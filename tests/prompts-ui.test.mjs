import test from 'node:test';
import assert from 'node:assert/strict';
import { initPromptsUI, outlineBranch, outlineDepthBounds, moveOutlineBranch, insertOutlineSibling, removeOutlineBranch, setOutlineDepth } from '../public/prompts-ui.mjs';
import { createDraftStore } from '../public/draft-store.mjs';
import { BUILTIN_PROMPT_TEMPLATES, renderPromptTemplate } from '../public/prompt-template-model.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
function fixture(t, overrides = {}) {
  const previous = globalThis.document, roots = [], calls = [], applied = [], toasts = [], downloaded = [], blobs = [], cache = new Map(); let root = null, closed = 0;
  const previousCreateURL = URL.createObjectURL, previousRevokeURL = URL.revokeObjectURL; URL.createObjectURL = blob => { blobs.push(blob); return `blob:fixture-${blobs.length}`; }; URL.revokeObjectURL = () => {};
  const storage = { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key), get length() { return cache.size; }, key: index => [...cache.keys()][index] };
  const draftStore = createDraftStore({ storage, prefix: 'test:' });
  function createRoot() {
    const nodes = [], events = new Map(); let html = '';
    const match = (node, selector) => {
      selector = selector.trim(); if (selector.includes(' ')) selector = selector.split(' ')[0];
      if (selector.startsWith('#')) return node.id === selector.slice(1);
      if (/^[a-z]+$/i.test(selector)) return node.tagName.toLowerCase() === selector.toLowerCase();
      const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]; return attrs.length && attrs.every(([, key, value]) => value === undefined ? node.attributes[key] !== undefined : node.attributes[key] === value);
    };
    const parse = source => { for (const token of source.matchAll(/<(input|textarea|button|div|small|span|select|nav|section)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?>)/g)) {
      const attributes = Object.fromEntries([...token[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, decode(value || '')]));
      const node = { id: attributes.id || '', tagName: token[1].toUpperCase(), attributes, dataset: Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])), value: token[1] === 'textarea' ? decode(token[3] || '') : attributes.value || '', textContent: decode((token[3] || '').replace(/<[^>]*>/g, '')), innerHTML: '', disabled: /\bdisabled\b/.test(token[2]), hidden: /\bhidden\b/.test(token[2]), parentNode: ownRoot,
        focus() { globalThis.document.activeElement = node; }, click() { void ownRoot.dispatch('click', { target: node }); }, closest: selector => match(node, selector) ? node : null, insertAdjacentHTML(_position, source) { parse(source); } };
      nodes.push(node); if (token[3]) parse(token[3]);
    } };
    const ownRoot = { id: 'prompt-workspace', get innerHTML() { return html; }, set innerHTML(value) { html = value; nodes.length = 0; parse(value); }, querySelector(selector) { return selector.split(',').map(item => nodes.find(node => match(node, item))).find(Boolean) || null; }, querySelectorAll(selector) { return nodes.filter(node => selector.split(',').some(item => match(node, item))); }, addEventListener(type, callback) { const callbacks = events.get(type) || []; callbacks.push(callback); events.set(type, callbacks); }, async dispatch(type, event) { for (const callback of events.get(type) || []) await callback(event); await tick(); } }; roots.push(ownRoot); return ownRoot;
  }
  globalThis.document = { activeElement: null, getElementById: id => id === 'prompt-workspace' ? root : null, createElement: tag => ({ tagName: tag.toUpperCase(), click() { downloaded.push({ href: this.href, download: this.download }); } }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; URL.createObjectURL = previousCreateURL; URL.revokeObjectURL = previousRevokeURL; });
  const api = async (url, method, body) => { calls.push({ url, method, body }); const result = await overrides.api?.(url, method, body); if (result !== undefined) return result; if (url === '/api/prompts?includeDeleted=true' && !method) return { templates: BUILTIN_PROMPT_TEMPLATES }; const id = url.split('/')[3]; return { template: BUILTIN_PROMPT_TEMPLATES.find(item => item.id === id) }; };
  const ui = initPromptsUI({ api, showModal() { root = createRoot(); }, closeModal() { closed++; ui.cancel(); root = null; }, escape, icon: () => '', toast: (...args) => toasts.push(args), draftStore, captureDraft: () => ({ key: 'new', task: overrides.task ?? 'Build chess pieces' }), applyDraft(capture, text) { applied.push({ capture, text }); return overrides.apply?.(capture, text) || { applied: true }; } });
  return { ui, api, calls, applied, toasts, cache, roots, draftStore, downloaded, blobs, get root() { return root; }, get closed() { return closed; }, async action(action, data = {}) { const node = root.querySelector(`[data-prompt-action="${action}"]`) || { dataset: {} }; node.dataset = { ...node.dataset, promptAction: action, ...data }; node.disabled = false; node.closest = () => node; await root.dispatch('click', { target: node }); }, async input(id, value, dataset = {}) { const node = root.querySelector(`#${id}`) || { id }; node.value = value; node.dataset = { ...node.dataset, ...dataset }; await root.dispatch('input', { target: node }); }, async choose(id = 'builtin_task') { await this.action('select', { id }); }, async import(file) { await root.dispatch('change', { target: { id: 'prompt-import', files: [file] } }); }, dismiss() { ui.cancel(); root = null; } };
}

test('outline library is loaded on demand and searching a large library does not dispatch agent work', async t => {
  const templates = Array.from({ length: 240 }, (_, index) => ({ ...BUILTIN_PROMPT_TEMPLATES[0], id: `custom_${index}`, title: `Reusable ${index}`, description: index === 179 ? 'Needle recipe' : 'Generic work' }));
  const f = fixture(t, { api: url => url === '/api/prompts?includeDeleted=true' ? { templates } : undefined }); assert.equal(f.calls.length, 0); await f.ui.open(); assert.equal(f.calls.length, 1); await f.input('prompt-search', 'needle'); const html = f.root.querySelector('#prompt-library').innerHTML; assert.match(html, /Reusable 179/); assert.doesNotMatch(html, /Reusable 178/); assert.equal(f.calls.length, 1); assert.equal(f.applied.length, 0);
});

test('fill values render literally and exact preview edits apply only to the unsent draft', async t => {
  const f = fixture(t, { task: 'Use {{context}} literally' }); await f.ui.open(); await f.choose(); await f.input('unused', 'Some context', { promptValue: 'context' });
  const rendered = renderPromptTemplate(BUILTIN_PROMPT_TEMPLATES[0], { task: 'Use {{context}} literally', context: 'Some context' }).text; assert.equal(f.root.querySelector('#prompt-result').value, rendered); assert.match(rendered, /Use \{\{context\}\} literally/); assert.equal(f.applied.length, 0);
  await f.input('prompt-result', 'My exact edited message\n\n{{still literal}}'); await f.action('apply'); assert.equal(f.closed, 1); assert.equal(f.applied[0].text, 'My exact edited message\n\n{{still literal}}'); assert.equal(f.calls.filter(call => call.method).length, 0);
});

test('Cancel and stale async detail results cannot change a newer modal session or its draft', async t => {
  const first = deferred(); let details = 0; const f = fixture(t, { api: url => url === '/api/prompts/builtin_task' && ++details === 1 ? first.promise : undefined }); await f.ui.open(); const old = f.root; await f.action('select', { id: 'builtin_task' }); f.dismiss(); await f.ui.open(); const current = f.root;
  first.resolve({ template: BUILTIN_PROMPT_TEMPLATES[0] }); await tick(); assert.equal(f.root, current); assert.match(current.innerHTML, /Prompt outlines/); assert.doesNotMatch(current.innerHTML, /id="prompt-result"/); assert.equal(f.applied.length, 0); assert.notEqual(old, current);
});

test('late library response after close cannot populate a subsequently reopened library', async t => {
  const first = deferred(); let lists = 0; const f = fixture(t, { api: url => url === '/api/prompts?includeDeleted=true' && ++lists === 1 ? first.promise : undefined }); const pending = f.ui.open(); f.dismiss(); await f.ui.open(); first.resolve({ templates: [{ ...BUILTIN_PROMPT_TEMPLATES[0], title: 'Stale library only' }] }); await pending;
  assert.doesNotMatch(f.root.querySelector('#prompt-library').innerHTML, /Stale library only/); assert.match(f.root.querySelector('#prompt-library').innerHTML, /Clear task/);
});

test('a pending library selection cannot replace a newly authored outline in the same dialog', async t => {
  const detail = deferred(), f = fixture(t, { api: url => url === '/api/prompts/builtin_task' ? detail.promise : undefined }); await f.ui.open(); await f.action('select', { id: 'builtin_task' }); await f.action('new'); await f.input('prompt-name', 'Keep my new outline'); await f.input('prompt-section-content', 'My instructions'); detail.resolve({ template: BUILTIN_PROMPT_TEMPLATES[0] }); await tick(); assert.equal(f.root.querySelector('#prompt-name').value, 'Keep my new outline'); assert.equal(f.root.querySelector('#prompt-section-content').value, 'My instructions'); assert.equal(f.applied.length, 0);
});

test('failed Apply keeps the exact preview and reports changed-chat ownership without sending anything', async t => {
  const f = fixture(t, { apply: () => ({ applied: false, error: 'This draft changed in another Relay window.' }) }); await f.ui.open(); await f.choose(); await f.input('prompt-result', 'Keep this carefully edited preview'); await f.action('apply');
  assert.equal(f.closed, 0); assert.equal(f.root.querySelector('#prompt-result').value, 'Keep this carefully edited preview'); assert.match(f.root.querySelector('#prompt-error').textContent, /another Relay window/); assert.equal(f.calls.filter(call => call.method).length, 0);
});

test('saving a builtin creates a copy without persisting filled values or edited preview text', async t => {
  let saved; const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/save' && method === 'POST') { saved = body; return { template: { ...body.template, id: 'saved_copy', revision: 1, builtin: false } }; } } }); await f.ui.open(); await f.choose(); await f.input('unused', 'Private context from this task', { promptValue: 'context' }); await f.input('prompt-result', 'Private preview from this task'); await f.action('save');
  assert.equal(saved.template.id, undefined); assert.equal(saved.expectedRevision, undefined); assert.equal(saved.template.sections[0].content, '{{task}}'); assert.doesNotMatch(JSON.stringify(saved), /Private context|Private preview|Build chess pieces/); assert.equal(f.applied.length, 0);
});

test('a revision conflict preserves authoring edits and unsaved authoring can be resumed after close', async t => {
  const template = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_existing', builtin: false, revision: 7 }; let posted;
  const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/custom_existing') return { template }; if (url === '/api/prompts/save' && method === 'POST') { posted = body; throw new Error('This outline changed. Reload its saved revision.'); } } }); await f.ui.open(); await f.choose(template.id); await f.action('edit'); await f.input('prompt-name', 'My unsaved title'); await f.input('prompt-section-content', '{{task}}\nAlways verify'); await f.action('save');
  assert.equal(posted.expectedRevision, 7); assert.equal(posted.template.id, template.id); assert.equal(posted.template.sections[0].content, '{{task}}\nAlways verify'); assert.match(f.root.querySelector('#prompt-error').textContent, /changed/); assert.equal(f.root.querySelector('#prompt-name').value, 'My unsaved title'); f.dismiss(); await f.ui.open(); await f.action('resume-draft'); assert.equal(f.root.querySelector('#prompt-name').value, 'My unsaved title'); assert.equal(f.root.querySelector('#prompt-section-content').value, '{{task}}\nAlways verify'); assert.doesNotMatch(JSON.stringify([...f.cache]), /Build chess pieces/);
});

test('the editor keeps nested sections attached when a sibling move is unavailable', async t => {
  let posted; const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/save' && method === 'POST') { posted = body; return { template: { ...body.template, id: 'structured', revision: 1, builtin: false } }; } } }); await f.ui.open({ saveCurrent: true }); await f.input('prompt-name', 'Chess delivery'); await f.input('prompt-section-title', 'Goal'); await f.action('add'); await f.input('prompt-section-title', 'Validation'); await f.input('prompt-section-content', 'Test legal moves'); await f.input('prompt-section-level', '1'); await f.action('up'); await f.action('save');
  assert.equal(posted.template.title, 'Chess delivery'); assert.deepEqual(posted.template.sections.map(section => [section.title, section.level]), [['Goal', 0], ['Validation', 1]]); assert.equal(posted.template.sections[0].content, 'Build chess pieces'); assert.equal(f.applied.length, 0);
});

test('deleting a saved outline offers optimistic Undo and restore failure preserves the receipt', async t => {
  const template = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_delete', builtin: false, revision: 4 }; let restore = 0; const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/custom_delete') return { template }; if (url.endsWith('/delete')) { assert.equal(body.expectedRevision, 4); return { template: { ...template, deleted: true, revision: 5 } }; } if (url.endsWith('/restore')) { assert.equal(body.expectedRevision, 5); if (++restore === 1) throw new Error('Temporary restore error'); return { template: { ...template, revision: 6 } }; } } }); await f.ui.open(); await f.choose(template.id); await f.action('delete'); assert.match(f.root.innerHTML, /Outline deleted/); await f.action('undo-delete'); assert.match(f.root.querySelector('#prompt-error').textContent, /Temporary restore error/); assert.match(f.root.innerHTML, /undo-delete/); await f.action('undo-delete'); assert.doesNotMatch(f.root.innerHTML, /Outline deleted/); assert.equal(f.applied.length, 0);
});

test('closing during Save never reopens the modal or replaces a new session with its result', async t => {
  const saving = deferred(); const f = fixture(t, { api: (url, method) => url === '/api/prompts/save' && method === 'POST' ? saving.promise : undefined }); await f.ui.open(); await f.choose(); await f.action('save'); f.dismiss(); await f.ui.open(); const latest = f.root; saving.resolve({ template: { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'late_saved', builtin: false } }); await tick(); assert.equal(f.root, latest); assert.doesNotMatch(latest.innerHTML, /id="prompt-result"/); assert.equal(f.toasts.length, 0);
});

test('optional fields stay behind Add details and retain values while preview is freely editable', async t => {
  const f = fixture(t, { task: '' }); await f.ui.open(); await f.choose(); assert.match(f.root.innerHTML, /class="prompt-extra-fields"><summary>Add details/); await f.input('unused', 'Keep this context', { promptValue: 'context' }); await f.input('prompt-result', 'An ordinary handwritten message'); await f.action('apply'); assert.equal(f.applied[0].text, 'An ordinary handwritten message'); assert.equal(f.closed, 1);
});

test('degraded saved library leaves starter outlines usable and does not block normal draft application', async t => {
  const f = fixture(t, { api: url => url === '/api/prompts?includeDeleted=true' ? { templates: BUILTIN_PROMPT_TEMPLATES, status: { healthy: false, error: 'Saved outlines need recovery.' } } : undefined }); await f.ui.open(); assert.match(f.root.querySelector('#prompt-error').textContent, /recovery/); await f.choose(); assert.match(f.root.querySelector('#prompt-error').textContent, /recovery/); await f.action('apply'); assert.equal(f.closed, 1); assert.match(f.applied[0].text, /Build chess pieces/);
});

test('history exposes readable revisions and restores as a new revision without applying a chat message', async t => {
  const original = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_history', builtin: false, revision: 1, title: 'Original structure', provenance: { source: 'agent' }, action: 'create', updatedAt: '2026-10-17T10:00:00Z' }, latest = { ...original, revision: 2, title: 'Current structure', provenance: { source: 'user' }, action: 'update' }; let restored;
  const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/custom_history') return { template: latest }; if (url.endsWith('/history')) return { templateId: latest.id, currentRevision: restored ? 3 : 2, history: restored ? [restored, latest, original] : [latest, original] }; if (url.endsWith('/restore')) { assert.deepEqual(body, { expectedRevision: 2, revision: 1 }); restored = { ...original, revision: 3, action: 'restore' }; return { template: restored }; } } }); await f.ui.open(); await f.choose(latest.id); await f.action('history'); assert.match(f.root.innerHTML, /Revision 1/); assert.match(f.root.innerHTML, /agent/); assert.match(f.root.innerHTML, /Original structure/); await f.action('restore-revision', { revision: '1' }); assert.match(f.root.innerHTML, /Revision 3/); assert.equal(f.applied.length, 0); assert.equal(f.closed, 0); await f.action('history-back'); assert.match(f.root.innerHTML, /Original structure/);
});

test('stale history responses and restore conflicts preserve current template edits', async t => {
  const pending = deferred(), template = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_stale_history', builtin: false, revision: 6 }; let historyCalls = 0;
  const f = fixture(t, { api: url => { if (url === `/api/prompts/${template.id}`) return { template }; if (url.endsWith('/history')) return ++historyCalls === 1 ? pending.promise : { templateId: template.id, currentRevision: 6, history: [template, { ...template, revision: 5 }] }; if (url.endsWith('/restore')) throw new Error('The outline changed in another window.'); } }); await f.ui.open(); await f.choose(template.id); await f.action('history'); await f.action('history-back'); pending.resolve({ templateId: template.id, currentRevision: 9, history: [{ ...template, revision: 9, title: 'Stale history response' }] }); await tick(); assert.doesNotMatch(f.root.innerHTML, /Stale history response/); assert.match(f.root.innerHTML, /id="prompt-result"/); await f.action('history'); await f.action('restore-revision', { revision: '5' }); assert.match(f.root.querySelector('#prompt-error').textContent, /another window/); assert.match(f.root.innerHTML, /Revision 6/); assert.equal(f.applied.length, 0);
});

test('export includes visible authoring edits, excludes filled values, and imports that portable document as a new outline', async t => {
  let imported; const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts/import') { imported = body.document; return { template: { ...body.document.template, id: 'imported_new', revision: 1, builtin: false } }; } } }); await f.ui.open(); await f.choose(); await f.input('unused', 'Private context', { promptValue: 'context' }); await f.action('edit'); await f.input('prompt-name', 'Portable edited outline'); await f.input('prompt-section-content', '{{task}}\nVerify the result'); await f.action('export'); assert.equal(f.downloaded.length, 1); const text = await f.blobs[0].text(), document = JSON.parse(text); assert.equal(document.format, 'relay-prompt-template'); assert.equal(document.template.title, 'Portable edited outline'); assert.equal(document.template.sections[0].content, '{{task}}\nVerify the result'); assert.equal(document.template.id, undefined); assert.doesNotMatch(text, /Private context|Build chess pieces/); await f.action('library'); await f.import({ size: text.length, text: async () => text }); assert.deepEqual(imported, document); assert.match(f.root.innerHTML, /Portable edited outline/); assert.equal(f.applied.length, 0);
});

test('oversized or malformed imports do not mutate the library and late file reads cannot reopen a closed dialog', async t => {
  const fileRead = deferred(), f = fixture(t); await f.ui.open(); await f.import({ size: 600000, text: () => { throw new Error('Must not read'); } }); assert.match(f.root.querySelector('#prompt-error').textContent, /512 KB/); await f.import({ size: 10, text: async () => '{invalid}' }); assert.match(f.root.querySelector('#prompt-error').textContent, /not valid JSON/); await f.import({ size: 10, text: () => fileRead.promise }); f.dismiss(); await f.ui.open(); const newest = f.root; fileRead.resolve('{}'); await tick(); assert.equal(f.root, newest); assert.equal(f.calls.filter(call => call.method).length, 0);
});

test('saved copies are distinguished from same-name starters and Trash appears only when deleted outlines exist', async t => {
  const custom = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_same_name', builtin: false, revision: 2 };
  const f = fixture(t, { api: url => url === '/api/prompts?includeDeleted=true' ? { templates: [BUILTIN_PROMPT_TEMPLATES[0], custom] } : undefined }); await f.ui.open(); const html = f.root.querySelector('#prompt-library').innerHTML;
  assert.match(html, /data-id="builtin_task"><strong>Clear task<\/strong>/); assert.match(html, /data-id="custom_same_name"><strong>Clear task<span class="prompt-saved">Saved<\/span>/); assert.equal(f.root.querySelector('#prompt-trash-control').innerHTML, ''); assert.equal(f.applied.length, 0);
});

test('deleted outlines remain discoverable and restorable after closing and reopening without reading deleted content or applying a draft', async t => {
  let saved = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_persistent_trash', title: 'Keep recoverable', builtin: false, revision: 3 };
  const f = fixture(t, { api: (url, method, body) => {
    if (url === '/api/prompts?includeDeleted=true') return { templates: [...BUILTIN_PROMPT_TEMPLATES, saved] };
    if (url === `/api/prompts/${saved.id}`) { assert.equal(saved.deleted, false); return { template: saved }; }
    if (url.endsWith('/delete')) { assert.equal(body.expectedRevision, 3); saved = { ...saved, revision: 4, deleted: true }; return { template: saved }; }
    if (url.endsWith('/restore')) { assert.deepEqual(body, { expectedRevision: 4 }); saved = { ...saved, revision: 5, deleted: false }; return { template: saved }; }
  } });
  await f.ui.open(); await f.choose(saved.id); await f.action('delete'); f.dismiss(); await f.ui.open(); assert.match(f.root.querySelector('#prompt-trash-control').innerHTML, /Trash 1/); assert.doesNotMatch(f.root.querySelector('#prompt-library').innerHTML, /Keep recoverable/);
  await f.action('trash'); assert.match(f.root.querySelector('#prompt-library').innerHTML, /Keep recoverable/); assert.match(f.root.querySelector('#prompt-library').innerHTML, /restore-deleted/); await f.action('restore-deleted', { id: saved.id, revision: '4' }); assert.equal(saved.deleted, false); assert.match(f.root.querySelector('#prompt-library').innerHTML, /Keep recoverable/); assert.equal(f.root.querySelector('#prompt-trash-control').innerHTML, ''); assert.equal(f.calls.filter(call => call.url === `/api/prompts/${saved.id}` && !call.method).length, 1); assert.equal(f.applied.length, 0); assert.equal(f.closed, 0);
});

test('a Trash restore conflict retains its row and leaves the current message untouched', async t => {
  const deleted = { ...BUILTIN_PROMPT_TEMPLATES[0], id: 'custom_conflicted_trash', title: 'Deleted structure', builtin: false, deleted: true, revision: 8 };
  const f = fixture(t, { api: (url, method, body) => { if (url === '/api/prompts?includeDeleted=true') return { templates: [...BUILTIN_PROMPT_TEMPLATES, deleted] }; if (url.endsWith('/restore')) { assert.deepEqual(body, { expectedRevision: 8 }); throw new Error('The saved outline changed. Reopen the library to refresh.'); } } }); await f.ui.open(); await f.action('trash'); await f.action('restore-deleted', { id: deleted.id }); assert.match(f.root.querySelector('#prompt-error').textContent, /changed/); assert.match(f.root.querySelector('#prompt-library').innerHTML, /Deleted structure/); assert.match(f.root.querySelector('#prompt-library').innerHTML, /restore-deleted/); assert.equal(f.applied.length, 0);
});

const outline = entries => entries.map(([id, level]) => ({ id, title: id, content: `${id} instructions`, level }));
const ordering = sections => sections.map(section => [section.id, section.level]);

test('moving a parent down or its neighboring sibling up swaps complete outline branches', () => {
  const original = outline([['A',0],['B',1],['C',0],['D',1]]), snapshot = structuredClone(original), down = moveOutlineBranch(original, 0, 'down'), up = moveOutlineBranch(original, 2, 'up');
  assert.deepEqual(ordering(down.sections), [['C',0],['D',1],['A',0],['B',1]]); assert.equal(down.index, 2); assert.deepEqual(up, { sections: down.sections, index: 0 }); assert.deepEqual(original, snapshot);
});

test('nested sibling moves preserve both child subtrees and never cross their parent boundary', () => {
  const original = outline([['P',0],['A',1],['a',2],['B',1],['b',2],['Q',0]]), moved = moveOutlineBranch(original, 1, 'down');
  assert.deepEqual(ordering(moved.sections), [['P',0],['B',1],['b',2],['A',1],['a',2],['Q',0]]); assert.equal(moved.index, 3);
  assert.deepEqual(outlineBranch(original, 1), { start: 1, end: 3, previous: null, next: 3 }); assert.equal(outlineBranch(original, 3).next, null); assert.deepEqual(moveOutlineBranch(original, 1, 'up').sections, original); assert.deepEqual(moveOutlineBranch(original, 3, 'down').sections, original);
});

test('adding a section inserts a sibling after the entire selected branch at its existing depth', () => {
  const original = outline([['P',0],['A',1],['a',2],['B',1],['Q',0]]), fresh = { id: 'new', title: '', content: '', level: 4 }, root = insertOutlineSibling(original, 0, fresh), nested = insertOutlineSibling(original, 1, fresh);
  assert.deepEqual(ordering(root.sections), [['P',0],['A',1],['a',2],['B',1],['new',0],['Q',0]]); assert.equal(root.index, 4); assert.deepEqual(ordering(nested.sections), [['P',0],['A',1],['a',2],['new',1],['B',1],['Q',0]]); assert.equal(nested.index, 3); assert.equal(fresh.level, 4);
});

test('deleting a section removes its complete branch and clearing the entire outline leaves one editable root', () => {
  const original = outline([['P',0],['A',1],['a',2],['B',1],['Q',0]]), nested = removeOutlineBranch(original, 1), root = removeOutlineBranch(original, 0), empty = removeOutlineBranch(original.slice(0, 4), 0, { id: 'empty', title: '', content: '', level: 4 });
  assert.deepEqual(ordering(nested.sections), [['P',0],['B',1],['Q',0]]); assert.equal(nested.index, 1); assert.deepEqual(ordering(root.sections), [['Q',0]]); assert.equal(root.index, 0); assert.deepEqual(empty, { sections: [{ id: 'empty', title: '', content: '', level: 0 }], index: 0 });
});

test('indenting shifts every descendant uniformly and clamps only unavailable parent or maximum depth', () => {
  const original = outline([['P',0],['A',0],['B',1],['C',2],['Q',0]]), shifted = setOutlineDepth(original, 1, 4);
  assert.deepEqual(outlineDepthBounds(original, 1), { min: 0, max: 1 }); assert.deepEqual(ordering(shifted.sections), [['P',0],['A',1],['B',2],['C',3],['Q',0]]); assert.equal(shifted.index, 1);
  const deep = outline([['P',0],['A',1],['B',2],['C',3],['D',4],['Q',0]]); assert.deepEqual(outlineDepthBounds(deep, 1), { min: 0, max: 1 }); assert.deepEqual(setOutlineDepth(deep, 1, 4).sections, deep); assert.deepEqual(outlineDepthBounds(original, 0), { min: 0, max: 0 }); assert.deepEqual(setOutlineDepth(original, 0, 4).sections, original);
});

test('outdenting a middle child lifts its branch after remaining siblings without adopting them', () => {
  const original = outline([['P',0],['A',1],['B',2],['C',1],['D',0]]), shifted = setOutlineDepth(original, 1, 0);
  assert.deepEqual(ordering(shifted.sections), [['P',0],['C',1],['A',0],['B',1],['D',0]]); assert.equal(shifted.index, 2); assert.deepEqual(ordering(original), [['P',0],['A',1],['B',2],['C',1],['D',0]]);
});

test('outdenting several levels moves the intact branch after the target ancestor subtree', () => {
  const original = outline([['P',0],['A',1],['B',2],['b',3],['C',2],['D',1],['Q',0]]), shifted = setOutlineDepth(original, 2, 0);
  assert.deepEqual(ordering(shifted.sections), [['P',0],['A',1],['C',2],['D',1],['B',0],['b',1],['Q',0]]); assert.equal(shifted.index, 4);
});

test('the section editor moves and removes whole nested branches before saving', async t => {
  let saved; const template = { id: 'custom_branches', title: 'Nested method', description: '', sections: outline([['A',0],['B',1],['C',0]]), revision: 1, builtin: false };
  const f = fixture(t, { api: (url, method, body) => { if (url === `/api/prompts/${template.id}`) return { template }; if (url === '/api/prompts/save') { saved = body.template; return { template: { ...body.template, revision: 2, builtin: false } }; } } }); await f.ui.open(); await f.choose(template.id); await f.action('edit'); await f.action('down'); assert.equal(f.root.querySelector('#prompt-section-title').value, 'A'); await f.action('save'); assert.deepEqual(ordering(saved.sections), [['C',0],['A',0],['B',1]]); await f.action('remove'); await f.action('save'); assert.deepEqual(ordering(saved.sections), [['C',0]]); assert.equal(f.applied.length, 0);
});

test('the section editor selects the lifted branch after standard outdent and preserves sibling parentage', async t => {
  let saved; const template = { id: 'custom_outdent', title: 'Nested method', description: '', sections: outline([['P',0],['A',1],['B',2],['C',1],['D',0]]), revision: 1, builtin: false };
  const f = fixture(t, { api: (url, method, body) => { if (url === `/api/prompts/${template.id}`) return { template }; if (url === '/api/prompts/save') { saved = body.template; return { template: { ...body.template, revision: 2, builtin: false } }; } } }); await f.ui.open(); await f.choose(template.id); await f.action('edit'); await f.action('section', { index: '1' }); await f.input('prompt-section-level', '0'); assert.equal(f.root.querySelector('#prompt-section-title').value, 'A'); assert.equal(f.root.querySelector('[data-prompt-action="up"]').disabled, false); await f.action('save'); assert.deepEqual(ordering(saved.sections), [['P',0],['C',1],['A',0],['B',1],['D',0]]); assert.equal(f.applied.length, 0);
});
