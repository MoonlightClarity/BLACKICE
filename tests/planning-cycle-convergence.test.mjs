import test from 'node:test';
import {judgment as fixtureChildAdmission} from './fixture-child-admission.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixtureUserAgency} from './fixture-user-agency.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse,planningModulePrompt} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {responseCycleStage,responseCycleTemplate} from '../public/response-cycle-model.mjs';

const purpose='Compare the supplied fictional room capacities.';
const criterion={id:'capacity-finding',label:'Capacity finding',description:'Report the conclusion supported by the supplied capacities.',verification:'response'};
const profile={model:'fixture-local',effort:'low',serviceTier:'default'};
const captured=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
function answer(input){
  const stage=responseCycleStage(input.module.kind,{pipelineVersion:2}),sourceId=input.sources[0].id;
  return {userAgency:fixtureUserAgency(),values:Object.fromEntries(input.template.fields.map(field=>[field.id,'The supplied fictional capacities support a bounded comparison.'])),
    grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[],
    checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'This check is supported only by the supplied fictional premises.'})),
    subproblems:[],childResults:[],inferences:[{id:'capacity',claim:'The captured fictional rooms have different capacities.',basis:'inferred',sourceIds:[sourceId],limitation:'No additional room observation has been made.'}]};
}
function childRequest(sourceId){return {executionTarget:'analysis',key:'capacity',title:'Compare the two supplied numbers',objective:'Determine the difference between the two supplied capacities.',reason:'The comparison supports the parent answer.',required:true,sourceIds:[sourceId],acceptanceCriteria:[criterion]};}
function unit(){
  const source={id:'supplied-facts',kind:'source',text:'Fictional North has four seats and South has six.'};
  const input={module:{kind:'inference'},template:responseCycleTemplate('inference'),sources:[source],cycle:{objective:purpose,children:[]}};
  const attempt={node:{kind:'inference'},pipelineVersion:2,template:input.template,sources:input.sources,cycleContext:input.cycle};
  return {input,attempt,body:answer(input)};
}
async function fixture(t,handler){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-cycle-convergence-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  const reviews=[];const runtime={runAgent:async options=>{const input=captured(options);if(input.reviewType){reviews.push(input);return {output:JSON.stringify(fixtureChildAdmission(input.snapshot)),threadId:'fixture-review',turnId:'review-'+reviews.length};}calls.push({input,options});return {output:JSON.stringify(await handler(input,calls.length)),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length};}};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>({maxSubagents:2,defaultModel:profile.model,defaultEffort:profile.effort})}),service=new ResponseCycleService({store,runner,getSettings:()=>({defaultModel:profile.model,defaultEffort:profile.effort})});
  t.after(async()=>{await runner.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  let request=await store.create({conversationId:'convergence-fixture',title:'Fictional capacities',objective:purpose,cwd:dir});
  request=await service.createCycle(request.id,{title:'Compare fictional rooms',purpose,planningExecutionMode:'plan_only',expectedRequestRevision:request.revision,clientRequestId:'root-fixture'});
  return {store,runner,service,calls,reviews,request,cycle:request.cycles[0]};
}
// Seed historical/manual child records without pretending they passed new automatic admission.
async function historicalChild(service,requestId,value,options){const current=await service.store.get(requestId),parent=current.nodes.find(item=>item.id===value.parentNodeId);return service.createCurrent(requestId,{...value,expectedRequestRevision:current.revision,expectedParentRevision:parent.revision},{...options,internal:false});}
const aggregate=child=>({key:child.key,sourceId:child.sourceId,summary:'The child failed without a checked answer. Its requested conclusion remains unresolved.',usedFor:'Preserve the missing comparison as a limitation, not successful evidence.'});

test('terminal required child aggregation is structural, exact, and cannot promote its outcome',()=>{
  for(const state of ['failed','cancelled','completed']){
    const {input,attempt,body}=unit(),request=childRequest(input.sources[0].id),source={id:'child-result',kind:'source',text:JSON.stringify({state,outcome:'unresolved'})};
    input.sources.push(source);
    const child={key:request.key,required:true,state,sourceId:source.id,request};
    input.cycle.children=[child];
    assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),error=>error.code==='PLANNING_RESPONSE_FORMAT'&&error.issues.some(item=>item.path==='response.childResults'&&item.message.includes(state)));
    body.childResults=[aggregate(child)];
    assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)));
    body.childResults[0].sourceId=input.sources[0].id;
    assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),{code:'PLANNING_RESPONSE_FORMAT'});
  }
});

test('pending, optional, or missing-source children never require fabricated aggregates',()=>{
  for(const variant of ['pending','optional','missing-source']){
    const {input,attempt,body}=unit(),request=childRequest(input.sources[0].id);
    const child={key:request.key,required:variant!=='optional',state:variant==='pending'?'running':'failed',sourceId:'child-result',request};
    input.cycle.children=[child];
    if(variant!=='missing-source')input.sources.push({id:'child-result',kind:'source',text:'Captured unresolved child outcome.'});
    assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)));
    if(variant==='pending'){
      body.childResults=[aggregate(child)];
      assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),{code:'PLANNING_RESPONSE_FORMAT'});
    }
  }
  const {input,attempt,body}=unit();body.childResults=[{key:'invented',sourceId:input.sources[0].id,summary:'Invented child.',usedFor:'Claim readiness.'}];
  assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),{code:'PLANNING_RESPONSE_FORMAT'});
});

test('bound child identity and exact parent recursion reach bounded repair without weakening host guards',()=>{
  for(const field of ['objective','title','required','sourceIds','acceptanceCriteria','executionTarget']){
    const {input,attempt,body}=unit(),original=childRequest(input.sources[0].id);
    input.cycle.children=[{key:original.key,state:'running',required:true,request:original}];
    const revised=structuredClone(original);
    revised[field]=field==='required'?false:field==='sourceIds'?[]:field==='acceptanceCriteria'?[{...criterion,description:'A different completion contract.'}]:field==='executionTarget'?'workflow':'Different '+field;
    body.subproblems=[revised];
    assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),error=>error.code==='PLANNING_RESPONSE_FORMAT'&&error.issues[0].path==='response.subproblems[0]');
    body.subproblems=[structuredClone(original)];
    assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)));
  }
  const {input,attempt,body}=unit();
  body.subproblems=[{...childRequest(input.sources[0].id),objective:'  # '+purpose.toUpperCase().replaceAll(' ','  ')}];
  assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),error=>error.code==='PLANNING_RESPONSE_FORMAT'&&error.issues[0].path==='response.subproblems[0].objective');
  body.subproblems[0].executionTarget='workflow';
  assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),'Actual workflow routing is not forbidden by a same-sized analytical guard.');
});

test('recorded failure pattern repairs once using exact host review and preserves failed-child dispatch block',async t=>{
  for(const defect of ['missing-aggregate','changed-contract'])await t.test(defect,async t=>{
    let original;
    const f=await fixture(t,(input,index)=>{
      const body=answer(input);
      if(index===1){original=childRequest(input.sources[0].id);body.subproblems=[original];}
      else{
        assert.ok(input.stageReview.readiness.cycle.issues.some(issue=>issue.includes('Aggregate the current required child result')));
        assert.equal(input.previousResponse.childResults.length,0);
        body.subproblems=[structuredClone(original)];
        if(index===2&&defect==='changed-contract')body.subproblems[0].acceptanceCriteria[0].description='A different completion requirement.';
        if(index===3){
          assert.equal(input.formatRepair.diagnostic.code,'PLANNING_RESPONSE_FORMAT');
          assert.ok(input.formatRepair.diagnostic.issues.some(issue=>issue.path==='response.childResults'),'One repair sees the missing aggregate even when the bound contract also changed.');
          if(defect==='changed-contract')assert.ok(input.formatRepair.diagnostic.issues.some(issue=>issue.path==='response.subproblems[0]'));
          assert.deepEqual(input.stageReview,f.calls[1].input.stageReview);
          body.childResults=input.cycle.children.map(aggregate);
        }
      }
      return body;
    });
    let node=f.request.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference);
    const initial=await f.runner.start({requestId:f.request.id,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:'initial-response',...profile});
    await f.runner.wait(f.request.id,initial.attempt.id);
    let request=await historicalChild(f.service,f.request.id,{parentNodeId:node.id,title:original.title,purpose:original.objective,planningExecutionMode:'automatic',clientRequestId:'captured-child'},{internal:true,acceptanceCriteria:original.acceptanceCriteria,sourceIds:original.sourceIds,key:original.key,required:true,subproblemRequest:original});
    const childId=request.cycleAction.cycleId;
    request=await f.store.runtimeWriter().configureResponseCycle(request.id,{cyclePatch:{id:childId,state:'failed',failure:{code:'FIXTURE_UNAVAILABLE',message:'No checked child answer was produced.'},summary:'The supplied child analysis failed.'}});
    const budget={used:1,max:8,maxPasses:3};
    request=await f.service.runStage(request.id,f.cycle.id,'inference',{budget,runKey:'refine-existing-failure'});
    node=request.nodes.find(item=>item.id===node.id);
    assert.equal(f.calls.length,3);
    assert.equal(budget.used,3+f.reviews.length,'Semantic reviews consume provider budget separately from module-format repair.');
    assert.equal(request.cycles.find(item=>item.id===childId).state,'failed');
    assert.equal(request.cycles.length,2,'Repair must not create replacement children to conceal failure.');
    assert.equal(node.readiness.cycle.analysisReady,true);
    assert.equal(node.readiness.cycle.dispatchReady,false);
    assert.deepEqual(node.readiness.cycle.childFailures,[{key:original.key,state:'failed'}]);
    assert.match(node.response.childResults[0].summary,/failed/);
    const [initialAttempt,invalid,repaired]=request.attempts.filter(item=>item.purpose!=='child_admission');
    assert.equal(initialAttempt.status,'completed');assert.equal(invalid.status,'failed');assert.equal(repaired.status,'completed');
    assert.equal(repaired.repairOf,invalid.id);assert.deepEqual(repaired.stageReview,invalid.stageReview);
    assert.equal(invalid.stageReview.responseId,initialAttempt.responseId);
    assert.match(planningModulePrompt(repaired),/failed or cancelled child is not successful evidence|failed or cancelled children/);
    const repeated=await f.service.runStage(request.id,f.cycle.id,'inference',{budget,runKey:'ready-is-stable'});
    assert.equal(f.calls.length,3,'A ready analysis with a preserved failed outcome does not spend further turns.');
    assert.equal(repeated.nodes.find(item=>item.id===node.id).readiness.cycle.dispatchReady,false);
  });
});

test('exact-self recursion is repaired before child admission, and an invalid repair stays bounded',async t=>{
  for(const repair of [true,false])await t.test(String(repair),async t=>{
    const f=await fixture(t,(input,index)=>{
      const body=answer(input);
      if(index===1||!repair)body.subproblems=[{...childRequest(input.sources[0].id),objective:purpose}];
      if(index===2)assert.ok(input.formatRepair.diagnostic.issues.some(issue=>issue.path==='response.subproblems[0].objective'));
      return body;
    }),budget={used:0,max:10,maxPasses:3};
    const request=await f.service.runStage(f.request.id,f.cycle.id,'inference',{budget,runKey:'self-recursion'}),node=request.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference);
    assert.equal(f.calls.length,2);assert.equal(budget.used,2);assert.equal(request.cycles.length,1);
    assert.equal(Boolean(node.response),repair);assert.equal(request.attempts.at(-1).status,repair?'completed':'failed');
    assert.equal(request.nodes.find(item=>item.id===f.cycle.stageNodeIds.plan).response,null);
  });
});


test('explicit retry can replace a historical changed child binding before resuming only original child work',async t=>{
  for(const mode of ['terminal','pending','waiting','invalid','budget','cancel'])await t.test(mode,async t=>{
    let original,childId,legacyId,childDrives=0;
    const f=await fixture(t,input=>{
      const body=answer(input);
      assert.ok(input.stageReview.readiness.cycle.staleInputs.some(issue=>issue.includes('bound subproblem'))||input.stageReview.readiness.cycle.issues.some(issue=>issue.includes('Aggregate')));
      if(mode==='invalid')body.subproblems=[{...original,objective:'A different child question that changes the saved binding.'}];
      else if(mode==='terminal')body.subproblems=[structuredClone(original)];
      body.childResults=(input.cycle.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)&&input.sources.some(source=>source.id===child.sourceId)).map(aggregate);
      return body;
    });
    const sourceId=f.request.sources[0].id;
    original=childRequest(sourceId);
    let request=await historicalChild(f.service,f.request.id,{parentNodeId:f.cycle.stageNodeIds.inference,title:original.title,purpose:original.objective,planningExecutionMode:'automatic',clientRequestId:'legacy-bound-child'},
      {internal:true,key:original.key,required:true,acceptanceCriteria:original.acceptanceCriteria,sourceIds:original.sourceIds,subproblemRequest:original});
    childId=request.cycleAction.cycleId;
    const writer=f.store.runtimeWriter();
    request=await writer.configureResponseCycle(request.id,{cyclePatch:{id:childId,state:mode==='terminal'?'failed':'needs_evidence',summary:'The saved child has no checked answer.'}});
    const node=request.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference),captured=await writer.beginAttempt(request.id,node.id,{ownerId:'historical-worker',expectedNodeRevision:node.revision,...profile});
    const historical=answer({module:captured.attempt.node,template:captured.attempt.template,sources:captured.attempt.sources,cycle:captured.attempt.cycleContext});
    historical.subproblems=[{...original,objective:'A different child question that changes the saved binding.'}];
    request=await writer.recordResponse(request.id,captured.attempt.id,{output:JSON.stringify(historical),metadata:{runId:'fixture-historical-run',executionNodeId:node.id}});
    legacyId=request.nodes.find(item=>item.id===node.id).response.id;
    const legacy=structuredClone(request.responses.find(item=>item.id===legacyId));
    f.service.drive=async(requestId,cycleId)=>{
      assert.equal(cycleId,childId);
      const current=await f.store.get(requestId),parent=current.nodes.find(item=>item.id===node.id);
      assert.notEqual(parent.response.id,legacyId,'No child work may run while the invalid historical response is current.');
      assert.doesNotThrow(()=>f.service.assertSubproblemBindings(current,parent));
      childDrives++;
      return writer.configureResponseCycle(requestId,{cyclePatch:{id:childId,state:mode==='waiting'?'needs_evidence':'failed',summary:'The original bounded child remains unresolved.'}});
    };
    const budget={used:1,max:mode==='budget'?1:10,maxPasses:3},controller=new AbortController();
    if(mode==='cancel')controller.abort();
    const operation=f.service.runStage(request.id,f.cycle.id,'inference',{budget,signal:controller.signal,runKey:'repair-legacy-binding'});
    if(mode==='invalid')await assert.rejects(operation,{code:'RESPONSE_CYCLE_RECURSION'});
    else if(mode==='budget')await assert.rejects(operation,{code:'RESPONSE_CYCLE_BUDGET'});
    else if(mode==='cancel')await assert.rejects(operation,error=>error.name==='AbortError');
    else await operation;
    const saved=await f.store.get(request.id),parent=saved.nodes.find(item=>item.id===node.id),child=saved.cycles.find(item=>item.id===childId);
    assert.deepEqual(saved.responses.find(item=>item.id===legacyId),legacy,'Historical response bytes are not rewritten.');
    assert.deepEqual(child.request,original,'The saved child contract remains immutable.');
    assert.equal(saved.cycles.length,2);
    if(mode==='terminal'||mode==='pending'){
      assert.equal(f.calls.length,2,'The second bounded refinement consumes the newly captured terminal child source.');
      assert.equal(childDrives,mode==='pending'?1:0);
      assert.equal(parent.readiness.cycle.analysisReady,true);
      assert.equal(parent.readiness.cycle.dispatchReady,false);
      assert.equal(child.state,'failed');
    }else if(mode==='waiting'){
      assert.equal(f.calls.length,1);assert.equal(childDrives,1);
      assert.notEqual(parent.response.id,legacyId);
      assert.equal(parent.readiness.cycle.analysisReady,false);assert.equal(parent.readiness.cycle.dispatchReady,false);
      assert.equal(child.state,'needs_evidence');assert.equal(child.required,true);
    }else{
      assert.equal(f.calls.length,mode==='invalid'?2:0);
      assert.equal(childDrives,0);
      assert.equal(parent.response.id,legacyId);
      assert.equal(parent.readiness.cycle.analysisReady,false);
    }
  });
});


test('combined child diagnostics retain established specific error messages',()=>{
  for(const kind of ['missing-target','workflow-rebind','external-effect','combined']){
    const {input,attempt,body}=unit(),original=childRequest(input.sources[0].id);
    body.subproblems=[structuredClone(original)];
    let expected;
    if(kind==='missing-target'){delete body.subproblems[0].executionTarget;expected=/must declare where its work can actually execute/;}
    if(kind==='workflow-rebind'){
      input.cycle.children=[{key:original.key,state:'running',required:true,request:original}];
      body.subproblems[0].executionTarget='workflow';expected=/analytical child cannot be rebound/;
    }
    if(kind==='external-effect'||kind==='combined'){
      body.subproblems[0].acceptanceCriteria[0].verification='effect';expected=/analytical child cannot establish/;
    }
    if(kind==='combined'){
      input.sources.push({id:'failed-child-result',kind:'source',text:'The child failed without observed effects.'});
      input.cycle.children=[{key:original.key,state:'failed',required:true,sourceId:'failed-child-result',request:original}];
    }
    assert.throws(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),error=>{
      assert.equal(error.code,'PLANNING_RESPONSE_FORMAT');assert.match(error.message,expected);
      if(kind==='combined'){
        assert.ok(error.issues.some(item=>item.path==='response.subproblems[0]'));
        assert.ok(error.issues.some(item=>item.path.endsWith('.verification')));
        assert.ok(error.issues.some(item=>item.path==='response.childResults'));
      }
      return true;
    });
  }
});
