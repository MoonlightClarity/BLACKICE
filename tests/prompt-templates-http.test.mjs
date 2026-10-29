import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const outline = (title = 'Saved HTTP outline') => ({ title, description: 'HTTP prompt fixture', sections: [{ id: 'goal', title: 'Goal', content: '{{task}}', level: 0 }, { id: 'checks', title: 'Checks', content: 'Check the actual output.', level: 0 }] });
const graph = { id: 'prompt-flow', name: 'Prompt fixture', nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Worker', prompt: 'Complete the user task.', model: 'prompt-fixture-model' }, { id: 'output', type: 'output', name: 'Result' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } };
const until = async (check, label) => { const deadline = Date.now() + 7000; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(`${label} did not settle`); };
async function fixture(t, execute, prepare) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-prompt-http-')), calls = [];
  if (prepare) await prepare(directory);
  class Runtime extends EventEmitter { status() { return { connected: true, authenticated: true, models: [{ model: 'prompt-fixture-model' }], defaultModel: 'prompt-fixture-model' }; } async start() { return this.status(); } async close() {} async runAgent(options) { calls.push(options); if (execute) return execute(options, calls.length); return { output: 'Prompt fixture finished.', threadId: `prompt-thread-${calls.length}` }; } }
  class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
  const app = await createHarnessServer({ port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), runtime: new Runtime(), desktop: new Desktop() }); await app.learning.updateSettings({ mode: 'manual' });
  t.after(async () => { await app.close(); assert.match(path.basename(directory), /^relay-prompt-http-/); await rm(directory, { recursive: true, force: true }); });
  const base = await app.listen(), home = await fetch(base), cookie = home.headers.get('set-cookie').split(';')[0];
  const request = async (url, { method = 'GET', body, authenticated = true, headers = {} } = {}) => { const response = await fetch(base + url, { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const type = response.headers.get('content-type'); return { status: response.status, data: type?.includes('application/json') ? await response.json() : await response.text() }; };
  const post = (url, body, options = {}) => request(url, { method: 'POST', body, ...options });
  const settled = id => until(() => { const run = app.engine.getRun(id); return run.settled && run; }, 'prompt-backed run');
  return { app, request, post, calls, settled, directory };
}

test('prompt HTTP endpoints authenticate requests, validate boundaries, and expose metadata without private bodies', async t => {
  const { app, request, post, calls } = await fixture(t);
  assert.equal((await request('/api/prompts', { authenticated: false })).status, 401); assert.equal((await post('/api/prompts/save', { template: outline() }, { authenticated: false })).status, 401);
  assert.equal((await request('/api/prompts', { headers: { Origin: 'https://other.example' } })).status, 403);
  const list = await request('/api/prompts'); assert.equal(list.status, 200); assert.equal(list.data.templates.length, 6); assert.ok(list.data.templates[0].fields.some(field => field.key === 'task')); assert.equal(Object.hasOwn(list.data.templates[0], 'sections'), false);
  for (const value of [null, [], { template: outline(), unexpected: true }]) assert.equal((await post('/api/prompts/save', value)).status, 400);
  assert.equal((await post('/api/prompts/render', { id: 'builtin_task', values: { task: 9 } })).status, 400); assert.equal((await post('/api/prompts/render', null)).status, 400);
  assert.equal((await request('/api/prompts?includeDeleted=maybe')).status, 400);
  const status = (await request('/api/status')).data.prompts; assert.deepEqual(status, { healthy: true, error: null, recovered: false, recoveryRequired: false, count: 0, deleted: 0, builtins: 6 }); assert.equal(calls.length, 0, 'browsing and rendering templates never starts an agent');
  for (const file of ['/prompt-template-model.mjs', '/task-title.mjs']) assert.equal((await request(file)).status, 200);
  assert.equal(app.engine.prompts, app.prompts);
});

test('prompt HTTP save delete Undo history and portable import preserve revision receipts', async t => {
  const { request, post } = await fixture(t), saved = await post('/api/prompts/save', { template: outline() }); assert.equal(saved.status, 200); const first = saved.data.template;
  assert.equal(first.revision, 1); assert.equal((await request(`/api/prompts/${first.id}`)).data.template.title, first.title);
  assert.equal((await post('/api/prompts/save', { template: { ...first, title: 'Stale edit' } })).status, 400);
  const edited = await post('/api/prompts/save', { template: { ...first, title: 'Current edit' }, expectedRevision: 1 }); assert.equal(edited.data.template.revision, 2);
  assert.equal((await post(`/api/prompts/${first.id}/delete`, { expectedRevision: 1 })).status, 409);
  const removed = await post(`/api/prompts/${first.id}/delete`, { expectedRevision: 2 }); assert.equal(removed.data.template.deleted, true);
  assert.equal((await request(`/api/prompts/${first.id}`)).status, 404);
  const restored = await post(`/api/prompts/${first.id}/restore`, { expectedRevision: removed.data.template.revision }); assert.equal(restored.data.template.revision, 4); assert.equal(restored.data.template.title, 'Current edit');
  const history = await request(`/api/prompts/${first.id}/history`); assert.deepEqual(history.data.history.map(item => item.action), ['restore', 'delete', 'update', 'create']);
  const prior = await post(`/api/prompts/${first.id}/restore`, { expectedRevision: 4, revision: 1 }); assert.equal(prior.data.template.title, first.title);
  const portable = (await request(`/api/prompts/${first.id}/export`)).data.document, imported = await post('/api/prompts/import', { document: portable }); assert.equal(imported.status, 201); assert.notEqual(imported.data.template.id, first.id);
  assert.equal((await post('/api/prompts/import', { document: { ...portable, command: 'never execute' } })).status, 400);
  assert.equal((await post('/api/prompts/save', { template: { ...outline(), id: 'builtin_task' }, expectedRevision: 1 })).status, 400);
});

test('prompt HTTP disk failure leaves committed state intact and successful recovery clears status', async t => {
  const { app, post, request } = await fixture(t); const destination = path.join(app.engine.dataDir, 'prompt-templates.json'); await mkdir(destination);
  const failed = await post('/api/prompts/save', { template: outline() }); assert.equal(failed.status, 500); assert.equal(app.prompts.status().count, 0); assert.equal((await request('/api/status')).data.prompts.healthy, false);
  await rmdir(destination); const recovered = await post('/api/prompts/save', { template: outline() }); assert.equal(recovered.status, 200); assert.equal(app.prompts.status().healthy, true); assert.equal(JSON.parse(await readFile(destination, 'utf8')).entries.length, 1);
});

test('corrupt optional prompt storage cannot prevent ordinary chat or a clean server shutdown', async t => {
  const { app, post, request, settled } = await fixture(t, undefined, async directory => { await mkdir(path.join(directory, 'data')); await writeFile(path.join(directory, 'data', 'prompt-templates.json'), '{bad-primary'); await writeFile(path.join(directory, 'data', 'prompt-templates.json.bak'), '{bad-backup'); });
  const catalog = await request('/api/prompts'); assert.equal(catalog.status, 200); assert.equal(catalog.data.templates.length, 6); assert.equal(catalog.data.status.healthy, false); assert.equal(catalog.data.status.recoveryRequired, true);
  assert.equal((await post('/api/prompts/save', { template: outline() })).status, 503); const rendered = await post('/api/prompts/render', { id: 'builtin_task', values: { task: 'An ordinary message still works' } }); assert.equal(rendered.status, 200);
  const start = await post('/api/runs', { workflow: graph, input: rendered.data.text }); assert.equal(start.status, 201); assert.equal((await settled(start.data.id)).status, 'completed');
  assert.equal(await readFile(app.prompts.file, 'utf8'), '{bad-primary'); assert.equal(await readFile(`${app.prompts.file}.bak`, 'utf8'), '{bad-backup'); await app.close();
});

test('profile maintenance drains admitted prompt writes and blocks new prompt mutations', async t => {
  const { app, post } = await fixture(t); let entered = false, release; const gate = new Promise(resolve => { release = resolve; }), original = app.prompts.writeSnapshot.bind(app.prompts);
  app.prompts.writeSnapshot = async (...args) => { entered = true; await gate; return original(...args); };
  const admitted = app.prompts.save(outline('Admitted before maintenance')); await until(() => entered, 'prompt write reaches durable boundary'); let finished = false;
  const maintenance = app.beginMaintenance().then(value => { finished = true; return value; });
  await until(() => app.engine.maintenanceRequested, 'maintenance admission latch'); assert.equal(finished, false); assert.equal((await post('/api/prompts/save', { template: outline('Too late') })).status, 503);
  release(); const committed = await admitted; await maintenance; assert.equal(app.prompts.get(committed.id).title, 'Admitted before maintenance'); app.endMaintenance();
});

test('rendered prompt text stays frozen through library edits, Retry, queue dispatch and conversation export', async t => {
  const { app, post, calls, settled } = await fixture(t, async (options, index) => { if (index === 1) throw new Error('Fixture failure before retry'); return { output: 'Completed the exact accepted task.', threadId: `frozen-${index}` }; });
  const saved = (await post('/api/prompts/save', { template: outline() })).data.template;
  const rendered = (await post('/api/prompts/render', { id: saved.id, values: { task: 'Build a small chess game with SVG pieces' } })).data;
  const first = (await post('/api/runs', { workflow: graph, input: rendered.text, requestId: 'outline-same-send' })).data; assert.equal((await settled(first.id)).status, 'failed');
  await post('/api/prompts/save', { template: { ...saved, sections: [{ id: 'new', title: 'Changed library', content: 'Completely different task', level: 0 }] }, expectedRevision: 1 });
  const retry = app.engine.retryRun(first.id); assert.equal((await settled(retry.id)).status, 'completed'); assert.equal(calls[0].prompt.includes(rendered.text), true); assert.equal(calls[1].prompt.includes(rendered.text), true); assert.equal(calls[1].prompt.includes('Completely different task'), false);
  const repeated = await post('/api/runs', { workflow: graph, input: rendered.text, requestId: 'outline-same-send' }); assert.equal(repeated.data.id, first.id); assert.equal(calls.length, 2);
  const queued = await app.inbox.add({ input: rendered.text, cwd: app.engine.defaultCwd, workflow: graph }); const dispatched = await app.inbox.runNow(queued.id); const runId = dispatched.runId || app.inbox.get(queued.id).runId; const queuedRun = await settled(runId); assert.equal(queuedRun.status, 'completed', queuedRun.error); assert.equal(queuedRun.input, rendered.text); assert.equal(calls[2].prompt.includes(rendered.text), true);
  const exported = await app.conversations.export(first.id, { format: 'json', attachments: app.attachments }); const transcript = JSON.parse(exported.body); assert.ok(transcript.turns.some(turn => turn.messages.some(message => message.role === 'user' && message.text === rendered.text)));
});

test('real engine attaches relay_prompts while older native catalogs keep their original tools', async t => {
  const seen = [], { app, settled } = await fixture(t, async (options, index) => {
    const names = options.dynamicTools.map(tool => tool.name); seen.push(names); options.onEvent({ type: 'thread', threadId: 'native-saved-prompt-thread', codexHistory: 'codex' });
    if (index === 1) { assert.ok(names.includes('relay_prompts')); assert.match(options.prompt, /OPTIONAL PROMPT OUTLINES/); const receipt = await options.onToolCall({ name: 'relay_prompts', arguments: { action: 'render', id: 'builtin_build', values: { task: 'A tool-rendered draft only' } } }); assert.equal(receipt.success, true); assert.match(receipt.contentItems[0].text, /A tool-rendered draft only/); }
    else { assert.equal(names.includes('relay_prompts'), false); assert.doesNotMatch(options.prompt, /OPTIONAL PROMPT OUTLINES/); assert.match(options.prompt, /retains its original tools/); }
    return { output: 'Native catalog checked.', threadId: 'native-saved-prompt-thread' };
  });
  await app.runtimeSettings.update({ codexHistory: 'codex' }); const first = app.engine.startRun({ workflow: graph, input: 'Check optional prompt tooling' }); const firstRun = await settled(first.id); assert.equal(firstRun.status, 'completed', firstRun.error);
  const internal = app.engine.runs.get(first.id); internal.nodes.agent.toolNames = internal.nodes.agent.toolNames.filter(name => name !== 'relay_prompts');
  const continued = app.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this older catalog' }); assert.equal((await settled(continued.id)).status, 'completed'); assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0].filter(name => name !== 'relay_prompts'), 'a successful continuation must not expand the saved native tool catalog');
});
