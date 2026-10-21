import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadBrowserCompatibility } from '../desktop/browser-compatibility.mjs';

const source = await readFile(new URL('../desktop/browser-compatibility/main.js', import.meta.url), 'utf8');
const install = context => vm.runInContext(source, context);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const context = vm.createContext({});
  vm.runInContext(`
    class PublicKeyCredential {}
    let conditionalCalls = 0, capabilityCalls = 0;
    const originalCapabilities = Object.freeze({ conditionalGet: true, conditionalCreate: true, userVerifyingPlatformAuthenticator: true, hybridTransport: false, extension: 'preserved' });
    Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { configurable: true, writable: true, enumerable: false, value: async function isConditionalMediationAvailable() { conditionalCalls++; return true; } });
    Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', { configurable: true, writable: true, enumerable: true, value: async function getClientCapabilities() { capabilityCalls++; return originalCapabilities; } });
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
    class CredentialsContainer { get(options) { return options; } create(options) { return options; } }
    const navigator = { credentials: new CredentialsContainer() };
    Object.assign(globalThis, { PublicKeyCredential, CredentialsContainer, navigator });
    const originals = { get: CredentialsContainer.prototype.get, create: CredentialsContainer.prototype.create, platform: PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable };
  `, context);
  return context;
}

test('the main-world correction disables only conditional get capability and retains explicit authentication methods', async () => {
  const context = fixture();
  install(context);
  assert.equal(await vm.runInContext('PublicKeyCredential.isConditionalMediationAvailable()', context), false);
  assert.equal(vm.runInContext('conditionalCalls', context), 0);
  const capabilities = await vm.runInContext('PublicKeyCredential.getClientCapabilities()', context);
  assert.deepEqual(plain(capabilities), { conditionalGet: false, conditionalCreate: true, userVerifyingPlatformAuthenticator: true, hybridTransport: false, extension: 'preserved' });
  assert.equal(vm.runInContext('capabilityCalls', context), 1);
  assert.equal(vm.runInContext('originalCapabilities.conditionalGet', context), true, 'Do not mutate the native capability record.');
  assert.equal(vm.runInContext('CredentialsContainer.prototype.get === originals.get && CredentialsContainer.prototype.create === originals.create && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === originals.platform', context), true);
  const options = { publicKey: { challenge: 'owned-unit-fixture' }, mediation: 'required' };
  context.options = options;
  assert.equal(vm.runInContext('navigator.credentials.get(options)', context), options);
  assert.equal(vm.runInContext('navigator.credentials.create(options)', context), options);
});

test('capability forwarding preserves receiver, arguments, and native failures', async () => {
  const context = fixture();
  vm.runInContext(`
    const receiver = { owned: true }, argument = { owned: true }, failure = new Error('Owned capability failure');
    PublicKeyCredential.getClientCapabilities = function(...args) { globalThis.received = { receiver: this, args }; return Promise.reject(failure); };
  `, context);
  install(context);
  await assert.rejects(vm.runInContext('PublicKeyCredential.getClientCapabilities.call(receiver, argument)', context), value => value === vm.runInContext('failure', context));
  assert.equal(vm.runInContext('received.receiver === receiver && received.args.length === 1 && received.args[0] === argument', context), true);

  const synchronous = fixture();
  vm.runInContext("const failure = new TypeError('Owned synchronous failure'); PublicKeyCredential.getClientCapabilities = function() { throw failure; };", synchronous);
  install(synchronous);
  assert.throws(() => vm.runInContext('PublicKeyCredential.getClientCapabilities()', synchronous), value => value === vm.runInContext('failure', synchronous));
});

test('the correction preserves property attributes and does not invent unavailable WebAuthn APIs', async () => {
  const context = fixture();
  install(context);
  assert.deepEqual(plain(vm.runInContext("const { value, ...attributes } = Object.getOwnPropertyDescriptor(PublicKeyCredential, 'isConditionalMediationAvailable'); attributes", context)), { writable: true, enumerable: false, configurable: true });
  assert.deepEqual(plain(vm.runInContext("const { value: ignored, ...capabilityAttributes } = Object.getOwnPropertyDescriptor(PublicKeyCredential, 'getClientCapabilities'); capabilityAttributes", context)), { writable: true, enumerable: true, configurable: true });
  install(context);
  assert.equal((await vm.runInContext('PublicKeyCredential.getClientCapabilities()', context)).conditionalGet, false);
  assert.equal(vm.runInContext('capabilityCalls', context), 1);

  for (const initial of ['', 'globalThis.PublicKeyCredential = class PublicKeyCredential {};']) {
    const absent = vm.createContext({}); vm.runInContext(initial, absent);
    const before = vm.runInContext('Reflect.ownKeys(globalThis).length', absent);
    install(absent);
    assert.equal(vm.runInContext('Reflect.ownKeys(globalThis).length', absent), before);
    assert.equal(vm.runInContext("typeof globalThis.PublicKeyCredential?.isConditionalMediationAvailable", absent), 'undefined');
    assert.equal(vm.runInContext("typeof globalThis.PublicKeyCredential?.getClientCapabilities", absent), 'undefined');
  }
});

test('the page-world installer exposes no global bridge and the manifest covers first scripts in matching frames', async () => {
  const context = fixture(), globalsBefore = vm.runInContext('Reflect.ownKeys(globalThis).length', context);
  install(context);
  assert.equal(await vm.runInContext('PublicKeyCredential.isConditionalMediationAvailable()', context), false);
  assert.equal(vm.runInContext('Reflect.ownKeys(globalThis).length', context), globalsBefore);
  assert.equal(vm.runInContext("typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'", context), true);
  const manifest = JSON.parse(await readFile(new URL('../desktop/browser-compatibility/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://*/*', 'https://*/*'], js: ['main.js'], run_at: 'document_start', world: 'MAIN', all_frames: true, match_about_blank: true, match_origin_as_fallback: true }]);
  assert.deepEqual(Object.keys(manifest).sort(), ['content_scripts', 'description', 'manifest_version', 'name', 'version']);
  assert.match(await readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'), /^  - desktop\/browser-compatibility\/\*\*\/\*$/m);
});

test('compatibility loading is scoped to the supplied session and reused across driver lifecycles', async () => {
  const calls = [], extension = { id: 'owned-compatibility-extension' };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const browserSession = { extensions: { loadExtension: (...args) => { calls.push(args); return pending; } } };
  const first = loadBrowserCompatibility(browserSession), second = loadBrowserCompatibility(browserSession);
  assert.equal(second, first); await Promise.resolve();
  assert.deepEqual(calls, [[fileURLToPath(new URL('../desktop/browser-compatibility/', import.meta.url))]]);
  release(extension); assert.equal(await first, extension);
  assert.equal(loadBrowserCompatibility(browserSession), first);
  const other = { extensions: { loadExtension: async () => { calls.push('other-session'); return extension; } } };
  await loadBrowserCompatibility(other);
  assert.equal(calls.length, 2); assert.equal(calls[1], 'other-session');
});

test('missing extension support or a failed load fails closed without retrying installation', async () => {
  let calls = 0;
  const failure = new Error('Owned fixture manifest failure');
  for (const browserSession of [{}, { extensions: { loadExtension: async () => { calls++; throw failure; } } }]) {
    const first = loadBrowserCompatibility(browserSession);
    await assert.rejects(first, value => value.code === 'BROWSER_COMPATIBILITY_UNAVAILABLE' && value.actionDispatched === false && /Remote pages remain blocked/.test(value.message));
    assert.equal(loadBrowserCompatibility(browserSession), first);
    await assert.rejects(loadBrowserCompatibility(browserSession), { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE' });
  }
  assert.equal(calls, 1);
});

test('a stalled extension load has a bounded failure and a late completion does not retry or report ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, calls = 0;
  const browserSession = { extensions: { loadExtension: () => { calls++; return new Promise(resolve => { release = resolve; }); } } };
  const pending = loadBrowserCompatibility(browserSession);
  const rejected = assert.rejects(pending, { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE', actionDispatched: false });
  await Promise.resolve(); t.mock.timers.tick(10000); await rejected;
  release({ id: 'owned-late-extension' });
  assert.equal(loadBrowserCompatibility(browserSession), pending);
  await assert.rejects(pending, { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE' });
  assert.equal(calls, 1);
});
