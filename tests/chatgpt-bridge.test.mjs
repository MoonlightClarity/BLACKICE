import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatGPTBridgeStore, CHATGPT_BRIDGE_LIMITS, CHATGPT_BRIDGE_TOOLS, dispatchChatGPTBridgeTool } from '../lib/chatgpt-bridge.mjs';

const input = (requestId = randomUUID(), extra = {}) => ({ requestId, title: 'Review the next step', prompt: 'Explain how the selected approach works.', context: 'These are deliberately supplied project notes.', cwd: 'C:\\Users\\Example\\Documents\\Blackice', ...extra });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-chatgpt-bridge-'));
  const store = await new ChatGPTBridgeStore({ dataDir: directory, ...options }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, file: path.join(directory, 'chatgpt-bridge.json'), store };
}
const conflict = cause => cause.status === 409 && cause.code === 'CHATGPT_BRIDGE_CONFLICT';

test('bridge reads are inert, summaries bounded, and request text immutable', async t => {
  const { directory, file, store } = await fixture(t);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(store.status().healthy, true); assert.equal(store.status().pending, 0);
  const submitted = input(undefined, { prompt: `  Retain spaces.\n${'context '.repeat(100)}` });
  const saved = await store.enqueue(submitted); const originalFile = await fs.readFile(file, 'utf8');
  assert.equal(saved.status, 'pending'); assert.equal(saved.revision, 1); assert.equal(saved.prompt, submitted.prompt);
  saved.prompt = 'caller mutation'; submitted.context = 'caller changed input';
  const read = store.get(saved.id), listed = store.list();
  assert.notEqual(read.prompt, saved.prompt); assert.notEqual(read.context, submitted.context);
  assert.equal(listed.total, 1); assert.equal(listed.nextOffset, null); assert.equal(listed.items[0].preview.length, CHATGPT_BRIDGE_LIMITS.previewChars);
  for (const field of ['prompt', 'context', 'answer', 'cwd']) assert.equal(Object.hasOwn(listed.items[0], field), false);
  listed.items[0].title = 'caller mutation'; assert.equal(store.get(saved.id).title, 'Review the next step');
  assert.equal(store.get(saved.id).status, 'pending'); assert.equal(await fs.readFile(file, 'utf8'), originalFile);
});

test('enqueue and completion retries remain idempotent after restart', async t => {
  const { directory, file, store } = await fixture(t), submitted = input(), saved = await store.enqueue(submitted);
  assert.deepEqual(await store.enqueue(submitted), saved);
  const completion = { id: saved.id, revision: saved.revision, answer: 'A durable answer.\n\nKeep the supplied formatting.  ' };
  const completed = await store.complete(completion);
  assert.equal(completed.revision, 2); assert.equal(completed.status, 'completed'); assert.equal(completed.answer, completion.answer);
  assert.equal(completed.prompt, saved.prompt); assert.equal(completed.context, saved.context);
  await store.close(); const restarted = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => restarted.close());
  const persisted = await fs.readFile(file, 'utf8');
  assert.deepEqual(restarted.get(saved.id), completed);
  assert.deepEqual(await restarted.enqueue(submitted), completed);
  assert.deepEqual(await restarted.complete(completion), completed);
  assert.equal(await fs.readFile(file, 'utf8'), persisted);
  await assert.rejects(restarted.enqueue({ ...submitted, context: 'Different notes' }), conflict);
  await assert.rejects(restarted.complete({ ...completion, answer: 'Replace the answer' }), conflict);
  await assert.rejects(restarted.complete({ ...completion, revision: 2 }), conflict);
  assert.equal(restarted.status().count, 1); assert.equal(restarted.status().completed, 1);
});

test('mode-redirect completion errors preserve the pending request, revision, file, health and update events', async t => {
  const { file, store } = await fixture(t), pending = await store.enqueue(input());
  const persisted = await fs.readFile(file, 'utf8');
  let updates = 0; store.on('updated', () => updates++);
  const answer = 'Would you like me to hand this off to Work Mode?';
  await assert.rejects(store.complete({ id: pending.id, revision: pending.revision, answer }), cause => {
    assert.equal(cause.status, 422);
    assert.equal(cause.code, 'CHATGPT_BRIDGE_CHAT_MODE_REQUIRED');
    assert.match(cause.message, /Remain in Chat Mode/);
    assert.match(cause.message, /authorized connector/);
    assert.match(cause.message, /missing capability or blocker/);
    assert.match(cause.message, /to the user in Chat Mode and leave this request pending/);
    assert.match(cause.message, /Complete the request only with the requested result/);
    return true;
  });
  const toolResult = await dispatchChatGPTBridgeTool(store, 'blackice_complete_request', { id: pending.id, revision: 1, answer: 'Please switch to Work Mode to finish this.' });
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.structuredContent.code, 'CHATGPT_BRIDGE_CHAT_MODE_REQUIRED');
  assert.equal(toolResult.structuredContent.status, 422);
  assert.equal(Object.hasOwn(toolResult.structuredContent, 'request'), false, 'a rejected answer must never resemble a completion receipt');
  await assert.rejects(store.complete({ id: pending.id, revision: 2, answer }), conflict);
  await assert.rejects(store.complete({ id: randomUUID(), revision: 1, answer }), cause => cause.code === 'CHATGPT_BRIDGE_NOT_FOUND');
  assert.deepEqual(store.get(pending.id), pending);
  assert.equal(await fs.readFile(file, 'utf8'), persisted);
  assert.equal(store.status().healthy, true);
  assert.equal(store.status().pending, 1);
  assert.equal(updates, 0);
  const completed = await store.complete({ id: pending.id, revision: 1, answer: 'The requested explanation is complete. I used the authorized connector in Chat Mode.' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.revision, 2);
  assert.equal(updates, 1, 'only the later valid answer commits an update');
});

test('a mode comparison and quoted or negated instructions are stored exactly as authored', async t => {
  const { store } = await fixture(t);
  for (const answer of [
    'Work Mode and Chat Mode are different interfaces. Do not switch to Work Mode for this bridge request.',
    'Use Work Mode for tasks that need its tools. Use Chat Mode for this connector exchange.',
    'The interface said "Please switch to Work Mode." That is a quote, not a required step.\n\n```text\nWould you like me to hand this off to Work Mode?\n```\n\nSwitching to Work Mode is not necessary.',
  ]) {
    const pending = await store.enqueue(input(undefined, { prompt: 'Compare Chat Mode with Work Mode and explain their differences.' }));
    const completed = await store.complete({ id: pending.id, revision: 1, answer });
    assert.equal(completed.answer, answer, 'guard analysis cannot strip quotes, code or formatting from a saved answer');
  }
  assert.equal(store.status().completed, 3);
});

test('historical mode-redirect answers remain readable and exact terminal retries precede the new guard', async t => {
  const { directory, file, store } = await fixture(t), pending = await store.enqueue(input()); await store.close();
  const historical = { ...pending, status: 'completed', revision: 2, answer: 'Please switch to Work Mode.', completedAt: pending.updatedAt };
  await fs.writeFile(file, JSON.stringify({ version: 1, requests: [historical] }));
  const restarted = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => restarted.close());
  const persisted = await fs.readFile(file, 'utf8');
  assert.equal(restarted.status().healthy, true);
  assert.deepEqual(restarted.get(pending.id), historical);
  assert.deepEqual(await restarted.complete({ id: pending.id, revision: 1, answer: historical.answer }), historical);
  await assert.rejects(restarted.complete({ id: pending.id, revision: 2, answer: historical.answer }), conflict);
  await assert.rejects(restarted.complete({ id: pending.id, revision: 1, answer: 'Would you like to move to Work Mode?' }), conflict);
  assert.equal(await fs.readFile(file, 'utf8'), persisted);
});

test('concurrent retries create one request and a conflicting completion cannot replace the winner', async t => {
  const { store } = await fixture(t), submitted = input();
  const saved = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(submitted)));
  assert.equal(new Set(saved.map(record => record.id)).size, 1); assert.equal(store.status().count, 1);
  const id = saved[0].id, completion = { id, revision: 1, answer: 'First committed answer' };
  const results = await Promise.allSettled([store.complete(completion), store.complete(completion), store.complete({ ...completion, answer: 'Conflicting answer' })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'fulfilled'); assert.deepEqual(results[0].value, results[1].value);
  assert.equal(results[2].status, 'rejected'); assert.ok(conflict(results[2].reason));
  assert.equal(store.get(id).answer, completion.answer);
  const another = await store.enqueue(input()); assert.equal(another.status, 'pending');
});

test('cancellation persists, retries exactly, and blocks an answer arriving afterward', async t => {
  const { directory, file, store } = await fixture(t), saved = await store.enqueue(input());
  const results = await Promise.allSettled([store.cancel({ id: saved.id, revision: 1 }), store.complete({ id: saved.id, revision: 1, answer: 'Late answer' })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.ok(conflict(results[1].reason));
  const cancelled = results[0].value;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.revision, 2); assert.equal(Object.hasOwn(cancelled, 'answer'), false);
  const persisted = await fs.readFile(file, 'utf8');
  assert.deepEqual(await store.cancel({ id: saved.id, revision: 1 }), cancelled); assert.equal(await fs.readFile(file, 'utf8'), persisted);
  await store.close(); const restarted = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => restarted.close());
  await assert.rejects(restarted.complete({ id: saved.id, revision: 1, answer: 'Still late' }), conflict);
  assert.deepEqual(restarted.get(saved.id), cancelled); assert.equal(restarted.status().cancelled, 1);
  const completed = await restarted.complete({ id: (await restarted.enqueue(input())).id, revision: 1, answer: 'Saved first' });
  await assert.rejects(restarted.cancel({ id: completed.id, revision: completed.revision }), conflict);
});

test('positive integer revisions, exact fields, and text limits are enforced before writes', async t => {
  const { file, store } = await fixture(t), saved = await store.enqueue(input()), persisted = await fs.readFile(file, 'utf8');
  for (const revision of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(store.complete({ id: saved.id, revision, answer: 'No write' }), cause => cause.status === 400);
    await assert.rejects(store.cancel({ id: saved.id, revision }), cause => cause.status === 400);
  }
  await assert.rejects(store.complete({ id: saved.id, revision: 2, answer: 'Stale' }), conflict);
  for (const submitted of [null, [], input(undefined, { extra: true }), input(undefined, { context: {} }), input(undefined, { title: '' }), input(undefined, { prompt: '   ' }), input(undefined, { requestId: 'invalid id' }), input(undefined, { prompt: 'x'.repeat(CHATGPT_BRIDGE_LIMITS.promptChars + 1) }), input(undefined, { context: 'NUL\0data' })]) await assert.rejects(store.enqueue(submitted), cause => cause.status === 400);
  await assert.rejects(store.complete({ id: saved.id, revision: 1, answer: ' ' }), cause => cause.status === 400);
  await assert.rejects(store.complete({ id: saved.id, revision: 1, answer: 'x'.repeat(CHATGPT_BRIDGE_LIMITS.answerChars + 1) }), cause => cause.status === 400);
  await assert.rejects(store.cancel({ id: saved.id, revision: 1, answer: 'Unexpected' }), cause => cause.status === 400);
  for (const options of [{ status: 'processing' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: '1' }, { extra: true }]) assert.throws(() => store.list(options), cause => cause.status === 400);
  assert.equal(await fs.readFile(file, 'utf8'), persisted); assert.equal(store.status().healthy, true);
});

test('save failure preserves the original file, memory, client key, and permits a durable retry', async t => {
  let failSync = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), sync: () => failSync ? Promise.reject(Object.assign(new Error('Fixture storage is full'), { code: 'ENOSPC' })) : handle.sync() };
  } };
  const { file, directory, store } = await fixture(t, { io });
  const first = await store.enqueue(input()), persisted = await fs.readFile(file, 'utf8');
  let events = 0; store.on('updated', () => events++);
  failSync = true; const submitted = input();
  await assert.rejects(store.enqueue(submitted), cause => cause.code === 'CHATGPT_BRIDGE_STORAGE');
  await assert.rejects(store.complete({ id: first.id, revision: 1, answer: 'Not durable' }), cause => cause.code === 'CHATGPT_BRIDGE_STORAGE');
  assert.equal(events, 0); assert.equal(store.status().count, 1); assert.equal(store.get(first.id).status, 'pending');
  assert.equal(store.status().healthy, false); assert.equal(store.status().recoveryRequired, false);
  assert.equal(await fs.readFile(file, 'utf8'), persisted); assert.deepEqual(await fs.readdir(directory), ['chatgpt-bridge.json']);
  failSync = false;
  const retried = await store.enqueue(submitted); assert.equal(retried.status, 'pending'); assert.equal(store.status().healthy, true); assert.equal(events, 1);
  const completed = await store.complete({ id: first.id, revision: 1, answer: 'Now durable' });
  assert.equal(completed.answer, 'Now durable'); assert.equal(events, 2);
  assert.deepEqual(await store.enqueue(submitted), retried); assert.equal(events, 2);
});

test('successful receipt and update event wait for rename and a listener cannot invalidate a commit', async t => {
  let release, entered, holdRename = false;
  const reachedRename = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const io = { ...fs, rename: async (...args) => { if (holdRename) { entered(); await released; } return fs.rename(...args); } };
  const { directory, store } = await fixture(t, { io });
  holdRename = true; let finished = false, events = 0;
  store.on('updated', () => { events++; throw new Error('Fixture UI listener failed'); });
  const saving = store.enqueue(input()).then(record => { finished = true; return record; });
  await reachedRename;
  assert.equal(finished, false); assert.equal(events, 0); assert.equal(store.status().count, 0);
  release(); const saved = await saving; assert.equal(finished, true); assert.equal(events, 1); assert.equal(store.status().count, 1);
  const restarted = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => restarted.close());
  assert.deepEqual(restarted.get(saved.id), saved);
});

test('corrupt or contradictory history fails closed without replacing the file', async t => {
  const { directory, file, store } = await fixture(t), saved = await store.enqueue(input()); await store.close();
  const cases = [
    '{ invalid JSON',
    JSON.stringify({ version: 2, requests: [saved] }),
    JSON.stringify({ version: 1, requests: [{ ...saved, status: 'completed', revision: 2, completedAt: saved.updatedAt }] }),
    JSON.stringify({ version: 1, requests: [{ ...saved, status: 'cancelled', revision: 2, cancelledAt: saved.updatedAt, answer: 'Cannot have an answer' }] }),
    JSON.stringify({ version: 1, requests: [{ ...saved, revision: 0 }] }),
    JSON.stringify({ version: 1, requests: [{ ...saved, prompt: { unexpected: true } }] }),
    JSON.stringify({ version: 1, requests: [{ ...saved, updatedAt: 'invalid time' }] }),
    JSON.stringify({ version: 1, requests: [saved, { ...saved, id: randomUUID() }] }),
    JSON.stringify({ version: 1, requests: [saved, { ...saved, requestId: 'another-client' }] }),
  ];
  for (const contents of cases) {
    await fs.writeFile(file, contents); const broken = await new ChatGPTBridgeStore({ dataDir: directory }).init();
    assert.equal(broken.status().healthy, false); assert.equal(broken.status().recoveryRequired, true); assert.match(broken.status().error, /preserved/);
    assert.throws(() => broken.list(), cause => cause.status === 503);
    assert.throws(() => broken.get(saved.id), cause => cause.status === 503);
    await assert.rejects(broken.enqueue(input()), cause => cause.status === 503);
    await broken.close(); assert.equal(await fs.readFile(file, 'utf8'), contents);
  }
});

test('unexpected file replacement after initialization is preserved instead of silently overwritten', async t => {
  const { file, store } = await fixture(t), saved = await store.enqueue(input());
  const externallyEdited = JSON.stringify({ version: 1, requests: [{ ...saved, title: 'Changed elsewhere' }] });
  await fs.writeFile(file, externallyEdited);
  await assert.rejects(store.enqueue(input()), conflict);
  assert.equal(await fs.readFile(file, 'utf8'), externallyEdited); assert.equal(store.status().recoveryRequired, true);
  assert.throws(() => store.get(saved.id), cause => cause.status === 503);
});

test('a full history rejects new work without eviction and still accepts existing answers', async t => {
  const { directory, file, store } = await fixture(t), saved = await store.enqueue(input()); await store.close();
  const records = Array.from({ length: CHATGPT_BRIDGE_LIMITS.requests }, (_, index) => ({ ...saved, id: randomUUID(), requestId: `capacity-${index}` }));
  await fs.writeFile(file, JSON.stringify({ version: 1, requests: records }));
  const full = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => full.close());
  const persisted = await fs.readFile(file, 'utf8');
  await assert.rejects(full.enqueue(input()), cause => cause.status === 507 && cause.code === 'CHATGPT_BRIDGE_CAPACITY');
  assert.equal(await fs.readFile(file, 'utf8'), persisted); assert.equal(full.status().count, CHATGPT_BRIDGE_LIMITS.requests);
  const completed = await full.complete({ id: records[0].id, revision: 1, answer: 'Completing existing work remains possible.' });
  assert.equal(completed.status, 'completed'); assert.equal(full.status().count, CHATGPT_BRIDGE_LIMITS.requests);
  assert.equal(full.get(records.at(-1).id).status, 'pending');
  await full.close();
  const oversized = await fs.open(file, 'r+'); try { await oversized.truncate(CHATGPT_BRIDGE_LIMITS.storageBytes + 1); } finally { await oversized.close(); }
  const blocked = await new ChatGPTBridgeStore({ dataDir: directory }).init(); t.after(() => blocked.close());
  assert.equal(blocked.status().recoveryRequired, true); assert.match(blocked.status().error, /storage limit/);
  await assert.rejects(blocked.enqueue(input()), cause => cause.status === 503);
  assert.equal((await fs.stat(file)).size, CHATGPT_BRIDGE_LIMITS.storageBytes + 1);
});

test('pagination preserves retained history and close drains already accepted writes', async t => {
  const { file, store } = await fixture(t);
  const one = await store.enqueue(input()), two = await store.enqueue(input()), three = await store.enqueue(input());
  await store.complete({ id: two.id, revision: 1, answer: 'Saved answer' }); await store.cancel({ id: three.id, revision: 1 });
  assert.deepEqual(store.list().items.map(record => record.id), [one.id]);
  const first = store.list({ status: 'all', limit: 2 });
  assert.deepEqual(first.items.map(record => record.id), [one.id, two.id]); assert.equal(first.total, 3); assert.equal(first.nextOffset, 2);
  assert.deepEqual(store.list({ status: 'all', offset: 2, limit: 2 }).items.map(record => record.id), [three.id]);
  const queued = store.enqueue(input()); await store.close(); const saved = await queued;
  assert.ok(JSON.parse(await fs.readFile(file, 'utf8')).requests.some(record => record.id === saved.id));
  await assert.rejects(store.enqueue(input()), cause => cause.code === 'CHATGPT_BRIDGE_CLOSED');
});

test('narrow MCP tools validate arguments, annotate side effects, and return structured durable receipts', async t => {
  const { file, store } = await fixture(t), saved = await store.enqueue(input());
  assert.deepEqual(CHATGPT_BRIDGE_TOOLS.map(tool => tool.name), ['blackice_bridge_status', 'blackice_list_requests', 'blackice_get_request', 'blackice_complete_request']);
  for (const tool of CHATGPT_BRIDGE_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'blackice_complete_request'); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const originalFile = await fs.readFile(file, 'utf8');
  for (const [name, args] of [['blackice_bridge_status', {}], ['blackice_list_requests', {}], ['blackice_get_request', { id: saved.id }]]) {
    const result = await dispatchChatGPTBridgeTool(store, name, args);
    assert.equal(result.isError, undefined); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.equal(store.get(saved.id).status, 'pending'); assert.equal(await fs.readFile(file, 'utf8'), originalFile);
  for (const [name, args] of [['blackice_bridge_status', { extra: true }], ['blackice_get_request', {}], ['blackice_list_requests', { limit: '20' }], ['blackice_complete_request', { id: saved.id, revision: '1', answer: 'Invalid' }], ['blackice_complete_request', { id: saved.id, revision: 1, answer: 'Valid text', execute: true }], ['blackice_list_requests', null], ['blackice_run_code', {}]]) {
    const result = await dispatchChatGPTBridgeTool(store, name, args); assert.equal(result.isError, true); assert.ok(result.structuredContent.error);
  }
  const result = await dispatchChatGPTBridgeTool(store, 'blackice_complete_request', { id: saved.id, revision: 1, answer: 'Answer returned through ChatGPT tools.' });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.request.status, 'completed');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8')).requests[0]; assert.deepEqual(result.structuredContent.request, persisted);
});
