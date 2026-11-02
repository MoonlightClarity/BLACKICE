param([string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor did not parse.'}
$native=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.StartsWith('using System;')})[0].Value
$fixture=@'
public sealed class OutputFixtureReader : System.IO.TextReader {
 readonly string text;int position;public OutputFixtureReader(string value){text=value;}
 public override int Read(char[] buffer,int offset,int count){int take=System.Math.Min(7,System.Math.Min(count,text.Length-position));if(take>0){text.CopyTo(position,buffer,offset,take);position+=take;}return take;}
}
'@
Add-Type -TypeDefinition ($native+[Environment]::NewLine+$fixture)
$checks=0
function Check([string]$Text,[bool]$Truncated,[int]$ExpectedBytes){
 $reader=[OutputFixtureReader]::new($Text)
 $result=[BLACKICEAgentJob]::ReadOutput($reader)
 if($result.Truncated -ne $Truncated -or $result.CharactersRead -ne $Text.Length -or [Text.Encoding]::UTF8.GetByteCount($result.Text) -ne $ExpectedBytes){throw 'Stream completeness or byte bound mismatch.'}
 [void][Text.UTF8Encoding]::new($false,$true).GetBytes($result.Text)
 $script:checks++
}
Check ('x'*16384) $false 16384
Check ('x'*100000) $true 16384
Check (([string][char]0x00e9)*8192) $false 16384
Check (([string][char]0x00e9)*8193) $true 16384
$emoji=[char]::ConvertFromUtf32(0x1f9ca)
Check ($emoji*10000) $true 16384
$prefix='{"ok":true}'+(' '*20000)
$result=[BLACKICEAgentJob]::ReadOutput([OutputFixtureReader]::new($prefix))
if(!$result.Truncated -or !($result.Text|ConvertFrom-Json).ok){throw 'Passing JSON prefix fixture invalid.'}
$checks++
@{checks=$checks;jobConstructed=$false;childStarted=$false}|ConvertTo-Json -Compress
