import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { throw Error('The contained status fixture cannot request a model turn.'); }
}
class Desktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

test('contained status stays responsive while profile discovery is held, without changing full management refresh', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-observe-status-'));
  const entered = deferred(), release = deferred(), calls = { profiles: 0, import: 0 };
  const metadata = { sources: [{ id: 'owned-discovery-fixture' }], imports: [] };
  const profiles = { async discover() { calls.profiles++; entered.resolve(); await release.promise; return metadata; }, async close() {} };
  const browserImport = {
    snapshot() { return { available: true, capabilities: { open: true } }; },
    async status() { calls.import++; return this.snapshot(); },
    async close() {},
  };
  let app;
  t.after(async () => { release.resolve(); await app?.close(); await rm(directory, { recursive: true, force: true }); });
  app = await createHarnessServer({
    port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'),
    runtime: new Runtime(), desktop: new Desktop(), autoAttachDesktop: false, remoteAccess: false,
    browserProfiles: profiles, browserImport, signedBrowser: true,
    signedBrowserOptions: { registerImpl: async () => ({ available: false, reason: 'Disposable status fixture.' }) },
  });
  const origin = await app.listen(), home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const get = target => fetch(origin + target, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
  assert.equal((await fetch(origin + '/api/browser/status?view=contained')).status, 401);
  const asset = await get('/browser-address.mjs');
  assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/); await asset.text();
  const first = await get('/api/browser/status?view=contained');
  assert.equal(first.status, 200); assert.equal((await first.json()).browserProfiles.loaded, false);
  assert.deepEqual(calls, { profiles: 0, import: 0 });

  const management = get('/api/browser/status'); await entered.promise;
  let managementFinished = false; management.then(() => { managementFinished = true; }, () => { managementFinished = true; });
  for (let index = 0; index < 4; index++) {
    const preview = await get('/api/browser/status?view=contained');
    assert.equal(preview.status, 200); assert.equal((await preview.json()).browserProfiles.loaded, false);
  }
  assert.equal(managementFinished, false, 'contained reads finish before the deliberately delayed discovery');
  assert.deepEqual(calls, { profiles: 1, import: 1 }, 'preview polling does not repeat native metadata discovery');
  release.resolve();
  const refreshed = await management; assert.equal(refreshed.status, 200);
  assert.deepEqual((await refreshed.json()).browserProfiles, { ...metadata, loaded: true });
  const cached = await get('/api/browser/status?view=contained');
  assert.deepEqual((await cached.json()).browserProfiles, { ...metadata, loaded: true });
  assert.deepEqual(calls, { profiles: 1, import: 1 });
});
