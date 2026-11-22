import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareLlamaRuntime, llamaPreparationTest } from '../scripts/prepare-llama-runtime.mjs';
import {
  LLAMA_RUNTIME_ID, LLAMA_RUNTIME_COMMIT, LLAMA_RUNTIME_PIN, LLAMA_PATCH_NAMES,
  llamaBundleTest,
} from '../lib/llama-cpp-bundle.mjs';
const execute = promisify(execFile), windows = process.platform === 'win32';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({size:bytes.length,sha256:hash(bytes)});
const quote = value => "'"+value.replaceAll("'","''")+"'";
async function zipFiles(root, archives) {
  const input=path.join(root,'zip-inputs.json');
  await fs.writeFile(input,JSON.stringify(archives.map(archive=>({
    path:archive.path,entries:archive.entries.map(([name,bytes])=>({name,base64:bytes.toString('base64')})),
  }))));
  for(const archive of archives)await fs.rm(archive.path,{force:true});
  const script='$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; '+
    '$items=Get-Content -LiteralPath '+quote(input)+' -Raw | ConvertFrom-Json; '+
    'foreach($a in $items) { $z=[System.IO.Compression.ZipFile]::Open($a.path,[System.IO.Compression.ZipArchiveMode]::Create); try {'+
    'foreach($e in $a.entries) { $entry=$z.CreateEntry($e.name); $s=$entry.Open(); try { $b=[Convert]::FromBase64String($e.base64); $s.Write($b,0,$b.Length) } finally {$s.Dispose()} }'+
    '} finally {$z.Dispose()} }';
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:65536});
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-runtime-prepare-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'source'),repairBundle=path.join(root,'repair'),cache=path.join(root,'cache'),destination=path.join(root,'prepared');
  for(const folder of [path.join(sourceRoot,'desktop'),path.join(sourceRoot,'verification','minicpm-agent-tools-v2'),path.join(repairBundle,'bin'),cache,destination])await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(destination,'prior-runtime.txt'),'prior accepted runtime');
  const executable=Buffer.from('qualified synthetic QX3 executable\n'),license=Buffer.from('fixture MIT license\n'),sourceArchive=Buffer.from('pinned source archive');
  const patches=LLAMA_PATCH_NAMES.map(name=>({name,bytes:Buffer.from('portable source patch '+name+'\n')}));
  for(const patch of patches)await fs.writeFile(path.join(sourceRoot,'verification','minicpm-agent-tools-v2',patch.name),patch.bytes);
  await fs.writeFile(path.join(sourceRoot,'desktop','llama.cpp-LICENSE'),license);
  const dlls=new Map([['ggml-base.dll',Buffer.from('official base')],['ggml.dll',Buffer.from('official ggml')],['ggml-vulkan.dll',Buffer.from('official Vulkan')]]);
  for(let i=0;i<16;i++)dlls.set('ggml-cpu-fixture-'+i+'.dll',Buffer.from('official CPU library '+i));
  const repairEntries=[['llama-server.exe',executable],...dlls];
  for(const [name,bytes] of repairEntries)await fs.writeFile(path.join(repairBundle,'bin',name),bytes);
  const entries={},archives=[];
  for(const backend of ['cpu','vulkan']) {
    entries[backend]=[['llama-server.exe',Buffer.from('official stock launcher '+backend)],...[...dlls].filter(([name])=>backend==='vulkan'||name!=='ggml-vulkan.dll'),
      ['common.dll',Buffer.from('official common '+backend)],['LICENSE-runtime',Buffer.from('official license '+backend)],['llama-cli.exe',Buffer.from('unrelated official command')]];
    archives.push({path:path.join(cache,LLAMA_RUNTIME_PIN[backend].name),entries:entries[backend]});
  }
  await zipFiles(root,archives);
  const archiveBytes=Object.fromEntries(await Promise.all(['cpu','vulkan'].map(async backend=>[backend,await fs.readFile(path.join(cache,LLAMA_RUNTIME_PIN[backend].name))])));
  const manifest={
    schema:'blackice.minicpm.qx3.bundle.v1',runtimeId:LLAMA_RUNTIME_ID,sourceCommit:LLAMA_RUNTIME_COMMIT,release:'b12359',
    archive:{bytes:sourceArchive.length,sha256:hash(sourceArchive)},
    files:repairEntries.map(([name,bytes])=>({name,relativePath:'bin/'+name,bytes:bytes.length,sha256:hash(bytes)})),
    patches:patches.map(patch=>({name:patch.name,bytes:patch.bytes.length,sha256:hash(patch.bytes)})),
  },manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await fs.writeFile(path.join(repairBundle,'manifest.json'),manifestBytes);
  const files=[{path:'LICENSE',...identity(license)},...patches.map(patch=>({path:'patches/'+patch.name,...identity(patch.bytes)}))];
  for(const backend of ['cpu','vulkan'])for(const [name,bytes] of entries[backend])if(name.endsWith('.dll')||name==='llama-server.exe'||name.startsWith('LICENSE'))files.push({path:backend+'/'+name,...identity(name==='llama-server.exe'?executable:bytes)});
  const pin={
    runtimeId:LLAMA_RUNTIME_ID,sourceCommit:LLAMA_RUNTIME_COMMIT,release:'b12359',sourceArchive:identity(sourceArchive),
    buildManifest:{schema:manifest.schema,...identity(manifestBytes)},executable:identity(executable),
    repairArchive:{name:LLAMA_RUNTIME_ID+'.zip',url:'https://github.com/MoonlightClarity/BLACKICE/releases/download/'+LLAMA_RUNTIME_ID+'/'+LLAMA_RUNTIME_ID+'.zip',...identity(Buffer.from('synthetic portable repair archive'))},
    archives:Object.fromEntries(['cpu','vulkan'].map(backend=>[backend,{name:LLAMA_RUNTIME_PIN[backend].name,...identity(archiveBytes[backend])}])),
    patches:patches.map(patch=>({name:patch.name,...identity(patch.bytes)})),
    repairFiles:repairEntries.map(([name,bytes])=>({path:'bin/'+name,...identity(bytes)})),files,
  };
  return {root,sourceRoot,repairBundle,cache,destination,pin,entries,archiveBytes,manifest,manifestBytes,patches,repairEntries,executable};
}
const options=f=>({destination:f.destination,cache:f.cache,repairBundle:f.repairBundle,fetchImpl:async()=>{throw Error('unexpected network request');}});
const prepare=(f,pin=f.pin,extra={})=>llamaPreparationTest.createPreparer(pin,{sourceRoot:f.sourceRoot,platform:'win32',arch:'x64',...extra});
const marker=f=>fs.readFile(path.join(f.destination,'prior-runtime.txt'),'utf8');
async function noStage(f) {assert.deepEqual((await fs.readdir(f.root)).filter(name=>name.startsWith('.llama-runtime-stage-')),[]);}
test('production preparation ignores caller trust and rejects an untrusted manifest before effects',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-source-pinned-runtime-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let fetches=0;
  const manifest=Buffer.from(JSON.stringify({schema:'blackice.minicpm.qx3.bundle.v1',runtimeId:LLAMA_RUNTIME_ID,files:[]})+'\n');
  await fs.writeFile(path.join(root,'manifest.json'),manifest);
  await assert.rejects(prepareLlamaRuntime({destination:path.join(root,'destination'),cache:path.join(root,'cache'),repairBundle:root,repairPin:{runtimeId:'caller-selected-runtime'},fetchImpl:async()=>{fetches++;}}),{code:'LLAMA_RUNTIME_PREPARATION'});
  assert.equal(fetches,0);assert.deepEqual(await fs.readdir(root),['manifest.json']);
  assert.deepEqual(await fs.readFile(path.join(root,'manifest.json')),manifest);
});
test('actual Windows ZIP preparation overlays both EXEs and preserves every official DLL and license', {skip:!windows},async t=>{
  const f=await fixture(t),result=await prepare(f)(options(f));
  assert.equal(result.runtime.runtimeId,LLAMA_RUNTIME_ID);assert.equal(result.files,f.pin.files.length);assert.equal(JSON.stringify(result.runtime).includes('private-build'),false);
  await assert.rejects(fs.stat(path.join(f.destination,'prior-runtime.txt')),{code:'ENOENT'});
  for(const backend of ['cpu','vulkan']) {
    assert.deepEqual(await fs.readFile(path.join(f.destination,backend,'llama-server.exe')),f.executable);
    for(const [name,bytes] of f.entries[backend])if(name.endsWith('.dll')||name.startsWith('LICENSE'))assert.deepEqual(await fs.readFile(path.join(f.destination,backend,name)),bytes);
    await assert.rejects(fs.stat(path.join(f.destination,backend,'llama-cli.exe')),{code:'ENOENT'});
  }
  assert.equal((await fs.readdir(path.join(f.destination,'cpu'))).includes('ggml-vulkan.dll'),false);
  for(const patch of f.patches)assert.deepEqual(await fs.readFile(path.join(f.destination,'patches',patch.name)),patch.bytes);
  const copy=path.join(f.root,'unpacked');await fs.cp(f.destination,copy,{recursive:true});
  const verify=llamaBundleTest.createVerifier(f.pin);assert.deepEqual(await verify({root:copy,expected:result.runtime}),result.runtime);
  await fs.appendFile(path.join(copy,'vulkan','common.dll'),'changed after package');await assert.rejects(verify({root:copy,expected:result.runtime}),/altered file/);
  await noStage(f);
});
test('invalid repair inputs are rejected before staging or extraction and preserve the existing destination', {skip:!windows},async t=>{
  const f=await fixture(t),manifestPath=path.join(f.repairBundle,'manifest.json'),patchPath=path.join(f.sourceRoot,'verification','minicpm-agent-tools-v2',LLAMA_PATCH_NAMES[1]);
  async function changedManifest(pin,change) {const value=structuredClone(f.manifest);change(value);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await fs.writeFile(manifestPath,bytes);pin.buildManifest={schema:value.schema,...identity(bytes)};}
  const cases=[
    ['wrong build manifest hash',async pin=>{pin.buildManifest.sha256='0'.repeat(64);}],
    ['missing repair DLL',async()=>fs.unlink(path.join(f.repairBundle,'bin','ggml.dll'))],
    ['changed repair executable',async()=>fs.appendFile(path.join(f.repairBundle,'bin','llama-server.exe'),'bad')],
    ['extra repair DLL',async()=>fs.writeFile(path.join(f.repairBundle,'bin','extra.dll'),'bad')],
    ['changed checked-in I/O patch',async()=>fs.appendFile(patchPath,'bad')],
    ['changed checked-in action schema patch',async()=>fs.appendFile(path.join(f.sourceRoot,'verification','minicpm-agent-tools-v2',LLAMA_PATCH_NAMES[2]),'bad')],
    ['wrong source provenance',async pin=>changedManifest(pin,value=>value.sourceCommit='0'.repeat(40))],
    ['wrong patch provenance',async pin=>changedManifest(pin,value=>value.patches[1].sha256='0'.repeat(64))],
    ['missing third patch provenance',async pin=>changedManifest(pin,value=>value.patches.pop())],
    ['duplicate third patch provenance',async pin=>changedManifest(pin,value=>value.patches[2]={...value.patches[0]})],
    ['private audit fields in portable manifest',async pin=>changedManifest(pin,value=>value.privateDiagnosticPath='C:\\private\\logs')],
    ['duplicate repair manifest entry',async pin=>changedManifest(pin,value=>value.files.push({...value.files[0]}))],
    ['unsafe repair manifest path',async pin=>changedManifest(pin,value=>value.files[0].relativePath='../outside.exe')],
  ];
  for(const [label,change] of cases)await t.test(label,async()=>{
    await fs.writeFile(manifestPath,f.manifestBytes);
    for(const [name,bytes] of f.repairEntries)await fs.writeFile(path.join(f.repairBundle,'bin',name),bytes);
    await fs.rm(path.join(f.repairBundle,'bin','extra.dll'),{force:true});
    for(const patch of f.patches)await fs.writeFile(path.join(f.sourceRoot,'verification','minicpm-agent-tools-v2',patch.name),patch.bytes);
    const pin=structuredClone(f.pin);await change(pin);let extractions=0;
    await assert.rejects(prepare(f,pin,{extract:async()=>{extractions++;throw Error('must not extract');}})(options(f)));
    assert.equal(extractions,0);assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
  });
});
test('a failed second-backend extraction preserves the existing runtime and removes owned staging', {skip:!windows},async t=>{
  const f=await fixture(t);let calls=0;
  const extract=async(archive,folder)=>{
    calls++;if(path.basename(folder)==='vulkan')throw Error('fixture Vulkan extraction failed');
    for(const [name,bytes] of f.entries.cpu)await fs.writeFile(path.join(folder,name),bytes);
  };
  await assert.rejects(prepare(f,f.pin,{extract})(options(f)),/fixture Vulkan extraction failed/);
  assert.equal(calls,2);assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
});
test('failed promotion restores the previous directory through the same rename boundary', {skip:!windows},async t=>{
  const f=await fixture(t);let renames=0;
  const rename=async(from,to)=>{renames++;if(renames===2)throw Object.assign(Error('fixture promotion denied'),{code:'EACCES'});return fs.rename(from,to);};
  await assert.rejects(prepare(f,f.pin,{rename})(options(f)),/fixture promotion denied/);
  assert.equal(renames,3);assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
});
test('official archive download uses exact upstream URLs and refuses checksum or HTTP failure before staging', {skip:!windows},async t=>{
  const f=await fixture(t),archive=path.join(f.cache,LLAMA_RUNTIME_PIN.cpu.name);await fs.writeFile(archive,'invalid cache');
  for(const response of [{ok:true,status:200,arrayBuffer:async()=>Buffer.from('wrong download')},{ok:false,status:503}]) {
    const urls=[];await assert.rejects(prepare(f)({...options(f),fetchImpl:async url=>{urls.push(url);return response;}}),/checksum mismatch|download failed/);
    assert.deepEqual(urls,['https://github.com/ggml-org/llama.cpp/releases/download/b12359/'+LLAMA_RUNTIME_PIN.cpu.name]);
    assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
  }
  let calls=0;const result=await prepare(f)({...options(f),fetchImpl:async()=>{calls++;return {ok:true,arrayBuffer:async()=>f.archiveBytes.cpu};}});
  assert.equal(calls,1);assert.equal(result.runtime.runtimeId,LLAMA_RUNTIME_ID);assert.deepEqual(await fs.readFile(archive),f.archiveBytes.cpu);
});
test('unsafe and case-colliding ZIP entries reject without touching the previous runtime', {skip:!windows},async t=>{
  const f=await fixture(t),archive=path.join(f.cache,LLAMA_RUNTIME_PIN.vulkan.name);
  for(const [label,entries] of [
    ['traversal',[...f.entries.vulkan,['../escape.dll',Buffer.from('bad')]]],
    ['case collision',[...f.entries.vulkan,['GGML.dll',Buffer.from('collision')]]],
  ])await t.test(label,async()=>{
    await zipFiles(f.root,[{path:archive,entries}]);const bytes=await fs.readFile(archive),pin=structuredClone(f.pin);
    pin.archives.vulkan={name:LLAMA_RUNTIME_PIN.vulkan.name,...identity(bytes)};
    await assert.rejects(prepare(f,pin)(options(f)),/Unexpected or duplicate archive path/);
    assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
    await assert.rejects(fs.stat(path.join(f.root,'escape.dll')),{code:'ENOENT'});
  });
});
test('a trusted archive with an unapproved or missing dependency cannot create a partial bundle', {skip:!windows},async t=>{
  const f=await fixture(t),archive=path.join(f.cache,LLAMA_RUNTIME_PIN.vulkan.name);
  for(const [label,entries] of [
    ['extra DLL',[...f.entries.vulkan,['unexpected.dll',Buffer.from('extra')]]],
    ['missing DLL',f.entries.vulkan.filter(([name])=>name!=='ggml.dll')],
    ['missing stock server',f.entries.vulkan.filter(([name])=>name!=='llama-server.exe')],
  ])await t.test(label,async()=>{
    await zipFiles(f.root,[{path:archive,entries}]);const bytes=await fs.readFile(archive),pin=structuredClone(f.pin);
    pin.archives.vulkan={name:LLAMA_RUNTIME_PIN.vulkan.name,...identity(bytes)};
    await assert.rejects(prepare(f,pin)(options(f)),/unlisted|missing/);
    assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
  });
});
test('linked repair roots and destinations containing their own inputs reject without mutation', {skip:!windows},async t=>{
  const f=await fixture(t),link=path.join(f.root,'repair-link');
  await fs.symlink(f.repairBundle,link,'junction');
  await assert.rejects(prepare(f)({...options(f),repairBundle:link}),/ordinary directory/);
  await assert.rejects(prepare(f)({...options(f),destination:f.root}),/must not contain/);
  assert.equal(await marker(f),'prior accepted runtime');await noStage(f);
});
