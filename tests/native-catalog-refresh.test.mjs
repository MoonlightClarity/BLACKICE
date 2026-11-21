import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Catalog continuity',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Use the requested files'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter {
 calls=[];failFirst=false;
 status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
 async runAgent(options){this.calls.push(options);const threadId=options.threadId||'fixture-thread-'+this.calls.length;options.onEvent?.({type:'thread',threadId});if(this.failFirst&&this.calls.length===1)throw Error('Fixture interruption');return {output:'Saved export result',threadId};}
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'blackice-catalog-refresh-')),runtime=new Runtime();
 const provider=async()=>({tools:provider.catalog,handle:async()=>({success:true,contentItems:[]}),instructions:'Use the attached visual schema.'});
 provider.catalog=[{type:'function',name:'relay_visual',description:'Read a visual artifact.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read']},id:{type:'string'}}}}];
 const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root,nativeVisualTools:provider}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 return {engine,runtime,provider};
}
async function start(engine){const run=engine.startRun({workflow:graph,input:'Check the saved export'});await engine.executions.get(run.id);return engine.getRun(run.id);}
test('same current native catalog keeps the provider thread',async t=>{
 const {engine,runtime}=await fixture(t),first=await start(engine);
 const next=engine.continueRun(first.id,{nodeId:'a',message:'Continue the export check'});await engine.executions.get(next.id);
 assert.equal(engine.getRun(next.id).status,'completed');
 assert.equal(runtime.calls[1].threadId,first.nodes.a.threadId);
 assert.equal(engine.getRun(next.id).taskId,first.taskId);
});
test('changed tool description refreshes the provider catalog in the same conversation',async t=>{
 const {engine,runtime,provider}=await fixture(t),first=await start(engine);
 provider.catalog[0]={...provider.catalog[0],description:'Read the current visual artifact and its saved revision.'};
 const next=engine.continueRun(first.id,{nodeId:'a',message:'Continue the export check'});await engine.executions.get(next.id);
 const done=engine.getRun(next.id);
 assert.equal(done.status,'completed',done.error);
 assert.equal(runtime.calls[1].threadId,undefined,'new instructions cannot accompany the old provider-pinned tool definition');
 assert.equal(done.modelHandoff.reason,'source-tool-catalog');
 assert.equal(done.taskId,first.taskId);
 assert.equal(done.parentRunId,first.id);
 assert.equal(done.modelHandoff.sourceThreadId,first.nodes.a.threadId);
 assert.equal(runtime.calls[1].dynamicTools.find(x=>x.name==='relay_visual').description,provider.catalog[0].description);
 assert.equal(engine.getRun(first.id).input,'Check the saved export');
});
test('changed argument schema refreshes a retry before provider execution',async t=>{
 const {engine,runtime,provider}=await fixture(t);runtime.failFirst=true;const first=await start(engine);
 assert.equal(first.status,'failed');
 provider.catalog[0]={...provider.catalog[0],inputSchema:{...provider.catalog[0].inputSchema,properties:{...provider.catalog[0].inputSchema.properties,revision:{type:'integer',minimum:0}}}};
 const next=engine.retryRun(first.id);await engine.executions.get(next.id);const done=engine.getRun(next.id);
 assert.equal(done.status,'completed',done.error);
 assert.equal(runtime.calls[1].threadId,undefined);
 assert.equal(done.nodeHandoffs.a.reason,'source-tool-catalog');
 assert.equal(done.taskId,first.taskId);
 assert.equal(done.retryOf,first.id);
 assert.deepEqual(runtime.calls[1].dynamicTools.find(x=>x.name==='relay_visual').inputSchema,provider.catalog[0].inputSchema);
});
test('a saved current-version catalog without a fingerprint refreshes once',async t=>{
 const {engine,runtime}=await fixture(t),first=await start(engine);
 delete engine.runs.get(first.id).nodes.a.nativeCatalogFingerprint;
 const next=engine.continueRun(first.id,{nodeId:'a',message:'Continue the export check'});await engine.executions.get(next.id);const refreshed=engine.getRun(next.id);
 assert.equal(refreshed.status,'completed',refreshed.error);
 assert.equal(runtime.calls[1].threadId,undefined);
 assert.match(refreshed.nodes.a.nativeCatalogFingerprint,/^[a-f0-9]{64}$/);
 const third=engine.continueRun(next.id,{nodeId:'a',message:'Continue checking'});await engine.executions.get(third.id);
 assert.equal(runtime.calls[2].threadId,refreshed.nodes.a.threadId);
 assert.equal(engine.getRun(third.id).taskId,first.taskId);
});

test('property ordering in an unchanged catalog does not replace a current thread',async t=>{
 const {engine,runtime,provider}=await fixture(t),first=await start(engine),original=provider.catalog[0];
 provider.catalog[0]={inputSchema:{properties:{id:{type:'string'},action:{enum:['read'],type:'string'}},required:['action'],additionalProperties:false,type:'object'},description:original.description,name:original.name,type:original.type};
 const next=engine.continueRun(first.id,{nodeId:'a',message:'Continue the export check'});await engine.executions.get(next.id);
 assert.equal(engine.getRun(next.id).status,'completed');
 assert.equal(runtime.calls[1].threadId,first.nodes.a.threadId);
 assert.equal(engine.getRun(next.id).nodes.a.nativeCatalogFingerprint,first.nodes.a.nativeCatalogFingerprint);
});
