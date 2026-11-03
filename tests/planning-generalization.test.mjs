import test from 'node:test';
import assert from 'node:assert/strict';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';
import { PLANNING_DECISION_GUIDANCE } from '../lib/planning-policy.mjs';
import { PLANNING_SKILL_CONTENT } from '../lib/planning-skill.mjs';
import { evaluateViabilityResponse, PLANNING_STOP_KINDS } from '../public/task-viability-model.mjs';

const source = (id, text) => ({ id, kind: 'source', text, contentHash: text });
const sources = [
  source('viability:task', 'The user authorized preparing and submitting this proposal. No success guarantee was requested.'),
  source('viability:profile', 'Prior work shows transferable experience for the proposed deliverable.')
];
const requirement = overrides => ({
  id: 'proposal_assessment', label: 'Recipient selection estimate', importance: 'essential',
  basis: 'external', consequence: 'The recipient may decide whether to accept the proposal.',
  resolution: 'inference', value: 'A plausible submission despite an uncertain chance of acceptance.',
  sourceIds: ['viability:task', 'viability:profile'],
  checkedSourceIds: sources.map(item => item.id),
  rationale: 'Recipient selection is decided after submission, not inferred from a perfect-match checklist.',
  inferable: true, omissionAllowed: false, question: '', dependentNodeIds: ['worker'],
  ...overrides
});
const assess = entry => evaluateViabilityResponse({ requirements: [entry], sources }, sources, { workflowNodeIds: ['worker'] });

test('general operating identity and Planning are task-neutral, not a job-application prompt patch', () => {
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /Third-party selection criteria, preferences, prior scores and apparent gaps are observations/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /recipient or system decide acceptance/);
  assert.match(PLANNING_DECISION_GUIDANCE, /time-stamped, revisable observations/);
  for (const activity of ['applying', 'submitting a proposal', 'editing code', 'investigating a record', 'creating an artifact']) {
    assert.ok(PLANNING_SKILL_CONTENT.includes(activity), 'The general Planning skill must include ' + activity);
  }
  assert.match(PLANNING_SKILL_CONTENT, /observations made under particular conditions and at a particular time/);
});

test('uncertain selection in a non-job proposal is not a host-verified stop', () => {
  const fit = assess(requirement());
  assert.equal(fit.state, 'ready');
  assert.equal(fit.blockingFacts.length, 0);

  const selfRejected = assess(requirement({
    resolution: 'blocked', value: 'The evaluation rubric is demanding and acceptance cannot be guaranteed.',
    rationale: 'A speculative judgment cannot decide the recipient outcome.'
  }));
  assert.equal(selfRejected.state, 'ready');
  assert.equal(selfRejected.unverifiedStopClaims.length, 1);
  assert.equal(selfRejected.blockingFacts.length, 0);
});

test('a concrete denial is distinct from imperfect fit across all task domains', () => {
  assert.deepEqual(PLANNING_STOP_KINDS, [
    'user_prohibited', 'target_denied', 'known_false_certification',
    'human_control_taken', 'unreconciled_dispatch'
  ]);
  const denial = assess(requirement({
    id: 'target_write', label: 'Destination write',
    resolution: 'blocked', stopKind: 'target_denied',
    value: 'The target returned a specific write-denied response.',
    sourceIds: ['viability:task'],
    rationale: 'The exact write to that destination was rejected; use another authorized route.'
  }));
  assert.equal(denial.state, 'blocked');
  assert.equal(denial.blockingFacts[0].resolution, 'blocked');
});
