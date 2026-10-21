import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { DesktopRendererRecovery } from '../desktop/renderer-recovery.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(t, overrides = {}) {
  const timers = new Map(); let nextTimer = 0;
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  window.destroyed = false; window.visible = true; window.webContents.isDestroyed = () => window.destroyed;
  window.isDestroyed = () => window.destroyed; window.isVisible = () => window.visible;
  const loads = [], prompts = [], errors = [], crashes = [];
  let closing = false, unavailable = 0;
  window.loadURL = url => { loads.push(url); return overrides.load?.(loads.length) ?? Promise.resolve(); };
  const recovery = new DesktopRendererRecovery({ window, url: 'http://127.0.0.1:3547/',
    isClosing: () => closing, showRecovery: options => { prompts.push(options); return overrides.ask?.(options) ?? Promise.resolve({ response: 0 }); },
    onCrash: details => crashes.push(details), onError: error => errors.push(error), onUnavailable: () => unavailable++,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), stableMs: 60, unresponsiveMs: 15, loadTimeoutMs: 20,
  });
  t.after(() => recovery.stop());
  return { recovery, window, loads, prompts, errors, crashes, timers,
    close: () => { closing = true; recovery.stop(); },
    get unavailable() { return unavailable; },
    fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
  };
}

test('an isolated renderer crash reloads the interface once without touching runtime work', async t => {
  const f = fixture(t);
  f.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick();
  assert.deepEqual(f.loads, ['http://127.0.0.1:3547/']); assert.equal(f.recovery.state, 'ready');
  assert.equal(f.crashes.length, 1); assert.equal(f.prompts.length, 0); assert.equal(f.errors.length, 0);
});

test('crash loops stop at the retry budget and Keep running settles without further reloads or prompts', async t => {
  const f = fixture(t);
  assert.equal(await f.recovery.rendererGone({ reason: 'oom' }), true);
  f.window.webContents.emit('did-finish-load');
  assert.equal(await f.recovery.rendererGone({ reason: 'crashed' }), false);
  assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].defaultId, 0); assert.equal(f.prompts[0].cancelId, 0);
  assert.deepEqual(f.prompts[0].buttons, ['Keep running', 'Reload interface']); assert.equal(f.unavailable, 1);
  for (let index = 0; index < 8; index++) await f.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(f.recovery.state, 'blocked'); assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 1);
  f.fire(60); await tick(); assert.equal(f.recovery.automaticUsed, true);
});

test('the automatic budget resets only after stable successful loading', async t => {
  const f = fixture(t);
  await f.recovery.rendererGone({ reason: 'crashed' }); assert.equal(f.recovery.automaticUsed, true);
  f.fire(60); assert.equal(f.recovery.automaticUsed, false);
  await f.recovery.rendererGone({ reason: 'crashed' }); assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 0);
});

test('a rejected recovery load offers one safe choice and contains the rejection', async t => {
  const f = fixture(t, { load: () => Promise.reject(new Error('fixture load rejection')) });
  assert.equal(await f.recovery.rendererGone({ reason: 'launch-failed' }), false);
  assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.errors[0].message, 'fixture load rejection'); assert.equal(f.recovery.state, 'blocked');
});

test('a hidden shell with a failed crash reload stays blocked without a native dialog and can recover when reopened', async t => {
  const f = fixture(t, { load: count => count === 1 ? Promise.reject(new Error('fixture background reload failure')) : Promise.resolve() });
  f.window.visible = false;
  assert.equal(await f.recovery.rendererGone({ reason: 'crashed' }), false);
  assert.equal(f.recovery.state, 'blocked'); assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 0); assert.equal(f.errors.length, 1);
  for (let index = 0; index < 3; index++) await f.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 0);
  f.window.visible = true;
  assert.equal(await f.recovery.retry(), true);
  assert.equal(f.recovery.state, 'ready'); assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 0);
});

test('background crash loops exhaust their automatic budget silently until an explicit reopen retry', async t => {
  const f = fixture(t); f.window.visible = false;
  assert.equal(await f.recovery.rendererGone({ reason: 'crashed' }), true);
  assert.equal(await f.recovery.rendererGone({ reason: 'oom' }), false);
  assert.equal(f.recovery.state, 'blocked'); assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 0);
  f.fire(60); await tick(); assert.equal(f.recovery.automaticUsed, true);
  f.window.visible = true;
  assert.equal(await f.recovery.retry(), true);
  assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 0); assert.equal(f.recovery.automaticUsed, true);
});

test('an explicitly chosen retry gets one load and a second rejection never creates a loop', async t => {
  const f = fixture(t, { load: () => Promise.reject(new Error('fixture load rejection')), ask: () => Promise.resolve({ response: 1 }) });
  assert.equal(await f.recovery.rendererGone({ reason: 'crashed' }), false);
  assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 1); assert.equal(f.recovery.state, 'blocked');
});

test('a stalled navigation is bounded and late rejection is already handled', async t => {
  const load = deferred(), f = fixture(t, { load: () => load.promise });
  const pending = f.recovery.rendererGone({ reason: 'crashed' }); await tick(); f.fire(20);
  assert.equal(await pending, false); assert.equal(f.prompts.length, 1); assert.equal(f.recovery.state, 'blocked');
  load.reject(new Error('late fixture error')); await tick(); assert.equal(f.errors.length, 1);
});

test('a real late page load recovers a timed-out shell and eventually restores its retry budget', async t => {
  const load = deferred(), f = fixture(t, { load: count => count === 1 ? load.promise : Promise.resolve() });
  const pending = f.recovery.rendererGone({ reason: 'crashed' }); await tick(); f.fire(20); await pending;
  assert.equal(f.recovery.state, 'blocked');
  f.window.webContents.emit('did-finish-load'); load.resolve(); await tick();
  assert.equal(f.recovery.state, 'ready'); assert.equal(f.recovery.automaticUsed, true); f.fire(60);
  assert.equal(await f.recovery.rendererGone({ reason: 'crashed' }), true); assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 1);
});

test('a late page load cancels an obsolete recovery prompt and ignores a stale Reload response', async t => {
  const load = deferred(), answer = deferred(), f = fixture(t, { load: () => load.promise, ask: () => answer.promise });
  const pending = f.recovery.rendererGone({ reason: 'crashed' }); await tick(); f.fire(20); await tick();
  f.window.webContents.emit('did-finish-load'); load.resolve(); assert.equal(await pending, false);
  assert.equal(f.prompts[0].signal.aborted, true); assert.equal(f.recovery.state, 'ready');
  answer.resolve({ response: 1 }); await tick(); assert.equal(f.loads.length, 1);
});

test('a deliberate later retry can recover a blocked shell without restoring an automatic loop', async t => {
  const f = fixture(t, { load: count => count === 1 || count === 3 ? Promise.reject(new Error('fixture load rejection')) : Promise.resolve() });
  await f.recovery.rendererGone({ reason: 'crashed' }); assert.equal(f.recovery.state, 'blocked');
  assert.equal(await f.recovery.retry(), true); assert.equal(f.loads.length, 2); assert.equal(f.recovery.automaticUsed, true);
  await f.recovery.rendererGone({ reason: 'crashed' }); assert.equal(f.recovery.state, 'blocked');
  assert.equal(await f.recovery.retry(), false); assert.equal(f.loads.length, 3); assert.equal(f.prompts.length, 2); assert.equal(f.recovery.state, 'blocked');
});

test('a crash while the first reload is pending coalesces and asks before any second load', async t => {
  const load = deferred(), f = fixture(t, { load: () => load.promise });
  const first = f.recovery.rendererGone({ reason: 'crashed' }); await tick();
  const second = f.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(await first, false); assert.equal(await second, false); assert.equal(f.loads.length, 1); assert.equal(f.prompts.length, 1);
  load.resolve(); await tick(); assert.equal(f.recovery.state, 'blocked');
});

test('an initial renderer crash cannot turn a recovered load into startup failure', async t => {
  const initial = deferred(), f = fixture(t, { load: count => count === 1 ? initial.promise : Promise.resolve() });
  const starting = f.recovery.loadInitial(); await tick();
  const recovering = f.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(await starting, true); assert.equal(await recovering, true); assert.equal(f.loads.length, 2); assert.equal(f.prompts.length, 0);
  initial.reject(new Error('aborted old navigation')); await tick(); assert.equal(f.errors.length, 0);
});

test('clean exits, intentional shutdown and destroyed windows never start recovery', async t => {
  const f = fixture(t);
  await f.recovery.rendererGone({ reason: 'clean-exit' }); assert.equal(f.loads.length, 0); assert.equal(f.crashes.length, 0);
  f.close(); await f.recovery.rendererGone({ reason: 'killed' }); assert.equal(f.loads.length, 0); assert.equal(f.prompts.length, 0); assert.equal(f.timers.size, 0);
  const destroyed = fixture(t); destroyed.window.destroyed = true; await destroyed.recovery.rendererGone({ reason: 'crashed' }); assert.equal(destroyed.loads.length, 0);
});

test('shutdown cancels pending navigation promptly and contains a later failure', async t => {
  const load = deferred(), f = fixture(t, { load: () => load.promise });
  const pending = f.recovery.rendererGone({ reason: 'crashed' }); await tick(); f.close();
  assert.equal(await pending, false); assert.equal(f.prompts.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.recovery.state, 'stopped');
  load.reject(new Error('late failure after shutdown')); await tick(); assert.equal(f.errors.length, 0);
});

test('shutdown aborts the native prompt and ignores a stale Reload response', async t => {
  const answer = deferred(); let signal;
  const f = fixture(t, { ask: options => { signal = options.signal; return answer.promise; } });
  await f.recovery.rendererGone({ reason: 'crashed' });
  const pending = f.recovery.rendererGone({ reason: 'crashed' }); await tick(); f.close(); assert.equal(signal.aborted, true);
  assert.equal(await pending, false); answer.resolve({ response: 1 }); await tick(); assert.equal(f.loads.length, 1); assert.equal(f.recovery.state, 'stopped');
});

test('short hangs recover quietly and prolonged visible hangs ask before reloading', async t => {
  const f = fixture(t, { ask: () => Promise.resolve({ response: 1 }) });
  f.window.emit('unresponsive'); f.window.emit('responsive'); f.fire(15); await tick(); assert.equal(f.prompts.length, 0); assert.equal(f.loads.length, 0);
  f.window.emit('unresponsive'); assert.equal(f.prompts.length, 0); f.fire(15); await tick();
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].defaultId, 0); assert.equal(f.loads.length, 1);
  const hidden = fixture(t); hidden.window.visible = false; hidden.window.emit('unresponsive'); hidden.fire(15); await tick(); assert.equal(hidden.prompts.length, 0);
});

test('becoming responsive cancels a pending hang prompt and ignores its late Reload response', async t => {
  const answer = deferred(), f = fixture(t, { ask: () => answer.promise });
  f.window.emit('unresponsive'); f.fire(15); await tick(); f.window.emit('responsive');
  assert.equal(f.prompts[0].signal.aborted, true); answer.resolve({ response: 1 }); await tick(); assert.equal(f.loads.length, 0);
});

test('native prompt failures are contained and preserve a running backend', async t => {
  const f = fixture(t, { ask: () => Promise.reject(new Error('fixture native prompt error')) });
  await f.recovery.rendererGone({ reason: 'crashed' }); await f.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(f.errors.length, 1); assert.equal(f.loads.length, 1); assert.equal(f.recovery.state, 'blocked');
});

test('desktop wiring isolates renderer recovery from detach and guards shutdown', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const wiring = source.slice(source.indexOf('const recovery = rendererRecovery = new DesktopRendererRecovery('), source.indexOf('let readyToShow = false;'));
  assert.ok(wiring.includes('dialog.showMessageBox(window, options)')); assert.ok(wiring.includes("event: 'renderer_gone'"));
  assert.ok(wiring.includes('restartClosing')); assert.ok(wiring.includes('maintenanceScheduled')); assert.ok(wiring.includes('desktopLifecycle.quitting'));
  assert.ok(!wiring.includes('detachDesktop')); assert.ok(!wiring.includes('app.quit')); assert.match(source, /return recovery\.loadInitial\(\)/);
  assert.match(source, /async function shutdown\(\) \{\s*rendererRecovery\?\.stop\(\)/);
  assert.match(source, /app\.on\('before-quit', event => \{\s*rendererRecovery\?\.stop\(\)/);
  assert.match(source, /!requested\.headless && !requested\.background\) await rendererRecovery\?\.retry\(\)/);
});
