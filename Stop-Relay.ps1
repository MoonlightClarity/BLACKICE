$ErrorActionPreference = 'Stop'
$relayUrl = 'http://127.0.0.1:4317'
try {
  $relayHealth = Invoke-RestMethod -Uri "$relayUrl/health" -TimeoutSec 2
  if ($relayHealth.app -ne 'relay-agent-harness') { throw 'Port 4317 belongs to another app.' }
  Invoke-WebRequest -Uri $relayUrl -SessionVariable relayBrowserSession -UseBasicParsing | Out-Null
  Invoke-RestMethod -Uri "$relayUrl/api/shutdown" -Method Post -WebSession $relayBrowserSession -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Host 'Relay is stopping its agents and saving history.'
} catch { Write-Host 'Relay is already stopped, or could not be reached.' }
