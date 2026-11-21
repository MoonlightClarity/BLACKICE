import test from 'node:test';
import assert from 'node:assert/strict';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';
import { analyticalMethodInstructions } from '../lib/analytical-method.mjs';
import { EXECUTION_COMPLETION_RULE } from '../lib/task-completion-guidance.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';

const tool = (name, actions = [], properties = {}) => ({ name, inputSchema: { properties: { action: { enum: actions }, ...properties } } });

test('the built-in core delegates behavior and contains no retired analytical/approval policy', () => {
  assert.equal(analyticalMethodInstructions(), '');
  assert.ok(BLACKICE_HARNESS_INSTRUCTIONS.length < 2500, 'Default adapter contract must remain reviewable; this check never truncates owner text.');
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /SOUL\.md supplies owner-configured behavior/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /Current user directions supersede conflicting behavioral defaults/);
  assert.doesNotMatch(BLACKICE_HARNESS_INSTRUCTIONS, /full quantitative planning contract|GENERAL ANALYTICAL METHOD|FORM COMPLETION|changes require owner approval/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /When input was not dispatched/);
  assert.match(BLACKICE_HARNESS_INSTRUCTIONS, /When an action may have reached its destination/);
  assert.match(EXECUTION_COMPLETION_RULE, /observed host\/time limit/);
});

test('local file routing follows the attached schema instead of advertising a retired find action', () => {
  const current = capabilityGuidance([tool('relay_workspace', ['read', 'list', 'run']), tool('relay_find_files')], { planningMode: 'off' });
  assert.match(current, /Use relay_find_files when the required path is unknown/);
  assert.doesNotMatch(current, /Use action find/);
  assert.doesNotMatch(current, /relay_files|relay_identity|relay_skills/);
  const legacy = capabilityGuidance([tool('relay_workspace', ['read', 'find'])], { planningMode: 'off' });
  assert.match(legacy, /Use action find when the required path is unknown/);
  assert.doesNotMatch(legacy, /relay_find_files/);
  const paths = capabilityGuidance([tool('relay_find_files')]);
  assert.doesNotMatch(paths, /relay_workspace/);
  assert.match(paths, /empty page is not a completed search/);
});

test('browser recovery guidance includes ownership operations only when the attached tool supports them', () => {
  const ordinary = capabilityGuidance([tool('relay_browser', ['open', 'snapshot', 'click'])]);
  assert.match(ordinary, /fresh snapshot and retry/);
  assert.doesNotMatch(ordinary, /take_ownership|stopped-task-recovery/);
  const recovery = capabilityGuidance([tool('relay_browser', ['tabs', 'take_ownership'])]);
  assert.match(recovery, /take_ownership with its exact tab ID, ownerKey, URL and document ID/);
});

test('advisory/off planning introduces no external checkpoint and canonical guidance requires a matching schema', () => {
  const contract = tool('relay_task', ['read', 'plan', 'focus', 'assess'], { contract: { properties: { contractVersion: { enum: [2] } } }, external: {} });
  const advisory = capabilityGuidance([contract], { planningContractVersion: 14 });
  assert.match(advisory, /Planning is Advisory/);
  assert.match(advisory, /current canonical contract revision/);
  assert.doesNotMatch(advisory, /requires prepare\/attempt/);
  const off = capabilityGuidance([contract], { planningMode: 'off', executionGuardrails: true, planningContractVersion: 14 });
  assert.match(off, /Automatic planning is off/);
  assert.doesNotMatch(off, /requires prepare\/attempt/);
  const forced = capabilityGuidance([contract], { executionGuardrails: true, planningContractVersion: 14 });
  assert.match(forced, /requires prepare\/attempt before dispatch/);
  const older = capabilityGuidance([tool('relay_task', ['read'])], { planningContractVersion: 14 });
  assert.doesNotMatch(older, /canonical contract|focus moves|assess records/);
});

test('the brief skill/app guidance does not recreate owner approval or mandatory recovery-copy policy', () => {
  const instructions = capabilityGuidance([tool('relay_skills'), tool('relay_apps', ['save_text'])]);
  assert.match(instructions, /current owner-edited version/);
  assert.match(instructions, /recovery snapshot does not replace it/);
  assert.doesNotMatch(instructions, /changes require owner approval|before ending completed work|independent review evidence|fully reviewed method/);
});
