import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { OperationsStore } from '../lib/operations.mjs';

class Clock {
  value = 0; serial = 0; timers = new Map();
  now = () => this.value;
  setTimeout = (callback, delay) => { const id = ++this.serial; this.timers.set(id, { callback, at: this.value + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  advance(ms) {
    this.value += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= this.value && this.timers.delete(id)) timer.callback();
  }
}
const until = async (check, label = 'fixture state') => {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${label} did not arrive`);
};
const agent = id => ({ id, type: 'agent', name: id, model: 'fixture', prompt: `Complete ${id} fixture work.`, assignment: { scope: `Only ${id} fixture work.`, inputs: ['Original local fixture task.'], result: `A checked ${id} result.`, doneWhen: `The ${id} fixture result is checked.`, canWrite: true } });
const workflow = () => ({ id: 'coordination-fixture', name: 'Coordination fixture', planning: { shared: true, coordinatorNodeId: 'coordinator' }, nodes: [{ id: 'input', type: 'input' }, agent('worker'), agent('coordinator'), { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'worker' }, { source: 'worker', target: 'coordinator' }, { source: 'coordinator', target: 'output' }], settings: { maxParallel: 2 } });
async function taskCall(options, build) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const read = await options.onToolCall({ name: 'relay_task', arguments: { action: 'read' } }); assert.equal(read.success, true);
    const state = JSON.parse(read.contentItems[0].text);
    const receipt = await options.onToolCall({ name: 'relay_task', arguments: { ...build(state), expectedRevision: state.revision } });
    if (receipt.code === 'TASK_STATE_CONFLICT') continue;
    assert.equal(receipt.success, true, receipt.contentItems[0].text); return JSON.parse(receipt.contentItems[0].text);
  }
  assert.fail('Fixture plan edit could not commit.');
}
async function complete(options) {
  const id = options.prompt.match(/^You are ([a-z]+)\./)?.[1];
  assert.ok(['worker', 'coordinator'].includes(id), 'The prompt identifies the assigned fixture actor.');
  await taskCall(options, () => ({ action: 'edit', operations: [{ type: 'update', stepId: `agent-${id}-work`, patch: { status: 'active',
    operation: { kind: 'reasoning', target: `The supplied ${id} fixture assignment` },
    result: `The ${id} assignment label and prompt identifier are compared.`,
    note: `Compare the identifier extracted from the current prompt with the supplied ${id} assignment label.`,
    doneWhen: `The comparison identifies whether both supplied labels equal ${id}.` } }] }));
  await taskCall(options, () => ({ action: 'step', stepId: `agent-${id}-work`, status: 'done', evidence: 'The actual fixture result was checked.' }));
  await taskCall(options, () => ({ action: 'review', review: { decision: 'respond', summary: `The current prompt identifies ${id}, matching its supplied assignment. The comparison is recorded and no work remains in this actor's assigned scope.` } }));
  return { output: `Checked ${id} fixture result.` };
}
async function fixture(t, { blocked = true, choice = false, grace, execute = complete, maxConcurrentRuns } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-coordination-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), clock = new Clock(), entered = [];
  const bind = tasks.bindWorkflow.bind(tasks);
  tasks.bindWorkflow = async (...args) => {
    let state = await bind(...args);
    if (choice) state = await tasks.setPlan(state.taskId, { plan: { ...state.plan, layout: 'choice' }, steps: state.steps }, { expectedRevision: state.revision, source: 'human', schemaVersion: 6 });
    else if (blocked) state = await tasks.editPlan(state.taskId, { operations: [{ type: 'update', stepId: 'agent-worker-work', patch: { status: 'blocked', blockedReason: 'Fixture input has not been supplied.' } }] }, { expectedRevision: state.revision, source: 'human' });
    return state;
  };
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    runAgent(options) { entered.push(options); return execute(options); }
  }
  const engine = await new HarnessEngine({ runtime: new Runtime(), dataDir: directory, defaultCwd: directory, tasks, coordinationWaitMs: grace, coordinationTiming: clock, maxConcurrentRuns }).init();
  t.after(async () => { await engine.close(); await tasks.close(); const resolved = path.resolve(directory); assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('blackice-coordination-')); await fs.rm(resolved, { recursive: true, force: true }); });
  const start = () => engine.startRun({ workflow: workflow(), input: 'Complete the local fixture task.' });
  const waiting = id => until(() => { const run = engine.getRun(id); return run.status === 'waiting' && run.coordination?.status === 'waiting' && clock.timers.size && run; }, 'coordination wait');
  const settled = id => until(() => { const run = engine.getRun(id); return run.settled && run; }, 'settled run');
  const edit = async (id, patch) => { const run = engine.getRun(id), state = await tasks.get(run.taskId); return tasks.editPlan(run.taskId, { operations: [{ type: 'update', stepId: 'agent-worker-work', patch }] }, { expectedRevision: state.revision, source: 'human' }); };
  return { directory, tasks, clock, entered, engine, start, waiting, settled, edit };
}

test('the default 60-second no-running coordination window produces a durable precise failed outcome', async t => {
  const f = await fixture(t); assert.equal(f.engine.coordinationWaitMs, 60000);
  const admitted = f.start(); const waiting = await f.waiting(admitted.id);
  assert.equal(f.entered.length, 0); assert.equal(waiting.coordination.coordinator.runtimeStatus, 'queued');
  assert.ok(waiting.coordination.blockedNodes.some(item => item.nodeId === 'worker' && item.state === 'blocked'));
  f.clock.advance(59999); assert.equal(f.engine.getRun(admitted.id).status, 'waiting');
  f.clock.advance(1); const failed = await f.settled(admitted.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'WORKFLOW_COORDINATION_STALLED');
  assert.equal(failed.coordination.status, 'stalled'); assert.match(failed.error, /Coordinator coordinator is queued/);
  assert.equal(failed.taskState.interruption.status, 'failed'); assert.match(failed.taskState.interruption.reason, /No worker is running/);
  assert.equal(failed.taskState.checkpoint.kind, 'interruption'); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.engine.executions.has(admitted.id), false); assert.equal(f.entered.length, 0);
  assert.equal(failed.events.filter(event => event.data?.type === 'coordination.stalled').length, 1);
  await f.engine.persist();
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'runs.json'), 'utf8'));
  assert.match(JSON.stringify(persisted), /WORKFLOW_COORDINATION_STALLED/);
});

test('a real readiness edit wakes work immediately and removes the old timer', async t => {
  const f = await fixture(t, { grace: 100 }); const admitted = f.start(); await f.waiting(admitted.id);
  f.clock.advance(40); await f.edit(admitted.id, { status: 'pending' });
  const finished = await f.settled(admitted.id);
  assert.equal(finished.status, 'completed', finished.error); assert.equal(f.entered.length, 2);
  assert.ok(finished.events.some(event => event.data?.type === 'coordination.resumed'));
  assert.equal(f.clock.timers.size, 0); f.clock.advance(1000000);
  assert.equal(f.engine.getRun(admitted.id).status, 'completed');
  assert.equal(finished.events.some(event => event.data?.type === 'coordination.stalled'), false);
});

test('arbitrary revisions, blocker wording and runtime heartbeat noise cannot extend the window', async t => {
  const f = await fixture(t, { grace: 100 }); const admitted = f.start(); await f.waiting(admitted.id);
  f.clock.advance(40); await f.edit(admitted.id, { note: 'Status poll one.', blockedReason: 'Same missing fixture input, wording changed.' });
  await until(() => f.clock.timers.size === 1);
  f.engine.notify('agent.event', f.engine.runs.get(admitted.id), 'runtime', { type: 'heartbeat' });
  f.clock.advance(59); await f.edit(admitted.id, { note: 'Another read and status revision.' });
  f.clock.advance(1); const failed = await f.settled(admitted.id);
  assert.equal(failed.errorCode, 'WORKFLOW_COORDINATION_STALLED'); assert.equal(failed.coordination.elapsedMs, 100);
  assert.equal(f.entered.length, 0);
});

test('a dependency/readiness change at expiry is reread before failure', async t => {
  const f = await fixture(t, { grace: 100 }); const admitted = f.start(); await f.waiting(admitted.id);
  const get = f.tasks.get.bind(f.tasks); let readsAtDeadline = 0;
  f.tasks.get = async (...args) => {
    const state = await get(...args);
    if (f.clock.now() >= 100 && ++readsAtDeadline === 2) {
      await f.tasks.editPlan(state.taskId, { operations: [{ type: 'update', stepId: 'agent-worker-work', patch: { status: 'pending' } }] }, { expectedRevision: state.revision, source: 'human' });
      return get(...args);
    }
    return state;
  };
  f.clock.advance(100); const finished = await f.settled(admitted.id);
  assert.ok(readsAtDeadline >= 2); assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.events.some(event => event.data?.type === 'coordination.stalled'), false);
});

test('explicit branch choice is identified as missing input instead of an active coordinator', async t => {
  const f = await fixture(t, { choice: true, grace: 100 }); const admitted = f.start();
  const waiting = await f.waiting(admitted.id); assert.equal(waiting.coordination.classification, 'awaiting-choice');
  f.clock.advance(100); const failed = await f.settled(admitted.id);
  assert.match(failed.error, /saved branch choice is required/); assert.equal(f.entered.length, 0);
  assert.equal(failed.coordination.coordinator.runtimeStatus, 'queued');
});

test('cancellation before a timer callback settles cancelled without a later stall', async t => {
  const f = await fixture(t, { grace: 100 }); const admitted = f.start(); await f.waiting(admitted.id);
  f.engine.cancelRun(admitted.id); f.clock.advance(100);
  const stopped = await f.settled(admitted.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.coordination.status, 'cancelled');
  assert.equal(stopped.events.some(event => event.data?.type === 'coordination.stalled'), false);
  assert.equal(f.clock.timers.size, 0); assert.equal(f.entered.length, 0);
});

test('a long active prerequisite is excluded even while its final coordinator is queued', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { blocked: false, grace: 100, execute: async options => {
    const id = options.prompt.match(/^You are ([a-z]+)\./)?.[1];
    if (id === 'worker') { const stop = () => release(); options.signal.addEventListener('abort', stop, { once: true }); try { await held; } finally { options.signal.removeEventListener('abort', stop); } }
    return complete(options);
  } });
  const admitted = f.start(); await until(() => f.entered.length === 1);
  f.clock.advance(3600000); const active = f.engine.getRun(admitted.id);
  assert.equal(active.status, 'running'); assert.equal(active.nodes.worker.status, 'running'); assert.equal(active.nodes.coordinator.status, 'queued');
  assert.equal(f.clock.timers.size, 0); assert.equal(active.events.some(event => event.data?.type === 'coordination.stalled'), false);
  release(); assert.equal((await f.settled(admitted.id)).status, 'completed');
});

test('operation queue holds a real waiting run, then follows settled failure and the configured retry', async t => {
  const f = await fixture(t, { grace: 100, maxConcurrentRuns: 1 });
  const inbox = await new TaskInbox({ dataDir: f.directory, engine: f.engine }).init();
  const operations = await new OperationsStore({ dataDir: f.directory, inbox, engine: f.engine, clock: () => 1792790000000 + f.clock.now(), pollMs: 10000 }).init();
  operations.kick = () => {};
  t.after(async () => { await operations.close(); await inbox.close(); });
  const deployment = await operations.create({ name: 'Stall fixture', input: 'Complete the fixture.', cwd: f.directory, workflow: workflow(), overlap: 'queue', retry: { maxAttempts: 1, backoffSeconds: 1 } });
  const first = await operations.trigger(deployment.id), second = await operations.trigger(deployment.id);
  await operations.poll(); const firstRunId = operations.getJob(first.id).attempts[0].runId; await f.waiting(firstRunId);
  await operations.poll(); assert.equal(operations.getJob(first.id).status, 'running'); assert.equal(operations.getJob(second.id).status, 'queued');
  f.clock.advance(100); await f.settled(firstRunId); await operations.poll();
  assert.equal(operations.getJob(first.id).status, 'retry_wait'); assert.equal(inbox.get(operations.getJob(first.id).attempts[0].inboxId).status, 'failed');
  assert.equal(f.engine.getRun(firstRunId).settled, true); assert.equal(f.engine.getRun(firstRunId).errorCode, 'WORKFLOW_COORDINATION_STALLED');
  f.clock.advance(1000); await operations.poll();
  const retry = operations.getJob(first.id); assert.equal(retry.attempts.length, 2); assert.notEqual(retry.attempts[1].runId, firstRunId);
  assert.equal(operations.getJob(second.id).status, 'queued');
  await f.waiting(retry.attempts[1].runId); f.clock.advance(100); await f.settled(retry.attempts[1].runId); await operations.poll();
  assert.equal(operations.getJob(first.id).status, 'failed'); assert.equal(operations.getJob(second.id).status, 'running');
  assert.equal(f.entered.length, 0, 'Coordination failure must not create phantom model calls.');
});
