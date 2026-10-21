import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteAgentAPI, isRemoteAgentPath, MCP_VERSIONS } from '../lib/remote-agent-api.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';

const client = { id: 'outside-agent-one', kind: 'agent', label: 'Outside agent', scopes: ['read', 'planning:write', 'tasks:write'] };
const readClient = { ...client, scopes: ['read'] };
class Response extends EventEmitter {
  constructor() { super(); this.headers = {}; this.output = ''; this.writableLength = 0; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); }
  write(value) { this.output += value; return true; }
  end(value = '') { this.output += value; this.emit('close'); }
  json() { return JSON.parse(this.output); }
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-remote-api-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const state = await tasks.ensure({ taskId: 'task-one', runId: 'run-one', nodeId: 'runtime', cwd: directory, goal: 'Work together on the shared document.', defaultPlan: true });
  const runs = new Map([['run-one', { id: 'run-one', taskId: 'task-one', status: 'completed', settled: true, output: 'result-'.repeat(1000), events: [], createdAt: '2026-10-19T10:00:00Z', taskState: state, workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Task owner' }] }, nodes: { agent: { status: 'completed', output: 'worker output', threadId: 'thread-private' } } }]]);
  const events = [], requests = [], buckets = new Map([['task-one', 'active']]);
  const engine = {
    runs, listRuns: () => [...runs.values()].map(run => structuredClone(run)), getRun: id => { if (!runs.has(id)) throw Object.assign(Error('Run not found.'), { status: 404 }); return structuredClone(runs.get(id)); },
    executionStatus: () => ({ activeCount: 0, availableSlots: 4 }),
    adoptTaskState: (run, saved) => { if ((run.taskState?.revision || 0) >= saved.revision) return false; run.taskState = saved; return true; },
    notify: (...args) => events.push(args),
    startRun: value => { requests.push(value); const run = { id: `started-${requests.length}`, taskId: `started-${requests.length}`, workflow: value.workflow, nodes: {}, metadata: {}, status: 'queued', settled: false }; runs.set(run.id, run); return structuredClone(run); },
    cancelRun: id => { const run = runs.get(id); run.status = 'cancelled'; return structuredClone(run); },
  };
  const conversations = {
    list: () => [...buckets].map(([taskId, state]) => ({ id: taskId, taskId, title: 'A saved chat', state, updatedAt: '2026-10-19T09:00:00Z' })), status: () => ({ healthy: true }),
    get: async id => engine.getRun(id), family: async id => ({ state: buckets.get(runs.get(id).taskId), runs: [engine.getRun(id)] }),
  };
  const runtime = { status: () => ({ connected: true, authenticated: true, defaultModel: 'fixture', models: Array.from({ length: 500 }, (_, id) => ({ id: `model-${id}`, displayName: `Model ${id}`, available: id !== 4 })) }) };
  const api = new RemoteAgentAPI({ version: '2.29.0', tasks, engine, conversations, runtime, defaultCwd: directory, recoverClientRequest: async value => { requests.push({ recovery: value.requestId }); }, onEvent: event => events.push(event) });
  t.after(async () => { api.close(); await tasks.close(); assert.match(path.basename(directory), /^blackice-remote-api-/); await rm(directory, { recursive: true, force: true }); });
  return { api, tasks, engine, conversations, state, events, requests, buckets, directory };
}
async function http(api, url, { method = 'GET', payload, raw, headers = {}, identity = client } = {}) {
  const req = Readable.from(raw !== undefined || payload !== undefined ? [Buffer.from(raw ?? JSON.stringify(payload))] : []);
  Object.assign(req, { url, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
  const res = new Response(); await api.handle(req, res, identity); return res;
}
const modern = (method, params = {}, version = '2026-07-28') => ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'Untrusted client label', version: '1' } } } });
const modernHeaders = (method, name) => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });

test('machine paths are isolated from legacy APIs and lookalike prefixes', () => {
  for (const pathname of ['/mcp', '/api/agent', '/api/agent/tasks', '/api/agent/events']) assert.equal(isRemoteAgentPath(pathname), true);
  for (const pathname of ['/mcp-extra', '/api/agents', '/api/runs', '/api/remote-access']) assert.equal(isRemoteAgentPath(pathname), false);
});

test('tool catalog and execution independently enforce the verified scopes', async t => {
  const { api, requests } = await fixture(t);
  assert.ok(api.tools(readClient).every(tool => tool.annotations.readOnlyHint));
  assert.ok(api.tools(client).some(tool => tool.name === 'blackice_start_task'));
  for (const name of ['blackice_start_task', 'blackice_edit_plan', 'blackice_cancel_task']) await assert.rejects(api.call(name, {}, readClient), { status: 403, code: 'REMOTE_SCOPE_REQUIRED' });
  await assert.rejects(api.call('blackice_status', {}, null), { status: 401 }); assert.deepEqual(requests, []);
});

test('outside catalog reads default to active and share exact names and group filters with Planning', async t => {
  const { api, buckets } = await fixture(t);
  api.planningOrganization = { get: async () => ({ revision: 3, groups: [{ id: 'research', name: 'Research' }], plans: [{ taskId: 'task-one', name: 'A shared custom name', groupId: 'research' }], projects: [], updatedAt: null }) };
  const current = await api.call('blackice_list_tasks', { query: 'custom', taskId: 'task-one', groupId: 'research' }, readClient);
  assert.equal(current.plans.length, 1); assert.equal(current.plans[0].title, 'A shared custom name'); assert.equal(current.organization.revision, 3);
  assert.equal((await api.call('blackice_list_tasks', { groupId: 'ungrouped' }, readClient)).total, 0);
  assert.equal((await api.call('blackice_list_tasks', { groupId: 'all' }, readClient)).total, 1);
  buckets.set('task-one', 'archived'); assert.equal((await api.call('blackice_list_tasks', {}, readClient)).total, 0);
  assert.equal((await api.call('blackice_list_tasks', { state: 'archived' }, readClient)).plans[0].groupName, 'Research');
  assert.equal((await api.call('blackice_list_tasks', { state: 'all', taskId: 'task-one' }, readClient)).total, 1);
});

test('an outside agent edits the same durable plan with verified provenance and CAS', async t => {
  const { api, tasks, state, engine, events } = await fixture(t);
  const args = { taskId: 'task-one', expectedRevision: state.revision, operations: [
    { type: 'metadata', patch: { layout: 'parallel' } },
    { type: 'add', step: { id: 'implementation', title: 'Implement requested changes', doneWhen: 'The changed behavior is checked.' } },
    { type: 'add', step: { id: 'docs', title: 'Document the connection', doneWhen: 'A new client can follow the instructions.' } },
  ] };
  const saved = await api.call('blackice_edit_plan', args, client);
  assert.equal(saved.revision, state.revision + 1); assert.deepEqual(saved.provenance.actor, { type: 'external-agent', id: client.id, name: client.label });
  assert.deepEqual((await tasks.get('task-one')).steps.map(step => step.id), ['implementation', 'docs']);
  assert.equal(engine.runs.get('run-one').status, 'completed'); assert.equal(engine.runs.get('run-one').taskState.revision, saved.revision);
  assert.ok(events.some(event => event.type === 'planning.updated'));
  await assert.rejects(api.call('blackice_edit_plan', args, client), error => error.status === 409 && error.currentRevision === saved.revision);
  assert.equal((await tasks.get('task-one')).revision, saved.revision);
});

test('outside clients cannot forge identity, execution state or local filesystem arguments', async t => {
  const { api, state, requests } = await fixture(t);
  await assert.rejects(api.call('blackice_edit_plan', { taskId: 'task-one', expectedRevision: state.revision, operations: [{ type: 'metadata', patch: { goal: 'x' } }], actor: { type: 'human-client', id: 'owner' } }, client), { status: 400 });
  for (const extras of [{ cwd: 'C:\\Windows' }, { metadata: { inboxId: 'forged' } }, { workflow: {} }, { scopes: ['read'] }, { status: 'completed' }]) await assert.rejects(api.call('blackice_start_task', { task: 'A task', requestId: 'one', ...extras }, client), { status: 400 });
  assert.deepEqual(requests, []);
});

test('outside plan reads expose live editing presence without acknowledging another worker', async t => {
  const { api, tasks, state } = await fixture(t);
  tasks.awareness.setPresence(state, { editorId: 'editor-one', stepId: null }, { type: 'human-client', id: 'paired-person', name: 'Paired browser' });
  const workerId = tasks.awareness.register(state, { runId: 'run-live', nodeId: 'native-worker', label: 'Native worker' });
  for (const identity of [readClient, client]) {
    const read = await api.call('blackice_get_task', { taskId: 'task-one' }, identity);
    assert.equal(read.revision, state.revision); assert.equal(read.planningAwareness.revision, read.revision);
    assert.equal(read.planningAwareness.presence[0].label, 'Paired browser');
    assert.equal(read.planningAwareness.workers[0].lastReadRevision, null);
    const response = await http(api, '/api/agent/tasks/task-one', { identity }); assert.equal(response.statusCode, 200);
    assert.equal(response.json().planningAwareness.presence[0].editorId, 'editor-one');
    for (const extras of [{ lastReadRevision: state.revision }, { workerId }, { presence: { editorId: 'spoof', stepId: null } }]) await assert.rejects(api.call('blackice_get_task', { taskId: 'task-one', ...extras }, identity), { status: 400 });
    const attempted = await http(api, '/api/agent/tasks/task-one/plan/presence', { method: 'POST', payload: { editorId: 'spoof', stepId: null }, identity }); assert.equal(attempted.statusCode, 404);
  }
  assert.equal(tasks.awareness.workers.size, 1); assert.equal(tasks.awareness.workers.get(workerId).lastReadRevision, null);
  assert.deepEqual(tasks.awareness.snapshot(state).presence.map(item => item.editorId), ['editor-one']);
});

test('task submission namespaces retry IDs by credential and pins its trusted workspace', async t => {
  const { api, requests, engine, directory } = await fixture(t);
  const args = { task: 'Complete the authorized task.', requestId: 'client-request-one', planningMode: 'on' };
  const first = await api.call('blackice_start_task', args, client);
  await api.call('blackice_start_task', args, client);
  await api.call('blackice_start_task', args, { ...client, id: 'outside-agent-two' });
  const submitted = requests.filter(value => value.workflow);
  assert.equal(submitted[0].requestId, submitted[1].requestId); assert.notEqual(submitted[0].requestId, submitted[2].requestId);
  assert.equal(submitted[0].workflow.id, submitted[1].workflow.id); assert.equal(submitted[0].input.cwd, directory);
  assert.equal(engine.runs.get(first.runId).metadata.remoteClient.id, client.id);
  assert.equal(submitted[0].workflow.nodes.find(node => node.type === 'agent').desktop, false);
});

test('machine reads paginate large models and outputs without exposing runtime internals', async t => {
  const { api } = await fixture(t);
  const models = await api.call('blackice_models', { limit: 7 }, readClient); assert.equal(models.models.length, 7); assert.equal(models.total, 500); assert.equal(models.nextOffset, 7);
  const first = await api.call('blackice_get_run', { runId: 'run-one', limit: 20 }, readClient); assert.equal(first.output.text.length, 20); assert.equal(first.output.nextOffset, 20); assert.equal(first.workflow, undefined); assert.equal(first.events, undefined); assert.equal(first.nodes[0].threadId, undefined);
  const next = await api.call('blackice_read_output', { runId: 'run-one', nodeId: 'agent', offset: 7 }, readClient); assert.equal(next.text, 'output'); assert.equal(next.nextOffset, null);
  await assert.rejects(api.call('blackice_get_run', { runId: 'run-one', limit: 50001 }, client), { status: 400 });
});

test('Trash and unknown history cannot be read or edited through an agent handle', async t => {
  const { api, buckets } = await fixture(t);
  for (const bucket of ['deleted', 'unknown']) {
    buckets.set('task-one', bucket);
    await assert.rejects(api.call('blackice_get_task', { taskId: 'task-one' }, client), { status: 404 });
    await assert.rejects(api.call('blackice_get_run', { runId: 'run-one' }, client), { status: 404 });
  }
});

test('legacy MCP initializes and returns scoped tools over stateless HTTP', async t => {
  const { api } = await fixture(t);
  const start = await http(api, '/mcp', { method: 'POST', payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Fixture', version: '1' } } } });
  assert.equal(start.json().result.protocolVersion, '2025-06-18'); assert.equal(start.headers['mcp-session-id'], undefined);
  const notice = await http(api, '/mcp', { method: 'POST', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } }); assert.equal(notice.statusCode, 202); assert.equal(notice.output, '');
  const list = await http(api, '/mcp', { method: 'POST', payload: { jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, headers: { 'mcp-protocol-version': '2025-06-18' }, identity: readClient });
  assert.equal(list.statusCode, 200); assert.equal(list.json().id, 'tools'); assert.ok(list.json().result.tools.every(tool => tool.annotations.readOnlyHint));
  assert.equal((await http(api, '/mcp')).statusCode, 405);
});

test('current MCP discovery and tool calls validate metadata and mirrored HTTP headers', async t => {
  const { api } = await fixture(t);
  const discovery = await http(api, '/mcp', { method: 'POST', payload: modern('server/discover'), headers: modernHeaders('server/discover') });
  assert.deepEqual(discovery.json().result.supportedVersions, MCP_VERSIONS); assert.equal(discovery.json().result.resultType, 'complete');
  const payload = modern('tools/call', { name: 'blackice_status', arguments: {} });
  const response = await http(api, '/mcp', { method: 'POST', payload, headers: modernHeaders('tools/call', 'blackice_status') });
  assert.equal(response.json().result.structuredContent.client.name, client.label, 'untrusted MCP clientInfo is not an authentication identity');
  for (const headers of [modernHeaders('tools/list', 'blackice_status'), modernHeaders('tools/call', 'blackice_cancel_task'), { 'mcp-protocol-version': '2026-07-28' }]) {
    const mismatch = await http(api, '/mcp', { method: 'POST', payload, headers }); assert.equal(mismatch.statusCode, 400); assert.equal(mismatch.json().error.code, -32020);
  }
  const encoded = `=?base64?${Buffer.from('blackice_status').toString('base64')}?=`;
  assert.equal((await http(api, '/mcp', { method: 'POST', payload, headers: modernHeaders('tools/call', encoded) })).json().result.isError, false);
});

test('MCP errors distinguish malformed protocol, unsupported versions and forbidden tools', async t => {
  const { api } = await fixture(t);
  const version = await http(api, '/mcp', { method: 'POST', payload: modern('tools/list', {}, '2099-01-01'), headers: { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' } });
  assert.equal(version.json().error.code, -32022); assert.deepEqual(version.json().error.data.supported, MCP_VERSIONS);
  const invalid = await http(api, '/mcp', { method: 'POST', raw: '{' }); assert.equal(invalid.json().error.code, -32700);
  const batch = await http(api, '/mcp', { method: 'POST', payload: [modern('tools/list')] }); assert.equal(batch.json().error.code, -32600);
  const denied = await http(api, '/mcp', { method: 'POST', payload: modern('tools/call', { name: 'blackice_cancel_task', arguments: { runId: 'run-one' } }), headers: modernHeaders('tools/call', 'blackice_cancel_task'), identity: readClient });
  assert.equal(denied.statusCode, 403); assert.equal(denied.json().error.data.requiredScope, 'tasks:write');
});

test('REST validates routing and preserves the actionable revision conflict', async t => {
  const { api, state } = await fixture(t);
  const body = { expectedRevision: state.revision, operations: [{ type: 'metadata', patch: { goal: 'The human and agent share this goal.' } }, { type: 'add', step: { id: 'work', title: 'Do the work', doneWhen: 'The result is verified.' } }] };
  const saved = await http(api, '/api/agent/tasks/task-one/plan', { method: 'POST', payload: body }); assert.equal(saved.statusCode, 200);
  const conflict = await http(api, '/api/agent/tasks/task-one/plan', { method: 'POST', payload: body }); assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().currentRevision, saved.json().revision);
  for (const url of ['/api/agent/tasks?limit=0', '/api/agent/tasks?query=a&query=b', '/api/agent/runs/run-one?limit=1.5', '/api/agent/status?credentials=1']) assert.equal((await http(api, url)).statusCode, 400);
  assert.equal((await http(api, '/api/agent/runs/run-one/cancel', { method: 'POST', payload: [] })).statusCode, 400);
  assert.equal((await http(api, '/api/agent/runs/run-one/cancel', { method: 'POST', payload: { runId: 'other' } })).statusCode, 400);
});

test('live change feed emits compact state invalidations and closes without retaining listeners', async t => {
  const { api } = await fixture(t), response = new Response(); api.listen(response);
  api.publish({ type: 'agent.event', runId: 'run-one', data: { type: 'delta', delta: 'private model trace' } });
  api.publish({ type: 'planning.updated', data: { taskId: 'task-one', revision: 5, state: { goal: 'long goal' } }, at: 'now' });
  api.publish({ type: 'planning.awareness', data: { taskId: 'task-one', presence: [{ label: 'private label', text: 'forbidden draft' }], workers: [{ signature: 'private signature' }] }, at: 'now' });
  assert.match(response.output, /"revision":5/); assert.doesNotMatch(response.output, /private model trace|long goal/);
  assert.match(response.output, /"type":"planning.awareness","taskId":"task-one"/); assert.doesNotMatch(response.output, /private label|forbidden draft|private signature/);
  api.close(); assert.equal(api.streams.size, 0);
});
