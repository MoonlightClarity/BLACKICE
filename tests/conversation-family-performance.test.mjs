import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';

const turn = (id, { taskId, parentRunId = null, at = 0, status = 'completed', settled = true } = {}) => ({
  id, ...(taskId ? { taskId } : {}), parentRunId,
  createdAt: new Date(1700000000000 + at * 1000).toISOString(), input: 'Message ' + id,
  status, settled, workflow: { nodes: [{ id: 'agent', type: 'agent' }], edges: [] },
  nodes: { agent: { status, output: 'Answer ' + id, threadId: 'thread-' + id } },
  output: 'Answer ' + id, events: [],
});
class Engine extends EventEmitter {
  runs = new Map(); listCalls = 0; snapshots = [];
  snapshot(run) { this.snapshots.push(run.id); return structuredClone(run); }
  listRuns() { this.listCalls++; return [...this.runs.values()].reverse().map(run => this.snapshot(run)); }
  getRun(id) { const run = this.runs.get(id); if (!run) throw Error('Run not found.'); return this.snapshot(run); }
}
async function setup(t, engine = new Engine()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-conversation-family-'));
  const archive = await new ConversationArchive({ dataDir, engine }).init();
  t.after(async () => { engine.runs?.clear(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, engine, dataDir };
}

test('opening one family never materializes 20000 unrelated live transcripts', async t => {
  const { archive, engine, dataDir } = await setup(t);
  const root = turn('saved-root'), child = turn('live-child', { taskId: root.id, parentRunId: root.id, at: 1 });
  await archive.capture(root);
  const rootFile = path.join(dataDir, 'conversations', root.id + '.json'), savedBytes = await readFile(rootFile);
  engine.runs.set(child.id, child);
  let unrelatedPayloadReads = 0;
  for (let i = 0; i < 20000; i++) {
    const unrelated = { id: 'unrelated-' + i, taskId: 'unrelated-' + i, parentRunId: null, createdAt: root.createdAt };
    // An unrelated transcript is an opaque, potentially huge payload. Neither
    // snapshotting nor a shallow spread of that payload belongs in this read.
    Object.defineProperty(unrelated, 'events', { enumerable: true, get() { unrelatedPayloadReads++; throw Error('Unrelated transcript materialized'); } });
    engine.runs.set(unrelated.id, unrelated);
  }
  const early = { at: root.createdAt, nodeId: 'agent', data: { type: 'message', itemId: 'early', text: 'Durable early message' } };
  archive.messages.set(child.id, [early]);
  engine.listCalls = 0; engine.snapshots = [];
  const started = performance.now(), family = await archive.family(child.id), elapsedMs = performance.now() - started;
  assert.deepEqual(family.runs.map(run => run.id), [root.id, child.id]);
  assert.equal(family.rootId, root.id); assert.equal(family.truncated, false);
  assert.equal(family.runs[1].events[0].data.text, 'Durable early message');
  assert.equal(engine.listCalls, 0); assert.equal(unrelatedPayloadReads, 0);
  assert.ok(engine.snapshots.length > 0 && engine.snapshots.every(id => id === child.id));
  assert.deepEqual(await readFile(rootFile), savedBytes, 'family reads preserve archived turn bytes');
  assert.equal(archive.status().turns, 1); assert.equal(archive.status().conversations, 1);
  family.runs[1].nodes.agent.output = 'Changed by reader';
  assert.equal(child.nodes.agent.output, 'Answer live-child', 'returned runs remain independent snapshots');
  t.diagnostic(JSON.stringify({ unrelatedRuns: 20000, liveSnapshots: engine.snapshots.length, unrelatedPayloadReads, elapsedMs }));
});

test('live metadata overrides saved lineage while legacy parents and Trash settlement semantics remain intact', async t => {
  const { archive, engine, dataDir } = await setup(t);
  const root = turn('legacy-root'), obsolete = turn('unrelated-old-root');
  const savedMiddle = turn('legacy-middle', { parentRunId: obsolete.id, at: 1 });
  for (const run of [root, obsolete, savedMiddle]) await archive.capture(run);
  await archive.rename(root.id, 'Retained family title');
  await archive.setState(root.id, 'archived');
  const liveMiddle = { ...savedMiddle, parentRunId: root.id };
  const leaf = turn('uncaptured-leaf', { parentRunId: liveMiddle.id, at: 2, status: 'running', settled: false });
  engine.runs.set(liveMiddle.id, liveMiddle); engine.runs.set(leaf.id, leaf);
  const family = await archive.family(leaf.id);
  assert.deepEqual(family.runs.map(run => run.id), [root.id, liveMiddle.id, leaf.id]);
  assert.equal(family.rootId, root.id); assert.equal(family.state, 'archived'); assert.equal(family.title, 'Retained family title');
  assert.equal(archive.entries.get(liveMiddle.id).parentRunId, obsolete.id, 'metadata lookup must not rewrite archived records');
  assert.equal(Object.hasOwn(liveMiddle, 'taskId'), false, 'normalizing metadata must not mutate the engine run');
  await assert.rejects(archive.setState(root.id, 'deleted'), error => error.status === 409);
  leaf.status = 'cancelled'; leaf.nodes.agent.status = 'cancelled';
  await assert.rejects(archive.setState(root.id, 'deleted'), error => error.status === 409);
  leaf.settled = true;
  await archive.setState(leaf.id, 'deleted');
  assert.equal((await archive.family(root.id)).state, 'deleted');
  assert.equal(archive.list('deleted').length, 1);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'conversations', savedMiddle.id + '.json'), 'utf8')).parentRunId, obsolete.id);
  engine.runs.clear();
  const retained = await archive.family(savedMiddle.id);
  assert.deepEqual(retained.runs.map(run => run.id), [obsolete.id, savedMiddle.id]);
  assert.equal(retained.truncated, false, 'recent-run eviction keeps the saved legacy family readable');
});

test('modern task IDs include disconnected continuations and preserve stable chronological ordering', async t => {
  const { archive, engine } = await setup(t);
  const root = turn('root', { taskId: 'root', at: 0 });
  const saved = turn('saved-tie', { taskId: 'root', parentRunId: 'root', at: 2 });
  await archive.capture(root); await archive.capture(saved);
  const liveFirst = turn('live-first', { taskId: 'root', at: 2 });
  const liveSecond = turn('live-second', { taskId: 'root', at: 2 });
  const oldest = turn('live-oldest', { taskId: 'root', at: 1 });
  for (const run of [liveFirst, liveSecond, oldest]) engine.runs.set(run.id, run);
  assert.deepEqual((await archive.family(liveFirst.id)).runs.map(run => run.id), ['root', 'live-oldest', 'saved-tie', 'live-second', 'live-first']);
  assert.equal((await archive.family(root.id)).rootId, root.id);
  await assert.rejects(archive.family('missing-turn'), error => error.status === 404);
});

test('engines without an exposed run Map retain the listRuns compatibility path', async t => {
  const backing = new Engine(), engine = new EventEmitter();
  engine.listRuns = () => backing.listRuns(); engine.getRun = id => backing.getRun(id);
  const { archive } = await setup(t, engine);
  const root = turn('fallback-root'), child = turn('fallback-child', { parentRunId: root.id, at: 1 });
  await archive.capture(root); backing.runs.set(child.id, child); backing.listCalls = 0;
  assert.deepEqual((await archive.family(child.id)).runs.map(run => run.id), [root.id, child.id]);
  assert.equal(backing.listCalls, 1);
  backing.runs.clear();
});
