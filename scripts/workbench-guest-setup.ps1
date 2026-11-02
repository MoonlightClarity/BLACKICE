# One-time setup inside the installed BLACKICE-Workbench Windows guest.
# This is a GUEST program, never a host desktop automation.
param(
  [string]$HostComputer,
  [ValidatePattern('^[A-Za-z]$')][string]$SharedDrive='W'
)
$ErrorActionPreference='Stop'
$drive=$SharedDrive+':'
$root=$drive+'\'
if(!(Test-Path -LiteralPath $root)){
  if(!$HostComputer){throw 'Map the authenticated host share in the guest first, or supply -HostComputer.'}
  if($HostComputer -notmatch '^[A-Za-z0-9_-]{1,80}$'){throw 'Invalid host computer name.'}
  $credential=Get-Credential -Message ('Windows account authorized to access \\'+$HostComputer+'\BLACKICE-Workspace')
  if(!$credential){throw 'Host share credentials were not provided.'}
  New-PSDrive -Name $SharedDrive -PSProvider FileSystem -Root ('\\'+$HostComputer+'\BLACKICE-Workspace') -Persist -Credential $credential -Scope Global -ErrorAction Stop|Out-Null
  if(!(Test-Path -LiteralPath $root)){throw 'Guest did not mount the host workspace read/write.'}
}
$dir=Join-Path $root '.blackice-workbench'
$agent=Join-Path $dir 'guest-agent.ps1'
$hostInfo=Join-Path $dir 'host-info.json'
if(!(Test-Path -LiteralPath $agent) -or !(Test-Path -LiteralPath $hostInfo)){
  throw 'This is not an initialized BLACKICE shared workspace. Prepare the guest agent from the Workbench tab.'
}
$info=Get-Content -LiteralPath $hostInfo -Raw|ConvertFrom-Json
if(([string]$info.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Refusing to configure a guest desktop agent on the host.'
}
if(!([Environment]::UserInteractive) -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){
  throw 'Install the guest agent while logged in to the guest Windows desktop.'
}
$quoted='"'+$agent.Replace('"','')+'"'
# W:\ is intentionally unquoted: a quoted trailing backslash can escape the
# closing quote in Windows native-process argument parsing.
if($root -notmatch '^[A-Za-z]:\\$'){throw 'Guest shared root must be one drive letter.'}
$args='-NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File '+$quoted+' -WorkspaceRoot '+$root
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $key -Force|Out-Null
Set-ItemProperty -Path $key -Name 'BLACKICE-Workbench-Guest' -Value ('powershell.exe '+$args)
$stdout=Join-Path $dir 'guest-agent-launch-stdout.log'
$stderr=Join-Path $dir 'guest-agent-launch-stderr.log'
$child=Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
Start-Sleep -Milliseconds 1300
if($child.HasExited){
  $diagnostic=if(Test-Path $stderr){(Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)}else{''}
  throw ('Guest agent exited during startup ('+$child.ExitCode+'): '+$diagnostic.Substring(0,[Math]::Min(300,$diagnostic.Length)))
}
$videoScript=Join-Path $dir 'workbench-desktop-stream.ps1'
if(Test-Path -LiteralPath $videoScript){
  $videoQuoted='"'+$videoScript.Replace('"','')+'"'
  $videoArgs='-NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File '+$videoQuoted+
    ' -WorkspaceRoot '+$root+' -TargetFps 15 -Quality 68'
  Set-ItemProperty -Path $key -Name 'BLACKICE-Workbench-Video' -Value ('powershell.exe '+$videoArgs)
  Start-Process -FilePath 'powershell.exe' -ArgumentList $videoArgs -WindowStyle Hidden -ErrorAction Stop|Out-Null
}
Write-Output ('Guest agent and desktop stream configured; workspace '+$root+'.')
Write-Output 'Return to host BLACKICE Workbench, select Pair guest. Host desktop focus is unaffected.'
