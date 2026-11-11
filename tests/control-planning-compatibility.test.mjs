import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {createControlToolHandler,CONTROL_TOOL,PRE_USER_AGENCY_CONTROL_TOOL} from '../lib/control-tools.mjs';
import {validRemoteArguments} from '../lib/remote-agent-api.mjs';
import {responseCycleStage,responseCycleTemplate} from '../public/response-cycle-model.mjs';

const savedPlan=()=>({
  values:Object.fromEntries(responseCycleTemplate('plan').fields.map(field=>[field.id,'Archived synthetic finding.'])),
  grounding:[],openQuestions:[],challengeResponses:[],
  checks:responseCycleStage('plan').checks.map(row=>({id:row.id,assessment:'supported',sourceIds:[],note:'Historical read-only test.'})),
  subproblems:[],childResults:[],
  acceptanceCriteria:[{id:'outcome',label:'Recorded outcome',description:'Historical synthetic response.',verification:'response',accuracy:null}],
  steps:[{id:'work',label:'Inspect archived result',description:'Inspect the saved record.',dependsOn:[],criterionIds:['outcome'],sourceIds:[]}],
});

test('archived response cycles remain readable, but neither old nor current control tools can mutate the retired pipeline',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-retired-control-'));
  let store,service;let modelCalls=0;
  const runner={start(){modelCalls++;throw Error('No provider start allowed for an archived cycle');}};
  const open=async()=>{store=await new PlanningBrowserStore({dataDir:directory}).init();service=new ResponseCycleService({store,runner});};
  await open();
  t.after(async()=>{await service.close();await store.close();await rm(directory,{recursive:true,force:true});});
  let request=await store.create({conversationId:'archived',title:'Old Plan',objective:'Preserve earlier findings',cwd:directory});
  request=await service.createCycle(request.id,{title:'Historical cycle',purpose:request.objective,
    planningExecutionMode:'automatic',expectedRequestRevision:request.revision,clientRequestId:'archive-fixture'});
  const id=request.id,cycleId=request.cycles[0].id;
  const planOf=graph=>graph.nodes.find(node=>node.id===graph.cycles.find(cycle=>cycle.id===cycleId).stageNodeIds.plan);
  const plan=planOf(request);
  request=await store.recordHumanResponse(id,plan.id,savedPlan(),{expectedNodeRevision:plan.revision,actor:'historical-fixture'});
  const before=planOf(request).response.id;
  await service.close();await store.close();await open();
  assert.equal(planOf(await store.get(id)).response.id,before,'archive must survive reopening');
  assert.ok(!CONTROL_TOOL.inputSchema.properties.action.enum.some(name=>name.startsWith('planning_cycle_')));
  const args={action:'planning_cycle_edit_plan',graphRequestId:id,cycleId,
    cycle:{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycleId).revision,
      expectedPlanRevision:planOf(request).revision,expectedPlanResponseId:before,clientRequestId:'old-plan-edit',plan:savedPlan()}};
  assert.equal(typeof args.action,'string'); // Historical payload remains readable, never executable.
  for(const schema of [PRE_USER_AGENCY_CONTROL_TOOL,CONTROL_TOOL]){
    const gateway=createControlToolHandler({engine:{responseCycle:service},run:{id:'archived',cwd:directory},
      nodeId:'archived-agent',toolDefinition:schema});
    const result=await gateway({name:'relay_control',arguments:args});
    assert.equal(result.success,false);
    assert.match(result.contentItems[0].text,/legacy Planning cycle is retired/);
    assert.equal(planOf(await store.get(id)).response.id,before,'rejected action cannot mutate an old cycle');
  }
  assert.equal(modelCalls,0);
  await service.close();await store.close();await open();
  assert.equal(planOf(await store.get(id)).response.id,before);
});
