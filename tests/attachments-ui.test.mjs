import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initAttachmentsUI, pastedFiles, pastedImageFiles } from '../public/attachments-ui.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let count = 0; count < 6; count++) await turn(); };
const escaped = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const file = (name = 'screenshot.png', type = 'image/png', text = 'pixels', size = text.length) => ({ name, type, size, async arrayBuffer() { return new TextEncoder().encode(text).buffer; } });
const metadata = (id, name, size = 6) => ({ id, name, size, kind: 'image', mime: 'image/png', width: 2, height: 3, sha256: 'fixture' });

function fixture({ upload, pickFiles, initial = [], saved = [] } = {}) {
  const elements = new Map(), drafts = { a: [...initial], b: [] }, changes = [], calls = [], saves = [];
  let current = 'a', unlocked = true;
  const element = selector => {
    if (elements.has(selector)) return elements.get(selector);
    const listeners = new Map(), classes = new Set(), node = {
      innerHTML: '', textContent: '', disabled: false, readOnly: false, value: '', dataset: {}, tagName: 'DIV',
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), toggle: (value, force) => force ? classes.add(value) : classes.delete(value), contains: value => classes.has(value) },
      querySelector: element, querySelectorAll: () => [],
      closest(query) { return query === 'form' ? element('form') : query === '[data-attachment-action]' && this.dataset.attachmentAction ? this : null; },
      addEventListener(type, listener) { const values = listeners.get(type) || []; values.push(listener); listeners.set(type, values); },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(value => value !== listener)); },
      dispatch(type, event = {}) { return Promise.all((listeners.get(type) || []).map(listener => listener(event))); },
      click() { this.clicked = true; },
    };
    elements.set(selector, node); return node;
  };
  const mount = element('mount'), form = element('form'), textarea = element('textarea'); textarea.tagName = 'TEXTAREA';
  const ui = initAttachmentsUI({ mount, getDraftKey: () => current, getIds: key => drafts[key], setIds: (ids, key) => { saves.push({ key, ids: [...ids] }); drafts[key] = [...ids]; }, canEdit: () => unlocked,
    onPendingChange: (pending, count) => changes.push({ key: current, pending, count }), escape: escaped, icon: () => '', pickFiles,
    api: async (url, method, body) => { calls.push({ url, method, body }); if (url === '/api/attachments') return saved; return upload ? upload(url, body) : metadata(`file-${calls.length}`, body.name); },
  });
  return { ui, mount, form, textarea, element, drafts, changes, calls, saves, switchTo(key) { current = key; ui.reset({ cancelPending: false }); }, lock(value = true) { unlocked = !value; ui.refreshEditability(); } };
}

test('clipboard extraction accepts every actual File while text, HTML and URL strings stay ordinary paste data', () => {
  const image = file(), text = file('notes.txt', 'text/plain'), pdf = file('report.pdf', 'application/pdf'), binary = file('data.custom', 'application/x-opaque');
  assert.equal(pastedImageFiles, pastedFiles, 'existing imports retain the expanded File behavior');
  assert.deepEqual(pastedFiles({ files: [image, text, pdf, binary], items: [{ kind: 'file', type: image.type, getAsFile: () => image }] }), [image, text, pdf, binary], 'files and item representations are not duplicated');
  assert.deepEqual(pastedFiles({ items: [{ kind: 'string', type: 'text/plain' }, { kind: 'string', type: 'text/html' }, { kind: 'string', type: 'text/uri-list' }] }), []);
  assert.deepEqual(pastedFiles({ items: [{ kind: 'file', type: binary.type, getAsFile: () => binary }, { kind: 'file', type: text.type, getAsFile: () => text }, { kind: 'file', type: 'application/pdf', getAsFile: () => null }] }), [binary, text]);
});

test('pasting a screenshot uploads its exact bytes and leaves ordinary or mixed text paste alone', async () => {
  const f = fixture(); let prevented = 0;
  const paste = (files, text = '') => f.form.dispatch('paste', { target: f.textarea, clipboardData: { files, getData: () => text }, preventDefault() { prevented++; } });
  await paste([], 'plain text'); await settle(); assert.equal(f.calls.filter(call => call.method).length, 0); assert.equal(prevented, 0);
  await paste([file('screen.png', 'image/png', '\0pixels')]); await settle();
  const uploaded = f.calls.find(call => call.url.endsWith('/upload')); assert.equal(uploaded.body.name, 'screen.png'); assert.equal(Buffer.from(uploaded.body.dataBase64, 'base64').toString(), '\0pixels');
  assert.equal(prevented, 1); assert.equal(f.drafts.a.length, 1); assert.equal(f.ui.isPending(), false);
  await paste([file('second.png')], 'copied caption'); await settle(); assert.equal(prevented, 1, 'the browser must still insert mixed clipboard text'); assert.equal(f.drafts.a.length, 2);
  f.ui.destroy();
});

test('pasted arbitrary File items retain exact bytes and originating draft without swallowing mixed text or inventing image names', async () => {
  const bytes = Uint8Array.from([0, 255, 1, 2, 128, 65, 66]); let release, prevented = 0;
  const opaqueMetadata = (id, name) => ({ id, name, kind: 'file', mime: 'application/octet-stream', extension: 'bin', size: bytes.length, sha256: 'fixture' });
  const f = fixture({ upload: (url, body) => body.name === 'clipboard.custom' ? new Promise(resolve => { release = resolve; }) : opaqueMetadata('unnamed-id', body.name) });
  const opaque = { name: 'clipboard.custom', type: 'application/x-arbitrary-file', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  const paste = (items, text = '') => f.form.dispatch('paste', { target: f.textarea, clipboardData: { files: [], items, getData: () => text }, preventDefault() { prevented++; } });
  await paste([{ kind: 'string', type: 'text/uri-list' }, { kind: 'string', type: 'text/html' }], 'https://example.test/source'); await settle();
  assert.equal(f.calls.filter(call => call.method).length, 0); assert.equal(prevented, 0);
  await paste([{ kind: 'file', type: opaque.type, getAsFile: () => opaque }, { kind: 'string', type: 'text/plain' }], 'Keep this copied note.');
  await turn(); assert.equal(f.ui.isPending(), true); f.switchTo('b'); release(opaqueMetadata('opaque-id', opaque.name)); await settle();
  assert.equal(prevented, 0, 'mixed text still reaches the browser textarea'); assert.deepEqual(f.drafts.a, ['opaque-id']); assert.deepEqual(f.drafts.b, []);
  const upload = f.calls.find(call => call.url.endsWith('/upload')); assert.equal(upload.body.name, opaque.name); assert.deepEqual(Buffer.from(upload.body.dataBase64, 'base64'), Buffer.from(bytes));
  await paste([{ kind: 'file', type: opaque.type, getAsFile: () => ({ ...opaque, name: '' }) }]); await settle();
  assert.equal(prevented, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/upload')).at(-1).body.name, 'pasted-file'); assert.deepEqual(f.drafts.b, ['unnamed-id']);
  assert.equal(f.ui.isPending(), false); f.ui.destroy();
});

test('paste outside message fields and paste while sending never imports clipboard files', async () => {
  const f = fixture(); const imageEvent = target => ({ target, clipboardData: { files: [file()], getData: () => '' }, preventDefault() {} });
  const folder = f.element('folder'); folder.tagName = 'INPUT'; await f.form.dispatch('paste', imageEvent(folder));
  f.lock(); await f.form.dispatch('paste', imageEvent(f.textarea)); f.lock(false); f.textarea.readOnly = true; await f.form.dispatch('paste', imageEvent(f.textarea));
  await settle(); assert.deepEqual(f.calls.filter(call => call.method), []); f.ui.destroy();
});

test('file drops use the File bytes, never a guessed local path, and show a whole-composer target', async () => {
  const f = fixture(); let prevented = 0, stopped = 0;
  const transfer = { types: ['Files'], files: [{ ...file('drop.txt', 'text/plain', 'dropped'), path: 'C:\\private\\must-not-read.txt' }] };
  const event = { dataTransfer: transfer, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  await f.form.dispatch('dragenter', event); assert.equal(f.form.classList.contains('dragging-attachments'), true);
  await f.form.dispatch('dragover', event); assert.equal(transfer.dropEffect, 'copy');
  await f.form.dispatch('drop', event); await settle();
  assert.equal(f.form.classList.contains('dragging-attachments'), false); assert.equal(f.mount.classList.contains('dragging-files'), false);
  assert.equal(f.calls.some(call => call.url.endsWith('/import')), false); assert.equal(f.calls.find(call => call.method).body.name, 'drop.txt'); assert.equal(stopped, 1); assert.equal(prevented, 3); f.ui.destroy();
});

test('accepted uploads finish into their originating chat while another chat is sending', async () => {
  let release;
  const f = fixture({ upload: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.ui.addFiles([file('origin.png')]); await turn(); assert.equal(f.ui.isPending(), true);
  f.switchTo('b'); assert.equal(f.ui.isPending(), false); f.lock();
  release(metadata('origin-id', 'origin.png')); await pending;
  assert.deepEqual(f.drafts.a, ['origin-id']); assert.deepEqual(f.drafts.b, []); assert.deepEqual(f.saves, [{ key: 'a', ids: ['origin-id'] }]);
  assert.deepEqual(f.changes.at(-1), { key: 'b', pending: false, count: 0 });
  f.lock(false); f.switchTo('a'); assert.match(f.element('.attachments-file-list').innerHTML, /origin\.png/); f.ui.destroy();
});

test('queued uploads for two drafts keep separate file limits and destinations', async () => {
  let release;
  const f = fixture({ initial: Array.from({ length: 9 }, (_, index) => `old-${index}`), upload: (url, body) => body.name === 'a.png' ? new Promise(resolve => { release = resolve; }) : metadata('b-id', body.name) });
  const a = f.ui.addFiles([file('a.png')]); await turn();
  f.switchTo('b'); const b = f.ui.addFiles([file('b.png')]); assert.equal(f.ui.isPending(), true);
  release(metadata('a-id', 'a.png')); await Promise.all([a, b]);
  assert.equal(f.drafts.a.length, 10); assert.deepEqual(f.drafts.b, ['b-id']); assert.equal(f.ui.isPending(), false); f.ui.destroy();
});

test('consuming or destroying a draft prevents a delayed upload from reattaching itself', async () => {
  for (const action of ['reset', 'destroy']) {
    let release; const f = fixture({ upload: () => new Promise(resolve => { release = resolve; }) });
    const pending = f.ui.addFiles([file()]); await turn(); f.ui[action](); release(metadata('late-id', 'late.png')); await pending;
    assert.deepEqual(f.saves, []); assert.equal(f.ui.isPending(), false);
    if (action === 'reset') f.ui.destroy();
    await f.form.dispatch('paste', { target: f.textarea, clipboardData: { files: [file()] }, preventDefault() {} }); await settle();
    assert.equal(f.calls.filter(call => call.method).length, 1, 'destroy removes event listeners');
  }
});

test('late native file picker results cannot attach to a different chat', async () => {
  let release; const f = fixture({ pickFiles: () => new Promise(resolve => { release = resolve; }) });
  const button = f.element('choose'); button.dataset.attachmentAction = 'choose';
  const picking = f.mount.dispatch('click', { target: button }); f.switchTo('b'); release({ filePaths: ['C:\\fixture\\chosen.txt'] }); await picking;
  assert.deepEqual(f.calls.filter(call => call.method), []); assert.deepEqual(f.drafts.b, []); f.ui.destroy();
});

test('file count and byte limits reject excess work before reading or uploading it', async () => {
  let reads = 0; const oversized = { ...file(), size: 10 * 1024 * 1024 + 1, async arrayBuffer() { reads++; return new ArrayBuffer(0); } };
  const f = fixture(); await f.ui.addFiles([oversized]); assert.equal(reads, 0); assert.equal(f.calls.filter(call => call.method).length, 0); assert.match(f.element('.attachments-error-list').innerHTML, /10 MiB/);
  await f.ui.addFiles(Array.from({ length: 12 }, (_, index) => file(`file-${index}.png`)));
  assert.equal(f.drafts.a.length, 10); assert.equal(f.calls.filter(call => call.method).length, 10); assert.match(f.element('.attachments-error-list').innerHTML, /up to 10 files/); f.ui.destroy();
});

test('aggregate task size is checked before another file is read', async () => {
  const saved = Array.from({ length: 5 }, (_, index) => metadata(`large-${index}`, `large-${index}.png`, 10 * 1024 * 1024));
  const f = fixture({ saved, initial: saved.map(entry => entry.id) }); await settle(); let reads = 0;
  await f.ui.addFiles([{ ...file(), async arrayBuffer() { reads++; return new ArrayBuffer(1); } }]);
  assert.equal(reads, 0); assert.equal(f.calls.filter(call => call.method).length, 0); assert.match(f.element('.attachments-error-list').innerHTML, /50 MiB/); f.ui.destroy();
});

test('failed imports remain human readable in their own draft and do not block later files', async () => {
  let reject;
  const f = fixture({ upload: (url, body) => body.name === 'bad.png' ? new Promise((resolve, no) => { reject = no; }) : metadata('good-id', body.name) });
  const bad = f.ui.addFiles([file('bad.png')]); await turn(); f.switchTo('b'); reject(new Error('Network unavailable. Try again.')); await bad;
  assert.equal(f.element('.attachments-error-list').innerHTML, ''); await f.ui.addFiles([file('good.png')]); assert.deepEqual(f.drafts.b, ['good-id']);
  f.switchTo('a'); assert.match(f.element('.attachments-error-list').innerHTML, /bad\.png/); assert.match(f.element('.attachments-error-list').innerHTML, /Network unavailable/); assert.equal(f.ui.isPending(), false); f.ui.destroy();
});


test('both file pickers and drop or paste guidance accept every file type', async () => {
  const f = fixture();
  const input = /<input[^>]*class="attachments-file-input"[^>]*>/.exec(f.mount.innerHTML)?.[0];
  assert.ok(input); assert.doesNotMatch(input, /\baccept=/, 'the browser picker has no MIME or extension restrictions');
  assert.match(f.mount.innerHTML, /title="Attach any file"/); assert.match(f.mount.innerHTML, /Any file · 10 MiB per file/); assert.match(f.mount.innerHTML, /Drop files · Paste files/);
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8'), start = main.indexOf("handle('relay:pick-files'");
  assert.ok(start >= 0); const picker = main.slice(start, main.indexOf("ipcMain.handle(", start));
  assert.match(picker, /filters: \[\{ name: 'All files', extensions: \['\*'\] \}\]/, 'the native picker defaults to every file, with no restrictive format list');
  const pdf = file('report.pdf', 'application/pdf'); assert.deepEqual(pastedFiles({ files: [pdf] }), [pdf], 'an actual PDF File from the clipboard is attachable');
  f.ui.destroy();
});

test('dropped PDFs keep their exact bytes and originating draft, and chips show returned page counts', async () => {
  let release;
  const pdfMetadata = (id, name, pageCount) => ({ id, name, pageCount, kind: 'pdf', mime: 'application/pdf', extension: 'pdf', size: 40, sha256: 'fixture' });
  const f = fixture({ upload: (url, body) => body.name === 'one-page.pdf' ? new Promise(resolve => { release = resolve; }) : pdfMetadata('pdf-three', body.name, 3) });
  const files = [file('one-page.pdf', 'application/pdf', '%PDF-1.4\none-page bytes'), file('three-pages.pdf', 'application/pdf', '%PDF-1.4\nthree-page bytes')];
  let prevented = 0, stopped = 0;
  await f.form.dispatch('drop', { dataTransfer: { types: ['Files'], files }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  await turn(); assert.equal(f.ui.isPending(), true); f.switchTo('b'); release(pdfMetadata('pdf-one', 'one-page.pdf', 1)); await settle();
  assert.equal(f.element('.attachments-file-list').innerHTML, ''); assert.deepEqual(f.drafts.b, []); assert.deepEqual(f.drafts.a, ['pdf-one', 'pdf-three']);
  const uploads = f.calls.filter(call => call.url === '/api/attachments/upload'); assert.equal(uploads.length, 2);
  for (const [index, upload] of uploads.entries()) { assert.equal(upload.body.name, files[index].name); assert.equal(Buffer.from(upload.body.dataBase64, 'base64').toString(), index ? '%PDF-1.4\nthree-page bytes' : '%PDF-1.4\none-page bytes'); }
  assert.equal(f.calls.some(call => call.url.endsWith('/import')), false); assert.equal(prevented, 1); assert.equal(stopped, 1);
  f.switchTo('a'); assert.match(f.element('.attachments-file-list').innerHTML, /PDF · 1 page · 40 B/); assert.match(f.element('.attachments-file-list').innerHTML, /PDF · 3 pages · 40 B/); assert.equal(f.ui.isPending(), false);
  f.ui.destroy();
});


test('arbitrary binary drops preserve exact bytes and original names while reading limitations stay explicit and escaped', async () => {
  const bytes = Uint8Array.from([0, 255, 1, 2, 128, 65, 66]), note = 'Text extraction is unavailable for <broken PDF>; its original bytes are saved.';
  const f = fixture({ upload: (url, body) => ({ id: body.name.endsWith('.pdf') ? 'unreadable-pdf' : 'opaque-file', name: body.name, kind: 'file', mime: 'application/octet-stream', extension: 'bin', size: bytes.length, sha256: 'fixture', ...(body.name.endsWith('.pdf') ? { processing: { status: 'unavailable', format: 'pdf', code: 'PDF_DAMAGED', message: note } } : {}) }) });
  const files = ['payload.custom-format', 'damaged.pdf'].map(name => ({ name, type: 'application/x-arbitrary-file', size: bytes.length, arrayBuffer: async () => bytes.buffer }));
  await f.form.dispatch('drop', { dataTransfer: { types: ['Files'], files }, preventDefault() {}, stopPropagation() {} }); await settle();
  const uploads = f.calls.filter(call => call.url.endsWith('/upload')); assert.equal(uploads.length, 2);
  for (const [index, call] of uploads.entries()) { assert.equal(call.body.name, files[index].name); assert.deepEqual(Buffer.from(call.body.dataBase64, 'base64'), Buffer.from(bytes)); }
  assert.deepEqual(f.drafts.a, ['opaque-file', 'unreadable-pdf']); assert.equal(f.element('.attachments-error-list').innerHTML, '');
  const chips = f.element('.attachments-file-list').innerHTML;
  assert.match(chips, /payload\.custom-format/); assert.match(chips, /damaged\.pdf/); assert.doesNotMatch(chips, /payload\.bin|damaged\.bin/); assert.match(chips, /File · 7 B/);
  assert.match(chips, /class="attachment-processing-note" role="note"/); assert.match(chips, /Direct reading is unavailable for this format/); assert.match(chips, /&lt;broken PDF&gt;/); assert.doesNotMatch(chips, /<broken PDF>/); assert.equal(f.ui.isPending(), false);
  f.ui.destroy();
});
