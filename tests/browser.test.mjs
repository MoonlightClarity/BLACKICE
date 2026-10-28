import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BROWSER_TOOL, BrowserWorkspace, browserURL, createBrowserToolHandler } from '../lib/browser.mjs';

// Lifecycle fakes own ordinary tabs just as the real adapter does. Reservation
// and missing-inventory behavior are exercised in browser-human-chat-boundary.
function fixtureWorkspace({ driver, ...options }) {
  const status = driver?.status?.bind(driver);
  if (driver) driver.status = () => ({ tabs: [{ tabId: 'one' }, { tabId: 'owned-tab' }], activeTab: 'one', ...status?.() });
  return new BrowserWorkspace({ driver, ...options });
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('focused typing requires explicit contained ownership and a complete document guard before admission', async t => {
  const calls = [], driver = { perform: async args => { calls.push(args); return { tabId: args.tabId }; } }, browser = fixtureWorkspace({ driver });
  t.after(() => browser.close());
  const valid = { action: 'type', browser: 'relay', tabId: 'owned-tab', text: 'safe fixture', expectedUrl: 'https://signin.example.test/', expectedDocumentId: 'owned-tab:1' };
  for (const override of [{ browser: 'firefox' }, { browser: undefined }, { tabId: undefined }, { text: '' }, { text: 'x'.repeat(16385) }, { expectedDocumentId: undefined }, { expectedUrl: undefined }, { expectedDocumentId: 1 }, { modifiers: ['Control'] }]) await assert.rejects(browser.perform({ ...valid, ...override }), { code: 'BROWSER_VALIDATION' });
  assert.deepEqual(calls, []);
  await browser.perform(valid, { source: 'user' }); assert.deepEqual(calls, [valid]);
  const explicitScheme = { ...valid, expectedUrl: 'javascript:alert(1)' };
  await browser.perform(explicitScheme, { source: 'user' }); assert.deepEqual(calls.at(-1), explicitScheme);
});

test('guarded form fill, selection and hover cross the tool boundary without losing the observed identity', async t => {
  const calls = [], browser = fixtureWorkspace({ driver: { status: () => ({ available: true, contained: true }), perform: async args => { calls.push(args); return { tabId: args.tabId }; } } });
  t.after(() => browser.close());
  const handler = createBrowserToolHandler({ browser });
  const guard = { browser: 'relay', tabId: 'owned-tab', expectedUrl: 'https://careers.example.test/application', expectedDocumentId: 'owned-tab:9' };
  for (const action of ['fill', 'select', 'hover']) {
    const request = { ...guard, action, ref: 'observed-field', ...(action === 'fill' ? { text: 'A real draft' } : action === 'select' ? { value: 'available-option' } : {}) };
    const response = await handler({ name: 'relay_browser', arguments: request });
    assert.equal(response.success, true, `${action} should accept the same complete guard advertised for page input`);
    assert.deepEqual(calls.at(-1), request);
    const dispatched = calls.length;
    for (const override of [{ expectedDocumentId: undefined }, { expectedUrl: undefined }, { expectedDocumentId: '' }, { expectedUrl: '' }]) {
      await assert.rejects(browser.perform({ ...request, ...override }), { code: 'BROWSER_VALIDATION' });
    }
    assert.equal(calls.length, dispatched, 'An incomplete guard must not reach the driver.');
  }
  await assert.rejects(browser.perform({ ...guard, action: 'read' }), { code: 'BROWSER_VALIDATION' });
  const legacy = { action: 'fill', browser: 'relay', tabId: 'owned-tab', ref: 'observed-field', text: 'Ref-only draft' };
  assert.equal((await handler({ name: 'relay_browser', arguments: legacy })).success, true);
  assert.deepEqual(calls.at(-1), legacy);
});

test('tools resolve observed dialogs with the same exact identity checks as local input', async t => {
  const calls = [], browser = fixtureWorkspace({ driver: { status: () => ({ available: true, contained: true }), perform: async (args, options) => { calls.push({ args, source: options.source }); return { receipt: { decided: true } }; } } });
  t.after(() => browser.close());
  const value = { action: 'interaction', browser: 'relay', tabId: 'owned-tab', interactionId: 'browser_input_11111111-1111-4111-8111-111111111111', expectedUrl: 'https://example.test/', expectedDocumentId: 'owned-tab:2', decision: 'dismiss' };
  assert.equal(BROWSER_TOOL.inputSchema.properties.action.enum.includes('interaction'), true);
  for (const extra of [{ browser: 'firefox' }, { expectedUrl: undefined }, { expectedDocumentId: undefined }, { interactionId: 'guessed' }, { decision: 'yes' }, { source: 'user' }, { promptText: 'x'.repeat(4097) }]) await assert.rejects(browser.perform({ ...value, ...extra }, { source: 'user' }), { code: 'BROWSER_VALIDATION' });
  const result = await createBrowserToolHandler({ browser })({ name: 'relay_browser', arguments: value }); assert.equal(result.success, true); assert.equal(calls.length, 1);
  await browser.perform(value, { source: 'user' }); assert.deepEqual(calls, [{ args: value, source: 'agent' }, { args: value, source: 'user' }]);
});

test('chooser uploads require a fresh document and preserve only the host upload validator across the queue', async t => {
  const calls = [], validator = async () => {};
  const browser = fixtureWorkspace({ driver: { status: () => ({ available: true, contained: true }), perform: async (args, options) => { calls.push({ args, validator: options.validateUploadPath }); return { receipt: { uploaded: true } }; } } }); t.after(() => browser.close());
  const request = { action: 'upload', browser: 'relay', tabId: 'owned-tab', chooserId: 'browser_input_11111111-1111-4111-8111-111111111111', expectedUrl: 'https://example.test/', expectedDocumentId: 'owned-tab:2', paths: ['/owned/file.txt'] };
  for (const extra of [{ ref: 'other-input' }, { expectedDocumentId: undefined }, { expectedUrl: undefined }, { chooserId: 'guessed' }, { browser: 'firefox' }, { action: 'click' }]) await assert.rejects(browser.perform({ ...request, ...extra }), { code: 'BROWSER_VALIDATION' });
  const result = await createBrowserToolHandler({ browser, validateUploadPath: validator })({ name: 'relay_browser', arguments: request });
  assert.equal(result.success, true); assert.equal(calls.length, 1); assert.equal(calls[0].validator, validator); assert.equal(calls[0].args.validateUploadPath, undefined);
});

test('typing and editing keys keep admission order while rapid text is queued', async t => {
  const held = deferred(), calls = [], events = [];
  const browser = fixtureWorkspace({ driver: { perform: async args => { calls.push(args); if (calls.length === 1) await held.promise; return { tabId: args.tabId }; } } });
  t.after(async () => { held.resolve(); await browser.close(); }); browser.on('action', event => events.push(event));
  const guard = { browser: 'relay', tabId: 'owned-tab', expectedUrl: 'https://signin.example.test/', expectedDocumentId: 'owned-tab:1' };
  const one = browser.perform({ ...guard, action: 'type', text: 'private-first' }, { source: 'user' }); await tick();
  const two = browser.perform({ ...guard, action: 'press', key: 'Backspace' }, { source: 'user' });
  const three = browser.perform({ ...guard, action: 'type', text: 'private-second' }, { source: 'user' });
  assert.equal(calls.length, 1); held.resolve(); await Promise.all([one, two, three]);
  assert.deepEqual(calls.map(item => item.action), ['type', 'press', 'type']);
  assert.doesNotMatch(JSON.stringify(events), /private-first|private-second/);
});

test('browser URL validation preserves explicit schemes and credentials while rejecting malformed addresses', () => {
  assert.equal(browserURL('https://example.com/path'), 'https://example.com/path');
  assert.equal(browserURL('www.linkedin.comm'), 'https://www.linkedin.comm/');
  for (const url of ['file:///C:/Documents/local.html', 'about:version', 'chrome://version/']) assert.equal(browserURL(url), new URL(url).href);
  for (const url of ['javascript:alert(1)', 'https://key:secret@example.com']) assert.equal(browserURL(url), new URL(url).href);
  assert.throws(() => browserURL('not a url'), { code: 'BROWSER_VALIDATION' });
});
test('open and navigate normalize bare addresses before dispatching to the browser', async t => {
  const calls = [], browser = fixtureWorkspace({ driver: { perform: async args => { calls.push(args); return { tabId: 'one' }; } } });
  t.after(() => browser.close());
  await browser.perform({ action: 'open', url: 'www.linkedin.comm' }, { source: 'user' });
  await browser.perform({ action: 'navigate', tabId: 'one', url: 'localhost:3000/page' }, { source: 'user' });
  assert.deepEqual(calls, [
    { action: 'open', url: 'https://www.linkedin.comm/' },
    { action: 'navigate', tabId: 'one', url: 'http://localhost:3000/page' },
  ]);
});
test('new-tab URLs and explicit metadata selection use the existing workspace without page input', async t => {
  const calls = [], browser = fixtureWorkspace({ driver: { perform: async args => { calls.push(args); return { tabId: 'one' }; } } });
  t.after(() => browser.close());
  await browser.perform({ action: 'open', url: 'about:blank' }, { source: 'user' });
  await browser.perform({ action: 'navigate', tabId: 'one', url: 'about:blank' }, { source: 'user' });
  await browser.perform({ action: 'tab_select', browser: 'relay', tabId: 'one' }, { source: 'user' });
  assert.deepEqual(calls, [{ action: 'open', url: 'about:blank' }, { action: 'navigate', tabId: 'one', url: 'about:blank' },
    { action: 'tab_select', browser: 'relay', tabId: 'one' }]);
  for (const args of [{ action: 'tab_select' }, { action: 'tab_select', tabId: '' }, { action: 'tab_select', tabId: 'one', url: 'https://example.test/' }])
    await assert.rejects(browser.perform(args, { source: 'user' }), { code: 'BROWSER_VALIDATION' });
  assert.equal(calls.length, 3);
});
test('browser actions serialize and caller cancellation prevents queued mutations', async () => {
  const driver = new EventEmitter(), calls = []; let release;
  driver.perform = async (args) => { calls.push(args.action); if (args.action === 'snapshot') await new Promise(resolve => { release = resolve; }); return { tabId: 'one' }; };
  const browser = fixtureWorkspace({ driver });
  const first = browser.perform({ action: 'snapshot' });
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(), second = browser.perform({ action: 'click', ref: 'one' }, { signal: controller.signal });
  controller.abort(); release(); await first;
  await assert.rejects(second, /cancelled/); assert.deepEqual(calls, ['snapshot']); await browser.close();
});
test('browser screenshot tools return pixels only as image content and errors stay actionable', async () => {
  const driver = { status: () => ({ available: true, contained: true }), perform: async args => { if (args.action === 'click') throw new Error('This ref is stale. Take a new snapshot.'); return { tabId: 'one', imageUrl: 'data:image/png;base64,AA==' }; } };
  const browser = fixtureWorkspace({ driver }), handler = createBrowserToolHandler({ browser });
  const image = await handler({ name: 'relay_browser', arguments: { action: 'screenshot' } });
  assert.equal(image.contentItems[1].type, 'inputImage'); assert.doesNotMatch(image.contentItems[0].text, /base64/);
  const stale = await handler({ name: 'relay_browser', arguments: { action: 'click', ref: 'stale' } });
  assert.equal(stale.success, false); assert.match(stale.contentItems[0].text, /new snapshot/);
  await browser.close();
});

test('browser failure receipts retain non-Error messages and never collapse unknown rejections to an empty object', async () => {
  const stale = 'This element ref is stale. Take a new snapshot and choose its current ref.';
  for (const [reason, expected] of [
    [Object.assign(new Error(stale), { code: 'BROWSER_REF_STALE', actionDispatched: false }), { error: stale, code: 'BROWSER_REF_STALE', actionDispatched: false }],
    [stale, { error: stale, code: 'BROWSER_ACTION_FAILED' }],
    [{ description: 'The node no longer exists.', code: -32000 }, { error: 'The node no longer exists.', code: -32000 }],
    ...[{}, null, undefined].map(reason => [reason, { error: 'The browser action failed without error details. Inspect the current page before repeating it.', code: 'BROWSER_ACTION_FAILED' }]),
  ]) {
    const browser = { status: () => ({ available: true, contained: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async () => { throw reason; } };
    const result = await createBrowserToolHandler({ browser })({ name: 'relay_browser', arguments: { action: 'click', tabId: 'one', ref: 'old-media' } });
    assert.equal(result.success, false); assert.equal(result.code, expected.code);
    assert.deepEqual(JSON.parse(result.contentItems[0].text), expected);
  }
});

test('browser tools continue beyond 200 actions and respect an explicit caller budget', async () => {
  const browser = { status: () => ({ available: true, contained: true, tabs: [] }), perform: async () => ({ tabs: [] }) }, call = { name: 'relay_browser', arguments: { action: 'tabs' } }, handler = createBrowserToolHandler({ browser });
  for (let index = 0; index < 205; index++) assert.equal((await handler(call)).success, true);
  const limited = createBrowserToolHandler({ browser, maxCalls: 2 }); await limited(call); await limited(call); await assert.rejects(limited(call), /configured browser action limit/);
  for (const maxCalls of [0, -1, 1.5, false]) assert.throws(() => createBrowserToolHandler({ browser, maxCalls }), /positive whole number/);
});
test('browser shutdown aborts active work and rejects later requests without reviving the driver', async () => {
  let closed = false;
  const driver = { perform: (_args, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })), close: () => { closed = true; } };
  const browser = fixtureWorkspace({ driver }); const active = browser.perform({ action: 'snapshot' });
  await new Promise(resolve => setImmediate(resolve)); await browser.close();
  await assert.rejects(active, /cancelled/); assert.equal(closed, true); await assert.rejects(browser.perform({ action: 'tabs' }), /desktop app/);
});
test('removed saved-session copying is absent from the catalog and rejected before reaching a driver', async () => {
  const calls = [], driver = { perform: async args => { calls.push(args); return { tabId: 'must-not-be-opened' }; } };
  const browser = fixtureWorkspace({ driver });
  try {
    assert.equal(BROWSER_TOOL.inputSchema.properties.action.enum.includes('reuse_session'), false);
    for (const url of ['https://example.com/account', 'file:///C:/cookies.sqlite', 'javascript:alert(1)', 'https://name:private-token@example.com/', 'not a URL', undefined]) await assert.rejects(browser.perform({ action: 'reuse_session', url }), { code: 'BROWSER_VALIDATION' });
    assert.deepEqual(calls, [], 'even a valid website URL must not reach any session reader or driver');
  } finally { await browser.close(); }
});
test('a stale agent request to copy a session fails without opening a page or exposing its arguments', async () => {
  let driverCalls = 0;
  const browser = fixtureWorkspace({ driver: { perform: async () => { driverCalls++; return {}; } } });
  try {
    const handler = createBrowserToolHandler({ browser });
    const result = await handler({ name: 'relay_browser', arguments: { action: 'reuse_session', url: 'https://name:private-token@example.com/account' } });
    assert.equal(result.success, false); assert.equal(driverCalls, 0);
    assert.match(result.contentItems[0].text, /session transfer was removed/i);
    assert.match(result.contentItems[0].text, /contained browser and its own sign-in/i);
    assert.doesNotMatch(JSON.stringify(result), /private-token|sessionImport|authenticated/);
  } finally { await browser.close(); }
});

test('a timed-out adapter returns promptly, blocks duplicate actions, and discards late success', { timeout: 2000 }, async t => {
  const held = deferred(), calls = [], events = [];
  const driver = { perform: args => { calls.push(args.action); return calls.length === 1 ? held.promise : Promise.resolve({ tabId: 'one' }); } };
  const browser = fixtureWorkspace({ driver, timeoutMs: 25, shutdownTimeoutMs: 50 });
  t.after(async () => { held.resolve({ tabId: 'late' }); await browser.close().catch(() => {}); });
  browser.on('action', event => events.push(event));
  const started = Date.now(), first = browser.perform({ action: 'click', ref: 'submit' });
  const firstFailure = assert.rejects(first, { code: 'BROWSER_TIMEOUT' });
  await tick();
  const queued = browser.perform({ action: 'click', ref: 'submit' });
  const queuedFailure = assert.rejects(queued, { code: 'BROWSER_RECOVERY_REQUIRED' });
  await firstFailure; await queuedFailure;
  assert.ok(Date.now() - started < 1000, 'the caller must not wait for an abort-ignoring adapter');
  assert.deepEqual(calls, ['click']);
  assert.equal(browser.status().lifecycle, 'recovering'); assert.equal(browser.status().acceptingActions, false);
  assert.match(browser.status().recovery.message, /duplicate/i);
  await assert.rejects(browser.perform({ action: 'click', ref: 'submit' }), { code: 'BROWSER_RECOVERY_REQUIRED' });
  held.resolve({ tabId: 'late' }); await tick();
  assert.deepEqual(events, [], 'late physical completion must not become a successful receipt');
  assert.equal(browser.status().acceptingActions, true);
  assert.equal(browser.status().recovery, undefined);
  await browser.perform({ action: 'snapshot' });
  assert.deepEqual(calls, ['click', 'snapshot']); assert.deepEqual(events.map(event => event.action), ['snapshot']);
});

test('queued cancellation returns before the active action finishes and does not cancel it', { timeout: 2000 }, async t => {
  const held = deferred(), calls = [];
  const browser = fixtureWorkspace({ driver: { perform: args => { calls.push(args.action); return held.promise; } } });
  t.after(async () => { held.resolve({ tabId: 'one' }); await browser.close(); });
  const first = browser.perform({ action: 'read' }); await tick();
  const controller = new AbortController(), queued = browser.perform({ action: 'click', ref: 'submit' }, { signal: controller.signal });
  const cancelled = assert.rejects(queued, { name: 'AbortError', code: 'ABORT_ERR' }); controller.abort(); await cancelled;
  assert.deepEqual(calls, ['read']); assert.equal(browser.status().lifecycle, 'ready'); assert.equal(browser.status().busy, true);
  held.resolve({ tabId: 'one' }); await first;
});

test('active caller cancellation quarantines an uncooperative adapter and observes its late rejection', { timeout: 2000 }, async t => {
  const held = deferred(); let adapterSignal, calls = 0;
  const driver = { perform: (_args, { signal }) => { calls++; adapterSignal = signal; return calls === 1 ? held.promise : Promise.resolve({ tabId: 'one' }); } };
  const browser = fixtureWorkspace({ driver, timeoutMs: 1000, shutdownTimeoutMs: 50 });
  t.after(async () => { held.resolve({}); await browser.close().catch(() => {}); });
  const controller = new AbortController(), active = browser.perform({ action: 'fill', text: 'draft' }, { signal: controller.signal });
  const cancelled = assert.rejects(active, { code: 'ABORT_ERR' }); await tick(); controller.abort(); await cancelled;
  assert.equal(adapterSignal.aborted, true); assert.equal(browser.status().acceptingActions, false);
  await assert.rejects(browser.perform({ action: 'click', ref: 'send' }), { code: 'BROWSER_RECOVERY_REQUIRED' });
  held.reject(new Error('The cancelled adapter failed later.')); await tick();
  assert.equal(browser.status().acceptingActions, true); await browser.perform({ action: 'snapshot' }); assert.equal(calls, 2);
});

test('shutdown is coalesced and bounded even when both physical work and driver shutdown ignore cancellation', { timeout: 2000 }, async () => {
  const action = deferred(), shutdown = deferred(); let closes = 0;
  const driver = new EventEmitter(); driver.status = () => ({ available: true }); driver.perform = () => action.promise; driver.close = () => { closes++; return shutdown.promise; };
  const browser = fixtureWorkspace({ driver, timeoutMs: 1000, shutdownTimeoutMs: 25 });
  const active = browser.perform({ action: 'click', ref: 'submit' }); const cancelled = assert.rejects(active, { code: 'ABORT_ERR' }); await tick();
  const started = Date.now(), first = browser.close(), second = browser.close();
  assert.equal(first, second); const failure = assert.rejects(first, { code: 'BROWSER_SHUTDOWN_TIMEOUT' });
  await cancelled; await failure;
  assert.ok(Date.now() - started < 1000); assert.equal(closes, 1);
  assert.equal(browser.status().available, false); assert.equal(browser.status().lifecycle, 'closed'); assert.equal(browser.status().acceptingActions, false);
  assert.match(browser.status().recovery.message, /could not be confirmed/i);
  assert.equal(driver.listenerCount('changed'), 0);
  await assert.rejects(browser.perform({ action: 'open', url: 'https://example.com' }), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(browser.close(), first, 'later close callers receive the same failed shutdown result');
  action.resolve({ tabId: 'late' }); shutdown.reject(new Error('Late close failure must be observed.')); await tick();
});

test('a driver shutdown failure still drains pending physical work before reporting failure', { timeout: 2000 }, async () => {
  const action = deferred(); let closes = 0, settled = false;
  const driver = { perform: () => action.promise, close: () => { closes++; throw Object.assign(new Error('Profile flush failed.'), { code: 'FLUSH_FAILED' }); } };
  const browser = fixtureWorkspace({ driver, timeoutMs: 1000, shutdownTimeoutMs: 500 });
  const active = browser.perform({ action: 'read' }), cancelled = assert.rejects(active, { code: 'ABORT_ERR' }); await tick();
  const closing = browser.close(), failed = assert.rejects(closing, { code: 'FLUSH_FAILED' }); closing.then(() => { settled = true; }, () => { settled = true; });
  await cancelled; await tick(); assert.equal(settled, false, 'a failed close must not skip the active-work drain');
  action.resolve({}); await failed; assert.equal(closes, 1); assert.equal(browser.status().available, false);
});

test('Firefox disconnect blocks admission immediately, coalesces callers, and releases only after all work stops', { timeout: 2000 }, async t => {
  const action = deferred(), disconnect = deferred(), calls = []; let disconnects = 0, shows = 0;
  const driver = { drivers: { firefox: { disconnect: () => { disconnects++; return disconnect.promise; } } }, perform: args => { calls.push(args.action); return calls.length === 1 ? action.promise : Promise.resolve({ tabId: 'one' }); }, show: () => { shows++; } };
  const browser = fixtureWorkspace({ driver, timeoutMs: 1000, shutdownTimeoutMs: 500 });
  t.after(async () => { action.resolve({}); disconnect.resolve(); await browser.close().catch(() => {}); });
  const active = browser.perform({ action: 'open', browser: 'firefox', url: 'https://example.com' }, { source: 'user' }), cancelled = assert.rejects(active, { code: 'ABORT_ERR' }); await tick();
  const queued = browser.perform({ action: 'click', ref: 'submit' }), queuedCancelled = assert.rejects(queued, { code: 'ABORT_ERR' });
  const first = browser.disconnectFirefox(), second = browser.disconnectFirefox(); assert.equal(first, second);
  await assert.rejects(browser.perform({ action: 'open', browser: 'firefox', url: 'https://example.com' }), { code: 'BROWSER_DISCONNECTING' });
  await assert.rejects(browser.show('one'), { code: 'BROWSER_DISCONNECTING' }); await cancelled; await queuedCancelled; await tick();
  assert.equal(disconnects, 1, 'disconnect must start without waiting for an uncooperative action'); assert.equal(shows, 0);
  action.resolve({ tabId: 'late' }); await tick();
  assert.equal(browser.status().lifecycle, 'disconnecting'); assert.equal(browser.status().acceptingActions, false);
  disconnect.resolve(); await first;
  assert.equal(browser.status().acceptingActions, true); await browser.perform({ action: 'snapshot' }); assert.deepEqual(calls, ['open', 'snapshot']);
});

test('a disconnect timeout keeps its admission barrier until physical completion, without retrying disconnect', { timeout: 2000 }, async t => {
  const action = deferred(); let disconnects = 0;
  const driver = { drivers: { firefox: { disconnect: async () => { disconnects++; } } }, perform: () => action.promise };
  const browser = fixtureWorkspace({ driver, timeoutMs: 1000, shutdownTimeoutMs: 25 });
  t.after(async () => { action.resolve({}); await browser.close().catch(() => {}); });
  const active = browser.perform({ action: 'fill', text: 'draft' }), cancelled = assert.rejects(active, { code: 'ABORT_ERR' }); await tick();
  const disconnecting = browser.disconnectFirefox(), timedOut = assert.rejects(disconnecting, { code: 'BROWSER_DISCONNECT_TIMEOUT' });
  await cancelled; await timedOut;
  assert.equal(browser.disconnectFirefox(), disconnecting); assert.equal(disconnects, 1);
  await assert.rejects(browser.perform({ action: 'click', ref: 'send' }), { code: 'BROWSER_DISCONNECTING' });
  assert.match(browser.status().recovery.message, /profile may still be in use/i);
  action.resolve({}); await tick();
  assert.equal(browser.status().acceptingActions, true); assert.equal(browser.status().recovery, undefined);
});

test('unconfirmed Firefox shutdown retains the barrier and close still attempts complete workspace shutdown', { timeout: 2000 }, async () => {
  let disconnects = 0, closes = 0;
  const cause = Object.assign(new Error('Firefox profile is still in use.'), { code: 'PROFILE_BUSY' });
  const driver = { drivers: { firefox: { disconnect: async () => { disconnects++; throw cause; } } }, perform: async () => ({}), close: async () => { closes++; } };
  const browser = fixtureWorkspace({ driver, shutdownTimeoutMs: 50 });
  const first = browser.disconnectFirefox(); await assert.rejects(first, { code: 'PROFILE_BUSY' });
  assert.equal(disconnects, 1); assert.equal(browser.status().acceptingActions, false);
  await assert.rejects(browser.perform({ action: 'snapshot' }), { code: 'BROWSER_DISCONNECTING' });
  await assert.rejects(browser.close(), { code: 'PROFILE_BUSY' }); assert.equal(closes, 1); assert.equal(browser.status().available, false);
});

test('an explicit disconnect retry can recover settled failed cleanup without admitting or replaying browser work', { timeout: 2000 }, async t => {
  const cleanup = deferred(); let disconnects = 0, actions = 0;
  const driver = { drivers: { firefox: { disconnect: async () => { if (++disconnects === 1) throw Object.assign(new Error('Profile close was not confirmed.'), { code: 'PROFILE_BUSY' }); await cleanup.promise; } } }, perform: async () => { actions++; return {}; } };
  const browser = fixtureWorkspace({ driver, shutdownTimeoutMs: 500 });
  t.after(async () => { cleanup.resolve(); await browser.close().catch(() => {}); });
  const first = browser.disconnectFirefox(); await assert.rejects(first, { code: 'PROFILE_BUSY' });
  await assert.rejects(browser.perform({ action: 'open', url: 'https://example.com' }), { code: 'BROWSER_DISCONNECTING' });
  const retry = browser.disconnectFirefox(); assert.notEqual(retry, first); assert.equal(browser.disconnectFirefox(), retry); await tick();
  assert.equal(disconnects, 2); assert.equal(browser.status().acceptingActions, false);
  await assert.rejects(browser.perform({ action: 'click', ref: 'submit' }), { code: 'BROWSER_DISCONNECTING' });
  cleanup.resolve(); await retry; assert.equal(browser.status().acceptingActions, true); assert.equal(browser.status().recovery, undefined);
  assert.equal(actions, 0, 'blocked requests are never replayed after recovery');
  await browser.perform({ action: 'snapshot' }); assert.equal(actions, 1);
});

test('a timed-out disconnect cannot start another cleanup while the original adapter shutdown is unresolved', { timeout: 2000 }, async t => {
  const cleanup = deferred(); let disconnects = 0;
  const browser = fixtureWorkspace({ driver: { drivers: { firefox: { disconnect: () => { disconnects++; return cleanup.promise; } } } }, shutdownTimeoutMs: 25 });
  t.after(async () => { cleanup.resolve(); await browser.close().catch(() => {}); });
  const first = browser.disconnectFirefox(); await assert.rejects(first, { code: 'BROWSER_DISCONNECT_TIMEOUT' });
  assert.equal(browser.disconnectFirefox(), first); assert.equal(disconnects, 1);
  await assert.rejects(browser.perform({ action: 'snapshot' }), { code: 'BROWSER_DISCONNECTING' });
  cleanup.resolve(); await tick(); assert.equal(browser.status().acceptingActions, true); assert.equal(browser.status().recovery, undefined);
});

test('showing a restored browser uses the same bounded queue and cannot bypass quarantined work', { timeout: 2000 }, async t => {
  const show = deferred(); let mutations = 0;
  const driver = { show: () => show.promise, perform: async () => { mutations++; return {}; } };
  const browser = fixtureWorkspace({ driver, timeoutMs: 25, shutdownTimeoutMs: 50 });
  t.after(async () => { show.resolve({ tabId: 'one' }); await browser.close().catch(() => {}); });
  const visible = browser.show('one'); await assert.rejects(visible, { code: 'BROWSER_TIMEOUT' });
  await assert.rejects(browser.perform({ action: 'open', url: 'https://example.com' }), { code: 'BROWSER_RECOVERY_REQUIRED' }); assert.equal(mutations, 0);
  show.resolve({ tabId: 'one' }); await tick(); await browser.perform({ action: 'snapshot' }); assert.equal(mutations, 1);
});

test('task browser ownership is host-bound, rechecked at dispatch and cannot be supplied in tool JSON', async t => {
  const owner = { taskId: 'task-a', runId: 'run-a', nodeId: 'agent' }, sibling = { taskId: 'task-a', runId: 'run-a', nodeId: 'review' }, held = deferred(), calls = [];
  const tabs = [{ tabId: 'a', owner: { ...owner } }, { tabId: 'sibling', owner: sibling }, { tabId: 'personal' }];
  const browser = new BrowserWorkspace({ driver: { status: () => ({ available: true, contained: true, tabs, activeTab: 'personal', ownerActiveTabs: { ['task-a\0agent']: 'a' }, folders: [{ id: 'task-folder', taskId: 'task-a', kind: 'task' }, { id: 'user-folder', kind: 'user' }] }), perform: async (args, options) => { calls.push({ args, options }); if (args.action === 'read') await held.promise; return args.action === 'tabs' ? { tabs, activeTab: 'personal' } : { tabId: args.tabId }; } } });
  t.after(async () => { held.resolve(); await browser.close(); });
  const handler = createBrowserToolHandler({ browser, owner });
  for (const arguments_ of [{ action: 'snapshot', tabId: 'sibling' }, { action: 'snapshot', tabId: 'personal' }, { action: 'open', url: 'https://example.test/', owner }, { action: 'open', url: 'https://example.test/', folderId: 'user-folder' }, { action: 'open', url: 'https://example.test/', parentTabId: 'sibling' }]) {
    const result = await handler({ name: 'relay_browser', arguments: arguments_ }); assert.equal(result.success, false);
  }
  assert.equal(calls.length, 0);
  const reading = browser.perform({ action: 'read' }, { owner }); await tick();
  const queued = browser.perform({ action: 'click', ref: 'observed' }, { owner });
  const rejected = assert.rejects(queued, { code: 'BROWSER_TAB_OWNERSHIP', actionDispatched: false });
  tabs[0].owner = sibling; held.resolve();
  await assert.rejects(reading, { code: 'BROWSER_RESULT_TAB_CHANGED' }); await rejected;
  assert.equal(calls.length, 1); assert.equal(calls[0].args.tabId, 'a'); assert.deepEqual(calls[0].options.owner, owner);
});

test('task cleanup runs after active browser work and receives only trusted exact owner context', async t => {
  const owner = { taskId: 'task', runId: 'run', nodeId: 'node' }, held = deferred(), events = [];
  const browser = new BrowserWorkspace({ driver: { status: () => ({ tabs: [{ tabId: 'page', owner }], activeTab: 'page' }), perform: async args => { events.push(args.action); await held.promise; return { tabId: 'page' }; }, releaseOwner: async supplied => { events.push('cleanup'); assert.deepEqual(supplied, owner); return { suspended: ['page'], retained: [] }; } } });
  t.after(async () => { held.resolve(); await browser.close(); });
  const first = browser.perform({ action: 'read', tabId: 'page' }, { owner }); await tick();
  const cleanup = browser.releaseOwner(owner); await tick(); assert.deepEqual(events, ['read']); held.resolve();
  await first; assert.deepEqual(await cleanup, { suspended: ['page'], retained: [] }); assert.deepEqual(events, ['read', 'cleanup']);
  await assert.rejects(browser.releaseOwner({ taskId: 'task', runId: 'run' }), { code: 'BROWSER_OWNER_INVALID' });
});

test('browser failure receipts retain their real code without fabricating dispatch absence', async t => {
  const driver = { status: () => ({ available: true, contained: true }), perform: async () => { throw Object.assign(new Error('The page navigation failed.'), { code: 'BROWSER_NAVIGATION_FAILED' }); } }, browser = fixtureWorkspace({ driver }); t.after(() => browser.close());
  const result = await createBrowserToolHandler({ browser })({ name: 'relay_browser', arguments: { action: 'open', url: 'https://example.test/' } });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_NAVIGATION_FAILED');
  const receipt = JSON.parse(result.contentItems[0].text); assert.equal(receipt.code, result.code); assert.equal(Object.hasOwn(receipt, 'actionDispatched'), false);
});

for (const trigger of ['deadline', 'caller abort']) test(`task cleanup survives ${trigger} and only runs after physical page work settles`, { timeout: 2000 }, async t => {
  const owner = { taskId: 'task', runId: 'run', nodeId: 'node' }, held = deferred(), controller = new AbortController(), events = [];
  const browser = new BrowserWorkspace({ timeoutMs: 25, driver: {
    status: () => ({ tabs: [{ tabId: 'page', owner }], activeTab: 'page' }),
    perform: async () => { events.push('physical-start'); await held.promise; events.push('physical-end'); return { tabId: 'page' }; },
    releaseOwner: async supplied => { assert.deepEqual(supplied, owner); events.push('cleanup'); return { suspended: ['page'], retained: [] }; },
  } });
  t.after(async () => { held.resolve(); await browser.close(); });
  const action = browser.perform({ action: 'read', tabId: 'page' }, { owner, signal: controller.signal });
  const rejected = assert.rejects(action, { code: trigger === 'deadline' ? 'BROWSER_TIMEOUT' : 'ABORT_ERR' });
  await tick();
  // Queue before a deadline to cover quarantine cancelling queued work; enqueue
  // after a caller abort to cover cleanup admitted during recovery.
  let cleanup;
  if (trigger === 'deadline') cleanup = browser.releaseOwner(owner);
  else { controller.abort(); await rejected; cleanup = browser.releaseOwner(owner); }
  let cleanupSettled = false;
  cleanup.then(() => { cleanupSettled = true; }, () => { cleanupSettled = true; });
  await rejected; browser.cancel();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cleanupSettled, false); assert.deepEqual(events, ['physical-start']);
  assert.equal(browser.status().recovery.required, true);
  held.resolve(); assert.deepEqual(await cleanup, { suspended: ['page'], retained: [] });
  assert.deepEqual(events, ['physical-start', 'physical-end', 'cleanup']);
  assert.equal(browser.status().busy, false); assert.equal(browser.status().recovery, undefined);
});

test('host persistence flush is serialized with page work and rejects an unconfirmed save', async t => {
  const held = deferred(), events = []; let failSave = false;
  const browser = fixtureWorkspace({ driver: {
    perform: async () => { events.push('read'); await held.promise; return { tabId: 'one' }; },
    flushPersistence: async () => { events.push('save'); if (failSave) throw Object.assign(new Error('Storage unavailable.'), { code: 'BROWSER_SAVE_FAILED' }); },
  } });
  t.after(async () => { held.resolve(); await browser.close(); });
  const action = browser.perform({ action: 'read' }); await tick(); const flush = browser.flushPersistence();
  await tick(); assert.deepEqual(events, ['read']); held.resolve(); await action;
  assert.equal((await flush).busy, false); assert.deepEqual(events, ['read', 'save']);
  failSave = true; await assert.rejects(browser.flushPersistence(), { code: 'BROWSER_SAVE_FAILED' });
  assert.equal(browser.status().available, true);
});
