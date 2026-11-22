import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  inspectLlamaBundle, verifyLlamaBundle, llamaBundleManifest, llamaBundleTest,
  LLAMA_BUNDLE_VERSION, LLAMA_RUNTIME_ID, LLAMA_RUNTIME_COMMIT, LLAMA_RUNTIME_PIN,
  LLAMA_RUNTIME_REPAIR_PIN, LLAMA_PATCH_NAMES,
} from '../lib/llama-cpp-bundle.mjs';
import { LocalModelManager } from '../lib/local-model-manager.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({size:bytes.length,sha256:hash(bytes)});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'blackice-bundle-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable = Buffer.from('qualified synthetic QX3 executable'), contents = new Map([['LICENSE',Buffer.from('MIT fixture license')]]);
  const patches = LLAMA_PATCH_NAMES.map(name=>{
    const bytes=Buffer.from('portable fixture patch '+name+'\n');contents.set('patches/'+name,bytes);return {name,...identity(bytes)};
  });
  for (const backend of ['cpu','vulkan']) {
    contents.set(backend+'/llama-server.exe',executable);
    contents.set(backend+'/ggml.dll',Buffer.from('official ggml'));
    contents.set(backend+'/ggml-base.dll',Buffer.from('official base'));
    contents.set(backend+'/LICENSE-runtime',Buffer.from('upstream license '+backend));
  }
  contents.set('vulkan/ggml-vulkan.dll',Buffer.from('official vulkan'));
  const repairFiles = [{path:'bin/llama-server.exe',...identity(executable)},...Array.from({length:19},(_,i)=>({path:'bin/runtime-'+i+'.dll',...identity(Buffer.from('dll '+i))}))];
  const pin = {
    runtimeId:LLAMA_RUNTIME_ID,release:'b12359',sourceCommit:LLAMA_RUNTIME_COMMIT,
    sourceArchive:identity(Buffer.from('source archive')),
    repairArchive:{name:LLAMA_RUNTIME_ID+'.zip',url:'https://github.com/MoonlightClarity/BLACKICE/releases/download/'+LLAMA_RUNTIME_ID+'/'+LLAMA_RUNTIME_ID+'.zip',...identity(Buffer.from('synthetic portable repair archive'))},
    buildManifest:{schema:'blackice.minicpm.qx3.bundle.v1',...identity(Buffer.from('private build manifest'))},
    executable:identity(executable),
    archives:Object.fromEntries(['cpu','vulkan'].map(backend=>[backend,{name:LLAMA_RUNTIME_PIN[backend].name,...identity(Buffer.from(backend+' archive'))}])),
    patches,repairFiles,files:[...contents].map(([name,bytes])=>({path:name,...identity(bytes)})),
  };
  for (const [name,bytes] of contents) {const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(llamaBundleManifest(pin),null,2)+'\n');
  return {root,pin,contents,verify:llamaBundleTest.createVerifier(pin)};
}
async function inspect(f,run) {return inspectLlamaBundle({root:f.root,platform:'win32',arch:'x64',verify:f.verify,run});}
test('production source pins reject synthetic manifests and caller-supplied trust before execution',async t=>{
  const f=await fixture(t),accepted=llamaBundleManifest(LLAMA_RUNTIME_REPAIR_PIN);let calls=0;
  assert.equal(accepted.runtimeId,LLAMA_RUNTIME_ID);assert.equal(accepted.files.length,67);
  assert.deepEqual(accepted.provenance.patches.map(patch=>patch.name),LLAMA_PATCH_NAMES);
  await assert.rejects(verifyLlamaBundle({root:f.root,repairPin:f.pin}),{code:'LLAMA_BUNDLE_INTEGRITY'});
  const result=await inspectLlamaBundle({root:f.root,platform:'win32',arch:'x64',run:async()=>{calls++;}});
  assert.equal(result.available,false);assert.match(result.message,/integrity check/);assert.equal(calls,0);
});
test('verified bundle selects Vulkan and retains a verified CPU fallback',async t=>{
  const f=await fixture(t),calls=[];
  const gpu=await inspect(f,async(file,args)=>{calls.push({file,args});return {stdout:'Available devices:\n  Vulkan0: Test GPU (1024 MiB)'};});
  assert.equal(gpu.backend,'Vulkan');assert.equal(gpu.runtimeId,LLAMA_RUNTIME_ID);assert.equal(gpu.version,LLAMA_BUNDLE_VERSION);
  assert.match(gpu.fallbackPath,/cpu/);assert.match(gpu.manifestSha256,/^[a-f0-9]{64}$/);assert.equal(calls.length,1);
  const cpu=await inspect(f,async(file,args)=>{calls.push({file,args});if(file.includes('vulkan'))throw Error('driver absent');return {stdout:'fixture version'};});
  assert.equal(cpu.backend,'CPU');assert.ok(calls.some(call=>call.args[0]==='--version'));
});
test('unsupported platforms, absent files and failed CPU probes remain unavailable',async t=>{
  const f=await fixture(t);let calls=0;const run=async()=>{calls++;throw Error('cannot execute');};
  assert.equal((await inspectLlamaBundle({root:f.root,platform:'linux',verify:f.verify,run})).available,false);assert.equal(calls,0);
  assert.equal((await inspect(f,run)).available,false);assert.equal(calls,2);
  await fs.unlink(path.join(f.root,'cpu','ggml.dll'));calls=0;
  assert.equal((await inspect(f,run)).available,false);assert.equal(calls,0);
});
for (const [label,mutate] of [
  ['wrong runtime ID',pin=>pin.runtimeId='stock-b12359'],
  ['wrong source commit',pin=>pin.sourceCommit='0'.repeat(40)],
  ['wrong repair schema',pin=>pin.buildManifest.schema='old-qx1'],
  ['missing third source patch',pin=>pin.patches.pop()],
  ['wrong repair artifact repository',pin=>pin.repairArchive.url=pin.repairArchive.url.replace('MoonlightClarity','another-owner')],
  ['application draft used as runtime source',pin=>pin.repairArchive.url=pin.repairArchive.url.replace('/download/'+LLAMA_RUNTIME_ID+'/', '/download/v99.0.0/')],
  ['unencrypted repair artifact',pin=>pin.repairArchive.url=pin.repairArchive.url.replace('https:','http:')],
  ['repair artifact credentials',pin=>pin.repairArchive.url=pin.repairArchive.url.replace('https://','https://user:password@')],
  ['repair artifact query override',pin=>pin.repairArchive.url+='?download=untrusted'],
  ['wrong repair artifact name',pin=>pin.repairArchive.name='another.zip'],
  ['missing repair artifact digest',pin=>delete pin.repairArchive.sha256],
  ['missing repair DLL',pin=>pin.repairFiles.pop()],
  ['mixed backend executable',pin=>pin.files.find(file=>file.path==='cpu/llama-server.exe').sha256='0'.repeat(64)],
  ['wrong shipped patch hash',pin=>pin.files.find(file=>file.path==='patches/'+LLAMA_PATCH_NAMES[0]).sha256='0'.repeat(64)],
  ['unsafe inventory path',pin=>pin.files.push({path:'cpu/../escape.dll',size:1,sha256:hash('x')})],
  ['duplicate inventory path',pin=>pin.files.push({...pin.files[0]})],
  ['case-colliding inventory path',pin=>pin.files.push({...pin.files.find(file=>file.path==='cpu/ggml.dll'),path:'cpu/GGML.dll'})],
  ['reserved Windows filename',pin=>pin.files.push({path:'cpu/CON.dll',size:1,sha256:hash('x')})],
]) test('trusted repair validation rejects '+label+' before execution',async t=>{
  const f=await fixture(t);mutate(f.pin);let calls=0;
  assert.equal((await inspect(f,async()=>{calls++;return {stdout:'Vulkan0: device'};})).available,false);assert.equal(calls,0);
});
for (const [label,mutate] of [
  ['stock server in CPU variant',async root=>fs.writeFile(path.join(root,'cpu','llama-server.exe'),'stock tiny launcher')],
  ['altered Vulkan DLL',async root=>fs.appendFile(path.join(root,'vulkan','ggml.dll'),'bad')],
  ['missing license',async root=>fs.unlink(path.join(root,'LICENSE'))],
  ['unlisted DLL',async root=>fs.writeFile(path.join(root,'cpu','extra.dll'),'extra')],
  ['unlisted directory',async root=>fs.mkdir(path.join(root,'extra'))],
  ['old stock manifest',async root=>fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({version:LLAMA_BUNDLE_VERSION,files:[]}))],
  ['edited DLL and self-reported hash',async root=>{
    const file=path.join(root,'cpu','ggml.dll'),bytes=Buffer.from('altered official dependency');await fs.writeFile(file,bytes);
    const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
    Object.assign(manifest.files.find(row=>row.path==='cpu/ggml.dll'),identity(bytes));
    await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  }],
]) test('file verification rejects '+label+' before execution',async t=>{
  const f=await fixture(t);await mutate(f.root);let calls=0;
  assert.equal((await inspect(f,async()=>{calls++;return {stdout:'Vulkan0: device'};})).available,false);assert.equal(calls,0);
});
test('linked backend directory is rejected without following it',async t=>{
  const f=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-runtime-link-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.rename(path.join(f.root,'cpu'),path.join(outside,'cpu'));
  await fs.symlink(path.join(outside,'cpu'),path.join(f.root,'cpu'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.verify({root:f.root}),/linked path/);
});
test('installed verification needs only shipped bytes and emits path-free provenance',async t=>{
  const f=await fixture(t);f.pin.privateBuildPath='C:\\private\\do-not-ship';f.pin.sourceArchive.path='C:\\private\\source.tar.gz';
  f.pin.patches[0].path='C:\\private\\source.patch';const receipt=await f.verify({root:f.root});
  assert.equal(receipt.runtimeId,LLAMA_RUNTIME_ID);assert.equal(receipt.files.length,f.contents.size);
  assert.equal(JSON.stringify(receipt).includes('private'),false);
  assert.deepEqual(receipt.provenance.patches.map(patch=>patch.name),LLAMA_PATCH_NAMES);
  assert.ok(receipt.files.some(file=>file.path==='patches/'+LLAMA_PATCH_NAMES[2]));
  assert.deepEqual(receipt.provenance.repairArchive,f.pin.repairArchive);
});
test('prepared receipt binds every byte of an unpacked copy',async t=>{
  const f=await fixture(t),prepared=await f.verify({root:f.root}),copy=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-unpacked-'));
  t.after(()=>fs.rm(copy,{recursive:true,force:true}));await fs.cp(f.root,copy,{recursive:true});
  assert.deepEqual(await f.verify({root:copy,expected:prepared}),prepared);
  await assert.rejects(f.verify({root:copy,expected:{...prepared,inventorySha256:'0'.repeat(64)}}),/preparation receipt/);
  await fs.appendFile(path.join(copy,'vulkan','ggml.dll'),'package mutation');await assert.rejects(f.verify({root:copy,expected:prepared}),/altered file/);
});
test('explicit custom runtime settings remain outside bundled-runtime probing',async t=>{
  const f=await fixture(t),manager=await new LocalModelManager({dataDir:f.root,llamaBundleRoot:f.root}).init();t.after(()=>manager.close());
  const executable=path.join(f.root,'cpu','llama-server.exe');
  await manager.configureLlama({expectedRevision:0,settings:{executablePath:executable,modelPaths:{saved:path.join(f.root,'saved.gguf')}}});
  manager.bundledRuntime=()=>{throw Error('must not probe bundle');};
  assert.equal((await manager.llamaRuntimeStatus()).source,'custom');assert.equal(manager.llamaConfig().settings.executablePath,executable);
  assert.equal(manager.llamaConfig().settings.modelPaths.saved,path.join(f.root,'saved.gguf'));
});
