# BLACKICE Workbench one-shot hidden administrator command relay.
# Electron stays asInvoker; the isolated PowerShell child obtains Hyper-V rights.
param(
 [Parameter(Mandatory=$true)][string]$RequestPath,
 [Parameter(Mandatory=$true)][string]$ResponsePath,
 [switch]$Elevated
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Write-Receipt($value){
 [IO.File]::WriteAllText($ResponsePath,($value|ConvertTo-Json -Compress -Depth 5),[Text.UTF8Encoding]::new($false))
}
if(!$Elevated){
 $win=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop
 if($win.EnableLUA -ne 1 -or $win.ConsentPromptBehaviorAdmin -ne 0){
   throw 'Workbench hidden administrator helper has only been validated with UAC Never notify (EnableLUA=1).'
 }
 $arguments=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
   '-File',('"'+$PSCommandPath+'"'),'-RequestPath',('"'+$RequestPath+'"'),
   '-ResponsePath',('"'+$ResponsePath+'"'),'-Elevated')
 $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -Verb RunAs -Wait -PassThru -ErrorAction Stop
 if($child.ExitCode -ne 0 -and !(Test-Path -LiteralPath $ResponsePath)){
   throw ('The hidden Workbench administrator process failed with '+$child.ExitCode)
 }
 if(!(Test-Path -LiteralPath $ResponsePath)){throw 'Administrator process returned no Workbench receipt.'}
 exit 0
}
$identity=''
try{
 $person=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
 if(!$person.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'An administrator token was not granted for the hidden Workbench operation.'}
 $r=Get-Content -LiteralPath $RequestPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
 $identity=[string]$r.id
 if($r.version -ne 1 -or $identity -notmatch '^[a-f0-9-]{36}$' -or $r.script -isnot [string] -or $r.script.Length -lt 1 -or $r.script.Length -gt 60000){
  throw 'Invalid bounded Workbench operation.'
 }
 $output=(& ([ScriptBlock]::Create($r.script))|Out-String -Width 100000).Trim()
 if($output.Length -gt 1600000){throw 'Workbench administrator result exceeded its size limit.'}
 Write-Receipt ([ordered]@{version=1;id=$identity;ok=$true;output=$output})
}catch{
 $message=[string]$_.Exception.Message
 Write-Receipt ([ordered]@{version=1;id=$identity;ok=$false;message=$message.Substring(0,[Math]::Min(450,$message.Length))})
 exit 1
}
