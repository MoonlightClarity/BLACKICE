import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflow} from '../lib/engine.mjs';
import {workerAssignmentDescription} from '../lib/workflow-assignment.mjs';
import {SUBAGENT_TOOL,SUBAGENT_INSTRUCTIONS} from '../lib/subagents.mjs';
import {applyWorkflowStageEdits,workflowSnapshot} from '../public/next/workspaces/workflow-edit-model.mjs';

const assignment=()=>({scope:'Investigate the supplied records.',inputs:['Original task','Supplied evidence'],
  result:'A checked assessment.',doneWhen:'Claims are supported and material uncertainties are stated.'});
const graph=()=>({id:'assigned-workflow',name:'Investigate and review',nodes:[
  {id:'input',type:'input',name:'Task'},
  {id:'lead',type:'agent',name:'Lead',model:'default',prompt:'Investigate.',sandbox:'danger-full-access',custom:{retain:1}},
  {id:'review',type:'agent',name:'Reviewer',prompt:'Review the evidence.',tools:['custom-tool']},
  {id:'output',type:'output',name:'Result'},
],edges:[{source:'input',target:'lead'},{source:'lead',target:'review'},{source:'review',target:'output'}],
settings:{maxParallel:2,customSetting:true},customWorkflow:{retained:true}});

test('four-field assignments save through the backend without changing graph identity or execution settings',()=>{
  const original=graph(),snapshot=workflowSnapshot(original);
  const edited=applyWorkflowStageEdits(original,{nodes:{lead:{assignment:assignment()}}});
  assert.deepEqual(edited.nodes[1].assignment,assignment());
  assert.equal(Object.hasOwn(edited.nodes[1].assignment,'canWrite'),false);
  assert.equal(edited.nodes[1].sandbox,original.nodes[1].sandbox);
  assert.deepEqual(edited.nodes[1].custom,original.nodes[1].custom);
  assert.deepEqual(edited.nodes[2],original.nodes[2]);
  assert.deepEqual(edited.edges,original.edges);assert.deepEqual(edited.settings,original.settings);
  assert.deepEqual(edited.customWorkflow,original.customWorkflow);
  assert.deepEqual(validateWorkflow(edited).nodes[1].assignment,assignment());
  assert.equal(workflowSnapshot(original),snapshot,'Drafting must leave saved source data untouched.');
});

test('editing descriptive fields preserves legacy and unknown metadata without deriving capabilities',()=>{
  const original=graph();original.nodes[1].assignment={...assignment(),canWrite:false,future:{evidenceFormat:'checked'}};
  const edited=applyWorkflowStageEdits(original,{nodes:{lead:{assignment:{scope:'Compare the supplied reports.'}}}});
  assert.deepEqual(edited.nodes[1].assignment,{...original.nodes[1].assignment,scope:'Compare the supplied reports.'});
  const canonical=validateWorkflow(edited);
  assert.equal(canonical.nodes[1].sandbox,'danger-full-access');
  assert.equal(canonical.nodes[1].assignment.canWrite,false,'Historical metadata remains readable.');
  assert.deepEqual(canonical.nodes[1].assignment.future,{evidenceFormat:'checked'});
  assert.deepEqual(workerAssignmentDescription(canonical.nodes[1].assignment),{
    ...assignment(),scope:'Compare the supplied reports.',
  },'Only descriptive work fields belong in worker instructions.');
  assert.equal(original.nodes[1].assignment.scope,assignment().scope);
});

test('removing an assignment needs only the existing explicit workflow save',()=>{
  const original=graph();original.nodes[1].assignment={...assignment(),canWrite:false};
  const edited=applyWorkflowStageEdits(original,{nodes:{lead:{assignment:null}}});
  assert.equal(Object.hasOwn(edited.nodes[1],'assignment'),false);
  assert.equal(edited.nodes[1].sandbox,original.nodes[1].sandbox);
  assert.ok(original.nodes[1].assignment);assert.doesNotThrow(()=>validateWorkflow(edited));
  assert.doesNotThrow(()=>applyWorkflowStageEdits(graph(),{nodes:{lead:{assignment:null}}}));
});

test('assignments may share work descriptions without introducing access or overlap validation',()=>{
  const edited=applyWorkflowStageEdits(graph(),{nodes:{lead:{assignment:assignment()},review:{assignment:assignment()}}});
  assert.doesNotThrow(()=>validateWorkflow(edited));
  assert.equal(edited.nodes[1].assignment.scope,edited.nodes[2].assignment.scope);
  assert.equal(Object.hasOwn(SUBAGENT_TOOL.inputSchema.properties.tasks.items.properties,'canWrite'),false);
  assert.doesNotMatch(SUBAGENT_INSTRUCTIONS,/canWrite|enforced read-only|file-write permission/);
});

test('frontend and backend agree on bounded descriptive assignment data',()=>{
  const invalid=[null,[],{},...['scope','result','doneWhen'].flatMap(field=>[
    {...assignment(),[field]:' '},{...assignment(),[field]:'x'.repeat(field==='scope'?3001:1001)},
    {...assignment(),[field]:'text\0invalid'},
  ]),...[[1],[' '],['text\0invalid'],['x'.repeat(1001)],Array(201).fill('Source')].map(inputs=>({...assignment(),inputs}))];
  for(const value of invalid){
    const raw=graph();raw.nodes[1].assignment=value;
    assert.throws(()=>validateWorkflow(raw),/assignment|Worker/i);
    if(value!==null)assert.throws(()=>applyWorkflowStageEdits(graph(),{nodes:{lead:{assignment:value}}}),/assignment|Worker/i);
  }
  const edited=applyWorkflowStageEdits(graph(),{nodes:{lead:{assignment:{...assignment(),inputs:['  Original task  ',' Evidence ']}}}});
  assert.deepEqual(edited.nodes[1].assignment.inputs,['Original task','Evidence']);
  assert.throws(()=>applyWorkflowStageEdits(graph(),{nodes:{input:{assignment:assignment()}}}),/Only agent/);
});
