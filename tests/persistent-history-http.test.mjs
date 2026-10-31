import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const nextIO = () => new Promise(resolve => setImmediate(resolve));
const context = {
  preset: 'model', autoCompact: false, effectiveWindowTokens: 258400,
  nativeConfiguredWindowTokens: 272000, nativeDefaultContextWindowTokens: 272000,
  nativeMaxContextWindowTokens: 872000, nativeEffectiveContextWindowPercent: 95,
  nativeWindowBasis: 'runtime-usage', nativeObservedWindowTokens: 258400,
  compactionCount: 1,
};

class MigrationFixture extends EventEmitter {
  constructor() {
    super();
    this.supportsContinuityCompaction = true;
    this.entered = deferred();
    this.release = deferred();
    this.calls = [];
    this.generationCalls = 0;
    this.receipt = {
      compacted: true, migrated: true, method: 'codex-native', codexHistory: 'codex',
      threadId: 'persistent-http-replacement', model: 'fixture-native', context,
      usage: { total: { inputTokens: 120, outputTokens: 24, totalTokens: 144 } },
    };
  }
  status() {
    return {
      connected: true, authenticated: true, defaultModel: 'fixture-native', activeTurns: 0,
      models: [{ id: 'fixture-native', model: 'fixture-native', supportedReasoningEfforts: [],
        contextWindowTokens: 272000, runtimeDefaultContextWindowTokens: 272000,
        maxContextWindowTokens: 872000, effectiveContextWindowPercent: 95,
        contextWindowSource: 'runtime-reported' }],
    };
  }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.generationCalls++; throw Error('This HTTP fixture must not generate a model response.'); }
  async compactThread() { throw Error('Missing native history must use the saved-history migration path.'); }
  async compactHistory(options) {
    this.calls.push(options);
    this.entered.resolve();
    await this.release.promise;
    return structuredClone(this.receipt);
  }
}
class NoDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

function legacyRun(id, cwd, { parentRunId, createdAt = '2026-10-01T00:00:00.000Z' } = {}) {
  const input = `USER_${id}`, output = `ASSISTANT_${id}`;
  const workflow = {
    id: 'persistent-http-fixture', name: 'Saved HTTP conversation',
    nodes: [{ id: 'input', type: 'input' },
      { id: 'agent', type: 'agent', name: 'Agent', model: 'fixture-native',
        prompt: 'Continue the saved conversation.', context: { preset: 'model', autoCompact: false } },
      { id: 'output', type: 'output' }],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
    settings: { maxParallel: 1, planningMode: 'off' },
  };
  return {
    id, taskId: parentRunId || id, parentRunId, cwd, workflow,
    workflowId: workflow.id, workflowName: workflow.name,
    input, output, status: 'completed', settled: true, createdAt, finishedAt: createdAt,
    runtimeSettings: { codexHistory: 'relay', runTimeoutMs: null, executionGuardrails: false },
    planningMode: 'off', planningContractVersion: 1,
    events: [
      { type: 'agent.event', runId: id, nodeId: 'agent', at: createdAt,
        data: { type: 'message', text: output, phase: 'final_answer' } },
      { type: 'agent.event', runId: id, nodeId: 'agent', at: createdAt,
        data: { type: 'steer', text: `ACCEPTED_${id}`, accepted: true } },
      { type: 'agent.event', runId: id, nodeId: 'agent', at: createdAt,
        data: { type: 'steer', text: `REJECTED_${id}`, accepted: false } },
    ],
    nodes: {
      input: { status: 'completed', output: input },
      // A lost ephemeral ID is deliberately absent. Saved messages are the migration source.
      agent: { status: 'completed', output, codexHistory: 'relay', resolvedModel: 'fixture-native',
        toolNames: ['relay_control'], controlSchemaVersion: 8,
        contextStatus: { preset: 'model', autoCompact: false, effectiveWindowTokens: 258400 } },
      output: { status: 'completed', output },
    },
  };
}
const visibleHistory = run => ({
  input: run.input, output: run.output, agentOutput: run.nodes.agent.output,
  events: run.events.map(({ timelineOrder, ...event }) => event),
});

test('HTTP compact forwards archived lineage and waits for native completion and archive persistence', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-persistent-http-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await mkdir(cwd);
  const runtime = new MigrationFixture(), archiveEntered = deferred(), archiveRelease = deferred();
  let app, operation;
  t.after(async () => {
    runtime.release.resolve();
    archiveRelease.resolve();
    await operation?.catch(() => {});
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  app = await createHarnessServer({ runtime, desktop: new NoDesktop(), port: 0, dataDir,
    defaultCwd: cwd, autoAttachDesktop: false, remoteAccess: false });
  const url = await app.listen(), home = await fetch(url);
  const cookie = home.headers.get('set-cookie').split(';', 1)[0];
  await home.arrayBuffer();
  const api = async (route, body) => {
    const response = await fetch(new URL(route, url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), text };
  };

  const first = legacyRun('http-ancestor', cwd);
  const latest = legacyRun('http-latest', cwd, { parentRunId: first.id, createdAt: '2026-10-01T01:00:00.000Z' });
  const unrelated = legacyRun('http-unrelated', cwd);
  for (const run of [first, latest, unrelated]) {
    app.engine.runs.set(run.id, run);
    await app.conversations.capture(run);
  }
  app.engine.runs.delete(first.id);
  await app.engine.persist();
  assert.equal(app.engine.runs.has(first.id), false, 'The ancestor must only be reachable through the archive.');
  assert.deepEqual((await app.conversations.family(latest.id)).runs.map(run => run.id), [first.id, latest.id]);
  const originalHistory = visibleHistory(await app.conversations.readFile(latest.id));
  const ancestorFile = path.join(app.conversations.directory, first.id + '.json');
  const ancestorBytes = await readFile(ancestorFile);
  const capture = app.conversations.capture.bind(app.conversations);
  app.conversations.capture = async value => {
    if (value.id === latest.id && value.nodes.agent.threadId === runtime.receipt.threadId) {
      archiveEntered.resolve();
      await archiveRelease.promise;
    }
    return capture(value);
  };
  // Leave the server's persistConversation closure intact: a missing hook must fail this test.
  let settled = false;
  operation = api(`/api/runs/${latest.id}/compact`, { nodeId: 'agent' }).finally(() => { settled = true; });
  const premature = operation.then(response => assert.fail(`HTTP compact returned before its durable checkpoint: ${response.status} ${response.text}`));
  await Promise.race([runtime.entered.promise, premature]);
  await nextIO();
  assert.equal(settled, false, 'Starting native compression is not its completed result.');
  assert.equal(runtime.calls.length, 1);
  const imported = runtime.calls[0].continuity.text;
  for (const marker of ['USER_http-ancestor', 'ASSISTANT_http-ancestor', 'ACCEPTED_http-ancestor', 'USER_http-latest', 'ASSISTANT_http-latest']) {
    assert.ok(imported.includes(marker), `Full archived lineage must include ${marker}.`);
  }
  assert.doesNotMatch(imported, /http-unrelated|REJECTED_/);
  assert.equal(runtime.calls[0].context.autoCompact, false, 'An explicit manual request remains independent of the automatic setting.');

  runtime.release.resolve();
  await Promise.race([archiveEntered.promise, premature]);
  await nextIO();
  assert.equal(settled, false, 'A completed native checkpoint must wait for the archive save.');
  const pendingArchive = await app.conversations.readFile(latest.id);
  assert.equal(pendingArchive.nodes.agent.codexHistory, 'relay');
  assert.equal(pendingArchive.nodes.agent.threadId, undefined);
  assert.deepEqual(visibleHistory(pendingArchive), originalHistory);

  archiveRelease.resolve();
  const response = await operation;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.data.compacted, true);
  assert.equal(response.data.migrated, true);
  assert.equal(response.data.method, 'codex-native');
  assert.equal(response.data.threadId, runtime.receipt.threadId);
  assert.deepEqual(response.data.context, context);
  const archived = await app.conversations.readFile(latest.id);
  assert.equal(archived.nodes.agent.threadId, response.data.threadId);
  assert.equal(archived.nodes.agent.codexHistory, 'codex');
  assert.equal(archived.nodes.agent.lastCompaction.compacted, true);
  assert.equal(archived.nodes.agent.lastCompaction.migrated, true);
  assert.deepEqual(archived.nodes.agent.contextStatus, response.data.context);
  assert.deepEqual(visibleHistory(archived), originalHistory);
  assert.deepEqual(await readFile(ancestorFile), ancestorBytes, 'Migrating the latest turn must preserve the archived ancestor exactly.');
  assert.equal(runtime.generationCalls, 0);
});
