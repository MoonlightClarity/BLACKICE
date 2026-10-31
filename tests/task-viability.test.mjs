import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { TaskViability, viabilityFingerprint } from '../lib/task-viability.mjs';
import { evaluateViabilityResponse, validateViabilityRequirements } from '../public/task-viability-model.mjs';
import { planningRequestSources } from '../public/planning-browser-model.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const workflow=()=>({id:'fixture-flow',name:'Fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Complete the requested form.',model:'selected-fixture-model',effort:'high',serviceTier:'priority'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'on'}});
const requirement=(overrides={})=>({id:'address',label:'Residential address',importance:'essential',basis:'task',consequence:'Completing the mandatory address field.',resolution:'unknown',value:'',sourceIds:[],checkedSourceIds:['viability:task','viability:profile'],rationale:'The inspected records do not contain the required residential address.',inferable:false,omissionAllowed:false,question:'What residential address should the required form use?',dependentNodeIds:['agent'],...overrides});
const source=(id,text)=>({id,kind:'source',text,contentHash:text});
const fixtureResponse=(requirements,sources)=>({requirements,sources});
const node=request=>request.nodes.find(item=>item.id==='viability');
const ref=request=>({requestId:request.id,responseId:node(request).response.id});
const parsePrompt=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
function output(captured,requirements){
  return JSON.stringify({values:Object.fromEntries(captured.template.fields.map(field=>[field.id,field.label+': a public finding based on the captured fixture records.'])),grounding:captured.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements,openQuestions:[],challengeResponses:[]});
}
async function fixture(t,{findings,attachments,profile='The user has recorded a name but no residential address.',identity,engine}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'task-viability-fixture-'));
  const store=await new PlanningBrowserStore({dataDir:directory}).init(),calls=[];
  const model={runAgent:async options=>{const captured=parsePrompt(options);calls.push({options,captured});const requirements=await(findings?findings(captured,calls):[]);return{output:output(captured,requirements),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length};}};
  const settings={defaultModel:'global-fixture-model',defaultEffort:'low',defaultServiceTier:'default',maxSubagents:2};
  const runner=new PlanningBrowserRuntime({store,runtime:model,defaultCwd:directory,getSettings:()=>settings});
  const resumed=new Map(),resumeCalls=[],runs=new Map();
  const actualEngine=engine||{getRun:id=>{const value=runs.get(id);if(!value)throw Error('missing fixture run');return value;},resumeViabilityRun:(id,value)=>{resumeCalls.push({id,value});if(!resumed.has(value.requestId))resumed.set(value.requestId,{id:'resumed-'+resumed.size,taskId:runs.get(id)?.taskId});return resumed.get(value.requestId);}};
  let currentProfile=profile;
  const service=new TaskViability({store,runner,engine:actualEngine,attachments,identity:identity||{read:async()=>({content:currentProfile})},getSettings:()=>settings});
  t.after(async()=>{await runner.close();await service.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const definition={input:'Complete the form with its mandatory residential address.',cwd:directory,workflow:workflow(),attachmentIds:[]};
  async function request(scope='request',overrides={}){return service.ensure({scope,scopeId:'fixture-'+scope,conversationId:'fixture-conversation',definition,...(scope==='deployment'?{deploymentId:'fixture-deployment'}:{}),...overrides});}
  async function run(){const run={id:'run-a',taskId:'conversation-a',input:definition.input,cwd:directory,workflow:workflow(),attachmentIds:[],planningMode:'on',settled:true};runs.set(run.id,run);const result=await service.forRun(run);run.viability={...result,baseInput:run.input};return {run,request:await store.get(result.requestId)};}
  return{directory,store,runner,service,calls,settings,definition,request,run,runs,resumed,resumeCalls,engine:actualEngine,setProfile:value=>{currentProfile=value;}};
}
const answer=(request,clientRequestId='answer-a',value='123 Fixture Road')=>({requirementId:'address',answer:value,expectedNodeRevision:node(request).revision,expectedResponseId:node(request).response.id,clientRequestId});
const resolveAnswer=captured=>{const found=captured.sources.find(item=>item.id.startsWith('viability:answer:'));return[found?requirement({resolution:'observed',value:found.text,sourceIds:[found.id],checkedSourceIds:captured.sources.map(item=>item.id),rationale:'The user supplied the answer to this exact factual question.',question:''}):requirement()];};

test('typed readiness separates essential facts, supported inference, omission and preferences',()=>{
  const sources=[source('viability:task','Address is mandatory.'),source('viability:profile','Recorded name.')];
  let result=evaluateViabilityResponse(fixtureResponse([requirement()],sources),sources,{workflowNodeIds:['agent']});
  assert.equal(result.state,'awaiting_input');assert.equal(result.blockingFacts[0].id,'address');
  result=evaluateViabilityResponse(fixtureResponse([requirement({importance:'preference',resolution:'unknown'})],sources),sources);
  assert.equal(result.state,'ready');assert.equal(result.preferences.length,1);
  for(const overrides of [{resolution:'inference',value:'Guessed address',sourceIds:['viability:profile']},{resolution:'omission',sourceIds:['viability:task']}])assert.equal(evaluateViabilityResponse(fixtureResponse([requirement(overrides)],sources),sources).state,'needs_evidence');
  assert.equal(evaluateViabilityResponse(fixtureResponse([requirement({resolution:'omission',omissionAllowed:true,sourceIds:['viability:task'],rationale:'The task explicitly permits leaving this field blank.'})],sources),sources).state,'ready');
  assert.throws(()=>validateViabilityRequirements([{ready:true}]),{code:'TASK_VIABILITY_INVALID'});
});

test('an unexamined essential fact is source recovery, not a factual question',()=>{
  const sources=[source('viability:task','Requested form')];
  const result=evaluateViabilityResponse(fixtureResponse([requirement({checkedSourceIds:[]})],sources),sources);
  assert.equal(result.state,'needs_evidence');assert.match(result.issues[0],/Inspect the captured sources/);
  const resume=source('viability:attachment:resume','Supplied résumé has relevant facts.');
  const unread=evaluateViabilityResponse(fixtureResponse([requirement({checkedSourceIds:['viability:task']})],[...sources,resume]),[...sources,resume]);
  assert.equal(unread.state,'needs_evidence');assert.match(unread.issues[0],/all supplied records/);
});

test('real graph capture stays stale after current source change or removal and preserves historical snapshots',async t=>{
  const f=await fixture(t);let request=await f.request();request=await f.service.assess(request.id);
  assert.equal(node(request).readiness.state,'ready');const oldProfile=node(request).response.sources.find(item=>item.id==='viability:profile').text;
  f.setProfile('Changed recorded user facts.');request=await f.service.refreshSources(request,f.definition);
  assert.equal(node(request).readiness.state,'stale');assert.equal(request.sources.find(item=>item.id==='viability:profile').text,'Changed recorded user facts.');
  assert.equal(node(request).response.sources.find(item=>item.id==='viability:profile').text,oldProfile);
  request=await f.service.assess(request.id);assert.equal(node(request).readiness.state,'ready');assert.equal(f.calls.length,2);
  f.setProfile('');request=await f.service.refreshSources(request,f.definition);
  assert.equal(node(request).readiness.state,'stale');assert.ok(!planningRequestSources(request).some(item=>item.id==='viability:profile'));
});

test('same-input concurrent checks and retries admit one configured response worker',async t=>{
  const gate=deferred();const f=await fixture(t,{findings:async()=>{await gate.promise;return[];}});const request=await f.request();
  const first=f.service.assess(request.id),second=f.service.assess(request.id);gate.resolve();await Promise.all([first,second]);await f.service.assess(request.id);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.model,'selected-fixture-model');assert.equal(f.calls[0].options.effort,'high');assert.equal(f.calls[0].options.serviceTier,'priority');assert.equal(f.calls[0].options.responseOnly,true);
});

test('factual answer preserves execution choice and resumes one original intent across uncertain delivery',async t=>{
  const f=await fixture(t,{findings:resolveAnswer});const {run,request}=await f.run();const original=f.engine.resumeViabilityRun;let uncertain=true;
  f.engine.resumeViabilityRun=(...args)=>{const result=original(...args);if(uncertain){uncertain=false;throw Error('Fixture transport failed after continuation was admitted');}return result;};
  f.settings.defaultModel='changed-global-model';f.settings.defaultEffort='low';const payload=answer(request);
  await assert.rejects(f.service.answer(request.id,payload),/transport failed/);const result=await f.service.answer(request.id,payload);
  assert.equal(f.resumed.size,1);assert.equal(result.viabilityAction.resumedRunId,'resumed-0');assert.equal(f.resumed.values().next().value.taskId,run.taskId);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.model,'selected-fixture-model');assert.equal(f.calls[1].options.effort,'high');assert.equal(f.calls[1].options.serviceTier,'priority');
  const replay=await f.service.answer(request.id,payload);assert.equal(replay.viabilityAction.resumedRunId,result.viabilityAction.resumedRunId);assert.equal(f.resumed.size,1);assert.equal(f.calls.length,2);
});

test('concurrent answers cannot launch duplicate continuations or overwrite receipts',async t=>{
  const f=await fixture(t,{findings:resolveAnswer});const {request}=await f.run();
  const results=await Promise.allSettled([f.service.answer(request.id,answer(request,'answer-a')),f.service.answer(request.id,answer(request,'answer-b'))]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(f.resumed.size,1);assert.equal(f.calls.length,2);
  const saved=await f.store.get(request.id);assert.equal(saved.viability.answers.length,1);assert.equal(saved.viability.pendingIntent,null);
});

test('answer rereads actual sources before spending another model turn',async t=>{
  const f=await fixture(t,{findings:resolveAnswer});const {request}=await f.run();f.setProfile('The recorded address is already 88 Saved Lane.');
  await assert.rejects(f.service.answer(request.id,answer(request)),{code:'TASK_VIABILITY_ANSWER_CONFLICT'});assert.equal(f.calls.length,1);assert.equal(f.resumed.size,0);
  assert.equal(node(await f.store.get(request.id)).readiness.state,'stale');
});

test('source refresh and intent completion cannot erase newer binding fields',async t=>{
  const f=await fixture(t);const old=await f.request();const writer=f.store.runtimeWriter();
  await writer.configureViability(old.id,{viability:{answers:[{id:'new-receipt'}],pendingIntent:{id:'new-intent'}}});
  await f.service.refreshSources(old,f.definition);
  const current=await writer.configureViability(old.id,{completeIntentId:'old-intent',viability:{pendingIntent:null,lastAction:{resumedRunId:'older-run'}}});
  assert.equal(current.viability.answers[0].id,'new-receipt');assert.equal(current.viability.pendingIntent.id,'new-intent');assert.equal(current.viability.lastAction,undefined);
});

test('a new answer without a pending intent does not report an older continuation',async t=>{
  const f=await fixture(t,{findings:resolveAnswer});let request=await f.request();request=await f.service.assess(request.id);
  await f.store.runtimeWriter().configureViability(request.id,{viability:{lastAction:{resumedRunId:'old-run'},lastActionReceiptId:'older-receipt'}});
  const result=await f.service.answer(request.id,answer(request));assert.equal(result.viabilityAction,undefined);assert.equal(f.resumed.size,0);
});

test('unreadable, unsupported and empty supplied evidence requests recovery without a provider question',async t=>{
  for(const attachments of [
    {get:async()=>({kind:'image',name:'fixture.png'})},
    {get:async()=>({kind:'text',name:'fixture.txt'}),text:async()=>({text:'  '})},
    {get:async()=>{throw Object.assign(Error('missing stored copy'),{code:'ENOENT'});}},
    {get:async()=>({kind:'pdf',name:'fixture.pdf'}),read:async()=>({pages:[{page:1,text:''}]})}
  ]){
    const f=await fixture(t,{attachments});const request=await f.request('request',{definition:{...f.definition,attachmentIds:['file-a']}});const result=await f.service.assess(request.id);
    assert.equal(f.calls.length,0);assert.equal(node(result).readiness.viability.state,'needs_evidence');assert.match(result.viability.recoveryIssue.code,/^TASK_VIABILITY_SOURCE/);
  }
});

test('full user fact record is used and a damaged canonical record needs recovery',async t=>{
  let reads=0,snapshots=0;const f=await fixture(t,{identity:{read:async()=>{reads++;return{content:'Full facts with a middle address.'};},snapshot:async()=>{snapshots++;return{documents:{user:{content:'truncated',truncated:true}}};}}});
  const request=await f.request();assert.equal(reads,1);assert.equal(snapshots,0);assert.match(request.sources.find(item=>item.id==='viability:profile').text,/middle address/);
  const damaged=await fixture(t,{identity:{read:async()=>({content:'older record',warning:'Current USER.md is invalid.'})}});const recovered=await damaged.request();assert.ok(recovered.viability.recoveryIssue);await damaged.service.assess(recovered.id);assert.equal(damaged.calls.length,0);
});

test('Planning Off admits no check or evidence read',async t=>{
  const f=await fixture(t,{identity:{read:async()=>{throw Error('must not read');}}});
  assert.equal((await f.service.forRun({planningMode:'off'})).skipped,true);assert.equal(f.calls.length,0);assert.equal((await f.store.list()).requests.length,0);
});

test('cancellation during durable attempt admission settles without pumping a provider',async t=>{
  const f=await fixture(t);const request=await f.request(),controller=new AbortController(),begin=f.store.beginAttempt.bind(f.store);
  f.store.beginAttempt=async(...args)=>{const result=await begin(...args);controller.abort();return result;};
  await assert.rejects(f.service.assess(request.id,{signal:controller.signal}),error=>error.name==='AbortError');assert.equal(f.calls.length,0);
  assert.equal((await f.store.get(request.id)).attempts.at(-1).status,'cancelled');
});

test('deployment readiness binds exact identity and holds graph edits through admission',async t=>{
  const f=await fixture(t);let request=await f.request('deployment');request=await f.service.assess(request.id);
  const definition={...f.definition,id:'fixture-deployment',viabilityRef:ref(request)};assert.equal(viabilityFingerprint(definition),request.viability.fingerprint);
  await assert.rejects(f.service.assertDeployment({...definition,id:'another-deployment'}),{code:'TASK_VIABILITY_STALE'});
  const entered=deferred(),release=deferred();let changed=false;
  const admission=f.service.withDeployment(definition,async()=>{entered.resolve();await release.promise;return 'admitted';});await entered.promise;
  const edit=f.store.runtimeWriter().configureViability(request.id,{sources:[{id:'viability:profile',kind:'source',text:'Changed while admitting.'}]}).then(()=>{changed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(changed,false);release.resolve();assert.equal(await admission,'admitted');await edit;assert.equal(node(await f.store.get(request.id)).readiness.state,'stale');
});

test('supervising factual answers retain caller provenance and can defer original continuation to cycle checks',async t=>{
  const f=await fixture(t,{findings:resolveAnswer}),{request}=await f.run(),payload=answer(request),actor={type:'agent',id:'supervisor-run:worker'};
  const checked=await f.service.answer(request.id,payload,{actor,deferContinuation:true});
  assert.equal(node(checked).readiness.state,'ready');assert.equal(f.resumed.size,0);assert.ok(checked.viability.pendingIntent);
  const source=checked.sources.find(item=>item.id.startsWith('viability:answer:'));assert.equal(source.kind,'source');assert.match(source.title,/^Supervising model answer:/);assert.deepEqual(checked.viability.answers[0].authoredBy,actor);
  await f.service.answer(request.id,payload,{actor,deferContinuation:true});assert.equal(f.calls.length,2);assert.equal(f.resumed.size,0);
  await assert.rejects(f.service.answer(request.id,payload,{actor:{type:'external-agent',id:'different-caller'},deferContinuation:true}),{code:'TASK_VIABILITY_IDEMPOTENCY_CONFLICT'});
});
