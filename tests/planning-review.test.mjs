import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler, TASK_LIMITS, TASK_SCHEMA_VERSION, TASK_TOOL, TASK_TOOL_V9, TASK_WORKER_TOOL_V9,
  TASK_INSTRUCTIONS_V9, taskToolForVersion, taskWorkerToolForVersion, taskInstructionsForVersion } from '../lib/task-state.mjs';
import { planningReviewStatus, planningReviewSignature, PLANNING_REVIEW_LIMITS } from '../lib/planning-review.mjs';
import { createSequentialPlanningGuard, planningSequenceStatus } from '../lib/planning-sequence.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const outcome = 'The supplied values were compared; the observed subtotal is 14.50.';
const leaf = (id = 'compare', status = 'active', parentId = null) => ({ id, kind: 'action', parentId, status,
  title: `Compare the supplied values for ${id}`, operation: { kind: 'reasoning', target: `The supplied price pair for ${id}.` },
  result: 'The checked subtotal and any discrepancy.', note: 'Add the two supplied decimal prices and compare the sum against the supplied subtotal.',
  doneWhen: 'The sum and comparison finding have been recorded.' });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-review-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), taskId = 'review-fixture';
  await store.ensure({ taskId, runId: 'run', nodeId: 'agent', cwd, goal: 'Compare the supplied prices.', defaultPlan: true });
  const context = { workEpoch: 0, directionFingerprint: 'original-request' };
  const makeHandler = options => createTaskToolHandler({ store, taskId, runId: 'run', nodeId: 'agent', planningMode: 'on', getReviewContext: () => ({ ...context }), ...options });
  const handler = makeHandler();
  const call = args => handler({ name: 'relay_task', arguments: args });
  const accept = async args => { const result = await call(args); assert.equal(result.success, true, result.contentItems[0].text); return payload(result); };
  const write = async args => accept({ expectedRevision: (await store.get(taskId)).revision, ...args });
  const plan = (steps = [leaf()], plan = { layout: 'sequence' }) => write({ action: 'plan', steps, plan });
  const finish = (stepId = 'compare') => write({ action: 'step', stepId, status: 'done', evidence: outcome });
  const review = (decision = 'respond', extra = {}) => write({ action: 'review', review: { decision, summary: 'The supplied price comparison is complete and its exact result has been checked.', ...extra } });
  const status = state => planningReviewStatus(state, { runId: 'run', nodeId: 'agent', context });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, taskId, directory, cwd, context, makeHandler, call, accept, write, plan, finish, review, status };
}

test('schema 10 exposes review while the schema 9 tool, worker and instructions retain their exact catalog identities', () => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(TASK_SCHEMA_VERSION, 10);
  assert.ok(TASK_TOOL.inputSchema.properties.action.enum.includes('review'));
  assert.equal(digest(TASK_TOOL_V9), 'f0bf0f289ab9375bdcd9dabbbdb26ca4c1203606860ffa3f55cca41f1cdda43e');
  assert.equal(digest(TASK_WORKER_TOOL_V9), '5afe056db14867f1e5ecfafca46e701123ee2e8352959c6e6feea37ac6c7a7bb');
  assert.equal(digest(TASK_INSTRUCTIONS_V9), '47822f983a3d6747f910c9e1b4f50a4603c5b2cc32b084dcde2ceb24692ccfab');
  assert.equal(taskToolForVersion(9), TASK_TOOL_V9);
  assert.equal(taskWorkerToolForVersion(9), TASK_WORKER_TOOL_V9);
  assert.equal(taskInstructionsForVersion(9), TASK_INSTRUCTIONS_V9);
});

test('a plan or completion status alone is not a return to planning; explicit review is durable and does not invalidate itself', async t => {
  const f = await fixture(t), planned = await f.plan();
  const before = await readFile(f.store.file(f.taskId));
  const premature = await f.call({ action: 'review', expectedRevision: planned.revision, review: { decision: 'respond', summary: 'I plan to finish.' } });
  assert.equal(premature.code, 'TASK_PLAN_REASSESSMENT_REQUIRED');
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  const completed = await f.finish();
  assert.equal(f.status(completed).ready, false);
  const reviewed = await f.review();
  assert.equal(reviewed.revision, completed.revision + 1);
  assert.equal(reviewed.planningReviews.at(-1).reviewedRevision, completed.revision);
  assert.equal(reviewed.planningReviews.at(-1).signature, planningReviewSignature(reviewed));
  assert.equal(f.status(reviewed).ready, true);
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init();
  try { assert.equal(f.status(await reopened.get(f.taskId)).ready, true); } finally { await reopened.close(); }
  assert.equal(f.status(await f.accept({ action: 'read' })).ready, true, 'A read does not itself invalidate the review.');
});

test('review input is strict, revisioned, and unavailable through frozen schema 9', async t => {
  const f = await fixture(t); await f.plan(); const completed = await f.finish();
  for (const review of [{ decision: 'respond', summary: '' }, { decision: 'respond', summary: 'Checked', thoughts: 'unsupported' },
    { decision: 'respond', summary: 'Checked', nextStepId: 'compare' }, { decision: 'continue', summary: 'More work' },
    { decision: 'respond', summary: 'x'.repeat(1201) }]) {
    const response = await f.call({ action: 'review', expectedRevision: completed.revision, review });
    assert.equal(response.success, false);
    assert.equal((await f.store.get(f.taskId)).revision, completed.revision);
  }
  assert.equal((await f.call({ action: 'review', review: { decision: 'respond', summary: 'Checked' } })).code, 'TASK_STATE_REVISION_REQUIRED');
  assert.equal((await f.call({ action: 'review', expectedRevision: completed.revision - 1, review: { decision: 'respond', summary: 'Checked' } })).code, 'TASK_STATE_CONFLICT');
  assert.equal((await f.call({ action: 'review', expectedRevision: completed.revision, review: { decision: 'respond', summary: 'Checked' }, status: 'done' })).code, 'INVALID_PLANNING_REVIEW');
  const old = f.makeHandler({ schemaVersion: 9 });
  assert.equal((await old({ name: 'relay_task', arguments: { action: 'review', expectedRevision: completed.revision, review: { decision: 'respond', summary: 'Checked' } } })).code, 'TASK_SCHEMA_UNSUPPORTED');
  const described = payload(await f.call({ action: 'describe' }));
  assert.equal(described.review.example.action, 'review');
  assert.match(described.review.note, /status update alone is not review/);
});

test('continue points at one eligible saved leaf and never authorizes a final response', async t => {
  const f = await fixture(t); await f.plan([leaf(), leaf('check', 'pending')]); await f.finish();
  const rejected = await f.call({ action: 'review', expectedRevision: (await f.store.get(f.taskId)).revision, review: { decision: 'respond', summary: 'A second check remains.' } });
  assert.equal(rejected.code, 'TASK_PLAN_REVIEW_INCOMPLETE');
  const continued = await f.review('continue', { nextStepId: 'check' });
  assert.equal(f.status(continued).current, true); assert.equal(f.status(continued).ready, false);
  await f.write({ action: 'step', stepId: 'check', status: 'active' });
  const activeReview = await f.review('continue', { nextStepId: 'check' });
  assert.equal(activeReview.planningReviews.at(-1).nextStepId, 'check');
  await f.finish('check');
  assert.equal(f.status(await f.review()).ready, true);
});

test('respond ignores unchosen alternatives but cannot bypass an unresolved later condition', async t => {
  const f = await fixture(t);
  const choice = { id: 'choose', kind: 'choice', title: 'Select the observed route', branch: { if: false, then: 'first', elif: [{ if: { fact: 'observed' }, then: 'second' }], else: 'last' } };
  await f.plan([leaf(), choice, leaf('first', 'pending', 'choose'), leaf('second', 'pending', 'choose'), leaf('last', 'pending', 'choose')], { layout: 'sequence', facts: [{ id: 'observed', value: null }] });
  const completed = await f.finish();
  const unresolved = await f.call({ action: 'review', expectedRevision: completed.revision, review: { decision: 'respond', summary: 'The branch still has unknown evidence.' } });
  assert.equal(unresolved.code, 'TASK_PLAN_REVIEW_INCOMPLETE');
  await f.write({ action: 'edit', operations: [{ type: 'metadata', patch: { facts: [{ id: 'observed', value: true, evidence: 'The supplied flag was observed true.' }] } }] });
  await f.write({ action: 'step', stepId: 'second', status: 'active' }); await f.finish('second');
  const reviewed = await f.review();
  assert.equal(f.status(reviewed).ready, true);
  assert.equal(reviewed.steps.find(step => step.id === 'first').status, 'pending');
  assert.equal(reviewed.steps.find(step => step.id === 'last').status, 'pending');
});

test('blocked needs an actual reported obstacle and cannot abandon independent ready work', async t => {
  const f = await fixture(t); await f.plan([leaf(), leaf('other', 'pending')], { layout: 'parallel' });
  const blocked = await f.write({ action: 'step', stepId: 'compare', status: 'blocked', blockedReason: 'The necessary second input is absent.' });
  const rejected = await f.call({ action: 'review', expectedRevision: blocked.revision, review: { decision: 'blocked', summary: 'One input is absent.' } });
  assert.equal(rejected.code, 'TASK_PLAN_REVIEW_NOT_BLOCKED');
  await f.write({ action: 'step', stepId: 'other', status: 'active' }); await f.finish('other');
  const reviewed = await f.review('blocked');
  assert.equal(f.status(reviewed).ready, true);
  assert.equal(reviewed.steps.find(step => step.id === 'compare').status, 'blocked');
});

test('skipping every action does not manufacture a completed outcome', async t => {
  const f = await fixture(t); await f.plan();
  const skipped = await f.write({ action: 'step', stepId: 'compare', status: 'skipped', skipReason: 'The comparison was not performed.' });
  assert.equal((await f.call({ action: 'review', expectedRevision: skipped.revision, review: { decision: 'respond', summary: 'No action was performed.' } })).code, 'TASK_PLAN_REASSESSMENT_REQUIRED');
});

test('new context, facts, artifacts or external effects invalidate review while bounded outcome markers survive history rotation', async t => {
  const f = await fixture(t); await f.plan(); await f.finish(); const first = await f.review();
  f.context.workEpoch++;
  assert.equal(f.status(first).ready, false);
  await f.review(); f.context.directionFingerprint = 'changed-user-request';
  assert.equal(f.status(await f.store.get(f.taskId)).ready, false);
  await f.review();
  const changed = await f.write({ action: 'edit', operations: [{ type: 'metadata', patch: { facts: [{ id: 'new_input', value: 3, evidence: 'The corrected supplied value is 3.' }] } }] });
  assert.equal(f.status(changed).ready, false);
  await f.review();
  const file = path.join(f.cwd, 'result.txt'); await writeFile(file, '14.50');
  const artifact = await f.write({ action: 'artifact', path: file });
  assert.equal(f.status(artifact).ready, false);
  await f.review();
  const prepared = await f.write({ action: 'external', external: { operation: 'prepare', receiptId: 'saved-effect', destination: 'https://example.invalid/result', content: 'The exact authorized result.' } });
  assert.equal(f.status(prepared).ready, false);
  for (let index = 0; index < 34; index++) await f.review('respond', { summary: `The checked result is unchanged after reassessment ${index}.` });
  const saved = await f.store.get(f.taskId);
  assert.ok(saved.planningReviews.length <= PLANNING_REVIEW_LIMITS.history);
  assert.ok(JSON.stringify(saved.planningReviews).length <= PLANNING_REVIEW_LIMITS.historyChars);
  assert.equal(f.status(saved).ready, true);
  const differentRun = f.makeHandler({ runId: 'later-run' });
  const denied = await differentRun({ name: 'relay_task', arguments: { action: 'review', expectedRevision: saved.revision, review: { decision: 'respond', summary: 'Reuse old completed work.' } } });
  assert.equal(denied.code, 'TASK_PLAN_REASSESSMENT_REQUIRED');
});

test('a scoped worker can review its own work while independent sibling work remains pending', async t => {
  const f = await fixture(t);
  await f.plan([{ id: 'mine', kind: 'sequence', title: 'Assigned comparison' }, leaf('own', 'active', 'mine'),
    { id: 'theirs', kind: 'sequence', title: 'Other comparison' }, leaf('other', 'pending', 'theirs')], { layout: 'parallel' });
  const handler = f.makeHandler({ nodeId: 'worker', scopeStepId: 'mine', worker: true });
  const accept = async args => { const response = await handler({ name: 'relay_task', arguments: { expectedRevision: (await f.store.get(f.taskId)).revision, ...args } }); assert.equal(response.success, true, response.contentItems[0].text); return payload(response); };
  await accept({ action: 'step', stepId: 'own', status: 'done', evidence: outcome });
  const saved = await accept({ action: 'review', review: { decision: 'respond', summary: 'The assigned comparison is complete; other work belongs to its separate owner.' } });
  assert.equal(planningReviewStatus(saved, { runId: 'run', nodeId: 'worker', scopeStepId: 'mine', context: f.context }).ready, true);
  assert.equal(f.status(saved).ready, false, 'A worker review cannot substitute for coordinator review.');
  const changed = await f.write({ action: 'edit', operations: [{ type: 'update', stepId: 'other', patch: { note: 'Use the corrected supplied prices for the other independent comparison.' } }] });
  assert.equal(planningReviewStatus(changed, { runId: 'run', nodeId: 'worker', scopeStepId: 'mine', context: f.context }).ready, true);
});

test('scoped review can hand off observed work while the coordinator owns an uncertain external receipt', async t => {
  const f = await fixture(t);
  await f.plan([{ id: 'mine', kind: 'sequence', title: 'Assigned verification' }, leaf('own', 'active', 'mine'),
    { id: 'theirs', kind: 'sequence', title: 'Other comparison' }, leaf('other', 'pending', 'theirs')], { layout: 'parallel' });
  await f.write({ action: 'external', external: { operation: 'prepare', receiptId: 'external-effect', destination: 'https://example.invalid/result', content: 'The exact authorized result.' } });
  await f.write({ action: 'external', external: { operation: 'attempt', receiptId: 'external-effect' } });
  const handler = f.makeHandler({ reviewScopeStepId: 'mine' });
  const accept = async args => { const response = await handler({ name: 'relay_task', arguments: { expectedRevision: (await f.store.get(f.taskId)).revision, ...args } }); assert.equal(response.success, true, response.contentItems[0].text); return payload(response); };
  await accept({ action: 'step', stepId: 'own', status: 'done', evidence: 'The assigned supplied observation was inspected; the coordinator owns the final external reconciliation.' });
  const reviewed = await accept({ action: 'review', review: { decision: 'respond', summary: 'The assigned observation is ready to hand back; the coordinator must reconcile its external receipt.' } });
  const status = state => planningReviewStatus(state, { runId: 'run', nodeId: 'agent', scopeStepId: 'mine', context: f.context });
  assert.equal(status(reviewed).ready, true);
  const edited = await accept({ action: 'edit', operations: [{ type: 'update', stepId: 'other', patch: { note: 'Compare the other supplied pair against its corrected subtotal.' } }] });
  assert.equal(status(edited).ready, true, 'A separate review scope does not remove coordinator editing authority or wait for sibling work.');
  const confirmed = await f.write({ action: 'external', external: { operation: 'confirm', receiptId: 'external-effect', url: 'https://example.invalid/result/observed', evidence: 'The actual destination contains the exact expected result.' } });
  assert.equal(status(confirmed).ready, true, 'Coordinator receipt updates do not stale an independent scoped handoff.');
});

test('a near-limit plan retains room for its mandatory review and old reviews compact before new work', async t => {
  const f = await fixture(t); await f.plan(); await f.finish();
  const raw = JSON.parse(await readFile(f.store.file(f.taskId), 'utf8')).history.at(-1), facts = [];
  const projected = { ...raw, plan: { ...raw.plan, facts } }, target = 55400;
  while (JSON.stringify(projected).length < target) {
    const fact = { id: `fixture_value_${facts.length}`, value: 'x'.repeat(2000), evidence: 'Supplied fixture value.' };
    facts.push(fact);
    const excess = JSON.stringify(projected).length - target;
    if (excess > 0) { assert.ok(excess < fact.value.length); fact.value = fact.value.slice(0, -excess); }
  }
  await f.write({ action: 'edit', operations: [{ type: 'metadata', patch: { facts } }] });
  const summary = 'The supplied comparison is complete. ' + 'x'.repeat(1100);
  for (let index = 0; index < 12; index++) await f.review('respond', { summary });
  const saved = JSON.parse(await readFile(f.store.file(f.taskId), 'utf8')).history.at(-1);
  assert.ok(JSON.stringify(saved).length > TASK_LIMITS.agentStateChars, 'The current review uses the existing bounded runtime reserve.');
  assert.ok(JSON.stringify(saved).length <= TASK_LIMITS.stateChars);
  assert.equal(saved.provenance.source, 'agent');
  assert.equal(f.status(saved).ready, true);
  const updated = await f.write({ action: 'edit', operations: [{ type: 'metadata', patch: { goal: 'Compare the same supplied prices and retain their checked result.' } }] });
  const next = JSON.parse(await readFile(f.store.file(f.taskId), 'utf8')).history.at(-1);
  assert.ok(JSON.stringify(next).length <= TASK_LIMITS.agentStateChars, 'Optional old summaries cannot crowd new ordinary work out of its original budget.');
  assert.equal(f.status(updated).ready, false);
  assert.equal(f.status(await f.review()).ready, true);
});

test('review waits for actual dispatch settlement and reported outcome; uncertainty permits only a truthful blocked review', async t => {
  const f = await fixture(t);
  const operation = { ...leaf(), operation: { kind: 'tool', tool: 'relay_workspace', action: 'write', target: 'result.txt' }, note: 'Write one exact supplied result to result.txt.' };
  const planned = await f.plan([operation]);
  const guard = createSequentialPlanningGuard({ store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent', schemaVersion: 10 });
  const call = { name: 'relay_workspace', arguments: { action: 'write', path: 'result.txt', text: '14.50' }, callId: 'observed-write' };
  assert.equal(await guard.before(call, { expectedRevision: planned.revision }), null);
  assert.equal((await planningSequenceStatus(f.store, f.taskId, planned)).running.length, 1);
  assert.equal((await f.call({ action: 'review', expectedRevision: planned.revision, review: { decision: 'respond', summary: 'The operation is still running.' } })).code, 'TASK_PLAN_STEP_IN_FLIGHT');
  await guard.after(call, { success: false, contentItems: [{ type: 'inputText', text: 'The result was lost.' }] }, { uncertain: true });
  assert.equal((await f.call({ action: 'review', expectedRevision: planned.revision, review: { decision: 'respond', summary: 'The outcome has not been saved.' } })).code, 'TASK_PLAN_RESULT_REQUIRED');
  const blocked = await f.write({ action: 'step', stepId: 'compare', status: 'blocked', blockedReason: 'The dispatched write has no confirmed response; its effect remains uncertain and cannot currently be inspected.' });
  assert.equal((await planningSequenceStatus(f.store, f.taskId, blocked)).uncertain.length, 1);
  const reviewed = await f.review('blocked', { summary: 'The write result was lost; the saved action remains blocked with its effect uncertain. No completion is claimed.' });
  assert.equal(f.status(reviewed).ready, true);
  assert.equal(reviewed.planningReviews.at(-1).sequenceSignature, (await planningSequenceStatus(f.store, f.taskId, reviewed)).signature);
});
