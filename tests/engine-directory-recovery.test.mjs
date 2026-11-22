import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { Writable } from 'node:stream';
import { CodexRuntime } from '../lib/codex.mjs';
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

const DIRECTORY_CHOICES = 'Current Directory choices (same task): ';
const resultText = result => result.contentItems.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
function returnedChoices(text) {
  const rows = text.split('\n').filter(line => line.startsWith(DIRECTORY_CHOICES));
  assert.equal(rows.length, 1);
  return JSON.parse(rows[0].slice(DIRECTORY_CHOICES.length));
}

test('current Directory choices survive actual engine and compatible tool-result serialization', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'directory-choice-compatible-'));
  const outputPath = path.join(root, 'result.txt'), expected = 'Saved résumé — 東京\n';
  const objective = 'Save the "reviewed" résumé — 東京\nKeep the source.';
  const requests = [], results = new Map(); let engine, runId, beforeRejections;
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: path.join(root, 'provider'),
    modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: async (url, options = {}) => {
      assert.ok(String(url).startsWith('http://127.0.0.1:45681/'));
      if ((options.method || 'GET') === 'GET') return json({ data: [{ id: 'fixture', context_length: 1000000, max_output_tokens: 128000 }] });
      const body = JSON.parse(options.body); requests.push(body); const index = requests.length;
      if (index === 1) return json(toolReply('plan-choices', 'relay_directory_action', { action: 'plan',
        actions: [{ id: 'save_result', objective, dependsOn: [] }] }));
      if (index === 2) {
        beforeRejections = (await engine.actionDirectories.get(runId, 'ignored')).read();
        return json(toolReply('unknown-id', 'relay_directory_action', { action: 'focus', id: 'host-turn-authORITY' }));
      }
      if (index === 3 || index === 4) {
        const callId = index === 3 ? 'unknown-id' : 'unfocused-write', result = results.get(callId);
        assert.ok(result); assert.equal(result.success, false);
        assert.equal(result.code, index === 3 ? 'DIRECTORY_ACTION' : 'DIRECTORY_FOCUS');
        if (index === 4) assert.equal(result.actionDispatched, false);
        const message = body.messages.at(-1);
        assert.equal(message.role, 'tool'); assert.equal(message.tool_call_id, callId);
        assert.equal(message.content, resultText(result), 'The complete actual engine error reaches the next request unchanged.');
        assert.deepEqual(returnedChoices(message.content), { taskId: runId,
          actionRevision: beforeRejections.actionRevision, focus: null, ready: ['save_result'],
          actions: [{ id: 'save_result', objective, state: 'pending' }] });
        assert.deepEqual((await engine.actionDirectories.get(runId, 'ignored')).read(), beforeRejections);
        await assert.rejects(access(outputPath), { code: 'ENOENT' });
        return json(index === 3
          ? toolReply('unfocused-write', 'relay_workspace', { action: 'write', path: outputPath, text: expected })
          : toolReply('focus-choices', 'relay_directory_action', { action: 'focus', id: 'save_result' }));
      }
      if (index === 5) return json(toolReply('focused-write', 'relay_workspace', { action: 'write', path: outputPath, text: expected }));
      if (index === 6) {
        const message = body.messages.at(-1);
        assert.equal(message.tool_call_id, 'focused-write');
        const receipt = message.content.match(/receipt-[0-9]+/); assert.ok(receipt);
        return json(toolReply('observe-choices', 'relay_directory_action', { action: 'observe', id: 'save_result',
          outcome: 'objective-met', claim: 'Saved the reviewed output.', receipts: [receipt[0]] }));
      }
      assert.equal(index, 7); return json(final);
    } }).init();
  const execute = runtime.executeTool.bind(runtime);
  runtime.executeTool = async (state, call) => {
    const result = await execute(state, call); results.set(call.id || call.callId, structuredClone(result)); return result;
  };
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: 'http://127.0.0.1:45681/v1',
    models: ['fixture'], maxTokens: 90000 });
  engine = await new HarnessEngine({ runtime, dataDir: path.join(root, 'engine'), defaultCwd: root }).init();
  t.after(async () => { await engine.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const started = engine.startRun({ workflow: graph('fixture::fixture'),
    input: { task: 'Save the reviewed local output', directoryActions: 'on' } });
  runId = started.id; await engine.executions.get(runId);
  assert.equal(engine.getRun(runId).status, 'completed', engine.getRun(runId).error);
  assert.equal(await readFile(outputPath, 'utf8'), expected); assert.equal(requests.length, 7);
  const state = (await engine.actionDirectories.get(runId, 'ignored')).read();
  assert.equal(state.receipts.length, 1); assert.equal(state.receipts[0].success, true);
  assert.equal(state.actions[0].state, 'observed');
  for (let index = 0; index < requests.length; index++) {
    assert.equal(requests[index].max_tokens, 90000); assert.deepEqual(requests[index].tools, requests[0].tools);
    if (index) assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length),
      requests[index - 1].messages, 'Earlier messages are retained exactly.');
  }
});

test('actual native Codex pipe delivers the engine Directory hint without granting dispatch', async t => {
  let fixture, outputPath; const expected = 'Native fixture résumé — 東京\n', objective = 'Save the "native" fixture — 東京';
  const delivered = [], hostResults = []; let serialized, finishWrite, rpcId = 0;
  const stream = new Writable({ write(chunk, _encoding, callback) { serialized = JSON.parse(String(chunk)); finishWrite = callback; } });
  stream.on('error', () => {}); t.after(() => stream.destroy());
  fixture = await inspectFixture(t, async options => {
    const child = { stdin: stream, killed: false }, runtime = Object.create(CodexRuntime.prototype);
    const state = { threadId: 'choice-thread', turnId: 'choice-turn', done: false, messages: new Map(),
      dynamicTools: options.dynamicTools, toolController: new AbortController(),
      onToolCall: async (call, meta) => { const result = await options.onToolCall(call, meta); hostResults.push(structuredClone(result)); return result; },
      onToolResultDelivered: value => { delivered.push(structuredClone(value)); options.onToolResultDelivered?.(value); } };
    Object.assign(runtime, { child, threads: new Map([['choice-thread', state]]), pendingNativeWrites: new Set(), _emitRun() {} });
    async function send(callId, tool, args) {
      const before = delivered.length; finishWrite = null;
      await runtime._dynamicToolCall({ id: ++rpcId, params: { threadId: 'choice-thread', turnId: 'choice-turn', callId, tool, arguments: args } });
      assert.equal(typeof finishWrite, 'function'); assert.equal(delivered.length, before);
      const response = serialized.result;
      assert.deepEqual(response, JSON.parse(JSON.stringify(hostResults.at(-1))));
      finishWrite(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(delivered.length, before + 1); assert.equal(delivered.at(-1).call.callId, callId);
      assert.deepEqual(delivered.at(-1).result, hostResults.at(-1));
      return response;
    }
    assert.equal((await send('plan', 'relay_directory_action', { action: 'plan',
      actions: [{ id: 'save_result', objective, dependsOn: [] }] })).success, true);
    const directory = await fixture.engine.actionDirectories.get(fixture.engine.listRuns()[0].id, 'ignored');
    const before = directory.read();
    const unknown = await send('unknown-id', 'relay_directory_action', { action: 'focus', id: 'host-turn-authORITY' });
    assert.equal(unknown.success, false); assert.equal(unknown.code, 'DIRECTORY_ACTION');
    const unfocused = await send('unfocused-write', 'relay_workspace', { action: 'write', path: outputPath, text: expected });
    assert.equal(unfocused.success, false); assert.equal(unfocused.code, 'DIRECTORY_FOCUS'); assert.equal(unfocused.actionDispatched, false);
    for (const response of [unknown, unfocused]) {
      assert.deepEqual(returnedChoices(resultText(response)), { taskId: before.taskId, actionRevision: before.actionRevision,
        focus: null, ready: ['save_result'], actions: [{ id: 'save_result', objective, state: 'pending' }] });
    }
    assert.deepEqual(directory.read(), before); await assert.rejects(access(outputPath), { code: 'ENOENT' });
    assert.equal((await send('focus', 'relay_directory_action', { action: 'focus', id: 'save_result' })).success, true);
    const written = await send('focused-write', 'relay_workspace', { action: 'write', path: outputPath, text: expected });
    assert.equal(written.success, true); const receipt = resultText(written).match(/receipt-[0-9]+/); assert.ok(receipt);
    assert.equal((await send('observe', 'relay_directory_action', { action: 'observe', id: 'save_result',
      outcome: 'objective-met', claim: 'The fixture output was saved.', receipts: [receipt[0]] })).success, true);
    assert.equal(directory.read().receipts.length, 1); assert.equal(runtime.pendingNativeWrites.size, 0);
    return { output: 'Saved the reviewed local output.' };
  });
  outputPath = path.join(fixture.root, 'result.txt');
  const started = fixture.engine.startRun({ workflow: graph('fixture-model'),
    input: { task: 'Save the reviewed local output', directoryActions: 'on' } });
  await fixture.engine.executions.get(started.id);
  assert.equal(fixture.engine.getRun(started.id).status, 'completed', fixture.engine.getRun(started.id).error);
  assert.equal(await readFile(outputPath, 'utf8'), expected);
  assert.equal(delivered.length, 6); assert.equal(hostResults.length, 6);
});
