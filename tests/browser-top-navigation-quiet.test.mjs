import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/browser-driver.mjs', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('  waitForTopNavigationQuiet('), source.indexOf('  watchNavigation('));
function harness() {
  let tick = 0, nextId = 0;
  const queue = new Map();
  const clock = {
    setTimeout(callback, ms) { const id = ++nextId; queue.set(id, { due: tick + ms, callback }); return id; },
    clearTimeout(id) { queue.delete(id); },
    advance(ms) {
      const end = tick + ms;
      while (true) {
        const next = [...queue.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; queue.delete(id); tick = timer.due; timer.callback();
      }
      tick = end;
    }
  };
  const wc = Object.assign(new EventEmitter(), { mainLoading: false, isLoadingMainFrame() { return this.mainLoading; }, isDestroyed: () => false });
  const listener = () => {};
  wc.on('did-navigate-in-page', listener);
  const driver = vm.runInNewContext('(new class {' + method + '})', {
    ...clock, TOP_NAVIGATION_QUIET_MS: 300, TOP_NAVIGATION_MAX_MS: 1500,
    cancel(signal) { if (signal?.aborted) throw signal.reason; }
  });
  return {
    clock, wc, start(signal) { return driver.waitForTopNavigationQuiet({ window: { webContents: wc } }, signal); },
    cleaned() { assert.equal(queue.size, 0); assert.equal(wc.eventNames().length, 1); assert.deepEqual(wc.listeners('did-navigate-in-page'), [listener]); }
  };
}

test('an SPA main-route commit resets quiet, but child navigation does not', async () => {
  const { wc, clock, start, cleaned } = harness();
  let state;
  const result = start().then(value => state = value);
  clock.advance(250);
  wc.emit('did-navigate-in-page', {}, '/spa-route', true);
  clock.advance(200);
  wc.emit('did-navigate-in-page', {}, '/child-route', false);
  clock.advance(99); await Promise.resolve();
  assert.equal(state, undefined);
  clock.advance(1);
  assert.equal(await result, true);
  cleaned();
});

test('an active main-frame replacement waits for its completion then another quiet window', async () => {
  const { wc, clock, start, cleaned } = harness();
  let state;
  const result = start().then(value => state = value);
  clock.advance(200);
  wc.mainLoading = true;
  wc.emit('did-start-navigation', {}, '/redirect', false, true);
  clock.advance(400); await Promise.resolve();
  assert.equal(state, undefined);
  wc.mainLoading = false;
  wc.emit('did-frame-finish-load', {}, true);
  clock.advance(299); await Promise.resolve();
  assert.equal(state, undefined);
  clock.advance(1);
  assert.equal(await result, true);
  cleaned();
});

test('persistent top-level changes hit the fixed cap without declaring controls settled', async () => {
  const { wc, clock, start, cleaned } = harness();
  const result = start();
  for (let i = 0; i < 5; i++) { clock.advance(250); wc.emit('did-navigate-in-page', {}, '/churn', true); }
  clock.advance(250);
  assert.equal(await result, false);
  cleaned();
});

test('abort and renderer destruction clean up both timers and all owned listeners', async () => {
  {
    const { start, cleaned } = harness();
    const controller = new AbortController();
    const result = start(controller.signal);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    cleaned();
  }
  {
    const { wc, start, cleaned } = harness();
    const result = start();
    wc.emit('destroyed');
    assert.equal(await result, false);
    cleaned();
  }
});
