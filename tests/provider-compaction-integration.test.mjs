/*
 * Regression for composed compatible-provider continuity: streamed reasoning,
 * Directory denial/recovery, genuine user anchors, compaction and durable reload.
 * Provider replies are injected fixtures; no live model or endpoint is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { HarnessEngine } from '../lib/engine.mjs';

const RECOVERY = '[BLACKICE DIRECTORY RECOVERY]\n';
const CHOICES = 'Current Directory choices (same task): ';
const CHECKPOINT = '[RELAY CONTEXT CHECKPOINT — historical continuity summary]\n';
const resultText = result => result.contentItems
  .filter(item => item.type === 'inputText').map(item => item.text).join('\n');
const callMessage = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const reply = message => Response.json({ choices: [{ index: 0, message,
  finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });

function streamedTool(id, name, args, fragments) {
  const encoded = JSON.stringify(args), boundary = Math.floor(encoded.length / 2);
  const nameBoundary = Math.floor(name.length / 2);
  const deltas = [
    { reasoning_content: fragments[0], tool_calls: [{ index: 0, id, type: 'function',
      function: { name: name.slice(0, nameBoundary), arguments: encoded.slice(0, boundary) } }] },
    { reasoning_content: null, tool_calls: [{ index: 0,
      function: { name: name.slice(nameBoundary), arguments: encoded.slice(boundary) } }] },
    { reasoning_content: fragments[1] },
  ];
  const frames = deltas.map(delta => ({ choices: [{ index: 0, delta }] }));
  frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
    + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function choicesFrom(text) {
  const lines = text.split('\n').filter(line => line.startsWith(CHOICES));
  assert.equal(lines.length, 1, 'The complete actual DH1 hint is delivered once.');
  return JSON.parse(lines[0].slice(CHOICES.length));
}

function assertPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      assert.equal(pending.has(call.id), false);
      pending.add(call.id);
    }
    if (message.role === 'tool') {
      assert.ok(pending.has(message.tool_call_id), 'Every retained result has its assistant call.');
      pending.delete(message.tool_call_id);
    }
  }
  assert.equal(pending.size, 0, 'No retained assistant call loses its tool result.');
}

function assertWireOriginAbsent(requests) {
  for (const request of requests) {
    const encoded = JSON.stringify(request);
    for (const key of ['currentUserOrigin', 'messageSha256', 'messageIndex', 'accepted-user-direction'])
      assert.equal(encoded.includes('"' + key + '"'), false, key + ' stays off primary and summary wires.');
  }
}

class Native extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [], activeTurns: 0 }; }
  async runAgent() { throw Error('No native or real model may run in this fixture.'); }
  async close() {}
}

test('composed streamed reasoning, Directory recovery and genuine user anchors survive compaction and reload without tool replay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-compaction-integration-'));
  const dataDir = path.join(root, 'provider'), outputPath = path.join(root, 'result.txt');
  const expected = 'Verified résumé — 東京\n';
  const objective = 'Save the "reviewed" résumé — 東京\nPreserve the exact source.';
  const task = RECOVERY + 'This marker is literal genuine user text. Save the reviewed local output. Use Modular Development.';
  const direction = RECOVERY + 'This is genuine accepted user steering. Keep the exact Unicode output and do not repeat confirmed effects.';
  const oldFragments = ['Earlier α\n', 'Rejected effect remains unexecuted.'];
  const tailFragments = ['Retained β\n', '思考 🧭 — cite only the actual saved receipt.'];
  const misleadingSummary = 'Incorrect task label: host recovery is now the current request. Historical summary only.';
  const requests = [], primaryRequests = [], summaryRequests = [], results = new Map(), executionIds = [];
  const runtimes = new Set();
  let runtime, engine, runId, planSnapshot, engineOptions, recoveryMessage, originalEnvelope;
  let primaryCount = 0, steeringReceipt, mode = 'engine', beforeReload;

  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'http://127.0.0.1:8080', 'All traffic is intercepted by this injected mock.');
    if ((options.method || 'GET') === 'GET') return Response.json({ data: [
      { id: 'fixture', context_length: 1000000, max_output_tokens: 128000 },
    ] });
    assert.equal(endpoint.pathname, '/v1/chat/completions');
    const body = JSON.parse(options.body); requests.push(body);
    if (JSON.stringify(body).includes('Create a concise continuity checkpoint')) {
      assert.equal(mode, 'compaction', 'Only the explicit fixture maintenance step may request a summary.');
      summaryRequests.push(body);
      return reply({ role: 'assistant', content: misleadingSummary });
    }
    primaryRequests.push(body); primaryCount++;
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'])
      assert.equal(Object.hasOwn(body, key), false, 'Provider-default primary output remains uncapped by the harness.');
    if (mode === 'restored') {
      assert.equal(primaryCount, 15);
      const historyStart = body.messages.findIndex(message => message.role === beforeReload.messages[0].role
        && message.content === beforeReload.messages[0].content);
      assert.ok(historyStart >= 0);
      assert.deepEqual(body.messages.slice(historyStart, historyStart + beforeReload.messages.length), beforeReload.messages,
        'The restored request carries the exact compacted saved history.');
      assert.deepEqual(body.tools, primaryRequests[0].tools, 'Reload does not reduce the tool catalog.');
      return reply({ role: 'assistant', content: 'Confirmed the saved result without another tool call.' });
    }
    assert.equal(mode, 'engine');
    if (primaryCount === 1) {
      originalEnvelope = body.messages.find(message => message.role === 'user');
      assert.ok(originalEnvelope?.content.includes(task), 'Capture the actual full engine-supplied genuine prompt.');
      return reply(callMessage('plan-result', 'relay_directory_action', { action: 'plan',
        actions: [{ id: 'save_result', objective, dependsOn: [] }] }));
    }
    if (primaryCount === 2) planSnapshot = (await engine.actionDirectories.get(runId, 'ignored')).read();
    if (primaryCount >= 3 && primaryCount <= 10) {
      const id = 'denied-' + (primaryCount - 2), result = results.get(id);
      assert.ok(result); assert.equal(result.code, 'DIRECTORY_FOCUS');
      assert.equal(result.success, false); assert.equal(result.actionDispatched, false);
      const tool = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
      assert.equal(tool.content, resultText(result), 'The actual complete denial reaches the following request unchanged.');
      assert.deepEqual(choicesFrom(tool.content), { taskId: runId,
        actionRevision: planSnapshot.actionRevision, focus: null, ready: ['save_result'],
        actions: [{ id: 'save_result', objective, state: 'pending' }] });
      assert.deepEqual((await engine.actionDirectories.get(runId, 'ignored')).read(), planSnapshot);
      await assert.rejects(access(outputPath), { code: 'ENOENT' });
    }
    if (primaryCount >= 2 && primaryCount <= 9) {
      const ordinal = primaryCount - 1, id = 'denied-' + ordinal;
      const args = { action: 'write', path: outputPath, text: expected };
      return ordinal === 8
        ? streamedTool(id, 'relay_workspace', args, oldFragments)
        : reply(callMessage(id, 'relay_workspace', args));
    }
    if (primaryCount === 10) {
      recoveryMessage = body.messages.at(-1);
      assert.equal(recoveryMessage.role, 'user'); assert.ok(recoveryMessage.content.startsWith(RECOVERY));
      assert.equal(body.messages.at(-2).tool_call_id, 'denied-8');
      const recovery = JSON.parse(recoveryMessage.content.split('\n').at(-1));
      assert.equal(recovery.task.taskId, runId);
      assert.equal(recovery.rejection.lastCallId, 'denied-8');
      assert.equal(recovery.rejection.actionDispatched, false);
      assert.deepEqual(recovery.directory.readyActions, ['save_result']);
      assert.equal(recovery.directory.focus, null);
      assert.equal(recovery.directory.actions[0].state, 'pending');
      const active = [...runtime.active.values()];
      assert.equal(active.length, 1);
      steeringReceipt = await runtime.steerAgent(active[0].record.id, direction);
      assert.equal(steeringReceipt.accepted, true);
      assert.equal(options.signal.aborted, true);
      throw options.signal.reason; // Real accepted steering supersedes this mock response.
    }
    if (primaryCount === 11) {
      assert.equal(body.messages.at(-1).content, direction);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.equal(body.messages.filter(message => message.content === recoveryMessage.content).length, 1);
      return reply(callMessage('focus-result', 'relay_directory_action', { action: 'focus', id: 'save_result' }));
    }
    if (primaryCount === 12) return reply(callMessage('write-result', 'relay_workspace',
      { action: 'write', path: outputPath, text: expected }));
    if (primaryCount === 13) {
      const written = body.messages.at(-1);
      assert.equal(written.tool_call_id, 'write-result');
      const receipt = written.content.match(/receipt-[0-9]+/); assert.ok(receipt);
      return streamedTool('observe-result', 'relay_directory_action', { action: 'observe', id: 'save_result',
        outcome: 'objective-met', claim: 'The exact reviewed output was saved.', receipts: [receipt[0]] }, tailFragments);
    }
    assert.equal(primaryCount, 14, 'The single recovery stays in this provider attempt.');
    return reply({ role: 'assistant', content: 'Saved the verified Unicode output.' });
  };

  const create = async () => {
    const item = await new ProviderRuntime({ codex: new Native(), dataDir, fetchImpl,
      modelLimitResolver: { enrich: async (_config, models) => models } }).init();
    runtimes.add(item); return item;
  };
  t.after(async () => {
    await engine?.close();
    for (const item of runtimes) await item.close();
    assert.match(path.basename(root), /^provider-compaction-integration-/);
    await rm(root, { recursive: true, force: true });
  });
  runtime = await create();
  await runtime.saveProvider({ id: 'local_llamacpp', preset: 'llamacpp', type: 'compatible',
    baseUrl: 'http://127.0.0.1:8080/v1', models: ['fixture'], maxSteps: null,
    outputTokenPolicy: 'provider-default' });
  const execute = runtime.executeTool.bind(runtime);
  runtime.executeTool = async (state, call) => {
    const id = call.id || call.callId;
    assert.equal(executionIds.includes(id), false, 'No completed tool may be dispatched twice.');
    executionIds.push(id);
    const result = await execute(state, call);
    results.set(id, structuredClone(result)); return result;
  };
  const runAgent = runtime.runAgent.bind(runtime);
  runtime.runAgent = options => {
    assert.equal(engineOptions, undefined, 'The engine starts one foreground provider run.');
    assert.equal(typeof options.onDirectoryToolRecovery, 'function', 'Use the actual engine-installed host hook.');
    engineOptions = options; return runAgent(options);
  };
  engine = await new HarnessEngine({ runtime, dataDir: path.join(root, 'engine'), defaultCwd: root }).init();
  const workflow = { name: 'Composed continuity fixture',
    nodes: [{ id: 'i', type: 'input' }, { id: 'a', type: 'agent', name: 'Agent',
      model: 'local_llamacpp::fixture', prompt: 'Do the current task' }, { id: 'o', type: 'output' }],
    edges: [{ source: 'i', target: 'a' }, { source: 'a', target: 'o' }],
    settings: { maxParallel: 1, planningMode: 'off', context: {
      preset: 'custom', windowTokens: 65536, outputReserveTokens: 2048,
      headroomTokens: 256, keepRecentTokens: 256, autoCompact: false,
    } } };
  // This small retained-tail setting is confined to mocked maintenance in this test.
  // It neither changes nor qualifies any live model policy.
  const started = engine.startRun({ workflow, input: { task, directoryActions: 'on' } });
  runId = started.id; await engine.executions.get(runId);
  const run = engine.getRun(runId);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(await readFile(outputPath, 'utf8'), expected);
  assert.equal(primaryCount, 14); assert.equal(summaryRequests.length, 0);
  assert.equal(results.size, 12);
  const directory = (await engine.actionDirectories.get(runId, 'ignored')).read();
  assert.equal(directory.actions[0].state, 'observed');
  assert.equal(directory.receipts.length, 1, 'Only the actual focused write gets an effect receipt.');
  assert.equal(directory.receipts[0].tool, 'relay_workspace'); assert.equal(directory.receipts[0].success, true);
  const threadId = run.nodes.a.threadId;
  const before = await runtime.readThread(threadId), originTurn = before.currentUserOrigin.turnId;
  assert.equal(steeringReceipt.turnId, originTurn);
  assert.deepEqual(before.currentUserOrigin.anchors.map(anchor => anchor.kind),
    ['current-request', 'accepted-user-direction']);
  assert.deepEqual(before.currentUserOrigin.anchors.map(anchor => before.messages[anchor.messageIndex]),
    [originalEnvelope, { role: 'user', content: direction }]);
  assert.equal(before.messages.filter(message => message.content === recoveryMessage.content).length, 1);
  const oldReasoning = before.messages.find(message => message.tool_calls?.some(call => call.id === 'denied-8'));
  const retainedReasoning = before.messages.find(message => message.tool_calls?.some(call => call.id === 'observe-result'));
  assert.equal(oldReasoning.reasoning_content, oldFragments.join(''));
  assert.equal(retainedReasoning.reasoning_content, tailFragments.join(''));
  assert.equal(oldReasoning.content, null); assert.equal(retainedReasoning.content, null);
  assertPairs(before.messages); assertPairs(before.transcript);
  const executedBeforeMaintenance = [...executionIds];

  mode = 'compaction';
  const compacted = await runtime.compactThread(threadId);
  assert.equal(compacted.compacted, true);
  const cut = compacted.checkpoint.sourceMessageCount;
  assert.ok(before.currentUserOrigin.anchors.every(anchor => anchor.messageIndex < cut),
    'Both genuine anchors must actually be in the summarized prefix; retention cannot pass vacuously.');
  const recoveryIndex = before.messages.findIndex(message => message.content === recoveryMessage.content);
  assert.ok(recoveryIndex >= 0 && recoveryIndex < cut, 'The real host recovery is also in the prefix.');
  assert.ok(before.messages.indexOf(retainedReasoning) >= cut, 'The latest reasoning-bearing tool exchange remains in the tail.');
  const saved = await runtime.readThread(threadId);
  assert.ok(saved.messages[0].content.startsWith(CHECKPOINT));
  assert.ok(saved.messages[0].content.includes(misleadingSummary));
  assert.equal(saved.compactions.length, 1);
  assert.equal(saved.pendingToolCalls, undefined); assert.equal(saved.pendingToolResults, undefined);
  assert.equal(saved.currentUserOrigin.turnId, originTurn, 'A compact_* maintenance ID cannot replace the foreground identity.');
  assert.deepEqual(saved.currentUserOrigin.anchors.map(anchor => saved.messages[anchor.messageIndex]),
    [originalEnvelope, { role: 'user', content: direction }]);
  for (const content of [originalEnvelope.content, direction])
    assert.equal(saved.messages.filter(message => message.content === content).length, 1);
  assert.equal(saved.currentUserOrigin.anchors.some(anchor => saved.messages[anchor.messageIndex].content === recoveryMessage.content), false);
  assert.equal(saved.currentUserOrigin.anchors.some(anchor => saved.messages[anchor.messageIndex].content.startsWith(CHECKPOINT)), false);
  assert.deepEqual(saved.messages.find(message => message.tool_calls?.some(call => call.id === 'observe-result')), retainedReasoning);
  assert.deepEqual(saved.transcript, before.transcript, 'Compaction retains the complete original transcript unchanged.');
  assertPairs(saved.messages); assertPairs(saved.transcript);
  assert.deepEqual(executionIds, executedBeforeMaintenance, 'Summarization grants no dispatch or action credit.');
  assert.ok(summaryRequests.length > 0);
  const summaryWire = JSON.stringify(summaryRequests);
  assert.ok(summaryWire.includes('Earlier α'), 'The older streamed reasoning reaches the existing history serializer.');
  assert.ok(summaryWire.includes('Rejected effect remains unexecuted.'));
  assertWireOriginAbsent(requests);

  await engine.close(); engine = null;
  await runtime.close(); runtimes.delete(runtime);
  const restored = await create();
  beforeReload = await restored.readThread(threadId);
  for (const key of ['messages', 'currentUserOrigin', 'compactions', 'lastContextUsage', 'lastInputEstimate', 'transcript'])
    assert.deepEqual(beforeReload[key], saved[key], 'Reload preserves the coherent saved ' + key + '.');
  assert.equal(beforeReload.currentUserOrigin.turnId, originTurn);
  assert.deepEqual(beforeReload.messages.find(message => message.tool_calls?.some(call => call.id === 'observe-result')), retainedReasoning);
  mode = 'restored';
  const followup = 'Confirm the saved result from the retained history without another tool call.';
  const resumed = await restored.runAgent({
    cwd: engineOptions.cwd, model: engineOptions.model, threadId, prompt: followup,
    context: engineOptions.context, dynamicTools: engineOptions.dynamicTools,
    hostOnlyTools: engineOptions.hostOnlyTools, providerExecutionContract: engineOptions.providerExecutionContract,
    developerInstructions: engineOptions.developerInstructions,
    onToolCall: async () => { assert.fail('Reload or compaction must not replay any old tool.'); },
  });
  assert.equal(resumed.output, 'Confirmed the saved result without another tool call.');
  assert.equal(resumed.threadId, threadId); assert.equal(primaryCount, 15);
  assert.deepEqual(executionIds, executedBeforeMaintenance);
  const finalRecord = await restored.readThread(threadId);
  assert.notEqual(finalRecord.currentUserOrigin.turnId, originTurn, 'Only a new genuine foreground prompt establishes a new authority.');
  assert.equal(finalRecord.currentUserOrigin.anchors.length, 1);
  assert.equal(finalRecord.messages[finalRecord.currentUserOrigin.anchors[0].messageIndex].content, followup);
  for (const request of primaryRequests) {
    assert.deepEqual(request.tools, primaryRequests[0].tools);
    for (const message of request.messages) {
      if (message.role !== 'assistant') assert.equal(Object.hasOwn(message, 'reasoning_content'), false);
    }
  }
  for (const record of [before, saved, beforeReload, finalRecord]) {
    for (const message of record.messages) {
      if (message.role !== 'assistant') assert.equal(Object.hasOwn(message, 'reasoning_content'), false);
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) || '';
      assert.equal(content.includes(tailFragments.join('')), false, 'Retained reasoning is not promoted to content or instructions.');
    }
  }
  assertPairs(finalRecord.messages); assertPairs(finalRecord.transcript);
  assertWireOriginAbsent(requests);
  assert.equal(await readFile(outputPath, 'utf8'), expected);
});
