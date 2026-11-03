import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskViewArguments } from '../lib/task-tool-view.mjs';
import { PLANNING_SKILL_CONTENT, validatePlanningSkill } from '../lib/planning-skill.mjs';

test('a speculative nonzero Planning offset is rejected with an actionable first-page recovery', () => {
  assert.throws(
    () => validateTaskViewArguments({ action: 'read', view: 'full', offset: 150187, expectedRevision: 316 }),
    error => error?.code === 'INVALID_TASK_VIEW' &&
      /exact nextRead/.test(error.message) &&
      /restart the first page/.test(error.message) &&
      /focused stepId/.test(error.message)
  );
  assert.doesNotThrow(() => validateTaskViewArguments({ action: 'read', view: 'full' }));
  assert.doesNotThrow(() => validateTaskViewArguments({ action: 'read', stepId: 'r22_4fd' }));
  assert.doesNotThrow(() => validateTaskViewArguments({
    action: 'read', view: 'full', offset: 4000, expectedRevision: 316, viewHash: 'a'.repeat(64)
  }));
});

test('mandatory Planning skill teaches cursor-copying and explicitly prohibits speculative offsets', () => {
  assert.equal(validatePlanningSkill(PLANNING_SKILL_CONTENT).version, 3);
  assert.match(PLANNING_SKILL_CONTENT, /Paged Planning reads use exact returned cursors/);
  assert.match(PLANNING_SKILL_CONTENT, /copy the returned nextRead object verbatim/);
  assert.match(PLANNING_SKILL_CONTENT, /Do not invent or increment page offsets/);
  assert.match(PLANNING_SKILL_CONTENT, /Two repeated invalid reads require changing the read strategy/);
});

