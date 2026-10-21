import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApiClient } from '../public/api-client.mjs';
import { applicationSessionModel, applicationSessionFrame, applicationSessionDocument, applicationSavedText, applicationEditorVersion, applicationSessionDiagnostics } from '../public/application-session-model.mjs';
import { initApplicationSessionUI, renderApplicationSession } from '../public/application-session-ui.mjs';
import { initObserveUI } from '../public/observe-ui.mjs';

const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const session = (id, extra = {}) => ({ id, isolated: true, name: 'Private ' + id, appId: 'notepad', applicationName: 'Notepad', state: 'running', controlsAvailable: true, ...extra });
const status = (sessions = [session('one')], extra = {}) => ({ available: true, isolation: 'hidden-desktop', physicalInput: false, foregroundPolicy: 'isolated-desktop', acceptingActions: true, busy: false, supportedApps: [{ appId: 'notepad', name: 'Notepad', description: 'A supported text editor.' }], sessions, activeSessionId: sessions.at(-1)?.id, ...extra });
const frame = id => ({ sessionId: id, imageUrl, width: 900, height: 650 });
const observed = id => ({ sessionId: id, controls: [{ ref: 'edit:one', enabled: true, name: 'Document', role: 'Edit', writable: true }, { ref: 'save:one', enabled: true, name: 'Save', role: 'Button', invokable: true }], text: 'Actual isolated application text' });
const decode = value => String(value).replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const digest = text => createHash('sha256').update(text).digest('hex');
const savedMetadata = (id, text, extra = {}) => ({ id, title: 'Saved ' + id, source: { sessionId: 'one', appId: 'notepad', applicationName: 'Notepad' }, createdAt: '2026-10-18T12:00:00.000Z', sha256: digest(text), bytes: Buffer.byteLength(text), characters: text.length, ...extra });

function savedFixture(t, { initialText = 'Current editor text', savedText = 'Earlier saved text', initial, handle } = {}) {
  const documents = new Map([['saved-one', { ...savedMetadata('saved-one', savedText), text: savedText }]]); let actual = initialText, nextId = 1;
  const f = fixture(t, { initial: initial || status([session('one')], { documents: [...documents.values()], documentStorage: { healthy: true, maxDocuments: 100 } }), handle: async (call, data) => {
    const custom = await handle?.(call, data); if (custom !== undefined) return custom;
    const body = call.body;
    const save = (text, title) => { const id = 'saved-' + ++nextId, item = { ...savedMetadata(id, text, title ? { title } : {}), text }; documents.set(id, item); data.status.documents = [...documents.values()]; return item; };
    if (body?.action === 'inspect') return { ...observed(body.sessionId), text: actual, editor: { ref: 'edit:one', sha256: digest(actual), characters: actual.length, bytes: Buffer.byteLength(actual) } };
    if (body?.action === 'save_text') return { sessionId: body.sessionId, document: save(actual, body.title) };
    if (body?.action === 'read_document') return { document: documents.get(body.documentId) };
    if (body?.action === 'restore_document') { if (body.expectedTextSha256 !== digest(actual)) throw Error('The current editor changed. Compare again before restoring.'); const recoveryDocument = save(actual, 'Recovery text'); actual = documents.get(body.documentId).text; return { sessionId: body.sessionId, document: documents.get(body.documentId), recoveryDocument, verified: true }; }
    if (body?.action === 'control' && body.operation === 'set_value') { if (body.expectedTextSha256 && body.expectedTextSha256 !== digest(actual)) throw Error('The current editor changed. Your draft was not applied.'); actual = body.text; return observed(body.sessionId); }
  } });
  return { ...f, get html() { return f.html; }, get focused() { return f.focused; }, get actual() { return actual; }, setActual(value) { actual = value; }, documents };
}

function fixture(t, { initial = status(), handle } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), doc = { activeElement: null, body: {} }; globalThis.document = doc;
  const listeners = new Map(), calls = []; let html = '', nodes = [], clock = 0, visible = true;
  const mount = { isConnected: true, writes: 0, setAttribute() {}, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name), contains: node => node?.host === mount && node.isConnected, querySelector: selector => selector.startsWith('#') ? nodes.find(node => node.id === selector.slice(1)) : null, querySelectorAll: selector => selector === '[data-application-session]' ? nodes.filter(node => node.dataset.applicationSession) : [] };
  Object.defineProperty(mount, 'innerHTML', { get: () => html, set(value) {
    html = value; mount.writes++; for (const node of nodes) { node.isConnected = false; if (doc.activeElement === node) doc.activeElement = doc.body; } nodes = [];
    for (const [tag, kind] of value.matchAll(/<(input|select|textarea|button|details|img)\b[^>]*>/g)) {
      const attributes = attrs(tag), node = { ...attributes, tagName: kind.toUpperCase(), id: attributes.id || '', value: attributes.value || '', disabled: /\sdisabled(?:\s|>)/.test(tag), open: /\sopen(?:\s|>)/.test(tag), host: mount, isConnected: true, dataset: attributes['data-application-session'] ? { applicationSession: attributes['data-application-session'] } : {}, focus(options) { if (this.disabled) return; doc.activeElement = this; this.focusOptions = options; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, closest(selector) { return selector === '[data-application-session]' && this.dataset.applicationSession ? this : null; } };
      if (kind === 'select') { const body = new RegExp('<select\\b[^>]*id="' + node.id + '"[^>]*>([\\s\\S]*?)</select>').exec(value)?.[1] || '', options = [...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attributes, label]) => ({ value: attrs(attributes).value ?? decode(label), selected: /\bselected\b/.test(attributes) })); node.value = (options.find(option => option.selected) || options[0])?.value || ''; }
      if (kind === 'textarea') node.value = decode(new RegExp('<textarea\\b[^>]*id="' + node.id + '"[^>]*>([\\s\\S]*?)</textarea>').exec(value)?.[1] || '');
      nodes.push(node);
    }
  } });
  const data = { status: initial };
  const api = createApiClient({ timeoutMs: 2000, fetcher: async (route, options) => {
    assert.ok(['/api/application-sessions/status', '/api/application-sessions/action'].includes(route), 'only the isolated native application broker is called');
    const body = options.body ? JSON.parse(options.body) : undefined, call = { route, body, signal: options.signal }; calls.push(call);
    if (body) { assert.ok(['create', 'inspect', 'screenshot', 'control', 'close', 'save_text', 'read_document', 'restore_document'].includes(body.action)); assert.ok(!('executable' in body || 'command' in body || 'x' in body || 'key' in body || 'browser' in body)); }
    const custom = await handle?.(call, data); if (custom !== undefined) return Response.json(custom);
    if (route.endsWith('/status')) return Response.json(data.status);
    if (body.action === 'screenshot') return Response.json(frame(body.sessionId));
    if (body.action === 'create') { data.status.sessions.push(session('new')); data.status.activeSessionId = 'new'; return Response.json({ sessionId: 'new' }); }
    if (body.action === 'close') { data.status.sessions = data.status.sessions.filter(item => item.id !== body.sessionId); data.status.activeSessionId = data.status.sessions.at(-1)?.id; return Response.json({ closed: true }); }
    return Response.json(observed(body.sessionId));
  } });
  const ui = initApplicationSessionUI({ mount, api, isVisible: () => visible, now: () => clock });
  t.after(() => { ui.destroy(); if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  return { ui, mount, data, calls, element: id => mount.querySelector('#application-session-' + id), button: action => nodes.find(node => node.dataset.applicationSession === action), get html() { return html; }, get focused() { return doc.activeElement; }, advance(ms) { clock += ms; }, hide() { visible = false; }, show() { visible = true; }, async click(action) { const target = this.button(action); assert.ok(target, 'rendered action exists: ' + action); await listeners.get('click')({ target }); }, async change(id, value) { const target = this.element(id); target.value = value; await listeners.get('change')({ target }); }, async submit() { await listeners.get('submit')({ target: { id: 'application-session-create' }, preventDefault() {} }); } };
}

test('application inventory requires an explicit isolated-desktop broker and verified private sessions', () => {
  const input = status([session('one'), session('active-desktop', { isolated: false }), session('unknown', { isolated: undefined }), session('duplicate'), session('duplicate')]);
  const before = structuredClone(input), model = applicationSessionModel(input);
  assert.equal(model.available, true); assert.deepEqual(model.sessions.map(item => item.id), ['one']); assert.deepEqual(input, before);
  assert.equal(applicationSessionModel(status([], { physicalInput: true })).available, false);
  assert.equal(applicationSessionModel(status([], { foregroundPolicy: undefined })).available, false);
  assert.equal(applicationSessionModel(null).available, false);
  assert.equal(applicationSessionModel(input, 'active-desktop').selected, null);
  assert.equal(applicationSessionModel(status([], { recovery: { required: true, message: 'Inspect the original save.' } })).blocked, true);
});

test('frames and control receipts are bounded and belong to the exact private session', () => {
  assert.equal(applicationSessionFrame(frame('one'), 'two'), null);
  for (const value of [{ ...frame('one'), width: 0 }, { ...frame('one'), height: 10000 }, { ...frame('one'), imageUrl: 'https://elsewhere.test/fake.png' }, { ...frame('one'), imageUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }]) assert.equal(applicationSessionFrame(value, 'one'), null);
  assert.equal(applicationSessionFrame({ sessionId: 'one', image: { mimeType: 'image/png', data: imageUrl.split(',')[1], width: 900, height: 650 } }, 'one').width, 900);
  assert.equal(applicationSessionDocument(observed('one'), 'two'), null);
  const document = applicationSessionDocument({ sessionId: 'one', controls: [{ ref: 'duplicate', invokable: true }, { ref: 'duplicate', writable: true }, { ref: 'disabled', enabled: false }, { ref: 'valid', enabled: true, name: '<script>unsafe</script>', writable: true, value: 'never echo a stored value' }], text: 'x'.repeat(30000) }, 'one');
  assert.deepEqual(document.controls.map(item => item.ref), ['valid']); assert.equal(document.text.length, 24000); assert.ok(!JSON.stringify(document).includes('never echo'));
});

test('saved text inventory rejects ambiguous metadata and exact editor observations are versioned', () => {
  const metadata = savedMetadata('saved', 'hello');
  const model = applicationSessionModel(status([], { documents: [metadata, { ...metadata, id: 'bad', sha256: 'wrong' }, { ...metadata, id: 'duplicate' }, { ...metadata, id: 'duplicate' }] }));
  assert.deepEqual(model.documents.map(item => item.id), ['saved']);
  assert.equal(applicationSavedText({ document: { ...metadata, text: 'hello' } }, metadata).text, 'hello');
  assert.equal(applicationSavedText({ document: { ...metadata, text: 'shortened text' } }, metadata), null);
  assert.equal(applicationSavedText({ document: { ...metadata, sha256: digest('another'), text: 'hello' } }, metadata), null);
  const editor = { ...observed('one'), text: 'hello', editor: { ref: 'edit:one', sha256: digest('hello'), characters: 5, bytes: 5 } };
  assert.equal(applicationEditorVersion(editor, 'one').sha256, digest('hello')); assert.equal(applicationEditorVersion(editor, 'different'), null);
});

test('saving captures actual application text and preserves the unapplied draft and title focus', async t => {
  const f = savedFixture(t); await f.ui.enter(); f.element('text').value = 'Unapplied human draft'; const title = f.element('save-title'); title.value = 'A useful version'; title.focus(); title.selectionStart = 2; title.selectionEnd = 6;
  await f.click('save-text'); const call = f.calls.find(call => call.body?.action === 'save_text');
  assert.deepEqual(call.body, { action: 'save_text', sessionId: 'one', title: 'A useful version' });
  assert.equal(f.documents.get('saved-2').text, 'Current editor text'); assert.equal(f.element('text').value, 'Unapplied human draft'); assert.equal(f.focused.id, 'application-session-save-title'); assert.equal(f.focused.selectionStart, 2);
  assert.match(f.html, /Saved “A useful version” in BLACKICE/); assert.match(f.html, /does not save a Notepad file/);
});

test('saved versions can be read after restart without launching or requiring a Windows application runtime', async t => {
  const saved = savedMetadata('saved-one', 'Earlier saved text');
  const f = savedFixture(t, { initial: status([session('one', { state: 'interrupted', isolated: false })], { available: false, documents: [saved], documentStorage: { healthy: true, maxDocuments: 100 } }) });
  await f.ui.enter(); await f.change('saved', 'saved-one'); await f.click('read-saved');
  assert.match(f.html, /Earlier saved text/); assert.equal(f.button('restore-preview').disabled, true);
  assert.deepEqual(f.calls.map(call => call.body?.action || 'status'), ['status', 'status', 'read_document']);
});

test('restoring requires a fresh comparison and explicit confirmation, preserves the draft, and sends the observed hash', async t => {
  const f = savedFixture(t); await f.ui.enter(); f.element('text').value = 'Keep this draft'; await f.change('saved', 'saved-one'); await f.click('read-saved'); await f.click('restore-preview');
  assert.match(f.html, /Current editor · 19 characters/); assert.match(f.html, /Earlier saved text/); assert.equal(f.calls.filter(call => call.body?.action === 'restore_document').length, 0);
  const count = f.calls.length; f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.length, count, 'comparison pauses automatic observations');
  await f.click('restore-confirm'); assert.equal(f.actual, 'Earlier saved text'); assert.equal(f.documents.get('saved-2').text, 'Current editor text'); assert.equal(f.element('text').value, 'Keep this draft');
  assert.deepEqual(f.calls.find(call => call.body?.action === 'restore_document').body, { action: 'restore_document', sessionId: 'one', documentId: 'saved-one', expectedTextSha256: digest('Current editor text') }); assert.match(f.html, /restored and verified/);
});

test('a verified restore that already matches needs no recovery snapshot and reports no replacement', async t => {
  const f = savedFixture(t, { initialText: 'Earlier saved text', handle: call => call.body?.action === 'restore_document' ? { sessionId: 'one', document: savedMetadata('saved-one', 'Earlier saved text'), verified: true, unchanged: true, recoveryDocument: null } : undefined });
  await f.ui.enter(); await f.change('saved', 'saved-one'); await f.click('read-saved'); await f.click('restore-preview'); await f.click('restore-confirm');
  assert.match(f.html, /already matches the saved version/); assert.doesNotMatch(f.html, /action may have completed/); assert.equal(f.documents.size, 1);
});

test('cancelling restore changes no application text and a changed editor is never overwritten from stale comparison', async t => {
  const f = savedFixture(t); await f.ui.enter(); await f.change('saved', 'saved-one'); await f.click('read-saved'); await f.click('restore-preview'); const count = f.calls.length; await f.click('restore-cancel');
  assert.equal(f.calls.length, count); assert.equal(f.actual, 'Current editor text'); assert.equal(f.button('restore-confirm'), undefined);
  await f.click('restore-preview'); f.setActual('New agent edits'); await f.click('restore-confirm');
  assert.equal(f.actual, 'New agent edits'); assert.match(f.html, /current editor changed/); assert.equal(f.button('restore-confirm'), undefined); const attempts = f.calls.filter(call => call.body?.action === 'restore_document').length;
  f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.filter(call => call.body?.action === 'restore_document').length, attempts);
});

test('a changed saved version receipt is rejected and switching saved selection retires a restore confirmation', async t => {
  let tamper = true; const f = savedFixture(t, { handle: call => tamper && call.body?.action === 'read_document' ? { document: { ...savedMetadata('saved-one', 'Tampered'), text: 'Tampered' } } : undefined }); await f.ui.enter(); await f.change('saved', 'saved-one'); await f.click('read-saved');
  assert.match(f.html, /did not match its recorded version/); assert.equal(f.button('restore-preview'), undefined); tamper = false;
  await f.click('read-saved'); await f.click('restore-preview'); await f.change('saved', ''); assert.equal(f.button('restore-confirm'), undefined); assert.equal(f.calls.filter(call => call.body?.action === 'restore_document').length, 0);
});

test('an uncertain save pauses polling and never retries or launches an application', async t => {
  const f = savedFixture(t, { handle: call => { if (call.body?.action === 'save_text') throw Error('The saved version response was lost.'); } }); await f.ui.enter(); await f.click('save-text');
  assert.match(f.html, /action may have completed/); const count = f.calls.length; f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.length, count); assert.equal(f.calls.filter(call => call.body?.action === 'save_text').length, 1); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0);
});

test('a pending restore retired by hiding cannot replay or repopulate its confirmation', async t => {
  const gate = deferred(); const f = savedFixture(t, { handle: call => call.body?.action === 'restore_document' ? gate.promise : undefined }); await f.ui.enter(); await f.change('saved', 'saved-one'); await f.click('read-saved'); await f.click('restore-preview');
  const pending = f.click('restore-confirm'); await flush(); const count = f.calls.length; f.hide(); f.ui.update(); f.show(); f.ui.update(); assert.equal(f.calls.length, count); assert.equal(f.button('restore-confirm'), undefined);
  gate.resolve({ sessionId: 'one', document: savedMetadata('saved-one', 'Earlier saved text'), recoveryDocument: savedMetadata('recovery', 'Current editor text'), verified: true }); await pending;
  assert.equal(f.calls.length, count); assert.match(f.html, /view became hidden/);
});

test('ordinary editor changes preserve the original draft version across refresh and reveal concurrent edits on conflict', async t => {
  const f = savedFixture(t); await f.ui.enter(); f.element('text').value = 'Human draft'; f.setActual('Agent edits happened'); f.advance(5000); f.ui.update(); await flush();
  assert.equal(f.element('text').value, 'Human draft'); await f.click('set-value');
  assert.equal(f.calls.find(call => call.body?.action === 'control').body.expectedTextSha256, digest('Current editor text')); assert.equal(f.actual, 'Agent edits happened'); assert.equal(f.element('text').value, 'Human draft'); assert.match(f.html, /Agent edits happened/); assert.match(f.html, /draft was not applied/);
});

test('editing current text loads only the draft and replacing an unfinished draft requires inline confirmation', async t => {
  const f = savedFixture(t); await f.ui.enter(); const count = f.calls.length; await f.click('edit-current'); assert.equal(f.element('text').value, 'Current editor text'); assert.equal(f.calls.length, count);
  f.element('text').value = 'My unfinished draft'; f.setActual('Latest actual editor'); await f.click('inspect'); await f.click('edit-current');
  assert.equal(f.element('text').value, 'My unfinished draft'); assert.match(f.html, /Replace your unapplied draft/); await f.click('draft-replace-cancel'); assert.equal(f.element('text').value, 'My unfinished draft');
  await f.click('edit-current'); const before = f.calls.length; await f.click('draft-replace-confirm'); assert.equal(f.element('text').value, 'Latest actual editor'); assert.equal(f.calls.length, before, 'draft replacement sends no application input');
  f.element('text').value += ' merged'; await f.click('set-value'); const call = f.calls.find(call => call.body?.action === 'control'); assert.equal(call.body.expectedTextSha256, digest('Latest actual editor')); assert.equal(f.actual, 'Latest actual editor merged');
});

test('changing a draft during its replace confirmation preserves the newer draft', async t => {
  const f = savedFixture(t); await f.ui.enter(); f.element('text').value = 'First draft'; await f.click('edit-current'); f.element('text').value = 'Newer draft'; await f.click('draft-replace-confirm');
  assert.equal(f.element('text').value, 'Newer draft'); assert.match(f.html, /draft changed during confirmation/); assert.equal(f.calls.filter(call => call.body?.action === 'control').length, 0);
});

test('leaving Activity preserves the unapplied draft and saved title but retires comparison and observations', async t => {
  const f = savedFixture(t); await f.ui.enter(); f.element('text').value = 'Still working on this'; f.element('save-title').value = 'Pending version title'; await f.change('saved', 'saved-one'); await f.click('read-saved'); await f.click('restore-preview'); f.ui.leave(); await f.ui.enter();
  assert.equal(f.element('text').value, 'Still working on this'); assert.equal(f.element('save-title').value, 'Pending version title'); assert.equal(f.button('restore-confirm'), undefined); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0);
});

test('a late application edit receipt after Activity leave cannot erase its retained draft', async t => {
  const gate = deferred(); const f = savedFixture(t, { handle: call => call.body?.action === 'control' ? gate.promise : undefined }); await f.ui.enter(); f.element('text').value = 'Retain until verified';
  const pending = f.click('set-value'); await flush(); f.ui.leave(); gate.resolve(observed('one')); await pending; await f.ui.enter();
  assert.equal(f.element('text').value, 'Retain until verified'); assert.equal(f.calls.filter(call => call.body?.action === 'control').length, 1);
});

test('entering Observe reads actual sessions and frames without starting an application or opening a desktop', async t => {
  const f = fixture(t); await f.ui.enter();
  assert.match(f.html, /Captured isolated application window/); assert.match(f.html, /Actual isolated application text/); assert.match(f.html, /No desktop switching/);
  assert.deepEqual(f.calls.map(call => call.body?.action || 'status'), ['status', 'inspect', 'screenshot']); assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
  assert.equal(f.button('invoke').disabled, true); assert.equal(f.button('set-value').disabled, false);
});

test('reading an application with a window first selects its writable editor and preserves deliberate selection', async t => {
  const f = fixture(t, { handle: call => call.body?.action === 'inspect' ? { sessionId: 'one', controls: [{ ref: 'window:one', enabled: true, role: 'Window', name: 'Notepad' }, { ref: 'save:one', enabled: true, role: 'Button', name: 'Save', invokable: true }, { ref: 'edit:one', enabled: true, role: 'Edit', name: 'Document', writable: true }], text: 'Actual editor content' } : undefined }); await f.ui.enter();
  assert.equal(f.element('ref').value, 'edit:one'); assert.equal(f.button('set-value').disabled, false);
  await f.change('ref', 'save:one'); await f.click('inspect'); assert.equal(f.element('ref').value, 'save:one', 'a current explicit control selection survives new observations');
});

test('unsupported runtimes explain their limit and never attempt a launch', async t => {
  const f = fixture(t, { initial: status([], { available: false, reason: 'Private desktops are unavailable on this machine.' }) }); await f.ui.enter();
  assert.match(f.html, /Private desktops are unavailable/); assert.equal(f.calls.length, 1); await f.submit(); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0);
});

test('an unavailable compatibility entry explains why it is disabled and cannot launch', async t => {
  const f = fixture(t, { initial: status([], { supportedApps: [{ appId: 'notepad', name: 'Notepad', available: false, reason: 'This Windows version uses packaged Notepad.' }] }) }); await f.ui.enter();
  assert.match(f.html, /Notepad is unavailable/); assert.match(f.html, /uses packaged Notepad/); assert.match(f.html, /No compatible application is available/); assert.match(f.html, /<option value="notepad" disabled>/);
  await f.change('app', 'notepad'); await f.submit(); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0);
});

test('explicit creation uses only a catalog identity and a human session name', async t => {
  const f = fixture(t, { initial: status([]) }); await f.ui.enter(); await f.change('app', 'notepad'); f.element('name').value = 'Draft workspace'; await f.submit();
  assert.deepEqual(f.calls.find(call => call.body?.action === 'create').body, { action: 'create', appId: 'notepad', name: 'Draft workspace' }); assert.match(f.html, /Private new/); assert.match(f.html, /Captured isolated application window/);
  await f.change('app', 'C:\\Windows\\System32\\cmd.exe'); await f.submit(); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 1); assert.match(f.html, /current supported list/);
});

test('canonical public create records use id and terminal launch receipts remain readable without inspection', async t => {
  const f = fixture(t, { initial: status([]), handle: (call, data) => { if (call.body?.action === 'create') { data.status.sessions.push(session('canonical')); data.status.activeSessionId = 'canonical'; return session('canonical'); } } }); await f.ui.enter(); await f.change('app', 'notepad'); await f.submit();
  assert.match(f.html, /Private canonical/); assert.match(f.html, /Captured isolated application window/);
  f.data.status.sessions = [session('unverified-failure', { isolated: false, state: 'failed', reason: 'Private desktop verification failed.' })]; f.data.status.activeSessionId = null; await f.change('selected', ''); const count = f.calls.length;
  assert.match(f.html, /Private desktop verification failed/); assert.match(f.html, /Failed/); assert.equal(f.button('inspect').disabled, true); await f.click('inspect'); assert.equal(f.calls.length, count); assert.doesNotMatch(f.html, /Captured isolated application window/);
});

test('text editing accepts multiline content and rejects a value above the 10000 character broker limit', async t => {
  const f = fixture(t); await f.ui.enter(); assert.match(f.html, /<textarea[^>]*maxlength="10000"/); f.element('text').value = 'First line\nSecond line'; await f.click('set-value');
  assert.equal(f.calls.find(call => call.body?.action === 'control').body.text, 'First line\nSecond line');
  f.element('text').value = 'x'.repeat(10001); const count = f.calls.length; await f.click('set-value'); assert.equal(f.calls.length, count); assert.match(f.html, /at most 10,000 characters/); assert.equal(f.element('text').value.length, 10001);
});

test('a save operation uses a freshly observed stable ref and duplicates cannot enqueue', async t => {
  const gate = deferred(); const f = fixture(t, { handle: call => call.body?.action === 'control' ? gate.promise : undefined }); await f.ui.enter(); await f.change('ref', 'save:one');
  const pending = f.click('invoke'); await flush(); await f.click('invoke');
  assert.equal(f.calls.filter(call => call.body?.action === 'control').length, 1); assert.deepEqual(f.calls.find(call => call.body?.action === 'control').body, { action: 'control', sessionId: 'one', ref: 'save:one', operation: 'invoke' });
  assert.equal(f.calls.at(-2).body.action, 'inspect', 'the control is revalidated immediately before mutation'); gate.resolve(observed('one')); await pending;
});

test('a disappearing control is never invoked and setting a value clears only the submitted draft', async t => {
  let disappeared = false; const f = fixture(t, { handle: call => disappeared && call.body?.action === 'inspect' ? { sessionId: 'one', controls: [], text: 'The dialog closed.' } : undefined }); await f.ui.enter();
  f.element('text').value = 'Actual draft'; await f.click('set-value'); assert.deepEqual(f.calls.find(call => call.body?.action === 'control').body, { action: 'control', sessionId: 'one', ref: 'edit:one', operation: 'set_value', text: 'Actual draft' }); assert.equal(f.element('text').value, '');
  await f.change('ref', 'save:one'); disappeared = true; const before = f.calls.filter(call => call.body?.action === 'control').length; await f.click('invoke'); assert.equal(f.calls.filter(call => call.body?.action === 'control').length, before); assert.match(f.html, /control is no longer available/);
});

test('preview refresh is visible-only and preserves the new session name and keyboard focus', async t => {
  const gate = deferred(); let held = false; const f = fixture(t, { handle: call => held && call.route.endsWith('/status') ? gate.promise : undefined }); await f.ui.enter();
  const field = f.element('name'); field.value = 'An unfinished session name'; field.focus(); field.selectionStart = 3; field.selectionEnd = 7;
  held = true; f.advance(5000); f.ui.update(); f.ui.update(); assert.equal(f.calls.length, 4); assert.equal(f.focused.id, 'application-session-name'); assert.equal(f.focused.selectionStart, 3);
  f.element('name').value += ' edited'; gate.resolve(f.data.status); await flush(); assert.equal(f.element('name').value, 'An unfinished session name edited'); assert.equal(f.focused.id, 'application-session-name');
  f.hide(); const count = f.calls.length; f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.length, count);
});

test('leaving aborts requests and late responses cannot relaunch or repopulate a fresh entry', async t => {
  const gate = deferred(); let held = true; const f = fixture(t, { handle: call => held && call.route.endsWith('/status') ? gate.promise : undefined }); const pending = f.ui.enter(); await flush();
  f.ui.leave(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.html, ''); held = false; await f.ui.enter(); const count = f.calls.length, writes = f.mount.writes;
  gate.resolve(status([session('old-private-app')])); await pending; assert.equal(f.calls.length, count); assert.equal(f.mount.writes, writes); assert.doesNotMatch(f.html, /old-private-app/);
});

test('an accepted application action completing after leave cannot dispatch reads or captures', async t => {
  const gate = deferred(); const f = fixture(t, { handle: call => call.body?.action === 'control' ? gate.promise : undefined }); await f.ui.enter(); await f.change('ref', 'save:one'); const pending = f.click('invoke'); await flush();
  const count = f.calls.length; f.ui.leave(); gate.resolve(observed('one')); await pending; assert.equal(f.calls.length, count); assert.equal(f.html, '');
});

test('hiding the surface retires a preview request and a fresh visible refresh cannot be overwritten', async t => {
  const gate = deferred(); let held = false; const f = fixture(t, { handle: call => held && call.route.endsWith('/status') ? gate.promise : undefined }); await f.ui.enter();
  held = true; f.advance(5000); f.ui.update(); await flush(); const pending = f.calls.at(-1), count = f.calls.length;
  f.hide(); f.ui.update(); assert.equal(pending.signal.aborted, true); f.advance(20000); f.ui.update(); assert.equal(f.calls.length, count);
  held = false; f.show(); f.ui.update(); await flush(); assert.equal(f.calls.length, count + 3); const writes = f.mount.writes;
  gate.resolve(status([session('old-hidden-app')])); await flush(); assert.equal(f.mount.writes, writes); assert.doesNotMatch(f.html, /old-hidden-app/);
});

test('hiding a possible application submission pauses preview until explicit inspection', async t => {
  const gate = deferred(); const f = fixture(t, { handle: call => call.body?.action === 'control' ? gate.promise : undefined }); await f.ui.enter(); await f.change('ref', 'save:one');
  const pending = f.click('invoke'); await flush(); const count = f.calls.length; f.hide(); f.ui.update(); f.show(); f.ui.update();
  assert.equal(f.calls.length, count); assert.match(f.html, /view became hidden/); assert.match(f.html, /Resume preview/);
  gate.resolve(observed('one')); await pending; assert.equal(f.calls.length, count); assert.equal(f.button('invoke').disabled, true);
});

test('uncertain application input pauses preview and never replays a possible save', async t => {
  const f = fixture(t, { handle: call => { if (call.body?.action === 'control') throw Error('The save response was lost.'); } }); await f.ui.enter(); await f.change('ref', 'save:one'); await f.click('invoke');
  assert.match(f.html, /action may have completed/); assert.match(f.html, /Resume preview/); const count = f.calls.length; f.advance(20000); f.ui.update(); await flush(); assert.equal(f.calls.length, count);
  await f.click('watch'); assert.equal(f.calls.filter(call => call.body?.action === 'control').length, 1); assert.match(f.html, /Captured isolated application window/);
});

test('a session without a capturable window shows its actual reason and never fabricates a frame or relaunches', async t => {
  const f = fixture(t, { handle: call => call.body?.action === 'screenshot' ? { sessionId: 'one', reason: 'The application has no capturable window yet.' } : undefined }); await f.ui.enter();
  assert.match(f.html, /no capturable window yet/); assert.doesNotMatch(f.html, /<img/); assert.match(f.html, /No current application frame/); assert.equal(f.button('set-value').disabled, false, 'fresh observed controls remain usable when capture is unavailable'); f.advance(5000); f.ui.update(); await flush(); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0);
});

test('ending a private session preserves other sessions and never targets active-desktop applications', async t => {
  const f = fixture(t, { initial: status([session('one'), session('two'), session('outside', { isolated: false })]) }); await f.ui.enter(); await f.click('close-intent');
  assert.equal(f.calls.filter(call => call.body?.action === 'close').length, 0); assert.match(f.html, /Unsaved work in this isolated application will be discarded/); await f.click('close-confirm');
  assert.deepEqual(f.calls.find(call => call.body?.action === 'close').body, { action: 'close', sessionId: 'two' }); assert.deepEqual(f.data.status.sessions.map(item => item.id), ['one', 'outside']); assert.match(f.html, /Private one/);
});

test('ending a session can be cancelled inline without any native dialog or broker mutation', async t => {
  const f = fixture(t); await f.ui.enter(); const count = f.calls.length; await f.click('close-intent'); await f.click('close-cancel');
  assert.equal(f.calls.length, count); assert.doesNotMatch(f.html, /End session and discard unsaved work/); assert.ok(f.button('close-intent'));
});

test('application observations are escaped, and the frame cannot issue pointer or keyboard input', () => {
  const html = renderApplicationSession({ status: status([session('one', { name: '<script>bad</script>', output: '<svg onload=bad>' })]), frame: frame('one'), document: { controls: [{ ref: 'x" onclick="bad', name: '<img src=x onerror=bad>', invokable: true }], text: '<script>bad</script>' }, name: '" onfocus="bad', watching: true });
  assert.doesNotMatch(html, /<iframe|<script|<svg|<img src=x|onclick="bad|onfocus="bad|data-application-session="point"|Send key/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;svg/);
});

test('Observe mounts application sessions without a selected task and leaving cancels only its own preview', async t => {
  const elements = new Map(), basic = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, classList: { add() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, isConnected: true });
  const element = key => { if (!elements.has(key)) elements.set(key, basic()); return elements.get(key); }, mount = { ...basic(), hidden: false, querySelector: element, contains: () => false };
  const gate = deferred(), calls = [], ui = initObserveUI({ mount, getSnapshot: () => ({ runs: [], currentRun: null }), api: async (route, options) => { calls.push({ route, signal: options.signal }); return route === '/api/application-sessions/status' ? gate.promise : { available: false }; } }); t.after(() => ui.destroy());
  ui.enter(); await flush(); await ui.selectSurface('applications'); await flush(); assert.equal(element('#observe-content').hidden, true); assert.match(element('#observe-application-sessions').innerHTML, /Application sessions/); assert.match(mount.innerHTML, /id="observe-application-sessions"/);
  const native = calls.find(call => call.route === '/api/application-sessions/status'); assert.ok(native); ui.leave(); assert.equal(native.signal.aborted, true); assert.equal(element('#observe-application-sessions').innerHTML, '');
  gate.resolve(status([session('late-private-app')])); await flush(); assert.equal(element('#observe-application-sessions').innerHTML, ''); assert.equal(calls.length, 2); assert.ok(!calls.some(call => call.route.endsWith('/action')));
});


const diagnosticStatus = (extra = {}) => ({
  version: 1, phase: 'waiting-for-window', jobTotalProcesses: 2, jobActiveProcesses: 0,
  visibleOwnedWindows: 0, closed: true, allObservedProcessesExited: true,
  diagnosticsIncomplete: false, processListTruncated: false, windowsTruncated: false,
  processes: [{ pid: 9101, state: 'exited', exitCode: 0 }, { pid: 9102, state: 'exited', exitCode: 81 }], ...extra,
});

test('compatibility evidence is escaped and stays separate from application choices and launch admission', async t => {
  const compatibility = { testedAt: '<date>', system: '<system>', note: 'Only the available-app list can be launched. <note>', apps: [
    { id: 'observed-editor', name: '<img src=x onerror=alert(1)>', version: '<version>', result: 'verified', detail: '<script>privateCompat()</script>' },
    { id: 'blocked-editor', name: 'Blocked editor', result: 'blocked', detail: 'No owned window.' },
    { id: 'console-editor', name: 'Console editor', result: 'not_admitted', detail: 'GUI-only admission declined it.' },
  ] };
  const f = fixture(t, { initial: status([], { compatibility }) }); await f.ui.enter();
  assert.match(f.html, /Application compatibility · 3 checked/); assert.match(f.html, /Verified controls/); assert.match(f.html, /Startup blocked/); assert.match(f.html, /Not admitted/);
  assert.match(f.html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(f.html, /&lt;script&gt;privateCompat\(\)&lt;\/script&gt;/); assert.match(f.html, /&lt;system&gt;/); assert.match(f.html, /&lt;note&gt;/);
  assert.doesNotMatch(f.html, /<script>|<img src=x|<option value="(?:observed-editor|blocked-editor|console-editor)"/);
  assert.deepEqual(applicationSessionModel(f.data.status).supportedApps.map(app => app.appId), ['notepad']);
  await f.change('app', 'observed-editor'); await f.submit(); assert.equal(f.calls.filter(call => call.body?.action === 'create').length, 0); assert.match(f.html, /current supported list/);
});

test('cleanup summaries require complete observed exit evidence and omit private process details', () => {
  const source = diagnosticStatus({ jobTotalProcesses: 3, executable: 'PRIVATE EXECUTABLE', processes: [{ pid: 9101, state: 'exited', exitCode: 0, name: 'PRIVATE PROCESS' }, { pid: 9102, state: 'exited', exitCode: 81, windowTitle: 'PRIVATE WINDOW' }, { pid: 9103, state: 'exited', exitCode: 81 }] });
  const model = applicationSessionDiagnostics(source); assert.equal(model.cleanupConfirmed, true); assert.equal(model.processes, 3); assert.equal(model.windows, 0); assert.deepEqual(model.exitCodes, [0, 81]);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE|9101|9102|9103/);
  for (const patch of [{ closed: false }, { allObservedProcessesExited: false }, { jobActiveProcesses: 1 }, { jobActiveProcesses: -1 }, { jobActiveProcesses: undefined }, { diagnosticsIncomplete: true }, { processListTruncated: true }, { windowsTruncated: true }]) assert.equal(applicationSessionDiagnostics({ ...source, ...patch }).cleanupConfirmed, false, JSON.stringify(patch));
  assert.equal(applicationSessionDiagnostics({ version: 2 }), null);
  assert.equal(applicationSessionDiagnostics(diagnosticStatus({ jobTotalProcesses: -1 })).processes, null);
});

test('failed session diagnostics render escaped failure history without frames, actions or unsupported cleanup claims', async t => {
  const failed = session('failed', { state: 'failed', isolated: false, reason: '<img src=x onerror=bad()>', diagnostics: diagnosticStatus({ commandLine: 'PRIVATE COMMAND', processes: [{ pid: 9101, state: 'exited', exitCode: 81, executable: 'PRIVATE PATH' }] }) });
  const f = fixture(t, { initial: status([failed]) }); await f.ui.enter();
  assert.deepEqual(f.calls.map(call => call.body?.action || 'status'), ['status']); assert.match(f.html, /Startup &amp; cleanup details/);
  assert.match(f.html, /Owned processes stopped/); assert.match(f.html, /Observed exit codes<\/dt><dd>81/); assert.match(f.html, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(f.html, /PRIVATE COMMAND|PRIVATE PATH|<img src=x|Captured isolated application window/); assert.equal(f.button('inspect').disabled, true);
  await f.click('inspect'); assert.equal(f.calls.length, 1);
  for (const patch of [{ diagnosticsIncomplete: true }, { processListTruncated: true }, { windowsTruncated: true }]) {
    f.data.status.sessions[0].diagnostics = diagnosticStatus(patch); await f.change('selected', '');
    assert.match(f.html, /Session closed; complete cleanup evidence is unavailable/); assert.match(f.html, /Some startup diagnostics are incomplete/); assert.doesNotMatch(f.html, /Owned processes stopped/);
  }
  assert.equal(f.calls.filter(call => call.body).length, 0);
});
