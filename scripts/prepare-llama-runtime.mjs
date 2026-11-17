import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LLAMA_BUNDLE_VERSION } from '../lib/llama-cpp-bundle.mjs';
const execute = promisify(execFile);
export const LLAMA_RUNTIME_PIN = Object.freeze({
  release:'b12359', sourceCommit:'b1b770d90', stableRelease:'v1.0.0',
  cpu:{name:'llama-b12359-bin-win-cpu-x64.zip',size:25097509,sha256:'837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69'},
  vulkan:{name:'llama-b12359-bin-win-vulkan-x64.zip',size:38090643,sha256:'e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e'},
});
const hash = data => createHash('sha256').update(data).digest('hex');
export async function prepareLlamaRuntime({destination,cache,fetchImpl=fetch}={}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Bundled runtime packaging currently supports Windows x64 only.');
  await fs.mkdir(cache,{recursive:true}); await fs.mkdir(destination,{recursive:true});
  const files=[];
  for (const backend of ['cpu','vulkan']) {
    const asset=LLAMA_RUNTIME_PIN[backend], archive=path.join(cache,asset.name);
    let bytes=await fs.readFile(archive).catch(()=>null);
    if (!bytes || bytes.length!==asset.size || hash(bytes)!==asset.sha256) {
      const response=await fetchImpl('https://github.com/ggml-org/llama.cpp/releases/download/b12359/'+asset.name,{signal:AbortSignal.timeout(180000)});
      if (!response.ok) throw Error('Official llama.cpp runtime download failed: '+response.status);
      bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length!==asset.size || hash(bytes)!==asset.sha256)throw Error('Official llama.cpp runtime checksum mismatch.');
      await fs.writeFile(archive,bytes);
    }
    const target=path.resolve(destination,backend);
    if (path.dirname(target)!==path.resolve(destination) || !['cpu','vulkan'].includes(path.basename(target))) throw Error('Runtime staging escaped its destination.');
    await fs.rm(target,{recursive:true,force:true});await fs.mkdir(target,{recursive:true});
    // Only a checksum-pinned upstream archive is expanded, never user input.
    await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${archive.replaceAll("'","''")}'); try { foreach($e in $z.Entries) { if($e.FullName -ne $e.Name) {throw 'Unexpected archive path'}; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,[System.IO.Path]::Combine('${target.replaceAll("'","''")}',$e.Name),$true) } } finally {$z.Dispose()}`],{windowsHide:true,timeout:60000});
    for(const entry of await fs.readdir(target,{withFileTypes:true})) {
      if(!entry.isFile())throw Error('Unexpected upstream runtime archive layout.');
      const filename=path.join(target,entry.name);
      // Keep the upstream dependency DLL set; exclude unrelated command tools.
      if(!entry.name.endsWith('.dll') && entry.name!=='llama-server.exe' && !entry.name.startsWith('LICENSE')) {await fs.unlink(filename);continue;}
      const data=await fs.readFile(filename);files.push({path:backend+'/'+entry.name,size:data.length,sha256:hash(data)});
    }
  }
  const license=await fs.readFile(new URL('../desktop/llama.cpp-LICENSE',import.meta.url));
  await fs.writeFile(path.join(destination,'LICENSE'),license);
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({version:LLAMA_BUNDLE_VERSION,pin:LLAMA_RUNTIME_PIN,files},null,2)+'\n');
  return {destination,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0)};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
  console.log(await prepareLlamaRuntime({destination:path.join(root,'.build/llama.cpp'),cache:path.join(root,'.build/llama-cache')}));
}
