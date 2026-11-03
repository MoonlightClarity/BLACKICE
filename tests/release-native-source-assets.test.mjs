import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyNativeSourcePayload} from '../scripts/release-native-source-assets.mjs';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{changed=false,missing=false,extra=false,caseMismatch=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-source-assets-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^blackice-source-assets-/);await fs.rm(root,{recursive:true,force:true});});
  const source=path.join(root,'content');await fs.mkdir(source);await fs.mkdir(path.join(source,'sources'));await fs.mkdir(path.join(source,'crates'));
  const values=[{path:'README.txt',body:Buffer.from('fixture source archive\n')},{path:'sources/matching.src.tar.zst',body:Buffer.from([0,1,2,255,0,42])},{path:'crates/matching-1.0.0.crate',body:Buffer.alloc(70000,197)},{path:'empty.txt',body:Buffer.alloc(0)}];
  const index={payloadFiles:values.map(v=>({path:v.path,sha256:sha(v.body),bytes:v.body.length}))},indexBytes=Buffer.from(JSON.stringify(index));
  for(const value of values)if(!missing||!value.path.startsWith('sources/'))await fs.writeFile(path.join(source,caseMismatch&&value.path==='README.txt'?'readme.txt':value.path),changed&&value.path.startsWith('crates/')?Buffer.alloc(value.body.length,198):value.body);
  await fs.writeFile(path.join(source,'SOURCE-INDEX.json'),indexBytes);if(extra)await fs.writeFile(path.join(source,'extra.txt'),'unexpected');
  const archivePath=path.join(root,'source.tar'),names=await fs.readdir(source);
  await execute('tar',['-cf',archivePath,'-C',source,...names],{windowsHide:true});
  return {archivePath,index,indexBytes,source,root};
}

test('actual source tar verifies every indexed byte across binary, chunk and empty-file boundaries',async t=>{
  const value=await fixture(t),r=await verifyNativeSourcePayload(value);assert.equal(r.payloadFilesVerified,4);assert.ok(r.payloadBytesVerified>70000);
});
test('changed crate bytes are rejected even when the index and file size are unchanged',async t=>{
  await assert.rejects(verifyNativeSourcePayload(await fixture(t,{changed:true})),/checksum mismatch/);
});
test('missing source package is rejected instead of trusting its index entry',async t=>{
  await assert.rejects(verifyNativeSourcePayload(await fixture(t,{missing:true})),/differs from index/);
});
test('additional unindexed payload is rejected',async t=>{
  await assert.rejects(verifyNativeSourcePayload(await fixture(t,{extra:true})),/differs from index/);
});
test('source archive member names must match exact index case',async t=>{
  await assert.rejects(verifyNativeSourcePayload(await fixture(t,{caseMismatch:true})),/differs from index/);
});
test('duplicate and escaping index names are rejected before archive extraction',async t=>{
  const value=await fixture(t);value.index.payloadFiles.push({...value.index.payloadFiles[0]});await assert.rejects(verifyNativeSourcePayload(value),/invalid payload inventory/);
  value.index.payloadFiles=[{path:'../escape.txt',sha256:sha('bad'),bytes:3}];await assert.rejects(verifyNativeSourcePayload(value),/invalid payload inventory/);
});
test('truncated actual tar cannot establish a complete source payload',async t=>{
  const value=await fixture(t),b=await fs.readFile(value.archivePath);await fs.writeFile(value.archivePath,b.subarray(0,2500));await assert.rejects(verifyNativeSourcePayload(value));
});
