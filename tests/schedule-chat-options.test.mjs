import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduledChatWorkflow,applyChatProfileToWorkflow,chatProfileFromDeployment,scheduleChatOptionsMarkup} from '../public/next/workspaces/schedule-inspection-model.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
import {normalizePlanningOntology} from '../public/planning-module-policy.mjs';

const oldProfile={model:'gpt-6-luna',effort:'high',serviceTier:'fast',planningMode:'forced',planningExecutionMode:'automatic'};
const context={preset:'custom',windowTokens:100000,autoCompact:false,
  compactAtTokens:60000,keepRecentTokens:12000,outputReserveTokens:8000,headroomTokens:3000};

test('scheduled Chat keeps model and context while retiring Forced under explicit Automatic',()=>{
  const workflow=createScheduledChatWorkflow({task:'Research and summarize new roles',cwd:'C:\\workspace',options:oldProfile,context});
  const nodes=workflow.nodes.filter(node=>node.type==='agent');
  assert.equal(nodes.length,1);
  assert.equal(nodes[0].model,'gpt-6-luna');
  assert.equal(nodes[0].effort,'high');
  assert.equal(nodes[0].serviceTier,'fast');
  assert.equal(workflow.settings.planningMode,'off');
  assert.equal(workflow.settings.planningEnforcement,undefined);
  assert.equal(workflow.settings.planningExecutionMode,'automatic');
  assert.equal(workflow.settings.planningOntology.modules.anti_overalignment,'mandatory');
  assert.deepEqual(nodes[0].context,context);
  assert.deepEqual(workflow.settings.context,context);
  assert.equal(workflow.nodes.length,3);
  assert.equal(workflow.edges.length,2);
  assert.match(workflow.id,/^scheduled_chat_/);
  assert.equal(workflow.settings.cwd,'C:\\workspace');
});

test('scheduled Module and Off choices remain separate from model reasoning effort',()=>{
  const off=createScheduledChatWorkflow({task:'Check results',cwd:'C:\\work',
    options:{...oldProfile,planningMode:'off',planningExecutionMode:'automatic'}});
  assert.equal(off.settings.planningMode,'off');
  assert.equal(off.settings.planningEnforcement,undefined);
  assert.equal(off.settings.planningOntology,undefined);
  assert.equal(off.nodes[1].effort,'high');
  const policy=normalizePlanningOntology({modules:{subagents:'forbidden',anti_overalignment:'mandatory'}});
  const modern=createScheduledChatWorkflow({task:'Review report',cwd:'C:\\work',
    options:{...oldProfile,planningMode:'ontology',planningExecutionMode:'automatic',planningOntology:policy}});
  assert.deepEqual(modern.settings.planningOntology,policy);
  assert.equal(modern.settings.planningExecutionMode,'automatic');
  assert.throws(()=>createScheduledChatWorkflow({task:'Continue unaffected branches',cwd:'C:\\work',options:{...oldProfile,planningMode:'off',planningExecutionMode:'plan_only'}}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
});

test('schedule edits preserve original identity, custom agent instructions and pinned modules',()=>{
  const before=createScheduledChatWorkflow({task:'Analyze reports',cwd:'C:\\work',
    options:{...oldProfile,planningMode:'ontology',planningExecutionMode:'automatic'}});
  before.nodes[1].prompt='User-authored agent behavior';
  before.nodes[1].desktop=true;
  const original=structuredClone(before);
  const policy=normalizePlanningOntology({modules:{decomposition:'forbidden'}});
  const selected={...oldProfile,planningMode:'ontology',planningOntology:policy};
  const updated=applyChatProfileToWorkflow(before,selected,context);
  assert.equal(updated.nodes[1].prompt,'User-authored agent behavior');
  assert.equal(updated.nodes[1].desktop,true);
  assert.equal(updated.settings.planningExecutionMode,'automatic');
  assert.deepEqual(updated.settings.planningOntology,policy);
  assert.deepEqual(before,original);
  const restored=chatProfileFromDeployment({workflow:updated,planningExecutionMode:'plan_only'});
  assert.deepEqual(restored.options,normalizeChatOptions(selected));
  assert.deepEqual(restored.context,context);
  assert.equal(restored.agentCount,1);
});

test('multi-agent saved workflow never silently retargets multiple agents',()=>{
  const workflow=createScheduledChatWorkflow({task:'Research',cwd:'C:\\work',options:oldProfile});
  workflow.nodes.push({...workflow.nodes[1],id:'reviewer',model:'different-model'});
  assert.throws(()=>applyChatProfileToWorkflow(workflow,oldProfile,context),/multi-agent workflow/);
  assert.equal(workflow.nodes[3].model,'different-model');
});

test('schedule editor exposes only Modules and Off and no Plan-only or Forced choices',()=>{
  const html=scheduleChatOptionsMarkup();
  for(const name of ['agentModel','agentEffort','agentServiceTier','planningMode','planningExecutionMode',
    'contextPreset','contextWindowTokens','contextAutoCompact','contextCompactAtTokens',
    'contextKeepRecentTokens','contextOutputReserveTokens','contextHeadroomTokens'])
    assert.match(html,new RegExp('name="'+name+'"'),name);
  for(const value of ['ontology','off','automatic','extended','custom'])
    assert.match(html,new RegExp('value="'+value+'"'));
  assert.doesNotMatch(html,/value="(?:forced|advisory|plan_only)"/);
});
