import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectLlamaBundle, verifyLlamaBundle, llamaBundleManifest,
  LLAMA_BUNDLE_VERSION, LLAMA_RUNTIME_ID, LLAMA_RUNTIME_COMMIT,
  LLAMA_RUNTIME_REPAIR_PIN, LLAMA_PATCH_NAMES,
} from '../lib/llama-cpp-bundle.mjs';
import { LocalModelManager } from '../lib/local-model-manager.mjs';
import { createLlamaBundleFixture as fixture, hash, identity } from './fixtures/llama-bundle.mjs';
async function inspect(f,run) {return inspectLlamaBundle({root:f.root,platform:'win32',arch:'x64',verify:f.verify,run});}
test('production source pins reject synthetic manifests and caller-supplied trust before execution',async t=>{
  const f=await fixture(t),accepted=llamaBundleManifest(LLAMA_RUNTIME_REPAIR_PIN);let calls=0;
  assert.equal(accepted.runtimeId,LLAMA_RUNTIME_ID);assert.equal(accepted.files.length,68);
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
  ['missing third source patch',pin=>pin.patches.splice(2,1)],
  ['missing fourth source patch',pin=>pin.patches.pop()],
  ['wrong fourth source patch hash',pin=>pin.patches[3].sha256='0'.repeat(64)],
  ['legacy QX3 portable schema',pin=>pin.buildManifest.schema='blackice.minicpm.qx3.bundle.v1'],
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
  ['missing fourth patch file',async root=>fs.unlink(path.join(root,'patches',LLAMA_PATCH_NAMES[3]))],
  ['altered fourth patch file',async root=>fs.appendFile(path.join(root,'patches',LLAMA_PATCH_NAMES[3]),'bad')],
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

test('RB4 source binding pins the exact QX4 native qualification',async()=>{
  const accepted=llamaBundleManifest(LLAMA_RUNTIME_REPAIR_PIN),pin=accepted.provenance;
  assert.equal(accepted.runtimeId,'blackice-b12359-qwen3-unique-parameters-io-v3');
  assert.deepEqual(pin.buildManifest,{schema:'blackice.minicpm.qx4.bundle.v1',size:5128,sha256:'d90814fb28438f0d77ef3ec55d5f51979799ce83dc92859e385f6c175f4b9d03'});
  assert.deepEqual(pin.executable,{size:18919876,sha256:'4277c145aa9f8705a21b8970a3e19ae9b2563c2f83db79ed57c071f8a1c56b2e'});
  assert.equal(pin.repairArchive.size,83795396);
  assert.equal(pin.repairArchive.sha256,'257696fce676fa42946195ab01620c67eec3732899bec53adc7ae24402e77a07');
  assert.equal(pin.repairArchive.url,'https://github.com/MoonlightClarity/BLACKICE/releases/download/runtime-'+accepted.runtimeId+'/'+accepted.runtimeId+'.zip');
  assert.deepEqual(LLAMA_PATCH_NAMES,['llama-qwen3-object-schema.patch','llama-qwen3-io-compat.patch','llama-qwen3-action-schema.patch','llama-qwen3-unique-parameters.patch']);
  assert.equal(accepted.files.length,68);
  for(const patch of pin.patches){
    const bytes=await fs.readFile(new URL('../verification/minicpm-agent-tools-v2/'+patch.name,import.meta.url));
    assert.deepEqual(identity(bytes),{size:patch.size,sha256:patch.sha256});
  }
  assert.deepEqual(pin.patches.at(-1),{name:'llama-qwen3-unique-parameters.patch',size:19985,sha256:'3dd918002874b9993beceb28e20756424f64f36af2ea9a7e6768128da5981688'});
  for(const backend of ['cpu','vulkan'])assert.deepEqual(accepted.files.find(file=>file.path===backend+'/llama-server.exe'),{path:backend+'/llama-server.exe',...pin.executable});
});
