import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRuntime } from '../lib/codex.mjs';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';
import { DESKTOP_TOOL } from '../lib/desktop-tools.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

test('attached desktop dynamic tool returns text and image to the correct Codex turn', async t => {
  const client = runtime(t); let called = false;
  const result = await client.runAgent({ cwd, prompt: 'DYNAMIC_TOOL', dynamicTools: [DESKTOP_TOOL],
    onToolCall: async (call, context) => {
      called = true; assert.equal(call.name, 'relay_desktop'); assert.equal(call.arguments.action, 'screenshot');
      assert.equal(context.signal.aborted, false);
      return { success: true, contentItems: [{ type: 'inputText', text: 'Desktop ready' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,PIXELS' }] };
    },
  });
  assert.equal(called, true);
  const response = JSON.parse(result.output); assert.equal(response.success, true); assert.equal(response.contentItems[1].type, 'inputImage');
});

test('Codex cannot call a desktop tool that was not attached', async t => {
  const client = runtime(t); let called = false;const events=[];
  const result = await client.runAgent({ cwd, prompt: 'DYNAMIC_TOOL', onEvent:event=>events.push(event), onToolCall: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(JSON.parse(result.output).success, false);
  assert.equal(events.find(event=>event.type==='tool.result').success,false);
  assert.match(events.find(event=>event.type==='tool.result').message,/not attached/);
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function runtime(t, overrides = {}) {
  const client = new CodexRuntime({
    command: process.execPath, args: [fixture], cwd,
    requestTimeoutMs: 5000, runTimeoutMs: 8000, approvalTimeoutMs: 3000,
    ...overrides,
  });
  t.after(() => client.close());
  return client;
}
function recordedRuntime(t, overrides = {}) {
  const client=runtime(t,overrides),requests=[],request=client._request.bind(client);
  client._request=(method,params={},...args)=>{requests.push({method,params:structuredClone(params)});return request(method,params,...args);};
  return{client,requests};
}

test('JSONL handshake reads models and returns a sanitized account', async t => {
  const client = runtime(t);
  const status = await client.start();
  assert.equal(status.connected, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.defaultModel, 'fixture-model');
  assert.equal(status.models[0].model, 'fixture-model');
  assert.deepEqual(status.account, { type: 'chatgpt', planType: 'test' });
  assert.equal(JSON.stringify(status).includes('fixture@example.invalid'), false);
  status.models.length = 0;
  assert.equal(client.status().models.length, 1, 'status returns an independent snapshot');
});

const catalogModel = (id, options = {}) => ({ id, model: id, displayName: id, description: 'Local catalog fixture', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Fixture' }], ...options });

function passiveNativeFixture(t) {
  const client = new CodexRuntime({ command: process.execPath, cwd, requestTimeoutMs: 2000, runTimeoutMs: 4000, spawnImpl() { throw Error('No process is allowed in this fixture.'); } });
  const requests = []; let nextThread = 0, nextTurn = 0, models = [catalogModel('native-wire', { id: 'native-picker', isDefault: true })], account = { account: { type: 'chatgpt', email: 'first@example.invalid', planType: 'same-plan' }, requiresOpenaiAuth: true };
  client.child = {}; Object.assign(client.info, { connected: true, authenticated: true, models, defaultModel: 'native-wire' });
  client._request = async (method, params = {}) => {
    requests.push({ method, params: structuredClone(params) });
    if (method === 'account/read') return structuredClone(account);
    if (method === 'model/list') { const offset = Number(params.cursor || 0), end = offset + params.limit; return { data: structuredClone(models.slice(offset, end)), nextCursor: end < models.length ? String(end) : null }; }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || `passive-thread-${++nextThread}`, ephemeral: Boolean(params.ephemeral) }, model: params.model };
    if (method === 'turn/start') return { turn: { id: `passive-turn-${++nextTurn}`, status: 'inProgress' } };
    if (['thread/unsubscribe', 'turn/interrupt'].includes(method)) return {};
    throw Error(`Unexpected native fixture request: ${method}`);
  };
  t.after(() => { client.closing = true; client._connectionFailed(Object.assign(new Error('Fixture closed.'), { code: 'CODEX_CLOSED' }), client.child); });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  async function begin(model = 'native-picker', options = {}) {
    const work = client.runAgent({ cwd, prompt: 'A deterministic fixture task.', model, ...options }); work.catch(() => {}); await settle();
    const state = [...client.threads.values()].at(-1); assert.ok(state, 'fixture reached an actual turn');
    return { work, state };
  }
  const complete = (state, status = 'completed') => client._notification('turn/completed', { threadId: state.threadId, turn: { id: state.turnId, status, ...(status === 'failed' ? { error: { message: 'Fixture request failed, not an entitlement verdict.' } } : {}), items: [{ type: 'agentMessage', id: `message-${state.turnId}`, phase: 'final_answer', text: 'Fixture completed answer.' }] } });
  return { client, requests, begin, complete, settle, models(value) { models = value; }, account(value) { account = value; } };
}

test('native model access requires completed inference and preserves exact explicit and advertised alias routes', async t => {
  const { client, requests, begin, complete } = passiveNativeFixture(t);
  await client.start({ refresh: true }); assert.equal(client.status().models[0].access.state, 'unverified');
  const first = await begin(); assert.deepEqual(client.status().modelAccess, {}, 'thread creation and acknowledged turn start are unverified');
  client._notification('item/agentMessage/delta', { threadId: first.state.threadId, turnId: first.state.turnId, itemId: 'partial', delta: 'Partial output.' });
  assert.equal(client.status().models[0].access.state, 'unverified');
  complete(first.state); await first.work;
  assert.equal(client.status().models[0].access.state, 'accepted'); assert.ok(Date.parse(client.status().models[0].access.lastSuccessAt));
  assert.equal(requests.find(request => request.method === 'thread/start').params.model, 'native-wire');
  assert.equal(requests.find(request => request.method === 'thread/start').params.allowProviderModelFallback, false);
  const explicit = 'Vendor/Explicit.Model:preview', second = await begin(explicit); complete(second.state); await second.work;
  const resumed = await begin(explicit, { threadId: second.state.threadId }); complete(resumed.state); await resumed.work;
  assert.ok(requests.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)).slice(-4).every(request => request.params.model === explicit));
  assert.equal(client.status().modelAccess[explicit].state, 'accepted');
  assert.equal(client.status().models.some(model => model.id === explicit), false, 'access evidence does not fabricate catalog discovery');
  assert.equal(requests.some(request => /tool|exec|shell/i.test(request.method)), false);
});

test('native model access keeps failed and interrupted outcomes distinct and newer attempts own the result', async t => {
  const { client, begin, complete } = passiveNativeFixture(t);
  const older = await begin(), newer = await begin();
  complete(newer.state, 'failed'); await assert.rejects(newer.work, { code: 'CODEX_TURN_FAILED' });
  complete(older.state); await older.work;
  assert.equal(client.status().models[0].access.state, 'failed', 'an older successful run cannot overwrite a newer failed attempt');
  assert.equal(client.status().models[0].access.lastSuccessAt, undefined);
  const successful = await begin(); complete(successful.state); await successful.work;
  const lastSuccess = client.status().models[0].access.lastSuccessAt;
  const cancelled = await begin(); complete(cancelled.state, 'interrupted'); await assert.rejects(cancelled.work, { code: 'ABORT_ERR' });
  assert.equal(client.status().models[0].access.state, 'failed'); assert.equal(client.status().models[0].access.outcome, 'interrupted'); assert.equal(client.status().models[0].access.lastSuccessAt, lastSuccess);
  assert.equal(JSON.stringify(client.status().modelAccess).includes('Fixture request failed'), false, 'outcome evidence contains no task/error text');
});

test('native model access resets on account identity or connection changes and ignores prior-account late completions', async t => {
  const fixture = passiveNativeFixture(t), { client, begin, complete } = fixture;
  await client.start({ refresh: true }); const success = await begin(); complete(success.state); await success.work;
  await client.start({ refresh: true }); assert.equal(client.status().models[0].access.state, 'accepted', 'same-account refresh preserves a completed observation');
  const oldAccount = await begin();
  fixture.account({ account: { type: 'chatgpt', email: 'second@example.invalid', planType: 'same-plan' }, requiresOpenaiAuth: true });
  await client.start({ refresh: true });
  assert.equal(client.threads.has(oldAccount.state.threadId), true, 'refresh leaves an active turn running');
  assert.equal(client.status().models[0].access.state, 'unverified'); complete(oldAccount.state); await oldAccount.work;
  assert.equal(client.status().models[0].access.state, 'unverified', 'old-account completion does not verify the new account');
  const current = await begin(); complete(current.state); await current.work; assert.equal(client.status().models[0].access.state, 'accepted');
  const pending = await begin(), rejected = assert.rejects(pending.work, { code: 'CODEX_DISCONNECTED' });
  client._connectionFailed(Object.assign(new Error('Fixture disconnected.'), { code: 'CODEX_DISCONNECTED' }), client.child); await rejected;
  assert.deepEqual(client.status().modelAccess, {}); assert.equal(client.status().models[0].access.state, 'unverified');
  assert.doesNotMatch(JSON.stringify(client.status()), /first@example|second@example|accountSignature/);
});

test('native model capability metadata retains every paginated model and only reported safe detail fields', async t => {
  const fixture = passiveNativeFixture(t), { client, requests } = fixture;
  const models = Array.from({ length: 252 }, (_, index) => catalogModel(`detail-${index}`, { hidden: index % 2 === 0 }));
  models[0].contextWindowTokens = { secret: 'never-copy-me' };
  models[251] = catalogModel('detailed-wire', { id: 'detailed-picker', hidden: true, serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Reported speed.', privateToken: 'never-copy-me' }], defaultServiceTier: 'priority', additionalSpeedTiers: ['priority'], availableAccessPrograms: { cyber: ['standard'], token: 'never-copy-me' }, upgrade: 'next-model', upgradeInfo: { model: 'next-model', upgradeCopy: 'Upgrade notice.', modelLink: 'https://example.invalid/model', migrationMarkdown: 'Reported **migration**.', retirementAt: 123, token: 'never-copy-me' }, multiAgentVersion: 'v2', modelSpecialty: 'coding', supportsPersonality: false, inputModalities: ['text', 'image', null, '<script>'], availabilityNux: { message: 'Informational only.', secret: 'never-copy-me' }, otherSecret: 'never-copy-me' });
  fixture.models(models); const result = await client.start({ refresh: true });
  assert.equal(result.models.length, 252); assert.equal(requests.filter(request => request.method === 'model/list').length, 3);
  assert.ok(requests.filter(request => request.method === 'model/list').every(request => request.params.includeHidden));
  const last = result.models.at(-1); assert.equal(result.models[0].contextWindowTokens, undefined); assert.deepEqual(last.serviceTiers, [{ id: 'priority', name: 'Priority', description: 'Reported speed.' }]); assert.equal(last.defaultServiceTier, 'priority');
  assert.deepEqual(last.availableAccessPrograms, { cyber: ['standard'] }); assert.equal(last.upgradeInfo.migrationMarkdown, 'Reported **migration**.'); assert.equal(last.multiAgentVersion, 'v2'); assert.equal(last.modelSpecialty, 'coding');
  assert.deepEqual(last.inputModalities, ['text', 'image']); assert.equal(last.access.state, 'unverified'); assert.equal(last.source, 'advertised');
  assert.doesNotMatch(JSON.stringify(result), /never-copy-me|otherSecret|privateToken/);
});
function nextCatalogRead(client, replacement) {
  const entered = deferred(), request = client._request;
  client._request = function (method, ...args) {
    if (method === 'model/list') {
      client._request = request;
      entered.resolve();
      if (replacement) return replacement.promise;
    }
    return request.call(this, method, ...args);
  };
  return entered.promise;
}

test('native user-agent reports its CLI version and initialization advertises the current app', async t => {
  const { client, requests } = recordedRuntime(t, { args: [fixture, '--native-user-agent'] });
  const status = await client.start();
  assert.equal(status.version, '0.163.0');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(requests.find(request => request.method === 'initialize').params.clientInfo, { name: 'blackice', title: 'BLACKICE', version });
  assert.equal(status.modelCatalog.hiddenModelsIncluded, true);
  assert.equal(status.modelCatalog.stale, false);
  assert.ok(Date.parse(status.modelCatalog.updatedAt));
});

test('native agent turns identify BLACKICE and receive its instructions without requesting attestation', async t => {
  const { client, requests } = recordedRuntime(t);
  await client.runAgent({ cwd, prompt: 'A harmless local fixture.', developerInstructions: BLACKICE_HARNESS_INSTRUCTIONS });
  const started = requests.find(request => request.method === 'thread/start').params;
  assert.equal(started.serviceName, 'blackice');
  assert.equal(started.developerInstructions, BLACKICE_HARNESS_INSTRUCTIONS);
  assert.equal(requests.find(request => request.method === 'initialize').params.capabilities.requestAttestation, false);
});

test('native discovery includes hidden models on every page and retains safe informational metadata', async t => {
  const { client, requests } = recordedRuntime(t);
  await client.start(); const child = client.child;
  const models = Array.from({ length: 251 }, (_, index) => catalogModel(`model-${index}`, { hidden: index % 100 === 0 }));
  models[250] = catalogModel('final-hidden', { hidden: true, inputModalities: ['text', 'image', null, { unsafe: true }, '<script>'], availabilityNux: { message: 'Optional plan information, not an access verdict.', privateField: 'discard' }, availableAccessPrograms: [{ id: 'not-an-availability-flag' }] });
  await client._request('fixture/catalog', { models });
  const offset = requests.length, status = await client.start({ refresh: true });
  const pages = requests.slice(offset).filter(request => request.method === 'model/list');
  assert.equal(pages.length, 3); assert.ok(pages.every(request => request.params.includeHidden === true && request.params.limit === 100));
  assert.deepEqual(pages.map(request => request.params.cursor), [undefined, '100', '200']);
  assert.equal(status.models.length, 251); assert.equal(status.models.at(-1).hidden, true);
  assert.deepEqual(status.models.at(-1).inputModalities, ['text', 'image']);
  assert.deepEqual(status.models.at(-1).availabilityNux, { message: 'Optional plan information, not an access verdict.' });
  assert.equal(status.models.at(-1).availableAccessPrograms, undefined);
  assert.equal(status.defaultModel, 'model-1', 'automatic fallback skips the first hidden row');
  assert.equal(client.child, child); assert.equal(requests.filter(request => request.method === 'initialize').length, 1);
  await client._request('fixture/catalog', { models: [catalogModel('hidden-only', { hidden: true })] });
  assert.equal((await client.start({ refresh: true })).defaultModel, null, 'an all-hidden catalog requires an explicit choice or endpoint default');
  await assert.rejects(client.runAgent({ cwd, prompt: 'Require a model choice.' }), { code: 'CODEX_MODEL_REQUIRED' });
  assert.equal(requests.some(request => request.method === 'thread/start'), false, 'no implicit server fallback starts a turn');
  await client._request('fixture/catalog', { models: [catalogModel('hidden-default', { hidden: true, isDefault: true })] });
  assert.equal((await client.start({ refresh: true })).defaultModel, 'hidden-default', 'an explicit endpoint default remains authoritative');
});

test('concurrent reconnects share one catalog refresh and leave an active native turn intact', async t => {
  const { client, requests } = recordedRuntime(t), started = deferred();
  const work = client.runAgent({ cwd, prompt: 'WAIT_FOR_STEER', onEvent: event => { if (event.type === 'turn' && event.status === 'inProgress') started.resolve(event); } });
  const active = await started.promise, child = client.child, state = client.threads.get(active.threadId);
  await client._request('fixture/catalog', { models: [catalogModel('new-model', { isDefault: true })], account: { account: { type: 'chatgpt', planType: 'updated', email: 'never-publish@example.invalid' }, requiresOpenaiAuth: true }, hold: true });
  const offset = requests.length, entered = nextCatalogRead(client), first = client.start({ refresh: true });
  await entered;
  const second = client.start({ refresh: true });
  const cached = await client.start();
  assert.equal(cached.modelCatalog.refreshing, true); assert.equal(cached.models[0].model, 'fixture-model');
  assert.equal(client.threads.get(active.threadId), state);
  await client._request('fixture/releaseCatalog');
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.models[0].model, 'new-model'); assert.deepEqual(two, one);
  assert.deepEqual(one.account, { type: 'chatgpt', planType: 'updated' });
  assert.equal(requests.slice(offset).filter(request => request.method === 'account/read').length, 1);
  assert.equal(requests.slice(offset).filter(request => request.method === 'model/list').length, 1);
  assert.equal(client.child, child); assert.equal(client.status().activeTurns, 1);
  await client.steerAgent(active.threadId, 'Finish after refreshing models.');
  assert.equal((await work).turnId, active.turnId);
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
});

test('catalog failures keep the last good models and default and report a retryable refresh error', async t => {
  const { client, requests } = recordedRuntime(t); const previous = await client.start(), child = client.child;
  await client._request('fixture/catalog', { account: { account: { type: 'chatgpt', planType: 'latest-account' }, requiresOpenaiAuth: true }, error: { code: -32000, message: 'Model service failed while includeHidden was true.' } });
  const offset = requests.length;
  await assert.rejects(client.start({ refresh: true }), /Model service failed/);
  const failed = client.status();
  assert.equal(failed.connected, true); assert.equal(client.child, child);
  assert.deepEqual(failed.models, previous.models); assert.equal(failed.account.planType, 'latest-account'); assert.equal(failed.defaultModel, previous.defaultModel);
  assert.equal(failed.modelCatalog.updatedAt, previous.modelCatalog.updatedAt);
  assert.equal(failed.modelCatalog.refreshing, false); assert.equal(failed.modelCatalog.stale, true); assert.match(failed.modelCatalog.error, /Model service failed/);
  assert.equal(failed.modelCatalog.hiddenModelsIncluded, true, 'this describes the retained successful snapshot');
  assert.equal(requests.slice(offset).filter(request => request.method === 'model/list').length, 1, 'generic failures do not silently fall back');
  await client._request('fixture/catalog', { error: null, models: [catalogModel('recovered', { isDefault: true })] });
  const recovered = await client.start({ refresh: true });
  assert.equal(recovered.models[0].model, 'recovered'); assert.equal(recovered.modelCatalog.error, null); assert.equal(recovered.modelCatalog.stale, false);
});

test('a successful sign-out read blocks new turns even when the accompanying catalog read fails', async t => {
  const client = runtime(t), previous = await client.start();
  await client._request('fixture/catalog', { account: { account: null, requiresOpenaiAuth: true }, error: { code: -32000, message: 'Catalog requires sign-in.' } });
  await assert.rejects(client.start({ refresh: true }), /Catalog requires sign-in/);
  const status = client.status();
  assert.equal(status.connected, true); assert.equal(status.authenticated, false); assert.equal(status.account, null);
  assert.deepEqual(status.models, previous.models); assert.equal(status.modelCatalog.stale, true);
  await assert.rejects(client.runAgent({ cwd, prompt: 'Must not start signed out.' }), { code: 'CODEX_UNAUTHENTICATED' });
});

test('an account change refreshes models and invalidates an in-flight snapshot without restarting turns', async t => {
  const { client, requests } = recordedRuntime(t); await client.start(); const child = client.child, snapshots = [];
  client.on('status', status => snapshots.push(status));
  await client._request('fixture/catalog', { models: [catalogModel('outdated')], hold: true });
  const entered = nextCatalogRead(client), refreshed = client.start({ refresh: true }); await entered;
  await client._request('fixture/catalog', { models: [catalogModel('new-account-model', { isDefault: true })], account: { account: { type: 'chatgpt', planType: 'changed' }, requiresOpenaiAuth: true }, notify: true });
  await client._request('fixture/releaseCatalog');
  const status = await refreshed;
  assert.equal(status.models[0].model, 'new-account-model'); assert.equal(status.account.planType, 'changed');
  assert.equal(snapshots.some(snapshot => snapshot.models[0]?.model === 'outdated'), false);
  assert.equal(client.child, child); assert.equal(requests.filter(request => request.method === 'initialize').length, 1);
  const background = deferred();
  client.on('status', snapshot => { if (snapshot.models[0]?.model === 'notification-only' && !snapshot.modelCatalog.refreshing) background.resolve(snapshot); });
  await client._request('fixture/catalog', { models: [catalogModel('notification-only')], notify: true });
  assert.equal((await background.promise).modelCatalog.stale, false, 'account notifications also refresh without a manual reconnect');
});

test('late catalog pages from a disconnected child cannot publish or read pages through its replacement', async t => {
  const { client, requests } = recordedRuntime(t); await client.start();
  const child = client.child, oldPage = deferred(), entered = nextCatalogRead(client, oldPage);
  const refresh = client.start({ refresh: true }), rejected = assert.rejects(refresh, { code: 'CODEX_DISCONNECTED' }); await entered;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  assert.equal(client.status().modelCatalog.refreshing, false); assert.equal(client.status().modelCatalog.stale, true);
  const replacement = await client.start(); assert.notEqual(client.child, child);
  oldPage.resolve({ data: [catalogModel('obsolete')], nextCursor: 'obsolete-next-page' });
  await rejected;
  assert.deepEqual(client.status().models, replacement.models); assert.equal(client.status().modelCatalog.stale, false);
  assert.equal(requests.some(request => request.params.cursor === 'obsolete-next-page'), false);
});

test('only an explicit unsupported includeHidden parameter permits a complete legacy catalog fallback', async t => {
  const { client, requests } = recordedRuntime(t); await client.start();
  const models = Array.from({ length: 251 }, (_, index) => catalogModel(`legacy-${index}`, { hidden: index % 2 === 0 }));
  await client._request('fixture/catalog', { models, unsupportedHidden: true });
  const offset = requests.length, legacy = await client.start({ refresh: true });
  const pages = requests.slice(offset).filter(request => request.method === 'model/list');
  assert.equal(pages.length, 3); assert.equal(pages[0].params.includeHidden, true);
  assert.ok(pages.slice(1).every(request => !Object.hasOwn(request.params, 'includeHidden')));
  assert.equal(legacy.models.length, 125); assert.ok(legacy.models.every(model => !model.hidden));
  assert.equal(legacy.modelCatalog.hiddenModelsIncluded, false); assert.equal(legacy.modelCatalog.error, null);
  await client._request('fixture/catalog', { unsupportedHidden: false });
  const full = await client.start({ refresh: true });
  assert.equal(full.models.length, 251); assert.equal(full.modelCatalog.hiddenModelsIncluded, true);
});

test('malformed or repeated model pages reject the whole catalog instead of silently dropping data', async t => {
  const client = runtime(t); let calls = 0;
  client._request = async () => { calls++; return { data: [catalogModel('duplicate')], nextCursor: 'same' }; };
  await assert.rejects(client._catalog(), /repeated model catalog cursor/); assert.equal(calls, 2);
  client._request = async () => ({ nextCursor: null });
  await assert.rejects(client._catalog(), { code: 'CODEX_CATALOG_INVALID' });
});

test('native catalog aliases resolve to the canonical model on actual thread and turn requests', async t => {
  const { client, requests } = recordedRuntime(t); await client.start();
  await client._request('fixture/catalog', { models: [catalogModel('picker-alias', { model: 'wire-model', hidden: true, isDefault: true })] });
  await client.start({ refresh: true });
  const first = await client.runAgent({ cwd, prompt: 'Use the alias.', model: 'picker-alias' });
  await client.runAgent({ cwd, prompt: 'Keep the same alias.', threadId: first.threadId, model: 'picker-alias' });
  const starts = requests.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method));
  assert.equal(starts.length, 4); assert.ok(starts.every(request => request.params.model === 'wire-model'));
  assert.equal(client.status().models[0].hidden, true, 'hidden labels do not prohibit an explicit model choice');
});

test('streams agent output and usage into the completed result', async t => {
  const client = runtime(t);
  const events = [];
  const result = await client.runAgent({ cwd, prompt: 'hello fixture', effort: 'medium', onEvent: event => events.push(event) });
  assert.equal(result.output, 'Fixture result for hello fixture');
  assert.match(result.threadId, /^fixture-thread-/);
  assert.match(result.turnId, /^fixture-turn-/);
  assert.equal(result.usage.totalTokens, 20);
  assert.ok(events.some(event => event.type === 'delta' && event.delta.includes('hello fixture')));
  assert.ok(events.some(event => event.type === 'usage' && event.usage.totalTokens === 20));
  assert.equal(client.status().activeTurns, 0);
});

test('advertised max and ultra reasoning reach the real turn RPC and report the selected effort', async t => {
  const { client, requests } = recordedRuntime(t, { args: [fixture, '--reasoning-levels'] });
  for (const effort of ['max', 'ultra']) {
    const events = [];
    const result = await client.runAgent({ cwd, prompt: `Use precisely ${effort}.`, effort, onEvent: event => events.push(event) });
    const turn = requests.filter(request => request.method === 'turn/start').at(-1);
    assert.equal(turn.params.effort, effort); assert.equal(turn.params.threadId, result.threadId);
    assert.equal(result.effort, effort);
    const thread = events.find(event => event.type === 'thread');
    assert.equal(thread.effort, effort); assert.equal(thread.requestedEffort, effort);
  }
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 2, 'neither effort choice causes a hidden retry or downgrade');
});

test('native continuation inherits ultra until an explicit model-default reset clears the saved setting', async t => {
  const { client, requests } = recordedRuntime(t, { args: [fixture, '--reasoning-levels'] });
  const first = await client.runAgent({ cwd, prompt: 'Start with ultra.', effort: 'ultra' });
  const inherited = await client.runAgent({ cwd, prompt: 'Keep this conversation’s effort.', threadId: first.threadId });
  assert.equal(inherited.effort, 'ultra');
  const events = [];
  const reset = await client.runAgent({ cwd, prompt: 'Reset to the model default.', threadId: first.threadId, effort: 'default', onEvent: event => events.push(event) });
  assert.equal(reset.threadId, first.threadId); assert.equal(reset.effort, 'medium');
  const resumes = requests.filter(request => request.method === 'thread/resume');
  assert.equal(resumes.at(-1).params.config.model_reasoning_effort, null);
  const event = events.find(item => item.type === 'thread'); assert.equal(event.effort, 'medium'); assert.equal(event.requestedEffort, 'default');
  const next = await client.runAgent({ cwd, prompt: 'Continue after resetting.', threadId: first.threadId });
  assert.equal(next.effort, 'medium');
  assert.deepEqual(requests.filter(request => request.method === 'turn/start').map(request => request.params.effort), ['ultra', 'ultra', 'medium', 'medium']);
});

test('a reasoning level missing from the native catalog rejects before any thread or turn is created', async t => {
  const { client, requests } = recordedRuntime(t);
  await assert.rejects(client.runAgent({ cwd, prompt: 'Do not downgrade ultra.', effort: 'ultra' }), error => error.code === 'INVALID_EFFORT' && /not supported by fixture-model/.test(error.message));
  assert.ok(requests.some(request => request.method === 'model/list'));
  assert.equal(requests.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)), false);
  assert.equal(client.status().activeTurns, 0);
});

test('an unknown reasoning level rejects before Codex is spawned', async t => {
  let spawned = false;
  const client = runtime(t, { spawnImpl: () => { spawned = true; throw new Error('Unexpected spawn'); } });
  await assert.rejects(client.runAgent({ cwd, prompt: 'Do not send an unknown setting.', effort: 'ultra-plus' }), { code: 'INVALID_EFFORT' });
  assert.equal(spawned, false);
});

test('multiplexed agent runs keep thread results separate', async t => {
  const client = runtime(t);
  const [alpha, beta] = await Promise.all([
    client.runAgent({ cwd, prompt: 'alpha-only' }),
    client.runAgent({ cwd, prompt: 'beta-only' }),
  ]);
  assert.match(alpha.output, /alpha-only/);
  assert.equal(alpha.output.includes('beta-only'), false);
  assert.match(beta.output, /beta-only/);
  assert.equal(beta.output.includes('alpha-only'), false);
  assert.notEqual(alpha.threadId, beta.threadId);
});

test('Relay-only Codex work creates a confirmed ephemeral session and preserves only the returned context',async t=>{
  const{client,requests}=recordedRuntime(t),events=[];
  const result=await client.runAgent({cwd,prompt:'Relay-only task',codexHistory:'relay',onEvent:event=>events.push(event)});
  assert.equal(result.codexHistory,'relay');assert.match(result.output,/Relay-only task/);assert.ok(result.context);assert.equal(client.contexts.has(result.threadId),false,'completed private sessions do not accumulate native context state');
  const start=requests.find(item=>item.method==='thread/start');assert.equal(start.params.ephemeral,true);assert.equal(events.find(event=>event.type==='thread').codexHistory,'relay');assert.equal(events.find(event=>event.type==='thread').resumed,false);
  assert.equal(requests.filter(item=>item.method==='turn/start').length,1);assert.ok(requests.some(item=>item.method==='thread/unsubscribe'&&item.params.threadId===result.threadId));assert.ok(!requests.some(item=>['thread/archive','thread/delete'].includes(item.method)));
  await assert.rejects(client.runAgent({cwd,prompt:'READ_PRIOR',threadId:result.threadId}),/not found/,'the fixture discards ephemeral sessions when unsubscribed');
});

test('persistent native history remains the library default and retains same-thread continuation',async t=>{
  const{client,requests}=recordedRuntime(t),events=[];
  const first=await client.runAgent({cwd,prompt:'Persistent by library default',onEvent:event=>events.push(event)});
  assert.equal(first.codexHistory,'codex');assert.equal(client.contexts.has(first.threadId),true);assert.equal(events.find(event=>event.type==='thread').codexHistory,'codex');assert.equal(Object.hasOwn(requests.find(item=>item.method==='thread/start').params,'ephemeral'),false);
  const second=await client.runAgent({cwd,prompt:'READ_PRIOR',threadId:first.threadId,codexHistory:'codex'});assert.equal(second.threadId,first.threadId);assert.match(second.output,/Persistent by library default/);assert.ok(requests.some(item=>item.method==='thread/resume'));assert.ok(!requests.some(item=>['thread/archive','thread/delete'].includes(item.method)));
});

test('parallel Relay-only and persistent chats retain their own visibility, events and cache lifetime',async t=>{
  const{client,requests}=recordedRuntime(t),privateEvents=[],persistentEvents=[],privateStarted=deferred(),persistentStarted=deferred();
  const privateWork=client.runAgent({cwd,prompt:'WAIT_FOR_STEER private',codexHistory:'relay',onEvent:event=>{privateEvents.push(event);if(event.type==='turn'&&event.status==='inProgress')privateStarted.resolve(event);}});
  const persistentWork=client.runAgent({cwd,prompt:'WAIT_FOR_STEER persistent',codexHistory:'codex',onEvent:event=>{persistentEvents.push(event);if(event.type==='turn'&&event.status==='inProgress')persistentStarted.resolve(event);}});
  privateWork.catch(()=>{});persistentWork.catch(()=>{});const[privateTurn,persistentTurn]=await Promise.all([privateStarted.promise,persistentStarted.promise]);assert.notEqual(privateTurn.threadId,persistentTurn.threadId);assert.equal(client.status().activeTurns,2);
  await client.steerAgent(privateTurn.threadId,'private result');const privateResult=await privateWork;assert.equal(privateResult.codexHistory,'relay');assert.equal(client.contexts.has(privateTurn.threadId),false);assert.equal(client.contexts.has(persistentTurn.threadId),true);assert.equal(client.status().activeTurns,1);
  await client.steerAgent(persistentTurn.threadId,'persistent result');const persistentResult=await persistentWork;assert.equal(persistentResult.codexHistory,'codex');assert.equal(client.contexts.has(persistentTurn.threadId),true);assert.ok(privateEvents.every(event=>event.threadId===privateTurn.threadId));assert.ok(persistentEvents.every(event=>event.threadId===persistentTurn.threadId));assert.match(privateResult.output,/private result/);assert.doesNotMatch(privateResult.output,/persistent result/);assert.match(persistentResult.output,/persistent result/);
  assert.deepEqual(requests.filter(item=>item.method==='thread/start').map(item=>item.params.ephemeral),[true,undefined]);
});

test('private native history rejects resume and invalid visibility before spawning or starting work',async t=>{
  let spawned=false;const client=runtime(t,{spawnImpl:()=>{spawned=true;throw new Error('Unexpected spawn');}});
  await assert.rejects(client.runAgent({cwd,prompt:'Must not resume',threadId:'persistent-thread',codexHistory:'relay'}),{code:'CODEX_HISTORY_RESUME'});
  for(const codexHistory of ['private',null,true,{}])await assert.rejects(client.runAgent({cwd,prompt:'Invalid mode',codexHistory}),{code:'INVALID_CODEX_HISTORY'});
  assert.equal(spawned,false);
});

for(const flag of ['--no-ephemeral','--omit-ephemeral'])test(`Relay-only history fails closed when Codex does not explicitly confirm ephemeral support (${flag})`,async t=>{
  const{client,requests}=recordedRuntime(t,{args:[fixture,flag]});
  await assert.rejects(client.runAgent({cwd,prompt:'Do not start this private task',codexHistory:'relay'}),error=>error.code==='CODEX_HISTORY_UNSUPPORTED'&&/No agent turn was started/.test(error.message));
  assert.equal(requests.filter(item=>item.method==='thread/start').length,1);assert.equal(requests.some(item=>item.method==='turn/start'),false);assert.equal(requests.some(item=>item.method==='thread/resume'),false);assert.equal(client.contexts.size,0);assert.equal(client.status().activeTurns,0);assert.ok(requests.some(item=>item.method==='thread/unsubscribe'));assert.ok(!requests.some(item=>['thread/archive','thread/delete'].includes(item.method)));
});

test('failed, cancelled and disconnected private turns clear native context without disturbing persistent sessions',async t=>{
  const{client,requests}=recordedRuntime(t);const persistent=await client.runAgent({cwd,prompt:'Keep persistent context'});
  await assert.rejects(client.runAgent({cwd,prompt:'FAIL_TURN',codexHistory:'relay'}),/Deliberate fixture failure/);assert.equal(client.contexts.size,1);assert.equal(client.contexts.has(persistent.threadId),true);
  const controller=new AbortController(),started=deferred();let privateId;
  const cancelled=client.runAgent({cwd,prompt:'WAIT_FOR_CANCEL',codexHistory:'relay',signal:controller.signal,onEvent:event=>{if(event.type==='thread')privateId=event.threadId;if(event.type==='turn'&&event.status==='inProgress')started.resolve();}});cancelled.catch(()=>{});await started.promise;assert.equal(client.contexts.has(privateId),true);controller.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(client.contexts.has(privateId),false);assert.equal(client.contexts.has(persistent.threadId),true);
  const disconnected=deferred();const failed=client.runAgent({cwd,prompt:'WAIT_FOR_CANCEL',codexHistory:'relay',onEvent:event=>{if(event.type==='turn'&&event.status==='inProgress')disconnected.resolve();}});failed.catch(()=>{});await disconnected.promise;client.child.kill();await assert.rejects(failed,{code:'CODEX_DISCONNECTED'});assert.equal(client.contexts.size,1);assert.ok(!requests.some(item=>['thread/archive','thread/delete'].includes(item.method)));
});

test('continuation resumes the same conversation and reports only new usage', async t => {
  const client = runtime(t);
  const first = await client.runAgent({ cwd, prompt: 'Remember the project code ORBIT-73.' });
  const events = [];
  const second = await client.runAgent({ cwd, prompt: 'READ_PRIOR', threadId: first.threadId, usageBaseline: first.usage.total, onEvent: event => events.push(event) });
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(second.output, 'Earlier message: Remember the project code ORBIT-73.');
  assert.equal(second.usage.totalTokens, 20);
  assert.equal(second.usage.total.totalTokens, 40);
  assert.equal(events.find(event => event.type === 'thread').resumed, true);
  await assert.rejects(client.runAgent({ cwd, prompt: 'hello', threadId: 'missing-thread' }), /not found/);
});

test('one saved conversation cannot receive overlapping turns and invalid IDs never start a turn', async t => {
  const client = runtime(t);
  await assert.rejects(client.runAgent({ cwd, prompt: 'hello', threadId: '../invalid' }), { code: 'INVALID_THREAD' });
  const first = await client.runAgent({ cwd, prompt: 'initial' });
  const controller = new AbortController();
  const working = client.runAgent({ cwd, prompt: 'WAIT_FOR_CANCEL', threadId: first.threadId, signal: controller.signal });
  working.catch(() => {});
  while (!client.threads.has(first.threadId)) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(client.runAgent({ cwd, prompt: 'conflicting', threadId: first.threadId }), { code: 'THREAD_BUSY' });
  controller.abort();
  await assert.rejects(working, { name: 'AbortError' });
});

test('live direction is acknowledged by the existing turn and never starts another conversation', async t => {
  const client = runtime(t);
  const events = [];
  const working = client.runAgent({ cwd, prompt: 'WAIT_FOR_STEER', onEvent: event => events.push(event) });
  while (!events.some(event => event.type === 'turn' && event.turnId)) await new Promise(resolve => setTimeout(resolve, 5));
  const active = events.find(event => event.type === 'turn' && event.turnId);
  const receipt = await client.steerAgent(active.threadId, 'Use the corrected project name.');
  assert.deepEqual(receipt, { accepted: true, threadId: active.threadId, turnId: active.turnId });
  const result = await working;
  assert.equal(result.threadId, active.threadId);
  assert.equal(result.turnId, active.turnId);
  assert.equal(result.output, 'Direction received: Use the corrected project name.');
  await assert.rejects(client.steerAgent(active.threadId, 'too late'), { code: 'TURN_NOT_ACTIVE' });
});

test('legacy command requests execute without calling a permission callback', async t => {
  const client = runtime(t); let callbacks = 0;
  const result = await client.runAgent({
    cwd, prompt: 'REQUEST_APPROVAL',
    onApproval: async () => { callbacks++; return { decision: 'decline' }; },
  });
  assert.equal(callbacks, 0);
  assert.equal(result.output, 'Approval decision: "accept"');
});

test('legacy command requests are accepted when no permission callback exists', async t => {
  const client = runtime(t);
  const result = await client.runAgent({ cwd, prompt: 'REQUEST_APPROVAL' });
  assert.equal(result.output, 'Approval decision: "accept"');
});

test('stale turn requests are rejected while the matching active turn executes directly', async t => {
  const client = runtime(t);
  const requests = [];
  const result = await client.runAgent({
    cwd, prompt: 'STALE_THEN_APPROVAL',
    onApproval: async request => { requests.push(request); return { decision: 'accept' }; },
  });
  assert.equal(requests.length, 0, 'neither stale nor current requests invoke a permission callback');
  assert.equal(result.output, 'Approval decision: "accept"');
});

test('legacy question requests return empty answers without blocking execution', async t => {
  const client = runtime(t);
  let callbacks = 0;
  const result = await client.runAgent({
    cwd, prompt: 'REQUEST_USER_INPUT',
    onApproval: async () => { callbacks++; return { decision: 'accept', answers: { direction: { answers: ['Inspect'] } } }; },
  });
  assert.equal(callbacks, 0);
  assert.deepEqual(JSON.parse(result.output), { answers: {} });
});

test('legacy additional permission requests execute directly within their current turn', async t => {
  const client = runtime(t); let callbacks = 0;
  const result = await client.runAgent({
    cwd, prompt: 'REQUEST_PERMISSIONS',
    onApproval: async () => { callbacks++; return { decision: 'decline' }; },
  });
  assert.equal(callbacks, 0);
  assert.deepEqual(JSON.parse(result.output), { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('new Codex sessions preserve writable defaults and honor declared read-only execution without asking', async t => {
  const sent = []; let callbacks = 0;
  const client = runtime(t, { spawnImpl: (...args) => {
    const child = spawn(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...options) => { sent.push(JSON.parse(String(data))); return write(data, ...options); };
    return child;
  } });
  const onApproval = async () => { callbacks++; return { decision: 'accept' }; };
  const writable = await client.runAgent({ cwd, prompt: 'REQUEST_APPROVAL with default writable execution', onApproval });
  const readOnly = await client.runAgent({ cwd, prompt: 'REQUEST_APPROVAL with declared read-only execution', sandbox: 'read-only', onApproval });
  assert.equal(writable.output, 'Approval decision: "accept"');
  assert.equal(readOnly.output, 'Approval decision: "decline"');
  assert.equal(callbacks, 0);
  const starts = sent.filter(message => message.method === 'thread/start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map(message => message.params.sandbox), ['danger-full-access', 'read-only']);
  for (const { params } of starts) {
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.approvalsReviewer, undefined);
  }
});

test('legacy file requests execute only for active matching turns with explicit full access', async () => {
  const client = new CodexRuntime(); const sent = [];
  client._send = message => sent.push(message);
  client.threads.set('active', { turnId: 'current', done: false, sandbox: 'danger-full-access' });
  client.threads.set('read-only', { turnId: 'current', done: false, sandbox: 'read-only' });
  client.threads.set('workspace-write', { turnId: 'current', done: false, sandbox: 'workspace-write' });
  client.threads.set('unknown', { turnId: 'current', done: false });
  client.threads.set('cancelled', { turnId: 'current', done: false, sandbox: 'danger-full-access', cancelError: new Error('Cancelled') });
  client.threads.set('completed', { turnId: 'current', done: true, sandbox: 'danger-full-access' });
  for (const [threadId, turnId, expected] of [
    ['active', 'current', 'accept'], ['active', 'stale', 'decline'],
    ['read-only', 'current', 'decline'], ['workspace-write', 'current', 'decline'], ['unknown', 'current', 'decline'],
    ['cancelled', 'current', 'decline'], ['completed', 'current', 'decline'],
    ['missing', 'current', 'decline'],
  ]) {
    await client._serverRequest({ id: `${threadId}-${turnId}`, method: 'item/fileChange/requestApproval', params: { threadId, turnId } });
    assert.equal(sent.at(-1).result.decision, expected);
    assert.equal(sent.at(-1).id, `${threadId}-${turnId}`);
  }
});

test('cancelled active turn sends interrupt and rejects with AbortError', async t => {
  const client = runtime(t);
  const controller = new AbortController();
  const started = deferred();
  const run = client.runAgent({
    cwd, prompt: 'WAIT_FOR_CANCEL', signal: controller.signal,
    onEvent: event => { if (event.type === 'turn' && event.status === 'inProgress') started.resolve(); },
  });
  await started.promise;
  controller.abort();
  await assert.rejects(run, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.equal(client.status().activeTurns, 0);
  assert.equal(client.status().connected, true, 'confirmed interruption preserves the runtime connection');
});

test('failed Codex turn rejects with the server error', async t => {
  const client = runtime(t);
  await assert.rejects(client.runAgent({ cwd, prompt: 'FAIL_TURN' }), /Deliberate fixture failure/);
  assert.equal(client.status().activeTurns, 0);
});

test('bounded run timeout interrupts a non-completing turn', async t => {
  const client = runtime(t);
  await assert.rejects(client.runAgent({ cwd, prompt: 'WAIT_FOR_CANCEL', timeoutMs: 50 }), error => error.code === 'CODEX_RUN_TIMEOUT');
  assert.equal(client.status().activeTurns, 0);
});

test('lost turn-start acknowledgement closes the connection to prevent an orphan agent', async t => {
  const client = runtime(t, { requestTimeoutMs: 500 });
  await assert.rejects(client.runAgent({ cwd, prompt: 'STALL_TURN_START' }), error => error.code === 'CODEX_TIMEOUT');
  assert.equal(client.status().activeTurns, 0);
  assert.equal(client.status().connected, false);
});

test('invalid prompts and relative workspaces fail before spawning Codex', async t => {
  let spawned = false;
  const client = runtime(t, { spawnImpl: () => { spawned = true; throw new Error('Should never spawn'); } });
  await assert.rejects(client.runAgent({ cwd, prompt: '' }), error => error.code === 'INVALID_PROMPT');
  await assert.rejects(client.runAgent({ cwd: 'relative', prompt: 'hello' }), error => error.code === 'INVALID_WORKSPACE');
  assert.equal(spawned, false);
});

// Every request in this fixture is an injected handshake or catalog response.
// No process, network request, thread or provider turn is started.
function deferredConnectionFixture(t) {
  const gates = Object.fromEntries(['initialize', 'account/read', 'model/list'].map(method => [method, { ...heldConnectionResponse(), entered: deferred() }]));
  const requests = [], stages = [], children = [];
  const client = new CodexRuntime({ command: process.execPath, cwd, spawnImpl() {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.once('finish', () => setImmediate(() => child.emit('exit', 0)));
    child.kill = () => { child.killed = true; }; children.push(child); return child;
  } });
  client._send = () => {};
  client._request = async method => { requests.push(method); const gate = gates[method]; assert.ok(gate, 'Only connection metadata may be requested.'); gate.entered.resolve(); return gate.promise; };
  client.on('status', value => stages.push(value.connection.phase));
  t.after(() => { client.closing = true; client._connectionFailed(Error('Fixture closed.'), client.child); });
  return { client, gates, requests, stages, children };
}
function heldConnectionResponse() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const connectionAccount = { account: { type: 'chatgpt', planType: 'fixture', email: 'never-publish@example.invalid' }, requiresOpenaiAuth: true };
const connectionModels = { data: [catalogModel('metadata-only-model', { isDefault: true })], nextCursor: null };

test('connection stages are observable before deferred initialize, account and catalog reads complete', async t => {
  const { client, gates, requests, stages, children } = deferredConnectionFixture(t);
  const first = client.start(); assert.equal(client.status().connection.phase, 'starting');
  const second = client.start(); await gates.initialize.entered.promise;
  assert.equal(client.status().connection.phase, 'initializing'); assert.equal(client.status().connected, false); assert.equal(children.length, 1);
  gates.initialize.resolve({ userAgent: 'fixture/1.0.0' }); await Promise.all([gates['account/read'].entered.promise, gates['model/list'].entered.promise]);
  assert.equal(client.status().connection.phase, 'reading-account-and-models');
  gates['account/read'].resolve(connectionAccount); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.status().connection.phase, 'reading-account-and-models', 'one pending metadata request keeps progress visible');
  gates['model/list'].resolve(connectionModels); const [one, two] = await Promise.all([first, second]);
  assert.equal(one.connection.phase, 'ready'); assert.deepEqual(two, one); assert.equal(one.activeTurns, 0);
  assert.deepEqual(stages, ['starting', 'initializing', 'reading-account-and-models', 'ready']);
  assert.ok(Date.parse(one.connection.startedAt)); assert.ok(Date.parse(one.connection.updatedAt));
  assert.deepEqual(requests, ['initialize', 'account/read', 'model/list']); assert.equal(JSON.stringify(one).includes('never-publish'), false);
});

for (const failingMethod of ['initialize', 'account/read', 'model/list']) test(`${failingMethod} failure ends connection progress without starting model work`, async t => {
  const { client, gates, requests } = deferredConnectionFixture(t), pending = client.start(); pending.catch(() => {});
  await gates.initialize.entered.promise;
  if (failingMethod === 'initialize') gates.initialize.reject(Error('Fixture initialize refused.'));
  else {
    gates.initialize.resolve({}); await Promise.all([gates['account/read'].entered.promise, gates['model/list'].entered.promise]);
    gates['account/read'][failingMethod === 'account/read' ? 'reject' : 'resolve'](failingMethod === 'account/read' ? Error('Fixture account read refused.') : connectionAccount);
    gates['model/list'][failingMethod === 'model/list' ? 'reject' : 'resolve'](failingMethod === 'model/list' ? Error('Fixture model catalog refused.') : connectionModels);
  }
  await assert.rejects(pending, /Fixture .*refused/); const status = client.status();
  assert.equal(status.connection.phase, 'failed'); assert.equal(status.modelCatalog.refreshing, false); assert.match(status.lastError, /refused/); assert.equal(status.activeTurns, 0);
  assert.ok(requests.every(method => ['initialize', 'account/read', 'model/list'].includes(method)));
});

test('an unsigned account becomes sign-in-required after metadata completes', async t => {
  const { client, gates } = deferredConnectionFixture(t), pending = client.start(); await gates.initialize.entered.promise;
  gates.initialize.resolve({}); await gates['account/read'].entered.promise;
  gates['account/read'].resolve({ account: null, requiresOpenaiAuth: true }); gates['model/list'].resolve(connectionModels);
  const status = await pending; assert.equal(status.connected, true); assert.equal(status.authenticated, false); assert.equal(status.connection.phase, 'sign-in-required'); assert.equal(status.activeTurns, 0);
});

for (const stopAt of ['initialize', 'catalog']) test(`closing during deferred ${stopAt} cannot publish a late ready stage`, async t => {
  const { client, gates, stages, requests } = deferredConnectionFixture(t), pending = client.start(); pending.catch(() => {}); await gates.initialize.entered.promise;
  if (stopAt === 'catalog') { gates.initialize.resolve({}); await gates['account/read'].entered.promise; }
  await client.close(); assert.equal(client.status().connection.phase, 'closed');
  if (stopAt === 'initialize') gates.initialize.resolve({});
  else { gates['account/read'].resolve(connectionAccount); gates['model/list'].resolve(connectionModels); }
  await assert.rejects(pending, /disconnected/i);
  assert.equal(client.status().connection.phase, 'closed'); assert.equal(stages.includes('ready'), false);
  assert.equal(requests.some(method => /thread|turn/.test(method)), false);
});

test('a replacement child owns connection progress when an old initialization resolves late', async t => {
  const { client, gates, stages } = deferredConnectionFixture(t), pending = client.start(); pending.catch(() => {}); await gates.initialize.entered.promise;
  const oldChild = client.child, replacement = {}; client.child = replacement;
  client._connectionPhase('initializing'); const mark = stages.length; gates.initialize.resolve({});
  await assert.rejects(pending, /disconnected/i);
  assert.equal(client.child, replacement); assert.equal(client.status().connection.phase, 'initializing'); assert.equal(oldChild.killed, true); assert.deepEqual(stages.slice(mark), []);
});


test('a starting status listener can close before initialization without spawning or reviving progress', async t => {
  const { client, stages, children } = deferredConnectionFixture(t); let closing;
  client.on('status', status => { if (status.connection.phase === 'starting') closing = client.close(); });
  await assert.rejects(client.start(), { code: 'CODEX_CLOSED' }); await closing;
  assert.equal(children.length, 0); assert.equal(client.status().connection.phase, 'closed'); assert.deepEqual(stages, ['starting', 'closed']);
});
