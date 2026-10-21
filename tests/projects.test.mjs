import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore, parseProjectVerdict, PROJECT_LIMITS } from '../lib/projects.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { applyMethodPreview, projectPlan } from '../public/process-model.mjs';

class Engine extends EventEmitter {
  constructor(capacity = 1) { super(); this.runs = new Map(); this.executions = new Map(); this.calls = []; this.maxConcurrentRuns = capacity; this.closed = false; }
  listRuns() { return structuredClone([...this.runs.values()]); }
  startRun(request) {
    const existing = this.listRuns().find(run => run.metadata.clientRequestId === request.requestId); if (existing) return existing;
    if (this.executions.size >= this.maxConcurrentRuns) throw Object.assign(new Error('All slots are busy.'), { status: 409 });
    this.calls.push(structuredClone(request)); const run = { id: `run-${this.calls.length}`, status: 'running', settled: false, nodes: { agent: { output: '' } }, metadata: { clientRequestId: request.requestId } };
    this.runs.set(run.id, run); this.executions.set(run.id, true); if (this.loseAck) { this.loseAck = false; throw Error('Admission acknowledgement lost.'); } return structuredClone(run);
  }
  finish(id, output = 'Implementation is complete.', status = 'completed', settled = true) {
    const run = this.runs.get(id); Object.assign(run, { status, settled, finishedAt: new Date().toISOString(), output: `[Agent]\n${output}`, nodes: { agent: { output } } }); if (settled) this.executions.delete(id);
    this.emit('event', { type: 'run.updated', data: structuredClone(run) });
  }
}
const task = (id = 'build', extra = {}) => ({ id, title: `Task ${id}`, instructions: `Implement ${id}.`, acceptanceCriteria: [`${id} result is checked`], dependsOn: [], ...extra });
const verdict = (criteria, passed = true) => JSON.stringify({ passed, summary: passed ? 'Observed the acceptance checks; scope is limited to these checks.' : 'The saved result does not meet the requirement.', criteria: criteria.map(criterion => ({ criterion, passed, evidence: passed ? 'Read the produced file and checked its expected content.' : 'The produced file is missing the required content.' })) });
async function fixture(t, { engine = new Engine(), paused = () => false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-projects-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const stores = [], make = async () => { const store = await new ProjectStore({ dataDir: directory, engine, isPaused: paused }).init(); clearTimeout(store.timer); store.timer = null; store.kick = () => {}; stores.push(store); return store; }, store = await make();
  t.after(async () => { for (const instance of stores) await instance.close(); assert.match(path.basename(directory), /^blackice-projects-/); await rm(directory, { recursive: true, force: true }); });
  const create = value => store.create({ name: 'Verified project', objective: 'Produce and independently check the requested outcome.', cwd, tasks: [task()], ...value });
  const complete = async (projectId, passed = true) => { const project = store.get(projectId), current = project.tasks.find(item => ['running', 'verifying'].includes(item.status)), phase = current.status === 'verifying' ? current.attempts.at(-1).verification : current.attempts.at(-1).implementation; engine.finish(phase.runId, current.status === 'verifying' ? verdict(current.acceptanceCriteria, passed) : 'Changed the requested file; independent checks still required.'); await store.poll(); };
  return { directory, cwd, engine, store, create, complete, make };
}

async function externalReceipt(t, { directory, cwd, engine }, runId, { status = 'uncertain', backupRecovery = false } = {}) {
  const state = await new TaskStateStore({ dataDir: directory }).init(); t.after(() => state.close());
  await state.ensure({ taskId: runId, runId, nodeId: 'agent', cwd, goal: 'Record one authorized fixture publication.' });
  const apply = async value => state.externalAction(runId, value, { expectedRevision: (await state.get(runId)).revision, runId, nodeId: 'agent' });
  await apply({ receiptId: 'fixture-publication', operation: 'prepare', destination: 'https://example.com/updates', content: 'One authorized fixture publication.' });
  if (status !== 'prepared') await apply({ receiptId: 'fixture-publication', operation: 'attempt' });
  if (status === 'confirmed') await apply({ receiptId: 'fixture-publication', operation: 'confirm', url: 'https://example.com/updates/one', evidence: 'Observed the exact fixture text at its resulting URL.' });
  if (backupRecovery) { await state.close(); await rm(state.file(runId)); const recovered = await new TaskStateStore({ dataDir: directory }).init(); t.after(() => recovered.close()); engine.runs.get(runId).taskState = await recovered.get(runId); }
  else engine.runs.get(runId).taskState = await state.get(runId);
}

async function pausedRepairIntent(t) {
  const context = await fixture(t), { store, engine, create, complete } = context, project = await create({ maxRepairs: 1 }); await store.start(project.id); await store.poll(); await complete(project.id);
  let entered, release; const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), save = store.save.bind(store); let held = false;
  store.save = async next => { if (!held && next.projects[0].tasks[0].attempts.length === 2) { held = true; entered(); await gate; } return save(next); };
  engine.finish('run-2', verdict(project.tasks[0].acceptanceCriteria, false)); const polling = store.poll(); await arrived; const pausing = store.pause(project.id); release(); await polling; await pausing; store.save = save;
  const pending = store.get(project.id).tasks[0].attempts.at(-1).implementation; assert.equal(pending.status, 'dispatching'); assert.equal(pending.runId, null); assert.equal(engine.calls.length, 2);
  return { ...context, project, pending };
}

test('project DAG and checkable criteria validation rejects cycles, unknown dependencies and duplicate criteria without saving', async t => {
  const { store, create } = await fixture(t);
  for (const tasks of [[task('a', { dependsOn: ['missing'] })], [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })], [task('a'), task('a')], [task('a', { acceptanceCriteria: [] })], [task('a', { acceptanceCriteria: ['same', 'same'] })]]) await assert.rejects(create({ tasks }));
  assert.equal(store.list().length, 0); await assert.rejects(create({ maxRepairs: 4 }), /zero to three/);
});

test('implementation ending never completes a task; separate verifier evidence unlocks dependent work', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ tasks: [task('build'), task('publish', { dependsOn: ['build'] })] });
  await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 1); assert.equal(store.get(project.id).tasks[0].status, 'running');
  await complete(project.id); let saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'verifying'); assert.equal(saved.tasks[1].status, 'pending'); assert.equal(engine.calls.length, 2);
  assert.match(engine.calls[1].workflow.nodes[1].prompt, /Independently verify/); assert.match(engine.calls[1].input.task, /claims to check/);
  await complete(project.id); saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'completed'); assert.equal(saved.tasks[0].verification.kind, 'agent-verifier'); assert.equal(saved.tasks[0].verification.runId, 'run-2'); assert.match(saved.tasks[0].verification.limitation, /not a guarantee/); assert.equal(saved.tasks[1].status, 'running');
  assert.match(engine.calls[2].input.task, /VERIFIED DEPENDENCIES/); await complete(project.id); await complete(project.id); assert.equal(store.get(project.id).status, 'completed'); assert.equal(engine.calls.length, 4);
});

test('failed acceptance repairs with concrete previous evidence, stops at the explicit bound, and continues independent tasks', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 1, tasks: [task('broken'), task('independent'), task('dependent', { dependsOn: ['broken'] })] });
  await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false);
  assert.equal(engine.calls.length, 3); assert.equal(store.get(project.id).tasks[0].round, 1); assert.match(engine.calls[2].input.task, /REPAIR THESE FAILURES/); assert.match(engine.calls[2].input.task, /missing the required content/);
  await complete(project.id); await complete(project.id, false); let saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].attempts.length, 2); assert.equal(saved.tasks[1].status, 'running'); assert.equal(saved.tasks[2].status, 'pending');
  await complete(project.id); await complete(project.id); saved = store.get(project.id); assert.equal(saved.status, 'needs_attention'); assert.equal(saved.tasks[2].attempts.length, 0); const count = engine.calls.length; await store.poll(); await store.poll(); assert.equal(engine.calls.length, count);
});

test('explicit retry after an exhausted repair budget retains the failed review and receives new run receipts', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false);
  const blocked = store.get(project.id); assert.equal(blocked.status, 'needs_attention'); assert.equal(blocked.tasks[0].round, 0);
  await store.retryTask(project.id, 'build'); assert.equal(store.get(project.id).status, 'paused'); assert.equal(engine.calls.length, 2); await store.start(project.id); await store.poll();
  assert.match(engine.calls[2].input.task, /PREVIOUS VERIFICATION: REPAIR THESE FAILURES/); assert.match(engine.calls[2].input.task, /missing the required content/); assert.match(engine.calls[2].input.task, /PREVIOUS IMPLEMENTATION/); assert.notEqual(engine.calls[2].requestId, engine.calls[0].requestId);
  await complete(project.id); await complete(project.id); const saved = store.get(project.id); assert.equal(saved.status, 'completed'); assert.equal(saved.tasks[0].attempts.length, 2); assert.equal(saved.tasks[0].attempts[0].verification.verdict.passed, false); assert.equal(saved.tasks[0].attempts[1].verification.verdict.passed, true); assert.equal(engine.calls.length, 4);
});

test('manual retry after a malformed verdict retains the actual review failure rather than starting without its context', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); engine.finish('run-2', 'The verifier returned prose instead of the required verdict.'); await store.poll();
  await store.retryTask(project.id, 'build'); await store.start(project.id); await store.poll(); const input = engine.calls[2].input.task;
  assert.match(input, /valid JSON verdict/); assert.match(input, /verifier returned prose/); assert.match(input, /Changed the requested file/); assert.equal(store.get(project.id).tasks[0].attempts[0].verification.verdict, undefined);
});

test('large reviews retain every failed criterion in bounded repair context, including failures near the end', async t => {
  const { store, engine, create, complete } = await fixture(t), criteria = Array.from({ length: 20 }, (_, index) => `Check ${index + 1}: ` + '"'.repeat(400) + 'e'.repeat(550)), project = await create({ objective: 'o'.repeat(8000), maxRepairs: 1, tasks: [task('build', { instructions: 'i'.repeat(11000), acceptanceCriteria: criteria })] });
  await store.start(project.id); await store.poll(); await complete(project.id); engine.finish('run-2', JSON.stringify({ passed: false, summary: 'Every saved criterion needs repair.', criteria: criteria.map((criterion, index) => ({ criterion, passed: false, evidence: `Failure ${index + 1}: ` + 'An observed gap remains. '.repeat(100) })) })); await store.poll();
  const input = engine.calls[2].input.task, section = input.split('PREVIOUS VERIFICATION: REPAIR THESE FAILURES\n')[1].split('\n\nPREVIOUS IMPLEMENTATION')[0], context = JSON.parse(section);
  assert.deepEqual(context.failedCriteria.map(check => check.criterionNumber), Array.from({ length: 20 }, (_, index) => index + 1)); assert.match(context.failedCriteria.at(-1).evidence, /Failure 20/); assert.ok(section.length < 8000); assert.ok(input.length <= 50000); assert.equal(store.get(project.id).tasks[0].round, 1);
});

for (const status of ['uncertain', 'confirmed']) test(`a project ${status} external action permits review but holds fresh repair without blocking independent tasks`, async t => {
  const context = await fixture(t), { store, engine, create, complete } = context, project = await create({ maxRepairs: 2, tasks: [task('publish'), task('independent'), task('dependent', { dependsOn: ['publish'] })] });
  await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1', { status }); await complete(project.id);
  let saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'verifying'); assert.equal(saved.tasks[0].retryHold.runId, 'run-1'); assert.equal(engine.calls.length, 2, 'independent review may inspect the original result'); assert.match(engine.calls[1].workflow.nodes[1].prompt, /never resend, republish, or repeat an external action/); assert.match(engine.calls[1].input.task, /RECORDED EXTERNAL ACTIONS/); assert.match(engine.calls[1].input.task, /"runId":"run-1"/);
  await complete(project.id, false); saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.match(saved.tasks[0].error, /Original run: run-1/); assert.equal(saved.tasks[0].round, 0); assert.equal(saved.tasks[0].attempts.length, 1); assert.equal(saved.tasks[1].status, 'running'); assert.equal(saved.tasks[2].attempts.length, 0); assert.equal(engine.calls.length, 3); assert.match(engine.calls[2].workflow.name, /Task independent/);
  await assert.rejects(store.retryTask(project.id, 'publish'), { status: 409, code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.equal(engine.calls.length, 3);
});

for (const outcome of ['failed', 'cancelled']) test(`a project ${outcome} external attempt keeps its manual retry hold across pruning and restart`, async t => {
  const context = await fixture(t), { store, engine, create, make } = context, project = await create(); await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1'); engine.finish('run-1', '', outcome); await store.poll();
  assert.equal(store.get(project.id).tasks[0].retryHold.runId, 'run-1'); engine.runs.delete('run-1'); await store.close(); const recovered = await make();
  await assert.rejects(recovered.retryTask(project.id, 'build'), { status: 409, code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.match(recovered.get(project.id).tasks[0].error, /Original run: run-1/); assert.equal(recovered.get(project.id).tasks[0].attempts.length, 1); await recovered.poll(); assert.equal(engine.calls.length, 1);
});

test('a blocked project observes later external uncertainty before its original run is pruned', async t => {
  const context = await fixture(t), { store, engine, create } = context, project = await create(); await store.start(project.id); await store.poll(); engine.finish('run-1', '', 'failed'); await store.poll(); assert.equal(store.get(project.id).tasks[0].retryHold, undefined);
  await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await store.poll(); engine.runs.delete('run-1');
  await assert.rejects(store.retryTask(project.id, 'build'), { code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.match(store.get(project.id).tasks[0].error, /Original run: run-1/); assert.equal(engine.calls.length, 1);
});

test('an explicit retry persists newly discovered external uncertainty before rejecting the request', async t => {
  const context = await fixture(t), { store, engine, create, make } = context, project = await create(); await store.start(project.id); await store.poll(); engine.finish('run-1', '', 'failed'); await store.poll(); await externalReceipt(t, context, 'run-1');
  await assert.rejects(store.retryTask(project.id, 'build'), { code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.equal(JSON.parse(await readFile(store.file, 'utf8')).projects[0].tasks[0].retryHold.runId, 'run-1'); engine.runs.delete('run-1'); await store.close(); const recovered = await make(); await assert.rejects(recovered.retryTask(project.id, 'build'), { code: 'EXTERNAL_ACTION_RECONCILE' }); assert.equal(engine.calls.length, 1);
});

test('an older pending repair is checked on restart before its fresh implementation can start', async t => {
  const context = await fixture(t), { store, engine, create, complete, make } = context, project = await create({ maxRepairs: 1 }); await store.start(project.id); await store.poll(); await complete(project.id); await store.pause(project.id); engine.finish('run-2', verdict(project.tasks[0].acceptanceCriteria, false)); await store.poll(); assert.equal(store.get(project.id).tasks[0].status, 'pending'); assert.equal(store.get(project.id).tasks[0].retryHold, undefined);
  await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await store.close(); const recovered = await make(); assert.equal(recovered.get(project.id).tasks[0].retryHold.runId, 'run-1'); engine.runs.delete('run-1'); engine.runs.delete('run-2'); await recovered.start(project.id); await recovered.poll(); assert.equal(recovered.get(project.id).tasks[0].status, 'blocked'); assert.match(recovered.get(project.id).tasks[0].error, /Original run: run-1/); assert.equal(engine.calls.length, 2);
});

test('resuming a saved unadmitted repair rechecks a later original external receipt before dispatch', async t => {
  const context = await pausedRepairIntent(t), { store, engine, project, make } = context; await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await store.poll(); assert.equal(store.get(project.id).tasks[0].retryHold.runId, 'run-1');
  await store.start(project.id); await store.poll(); const saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].attempts[1].implementation.status, 'interrupted'); assert.equal(saved.tasks[0].attempts[1].implementation.runId, null); assert.match(saved.tasks[0].error, /Original run: run-1/); assert.equal(engine.calls.length, 2, 'the saved repair intent never became a fresh implementation');
  await store.close(); engine.runs.delete('run-1'); engine.runs.delete('run-2'); const recovered = await make(); await assert.rejects(recovered.retryTask(project.id, 'build'), { code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.equal(engine.calls.length, 2);
});

test('an already admitted repair follows its matching run despite a later hold and can still receive independent review', async t => {
  const context = await pausedRepairIntent(t), { store, engine, project, pending } = context; const admitted = engine.startRun(pending.request); assert.equal(admitted.id, 'run-3'); await externalReceipt(t, context, 'run-1', { status: 'confirmed' });
  await store.start(project.id); await store.poll(); let saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'running'); assert.equal(saved.tasks[0].attempts[1].implementation.runId, 'run-3'); assert.equal(saved.tasks[0].retryHold.runId, 'run-1'); assert.equal(engine.calls.length, 3, 'lost admission binding must not produce a duplicate implementation');
  engine.finish('run-3', 'Inspected the existing delivery without repeating it.'); await store.poll(); saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'verifying'); assert.equal(saved.tasks[0].attempts[1].verification.runId, 'run-4'); assert.equal(engine.calls.length, 4); engine.finish('run-4', verdict(project.tasks[0].acceptanceCriteria)); await store.poll(); assert.equal(store.get(project.id).status, 'completed');
});

test('reviewer external-action uncertainty also holds a fresh project implementation', async t => {
  const context = await fixture(t), { store, engine, create, complete } = context, project = await create({ maxRepairs: 2 }); await store.start(project.id); await store.poll(); await complete(project.id); await externalReceipt(t, context, 'run-2'); await complete(project.id, false);
  const saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].retryHold.runId, 'run-2'); assert.match(saved.tasks[0].error, /Original run: run-2/); assert.equal(engine.calls.length, 2);
});

for (const manual of [false, true]) test(`a prepared project draft with no external attempt permits ${manual ? 'explicit retry' : 'automatic repair'}`, async t => {
  const context = await fixture(t), { store, engine, create, complete } = context, project = await create({ maxRepairs: manual ? 0 : 1 }); await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1', { status: 'prepared' }); await complete(project.id); await complete(project.id, false);
  if (manual) { await store.retryTask(project.id, 'build'); assert.equal(store.get(project.id).status, 'paused'); await store.start(project.id); await store.poll(); }
  assert.equal(store.get(project.id).tasks[0].status, 'running'); assert.equal(store.get(project.id).tasks[0].retryHold, undefined); assert.equal(engine.calls.length, 3); await complete(project.id); await complete(project.id); assert.equal(store.get(project.id).status, 'completed'); assert.equal(engine.calls.length, 4);
});

test('task-state backup recovery holds project repair even when the recovered ledger only contains a prepared draft', async t => {
  const context = await fixture(t), { store, engine, create, complete, make } = context, project = await create({ maxRepairs: 2 }); await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1', { backupRecovery: true }); assert.equal(engine.runs.get('run-1').taskState.externalRecovery.required, true);
  await complete(project.id); await complete(project.id, false); assert.equal(store.get(project.id).tasks[0].retryHold.backupRecovery, true); engine.runs.delete('run-1'); engine.runs.delete('run-2'); await store.close(); const recovered = await make(); await assert.rejects(recovered.retryTask(project.id, 'build'), { code: 'EXTERNAL_ACTION_RECONCILE', runId: 'run-1' }); assert.equal(engine.calls.length, 2);
});

test('held external-action history does not prevent a successful independent review from completing the project', async t => {
  const context = await fixture(t), { store, engine, create, complete, make } = context, project = await create(); await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await complete(project.id); await complete(project.id);
  assert.equal(store.get(project.id).status, 'completed'); assert.equal(store.get(project.id).tasks[0].verification.passed, true); await store.close(); const recovered = await make(); await recovered.start(project.id); await recovered.poll(); assert.equal(recovered.get(project.id).status, 'completed'); assert.equal(engine.calls.length, 2);
});

test('a held external result can pass a fresh independent review without another implementation or delivery', async t => {
  const context = await fixture(t), { store, engine, create, complete } = context, project = await create({ maxRepairs: 2, tasks: [task('publish'), task('dependent', { dependsOn: ['publish'] })] });
  await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await complete(project.id); await complete(project.id, false);
  const blocked = store.get(project.id), original = blocked.tasks[0].attempts[0], prepared = await store.reviewTask(project.id, 'publish'), recovery = prepared.tasks[0].attempts[1];
  assert.equal(prepared.status, 'paused'); assert.equal(prepared.tasks[0].status, 'verifying'); assert.equal(recovery.mode, 'review_only'); assert.equal(recovery.sourceAttempt, 1); assert.deepEqual(recovery.implementation, original.implementation); assert.deepEqual(prepared.tasks[0].retryHold, blocked.tasks[0].retryHold); assert.equal(recovery.verification.status, 'prepared'); assert.notEqual(recovery.verification.requestId, original.verification.requestId);
  await store.poll(); await assert.rejects(store.reviewTask(project.id, 'publish'), { status: 409 }); assert.equal(engine.calls.length, 2, 'preparation and repeated staging never dispatch work');
  await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 3); assert.match(engine.calls[2].workflow.nodes[1].prompt, /never resend, republish, or repeat/); assert.match(engine.calls[2].input.task, /REVIEW-ONLY RECOVERY/); assert.match(engine.calls[2].input.task, /implementation run run-1/); assert.match(engine.calls[2].input.task, /PREVIOUS REVIEW/); assert.match(engine.calls[2].input.task, /missing the required content/);
  await complete(project.id); const saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'completed'); assert.equal(saved.tasks[0].verification.runId, 'run-3'); assert.equal(saved.tasks[0].attempts[0].verification.verdict.passed, false); assert.equal(saved.tasks[0].attempts[1].verification.verdict.passed, true); assert.equal(saved.tasks[1].status, 'running'); assert.equal(engine.calls.filter(call => /Task publish/.test(call.workflow.name) && call.workflow.nodes[1].name === 'Project implementer').length, 1, 'the original implementation is reused, never executed again');
});

for (const outcome of ['rejected', 'malformed', 'failed']) test(`a ${outcome} review-only recovery remains blocked even with unused automatic repairs`, async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 3 }); await store.start(project.id); await store.poll(); await complete(project.id); engine.finish('run-2', 'The original reviewer omitted the required verdict.'); await store.poll();
  await store.reviewTask(project.id, 'build'); await store.start(project.id); await store.poll();
  engine.finish('run-3', outcome === 'rejected' ? verdict(project.tasks[0].acceptanceCriteria, false) : 'Review could not establish passing evidence.', outcome === 'failed' ? 'failed' : 'completed'); await store.poll(); await store.poll();
  const saved = store.get(project.id); assert.equal(saved.status, 'needs_attention'); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].round, 0); assert.equal(saved.tasks[0].verification, undefined); assert.equal(engine.calls.length, 3); assert.equal(engine.calls.filter(call => call.workflow.nodes[1].name === 'Project implementer').length, 1);
});

test('a prepared review-only recovery and its held original receipt survive pruning and restart without automatic dispatch', async t => {
  const context = await fixture(t), { store, engine, create, complete, make } = context, project = await create(); await store.start(project.id); await store.poll(); await externalReceipt(t, context, 'run-1'); await complete(project.id); await complete(project.id, false);
  engine.runs.delete('run-1'); engine.runs.delete('run-2'); await store.close(); const recovered = await make(), prepared = await recovered.reviewTask(project.id, 'build'), requestId = prepared.tasks[0].attempts[1].verification.requestId;
  await recovered.close(); const reopened = await make(); await reopened.poll(); let saved = reopened.get(project.id); assert.equal(saved.status, 'paused'); assert.equal(saved.tasks[0].status, 'verifying'); assert.equal(saved.tasks[0].attempts[1].verification.status, 'prepared'); assert.equal(saved.tasks[0].retryHold.runId, 'run-1'); assert.equal(engine.calls.length, 2);
  engine.loseAck = true; await reopened.start(project.id); await Promise.all([reopened.poll(), reopened.poll(), reopened.poll()]); assert.equal(engine.calls.length, 3); assert.equal(engine.calls[2].requestId, requestId); engine.finish('run-3', verdict(project.tasks[0].acceptanceCriteria)); await reopened.poll(); saved = reopened.get(project.id); assert.equal(saved.status, 'completed'); assert.equal(saved.tasks[0].attempts[1].implementation.runId, 'run-1'); assert.equal(saved.tasks[0].verification.runId, 'run-3');
  await reopened.close(); const completed = await make(); assert.equal(completed.get(project.id).status, 'completed'); assert.equal(engine.calls.length, 3);
});

test('review-only recovery rejects original stopping leases, conflicting implementation receipts and duplicate requests', async t => {
  const { store, engine, create, complete } = await fixture(t, { engine: new Engine(4) }), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false); const blocked = store.get(project.id);
  const unchanged = async expected => { await assert.rejects(store.reviewTask(project.id, 'build'), expected); assert.deepEqual(store.get(project.id), blocked); assert.equal(engine.calls.length, 2); };
  engine.runs.get('run-1').settled = false; await unchanged({ status: 409, code: 'PROJECT_ATTEMPT_ACTIVE' }); engine.runs.get('run-1').settled = true;
  engine.executions.set('run-2', true); await unchanged({ status: 409, code: 'PROJECT_ATTEMPT_ACTIVE' }); engine.executions.delete('run-2');
  engine.runs.get('run-1').metadata.clientRequestId = 'conflicting-original-request'; await unchanged(/different project execution request/); engine.runs.get('run-1').metadata.clientRequestId = blocked.tasks[0].attempts[0].implementation.requestId;
  engine.runs.set('duplicate', { ...structuredClone(engine.runs.get('run-1')), id: 'duplicate' }); await unchanged(/More than one run/); engine.runs.delete('duplicate');
  await store.reviewTask(project.id, 'build'); await assert.rejects(store.reviewTask(project.id, 'build'), { status: 409 }); assert.equal(engine.calls.length, 2);
});

test('review-only recovery does not certify an older result after a newer implementation actually failed', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 1 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false); engine.finish('run-3', 'The later repair failed after changing the workspace.', 'failed'); await store.poll();
  await assert.rejects(store.reviewTask(project.id, 'build'), /most recent executed implementation/); assert.equal(store.get(project.id).tasks[0].status, 'blocked'); assert.equal(engine.calls.length, 3);
});

test('review-only admission rechecks an original lease and receipt changed after preparation', async t => {
  const { store, engine, create, complete } = await fixture(t, { engine: new Engine(4) }), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false); await store.reviewTask(project.id, 'build');
  engine.executions.set('run-1', true); await store.start(project.id); await store.poll(); let saved = store.get(project.id); assert.equal(saved.status, 'paused'); assert.equal(saved.tasks[0].attempts[1].verification.status, 'prepared'); assert.match(saved.pauseReason, /active or stopping/); assert.equal(engine.calls.length, 2);
  engine.executions.delete('run-1'); engine.runs.get('run-1').metadata.clientRequestId = 'a-conflicting-original-request'; await store.start(project.id); await store.poll(); saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].attempts[1].verification.status, 'interrupted'); assert.match(saved.tasks[0].error, /different project execution request/); assert.equal(engine.calls.length, 2);
});

test('review-only recovery respects the bounded saved attempt history without replacing its receipts', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false);
  const next = structuredClone(store.state), savedTask = next.projects[0].tasks[0], original = savedTask.attempts[0]; savedTask.attempts = Array.from({ length: PROJECT_LIMITS.attempts }, (_, index) => ({ ...structuredClone(original), number: index + 1 })); await store.save(next); const blocked = store.get(project.id);
  await assert.rejects(store.reviewTask(project.id, 'build'), { status: 507 }); assert.deepEqual(store.get(project.id), blocked); assert.equal(engine.calls.length, 2);
});

test('an original lease acquired during review admission persistence prevents a new reviewer from starting', async t => {
  const { store, engine, create, complete } = await fixture(t, { engine: new Engine(4) }), project = await create({ maxRepairs: 0 }); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id, false); await store.reviewTask(project.id, 'build'); await store.start(project.id);
  let entered, release; const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), save = store.save.bind(store); let held = false;
  store.save = async next => { if (!held && next.projects[0].tasks[0].attempts[1].verification.status === 'dispatching') { held = true; entered(); await gate; } return save(next); };
  const polling = store.poll(); await arrived; engine.executions.set('run-1', true); release(); await polling; store.save = save;
  const paused = store.get(project.id); assert.equal(paused.status, 'paused'); assert.equal(paused.tasks[0].attempts[1].verification.status, 'prepared'); assert.equal(engine.calls.length, 2);
  engine.executions.delete('run-1'); await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 3); assert.equal(engine.calls[2].workflow.nodes[1].name, 'Independent verifier');
});

test('a repair proven never admitted can recover by reviewing its original held implementation', async t => {
  const context = await pausedRepairIntent(t), { store, engine, project } = context; await externalReceipt(t, context, 'run-1', { status: 'confirmed' }); await store.poll(); await store.start(project.id); await store.poll();
  const blocked = store.get(project.id); assert.equal(blocked.tasks[0].attempts[1].implementation.notAdmitted, true); const prepared = await store.reviewTask(project.id, 'build'); assert.equal(prepared.tasks[0].attempts[2].sourceAttempt, 1); assert.deepEqual(prepared.tasks[0].attempts[2].implementation, blocked.tasks[0].attempts[0].implementation);
  await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 3); engine.finish('run-3', verdict(project.tasks[0].acceptanceCriteria)); await store.poll(); assert.equal(store.get(project.id).status, 'completed');
});

test('malformed, missing, contradictory and duplicate verifier criteria fail closed', async t => {
  for (const raw of ['All good.', '{"passed":true}', JSON.stringify({ passed: true, summary: 'Fine', criteria: [{ criterion: 'check', passed: false, evidence: 'Failed' }] }), JSON.stringify({ passed: true, summary: 'Fine', criteria: [{ criterion: 'other', passed: true, evidence: 'Claim' }] })]) assert.throws(() => parseProjectVerdict(raw, ['check']));
  assert.throws(() => parseProjectVerdict(JSON.stringify({ passed: true, summary: 'Fine', criteria: [{ criterion: 'a', passed: true, evidence: 'Claim' }, { criterion: 'a', passed: true, evidence: 'Claim' }] }), ['a', 'b']));
  const { store, engine, create, complete } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); await complete(project.id); engine.finish('run-2', 'Done, all checks passed.'); await store.poll();
  const saved = store.get(project.id); assert.equal(saved.status, 'needs_attention'); assert.equal(saved.tasks[0].status, 'blocked'); assert.match(saved.tasks[0].attempts[0].verification.verdictError, /valid JSON/); assert.equal(engine.calls.length, 2);
});

test('a terminal-looking run cannot advance before its execution settles, and failed runtime work blocks', async t => {
  const { store, engine, create } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); engine.finish('run-1', 'Looks done', 'completed', false); await store.poll(); assert.equal(engine.calls.length, 1); assert.equal(store.get(project.id).tasks[0].status, 'running');
  engine.finish('run-1', '', 'failed'); await store.poll(); assert.equal(store.get(project.id).tasks[0].status, 'blocked'); assert.equal(store.get(project.id).status, 'needs_attention'); assert.equal(engine.calls.length, 1);
});

test('pause and global application suspension let receipts settle without starting the next phase', async t => {
  let paused = false; const { store, engine, create } = await fixture(t, { paused: () => paused && 'Profile maintenance is active.' }), project = await create();
  await store.start(project.id); await store.poll(); await store.pause(project.id); engine.finish('run-1'); await store.poll(); assert.equal(engine.calls.length, 1); assert.equal(store.get(project.id).tasks[0].status, 'verifying');
  paused = true; await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 1); assert.equal(store.status().blockedReason, 'Profile maintenance is active.'); paused = false; await store.poll(); assert.equal(engine.calls.length, 2);
});

test('multiple projects share the engine capacity and repeated polls never admit a duplicate phase', async t => {
  const { store, engine, create, complete } = await fixture(t), first = await create(), second = await create({ name: 'Second project' }); await store.start(first.id); await store.start(second.id);
  await Promise.all(Array.from({ length: 15 }, () => store.poll())); assert.equal(engine.calls.length, 1); assert.equal(store.get(second.id).tasks[0].status, 'pending');
  await complete(first.id); await complete(first.id); assert.equal(engine.calls.length, 3); assert.equal(store.get(second.id).tasks[0].status, 'running');
});

test('a pause requested while an execution intent is being saved prevents admission', async t => {
  const { store, engine, create } = await fixture(t), project = await create(); await store.start(project.id);
  let release, entered; const saved = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; }), save = store.save.bind(store); let held = false;
  store.save = async next => { if (!held && next.projects[0].tasks[0].attempts.length) { held = true; entered(); await hold; } return save(next); };
  const polling = store.poll(); await saved; const pausing = store.pause(project.id); release(); await polling; await pausing; assert.equal(engine.calls.length, 0); assert.equal(store.get(project.id).status, 'paused');
  await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, 1);
});

test('a full valid verifier verdict is parsed before its display output is shortened', async t => {
  const { store, engine, create, complete } = await fixture(t), criteria = Array.from({ length: 20 }, (_, index) => `Criterion ${index}: ` + 'observable evidence '.repeat(34)), project = await create({ tasks: [task('long', { acceptanceCriteria: criteria })] });
  await store.start(project.id); await store.poll(); await complete(project.id); engine.finish('run-2', verdict(criteria)); await store.poll(); const saved = store.get(project.id); assert.equal(saved.status, 'completed'); assert.equal(saved.tasks[0].verification.criteria.length, 20); assert.equal(saved.tasks[0].attempts[0].verification.outputTruncated, true);
});

test('lost admission acknowledgement and a transient receipt-bind write recover the admitted run exactly once', async t => {
  const { store, engine, create } = await fixture(t), project = await create(); await store.start(project.id); engine.loseAck = true; await store.poll(); assert.equal(engine.calls.length, 1); assert.equal(store.get(project.id).tasks[0].attempts[0].implementation.runId, 'run-1');
  engine.finish('run-1'); const save = store.save.bind(store); let failed = false;
  store.save = async next => { if (!failed && next.projects[0].tasks[0].attempts[0].verification?.runId) { failed = true; throw Error('Transient bind write failure'); } return save(next); };
  await store.poll(); await store.poll(); assert.equal(failed, true); assert.equal(engine.calls.length, 2); assert.equal(store.get(project.id).tasks[0].attempts[0].verification.runId, 'run-2');
  const file = JSON.parse(await readFile(store.file, 'utf8')); assert.equal(file.projects[0].tasks[0].attempts[0].verification.runId, 'run-2');
});

test('restart reconciles a completed implementation and pauses before verification without replaying side effects', async t => {
  const { store, engine, create, make } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); await store.close(); engine.finish('run-1'); const recovered = await make();
  let saved = recovered.get(project.id); assert.equal(saved.status, 'paused'); assert.equal(saved.tasks[0].status, 'verifying'); assert.match(saved.pauseReason, /restarted/); await recovered.poll(); assert.equal(engine.calls.length, 1); await recovered.start(project.id); await recovered.poll(); assert.equal(engine.calls.length, 2);
  saved = recovered.get(project.id); assert.equal(saved.tasks[0].attempts[0].implementation.runId, 'run-1');
});

test('restart with a missing execution receipt blocks and requires explicit retry; retries preserve history and get new request IDs', async t => {
  const { store, engine, create, make } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); const originalRequest = engine.calls[0].requestId; await store.close(); engine.runs.clear(); engine.executions.clear(); const recovered = await make();
  assert.equal(recovered.get(project.id).tasks[0].status, 'blocked'); await recovered.poll(); assert.equal(engine.calls.length, 1); await recovered.retryTask(project.id, 'build'); assert.equal(recovered.get(project.id).status, 'paused'); await recovered.start(project.id); await recovered.poll(); assert.equal(engine.calls.length, 2); assert.notEqual(engine.calls[1].requestId, originalRequest); assert.equal(recovered.get(project.id).tasks[0].attempts.length, 2);
});

test('a final acceptance review can finish a paused project without resuming or replaying work', async t => {
  const { store, engine, create, complete, make } = await fixture(t), project = await create();
  await store.start(project.id); await store.poll(); await complete(project.id); await store.pause(project.id);
  const paused = store.get(project.id); assert.equal(paused.status, 'paused'); assert.equal(paused.tasks[0].status, 'verifying');
  engine.finish('run-2', verdict(paused.tasks[0].acceptanceCriteria)); await store.poll();
  const saved = store.get(project.id); assert.equal(saved.status, 'completed'); assert.equal(saved.pauseReason, null); assert.equal(saved.tasks[0].verification.passed, true); assert.equal(saved.tasks[0].verification.runId, 'run-2'); assert.ok(saved.finishedAt); assert.ok(saved.revision > paused.revision);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).projects[0].status, 'completed');
  await store.close(); const reopened = await make(); assert.equal(reopened.get(project.id).status, 'completed'); await reopened.start(project.id); await reopened.poll(); assert.equal(engine.calls.length, 2);
});

test('restart completion advances the revision while preserving the last independently reviewed receipt', async t => {
  const { store, engine, create, complete, make } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); await complete(project.id); await store.pause(project.id); const previous = store.get(project.id);
  await store.close(); engine.finish('run-2', verdict(previous.tasks[0].acceptanceCriteria)); const recovered = await make(), saved = recovered.get(project.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.revision, previous.revision + 1); assert.equal(saved.tasks[0].verification.runId, 'run-2'); assert.equal(engine.calls.length, 2);
  await assert.rejects(recovered.update(project.id, { name: 'An old window name', expectedRevision: previous.revision }), /changed/);
});

test('a bound run with a different request cannot supply stale review evidence or unlock dependent work', async t => {
  const { store, engine, create, complete, make } = await fixture(t), project = await create({ tasks: [task('build'), task('deliver', { dependsOn: ['build'] })] });
  await store.start(project.id); await store.poll(); await complete(project.id); const review = store.get(project.id).tasks[0].attempts.at(-1).verification;
  engine.runs.get('run-2').metadata.clientRequestId = 'old-unrelated-review'; engine.finish('run-2', verdict(project.tasks[0].acceptanceCriteria)); await store.poll();
  const saved = store.get(project.id); assert.equal(saved.status, 'needs_attention'); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].verification, undefined); assert.equal(saved.tasks[0].attempts[0].verification.runId, review.runId); assert.equal(saved.tasks[0].attempts[0].verification.status, 'interrupted'); assert.match(saved.tasks[0].error, /different project execution request/); assert.equal(saved.tasks[1].attempts.length, 0); assert.equal(engine.calls.length, 2);
  await store.close(); const reopened = await make(); await reopened.poll(); assert.equal(reopened.get(project.id).tasks[0].status, 'blocked'); assert.equal(engine.calls.length, 2);
});

for (const kind of ['implementation', 'verification']) test(`retry waits for a conflicting ${kind} request and its stopping lease before admitting fresh work`, async t => {
  const { store, engine, create, complete } = await fixture(t, { engine: new Engine(4) }), project = await create(); await store.start(project.id); await store.poll(); if (kind === 'verification') await complete(project.id);
  const next = structuredClone(store.state), phase = next.projects[0].tasks[0].attempts[0][kind], originalId = phase.runId, originalRequest = phase.requestId;
  if (kind === 'implementation') {
    const foreign = engine.startRun({ requestId: 'unrelated-fixture-request' }); engine.finish(foreign.id); phase.runId = foreign.id;
  } else engine.runs.get(originalId).metadata.clientRequestId = 'conflicting-review-request';
  await store.save(next); await store.poll(); const blocked = store.get(project.id), count = engine.calls.length;
  assert.equal(blocked.tasks[0].status, 'blocked'); assert.match(blocked.tasks[0].error, /different project execution request/);
  const held = async () => { await assert.rejects(store.retryTask(project.id, 'build'), { status: 409, code: 'PROJECT_ATTEMPT_ACTIVE' }); assert.deepEqual(store.get(project.id), blocked); assert.equal(engine.calls.length, count); };
  await held();
  engine.finish(originalId, '', 'cancelled', false); await held();
  engine.runs.get(originalId).settled = true; await held();
  engine.executions.delete(originalId); await store.retryTask(project.id, 'build'); assert.equal(store.get(project.id).status, 'paused'); assert.equal(engine.calls.length, count);
  await store.start(project.id); await store.poll(); assert.equal(engine.calls.length, count + 1); assert.notEqual(engine.calls.at(-1).requestId, originalRequest); assert.equal(store.get(project.id).tasks[0].attempts.length, 2);
});

test('oversized escaped task context blocks visibly rather than leaving a project running without an execution', async t => {
  const { store, engine, create } = await fixture(t), project = await create({ objective: 'o'.repeat(8000), tasks: [task('large', { instructions: 'i'.repeat(12000), acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `Check ${index}: ` + '"'.repeat(950)) }), task('independent')] });
  await store.start(project.id); await store.poll(); let saved = store.get(project.id); assert.equal(saved.tasks[0].status, 'blocked'); assert.equal(saved.tasks[0].attempts.length, 0); assert.match(saved.tasks[0].error, /Cannot prepare the task:.*execution input limit/); assert.equal(engine.calls.length, 0);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).projects[0].tasks[0].status, 'blocked');
  await store.poll(); saved = store.get(project.id); assert.equal(saved.tasks[1].status, 'running'); assert.equal(engine.calls.length, 1); assert.equal(saved.tasks[0].attempts.length, 0);
});

test('review preparation failure preserves completed implementation evidence and requires explicit recovery', async t => {
  const { store, engine, create } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); const intent = store.intent.bind(store);
  store.intent = (project, task, kind) => { if (kind === 'verification') throw Error('Review context cannot be prepared.'); return intent(project, task, kind); };
  engine.finish('run-1', 'Wrote the actual result; independent review is still needed.'); await store.poll(); const saved = store.get(project.id), attempt = saved.tasks[0].attempts[0];
  assert.equal(saved.status, 'needs_attention'); assert.equal(saved.tasks[0].status, 'blocked'); assert.match(saved.tasks[0].error, /Cannot prepare the acceptance review/); assert.equal(attempt.implementation.status, 'completed'); assert.match(attempt.implementation.output, /actual result/); assert.equal(attempt.verification, undefined); assert.equal(saved.tasks[0].verification, undefined); await store.poll(); assert.equal(engine.calls.length, 1);
});

test('saved graph revisions protect edits and executed criteria remain immutable', async t => {
  const { store, create } = await fixture(t), project = await create(); await assert.rejects(store.update(project.id, { name: 'Stale', expectedRevision: 0 }), { status: 409 });
  const changed = await store.update(project.id, { name: 'Updated', expectedRevision: project.revision }); await store.start(project.id); await store.poll(); await store.pause(project.id);
  await assert.rejects(store.update(project.id, { objective: 'Different outcome', expectedRevision: store.get(project.id).revision }), /original criteria/); const renamed = await store.update(project.id, { name: 'Renamed only', expectedRevision: store.get(project.id).revision }); assert.equal(renamed.name, 'Renamed only'); assert.equal(renamed.objective, changed.objective);
});

test('damaged primary project storage recovers the valid backup while preserving the damaged file', async t => {
  const { store, create, make } = await fixture(t), project = await create(); await store.pause(project.id); await store.close(); await writeFile(store.file, '{damaged'); const recovered = await make(); assert.equal(recovered.status().recovered, true); assert.equal(recovered.get(project.id).id, project.id);
});

test('a restored completed flag without acceptance receipts cannot unlock a dependent task', async t => {
  const { store, engine, create, make, directory } = await fixture(t), project = await create({ tasks: [task('build'), task('deliver', { dependsOn: ['build'] })] }); await store.pause(project.id); await store.close();
  const malformed = JSON.parse(await readFile(store.file, 'utf8')); malformed.projects[0].tasks[0].status = 'completed'; malformed.projects[0].tasks[0].verification = { passed: true }; await writeFile(store.file, JSON.stringify(malformed));
  const recovered = await make(); assert.equal(recovered.status().recovered, true); assert.equal(recovered.get(project.id).tasks[0].status, 'pending'); assert.ok((await readdir(directory)).some(name => name.startsWith('projects.json.corrupt-')));
  await recovered.start(project.id); await recovered.poll(); assert.equal(engine.calls.length, 1); assert.match(engine.calls[0].workflow.name, /Task build/); assert.equal(recovered.get(project.id).tasks[1].attempts.length, 0);
});

test('completed project storage requires matching passing review evidence and fails closed if neither copy has it', async t => {
  const { store, create, complete, make } = await fixture(t), project = await create(); await store.start(project.id); await store.poll(); await complete(project.id); await complete(project.id); const valid = JSON.parse(await readFile(store.file, 'utf8'));
  for (const change of [value => { value.tasks[0].verification.runId = 'a-stale-review'; }, value => { value.tasks[0].verification.criteria[0].evidence = 'Unrelated old evidence.'; }, value => { value.tasks[0].attempts[0].verification.runId = value.tasks[0].attempts[0].implementation.runId; }, value => { value.tasks[0].attempts[0].verification.verdict.criteria[0].passed = false; }, value => { value.tasks[0].status = 'pending'; }]) { const candidate = structuredClone(valid); change(candidate.projects[0]); assert.throws(() => store.validateState(candidate)); }
  await store.close(); const broken = structuredClone(valid); delete broken.projects[0].tasks[0].verification; const raw = JSON.stringify(broken); await writeFile(store.file, raw); await writeFile(store.file + '.bak', raw); await assert.rejects(make(), /Cannot load projects/); assert.equal(await readFile(store.file, 'utf8'), raw); assert.equal(await readFile(store.file + '.bak', 'utf8'), raw);
});

test('history capacity failures become visible unhealthy state and stop admission without replacing saved receipts', async t => {
  const { store, engine, create } = await fixture(t), project = await create(), acknowledged = await readFile(store.file, 'utf8');
  await assert.rejects(store.save({ ...structuredClone(store.state), overflow: 'x'.repeat(PROJECT_LIMITS.bytes) }), { status: 507 }); assert.equal(store.status().healthy, false); assert.match(store.status().error, /history is full/); assert.equal(await readFile(store.file, 'utf8'), acknowledged); await store.poll(); assert.equal(engine.calls.length, 0);
  await store.start(project.id); assert.equal(store.status().healthy, true); await store.poll(); assert.equal(engine.calls.length, 1);
});

test('real execution engine runs implementation, independent disk verification, repair and a successful second verification', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-project-engine-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'); await mkdir(cwd); let implementations = 0, verifications = 0;
  const runtime = { status: () => ({ connected: true, authenticated: true, defaultModel: 'fixture-model' }), async runAgent(options) {
    if (options.prompt.includes('Independently verify the project task')) { verifications++; const actual = await readFile(path.join(cwd, 'result.txt'), 'utf8'); return { output: verdict(['result.txt contains VERIFIED'], actual === 'VERIFIED'), threadId: `verify-${verifications}` }; }
    implementations++; await writeFile(path.join(cwd, 'result.txt'), implementations === 1 ? 'INCOMPLETE' : 'VERIFIED'); return { output: 'Wrote result.txt. A separate check is still required.', threadId: `implement-${implementations}` };
  } };
  const engine = await new HarnessEngine({ dataDir, defaultCwd: cwd, runtime, maxConcurrentRuns: 1 }).init(), store = await new ProjectStore({ dataDir, engine }).init(); clearTimeout(store.timer); store.timer = null; store.kick = () => {};
  t.after(async () => { await store.close(); await engine.close(); assert.match(path.basename(directory), /^blackice-project-engine-/); await rm(directory, { recursive: true, force: true }); });
  const project = await store.create({ name: 'Actual execution path', objective: 'Write a file and independently check it.', cwd, maxRepairs: 1, tasks: [task('result', { acceptanceCriteria: ['result.txt contains VERIFIED'] })] }); await store.start(project.id);
  for (let round = 0; round < 6 && store.get(project.id).status !== 'completed'; round++) { await store.poll(); await Promise.all([...engine.executions.values()]); await store.poll(); }
  const saved = store.get(project.id); assert.equal(saved.status, 'completed'); assert.equal(implementations, 2); assert.equal(verifications, 2); assert.equal(saved.tasks[0].attempts.length, 2); assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), 'VERIFIED'); assert.equal(saved.tasks[0].verification.passed, true); assert.ok(saved.tasks[0].verification.runId);
});

test('project management fields and method step context persist without changing the draft execution boundary', async t => {
  const { store, engine, create, make } = await fixture(t);
  const method = { id: 'saved-method', revision: 3, name: 'Reusable evidence inspection', taskType: 'analysis', origin: 'custom' };
  const project = await create({ priority: 'high', owner: 'Research lead', dueDate: '2030-02-28', tags: ['research', 'fixture'], notes: 'Keep observations separate from assumptions.', context: 'Source material: fixture.txt', method, milestones: [{ id: 'scope', title: 'Scope agreed', taskIds: [], done: true }, { id: 'result', title: 'Reviewed result', taskIds: ['build'], dueDate: '2030-02-28' }], tasks: [task('build', { stepType: 'analyze', inputs: ['Source material'], result: 'A saved evidence note.' })] });
  assert.equal(project.status, 'draft'); assert.equal(project.summary.progress.percent, 0); assert.equal(project.summary.nextAction.kind, 'start');
  assert.equal(project.summary.milestones[0].completion, 'manual'); assert.equal(project.summary.milestones[0].status, 'completed'); assert.equal(project.summary.milestones[1].completion, 'agent-reviewed'); assert.equal(project.summary.milestones[1].status, 'planned');
  await store.close(); const reopened = await make(), actual = reopened.get(project.id);
  assert.deepEqual(actual.method, method); assert.equal(actual.priority, 'high'); assert.equal(actual.owner, 'Research lead'); assert.equal(actual.tasks[0].result, 'A saved evidence note.'); assert.equal(actual.notes, project.notes); assert.deepEqual(actual.milestones, project.milestones);
  await reopened.poll(); assert.equal(engine.calls.length, 0);
});

test('invalid project dates, priorities, milestone references and fake linked completion cannot be saved', async t => {
  const { store, create } = await fixture(t);
  for (const value of [{ priority: 'critical' }, { dueDate: '2027-02-29' }, { dueDate: '2030-01-01T00:00:00Z' }, { tags: ['same', 'same'] }, { milestones: [{ title: 'Missing', taskIds: ['absent'] }] }, { milestones: [{ title: 'Duplicated task', taskIds: ['build', 'build'] }] }, { milestones: [{ title: 'Fake review', taskIds: ['build'], done: true }] }, { milestones: [{ id: 'same', title: 'First' }, { id: 'same', title: 'Second' }] }, { milestones: [{ title: 'Invalid manual marker', done: 'yes' }] }]) await assert.rejects(create(value), { status: 400 });
  assert.equal(store.list().length, 0); assert.equal((await create({ dueDate: '2028-02-29' })).dueDate, '2028-02-29');
});

test('shared metadata stays editable during active and completed work while task criteria and receipts remain immutable', async t => {
  const method = { id: 'saved-method', revision: 1, name: 'Saved method', taskType: 'general', origin: 'custom' }, methodContext = 'Saved method inputs';
  const { store, engine, create, complete } = await fixture(t), project = await create({ method, methodContext, context: 'Authored constraints\n\n' + methodContext }); await store.start(project.id); await store.poll();
  const active = store.get(project.id), receipt = structuredClone(active.tasks[0].attempts);
  const changed = await store.update(project.id, { expectedRevision: active.revision, priority: 'urgent', owner: 'Task owner', notes: 'A shared coordination note.', milestones: [{ title: 'Owner informed', done: true }] });
  assert.equal(changed.status, 'running'); assert.deepEqual(changed.tasks[0].attempts, receipt); assert.equal(changed.summary.progress.completed, 0); assert.equal(engine.calls.length, 1); assert.equal(changed.methodContext, methodContext); assert.equal(changed.context, project.context);
  await assert.rejects(store.update(project.id, { expectedRevision: changed.revision, context: 'Changed task inputs' }), /original criteria and task graph/);
  await assert.rejects(store.update(project.id, { expectedRevision: changed.revision, methodContext: '' }), /original criteria and task graph/);
  await assert.rejects(store.update(project.id, { expectedRevision: changed.revision, tasks: [task('different')] }), /original criteria and task graph/);
  await complete(project.id); await complete(project.id); const completed = store.get(project.id), finished = await store.update(project.id, { expectedRevision: completed.revision, notes: 'Result handed to the requester.' });
  assert.equal(finished.status, 'completed'); assert.deepEqual(finished.tasks, completed.tasks); assert.equal(finished.summary.progress.percent, 100); assert.equal(finished.summary.nextAction.kind, 'complete'); assert.equal(engine.calls.length, 2);
});

test('linked milestone progress advances only after independent review and reflects actual blocked steps', async t => {
  const { store, create, complete } = await fixture(t), project = await create({ maxRepairs: 0, tasks: [task('build'), task('deliver', { dependsOn: ['build'] })], milestones: [{ id: 'manual', title: 'Planning check', done: true }, { id: 'delivery', title: 'Reviewed delivery', taskIds: ['build', 'deliver'] }] });
  await store.start(project.id); await store.poll(); await complete(project.id);
  let current = store.get(project.id); assert.equal(current.tasks[0].status, 'verifying'); assert.equal(current.summary.progress.percent, 0); assert.equal(current.summary.milestones[1].completed, 0);
  await complete(project.id); current = store.get(project.id); assert.equal(current.summary.progress.percent, 50); assert.equal(current.summary.milestones[1].percent, 50); assert.equal(current.summary.milestones[1].status, 'active');
  await complete(project.id); await complete(project.id, false); current = store.get(project.id);
  assert.equal(current.summary.progress.completed, 1); assert.equal(current.summary.progress.blocked, 1); assert.equal(current.summary.nextAction.kind, 'review'); assert.equal(current.summary.nextAction.taskId, 'deliver'); assert.equal(current.summary.milestones[1].status, 'blocked'); assert.equal(current.summary.milestones[0].completion, 'manual');
});

test('saved input context, expected results and prior actual output reach the existing task execution prompt', async t => {
  const { store, engine, create, complete } = await fixture(t), project = await create({ context: 'Source file: fixture-source.txt', tasks: [task('build', { stepType: 'collect', inputs: ['Supplied source'], result: 'Evidence notes in findings.txt' }), task('summarize', { dependsOn: ['build'], inputs: ['Reviewed findings.txt'], result: 'A final report.' })] });
  await store.start(project.id); await store.poll(); const input = engine.calls[0].input.task;
  assert.match(input, /PROJECT INPUT CONTEXT/); assert.match(input, /fixture-source\.txt/); assert.match(input, /STEP INPUTS/); assert.match(input, /EXPECTED STEP RESULT/); assert.match(input, /Evidence notes in findings\.txt/);
  await complete(project.id); await complete(project.id); const next = engine.calls[2].input.task;
  assert.match(next, /implementationRunId/); assert.match(next, /Changed the requested file/); assert.match(next, /Reviewed findings\.txt/); assert.deepEqual(store.get(project.id).tasks[1].acceptanceCriteria, ['summarize result is checked']);
});

test('concurrent metadata updates retain one exact revision and old projects acquire truthful empty management defaults', async t => {
  const { store, create, make } = await fixture(t), project = await create();
  const results = await Promise.allSettled([store.update(project.id, { expectedRevision: project.revision, notes: 'First writer' }), store.update(project.id, { expectedRevision: project.revision, notes: 'Second writer' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await store.close(); const legacy = JSON.parse(await readFile(store.file, 'utf8'));
  for (const key of ['context', 'methodContext', 'method', 'priority', 'owner', 'dueDate', 'notes', 'tags', 'milestones']) delete legacy.projects[0][key];
  for (const key of ['stepType', 'inputs', 'result']) delete legacy.projects[0].tasks[0][key];
  await writeFile(store.file, JSON.stringify(legacy)); const reopened = await make(), loaded = reopened.get(project.id);
  assert.equal(loaded.priority, 'normal'); assert.equal(loaded.owner, ''); assert.deepEqual(loaded.tags, []); assert.deepEqual(loaded.milestones, []); assert.equal(loaded.summary.progress.percent, 0); assert.equal(loaded.status, 'draft'); assert.equal(loaded.methodContext, '');
});

test('saved method plans reopen and replace changed generated inputs without losing authored context or starting work', async t => {
  const { store, make, engine, directory, cwd } = await fixture(t);
  const methods = await new MethodStore({ dataDir: directory, projects: store }).init(); t.after(() => methods.close());
  const options = { objective: 'Compare the supplied options.', cwd, inputs: { options: 'Option A and Option B' } };
  const first = methods.preview('compare-options', options), authored = 'Keep the agreed budget.\n\nMETHOD INPUTS is also a phrase in my source notes.';
  const draft = applyMethodPreview({ ...projectPlan(first), context: authored, methodContext: '' }, first);
  const saved = await store.create(draft); await store.close(); const reopened = await make(), original = reopened.get(saved.id);
  assert.equal(original.methodContext, first.context); assert.equal(original.context, authored + '\n\n' + first.context);
  const next = methods.preview('compare-options', { ...options, inputs: { options: 'Option C and Option D' } });
  const reapplied = applyMethodPreview(projectPlan(original), next);
  const updated = await reopened.update(saved.id, { ...reapplied, expectedRevision: original.revision });
  assert.equal(updated.context, authored + '\n\n' + next.context); assert.equal(updated.methodContext, next.context); assert.ok(!updated.context.includes('Option A and Option B'));
  assert.equal(updated.status, 'draft'); assert.ok(updated.tasks.every(task => task.attempts.length === 0)); assert.equal(engine.calls.length, 0);
  await reopened.close(); const durable = (await make()).get(saved.id); assert.equal(durable.context, updated.context); assert.equal(durable.methodContext, next.context);
});

test('generated method input ownership rejects inconsistent boundaries and can be explicitly cleared in an unstarted plan', async t => {
  const { store, create } = await fixture(t), method = { id: 'method', revision: 1, name: 'Method', taskType: 'general', origin: 'custom' };
  for (const value of [
    { context: 'Inputs', methodContext: 'Inputs' },
    { method, context: 'Inputs', methodContext: 'Different inputs' },
    { method, context: 'Authored text Inputs', methodContext: 'Inputs' },
    { method, context: 'Inputs\n\nMore text', methodContext: 'Inputs' },
    { method, context: 'Inputs', methodContext: null },
    { method, context: 'Inputs', methodContext: 'x'.repeat(8001) },
    { method, context: 'Inputs', methodContext: 'Inputs\0' },
  ]) await assert.rejects(create(value), { status: 400 });
  assert.equal(store.list().length, 0);
  const saved = await create({ method, context: 'Authored text\n\nInputs', methodContext: 'Inputs' });
  const cleared = await store.update(saved.id, { expectedRevision: saved.revision, methodContext: '', method: null });
  assert.equal(cleared.context, saved.context); assert.equal(cleared.methodContext, ''); assert.equal(cleared.method, null); assert.equal(cleared.status, 'draft');
});

test('corrupt saved method ownership fails closed and leaves the original project bytes available', async t => {
  const { store, create, make } = await fixture(t), method = { id: 'method', revision: 1, name: 'Method', taskType: 'general', origin: 'custom' };
  await create({ method, context: 'Authored text\n\nInputs', methodContext: 'Inputs' }); await store.close();
  const state = JSON.parse(await readFile(store.file, 'utf8')); state.projects[0].methodContext = 'Different inputs';
  const original = JSON.stringify(state); await writeFile(store.file, original); await rm(store.file + '.bak', { force: true });
  await assert.rejects(make(), error => error.status === 500 && /exact final block/.test(error.message)); assert.equal(await readFile(store.file, 'utf8'), original);
});
