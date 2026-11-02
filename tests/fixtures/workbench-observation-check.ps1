param([string]$Source,[string]$Scratch)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor did not parse.'}
$helper=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.StartsWith('function Convert-BLACKICEObservationValue')})[0].Value
if(!$helper){throw 'Structured observation helper absent.'}
. ([scriptblock]::Create($helper))
$file=Join-Path $Scratch 'channel.txt'
[IO.File]::WriteAllText($file,'pref("app.update.channel", "release");',[Text.UTF8Encoding]::new($false))
$raw=Get-Content -LiteralPath $file -Raw
if(!$raw.PSObject.Properties['PSPath']){throw 'The actual PowerShell provider-string fixture lost its metadata.'}
function Capture($Data,[bool]$MustFail=$false){
 $previous=[Console]::Out;$writer=[IO.StringWriter]::new();$failed=$false
 try{[Console]::SetOut($writer);try{Write-BLACKICEObservation -Data $Data}catch{$failed=$true}}
 finally{[Console]::SetOut($previous)}
 $text=$writer.ToString()
 if($MustFail){if(!$failed -or $text.Length){throw 'Rejected observation emitted partial or invalid stdout.'};return}
 if($failed){throw 'Valid observation was rejected.'}
 return $text
}
$data=[ordered]@{channel=$raw;flags=@($true,$false);empty=@();single=@('one');nothing=$null;count=7;unicode=[string][char]0x00e9;when=[datetime]::SpecifyKind([datetime]'2026-01-02T03:04:05',[DateTimeKind]::Utc)}
$text=Capture $data
$result=$text|ConvertFrom-Json
if($result.channel -cne [IO.File]::ReadAllText($file) -or $text -match '"PS(Drive|Provider|Path|ParentPath)"'){throw 'Provider metadata leaked into a primitive observation.'}
if($result.flags.Count -ne 2 -or $result.flags[0] -ne $true -or $result.flags[1] -ne $false -or $result.empty.Count -ne 0 -or $result.single.Count -ne 1 -or $result.single[0] -cne 'one' -or $null -ne $result.nothing -or $result.count -ne 7 -or $result.unicode -cne [string][char]0x00e9 -or $result.when -cne '2026-01-02T03:04:05.0000000Z'){throw 'Typed observation normalization changed its values.'}
$boundary=Capture @{value=('x'*16372)}
if([Text.Encoding]::UTF8.GetByteCount($boundary) -ne 16384 -or ($boundary|ConvertFrom-Json).value.Length -ne 16372){throw 'The exact-limit observation must fit without an extra newline.'}
Capture @{value=('x'*16373)} $true
Capture @{value=('x'*20000)} $true
Capture @{file=(Get-Item -LiteralPath $file)} $true
Capture @{value=[double]::NaN} $true
Capture @{value=[decimal]'9007199254740991.1'} $true
$caseSensitive=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$caseSensitive.Add('value',1);$caseSensitive.Add('Value',2)
Capture $caseSensitive $true
$nested=@{value='leaf'};1..10|ForEach-Object {$nested=@{value=$nested}}
Capture $nested $true
@{providerMetadataRemoved=$true;typedValuesPreserved=$true;exactByteLimitPreserved=$true;rejectedWithoutPartialJson=7;guestOperations=0}|ConvertTo-Json -Compress
