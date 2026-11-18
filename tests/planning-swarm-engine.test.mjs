import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Current engine scheduling and effects; manual notes never control runtime admission.
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
  await prefs.update({ executionGuardrails: true, planningOntology:{version:2,modules:{decomposition:true}} });
  if (subagents) await prefs.update({ subagentsEnabled: true, maxSubagents: 2 });
  const attachments = attachmentText === undefined ? undefined : await new AttachmentStore({ dataDir: directory }).init();
  const attachment = attachments ? await attachments.importBytes({ name: 'input.txt', bytes: Buffer.from(attachmentText) }) : undefined;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-planning', models: [{ id: 'fixture-planning', supportsTools: true }] }; }
    async runAgent(options) { const review = fixtureOutcomeReview(options); if (review) return review; return finishFixtureCandidate(options, await execute(options, context)); }
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

test('Current task execution preserves authored workflow parallelism without serial planner admission', async t => {
  const hold = deferred(), entered = [], workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['input', 'worker'], ['coordinator', 'output'], ['worker', 'output']]);
  const f = await fixture(t, workflow, async options => {
    const id = who(options); entered.push(id);
    if (id === 'coordinator') await hold.promise;
    return { output: `Actual ${id} result.` };
  }, { holds: [hold] });
  const accepted = f.start();
  await waitFor(() => f.engine.getRun(accepted.id).nodes.worker.status === 'completed');
  assert.deepEqual(new Set(entered), new Set(['coordinator', 'worker']));
  assert.equal(f.engine.getRun(accepted.id).nodes.coordinator.status, 'running');
  assert.equal(f.engine.getRun(accepted.id).settled, false);
  hold.resolve();
  const finished = await f.settled(accepted.id);
  assert.equal(finished.status, 'completed', finished.error); assert.deepEqual(entered, ['coordinator', 'worker']);
  assert.equal(finished.workflow.settings.maxParallel, 2, 'Authored settings remain intact; a historical On value does not serialize independent work.');
  assert.equal(finished.nodes.coordinator.output, 'Actual coordinator result.');
  assert.equal(finished.nodes.worker.output, 'Actual worker result.');
  assert.equal(finished.planningContractVersion, 14);
});

test('Planning Off preserves shared workflow concurrency before an unrelated coordinator finishes', async t => {
  const hold = deferred(), entered = [], workflow = graph([agent('coordinator'), agent('left'), agent('right')], [
    ['input', 'coordinator'], ['input', 'left'], ['left', 'right'], ['coordinator', 'output'], ['right', 'output']
  ]);
  workflow.settings.planningMode = 'off';
  const f = await fixture(t, workflow, async (options, context) => {
    const id = who(options); entered.push(id);
    if (id === 'coordinator') await hold.promise;
    if (id === 'right') {
      const run = context.engine.listRuns()[0]; assert.equal(run.nodes.coordinator.status, 'running'); assert.equal(run.nodes.left.status, 'completed');
      assert.match(options.prompt, /UPSTREAM RESULTS[\s\S]*Actual left result/);
    }
    return { output: `Actual ${id} result.` };
  }, { holds: [hold] });
  const accepted = f.start();
  await waitFor(() => f.engine.getRun(accepted.id).nodes.right.status === 'completed');
  assert.deepEqual(new Set(entered), new Set(['coordinator', 'left', 'right']));
  assert.equal(f.engine.getRun(accepted.id).settled, false);
  assert.equal(f.engine.getRun(accepted.id).nodes.coordinator.status, 'running');
  assert.equal(f.engine.getRun(accepted.id).nodes.right.output, 'Actual right result.');
  hold.resolve(); const finished = await f.settled(accepted.id); assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.nodes.left.output, 'Actual left result.');
});

for (const edit of ['dependencies', 'completion']) test('a manual ' + edit + ' edit cannot finish a held runtime or release its dependent', async t => {
  const hold = deferred(), entered = [], workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['coordinator', 'worker'], ['worker', 'output']]);
  workflow.settings.planningMode = 'off';
  const f = await fixture(t, workflow, async options => {
    const id = who(options); entered.push(id); if (id === 'coordinator') await hold.promise;
    return { output: 'Actual ' + id + ' result.' };
  }, { holds: [hold] });
  const accepted = f.start(); await waitFor(() => entered.includes('coordinator'));
  const previous = await f.tasks.get(accepted.taskId);
  const notes = await f.tasks.setPlan(accepted.taskId, { plan: { layout: 'sequence' }, steps: [
    { id: 'coordinator-note', kind: 'action', title: 'Coordinator observation', status: 'active', result: 'Observed coordinator result.', note: 'Compare the observed coordinator result with the requested result.', doneWhen: 'The actual result is checked.' },
    { id: 'worker-note', kind: 'action', title: 'Worker observation', status: 'pending', dependsOn: ['coordinator-note'], result: 'Observed worker result.', note: 'Compare the worker observation with the coordinator result.', doneWhen: 'The actual worker result is checked.' }
  ] }, { expectedRevision: previous.revision, source: 'human' });
  const operations = edit === 'dependencies' ? [{ type: 'dependencies', stepId: 'worker-note', dependsOn: [] }] : [{ type: 'update', stepId: 'coordinator-note', patch: { status: 'done', evidence: 'A human supplied a separate observation while the runtime was still running.' } }];
  const human = await f.tasks.editPlan(accepted.taskId, { operations }, { expectedRevision: notes.revision, source: 'human' });
  assert.equal(human.provenance.source, 'human');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(entered, ['coordinator']);
  assert.equal(f.engine.getRun(accepted.id).nodes.coordinator.status, 'running');
  assert.equal(f.engine.getRun(accepted.id).nodes.worker.status, 'queued');
  assert.equal(f.engine.getRun(accepted.id).settled, false);
  hold.resolve(); const finished = await f.settled(accepted.id);
  assert.equal(finished.status, 'completed', finished.error); assert.deepEqual(entered, ['coordinator', 'worker']);
  assert.equal(finished.nodes.worker.output, 'Actual worker result.');
});

test('assignment metadata preserves ordinary effects while historical model writes fail closed', async t => {
  const readonly = agent('worker'); readonly.assignment.canWrite = false; readonly.assignment.scope = 'Inspect input.txt only; report the observed content and do not change files.';
  const workflow = graph([readonly, agent('coordinator')], [['input', 'worker'], ['worker', 'coordinator'], ['coordinator', 'output']]);
  workflow.settings.planningMode = 'off';
  const f = await fixture(t, workflow, async (options, context) => {
    const id = who(options);
    if (id === 'worker') {
      assert.equal(options.sandbox, 'danger-full-access'); assert.match(options.prompt, /Inspect input\.txt only; report the observed content/);
      assert.doesNotMatch(options.prompt,/"canWrite"|This assignment is read-only/);
      assert.ok(!options.dynamicTools.some(tool => ['relay_control', 'relay_delegate', 'relay_desktop', 'relay_identity', 'relay_project', 'relay_prompts'].includes(tool.name)));
      const written=await tool(options,'relay_workspace',{action:'write',path:'worker-result.txt',text:'A checked worker result.'});
      assert.equal(written.success,true,JSON.stringify(written));
      assert.equal(await readFile(path.join(context.cwd,'worker-result.txt'),'utf8'),'A checked worker result.');
      const read = await tool(options, 'relay_files', { action: 'read', attachmentId: context.attachment.id });
      assert.equal(read.success, true); assert.match(JSON.stringify(payload(read)), /Actual attached fixture input/);
      const exported = await tool(options, 'relay_files', { action: 'export', attachmentId: context.attachment.id });
      assert.equal(exported.success, true);assert.equal(await readFile(payload(exported).path,'utf8'),'Actual attached fixture input.');
      const current = payload(await tool(options, 'relay_task', { action: 'read' }));
      for (const args of [
        { action: 'edit', expectedRevision: current.revision, operations: [{ type: 'update', stepId: 'agent-coordinator-work', patch: { title: 'Take another owner' } }] },
        { action: 'external', expectedRevision: current.revision, external: { operation: 'attempt', receiptId: 'forbidden-send' } },
        { action: 'plan', expectedRevision: current.revision, steps: [] },
        { action: 'step', stepId: 'agent-worker-work', status: 'done', evidence: 'Unsupported completion.' },
        { action: 'review', expectedRevision: current.revision, review: { decision: 'respond', summary: 'Unsupported manual reassessment.' } }
      ]) {
        const rejected = await tool(options, 'relay_task', args);
        assert.equal(rejected.success, false); assert.equal(rejected.code, 'TASK_CONTRACT_INVALID');
      }
      const unchanged = payload(await tool(options, 'relay_task', { action: 'read' }));
      assert.equal(unchanged.revision, current.revision, 'Rejected historical writes cannot mutate the current task.');
    } else {
      assert.equal(options.sandbox, 'danger-full-access');
      const written = await tool(options, 'relay_workspace', { action: 'write', path: 'authorized.txt', text: 'An authorized fixture result.' }); assert.equal(written.success, true);
      const exported = await tool(options, 'relay_files', { action: 'export', attachmentId: context.attachment.id }); assert.equal(exported.success, true);
      assert.equal(await readFile(payload(exported).path, 'utf8'), 'Actual attached fixture input.');

    }
    return { output: `Actual ${id} result.` };
  }, { attachmentText: 'Actual attached fixture input.' });
  const run = await f.settled(f.start().id); assert.equal(run.status, 'completed', JSON.stringify({ error: run.error, worker: run.nodes.worker.error, coordinator: run.nodes.coordinator.error }));
  await assert.rejects(readFile(path.join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.cwd, 'authorized.txt'), 'utf8'), 'An authorized fixture result.');
  assert.equal(run.nodes.worker.output, 'Actual worker result.');
  assert.equal(run.nodes.coordinator.output, 'Actual coordinator result.');
});

test('historical linked single-scope work is rejected before ownership transfer or a child provider turn', async t => {
  const workflow = graph([agent('coordinator')], [['input', 'coordinator'], ['coordinator', 'output']], false);
  let childCalls = 0;
  const f = await fixture(t, workflow, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      childCalls++; assert.fail('A single linked assignment has no parallel work to dispatch.');
    }
    const returned = await tool(options, 'relay_delegate', { tasks: [{ id: 'inspector', stepId: 'inspect', prompt: 'Inspect only the assigned input and maintain that saved plan action.' }] });
    assert.equal(returned.success, false); assert.equal(payload(returned).code, 'SUBAGENT_SINGLE_WORK_ITEM');
    assert.equal(payload(returned).providerCalls, 0); assert.equal(payload(returned).gate, 'static_dag');
    return { output: 'The coordinator keeps the serial inspection and has not transferred ownership.' };
  }, { subagents: true });
  const run = await f.settled(f.start().id);
  assert.equal(run.status, 'completed', run.error); assert.equal(childCalls, 0);
  assert.ok(!run.events.some(event => event.data?.type === 'subagent' && event.data.status === 'running'));
  const state = await f.tasks.get(run.taskId);
  assert.equal(state.execution?.nodes?.[delegatedPlanNodeId('coordinator', 'inspector')], undefined);
});

test('a concurrent Planning Off worker failure preserves its cause and settles the other runtime before final status', async t => {
  const ready = deferred(), stopped = deferred(); let workerSettled = false;
  const workflow = graph([agent('coordinator'), agent('worker')], [['input', 'coordinator'], ['input', 'worker'], ['coordinator', 'output'], ['worker', 'output']]);
  workflow.settings.planningMode = 'off';
  const f = await fixture(t, workflow, async options => {
    const id = who(options);
    if (id === 'coordinator') { await ready.promise; throw Error('The actual required fixture source is unavailable.'); }
    const stop = () => stopped.resolve(); options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop(); ready.resolve();
    try { await stopped.promise; workerSettled = true; throw Object.assign(Error('The independent fixture worker stopped.'), { name: 'AbortError' }); }
    finally { options.signal.removeEventListener('abort', stop); }
  }, { holds: [ready, stopped] });
  const run = await f.settled(f.start().id);
  assert.equal(run.status, 'failed'); assert.equal(run.error, 'The actual required fixture source is unavailable.'); assert.equal(workerSettled, true);
  assert.equal(run.nodes.worker.status, 'cancelled');
  assert.equal(run.nodes.coordinator.status, 'failed');
});

test('Planning Off explicit canonical assignments transfer only named ownership before children start', async t => {
  const workflow = graph([agent('coordinator')], [['input', 'coordinator'], ['coordinator', 'output']], false);
  workflow.settings.planningMode = 'off';
  const children = [];
  const f = await fixture(t, workflow, async (options, context) => {
    const invoke = async (name, args) => {
      const call = { name, arguments: args }, result = await options.onToolCall(call);
      await options.onToolResultDelivered?.({ call, result });
      return result;
    };
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      const state = await context.tasks.get(context.engine.listRuns()[0].taskId);
      const expected = options.prompt.split('YOUR ASSIGNED TASK:')[1]?.trimStart().startsWith('Inspect left') ? 'left' : 'right';
      assert.equal(state.contract.workItems.find(item => item.id === expected).owner, delegatedPlanNodeId('coordinator', expected));
      assert.match(options.developerInstructions + '\n' + options.prompt, /DELIVERED CANONICAL WORK-ITEM SNAPSHOT/);
      children.push(expected);
      return { output: 'Inspected ' + expected + ' without claiming an external effect.' };
    }
    const initial = payload(await invoke('relay_task', { action: 'read' }));
    const contract = { contractVersion: 2, goal: 'Inspect two independent inputs', criteria: [{ id: 'checked', kind: 'judgment', description: 'Report both actual observations' }], workItems: ['left', 'right', 'untouched'].map(id => ({ id, title: 'Inspect ' + id, objective: 'Inspect the supplied ' + id + ' input', owner: 'coordinator', resourceKeys: ['workspace:' + id], effects: ['observe'], dependsOn: [], criterionIds: ['checked'] })), instructions: [] };
    const planCall = { name: 'relay_task', arguments: { action: 'plan', expectedRevision: initial.revision, contract } };
    const planned = await options.onToolCall(planCall);
    assert.equal(planned.success, true, JSON.stringify(planned));
    const before = await readFile(context.tasks.file(initial.taskId));
    const stale = await invoke('relay_delegate', { tasks: ['left', 'right'].map(id => ({ id: 'unread-' + id, stepId: id, prompt: 'Inspect ' + id + ' independently' })) });
    assert.equal(stale.success, false, 'A plan not delivered to the provider cannot authorize ownership transfer.');
    assert.match(JSON.stringify(stale), /revision changed/i);
    assert.deepEqual(children, []);
    assert.deepEqual(await readFile(context.tasks.file(initial.taskId)), before);
    await options.onToolResultDelivered?.({ call: planCall, result: planned });
    const unknown = await invoke('relay_delegate', { tasks: ['left', 'right'].map(id => ({ id: 'unknown-' + id, stepId: 'old-outline-' + id, prompt: 'Inspect ' + id + ' independently' })) });
    assert.equal(unknown.success, false, 'Historical outline IDs are not canonical work-item assignments.');
    assert.deepEqual(children, []);
    assert.deepEqual(await readFile(context.tasks.file(initial.taskId)), before);
    const returned = await invoke('relay_delegate', { tasks: ['left', 'right'].map(id => ({ id, stepId: id, prompt: 'Inspect ' + id + ' supplied input independently', readOnly: true })) });
    assert.equal(returned.success, true, JSON.stringify(returned));
    const final = await context.tasks.get(initial.taskId);
    assert.equal(final.contract.workItems.find(item => item.id === 'untouched').owner, 'coordinator');
    assert.equal(final.contractAssignments.length, 2);
    assert.deepEqual(final.contract.criteria, payload(planned).contract.criteria);
    return { output: 'Both assigned inputs inspected.' };
  }, { subagents: true });
  const run = await f.settled(f.start().id);
  assert.equal(run.status, 'completed', run.error || run.nodes.coordinator.error);
  assert.deepEqual(children.sort(), ['left', 'right']);
});
