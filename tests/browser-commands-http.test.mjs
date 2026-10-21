import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class Runtime extends EventEmitter { status() { return { connected: false, authenticated: false, models: [] }; } async start() { return this.status(); } async close() {} async runAgent() { throw Error('Browser commands must not start a model.'); } }
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-browser-http-')); let connects = 0, copies = 0;
  const profiles = { discover: async () => ({ sources: [{ id: 'source-one' }], imports: [] }), import: async ({ sourceId }) => { copies++; return { id: sourceId, authentication: 'unverified' }; }, close: async () => {} };
  const app = await createHarnessServer({ port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'work'), runtime: new Runtime(), desktop: new Desktop(), autoAttachDesktop: false, remoteAccess: false, browserProfiles: profiles,
    connectChromeBrowser: async ({ onDispatch }) => { connects++; onDispatch?.(); return { browser: 'chrome', connected: true, accountAuthenticated: 'unknown' }; },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const url = await app.listen(), page = await fetch(url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const request = (route, value, extra = {}) => fetch(url + route, { method: value === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...extra, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  async function done(id) { for (let n = 0; n < 100; n++) { const result = await (await request('/api/browser/commands/' + id)).json(); if (result.settled) return result; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Browser command did not finish.'); }
  return { app, url, request, done, counts: () => ({ connects, copies }) };
}

test('local CLI browser actions share durable idempotent jobs without requiring the ChatGPT connector to be enabled', async t => {
  const f = await fixture(t), input = { tool: 'blackice_connected_browser_action', arguments: { requestId: 'chrome-connect-once', action: 'connect_chrome' } };
  const first = await (await f.request('/api/browser/commands', input)).json(), settled = await f.done(first.jobId);
  assert.equal(settled.status, 'succeeded'); assert.equal(f.counts().connects, 1);
  assert.match(settled.result.text.text, /accountAuthenticated.*unknown/);
  const retry = await (await f.request('/api/browser/commands', input)).json(); assert.equal(retry.jobId, first.jobId); assert.equal(retry.existing, true); assert.equal(f.counts().connects, 1);
  const page = await (await f.request('/api/browser/commands/' + first.jobId + '?offset=2&limit=5')).json(); assert.equal(page.result.text.offset, 2); assert.equal(page.result.text.text.length, 5); assert.equal(page.result.text.nextOffset, 7);
  assert.equal((await f.request('/api/browser/commands/' + first.jobId + '?offset=-1')).status, 400);
  assert.equal((await f.request('/api/browser/commands', { tool: 'blackice_run_command', arguments: { requestId: 'unsupported', command: 'anything' } })).status, 400);
});

test('browser commands use normal local authentication and profile import produces a copy receipt', async t => {
  const f = await fixture(t), input = { tool: 'blackice_profile_import', arguments: { requestId: 'copy-once', sourceId: 'source-one' } };
  assert.equal((await fetch(f.url + '/api/browser/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  assert.equal((await f.request('/api/browser/commands', input, { 'x-blackice-remote': '1' })).status, 403);
  const first = await (await f.request('/api/browser/commands', input)).json(), result = await f.done(first.jobId);
  assert.equal(result.status, 'succeeded'); assert.equal(f.counts().copies, 1); assert.equal(JSON.parse(result.result.text.text).authentication, 'unverified');
  const status = await (await f.request('/api/browser/status')).json(); assert.equal(status.browserProfiles.sources[0].id, 'source-one');
});
