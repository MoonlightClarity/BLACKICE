import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { ApplicationSessions, createWindowsApplicationRunner, validateApplicationExecutable, sanitizeApplicationDiagnostics } from '../lib/application-sessions.mjs';

const ownedWindow = (id = '201', pid = 1201) => ({ id, pid, title: 'Private editor', isolated: true, x: 0, y: 0, width: 700, height: 500 });
const launchResult = (window = ownedWindow()) => ({ mode: 'private_desktop', isolated: true, pid: window.pid, windows: [window] });
const tick = () => new Promise(resolve => setImmediate(resolve));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const frame = () => ({ image: { mimeType: 'image/png', data: png, width: 1, height: 1 }, method: 'print_window' });

function harness(t, respond = request => request.action === 'launch' ? launchResult() : request.action === 'windows' ? { windows: [ownedWindow()] } : frame()) {
  const runners = [];
  const sessions = new ApplicationSessions({ platform: 'win32', validateExecutable: async value => value, runnerFactory: () => {
    const runner = async (request, options) => { runner.calls.push({ request, options }); return respond(request, options, runners.indexOf(runner)); };
    runner.calls = []; runner.closes = 0; runner.close = () => { runner.closes++; };
    runners.push(runner); return runner;
  } });
  t.after(() => sessions.closeAll());
  return { sessions, runners };
}

test('private application admission uses one owned helper and literal executable arguments', async t => {
  const { sessions, runners } = harness(t);
  const argv = ['literal & $() ; text', 'C:\\folder with spaces\\', 'quoted "document"'];
  const result = await sessions.create({ executable: 'C:\\Verified\\editor.exe', args: argv, label: 'Editor' });
  assert.equal(result.state, 'running'); assert.match(result.id, /^app_[a-f0-9]{32}$/);
  assert.equal(result.mode, 'private_desktop'); assert.equal(result.requiresForeground, false);
  assert.deepEqual(runners[0].calls[0].request, { action: 'launch', executable: 'C:\\Verified\\editor.exe', args: argv });
  argv[0] = 'changed'; assert.equal(runners[0].calls[0].request.args[0], 'literal & $() ; text');
  const snapshot = sessions.list(); snapshot[0].windows[0].title = 'changed';
  assert.equal(sessions.list()[0].windows[0].title, 'Private editor');
  assert.match(sessions.status().limitations.join(' '), /not files, network access/);
});

test('non-Windows and already-cancelled admissions never spawn helpers', async () => {
  let calls = 0;
  const sessions = new ApplicationSessions({ platform: 'linux', runnerFactory: () => { calls++; } });
  await assert.rejects(sessions.create({ executable: 'C:\\app.exe' }), /unavailable/);
  const windows = new ApplicationSessions({ platform: 'win32', runnerFactory: () => { calls++; } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(windows.create({ executable: 'C:\\app.exe' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('admission validates literal arguments before reserving or invoking a helper', async t => {
  const { sessions, runners } = harness(t);
  for (const args of [['null\0byte'], ['line\nbreak'], Array(33).fill('a'), ['x'.repeat(4097)], [123], 'command text']) await assert.rejects(sessions.create({ executable: 'C:\\app.exe', args }), /arguments/);
  assert.equal(runners.length, 0); assert.equal(sessions.list().length, 0);
});

test('executable admission rejects shells, browser brokers, UNC, aliases, relative paths and scripts before filesystem access', async () => {
  for (const executable of ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Apps\\chrome.exe', 'C:\\Apps\\calc.exe', 'C:\\Program Files\\WindowsApps\\Editor\\editor.exe', '\\\\machine\\app.exe', 'C:\\app.ps1', 'C:\\bad\0.exe', 42]) await assert.rejects(validateApplicationExecutable(executable), /executable|application|supported|catalog/i);
});

test('concurrent admissions reserve bounded capacity before asynchronous validation', async () => {
  let finish;
  let factories = 0;
  const sessions = new ApplicationSessions({ platform: 'win32', maxSessions: 1, validateExecutable: () => new Promise(resolve => { finish = resolve; }), runnerFactory: () => { factories++; const runner = async () => launchResult(); runner.close = () => {}; return runner; } });
  const first = sessions.create({ executable: 'C:\\editor.exe' });
  await assert.rejects(sessions.create({ executable: 'C:\\other.exe' }), /Close an isolated/);
  assert.equal(factories, 0);
  finish('C:\\editor.exe'); const opened = await first;
  await sessions.close(opened.id); await sessions.closeAll();
});

test('closing or cancelling during executable validation never launches late work', async () => {
  for (const cancel of ['close', 'abort']) {
    let finish, factories = 0;
    const sessions = new ApplicationSessions({ platform: 'win32', validateExecutable: () => new Promise(resolve => { finish = resolve; }), runnerFactory: () => { factories++; } });
    const controller = new AbortController();
    const opening = sessions.create({ executable: 'C:\\editor.exe' }, { signal: controller.signal });
    const rejected = assert.rejects(opening, { name: 'AbortError' });
    if (cancel === 'close') await sessions.close(sessions.list()[0].id); else controller.abort();
    finish('C:\\editor.exe'); await rejected;
    assert.equal(factories, 0); assert.equal(sessions.list()[0].state, 'closed');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await sessions.closeAll();
  }
});

test('invalid native launch ownership is terminal and closes only its helper', async t => {
  const { sessions, runners } = harness(t, (_request, _options, index) => index ? { mode: 'private_desktop', isolated: true, pid: 800, windows: [] } : launchResult());
  const first = await sessions.create({ executable: 'C:\\editor.exe' });
  await assert.rejects(sessions.create({ executable: 'C:\\other.exe' }), /owned window/);
  assert.equal(runners[0].closes, 0); assert.equal(runners[1].closes, 1);
  assert.equal(sessions.list().find(item => item.id === first.id).state, 'running');
  assert.equal(sessions.list()[1].state, 'failed');
});

test('physical input, desktop switching and invalid references never reach an owned helper', async t => {
  const { sessions, runners } = harness(t);
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  for (const action of ['focus', 'click', 'type', 'key', 'switch_desktop', 'run', 'launch']) await assert.rejects(sessions.perform({ sessionId: opened.id, action }), /advertised isolated/);
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'invoke', windowId: '201' }), /accessibility ref/);
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'inspect', windowId: '-1' }), /windowId/);
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'set_value', ref: 'uia_123456abcdef_1', value: 'a\0b' }), /Value/);
  assert.equal(runners[0].calls.length, 1); assert.equal(sessions.list()[0].state, 'running');
});

test('semantic controls use bounded requests with no shell, PID or desktop selection', async t => {
  const { sessions, runners } = harness(t, request => request.action === 'launch' ? launchResult() : ({ text: 'done' }));
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  await sessions.perform({ sessionId: opened.id, action: 'set_value', ref: 'uia_123456abcdef_1', value: 'Text λ', desktop: 'Default', processId: 1, script: 'bad', x: 1, y: 2 });
  assert.deepEqual(runners[0].calls[1].request, { action: 'set_value', ref: 'uia_123456abcdef_1', value: 'Text λ' });
});

test('a screenshot is bounded PNG evidence and is never used as input coordinates', async t => {
  const { sessions, runners } = harness(t);
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  assert.deepEqual(await sessions.perform({ sessionId: opened.id, action: 'screenshot', windowId: '201', maxWidth: 9999 }), frame());
  assert.deepEqual(runners[0].calls[1].request, { action: 'screenshot', windowId: '201', maxWidth: 1280, maxHeight: 900 });
});

test('a forged or oversized native frame closes the session and never publishes it', async t => {
  const { sessions, runners } = harness(t, request => request.action === 'launch' ? launchResult() : ({ image: { ...frame().image, width: 1281 } }));
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'screenshot' }), /frame is invalid/);
  assert.equal(sessions.list()[0].state, 'failed'); assert.equal(runners[0].closes, 1);
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'windows' }), /not running/);
});

test('operations serialize per session while independent private applications remain usable', async t => {
  let finish;
  const { sessions, runners } = harness(t, (request, _options, index) => request.action === 'launch' ? launchResult(ownedWindow(String(201 + index), 1201 + index)) : index === 0 && request.action === 'screenshot' ? new Promise(resolve => { finish = resolve; }) : ({ windows: [ownedWindow()] }));
  const first = await sessions.create({ executable: 'C:\\first.exe' }); const second = await sessions.create({ executable: 'C:\\second.exe' });
  const capture = sessions.perform({ sessionId: first.id, action: 'screenshot' }); await tick();
  const queued = sessions.perform({ sessionId: first.id, action: 'windows' });
  await sessions.perform({ sessionId: second.id, action: 'windows' });
  assert.equal(runners[0].calls.length, 2); assert.equal(runners[1].calls.length, 2);
  finish(frame()); await capture; await queued; assert.equal(runners[0].calls.length, 3);
});

test('cancelling a queued action closes its session before it can be admitted', async t => {
  let finish;
  const { sessions, runners } = harness(t, request => request.action === 'launch' ? launchResult() : new Promise(resolve => { finish = resolve; }));
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  const first = sessions.perform({ sessionId: opened.id, action: 'screenshot' }); const firstRejected = assert.rejects(first, { name: 'AbortError' }); await tick();
  const controller = new AbortController();
  const second = sessions.perform({ sessionId: opened.id, action: 'windows' }, { signal: controller.signal }); const secondRejected = assert.rejects(second, { name: 'AbortError' });
  controller.abort(); assert.equal(sessions.list()[0].state, 'closed'); finish(frame());
  await firstRejected; await secondRejected;
  assert.equal(runners[0].calls.length, 2); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an application with no remaining private windows closes its owned session', async t => {
  const { sessions, runners } = harness(t, request => request.action === 'launch' ? launchResult() : ({ windows: [] }));
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  assert.deepEqual(await sessions.perform({ sessionId: opened.id, action: 'windows' }), { windows: [] });
  assert.equal(sessions.list()[0].state, 'closed'); assert.equal(runners[0].closes, 1);
});

function transport(t, respond) {
  const children = [], spawns = [];
  const runner = createWindowsApplicationRunner({ spawnImpl(command, args, options) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0; child.requests = [];
    child.stdin = new Writable({ write(chunk, _encoding, callback) { const request = JSON.parse(chunk.toString()); child.requests.push(request); callback(); respond?.(child, request); } });
    child.kill = () => { child.kills++; return true; };
    child.reply = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    children.push(child); spawns.push({ command, args, options }); return child;
  } });
  t.after(() => runner.close()); return { runner, children, spawns };
}

test('native transport has a hidden non-shell process and correlates every response', async t => {
  const { runner, children, spawns } = transport(t, (child, request) => child.reply({ ok: true, requestId: request.requestId, text: 'Unicode λ' }));
  assert.deepEqual(await runner({ action: 'windows' }), { text: 'Unicode λ' });
  assert.deepEqual(await runner({ action: 'windows' }), { text: 'Unicode λ' });
  assert.equal(children.length, 1); assert.deepEqual(children[0].requests.map(item => item.requestId), [1, 2]);
  assert.equal(spawns[0].command, 'powershell.exe'); assert.equal(spawns[0].options.windowsHide, true); assert.equal(spawns[0].options.shell, false);
  assert.ok(spawns[0].args.includes('-NonInteractive') && spawns[0].args.includes('-Mta'));
  assert.deepEqual(spawns[0].args.slice(spawns[0].args.indexOf('-WindowStyle'), spawns[0].args.indexOf('-WindowStyle') + 2), ['-WindowStyle', 'Hidden']);
  assert.deepEqual(spawns[0].args.slice(spawns[0].args.indexOf('-ParentProcessId'), spawns[0].args.indexOf('-ParentProcessId') + 2), ['-ParentProcessId', String(process.pid)]);
});

test('native capture deadline destroys only its helper and cannot transparently restart', async t => {
  const { runner, children } = transport(t);
  await assert.rejects(runner({ action: 'screenshot' }, { timeoutMs: 10 }), /timed out.*no foreground fallback/);
  assert.equal(children[0].kills, 1); assert.equal(children[0].stdin.writableEnded, true);
  await assert.rejects(runner({ action: 'windows' }), { name: 'AbortError' }); assert.equal(children.length, 1);
  runner.close(); assert.equal(children[0].kills, 1);
});

test('idle native helper loss immediately marks the application session unavailable', async t => {
  const wire = transport(t, (child, request) => child.reply({ ok: true, requestId: request.requestId, ...launchResult() }));
  const sessions = new ApplicationSessions({ platform: 'win32', validateExecutable: async value => value, runnerFactory: () => wire.runner });
  t.after(() => sessions.closeAll());
  const opened = await sessions.create({ executable: 'C:\\editor.exe' });
  const events = []; sessions.on('status', value => events.push(value));
  wire.children[0].emit('close', 17);
  const session = sessions.list().find(item => item.id === opened.id);
  assert.equal(session.state, 'failed'); assert.deepEqual(session.windows, []); assert.equal(session.busy, false);
  assert.match(session.lastError, /helper stopped \(17\)/); assert.equal(events.at(-1).sessions[0].state, 'failed');
  await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'windows' }), /not running/);
});

test('list reconciles a custom runner that closed without an event callback', async () => {
  let closed = false;
  const runner = async () => launchResult(); runner.isClosed = () => closed; runner.close = () => { closed = true; };
  const sessions = new ApplicationSessions({ platform: 'win32', validateExecutable: async value => value, runnerFactory: () => runner });
  await sessions.create({ executable: 'C:\\editor.exe' }); closed = true;
  assert.equal(sessions.list()[0].state, 'failed'); assert.deepEqual(sessions.list()[0].windows, []);
  assert.match(sessions.status().sessions[0].lastError, /helper stopped/); await sessions.closeAll();
});

for (const kind of ['cancel', 'wrong_id', 'malformed', 'oversized', 'lost_pipe']) test(`native helper ${kind} closes the private job boundary without a replacement`, async t => {
  const { runner, children } = transport(t); const controller = new AbortController();
  const request = runner({ action: 'screenshot' }, { signal: controller.signal }); const rejected = assert.rejects(request);
  if (kind === 'cancel') controller.abort();
  else if (kind === 'wrong_id') children[0].reply({ ok: true, requestId: 999 });
  else if (kind === 'malformed') children[0].stdout.write('invalid JSON\n');
  else if (kind === 'oversized') children[0].stdout.write('a'.repeat(12 * 1024 * 1024 + 1));
  else children[0].emit('close', 1);
  await rejected; assert.equal(children[0].kills, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(runner({ action: 'windows' }), { name: 'AbortError' }); assert.equal(children.length, 1);
});

test('native source limits every window and UIA action to owned inactive desktop processes', async () => {
  const source = await readFile(new URL('../lib/windows-application-session.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:SwitchDesktop|SetForegroundWindow|SetActiveWindow|SetFocus|SendInput|SendKeys|CopyFromScreen|ShellExecute|SetCursorPos)\s*\(/);
  assert.match(source, /CreateDesktopW\(name,IntPtr.Zero,IntPtr.Zero,0,0x00c7/);
  assert.match(source, /DesktopInput\(desktop,6,out input,4/); assert.match(source, /if\(input!=0\) throw/);
  assert.ok(source.indexOf('[BlackiceApplicationSession]::Initialize()') < source.indexOf('Add-Type -AssemblyName UIAutomationClient'));
  assert.ok(source.indexOf('AssignProcessToJobObject(job,process.hProcess)') < source.indexOf('ResumeThread(process.hThread)'));
  assert.match(source, /LimitFlags=0x2000/); assert.match(source, /startup.lpDesktop="WinSta0\\\\"\+name/);
  assert.match(source, /WatchParent\(\$ParentProcessId\)/); assert.match(source, /WaitForSingleObject\(parent,0xffffffff\)/); assert.match(source, /Environment.Exit\(0\)/);
  assert.match(source, /EnumDesktopWindows\(desktop/); assert.match(source, /IsProcessInJob\(process,job,out member\)/);
  assert.match(source, /function Resolve-ApplicationRef[\s\S]*RequireWindow[\s\S]*OwnsProcess/);
  assert.match(source, /PrintWindow\(new IntPtr\(Int64.Parse\(id\)\),dc,2\)/);
  assert.match(source, /finally \{ if \('BlackiceApplicationSession'/);
  assert.ok(source.indexOf('Name(GetProcessWindowStation())') < source.indexOf('desktop=CreateDesktopW('));
  assert.match(source, /diagnostic.windowStation!="WinSta0"/); assert.match(source, /Marshal.WriteInt32\(block,0xde\)/);
  assert.match(source, /observedProcessLimit=64/); assert.match(source, /QueryInformationJobObject\(job,3/); assert.match(source, /QueryInformationJobObject\(job,1/);
  assert.ok(source.indexOf('diagnostic.ownedWindows++;') < source.indexOf('if(!IsWindowVisible(hwnd))'));
  assert.match(source, /lifetime.ElapsedMilliseconds\+1500/); assert.match(source, /foreach\(var item in observed.Values\) if\(!item.launcher\) CloseHandle\(item.handle\)/);
  assert.match(source, /failure.diagnostics=\[BlackiceApplicationSession\]::Diagnostics\(\)/);
});

const launchDiagnostics = () => ({ version: 1, rootPid: 1201, windowStation: 'WinSta0', phase: 'waiting-for-window', observedProcessLimit: 64, jobTotalProcesses: 2, jobActiveProcesses: 0, jobTerminatedProcesses: 2, unobservedProcessCount: 0, privateWindows: 2, ownedWindows: 1, visibleOwnedWindows: 0, hiddenOwnedWindows: 1, unownedWindows: 1, ownershipQueryFailures: 0, windowGeometryFailures: 0, isolationVerified: true, processListTruncated: false, windowsTruncated: false, closed: true, terminationAttempted: true, terminationSucceeded: true, allObservedProcessesExited: true, processes: [
  { pid: 1201, role: 'launcher', state: 'exited', firstSeenMs: 0, lastObservedMs: 15000, exitCode: 0 },
  { pid: 1202, role: 'descendant', state: 'exited', firstSeenMs: 100, lastObservedMs: 15000, exitCode: 0xc0000142 }
] });

test('native diagnostics retain only bounded owned-lifetime evidence and cannot leak arbitrary process or window details', () => {
  const original = launchDiagnostics(); original.executable = 'C:\\private-user\\program.exe'; original.windowTitles = ['A private document']; original.processes[0].name = 'private-process'; original.processes[0].path = 'C:\\private-user\\program.exe';
  const sanitized = sanitizeApplicationDiagnostics(original);
  assert.equal(sanitized.processes.length, 2); assert.equal(sanitized.processes[1].exitCode, 0xc0000142); assert.equal(sanitized.allObservedProcessesExited, true);
  assert.doesNotMatch(JSON.stringify(sanitized), /private-user|private-process|private document|executable|windowTitles/);
  sanitized.processes[0].pid = 99; assert.equal(original.processes[0].pid, 1201);
  const oversized = { ...original, processes: Array.from({ length: 65 }, (_, index) => ({ pid: 2000 + index, role: 'descendant', state: 'exited', exitCode: 0 })) };
  const capped = sanitizeApplicationDiagnostics(oversized); assert.equal(capped.processes.length, 64); assert.equal(capped.processListTruncated, true); assert.equal(capped.allObservedProcessesExited, false);
  const invalid = sanitizeApplicationDiagnostics({ ...original, windowStation: 'Personal station name', jobActiveProcesses: '0', processes: [{ pid: '1202', role: 'descendant', state: 'exited', exitCode: 0 }, { pid: 1201, role: 'launcher', state: 'running', exitCode: 0 }] });
  assert.equal(invalid.windowStation, 'unknown'); assert.equal(invalid.jobActiveProcesses, undefined); assert.equal(invalid.processes.length, 1); assert.equal(invalid.processes[0].exitCode, null); assert.equal(invalid.allObservedProcessesExited, false);
  for (const value of [null, [], {}, { version: 2 }]) assert.equal(sanitizeApplicationDiagnostics(value), null);
});

test('a native startup error reaches the caller and terminal session with sanitized descendant exit evidence', async t => {
  const diagnostics = launchDiagnostics(); diagnostics.processes[0].name = 'Do not expose process names';
  const wire = transport(t, (child, request) => child.reply({ ok: false, requestId: request.requestId, error: 'No owned visible window was created. The launcher exited with code 0.', diagnostics }));
  const sessions = new ApplicationSessions({ platform: 'win32', validateExecutable: async value => value, runnerFactory: () => wire.runner }); t.after(() => sessions.closeAll());
  let failure;
  await assert.rejects(sessions.create({ executable: 'C:\\Verified\\launcher.exe' }), cause => { failure = cause; return /launcher exited with code 0/.test(cause.message); });
  assert.deepEqual(failure.diagnostics.processes.map(item => [item.pid, item.role, item.state, item.exitCode]), [[1201, 'launcher', 'exited', 0], [1202, 'descendant', 'exited', 0xc0000142]]);
  assert.equal(failure.diagnostics.hiddenOwnedWindows, 1); assert.equal(failure.diagnostics.allObservedProcessesExited, true);
  const terminal = sessions.list()[0]; assert.equal(terminal.state, 'failed'); assert.equal(terminal.busy, false); assert.deepEqual(terminal.windows, []); assert.deepEqual(terminal.diagnostics, failure.diagnostics);
  assert.equal(wire.children[0].kills, 1); assert.doesNotMatch(JSON.stringify(terminal.diagnostics), /Do not expose/);
  terminal.diagnostics.processes[0].pid = 99; failure.diagnostics.processes[0].pid = 98; assert.equal(sessions.list()[0].diagnostics.processes[0].pid, 1201);
  await assert.rejects(sessions.perform({ sessionId: terminal.id, action: 'windows' }), /not running/);
});

test('later native operation failures retain honest incomplete-cleanup diagnostics without claiming every observed process exited', async t => {
  const diagnostics = launchDiagnostics(); diagnostics.processes[1].state = 'running'; diagnostics.processes[1].exitCode = null; diagnostics.allObservedProcessesExited = false; diagnostics.jobActiveProcesses = 1;
  const { sessions, runners } = harness(t, request => { if (request.action === 'launch') return launchResult(); throw Object.assign(Error('The application became unresponsive.'), { diagnostics }); });
  const opened = await sessions.create({ executable: 'C:\\editor.exe' }); await assert.rejects(sessions.perform({ sessionId: opened.id, action: 'windows' }), /unresponsive/);
  const failed = sessions.list()[0]; assert.equal(failed.state, 'failed'); assert.equal(failed.diagnostics.allObservedProcessesExited, false); assert.equal(failed.diagnostics.jobActiveProcesses, 1); assert.equal(failed.diagnostics.processes[1].state, 'running'); assert.equal(runners[0].closes, 1);
});
