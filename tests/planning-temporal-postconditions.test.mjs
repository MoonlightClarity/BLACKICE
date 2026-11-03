import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_SKILL_CONTENT, validatePlanningSkill, planningSkillInstructions } from '../lib/planning-skill.mjs';

test('time-indexed effect receipts never substitute for current external state', () => {
  const skill = validatePlanningSkill(PLANNING_SKILL_CONTENT);
  assert.equal(skill.version, 3);
  assert.match(skill.content, /Distinguish historical effects from current postconditions/);
  assert.match(skill.content, /does not prove the target still has that state after a restart/);
  assert.match(skill.content, /preserve the completed historical step and create a new dependent restore\/revisit action/);
  assert.match(skill.content, /changed files, settings, deployments, reservations and other delegated tasks/);
});

test('a reset form requires new observed effects instead of replaying historical completion', () => {
  const on = planningSkillInstructions('on');
  assert.match(on, /In a form that reset, re-enter all missing required values/);
  assert.match(on, /do not mark past successful fills as sufficient for the new form instance/);
  assert.equal(planningSkillInstructions('off'), '');
});
