import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANNING_SKILL_CONTENT, planningSkillInstructions, validatePlanningSkill } from '../lib/planning-skill.mjs';

const evidenceReference = readFileSync(new URL('../skills/planning/references/evidence-preserving-execution.md', import.meta.url), 'utf8');

test('Planning skill keeps a valid, universal nine-section contract', () => {
  const description = validatePlanningSkill(PLANNING_SKILL_CONTENT);
  assert.equal(description.id, 'blackice-planning');
  assert.deepEqual([...PLANNING_SKILL_CONTENT.matchAll(/^## (\d+)\. /gm)].map(match => Number(match[1])), [1,2,3,4,5,6,7,8,9]);
  assert.equal(planningSkillInstructions('off'), '');
  assert.ok(planningSkillInstructions('on').includes(PLANNING_SKILL_CONTENT));
  assert.match(PLANNING_SKILL_CONTENT, /time|revisable observations/i);
  assert.match(PLANNING_SKILL_CONTENT, /evidence-preserving-execution\.md/);
});

test('Historical job-search lessons are examples, not global disqualification rules', () => {
  assert.match(evidenceReference, /Domain-general/);
  assert.match(evidenceReference, /Non-job illustration/);
  assert.match(evidenceReference, /Job-search illustration/);
  assert.match(evidenceReference, /time-indexed and revisable/);
  assert.match(evidenceReference, /another party's likely acceptance|A third party's stated preferences|third party's preferences/i);
  assert.match(evidenceReference, /Do not self-reject/);
  assert.match(evidenceReference, /never invent a credential|never manufacture a credential|never manufacture.*credential/i);
});

test('Evidence loss and incomplete observation cannot be relabeled as a negative result', () => {
  assert.match(PLANNING_SKILL_CONTENT, /Preserve full source records before filtering/);
  assert.match(evidenceReference, /source failures as failures rather than zero results/);
  assert.match(evidenceReference, /Raw corpus remains recoverable/);
  assert.match(evidenceReference, /A broken fetcher, missing description, stale identifier/);
});

test('Uncertainty alone cannot authorize a stop; actual stops are scoped to the operation', () => {
  assert.match(PLANNING_SKILL_CONTENT, /Do not treat residual uncertainty/);
  assert.match(PLANNING_SKILL_CONTENT, /continue independent ready work/);
  for (const category of ['user_prohibited', 'target_denied', 'known_false_certification', 'human_control_taken', 'unreconciled_dispatch']) {
    assert.ok(evidenceReference.includes(category), category);
  }
  assert.match(evidenceReference, /an unverified assertion, not authority to stop/);
});

test('Real-world effects remain distinct from accepted tool calls, and corrections trigger replanning', () => {
  assert.match(PLANNING_SKILL_CONTENT, /correct|revisit/i);
  assert.match(evidenceReference, /Tool success misreported as external success/);
  assert.match(evidenceReference, /Destination state/);
  assert.match(evidenceReference, /User correction ignored downstream/);
});

test('A repairable prerequisite never replaces an unfinished external action', () => {
  assert.match(PLANNING_SKILL_CONTENT, /new prerequisite observation, source lookup, diagnosis or format conversion must be a distinct preparatory leaf/);
  assert.match(PLANNING_SKILL_CONTENT, /not a replacement for a pending write, delivery, application, or verification/);
  assert.match(PLANNING_SKILL_CONTENT, /record the work as a next executable step and recheck afterward/);
  assert.match(PLANNING_SKILL_CONTENT, /An observed stop applies only to the exact operation/);
});

test('The same skill prioritizes fresh evidence and explains two independent task domains', () => {
  assert.match(PLANNING_SKILL_CONTENT, /Reuse current evidence/);
  assert.match(PLANNING_SKILL_CONTENT, /source changes, its scope fails to answer the next operation, or newer evidence contradicts it/);
  assert.match(PLANNING_SKILL_CONTENT, /Worked job-search example/);
  assert.match(PLANNING_SKILL_CONTENT, /Worked non-job example/);
  assert.match(PLANNING_SKILL_CONTENT, /For a code repair/);
});

test('Installer includes the mandatory Planning reference, not just SKILL.md', () => {
  const manifest = readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
  assert.match(manifest, /skills\/planning\/\*\*\/\*/);
});


test('historical external effects do not imply current postconditions after restart', () => {
  assert.match(PLANNING_SKILL_CONTENT, /Distinguish historical effects from current postconditions/);
  assert.match(PLANNING_SKILL_CONTENT, /does not prove the target still has that state after a restart/);
  assert.match(PLANNING_SKILL_CONTENT, /preserve the completed historical step and create a new dependent restore\/revisit action/);
  assert.match(PLANNING_SKILL_CONTENT, /changed files, settings, deployments, reservations and other delegated tasks/);
});

test('reset form is repaired from evidence without treating past fills as current', () => {
  assert.match(PLANNING_SKILL_CONTENT, /In a form that reset, re-enter all missing required values/);
  assert.match(PLANNING_SKILL_CONTENT, /do not mark past successful fills as sufficient for the new form instance/);
});
