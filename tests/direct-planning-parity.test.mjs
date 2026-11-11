import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { createDirectPlanningBrowserTools } from '../lib/direct-planning-browser-tools.mjs';
import { createDirectPlanningExecutionTools } from '../lib/direct-planning-execution-tools.mjs';
import { planningModuleTemplate } from '../public/planning-browser-model.mjs';

const client = { id: 'parity-connector', kind: 'chatgpt', scopes: ['read', 'planning:write', 'commands:run'] };
const readTool = 'blackice_planning_graph_read', writeTool = 'blackice_planning_graph_write', executionTool = 'blackice_planning_module';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function wait(check) { for (let n = 0; n < 1000; n++) { const value = await check(); if (value) return value; await pause(); } throw Error('Fixture did not settle.'); }
function publicOutput() {
  const fields = planningModuleTemplate('frame').fields;
  return JSON.stringify({ values: Object.fromEntries(fields.map(field => [field.id, 'A supported public finding for ' + field.label])),
    grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:graph' })), openQuestions: [], challengeResponses: [] });
}
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planning-direct-parity-')), cwd = path.join(dataDir, 'workspace'); await mkdir(cwd);
  const store = await new PlanningBrowserStore({ dataDir }).init(), calls = [], events = [];
  const runtime = { runAgent: options => new Promise((resolve, reject) => {
    calls.push({ options, resolve, reject });
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Fixture cancelled'), { code: 'ABORT_ERR' })), { once: true });
  }) };
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => ({ maxSubagents: 2, subagentsEnabled: false }), onUpdated: event => events.push(event) });
  const api = await new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: [
    ...createDirectPlanningBrowserTools({ store, getExecutionSnapshot: () => runner.status(), onChange: event => events.push(event) }),
    ...createDirectPlanningExecutionTools({ store, runner, onChange: event => events.push(event) }),
  ] }).init();
  t.after(async () => { for (const call of calls) call.reject(Object.assign(new Error('Fixture cleanup'), { code: 'ABORT_ERR' })); await runner.close(); await api.close(); await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  let sequence = 0;
  const send = async (name, args, who = client) => {
    const admitted = await api.call(name, { requestId: 'parity-' + (++sequence), ...args }, who);
    const job = await wait(async () => { const value = await api.getJob(admitted.jobId, who, { limit: 50000 }); return value.settled ? value : null; });
    return { admitted, job, value: job.result ? JSON.parse(job.result.text.text) : null };
  };
  const write = args => send(writeTool, { graphRequestId: 'graph', ...args });
  const read = args => send(readTool, { graphRequestId: 'graph', ...args });
  const execute = args => send(executionTool, { graphRequestId: 'graph', nodeId: 'module', ...args });
  await write({ action: 'create_request', conversationId: 'conversation', title: 'Synthetic plan', objective: 'Compare the supplied evidence.', cwd });
  await write({ action: 'add_module', nodeId: 'module', kind: 'frame', title: 'Synthetic module' });
  return { store, runner, api, calls, events, send, write, read, execute };
}

test('completion checks, skipping and assignment round trip between local workspace and direct tools', async t => {
  const f = await fixture(t);
  let result = await f.write({ action: 'update_module', nodeId: 'module', expectedNodeRevision: 1, doneWhen: 'The alternatives and material uncertainty are stated.', skipReason: 'Optional comparison deferred.' });
  assert.equal(result.job.status, 'succeeded'); assert.equal(result.value.node.skipReason, 'Optional comparison deferred.');
  const blocked = await f.execute({ action: 'run', expectedNodeRevision: 2 }); assert.equal(blocked.job.error.code, 'PLANNING_MODULE_SKIPPED'); assert.equal(f.calls.length, 0);
  await f.store.updateNode('graph', 'module', { skipReason: '' }, { expectedNodeRevision: 2, actor: { type: 'human', id: 'local' } });
  result = await f.read({ action: 'get', nodeId: 'module' }); assert.equal(result.value.node.skipReason, undefined); assert.match(result.value.node.doneWhen, /alternatives/);
  const assigned = await f.write({ action: 'assign', nodeId: 'module', expectedNodeRevision: 3, ownerId: 'review-owner', scope: 'node', label: 'Bounded reviewer' });
  assert.equal(assigned.job.status, 'succeeded'); assert.equal(assigned.value.node.assignment.ownerId, 'review-owner'); assert.equal((await f.store.get('graph')).nodes[0].assignment.label, 'Bounded reviewer');
  assert.equal(f.calls.length, 0, 'Document writes never invoke a model.'); assert.equal((await f.store.get('graph')).attempts.length, 0);
});

test('program XML is editable bidirectionally with exact revision and durable idempotency', async t => {
  const f = await fixture(t), before = await f.read({ action: 'program', limit: 50000 });
  assert.equal(before.value.xml.nextOffset, null); assert.match(before.value.xml.text, /Synthetic module/);
  const xml = before.value.xml.text.replace('Synthetic module', 'Direct revised module');
  const args = { action: 'update_program', xml, expectedRequestRevision: before.value.request.revision, requestId: 'program-write' };
  const saved = await f.write(args); assert.equal(saved.job.status, 'succeeded', JSON.stringify(saved.job)); assert.equal((await f.store.get('graph')).nodes[0].title, 'Direct revised module');
  const replay = await f.write(args); assert.equal(replay.admitted.existing, true); assert.equal(replay.admitted.jobId, saved.admitted.jobId);
  const stale = await f.write({ ...args, requestId: 'stale-program' }); assert.equal(stale.job.status, 'failed');
  const local = await f.store.get('graph'); await f.store.updateNode('graph', 'module', { title: 'Local revised module' }, { expectedNodeRevision: local.nodes[0].revision, actor: 'user' });
  const after = await f.read({ action: 'program', limit: 50000 }); assert.match(after.value.xml.text, /Local revised module/);
  const first = await f.read({ action: 'program', limit: 40 }); const next = await f.read({ action: 'program', offset: first.value.xml.nextOffset, limit: 40 });
  assert.equal(first.value.xml.text + next.value.xml.text, after.value.xml.text.slice(0, 80));
  assert.equal(f.calls.length, 0);
});

test('explicit direct module admission, native outcome and graph readback form one lifecycle without replay', async t => {
  const f = await fixture(t), args = { action: 'run', expectedNodeRevision: 1, requestId: 'run-module' };
  const admitted = await f.execute(args); assert.equal(admitted.job.status, 'succeeded', JSON.stringify(admitted.job));
  await wait(() => f.calls.length === 1); assert.equal(admitted.value.executionRequested, true); assert.equal(admitted.value.externalActionExecuted, false);
  assert.equal(f.calls[0].options.responseOnly, true); assert.deepEqual(f.calls[0].options.dynamicTools, []);
  const live = await f.read({ action: 'get', nodeId: 'module' }); assert.equal(live.value.request.execution.state, 'running'); assert.equal(live.value.attempts.items[0].workerStatus, 'running');
  const replay = await f.execute(args); assert.equal(replay.admitted.jobId, admitted.admitted.jobId); assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ output: publicOutput(), threadId: 'actual-thread', turnId: 'actual-turn' }); await Promise.all(f.runner.activePromises());
  const settled = await f.read({ action: 'get', nodeId: 'module' }); assert.equal(settled.value.request.execution.state, 'idle'); assert.equal(settled.value.attempts.items[0].status, 'completed');
  assert.equal(settled.value.node.response.provenance.kind, 'runtime'); assert.equal(settled.value.node.response.verifiedAction, false);
  const history = await f.read({ action: 'response_history', nodeId: 'module', responseId: settled.value.node.response.id }); assert.match(history.value.response.values.objective, /supported public finding/);
  const receipt = await f.read({ action: 'attempts', nodeId: 'module' }); assert.equal(receipt.value.attempts.items[0].id, admitted.value.admittedAttempt.id);
  assert.equal(receipt.value.attempts.items[0].output, undefined); assert.equal(receipt.value.attempts.items[0].prompt, undefined);
});

test('exact cancellation preserves attempts and cannot cancel another module or settled work', async t => {
  const f = await fixture(t), started = await f.execute({ action: 'run', expectedNodeRevision: 1 }); await wait(() => f.calls.length === 1);
  const wrong = await f.execute({ action: 'cancel', attemptId: 'unrelated' }); assert.equal(wrong.job.error.code, 'PLANNING_ATTEMPT_NOT_FOUND');
  const cancelled = await f.execute({ action: 'cancel', attemptId: started.value.admittedAttempt.id, reason: 'Stop this bounded test.' });
  assert.equal(cancelled.job.status, 'succeeded'); assert.equal((await f.store.get('graph')).attempts[0].status, 'cancelled'); assert.equal(f.calls.length, 1);
  const again = await f.execute({ action: 'cancel', attemptId: started.value.admittedAttempt.id }); assert.equal(again.job.error.code, 'PLANNING_BROWSER_ATTEMPT_SETTLED');
});

test('execution scope and stale revision are enforced before provider admission', async t => {
  const f = await fixture(t), writer = { ...client, scopes: ['read', 'planning:write'] };
  assert.ok(!f.api.tools(writer).some(tool => tool.name === executionTool));
  await assert.rejects(f.send(executionTool, { graphRequestId: 'graph', nodeId: 'module', action: 'run', expectedNodeRevision: 1 }, writer), { code: 'DIRECT_SCOPE_REQUIRED' });
  await f.write({ action: 'update_module', nodeId: 'module', expectedNodeRevision: 1, title: 'Newer module' });
  const stale = await f.execute({ action: 'run', expectedNodeRevision: 1 }); assert.equal(stale.job.status, 'failed'); assert.equal(stale.job.error.code, 'PLANNING_NODE_CONFLICT'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.execute({ action: 'run', expectedNodeRevision: 2, automatic: true }), { code: 'DIRECT_REQUEST_INVALID' });
});

test('orphaned running attempt stays unknown and metadata pages do not expose worker payloads', async () => {
  const request = { id: 'saved', conversationId: 'conversation', title: 'Saved', objective: 'Check status', revision: 1, nodes: [{ id: 'module', kind: 'frame', revision: 1 }], edges: [], sources: [], responses: [], attempts: Array.from({ length: 3 }, (_, index) => ({ id: 'attempt-' + index, nodeId: 'module', status: 'running', repairOf: 'original-attempt', repairIndex: 1, prompt: 'private worker payload', output: 'raw rejected output' })) };
  const store = Object.fromEntries(['list', 'create', 'addNode', 'updateNode', 'link', 'addSource'].map(name => [name, () => { throw Error('Unexpected mutation.'); }])); store.get = async () => request;
  const tool = createDirectPlanningBrowserTools({ store, getExecutionSnapshot: () => ({ attempts: [] }) })[0];
  const value = JSON.parse((await tool.execute({ action: 'get', graphRequestId: 'saved', nodeId: 'module', attemptOffset: 1, limit: 1 })).contentItems[0].text);
  assert.equal(value.request.execution.state, 'unknown'); assert.equal(value.attempts.items[0].id, 'attempt-1'); assert.equal(value.attempts.nextOffset, 2);
  assert.equal(value.attempts.items[0].workerStatus, 'unknown'); assert.equal(value.attempts.items[0].repairOf, 'original-attempt'); assert.equal(value.attempts.items[0].repairIndex, 1); assert.equal(value.attempts.items[0].prompt, undefined); assert.equal(value.attempts.items[0].output, undefined);
});
