import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

async function fixture(t, configure) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-protection-http-')), calls = [];
  class Runtime extends EventEmitter { status() { return { connected: true, authenticated: true, models: [] }; } async start() { return this.status(); } async close() {} async runAgent() { assert.fail('Protection controls must not start a model turn.'); } }
  class Browser extends EventEmitter {
    status() { return { available: true, contained: true, tabs: [], activeTab: null }; }
    protectionStatus() { return { available: true, enabled: true, ready: true, filterCount: 1234, tabs: [] }; }
    async configureProtection(value, context) { calls.push({ value, source: context.source }); return configure ? configure(value, context) : this.protectionStatus(); }
    async cancel() {} async close() {}
  }
  class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } async close() {} }
  const app = await createHarnessServer({ port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'workspace'), runtime: new Runtime(), browser: new Browser(), desktop: new Desktop(), remoteAccess: false });
  const origin = await app.listen(), home = await fetch(origin), cookie = home.headers.get('set-cookie').split(';', 1)[0]; await home.arrayBuffer();
  t.after(async () => { await app.close(); assert.match(path.basename(root), /^blackice-protection-http-/); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (value, { auth = true, requestOrigin = origin, method = value === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(origin + '/api/browser/protection', { method, headers: { ...(auth ? { Cookie: cookie } : {}), Origin: requestOrigin, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, request, calls };
}

test('browser protection HTTP requires a same-origin session and validates actions before any mutation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(undefined, { auth: false })).status, 401);
  assert.equal((await f.request({ action: 'global', enabled: false }, { auth: false })).status, 401);
  assert.equal((await f.request({ action: 'global', enabled: false }, { requestOrigin: 'https://unrelated.invalid' })).status, 403);
  for (const value of [null, [], {}, { action: 'global' }, { action: 'global', enabled: 'false' }, { action: 'refresh', url: 'https://unrelated.invalid/list.txt' }, { action: 'site', enabled: false }, { action: 'global', enabled: true, source: 'agent' }]) assert.equal((await f.request(value)).status, 400);
  assert.deepEqual(f.calls, []);
  const status = await f.request(); assert.equal(status.status, 200); assert.equal(status.body.filterCount, 1234);
});

test('browser protection HTTP forwards only explicit human actions and returns the observed receipt', async t => {
  const f = await fixture(t);
  for (const value of [{ action: 'global', enabled: false }, { action: 'site', tabId: 'relay:tab_1', origin: 'https://example.test', enabled: false }, { action: 'refresh' }]) {
    assert.equal((await f.request(value)).status, 200);
    assert.deepEqual(f.calls.at(-1), { value, source: 'user' });
  }
  assert.equal(f.calls.length, 3);
});

test('browser protection HTTP preserves stale-origin conflicts and drains an admitted settings write before close', async t => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async value => { if (value.action === 'site') throw Object.assign(Error('This tab changed its origin.'), { status: 409, code: 'BROWSER_PROTECTION_STALE_TAB' }); entered(); await held; return { available: true, enabled: false, ready: true, tabs: [] }; });
  assert.equal((await f.request({ action: 'site', tabId: 'relay:tab_1', origin: 'https://example.test', enabled: false })).status, 409);
  let settled = false;
  const saving = f.request({ action: 'global', enabled: false }); await started;
  const closing = f.app.close().then(() => { settled = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); }
  finally { release(); }
  const response = await saving; assert.equal(response.status, 200); assert.equal(response.body.enabled, false); await closing; assert.equal(settled, true);
});
