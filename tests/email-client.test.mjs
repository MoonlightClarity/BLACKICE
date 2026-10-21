import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EmailClientBridge } from '../lib/email-client.mjs';

const executable = 'C:\\Program Files\\Mozilla Thunderbird\\thunderbird.exe';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [], probes = [], children = [];
  const bridge = new EmailClientBridge({
    platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' },
    lstat: async file => { probes.push(file); if (file !== executable) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false }; },
    realpath: async file => file,
    launch(file, args, options) {
      calls.push({ file, args, options });
      const child = new EventEmitter(); child.unrefs = 0; child.kills = 0;
      child.unref = () => { child.unrefs++; }; child.kill = () => { child.kills++; };
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...overrides
  });
  return { bridge, calls, probes, children };
}

test('availability inspects only fixed executable metadata and never launches or reports account reuse', async () => {
  const f = fixture();
  assert.deepEqual(await f.bridge.status(), { id: 'thunderbird', name: 'Thunderbird', supported: true, available: true, capabilities: { open: true, compose: true }, handoff: 'native-app', accountReuse: false });
  assert.deepEqual(f.probes, [executable]); assert.deepEqual(f.calls, []);
  await f.bridge.close();
  assert.deepEqual((await f.bridge.status()).capabilities, { open: false, compose: false });
});

test('open and empty compose use fixed arguments with no shell, mail content, or window verification claim', async () => {
  const f = fixture();
  for (const action of ['open', 'compose']) {
    assert.deepEqual(await f.bridge.open({ action }), { requested: true, action, application: 'Thunderbird', nativeWindow: true, windowVerified: false, sent: false });
  }
  assert.deepEqual(f.calls, [
    { file: executable, args: [], options: { shell: false, detached: true, windowsHide: false, stdio: 'ignore' } },
    { file: executable, args: ['-compose'], options: { shell: false, detached: true, windowsHide: false, stdio: 'ignore' } }
  ]);
  await f.bridge.close();
  for (const child of f.children) { assert.equal(child.unrefs, 1); assert.equal(child.kills, 0); }
});

test('message data, send, custom executables and extra launch arguments are rejected before filesystem or launch access', async () => {
  const f = fixture();
  for (const value of [null, [], {}, { action: 'send' }, { action: 'open', executable: 'other.exe' }, { action: 'compose', to: 'recipient@example.test' }, { action: 'compose', args: ['-profile', 'elsewhere'] }]) {
    await assert.rejects(f.bridge.open(value), error => error.code === 'EMAIL_CLIENT_ACTION' && error.status === 400);
  }
  assert.deepEqual(f.probes, []); assert.deepEqual(f.calls, []);
});

test('unsupported platforms, missing installations and redirected executable paths cannot launch', async () => {
  const unsupported = fixture({ platform: 'linux' });
  assert.equal((await unsupported.bridge.status()).supported, false);
  await assert.rejects(unsupported.bridge.open({ action: 'open' }), { code: 'EMAIL_CLIENT_UNAVAILABLE' });
  assert.deepEqual(unsupported.probes, []); assert.deepEqual(unsupported.calls, []);
  for (const overrides of [
    { lstat: async () => { throw Error('not found'); } },
    { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }) },
    { realpath: async () => 'C:\\Other\\thunderbird.exe' }
  ]) {
    const f = fixture(overrides); assert.equal((await f.bridge.status()).available, false);
    await assert.rejects(f.bridge.open({ action: 'compose' }), { code: 'EMAIL_CLIENT_UNAVAILABLE' });
    assert.deepEqual(f.calls, []);
  }
});

test('cancellation and maintenance are rechecked after asynchronous executable discovery', async () => {
  for (const kind of ['cancel', 'close']) {
    const gate = deferred(), abort = new AbortController(); let closing = false;
    const f = fixture({ realpath: async file => { await gate.promise; return file; }, isClosing: () => closing });
    const pending = f.bridge.open({ action: 'open' }, { signal: abort.signal });
    if (kind === 'cancel') abort.abort(); else closing = true;
    gate.resolve();
    await assert.rejects(pending, { code: kind === 'cancel' ? 'EMAIL_CLIENT_CANCELLED' : 'EMAIL_CLIENT_CLOSED' });
    assert.deepEqual(f.calls, []);
  }
});

test('one handoff owns admission until acknowledgment and close never terminates Thunderbird', async () => {
  const child = new EventEmitter(); let launches = 0, kills = 0, unrefs = 0;
  child.kill = () => { kills++; }; child.unref = () => { unrefs++; };
  const f = fixture({ launch: () => { launches++; return child; } });
  const pending = f.bridge.open({ action: 'compose' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.bridge.open({ action: 'compose' }), { code: 'EMAIL_CLIENT_BUSY' });
  let closed = false; const closing = f.bridge.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  child.emit('spawn'); await pending; await closing;
  assert.equal(launches, 1); assert.equal(kills, 0); assert.equal(unrefs, 1);
  await assert.rejects(f.bridge.open({ action: 'open' }), { code: 'EMAIL_CLIENT_CLOSED' });
});

test('aborting an accepted native launch returns uncertainty without killing it or swallowing a later spawn', async () => {
  const child = new EventEmitter(), controller = new AbortController(); let kills = 0, unrefs = 0;
  child.kill = () => { kills++; }; child.unref = () => { unrefs++; };
  const f = fixture({ launch: () => child });
  const pending = f.bridge.open({ action: 'compose' }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, error => error.code === 'EMAIL_CLIENT_UNCERTAIN' && error.uncertain === true);
  child.emit('spawn'); await f.bridge.close();
  assert.equal(kills, 0); assert.equal(unrefs, 1);
});

test('launch failures omit raw process details and a missing acknowledgment has a bounded uncertain result', async () => {
  const failed = fixture({ launch: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', Error('private path and diagnostic'))); return child; } });
  await assert.rejects(failed.bridge.open({ action: 'open' }), error => error.code === 'EMAIL_CLIENT_LAUNCH_FAILED' && !error.message.includes('private'));
  const pending = fixture({ launch: () => new EventEmitter(), launchTimeoutMs: 100 });
  await assert.rejects(pending.bridge.open({ action: 'open' }), error => error.code === 'EMAIL_CLIENT_UNCERTAIN' && error.uncertain === true);
  await pending.bridge.close();
});
