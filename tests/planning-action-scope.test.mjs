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

test('planning and execution stay aligned with the person requesting help', () => {
  // Applies to an analysis, an independent repair, and a purchasing decision,
  // including the individual budget or other constraints supplied by the user.
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /Throughout planning and execution, represent the person being helped/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /pursue their actual objective, priorities and constraints/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /choose work that advances the outcome they requested/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /Use honest evidence, respect actual constraints and host controls/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /explain consequential uncertainty or conflict/);
  // The principle is also present in the always-on harness, including when
  // optional task planning is off.
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /Represent the person being helped throughout planning and execution/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /actual objectives, priorities and constraints/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /never invent qualifications, results, endorsements/);
  for (const instruction of [BLACKICE_HARNESS_INSTRUCTIONS, PLANNING_DEPTH_INSTRUCTIONS]) {
    assert.match(instruction, /reasonable inferences from the whole record and (?:the )?context/i);
    assert.match(instruction, /missing verbatim statement alone is not a reason to stop/i);
    assert.match(instruction, /material answer remains genuinely unsupported/i);
  }
});

test('representing a product proposal emphasizes supportable value without inventing claims', () => {
  // For a requested product proposal, the guidance supports relevant benefits
  // without treating unrelated missing features as automatic disqualification.
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /represent a person, product or proposal/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /strongest relevant, supportable facts/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /Do not volunteer unrequested gaps, absences, or unfavorable comparisons merely for balance/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /Answer required questions honestly/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /facts necessary to avoid a materially misleading answer/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /do not invent qualifications, results, endorsements/);
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
