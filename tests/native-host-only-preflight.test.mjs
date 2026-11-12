import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexRuntime} from '../lib/codex.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES} from '../lib/response-profile.mjs';

async function fixture(t,{ignoredFeature}={}){
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
  if(method==='thread/unsubscribe')return {};
  if(method==='turn/start'){
    const id='turn-'+next;
    setImmediate(()=>client._notification('turn/completed',{threadId:params.threadId,
      turn:{id,status:'completed',items:[{type:'agentMessage',id:'synthetic-answer',phase:'final_answer',text:'SYNTHETIC_PROTECTED_OK'}]}}));
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
