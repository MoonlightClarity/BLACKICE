import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StorageManager, STORAGE_CATEGORIES } from '../lib/storage-management.mjs';
import { blockedRemotePath } from '../lib/remote-access-gateway.mjs';
import { createHarnessServer } from '../server.mjs';

const confirmation = 'DELETE SELECTED DATA';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-storage-safety-'));
  const dataDir = path.join(root, 'data'), workspaceDir = path.join(root, 'workspace');
  await mkdir(dataDir); await mkdir(workspaceDir);
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, workspaceDir, beforeRemove: close => closers.push(close), manager: new StorageManager({ dataDir, workspaceDir }) };
}
const present = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

test('a real failure after deletion preserves a readable failed marker and partial warning', async t => {
  const { dataDir, workspaceDir, manager } = await fixture(t);
  const history = path.join(dataDir, 'conversations');
  await mkdir(history); await writeFile(path.join(history, 'turn.json'), 'history');
  await manager.schedule({ categories: ['conversations'], confirmation });
  // Force reporting to fail AFTER deletion, without touching anything outside the fixture.
  await mkdir(manager.reportFile);
  await assert.rejects(manager.applyAtStartup());
  assert.equal(await present(history), false);
  const saved = JSON.parse(await readFile(manager.pendingFile, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.status, 'failed');
  const restarted = new StorageManager({ dataDir, workspaceDir });
  assert.equal((await restarted.pending()).status, 'failed');
  await assert.rejects(restarted.applyAtStartup(), /interrupted/);
  assert.deepEqual(await restarted.cancel(), { cancelled: true, partial: true });
});

test('unreadable cleanup state is cancelled without claiming that no deletion occurred', async t => {
  const { manager } = await fixture(t);
  await writeFile(manager.pendingFile, '{"status":"applying"}');
  assert.deepEqual(await manager.cancel(), { cancelled: true, partial: true });
});

test('competing queue requests cannot overwrite an accepted cleanup selection', async t => {
  const { manager } = await fixture(t);
  const results = await Promise.allSettled([
    manager.schedule({ categories: ['conversations'], confirmation }),
    manager.schedule({ categories: ['context'], confirmation })
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409);
  assert.deepEqual((await manager.pending()).categories, ['conversations']);
  await manager.cancel();
  await manager.schedule({ categories: ['context'], confirmation });
  assert.deepEqual((await manager.pending()).categories, ['context']);
});

test('retired VM files, active browser files, and modular planning settings remain protected', async t => {
  const { root, dataDir, manager } = await fixture(t);
  for (const id of ['vm', 'browser', 'runtimeSettings']) {
    assert.equal(STORAGE_CATEGORIES.find(c => c.id === id).deletable, false);
    await assert.rejects(manager.schedule({ categories: [id], confirmation }), /protected/);
  }
  const preserved = [
    ['data', 'workbench-vm', 'disk.vhdx'], ['data', 'bp', 'snapshot'],
    ['data', 'browser-profiles', 'manifest'], ['Partitions', 'browser', 'Cookies'],
    ['data', 'browser-tabs.json'], ['data', 'runtime-settings.json']
  ];
  for (const parts of preserved) {
    const file = path.join(root, ...parts);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'preserve');
  }
  const credentials = path.join(dataDir, 'browser-credentials');
  await mkdir(credentials); await writeFile(path.join(credentials, 'vault.json'), 'saved password');
  const overview = await manager.overview();
  assert.equal(overview.categories.find(c => c.id === 'browser').bytes, 32);
  assert.equal(overview.categories.find(c => c.id === 'vm').bytes, 8);
  await manager.schedule({ categories: ['browserCredentials', 'context'], confirmation });
  await manager.applyAtStartup();
  assert.equal(await present(credentials), false);
  for (const parts of preserved) assert.equal(await readFile(path.join(root, ...parts), 'utf8'), 'preserve');
});

test('remote gateway blocks every storage route independently of HTTP method', () => {
  for (const route of ['overview', 'cleanup', 'cleanup/cancel', 'policy']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(blockedRemotePath('/api/storage/' + route, method), true);
  }
  assert.equal(blockedRemotePath('/api/storage-other', 'GET'), false);
});

class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent() { throw new Error('Storage tests must never start model work.'); }
  async close() {}
}
test('storage HTTP routes require a local authenticated same-origin session and preserve typed confirmation', async t => {
  const { dataDir, workspaceDir, beforeRemove } = await fixture(t);
  const app = await createHarnessServer({ dataDir, defaultCwd: workspaceDir, runtime: new Runtime(), remoteAccess: false, port: 0, autoAttachDesktop: false });
  beforeRemove(() => app.close());
  const url = await app.listen();
  const home = await fetch(url), cookie = home.headers.get('set-cookie').split(';')[0];
  const request = async (route, method = 'GET', payload, headers = {}) => {
    const response = await fetch(new URL(route, url), { method, headers: { Cookie: cookie, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await fetch(new URL('/api/storage/overview', url))).status, 401);
  assert.equal((await request('/api/storage/overview', 'GET', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  for (const [route, method] of [['overview','GET'], ['cleanup','POST'], ['cleanup/cancel','POST'], ['policy','POST']]) {
    const result = await request('/api/storage/' + route, method, method === 'POST' ? {} : undefined, { 'x-blackice-remote': '1' });
    assert.equal(result.status, 403); assert.equal(result.value.code, 'STORAGE_LOCAL_REQUIRED');
  }
  assert.equal((await request('/api/storage/overview')).status, 200);
  assert.equal((await request('/api/storage/cleanup', 'POST', { categories: ['context'], confirmation: 'yes' })).status, 400);
  const queued = await request('/api/storage/cleanup', 'POST', { categories: ['context'], confirmation });
  assert.equal(queued.status, 202); assert.equal(queued.value.applies, 'next-startup');
  assert.equal((await request('/api/storage/cleanup/cancel', 'POST', {})).value.cancelled, true);
});

test('server applies queued cleanup before its stores load, without deleting protected settings', async t => {
  const { dataDir, workspaceDir, manager, beforeRemove } = await fixture(t);
  await writeFile(path.join(dataDir, 'knowledge.json'), 'invalid old data that must not hydrate');
  await manager.schedule({ categories: ['context'], confirmation });
  const app = await createHarnessServer({ dataDir, defaultCwd: workspaceDir, runtime: new Runtime(), remoteAccess: false, port: 0, autoAttachDesktop: false });
  beforeRemove(() => app.close());
  assert.equal(await manager.pending(), null);
  assert.equal(app.knowledge.status().count ?? app.knowledge.list?.().length ?? 0, 0);
  assert.deepEqual((await manager.overview()).lastCleanup.categories, ['context']);
});
