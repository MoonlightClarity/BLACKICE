import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {NATIVE_SOURCE_FILES,validateNativeSourceInventory,validateNativeSourceIndex} from './package-workbench-native-sources.mjs';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex'),HASH=/^[a-f0-9]{64}$/;
const safe=p=>typeof p==='string'&&/^[A-Za-z0-9_.+~-]+(?:\/[A-Za-z0-9_.+~-]+)*$/.test(p)&&p.split('/').every(s=>s!=='.'&&s!=='..');
const fail=message=>{throw Error('Native source release asset: '+message);};
async function ordinary(file){for(let current=path.resolve(file);;current=path.dirname(current)){const s=await fs.lstat(current);if(s.isSymbolicLink()||(current===path.resolve(file)?!s.isFile():!s.isDirectory()))fail('ordinary file required');if(current===path.dirname(current))return fs.stat(file);}}
async function bytes(file,max=2*1024*1024){const before=await ordinary(file);if(before.size>max)fail('file size limit');const b=await fs.readFile(file),after=await ordinary(file);if(b.length!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('file changed');return b;}
async function hashFile(file,max=2*1024*1024*1024){const before=await ordinary(file);if(before.size>max)fail('archive size limit');const h=createHash('sha256');let count=0;for await(const b of createReadStream(file)){count+=b.length;if(count>max)fail('archive size limit');h.update(b);}const after=await ordinary(file);if(count!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('archive changed');return {bytes:count,sha256:h.digest('hex'),stat:after};}

export async function verifyNativeSourcePayload({archivePath,index,indexBytes,tarExecutable='tar'}={}){
  if(!Array.isArray(index?.payloadFiles)||!index.payloadFiles.length||index.payloadFiles.length>5000)fail('complete payload inventory required');
  const rows=new Map(),folded=new Set();let total=0;
  for(const row of [...index.payloadFiles,{path:'SOURCE-INDEX.json',bytes:indexBytes.length,sha256:sha(indexBytes)}]){
    if(!safe(row.path)||folded.has(row.path.toLowerCase())||!HASH.test(row.sha256||'')||!Number.isSafeInteger(row.bytes)||row.bytes<0)fail('invalid payload inventory');
    total+=row.bytes;if(total>1024*1024*1024)fail('payload size limit');rows.set(row.path,row);folded.add(row.path.toLowerCase());
  }
  const options={windowsHide:true,timeout:120000,maxBuffer:2*1024*1024,encoding:'utf8'};
  const listed=(await execute(tarExecutable,['-tf',archivePath],options)).stdout.split(/\r?\n/).filter(Boolean);
  if(listed.length>10000||listed.some(n=>!safe(n.replace(/\/$/,''))))fail('unsafe archive paths');
  const members=listed.filter(n=>!n.endsWith('/'));
  if(members.length!==rows.size||new Set(members.map(n=>n.toLowerCase())).size!==members.length||members.some(n=>!rows.has(n)))fail('archive payload differs from index');
  const verbose=(await execute(tarExecutable,['-tvf',archivePath],options)).stdout.split(/\r?\n/).filter(Boolean);
  if(verbose.some(line=>!/^[-d]/.test(line)))fail('links and special archive members are forbidden');
  await new Promise((resolve,reject)=>{
    const child=spawn(tarExecutable,['-xOf',archivePath,'--',...members],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let position=0,remaining=rows.get(members[0]).bytes,hash=createHash('sha256'),error,stderr='';
    const stop=e=>{error??=e;child.kill();};
    const timer=setTimeout(()=>stop(Error('Native source archive verification timed out.')),180000);
    const finishEmpty=()=>{while(position<members.length&&remaining===0){const wanted=rows.get(members[position]);if(hash.digest('hex')!==wanted.sha256)throw Error('Native source archive member checksum mismatch: '+wanted.path);position++;if(position<members.length){remaining=rows.get(members[position]).bytes;hash=createHash('sha256');}}};
    child.stdout.on('data',chunk=>{if(error)return;try{let offset=0;finishEmpty();while(offset<chunk.length){if(position>=members.length)throw Error('Unexpected native source archive bytes.');const count=Math.min(remaining,chunk.length-offset);hash.update(chunk.subarray(offset,offset+count));offset+=count;remaining-=count;finishEmpty();}}catch(e){stop(e);}});
    child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>65536)stop(Error('Native source archive diagnostics exceeded their limit.'));});
    child.once('error',e=>{error??=e;});
    child.once('close',code=>{clearTimeout(timer);if(!error){try{finishEmpty();if(code!==0||position!==members.length)throw Error('Incomplete native source archive verification: '+stderr.slice(0,1000));}catch(e){error=e;}}if(error)reject(error);else resolve();});
  });
  return {payloadFilesVerified:rows.size-1,payloadBytesVerified:total-indexBytes.length};
}

export async function verifyNativeSourceAssets({repositoryRoot,directory,version,expected={},tarExecutable='tar'}={}){
  if(!path.isAbsolute(repositoryRoot||'')||!path.isAbsolute(directory||'')||!/^\d+\.\d+\.\d+$/.test(version||''))fail('exact release paths and version required');
  const resource=path.join(repositoryRoot,'resources/workbench-native'),runtimeBytes=await bytes(path.join(resource,'runtime-manifest.json')),
    runtime=JSON.parse(runtimeBytes),redistribution=JSON.parse(await bytes(path.join(resource,'redistribution.json'))),acceptance=JSON.parse(await bytes(path.join(resource,'acceptance.json')));
  const sourceRows=validateNativeSourceInventory(redistribution,runtime),metadataBytes=await bytes(path.join(directory,'blackice-native-sources.json')),metadata=JSON.parse(metadataBytes);
  const archiveName=`Blackice-${version}-Native-Sources.tar`,archive=metadata.archive,indexInfo=metadata.index;
  if(metadata.schema!==1||metadata.product!=='BLACKICE'||metadata.version!==version||metadata.fullAcceptance!==false||archive?.name!==archiveName||indexInfo?.name!=='SOURCE-INDEX.json'||!HASH.test(archive.sha256||'')||!HASH.test(indexInfo.sha256||'')||metadata.runtimeManifestSha256!==sha(runtimeBytes)||metadata.helperSha256!==acceptance.helperSha256||metadata.sourceArchiveCount!==sourceRows.length||metadata.sourceBytes!==redistribution.totalSourceArchiveBytes)fail('source companion binding mismatch');
  const indexBytes=await bytes(path.join(directory,'SOURCE-INDEX.json')),index=JSON.parse(indexBytes);
  if(indexBytes.length!==indexInfo.bytes||sha(indexBytes)!==indexInfo.sha256||index.schema!==1||index.product!=='BLACKICE'||index.version!==version||index.fullAcceptance!==false||index.runtimeManifestSha256!==sha(runtimeBytes)||index.helperSha256!==acceptance.helperSha256||index.helperSourceSha256!==acceptance.sourceSha256||index.sourceArchiveCount!==sourceRows.length||JSON.stringify(index.sourceArchives)!==JSON.stringify(sourceRows.map(r=>({path:'sources/'+r.archive,...r}))))fail('source index differs from pinned inputs');
  const expectedApp=[];
  for(const relative of NATIVE_SOURCE_FILES){const b=await bytes(path.join(repositoryRoot,relative),200*1024*1024);expectedApp.push({path:'app-source/'+relative,sha256:sha(b),bytes:b.length});}
  for(const row of redistribution.files||[]){if(!safe(row.path)||!row.path.startsWith('licenses/'))fail('invalid native distribution notice');const b=await bytes(path.join(resource,row.path));if(row.sha256!==sha(b)||row.bytes!==b.length)fail('native distribution notice changed');expectedApp.push({path:'app-source/resources/workbench-native/'+row.path,sha256:sha(b),bytes:b.length});}
  for(const relative of ['acceptance.json','redistribution.json','runtime-manifest.json','dependency-lock.json']){const b=await bytes(path.join(resource,relative));expectedApp.push({path:relative,sha256:sha(b),bytes:b.length});}
  const sort=rows=>[...rows].sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(!Array.isArray(index.applicationFiles)||JSON.stringify(sort(index.applicationFiles))!==JSON.stringify(sort(expectedApp)))fail('application corresponding sources differ');
  const payload=new Map((index.payloadFiles||[]).map(r=>[r.path,r]));
  for(const row of [...expectedApp,...sourceRows.map(r=>({path:'sources/'+r.archive,sha256:r.sha256,bytes:r.bytes}))]){const actual=payload.get(row.path);if(actual?.path!==row.path||actual?.bytes!==row.bytes||actual?.sha256!==row.sha256)fail('pinned source payload omitted or changed');}
  const archiveIdentity=await hashFile(path.join(directory,archiveName));if(archiveIdentity.sha256!==archive.sha256||archiveIdentity.bytes!==archive.bytes)fail('source archive checksum mismatch');
  const lockInputs=[['mingw-w64-librsvg','librsvg-2.63.4.tar.xz','librsvg-2.63.4/Cargo.lock'],['mingw-w64-rav1e','rav1e-0.8.1.tar.gz','rav1e-0.8.1/Cargo.lock']],cargoLockContents=new Map();
  if(!Array.isArray(index.cargo?.locks)||index.cargo.locks.length!==lockInputs.length)fail('original Cargo locks are required');
  for(const [pkgbase,upstreamMember,lockMember]of lockInputs){
    const source=sourceRows.find(r=>r.pkgbase===pkgbase),locked=index.cargo.locks.find(r=>r.pkgbase===pkgbase);
    if(!source||!locked||locked.sourceArchive!==source.archive||locked.sourceArchiveSha256!==source.sha256||locked.sourceMember!==pkgbase+'/'+upstreamMember||locked.lockMember!==lockMember||locked.path!=='cargo-locks/'+pkgbase+'.Cargo.lock')fail('Cargo source package identity differs');
    const opts={windowsHide:true,timeout:120000,encoding:null};
    const sourceBytes=(await execute(tarExecutable,['-xOf',path.join(directory,archiveName),'sources/'+source.archive],{...opts,maxBuffer:200*1024*1024})).stdout;
    if(sourceBytes.length!==source.bytes||sha(sourceBytes)!==source.sha256)fail('Cargo upstream source package changed');
    const upstream=execFileSync(tarExecutable,['-xOf','-',pkgbase+'/'+upstreamMember],{...opts,input:sourceBytes,maxBuffer:32*1024*1024});
    const originalLock=execFileSync(tarExecutable,['-xOf','-',lockMember],{...opts,input:upstream,maxBuffer:5*1024*1024});
    cargoLockContents.set(pkgbase,originalLock);
  }
  validateNativeSourceIndex(index,redistribution,{cargoLockContents});
  const identities={archiveSha256:archiveIdentity.sha256,indexSha256:sha(indexBytes),metadataSha256:sha(metadataBytes)};
  for(const [key,value]of Object.entries(expected))if(!HASH.test(value||'')||identities[key]!==value)fail('source asset changed after verification');
  const verified=await verifyNativeSourcePayload({archivePath:path.join(directory,archiveName),index,indexBytes,tarExecutable});
  const after=await ordinary(path.join(directory,archiveName));if(after.ino!==archiveIdentity.stat.ino||after.size!==archiveIdentity.stat.size||after.mtimeMs!==archiveIdentity.stat.mtimeMs)fail('source archive changed during verification');
  if(sha(await bytes(path.join(directory,'SOURCE-INDEX.json')))!==identities.indexSha256||sha(await bytes(path.join(directory,'blackice-native-sources.json')))!==identities.metadataSha256)fail('source metadata changed during verification');
  return {verified:true,version,archiveName,archiveBytes:archiveIdentity.bytes,...identities,...verified,sourceArchiveCount:sourceRows.length,fullAcceptance:false};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),get=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1),version=JSON.parse(await fs.readFile(path.join(repo,'package.json'),'utf8')).version;
  const expected={};for(const [flag,key]of[['--expected-archive-sha256','archiveSha256'],['--expected-index-sha256','indexSha256'],['--expected-metadata-sha256','metadataSha256']])if(get(flag))expected[key]=get(flag);
  console.log(JSON.stringify(await verifyNativeSourceAssets({repositoryRoot:repo,directory:path.resolve(get('--directory')||''),version,expected})));
}
