# BLACKICE guest-side W: maintenance. Runs inside the interactive VM, not the host.
# Hyper-V copies this script locally, so repair never depends on an existing W: drive.
param([switch]$Once,[switch]$Watch,[ValidateRange(5,300)][int]$IntervalSeconds=15)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$localRoot=Join-Path $env:LOCALAPPDATA 'BLACKICE-Workbench'
$configPath=Join-Path $localRoot 'share.json'
$credentialPath=Join-Path $localRoot 'share-credential.xml'
$script:nextAgentLaunch=[datetime]::MinValue
$script:nextVideoLaunch=[datetime]::MinValue
if(!(Test-Path -LiteralPath $configPath)){throw 'BLACKICE guest link config is missing. Bootstrap from the host.'}
if(!(Test-Path -LiteralPath $credentialPath)){throw 'BLACKICE guest link credential is missing. Bootstrap from the host.'}
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
if([string]$config.hostComputer -notmatch '^[a-zA-Z0-9_-]{1,80}$' -or [string]$config.shareName -notmatch '^[a-zA-Z][a-zA-Z0-9_-]{2,55}$' -or [string]$config.drive -notmatch '^[A-Z]$'){throw 'Invalid persisted guest link configuration.'}
$driveName=[string]$config.drive
$drive=$driveName+':'
$driveRoot=$drive+'\'
$bridge=$driveRoot+'.blackice-workbench'
$credentials=Import-Clixml -LiteralPath $credentialPath
if($credentials -isnot [pscredential]){throw 'Saved BLACKICE guest share credential cannot be read.'}
$logFile=Join-Path $localRoot 'reconnect-state.json'
function Publish-Status([string]$state,[string]$message){
  try{
    $content=@{state=$state;at=(Get-Date).ToUniversalTime().ToString('o');drive=$drive;host=$config.hostComputer;message=$message}|ConvertTo-Json -Compress
    $tmp=$logFile+'.tmp'
    [IO.File]::WriteAllText($tmp,$content)
    Move-Item -LiteralPath $tmp -Destination $logFile -Force
  }catch{}
}
function Guest-ShareReady {
  if(!(Test-Path -LiteralPath ($bridge+'\host-info.json'))){return $false}
  try{
    $info=Get-Content -LiteralPath (Join-Path $bridge 'host-info.json') -Raw|ConvertFrom-Json
    if($info.hostName -cne $config.hostComputer){return $false}
    $probe=Join-Path $bridge ('guest-link-'+[guid]::NewGuid().ToString('N')+'.tmp')
    [IO.File]::WriteAllText($probe,'blackice-share-read-write')
    $ok=([IO.File]::ReadAllText($probe) -ceq 'blackice-share-read-write')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $ok
  }catch{return $false}
}
function Repair-Share {
  if(Guest-ShareReady){return $true}
  try{& net.exe use $drive /delete /y 2>$null|Out-Null}catch{}
  try{Remove-PSDrive -Name $driveName -Force -ErrorAction SilentlyContinue}catch{}
  $candidates=New-Object System.Collections.Generic.List[string]
  $candidates.Add(('\\'+$config.hostComputer+'\'+$config.shareName))
  # Hyper-V Default Switch changes its gateway across host/VM restarts.
  # Resolve the current route each cycle, never cache an old numerical IP.
  try{
    $gateways=@(Get-NetIPConfiguration -ErrorAction Stop|ForEach-Object {$_.IPv4DefaultGateway.NextHop})|Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' }|Select-Object -Unique
    foreach($gateway in $gateways){$candidates.Add(('\\'+$gateway+'\'+$config.shareName))}
  }catch{}
  foreach($unc in $candidates){
    try{
      New-PSDrive -Name $driveName -PSProvider FileSystem -Root $unc -Credential $credentials -Persist -Scope Global -ErrorAction Stop|Out-Null
      if(Guest-ShareReady){
        Publish-Status 'connected' ('Reconnected '+$drive+' to '+$unc)
        return $true
      }
    }catch{Publish-Status 'retrying' (([string]$_.Exception.Message).Substring(0,[Math]::Min(250,([string]$_.Exception.Message).Length)))}
    try{& net.exe use $drive /delete /y 2>$null|Out-Null}catch{}
  }
  Publish-Status 'disconnected' 'Workspace share unavailable; will retry automatically.'
  return $false
}
function Guest-Agent-Alive {
  $file=Join-Path $bridge 'agent-state.json'
  if(!(Test-Path -LiteralPath $file)){return $false}
  try{
    $state=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
    $heartbeat=[datetime]::Parse([string]$state.heartbeatAt).ToUniversalTime()
    return [bool]$state.interactive -and (([datetime]::UtcNow-$heartbeat).TotalSeconds -lt 15)
  }catch{return $false}
}
function Ensure-Guest-Processes {
  $now=[datetime]::UtcNow
  if(-not (Guest-Agent-Alive) -and $now -ge $script:nextAgentLaunch){
    $agent=Join-Path $bridge 'guest-agent.ps1'
    if(Test-Path -LiteralPath $agent){
      $args='-NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$agent+'" -WorkspaceRoot '+$driveRoot
      Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -ErrorAction Stop|Out-Null
      $script:nextAgentLaunch=$now.AddSeconds(30)
    }
  }
  if($now -ge $script:nextVideoLaunch){
    $video=Join-Path $bridge 'workbench-desktop-stream.ps1'
    if(Test-Path -LiteralPath $video){
      $running=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue|Where-Object {$_.CommandLine -like '*workbench-desktop-stream.ps1*'})
      if(!$running.Count){
        $args='-NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$video+'" -WorkspaceRoot '+$driveRoot+' -TargetFps 15 -Quality 68'
        Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden|Out-Null
      }
      $script:nextVideoLaunch=$now.AddSeconds(60)
    }
  }
}
function Step {
  if(Repair-Share){Ensure-Guest-Processes;return $true}
  return $false
}
if($Once){
  if(!(Repair-Share)){throw 'BLACKICE W: reconnect did not pass a read/write check.'}
  Write-Output ('BLACKICE_W_DRIVE_OK '+$driveRoot)
  exit 0
}
if(-not $Watch){throw 'Choose -Once or -Watch.'}
# Exactly one watcher per signed-in guest user, independent of the SMB drive.
$created=$false
$mutex=New-Object System.Threading.Mutex($false,'Local\BLACKICE-Workbench-Watch',[ref]$created)
try{
  if(-not $mutex.WaitOne(0)){exit 0}
  try{
    for(;;){
      try{[void](Step)}catch{Publish-Status 'error' ([string]$_.Exception.Message)}
      Start-Sleep -Seconds $IntervalSeconds
    }
  }finally{$mutex.ReleaseMutex()}
}finally{$mutex.Dispose()}
