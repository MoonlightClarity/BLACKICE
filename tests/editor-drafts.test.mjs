import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, draftKey } from '../public/draft-store.mjs';
import { initIdentityUI } from '../public/identity-ui.mjs';
import { initInboxUI, inboxItemPresentation } from '../public/inbox-ui.mjs';

class Storage {
  values = new Map(); get length() { return this.values.size; } key(index) { return [...this.values.keys()][index]; }
  getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, value); } removeItem(key) { this.values.delete(key); }
}
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function editorDocument() {
  const elements = new Map(), listeners = new Map(), injected = new Set(); let modal = null, html = '';
  const document = {
    activeElement: { id: '', closest: () => null },
    addEventListener(type, callback) { const group = listeners.get(type) || []; group.push(callback); listeners.set(type, group); },
    querySelector(selector) {
      if (selector === '#modal-root .modal') return modal ? element(selector) : null;
      if (!modal) return null;
      if (selector === '#identity-view') return modal === 'identity' ? element(selector) : null;
      if (selector === '#inbox-view') return modal === 'inbox' ? element(selector) : null;
      if (selector === '#identity-draft-notice' || selector === '#inbox-draft-notice') return injected.has(selector) ? element(selector) : null;
      const id = /^#([\w-]+)/.exec(selector)?.[1]; if (id && !html.includes(`id="${id}"`)) return null;
      if (selector === '.inbox-list' || selector === '.inbox-detail') return html.includes(selector.slice(1)) ? element(selector) : null;
      return element(selector);
    },
    async emit(type, target, extra = {}) { const event = { target, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; for (const callback of listeners.get(type) || []) await callback(event); return event; },
    input(id, value) { return this.emit('input', { id, value }); },
    click(attribute, action, extra = {}) { const button = { dataset: { [attribute]: action, ...extra } }; return this.emit('click', { closest: () => button }); },
    show(type) { modal = type; html = ''; injected.clear(); }, close() { modal = null; },
    get html() { return html; },
  };
  function element(selector) {
    if (!elements.has(selector)) {
      let ownHtml = '';
      elements.set(selector, {
        id: selector.replace(/^#/, ''), dataset: {}, disabled: false, hidden: false, classList: { add() {}, remove() {} }, scrollTop: 0,
        get innerHTML() { return ownHtml; }, set innerHTML(value) { ownHtml = value; if (['#identity-view', '#inbox-view'].includes(selector)) { html = value; injected.clear(); } },
        closest: () => element('.identity-save-row'),
        insertAdjacentHTML(_position, value) { for (const match of value.matchAll(/id="([^"]+)"/g)) injected.add('#' + match[1]); },
        focus() { document.activeElement = this; }, setSelectionRange() {},
        requestSubmit() { return document.emit('submit', { id: selector.replace(/^#/, '') }); },
      });
    }
    return elements.get(selector);
  }
  return document;
}
function environment(t) {
  const previous = globalThis.document, controllers = []; let current;
  t.after(() => { for (const controller of controllers) controller.close(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { controllers, document() { current = editorDocument(); globalThis.document = current; return current; }, options(document) { return { showModal: type => document.show(type), closeModal: () => document.close(), toast() {}, escape, icon: () => '<svg></svg>' }; } };
}
const doc = (kind = 'soul', revision = 1, content = 'Saved document') => ({ kind, revision, content, path: `C:/fixture/identity/${kind}.md`, hash: String(revision).repeat(64), diskHash: String(revision).repeat(64), provenance: { source: 'user' }, updatedAt: '2026-01-01T00:00:00Z' });
const snapshot = items => ({ items, status: { pending: items.filter(item => item.status === 'queued').length, active: 0, completed: 0, autoRun: false, paused: true }, settings: { pauseOnFailure: true } });
const task = (revision = 1) => ({ id: 'task-one', revision, title: 'Original task', input: 'Original instructions', cwd: 'C:/work/project', status: 'queued', attachmentIds: [], attempts: [], workflow: { nodes: [{ type: 'agent', model: 'default' }] } });

test('editor draft cache survives recreation, strips credential fields and conditionally clears only the saved payload', () => {
  const storage = new Storage(), store = createDraftStore({ storage }), key = draftKey('identity', 'soul', 'C:/fixture/soul.md');
  store.save(key, { content: 'Unfinished writing', base: { revision: 1, hash: 'base' }, apiKey: 'NEVER_STORE', workflow: { headers: { authorization: 'NEVER_STORE' }, accessToken: 'NEVER_STORE' } });
  assert.doesNotMatch([...storage.values.values()].join(''), /NEVER_STORE/);
  const restored = createDraftStore({ storage }); assert.equal(restored.load(key).data.content, 'Unfinished writing');
  const old = restored.load(key).data; restored.save(key, { ...old, content: 'Newer text' });
  assert.equal(restored.remove(key, { expected: old }).removed, false); assert.equal(restored.load(key).data.content, 'Newer text');
  const current = restored.load(key).data; restored.remove(key, { expected: current }); assert.equal(createDraftStore({ storage }).load(key), null);
});

test('unavailable or full storage keeps a readable window draft without throwing or losing its base', () => {
  const store = createDraftStore({ storage: { getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('disabled'); } } });
  const result = store.save('fixture', { content: 'Do not lose this', base: { revision: 4, hash: 'saved-base' } });
  assert.equal(result.persistent, false); assert.match(result.error, /this window only/); assert.equal(store.load('fixture').data.base.revision, 4);
});

test('draft cleanup requires a known matching payload, including across windows', () => {
  const storage = new Storage(), writer = createDraftStore({ storage }), otherWindow = createDraftStore({ storage });
  writer.save('shared', { content: 'Another window owns this draft' });
  for (const options of [undefined, {}, { expected: undefined }, { expected: null }]) assert.equal(otherWindow.remove('shared', options).removed, false);
  assert.equal(createDraftStore({ storage }).load('shared').data.content, 'Another window owns this draft');
  const owned = otherWindow.load('shared').data;
  writer.save('shared', { content: 'A newer draft from the other window' });
  assert.equal(otherWindow.remove('shared', { expected: owned }).removed, false);
  assert.equal(createDraftStore({ storage }).load('shared').data.content, 'A newer draft from the other window');
});

test('oversized drafts remain readable and removable in their window while disk records stay bounded', () => {
  const storage = new Storage(), store = createDraftStore({ storage, maxChars: 160 }), value = { content: 'Large draft '.repeat(40), base: { revision: 3, hash: 'base' } };
  const result = store.save('large', value);
  assert.equal(result.saved, true); assert.equal(result.persistent, false); assert.equal(storage.length, 0);
  assert.deepEqual(store.load('large').data, value); assert.deepEqual(store.list().map(entry => entry.data), [value]);
  result.data.content = 'A changed return value'; assert.deepEqual(store.load('large').data, value);
  storage.setItem('relay.editor-draft.v1:oversized-disk-record', JSON.stringify({ version: 1, savedAt: '2026-01-01T00:00:00Z', data: value }));
  const restarted = createDraftStore({ storage, maxChars: 160 });
  assert.equal(restarted.load('oversized-disk-record'), null); assert.deepEqual(restarted.list(), []);
  assert.equal(store.remove('large', { expected: { ...value, content: 'Wrong payload' } }).removed, false);
  assert.deepEqual(store.load('large').data, value);
  assert.equal(store.remove('large', { expected: value }).removed, true); assert.equal(store.load('large'), null);
});

test('unchanged identity cleanup preserves drafts owned by another window', async t => {
  const environment_ = environment(t), storage = new Storage(), document = environment_.document(), current = doc();
  const api = async () => ({ documents: { soul: current, user: doc('user') } });
  const controller = initIdentityUI({ ...environment_.options(document), api, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open();
  const key = draftKey('identity', 'soul', current.path), otherWindow = createDraftStore({ storage });
  otherWindow.save(key, { content: 'An unsent draft in another window', base: { revision: 1, hash: current.hash } });
  otherWindow.save(key + ':previous', { content: 'Previous draft owned by another window' });
  await document.input('identity-content', current.content); await document.click('identityAction', 'discard-draft');
  const persisted = createDraftStore({ storage });
  assert.equal(persisted.load(key).data.content, 'An unsent draft in another window');
  assert.equal(persisted.load(key + ':previous').data.content, 'Previous draft owned by another window');
});

for (const action of ['recover-draft', 'discard-draft']) test(`identity ${action} clears only its original previous-draft payload`, async t => {
  const environment_ = environment(t), storage = new Storage(), document = environment_.document(), current = doc(), key = draftKey('identity', 'soul', current.path) + ':previous';
  const otherWindow = createDraftStore({ storage }); otherWindow.save(key, { content: 'Original previous draft' });
  const api = async () => ({ documents: { soul: current, user: doc('user') } });
  const controller = initIdentityUI({ ...environment_.options(document), api, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open();
  otherWindow.save(key, { content: 'Newer previous draft from another window' });
  await document.click('identityAction', action);
  assert.equal(createDraftStore({ storage }).load(key).data.content, 'Newer previous draft from another window');
});

test('identity drafts restore after a restart and cannot silently overwrite a newer file', async t => {
  const environment_ = environment(t), storage = new Storage(); let current = doc(), writes = [];
  const api = async (_path, method = 'GET', body) => { if (method === 'PUT') { writes.push(body); current = doc('soul', current.revision + 1, body.content); return current; } return { documents: { soul: current, user: doc('user') } }; };
  let document = environment_.document(), controller = initIdentityUI({ ...environment_.options(document), api, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller);
  await controller.open(); await document.input('identity-content', 'Unfinished profile wording'); controller.close();
  current = doc('soul', 2, 'A newer saved document');
  document = environment_.document(); controller = initIdentityUI({ ...environment_.options(document), api, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller);
  await controller.open(); assert.match(document.html, /Unfinished profile wording/); assert.match(document.html, /newer disk version/);
  assert.match(document.querySelector('#identity-draft-notice').innerHTML, /Draft restored/);
  await document.emit('submit', { id: 'identity-editor' }); assert.equal(writes.length, 0);
  await document.click('identityAction', 'keep-draft'); await document.emit('submit', { id: 'identity-editor' });
  assert.equal(writes.length, 1); assert.equal(writes[0].expectedRevision, 2); assert.equal(writes[0].expectedHash, '2'.repeat(64));
  assert.equal(createDraftStore({ storage }).list(draftKey('identity') + ':').length, 0);
});

test('failed identity saves retain the draft; typing during a successful save preserves newer text and rebases it', async t => {
  const environment_ = environment(t), storage = new Storage(), document = environment_.document(); let current = doc(), fail = true, complete;
  const api = async (_path, method = 'GET', body) => {
    if (method === 'PUT') { if (fail) throw Error('Temporary save failure'); await new Promise(resolve => { complete = resolve; }); current = doc('soul', 2, body.content); return current; }
    return { documents: { soul: current, user: doc('user') } };
  };
  const controller = initIdentityUI({ ...environment_.options(document), api, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open();
  await document.input('identity-content', 'First draft'); await document.emit('submit', { id: 'identity-editor' });
  assert.equal(createDraftStore({ storage }).list()[0].data.content, 'First draft'); fail = false;
  const saving = document.emit('submit', { id: 'identity-editor' }); await Promise.resolve(); await document.input('identity-content', 'Newer draft while saving'); complete(); await saving;
  const saved = createDraftStore({ storage }).list()[0].data; assert.equal(saved.content, 'Newer draft while saving'); assert.equal(saved.base.revision, 2);
  await document.click('identityAction', 'discard-draft'); assert.equal(createDraftStore({ storage }).list().length, 0);
});

test('new Inbox captures retain their original snapshot, restore only in their workspace and clear after a successful save', async t => {
  const environment_ = environment(t), storage = new Storage(), original = { title: 'Captured original', input: 'Captured instructions', cwd: 'C:/work/project', attachmentIds: ['actual-file'], workflow: { nodes: [{ model: 'compatible/model', apiKey: 'DO_NOT_CACHE' }] } }, untouched = structuredClone(original); let items = [], saves = 0, cwd = original.cwd;
  const api = async (_path, method = 'GET', body) => { if (method === 'POST') { saves++; const item = { ...task(), ...body }; items.push(item); return item; } return snapshot(items); };
  let document = environment_.document(), controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller);
  await controller.open({ draft: original }); await document.input('inbox-input', 'Edited captured draft'); assert.deepEqual(original, untouched); assert.doesNotMatch([...storage.values.values()].join(''), /DO_NOT_CACHE/); controller.close();
  cwd = 'C:/work/other'; document = environment_.document(); controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); assert.doesNotMatch(document.html, /Edited captured draft/); controller.close();
  cwd = original.cwd; document = environment_.document(); controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open();
  assert.match(document.html, /Edited captured draft/); assert.match(document.querySelector('#inbox-draft-notice').innerHTML, /Draft restored/);
  await document.emit('submit', { id: 'inbox-editor' }); assert.equal(saves, 1); assert.equal(createDraftStore({ storage }).list().length, 0);
});

test('restored Inbox edits use their original base revision until the user resolves a newer saved task', async t => {
  const environment_ = environment(t), storage = new Storage(); let item = task(), writes = [];
  const api = async (_path, method = 'GET', body) => { if (method === 'PUT') { writes.push(body); item = { ...item, ...body, revision: item.revision + 1 }; return item; } return snapshot([item]); };
  let document = environment_.document(), controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); await document.click('inbox', 'edit'); await document.input('inbox-input', 'Unsaved task edits'); controller.close();
  item = { ...task(2), input: 'Newer task instructions' };
  document = environment_.document(); controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open();
  assert.match(document.html, /Unsaved task edits/); assert.match(document.querySelector('#inbox-draft-notice').innerHTML, /saved task changed/);
  await document.emit('submit', { id: 'inbox-editor' }); assert.equal(writes.length, 0);
  await document.click('inbox', 'keep-draft'); await document.emit('submit', { id: 'inbox-editor' }); assert.equal(writes[0].expectedRevision, 2); assert.equal(writes[0].input, 'Unsaved task edits'); assert.equal(createDraftStore({ storage }).list().length, 0);
});

test('deleted Inbox item drafts are removed, and editor save shortcuts never leak into workflow commands', async t => {
  const environment_ = environment(t), storage = new Storage(); let item = task();
  const api = async () => snapshot([item]);
  let document = environment_.document(), controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); await document.click('inbox', 'edit'); await document.input('inbox-input', 'Must not resurrect a deleted task'); controller.close(); item = { ...item, status: 'deleted' };
  document = environment_.document(); controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); assert.equal(createDraftStore({ storage }).list().length, 0); assert.doesNotMatch(document.html, /Must not resurrect/);
  await document.click('inbox', 'new'); await document.input('inbox-input', 'A new unsaved task');
  const form = document.querySelector('#inbox-editor'); let submissions = 0; form.requestSubmit = () => { submissions++; };
  for (const key of ['s', 'Enter']) { const event = await document.emit('keydown', { id: 'inbox-input' }, { ctrlKey: true, key }); assert.equal(event.prevented, true); assert.equal(event.stopped, true); }
  assert.equal(submissions, 2); await document.click('inbox', 'discard-draft'); assert.equal(createDraftStore({ storage }).list().length, 0);
});

test('Inbox labels keep passive saves outside the actual queue order, including managed operation jobs', () => {
  const saved = { ...task(), id: 'saved' }, queued = { ...task(), id: 'queued', startWhenIdle: true }, managed = { ...task(), id: 'managed', managedBy: 'operations' }, next = { ...queued, id: 'next' }, items = [saved, managed, queued, next];
  assert.deepEqual(inboxItemPresentation(saved, {}, items), { label: 'Saved', detail: 'Start when you choose', scheduled: false, position: null });
  assert.equal(inboxItemPresentation(queued, {}, items).position, 1); assert.equal(inboxItemPresentation(next, {}, items).position, 2); assert.equal(inboxItemPresentation(managed, { autoRun: true }, items).scheduled, false);
  assert.equal(inboxItemPresentation(queued, { paused: true }, items).label, 'Paused'); assert.equal(inboxItemPresentation(queued, { autoRun: true }, items).position, 2);
});

test('Inbox exposes queued starts without turning on Run all saved tasks and explicitly pauses before editing', async t => {
  const environment_ = environment(t), storage = new Storage(), document = environment_.document(), saved = { ...task(), id: 'saved', title: 'Passive saved task' }; let queued = { ...task(), id: 'queued', title: 'Explicit queued task', startWhenIdle: true }, paused = false, calls = [];
  const data = () => ({ ...snapshot([saved, queued]), status: { ...snapshot([saved, queued]).status, paused, scheduled: 1 } });
  const api = async (route, method = 'GET', body) => { if (method !== 'GET') calls.push({ route, method, body }); if (route === '/api/inbox/pause') { paused = true; return data().status; } if (method === 'PUT') { queued = { ...queued, ...body, revision: queued.revision + 1 }; return queued; } return data(); };
  const controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => queued.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open({ selectedId: queued.id });
  assert.match(document.html, /1 queued to run/); assert.match(document.html, /Pause queue/); assert.match(document.html, /Pause & edit/); assert.doesNotMatch(document.html, /id="inbox-auto" checked/); assert.match(document.html, /Saved · Start when you choose/); assert.match(document.html, /Queued · 1 in run order/);
  await document.click('inbox', 'edit'); assert.equal(calls[0].route, '/api/inbox/pause'); assert.equal(paused, true); assert.match(document.html, /id="inbox-editor"/); await document.input('inbox-input', 'Updated queued instructions'); await document.emit('submit', { id: 'inbox-editor' }); assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].body.expectedRevision, 1); assert.equal(queued.input, 'Updated queued instructions'); assert.equal(queued.startWhenIdle, true); assert.equal(paused, true, 'saving does not silently resume the queue');
});

test('Inbox does not edit a queued task that wins admission just before Pause & edit reaches the server', async t => {
  const environment_ = environment(t), document = environment_.document(), messages = []; let item = { ...task(), startWhenIdle: true }, paused = false;
  const data = () => ({ ...snapshot([item]), status: { ...snapshot([item]).status, paused, scheduled: item.status === 'queued' ? 1 : 0 } });
  const api = async route => { if (route === '/api/inbox/pause') { paused = true; item = { ...item, status: 'running', revision: 2 }; return data().status; } return data(); };
  const controller = initInboxUI({ ...environment_.options(document), api, toast: message => messages.push(message), draftStore: createDraftStore({ storage: new Storage() }) }); environment_.controllers.push(controller); await controller.open(); await document.click('inbox', 'edit'); assert.doesNotMatch(document.html, /id="inbox-editor"/); assert.match(messages.at(-1), /started or changed/); assert.match(document.html, /Working/);
});

test('Inbox opens a completed requested task in History and reports failed chat navigation', async t => {
  const environment_ = environment(t), document = environment_.document(), pending = { ...task(), id: 'pending', title: 'Unrelated pending task' }, finished = { ...task(), id: 'finished', title: 'Requested completed task', status: 'completed', runId: 'actual-run' }, opened = [], messages = [];
  const controller = initInboxUI({ ...environment_.options(document), api: async () => snapshot([pending, finished]), toast: message => messages.push(message), onOpenRun: async id => { opened.push(id); throw Error('Fixture unavailable'); }, draftStore: createDraftStore({ storage: new Storage() }) }); environment_.controllers.push(controller); await controller.open({ selectedId: finished.id });
  assert.match(document.html, /aria-selected="true" data-inbox="tab" data-tab="history"/); assert.match(document.html, /<h3>Requested completed task<\/h3>/); assert.match(document.html, /data-run-id="actual-run">Open chat/); await document.click('inbox', 'open-run', { runId: finished.runId }); assert.deepEqual(opened, ['actual-run']); assert.match(messages.at(-1), /chat could not open/);
});

test('a restored armed Inbox edit cannot save while the queue was resumed in another window', async t => {
  const environment_ = environment(t), storage = new Storage(); let item = { ...task(), startWhenIdle: true }, paused = true, writes = 0;
  const data = () => ({ ...snapshot([item]), status: { ...snapshot([item]).status, paused, scheduled: 1 } });
  const api = async (route, method = 'GET', body) => { if (route === '/api/inbox/pause') { paused = true; return data().status; } if (method === 'PUT') { writes++; item = { ...item, ...body, revision: item.revision + 1 }; return item; } return data(); };
  let document = environment_.document(), controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); await document.click('inbox', 'edit'); await document.input('inbox-input', 'Restored queue edit'); controller.close(); paused = false;
  document = environment_.document(); controller = initInboxUI({ ...environment_.options(document), api, getCwd: () => item.cwd, draftStore: createDraftStore({ storage }) }); environment_.controllers.push(controller); await controller.open(); assert.equal(document.querySelector('#inbox-editor button[type="submit"]').disabled, true); await document.emit('submit', { id: 'inbox-editor' }); assert.equal(writes, 0); assert.equal(createDraftStore({ storage }).list().length, 1);
  await document.click('inbox', 'pause'); await document.emit('submit', { id: 'inbox-editor' }); assert.equal(writes, 1); assert.equal(item.input, 'Restored queue edit'); assert.equal(paused, true); assert.equal(createDraftStore({ storage }).list().length, 0);
});
