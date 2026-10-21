import test from 'node:test';
import assert from 'node:assert/strict';
import { selectObservedRun, createObserveSelection, createObserveFeed, observeLiveEntries, normalizeObserveEvent, observeTrace, observeAgents, observeModel, agentElapsed } from '../public/observe-model.mjs';
import { renderObserveAgents, renderObserveTrace, renderObserveDiff, renderObserveFeed, observeDuration, initObserveUI } from '../public/observe-ui.mjs';

const time = '2026-10-16T12:00:00.000Z';
const run = () => ({ id: 'actual-run', input: 'Finish the report.', status: 'running', workflow: { nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'one', type: 'agent', name: 'Research agent', model: 'default' }, { id: 'two', type: 'agent', name: 'Writer', model: 'local::writer' }, { id: 'output', type: 'output', name: 'Result' }] }, nodes: { input: { status: 'completed' }, one: { status: 'running', startedAt: time }, two: { status: 'queued' }, output: { status: 'queued' }, orphan: { status: 'running' } }, events: [] });
const event = (data, { nodeId = 'one', at = time } = {}) => ({ type: 'agent.event', nodeId, at, data });

test('Observe selects actual active work or an explicit real task without fabricating an agent', () => {
  const active = run(), old = { ...run(), id: 'old', status: 'completed' }, snapshot = { runs: [old, active], currentRun: old };
  assert.equal(selectObservedRun(snapshot).id, active.id); assert.equal(selectObservedRun(snapshot, 'old').id, old.id); assert.equal(selectObservedRun(snapshot, 'missing'), null);
  const empty = observeModel({ status: { connected: true }, runs: [] }); assert.equal(empty.run, null); assert.deepEqual(empty.agents, []); assert.deepEqual(empty.trace, []); assert.equal(empty.streamState, 'snapshot');
  assert.equal(observeModel(snapshot).activeAgents, 1, 'a queued agent must not be counted as already active');
});

test('entering Observe can find a stopping task without treating its cancelled agents as active', () => {
  const stopping = { ...run(), status: 'cancelled', settled: false };
  stopping.nodes.one.status = 'cancelled'; stopping.nodes.two.status = 'cancelled';
  const snapshot = { runs: [stopping], currentRun: stopping }, view = observeModel(snapshot);
  assert.equal(view.run, stopping); assert.equal(view.active, false); assert.equal(view.activeAgents, 0);
  assert.equal(view.runs[0].settled, false); assert.ok(view.agents.every(agent => agent.settled === false));
  assert.match(renderObserveAgents(view.agents), /Stopping/); assert.doesNotMatch(renderObserveAgents(view.agents), />Stopped</);
  stopping.settled = true; assert.equal(selectObservedRun(snapshot), null, 'fresh automatic entry does not choose already settled history');
  assert.match(renderObserveAgents(observeAgents(stopping)), />Stopped</);
});

test('automatic Observe keeps settled work until the next active run and resets on entry without changing the conversation', () => {
  const operation = run(), conversation = { ...run(), id: 'conversation', status: 'completed' };
  const snapshot = { runs: [operation, conversation], currentRun: conversation }, selection = createObserveSelection();
  assert.equal(selection.model(snapshot).run, operation);
  const completed = { ...operation, status: 'completed', events: [event({ type: 'browser.action', action: 'snapshot' })] };
  snapshot.runs = [completed, conversation];
  const settled = selection.model(snapshot);
  assert.equal(settled.run, completed, 'use the latest actual settled record, not a copied historical run');
  assert.equal(settled.active, false); assert.equal(settled.trace.length, 1);
  assert.equal(snapshot.currentRun, conversation, 'observing must not select or replace the conversation');
  const next = { ...run(), id: 'next-operation' }; snapshot.runs.unshift(next);
  assert.equal(selection.model(snapshot).run, next, 'automatic mode follows newly active work');
  selection.choose(completed.id);
  assert.equal(selection.model(snapshot).run, completed, 'manual choice wins over another active operation');
  selection.enter({ preserveSelection: true });
  assert.equal(selection.model(snapshot).run, completed, 'the selector navigation callback preserves its explicit choice');
  selection.enter();
  assert.equal(selection.model(snapshot).run, next, 'a fresh Observe entry chooses current active work');
  snapshot.runs = [conversation];
  assert.equal(selection.model(snapshot).run, null, 'missing observed runs cannot fabricate or preload old history');
  assert.equal(snapshot.currentRun, conversation);
});

test('live feed starts empty, receives only matching new evidence, and clears every payload on leave or run change', () => {
  const feed = createObserveFeed({ maxEntries: 3, maxChars: 5000 }); feed.reset('live');
  assert.deepEqual(feed.snapshot().entries, []); feed.baseline(5);
  const edit = { type: 'run.edit', runId: 'live', source: 'filesystem', sequence: 6, at: time, path: 'src/actual.txt', change: 'modified', diff: { added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'add', oldLine: null, newLine: 1, text: '<script>actual file text</script>' }] }] } };
  assert.equal(feed.edit({ ...edit, sequence: 5 }), false); assert.equal(feed.edit({ ...edit, source: 'agent' }), false); assert.equal(feed.edit({ ...edit, runId: 'old' }), false); assert.equal(feed.edit(edit), true); assert.equal(feed.edit(edit), false);
  assert.equal(feed.event({ ...event({ type: 'delta', delta: 'Current ' }), runId: 'live' }), true);
  feed.event({ ...event({ type: 'delta', delta: 'message.' }, { at: '2026-10-16T12:00:01Z' }), runId: 'live' });
  assert.equal(feed.snapshot().entries.at(-1).text, 'Current message.'); assert.equal(feed.event({ ...event({ type: 'message', text: 'Old private history' }), runId: 'old' }), false);
  const rendered = renderObserveDiff(feed.snapshot().entries[0]); assert.match(rendered, /Observed on disk/); assert.match(rendered, /observe-line-number/); assert.ok(!rendered.includes('<script>')); assert.match(rendered, /&lt;script&gt;/);
  for (let index = 0; index < 8; index++) feed.event({ ...event({ type: 'message', text: 'New update ' + index }, { at: new Date(Date.parse(time) + index + 2000).toISOString() }), runId: 'live' });
  assert.equal(feed.snapshot().entries.length, 3); assert.ok(renderObserveFeed(feed.snapshot().entries).includes('New update 7'));
  feed.reset('different'); assert.deepEqual(feed.snapshot().entries, []); assert.equal(feed.snapshot().sequence, 0); feed.reset(); assert.equal(feed.snapshot().runId, null);
});

test('Observe subscription closes and clears content immediately when hidden, then opens a fresh baseline', () => {
  const elements = new Map(), listeners = new Map();
  const element = key => { if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', hidden: false, value: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100, classList: { toggle() {} } }); return elements.get(key); };
  const mount = { hidden: true, isConnected: true, innerHTML: '', classList: { add() {} }, querySelector: element, querySelectorAll: () => [], addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name), contains: () => true };
  const active = run(), snapshot = { currentRun: active, runs: [active] }; let handlers, closes = 0, subscriptions = 0;
  const ui = initObserveUI({ mount, getSnapshot: () => snapshot, subscribe: (id, callbacks) => { assert.equal(id, active.id); subscriptions++; handlers = callbacks; return () => { closes++; }; } });
  ui.update(); assert.equal(subscriptions, 0, 'hidden Observe never starts a watcher');
  mount.hidden = false; ui.enter(); assert.equal(subscriptions, 1); handlers.onReady({ sequence: 0 });
  ui.handleEvent({ type: 'observe.presentation', runId: active.id, data: { version: 1, focus: 'activity', title: 'Reviewing the live changes', showAgents: false } });
  ui.update();
  assert.equal(element('#observe-live-title').textContent, 'Reviewing the live changes'); assert.equal(element('#observe-focus').value, 'activity'); assert.equal(element('#observe-agents').innerHTML, '');
  ui.handleEvent({ ...event({ type: 'message', text: 'CURRENT_LIVE_MESSAGE' }), runId: active.id }); ui.update(); assert.match(element('#observe-feed').innerHTML, /CURRENT_LIVE_MESSAGE/);
  ui.handleEvent({ type: 'observe.presentation', runId: active.id, data: { focus: 'auto' } });
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  handlers.onEdit({ runId: active.id, source: 'filesystem', sequence: 1, path: 'live.svg', change: 'created', bytes: { after: Buffer.byteLength(source) }, diff: { hunks: [], truncated: false }, preview: { type: 'svg', text: source } });
  ui.update();
  assert.match(element('#observe-pinned').innerHTML, /<img src="data:image\/svg\+xml/);
  mount.hidden = true; ui.update(); assert.equal(closes, 1); assert.equal(element('#observe-feed').innerHTML, ''); assert.equal(element('#observe-pinned').innerHTML, ''); assert.equal(element('#observe-now-text').textContent, '');
  handlers.onEdit({ runId: active.id, source: 'filesystem', sequence: 1, path: 'late.txt', change: 'created' }); assert.equal(element('#observe-feed').innerHTML, '', 'late callbacks cannot restore released content');
  mount.hidden = false; ui.enter(); assert.equal(subscriptions, 2); handlers.onReady({ sequence: 2 }); assert.ok(!element('#observe-feed').innerHTML.includes('CURRENT_LIVE_MESSAGE'));
  handlers.onError('Live edits disconnected. Reopen Observe to reconnect.'); ui.update(); assert.equal(element('#observe-error').textContent, 'Live edits disconnected. Reopen Observe to reconnect.');
  handlers.onStopped({ reason: 'completed' }); assert.equal(closes, 2); ui.destroy(); assert.equal(closes, 2); assert.equal(listeners.size, 0);
});

test('a stale Observe task selection cannot clear the latest selector navigation ownership', async t => {
  for (const staleFails of [false, true]) await t.test(staleFails ? 'stale selection fails' : 'stale selection succeeds', async () => {
    const elements = new Map(), listeners = new Map(), pending = new Map(), subscribed = [];
    const element = key => { if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', hidden: false, value: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100, classList: { toggle() {} } }); return elements.get(key); };
    const mount = { hidden: false, isConnected: true, innerHTML: '', classList: { add() {} }, querySelector: element, querySelectorAll: () => [], addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name), contains: () => true };
    const active = { ...run(), id: 'active', input: 'Current live task' }, first = { ...run(), id: 'first', input: 'First selected task', status: 'completed' }, latest = { ...run(), id: 'latest', input: 'Latest selected task', status: 'completed' }, snapshot = { runs: [active, first, latest], currentRun: active };
    let latestNavigation, closed = 0, ui;
    ui = initObserveUI({ mount, getSnapshot: () => snapshot, subscribe: id => { subscribed.push(id); return () => closed++; }, onOpenRun: async id => {
      latestNavigation = id; await new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      if (latestNavigation !== id) return;
      snapshot.currentRun = snapshot.runs.find(item => item.id === id); ui.enter();
    } });
    try {
      ui.enter(); const change = listeners.get('change'), earlier = change({ target: { id: 'observe-run', value: first.id } }), current = change({ target: { id: 'observe-run', value: latest.id } });
      if (staleFails) pending.get(first.id).reject(new Error('Old selection failed.')); else pending.get(first.id).resolve(); await earlier;
      pending.get(latest.id).resolve(); await current;
      assert.equal(element('#observe-run').value, latest.id); assert.equal(element('#observe-task-name').textContent, 'Latest selected task'); assert.equal(element('#observe-error').hidden, true); assert.deepEqual(subscribed, [active.id]); assert.equal(closed, 1, 'selecting a settled task releases the prior live watcher');
      ui.leave(); ui.enter(); assert.equal(element('#observe-run').value, ''); assert.equal(element('#observe-task-name').textContent, 'Current live task'); assert.deepEqual(subscribed, [active.id, active.id], 'a fresh entry returns to automatic live following');
    } finally { ui.destroy(); }
  });
});

test('leaving Observe invalidates a pending selection so its late failure cannot affect a fresh view', async () => {
  const elements = new Map(), listeners = new Map(); let rejectSelection, closed = 0, subscriptions = 0;
  const element = key => { if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', hidden: false, value: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100, classList: { toggle() {} } }); return elements.get(key); };
  const mount = { hidden: false, isConnected: true, innerHTML: '', classList: { add() {} }, querySelector: element, querySelectorAll: () => [], addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name), contains: () => true };
  const active = run(), old = { ...run(), id: 'old', status: 'completed' }, snapshot = { runs: [active, old], currentRun: active };
  const ui = initObserveUI({ mount, getSnapshot: () => snapshot, subscribe: () => { subscriptions++; return () => closed++; }, onOpenRun: () => new Promise((resolve, reject) => { rejectSelection = reject; }) });
  try {
    ui.enter(); const pending = listeners.get('change')({ target: { id: 'observe-run', value: old.id } }); ui.leave(); assert.equal(closed, 1);
    ui.enter(); assert.equal(subscriptions, 2); rejectSelection(new Error('Late abandoned navigation.')); await pending;
    assert.equal(element('#observe-run').value, ''); assert.equal(element('#observe-task-name').textContent, active.input); assert.equal(element('#observe-error').hidden, true); assert.equal(closed, 1, 'a late callback cannot close the fresh live watcher');
  } finally { ui.destroy(); }
  assert.equal(closed, 2);
});

test('automatic live view keeps the latest actual edit pinned through routine activity and releases it on leave', () => {
  const feed = createObserveFeed({ maxEntries: 6 }); feed.reset('live');
  const edit = { type: 'run.edit', runId: 'live', source: 'filesystem', sequence: 1, at: time, path: 'src/edited.mjs', change: 'modified', diff: { added: 1, removed: 1, hunks: [] } };
  feed.edit(edit);
  for (let index = 0; index < 20; index++) feed.event({ ...event({ type: 'browser.action', action: 'snapshot', title: 'Routine check ' + index }, { at: new Date(Date.parse(time) + index).toISOString() }), runId: 'live' });
  const live = feed.snapshot(), view = observeLiveEntries(live);
  assert.equal(live.entries.length, 6); assert.ok(!live.entries.some(entry => entry.kind === 'edit'), 'routine feed is independently bounded');
  assert.equal(view.pinned.path, 'src/edited.mjs'); assert.equal(view.pinned.source, 'filesystem'); assert.equal(view.visible.length, 4); assert.ok(view.visible.every(entry => entry.kind !== 'edit')); assert.ok(!view.earlier.some(entry => entry.key === view.pinned.key));
  feed.edit({ ...edit, sequence: 2, path: 'src/newest.mjs' }); const next = observeLiveEntries(feed.snapshot()); assert.equal(next.pinned.path, 'src/newest.mjs'); assert.ok(!next.visible.some(entry => entry.key === next.pinned.key));
  const editsOnly = observeLiveEntries(feed.snapshot(), { focus: 'edits' }); assert.equal(editsOnly.pinned, null); assert.ok(editsOnly.visible.every(entry => entry.kind === 'edit'));
  feed.reset(); assert.equal(feed.snapshot().latestEdit, null); assert.equal(observeLiveEntries(feed.snapshot()).pinned, null);
});

test('agent cards use saved node/model/timing records and ignore orphan graph state', () => {
  const value = run(); value.events.push(event({ type: 'thread', model: 'cloud::actual-model' }), event({ type: 'message', text: 'Checked the existing source.' }, { at: '2026-10-16T12:00:02Z' }));
  const agents = observeAgents(value, { now: Date.parse(time) + 15000 }); assert.equal(agents.length, 2); assert.equal(agents[0].model, 'cloud::actual-model'); assert.equal(agents[0].elapsedMs, 15000); assert.equal(agents[0].activity, 'Checked the existing source.'); assert.equal(agents[1].model, 'local::writer'); assert.equal(agents[1].elapsedMs, null); assert.equal(agents[1].status, 'queued');
  value.nodes.one.status = 'completed'; value.nodes.one.finishedAt = '2026-10-16T12:00:04Z'; assert.equal(observeAgents(value, { now: Date.parse(time) + 60000 })[0].elapsedMs, 4000);
  value.events = []; assert.equal(observeAgents(value)[0].model, 'Model default', 'current account settings must not invent the historical model');
  assert.equal(agentElapsed({ status: 'cancelled', startedAt: time }), null); assert.equal(observeDuration(61000), '1m 1s'); assert.equal(observeDuration(null), '—');
});

test('tool requests are distinct from completion and failed actual exit codes remain failures', () => {
  const request = normalizeObserveEvent(event({ type: 'browser.action', action: 'click', message: 'Browser · click' })); assert.equal(request.status, 'requested'); assert.equal(request.title, 'Activate control');
  const completed = normalizeObserveEvent(event({ type: 'item', stage: 'completed', item: { type: 'commandExecution', id: 'cmd', status: 'completed', exitCode: 1, commandActions: [{ type: 'read', path: 'C:\\project\\result.txt' }] } })); assert.equal(completed.status, 'failed'); assert.equal(completed.detail, 'result.txt');
  assert.equal(normalizeObserveEvent(event({ type: 'delta', delta: 'This is conversation text, not a tool action.' })), null);
  assert.equal(normalizeObserveEvent(event({ type: 'context', context: { actualInputTokens: 9000 } })), null);
});

test('trace reconciles actual item completion and orders it by its latest recorded event', () => {
  const value = run(); value.events = [event({ type: 'item', stage: 'started', item: { type: 'commandExecution', id: 'first', status: 'inProgress', commandActions: [{ type: 'read', path: '/project/actual.txt' }] } }), event({ type: 'browser.action', action: 'snapshot' }, { at: '2026-10-16T12:00:01Z' }), event({ type: 'item', stage: 'completed', item: { type: 'commandExecution', id: 'first', status: 'completed', exitCode: 0 } }, { at: '2026-10-16T12:00:02Z' })];
  const rows = observeTrace(value); assert.equal(rows.length, 2); assert.equal(rows.at(-1).key, 'one:first'); assert.equal(rows.at(-1).status, 'completed'); assert.equal(rows.at(-1).detail, 'actual.txt');
  value.events.push(...Array.from({ length: 30 }, (_, index) => event({ type: 'connection.action', action: 'call', toolName: 'tool-' + index }, { nodeId: 'two' })));
  const bounded = observeTrace(value); assert.equal(bounded.length, 20); assert.equal(bounded[0].detail, 'tool-10'); assert.equal(bounded.at(-1).detail, 'tool-29'); assert.equal(observeTrace(value, { nodeId: 'one' }).length, 2);
});

test('saved plan trace counts only actual saved steps and excludes unneeded tool payloads', () => {
  const value = run(), secret = 'PRIVATE_TOOL_TEXT_SHOULD_NOT_APPEAR'; value.events = [event({ type: 'task.state', state: { steps: [{ status: 'done' }, { status: 'active' }] } }), event({ type: 'item', stage: 'completed', item: { type: 'dynamicToolCall', id: 'tool', name: 'relay_files', status: 'completed', success: false, arguments: { text: secret }, contentItems: [{ type: 'inputText', text: secret }, { type: 'inputImage', imageUrl: 'data:image/png;base64,' + secret }] } })];
  const rows = observeTrace(value); assert.match(rows[0].detail, /1 of 2/); assert.equal(rows[1].status, 'failed'); assert.ok(!JSON.stringify(rows).includes(secret));
});

test('Observe renders escaped real labels, bounded activity and source-backed tool statuses', () => {
  const value = run(); value.workflow.nodes[1].name = '<img onerror=bad>'; value.nodes.one.error = '<script>bad</script>'; value.events = [event({ type: 'browser.action', action: 'click' })];
  const agents = observeAgents(value), html = renderObserveAgents(agents), trace = renderObserveTrace(observeTrace(value), { agentNames: { one: '<b>Agent</b>' } });
  assert.ok(!html.includes('<img onerror')); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/); assert.match(html, /data-observe-duration/); assert.match(html, /<svg/); assert.match(trace, /Requested/); assert.ok(!trace.includes('<b>Agent</b>'));
  value.nodes.one.error = ''; value.events = [event({ type: 'message', text: 'A'.repeat(10000) })]; assert.equal(observeAgents(value)[0].activity.length, 170);
});

test('live SVG evidence renders only as an encoded image with collapsed escaped source changes', () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="#aaa"/></svg>';
  const edit = { type: 'run.edit', runId: 'live', source: 'filesystem', sequence: 1, at: time, path: 'art.svg', change: 'created', bytes: { after: Buffer.byteLength(text) }, preview: { type: 'svg', text }, diff: { added: 1, removed: 0, truncated: false, hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'add', newLine: 1, text }] }] } };
  const feed = createObserveFeed(); feed.reset('live'); assert.equal(feed.edit(edit), true);
  const row = feed.snapshot().entries[0], html = renderObserveDiff(row, { icon: () => '' });
  assert.match(html, /<img src="data:image\/svg\+xml;charset=utf-8,/); assert.match(html, /<details class="observe-source-changes"[^>]*><summary[^>]*>Source changes<\/summary>/);
  assert.doesNotMatch(html, /<svg|<rect/); assert.match(html, /&lt;rect/); assert.match(html, /Observed on disk/);
  for (const override of [{ change: 'deleted' }, { source: 'agent' }, { contentOmitted: 'sensitive-file' }, { diff: { ...edit.diff, truncated: true } }, { bytes: { after: 40000 } }, { preview: { type: 'svg', text: '<svg><script>bad</script></svg>' } }]) assert.doesNotMatch(renderObserveDiff({ ...row, ...override }, { icon: () => '' }), /<img/);
  for (const override of [{ contentOmitted: 'baseline-limit' }, { diff: { ...edit.diff, truncated: true } }, { bytes: { after: 40000 } }]) {
    const next = createObserveFeed(); next.reset('live'); next.edit({ ...edit, ...override }); assert.equal(next.snapshot().latestEdit.preview, undefined);
  }
  feed.reset(); assert.equal(feed.snapshot().latestEdit, null); assert.deepEqual(feed.snapshot().entries, []);
});

test('SVG preview feed and pinned evidence remain bounded instead of accumulating images', () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' + ' '.repeat(2000), feed = createObserveFeed({ maxEntries: 4, maxChars: 7000 }); feed.reset('live');
  for (let sequence = 1; sequence <= 40; sequence++) feed.edit({ runId: 'live', source: 'filesystem', sequence, at: time, path: `art-${sequence}.svg`, change: 'created', bytes: { after: Buffer.byteLength(text) }, diff: { hunks: [], truncated: false }, preview: { type: 'svg', text } });
  const snapshot = feed.snapshot(); assert.ok(snapshot.entries.length <= 4); assert.ok(JSON.stringify(snapshot.entries).length <= 7000);
  assert.equal(snapshot.latestEdit.path, 'art-40.svg'); assert.equal(snapshot.latestEdit.preview.text, text); assert.ok(snapshot.entries.includes(snapshot.latestEdit), 'pin references the same bounded entry instead of copying encoded images');
  feed.reset(); assert.equal(JSON.stringify(feed.snapshot()).includes('data:image'), false); assert.equal(feed.snapshot().latestEdit, null);
});

test('Observe records real Neo tool failures and recovery without exposing browser script arguments', () => {
 const failed = event({ type:'tool.result', tool:'relay_connections', action:'call', integration:'run', connectionId:'browseros-neo', callId:'call-1', success:false, status:'failed', message:'page.waitForTimeout is not part of this SDK. Use page.waitForTime(ms).' });
 const ok = event({ type:'tool.result', tool:'relay_connections', action:'call', integration:'tabs', connectionId:'browseros-neo', callId:'call-2', success:true, status:'completed' });
 const invalid = event({ type:'tool.result', tool:'relay_connections', action:'call', integration:'run', connectionId:'other-service', callId:'call-3', success:false, message:'Other service failed' });
 const row=normalizeObserveEvent(failed);
 assert.equal(row.kind,'browser');assert.equal(row.status,'failed');
 assert.equal(row.title,'BrowserOS Neo · run');
 assert.match(row.detail,/waitForTimeout/);
 const noisy=normalizeObserveEvent(event({type:'tool.result',tool:'relay_connections',connectionId:'browseros-neo',integration:'run',callId:'call-noise',success:false,status:'failed',message:'error: page.waitForTimeout is not part of this SDK. Use page.waitForTime(ms). {"error":"same error","logs":[],"ok":false}'}));
 assert.equal(noisy.detail,'page.waitForTimeout is not part of this SDK. Use page.waitForTime(ms).');
 assert.ok(!noisy.detail.includes('"logs"'));

 assert.equal(row.key,'one:call-1');
 assert.equal(normalizeObserveEvent(invalid),null);
 const current=run();current.events=[failed,ok];
 const rows=observeTrace(current);
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>row.status),['failed','completed']);
 assert.deepEqual(rows.map(row=>row.title),['BrowserOS Neo · run','BrowserOS Neo · tabs']);
 assert.match(renderObserveTrace(rows),/waitForTimeout/);
 const feed=createObserveFeed();feed.reset(current.id);
 const first={...failed,runId:current.id},second={...ok,runId:current.id};
 assert.equal(feed.event(first),true);assert.equal(feed.event(second),true);
 assert.equal(feed.snapshot().entries.length,2);
 assert.match(renderObserveFeed(feed.snapshot().entries),/BrowserOS Neo/);
});

test('Observe shows a durable quiet website sign-in blocker as activity without opening any window',()=>{
 const e=event({type:'browser.signin',status:'awaiting-user',origin:'https://www.linkedin.com',hostname:'www.linkedin.com',reason:'sign-in',evidence:'login-redirect'});
 const row=normalizeObserveEvent(e);
 assert.equal(row.title,'Browser sign-in required');
 assert.equal(row.kind,'browser');
 assert.equal(row.detail,'www.linkedin.com');
 assert.ok(renderObserveTrace([row]).includes('Browser sign-in required'));
});
