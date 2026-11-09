import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduledChatWorkflow,applyChatProfileToWorkflow,chatProfileFromDeployment,scheduleChatOptionsMarkup
} from '../public/next/workspaces/schedule-inspection-model.mjs';

const profile={model:'gpt-6-luna',effort:'high',serviceTier:'fast',planningMode:'forced',planningExecutionMode:'plan_only'};
const context={preset:'custom',windowTokens:100000,autoCompact:false,
  compactAtTokens:60000,keepRecentTokens:12000,outputReserveTokens:8000,headroomTokens:3000};

test('scheduled Chat tasks use the same mission shape and all execution settings as Chat',()=>{
  const workflow=createScheduledChatWorkflow({task:'Research and summarize new roles',cwd:'C:\\workspace',options:profile,context});
  const nodes=workflow.nodes.filter(node=>node.type==='agent');
  assert.equal(nodes.length,1);
  const node=nodes[0];
  assert.equal(node.model,'gpt-6-luna');
  assert.equal(node.effort,'high');
  assert.equal(node.serviceTier,'fast');
  assert.equal(workflow.settings.planningMode,'on');
  assert.equal(workflow.settings.planningEnforcement,'forced');
  assert.equal(workflow.settings.planningExecutionMode,'plan_only');
  assert.deepEqual(node.context,context);
  assert.deepEqual(workflow.settings.context,context);
  assert.equal(workflow.nodes.length,3);
  assert.equal(workflow.edges.length,2);
  assert.match(workflow.id,/^scheduled_chat_/);
  assert.equal(workflow.settings.cwd,'C:\\workspace');
});

test('planning is independent from reasoning and automatic execution',()=>{
  const off=createScheduledChatWorkflow({task:'Check results',cwd:'C:\\work',
    options:{...profile,planningMode:'off',planningExecutionMode:'automatic'}});
  assert.equal(off.settings.planningMode,'off');
  assert.equal(off.settings.planningEnforcement,undefined);
  assert.equal(off.nodes[1].effort,'high');
  const advisory=createScheduledChatWorkflow({task:'Review report',cwd:'C:\\work',
    options:{...profile,planningMode:'advisory',planningExecutionMode:'automatic'}});
  assert.equal(advisory.settings.planningEnforcement,'advisory');
  assert.equal(advisory.settings.planningExecutionMode,'automatic');
  assert.throws(()=>createScheduledChatWorkflow({task:'Bad combo',cwd:'C:\\work',
    options:{...profile,planningMode:'off',planningExecutionMode:'plan_only'}}),/Plan only/);
});

test('schedule edits clone pinned workflows, preserving the original and non-chat agent fields',()=>{
  const base=createScheduledChatWorkflow({task:'Analyze reports',cwd:'C:\\work',
    options:{...profile,planningMode:'advisory',planningExecutionMode:'automatic'}});
  base.nodes[1].prompt='User-authored agent behavior';
  base.nodes[1].desktop=true;
  const original=structuredClone(base);
  const changed=applyChatProfileToWorkflow(base,profile,context);
  assert.equal(changed.nodes[1].prompt,'User-authored agent behavior');
  assert.equal(changed.nodes[1].desktop,true);
  assert.equal(changed.settings.planningExecutionMode,'plan_only');
  assert.deepEqual(base,original);
  const settings=chatProfileFromDeployment({workflow:changed,planningExecutionMode:'plan_only'});
  assert.deepEqual(settings.options,profile);
  assert.deepEqual(settings.context,context);
  assert.equal(settings.agentCount,1);
});

test('multi-agent saved workflow never silently retargets multiple agents',()=>{
  const base=createScheduledChatWorkflow({task:'Research',cwd:'C:\\work',options:profile});
  base.nodes.push({...base.nodes[1],id:'reviewer',model:'different-model'});
  assert.throws(()=>applyChatProfileToWorkflow(base,profile,context),/multi-agent workflow/);
  assert.equal(base.nodes[3].model,'different-model');
});

test('create and edit controls expose all standard Chat options including context',()=>{
  const html=scheduleChatOptionsMarkup();
  for(const name of ['agentModel','agentEffort','agentServiceTier','planningMode','planningExecutionMode',
    'contextPreset','contextWindowTokens','contextAutoCompact','contextCompactAtTokens',
    'contextKeepRecentTokens','contextOutputReserveTokens','contextHeadroomTokens'])
    assert.match(html,new RegExp('name="'+name+'"'),name);
  for(const value of ['forced','advisory','off','automatic','plan_only','extended','custom'])
    assert.match(html,new RegExp('value="'+value+'"'));
});
