import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { AttachmentStore, ATTACHMENT_LIMITS, createAttachmentToolHandler, inspectAttachment } from '../lib/attachments.mjs';
import { renderPdfPage } from '../lib/pdf-documents.mjs';
import { attachmentResourceKey, normalizeHostOperationResult } from '../lib/operation-descriptors.mjs';
import { evaluateContractCriteria, normalizeContractEvidence } from '../lib/planning-contract-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invoke = (handler, args) => handler({ name: 'relay_files', arguments: args });
const data = result => JSON.parse(result.contentItems[0].text);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-attachment-formats-'));
  const cwd = path.join(directory, 'task'); await fs.mkdir(cwd);
  const store = await new AttachmentStore({ dataDir: directory }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, directory, cwd };
}

// A real PDF with byte-correct offsets and compressed text streams.
function document(pages) {
  const objects = [null, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), null, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const ids = [];
  for (const text of pages) {
    const id = objects.length; ids.push(id);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`));
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = deflateSync(Buffer.from(text ? `BT /F1 14 Tf 30 740 Td (${escaped}) Tj ET` : '0.2 0.3 0.5 rg 30 40 100 100 re f'));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`);
  const parts = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1')], offsets = [0];
  let size = parts[0].length;
  for (let id = 1; id < objects.length; id++) {
    offsets.push(size); const part = Buffer.concat([Buffer.from(`${id} 0 obj\n`), objects[id], Buffer.from('\nendobj\n')]); parts.push(part); size += part.length;
  }
  const xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(xref)); return Buffer.concat(parts);
}

test('only complete selectable pages from exact immutable PDF reads establish source coverage', async t => {
  const { store } = await fixture(t);
  const entry = await store.importBytes({ name: 'two-pages.pdf', bytes: document(['First page actual text', 'Second page actual text']) });
  const blank = await store.importBytes({ name: 'blank-page.pdf', bytes: document(['First page actual text', '']) });
  const handler = createAttachmentToolHandler({ store, attachmentIds: [entry.id, blank.id] });
  const read = async (args, { file = entry, change } = {}) => {
    const call = { name: 'relay_files', arguments: { action: 'read', attachmentId: file.id, ...args } };
    const descriptor = await handler.describeOperation(call), result = await handler(call);
    if (change) {
      const body = data(result); change(body); result.contentItems[0].text = JSON.stringify(body);
    }
    return (await normalizeHostOperationResult(result, { call, descriptor })).evidence;
  };
  const ranges = rows => rows.filter(row => row.kind === 'source-coverage').map(row => row.coverage);
  const resourceKey = attachmentResourceKey(entry.sha256);
  const contract = { criteria: [{ id: 'complete', kind: 'source-coverage', resourceKey }], workItems: [{ id: 'read', criterionIds: ['complete'] }] };
  const complete = (...reads) => evaluateContractCriteria(contract, reads.flatMap((rows, index) => rows.map(row => normalizeContractEvidence(row, {
    operationId: 'operation-' + index, workItemId: 'read', at: '2026-11-09T00:00:00.000Z',
  })))).criteria[0].satisfied;
  const prefix = await read({ charCount: 5 }), suffix = await read({ startChar: 5 });
  assert.deepEqual(ranges(prefix), []); assert.deepEqual(ranges(suffix), []);
  const first = await read({ pageCount: 1 }), second = await read({ startPage: 2 });
  assert.deepEqual(ranges(first), [{ unit: 'pages', start: 0, end: 1, total: 2 }]);
  assert.deepEqual(ranges(second), [{ unit: 'pages', start: 1, end: 2, total: 2 }]);
  assert.ok([...first, ...second].every(row => row.resourceKey === resourceKey && row.sourceVersion === entry.sha256));
  assert.equal(complete(prefix, suffix, second), false);
  assert.equal(complete(first, second), true);
  assert.deepEqual(ranges(await read({}, { file: blank })), [{ unit: 'pages', start: 0, end: 1, total: 2 }]);
  for (const args of [{ action: 'read_bytes' }, { action: 'search', query: 'page' }, { action: 'image', page: 1 }]) {
    assert.deepEqual(ranges(await read(args)), []);
  }
  assert.deepEqual(ranges(await read({}, { change: body => { body.attachment.sha256 = blank.sha256; } })), []);
  assert.deepEqual(ranges(await read({}, { change: body => { body.attachment.id = blank.id; } })), []);
});

test('a truncated text line contributes no line coverage while exact character reads retain their ranges', async t => {
  const { store } = await fixture(t);
  const text = 'First line\n' + 'x'.repeat(ATTACHMENT_LIMITS.readChars + 5);
  const entry = await store.importBytes({ name: 'long-line.txt', bytes: Buffer.from(text) });
  const handler = createAttachmentToolHandler({ store, attachmentIds: [entry.id] });
  const ranges = async args => {
    const call = { name: 'relay_files', arguments: { action: 'read', attachmentId: entry.id, ...args } };
    const descriptor = await handler.describeOperation(call), result = await handler(call);
    const { evidence } = await normalizeHostOperationResult(result, { call, descriptor });
    return evidence.filter(row => row.kind === 'source-coverage').map(row => row.coverage);
  };
  assert.deepEqual(await ranges({}), [{ unit: 'lines', start: 0, end: 1, total: 2 }]);
  assert.deepEqual(await ranges({ startLine: 2 }), []);
  assert.deepEqual(await ranges({ charCount: ATTACHMENT_LIMITS.readChars }), [{ unit: 'characters', start: 0, end: ATTACHMENT_LIMITS.readChars, total: text.length }]);
  assert.deepEqual(await ranges({ startChar: ATTACHMENT_LIMITS.readChars }), [{ unit: 'characters', start: ATTACHMENT_LIMITS.readChars, end: text.length, total: text.length }]);
});

test('arbitrary extensions and binary contents survive upload, restart and byte pagination exactly', async t => {
  const { store, directory } = await fixture(t);
  const original = Buffer.alloc(40000); for (let i = 0; i < original.length; i++) original[i] = i % 256;
  const entries = [];
  for (const name of ['archive.zip', 'macro.docm', 'program.exe', 'future-format.unknown', 'no-extension', 'misnamed.txt']) {
    const entry = await store.importBytes({ name, dataBase64: original.toString('base64') }); entries.push(entry);
    assert.equal(entry.name, name); assert.equal(entry.kind, 'file'); assert.equal(entry.sha256, hash(original));
  }
  const reopened = await new AttachmentStore({ dataDir: directory }).init(); t.after(() => reopened.close());
  assert.deepEqual(await reopened.get(entries[0].id), entries[0]);
  const handler = createAttachmentToolHandler({ store: reopened, attachmentIds: [entries[0].id] });
  const chunks = []; let offset = 0;
  while (offset !== null) {
    const result = data(await invoke(handler, { action: 'read_bytes', attachmentId: entries[0].id, offset, byteCount: 16384 }));
    assert.equal(result.offset, offset); assert.equal(result.totalBytes, original.length); assert.ok(result.byteCount <= 16384);
    chunks.push(Buffer.from(result.dataBase64, 'base64')); offset = result.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), original);
  await assert.rejects(invoke(handler, { action: 'read_bytes', attachmentId: entries[1].id }), /not attached/);
  await assert.rejects(store.readBytes(entries[0].id, { byteCount: 16385 }), /Byte count/);
  await assert.rejects(store.readBytes(entries[0].id, { offset: original.length + 1 }), /past the end/);
  assert.doesNotMatch(await store.prompt([entries[0].id]), /dataBase64/);
});

test('an unreadable PDF is still an exact original attachment with a visible reading limitation', async t => {
  const { store } = await fixture(t), bytes = Buffer.from('%PDF-1.7\nDamaged but user-selected original');
  const entry = await store.importBytes({ name: 'damaged.pdf', bytes });
  assert.equal(entry.kind, 'file'); assert.equal(entry.processing.format, 'pdf'); assert.equal(entry.processing.status, 'unavailable');
  assert.match(entry.processing.message, /PDF|document/i); assert.deepEqual((await store.bytes(entry.id)).bytes, bytes);
  await assert.rejects(store.read(entry.id), /working copy|compatible tool|export/i);
  await assert.rejects(store.importBytes({ name: 'anything.bin', bytes: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1) }), /10 MiB/);
});

test('export supplies separate usable working copies and never overwrites a previous copy or the source', async t => {
  const { store, cwd } = await fixture(t), bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 3, 99]);
  const entry = await store.importBytes({ name: 'document.docx', bytes }), events = [];
  const handler = createAttachmentToolHandler({ store, attachmentIds: [entry.id], cwd, onEvent: event => events.push(event) });
  const first = data(await invoke(handler, { action: 'export', attachmentId: entry.id }));
  assert.equal(path.dirname(path.dirname(first.path)), await fs.realpath(cwd)); assert.equal(path.basename(first.path), 'attachment.docx');
  assert.equal(first.workingCopy, true); assert.equal(first.sha256, hash(bytes)); assert.deepEqual(await fs.readFile(first.path), bytes);
  await fs.writeFile(first.path, 'A decoder edited this working copy');
  const second = data(await invoke(handler, { action: 'export', attachmentId: entry.id }));
  assert.notEqual(second.path, first.path); assert.deepEqual(await fs.readFile(second.path), bytes);
  assert.equal(await fs.readFile(first.path, 'utf8'), 'A decoder edited this working copy'); assert.deepEqual((await store.bytes(entry.id)).bytes, bytes);
  assert.equal(events.at(-1).action, 'export'); assert.equal(Object.hasOwn(events.at(-1), 'content'), false);
  await assert.rejects(invoke(handler, { action: 'export', attachmentId: entry.id, path: first.path }), /Invalid/);
  const alternate = await store.importBytes({ name: 'CON.exe:payload', bytes });
  const safe = await store.export(alternate.id, { cwd }); assert.equal(path.basename(safe.path), 'attachment.bin'); assert.equal(safe.attachment.name, 'CON.exe:payload');
});

test('cancelled or damaged attachment exports create no successful copy or tool receipt', async t => {
  const { store, directory, cwd } = await fixture(t), entry = await store.importBytes({ name: 'payload.bin', bytes: Buffer.from([0, 2, 3]) });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.export(entry.id, { cwd, signal: controller.signal }), { name: 'AbortError' }); assert.deepEqual(await fs.readdir(cwd), []);
  await fs.writeFile(path.join(directory, 'attachments', 'blobs', `${entry.sha256}.bin`), Buffer.from([0, 9, 9]));
  const events = [], handler = createAttachmentToolHandler({ store, attachmentIds: [entry.id], cwd, onEvent: event => events.push(event) });
  await assert.rejects(invoke(handler, { action: 'export', attachmentId: entry.id }), /changed|integrity/);
  assert.deepEqual(events, []); assert.deepEqual(await fs.readdir(cwd), []);
});

test('real PDF text, search and rendered page pixels are available through the run-scoped attachment gateway', async t => {
  const { store, directory, cwd } = await fixture(t), bytes = document(['BLACKICE first page evidence', 'Second page needle evidence', '']);
  const entry = await store.importBytes({ name: 'reference.pdf', bytes });
  assert.equal(entry.kind, 'pdf'); assert.equal(entry.pageCount, 3); assert.equal(entry.sha256, hash(bytes));
  const reopened = await new AttachmentStore({ dataDir: directory }).init(); t.after(() => reopened.close()); assert.deepEqual(await reopened.get(entry.id), entry);
  const handler = createAttachmentToolHandler({ store: reopened, attachmentIds: [entry.id], cwd });
  const first = data(await invoke(handler, { action: 'read', attachmentId: entry.id, startPage: 1, pageCount: 1 }));
  assert.equal(first.format, 'pdf'); assert.equal(first.totalPages, 3); assert.equal(first.pages[0].page, 1); assert.match(first.pages[0].text, /BLACKICE first page evidence/); assert.equal(first.nextPage, 2);
  const searched = data(await invoke(handler, { action: 'search', attachmentId: entry.id, query: 'needle' }));
  assert.equal(searched.matches[0].page, 2); assert.match(searched.matches[0].text, /needle/);
  const sliced = data(await invoke(handler, { action: 'read', attachmentId: entry.id, startPage: 2, startChar: 7, charCount: 4 })); assert.equal(sliced.pages[0].text, 'page');
  const visualOnly = data(await invoke(handler, { action: 'read', attachmentId: entry.id, startPage: 3, pageCount: 1 })); assert.equal(visualOnly.pages[0].text, '');
  const image = await invoke(handler, { action: 'image', attachmentId: entry.id, page: 3 });
  assert.equal(image.contentItems[1].type, 'inputImage'); const pixels = Buffer.from(image.contentItems[1].imageUrl.split(',')[1], 'base64');
  const dimensions = inspectAttachment('render.png', pixels); assert.equal(dimensions.kind, 'image'); assert.ok(dimensions.width > 100 && dimensions.height > 100);
  assert.equal(data(image).page, 3); assert.equal(data(image).totalPages, 3);
  const exported = data(await invoke(handler, { action: 'export', attachmentId: entry.id })); assert.deepEqual(await fs.readFile(exported.path), bytes);
  const prompt = await store.prompt([entry.id]); assert.match(prompt, /"pageCount":3/); assert.doesNotMatch(prompt, /BLACKICE first page evidence|dataBase64/);
  const foreign = createAttachmentToolHandler({ store, attachmentIds: [] }); await assert.rejects(invoke(foreign, { action: 'image', attachmentId: entry.id, page: 1 }), /not attached/);
});

test('explicit reimport recovers transient PDF reader saturation without rewriting earlier task attachments', async t => {
  const { store } = await fixture(t), bytes = document(['Transient PDF admission recovery']);
  const running = Array.from({ length: 6 }, () => renderPdfPage(bytes));
  const first = await store.importBytes({ name: 'retry.pdf', bytes });
  assert.equal(first.kind, 'file'); assert.equal(first.processing.code, 'PDF_BUSY');
  await Promise.all(running);
  const retried = await store.importBytes({ name: 'retry.pdf', bytes });
  assert.equal(retried.kind, 'pdf'); assert.equal(retried.pageCount, 1); assert.notEqual(retried.id, first.id);
  assert.equal((await store.get(first.id)).kind, 'file'); assert.deepEqual((await store.bytes(first.id)).bytes, bytes);
  assert.equal((await store.importBytes({ name: 'retry.pdf', bytes })).id, retried.id);
  assert.match((await store.read(retried.id)).pages[0].text, /Transient PDF admission recovery/);
});

test('escaped arbitrary-file names fit the prompt budget while full metadata stays available', async t => {
  const { store } = await fixture(t), entries = [];
  for (let index = 0; index < 10; index++) entries.push(await store.importBytes({ name: '<>&'.repeat(79) + index, bytes: Buffer.from([0, 9, index]) }));
  const prompt = await store.prompt(entries.map(entry => entry.id));
  assert.ok(prompt.length <= ATTACHMENT_LIMITS.promptChars, `Prompt was ${prompt.length} characters`); assert.match(prompt, /"nameTruncated":true/); assert.doesNotMatch(prompt, /<>&/);
  assert.equal((await store.get(entries[0].id)).name, entries[0].name);
  const listed = data(await invoke(createAttachmentToolHandler({ store, attachmentIds: entries.map(entry => entry.id) }), { action: 'list' }));
  assert.equal(listed[0].name, entries[0].name);
});
