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
test('owner-edited tool wording refreshes the model catalog without changing the executable definition',async t=>{
 const {engine,runtime,provider}=await fixture(t);
 const baseline=structuredClone(provider.catalog[0]);
 const first=await start(engine);
 await engine.toolDescriptions.save({
  name:baseline.name,description:'Owner-authored visual instructions: use the saved item identifier.',
  expectedRevision:engine.toolDescriptions.revision
 },engine.nativeToolDefinitions());
 const next=engine.continueRun(first.id,{nodeId:'a',message:'Continue the export check'});
 await engine.executions.get(next.id);
 const done=engine.getRun(next.id),delivered=runtime.calls[1].dynamicTools.find(item=>item.name===baseline.name);
 assert.equal(done.status,'completed',done.error);
 assert.equal(runtime.calls[1].threadId,undefined,'stale provider definition must not survive an owner edit');
 assert.equal(delivered.description,'Owner-authored visual instructions: use the saved item identifier.');
 assert.deepEqual(delivered.inputSchema,baseline.inputSchema,'editing wording must not change executable protocol');
 assert.deepEqual(provider.catalog[0],baseline,'shipped tool definition stays unchanged');
 assert.equal(runtime.calls[1].dynamicTools.filter(item=>item.name===baseline.name).length,1);
});
test('owner tool wording suppresses conflicting baked-in routing instructions',async t=>{
 const {engine,runtime}=await fixture(t);
 await engine.toolDescriptions.save({name:'relay_workspace',
  description:'Owner specifies the workspace behavior in these current model instructions.',
  expectedRevision:engine.toolDescriptions.revision},engine.nativeToolDefinitions());
 const done=await start(engine);
 assert.equal(done.status,'completed',done.error);
 const request=runtime.calls[0];
 assert.match(request.dynamicTools.find(tool=>tool.name==='relay_workspace').description,
  /Owner specifies the workspace behavior/);
 assert.match(request.developerInstructions,/BLACKICE TOOL ROUTING/);
 assert.doesNotMatch(request.developerInstructions,
  /Use supplied absolute paths directly; the working folder is not a search boundary\./,
  'original per-tool instruction must not override the authored tool description');
});
test('editing only schema-field wording supersedes conflicting hardcoded routing guidance',async t=>{
 const {engine,runtime}=await fixture(t);
 const definitions=engine.nativeToolDefinitions();
 const workspace=definitions.find(tool=>tool.name==='relay_workspace');
 const schema=structuredClone(workspace.inputSchema);
 schema.properties.action.description='Owner-provided interpretation of the available workspace actions.';
 await engine.toolDescriptions.save({name:'relay_workspace',inputSchema:schema,
  expectedRevision:engine.toolDescriptions.revision},definitions);
 const done=await start(engine);
 assert.equal(done.status,'completed',done.error);
 const request=runtime.calls[0];
 const tool=request.dynamicTools.find(tool=>tool.name==='relay_workspace');
 assert.equal(tool.inputSchema.properties.action.description,
  'Owner-provided interpretation of the available workspace actions.');
 assert.deepEqual(tool.inputSchema.properties.action.enum,workspace.inputSchema.properties.action.enum,
  'native action choices remain unchanged');
 assert.doesNotMatch(request.developerInstructions,
  /Use supplied absolute paths directly; the working folder is not a search boundary\./,
  'a schema-only documentation edit must also suppress contradictory hardcoded routing notes');
});
test('a disabled Runtime tool is rejected at dispatch even if a stale model attempts it',async t=>{
 const {engine,runtime}=await fixture(t);
 await engine.toolDescriptions.save({name:'relay_workspace',action:'disable',
  expectedRevision:engine.toolDescriptions.revision},engine.nativeToolDefinitions());
 runtime.runAgent=async options=>{
  runtime.calls.push(options);
  assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_workspace'),false,
   'disabled tool must not be advertised');
  const receipt=await options.onToolCall({name:'relay_workspace',callId:'stale-tool-attempt',
   arguments:{action:'run',command:'echo must-not-run'}});
  assert.equal(receipt.success,false);
  assert.equal(receipt.code,'RUNTIME_TOOL_NOT_ATTACHED');
  return {output:'Stale disabled tool was rejected',threadId:'disabled-tool-fixture'};
 };
 const done=await start(engine);
 assert.equal(done.status,'completed',done.error);
 assert.equal(done.nodes.a.output,'Stale disabled tool was rejected');
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
