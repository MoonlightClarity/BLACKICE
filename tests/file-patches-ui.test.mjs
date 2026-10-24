import test from 'node:test';
import assert from 'node:assert/strict';
import { initFilePatchesUI, patchComparison, patchFileName } from '../public/file-patches-ui.mjs';

const held = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const patch = (id = 'patch-one', overrides = {}) => ({ id, path: 'C:\\project\\src\\app.js', cwd: 'C:\\project', at: '2026-10-16T16:30:00Z', action: 'patch', source: 'agent', runId: 'source-chat', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), status: 'applied', ...overrides });
const record = (id = 'patch-one', overrides = {}) => ({ ...patch(id), before: 'const result = 1;\n', after: 'const result = 2;\n', ...overrides });
const page = records => ({ patches: records, total: records.length, hasMore: false, damaged: 0 });

// Only event and markup behavior is modeled; the production UI owns every handler.
function surface(t) {
  const previous = globalThis.document, nodes = new Map(); let mount, modal, focus, style;
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  function remove(node) { for (const child of node.children) remove(child); if (node.id && nodes.get(node.id) === node) nodes.delete(node.id); }
  function make(attributes = '') {
    const node = { children: [], dataset: {}, disabled: /\sdisabled\b/.test(attributes), textContent: '', hidden: false, value: '', classList: { add() {} }, focus() { focus = this; }, closest(selector) { return selector === '[data-patch-action]' && this.dataset.patchAction ? this : null; } };
    for (const match of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
      const value = decode(match[2]);
      if (match[1] === 'id') { node.id = value; nodes.set(value, node); }
      if (match[1] === 'value') node.value = value;
      if (match[1].startsWith('data-')) node.dataset[match[1].slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
    Object.defineProperty(node, 'innerHTML', { get() { return this.markup || ''; }, set(value) {
      for (const child of this.children) remove(child); this.children = []; this.markup = value;
      for (const match of value.matchAll(/<(?:button|div|span|select|pre|article|p)[\s>]([^>]*?)>/g)) this.children.push(make(match[1]));
    } });
    node.querySelectorAll = selector => {
      const name = selector.match(/^\[data-patch-action="([^"]+)"\]$/)?.[1], found = [];
      const visit = parent => { for (const child of parent.children) { if (child.dataset.patchAction === name) found.push(child); visit(child); } }; visit(node); return found;
    };
    return node;
  }
  globalThis.document = { getElementById: id => id === 'relay-file-patches-styles' ? style : nodes.get(id), createElement: () => ({}), head: { append(link) { style = link; } }, querySelector: selector => selector === '#modal-root .modal' ? modal : nodes.get(selector.slice(1)) };
  t.after(() => { globalThis.document = previous; });
  const showModal = (type, html) => { nodes.clear(); modal = make(); modal.innerHTML = html; mount = nodes.get('file-patches-view'); };
  const closeModal = () => { nodes.clear(); mount = null; modal = null; };
  return { showModal, closeModal, node: id => nodes.get(id), mount: () => mount, focused: () => focus, style: () => style,
    markup: () => { const collect = node => (node?.innerHTML || '') + (node?.children || []).map(collect).join(''); return collect(mount); },
    button(action, id) { const all = mount?.querySelectorAll(`[data-patch-action="${action}"]`) || []; return all.find(button => !id || button.dataset.id === id); },
    async click(action, id) { const button = this.button(action, id); assert.ok(button, `Missing ${action} button`); return mount.onclick({ target: button }); },
    async scope(value) { const select = nodes.get('file-patches-scope'); select.value = value; select.onchange({ target: select }); await turn(); },
  };
}

function fixture(t, responder, options = {}) {
  const dom = surface(t), requests = [], opened = [], notices = [];
  const ui = initFilePatchesUI({ ...dom, getCwd: () => 'C:\\project', api: async (url, method, body) => { requests.push({ url, method, body }); return responder(url, method, body); }, toast: (...args) => notices.push(args), onOpenRun: async id => opened.push(id), ...options });
  return { ui, dom, requests, opened, notices };
}

test('patch previews include late changes, remain bounded and identify line-ending changes', () => {
  const long = 'x'.repeat(100000), comparison = patchComparison(`${long}old\nend`, `${long}new\nend`);
  assert.match(comparison.before.text, /old/); assert.match(comparison.after.text, /new/); assert.ok(comparison.before.text.length <= 24000); assert.equal(comparison.before.omittedBefore, true);
  const lines = patchComparison(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'), 'replacement\n'.repeat(500));
  assert.ok(lines.before.text.split('\n').length <= 121); assert.equal(lines.after.omittedAfter, true);
  assert.equal(patchComparison('hello\r\n', 'hello\n').lineEndingsOnly, true);
  assert.equal(patchFileName('C:\\project\\SOUL.md'), 'SOUL.md'); assert.equal(patchFileName('/work/src/app.ts'), 'app.ts');
});

test('opening the viewer loads only receipt metadata and preserves its folder filter across opens', async t => {
  const f = fixture(t, () => page([patch()])); await f.ui.open();
  assert.equal(f.requests.length, 1); const query = new URL(f.requests[0].url, 'http://relay.local').searchParams;
  assert.equal(query.get('cwd'), 'C:\\project'); assert.equal(query.get('limit'), '30');
  assert.match(f.dom.markup(), /app\.js/); assert.match(f.dom.markup(), /Agent/); assert.doesNotMatch(f.dom.markup(), /const result/);
  assert.equal(f.dom.style().href, '/file-patches.css');
  await f.dom.scope('all'); f.dom.closeModal(); await f.ui.open();
  assert.equal(new URL(f.requests.at(-1).url, 'http://relay.local').searchParams.has('cwd'), false);
});

test('expansion renders saved before and after text safely and source chat opens its exact conversation', async t => {
  const f = fixture(t, url => url.includes('?') ? page([patch()]) : record('patch-one', { before: '<script>before()</script>', after: '<img src=x onerror=after()>' })); await f.ui.open(); await f.dom.click('expand', 'patch-one');
  assert.match(f.dom.markup(), /&lt;script&gt;before\(\)&lt;\/script&gt;/); assert.match(f.dom.markup(), /&lt;img src=x onerror=after\(\)&gt;/);
  assert.doesNotMatch(f.dom.markup(), /<script>|<img src=x/); assert.match(f.dom.markup(), /Before hash/); assert.match(f.dom.markup(), /Source chat/);
  await f.dom.click('source', 'patch-one'); assert.deepEqual(f.opened, ['source-chat']); assert.equal(f.dom.mount(), null);
});

test('Undo applies immediately, remains single-flight, and records the result without approval', async t => {
  const pending = held(); let reads = 0;
  const f = fixture(t, (url, method) => method === 'POST' ? pending.promise : url.includes('?') ? (++reads, page([patch()])) : record());
  await f.ui.open(); await f.dom.click('expand', 'patch-one'); const undoing = f.dom.click('undo', 'patch-one'); await turn(); await f.dom.click('undo', 'patch-one');
  const calls = f.requests.filter(request => request.method === 'POST'); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/file-patches/patch-one/undo'); assert.deepEqual(calls[0].body, {});
  pending.resolve(patch('undo-one', { action: 'undo', undoOf: 'patch-one', source: 'user' })); await undoing;
  assert.equal(reads, 2); assert.equal(f.dom.node('file-patches-message').textContent, 'Change undone.'); assert.equal(f.dom.button('undo', 'patch-one').disabled, true); assert.match(f.dom.markup(), /Undo saved/);
});

test('a newer-file conflict is readable and never retries or overwrites the saved preview', async t => {
  const f = fixture(t, (url, method) => { if (method === 'POST') throw Object.assign(new Error('This file has newer changes.'), { status: 409 }); return url.includes('?') ? page([patch()]) : record(); });
  await f.ui.open(); await f.dom.click('expand', 'patch-one'); await f.dom.click('undo', 'patch-one');
  assert.match(f.dom.node('file-patches-message').textContent, /newer changes\. Nothing was overwritten/); assert.match(f.dom.markup(), /const result = 2/); assert.equal(f.requests.filter(request => request.method === 'POST').length, 1); assert.equal(f.dom.button('undo', 'patch-one').disabled, false);
});

test('late scope reads cannot replace a newer filter and its page', async t => {
  const pending = held(), f = fixture(t, url => new URL(url, 'http://relay.local').searchParams.has('cwd') ? pending.promise : page([patch('all-folders', { path: 'D:\\other\\global.md' })]));
  const opening = f.ui.open(); await turn(); await f.dom.scope('all'); pending.resolve(page([patch('old-folder')])); await opening;
  assert.match(f.dom.markup(), /global\.md/); assert.doesNotMatch(f.dom.markup(), /data-id="old-folder"/);
});

test('late receipt text cannot replace another expanded receipt or a closed dialog', async t => {
  const pending = held(), f = fixture(t, url => url.includes('?') ? page([patch('one'), patch('two')]) : url.endsWith('/one') ? pending.promise : record('two', { before: 'second before', after: 'second after' }));
  await f.ui.open(); const opening = f.dom.click('expand', 'one'); await turn(); await f.dom.click('expand', 'two'); pending.resolve(record('one', { before: 'stale text', after: 'stale result' })); await opening;
  assert.match(f.dom.markup(), /second after/); assert.doesNotMatch(f.dom.markup(), /stale text/);
  const another = held(), g = fixture(t, url => url.includes('?') ? page([patch()]) : another.promise); await g.ui.open(); const reading = g.dom.click('expand', 'patch-one'); g.dom.closeModal(); another.resolve(record()); await reading; assert.equal(g.dom.mount(), null);
});

test('closing and reopening during Undo cannot resubmit or leave its new view stuck', async t => {
  const pending = held(), f = fixture(t, (url, method) => method === 'POST' ? pending.promise : url.includes('?') ? page([patch()]) : record());
  await f.ui.open(); await f.dom.click('expand', 'patch-one'); const undoing = f.dom.click('undo', 'patch-one'); f.dom.closeModal(); await f.ui.open(); await f.dom.click('expand', 'patch-one');
  assert.match(f.dom.markup(), /Undoing/); await f.dom.click('undo', 'patch-one'); const count = f.requests.length;
  pending.resolve(patch('undo-one', { action: 'undo', undoOf: 'patch-one' })); await undoing;
  assert.equal(f.requests.length, count, 'late Undo completion does not refresh the replacement view'); assert.equal(f.requests.filter(request => request.method === 'POST').length, 1); assert.match(f.dom.markup(), /Undo saved/); assert.equal(f.dom.node('file-patches-message').textContent, '');
});

test('uncertain Undo outcomes remain explicit and are never replayed automatically', async t => {
  const f = fixture(t, (url, method) => { if (method === 'POST') throw Object.assign(new Error('Timeout'), { uncertain: true }); return url.includes('?') ? page([patch()]) : record(); });
  await f.ui.open(); await f.dom.click('expand', 'patch-one'); await f.dom.click('undo', 'patch-one');
  assert.match(f.dom.node('file-patches-message').textContent, /may have completed.*Refresh/); assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('pagination requests the actual next history page, while non-applied records have no Undo action', async t => {
  const f = fixture(t, url => url.includes('?') ? { patches: [patch('page-item', { status: 'not_applied' })], total: 61, hasMore: new URL(url, 'http://relay.local').searchParams.get('offset') === '0' } : record('page-item', { status: 'not_applied' }));
  await f.ui.open(); await f.dom.click('next'); assert.equal(new URL(f.requests.at(-1).url, 'http://relay.local').searchParams.get('offset'), '30');
  await f.dom.click('expand', 'page-item'); assert.equal(f.dom.button('undo'), undefined); await f.dom.click('previous'); assert.equal(new URL(f.requests.at(-1).url, 'http://relay.local').searchParams.get('offset'), '0');
});

test('an unreadable receipt collection is visible even when it has no readable rows',async t=>{
  const f=fixture(t,()=>({...page([]),damaged:2}));await f.ui.open();
  assert.match(f.dom.markup(),/2 receipts could not be read/);assert.equal(f.requests.length,1);
});

test('closed and replaced viewers ignore late metadata from their earlier session',async t=>{
  const pending=held();let reads=0;const f=fixture(t,()=>++reads===1?pending.promise:page([patch('new-session',{path:'C:\\project\\fresh.md'})]));
  const first=f.ui.open();await turn();f.dom.closeModal();await f.ui.open();pending.resolve(page([patch('old-session')]));await first;
  assert.match(f.dom.markup(),/fresh\.md/);assert.doesNotMatch(f.dom.markup(),/data-id="old-session"/);assert.equal(f.notices.length,0);
});
