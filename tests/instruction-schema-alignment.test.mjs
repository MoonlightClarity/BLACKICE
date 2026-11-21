import {capabilityGuidance} from '../lib/tool-routing.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_TOOL, currentTaskTool, assignedTaskInstructions } from '../lib/task-state.mjs';

const shape = value => {
  if (Array.isArray(value)) return value.map(shape);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, child]) => [key, shape(child)]));
};

test('assigned task guidance uses the current attached work-item API', () => {
  const tool = currentTaskTool({ executionGuardrails: false });
  const text = assignedTaskInstructions(tool, { scopeStepId: 'deliver_file' });
  assert.match(text, /deliver_file/);
  for (const action of ['read', 'focus', 'plan']) assert.ok(tool.inputSchema.properties.action.enum.includes(action));
  for (const field of ['workItemId', 'expectedPlanEpoch', 'expectedRevision', 'contract']) {
    assert.ok(tool.inputSchema.properties[field], field);
    assert.ok(text.includes(field), field);
  }
  assert.doesNotMatch(text, /group.s children|atomic edit|globally unique IDs|stepId|action:"step"/);
});

test('missing or filtered task tools receive no instructions for absent calls', () => {
  assert.equal(assignedTaskInstructions(undefined, { scopeStepId: 'deliver_file' }), '');
  assert.equal(assignedTaskInstructions({ name: 'relay_directory_action' }, { scopeStepId: 'deliver_file' }), '');
  assert.equal(assignedTaskInstructions(TASK_TOOL, null), '');
  const readOnly = { name: 'relay_task', inputSchema: { properties: { action: { enum: ['read'] } } } };
  const text = assignedTaskInstructions(readOnly, { scopeStepId: 'review_file' });
  assert.match(text, /Use read/);
  assert.doesNotMatch(text, /Use focus|Use plan|expectedPlanEpoch|expectedRevision/);
});

test('advisory mode preserves parameter meaning and the actual input schema', () => {
  const advisory = currentTaskTool({ executionGuardrails: false });
  assert.deepEqual(shape(advisory.inputSchema), shape(TASK_TOOL.inputSchema));
  assert.equal(advisory.inputSchema.properties.expectedRevision.description, TASK_TOOL.inputSchema.properties.expectedRevision.description);
  assert.equal(advisory.inputSchema.properties.contract.description, TASK_TOOL.inputSchema.properties.contract.description);
  assert.match(advisory.inputSchema.properties.expectedRevision.description, /plan, bind_receipt, checkpoint and artifact/);
  assert.match(advisory.description, /Optional task record/);
  assert.doesNotMatch(JSON.stringify(advisory.inputSchema), /Optional saved planning metadata/);
});

test('routing does not prescribe revision fields absent from the attached task schema',()=>{
 const tool={name:'relay_task',inputSchema:{type:'object',properties:{action:{type:'string',enum:['read']}}}};
 const guidance=capabilityGuidance([tool],{planningMode:'on',planningContractVersion:14});
 assert.doesNotMatch(guidance,/expectedRevision|expectedPlanEpoch/);
 const withRevision={...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,expectedRevision:{type:'integer'}}}};
 assert.match(capabilityGuidance([withRevision],{planningMode:'on',planningContractVersion:14}),/current expectedRevision/);
});
