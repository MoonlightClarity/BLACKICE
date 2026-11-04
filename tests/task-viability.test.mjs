import test from 'node:test';
import {fixtureUserAgency,fixtureAskingUserAgency} from './fixture-user-agency.mjs';
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
  const missing=requirements.find(item=>item.id==='address'&&item.importance==='essential'&&item.resolution==='unknown'&&item.question);
  return JSON.stringify({userAgency:missing?fixtureAskingUserAgency(missing.question):fixtureUserAgency(),values:Object.fromEntries(captured.template.fields.map(field=>[field.id,field.label+': a public finding based on the captured fixture records.'])),grounding:captured.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements,openQuestions:[],challengeResponses:[]});
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

test('duplicate evidence citations canonicalize without weakening type, capacity or provenance checks',()=>{
  const sources=[source('viability:task','The saved criteria can be checked by the owner.'),source('viability:profile','The user supplied background for the form.')];
  const repeated=requirement({id:'saved_records',label:'Read saved criteria',resolution:'repairable',value:'The owner can read saved records before selecting roles.',sourceIds:['viability:task','viability:task'],checkedSourceIds:['viability:task','viability:profile','viability:task','viability:profile'],rationale:'Read the existing records; an identical citation adds no proof.',question:''});
  const [normalized]=validateViabilityRequirements([repeated]);
  assert.deepEqual(normalized.sourceIds,['viability:task']);
  assert.deepEqual(normalized.checkedSourceIds,['viability:task','viability:profile']);
  const result=evaluateViabilityResponse(fixtureResponse([repeated],sources),sources,{workflowNodeIds:['agent']});
  assert.equal(result.state,'ready');
  assert.equal(result.repairableGaps.length,1);
  assert.throws(()=>validateViabilityRequirements([{...repeated,checkedSourceIds:['viability:task',null]}]),{code:'TASK_VIABILITY_INVALID'});
  assert.throws(()=>validateViabilityRequirements([{...repeated,checkedSourceIds:Array(101).fill('viability:task')}]),{code:'TASK_VIABILITY_INVALID'});
  const unsupported={...repeated,sourceIds:['missing-source','missing-source']};
  assert.equal(evaluateViabilityResponse(fixtureResponse([unsupported],sources),sources).state,'needs_evidence','canonicalizing a repeated reference does not establish its source provenance');
});

test('resource findings distinguish confirmed blockers, autonomous repairs and misleading symptoms without manufacturing facts',()=>{
  const sources=[source('viability:task','Complete the delegated result under existing rights; ordinary terms and a needed user-level installation are already authorized. The actual protected target denied the requested write.'),source('viability:workflow','The owning workflow can inspect and repair its authorized target.')];
  const resource=resolution=>requirement({id:'resource',label:'Required utility',resolution,...(resolution==='blocked'?{stopKind:'target_denied'}:{}),value:resolution==='blocked'?'The actual target denies the required write right.':'The needed utility is absent; the authorized user-level setup route is available.',sourceIds:['viability:task'],checkedSourceIds:sources.map(item=>item.id),rationale:resolution==='blocked'?'The affected write must wait for an authorized right or alternate supported route; continue the independent summary.':'Inspect existing inventory, install only if absent using the authorized route, and verify the destination before the costly dependent operation.',question:''});
  const untyped={...resource('blocked')};delete untyped.stopKind;
  const untypedResult=evaluateViabilityResponse(fixtureResponse([untyped],sources),sources,{workflowNodeIds:['agent']});
  assert.equal(untypedResult.state,'ready','generic concerns must not manufacture a stop');
  assert.equal(untypedResult.unverifiedStopClaims.length,1);
  const blocked=evaluateViabilityResponse(fixtureResponse([resource('blocked')],sources),sources,{workflowNodeIds:['agent']});
  assert.equal(blocked.state,'blocked');assert.equal(blocked.analysisReady,true);assert.equal(blocked.blockingFacts[0].dependentNodeIds[0],'agent');assert.match(blocked.blockingFacts[0].remedy,/alternate supported route/);
  const repair=evaluateViabilityResponse(fixtureResponse([resource('repairable')],sources),sources,{workflowNodeIds:['agent']});
  assert.equal(repair.state,'ready');assert.equal(repair.blockingFacts.length,0);assert.equal(repair.repairableGaps.length,1);assert.match(repair.repairableGaps[0].remedy,/verify the destination/);
  const misleading=evaluateViabilityResponse(fixtureResponse([resource('nonblocking')],sources),sources,{workflowNodeIds:['agent']});assert.equal(misleading.state,'ready');assert.equal(misleading.nonblockingSymptoms.length,1);
  const unsupported=resource('blocked');unsupported.sourceIds=[];assert.equal(evaluateViabilityResponse(fixtureResponse([unsupported],sources),sources).state,'needs_evidence','An unsupported obstacle claim cannot masquerade as a confirmed blocker.');
});

test('only unchanged current host-consumed upstream responses support feasibility, without self or historical response invalidation loops',()=>{
  const base=source('viability:task','Complete the existing browser verification; preserve installed work and repair the failed observation.');
  const upstream={id:'response:intent-a',kind:'response',responseId:'intent-a',revision:1,text:'{"values":{"userBenefit":"Offload routine verification."}}',contentHash:'intent-body-hash',provenance:{kind:'runtime',attemptId:'intent-attempt',contentHash:'intent-body-hash'}};
  const binding={nodeId:'inference-node',responseId:'intent-a',responseRevision:1};
  const req=requirement({id:'browser_observations',label:'Current browser evidence',resolution:'repairable',value:'Current keyed settings remain to be inspected by the operational owner.',sourceIds:[base.id,upstream.id],checkedSourceIds:[base.id,upstream.id],rationale:'Perform the authorized compact read and inspect its actual result rather than handing the failed observation back.',question:''});
  const recorded={id:'feasibility-response',nodeId:'feasibility-node',requirements:[req],sources:[base,upstream],inputs:[binding]};
  const evaluate=(response=recorded,sources=[base,upstream],bindings=[binding])=>evaluateViabilityResponse(response,sources,{workflowNodeIds:['agent'],upstreamResponses:bindings});
  assert.equal(evaluate().state,'ready');assert.equal(evaluate().repairableGaps.length,1);
  assert.equal(evaluate(recorded,[base,upstream],[]).analysisReady,false,'A response in the catalog alone is not an allowed upstream input.');
  assert.equal(evaluate({...recorded,inputs:[]}).analysisReady,false,'A claimed prerequisite must also have an actual captured consumed input.');
  assert.equal(evaluate({...recorded,inputs:[{nodeId:'parent',responseId:'parent',responseRevision:1,subtree:[binding]}]}).state,'ready','Exact host-captured subtree bindings remain supported.');
  assert.equal(evaluate(recorded,[base,upstream],[{...binding,responseId:'intent-b',responseRevision:2}]).analysisReady,false,'A superseded intent remains unusable even while its historical source stays in the catalog.');
  for(const changed of [{...upstream,text:'Altered claim.'},{...upstream,revision:2},{...upstream,provenance:{...upstream.provenance,attemptId:'different-attempt'}},{...upstream,kind:'source'}])assert.equal(evaluate(recorded,[base,changed]).analysisReady,false,'Changed source identity or provenance remains held.');
  assert.equal(evaluate(recorded,[base]).analysisReady,false,'Missing current upstream evidence is not repaired by its captured snapshot.');
  assert.equal(evaluate({...recorded,id:'intent-a'}).analysisReady,false,'Self evidence cannot satisfy its own prerequisite.');
  assert.equal(evaluate({...recorded,nodeId:'inference-node'}).analysisReady,false,'An old response of the same producer is not an upstream prerequisite.');
  const unrelated={...upstream,id:'response:later',responseId:'later',revision:4};assert.equal(evaluate(recorded,[base,upstream,unrelated]).state,'ready','Uncited later and self responses do not participate in whole-set freshness.');
  const unknown=structuredClone(recorded);unknown.requirements[0]={...req,resolution:'unknown',value:'',question:'What essential user fact is missing?',checkedSourceIds:[upstream.id]};
  const unseen=source('viability:profile','A supplied factual record still needs inspection.');const coverage=evaluate({...unknown,sources:[base,upstream,unseen]},[base,upstream,unseen]);assert.equal(coverage.state,'needs_evidence');assert.ok(coverage.sourceCoverage[0].missingSourceIds.includes(unseen.id),'Upstream analysis cannot substitute for inspecting supplied base facts.');
});

test('safe resource snapshot separates host and guest rights and optional viewer failure preserves known guest facts',async t=>{
  const workbench={status:async()=>({vmName:'fixture-guest',capability:{canManageVM:true,processElevated:true},guest:{running:true,agent:{paired:true,privileges:{basis:'interactive-guest-agent-token',administratorToken:false,privateToken:'must-not-leak'}}},canRunNativeApps:true,consoleControl:{owner:'agent',revision:7,token:'must-not-leak'}}),guestNativeConsoleStatus:async()=>{throw Object.assign(Error('viewer status unavailable'),{code:'VIEWER_UNAVAILABLE'});}};
  const f=await fixture(t,{engine:{workbench}}),sources=await f.service.sources({...f.definition,workbench:true}),captured=JSON.parse(sources.find(item=>item.id==='viability:workbench').text);
  assert.equal(captured.guest.running,true);assert.equal(captured.guest.hostRights.processElevated,true);assert.equal(captured.guest.guestPrivileges.administratorToken,false);assert.equal(captured.guest.guestPrivileges.known,true);assert.equal(captured.viewer.uncertain,true);assert.equal(captured.viewer.code,'VIEWER_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(captured),/must-not-leak/);
});

test('ordinary planning discovers VM tools without host probes; explicitly granted VM tasks collect actual state',async t=>{
  let statusCalls=0,viewerCalls=0;
  const workbench={status:async()=>{statusCalls++;return{vmName:'fixture-guest',guest:{running:true,agent:{paired:true}},canRunNativeApps:true,consoleControl:{owner:'agent',revision:3}};},guestNativeConsoleStatus:async()=>{viewerCalls++;return{attached:false,openAvailable:true};}};
  const f=await fixture(t,{engine:{workbench}});
  for(const grant of [undefined,false]){
    const records=await f.service.sources({...f.definition,...(grant===undefined?{}:{workbench:grant})});
    const snapshot=JSON.parse(records.find(r=>r.id==='viability:workbench').text);
    assert.equal(snapshot.tool,'relay_workbench');assert.ok(snapshot.actions.includes('status'));
    assert.equal(snapshot.explicitTaskControlGrant,false);assert.equal(snapshot.guest.availability,'not-probed');
    assert.equal(statusCalls,0);assert.equal(viewerCalls,0);
  }
  const records=await f.service.sources({...f.definition,workbench:true}),snapshot=JSON.parse(records.find(r=>r.id==='viability:workbench').text);
  assert.equal(statusCalls,1);assert.equal(viewerCalls,1);assert.equal(snapshot.explicitTaskControlGrant,true);
  assert.equal(snapshot.guest.running,true);assert.equal(snapshot.guest.paired,true);assert.equal(snapshot.viewer.openAvailable,true);
});

test('host proof discovery distinguishes guest observations, reserved control and native visual evidence',async t=>{
  const workbench={status:async()=>({vmName:'fixture',guest:{running:true,agent:{paired:true}},consoleControl:{owner:'user',revision:1}})};
  const f=await fixture(t,{engine:{workbench}}),sources=await f.service.sources({...f.definition,workbench:true});
  const snapshot=JSON.parse(sources.find(item=>item.id==='viability:workbench').text),proof=snapshot.proofCapabilities;
  for(const family of Object.values(proof).filter(item=>item&&typeof item==='object'&&item.action)){
    assert.equal(family.contractExposed,snapshot.actions.includes(family.action),'Discovery describes the actual attached action contract.');
  }
  assert.deepEqual(proof.guestScript.operators,['equals','notEmpty','includes']);assert.equal(proof.guestScript.requiresCurrentAdoptedPlan,true);
  assert.match(proof.guestScript.limits,/model-authored usability Boolean/);assert.match(proof.hostControl.criterionSource,/reserved host-owned/);
  assert.equal(proof.nativeCapture.producesEffectReceipt,false);assert.match(proof.nativeCapture.preciseReadback,/independently read/);
  assert.match(proof.nativeCapture.visualEvidence,/actual returned or retained pixels/);
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
