import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserImportBridge, NEO_IMPORT_URL } from '../lib/browser-import.mjs';

const root = 'C:\\Users\\fixture\\AppData\\Local';
const executable = root + '\\BrowserClaw\\Application\\chrome.exe';
const profile = root + '\\BrowserClaw\\User Data';
const metadata = location => ({ isFile: () => location === executable, isDirectory: () => location === profile, isSymbolicLink: () => false });
const options = { env: { LOCALAPPDATA: root }, platform: 'win32', lstat: async location => metadata(location), realpath: async location => location };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const user = { source: 'user' };
const child = () => { const value = new EventEmitter(); value.unref = () => {}; return value; };

test('Neo import status reads only the two fixed installation entries and never opens a browser', async () => {
  const reads = [];
  const bridge = new BrowserImportBridge({ ...options, lstat: async location => { reads.push(location); return metadata(location); }, launch: () => assert.fail('Status must not launch') });
  const state = await bridge.status();
  assert.deepEqual(reads, [executable, profile]);
  assert.equal(state.available, true); assert.equal(state.destination, 'neo'); assert.equal(state.capabilities.open, true);
  assert.equal(state.importVerified, false); assert.equal(state.handoff, 'native-import-dialog');
  assert.doesNotMatch(JSON.stringify(state), /fixture|User Data|chrome\.exe|cookies|passwords/);
});

test('every explicit handoff submits only the fixed native import URL, including an already-open browser', async () => {
  const calls = [];
  const bridge = new BrowserImportBridge({ ...options, launch: (file, args, settings) => {
    calls.push({ file, args, settings }); const value = child(); queueMicrotask(() => value.emit('spawn')); return value;
  } });
  const first = await bridge.open({}, user), second = await bridge.open({}, user);
  assert.deepEqual(first, { requested: true, destination: 'neo', nativeWindow: true, windowVerified: false, importCompleted: false });
  assert.deepEqual(second, first); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, executable);
    assert.deepEqual(call.args, ['--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--new-window', NEO_IMPORT_URL]);
    assert.deepEqual(call.settings, { shell: false, detached: true, windowsHide: false, stdio: 'ignore', cwd: root + '\\BrowserClaw\\Application' });
    assert.doesNotMatch(JSON.stringify(call), /remote-debugging|headless|--import|--profile-directory|cookie|password|Chrome\\\\User/);
  }
});

test('the bridge rejects non-user callers and every nonempty or nonobject request before inspection', async () => {
  const bridge = new BrowserImportBridge({ ...options, lstat: () => assert.fail('Invalid input must not inspect'), launch: () => assert.fail('Invalid input must not launch') });
  for (const source of [undefined, 'agent', 'remote']) await assert.rejects(bridge.open({}, { source }), { status: 403 });
  for (const value of [null, [], '', 1, { url: 'https://example.test' }, { cookies: true }, { executable }, { profile }, { source: 'user' }]) await assert.rejects(bridge.open(value, user), { status: 400 });
});

test('missing, redirected, linked and unsupported installations never launch or inspect profile contents', async () => {
  for (const override of [
    { platform: 'linux' }, { env: { LOCALAPPDATA: 'relative' } }, { env: { LOCALAPPDATA: '\\\\server\\share' } },
    { lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
    { lstat: async location => ({ ...metadata(location), isSymbolicLink: () => true }) },
    { realpath: async location => location === profile ? 'C:\\unexpected-profile' : location },
    { realpath: async location => location === executable ? 'C:\\unexpected.exe' : location },
  ]) {
    const bridge = new BrowserImportBridge({ ...options, ...override, launch: () => assert.fail('Invalid installation must not launch') });
    assert.equal((await bridge.status()).available, false);
    await assert.rejects(bridge.open({}, user), { code: 'BROWSER_IMPORT_UNAVAILABLE', status: 503 });
  }
});

test('concurrent clicks share installation inspection and one pending native dispatch', async () => {
  const inspected = deferred(), release = deferred(), started = deferred(); let count = 0, inspectedCount = 0;
  const value = child();
  const bridge = new BrowserImportBridge({ ...options, lstat: async location => { inspectedCount++; if (location === executable) { inspected.resolve(); await release.promise; } return metadata(location); }, launch: () => { count++; started.resolve(); return value; } });
  const one = bridge.open({}, user); await inspected.promise;
  const two = bridge.open({}, user); assert.equal(bridge.snapshot().pending, true);
  release.resolve(); await started.promise; assert.equal(count, 1); assert.equal(inspectedCount, 2);
  value.emit('spawn'); assert.deepEqual(await one, await two); assert.equal(bridge.snapshot().pending, false);
});

test('maintenance beginning during installation checks rejects before native dispatch', async () => {
  const entered = deferred(), release = deferred(); let closing = false;
  const bridge = new BrowserImportBridge({ ...options, isClosing: () => closing, lstat: async location => { entered.resolve(); await release.promise; return metadata(location); }, launch: () => assert.fail('Maintenance must prevent launch') });
  const work = bridge.open({}, user); await entered.promise; closing = true; release.resolve();
  await assert.rejects(work, { code: 'BROWSER_IMPORT_CLOSED', status: 503 });
  assert.equal(bridge.snapshot().capabilities.open, false);
});

test('shutdown waits for an admitted acknowledgement and never kills the user’s browser', async () => {
  const started = deferred(), value = child(); let closed = false;
  value.kill = () => assert.fail('Never kill Neo');
  const bridge = new BrowserImportBridge({ ...options, launch: () => { started.resolve(); return value; } });
  const work = bridge.open({}, user); await started.promise;
  const close = bridge.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(bridge.open({}, user), { code: 'BROWSER_IMPORT_CLOSED' });
  value.emit('spawn'); await work; await close; assert.equal(closed, true);
});

test('an aborted request cannot launch before or after installation checks', async () => {
  const controller = new AbortController(), release = deferred(), entered = deferred();
  const bridge = new BrowserImportBridge({ ...options, lstat: async location => { entered.resolve(); await release.promise; return metadata(location); }, launch: () => assert.fail('Cancelled request must not launch') });
  const work = bridge.open({}, { ...user, signal: controller.signal }); await entered.promise; controller.abort(); release.resolve();
  await assert.rejects(work, { code: 'BROWSER_IMPORT_CANCELLED' });
  await assert.rejects(bridge.open({}, { ...user, signal: controller.signal }), { code: 'BROWSER_IMPORT_CANCELLED' });
});

test('launch errors do not expose process details or claim an imported session', async () => {
  const bridge = new BrowserImportBridge({ ...options, launch: () => { const value = child(); queueMicrotask(() => value.emit('error', new Error('private process detail'))); return value; } });
  await assert.rejects(bridge.open({}, user), error => error.code === 'BROWSER_IMPORT_LAUNCH_FAILED' && error.status === 503 && !error.message.includes('private process detail'));
  assert.equal(bridge.snapshot().pending, false); assert.equal(bridge.snapshot().importVerified, false);
});

test('missing spawn acknowledgement is bounded and reported as uncertain without killing or retrying', async () => {
  let launches = 0; const value = child(); value.kill = () => assert.fail('A timeout must not kill Neo');
  const bridge = new BrowserImportBridge({ ...options, launchTimeoutMs: 100, launch: () => { launches++; return value; } });
  await assert.rejects(bridge.open({}, user), { code: 'BROWSER_IMPORT_UNCERTAIN', status: 504, uncertain: true });
  value.emit('spawn'); assert.equal(launches, 1); assert.equal(bridge.snapshot().pending, false);
});
