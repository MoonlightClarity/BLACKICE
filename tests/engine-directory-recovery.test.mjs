import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { directoryToolFailure } from '../lib/directory-tool-recovery.mjs';

const MARKER = '[BLACKICE DIRECTORY RECOVERY]\n';
const graph = model => ({ name: 'Recovery fixture', nodes: [{ id: 'i', type: 'input' },
  { id: 'a', type: 'agent', name: 'Agent', model, prompt: 'Do the current task' }, { id: 'o', type: 'output' }],
  edges: [{ source: 'i', target: 'a' }, { source: 'a', target: 'o' }],
  settings: { maxParallel: 1, planningMode: 'off', context: { autoCompact: false, enforceKnownCapacityOnly: true } } });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const toolReply = (id, name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const final = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Saved the verified output.' } }] };

class Native extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async runAgent() { throw Error('No native or real model may run in this fixture.'); }
  async close() {}
}

test('the actual provider/engine path preserves rejected effects and only the model plans, focuses, saves and observes afterward', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engine-directory-recovery-'));
  const outputPath = path.join(root, 'result.txt'), expected = 'Verified résumé — 東京\n';
  const requests = []; let engine, runId, snapshotAtRecovery;
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: path.join(root, 'provider'),
    modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: async (url, options = {}) => {
      assert.ok(String(url).startsWith('http://127.0.0.1:45680/'), 'The fixture cannot use a real provider.');
      if ((options.method || 'GET') === 'GET') return json({ data: [{ id: 'fixture', context_length: 1000000, max_output_tokens: 128000 }] });
      const body = JSON.parse(options.body); requests.push(body); const index = requests.length;
      if (index <= 8) return json(toolReply('rejected-' + index, 'relay_workspace', { action: 'write', path: outputPath, text: expected }));
      if (index === 9) {
        const messages = body.messages;
        assert.ok(messages.at(-1).content.startsWith(MARKER));
        assert.equal(messages.at(-2).tool_call_id, 'rejected-8');
        assert.match(messages.at(-2).content, /This tool call did not run/);
        await assert.rejects(access(outputPath), { code: 'ENOENT' });
        const directory = await engine.actionDirectories.get(runId, 'ignored');
        snapshotAtRecovery = directory.read();
        assert.equal(snapshotAtRecovery.revision, 0); assert.equal(snapshotAtRecovery.actionRevision, 0);
        assert.deepEqual(snapshotAtRecovery.actions, []); assert.deepEqual(snapshotAtRecovery.receipts, []);
        const data = JSON.parse(messages.at(-1).content.split('\n').at(-1));
        assert.equal(data.task.taskId, runId); assert.equal(data.task.runId, runId); assert.equal(data.task.nodeId, 'a');
        assert.equal(data.directory.focus, null); assert.deepEqual(data.directory.readyActions, []);
        assert.equal(data.directory.finalStatus.reason, 'no-actions');
        assert.equal(data.rejection.lastCallId, 'rejected-8'); assert.equal(data.rejection.actionDispatched, false);
        return json(toolReply('model-plan', 'relay_directory_action', { action: 'plan',
          actions: [{ id: 'save', objective: 'Save the verified output file', dependsOn: [] }] }));
      }
      if (index === 10) return json(toolReply('model-focus', 'relay_directory_action', { action: 'focus', id: 'save' }));
      if (index === 11) return json(toolReply('model-write', 'relay_workspace', { action: 'write', path: outputPath, text: expected }));
      if (index === 12) {
        const saved = body.messages.filter(m => m.role === 'tool').at(-1);
        assert.equal(saved.tool_call_id, 'model-write');
        const receipt = saved.content.match(/receipt-[0-9]+/);
        assert.ok(receipt, 'Only the actual successful write supplies the observation receipt.');
        return json(toolReply('model-observe', 'relay_directory_action', { action: 'observe', id: 'save',
          outcome: 'objective-met', claim: 'The verified output file was saved.', receipts: [receipt[0]] }));
      }
      assert.equal(index, 13, 'Recovery does not start a separate provider run or extra final pass.');
      return json(final);
    } }).init();
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: 'http://127.0.0.1:45680/v1',
    models: ['fixture'], maxTokens: 90000 });
  engine = await new HarnessEngine({ runtime, dataDir: path.join(root, 'engine'), defaultCwd: root }).init();
  t.after(async () => { await engine.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const started = engine.startRun({ workflow: graph('fixture::fixture'),
    input: { task: 'Save a verified local result file', directoryActions: 'on' } });
  runId = started.id;
  await engine.executions.get(runId);
  const run = engine.getRun(runId);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(await readFile(outputPath, 'utf8'), expected);
  assert.ok(snapshotAtRecovery);
  const directory = (await engine.actionDirectories.get(runId, 'ignored')).read();
  assert.equal(directory.actions.length, 1); assert.equal(directory.actions[0].state, 'observed');
  assert.equal(directory.receipts.length, 1); assert.equal(directory.receipts[0].success, true);
  assert.equal(directory.receipts[0].tool, 'relay_workspace');
  assert.equal(requests.length, 13);
  const history = requests.at(-1).messages;
  assert.equal(history.filter(m => String(m.content).startsWith(MARKER)).length, 1);
  for (let index = 1; index <= 8; index++) {
    const failed = history.find(m => m.role === 'tool' && m.tool_call_id === 'rejected-' + index);
    assert.ok(failed); assert.match(failed.content, /This tool call did not run/);
  }
  for (const request of requests) {
    assert.equal(request.max_tokens, 90000); assert.deepEqual(request.tools, requests[0].tools);
  }
});

class InspectRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ id: 'fixture-model', supportsTools: true }] }; }
  async runAgent(options) { return this.execute(options); }
}
async function inspectFixture(t, execute) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engine-recovery-hook-'));
  const runtime = new InspectRuntime(); runtime.execute = execute;
  const engine = await new HarnessEngine({ runtime, dataDir: root, defaultCwd: root }).init();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, engine };
}

test('the engine recovery hook is read-only, current-state scoped and latched across ordinary receipt changes', async t => {
  let f, captured, candidate, directory, secondSnapshot;
  f = await inspectFixture(t, async o => {
    captured = o;
    const dir = async args => {
      const result = await o.onToolCall({ name: 'relay_directory_action', arguments: args, callId: 'model-' + args.action });
      assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text);
    };
    await dir({ action: 'plan', actions: [{ id: 'save', objective: 'Save the output', dependsOn: [] }] });
    directory = await f.engine.actionDirectories.get([...f.engine.runs.values()].find(r => r.status === 'running').id, 'ignored');
    let failure = null;
    for (let index = 0; index < 8; index++) {
      const call = { name: 'relay_workspace', callId: 'rejected-' + index,
        arguments: { action: 'write', path: path.join(f.root, 'never-written.txt'), text: 'must not be written' } };
      const result = await o.onToolCall(call);
      assert.equal(result.success, false); assert.equal(result.code, 'DIRECTORY_FOCUS'); assert.equal(result.actionDispatched, false);
      failure = directoryToolFailure(failure, call, result);
    }
    candidate = { failure, signal: o.signal };
    const before = directory.read(), recovered = o.onDirectoryToolRecovery(candidate);
    assert.ok(recovered.prompt); assert.deepEqual(directory.read(), before);
    const current = JSON.parse(recovered.prompt.split('\n').at(-1));
    assert.deepEqual(current.directory.readyActions, ['save']); assert.equal(current.directory.focus, null);
    assert.equal(current.directory.actions[0].state, 'pending');
    assert.equal(o.onDirectoryToolRecovery(candidate), null);
    const read = await o.onToolCall({ name: 'relay_workspace', arguments: { action: 'list', path: f.root }, callId: 'model-list' });
    assert.equal(read.success, true);
    const receiptChanged = directory.read();
    assert.ok(receiptChanged.revision > before.revision); assert.equal(receiptChanged.actionRevision, before.actionRevision);
    assert.equal(o.onDirectoryToolRecovery(candidate), null);
    await dir({ action: 'plan', actions: [{ id: 'save', objective: 'Save the now-inspected output', dependsOn: [] }] });
    secondSnapshot = directory.read();
    assert.ok(o.onDirectoryToolRecovery(candidate).prompt);
    assert.deepEqual(directory.read(), secondSnapshot);
    assert.equal(o.onDirectoryToolRecovery(candidate), null);
    await assert.rejects(access(path.join(f.root, 'never-written.txt')), { code: 'ENOENT' });
    return { output: 'The output remains unsaved.' };
  });
  const started = f.engine.startRun({ workflow: graph('fixture-model'),
    input: { task: 'Save an output', directoryActions: 'on' } });
  await f.engine.executions.get(started.id);
  assert.equal(f.engine.getRun(started.id).status, 'failed', 'Informational feedback alone never completes the task.');
  assert.equal(captured.onDirectoryToolRecovery(candidate), null, 'Settled attempts do not get late recovery.');
  assert.deepEqual(directory.read(), secondSnapshot);
});

test('Directory-off engine runs do not install the recovery hook', async t => {
  const f = await inspectFixture(t, async o => {
    assert.equal(o.onDirectoryToolRecovery, undefined); return { output: 'Ordinary answer.' };
  });
  const started = f.engine.startRun({ workflow: graph('fixture-model'),
    input: { task: 'Answer a simple question', directoryActions: 'off' } });
  await f.engine.executions.get(started.id);
  assert.equal(f.engine.getRun(started.id).status, 'completed');
});
