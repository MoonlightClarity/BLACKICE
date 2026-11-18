import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Historical schema-13 guarded-worker regression; current canonical behavior has separate engine acceptance.
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
async function complete(options){const id=options.prompt.match(/^You are ([a-z]+)\./)?.[1];assert.ok(['worker','coordinator'].includes(id));return{output:`Checked ${id} fixture result.`};}
async function fixture(t, { grace, execute = complete, maxConcurrentRuns } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-coordination-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), clock = new Clock(), entered = [];
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    async runAgent(options) { const review = fixtureOutcomeReview(options); if (review) return review; entered.push(options); return finishFixtureCandidate(options, await execute(options)); }
  }
  // These fixtures exercise the explicit shared execution guardrail and its coordination deadline.
  const engine = await new HarnessEngine({ runtime: new Runtime(), dataDir: directory, defaultCwd: directory, tasks, coordinationWaitMs: grace, coordinationTiming: clock, maxConcurrentRuns }).init();
  engine.runtimeSettings = { get: () => ({ executionGuardrails: true, planningOntology: {version:2,modules:{decomposition:true}} }) };
  t.after(async () => { await engine.close(); await tasks.close(); const resolved = path.resolve(directory); assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('blackice-coordination-')); await fs.rm(resolved, { recursive: true, force: true }); });
  const start = () => engine.startRun({ workflow: workflow(), input: 'Complete the local fixture task.' });
  const settled = id => until(() => { const run = engine.getRun(id); return run.settled && run; }, 'settled run');
  return { directory, tasks, clock, entered, engine, start, settled };
}

test('a long active prerequisite is excluded even while its final coordinator is queued', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { grace: 100, execute: async options => {
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


test('current shared graph runs prerequisites in order without historical readiness or branch-choice injection',async t=>{const f=await fixture(t);assert.equal(f.engine.coordinationWaitMs,60000);const run=await f.settled(f.start().id);assert.equal(run.status,'completed',run.error);assert.equal(run.planningContractVersion,14);assert.equal(f.entered.length,2);assert.match(f.entered[0].prompt,/^You are worker/);assert.match(f.entered[1].prompt,/^You are coordinator/);assert.equal(f.clock.timers.size,0);assert.equal(run.events.some(e=>e.data?.type==='coordination.stalled'),false);});
test('cancelling a real active prerequisite prevents queued coordinator dispatch and late stall',async t=>{let release;const held=new Promise(r=>release=r);const f=await fixture(t,{execute:async options=>{options.signal.addEventListener('abort',release,{once:true});await held;return complete(options);}});const run=f.start();await until(()=>f.entered.length===1);f.engine.cancelRun(run.id);release();const stopped=await f.settled(run.id);f.clock.advance(3600000);assert.equal(stopped.status,'cancelled');assert.equal(f.entered.length,1);assert.notEqual(stopped.nodes.coordinator.status,'completed');assert.equal(stopped.events.some(e=>e.data?.type==='coordination.stalled'),false);assert.equal(f.clock.timers.size,0);});
test('operation queue keeps actual running work owned until failure settles then retries without overlapping',async t=>{const releases=[];const f=await fixture(t,{maxConcurrentRuns:1,execute:async options=>{await new Promise(resolve=>{releases.push(resolve);options.signal.addEventListener('abort',resolve,{once:true});});throw Error('Synthetic provider failure after admission');}});const inbox=await new TaskInbox({dataDir:f.directory,engine:f.engine}).init();const operations=await new OperationsStore({dataDir:f.directory,inbox,engine:f.engine,clock:()=>1792790000000+f.clock.now(),pollMs:10000}).init();operations.kick=()=>{};t.after(async()=>{for(const r of releases)r();await operations.close();await inbox.close();});const deployment=await operations.create({name:'Current queue fixture',input:'Complete fixture',cwd:f.directory,workflow:workflow(),overlap:'queue',retry:{maxAttempts:1,backoffSeconds:1}});const first=await operations.trigger(deployment.id),second=await operations.trigger(deployment.id);await operations.poll();await until(()=>releases.length===1);const firstRunId=operations.getJob(first.id).attempts[0].runId;await operations.poll();assert.equal(operations.getJob(first.id).status,'running');assert.equal(operations.getJob(second.id).status,'queued');releases[0]();await f.settled(firstRunId);await operations.poll();assert.equal(operations.getJob(first.id).status,'retry_wait');assert.equal(inbox.get(operations.getJob(first.id).attempts[0].inboxId).status,'failed');f.clock.advance(1000);await operations.poll();await until(()=>releases.length===2);const retry=operations.getJob(first.id);assert.equal(retry.attempts.length,2);assert.notEqual(retry.attempts[1].runId,firstRunId);assert.equal(operations.getJob(second.id).status,'queued');releases[1]();await f.settled(retry.attempts[1].runId);await operations.poll();assert.equal(operations.getJob(first.id).status,'failed');assert.equal(operations.getJob(second.id).status,'running');f.engine.cancelRun(operations.getJob(second.id).attempts[0].runId);});
