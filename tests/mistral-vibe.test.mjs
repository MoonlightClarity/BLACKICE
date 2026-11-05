import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MistralVibeRuntime, vibeModelCatalog, vibeIsolationConfig, vibeAccountCatalog } from '../lib/mistral-vibe.mjs';

const configOptions = [
  { id: 'model', currentValue: 'mistral-medium-3.5', options: [{ value: 'mistral-medium-3.5', name: 'Mistral Medium 3.5', description: 'mistral-vibe-cli-latest' }] },
  { id: 'thinking', currentValue: 'high', options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }] },
];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeConnection extends EventEmitter {
  constructor(options, fixture) { super(); this.options = options; this.fixture = fixture; this.calls = []; this.closed = false; this.turn = 0; }
  async initialize() {
    const home = this.options.env.VIBE_HOME;
    if (home) {
      this.profileConfig = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
      this.agentProfile = await fs.readFile(path.join(home, 'agents', 'blackice.toml'), 'utf8');
    }
    return this.request('initialize', {});
  }
  async request(method, params = {}, options = {}) {
    this.calls.push({ method, params });
    if (options.signal?.aborted) throw options.signal.reason;
    const operation = Promise.resolve().then(async () => {
      if (this.fixture.handler) {
        const result = await this.fixture.handler(this, method, params, options);
        if (result !== undefined) return result;
      }
      if (method === 'initialize') return { agentInfo: { version: '3.1.0' }, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'browser-auth-delegated' }] };
      if (method === '_auth/status') return { authenticated: this.fixture.authenticated !== false, authState: 'os_keyring' };
      if (method === 'session/new' || method === 'session/load') {
        this.sessionId = params.sessionId || 'native-' + this.fixture.connections.length + '-' + Math.random();
        this.totals = this.fixture.sessions.get(this.sessionId) || 0;
        if (method === 'session/load') this.message('historical text must not be replayed as current output', 'old-message');
        this.usage();
        return { ...(method === 'session/new' ? { sessionId: this.sessionId } : {}), configOptions };
      }
      if (method === 'session/set_config_option') return { configOptions };
      if (method === 'session/close') return {};
      if (method === 'session/prompt') {
        this.turn++;
        if (this.fixture.onPrompt) return this.fixture.onPrompt(this, params, options);
        return this.answer('answer ' + this.turn);
      }
      throw new Error('Unexpected fake method: ' + method);
    });
    if (!options.signal) return operation;
    return new Promise((resolve, reject) => {
      const abort = () => { options.signal.removeEventListener('abort', abort); reject(options.signal.reason); };
      options.signal.addEventListener('abort', abort, { once: true });
      operation.then(value => { options.signal.removeEventListener('abort', abort); resolve(value); }, cause => { options.signal.removeEventListener('abort', abort); reject(cause); });
    });
  }
  usage() {
    this.emit('notification', { method: 'session/update', params: { sessionId: this.sessionId, update: {
      sessionUpdate: 'usage_update', used: this.fixture.observedContext ?? this.totals * 20, size: 202144,
      _meta: { promptTokens: this.totals * 10, completionTokens: this.totals * 2, totalTokens: this.totals * 12, cachedTokens: 0 },
    } } });
  }
  message(text, messageId = 'message-' + this.turn) {
    this.emit('notification', { method: 'session/update', params: { sessionId: this.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } } });
  }
  answer(text) {
    this.message(text);
    this.totals++;
    this.fixture.sessions.set(this.sessionId, this.totals);
    this.usage();
    return { stopReason: 'end_turn', usage: { inputTokens: this.totals * 10, outputTokens: this.totals * 2, totalTokens: this.totals * 12, cachedReadTokens: 0 } };
  }
  notify(method, params) { this.calls.push({ method, params, notification: true }); }
  async close() { if (this.closed) return; if (this.fixture.closeGate) await this.fixture.closeGate.promise; if (this.closed) return; this.closed = true; this.emit('exit', { code: 0 }); }
}

async function fixture(t, extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-vibe-test-'));
  const cli = path.join(dir, 'vibe-acp.exe');
  await fs.writeFile(cli, '');
  const state = { dir, connections: [], sessions: new Map(), ...extras };
  const runtime = new MistralVibeRuntime({
    dataDir: dir, cliPath: cli, catalogWaitMs: extras.catalogWaitMs ?? 0,
    connectionFactory: options => { const connection = new FakeConnection(options, state); state.connections.push(connection); return connection; },
    ...(extras.toolBridgeFactory ? { toolBridgeFactory: extras.toolBridgeFactory } : {}),
  });
  state.runtime = runtime;
  runtime._status({ installed: true, connected: true, authenticated: true, available: true, ...vibeModelCatalog(configOptions, 202144) });
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return state;
}
const input = extra => ({ cwd: path.resolve(os.tmpdir()), prompt: 'Current request', developerInstructions: 'Keep the BLACKICE policy.', model: 'mistral-medium-3.5', ...extra });

test('catalog uses only advertised aliases, maps off to none, and keeps runtime-reported context', () => {
  const catalog = vibeModelCatalog(configOptions, 202144);
  assert.equal(catalog.defaultModel, 'mistral-medium-3.5');
  assert.deepEqual(catalog.models.map(model => model.id), ['mistral-medium-3.5']);
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map(option => option.reasoningEffort), ['none', 'high']);
  assert.equal(catalog.models[0].defaultReasoningEffort, 'high');
  assert.equal(catalog.models[0].contextWindowTokens, 202144);
  assert.equal(catalog.models[0].contextWindowSource, 'runtime-reported');
  assert.equal(catalog.models[0].inputModalities, undefined);
  assert.throws(() => vibeModelCatalog([{ id: 'model', currentValue: 'invented', options: [] }]), { code: 'MISTRAL_VIBE_CATALOG' });
});

test('isolation disables ambient surfaces and never uses Vibe empty allowlist semantics', () => {
  const none = vibeIsolationConfig();
  assert.match(none, /enabled_tools = \["re:\(\?!\)"\]/);
  for (const name of ['enable_mcp', 'enable_connectors', 'enable_subagents', 'enable_background_processes', 'include_project_context', 'enable_update_checks', 'enable_telemetry']) assert.match(none, new RegExp(name + ' = false'));
  assert.match(none, /disabled_skills = \["\*"\]/);
  assert.match(none, /generate_titles = false/);
  assert.match(none, /experimental_enable_model_catalog = true/);
  const attached = vibeIsolationConfig({ toolNames: ['blackice_lookup', 'mcp_blackice.lookup'] });
  assert.match(attached, /enable_mcp = true/);
  assert.match(attached, /enabled_tools = \["blackice_lookup","mcp_blackice.lookup"\]/);
  assert.doesNotMatch(attached, /enabled_tools = \[\]/);
});

test('missing optional CLI cannot fail BLACKICE initialization or launch a process', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-no-vibe-'));
  let launched = 0;
  const runtime = new MistralVibeRuntime({ dataDir: dir, cliPath: path.join(dir, 'missing'), connectionFactory: () => { launched++; throw Error('must not launch'); } });
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const status = await runtime.init();
  assert.equal(status.installed, false);
  assert.equal(status.available, false);
  assert.equal(launched, 0);
});

test('refresh creates only an isolated metadata session and closes it without inference', async t => {
  const f = await fixture(t);
  const status = await f.runtime.refresh();
  assert.equal(status.authenticated, true);
  assert.equal(status.available, true);
  assert.equal(status.models[0].contextWindowTokens, 202144);
  const connection = f.connections[0];
  assert.ok(connection.closed);
  assert.equal(connection.calls.some(call => call.method === 'session/prompt'), false);
  const created = connection.calls.find(call => call.method === 'session/new');
  assert.deepEqual(created.params.mcpServers, []);
  assert.ok(created.params.cwd.startsWith(f.dir));
  assert.notEqual(created.params.cwd, input().cwd);
  const config = connection.profileConfig;
  assert.match(config, /enable_mcp = false/);
  const profile = connection.agentProfile;
  assert.match(profile, /system_prompt_id = "blackice"/);
});

test('real session review continuation publishes only an accepted final and correct cumulative usage', async t => {
  const events = [];
  const f = await fixture(t, { onPrompt: c => c.answer(c.turn === 1 ? 'draft' : 'accepted') });
  let reviewed = 0;
  const result = await f.runtime.runAgent(input({ effort: 'none', onEvent: event => events.push(event), onBeforeFinal: async candidate => {
    assert.equal(events.some(event => event.type === 'turn' && event.status === 'completed'), false);
    assert.equal(events.some(event => event.type === 'message' && event.phase === 'final_answer'), false);
    reviewed++;
    return reviewed === 1 ? { continue: true, prompt: 'Correct the draft.' } : null;
  } }));
  assert.equal(result.output, 'accepted');
  assert.equal(result.model, 'mistral-vibe::mistral-medium-3.5');
  assert.equal(result.providerId, 'mistral-vibe');
  assert.equal(result.usage.totalTokens, 24);
  assert.equal(await f.runtime.savedThreadModel(result.threadId), result.model);
  const prompts = f.connections[0].calls.filter(call => call.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId);
  assert.equal(prompts[1].params.prompt[0].text, 'Correct the draft.');
  assert.ok(f.connections[0].calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'thinking' && call.params.value === 'off'));
  assert.deepEqual(events.filter(event => event.type === 'message' && event.phase === 'final_answer').map(event => event.text), ['accepted']);
  assert.equal(events.filter(event => event.type === 'turn' && event.status === 'completed').length, 1);
});

test('persisted native session resumes privately, ignores history replay, and pins original model', async t => {
  const f = await fixture(t);
  const first = await f.runtime.runAgent(input());
  const second = await f.runtime.runAgent(input({ threadId: first.threadId, prompt: 'Follow-up' }));
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.output, 'answer 1');
  assert.equal(second.usage.totalTokens, 12);
  assert.ok(f.connections[1].calls.some(call => call.method === 'session/load'));
  assert.equal(f.connections[1].calls.some(call => call.method === 'session/new'), false);
  assert.doesNotMatch(second.output, /historical/);
  await assert.rejects(f.runtime.runAgent(input({ threadId: first.threadId, model: 'invented' })), { code: 'MISTRAL_VIBE_MODEL' });
});

test('malformed final review does not accept a final or mark the turn complete', async t => {
  const f = await fixture(t);
  for (const review of [{}, { continue: false }, { continue: 'true', prompt: 'x' }, { continue: true, prompt: '' }]) {
    const events = [];
    await assert.rejects(f.runtime.runAgent(input({ onEvent: event => events.push(event), onBeforeFinal: () => review })), { code: 'INVALID_FINAL_REVIEW' });
    assert.equal(events.some(event => event.type === 'turn' && event.status === 'completed'), false);
    assert.equal(events.some(event => event.type === 'message' && event.phase === 'final_answer'), false);
  }
});

test('Stop during delayed final review cannot publish a final or completed turn', async t => {
  const f = await fixture(t), controller = new AbortController(), entered = deferred(), review = deferred(), events = [];
  const running = f.runtime.runAgent(input({ signal: controller.signal, onEvent: event => events.push(event), onBeforeFinal: () => { entered.resolve(); return review.promise; } }));
  const rejected = assert.rejects(running, { code: 'ABORTED' });
  await entered.promise;
  controller.abort(Object.assign(Error('Stopped'), { code: 'ABORTED' }));
  await rejected;
  review.resolve(null);
  await tick();
  assert.equal(events.some(event => event.type === 'turn' && event.status === 'completed'), false);
  assert.equal(events.some(event => event.type === 'message' && event.phase === 'final_answer'), false);
});

test('close retains the active run lease until admitted tool callbacks and late receipts settle', async t => {
  const admitted = deferred(), finish = deferred(), events = [];
  let bridgeOptions, operation;
  const f = await fixture(t, {
    toolBridgeFactory: async options => {
      bridgeOptions = options;
      return {
        server: { type: 'http', name: 'blackice', url: 'http://127.0.0.1:1/mcp', headers: [] },
        toolNames: new Set(['blackice_do_work', 'mcp_blackice.do_work']),
        settle: async () => { await operation; }, close: async () => { await operation; },
      };
    },
    onPrompt: async c => {
      operation = bridgeOptions.onToolCall({ name: 'do_work', arguments: {}, callId: 'call-owned' }, { signal: bridgeOptions.signal })
        .then(result => { bridgeOptions.onEvent({ type: 'tool.result', callId: 'call-owned', success: result.success, duringSettlement: bridgeOptions.signal.aborted }); });
      admitted.resolve();
      await operation;
      return c.answer('done');
    },
  });
  const running = f.runtime.runAgent(input({ dynamicTools: [{ name: 'do_work', inputSchema: { type: 'object', properties: {} } }], onToolCall: () => finish.promise, onEvent: event => events.push(event) }));
  const rejected = assert.rejects(running, { code: 'ABORTED' });
  await admitted.promise;
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.runtime.runs.size, 1);
  assert.equal(f.runtime.status().activeTurns, 1);
  finish.resolve({ success: true, contentItems: [{ type: 'inputText', text: 'Confirmed late result' }] });
  await Promise.all([closing, rejected]);
  assert.equal(f.runtime.runs.size, 0);
  assert.equal(f.runtime.status().activeTurns, 0);
  assert.ok(events.some(event => event.type === 'tool.result' && event.success && event.duringSettlement));
});

test('steering is applied as a same-session follow-up before final acceptance', async t => {
  let threadId;
  const f = await fixture(t, { onPrompt: async c => {
    if (c.turn === 1) await f.runtime.steerAgent(threadId, 'Use the corrected direction.');
    return c.answer(c.turn === 1 ? 'early candidate' : 'steered answer');
  } });
  const result = await f.runtime.runAgent(input({ onEvent: event => { if (event.type === 'thread') threadId = event.threadId; } }));
  assert.equal(result.output, 'steered answer');
  assert.equal(f.connections[0].calls.filter(call => call.method === 'session/prompt')[1].params.prompt[0].text, 'Use the corrected direction.');
});

test('uncertain protocol failure cannot silently replay the same native prompt', async t => {
  let threadId;
  const f = await fixture(t, { onPrompt: () => { throw Object.assign(Error('connection lost after admission'), { code: 'MISTRAL_VIBE_EXITED' }); } });
  await assert.rejects(f.runtime.runAgent(input({ onEvent: event => { if (event.type === 'thread') threadId = event.threadId; } })), { code: 'MISTRAL_VIBE_EXITED' });
  const count = f.connections.length;
  await assert.rejects(f.runtime.runAgent(input({ threadId })), { code: 'MISTRAL_VIBE_TURN_UNCERTAIN' });
  assert.equal(f.connections.length, count);
});

test('analytical response profile has no MCP and declares host-validated structured output', async t => {
  const events = [];
  const f = await fixture(t, { onPrompt: c => c.answer('{"ok":true}') });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = await f.runtime.runAgent(input({ responseOnly: true, sandbox: 'read-only', outputSchema: schema, onEvent: event => events.push(event) }));
  assert.equal(result.output, '{"ok":true}');
  assert.deepEqual(f.connections[0].calls.find(call => call.method === 'session/new').params.mcpServers, []);
  const capabilities = events.find(event => event.type === 'capabilities');
  assert.equal(capabilities.attachedTools, 0);
  assert.equal(capabilities.structuredOutput, 'prompt-and-host-validation');
  const prompt = await fs.readFile(path.join(f.connections[0].options.env.VIBE_HOME, 'prompts', 'blackice.md'), 'utf8');
  assert.match(prompt, /BLACKICE validates the final output/);
});

test('delegated login is single-flight, opens no browser itself, and rejects foreign URLs', async t => {
  const completion = deferred();
  let starts = 0;
  const f = await fixture(t, { authenticated: false, handler: async (c, method, params) => {
    if (method !== 'authenticate') return undefined;
    if (params._meta.action === 'start') {
      starts++;
      return { _meta: { 'browser-auth-delegated': { attemptId: 'attempt', expiresAt: new Date(Date.now() + 60_000).toISOString(), signInUrl: 'https://console.mistral.ai/codestral/cli/authenticate?process_id=opaque' } } };
    }
    await completion.promise;
    f.authenticated = true;
    return { _meta: { 'browser-auth-delegated': { status: 'completed' } } };
  } });
  const [one, two] = await Promise.all([f.runtime.beginLogin(), f.runtime.beginLogin()]);
  assert.deepEqual(one, two);
  assert.equal(starts, 1);
  assert.equal(one.state, 'waiting');
  assert.equal(f.connections.length, 1);
  completion.resolve();
  await f.runtime.login.promise;
  assert.equal(f.runtime.status().authenticated, true);
  assert.equal(f.runtime.status().loginState, 'complete');
  assert.equal(f.runtime.status().url, undefined);
  const bad = await fixture(t, { authenticated: false, handler: async (c, method) => method === 'authenticate' ? { _meta: { 'browser-auth-delegated': { attemptId: 'x', expiresAt: new Date(Date.now() + 60_000).toISOString(), signInUrl: 'https://attacker.invalid/' } } } : undefined });
  await assert.rejects(bad.runtime.beginLogin(), { code: 'MISTRAL_VIBE_LOGIN_URL' });
});


test('final cumulative wire usage stays correct when the usage notification is delayed', async t => {
  const f = await fixture(t, { onPrompt: c => {
    c.message('wire-confirmed answer');
    c.totals++;
    c.fixture.sessions.set(c.sessionId, c.totals);
    setImmediate(() => { if (!c.closed) c.usage(); });
    return { stopReason: 'end_turn', usage: { inputTokens: c.totals * 10, outputTokens: c.totals * 2, totalTokens: c.totals * 12, cachedReadTokens: 0 } };
  } });
  const first = await f.runtime.runAgent(input());
  const second = await f.runtime.runAgent(input({ threadId: first.threadId }));
  assert.equal(first.usage.totalTokens, 12);
  assert.equal(second.usage.totalTokens, 12);
  const record = JSON.parse(await fs.readFile(path.join(f.dir, 'mistral-vibe', 'threads', first.threadId, 'thread.json')));
  assert.equal(record.usage.totalTokens, 24);
  assert.equal(record.nativeUsageTotals.totalTokens, 24);
});

test('fresh installed profile detects Vibe without launching unrequested ACP sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-vibe-detect-')), cli = path.join(dir, 'vibe-acp.exe');
  await fs.writeFile(cli, '');
  let launched = 0;
  const runtime = new MistralVibeRuntime({ dataDir: dir, cliPath: cli, connectionFactory: () => { launched++; throw Error('unexpected session'); } });
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const status = await runtime.init();
  await tick();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.available, false);
  assert.equal(launched, 0);
});


test('ACP permissions allow only a current exact BLACKICE tool identity and deny native tools', async t => {
  const permissions = [];
  const f = await fixture(t, {
    toolBridgeFactory: async () => ({
      server: { type: 'http', name: 'blackice', url: 'http://127.0.0.1:1/mcp', headers: [] },
      toolNames: new Set(['blackice_lookup', 'mcp_blackice.lookup']),
      settle: async () => {}, close: async () => {},
    }),
    onPrompt: async c => {
      for (const [id, name] of [['owned', 'mcp_blackice.lookup'], ['native', 'file_system.bash']]) {
        c.emit('notification', { method: 'session/update', params: { sessionId: c.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: id, _meta: { tool_name: name } } } });
        permissions.push(await c.options.onRequest('session/request_permission', { sessionId: c.sessionId, toolCall: { toolCallId: id }, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }] }));
      }
      return c.answer('must not publish this final');
    },
  });
  let executed = 0;
  await assert.rejects(f.runtime.runAgent(input({ dynamicTools: [{ name: 'lookup', inputSchema: { type: 'object' } }], onToolCall: () => { executed++; } })), { code: 'MISTRAL_VIBE_NATIVE_TOOL_DENIED' });
  assert.deepEqual(permissions.map(result => result.outcome.optionId), ['allow', 'deny']);
  assert.equal(executed, 0);
});

test('cancelled prompt retains actually observed positive cumulative usage during settlement', async t => {
  const events = [];
  const f = await fixture(t, { onPrompt: c => {
    c.totals++; c.usage();
    throw Object.assign(Error('cancelled before prompt response'), { code: 'ABORTED' });
  } });
  await assert.rejects(f.runtime.runAgent(input({ onEvent: event => events.push(event) })), { code: 'ABORTED' });
  const usage = events.find(event => event.type === 'usage' && event.duringSettlement);
  assert.equal(usage.usage.totalTokens, 12);
  assert.equal(usage.usage.total.totalTokens, 12);
});


test('invalid run boundaries fail before admitting a lease or spawning a native session', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.runAgent(input({ timeoutMs: 0 })), { code: 'INVALID_RUN_TIMEOUT' });
  await assert.rejects(f.runtime.runAgent(input({ providerIdleTimeoutMs: -1 })), { code: 'INVALID_PROVIDER_IDLE_TIMEOUT' });
  await assert.rejects(f.runtime.runAgent(input({ dynamicTools: {} })), { code: 'INVALID_TOOLS' });
  await assert.rejects(f.runtime.runAgent(input({ sandbox: 'unknown' })), { code: 'INVALID_SANDBOX' });
  assert.equal(f.runtime.status().activeTurns, 0);
  assert.equal(f.connections.length, 0);
});


test('native thread continuation cannot silently change the BLACKICE workspace', async t => {
  const f = await fixture(t);
  const first = await f.runtime.runAgent(input());
  const connections = f.connections.length;
  await assert.rejects(f.runtime.runAgent(input({ threadId: first.threadId, cwd: path.join(f.dir, 'different-workspace') })), { code: 'MISTRAL_VIBE_THREAD_WORKSPACE' });
  assert.equal(f.connections.length, connections);
});

test('native automatic compaction may handle existing history while an oversized new request is rejected', async t => {
  const f = await fixture(t);
  const first = await f.runtime.runAgent(input());
  f.observedContext = 190_000;
  const continued = await f.runtime.runAgent(input({ threadId: first.threadId, prompt: 'Small next request' }));
  assert.equal(continued.threadId, first.threadId);
  assert.equal(continued.output, 'answer 1');
  assert.ok(f.connections[1].calls.some(call => call.method === 'session/prompt'));
  await assert.rejects(f.runtime.runAgent(input({ prompt: 'x'.repeat(600_000) })), { code: 'CONTEXT_OVERFLOW' });
  assert.equal(f.connections.at(-1).calls.some(call => call.method === 'session/prompt'), false);
  await assert.rejects(f.runtime.runAgent(input({ context: { preset: 'custom', windowTokens: 100_000 } })), { code: 'MISTRAL_VIBE_CONTEXT_UNSUPPORTED' });
  await assert.rejects(f.runtime.runAgent(input({ context: { preset: 'model', compactAtTokens: 50_000 } })), { code: 'MISTRAL_VIBE_CONTEXT_UNSUPPORTED' });
});


const accountEntries = [
  { id: 'mistral-large-4-0', label: 'Mistral Large 4', aliases: ['mistral-large-4-0-3', 'mistral-large-4'], recommended: true, max_context_length: 1048576, parameters: { reasoning: ['low', 'medium', 'high'] }, capabilities: { function_calling: true, completion_chat: true, vision: true } },
  { id: 'mistral-medium-latest', label: 'Mistral Medium 3.5', aliases: ['mistral-medium', 'mistral-medium-3.5', 'mistral-vibe-cli-latest'], recommended: false, max_context_length: 262144, parameters: { reasoning: ['none', 'high'] }, capabilities: { function_calling: true, completion_chat: true, vision: true } },
  { id: 'zai-glm-5-3-flash', label: 'GLM 5.3 Flash (Mistral Hosted)', aliases: [], recommended: false, max_context_length: 1048576, parameters: { reasoning: ['low', 'high', 'max'] }, capabilities: { function_calling: true, completion_chat: true, vision: true } },
];
const accountCache = () => ({ 'synthetic-credential-cache-key': { stored_at_timestamp: Math.floor(Date.now() / 1000), payload: { models: accountEntries } } });
const nativeChoices = [
  ...accountEntries.map(model => ({ value: model.id, name: model.label, description: model.id })),
  ...configOptions[0].options,
];
const accountOptions = (current = 'mistral-medium-3.5', { noThinking = false } = {}) => {
  const entry = accountEntries.find(model => model.id === current || model.aliases.includes(current));
  return [
    { id: 'model', currentValue: current, options: [{ name: 'Account models', options: nativeChoices }] },
    ...(!noThinking ? [{ id: 'thinking', currentValue: 'high', options: entry.parameters.reasoning.map(value => ({ value: value === 'none' ? 'off' : value, name: value })) }] : []),
  ];
};
async function accountFixture(t, extras = {}) {
  return fixture(t, {
    ...extras,
    handler: async (connection, method, params) => {
      const state = connection.fixture;
      if (method === 'session/new' || method === 'session/load') {
        connection.sessionId = params.sessionId || 'account-session-' + state.connections.length;
        connection.totals = state.sessions.get(connection.sessionId) || 0;
        connection.catalogCurrent = 'mistral-medium-3.5';
        connection.catalogWarm = !state.catalogMissing && !state.cacheDelayMs;
        if (!state.catalogMissing) {
          const cacheFile = path.join(connection.options.env.VIBE_HOME, 'model_catalog_cache.json');
          const write = async () => { await fs.writeFile(cacheFile, JSON.stringify(accountCache())); connection.catalogWarm = true; };
          if (state.cacheDelayMs) connection.cacheWrite = new Promise(resolve => setTimeout(resolve, state.cacheDelayMs)).then(write);
          else await write();
        }
        if (!state.skipInitialUsage) connection.usage();
        return { ...(method === 'session/new' ? { sessionId: connection.sessionId } : {}),
          configOptions: connection.catalogWarm ? accountOptions() : configOptions };
      }
      if (method === 'session/set_config_option') {
        if (state.selectionFailure === params.value) throw Object.assign(new Error('Selected model metadata was unavailable'), { code: 'MODEL_METADATA_FAILED' });
        if (!connection.catalogWarm || state.catalogPartial) return { configOptions };
        if (params.configId === 'model') connection.catalogCurrent = params.value;
        return { configOptions: accountOptions(connection.catalogCurrent, { noThinking: state.noThinking === connection.catalogCurrent }) };
      }
      if (method === 'session/prompt' && state.deniedModel === connection.catalogCurrent) {
        throw Object.assign(new Error('Selected model requires different account access'), { code: 'MODEL_ACCESS_DENIED', status: 403 });
      }
      return undefined;
    },
  });
}

test('account catalog deduplicates only declared aliases and preserves the existing Medium public identity', () => {
  const catalog = vibeAccountCatalog(accountOptions(), accountCache(), ['mistral-medium-3.5']);
  assert.deepEqual(catalog.models.map(model => model.id), ['mistral-large-4-0', 'mistral-medium-3.5', 'zai-glm-5-3-flash']);
  assert.equal(catalog.defaultModel, 'mistral-medium-3.5');
  assert.equal(catalog.models[1].accountCatalogId, 'mistral-medium-latest');
  assert.deepEqual(catalog.models.map(model => [model.contextWindowTokens, model.contextWindowSource]), [
    [1048576, 'account-catalog'], [262144, 'account-catalog'], [1048576, 'account-catalog'],
  ]);
  assert.equal(catalog.models[2].displayName, 'GLM 5.3 Flash (Mistral Hosted)');
  const withoutAlias = accountCache();
  withoutAlias['synthetic-credential-cache-key'].payload = { models: accountEntries.map(model => ({ ...model, aliases: [] })) };
  assert.equal(vibeAccountCatalog(accountOptions(), withoutAlias).models.length, 4, 'matching display names are not identity evidence');
  const stale = accountCache();
  stale['synthetic-credential-cache-key'].stored_at_timestamp = 1;
  assert.equal(vibeAccountCatalog(accountOptions(), stale).accountCatalogState, 'unavailable');
  assert.equal(vibeAccountCatalog(configOptions, accountCache()).accountCatalogState, 'unavailable', 'an unrelated cache cannot admit models absent from ACP');
});

test('account refresh selects every visible native model for its own settings and publishes only after cleanup', async t => {
  const f = await accountFixture(t);
  let publishedAfterClose = false;
  f.runtime.on('status', status => { if (status.accountCatalogState === 'available') publishedAfterClose = f.connections.every(connection => connection.closed); });
  const status = await f.runtime.refresh();
  assert.equal(publishedAfterClose, true);
  assert.equal(status.defaultModel, 'mistral-medium-3.5');
  assert.deepEqual(status.models.map(model => model.id), ['mistral-large-4-0', 'mistral-medium-3.5', 'zai-glm-5-3-flash']);
  assert.deepEqual(status.models.map(model => model.supportedReasoningEfforts.map(option => option.reasoningEffort)), [
    ['low', 'medium', 'high'], ['none', 'high'], ['low', 'high', 'max'],
  ]);
  assert.ok(status.models.every(model => model.defaultReasoningEffort === 'high' && model.supportsReasoningSelection === true));
  assert.ok(status.models.every(model => model.contextWindowSource === 'account-catalog'));
  assert.equal(status.models[0].contextWindowTokens, 1048576, 'the initial Medium usable window must not leak into Large metadata');
  assert.equal(f.connections.flatMap(connection => connection.calls).some(call => call.method === 'session/prompt'), false);
  assert.equal(status.authenticated, true);
});

test('cold catalog discovery waits for the native cache and reads a snapshot without requiring a notification or prompt', async t => {
  const f = await accountFixture(t, { cacheDelayMs: 20, catalogWaitMs: 500 });
  const started = Date.now();
  const status = await f.runtime.refresh();
  assert.equal(status.models.length, 3);
  assert.ok(Date.now() - started < 2000);
  assert.equal(f.connections.flatMap(connection => connection.calls).some(call => call.method === 'session/prompt'), false);
  await Promise.all(f.connections.map(connection => connection.cacheWrite));
});

test('missing or failed catalog refresh preserves the working connection, list and durable receipt', async t => {
  const f = await accountFixture(t);
  const confirmed = await f.runtime.refresh();
  const durableFile = path.join(f.dir, 'mistral-vibe', 'catalog.json');
  const durable = await fs.readFile(durableFile, 'utf8');
  const oldHome = path.join(f.dir, 'mistral-vibe', 'catalog', 'home');
  await fs.mkdir(oldHome, { recursive: true });
  await fs.writeFile(path.join(oldHome, 'model_catalog_cache.json'), JSON.stringify(accountCache()));
  f.catalogMissing = true;
  const unavailable = await f.runtime.refresh();
  assert.equal(unavailable.accountCatalogState, 'stale');
  assert.match(unavailable.lastError, /could not be refreshed/);
  assert.deepEqual(unavailable.models, confirmed.models);
  assert.equal(unavailable.defaultModel, confirmed.defaultModel);
  assert.equal(unavailable.authenticated, true);
  assert.equal(unavailable.connected, true);
  assert.equal(unavailable.available, true);
  assert.equal(await fs.readFile(durableFile, 'utf8'), durable);
  assert.notEqual(f.connections[0].options.env.VIBE_HOME, f.connections[1].options.env.VIBE_HOME);
  assert.ok(f.connections.every(connection => connection.closed));
  f.catalogMissing = false;
  f.selectionFailure = 'zai-glm-5-3-flash';
  const failed = await f.runtime.refresh();
  assert.deepEqual(failed.models, confirmed.models);
  assert.equal(failed.available, true);
  assert.equal(failed.authenticated, true);
  assert.equal(await fs.readFile(durableFile, 'utf8'), durable);
  assert.ok(f.connections.every(connection => connection.closed));
});

test('a missing per-model thinking control explicitly disables generic reasoning choices', async t => {
  const f = await accountFixture(t, { noThinking: 'zai-glm-5-3-flash' });
  const status = await f.runtime.refresh();
  const glm = status.models.find(model => model.id === 'zai-glm-5-3-flash');
  assert.equal(glm.supportsReasoningSelection, false);
  assert.equal(glm.supportedReasoningEfforts, undefined);
  assert.equal(glm.defaultReasoningEffort, undefined);
  assert.deepEqual(status.models[0].supportedReasoningEfforts.map(option => option.reasoningEffort), ['low', 'medium', 'high']);
});

test('saved Medium native conversations remain on their original ID after the account catalog expands', async t => {
  const f = await accountFixture(t);
  const first = await f.runtime.runAgent(input());
  await f.runtime.refresh();
  const resumed = await f.runtime.runAgent(input({ threadId: first.threadId }));
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.model, 'mistral-vibe::mistral-medium-3.5');
  assert.equal(await f.runtime.savedThreadModel(first.threadId), 'mistral-vibe::mistral-medium-3.5');
  assert.equal(resumed.output, 'answer 1');
  const loads = f.connections.flatMap(connection => connection.calls).filter(call => call.method === 'session/load');
  assert.equal(loads.length, 1);
});

test('a model access rejection does not clear authentication, hide Medium, replay, or fall back', async t => {
  const f = await accountFixture(t);
  const confirmed = await f.runtime.refresh();
  f.deniedModel = 'mistral-large-4-0';
  await assert.rejects(f.runtime.runAgent(input({ model: 'mistral-large-4-0' })), { code: 'MODEL_ACCESS_DENIED' });
  assert.equal(f.runtime.status().authenticated, true);
  assert.equal(f.runtime.status().available, true);
  assert.deepEqual(f.runtime.status().models, confirmed.models);
  const medium = await f.runtime.runAgent(input());
  assert.equal(medium.model, 'mistral-vibe::mistral-medium-3.5');
  assert.equal(medium.output, 'answer 1');
  assert.equal(medium.context.remainingIsEstimate, true);
  assert.equal(medium.context.remainingTokens, null);
  assert.match(medium.context.estimateMethod, /native remaining context is unknown/);
  assert.equal(f.connections.flatMap(connection => connection.calls).filter(call => call.method === 'session/prompt').length, 2);
});

test('cancellation during account-catalog warmup never sends a prompt and releases the native lease', async t => {
  const f = await fixture(t, { catalogWaitMs: 5000 });
  const controller = new AbortController();
  const running = f.runtime.runAgent(input({ signal: controller.signal }));
  while (!f.connections.some(connection => connection.calls.some(call => call.method === 'session/new'))) await tick();
  controller.abort(Object.assign(new Error('Stopped during discovery'), { code: 'ABORTED' }));
  await assert.rejects(running, { code: 'ABORTED' });
  assert.equal(f.runtime.status().activeTurns, 0);
  assert.ok(f.connections.every(connection => connection.closed));
  assert.equal(f.connections.flatMap(connection => connection.calls).some(call => call.method === 'session/prompt'), false);
});


test('a partial native view never replaces a complete confirmed account catalog', async t => {
  const f = await accountFixture(t);
  const confirmed = await f.runtime.refresh();
  const durable = await fs.readFile(path.join(f.dir, 'mistral-vibe', 'catalog.json'), 'utf8');
  f.catalogPartial = true;
  const status = await f.runtime.refresh();
  assert.equal(status.accountCatalogState, 'stale');
  assert.match(status.lastError, /complete fresh account catalog/);
  assert.equal(status.available, true);
  assert.deepEqual(status.models, confirmed.models);
  assert.equal(await fs.readFile(path.join(f.dir, 'mistral-vibe', 'catalog.json'), 'utf8'), durable);
});

test('closing during metadata cleanup drains Refresh and prevents post-close catalog publication', async t => {
  const f = await accountFixture(t);
  f.closeGate = deferred();
  let published = false;
  f.runtime.on('status', status => { if (status.accountCatalogState === 'available') published = true; });
  const refreshing = f.runtime.refresh();
  const checkedRefresh = assert.rejects(refreshing, { code: 'MISTRAL_VIBE_CLOSED' });
  while (!f.connections.some(connection => connection.calls.some(call => call.method === 'session/close'))) await tick();
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  f.closeGate.resolve();
  await Promise.all([checkedRefresh, closing]);
  assert.equal(published, false);
  assert.equal(f.runtime.status().available, false);
  assert.equal(f.runtime.status().activeTurns, 0);
  await assert.rejects(fs.access(path.join(f.dir, 'mistral-vibe', 'catalog.json')));
});


test('catalog-only remaining context is unknown before and after the first native usage update', async t => {
  const f = await accountFixture(t, { skipInitialUsage: true });
  await f.runtime.refresh();
  const contexts = [];
  await f.runtime.runAgent(input({
    model: 'mistral-large-4-0',
    onEvent: event => { if (event.type === 'context') contexts.push(event.context); },
  }));
  assert.ok(contexts.length >= 2);
  assert.equal(contexts[0].remainingTokens, null);
  assert.equal(contexts[0].remainingIsEstimate, true);
  assert.equal(contexts.at(-1).estimatedInputTokens, 20, 'retain the actual native active-context count');
  assert.equal(contexts.at(-1).remainingTokens, null);
  assert.match(contexts.at(-1).estimateMethod, /native remaining context is unknown/);
});
