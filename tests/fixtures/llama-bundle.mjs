import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  llamaBundleManifest, llamaBundleTest, LLAMA_RUNTIME_ID, LLAMA_RUNTIME_COMMIT,
  LLAMA_RUNTIME_PIN, LLAMA_PATCH_NAMES,
} from '../../lib/llama-cpp-bundle.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const identity = bytes => ({size:bytes.length,sha256:hash(bytes)});
export async function createLlamaBundleFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'blackice-bundle-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable = Buffer.from('qualified synthetic QX4 executable'), contents = new Map([['LICENSE',Buffer.from('MIT fixture license')]]);
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
    buildManifest:{schema:'blackice.minicpm.qx4.bundle.v1',...identity(Buffer.from('private build manifest'))},
    executable:identity(executable),
    archives:Object.fromEntries(['cpu','vulkan'].map(backend=>[backend,{name:LLAMA_RUNTIME_PIN[backend].name,...identity(Buffer.from(backend+' archive'))}])),
    patches,repairFiles,files:[...contents].map(([name,bytes])=>({path:name,...identity(bytes)})),
  };
  for (const [name,bytes] of contents) {const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(llamaBundleManifest(pin),null,2)+'\n');
  return {root,pin,contents,verify:llamaBundleTest.createVerifier(pin)};
}
