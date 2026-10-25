import test from 'node:test';
import assert from 'node:assert/strict';
import {createSwarmWorkflow,swarmAssignments,swarmWorkflowPlan} from '../public/swarm-model.mjs';

const agents=workflow=>workflow.nodes.filter(node=>node.type==='agent');
test('new swarm assignments describe work without deriving worker capabilities',()=>{
  for(const pattern of ['research','delivery']){
    const workflow=createSwarmWorkflow({id:pattern,pattern,members:6});
    for(const node of agents(workflow)){
      assert.deepEqual(Object.keys(node.assignment).sort(),['doneWhen','inputs','result','scope']);
      assert.equal(Object.hasOwn(node,'sandbox'),false);
      assert.doesNotMatch(node.prompt,/read.only assignment|assignment is read.only|do not modify workspace|sole specialist allowed|explicit disjoint file boundaries/i);
    }
    assert.equal(workflow.settings.maxParallel,6);
  }
});

test('legacy assignment metadata is preserved without restricting overlapping work',()=>{
  const assignments=swarmAssignments({members:2,pattern:'delivery'});
  for(const item of assignments)item.scope='Inspect and improve the shared implementation.';
  assignments[0].canWrite=false;assignments[0].legacy={label:'Keep exactly',permissions:{write:false}};
  assignments[1].canWrite=true;assignments[1].unknownMetadata=['retained'];
  const workflow=createSwarmWorkflow({members:2,pattern:'delivery',assignments}),workers=agents(workflow).slice(0,2);
  assert.equal(workers[0].assignment.canWrite,false);assert.equal(workers[1].assignment.canWrite,true);
  assert.deepEqual(workers[0].assignment.legacy,assignments[0].legacy);
  assert.deepEqual(workers[1].assignment.unknownMetadata,['retained']);
  assert.ok(workers.every(node=>!Object.hasOwn(node,'sandbox')));
  workers[0].assignment.legacy.label='Changed copy';assert.equal(assignments[0].legacy.label,'Keep exactly');
  const withoutFlags=assignments.map(({canWrite,...item})=>item);
  const ordinary=agents(createSwarmWorkflow({members:2,pattern:'delivery',assignments:withoutFlags}));
  assert.deepEqual(workers.map(node=>node.prompt),ordinary.slice(0,2).map(node=>node.prompt));
});

test('descriptive field validation uses the shared assignment bounds and ignores old flag types',()=>{
  const assignments=swarmAssignments({members:1});
  assignments[0].canWrite='legacy metadata';assignments[0].inputs=Array.from({length:200},(_,i)=>'Input '+i);
  assert.equal(agents(createSwarmWorkflow({members:1,assignments}))[0].assignment.inputs.length,200);
  assignments[0].inputs.push('Too many');assert.throws(()=>createSwarmWorkflow({members:1,assignments}),/200 required inputs/);
  assignments[0].inputs=[''];assert.throws(()=>createSwarmWorkflow({members:1,assignments}),/nonempty text/);
  assignments[0].inputs=[];assignments[0].scope='';assert.throws(()=>createSwarmWorkflow({members:1,assignments}),/scope needs nonempty/);
});

test('shared plan previews display work and inputs instead of permission labels',()=>{
  const assignments=swarmAssignments({members:2});assignments[0].canWrite=false;assignments[1].canWrite=true;
  const plan=swarmWorkflowPlan(createSwarmWorkflow({id:'preview',members:2,assignments}));
  assert.match(plan.steps.find(step=>step.id==='agent-specialist-1-work').note,/Required inputs/);
  assert.doesNotMatch(JSON.stringify(plan),/Read.only assignment|May edit files|canWrite/);
  assert.deepEqual(plan.steps.find(step=>step.id==='agent-coordinator').dependsOn,['agent-specialist-1','agent-specialist-2']);
});
