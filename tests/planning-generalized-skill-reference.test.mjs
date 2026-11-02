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
