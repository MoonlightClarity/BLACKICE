import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkFirefoxProcesses, discoverFirefoxProfile, firefoxSessionStatus, createFirefoxSessionLauncher, firefoxBiDiEndpoint, waitForFirefoxExit } from '../lib/firefox-session.mjs';

// Every fixture has an isolated owner registry; tests never spawn a real browser.
const startFirefoxSession = options => createFirefoxSessionLauncher().start(options);

const env = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
const exe = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const root = 'C:\\Users\\test\\AppData\\Roaming\\Mozilla\\Firefox';
const main = root + '\\Profiles\\actual.default-release';
const legacy = root + '\\Profiles\\empty.default';
const index = `[General]\nStartWithLastProfile=1\nVersion=2\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/empty.default\nDefault=1\n[Profile1]\nName=Daily\nIsRelative=1\nPath=Profiles/actual.default-release\n[InstallABC123]\nDefault=Profiles/actual.default-release\nLocked=1\n`;
function fixture(extra = {}) {
  const files = new Map([[root + '\\profiles.ini', index], [main + '\\compatibility.ini', '[Compatibility]\nLastPlatformDir=C:\\Program Files\\Mozilla Firefox\n']]);
  return { env, platform: 'win32', statImpl: async file => {
    if (file === exe) return { isFile: () => true };
    if ([main, legacy].includes(file)) return { isDirectory: () => true };
    throw Object.assign(new Error('Missing private path'), { code: 'ENOENT' });
  }, readFileImpl: async file => { if (!files.has(file)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return files.get(file); }, processCheckImpl: async () => ({ running: false, uncertain: false }), spawnImpl: () => { throw new Error('Unexpected real process launch'); }, ...extra };
}

test('per-install Firefox default overrides the legacy empty default and keeps the real profile in place', async () => {
  const result = await discoverFirefoxProfile(fixture());
  assert.equal(result.available, true); assert.equal(result.executable, exe); assert.equal(result.profilePath, main); assert.equal(result.profileName, 'Daily'); assert.equal(result.profileSource, 'install-default');
  assert.match(result.reason, /sign-in still needs a page check/);
});

test('legacy defaults and absolute existing profile paths are supported without directory-name guessing', async () => {
  const result = await discoverFirefoxProfile(fixture({ readFileImpl: async file => {
    if (file.endsWith('profiles.ini')) return '[Profile0]\nName=Work profile\nIsRelative=0\nPath=D:\\My Firefox Data\nDefault=1\n';
    throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  }, statImpl: async file => file === exe ? { isFile: () => true } : file === 'D:\\My Firefox Data' ? { isDirectory: () => true } : Promise.reject(new Error('Missing')) }));
  assert.equal(result.profilePath, 'D:\\My Firefox Data'); assert.equal(result.profileSource, 'legacy-default');
});

test('ambiguous install defaults are matched by compatibility metadata or declined', async () => {
  const config = index + '[InstallOTHER]\nDefault=Profiles/other.default\n';
  const base = fixture();
  const result = await discoverFirefoxProfile(fixture({ readFileImpl: async file => file.endsWith('profiles.ini') ? config : base.readFileImpl(file) }));
  assert.equal(result.profilePath, main);
  const ambiguous = await discoverFirefoxProfile(fixture({ readFileImpl: async file => file.endsWith('profiles.ini') ? config : '[Compatibility]\nLastPlatformDir=C:\\Program Files\\Mozilla Firefox\n' }));
  assert.equal(ambiguous.available, false); assert.match(ambiguous.reason, /multiple/);
});

test('missing profile metadata, missing profile directory and oversized indexes never create a fresh profile', async () => {
  for (const options of [
    fixture({ readFileImpl: async () => { throw new Error('Private file failure'); } }),
    fixture({ readFileImpl: async () => 'x'.repeat(256 * 1024 + 1) }),
    fixture({ statImpl: async file => file === exe ? { isFile: () => true } : Promise.reject(new Error('Missing')) }),
    fixture({ env: {} }),
    fixture({ platform: 'linux' }),
  ]) {
    const result = await discoverFirefoxProfile(options); assert.equal(result.available, false); assert.doesNotMatch(result.reason, /Private/);
  }
});

test('any running Firefox or uncertain inventory prevents another launch without disturbing its session', async () => {
  for (const processes of [{ running: true, uncertain: false }, { running: false, uncertain: true }, undefined]) {
    const result = await startFirefoxSession(fixture({ port: 45001, processCheckImpl: async () => processes, spawnImpl: () => { throw new Error('Must not launch'); } }));
    assert.equal(result.started, false); assert.equal(result.canStart, false);
  }
  const status = await firefoxSessionStatus(fixture({ processCheckImpl: async () => { throw new Error('CIM failure'); } })); assert.equal(status.canStart, false);
});

test('headless Firefox starts with the actual profile and a loopback BiDi endpoint parsed from stderr', async () => {
  const calls = []; let unref = false, owned;
  const result = await startFirefoxSession(fixture({ port: 45001, onSpawn: child => { owned = child; }, spawnImpl: (file, args, options) => {
    calls.push({ file, args, options }); const child = new EventEmitter(); child.pid = 4567; child.unref = () => { unref = true; }; child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.stderr.emit('data', '*** You are running in headless mode.\nWebDriver BiDi listening on ws://127.0.0.1:'); child.stderr.emit('data', '45001\n'); }); return child;
  } }));
  assert.equal(result.started, true); assert.equal(result.ready, true); assert.equal(result.endpoint, 'ws://127.0.0.1:45001/session'); assert.equal(result.profilePath, main); assert.equal(owned.pid, result.pid); assert.equal(unref, true);
  assert.deepEqual(calls[0], { file: exe, args: ['--headless', '--no-remote', '--new-instance', '--profile', main, '--remote-debugging-port=45001'], options: { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false } });
  assert.doesNotMatch(JSON.stringify(calls), /private-window|allow-downgrade|safe-mode|CreateProfile|cookie|remote-allow-origins/);
});

test('endpoint parsing rejects remote, credential and wrong-port addresses', () => {
  assert.equal(firefoxBiDiEndpoint('ws://127.0.0.1:45001', 45001), 'ws://127.0.0.1:45001/session');
  assert.equal(firefoxBiDiEndpoint('ws://[::1]:45001', 45001), 'ws://[::1]:45001/session');
  for (const value of ['ws://example.test:45001', 'ws://user:secret@127.0.0.1:45001', 'ws://127.0.0.1:45002', 'ws://127.0.0.1:45001/other', 'ws://127.0.0.1:45001/?token=secret']) assert.equal(firefoxBiDiEndpoint(value, 45001), null);
});

test('an exited browser and a readiness timeout never guess a ready endpoint or successful authentication', async () => {
  const exited = await startFirefoxSession(fixture({ port: 45001, spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('Private failure'))); return child; } }));
  assert.equal(exited.started, false); assert.doesNotMatch(exited.reason, /Private/);
  const timed = await startFirefoxSession(fixture({ port: 45001, timeoutMs: 100, spawnImpl: () => { const child = new EventEmitter(); child.pid = 9876; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } }));
  assert.equal(timed.started, true); assert.equal(timed.ready, false); assert.equal(timed.endpoint, undefined); assert.match(timed.reason, /did not report a complete browser endpoint/);
});

test('invalid ports and pre-cancelled starts do not launch Firefox', async () => {
  for (const port of [-1, 65536, '45001']) assert.equal((await startFirefoxSession(fixture({ port }))).started, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await startFirefoxSession({ port: 45001, signal: controller.signal, readFileImpl: () => { throw new Error('Must not read'); } })).started, false);
});

test('default port is allocated by Firefox and only its observed loopback endpoint is returned', async () => {
  let args;
  const result = await startFirefoxSession(fixture({ spawnImpl: (_file, input) => {
    args = input;
    const child = new EventEmitter(); child.pid = 7812; child.unref = () => {}; child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.stderr.emit('data', 'WebDriver BiDi listening on ws://127.0.0.1:51234\n'); });
    return child;
  } }));
  assert.equal(args.at(-1), '--remote-debugging-port=0');
  assert.equal(result.endpoint, 'ws://127.0.0.1:51234/session'); assert.equal(result.ready, true);
  assert.equal(typeof result.stop, 'function');
});

test('a Firefox starting during metadata discovery prevents launch at the final process recheck', async () => {
  let checks = 0, spawned = false;
  const result = await startFirefoxSession(fixture({ processCheckImpl: async () => ({ running: ++checks > 1, uncertain: false }), spawnImpl: () => { spawned = true; throw new Error('Must not launch'); } }));
  assert.equal(checks, 2); assert.equal(spawned, false); assert.equal(result.started, false); assert.equal(result.canStart, false);
});

test('graceful shutdown waits for the owned process without terminating any process', async () => {
  const child = new EventEmitter(); child.exitCode = null; child.kill = () => { throw new Error('Must never kill'); };
  const waiting = waitForFirefoxExit(child, { timeoutMs: 200 });
  queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); });
  assert.deepEqual(await waiting, { closed: true, running: false });
  assert.deepEqual(await waitForFirefoxExit(child), { closed: true, running: false });
  const stillRunning = new EventEmitter(); stillRunning.exitCode = null; stillRunning.kill = child.kill;
  assert.deepEqual(await waitForFirefoxExit(stillRunning, { timeoutMs: 100 }), { closed: false, running: true, reason: 'Firefox is still closing. Its process and profile were left intact.' });
  assert.equal(stillRunning.listenerCount('exit'), 0);
});

test('cancelling after spawn retains the owned process and does not invent an endpoint', async () => {
  const controller = new AbortController(); let owned;
  const result = await startFirefoxSession(fixture({ signal: controller.signal, timeoutMs: 100, spawnImpl: () => {
    const child = new EventEmitter(); owned = child; child.exitCode = null; child.pid = 8172; child.unref = () => {}; child.kill = () => { throw new Error('Must never kill'); };
    queueMicrotask(() => { child.emit('spawn'); controller.abort(); });
    return child;
  } }));
  assert.equal(result.started, true); assert.equal(result.cancelled, true); assert.equal(result.ready, false); assert.equal(result.endpoint, undefined);
  owned.exitCode = 0; owned.emit('exit', 0); assert.deepEqual(await result.stop(), { closed: true, running: false, owned: true });
});

test('process discovery is hidden, read-only, bounded and fails conservatively', async () => {
  const result = await checkFirefoxProcesses({ platform: 'win32', env, execFileImpl: async (file, args, options) => {
    assert.equal(file, 'powershell.exe'); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 3000);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le'); assert.match(script, /Get-CimInstance/); assert.doesNotMatch(script, /CommandLine|Stop-Process|Start-Process|Terminate/);
    return { stdout: '{"count":1}' };
  } });
  assert.deepEqual(result, { running: true, uncertain: false });
  for (const stdout of ['bad', '{}', '{"count":-1}']) assert.deepEqual(await checkFirefoxProcesses({ platform: 'win32', execFileImpl: async () => ({ stdout }) }), { running: false, uncertain: true });
});

function ownedProcess(pid = 9172) {
  const child = new EventEmitter(); child.pid = pid; child.exitCode = null; child.unref = () => {};
  child.stderr = new EventEmitter(); child.stderr.resume = () => {};
  child.kill = () => { throw new Error('The launcher must never terminate Firefox'); };
  child.finish = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.announce = (line = 'ws://127.0.0.1:51234') => child.stderr.emit('data', `WebDriver BiDi listening on ${line}\n`);
  return child;
}

test('a startup timeout retains ownership and a late endpoint can be recovered without a second process', async () => {
  const launcher = createFirefoxSessionLauncher(), child = ownedProcess(); let spawns = 0;
  const options = fixture({ timeoutMs: 10, spawnImpl: () => { spawns++; queueMicrotask(() => child.emit('spawn')); return child; } });
  const launch = await launcher.start(options);
  assert.equal(launch.running, true); assert.equal(launch.recoveryRequired, true); assert.equal(launcher.current(), launch);
  child.announce();
  const retry = await launcher.start(options);
  assert.equal(retry, launch); assert.equal(retry.ready, true); assert.equal(retry.recoveryRequired, false); assert.equal(spawns, 1);
  const exit = await retry.stop({ timeoutMs: 100, closeBrowser: async ({ endpoint, pid }) => { assert.equal(endpoint, 'ws://127.0.0.1:51234/session'); assert.equal(pid, child.pid); child.finish(); } });
  assert.equal(exit.closed, true); assert.equal(launcher.current(), null); assert.equal(launch.running, false); assert.equal(launch.ready, false);
  assert.equal(child.stderr.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('error'), 0);
});

test('an endpoint split within its port waits for a complete line and invalid lines do not block later valid announcements', async () => {
  const child = ownedProcess(), launcher = createFirefoxSessionLauncher();
  const starting = launcher.start(fixture({ timeoutMs: 100, spawnImpl: () => {
    queueMicrotask(() => {
      child.emit('spawn'); child.stderr.emit('data', 'WebDriver BiDi listening on ws://127.0.0.1:51');
      assert.equal(launcher.current().endpoint, undefined);
      child.stderr.emit('data', '234\n');
    }); return child;
  } }));
  const result = await starting; assert.equal(result.endpoint, 'ws://127.0.0.1:51234/session'); child.finish();
  const next = ownedProcess();
  const recovered = await launcher.start(fixture({ timeoutMs: 100, spawnImpl: () => {
    queueMicrotask(() => { next.emit('spawn'); next.stderr.emit('data', 'WebDriver BiDi listening on ws://remote.invalid:51234\nWebDriver BiDi listening on ws://127.0.0.1:51235\n'); }); return next;
  } }));
  assert.equal(recovered.endpoint, 'ws://127.0.0.1:51235/session'); next.finish();
});

test('cancelled startup keeps observing the owned child and graceful cleanup can wait for its endpoint', async () => {
  const launcher = createFirefoxSessionLauncher(), controller = new AbortController(), child = ownedProcess();
  const launch = await launcher.start(fixture({ signal: controller.signal, spawnImpl: () => {
    queueMicrotask(() => { child.emit('spawn'); controller.abort(); }); return child;
  } }));
  assert.equal(launch.cancelled, true); assert.equal(launch.recoveryRequired, true); assert.equal(launch.running, true);
  const stopping = launch.stop({ timeoutMs: 100, closeBrowser: async () => child.finish() });
  queueMicrotask(() => child.announce());
  assert.equal((await stopping).closed, true); assert.equal(launcher.current(), null);
});

test('missing endpoints and failed graceful handshakes preserve ownership and allow a later Disconnect retry', async () => {
  const launcher = createFirefoxSessionLauncher(), child = ownedProcess(); let closes = 0;
  const launch = await launcher.start(fixture({ timeoutMs: 1, spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; } }));
  const unavailable = await launch.stop({ timeoutMs: 1, closeBrowser: async () => { closes++; } });
  assert.equal(unavailable.closed, false); assert.equal(unavailable.running, true); assert.equal(unavailable.owned, true); assert.equal(unavailable.recoveryRequired, true); assert.equal(closes, 0);
  assert.match(unavailable.reason, /retains ownership/); assert.equal(launcher.current(), launch);
  child.announce();
  const failed = await launch.stop({ timeoutMs: 1, closeBrowser: async () => { closes++; throw new Error('Private protocol failure'); } });
  assert.equal(failed.closed, false); assert.doesNotMatch(failed.reason, /Private/); assert.equal(launcher.current(), launch);
  const retry = await launch.stop({ timeoutMs: 100, closeBrowser: async () => { closes++; child.finish(); } });
  assert.equal(retry.closed, true); assert.equal(closes, 2); assert.equal(launcher.current(), null);
});

test('concurrent starts and disconnects share one owned process and one graceful close request', async () => {
  const launcher = createFirefoxSessionLauncher(), child = ownedProcess(); let spawns = 0, closes = 0, release;
  const options = fixture({ spawnImpl: () => { spawns++; queueMicrotask(() => { child.emit('spawn'); child.announce(); }); return child; } });
  const [first, second] = await Promise.all([launcher.start(options), launcher.start(options)]);
  assert.equal(first, second); assert.equal(spawns, 1);
  const closeBrowser = async () => { closes++; await new Promise(resolve => { release = resolve; }); child.finish(); };
  const one = first.stop({ timeoutMs: 100, closeBrowser }), two = first.stop({ timeoutMs: 100, closeBrowser });
  assert.equal(first.closing, true); assert.equal(first.ready, false);
  assert.equal((await launcher.start(options)).closing, true); assert.equal(spawns, 1);
  await Promise.resolve(); release();
  assert.equal((await one).closed, true); assert.equal((await two).closed, true); assert.equal(closes, 1);
});

test('a hung graceful close request is bounded and retains its process instead of killing it', async () => {
  const launcher = createFirefoxSessionLauncher(), child = ownedProcess(); let signal;
  const launch = await launcher.start(fixture({ spawnImpl: () => { queueMicrotask(() => { child.emit('spawn'); child.announce(); }); return child; } }));
  const result = await launch.stop({ timeoutMs: 5, closeBrowser: async options => { signal = options.signal; await new Promise(() => {}); } });
  assert.equal(result.closed, false); assert.equal(result.running, true); assert.equal(signal.aborted, true); assert.equal(launcher.current(), launch);
  child.finish(); assert.equal((await launch.stop()).closed, true);
});

test('process errors after spawn never falsely release an owned live profile', async () => {
  const launcher = createFirefoxSessionLauncher(), child = ownedProcess();
  const launch = await launcher.start(fixture({ timeoutMs: 1, spawnImpl: () => {
    queueMicrotask(() => { child.emit('spawn'); child.emit('error', new Error('Private process failure')); child.stderr.emit('error', new Error('Private stream failure')); }); return child;
  } }));
  assert.equal(launch.running, true); assert.equal(launcher.current(), launch); assert.equal(launch.recoveryRequired, true); assert.doesNotMatch(launch.reason, /Private/);
  child.finish(); assert.equal(launch.running, false); assert.equal(launcher.current(), null);
});
