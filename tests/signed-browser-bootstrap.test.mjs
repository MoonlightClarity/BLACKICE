import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BACKGROUND_WINDOW_BOOTSTRAP_CODE, prepareSignedBrowserWindow, captureSignedBrowserScreenshot } from '../lib/signed-browser-bootstrap.mjs';
import { createSignedBrowserIntegration } from '../lib/signed-browser.mjs';

const extensionId = 'pjimfkbpehlcllblajnpfamdfjhhlgkc';
const run = { name: 'run', description: 'Raw escape hatch: browser.cdp(method, params?, sessionId?).', inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeout: { type: 'number' } } } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function protocolFixture({ windows = [], preference = true, manifest = 'BrowserOS neo', id = extensionId, target = true } = {}) {
  const calls = [], nativeCalls = [], existing = windows.map(value => ({ ...value }));
  const native = (method, value) => (...args) => {
    const callback = args.pop(); nativeCalls.push({ method, args });
    callback(typeof value === 'function' ? value(...args) : value);
  };
  const chrome = {
    runtime: { id, getManifest: () => ({ name: manifest, version: '0.2.37.0' }) },
    browserOS: { getPref: native('getPref', { key: 'browseros.automation_never_steals_focus', type: 'boolean', value: preference }) },
    windows: {
      getAll: native('getAll', () => [...existing]),
      create: () => assert.fail('Task preparation must never create a native window.'),
      update: () => assert.fail('Task preparation must never resize, restore, minimize, or activate a native window.'),
      get: () => assert.fail('Read-only preparation uses only the existing window inventory.'),
      remove: () => assert.fail('Task preparation must never close a native window.'),
    },
  };
  const browser = { cdp: async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'untrusted', type: 'page', url: 'https://example.test/' }, ...(target ? [{ targetId: 'neo-worker', type: 'service_worker', url: `chrome-extension://${extensionId}/worker.js` }] : [])] };
    if (method === 'Target.attachToTarget') { assert.deepEqual(params, { targetId: 'neo-worker', flatten: true }); return { sessionId: 'owned-extension' }; }
    if (method === 'Runtime.evaluate') {
      assert.equal(sessionId, 'owned-extension'); assert.equal(params.awaitPromise, true); assert.equal(params.returnByValue, true);
      return { result: { value: await runInNewContext(params.expression, { chrome }) } };
    }
    if (method === 'Target.detachFromTarget') { assert.deepEqual(params, { sessionId: 'owned-extension' }); return {}; }
    assert.fail(`Unexpected protocol operation: ${method}`);
  } };
  return { calls, nativeCalls, existing, execute: () => new AsyncFunction('browser', BACKGROUND_WINDOW_BOOTSTRAP_CODE)(browser) };
}

test('zero-window Neo preparation stops without creating or changing any native OS window', async () => {
  const fixture = protocolFixture();
  const result = await fixture.execute();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { version: 1, ready: false, created: false, policyVerified: true, code: 'NATIVE_WINDOW_REQUIRED' });
  assert.deepEqual(fixture.nativeCalls.map(call => call.method), ['getPref', 'getAll']);
  assert.deepEqual(fixture.existing, []);
  assert.equal(fixture.calls.at(-1).method, 'Target.detachFromTarget');
});

test('existing browser windows remain untouched, including normal, focused user windows', async () => {
  const fixture = protocolFixture({ windows: [{ id: 41, state: 'normal', focused: true }] });
  const result = await fixture.execute();
  assert.equal(result.ready, true); assert.equal(result.created, false);
  assert.deepEqual(fixture.nativeCalls.map(call => call.method), ['getPref', 'getAll']);
  assert.deepEqual(fixture.existing, [{ id: 41, state: 'normal', focused: true }]);
});

test('an existing normal inactive Neo window remains usable after its actual native policy check', async () => {
  const fixture = protocolFixture({ windows: [{ id: 41, state: 'normal', focused: false }] }), before = structuredClone(fixture.existing), result = await fixture.execute();
  assert.equal(result.ready, true); assert.equal(result.policyVerified, true); assert.equal(result.created, false); assert.deepEqual(fixture.existing, before); assert.deepEqual(fixture.nativeCalls.map(call => call.method), ['getPref', 'getAll']);
});

for (const preference of [false, null, 'true']) test(`background preparation refuses unsafe focus policy ${JSON.stringify(preference)} without changing it`, async () => {
  const fixture = protocolFixture({ preference });
  const result = await fixture.execute();
  assert.equal(result.ready, false); assert.equal(result.code, 'FOCUS_POLICY_DISABLED');
  assert.deepEqual(fixture.nativeCalls.map(call => call.method), ['getPref']);
});

for (const options of [{ manifest: 'Lookalike extension' }, { id: 'other-extension' }, { target: false }]) test(`only the verified native Neo extension can admit an existing workspace: ${JSON.stringify(options)}`, async () => {
  const fixture = protocolFixture(options);
  const result = await fixture.execute();
  assert.equal(result.ready, false);
  assert.equal(fixture.nativeCalls.length, 0);
});

test('MCP preparation validates the run envelope and never exposes raw extension or page failures', async () => {
  let calls = 0;
  const connections = { clients: new Map([['neo', { tools: [run], call: async (name, args) => {
    calls++; assert.equal(name, 'run'); assert.equal(args.code, BACKGROUND_WINDOW_BOOTSTRAP_CODE); assert.equal(args.timeout, 8000);
    return { structuredContent: { ok: true, value: { version: 1, ready: true, created: false, policyVerified: true } } };
  } }]]) };
  const prepared = await prepareSignedBrowserWindow({ connections, status: { connectionId: 'neo' } });
  assert.deepEqual(prepared, { ready: true, supported: true, created: false, policyVerified: true }); assert.equal(calls, 1);
  connections.clients.get('neo').call = async () => ({ structuredContent: { ok: true, value: { version: 1, ready: true, created: true, policyVerified: true } } });
  assert.equal((await prepareSignedBrowserWindow({ connections, status: { connectionId: 'neo' } })).ready, false, 'a protocol claiming new window creation cannot admit the task');
  connections.clients.get('neo').call = async () => ({ structuredContent: { ok: false, error: 'https://private.example/account secret-page-data' } });
  const failure = await prepareSignedBrowserWindow({ connections, status: { connectionId: 'neo' } });
  assert.equal(failure.ready, false); assert.doesNotMatch(JSON.stringify(failure), /private\.example|secret-page-data/);
});

test('cancelled preparation never calls MCP and an unverifiable focus policy fails closed', async () => {
  const controller = new AbortController(); controller.abort();
  const connections = { clients: new Map([['neo', { tools: [run], call: () => assert.fail('Cancelled preparation cannot start a native action.') }]]) };
  assert.equal((await prepareSignedBrowserWindow({ connections, status: { connectionId: 'neo' }, signal: controller.signal })).ready, false);
  connections.clients.get('neo').tools = [{ ...run, description: 'Unrelated run tool.' }];
  const unsupported = await prepareSignedBrowserWindow({ connections, status: { connectionId: 'neo' } });
  assert.equal(unsupported.ready, false); assert.equal(unsupported.supported, false); assert.equal(unsupported.created, false); assert.match(unsupported.reason, /focus policy.*Update or reconnect/);
});

const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
function png(width = 1, height = 1, noisy = false) {
  const chunk = (name, bytes) => { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(name, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = width * 4 + 1, pixels = noisy ? randomBytes(row * height) : Buffer.alloc(row * height); for (let index = 0; index < height; index++) pixels[index * row] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
const screenshotRun = { ...run, description: 'browser.pages.list() browser.windows(opts) browser.cdp(method, params?, sessionId?).' };
function captureFixture({ pages = [{ pageId: 7, windowId: 82, targetId: 'exact-observed-target', ownership: 'mine' }], windows = [{ windowId: 82, isActive: false, bounds: { windowState: 'normal' } }], viewport = { pageX: 15, pageY: 30, clientWidth: 1400, clientHeight: 900 }, bytes = png(), data = bytes.toString('base64'), textEnvelope = false, atMethod = () => {}, atInventory = () => {}, ratio = 1, envelope = value => ({ ok: true, value }) } = {}) {
  const calls = [], rpc = []; let inventories = 0;
  const browser = {
    page: () => assert.fail('The capture broker must not use a page wrapper.'),
    pages: { list: async () => structuredClone(pages) },
    windows: async args => { assert.deepEqual(args, { action: 'list' }); atInventory(++inventories, windows); return { windows: structuredClone(windows) }; },
    cdp: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId }); await atMethod(method, params, sessionId);
      if (method === 'Target.attachToTarget') { assert.deepEqual(params, { targetId: 'exact-observed-target', flatten: true }); return { sessionId: 'owned-capture-session' }; }
      if (method === 'Target.detachFromTarget') { assert.deepEqual(params, { sessionId: 'owned-capture-session' }); return {}; }
      assert.equal(sessionId, 'owned-capture-session');
      if (method === 'Runtime.evaluate') { assert.deepEqual(params,{expression:'window.devicePixelRatio',returnByValue:true}); return {result:{value:ratio}}; }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: viewport };
      if (method === 'Page.captureScreenshot') return { data };
      assert.fail(`Unexpected or restore-capable protocol method: ${method}`);
    },
  };
  const connections = { clients: new Map([['neo', { tools: [screenshotRun] }]]), call: async (id, name, args, options) => {
    rpc.push({ id, name, args, options }); assert.equal(id, 'neo'); assert.equal(name, 'run');
    const value = envelope(await new AsyncFunction('browser', args.code)(browser));
    return textEnvelope ? { content: [{ type: 'text', text: JSON.stringify(value) }] } : { structuredContent: value };
  } };
  return { connections, calls, rpc, capture: (args = { page: 7, format: 'png' }, options = {}) => captureSignedBrowserScreenshot({ connections, connectionId: 'neo', arguments: args, ...options }) };
}

test('fixed background capture binds the exact observed target and clips the scrolled viewport without resizing', async () => {
  const f = captureFixture({ bytes: tinyJpeg, pages: [{ pageId: 8, windowId: 82, targetId: 'other-same-url', ownership: 'mine' }, { pageId: 7, windowId: 82, targetId: 'exact-observed-target', ownership: 'mine' }] });
  const result = await f.capture({ page: 7, session: 'observed-session' });
  assert.deepEqual(f.calls.map(call => call.method), ['Target.attachToTarget', 'Page.getLayoutMetrics', 'Runtime.evaluate', 'Page.captureScreenshot', 'Target.detachFromTarget']);
  assert.deepEqual(f.calls[3].params, { format: 'jpeg', quality: 80, fromSurface: true, captureBeyondViewport: false, clip: { x: 15, y: 30, width: 1024, height: 768, scale: 1 } });
  assert.equal(f.rpc[0].args.session, 'observed-session'); assert.equal(f.rpc[0].args.timeout, 8000); assert.ok(f.rpc[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result.content, [{ type: 'image', mimeType: 'image/jpeg', data: tinyJpeg.toString('base64') }]);
  assert.deepEqual(result.structuredContent.backgroundCapture, { page: 7, windowId: 82, mimeType: 'image/jpeg', bytes: tinyJpeg.length, sha256: createHash('sha256').update(tinyJpeg).digest('hex'), width: 1, height: 1, fullPage: false, method: 'fixed-cdp-viewport' });
});

for (const textEnvelope of [false, true]) test(`capture accepts validated image payloads beyond readiness parser limits (${textEnvelope ? 'text' : 'structured'} envelope)`, async () => {
  const bytes = png(128, 128, true), f = captureFixture({ bytes, textEnvelope, viewport: { pageX: 0, pageY: 0, clientWidth: 128, clientHeight: 128 } }); assert.ok(bytes.length > 16384);
  const result = await f.capture({ page: 7, format: 'png', quality: 95, size: { width: 128, height: 128 } });
  assert.deepEqual(Buffer.from(result.content[0].data, 'base64'), bytes); assert.equal(result.structuredContent.backgroundCapture.width, 128);
  assert.equal(f.calls[3].params.quality, undefined); assert.equal(f.calls[3].params.clip.width, 128);
});

test('capture respects requested JPEG quality and validates WebP bytes without applying JPEG-only options', async () => {
  const jpeg = captureFixture({ bytes: tinyJpeg }); await jpeg.capture({ page: 7, format: 'jpeg', quality: 37 }); assert.equal(jpeg.calls[3].params.quality, 37);
  const bytes = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64'), webp = captureFixture({ bytes });
  const result = await webp.capture({ page: 7, format: 'webp', quality: 95 }); assert.equal(result.content[0].mimeType, 'image/webp'); assert.equal(webp.calls[3].params.format, 'webp'); assert.equal(webp.calls[3].params.quality, undefined);
});

test('device scaling bounds actual image pixels without changing window or emulation metrics', async () => {
  for (const ratio of [1.25,2]) {
    const f=captureFixture({ratio}); await f.capture();
    assert.equal(f.calls.find(call=>call.method==='Page.captureScreenshot').params.clip.scale,1/ratio);
    assert.equal(f.calls.some(call=>/Emulation|bringToFront|setWindowBounds/.test(call.method)),false);
  }
  for(const ratio of [undefined,0,Infinity,9]) {
    const f=captureFixture({ratio:ratio===undefined?null:ratio});await assert.rejects(f.capture(),/normal inactive window/);
    assert.equal(f.calls.some(call=>call.method==='Page.captureScreenshot'),false);
    assert.equal(f.calls.at(-1).method,'Target.detachFromTarget');
  }
});

test('a window minimized after inventory is never restored and its capture session is retired', async () => {
  const windows = [{ windowId: 82, isActive: false, bounds: { windowState: 'normal' } }];
  const f = captureFixture({ windows, atMethod: method => { if (method === 'Page.getLayoutMetrics') windows[0].bounds.windowState = 'minimized'; } });
  await assert.rejects(f.capture(), /normal inactive window/);
  assert.deepEqual(f.calls.map(call => call.method), ['Target.attachToTarget', 'Page.getLayoutMetrics', 'Runtime.evaluate', 'Target.detachFromTarget']); assert.equal(windows[0].bounds.windowState, 'minimized');
});

for (const [change, mutate] of [
  ['focused', ({ windows }) => { windows[0].isActive = true; }],
  ['minimized', ({ windows }) => { windows[0].bounds.windowState = 'minimized'; }],
  ['moved to another window', ({ pages }) => { pages[0].windowId = 99; }],
  ['mapped to another target', ({ pages }) => { pages[0].targetId = 'a-different-target'; }],
  ['no longer owned', ({ pages }) => { pages[0].ownership = 'user'; }],
  ['closed', ({ pages }) => { pages.splice(0); }],
]) test(`an awaited capture whose page becomes ${change} cannot emit an image or retry`, async () => {
  const pages = [{ pageId: 7, windowId: 82, targetId: 'exact-observed-target', ownership: 'mine' }], windows = [{ windowId: 82, isActive: false, bounds: { windowState: 'normal' } }]; let afterChange;
  const f = captureFixture({ pages, windows, atMethod: method => { if (method === 'Page.captureScreenshot') { mutate({ pages, windows }); afterChange = structuredClone({ pages, windows }); } } });
  await assert.rejects(f.capture(), /normal inactive window/); assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot').length, 1); assert.equal(f.calls.at(-1).method, 'Target.detachFromTarget'); assert.deepEqual({ pages, windows }, afterChange, 'capture cleanup never restores, reclaims or mutates the changed page/window');
});

test('unavailable post-capture inventory discards the image, detaches its session and hides private transport details', async () => {
  const f = captureFixture({ atInventory: count => { if (count === 3) throw Error('private https://secret.example/native-state'); } });
  const failure = await f.capture().catch(cause => cause); assert.ok(failure instanceof Error); assert.doesNotMatch(failure.message, /secret\.example|native-state/); assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot').length, 1); assert.equal(f.calls.at(-1).method, 'Target.detachFromTarget');
});

for (const pages of [[], [{ pageId: 7, windowId: 82, ownership: 'mine' }], [{ pageId: 7, windowId: 82, targetId: 'exact-observed-target', ownership: 'user' }]]) test(`unobserved or unowned target cannot reach raw capture (${JSON.stringify(pages)})`, async () => {
  const f = captureFixture({ pages }); await assert.rejects(f.capture(), /could not verify/); assert.deepEqual(f.calls, []);
});

for (const window of [{ windowId: 82, isActive: true, bounds: { windowState: 'normal' } }, { windowId: 82, isActive: false, bounds: { windowState: 'minimized' } }]) test(`unsafe native window cannot attach a capture session (${JSON.stringify(window)})`, async () => {
  const f = captureFixture({ windows: [window] }); await assert.rejects(f.capture(), /could not verify/); assert.deepEqual(f.calls, []);
});

test('capture failures and cancellation retire only their own protocol session and keep errors private', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController(), f = captureFixture({ atMethod: method => { if (method === 'Page.captureScreenshot') { if (cancelled) controller.abort(); throw Error('private https://secret.example/account'); } } });
    const failure = await f.capture(undefined, { signal: controller.signal }).catch(cause => cause); assert.ok(failure instanceof Error); assert.doesNotMatch(failure.message, /secret\.example/); if (cancelled) assert.equal(failure.name, 'AbortError');
    assert.equal(f.calls.at(-1).method, 'Target.detachFromTarget'); assert.equal(f.rpc[0].options.signal.aborted, cancelled);
  }
});

test('pre-cancelled capture and invalid viewport cannot emit an image or touch window state', async () => {
  const controller = new AbortController(); controller.abort(); const f = captureFixture(); await assert.rejects(f.capture(undefined, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.rpc.length, 0);
  const invalid = captureFixture({ viewport: { pageX: 0, pageY: 0, clientWidth: NaN, clientHeight: 100 } }); await assert.rejects(invalid.capture()); assert.deepEqual(invalid.calls.map(call => call.method), ['Target.attachToTarget', 'Page.getLayoutMetrics', 'Target.detachFromTarget']);
});

test('capture deadline reaches the tracked connection call without exposing transport failures', async () => {
  const f = captureFixture(); f.connections.call = async (id, name, args, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('private transport details')), { once: true }));
  const keepAlive = setTimeout(() => {}, 1000); try { await assert.rejects(f.capture(undefined, { timeoutMs: 100 }), cause => cause.name === 'AbortError' && /deadline/.test(cause.message) && !/private/.test(cause.message)); } finally { clearTimeout(keepAlive); }
});

test('capture rejects dangerous options before calls and damaged, mismatched, oversized or noncanonical image bytes afterward', async () => {
  const f = captureFixture(); for (const args of [{ page: 7, fullPage: true }, { page: 7, annotate: true }, { page: '7' }, { page: 7, format: "png';throw 1;//" }, { page: 7, quality: -1 }, { page: 7, size: { width: 1921, height: 100 } }]) await assert.rejects(f.capture(args)); assert.equal(f.rpc.length, 0);
  const damaged = Buffer.from(png()); damaged[damaged.length - 5] ^= 1;
  for (const options of [{ data: '!!!!' }, { data: 'Zh==' }, { bytes: damaged }, { bytes: tinyJpeg }, { bytes: png(2, 2) }, { data: 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4) }, { envelope: () => ({ ok: false, error: 'private native details' }) }]) {
    const invalid = captureFixture(options); const failure = await invalid.capture({ page: 7, format: 'png', size: { width: 1, height: 1 } }).catch(cause => cause); assert.ok(failure instanceof Error); assert.doesNotMatch(failure.message, /private native/); assert.equal(invalid.calls.at(-1).method, 'Target.detachFromTarget');
  }
});

test('passive discovery never probes background readiness; an explicit task reports it without hiding the live connection', async () => {
  let preparations = 0;
  const integration = createSignedBrowserIntegration({
    registerImpl: async () => ({ available: true, catalogKind: 'neo-run', connectionId: 'neo' }),
    prepareWindowImpl: async () => { preparations++; return { ready: false, reason: 'Focus policy needs attention.' }; },
  });
  assert.equal((await integration.refresh()).available, true); assert.equal(preparations, 0);
  const checked = await integration.refresh({ startIfNeeded: true });
  assert.equal(preparations, 1); assert.equal(checked.available, true); assert.equal(checked.backgroundReady, false); assert.equal(checked.backgroundReason, 'Focus policy needs attention.');
  assert.equal(checked.backgroundWindow.ready, false);
  await integration.close();
});

test('repeated zero-window checks preserve the live connection and report background readiness until an existing Neo window is supplied', async () => {
  const fixture = protocolFixture();
  let mcpCalls = 0;
  const connections = { clients: new Map([['neo', { connected: true, closed: false, tools: [run], call: async (name, args) => {
    mcpCalls++; assert.equal(name, 'run'); assert.equal(args.code, BACKGROUND_WINDOW_BOOTSTRAP_CODE);
    return { structuredContent: { ok: true, value: await fixture.execute() } };
  } }]]) };
  const integration = createSignedBrowserIntegration({ connections, registerImpl: async () => ({ available: true, catalogKind: 'neo-run', connectionId: 'neo' }) });
  assert.equal((await integration.refresh()).available, true); assert.equal(mcpCalls, 0);
  const first = await integration.refresh({ startIfNeeded: true });
  assert.equal(first.available, true); assert.equal(first.backgroundReady, false); assert.equal(first.backgroundWindow.ready, false); assert.equal(first.backgroundWindow.created, false); assert.equal(first.backgroundWindow.code, 'NATIVE_WINDOW_REQUIRED'); assert.equal(first.backgroundWindow.policyVerified, true); assert.match(first.backgroundReason, /contained BLACKICE browser in Observe/); assert.match(first.backgroundReason, /will not open one automatically/);
  const second = await integration.refresh({ startIfNeeded: true });
  assert.equal(second.available, true); assert.equal(second.backgroundReady, false); assert.equal(second.backgroundWindow.ready, false); assert.equal(second.backgroundWindow.code, 'NATIVE_WINDOW_REQUIRED'); assert.deepEqual(fixture.existing, []);
  // Only external human action supplies this pre-existing native window.
  fixture.existing.push({ id: 82, state: 'normal', focused: false });
  const third = await integration.refresh({ startIfNeeded: true }); assert.equal(third.available, true); assert.equal(third.backgroundReady, true); assert.equal(third.backgroundReason, null); assert.equal(third.backgroundWindow.ready, true); assert.equal(third.backgroundWindow.created, false); assert.equal(third.backgroundWindow.policyVerified, true);
  const fourth = await integration.refresh({ startIfNeeded: true }); assert.equal(fourth.available, true); assert.equal(fourth.backgroundReady, true); assert.equal(fourth.backgroundReason, null); assert.equal(fourth.backgroundWindow.ready, true); assert.equal(fourth.backgroundWindow.created, false);
  assert.deepEqual(fixture.existing, [{ id: 82, state: 'normal', focused: false }]); assert.equal(mcpCalls, 4); assert.deepEqual(fixture.nativeCalls.map(call => call.method), Array.from({ length: 4 }, () => ['getPref', 'getAll']).flat());
  await integration.close();
});
