import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore, KNOWLEDGE_LIMITS, KNOWLEDGE_INSTRUCTIONS, createKnowledgeToolHandler } from '../lib/knowledge.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-knowledge-audit-')), store = await new KnowledgeStore({ dataDir }).init(), cwd = path.join(dataDir, 'project');
  t.after(async () => { await store.writeChain.catch(() => {}); assert.match(path.basename(dataDir), /^relay-knowledge-audit-/); await rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, cwd };
}
const note = (content, extra = {}) => ({ kind: 'memory', title: 'Project preference', content, ...extra });
const call = (name, arguments_) => ({ name, arguments: arguments_ });
const unpack = result => { assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text); };

test('direct agent saves, patches and removals all retain auditable source revisions and reversible deletion after restart', async t => {
  const { store, dataDir, cwd } = await fixture(t), events = [], agent = createKnowledgeToolHandler({ store, cwd, runId: 'source-chat', nodeId: 'agent-one', onEvent: value => events.push(value) });
  const created = unpack(await agent(call('relay_memory', { action: 'remember', title: 'Theme preference', content: 'Use a black background.' }))).entry;
  const patched = unpack(await agent(call('relay_memory', { action: 'patch', id: created.id, oldText: 'black background', newText: 'black background with clear contrast', expectedRevision: created.revision }))).entry;
  assert.equal(patched.revision, 2); assert.equal(patched.summary, 'Use a black background with clear contrast.');
  assert.equal(patched.history, undefined, 'full agent reads contain one current entry, not its audit history');
  const deletion = unpack(await agent(call('relay_memory', { action: 'forget', id: created.id, expectedRevision: patched.revision })));
  assert.equal(deletion.revision, 3); assert.equal(deletion.deleted, true);
  assert.throws(() => store.get(created.id), { status: 404 }); assert.equal(store.list().length, 0); assert.deepEqual(store.context(cwd).memories, []);
  const restarted = await new KnowledgeStore({ dataDir }).init(), audit = restarted.history(created.id);
  assert.deepEqual(audit.history.map(item => item.revision), [3, 2, 1]); assert.deepEqual(audit.history.map(item => item.action), ['delete', 'update', 'create']);
  assert.equal(audit.history[1].content, 'Use a black background with clear contrast.'); assert.equal(audit.history[2].content, 'Use a black background.');
  for (const entry of audit.history) { assert.equal(entry.provenance.runId, 'source-chat'); assert.equal(entry.provenance.nodeId, 'agent-one'); assert.equal(entry.provenance.source, 'agent'); assert.equal(entry.history, undefined); }
  assert.match(audit.history[1].provenance.reason, /patched/); assert.equal(audit.deleted, true);
  const visibleDeleted = restarted.list({ cwd, deletedOnly: true }); assert.equal(visibleDeleted.length, 1); assert.equal(visibleDeleted[0].content, undefined); assert.equal(visibleDeleted[0].history, undefined);
  const restored = await restarted.restore(created.id, 2, { source: 'user', reason: 'Undo deletion' }, { expectedRevision: 3 });
  assert.equal(restored.revision, 4); assert.equal(restored.content, patched.content); assert.equal(restored.deleted, undefined); assert.equal(restored.provenance.source, 'user'); assert.equal(restored.restoredFromRevision, 2);
  const durable = await new KnowledgeStore({ dataDir }).init(); assert.equal(durable.get(created.id).content, patched.content); assert.equal(durable.history(created.id).history.length, 4);
  assert.ok(events.some(event => event.action === 'forget' && event.status === 'completed' && event.revision === 3)); assert.ok(events.every(event => !Object.hasOwn(event, 'content')));
});

test('old version-one entries gain history on their next write without inventing earlier content', async t => {
  const { dataDir, cwd } = await fixture(t), file = path.join(dataDir, 'knowledge.json'), at = '2025-01-01T00:00:00Z';
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ id: 'legacy', kind: 'skill', title: 'Existing method', summary: 'Previously saved', content: 'Read then test.', cwd, revision: 7, createdAt: at, updatedAt: at, provenance: { source: 'agent', runId: 'older-run' } }] }));
  const migrated = await new KnowledgeStore({ dataDir }).init(); assert.deepEqual(migrated.history('legacy').history.map(item => item.revision), [7]);
  await migrated.patch('legacy', { oldText: 'Read then test.', newText: 'Read, test, then report.', expectedRevision: 7 }, { source: 'agent', runId: 'new-run' });
  assert.deepEqual(migrated.history('legacy').history.map(item => item.revision), [8, 7]); assert.equal(migrated.history('legacy').history[1].content, 'Read then test.');
  const restored = await migrated.restore('legacy', 7, { source: 'user' }, { expectedRevision: 8 }); assert.equal(restored.createdAt, at); assert.equal(restored.content, 'Read then test.');
  assert.equal(migrated.get('legacy').history, undefined); assert.equal(migrated.list()[0].history, undefined); assert.ok(!JSON.stringify(migrated.context(cwd)).includes('Read then test.'));
});

test('revision conflicts are checked against the locked live snapshot and never overwrite a newer instance', async t => {
  const { store, dataDir } = await fixture(t), initial = await store.upsert(note('First version.')), second = await new KnowledgeStore({ dataDir }).init();
  await second.patch(initial.id, { oldText: 'First', newText: 'Second', expectedRevision: 1 }, { source: 'agent', runId: 'parallel-chat' });
  await assert.rejects(store.restore(initial.id, 1, { source: 'user' }, { expectedRevision: 1 }), { status: 409 });
  await assert.rejects(store.patch(initial.id, { oldText: 'First', newText: 'Third', expectedRevision: 1 }), { status: 409 });
  await assert.rejects(store.upsert(note('Must not overwrite.', { id: initial.id, expectedRevision: 1 })), { status: 409 });
  await assert.rejects(store.remove(initial.id, { expectedRevision: 1 }), { status: 409 });
  const durable = await new KnowledgeStore({ dataDir }).init(); assert.equal(durable.get(initial.id).content, 'Second version.'); assert.deepEqual(durable.history(initial.id).history.map(item => item.revision), [2, 1]);
});

test('exact patches reject missing, overlapping or ambiguous passages, empty results and invalid revisions without writes', async t => {
  const { store, dataDir } = await fixture(t), saved = await store.upsert(note('aaaa\nUse literal .* here.\nKeep 🐈.', { summary: 'An explicit summary' })), file = path.join(dataDir, 'knowledge.json'), original = await readFile(file, 'utf8');
  for (const [oldText, newText, pattern] of [['aa', 'b', /more than once/], ['absent', 'b', /does not match/]]) await assert.rejects(store.patch(saved.id, { oldText, newText }), pattern);
  assert.throws(() => store.patch(saved.id, { oldText: '', newText: 'b' }), /nonempty/);
  assert.throws(() => store.patch(saved.id, { oldText: 'aaaa', newText: 'aaaa' }), /must change/);
  assert.throws(() => store.patch(saved.id, { oldText: 'aaaa', newText: 'b', expectedRevision: 0 }), /positive integer/);
  await assert.rejects(store.patch(saved.id, { oldText: saved.content, newText: '' }), /nonempty/);
  assert.equal(await readFile(file, 'utf8'), original); assert.equal(store.history(saved.id).history.length, 1);
  const patched = await store.patch(saved.id, { oldText: 'literal .*', newText: 'literal $& and $1' }); assert.equal(patched.content, 'aaaa\nUse literal $& and $1 here.\nKeep 🐈.'); assert.equal(patched.summary, 'An explicit summary');
});

test('audit history, deletion and restore all commit atomically and failed writes cannot change the visible version', async t => {
  const { store, dataDir } = await fixture(t), initial = await store.upsert(note('Keep the committed value.')), persist = store.writeSnapshot.bind(store), file = path.join(dataDir, 'knowledge.json'), original = await readFile(file, 'utf8');
  store.writeSnapshot = async () => { throw new Error('fixture disk unavailable'); };
  await assert.rejects(store.patch(initial.id, { oldText: 'committed', newText: 'uncommitted' }), /disk unavailable/); await assert.rejects(store.remove(initial.id), /disk unavailable/);
  assert.equal(store.get(initial.id).content, initial.content); assert.equal(store.history(initial.id).history.length, 1); assert.equal(await readFile(file, 'utf8'), original);
  store.writeSnapshot = persist; await store.remove(initial.id); const removed = await readFile(file, 'utf8');
  store.writeSnapshot = async () => { throw new Error('fixture restore failure'); }; await assert.rejects(store.restore(initial.id, 1), /restore failure/);
  assert.throws(() => store.get(initial.id), { status: 404 }); assert.equal(store.history(initial.id).currentRevision, 2); assert.equal(await readFile(file, 'utf8'), removed);
  const restarted = await new KnowledgeStore({ dataDir }).init(); assert.equal(restarted.history(initial.id).deleted, true); assert.equal(restarted.history(initial.id).history[1].content, initial.content);
});

test('history retention is bounded, snapshots are immutable and deleted IDs cannot be silently recreated by an agent', async t => {
  const { store, dataDir } = await fixture(t), initial = await store.upsert(note('Version 1.'));
  for (let revision = 2; revision <= 14; revision++) await store.upsert(note(`Version ${revision}.`, { id: initial.id }), { source: 'agent', runId: `source-${revision}` });
  const audit = store.history(initial.id); assert.equal(audit.history.length, KNOWLEDGE_LIMITS.history + 1); assert.deepEqual(audit.history.map(item => item.revision), [14,13,12,11,10,9,8,7,6]);
  audit.history[1].content = 'Client tampering'; assert.equal(store.history(initial.id).history[1].content, 'Version 13.'); await assert.rejects(store.restore(initial.id, 1), /no longer retained/);
  await store.remove(initial.id); await assert.rejects(store.upsert(note('Recreate silently', { id: initial.id }), { source: 'agent' }), /deleted/);
  assert.equal((await new KnowledgeStore({ dataDir }).init()).history(initial.id).deleted, true);
  await store.restore(initial.id, 14); assert.equal(store.get(initial.id).content, 'Version 14.');
  await store.restore(initial.id, 15); assert.throws(() => store.get(initial.id), { status: 404 }); assert.equal(store.history(initial.id).history[0].action, 'restore', 'restoring a deletion is also auditable');
});

test('agent patching keeps memory kind and workspace boundaries and requires deliberate global scope', async t => {
  const { store, cwd, dataDir } = await fixture(t), other = await store.upsert(note('Other private note.', { cwd: path.join(dataDir, 'other') })), global = await store.upsert(note('Shared preference.')), skill = await store.upsert({ kind: 'skill', title: 'Method', content: 'Read and verify.', cwd });
  const agent = createKnowledgeToolHandler({ store, cwd, runId: 'current-run', nodeId: 'agent' });
  for (const id of [other.id, skill.id]) await assert.rejects(agent(call('relay_memory', { action: 'patch', id, oldText: 'note', newText: 'text' })), /selected scope/);
  await assert.rejects(agent(call('relay_memory', { action: 'patch', id: global.id, oldText: 'Shared', newText: 'Changed' })), /global scope explicitly/);
  const patched = unpack(await agent(call('relay_memory', { action: 'patch', id: global.id, oldText: 'Shared', newText: 'Changed', scope: 'global', expectedRevision: 1 }))).entry;
  assert.equal(patched.content, 'Changed preference.'); assert.equal(patched.cwd, null);
  const patchedSkill = unpack(await agent(call('relay_skills', { action: 'patch', id: skill.id, oldText: 'Read and verify.', newText: 'Read, verify, report.', expectedRevision: 1 }))).entry; assert.equal(patchedSkill.kind, 'skill');
  assert.match(KNOWLEDGE_INSTRUCTIONS, /automatic/); assert.match(KNOWLEDGE_INSTRUCTIONS, /expectedRevision/); assert.match(KNOWLEDGE_INSTRUCTIONS, /Do not ask for routine approval/);
});

test('a cancelled queued patch never appears in revision history', async t => {
  const { store } = await fixture(t), initial = await store.upsert(note('Original.')); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; }), persist = store.writeSnapshot.bind(store);
  store.writeSnapshot = async (...args) => { enter(); await held; return persist(...args); };
  const saving = store.upsert(note('Unrelated.', { id: 'unrelated' })); await entered;
  const controller = new AbortController(), cancelled = store.patch(initial.id, { oldText: 'Original', newText: 'Cancelled' }, { source: 'agent' }, { signal: controller.signal }), rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); release(); await saving; await rejected; assert.equal(store.get(initial.id).content, 'Original.'); assert.equal(store.history(initial.id).history.length, 1);
});
