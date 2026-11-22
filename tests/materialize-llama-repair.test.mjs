import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { materializeLlamaRepair, llamaMaterializationTest } from '../scripts/materialize-llama-repair.mjs';
import { LLAMA_RUNTIME_ID, LLAMA_RUNTIME_COMMIT, LLAMA_RUNTIME_PIN, LLAMA_PATCH_NAMES } from '../lib/llama-cpp-bundle.mjs';
const windows=process.platform==='win32',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=bytes=>({size:bytes.length,sha256:hash(bytes)});
const ordinal=(a,b)=>a<b?-1:a>b?1:0;
// Stored ZIP fixtures use the real Windows extractor without any external archive tool.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const {name,bytes=Buffer.alloc(0),attributes=0} of entries){
    const filename=Buffer.from(name);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);
    header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,bytes);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);
    record.writeUInt16LE(filename.length,28);record.writeUInt32LE(attributes>>>0,38);record.writeUInt32LE(offset,42);
    central.push(record,filename);offset+=header.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
async function fixture(t,{cached=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-materialize-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'source'),cache=path.join(root,'cache'),destination=path.join(root,'repair');
  for(const folder of [sourceRoot,cache,destination])await fs.mkdir(folder);
  await fs.writeFile(path.join(destination,'prior.txt'),'previous accepted repair');
  const executable=Buffer.from('accepted synthetic QX4 executable'),sourceArchive=Buffer.from('upstream source archive');
  const files=[{name:'llama-server.exe',bytes:executable},...Array.from({length:19},(_,i)=>({name:'fixture-'+i+'.dll',bytes:Buffer.from('accepted DLL '+i)}))];
  const patches=LLAMA_PATCH_NAMES.map(name=>({name,...identity(Buffer.from('accepted patch '+name))}));
  const manifest={schema:'blackice.minicpm.qx4.bundle.v1',runtimeId:LLAMA_RUNTIME_ID,sourceCommit:LLAMA_RUNTIME_COMMIT,release:'b12359',
    archive:{bytes:sourceArchive.length,sha256:hash(sourceArchive)},
    patches:patches.map(({name,size,sha256})=>({name,bytes:size,sha256})).sort((a,b)=>ordinal(a.name,b.name)),
    files:files.map(({name,bytes})=>({name,relativePath:'bin/'+name,bytes:bytes.length,sha256:hash(bytes)})).sort((a,b)=>ordinal(a.relativePath,b.relativePath))};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  const entries=[{name:'manifest.json',bytes:manifestBytes},...files.map(({name,bytes})=>({name:'bin/'+name,bytes}))],archiveBytes=zip(entries);
  const pin={runtimeId:LLAMA_RUNTIME_ID,sourceCommit:LLAMA_RUNTIME_COMMIT,release:'b12359',sourceArchive:identity(sourceArchive),
    buildManifest:{schema:manifest.schema,...identity(manifestBytes)},executable:identity(executable),
    repairArchive:{name:LLAMA_RUNTIME_ID+'.zip',url:'https://github.com/MoonlightClarity/BLACKICE/releases/download/'+LLAMA_RUNTIME_ID+'/'+LLAMA_RUNTIME_ID+'.zip',...identity(archiveBytes)},
    archives:Object.fromEntries(['cpu','vulkan'].map(backend=>[backend,{name:LLAMA_RUNTIME_PIN[backend].name,...identity(Buffer.from(backend+' archive'))}])),
    patches,repairFiles:files.map(({name,bytes})=>({path:'bin/'+name,...identity(bytes)})),
    files:[{path:'LICENSE',...identity(Buffer.from('MIT'))},...patches.map(({name,size,sha256})=>({path:'patches/'+name,size,sha256})),
      ...['cpu','vulkan'].map(backend=>({path:backend+'/llama-server.exe',...identity(executable)}))]};
  const archive=path.join(cache,pin.repairArchive.name);if(cached)await fs.writeFile(archive,archiveBytes);
  return {root,sourceRoot,cache,destination,archive,archiveBytes,pin,manifest,manifestBytes,entries};
}
const create=(f,pin=f.pin,extra={})=>llamaMaterializationTest.createMaterializer(pin,{sourceRoot:f.sourceRoot,platform:'win32',arch:'x64',...extra});
const options=f=>({cache:f.cache,destination:f.destination,fetchImpl:async()=>{throw Error('unexpected network');}});
const prior=f=>fs.readFile(path.join(f.destination,'prior.txt'),'utf8');
async function noTemporary(f,{previous=false}={}){
  const names=await fs.readdir(f.root);assert.deepEqual(names.filter(name=>name.startsWith('.llama-repair-stage-')&&!(previous&&name.endsWith('.previous'))),[]);
  assert.deepEqual((await fs.readdir(f.cache)).filter(name=>name.endsWith('.tmp')),[]);
}
async function alteredArchive(f,entries,pin=structuredClone(f.pin)){
  const bytes=zip(entries);await fs.writeFile(f.archive,bytes);pin.repairArchive={...pin.repairArchive,...identity(bytes)};return pin;
}
test('production source pins reject caller overrides before effects',async t=>{
  const f=await fixture(t,{cached:false});let fetches=0;
  await assert.rejects(materializeLlamaRepair({...options(f),repairPin:f.pin,fetchImpl:async()=>{fetches++;}}),
    process.platform==='win32'&&process.arch==='x64'?/source-pinned/:/Windows x64/);
  assert.equal(fetches,0);assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
  for(const field of ['url','sha256','repairPin','sourceRoot'])await assert.rejects(create(f)({...options(f),[field]:'override'}),/source-pinned/);
  await assert.rejects(create(f,f.pin,{platform:'linux'})(options(f)),/Windows x64/);
  assert.deepEqual(await fs.readdir(f.cache),[]);
});
test('real cached synthetic ZIP materializes the complete accepted repair and never fetches',{skip:!windows},async t=>{
  const f=await fixture(t),result=await create(f)(options(f));
  assert.equal(result.cacheSource,'verified-cache');assert.equal(result.runtimeId,LLAMA_RUNTIME_ID);assert.equal(result.files.length,20);
  assert.deepEqual(await fs.readFile(path.join(f.destination,'manifest.json')),f.manifestBytes);
  for(const entry of f.entries.slice(1))assert.deepEqual(await fs.readFile(path.join(f.destination,entry.name)),entry.bytes);
  assert.deepEqual((await fs.readdir(f.destination)).sort(),['bin','manifest.json']);assert.equal((await fs.readdir(path.join(f.destination,'bin'))).length,20);
  assert.deepEqual(result.archive,f.pin.repairArchive);await noTemporary(f);
});
test('a bounded mock download publishes a verified cache and the next attempt uses it',{skip:!windows},async t=>{
  const f=await fixture(t,{cached:false}),calls=[];
  const result=await create(f)({...options(f),fetchImpl:async(url,args)=>{calls.push({url,redirect:args.redirect});return new Response(f.archiveBytes);}});
  assert.deepEqual(calls,[{url:f.pin.repairArchive.url,redirect:'manual'}]);assert.equal(result.cacheSource,'downloaded');
  assert.deepEqual(await fs.readFile(f.archive),f.archiveBytes);
  assert.equal((await create(f)(options(f))).cacheSource,'verified-cache');await noTemporary(f);
});
test('corrupt cached bytes fail closed before fetch or extraction',{skip:!windows},async t=>{
  const f=await fixture(t);let fetches=0,extractions=0;
  for(const bytes of [Buffer.from('short cache'),Buffer.alloc(f.archiveBytes.length)]){
    await fs.writeFile(f.archive,bytes);
    await assert.rejects(create(f,f.pin,{extract:async()=>{extractions++;}})({...options(f),fetchImpl:async()=>{fetches++;}}),/cached repair|checksum/);
    assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
  }
  assert.equal(fetches,0);assert.equal(extractions,0);
});
test('HTTP, size, checksum and partial stream failures never publish downloaded bytes',{skip:!windows},async t=>{
  const f=await fixture(t,{cached:false});let extractions=0;
  const responses=[
    ['HTTP failure',()=>new Response(null,{status:503})],
    ['short body',()=>new Response(f.archiveBytes.subarray(0,5))],
    ['oversized body',()=>new Response(Buffer.concat([f.archiveBytes,Buffer.from('x')]))],
    ['wrong digest',()=>new Response(Buffer.alloc(f.archiveBytes.length))],
    ['partial stream',()=>({ok:true,status:200,body:(async function*(){yield f.archiveBytes.subarray(0,5);throw Error('connection interrupted');})()})],
  ];
  for(const [label,response] of responses)await t.test(label,async()=>{
    await assert.rejects(create(f,f.pin,{extract:async()=>{extractions++;}})({...options(f),fetchImpl:async()=>response()}));
    assert.deepEqual(await fs.readdir(f.cache),[]);assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
  });
  assert.equal(extractions,0);
});
test('HTTPS artifact redirects retain hash binding and reject downgrade or excessive redirects',{skip:!windows},async t=>{
  const f=await fixture(t,{cached:false}),urls=[];
  const signed='https://release-assets.githubusercontent.com/fixture?temporary=secret';
  const result=await create(f)({...options(f),fetchImpl:async url=>{urls.push(url);return urls.length===1?new Response(null,{status:302,headers:{location:signed}}):new Response(f.archiveBytes);}});
  assert.deepEqual(urls,[f.pin.repairArchive.url,signed]);assert.equal(JSON.stringify(result).includes('secret'),false);
  await fs.rm(f.destination,{recursive:true});await fs.mkdir(f.destination);await fs.writeFile(path.join(f.destination,'prior.txt'),'previous accepted repair');await fs.unlink(f.archive);
  for(const location of ['http://example.invalid/unsafe','https://user:password@example.invalid/file',f.pin.repairArchive.url]){
    await assert.rejects(create(f)({...options(f),fetchImpl:async()=>new Response(null,{status:302,headers:{location}})}),/redirect/);
    assert.equal(await prior(f),'previous accepted repair');assert.deepEqual(await fs.readdir(f.cache),[]);await noTemporary(f);
  }
});
test('cancellation before work and during download or extraction preserves the previous repair',{skip:!windows},async t=>{
  const f=await fixture(t,{cached:false}),early=new AbortController();early.abort(Error('cancel early'));
  await assert.rejects(create(f)({...options(f),signal:early.signal}),/cancel early/);
  const downloading=new AbortController();
  await assert.rejects(create(f)({...options(f),signal:downloading.signal,fetchImpl:async()=>({ok:true,status:200,
    body:(async function*(){yield f.archiveBytes.subarray(0,5);downloading.abort(Error('cancel download'));yield f.archiveBytes.subarray(5);})()})}),/cancel download/);
  assert.deepEqual(await fs.readdir(f.cache),[]);
  await fs.writeFile(f.archive,f.archiveBytes);const extracting=new AbortController();
  await assert.rejects(create(f,f.pin,{extract:async(_archive,stage)=>{await fs.writeFile(path.join(stage,'partial'),'partial');extracting.abort(Error('cancel extract'));}})({...options(f),signal:extracting.signal}),/cancel extract/);
  assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
});
test('malformed ZIP inventory fails before promotion, including links and unsafe paths',{skip:!windows},async t=>{
  const f=await fixture(t),extra=name=>[...f.entries,{name,bytes:Buffer.from('x')}];
  const variants=[
    ['traversal',extra('../escape.dll')],['absolute',extra('C:/escape.dll')],['backslash',extra('bin\\escape.dll')],
    ['extra',extra('extra.dll')],['duplicate',[...f.entries,{...f.entries[1]}]],
    ['case collision',[...f.entries,{...f.entries[1],name:f.entries[1].name.toUpperCase()}]],
    ['missing',f.entries.slice(1)],
    ['wrong size',f.entries.map((entry,i)=>i===1?{...entry,bytes:Buffer.from('wrong')}:entry)],
    ['symbolic link',f.entries.map((entry,i)=>i===1?{...entry,attributes:0xa0000000}:entry)],
    ['reparse point',f.entries.map((entry,i)=>i===1?{...entry,attributes:1024}:entry)],
    ['directory flag on file',f.entries.map((entry,i)=>i===1?{...entry,attributes:16}:entry)],
  ];
  for(const [label,entries] of variants)await t.test(label,async()=>{
    const pin=await alteredArchive(f,entries);await assert.rejects(create(f,pin)(options(f)));
    assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
    await assert.rejects(fs.stat(path.join(f.root,'escape.dll')),{code:'ENOENT'});
  });
});
test('exact archive identity cannot replace the accepted manifest or repair file identities',{skip:!windows},async t=>{
  const f=await fixture(t);
  for(const [label,change] of [
    ['private audit path',value=>value.privatePath='C:\\private-build'],
    ['wrong commit',value=>value.sourceCommit='0'.repeat(40)],
    ['wrong action patch',value=>value.patches.find(patch=>patch.name==='llama-qwen3-action-schema.patch').sha256='0'.repeat(64)],
    ['missing action patch',value=>value.patches=value.patches.filter(patch=>patch.name!=='llama-qwen3-action-schema.patch')],
    ['wrong fourth patch',value=>value.patches.find(patch=>patch.name==='llama-qwen3-unique-parameters.patch').sha256='0'.repeat(64)],
    ['missing fourth patch',value=>value.patches=value.patches.filter(patch=>patch.name!=='llama-qwen3-unique-parameters.patch')],
    ['duplicate fourth patch',value=>value.patches[3]={...value.patches[0]}],
  ])await t.test(label,async()=>{
    const value=structuredClone(f.manifest);change(value);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),pin=structuredClone(f.pin);
    pin.buildManifest={schema:value.schema,...identity(bytes)};
    await alteredArchive(f,[{name:'manifest.json',bytes},...f.entries.slice(1)],pin);
    await assert.rejects(create(f,pin)(options(f)),/portable|patch/);assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
  });
  const entries=f.entries.map((entry,i)=>i===1?{...entry,bytes:Buffer.alloc(entry.bytes.length)}:entry),pin=await alteredArchive(f,entries);
  await assert.rejects(create(f,pin)(options(f)),/altered file/);assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
});
test('partial extraction and promotion failures clean staging and restore the accepted destination',{skip:!windows},async t=>{
  const f=await fixture(t);
  await assert.rejects(create(f,f.pin,{extract:async(_archive,stage)=>{await fs.writeFile(path.join(stage,'partial'),'partial');throw Error('extract failure');}})(options(f)),/extract failure/);
  assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
  let renames=0;
  await assert.rejects(create(f,f.pin,{rename:async(from,to)=>{if(++renames===2)throw Object.assign(Error('promotion denied'),{code:'EACCES'});return fs.rename(from,to);}})(options(f)),/promotion denied/);
  assert.equal(renames,3);assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
});
test('uncertain rollback retains the previous repair and reports its recoverable location',{skip:!windows},async t=>{
  const f=await fixture(t);let renames=0,previous;
  await assert.rejects(create(f,f.pin,{rename:async(from,to)=>{
    if(++renames>=2)throw Object.assign(Error('rename denied'),{code:'EACCES'});return fs.rename(from,to);
  }})(options(f)),error=>{assert.equal(error.code,'LLAMA_REPAIR_PROMOTION_UNCERTAIN');previous=error.previous;assert.equal(error.destination,f.destination);return true;});
  assert.equal(await fs.readFile(path.join(previous,'prior.txt'),'utf8'),'previous accepted repair');await noTemporary(f,{previous:true});
  await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});
});
test('linked and overlapping destinations or caches are rejected before mutation',{skip:!windows},async t=>{
  const f=await fixture(t),link=path.join(f.root,'linked');await fs.symlink(f.destination,link,'junction');
  await assert.rejects(create(f)({...options(f),destination:link}),/ordinary directory/);
  await assert.rejects(create(f)({...options(f),cache:link}),/ordinary directory/);
  await assert.rejects(create(f)({...options(f),destination:f.root}),/separate/);
  await assert.rejects(create(f)({...options(f),cache:path.join(f.destination,'cache')}),/separate/);
  await assert.rejects(create(f)({...options(f),destination:path.join(f.cache,'repair')}),/separate/);
  assert.equal(await prior(f),'previous accepted repair');await noTemporary(f);
});
test('hosted packaging materializes the pinned runtime before packaging and keeps draft recovery separate',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/publish-windows-release.yml',import.meta.url),'utf8');
  const steps=workflow.split(/^\s{6}- name: /m).slice(1),build=steps.find(step=>step.includes('npm ci --no-audit --no-fund'));
  assert.ok(build);assert.match(build,/if: steps\.draft\.outputs\.reuse == 'false'/);
  assert.ok(build.indexOf('npm ci')<build.indexOf('node scripts/materialize-llama-repair.mjs'));
  assert.ok(build.indexOf('node scripts/materialize-llama-repair.mjs')<build.indexOf('npm run package:public'));
  assert.match(build,/\$env:BLACKICE_LLAMA_REPAIR_BUNDLE\s*=\s*Join-Path \$PWD '\.build\/llama-repair'/);
  assert.match(build,/if \(\$LASTEXITCODE -ne 0\) \{ throw 'Pinned runtime repair materialization failed\.';? \}/);
  assert.ok(steps.some(step=>step.includes("if: steps.draft.outputs.reuse == 'true'")));
  assert.doesNotMatch(build,/--repair-pin|--sha256|--url|GH_TOKEN/);
});
