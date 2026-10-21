import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { access, rm, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkCodexModelAccess, codexAccountSignature, MODEL_CHECK_MARKER, MODEL_CHECK_PROMPT } from '../lib/codex-model-check.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { codexModelCandidates, documentedCodexModels } from '../lib/codex-model-candidates.mjs';

const MODEL = 'Fixture/Exact.Model:2026.10';
const account = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'fixture' }, requiresOpenaiAuth: true };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function nativeFixture(t, mode = 'success') {
  const requests = [], replies = [], entered = deferred(); let child, directory, actuallyExited = false, kills = 0;
  const emit = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const done = (id = 'check-turn', items = [{ id: 'answer', type: 'agentMessage', text: MODEL_CHECK_MARKER }]) => emit({ method: 'turn/completed', params: { threadId: 'check-thread', turn: { id, status: 'completed', items } } });
  const exit = () => { if (!actuallyExited) { actuallyExited = true; child.emit('exit', 0, null); } };
  t.after(async () => {
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
    // This is only an in-memory process double. The test owns cleanup when it
    // deliberately simulates a child whose real-world exit is unconfirmed.
    if (directory) { assert.match(directory, /blackice-model-check-[^/\\]+$/); await rm(directory, { recursive: true, force: true }); }
  });
  function spawnImpl(command, args, options) {
    assert.equal(command, 'fixture-command'); assert.deepEqual(args, ['app-server']);
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    directory = options.cwd; child = new EventEmitter(); child.pid = mode === 'spawn-failed' ? undefined : 12345;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { kills++; if (mode === 'kill-failed') child.emit('error', Object.assign(Error('Fixture kill denied.'), { code: 'EPERM' })); else exit(); return mode !== 'kill-failed'; };
    child.stdin = new Writable({ write(bytes, encoding, callback) {
      const request = JSON.parse(bytes.toString());
      if (!request.method) replies.push(request); else requests.push(request);
      queueMicrotask(() => {
        if (!request.method || request.id === undefined || actuallyExited) return;
        if (mode === 'spawn-failed') { child.emit('error', Object.assign(Error('Fixture executable missing.'), { code: 'ENOENT' })); return; }
        if (mode === 'startup-timeout' && request.method === 'initialize') return;
        if (mode === 'oversized' && request.method === 'initialize') { child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); return; }
        let result;
        if (request.method === 'initialize') result = {};
        else if (request.method === 'account/read') result = mode === 'different-account' ? { ...account, account: { ...account.account, email: 'other@example.invalid' } } : account;
        else if (request.method === 'thread/start') result = { thread: { id: 'check-thread', ephemeral: mode !== 'not-ephemeral' }, model: mode === 'wrong-model' ? 'OtherModel' : request.params.model };
        else if (request.method === 'turn/start') result = { turn: { id: 'check-turn', status: 'inProgress', ...(mode === 'wrong-turn-model' ? { model: 'OtherModel' } : {}) } };
        else throw Error(`Unexpected fixture RPC: ${request.method}`);
        if (request.method === 'turn/start' && mode === 'completion-first') done();
        emit({ id: request.id, result });
        if (request.method === 'account/read' && mode === 'account-race') emit({ method: 'account/updated', params: { authMode: 'chatgpt' } });
        if (request.method !== 'turn/start') return;
        entered.resolve();
        if (['held', 'kill-failed', 'completion-first'].includes(mode)) return;
        if (mode === 'tool-request') { emit({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { command: 'NEVER EXECUTED BY THIS FIXTURE' } }); return; }
        if (mode === 'tool-event') { emit({ method: 'item/started', params: { threadId: 'check-thread', turnId: 'check-turn', item: { id: 'tool', type: 'commandExecution' } } }); return; }
        if (mode === 'native-failed') { emit({ method: 'turn/completed', params: { threadId: 'check-thread', turn: { id: 'check-turn', status: 'failed', error: { message: 'This exact model is not supported for the fixture account.', code: 'MODEL_UNSUPPORTED' }, items: [] } } }); return; }
        if (['foreign-thread', 'foreign-turn'].includes(mode)) {
          const ids = { threadId: mode === 'foreign-thread' ? 'other-thread' : 'check-thread', turnId: 'other-turn' };
          emit({ method: 'item/completed', params: { ...ids, item: { id: 'foreign', type: 'agentMessage', text: MODEL_CHECK_MARKER } } });
          emit({ method: 'item/agentMessage/delta', params: { ...ids, itemId: 'delta', delta: MODEL_CHECK_MARKER } });
          done('check-turn', []); return;
        }
        done(mode === 'wrong-turn' ? 'different-turn' : 'check-turn');
      });
      callback();
    } });
    child.stdin.on('finish', () => { if (mode !== 'kill-failed') exit(); });
    return child;
  }
  return { requests, replies, entered: entered.promise, finish: done, spawnImpl,
    get directory() { return directory; }, get actuallyExited() { return actuallyExited; }, get kills() { return kills; },
    run: options => checkCodexModelAccess({ command: 'fixture-command', model: MODEL, expectedAccountSignature: codexAccountSignature(account), spawnImpl, timeoutMs: ['startup-timeout', 'kill-failed'].includes(mode) ? 20 : 1000, cleanupMs: 5, ...options }),
  };
}

test('documented candidates are bounded exact IDs with lifecycle and do not become advertised or accepted', () => {
  const all = documentedCodexModels(); assert.equal(new Set(all.map(model => model.id)).size, all.length); assert.ok(all.length <= 20);
  const spark = all.find(model => model.id === 'gpt-5.3-codex-spark'); assert.equal(spark.lifecycle.state, 'retired'); assert.equal(spark.lifecycle.date, '2026-09-14');
  assert.equal(spark.provenance.url, 'https://learn.chatgpt.com/docs/models');
  const candidates = codexModelCandidates([{ id: 'picker-alias', model: 'gpt-6.1-sol' }]);
  assert.equal(candidates.some(model => model.id === 'gpt-6.1-sol'), false); assert.ok(candidates.every(model => model.source === 'documented' && model.access.state === 'unverified'));
  const accepted = codexModelCandidates([], { 'gpt-5.3-codex-spark': { state: 'accepted', scope: 'current-connection' } }).find(model => model.id === spark.id);
  assert.equal(accepted.access.state, 'accepted'); assert.equal(accepted.lifecycle.state, 'retired', 'an inference does not rewrite source lifecycle');
  accepted.lifecycle.state = 'current'; assert.equal(documentedCodexModels().find(model => model.id === spark.id).lifecycle.state, 'retired');
});

test('an explicit check accepts only a completed exact-model text turn and cleans its isolated child and directory', async t => {
  const f = nativeFixture(t), result = await f.run();
  assert.equal(result.status, 'accepted'); assert.equal(result.requestedModel, MODEL); assert.equal(result.effectiveModel, MODEL); assert.equal(result.answerMatchesMarker, true);
  assert.equal(result.childExited, true); assert.equal(result.temporaryCwdRemoved, true); assert.equal(f.actuallyExited, true); await assert.rejects(access(f.directory), { code: 'ENOENT' });
  assert.equal(result.toolRequestsDenied, 0); assert.equal(result.toolEventsObserved, 0);
  assert.deepEqual(f.requests.map(request => request.method), ['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start']);
  const thread = f.requests.find(request => request.method === 'thread/start').params, turn = f.requests.find(request => request.method === 'turn/start').params;
  assert.equal(thread.model, MODEL); assert.equal(thread.allowProviderModelFallback, false); assert.equal(thread.ephemeral, true); assert.equal(thread.cwd, f.directory);
  assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.sandbox, 'read-only'); assert.deepEqual(thread.environments, []); assert.deepEqual(thread.dynamicTools, []);
  assert.equal(turn.model, MODEL); assert.equal(turn.approvalPolicy, 'never'); assert.deepEqual(turn.environments, []); assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.input, [{ type: 'text', text: MODEL_CHECK_PROMPT }]); assert.equal(thread.config, undefined); assert.equal(turn.config, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture@example|accountSignature|read-only|NEVER EXECUTED/);
});

test('completion may beat its acknowledgement but a different effective model or turn is never accepted', async t => {
  const first = nativeFixture(t, 'completion-first'); assert.equal((await first.run()).status, 'accepted');
  for (const [mode, code] of [['wrong-model', 'CODEX_MODEL_CHECK_MODEL_MISMATCH'], ['wrong-turn-model', 'CODEX_MODEL_CHECK_MODEL_MISMATCH'], ['wrong-turn', 'CODEX_MODEL_CHECK_TURN_MISMATCH'], ['not-ephemeral', 'CODEX_MODEL_CHECK_HISTORY_UNCONFIRMED']]) {
    const f = nativeFixture(t, mode), result = await f.run(); assert.equal(result.status, 'failed', mode); assert.equal(result.error.code, code, mode); assert.equal(result.childExited, true);
    if (['wrong-model', 'not-ephemeral'].includes(mode)) assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  }
});

test('foreign-thread and foreign-turn text cannot verify an empty owned turn', async t => {
  for (const mode of ['foreign-thread', 'foreign-turn']) { const f = nativeFixture(t, mode), result = await f.run(); assert.equal(result.status, 'failed', mode); assert.equal(result.error.code, 'CODEX_MODEL_CHECK_NO_ANSWER', mode); }
});

test('a changed account or an account notification racing its read prevents inference', async t => {
  for (const mode of ['different-account', 'account-race']) {
    const f = nativeFixture(t, mode), result = await f.run(); assert.equal(result.status, 'interrupted'); assert.equal(result.error.code, 'CODEX_MODEL_CHECK_ACCOUNT_CHANGED');
    assert.equal(f.requests.some(request => request.method === 'thread/start'), false); assert.equal(result.childExited, true);
  }
});

test('server approvals and tool events are denied without executing a tool or accepting a result', async t => {
  for (const mode of ['tool-request', 'tool-event']) {
    const f = nativeFixture(t, mode), result = await f.run(); assert.equal(result.status, 'interrupted'); assert.equal(result.childExited, true);
    assert.equal(result.toolRequestsDenied, mode === 'tool-request' ? 1 : 0); assert.equal(result.toolEventsObserved, mode === 'tool-event' ? 1 : 0);
    if (mode === 'tool-request') { assert.deepEqual(f.replies.map(reply => reply.error?.code), [-32601]); assert.equal(f.replies[0].result, undefined); }
  }
});

test('startup deadline, cancellation, oversized unterminated output and endpoint rejection each end without replay', async t => {
  for (const [mode, code] of [['startup-timeout', 'CODEX_MODEL_CHECK_TIMEOUT'], ['oversized', 'CODEX_MODEL_CHECK_PROTOCOL'], ['native-failed', 'MODEL_UNSUPPORTED'], ['spawn-failed', 'ENOENT']]) {
    const f = nativeFixture(t, mode), result = await f.run(); assert.notEqual(result.status, 'accepted'); assert.equal(result.error.code, code); assert.equal(result.childExited, true); assert.equal(result.temporaryCwdRemoved, true);
    assert.ok(f.requests.filter(request => request.method === 'turn/start').length <= 1);
  }
  const f = nativeFixture(t, 'held'), controller = new AbortController(), work = f.run({ signal: controller.signal }); await f.entered; controller.abort();
  const stopped = await work; assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.error.code, 'CODEX_MODEL_CHECK_INTERRUPTED'); assert.equal(stopped.childExited, true);
  const before = nativeFixture(t); const rejected = await before.run({ signal: AbortSignal.abort() }); assert.equal(rejected.status, 'interrupted'); assert.deepEqual(before.requests, []);
});

test('a running-child error without an exit never claims cleanup or deletes its directory', async t => {
  const f = nativeFixture(t, 'kill-failed'), controller = new AbortController();
  // This case tests a running child that refuses cleanup. A 20 ms startup
  // deadline can expire during mkdtemp before there is any child to stop.
  const work = f.run({ signal: controller.signal, timeoutMs: 10000 });
  assert.equal(await Promise.race([f.entered.then(() => true), work.then(() => false)]), true, 'the owned child reached its inference turn before cleanup is tested');
  controller.abort(); const result = await work;
  assert.equal(result.status, 'interrupted'); assert.equal(result.error.code, 'CODEX_MODEL_CHECK_CLEANUP'); assert.equal(result.childExited, false); assert.equal(result.temporaryCwdRemoved, false); assert.equal(f.actuallyExited, false);
  await access(f.directory); assert.ok(f.kills >= 1);
});

function runtimeFixture(t) {
  const checks = [], release = deferred(); let stopped = false;
  const runtime = new CodexRuntime({ command: process.execPath, modelCheckImpl: async options => {
    checks.push(options); options.signal.addEventListener('abort', () => { stopped = true; release.resolve(); }, { once: true });
    await release.promise;
    return { model: options.model, requestedModel: options.model, effectiveModel: options.model, status: 'accepted', checkedAt: '2026-10-18T01:00:00Z', childExited: true, temporaryCwdRemoved: true };
  }, spawnImpl() { throw Error('Ordinary runtime spawning is forbidden in this fixture.'); } });
  Object.assign(runtime.info, { connected: true, authenticated: true, models: [{ id: 'fixture-picker', model: MODEL }], defaultModel: MODEL }); runtime.accountSignature = codexAccountSignature(account);
  t.after(async () => { runtime.modelCheck?.controller.abort(); release.resolve(); await runtime.modelCheck?.promise.catch(() => {}); runtime.closing = true; });
  return { runtime, checks, release: () => release.resolve(), get stopped() { return stopped; } };
}

test('runtime coalesces one exact native check, leaves active tasks and defaults alone, and records only completed evidence', async t => {
  const f = runtimeFixture(t), { runtime } = f;
  const ordinaryTask = {}; runtime.threads.set('ordinary-task', ordinaryTask);
  const first = runtime.checkModelAccess('fixture-picker'), same = runtime.checkModelAccess(MODEL); assert.equal(first, same);
  assert.throws(() => runtime.checkModelAccess('other-model'), { code: 'CODEX_MODEL_CHECK_BUSY', status: 409 });
  assert.deepEqual(runtime.status().modelAccess, {}); assert.equal(runtime.status().modelCheck.status, 'checking');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.checks.length, 1); assert.equal(f.checks[0].model, MODEL); assert.equal(f.checks[0].timeoutMs, 45000);
  f.release(); const result = await first; assert.equal(result.status, 'accepted'); assert.equal(runtime.status().models[0].access.state, 'accepted');
  assert.equal(runtime.threads.get('ordinary-task'), ordinaryTask); runtime.threads.delete('ordinary-task'); assert.equal(runtime.info.defaultModel, MODEL); assert.equal(runtime.status().modelCheck.status, 'accepted');
});

test('an account or connection transition aborts only the check and excludes its late completed result', async t => {
  const f = runtimeFixture(t), { runtime } = f, ordinaryTask = {}; runtime.threads.set('ordinary-task', ordinaryTask);
  const checking = runtime.checkModelAccess(MODEL); await new Promise(resolve => setImmediate(resolve)); runtime._invalidateModelAccess();
  const result = await checking; assert.equal(f.stopped, true); assert.equal(result.status, 'interrupted'); assert.equal(result.scope, 'expired-connection'); assert.deepEqual(runtime.status().modelAccess, {}); assert.equal(runtime.status().modelCheck, null);
  assert.equal(runtime.threads.get('ordinary-task'), ordinaryTask); runtime.threads.delete('ordinary-task');
});

test('runtime close awaits the owned check cleanup and malformed IDs never start a check', async t => {
  const f = runtimeFixture(t), { runtime } = f;
  for (const value of ['default', 'codex', 'provider::model', 'bad model', '', null]) assert.throws(() => runtime.checkModelAccess(value)); assert.equal(f.checks.length, 0);
  const checking = runtime.checkModelAccess(MODEL); await new Promise(resolve => setImmediate(resolve)); await runtime.close();
  assert.equal(f.stopped, true); assert.equal((await checking).status, 'interrupted'); assert.equal(runtime.status().modelCheck, null);
});

test('provider discovery and checks preserve saved defaults byte-for-byte and require a separate explicit ID registration', async t => {
  const f = runtimeFixture(t), dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-candidate-provider-'));
  const provider = new ProviderRuntime({ codex: f.runtime, dataDir, fetchImpl() { throw Error('A native model check cannot contact an API provider.'); } });
  t.after(async () => { await provider.close(); await rm(dataDir, { recursive: true, force: true }); });
  await provider.init(); await provider.store.pinAutomaticDefault(MODEL); await provider.store.setDefaultModel(MODEL);
  const saved = await readFile(provider.store.file, 'utf8'), candidate = 'gpt-5.3-codex-spark';
  assert.equal(provider.codexModelCatalog().candidates.find(model => model.id === candidate).access.state, 'unverified'); assert.deepEqual(f.checks, []);
  const checking = provider.checkCodexModel(candidate); f.release(); const checked = await checking;
  assert.equal(checked.result.status, 'accepted'); assert.equal(checked.result.model, candidate); assert.equal(checked.result.requestedModel, candidate);
  assert.equal(checked.candidates.find(model => model.id === candidate).access.state, 'accepted'); assert.equal(checked.candidates.find(model => model.id === candidate).lifecycle.state, 'retired');
  assert.equal(await readFile(provider.store.file, 'utf8'), saved); assert.equal(provider.status().defaultModelSelection, MODEL); assert.equal(provider.status().automaticDefaultModel, MODEL);
  assert.equal(provider.status().models.some(model => model.id === candidate), false); assert.deepEqual(provider.store.listCodexModels(), []);
  await provider.addCodexModel(candidate); const option = provider.status().models.find(model => model.id === candidate);
  assert.equal(option.source, 'custom'); assert.equal(option.lifecycle.state, 'retired'); assert.equal(option.access.state, 'accepted'); assert.equal(provider.resolveModel(candidate).model, candidate); assert.equal(provider.status().defaultModelSelection, MODEL);
  f.runtime._invalidateModelAccess(); assert.equal(provider.codexModelCatalog().candidates.find(model => model.id === candidate).access.state, 'unverified'); assert.equal(provider.status().models.find(model => model.id === candidate).access.state, 'unverified');
});
