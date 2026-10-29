import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_DEPTH_INSTRUCTIONS } from '../lib/planning-policy.mjs';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';
import { taskPlanAvailability } from '../lib/task-plan.mjs';

const action = (id, title, dependsOn = []) => ({ id, title, kind:'action', status:'pending', parentId:null, dependsOn });
const state = steps => ({ planVersion:1, plan:{ layout:'parallel' }, steps });

test('a ready independent repair stays available while other options are compared', () => {
  const plan = state([action('compare', 'Compare future improvements'), action('repair', 'Repair the confirmed broken link')]);
  const available = taskPlanAvailability(plan);
  assert.deepEqual(available.ready, ['compare', 'repair']);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /independent additive actions/i);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /not by itself a prerequisite for an already-ready action/i);
});

test('an explicit prerequisite remains binding for an action', () => {
  const plan = state([action('approval', 'Check the required access'), action('publish', 'Publish the selected version', ['approval'])]);
  const available = taskPlanAvailability(plan);
  assert.equal(available.byId.publish.state, 'waiting');
  assert.equal(available.byId.publish.prerequisites[0].id, 'approval');
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /honor actual dependencies, user-imposed ordering or limits/i);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /user requires a choice|action would foreclose another/i);
});

test('planning and execution keep outcome, evidence and consequence in the supplied guidance', () => {
  // Wiring checks only. Actual judgment is evaluated through matched model runs,
  // not certified by the presence of words in an instruction.
  for (const instruction of [BLACKICE_HARNESS_INSTRUCTIONS, PLANNING_DEPTH_INSTRUCTIONS]) {
    assert.match(instruction, /Plan backward from (?:their|the user’s) desired outcome/);
    assert.match(instruction, /opportunity cost/);
    assert.match(instruction, /(?:Preserve|preserve) (?:their actual|actual user) constraints/);
    assert.match(instruction, /(?:realistic ability|could realistically do the work)/);
  }
  assert.doesNotMatch(BLACKICE_HARNESS_INSTRUCTIONS, /prioritize avoiding catastrophic failure.*in that order/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /likelihood and severity together/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /A missing verbatim statement is not missing evidence/);
});

test('representation guidance distinguishes audience relevance from material factual accuracy', () => {
  for (const instruction of [BLACKICE_HARNESS_INSTRUCTIONS, PLANNING_DEPTH_INSTRUCTIONS]) {
    assert.match(instruction, /actual question/);
    assert.match(instruction, /(?:unasked weaknesses)/);
    assert.match(instruction, /private negotiating limits/);
    assert.match(instruction, /Answer material factual questions accurately/);
    assert.match(instruction, /(?:never invent|without inventing) (?:qualifications|claims)/);
  }
});

test('both planning modes keep the current direction distinct from past background and select artifacts for the audience', () => {
  for (const instruction of [BLACKICE_HARNESS_INSTRUCTIONS, PLANNING_DEPTH_INSTRUCTIONS]) {
    assert.match(instruction, /(?:stated interests|stated aims)/i);
    assert.match(instruction, /past (?:domains and experience|work or subject matter) as evidence/i);
    assert.match(instruction, /(?:adjacent options)/i);
    assert.match(instruction, /(?:audience|audience fit)/i);
    assert.match(instruction, /(?:explicit artifact selection|explicit user choices)/i);
  }
});

test('the authorized outcome includes necessary routine steps but not unrelated actions', () => {
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /ordinary steps needed to complete it/i);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /do not add per-step reconfirmations/i);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /user constraints and actual host or service controls/i);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /does not authorize unrelated actions/i);
});
