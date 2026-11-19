import test from 'node:test';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { zip } from './fixtures/office-zip.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectWordDocument, WORD_MIME } from '../lib/office-documents.mjs';
import { inspectAttachment, AttachmentStore, createAttachmentToolHandler } from '../lib/attachments.mjs';
import { TaskViability } from '../lib/task-viability.mjs';
import { attachmentResourceKey, normalizeHostOperationResult } from '../lib/operation-descriptors.mjs';

const digest = x => createHash('sha256').update(x).digest('hex');
const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="' + WORD_MIME + '.main+xml"/></Types>';
const doc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
'<w:p><w:r><w:t>Research &amp; due diligence</w:t></w:r></w:p>' +
'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Employer</w:t></w:r></w:p></w:tc>' +
'<w:tc><w:p><w:r><w:t>Fully remote</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
'<w:p><w:r><w:t>Final résumé finding.</w:t></w:r></w:p></w:body></w:document>';
const header='<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Contact header</w:t></w:r></w:p></w:hdr>';
const word = () => zip({'[Content_Types].xml':types,'word/document.xml':doc,'word/header1.xml':header});
const fixture = async t => {const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-word-reader-'));const store=await new AttachmentStore({dataDir:dir}).init();t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true})});return {dir,store}};

test('DOCX original is parsed before planning into paragraphs, tables and header without converting or changing files',async t=>{
  const {store,dir}=await fixture(t),bytes=word(),metadata=inspectAttachment('resume.docx',bytes);
  assert.equal(metadata.kind,'document');assert.equal(metadata.format,'docx');assert.equal(metadata.mime,WORD_MIME);
  const entry=await store.importBytes({name:'resume.docx',bytes});
  assert.equal(entry.sha256,digest(bytes));assert.equal(entry.kind,'document');assert.equal(entry.reader,'wordprocessingml-v1');
  assert.deepEqual((await store.bytes(entry.id)).bytes,bytes);
  const parsed=await store.text(entry.id);
  assert.match(parsed.text,/Research & due diligence/);assert.match(parsed.text,/\| Employer \| Fully remote \|/);
  assert.match(parsed.text,/Contact header/);
  const read=await store.read(entry.id,{startLine:1,lineCount:25});
  assert.ok(read.lines.some(line=>line.text.includes('Fully remote')));
  const matched=await store.search(entry.id,{query:'remote'});
  assert.ok(matched.matches.some(m=>m.text.includes('Fully remote')));
  const handler=createAttachmentToolHandler({store,attachmentIds:[entry.id]});
  const tools=await handler({name:'relay_files',arguments:{action:'read',attachmentId:entry.id}});
  assert.equal(tools.success,true);
  const shown=JSON.parse(tools.contentItems[0].text);
  assert.equal(shown.attachment.sha256,digest(bytes));
  const coverage = async args => {
    const call = { name:'relay_files', arguments:{action:'read',attachmentId:entry.id,...args} };
    const result = await handler(call), descriptor = await handler.describeOperation(call);
    const { evidence } = await normalizeHostOperationResult(result, { call, descriptor });
    return evidence.find(row => row.kind === 'source-coverage');
  };
  const line = await coverage({ startLine:1, lineCount:1 });
  assert.deepEqual(line.coverage, { unit:'lines', start:0, end:1, total:shown.totalLines });
  const prefix = await coverage({ startChar:0, charCount:5 }), suffix = await coverage({ startChar:5 });
  assert.deepEqual(prefix.coverage, { unit:'characters', start:0, end:5, total:parsed.text.length });
  assert.deepEqual(suffix.coverage, { unit:'characters', start:5, end:parsed.text.length, total:parsed.text.length });
  assert.ok([line,prefix,suffix].every(row => row.resourceKey === attachmentResourceKey(entry.sha256) && row.sourceVersion === entry.sha256));
  const fresh=await new AttachmentStore({dataDir:dir}).init();t.after(()=>fresh.close());
  assert.equal((await fresh.read(entry.id)).attachment.kind,'document');
});

test('feasibility captures original DOCX text and source hash before invoking a model',async t=>{
  const {store}=await fixture(t),entry=await store.importBytes({name:'resume.docx',bytes:word()});
  const fake={attachments:store,identity:null};
  const result=await TaskViability.prototype.sources.call(fake,{input:'Assess a job search using the original Word resume.',workflow:{nodes:[{id:'agent',type:'agent'}],edges:[]},attachmentIds:[entry.id]});
  const evidence=result.find(source=>source.id==='viability:attachment:'+entry.id);
  assert.ok(evidence);assert.equal(evidence.kind,'artifact');
  assert.match(evidence.text,/Original attachment SHA256: [a-f0-9]{64}/);
  assert.match(evidence.text,/Reader: wordprocessingml-v1/);
  assert.match(evidence.text,/Fully remote/);
  assert.equal(evidence.contentHash,digest(evidence.text));
});

test('legacy opaque Word uploads are readable without rewriting their original attachment receipts',async t=>{
  const {store,dir}=await fixture(t),bytes=word();
  const original=await store.importBytes({name:'historical.docx',bytes});
  await store.close();
  const manifestPath=path.join(dir,'attachments','manifest.json');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const old={...original,kind:'file',extension:'bin',mime:'application/octet-stream',
    processing:{status:'unavailable',format:'binary',code:'FILE_DECODER_UNAVAILABLE',message:'Saved before DOCX support.'}};
  await fs.copyFile(path.join(dir,'attachments','blobs',original.sha256+'.docx'),path.join(dir,'attachments','blobs',original.sha256+'.bin'));
  manifest.files=manifest.files.map(x=>x.id===old.id?old:x);
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await fs.writeFile(path.join(dir,'attachments','records',old.id+'.json'),JSON.stringify(old));
  const reopened=await new AttachmentStore({dataDir:dir}).init();t.after(()=>reopened.close());
  assert.equal((await reopened.get(old.id)).kind,'file');
  const parsed=await reopened.text(old.id);
  assert.equal(parsed.entry.kind,'document');assert.match(parsed.text,/Final résumé finding/);
  const sources=await TaskViability.prototype.sources.call({attachments:reopened,identity:null},{input:'Check original saved resume.',workflow:{nodes:[],edges:[]},attachmentIds:[old.id]});
  assert.ok(sources.find(x=>x.id==='viability:attachment:'+old.id)?.text.includes('Fully remote'));
  assert.equal((await reopened.get(old.id)).kind,'file','original metadata remains immutable');
  assert.deepEqual((await reopened.bytes(old.id)).bytes,bytes);
});

test('invalid ZIP data and non-Word ZIP remain unsupported without false document claims',async()=>{
  const bytes=word(),bad=Buffer.from(bytes);
  const marker=bad.indexOf(Buffer.from('word/document.xml'));
  assert.ok(marker>=0);
  bad[marker]=0;
  const inspected=inspectAttachment('tampered.docx',bad);
  assert.equal(inspected.kind,'file');assert.equal(inspected.processing.format,'docx');
  assert.match(inspected.processing.code,/OFFICE_DOCUMENT_INVALID/);
  const generic=inspectAttachment('archive.zip',zip({'notes.txt':'Neither a Word document nor a user fact.'}));
  assert.equal(generic.kind,'file');
});

test('unsupported and visual-only documents remain explicit recovery inputs, not missing personal facts',async t=>{
  const {store}=await fixture(t),broken=zip({'[Content_Types].xml':types,'word/document.xml':'<w:document><w:body></w:body></w:document>'});
  const item=await store.importBytes({name:'blank.docx',bytes:broken});
  assert.equal(item.kind,'file');assert.match(item.processing.code,/OFFICE_DOCUMENT_UNREADABLE/);
  await assert.rejects(TaskViability.prototype.sources.call({attachments:store,identity:null},
    {input:'Check resume.',workflow:{nodes:[],edges:[]},attachmentIds:[item.id]}),/could not be read or verified|supported reader/i);
});

test('relay_find_files discovered DOCX reads directly by path, paginates extracted lines and preserves the source', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-local-docx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace'), sourceDir = path.join(dir, 'external', 'Nested Documents');
  await fs.mkdir(cwd);
  await fs.mkdir(sourceDir, { recursive: true });
  const file = path.join(sourceDir, 'Synthetic candidate.DOCX'), bytes = word();
  await fs.writeFile(file, bytes);
  const workspace = createWorkspaceToolHandler({ cwd });
  async function invoke(name, args) {
    const result = await workspace({ name, arguments: args });
    return { ...JSON.parse(result.contentItems[0].text), success: result.success };
  }
  const found = await invoke('relay_find_files', { query: 'Synthetic candidate', path: path.join(dir, 'external') });
  assert.equal(found.success, true);
  const target = found.matches[0].path;
  assert.equal(target, file);
  const read = (path, options) => invoke('relay_workspace', { action: 'read', path, ...options });
  const first = await read(target, { lineCount: 1 });
  assert.equal(first.success, true);
  assert.equal(first.path, file);
  assert.equal(first.format, 'docx');
  assert.equal(first.sha256, digest(bytes));
  assert.match(first.content, /^1: Research & due diligence/);
  assert.equal(first.truncated, true);
  assert.equal(first.nextStartLine, 2);
  const rest = await read(target, { startLine: first.nextStartLine });
  assert.match(rest.content, /Fully remote/);
  assert.match(rest.content, /Contact header/);
  assert.equal(rest.truncated, false);
  assert.equal(rest.nextStartLine, null);
  assert.equal((await read(target, { startPage: 1 })).success, false);
  assert.deepEqual(await fs.readdir(sourceDir), ['Synthetic candidate.DOCX']);
  assert.deepEqual(await fs.readFile(file), bytes);
  const invalid = path.join(sourceDir, 'invalid.docx'), blank = path.join(sourceDir, 'blank.docx');
  await fs.writeFile(invalid, 'Not a DOCX');
  await fs.writeFile(blank, zip({'[Content_Types].xml':types,'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'}));
  assert.equal((await read(invalid)).code, 'OFFICE_DOCUMENT_INVALID');
  assert.equal((await read(blank)).code, 'OFFICE_DOCUMENT_UNREADABLE');
  const call = { name: 'relay_workspace', arguments: { action: 'read', path: target } };
  const { evidence } = await normalizeHostOperationResult(await workspace(call), { call, descriptor: await workspace.describeOperation(call) });
  assert.ok(!evidence.some(row => row.kind === 'source-coverage'), 'extracted DOCX lines are not raw-file coverage');
});
