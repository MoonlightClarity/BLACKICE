param([string]$AgentPath,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($AgentPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Guest agent syntax failed.'}
$native=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.Contains('public static class BLACKICEGuestJson')})[0].Value
if(!$native){throw 'Guest metadata publisher is missing.'}
Add-Type -TypeDefinition $native
$Bridge=$FixtureRoot
foreach($name in @('Save-Json','Register-ClipboardResponseExpiry','Remove-ExpiredClipboardResponses')){
  $definition=$ast.Find({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(!$definition){throw 'Expiry function is missing.'}
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$Responses=Join-Path $FixtureRoot 'responses';$ClipboardExpiry=Join-Path $FixtureRoot 'clipboard-expiry'
New-Item -ItemType Directory -Path $Responses,$ClipboardExpiry -Force|Out-Null
$AgentId='a'*32;$SessionId=2
function Assert($value,[string]$message){if(!$value){throw $message}}
function Seed([string]$id,[int]$seconds){
  $request=@{requestId=$id;kind='clipboard_read';expiresAt=[DateTime]::UtcNow.AddSeconds($seconds).ToString('o')}
  Register-ClipboardResponseExpiry $request
  Save-Json (Join-Path $Responses ($id+'.json')) @{result=@{text='Only a temporary fixture'}}
}
$expired='1'*32;$future='2'*32;$generic='3'*32
Seed $expired -10;Seed $future 60
Save-Json (Join-Path $Responses ($generic+'.json')) @{kind='windows';result=@{windows=@()}}
$AgentId='b'*32 # A restarted agent must expire its predecessor's proof.
Remove-ExpiredClipboardResponses
Assert (!(Test-Path -LiteralPath (Join-Path $Responses ($expired+'.json')))) 'Old-agent clipboard plaintext survived expiry.'
Assert (Test-Path -LiteralPath (Join-Path $Responses ($future+'.json'))) 'Unexpired clipboard response was removed.'
Assert (Test-Path -LiteralPath (Join-Path $Responses ($generic+'.json'))) 'Generic history was removed.'
Assert (!(Test-Path -LiteralPath (Join-Path $ClipboardExpiry ($expired+'.json')))) 'Expired proof remained.'

# Invalid/private marker data cannot authorize a generic response deletion.
Save-Json (Join-Path $ClipboardExpiry ($generic+'.json')) @{version=1;requestId=$generic;kind='windows';agentId=$AgentId;guestSessionId=2;expiresAt=[DateTime]::UtcNow.AddSeconds(-5).ToString('o')}
$script:LastClipboardCleanup=$null;Remove-ExpiredClipboardResponses
Assert (Test-Path -LiteralPath (Join-Path $Responses ($generic+'.json'))) 'A non-clipboard marker deleted generic data.'
Assert (!(Test-Path -LiteralPath (Join-Path $ClipboardExpiry ($generic+'.json')))) 'Invalid metadata was not removed.'

Save-Json (Join-Path $ClipboardExpiry ($generic+'.json')) @{version=1;requestId=('../'+$generic);kind='clipboard_read';agentId=$AgentId;guestSessionId=2;expiresAt=[DateTime]::UtcNow.AddSeconds(-5).ToString('o')}
$script:LastClipboardCleanup=$null;Remove-ExpiredClipboardResponses
Assert (Test-Path -LiteralPath (Join-Path $Responses ($generic+'.json'))) 'Mismatched marker identity deleted data.'

[IO.File]::WriteAllText((Join-Path $ClipboardExpiry ($generic+'.json')),'{bad json')
$script:LastClipboardCleanup=$null;Remove-ExpiredClipboardResponses
Assert (Test-Path -LiteralPath (Join-Path $Responses ($generic+'.json'))) 'Malformed marker deleted data.'
Assert (!(Test-Path -LiteralPath (Join-Path $ClipboardExpiry ($generic+'.json')))) 'Malformed metadata can starve cleanup.'

# The first pass is bounded; a later/startup pass finishes old markers.
Remove-Item -LiteralPath (Join-Path $ClipboardExpiry ($future+'.json')) -Force
for($i=10;$i -lt 35;$i++){Seed ($i.ToString('x32')) -10}
$script:LastClipboardCleanup=$null;Remove-ExpiredClipboardResponses
Assert (@(Get-ChildItem -LiteralPath $ClipboardExpiry -File).Count -eq 5) 'Cleanup was not bounded to twenty markers.'
Remove-ExpiredClipboardResponses
Assert (@(Get-ChildItem -LiteralPath $ClipboardExpiry -File).Count -eq 5) 'Cleanup ignored its one-second cadence.'
$script:LastClipboardCleanup=$null;Remove-ExpiredClipboardResponses
Assert (@(Get-ChildItem -LiteralPath $ClipboardExpiry -File).Count -eq 0) 'Restart cleanup did not finish old responses.'
Assert (Test-Path -LiteralPath (Join-Path $Responses ($generic+'.json'))) 'Generic history changed during bounded cleanup.'
Write-Output 'CLIPBOARD_EXPIRY_FIXTURES_PASS'
