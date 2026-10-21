import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.calls++; throw Error('Retired route must not start a model.'); }
}
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-retired-http-')), runtime = new Runtime(), reverseCalls = [];
  const obsolete = new Proxy({}, { get(_target, name) { reverseCalls.push(String(name)); throw Error('Retired browser runtime must not be used.'); } });
  const stateFile = path.join(dataDir, 'chat-mode-state.json'), saved = 'Original legacy receipt is intentionally unreadable.';
  await writeFile(stateFile, saved);
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(dataDir, 'workspace'), runtime, desktop, autoAttachDesktop: false, remoteAccess: false, chatMode: obsolete, chatModeConnection: obsolete, emailExecutableHint: null });
  const url = await app.listen(), home = await fetch(url), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const request = (route, options = {}) => fetch(url + route, { ...options, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...options.headers } });
  t.after(async () => { await app.close(); assert.deepEqual(reverseCalls, []); assert.equal(await readFile(stateFile, 'utf8'), saved); await rm(dataDir, { recursive: true, force: true }); });
  return { app, request, url, runtime, reverseCalls };
}

test('retired Chat Mode endpoints authenticate normally and return 410 without touching browser or saved state', async t => {
  const { app, request, url, runtime, reverseCalls } = await fixture(t);
  assert.equal((await fetch(url + '/api/chat-mode')).status, 401);
  assert.equal((await request('/api/chat-mode/setup', { method: 'POST', body: '{}', headers: { Origin: 'https://unrelated.example' } })).status, 403);
  for (const route of ['/api/chat-mode', '/api/chat-mode/setup', '/api/chat-mode/refresh', '/api/chat-mode/acknowledge']) {
    const response = await request(route, route.endsWith('chat-mode') ? {} : { method: 'POST', body: '{}' });
    assert.equal(response.status, 410); const result = await response.json();
    assert.equal(result.code, 'CHAT_MODE_RETIRED'); assert.match(result.error, /BLACKICE connection from ChatGPT/);
  }
  const status = await (await request('/api/status')).json();
  assert.equal(Object.hasOwn(status, 'chatMode'), false); assert.equal(Object.hasOwn(app, 'chatMode'), false);
  assert.equal(runtime.calls, 0); assert.deepEqual(reverseCalls, []);
  await app.beginMaintenance(); app.endMaintenance();
  assert.equal(typeof app.assertRestartReady, 'function');
});

test('retiring the reverse provider retains direct connector status and durable execution stores', async t => {
  const { app, request, runtime } = await fixture(t);
  const response = await request('/api/chatgpt-connector');
  assert.equal(response.status, 200); assert.equal(typeof (await response.json()).enabled, 'boolean');
  assert.equal(typeof app.chatGPTConnector.handle, 'function');
  assert.equal((await app.directExecution.status()).jobs.active, 0);
  assert.equal(runtime.calls, 0);
  const legacy = await request('/api/chatgpt-bridge');
  assert.equal(legacy.status, 410); assert.equal((await legacy.json()).code, 'FEATURE_NOT_OFFERED');
});
