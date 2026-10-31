import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { providerKeyPage, performProviderKeySource } from '../desktop/provider-key-source.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';

const SECRET = 'synthetic_key_source_token_938751239012';
const origin = 'https://provider.example', url = `${origin}/keys`, target = { browser: 'relay', tabId: 'tab-1', origin, expectedUrl: url };
const owner = { taskId: 'task-1', runId: 'run-1', nodeId: 'node-1' };
const noSecret = value => assert.equal(JSON.stringify(value).includes(SECRET), false);
function fixture() {
  const elements = [], events = new Map(), timers = new Map(), window = { origin, location: { href: url }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  let originalWrites = 0, timerId = 0;
  const clipboard = { writeText: async () => { originalWrites++; } }, originalWrite = clipboard.writeText;
  const select = selector => selector === '*' ? elements : selector === '[role="dialog"],dialog' ? elements.filter(el => el.tagName === 'DIALOG')
    : selector === 'code,pre' ? elements.filter(el => ['CODE', 'PRE'].includes(el.tagName))
      : selector === 'button,[role="button"],input[type="button"]' ? elements.filter(el => el.tagName === 'BUTTON')
        : elements.filter(el => ['INPUT', 'TEXTAREA', 'CODE', 'PRE', 'P', 'SPAN', 'DIV'].includes(el.tagName));
  const document = { defaultView: window, querySelectorAll: select, getElementById: () => null }; window.top = window;
  const make = (tagName, textContent, attributes = {}) => {
    const el = { tagName, type: tagName === 'BUTTON' ? 'button' : '', textContent, ownerDocument: document, isConnected: true, childElementCount: 0, childNodes: [],
      getBoundingClientRect: () => ({ width: 100, height: 20 }), getAttribute: key => attributes[key] ?? null, hasAttribute: key => Object.hasOwn(attributes, key),
      querySelectorAll: select, matches: () => false, addEventListener: (type, listener) => events.set(el, listener), removeEventListener: (type, listener) => { if (events.get(el) === listener) events.delete(el); } };
    el.closest = selector => selector === '[role="dialog"],dialog' ? dialog : null; elements.push(el); return el;
  };
  const dialog = make('DIALOG', ''), code = make('CODE', 'sk-or-v1-••••••••'), button = make('BUTTON', 'Copy');
  const context = vm.createContext({ window, document, location: { origin }, origin, navigator: { clipboard }, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  const run = args => vm.runInContext(`(${providerKeyPage.toString()})('private_state','0-0-1-1',${JSON.stringify({ origin, expectedUrl: url, ...args })})`, context);
  const click = async ({ trusted = true, value = SECRET } = {}) => {
    let prevented = false;
    events.get(button)?.({ isTrusted: trusted, composedPath: () => [button, dialog], preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { prevented = true; } });
    if (!prevented) await clipboard.writeText(value);
  };
  const frame = { processId: 1, routingId: 1, url, framesInSubtree: [], executeJavaScript: expression => Promise.resolve(vm.runInContext(expression.replaceAll('"private_ref_state"', '"private_state"'), context)) };
  const tab = { id: 'tab-1', revision: 0, owner, refs: new Map(), refContexts: new Map(), suspendedWork: new Set(), window: { isDestroyed: () => false, webContents: { getURL: () => url, mainFrame: frame } } };
  const calls = [], driver = { key: 'private_state', tab: () => tab, closed: false, activate: async () => {},
    assertInputDocument: (_tab, args) => { if (args.expectedUrl !== url || args.expectedDocumentId && args.expectedDocumentId !== 'tab-1:0') throw Error(SECRET); },
    persist: () => {}, flushPersistence: async () => {}, frameStamp: () => ({ mainRevision: 0, lineage: [{ revision: 0 }], frame }), frameStampCurrent: () => true,
    referenceCurrent: (_tab, ref, documentId) => tab.refs.has(ref) && documentId === 'tab-1:0',
    rememberReferences: (_tab, captures) => captures.forEach(item => item.elements.forEach(source => tab.refs.set(source.ref, frame))),
    pageWork: (_tab, promise, signal) => signal?.aborted ? Promise.reject(Object.assign(Error(SECRET), { name: 'AbortError' })) : promise,
    perform: async (args, options) => { calls.push({ args, suppress: options.suppressResultSnapshot, protected: tab.providerKeyProtected }); await click(); return { protectedContent: true }; } };
  return { run, click, clipboard, originalWrite, get originalWrites() { return originalWrites; }, timers, events, context, elements, button, code, dialog, driver, tab, calls };
}

test('masked display is never a value source; one Copy control is explicitly identified without page text', () => {
  const page = fixture(), result = page.run({ action: 'inspect' }); noSecret(result);
  assert.equal(result.valid, true); assert.equal(result.sources.length, 1); assert.equal(result.sources[0].sourceKind, 'copy_control');
  assert.equal(result.sources[0].keyDisplayMasked, true); assert.equal(result.sources[0].requiresCopyClick, true);
  assert.equal(result.sources[0].valuePresent, false); assert.equal(JSON.stringify(result).includes('sk-or-v1'), false);
});

test('one trusted Copy writes only in-frame memory and restores the original method after one take', async () => {
  const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref;
  const prepared = page.run({ action: 'import', ref }); noSecret(prepared); assert.equal(prepared.clipboardPrepared, true);
  assert.notEqual(page.clipboard.writeText, page.originalWrite);
  await page.click(); const taken = await page.run({ action: 'copy_take', ref, captureId: prepared.captureId });
  assert.equal(taken.value, SECRET); assert.equal(page.originalWrites, 0); assert.equal(page.clipboard.writeText, page.originalWrite); assert.equal(page.timers.size, 0);
  assert.equal(page.run({ action: 'import', ref }).valid, false); assert.equal(page.run({ action: 'copy_take', ref, captureId: prepared.captureId }).valid, false);
});

test('untrusted Copy and masked writes cannot be imported and do not touch system clipboard', async () => {
  for (const options of [{ trusted: false }, { value: 'sk-or-v1-****masked****' }]) {
    const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref, prepared = page.run({ action: 'import', ref });
    await page.click(options).catch(cause => noSecret({ message: cause.message }));
    const result = await page.run({ action: 'copy_take', ref, captureId: prepared.captureId }); noSecret(result); assert.equal(result.valid, false);
    assert.equal(page.originalWrites, 0); assert.equal(page.clipboard.writeText, page.originalWrite);
  }
});

test('source change and ambiguous Copy controls refuse capture before input', () => {
  const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref;
  page.button.textContent = 'Create'; assert.equal(page.run({ action: 'import', ref }).valid, false); assert.equal(page.clipboard.writeText, page.originalWrite);
  page.button.textContent = 'Copy'; page.elements.push({ ...page.button }); assert.equal(page.run({ action: 'inspect' }).sources.length, 0);
});

test('timeout and explicit cleanup restore clipboard and erase captured state', () => {
  for (const mode of ['timeout', 'cleanup']) {
    const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref, prepared = page.run({ action: 'import', ref });
    if (mode === 'timeout') [...page.timers.values()][0].fn(); else page.run({ action: 'copy_cleanup', ref, captureId: prepared.captureId });
    assert.equal(page.clipboard.writeText, page.originalWrite); assert.equal(page.context.private_state.providerKeyClipboardCapture, null); assert.equal(page.events.size, 0);
  }
});

test('multiple writes are ambiguous, and deadline-before-click cannot produce an imported value', async () => {
  const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref, prepared = page.run({ action: 'import', ref });
  await page.click(); await page.clipboard.writeText(SECRET).catch(cause => noSecret({ message: cause.message }));
  const result = await page.run({ action: 'copy_take', ref, captureId: prepared.captureId }); noSecret(result); assert.equal(result.valid, false); assert.equal(page.originalWrites, 0);
  const other = fixture(), secondRef = other.run({ action: 'inspect' }).sources[0].ref, second = other.run({ action: 'import', ref: secondRef });
  const waiting = other.run({ action: 'copy_take', ref: secondRef, captureId: second.captureId }); [...other.timers.values()][0].fn();
  assert.equal((await waiting).valid, false); assert.equal(other.clipboard.writeText, other.originalWrite);
});

test('same-document masked display replacement refuses bytes while normal Copied label is allowed', async () => {
  for (const change of ['display', 'label']) {
    const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref, prepared = page.run({ action: 'import', ref });
    await page.click();
    if (change === 'display') page.code.textContent = 'sk-or-v1-****different****'; else page.button.textContent = 'Copied!';
    const result = await page.run({ action: 'copy_take', ref, captureId: prepared.captureId });
    if (change === 'display') { noSecret(result); assert.equal(result.valid, false); } else assert.equal(result.value, SECRET);
    assert.equal(page.clipboard.writeText, page.originalWrite);
  }
});

test('host imports through existing consume after one guarded no-snapshot click and returns only receipt', async () => {
  const page = fixture(), inspected = await performProviderKeySource(page.driver, { ...target, action: 'inspect' }, { owner });
  let consumed = 0, checks = 0;
  const result = await performProviderKeySource(page.driver, { ...target, action: 'import', ref: inspected.sources[0].ref, expectedDocumentId: inspected.documentId }, { owner,
    beforeDispatch: async () => { checks++; }, consume: async value => { assert.equal(value, SECRET); assert.equal(page.clipboard.writeText, page.originalWrite); consumed++; return { imported: true, encrypted: true }; } });
  noSecret(result); noSecret(page.calls); assert.equal(consumed, 1); assert.equal(page.calls.length, 1); assert.equal(page.calls[0].suppress, true); assert.equal(page.calls[0].protected, true);
  assert.equal(checks, 3); assert.equal(page.originalWrites, 0); assert.equal(page.clipboard.writeText, page.originalWrite);
});

test('cancellation after prepare restores hook without a click, and lost click receipt never claims not sent', async () => {
  const page = fixture(), inspected = await performProviderKeySource(page.driver, { ...target, action: 'inspect' }, { owner });
  let checks = 0;
  await assert.rejects(performProviderKeySource(page.driver, { ...target, action: 'import', ref: inspected.sources[0].ref, expectedDocumentId: inspected.documentId }, { owner,
    beforeDispatch: async () => { if (++checks === 2) throw Object.assign(Error(SECRET), { name: 'AbortError' }); }, consume: () => assert.fail('must not consume') }), cause => { noSecret({ message: cause.message }); assert.equal(cause.actionDispatched, false); return true; });
  assert.equal(page.calls.length, 0); assert.equal(page.clipboard.writeText, page.originalWrite);
  const fresh = await performProviderKeySource(page.driver, { ...target, action: 'inspect' }, { owner });
  page.driver.perform = async () => { await page.click(); throw Error(SECRET); };
  await assert.rejects(performProviderKeySource(page.driver, { ...target, action: 'import', ref: fresh.sources[0].ref, expectedDocumentId: fresh.documentId }, { owner, consume: () => assert.fail('must not consume') }), cause => { noSecret({ message: cause.message }); assert.equal(cause.actionDispatched, null); return true; });
  assert.equal(page.clipboard.writeText, page.originalWrite); assert.equal(page.context.private_state.providerKeyClipboardCapture, null);
});

test('direct import wrapper retains possible Copy dispatch when the browser loses its reply', async () => {
  const runtime = { store: { init: async () => {}, get: () => ({ updatedAt: 'revision-1' }), encryptSecret: () => {}, decryptSecret: () => {} }, saveProvider: () => assert.fail('must not save') };
  const browser = { providerKeySource: async () => { throw Object.assign(Error(SECRET), { code: 'PROVIDER_KEY_SETUP_UNCONFIRMED', actionDispatched: null }); } };
  const tool = createDirectProviderSetupTools({ runtime, browser, reauthorize: async () => {}, isEncryptionAvailable: () => true }).find(item => item.definition.name === 'blackice_provider_import_key');
  await assert.rejects(tool.execute({ requestId: 'copy-uncertain', action: 'import', tabId: target.tabId, origin, expectedUrl: url, expectedDocumentId: 'tab-1:0', ref: 'copy-ref', providerId: 'provider', expectedUpdatedAt: 'revision-1' }, { client: { id: 'client', scopes: ['commands:run', 'browser:read', 'browser:write'] } }), cause => { noSecret({ message: cause.message }); assert.equal(cause.actionDispatched, null); return true; });
});

test('a lost prepare reply cleans the installed interceptor before the outer import exits', async () => {
  const page = fixture(), inspected = await performProviderKeySource(page.driver, { ...target, action: 'inspect' }, { owner });
  page.driver.pageWork = async (_tab, promise) => { const result = await promise; if (result?.clipboardPrepared) throw Object.assign(Error(SECRET), { name: 'AbortError' }); return result; };
  await assert.rejects(performProviderKeySource(page.driver, { ...target, action: 'import', ref: inspected.sources[0].ref, expectedDocumentId: inspected.documentId }, { owner, consume: () => assert.fail('must not consume') }), cause => { noSecret({ message: cause.message }); return true; });
  assert.equal(page.calls.length, 0); assert.equal(page.clipboard.writeText, page.originalWrite); assert.equal(page.context.private_state.providerKeyClipboardCapture, null);
});

test('same-document URL change blocks taking bytes while restoration-only cleanup still succeeds', () => {
  const page = fixture(), ref = page.run({ action: 'inspect' }).sources[0].ref, prepared = page.run({ action: 'import', ref });
  page.context.window.location.href = `${url}#changed`;
  assert.equal(page.run({ action: 'copy_take', ref, captureId: prepared.captureId }).valid, false);
  assert.equal(page.run({ action: 'copy_cleanup', ref, captureId: prepared.captureId }).valid, true);
  assert.equal(page.clipboard.writeText, page.originalWrite); assert.equal(page.context.private_state.providerKeyClipboardCapture, null);
});
