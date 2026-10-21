import test from 'node:test';
import {selectStartupRun,workspaceActivity} from '../public/run-state-model.mjs';
import assert from 'node:assert/strict';

test('startup restores the selected conversation before unrelated active work',()=>{
  const working={id:'working',status:'running'},selected={id:'selected',status:'completed'};
  assert.equal(selectStartupRun([working,selected],'selected'),selected);
  assert.equal(selectStartupRun([selected,working],'missing'),working);
  assert.equal(selectStartupRun([selected],null),selected);
  assert.equal(selectStartupRun([],null),null);
});
import { reduceRunEvent, reduceRunCollection, runsWithCurrent, adoptFetchedRun, mergeRunSnapshots, newerTaskState } from '../public/run-state-model.mjs';
import { assistantMessages, conversationAgents, conversationRuns } from '../public/conversation-model.mjs';

test('workspace activity stays stopping or finishing until admitted work settles', () => {
  const stopped = {id:'stopped',status:'cancelled',settled:false};
  assert.equal(workspaceActivity({runs:[stopped]}).label, 'Stopping…');
  assert.equal(workspaceActivity({currentRun:stopped}).label, 'Stopping…');
  assert.equal(workspaceActivity({execution:{stopping:true,activeRunCount:1}}).label, 'Stopping…');
  assert.equal(workspaceActivity({runs:[{...stopped,status:'failed'}]}).label, 'Finishing…');
  assert.equal(workspaceActivity({runs:[{...stopped,settled:true}],execution:{settling:true}}).label, 'Finishing…');
  assert.equal(workspaceActivity({runs:[{...stopped,settled:true}],execution:{activeRunCount:0,stopping:false,settling:false}}), null);
});

test('workspace activity preserves independent working tasks while one task stops', () => {
  const value = workspaceActivity({runs:[{id:'a',status:'cancelled',settled:false},{id:'b',status:'running',settled:false}],execution:{stopping:true,activeRunCount:2}});
  assert.equal(value.label, 'Working');
  assert.match(value.title, /stopped task is still finishing/);
  assert.equal(workspaceActivity({execution:{activeRunCount:1}}).label, 'Working');
  assert.equal(workspaceActivity({runs:[{id:'old',status:'failed',settled:true}]}), null);
});

const run = () => ({ id: 'live-run', status: 'running', workflow: { nodes: [{ id: 'agent', type: 'agent' }] }, nodes: { agent: { status: 'running', output: '' } }, events: [] });
const agentEvent = data => ({ type: 'agent.event', runId: 'live-run', nodeId: 'agent', at: '2026-10-16T15:20:01Z', data });

test('delayed thread and turn startup enables live direction without another node update or refresh', () => {
  const initial = run();
  let live = reduceRunEvent(initial, { type: 'node.updated', runId: initial.id, nodeId: 'agent', data: { status: 'running' } });
  assert.deepEqual(conversationAgents(live, 'steer'), []);
  live = reduceRunEvent(live, agentEvent({ type: 'thread', threadId: 'actual-thread', turnId: null, model: 'actual-model' }));
  assert.deepEqual(conversationAgents(live, 'steer'), []);
  live = reduceRunEvent(live, agentEvent({ type: 'turn', threadId: 'actual-thread', turnId: 'actual-turn', status: 'inProgress' }));
  assert.deepEqual(conversationAgents(live, 'steer').map(node => node.id), ['agent']);
  assert.equal(live.nodes.agent.threadId, 'actual-thread');
  assert.equal(live.nodes.agent.turnId, 'actual-turn');
  assert.equal(live.nodes.agent.resolvedModel, 'actual-model');
  assert.equal(live.nodes.agent.status, 'running');
  assert.equal(initial.nodes.agent.threadId, undefined);
  assert.equal(initial.events.length, 0);
});

test('thread receipts retain verified history visibility without letting another chat or unknown values overwrite it',()=>{
  const original=run();let live=reduceRunEvent(original,agentEvent({type:'thread',threadId:'private-thread',model:'native',codexHistory:'relay'}));
  assert.equal(live.nodes.agent.codexHistory,'relay');assert.equal(original.nodes.agent.codexHistory,undefined);
  for(const codexHistory of [undefined,null,'private',true])live=reduceRunEvent(live,agentEvent({type:'thread',codexHistory}));assert.equal(live.nodes.agent.codexHistory,'relay');
  assert.strictEqual(reduceRunEvent(live,{...agentEvent({type:'thread',codexHistory:'codex'}),runId:'other'}),live);
  live=reduceRunEvent(live,agentEvent({type:'thread',threadId:'visible-thread',codexHistory:'codex'}));assert.equal(live.nodes.agent.codexHistory,'codex');
});

test('actual metadata carried by a delta also unlocks direction, while absent IDs never create a target', () => {
  let live = reduceRunEvent(run(), agentEvent({ type: 'delta', delta: 'Real progress.' }));
  assert.deepEqual(conversationAgents(live, 'steer'), []);
  assert.equal(live.nodes.agent.threadId, undefined);
  live = reduceRunEvent(live, agentEvent({ type: 'delta', delta: ' More progress.', threadId: 'provider_thread', turnId: 'provider_turn' }));
  assert.deepEqual(conversationAgents(live, 'steer').map(node => node.id), ['agent']);
  assert.equal(live.nodes.agent.output, 'Real progress. More progress.');
  live = reduceRunEvent(live, agentEvent({ type: 'usage', threadId: '', turnId: null, usage: { totalTokens: 5 } }));
  assert.equal(live.nodes.agent.threadId, 'provider_thread');
  assert.equal(live.nodes.agent.turnId, 'provider_turn');
});

test('another run cannot alter the selected run and an unknown node cannot invent an agent', () => {
  const selected = run();
  assert.strictEqual(reduceRunEvent(selected, { ...agentEvent({ type: 'thread', threadId: 'other-thread' }), runId: 'different-run' }), selected);
  const unknown = reduceRunEvent(selected, { ...agentEvent({ type: 'thread', threadId: 'unknown-thread', turnId: 'unknown-turn' }), nodeId: 'missing' });
  assert.equal(unknown.nodes.missing, undefined);
  assert.equal(unknown.nodes.agent.threadId, undefined);
  assert.deepEqual(conversationAgents(unknown, 'steer'), []);
});

test('terminal and cancelling turn receipts stop live direction without inventing a node status', () => {
  const live = reduceRunEvent(run(), agentEvent({ type: 'turn', threadId: 'thread', turnId: 'turn', status: 'inProgress' }));
  for (const status of ['completed', 'failed', 'interrupted', 'cancelled', 'cancelling']) {
    const stopped = reduceRunEvent(live, agentEvent({ type: 'turn', threadId: 'thread', turnId: 'turn', status }));
    assert.deepEqual(conversationAgents(stopped, 'steer'), []);
    assert.equal(stopped.nodes.agent.status, 'running');
    assert.equal(stopped.nodes.agent.turnId, 'turn');
  }
  const cancelled = reduceRunEvent(live, { type: 'node.updated', runId: live.id, nodeId: 'agent', data: { status: 'cancelled' } });
  const receipt = reduceRunEvent(cancelled, agentEvent({ type: 'usage', threadId: 'thread', turnId: 'turn', usage: { totalTokens: 12 } }));
  assert.equal(receipt.nodes.agent.status, 'cancelled');
  assert.deepEqual(conversationAgents(receipt, 'steer'), []);
  assert.equal(receipt.nodes.agent.usage.totalTokens, 12);
});

test('context, usage and task state receipts retain actual streamed values', () => {
  let live = { ...run(), usage: { totalTokens: 1 } };
  const context = { usedTokens: 12 }, usage = { totalTokens: 12 }, taskState = { taskId: live.id, revision: 3, steps: [] };
  live = reduceRunEvent(live, agentEvent({ type: 'context', context }));
  live = reduceRunEvent(live, agentEvent({ type: 'usage', usage }));
  live = reduceRunEvent(live, agentEvent({ type: 'task.state', state: taskState }));
  assert.deepEqual(live.nodes.agent.contextStatus, context);
  assert.deepEqual(live.nodes.agent.usage, usage);
  assert.equal(Object.hasOwn(live, 'usage'), false);
  assert.deepEqual(live.taskState, taskState);
  assert.equal(live.events.length, 3);
});

test('a selected live snapshot replaces its stale list entry for all conversation consumers', () => {
  const stale = run(), other = { id: 'other', status: 'completed' }, listed = [other, stale];
  const current = reduceRunEvent(stale, agentEvent({ type: 'turn', threadId: 'thread', turnId: 'turn', status: 'inProgress' }));
  const snapshot = runsWithCurrent(listed, current);
  assert.deepEqual(snapshot.map(item => item.id), ['other', 'live-run']);
  assert.strictEqual(snapshot[1], current);
  const family = conversationRuns(snapshot, current);
  assert.deepEqual(conversationAgents(family[0], 'steer').map(node => node.id), ['agent']);
  assert.strictEqual(listed[1], stale);
  assert.equal(stale.nodes.agent.threadId, undefined);
  assert.strictEqual(runsWithCurrent(listed, null), listed);
  assert.strictEqual(runsWithCurrent([], current)[0], current);
});

const collectionRun = (id, output = '') => ({ ...run(), id, nodes: { agent: { status: 'running', output } } });
const routed = (runId, data, at = '2026-10-16T16:00:01Z') => ({ type: 'agent.event', runId, nodeId: 'agent', data, at });

test('interleaved live receipts stay with their own chat even when agent and message IDs are identical', () => {
  const a = collectionRun('a'), b = collectionRun('b'); let state = { runs: [a, b], currentRun: b };
  state = reduceRunCollection(state, routed('a', { type: 'delta', itemId: 'same-message', delta: 'A first.' }));
  assert.strictEqual(state.currentRun, b, 'background activity must not change the selected snapshot');
  state = reduceRunCollection(state, routed('b', { type: 'delta', itemId: 'same-message', delta: 'B first.' }));
  state = reduceRunCollection(state, routed('a', { type: 'delta', itemId: 'same-message', delta: ' A second.' }, '2026-10-16T16:00:02Z'));
  state = reduceRunCollection(state, routed('b', { type: 'message', itemId: 'same-message', text: 'B final answer.', phase: 'final_answer' }, '2026-10-16T16:00:03Z'));
  state = reduceRunCollection(state, { type: 'node.updated', runId: 'a', nodeId: 'agent', data: { status: 'failed', error: 'Only A failed.' }, at: '2026-10-16T16:00:04Z' });
  state = reduceRunCollection(state, { type: 'node.updated', runId: 'b', nodeId: 'agent', data: { status: 'completed', output: 'B final answer.' }, at: '2026-10-16T16:00:05Z' });
  const [updatedA, updatedB] = state.runs;
  assert.deepEqual(state.runs.map(run => run.id), ['a', 'b']); assert.equal(state.known, true); assert.strictEqual(state.currentRun, updatedB);
  assert.equal(updatedA.nodes.agent.output, 'A first. A second.'); assert.equal(updatedA.nodes.agent.status, 'failed'); assert.equal(updatedA.nodes.agent.error, 'Only A failed.');
  assert.equal(updatedB.nodes.agent.output, 'B final answer.'); assert.equal(updatedB.nodes.agent.status, 'completed'); assert.equal(updatedB.nodes.agent.error, undefined);
  assert.deepEqual(assistantMessages(updatedA).map(message => message.text), ['A first. A second.']); assert.deepEqual(assistantMessages(updatedB).map(message => message.text), ['B final answer.']);
  assert.equal(updatedA.events.length, 3); assert.equal(updatedB.events.length, 3); assert.equal(a.events.length, 0); assert.equal(b.events.length, 0); assert.equal(a.nodes.agent.output, '');
});

test('streaming into the selected chat uses its newer snapshot instead of an older list response', () => {
  const other = collectionRun('other'), stale = collectionRun('selected', 'Old ');
  const current = reduceRunEvent(collectionRun('selected', 'Fresh '), routed('selected', { type: 'thread', threadId: 'new-thread', model: 'chosen-model' }));
  const initial = { runs: [other, stale], currentRun: current };
  const next = reduceRunCollection(initial, routed('selected', { type: 'delta', delta: 'receipt.' }));
  assert.deepEqual(next.runs.map(run => run.id), ['other', 'selected']); assert.strictEqual(next.runs[0], other); assert.strictEqual(next.runs[1], next.currentRun);
  assert.equal(next.currentRun.nodes.agent.output, 'Fresh receipt.'); assert.equal(next.currentRun.nodes.agent.threadId, 'new-thread'); assert.equal(next.currentRun.nodes.agent.resolvedModel, 'chosen-model');
  assert.equal(next.currentRun.events.length, 2); assert.equal(stale.nodes.agent.output, 'Old '); assert.equal(current.nodes.agent.output, 'Fresh ');
});

test('a background chat update preserves the selected live snapshot and its position', () => {
  const background = collectionRun('background'), stale = collectionRun('selected', 'stale');
  const current = collectionRun('selected', 'newer selected content');
  const next = reduceRunCollection({ runs: [background, stale], currentRun: current }, routed('background', { type: 'context', context: { actualInputTokens: 123 } }));
  assert.strictEqual(next.currentRun, current); assert.strictEqual(next.runs[1], current); assert.equal(next.runs[0].nodes.agent.contextStatus.actualInputTokens, 123);
  assert.equal(next.currentRun.nodes.agent.contextStatus, undefined); assert.equal(background.nodes.agent.contextStatus, undefined);
});

test('a selected run missing from the list is appended without reordering other chats', () => {
  const first = collectionRun('first'), second = collectionRun('second'), current = collectionRun('selected');
  const next = reduceRunCollection({ runs: [first, second], currentRun: current }, routed('selected', { type: 'usage', usage: { totalTokens: 15 } }));
  assert.deepEqual(next.runs.map(run => run.id), ['first', 'second', 'selected']); assert.strictEqual(next.runs[0], first); assert.strictEqual(next.runs[1], second); assert.strictEqual(next.runs[2], next.currentRun);
  assert.equal(next.currentRun.nodes.agent.usage.totalTokens, 15); assert.equal(current.nodes.agent.usage, undefined);
});

test('unknown or unscoped events cannot invent runs or change the selected conversation', () => {
  const listed = collectionRun('listed'), current = collectionRun('selected'), initial = { runs: [listed], currentRun: current };
  for (const event of [routed('unknown', { type: 'delta', delta: 'Unverified output.' }), { type: 'runtime.status', data: {} }, null]) {
    const next = reduceRunCollection(initial, event);
    assert.equal(next.known, false); assert.strictEqual(next.currentRun, current); assert.deepEqual(next.runs.map(run => run.id), ['listed', 'selected']); assert.strictEqual(next.runs[0], listed); assert.strictEqual(next.runs[1], current);
    assert.equal(next.runs.some(run => run.id === 'unknown'), false); assert.equal(listed.events.length, 0); assert.equal(current.events.length, 0);
  }
  assert.deepEqual(reduceRunCollection({}, routed('unknown', { type: 'delta', delta: 'No run.' })), { runs: [], currentRun: undefined, known: false });
});

test('thread startup, usage and terminal errors remain isolated across concurrent agents', () => {
  let state = { runs: [collectionRun('a'), collectionRun('b')], currentRun: null };
  state = reduceRunCollection(state, routed('a', { type: 'thread', threadId: 'thread-a', turnId: 'turn-a', model: 'provider-a::model' }));
  state = reduceRunCollection(state, routed('b', { type: 'thread', threadId: 'thread-b', turnId: 'turn-b', model: 'provider-b::model' }));
  state = reduceRunCollection(state, routed('a', { type: 'usage', usage: { totalTokens: 100 } }));
  state = reduceRunCollection(state, routed('b', { type: 'turn', status: 'failed' }));
  const [a, b] = state.runs;
  assert.equal(a.nodes.agent.threadId, 'thread-a'); assert.equal(a.nodes.agent.resolvedModel, 'provider-a::model'); assert.equal(a.nodes.agent.usage.totalTokens, 100); assert.equal(a.nodes.agent.turnStatus, undefined);
  assert.equal(b.nodes.agent.threadId, 'thread-b'); assert.equal(b.nodes.agent.resolvedModel, 'provider-b::model'); assert.equal(b.nodes.agent.turnStatus, 'failed'); assert.equal(b.nodes.agent.usage, undefined);
  assert.strictEqual(state.currentRun, null); assert.deepEqual(conversationAgents(b, 'steer'), []);
});

test('a long live stream bounds trace memory while keeping real messages, directions and the actual output tail', () => {
  let live = reduceRunEvent(collectionRun('long'), routed('long', { type: 'thread', threadId: 'actual-thread', turnId: 'actual-turn', model: 'chosen-model' })), expected = '';
  const durable = [];
  for (let index = 0; index < 20000; index++) {
    const delta = `${String(index).padStart(5, '0')}|${'x'.repeat(24)}`; expected += delta;
    live = reduceRunEvent(live, routed('long', { type: 'delta', itemId: 'long-stream', delta }, `delta-${index}`));
    if (index % 4000 === 0) {
      const data = { type: 'steer', text: `Real direction ${index}`, accepted: true }; durable.push(data.text);
      live = reduceRunEvent(live, routed('long', data, `direction-${index}`));
    }
    if (index % 5000 === 0) {
      const data = { type: 'message', itemId: `review-${index}`, text: `Actual reviewer receipt ${index}` }; durable.push(data.text);
      live = reduceRunEvent(live, { ...routed('long', data, `review-${index}`), nodeId: 'reviewer' });
    }
  }
  const nondurable = live.events.filter(event => !['message', 'steer'].includes(event.data.type));
  assert.ok(nondurable.length <= 3000); assert.ok(nondurable.length >= 2500); assert.ok(live.events.length <= 3000 + durable.length);
  assert.equal(live.nodes.agent.output.length, 500000); assert.equal(live.nodes.agent.output, expected.slice(-500000));
  assert.equal(live.nodes.agent.threadId, 'actual-thread'); assert.equal(live.nodes.agent.turnId, 'actual-turn'); assert.equal(live.nodes.agent.resolvedModel, 'chosen-model');
  assert.deepEqual(live.events.filter(event => ['message', 'steer'].includes(event.data.type)).map(event => event.data.text), durable);
  const shown = assistantMessages(live);
  assert.equal(shown.find(message => message.nodeId === 'agent' && message.role === 'assistant').text, expected.slice(-500000), 'the actual output accumulator restores the truncated live trace prefix');
  assert.deepEqual(shown.filter(message => message.role === 'user').map(message => message.text), durable.filter(text => text.startsWith('Real direction')));
  live = reduceRunEvent(live, routed('long', { type: 'message', itemId: 'long-stream', text: 'The actual final answer.', phase: 'final_answer' }, 'final-receipt'));
  const final = assistantMessages(live).filter(message => message.nodeId === 'agent' && message.role === 'assistant');
  assert.deepEqual(final.map(message => message.text), ['The actual final answer.'], 'a completed receipt replaces its own streamed text without a duplicate or synthetic result');
});

test('batch compaction preserves both message receipt formats and does not mutate earlier snapshots', () => {
  const original = collectionRun('long');
  original.events = [routed('long', { type: 'item', item: { type: 'agentMessage', id: 'native-message', text: 'Native saved answer.' } }), routed('long', { type: 'message', itemId: 'provider-message', text: 'Provider saved answer.' })];
  let next = original;
  for (let index = 0; index < 3001; index++) next = reduceRunEvent(next, routed('long', { type: 'item', item: { type: 'dynamicToolCall', id: `trace-${index}` } }));
  assert.equal(next.events.length, 2502); assert.equal(original.events.length, 2);
  assert.deepEqual(assistantMessages(next).map(message => message.text), ['Native saved answer.', 'Provider saved answer.']);
  assert.equal(next.events.at(-1).data.item.id, 'trace-3000'); assert.equal(next.events[2].data.item.id, 'trace-501');
});

test('a late HTTP snapshot cannot overwrite newer streamed background or selected-chat receipts', () => {
  const before = { ...collectionRun('background', 'before'), updatedAt: '2026-10-16T16:00:00Z' }, selectedBefore = { ...collectionRun('selected', 'selected before'), updatedAt: before.updatedAt };
  const background = reduceRunEvent(before, routed('background', { type: 'delta', delta: ' after' }, '2026-10-16T16:00:01Z'));
  const selected = reduceRunEvent(selectedBefore, routed('selected', { type: 'delta', delta: ' after' }, '2026-10-16T16:00:01Z'));
  const merged = mergeRunSnapshots([background, selectedBefore], [before, selectedBefore], { currentRun: selected, changedRunIds: new Set(['background', 'selected']) });
  assert.strictEqual(merged.find(run => run.id === 'background'), background); assert.strictEqual(merged.find(run => run.id === 'selected'), selected);
  assert.equal(merged.find(run => run.id === 'background').nodes.agent.output, 'before after'); assert.equal(merged.find(run => run.id === 'selected').nodes.agent.output, 'selected before after');
  assert.strictEqual(adoptFetchedRun(background, before), background, 'timestamps also guard a stale backend snapshot without an event-generation hint');
});

test('a changed event generation wins even when HTTP and SSE share the same timestamp', () => {
  const http = { ...collectionRun('same', 'old'), updatedAt: '2026-10-16T16:00:00Z' }, streamed = { ...collectionRun('same', 'new receipt'), updatedAt: http.updatedAt };
  assert.strictEqual(adoptFetchedRun(streamed, http, { changedSinceRequest: true }), streamed);
  assert.strictEqual(mergeRunSnapshots([streamed], [http], { changedRunIds: new Set(['same']) })[0], streamed);
  const metadata = { ...http, providerNote: 'Fresh metadata fetched after the latest event.' };
  assert.strictEqual(adoptFetchedRun(streamed, metadata), metadata, 'a request made after the latest receipt may supply fresh same-timestamp metadata');
});

test('fresh settled snapshots replace old output completely and stale active snapshots cannot resurrect them', () => {
  const live = { ...collectionRun('task', 'obsolete partial output'), updatedAt: '2026-10-16T16:00:00Z' };
  const settled = { ...collectionRun('task', 'actual final answer'), status: 'completed', settled: true, updatedAt: '2026-10-16T16:00:02Z', serverMetadata: 'new' };
  const merged = mergeRunSnapshots([live], [settled]); assert.strictEqual(merged[0], settled); assert.equal(merged[0].nodes.agent.output, 'actual final answer'); assert.equal(merged[0].serverMetadata, 'new');
  assert.strictEqual(adoptFetchedRun(settled, live), settled);
  assert.strictEqual(adoptFetchedRun(settled, { ...live, updatedAt: settled.updatedAt }), settled, 'an equal-timestamp pre-terminal response must not revive a completed task');
  const failed = { ...settled, status: 'failed', nodes: { agent: { status: 'failed', error: 'Actual terminal error.' } }, updatedAt: '2026-10-16T16:00:03Z' };
  assert.strictEqual(adoptFetchedRun(settled, failed), failed); assert.equal(adoptFetchedRun(settled, failed).nodes.agent.output, undefined, 'replacement does not deep-merge obsolete output into the new snapshot');
});

test('bounded list refreshes retain missing live chats, recent history and the selected old conversation', () => {
  const item = (id, index, live = false) => ({ ...collectionRun(id), createdAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString(), status: live ? 'running' : 'completed', settled: !live });
  const oldActive = item('missing-active', 0, true), selected = item('selected-old-history', -10), historical = Array.from({ length: 140 }, (_, index) => item(`history-${index}`, index + 100));
  const active = Array.from({ length: 35 }, (_, index) => item(`active-${index}`, index + 300, true));
  const next = mergeRunSnapshots([oldActive, selected, ...historical], active, { currentRun: oldActive });
  assert.equal(next.filter(run => activeRunForTest(run)).length, 36); assert.equal(next.filter(run => !activeRunForTest(run)).length, 100); assert.equal(next.length, 136); assert.ok(next.includes(oldActive), 'a selected missing active chat cannot be evicted');
  const fewerActive = mergeRunSnapshots([oldActive, selected], historical.slice(-3), { currentRun: selected, maxHistory: 2 });
  assert.ok(fewerActive.includes(oldActive)); assert.ok(fewerActive.includes(selected)); assert.equal(fewerActive.filter(run => !activeRunForTest(run)).length, 2); assert.equal(new Set(fewerActive.map(run => run.id)).size, fewerActive.length);
});

test('settling executions count as live retention, and invalid fetched values do not invent records', () => {
  const settling = { ...collectionRun('settling'), status: 'cancelled', settled: false }, selected = collectionRun('selected');
  const merged = mergeRunSnapshots([settling], [null, {}], { currentRun: selected });
  assert.deepEqual(new Set(merged.map(run => run.id)), new Set(['settling', 'selected'])); assert.strictEqual(adoptFetchedRun(selected, null), selected); assert.equal(adoptFetchedRun(undefined, undefined), undefined);
});

const activeRunForTest = run => ['queued', 'running', 'waiting'].includes(run.status) || run.settled === false;

test('user-admitted live work is never clipped by an old active count hint',()=>{
  const active=Array.from({length:150},(_,index)=>({...collectionRun(`active-${index}`),createdAt:new Date(Date.UTC(2026,9,16,0,0,index)).toISOString()}));
  const history=Array.from({length:120},(_,index)=>({...collectionRun(`done-${index}`),status:'completed',settled:true}));
  const selected=active[0],next=mergeRunSnapshots(active,history,{currentRun:selected,maxActive:1,maxHistory:10});
  assert.equal(next.filter(activeRunForTest).length,150);assert.equal(next.filter(run=>!activeRunForTest(run)).length,10);assert.ok(next.includes(selected));
});

test('milestone snapshots require the exact task identity and a positive safe revision before entering live state', () => {
  const saved = { taskId: 'shared-task', revision: 5, steps: [{ title: 'Actual saved work', status: 'active' }] };
  const invalid = [null, {}, [], { revision: 6 }, { taskId: 'other', revision: 6 }, ...[undefined, null, 0, -1, 1.5, '6', Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => ({ taskId: 'shared-task', revision }))];
  for (const state of invalid) {
    assert.strictEqual(newerTaskState(saved, state, 'shared-task'), saved);
    assert.equal(newerTaskState(undefined, state, 'shared-task'), undefined);
    const initial = { ...run(), taskId: 'shared-task' };
    assert.equal(reduceRunEvent(initial, agentEvent({ type: 'task.state', state })).taskState, undefined);
    assert.equal(adoptFetchedRun(undefined, { ...initial, taskState: state }).taskState, undefined);
  }
  assert.strictEqual(newerTaskState(saved, { ...saved, revision: 4 }, 'shared-task'), saved);
  assert.strictEqual(newerTaskState(saved, { ...saved, steps: [] }, 'shared-task'), saved, 'same-revision conflicting contents cannot replace a committed snapshot');
  const latest = { ...saved, revision: 6 }; assert.strictEqual(newerTaskState(saved, latest, 'shared-task'), latest);
  assert.strictEqual(newerTaskState({ taskId: 'other', revision: 100 }, saved, 'shared-task'), saved);
});

test('delayed milestone receipts and HTTP snapshots preserve the newest revision without reviving terminal output', () => {
  const saved = { taskId: 'shared-task', revision: 5, steps: [{ title: 'Verify actual result', status: 'active' }] };
  const terminal = { ...run(), taskId: 'shared-task', taskState: saved, status: 'completed', settled: true, updatedAt: '2026-10-16T16:00:02Z', nodes: { agent: { status: 'completed', output: 'Final answer.' } } };
  const older = { ...terminal, status: 'running', settled: false, updatedAt: terminal.updatedAt, taskState: { ...saved, revision: 4 }, nodes: { agent: { output: 'Old partial.' } } };
  const delayed = reduceRunEvent(terminal, agentEvent({ type: 'task.state', state: older.taskState })); assert.strictEqual(delayed.taskState, saved); assert.equal(delayed.status, 'completed');
  assert.strictEqual(adoptFetchedRun(terminal, older), terminal);
  const newest = { ...saved, revision: 6, steps: [{ title: 'Result verified', status: 'done' }] };
  const olderHttp = { ...older, updatedAt: '2026-10-16T16:00:01Z', taskState: newest };
  const merged = adoptFetchedRun(terminal, olderHttp, { changedSinceRequest: true });
  assert.strictEqual(merged.taskState, newest); assert.equal(merged.status, 'completed'); assert.equal(merged.settled, true); assert.equal(merged.nodes.agent.output, 'Final answer.');
  assert.strictEqual(terminal.taskState, saved); assert.strictEqual(olderHttp.taskState, newest);
});

test('selected live output and background chat routing retain independently newer saved milestones', () => {
  const state = revision => ({ taskId: 'shared-task', revision, steps: [] });
  const selected = { ...collectionRun('selected', 'Selected live output'), taskId: 'shared-task', taskState: state(2) };
  const listed = { ...selected, taskState: state(5), nodes: { agent: { output: 'Older listed output' } } };
  const background = { ...collectionRun('background'), taskState: { taskId: 'background', revision: 3, steps: [] } };
  const combined = runsWithCurrent([background, listed], selected);
  assert.equal(combined[1].nodes.agent.output, 'Selected live output'); assert.equal(combined[1].taskState.revision, 5);
  const sameRevision = { ...selected, taskState: { ...selected.taskState, steps: [{ title: 'Conflicting same-revision contents' }] } };
  assert.strictEqual(runsWithCurrent([sameRevision], selected)[0], selected, 'the selected snapshot wins a same-revision tie');
  const receipt = reduceRunCollection({ runs: [background, listed], currentRun: selected }, routed('background', { type: 'task.state', state: { taskId: 'background', revision: 4, steps: [] } }));
  assert.equal(receipt.currentRun.taskState.revision, 5); assert.equal(receipt.currentRun.nodes.agent.output, 'Selected live output'); assert.equal(receipt.runs[0].taskState.revision, 4);
  const rejected = reduceRunCollection(receipt, routed('background', { type: 'task.state', state: { taskId: 'shared-task', revision: 99, steps: [] } }));
  assert.equal(rejected.runs[0].taskState.revision, 4); assert.equal(rejected.currentRun.taskState.revision, 5);
});
