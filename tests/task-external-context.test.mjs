import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskExternalContextStore, eligibleExternalContextCall, EXTERNAL_CONTEXT_TOOL } from '../lib/task-external-context.mjs';
import { readOnlyToolDenial } from '../lib/worker-permissions.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-task-external-context-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new TaskExternalContextStore({ dataDir, taskId: 'task-alpha', thresholdBytes: 500 }) };
}
const readCall = { name: 'relay_workspace', arguments: { action: 'read', path: 'fixture.txt' }, callId: 'read-1' };
const result = text => ({ success: true, contentItems: [{ type: 'inputText', text }] });
const parsed = answer => JSON.parse(answer.contentItems[0].text);

test('externalized read-only results can be paged and reassembled byte-exactly after a fresh store is opened', async t => {
  const { dataDir, store } = await fixture(t);
  const original = 'Start ' + '🌕漢字—\r\n'.repeat(500) + ' END-TOKEN-EXACT';
  const value = result(original);
  const compact = await store.archiveResult(readCall, value);
  assert.equal(value.contentItems[0].text, original, 'The original host result is not edited.');
  assert.equal(compact.success, true);
  const pointer = parsed(compact);
  assert.equal(pointer.externalContext, true);
  assert.equal(pointer.tool, 'relay_workspace');
  assert(pointer.bytes > 500);
  assert(!compact.contentItems[0].text.includes('END-TOKEN-EXACT'));
  assert(compact.contentItems[0].text.length < original.length / 4);
  const resumed = new TaskExternalContextStore({ dataDir, taskId: 'task-alpha' });
  const listing = parsed(await resumed.handle({ arguments: { action: 'list' } }));
  assert(listing.items.some(row => row.reference === pointer.reference));
  let offset = 0, recovered = '', pages = 0;
  do {
    const response = await resumed.handle({ arguments: { action: 'read', reference: pointer.reference, offset, maxBytes: 513 } });
    assert.equal(response.success, true);
    const page = parsed(response);
    assert.equal(page.offset, offset);
    assert(page.nextOffset > offset);
    recovered += page.text;
    offset = page.nextOffset;
    pages++;
    if (page.complete) break;
  } while (pages < 100);
  assert(pages > 4);
  assert.equal(offset, pointer.bytes);
  assert.equal(recovered, original);
});

test('short results, write results, unrelated tool calls, and unknown tool semantics are unchanged', async t => {
  const { store } = await fixture(t);
  const small = result('short answer');
  assert.strictEqual(await store.archiveResult(readCall, small), small);
  const write = { ...readCall, arguments: { action: 'write', path: 'fixture.txt', text: 'change' } };
  const large = result('x'.repeat(1000));
  assert.strictEqual(await store.archiveResult(write, large), large);
  assert.strictEqual(await store.archiveResult({ name: 'relay_skills', arguments: { action: 'read' } }, large), large);
  assert.equal(eligibleExternalContextCall({ name: 'relay_find_files', arguments: { query: 'needle' } }), true);
  assert.equal(eligibleExternalContextCall({ name: 'relay_browser', arguments: { action: 'fill' } }), false);
  assert.equal(EXTERNAL_CONTEXT_TOOL.name, 'relay_context_page');
  assert.equal(readOnlyToolDenial({ name: 'relay_context_page', arguments: { action: 'read', reference: 'x' } }, false), null);
  assert.equal(readOnlyToolDenial({ name: 'relay_context_page', arguments: { action: 'list' } }, false), null);
  assert.equal(readOnlyToolDenial({ name: 'relay_context_page', arguments: { action: 'search' } }, false), null);
});

test('task-owned references cannot be read in another task and cannot escape their directory', async t => {
  const { dataDir, store } = await fixture(t);
  const compact = await store.archiveResult(readCall, result('a'.repeat(1500)));
  const ref = parsed(compact).reference;
  const foreign = new TaskExternalContextStore({ dataDir, taskId: 'task-beta' });
  const denied = await foreign.handle({ arguments: { action: 'read', reference: ref } });
  assert.equal(denied.success, false);
  assert.equal(denied.code, 'CONTEXT_ARCHIVE_NOT_FOUND');
  assert.equal((await store.handle({ arguments: { action: 'read', reference: '../outside' } })).code, 'CONTEXT_ARCHIVE_INVALID');
  const badBoundary = await store.handle({ arguments: { action: 'read', reference: ref, offset: 1501 } });
  assert.equal(badBoundary.success, false);
});

test('literal search finds evidence across chunk boundaries without paging through the full result', async t => {
  const { store } = await fixture(t);
  const needle = 'target-marker';
  const original = 'a'.repeat(65532) + '🌕' + needle + '🌕' + 'b'.repeat(70000) + needle;
  const first = Buffer.byteLength(original.slice(0, original.indexOf(needle)), 'utf8');
  const second = Buffer.byteLength(original.slice(0, original.lastIndexOf(needle)), 'utf8');
  const compact = await store.archiveResult(readCall, result(original));
  const reference = parsed(compact).reference;
  const search = args => store.handle({ arguments: { action: 'search', reference, needle, ...args } });
  const one = parsed(await search({ limit: 1 }));
  assert.deepEqual(one.matches, [{ offset: first }]);
  assert.equal(one.complete, false);
  assert.equal(one.nextScanOffset, first + 1);
  const two = parsed(await search({ limit: 1, startOffset: one.nextScanOffset }));
  assert.deepEqual(two.matches, [{ offset: second }]);
  const page = parsed(await store.handle({ arguments: { action: 'read', reference, offset: second, maxBytes: 512 } }));
  assert(page.text.startsWith(needle));
  const noMore = parsed(await search({ startOffset: second + 1 }));
  assert.deepEqual(noMore.matches, []);
  assert.equal(noMore.complete, true);
});

test('missing disk storage leaves full tool result intact instead of losing evidence', async t => {
  const { dataDir } = await fixture(t);
  const occupied = path.join(dataDir, 'occupied');
  await writeFile(occupied, 'regular file');
  const store = new TaskExternalContextStore({ dataDir: occupied, taskId: 'task-alpha', thresholdBytes: 1 });
  const original = result('x'.repeat(4000));
  const observed = await store.archiveResult(readCall, original);
  assert.strictEqual(observed, original);
});
