# Native VMConnect viewport controller. Runs unelevated, hidden and persists
# for one BLACKICE desktop window. It never starts or stops the Hyper-V VM.
param([switch]$Stream)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
Add-Type -Path (Join-Path $PSScriptRoot 'workbench-vmconnect-bridge.cs') -ReferencedAssemblies @('System.dll')
function Invoke-VMConnect($request) {
  if(!$request -or !$request.action){throw 'Missing native VMConnect action.'}
  switch([string]$request.action) {
    'attach' {return [BlackiceVMConnectDock]::Attach([string]$request.parent,[string]$request.vmName,[string]$request.vmId,
        [int]$request.x,[int]$request.y,[int]$request.width,[int]$request.height)}
    'bounds' {return [BlackiceVMConnectDock]::Position([int]$request.x,[int]$request.y,
        [int]$request.width,[int]$request.height)}
    'visible' {return [BlackiceVMConnectDock]::Visible([bool]$request.visible)}
    'input' {return [BlackiceVMConnectDock]::Input([bool]$request.enabled)}
    'close' {return [BlackiceVMConnectDock]::Close()}
    'status' {return [BlackiceVMConnectDock]::Status()}
    default {throw 'Unsupported VMConnect action.'}
  }
}
try {
  if($Stream){
    while($null -ne ($line=[Console]::In.ReadLine())) {
      try {
        if($line.Length -gt 6000){throw 'VMConnect request too large.'}
        $request=ConvertFrom-Json -InputObject $line -ErrorAction Stop
        $answer=Invoke-VMConnect $request
        $reply=@{ok=$true;requestId=$request.requestId;result=$answer}
      }catch{
        $reply=@{ok=$false;requestId=$request.requestId;error=$_.Exception.Message}
      }
      [Console]::Out.WriteLine(($reply|ConvertTo-Json -Compress -Depth 5))
      [Console]::Out.Flush()
    }
  }else {
    $inputText=[Console]::In.ReadToEnd()
    $request=ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
    $answer=Invoke-VMConnect $request
    [Console]::Out.WriteLine((@{ok=$true;requestId=$request.requestId;result=$answer}|ConvertTo-Json -Compress -Depth 5))
  }
}finally {
  # A connected viewer is closed explicitly before the pipe exits. The VM
  # continues running with its original VHDX and guest agent.
  [void][BlackiceVMConnectDock]::Close()
}
