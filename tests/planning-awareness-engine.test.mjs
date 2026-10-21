import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const call = (options, name, args) => options.onToolCall({ name, arguments: args });
async function task(options, args) { const receipt = await call(options, 'relay_task', args); assert.equal(receipt.success, true, receipt.contentItems[0].text); return payload(receipt); }
const action = (id, parentId = null) => ({ id, title: id, kind: 'action', parentId, status: 'pending', doneWhen: `${id} has a checked fixture result.` });
const workflow = {
  name: 'Awareness fixture', settings: { maxParallel: 2 },
  nodes: [{ id: 'input', type: 'input', name: 'Request' }, { id: 'agent', type: 'agent', name: 'Agent', model: 'fixture-awareness', prompt: 'Complete the requested work.' }, { id: 'output', type: 'output', name: 'Result' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
};
async function fixture(t, execute, { delegates = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-awareness-engine-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), settings = await new RuntimeSettingsStore({ dataDir: directory }).init();
  if (delegates) await settings.update({ subagentsEnabled: true, maxSubagents: 2 });
  const context = { tasks, cwd };
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-awareness', models: [{ id: 'fixture-awareness', supportsTools: true }] }; }
    runAgent(options) { return execute(options, context); }
  }
  const engine = new HarnessEngine({ runtime: new Runtime(), tasks, dataDir: directory, defaultCwd: cwd }); engine.runtimeSettings = settings; await engine.init(); context.engine = engine;
  t.after(async () => { await engine.close(); await settings.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...context, async run() {
    const accepted = engine.startRun({ workflow, input: { task: 'Check actual saved-edit awareness and file writes.' } }), deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const result = engine.getRun(accepted.id); if (result.settled) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('The controlled awareness engine did not settle.');
  } };
}

test('the main engine refuses an actual workspace write after a human correction and resumes after read delivery', async t => {
  let beforeRead, afterRead;
  const f = await fixture(t, async (options, context) => {
    const initial = await task(options, { action: 'read' });
    const plan = await task(options, { action: 'plan', expectedRevision: initial.revision, plan: { layout: 'parallel' }, steps: [action('build')] });
    await task(options, { action: 'read' });
    context.tasks.awareness.setPresence(plan, { editorId: 'human-editor', stepId: 'build' }, { type: 'local-human', id: 'local-user' });
    const advisory = await call(options, 'relay_workspace', { action: 'write', path: 'presence.txt', text: 'Presence is advisory.' });
    assert.equal(advisory.success, true); assert.equal(payload(advisory).path, path.join(context.cwd, 'presence.txt'));
    assert.equal(JSON.parse(advisory.contentItems[1].text).presence[0].stepId, 'build');
    assert.equal(await readFile(path.join(context.cwd, 'presence.txt'), 'utf8'), 'Presence is advisory.');
    const corrected = await context.tasks.editPlan(initial.taskId, { operations: [{ type: 'update', stepId: 'build', patch: { note: 'Write the revised text after reading this correction.' } }] }, { expectedRevision: plan.revision, source: 'human' });
    const write = { action: 'write', path: 'actual.txt', text: 'Revised fixture result.' };
    const denied = await call(options, 'relay_workspace', write); assert.equal(denied.code, 'TASK_PLAN_REVIEW_REQUIRED');
    await assert.rejects(readFile(path.join(context.cwd, 'actual.txt')), { code: 'ENOENT' });
    beforeRead = context.tasks.awareness.snapshot(corrected).workers[0];
    const reviewed = await task(options, { action: 'read' }); assert.match(reviewed.steps[0].note, /revised text/);
    afterRead = context.tasks.awareness.snapshot(corrected).workers[0];
    const actual = await call(options, 'relay_workspace', write); assert.equal(actual.success, true, actual.contentItems[0].text);
    await task(options, { action: 'step', expectedRevision: reviewed.revision, stepId: 'build', status: 'done', evidence: 'The actual written file contains the revised fixture result.' });
    return { output: 'Written and checked the revised fixture result.' };
  });
  const result = await f.run(); assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(path.join(f.cwd, 'actual.txt'), 'utf8'), 'Revised fixture result.');
  assert.equal(beforeRead.state, 'needs-review'); assert.equal(afterRead.state, 'current'); assert.ok(afterRead.lastReadRevision > beforeRead.lastReadRevision);
  assert.equal(result.nodes.agent.planningAwareness.lastReadRevision, afterRead.lastReadRevision);
  assert.equal(f.tasks.awareness.snapshot(await f.tasks.get(result.taskId)).workers[0].state, 'finished');
});

test('an assigned delegate receives the same saved-edit gate and cannot operate with an unread correction', async t => {
  let deniedCount = 0, childReadRevision;
  const f = await fixture(t, async (options, context) => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      let current = await task(options, { action: 'read' });
      const step = current.steps.find(item => item.id === 'inspect');
      current = await context.tasks.editPlan(current.taskId, { operations: [{ type: 'update', stepId: step.id, patch: { note: 'Read this delegated correction before changing the file.' } }] }, { expectedRevision: current.revision, source: 'human' });
      const denied = await call(options, 'relay_workspace', { action: 'write', path: 'delegated.txt', text: 'Unreviewed' }); assert.equal(denied.code, 'TASK_PLAN_REVIEW_REQUIRED'); deniedCount++;
      await assert.rejects(readFile(path.join(context.cwd, 'delegated.txt')), { code: 'ENOENT' });
      current = await task(options, { action: 'read' }); childReadRevision = current.revision;
      assert.equal(current.planningAwareness.worker.lastReadRevision, current.revision);
      const written = await call(options, 'relay_workspace', { action: 'write', path: 'delegated.txt', text: 'Reviewed delegated result.' }); assert.equal(written.success, true);
      await task(options, { action: 'step', expectedRevision: current.revision, stepId: 'inspect', status: 'done', evidence: 'The delegated result was actually written after the saved correction was read.' });
      return { output: 'Reviewed and wrote the delegated result.' };
    }
    let current = await task(options, { action: 'read' });
    current = await task(options, { action: 'plan', expectedRevision: current.revision, plan: { layout: 'sequence' }, steps: [action('inspect'), action('integrate')] });
    const delegated = await call(options, 'relay_delegate', { tasks: [{ id: 'inspector', stepId: 'inspect', prompt: 'Implement only the assigned inspection result.' }] });
    assert.equal(delegated.success, true, delegated.contentItems[0].text);
    current = await task(options, { action: 'read' });
    await task(options, { action: 'step', expectedRevision: current.revision, stepId: 'integrate', status: 'done', evidence: 'The actual returned worker result and file were checked.' });
    return { output: 'Integrated the reviewed delegated result.' };
  }, { delegates: true });
  const result = await f.run(); assert.equal(result.status, 'completed', result.error); assert.equal(deniedCount, 1);
  assert.equal(await readFile(path.join(f.cwd, 'delegated.txt'), 'utf8'), 'Reviewed delegated result.');
  const worker = f.tasks.awareness.snapshot(await f.tasks.get(result.taskId)).workers.find(item => item.nodeId.startsWith('delegate-'));
  assert.equal(worker.lastReadRevision, childReadRevision); assert.equal(worker.status, 'completed');
});
