import test from 'node:test';
import assert from 'node:assert/strict';
import { initKnowledgeUI } from '../public/knowledge-ui.mjs';

const escaped = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const entry = (revision = 2, extra = {}) => ({ id: 'note', kind: 'memory', title: 'Project preference', summary: 'A useful note.', content: revision === 1 ? 'Before <script>alert(1)</script>' : 'After literal content.', cwd: 'C:\\project', revision, createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T13:00:00Z', action: revision === 1 ? 'create' : 'update', provenance: { source: 'agent', runId: 'source-chat', nodeId: 'agent', reason: 'Saved after successful work' }, ...extra });
const audit = (history = [entry(), entry(1)]) => ({ entryId: 'note', currentRevision: history[0].revision, deleted: history[0].deleted === true, retentionLimit: 9, history });

function fixture(t, onApi) {
  const previous = Object.fromEntries(['document', 'requestAnimationFrame'].map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }])), elements = new Map(), listeners = new Map(), requests = [], messages = [], opened = [], evidence = [], modals = [];
  function node(selector) {
    if (elements.has(selector)) return elements.get(selector);
    let html = '';
    const result = { value: '', disabled: false, isConnected: true, dataset: {}, textContent: '', classList: { add() {} }, focus() {}, querySelector: query => node(`${selector} ${query}`), requestSubmit() {},
      get innerHTML() { return html; }, set innerHTML(value) { html = value; for (const match of value.matchAll(/id="([^"]+)"/g)) node(`#${match[1]}`); } };
    elements.set(selector, result); return result;
  }
  globalThis.document = { querySelector: selector => elements.get(selector) || null, addEventListener: (type, listener) => { const handlers = listeners.get(type) || []; handlers.push(listener); listeners.set(type, handlers); } };
  globalThis.requestAnimationFrame = fn => fn();
  const ui = initKnowledgeUI({ api: async (path, method = 'GET', body) => { requests.push({ path, method, body }); return onApi(path, method, body); }, showModal: (id, html) => { elements.clear(); modals.push({ id, html }); node('#modal-root .modal'); node('#knowledge-view'); }, closeModal: () => elements.clear(), toast: (message, error) => messages.push({ message, error }), escape: escaped, getCwd: () => 'C:\\project', icon: () => '', onOpenRun: async id => opened.push(id), onOpenLearning: async value => evidence.push(value) });
  t.after(() => { ui.close(); for (const [key, old] of Object.entries(previous)) if (old.present) globalThis[key] = old.value; else delete globalThis[key]; });
  const dispatch = async (type, target) => { for (const listener of listeners.get(type) || []) await listener({ target, preventDefault() {} }); };
  const click = (action, extra = {}) => { const button = { disabled: false, isConnected: true, dataset: { knowledgeAction: action, ...extra }, closest: () => button }; return dispatch('click', button); };
  return { ui, elements, requests, messages, opened, evidence, modals, click, change: (id, value) => dispatch('change', { id, value }), submit: () => dispatch('submit', { id: 'knowledge-editor', querySelector: query => node(`#knowledge-editor ${query}`) }), html: () => elements.get('#knowledge-view')?.innerHTML || '', results: () => elements.get('#knowledge-results')?.innerHTML || '' };
}

test('the library exposes source badges and opens the actual source chat and learning evidence', async t => {
  const learned = entry(2, { provenance: { source: 'agent', runId: 'learned-chat', nodeId: 'learning-review', reason: 'Automatic learning' } }), f = fixture(t, path => path.includes('?') ? [learned] : learned);
  await f.ui.open(); assert.match(f.modals[0].html, /Memory & skills/); assert.match(f.results(), /knowledge-source-tag">Learned/); assert.match(f.html(), /data-knowledge-action="deleted"/);
  await f.click('read', { id: 'note' }); assert.match(f.html(), /Automatic learning/); assert.match(f.html(), /Source chat/); assert.match(f.html(), /Review evidence/); assert.match(f.html(), /data-knowledge-action="history"/);
  await f.click('source', { runId: 'learned-chat' }); await f.click('evidence', { id: 'note' }); assert.deepEqual(f.opened, ['learned-chat']); assert.deepEqual(f.evidence, [{ knowledgeId: 'note' }]);
});

test('change history displays real escaped before and after content and restores the chosen revision with a conflict guard', async t => {
  let saved = audit(); const f = fixture(t, (path, method, body) => { if (path.includes('/history')) return saved; if (path.endsWith('/restore')) { assert.deepEqual(body, { revision: 1, expectedRevision: 2 }); saved = audit([entry(3, { content: entry(1).content, action: 'restore', provenance: { source: 'user' } }), ...saved.history]); return saved.history[0]; } return path.includes('?') ? [entry()] : entry(); });
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('history');
  assert.match(f.html(), /<h3>Before<\/h3>/); assert.match(f.html(), /Before &lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.match(f.html(), /After literal content/); assert.doesNotMatch(f.html(), /<script>/);
  await f.change('knowledge-revision', '1'); assert.match(f.html(), /This entry did not exist/); await f.click('restore');
  assert.equal(f.requests.filter(item => item.path.endsWith('/restore')).length, 1); assert.match(f.html(), /Revision 3/); assert.equal(f.messages.at(-1).message, 'Revision restored.');
});

test('undoing the first automatic save deletes it recoverably and undoing that deletion restores the saved snapshot', async t => {
  let saved = audit([entry(1)]); const f = fixture(t, (path, method, body) => {
    if (path.includes('/history')) return saved;
    if (method === 'DELETE') { assert.deepEqual(body, { expectedRevision: 1 }); saved = audit([entry(2, { deleted: true, action: 'delete', content: entry(1).content, provenance: { source: 'user' } }), ...saved.history]); return { ok: true, revision: 2, deleted: true }; }
    if (path.endsWith('/restore')) { assert.deepEqual(body, { revision: 1, expectedRevision: 2 }); saved = audit([entry(3, { action: 'restore', content: entry(1).content, provenance: { source: 'user' } }), ...saved.history]); return saved.history[0]; }
    return path.includes('?') ? [entry(1)] : entry(1);
  });
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('history'); await f.click('undo'); assert.match(f.html(), /Deleted · unavailable to agents/); assert.match(f.html(), /data-knowledge-action="undo"/);
  await f.click('undo'); assert.equal(f.requests.filter(item => item.path.endsWith('/restore')).length, 1); assert.match(f.html(), />Active<\/span>/); assert.match(f.html(), /Revision 3/);
});

test('Deleted filters the actual deleted API records and opens their audit instead of attempting a forbidden current read', async t => {
  const removed = entry(3, { deleted: true, action: 'delete' }), f = fixture(t, path => path.includes('/history') ? audit([removed, entry()]) : [removed]);
  await f.ui.open(); await f.click('deleted'); assert.ok(f.requests.some(item => item.path.includes('deletedOnly=true'))); assert.match(f.html(), /Show active/);
  await f.click('read', { id: 'note' }); assert.equal(f.requests.filter(item => item.path === '/api/knowledge/note').length, 0); assert.match(f.html(), /Deleted · unavailable to agents/); assert.match(f.html(), /Undo latest change/);
});

test('failed and duplicate undo requests preserve the inspectable history and never claim success', async t => {
  const pending = deferred(), f = fixture(t, (path, method) => path.endsWith('/restore') ? pending.promise : path.includes('/history') ? audit() : path.includes('?') ? [entry()] : entry());
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('history'); const first = f.click('undo'); await f.click('undo'); assert.equal(f.requests.filter(item => item.path.endsWith('/restore')).length, 1);
  pending.reject(new Error('This entry changed. Refresh its history.')); await first; assert.match(f.html(), /This entry changed/); assert.match(f.html(), /Refresh change history/); assert.deepEqual(f.messages, []);
});

test('a late history response cannot replace an editor or a reopened library', async t => {
  const pending = deferred(), f = fixture(t, path => path.includes('/history') ? pending.promise : path.includes('?') ? [entry()] : entry());
  await f.ui.open(); await f.click('read', { id: 'note' }); const opening = f.click('history'); await turn(); await f.click('new'); assert.match(f.html(), /id="knowledge-editor"/);
  pending.resolve(audit()); await opening; assert.match(f.html(), /id="knowledge-editor"/); assert.doesNotMatch(f.html(), /knowledge-revision-grid/);
  await f.ui.open(); assert.match(f.html(), /knowledge-toolbar/);
});

test('deferred editor autofocus preserves a field the person already selected and cannot focus a later view', async t => {
  const f = fixture(t, () => [entry()]), frames = [];
  await f.ui.open(); globalThis.requestAnimationFrame = fn => frames.push(fn);
  globalThis.document.body = {}; globalThis.document.activeElement = globalThis.document.body;
  await f.click('new');
  const title = f.elements.get('#knowledge-title'), summary = f.elements.get('#knowledge-summary'); let focused = 0;
  title.focus = () => { focused++; globalThis.document.activeElement = title; };
  globalThis.document.activeElement = summary; frames.shift()();
  assert.equal(focused, 0); assert.equal(globalThis.document.activeElement, summary);
  await f.click('new'); globalThis.document.activeElement = globalThis.document.body; frames.shift()();
  assert.equal(focused, 1); assert.equal(globalThis.document.activeElement, title);
  await f.click('new'); await f.click('back'); globalThis.document.activeElement = globalThis.document.body;
  frames.shift()(); assert.equal(focused, 1);
});

test('late undo success or failure cannot replace another library session or show a stale error there', async t => {
  for (const failure of [false, true]) {
    const pending = deferred(), f = fixture(t, path => path.endsWith('/restore') ? pending.promise : path.includes('/history') ? audit() : path.includes('?') ? [entry()] : entry());
    await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('history'); const saving = f.click('undo'); await f.ui.open();
    if (failure) pending.reject(new Error('Old undo failure')); else pending.resolve(entry(3)); await saving;
    assert.match(f.html(), /knowledge-toolbar/); assert.doesNotMatch(f.html(), /Old undo failure|knowledge-revision-grid/); assert.deepEqual(f.messages, []);
  }
});

test('a legacy revision without retained earlier content cannot pretend to undo that edit by deleting the whole entry', async t => {
  const legacy = entry(7), f = fixture(t, path => path.includes('/history') ? audit([legacy]) : path.includes('?') ? [legacy] : legacy);
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('history');
  assert.match(f.html(), /data-knowledge-action="undo" disabled/); await f.click('undo'); assert.equal(f.requests.some(item => item.method !== 'GET'), false);
});

const fillMemory = (f, extra = {}) => {
  const values = { 'knowledge-title': 'A decision', 'knowledge-kind': 'memory', 'knowledge-edit-scope': 'workspace', 'knowledge-summary': 'Why this choice matters', 'knowledge-content': 'Use the tested approach.', 'knowledge-memory-type': 'decision', 'knowledge-sources': 'brief.md section 2\nhttps://example.invalid/evidence', ...extra };
  for (const [id, value] of Object.entries(values)) f.elements.get(`#${id}`).value = value;
};

test('memory type filter requests real filtered records and displays their category', async t => {
  const fact = entry(1, { memoryType: 'fact' }), f = fixture(t, path => path.includes('memoryType=fact') ? [fact] : [entry()]);
  await f.ui.open(); assert.match(f.html(), /Filter memory type/);
  await f.change('knowledge-memory-filter', 'fact'); await turn();
  assert.ok(f.requests.some(item => item.path.includes('memoryType=fact'))); assert.match(f.results(), /knowledge-type-tag">Fact/);
});

test('memory editor saves ordinary category, source and relationship controls with the revision it read', async t => {
  const original = entry(2, { memoryType: 'assumption', sources: ['old.md'], relations: [] }), target = entry(1, { id: 'target', title: 'Observed result', memoryType: 'fact' }); let saved;
  const f = fixture(t, (path, method, body) => {
    if (method === 'POST') { saved = body; return { ...original, ...body, revision: 3 }; }
    return path.includes('?') ? [original, target] : original;
  });
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('edit'); await turn();
  assert.match(f.html(), /knowledge-memory-type/); assert.match(f.html(), /One URL, file location, or citation per line/);
  fillMemory(f); f.elements.get('#knowledge-relation-type').value = 'supports'; f.elements.get('#knowledge-relation-target').value = 'target';
  await f.click('add-relation'); assert.match(f.elements.get('#knowledge-relation-list').innerHTML, /Observed result/);
  await f.click('add-relation'); assert.match(f.elements.get('#knowledge-relation-error').textContent, /already included/);
  await f.submit();
  assert.equal(saved.expectedRevision, 2); assert.equal(saved.memoryType, 'decision'); assert.deepEqual(saved.sources, ['brief.md section 2', 'https://example.invalid/evidence']); assert.deepEqual(saved.relations, [{ type: 'supports', targetId: 'target' }]);
  assert.match(f.html(), /Relationships/); assert.match(f.html(), /Supports/); assert.match(f.html(), /brief\.md section 2/); assert.equal(f.messages.at(-1).message, 'Memory saved.');
});

test('failed semantic save preserves source text, category and relationships for review', async t => {
  const original = entry(2), target = entry(1, { id: 'target', title: 'Reference' }), f = fixture(t, (path, method) => {
    if (method === 'POST') throw new Error('This entry changed while you were reading it.');
    return path.includes('?') ? [original, target] : original;
  });
  await f.ui.open(); await f.click('read', { id: 'note' }); await f.click('edit'); await turn(); fillMemory(f);
  f.elements.get('#knowledge-relation-type').value = 'contradicts'; f.elements.get('#knowledge-relation-target').value = 'target'; await f.click('add-relation'); await f.submit();
  assert.equal(f.elements.get('#knowledge-memory-type').value, 'decision'); assert.match(f.elements.get('#knowledge-sources').value, /brief\.md/); assert.match(f.elements.get('#knowledge-relation-list').innerHTML, /Contradicts/); assert.match(f.elements.get('#knowledge-editor-error').textContent, /entry changed/); assert.deepEqual(f.messages, []);
  await f.click('remove-relation', { index: '0' }); assert.match(f.elements.get('#knowledge-relation-list').innerHTML, /No related memories yet/);
});

test('sources and relationship metadata are escaped in the reader and before/after history', async t => {
  const typed = entry(2, { memoryType: 'fact', sources: ['<img src=x onerror=alert(1)>'], relations: [{ type: 'informs', targetId: 'target' }] }), f = fixture(t, path => path.includes('/history') ? audit([typed, entry(1, { memoryType: 'assumption', sources: ['original.md'] })]) : path.includes('?') ? [typed] : typed);
  await f.ui.open(); await f.click('read', { id: 'note' }); assert.match(f.html(), /&lt;img/); assert.doesNotMatch(f.html(), /<img src=x/);
  await f.click('history'); assert.match(f.html(), /Assumption/); assert.match(f.html(), /Fact/); assert.match(f.html(), /original\.md/); assert.match(f.html(), /Informs/); assert.doesNotMatch(f.html(), /<img src=x/);
});

test('late relation choices preserve edited content and cannot replace a newer editor', async t => {
  const pending = deferred(); let listing = 0;
  const f = fixture(t, path => path.includes('?') ? ++listing === 2 ? pending.promise : [entry()] : entry());
  await f.ui.open(); await f.click('new'); fillMemory(f, { 'knowledge-content': 'Unsaved choice and rationale.' });
  await f.click('new'); fillMemory(f, { 'knowledge-content': 'A different draft.' }); await turn();
  pending.resolve([entry(1, { id: 'stale-target', title: 'Stale choice' })]); await turn();
  assert.equal(f.elements.get('#knowledge-content').value, 'A different draft.'); assert.doesNotMatch(f.elements.get('#knowledge-relation-target').innerHTML, /Stale choice/);
});

test('a late failed save cannot put its conflict error into another editor', async t => {
  const pending = deferred(), f = fixture(t, (path, method) => method === 'POST' ? pending.promise : path.includes('?') ? [entry()] : entry());
  await f.ui.open(); await f.click('new'); fillMemory(f); const saving = f.submit(); await f.click('new'); fillMemory(f, { 'knowledge-title': 'Different draft' });
  pending.reject(new Error('Old draft conflict')); await saving;
  assert.equal(f.elements.get('#knowledge-title').value, 'Different draft'); assert.doesNotMatch(f.elements.get('#knowledge-editor-error').textContent, /Old draft conflict/); assert.deepEqual(f.messages, []);
});
