import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
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
  assert.match(pointer.preview.tail,/END-TOKEN-EXACT/, 'Preserve useful diagnostic tails in the short preview.');
  assert(compact.contentItems[0].text.length < original.length / 2, 'The combined head/tail preview remains bounded even in a small synthetic fixture.');
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

test('large structured diagnostic results preserve both ends and actionable status in a bounded preview', async t => {
  const {store} = await fixture(t);
  const content = '1: start\n' + 'observation\n'.repeat(3000) + '3002: ROOT_CAUSE_CYCLE_WAITED_FOREVER';
  const raw = JSON.stringify({path:'incident.log',startLine:1,endLine:3002,content,truncated:true,nextStartLine:3003});
  const host = result(raw);
  const compact = await store.archiveResult(readCall, host);
  const pointer = parsed(compact);
  assert.equal(pointer.externalContext,true);
  assert.equal(pointer.preview.contentField,'content');
  assert.match(pointer.preview.head,/1: start/);
  assert.match(pointer.preview.tail,/ROOT_CAUSE_CYCLE_WAITED_FOREVER/);
  assert.equal(pointer.preview.truncated,true);
  assert.equal(pointer.preview.nextStartLine,3003);
  assert.deepEqual(pointer.sourceContinuation,{tool:'relay_workspace',action:'read',path:'incident.log',startLine:3003});
  assert.match(pointer.nextAction,/original workspace result was truncated/);
  assert.match(pointer.preview.warning,/not complete evidence/);
  assert(Buffer.byteLength(compact.contentItems[0].text)<Buffer.byteLength(raw)*0.2);
  const match = await store.search({reference:pointer.reference,needle:'ROOT_CAUSE_CYCLE_WAITED_FOREVER'});
  assert.equal(match.matches.length,1);
  const page = await store.read({reference:pointer.reference,offset:match.matches[0].offset,maxBytes:512});
  assert.match(page.text,/ROOT_CAUSE_CYCLE_WAITED_FOREVER/);
  assert.equal(host.contentItems[0].text,raw);
});

test('large failed reads are not hidden behind context references',async t=>{
  const {store}=await fixture(t);
  const failure={success:false,code:'WORKSPACE_ERROR',contentItems:[{type:'inputText',text:'File error '+('x'.repeat(3000))}]};
  assert.strictEqual(await store.archiveResult(readCall,failure),failure);
  assert.deepEqual((await store.list()).items,[]);
});

test('identical tool observations deduplicate across concurrent calls, retries, and reopened task stores',async t=>{
 const {dataDir,store}=await fixture(t);
 const original=JSON.stringify({path:'incident.log',content:'diagnostic event\n'.repeat(1400)+'ROOT_CAUSE'});
 const observations=await Promise.all(Array.from({length:32},(_,index)=>
   store.archiveResult({...readCall,callId:'parallel-'+index},result(original))));
 const ids=new Set(observations.map(item=>parsed(item).reference));
 assert.equal(ids.size,1,'All equivalent observations refer to one preserved artifact.');
 assert.equal((await readdir(store.root)).length,2,'One payload and one metadata file, not 64 files.');
 const reopened=new TaskExternalContextStore({dataDir,taskId:'task-alpha',thresholdBytes:500});
 const again=await reopened.archiveResult({...readCall,callId:'after-restart'},result(original));
 assert.equal(parsed(again).reference,[...ids][0]);
 assert.equal((await readdir(store.root)).length,2);
 const other=await reopened.archiveResult({name:'relay_browser',arguments:{action:'read'}},result(original));
 assert.notEqual(parsed(other).reference,[...ids][0],'Tool provenance is part of the deduplication identity.');
 assert.equal((await readdir(store.root)).length,4);
});

test('two simultaneous task-store instances converge on the same archived result',async t=>{
 const {dataDir,store}=await fixture(t);
 const peer=new TaskExternalContextStore({dataDir,taskId:'task-alpha',thresholdBytes:500});
 const original='parallel writer evidence '.repeat(2000);
 const items=await Promise.all(Array.from({length:20},(_,index)=>
  (index%2?peer:store).archiveResult({...readCall,callId:'concurrent-'+index},result(original))));
 assert.equal(new Set(items.map(item=>parsed(item).reference)).size,1);
 assert.equal((await readdir(store.root)).length,2);
});

test('corrupt stored content fails closed, and an archive failure never removes shared earlier evidence',async t=>{
 const {store}=await fixture(t);
 const original='shared observation '.repeat(1500);
 const first=await store.archiveResult(readCall,result(original));
 const ref=parsed(first).reference;
 const save=store.save.bind(store);
 store.save=async(text,name)=>text.startsWith('FAIL-LATER')?Promise.reject(Error('Simulated storage problem')):save(text,name);
 const combined={success:true,contentItems:[
  {type:'inputText',text:original},{type:'inputText',text:'FAIL-LATER'+('x'.repeat(3000))}]};
 assert.strictEqual(await store.archiveResult(readCall,combined),combined,'If any block cannot archive, the entire original result is returned.');
 assert.equal((await store.read({reference:ref,maxBytes:512})).text.slice(0,10),original.slice(0,10));
 assert.equal((await readdir(store.root)).length,2,'The shared artifact survived later failures.');
 store.save=save;
 const file=store.file(ref,'.txt'),text=await readFile(file,'utf8');
 await writeFile(file,'Z'+text.slice(1),'utf8'); // Same byte length, altered contents
 const failed=await store.handle({arguments:{action:'read',reference:ref}});
 assert.equal(failed.success,false);
 assert.equal(failed.code,'CONTEXT_ARCHIVE_CORRUPT');
 const retry=result(original);
 assert.strictEqual(await store.archiveResult(readCall,retry),retry,'Corruption cannot yield a false pointer.');
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
