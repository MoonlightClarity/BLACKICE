// Reconstruct only the exact accepted native product bytes, never a development tree.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyFreeRdpRuntime,activateOpenSslProviders} from './package-workbench-freerdp.mjs';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const digest=/^[a-f0-9]{64}$/,relative=v=>typeof v==='string'&&/^[A-Za-z0-9_.+/-]+$/.test(v)&&!v.startsWith('/')&&v.split('/').every(s=>s&&s!=='.'&&s!=='..');
const fail=()=>{throw Error('The pinned native Workbench package is incomplete or changed.');};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function accepted(a,d){
  if(a.schema!==1||a.scope!=='local-preview'||a.fullAcceptance!==false||a.helperSha256!==d.helperSha256||a.runtimeManifestSha256!==d.runtimeManifestSha256||a.timingBasis!=='decoded-surface'||a.detachedControls!==true||['sameConsolePixels','inputOwnership','noHostActivation','motionAndLatency','lifecycle'].some(k=>a.checks?.[k]!==true))fail();
}
async function ordinary(file,kind='file'){
  for(let cursor=path.resolve(file);;cursor=path.dirname(cursor)){
    const s=await fs.lstat(cursor);if(s.isSymbolicLink()||(cursor===path.resolve(file)?kind==='file'?!s.isFile():!s.isDirectory():!s.isDirectory()))fail();
    if(cursor===path.dirname(cursor))break;
  }
}
async function bytes(file,maximum=256*1024*1024){await ordinary(file);const s=await fs.stat(file);if(s.size>maximum)fail();const b=await fs.readFile(file);if(b.length!==s.size||b.length>maximum)fail();return b;}
async function json(file){return JSON.parse((await bytes(file,2*1024*1024)).toString('utf8'));}
async function files(root,prefix=''){
  await ordinary(path.join(root,prefix),'directory');const result=[];
  for(const n of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){const r=prefix?prefix+'/'+n.name:n.name;if(n.isSymbolicLink())fail();if(n.isDirectory())result.push(...await files(root,r));else if(n.isFile())result.push(r);else fail();}
  return result.sort();
}
async function verifyRows(root,rows){
  if(!Array.isArray(rows)||rows.length>2000||new Set(rows.map(r=>r.path.toLowerCase())).size!==rows.length)fail();
  for(const r of rows){if(!relative(r.path)||!digest.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<0)fail();const b=await bytes(path.join(root,r.path));if(b.length!==r.bytes||sha(b)!==r.sha256)fail();}
}
export async function readWorkbenchNativePackage(sourceDirectory){
  const source=path.resolve(sourceDirectory),inventory=await json(path.join(source,'package.json'));
  if(inventory.schema!==1||inventory.scope!=='local-preview'||inventory.fullAcceptance!==false||!digest.test(inventory.helperSourceSha256)||!inventory.descriptor||!Array.isArray(inventory.archives))fail();
  if(!equal((await files(source)).filter(p=>p!=='package.json'),inventory.sourceFiles.map(r=>r.path).sort()))fail();
  await verifyRows(source,inventory.sourceFiles);
  const d=inventory.descriptor;
  if(d.schema!==1||d.helper!=='workbench-freerdp-client.exe'||d.runtime!=='runtime'||d.dependencyLock!=='dependency-lock.json'||d.acceptance!=='acceptance.json'||![d.helperSha256,d.runtimeManifestSha256,d.dependencyLockSha256].every(v=>digest.test(v)))fail();
  const manifest=await json(path.join(source,'runtime-manifest.json')),lock=await json(path.join(source,d.dependencyLock)),acceptance=await json(path.join(source,d.acceptance));
  accepted(acceptance,d);
  const bound=n=>inventory.sourceFiles.find(r=>r.path===n)?.sha256;
  if(bound(d.helper)!==d.helperSha256||bound('runtime-manifest.json')!==d.runtimeManifestSha256||bound(d.dependencyLock)!==d.dependencyLockSha256||manifest.sourceLockSHA256!==d.dependencyLockSha256||acceptance.helperSha256!==d.helperSha256||acceptance.runtimeManifestSha256!==d.runtimeManifestSha256||acceptance.scope!=='local-preview'||acceptance.fullAcceptance!==false)fail();
  if(inventory.archives.length!==manifest.packages.length||new Set(inventory.archives.map(p=>p.file)).size!==inventory.archives.length)fail();
  for(const p of inventory.archives){const m=manifest.packages.find(m=>m.archive===p.file),l=lock.packageArtifacts.find(l=>l.file===p.file);if(!m||!l||!relative(p.file)||p.file.includes('/')||p.sha256!==m.sha256||p.sha256!==l.sha256.toLowerCase()||p.url!=='https://repo.msys2.org/mingw/ucrt64/'+p.file)fail();}
  return {source,inventory,manifest,lock,acceptance};
}

export async function downloadPinnedArchive({url,file,sha256,signal,fetchImpl=fetch}){
  let last;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetchImpl(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000),redirect:'error'});if(!response.ok||Number(response.headers.get('content-length'))>256*1024*1024)fail();
      const chunks=[];let total=0;
      for await(const c of response.body){total+=c.length;if(total>256*1024*1024)fail();chunks.push(c);}
      const b=Buffer.concat(chunks);if(sha(b)!==sha256)fail();await fs.writeFile(file,b,{flag:'wx'});return;
    }catch(e){last=e;if(signal?.aborted)throw e;if(attempt<2)await new Promise(r=>setTimeout(r,250*(attempt+1)));}
  }
  throw last;
}

export async function verifyInstalledWorkbenchNative({appDirectory,resourcesDirectory,systemDirectory,verifyRuntime=verifyFreeRdpRuntime}={}){
  const inventory=await json(path.join(appDirectory,'resources/workbench-native/package.json'));
  if(inventory.schema!==1||inventory.scope!=='local-preview'||inventory.fullAcceptance!==false)fail();
  const root=path.join(resourcesDirectory,'workbench-native');
  await verifyRows(root,inventory.files);
  if(!equal(await files(root),inventory.files.map(r=>r.path).sort()))fail();
  if(!equal(await json(path.join(root,'native-display.json')),inventory.descriptor))fail();
  accepted(await json(path.join(root,'acceptance.json')),inventory.descriptor);
  await verifyRuntime({outputDirectory:path.join(root,'runtime'),lockPath:path.join(root,'dependency-lock.json'),systemDirectory});
  await verifyRows(root,inventory.files);if(!equal(await files(root),inventory.files.map(r=>r.path).sort()))fail();
  return {verified:true,scope:'local-preview',fullAcceptance:false,helperSha256:inventory.descriptor.helperSha256,runtimeManifestSha256:inventory.descriptor.runtimeManifestSha256,filesVerified:inventory.files.length};
}

export async function stageWorkbenchNative({sourceDirectory,outputDirectory,cacheDirectory,systemDirectory,
  verifyRuntime=verifyFreeRdpRuntime,download=downloadPinnedArchive,extract=async({archive,directory,members})=>{
    await execute(path.join(systemDirectory,'tar.exe'),['-xf',archive,'-C',directory,'--',...members],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  }}={}){
  const state=await readWorkbenchNativePackage(sourceDirectory),{inventory,manifest}=state;
  const output=path.resolve(outputDirectory),cache=path.resolve(cacheDirectory);
  if(await fs.lstat(output).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)))fail();
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(cache,{recursive:true});await ordinary(cache,'directory');
  const temp=await fs.mkdtemp(path.join(path.dirname(output),'.native-package-'));
  const deadline=AbortSignal.timeout(15*60*1000);
  try{
    for(const r of inventory.sourceFiles){const destination=r.path==='runtime-manifest.json'?'runtime/runtime-manifest.json':r.path==='runtime-notices.txt'?'runtime/THIRD-PARTY-NOTICES.txt':r.path;await fs.mkdir(path.dirname(path.join(temp,destination)),{recursive:true});await fs.copyFile(path.join(state.source,r.path),path.join(temp,destination));}
    const queue=[...inventory.archives];
    const workers=await Promise.allSettled(Array.from({length:4},async()=>{while(queue.length){deadline.throwIfAborted();const a=queue.shift(),cached=path.join(cache,a.file);let content;try{content=await bytes(cached);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(content){if(sha(content)!==a.sha256)fail();}else{const partial=path.join(cache,'.'+a.file+'.'+randomUUID());try{await download({...a,file:partial,sha256:a.sha256,signal:deadline});if(sha(await bytes(partial))!==a.sha256)fail();await fs.rename(partial,cached);}finally{await fs.rm(partial,{force:true});}}
      const selected=manifest.files.filter(f=>f.package===manifest.packages.find(p=>p.archive===a.file).name&&f.sourcePath),members=[...new Set(selected.map(f=>f.sourcePath))];if(members.some(p=>!relative(p)))fail();
      const extracted=path.join(temp,'.extract',a.file);await fs.mkdir(extracted,{recursive:true});await extract({archive:cached,directory:extracted,members});
      for(const r of selected){const b=await bytes(path.join(extracted,r.sourcePath));if(b.length!==r.size||sha(b)!==r.sha256)fail();const target=path.join(temp,'runtime',r.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,b,{flag:'wx'});}
    }}));
    const failed=workers.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    const cfg=activateOpenSslProviders(await fs.readFile(path.join(temp,'runtime/etc/ssl/openssl.cnf.dist'),'utf8'));await fs.writeFile(path.join(temp,'runtime/etc/ssl/openssl.cnf'),cfg,{flag:'wx'});
    const extractionRoot=path.resolve(temp,'.extract');if(path.dirname(extractionRoot)!==path.resolve(temp))fail();
    await fs.rm(extractionRoot,{recursive:true,force:true});
    await fs.writeFile(path.join(temp,'native-display.json'),JSON.stringify(inventory.descriptor,null,2)+'\n',{flag:'wx'});
    await verifyRows(temp,inventory.files);if(!equal(await files(temp),inventory.files.map(r=>r.path).sort()))fail();
    await verifyRuntime({outputDirectory:path.join(temp,'runtime'),lockPath:path.join(temp,'dependency-lock.json'),systemDirectory});
    await verifyRows(temp,inventory.files);if(!equal(await files(temp),inventory.files.map(r=>r.path).sort()))fail();
    const fresh=await readWorkbenchNativePackage(sourceDirectory);if(!equal(fresh.inventory,inventory))fail();
    await fs.rename(temp,output);return {outputDirectory:output,verified:true,scope:'local-preview',fullAcceptance:false,helperSha256:inventory.descriptor.helperSha256,runtimeManifestSha256:inventory.descriptor.runtimeManifestSha256};
  }finally{if(path.dirname(temp)!==path.dirname(output)||!path.basename(temp).startsWith('.native-package-'))fail();await fs.rm(temp,{recursive:true,force:true});}
}

export async function selfTestWorkbenchNative({directory,systemDirectory,executeFile=execute}={}){
  const d=await json(path.join(directory,'native-display.json')),runtime=path.join(directory,d.runtime),m=await json(path.join(runtime,'runtime-manifest.json'));
  const env={...process.env,PATH:[path.join(runtime,'bin'),systemDirectory,path.dirname(systemDirectory)].join(path.delimiter)};
  for(const key of Object.keys(env))if((key.toUpperCase()==='PATH'&&key!=='PATH')||/^(OPENSSL_CONF|OPENSSL_MODULES|MSYSTEM|GIO_MODULE_DIR|GDK_PIXBUF_MODULE_FILE|FREERDP_ADDIN_PATH)$/i.test(key))delete env[key];
  for(const [key,value]of Object.entries(m.processEnvironment??{}))env[key]=path.resolve(runtime,value);
  const {stdout}=await executeFile(path.join(directory,d.helper),['--self-test'],{cwd:directory,env,windowsHide:true,timeout:15000,maxBuffer:1024*1024});const r=JSON.parse(stdout.trim());
  if(r.ok!==true||r.result?.selfTest!==true||r.result.networkStarted!==false||r.result.foregroundUnchanged!==true||r.result.digestReady!==true||r.result.detachedControlsVerified!==true||r.result.bufferedPresentationVerified!==true||r.result.iconResourcePresent!==true)fail();
  return {passed:true,networkStarted:false,scope:'local-preview',fullAcceptance:false};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),systemDirectory=path.join(process.env.SystemRoot??process.env.WINDIR??'','System32');
  const result=await stageWorkbenchNative({sourceDirectory:path.join(repo,'resources/workbench-native'),outputDirectory:path.join(repo,'.build/workbench-native-package'),cacheDirectory:path.join(repo,'.build/workbench-native-cache'),systemDirectory});
  result.selfTest=await selfTestWorkbenchNative({directory:result.outputDirectory,systemDirectory});console.log(JSON.stringify(result));
}
