import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopLifecycle, parseDesktopLaunchArgs, buildDesktopRelaunchArgs, prepareDesktopProfile } from '../desktop/lifecycle.mjs';

function fixture({ headless = false, background = false, restart, waitForWindow } = {}) {
  let window = null, created = 0, saved = 0, quits = 0;
  const lifecycle = new DesktopLifecycle({ headless, background, restart, getWindow: () => window, createWindow: async () => { created++; if (waitForWindow) await waitForWindow; window = { visible: false, minimized: false, destroyed: false, focused: 0, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; }, restore() { this.minimized = false; }, show() { this.visible = true; }, hide() { this.visible = false; }, focus() { this.focused++; } }; return window; }, saveWindow: async () => { saved++; }, quit: () => { quits++; } });
  return { lifecycle, get window() { return window; }, get created() { return created; }, get saved() { return saved; }, get quits() { return quits; } };
}

test('headless startup keeps the runtime alive without creating a window', async () => {
  const f = fixture({ headless: true }); await f.lifecycle.start(); assert.equal(f.created, 0); assert.equal(f.lifecycle.status().mode, 'headless'); assert.equal(f.lifecycle.status().windowVisible, false); assert.equal(f.lifecycle.status().sameProfile, true);
  f.lifecycle.windowClosed(); assert.equal(f.quits, 0);
});

test('background mode hides the window while preserving the same instance and saved bounds', async () => {
  const f = fixture(); await f.lifecycle.start(); const window = f.window; assert.equal(window.visible, true);
  await f.lifecycle.background(); assert.equal(f.window, window); assert.equal(f.window.visible, false); assert.equal(f.saved, 1); assert.equal(f.lifecycle.status().mode, 'background'); f.lifecycle.windowClosed(); assert.equal(f.quits, 0);
  await f.lifecycle.secondInstance({ headless: false }); assert.equal(f.window, window); assert.equal(f.created, 1); assert.equal(f.window.visible, true); assert.equal(f.lifecycle.status().mode, 'window');
});

test('normal reopening of a headless instance creates exactly one window for concurrent requests', async () => {
  const f = fixture({ headless: true }); await f.lifecycle.start(); await Promise.all([f.lifecycle.show(), f.lifecycle.show(), f.lifecycle.secondInstance({})]); assert.equal(f.created, 1); assert.equal(f.lifecycle.status().windowVisible, true);
  f.window.minimized = true; await f.lifecycle.show(); assert.equal(f.window.minimized, false); assert.equal(f.created, 1);
});

test('an explicit headless second launch does not hide an already visible workspace', async () => {
  const f = fixture(); await f.lifecycle.start(); const window = f.window; await f.lifecycle.secondInstance({ headless: true }); assert.equal(f.window, window); assert.equal(window.visible, true); assert.equal(f.lifecycle.status().mode, 'window');
});

test('background requested while a new window is loading prevents it from being revealed', async () => {
  let resolve; const waitForWindow = new Promise(done => { resolve = done; }), f = fixture({ headless: true, waitForWindow }); await f.lifecycle.start(); const showing = f.lifecycle.show(); await Promise.resolve(); await f.lifecycle.background(); resolve(); await showing;
  assert.equal(f.created, 1); assert.equal(f.window.visible, false); assert.equal(f.lifecycle.status().mode, 'background');
});

test('normal close and explicit --quit use the existing graceful quit callback only once', async () => {
  const f = fixture(); await f.lifecycle.start(); f.lifecycle.windowClosed(); f.lifecycle.windowClosed(); await f.lifecycle.secondInstance({ quit: true }); assert.equal(f.quits, 1);
  f.lifecycle.stop(); await assert.rejects(f.lifecycle.show(), /closing/); await assert.rejects(f.lifecycle.background(), /closing/);
  const headless = fixture({ headless: true }); await headless.lifecycle.start(); await headless.lifecycle.secondInstance({ quit: true }); assert.equal(headless.quits, 1); assert.equal(headless.created, 0);
});

test('desktop profile arguments preserve the default and reject ambiguous or nonlocal paths', () => {
  assert.deepEqual(parseDesktopLaunchArgs(['electron', '.', '--headless']), { headless: true, background: false, quit: false, restart: false, profileDir: null });
  assert.equal(parseDesktopLaunchArgs(['--profile-dir=C:\\Temp\\BLACKICE'], { platform: 'win32' }).profileDir, 'C:\\Temp\\BLACKICE');
  assert.equal(parseDesktopLaunchArgs(['--profile', '/tmp/blackice'], { platform: 'linux' }).profileDir, '/tmp/blackice');
  for (const argv of [['--profile-dir'], ['--profile-dir='], ['--profile-dir=relative'], ['--profile-dir=/'], ['--profile-dir=/tmp/a', '--profile-dir=/tmp/b'], ['--headless=true'], ['--headless', '--quit']]) assert.throws(() => parseDesktopLaunchArgs(argv, { platform: 'linux' }));
  for (const value of ['C:\\', '\\\\server\\share', '\\\\?\\C:\\Temp\\profile', 'C:relative', ' C:\\Temp']) assert.throws(() => parseDesktopLaunchArgs(['--profile-dir=' + value], { platform: 'win32' }));
});

test('restart and background flags are explicit booleans with no contradictory launch mode', () => {
  assert.deepEqual(parseDesktopLaunchArgs(['electron', '.', '--restart']), { headless: false, background: false, quit: false, restart: true, profileDir: null });
  assert.deepEqual(parseDesktopLaunchArgs(['electron', '.', '--background']), { headless: false, background: true, quit: false, restart: false, profileDir: null });
  assert.equal(parseDesktopLaunchArgs(['--restart', '--profile-dir=/tmp/custom-profile'], { platform: 'linux' }).profileDir, '/tmp/custom-profile');
  for (const argv of [
    ['--restart', '--quit'], ['--restart', '--headless'], ['--restart', '--background'],
    ['--headless', '--background'], ['--background', '--quit'],
    ['--restart=true'], ['--restart=false'], ['--background=true'], ['--background='], ['--quit=false'], ['--headless=false'], ['--force'], ['--force=true'],
  ]) assert.throws(() => parseDesktopLaunchArgs(argv, { platform: 'linux' }));
});

test('relaunch keeps dev and unrelated arguments while replacing transient flags and the selected profile', () => {
  const argv = ['electron', '/development/blackice', '--disable-gpu', '--custom=value', '--restart', '--quit', '--headless', '--background', '--profile-dir', '/tmp/old-profile', '--profile=/tmp/older-profile', '--profile-dir=/tmp/oldest-profile', '--profile', '/tmp/other-profile'];
  const original = [...argv];
  assert.deepEqual(buildDesktopRelaunchArgs({ argv, profileDir: '/tmp/current profile', mode: 'background' }), ['/development/blackice', '--disable-gpu', '--custom=value', '--profile-dir', '/tmp/current profile', '--background']);
  assert.deepEqual(argv, original, 'building relaunch arguments does not mutate the original command line');
  assert.deepEqual(buildDesktopRelaunchArgs({ argv: ['blackice.exe', '--profile-dir=C:\\Old', '--headless', '--restart', '--quit'], profileDir: 'C:\\Current Profile', mode: 'window' }), ['--profile-dir', 'C:\\Current Profile']);
});

test('native restart request and compatibility flags cannot replay through relaunch', () => {
  const argv = ['electron', '.', '--restart', '--force', '--force=true', '--request-id', 'first', '--restart-status', '--cancel-restart', '--request-id=second', '--legacy-native-handoff', '--unrelated'];
  assert.deepEqual(buildDesktopRelaunchArgs({ argv, mode: 'background' }), ['.', '--unrelated', '--background']);
});

test('relaunch mode comes from the running instance and never preserves restart or quit triggers', () => {
  const argv = ['blackice', '--headless', '--profile-dir=/tmp/stale', '--restart', '--quit', '--background=false', '--restart=true', '--quit=false', '--headless=true', '--unrelated'];
  for (const mode of ['window', 'background', 'headless']) {
    const args = buildDesktopRelaunchArgs({ argv, mode });
    assert.deepEqual(args, ['--unrelated', ...(mode === 'window' ? [] : [`--${mode}`])]);
    const launch = parseDesktopLaunchArgs(['blackice', ...args]);
    assert.equal(launch.restart, false); assert.equal(launch.quit, false); assert.equal(launch.profileDir, null);
    assert.equal(launch.headless, mode === 'headless'); assert.equal(launch.background, mode === 'background');
  }
  assert.throws(() => buildDesktopRelaunchArgs({ argv, mode: 'unknown' }), /current desktop mode/);
});

test('background relaunch starts hidden and a background second instance never changes the running mode', async () => {
  const restored = fixture({ background: true }); await restored.lifecycle.start();
  assert.equal(restored.created, 0); assert.equal(restored.lifecycle.status().mode, 'background'); assert.equal(restored.lifecycle.status().windowVisible, false);
  restored.lifecycle.windowClosed(); assert.equal(restored.quits, 0);
  const visible = fixture(); await visible.lifecycle.start(); const window = visible.window;
  await visible.lifecycle.secondInstance({ background: true });
  assert.equal(visible.window, window); assert.equal(window.visible, true); assert.equal(visible.lifecycle.status().mode, 'window');
  await restored.lifecycle.secondInstance({}); assert.equal(restored.created, 1); assert.equal(restored.lifecycle.status().mode, 'window');
});

test('restart waits for readiness and duplicate requests share a single restart without changing mode', async () => {
  let restarts = 0, release; const completed = new Promise(resolve => { release = resolve; });
  const f = fixture({ background: true, restart: async () => { restarts++; await completed; } });
  assert.equal(f.lifecycle.status().supportsRestart, true);
  const first = f.lifecycle.secondInstance({ restart: true }), second = f.lifecycle.secondInstance({ restart: true });
  assert.equal(first, second); await Promise.resolve(); assert.equal(restarts, 0);
  await f.lifecycle.start(); await Promise.resolve(); assert.equal(restarts, 1);
  const third = f.lifecycle.secondInstance({ restart: true }); assert.equal(third, first);
  release(); await Promise.all([first, second, third]);
  await f.lifecycle.secondInstance({ restart: true }); assert.equal(restarts, 1);
  assert.equal(f.created, 0); assert.equal(f.quits, 0); assert.equal(f.lifecycle.status().mode, 'background');
});

test('failed restart keeps the running desktop usable and permits a deliberate retry', async () => {
  let attempts = 0;
  const f = fixture({ restart: async () => { attempts++; throw Error('Restart preparation failed.'); } });
  await f.lifecycle.start(); const window = f.window;
  const first = f.lifecycle.secondInstance({ restart: true }), duplicate = f.lifecycle.secondInstance({ restart: true });
  await Promise.all([assert.rejects(first, /Restart preparation failed/), assert.rejects(duplicate, /Restart preparation failed/)]);
  assert.equal(attempts, 1); assert.equal(f.quits, 0); assert.equal(f.window, window); assert.equal(window.visible, true); assert.equal(f.lifecycle.status().mode, 'window');
  await assert.rejects(f.lifecycle.secondInstance({ restart: true }), /Restart preparation failed/);
  assert.equal(attempts, 2); assert.equal(f.quits, 0); await f.lifecycle.show(); assert.equal(f.created, 1);
});

test('unavailable or closing desktop restart never invokes a quit or restart callback', async () => {
  const unavailable = fixture({ headless: true }); await unavailable.lifecycle.start();
  assert.equal(unavailable.lifecycle.status().supportsRestart, false);
  await assert.rejects(unavailable.lifecycle.secondInstance({ restart: true }), /restart is unavailable/); assert.equal(unavailable.quits, 0);
  let restarts = 0; const stopped = fixture({ restart: () => { restarts++; } });
  const pending = stopped.lifecycle.secondInstance({ restart: true }); stopped.lifecycle.stop();
  await assert.rejects(pending, /closing/); assert.equal(restarts, 0); assert.equal(stopped.quits, 0);
});

test('an explicit profile is created in its own ordinary directory and symlink ancestors are refused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-desktop-profile-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'independent', 'profile'); assert.equal(await prepareDesktopProfile({ profileDir: profile }), profile); assert.equal((await fs.stat(profile)).isDirectory(), true);
  assert.equal(await prepareDesktopProfile({ profileDir: null }, { defaultProfile: 'historical-profile' }), 'historical-profile');
  const file = path.join(root, 'file'); await fs.writeFile(file, 'keep'); await assert.rejects(prepareDesktopProfile({ profileDir: path.join(file, 'profile') }));
  const link = path.join(root, 'redirect'); await fs.symlink(path.join(root, 'independent'), link, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(prepareDesktopProfile({ profileDir: path.join(link, 'other-profile') }), /symbolic links/); assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});
