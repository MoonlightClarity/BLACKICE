import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { chatTimeline, projectPlanningActivity } from '../public/next/chat/planning-timeline.mjs';
import { planningReturnRun } from './fixtures/planning-return-records.mjs';

class Engine extends EventEmitter {
  runs = new Map();
  listRuns() { return [...this.runs.values()]; }
  getRun(id) { if (!this.runs.has(id)) throw Error('Run not found.'); return structuredClone(this.runs.get(id)); }
}
const phases = run => { const projected = projectFamily({ runs: [run] }).runs[0]; return chatTimeline(projected, projected.precomputedMessages).map(group => group.phase); };
async function fixture(t, run = planningReturnRun()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-archive-')), engine = new Engine(), archives = [];
  engine.runs.set(run.id, run);
  const archive = await new ConversationArchive({ dataDir: directory, engine }).init(); archives.push(archive);
  t.after(async () => { for (const item of archives) await item.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, engine, run, archive, async reopen() { await archive.close(); engine.runs.clear(); const reopened = await new ConversationArchive({ dataDir: directory, engine: new Engine() }).init(); archives.push(reopened); return reopened; } };
}

test('the public planning cycle survives archive eviction and restart with one final and no full trace', async t => {
  const f = await fixture(t), expected = ['plan', 'think', 'plan', 'think', 'respond'];
  f.run.events.splice(2, 0, { type: 'agent.event', runId: f.run.id, nodeId: 'agent', at: '2026-10-29T12:00:02.500Z', data: { type: 'item', item: { type: 'reasoning', text: 'PRIVATE_PROVIDER_REASONING' } } });
  await f.archive.capture(f.run);
  assert.deepEqual(phases(await f.archive.get(f.run.id)), expected);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'conversations', f.run.id + '.json'), 'utf8'));
  assert.ok(saved.planningActivity.some(row => row.source === 'plan'));
  assert.ok(saved.planningActivity.some(row => row.source === 'observation'));
  assert.ok(saved.planningActivity.some(row => row.source === 'review'));
  assert.equal(saved.events.some(event => ['task.state', 'planning.reassessment'].includes(event.data.type)), false);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROVIDER_REASONING/);
  const reopened = await f.reopen(), read = await reopened.get(f.run.id);
  assert.deepEqual(phases(read), expected);
  const projected = projectFamily({ runs: [read] }).runs[0];
  assert.equal(projected.precomputedMessages.filter(message => message.phase === 'final_answer').length, 1);
  assert.deepEqual(projected.events, []);
});

test('same-millisecond public receipts retain actual order after the archive compacts messages', async t => {
  const run = planningReturnRun(), at = '2026-10-29T12:00:01.000Z';
  for (const event of run.events) { event.at = at; if (event.data.state) { event.data.state.updatedAt = at; for (const review of event.data.state.planningReviews) review.at = at; } }
  run.taskState.planningReviews[0].at = at;
  const f = await fixture(t, run), expected = ['plan', 'think', 'plan', 'think', 'respond'];
  assert.deepEqual(phases(await f.archive.get(run.id)), expected, 'live archive merge must not collapse distinct task revisions sharing a timestamp');
  const reopened = await f.reopen(), read = await reopened.get(run.id);
  assert.deepEqual(phases(read), expected);
  assert.deepEqual(read.events.map(event => event.timelineOrder), [1, 4, 6, 7]);
});

test('quiet saved planning events are archived before a rolling execution window discards earlier snapshots', async t => {
  const full = planningReturnRun(), run = { ...full, status: 'running', settled: false, output: '', nodes: { agent: { status: 'running' } }, taskState: null, events: [] };
  const f = await fixture(t, run);
  for (const event of full.events) {
    run.events = [event]; // The execution trace no longer contains its predecessor.
    if (event.data.type === 'task.state') run.taskState = event.data.state;
    f.engine.emit('event', event); await f.archive.chain;
  }
  run.status = 'completed'; run.settled = true; run.output = full.output; run.nodes = full.nodes;
  await f.archive.capture(run);
  const reopened = await f.reopen(), saved = await reopened.get(run.id);
  assert.deepEqual(phases(saved), ['plan', 'think', 'plan', 'think', 'respond']);
  assert.equal(saved.planningActivity.filter(row => row.source === 'plan').length, 1, 'a later review snapshot cannot masquerade as a new initial plan');
  assert.equal(saved.planningActivity.filter(row => row.source === 'observation').length, 1);
});

test('real schema10 plan, finding, review and final-message start records survive reopening', async t => {
  const base = planningReturnRun(), run = { ...base, id: 'schema10-records', taskId: 'schema10-records', events: [], taskState: null, output: '', status: 'running', settled: false, nodes: { agent: { status: 'running' } } };
  const f = await fixture(t, run), store = await new TaskStateStore({ dataDir: f.directory }).init();
  t.after(() => store.close());
  await store.ensure({ taskId: run.taskId, runId: run.id, nodeId: 'agent', cwd: f.directory, goal: 'Check the supplied $32 price plus $9 fee.', defaultPlan: true });
  const emit = data => { const event = { type: 'agent.event', runId: run.id, nodeId: 'agent', at: new Date().toISOString(), data }; run.events.push(event); if (data.type === 'task.state') run.taskState = data.state; f.engine.emit('event', event); return event; };
  const handler = createTaskToolHandler({ store, taskId: run.taskId, runId: run.id, nodeId: 'agent', planningMode: 'on', onEvent: emit });
  const write = async args => { const state = await store.get(run.taskId), result = await handler({ name: 'relay_task', arguments: { ...args, expectedRevision: state.revision } }); assert.equal(result.success, true, result.contentItems[0].text); return JSON.parse(result.contentItems[0].text); };
  await write({ action: 'plan', plan: { layout: 'sequence' }, steps: [{ id: 'add', kind: 'action', status: 'active', title: 'Add the supplied price and delivery fee', operation: { kind: 'reasoning', target: 'The supplied $32 price and $9 delivery fee.' }, note: 'Add the two stated amounts and record the sum.', result: 'The checked total.', doneWhen: 'Both amounts are included in the saved sum.' }] });
  await write({ action: 'step', stepId: 'add', status: 'done', evidence: '$32 + $9 = $41.' });
  const reviewed = await write({ action: 'review', review: { decision: 'respond', summary: 'The arithmetic includes both the stated price and delivery fee.' } });
  // The response-start receipt itself supplies the public composition boundary.
  // Waiting for a distinct millisecond exercises its strictly-after-review rule.
  while (Date.now() <= Date.parse(reviewed.planningReviews.at(-1).at)) await new Promise(resolve => setTimeout(resolve, 1));
  emit({ type: 'item', stage: 'started', item: { id: 'actual-final-start', type: 'agentMessage', phase: 'final_answer', text: '' } });
  emit({ type: 'message', itemId: 'actual-final-start', phase: 'final_answer', text: 'The total is $41.' });
  run.status = 'completed'; run.settled = true; run.output = 'The total is $41.'; run.nodes.agent = { status: 'completed', output: run.output };
  await f.archive.capture(run);
  const reopened = await f.reopen(), saved = await reopened.get(run.id);
  assert.deepEqual(phases(saved), ['plan', 'think', 'plan', 'think', 'respond']);
  assert.deepEqual(saved.planningActivity.map(row => row.source), ['plan', 'observation', 'review', 'composition']);
  assert.equal(saved.planningActivity.find(row => row.source === 'composition').text, 'Preparing the response from the reviewed findings.');
  assert.equal(saved.planningActivity.find(row => row.source === 'review').revision, reviewed.planningReviews.at(-1).reviewedRevision);
});

test('upgrading an owned legacy archive backfills its initial plan and finding from actual execution history', async t => {
  for (const partialCursor of [false, true]) await t.test(partialCursor ? 'an older cursor does not cover the latest outline' : 'legacy archive has no activity cursor', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-upgrade-')), engine = new Engine(), full = planningReturnRun({ composition: true }), legacy = structuredClone(full), archives = [];
    legacy.events = legacy.events.filter(event => event.data.type === 'message' || event.data.item?.type === 'agentMessage');
    if (partialCursor) { legacy.planningActivity = projectPlanningActivity(legacy); legacy.planningActivityRevision = legacy.taskState.revision - 1; }
    const folder = path.join(directory, 'conversations'), file = path.join(folder, full.id + '.json');
    await mkdir(folder); await writeFile(file, JSON.stringify(legacy)); engine.runs.set(full.id, full);
    t.after(async () => { for (const archive of archives) await archive.close(); await rm(directory, { recursive: true, force: true }); });
    const upgraded = await new ConversationArchive({ dataDir: directory, engine }).init(); archives.push(upgraded);
    const live = await upgraded.get(full.id), saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(phases(live), ['plan', 'think', 'plan', 'think', 'respond']);
    assert.deepEqual(saved.planningActivity.map(row => row.source), ['plan', 'observation', 'review', 'composition']);
    assert.equal(saved.planningActivity.find(row => row.source === 'plan').at, full.events[0].at);
    assert.equal(saved.planningActivity.find(row => row.source === 'observation').at, full.events[2].at);
    assert.equal(saved.planningActivityRevision, full.taskState.revision);
    await upgraded.close(); engine.runs.clear();
    const reopened = await new ConversationArchive({ dataDir: directory, engine: new Engine() }).init(); archives.push(reopened);
    assert.deepEqual(phases(await reopened.get(full.id)), ['plan', 'think', 'plan', 'think', 'respond']);
  });
});

test('an evicted legacy archive reports only surviving receipts and cannot invent its missing initial plan or findings', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-legacy-')), run = planningReturnRun({ composition: true });
  run.events = run.events.filter(event => event.data.type === 'message' || event.data.item?.type === 'agentMessage');
  const folder = path.join(directory, 'conversations'), file = path.join(folder, run.id + '.json');
  await mkdir(folder); const original = JSON.stringify(run); await writeFile(file, original);
  const archive = await new ConversationArchive({ dataDir: directory, engine: new Engine() }).init();
  t.after(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = await archive.get(run.id), rows = projectFamily({ runs: [saved] }).runs[0].planningActivity;
  assert.deepEqual(rows.map(row => row.source), ['review', 'composition']);
  assert.deepEqual(phases(saved), ['think', 'plan', 'think', 'respond']);
  assert.equal(await readFile(file, 'utf8'), original, 'a read does not rewrite or fabricate historical source records');
});
