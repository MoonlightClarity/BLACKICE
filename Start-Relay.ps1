$ErrorActionPreference = 'Stop'
$relayUrl = 'http://127.0.0.1:4317'
$relayHealth = $null
try { $relayHealth = Invoke-RestMethod -Uri "$relayUrl/health" -TimeoutSec 2 } catch { }
if ($null -eq $relayHealth) {
  $relayNode = (Get-Command node -ErrorAction Stop).Source
  $relayServer = Join-Path $PSScriptRoot 'server.mjs'
  $relayData = Join-Path $PSScriptRoot 'data'
  New-Item -ItemType Directory -Path $relayData -Force | Out-Null
  Start-Process -FilePath $relayNode -ArgumentList @('"' + $relayServer + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $relayData 'server.log') -RedirectStandardError (Join-Path $relayData 'server-error.log') | Out-Null
  for ($relayAttempt = 0; $relayAttempt -lt 40; $relayAttempt++) {
    Start-Sleep -Milliseconds 250
    try { $relayHealth = Invoke-RestMethod -Uri "$relayUrl/health" -TimeoutSec 1; break } catch { }
  }
}
if ($relayHealth.app -ne 'relay-agent-harness') { throw 'Relay did not start. Check data/server-error.log, or free port 4317.' }
Start-Process $relayUrl
