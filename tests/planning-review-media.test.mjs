import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workbenchFramePng} from './fixtures/legacy-bmp-to-png.mjs';
import {inspectWorkbenchPng,retainWorkbenchCapture,readRetainedWorkbenchCapture} from '../lib/historical-guest-capture.mjs';
import {preparePlanningReviewMedia,loadPlanningReviewMedia,retainedPlanningCaptures,validatePlanningImageDelivery} from '../lib/planning-review-media.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function mediaPng(){const bytes=Buffer.alloc(70);bytes.write('BM');bytes.writeUInt32LE(70,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(2,18);bytes.writeInt32LE(-2,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);bytes.fill(180,54);return workbenchFramePng({bytes,width:2,height:2,sequence:7});}
export function mediaEvents(run,artifact){
  const metadata={basis:'native-decoded-surface',vmScope:'configured-vm',sequence:7,pngSha256:artifact.sha256,pngBytes:artifact.bytes,width:artifact.width,height:artifact.height,artifact};
  return [{runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.719Z',data:{type:'tool.result',tool:'relay_workbench',action:'capture',success:true,status:'completed',callId:'capture-actual'}},
    {runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.728Z',data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',tool:'relay_workbench',id:'capture-actual',arguments:{action:'capture',retain:true},status:'completed',success:true,contentItems:[{type:'inputText',text:JSON.stringify(metadata)},{type:'inputText',text:'[Screenshot returned to the agent]'}]}}}];
}
async function fixture(t){
  const workspace=await mkdtemp(path.join(tmpdir(),'planning-media-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const bytes=mediaPng(),artifact=await retainWorkbenchCapture({workspace,scope:'task-a',bytes,info:inspectWorkbenchPng(bytes)}),planRef={requestId:'request-a',cycleId:'cycle-a',nodeId:'plan-a',nodeRevision:4,responseId:'response-a'},run={id:'run-a',taskId:'task-a',responseCycle:{planRef}};
  run.events=mediaEvents(run,artifact);return {workspace,bytes,artifact,planRef,run};
}

test('trusted final media re-reads exact retained pixels and records hashes, never base64 or chosen file paths',async t=>{
  const f=await fixture(t),source=await preparePlanningReviewMedia(f),loaded=await loadPlanningReviewMedia({...f,source});
  assert.equal(loaded.inputImages.length,1);assert.deepEqual(Buffer.from(loaded.inputImages[0].imageUrl.split(',')[1],'base64'),f.bytes);
  assert.equal(loaded.delivery.count,1);assert.equal(loaded.delivery.images[0].sha256,hash(f.bytes));assert.equal(loaded.delivery.images[0].captureCallId,'capture-actual');
  assert.equal(JSON.stringify(source).includes('data:image'),false);assert.equal(JSON.stringify(loaded.delivery).includes('base64'),false);assert.equal(source.text.includes(f.workspace),false);
  assert.deepEqual((await readRetainedWorkbenchCapture({...f,scope:f.run.taskId})).bytes,f.bytes);
});

test('old runs, changed Plans, unmatched tool settlements and model artifact claims cannot provide pixels',async t=>{
  const f=await fixture(t);
  for(const mutate of [run=>run.events[1].runId='old-run',run=>run.events[0].data.success=false,run=>run.events[1].data.item.success=false,run=>run.events[1].data.item.arguments.retain=false]){
    const run=structuredClone(f.run);mutate(run);assert.equal(retainedPlanningCaptures(run,f.planRef).selected.length,0);
  }
  const paired=structuredClone(f.run),part=paired.events[1].data.item.contentItems[0],pairedMetadata=JSON.parse(part.text);pairedMetadata.basis='paired-guest-desktop';delete pairedMetadata.sequence;part.text=JSON.stringify(pairedMetadata);assert.equal(retainedPlanningCaptures(paired,f.planRef).selected.length,0,'This bounded final-review lane explicitly supports sequence-bound native captures only.');
  assert.throws(()=>retainedPlanningCaptures(f.run,{...f.planRef,responseId:'new-plan'}),{code:'PLANNING_MEDIA_BINDING'});
  const source=await preparePlanningReviewMedia(f),changed=JSON.parse(source.text);changed.images[0].receiptSha256='0'.repeat(64);source.text=JSON.stringify(changed);source.contentHash=hash(source.text);
  await assert.rejects(loadPlanningReviewMedia({...f,source}),{code:'PLANNING_MEDIA_BINDING'});
});

test('retained path/scope and changed bytes fail safely with explicit zero-image delivery',async t=>{
  const f=await fixture(t);
  for(const artifact of [{...f.artifact,hostPath:path.join(f.workspace,'outside.png')},{...f.artifact,scopeHash:'0'.repeat(64)},{...f.artifact,guestRelativePath:'../outside.png'}])await assert.rejects(readRetainedWorkbenchCapture({...f,scope:f.run.taskId,artifact}));
  const source=await preparePlanningReviewMedia(f);await writeFile(f.artifact.hostPath,Buffer.from('changed retained file'));
  const loaded=await loadPlanningReviewMedia({...f,source});assert.equal(loaded.inputImages.length,0);assert.equal(loaded.delivery.count,0);assert.equal(loaded.delivery.images[0].delivered,false);assert.ok(loaded.delivery.images[0].code);
  assert.equal((await readFile(f.artifact.hostPath)).toString(),'changed retained file','The reader never repairs or overwrites evidence.');
});

test('image-delivery persistence accepts bounded provenance only',async t=>{
  const f=await fixture(t),source=await preparePlanningReviewMedia(f),{delivery}=await loadPlanningReviewMedia({...f,source});
  assert.deepEqual(validatePlanningImageDelivery(delivery),delivery);
  for(const change of [value=>value.imageUrl='data:image/png;base64,secret',value=>value.count=2,value=>value.images[0].hostPath='C:/private',value=>value.images[0].sha256='invalid']){
    const changed=structuredClone(delivery);change(changed);assert.throws(()=>validatePlanningImageDelivery(changed),{code:'PLANNING_MEDIA_BINDING'});
  }
});
