import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

const DEFAULT_MODEL = 'fixture/default-wire';
const AUTOMATIC_MODEL = 'fixture/automatic-wire';
const EXACT_MODEL = 'Private/Exact-Model:2026.10';
const CHECKED_AT = '2026-10-18T00:00:00.000Z';
const CHECK_ROUTE = '/api/codex/models/check';

class FixtureCodex extends EventEmitter {
  constructor() { super(); this.inferences = []; }
  status() {
    return {
      connected: true, authenticated: true, defaultModel: DEFAULT_MODEL, activeTurns: 0,
      models: [
        { id: 'fixture-visible', model: DEFAULT_MODEL, displayName: 'Fixture visible model', hidden: false },
        { id: 'fixture-hidden', model: 'fixture/hidden-wire', displayName: 'Fixture hidden model', hidden: true },
      ],
      modelCatalog: { hiddenModelsIncluded: true, stale: false, refreshing: false },
    };
  }
  async start() { return this.status(); }
  async runAgent(options) { this.inferences.push(options); throw Error('The HTTP boundary fixture must not run an inference.'); }
  async close() {}
}

async function application(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-model-check-http-'));
  const dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace');
  const codex = new FixtureCodex(), providerRequests = [], checkCalls = [];
  const runtime = new ProviderRuntime({ codex, dataDir, fetchImpl: async (...args) => {
    providerRequests.push(args); throw Error('The HTTP boundary fixture must not contact an API provider.');
  } });
  let app, resultStatus = 'accepted', checkError = null;
  const candidates = [{ model: EXACT_MODEL, source: 'fixture-candidate', access: { state: 'unverified' } }];
  // Keep real provider/default storage; replace only the isolated native check
  // and its candidate input. Transport tests never perform model inference.
  const catalog = runtime.codexModelCatalog.bind(runtime);
  runtime.codexModelCatalog = (...args) => ({ ...catalog(...args), candidates: structuredClone(candidates) });
  const receipt = model => ({
    model, requestedModel: model, effectiveModel: resultStatus === 'accepted' ? model : null,
    status: resultStatus, checkedAt: CHECKED_AT,
    ...(resultStatus === 'accepted' ? {} : { error: {
      code: resultStatus === 'interrupted' ? 'ABORT_ERR' : 'MODEL_NOT_FOUND',
      message: resultStatus === 'interrupted' ? 'The fixture check was interrupted.' : 'The fixture endpoint rejected this exact model.',
    } }),
  });
  runtime.checkCodexModel = async model => {
    checkCalls.push(model);
    if (checkError) throw checkError;
    return { ...runtime.codexModelCatalog(), result: receipt(model) };
  };
  t.after(async () => {
    try { if (app) await app.close(); else await runtime.close(); }
    finally {
      assert.match(path.basename(directory), /^blackice-model-check-http-/);
      await rm(directory, { recursive: true, force: true });
    }
  });
  await runtime.init();
  await runtime.store.pinAutomaticDefault(AUTOMATIC_MODEL);
  await runtime.store.setDefaultModel(DEFAULT_MODEL);
  app = await createHarnessServer({ runtime, port: 0, dataDir, defaultCwd: cwd, autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'manual' });
  const target = new URL(await app.listen());
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...options.headers };
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(Error('The fixture HTTP response was interrupted.')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, headers: res.headers, data: String(res.headers['content-type']).includes('application/json') ? JSON.parse(text) : text, text }); }
        catch (cause) { reject(cause); }
      });
    });
    req.setTimeout(5000, () => req.destroy(Error('The fixture HTTP request timed out.')));
    req.on('error', reject); req.end(payload);
  });
  const home = await request('/'); assert.equal(home.status, 200);
  const cookie = home.headers['set-cookie']?.[0]?.split(';', 1)[0]; assert.ok(cookie);
  const api = (route, options = {}) => request(route, { ...options, headers: { Cookie: cookie, ...options.headers } });
  const settingsFile = path.join(dataDir, 'providers.json'), savedSettings = await readFile(settingsFile, 'utf8');
  const unchanged = async () => {
    assert.equal(await readFile(settingsFile, 'utf8'), savedSettings, 'checking a model must not write provider/default settings');
    assert.equal(runtime.store.defaultModel, DEFAULT_MODEL);
    assert.equal(runtime.store.automaticDefaultModel, AUTOMATIC_MODEL);
    assert.deepEqual(runtime.store.listCodexModels(), [], 'a check does not register its candidate');
    const runs = await api('/api/runs'); assert.equal(runs.status, 200); assert.deepEqual(runs.data, []);
    const status = await api('/api/status'); assert.equal(status.status, 200); assert.equal(status.data.execution.activeRunCount, 0);
    assert.equal(status.data.defaultModelSelection, DEFAULT_MODEL);
    assert.equal(status.data.automaticDefaultModel, AUTOMATIC_MODEL);
    assert.equal(codex.inferences.length, 0, 'the route must not start an ordinary agent task');
    assert.equal(providerRequests.length, 0, 'the route must not fall back to an API provider');
  };
  return { request, api, checkCalls, candidates, receipt, unchanged, outcome(value) { resultStatus = value; }, rejectWith(value) { checkError = value; } };
}

test('native model checks require the local session and reject cross-site mutations before dispatch', async t => {
  const f = await application(t);
  const unauthenticated = await f.request(CHECK_ROUTE, { method: 'POST', body: { model: EXACT_MODEL } });
  assert.equal(unauthenticated.status, 401);
  for (const headers of [{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const rejected = await f.api(CHECK_ROUTE, { method: 'POST', body: { model: EXACT_MODEL }, headers });
    assert.equal(rejected.status, 403);
  }
  assert.deepEqual(f.checkCalls, []);
  await f.unchanged();
});

test('native model check HTTP bodies accept only one string model field and reads never dispatch a check', async t => {
  const f = await application(t);
  const bodies = [null, [], {}, EXACT_MODEL, { model: 17 }, { model: EXACT_MODEL, cwd: 'ignored' }, { model: EXACT_MODEL, defaultModel: 'default' }, { model: EXACT_MODEL, prompt: 'Do other work.' }, { model: EXACT_MODEL, timeoutMs: 0 }];
  for (const body of bodies) {
    const rejected = await f.api(CHECK_ROUTE, { method: 'POST', body });
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(typeof rejected.data.error, 'string');
  }
  const catalog = await f.api('/api/codex/models'); assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.candidates, f.candidates);
  assert.deepEqual(catalog.data.models.map(model => model.model), [DEFAULT_MODEL, 'fixture/hidden-wire']);
  assert.deepEqual(f.checkCalls, []);
  await f.unchanged();
});

test('native model check HTTP passes the exact routing ID and returns its receipt without saving a model or starting a task', async t => {
  const f = await application(t);
  const response = await f.api(CHECK_ROUTE, { method: 'POST', body: { model: EXACT_MODEL } });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(f.checkCalls, [EXACT_MODEL]);
  assert.deepEqual(response.data.result, f.receipt(EXACT_MODEL));
  assert.deepEqual(response.data.candidates, f.candidates);
  assert.equal(response.data.models[1].hidden, true);
  assert.equal(response.data.models.some(model => model.model === EXACT_MODEL), false, 'an unregistered checked ID is not silently added to the saved picker');
  const catalog = await f.api('/api/codex/models'); assert.equal(catalog.status, 200);
  assert.deepEqual(f.checkCalls, [EXACT_MODEL], 'reading after a check must not replay it');
  await f.unchanged();
});

test('native model check HTTP preserves rejection and interruption outcomes and reports a busy error without fallback', async t => {
  const f = await application(t);
  for (const outcome of ['failed', 'interrupted']) {
    f.outcome(outcome);
    const response = await f.api(CHECK_ROUTE, { method: 'POST', body: { model: EXACT_MODEL } });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.data.result, f.receipt(EXACT_MODEL));
    assert.equal(response.data.result.status, outcome);
    assert.equal(response.data.result.effectiveModel, null);
  }
  f.rejectWith(Object.assign(Error('Another native model check is still running.'), { code: 'CODEX_MODEL_CHECK_BUSY', status: 409 }));
  const busy = await f.api(CHECK_ROUTE, { method: 'POST', body: { model: EXACT_MODEL } });
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.data.error, 'Another native model check is still running.');
  assert.equal(busy.data.result, undefined);
  assert.deepEqual(f.checkCalls, [EXACT_MODEL, EXACT_MODEL, EXACT_MODEL]);
  await f.unchanged();
});
