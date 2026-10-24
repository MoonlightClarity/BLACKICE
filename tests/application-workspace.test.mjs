import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApplicationWorkspace, applicationCatalog } from '../lib/application-workspace.mjs';

const catalog = [{ appId: 'notepad-classic', name: 'Notepad', available: true, executable: 'C:\\Windows\\System32\\notepad.exe', args: [] }];
const window = { id: '301', pid: 2001, title: 'Private Notepad', isolated: true };
const editor = { ref: 'uia_123456abcdef_1', controlType: 'Edit', enabled: true, actions: ['get_text', 'set_value'], name: 'Text editor', value: 'Initial text' };

class FakeRuntime {
  constructor() { this.records = []; this.creates = []; this.operations = []; this.ends = []; this.closes = 0; this.onCreate = null; this.onPerform = null; }
  list() { return structuredClone(this.records); }
  async create(value, options) {
    this.creates.push({ value: structuredClone(value), options }); await this.onCreate?.(value, options);
    const record = { id: `private_${this.creates.length}`, state: 'running', isolated: true, windows: [window] }; this.records.push(record); return structuredClone(record);
  }
  async perform(value, options) {
    this.operations.push({ value: structuredClone(value), options });
    const supplied = await this.onPerform?.(value, options); if (supplied) return supplied;
    if (value.action === 'windows') return { windows: [window] };
    if (value.action === 'inspect') return { elements: [editor, { ...editor, ref: 'uia_123456abcdef_2', controlType: 'Button', actions: ['invoke'], name: 'Help' }, { ...editor, ref: 'uia_123456abcdef_3', password: true, name: 'Secret' }] };
    return { text: value.action === 'get_text' ? 'Current text' : 'Completed' };
  }
  async close(id) { this.ends.push(id); const record = this.records.find(item => item.id === id); if (record) { record.state = 'closed'; record.windows = []; } }
  async closeAll() { this.closes++; for (const record of this.records) { record.state = 'closed'; record.windows = []; } }
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-application-workspace-'));
  const runtime = options.runtime || new FakeRuntime();
  const workspace = new ApplicationWorkspace({ dataDir, runtime, platform: 'win32', catalog, ...options });
  await workspace.init();
  t.after(async () => {
    await workspace.close().catch(() => {});
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { workspace, runtime, dataDir, file: path.join(dataDir, 'application-sessions.json') };
}

test('workspace saves a launch intent before admitting a verified application and hides executable paths', async t => {
  const { workspace, runtime, file } = await fixture(t);
  runtime.onCreate = async () => { const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.sessions.length, 1); assert.equal(saved.sessions[0].state, 'starting'); };
  const opened = await workspace.create({ appId: 'notepad-classic', name: 'Writing notes' });
  assert.match(opened.id, /^app_[a-f0-9-]{36}$/); assert.equal(opened.state, 'running'); assert.equal(opened.isolated, true);
  assert.deepEqual(runtime.creates[0].value, { executable: catalog[0].executable, args: [], label: 'Writing notes' });
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.sessions[0].state, 'running'); assert.equal(saved.sessions[0].id, opened.id);
  assert.ok(!Object.hasOwn(saved.sessions[0], 'windows')); assert.ok(!JSON.stringify(workspace.status()).includes('C:\\\\Windows'));
  assert.equal(workspace.status().supportedApps[0].executable, undefined); assert.equal(workspace.status().supportedApps[0].args, undefined);
});

test('failed launch persists a terminal receipt and never retries the application implicitly', async t => {
  const { workspace, runtime, file } = await fixture(t);
  runtime.onCreate = async () => { assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[0].state, 'starting'); throw new Error('Existing application process is already running.'); };
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), /already running/);
  assert.equal(runtime.creates.length, 1); assert.equal(workspace.status().sessions[0].state, 'failed');
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.sessions[0].state, 'failed'); assert.match(saved.sessions[0].reason, /already running/);
  await assert.rejects(workspace.perform({ sessionId: saved.sessions[0].id, action: 'inspect' }), /already running/);
  assert.equal(runtime.creates.length, 1);
});

test('restoring running or starting history marks it interrupted without relaunching or attaching old process IDs', async t => {
  const { workspace, runtime, dataDir, file } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' });
  const replacement = new FakeRuntime();
  const restored = new ApplicationWorkspace({ dataDir, runtime: replacement, platform: 'win32', catalog }); await restored.init();
  assert.equal(restored.status().sessions[0].id, opened.id); assert.equal(restored.status().sessions[0].state, 'interrupted');
  assert.match(restored.status().sessions[0].reason, /not relaunched/); assert.equal(replacement.creates.length, 0); assert.equal(replacement.operations.length, 0);
  await assert.rejects(restored.perform({ sessionId: opened.id, action: 'screenshot' }), /not relaunched/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[0].state, 'interrupted'); assert.equal(runtime.creates.length, 1);
  await restored.close();
});

test('closing workspace ends only its owned runtime and persisted sessions remain interrupted on restart', async t => {
  const { workspace, runtime, dataDir, file } = await fixture(t);
  await workspace.create({ appId: 'notepad-classic' }); await workspace.close(); await workspace.close();
  assert.equal(runtime.closes, 1); assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[0].state, 'interrupted'); assert.match(JSON.parse(await readFile(file, 'utf8')).sessions[0].reason, /requested application cleanup/);
  const replacement = new FakeRuntime(); const restored = new ApplicationWorkspace({ dataDir, runtime: replacement, platform: 'win32', catalog }); await restored.init();
  assert.equal(restored.status().sessions[0].state, 'interrupted'); assert.equal(replacement.creates.length, 0);
  await restored.close();
});

test('unknown fields, raw executable paths, custom arguments and unavailable app IDs are rejected before launch', async t => {
  const { workspace, runtime } = await fixture(t);
  for (const value of [{ appId: 'notepad-classic', executable: 'C:\\app.exe' }, { appId: 'notepad-classic', args: [] }, { appId: 'notepad-classic', desktop: 'Default' }, { appId: 'unknown' }, { appId: 'notepad-classic', name: '' }, null, []]) await assert.rejects(workspace.create(value), /catalog|available|Session name|nonempty/);
  assert.equal(runtime.creates.length, 0); assert.equal(workspace.status().sessions.length, 0);
});

test('controls require fresh observed editor refs and never admit help/browser invokes', async t => {
  const { workspace, runtime } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' });
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'control', operation: 'set_value', ref: editor.ref, text: 'new' }), /Inspect this private session/);
  const inspection = await workspace.perform({ sessionId: opened.id, action: 'inspect' });
  assert.equal(inspection.controls[0].writable, true); assert.equal(inspection.controls[1].invokable, false); assert.equal(inspection.controls[2].writable, false); assert.equal(inspection.controls[2].readable, false); assert.equal(inspection.controls[2].value, undefined);
  assert.equal(inspection.elements, undefined); assert.equal(inspection.text, 'Initial text');
  await workspace.perform({ sessionId: opened.id, action: 'control', operation: 'set_value', ref: editor.ref, text: 'new' });
  assert.deepEqual(runtime.operations.at(-1).value, { sessionId: 'private_1', action: 'set_value', ref: editor.ref, value: 'new' });
  const count = runtime.operations.length;
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'control', operation: 'invoke', ref: 'uia_123456abcdef_2' }), /not admitted/);
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'control', operation: 'set_value', ref: 'uia_123456abcdef_3', text: 'secret' }), /not admitted/);
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'run', code: 'bad' }), /supported application/);
  assert.equal(runtime.operations.length, count);
});

test('get_text without a ref requires one previously observed editor and uses that exact current ref', async t => {
  const { workspace, runtime } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' });
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'get_text' }), /Inspect first.*exactly one observed editor/);
  assert.equal(runtime.operations.length, 0); assert.equal(workspace.status().sessions[0].state, 'running');
  await workspace.perform({ sessionId: opened.id, action: 'inspect' });
  const request = Object.freeze({ sessionId: opened.id, action: 'get_text' });
  const result = await workspace.perform(request);
  assert.equal(result.text, 'Current text');
  assert.deepEqual(runtime.operations.at(-1).value, { sessionId: 'private_1', action: 'get_text', ref: editor.ref, maxCharacters: 12000 });
  assert.deepEqual(request, { sessionId: opened.id, action: 'get_text' }, 'automatic disambiguation does not mutate the original tool request');
  const count = runtime.operations.length;
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'get_text', ref: 'uia_123456abcdef_99' }), /not admitted/);
  assert.equal(runtime.operations.length, count); assert.equal(workspace.status().sessions[0].state, 'running');
});

test('get_text never guesses between multiple observed editable controls', async t => {
  const { workspace, runtime } = await fixture(t);
  runtime.onPerform = async value => value.action === 'inspect' ? { elements: [editor, { ...editor, ref: 'uia_123456abcdef_7', name: 'Second editor', value: 'Other text' }] } : undefined;
  const opened = await workspace.create({ appId: 'notepad-classic' }); await workspace.perform({ sessionId: opened.id, action: 'inspect' });
  const count = runtime.operations.length;
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'get_text' }), /exactly one observed editor/);
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'get_text', ref: 'uia_123456abcdef_99' }), /not admitted/);
  assert.equal(runtime.operations.length, count);
  await workspace.perform({ sessionId: opened.id, action: 'get_text', ref: 'uia_123456abcdef_7' });
  assert.deepEqual(runtime.operations.at(-1).value, { sessionId: 'private_1', action: 'get_text', ref: 'uia_123456abcdef_7', maxCharacters: 12000 });
});

test('inspect and screenshot reject accessibility-ref targets before native admission without ending the session', async t => {
  const { workspace, runtime } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' });
  for (const action of ['inspect', 'screenshot']) {
    await assert.rejects(workspace.perform({ sessionId: opened.id, action, ref: editor.ref }), /observed fields advertised/);
    await assert.rejects(workspace.perform({ sessionId: opened.id, action, ref: editor.ref, windowId: window.id }), /observed fields advertised/);
  }
  assert.equal(runtime.operations.length, 0); assert.equal(runtime.ends.length, 0); assert.equal(workspace.status().sessions[0].state, 'running');
  await workspace.perform({ sessionId: opened.id, action: 'inspect' });
  assert.equal(runtime.operations.length, 2); assert.equal(workspace.status().sessions[0].state, 'running');
});

test('idle native helper failure reaches workspace status and cannot silently restart', async t => {
  const { workspace, runtime } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' });
  runtime.records[0].state = 'failed'; runtime.records[0].lastError = 'Private desktop capture timed out.'; runtime.records[0].windows = [];
  const state = workspace.status().sessions[0]; assert.equal(state.state, 'failed'); assert.equal(state.controlsAvailable, false); assert.deepEqual(state.windows, []);
  assert.match(state.reason, /capture timed out/);
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'inspect' }), /capture timed out/); assert.equal(runtime.creates.length, 1);
});

test('unreadable session history is preserved byte for byte even during shutdown', async t => {
  const { workspace, runtime, dataDir, file } = await fixture(t); await workspace.close();
  const bad = '{invalid history exactly\n'; await writeFile(file, bad);
  const restored = new ApplicationWorkspace({ dataDir, runtime: new FakeRuntime(), platform: 'win32', catalog }); await restored.init();
  assert.equal(restored.status().available, false); assert.match(restored.status().reason, /preserved/);
  await assert.rejects(restored.create({ appId: 'notepad-classic' }), /preserved/);
  assert.equal(await readFile(file, 'utf8'), bad); await restored.close(); assert.equal(await readFile(file, 'utf8'), bad); assert.equal(runtime.creates.length, 0);
});

test('storage failure before admission never invokes runtime and blocks another launch', async t => {
  const { workspace, runtime } = await fixture(t);
  workspace.save = async () => { throw new Error('disk is full'); };
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), error => error.code === 'APPLICATION_HISTORY_FAILED');
  assert.equal(runtime.creates.length, 0); assert.equal(workspace.status().available, false);
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), /do not repeat a launch/); assert.equal(runtime.creates.length, 0);
});

test('storage failure after admission retains the original running result and rejects duplicate launches', async t => {
  const { workspace, runtime, file } = await fixture(t);
  const originalSave = workspace.save.bind(workspace); let saves = 0;
  workspace.save = async () => { if (++saves === 2) throw new Error('disk is full'); return originalSave(); };
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), error => error.code === 'APPLICATION_HISTORY_FAILED');
  const original = workspace.status().sessions[0]; assert.equal(original.state, 'running'); assert.equal(original.isolated, true); assert.equal(runtime.creates.length, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[0].state, 'starting');
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), /do not repeat a launch/); assert.equal(runtime.creates.length, 1);
  await workspace.perform({ sessionId: original.id, action: 'inspect' }); assert.equal(runtime.creates.length, 1);
  await workspace.end(original.id); assert.deepEqual(runtime.ends, ['private_1']); assert.equal(workspace.status().sessions[0].state, 'closed');
});

test('storage failure after an editor mutation retains completed action receipt and never replays it', async t => {
  const { workspace, runtime } = await fixture(t);
  const opened = await workspace.create({ appId: 'notepad-classic' }); await workspace.perform({ sessionId: opened.id, action: 'inspect' });
  const originalSave = workspace.save.bind(workspace); workspace.save = async () => { throw new Error('disk full'); };
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'control', operation: 'set_value', ref: editor.ref, text: 'Saved once in the app' }), error => error.code === 'APPLICATION_HISTORY_FAILED');
  assert.equal(workspace.status().sessions[0].lastAction.status, 'completed'); assert.equal(runtime.operations.filter(item => item.value.action === 'set_value').length, 1);
  workspace.save = originalSave; await workspace.perform({ sessionId: opened.id, action: 'get_text', ref: editor.ref });
  assert.equal(runtime.operations.filter(item => item.value.action === 'set_value').length, 1); assert.equal(runtime.creates.length, 1);
});

test('compatibility catalog admits classic Notepad only on supported Windows builds and reports packaged versions unavailable', async () => {
  const options = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, stat: async () => ({ isFile: () => true }) };
  assert.equal((await applicationCatalog({ ...options, release: '10.0.19045' }))[0].available, true);
  assert.equal((await applicationCatalog({ ...options, release: '10.0.22631' }))[0].available, false);
  assert.deepEqual(await applicationCatalog({ ...options, platform: 'linux' }), []);
});


const nativeDiagnostics = (extra = {}) => ({
  version: 1, windowStation: 'WinSta0', phase: 'waiting-for-window', rootPid: 8101,
  jobTotalProcesses: 2, jobActiveProcesses: 0, jobTerminatedProcesses: 0, unobservedProcessCount: 0,
  privateWindows: 0, ownedWindows: 0, visibleOwnedWindows: 0, hiddenOwnedWindows: 0,
  closed: true, terminationAttempted: true, terminationSucceeded: true, allObservedProcessesExited: true,
  diagnosticsIncomplete: false, processListTruncated: false, windowsTruncated: false,
  processes: [
    { pid: 8101, role: 'launcher', state: 'exited', firstSeenMs: 0, lastObservedMs: 15000, exitCode: 0 },
    { pid: 8102, role: 'descendant', state: 'exited', firstSeenMs: 20, lastObservedMs: 15000, exitCode: 81 },
  ], ...extra,
});

test('failed startup diagnostics are sanitized, durably retained and readable after restart without another launch', async t => {
  const { workspace, runtime, dataDir, file } = await fixture(t);
  const diagnostics = nativeDiagnostics({ executable: 'C:\\fixture-private\\app.exe', windowTitle: 'PRIVATE WINDOW TITLE', unknownNativeObject: { secret: 'PRIVATE NATIVE VALUE' } });
  diagnostics.processes[1].name = 'PRIVATE PROCESS NAME'; diagnostics.processes[1].commandLine = 'PRIVATE COMMAND LINE';
  runtime.onCreate = async () => { throw Object.assign(new Error('No owned application window appeared.'), { diagnostics }); };
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), /No owned application window/);
  const receipt = workspace.status().sessions[0]; assert.equal(receipt.state, 'failed'); assert.equal(receipt.isolated, false);
  assert.equal(receipt.diagnostics.jobTotalProcesses, 2); assert.equal(receipt.diagnostics.jobActiveProcesses, 0); assert.equal(receipt.diagnostics.allObservedProcessesExited, true);
  assert.deepEqual(receipt.diagnostics.processes.map(item => [item.pid, item.state, item.exitCode]), [[8101, 'exited', 0], [8102, 'exited', 81]]);
  const raw = await readFile(file, 'utf8'), saved = JSON.parse(raw).sessions[0]; assert.deepEqual(saved.diagnostics, receipt.diagnostics);
  assert.doesNotMatch(raw, /fixture-private|PRIVATE WINDOW|PRIVATE NATIVE|PRIVATE PROCESS|PRIVATE COMMAND/);
  receipt.diagnostics.processes[0].exitCode = 900; diagnostics.processes[1].exitCode = 900;
  assert.deepEqual(workspace.status().sessions[0].diagnostics.processes.map(item => item.exitCode), [0, 81]);
  await workspace.close(); const replacement = new FakeRuntime();
  const restored = await new ApplicationWorkspace({ dataDir, runtime: replacement, platform: 'win32', catalog }).init();
  try {
    assert.deepEqual(restored.status().sessions[0].diagnostics, saved.diagnostics); assert.equal(restored.status().sessions[0].state, 'failed');
    await assert.rejects(restored.perform({ sessionId: saved.id, action: 'inspect' }), /No owned application window/);
    assert.equal(replacement.creates.length, 0); assert.equal(replacement.operations.length, 0); assert.equal(runtime.creates.length, 1);
  } finally { await restored.close(); }
});

test('a later native failure persists sanitized diagnostics and cannot turn a running descendant into confirmed cleanup', async t => {
  const { workspace, runtime, file } = await fixture(t), opened = await workspace.create({ appId: 'notepad-classic' });
  const diagnostics = nativeDiagnostics({ jobActiveProcesses: 1, terminationSucceeded: false, terminationError: 5, allObservedProcessesExited: true });
  Object.assign(diagnostics.processes[1], { state: 'running', exitCode: 81, imagePath: 'PRIVATE DESCENDANT PATH' });
  runtime.onPerform = async () => {
    Object.assign(runtime.records[0], { state: 'failed', lastError: 'Private capture failed during cleanup.', windows: [], diagnostics });
    throw Object.assign(new Error('Private capture failed during cleanup.'), { diagnostics });
  };
  await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'screenshot' }), /Private capture failed/);
  const receipt = workspace.status().sessions[0], saved = JSON.parse(await readFile(file, 'utf8')).sessions[0];
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.controlsAvailable, false); assert.equal(receipt.lastAction.status, 'failed');
  assert.deepEqual(saved.diagnostics, receipt.diagnostics); assert.equal(receipt.diagnostics.allObservedProcessesExited, false);
  assert.equal(receipt.diagnostics.processes[1].state, 'running'); assert.equal(receipt.diagnostics.processes[1].exitCode, null); assert.equal(receipt.diagnostics.terminationError, 5);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE DESCENDANT/);
  const operations = runtime.operations.length; await assert.rejects(workspace.perform({ sessionId: opened.id, action: 'screenshot' }), /Private capture failed/);
  assert.equal(runtime.operations.length, operations); assert.equal(runtime.creates.length, 1);
});

test('compatibility observations never expand the available application catalog or bypass a current admission rejection', async t => {
  const { workspace, runtime } = await fixture(t);
  const first = workspace.status(), observedIds = first.compatibility.apps.map(app => app.id);
  assert.ok(observedIds.includes('libreoffice-writer')); assert.ok(observedIds.includes('blender'));
  assert.deepEqual(first.supportedApps.map(app => app.appId), ['notepad-classic']);
  for (const appId of observedIds.filter(id => id !== 'notepad-classic')) await assert.rejects(workspace.create({ appId }), { status: 409 });
  first.compatibility.apps.find(app => app.id === 'libreoffice-writer').result = 'verified'; first.supportedApps[0].available = false;
  assert.equal(workspace.status().compatibility.apps.find(app => app.id === 'libreoffice-writer').result, 'blocked'); assert.equal(workspace.status().supportedApps[0].available, true);
  assert.equal(runtime.creates.length, 0); assert.equal(workspace.status().sessions.length, 0);
  const unavailable = await fixture(t, { catalog: [{ ...catalog[0], available: false, reason: 'Unavailable in this installation.' }] });
  assert.equal(unavailable.workspace.status().compatibility.apps.find(app => app.id === 'notepad-classic').result, 'verified');
  await assert.rejects(unavailable.workspace.create({ appId: 'notepad-classic' }), { status: 409 }); assert.equal(unavailable.runtime.creates.length, 0);
});

test('ending a failed unbound session retains incomplete cleanup evidence and never claims an additional process stop', async t => {
  const { workspace, runtime, file } = await fixture(t);
  const diagnostics = nativeDiagnostics({ jobActiveProcesses: 1, terminationSucceeded: false, terminationError: 5, allObservedProcessesExited: false });
  Object.assign(diagnostics.processes[1], { state: 'running', exitCode: null });
  runtime.onCreate = async () => { throw Object.assign(new Error('No owned window; cleanup did not finish.'), { diagnostics }); };
  await assert.rejects(workspace.create({ appId: 'notepad-classic' }), /cleanup did not finish/);
  const failed = workspace.status().sessions[0], ended = await workspace.end(failed.id);
  assert.equal(ended.state, 'closed'); assert.deepEqual(ended.diagnostics, failed.diagnostics); assert.equal(ended.diagnostics.jobActiveProcesses, 1);
  assert.match(ended.reason, /No additional application cleanup was performed/); assert.doesNotMatch(ended.reason, /processes (?:were stopped|exited)/);
  assert.deepEqual(runtime.ends, []); assert.equal(runtime.creates.length, 1); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sessions[0].diagnostics, failed.diagnostics);
});

test('ending an owned session retains its returned cleanup receipt and distinguishes observed exit from a cleanup request', async t => {
  const { workspace, runtime, file } = await fixture(t), opened = await workspace.create({ appId: 'notepad-classic' });
  const close = runtime.close.bind(runtime);
  runtime.close = async id => { await close(id); const record = runtime.records.find(item => item.id === id); record.diagnostics = nativeDiagnostics({ extraPrivateValue: 'PRIVATE CLOSE VALUE' }); return structuredClone(record); };
  const ended = await workspace.end(opened.id); assert.deepEqual(runtime.ends, ['private_1']);
  assert.equal(ended.diagnostics.closed, true); assert.equal(ended.diagnostics.jobActiveProcesses, 0); assert.equal(ended.diagnostics.allObservedProcessesExited, true);
  assert.match(ended.reason, /All observed application processes exited/); assert.doesNotMatch(JSON.stringify(ended), /PRIVATE CLOSE VALUE/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sessions[0].diagnostics, ended.diagnostics);
  const second = await workspace.create({ appId: 'notepad-classic' });
  runtime.close = async id => { await close(id); return { ...runtime.records.find(item => item.id === id), diagnostics: nativeDiagnostics({ diagnosticsIncomplete: true }) }; };
  const incomplete = await workspace.end(second.id); assert.match(incomplete.reason, /cleanup was requested/); assert.doesNotMatch(incomplete.reason, /All observed application processes exited/);
});
