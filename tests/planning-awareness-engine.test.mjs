import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Historical schema-13 protocol regression; schema-14 behavior has separate canonical-contract and production-engine acceptance coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from './fixture-legacy-planning-engine.mjs';
import { TaskStateStore } from './fixture-legacy-task-state.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { finishFixturePlan } from './fixture-task-plan.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const call = (options, name, args) => options.onToolCall({ name, arguments: args });
async function task(options, args) { const receipt = await call(options, 'relay_task', args); assert.equal(receipt.success, true, receipt.contentItems[0].text); return payload(receipt); }
const action = (id, parentId = null) => ({ id, title: id, kind: 'action', parentId, status: 'pending', operation: { kind: 'reasoning', target: `The ${id} fixture result` }, result: 'The assigned fixture operation and its checked effects.', note: 'Compare the supplied fixture result with its stated criterion.', doneWhen: `${id} has a checked fixture result.` });
const writeAction = (id, target, status = 'active') => ({ ...action(id), status, operation: { kind: 'tool', tool: 'relay_workspace', action: 'write', target }, note: `Write the requested text to ${target} once.` });
const workflow = {
  name: 'Awareness fixture', settings: { maxParallel: 2 },
  nodes: [{ id: 'input', type: 'input', name: 'Request' }, { id: 'agent', type: 'agent', name: 'Agent', model: 'fixture-awareness', prompt: 'Complete the requested work.' }, { id: 'output', type: 'output', name: 'Result' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
};
async function fixture(t, execute, { delegates = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-awareness-engine-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), settings = await new RuntimeSettingsStore({ dataDir: directory }).init();
  // These fixtures exercise the opt-in saved-edit execution gates.
  await settings.update({ executionGuardrails: true, planningOntology:{version:2,modules:{decomposition:true}} });
  if (delegates) await settings.update({ subagentsEnabled: true, maxSubagents: 2 });
  const context = { tasks, cwd };
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-awareness', models: [{ id: 'fixture-awareness', supportsTools: true }] }; }
    async runAgent(options) { const review=fixtureOutcomeReview(options);if(review)return review;return finishFixtureCandidate(options,await execute(options, context)); }
  }
  const engine = new HarnessEngine({ runtime: new Runtime(), tasks, dataDir: directory, defaultCwd: cwd }); engine.runtimeSettings = settings; await engine.init(); context.engine = engine;
  t.after(async () => { await engine.close(); await settings.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...context, async run() {
    const accepted = engine.startRun({ workflow, input: { task: 'Check actual saved-edit awareness and file writes.' } }), deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const result = engine.getRun(accepted.id); if (result.settled) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('The controlled awareness engine did not settle.');
  } };
}

test('manual saved corrections and presence remain visible without installing an automatic execution gate', async t => {
  let correctedRevision;
  const f = await fixture(t, async (options, context) => {
    const initial = await task(options, { action: 'read' });
    let plan = await task(options, { action: 'plan', expectedRevision: initial.revision, plan: { layout: 'sequence' }, steps: [writeAction('presence', 'presence.txt'), writeAction('build', 'actual.txt', 'pending')] });
    context.tasks.awareness.setPresence(plan, { editorId: 'human-editor', stepId: 'build' }, { type: 'local-human', id: 'local-user' });
    assert.equal(context.tasks.awareness.snapshot(plan).presence[0].stepId, 'build');
    const advisory = await call(options, 'relay_workspace', { action: 'write', path: 'presence.txt', text: 'Presence is advisory.' });
    assert.equal(advisory.success, true); assert.equal(payload(advisory).path, path.join(context.cwd, 'presence.txt'));
    plan = await task(options, { action: 'step', expectedRevision: plan.revision, stepId: 'presence', status: 'done', evidence: 'The actual write receipt identifies presence.txt and its saved bytes.' });
    const corrected = await context.tasks.editPlan(initial.taskId, { operations: [{ type: 'update', stepId: 'build', patch: { note: 'Write the revised text.' } }] }, { expectedRevision: plan.revision, source: 'human' });
    correctedRevision = corrected.revision;
    await assert.rejects(context.tasks.editPlan(initial.taskId, { operations: [{ type: 'update', stepId: 'build', patch: { note: 'Stale overwrite' } }] }, { expectedRevision: plan.revision, source: 'human' }), { code: 'TASK_STATE_CONFLICT' });
    const actual = await call(options, 'relay_workspace', { action: 'write', path: 'actual.txt', text: 'Revised fixture result.' });
    assert.equal(actual.success, true, actual.contentItems[0].text);
    const reviewed = await task(options, { action: 'read' });
    assert.equal(reviewed.revision, correctedRevision); assert.equal(reviewed.steps.find(step => step.id === 'build').note, 'Write the revised text.');
    assert.equal(reviewed.steps.find(step => step.id === 'build').status, 'pending', 'A tool result cannot fabricate explicit task completion.');
    const completed = await task(options, { action: 'step', expectedRevision: reviewed.revision, stepId: 'build', status: 'done', evidence: 'The actual written file contains the revised fixture result.' });
    await finishFixturePlan(options, { state: completed, summary: 'The human correction and written result agree; no requested action remains.' });
    return { output: 'Written and checked the revised fixture result.' };
  });
  const result = await f.run(); assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(path.join(f.cwd, 'presence.txt'), 'utf8'), 'Presence is advisory.');
  assert.equal(await readFile(path.join(f.cwd, 'actual.txt'), 'utf8'), 'Revised fixture result.');
  assert.ok(result.taskState.revision > correctedRevision);
  assert.equal(result.nodes.agent.planning.status, 'off');
  assert.deepEqual(f.tasks.awareness.snapshot(await f.tasks.get(result.taskId)).workers, [], 'Retirement does not create fictitious worker read receipts.');
});

test('a historical single-scope delegation is rejected before worker execution or saved-edit activity', async t => {
  let childCalls = 0;
  const f = await fixture(t, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      childCalls++; assert.fail('A serial assignment must not start a child provider turn.');
    }
    const receipt = await call(options, 'relay_delegate', { tasks: [{ id: 'inspector', stepId: 'inspect', prompt: 'Implement only the assigned inspection result.' }] });
    assert.equal(receipt.success, false);
    assert.deepEqual({ code: payload(receipt).code, gate: payload(receipt).gate, providerCalls: payload(receipt).providerCalls },
      { code: 'SUBAGENT_SINGLE_WORK_ITEM', gate: 'static_dag', providerCalls: 0 });
    return { output: 'The coordinator retains the serial inspection; no delegated effect was attempted.' };
  }, { delegates: true });
  const result = await f.run();
  assert.equal(result.status, 'completed', result.error); assert.equal(childCalls, 0);
  await assert.rejects(readFile(path.join(f.cwd, 'delegated.txt')), { code: 'ENOENT' });
  assert.ok(!result.events.some(event => event.data?.type === 'subagent' && event.data.status === 'running'));
});
