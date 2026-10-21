# Proposal only. Run after release acceptance, with the exact current installed main PID.
# .\close-awareness-update.ps1 -Work <work> -ExpectedPid <pid> -ExpectedExecutable <Agent Desk.exe> -ExpectedPlanSha256 <reviewed plan SHA>
# The only application action is Process.CloseMainWindow(). No force, API shutdown, provider or Tailscale call.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Work,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ExpectedPid,
  [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baselineSha256 = '98059bdd853b7d448cec3bb5a4815bd1445afb69bda525633b630e91237e8b66'
$samples = @(); $native = $null; $current = $null; $idleSaved = $false; $closeRequested = $false
$closeAccepted = $false; $nativeExited = $false; $nativeExitCode = $null
$closeRequestedAt = $null; $initialProcess = $null; $origin = $null; $port = $null
$idleFile = $null; $closeFile = $null; $outputsReady = $false; $baseline = $null

function Same-Path([string]$Left, [string]$Right) {
  return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals([IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Save-NewJson([string]$File, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 10) + "`n")
  $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Exact-NativeProcess {
  $item = Get-Process -Id $ExpectedPid -ErrorAction Stop
  if (-not (Same-Path $item.Path $ExpectedExecutable)) { throw 'The expected PID belongs to another executable.' }
  $item.Refresh()
  if ($item.MainWindowHandle.ToInt64() -eq 0) { throw 'The exact installed process has no main window to close normally.' }
  return $item
}
function Port-Listeners {
  return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port })
}
function Installed-Processes {
  $prefix = [IO.Path]::GetDirectoryName($ExpectedExecutable).TrimEnd('\') + '\'
  $found = @()
  foreach ($item in Get-Process -ErrorAction Stop) {
    $file = $null
    try { $file = $item.Path } catch { if ($item.ProcessName -eq 'Agent Desk') { throw 'Cannot inspect a remaining Agent Desk process path.' } }
    if (-not $file -and $item.ProcessName -eq 'Agent Desk') { throw 'Cannot verify a remaining Agent Desk process path.' }
    if ($file -and $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $found += $item.Id }
  }
  return $found
}
function Read-IdleSample {
  $value = Invoke-RestMethod -Uri ($origin + '/api/status') -Method Get -WebSession $session -Headers @{ Origin=$origin; 'Cache-Control'='no-store' } -TimeoutSec 5 -ErrorAction Stop
  if ($value.app -ne 'relay-agent-harness' -or $value.version -ne '2.29.0' -or $value.desktopApp -ne $true -or -not (Same-Path $value.installPath ([IO.Path]::GetDirectoryName($ExpectedExecutable)))) { throw 'The fresh local API is not this installed BLACKICE 2.29.0 desktop.' }
  $idle = $value.activeTurns -eq 0 -and $value.execution.activeCount -eq 0 -and @($value.execution.activeRunIds).Count -eq 0 -and $value.execution.settling -eq $false -and $value.execution.stopping -eq $false -and $null -eq $value.learning.activeReviewId -and $null -eq $value.learning.activeRunId -and $value.inbox.active -eq 0 -and $value.inbox.pending -eq 0 -and $value.inbox.paused -eq $true -and $value.operations.running -eq 0 -and $value.operations.queued -eq 0 -and $value.operations.paused -eq $true -and $value.projects.running -eq 0 -and $value.browser.busy -eq $false
  return [ordered]@{
    observedAt=[DateTime]::UtcNow.ToString('o'); version=$value.version; desktopApp=$value.desktopApp; idle=[bool]$idle
    activeTurns=$value.activeTurns
    execution=[ordered]@{activeCount=$value.execution.activeCount; activeRunIds=@($value.execution.activeRunIds); settling=$value.execution.settling; stopping=$value.execution.stopping}
    learning=[ordered]@{activeReview=($null -ne $value.learning.activeReviewId); activeRun=($null -ne $value.learning.activeRunId)}
    inbox=[ordered]@{active=$value.inbox.active; pending=$value.inbox.pending; paused=$value.inbox.paused}
    operations=[ordered]@{running=$value.operations.running; queued=$value.operations.queued; paused=$value.operations.paused}
    projects=[ordered]@{running=$value.projects.running}; browser=[ordered]@{available=$value.browser.available; busy=$value.browser.busy}
  }
}

try {
  if (-not [IO.Path]::IsPathRooted($Work) -or -not [IO.Path]::IsPathRooted($ExpectedExecutable)) { throw 'Use absolute work and executable paths.' }
  $Work = [IO.Path]::GetFullPath($Work); $ExpectedExecutable = [IO.Path]::GetFullPath($ExpectedExecutable)
  if (-not [IO.Path]::GetFileName($ExpectedExecutable).Equals('Agent Desk.exe', [StringComparison]::OrdinalIgnoreCase)) { throw 'This proposal targets the exact existing Agent Desk.exe installation.' }
  $baselineFile = Join-Path $Work 'baseline-awareness-2.29.0.json'
  if ((Get-FileHash -LiteralPath $baselineFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $baselineSha256) { throw 'The inspected native baseline bytes changed.' }
  $baseline = Get-Content -LiteralPath $baselineFile -Raw | ConvertFrom-Json
  if ($baseline.product -ne 'BLACKICE' -or $baseline.version -ne '2.29.0' -or -not (Same-Path $baseline.candidate (Join-Path $Work 'candidate')) -or -not (Same-Path $baseline.installed (Join-Path ([IO.Path]::GetDirectoryName($ExpectedExecutable)) 'resources\app'))) { throw 'The baseline belongs to another work directory or native installation.' }
  $planFile = Join-Path $Work 'awareness-update-plan.json'
  if ((Get-FileHash -LiteralPath $planFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedPlanSha256) { throw 'The reviewed 2.30 installation plan bytes changed.' }
  $plan = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
  if ($plan.product -ne 'BLACKICE' -or $plan.version -ne '2.30.0' -or $plan.previousVersion -ne '2.29.0' -or $plan.baselineSha256 -ne $baselineSha256 -or -not (Same-Path $plan.candidate $baseline.candidate) -or -not (Same-Path $plan.installed $baseline.installed) -or -not (Same-Path $plan.source $baseline.source)) { throw 'The reviewed plan belongs to another installation or baseline.' }
  if (-not (Same-Path $PSCommandPath (Join-Path $plan.candidate 'scripts\close-awareness-update.ps1')) -or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.sourceFiles.'scripts/close-awareness-update.ps1') { throw 'Run the exact close helper bound to this prepared candidate.' }
  $idleFile = Join-Path $Work 'pre-install-idle-verification.json'; $closeFile = Join-Path $Work 'native-close-verification.json'
  if ((Test-Path -LiteralPath $idleFile) -or (Test-Path -LiteralPath $closeFile)) { throw 'Preserve existing receipts; use a separately reviewed attempt before closing.' }
  $outputsReady = $true
  $native = Exact-NativeProcess
  $initialProcess = [ordered]@{pid=$native.Id; executable=$native.Path; startedAt=$native.StartTime.ToUniversalTime().ToString('o'); mainWindowHandle=$native.MainWindowHandle.ToInt64()}
  $BlackIceProfilePath = Join-Path $env:APPDATA 'Relay'; $portRecord = Get-Content -LiteralPath (Join-Path $BlackIceProfilePath 'desktop-port.json') -Raw | ConvertFrom-Json
  if ($portRecord.port -isnot [int] -and $portRecord.port -isnot [long]) { throw 'The desktop port is not an integer.' }
  $port = [int]$portRecord.port; if ($port -lt 1024 -or $port -gt 65535) { throw 'The saved desktop port is outside the local runtime range.' }
  $listeners = @(Port-Listeners)
  if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $ExpectedPid }).Count -ne 0) { throw 'The exact installed native PID does not own this loopback listener.' }
  $origin = 'http://127.0.0.1:' + $port
  $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $page = Invoke-WebRequest -Uri ($origin + '/') -UseBasicParsing -Method Get -WebSession $session -TimeoutSec 5 -ErrorAction Stop
  if ($page.StatusCode -ne 200) { throw 'The installed app did not issue a local browser session.' }
  $samples += Read-IdleSample
  if (-not $samples[-1].idle) { throw 'BLACKICE has active work or unpaused/pending dispatch. No close was requested.' }
  Start-Sleep -Milliseconds 200
  $samples += Read-IdleSample
  if (-not $samples[-1].idle) { throw 'BLACKICE became busy before close. No close was requested.' }
  $current = Exact-NativeProcess
  $null = $current.Handle
  if ($current.HasExited) { throw 'The exact native process exited before the normal close request.' }
  if ($current.StartTime.ToUniversalTime().ToString('o') -ne $initialProcess.startedAt) { throw 'The expected native PID was replaced during verification.' }
  $idleReceipt = [ordered]@{format=1; product='BLACKICE'; version='2.29.0'; targetVersion='2.30.0'; platform='win32'; verifiedAt=[DateTime]::UtcNow.ToString('o'); baselineSha256=$baselineSha256; planSha256=$ExpectedPlanSha256; idle=$true; statusOk=$true; exactNativeProcess=$initialProcess; loopbackListenerOwned=$true; samples=$samples; providerTurnsRequested=0; routesMutated=$false; errors=@()}
  Save-NewJson $idleFile $idleReceipt; $idleSaved = $true
  if (([DateTime]::UtcNow - [DateTime]::Parse($samples[-1].observedAt).ToUniversalTime()).TotalSeconds -gt 2) { throw 'The final idle observation is no longer fresh enough to request close.' }
  if ((Get-FileHash -LiteralPath $planFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedPlanSha256) { throw 'The reviewed plan changed before normal close.' }
  $closeRequestedAt = [DateTime]::UtcNow.ToString('o'); $closeRequested = $true
  $closeAccepted = $current.CloseMainWindow()
  if (-not $closeAccepted) { throw 'The native process did not accept its normal CloseMainWindow request.' }
  $nativeExited = $current.WaitForExit(35000)
  if (-not $nativeExited) { throw 'The exact native process did not exit within 35 seconds. No forced cleanup was attempted.' }
  $nativeExitCode = $current.ExitCode
  if ($nativeExitCode -ne 0) { throw 'The native app exited with a nonzero status; normal graceful shutdown is not verified.' }
  $remaining = @(Installed-Processes); $childDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $childDeadline) { Start-Sleep -Milliseconds 250; $remaining = @(Installed-Processes) }
  if ($remaining.Count -ne 0) { throw 'Processes remain under the exact installation root. No process was forced to stop.' }
  if (@(Port-Listeners).Count -ne 0) { throw 'The previous desktop port still has a listening process.' }
  if (Test-Path -LiteralPath (Join-Path $BlackIceProfilePath 'desktop-runtime.json')) { throw 'The native runtime marker was not removed by normal shutdown.' }
  $closeReceipt = [ordered]@{format=1; product='BLACKICE'; version='2.29.0'; targetVersion='2.30.0'; platform='win32'; verifiedAt=[DateTime]::UtcNow.ToString('o'); baselineSha256=$baselineSha256; planSha256=$ExpectedPlanSha256; idleReceiptSha256=(Get-FileHash -LiteralPath $idleFile -Algorithm SHA256).Hash.ToLowerInvariant(); exactNativeProcess=$initialProcess; method='CloseMainWindow'; requestedAt=$closeRequestedAt; closeRequested=$true; closeAccepted=$true; nativeExited=$true; exitCode=$nativeExitCode; graceful=$true; closed=$true; remainingInstalledProcesses=0; loopbackListenerClosed=$true; runtimeMarkerRemoved=$true; forcedCleanup=$false; providerTurnsRequested=0; routesMutated=$false; errors=@()}
  Save-NewJson $closeFile $closeReceipt
  [ordered]@{verified=$true; closed=$true; version='2.29.0'; pid=$ExpectedPid; forcedCleanup=$false; idleReceipt=$idleFile; closeReceipt=$closeFile} | ConvertTo-Json -Compress
} catch {
  $reason = $_.Exception.Message
  if ($outputsReady) {
    if (-not $idleSaved -and -not (Test-Path -LiteralPath $idleFile)) {
      try { Save-NewJson $idleFile ([ordered]@{format=1; product='BLACKICE'; version='2.29.0'; platform='win32'; verifiedAt=[DateTime]::UtcNow.ToString('o'); baselineSha256=$baselineSha256; planSha256=$ExpectedPlanSha256; idle=$false; statusOk=($samples.Count -gt 0); exactNativeProcess=$initialProcess; samples=$samples; errors=@($reason)}) } catch {}
    }
    if (-not (Test-Path -LiteralPath $closeFile)) {
      try { Save-NewJson $closeFile ([ordered]@{format=1; product='BLACKICE'; version='2.29.0'; platform='win32'; verifiedAt=[DateTime]::UtcNow.ToString('o'); method='CloseMainWindow'; requestedAt=$closeRequestedAt; exactNativeProcess=$initialProcess; closeRequested=$closeRequested; closeAccepted=$closeAccepted; nativeExited=$nativeExited; exitCode=$nativeExitCode; graceful=$false; closed=$false; forcedCleanup=$false; errors=@($reason)}) } catch {}
    }
  }
  [ordered]@{verified=$false; closed=$false; closeRequested=$closeRequested; forcedCleanup=$false; error=$reason} | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($null -ne $native) { $native.Dispose() }
  if ($null -ne $current) { $current.Dispose() }
}
