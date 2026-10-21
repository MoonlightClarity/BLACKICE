import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { PDFDocumentEngine, PDF_LIMITS, inspectPdf, readPdfPages, searchPdfPages, renderPdfPage } from '../lib/pdf-documents.mjs';

const md5 = value => createHash('md5').update(value).digest();
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const pad = value => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
function rc4(key, input) {
  const state = Array.from({ length: 256 }, (_, i) => i); let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  const output = Buffer.alloc(input.length); let i = 0; j = 0;
  for (let n = 0; n < input.length; n++) { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; output[n] = input[n] ^ state[(state[i] + state[j]) & 255]; }
  return output;
}
function security() {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const owner = rc4(md5(pad('fixture-owner')).subarray(0, 5), pad('fixture-password'));
  const key = md5(Buffer.concat([pad('fixture-password'), owner, permissions, id])).subarray(0, 5), user = rc4(key, padding);
  return { id, dictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`, encrypt: (bytes, object) => { const suffix = Buffer.alloc(5); suffix.writeUIntLE(object, 0, 3); return rc4(md5(Buffer.concat([key, suffix])).subarray(0, 10), bytes); } };
}
function assemble(objects, trailer = '') {
  const pieces = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0]; let offset = pieces[0].length;
  objects.forEach((object, index) => { offsets.push(offset); const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); pieces.push(piece); offset += piece.length; });
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
function pdf(pages, { password = false } = {}) {
  const encryption = password ? security() : null;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], pageIds = [];
  const stream = (data, object, extra = '', compressed = true) => { let bytes = compressed ? deflateSync(data) : data; if (encryption) bytes = encryption.encrypt(bytes, object); return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${compressed ? '/Filter /FlateDecode' : ''} ${extra} >>\nstream\n`), bytes, Buffer.from('\nendstream')]); };
  for (const page of pages) {
    const pageId = objects.length + 1; pageIds.push(pageId); objects.push('');
    const contentId = objects.length + 1, lines = String(page.text || '').split('\n');
    const escape = value => value.replace(/[\\()]/g, '\\$&');
    const text = page.text ? `BT /F1 ${page.small ? 1 : 12} Tf 40 740 Td ${page.small ? 2 : 16} TL ${lines.map(line => `(${escape(line)}) Tj T*`).join('\n')} ET\n` : '';
    const content = Buffer.from(`${page.scan ? 'q 200 0 0 200 20 20 cm /Im0 Do Q\n' : ''}${page.red ? '1 0 0 rg 20 20 80 80 re f 0 0 0 rg\n' : ''}${text}`);
    objects.push(stream(content, contentId, '', page.compressed !== false));
    let image = '';
    if (page.scan) { const imageId = objects.length + 1; image = `/XObject << /Im0 ${imageId} 0 R >>`; objects.push(stream(Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]), imageId, '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8')); }
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width || 612} ${page.height || 792}] /Resources << /Font << /F1 3 0 R >> ${image} >> /Contents ${contentId} 0 R >>`;
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  let trailer = '';
  if (encryption) { objects.push(encryption.dictionary); trailer = `/Encrypt ${objects.length} 0 R /ID [<${encryption.id.toString('hex')}> <${encryption.id.toString('hex')}>]`; }
  return assemble(objects, trailer);
}
function decodedPng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8, width, height, ended = false; const compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff; for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + length), `${name} CRC`);
    if (name === 'IHDR') { width = payload.readUInt32BE(0); height = payload.readUInt32BE(4); assert.equal(payload[8], 8); assert.equal(payload[9], 6); }
    if (name === 'IDAT') compressed.push(payload);
    if (name === 'IEND') ended = true;
    offset += length + 12;
  }
  assert.equal(ended, true); const data = inflateSync(Buffer.concat(compressed)); assert.equal(data.length, (width * 4 + 1) * height);
  for (let y = 0; y < height; y++) assert.equal(data[y * (width * 4 + 1)], 0);
  return { width, height, data };
}
const valid = pdf([{ text: 'First page: Alpha [.*] beta.', compressed: false }, { text: 'Compressed second page. ALPHA [.*] beta.' }, { scan: true }]);

test('PDFium inspects and reads real multi-page PDFs including Flate streams without detaching input', async () => {
  const before = createHash('sha256').update(valid).digest('hex');
  assert.deepEqual(await inspectPdf(valid), { pageCount: 3 });
  const result = await readPdfPages(valid, { pageCount: 2 });
  assert.equal(result.format, 'pdf'); assert.equal(result.totalPages, 3); assert.deepEqual(result.pages.map(page => page.page), [1, 2]);
  assert.match(result.pages[0].text, /First page: Alpha \[\.\*\] beta\./); assert.match(result.pages[1].text, /Compressed second page/);
  assert.equal(result.nextPage, 3); assert.equal(result.nextChar, 0); assert.equal(result.pages[1].nextChar, null);
  assert.equal(createHash('sha256').update(valid).digest('hex'), before);
});

test('PDF worker startup preserves Node default flag inheritance and loads the actual module', async () => {
  let starts = 0;
  const engine = new PDFDocumentEngine({ workerFactory: (url, options) => {
    starts++;
    assert.equal(Object.hasOwn(options, 'execArgv'), false, 'Let Node inherit flags instead of replaying process-only test/security flags.');
    assert.equal(url.protocol, 'data:', 'The module input accepts an inherited --input-type without stripping runtime flags.');
    return new Worker(url, options);
  } });
  try { const result = await engine.read(valid, { pageCount: 1 }); assert.match(result.pages[0].text, /First page: Alpha/); assert.equal(starts, 1); }
  finally { await engine.close(); }
  assert.equal(engine.status().active, 0);
});

test('long PDF pages paginate by exact character positions without dropping the remainder', async () => {
  const text = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, '0')} ${'long-text '.repeat(90)}`).join('\n'), bytes = pdf([{ text, small: true }, { text: 'NEXT PAGE' }]);
  let startPage = 1, startChar = 0, whole = '', iterations = 0, seenSecond = false;
  while (startPage !== null) {
    const result = await readPdfPages(bytes, { startPage, startChar, charCount: 7000, pageCount: 2 });
    assert.ok(result.pages.reduce((sum, page) => sum + page.text.length, 0) <= 7000);
    for (const page of result.pages) { if (page.page === 1) whole += page.text; else { assert.match(page.text, /NEXT PAGE/); seenSecond = true; } }
    if (result.nextPage === 1) { assert.ok(result.nextChar > startChar); assert.equal(result.pages.at(-1).nextChar, result.nextChar); }
    startPage = result.nextPage; startChar = result.nextChar || 0; assert.ok(++iterations < 10);
  }
  assert.equal((whole.match(/long-text/g) || []).length, 32 * 90); assert.match(whole, /00 long-text/); assert.match(whole, /31 long-text/); assert.equal(seenSecond, true);
});

test('PDF search is literal, case-aware and resumes within a page without skipping matches', async () => {
  const bytes = pdf([{ text: 'one [.*] two [.*] three [.*]' }, { text: 'FOUR [.*] five' }]);
  let startPage = 1, startChar = 0; const matches = [];
  while (startPage !== null) { const result = await searchPdfPages(bytes, { query: '[.*]', limit: 1, startPage, startChar }); matches.push(...result.matches); startPage = result.nextPage; startChar = result.nextChar || 0; assert.ok(matches.length <= 4); }
  assert.deepEqual(matches.map(match => match.page), [1, 1, 1, 2]); assert.equal(new Set(matches.map(match => `${match.page}:${match.startChar}`)).size, 4);
  assert.ok(matches.every(match => match.endChar - match.startChar === 4 && match.matchText === '[.*]'));
  assert.equal((await searchPdfPages(bytes, { query: 'four' })).matches.length, 1);
  assert.equal((await searchPdfPages(bytes, { query: 'four', caseSensitive: true })).matches.length, 0);
});

test('image-only pages explicitly report no selectable text and still render actual PDF pixels', async () => {
  const read = await readPdfPages(valid, { startPage: 3 }); assert.equal(read.pages[0].text, ''); assert.equal(read.pages[0].totalChars, 0); assert.equal(read.pages[0].textAvailable, false); assert.match(read.pages[0].hint, /OCR is not included/);
  const search = await searchPdfPages(valid, { query: 'page', startPage: 3 }); assert.deepEqual(search.matches, []); assert.deepEqual(search.emptyTextPages, [3]);
  const rendered = await renderPdfPage(valid, { page: 3 }), image = decodedPng(rendered.bytes);
  assert.equal(rendered.page, 3); assert.equal(rendered.totalPages, 3); assert.equal(image.width, rendered.width); assert.equal(image.height, rendered.height);
  let blue = 0; for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) { const n = y * (image.width * 4 + 1) + 1 + x * 4; if (image.data[n] < 10 && image.data[n + 1] < 10 && image.data[n + 2] > 245) blue++; }
  assert.ok(blue > 10000, 'The PNG contains the blue image embedded in the PDF, not a blank placeholder.');
});

test('PDF PNG rendering preserves the visible page, caps dimensions and emits bounded valid bytes', async () => {
  const result = await renderPdfPage(pdf([{ text: 'Actual rendered text', red: true, width: 10000, height: 10000 }]));
  assert.ok(Buffer.isBuffer(result.bytes)); assert.ok(result.bytes.length <= PDF_LIMITS.outputBytes); assert.ok(Math.max(result.width, result.height) <= 1600); assert.ok(result.width * result.height <= 4000000);
  const image = decodedPng(result.bytes); let red = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) { const n = y * (image.width * 4 + 1) + 1 + x * 4; if (image.data[n] > 245 && image.data[n + 1] < 10 && image.data[n + 2] < 10) red++; }
  assert.ok(red > 20, 'The red PDF drawing is present in the rendered PNG.');
});

test('malformed and genuinely password-encrypted PDFs fail with actionable processing errors', async () => {
  await assert.rejects(inspectPdf(Buffer.from('%PDF-1.7\nnot a PDF')), { code: 'PDF_INVALID', status: 422 });
  const encrypted = pdf([{ text: 'Protected text' }], { password: true });
  await assert.rejects(readPdfPages(encrypted), error => error.code === 'PDF_PASSWORD_REQUIRED' && /unlocked copy/.test(error.message));
  await assert.rejects(renderPdfPage(encrypted), { code: 'PDF_PASSWORD_REQUIRED' });
});

test('PDF byte/page/option limits and out-of-range positions reject without invented results', async () => {
  await assert.rejects(inspectPdf(Buffer.alloc(PDF_LIMITS.inputBytes + 1)), { code: 'PDF_LIMIT_EXCEEDED', status: 413 });
  await assert.rejects(inspectPdf(Buffer.alloc(0)), { code: 'PDF_INVALID' });
  await assert.rejects(readPdfPages(valid, { charCount: 20001 }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(searchPdfPages(valid, { query: 'x', pageCount: 21 }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(searchPdfPages(valid, { query: 'x', limit: 41 }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(searchPdfPages(valid, { query: 'x', caseSensitive: 'false' }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(readPdfPages(valid, { startPage: 4 }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(readPdfPages(valid, { startChar: 1999999 }), { code: 'PDF_INVALID_ARGUMENT' });
  await assert.rejects(inspectPdf(pdf(Array.from({ length: 2001 }, () => ({})))), { code: 'PDF_LIMIT_EXCEEDED', status: 413 });
});

test('already-cancelled PDF work never starts a worker', async () => {
  let started = 0; const engine = new PDFDocumentEngine({ workerFactory: () => { started++; throw new Error('Must not start'); } }), controller = new AbortController(); controller.abort();
  await assert.rejects(engine.inspect(valid, { signal: controller.signal }), { name: 'AbortError', code: 'PDF_ABORTED' }); assert.equal(started, 0); await engine.close();
});

test('PDF worker deadline interrupts a real CPU loop while the caller remains responsive', async () => {
  let worker; const engine = new PDFDocumentEngine({ timeoutMs: 150, workerFactory: (_url, options) => worker = new Worker('while (true) {}', { ...options, eval: true }) });
  let ticks = 0; const timer = setInterval(() => ticks++, 5), started = Date.now();
  try { await assert.rejects(engine.inspect(valid), { code: 'PDF_TIMEOUT', status: 408 }); assert.ok(Date.now() - started < 3000); assert.ok(ticks > 2, 'The PDF worker did not block the main event loop.'); }
  finally { clearInterval(timer); await engine.close(); }
  assert.equal(worker.threadId, -1); assert.deepEqual(engine.status(), { active: 0, queued: 0, closed: true });
});

test('PDF queue is bounded, queued cancellation is independent, and active abort confirms worker exit', async () => {
  const workers = []; const engine = new PDFDocumentEngine({ concurrent: 1, queued: 1, workerFactory: (_url, options) => { const worker = new Worker('while (true) {}', { ...options, eval: true }); workers.push(worker); return worker; } });
  const activeController = new AbortController(), queuedController = new AbortController();
  const first = engine.inspect(valid, { signal: activeController.signal }), firstRejected = assert.rejects(first, { code: 'PDF_ABORTED' });
  const second = engine.read(valid, { signal: queuedController.signal }), secondRejected = assert.rejects(second, { code: 'PDF_ABORTED' });
  assert.deepEqual(engine.status(), { active: 1, queued: 1, closed: false });
  await assert.rejects(engine.render(valid), { code: 'PDF_BUSY', status: 429 });
  queuedController.abort(); await secondRejected; assert.equal(workers.length, 1); assert.equal(engine.status().active, 1); assert.equal(engine.status().queued, 0);
  await once(workers[0], 'online');
  activeController.abort(); await firstRejected; await engine.close(); assert.equal(workers[0].threadId, -1); assert.equal(engine.status().active, 0);
  await assert.rejects(engine.inspect(valid), { code: 'PDF_CLOSED' });
});
