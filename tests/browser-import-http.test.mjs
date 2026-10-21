import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { BrowserImportBridge } from '../lib/browser-import.mjs';

const route = '/api/browser/neo/import';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); } async close() {}
  async runAgent() { throw new Error('A native import handoff must not call a model.'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }

async function fixture(t, { desktop = true, launch } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-browser-import-')), calls = [];
  const bridge = new BrowserImportBridge({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' },
    lstat: async location => ({ isFile: () => location.endsWith('.exe'), isDirectory: () => location.endsWith('User Data'), isSymbolicLink: () => false }), realpath: async location => location,
    launch: (...args) => { calls.push(args); if (launch) return launch(...args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; },
  });
  const app = await createHarnessServer({ port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), runtime: new Runtime(), desktop: new Desktop(), autoAttachDesktop: false, remoteAccess: false, browserImport: bridge, signedBrowser: desktop,
    signedBrowserOptions: { registerImpl: async () => ({ available: false, nativeIntegration: true, reason: 'No native browser connection is required to open import settings.' }) },
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.learning.updateSettings({ mode: 'manual' });
  const url = await app.listen(), response = await fetch(url), cookie = response.headers.get('set-cookie').split(';')[0]; await response.text();
  const request = (target, { method = 'GET', body, headers = {} } = {}) => fetch(url + target, { method, headers: { Cookie: cookie, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, bridge, calls, url, cookie, request };
}

test('native Neo import requires local authentication, desktop availability and an exact empty request', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const state = await (await f.request('/api/browser/status')).json(); assert.equal(state.neoImport.available, true); assert.equal(state.neoImport.localManagement, true); assert.equal(f.calls.length, 0);
  const remoteState = await (await f.request('/api/browser/status', { headers: { 'x-blackice-remote': '1' } })).json(); assert.equal(remoteState.neoImport.localManagement, false); assert.equal(remoteState.neoImport.capabilities.open, false);
  const remoteOverview = await (await f.request('/api/status', { headers: { 'x-blackice-remote': '1' } })).json(); assert.equal(remoteOverview.browser.neoImport.localManagement, false); assert.equal(remoteOverview.browser.neoImport.capabilities.open, false);
  const localOverview = await (await f.request('/api/status')).json(); assert.equal(localOverview.browser.neoImport.localManagement, true); assert.equal(localOverview.browser.neoImport.capabilities.open, true);
  for (const headers of [{ 'x-blackice-remote': '1' }, { Origin: 'https://unrelated.invalid' }]) assert.equal((await f.request(route, { method: 'POST', body: {}, headers })).status, 403);
  for (const body of [null, [], { url: 'chrome://settings' }, { sourceBrowser: 'Chrome' }, { cookies: true }, { source: 'user' }]) assert.equal((await f.request(route, { method: 'POST', body })).status, 400);
  assert.equal((await f.request(route + '?url=chrome%3A%2F%2Fsettings', { method: 'POST', body: {} })).status, 400);
  assert.equal(f.calls.length, 0);
  const response = await f.request(route, { method: 'POST', body: {} }); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requested: true, destination: 'neo', nativeWindow: true, windowVerified: false, importCompleted: false }); assert.equal(f.calls.length, 1);
});

test('the web-only server cannot launch a native importer', async t => {
  const f = await fixture(t, { desktop: false });
  assert.equal((await f.request(route, { method: 'POST', body: {} })).status, 409); assert.equal(f.calls.length, 0);
  assert.equal((await (await f.request('/api/browser/status')).json()).neoImport, undefined);
});

test('concurrent local handoffs launch once and profile maintenance waits for the admitted acknowledgement', async t => {
  const started = deferred(), admittedTwice = deferred(), child = new EventEmitter(); child.unref = () => {};
  const f = await fixture(t, { launch: () => { started.resolve(); return child; } });
  const original = f.bridge.open.bind(f.bridge); let admissions = 0;
  f.bridge.open = (...args) => { if (++admissions === 2) admittedTwice.resolve(); return original(...args); };
  const one = f.request(route, { method: 'POST', body: {} }); await started.promise;
  const two = f.request(route, { method: 'POST', body: {} }); await admittedTwice.promise;
  let drained = false; const maintenance = f.app.beginMaintenance().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(f.calls.length, 1);
  child.emit('spawn');
  for (const response of await Promise.all([one, two])) { assert.equal(response.status, 200); assert.equal((await response.json()).importCompleted, false); }
  await maintenance; assert.equal(drained, true);
  assert.equal((await f.request(route, { method: 'POST', body: {} })).status, 503); assert.equal(f.calls.length, 1); f.app.endMaintenance();
});

test('a request held mid-body cannot open an import window after profile maintenance has drained', async t => {
  const f = await fixture(t), entered = deferred(), received = deferred();
  f.app.server.once('request', entered.resolve);
  const req = http.request(f.url + route, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json', 'Content-Length': '2' } }, res => { res.resume(); res.once('end', () => received.resolve(res.statusCode)); });
  req.once('error', received.reject); req.write('{');
  await entered.promise; await f.app.beginMaintenance(); req.end('}');
  assert.equal(await received.promise, 503); assert.equal(f.calls.length, 0); f.app.endMaintenance();
});
