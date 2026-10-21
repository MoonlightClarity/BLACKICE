import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { editPlanningWorkspace } from '../lib/planning-workspace.mjs';

const client = { id: 'chatgpt-owned-client', label: 'Owned ChatGPT connection', scopes: ['read', 'planning:write'] };
const task = (id = 'step-one') => ({ id, title: `Saved task ${id}`, instructions: 'Authored instructions stay in the saved plan.', acceptanceCriteria: ['The actual result is checked.'], dependsOn: [], stepType: 'create', status: 'blocked', round: 1, cycle: 1, maxRepairs: 2, attempts: [], error: 'The original work was stopped.' });
const project = (id = 'swarm-one') => ({ id, name: `Saved swarm ${id}`, objective: 'Observe the weather forecast.', revision: 7, status: 'paused', priority: 'normal', owner: '', dueDate: '', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T11:00:00Z', tasks: [task()], context: 'Stored planning context', notes: 'Stored project notes' });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-chatgpt-planning-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  let saved = await tasks.ensure({ taskId: 'task-one', runId: 'run-one', cwd: directory, goal: 'Saved goal.', defaultPlan: true });
  saved = await tasks.editPlan('task-one', { operations: [{ type: 'add', step: { id: 'work', title: 'Existing work', doneWhen: 'The saved work is verified.' } }] }, { source: 'human', expectedRevision: saved.revision });
  const events = [], runs = new Map([['run-one', { id: 'run-one', taskId: 'task-one', status: 'cancelled', settled: true, taskState: saved, output: 'Real saved run output.', nodes: { implement: { output: 'Actual implementation output.' } } }]]);
  const engine = { runs, listRuns: () => [...runs.values()], adoptTaskState: (run, state) => { if (run.taskState.revision >= state.revision) return false; run.taskState = state; return true; }, notify: (...args) => events.push(args), startRun: () => { throw Error('A planning document API must never start a worker.'); } };
  const conversations = { list: () => [{ id: 'task-one', taskId: 'task-one', title: 'Saved conversation', state: 'active' }], status: () => ({ healthy: true }), get: async id => { if (!runs.has(id)) throw Error('Unknown run.'); return runs.get(id); } };
  const projects = [project()];
  const api = new ChatGPTPlanningAPI({ tasks, conversations, engine, projects: { snapshot: () => ({ projects: structuredClone(projects) }), get: id => { const value = projects.find(item => item.id === id); if (!value) throw Object.assign(Error('Missing project.'), { status: 404 }); return structuredClone(value); } }, onUpdated: event => events.push(event) });
  t.after(async () => { await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { api, tasks, directory, projects, events, engine, conversations, saved };
}

test('a ChatGPT document edit preserves a durable stopped-worker interruption and never resumes the run', async t => {
  const f = await fixture(t);
  const stopped = await f.tasks.interrupt('task-one', { runId: 'run-one', nodeId: 'implement', status: 'cancelled', reason: 'Stopped explicitly before external document editing.' });
  const args = { taskId: 'task-one', expectedRevision: stopped.revision, operations: [{ type: 'metadata', patch: { goal: 'Edited document goal.' } }, { type: 'update', stepId: 'work', patch: { title: 'Clarified existing work' } }] };
  const edited = await f.api.call('blackice_edit_plan', args, client);
  assert.equal(edited.revision, stopped.revision + 1); assert.equal(edited.goal, 'Edited document goal.');
  assert.deepEqual(edited.interruption, stopped.interruption); assert.deepEqual(edited.checkpoint, stopped.checkpoint);
  assert.equal(edited.provenance.source, 'external-agent'); assert.deepEqual(edited.provenance.actor, { type: 'external-agent', id: client.id, name: client.label });
  assert.equal(f.engine.runs.get('run-one').status, 'cancelled'); assert.equal(f.engine.runs.get('run-one').settled, true);
  assert.equal(f.engine.runs.get('run-one').taskState.revision, edited.revision);
  assert.ok(f.events.some(event => event.type === 'planning.updated' && event.data.source === 'external-agent'));
  const reader = await new TaskStateStore({ dataDir: f.directory }).init();
  try { assert.deepEqual((await reader.get('task-one')).interruption, stopped.interruption); } finally { await reader.close(); }
  await assert.rejects(f.api.call('blackice_edit_plan', args, client), error => error.code === 'TASK_STATE_CONFLICT' && error.currentRevision === edited.revision);
  assert.equal((await f.tasks.get('task-one')).revision, edited.revision);
});

test('the document-only source requires a verified external actor and cannot be supplied through tool arguments', async t => {
  const f = await fixture(t), edit = { expectedRevision: f.saved.revision, operations: [{ type: 'update', stepId: 'work', patch: { title: 'Unauthenticated provenance' } }] };
  for (const actor of [undefined, { type: 'human-client', id: 'person' }]) await assert.rejects(editPlanningWorkspace({ ...f.api, source: 'external-agent', actor }, 'task-one', edit), { code: 'PLANNING_REQUEST_INVALID' });
  for (const extra of [{ source: 'human' }, { actor: { type: 'human-client', id: 'person' } }, { runId: 'forged-resume' }]) await assert.rejects(f.api.call('blackice_edit_plan', { taskId: 'task-one', ...edit, ...extra }, client), { code: 'CHATGPT_ARGUMENTS_INVALID' });
  await assert.rejects(f.api.call('blackice_edit_plan', { taskId: 'task-one', ...edit }, { ...client, scopes: ['read'] }), { code: 'CHATGPT_SCOPE_REQUIRED' });
  assert.equal((await f.tasks.get('task-one')).revision, f.saved.revision);
});

test('Swarm search matches the saved objective, trims text, and preserves active/archive and group filtering', async t => {
  const f = await fixture(t); f.projects.push({ ...project('swarm-two'), objective: 'Forecast shipping demand.' });
  f.api.planningOrganization = { get: async () => ({ revision: 3, groups: [{ id: 'forecasting', name: 'Forecasting' }], plans: [], projects: [{ projectId: 'swarm-one', groupId: 'forecasting' }, { projectId: 'swarm-two', groupId: 'forecasting', archived: true }] }) };
  const active = await f.api.call('blackice_list_swarm_plans', { query: '  WEATHER  ', groupId: 'forecasting' }, client);
  assert.deepEqual(active.projects.map(item => item.id), ['swarm-one']); assert.equal(active.projects[0].objective, f.projects[0].objective);
  assert.equal(active.projects[0].taskCount, 1); assert.equal(active.projects[0].groupName, 'Forecasting');
  assert.equal((await f.api.call('blackice_list_swarm_plans', { query: 'shipping' }, client)).total, 0);
  assert.deepEqual((await f.api.call('blackice_list_swarm_plans', { query: 'shipping', state: 'archived' }, client)).projects.map(item => item.id), ['swarm-two']);
  assert.equal((await f.api.call('blackice_list_swarm_plans', { groupId: 'ungrouped' }, client)).total, 0);
  assert.equal((await f.api.call('blackice_list_swarm_plans', { query: 'forecast', state: 'all' }, client)).total, 2);
});

test('Swarm detail projects compact attempt metadata and reads real run output through the existing bounded result tool', async t => {
  const f = await fixture(t), hidden = 'PRIVATE_STORED_EXECUTION_REQUEST';
  const phase = { requestId: 'request-one', runId: 'run-one', status: 'cancelled', createdAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T10:02:00Z', request: { workflow: { nodes: [{ prompt: hidden.repeat(1000) }] }, input: hidden }, output: 'SAVED_PHASE_OUTPUT'.repeat(10000), outputTruncated: true, unknownFuturePayload: hidden };
  f.projects[0].tasks[0].attempts = Array.from({ length: 12 }, (_, index) => ({ number: index + 1, cycle: 1, round: 1, implementation: phase, verification: null, unexpected: hidden }));
  const value = await f.api.call('blackice_get_swarm_plan', { projectId: 'swarm-one' }, client), current = value.tasks[0];
  assert.deepEqual(current.attempts.map(item => item.number), [8, 9, 10, 11, 12]); assert.equal(current.totalAttempts, 12); assert.equal(current.attemptOffset, 7); assert.equal(current.previousAttemptOffset, 2); assert.equal(current.nextAttemptOffset, null);
  assert.deepEqual(current.acceptanceCriteria, f.projects[0].tasks[0].acceptanceCriteria);
  assert.equal(current.attempts[0].implementation.runId, 'run-one'); assert.equal(current.attempts[0].implementation.requestId, 'request-one');
  assert.equal(current.attempts[0].implementation.outputCharacters, phase.output.length); assert.equal(current.attempts[0].implementation.outputTruncated, true);
  for (const leaked of [hidden, 'SAVED_PHASE_OUTPUT', '"request":', '"workflow":', '"prompt":', '"output":', '"instructions":']) assert.ok(!JSON.stringify(value).includes(leaked), leaked);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 10000); assert.equal(value.runOutputTool, 'blackice_get_run_result');
  const first = await f.api.call('blackice_get_swarm_plan', { projectId: 'swarm-one', attemptOffset: 0, attemptLimit: 3 }, client);
  assert.deepEqual(first.tasks[0].attempts.map(item => item.number), [1, 2, 3]); assert.equal(first.tasks[0].nextAttemptOffset, 3); assert.equal(first.tasks[0].previousAttemptOffset, null);
  const output = await f.api.call('blackice_get_run_result', { runId: current.attempts[0].implementation.runId, offset: 5, limit: 5 }, client);
  assert.deepEqual(output.output, { text: 'saved', offset: 5, totalCharacters: 'Real saved run output.'.length, nextOffset: 10 }); assert.equal(output.status, 'cancelled');
});

test('large Swarm task pages stay bounded and expose exact continuation offsets without losing rows', async t => {
  const f = await fixture(t), criteria = Array.from({ length: 20 }, (_, index) => String(index) + '🧊'.repeat(490));
  f.projects[0].tasks = Array.from({ length: 100 }, (_, index) => ({ ...task('step-' + index), acceptanceCriteria: criteria }));
  const seen = []; let offset = 0;
  do {
    const page = await f.api.call('blackice_get_swarm_plan', { projectId: 'swarm-one', offset, limit: 100 }, client);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256000); assert.ok(page.tasks.length > 0 && page.tasks.length < 100);
    assert.equal(page.totalTasks, 100); assert.equal(page.offset, offset); seen.push(...page.tasks.map(item => item.id));
    assert.equal(page.nextOffset, seen.length < 100 ? seen.length : null); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(seen, f.projects[0].tasks.map(item => item.id));
  for (const args of [{ attemptLimit: 11 }, { attemptOffset: -1 }, { limit: 101 }, { includeOutputs: true }]) await assert.rejects(f.api.call('blackice_get_swarm_plan', { projectId: 'swarm-one', ...args }, client), { code: 'CHATGPT_ARGUMENTS_INVALID' });
});
