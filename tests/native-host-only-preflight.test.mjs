import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexRuntime} from '../lib/codex.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {CHAT_PLANNING_MODULES,createChatPlanningPass} from '../lib/chat-planning-pass.mjs';
import {createChatPlanningProviderInvoker} from '../lib/chat-planning-provider.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES} from '../lib/response-profile.mjs';

async function fixture(t,{ignoredFeature,answer='SYNTHETIC_PROTECTED_OK',onTurn}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-native-preflight-'));
 const cwd=path.join(dir,'workspace');await mkdir(cwd);
 const client=new CodexRuntime({command:process.execPath,cwd,isolatedHistory:false,runTimeoutMs:5000,
   spawnImpl(){throw Error('No process may start during synthetic preflight tests.')}});
 const child={};client.child=child;
 Object.assign(client.info,{connected:true,authenticated:true,defaultModel:'gpt-6-luna',
  models:[{id:'gpt-6-luna',model:'gpt-6-luna',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]});
 const calls=[];let next=0;
 client._request=async(method,params={})=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='config/read')return {config:{skills:{config:[]},plugins:{ambient:{enabled:true}},mcp_servers:{ambient:{command:'do-not-run'}}}};
  if(method==='skills/list')return {data:[{cwd,skills:[],errors:[]}]};
  if(method==='experimentalFeature/list')return {data:PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({name,stage:'stable',
    enabled:params.threadId?name===ignoredFeature:true})),nextCursor:null};
  if(method==='thread/start')return {thread:{id:'thread-'+(++next),ephemeral:params.ephemeral===true},
    sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy};
  if(['thread/unsubscribe','turn/interrupt'].includes(method))return {};
  if(method==='turn/start'){
    const id='turn-'+next;
    const complete=()=>client._notification('turn/completed',{threadId:params.threadId,
      turn:{id,status:'completed',items:[{type:'agentMessage',id:'synthetic-answer',phase:'final_answer',text:answer}]}});
    if(onTurn)onTurn(complete);else setImmediate(complete);
    return {turn:{id,status:'inProgress'}};
  }
  throw Error('Unexpected synthetic RPC: '+method);
 };
 t.after(async()=>{client.closing=true;client._connectionFailed(Object.assign(Error('Synthetic fixture closed'),{code:'CODEX_CLOSED'}),child);await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:40})});
 return {client,cwd,dir,calls,child};
}
test('authenticated alone does not attest native host-only support; model-free effective preflight does',async t=>{
 const f=await fixture(t),{client,cwd,calls}=f;
 assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),false);
 assert.equal(client.status().authenticated,true,'Signed in does not imply protected tools.');
 assert.equal(await client.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),true);
 assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),true);
 assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd:path.join(f.dir,'other')}),false);
 assert.equal(client.supportsHostOnlyToolDispatch({model:'other',cwd}),false);
 assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
 assert.equal(calls.filter(x=>x.method==='turn/start').length,0,'Preflight must not infer or execute model.');
 assert.equal(calls.filter(x=>x.method==='thread/unsubscribe').length,1);
 const request=calls.find(x=>x.method==='thread/start').params;
 assert.equal(request.ephemeral,true);assert.equal(request.sandbox,'read-only');assert.deepEqual(request.environments,[]);
 assert.deepEqual(request.selectedCapabilityRoots,[]);assert.equal(request.config['features.shell_tool'],false);
 assert.equal(request.config.plugins.ambient.enabled,false);
 assert.equal(request.config.mcp_servers.ambient.enabled,false);
 client.child={};assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),false,'Proof expires on connection change.');
});
test('failed effective native preflight never claims support or starts a model turn',async t=>{
 const f=await fixture(t,{ignoredFeature:'browser_use'}),{client,cwd,calls}=f;
 await assert.rejects(client.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),{code:'HOST_ONLY_TRANSPORT_UNSUPPORTED'});
 assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),false);
 assert.equal(calls.some(c=>c.method==='turn/start'),false);
 assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,1);
});
test('isolatedHistory:false still runs protected Luna only in ephemeral read-only native sessions',async t=>{
 const f=await fixture(t),{client,cwd,calls}=f;
 assert.equal(client.isolatedHistory,false);
 const runtime=await new ProviderRuntime({codex:client,dataDir:f.dir}).init();
 await runtime.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd});
 const events=[];
 const result=await runtime.runAgent({cwd,model:'gpt-6-luna',prompt:'Synthetic model response',hostOnlyTools:true,
  sandbox:'danger-full-access',dynamicTools:[],onEvent:e=>events.push(e)});
 assert.equal(result.output,'SYNTHETIC_PROTECTED_OK');
 const opens=calls.filter(c=>c.method==='thread/start').map(x=>x.params);
 assert.equal(opens.length,2,'Preflight and real isolated thread are distinct.');
 assert.ok(opens.every(x=>x.ephemeral===true&&x.sandbox==='read-only'));
 assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 assert.ok(calls.findIndex(c=>c.method==='experimentalFeature/list'&&c.params.threadId=== 'thread-2')
  <calls.findIndex(c=>c.method==='turn/start'),'Effective tool restrictions are checked before provider inference.');
 assert.ok(events.some(e=>e.type==='capabilities'&&e.profile==='host-only-task-tools'));
});

function deferOpening(f){
 const original=f.client._request.bind(f.client);
 let release,started;
 const gate=new Promise(resolve=>{release=resolve;});
 const observed=new Promise(resolve=>{started=resolve;});
 f.client._request=(method,params={})=>{
  if(method!=='thread/start')return original(method,params);
  f.calls.push({method,params:structuredClone(params)});
  started();
  return gate.then(()=>({thread:{id:'late-preflight-thread',ephemeral:true},
   sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy}));
 };
 return {release,observed};
}
test('aborted waiter retains a late native thread/start acknowledgment and unsubscribes the accepted ephemeral thread',async t=>{
 const f=await fixture(t),{client,cwd,calls}=f,gate=deferOpening(f),controller=new AbortController();
 const first=client.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd,signal:controller.signal});
 await gate.observed;
 assert.equal(client.hostOnlyPreflights.size,1);
 controller.abort();
 await assert.rejects(first,{code:'ABORT_ERR'});
 assert.equal(client.hostOnlyPreflights.size,1,'Waiter cancellation must not abandon the outstanding thread/start RPC');
 assert.equal(calls.filter(x=>x.method==='thread/unsubscribe').length,0,'The opening acknowledgment has not arrived yet');
 gate.release();
 const pending=[...client.hostOnlyPreflights.values()][0].promise;
 assert.equal(await pending,true);
 assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
 assert.equal(calls.filter(x=>x.method==='thread/unsubscribe').length,1,'Late success must unsubscribe exactly once');
 assert.equal(calls.filter(x=>x.method==='turn/start').length,0);
});
test('two waiters share one native preflight without sharing caller cancellation',async t=>{
 const f=await fixture(t),{client,cwd,calls}=f,gate=deferOpening(f),firstController=new AbortController();
 const first=client.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd,signal:firstController.signal});
 await gate.observed;
 const second=client.ensureHostOnlyToolDispatch({model:'gpt-6-luna',cwd});
 firstController.abort();
 await assert.rejects(first,{code:'ABORT_ERR'});
 assert.equal(client.hostOnlyPreflights.size,1);
 gate.release();
 assert.equal(await second,true,'The second waiter must not inherit the first caller\'s abort signal');
 assert.equal(client.supportsHostOnlyToolDispatch({model:'gpt-6-luna',cwd}),true);
 assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'Only one shared preflight session is created');
 assert.equal(calls.filter(x=>x.method==='thread/unsubscribe').length,1);
 assert.equal(calls.filter(x=>x.method==='turn/start').length,0);
});

const planningScope={taskId:'task1',runId:'run1',nodeId:'agent'};
const planningArtifact={status:'proposed',focus:'route',reason:'Check the failed route',
  actions:[{id:'route',objective:'Inspect the installed route',dependsOn:[]}]};
async function nativePlanningFixture(t,opts={}) {
 const f=await fixture(t,{answer:JSON.stringify({artifact:planningArtifact}),...opts});
 const runtime=await new ProviderRuntime({codex:f.client,dataDir:f.dir}).init();
 const model='gpt-6-luna',events=[],writes=[];
 const pass=createChatPlanningPass({mode:'on',...planningScope,signal:opts.signal,emit:event=>events.push(event),
  assertAdmission:()=>{},read:()=>({taskId:'task1',revision:0,actions:[],receipts:[]}),
  invoke:createChatPlanningProviderInvoker({runtime,model,cwd:f.cwd,...planningScope,assertAdmission:()=>{}}),
  commit:input=>{writes.push(input);return {taskId:'task1',revision:1};}});
 return {...f,run:()=>pass.run(CHAT_PLANNING_MODULES[0].id),events,writes};
}
test('Chat Planning selected-native production adapter reaches exact-model Codex response-only RPC',async t=>{
 const f=await nativePlanningFixture(t);
 assert.equal((await f.run()).status,'completed');
 assert.deepEqual(f.events.map(row=>row.phase),['started','completed']);
 assert.equal(f.writes.length,1);
 const turns=f.calls.filter(row=>row.method==='turn/start').map(row=>row.params), opens=f.calls.filter(row=>row.method==='thread/start').map(row=>row.params);
 assert.equal(turns.length,1,'The native capability preflight does not infer; the module does once.');
 assert.equal(opens.length,2,'One capability preflight and one phase session.');
 assert.equal(turns[0].model,'gpt-6-luna');
 assert.deepEqual(turns[0].sandboxPolicy,{type:'readOnly',networkAccess:false});
 assert.ok(opens.every(row=>row.model==='gpt-6-luna'&&row.allowProviderModelFallback===false&&row.ephemeral===true&&row.dynamicTools===undefined));
 assert.ok(opens.every(row=>row.config['features.shell_tool']===false));
});
test('unsupported selected-native restriction does not start a module turn or write a plan',async t=>{
 const f=await nativePlanningFixture(t,{ignoredFeature:'browser_use'});
 assert.equal((await f.run()).status,'failed');
 assert.equal(f.calls.filter(row=>row.method==='turn/start').length,0);
 assert.equal(f.writes.length,0);
 assert.deepEqual(f.events.map(row=>row.phase),['started','failed']);
});
test('late valid native module artifact after cancel cannot commit',async t=>{
 let notify;
 const started=new Promise(resolve=>notify=resolve),controller=new AbortController();
 const f=await nativePlanningFixture(t,{signal:controller.signal,onTurn:notify});
 const work=f.run(), complete=await started;
 controller.abort();
 complete();
 assert.equal((await work).status,'cancelled');
 assert.equal(f.writes.length,0);
 assert.deepEqual(f.events.map(row=>row.phase),['started','cancelled']);
});
