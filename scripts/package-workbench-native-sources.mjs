// Preserve matching upstream source packages as data; never evaluate PKGBUILD.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const HASH=/^[a-f0-9]{64}$/,MAX_FILE=200*1024*1024,MAX_TOTAL=1024*1024*1024;
const safe=p=>typeof p==='string'&&/^[A-Za-z0-9_.+/-]+$/.test(p)&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const fail=message=>{throw Error('Native source companion: '+message);};
// The pinned librsvg recipe downgrades windows-sys after unpacking. Preserve
// explicit compatible alternatives without pretending to possess its modified lock.
const RUST_RECIPE_SUPPLEMENTS=[{"name":"windows-sys","version":"0.60.2","sha256":"f2f500e4d28234f72040990ec9d39e3a6b950f9f22d3dba18416c35882612bcb","registryIndexUrl":"https://index.crates.io/wi/nd/windows-sys","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-targets","version":"0.53.2","sha256":"c66f69fcc9ce11da9966ddb31a40968cad001c5bedeb5c2b82ede4253ab48aef","registryIndexUrl":"https://index.crates.io/wi/nd/windows-targets","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-targets","version":"0.53.3","sha256":"d5fe6031c4041849d7c496a8ded650796e7b6ecc19df1a431c1a363342e5dc91","registryIndexUrl":"https://index.crates.io/wi/nd/windows-targets","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-targets","version":"0.53.4","sha256":"2d42b7b7f66d2a06854650af09cfdf8713e427a439c97ad65a6375318033ac4b","registryIndexUrl":"https://index.crates.io/wi/nd/windows-targets","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-targets","version":"0.53.5","sha256":"4945f9f551b88e0d65f3db0bc25c33b8acea4d9e41163edf90dcd0b19f9069f3","registryIndexUrl":"https://index.crates.io/wi/nd/windows-targets","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-link","version":"0.1.3","sha256":"5e6ad25900d524eaabdbbb96d20b4311e1e7ae1699af4fb28c17ae66c80d798a","registryIndexUrl":"https://index.crates.io/wi/nd/windows-link","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-link","version":"0.2.0","sha256":"45e46c0661abb7180e7b9c281db115305d49ca1709ab8242adf09666d2173c65","registryIndexUrl":"https://index.crates.io/wi/nd/windows-link","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows-link","version":"0.2.1","sha256":"f0805222e57f7521d6a62e36fa9163bc891acd422f971defe97d64e70d0a4fe5","registryIndexUrl":"https://index.crates.io/wi/nd/windows-link","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_aarch64_gnullvm","version":"0.53.0","sha256":"86b8d5f90ddd19cb4a147a5fa63ca848db3df085e25fee3cc10b39b6eebae764","registryIndexUrl":"https://index.crates.io/wi/nd/windows_aarch64_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_aarch64_gnullvm","version":"0.53.1","sha256":"a9d8416fa8b42f5c947f8482c43e7d89e73a173cead56d044f6a56104a6d1b53","registryIndexUrl":"https://index.crates.io/wi/nd/windows_aarch64_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_aarch64_msvc","version":"0.53.0","sha256":"c7651a1f62a11b8cbd5e0d42526e55f2c99886c77e007179efff86c2b137e66c","registryIndexUrl":"https://index.crates.io/wi/nd/windows_aarch64_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_aarch64_msvc","version":"0.53.1","sha256":"b9d782e804c2f632e395708e99a94275910eb9100b2114651e04744e9b125006","registryIndexUrl":"https://index.crates.io/wi/nd/windows_aarch64_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_gnu","version":"0.53.0","sha256":"c1dc67659d35f387f5f6c479dc4e28f1d4bb90ddd1a5d3da2e5d97b42d6272c3","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_gnu","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_gnu","version":"0.53.1","sha256":"960e6da069d81e09becb0ca57a65220ddff016ff2d6af6a223cf372a506593a3","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_gnu","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_gnullvm","version":"0.53.0","sha256":"9ce6ccbdedbf6d6354471319e781c0dfef054c81fbc7cf83f338a4296c0cae11","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_gnullvm","version":"0.53.1","sha256":"fa7359d10048f68ab8b09fa71c3daccfb0e9b559aed648a8f95469c27057180c","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_msvc","version":"0.53.0","sha256":"581fee95406bb13382d2f65cd4a908ca7b1e4c2f1917f143ba16efe98a589b5d","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_i686_msvc","version":"0.53.1","sha256":"1e7ac75179f18232fe9c285163565a57ef8d3c89254a30685b57d83a38d326c2","registryIndexUrl":"https://index.crates.io/wi/nd/windows_i686_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_gnu","version":"0.53.0","sha256":"2e55b5ac9ea33f2fc1716d1742db15574fd6fc8dadc51caab1c16a3d3b4190ba","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_gnu","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_gnu","version":"0.53.1","sha256":"9c3842cdd74a865a8066ab39c8a7a473c0778a3f29370b5fd6b4b9aa7df4a499","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_gnu","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_gnullvm","version":"0.53.0","sha256":"0a6e035dd0599267ce1ee132e51c27dd29437f63325753051e71dd9e42406c57","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_gnullvm","version":"0.53.1","sha256":"0ffa179e2d07eee8ad8f57493436566c7cc30ac536a3379fdf008f47f6bb7ae1","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_gnullvm","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_msvc","version":"0.53.0","sha256":"271414315aff87387382ec3d271b52d7ae78726f5d44ac98b4f4030c91880486","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."},{"name":"windows_x86_64_msvc","version":"0.53.1","sha256":"d6bbff5f0aada427a1e5a6da5f1f98158182f26556f345ac9e04d36d0ebed650","registryIndexUrl":"https://index.crates.io/wi/nd/windows_x86_64_msvc","provenance":"Supplement to exact MSYS2 librsvg PKGBUILD windows-sys downgrade; all published compatible Windows-target candidates, not an observed modified Cargo.lock."}];
export const NATIVE_SOURCE_FILES=Object.freeze([
  'LICENSE','NOTICE','scripts/workbench-freerdp-client/main.cpp','scripts/workbench-freerdp-client/workbench-icon.rc',
  'scripts/workbench-freerdp-client/README.md','scripts/build-workbench-freerdp-client.ps1',
  'scripts/setup-workbench-freerdp.ps1','scripts/setup-workbench-freerdp-compiler.ps1','scripts/workbench-freerdp-lock.ps1',
  'scripts/verify-workbench-compiler.mjs','scripts/package-workbench-freerdp.mjs',
  'scripts/package-workbench-native.mjs','scripts/package-workbench-native-sources.mjs',
  'docs/workbench-freerdp-dependencies.lock.json','docs/workbench-freerdp-compiler.lock.json',
  'desktop/workbench-icon.svg','desktop/workbench-icon.png','desktop/workbench-icon.ico',
  'desktop/workbench-icon.manifest.json','desktop/build-icon.mjs',
]);
async function ordinary(file,kind='file'){
  for(let current=path.resolve(file);;current=path.dirname(current)){
    const s=await fs.lstat(current);
    if(s.isSymbolicLink()||(current===path.resolve(file)?kind==='file'?!s.isFile():!s.isDirectory():!s.isDirectory()))fail('ordinary files and directories required');
    if(current===path.dirname(current))break;
  }
}
async function bytes(file,limit=MAX_FILE){await ordinary(file);const s=await fs.stat(file);if(s.size>limit)fail('file size limit');const b=await fs.readFile(file);if(b.length!==s.size||b.length>limit)fail('file changed');return b;}
async function fileHash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}

export function parseCargoLockSources(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)fail('Cargo lock size limit');
  const result=[],seen=new Map();
  for(const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)){
    const source=/^source\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];if(!source)continue;
    if(source!=='registry+https://github.com/rust-lang/crates.io-index')fail('unsupported Cargo source');
    const name=/^name\s*=\s*"([A-Za-z0-9_-]+)"\s*$/m.exec(block)?.[1],version=/^version\s*=\s*"([A-Za-z0-9_.+-]+)"\s*$/m.exec(block)?.[1],checksum=/^checksum\s*=\s*"([a-f0-9]{64})"\s*$/m.exec(block)?.[1];
    if(!name||!version||!checksum)fail('invalid Cargo lock entry');
    const key=name+'@'+version;if(seen.has(key)&&seen.get(key)!==checksum)fail('conflicting Cargo checksum');if(seen.has(key))continue;seen.set(key,checksum);
    result.push({name,version,sha256:checksum});
  }
  if(result.length>1000)fail('Cargo source count limit');return result;
}

export function validateNativeSourceIndex(index,metadata,{cargoLockContents}={}){
  if(index?.schema!==1||index.product!=='BLACKICE'||index.scope!=='corresponding-native-runtime-source'||index.fullAcceptance!==false||index.runtimeManifestSha256!==metadata.sourceRuntimeManifestSha256||!Array.isArray(index.payloadFiles)||!Array.isArray(index.applicationFiles)||!Array.isArray(index.cargo?.locks)||!Array.isArray(index.cargo?.crates)||JSON.stringify(index.sourceArchives)!==JSON.stringify(metadata.sourcePackages.map(r=>({path:'sources/'+r.archive,...r}))))fail('source companion index mismatch');
  const payload=new Map();for(const row of index.payloadFiles){if(!safe(row.path)||row.path==='SOURCE-INDEX.json'||payload.has(row.path.toLowerCase())||!HASH.test(row.sha256||'')||!Number.isSafeInteger(row.bytes)||row.bytes<0)fail('invalid source payload vector');payload.set(row.path.toLowerCase(),row);}
  const expected=[...index.sourceArchives,...index.applicationFiles,...index.cargo.locks,...index.cargo.crates];
  if(payload.size!==expected.length+1||!payload.has('readme.txt'))fail('source payload vector is incomplete');
  for(const row of expected){const actual=payload.get(row.path?.toLowerCase());if(!actual||actual.sha256!==row.sha256||actual.bytes!==row.bytes)fail('source payload checksum mismatch');}
  const crates=new Map();for(const c of index.cargo.crates){const key=c.name+'@'+c.version;if(!/^[A-Za-z0-9_-]+$/.test(c.name||'')||!/^[A-Za-z0-9_.+-]+$/.test(c.version||'')||crates.has(key)||c.path!=='crates/'+c.name+'-'+c.version+'.crate'||c.url!=='https://static.crates.io/crates/'+c.name+'/'+c.name+'-'+c.version+'.crate'||typeof c.recipeSupplement!=='boolean'||!Array.isArray(c.sourceLocks))fail('invalid Cargo source index');crates.set(key,c);}
  if(cargoLockContents){const required=new Map();for(const lock of index.cargo.locks){const content=cargoLockContents.get(lock.pkgbase);if(!Buffer.isBuffer(content)||content.length!==lock.bytes||sha(content)!==lock.sha256)fail('Cargo lock readback differs');for(const c of parseCargoLockSources(content.toString('utf8')))required.set(c.name+'@'+c.version,c.sha256);}
    if(index.cargo.locks.some(l=>l.pkgbase==='mingw-w64-librsvg'))for(const c of RUST_RECIPE_SUPPLEMENTS)required.set(c.name+'@'+c.version,c.sha256);
    if(required.size!==crates.size||[...required].some(([key,hash])=>crates.get(key)?.sha256!==hash))fail('Cargo source list is not the exact locked/supplemental set');
  }
  return true;
}

function rustLockInputs(rows,cacheDirectory,tarExecutable){
  const inputs=[['mingw-w64-librsvg','librsvg-2.63.4.tar.xz','librsvg-2.63.4/Cargo.lock'],['mingw-w64-rav1e','rav1e-0.8.1.tar.gz','rav1e-0.8.1/Cargo.lock']],locks=[];
  for(const[pkgbase,sourceMember,lockMember]of inputs){const row=rows.find(r=>r.pkgbase===pkgbase);if(!row)continue;
    const inner=execFileSync(tarExecutable,['-xOf',path.join(cacheDirectory,row.archive),pkgbase+'/'+sourceMember],{windowsHide:true,maxBuffer:32*1024*1024,timeout:120000});
    const lock=execFileSync(tarExecutable,['-xOf','-',lockMember],{input:inner,windowsHide:true,maxBuffer:5*1024*1024,timeout:120000});
    locks.push({pkgbase,sourceArchive:row.archive,sourceArchiveSha256:row.sha256,sourceMember:pkgbase+'/'+sourceMember,lockMember,sha256:sha(lock),bytes:lock.length,contents:lock,crates:parseCargoLockSources(lock.toString('utf8'))});
  }
  return locks;
}

async function packageRustCrates(rows,cacheDirectory,staging,signal,fetchImpl,tarExecutable){
  const locks=rustLockInputs(rows,cacheDirectory,tarExecutable);if(!locks.length)return{locks:[],crates:[]};
  const crates=new Map();
  for(const lock of locks)for(const c of lock.crates){const key=c.name+'@'+c.version,old=crates.get(key);if(old&&old.sha256!==c.sha256)fail('Cargo locks disagree');const entry=old||{...c,sourceLocks:[],recipeSupplement:false};entry.sourceLocks.push(lock.pkgbase);crates.set(key,entry);}
  if(locks.some(l=>l.pkgbase==='mingw-w64-librsvg'))for(const c of RUST_RECIPE_SUPPLEMENTS){const key=c.name+'@'+c.version,old=crates.get(key);if(old&&old.sha256!==c.sha256)fail('recipe supplement conflicts with lock');if(!old)crates.set(key,{...c,sourceLocks:[],recipeSupplement:true});}
  if(crates.size>1000)fail('Cargo source count limit');
  const all=[...crates.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version));
  await fs.mkdir(path.join(cacheDirectory,'crates'),{recursive:true});await ordinary(path.join(cacheDirectory,'crates'),'directory');await fs.mkdir(path.join(staging,'crates'));await fs.mkdir(path.join(staging,'cargo-locks'));
  for(const l of locks)await fs.writeFile(path.join(staging,'cargo-locks',l.pkgbase+'.Cargo.lock'),l.contents,{flag:'wx'});
  let next=0,total=0;await Promise.all(Array.from({length:Math.min(4,all.length)},async()=>{while(next<all.length){if(signal.aborted)throw signal.reason;const row=all[next++],archive=row.name+'-'+row.version+'.crate',cached=path.join(cacheDirectory,'crates',archive);row.url='https://static.crates.io/crates/'+row.name+'/'+archive;let data;
    try{data=await bytes(cached,32*1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;let last;for(let attempt=0;attempt<3;attempt++){try{const response=await fetchImpl(row.url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});if(!response.ok||Number(response.headers.get('content-length'))>32*1024*1024)fail('crate download rejected');const parts=[];let count=0;for await(const part of response.body){count+=part.length;if(count>32*1024*1024)fail('crate download size limit');parts.push(part);}data=Buffer.concat(parts);if(sha(data)!==row.sha256)fail('crate checksum differs from Cargo.lock');await fs.writeFile(cached,data,{flag:'wx'});last=null;break;}catch(error){last=error;if(signal.aborted)throw error;}}if(last)throw last;}
    if(sha(data)!==row.sha256)fail('cached crate checksum differs from Cargo.lock');total+=data.length;if(total>512*1024*1024)fail('total Cargo source size limit');row.path='crates/'+archive;row.bytes=data.length;await fs.writeFile(path.join(staging,row.path),data,{flag:'wx'});
  }}));
  return{locks:locks.map(({contents,crates,...l})=>({...l,path:'cargo-locks/'+l.pkgbase+'.Cargo.lock',registryCrateCount:crates.length})),crates:all};
}

export function validateNativeSourceInventory(value,manifest){
  if(value?.schema!==1||value.scope!=='runtime-redistribution-inputs'||!HASH.test(value.sourceRuntimeManifestSha256||'')||!Array.isArray(value.sourcePackages)||!value.sourcePackages.length||value.sourcePackages.length>100||!Array.isArray(manifest?.packages))fail('invalid source inventory');
  const names=new Set(),binary=new Map();let total=0;
  for(const r of value.sourcePackages){
    if(!safe(r.archive)||r.archive.includes('/')||!/^mingw-w64-[A-Za-z0-9_.+~-]+\.src\.tar\.zst$/.test(r.archive)||names.has(r.archive.toLowerCase())||!safe(r.pkgbase)||r.pkgbase.includes('/')||r.recipeMember!==r.pkgbase+'/PKGBUILD'||r.srcinfoMember!==r.pkgbase+'/.SRCINFO'||r.url!=='https://repo.msys2.org/mingw/sources/'+r.archive||![r.sha256,r.pkgbuildSha256,r.srcinfoSha256].every(h=>HASH.test(h||''))||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>MAX_FILE||!Array.isArray(r.binaryPackages)||!r.binaryPackages.length)fail('invalid pinned source package');
    names.add(r.archive.toLowerCase());total+=r.bytes;
    for(const b of r.binaryPackages){if(typeof b.name!=='string'||binary.has(b.name)||!HASH.test(b.sha256||''))fail('duplicate or invalid binary binding');binary.set(b.name,{...b,version:r.version});}
  }
  if(total>MAX_TOTAL||value.totalSourceArchiveBytes!==total||binary.size!==manifest.packages.length)fail('incomplete source inventory');
  for(const p of manifest.packages){const b=binary.get(p.name);if(!b||b.version!==p.version||b.archive!==p.archive||b.sha256!==p.sha256)fail('source inventory does not cover shipped binaries');}
  return value.sourcePackages;
}

export async function verifyNativeSourceArchive(file,row,{tarExecutable='tar',executeFile=execute}={}){
  const b=await bytes(file);if(b.length!==row.bytes||sha(b)!==row.sha256)fail('source archive hash mismatch');
  const opts={windowsHide:true,maxBuffer:64*1024*1024,timeout:120000,encoding:'utf8'};
  const {stdout}=await executeFile(tarExecutable,['-tf',file],opts),members=stdout.split(/\r?\n/).filter(Boolean);
  if(members.length>1000000||members.some(m=>!safe(m.replace(/\/$/,'')))||members.filter(m=>m===row.recipeMember).length!==1||members.filter(m=>m===row.srcinfoMember).length!==1)fail('unsafe source archive members');
  for(const [member,expected]of[[row.recipeMember,row.pkgbuildSha256],[row.srcinfoMember,row.srcinfoSha256]]){
    const {stdout}=await executeFile(tarExecutable,['-xOf',file,member],{...opts,maxBuffer:3*1024*1024,encoding:null});if(sha(stdout)!==expected)fail('source recipe or metadata does not match the binary build');
  }
  return true;
}

async function download(row,target,signal,fetchImpl){
  let last;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetchImpl(row.url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
      if(!response.ok||Number(response.headers.get('content-length'))>row.bytes)fail('source download rejected');
      const parts=[];let length=0;for await(const part of response.body){length+=part.length;if(length>row.bytes)fail('source download size limit');parts.push(part);}
      const b=Buffer.concat(parts);if(length!==row.bytes||sha(b)!==row.sha256)fail('downloaded source archive changed');await fs.writeFile(target,b,{flag:'wx'});return;
    }catch(error){last=error;if(signal.aborted)throw error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));}
  }
  throw last;
}

export async function packageWorkbenchNativeSources({repositoryRoot,outputDirectory,cacheDirectory,version,
  sourceFiles=NATIVE_SOURCE_FILES,fetchImpl=fetch,tarExecutable='tar',timeoutMs=30*60*1000}={}){
  if(!path.isAbsolute(repositoryRoot||'')||!path.isAbsolute(outputDirectory||'')||!path.isAbsolute(cacheDirectory||'')||!/^\d+\.\d+\.\d+$/.test(version||'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30*60*1000)fail('absolute directories, version and bounded deadline required');
  const signal=AbortSignal.timeout(timeoutMs),resource=path.join(repositoryRoot,'resources/workbench-native');
  const metadataBytes=await bytes(path.join(resource,'redistribution.json'),2*1024*1024),metadata=JSON.parse(metadataBytes),manifestBytes=await bytes(path.join(resource,'runtime-manifest.json'),2*1024*1024),manifest=JSON.parse(manifestBytes);
  if(sha(manifestBytes)!==metadata.sourceRuntimeManifestSha256)fail('runtime manifest changed');
  const rows=validateNativeSourceInventory(metadata,manifest);
  await ordinary(path.dirname(outputDirectory),'directory');await fs.mkdir(outputDirectory);await ordinary(outputDirectory,'directory');
  await fs.mkdir(cacheDirectory,{recursive:true});await ordinary(cacheDirectory,'directory');
  const staging=path.join(outputDirectory,'content');await fs.mkdir(staging);await fs.mkdir(path.join(staging,'sources'));await fs.mkdir(path.join(staging,'app-source'));
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(next<rows.length){if(signal.aborted)throw signal.reason;const row=rows[next++],cached=path.join(cacheDirectory,row.archive);try{await ordinary(cached);}catch(error){if(error.code!=='ENOENT')throw error;await download(row,cached,signal,fetchImpl);}await verifyNativeSourceArchive(cached,row,{tarExecutable});const destination=path.join(staging,'sources',row.archive);await fs.copyFile(cached,destination,fs.constants?.COPYFILE_EXCL||1);if((await fs.stat(destination)).size!==row.bytes||await fileHash(destination)!==row.sha256)fail('copied source archive changed');}}));
  const cargo=await packageRustCrates(rows,cacheDirectory,staging,signal,fetchImpl,tarExecutable),appFiles=[];
  const licenseInputs=(metadata.files||[]).map(row=>{if(!safe(row.path)||!row.path.startsWith('licenses/'))fail('unsafe license input');return{...row,source:'resources/workbench-native/'+row.path};});
  for(const relative of [...sourceFiles,...licenseInputs.map(row=>row.source)]){if(!safe(relative))fail('unsafe application source path');const b=await bytes(path.join(repositoryRoot,relative)),license=licenseInputs.find(row=>row.source===relative);if(license&&(license.sha256!==sha(b)||license.bytes!==b.length))fail('license input changed');const destination=path.join(staging,'app-source',relative);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,b,{flag:'wx'});appFiles.push({path:'app-source/'+relative,sha256:sha(b),bytes:b.length});}
  for(const relative of ['acceptance.json','redistribution.json','runtime-manifest.json','dependency-lock.json']){const b=await bytes(path.join(resource,relative),2*1024*1024);await fs.writeFile(path.join(staging,relative),b,{flag:'wx'});appFiles.push({path:relative,sha256:sha(b),bytes:b.length});}
  const acceptance=JSON.parse(await bytes(path.join(resource,'acceptance.json'),2*1024*1024)),main=appFiles.find(f=>f.path==='app-source/scripts/workbench-freerdp-client/main.cpp');
  if(!main||main.sha256!==acceptance.sourceSha256||acceptance.runtimeManifestSha256!==sha(manifestBytes)||acceptance.fullAcceptance!==false)fail('native source and accepted executable binding changed');
  const readme=Buffer.from('BLACKICE native runtime corresponding sources\n\nThe sources/ directory contains complete matching MSYS2 source packages, including upstream sources or complete VCS objects, PKGBUILD build/configuration recipes and patches. SOURCE-INDEX.json binds every archive to its shipped binary package and exact build-recipe hash. Extract a .src.tar.zst package and use the matching MSYS2 toolchain/PKGBUILD instructions to rebuild; BLACKICE never executes these recipes while packaging. app-source/ contains BLACKICE native helper source, build scripts, dependency/compiler locks and icon resources. cargo-locks/ preserves original librsvg/rav1e lockfiles; crates/ contains their checksum-verified registry sources. The pinned librsvg recipe changes windows-sys after extraction: clearly marked registry supplements cover its compatible Windows dependency alternatives without claiming a captured modified build lock. Sources are distributed beside the installer at no additional charge. Behavioral acceptance remains local-preview/fullAcceptance:false; source publication is not proof of unrestricted native behavior.\n');
  await fs.writeFile(path.join(staging,'README.txt'),readme,{flag:'wx'});
  const payloadFiles=[...rows.map(r=>({path:'sources/'+r.archive,sha256:r.sha256,bytes:r.bytes})),...appFiles,...cargo.crates.map(({path,sha256,bytes})=>({path,sha256,bytes})),...cargo.locks.map(({path,sha256,bytes})=>({path,sha256,bytes})),{path:'README.txt',sha256:sha(readme),bytes:readme.length}].sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const index={schema:1,product:'BLACKICE',version,scope:'corresponding-native-runtime-source',runtimeManifestSha256:sha(manifestBytes),helperSha256:acceptance.helperSha256,helperSourceSha256:main.sha256,fullAcceptance:false,sourceArchiveCount:rows.length,sourceArchives:rows.map(r=>({path:'sources/'+r.archive,...r})),applicationFiles:appFiles,sourceBytes:metadata.totalSourceArchiveBytes,cargo,payloadFiles};
  validateNativeSourceIndex(index,metadata,{cargoLockContents:new Map(await Promise.all(cargo.locks.map(async l=>[l.pkgbase,await bytes(path.join(staging,l.path),5*1024*1024)])))});
  const indexBytes=Buffer.from(JSON.stringify(index,null,2)+'\n');await fs.writeFile(path.join(staging,'SOURCE-INDEX.json'),indexBytes,{flag:'wx'});
  const archiveName=`Blackice-${version}-Native-Sources.tar`,archivePath=path.join(outputDirectory,archiveName);
  await execute(tarExecutable,['-cf',archivePath,'-C',staging,'SOURCE-INDEX.json','README.txt','acceptance.json','redistribution.json','runtime-manifest.json','dependency-lock.json','sources','app-source',...(cargo.locks.length?['crates','cargo-locks']:[])],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  const stat=await fs.stat(archivePath),result={schema:1,product:'BLACKICE',version,archive:{name:archiveName,bytes:stat.size,sha256:await fileHash(archivePath)},index:{name:'SOURCE-INDEX.json',bytes:indexBytes.length,sha256:sha(indexBytes)},runtimeManifestSha256:index.runtimeManifestSha256,helperSha256:index.helperSha256,sourceArchiveCount:rows.length,sourceBytes:metadata.totalSourceArchiveBytes,registryCrateCount:cargo.crates.length,payloadFileCount:payloadFiles.length,fullAcceptance:false};
  await fs.writeFile(path.join(outputDirectory,'SOURCE-INDEX.json'),indexBytes,{flag:'wx'});await fs.writeFile(path.join(outputDirectory,'blackice-native-sources.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),get=(name,fallback)=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)||fallback,version=JSON.parse(await fs.readFile(path.join(repo,'package.json'),'utf8')).version;
  console.log(JSON.stringify(await packageWorkbenchNativeSources({repositoryRoot:repo,version,outputDirectory:path.resolve(get('--output-dir',path.join(repo,'.build/workbench-native-source-bundle'))),cacheDirectory:path.resolve(get('--cache-dir',path.join(repo,'.build/workbench-native-sources/cache')))})));
}
