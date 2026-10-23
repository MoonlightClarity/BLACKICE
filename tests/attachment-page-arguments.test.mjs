import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentStore, createAttachmentToolHandler } from '../lib/attachments.mjs';

const invoke = (handler, args) => handler({ name: 'relay_files', arguments: args });
const data = response => JSON.parse(response.contentItems[0].text);
const selectorError = action => error => error.status === 400 && error.message.includes(`The ${action} action does not accept page`) && /startPage/.test(error.message) && /pageCount/.test(error.message) && /image/.test(error.message);

test('image-only page selectors on read/search fail before any attachment reader or completion event', async () => {
  const calls = [], events = [], store = Object.fromEntries(['read', 'readChars', 'search'].map(method => [method, async () => { calls.push(method); return {}; }]));
  const handler = createAttachmentToolHandler({ store, attachmentIds: ['selected'], onEvent: event => events.push(event) });
  for (const action of ['read', 'search']) for (const extra of [{}, { startChar: 0 }, { charCount: 100 }, { startPage: 6, pageCount: 1 }, { startPage: 1 }]) {
    await assert.rejects(invoke(handler, { action, attachmentId: 'selected', page: 6, ...(action === 'search' ? { query: 'fixture' } : {}), ...extra }), selectorError(action));
  }
  assert.deepEqual(calls, []); assert.deepEqual(events, []);
  await assert.rejects(invoke(handler, { action: 'read', attachmentId: 'not-attached', page: 6 }), /not attached/);
});

// Byte-correct eight-page PDF with distinct, synthetic page text.
function fixturePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], ids = [];
  for (let page = 1; page <= 8; page++) {
    const id = objects.length + 1; ids.push(id);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const stream = `BT /F1 14 Tf 30 740 Td (Synthetic attachment page ${page}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count 8 >>`;
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = parts[0].length;
  for (let index = 0; index < objects.length; index++) { offsets.push(length); const part = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`); parts.push(part); length += part.length; }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('actual PDF page6 misuse is diagnosed while canonical page6 read/search and image remain correct', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-attachment-selector-'));
  const store = await new AttachmentStore({ dataDir: directory }).init();
  t.after(async () => { await store.close(); assert.match(path.basename(directory), /^blackice-attachment-selector-/); await fs.rm(directory, { recursive: true, force: true }); });
  const entry = await store.importBytes({ name: 'synthetic-eight-pages.pdf', bytes: fixturePdf() });
  assert.equal(entry.kind, 'pdf'); assert.equal(entry.pageCount, 8);
  const events = [], handler = createAttachmentToolHandler({ store, attachmentIds: [entry.id], onEvent: event => events.push(event) });
  await assert.rejects(invoke(handler, { action: 'read', attachmentId: entry.id, page: 6 }), selectorError('read'));
  assert.deepEqual(events, []);
  const read = await invoke(handler, { action: 'read', attachmentId: entry.id, startPage: 6, pageCount: 1 });
  assert.equal(read.success, true); assert.deepEqual(data(read).pages.map(page => page.page), [6]); assert.match(data(read).pages[0].text, /Synthetic attachment page 6/); assert.equal(data(read).nextPage, 7);
  const sliced = data(await invoke(handler, { action: 'read', attachmentId: entry.id, startPage: 6, startChar: 0, charCount: 9 }));
  assert.equal(sliced.pages[0].page, 6); assert.equal(sliced.pages[0].text, 'Synthetic');
  await assert.rejects(invoke(handler, { action: 'search', attachmentId: entry.id, page: 6, query: 'Synthetic' }), selectorError('search'));
  const searched = data(await invoke(handler, { action: 'search', attachmentId: entry.id, startPage: 6, pageCount: 1, query: 'Synthetic' }));
  assert.deepEqual(searched.matches.map(match => match.page), [6]);
  const image = await invoke(handler, { action: 'image', attachmentId: entry.id, page: 6 });
  assert.equal(image.success, true); assert.equal(data(image).page, 6); assert.equal(image.contentItems[1].type, 'inputImage');
  assert.deepEqual([...Buffer.from(image.contentItems[1].imageUrl.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
