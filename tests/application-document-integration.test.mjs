import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { ApplicationWorkspace } from '../lib/application-workspace.mjs';
import { APPLICATION_TOOL, APPLICATION_SCHEMA_VERSION, LEGACY_APPLICATION_TOOL, LEGACY_APPLICATION_INSTRUCTIONS } from '../lib/application-tools.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const EDITOR = 'uia_abcdef123456_1';
const catalog = [{ appId: 'notepad-classic', name: 'Notepad', available: true, executable: 'C:\\Windows\\System32\\notepad.exe', args: [] }];
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const graph = { id: 'document-integration', name: 'Private document round trip', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Document worker', model: 'document-fixture', prompt: 'Work with the attached private application editor and its saved versions.' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } };

// In-memory private runtime only. These integration tests start a local HTTP
// server and fake provider, never a Windows helper, browser, or GUI process.
class PrivateRuntime extends EventEmitter {
  constructor() { super(); this.sessions = new Map(); this.calls = []; this.next = 0; this.closed = false; }
  list() { return [...this.sessions.values()].map(({ text, ...receipt }) => structuredClone(receipt)); }
  async create(value) {
    this.calls.push({ action: 'create', ...structuredClone(value) });
    const id = `private_${++this.next}`, record = { id, label: value.label, state: 'running', isolated: true, pid: 8000 + this.next, windows: [{ id: String(5000 + this.next), pid: 8000 + this.next, title: 'Untitled - Notepad', isolated: true }], text: '' };
    this.sessions.set(id, record); return this.list().find(item => item.id === id);
  }
  async perform(value) {
    this.calls.push(structuredClone(value)); const record = this.sessions.get(value.sessionId); assert.equal(record?.state, 'running', 'every native observation targets this fixture’s existing private process');
    if (value.action === 'windows') return { windows: structuredClone(record.windows) };
    if (value.action === 'inspect') {
      assert.equal(value.windowId, record.windows[0].id);
      return { windowId: value.windowId, elements: [{ ref: EDITOR, processId: record.pid, windowId: value.windowId, controlType: 'Edit', className: 'Edit', frameworkId: 'Win32', enabled: true, password: false, readOnly: false, name: 'Actual private editor', value: record.text, actions: ['get_text', 'set_value'] }] };
    }
    if (value.action === 'get_text') { assert.equal(value.ref, EDITOR); return { ref: EDITOR, text: record.text.slice(0, value.maxCharacters ?? 4000) }; }
    if (value.action === 'set_value') {
      assert.equal(value.ref, EDITOR);
      if (value.expectedTextSha256 !== undefined && digest(record.text) !== value.expectedTextSha256) throw Object.assign(Error('The native editor changed before replacement.'), { status: 409, code: 'APPLICATION_TEXT_CONFLICT' });
      record.text = value.value; return { ref: EDITOR, mechanism: 'fixture_editor_value', text: 'Updated the existing private editor.' };
    }
    assert.fail(`Unexpected native action in document integration: ${value.action}`);
  }
  async close(id) { this.calls.push({ action: 'close', sessionId: id }); const record = this.sessions.get(id); if (record) { record.state = 'closed'; record.windows = []; } }
  async closeAll() { this.closed = true; for (const record of this.sessions.values()) if (record.state === 'running') await this.close(record.id); }
  get editorText() { return [...this.sessions.values()].at(-1)?.text; }
}
class ModelRuntime extends EventEmitter {
  constructor() { super(); this.calls = []; this.expectedApplicationSchemaVersion = 2; }
  status() { return { connected: true, authenticated: true, defaultModel: 'document-fixture', models: [{ id: 'document-fixture', model: 'document-fixture', available: true }] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) {
    for (const tool of options.dynamicTools || []) assert.ok(['function', 'namespace'].includes(tool.type), `${tool.name || 'Unnamed tool'} needs provider-facing type metadata.`);
    const tool = options.dynamicTools?.find(item => item.name === APPLICATION_TOOL.name);
    if (tool) {
      assert.equal(tool.type, 'function'); assert.equal(tool.inputSchema.additionalProperties, false);
      if (this.expectedApplicationSchemaVersion === 1) assert.deepEqual(tool, LEGACY_APPLICATION_TOOL);
      else {
        for (const action of ['save_text', 'read_document', 'restore_document']) assert.ok(tool.inputSchema.properties.action.enum.includes(action), `${action} is advertised to the actual engine provider`);
        assert.equal(tool.inputSchema.properties.documentId.type, 'string'); assert.equal(tool.inputSchema.properties.title.type, 'string'); assert.equal(tool.inputSchema.properties.expectedTextSha256.pattern, '^[a-f0-9]{64}$');
      }
    }
    await recordFixturePlan(options, { title: 'Exercise the private document workflow', doneWhen: 'Observed editor text and saved versions enforce the requested integrity and restore boundaries.' });
    this.calls.push(options); return this.execute ? this.execute(options) : { output: 'No application launch requested.', threadId: 'document-fixture-thread' };
  }
}
class NoDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled(value) { assert.equal(value, false, 'a document test must never attach the user desktop'); return this.status(); }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-document-integration-')), dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  let app, runtime, model, workspace, url, cookie; const startedApps = [];
  const request = (route, { cookie: auth, origin, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers: { ...(auth ? { Cookie: auth } : {}), ...(origin ? { Origin: origin } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data; try { if (String(response.headers['content-type']).includes('application/json')) data = JSON.parse(text); } catch (error) { reject(error); return; }
        resolve({ status: response.statusCode, headers: response.headers, data, text });
      });
    });
    req.setTimeout(5000, () => req.destroy(Error('Document integration HTTP request timed out.'))); req.on('error', reject); req.end(bytes);
  });
  async function start({ platform = 'win32', availableCatalog = catalog } = {}) {
    runtime = new PrivateRuntime(); model = new ModelRuntime(); workspace = await new ApplicationWorkspace({ dataDir, runtime, platform, catalog: availableCatalog }).init();
    app = await createHarnessServer({ port: 0, dataDir, defaultCwd: cwd, runtime: model, desktop: new NoDesktop(), autoAttachDesktop: false, signedBrowser: false, applicationWorkspace: workspace }); startedApps.push(app); await app.learning.updateSettings({ mode: 'off' });
    url = new URL(await app.listen()); const home = await request('/'); cookie = home.headers['set-cookie'][0].split(';', 1)[0];
  }
  await start();
  t.after(async () => { for (const server of startedApps) await server.close(); const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); assert.match(path.basename(resolved), /^blackice-document-integration-/); await rm(resolved, { recursive: true, force: true }); });
  const action = body => request('/api/application-sessions/action', { cookie, method: 'POST', body });
  const okay = async body => { const response = await action(body); assert.equal(response.status, 200, `${body.action}: ${response.text}`); return response.data; };
  return { get app() { return app; }, get model() { return model; }, get runtime() { return runtime; }, get workspace() { return workspace; }, get cookie() { return cookie; }, dataDir, request, action, okay, async restart(options) { const previousRuntime = runtime; await app.close(); assert.equal(previousRuntime.closed, true); await start(options); } };
}

async function openEditor(f, text = '') {
  const created = await f.okay({ action: 'create', appId: 'notepad-classic', name: 'Shared document editor' }), sessionId = created.id;
  const observation = await f.okay({ action: 'inspect', sessionId }); assert.equal(observation.editor.ref, EDITOR); assert.equal(observation.editor.sha256, digest(''));
  if (text) await f.okay({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text, expectedTextSha256: observation.editor.sha256 });
  return sessionId;
}

test('HTTP saves exact observed editor text and restores with a verified recovery version', async t => {
  const f = await fixture(t), original = 'Actual private note\r\nDark ice: ❄ 雪 🧊\r\n', sessionId = await openEditor(f, original);
  const saved = await f.okay({ action: 'save_text', sessionId, title: 'First checked version' }); assert.equal(saved.document.sha256, digest(original)); assert.equal(saved.document.bytes, Buffer.byteLength(original, 'utf8')); assert.equal(saved.document.characters, original.length); assert.equal(saved.document.source.sessionId, sessionId); assert.equal(saved.document.text, undefined);
  const stored = await f.okay({ action: 'read_document', documentId: saved.document.id }); assert.equal(stored.text, original); assert.equal(stored.document.text, original);
  const later = 'Current editor before restore\nUnsaved changes retained in recovery.';
  await f.okay({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: later, expectedTextSha256: digest(original) });
  const preview = await f.okay({ action: 'inspect', sessionId }); assert.equal(preview.editor.sha256, digest(later));
  const restored = await f.okay({ action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256: preview.editor.sha256 });
  assert.equal(restored.verified, true); assert.equal(restored.editor.sha256, digest(original)); assert.equal(restored.document.id, saved.document.id); assert.equal(restored.recoveryDocument.sha256, digest(later)); assert.notEqual(restored.recoveryDocument.id, saved.document.id);
  assert.equal((await f.okay({ action: 'get_text', sessionId })).text, original); assert.equal(f.runtime.editorText, original); assert.equal((await f.okay({ action: 'read_document', documentId: restored.recoveryDocument.id })).text, later);
  const status = await f.request('/api/application-sessions/status', { cookie: f.cookie }); assert.equal(status.data.documentStorage.healthy, true); assert.equal(status.data.documents.length, 2); assert.ok(status.data.documents.every(item => !Object.hasOwn(item, 'text')));
  const session = status.data.sessions.find(item => item.id === sessionId); assert.equal(session.lastRestore.state, 'verified'); assert.equal(session.lastRestore.recoveryDocumentId, restored.recoveryDocument.id); assert.ok(!JSON.stringify(status.data).includes('Actual private note'));
  const history = JSON.parse(await readFile(path.join(f.dataDir, 'application-sessions.json'), 'utf8')); assert.equal(history.sessions.find(item => item.id === sessionId).lastRestore.state, 'verified'); assert.ok(!JSON.stringify(history).includes('Current editor before restore')); assert.equal(f.runtime.calls.filter(call => call.action === 'create').length, 1);
});

test('saved library reads survive session end and a server restart without an available application runtime', async t => {
  const f = await fixture(t), text = 'Persisted outside the lifetime of the private editor.\r\n', sessionId = await openEditor(f, text), saved = await f.okay({ action: 'save_text', sessionId, title: 'Persistent editor text' });
  await f.okay({ action: 'close', sessionId }); let nativeCalls = f.runtime.calls.length;
  assert.equal((await f.okay({ action: 'read_document', documentId: saved.document.id })).text, text); assert.equal(f.runtime.calls.length, nativeCalls, 'reading a closed session’s document starts no native work');
  await f.restart({ platform: 'unsupported-fixture', availableCatalog: [] });
  const status = await f.request('/api/application-sessions/status', { cookie: f.cookie }); assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.equal(status.data.documents[0].id, saved.document.id); assert.deepEqual(status.data.supportedApps, []);
  assert.equal((await f.okay({ action: 'read_document', documentId: saved.document.id })).text, text); assert.equal(f.runtime.calls.length, 0);
  const refused = await f.action({ action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256: digest(text) }); assert.equal(refused.status, 409); assert.equal(f.runtime.calls.length, 0, 'restore never relaunches a terminal or restarted session');
});

test('saved text HTTP actions enforce authentication and same-origin policy before any editor or library operation', async t => {
  const f = await fixture(t), sessionId = await openEditor(f, 'Protected local editor'), saved = await f.okay({ action: 'save_text', sessionId, title: 'Protected local version' }); const nativeCalls = f.runtime.calls.length, count = f.workspace.documents.list().length;
  for (const body of [{ action: 'save_text', sessionId }, { action: 'read_document', documentId: saved.document.id }, { action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256: digest('Protected local editor') }]) {
    assert.equal((await f.request('/api/application-sessions/action', { method: 'POST', body })).status, 401);
    assert.equal((await f.request('/api/application-sessions/action', { cookie: f.cookie, origin: 'https://outside.example', method: 'POST', body })).status, 403);
  }
  assert.equal(f.runtime.calls.length, nativeCalls); assert.equal(f.workspace.documents.list().length, count); assert.equal(f.runtime.editorText, 'Protected local editor');
});

test('HTTP save rejects supplied text and paths, and document reads reject every unknown field', async t => {
  const f = await fixture(t), sessionId = await openEditor(f, 'Read actual editor only'), saved = await f.okay({ action: 'save_text', sessionId, title: 'Trusted source' }); const before = f.runtime.calls.length;
  for (const extra of [{ text: 'Caller fabricated document' }, { path: 'C:\\private\\outside.txt' }, { filename: '../outside' }, { source: { sessionId: 'forged' } }, { documentId: saved.document.id }, { expectedTextSha256: digest('') }]) {
    const result = await f.action({ action: 'save_text', sessionId, ...extra }); assert.equal(result.status, 400, JSON.stringify(extra));
  }
  for (const extra of [{ path: '../outside' }, { text: 'Injected' }, { sessionId }, { filename: 'note.txt' }, { actionOverride: 'create' }]) assert.equal((await f.action({ action: 'read_document', documentId: saved.document.id, ...extra })).status, 400, JSON.stringify(extra));
  for (const documentId of ['../outside', '..\\outside', 'C:\\private\\secret', '', null]) assert.equal((await f.action({ action: 'read_document', documentId })).status, 400);
  assert.equal((await f.action({ action: 'read_document', documentId: 'doc_12345678-1234-4234-8234-123456789012' })).status, 404); assert.equal(f.runtime.calls.length, before); assert.equal(f.workspace.documents.list().length, 1); assert.equal(f.runtime.editorText, 'Read actual editor only');
});

test('stale HTTP editor and restore hashes cannot overwrite newer text or create an unnecessary recovery version', async t => {
  const f = await fixture(t), sessionId = await openEditor(f, 'Original saved target'), saved = await f.okay({ action: 'save_text', sessionId, title: 'Target' }), observation = await f.okay({ action: 'inspect', sessionId });
  await f.okay({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: 'Newer collaborative edit', expectedTextSha256: observation.editor.sha256 }); const writes = f.runtime.calls.filter(call => call.action === 'set_value').length;
  const staleEdit = await f.action({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: 'Stale draft must not overwrite', expectedTextSha256: observation.editor.sha256 }); assert.equal(staleEdit.status, 409); assert.match(staleEdit.text, /changed/);
  const staleRestore = await f.action({ action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256: observation.editor.sha256 }); assert.equal(staleRestore.status, 409); assert.match(staleRestore.text, /No text was replaced/);
  for (const expectedTextSha256 of [undefined, '', '0'.repeat(63), 'A'.repeat(64)]) assert.equal((await f.action({ action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256 })).status, 400);
  assert.equal(f.runtime.editorText, 'Newer collaborative edit'); assert.equal(f.runtime.calls.filter(call => call.action === 'set_value').length, writes); assert.equal(f.workspace.documents.list().length, 1); assert.equal((await f.okay({ action: 'get_text', sessionId })).text, 'Newer collaborative edit');
});

test('engine relay_apps saves, reads, changes and restores the same editor and documents visible over HTTP', async t => {
  const f = await fixture(t); let sessionId, savedId, recoveryId;
  f.model.execute = async options => {
    assert.ok(options.dynamicTools.some(tool => tool.name === APPLICATION_TOOL.name)); assert.match(options.developerInstructions, /relay_apps/); assert.match(options.prompt, /PRIVATE APPLICATION SESSIONS/); assert.match(options.prompt, /save_text/); assert.match(options.prompt, /expectedTextSha256/);
    const call = async value => { const response = await options.onToolCall({ name: APPLICATION_TOOL.name, arguments: JSON.stringify(value) }, { signal: options.signal }); assert.equal(response.success, true, response.contentItems[0]?.text); return JSON.parse(response.contentItems[0].text); };
    assert.equal((await call({ action: 'status' })).supportedApps[0].appId, 'notepad-classic'); const created = await call({ action: 'create', appId: 'notepad-classic', name: 'Model document editor' }); sessionId = created.id;
    const inspected = await call({ action: 'inspect', sessionId }); assert.equal(inspected.editor.sha256, digest('')); assert.equal(inspected.editor.ref, EDITOR);
    const targetText = 'Model wrote a real private editor.\r\nUnicode: 雪 🧊\r\n'; await call({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: targetText, expectedTextSha256: inspected.editor.sha256 });
    const saved = await call({ action: 'save_text', sessionId, title: 'Model checked version' }); savedId = saved.document.id; assert.equal(saved.document.sha256, digest(targetText)); assert.equal((await f.okay({ action: 'read_document', documentId: savedId })).text, targetText);
    assert.equal((await call({ action: 'read_document', documentId: savedId })).document.text, targetText);
    const laterText = 'Later human changes, protected by recovery.'; await f.okay({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: laterText, expectedTextSha256: saved.document.sha256 });
    const preview = await call({ action: 'inspect', sessionId }); assert.equal(preview.editor.sha256, digest(laterText)); const restored = await call({ action: 'restore_document', sessionId, documentId: savedId, expectedTextSha256: preview.editor.sha256 }); recoveryId = restored.recoveryDocument.id;
    assert.equal(restored.verified, true); assert.equal((await call({ action: 'get_text', sessionId })).text, targetText); assert.equal((await f.okay({ action: 'read_document', documentId: recoveryId })).text, laterText);
    await call({ action: 'close', sessionId }); const calls = f.runtime.calls.length; assert.equal((await call({ action: 'read_document', documentId: savedId })).text, targetText); assert.equal(f.runtime.calls.length, calls);
    return { output: 'Saved the exact shared editor, verified a recovery-backed restore, and retained its document after ending the private session.', threadId: 'document-fixture-thread' };
  };
  const started = f.app.engine.startRun({ workflow: graph, input: 'Preserve and restore the shared private editor without touching the visible desktop.' }); await f.app.engine.executions.get(started.id); const run = f.app.engine.getRun(started.id);
  assert.equal(run.status, 'completed', run.error); assert.equal(f.model.calls.length, 1); assert.ok(run.nodes.agent.toolNames.includes(APPLICATION_TOOL.name)); assert.equal(f.runtime.calls.filter(call => call.action === 'create').length, 1); assert.equal(f.runtime.calls.filter(call => call.action === 'close').length, 1);
  const status = await f.request('/api/application-sessions/status', { cookie: f.cookie }); assert.equal(status.data.sessions.find(item => item.id === sessionId).state, 'closed'); assert.ok(status.data.documents.some(item => item.id === savedId)); assert.ok(status.data.documents.some(item => item.id === recoveryId));
});

test('engine tool rejects fabricated save inputs, unknown document fields and stale overwrite hashes without native effects', async t => {
  const f = await fixture(t), sessionId = await openEditor(f, 'Saved target'), saved = await f.okay({ action: 'save_text', sessionId, title: 'Tool target' }); await f.okay({ action: 'control', sessionId, ref: EDITOR, operation: 'set_value', text: 'Current collaborative editor', expectedTextSha256: digest('Saved target') }); const writes = f.runtime.calls.filter(call => call.action === 'set_value').length;
  f.model.execute = async options => {
    const call = value => options.onToolCall({ name: APPLICATION_TOOL.name, arguments: JSON.stringify(value) }, { signal: options.signal });
    const before = f.runtime.calls.length;
    for (const value of [{ action: 'save_text', sessionId, text: 'Invented text' }, { action: 'save_text', sessionId, path: 'C:\\private\\new-file' }, { action: 'read_document', documentId: saved.document.id, sessionId }, { action: 'read_document', documentId: saved.document.id, path: '../outside' }, { action: 'restore_document', sessionId, documentId: saved.document.id }]) { const result = await call(value); assert.equal(result.success, false); assert.match(result.contentItems[0].text, /fields|expectedTextSha256/); }
    assert.equal(f.runtime.calls.length, before, 'schema rejection reaches no native editor operation');
    const conflict = await call({ action: 'restore_document', sessionId, documentId: saved.document.id, expectedTextSha256: digest('Saved target') }); assert.equal(conflict.success, false); assert.match(conflict.contentItems[0].text, /No text was replaced/); return { output: 'Reported rejected inputs and a concurrent edit conflict without replacing text.', threadId: 'document-fixture-thread' };
  };
  const started = f.app.engine.startRun({ workflow: graph, input: 'Check saved document input boundaries.' }); await f.app.engine.executions.get(started.id); assert.equal(f.app.engine.getRun(started.id).status, 'completed', f.app.engine.getRun(started.id).error); assert.equal(f.runtime.editorText, 'Current collaborative editor'); assert.equal(f.runtime.calls.filter(call => call.action === 'set_value').length, writes); assert.equal(f.workspace.documents.list().length, 1);
});

test('native application catalogs without a version marker retain the exact original schema through continuation and retry', async t => {
  const f = await fixture(t); await f.app.runtimeSettings.update({ codexHistory: 'codex' }); let turns = 0;
  f.model.execute = async options => {
    turns++; const tool = options.dynamicTools.find(item => item.name === APPLICATION_TOOL.name); assert.ok(tool);
    options.onEvent({ type: 'thread', threadId: 'native-legacy-application-thread' });
    if (turns === 1) { assert.deepEqual(tool, APPLICATION_TOOL); return { output: 'Recorded the initially attached application tool.', threadId: 'native-legacy-application-thread', codexHistory: 'codex' }; }
    assert.equal(options.threadId, 'native-legacy-application-thread'); assert.deepEqual(tool, LEGACY_APPLICATION_TOOL); assert.equal(tool.inputSchema.properties.expectedTextSha256, undefined); assert.equal(tool.inputSchema.properties.documentId, undefined); assert.equal(tool.inputSchema.properties.title, undefined);
    assert.ok(options.prompt.includes(LEGACY_APPLICATION_INSTRUCTIONS)); assert.doesNotMatch(options.prompt, /save_text|read_document|restore_document|expectedTextSha256|recovery text version/); assert.doesNotMatch(options.developerInstructions, /save_text|read_document|restore_document|recovery version|Saved versions/);
    const nativeCalls = f.runtime.calls.length, documents = f.workspace.documents.list();
    for (const value of [{ action: 'save_text', sessionId: 'never-opened' }, { action: 'read_document', documentId: 'never-saved' }, { action: 'restore_document', sessionId: 'never-opened', documentId: 'never-saved', expectedTextSha256: digest('') }, { action: 'control', sessionId: 'never-opened', ref: EDITOR, operation: 'set_value', text: 'Must not be applied', expectedTextSha256: digest('') }]) {
      const response = await options.onToolCall({ name: APPLICATION_TOOL.name, arguments: JSON.stringify(value) }, { signal: options.signal }); assert.equal(response.success, false); assert.match(response.contentItems[0].text, /attached.*catalog/);
    }
    assert.equal(f.runtime.calls.length, nativeCalls); assert.deepEqual(f.workspace.documents.list(), documents);
    const status = await options.onToolCall({ name: APPLICATION_TOOL.name, arguments: { action: 'status' } }); assert.equal(status.success, true);
    if (turns === 2) throw Error('Fixture interrupted after checking the original app catalog.');
    return { output: 'Retained the original attached application schema.', threadId: 'native-legacy-application-thread', codexHistory: 'codex' };
  };
  const first = f.app.engine.startRun({ workflow: graph, input: 'Check the initially attached application schema.' }); await f.app.engine.executions.get(first.id); assert.equal(f.app.engine.getRun(first.id).nodes.agent.applicationSchemaVersion, APPLICATION_SCHEMA_VERSION);
  // An actual pre-upgrade native conversation has relay_apps in its catalog but
  // predates the newly persisted schema marker.
  delete f.app.engine.runs.get(first.id).nodes.agent.applicationSchemaVersion; f.model.expectedApplicationSchemaVersion = 1;
  const continued = f.app.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the same native application conversation.' }); await f.app.engine.executions.get(continued.id); const interrupted = f.app.engine.getRun(continued.id);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.nodes.agent.resumeApplicationSchemaVersion, 1); assert.equal(interrupted.nodes.agent.applicationSchemaVersion, 1);
  const retry = f.app.engine.retryRun(continued.id); await f.app.engine.executions.get(retry.id); const finished = f.app.engine.getRun(retry.id); assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.nodes.agent.resumeApplicationSchemaVersion, 1); assert.equal(finished.nodes.agent.applicationSchemaVersion, 1); assert.equal(turns, 3); assert.equal(f.runtime.calls.length, 0);
});

test('native version two application catalogs retain saved-text actions through continuation and retry', async t => {
  const f = await fixture(t); await f.app.runtimeSettings.update({ codexHistory: 'codex' }); let turns = 0;
  f.model.execute = async options => {
    turns++; assert.deepEqual(options.dynamicTools.find(item => item.name === APPLICATION_TOOL.name), APPLICATION_TOOL); assert.match(options.prompt, /save_text/); assert.match(options.developerInstructions, /read_document/);
    options.onEvent({ type: 'thread', threadId: 'native-v2-application-thread' });
    if (turns > 1) assert.equal(options.threadId, 'native-v2-application-thread');
    if (turns === 2) throw Error('Fixture interruption with the version two catalog.');
    return { output: 'Retained the attached version two application schema.', threadId: 'native-v2-application-thread', codexHistory: 'codex' };
  };
  const first = f.app.engine.startRun({ workflow: graph, input: 'Start a new saved-text capable native conversation.' }); await f.app.engine.executions.get(first.id); assert.equal(f.app.engine.getRun(first.id).nodes.agent.applicationSchemaVersion, 2);
  const continued = f.app.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the saved-text capable native conversation.' }); await f.app.engine.executions.get(continued.id); const interrupted = f.app.engine.getRun(continued.id); assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.nodes.agent.applicationSchemaVersion, 2); assert.equal(interrupted.nodes.agent.resumeApplicationSchemaVersion, 2);
  const retry = f.app.engine.retryRun(continued.id); await f.app.engine.executions.get(retry.id); const finished = f.app.engine.getRun(retry.id); assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.nodes.agent.applicationSchemaVersion, 2); assert.equal(finished.nodes.agent.resumeApplicationSchemaVersion, 2); assert.equal(turns, 3); assert.equal(f.runtime.calls.length, 0);
});

test('fresh and Relay ephemeral conversations receive version two after legacy native history', async t => {
  const f = await fixture(t); await f.app.runtimeSettings.update({ codexHistory: 'codex' });
  f.model.execute = async options => { options.onEvent({ type: 'thread', threadId: 'native-upgrade-application-thread' }); return { output: 'Recorded an original native application conversation.', threadId: 'native-upgrade-application-thread', codexHistory: 'codex' }; };
  const original = f.app.engine.startRun({ workflow: graph, input: 'Record a pre-upgrade native session.' }); await f.app.engine.executions.get(original.id); delete f.app.engine.runs.get(original.id).nodes.agent.applicationSchemaVersion;
  await f.app.runtimeSettings.update({ codexHistory: 'relay' });
  f.model.execute = async options => { assert.deepEqual(options.dynamicTools.find(item => item.name === APPLICATION_TOOL.name), APPLICATION_TOOL); assert.equal(options.threadId, undefined); assert.match(options.prompt, /save_text/); return { output: 'Used the current application schema in a fresh ephemeral session.', threadId: 'ephemeral-upgrade-application-thread', codexHistory: 'relay' }; };
  const continued = f.app.engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue with Relay continuity in a new ephemeral native session.' }); await f.app.engine.executions.get(continued.id); const ephemeral = f.app.engine.getRun(continued.id); assert.equal(ephemeral.status, 'completed', ephemeral.error); assert.equal(ephemeral.nodes.agent.applicationSchemaVersion, 2); assert.equal(ephemeral.nodes.agent.resumeApplicationSchemaVersion, undefined); assert.equal(ephemeral.modelHandoff.reason, 'relay-history');
  const fresh = f.app.engine.startRun({ workflow: graph, input: 'Start a completely fresh current-schema conversation.' }); await f.app.engine.executions.get(fresh.id); assert.equal(f.app.engine.getRun(fresh.id).status, 'completed', f.app.engine.getRun(fresh.id).error); assert.equal(f.app.engine.getRun(fresh.id).nodes.agent.applicationSchemaVersion, 2); assert.equal(f.runtime.calls.length, 0);
});

test('a model can read its saved document library after restart when native applications are unavailable', async t => {
  const f = await fixture(t), text = 'Model-readable saved text without a running native app.', sessionId = await openEditor(f, text), saved = await f.okay({ action: 'save_text', sessionId, title: 'Independent document library' }); await f.okay({ action: 'close', sessionId }); await f.restart({ platform: 'linux', availableCatalog: [] });
  f.model.execute = async options => {
    assert.deepEqual(options.dynamicTools.find(item => item.name === APPLICATION_TOOL.name), APPLICATION_TOOL);
    const invoke = value => options.onToolCall({ name: APPLICATION_TOOL.name, arguments: value }, { signal: options.signal });
    const inventory = await invoke({ action: 'status' }); assert.equal(inventory.success, true); const status = JSON.parse(inventory.contentItems[0].text); assert.equal(status.available, false); assert.deepEqual(status.supportedApps, []); assert.equal(status.documents[0].id, saved.document.id);
    const read = await invoke({ action: 'read_document', documentId: saved.document.id }); assert.equal(read.success, true); assert.equal(JSON.parse(read.contentItems[0].text).text, text);
    const denied = await invoke({ action: 'create', appId: 'notepad-classic' }); assert.equal(denied.success, false); assert.match(denied.contentItems[0].text, /require Windows/); return { output: 'Read the intact saved document without starting an application.', threadId: 'document-library-only-thread' };
  };
  const started = f.app.engine.startRun({ workflow: graph, input: 'Read the saved private editor version.' }); await f.app.engine.executions.get(started.id); const completed = f.app.engine.getRun(started.id); assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.nodes.agent.applicationSchemaVersion, 2); assert.equal(f.runtime.calls.length, 0);
});
