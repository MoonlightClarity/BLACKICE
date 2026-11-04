import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL, TASK_TOOL_V12, TASK_WORKER_TOOL_V12, TASK_INSTRUCTIONS_V12 } from '../lib/task-state.mjs';
import { normalizePlanningReview } from '../lib/planning-review.mjs';
import { createPlanningCompletionController } from '../lib/planning-completion.mjs';
import { PLANNING_DEPTH_INSTRUCTIONS } from '../lib/planning-policy.mjs';

const payload = result => JSON.parse(result.contentItems[0].text);
const review = { decision: 'respond', summary: 'The supplied prices total 14.50; the requested calculation is complete.' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-protocol-recovery-')), cwd = path.join(directory, 'work');
  await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), taskId = 'protocol-recovery';
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.ensure({ taskId, runId: 'run', nodeId: 'agent', cwd, goal: 'Complete the requested calculation.', defaultPlan: true });
  const handler = createTaskToolHandler({ store, taskId, runId: 'run', nodeId: 'agent', planningMode: 'on', executionGuardrails: true });
  const call = args => handler({ name: 'relay_task', arguments: args });
  const accept = async args => { const result = await call(args); assert.equal(result.success, true, result.contentItems[0].text); return payload(result); };
  const write = async args => accept({ ...args, expectedRevision: (await store.get(taskId)).revision });
  const described = await accept({ action: 'describe' });
  const complete = async () => {
    await write(described.plan.example);
    return write(described.step.example);
  };
  return { store, taskId, call, accept, write, described, complete };
}

test('malformed review shapes remain rejected with an object diagnostic and no saved changes; correction uses the same revision', async t => {
  const f = await fixture(t), completed = await f.complete(), before = await readFile(f.store.file(f.taskId));
  for (const value of [JSON.stringify(review), null, [], true, 3, undefined]) {
    const result = await f.call({ action: 'review', expectedRevision: completed.revision, review: value });
    assert.equal(result.code, 'INVALID_PLANNING_REVIEW');
    assert.match(payload(result).error, /^review must be a JSON object, not a JSON-encoded string/);
    assert.match(payload(result).error, /Keep action and expectedRevision at the top level/);
    assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  }
  const unknown = await f.call({ action: 'review', expectedRevision: completed.revision, review: { ...review, thoughts: 'unsupported' } });
  assert.equal(unknown.code, 'INVALID_PLANNING_REVIEW');
  assert.match(payload(unknown).error, /Unsupported review field "thoughts"/);
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  const corrected = await f.accept({ action: 'review', expectedRevision: completed.revision, review });
  assert.equal(corrected.revision, completed.revision + 1);
  assert.deepEqual(corrected.steps, completed.steps, 'Correcting the payload neither repeats nor rewrites completed work.');
  assert.equal(corrected.planningReviews.at(-1).summary, review.summary);
});

test('a misplaced checkpoint is diagnosed by its exact nesting and remains rejected at the same saved revision', async t => {
  const f = await fixture(t), completed = await f.complete(), before = await readFile(f.store.file(f.taskId));
  const userAgency = f.described.agencyCheckpoint.example.operations[0].userAgency;
  const misplaced = await f.call({ action: 'review', expectedRevision: completed.revision, review, userAgency });
  assert.equal(misplaced.code, 'INVALID_PLANNING_REVIEW');
  assert.match(payload(misplaced).error, /inside review\.userAgency, not at the top level/);
  assert.match(payload(misplaced).error, /operations\[i\]\.userAgency/);
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  const corrected = await f.accept({ action: 'review', expectedRevision: completed.revision, review: { ...review, userAgency } });
  assert.equal(corrected.revision, completed.revision + 1);
  assert.deepEqual(corrected.planningReviews.at(-1).userAgency, userAgency);
});

test('current describe examples execute with their declared nesting and blocked reviews retain the actual blocker gate', async t => {
  const f = await fixture(t), example = f.described.review.blockedExample;
  assert.equal(TASK_TOOL.inputSchema.properties.review.type, 'object');
  assert.equal(TASK_TOOL.inputSchema.properties.userAgency, undefined);
  assert.equal(TASK_TOOL.inputSchema.properties.review.properties.userAgency.type, 'object');
  assert.equal(example.userAgency, undefined);
  assert.equal(normalizePlanningReview(example.review, { requireUserAgency: true }).userAgency.action, 'ask');
  assert.match(f.described.review.note, /review\.userAgency/);
  assert.match(f.described.agencyCheckpoint.note, /operations\[i\]\.userAgency/);

  const planned = await f.write({ action: 'plan', plan: { layout: 'sequence' }, steps: [{
    id: 'source', kind: 'action', status: 'active', title: 'Assess the supplied source availability record',
    operation: { kind: 'reasoning', target: 'The supplied lookup receipt for the specifically requested source.' },
    result: 'Whether the requested calculation has its actual source inputs.',
    note: 'Compare the supplied lookup result with the input values needed for the calculation.',
    doneWhen: 'The available inputs or the specific missing source are recorded.'
  }] });
  const premature = await f.call({ ...example, expectedRevision: planned.revision });
  assert.equal(premature.code, 'TASK_PLAN_REASSESSMENT_REQUIRED', 'An example checkpoint cannot manufacture observed work.');
  const blocked = await f.write({ action: 'step', stepId: 'source', status: 'blocked', blockedReason: 'The supplied completed lookup reports the named source absent and no alternative input values.' });
  const before = await readFile(f.store.file(f.taskId));
  for (const userAgency of [undefined, null]) {
    const missing = await f.call({ action: 'review', expectedRevision: blocked.revision, review: { decision: 'blocked', summary: example.review.summary, userAgency } });
    assert.equal(missing.code, 'USER_AGENCY_REQUIRED');
    assert.match(payload(missing).error, /requires review\.userAgency with its quantified ask\/defer comparison/);
    assert.match(payload(missing).error, /routine no-decision checkpoint cannot justify stopping/);
    assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  }
  const routine = await f.call({ action: 'review', expectedRevision: blocked.revision, review: { ...example.review, userAgency: f.described.agencyCheckpoint.example.operations[0].userAgency } });
  assert.equal(routine.code, 'USER_COST_RECALCULATION_REQUIRED', 'Routine progress cannot be relabeled as a justified stop.');
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  const assessed = await f.write(f.described.assessDecision.example);
  assert.equal(assessed.decisionAssessments[0].evaluation.preferredAction, 'ask');
  const reviewed = await f.write(example);
  assert.equal(reviewed.planningReviews.at(-1).userAgency.action, 'ask');
  assert.equal(reviewed.steps[0].status, 'blocked', 'A review records the unresolved result; it does not complete the calculation.');
});

test('routine checkpoint edit and completion recovery use separate exact object paths without demanding a comparison', async t => {
  const f = await fixture(t); await f.complete();
  const saved = await f.write(f.described.agencyCheckpoint.example);
  assert.equal(saved.userAgency.action, 'proceed');
  assert.deepEqual(saved.userAgency.decisions, []);
  const controller = createPlanningCompletionController({ store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent', executionGuardrails: true });
  const pending = await controller.beforeFinal();
  assert.equal(pending.continue, true);
  assert.match(pending.prompt, /review as a JSON object, never a JSON-encoded string/);
  assert.match(pending.prompt, /schema 13 and later.*review\.userAgency/);
  assert.match(PLANNING_DEPTH_INSTRUCTIONS, /Top-level userAgency is invalid; an edit agency_checkpoint instead uses operations\[i\]\.userAgency/);
  await f.write({ action: 'review', review });
  assert.equal((await controller.assertReady()).ready, true);
});

test('schema 12 retains its exact cached catalog and does not advertise schema 13 checkpoint examples', async () => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.deepEqual([TASK_TOOL_V12, TASK_WORKER_TOOL_V12, TASK_INSTRUCTIONS_V12].map(digest), [
    '139dccb986f47b83f1cdb3d48639a4e1a15ca94d61967250b4eb692947592027',
    '2535c0106073f6e03ee82e61647f37161545ffd68dbb9dc1dd2c87ee20ffdcdc',
    'a5eb9739cc4e0f2d7f4a7e10e61947f38d326614f4158d98424d39ee7761d31f'
  ]);
  const handler = createTaskToolHandler({ store: {}, taskId: 'legacy', runId: 'run', nodeId: 'agent', schemaVersion: 12, executionGuardrails: true });
  const described = payload(await handler({ name: 'relay_task', arguments: { action: 'describe' } }));
  assert.equal(described.review.blockedExample, undefined);
  assert.equal(described.agencyCheckpoint, undefined);
  assert.equal(described.assessDecision, undefined);
  assert.equal(described.review.inputSchema.properties.userAgency, undefined);
});
