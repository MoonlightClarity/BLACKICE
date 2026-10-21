import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ConnectionStartup } from '../lib/connection-startup.mjs';
import { createDesktopConnectionStartup, startupLoginSpec, loginStartupState, loginStartupInspectScript, tailscaleStartupState, tailscaleStartupRepairScript, runStartupPowerShell, TAILSCALE_STARTUP_INSPECT, TAILSCALE_SERVICE_REPAIR, STARTUP_COMMANDLINE_NATIVE } from '../desktop/connection-startup.mjs';

const waitTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const healthy = { ready: true, canEnable: true, detail: 'ready' };
const missing = { ready: false, canEnable: true, detail: 'disabled' };
const spec = startupLoginSpec({ executable: 'C:\\Program Files\\BLACKICE\\BLACKICE.exe', profileDir: 'C:\\Users\\Test\\AppData\\Roaming\\Relay' });
const exactSettings = { openAtLogin: true, launchItems: [{ name: spec.name, path: spec.path, args: spec.args, enabled: true }] };
const registered = { entryExists: true, commandMatches: true, approval: 'enabled' };
const unregistered = { entryExists: false, commandMatches: false, approval: 'enabled' };
const tailscaleRaw = { installed: true, servicePresent: true, serviceAutomatic: true, serviceRunning: true, unattended: true, supported: true, connected: true };

test('startup diagnostics are read-only, coalesced and cached independently of current connectivity', async () => {
  const read = deferred(); let reads = 0, mutations = 0, time = 1000;
  const manager = new ConnectionStartup({ platform: 'win32', now: () => time, tailscale: { inspect: async () => { reads++; await read.promise; return missing; }, enable: async () => mutations++ }, blackice: { inspect: async () => healthy, enable: async () => mutations++ } });
  const one = manager.snapshot(), two = manager.snapshot(); await waitTurn(); assert.equal(reads, 1); read.resolve();
  for (const state of await Promise.all([one, two])) { assert.equal(state.ready, false); assert.equal(state.canEnable, true); assert.equal(state.checks[0].ok, false); }
  await manager.snapshot(); assert.equal(reads, 1); assert.equal(mutations, 0);
  time += 30001; await manager.snapshot(); assert.equal(reads, 2); assert.equal(mutations, 0);
});

test('setup is idempotent and coalesces repeated clicks while the actual helper remains pending', async () => {
  const physical = deferred(); let tailReady = false, appReady = false, tails = 0, apps = 0;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => tailReady ? healthy : missing, enable: async () => { tails++; await physical.promise; tailReady = true; } }, blackice: { inspect: async () => appReady ? healthy : missing, enable: async () => { apps++; appReady = true; } } });
  await manager.snapshot(); const one = manager.enable(), two = manager.enable(); await waitTurn();
  assert.equal(tails, 1); assert.equal(apps, 0); assert.equal(manager.busy, true); const during = await manager.snapshot(); assert.equal(during.busy, true); assert.equal(during.canEnable, false);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(manager.busy, true); assert.equal(apps, 0);
  physical.resolve(); for (const result of await Promise.all([one, two])) assert.equal(result.ready, true);
  assert.equal(manager.busy, false); assert.equal(tails, 1); assert.equal(apps, 1);
  await manager.enable(); assert.equal(tails, 1); assert.equal(apps, 1);
});

test('a denied native setup is sanitized, settles busy, and does not register BLACKICE startup', async () => {
  let registered = false;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => missing, enable: async () => { throw new Error('secret-native-cli-output'); } }, blackice: { inspect: async () => missing, enable: async () => { registered = true; } } });
  await assert.rejects(manager.enable(), error => error.code === 'CONNECTION_STARTUP_FAILED' && !error.message.includes('secret-native'));
  assert.equal(registered, false); assert.equal(manager.busy, false); assert.equal((await manager.snapshot()).ready, false);
});

test('a successful helper exit cannot report startup ready without verified readback', async () => {
  let appWrites = 0;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => missing, enable: async () => {} }, blackice: { inspect: async () => missing, enable: async () => appWrites++ } });
  await assert.rejects(manager.enable(), { code: 'CONNECTION_STARTUP_NOT_VERIFIED' }); assert.equal(appWrites, 0); assert.equal((await manager.snapshot()).ready, false);
});

test('first-ever enable keeps concurrent snapshots from starting a stale diagnostic read', async () => {
  const held = deferred(); let reads = 0;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => { reads++; await held.promise; return healthy; } }, blackice: { inspect: async () => healthy } });
  const enabling = manager.enable(); await waitTurn();
  const during = await manager.snapshot({ refresh: true }); assert.equal(during.busy, true); assert.equal(during.checkedAt, null); assert.deepEqual(during.checks, []); assert.equal(reads, 1);
  held.resolve(); assert.equal((await enabling).ready, true); assert.equal((await manager.snapshot()).ready, true); assert.equal(reads, 1);
});

test('partial native success followed by login failure is reported with refreshed checks, never an unchanged claim', async () => {
  let tailReady = false;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => tailReady ? healthy : missing, enable: async () => { tailReady = true; } }, blackice: { inspect: async () => missing, enable: async () => { throw new Error('private registry details'); } } });
  await assert.rejects(manager.enable(), error => error.code === 'CONNECTION_STARTUP_FAILED' && /may have changed/.test(error.message) && !/preserved|private registry/.test(error.message));
  const result = await manager.snapshot(); assert.equal(result.ready, false); assert.equal(result.checks[0].ok, true); assert.equal(result.checks[1].ok, false); assert.equal(result.busy, false);
});

test('existing managed startup and unknown read results cannot be overwritten', async () => {
  let writes = 0;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => healthy, enable: async () => writes++ }, blackice: { inspect: async () => ({ ready: false, canEnable: false, detail: 'managed' }), enable: async () => writes++ } });
  assert.equal((await manager.snapshot()).canEnable, false); await assert.rejects(manager.enable(), { code: 'CONNECTION_STARTUP_UNAVAILABLE' }); assert.equal(writes, 0);
});

test('startup login identity requires the exact enabled current-profile entry', () => {
  assert.equal(loginStartupState(exactSettings, { relatedTask: false }, spec, registered).ready, true);
  // Real Electron44 custom-name getter: default openAtLogin is false and GetArgs
  // omits lifecycle/profile switches. Only the full native registry proof counts.
  const lossy = { openAtLogin: false, executableWillLaunchAtLogin: true, launchItems: [{ name: spec.name, path: `"${spec.path}"`, args: [spec.args.at(-1)], enabled: true }] };
  assert.equal(loginStartupState(lossy, { relatedTask: false }, spec, registered).ready, true);
  for (const proof of [undefined, {}, { ...registered, commandMatches: false }, { ...registered, approval: 'disabled' }, { ...registered, approval: 'unknown' }, unregistered]) {
    const state = loginStartupState(exactSettings, { relatedTask: false }, spec, proof); assert.equal(state.ready, false); assert.equal(state.canEnable, false);
  }
  const task = loginStartupState({ openAtLogin: false, launchItems: [] }, { relatedTask: true }, spec, unregistered); assert.equal(task.canEnable, false); assert.match(task.detail, /preserved/);
  assert.equal(loginStartupState({}, {}, spec, unregistered).canEnable, false);
  assert.equal(loginStartupState({}, { relatedTask: false }, spec, unregistered).canEnable, true);
});

test('native Windows startup proof retains all switches, quoted paths and current-profile identity', async () => {
  const inspect = loginStartupInspectScript(spec);
  assert.match(inspect, /OpenSubKey\([^\n]+\$false\)/); assert.doesNotMatch(inspect, /SetValue|DeleteValue|CreateSubKey|\.GetArgs\(/);
  if (process.platform !== 'win32') { assert.match(STARTUP_COMMANDLINE_NATIVE, /CommandLineToArgvW/); return; }
  const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  const command = args => [spec.path, ...args].map(quote).join(' ');
  const cases = [
    { command: command(spec.args), expected: true },
    { command: command([spec.args.at(-1)]), expected: false },
    { command: command(['--headless', '--profile-dir', spec.args.at(-1)]), expected: false },
    { command: command(['--background', '--profile-dir', 'C:\\Users\\SomeoneElse\\Relay']), expected: false },
    { command: command([...spec.args, '--quit']), expected: false },
    { command: `${spec.path} ${spec.args.map(quote).join(' ')}`, expected: false },
  ];
  const approvals = [
    { bytes: Array(12).fill(0), expected: 'enabled' },
    { bytes: [2, ...Array(11).fill(0)], expected: 'enabled' },
    { bytes: [3, ...Array(11).fill(0)], expected: 'disabled' },
    { bytes: [6, ...Array(11).fill(0)], expected: 'unknown' },
    { bytes: [2, 0, 0, 0], expected: 'unknown' },
  ];
  const payload = Buffer.from(JSON.stringify({ spec, cases, approvals })).toString('base64');
  const script = `${STARTUP_COMMANDLINE_NATIVE}\n$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n$commands = @($data.cases | ForEach-Object { [BlackiceStartupCommandLine]::Matches($_.command, $data.spec.path, [string[]]$data.spec.args) })\n$approvals = @($data.approvals | ForEach-Object { [BlackiceStartupCommandLine]::Approval([byte[]]$_.bytes) })\n@{ commands = $commands; approvals = $approvals } | ConvertTo-Json -Compress`;
  assert.deepEqual(JSON.parse(await runStartupPowerShell(script)), { commands: cases.map(item => item.expected), approvals: approvals.map(item => item.expected) });
});

test('Tailscale can be explicitly repaired while an existing BLACKICE scheduled task remains untouched', async () => {
  let ready = false, tailWrites = 0, appWrites = 0;
  const manager = new ConnectionStartup({ platform: 'win32', tailscale: { inspect: async () => ready ? healthy : missing, enable: async () => { tailWrites++; ready = true; } }, blackice: { inspect: async () => ({ ready: false, canEnable: false, detail: 'Existing task preserved.' }), enable: async () => appWrites++ } });
  const before = await manager.snapshot(); assert.equal(before.canEnable, true); assert.match(before.actionLabel, /Tailscale/);
  const after = await manager.enable(); assert.equal(after.ready, false); assert.equal(after.checks[0].ok, true); assert.equal(after.checks[1].ok, false); assert.equal(after.canEnable, false); assert.equal(tailWrites, 1); assert.equal(appWrites, 0);
});

test('exact source Electron startup retains app directory, background mode and profile; unsafe paths rejected', () => {
  const source = startupLoginSpec({ executable: 'C:\\work\\electron.exe', profileDir: 'C:\\work\\User Profile', appDir: 'C:\\work\\BLACKICE', packaged: false });
  assert.deepEqual(source.args, ['C:\\work\\BLACKICE', '--background', '--profile-dir', 'C:\\work\\User Profile']);
  assert.notEqual(source.name, spec.name);
  for (const profileDir of ['relative', '\\\\server\\share', 'C:\\bad"quote']) assert.throws(() => startupLoginSpec({ executable: spec.path, profileDir }), { code: 'CONNECTION_STARTUP_PATH' });
});

test('Automatic plus Running is insufficient without affirmative unattended evidence', () => {
  assert.equal(tailscaleStartupState(tailscaleRaw).ready, true);
  for (const unattended of [false, null, undefined, 'true']) assert.equal(tailscaleStartupState({ ...tailscaleRaw, unattended }).ready, false);
  assert.equal(tailscaleStartupState({ ...tailscaleRaw, unattended: false }).canEnable, true);
  assert.equal(tailscaleStartupState({ ...tailscaleRaw, unattended: null, supported: false }).canEnable, false);
  assert.equal(tailscaleStartupState({ ...tailscaleRaw, unattended: false, connected: false }).canEnable, false);
  assert.equal(tailscaleStartupState({ ...tailscaleRaw, serviceAutomatic: false }).ready, false);
  assert.equal(tailscaleStartupState({ ...tailscaleRaw, installed: false }).canEnable, false);
});

test('factory reads fixed scripts and enables only verified missing settings with exact login arguments', async () => {
  let raw = { ...tailscaleRaw, unattended: false }, proof = unregistered, settings = { openAtLogin: false, launchItems: [] }, mutations = 0, loginWrites = 0;
  const manager = createDesktopConnectionStartup({ platform: 'win32', executable: spec.path, profileDir: spec.args.at(-1), loginItem: { inspect: async input => { assert.deepEqual(input, spec); return settings; }, enable: async input => { loginWrites++; assert.deepEqual(input, spec); settings = { ...exactSettings, openAtLogin: false, launchItems: [{ ...exactSettings.launchItems[0], args: [spec.args.at(-1)] }] }; proof = registered; } }, runPowerShell: async (script, options = {}) => {
    if (options.mutation) { mutations++; assert.equal(script, tailscaleStartupRepairScript()); raw.unattended = true; return ''; }
    if (script === loginStartupInspectScript(spec)) return JSON.stringify(proof);
    return script === TAILSCALE_STARTUP_INSPECT ? JSON.stringify(raw) : '{"relatedTask":false}';
  } });
  assert.equal((await manager.snapshot()).ready, false); assert.equal(mutations, 0); assert.equal(loginWrites, 0);
  assert.equal((await manager.enable()).ready, true); assert.equal(mutations, 1); assert.equal(loginWrites, 1);
  await manager.enable(); assert.equal(mutations, 1); assert.equal(loginWrites, 1);
});

test('native helper lifetime remains visible until physical close even after stderr/error and no mutation deadline exists', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let options, args, settled = false;
  const action = runStartupPowerShell(tailscaleStartupRepairScript(), { mutation: true, spawnImpl: (file, argv, opts) => { assert.match(file, /WindowsPowerShell/); args = argv; options = opts; return child; } });
  action.then(() => { settled = true; }, () => { settled = true; }); child.stderr.write('private native output'); child.emit('error', new Error('private')); await waitTurn();
  assert.equal(settled, false); assert.equal(options.shell, false); assert.equal(options.detached, undefined); assert.equal(options.timeout, undefined);
  assert.ok(args.includes('-EncodedCommand')); child.emit('close', 1); await assert.rejects(action, error => error.code === 'CONNECTION_STARTUP_FAILED' && !error.message.includes('private'));
});

test('fixed helper preserves other Tailscale preferences and keeps unattended in the original user context', () => {
  const setup = tailscaleStartupRepairScript();
  assert.match(TAILSCALE_STARTUP_INSPECT, /'get','unattended'/); assert.doesNotMatch(TAILSCALE_STARTUP_INSPECT, /debug prefs/);
  assert.match(setup, /'set','--unattended=true'/); assert.match(setup, /-Verb RunAs -Wait -PassThru/); assert.doesNotMatch(setup, /\bup\s+--|--reset|auth-key|Set-ExecutionPolicy|Register-ScheduledTask/);
  assert.match(TAILSCALE_SERVICE_REPAIR, /Set-Service -Name Tailscale -StartupType Automatic/); assert.doesNotMatch(TAILSCALE_SERVICE_REPAIR, /tailscale\.exe|unattended|Get-ScheduledTask/);
});

test('non-Windows use remains manual and never invokes Windows adapters', async () => {
  const manager = createDesktopConnectionStartup({ platform: 'linux', runPowerShell: async () => { throw new Error('must not run'); } });
  assert.equal((await manager.snapshot()).available, false); await assert.rejects(manager.enable(), { code: 'CONNECTION_STARTUP_UNAVAILABLE' });
});
