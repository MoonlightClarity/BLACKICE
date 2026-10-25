import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRunCollection, projectRunIndex, reconcileRunIndex } from '../public/run-index-model.mjs';
import { createRunIndexClient } from '../public/run-index-client.mjs';

test('indexing full traces leaves the backend run untouched and preserves chat navigation metadata', () => {
  const original = {
    id: 'run-1', status: 'running', taskId: 'task-one', parentRunId: 'run-0',
    updatedAt: '2026-10-24T10:00:00.000Z', input: 'A real conversation',
    workflow: { nodes: [{ id: 'agent', name: 'Assistant' }], edges: [] },
    nodes: { agent: { output: 'Finished output', threadId: 'resume-01', status: 'running' } },
    taskState: { revision: 7, taskId: 'task-one', steps: [] },
    events: Array.from({ length: 2500 }, (_, n) => ({
      at: '2026-10-24T10:00:00.000Z', nodeId: 'agent',
      data: { type: 'tool.result', text: 'large external response'.repeat(100), n },
    })),
  };
  const [slim] = projectRunCollection([original]);
  assert.equal(slim.id, original.id);
  assert.equal(slim.taskId, original.taskId);
  assert.equal(slim.parentRunId, original.parentRunId);
  assert.equal(slim.workflow.nodes[0].name, 'Assistant');
  assert.equal(slim.nodes.agent.output, 'Finished output');
  assert.equal(slim.taskState.revision, 7);
  assert.equal(slim.events.length, 0);
  assert.equal(original.events.length, 2500, 'The source and saved history must never be changed.');
  const oldBytes = JSON.stringify(original).length, slimBytes = JSON.stringify(slim).length;
  assert.ok(slimBytes < oldBytes / 100, 'The UI index must exclude almost all trace payloads.');
  assert.equal(projectRunIndex(null), null);
  assert.throws(() => projectRunCollection({ runs: {} }), /invalid run catalog/);
});

test('index refresh must not erase messages or task details already loaded in the selected conversation', () => {
  const full = { id: 'r1', updatedAt: '2026-10-24T10:00:00Z',
    nodes: { agent: { output: 'A' } }, workflow: { nodes: [{ id: 'agent' }] },
    taskState: { taskId: 't1', revision: 4 },
    events: [{ data: { type: 'message', text: 'Hello' } }], output: 'Hello' };
  const next = projectRunIndex({ id: 'r1', updatedAt: '2026-10-24T10:00:05Z',
    events: [{ data: { type: 'trace' } }], nodes: { agent: { output: 'Updated' } },
    taskState: { taskId: 't1', revision: 5 }, output: 'Updated' });
  const reconciled = reconcileRunIndex(full, next);
  assert.deepEqual(reconciled.events, full.events);
  assert.equal(reconciled.nodes.agent.output, 'Updated');
  assert.equal(reconciled.taskState.revision, 5);
  assert.equal(reconciled.output, 'Updated');
  assert.equal(reconciled.updatedAt, next.updatedAt);
  assert.equal(reconcileRunIndex(undefined, next), next);
});

test('the renderer requests its run index through one dedicated worker without a UI-thread API call', async () => {
  class FakeWorker {
    constructor() { this.listeners = {}; this.calls = 0; this.terminated = false; FakeWorker.instance = this; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    postMessage(packet) {
      assert.equal(packet.type, 'fetch');
      this.calls++;
      queueMicrotask(() => this.listeners.message({ data: {
        id: packet.id, ok: true, runs: [{ id: 'r1', events: [], indexed: true }],
      } }));
    }
    terminate() { this.terminated = true; }
  }
  let fallback = 0;
  const client = createRunIndexClient({ api: async () => { fallback++; return []; }, WorkerClass: FakeWorker });
  assert.equal(client.usingWorker, true);
  const a = client.read(), b = client.read();
  assert.equal(a, b, 'Concurrent startup and reconnect reads are single-flight.');
  assert.equal((await a)[0].id, 'r1');
  assert.equal(FakeWorker.instance.calls, 1);
  assert.equal(fallback, 0);
  client.close();
  assert.equal(FakeWorker.instance.terminated, true);
});

test('existing API remains the compatibility fallback when workers cannot start', async () => {
  class BrokenWorker { constructor() { throw Error('Worker unavailable'); } }
  let requests = 0;
  const client = createRunIndexClient({
    api: async path => { assert.equal(path, '/api/runs'); requests++; return [{
      id: 'existing', events: [{ data: { type: 'tool.result', large: 'x'.repeat(1000) } }],
    }]; }, WorkerClass: BrokenWorker,
  });
  const list = await client.read();
  assert.equal(client.usingWorker, false);
  assert.equal(list[0].events.length, 0);
  assert.equal(requests, 1);
  client.close();
});
