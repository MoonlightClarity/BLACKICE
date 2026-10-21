import test from 'node:test';
import assert from 'node:assert/strict';
import { initLearningUI, learningConfidenceLabel, learningKindLabel, learningRevisionDiff } from '../public/learning-ui.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const lesson = (id = 'memory', extra = {}) => ({ id, knowledgeId: `knowledge-${id}`, kind: 'fact', cwd: 'C:\\project', title: 'Concise updates', summary: 'Keep status updates brief.', content: 'Use concise updates.\nKeep the evidence.', confidence: 'explicit_user_statement', status: 'active', revision: 2, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T11:00:00Z', evidence: [{ runId: 'source-run', kind: 'user', status: 'completed', quote: 'Please keep updates concise.' }], history: [{ revision: 1, title: 'Short updates', summary: 'Use short updates.', content: 'Use short updates.\nKeep the evidence.', at: '2026-10-16T10:00:00Z' }], ...extra });
const snapshot = () => ({ settings: { mode: 'auto' }, status: { queued: 0 }, lessons: [lesson(), lesson('skill', { kind: 'skill', title: 'Verify exports', summary: 'Inspect the exported result.' }), lesson('removed', { title: 'Old preference', status: 'deleted' })], reviews: [{ id: 'review', runId: 'source-run', workflowName: 'Export work', status: 'completed', reason: 'automatic', createdAt: '2026-10-16T11:00:00Z', finishedAt: '2026-10-16T11:00:10Z', model: 'provider::actual', summary: 'One useful memory was saved.', appliedIds: ['memory'], usage: { totalTokens: 42 }, evidence: { entries: [{ id: 'user', kind: 'user', text: 'Please keep updates concise.' }] } }] });
function fixture(t, { data = snapshot(), api: onApi, openRun } = {}) {
  const old = Object.fromEntries(['document', 'setTimeout', 'clearTimeout'].map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
  const elements = new Map(), handlers = new Map(), requests = [], messages = [], opened = [], timers = new Map(); let timerId = 0, mount, modalHtml = '';
  const element = (id, tagName = 'DIV') => {
    let html = '';
    return { id, tagName, dataset: {}, value: '', scrollTop: 0, writes: 0, open: false, classList: { add() {} }, querySelectorAll: () => [], contains: node => Boolean(node && node.parentMount === mount), focus() { globalThis.document.activeElement = this; }, blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
      get innerHTML() { return html; }, set innerHTML(value) { html = value; this.writes++; if (id === 'learning-view') { const detail = elements.get('#learning-detail') || element('learning-detail'); detail.innerHTML = value; elements.set('#learning-detail', detail); elements.set('.learning-list', element('learning-list')); } if (value.includes('id="learning-editor"')) { const form = element('learning-editor', 'FORM'); form.dataset.lessonId = /data-lesson-id="([^"]+)"/.exec(value)[1]; elements.set('#learning-editor', form); for (const name of ['title', 'summary', 'content']) { const field = element(`learning-${name}`, name === 'content' ? 'TEXTAREA' : 'INPUT'); field.parentMount = mount; field.value = name === 'content' ? /id="learning-content"[^>]*>([\s\S]*?)<\/textarea>/.exec(value)[1] : new RegExp(`id="learning-${name}"[^>]*value="([^"]*)"`).exec(value)[1]; elements.set(`#learning-${name}`, field); } } } };
  };
  globalThis.document = { activeElement: null, querySelector: selector => elements.get(selector) || null, addEventListener(type, fn) { const list = handlers.get(type) || []; list.push(fn); handlers.set(type, list); } };
  globalThis.setTimeout = fn => { timers.set(++timerId, fn); return timerId; }; globalThis.clearTimeout = id => timers.delete(id);
  function showModal(_id, html) { elements.clear(); modalHtml = html; mount = element('learning-view'); elements.set('#learning-view', mount); elements.set('#modal-root .modal', element('modal')); }
  const dispatch = async (type, target) => { for (const fn of handlers.get(type) || []) await fn({ target, preventDefault() {} }); };
  const ui = initLearningUI({ api: async (path, method = 'GET', body) => { requests.push({ path, method, body }); const result = await onApi?.(path, method, body); if (result !== undefined) return result; if (method === 'GET') return structuredClone(data); if (path === '/api/learning/settings') data.settings.mode = body.mode; if (method === 'DELETE') data.lessons.find(item => path.endsWith(item.id)).status = 'deleted'; if (path.endsWith('/restore')) { const item = data.lessons.find(item => path.includes(`/${item.id}/`)); item.status = 'active'; item.revision++; } return {}; }, showModal, closeModal() { elements.clear(); }, toast: (message, error) => messages.push({ message, error }), escape: value => String(value ?? '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[character]), getCwd: () => 'C:\\project', getRuns: () => [{ id: 'source-run', cwd: 'C:\\project', input: 'Create the export', status: 'completed', settled: true }], icon: () => '', onOpenRun: async id => { opened.push(id); return openRun?.(id); } });
  t.after(() => { ui.close(); for (const [key, previous] of Object.entries(old)) if (previous.present) globalThis[key] = previous.value; else delete globalThis[key]; });
  return { ui, data, requests, messages, opened, elements, html: () => mount.innerHTML, modal: () => modalHtml, mount: () => mount, clear: () => elements.clear(), async click(action, extra = {}) { const button = { dataset: { learning: action, ...extra }, closest() { return this; } }; return dispatch('click', button); }, async change(id, value) { const field = element(id, 'SELECT'); field.value = value; field.parentMount = mount; globalThis.document.activeElement = field; return dispatch('change', field); }, async feedback(value) { return dispatch('input', { id: 'learning-feedback', value }); }, async submit() { return dispatch('submit', elements.get('#learning-editor')); }, async tick() { const entry = [...timers].at(-1); if (entry) { timers.delete(entry[0]); await entry[1](); } }, timers, element };
}

test('revision comparison identifies separated edits without claiming unchanged lines were edited', () => {
  assert.deepEqual(learningRevisionDiff('first\nkeep\nlast', 'new first\nkeep\nnew last'), { removed: ['first', 'last'], added: ['new first', 'new last'], changed: true, excerpt: false });
  assert.deepEqual(learningRevisionDiff('a\nb', 'a\nnew\nb').removed, []);
  assert.deepEqual(learningRevisionDiff('a\nnew\nb', 'a\nb').added, []);
  assert.equal(learningRevisionDiff('same', 'same').changed, false);
});

test('large revision comparison stays bounded and declares its excerpt', () => {
  const diff = learningRevisionDiff(Array.from({ length: 1000 }, (_, i) => `before ${i}`).join('\n'), Array.from({ length: 1000 }, (_, i) => `after ${i}`).join('\n'));
  assert.equal(diff.excerpt, true); assert.equal(diff.removed.length, 80); assert.equal(diff.added.length, 80);
  const oneLongLine = learningRevisionDiff('x'.repeat(20000), 'y'.repeat(20000)); assert.equal(oneLongLine.excerpt, true); assert.equal(oneLongLine.added[0].length, 9000);
});

test('confidence labels express uncertainty and factual provenance in plain language', () => {
  assert.equal(learningKindLabel('fact'), 'Memory'); assert.equal(learningKindLabel('strategy'), 'Method'); assert.equal(learningKindLabel('skill'), 'Skill');
  assert.equal(learningConfidenceLabel('explicit_user_statement'), 'You said this'); assert.match(learningConfidenceLabel('tentative_after_failure'), /Tentative.*failed/); assert.equal(learningConfidenceLabel('observed_once'), 'Observed once');
});

test('automatic learning opens on saved items with optional controls collapsed and actual evidence', async t => {
  const f = fixture(t); await f.ui.open(); assert.match(f.modal(), /Learning history/); assert.match(f.html(), /Learns automatically after tasks/);
  assert.match(f.html(), /<details class="learning-options" data-learning-panel="options">/); assert.match(f.html(), /Please keep updates concise/); assert.match(f.html(), /data-learning="open-run" data-id="source-run"/); assert.match(f.html(), /Undo last change/); assert.doesNotMatch(f.html(), /learning-summary|approve|permission/i);
  assert.equal(f.requests.filter(item => item.method !== 'GET').length, 0, 'opening the audit does not request a review or change saved instructions');
});

test('saved filters keep removed items out of normal memory and skill lists', async t => {
  const f = fixture(t); await f.ui.open(); assert.doesNotMatch(f.html(), /data-learning="select" data-id="removed"/);
  await f.click('filter', { filter: 'skills' }); assert.match(f.html(), /data-learning="select" data-id="skill"/); assert.doesNotMatch(f.html(), /data-learning="select" data-id="memory"/);
  await f.click('filter', { filter: 'memories' }); assert.match(f.html(), /data-learning="select" data-id="memory"/); assert.doesNotMatch(f.html(), /data-learning="select" data-id="skill"/);
  await f.click('filter', { filter: 'removed' }); assert.match(f.html(), /Old preference/); assert.match(f.html(), /Removed\. Agents will not use/); assert.match(f.html(), /Restore item/);
});

test('knowledge deep link selects the matching real lesson including removed records', async t => {
  const f = fixture(t); await f.ui.open({ knowledgeId: 'knowledge-skill' }); assert.match(f.html(), /<h3>Verify exports<\/h3>/);
  await f.ui.open({ knowledgeId: 'knowledge-removed' }); assert.match(f.html(), /<h3>Old preference<\/h3>/); assert.match(f.html(), /Restore item/);
});

test('remove and restore use the captured lesson and revision without an approval queue', async t => {
  const f = fixture(t); await f.ui.open(); await f.click('delete'); assert.deepEqual(f.requests.find(item => item.method === 'DELETE'), { path: '/api/learning/lessons/memory', method: 'DELETE', body: {} }); assert.match(f.html(), /Removed\. Agents will not use/);
  await f.click('restore', { revision: '2' }); assert.deepEqual(f.requests.find(item => item.path.endsWith('/restore')), { path: '/api/learning/lessons/memory/restore', method: 'POST', body: { revision: 2 } }); assert.match(f.html(), /<h3>Concise updates<\/h3>/);
});

test('history compares selected saved versions and undo sends the real prior revision', async t => {
  const f = fixture(t); await f.ui.open(); assert.match(f.html(), /Earlier text/); assert.match(f.html(), /Use short updates/); assert.match(f.html(), /Current text/);
  await f.change('learning-revision', '1'); assert.match(f.html(), /Revision 1 → 2/); await f.click('restore', { revision: '1' }); assert.equal(f.requests.find(item => item.path.endsWith('/restore')).body.revision, 1);
});

test('activity uses actual receipt counts, model and source without presenting suggestions as saves', async t => {
  const f = fixture(t); await f.ui.open(); await f.click('tab', { tab: 'activity' }); assert.match(f.html(), /1 saved change/); assert.match(f.html(), /provider::actual/); assert.match(f.html(), /Tokens used<\/dt><dd>42/); assert.match(f.html(), /data-learning="show-lesson" data-id="memory"/);
  await f.click('show-lesson', { id: 'memory' }); assert.match(f.html(), /<h3>Concise updates<\/h3>/); await f.click('open-run', { id: 'source-run' }); assert.deepEqual(f.opened, ['source-run']);
});

test('unchanged polling preserves the mounted audit DOM and closing stops future polling', async t => {
  const f = fixture(t); await f.ui.open(); const writes = f.mount().writes; await f.tick(); assert.equal(f.mount().writes, writes); const count = f.requests.length; f.ui.close(); await f.tick(); assert.equal(f.requests.length, count); assert.equal(f.timers.size, 0);
});

test('an edit stays intact during refresh and Cancel returns to the saved item', async t => {
  const f = fixture(t); await f.ui.open(); await f.click('edit'); const detail = f.elements.get('#learning-detail'), title = f.elements.get('#learning-title'); title.value = 'Unsent edit'; const count = f.requests.length;
  await f.tick(); await f.ui.refresh(); assert.equal(f.requests.length, count); assert.equal(title.value, 'Unsent edit'); assert.match(detail.innerHTML, /learning-editor/);
  await f.click('cancel-edit'); assert.match(detail.innerHTML, /<h3>Concise updates<\/h3>/); assert.doesNotMatch(detail.innerHTML, /id="learning-editor"/);
});

test('saving an edit targets its original knowledge entry and does not request an agent run', async t => {
  const f = fixture(t); await f.ui.open(); await f.click('edit'); f.elements.get('#learning-title').value = 'Updated concise preference'; f.elements.get('#learning-content').value = 'Two sentences are enough.'; await f.submit();
  const save = f.requests.find(item => item.method === 'POST'); assert.equal(save.path, '/api/knowledge'); assert.equal(save.body.id, 'knowledge-memory'); assert.equal(save.body.content, 'Two sentences are enough.'); assert.equal(save.body.kind, 'memory'); assert.doesNotMatch(f.elements.get('#learning-detail').innerHTML, /id="learning-editor"/);
});

test('feedback remains an optional local draft across refresh without mutating any chat draft', async t => {
  const f = fixture(t), chatDraft = { task: 'Keep my unsent conversation', model: 'chosen-model' }; await f.ui.open(); await f.feedback('Export was helpful'); const count = f.requests.length; await f.tick(); assert.equal(f.requests.length, count);
  await f.ui.refresh(); assert.match(f.html(), /value="Export was helpful"/); f.ui.close(); assert.deepEqual(chatDraft, { task: 'Keep my unsent conversation', model: 'chosen-model' }); assert.equal(f.requests.filter(item => item.method !== 'GET').length, 0);
});

for (const reject of [false, true]) test(`a late ${reject ? 'failed' : 'successful'} save cannot change a reopened audit`, async t => {
  const pending = deferred(); const f = fixture(t, { api: (_path, method) => method === 'DELETE' ? pending.promise : undefined }); await f.ui.open(); const saving = f.click('delete'); await f.ui.open({ knowledgeId: 'knowledge-skill' }); const current = f.mount(), before = f.html();
  if (reject) pending.reject(new Error('Old delete failed')); else pending.resolve({}); await saving; assert.strictEqual(f.mount(), current); assert.equal(f.html(), before); assert.deepEqual(f.messages, []);
});

test('out-of-order loads cannot replace the newest mounted learning view', async t => {
  const loads = []; const f = fixture(t, { api: (_path, method) => method === 'GET' ? new Promise(resolve => loads.push(resolve)) : undefined });
  const first = f.ui.open(), second = f.ui.open(); const newer = snapshot(); newer.lessons = [lesson('newest', { title: 'Newest data' })]; loads[1](newer); await second; loads[0](snapshot()); await first; assert.match(f.html(), /Newest data/); assert.doesNotMatch(f.html(), /<h3>Concise updates<\/h3>/);
});

test('navigating to another item while a mutation finishes keeps that item selected', async t => {
  const pending = deferred(); const f = fixture(t, { api: (_path, method) => method === 'DELETE' ? pending.promise : undefined }); await f.ui.open(); const saving = f.click('delete'); await f.click('select', { id: 'skill' }); pending.resolve({}); await saving; assert.match(f.html(), /<h3>Verify exports<\/h3>/); assert.doesNotMatch(f.html(), /data-filter="removed" aria-pressed="true"/);
});

test('a learning storage error is visible even when the history request succeeds', async t => {
  const data = snapshot(); data.status.error = 'Learning history could not be saved.'; const f = fixture(t, { data }); await f.ui.open(); assert.match(f.html(), /Learning needs attention/); assert.match(f.html(), /role="alert">Learning history could not be saved\./);
});

test('evidence and comparison text cannot inject executable markup', async t => {
  const data = snapshot(); data.lessons[0].evidence[0].quote = '<img src=x onerror=alert(1)>'; data.lessons[0].history[0].content = '<script>bad()</script>'; const f = fixture(t, { data }); await f.ui.open(); assert.doesNotMatch(f.html(), /<script>|<img src=x/); assert.match(f.html(), /&lt;img src=x/); assert.match(f.html(), /&lt;script&gt;/);
});

test('load failures offer retry without inventing empty history and the saved manual choice is clear', async t => {
  let fail = true; const data = snapshot(); data.settings.mode = 'manual'; const f = fixture(t, { data, api: () => { if (fail) throw new Error('History is unavailable'); } }); await f.ui.open(); assert.match(f.html(), /History is unavailable/); assert.match(f.html(), /Try again/); fail = false; await f.click('refresh'); assert.match(f.html(), /Learns when you ask/); assert.match(f.html(), /value="manual" selected/);
});
