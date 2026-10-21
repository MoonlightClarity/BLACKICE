import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore, delegatedPlanNodeId } from '../lib/task-state.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { AttachmentStore } from '../lib/attachments.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async check => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The live planning engine did not reach the expected state.');
};
const payload = returned => JSON.parse(returned.contentItems[0].text);
const tool = (options, name, args) => options.onToolCall({ name, arguments: args });
async function taskCall(options, args) {
  const returned = await tool(options, 'relay_task', args); assert.equal(returned.success, true, returned.contentItems[0].text); return payload(returned);
}
async function revise(options, build) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await taskCall(options, { action: 'read' });
    const returned = await tool(options, 'relay_task', { ...build(state), expectedRevision: state.revision });
    if (returned.code === 'TASK_STATE_CONFLICT') continue;
    assert.equal(returned.success, true, returned.contentItems[0].text); return payload(returned);
  }
  assert.fail('The fixture could not merge its own progress with other worker revisions.');
}
const acknowledge = (options, nodeId) => revise(options, () => ({ action: 'edit', operations: [{ type: 'update', stepId: `agent-${nodeId}-work`, patch: { status: 'active', note: `Started the assigned ${nodeId} check.` } }] }));
const complete = (options, stepId) => revise(options, () => ({ action: 'step', stepId, status: 'done', evidence: `The actual ${stepId} fixture result was checked.` }));
const agent = (id, extra = {}) => ({ id, type: 'agent', name: id, prompt: `Complete the assigned ${id} work.`, model: 'fixture-planning', assignment: { scope: `Only ${id} fixture work.`, inputs: ['The original request.'], result: `Checked ${id} result.`, doneWhen: `The ${id} result passes its stated check.`, canWrite: true }, ...extra });
const graph = (agents, edges, shared = true) => ({
  name: 'Live planning fixture',
  nodes: [{ id: 'input', type: 'input', name: 'User request' }, ...agents, { id: 'output', type: 'output', name: 'Final result' }],
  edges: edges.map(([source, target]) => ({ source, target })), settings: { maxParallel: 2 },
  ...(shared ? { planning: { shared: true, coordinatorNodeId: 'coordinator' } } : {})
});

async function fixture(t, workflow, execute, { holds = [], subagents = false, attachmentText } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-runtime-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), prefs = await new RuntimeSettingsStore({ dataDir: directory }).init();
  if (subagents) await prefs.update({ subagentsEnabled: true, maxSubagents: 2 });
  const attachments = attachmentText === undefined ? undefined : await new AttachmentStore({ dataDir: directory }).init();
  const attachment = attachments ? await attachments.importBytes({ name: 'input.txt', bytes: Buffer.from(attachmentText) }) : undefined;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-planning', models: [{ id: 'fixture-planning', supportsTools: true }] }; }
    runAgent(options) { return execute(options, context); }
  }
  const engine = new HarnessEngine({ runtime: new Runtime(), tasks, attachments, dataDir: directory, defaultCwd: cwd }); engine.runtimeSettings = prefs; await engine.init();
  const context = { engine, tasks, cwd, workflow, attachment,
    start: () => engine.startRun({ workflow, input: { task: 'Complete and check the requested fixture work.', ...(attachment ? { attachmentIds: [attachment.id] } : {}) } }),
    settled: id => waitFor(() => { const run = engine.getRun(id); return run.settled && run; })
  };
  t.after(async () => { for (const hold of holds) hold.resolve(); await engine.close(); await prefs.close(); await tasks.close(); await attachments?.close(); await rm(directory, { recursive: true, force: true }); });
  return context;
}
const who = options => options.prompt.match(/^You are ([a-z]+)\./)?.[1];

test('a shared branch really starts its dependent before an unrelated coordinator finishes', async t => {
  const hold = deferred(), entered = [], workflow = graph([agent('coordinator'), agent('left'), agent('right')], [
    ['input', 'coordinator'], ['input', 'left'], ['left', 'right'], ['coordinator', 'output'], ['right', 'output']
  ]);
  const f = await fixture(t, workflow, async (options, context) => {
    const id = who(options); entered.push(id); await acknowledge(options, id);
    if (id === 'coordinator') await hold.promise;
    if (id === 'right') {
      const run = context.engine.listRuns()[0]; assert.equal(run.nodes.coordinator.status, 'running'); assert.equal(run.nodes.left.status, 'completed');
      assert.match(options.prompt, /UPSTREAM RESULTS[\s\S]*Actual left result/);
    }
    await complete(options, `agent-${id}-work`); return { output: `Actual ${id} result.` };
  }, { holds: [hold] });
  const accepted = f.start();
  await waitFor(() => f.engine.getRun(accepted.id).nodes.right.status === 'completed');
  assert.deepEqual(new Set(entered), new Set(['coordinator', 'left', 'right']));
  assert.equal(f.engine.getRun(accepted.id).settled, false);
  const state = await f.tasks.get(accepted.taskId); assert.equal(state.execution.nodes.coordinator.status, 'running'); assert.equal(state.execution.nodes.right.status, 'completed');
  hold.resolve(); const finished = await f.settled(accepted.id); assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.taskState.progress.done, 3);
});

test('a human dependency edit wakes ready work while the coordinator is awaiting its own result', async t => {
  const hold = deferred(), workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['coordinator', 'worker'], ['worker', 'output']]);
  const f = await fixture(t, workflow, async options => {
    const id = who(options); await acknowledge(options, id); if (id === 'coordinator') await hold.promise;
    await complete(options, `agent-${id}-work`); return { output: `Actual ${id} result.` };
  }, { holds: [hold] });
  const accepted = f.start();
  await waitFor(() => f.engine.getRun(accepted.id).nodes.coordinator.planning?.status === 'recorded');
  const previous = await f.tasks.get(accepted.taskId);
  const human = await f.tasks.editPlan(accepted.taskId, { operations: [{ type: 'dependencies', stepId: 'agent-worker', dependsOn: [] }] }, { expectedRevision: previous.revision, source: 'human' });
  assert.equal(human.provenance.source, 'human'); assert.equal(human.execution.nodes.worker.status, 'queued');
  await waitFor(() => f.engine.getRun(accepted.id).nodes.worker.status === 'completed');
  assert.equal(f.engine.getRun(accepted.id).nodes.coordinator.status, 'running');
  hold.resolve(); const finished = await f.settled(accepted.id); assert.equal(finished.status, 'completed', finished.error);
});

test('a human completion report cannot finish a held runtime or release its dependent prematurely', async t => {
  const hold = deferred(), entered = [], workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['coordinator', 'worker'], ['worker', 'output']]);
  const f = await fixture(t, workflow, async options => {
    const id = who(options); entered.push(id); await acknowledge(options, id);
    if (id === 'coordinator') await hold.promise; else await complete(options, 'agent-worker-work');
    return { output: `Actual ${id} result.` };
  }, { holds: [hold] });
  const accepted = f.start(); await waitFor(() => f.engine.getRun(accepted.id).nodes.coordinator.planning?.status === 'recorded');
  const previous = await f.tasks.get(accepted.taskId), human = await f.tasks.editPlan(accepted.taskId, { operations: [{ type: 'update', stepId: 'agent-coordinator-work', patch: { status: 'done', evidence: 'A human supplied a separate observation while the worker was still running.' } }] }, { expectedRevision: previous.revision, source: 'human' });
  await waitFor(() => f.engine.getRun(accepted.id).taskState.revision >= human.revision); await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(entered, ['coordinator']); assert.equal(f.engine.getRun(accepted.id).nodes.worker.status, 'queued');
  assert.equal(human.execution.nodes.coordinator.status, 'running'); assert.equal(human.availableWork.byId['agent-worker-work'].state, 'waiting');
  hold.resolve(); const finished = await f.settled(accepted.id); assert.equal(finished.status, 'completed', finished.error); assert.ok(entered.includes('worker'));
});

test('the runtime enforces read-only and plan ownership while an authorized implementation owner can write', async t => {
  const readonly = agent('worker'); readonly.assignment.canWrite = false; readonly.assignment.scope = 'Inspect input.txt only; report the observed content and do not change files.';
  const workflow = graph([readonly, agent('coordinator')], [['input', 'worker'], ['worker', 'coordinator'], ['coordinator', 'output']]);
  const f = await fixture(t, workflow, async (options, context) => {
    const id = who(options); await acknowledge(options, id);
    if (id === 'worker') {
      assert.equal(options.sandbox, 'read-only'); assert.match(options.prompt, /Inspect input\.txt only; report the observed content/);
      assert.ok(!options.dynamicTools.some(tool => ['relay_control', 'relay_delegate', 'relay_desktop', 'relay_identity', 'relay_project', 'relay_prompts'].includes(tool.name)));
      for (const args of [{ action: 'write', path: 'forbidden.txt', text: 'No.' }, { action: 'run', command: 'echo no' }]) {
        const denied = await tool(options, 'relay_workspace', args); assert.equal(denied.success, false); assert.equal(denied.code, 'TASK_PLAN_READ_ONLY');
      }
      const read = await tool(options, 'relay_files', { action: 'read', attachmentId: context.attachment.id });
      assert.equal(read.success, true); assert.match(JSON.stringify(payload(read)), /Actual attached fixture input/);
      const exported = await tool(options, 'relay_files', { action: 'export', attachmentId: context.attachment.id });
      assert.equal(exported.success, false); assert.equal(exported.code, 'TASK_PLAN_READ_ONLY');
      const current = await taskCall(options, { action: 'read' });
      const foreign = await tool(options, 'relay_task', { action: 'edit', expectedRevision: current.revision, operations: [{ type: 'update', stepId: 'agent-coordinator-work', patch: { title: 'Take another owner' } }] });
      assert.equal(foreign.code, 'TASK_PLAN_OWNERSHIP');
      const remote = await tool(options, 'relay_task', { action: 'external', expectedRevision: current.revision, external: { operation: 'attempt', receiptId: 'forbidden-send' } });
      assert.equal(remote.code, 'TASK_PLAN_OWNERSHIP');
      await revise(options, () => ({ action: 'plan', steps: [{ id: 'agent-worker-inspect', title: 'Inspect the assigned input', kind: 'action', parentId: null, status: 'active', doneWhen: 'The assigned content was inspected and its actual result recorded.' }] }));
      await complete(options, 'agent-worker-inspect');
    } else {
      assert.equal(options.sandbox, 'danger-full-access');
      const written = await tool(options, 'relay_workspace', { action: 'write', path: 'authorized.txt', text: 'An authorized fixture result.' }); assert.equal(written.success, true);
      const exported = await tool(options, 'relay_files', { action: 'export', attachmentId: context.attachment.id }); assert.equal(exported.success, true);
      assert.equal(await readFile(payload(exported).path, 'utf8'), 'Actual attached fixture input.');
      await complete(options, 'agent-coordinator-work');
    }
    return { output: `Actual ${id} result.` };
  }, { attachmentText: 'Actual attached fixture input.' });
  const run = await f.settled(f.start().id); assert.equal(run.status, 'completed', JSON.stringify({ error: run.error, worker: run.nodes.worker.error, coordinator: run.nodes.coordinator.error }));
  await assert.rejects(readFile(path.join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.cwd, 'authorized.txt'), 'utf8'), 'An authorized fixture result.');
  assert.equal(run.taskState.steps.find(step => step.id === 'agent-coordinator-work').title, 'coordinator');
});

test('on-demand linked workers maintain the same saved plan within their action scope and preserve actual execution receipts', async t => {
  const workflow = graph([agent('coordinator')], [['input', 'coordinator'], ['coordinator', 'output']], false); let childReceipt;
  const f = await fixture(t, workflow, async (options, context) => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_task'));
      assert.ok(!options.dynamicTools.some(tool => ['relay_delegate', 'relay_control'].includes(tool.name)));
      const current = await taskCall(options, { action: 'read' }); assert.equal(current.execution.nodes[delegatedPlanNodeId('coordinator', 'inspector')].status, 'running');
      const denied = await tool(options, 'relay_task', { action: 'edit', expectedRevision: current.revision, operations: [{ type: 'update', stepId: 'summary', patch: { title: 'Changed another owner' } }] }); assert.equal(denied.code, 'TASK_PLAN_OWNERSHIP');
      await revise(options, () => ({ action: 'plan', steps: [{ id: 'inspect-input', kind: 'action', parentId: null, title: 'Read the delegated input', status: 'active', doneWhen: 'The actual input was checked.' }] }));
      await complete(options, 'inspect-input'); return { output: 'Checked the assigned input and recorded its evidence.' };
    }
    await revise(options, () => ({ action: 'plan', plan: { layout: 'sequence' }, steps: [
      { id: 'inspect', title: 'Inspect the delegated input', kind: 'action', parentId: null, status: 'pending', doneWhen: 'The delegated input was checked.' },
      { id: 'summary', title: 'Review the actual worker result', kind: 'action', parentId: null, status: 'pending', doneWhen: 'The actual returned result was reviewed.' }
    ] }));
    const returned = await tool(options, 'relay_delegate', { tasks: [{ id: 'inspector', stepId: 'inspect', prompt: 'Inspect only the assigned input and maintain that saved plan action.' }] });
    assert.equal(returned.success, true, returned.contentItems[0].text); childReceipt = payload(returned).results[0];
    const after = await taskCall(options, { action: 'read' }); assert.equal(after.execution.nodes[delegatedPlanNodeId('coordinator', 'inspector')].status, 'completed');
    assert.equal(after.steps.find(step => step.id === 'summary').title, 'Review the actual worker result');
    await complete(options, 'summary'); return { output: 'Reviewed the actual delegated result.' };
  }, { subagents: true });
  const run = await f.settled(f.start().id); assert.equal(run.status, 'completed', run.error);
  assert.equal(childReceipt.status, 'completed'); assert.equal(run.taskState.steps.find(step => step.id === 'inspect-input').status, 'done');
  assert.equal(run.taskState.execution.nodes[delegatedPlanNodeId('coordinator', 'inspector')].status, 'completed');
});

test('a worker failure preserves its real cause and settles the other runtime before publishing final status', async t => {
  const ready = deferred(), stopped = deferred(); let workerSettled = false;
  const workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['input', 'worker'], ['coordinator', 'output'], ['worker', 'output']]);
  const f = await fixture(t, workflow, async options => {
    const id = who(options); await acknowledge(options, id);
    if (id === 'coordinator') { await ready.promise; throw Error('The actual required fixture source is unavailable.'); }
    const stop = () => stopped.resolve(); options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop(); ready.resolve();
    try { await stopped.promise; workerSettled = true; throw Object.assign(Error('The independent fixture worker stopped.'), { name: 'AbortError' }); }
    finally { options.signal.removeEventListener('abort', stop); }
  }, { holds: [ready, stopped] });
  const run = await f.settled(f.start().id);
  assert.equal(run.status, 'failed'); assert.equal(run.error, 'The actual required fixture source is unavailable.'); assert.equal(workerSettled, true);
  assert.equal(run.nodes.worker.status, 'cancelled'); assert.equal(run.taskState.execution.nodes.worker.status, 'cancelled');
  assert.equal(run.taskState.execution.nodes.coordinator.status, 'failed');
});
