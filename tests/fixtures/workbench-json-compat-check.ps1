param([string]$Source,[string]$Scratch)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor did not parse.'}
$helper=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.StartsWith('function Remove-BLACKICEJsonProviderMetadata')})[0].Value
if(!$helper){throw 'Default JSON compatibility boundary is absent.'}
. ([scriptblock]::Create($helper))
$checks=0
function Assert($Value,[string]$Message){if(!$Value){throw $Message};$script:checks++}
function Equal($Expected,$Actual,[string]$Message){
  $expectedText=[string]$Expected;$actualText=[string]$Actual
  Assert ($expectedText -ceq $actualText) ($Message+' Expected: '+$expectedText.Substring(0,[Math]::Min(200,$expectedText.Length))+' Actual: '+$actualText.Substring(0,[Math]::Min(200,$actualText.Length)))
}
$native=Get-Command Microsoft.PowerShell.Utility\ConvertTo-Json
$proxy=Get-Command ConvertTo-Json
Equal (($native.Parameters.Keys|Sort-Object)-join ',') (($proxy.Parameters.Keys|Sort-Object)-join ',') 'The proxy changed native/common parameter names.'
foreach($name in @('InputObject','Depth','Compress')){
  Equal $native.Parameters[$name].ParameterType.FullName $proxy.Parameters[$name].ParameterType.FullName 'The proxy changed a native parameter type.'
}
$file=Join-Path $Scratch 'provider.txt'
$content='pref("app.update.channel", "release");'+[char]10+[char]0x00e9+[char]0x65e5+[char]0x672c+[char]::ConvertFromUtf32(0x1f600)
[IO.File]::WriteAllText($file,$content,[Text.UTF8Encoding]::new($false))
$raw=Get-Content -LiteralPath $file -Raw -Encoding UTF8
Equal $content $raw 'The fixture content was decoded incorrectly.'
$notes=@($raw.PSObject.Properties|Where-Object MemberType -EQ NoteProperty|ForEach-Object Name)
Assert ($notes -contains 'PSProvider') 'The actual WinPS provider fixture lost its metadata.'
$nativeExpanded=Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{channel=$raw} -Compress -Depth 5
Assert ($nativeExpanded.Length -gt 16384) 'The fixture did not reproduce the actual provider expansion.'
$plain=[string]::new($raw.ToCharArray())
$expected=Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{channel=$plain} -Compress -Depth 5
Equal $expected (ConvertTo-Json -InputObject @{channel=$raw} -Compress -Depth 5) 'Ordinary explicit JSON still serializes provider internals.'
Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $plain -Compress) ($raw|ConvertTo-Json -Compress) 'Ordinary piped provider text was not normalized.'
Equal ($notes -join ',') (@($raw.PSObject.Properties|Where-Object MemberType -EQ NoteProperty|ForEach-Object Name)-join ',') 'Provider metadata was not restored after serialization.'
$nested=[ordered]@{data=@([pscustomobject]@{text=$raw},@($raw),@());flag=$false;empty=$null}
$clean=[ordered]@{data=@([pscustomobject]@{text=$plain},@($plain),@());flag=$false;empty=$null}
Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $clean -Compress -Depth 7) (ConvertTo-Json -InputObject $nested -Compress -Depth 7) 'Nested provider text or array shapes changed.'
$custom=[string]::new('custom string'.ToCharArray())
$custom=$custom|Add-Member -NotePropertyName note -NotePropertyValue 'preserve me' -PassThru
Assert ([bool]$custom.PSObject.Properties['note']) 'The custom string fixture lost its note.'
$dictionary=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$dictionary.Add('value',1);$dictionary.Add('Value',2)
$cases=[ordered]@{
  primitive='plain';nothing=$null;empty=@();single=@('one');bytes=[byte[]]@(0,127,255)
  nested=@(@('one'),@(),@($true,$false));custom=$custom;dictionary=$dictionary
  version=[version]'1.2.3';date=[datetime]::SpecifyKind([datetime]'2026-01-02T03:04:05',[DateTimeKind]::Utc)
  object=[pscustomobject]@{name='value';flags=@($true,$false)}
}
foreach($entry in $cases.GetEnumerator()){
  Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $entry.Value -Compress -Depth 5) (ConvertTo-Json -InputObject $entry.Value -Compress -Depth 5) ('Explicit input changed: '+$entry.Key)
}
foreach($inputValue in @(@(),@('one'),@('one','two'),@($null),@(@(1,2),@(3,4)),[byte[]]@(0,127,255),@($custom,$custom))){
  Equal ($inputValue|Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 5) ($inputValue|ConvertTo-Json -Compress -Depth 5) 'Pipeline enumeration differs from the original cmdlet.'
}
Equal (@($plain,$plain)|Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 5) (@($raw,$raw)|ConvertTo-Json -Compress -Depth 5) 'Piped provider strings lost their expected array shape.'
foreach($compress in @($true,$false)){
  Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $cases.object -Depth 5 -Compress:$compress) (ConvertTo-Json -InputObject $cases.object -Depth 5 -Compress:$compress) 'Compress/default formatting changed.'
}
$PSDefaultParameterValues['ConvertTo-Json:Depth']=5
try {Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $cases.object -Depth 5) (ConvertTo-Json -InputObject $cases.object) 'Default parameter binding changed.'}
finally {$PSDefaultParameterValues.Remove('ConvertTo-Json:Depth')}
$observed=$null
$actual=ConvertTo-Json -InputObject $cases.object -Compress -OutVariable observed
Equal $actual $observed 'The common OutVariable parameter changed.'
$outside=$false
$json=ConvertTo-Json -InputObject @{channel=$raw} -Compress -Depth 5|ForEach-Object {
  $script:outside=[bool]$raw.PSObject.Properties['PSProvider']
  $_
}
Assert $outside 'A downstream consumer observed temporarily removed provider metadata.'
$raw|Add-Member -NotePropertyName customNote -NotePropertyValue 'keep custom'
$customPlain=[string]::new($plain.ToCharArray())
$customPlain=$customPlain|Add-Member -NotePropertyName customNote -NotePropertyValue 'keep custom' -PassThru
Equal (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{channel=$customPlain} -Compress -Depth 5) (ConvertTo-Json -InputObject @{channel=$raw} -Compress -Depth 5) 'Legitimate custom string properties were removed.'
$rejected=$false
try {ConvertTo-Json -InputObject @{channel=$raw} -Depth 101|Out-Null}catch{$rejected=$true}
Assert $rejected 'The native depth error was swallowed.'
Assert ([bool]$raw.PSObject.Properties['PSProvider']) 'Provider metadata was lost after a native error.'
$config=ConvertTo-Json -InputObject @{name='configuration';values=@(1,2)} -Compress
$configPath=Join-Path $Scratch 'config.json'
[IO.File]::WriteAllText($configPath,$config,[Text.UTF8Encoding]::new($false))
$configBytes=[IO.File]::ReadAllBytes($configPath)
Assert ($configBytes[0] -eq 123) 'The boundary changed configuration JSON encoding.'
@{checks=$checks;nativeExpandedCharacters=$nativeExpanded.Length;normalizedCharacters=$expected.Length;providerNotesRestored=$true;qualifiedNativeAvailable=$true;guestOperations=0}|Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
