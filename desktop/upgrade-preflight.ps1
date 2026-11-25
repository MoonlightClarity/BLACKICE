# Runs from the new NSIS installer, before modifying an existing installation.
# Normal desktop shutdown intentionally retains remote access. Updating does not.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

try {
  $root=[IO.Path]::GetFullPath($InstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $expected=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\BLACKICE')).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($root -ine $expected) { throw 'Only the existing per-user BLACKICE installation can be updated.' }
  $exe=Join-Path $root 'BLACKICE.exe'
  if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { exit 0 }
  function Get-BlackiceProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='BLACKICE.exe'" -ErrorAction Stop | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath -ieq $exe
    })
  }
  function Is-BlackiceMain($p) {
    $command=[string]$p.CommandLine
    return $command -notmatch '(?i)--type=' -and $command -notmatch '(?i)remote-availability-worker\.mjs' -and $command -notmatch '(?i)(?:^|\s)--quit(?:\s|$)'
  }
  function Is-BlackiceHelper($p) {
    $command=[string]$p.CommandLine
    return $command -match '(?i)--type=(?:crashpad-handler|renderer|gpu-process|utility|zygote)' -or $command -match '(?i)remote-availability-worker\.mjs' -or $command -match '(?i)(?:^|\s)--quit(?:\s|$)'
  }
  $owners=@(Get-BlackiceProcesses | Where-Object { Is-BlackiceMain $_ })
  if ($owners.Count) {
    Start-Process -FilePath $exe -ArgumentList '--quit' -WindowStyle Hidden | Out-Null
    $deadline=(Get-Date).AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 250
      $owners=@(Get-BlackiceProcesses | Where-Object { Is-BlackiceMain $_ })
    } while ($owners.Count -and (Get-Date) -lt $deadline)
    if ($owners.Count) { throw 'BLACKICE declined or did not complete normal shutdown.' }
  }
  # Detached availability and Crashpad processes are allowed during normal
  # shutdown. Retire only these exact installation-owned helpers for upgrades.
  $remaining=@(Get-BlackiceProcesses)
  if (@($remaining | Where-Object { !(Is-BlackiceHelper $_) }).Count) {
    throw 'An unrecognized BLACKICE process still uses the installation.'
  }
  foreach ($process in $remaining) {
    if (@(Get-BlackiceProcesses | Where-Object { Is-BlackiceMain $_ }).Count) {
      throw 'BLACKICE was reopened during the update.'
    }
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue
    if (!$current -or $current.ExecutablePath -ine $exe -or $current.CreationDate -ne $process.CreationDate) { continue }
    if (!(Is-BlackiceHelper $current)) { throw 'The helper process identity changed.' }
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
  }
  $deadline=(Get-Date).AddSeconds(15)
  do {
    $remaining=@(Get-BlackiceProcesses)
    if (!$remaining.Count) { exit 0 }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'Old BLACKICE helper processes did not release the installation.'
} catch {
  [Console]::Error.WriteLine('BLACKICE_UPDATE_PROCESS_EXIT_FAILED')
  exit 1
}
