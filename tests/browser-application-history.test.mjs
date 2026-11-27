import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserToolHandler } from '../lib/browser.mjs';
import { applicationTarget } from '../lib/application-history.mjs';
import { AttachmentStore } from '../lib/attachments.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { IdentityStore } from '../lib/identity.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';


function syntheticOutcomeAssessment(request,expectedInput,workerRequest){
 const prompt=request.messages?.find(message=>typeof message.content==='string'&&message.content.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW'))?.content;
 if(!prompt)return null;
 const {snapshot}=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
 assert.equal(snapshot.request,expectedInput,'the readonly assessment retains the unchanged ordinary request');
 assert.equal(request.model,workerRequest.model,'assessment uses the same model as the worker');
 assert.equal(request.reasoning_effort,workerRequest.reasoning_effort,'assessment preserves the worker effort');
 assert.deepEqual(request.tools||[],[],'these small inline-evidence fixtures expose no reviewer action tools');
 // This explicit mock disposition exercises transport, not model judgment or
 // a real application outcome. All original worker/history assertions remain.
 return {decision:'respond',summary:'Synthetic transport assessment. No real application outcome is claimed.',
  remaining:[],nextAction:'',evidenceRefs:snapshot.evidence.records.length?[snapshot.evidence.records.at(-1).citationRef]:['user-request'],blockers:[]};
}

const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const url='https://jobs.ashbyhq.com/exampleco/'+first,other='https://jobs.ashbyhq.com/exampleco/'+second;
const task='Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.';
const coverage='selected-workspace-supported-ledgers-direct-application-history-and-legacy-claims-only';

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
function browserFixture({observedUrl,formLabel}={}){
 const calls=[];let current,owner;
 return {calls,
  status:()=>({available:true,contained:true,tabs:current?[{tabId:'history-tab',url:current,documentId:'history-document',...(owner?{owner}:{})}]:[]}),
  async perform(args,context={}){
   calls.push({...args});owner=context.owner||owner;current=observedUrl||args.url||current;
   return {tabId:'history-tab',url:current,title:'Research Specialist | ExampleCo',documentId:'history-document',
    ...(args.action==='click'?{actionDispatched:true}:{}),
    frames:[{frameId:'main',documentId:'history-document',url:current,readyState:'complete',observation:'content-observed',text:'Current page.',
      forms:formLabel?[{action:current,method:'post',fields:[{name:'role',type:'select-one'}]}]:[],
      elements:formLabel?[{tag:'button',type:'submit',role:'button',name:formLabel,disabled:false}]:[]}]};
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
 const f=await temporary(),source=await history(f),requests=[],assessments=[],allRequests=[],browser=browserFixture();
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
  let raw='';for await(const chunk of req)raw+=chunk;
  const request=JSON.parse(raw);allRequests.push(request);
  const assessment=syntheticOutcomeAssessment(request,task,requests.at(-1));
  if(assessment){assessments.push(request);return res.end(JSON.stringify(reply({content:JSON.stringify(assessment)})));}
  requests.push(request);
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
 const attachments=await new AttachmentStore({dataDir}).init();
 const ledger=await attachments.importBytes({name:'external_application_history.json',bytes:Buffer.from(JSON.stringify({entries:[
  {url,state:'confirmed'},
  {url:other,state:'confirmed'},
  {url,state:'draft'},
 ]}))});
 const unattached=await attachments.importBytes({name:'unattached_application_history.json',bytes:Buffer.from(JSON.stringify({url,status:'submitted'}))});
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:f.cwd,identity,browser,attachments}).init();
 const workflow=createMissionWorkflow({id:'mission_chat_history_fixture',task,cwd:f.cwd,model:'fixture::fixture',planningMode:'off'});
 const start=engine.startRun({workflow,input:{task,cwd:f.cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off',attachmentIds:[ledger.id]}});
 await engine.executions.get(start.id);const run=engine.getRun(start.id);
 assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
 assert.equal(run.input,task);
 assert.equal(requests.length,3,'all original worker requests remain');
 assert.equal(assessments.length,1,'one explicit read-only outcome assessment');
 assert.equal(allRequests.length,4,'every provider call is accounted for');
 assert.equal(run.events.filter(row=>row.data?.type==='chat.outcome-review'&&row.data.status==='validated').length,1);
 assert.equal(browser.calls.length,1);
 const delivered=requests[1].messages.find(message=>message.role==='tool');
 assert.ok(delivered,'the provider receives the actual browser tool result');
 const observed=JSON.parse(delivered.content);
 assert.equal(observed.applicationHistory.workspace,f.cwd,'the engine wires the actual run cwd');
 assert.equal(observed.applicationHistory.target.key,applicationTarget(url).key);
 assert.deepEqual(observed.applicationHistory.matches,[{source:source.name,record:241,reason:'reported-prior-requisition'}]);
 assert.deepEqual(observed.applicationHistory.attached.sources,[{id:ledger.id,name:'external_application_history.json'}]);
 assert.deepEqual(observed.applicationHistory.attached.matches,[{id:ledger.id,source:'external_application_history.json',record:1,reason:'reported-prior-requisition'}]);
 assert.deepEqual(observed.applicationHistory.attached.errors,[]);
 assert.ok(!delivered.content.includes(unattached.id),'unattached reports never enter the tool result');
 assert.ok(allRequests.every(request=>JSON.stringify(request.messages).includes(task)),'the task prompt stays unchanged');
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
});

const customPage='https://careers.fixture.invalid/careers';
const customUrl=customPage+'?access_token=private-query#private-fragment';
async function customHistory(f){
 const name='applications_custom.jsonl';
 const rows=Array.from({length:240},()=>({url:'https://elsewhere.invalid/careers',status:'draft'}));
 rows.push({url:customUrl,employer:'ExampleCo',role:'Research Analyst',status:'submitted_confirmed'});
 rows.push({url:customPage,employer:'ExampleCo',role:'Training Specialist',status:'uncertain'});
 const content=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
 await writeFile(path.join(f.cwd,name),content);
 return {name,content};
}

test('custom application browser observations deliver stable sanitized related history without gating',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());const source=await customHistory(f);
 const browser=browserFixture({observedUrl:customUrl,formLabel:'Submit application'}),handler=createBrowserToolHandler({browser,cwd:f.cwd});
 const first=body(await handler(call('custom-open',{action:'open',url:customUrl}))),facts=first.applicationHistory;
 assert.ok(facts,'observed custom application forms receive normal local history');
 assert.equal(facts.target.kind,'application-page-context');
 assert.equal(facts.target.precision,'origin-and-path-context-only');
 assert.equal(facts.target.url,customPage);
 assert.equal(facts.target.observedUrl,customPage);
 assert.equal(Object.hasOwn(facts.target,'key'),false);
 assert.equal(Object.hasOwn(facts.target,'employer'),false);
 assert.equal(facts.basis,'reported-local-history');
 assert.equal(facts.coverage,coverage);
 assert.deepEqual(facts.matches,[]);
 assert.deepEqual(facts.related.map(row=>({source:row.source,record:row.record,role:row.reported.role})),[
  {source:source.name,record:241,role:'Research Analyst'},{source:source.name,record:242,role:'Training Specialist'}
 ]);
 assert.equal(facts.relatedTruncated,false);
 assert.doesNotMatch(JSON.stringify(facts),/private-query|private-fragment/);
 assert.deepEqual(body(await handler(call('custom-repeat',{action:'snapshot',tabId:'history-tab'}))).applicationHistory,facts);
 const submitted=await handler(call('custom-explicit-action',{action:'click',tabId:'history-tab',ref:'submit',expectedDocumentId:'history-document',expectedUrl:customUrl}));
 assert.equal(submitted.success,true,'context never creates a duplicate or permission gate, including explicit reapplication');
 assert.equal(browser.calls.length,3);
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
 assert.deepEqual(await readdir(f.cwd),[source.name]);
});

test('custom application history is absent on contact login and bare Apply forms',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());await customHistory(f);
 for(const formLabel of ['Send message','Sign in','Apply','Apply now','Submit']){
  const browser=browserFixture({observedUrl:customUrl,formLabel}),handler=createBrowserToolHandler({browser,cwd:f.cwd});
  const result=body(await handler(call('unrelated-'+formLabel,{action:'open',url:customUrl})));
  assert.equal(Object.hasOwn(result,'applicationHistory'),false,formLabel);
  assert.equal(browser.calls.length,1);
 }
});

test('ordinary engine Chat delivers custom application history through the actual compatible browser response',{timeout:20000},async t=>{
 const f=await temporary(),source=await customHistory(f),requests=[],assessments=[],allRequests=[],browser=browserFixture({observedUrl:customUrl,formLabel:'Submit application'});
 let engine,runtime,identity;
 const reply=message=>({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]});
 const final='Fixture page observed. No application outcome is claimed.';
 const script=[
  reply({content:null,tool_calls:[{id:'open-custom-form',type:'function',function:{name:'relay_browser',arguments:JSON.stringify({browser:'relay',action:'open',url:customUrl})}}]}),
  reply({content:final}),reply({content:final})
 ];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET')return res.end(JSON.stringify({data:[{id:'fixture'}]}));
  let raw='';for await(const chunk of req)raw+=chunk;
  const request=JSON.parse(raw);allRequests.push(request);
  const assessment=syntheticOutcomeAssessment(request,task,requests.at(-1));
  if(assessment){assessments.push(request);return res.end(JSON.stringify(reply({content:JSON.stringify(assessment)})));}
  requests.push(request);
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
 const workflow=createMissionWorkflow({id:'mission_chat_custom_history_fixture',task,cwd:f.cwd,model:'fixture::fixture',planningMode:'off'});
 const start=engine.startRun({workflow,input:{task,cwd:f.cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off'}});
 await engine.executions.get(start.id);const run=engine.getRun(start.id);
 assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
 assert.equal(run.input,task);
 assert.equal(requests.length,3,'all original worker requests remain');
 assert.equal(assessments.length,1,'one explicit read-only outcome assessment');
 assert.equal(allRequests.length,4,'every provider call is accounted for');
 assert.equal(run.events.filter(row=>row.data?.type==='chat.outcome-review'&&row.data.status==='validated').length,1);
 assert.equal(browser.calls.length,1);
 const delivered=requests[1].messages.find(message=>message.role==='tool');
 assert.ok(delivered);
 const facts=JSON.parse(delivered.content).applicationHistory;
 assert.ok(facts,'custom context reaches the provider without a requested history lookup');
 assert.equal(facts.workspace,f.cwd);
 assert.equal(facts.target.kind,'application-page-context');
 assert.deepEqual(facts.matches,[]);
 assert.deepEqual(facts.related.map(row=>row.record),[241,242]);
 assert.ok(facts.related.every(row=>row.source===source.name));
 assert.doesNotMatch(JSON.stringify(facts),/private-query|private-fragment/);
 assert.ok(allRequests.every(request=>JSON.stringify(request.messages).includes(task)),'the ordinary task bytes stay unchanged');
 assert.equal(await readFile(path.join(f.cwd,source.name),'utf8'),source.content);
});

test('observed ATS target reads one conventional history child of only the pinned workspace',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());
 const child=path.join(f.cwd,'Application History');
 const deeper=path.join(child,'Application History');
 const sibling=path.join(f.directory,'Application History');
 await mkdir(deeper,{recursive:true});await mkdir(sibling);
 const name='ExampleCo-'+first+'.json';
 await Promise.all([
  writeFile(path.join(child,name),JSON.stringify([
   {applicationUrl:url,status:'confirmed',evidence:'PRIVATE BODY'},
   {applicationUrl:url,status:'unknown'},
   {applicationUrl:url.replace('/exampleco/','/differentco/'),status:'confirmed',employer:'ExampleCo',role:'Research Specialist'},
   {employer:'ExampleCo',role:'Research Specialist',status:'confirmed'},
  ])),
  writeFile(path.join(deeper,'applications_deep.json'),JSON.stringify({applicationUrl:url,status:'submitted'})),
  writeFile(path.join(sibling,'applications_sibling.json'),JSON.stringify({applicationUrl:url,status:'submitted'})),
  writeFile(path.join(f.cwd,name),JSON.stringify({applicationUrl:url,status:'submitted'})),
 ]);
 for (const selected of [f.cwd,child]) {
  const browser=browserFixture(), handler=createBrowserToolHandler({browser,cwd:selected});
  const result=await handler(call('observe-exact',{action:'open',url}));
  assert.equal(result.success,true);
  const facts=body(result).applicationHistory;
  const source=(selected===child?'':'Application History/')+name;
  assert.equal(facts.workspace,selected);
  assert.deepEqual(facts.sources,[source]);
  assert.deepEqual(facts.matches,[
   {source,record:1,reason:'reported-prior-requisition',reportedStatus:'confirmed'},
   {source,record:2,reason:'reported-prior-requisition',reportedStatus:'unknown'},
  ]);
  assert.equal(facts.scanComplete,true);
  assert.equal(facts.scope.applicationHistoryFolder,selected===child?'selected-workspace':'listed-direct-child');
  assert.equal(facts.matchesTruncated,false);
  assert.doesNotMatch(JSON.stringify(facts),/PRIVATE BODY/);
  assert.equal(browser.calls.length,1);
 }
});

test('history lookup does not follow a linked child or report refused scope as complete',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());
 const sibling=path.join(f.directory,'elsewhere');await mkdir(sibling);
 await writeFile(path.join(sibling,'applications_linked.json'),JSON.stringify({applicationUrl:url,status:'submitted'}));
 const linked=path.join(f.cwd,'Application History');
 try { await symlink(sibling,linked,process.platform==='win32'?'junction':'dir'); }
 catch (error) { if (!['EPERM','EACCES','ENOSYS'].includes(error.code)) throw error; return t.skip('Directory links unavailable on this executor'); }
 const handler=createBrowserToolHandler({browser:browserFixture(),cwd:f.cwd});
 const result=await handler(call('observe-incomplete',{action:'open',url}));
 const facts=body(result).applicationHistory;
 assert.equal(result.success,true);
 assert.equal(facts.scanComplete,false);
 assert.equal(facts.scope.applicationHistoryFolder,'skipped');
 assert.ok(facts.errors.includes('application-history-folder-not-one-direct-directory'));
 assert.deepEqual(facts.sources,[]);
 assert.deepEqual(facts.matches,[]);
});

test('history collection distinguishes an incomplete scope from truncated matches',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());
 const child=path.join(f.cwd,'Application History');await mkdir(child);
 const handler=createBrowserToolHandler({browser:browserFixture(),cwd:f.cwd});
 const malformed=path.join(child,'applications_bad.json');
 await writeFile(malformed,'{');
 let facts=body(await handler(call('bad-input',{action:'open',url}))).applicationHistory;
 assert.equal(facts.scope.applicationHistoryFolder,'listed-direct-child');
 assert.deepEqual(facts.errors,['Application History/applications_bad.json']);
 assert.equal(facts.scanComplete,false);
 assert.equal(facts.matchesTruncated,false);
 assert.deepEqual(facts.matches,[]);
 await writeFile(malformed,JSON.stringify(Array.from({length:41},()=>({applicationUrl:url,status:'submitted'}))));
 facts=body(await handler(call('bounded-lookup',{action:'open',url}))).applicationHistory;
 assert.equal(facts.scanComplete,true);
 assert.equal(facts.matchesTruncated,true);
 assert.equal(facts.matches.length,40);
 assert.deepEqual(facts.errors,[]);
});


test('an explicitly attached immutable application ledger discloses the exact prior iCIMS requisition from a separate workspace',async t=>{
 const f=await temporary();t.after(()=>f.cleanup());
 const store=await new AttachmentStore({dataDir:path.join(f.directory,'data')}).init();
 const prior='https://careers-navitus.icims.com/jobs/7200/customer-market-intelligence-analyst/job?mode=submit_apply';
 const observed='https://careers-navitus.icims.com/jobs/7200/customer-market-intelligence-analyst/job';
 const unrelated='https://careers-navitus.icims.com/jobs/7092/regulatory-analyst/job';
 const ledger=await store.importBytes({name:'application_history.json',bytes:Buffer.from(JSON.stringify({entries:[
   {employer:'Lumicera Health Services (Navitus)',state:'confirmed',url:prior},
   {employer:'Navitus',state:'confirmed',url:unrelated},
   {employer:'Navitus',state:'draft',url:prior},
 ]}))});
 await store.importBytes({name:'unattached_application_history.json',bytes:Buffer.from(JSON.stringify({url:prior,status:'submitted'}))});
 const browser=browserFixture(), handler=createBrowserToolHandler({browser,cwd:f.cwd,attachedApplicationHistory:{store,ids:[ledger.id]}});
 const observedHistory=body(await handler(call('open',{action:'open',url:observed}))).applicationHistory;
 assert.deepEqual(observedHistory.matches,[],'selected workspace did not include the ledger');
 assert.deepEqual(observedHistory.attached.sources,[{id:ledger.id,name:'application_history.json'}]);
 assert.deepEqual(observedHistory.attached.matches,[{id:ledger.id,source:'application_history.json',record:1,reason:'reported-prior-requisition'}]);
 assert.deepEqual(observedHistory.attached.errors,[]);
 assert.equal(browser.calls.length,1);
});
