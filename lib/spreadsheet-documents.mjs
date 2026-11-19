import path from 'node:path';
import { zipIndex, xmlText, decoded } from './office-documents.mjs';

const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentNS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
export const XLSX_ROWS = 1048576;
export const XLSX_COLUMNS = 16384;
const LIMIT = { sheets: 100, xmlBytes: 2 * 1024 * 1024, pageChars: 34000, stringChars: 2048, pageRows: 50, pageColumns: 20 };
const fail = (message, code = 'XLSX_INVALID') => { throw Object.assign(new Error(message), { code }); };
const require = (ok, message) => { if (!ok) fail(message); };
const limit = message => fail(message, 'XLSX_LIMIT_EXCEEDED');
const unsupported = message => fail(message, 'XLSX_UNSUPPORTED');
const name = '[A-Za-z_][\\w.:-]*';
const textValue = value => value.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// This is a bounded OOXML subset, not a general XML or Excel interpretation engine.
function readXml(zip, part, namespace, root, signal, visitor) {
  const info = zip.entries.get(part);
  if (info?.sizeRaw > LIMIT.xmlBytes) limit('An XLSX XML part exceeds the 2 MiB decoded limit.');
  const xml = xmlText(zip.read(part));
  require(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'The XLSX part contains invalid XML control characters.');
  const token = new RegExp('<!--(?:[^-]|-(?!-))*-->|<\\?xml\\s[^?]*\\?>|</?' + name + '(?:[^<>"\\\']|"[^"<]*"|\\\'[^\\\'<]*\\\')*>|[^<]+', 'gy');
  const startTag = new RegExp('^<(' + name + ')');
  const attr = new RegExp('\\s+(' + name + ')\\s*=\\s*("([^"]*)"|\\\'([^\\\']*)\\\')', 'y');
  const stack = []; let offset = 0, rootSeen = false, count = 0;
  const expanded = (qname, ns, attribute = false) => {
    const names = qname.split(':');
    require(names.length <= 2 && names.every(Boolean), 'Invalid XLSX XML name.');
    const [first, local] = names;
    const uri = local ? ns[first] : attribute ? '' : ns[''] || '';
    require(uri !== undefined, 'Unbound XLSX XML namespace prefix.');
    return { uri, local: local || first };
  };
  let match;
  while ((match = token.exec(xml))) {
    if ((++count & 1023) === 0) signal?.throwIfAborted();
    if (count > 180000) limit('The XLSX part has too many XML nodes for one read.');
    const raw = match[0], previous = offset; offset = token.lastIndex;
    if (raw.startsWith('<!--')) continue;
    if (raw.startsWith('<?')) { require(previous === 0 && !rootSeen, 'Unexpected XLSX XML instruction.'); continue; }
    if (raw.startsWith('</')) {
      const entry = stack.at(-1);
      require(entry && raw.slice(2, -1).trim() === entry.qname, 'Invalid XLSX XML closing element.');
      visitor('close', stack, entry); stack.pop();
    } else if (raw[0] !== '<') {
      require(stack.length || !raw.trim(), 'Unexpected text outside XLSX XML root.');
      if (stack.length) visitor('text', stack, raw);
    } else {
      if (raw.length > 16384) limit('An XLSX opening tag exceeds the XML inspection limit.');
      const qname = startTag.exec(raw)[1], self = raw.endsWith('/>');
      const end = raw.length - (self ? 2 : 1), attrs = Object.create(null);
      let cursor = qname.length + 1;
      const ns = Object.assign(Object.create(null), stack.at(-1)?.ns || { xml: 'http://www.w3.org/XML/1998/namespace' });
      while (cursor < end && raw.slice(cursor, end).trim()) {
        attr.lastIndex = cursor; const value = attr.exec(raw);
        require(value && attr.lastIndex <= end && !Object.hasOwn(attrs, value[1]), 'Malformed XLSX XML attribute.');
        const key = value[1], data = decoded(value[3] ?? value[4]);
        attrs[key] = data;
        if (key === 'xmlns' || key.startsWith('xmlns:')) ns[key === 'xmlns' ? '' : key.slice(6)] = data;
        cursor = attr.lastIndex;
      }
      if (Object.keys(ns).length > 64) limit('The XLSX part declares too many XML namespaces.');
      const values = new Map();
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
        const { uri, local } = expanded(key, ns, true), attribute = uri + '\0' + local;
        require(!values.has(attribute), 'Duplicate expanded XLSX XML attribute.');
        values.set(attribute, value);
      }
      const element = { qname, ns, ...expanded(qname, ns), get: (local, uri = '') => values.get(uri + '\0' + local) };
      if (!stack.length) {
        require(!rootSeen, 'Multiple XLSX XML roots.');
        if (element.uri !== namespace || element.local !== root) unsupported('Unexpected XLSX part type or unsupported OOXML namespace.');
        rootSeen = true;
      }
      if (stack.length >= 32) limit('The XLSX XML nesting exceeds the inspection limit.');
      stack.push(element); visitor('open', stack, element);
      if (self) { visitor('close', stack, element); stack.pop(); }
    }
  }
  require(offset === xml.length && rootSeen && !stack.length, 'Incomplete or malformed XLSX XML.');
}
const at = (stack, ns, ...names) => stack.length === names.length && names.every((word, i) => stack[i].uri === ns && stack[i].local === word);
function resolveInternal(owner, relationship) {
  if (!relationship || relationship.mode && relationship.mode !== 'Internal') return null;
  const target = relationship.target;
  if (!target || /[:?#%\\\u0000-\u0020\u007f]/.test(target) || target.startsWith('//')) return null;
  const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(owner), target));
  return resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/') ? null : resolved;
}
function relationshipMap(zip, part, signal) {
  const map = new Map();
  readXml(zip, part, packageNS, 'Relationships', signal, (event, stack, element) => {
    if (event !== 'open' || !at(stack, packageNS, 'Relationships', 'Relationship')) return;
    const id = element.get('Id'), type = element.get('Type');
    require(id && type && !map.has(id), 'Invalid or duplicate XLSX package relationship.');
    map.set(id, { type, target: element.get('Target'), mode: element.get('TargetMode') });
  });
  return map;
}
function integer(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) fail(label + ' must be an integer from 1 to ' + max + '.', 'XLSX_ARGUMENT');
  return value;
}
function positiveDigits(value, max) {
  const result = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : 0;
  require(result > 0 && result <= max, 'Invalid XLSX coordinate.');
  return result;
}
const on = value => value === '1' || value === 'true';
function readWorkbook(zip, signal) {
  const packageRels = relationshipMap(zip, '_rels/.rels', signal);
  const workbookRels = [...packageRels.values()].filter(rel => rel.type === relNS + '/officeDocument');
  if (workbookRels.length !== 1) unsupported('This package does not declare one supported XLSX workbook.');
  const workbook = resolveInternal('', workbookRels[0]);
  if (!workbook) unsupported('Only an internal XLSX workbook part can be read.');
  let contentType;
  readXml(zip, '[Content_Types].xml', contentNS, 'Types', signal, (event, stack, el) => {
    if (event === 'open' && at(stack, contentNS, 'Types', 'Override') && el.get('PartName') === '/' + workbook) {
      require(contentType === undefined, 'Duplicate XLSX workbook content type.');
      contentType = el.get('ContentType');
    }
  });
  if (contentType !== xlsxType || [...zip.entries.keys()].some(item => /(?:^|\/)vbaProject\.bin$/i.test(item))) unsupported('Only standard, macro-free .xlsx workbooks are supported.');
  const rels = relationshipMap(zip, path.posix.join(path.posix.dirname(workbook), '_rels', path.posix.basename(workbook) + '.rels'), signal);
  const sheets = [], names = new Set();
  readXml(zip, workbook, sheetNS, 'workbook', signal, (event, stack, el) => {
    if (event !== 'open' || !at(stack, sheetNS, 'workbook', 'sheets', 'sheet')) return;
    const name = textValue(el.get('name') ?? ''), visibility = el.get('state') ?? 'visible';
    require(name && name.length <= 31 && !names.has(name.toLowerCase()) && ['visible','hidden','veryHidden'].includes(visibility), 'Invalid or duplicate XLSX worksheet name or visibility.');
    names.add(name.toLowerCase());
    if (sheets.length >= LIMIT.sheets) limit('The workbook exceeds the 100-sheet manifest limit.');
    const rel = rels.get(el.get('id', relNS));
    const part = rel?.type === relNS + '/worksheet' ? resolveInternal(workbook, rel) : null;
    sheets.push({ name, visibility, status: part && zip.entries.has(part) ? 'worksheet' : part ? 'missing-worksheet-part' : 'unsupported-sheet', part });
  });
  require(sheets.length, 'The XLSX workbook has no sheet manifest.');
  return { workbook, rels, sheets };
}
function cellCoordinates(ref, row, previousColumn) {
  if (ref === undefined) return previousColumn + 1;
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
  require(match && Number(match[2]) === row, 'Invalid XLSX cell reference.');
  return [...match[1]].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0);
}
const letters = column => column > 0 ? letters(Math.floor((column - 1) / 26)) + String.fromCharCode(65 + (column - 1) % 26) : '';
const notes = 'Stored values only. Formula caches may be stale or absent; formulas are never evaluated. Row flags are explicit attributes only; styles/date formatting, inherited visibility, hidden columns, filters, drawings and external links are not inspected.';
export function readSpreadsheet(bytes, options = {}) {
  const { sheet, signal } = options;
  const paging = [options.startRow, options.rowCount, options.startColumn, options.columnCount];
  if (sheet === undefined && paging.some(value => value !== undefined)) fail('Specify a sheet name to read a row and column range.', 'XLSX_ARGUMENT');
  const firstRow = integer(paging[0], 1, XLSX_ROWS, 'Start row');
  const rowCount = integer(paging[1], 20, LIMIT.pageRows, 'Row count');
  const firstCol = integer(paging[2], 1, XLSX_COLUMNS, 'Start column');
  const colCount = integer(paging[3], 12, LIMIT.pageColumns, 'Column count');
  const zip = zipIndex(bytes);
  if (!zip) fail('This is not a valid XLSX archive.');
  const book = readWorkbook(zip, signal);
  if (sheet === undefined) return { format: 'xlsx', sheets: book.sheets.map(({ part, ...value }) => value), notes };
  if (typeof sheet !== 'string') fail('Use an exact worksheet name from the manifest.', 'XLSX_ARGUMENT');
  const selected = book.sheets.find(item => item.name === sheet);
  if (!selected) fail('No worksheet has that exact name. Read the manifest first.', 'XLSX_ARGUMENT');
  if (selected.status !== 'worksheet') unsupported('Selected sheet cannot be read: ' + selected.status + '.');
  const shared = [];
  let gotShared = false;
  function sharedValue(raw) {
    if (!gotShared) {
      gotShared = true;
      const entries = [...book.rels.values()].filter(rel => rel.type === relNS + '/sharedStrings');
      const part = entries.length === 1 ? resolveInternal(book.workbook, entries[0]) : null;
      if (!part) unsupported('Shared strings need a single internal XLSX table.');
      let value;
      readXml(zip, part, sheetNS, 'sst', signal, (event, stack, entry) => {
        if (event === 'open' && at(stack, sheetNS, 'sst', 'si')) value = '';
        if (event === 'text' && (at(stack, sheetNS, 'sst', 'si', 't') || at(stack, sheetNS, 'sst', 'si', 'r', 't'))) value += decoded(entry);
        if (event === 'close' && at(stack, sheetNS, 'sst', 'si')) shared.push(textValue(value));
      });
    }
    require(/^(0|[1-9]\d*)$/.test(raw) && Number(raw) < shared.length, 'An XLSX shared string index is invalid.');
    return shared[Number(raw)];
  }
  const rows = [];
  const lastRow = Math.min(firstRow + rowCount - 1, XLSX_ROWS), lastColumn = Math.min(firstCol + colCount - 1, XLSX_COLUMNS);
  let row, cell, highRow = 0, column = 0, highColumn = 0, pageChars = 0, budgetNextRow = null, dataSeen = false;
  const clip = raw => raw.length <= LIMIT.stringChars ? { text: raw } :
    { text: raw.slice(0, LIMIT.stringChars), truncated: true, totalChars: raw.length };
  function value(type, raw) {
    if (raw === undefined) return null;
    if (type === 's') return { type: 'string', ...clip(sharedValue(raw)) };
    if (type === 'str' || type === 'inlineStr') return { type: 'string', ...clip(textValue(raw)) };
    if (type === 'b' && ['0', '1', 'true', 'false'].includes(raw)) return { type: 'boolean', value: on(raw) };
    if (type === 'n' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return { type: 'number', ...clip(raw) };
    return { type: type === 'e' ? 'error' : type === 'd' ? 'date-lexical' : 'uninterpreted', ...clip(raw) };
  }
  readXml(zip, selected.part, sheetNS, 'worksheet', signal, (event, stack, entry) => {
    const isData = (...tail) => at(stack, sheetNS, 'worksheet', 'sheetData', ...tail);
    if (event === 'open' && isData()) { require(!dataSeen, 'Duplicate XLSX sheetData element.'); dataSeen = true; }
    if (event === 'open' && isData('row')) {
      const number = entry.get('r') === undefined ? highRow + 1 : positiveDigits(entry.get('r'), XLSX_ROWS);
      require(number > highRow && number <= XLSX_ROWS, 'XLSX rows are not in coordinate order.');
      highRow = number; column = 0;
      const hidden = entry.get('hidden');
      require(hidden === undefined || ['0','1','true','false'].includes(hidden), 'Invalid XLSX row hidden flag.');
      if (number >= firstRow && number <= lastRow && budgetNextRow === null) row = { row: number, hiddenAttribute: hidden === undefined ? null : on(hidden), cells: [] };
    }
    if (event === 'open' && isData('row', 'c')) {
      const next = cellCoordinates(entry.get('r'), highRow, column);
      require(next > column && next <= XLSX_COLUMNS, 'XLSX cells are not in coordinate order.');
      column = next; highColumn = Math.max(highColumn, next);
      if (row && next >= firstCol && next <= lastColumn) cell = { coordinate: letters(next) + row.row, type: entry.get('t') || 'n' };
    }
    if (cell) {
      if (event === 'open' && isData('row','c','v')) { require(cell.raw === undefined, 'Duplicate XLSX cell value.'); cell.raw = ''; }
      if (event === 'open' && isData('row','c','is')) { require(cell.inline === undefined, 'Duplicate XLSX inline string.'); cell.inline = ''; }
      if (event === 'open' && isData('row','c','f')) { require(cell.formula === undefined, 'Duplicate XLSX cell formula.'); cell.formula = ''; cell.formulaKind = entry.get('t') || 'normal'; }
      if (event === 'text' && isData('row','c','v')) cell.raw += decoded(entry);
      if (event === 'text' && isData('row','c','f')) cell.formula += decoded(entry);
      if (event === 'text' && (isData('row','c','is','t') || isData('row','c','is','r','t'))) cell.inline += decoded(entry);
      if (event === 'close' && isData('row','c')) {
        const { coordinate, type, raw, inline, formula, formulaKind } = cell;
        const stored = value(type, type === 'inlineStr' ? inline : raw === '' && type !== 'str' ? undefined : raw);
        row.cells.push(formula === undefined ? { coordinate, value: stored } :
          { coordinate, formula: { kind: formulaKind, ...(formula ? clip(formula) : { text: null, note: 'No formula text stored on this cell; shared formulas are not expanded.' }) }, cachedValue: stored });
        cell = null;
      }
    }
    if (event === 'close' && isData('row') && row) {
      const size = JSON.stringify(row).length + 1;
      if (pageChars + size <= LIMIT.pageChars) { pageChars += size; rows.push(row); }
      else if (rows.length) budgetNextRow = row.row;
      else limit('This row exceeds the output limit. Reduce columnCount or inspect a narrower column range.');
      row = null;
    }
  });
  require(dataSeen, 'XLSX worksheet has no sheetData.');
  const endRow = budgetNextRow !== null ? budgetNextRow - 1 : Math.max(firstRow - 1, Math.min(lastRow, highRow));
  return { format: 'xlsx', sheet, visibility: selected.visibility, startRow: firstRow, endRow, startColumn: firstCol, endColumn: lastColumn,
    rows, nextRow: budgetNextRow ?? (highRow > lastRow ? lastRow + 1 : null),
    nextColumn: highColumn > lastColumn ? lastColumn + 1 : null,
    note: 'Only stored rows and cells inside the returned coordinates are listed; omitted coordinates are not zeros. ' + notes };
}
