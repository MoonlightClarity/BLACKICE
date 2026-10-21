import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rename, mkdir, rm, readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {ApplicationWorkspace} from '../lib/application-workspace.mjs';
import {ApplicationDocumentStore} from '../lib/application-documents.mjs';
import {createApplicationToolHandler, APPLICATION_TOOL} from '../lib/application-tools.mjs';
import {createProfileBackup, verifyProfileBackup, restoreProfileBackup} from '../lib/profile-backup.mjs';

const EDITOR = 'uia_abcdef123456_1';
const catalog = [{appId: 'notepad-classic', name: 'Notepad', available: true, executable: 'C:\\Windows\\System32\\notepad.exe', args: []}];
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const copied = value => structuredClone(value);

// In-memory private runtime only. These tests never start a native helper or app.
class PrivateEditor {
  constructor(text = '') {this.text = text; this.calls = []; this.sessions = []; this.onPerform = null;}
  list() {return copied(this.sessions);}
  async create(value) {
    this.calls.push({action: 'create', ...copied(value)});
    const session = {id: `private_${this.sessions.length + 1}`, state: 'running', isolated: true, windows: [{id: '4101', title: 'Untitled - Notepad', isolated: true}]};
    this.sessions.push(session); return copied(session);
  }
  async perform(value) {
    this.calls.push(copied(value));
    const supplied = await this.onPerform?.(value);
    if (supplied !== undefined) return supplied;
    if (value.action === 'windows') return {windows: copied(this.sessions.find(item => item.id === value.sessionId).windows)};
    if (value.action === 'inspect') return {elements: [{ref: EDITOR, name: 'Text editor', controlType: 'Edit', enabled: true, password: false, actions: ['get_text', 'set_value'], value: this.text.slice(0, 2000)}]};
    if (value.action === 'get_text') return {ref: EDITOR, text: this.text.slice(0, value.maxCharacters ?? 4000)};
    if (value.action === 'set_value') {
      if (value.expectedTextSha256 !== undefined && hash(this.text) !== value.expectedTextSha256) throw Object.assign(Error('Native editor changed before conditional replacement.'), {code: 'APPLICATION_TEXT_CONFLICT', status: 409});
      this.text = value.value; return {ref: EDITOR, text: 'Updated the private editor.'};
    }
    assert.fail(`Unexpected native action: ${value.action}`);
  }
  async close(id) {this.calls.push({action: 'close', sessionId: id}); const session = this.sessions.find(item => item.id === id); if (session) {session.state = 'closed'; session.windows = [];}}
  async closeAll() {for (const session of this.sessions) if (session.state === 'running') await this.close(session.id);}
}

async function fixture(t, {text = 'Actual current editor', maxDocuments = 100} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-document-actions-'));
  const runtime = new PrivateEditor(text);
  const documents = new ApplicationDocumentStore({dataDir, maxDocuments});
  const workspace = await new ApplicationWorkspace({dataDir, runtime, documents, platform: 'win32', catalog}).init();
  const session = await workspace.create({appId: 'notepad-classic', name: 'Private writing'});
  const cleanup = [];
  t.after(async () => {
    for (const operation of cleanup) await operation();
    await workspace.close().catch(() => {});
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dataDir, {recursive: true, force: true});
  });
  const save = title => workspace.perform({action: 'save_text', sessionId: session.id, ...(title === undefined ? {} : {title})});
  const restore = (documentId, expectedTextSha256 = hash(runtime.text)) => workspace.perform({action: 'restore_document', sessionId: session.id, documentId, expectedTextSha256});
  return {workspace, documents, runtime, dataDir, session, save, restore, onCleanup: operation => cleanup.push(operation)};
}

test('save_text captures a fresh actual editor read and rejects caller-supplied text or paths', async t => {
  const {workspace, runtime, session, save, dataDir} = await fixture(t, {text: 'Native source\r\nwith exact line endings'});
  const before = runtime.calls.length;
  for (const injected of [{text: 'Fabricated content'}, {path: '../outside'}, {documentId: 'invented'}, {executable: 'cmd.exe'}]) await assert.rejects(workspace.perform({action: 'save_text', sessionId: session.id, ...injected}), /saved-text fields/);
  assert.equal(runtime.calls.length, before);
  const result = await save('Saved actual content');
  assert.deepEqual(runtime.calls.slice(before).map(item => item.action), ['windows', 'inspect', 'get_text']);
  assert.equal(result.document.text, undefined);
  assert.equal(result.document.sha256, hash(runtime.text));
  assert.equal(result.editor.sha256, hash(runtime.text));
  assert.equal((await workspace.readDocument({documentId: result.document.id})).text, runtime.text);
  const history = JSON.parse(await readFile(path.join(dataDir, 'application-sessions.json'), 'utf8'));
  assert.equal(history.sessions[0].lastSavedDocument.id, result.document.id);
  assert.ok(!JSON.stringify(history).includes('Native source'));
  assert.ok(!JSON.stringify(workspace.status()).includes('Native source'));
});

test('saved text remains readable after ending and restarting with no launch or native operation', async t => {
  const {workspace, runtime, session, save, dataDir, onCleanup} = await fixture(t, {text: 'Saved across restart\r\n雪'});
  const saved = await save(); await workspace.end(session.id); await workspace.close();
  const replacement = new PrivateEditor('Never opened');
  const restarted = await new ApplicationWorkspace({dataDir, runtime: replacement, platform: 'win32', catalog}).init();
  onCleanup(() => restarted.close());
  const document = await restarted.readDocument({documentId: saved.document.id});
  assert.equal(document.text, 'Saved across restart\r\n雪');
  assert.equal(document.document.id, saved.document.id);
  assert.deepEqual(replacement.calls, []);
  assert.equal(restarted.status().sessions[0].state, 'closed');
  assert.equal(runtime.calls.filter(item => item.action === 'create').length, 1);
  await assert.rejects(restarted.readDocument({documentId: saved.document.id, path: '../outside'}), /documentId only/);
  await assert.rejects(restarted.perform({action: 'restore_document', sessionId: session.id, documentId: saved.document.id, expectedTextSha256: hash('Never opened')}), /running private editor/);
  assert.deepEqual(replacement.calls, []);
});

test('restore requires a valid reviewed editor hash and document identity before native observation', async t => {
  const {workspace, runtime, session, save} = await fixture(t);
  const saved = await save(); const before = runtime.calls.length;
  for (const expectedTextSha256 of [undefined, '', '0'.repeat(63), 'A'.repeat(64), 123]) await assert.rejects(workspace.perform({action: 'restore_document', sessionId: session.id, documentId: saved.document.id, expectedTextSha256}), /expectedTextSha256/);
  for (const documentId of ['../outside', 'C:\\private\\file', 'doc_12345678-1234-4234-8234-123456789012']) await assert.rejects(workspace.perform({action: 'restore_document', sessionId: session.id, documentId, expectedTextSha256: hash(runtime.text)}), /document ID|not found/);
  assert.equal(runtime.calls.length, before);
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
});

test('a changed editor rejects restore before saving recovery or mutating native text', async t => {
  const {runtime, documents, save, restore} = await fixture(t, {text: 'Saved target'});
  const saved = await save(); runtime.text = 'Human current draft';
  await assert.rejects(restore(saved.document.id, hash('Earlier reviewed draft')), {code: 'APPLICATION_TEXT_CONFLICT'});
  assert.equal(runtime.text, 'Human current draft');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(documents.status().count, 1);
});

test('recovery capacity failure blocks replacement and preserves target plus current editor', async t => {
  const {runtime, documents, workspace, session, save, restore} = await fixture(t, {text: 'Saved target', maxDocuments: 1});
  const saved = await save(); runtime.text = 'Unsaved work that must survive';
  await assert.rejects(restore(saved.document.id), {code: 'APPLICATION_DOCUMENT_CAPACITY'});
  assert.equal(runtime.text, 'Unsaved work that must survive');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(documents.status().count, 1);
  assert.equal((await documents.read(saved.document.id)).text, 'Saved target');
  assert.equal(workspace.status().sessions.find(item => item.id === session.id).lastRestore, undefined);
});

test('recovery snapshot and uncertain restore intent are on disk before exactly one native edit', async t => {
  const {runtime, workspace, documents, session, save, restore, dataDir} = await fixture(t, {text: 'Saved target\r\n雪'});
  const saved = await save(); const before = 'Current work\r\nkeep me'; runtime.text = before;
  let witnessed = 0;
  runtime.onPerform = async value => {
    if (value.action !== 'set_value') return;
    witnessed++;
    const history = JSON.parse(await readFile(path.join(dataDir, 'application-sessions.json'), 'utf8'));
    const intent = history.sessions.find(item => item.id === session.id).lastRestore;
    assert.equal(intent.state, 'uncertain'); assert.equal(intent.documentId, saved.document.id);
    assert.equal(intent.beforeSha256, hash(before)); assert.equal(intent.targetSha256, saved.document.sha256);
    const recovery = await documents.read(intent.recoveryDocumentId);
    assert.equal(recovery.text, before); assert.equal(recovery.sha256, hash(before));
    assert.equal(value.value, 'Saved target\r\n雪');
  };
  const result = await restore(saved.document.id);
  assert.equal(witnessed, 1); assert.equal(result.verified, true);
  assert.equal(result.editor.sha256, saved.document.sha256);
  assert.equal(runtime.text, 'Saved target\r\n雪');
  assert.equal((await documents.read(result.recoveryDocument.id)).text, before);
  assert.equal(workspace.status().sessions[0].lastRestore.state, 'verified');
  assert.equal(workspace.status().sessions[0].lastSavedDocument.id, saved.document.id);
});

test('failure to persist the restore intent leaves both versions intact and performs no edit', async t => {
  const {runtime, workspace, documents, save, restore, dataDir, onCleanup} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'Before failed intent write';
  const historyFile = path.join(dataDir, 'application-sessions.json'), retained = `${historyFile}.retained`;
  await rename(historyFile, retained); await mkdir(historyFile);
  try {await assert.rejects(restore(saved.document.id), {code: 'APPLICATION_HISTORY_FAILED'});}
  finally {await rm(historyFile, {recursive: true}); await rename(retained, historyFile);}
  assert.equal(runtime.text, 'Before failed intent write');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(documents.status().count, 2);
  const recovered = documents.list().find(item => item.id !== saved.document.id);
  assert.equal((await documents.read(recovered.id)).text, 'Before failed intent write');
  assert.match(workspace.status().reason, /history could not be saved/);
});

test('a human edit during the recovery write conflicts before replacing the editor', async t => {
  const {runtime, documents, save, restore} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'Reviewed current version';
  let reads = 0;
  runtime.onPerform = value => {
    if (value.action === 'get_text' && ++reads === 2) runtime.text = 'New human edit during disk write';
  };
  await assert.rejects(restore(saved.document.id), {code: 'APPLICATION_TEXT_CONFLICT'});
  assert.equal(runtime.text, 'New human edit during disk write');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(documents.status().count, 2, 'the reviewed previous version remains saved even after a conflict');
});

test('an uncertain native result is never retried or relaunched by the operation or restart', async t => {
  const {runtime, workspace, documents, save, restore, dataDir, onCleanup} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'Recovery content';
  runtime.onPerform = value => {
    if (value.action === 'set_value') {runtime.text = value.value; throw Error('Native response was lost after submission.');}
  };
  await assert.rejects(restore(saved.document.id), /Do not repeat the restore/);
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 1);
  assert.equal(workspace.status().sessions[0].lastRestore.state, 'uncertain');
  assert.equal(workspace.status().sessions[0].lastAction.status, 'uncertain');
  assert.equal(documents.status().count, 2);
  await workspace.close();
  const replacement = new PrivateEditor();
  const restarted = await new ApplicationWorkspace({dataDir, runtime: replacement, platform: 'win32', catalog}).init();
  onCleanup(() => restarted.close());
  assert.equal(restarted.status().sessions[0].state, 'interrupted');
  assert.equal(restarted.status().sessions[0].lastRestore.state, 'uncertain');
  assert.deepEqual(replacement.calls, []);
  assert.equal((await restarted.readDocument({documentId: saved.document.id})).text, 'Target');
  assert.deepEqual(replacement.calls, []);
});

test('a mismatched verification read keeps the restore uncertain and preserves its recovery version', async t => {
  const {runtime, workspace, documents, save, restore} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'Before';
  runtime.onPerform = value => {
    if (value.action === 'set_value') {runtime.text = 'Unexpected provider result'; return {text: 'Accepted'};}
  };
  await assert.rejects(restore(saved.document.id), {code: 'APPLICATION_RESTORE_UNVERIFIED'});
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 1);
  assert.equal(workspace.status().sessions[0].lastRestore.state, 'uncertain');
  const recovery = documents.list().find(item => item.id !== saved.document.id);
  assert.equal((await documents.read(recovery.id)).text, 'Before');
});

test('an unchanged restore reconciles only the matching uncertain receipt without another edit or replacing its recovery reference', async t => {
  const {runtime, workspace, documents, session, save, restore, dataDir} = await fixture(t, {text: 'Target A\r\n'});
  const targetA = await save('Version A'); runtime.text = 'Target B\r\n'; const targetB = await save('Version B');
  runtime.text = 'Recovery before the uncertain edit\r\n';
  runtime.onPerform = value => {
    if (value.action === 'set_value') {runtime.text = value.value; throw Error('The submitted edit lost its response.');}
  };
  await assert.rejects(restore(targetA.document.id), /Do not repeat the restore/);
  runtime.onPerform = null;
  const original = copied(workspace.status().sessions[0].lastRestore);
  assert.equal(original.state, 'uncertain'); assert.equal(runtime.text, 'Target A\r\n');
  const count = documents.status().count;

  runtime.text = 'Target B\r\n';
  const unrelated = await restore(targetB.document.id);
  assert.equal(unrelated.verified, true); assert.equal(unrelated.unchanged, true);
  assert.deepEqual(workspace.status().sessions[0].lastRestore, original, 'verifying another target cannot resolve the earlier uncertain edit');

  runtime.text = 'Target A\r\n';
  const wrongHash = {...original, targetSha256: hash('Different target bytes')};
  workspace.find(session.id).lastRestore = copied(wrongHash); await workspace.record(workspace.find(session.id));
  await restore(targetA.document.id);
  assert.deepEqual(workspace.status().sessions[0].lastRestore, wrongHash, 'the document ID alone cannot reconcile a different intended hash');

  workspace.find(session.id).lastRestore = copied(original); await workspace.record(workspace.find(session.id));
  const result = await restore(targetA.document.id);
  assert.equal(result.verified, true); assert.equal(result.unchanged, true); assert.equal(result.recoveryDocument, null);
  const reconciled = workspace.status().sessions[0].lastRestore;
  assert.deepEqual(reconciled, {...original, state: 'verified', verifiedAt: reconciled.verifiedAt, reconciled: true});
  assert.equal(reconciled.verifiedAt, new Date(reconciled.verifiedAt).toISOString());
  assert.equal(reconciled.id, original.id); assert.equal(reconciled.recoveryDocumentId, original.recoveryDocumentId);
  assert.equal((await documents.read(reconciled.recoveryDocumentId)).text, 'Recovery before the uncertain edit\r\n');
  assert.equal(documents.status().count, count, 'reconciliation creates no redundant snapshots');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 1, 'only the initial uncertain submission wrote native text');
  const history = JSON.parse(await readFile(path.join(dataDir, 'application-sessions.json'), 'utf8'));
  assert.deepEqual(history.sessions.find(item => item.id === session.id).lastRestore, reconciled);
});

test('restoring identical text is verified without creating a recovery snapshot or invoking native input', async t => {
  const {runtime, documents, save, restore} = await fixture(t, {text: 'Already the target\r\n'});
  const saved = await save(); const result = await restore(saved.document.id);
  assert.equal(result.verified, true); assert.equal(result.unchanged, true); assert.equal(result.recoveryDocument, null);
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(documents.status().count, 1);
});

test('full-length Unicode and CRLF text is saved and restored beyond inspection preview length', async t => {
  const target = '雪\r\n'.repeat(3333) + 'X'; assert.equal(target.length, 10000);
  const {runtime, documents, workspace, session, save, restore} = await fixture(t, {text: target});
  const saved = await save(); assert.equal(saved.document.characters, 10000);
  assert.equal((await documents.read(saved.document.id)).text, target);
  runtime.text = 'Current draft\r\n' + 'a'.repeat(9000);
  const inspected = await workspace.perform({action: 'inspect', sessionId: session.id});
  assert.equal(inspected.editorText, runtime.text); assert.equal(inspected.editorTextSha256, hash(runtime.text));
  const result = await restore(saved.document.id, inspected.editorTextSha256);
  assert.equal(result.verified, true); assert.equal(runtime.text, target);
  assert.equal(result.editor.sha256, hash(target));
  assert.equal((await documents.read(result.recoveryDocument.id)).text, inspected.editorText);
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 1);
});

test('an oversized current editor blocks save and restore before snapshots or input', async t => {
  const {runtime, documents, save, restore} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'x'.repeat(10001);
  await assert.rejects(save(), /10,000-character/);
  await assert.rejects(restore(saved.document.id), /10,000-character/);
  assert.equal(documents.status().count, 1);
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
});

test('corrupt saved targets are preserved and reject restoration before any native read or overwrite', async t => {
  const {runtime, save, restore, dataDir} = await fixture(t, {text: 'Target'});
  const saved = await save(); runtime.text = 'Current work';
  const filename = path.join(dataDir, 'application-documents', `${saved.document.id}.json`);
  const corrupted = JSON.parse(await readFile(filename, 'utf8')); corrupted.text = 'Tampered target';
  const bytes = JSON.stringify(corrupted); await writeFile(filename, bytes);
  const before = runtime.calls.length;
  await assert.rejects(restore(saved.document.id), {code: 'APPLICATION_DOCUMENT_CORRUPT'});
  assert.equal(runtime.calls.length, before); assert.equal(runtime.text, 'Current work');
  assert.equal(await readFile(filename, 'utf8'), bytes);
  assert.deepEqual(await readdir(path.dirname(filename)), [`${saved.document.id}.json`]);
});

test('cancelling before restore performs no native operation and leaves target available', async t => {
  const {runtime, workspace, session, save} = await fixture(t, {text: 'Target'});
  const saved = await save(); const controller = new AbortController(); controller.abort();
  const before = runtime.calls.length;
  await assert.rejects(workspace.perform({action: 'restore_document', sessionId: session.id, documentId: saved.document.id, expectedTextSha256: hash('Target')}, {signal: controller.signal}), /cancelled before/);
  assert.equal(runtime.calls.length, before);
  assert.equal((await workspace.readDocument({documentId: saved.document.id})).text, 'Target');
});

test('agent tool uses the same actual snapshots and finite saved-document fields as the workspace', async t => {
  const {workspace, runtime, session} = await fixture(t, {text: 'Tool-visible saved content\r\n'});
  const events = [], tool = createApplicationToolHandler({workspace, onEvent: event => events.push(event)});
  const invoke = value => tool({name: APPLICATION_TOOL.name, arguments: JSON.stringify(value)});
  const saved = await invoke({action: 'save_text', sessionId: session.id, title: 'Tool saved version'});
  assert.equal(saved.success, true); const receipt = JSON.parse(saved.contentItems[0].text);
  assert.equal(receipt.document.text, undefined); assert.equal(receipt.document.sha256, hash(runtime.text));
  const read = await invoke({action: 'read_document', documentId: receipt.document.id});
  assert.equal(read.success, true); assert.equal(JSON.parse(read.contentItems[0].text).text, runtime.text);
  const before = runtime.calls.length;
  for (const value of [{action: 'save_text', sessionId: session.id, text: 'Injected'}, {action: 'read_document', documentId: receipt.document.id, filename: '../outside'}, {action: 'restore_document', sessionId: session.id, documentId: receipt.document.id}]) {
    assert.equal((await invoke(value)).success, false);
  }
  assert.equal(runtime.calls.length, before);
  assert.ok(!JSON.stringify(events).includes('Tool-visible saved content'));
  assert.equal(runtime.calls.filter(item => item.action === 'create').length, 1);
});

test('optional control editor hash rejects a stale draft before native replacement', async t => {
  const {workspace, runtime, session} = await fixture(t, {text: 'Observed editor text'});
  const observed = await workspace.perform({action: 'inspect', sessionId: session.id});
  runtime.text = 'Human changed text after inspection';
  await assert.rejects(workspace.perform({action: 'control', sessionId: session.id, ref: EDITOR, operation: 'set_value', text: 'Stale replacement', expectedTextSha256: observed.editorTextSha256}), {code: 'APPLICATION_TEXT_CONFLICT'});
  assert.equal(runtime.text, 'Human changed text after inspection');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 0);
  assert.equal(workspace.status().sessions[0].lastAction.status, 'failed');
});

test('optional control hash admits a matching draft and rejects malformed hashes before runtime access', async t => {
  const {workspace, runtime, session} = await fixture(t, {text: 'Current text'});
  const observed = await workspace.perform({action: 'inspect', sessionId: session.id});
  const before = runtime.calls.length;
  await assert.rejects(workspace.perform({action: 'control', sessionId: session.id, ref: EDITOR, operation: 'set_value', text: 'Malformed hash replacement', expectedTextSha256: 'not-a-hash'}), /exact editor hash/);
  assert.equal(runtime.calls.length, before);
  await workspace.perform({action: 'control', sessionId: session.id, ref: EDITOR, operation: 'set_value', text: 'New reviewed draft\r\n', expectedTextSha256: observed.editorTextSha256});
  assert.equal(runtime.text, 'New reviewed draft\r\n');
  assert.equal(runtime.calls.filter(item => item.action === 'set_value').length, 1);
});

test('a real whole-profile backup verifies and restores saved application text with no app relaunch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-saved-profile-'));
  const profileDir = path.join(root, 'RelayProfile'), backupDir = path.join(root, 'saved.backup'), dataDir = path.join(profileDir, 'data');
  const runtimes = [], workspaces = [];
  t.after(async () => {
    for (const workspace of workspaces) await workspace.close().catch(() => {});
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, {recursive: true, force: true});
  });
  const runtime = new PrivateEditor('Preserved project note\r\n雪 🧊'); runtimes.push(runtime);
  const workspace = await new ApplicationWorkspace({dataDir, runtime, platform: 'win32', catalog}).init(); workspaces.push(workspace);
  const session = await workspace.create({appId: 'notepad-classic'});
  const saved = await workspace.perform({action: 'save_text', sessionId: session.id, title: 'Project note'});
  await workspace.close();
  const binding = {platform: 'win32', userIdHash: 'a'.repeat(64), machineIdHash: 'b'.repeat(64)};
  const options = {profileDir, backupDir, appVersion: '2.19.3', getBinding: async () => binding, reparseCheck: async () => {}, isProcessAlive: () => false};
  const backup = await createProfileBackup(options);
  const relative = `data/application-documents/${saved.document.id}.json`;
  const snapshotEntry = backup.manifest.entries.find(item => item.path === relative);
  assert.equal(snapshotEntry.type, 'file');
  const originalFile = await readFile(path.join(dataDir, 'application-documents', `${saved.document.id}.json`));
  assert.equal(snapshotEntry.sha256, createHash('sha256').update(originalFile).digest('hex'));
  const verified = await verifyProfileBackup(options); assert.equal(verified.manifestSha256, backup.manifestSha256);
  const additional = await new ApplicationDocumentStore({dataDir}).init();
  const newer = await additional.save({title: 'Later private work', source: saved.document.source, text: 'Retain in previous profile'}); await additional.close();
  const restored = await restoreProfileBackup(options); assert.equal(restored.restored, true);
  const replacement = new PrivateEditor(); runtimes.push(replacement);
  const reopened = await new ApplicationWorkspace({dataDir, runtime: replacement, platform: 'win32', catalog}).init(); workspaces.push(reopened);
  const read = await reopened.readDocument({documentId: saved.document.id});
  assert.equal(read.text, 'Preserved project note\r\n雪 🧊'); assert.equal(read.document.sha256, saved.document.sha256);
  assert.equal(reopened.status().documents.length, 1); assert.deepEqual(replacement.calls, []);
  const previous = await new ApplicationDocumentStore({dataDir: path.join(restored.previousProfileDir, 'data')}).init();
  try {assert.equal((await previous.read(newer.id)).text, 'Retain in previous profile');}
  finally {await previous.close();}
  assert.equal(runtimes.reduce((sum, item) => sum + item.calls.filter(call => call.action === 'create').length, 0), 1);
});
