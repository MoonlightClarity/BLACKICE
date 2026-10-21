import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KnowledgeStore, KNOWLEDGE_TOOLS, createKnowledgeToolHandler } from '../lib/knowledge.mjs';

const note = (id, extra = {}) => ({ id, kind: 'memory', title: id, content: `Content for ${id}`, ...extra });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-knowledge-graph-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, cwd: path.join(dataDir, 'project'), other: path.join(dataDir, 'other'), store: await new KnowledgeStore({ dataDir }).init() };
}

test('typed memories and source references persist, filter and retain exact revisions through patch and restore', async t => {
  const { store, dataDir, cwd } = await fixture(t);
  const target = await store.upsert(note('observation', { cwd, memoryType: 'fact', sources: ['report.csv, row 4'] }));
  const saved = await store.upsert(note('decision', { cwd, memoryType: 'decision', sources: ['https://example.invalid/report'], relations: [{ type: 'informs', targetId: target.id }] }));
  assert.equal(store.list({ memoryType: 'decision' })[0].id, saved.id);
  assert.equal(store.list({ memoryType: 'decision' })[0].sourceCount, 1); assert.equal(store.list()[0].sources, undefined, 'metadata search leaves full references for an explicit read');
  assert.equal(store.list({ query: 'report.csv' })[0].id, target.id);
  assert.equal(store.context(cwd).memories.find(item => item.id === saved.id).relationCount, 1);
  const changed = await store.upsert(note(saved.id, { content: 'A changed decision', expectedRevision: saved.revision }));
  assert.equal(changed.memoryType, 'decision'); assert.deepEqual(changed.sources, saved.sources); assert.deepEqual(changed.relations, saved.relations);
  const patched = await store.patch(saved.id, { oldText: 'changed', newText: 'reviewed', expectedRevision: changed.revision });
  assert.deepEqual(patched.relations, saved.relations);
  const restored = await store.restore(saved.id, 1, { source: 'user' }, { expectedRevision: patched.revision });
  assert.equal(restored.content, saved.content); assert.equal(restored.memoryType, 'decision');
  const reopened = await new KnowledgeStore({ dataDir }).init();
  assert.deepEqual(reopened.get(saved.id).sources, saved.sources); assert.deepEqual(reopened.get(saved.id).relations, saved.relations);
  assert.equal(reopened.history(saved.id).history[1].content, 'A reviewed decision');
});

test('legacy memory records load as notes without rewriting the file', async t => {
  const { store, dataDir } = await fixture(t); await store.upsert(note('legacy'));
  const file = path.join(dataDir, 'knowledge.json'), value = JSON.parse(await fs.readFile(file, 'utf8'));
  delete value.entries[0].memoryType; delete value.entries[0].sources; delete value.entries[0].relations;
  await fs.writeFile(file, JSON.stringify(value)); const before = await fs.readFile(file, 'utf8');
  const reopened = await new KnowledgeStore({ dataDir }).init();
  assert.equal(reopened.get('legacy').memoryType, 'note'); assert.deepEqual(reopened.get('legacy').sources, []); assert.deepEqual(reopened.get('legacy').relations, []);
  assert.equal(reopened.list({ memoryType: 'note' }).length, 1); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('invalid types, excessive references, duplicate links and self links do not write', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.upsert(note('bad', { memoryType: 'verified' })), /Memory type/);
  assert.throws(() => store.upsert(note('bad', { sources: ['same', 'same'] })), /duplicates/);
  assert.throws(() => store.upsert(note('bad', { sources: ['two\nlines'] })), /single line/);
  assert.throws(() => store.upsert(note('bad', { sources: Array.from({ length: 21 }, (_, i) => `source-${i}`) })), /at most 20/);
  assert.throws(() => store.upsert(note('self', { relations: [{ type: 'informs', targetId: 'self' }] })), /itself/);
  assert.throws(() => store.upsert(note('bad', { relations: [{ type: 'executes', targetId: 'target' }] })), /Invalid knowledge relationship/);
  assert.throws(() => store.upsert({ ...note('skill'), kind: 'skill', memoryType: 'fact' }), /Only memories/);
  await assert.rejects(store.upsert(note('missing-link', { relations: [{ type: 'supports', targetId: 'absent' }] })), { status: 409 });
  assert.equal(store.list().length, 0);
});

test('relationships resolve atomically, respect workspace scope and cannot silently make global knowledge private', async t => {
  const { store, dataDir, cwd, other } = await fixture(t);
  await store.upsert(note('foreign', { cwd: other }));
  await assert.rejects(store.upsert(note('local', { cwd, relations: [{ type: 'supports', targetId: 'foreign' }] })), /same working folder/);
  const global = await store.upsert(note('global'));
  const linked = await store.upsert(note('local', { cwd, relations: [{ type: 'supports', targetId: global.id }] }));
  await assert.rejects(store.upsert(note(global.id, { cwd: other })), { status: 409 });
  await assert.rejects(store.upsert(note(linked.id, { cwd: null, relations: [{ type: 'informs', targetId: 'foreign' }] })), /same working folder/);
  const stale = await new KnowledgeStore({ dataDir }).init(); await store.remove('global');
  await assert.rejects(stale.upsert(note('new-link', { cwd, relations: [{ type: 'informs', targetId: 'global' }] })), { status: 409 });
  assert.equal(store.get('local').revision, 1);
});

test('target deletion preserves historical relationships and does not break restart, updates or undo', async t => {
  const { store, dataDir, cwd } = await fixture(t);
  await store.upsert(note('old', { cwd, memoryType: 'assumption' }));
  const linked = await store.upsert(note('new', { cwd, memoryType: 'fact', relations: [{ type: 'supersedes', targetId: 'old' }] }));
  assert.equal(store.get('old').deleted, undefined, 'supersedes is descriptive and never deletes its target');
  await store.remove('old');
  const changed = await store.upsert(note('new', { content: 'Revised fact' }));
  assert.deepEqual(changed.relations, linked.relations);
  await store.upsert(note('new', { relations: [], expectedRevision: changed.revision }));
  const restored = await store.restore('new', 1, { source: 'user' });
  assert.deepEqual(restored.relations, linked.relations);
  const reopened = await new KnowledgeStore({ dataDir }).init(); assert.deepEqual(reopened.get('new').relations, linked.relations);
});

test('stale writers cannot overwrite semantic metadata and incompatible restores preserve current records', async t => {
  const { store, dataDir, cwd, other } = await fixture(t);
  await store.upsert(note('target', { cwd }));
  const saved = await store.upsert(note('source', { cwd, relations: [{ type: 'contradicts', targetId: 'target' }] }));
  const stale = await new KnowledgeStore({ dataDir }).init();
  await store.upsert(note('source', { memoryType: 'assumption', relations: [], expectedRevision: 1 }));
  await assert.rejects(stale.upsert(note('source', { memoryType: 'decision', expectedRevision: saved.revision })), { status: 409 });
  await store.upsert(note('target', { cwd: other }));
  await assert.rejects(store.restore('source', 1), { status: 409 });
  assert.equal(store.get('source').memoryType, 'assumption'); assert.deepEqual(store.get('source').relations, []);
});

test('relay_memory exposes and saves typed metadata while tool scope and revision guards remain effective', async t => {
  const { store, cwd, other } = await fixture(t), events = [];
  await store.upsert(note('target', { cwd, memoryType: 'fact' })); await store.upsert(note('private', { cwd: other }));
  const handler = createKnowledgeToolHandler({ store, cwd, runId: 'run', nodeId: 'worker', onEvent: event => events.push(event) });
  const invoke = async arguments_ => JSON.parse((await handler({ name: 'relay_memory', arguments: arguments_ })).contentItems[0].text);
  const saved = (await invoke({ action: 'remember', title: 'Working assumption', content: 'An uncertain premise.', memoryType: 'assumption', sources: ['brief.md section 2'], relations: [{ type: 'contradicts', targetId: 'target' }] })).entry;
  assert.equal(saved.memoryType, 'assumption'); assert.equal(saved.provenance.runId, 'run');
  const found = await invoke({ action: 'search', memoryType: 'assumption' }); assert.equal(found.entries.length, 1); assert.equal(found.entries[0].id, saved.id);
  await assert.rejects(invoke({ action: 'remember', title: 'Leak', content: 'Never saved.', relations: [{ type: 'informs', targetId: 'private' }] }), /same working folder/);
  const spec = KNOWLEDGE_TOOLS.find(item => item.name === 'relay_memory'); assert.equal(spec.inputSchema.properties.relations.items.additionalProperties, false);
  assert.ok(events.some(event => event.action === 'remember' && event.status === 'completed'));
});
