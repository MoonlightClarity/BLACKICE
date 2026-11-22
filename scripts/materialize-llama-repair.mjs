import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LLAMA_RUNTIME_REPAIR_PIN, validateLlamaRepairPin, verifyLlamaRepairManifest, verifyLlamaFileTree } from '../lib/llama-cpp-bundle.mjs';
const execute=promisify(execFile),source=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fail=message=>Object.assign(Error(message),{code:'LLAMA_REPAIR_MATERIALIZATION'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const aborted=signal=>{if(signal?.aborted)throw signal.reason||Object.assign(Error('Repair materialization cancelled.'),{name:'AbortError'});};
const missing=error=>{if(error.code==='ENOENT')return null;throw error;};
const contains=(outer,inner)=>{const relative=path.relative(outer,inner);return !relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
async function ordinaryDirectory(directory,{optional=false}={}){
  const info=await fs.lstat(directory).catch(missing);
  if(!info&&optional)return null;
  if(!info?.isDirectory()||info.isSymbolicLink())throw fail('A repair input or destination must be an ordinary directory.');
  return info;
}
async function snapshot(stream,expected,signal){
  if(!stream||typeof stream[Symbol.asyncIterator]!=='function')throw fail('The repair archive response has no readable body.');
  const chunks=[],hash=createHash('sha256');let size=0;
  for await(const chunk of stream){aborted(signal);const bytes=Buffer.from(chunk);size+=bytes.length;
    if(size>expected.size)throw fail('The repair archive exceeds its pinned size.');
    hash.update(bytes);chunks.push(bytes);
  }
  aborted(signal);
  if(size!==expected.size||hash.digest('hex')!==expected.sha256)throw fail('The repair archive failed its pinned size or checksum.');
  return Buffer.concat(chunks,size);
}
async function cachedSnapshot(file,expected,signal){
  const info=await fs.lstat(file).catch(missing);if(!info)return null;
  if(!info.isFile()||info.isSymbolicLink()||info.size!==expected.size)throw fail('The cached repair archive is linked, invalid, or has the wrong size.');
  return snapshot(createReadStream(file),expected,signal);
}
async function downloadSnapshot(asset,fetchImpl,signal){
  let url=asset.url;
  for(let redirects=0;redirects<=5;redirects++){
    aborted(signal);
    const response=await fetchImpl(url,{signal,redirect:'manual'});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers?.get?.('location');
      if(!location||redirects===5)throw fail('The repair archive redirect could not be followed safely.');
      const next=new URL(location,url);
      if(next.protocol!=='https:'||next.username||next.password||next.hash)throw fail('The repair archive redirect must remain HTTPS without credentials.');
      if(response.body?.cancel)await response.body.cancel();
      url=next.href;continue;
    }
    if(!response.ok)throw fail('The repair archive download failed: '+response.status);
    return snapshot(response.body,asset,signal);
  }
  throw fail('The repair archive redirect limit was reached.');
}
async function extractRepairArchive(archive,target,expected){
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const entries=Buffer.from(JSON.stringify(expected)).toString('base64');
  const script=[
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('+quote(entries)+')) | ConvertFrom-Json',
    '$allowed=New-Object "System.Collections.Generic.Dictionary[string,long]" ([System.StringComparer]::Ordinal)',
    'foreach($e in $expected){$allowed.Add($e.path,[long]$e.size)}',
    '$z=[System.IO.Compression.ZipFile]::OpenRead('+quote(archive)+')',
    'try {',
    '$seen=New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)',
    '$files=0',
    'foreach($e in $z.Entries){',
    'if(-not $seen.Add($e.FullName)){throw "Duplicate repair archive path"}',
    '$kind=($e.ExternalAttributes -shr 16) -band 61440',
    'if(($e.ExternalAttributes -band 1024) -ne 0 -or $kind -eq 40960){throw "Linked repair archive entry"}',
    'if($e.FullName -ceq "bin/" -and $e.Length -eq 0){if($kind -ne 0 -and $kind -ne 16384){throw "Invalid directory entry"};continue}',
    'if(($e.ExternalAttributes -band 16) -ne 0 -or ($kind -ne 0 -and $kind -ne 32768)){throw "Non-regular repair archive entry"}',
    'if(-not $allowed.ContainsKey($e.FullName) -or $e.Length -ne $allowed[$e.FullName]){throw "Unlisted, unsafe, or wrong-size repair archive entry"}',
    '$files++',
    '}',
    'if($files -ne $allowed.Count){throw "Missing repair archive entry"}',
    'foreach($e in $z.Entries){if($e.FullName -ceq "bin/"){continue};[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,[IO.Path]::Combine('+quote(target)+',$e.FullName),$false)}',
    '} finally {$z.Dispose()}',
  ].join('; ');
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:60000,maxBuffer:65536});
}
function createMaterializer(repairPin,{sourceRoot=source,platform=process.platform,arch=process.arch,extract=extractRepairArchive,rename=fs.rename}={}){
  return async function materialize(options={}){
    const pin=validateLlamaRepairPin(repairPin);
    if(platform!=='win32'||arch!=='x64')throw fail('Repair materialization supports Windows x64 only.');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['destination','cache','fetchImpl','signal'].includes(key)))
      throw fail('Only destination, cache, fetchImpl, and signal are accepted; runtime trust is source-pinned.');
    const {destination,cache,fetchImpl=fetch,signal}=options;
    if(typeof destination!=='string'||!destination.trim()||typeof cache!=='string'||!cache.trim()||typeof fetchImpl!=='function')
      throw fail('Supply dedicated repair destination and cache directories.');
    const target=path.resolve(destination),parent=path.dirname(target),cacheRoot=path.resolve(cache);
    if(parent===target||path.dirname(cacheRoot)===cacheRoot||contains(target,path.resolve(sourceRoot))||contains(target,cacheRoot)||contains(cacheRoot,target))
      throw fail('The repair destination and cache must be separate and must not contain source inputs.');
    aborted(signal);
    await ordinaryDirectory(target,{optional:true});await ordinaryDirectory(cacheRoot,{optional:true});
    await fs.mkdir(cacheRoot,{recursive:true});await ordinaryDirectory(cacheRoot);
    const asset=pin.repairArchive,archive=path.join(cacheRoot,asset.name);
    let bytes=await cachedSnapshot(archive,asset,signal),cacheSource='verified-cache';
    if(!bytes){
      const downloadSignal=AbortSignal.any([AbortSignal.timeout(180000),...(signal?[signal]:[])]);
      bytes=await downloadSnapshot(asset,fetchImpl,downloadSignal);cacheSource='downloaded';
      const temporary=path.join(cacheRoot,'.llama-repair-download-'+randomUUID()+'.tmp');
      try{
        aborted(signal);await fs.writeFile(temporary,bytes,{flag:'wx'});
        try{await fs.link(temporary,archive);}
        catch(error){if(error.code!=='EEXIST')throw error;const existing=await cachedSnapshot(archive,asset,signal);if(!existing?.equals(bytes))throw fail('The repair cache changed during publication.');}
      }finally{await fs.rm(temporary,{force:true});}
    }
    aborted(signal);
    await fs.mkdir(parent,{recursive:true});await ordinaryDirectory(parent);
    const stage=await fs.mkdtemp(path.join(parent,'.llama-repair-stage-')),previous=stage+'.previous';
    let previousMoved=false,promoted=false;
    try{
      const input=path.join(stage,'.input.zip');await fs.writeFile(input,bytes,{flag:'wx'});await fs.mkdir(path.join(stage,'bin'));
      await extract(input,stage,[{path:'manifest.json',size:pin.buildManifest.size},...pin.repairFiles.map(({path,size})=>({path,size}))]);
      aborted(signal);await fs.unlink(input);
      const manifestBytes=await fs.readFile(path.join(stage,'manifest.json'));
      verifyLlamaRepairManifest(manifestBytes,pin);
      await verifyLlamaFileTree(stage,pin.repairFiles,{manifestBytes});
      aborted(signal);await ordinaryDirectory(target,{optional:true});
      try{await rename(target,previous);previousMoved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
      try{await rename(stage,target);promoted=true;}
      catch(error){
        if(previousMoved){
          try{await rename(previous,target);previousMoved=false;}
          catch(rollback){throw Object.assign(Error('Repair promotion and recovery failed; the prior directory is retained at '+previous),{code:'LLAMA_REPAIR_PROMOTION_UNCERTAIN',destination:target,previous,cause:error,rollbackCode:rollback.code||null});}
        }
        throw error;
      }
      return {schema:'blackice.llama-repair-materialization.v1',runtimeId:pin.runtimeId,destination:target,cacheSource,
        archive:pin.repairArchive,manifest:pin.buildManifest,files:pin.repairFiles,
        bytes:pin.buildManifest.size+pin.repairFiles.reduce((sum,file)=>sum+file.size,0)};
    }finally{
      if(!promoted)await fs.rm(stage,{recursive:true,force:true});
      if(promoted&&previousMoved)await fs.rm(previous,{recursive:true,force:true});
    }
  };
}
export async function materializeLlamaRepair(options={}){return createMaterializer(LLAMA_RUNTIME_REPAIR_PIN)(options);}
// Internal fixture seam only; production pins cannot be supplied through CLI or environment.
export const llamaMaterializationTest=Object.freeze({createMaterializer});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw fail('The materializer CLI accepts no trust overrides.');
  console.log(await materializeLlamaRepair({destination:path.join(source,'.build/llama-repair'),cache:path.join(source,'.build/llama-cache')}));
}
