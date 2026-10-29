import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { taskPlanMethodDraft, MethodStore } from '../lib/methods.mjs';
import { validateMethodOutline } from '../lib/process-ontology.mjs';
import { normalizeTaskPlan, taskPlanAvailability } from '../lib/task-plan.mjs';
import { applyPlanningEdits } from '../lib/planning-edits.mjs';

const fact = (id, value) => ({ id, value, evidence: `Observed ${id} in the current source.`, ...(value === null ? { known: true } : {}) });
const action = (id, parentId = null) => ({ id, parentId, kind: 'action', title: `Inspect ${id}`, result: `The ${id} source observation.`, note: `Read the named ${id} source once and retain its actual response.`, doneWhen: `The ${id} response or missing-source outcome is recorded.`, operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: `${id}.txt` } });
const compare = (id, op, value) => ({ compare: { left: { fact: id }, op, right: { value } } });
function savedAlgorithm() {
  const initial = { taskId: 'algorithm-method-source', revision: 5, artifacts: [], ...normalizeTaskPlan({
    plan: { layout: 'choice', branch: { if: compare('score', '>=', 90), then: 'high', elif: [{ if: compare('score', '>=', 70), then: 'middle' }], else: 'fallback' }, facts: [fact('score', 95), fact('cached', false), fact('override', true), fact('optional', null), fact('tags', ['verified', 'reviewed'])] },
    steps: [
      { ...action('high'), status: 'done', evidence: 'Read the high source and checked its returned identifier.' },
      { id: 'middle', kind: 'choice', title: 'Choose the middle-score source', branch: { if: { xor: [{ fact: 'cached' }, { fact: 'override' }] }, then: 'middle_cached', else: 'middle_fresh' } },
      action('middle_cached', 'middle'), action('middle_fresh', 'middle'), action('fallback')
    ]
  }) };
  const revisited = applyPlanningEdits(initial, { operations: [{ type: 'revisit', stepId: 'high', reason: 'Inspect the corrected source identifier.' }] });
  const state = { ...initial, ...revisited, revision: 6 };
  assert.equal(state.steps[0].pastAttempts[0].status, 'done');
  return state;
}

test('an algorithm blueprint preserves Boolean structure and operation bindings while clearing observed facts and execution history', () => {
  const source = savedAlgorithm(), before = structuredClone(source), draft = taskPlanMethodDraft(source);
  assert.deepEqual(draft.outline.branch, source.plan.branch);
  assert.deepEqual(draft.outline.steps.find(step => step.id === 'middle').branch, source.steps.find(step => step.id === 'middle').branch);
  assert.deepEqual(draft.outline.steps.find(step => step.id === 'high').operation, source.steps.find(step => step.id === 'high').operation);
  assert.deepEqual(draft.outline.facts, source.plan.facts.map(({ id }) => ({ id, value: null })));
  for (const step of draft.outline.steps) for (const field of ['status', 'selectedChildId', 'evidence', 'reconciliation', 'attempt', 'pastAttempts', 'pastAttemptsOmitted', 'artifactIds']) assert.equal(step[field], undefined, `${field} is task state, not reusable algorithm structure`);
  assert.equal(draft.outline.selectedChildId, undefined);
  const fresh = normalizeTaskPlan({ plan: { layout: draft.outline.layout, branch: draft.outline.branch, facts: draft.outline.facts }, steps: draft.outline.steps });
  assert.equal(fresh.plan.selectedChildId, undefined);
  assert.deepEqual(taskPlanAvailability(fresh).ready, []);
  assert.deepEqual(taskPlanAvailability(fresh).byId.high.condition.missingFactIds, ['score']);
  assert.deepEqual(source, before, 'drafting does not change the live plan or its prior results');
});

test('algorithm methods save and reload with exact nested conditions and unresolved inputs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-algorithm-methods-'));
  const projects = { definition: value => value, create: async () => { throw new Error('A reusable algorithm must not execute a project.'); } };
  const stores = [];
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  const first = await new MethodStore({ dataDir: directory, projects }).init(); stores.push(first);
  const state = savedAlgorithm();
  const saved = await first.saveTaskMethod(state, { name: 'Conditional source inspection', description: 'Read one source selected by observed score and cache conditions.' });
  assert.equal(saved.created, true);
  assert.equal(saved.method.verification, 'unverified');
  const restored = await new MethodStore({ dataDir: directory, projects }).init(); stores.push(restored);
  assert.deepEqual(restored.get(saved.method.id), saved.method);
  const retry = await restored.saveTaskMethod(state, { name: 'Conditional source inspection', description: 'Read one source selected by observed score and cache conditions.' });
  assert.equal(retry.created, false);
  assert.equal(retry.method.id, saved.method.id);
  assert.deepEqual(retry.method.outline.facts, state.plan.facts.map(({ id }) => ({ id, value: null })));
});

test('reusable outlines reject current observations rather than carrying a prior decision into a new task', () => {
  const draft = taskPlanMethodDraft(savedAlgorithm()).outline;
  for (const observation of [fact('score', 95), { id: 'score', value: null, evidence: 'A previous task claimed this.' }, { id: 'score', value: null, known: true }]) assert.throws(() => validateMethodOutline({ ...draft, facts: [observation] }), /unresolved inputs/);
  assert.deepEqual(validateMethodOutline(draft), draft);
});

test('changing a root or ancestor condition does not reuse source instructions for its old branch semantics', () => {
  const source = savedAlgorithm(), definition = taskPlanMethodDraft(source);
  const sourceMethod = { ...definition, id: 'algorithm-template', revision: 3, steps: definition.steps.map(step => ({ ...step, instructions: `Detailed instructions under the original conditions for ${step.id}.` })) };
  const linked = { ...source, plan: { ...source.plan, method: { id: sourceMethod.id, revision: sourceMethod.revision } } };
  const unchanged = taskPlanMethodDraft(linked, {}, { sourceMethod });
  assert.deepEqual(unchanged.steps, sourceMethod.steps, 'the exact source algorithm retains its detailed instructions');
  const changedRoot = structuredClone(linked);
  changedRoot.plan.branch.if.compare.right.value = 80;
  const rootDraft = taskPlanMethodDraft(changedRoot, {}, { sourceMethod });
  assert.notEqual(rootDraft.steps.find(step => step.id === 'high').instructions, sourceMethod.steps.find(step => step.id === 'high').instructions);
  assert.equal(rootDraft.outline.branch.if.compare.right.value, 80);
  const changedAncestor = structuredClone(linked);
  changedAncestor.steps.find(step => step.id === 'middle').branch.if = { not: { fact: 'cached' } };
  const nestedDraft = taskPlanMethodDraft(changedAncestor, {}, { sourceMethod });
  assert.notEqual(nestedDraft.steps.find(step => step.id === 'middle_cached').instructions, sourceMethod.steps.find(step => step.id === 'middle_cached').instructions);
  assert.equal(nestedDraft.steps.find(step => step.id === 'high').instructions, sourceMethod.steps.find(step => step.id === 'high').instructions, 'an unrelated branch keeps its matching source instructions');
});
