import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRuntimeOwnership, validateRuntimeFileOwnership, readAccessRuntime, createAccessCode } from '../lib/remote-access-cli.mjs';
import { connectBrowserCLI } from '../lib/browser-cli.mjs';
import { executeDesktopRestartCLI } from '../lib/desktop-restart-cli.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-runtime-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, 'real'), alias = path.join(root, 'alias'), other = path.join(root, 'other');
  const profile = path.join(root, 'profile');
  await Promise.all([real, other, profile].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(real, 'BLACKICE.exe'), 'fixture executable; never launched');
  await fs.writeFile(path.join(other, 'BLACKICE.exe'), 'fixture executable; never launched');
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const executable = path.join(alias, 'BLACKICE.exe'), canonical = await fs.realpath(path.join(real, 'BLACKICE.exe'));
  assert.notEqual(executable.toLowerCase(), canonical.toLowerCase());
  assert.equal(await fs.realpath(executable), canonical);
  const now = Date.now(), url = 'http://127.0.0.1:21567';
  const runtime = { pid: 43210, executable, startedAt: '2026-11-22T00:00:00.000Z',
    version: '2.40.73', url, profileMode: 'custom', capabilities: { electron: true } };
  const observed = { pid: runtime.pid, executable: canonical, startedAt: runtime.startedAt,
    listeners: [{ address: '127.0.0.1', pid: runtime.pid }] };
  const runtimeFile = path.join(profile, 'desktop-runtime.json'), bytes = Buffer.from(JSON.stringify(runtime, null, 2));
  await fs.writeFile(runtimeFile, bytes);
  const calls = [], state = { inspections: 0, change: null, rewriteOnStatus: false };
  const remote = { client: 'local', localManagement: true, enabled: true, state: 'ready', url: 'https://blackice.example.test:8443' };
  const context = {
    platform: process.platform, defaultProfile: profile, expectedExecutable: executable, env: {}, now: () => now,
    // These are synthetic process facts; path resolution always uses the real filesystem.
    inspectRuntime: async () => {
      state.inspections++;
      const value = structuredClone(observed);
      return state.change?.(value, state.inspections) ?? value;
    },
    fetchImpl: async (target, options) => {
      const route = new URL(target).pathname; calls.push({ route, method: options.method || 'GET', body: options.body });
      if (route === '/health') return json({ app: 'relay-agent-harness', ok: true });
      if (route === '/') return new Response('<!doctype html><title>Fixture</title>',
        { headers: { 'set-cookie': 'relay_session_21567=' + 'a'.repeat(64) + '; HttpOnly; SameSite=Strict; Path=/' } });
      if (route === '/api/status') {
        if (state.rewriteOnStatus) await fs.writeFile(runtimeFile, JSON.stringify({ ...runtime, startedAt: '2026-11-22T00:00:01.000Z' }));
        return json({ app: 'relay-agent-harness', version: runtime.version, desktopApp: true,
          installPath: path.dirname(executable), remoteAccess: remote,
          desktopLifecycle: { available: true, localManagement: true, mode: 'headless' } });
      }
      if (route === '/api/remote-access/pair') {
        const code = Array(8).fill('ABCD').join('-');
        return json({ kind: 'browser', scopes: [], code, expiresAt: new Date(now + 300000).toISOString(),
          sessionExpiresAt: new Date(now + 3600000).toISOString(), status: remote,
          pairUrl: remote.url + '/#code=' + encodeURIComponent(code) });
      }
      if (route === '/api/desktop/restart') {
        const input = JSON.parse(options.body);
        return json({ protocol: 1, acknowledged: true, receipt: { id: 'fixture-restart', ownerId: 'local',
          jobId: null, requestId: input.requestId, status: 'scheduled', durable: true } });
      }
      throw Error('Unexpected fixture route: ' + route);
    },
  };
  return { root, real, alias, other, profile, runtime, observed, runtimeFile, bytes, canonical, calls, state, context };
}
const invoke = (kind, f) => kind === 'browser'
  ? connectBrowserCLI({ 'profile-dir': f.profile }, f.context)
  : createAccessCode({ profileDir: f.profile, kind: 'browser', scopes: [] }, f.context);
const unchanged = async f => assert.deepEqual(await fs.readFile(f.runtimeFile), f.bytes);

test('real directory junction resolves both executable aliases without modifying records or the pure validator', async t => {
  const f = await fixture(t), original = structuredClone({ runtime: f.runtime, observed: f.observed });
  assert.throws(() => validateRuntimeOwnership(f.runtime, f.observed), { code: 'ACCESS_RUNTIME_OWNERSHIP' });
  await validateRuntimeFileOwnership(f.runtime, f.observed);
  const second = path.join(f.root, 'second-alias');
  await fs.symlink(f.real, second, process.platform === 'win32' ? 'junction' : 'dir');
  await validateRuntimeFileOwnership(f.runtime, { ...f.observed, executable: path.join(second, 'BLACKICE.exe') });
  assert.deepEqual({ runtime: f.runtime, observed: f.observed }, original);
  await unchanged(f);
});
test('equal lexical paths retain the previous pure validation behavior without new filesystem requirements', async () => {
  const executable = path.resolve('nonexistent-owned-process-fixture', 'BLACKICE.exe');
  const runtime = { pid: 22, executable, startedAt: '2026-11-22T00:00:00.000Z' };
  const observed = { ...runtime, listeners: [{ pid: 22, address: '127.0.0.1' }] };
  validateRuntimeOwnership(runtime, observed);
  await validateRuntimeFileOwnership(runtime, observed);
  await assert.rejects(validateRuntimeFileOwnership(runtime, { ...observed, pid: 23 }), { code: 'ACCESS_RUNTIME_OWNERSHIP' });
});
test('different real targets are rejected even when their file bytes and basenames match', async t => {
  const f = await fixture(t);
  assert.deepEqual(await fs.readFile(f.canonical), await fs.readFile(path.join(f.other, 'BLACKICE.exe')));
  await assert.rejects(validateRuntimeFileOwnership(f.runtime, { ...f.observed, executable: path.join(f.other, 'BLACKICE.exe') }),
    { code: 'ACCESS_RUNTIME_OWNERSHIP' });
  await unchanged(f);
});
test('a missing target and a broken recorded junction fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(validateRuntimeFileOwnership(f.runtime, { ...f.observed, executable: path.join(f.other, 'missing.exe') }),
    { code: 'ACCESS_RUNTIME_OWNERSHIP' });
  await fs.rm(f.real, { recursive: true });
  await assert.rejects(validateRuntimeFileOwnership(f.runtime, f.observed), { code: 'ACCESS_RUNTIME_OWNERSHIP' });
  await unchanged(f);
});
const failures = [
  ['array observation with attached process fields', value => Object.assign([], value)],
  ['wrong PID', (value, f) => { value.pid = f.runtime.pid + 1; }],
  ['wrong start time', value => { value.startedAt = '2026-11-22T00:00:06.000Z'; }],
  ['invalid start time', value => { value.startedAt = 'invalid'; }],
  ['empty listeners', value => { value.listeners = []; }],
  ['foreign listener PID', (value, f) => { value.listeners[0].pid = f.runtime.pid + 1; }],
  ['non-loopback listener', value => { value.listeners[0].address = '0.0.0.0'; }],
  ['different canonical executable', (value, f) => { value.executable = path.join(f.other, 'BLACKICE.exe'); }],
  ['missing executable', (value, f) => { value.executable = path.join(f.other, 'missing.exe'); }],
];
for (const kind of ['browser', 'access']) {
  test(kind + ' uses actual canonical validation at both session checks and preserves runtime bytes', async t => {
    const f = await fixture(t);
    const result = await invoke(kind, f);
    assert.equal(f.state.inspections, 2);
    if (kind === 'browser') assert.deepEqual(result.runtime, await readAccessRuntime(f.profile, f.context));
    else assert.equal(result.ok, true);
    assert.equal(f.calls.filter(row => row.method === 'POST').length, kind === 'access' ? 1 : 0);
    await unchanged(f);
  });
  for (const at of [1, 2]) for (const [name, change] of failures) {
    test(kind + ' check ' + at + ' rejects ' + name + ' despite a same-file alias on the other check', async t => {
      const f = await fixture(t);
      f.state.change = (value, index) => { if (index === at) return change(value, f); };
      await assert.rejects(invoke(kind, f), { code: 'ACCESS_RUNTIME_OWNERSHIP' });
      assert.equal(f.state.inspections, at);
      assert.equal(f.calls.filter(row => row.method === 'POST').length, 0);
      if (at === 1) assert.equal(f.calls.length, 0);
      await unchanged(f);
    });
  }
  test(kind + ' retains the original expected invocation-path check', async t => {
    const f = await fixture(t); f.context.expectedExecutable = f.canonical;
    await assert.rejects(invoke(kind, f), { code: 'ACCESS_RUNTIME_INVALID' });
    assert.equal(f.state.inspections, 0); assert.equal(f.calls.length, 0);
    await unchanged(f);
  });
  test(kind + ' still rejects runtime-record changes during session establishment', async t => {
    const f = await fixture(t); f.state.rewriteOnStatus = true;
    await assert.rejects(invoke(kind, f), { code: kind === 'browser' ? 'BROWSER_CLI_RUNTIME' : 'ACCESS_RUNTIME_CHANGED' });
    assert.equal(f.calls.filter(row => row.method === 'POST').length, 0);
    assert.equal(f.state.inspections, 1);
    assert.equal(JSON.parse(await fs.readFile(f.runtimeFile, 'utf8')).startedAt, '2026-11-22T00:00:01.000Z');
  });
}
test('normal restart delegates through both verified alias checks with the original stable request ID', async t => {
  const f = await fixture(t), requestId = 'junction-normal-restart-fixture';
  const result = await executeDesktopRestartCLI({ action: 'restart', 'request-id': requestId, 'profile-dir': f.profile }, f.context);
  assert.equal(result.receipt.requestId, requestId); assert.equal(result.receipt.status, 'scheduled');
  assert.equal(f.state.inspections, 2);
  const posts = f.calls.filter(row => row.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].route, '/api/desktop/restart');
  assert.deepEqual(JSON.parse(posts[0].body), { requestId });
  await unchanged(f);
});
