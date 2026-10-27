param([switch]$Stream)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
# Retain the genuine Excel COM instance only through its native first-workbook handoff.
$script:preparedExcel=$null
$script:preparedExcelWindowId=$null

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
      'windows' {
        $observed=@([BlackiceNativeWindowHost]::Windows([int]$message.excludePid,[int]$message.launchPid))
        if($script:preparedExcelWindowId){
          try{
            $prepared=[BlackiceNativeWindowHost]::PreparedExcelWindow($script:preparedExcelWindowId)
            if(-not @($observed | Where-Object { $_.id -eq $prepared.id }).Count){$observed+= $prepared}
          }catch{} # A closed Excel process cannot resurrect a stale HWND.
        }
        $observed;break
      }
      'excel-prepare' {
        if($script:preparedExcel) {throw 'An Excel startup is already retained in this native host.'}
        $existing=@(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
        $excel=$null;$book=$null;$newInstance=$false
        try {
          $excel=New-Object -ComObject Excel.Application
          $identity=[BlackiceNativeWindowHost]::PreparedExcelWindow([string]$excel.Hwnd)
          if($existing -contains $identity.pid) {throw 'Excel returned an already-running instance. Select that native window rather than changing an existing workbook.'}
          $newInstance=$true
          if(-not [string]::Equals([IO.Path]::GetFullPath($identity.processPath),[IO.Path]::GetFullPath([string]$message.executable),[StringComparison]::OrdinalIgnoreCase)){
            throw 'Excel automation started a different installed executable.'
          }
          $excel.Visible=$false
          $book=$excel.Workbooks.Add()
          $identity=[BlackiceNativeWindowHost]::PreparedExcelWindow([string]$excel.Hwnd)
          $script:preparedExcel=$excel
          $script:preparedExcelWindowId=$identity.id
          $result=@{launched=$true;pid=$identity.pid;activationPid=$identity.pid;
            activationProcessStartedAt=$identity.processStartedAt;windowId=$identity.id;
            title=[string]$book.Name;prepared=$true;isolated=$false;sandboxed=$false}
          $excel=$null
        }catch{
          if($newInstance -and $excel){try{$excel.Quit()}catch{}}
          if($excel){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)}catch{}}
          throw
        }finally{
          if($book){try{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($book)}catch{}}
        }
        $result;break
      }
      'attach' {
        $result=[BlackiceNativeWindowHost]::Attach([string]$message.windowId,[string]$message.hostWindowId,[int]$message.x,[int]$message.y,[int]$message.width,[int]$message.height,[string[]]$message.preexistingWindowIds)
        if($script:preparedExcel -and [string]$message.windowId -eq $script:preparedExcelWindowId){
          # Only expose Excel once the initialized workbook is already a native child.
          $script:preparedExcel.Visible=$true
          $result=[BlackiceNativeWindowHost]::Status()
        }
        $result;break
      }
      'position' {[BlackiceNativeWindowHost]::Position([int]$message.x,[int]$message.y,[int]$message.width,[int]$message.height);break}
      'dialogs' {[BlackiceNativeWindowHost]::Dialogs();break}
      'show' {[BlackiceNativeWindowHost]::SetVisible($true);break}
      'hide' {[BlackiceNativeWindowHost]::SetVisible($false);break}
      'close-app' {[BlackiceNativeWindowHost]::RequestClose();break}
      'status' {[BlackiceNativeWindowHost]::Status();break}
      'focus' {[BlackiceNativeWindowHost]::Focus();break}
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
  # Never restore a hosted application as an independent desktop window.
  # The native application remains under Windows' normal process lifecycle.
}
