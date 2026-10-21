import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, readdir, rm, rename, mkdir, link, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {ApplicationDocumentStore} from '../lib/application-documents.mjs';

const source = {sessionId: 'app_12345678-1234-4234-8234-123456789012', appId: 'notepad-classic', applicationName: 'Notepad'};
const input = (text = 'A saved note', extra = {}) => ({title: 'Draft note', source, text, ...extra});
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-application-documents-'));
  const store = new ApplicationDocumentStore({dataDir, ...options});
  await store.init();
  t.after(async () => {
    await store.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dataDir, {recursive: true, force: true});
  });
  return {store, dataDir, directory: path.join(dataDir, 'application-documents')};
}

test('immutable snapshot receipts omit text and preserve exact Unicode, CRLF and UTF-8 digest', async t => {
  const {store, directory} = await fixture(t);
  const text = 'First line\r\nIce: ❄ 雪 🧊\r\n\tLast line\r\n';
  const receipt = await store.save(input(text));
  assert.match(receipt.id, /^doc_[a-f0-9-]{36}$/);
  assert.equal(receipt.title, 'Draft note');
  assert.deepEqual(receipt.source, source);
  assert.equal(receipt.sha256, sha256(text));
  assert.equal(receipt.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(receipt.characters, text.length);
  assert.equal(receipt.createdAt, new Date(receipt.createdAt).toISOString());
  assert.equal(receipt.text, undefined);
  assert.ok(!JSON.stringify(store.list()).includes('First line'));
  assert.deepEqual(store.status(), {healthy: true, error: null, count: 1, maxDocuments: 100});
  assert.deepEqual(await store.read(receipt.id), {...receipt, text});
  assert.deepEqual(await readdir(directory), [`${receipt.id}.json`]);
  const saved = JSON.parse(await readFile(path.join(directory, `${receipt.id}.json`), 'utf8'));
  assert.equal(saved.text, text); assert.equal(saved.version, 1);
});

test('repeated and concurrent saves deduplicate exact session plus hash without rewriting the original receipt', async t => {
  const {store, directory} = await fixture(t);
  const original = await store.save(input('Original content'));
  const originalBytes = await readFile(path.join(directory, `${original.id}.json`));
  const receipts = await Promise.all(Array.from({length: 6}, (_, index) => store.save(input('Original content', {title: `Renamed ${index}`}))));
  for (const receipt of receipts) assert.deepEqual(receipt, original);
  assert.equal(store.status().count, 1);
  assert.deepEqual(await readFile(path.join(directory, `${original.id}.json`)), originalBytes);
  const otherSession = await store.save(input('Original content', {source: {...source, sessionId: 'other-session'}}));
  assert.notEqual(otherSession.id, original.id);
  const differentLineEndings = await store.save(input('Original content\r\n'));
  assert.notEqual(differentLineEndings.sha256, original.sha256);
  assert.equal(store.status().count, 3);
});

test('capacity blocks only new content, never deduplication, reads or prior snapshots', async t => {
  const {store, directory} = await fixture(t, {maxDocuments: 1});
  const original = await store.save(input('Retain me'));
  await assert.rejects(store.save(input('New content')), {status: 507, code: 'APPLICATION_DOCUMENT_CAPACITY'});
  assert.deepEqual(await store.save(input('Retain me', {title: 'Another title'})), original);
  assert.equal((await store.read(original.id)).text, 'Retain me');
  assert.deepEqual(await readdir(directory), [`${original.id}.json`]);
  assert.equal(store.status().healthy, true);
});

test('restart validates persisted content and deduplicates without opening an application', async t => {
  const {store, dataDir, directory} = await fixture(t);
  const original = await store.save(input('Persisted\r\ntext'));
  await store.close();
  const restarted = new ApplicationDocumentStore({dataDir}); await restarted.init();
  t.after(() => restarted.close());
  assert.deepEqual(restarted.list(), [original]);
  assert.equal((await restarted.read(original.id)).text, 'Persisted\r\ntext');
  assert.deepEqual(await restarted.save(input('Persisted\r\ntext')), original);
  assert.deepEqual(await readdir(directory), [`${original.id}.json`]);
  assert.equal(restarted.status().healthy, true);
});

test('receipts and returned source objects are copies and cannot mutate stored metadata', async t => {
  const {store} = await fixture(t);
  const original = await store.save(input());
  const expected = structuredClone(original);
  original.title = 'Changed'; original.source.sessionId = 'changed';
  const listed = store.list(); listed[0].source.applicationName = 'Changed'; listed.push({});
  const read = await store.read(expected.id); read.source.appId = 'changed';
  assert.deepEqual(store.list(), [expected]);
  assert.deepEqual(await store.save(input()), expected);
});

test('invalid inputs and arbitrary IDs are rejected before any snapshot is written', async t => {
  const {store, directory} = await fixture(t);
  for (const value of [null, [], input('text', {filename: '../outside'}), input('text', {title: ''}), input('text', {title: 'x'.repeat(161)}), input('text', {source: {...source, executable: 'cmd.exe'}}), input('text', {source: {}}), input('text\0other'), input('x'.repeat(10001)), input('\ud800')]) {
    await assert.rejects(store.save(value), {status: 400});
  }
  for (const id of ['../outside', '..\\outside', 'doc_../../outside', 'C:\\private\\secret', 'doc_12345678-1234-1234-1234-123456789012', null]) await assert.rejects(store.read(id), {status: 400});
  await assert.rejects(store.read('doc_12345678-1234-4234-8234-123456789012'), {status: 404});
  assert.deepEqual(await readdir(directory), []);
  assert.equal(store.status().healthy, true);
});

test('empty text and the maximum JavaScript character bound are valid snapshots', async t => {
  const {store} = await fixture(t);
  const empty = await store.save(input(''));
  assert.equal(empty.bytes, 0); assert.equal(empty.characters, 0);
  assert.equal((await store.read(empty.id)).text, '');
  const maximum = '\u0001'.repeat(10000);
  const receipt = await store.save(input(maximum));
  assert.equal(receipt.characters, 10000); assert.equal((await store.read(receipt.id)).text, maximum);
  const multibyte = '雪'.repeat(10000);
  assert.equal((await store.save(input(multibyte))).bytes, 30000);
  await assert.rejects(store.save(input('🧊'.repeat(5001))), /at most 10000/);
});

test('content tampering after save preserves the corrupt file and keeps other documents readable', async t => {
  const {store, directory} = await fixture(t);
  const bad = await store.save(input('Before'));
  const good = await store.save(input('Unaffected'));
  const filename = path.join(directory, `${bad.id}.json`);
  const corrupted = JSON.parse(await readFile(filename, 'utf8')); corrupted.text = 'After';
  const bytes = JSON.stringify(corrupted); await writeFile(filename, bytes);
  await assert.rejects(store.read(bad.id), {code: 'APPLICATION_DOCUMENT_CORRUPT'});
  assert.equal(await readFile(filename, 'utf8'), bytes);
  assert.equal(store.status().healthy, false); assert.equal(store.status().count, 1);
  assert.equal((await store.read(good.id)).text, 'Unaffected');
  assert.deepEqual(await store.save(input('Unaffected')), good, 'idempotent receipts remain available without a write');
  await assert.rejects(store.save(input('New')), {status: 503});
});

test('even internally consistent metadata changes cannot replace an immutable receipt', async t => {
  const {store, directory} = await fixture(t);
  const original = await store.save(input('Original'));
  const filename = path.join(directory, `${original.id}.json`);
  const value = JSON.parse(await readFile(filename, 'utf8')); value.title = 'Replaced title';
  await writeFile(filename, JSON.stringify(value));
  await assert.rejects(store.read(original.id), {code: 'APPLICATION_DOCUMENT_CORRUPT'});
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).title, 'Replaced title');
});

test('init preserves corrupt, oversized and unexpected files while indexing intact snapshots', async t => {
  const {store, dataDir, directory} = await fixture(t);
  const good = await store.save(input('Good snapshot'));
  await store.close();
  const invalidId = 'doc_11111111-1111-4111-8111-111111111111';
  const oversizedId = 'doc_22222222-2222-4222-8222-222222222222';
  const badFile = path.join(directory, `${invalidId}.json`);
  const largeFile = path.join(directory, `${oversizedId}.json`);
  await writeFile(badFile, '{broken JSON');
  await writeFile(largeFile, 'x'.repeat(81 * 1024));
  await writeFile(path.join(directory, 'notes.txt'), 'Preserve this file');
  const restarted = new ApplicationDocumentStore({dataDir}); await restarted.init();
  t.after(() => restarted.close());
  assert.equal(restarted.status().healthy, false); assert.match(restarted.status().error, /preserved/);
  assert.deepEqual(restarted.list(), [good]);
  assert.equal((await restarted.read(good.id)).text, 'Good snapshot');
  assert.equal(await readFile(badFile, 'utf8'), '{broken JSON');
  assert.equal((await readFile(largeFile)).length, 81 * 1024);
  assert.equal(await readFile(path.join(directory, 'notes.txt'), 'utf8'), 'Preserve this file');
  await assert.rejects(restarted.save(input('New content')), {status: 503});
});

test('disk failure pauses writes without replacing or removing prior snapshots', async t => {
  const {store, directory} = await fixture(t);
  const original = await store.save(input('Retained before failure'));
  const displaced = `${directory}-retained`;
  await rename(directory, displaced); await writeFile(directory, 'Not a directory');
  await assert.rejects(store.save(input('Cannot save')), {code: 'APPLICATION_DOCUMENT_STORAGE'});
  assert.equal(store.status().healthy, false);
  assert.equal(await readFile(directory, 'utf8'), 'Not a directory');
  await rm(directory); await rename(displaced, directory);
  assert.equal((await store.read(original.id)).text, 'Retained before failure');
  assert.deepEqual(await readdir(directory), [`${original.id}.json`]);
});

test('hard-linked snapshot files are rejected and the outside link is never changed', async t => {
  const {store, dataDir, directory} = await fixture(t);
  const original = await store.save(input('Do not edit outside files'));
  const filename = path.join(directory, `${original.id}.json`);
  const outside = path.join(dataDir, 'outside-copy.json');
  await link(filename, outside);
  const before = await readFile(outside);
  await assert.rejects(store.read(original.id), {code: 'APPLICATION_DOCUMENT_CORRUPT'});
  assert.deepEqual(await readFile(outside), before);
  assert.deepEqual(await readFile(filename), before);
});

test('a junction or symlink for the storage directory is rejected without touching its target', async t => {
  const {store, dataDir, directory} = await fixture(t);
  await store.close(); await rm(directory, {recursive: true});
  const outside = path.join(dataDir, 'outside-directory'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Untouched');
  try { await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This account cannot create a directory link.'); return; } throw error; }
  const restarted = new ApplicationDocumentStore({dataDir}); await restarted.init();
  t.after(() => restarted.close());
  assert.equal(restarted.status().healthy, false);
  await assert.rejects(restarted.save(input()), {status: 503});
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Untouched');
});

test('invalid stored UTF-8, text hashes and source fields do not enter the document list', async t => {
  const {store, dataDir, directory} = await fixture(t);
  const original = await store.save(input('A valid original'));
  await store.close();
  const originalValue = JSON.parse(await readFile(path.join(directory, `${original.id}.json`), 'utf8'));
  const invalidHashId = 'doc_33333333-3333-4333-8333-333333333333';
  const invalidSourceId = 'doc_44444444-4444-4444-8444-444444444444';
  const invalidUtf8Id = 'doc_55555555-5555-4555-8555-555555555555';
  await writeFile(path.join(directory, `${invalidHashId}.json`), JSON.stringify({...originalValue, id: invalidHashId, sha256: '0'.repeat(64)}));
  await writeFile(path.join(directory, `${invalidSourceId}.json`), JSON.stringify({...originalValue, id: invalidSourceId, source: {...source, filename: '../outside'}}));
  await writeFile(path.join(directory, `${invalidUtf8Id}.json`), Buffer.from([0xff, 0xfe, 0xfd]));
  const restarted = new ApplicationDocumentStore({dataDir}); await restarted.init();
  t.after(() => restarted.close());
  assert.deepEqual(restarted.list(), [original]);
  assert.equal(restarted.status().healthy, false);
  assert.equal((await readdir(directory)).length, 4);
});

test('close drains already accepted saves and prevents further disk operations', async t => {
  const {store, directory} = await fixture(t);
  const pending = store.save(input('Accepted before close'));
  await store.close();
  const receipt = await pending;
  assert.equal(store.status().count, 1);
  await assert.rejects(store.save(input('After close')), /closed/);
  await assert.rejects(store.read(receipt.id), /closed/);
  await store.close();
  assert.deepEqual(await readdir(directory), [`${receipt.id}.json`]);
});

test('invalid constructor capacities and uninitialized operations fail explicitly', async t => {
  for (const maxDocuments of [0, -1, 1.5, 1001, '100']) assert.throws(() => new ApplicationDocumentStore({dataDir: os.tmpdir(), maxDocuments}), /capacity/);
  assert.throws(() => new ApplicationDocumentStore(), /directory/);
  const store = new ApplicationDocumentStore({dataDir: os.tmpdir()});
  await assert.rejects(store.save(input()), /Initialize/);
  await store.close();
});
