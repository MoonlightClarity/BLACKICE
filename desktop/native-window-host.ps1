param([switch]$Stream)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding

# A native window manager on the user's ordinary interactive desktop.
# No private desktop, virtual machine, restricted token or application catalog.
Add-Type -Path (Join-Path $PSScriptRoot 'native-window-host.cs') -ReferencedAssemblies @('System.dll')
function Invoke-WindowHost([string]$line) {
  $message=$null
  try {
    if($line.Length -gt 16000) {throw 'Application host request exceeded its size limit.'}
    $message=ConvertFrom-Json -InputObject $line
    $action=[string]$message.action
    $result=switch($action) {
      'windows' {[BlackiceNativeWindowHost]::Windows([int]$message.excludePid);break}
      'attach' {[BlackiceNativeWindowHost]::Attach([string]$message.windowId,[string]$message.hostWindowId,[int]$message.x,[int]$message.y,[int]$message.width,[int]$message.height);break}
      'position' {[BlackiceNativeWindowHost]::Position([int]$message.x,[int]$message.y,[int]$message.width,[int]$message.height);break}
      'dialogs' {[BlackiceNativeWindowHost]::Dialogs();break}
      'show' {[BlackiceNativeWindowHost]::SetVisible($true);break}
      'hide' {[BlackiceNativeWindowHost]::SetVisible($false);break}
      'detach' {[BlackiceNativeWindowHost]::Detach();break}
      'status' {[BlackiceNativeWindowHost]::Status();break}
      default {throw 'Unsupported native application command.'}
    }
    if($action -eq 'windows' -or $action -eq 'dialogs') {
      # PowerShell enumerates .NET arrays through switch; preserve the JSON array
      # shape for zero or one native window instead of returning null or {}.
      if($null -eq $result) {$result=@()}
      elseif($result -isnot [array]) {$result=@($result)}
    }
    [Console]::Out.WriteLine((@{ok=$true;requestId=$message.requestId;result=$result} | ConvertTo-Json -Compress -Depth 8))
  } catch {
    [Console]::Out.WriteLine((@{ok=$false;requestId=$message.requestId;error=$_.Exception.Message} | ConvertTo-Json -Compress -Depth 3))
  }
}
try {
  if($Stream) {
    while($null -ne ($line=[Console]::In.ReadLine())) {Invoke-WindowHost $line}
  } else {
    Invoke-WindowHost ([Console]::In.ReadToEnd())
  }
} finally {
  if('BlackiceNativeWindowHost' -as [type]) {[BlackiceNativeWindowHost]::Detach() | Out-Null}
}
