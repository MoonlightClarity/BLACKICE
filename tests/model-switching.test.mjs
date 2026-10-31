import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createHarnessServer } from '../server.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { ConversationArchive } from '../lib/conversations.mjs';
import { assistantMessages } from '../public/conversation-model.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => { const deadline = Date.now() + 7000; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Model switching did not settle.'); };
class Codex extends EventEmitter {
  calls = [];
  status() { return { connected: true, authenticated: true, defaultModel: 'codex-a', models: [{ id: 'codex-a' }, { id: 'codex-b' }] }; }
  async start() { return this.status(); }
  async runAgent(options) { this.calls.push(options); const model = options.model || 'codex-a', threadId = options.threadId || `codex-thread-${this.calls.length}`, output = `Actual fixture Codex reply from ${model}.`; options.onEvent?.({ type: 'thread', model, threadId, turnId: `codex-turn-${this.calls.length}` }); options.onEvent?.({ type: 'message', itemId: `codex-message-${this.calls.length}`, text: output, phase: 'final_answer' }); return { output, threadId }; }
  async close() {}
}
function respond(response, type, text) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = type === 'openai' ? [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } } }] : type === 'anthropic' ? [{ type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }, { type: 'message_stop' }] : [{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } }];
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`); response.end();
}
async function fixture(t, type = 'compatible', beforeResponse, { modelAContext = 64000, modelBContext = 32000 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-model-switch-')), requests = [], codex = new Codex(), engines = [], archives = [];
  const server = createServer(async (request, response) => { try { let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); const receipt = { url: request.url, body }; requests.push(receipt); if (await beforeResponse?.({ request: receipt, response, index: requests.length }) === false) return; respond(response, type, `Actual fixture reply ${requests.length} from ${body.model}.`); } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await new ProviderRuntime({ codex, dataDir: directory }).init(), baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (const id of ['primary', 'secondary']) await runtime.saveProvider({ id, type, baseUrl, apiKey: type === 'compatible' ? undefined : 'fixture-key', models: [{ id: 'model-a', contextWindowTokens: modelAContext, contextWindowSource: 'user-configured' }, { id: 'model-b', contextWindowTokens: modelBContext, contextWindowSource: 'user-configured' }] });
  t.after(async () => { for (const engine of engines) await engine.close(); for (const archive of archives) await archive.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.match(path.basename(directory), /^relay-model-switch-/); await rm(directory, { recursive: true, force: true }); });
  return { directory, requests, runtime, codex, engines, archives, async engine() { const engine = await new HarnessEngine({ runtime, dataDir: path.join(directory, 'engine'), defaultCwd: directory }).init(); engines.push(engine); return engine; } };
}

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: switching a saved thread's model changes the real HTTP request and preserves its transcript`, async t => {
  const { directory: cwd, requests, runtime } = await fixture(t, type), events = [];
  const first = await runtime.runAgent({ cwd, model: 'primary::model-a', prompt: 'ORIGINAL_USER_MESSAGE', dynamicTools: [], onEvent: event => events.push(event) });
  const second = await runtime.runAgent({ cwd, model: 'primary::model-b', threadId: first.threadId, prompt: 'FOLLOWUP_USER_MESSAGE', dynamicTools: [] });
  assert.equal(second.threadId, first.threadId); assert.equal(requests[0].body.model, 'model-a'); assert.equal(requests[1].body.model, 'model-b');
  const sent = JSON.stringify(requests[1].body.input || requests[1].body.messages); assert.match(sent, /ORIGINAL_USER_MESSAGE/); assert.match(sent, /Actual fixture reply 1 from model-a/); assert.match(sent, /FOLLOWUP_USER_MESSAGE/);
  const saved = await runtime.readThread(first.threadId); assert.equal(saved.model, 'model-b'); assert.match(JSON.stringify(saved.transcript), /Actual fixture reply 1 from model-a/); assert.match(JSON.stringify(saved.transcript), /Actual fixture reply 2 from model-b/); assert.equal(second.context.configuredModelWindowTokens, 32000); assert.equal(second.context.modelWindowTokens, null);
  const message = events.find(event => event.type === 'message'); assert.ok(message.itemId); assert.equal(events.find(event => event.type === 'delta').itemId, message.itemId); assert.equal(message.text, first.output); assert.deepEqual(assistantMessages({ events: events.map(data => ({ nodeId: 'agent', data })), nodes: {}, workflow: { nodes: [] } }).map(message => message.text), [first.output], 'stream deltas and their durable completed snapshot are one visible reply');
});

test('switching models discards a capacity learned from the old model and uses the new model capacity', async t => {
  const { runtime, directory: cwd, requests } = await fixture(t, 'compatible', ({ response, index }) => { if (index === 1) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'maximum context length is 128000 tokens' } })); return false; } });
  let threadId;
  await assert.rejects(runtime.runAgent({ cwd, model: 'primary::model-a', prompt: 'Keep this failed attempt in history.', onEvent: event => { threadId ||= event.threadId; } }), /128000/);
  assert.ok(threadId); assert.equal((await runtime.readThread(threadId)).reportedContextWindow, 128000);
  const result = await runtime.runAgent({ cwd, model: 'primary::model-b', threadId, prompt: 'Use the new model.' });
  assert.equal(requests.at(-1).body.model, 'model-b'); assert.equal(result.context.configuredModelWindowTokens, 32000); assert.equal(result.context.modelWindowTokens, null); assert.equal(result.context.effectiveWindowTokens, 32000); assert.match(JSON.stringify(requests.at(-1).body.messages), /Keep this failed attempt in history/);
});

test('engine model changes resume only within a provider and hand actual saved text to a new provider thread', async t => {
  const { engine: makeEngine, runtime, codex, requests } = await fixture(t), engine = await makeEngine(), history = [];
  let run = engine.startRun({ workflow: createMissionWorkflow({ id: 'switch-chat', task: 'ORIGINAL_TASK', model: 'codex-a', planningMode: 'off' }), input: 'ORIGINAL_TASK' }); await engine.executions.get(run.id); run = engine.getRun(run.id); history.push(run);
  const variants = ['codex-b', 'primary::model-a', 'primary::model-b', 'secondary::model-a', 'codex-a'];
  for (const [index, model] of variants.entries()) {
    const previous = run, before = structuredClone(engine.getRun(previous.id)), sameProvider = (previous.nodes.agent.resolvedModel || previous.workflow.nodes.find(node => node.id === 'agent').model).split('::')[0] === model.split('::')[0] || !model.includes('::') && !previous.nodes.agent.threadId.startsWith('provider_');
    const oldTranscript = previous.nodes.agent.threadId.startsWith('provider_') ? await readFile(runtime.threadFile(previous.nodes.agent.threadId), 'utf8') : null;
    run = engine.continueRun(previous.id, { nodeId: 'agent', message: `FOLLOWUP_${index}`, model }, { historyRuns: history }); await engine.executions.get(run.id); run = engine.getRun(run.id);
    assert.equal(run.status, 'completed', run.error); assert.equal(run.taskId, history[0].id); assert.equal(run.workflow.nodes.find(node => node.id === 'agent').model, model); assert.deepEqual(engine.getRun(previous.id), before);
    if (sameProvider) { assert.equal(run.nodes.agent.threadId, previous.nodes.agent.threadId); assert.equal(run.modelHandoff, undefined); }
    else { assert.notEqual(run.nodes.agent.threadId, previous.nodes.agent.threadId); assert.ok(run.modelHandoff); const sent = model.includes('::') ? JSON.stringify(requests.at(-1).body.messages) : codex.calls.at(-1).prompt; assert.match(sent, /ORIGINAL_TASK/); assert.ok(sent.includes(previous.nodes.agent.output), 'the new provider receives actual prior assistant text'); if (oldTranscript) assert.equal(await readFile(runtime.threadFile(previous.nodes.agent.threadId), 'utf8'), oldTranscript, 'a cross-provider handoff does not rewrite the old transcript'); }
    history.push(run);
  }
  assert.equal(codex.calls[1].model, 'codex-b'); assert.equal(requests[1].body.model, 'model-b');
});

test('accepted provider directions and intermediate assistant replies survive a cross-provider handoff', async t => {
  const hold = deferred(), { engine: makeEngine, requests, directory, archives } = await fixture(t, 'compatible', async ({ index }) => { if (index === 1) await hold.promise; }, { modelBContext: 262144 }), engine = await makeEngine(), archive = await new ConversationArchive({ dataDir: path.join(directory, 'engine'), engine }).init(); archives.push(archive);
  const first = engine.startRun({ workflow: createMissionWorkflow({ id: 'direction-chat', task: 'ORIGINAL_HANDOFF_TASK', model: 'primary::model-a', planningMode: 'off' }), input: 'ORIGINAL_HANDOFF_TASK' });
  try { await until(() => requests.length && engine.getRun(first.id).nodes.agent.turnId); const receipt = await engine.steerRun(first.id, { nodeId: 'agent', message: 'ACTUAL_ACCEPTED_USER_DIRECTION' }); assert.equal(receipt.accepted, true); } finally { hold.resolve(); }
  await engine.executions.get(first.id); const previous = engine.getRun(first.id); assert.equal(previous.status, 'completed'); assert.ok(previous.events.some(event => event.data?.type === 'steer' && event.data.text === 'ACTUAL_ACCEPTED_USER_DIRECTION')); assert.equal(requests.length, 2);
  await archive.chain; engine.runs.get(first.id).events = Array.from({ length: 2500 }, (_, index) => ({ nodeId: 'agent', data: { type: 'item', item: { type: 'commandExecution', id: `bounded-${index}` } } }));
  const family = await archive.family(first.id), visible = run => assistantMessages(run).map(message => message.text);
  assert.deepEqual(visible(family.runs[0]), ['ACTUAL_ACCEPTED_USER_DIRECTION', 'Actual fixture reply 1 from model-a.', 'Actual fixture reply 2 from model-a.']);
  const next = engine.continueRun(first.id, { nodeId: 'agent', message: 'Switch provider and retain the discussion.', model: 'secondary::model-b' }, { historyRuns: family.runs }); await engine.executions.get(next.id);
  const handoff = JSON.stringify(requests.at(-1).body.messages); assert.match(handoff, /USER DIRECTION: ACTUAL_ACCEPTED_USER_DIRECTION/); assert.match(handoff, /Actual fixture reply 1 from model-a/); assert.match(handoff, /Actual fixture reply 2 from model-a/); assert.notEqual(engine.getRun(next.id).nodes.agent.threadId, previous.nodes.agent.threadId);
  await archive.close(); const restored = await new ConversationArchive({ dataDir: path.join(directory, 'engine'), engine }).init(); archives.push(restored); assert.deepEqual(visible(await restored.get(first.id)), visible(family.runs[0]), 'actual HTTP replies and directions survive a fresh archive instance even when the execution ring has evicted them');
});

test('retrying a failed provider handoff retains actual history without resuming the old native thread', async t => {
  const { engine: makeEngine, requests, codex } = await fixture(t, 'compatible', ({ response, index }) => { if (index <= 2) { response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' }); response.end(JSON.stringify({ error: { message: 'Temporary fixture provider failure.' } })); return false; } }, { modelBContext: 262144 }), engine = await makeEngine();
  const initial = engine.startRun({ workflow: createMissionWorkflow({ id: 'retry-handoff-chat', task: 'ORIGINAL_RETRY_HANDOFF_TASK', model: 'codex-a', planningMode: 'off' }), input: 'ORIGINAL_RETRY_HANDOFF_TASK' }); await engine.executions.get(initial.id); const original = engine.getRun(initial.id);
  const continued = engine.continueRun(initial.id, { nodeId: 'agent', message: 'Continue this exact discussion on the other provider.', model: 'secondary::model-b' }, { historyRuns: [original] }); await engine.executions.get(continued.id); const failed = engine.getRun(continued.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Temporary fixture provider failure/); assert.ok(failed.modelHandoff); assert.equal(codex.calls.length, 1);
  const retried = engine.retryRun(failed.id); assert.deepEqual(retried.modelHandoff, failed.modelHandoff); assert.equal(retried.nodes.agent.resumeThreadId, undefined); await engine.executions.get(retried.id); const completed = engine.getRun(retried.id);
  assert.equal(completed.status, 'completed', completed.error); assert.deepEqual(completed.modelHandoff, failed.modelHandoff); assert.equal(requests.length, 3); assert.deepEqual(requests[1].body, requests[0].body, 'The explicit transient rejection is retried once before the run fails.'); assert.equal(requests[2].body.model, 'model-b');
  const sent = JSON.stringify(requests[2].body.messages); assert.match(sent, /ORIGINAL_RETRY_HANDOFF_TASK/); assert.ok(sent.includes(original.nodes.agent.output)); assert.ok(sent.includes(failed.input)); assert.equal(codex.calls.length, 1, 'the retry must not dispatch to the old native thread'); assert.notEqual(completed.nodes.agent.threadId, original.nodes.agent.threadId); assert.notEqual(completed.nodes.agent.threadId, failed.nodes.agent.threadId);
  assert.deepEqual(engine.getRun(initial.id), original); assert.deepEqual(engine.getRun(failed.id), failed);
});

test('the actual provider transcript resolves a legacy default-model run without model receipts', async t => {
  const { engine: makeEngine, runtime, requests } = await fixture(t), engine = await makeEngine();
  const first = engine.startRun({ workflow: createMissionWorkflow({ id: 'legacy-model-chat', task: 'LEGACY_ACTUAL_CONTEXT', model: 'primary::model-a', planningMode: 'off' }), input: 'LEGACY_ACTUAL_CONTEXT' }); await engine.executions.get(first.id);
  const legacy = engine.runs.get(first.id); legacy.workflow.nodes.find(node => node.id === 'agent').model = 'default'; delete legacy.nodes.agent.resolvedModel; legacy.events = legacy.events.filter(event => event.data?.type !== 'thread'); const original = engine.getRun(first.id);
  const threadModel = await runtime.savedThreadModel(original.nodes.agent.threadId); assert.equal(threadModel, 'primary::model-a');
  const next = engine.continueRun(first.id, { nodeId: 'agent', message: 'Change models in this actual provider.', model: 'primary::model-b' }, { historyRuns: [original], threadModel }); await engine.executions.get(next.id); const result = engine.getRun(next.id);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.nodes.agent.threadId, original.nodes.agent.threadId); assert.equal(result.modelHandoff, undefined); assert.equal(requests.at(-1).body.model, 'model-b'); assert.match(JSON.stringify(requests.at(-1).body.messages), /LEGACY_ACTUAL_CONTEXT/); assert.deepEqual(engine.getRun(first.id), original);
});

test('conversation endpoints require the session, keep hidden families hidden and restore real continuation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-conversation-api-')), apps = [];
  class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
  let app, url, cookie;
  const boot = async () => { const codex = new Codex(); app = await createHarnessServer({ port: 0, runtime: codex, desktop: new Desktop(), autoAttachDesktop: false, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace') }); apps.push(app); await app.learning.updateSettings({ mode: 'manual' }); url = await app.listen(); const response = await fetch(url); cookie = response.headers.get('set-cookie').split(';', 1)[0]; await response.arrayBuffer(); };
  const request = async (route, method = 'GET', body, auth = true) => { const response = await fetch(new URL(route, url), { method, headers: { ...(auth ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  t.after(async () => { for (const application of apps) await application.close(); assert.match(path.basename(directory), /^relay-conversation-api-/); await rm(directory, { recursive: true, force: true }); }); await boot();
  assert.equal((await request('/api/conversations?state=deleted', 'GET', undefined, false)).status, 401);
  const started = await request('/api/runs', 'POST', { workflow: createMissionWorkflow({ id: 'archived-chat', task: 'Keep the actual chat.', model: 'codex-a', planningMode: 'off' }), input: 'Keep the actual chat.' }); assert.equal(started.status, 201); const id = started.data.id; await app.engine.executions.get(id); await app.conversations.chain;
  const continuation = { nodeId: 'agent', message: 'An actual follow-up.', model: 'codex-b' };
  assert.equal((await request(`/api/conversations/${id}/archive`, 'POST', {}, false)).status, 401);
  for (const action of ['archive', 'delete']) { const bucket = action === 'archive' ? 'archived' : 'deleted'; assert.equal((await request(`/api/conversations/${id}/${action}`, 'POST', {})).status, 200); assert.equal((await request('/api/conversations?state=active')).data.conversations.length, 0); assert.equal((await request(`/api/conversations?state=${bucket}`)).data.conversations.length, 1); assert.equal((await request(`/api/runs/${id}/continue`, 'POST', continuation)).status, 400); assert.equal((await request(`/api/runs/${id}/retry`, 'POST', {})).status, 400); assert.equal((await request(`/api/conversations/${id}`)).data.state, bucket); }
  await app.close(); await boot(); assert.equal((await request('/api/conversations?state=deleted')).data.conversations.length, 1); assert.equal((await request(`/api/conversations/${id}/restore`, 'POST', {})).status, 200); const next = await request(`/api/runs/${id}/continue`, 'POST', continuation); assert.equal(next.status, 201, JSON.stringify(next.data)); await app.engine.executions.get(next.data.id); const result = app.engine.getRun(next.data.id); assert.equal(result.nodes.agent.threadId, app.engine.getRun(id).nodes.agent.threadId); assert.equal(result.workflow.nodes.find(node => node.id === 'agent').model, 'codex-b'); assert.equal((await request(`/api/conversations/${next.data.id}`)).data.runs.length, 2);
});
