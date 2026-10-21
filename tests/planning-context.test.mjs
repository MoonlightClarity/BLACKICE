import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore } from '../lib/task-state.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const action = (id, extra = {}) => ({ id, title: 'Check ' + id, kind: 'action', status: 'pending', doneWhen: 'The actual ' + id + ' result meets its requested criterion.', ...extra });
const edit = (store, state, operations) => store.editPlan(state.taskId, { operations }, { expectedRevision: state.revision, source: 'human', actor: { type: 'human-client', id: 'paired-context-reader', name: 'Paired human' } });
const waitFor = async check => {
  const until = Date.now() + 7000;
  while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('The actual planning context fixture did not settle.');
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-context-')), cwd = path.join(directory, 'workspace');
  await mkdir(cwd); const stores = [], engines = [];
  const openStore = async () => { const store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); return store; };
  const store = await openStore();
  t.after(async () => { for (const engine of engines) await engine.close(); for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, store, openStore, engines };
}

test('the saved continuity excerpt includes current human notes, results, criteria and other actionable plan details', async t => {
  const f = await fixture(t);
  let state = await f.store.ensure({ taskId: 'context-task', runId: 'first-run', cwd: f.cwd, goal: 'Finish the checked output.', defaultPlan: true });
  state = await edit(f.store, state, [
    { type: 'add', step: action('read', { status: 'done', evidence: 'Read the exact owned source and compared its checksum.', note: 'The source was already inspected.' }) },
    { type: 'add', step: action('deliver', { dependsOn: ['read'], note: 'Original wording before human correction.', result: 'Original requested output.' }) },
  ]);
  state = await edit(f.store, state, [{ type: 'update', stepId: 'deliver', patch: { note: 'Latest human correction: preserve the appendix and show the uncertainty.', result: 'A checked report retaining the appendix.', doneWhen: 'The report contains the appendix and its limitations.' } }]);
  const context = await f.store.getContext(state.taskId, { maxChars: 12000 });
  assert.ok(context.includes('revision ' + state.revision));
  for (const text of ['Latest human correction: preserve the appendix and show the uncertainty.', 'A checked report retaining the appendix.', 'The report contains the appendix and its limitations.', 'Read the exact owned source and compared its checksum.', 'The source was already inspected.']) assert.ok(context.includes(text), text);
  assert.doesNotMatch(context, /Original wording before human correction|Original requested output/);
  assert.deepEqual(await f.store.get(state.taskId), state, 'Reading context must not mutate the saved plan or provenance.');
  state = await edit(f.store, state, [{ type: 'update', stepId: 'deliver', patch: { note: null, result: null } }]);
  const cleared = await f.store.getContext(state.taskId, { maxChars: 12000 });
  assert.doesNotMatch(cleared, /Latest human correction|A checked report retaining the appendix/);
  assert.match(cleared, /The report contains the appendix and its limitations/);
});

test('long completed history cannot bury current human notes and truncation retains the bounded read contract', async t => {
  const f = await fixture(t);
  let state = await f.store.ensure({ taskId: 'long-context', runId: 'first-run', cwd: f.cwd, goal: 'Preserve the requested output and its constraints.', defaultPlan: true });
  const history = Array.from({ length: 36 }, (_, index) => action('history-' + index, { status: 'done', evidence: 'Observed the actual completed fixture result. '.repeat(8), note: 'Historical detail. '.repeat(8) }));
  state = await edit(f.store, state, history.map(step => ({ type: 'add', step })).concat([{ type: 'add', step: action('next', { note: 'CURRENT_HUMAN_NOTE: keep the appendix and explain its limits.', result: 'CURRENT_RESULT: a report retaining its appendix.' }) }]));
  for (const toolAvailable of [true, false]) {
    const context = await f.store.getContext(state.taskId, { maxChars: 1500, toolAvailable });
    assert.ok(context.length <= 1500); assert.match(context, /CURRENT_HUMAN_NOTE: keep the appendix and explain its limits/); assert.match(context, /CURRENT_RESULT: a report retaining its appendix/);
    assert.ok(context.indexOf('CURRENT_HUMAN_NOTE') < context.indexOf('Outline:'));
    assert.match(context, toolAvailable ? /shortened; use relay_task read/ : /shortened; full state remains saved/);
    if (!toolAvailable) assert.doesNotMatch(context, /Read relay_task before edits|use relay_task read/);
    const small = await f.store.getContext(state.taskId, { maxChars: 512, toolAvailable });
    assert.ok(small.length <= 512); assert.match(small, /Outcome:|Current milestone:/); assert.match(small, /shortened/);
  }
});

test('a restarted engine supplies the latest paired-human work note on the actual resumed turn with automatic planning off', async t => {
  const f = await fixture(t), calls = [], model = 'fixture-provider::context-model', threadId = 'provider_actual_context_fixture';
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: model, models: [{ id: model, supportsTools: true }] }; }
    async runAgent(options) {
      calls.push(options); options.onEvent({ type: 'thread', threadId, model });
      return { output: calls.length === 1 ? 'Original checked reply.' : 'Continued with the current human plan.', threadId };
    }
  }
  const openEngine = async tasks => { const engine = await new HarnessEngine({ runtime: new Runtime(), tasks, dataDir: f.directory, defaultCwd: f.cwd }).init(); f.engines.push(engine); return engine; };
  let engine = await openEngine(f.store);
  const workflow = createMissionWorkflow({ id: 'context-resume', task: 'Create the requested result.', cwd: f.cwd, model, planningMode: 'off' });
  const admitted = engine.startRun({ workflow, input: 'Create the requested result.' });
  const first = await waitFor(() => { const run = engine.getRun(admitted.id); return run.settled && run; });
  assert.equal(first.status, 'completed', first.error); assert.equal(calls.length, 1);
  let state = await f.store.get(first.taskId);
  state = await edit(f.store, state, [{ type: 'add', step: action('followup', { note: 'Old human note before restart.', result: 'The final checked report.' }) }]);
  await engine.close(); await f.store.close();
  const restored = await f.openStore(); engine = await openEngine(restored);
  state = await edit(restored, await restored.get(first.taskId), [{ type: 'update', stepId: 'followup', patch: { note: 'Latest paired human note after restart: keep the appendix and explain the caveat.', result: 'A final report retaining the appendix and caveat.', doneWhen: 'The appendix and caveat are present in the continued result.' } }]);
  const next = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the saved work.', planningMode: 'off' }, { threadModel: model });
  const finished = await waitFor(() => { const run = engine.getRun(next.id); return run.settled && run; });
  assert.equal(finished.status, 'completed', finished.error); assert.equal(calls.length, 2); assert.equal(calls[1].threadId, threadId);
  for (const text of ['Latest paired human note after restart: keep the appendix and explain the caveat.', 'A final report retaining the appendix and caveat.', 'The appendix and caveat are present in the continued result.', 'Continue with the saved work.']) assert.ok(calls[1].prompt.includes(text), text);
  assert.doesNotMatch(calls[1].prompt, /Old human note before restart/);
  assert.match(calls[1].developerInstructions, /planning is off/i);
  assert.equal((await restored.get(first.taskId)).revision, state.revision, 'The resumed response does not rewrite or finish the human-authored plan.');
});
