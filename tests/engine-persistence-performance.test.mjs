import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const setup = async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-engine-persistence-'));
  const engine = new HarnessEngine({ runtime: {}, dataDir, defaultCwd: dataDir });
  t.after(async () => { clearTimeout(engine.dirtyTimer); await engine.writeChain.catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { engine, dataDir };
};

test('engine persistence batches a burst while retaining the newest state and bounded history', async t => {
  const { engine, dataDir } = await setup(t);
  let snapshots = 0;
  const write = engine.writeSnapshot.bind(engine);
  engine.writeSnapshot = () => { snapshots++; return write(); };
  for (let i = 0; i < 140; i++) engine.runs.set(`run-${i}`, { id: `run-${i}`, nodes: {}, events: [], status: i === 0 ? 'running' : 'completed' });
  const requests = [];
  for (let i = 0; i < 50; i++) {
    engine.workflows.set('draft', { id: 'draft', nodes: [], edges: [], version: i });
    requests.push(engine.persist());
  }
  await Promise.all(requests);
  assert.equal(snapshots, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'workflows.json')))[0].version, 49);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'runs.json')));
  assert.equal(saved.length, 100);
  assert.equal(saved[0].id, 'run-0');
  assert.equal(saved.at(-1).id, 'run-139');
});

test('explicit persistence cancels redundant debounce and storage failures remain observable', async t => {
  const { engine } = await setup(t), failures = [];
  engine.on('storage.error', failure => failures.push(failure));
  engine.schedulePersist();
  assert.ok(engine.dirtyTimer);
  const circular = { id: 'circular', nodes: [], edges: [] };
  circular.circular = circular;
  engine.workflows.set(circular.id, circular);
  const pending = engine.persist();
  assert.equal(engine.dirtyTimer, null);
  await assert.rejects(pending, /circular/i);
  assert.equal(failures.length, 1);
  assert.equal(engine.storageStatus().healthy, false);
  engine.workflows.delete(circular.id);
  await engine.persist();
  assert.equal(engine.storageStatus().healthy, true);
});

test('engine close drains a pending latest snapshot after an already-running write', async t => {
  const { engine, dataDir } = await setup(t), gate = deferred();
  const original = engine.snapshots.write.bind(engine.snapshots);
  let blocked = true;
  engine.snapshots.write = async (...args) => { if (blocked) { blocked = false; await gate.promise; } return original(...args); };
  engine.workflows.set('draft', { id: 'draft', nodes: [], edges: [], name: 'first' });
  const first = engine.persist();
  await turn();
  engine.workflows.get('draft').name = 'saved at shutdown';
  engine.schedulePersist();
  let closed = false;
  const closing = engine.close().then(() => { closed = true; });
  await turn();
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([first, closing]);
  assert.equal(closed, true);
  assert.equal(engine.dirtyTimer, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'workflows.json')))[0].name, 'saved at shutdown');
});
