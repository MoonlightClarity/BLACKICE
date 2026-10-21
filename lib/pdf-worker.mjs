import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { PDFiumLibrary } from './vendor/pdfium/index.esm.js';
import { PDF_LIMITS } from './pdf-documents.mjs';

const fail = (message, code = 'PDF_INVALID', status = 422) => Object.assign(new Error(message), { code, status });
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const type = Buffer.from(name), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result; }
function png({ width, height, data }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || Math.max(width, height) > PDF_LIMITS.renderLongSide || width * height > PDF_LIMITS.renderPixels || data.length !== width * height * 4) throw fail('The PDF page produced invalid or excessive image dimensions.', 'PDF_LIMIT_EXCEEDED', 413);
  const rowBytes = width * 4, pixels = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) pixels.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  let compressed; try { compressed = deflateSync(pixels, { level: 6, maxOutputLength: PDF_LIMITS.outputBytes }); } catch { throw fail('The rendered PDF page exceeds the 8 MiB image limit.', 'PDF_LIMIT_EXCEEDED', 413); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const result = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
  if (result.length > PDF_LIMITS.outputBytes) throw fail('The rendered PDF page exceeds the 8 MiB image limit.', 'PDF_LIMIT_EXCEEDED', 413);
  return result;
}
function textFor(page) {
  const text = page.getText();
  if (typeof text !== 'string') throw fail('PDFium could not extract this page’s text.');
  if (text.length > PDF_LIMITS.pageChars) throw fail('This PDF page contains more than 2 million text characters. Split it into smaller pages before processing.', 'PDF_LIMIT_EXCEEDED', 413);
  return text;
}
function pageRange(startPage, totalPages) { if (startPage > totalPages) throw fail(`Page ${startPage} is past the end of this PDF (${totalPages} pages).`, 'PDF_INVALID_ARGUMENT', 400); }
function charRange(startChar, text, page) { if (startChar > text.length) throw fail(`Start character is past the end of page ${page} (${text.length} characters).`, 'PDF_INVALID_ARGUMENT', 400); }
function readPages(document, totalPages, options) {
  const { startPage, pageCount, startChar, charCount } = options; pageRange(startPage, totalPages);
  const pages = [], endPage = Math.min(totalPages, startPage + pageCount - 1); let remaining = charCount;
  for (let number = startPage; number <= endPage; number++) {
    const page = document.getPage(number - 1);
    try {
      const text = textFor(page), begin = number === startPage ? startChar : 0; charRange(begin, text, number);
      const excerpt = text.slice(begin, begin + remaining), nextChar = begin + excerpt.length < text.length ? begin + excerpt.length : null;
      pages.push({ page: number, startChar: begin, text: excerpt, totalChars: text.length, nextChar, textAvailable: Boolean(text.trim()), ...(!text.trim() ? { hint: 'This page has no selectable text. Render it to inspect its pixels; OCR is not included.' } : {}) });
      remaining -= excerpt.length;
      if (nextChar !== null) return { format: 'pdf', totalPages, pages, nextPage: number, nextChar };
      if (remaining === 0) return { format: 'pdf', totalPages, pages, nextPage: number < totalPages ? number + 1 : null, nextChar: number < totalPages ? 0 : null };
    } finally { page.close(); }
  }
  return { format: 'pdf', totalPages, pages, nextPage: endPage < totalPages ? endPage + 1 : null, nextChar: endPage < totalPages ? 0 : null };
}
function searchPages(document, totalPages, options) {
  const { query, startPage, pageCount, startChar, limit, caseSensitive } = options; pageRange(startPage, totalPages);
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), expression = new RegExp(literal, caseSensitive ? 'gu' : 'giu');
  const matches = [], emptyTextPages = [], endPage = Math.min(totalPages, startPage + pageCount - 1);
  for (let number = startPage; number <= endPage; number++) {
    const page = document.getPage(number - 1);
    try {
      const text = textFor(page), begin = number === startPage ? startChar : 0; charRange(begin, text, number);
      if (!text.trim()) emptyTextPages.push(number);
      expression.lastIndex = begin; let match;
      while ((match = expression.exec(text))) {
        const start = match.index, end = start + match[0].length, excerptStart = Math.max(0, start - 120), excerptEnd = Math.min(text.length, end + 240);
        matches.push({ page: number, startChar: start, endChar: end, matchText: match[0], text: text.slice(excerptStart, excerptEnd), excerptStartChar: excerptStart, excerptEndChar: excerptEnd, truncated: excerptStart > 0 || excerptEnd < text.length });
        if (matches.length >= limit) {
          const nextPage = end < text.length ? number : number < totalPages ? number + 1 : null;
          return { format: 'pdf', totalPages, query, matches, emptyTextPages, nextPage, nextChar: nextPage === number ? end : nextPage ? 0 : null };
        }
      }
    } finally { page.close(); }
  }
  return { format: 'pdf', totalPages, query, matches, emptyTextPages, nextPage: endPage < totalPages ? endPage + 1 : null, nextChar: endPage < totalPages ? 0 : null };
}
async function renderPage(document, totalPages, number) {
  pageRange(number, totalPages); const page = document.getPage(number - 1);
  try {
    const { originalWidth, originalHeight } = page.getOriginalSize();
    if (!Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0) throw fail('This PDF page has no usable dimensions.');
    // Two million RGBA pixels also fit the PNG output limit even for poorly compressible images.
    const scale = Math.min(PDF_LIMITS.renderLongSide / Math.max(originalWidth, originalHeight), Math.sqrt(2000000 / (originalWidth * originalHeight)));
    const width = Math.max(1, Math.floor(originalWidth * scale)), height = Math.max(1, Math.floor(originalHeight * scale));
    const rendered = await page.render({ width, height, scale: 1, colorSpace: 'RGBA', transparent: false, renderFormFields: false, render: async pixels => png(pixels) });
    return { bytes: Uint8Array.from(rendered.data), width: rendered.width, height: rendered.height, page: number, totalPages };
  } finally { page.close(); }
}
function safeError(cause) {
  if (cause?.code?.startsWith?.('PDF_')) return { message: cause.message, code: cause.code, status: cause.status || 422 };
  if (/password/i.test(cause?.message || '')) return { message: 'This PDF requires a password. Attach an unlocked copy to read or render its contents.', code: 'PDF_PASSWORD_REQUIRED', status: 422 };
  if (/security scheme/i.test(cause?.message || '')) return { message: 'This PDF uses unsupported encryption. Attach an unlocked copy.', code: 'PDF_ENCRYPTION_UNSUPPORTED', status: 422 };
  return { message: 'This PDF is damaged or uses content PDFium could not process. Try exporting a new PDF copy.', code: 'PDF_INVALID', status: 422 };
}
async function perform({ operation, bytes, options }) {
  let library, document;
  try {
    const wasmBinary = await readFile(new URL('./vendor/pdfium/pdfium.wasm', import.meta.url));
    library = await PDFiumLibrary.init({ wasmBinary }); document = await library.loadDocument(bytes);
    const totalPages = document.getPageCount();
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw fail('This PDF contains no readable pages.');
    if (totalPages > PDF_LIMITS.pages) throw fail('PDF processing supports at most 2,000 pages per file. Split this document into smaller PDFs.', 'PDF_LIMIT_EXCEEDED', 413);
    if (operation === 'inspect') return { pageCount: totalPages };
    if (operation === 'read') return readPages(document, totalPages, options);
    if (operation === 'search') return searchPages(document, totalPages, options);
    if (operation === 'render') return await renderPage(document, totalPages, options.page);
    throw fail('Unknown PDF operation.', 'PDF_INVALID_ARGUMENT', 400);
  } finally { try { document?.destroy(); } finally { library?.destroy(); } }
}

if (!isMainThread) {
  let message;
  try { message = { ok: true, result: await perform(workerData) }; }
  catch (cause) { message = { ok: false, error: safeError(cause) }; }
  parentPort.postMessage(message, message.result?.bytes ? [message.result.bytes.buffer] : []);
  parentPort.close();
}
