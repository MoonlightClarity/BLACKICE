import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkflowStageEdits,workflowSnapshot} from '../public/next/workspaces/workflow-edit-model.mjs';

const sample=()=>({
  id:'saved-parallel',name:'Investigate and compare',
  description:'Keep original process steps',updatedAt:'2026-10-24T20:00:00Z',
  nodes:[
    {id:'input',type:'input',name:'Evidence'},
    {id:'first',type:'agent',name:'Primary reviewer',model:'codex',prompt:'Review each finding.',settings:{depth:2}},
    {id:'second',type:'agent',name:'Secondary reviewer',model:'codex',prompt:'Find contradictions.',tools:['search']},
    {id:'output',type:'output',name:'Report'}
  ],
  edges:[{id:'a',source:'input',target:'first'},{id:'b',source:'input',target:'second'},
    {id:'c',source:'first',target:'output'},{id:'d',source:'second',target:'output'}],
  settings:{maxParallel:2,planningMode:'auto'},unknownMetadata:{retain:true},
});

test('editing agent instructions retains saved workflow identity, parallel graph and unknown metadata',()=>{
  const original=sample(),before=structuredClone(original);
  const next=applyWorkflowStageEdits(original,{name:'New case assessment',nodes:{
    first:{name:'Lead reviewer',prompt:'Investigate the new evidence.'}
  }});
  assert.notEqual(next,original);
  assert.equal(next.id,'saved-parallel');
  assert.equal(next.name,'New case assessment');
  assert.equal(next.nodes[1].name,'Lead reviewer');
  assert.equal(next.nodes[1].prompt,'Investigate the new evidence.');
  assert.deepEqual(next.nodes[1].settings,{depth:2});
  assert.deepEqual(next.nodes[2],original.nodes[2]);
  assert.deepEqual(next.edges,original.edges);
  assert.deepEqual(next.settings,original.settings);
  assert.deepEqual(next.unknownMetadata,original.unknownMetadata);
  assert.deepEqual(original,before,'The editor cannot mutate original server data before Save');
});

test('changing multiple agent stages preserves edges and node identifiers',()=>{
  const workflow=sample();
  const patched=applyWorkflowStageEdits(workflow,{nodes:{
    first:{name:'Reviewer A',prompt:'Review.'},
    second:{name:'Reviewer B',prompt:'Cross check.'}
  }});
  assert.deepEqual(patched.nodes.map(n=>n.id),workflow.nodes.map(n=>n.id));
  assert.deepEqual(patched.edges,workflow.edges);
  assert.equal(patched.nodes[2].prompt,'Cross check.');
  assert.equal(patched.nodes[2].tools[0],'search');
});

test('invalid, unknown or ambiguous edits fail before HTTP submission',()=>{
  const workflow=sample();
  assert.throws(()=>applyWorkflowStageEdits(null,{}),/saved workflow/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{name:'   '}),/name/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{name:'X'.repeat(161)}),/160/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{removed:{name:'Old'}}}),/stage selection changed/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{input:{name:'Evidence',prompt:'Invalid'}}}),/Only agent stages/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{first:{name:'  '}}}),/stage name/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{first:{name:'X'.repeat(121)}}}),/120/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{first:{name:'Lead',prompt:'X'.repeat(20001)}}}),/20,000/);
  const duplicate=sample();duplicate.nodes.push({id:'first',type:'agent'});
  assert.throws(()=>applyWorkflowStageEdits(duplicate,{}),/duplicate stage IDs/);
});

test('advanced model, reasoning, speed, context and workflow settings preserve unrelated data',()=>{
  const original=sample(),before=structuredClone(original);
  original.nodes[1].context={preset:'model',windowTokens:null,autoCompact:true,keepRecentTokens:8000};
  const advanced=applyWorkflowStageEdits(original,{nodes:{
    first:{model:'cloud::remote-fixture',effort:'high',serviceTier:'fast',
      context:{preset:'custom',windowTokens:120000,autoCompact:false}},
    second:{model:'default',effort:'default',serviceTier:'default'},
  },workflowSettings:{maxParallel:3,planningMode:'on',planDetail:'detailed'}});
  assert.equal(advanced.nodes[1].model,'cloud::remote-fixture');
  assert.equal(advanced.nodes[1].effort,'high');
  assert.equal(advanced.nodes[1].serviceTier,'fast');
  assert.deepEqual(advanced.nodes[1].context,{
    preset:'custom',windowTokens:120000,autoCompact:false,keepRecentTokens:8000,
  });
  assert.equal(advanced.nodes[2].effort,'default','Explicit model default is different from omission.');
  assert.equal(advanced.nodes[2].serviceTier,'default');
  assert.equal(advanced.settings.maxParallel,3);
  assert.equal(advanced.settings.planningMode,'on');
  assert.equal(advanced.settings.planDetail,'detailed');
  assert.deepEqual(advanced.edges,original.edges);
  assert.deepEqual(advanced.nodes[1].settings,{depth:2});
  assert.deepEqual(advanced.nodes[2].tools,['search']);
  assert.deepEqual(advanced.unknownMetadata,original.unknownMetadata);
  assert.deepEqual(before.nodes[1].model,'codex');
  assert.equal(original.nodes[1].context.autoCompact,true);
});

test('advanced inheritance resets only named settings without destroying retained metadata',()=>{
  const original=sample();
  Object.assign(original.nodes[1],{effort:'high',serviceTier:'fast',
    context:{preset:'900k',windowTokens:900000,autoCompact:true},desktop:true});
  const revised=applyWorkflowStageEdits(original,{nodes:{
    first:{model:null,effort:null,serviceTier:null,context:null,desktop:null},
  },workflowSettings:{maxParallel:null,planningMode:null,planDetail:null}});
  for(const key of ['model','effort','serviceTier','context','desktop'])
    assert.equal(Object.hasOwn(revised.nodes[1],key),false,key+' must be omitted, not reset to a string default');
  assert.equal(revised.settings.maxParallel,null);
  assert.equal(Object.hasOwn(revised.settings,'planningMode'),false);
  assert.equal(Object.hasOwn(revised.settings,'planDetail'),false);
  assert.deepEqual(revised.nodes[1].settings,{depth:2});
  assert.deepEqual(revised.edges,original.edges);
  assert.equal(original.nodes[1].model,'codex','Original source must remain immutable.');
});

test('advanced metadata rejects invalid choices before attempting a workflow write',()=>{
  const workflow=sample();
  const badNode=input=>applyWorkflowStageEdits(workflow,{nodes:{first:input}});
  for(const value of ['', ' ', 'x'.repeat(401),'bad'+String.fromCharCode(10)+'model']){
    assert.throws(()=>badNode({model:value}),/model identifier/);
  }
  assert.throws(()=>badNode({effort:'unsupported'}),/reasoning effort/);
  assert.throws(()=>badNode({serviceTier:'priority'}),/service tier/);
  assert.throws(()=>badNode({context:{preset:'custom',windowTokens:1000,autoCompact:true}}),/Custom context/);
  assert.throws(()=>badNode({context:{preset:'custom',windowTokens:4000001}}),/Custom context/);
  assert.throws(()=>badNode({context:{preset:'invalid'}}),/context window preset/);
  assert.throws(()=>badNode({context:{preset:'model',autoCompact:'false'}}),/compaction/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{nodes:{input:{model:'default'}}}),/Only agent stages/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{workflowSettings:{maxParallel:-1}}),/parallel/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{workflowSettings:{maxParallel:1001}}),/parallel/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{workflowSettings:{planningMode:'never'}}),/planning mode/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{workflowSettings:{planDetail:'enormous'}}),/planning/);
  assert.throws(()=>applyWorkflowStageEdits(workflow,{workflowSettings:{privateSetting:'new'}}),/not editable/);
});

test('snapshot changes when another editor modifies the stored graph before Save',()=>{
  const original=sample();
  const changed=structuredClone(original);
  changed.edges.push({id:'extra',source:'second',target:'first'});
  assert.notEqual(workflowSnapshot(original),workflowSnapshot(changed));
  const next=applyWorkflowStageEdits(original,{nodes:{first:{name:'Updated'}}});
  assert.notEqual(workflowSnapshot(original),workflowSnapshot(next));
  assert.equal(workflowSnapshot(original),workflowSnapshot(structuredClone(original)));
});

test('stage IDs and other workflow metadata remain unchanged when only renaming a workflow',()=>{
  const initial=sample();
  const patched=applyWorkflowStageEdits(initial,{name:'Only a new name'});
  assert.equal(patched.name,'Only a new name');
  assert.deepEqual(patched.nodes,initial.nodes);
  assert.deepEqual(patched.edges,initial.edges);
});
