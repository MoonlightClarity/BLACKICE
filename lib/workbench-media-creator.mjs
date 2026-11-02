/**
 * Official Microsoft Windows 11 Media Creation Tool launcher.
 * This intentionally does NOT automate acceptance of Windows licensing or
 * drive selection. The Microsoft-signed wizard creates the ISO for a guest;
 * the host Windows installation is not a substitute for that image.
 */
import path from 'node:path';

export const WORKBENCH_MICROSOFT_MEDIA_TOOL_URL='https://go.microsoft.com/fwlink/?linkid=2156295';
export const WORKBENCH_MICROSOFT_MEDIA_TOOL_NAME='Microsoft-MediaCreationTool.exe';
const minBytes=5*1024*1024, maxBytes=80*1024*1024;
const issue=(message)=>Object.assign(new Error(message),{code:'WORKBENCH_MEDIA_TOOL_INVALID',status:400});

export function officialWindowsMediaCreatorScript({mediaDirectory,launch=true}={}){
  if(typeof mediaDirectory!=='string'||!path.win32.isAbsolute(mediaDirectory)||
    mediaDirectory.includes('\0')||mediaDirectory.length>3000||typeof launch!=='boolean')
    throw issue('The official Windows media tool needs an absolute local folder.');
  const target=path.win32.join(mediaDirectory,WORKBENCH_MICROSOFT_MEDIA_TOOL_NAME);
  const encoded=Buffer.from(target,'utf8').toString('base64');
  const lines=[
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$dest=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'))",
    "$folder=Split-Path -Parent $dest",
    "New-Item -ItemType Directory -Force -Path $folder | Out-Null",
    "$cached=Test-Path -LiteralPath $dest",
    "if(-not $cached){",
    "  $partial=$dest+'.'+[guid]::NewGuid().ToString('N')+'.partial'",
    "  try{",
    "    Invoke-WebRequest -Uri '"+WORKBENCH_MICROSOFT_MEDIA_TOOL_URL+"' -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 100 -OutFile $partial -ErrorAction Stop",
    "    $tempItem=Get-Item -LiteralPath $partial -ErrorAction Stop",
    "    if($tempItem.Length -lt "+minBytes+" -or $tempItem.Length -gt "+maxBytes+"){throw 'Official Microsoft media tool size was implausible.'}",
    "    $tempSignature=Get-AuthenticodeSignature -LiteralPath $partial",
    "    if($tempSignature.Status -ne 'Valid' -or !$tempSignature.SignerCertificate -or $tempSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'Official Microsoft media tool signature was not valid.'}",
    "    Move-Item -LiteralPath $partial -Destination $dest -ErrorAction Stop",
    "  }finally{Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue}",
    "}",
    "$file=Get-Item -LiteralPath $dest -ErrorAction Stop",
    "if($file.Length -lt "+minBytes+" -or $file.Length -gt "+maxBytes+"){throw 'Cached Microsoft media tool size was implausible.'}",
    "$signature=Get-AuthenticodeSignature -LiteralPath $dest",
    "if($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'Cached media tool failed Microsoft signature verification. No program was launched.'}",
    "$checksum=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()",
    "$result=[ordered]@{verified=$true;cached=[bool]$cached;path=[string]$dest;bytes=[long]$file.Length;sha256=[string]$checksum;signer=[string]$signature.SignerCertificate.Subject;launched=$false}",
    ...(launch?[
      // The official Media Creation Tool is interactive. Do NOT run Windows
      // Setup against the host or auto-accept its license/user decisions.
      "$wizard=Start-Process -FilePath $dest -PassThru -ErrorAction Stop",
      "if(!$wizard){throw 'Microsoft media wizard did not launch.'}",
      "$result.launched=$true",
      "$result.processId=[int]$wizard.Id",
    ]:[]),
    "$result | ConvertTo-Json -Compress -Depth 3"
  ];
  return lines.join('\n');
}

export function parseOfficialWindowsMediaCreatorReceipt(output,{mediaDirectory,launch=true}={}){
  let data;
  try{data=JSON.parse(String(output||'').trim())}catch{throw issue('The Microsoft media tool did not return a readable verification receipt.')}
  const expected=path.win32.join(mediaDirectory||'',WORKBENCH_MICROSOFT_MEDIA_TOOL_NAME);
  if(!data||data.verified!==true||data.launched!==launch||
    typeof data.path!=='string'||path.win32.normalize(data.path).toLowerCase()!==expected.toLowerCase()||
    !Number.isSafeInteger(data.bytes)||data.bytes<minBytes||data.bytes>maxBytes||
    !/^[a-f0-9]{64}$/.test(data.sha256||'')||
    typeof data.signer!=='string'||!data.signer.includes('Microsoft Corporation'))
    throw issue('Microsoft media tool receipt did not confirm the expected signed executable.');
  return {path:data.path,bytes:data.bytes,sha256:data.sha256,signer:data.signer,
    cached:Boolean(data.cached),verified:true,launched:launch,
    ...(launch&&Number.isInteger(data.processId)&&data.processId>0?{processId:data.processId}:{})};
}
