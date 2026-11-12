import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixtureUserAgency} from './fixture-user-agency.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {responseCycleStage,responseCycleTemplate} from '../public/response-cycle-model.mjs';

const purpose='Compare the supplied fictional room capacities.';
const criterion={id:'capacity-finding',label:'Capacity finding',description:'Report the conclusion supported by the supplied capacities.',verification:'response'};
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

test('saved child outcomes cannot restart recursion, child admission or stage repair',async t=>{
  for(const state of ['failed','cancelled','completed'])await t.test(state,async t=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'cycle-convergence-archive-')),store=await new PlanningBrowserStore({dataDir:dir}).init();let calls=0;
    const runner=new PlanningBrowserRuntime({store,runtime:{runAgent:async()=>{calls++;throw Error('Retired recursion must not call a provider.');}},defaultCwd:dir}),service=new ResponseCycleService({store,runner});
    t.after(async()=>{await runner.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
    await store.create({id:'saved',conversationId:'archive',title:'Saved recursion',objective:purpose});
    const definitions=[];
    for(const [id,parentStageId]of [['old-root',null],['old-child','old-root-inference']]){
      const current=await store.get('saved'),parent=current.nodes.find(node=>node.id===parentStageId);
      await store.addNode('saved',{id,kind:'cycle',title:'Saved '+id,parentId:parentStageId},parent?{expectedParentRevision:parent.revision}:{});
      const stageNodeIds={};
      for(const [stage,kind]of [['inference','inference'],['feasibility','viability'],['plan','plan'],['think','think'],['respond','respond']]){
        stageNodeIds[stage]=id+'-'+stage;
        const group=(await store.get('saved')).nodes.find(node=>node.id===id);
        await store.addNode('saved',{id:stageNodeIds[stage],kind,title:'Saved '+stage,parentId:id},{expectedParentRevision:group.revision});
      }
      definitions.push({id,title:'Saved '+id,objective:purpose,pipelineVersion:2,planningExecutionMode:'automatic',depth:parentStageId?1:0,parentCycleId:parentStageId?'old-root':null,parentStageId,stageNodeIds,state:parentStageId?state:'failed',key:parentStageId?'capacity':null,required:true,acceptanceCriteria:[],effectReceipts:[],summary:'Keep the original recorded outcome.'});
    }
    const writer=store.runtimeWriter(),attempt=await writer.beginAttempt('saved','old-child-inference',{ownerId:'prior-owner',expectedNodeRevision:1,clientRequestId:'prior-child'});
    await writer.fail('saved',attempt.attempt.id,{message:'Original child limitation.',partialOutput:'The comparison remains unverified.'});
    const raw=JSON.parse(await readFile(store.file('saved'),'utf8'));
    for(const cycle of definitions)for(const node of raw.nodes){
      if(node.id===cycle.id)node.cycleId=cycle.id;
      for(const [stage,nodeId]of Object.entries(cycle.stageNodeIds))if(node.id===nodeId){node.cycleId=cycle.id;node.cycleStage=stage;}
    }
    raw.responseCycle={version:1,rootCycleId:'old-root',cycles:definitions,limits:{maxDepth:4,maxCycles:24,maxPassesPerStage:3,maxProviderTurns:160}};
    store._validate(raw);await writeFile(store.file('saved'),JSON.stringify(raw));
    const before=await readFile(store.file('saved'),'utf8'),saved=await store.get('saved'),budget={used:0,max:10,maxPasses:3};
    await assert.rejects(service.runStage('saved','old-root','inference',{budget,runKey:'retry'}),{code:'PLANNING_CYCLE_RETIRED',status:410});
    await assert.rejects(service.ensureChildAdmission(saved,'old-root-inference'),{code:'PLANNING_CYCLE_RETIRED',status:410});
    await assert.rejects(service.createCurrent('saved',{parentNodeId:'old-root-inference',title:'Replacement',purpose}),{code:'PLANNING_CYCLE_RETIRED',status:410});
    await assert.rejects(writer.beginRepairAttempt('saved',attempt.attempt.id),{code:'PLANNING_CYCLE_RETIRED',status:410});
    assert.equal(await readFile(store.file('saved'),'utf8'),before);
    const after=await store.get('saved');
    assert.equal(after.responseCycle.cycles.find(cycle=>cycle.id==='old-child').state,state,'The original saved state remains unchanged.');
    assert.equal(after.cycles.find(cycle=>cycle.id==='old-child').state,state==='completed'?'needs_review':state,'A completion claim without successful stage evidence must not become verified completion.');
    assert.equal(calls,0);assert.equal(budget.used,0);assert.equal(saved.attempts.length,1);
  });
});
