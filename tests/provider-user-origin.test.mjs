import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createCurrentUserOrigin, extendCurrentUserOrigin, pinCurrentUserOrigin } from '../lib/provider-user-origin.mjs';
import { workbenchFramePng } from './fixtures/legacy-bmp-to-png.mjs';

const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const turn = 'turn_original';
const error = (code, message = code) => Object.assign(new Error(message), { code });
function initialRecord(prompt = 'Actual current request') {
  const record = { messages: [user(prompt)] };
  record.currentUserOrigin = createCurrentUserOrigin(record, 0, turn);
  return record;
}
function direction(record, text) {
  const index = record.messages.length;
  record.messages.push(user(text));
  record.currentUserOrigin = extendCurrentUserOrigin(record, index, turn);
}
function replace(record, cut, expectedTurn) {
  const pinned = pinCurrentUserOrigin(record, cut, expectedTurn);
  return { ...record, messages: [user('Generated historical checkpoint'), ...pinned.prefixMessages, ...record.messages.slice(cut)], currentUserOrigin: pinned.origin };
}
const tuple = record => structuredClone({
  messages: record.messages, currentUserOrigin: record.currentUserOrigin, compactions: record.compactions,
  lastContextUsage: record.lastContextUsage, lastInputEstimate: record.lastInputEstimate,
});
const markers = ['[BLACKICE DIRECTORY RECOVERY]', '[BLACKICE INTERNAL CONTINUATION]', '[RELAY CONTEXT CHECKPOINT — historical continuity summary]'];

for (const marker of markers) test('literal marker text remains genuine: ' + marker, () => {
  const record = initialRecord(marker + '\nGenuine user α 🧭');
  const original = record.messages[0], hostCopy = user(original.content);
  record.messages.push(assistant('Observed'), hostCopy);
  const pinned = pinCurrentUserOrigin(record, 2, turn);
  assert.deepEqual(pinned.prefixMessages, [original]);
  assert.equal(pinned.prefixMessages[0], original);
  assert.notEqual(pinned.prefixMessages[0], hostCopy);
  assert.equal(pinned.origin.anchors.length, 1, 'equal text cannot promote host origin');
});

test('explicit anchors reindex across repeated compaction and JSON reload without tail duplication', () => {
  let record = initialRecord();
  record.messages.push(assistant('Earlier result'));
  direction(record, 'Accepted direction β');
  record.messages.push(user(markers[0] + '\nHost recovery'));
  direction(record, 'Accepted direction β');
  record.messages.push(assistant('Latest result'));
  const original = record.messages[0], firstDirection = record.messages[2], lastDirection = record.messages[4];
  record = replace(record, 4, turn);
  assert.deepEqual(record.currentUserOrigin.anchors.map(x => x.messageIndex), [1, 2, 3]);
  assert.equal(record.messages[1], original);
  assert.equal(record.messages[2], firstDirection);
  assert.equal(record.messages[3], lastDirection, 'a tail anchor keeps its original object and position in the tail');
  assert.equal(record.messages.filter(x => x === lastDirection).length, 1);
  record = JSON.parse(JSON.stringify(record));
  const reloadedOriginal = record.messages[1];
  record = replace(record, 3);
  assert.equal(record.currentUserOrigin.turnId, turn, 'maintenance does not replace the originating turn');
  assert.deepEqual(record.currentUserOrigin.anchors.map(x => x.messageIndex), [1, 2, 3]);
  assert.equal(record.messages[1], reloadedOriginal);
  assert.equal(record.messages.filter(x => x.content === 'Accepted direction β').length, 2, 'two accepted directions are preserved, not deduplicated by text');
});

test('a new actual foreground prompt replaces old authority, while a direction cannot create it', () => {
  const record = initialRecord();
  record.messages.push(user('New foreground request'));
  record.currentUserOrigin = createCurrentUserOrigin(record, 1, 'turn_new');
  assert.equal(record.currentUserOrigin.turnId, 'turn_new');
  assert.deepEqual(record.currentUserOrigin.anchors.map(x => x.messageIndex), [1]);
  record.messages.push(user('Accepted new direction'));
  assert.equal(extendCurrentUserOrigin(record, 2, 'turn_other'), undefined);
  delete record.currentUserOrigin;
  assert.equal(extendCurrentUserOrigin(record, 2, 'turn_new'), undefined);
  assert.equal(pinCurrentUserOrigin(record, 2), null);
});

test('legacy messages are never classified from role or marker text', () => {
  const record = { messages: [user('Real or historical?'), user(markers[0]), assistant('Unknown')] };
  assert.equal(pinCurrentUserOrigin(record, 2), null);
  assert.equal(Object.hasOwn(record, 'currentUserOrigin'), false);
});

for (const [name, corrupt] of [
  ['null sidecar', r => { r.currentUserOrigin = null; }],
  ['unsupported version', r => { r.currentUserOrigin.version = 2; }],
  ['unknown field', r => { r.currentUserOrigin.extra = true; }],
  ['wrong first kind', r => { r.currentUserOrigin.anchors[0].kind = 'accepted-user-direction'; }],
  ['changed message', r => { r.messages[0].content = 'Changed by something else'; }],
  ['invalid hash', r => { r.currentUserOrigin.anchors[0].messageSha256 = '0'.repeat(64); }],
  ['outside index', r => { r.currentUserOrigin.anchors[0].messageIndex = 99; }],
  ['duplicate index', r => { r.currentUserOrigin.anchors.push({ ...r.currentUserOrigin.anchors[0], kind: 'accepted-user-direction' }); }],
]) test('malformed origin rejects without mutating history: ' + name, () => {
  const record = initialRecord(); record.messages.push(assistant('History')); corrupt(record);
  const before = structuredClone(record);
  assert.throws(() => pinCurrentUserOrigin(record, 1), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
  assert.deepEqual(record, before);
});

test('foreground identity and compaction bounds are checked independently from manual maintenance', () => {
  const record = initialRecord();
  assert.throws(() => pinCurrentUserOrigin(record, 1, 'turn_other'), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
  assert.doesNotThrow(() => pinCurrentUserOrigin(record, 1));
  for (const cut of [-1, 0.5, 2]) assert.throws(() => pinCurrentUserOrigin(record, cut), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
});

for (const content of [
  [{ type: 'tool_result', tool_use_id: 'call-a', content: 'Tool result' }],
  [{ type: 'text', text: 'Tool screenshots' }, { type: 'image_url', image_url: { url: 'fixture-image' } }],
]) test('tool-result and image supplement blocks cannot be registered as genuine prompt anchors: ' + content[0].type, () => {
  assert.throws(() => createCurrentUserOrigin({ messages: [user(content)] }, 0, turn), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
});

const context = { preset: 'custom', windowTokens: 8192, outputReserveTokens: 512, headroomTokens: 256, keepRecentTokens: 256, autoCompact: false };
const observe = { type: 'function', name: 'observe', description: 'Observe a fixture fact.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
function reply(type, text, { call = false, id = 'call-a', name = 'observe', args = {}, incomplete = false } = {}) {
  if (type === 'openai') return { status: incomplete ? 'incomplete' : 'completed', output: call
    ? [{ type: 'function_call', id: 'item-' + id, call_id: id, name, arguments: JSON.stringify(args) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
  if (type === 'anthropic') return { content: call ? [{ type: 'tool_use', id, name, input: args }] : [{ type: 'text', text }],
    stop_reason: incomplete ? 'max_tokens' : call ? 'tool_use' : 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } };
  return { choices: [{ message: call
    ? { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: text }, finish_reason: incomplete ? 'length' : call ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
}
async function fixture(t, { type = 'compatible', summary = 'Historical fixture progress only; verify current instructions.', incomplete = false,
  normalReply, evidence = 'observed evidence '.repeat(480) } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-user-origin-test-'));
  const requests = [], runtimes = new Set(), counters = { summaries: 0, normal: 0, tools: 0 };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'no traffic leaves the injected fixture');
    if (options.method === 'GET') return Response.json({ data: [] });
    const body = JSON.parse(options.body); requests.push(body);
    const isSummary = JSON.stringify(body).includes('Create a concise continuity checkpoint');
    if (isSummary) { counters.summaries++; return Response.json(reply(type, summary, { incomplete })); }
    counters.normal++;
    return Response.json(normalReply ? normalReply(counters.normal, body) : reply(type, 'Verified fixture.', { call: counters.normal === 1 }));
  };
  const create = async () => {
    const codex = new EventEmitter();
    codex.status = () => ({ connected: false, authenticated: false, models: [], activeTurns: 0 });
    codex.close = async () => {};
    const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl, modelLimitResolver: { enrich: async (_config, models) => models } }).init();
    runtimes.add(runtime); return runtime;
  };
  const runtime = await create();
  await runtime.saveProvider({ id: 'origin-fixture', type, ...(type === 'compatible' ? { preset: 'compatible' } : {}),
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-fixture-key', models: [{ id: 'fixture-model', contextWindowTokens: 8192, inputModalities: ['text', 'image'] }], maxSteps: 16 });
  t.after(async () => { for (const item of runtimes) await item.close(); assert.match(path.basename(dataDir), /^blackice-user-origin-test-/); await rm(dataDir, { recursive: true, force: true }); });
  const options = { cwd: dataDir, model: 'origin-fixture::fixture-model', prompt: 'Current genuine objective α', context, dynamicTools: [observe],
    onToolCall: async () => { counters.tools++; return { success: true, contentItems: [{ type: 'inputText', text: evidence }] }; } };
  return { runtime, dataDir, requests, counters, create, options };
}
function assertWireOriginAbsent(requests) {
  for (const request of requests) {
    const serialized = JSON.stringify(request);
    for (const key of ['currentUserOrigin', 'messageSha256', 'messageIndex', 'accepted-user-direction']) assert.equal(serialized.includes('"' + key + '"'), false, 'origin metadata stays off every primary and summary wire');
  }
}
function assertPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.type === 'function_call') pending.add(message.call_id);
    if (message.type === 'function_call_output') { assert.ok(pending.has(message.call_id)); pending.delete(message.call_id); }
    for (const call of message.tool_calls || []) pending.add(call.id);
    if (message.role === 'tool') { assert.ok(pending.has(message.tool_call_id)); pending.delete(message.tool_call_id); }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') pending.add(block.id);
      if (block.type === 'tool_result') { assert.ok(pending.has(block.tool_use_id)); pending.delete(block.tool_use_id); }
    }
  }
  assert.equal(pending.size, 0);
}

for (const type of ['openai', 'anthropic', 'compatible']) test(type + ' retains genuine input through host continuation, repeated manual compaction and durable reload', async t => {
  const f = await fixture(t, { type, summary: 'Incorrect inferred task label; historical summary only.' });
  const prompt = markers[0] + '\nGenuine current objective: keep the exact user request.';
  let reviews = 0;
  const first = await f.runtime.runAgent({ ...f.options, prompt, onBeforeFinal: () => ++reviews === 1
    ? { continue: true, prompt: 'Host final review: inspect remaining work.' } : null });
  const before = await f.runtime.readThread(first.threadId), originatingTurn = before.currentUserOrigin.turnId;
  assert.equal(before.currentUserOrigin.anchors.length, 1);
  assert.ok(before.messages.some(x => x.content === markers[1] + '\nHost final review: inspect remaining work.'));
  assert.equal((await f.runtime.compactThread(first.threadId)).compacted, true);
  let saved = await f.runtime.readThread(first.threadId);
  assert.equal(saved.messages.filter(x => x.content === prompt).length, 1);
  assert.equal(saved.currentUserOrigin.turnId, originatingTurn);
  assertPairs(saved.messages); assertPairs(saved.transcript);
  f.runtime.appendMessages(saved, [assistant('Additional settled history ' + 'known evidence '.repeat(450)), user(markers[0] + '\nLater host recovery'), assistant('History complete.')]);
  await f.runtime.persistThread(saved);
  await f.runtime.close();
  const restored = await f.create();
  await restored.saveProvider({ id: 'origin-fixture', apiKey: 'synthetic-fixture-key' });
  const again = await restored.compactThread(first.threadId);
  assert.equal(again.compacted, true);
  saved = await restored.readThread(first.threadId);
  assert.equal(saved.compactions.length, 2);
  assert.equal(saved.currentUserOrigin.turnId, originatingTurn, 'fresh compact_* maintenance IDs do not become the originating turn');
  assert.equal(saved.messages.filter(x => x.content === prompt).length, 1);
  assert.doesNotThrow(() => pinCurrentUserOrigin(saved, 1));
  const next = await restored.runAgent({ ...f.options, threadId: first.threadId, prompt: 'New actual foreground request.' });
  const nextRecord = await restored.readThread(next.threadId);
  assert.notEqual(nextRecord.currentUserOrigin.turnId, originatingTurn);
  assert.equal(nextRecord.currentUserOrigin.anchors.length, 1);
  assert.equal(nextRecord.messages[nextRecord.currentUserOrigin.anchors[0].messageIndex].content, 'New actual foreground request.');
  assert.equal(f.counters.tools, 1, 'compaction never replays the confirmed tool');
  assertWireOriginAbsent(f.requests);
});

test('actual Directory recovery cannot displace the initial user envelope during compaction', async t => {
  const tool = { ...observe, name: 'relay_code', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } };
  const f = await fixture(t, { normalReply: count => reply('compatible', 'Finished fixture.', {
    call: count <= 8, id: 'rejected-' + count, name: 'relay_code', args: { action: 'check' },
  }) });
  let recoveryCalls = 0, tools = 0;
  const initial = await f.runtime.runAgent({ ...f.options, dynamicTools: [tool],
    onToolCall: async () => { tools++; return { success: false, code: 'DIRECTORY_FOCUS', actionDispatched: false,
      contentItems: [{ type: 'inputText', text: 'The current action is not focused. ' + 'read-only evidence '.repeat(30) }] }; },
    onDirectoryToolRecovery: () => { recoveryCalls++; return { prompt: 'Host-only recovery instruction; the original current objective still applies.' }; },
  });
  assert.equal(recoveryCalls, 1); assert.equal(tools, 8);
  const before = await f.runtime.readThread(initial.threadId);
  assert.ok(before.messages.some(x => x.content === markers[0] + '\nHost-only recovery instruction; the original current objective still applies.'));
  assert.equal((await f.runtime.compactThread(initial.threadId)).compacted, true);
  const saved = await f.runtime.readThread(initial.threadId);
  assert.equal(saved.messages.filter(x => x.content === f.options.prompt).length, 1);
  assert.equal(saved.currentUserOrigin.anchors.length, 1);
  assert.equal(saved.messages[saved.currentUserOrigin.anchors[0].messageIndex].content, f.options.prompt);
  assertPairs(saved.messages); assertPairs(saved.transcript); assertWireOriginAbsent(f.requests);
});

test('accepted directions after a final summary supersede that checkpoint and survive the next compaction once', async t => {
  const f = await fixture(t, { evidence: 'observed evidence '.repeat(200), normalReply: count => {
    const value = reply('compatible', 'Finished after steering.', { call: count === 1 });
    if (count === 1) value.choices[0].message.tool_calls.push({ id: 'call-b', type: 'function', function: { name: 'observe', arguments: '{}' } });
    return value;
  } });
  const directions = ['Keep this actual accepted direction β.', markers[0] + '\nThis is also genuine user steering.'];
  const summarize = f.runtime.summarizeContextText.bind(f.runtime);
  let steered = false, accepts = [], reviews = 0;
  f.runtime.summarizeContextText = async (...args) => {
    const result = await summarize(...args);
    if (!steered) {
      steered = true;
      for (const text of directions) accepts.push(await f.runtime.steerAgent(args[0].record.id, text));
    }
    return result;
  };
  const result = await f.runtime.runAgent({ ...f.options, context: { ...context, autoCompact: true, compactAtTokens: 1000 },
    onBeforeFinal: () => ++reviews === 1 ? { continue: true, prompt: 'Host continuation creates a complete retained exchange before compaction.' } : null });
  const saved = await f.runtime.readThread(result.threadId);
  assert.equal(steered, true); assert.ok(accepts.every(x => x.accepted));
  assert.equal(saved.compactions.length, 1, 'the superseded candidate checkpoint was not committed');
  assert.equal(f.counters.summaries, 2, 'both actual summary responses remain accounted');
  assert.equal(f.counters.tools, 2);
  assert.deepEqual(saved.currentUserOrigin.anchors.map(x => saved.messages[x.messageIndex].content), [f.options.prompt, ...directions]);
  for (const text of [f.options.prompt, ...directions]) assert.equal(saved.messages.filter(x => x.content === text).length, 1);
  assertPairs(saved.messages); assertPairs(saved.transcript); assertWireOriginAbsent(f.requests);
});

test('failure before a new genuine prompt preserves accepted directions without borrowing the older origin', async t => {
  const f = await fixture(t), first = await f.runtime.runAgent(f.options);
  const before = await f.runtime.readThread(first.threadId), actualDirection = 'Accepted while preparing the new foreground run.';
  f.runtime.prepareLocalModel = async state => {
    assert.equal((await f.runtime.steerAgent(state.record.id, actualDirection)).accepted, true);
    throw error('FIXTURE_PREPARATION_FAILED');
  };
  await assert.rejects(f.runtime.runAgent({ ...f.options, threadId: first.threadId, prompt: 'A new prompt not yet installed.' }), { code: 'FIXTURE_PREPARATION_FAILED' });
  const saved = await f.runtime.readThread(first.threadId);
  assert.deepEqual(saved.messages.slice(0, before.messages.length), before.messages);
  assert.equal(saved.messages.at(-1).content, actualDirection);
  assert.equal(Object.hasOwn(saved, 'currentUserOrigin'), false);
  assert.equal(pinCurrentUserOrigin(saved, 1), null);
  assert.equal(f.counters.normal, 2, 'failed preparation started no new model exchange');
});

test('failure settlement preserves appended live directions and the primary failure for the current origin', async t => {
  const f = await fixture(t), actualDirection = markers[1] + '\nGenuine live direction before failure.';
  let threadId;
  f.runtime.modelResponse = async state => {
    threadId = state.record.id;
    assert.equal((await f.runtime.steerAgent(threadId, actualDirection)).accepted, true);
    const cause = error('FIXTURE_RUN_FAILED');
    state.controller.abort(cause); throw cause;
  };
  await assert.rejects(f.runtime.runAgent(f.options), { code: 'FIXTURE_RUN_FAILED' });
  const saved = await f.runtime.readThread(threadId);
  assert.deepEqual(saved.currentUserOrigin.anchors.map(x => saved.messages[x.messageIndex].content), [f.options.prompt, actualDirection]);
  assert.equal(saved.messages.filter(x => x.content === actualDirection).length, 1);
  assert.equal(f.counters.normal, 0); assert.equal(f.counters.tools, 0);
});

for (const kind of ['legacy', 'malformed']) test(kind + ' origin prevents compaction before any summary call', async t => {
  const f = await fixture(t), first = await f.runtime.runAgent(f.options);
  const seeded = await f.runtime.readThread(first.threadId);
  if (kind === 'legacy') delete seeded.currentUserOrigin;
  else seeded.currentUserOrigin.anchors[0].messageSha256 = '0'.repeat(64);
  await f.runtime.persistThread(seeded);
  const before = tuple(seeded), previousCalls = f.counters.summaries;
  if (kind === 'legacy') {
    const result = await f.runtime.compactThread(first.threadId);
    assert.equal(result.compacted, false); assert.match(result.reason, /origin/);
  } else await assert.rejects(f.runtime.compactThread(first.threadId), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
  assert.equal(f.counters.summaries, previousCalls);
  assert.deepEqual(tuple(await f.runtime.readThread(first.threadId)), before);
});

test('exact current anchors with insufficient capacity reject before requesting a summary', async t => {
  const f = await fixture(t), first = await f.runtime.runAgent({ ...f.options, prompt: 'Genuine current request ' + 'x'.repeat(9000) });
  const before = await f.runtime.readThread(first.threadId);
  await assert.rejects(f.runtime.compactThread(first.threadId, { context: { ...context, windowTokens: 4096 } }), { code: 'CONTEXT_OVERFLOW' });
  const saved = await f.runtime.readThread(first.threadId);
  assert.equal(f.counters.summaries, 0);
  assert.deepEqual(tuple(saved), tuple(before));
  assert.deepEqual(saved.totalUsage, before.totalUsage);
});

for (const mode of ['incomplete', 'oversized', 'nonreducing']) test(mode + ' summary preserves the whole checkpoint tuple and measured usage', async t => {
  const f = await fixture(t, { incomplete: mode === 'incomplete', summary: mode === 'oversized' ? 'x'.repeat(10000) : mode === 'nonreducing' ? 'x'.repeat(1000) : 'Incomplete summary.',
    ...(mode === 'nonreducing' ? { evidence: 'observed evidence '.repeat(20) } : {}) });
  const first = await f.runtime.runAgent(f.options), before = await f.runtime.readThread(first.threadId);
  await assert.rejects(f.runtime.compactThread(first.threadId), { code: mode === 'incomplete' ? 'CONTEXT_SUMMARY_FAILED' : 'CONTEXT_SUMMARY_INEFFECTIVE' });
  const saved = await f.runtime.readThread(first.threadId);
  assert.deepEqual(tuple(saved), tuple(before));
  assert.deepEqual(saved.transcript, before.transcript);
  assert.equal(f.counters.summaries, 1);
  assert.equal(saved.totalUsage.totalTokens, before.totalUsage.totalTokens + 25);
});

for (const mode of ['valid', 'nonreducing', 'throwing']) test('post-summary cancellation wins before checkpoint persistence: ' + mode, async t => {
  const f = await fixture(t), first = await f.runtime.runAgent(f.options), before = await f.runtime.readThread(first.threadId);
  const controller = new AbortController(), cause = error('ABORT_ERR', 'Cancelled at final summary boundary');
  const summarize = f.runtime.summarizeContextText.bind(f.runtime), persist = f.runtime.persistThread.bind(f.runtime), writes = [];
  f.runtime.summarizeContextText = async (...args) => {
    const result = await summarize(...args);
    controller.abort(cause);
    if (mode === 'throwing') throw error('CONTEXT_SUMMARY_INEFFECTIVE');
    return mode === 'nonreducing' ? { ...result, summary: 'x'.repeat(30000) } : result;
  };
  f.runtime.persistThread = async record => { writes.push(tuple(record)); return persist(record); };
  await assert.rejects(f.runtime.compactThread(first.threadId, { signal: controller.signal }), { code: 'ABORT_ERR' });
  const saved = await f.runtime.readThread(first.threadId);
  assert.deepEqual(tuple(saved), tuple(before));
  assert.ok(writes.length > 0);
  assert.ok(writes.every(value => JSON.stringify(value) === JSON.stringify(tuple(before))), 'only old-history catch persistence is permitted');
  assert.equal(saved.totalUsage.totalTokens, before.totalUsage.totalTokens + 25);
});

test('a failed staged write cannot be committed by manual catch persistence', async t => {
  const f = await fixture(t), first = await f.runtime.runAgent(f.options), before = await f.runtime.readThread(first.threadId);
  const persist = f.runtime.persistThread.bind(f.runtime), writes = [];
  f.runtime.persistThread = async record => {
    writes.push({ tuple: tuple(record), usage: structuredClone(record.totalUsage) });
    if (writes.length === 1) throw error('FIXTURE_WRITE_FAILED');
    return persist(record);
  };
  await assert.rejects(f.runtime.compactThread(first.threadId), { code: 'FIXTURE_WRITE_FAILED' });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].tuple.compactions.length, before.compactions.length + 1);
  assert.deepEqual(writes[1].tuple, tuple(before), 'catch must not save the rejected replacement');
  const saved = await f.runtime.readThread(first.threadId);
  assert.deepEqual(tuple(saved), tuple(before));
  assert.equal(saved.totalUsage.totalTokens, before.totalUsage.totalTokens + 25);
});

for (const succeed of [true, false]) test('cancellation during a staged write remains coherent when the write ' + (succeed ? 'succeeds' : 'fails'), async t => {
  const f = await fixture(t), first = await f.runtime.runAgent(f.options), before = await f.runtime.readThread(first.threadId);
  const controller = new AbortController(), persist = f.runtime.persistThread.bind(f.runtime), writes = [];
  let release, announce;
  const writing = new Promise(resolve => { announce = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.runtime.persistThread = async record => {
    writes.push(tuple(record));
    if (writes.length === 1) {
      announce(); await blocked;
      if (!succeed) throw error('FIXTURE_WRITE_FAILED');
    }
    return persist(record);
  };
  const compaction = f.runtime.compactThread(first.threadId, { signal: controller.signal });
  await Promise.race([writing, compaction.then(() => { throw new Error('No staged write was observed.'); })]);
  controller.abort(error('ABORT_ERR', 'Cancelled while writing'));
  release();
  await assert.rejects(compaction, { code: succeed ? 'ABORT_ERR' : 'FIXTURE_WRITE_FAILED' });
  assert.equal(writes.length, 2, 'the existing catch persists the coherent live tuple');
  const saved = await f.runtime.readThread(first.threadId);
  if (succeed) {
    assert.deepEqual(writes[1], writes[0]);
    assert.deepEqual(tuple(saved), writes[0]);
    assert.equal(saved.compactions.length, before.compactions.length + 1);
    assert.doesNotThrow(() => pinCurrentUserOrigin(saved, 1));
  } else {
    assert.deepEqual(writes[1], tuple(before));
    assert.deepEqual(tuple(saved), tuple(before));
  }
  assert.equal(saved.totalUsage.totalTokens, before.totalUsage.totalTokens + 25);
});

function pngUrl() {
  const bytes = Buffer.alloc(58); bytes.write('BM'); bytes.writeUInt32LE(58, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(-1, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(32, 28);
  bytes[54] = 91; bytes[55] = 43; bytes[56] = 17;
  return 'data:image/png;base64,' + workbenchFramePng({ bytes, width: 1, height: 1, contentType: 'image/bmp' }).toString('base64');
}
for (const type of ['openai', 'anthropic', 'compatible']) test(type + ' compaction retains exact image prompt identity and decorates only the outgoing copy', async t => {
  const imageUrl = pngUrl(), f = await fixture(t, { type, normalReply: () => reply(type, 'Image fixture complete.') });
  let state, originalPrompt;
  const result = await f.runtime.runAgent({
    cwd: f.dataDir, model: 'origin-fixture::fixture-model', prompt: 'Assess the supplied image against this exact current request.',
    responseOnly: true, dynamicTools: [], inputImages: [{ imageUrl }], context: { ...context, autoCompact: true, compactAtTokens: 1000 },
    onEvent: event => {
      if (event.type !== 'thread') return;
      state = f.runtime.active.get(event.threadId); originalPrompt = state.inputImageMessage;
      f.runtime.appendMessages(state.record, [assistant('Fixture history ' + 'old observed fact '.repeat(450)), user(markers[1] + '\nHost continuation'), assistant('Historical completion')]);
    },
  });
  assert.equal(result.context.compactionCount, 1);
  assert.equal(state.inputImageMessage, originalPrompt);
  assert.ok(state.record.messages.includes(originalPrompt), 'pinning must not clone the image prompt');
  const ordinary = f.requests.filter(body => !JSON.stringify(body).includes('Create a concise continuity checkpoint'));
  assert.equal(ordinary.length, 1);
  const decorated = (ordinary[0].input || ordinary[0].messages).filter(message => Array.isArray(message.content)
    && message.content.some(block => ['input_image', 'image', 'image_url'].includes(block.type)));
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].content[0].text, originalPrompt.content);
  const block = decorated[0].content[1], actual = type === 'openai' ? block.image_url : type === 'anthropic' ? 'data:' + block.source.media_type + ';base64,' + block.source.data : block.image_url.url;
  assert.equal(actual, imageUrl);
  const raw = await readFile(f.runtime.threadFile(result.threadId), 'utf8'), saved = JSON.parse(raw);
  assert.equal(raw.includes(imageUrl), false);
  assert.equal(raw.includes(imageUrl.split(',')[1]), false);
  assert.equal(saved.messages[saved.currentUserOrigin.anchors[0].messageIndex].content, originalPrompt.content);
  assertWireOriginAbsent(f.requests);
});

test('an origin validation failure preserves the unprocessed suffix of two accepted directions', async t => {
  const f = await fixture(t), accepted = ['First accepted direction.', 'Second accepted direction.'];
  let threadId, modelCalls = 0;
  f.runtime.modelResponse = async state => {
    modelCalls++; threadId = state.record.id;
    state.record.currentUserOrigin.anchors[0].messageSha256 = '0'.repeat(64);
    for (const text of accepted) assert.equal((await f.runtime.steerAgent(threadId, text)).accepted, true);
    throw state.stepController.signal.reason;
  };
  await assert.rejects(f.runtime.runAgent(f.options), { code: 'CONTEXT_USER_ORIGIN_INVALID' });
  const saved = await f.runtime.readThread(threadId);
  assert.deepEqual(saved.messages.map(x => x.content), [f.options.prompt, ...accepted]);
  for (const text of accepted) assert.equal(saved.transcript.filter(x => x.content === text).length, 1);
  assert.equal(Object.hasOwn(saved, 'currentUserOrigin'), false);
  assert.equal(modelCalls, 1);
  assert.equal(f.counters.tools, 0);
});
