# Read-only Windows guest RDP readiness probe for BLACKICE.
# Run INSIDE the Windows guest; writes a small result in the shared workspace.
param([string]$WorkspaceRoot='W:\')
$ErrorActionPreference='Stop'
if(![IO.Path]::IsPathRooted($WorkspaceRoot)){throw 'Expected mapped guest workspace.'}
$bridge=Join-Path $WorkspaceRoot '.blackice-workbench'
$hostInfo=Get-Content -LiteralPath (Join-Path $bridge 'host-info.json') -Raw|ConvertFrom-Json
if(([string]$hostInfo.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){
 throw 'This probe must run in the Windows guest.'
}
$service=Get-Service -Name TermService -ErrorAction SilentlyContinue
$rdp=Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -ErrorAction SilentlyContinue
$rules=@(Get-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue|
  Where-Object Enabled -eq 'True'|Select-Object -First 8 DisplayName,Enabled,Direction,Action)
$ipv4=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'}|
  Select-Object -First 8 InterfaceAlias,IPAddress,PrefixLength)
$os=Get-CimInstance Win32_OperatingSystem
$listener=Get-NetTCPConnection -State Listen -LocalPort 3389 -ErrorAction SilentlyContinue
$reply=[ordered]@{
 format=1
 at=[DateTime]::UtcNow.ToString('o')
 guestOS=[string]$os.Caption
 build=[string]$os.BuildNumber
 guestSessionId=[int][Diagnostics.Process]::GetCurrentProcess().SessionId
 remoteDesktopEnabled=$($null -ne $rdp -and $rdp.fDenyTSConnections -eq 0)
 remoteDesktopService=$(if($service){[string]$service.Status}else{'not-installed'})
 remoteDesktopListener=([bool]$listener)
 firewallRules=$rules
 ipv4=$ipv4
}
$destination=Join-Path $bridge 'rdp-preflight.json'
[IO.File]::WriteAllText($destination,($reply|ConvertTo-Json -Compress -Depth 7),[Text.UTF8Encoding]::new($false))
