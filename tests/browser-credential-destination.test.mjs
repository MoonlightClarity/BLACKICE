import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BrowserCredentialDestination } from '../lib/browser-credential-destination.mjs';
import { credentialTemporaryProtection } from '../lib/credential-temp-protection.mjs';

const env = { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
const ordinary = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false };
const options = { env, platform: 'win32', lstat: async () => ordinary, realpath: async value => value };
const nativeChild = () => { const child = new EventEmitter(); child.unref = () => {}; return child; };

test('password destinations inspect fixed installation metadata without reading stores or launching', async () => {
  const reads = [];
  const bridge = new BrowserCredentialDestination({ ...options, lstat: async name => { reads.push(name); return ordinary; }, launch: () => assert.fail('Status cannot launch') });
  const status = await bridge.status();
  assert.equal(status.length, 3); assert.ok(status.every(item => item.available && !item.automaticImport));
  assert.ok(reads.every(name => /chrome\.exe$|firefox\.exe$|BrowserClaw\\User Data$/.test(name)));
  assert.doesNotMatch(JSON.stringify(status), /Users|Program Files|Login Data|logins.json/);
});

test('each explicit handoff launches only its fixed native page and never claims an import', async () => {
  const calls = [];
  const bridge = new BrowserCredentialDestination({ ...options, launch: (file, args, opts) => { calls.push({ file, args, opts }); const child = nativeChild(); queueMicrotask(() => child.emit('spawn')); return child; } });
  for (const id of ['chrome', 'firefox', 'neo']) {
    const result = await bridge.open(id, { source: 'user' });
    assert.equal(result.destinationId, id); assert.equal(result.importCompleted, false); assert.equal(result.profileVerified, false); assert.equal(result.windowVerified, false);
  }
  assert.equal(calls[0].args.at(-1), 'chrome://password-manager/settings');
  assert.deepEqual(calls[1].args, ['--new-tab', 'about:logins']);
  assert.ok(calls[2].args.includes('--user-data-dir=C:\\Users\\fixture\\AppData\\Local\\BrowserClaw\\User Data'));
  assert.ok(calls.every(call => call.opts.shell === false && call.opts.detached === true));
  assert.doesNotMatch(JSON.stringify(calls), /\.csv|--import|remote-debugging|password=|--headless/);
});

test('remote callers, arbitrary destinations, missing and redirected installations cannot launch', async () => {
  const bridge = new BrowserCredentialDestination({ ...options, launch: () => assert.fail('Must not launch') });
  for (const source of [undefined, 'remote', 'agent']) await assert.rejects(bridge.open('chrome', { source }), { status: 403 });
  await assert.rejects(bridge.open('C:\\custom.exe', { source: 'user' }), { status: 400 });
  for (const override of [{ platform: 'linux' }, { realpath: async () => 'C:\\redirected.exe' }, { lstat: async () => ({ ...ordinary, isSymbolicLink: () => true }) }]) {
    const invalid = new BrowserCredentialDestination({ ...options, ...override, launch: () => assert.fail('Must not launch') });
    await assert.rejects(invalid.open('chrome', { source: 'user' }), { code: 'CREDENTIAL_DESTINATION_UNAVAILABLE' });
  }
});

test('concurrent handoffs share one native dispatch and close never terminates the user browser', async () => {
  let calls = 0; const child = nativeChild(); child.kill = () => assert.fail('Browser is not owned');
  let launched; const started = new Promise(resolve => { launched = resolve; });
  const bridge = new BrowserCredentialDestination({ ...options, launch: () => { calls++; launched(); return child; } });
  const one = bridge.open('chrome', { source: 'user' }), two = bridge.open('chrome', { source: 'user' });
  await started; const closing = bridge.close(); child.emit('spawn');
  assert.deepEqual(await one, await two); await closing; assert.equal(calls, 1);
  await assert.rejects(bridge.open('chrome', { source: 'user' }), { code: 'CREDENTIAL_DESTINATION_CLOSED' });
});

test('native launch failures and uncertain acknowledgement never become import success', async () => {
  const bridge = new BrowserCredentialDestination({ ...options, timeoutMs: 100, launch: () => nativeChild() });
  await assert.rejects(bridge.open('chrome', { source: 'user' }), { code: 'CREDENTIAL_DESTINATION_UNCERTAIN' });
  const failure = new BrowserCredentialDestination({ ...options, launch: () => { const child = nativeChild(); queueMicrotask(() => child.emit('error', new Error('private launch context'))); return child; } });
  await assert.rejects(failure.open('chrome', { source: 'user' }), error => error.code === 'CREDENTIAL_DESTINATION_LAUNCH_FAILED' && !error.message.includes('private'));
});

test('temporary Windows export protection removes inheritance and grants the actual OS user before use', async () => {
  const calls = [], dataDir = 'C:\\Users\\fixture\\data', directory = dataDir + '\\browser-credentials\\owned\\exports\\batch';
  const protect = credentialTemporaryProtection({ dataDir, env, platform: 'win32', io: { lstat: async () => ordinary, realpath: async value => value }, execute: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: file.endsWith('whoami.exe') ? '"fixture","S-1-5-21-11-22-33-1001"' : '' }; } });
  assert.deepEqual(await protect(directory), { protected: true, method: 'windows-user-acl' });
  assert.deepEqual(calls[1].args, [path.win32.toNamespacedPath(directory), '/inheritance:r', '/grant:r', '*S-1-5-21-11-22-33-1001:(OI)(CI)F']);
  assert.ok(calls.every(call => call.opts.shell === false && call.opts.timeout === 5000));
  await assert.rejects(protect('C:\\other\\export'), { code: 'CREDENTIAL_EXPORT_PROTECTION' });
  assert.equal(calls.length, 2);
});

test('temporary export ACL dispatch preserves a long owned path in Windows extended-length form', async () => {
  const dataDir = 'C:\\owned', directory = dataDir + '\\' + 'nested\\'.repeat(38) + 'export';
  let protectedTarget;
  const protect = credentialTemporaryProtection({ dataDir, env, platform: 'win32', io: { lstat: async () => ordinary, realpath: async value => value }, execute: async (file, args) => {
    if (file.endsWith('whoami.exe')) return { stdout: '"fixture","S-1-5-21-11-22-33-1001"' };
    protectedTarget = args[0]; return { stdout: '' };
  } });
  assert.ok(directory.length > 260);
  assert.equal((await protect(directory)).protected, true);
  assert.equal(protectedTarget, '\\\\?\\' + directory);
  assert.equal(path.win32.normalize(protectedTarget.slice(4)), path.win32.normalize(directory));
});

test('unknown user identity, linked directories or ACL errors fail closed before an export is permitted', async () => {
  const base = { dataDir: 'C:\\owned', env, platform: 'win32', io: { lstat: async () => ordinary, realpath: async value => value } };
  for (const execute of [async () => ({ stdout: '' }), async () => { throw Error('denied'); }]) await assert.rejects(credentialTemporaryProtection({ ...base, execute })('C:\\owned\\batch'), { code: 'CREDENTIAL_EXPORT_PROTECTION' });
  await assert.rejects(credentialTemporaryProtection({ ...base, io: { lstat: async () => ({ ...ordinary, isSymbolicLink: () => true }) }, execute: () => assert.fail('No ACL on linked target') })('C:\\owned\\batch'), { code: 'CREDENTIAL_EXPORT_PROTECTION' });
});
