/**
 * Bounded OOXML Word reader. It reads the source DOCX in memory, not a
 * converted/edited user file; only verified WordprocessingML parts are used.
 * No external ZIP command, platform Office automation or runtime npm package.
 */
import { inflateRawSync } from 'node:zlib';

export const WORD_DOCUMENT_FORMAT = 'docx';
export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LIMIT = Object.freeze({ entries: 4096, partBytes: 8 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024, textChars: 290000, parts: 40 });
const MAGIC = Object.freeze({ central: 0x02014b50, end: 0x06054b50, local: 0x04034b50 });
const hashTable = Array.from({ length: 256 }, (_, i) => {
  let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = hashTable[(crc ^ b) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid(message, code = 'OFFICE_DOCUMENT_INVALID') {
  throw Object.assign(new Error(message), { code });
}
function bounded(condition, message) { if (!condition) invalid(message); }
function zipIndex(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.readUInt32LE(0) !== MAGIC.local) return null;
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === MAGIC.end && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0) invalid('Office archive central directory is missing or damaged.');
  bounded(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    'Multi-disk ZIP archives are not supported.');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  bounded(count === bytes.readUInt16LE(end + 8) && count <= LIMIT.entries &&
    size !== 0xffffffff && offset !== 0xffffffff && offset + size === end,
    'Office archive directory is incomplete or exceeds the bound.');
  const entries = new Map();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    bounded(cursor + 46 <= end && bytes.readUInt32LE(cursor) === MAGIC.central, 'Invalid Office archive entry.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const sizeCompressed = bytes.readUInt32LE(cursor + 20), sizeRaw = bytes.readUInt32LE(cursor + 24);
    const filenameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + filenameLength + extraLength + commentLength;
    bounded(next <= end && filenameLength > 0, 'Invalid Office archive entry length.');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLength)); }
    catch { invalid('Office archive uses an unsupported part name.'); }
    bounded(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !name.includes('\0') &&
      !entries.has(name) && !(flags & 1) && [0, 8].includes(method) &&
      sizeRaw !== 0xffffffff && sizeCompressed !== 0xffffffff && localOffset !== 0xffffffff,
    'Encrypted, duplicated or invalid Office archive entry.');
    entries.set(name, { name, flags, method, sizeCompressed, sizeRaw, localOffset, crc: bytes.readUInt32LE(cursor + 16), filenameLength });
    cursor = next;
  }
  bounded(cursor === end, 'Office archive directory has unexpected trailing data.');
  const read = name => {
    const info = entries.get(name);
    if (!info) invalid('The Office package is missing ' + name + '.');
    bounded(info.sizeRaw <= LIMIT.partBytes && info.sizeCompressed <= bytes.length,
      'An Office XML part exceeds its decompression limit.');
    const start = info.localOffset;
    bounded(start + 30 <= bytes.length && bytes.readUInt32LE(start) === MAGIC.local &&
      bytes.readUInt16LE(start + 8) === info.method, 'Office archive local header is invalid.');
    const nameLength = bytes.readUInt16LE(start + 26), extraLength = bytes.readUInt16LE(start + 28);
    const dataStart = start + 30 + nameLength + extraLength;
    bounded(nameLength === info.filenameLength && dataStart + info.sizeCompressed <= offset &&
      bytes.subarray(start + 30, start + 30 + nameLength).equals(Buffer.from(name, 'utf8')),
    'Office archive part offset is invalid.');
    const compressed = bytes.subarray(dataStart, dataStart + info.sizeCompressed);
    let content;
    try {
      content = info.method === 8 ? inflateRawSync(compressed, { maxOutputLength: LIMIT.partBytes }) : compressed;
    } catch { invalid('Office archive contains a damaged or oversized compressed part.'); }
    bounded(content.length === info.sizeRaw && crc32(content) === info.crc,
      'Office archive part failed its size or checksum verification.');
    return content;
  };
  return { entries, read };
}
function xmlText(bytes) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('Office XML is not valid UTF-8.'); }
  value = value.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(value)) invalid('Office XML contains unsupported declarations.');
  return value;
}
function decoded(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);)/i.test(value))
    invalid('Office XML contains an unsupported entity reference.');
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (entity, name) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()];
    if (named !== undefined) return named;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!(point > 0 && point <= 0x10ffff) || point >= 0xd800 && point <= 0xdfff) invalid('Invalid Office XML character reference.');
    return String.fromCodePoint(point);
  });
}
/** SAX-like walker retaining document order and Word table-cell structure. */
function wordLines(xml) {
  const lines = [], stack = [], tableStack = [];
  let paragraph = null, wordPrefix = 'w', textNode = false, deleted = 0;
  const first = /<([A-Za-z_][\w.-]*):document\b/.exec(xml);
  if (first) wordPrefix = first[1];
  const word = name => name === wordPrefix + ':';
  let pos = 0, tags = 0;
  const addLine = value => { const trimmed = value.replace(/\u0000/g, '').trim(); if (trimmed) lines.push(trimmed); };
  while (pos < xml.length) {
    if (++tags > 1000000) invalid('Office document has too many XML elements.');
    const next = xml.indexOf('<', pos);
    if (next < 0) { if (xml.slice(pos).trim()) invalid('Unexpected Office XML text.'); break; }
    if (next > pos && textNode && paragraph !== null && !deleted) paragraph += decoded(xml.slice(pos, next));
    if (xml.startsWith('<!--', next)) {
      const end = xml.indexOf('-->', next + 4);
      if (end < 0) invalid('Office XML comment is unclosed.');
      pos = end + 3; continue;
    }
    let end = next + 1, quote = '';
    for (; end < xml.length; end++) {
      const c = xml[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === xml.length) invalid('Office XML tag is unclosed.');
    const raw = xml.slice(next + 1, end), closing = raw[0] === '/', selfClosing = raw.endsWith('/');
    const match = /^\/?([A-Za-z_][\w.:-]*)\b/.exec(raw);
    if (!match) { if (/^\?xml\b/i.test(raw)) { pos = end + 1; continue; } invalid('Unsupported Office XML markup.'); }
    const name = match[1];
    if (closing) {
      if (stack.at(-1) !== name) invalid('Office XML elements are not properly nested.');
      stack.pop();
      if (name === wordPrefix + ':t') textNode = false;
      if (name === wordPrefix + ':del' || name === wordPrefix + ':moveFrom') deleted--;
      if (name === wordPrefix + ':p') {
        if (paragraph !== null) {
          const cell = tableStack.at(-1)?.cell;
          if (cell) { if (paragraph.trim()) cell.push(paragraph.trim()); }
          else addLine(paragraph);
        }
        paragraph = null;
      }
      if (name === wordPrefix + ':tc' && tableStack.length) {
        const table = tableStack.at(-1);
        table.row?.push((table.cell || []).join(' ; '));
        table.cell = null;
      }
      if (name === wordPrefix + ':tr' && tableStack.length) {
        const table = tableStack.at(-1);
        if (table.row?.length) addLine('| ' + table.row.map(c => c.replace(/\|/g, '\\|')).join(' | ') + ' |');
        table.row = null;
      }
      if (name === wordPrefix + ':tbl') tableStack.pop();
    } else {
      stack.push(name);
      if (name === wordPrefix + ':del' || name === wordPrefix + ':moveFrom') deleted++;
      if (name === wordPrefix + ':tbl') tableStack.push({ row: null, cell: null });
      if (name === wordPrefix + ':tr' && tableStack.length) tableStack.at(-1).row = [];
      if (name === wordPrefix + ':tc' && tableStack.length) tableStack.at(-1).cell = [];
      if (name === wordPrefix + ':p') paragraph = '';
      if (name === wordPrefix + ':t') textNode = true;
      if (paragraph !== null && !deleted) {
        if (name === wordPrefix + ':tab') paragraph += '\t';
        if (name === wordPrefix + ':br' || name === wordPrefix + ':cr') paragraph += '\n';
        if (name === wordPrefix + ':noBreakHyphen') paragraph += '\u2011';
      }
      if (selfClosing) {
        stack.pop();
        if (name === wordPrefix + ':t') textNode = false;
        if (name === wordPrefix + ':del' || name === wordPrefix + ':moveFrom') deleted--;
      }
    }
    pos = end + 1;
  }
  if (stack.length || tableStack.length) invalid('Office XML document is incomplete.');
  return lines;
}
export function inspectWordDocument(bytes, { signal } = {}) {
  signal?.throwIfAborted();
  const zip = zipIndex(bytes);
  if (!zip || !zip.entries.has('word/document.xml') || !zip.entries.has('[Content_Types].xml')) return null;
  const types = xmlText(zip.read('[Content_Types].xml'));
  if (!types.includes(WORD_MIME + '.main+xml') && !types.includes('wordprocessingml.document.main+xml')) return null;
  const parts = ['word/document.xml', ...[...zip.entries.keys()].filter(name =>
    /^word\/(?:header|footer)\d+\.xml$/.test(name) || /^word\/(?:footnotes|endnotes)\.xml$/.test(name)).sort()];
  bounded(parts.length <= LIMIT.parts, 'Office document has too many XML sections.');
  let totalXml = 0;
  const sections = [];
  for (const name of parts) {
    signal?.throwIfAborted();
    const raw = zip.read(name);
    totalXml += raw.length;
    bounded(totalXml <= LIMIT.decodedBytes, 'Office document exceeds its decoded XML budget.');
    const lines = wordLines(xmlText(raw));
    if (lines.length) sections.push({ part: name, lines });
  }
  const body = sections.find(section => section.part === 'word/document.xml');
  if (!body?.lines.length) invalid('The Word document contains no readable text; embedded images may require visual review.', 'OFFICE_DOCUMENT_UNREADABLE');
  const text = sections.map(section => (section.part === 'word/document.xml' ? '' : '[' + section.part + ']\n') + section.lines.join('\n')).join('\n\n');
  bounded(text.length <= LIMIT.textChars, 'Word document text exceeds the bounded readiness source budget.');
  return {
    format: WORD_DOCUMENT_FORMAT, mime: WORD_MIME, extension: 'docx',
    text, lineCount: text.split('\n').length, characterCount: text.length,
    sectionCount: sections.length, reader: 'wordprocessingml-v1'
  };
}
