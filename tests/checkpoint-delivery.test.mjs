import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL } from '../lib/task-state.mjs';
import { checkpointDeliveryPage, projectContractTaskState, createContractDeliveryTracker, CONTRACT_REPLY_BYTES } from '../lib/planning-contract-delivery.mjs';
const checkpoint = { kind:'progress', decisions:['Keep the existing implementation.'], provenance:{runId:'original',nodeId:'agent',source:'agent'}, updatedAt:'2026-11-18T00:00:00Z' };
const saved = () => ({taskId:'checkpoint-test',revision:4,taskSchemaVersion:14,steps:[],goal:'Inspect current inputs',checkpoint:structuredClone(checkpoint)});
const receipt = value => ({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
test('explicit checkpoint retrieval preserves exact historical provenance but default projection contains only discovery metadata',()=>{
 const state=saved(),before=structuredClone(state),projection=projectContractTaskState(state);
 assert.equal(projection.savedCheckpoint.available,true);assert.equal(JSON.stringify(projection).includes(checkpoint.decisions[0]),false);
 const full=checkpointDeliveryPage(state);assert.deepEqual(full.checkpoint,checkpoint);assert.match(full.context,/Historical task data/);assert.match(full.context,/Current user directions take precedence/);
 assert.equal(full.contractDelivery,undefined);assert.deepEqual(state,before);
 const seen=[],deliver=createContractDeliveryTracker(state.taskId,snapshot=>seen.push(snapshot));deliver(receipt(full));assert.equal(seen.length,0);
});
test('large Unicode checkpoint pages reconstruct exact content within budget and cannot acknowledge a contract',()=>{
 const state=saved();state.checkpoint.decisions=Array.from({length:24},()=> '保存🙂'.repeat(600));
 const full=checkpointDeliveryPage(state);assert.equal(full.checkpointDelivery.kind,'manifest');
 const seen=[],deliver=createContractDeliveryTracker(state.taskId,snapshot=>seen.push(snapshot));let next=full.nextRead,text='',count=0;
 while(next){const page=checkpointDeliveryPage(state,next);assert.ok(Buffer.byteLength(JSON.stringify(page))<=CONTRACT_REPLY_BYTES);assert.equal(page.contractDelivery,undefined);text+=page.text;next=page.nextRead;deliver(receipt(page));count++;}
 assert.ok(count>1);assert.deepEqual(JSON.parse(text),state.checkpoint);assert.equal(seen.length,0);
});
test('checkpoint pages reject changed revisions, changed hashes, removal and malformed ranges without modifying data',()=>{
 const state=saved(),args=projectContractTaskState(state).savedCheckpoint.nextRead,before=structuredClone(state);
 for(const changed of [{...state,revision:5},{...state,checkpoint:{...checkpoint,decisions:['changed']}},{...state,checkpoint:null}])assert.throws(()=>checkpointDeliveryPage(changed,args),{code:'TASK_STATE_CONFLICT'});
 for(const patch of [{viewHash:'0'.repeat(64)},{expectedRevision:3}])assert.throws(()=>checkpointDeliveryPage(state,{...args,...patch}),{code:'TASK_STATE_CONFLICT'});
 for(const patch of [{offset:-1},{charCount:8001},{limit:1}])assert.throws(()=>checkpointDeliveryPage(state,{...args,...patch}),{code:'TASK_CONTRACT_DELIVERY_INVALID'});
 assert.deepEqual(state,before);assert.equal(checkpointDeliveryPage({...state,checkpoint:null}).checkpoint,null);
});
test('real current task handler advertises and reads saved checkpoint without mutating state or canonical delivery',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-checkpoint-delivery-')),store=await new TaskStateStore({dataDir:dir}).init();
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
 const initial=await store.ensure({taskId:'checkpoint-test',runId:'original',nodeId:'agent',cwd:dir,goal:'Inspect inputs',schemaVersion:14});
 const handler=createTaskToolHandler({store,taskId:initial.taskId,runId:'original',nodeId:'agent'}),call=async args=>{const result=await handler({name:'relay_task',arguments:args});assert.equal(result.success,true,JSON.stringify(result));return JSON.parse(result.contentItems[0].text);};
 const written=await call({action:'checkpoint',expectedRevision:initial.revision,decisions:checkpoint.decisions});assert.ok(TASK_TOOL.inputSchema.properties.view.enum.includes('checkpoint'));assert.equal(written.savedCheckpoint.available,true);
 const before=await readFile(store.file(initial.taskId)),page=await call(written.savedCheckpoint.nextRead),value=JSON.parse(page.text);
 assert.deepEqual(value.decisions,checkpoint.decisions);assert.equal(value.provenance.runId,'original');assert.equal(value.provenance.nodeId,'agent');assert.equal(value.provenance.source,'agent');assert.equal(page.contractDelivery,undefined);
 assert.deepEqual(await readFile(store.file(initial.taskId)),before);
});
