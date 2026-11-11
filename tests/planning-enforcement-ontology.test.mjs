import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_MODES, PLANNING_MODE_OPTIONS, PLANNING_INPUT_MODES, planningChoice, planningEnforcementOf, planningGuardrailsRequired, normalizePlanningMode } from '../public/planning-mode.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { validateWorkflow } from '../lib/engine.mjs';
import { applyWorkflowStageEdits } from '../public/next/workspaces/workflow-edit-model.mjs';
import { delegatedWorkerInstructions } from '../lib/task-state.mjs';

test('only the new module ontology or Off are selectable; old modes cannot become execution gates', () => {
  assert.deepEqual(PLANNING_MODES, ['ontology', 'off']);
  assert.deepEqual(PLANNING_MODE_OPTIONS.map(option => option.label), ['Modules', 'Off']);
  assert.equal(planningChoice(undefined), 'ontology');
  for (const old of ['on','auto','maximal','forced','advisory']) {
    assert.ok(PLANNING_INPUT_MODES.includes(old), 'historical record remains decodable');
    assert.equal(planningChoice(old), 'ontology');
    assert.equal(normalizePlanningMode(old), 'off');
    assert.equal(planningEnforcementOf(old), null);
  }
  assert.equal(planningChoice('off'), 'off');
  assert.equal(normalizePlanningMode('off'), 'off');
});

test('planning contract guardrails remain disabled regardless of historical On and external-action compatibility preferences', () => {
  for (const mode of ['ontology','off','on','auto','maximal','forced','advisory']) {
    for (const enforcement of [null,'forced','advisory','off']) {
      for (const external of [false,true]) assert.equal(planningGuardrailsRequired(mode,enforcement,external),false);
    }
  }
});

test('new and historically authored workflows normalize without persisting an enforcement requirement', () => {
  for (const mode of PLANNING_INPUT_MODES) {
    const authored=createMissionWorkflow({id:'policy_'+mode,task:'Complete this authorized task.',model:'fixture-model',planningMode:mode});
    const saved=validateWorkflow(authored);
    assert.equal(saved.settings.planningMode,'off');
    assert.equal(saved.settings.planningEnforcement,undefined);
  }
  assert.equal(validateWorkflow(createMissionWorkflow({id:'default',task:'New task'})).settings.planningEnforcement,undefined);
});

test('editing an older workflow retains its actual nodes while never restoring a forced Planning gate', () => {
  const original=validateWorkflow(createMissionWorkflow({id:'edit-modes',task:'One workflow',planningMode:'forced'}));
  const stageIds=original.nodes.map(node=>node.id);
  const edited=validateWorkflow(applyWorkflowStageEdits(original,{workflowSettings:{planningMode:'advisory'}}));
  assert.deepEqual(edited.nodes.map(node=>node.id),stageIds);
  assert.equal(edited.settings.planningMode,'off');
  assert.equal(edited.settings.planningEnforcement,undefined);
  const off=validateWorkflow(applyWorkflowStageEdits(edited,{workflowSettings:{planningMode:'off'}}));
  assert.equal(off.settings.planningMode,'off');
});

test('worker instructions use nonblocking Planning Off with the retired contract disabled', () => {
  const worker=delegatedWorkerInstructions({planningMode:'off',planningGuardrails:false,executionGuardrails:false});
  assert.match(worker,/Planning Off/);
  assert.doesNotMatch(worker,/Forced Planning is active|Planning is advisory/);
});
