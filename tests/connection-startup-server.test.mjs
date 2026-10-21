import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable, PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { createDesktopConnectionStartup, loginStartupInspectScript, scheduledStartupInspectScript, startupLoginSpec, TAILSCALE_STARTUP_INSPECT } from '../desktop/connection-startup.mjs';

const action = '/api/chatgpt-connector/enable-startup';
const tick = () => new Promise(resolve => setImmediate(resolve));
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const startup = overrides => ({ available: true, ready: false, canEnable: true, checkedAt: '2026-10-21T12:00:00.000Z', checks: [
  { key: 'tailscale', label: 'Tailscale at Windows boot', ok: false, detail: 'Service is running automatically; unattended mode is off.' },
  { key: 'blackice', label: 'BLACKICE at Windows sign-in', ok: true, detail: 'Existing sign-in configuration is enabled.' },
], ...overrides });
class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, activeTurns: 0, models: [] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { assert.fail('Startup settings must not start a model.'); }
}
class ResponseCapture extends Writable {
  constructor() { super(); this.headers = {}; this.parts = []; this.statusCode = 200; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); this.headersSent = true; }
  _write(part, _encoding, done) { this.parts.push(Buffer.from(part)); done(); }
}
async function fixture(t, connectionStartup) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-startup-api-'));
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const app = await createHarnessServer({ port: 0, runtime: new Runtime(), desktop, connectionStartup, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), remoteAccess: false, autoAttachDesktop: false, emailExecutableHint: null });
  t.after(async () => { app.endRestart(); app.endMaintenance(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  // Exercise the actual server request handler without a network listener.
  // Existing connector HTTP tests cover the Node socket and remote gateway.
  const handler = app.server.listeners('request')[0]; let cookie;
  const request = async (url, { body, headers = {}, authenticated = true, method = body === undefined ? 'GET' : 'POST', stream } = {}) => {
    const content = body === undefined ? undefined : JSON.stringify(body);
    const req = stream || Readable.from(content === undefined ? [] : [Buffer.from(content)]);
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:0', ...(authenticated && cookie ? { cookie } : {}), ...(content === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(content)) }), ...headers };
    const res = new ResponseCapture(); await handler(req, res);
    const text = Buffer.concat(res.parts).toString(); let value = text;
    if (res.headers['content-type']?.includes('application/json')) value = JSON.parse(text);
    return { status: res.statusCode, data: value, headers: res.headers, text };
  };
  const home = await request('/'); cookie = home.headers['set-cookie'].split(';')[0];
  return { app, request };
}

test('desktop login adapter verifies the named registry entry despite Electron 44 getter limitations', async () => {
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const source = /const connectionStartup = createDesktopConnectionStartup\([\s\S]+?\n  \}\);/.exec(main)?.[0];
  assert.ok(source, 'Exercise the actual desktop startup adapter without launching Electron.');
  const executable = 'C:\\Program Files\\Agent Desk\\Agent Desk.exe', profileDir = 'C:\\Users\\Test User\\AppData\\Roaming\\BLACKICE Profile';
  const expectedArgs = ['--background', '--profile-dir', profileDir], effects = [];
  const spec = startupLoginSpec({ executable, profileDir });
  let registered = null, proofMode = 'exact', registryReads = 0;
  const electron = {
    isPackaged: true,
    getPath: name => { assert.equal(name, 'userData'); return profileDir; },
    getLoginItemSettings: options => {
      effects.push('inspect');
      assert.equal(options.path, `"${executable}"`, 'Electron 44 splits an unquoted executable containing spaces.');
      assert.deepEqual(options.args, expectedArgs);
      // Electron 44 reads openAtLogin from its default AppUserModelID, ignoring
      // our custom registry name. Its launchItems args use Chromium GetArgs(),
      // which omits switches. Neither field proves this exact startup command.
      return { openAtLogin: false, executableWillLaunchAtLogin: Boolean(registered), launchItems: registered ? [{ name: registered.name, path: registered.path, args: [profileDir], enabled: true, scope: 'user' }] : [] };
    },
    setLoginItemSettings: options => {
      effects.push('enable');
      assert.equal(options.path, executable, 'The setter receives a plain executable path.');
      assert.deepEqual(options.args, expectedArgs); assert.equal(options.openAtLogin, true); assert.equal(options.enabled, true);
      assert.match(options.name, /^BLACKICE-[0-9a-f]{16}$/); registered = options;
    },
  };
  const factory = options => createDesktopConnectionStartup({ ...options, runPowerShell: async (script, runOptions = {}) => {
    assert.notEqual(runOptions.mutation, true, 'Already configured Tailscale must remain untouched.');
    if (script === TAILSCALE_STARTUP_INSPECT) return JSON.stringify({ installed: true, servicePresent: true, serviceAutomatic: true, serviceRunning: true, supported: true, unattended: true, connected: true });
    if (script === loginStartupInspectScript(spec)) {
      registryReads++;
      return JSON.stringify({ entryExists: Boolean(registered), commandMatches: Boolean(registered) && proofMode !== 'different-command', approval: proofMode === 'disabled' ? 'disabled' : proofMode === 'unknown-approval' ? 'unknown' : 'enabled' });
    }
    assert.equal(script, scheduledStartupInspectScript(spec), 'Only the fixed read-only startup probes may run.');
    return '{"relatedTask":false}';
  } });
  const manager = new Function('createDesktopConnectionStartup', 'process', 'app', 'APP_DIR', `${source}\nreturn connectionStartup;`)(factory, { platform: 'win32', execPath: executable }, electron, 'C:\\Program Files\\Agent Desk\\resources\\app');
  assert.equal((await manager.snapshot()).ready, false); assert.deepEqual(effects, ['inspect']); assert.equal(registryReads, 1);
  assert.equal((await manager.enable()).ready, true); assert.equal(effects.filter(effect => effect === 'enable').length, 1);
  assert.ok(registryReads >= 3, 'Setup checks the actual named entry before and after the setter.');
  await manager.enable(); assert.equal(effects.filter(effect => effect === 'enable').length, 1, 'Repeated setup does not add a duplicate sign-in entry.');
  for (proofMode of ['different-command', 'disabled', 'unknown-approval']) {
    const state = await manager.snapshot({ refresh: true });
    assert.equal(state.ready, false, `A ${proofMode} registry entry cannot be verified by executableWillLaunchAtLogin.`);
    assert.equal(state.canEnable, false, 'An existing ambiguous or disabled entry must be preserved.');
    await assert.rejects(manager.enable(), { code: 'CONNECTION_STARTUP_UNAVAILABLE' });
    assert.equal(effects.filter(effect => effect === 'enable').length, 1);
  }
});

test('connector startup reads remain side-effect-free and separate from current connection settings', async t => {
  let reads = 0, changes = 0;
  const f = await fixture(t, { async snapshot() { reads++; return startup(); }, async enable() { changes++; } });
  const oauth = await f.app.chatGPTOAuth.status();
  for (let index = 0; index < 3; index++) {
    const response = await f.request('/api/chatgpt-connector'); assert.equal(response.status, 200);
    assert.equal(response.data.startup.ready, false); assert.equal(response.data.startup.busy, false);
    assert.match(response.data.startup.checks[0].detail, /running automatically/);
    assert.equal(response.data.enabled, false); assert.equal(response.data.setup.ready, false);
  }
  assert.equal(reads, 3); assert.equal(changes, 0);
  assert.deepEqual(await f.app.chatGPTOAuth.status(), oauth); assert.equal(f.app.engine.listRuns().length, 0);
});

test('explicit startup requests coalesce and pending Windows work blocks restart until actual settlement', async t => {
  const entered = held(), finish = held(); let changes = 0, current = startup();
  const f = await fixture(t, { async snapshot() { return structuredClone(current); }, async enable() { changes++; entered.resolve(); await finish.promise; current = startup({ ready: true, canEnable: false, checks: current.checks.map(check => ({ ...check, ok: true })) }); } });
  const before = await f.app.chatGPTOAuth.status();
  const first = f.request(action, { body: {} }); await entered.promise;
  const second = f.request(action, { body: {} }); await tick();
  try {
    assert.equal(changes, 1);
    assert.equal((await f.request('/api/chatgpt-connector')).data.startup.busy, true);
    await assert.rejects(f.app.assertRestartReady(), { code: 'DESKTOP_RESTART_BUSY' });
    await assert.rejects(f.app.beginRestart(), { code: 'DESKTOP_RESTART_BUSY' });
    assert.equal(Boolean(f.app.engine.maintenanceRequested), false);
  } finally { finish.resolve(); }
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200); assert.equal(response.data.startup.ready, true); assert.equal(response.data.startup.busy, false);
    assert.equal(response.data.enabled, false, 'startup changes do not enable or republish connector access');
  }
  assert.equal(changes, 1); assert.deepEqual(await f.app.chatGPTOAuth.status(), before);
  await f.app.assertRestartReady();
});

test('startup enable retains local session, origin, query, method and exact empty-body guards', async t => {
  let changes = 0; const f = await fixture(t, { async snapshot() { return startup(); }, async enable() { changes++; } });
  assert.equal((await f.request(action, { body: {}, authenticated: false })).status, 401);
  for (const headers of [{ 'x-blackice-remote': '1' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'unrecognized.invalid' }]) assert.equal((await f.request(action, { body: {}, headers })).status, 403);
  assert.equal((await f.request(action)).status, 404);
  assert.equal((await f.request(action + '?', { body: {} })).status, 400);
  for (const body of [[], null, { command: 'anything' }, { confirm: true }]) assert.equal((await f.request(action, { body })).status, 400);
  assert.equal(changes, 0);
});

test('maintenance waits for admitted startup work and rejects a late body or another setup request', async t => {
  const entered = held(), finish = held(); let changes = 0;
  const f = await fixture(t, { async snapshot() { return startup(); }, async enable() { changes++; entered.resolve(); await finish.promise; } });
  const first = f.request(action, { body: {} }); await entered.promise;
  const stream = new PassThrough(), late = f.request(action, { body: {}, stream }); stream.write('{'); await tick();
  let drained = false; const maintenance = f.app.beginMaintenance().then(() => { drained = true; }); await tick();
  try {
    assert.equal(drained, false); stream.end('}'); assert.equal((await late).status, 503);
    assert.equal((await f.request(action, { body: {} })).status, 503); assert.equal(changes, 1);
    assert.equal((await f.request('/api/chatgpt-connector')).status, 200);
  } finally { finish.resolve(); }
  assert.equal((await first).status, 200); await maintenance; assert.equal(drained, true);
});

test('startup inspection failure does not break connector status or expose command output', async t => {
  const f = await fixture(t, { async snapshot() { throw Error('PRIVATE_NATIVE_OUTPUT'); } });
  const response = await f.request('/api/chatgpt-connector'); assert.equal(response.status, 200);
  assert.equal(response.data.startup.ready, false); assert.equal(response.data.startup.canEnable, false);
  assert.match(response.data.startup.checks[0].detail, /could not be verified/); assert.doesNotMatch(response.text, /PRIVATE_NATIVE_OUTPUT/);
  assert.equal((await f.request(action, { body: {} })).status, 409);
});

test('shutdown waits for the admitted startup helper and never requests a second operation', async t => {
  const entered = held(), finish = held(); let changes = 0;
  const f = await fixture(t, { async snapshot() { return startup(); }, async enable() { changes++; entered.resolve(); await finish.promise; } });
  const first = f.request(action, { body: {} }); await entered.promise;
  let closed = false; const closing = f.app.close().then(() => { closed = true; }); await tick();
  try {
    assert.equal(closed, false); assert.equal((await f.request(action, { body: {} })).status, 503);
    assert.equal(changes, 1);
  } finally { finish.resolve(); }
  assert.equal((await first).status, 200); await closing; assert.equal(closed, true);
});
