# One-time bootstrap copied directly into the running guest via Hyper-V Copy-VMFile.
# Does not require a preexisting W: drive, network-share login, or manual prompt.
param([string]$BootstrapRoot='C:\Users\Public\BLACKICE-Pairing')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$secretFile=Join-Path $BootstrapRoot 'share-bootstrap.json'
$sourceReconnect=Join-Path $BootstrapRoot 'workbench-guest-reconnect.ps1'
if(!(Test-Path -LiteralPath $secretFile)){throw 'Host share bootstrap was not copied to the guest.'}
if(!(Test-Path -LiteralPath $sourceReconnect)){throw 'Guest reconnect helper was not copied to the guest.'}
$data=Get-Content -LiteralPath $secretFile -Raw|ConvertFrom-Json
if([string]$data.hostComputer -notmatch '^[A-Za-z0-9_-]{1,80}$' -or
  [string]$data.shareName -cne 'BLACKICE-Workspace' -or
  [string]$data.account -notmatch '^[A-Za-z0-9_-]{1,80}\\[A-Za-z0-9_-]{1,80}$' -or
  [string]$data.password -notmatch '^[A-Za-z0-9+/=!]{20,100}$'){
  throw 'Guest link bootstrap settings are invalid.'
}
if(([string]$data.hostComputer).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Run Workbench pairing inside the Windows guest, not on the host.'
}
if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){
  throw 'Run the pairing bootstrap from the logged-in VM desktop.'
}
$localRoot=Join-Path $env:LOCALAPPDATA 'BLACKICE-Workbench'
New-Item -ItemType Directory -Path $localRoot -Force|Out-Null
$credential=[pscredential]::new([string]$data.account,(ConvertTo-SecureString -String ([string]$data.password) -AsPlainText -Force))
$credential | Export-Clixml -LiteralPath (Join-Path $localRoot 'share-credential.xml')
$localReconnect=Join-Path $localRoot 'workbench-guest-reconnect.ps1'
Copy-Item -LiteralPath $sourceReconnect -Destination $localReconnect -Force
$settings=[ordered]@{hostComputer=[string]$data.hostComputer;shareName=[string]$data.shareName;drive='W'}
$settings|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $localRoot 'share.json') -Encoding UTF8
# Install the reconnect process under the *same interactive guest user* whose
# Windows credential store contains the share credential. It must run after
# every sign-in; while signed in it also repairs guest suspend / host-IP change.
$run='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $run -Force|Out-Null
$watchArgs='-NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$localReconnect+'" -Watch -IntervalSeconds 15'
Set-ItemProperty -Path $run -Name 'BLACKICE-Workbench-Reconnect' -Value ('powershell.exe '+$watchArgs)
# The old auto-run entries launched W:\ scripts before W: was available.
foreach($old in @('BLACKICE-Workbench-Guest','BLACKICE-Workbench-Video')){
  Remove-ItemProperty -Path $run -Name $old -ErrorAction SilentlyContinue
}
try{
  & $localReconnect -Once
  $setup='W:\.blackice-workbench\guest-setup.ps1'
  if(!(Test-Path -LiteralPath $setup)){throw 'Host prepared guest-setup.ps1 is unavailable over W:.'}
  & $setup
  # Guest setup errors terminate through ErrorActionPreference=Stop; do not use stale LASTEXITCODE.
  # This watcher owns automatic reconnect/relaunch after guest sign-in.
  foreach($old in @('BLACKICE-Workbench-Guest','BLACKICE-Workbench-Video')){
    Remove-ItemProperty -Path $run -Name $old -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $watchArgs -WindowStyle Hidden|Out-Null
  Write-Output 'BLACKICE_PAIR_BOOTSTRAP_OK W: mounted, guest agent started, watcher registered.'
}finally{
  # No plaintext bootstrap credential needs to survive the handoff.
  Remove-Item -LiteralPath $secretFile -Force -ErrorAction SilentlyContinue
}
