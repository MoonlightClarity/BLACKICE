import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectWorkbenchPng, retainWorkbenchCapture, readRetainedWorkbenchCapture } from '../lib/historical-guest-capture.mjs';
import { workbenchFramePng } from './fixtures/legacy-bmp-to-png.mjs';

function historicalPng() {
  const bytes=Buffer.alloc(54+2*2*4);
  bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);
  bytes.writeUInt32LE(40,14);bytes.writeInt32LE(2,18);bytes.writeInt32LE(-2,22);
  bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);bytes.fill(125,54);
  return workbenchFramePng({bytes,width:2,height:2});
}

test('archived guest capture remains readable without the virtual machine',async t=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'historical-guest-capture-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const scope='older-conversation-123',bytes=historicalPng(),info=inspectWorkbenchPng(bytes);
  const artifact=await retainWorkbenchCapture({workspace,scope,bytes,info});
  assert.equal(artifact.retained,true);
  const read=await readRetainedWorkbenchCapture({workspace,scope,artifact});
  assert.equal(read.bytes.equals(bytes),true);
  assert.equal(read.info.pngSha256,artifact.sha256);
  await assert.rejects(readRetainedWorkbenchCapture({workspace,scope:'different-run',artifact}),{code:'WORKBENCH_CAPTURE_ARTIFACT'});
  await assert.rejects(readRetainedWorkbenchCapture({workspace,scope,artifact:{...artifact,hostPath:path.join(workspace,'other.png')}}),{code:'WORKBENCH_CAPTURE_PATH'});
});

test('tampering an old retained image cannot be accepted as evidence',async t=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'historical-guest-tamper-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const scope='older-run',bytes=historicalPng(),info=inspectWorkbenchPng(bytes);
  const artifact=await retainWorkbenchCapture({workspace,scope,bytes,info});
  await writeFile(artifact.hostPath,Buffer.alloc(bytes.length));
  await assert.rejects(readRetainedWorkbenchCapture({workspace,scope,artifact}),{code:'WORKBENCH_CAPTURE_INVALID'});
});
