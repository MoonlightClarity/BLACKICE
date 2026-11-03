import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_MODES, PLANNING_MODE_OPTIONS, planningChoice, planningEnforcementOf, planningGuardrailsRequired, normalizePlanningMode } from '../public/planning-mode.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { validateWorkflow } from '../lib/engine.mjs';
import { applyWorkflowStageEdits } from '../public/next/workspaces/workflow-edit-model.mjs';
import { delegatedWorkerInstructions } from '../lib/task-state.mjs';

test('Off, Advisory and Forced are the exact three visible choices', () => {
  assert.deepEqual(PLANNING_MODES, ['forced', 'advisory', 'off']);
  assert.deepEqual(PLANNING_MODE_OPTIONS.map(option => option.label), ['Forced', 'Advisory', 'Off']);
  assert.equal(planningChoice(undefined), 'forced');
  assert.equal(planningChoice('on'), 'advisory');
  assert.equal(planningChoice('auto'), 'advisory');
  assert.equal(planningChoice('maximal'), 'advisory');
  assert.equal(planningEnforcementOf('on'), null);
});

test('Forced Planning is independent of legacy external-action guardrails', () => {
  assert.equal(planningGuardrailsRequired('on', 'forced', false), true);
  assert.equal(planningGuardrailsRequired('on', 'forced', true), true);
  assert.equal(planningGuardrailsRequired('on', 'advisory', true), false);
  assert.equal(planningGuardrailsRequired('on', 'advisory', false), false);
  assert.equal(planningGuardrailsRequired('off', 'off', true), false);
  assert.equal(planningGuardrailsRequired('on', null, true), true, 'historical enforced On remains enforced');
  assert.equal(planningGuardrailsRequired('on', null, false), false, 'historical advisory On remains advisory');
  assert.equal(normalizePlanningMode('forced'), 'on');
  assert.equal(normalizePlanningMode('advisory'), 'on');
  assert.equal(normalizePlanningMode('off'), 'off');
});

test('workflow admission preserves three-state policy instead of collapsing to internal On', () => {
  for (const mode of PLANNING_MODES) {
    const authored = createMissionWorkflow({ id: 'policy_'+mode, task: 'Carry out a supported task.', model:'fixture-model', planningMode:mode });
    const saved = validateWorkflow(authored);
    assert.equal(saved.settings.planningMode, mode === 'off' ? 'off' : 'on');
    assert.equal(saved.settings.planningEnforcement, mode);
  }
  const legacy = createMissionWorkflow({ id:'legacy', task:'Historical task', planningMode:'on' });
  assert.equal(validateWorkflow(legacy).settings.planningEnforcement, undefined);
  assert.equal(validateWorkflow(createMissionWorkflow({ id:'new-default', task:'New task' })).settings.planningEnforcement, 'forced');
});

test('workflow edit round-trip retains explicit policy with unchanged stage identity', () => {
  const original = validateWorkflow(createMissionWorkflow({ id:'edit-modes', task:'One workflow', planningMode:'forced' }));
  const stageIds = original.nodes.map(node => node.id);
  const advisory = validateWorkflow(applyWorkflowStageEdits(original, { workflowSettings:{ planningMode:'advisory' } }));
  assert.deepEqual(advisory.nodes.map(node => node.id), stageIds);
  assert.equal(advisory.settings.planningMode, 'on');
  assert.equal(advisory.settings.planningEnforcement, 'advisory');
  const off = validateWorkflow(applyWorkflowStageEdits(advisory, { workflowSettings:{ planningMode:'off' } }));
  assert.equal(off.settings.planningMode, 'off');
  assert.equal(off.settings.planningEnforcement, 'off');
  const inherited = validateWorkflow(applyWorkflowStageEdits(off, { workflowSettings:{ planningMode:null } }));
  assert.equal(inherited.settings.planningMode, undefined);
  assert.equal(inherited.settings.planningEnforcement, undefined);
});

test('delegated worker instructions distinguish Forced Planning from legacy remote-send checkpoints', () => {
  const forced = delegatedWorkerInstructions({ planningMode: 'on', planningGuardrails: true, executionGuardrails: false });
  assert.match(forced, /Forced Planning is active/);
  assert.match(forced, /Legacy execution guardrails being off does not disable this requirement/);
  assert.match(forced, /Authorized external actions may be performed within your assignment/);
  assert.doesNotMatch(forced, /Planning is advisory/);
  assert.doesNotMatch(forced, /The coordinator owns the final remote send/);

  const advisory = delegatedWorkerInstructions({ planningMode: 'on', planningGuardrails: false, executionGuardrails: true });
  assert.match(advisory, /Planning is advisory/);
  assert.match(advisory, /The coordinator owns the final remote send/);
  assert.doesNotMatch(advisory, /Forced Planning is active/);

  const both = delegatedWorkerInstructions({ planningMode: 'on', planningGuardrails: true, executionGuardrails: true });
  assert.match(both, /Forced Planning is active/);
  assert.match(both, /The coordinator owns the final remote send/);
  assert.doesNotMatch(both, /Planning is advisory/);

  const off = delegatedWorkerInstructions({ planningMode: 'off', planningGuardrails: false, executionGuardrails: false });
  assert.match(off, /Planning Off/);
  assert.match(off, /Authorized external actions may be performed within your assignment/);
  assert.doesNotMatch(off, /Forced Planning is active|Planning is advisory/);
});
