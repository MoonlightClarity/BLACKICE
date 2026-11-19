import test from 'node:test';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { readSpreadsheetInWorker } from '../lib/spreadsheet-reader-worker.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceToolHandler, WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import { readSpreadsheet, XLSX_ROWS, XLSX_COLUMNS } from '../lib/spreadsheet-documents.mjs';
const crcTable = Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function zip(parts){
  const body=[],directory=[];let offset=0;
  for(const [name,source] of Object.entries(parts)){
    const nameBytes=Buffer.from(name),data=Buffer.from(source),compressed=deflateRawSync(data),checksum=crc(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);
    local.writeUInt32LE(checksum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
    body.push(local,nameBytes,compressed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(8,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(compressed.length,20);
    central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
    directory.push(central,nameBytes);offset+=local.length+nameBytes.length+compressed.length;
  }
  const dir=Buffer.concat(directory),end=Buffer.alloc(22),count=Object.keys(parts).length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);
  end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...body,dir,end]);
}

const bookXml = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:ref="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data &amp; café" sheetId="1" ref:id="worksheet"/><sheet name="Hidden" state="veryHidden" sheetId="2" ref:id="hidden"/><sheet name="External" sheetId="3" ref:id="external"/></sheets></workbook>';
const sharedXml = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Café </t></r><r><t>🦊 &amp; &#x6C34;</t></r><rPh><t>Not cell text</t></rPh></si></sst>';
const prefix = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const suffix = '</sheetData></worksheet>';
const sheetXml = prefix + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c><c r="C1"><f>NOW()</f><v/></c><c r="D1" t="b"><v>0</v></c><c r="E1" t="inlineStr"><is><t xml:space="preserve"> &gt; hi </t></is></c></row>' +
'<row r="3" hidden="1"><c r="A3"><f t="shared" si="1"/><v>17</v></c><c r="B3"/><c r="E3" t="e"><v>#DIV/0!</v></c><c r="XFD3"><v>0</v></c></row>' + suffix;
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = (entries) => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
 entries.map(([id, type, target, external]) => '<Relationship Id="'+id+'" Type="'+rel+type+'" Target="'+target+'"'+(external?' TargetMode="External"':'')+'/>').join('') + '</Relationships>';
const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/data/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
function book(extra = {}) {
  return zip({
    '_rels/.rels': rels([['book','officeDocument','/data/workbook.xml']]),
    '[Content_Types].xml': types,
    'data/workbook.xml': bookXml,
    'data/_rels/workbook.xml.rels': rels([['worksheet','worksheet','sub/data.xml'], ['hidden','worksheet','/data/sub/empty.xml'], ['external','worksheet','https://example.invalid/remote.xml',true], ['string','sharedStrings','sub/shared.xml']]),
    'data/sub/data.xml': sheetXml, 'data/sub/empty.xml': prefix + suffix, 'data/sub/shared.xml': sharedXml,
    ...extra,
  });
}
test('relay_workspace can read XLSX manifest and bounded views of stored rows by original path', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-xlsx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace'), file = path.join(dir, 'Synthetic Sheet.XLSX'), bytes = book();
  await fs.mkdir(cwd);
  await fs.writeFile(file, bytes);
  const handler = createWorkspaceToolHandler({ cwd });
  const invoke = async (args = {}) => {
    const result = await handler({ name: 'relay_workspace', arguments: { action: 'read', path: file, ...args } });
    assert.ok(result.contentItems[0].text.length <= 40000);
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
  const manifest = await invoke();
  assert.equal(manifest.success, true, JSON.stringify(manifest));
  assert.equal(manifest.path, file);
  assert.deepEqual(manifest.sheets, [{ name:'Data & café',visibility:'visible',status:'worksheet' }, { name:'Hidden',visibility:'veryHidden',status:'worksheet' }, { name:'External',visibility:'visible',status:'unsupported-sheet' }]);
  const first = await invoke({ sheet: 'Data & café', rowCount: 2, columnCount: 5 });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.nextRow, 3);
  assert.equal(first.nextColumn, 6);
  assert.deepEqual(first.rows, [{ row: 1, hiddenAttribute: null, cells:[
    { coordinate:'A1',value:{type:'string',text:'Café 🦊 & 水'} },
    { coordinate:'B1',formula:{kind:'normal',text:'1+1'},cachedValue:{type:'number',text:'2'} },
    { coordinate:'C1',formula:{kind:'normal',text:'NOW()'},cachedValue:null },
    { coordinate:'D1',value:{type:'boolean',value:false} },
    { coordinate:'E1',value:{type:'string',text:' > hi '} },
  ] }]);
  const next = await invoke({ sheet: first.sheet, startRow: first.nextRow });
  assert.equal(next.rows[0].row, 3);
  assert.equal(next.rows[0].hiddenAttribute, true);
  assert.equal(next.rows[0].cells[0].formula.text, null);
  assert.equal(next.rows[0].cells[1].value, null);
  assert.equal(next.rows[0].cells[2].value.type, 'error');
  assert.equal(next.nextRow, null);
  const far = await invoke({ sheet: first.sheet, startRow: 3, startColumn: 16384 });
  assert.equal(far.rows[0].cells[0].coordinate, 'XFD3');
  assert.equal(far.rows[0].cells[0].value.text, '0');
  assert.equal(far.nextColumn, null);
  assert.deepEqual((await invoke({ sheet:'Hidden' })).rows, []);
  assert.equal((await invoke({ sheet:'External' })).code, 'XLSX_UNSUPPORTED');
  assert.equal((await invoke({ rowCount: 1 })).code, 'XLSX_ARGUMENT');
  assert.equal((await invoke({ sheet:first.sheet, rowCount: 51 })).code, 'XLSX_ARGUMENT');
  assert.equal((await invoke({ sheet:first.sheet, startColumn: 16385 })).code, 'XLSX_ARGUMENT');
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(dir), ['Synthetic Sheet.XLSX','workspace']);
  const readDefinition = WORKSPACE_TOOL.inputSchema.properties;
  assert.equal(readDefinition.startRow.maximum, XLSX_ROWS);
  assert.equal(readDefinition.startColumn.maximum, XLSX_COLUMNS);
});
test('rejects malformed, oversized and unsupported workbook data without inventing cells', () => {
  assert.throws(() => readSpreadsheet(Buffer.from('not a workbook')), { code:'XLSX_INVALID' });
  assert.throws(() => readSpreadsheet(book({ 'data/workbook.xml':bookXml.replace('</workbook>', '') })), { code:'XLSX_INVALID' });
  assert.throws(() => readSpreadsheet(book({ 'data/workbook.xml':bookXml.replace('<sheets>', '<!DOCTYPE x><sheets>') })), { code:'OFFICE_DOCUMENT_INVALID' });
  assert.throws(() => readSpreadsheet(book({ 'xl/vbaProject.bin':'pretend macro' })), { code:'XLSX_UNSUPPORTED' });
  assert.throws(() => readSpreadsheet(book({ 'data/sub/data.xml':prefix+' '.repeat(2*1024*1024)+suffix }), { sheet:'Data & café' }), { code:'XLSX_LIMIT_EXCEEDED' });
  assert.throws(() => readSpreadsheet(book({ 'data/sub/data.xml':sheetXml.replace('<v>0</v>', '<v>99</v>') }), { sheet:'Data & café' }), { code:'XLSX_INVALID' });
  assert.throws(() => readSpreadsheet(book({ 'data/sub/data.xml':sheetXml.replace('r="A3"', 'r="A1"') }), { sheet:'Data & café' }), { code:'XLSX_INVALID' });
});
test('long stored cell strings report explicit excerpt bounds and never present a partial row as complete', () => {
  const xml = prefix + '<row r="1">' + 'ABCDEFGHIJ'.split('').map(c=>'<c r="'+c+'1" t="inlineStr"><is><t>' + '\\'.repeat(5000) + '</t></is></c>').join('') + '</row>' + suffix;
  const bytes = book({ 'data/sub/data.xml':xml });
  assert.throws(() => readSpreadsheet(bytes, { sheet:'Data & café' }), { code:'XLSX_LIMIT_EXCEEDED' });
  const page = readSpreadsheet(bytes, { sheet:'Data & café', columnCount:2 });
  assert.equal(page.rows[0].cells[0].value.truncated, true);
  assert.equal(page.rows[0].cells[0].value.totalChars, 5000);
  assert.equal(page.rows[0].cells[0].value.text.length, 2048);
  assert.equal(page.nextColumn, 3);
});

test('busy or cancelled XLSX reads settle and release the isolated worker slot', async () => {
  const bytes = book({ 'data/sub/data.xml': prefix + Array.from({length:20000}, (_, i) => '<row r="'+(i+1)+'"><c><v>'+i+'</v></c></row>').join('') + suffix });
  const controller = new AbortController();
  const first = readSpreadsheetInWorker(bytes, { sheet: 'Data & café', signal: controller.signal });
  const cancellation = assert.rejects(first, { name: 'AbortError' });
  const second = readSpreadsheetInWorker(bytes, { sheet: 'Data & café', rowCount: 1 });
  await assert.rejects(readSpreadsheetInWorker(bytes), { code: 'XLSX_BUSY' });
  controller.abort();
  await cancellation;
  const replacement = await readSpreadsheetInWorker(bytes);
  assert.equal(replacement.sheets[0].name, 'Data & café');
  assert.equal((await second).rows[0].cells[0].value.text, '0');
});
test('direct connector advertises workbook parameters and returns stored metadata and a row window', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-direct-xlsx-'));
  const cwd = path.join(dir, 'workspace');
  await fs.mkdir(cwd);
  const api = new DirectExecutionAPI({ dataDir: path.join(dir, 'profile'), allowedRoot: cwd });
  t.after(async () => { await api.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await api.init();
  await fs.writeFile(path.join(cwd, 'book.xlsx'), book());
  const client = { id:'xlsx-fixture', label:'Fixture', kind:'chatgpt', scopes:['read','files:read'] };
  const read = api.tools(client).find(tool => tool.name === 'blackice_workspace_read');
  for (const key of ['sheet', 'startRow', 'rowCount', 'startColumn', 'columnCount']) assert.ok(read.inputSchema.properties[key]);
  async function fetch(requestId, args) {
    const admitted = await api.call(read.name, { requestId, action:'read', path:'book.xlsx', ...args }, client);
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const done = await api.getJob(admitted.jobId, client);
      if (done.settled) { assert.equal(done.status, 'succeeded'); return JSON.parse(done.result.text.text); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('The synthetic XLSX direct job did not settle.');
  }
  const manifest = await fetch('workbook-manifest');
  const page = await fetch('stored-cell-page', { sheet:manifest.sheets[0].name, startRow:1, rowCount:1, startColumn:3, columnCount:1 });
  assert.equal(page.rows[0].cells[0].formula.text, 'NOW()');
  assert.equal(page.rows[0].cells[0].cachedValue, null);
});
