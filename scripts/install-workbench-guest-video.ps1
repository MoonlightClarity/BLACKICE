# Install or upgrade the native screen streamer inside the signed-in guest.
# Verify and stage BEFORE stopping the previous stream; retain rollback.
param([ValidateSet('auto','dxgi','gdi')][string]$Backend='auto',
  [ValidateRange(2,60)][int]$TargetFps=30,
  [ValidateRange(35,90)][int]$Quality=65)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$bridge='W:\.blackice-workbench'
$hostInfo=Get-Content -LiteralPath (Join-Path $bridge 'host-info.json') -Raw | ConvertFrom-Json
if(([string]$hostInfo.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Refusing to install guest video on the host desktop.'
}
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){
  throw 'Run from the signed-in interactive Windows guest session.'
}
$src=Join-Path $bridge 'workbench-guest-video.exe'
$dir=Join-Path $env:LOCALAPPDATA 'BLACKICE\GuestVideo'
$dest=Join-Path $dir 'workbench-guest-video.exe'
$result=Join-Path $bridge 'desktop-stream\install-native-video.json'
$errorReceipt=Join-Path $bridge 'desktop-stream\install-native-video-failure.json'
if(!(Test-Path -LiteralPath $src -PathType Leaf)){
  throw 'The native guest encoder must be staged in the workspace.'
}
New-Item -ItemType Directory -Path $dir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $result) -Force | Out-Null
$sourceHash=(Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
if($sourceHash -notmatch '^[a-f0-9]{64}$'){throw 'Source hash invalid'}
$needCopy=!(Test-Path -LiteralPath $dest) -or
  (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash
$stage=$null
$rollback=$null
$child=$null
$stopped=@()
$args='-fps '+$TargetFps+' -quality '+$Quality+' -backend '+$Backend
$run='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$priorRun=$null
try {
  $priorRun=(Get-ItemProperty -Path $run -Name 'BLACKICE-Workbench-Video' -ErrorAction SilentlyContinue).'BLACKICE-Workbench-Video'
}catch{}
$updatedRun=$false
try {
  # Stage verified bytes on the guest-local volume while the old encoder runs.
  if($needCopy){
    $stage=$dest+'.'+[guid]::NewGuid().ToString('N')+'.staged'
    Copy-Item -LiteralPath $src -Destination $stage -ErrorAction Stop
    Unblock-File -LiteralPath $stage -ErrorAction SilentlyContinue
    if((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash){
      throw 'Staged guest video checksum differs from the host.'
    }
  }
  # Stop only the named old video encoders, never the guest command agent.
  $old=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    ($_.Name -ieq 'workbench-guest-video.exe') -or
    ($_.Name -ieq 'powershell.exe' -and $_.ProcessId -ne $PID -and
      $_.CommandLine -match 'workbench-desktop-stream[.]ps1')
  })
  foreach($proc in $old){
    $pidToStop=[int]$proc.ProcessId
    try {
      Stop-Process -Id $pidToStop -Force -ErrorAction Stop
      $stopped+=$pidToStop
    }catch{
      if(Get-Process -Id $pidToStop -ErrorAction SilentlyContinue){
        throw ('Previous video process did not stop: '+$pidToStop)
      }
    }
  }
  if($stopped.Count){Start-Sleep -Milliseconds 350}
  if($needCopy){
    if(Test-Path -LiteralPath $dest){
      $rollback=$dest+'.'+[guid]::NewGuid().ToString('N')+'.previous'
      Move-Item -LiteralPath $dest -Destination $rollback -ErrorAction Stop
    }
    # The old destination no longer exists: no locked overwrite and no -Force.
    Move-Item -LiteralPath $stage -Destination $dest -ErrorAction Stop
    if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHash){
      throw 'The activated native video binary did not match the staged checksum.'
    }
  }
  Unblock-File -LiteralPath $dest -ErrorAction SilentlyContinue
  $child=Start-Process -FilePath $dest -ArgumentList $args -WorkingDirectory $dir -WindowStyle Hidden -PassThru -ErrorAction Stop
  Start-Sleep -Milliseconds 1050
  if($child.HasExited){throw ('Native video encoder exited: '+$child.ExitCode)}
  New-Item -Path $run -Force | Out-Null
  Set-ItemProperty -Path $run -Name 'BLACKICE-Workbench-Video' -Value ('"'+$dest+'" '+$args) -ErrorAction Stop
  $updatedRun=$true
  $receipt=[ordered]@{
    version=1;status='started';at=[DateTime]::UtcNow.ToString('o')
    guestMachine=$env:COMPUTERNAME;videoPath=$dest;sha256=$sourceHash;pid=[int]$child.Id
    stopped=$stopped;autostart=$true;nativeBackend=$Backend;targetFps=$TargetFps;quality=$Quality
    previousVideoPath=$rollback
  }
  [IO.File]::WriteAllText($result,($receipt|ConvertTo-Json -Compress -Depth 4),[Text.UTF8Encoding]::new($false))
}catch{
  $failure=[string]$_.Exception.Message
  # If replacement failed, recover the original guest-local executable.
  try{
    if($child -and !$child.HasExited){Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue}
    if($rollback -and (Test-Path -LiteralPath $rollback)){
      if(Test-Path -LiteralPath $dest){
        Move-Item -LiteralPath $dest -Destination ($dest+'.'+[guid]::NewGuid().ToString('N')+'.failed') -ErrorAction Stop
      }
      Move-Item -LiteralPath $rollback -Destination $dest -ErrorAction Stop
    }
    if($updatedRun){
      if($priorRun){Set-ItemProperty -Path $run -Name 'BLACKICE-Workbench-Video' -Value $priorRun}
      else {Remove-ItemProperty -Path $run -Name 'BLACKICE-Workbench-Video' -ErrorAction SilentlyContinue}
    }
    if($stopped.Count -gt 0 -and (Test-Path -LiteralPath $dest)){
      [void](Start-Process -FilePath $dest -ArgumentList $args -WorkingDirectory $dir -WindowStyle Hidden -PassThru -ErrorAction Stop)
    }
  }catch{
    $failure+='; rollback failed: '+[string]$_.Exception.Message
  }
  $report=[ordered]@{version=1;at=[DateTime]::UtcNow.ToString('o');status='failed';error=$failure;sourceSha256=$sourceHash;stopped=$stopped}
  try{[IO.File]::WriteAllText($errorReceipt,($report|ConvertTo-Json -Compress -Depth 4),[Text.UTF8Encoding]::new($false))}catch{}
  throw $failure
}finally{
  if($stage){Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue}
}
