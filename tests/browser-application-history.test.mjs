import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserToolHandler } from '../lib/browser.mjs';
import { applicationTarget } from '../lib/application-history.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { IdentityStore } from '../lib/identity.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const url='https://jobs.ashbyhq.com/exampleco/'+first,other='https://jobs.ashbyhq.com/exampleco/'+second;
const task='Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.';
const coverage='supported-top-level-workspace-history-and-legacy-claims-only';

async function temporary(){
 const root=await realpath(tmpdir()),directory=await mkdtemp(path.join(root,'blackice-browser-history-')),cwd=path.join(directory,'workspace');
 await mkdir(cwd);
 return {directory,cwd,async cleanup(){
  const actual=await realpath(directory);assert.equal(path.dirname(actual),root);assert.match(path.basename(actual),/^blackice-browser-history-/);
  await rm(actual,{recursive:true,force:true});
 }};
}
async function history(f){
 const name='applications_earlier.jsonl';
 const rows=Array.from({length:240},()=>({url:other,status:'draft'}));
 rows.push({url,status:'submitted_confirmed',observedAtUTC:'2026-01-03T04:05:06Z',evidence:'Employer application receipt was observed.'});
 const content=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
 await writeFile(path.join(f.cwd,name),content);
 return {name,content};
}
function browserFixture({observedUrl}={}){
 const calls=[];let current,owner;
 return {calls,
  status:()=>({available:true,contained:true,tabs:current?[{tabId:'history-tab',url:current,documentId:'history-document',...(owner?{owner}:{})}]:[]}),
  async perform(args,context={}){
   calls.push({...args});owner=context.owner||owner;current=observedUrl||args.url||current;
   return {tabId:'history-tab',url:current,title:'Research Specialist | ExampleCo',documentId:'history-document',
    ...(args.action==='click'?{actionDispatched:true}:{}),
    frames:[{frameId:'main',documentId:'history-document',url:current,readyState:'complete',observation:'content-observed',text:'Current page.',elements:[]}]};
  },
 };
}
const call=(id,args)=>({name:'relay_browser',callId:id,arguments:{browser:'relay',...args}});
const body=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);

test('actual recognized browser observations include full-file prior reports beyond the first history page',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());const source=await history(f),browser=browserFixture();
 const handler=createBrowserToolHandler({browser,cwd:f.cwd});
 const result=await handler(call('open',{action:'open',url})),observed=body(result),facts=observed.applicationHistory;
 assert.equal(result.success,true);
 assert.ok(facts,'history facts are attached without the model requesting a history file');
 assert.equal(facts.target.key,applicationTarget(url).key);
 assert.equal(facts.target.observedUrl,observed.url);
 assert.equal(facts.workspace,f.cwd);
 assert.equal(facts.basis,'reported-local-history');
 assert.equal(facts.coverage,coverage);
 assert.deepEqual(facts.errors,[]);
 assert.deepEqual(facts.sources,[source.name]);
 assert.deepEqual(facts.matches,[{source:source.name,record:241,reason:'reported-prior-requisition'}]);
 assert.equal(Object.hasOwn(facts,'eligible'),false);
 assert.equal(Object.hasOwn(facts,'nativeConfirmation'),false);
 assert.equal(browser.calls.length,1,'history lookup performs no extra browser action');
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
 assert.deepEqual(await readdir(f.cwd),[source.name],'no history, index, claim or lock file is written');
});

test('history metadata is stable across repeated observations and distinguishes exact requisitions',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());await history(f);const browser=browserFixture(),handler=createBrowserToolHandler({browser,cwd:f.cwd});
 const firstResult=body(await handler(call('first',{action:'open',url})));
 const repeated=body(await handler(call('repeat',{action:'snapshot',tabId:'history-tab'})));
 assert.ok(firstResult.applicationHistory);
 assert.deepEqual(repeated.applicationHistory,firstResult.applicationHistory,'unchanged source data must not manufacture new review evidence');
 const distinct=body(await handler(call('different',{action:'navigate',tabId:'history-tab',url:other})));
 assert.equal(distinct.applicationHistory.target.key,applicationTarget(other).key);
 assert.deepEqual(distinct.applicationHistory.matches,[],'a different requisition is not a duplicate of the confirmed target');
 assert.equal(distinct.applicationHistory.coverage,coverage,'no match is scoped to the inspected workspace records');
});

test('lookup uses the actual observed page URL and does not attach history to unrelated destinations',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());await history(f);
 const unrelated=browserFixture({observedUrl:'https://fixture.invalid/careers'}),unrelatedHandler=createBrowserToolHandler({browser:unrelated,cwd:f.cwd});
 const redirected=body(await unrelatedHandler(call('redirected',{action:'open',url})));
 assert.equal(redirected.url,'https://fixture.invalid/careers');
 assert.equal(Object.hasOwn(redirected,'applicationHistory'),false);
 const actual=browserFixture({observedUrl:url}),actualHandler=createBrowserToolHandler({browser:actual,cwd:f.cwd});
 const arrived=body(await actualHandler(call('arrived',{action:'open',url:'https://fixture.invalid/redirect'})));
 assert.equal(arrived.applicationHistory.target.key,applicationTarget(url).key);
 const unscoped=createBrowserToolHandler({browser:browserFixture()});
 assert.equal(Object.hasOwn(body(await unscoped(call('without-cwd',{action:'open',url}))),'applicationHistory'),false);
});

test('malformed or unavailable history remains explicit metadata and never vetoes browser dispatch',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());const source=await history(f);
 await writeFile(path.join(f.cwd,'applications_broken.json'),'{invalid');
 const browser=browserFixture(),handler=createBrowserToolHandler({browser,cwd:f.cwd});
 const opened=await handler(call('open',{action:'open',url}));
 assert.equal(opened.success,true);
 assert.deepEqual(body(opened).applicationHistory.errors,['applications_broken.json']);
 assert.ok(body(opened).applicationHistory.matches.some(row=>row.source===source.name));
 const submitted=await handler(call('explicit-action',{action:'click',tabId:'history-tab',ref:'submit',expectedDocumentId:'history-document',expectedUrl:url}));
 assert.equal(submitted.success,true,'imported prior reports do not grant or deny actions, including explicit reapplication');
 assert.equal(browser.calls.length,2);
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
 const missing=createBrowserToolHandler({browser:browserFixture(),cwd:path.join(f.directory,'unavailable')});
 const observed=await missing(call('missing-workspace',{action:'open',url}));
 assert.equal(observed.success,true);
 assert.deepEqual(body(observed).applicationHistory.errors,['workspace-unreadable']);
});

class NoNative extends EventEmitter{
 status(){return {connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){assert.fail('This fixture cannot call a live model.');}
}
test('ordinary engine Chat delivers history facts in the real compatible browser tool response',{timeout:20000},async t=>{
 const f=await temporary(),source=await history(f),requests=[],browser=browserFixture();
 let engine,runtime,identity;
 const reply=message=>({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]});
 const final='Fixture page observed. No application outcome is claimed.';
 const script=[
  reply({content:null,tool_calls:[{id:'open-role',type:'function',function:{name:'relay_browser',arguments:JSON.stringify({browser:'relay',action:'open',url})}}]}),
  reply({content:final}),reply({content:final}),
 ];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET')return res.end(JSON.stringify({data:[{id:'fixture'}]}));
  let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
  const response=script[requests.length-1];
  if(!response){res.statusCode=500;return res.end(JSON.stringify({error:{message:'Unexpected fixture request'}}));}
  res.end(JSON.stringify(response));
 });
 t.after(async()=>{
  await engine?.close();await runtime?.close();await identity?.close();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));await f.cleanup();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime=new ProviderRuntime({codex:new NoNative(),dataDir:path.join(f.directory,'provider'),modelLimitResolver:{enrich:async(_config,model)=>model}});
 await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
 const dataDir=path.join(f.directory,'engine');identity=await new IdentityStore({dataDir}).init();
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:f.cwd,identity,browser}).init();
 const workflow=createMissionWorkflow({id:'mission_chat_history_fixture',task,cwd:f.cwd,model:'fixture::fixture',planningMode:'off'});
 const start=engine.startRun({workflow,input:{task,cwd:f.cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off'}});
 await engine.executions.get(start.id);const run=engine.getRun(start.id);
 assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
 assert.equal(run.input,task);
 assert.equal(requests.length,3);
 assert.equal(browser.calls.length,1);
 const delivered=requests[1].messages.find(message=>message.role==='tool');
 assert.ok(delivered,'the provider receives the actual browser tool result');
 const observed=JSON.parse(delivered.content);
 assert.equal(observed.applicationHistory.workspace,f.cwd,'the engine wires the actual run cwd');
 assert.equal(observed.applicationHistory.target.key,applicationTarget(url).key);
 assert.deepEqual(observed.applicationHistory.matches,[{source:source.name,record:241,reason:'reported-prior-requisition'}]);
 assert.ok(requests.every(request=>JSON.stringify(request.messages).includes(task)),'the task prompt stays unchanged');
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
});
