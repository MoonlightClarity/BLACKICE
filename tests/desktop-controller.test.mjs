import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopController } from '../lib/desktop.mjs';

const screenshot = () => ({
  image: { data: 'YWJj', mimeType: 'image/png', width: 1280, height: 720 },
  coordinates: {
    width: 1280, height: 720, nativeWidth: 3840, nativeHeight: 2160,
    originX: -1920, originY: -1080, scaleX: 3, scaleY: 3,
  },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = 'uia_0123456789ab_1';

function harness(runner) {
  const calls = [];
  const desktop = new DesktopController({
    platform: 'win32',
    runner: async (request, options) => {
      calls.push({ request, options });
      if (runner) return runner(request, options);
      return request.action === 'screenshot' ? screenshot() : { text: 'Done.' };
    },
  });
  return { desktop, calls };
}

test('desktop starts detached and unavailable platforms cannot attach', async () => {
  const { desktop, calls } = harness();
  assert.equal(desktop.status().enabled, false);
  assert.equal(desktop.status().mode, 'background_uia');
  assert.equal(desktop.status().physicalInput, false);
  assert.equal(desktop.status().requiresForeground, false);
  assert.equal(desktop.status().isolated, false);
  await assert.rejects(desktop.perform({ action: 'windows' }), { code: 'DESKTOP_DISABLED' });
  assert.equal(calls.length, 0);
  assert.throws(() => desktop.setEnabled('true'), { code: 'DESKTOP_VALIDATION' });
  const unsupported = new DesktopController({ platform: 'linux' });
  assert.equal(unsupported.status().available, false);
  assert.throws(() => unsupported.setEnabled(true), { code: 'DESKTOP_UNAVAILABLE' });
});

test('screenshots remain read-only observations and every legacy physical input action is rejected', async () => {
  const { desktop, calls } = harness();
  desktop.setEnabled(true);
  await assert.rejects(desktop.perform({ action: 'click', x: 0, y: 0 }), { code: 'DESKTOP_VALIDATION' });
  await desktop.perform({ action: 'screenshot' });
  assert.deepEqual(calls[0].request, { action: 'screenshot', maxWidth: 1280, maxHeight: 900 });
  for (const action of ['click', 'double_click', 'right_click', 'type', 'key', 'focus']) {
    await assert.rejects(desktop.perform({ action, x: 0, y: 0, text: 'Never inject', keys: 'ENTER', windowId: '123' }), /Physical mouse, keyboard and focus actions are disabled/);
  }
  assert.equal(calls.length, 1, 'no legacy input reaches native code even after a screenshot');
  const copy = desktop.status(); copy.coordinates.width = 1;
  assert.equal(desktop.status().coordinates.width, 1280, 'status cannot mutate internal coordinate mapping');
});

test('native requests contain only validated semantic action data and explicit inspection targets', async () => {
  const { desktop, calls } = harness(); desktop.setEnabled(true);
  await desktop.perform({ action: 'inspect', windowId: '123', command: 'must not reach helper' });
  assert.deepEqual(calls.at(-1).request, { action: 'inspect', handle: '123', maxDepth: 5, maxNodes: 150, query: '' });
  await desktop.perform({ action: 'set_value', ref, value: 'Hello\nUnicode \u03bb\ud83d\ude80' });
  assert.deepEqual(calls.at(-1).request, { action: 'set_value', ref, value: 'Hello\nUnicode \u03bb\ud83d\ude80' });
  await desktop.perform({ action: 'set_value', ref, value: '' });
  assert.equal(calls.at(-1).request.value, '', 'clearing a supported edit is semantic and does not type');
  await desktop.perform({ action: 'scroll', ref, direction: 'down', amount: 3 });
  assert.deepEqual(calls.at(-1).request, { action: 'scroll', ref, direction: 'down', amount: 3, unit: 'large' });
  await desktop.perform({ action: 'get_text', ref });
  assert.deepEqual(calls.at(-1).request, { action: 'get_text', ref, maxCharacters: 4000 });
  for (const action of ['invoke', 'toggle', 'select', 'expand', 'collapse', 'scroll_into_view']) await desktop.perform({ action, ref });
});

test('invalid references, values, bounds and inspection handles never reach the native runner', async () => {
  const { desktop, calls } = harness(); desktop.setEnabled(true);
  await desktop.perform({ action: 'screenshot' });
  const before = calls.length;
  const invalid = [
    { action: 'exec', command: 'whoami' },
    { action: 'key', keys: 'CTRL' }, { action: 'key', keys: 'CTRL+CTRL+S' },
    { action: 'key', keys: 'A+B' }, { action: 'key', keys: 'CTRL+UNSUPPORTED' },
    { action: 'click', x: 1280, y: 0 }, { action: 'click', x: 0, y: -1 },
    { action: 'click', x: 0.5, y: 0 }, { action: 'click', x: Infinity, y: 0 },
    { action: 'type', text: '' }, { action: 'type', text: 'a'.repeat(10001) },
    { action: 'type', text: 'hello\u0000world' },
    { action: 'focus', handle: '1;whoami' }, { action: 'focus', windowId: '-123' },
    { action: 'inspect' }, { action: 'inspect', windowId: '123', maxNodes: 301 },
    { action: 'inspect', windowId: '123', maxDepth: 11 }, { action: 'inspect', windowId: '123', query: 'x'.repeat(201) },
    { action: 'invoke', windowId: '123' }, { action: 'invoke', ref: 'guessed-ref' },
    { action: 'invoke', ref, windowId: '123' }, { action: 'set_value', ref, value: true },
    { action: 'set_value', ref, value: Infinity }, { action: 'set_value', ref, value: '\0' },
    { action: 'set_value', ref, value: 'x'.repeat(10001) }, { action: 'get_text', ref, maxCharacters: 12001 },
    { action: 'scroll', ref, delta: 120 }, { action: 'scroll', ref, direction: 'down', x: 10 },
    { action: 'scroll', ref, direction: 'down', amount: 11 }, { action: 'scroll', ref, direction: 'elsewhere' },
    { action: 'wait', milliseconds: 2001 }, { action: 'wait', milliseconds: -1 },
  ];
  for (const args of invalid) await assert.rejects(desktop.perform(args), { code: 'DESKTOP_VALIDATION' }, JSON.stringify(args));
  assert.equal(calls.length, before);
});

test('background application actions serialize rather than racing', async () => {
  const first = deferred(); const entered = deferred();
  const { desktop, calls } = harness(async request => {
    if (request.action === 'windows') { entered.resolve(); return first.promise; }
    return { text: 'Done.' };
  });
  desktop.setEnabled(true);
  const windows = desktop.perform({ action: 'windows' });
  const invoke = desktop.perform({ action: 'invoke', ref });
  await entered.promise;
  assert.equal(calls.length, 1);
  first.resolve({ windows: [] });
  await Promise.all([windows, invoke]);
  assert.deepEqual(calls.map(call => call.request.action), ['windows', 'invoke']);
  assert.equal(desktop.status().busy, false);
});

test('detachment aborts the live helper and queued work, and reattachment cannot revive stale screenshots', async () => {
  const started = deferred(); const result = deferred();
  let activeSignal;
  const { desktop, calls } = harness(async (_request, { signal }) => {
    activeSignal = signal; started.resolve(); return result.promise;
  });
  desktop.setEnabled(true);
  const capture = desktop.perform({ action: 'screenshot' });
  const queued = desktop.perform({ action: 'windows' });
  const settled = Promise.allSettled([capture, queued]);
  await started.promise;
  desktop.setEnabled(false);
  assert.equal(activeSignal.aborted, true, 'active helper receives revocation synchronously');
  assert.equal(desktop.status().coordinates, null);
  desktop.setEnabled(true);
  result.resolve(screenshot());
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(calls.length, 1, 'queued native request never starts');
  assert.equal(desktop.status().coordinates, null, 'stale pixels cannot restore the attachment coordinate state');
});

test('caller cancellation removes only its action and leaves the attachment usable', async () => {
  const { desktop, calls } = harness(); desktop.setEnabled(true);
  const controller = new AbortController();
  const waiting = desktop.perform({ action: 'wait', milliseconds: 2000 }, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(desktop.status().enabled, true);
  await desktop.perform({ action: 'windows' });
  assert.equal(calls.length, 1, 'wait is cancellable without starting a native helper');
});

test('invalid screenshot results never become coordinate state and failures do not poison the action queue', async () => {
  let bad = true;
  const { desktop } = harness(async () => {
    if (bad) return { ...screenshot(), coordinates: { ...screenshot().coordinates, width: 1281 } };
    return screenshot();
  });
  desktop.setEnabled(true);
  await assert.rejects(desktop.perform({ action: 'screenshot' }), /coordinates are invalid/);
  assert.equal(desktop.status().coordinates, null);
  assert.ok(desktop.status().lastError);
  bad = false;
  await desktop.perform({ action: 'screenshot' });
  assert.equal(desktop.status().coordinates.width, 1280);
  assert.equal(desktop.status().lastError, null);
});
