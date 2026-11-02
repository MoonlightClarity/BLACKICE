#Requires -Version 5.1
<#
  Install BLACKICE's persistent headless Hyper-V broker only from an ALREADY
  elevated installer/process. This script never launches UAC, RunAs, VMConnect,
  or any foreground host application. Regular BLACKICE startup NEVER calls it.
  The dedicated task runs as SYSTEM in isolated Windows Session 0.
#>
param(
  [Parameter(Mandatory=$true)][string]$ApplicationDirectory,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [Parameter(Mandatory=$true)][string]$AuthorizedSid,
  [switch]$StartNow
)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'Broker registration requires existing installer administrator authority. No UAC prompt was attempted.'
}
if($AuthorizedSid -notmatch '^S-1-5-(?:\d+-){1,15}\d+$'){
  throw 'Pass the exact authorized interactive BLACKICE user SID.'
}
if(![IO.Path]::IsPathRooted($ApplicationDirectory) -or
   ![IO.Path]::IsPathRooted($DataDirectory)){
  throw 'Install locations must be absolute paths.'
}
$app=[IO.Path]::GetFullPath($ApplicationDirectory)
$data=[IO.Path]::GetFullPath($DataDirectory)
$sourceScript=Join-Path $app 'scripts\workbench-headless-broker.ps1'
$isoFolder=Join-Path $data 'workbench-media'
$vmFolder=Join-Path $data 'workbench-vm'
if(!(Test-Path -LiteralPath $sourceScript -PathType Leaf)){throw 'Broker source script not packaged.'}
if(!(Test-Path -LiteralPath $data -PathType Container)){throw 'Workbench configuration folder not found.'}
if(!(Test-Path -LiteralPath $isoFolder -PathType Container)){throw 'Workbench ISO directory not found.'}
if(!$env:ProgramFiles -or !(Test-Path -LiteralPath $env:ProgramFiles -PathType Container)){
  throw 'The protected Windows Program Files directory is unavailable.'
}
$taskName='BLACKICE-Workbench-HeadlessBroker'
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){
  throw 'A broker task already exists. Never silently replace an installed task.'
}
# Never run privileged code from a per-user installation folder. An ordinary
# user can edit resources\app, so stage the broker into protected Program Files
# with SYSTEM and Administrators as the only writers and Administrators owner.
$protectedRoot=Join-Path $env:ProgramFiles 'BLACKICE\Workbench'
$script=Join-Path $protectedRoot 'workbench-headless-broker.ps1'
if(Test-Path -LiteralPath $protectedRoot){
  throw 'A protected Workbench broker directory already exists. Inspect it before an explicit reinstall; do not overwrite.'
}
foreach($value in @($sourceScript,$script,$isoFolder,$vmFolder)){
  if($value.Contains([char]34) -or $value.Contains([char]96)){
    throw 'Unsupported quotation character in broker location.'
  }
}
$adminSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Set-ProtectedAcl([string]$target,[bool]$folder){
  $acl=Get-Acl -LiteralPath $target -ErrorAction Stop
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
  $acl.SetOwner($adminSid)
  $inherits=if($folder){
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }else{[Security.AccessControl.InheritanceFlags]::None}
  foreach($sid in @($adminSid,$systemSid)){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $sid,[Security.AccessControl.FileSystemRights]::FullControl,
      $inherits,[Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $target -AclObject $acl -ErrorAction Stop
  $actual=Get-Acl -LiteralPath $target -ErrorAction Stop
  if($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){
    throw 'Privileged script ownership was not secured.'
  }
  foreach($rule in $actual.Access){
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -notin @('S-1-5-18','S-1-5-32-544')){
      throw ('Unexpected inherited/explicit broker script access: '+$sid)
    }
  }
}
New-Item -Path $protectedRoot -ItemType Directory -ErrorAction Stop|Out-Null
Set-ProtectedAcl $protectedRoot $true
Copy-Item -LiteralPath $sourceScript -Destination $script -ErrorAction Stop
Set-ProtectedAcl $script $false
if((Get-FileHash $sourceScript -Algorithm SHA256).Hash -ne
   (Get-FileHash $script -Algorithm SHA256).Hash){
  throw 'The staged broker script hash does not match the packaged source.'
}
$psExe=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$args='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass'+
  ' -File "'+$script+'" -PipeName BLACKICE-Workbench-v1'+
  ' -AuthorizedSid "'+$AuthorizedSid+'" -MediaDirectory "'+$isoFolder+
  '" -VmDirectory "'+$vmFolder+'"'
$action=New-ScheduledTaskAction -Execute $psExe -Argument $args
$trigger=New-ScheduledTaskTrigger -AtStartup
$taskPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Headless BLACKICE guest broker: isolated SYSTEM Session 0; no host windows.'
if($StartNow){Start-ScheduledTask -TaskName $taskName -ErrorAction Stop}
[pscustomobject]@{
  installed=$true;task=$taskName;identity='SYSTEM';isolatedSession=0;
  started=[bool]$StartNow;hostWindowActivated=$false;interactiveElevationAttempted=$false
}|ConvertTo-Json -Compress
