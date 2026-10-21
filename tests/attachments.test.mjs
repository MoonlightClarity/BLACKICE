import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AttachmentStore, ATTACHMENT_LIMITS, inspectAttachment, createAttachmentToolHandler } from '../lib/attachments.mjs';
import { initAttachmentsUI } from '../public/attachments-ui.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
function chunk(name, bytes) { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length, 0); result.write(name, 4, 4, 'ascii'); bytes.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; }
function png(width = 1, height = 1, bits = 8, color = 6) { const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = bits; header[9] = color; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]); }
// Real 1×1 red pixel files encoded by Pillow; no image library is required at runtime.
const webp = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
async function setup(t) { const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'relay-attachment-test-')), store = await new AttachmentStore({ dataDir }).init(); t.after(async () => { await store.close(); assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir())); assert.match(path.basename(dataDir), /^relay-attachment-test-/); await fs.rm(dataDir, { recursive: true, force: true }); }); return { store, dataDir }; }
const upload = (store, name, text) => store.importBytes({ name, bytes: Buffer.from(text) });
const invoke = (handler, args) => handler({ name: 'relay_files', arguments: args });

test('copies local files immutably with content hash and durable metadata across restart', async t => {
  const { store, dataDir } = await setup(t), original = path.join(dataDir, 'original.txt'); await fs.writeFile(original, 'First version\nSecond line');
  const entry = await store.importPath(original); assert.equal(entry.kind, 'text'); assert.equal(entry.source, 'local'); assert.equal(entry.sha256, sha(Buffer.from('First version\nSecond line'))); assert.equal(entry.lineCount, 2);
  await fs.writeFile(original, 'Changed later'); assert.equal((await store.read(entry.id)).lines[0].text, 'First version');
  const reopened = await new AttachmentStore({ dataDir }).init(); t.after(() => reopened.close()); assert.deepEqual(await reopened.get(entry.id), entry); assert.deepEqual(reopened.validateIds([entry.id]), [entry.id]);
  assert.equal((await reopened.snapshot([entry.id]))[0].sha256, entry.sha256);
});

test('base64 uploads persist exact bytes, deduplicate only identical names and content, and reject malformed encoding', async t => {
  const { store } = await setup(t), text = Buffer.from('Actual uploaded café text');
  const entry = await store.importBytes({ name: 'notes.md', dataBase64: text.toString('base64') }); assert.deepEqual((await store.bytes(entry.id)).bytes, text);
  assert.equal((await store.importBytes({ name: 'notes.md', bytes: text })).id, entry.id);
  assert.notEqual((await store.importBytes({ name: 'renamed.md', bytes: text })).id, entry.id);
  assert.notEqual((await upload(store, 'notes.md', 'Different')).id, entry.id);
  for (const dataBase64 of ['YWJj\n', '!!!!', 'Zg=', 'Zh==', 'data:text/plain;base64,YQ==']) await assert.rejects(store.importBytes({ name: 'x.txt', dataBase64 }), /base64/i);
});

test('line and character paging can reach all text without silently claiming the long-line excerpt is complete', async t => {
  const { store } = await setup(t), text = `top\r\n${'x'.repeat(25000)}\r\nbottom`, entry = await upload(store, 'long.txt', text);
  const page = await store.read(entry.id, { startLine: 2, lineCount: 1 }); assert.equal(page.lines[0].text.length, ATTACHMENT_LIMITS.readChars); assert.equal(page.lines[0].truncated, true); assert.equal(page.nextLine, 3);
  let cursor = 0, combined = ''; while (cursor !== null) { const result = await store.readChars(entry.id, { startChar: cursor, charCount: 15000 }); combined += result.text; cursor = result.nextChar; }
  assert.equal(combined, text); await assert.rejects(store.read(entry.id, { startLine: 4 }), /past the end/); await assert.rejects(store.readChars(entry.id, { charCount: 20001 }), /Character count/);
});

test('literal searches are bounded, paged, case-aware and return the matching portion of long lines', async t => {
  const { store } = await setup(t), entry = await upload(store, 'search.txt', ['Needle', 'needle', `${'x'.repeat(4000)}needle suffix`, 'unrelated'].join('\n'));
  const first = await store.search(entry.id, { query: 'needle', limit: 2 }); assert.deepEqual(first.matches.map(match => match.line), [1, 2]); assert.equal(first.nextLine, 3);
  const next = await store.search(entry.id, { query: 'needle', startLine: first.nextLine }); assert.equal(next.matches[0].line, 3); assert.match(next.matches[0].text, /needle/); assert.equal(next.matches[0].matchColumn, 4001); assert.equal(next.matches[0].truncated, true);
  assert.equal((await store.search(entry.id, { query: 'Needle', caseSensitive: true })).matches.length, 1); assert.equal((await store.search(entry.id, { query: '.*' })).matches.length, 0);
});

test('PNG integrity and real dimensions are verified; WebP is sniffed from its bytes', () => {
  assert.deepEqual(inspectAttachment('pixels.bin', png()), { kind: 'image', mime: 'image/png', extension: 'png', width: 1, height: 1 });
  const damaged = png(); damaged[damaged.length - 5] ^= 1; assert.match(inspectAttachment('damaged.png', damaged).processing.message, /damaged/);
  assert.match(inspectAttachment('incomplete.png', png().subarray(0, -10)).processing.message, /incomplete/);
  const actual = inspectAttachment('tiny.webp', webp); assert.equal(actual.mime, 'image/webp'); assert.equal(actual.width, 1); assert.equal(actual.height, 1);
  assert.deepEqual(inspectAttachment('tiny.jpg', jpeg), { kind: 'image', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1 }); assert.match(inspectAttachment('cut.jpg', jpeg.subarray(0, -2)).processing.message, /incomplete/);
  assert.match(inspectAttachment('huge.png', png(32768, 32768)).processing.message, /too large/);
  assert.match(inspectAttachment('deep.png', png(6000, 6000, 16)).processing.message, /decoded pixel/);
});

test('file type never excludes uploads; actual bytes determine built-in reading capability', () => {
  assert.equal(inspectAttachment('paper.pdf', Buffer.from('%PDF-1.7')).kind, 'pdf');
  assert.equal(inspectAttachment('fake.png', Buffer.from('not a PNG')).kind, 'text');
  for (const [name, bytes] of [['binary.bin', Buffer.from([0, 1, 2])], ['bad.txt', Buffer.from([0xff])], ['animation.gif', Buffer.from('GIF89a')], ['program.exe', Buffer.from('MZ executable')]]) {
    const result = inspectAttachment(name, bytes); assert.equal(result.kind, 'file'); assert.equal(result.processing.status, 'unavailable');
  }
  assert.equal(inspectAttachment('graphic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).kind, 'text');
  assert.equal(inspectAttachment('empty.txt', Buffer.alloc(0)).lineCount, 1);
});

test('tool access is scoped to this run and image pixels are returned only on an explicit image action', async t => {
  const { store } = await setup(t), text = await upload(store, 'task.txt', 'Attached evidence'), image = await store.importBytes({ name: 'red.png', bytes: png() }), other = await upload(store, 'unrelated.txt', 'Other task private data'), events = [];
  const handler = createAttachmentToolHandler({ store, attachmentIds: [text.id, image.id], onEvent: event => events.push(event) });
  const listed = await invoke(handler, { action: 'list' }); assert.equal(listed.contentItems.some(item => item.type === 'inputImage'), false); assert.doesNotMatch(listed.contentItems[0].text, /Other task/);
  const viewed = await invoke(handler, { action: 'image', attachmentId: image.id }); assert.equal(viewed.contentItems[1].type, 'inputImage'); assert.deepEqual(Buffer.from(viewed.contentItems[1].imageUrl.split(',')[1], 'base64'), png());
  await assert.rejects(invoke(handler, { action: 'read', attachmentId: other.id }), /not attached/); await assert.rejects(invoke(handler, { action: 'image', attachmentId: text.id }), /attachment is text/);
  const read = await invoke(handler, { action: 'read', attachmentId: text.id }); assert.match(read.contentItems[0].text, /Attached evidence/); assert.equal(events.at(-1).type, 'attachment'); assert.equal(events.at(-1).status, 'completed'); assert.equal(Object.hasOwn(events.at(-1), 'content'), false);
});

test('prompt excerpts are bounded after JSON escaping and do not preload image pixels', async t => {
  const { store } = await setup(t), entries = await Promise.all(Array.from({ length: 10 }, (_, index) => upload(store, `data-${index}.txt`, '<>&'.repeat(2000))));
  const prompt = await store.prompt(entries.map(entry => entry.id)); assert.ok(prompt.length <= ATTACHMENT_LIMITS.promptChars); assert.match(prompt, /excerptTruncated":true/); assert.doesNotMatch(prompt, /<>&/); assert.match(prompt, /relay_files/);
  await assert.rejects(store.snapshot([...entries.map(entry => entry.id), entries[0].id]), /at most 10/); assert.throws(() => store.validateIds(['../../elsewhere']), /valid files/);
  const image = await store.importBytes({ name: 'red.png', bytes: png() }); assert.doesNotMatch(await store.prompt([image.id]), /base64|iVBOR/);
});

test('tampered or missing saved copies are detected and reattaching exact bytes repairs the immutable copy', async t => {
  const { store, dataDir } = await setup(t), entry = await upload(store, 'notes.txt', 'Original'), file = path.join(dataDir, 'attachments', 'blobs', `${entry.sha256}.txt`);
  await fs.writeFile(file, 'Modified'); await assert.rejects(store.bytes(entry.id), /integrity|changed/);
  assert.equal((await upload(store, 'notes.txt', 'Original')).id, entry.id); assert.equal((await store.text(entry.id)).text, 'Original');
  await fs.rm(file); await assert.rejects(store.snapshot([entry.id]), /missing/); await upload(store, 'notes.txt', 'Original'); assert.equal((await store.text(entry.id)).text, 'Original');
});

test('corrupt manifests preserve source data and recover a valid backup without overwriting it with corrupt metadata', async t => {
  const { store, dataDir } = await setup(t), first = await upload(store, 'first.txt', 'First'), second = await upload(store, 'second.txt', 'Second'); const manifest = path.join(dataDir, 'attachments', 'manifest.json'), backup = `${manifest}.bak`, goodBackup = await fs.readFile(backup, 'utf8');
  await fs.writeFile(manifest, '{"version":99,"files":[]}'); const reopened = await new AttachmentStore({ dataDir }).init(); t.after(() => reopened.close()); assert.equal((await reopened.get(first.id)).name, 'first.txt'); assert.equal((await reopened.get(second.id)).name, 'second.txt'); assert.equal(reopened.status().healthy, false);
  await upload(reopened, 'third.txt', 'Third'); assert.equal(await fs.readFile(backup, 'utf8'), goodBackup); assert.equal(reopened.status().healthy, true);
  const brokenDir = path.join(dataDir, 'broken'); await fs.mkdir(path.join(brokenDir, 'attachments'), { recursive: true }); await fs.writeFile(path.join(brokenDir, 'attachments', 'manifest.json'), 'broken'); const broken = await new AttachmentStore({ dataDir: brokenDir }).init(); t.after(() => broken.close()); await assert.rejects(upload(broken, 'new.txt', 'New'), /manifest could not be read/); assert.equal(await fs.readFile(path.join(brokenDir, 'attachments', 'manifest.json'), 'utf8'), 'broken');
});

test('cancelled imports do not add metadata; close drains writes and rejects further imports', async t => {
  const { store } = await setup(t), controller = new AbortController(); controller.abort(); await assert.rejects(store.importBytes({ name: 'cancel.txt', bytes: Buffer.from('Never saved'), signal: controller.signal }), { name: 'AbortError' }); assert.equal((await store.list()).length, 0);
  const pending = upload(store, 'finish.txt', 'Saved before close'); await pending; await store.close(); await assert.rejects(upload(store, 'closed.txt', 'No'), /closed/);
});

const uiTick = () => new Promise(resolve => setImmediate(resolve));
const uiDeferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Exercise the real UI's public event handlers and asynchronous queue without
// adding a DOM runtime or reading any files from the user's desktop.
function attachmentElements() {
  const element = () => {
    const listeners = new Map(), classes = new Set();
    return { innerHTML: '', textContent: '', disabled: false, value: '', dataset: {}, clicks: 0,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value), contains: value => classes.has(value) },
      addEventListener(type, handler) { const entries = listeners.get(type) || []; entries.push(handler); listeners.set(type, entries); },
      removeEventListener(type, handler) { listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== handler)); },
      dispatch(type, event) { return Promise.all((listeners.get(type) || []).map(handler => handler(event))); },
      closest() { return this; }, click() { this.clicks++; },
    };
  };
  const mount = element(), form = element(), selectors = ['.attachments-count', '.attachments-file-list', '.attachments-add', '.attachments-file-input', '.attachments-transfer-status', '.attachments-error-list'];
  const fields = new Map(selectors.map(selector => [selector, element()])); let removeButtons = [];
  const list = fields.get('.attachments-file-list'); Object.defineProperty(list, 'innerHTML', { get() { return this.markup || ''; }, set(value) { this.markup = value; removeButtons = [...value.matchAll(/data-attachment-action="remove" data-id="([^"]+)"/g)].map(match => ({ ...element(), dataset: { attachmentAction: 'remove', id: match[1] } })); } });
  mount.querySelector = selector => fields.get(selector); mount.querySelectorAll = () => removeButtons; mount.closest = () => form;
  fields.get('.attachments-add').dataset.attachmentAction = 'choose';
  return { mount, form, fields, removeButtons: () => removeButtons };
}
function setupAttachmentUI(t, { canEdit = () => true, pickFiles, mutate } = {}) {
  const elements = attachmentElements(), calls = [], changes = []; let savedIds = ['kept'];
  const metadata = { id: 'kept', name: 'kept.txt', mime: 'text/plain', sha256: 'fixture', kind: 'text', size: 4 };
  const ui = initAttachmentsUI({ ...elements, canEdit, pickFiles, getIds: () => savedIds,
    setIds: ids => { savedIds = [...ids]; changes.push([...ids]); }, escape: value => String(value ?? ''), icon: () => '',
    api: async (url, method, body) => { calls.push({ url, method, body }); if (!method) return [metadata]; return mutate ? mutate({ url, method, body }) : { attachment: { ...metadata, id: 'added', name: 'added.txt' } }; },
  });
  t.after(() => ui.destroy()); return { ui, ...elements, calls, changes, ids: () => savedIds };
}
const localFile = (read = async () => new TextEncoder().encode('fixture').buffer) => ({ name: 'fixture.txt', size: 7, arrayBuffer: read });

test('locked attachment controls reject choose/remove/drop and direct imports while preserving existing IDs', async t => {
  let editable = false, reads = 0, pickers = 0;
  const f = setupAttachmentUI(t, { canEdit: () => editable, pickFiles: async () => { pickers++; return ['C:\\fixture.txt']; } }); await uiTick();
  f.ui.refreshEditability();
  assert.equal(f.fields.get('.attachments-add').disabled, true); assert.equal(f.fields.get('.attachments-file-input').disabled, true); assert.equal(f.removeButtons()[0].disabled, true);
  await f.ui.addPaths(['C:\\fixture.txt']); await f.ui.addFiles([localFile(async () => { reads++; return new ArrayBuffer(0); })]);
  const choose = { dataset: { attachmentAction: 'choose' }, closest() { return this; } };
  const remove = { dataset: { attachmentAction: 'remove', id: 'kept' }, closest() { return this; } };
  await f.mount.dispatch('click', { target: choose }); await f.mount.dispatch('click', { target: remove });
  let prevented = false, stopped = false;
  await f.form.dispatch('drop', { dataTransfer: { types: ['Files'], files: [localFile()] }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(reads, 0); assert.equal(pickers, 0);
  assert.deepEqual(f.ids(), ['kept']); assert.deepEqual(f.changes, []); assert.equal(f.calls.filter(call => call.method).length, 0);
  editable = true; f.ui.refreshEditability(); assert.equal(f.fields.get('.attachments-add').disabled, false); assert.equal(f.removeButtons()[0].disabled, false);
  await f.mount.dispatch('click', { target: remove }); assert.deepEqual(f.ids(), []);
  await f.ui.addPaths(['C:\\fixture.txt']); assert.deepEqual(f.ids(), ['added']); assert.equal(f.calls.filter(call => call.method).length, 1);
});

test('native file picker results cannot attach after sending starts or the selected draft changes', async t => {
  let editable = true; const picker = uiDeferred();
  const f = setupAttachmentUI(t, { canEdit: () => editable, pickFiles: () => picker.promise }); await uiTick();
  const choose = f.mount.dispatch('click', { target: f.fields.get('.attachments-add') }); await uiTick();
  editable = false; f.ui.refreshEditability(); picker.resolve(['C:\\late.txt']); await choose;
  assert.deepEqual(f.ids(), ['kept']); assert.equal(f.calls.filter(call => call.method).length, 0); assert.equal(f.ui.isPending(), false);
  const otherPicker = uiDeferred(), other = setupAttachmentUI(t, { pickFiles: () => otherPicker.promise }); await uiTick();
  const previousDraft = other.mount.dispatch('click', { target: other.fields.get('.attachments-add') }); await uiTick();
  other.ui.reset(); otherPicker.resolve(['C:\\wrong-draft.txt']); await previousDraft;
  assert.deepEqual(other.ids(), ['kept']); assert.equal(other.calls.filter(call => call.method).length, 0);
});

test('a file still being read cannot start its upload after the composer locks', async t => {
  let editable = true; const bytes = uiDeferred();
  const f = setupAttachmentUI(t, { canEdit: () => editable }); await uiTick();
  const upload = f.ui.addFiles([localFile(() => bytes.promise)]); await uiTick(); assert.equal(f.ui.isPending(), true);
  editable = false; f.ui.refreshEditability(); bytes.resolve(new TextEncoder().encode('fixture').buffer); await upload;
  assert.equal(f.calls.filter(call => call.method).length, 0); assert.equal(f.ui.isPending(), false); assert.deepEqual(f.ids(), ['kept']);
});

test('locking during an import keeps the current draft and drains skipped queued files without another request', async t => {
  let editable = true; const imported = uiDeferred();
  const f = setupAttachmentUI(t, { canEdit: () => editable, mutate: () => imported.promise }); await uiTick();
  const importing = f.ui.addPaths(['C:\\first.txt', 'C:\\second.txt']); await uiTick(); assert.equal(f.ui.isPending(), true);
  editable = false; f.ui.refreshEditability(); imported.resolve({ attachment: { id: 'late', name: 'first.txt', size: 4, kind: 'text' } }); await importing;
  assert.equal(f.calls.filter(call => call.method).length, 1, 'the queued second import must never start after locking');
  assert.equal(f.ui.isPending(), false); assert.deepEqual(f.ids(), ['kept']); assert.deepEqual(f.changes, []);
  editable = true; f.ui.refreshEditability(); await uiTick(); assert.equal(f.calls.filter(call => call.method).length, 1, 'unlocking never automatically replays skipped imports');
});
