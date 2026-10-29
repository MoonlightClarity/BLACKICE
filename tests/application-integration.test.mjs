import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {ApplicationWorkspace} from '../lib/application-workspace.mjs';
import {APPLICATION_TOOL} from '../lib/application-tools.mjs';

const EDITOR = 'uia_abcdef123456_1';
const HELP = 'uia_abcdef123456_2';
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=';
const catalog = [{appId: 'notepad-classic', name: 'Notepad', available: true, executable: 'C:\\Windows\\System32\\notepad.exe', args: []}];
const graph = {
  id: 'application-integration', name: 'Contained app integration',
  nodes: [{id: 'input', type: 'input'}, {id: 'agent', type: 'agent', name: 'App worker', model: 'application-fixture', prompt: 'Use the attached private application workspace.'}, {id: 'output', type: 'output'}],
  edges: [{source: 'input', target: 'agent'}, {source: 'agent', target: 'output'}], settings: {maxParallel: 1, planningMode: 'off'},
};

// This fixture implements the private runtime protocol in memory. No Windows
// helper, GUI process, browser, or physical desktop operation is started.
class PrivateRuntime extends EventEmitter {
  constructor() { super(); this.records = new Map(); this.calls = []; this.next = 0; this.closed = false; }
  list() { return [...this.records.values()].map(({value, ...record}) => structuredClone(record)); }
  async create(args) {
    this.calls.push({action: 'create', ...structuredClone(args)});
    const id = `private_${++this.next}`, record = {id, label: args.label, state: 'running', isolated: true, pid: 9000 + this.next, windows: [{id: String(4100 + this.next), title: 'Untitled - Notepad', pid: 9000 + this.next, isolated: true}], value: ''};
    this.records.set(id, record); return this.list().find(item => item.id === id);
  }
  async perform(args) {
    this.calls.push(structuredClone(args));
    const record = this.records.get(args.sessionId);
    assert.equal(record?.state, 'running');
    if (args.action === 'windows') return {windows: structuredClone(record.windows)};
    if (args.action === 'inspect') {
      assert.equal(args.windowId, record.windows[0].id);
      return {windowId: args.windowId, elements: [
        {ref: EDITOR, processId: record.pid, windowId: args.windowId, controlType: 'Edit', className: 'Edit', frameworkId: 'Win32', name: 'Text editor', enabled: true, password: false, readOnly: false, value: record.value, actions: ['get_text', 'set_value']},
        {ref: HELP, processId: record.pid, windowId: args.windowId, controlType: 'Button', className: 'Button', frameworkId: 'Win32', name: 'Open external help', enabled: true, actions: ['invoke']},
      ]};
    }
    if (args.action === 'get_text') { assert.equal(args.ref, EDITOR); return {ref: EDITOR, text: record.value.slice(0, args.maxCharacters ?? 4000)}; }
    if (args.action === 'set_value') { assert.equal(args.ref, EDITOR); record.value = args.value; return {ref: EDITOR, mechanism: 'hwnd_edit_value', text: 'Updated private editor.'}; }
    if (args.action === 'screenshot') return {windowId: record.windows[0].id, image: {mimeType: 'image/png', data: PIXEL, width: 1, height: 1}, method: 'print_window', text: 'Captured private fixture.'};
    assert.fail(`Unexpected native operation: ${args.action}`);
  }
  async close(id) { this.calls.push({action: 'close', sessionId: id}); const record = this.records.get(id); if (record) { record.state = 'closed'; record.windows = []; } }
  async closeAll() { this.closed = true; for (const record of this.records.values()) if (record.state === 'running') await this.close(record.id); }
}

class ModelRuntime extends EventEmitter {
  constructor() { super(); this.calls = []; }
  status() { return {connected: true, authenticated: true, defaultModel: 'application-fixture', models: [{id: 'application-fixture', model: 'application-fixture', available: true}]}; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) {
    // Enforce the provider-facing catalog before the fake model can call a
    // handler. Missing type metadata otherwise passes local fixture calls while
    // a real model request rejects the entire advertised tool catalog.
    for (const tool of options.dynamicTools || []) assert.ok(['function', 'namespace'].includes(tool.type), `${tool.name || 'Unnamed attached tool'} must have a canonical function or namespace type.`);
    const applicationTool = options.dynamicTools?.find(tool => tool.name === APPLICATION_TOOL.name);
    if (applicationTool) assert.equal(applicationTool.type, 'function');
    this.calls.push(options); return this.execute ? this.execute(options) : {output: 'No application action requested.', threadId: 'application-fixture-thread'};
  }
}
class NoDesktop extends EventEmitter {
  status() { return {available: false, enabled: false}; }
  async setEnabled(value) { assert.equal(value, false, 'integration tests never attach the user desktop'); return this.status(); }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-app-integration-')), dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace');
  await mkdir(cwd);
  const privateRuntime = new PrivateRuntime(), model = new ModelRuntime(), workspace = await new ApplicationWorkspace({dataDir, runtime: privateRuntime, platform: 'win32', catalog}).init();
  const app = await createHarnessServer({port: 0, dataDir, defaultCwd: cwd, runtime: model, desktop: new NoDesktop(), autoAttachDesktop: false, signedBrowser: false, applicationWorkspace: workspace});
  await app.learning.updateSettings({mode: 'off'});
  const url = new URL(await app.listen());
  t.after(async () => { await app.close(); assert.equal(privateRuntime.closed, true); assert.match(path.basename(directory), /^blackice-app-integration-/); await rm(directory, {recursive: true, force: true}); });
  const request = (route, {cookie, origin, method = 'GET', body} = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({hostname: url.hostname, port: url.port, path: route, method, headers: {...(cookie ? {Cookie: cookie} : {}), ...(origin ? {Origin: origin} : {}), ...(bytes ? {'Content-Type': 'application/json', 'Content-Length': bytes.length} : {})}}, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data;
        if (String(response.headers['content-type']).includes('application/json')) { try { data = JSON.parse(text); } catch (error) { reject(error); return; } }
        resolve({status: response.statusCode, headers: response.headers, data, text});
      });
    });
    req.setTimeout(5000, () => req.destroy(Error('Application integration HTTP request timed out.'))); req.on('error', reject); req.end(bytes);
  });
  const home = await request('/'), cookie = home.headers['set-cookie'][0].split(';', 1)[0];
  const action = body => request('/api/application-sessions/action', {cookie, method: 'POST', body});
  return {app, workspace, privateRuntime, model, request, action, cookie, dataDir};
}

test('private app HTTP routes require local authentication, reject cross-origin requests and never accept executable paths', async t => {
  const {app, workspace, privateRuntime, request, action, cookie} = await fixture(t);
  assert.equal(app.applicationWorkspace, workspace); assert.equal(app.engine.applicationWorkspace, workspace);
  assert.equal((await request('/api/application-sessions/status')).status, 401);
  assert.equal((await request('/api/application-sessions/action', {method: 'POST', body: {action: 'create', appId: 'notepad-classic'}})).status, 401);
  for (const route of ['/api/application-sessions/status', '/api/application-sessions/action']) {
    const response = await request(route, {cookie, origin: 'https://outside.example', ...(route.endsWith('action') ? {method: 'POST', body: {action: 'create', appId: 'notepad-classic'}} : {})});
    assert.equal(response.status, 403);
  }
  const status = await request('/api/application-sessions/status', {cookie}); assert.equal(status.status, 200); assert.equal(status.data.available, true); assert.equal(status.data.foregroundPolicy, 'isolated-desktop');
  assert.ok(!('executable' in status.data.supportedApps[0])); assert.ok(!('args' in status.data.supportedApps[0]));
  for (const body of [[], null, {action: 'create', appId: 'notepad-classic', executable: 'C:\\Windows\\System32\\cmd.exe'}, {action: 'create', appId: 'notepad-classic', args: ['/c', 'start']}, {action: 'create', appId: 'unlisted-app'}, {action: 'launch', executable: 'C:\\Windows\\System32\\notepad.exe'}]) {
    const response = await action(body); assert.ok([400, 404, 409].includes(response.status), `${JSON.stringify(body)}: ${response.status}`);
  }
  assert.equal((await request('/api/application-sessions/status', {cookie, method: 'POST', body: {}})).status, 404);
  assert.equal((await request('/api/application-sessions/action', {cookie})).status, 404);
  assert.equal(privateRuntime.calls.length, 0, 'rejected requests cannot start or control any native application');
  const created = await action({action: 'create', appId: 'notepad-classic', name: 'Shared private editor'}); assert.equal(created.status, 200); assert.equal(created.data.state, 'running'); assert.equal(created.data.isolated, true);
  assert.notEqual(created.data.id, privateRuntime.list()[0].id, 'HTTP clients receive workspace identities, never private runtime identities');
  assert.deepEqual(privateRuntime.calls[0], {action: 'create', executable: catalog[0].executable, args: [], label: 'Shared private editor'});
});

test('HTTP app controls require observed editor refs and reject invoke without admitting an unsafe native action', async t => {
  const {privateRuntime, action} = await fixture(t), created = await action({action: 'create', appId: 'notepad-classic'}), sessionId = created.data.id;
  const inspect = await action({action: 'inspect', sessionId}); assert.equal(inspect.status, 200); const editor = inspect.data.controls.find(control => control.ref === EDITOR); assert.equal(editor.writable, true); assert.equal(editor.readable, true);
  let before = privateRuntime.calls.length;
  for (const body of [{action: 'control', sessionId, operation: 'invoke', ref: HELP}, {action: 'control', sessionId, operation: 'set_value', ref: 'uia_abcdef123456_999', text: 'Do not admit'}, {action: 'control', sessionId, operation: 'set_value', ref: EDITOR, text: 'x'.repeat(10001)}]) {
    const response = await action(body); assert.ok([400, 409].includes(response.status), `${JSON.stringify(body).slice(0, 160)}: ${response.status}`);
  }
  assert.equal(privateRuntime.calls.length, before, 'unsupported or unobserved controls are rejected before the runtime');
  assert.equal((await action({action: 'control', sessionId, operation: 'set_value', ref: EDITOR, text: 'Human wrote this inside Observe.'})).status, 200);
  const text = await action({action: 'get_text', sessionId, ref: EDITOR}); assert.equal(text.status, 200); assert.equal(text.data.text, 'Human wrote this inside Observe.');
  const frame = await action({action: 'screenshot', sessionId}); assert.equal(frame.status, 200); assert.equal(frame.data.imageUrl, `data:image/png;base64,${PIXEL}`); assert.equal(frame.data.method, 'print_window');
  const ended = await action({action: 'close', sessionId}); assert.equal(ended.status, 200); assert.equal(ended.data.state, 'closed');
  before = privateRuntime.calls.length; assert.equal((await action({action: 'get_text', sessionId, ref: EDITOR})).status, 409); assert.equal(privateRuntime.calls.length, before, 'closed sessions never relaunch to satisfy a later action');
});

test('the full admitted editor text can be verified beyond the native default text length', async t => {
  const {privateRuntime, action} = await fixture(t), opened = await action({action: 'create', appId: 'notepad-classic'}), sessionId = opened.data.id;
  assert.equal((await action({action: 'inspect', sessionId})).status, 200);
  const content = 'Verified private document.\n'.repeat(350) + 'END-OF-ADMITTED-DOCUMENT'; assert.ok(content.length > 4000 && content.length <= 10000);
  assert.equal((await action({action: 'control', sessionId, operation: 'set_value', ref: EDITOR, text: content})).status, 200);
  const read = await action({action: 'get_text', sessionId}); assert.equal(read.status, 200); assert.equal(read.data.text, content, 'readback must cover every character accepted by the editor');
  const last = privateRuntime.calls.at(-1); assert.equal(last.action, 'get_text'); assert.equal(last.ref, EDITOR); assert.ok(last.maxCharacters >= content.length && last.maxCharacters <= 12000);
});

test('an engine agent opens, observes, edits, verifies, captures and ends the same app session exposed by HTTP', async t => {
  const {app, model, privateRuntime, request, cookie, dataDir} = await fixture(t); let sessionId;
  model.execute = async options => {
    assert.ok(options.dynamicTools.some(tool => tool.name === APPLICATION_TOOL.name)); assert.match(options.developerInstructions, /relay_apps/); assert.match(options.prompt, /PRIVATE APPLICATION SESSIONS/);
    const call = async value => { const result = await options.onToolCall({name: APPLICATION_TOOL.name, arguments: JSON.stringify(value)}, {signal: options.signal}); assert.equal(result.success, true, result.contentItems[0]?.text); return {result, value: JSON.parse(result.contentItems[0].text)}; };
    const discovery = await call({action: 'status'}); assert.equal(discovery.value.supportedApps[0].appId, 'notepad-classic');
    const created = await call({action: 'create', appId: 'notepad-classic', name: 'Agent private editor'}); sessionId = created.value.id;
    const visible = await request('/api/application-sessions/status', {cookie}); assert.equal(visible.data.activeSessionId, sessionId); assert.equal(visible.data.sessions.find(item => item.id === sessionId).state, 'running');
    const inspected = await call({action: 'inspect', sessionId}); assert.ok(inspected.value.controls.some(control => control.ref === EDITOR && control.writable));
    await call({action: 'control', sessionId, operation: 'set_value', ref: EDITOR, text: 'Verified through a shared private editor.'});
    const read = await call({action: 'get_text', sessionId, ref: EDITOR}); assert.equal(read.value.text, 'Verified through a shared private editor.');
    const image = await call({action: 'screenshot', sessionId}); assert.equal(image.value.method, 'print_window'); assert.equal(image.result.contentItems.find(item => item.type === 'inputImage')?.imageUrl, `data:image/png;base64,${PIXEL}`); assert.ok(!('imageUrl' in image.value), 'base64 images use the image channel, not the text receipt');
    await call({action: 'close', sessionId}); return {output: 'Edited and read back the shared private app, captured it, and ended its owned session.', threadId: 'application-fixture-thread'};
  };
  const started = app.engine.startRun({workflow: graph, input: 'Edit the private app without touching the visible desktop.'}); await app.engine.executions.get(started.id);
  const completed = app.engine.getRun(started.id); assert.equal(completed.status, 'completed', completed.error); assert.equal(model.calls.length, 1); assert.ok(completed.nodes.agent.toolNames.includes(APPLICATION_TOOL.name));
  const status = await request('/api/application-sessions/status', {cookie}); assert.equal(status.data.sessions.find(item => item.id === sessionId).state, 'closed');
  assert.deepEqual(privateRuntime.calls.map(item => item.action), ['create', 'windows', 'inspect', 'set_value', 'get_text', 'screenshot', 'close']);
  const history = JSON.parse(await readFile(path.join(dataDir, 'application-sessions.json'), 'utf8')); assert.equal(history.sessions.find(item => item.id === sessionId).state, 'closed'); assert.ok(!JSON.stringify(history).includes(PIXEL), 'captured pixels are not persisted in session history');
});

test('a saved native conversation keeps its original tools while a new chat receives private application access', async t => {
  const {app, model, privateRuntime} = await fixture(t);
  await app.runtimeSettings.update({codexHistory: 'codex'});
  model.execute = async options => {
    const continued = model.calls.length === 2;
    assert.equal(options.dynamicTools.some(tool => tool.name === APPLICATION_TOOL.name), !continued);
    if (continued) {
      assert.equal(options.threadId, 'saved-app-fixture-thread');
      assert.ok(!options.prompt.includes('PRIVATE APPLICATION SESSIONS'), 'an older native tool catalog must not receive instructions for an unattached app tool');
      assert.ok(!options.developerInstructions.includes('"name":"relay_apps"'));
    }
    return {output: 'Reported the actual attached application capabilities.', threadId: 'saved-app-fixture-thread', codexHistory: 'codex'};
  };
  const first = app.engine.startRun({workflow: graph, input: 'Inspect the available tool catalog.'}); await app.engine.executions.get(first.id);
  const original = app.engine.getRun(first.id); assert.equal(original.status, 'completed', original.error);
  // Model an existing native conversation whose saved catalog predates relay_apps.
  app.engine.runs.get(first.id).nodes.agent.toolNames = original.nodes.agent.toolNames.filter(name => name !== APPLICATION_TOOL.name);
  const next = app.engine.continueRun(first.id, {nodeId: 'agent', message: 'Continue with the tools this native session originally had.'}); await app.engine.executions.get(next.id);
  assert.equal(app.engine.getRun(next.id).status, 'completed', app.engine.getRun(next.id).error);
  const fresh = app.engine.startRun({workflow: graph, input: 'A fresh chat may use the new application tool.'}); await app.engine.executions.get(fresh.id);
  assert.equal(app.engine.getRun(fresh.id).status, 'completed', app.engine.getRun(fresh.id).error); assert.equal(model.calls.length, 3); assert.equal(privateRuntime.calls.length, 0);
});
