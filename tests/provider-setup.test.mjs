import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderStore } from '../lib/provider-store.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { providerKeyTarget } from '../lib/provider-key-contract.mjs';
import { providerKeyPage, performProviderKeySource } from '../desktop/provider-key-source.mjs';
import { providerModelMetadata, zeroPricedFreeVariant } from '../lib/provider-model-metadata.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';
import { providerSetupHTTP } from '../lib/provider-setup-http.mjs';
import { DirectExecutionAPI, validDirectArguments } from '../lib/direct-execution-api.mjs';

const SECRET = 'synthetic_provider_key_for_test_only_938751';
const origin = 'https://provider.example', url = origin + '/keys';
const target = { browser: 'relay', tabId: 'tab-1', origin, expectedUrl: url };
const client = { id: 'connector-one', scopes: ['read', 'commands:run', 'browser:read', 'browser:write'] };
const owner = { taskId: 'task-1', runId: 'run-1', nodeId: 'node-1' };
const parse = result => JSON.parse(result.contentItems[0].text);
const noSecret = value => assert.equal(JSON.stringify(value).includes(SECRET), false);

function pageFixture() {
  const elements = [], document = {}, window = { origin }, context = { document, window, origin, location: { origin, href: url }, Map, WeakMap, WeakSet, Set, Math, String };
  window.top = window; window.location = context.location;
  window.getComputedStyle = () => ({ display: 'block', visibility: 'visible' }); document.defaultView = window;
  document.querySelectorAll = selector => selector === '[role="dialog"],dialog' ? [] : elements;
  const add = (value = SECRET, label = 'API key') => {
    const el = { tagName: 'INPUT', type: 'text', value, readOnly: true, ownerDocument: document, isConnected: true,
      getBoundingClientRect: () => ({ width: 100, height: 20 }), closest: () => null, getAttribute: name => name === 'aria-label' ? label : null, hasAttribute: () => false };
    elements.push(el); return el;
  };
  vm.createContext(context);
  return { context, elements, add, run: (args, prefix = '0-0-1-1') => vm.runInContext(`(${providerKeyPage.toString()})('private_ref_state',${JSON.stringify(prefix)},${JSON.stringify({ origin, expectedUrl: url, ...args })})`, context) };
}

function driverFixture() {
  const page = pageFixture(); page.add();
  const frame = { processId: 1, routingId: 1, url, framesInSubtree: [], executeJavaScript: expression => Promise.resolve(vm.runInContext(expression, page.context)) };
  const tab = { id: 'tab-1', revision: 0, mainRevision: 0, owner, refs: new Map(), refContexts: new Map(), suspendedWork: new Set(), window: { isDestroyed: () => false, webContents: { getURL: () => url, mainFrame: frame } } };
  const calls = [], driver = {
    key: 'private_ref_state', closed: false, tab: id => { assert.equal(id, tab.id); return tab; }, activate: async () => {},
    assertInputDocument: (_tab, args) => { if (args.expectedUrl !== url || args.expectedDocumentId && args.expectedDocumentId !== `${tab.id}:${tab.revision}`) throw Error('changed'); },
    persist: () => { calls.push(['persist', tab.providerKeyProtected]); }, flushPersistence: async () => {},
    frameStamp: () => ({ mainRevision: 0, lineage: [{ revision: 0 }], frame }), frameStampCurrent: () => true,
    referenceCurrent: (_tab, ref, doc) => ref === 'create-ref' || tab.refs.has(ref) && doc === 'tab-1:0',
    rememberReferences: (_tab, captured) => captured.forEach(item => item.elements.forEach(source => tab.refs.set(source.ref, item.stamp.frame))),
    pageWork: (_tab, promise) => promise,
    perform: async (_args, options) => { calls.push(['click', options.suppressResultSnapshot, tab.providerKeyProtected]); return { tabId: tab.id }; },
  };
  return { page, frame, tab, calls, driver };
}

async function storeFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-provider-setup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryptSecret = plain => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]); };
  const decryptSecret = encrypted => { const data = Buffer.from(encrypted), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(); };
  const store = new ProviderStore({ dataDir: directory, encryptSecret, decryptSecret, ...overrides }); await store.init();
  return { store, directory };
}

test('source contract rejects cross-origin, HTTP, missing document and free-form inputs', () => {
  assert.equal(providerKeyTarget({ ...target, action: 'inspect' }).origin, origin);
  for (const input of [
    { ...target, action: 'import', ref: 'r' }, { ...target, action: 'inspect', apiKey: SECRET },
    { ...target, action: 'inspect', origin: 'https://other.example' }, { ...target, action: 'inspect', origin: 'http://provider.example', expectedUrl: 'http://provider.example/keys' },
  ]) assert.throws(() => providerKeyTarget(input), { code: 'PROVIDER_KEY_SOURCE_INVALID' });
});

test('protected inspection exposes only fixed metadata; capture consumes exact unchanged source once', () => {
  const page = pageFixture(); const element = page.add(SECRET, 'API key ' + SECRET);
  const inspected = page.run({ action: 'inspect' }); assert.equal(inspected.valid, true); assert.equal(inspected.sources.length, 1); noSecret(inspected);
  const ref = inspected.sources[0].ref;
  const captured = page.run({ action: 'import', ref }); assert.equal(captured.value, SECRET);
  assert.equal(page.run({ action: 'import', ref }).valid, false);
  const fresh = page.run({ action: 'inspect' }); element.value = 'another_synthetic_key_12345';
  assert.equal(page.run({ action: 'import', ref: fresh.sources[0].ref }).valid, false);
});

test('protected source rejects detached nodes and wrong origins without exposing page exceptions', () => {
  const page = pageFixture(), element = page.add(); const source = page.run({ action: 'inspect' }).sources[0];
  element.isConnected = false; noSecret(page.run({ action: 'import', ref: source.ref })); assert.equal(page.run({ action: 'import', ref: source.ref }).valid, false);
  element.isConnected = true; page.context.location.origin = 'https://other.example'; assert.equal(page.run({ action: 'inspect' }).valid, false);
});

test('protected inspection excludes masked keys and ordinary read-only account fields', () => {
  const page = pageFixture(); page.add('sk-or-v1-****hidden****', 'API key'); page.add('sk-or-v1-prefix…suffix', 'API key'); page.add('example@provider.example', 'Account email');
  assert.equal(page.run({ action: 'inspect' }).sources.length, 0);
});

test('click_inspect protects before one real click and explicitly suppresses the automatic snapshot', async () => {
  const { driver, calls } = driverFixture();
  const result = await performProviderKeySource(driver, { ...target, action: 'click_inspect', ref: 'create-ref', expectedDocumentId: 'tab-1:0' }, { owner });
  assert.deepEqual(calls, [['persist', true], ['click', true, true]]); assert.equal(result.clickDispatched, true); assert.equal(result.sources.length, 1); noSecret(result);
});

test('generation with a secret-bearing alert returns a sanitized uncertainty and never replays', async () => {
  const { driver, tab, calls } = driverFixture();
  driver.perform = async () => { calls.push(['click']); tab.pendingInteraction = { id: 'alert-1', kind: 'alert', status: 'pending', message: SECRET }; throw Error(SECRET); };
  await assert.rejects(performProviderKeySource(driver, { ...target, action: 'click_inspect', ref: 'create-ref', expectedDocumentId: 'tab-1:0' }, { owner }), cause => { noSecret({ message: cause.message }); assert.equal(cause.actionDispatched, null); return true; });
  assert.equal(calls.filter(call => call[0] === 'click').length, 1);
});

test('protected host capture passes bytes only to the host consumer and rejects stale document', async () => {
  const { driver } = driverFixture(); const inspected = await performProviderKeySource(driver, { ...target, action: 'inspect' }, { owner });
  let consumed = 0;
  const result = await performProviderKeySource(driver, { ...target, action: 'import', ref: inspected.sources[0].ref, expectedDocumentId: inspected.documentId }, { owner, consume: async value => { assert.equal(value, SECRET); consumed++; return { imported: true }; } });
  noSecret(result); assert.equal(consumed, 1);
  await assert.rejects(performProviderKeySource(driver, { ...target, action: 'import', ref: inspected.sources[0].ref, expectedDocumentId: 'stale' }, { owner, consume: () => { consumed++; } })); assert.equal(consumed, 1);
});

test('protected host path rejects other owners and reserved human tabs', async () => {
  const { driver, tab, calls } = driverFixture();
  await assert.rejects(performProviderKeySource(driver, { ...target, action: 'inspect' }, { owner: { ...owner, nodeId: 'other' } }));
  tab.purpose = 'chat-mode'; await assert.rejects(performProviderKeySource(driver, { ...target, action: 'inspect' }, { owner: null })); assert.equal(calls.length, 0);
});

test('agent tabs and top-level dialog receipts mask protected alert text and secret-bearing URL', async () => {
  const interaction = { id: 'alert-1', kind: 'alert', status: 'pending', text: SECRET, message: SECRET, defaultValue: SECRET };
  const status = { available: true, contained: true, activeTab: 'tab-1', tabs: [{ tabId: 'tab-1', url: url + '?key=' + SECRET, title: SECRET, protectedContent: true, pendingInteraction: interaction }] };
  let result = status;
  const workspace = new BrowserWorkspace({ driver: { status: () => status, perform: async () => result } });
  const listed = await workspace.perform({ action: 'tabs', browser: 'relay' }, { source: 'agent' }); noSecret(listed); assert.equal(listed.tabs[0].pendingInteraction.id, 'alert-1');
  result = { tabId: 'tab-1', url: url + '?key=' + SECRET, pendingInteraction: interaction, frames: [{ text: SECRET }] };
  noSecret(await workspace.perform({ action: 'read', browser: 'relay', tabId: 'tab-1' }, { source: 'agent' }));
});

test('encrypted provider write persists no plaintext, preserves default and uses a fresh timestamp CAS', async t => {
  const { store, directory } = await storeFixture(t); store.defaultModel = 'chosen-model';
  const first = await store.save({ id: 'freeapi', preset: 'openrouter', models: [{ id: 'vendor/model:free' }] }, { expectedUpdatedAt: null });
  const saved = await store.save({ id: 'freeapi', apiKey: SECRET }, { expectedUpdatedAt: first.updatedAt, requireEncrypted: true });
  assert.equal(saved.secretStorage, 'encrypted'); assert.equal(saved.hasApiKey, true); assert.notEqual(saved.updatedAt, first.updatedAt); assert.equal(store.defaultModel, 'chosen-model');
  noSecret(saved); assert.equal((await readFile(path.join(directory, 'providers.json'), 'utf8')).includes(SECRET), false);
  await assert.rejects(store.save({ id: 'freeapi', name: 'stale overwrite' }, { expectedUpdatedAt: first.updatedAt }), { code: 'PROVIDER_CHANGED' });
  assert.equal(store.get('freeapi').name, first.name);
});

test('concurrent writes with one observed provider revision admit only one update', async t => {
  const { store } = await storeFixture(t); const saved = await store.save({ id: 'freeapi', preset: 'openrouter' });
  const results = await Promise.allSettled(['first', 'second'].map(name => store.save({ id: 'freeapi', name }, { expectedUpdatedAt: saved.updatedAt })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PROVIDER_CHANGED');
});

test('encryption unavailable/plaintext encryption and cancellation before commit never store a key', async t => {
  const absent = await storeFixture(t, { encryptSecret: undefined, decryptSecret: undefined });
  await assert.rejects(absent.store.save({ id: 'freeapi', preset: 'openrouter', apiKey: SECRET }, { requireEncrypted: true }), { code: 'PROVIDER_SECRET_STORAGE_UNAVAILABLE' }); assert.equal(absent.store.get('freeapi'), undefined);
  const plaintext = await storeFixture(t, { encryptSecret: value => value });
  await assert.rejects(plaintext.store.save({ id: 'freeapi', preset: 'openrouter', apiKey: SECRET }, { requireEncrypted: true })); assert.equal(plaintext.store.get('freeapi'), undefined);
  const controller = new AbortController(), encrypted = await storeFixture(t);
  await assert.rejects(encrypted.store.save({ id: 'freeapi', preset: 'openrouter', apiKey: SECRET }, { requireEncrypted: true, signal: controller.signal, beforeCommit: () => controller.abort() }), { code: 'ABORT_ERR' }); assert.equal(encrypted.store.get('freeapi'), undefined);
});

test('abort after atomic commit begins does not relabel a completed write as absent', async t => {
  const { store } = await storeFixture(t), controller = new AbortController(), persist = store.persist.bind(store);
  store.persist = async (...args) => { controller.abort(); return persist(...args); };
  const saved = await store.save({ id: 'freeapi', preset: 'openrouter', apiKey: SECRET }, { requireEncrypted: true, signal: controller.signal });
  assert.equal(saved.hasApiKey, true); assert.equal(store.key('freeapi'), SECRET);
});

test('freeOnly semantics require a free suffix and complete explicitly zero provider pricing', () => {
  const metadata = pricing => ({ id: 'vendor/model:free', ...providerModelMetadata({ id: 'vendor/model:free', pricing }, { reported: true, reportedAt: '2026-10-30T00:00:00.000Z' }) });
  assert.equal(zeroPricedFreeVariant(metadata({ prompt: '0', completion: '0.000', request: '0', novel_fee: '0' })), true);
  for (const prices of [{ prompt: '0', completion: '0', request: '0.1' }, { prompt: '0', completion: '0', novel_fee: 'unknown' }, { prompt: '0', completion: '1e-1000' }, { prompt: '0' }]) assert.equal(zeroPricedFreeVariant(metadata(prices)), false);
  assert.equal(zeroPricedFreeVariant({ ...metadata({ prompt: '0', completion: '0' }), freeVariant: false }), false);
  assert.equal(zeroPricedFreeVariant({ ...metadata({ prompt: '0', completion: '0' }), pricingSource: 'user-configured' }), false);
});

test('tool scopes are explicit; raw keys/headers are absent from configuration contract', async t => {
  const { store } = await storeFixture(t), calls = [];
  const runtime = { store, listProviders: () => store.list(), saveProvider: async (input, options) => { calls.push({ input, options }); return store.save(input, options); } };
  const tools = createDirectProviderSetupTools({ runtime, browser: {}, reauthorize: async () => {}, isEncryptionAvailable: () => true });
  assert.deepEqual(tools.map(tool => tool.definition.requiredScopes), [['read'], ['commands:run'], ['commands:run', 'browser:read', 'browser:write']]);
  const configure = tools[1]; assert.equal('apiKey' in configure.definition.inputSchema.properties.provider.properties, false); assert.equal('headers' in configure.definition.inputSchema.properties.provider.properties, false);
  await assert.rejects(configure.execute({ requestId: 'x', action: 'save', expectedUpdatedAt: null, provider: { id: 'freeapi', preset: 'openrouter', apiKey: SECRET } }, { client })); assert.equal(calls.length, 0);
  const result = await configure.execute({ requestId: 'save', action: 'save', expectedUpdatedAt: null, provider: { id: 'freeapi', preset: 'openrouter', models: [{ id: 'liquid/lfm-2.5-2.6b:free' }] } }, { client });
  assert.equal(calls[0].options.preserveDefault, true); noSecret(result); assert.equal(parse(result).defaultChanged, false);
});

test('key tool checks encryption before browser access and imports via sanitized host callback', async t => {
  const { store } = await storeFixture(t), saved = await store.save({ id: 'freeapi', preset: 'openrouter' });
  let browserCalls = 0;
  const browser = { providerKeySource: async (_args, options) => { browserCalls++; await options.beforeDispatch(); return options.consume(SECRET, {}); } };
  const runtime = { store, saveProvider: (value, options) => { assert.equal(options.preserveDefault, true); return store.save(value, options); } };
  const make = isEncryptionAvailable => createDirectProviderSetupTools({ runtime, browser, reauthorize: async () => {}, isEncryptionAvailable })[2];
  const input = { requestId: 'import-1', ...target, action: 'import', providerId: saved.id, expectedUpdatedAt: saved.updatedAt, expectedDocumentId: 'tab-1:0', ref: 'key-ref' }; delete input.browser;
  await assert.rejects(make(() => false).execute(input, { client }), { code: 'PROVIDER_SECRET_STORAGE_UNAVAILABLE' }); assert.equal(browserCalls, 0);
  const result = parse(await make(() => true).execute(input, { client })); assert.equal(result.imported, true); assert.equal(result.provider.secretStorage, 'encrypted'); noSecret(result); assert.equal(browserCalls, 1);
});

test('custom OpenAI-compatible endpoint can be saved with no key and no encrypted-storage requirement', async t => {
  const { store } = await storeFixture(t, { encryptSecret: undefined, decryptSecret: undefined }); store.defaultModel = 'unchanged-default';
  const runtime = { store, saveProvider: (input, options) => store.save(input, options) };
  const tool = createDirectProviderSetupTools({ runtime, browser: {}, reauthorize: async () => {}, isEncryptionAvailable: () => false })[1];
  const input = { requestId: 'custom-save', action: 'save', expectedUpdatedAt: null, provider: { id: 'custom_anonymous', preset: 'compatible', type: 'compatible', name: 'Custom anonymous endpoint', baseUrl: 'https://custom-api.example/v1', models: [{ id: 'explicit-free-model' }] } };
  assert.equal(validDirectArguments(input, tool.definition.inputSchema), true);
  const result = parse(await tool.execute(input, { client }));
  assert.equal(result.provider.baseUrl, input.provider.baseUrl); assert.equal(result.provider.configured, true); assert.equal(result.provider.hasApiKey, false); assert.equal(result.provider.secretStorage, 'none'); assert.equal(store.defaultModel, 'unchanged-default');
});

test('HTTP adapter uses the same concrete tools and client, and rejects remote/generic dispatch', async () => {
  const calls = [], directExecution = { call: async (...args) => { calls.push(args); return { jobId: 'job' }; }, getJob: async (...args) => { calls.push(args); return { status: 'succeeded' }; } };
  const base = { directExecution, client, pathname: '/api/providers/setup', method: 'POST', value: { tool: 'import_key', arguments: { requestId: 'same-id', action: 'inspect', ...target } } };
  const result = await providerSetupHTTP(base); assert.equal(result.status, 200); assert.equal(calls[0][0], 'blackice_provider_import_key'); assert.equal(calls[0][2], client);
  assert.equal((await providerSetupHTTP({ ...base, remote: true })).status, 403);
  assert.equal((await providerSetupHTTP({ ...base, value: { tool: 'arbitrary', arguments: {} } })).status, 400); assert.equal(calls.length, 1);
  assert.equal(await providerSetupHTTP({ ...base, pathname: '/unrelated' }), null);
  const id = 'direct_' + 'a'.repeat(64); await providerSetupHTTP({ ...base, pathname: '/api/providers/setup/jobs/' + id, method: 'GET', value: undefined });
  assert.equal(calls[1][0], id); assert.equal(calls[1][2].includeImages, false);
});

test('actual direct schema admits new provider revisions and rejects secret/header arguments', async t => {
  const { store } = await storeFixture(t);
  const tools = createDirectProviderSetupTools({ runtime: { store }, browser: {}, reauthorize: async () => {}, isEncryptionAvailable: () => true });
  const spec = tools[1].definition.inputSchema, good = { requestId: 'save-one', action: 'save', expectedUpdatedAt: null, provider: { id: 'freeapi', preset: 'openrouter', maxSteps: null, models: [{ id: 'liquid/lfm-2.5-2.6b:free' }] } };
  assert.equal(validDirectArguments(good, spec), true);
  assert.equal(validDirectArguments({ ...good, expectedUpdatedAt: '2026-10-30T00:00:00.000Z' }, spec), true);
  for (const field of ['apiKey', 'headers']) assert.equal(validDirectArguments({ ...good, provider: { ...good.provider, [field]: SECRET } }, spec), false);
});

test('actual direct ledger and HTTP adapter share scope validation, saved receipts and same-ID no replay', async t => {
  const { store, directory } = await storeFixture(t), saved = await store.save({ id: 'freeapi', preset: 'openrouter' });
  let calls = 0, api;
  const runtime = { store, listProviders: () => store.list(), saveProvider: (input, options) => store.save(input, options) };
  const browser = { providerKeySource: async (_target, options) => { calls++; return options.consume(SECRET, {}); } };
  const tools = createDirectProviderSetupTools({ runtime, browser, reauthorize: (identity, { scopes }) => api.require(identity, scopes), isEncryptionAvailable: () => true });
  api = new DirectExecutionAPI({ dataDir: directory, allowedRoot: directory, browser, additionalTools: tools, authorizeClient: async identity => identity.id === client.id });
  await api.init();
  const args = { requestId: 'import-durable-once', action: 'import', tabId: target.tabId, origin, expectedUrl: url, expectedDocumentId: 'tab-1:0', ref: 'key-ref', providerId: saved.id, expectedUpdatedAt: saved.updatedAt };
  await assert.rejects(api.call('blackice_provider_import_key', args, { ...client, scopes: ['read', 'commands:run', 'browser:read'] }), { code: 'DIRECT_SCOPE_REQUIRED' });
  assert.equal(calls, 0);
  const admitted = await api.call('blackice_provider_import_key', args, client);
  let job;
  for (let index = 0; index < 100; index++) { job = await api.getJob(admitted.jobId, client, { limit: 50000 }); if (job.settled) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(job.status, 'succeeded'); assert.equal(calls, 1); noSecret(job);
  noSecret(await api.jobs.get(admitted.jobId, { ownerId: client.id }));
  const repeated = await providerSetupHTTP({ directExecution: api, client, pathname: '/api/providers/setup', method: 'POST', value: { tool: 'import_key', arguments: args } });
  assert.equal(repeated.body.jobId, admitted.jobId); assert.equal(repeated.body.existing, true); assert.equal(calls, 1);
  const changed = { ...args, ref: 'different-key-ref' }; await assert.rejects(api.call('blackice_provider_import_key', changed, client)); assert.equal(calls, 1);
});
