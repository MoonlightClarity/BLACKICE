import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';
import { assistantMessages, mergeConversationRuns } from '../public/conversation-model.mjs';

class Engine extends EventEmitter {
  runs = new Map();
  listRuns() { return [...this.runs.values()].map(run => structuredClone(run)); }
  getRun(id) { if (!this.runs.has(id)) throw new Error('Run not found.'); return structuredClone(this.runs.get(id)); }
  record(run, data, at) { const event = { type: 'agent.event', runId: run.id, nodeId: 'agent', at, data }; run.events.push(event); if (run.events.length > 2500) run.events.shift(); this.emit('event', event); }
}
const turn = (id = 'root', parentRunId = null) => ({ id, parentRunId, taskId: parentRunId ? 'root' : undefined, input: parentRunId ? 'Continue this actual task.' : 'Finish the original task.', createdAt: '2026-10-16T12:00:00Z', status: 'running', settled: false, workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Agent' }] }, nodes: { agent: { status: 'running', threadId: 'actual-saved-thread', output: '' } }, output: '', events: [] });
async function setup(t, engine = new Engine()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-conversation-retention-')), archives = [], archive = await new ConversationArchive({ dataDir, engine }).init(); archives.push(archive);
  t.after(async () => { for (const value of archives) await value.close(); assert.match(path.basename(dataDir), /^relay-conversation-retention-/); await rm(dataDir, { recursive: true, force: true }); }); return { dataDir, engine, archive, archives };
}
const visible = run => assistantMessages(run).map(message => ({ role: message.role, text: message.text }));

test('actual early messages and directions survive2600 tool events, live reads, eviction and restart', async t => {
  const engine = new Engine(), run = turn(); engine.runs.set(run.id, run); const { archive, dataDir, archives } = await setup(t, engine);
  engine.record(run, { type: 'message', itemId: 'early', text: 'EARLY_VISIBLE_MESSAGE', phase: 'commentary' }, '2026-10-16T12:00:01Z');
  engine.record(run, { type: 'steer', text: 'ACCEPTED_USER_DIRECTION', accepted: true, threadId: 'actual-saved-thread', turnId: 'actual-turn' }, '2026-10-16T12:00:02Z');
  for (let index = 0; index < 2600; index++) engine.record(run, { type: 'item', item: { type: 'commandExecution', id: 'tool-' + index, status: 'completed', command: 'bounded fixture action' } }, '2026-10-16T12:00:03Z');
  assert.ok(!run.events.some(event => event.data.type === 'message' || event.data.type === 'steer'), 'the execution ring has actually evicted both early receipts');
  engine.record(run, { type: 'message', itemId: 'final', text: 'FINAL_VISIBLE_MESSAGE', phase: 'final_answer' }, '2026-10-16T12:00:04Z'); run.nodes.agent.output = 'FINAL_VISIBLE_MESSAGE'; run.nodes.agent.status = 'completed'; run.output = 'FINAL_VISIBLE_MESSAGE'; run.status = 'completed'; run.settled = true;
  engine.emit('event', { type: 'run.updated', data: structuredClone(run) }); await archive.chain;
  const expected = [{ role: 'assistant', text: 'EARLY_VISIBLE_MESSAGE' }, { role: 'user', text: 'ACCEPTED_USER_DIRECTION' }, { role: 'assistant', text: 'FINAL_VISIBLE_MESSAGE' }];
  assert.deepEqual(visible(await archive.get(run.id)), expected, 'live reads must merge the durable receipts with the bounded execution snapshot');
  const liveFamily = await archive.family(run.id); assert.deepEqual(visible(liveFamily.runs[0]), expected);
  engine.runs.clear(); const archived = await archive.get(run.id); assert.deepEqual(visible(archived), expected); assert.equal(archived.nodes.agent.threadId, 'actual-saved-thread'); assert.equal(archived.events.filter(event => event.data.type === 'message').length, 2); assert.equal(archived.events.filter(event => event.data.type === 'steer').length, 1); assert.ok(!archived.events.some(event => event.data.item?.type === 'commandExecution'));
  await archive.close();
  const restoredEngine = new Engine(); restoredEngine.runs.set(run.id, structuredClone(run)); const restored = await new ConversationArchive({ dataDir, engine: restoredEngine }).init(); archives.push(restored);
  assert.deepEqual(visible(await restored.get(run.id)), expected, 'preloading must preserve archived receipts when recent history contains only the bounded ring');
  restoredEngine.runs.clear(); assert.deepEqual(visible(await restored.get(run.id)), expected); assert.deepEqual(visible((await restored.family(run.id)).runs[0]), expected);
});

test('conversation merges preserve durable receipts without duplicating streamed final messages', () => {
  const cached = turn(), live = turn(); cached.status = live.status = 'completed'; cached.nodes.agent.status = live.nodes.agent.status = 'completed'; cached.nodes.agent.output = live.nodes.agent.output = 'Final answer.';
  cached.events = [{ type: 'agent.event', nodeId: 'agent', at: '2026-10-16T12:00:01Z', data: { type: 'message', itemId: 'early', text: 'Earlier progress.' } }, { type: 'agent.event', nodeId: 'agent', at: '2026-10-16T12:00:02Z', data: { type: 'message', itemId: 'final', text: 'Final answer.', phase: 'final_answer' } }];
  live.events = [structuredClone(cached.events[1])]; const merged = mergeConversationRuns([cached], [live]);
  assert.deepEqual(visible(merged[0]), [{ role: 'assistant', text: 'Earlier progress.' }, { role: 'assistant', text: 'Final answer.' }]); assert.equal(merged[0].events.filter(event => event.data?.itemId === 'final').length, 1);
});

test('legacy parent links form one archive conversation and damaged omitted history is disclosed', async t => {
  const { archive, dataDir, archives } = await setup(t); const root = turn(), child = turn('child', 'root'); delete root.taskId; delete child.taskId;
  for (const value of [root, child]) { value.status = 'completed'; value.settled = true; value.nodes.agent.status = 'completed'; value.nodes.agent.output = value.id; await archive.capture(value); }
  assert.equal(archive.list().length, 1); assert.equal(archive.list()[0].taskId, 'root'); assert.equal((await archive.family('child')).runs.length, 2); await archive.close();
  await writeFile(path.join(dataDir, 'conversations', 'root.json'), '{corrupt fixture'); const restored = await new ConversationArchive({ dataDir, engine: new Engine() }).init(); archives.push(restored); assert.equal(restored.status().healthy, false); assert.equal((await restored.family('child')).truncated, true);
});
