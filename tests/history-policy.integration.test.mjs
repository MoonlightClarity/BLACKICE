import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (condition, label) => {
  const until = Date.now() + 5000;
  while (Date.now() < until) { const result = condition(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${label} did not settle`);
};
const flow = (model = 'fixture-native') => ({ id: 'history-policy', name: 'History policy test', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Verifier', prompt: 'Use only this conversation and report verified facts.', model }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } });

class NativeFixture extends EventEmitter {
  constructor(execute) { super(); this.calls = []; this.execute = execute; this.prefix = `native-${randomUUID()}`; }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-native', models: [{ id: 'fixture-native', model: 'fixture-native', supportedReasoningEfforts: [] }], activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) {
    this.calls.push(options);
    const index = this.calls.length, threadId = options.threadId || `${this.prefix}-${index}`, turnId = `turn-${index}`;
    if (this.execute) return this.execute(options, { index, threadId, turnId });
    await recordFixturePlan(options, { title: 'Use the saved conversation for this reply', doneWhen: 'The reply preserves this conversation without borrowing another conversation’s messages.' });
    const output = `ASSISTANT_HISTORY_MARKER_${index}`;
    options.onEvent({ type: 'thread', model: options.model, threadId, turnId, codexHistory: options.codexHistory });
    options.onEvent({ type: 'message', itemId: `message-${index}`, threadId, turnId, text: output, phase: 'final_answer' });
    return { output, threadId, turnId, codexHistory: options.codexHistory };
  }
}
// Keep the real provider session/history implementation. The deterministic API
// fixture authors its outline through the actual task gateway before replying.
class ProviderFixture extends ProviderRuntime {
  async runAgent(options) {
    if (options.model?.includes('::')) await recordFixturePlan(options, { title: 'Continue the selected API conversation', doneWhen: 'The admitted provider reply uses the correct durable conversation session.' });
    return super.runAgent(options);
  }
}
class NoDesktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }

async function application(t, runtimeFactory = async () => new NativeFixture()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-history-policy-')), dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace');
  let current;
  const close = async () => { if (current) { const owned = current; current = null; await owned.app.close(); } };
  const reopen = async () => {
    await close();
    const runtime = await runtimeFactory({ dataDir, cwd });
    const app = await createHarnessServer({ runtime, desktop: new NoDesktop(), port: 0, dataDir, defaultCwd: cwd, autoAttachDesktop: false });
    const url = await app.listen(), home = await fetch(url), cookie = home.headers.get('set-cookie').split(';', 1)[0]; await home.arrayBuffer();
    const api = async (route, { method = 'GET', body, authenticated = true } = {}) => {
      const response = await fetch(new URL(route, url), { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); return { status: response.status, headers: response.headers, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    };
    const settled = id => waitFor(() => { const run = app.engine.getRun(id); return run.settled && run; }, 'history-policy run');
    current = { app, runtime, api, settled, url }; return current;
  };
  t.after(async () => { await close(); assert.match(path.basename(directory), /^relay-history-policy-/); await rm(directory, { recursive: true, force: true }); });
  return { ...await reopen(), reopen, close, directory, dataDir, cwd };
}
const start = async (session, input, model) => {
  const result = await session.api('/api/runs', { method: 'POST', body: { workflow: flow(model), input } }); assert.equal(result.status, 201, result.text); return session.settled(result.data.id);
};
const follow = async (session, run, message, model) => {
  const result = await session.api(`/api/runs/${run.id}/continue`, { method: 'POST', body: { nodeId: 'agent', message, ...(model ? { model } : {}) } }); assert.equal(result.status, 201, result.text); return session.settled(result.data.id);
};

test('Relay-only is the default, follow-ups use saved messages and survive reopening without native resume', async t => {
  const session = await application(t);
  assert.deepEqual((await session.api('/api/runtime/settings')).data, { codexHistory: 'relay', runTimeoutMs: null, providerIdleTimeoutMs: 300000, defaultEffort: 'default', defaultServiceTier: 'default', defaultContext: { preset: 'model', windowTokens: null, autoCompact: true }, verbosity: 'balanced', subagentsEnabled: false, maxSubagents: 3 });
  const first = await start(session, 'USER_HISTORY_MARKER_A: remember the copper rook.');
  const unrelated = await start(session, 'UNRELATED_CONVERSATION_MARKER: a different chat.');
  const second = await follow(session, first, 'USER_HISTORY_MARKER_B: what did I ask you to remember?');
  assert.equal(first.runtimeSettings.codexHistory, 'relay'); assert.equal(second.runtimeSettings.codexHistory, 'relay');
  assert.equal(session.runtime.calls[0].codexHistory, 'relay'); assert.equal(session.runtime.calls[2].codexHistory, 'relay');
  assert.equal(session.runtime.calls[2].threadId, undefined); assert.notEqual(first.nodes.agent.threadId, second.nodes.agent.threadId);
  assert.equal(second.modelHandoff.reason, 'relay-history');
  assert.match(session.runtime.calls[2].prompt, /USER_HISTORY_MARKER_A/); assert.match(session.runtime.calls[2].prompt, /ASSISTANT_HISTORY_MARKER_1/);
  assert.doesNotMatch(session.runtime.calls[2].prompt, /UNRELATED_CONVERSATION_MARKER|ASSISTANT_HISTORY_MARKER_2/);
  assert.equal(session.app.engine.getRun(unrelated.id).parentRunId, undefined);
  const reopened = await session.reopen();
  const third = await follow(reopened, second, 'USER_HISTORY_MARKER_C: continue after reopening.');
  assert.equal(reopened.runtime.calls[0].codexHistory, 'relay'); assert.equal(reopened.runtime.calls[0].threadId, undefined);
  assert.match(reopened.runtime.calls[0].prompt, /USER_HISTORY_MARKER_A/); assert.match(reopened.runtime.calls[0].prompt, /USER_HISTORY_MARKER_B/); assert.match(reopened.runtime.calls[0].prompt, /ASSISTANT_HISTORY_MARKER_3/);
  assert.doesNotMatch(reopened.runtime.calls[0].prompt, /UNRELATED_CONVERSATION_MARKER/); assert.equal(third.taskId, first.id);
});

test('history settings apply to future starts and transitions use fresh sessions when a private turn is involved', async t => {
  const entered = deferred(), release = deferred();
  const native = new NativeFixture(async (options, { index, threadId, turnId }) => {
    await recordFixturePlan(options, { title: 'Apply the admitted history policy', doneWhen: 'History policy changes affect future turns without changing this admitted turn.' });
    options.onEvent({ type: 'thread', model: options.model, threadId, turnId, codexHistory: options.codexHistory });
    if (index === 1) { entered.resolve(); await release.promise; }
    const output = `Policy output ${index}`;
    options.onEvent({ type: 'message', threadId, turnId, text: output, phase: 'final_answer' });
    return { output, threadId, turnId, codexHistory: options.codexHistory };
  });
  const session = await application(t, async () => native);
  const begun = await session.api('/api/runs', { method: 'POST', body: { workflow: flow(), input: 'Started privately.' } }); assert.equal(begun.status, 201);
  let first;
  try {
    await waitFor(() => native.calls.length === 1, 'first native start'); await entered.promise;
    const changed = await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'codex' } }); assert.equal(changed.status, 200);
    assert.equal(native.calls[0].codexHistory, 'relay'); assert.equal(session.app.engine.getRun(begun.data.id).runtimeSettings.codexHistory, 'relay');
  } finally { release.resolve(); first = await session.settled(begun.data.id); }
  const second = await follow(session, first, 'Now use Codex-visible history.');
  assert.equal(native.calls[1].codexHistory, 'codex'); assert.equal(native.calls[1].threadId, undefined); assert.equal(second.modelHandoff.reason, 'relay-history');
  const third = await follow(session, second, 'Resume that visible session.');
  assert.equal(native.calls[2].threadId, second.nodes.agent.threadId); assert.equal(third.modelHandoff, undefined);
  assert.equal((await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'relay' } })).status, 200);
  const fourth = await follow(session, third, 'Continue privately again.');
  assert.equal(native.calls[3].codexHistory, 'relay'); assert.equal(native.calls[3].threadId, undefined); assert.equal(fourth.modelHandoff.reason, 'relay-history');
  assert.match(native.calls[3].prompt, /Started privately/); assert.match(native.calls[3].prompt, /Resume that visible session/);
  assert.equal(session.app.engine.getRun(second.id).runtimeSettings.codexHistory, 'codex', 'old admitted snapshots remain unchanged');
  const reopened = await session.reopen(); assert.deepEqual((await reopened.api('/api/runtime/settings')).data, { codexHistory: 'relay', runTimeoutMs: null, providerIdleTimeoutMs: 300000, defaultEffort: 'default', defaultServiceTier: 'default', defaultContext: { preset: 'model', windowTokens: null, autoCompact: true }, verbosity: 'balanced', subagentsEnabled: false, maxSubagents: 3 });
});

test('API provider conversations retain their own durable sessions through Codex history changes and reopening', async t => {
  const requests = [], natives = [];
  const session = await application(t, async ({ dataDir }) => {
    const codex = new NativeFixture(); natives.push(codex);
    const runtime = await new ProviderFixture({ codex, dataDir, fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `API result ${requests.length}` }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); } }).init();
    if (!runtime.store.get('api')) await runtime.saveProvider({ id: 'api', type: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: ['api-model'] });
    await runtime.setDefaultModel('api::api-model'); return runtime;
  });
  const first = await start(session, 'API original task.', 'api::api-model');
  assert.match(first.nodes.agent.threadId, /^provider_/);
  await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'codex' } });
  const second = await follow(session, first, 'API visible-policy follow-up.');
  assert.equal(second.nodes.agent.threadId, first.nodes.agent.threadId); assert.equal(second.modelHandoff, undefined);
  await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'relay' } });
  const reopened = await session.reopen(), third = await follow(reopened, second, 'API follow-up after reopening.');
  assert.equal(third.nodes.agent.threadId, first.nodes.agent.threadId); assert.equal(third.modelHandoff, undefined);
  assert.equal(requests.length, 3); assert.equal(natives.reduce((sum, native) => sum + native.calls.length, 0), 0);
  const messages = JSON.stringify(requests[2].body.messages); assert.match(messages, /API original task/); assert.match(messages, /API visible-policy follow-up/); assert.match(messages, /API result 1/); assert.match(messages, /API result 2/);
});

test('HTTP native reconnect explicitly starts Codex while preserving a selected API default', async t => {
  const native = new NativeFixture(); let nativeStarts = 0;
  native.start = async () => { nativeStarts++; return native.status(); };
  const session = await application(t, async ({ dataDir }) => {
    const runtime = await new ProviderRuntime({ codex: native, dataDir }).init();
    await runtime.saveProvider({ id: 'api', type: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: ['api-model'] });
    await runtime.setDefaultModel('api::api-model'); return runtime;
  });
  assert.equal(nativeStarts, 0, 'an API default does not start the unused native connection at application startup');
  const connected = await session.api('/api/runtime/reconnect', { method: 'POST', body: {} });
  assert.equal(connected.status, 200, connected.text); assert.equal(nativeStarts, 1);
  assert.equal(connected.data.defaultModelSelection, 'api::api-model'); assert.equal(connected.data.defaultModel, 'api::api-model'); assert.equal(connected.data.codex.connected, true);
});

test('a failure before native session creation can continue on a different provider using the saved user task', async t => {
  const requests = [], codex = new NativeFixture(async () => { throw Object.assign(new Error('Fixture authentication expired before thread creation.'), { code: 'PROVIDER_AUTH' }); });
  const session = await application(t, async ({ dataDir }) => {
    const runtime = await new ProviderFixture({ codex, dataDir, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Recovered on the chosen API.' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); } }).init();
    await runtime.saveProvider({ id: 'recovery', type: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: ['api-model'] }); return runtime;
  });
  const first = await start(session, 'PRE_SESSION_TASK_MARKER: generate a copper rook.');
  assert.equal(first.status, 'failed'); assert.equal(first.nodes.agent.threadId, undefined);
  const second = await follow(session, first, 'Continue using the chosen API.', 'recovery::api-model');
  assert.equal(second.status, 'completed', second.error); assert.equal(second.modelHandoff.reason, 'session-unavailable');
  assert.match(JSON.stringify(requests[0].messages), /PRE_SESSION_TASK_MARKER/); assert.match(JSON.stringify(requests[0].messages), /Continue using the chosen API/);
  assert.match(second.nodes.agent.threadId, /^provider_/); assert.equal(codex.calls.length, 1);
});

test('retrying a failed visible continuation after selecting Relay-only rebuilds saved continuity instead of resuming Codex', async t => {
  const native = new NativeFixture(async (options, { index, threadId, turnId }) => {
    await recordFixturePlan(options, { title: 'Retain verified work through a history-policy retry', doneWhen: 'Retry rebuilds the original request, follow-up and recorded partial result without resuming the private native session.' });
    options.onEvent({ type: 'thread', model: options.model, threadId, turnId, codexHistory: options.codexHistory });
    const output = index === 2 ? 'RETRY_PARTIAL_MARKER: first action was confirmed before the connection failed.' : `Retry fixture result ${index}`;
    options.onEvent({ type: 'message', threadId, turnId, text: output, phase: index === 2 ? 'commentary' : 'final_answer' });
    if (index === 2) throw Object.assign(new Error('Fixture connection lost after partial work.'), { code: 'PROVIDER_NETWORK' });
    return { output, threadId, turnId, codexHistory: options.codexHistory };
  });
  const session = await application(t, async () => native);
  await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'codex' } });
  const first = await start(session, 'RETRY_ORIGINAL_MARKER: verify the existing artifact.');
  const failed = await follow(session, first, 'RETRY_FOLLOWUP_MARKER: verify the next change.');
  assert.equal(failed.status, 'failed'); assert.equal(native.calls[1].threadId, first.nodes.agent.threadId);
  await session.api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'relay' } });
  const requested = await session.api(`/api/runs/${failed.id}/retry`, { method: 'POST', body: {} }); assert.equal(requested.status, 201, requested.text);
  const retried = await session.settled(requested.data.id);
  assert.equal(retried.status, 'completed', retried.error); assert.equal(retried.runtimeSettings.codexHistory, 'relay'); assert.equal(native.calls[2].threadId, undefined);
  assert.equal(native.calls[2].codexHistory, 'relay'); assert.match(native.calls[2].prompt, /RETRY_ORIGINAL_MARKER/); assert.match(native.calls[2].prompt, /RETRY_FOLLOWUP_MARKER/); assert.match(native.calls[2].prompt, /RETRY_PARTIAL_MARKER/);
  assert.equal(retried.nodeHandoffs.agent.reason, 'relay-history'); assert.equal(retried.taskId, first.id);
});

test('a failed initial Relay-only turn retains its partial saved messages when Retry starts a new native session', async t => {
  const native = new NativeFixture(async (options, { index, threadId, turnId }) => {
    await recordFixturePlan(options, { title: 'Preserve partial work through a fresh-session retry', doneWhen: 'The retry receives the original request and partial saved result from the failed turn.' });
    options.onEvent({ type: 'thread', model: options.model, threadId, turnId, codexHistory: options.codexHistory });
    if (index === 1) {
      options.onEvent({ type: 'message', threadId, turnId, text: 'INITIAL_PRIVATE_PARTIAL_MARKER: the first operation finished; inspect its result before repeating it.', phase: 'commentary' });
      throw Object.assign(new Error('Fixture stopped after the first confirmed action.'), { code: 'PROVIDER_NETWORK' });
    }
    return { output: 'Retried from saved private continuity.', threadId, turnId, codexHistory: options.codexHistory };
  });
  const session = await application(t, async () => native), first = await start(session, 'INITIAL_PRIVATE_TASK_MARKER: perform the requested checks.');
  assert.equal(first.status, 'failed'); assert.equal(first.nodes.agent.resumeThreadId, undefined); assert.ok(first.nodes.agent.threadId);
  const requested = await session.api(`/api/runs/${first.id}/retry`, { method: 'POST', body: {} }); assert.equal(requested.status, 201, requested.text);
  const retried = await session.settled(requested.data.id);
  assert.equal(retried.status, 'completed', retried.error); assert.equal(native.calls[1].codexHistory, 'relay'); assert.equal(native.calls[1].threadId, undefined);
  assert.match(native.calls[1].prompt, /INITIAL_PRIVATE_TASK_MARKER/); assert.match(native.calls[1].prompt, /INITIAL_PRIVATE_PARTIAL_MARKER/);
  assert.equal(retried.nodeHandoffs.agent.reason, 'relay-history'); assert.equal(retried.taskId, first.id);
});

test('conversation exports use authenticated downloadable transcripts without native session or application configuration', async t => {
  const session = await application(t), first = await start(session, 'EXPORT_USER_MARKER: preserve this actual message.'), second = await follow(session, first, 'EXPORT_FOLLOWUP_MARKER: preserve the reply too.');
  const route = `/api/conversations/${first.id}/export`;
  assert.equal((await session.api(route, { authenticated: false })).status, 401);
  const json = await session.api(route); assert.equal(json.status, 200); assert.match(json.headers.get('content-disposition'), /^attachment; filename=".+\.json"$/); assert.equal(json.headers.get('cache-control'), 'no-store');
  assert.equal(json.data.format, 'relay-conversation'); assert.equal(json.data.conversation.resumable, false); assert.equal(json.data.turns.length, 2);
  assert.match(json.text, /EXPORT_USER_MARKER/); assert.match(json.text, /EXPORT_FOLLOWUP_MARKER/); assert.match(json.text, /ASSISTANT_HISTORY_MARKER_1/);
  assert.equal(json.text.includes(first.nodes.agent.threadId), false); assert.equal(json.text.includes(second.nodes.agent.threadId), false); assert.equal(json.text.includes('developerInstructions'), false); assert.equal(json.text.includes('runtimeSettings'), false);
  const markdown = await session.api(route + '?format=markdown'); assert.equal(markdown.status, 200); assert.match(markdown.headers.get('content-type'), /text\/markdown/); assert.match(markdown.headers.get('content-disposition'), /\.md"$/); assert.match(markdown.text, /EXPORT_USER_MARKER/); assert.match(markdown.text, /EXPORT_FOLLOWUP_MARKER/);
  assert.equal((await session.api(route + '?format=executable')).status, 400);
});
