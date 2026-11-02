param([string]$AgentPath,[string]$FixturePath,[switch]$Invalid)
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText($AgentPath,[Text.UTF8Encoding]::new($false,$true))
$match=[regex]::Match($source,"Add-Type -TypeDefinition @'\r?\n(?<code>[\s\S]*?)\r?\n'@")
if(!$match.Success){throw 'Guest clipboard validation source is missing.'}
# Compile the actual guest types, but call only pure Unicode validation/hash.
# No clipboard, input, display, process or window API is invoked.
Add-Type -TypeDefinition $match.Groups['code'].Value
$line=@($source -split '\r?\n'|Where-Object {$_ -match '^\s*\$request=\[IO.File\]::ReadAllText\(\$entry.FullName,\[Text.UTF8Encoding\]::new\(\$false,\$true\)\)\|ConvertFrom-Json$'})
if($line.Count -ne 1){throw 'The guest request reader is not explicit strict UTF-8.'}
$entry=[pscustomobject]@{FullName=$FixturePath}
if($Invalid){
 $rejected=$false;try{Invoke-Expression $line[0]}catch{$rejected=$true}
 if(!$rejected){throw 'Malformed UTF-8 was accepted.'}
 @{invalidUtf8Rejected=$true;clipboardAccessed=$false}|ConvertTo-Json -Compress
}else{
 Invoke-Expression $line[0]
 $text=[string]$request.args.text
 @{characters=$text.Length;sha256=[BLACKICEGuestClipboard]::TextSha256($text);clipboardAccessed=$false;reader='actual guest strict UTF-8 line'}|ConvertTo-Json -Compress
}
