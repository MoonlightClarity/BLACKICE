import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ model: 'metadata-fixture' }], defaultModel: 'metadata-fixture' }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { assert.fail('Reading Planning metadata must not start model work.'); }
}

test('real Planning HTTP catalogs empty active and paged archived plans without cloning large retained runs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-metadata-'));
  let app, originalListRuns, snapshotCalls = 0;
  t.after(async () => {
    try {
      if (app) {
        app.engine.listRuns = originalListRuns;
        // The large synthetic payloads are in-memory fixture data, not archives.
        app.engine.runs.clear();
        await app.close();
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  app = await createHarnessServer({ port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), runtime: new Runtime(), remoteAccess: false, autoAttachDesktop: false });
  originalListRuns = app.engine.listRuns;
  await app.learning.updateSettings({ mode: 'off' });
  await app.operations.pause('Disposable metadata verification.');
  const ids = [], revisions = new Map();
  for (let index = 0; index < 43; index++) {
    const id = 'retained-' + String(index).padStart(3, '0'), stamp = '2026-10-25T09:00:' + String(index).padStart(2, '0') + '.000Z';
    ids.push(id);
    const state = await app.tasks.ensure({ taskId: id, runId: id, cwd: directory, goal: 'Saved plan ' + index, defaultPlan: true });
    revisions.set(id, state.revision);
    const run = { id, taskId: id, input: 'Saved title ' + index, status: index % 2 ? 'failed' : 'completed', settled: true, createdAt: stamp, updatedAt: stamp, workflow: { name: 'Metadata fixture', nodes: [{ id: 'agent', type: 'agent' }], edges: [] }, nodes: { agent: { status: 'completed' } }, events: [] };
    await app.conversations.capture(run);
    await app.conversations.setState(id, 'archived');
    const payload = String(index) + 'x'.repeat(900 * 1024);
    run.nodes.agent.output = payload;
    run.events = [{ type: 'agent.event', data: { type: 'message', text: payload } }];
    app.engine.runs.set(id, run);
  }
  const before = await readFile(app.tasks.file(ids[0]));
  const origin = await app.listen(), page = await fetch(origin), cookie = page.headers.get('set-cookie').split(';', 1)[0];
  await page.arrayBuffer();
  app.engine.listRuns = () => { snapshotCalls++; assert.fail('HTTP metadata reads must not request full run snapshots.'); };
  const read = async route => {
    const response = await fetch(origin + route, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const active = await read('/api/planning');
  assert.equal(active.total, 0); assert.deepEqual(active.plans, []); assert.equal(active.healthy, true);
  const first = await read('/api/planning?state=archived&limit=40&offset=0');
  const second = await read('/api/planning?state=archived&limit=40&offset=40');
  assert.equal(first.total, 43); assert.equal(first.plans.length, 40); assert.equal(first.nextOffset, 40); assert.equal(first.hasMore, true);
  assert.equal(second.total, 43); assert.equal(second.plans.length, 3); assert.equal(second.nextOffset, null); assert.equal(second.hasMore, false);
  const plans = [...first.plans, ...second.plans];
  assert.deepEqual(new Set(plans.map(plan => plan.taskId)), new Set(ids));
  for (const plan of plans) {
    assert.equal(plan.bucket, 'archived'); assert.equal(plan.editable, true); assert.equal(plan.running, false);
    assert.equal(plan.revision, revisions.get(plan.taskId)); assert.equal(plan.runId, plan.taskId);
    assert.equal(plan.runStatus, app.engine.runs.get(plan.taskId).status);
    assert.equal(plan.title, 'Saved title ' + Number(plan.taskId.slice(-3)));
    for (const field of ['events', 'nodes', 'workflow', 'taskState']) assert.equal(Object.hasOwn(plan, field), false);
  }
  const exact = await read('/api/planning?state=archived&query=title%2042&limit=1');
  assert.equal(exact.total, 1); assert.equal(exact.plans[0].taskId, ids[42]);
  const projects = await read('/api/projects'); assert.deepEqual(projects.projects, []);
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(await readFile(app.tasks.file(ids[0])), before);
  assert.ok([...app.engine.runs.values()].reduce((size, run) => size + run.nodes.agent.output.length + run.events[0].data.text.length, 0) > 70 * 1024 * 1024);
});
