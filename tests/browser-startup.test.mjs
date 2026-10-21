import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkBrowserProcesses, inspectBackgroundBrowser, startBackgroundBrowser } from '../lib/browser-startup.mjs';

const env = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
const executable = 'C:\\Users\\test\\AppData\\Local\\BrowserClaw\\Application\\chrome.exe';
const userData = 'C:\\Users\\test\\AppData\\Local\\BrowserClaw\\User Data';
const defaults = { env, platform: 'win32', statImpl: async target => { assert.ok([executable, userData].includes(target)); return { isFile: () => target === executable, isDirectory: () => target === userData }; }, processCheckImpl: async () => ({ running: false, uncertain: false }) };

test('manual external startup requests no startup window and explains that the browser may foreground', async () => {
  const calls = []; let unreferenced = false;
  const result = await startBackgroundBrowser({ ...defaults, spawnImpl: (file, args, options) => {
    calls.push({ file, args, options }); const child = new EventEmitter(); child.pid = 1234; child.unref = () => { unreferenced = true; }; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.equal(result.started, true); assert.equal(result.pid, 1234); assert.equal(unreferenced, true);
  assert.deepEqual(calls, [{ file: executable, args: ['--no-first-run', '--no-default-browser-check', '--no-startup-window', '--keep-alive-for-test', `--user-data-dir=${userData}`], options: { windowsHide: true, detached: true, stdio: 'ignore', shell: false } }]);
  assert.equal(calls[0].args.filter(arg => arg.startsWith('--user-data-dir=')).length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /headless|incognito|remote-debugging|cookie|profile-directory|force/);
  assert.match(result.reason, /manual external browser connection/);
  assert.match(result.reason, /may foreground/);
  assert.doesNotMatch(result.reason, /without activating|without a (?:startup|browser) window/);
  assert.equal(result.persistentProfileAvailable, true);
});

test('an existing browser or an uncertain process check is never launched, focused or terminated', async () => {
  for (const processes of [{ running: true, uncertain: false }, { running: true, uncertain: true }, { running: false, uncertain: true }, undefined]) {
    const result = await startBackgroundBrowser({ ...defaults, processCheckImpl: async () => processes, spawnImpl: () => { throw new Error('Must not launch'); } });
    assert.equal(result.started, false); assert.equal(result.canStart, false);
  }
  const failedCheck = await startBackgroundBrowser({ ...defaults, processCheckImpl: async () => { throw new Error('Private process data'); }, spawnImpl: () => { throw new Error('Must not launch'); } });
  assert.equal(failedCheck.started, false); assert.doesNotMatch(failedCheck.reason, /Private/);
});

test('read-only Windows process check uses hidden bounded CIM and handles inaccessible paths conservatively', async () => {
  for (const [matchingCount, uncertain, expected] of [[0, false, { running: false, uncertain: false }], [1, false, { running: true, uncertain: false }], [0, true, { running: false, uncertain: true }]]) {
    const actual = await checkBrowserProcesses(executable, { env, platform: 'win32', execFileImpl: async (file, args, options) => {
      assert.equal(file, 'powershell.exe'); assert.ok(args.includes('-NonInteractive')); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 3000);
      assert.equal(options.env.RELAY_BROWSER_STARTUP_EXE, executable);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /Get-CimInstance Win32_Process/); assert.match(script, /ExecutablePath/); assert.match(script, /OrdinalIgnoreCase/);
      assert.doesNotMatch(script, /Stop-Process|Start-Process|CommandLine|Terminate|Remove-Item/);
      return { stdout: JSON.stringify({ matchingCount, uncertain }) };
    } });
    assert.deepEqual(actual, expected);
  }
  for (const stdout of ['not json', '{}', '{"matchingCount":-1,"uncertain":false}']) assert.deepEqual(await checkBrowserProcesses(executable, { platform: 'win32', execFileImpl: async () => ({ stdout }) }), { running: false, uncertain: true });
  assert.deepEqual(await checkBrowserProcesses(executable, { platform: 'win32', execFileImpl: async () => { throw new Error('CIM denied'); } }), { running: false, uncertain: true });
});

test('missing, inaccessible and unsupported installations do not spawn', async () => {
  const spawnImpl = () => { throw new Error('Must not launch'); };
  for (const options of [
    { ...defaults, platform: 'linux' },
    { ...defaults, env: {} },
    { ...defaults, env: { LOCALAPPDATA: 'relative-path' } },
    { ...defaults, statImpl: async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); } },
    { ...defaults, statImpl: async () => { throw Object.assign(new Error('Private path denied'), { code: 'EACCES' }); } },
  ]) {
    const status = await startBackgroundBrowser({ ...options, spawnImpl }); assert.equal(status.started, false); assert.doesNotMatch(status.reason, /Private/);
  }
});

test('missing or unreadable existing profile folders are never created or replaced with fresh profiles', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const status = await startBackgroundBrowser({ ...defaults, statImpl: async target => {
      if (target === userData) throw Object.assign(new Error('Private profile path'), { code });
      return { isFile: () => true };
    }, spawnImpl: () => { throw new Error('Must not launch'); } });
    assert.equal(status.started, false); assert.equal(status.canStart, false); assert.equal(status.persistentProfileAvailable, false);
    assert.match(status.reason, /profile folder/); assert.doesNotMatch(status.reason, /Private/);
  }
  const wrongType = await inspectBackgroundBrowser({ ...defaults, statImpl: async () => ({ isFile: () => true, isDirectory: () => false }) });
  assert.equal(wrongType.canStart, false); assert.equal(wrongType.persistentProfileAvailable, false);
});

test('a failed process creation is reported without claiming a ready browser connection', async () => {
  const failed = await startBackgroundBrowser({ ...defaults, spawnImpl: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('Private executable error'))); return child;
  } });
  assert.equal(failed.started, false); assert.equal(failed.running, false); assert.doesNotMatch(failed.reason, /Private/);
  const available = await inspectBackgroundBrowser(defaults);
  assert.equal(available.canStart, true);
  assert.match(available.reason, /started manually/);
  assert.match(available.reason, /external browser may foreground/);
});

test('concurrent start requests share one process launch and a subsequent request checks processes again', async () => {
  let spawned = 0, checked = 0;
  const options = { ...defaults, processCheckImpl: async () => { checked++; return { running: spawned > 0, uncertain: false }; }, spawnImpl: () => {
    spawned++; const child = new EventEmitter(); child.pid = 2345; child.unref = () => {}; setImmediate(() => child.emit('spawn')); return child;
  } };
  const [first, second] = await Promise.all([startBackgroundBrowser(options), startBackgroundBrowser(options)]);
  assert.equal(first.started, true); assert.equal(second.pid, first.pid); assert.equal(spawned, 1); assert.equal(checked, 1);
  const next = await startBackgroundBrowser(options); assert.equal(next.started, false); assert.equal(next.running, true); assert.equal(checked, 2); assert.equal(spawned, 1);
});

test('cancelled background startup never spawns before or after process inspection', async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = await startBackgroundBrowser({ ...defaults, signal: controller.signal, spawnImpl: () => { throw new Error('Must not launch'); } });
  assert.equal(cancelled.started, false); assert.match(cancelled.reason, /cancelled/);
  const during = new AbortController();
  const inspected = await startBackgroundBrowser({ ...defaults, signal: during.signal, processCheckImpl: async () => { during.abort(); return { running: false, uncertain: false }; }, spawnImpl: () => { throw new Error('Must not launch'); } });
  assert.equal(inspected.started, false); assert.match(inspected.reason, /cancelled/);
});
