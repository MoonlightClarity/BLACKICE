import test from 'node:test';
import {fixtureUserAgency,fixtureAskingUserAgency} from './fixture-user-agency.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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

test('an unexamined essential fact is source recovery, not a factual question',()=>{
  const sources=[source('viability:task','Requested form')];
  const result=evaluateViabilityResponse(fixtureResponse([requirement({checkedSourceIds:[]})],sources),sources);
  assert.equal(result.state,'needs_evidence');assert.match(result.issues[0],/Inspect the captured sources/);
  const resume=source('viability:attachment:resume','Supplied résumé has relevant facts.');
  const unread=evaluateViabilityResponse(fixtureResponse([requirement({checkedSourceIds:['viability:task']})],[...sources,resume]),[...sources,resume]);
  assert.equal(unread.state,'needs_evidence');assert.match(unread.issues[0],/all supplied records/);
});


test('readiness ensure, assessment, answer and deployment continuation reject before reading personal sources or dispatching',async t=>{
  let identityReads=0,attachmentReads=0,resumeCalls=0;
  const f=await fixture(t,{identity:{read:async()=>{identityReads++;throw Error('No personal source read is allowed after retirement.');}},attachments:{get:async()=>{attachmentReads++;throw Error('No attachment read is allowed.');}},engine:{resumeViabilityRun:()=>{resumeCalls++;}}});
  const request=await f.store.create({id:'saved-readiness',conversationId:'saved-conversation',title:'Saved readiness',objective:'Keep prior facts unchanged.',cwd:f.directory});
  await f.store.addNode(request.id,{id:'viability',kind:'viability',title:'Saved fact check'});
  await f.store.addSource(request.id,{title:'Captured facts',text:'An essential fact remained unknown.'});
  const raw=JSON.parse(await readFile(f.store.file(request.id),'utf8'));
  raw.viability={scope:'request',nodeId:'viability',fingerprint:viabilityFingerprint(f.definition),definition:f.definition,pendingIntent:{id:'saved-intent',runId:'original-run'}};
  f.store._validate(raw);await writeFile(f.store.file(request.id),JSON.stringify(raw));
  const before=await readFile(f.store.file(request.id),'utf8'),saved=await f.store.get(request.id);
  const operations=[
    ['ensure',[{scope:'request',scopeId:'saved',conversationId:'saved-conversation',definition:f.definition}]],
    ['assess',[request.id]],['assessCurrent',[request.id]],
    ['forRun',[{id:'run',planningMode:'on',planningExecutionMode:'automatic',...f.definition}]],
    ['answer',[request.id,{nodeId:'viability',requirementId:'address',answer:'Synthetic new fact',expectedNodeRevision:1,expectedResponseId:'saved-response',clientRequestId:'answer'}]],
    ['answerCurrent',[request.id,{}]],['refreshSources',[saved,f.definition]],
    ['checkDeployment',[f.definition,'schedule']],['saveDeployment',[{},{}]],
    ['prepareDeploymentInference',[saved,{},{}]],['assertDeployment',[{}]],['withDeployment',[{},()=>{resumeCalls++;}]]
  ];
  for(const [method,args]of operations)await t.test(method,async()=>{await assert.rejects(async()=>f.service[method](...args),{code:'PLANNING_CYCLE_RETIRED',status:410});assert.equal(await readFile(f.store.file(request.id),'utf8'),before);});
  assert.deepEqual(await f.store.get(request.id),saved);assert.equal(identityReads,0);assert.equal(attachmentReads,0);assert.equal(resumeCalls,0);assert.equal(f.calls.length,0);
  const reopened=await new PlanningBrowserStore({dataDir:f.directory}).init();
  try{assert.deepEqual(await reopened.get(request.id),saved);}finally{await reopened.close();}
});

test('off and previously cancelled readiness requests are also inert retired calls',async t=>{
  const f=await fixture(t),before=await f.store.list(),controller=new AbortController();controller.abort();
  for(const planningMode of ['off','on'])await assert.rejects(f.service.forRun({id:'cancelled',planningMode,...f.definition},{signal:controller.signal}),{code:'PLANNING_CYCLE_RETIRED',status:410});
  assert.deepEqual(await f.store.list(),before);assert.equal(f.calls.length,0);assert.equal(f.resumeCalls.length,0);
});
