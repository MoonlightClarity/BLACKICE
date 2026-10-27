import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { EXECUTION_LIMITS, executionReceipt, appendExecutionReceipt, executionView, executionErrorAnnotations } from '../lib/planning-execution.mjs';
import { toolResultEvent } from '../lib/tool-outcomes.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { reduceRunEvent, adoptFetchedRun, newerTaskState } from '../public/run-state-model.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const action = (id = 'draft') => ({ id, title: 'Prepare and verify the requested draft', kind: 'action', status: 'active', doneWhen: 'The destination displays the correct data and accepted attachment; unresolved facts remain visible.' });
const ok = () => ({ success: true, contentItems: [{ type: 'inputText', text: '{"acceptedByTool":true,"privateOutput":"email-code-927331"}' }] });
const failed = () => ({ success: false, code: 'BROWSER_VALIDATION', contentItems: [{ type: 'inputText', text: '{"error":"Current document required","code":"BROWSER_VALIDATION","secret":"do-not-retain-this"}' }] });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-execution-receipts-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  let store = await new TaskStateStore({ dataDir: directory }).init(); const stores = [store];
  const initial = await store.ensure({ taskId: 'task-one', runId: 'run-one', cwd, goal: 'Prepare a checked draft.', defaultPlan: true });
  const saved = await store.setPlan(initial.taskId, { plan: { layout: 'sequence' }, steps: [action()] }, { expectedRevision: initial.revision, runId: 'run-one', nodeId: 'agent', schemaVersion: 6 });
  t.after(async () => { for (const item of stores) await item.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, store, saved, async reopen() { await store.close(); store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); this.store = store; return store; },
    async guard(executionEnabled = true) { return createPlanningWorkerGuard({ store: this.store, taskId: initial.taskId, runId: 'run-one', nodeId: 'agent', executionEnabled }); } };
}
const browserCall = (callId, action, extra = {}) => ({ name: 'relay_browser', callId, arguments: { action, tabId: 'tab-one', ...extra } });
async function dispatch(guard, call, receipt) {
  assert.equal(await guard.before(call), null);
  return guard.annotate(call, receipt);
}

test('actual sanitized failure→different-method→upload sequence survives restart/interruption without claiming acceptance', async t => {
  const f = await fixture(t), guard = await f.guard(), planBytes = await readFile(f.store.file('task-one'));
  // Replays the observed application sequence, not the original external action.
  for (let index = 0; index < 9; index++) {
    const result = await dispatch(guard, browserCall('fill-' + index, 'fill', { ref: 'field-' + index, text: 'private-form-value', documentId: 'doc-one', expectedUrl: 'https://example.test/private' }), failed());
    assert.equal(result.success, false);
    if (index === 1) { const annotation = JSON.parse(result.contentItems[1].text); assert.equal(annotation.kind, 'recurring-tool-error'); assert.match(annotation.note, /different inputs/); assert.equal(annotation.currentChecks[0].stepId, 'draft'); }
  }
  await dispatch(guard, browserCall('click-one', 'click', { ref: 'field-1' }), ok());
  await dispatch(guard, browserCall('type-one', 'type', { text: 'private-form-value' }), ok());
  for (let index = 0; index < 70; index++) await dispatch(guard, browserCall('snapshot-' + index, 'snapshot'), ok());
  await dispatch(guard, browserCall('upload-one', 'upload', { path: 'C:/private/resume.pdf', ref: 'attachment' }), ok());
  assert.deepEqual(await readFile(f.store.file('task-one')), planBytes, 'Receipt writes do not change human plan bytes, revision or progress.');
  let current = await f.store.get('task-one');
  assert.equal(current.revision, f.saved.revision); assert.equal(current.steps[0].status, 'active');
  assert.equal(current.executionObservations.unresolved.length, 9);
  assert.equal(current.executionObservations.recoveredFailures, 0, 'Typing and upload are not recovery of rejected fills.');
  assert.ok(current.executionObservations.omittedReceipts > 0);
  const bytes = await readFile(f.store.executionFile('task-one'), 'utf8');
  assert.doesNotMatch(bytes, /private-form-value|privateOutput|email-code|927331|example\.test|resume\.pdf|do-not-retain/);
  assert.ok(bytes.length <= EXECUTION_LIMITS.bytes);
  const restarted = await f.reopen(); current = await restarted.get('task-one');
  assert.equal(current.executionObservations.total, 82);
  const context = await restarted.getContext('task-one');
  assert.match(context, /fill-8/); assert.match(context, /upload-one/); assert.match(context, /not milestone completion|not outcome confirmation/);
  const interrupted = await restarted.interrupt('task-one', { runId: 'run-one', nodeId: 'runtime', status: 'cancelled' });
  assert.equal(interrupted.steps[0].status, 'active');
  assert.equal(interrupted.interruption.executionObservations.recoveredFailures, 0);
  assert.equal(interrupted.checkpoint.executionSource, 'task-execution-journal');
  assert.match(interrupted.interruption.executionObservations.note, /destination confirmation/);
  assert.equal((await restarted.get('task-one')).executionObservations.recent.at(-1).callId, 'upload-one');
});

test('exact recovery and duplicate receipt replay are precise; changed input/scope cannot resolve a failure', async t => {
  const f = await fixture(t), guard = await f.guard();
  const original = browserCall('first-failure', 'fill', { ref: 'one', text: 'secret-one' });
  await dispatch(guard, original, failed());
  await dispatch(guard, browserCall('different-value', 'fill', { ref: 'one', text: 'secret-two' }), ok());
  assert.equal((await f.store.get('task-one')).executionObservations.unresolved.length, 1);
  const recovered = await dispatch(guard, { ...original, callId: 'exact-success' }, ok());
  assert.equal(recovered.success, true);
  const annotation = JSON.parse(recovered.contentItems[1].text);
  assert.equal(annotation.kind, 'exact-operation-recovered'); assert.deepEqual(annotation.recoveredCallIds, ['first-failure']);
  const before = await readFile(f.store.executionFile('task-one'));
  await dispatch(guard, { ...original, callId: 'exact-success' }, ok());
  assert.deepEqual(await readFile(f.store.executionFile('task-one')), before);
  assert.equal((await f.store.get('task-one')).executionObservations.recoveredFailures, 1);
  const event = toolResultEvent(original, failed());
  const alternate = executionReceipt(event, { runId: 'run-one', nodeId: 'other-node', planRevision: 2, activeStepIds: ['draft'] });
  let state = appendExecutionReceipt(null, alternate).state;
  const success = executionReceipt(toolResultEvent({ ...original, callId: 'not-same-worker' }, ok()), { runId: 'run-one', nodeId: 'agent', planRevision: 2, activeStepIds: ['draft'] });
  state = appendExecutionReceipt(state, success).state; assert.equal(state.unresolved.length, 1);
});

test('human edits are preserved and receipt writes do not create review churn; in-flight scope stays historical', async t => {
  const f = await fixture(t), guard = await f.guard(), call = browserCall('in-flight', 'upload');
  assert.equal(await guard.before(call), null);
  const edited = await f.store.editPlan('task-one', { operations: [{ type: 'update', stepId: 'draft', patch: { note: 'Human correction: keep the appendix.', doneWhen: 'The corrected appendix is checked at the destination.' } }] }, { expectedRevision: f.saved.revision, source: 'human' });
  const result = await guard.annotate(call, ok()); assert.equal(result.success, true);
  const current = await f.store.get('task-one'); assert.equal(current.revision, edited.revision); assert.equal(current.steps[0].note, 'Human correction: keep the appendix.');
  assert.equal(current.executionObservations.recent[0].planRevision, f.saved.revision);
  assert.equal((await guard.before(browserCall('affected-next', 'click'))).code, 'TASK_PLAN_REVIEW_REQUIRED');
  const handler = createTaskToolHandler({ store: f.store, taskId: 'task-one', runId: 'run-one', nodeId: 'agent' });
  const readCall = { name: 'relay_task', arguments: { action: 'read' } };
  const read = guard.after(readCall, await handler(readCall));
  assert.equal(payload(read).executionObservations.recent[0].callId, 'in-flight');
  await dispatch(guard, browserCall('after-read', 'snapshot'), ok());
  assert.equal(await guard.before(browserCall('no-churn', 'snapshot')), null);
  assert.equal((await f.store.get('task-one')).revision, edited.revision);
});

test('failed journal persistence preserves the exact completed/failed tool result and warns without replay', async t => {
  const f = await fixture(t), guard = await f.guard();
  f.store.recordToolReceipt = async () => { throw new Error('private disk error / credential:SECRET'); };
  let operations = 0;
  const wrapped = wrapPlanningToolHandler(guard, async call => { const denied = await guard.before(call); if (denied) return denied; operations++; return operations === 1 ? ok() : failed(); });
  const completed = await wrapped(browserCall('completed-effect', 'upload'));
  assert.equal(completed.success, true); assert.equal(completed.contentItems[0].text, ok().contentItems[0].text);
  assert.equal(JSON.parse(completed.contentItems[1].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
  assert.doesNotMatch(completed.contentItems[1].text, /private disk|credential:SECRET/);
  const failure = await wrapped(browserCall('failed-effect', 'fill'));
  assert.equal(failure.success, false); assert.equal(failure.code, 'BROWSER_VALIDATION'); assert.equal(failure.contentItems[0].text, failed().contentItems[0].text);
  assert.equal(JSON.parse(failure.contentItems[1].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
  assert.equal(operations, 2);
});

test('loaded corruption is unavailable without exposing unknown fields or overwriting saved bytes', async t => {
  const f = await fixture(t), guard = await f.guard();
  await dispatch(guard, browserCall('one', 'snapshot'), ok());
  const file = f.store.executionFile('task-one'), tampered = JSON.parse(await readFile(file, 'utf8'));
  tampered.arguments = { emailCode: '729331-PRIVATE' }; await writeFile(file, JSON.stringify(tampered));
  const before = await readFile(file), current = await f.store.get('task-one');
  assert.equal(current.executionObservations.unavailable, true); assert.doesNotMatch(JSON.stringify(current), /729331|emailCode/);
  const completed = await dispatch(guard, browserCall('two', 'upload'), ok());
  assert.equal(completed.success, true); assert.equal(JSON.parse(completed.contentItems[1].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
  assert.deepEqual(await readFile(file), before);
});

test('maximum valid metadata evicts deterministically with omissions, while ambiguous scopes are never bound to one step', () => {
  const long = prefix => prefix + 'x'.repeat(159 - prefix.length), active = Array.from({ length: 20 }, (_, index) => long('step-' + index));
  let state;
  for (let index = 0; index < 300; index++) {
    const event = { callId: long('call-' + index), tool: 'relay_browser', action: 'fill', success: index % 4 !== 0, operationKey: index.toString(16).padStart(64, '0'), code: 'BROWSER_VALIDATION' };
    const receipt = executionReceipt(event, { runId: long('run'), nodeId: long('node'), scopeStepId: long('scope'), activeStepIds: active, planRevision: 2 });
    assert.equal(receipt.stepId, undefined);
    state = appendExecutionReceipt(state, receipt).state;
    assert.ok(JSON.stringify(state).length <= EXECUTION_LIMITS.bytes);
  }
  assert.equal(state.total, 300); assert.ok(state.omittedReceipts > 0); assert.ok(state.omittedUnresolvedFailures > 0); assert.ok(state.dedupIdsOmitted > 0);
  assert.doesNotThrow(() => executionView(state));
});

test('legacy/off-disabled guards create no journal or recovery reminders; fake stores remain supported', async t => {
  const f = await fixture(t), guard = await f.guard(false);
  for (let index = 0; index < 3; index++) {
    const result = await dispatch(guard, browserCall('off-' + index, 'fill'), failed());
    assert.equal(result.contentItems.length, 1);
  }
  await assert.rejects(readFile(f.store.executionFile('task-one')), { code: 'ENOENT' });
  assert.equal((await f.store.get('task-one')).revision, f.saved.revision);
  assert.equal(await createPlanningWorkerGuard({ store: { get: async () => f.saved }, taskId: 'task-one', runId: 'run-one', nodeId: 'agent', executionEnabled: true }), null);
});

test('native Codex fallback call identity reaches handler and actual tool-result event consistently', async t => {
  const f = await fixture(t), guard = await f.guard(), events = [], replies = [], child = {};
  const state = { dynamicTools: [{ type: 'function', name: 'relay_browser' }], turnId: 'turn-one', toolController: new AbortController(), onToolCall: wrapPlanningToolHandler(guard, async call => { const denied = await guard.before(call); return denied || ok(); }) };
  const runtime = { threads: new Map([['thread-one', state]]), child, _emitRun: (_state, event) => events.push(event), _send: message => replies.push(message) };
  await CodexRuntime.prototype._dynamicToolCall.call(runtime, { id: 42, params: { threadId: 'thread-one', turnId: 'turn-one', tool: 'relay_browser', arguments: { action: 'upload' } } });
  assert.equal(replies[0].result.success, true);
  assert.equal(events.find(event => event.type === 'tool.result').callId, '42');
  assert.equal((await f.store.get('task-one')).executionObservations.recent[0].callId, '42');
});

test('thrown failures keep Error identity including frozen errors, with durable metadata and adapter-delivered warnings', async t => {
  const f = await fixture(t), guard = await f.guard();
  const original = Object.freeze(Object.assign(new Error('Actual validation failure'), { code: 'BROWSER_VALIDATION' }));
  const wrapped = wrapPlanningToolHandler(guard, async call => { assert.equal(await guard.before(call), null); throw original; });
  await assert.rejects(wrapped(browserCall('thrown-one', 'fill')), error => error === original);
  assert.equal((await f.store.get('task-one')).executionObservations.unresolved[0].callId, 'thrown-one');
  f.store.recordToolReceipt = async () => { throw new Error('disk error with private details'); };
  const events = [], replies = [], child = {}, state = { dynamicTools: [{ type: 'function', name: 'relay_browser' }], turnId: 'turn-one', toolController: new AbortController(), onToolCall: wrapped };
  const runtime = { threads: new Map([['thread-one', state]]), child, _emitRun: (_state, event) => events.push(event), _send: message => replies.push(message) };
  await CodexRuntime.prototype._dynamicToolCall.call(runtime, { id: 43, params: { threadId: 'thread-one', turnId: 'turn-one', tool: 'relay_browser', arguments: { action: 'fill' } } });
  assert.equal(replies[0].result.success, false); assert.equal(replies[0].result.code, 'BROWSER_VALIDATION'); assert.equal(replies[0].result.contentItems[0].text, original.message);
  assert.equal(JSON.parse(executionErrorAnnotations(original)[0].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
  assert.equal(JSON.parse(replies[0].result.contentItems[1].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
});

test('appended Planning annotations cannot hide a real structured tool failure or nonzero exit', () => {
  for (const detail of [{ exitCode: 1, code: 'WORKSPACE_ERROR' }, { success: false, code: 'BROWSER_VALIDATION' }, { ok: false, code: 'TOOL_FAILED' }, { isError: true, code: 'MCP_ERROR' }]) {
    const event = toolResultEvent(browserCall('classified', 'read'), { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(detail) }, { type: 'inputText', text: '{"type":"planning.execution","kind":"recurring-tool-error","code":"IGNORE_THIS"}' }] });
    assert.equal(event.success, false); assert.equal(event.code, detail.code);
  }
});

test('run snapshots adopt independent execution sequence without overwriting equal/newer human plan fields', () => {
  const run = { id: 'run-one', taskId: 'task-one', taskState: { taskId: 'task-one', revision: 3, goal: 'Latest human goal', steps: [action()], executionObservations: { total: 1, updatedAt: '2026-10-23T00:00:00.000Z' } } };
  assert.equal(HarnessEngine.prototype.adoptTaskState(run, { taskId: 'task-one', revision: 3, goal: 'Must not replace human goal', steps: [], executionObservations: { total: 2, updatedAt: '2026-10-23T00:00:01.000Z' } }), true);
  assert.equal(run.taskState.goal, 'Latest human goal'); assert.equal(run.taskState.steps.length, 1); assert.equal(run.taskState.executionObservations.total, 2);
  assert.equal(HarnessEngine.prototype.adoptTaskState(run, { taskId: 'task-one', revision: 3, executionObservations: { total: 1 } }), false);
  assert.equal(HarnessEngine.prototype.adoptTaskState(run, { taskId: 'task-one', revision: 4, goal: 'New saved human goal', steps: [], executionObservations: { total: 1 } }), true);
  assert.equal(run.taskState.goal, 'New saved human goal'); assert.equal(run.taskState.executionObservations.total, 2);
});

test('interruption preserves a near-limit human plan and uses only a small journal reference', async t => {
  const f = await fixture(t);
  let state = await f.store.get('task-one');
  const steps = Array.from({ length: 24 }, (_, index) => ({ id: 'item-' + index, title: 'Item ' + index, kind: 'action', status: index ? 'pending' : 'active', doneWhen: 'Check this actual output. ' + 'x'.repeat(800), evidence: 'Known evidence. ' + 'y'.repeat(1000) }));
  state = await f.store.setPlan('task-one', { plan: { layout: 'sequence' }, steps }, { expectedRevision: state.revision, source: 'human', actor: { type: 'human-client', id: 'human-one' }, schemaVersion: 6 });
  const guard = await f.guard();
  for (let index = 0; index < 20; index++) await dispatch(guard, browserCall('long-' + index, 'fill', { ref: 'field-' + index }), failed());
  const interrupted = await f.store.interrupt('task-one', { runId: 'run-one', nodeId: 'runtime', status: 'cancelled' });
  assert.equal(interrupted.steps.length, 24); assert.equal(interrupted.steps[0].status, 'active');
  assert.ok(JSON.stringify(interrupted).length < 64000);
  assert.ok(JSON.stringify(interrupted.interruption.executionObservations || {}).length < 500);
  assert.ok(JSON.stringify((await f.store.get('task-one')).executionObservations).length <= 8000);
});

test('provider error normalization preserves thrown failure and generated persistence warning without HTTP requests', async t => {
  const f = await fixture(t), guard = await f.guard();
  f.store.recordToolReceipt = async () => { throw new Error('disk unavailable'); };
  const original = Object.freeze(Object.assign(new Error('Actual browser validation failure'), { code: 'BROWSER_VALIDATION' }));
  const wrapped = wrapPlanningToolHandler(guard, async call => { assert.equal(await guard.before(call), null); throw original; });
  const events = [], runtime = { store: { redact: text => text }, emitRun: (_state, event) => events.push(event) };
  const result = await ProviderRuntime.prototype.executeTool.call(runtime, { controller: new AbortController(), tools: [{ wireName: 'relay_browser', name: 'relay_browser' }], config: { type: 'compatible' }, onToolCall: wrapped, toolCalls: new Set() }, { id: 'provider-failure', name: 'relay_browser', arguments: '{"action":"fill"}' });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_VALIDATION'); assert.equal(result.contentItems[0].text, original.message);
  assert.equal(JSON.parse(result.contentItems[1].text).code, 'PLANNING_EXECUTION_NOT_SAVED');
  assert.equal(events.find(event => event.type === 'tool.result').success, false);
});

test('live UI and delayed snapshots merge journal sequence without rolling back human plan fields or receipts', () => {
  const run = { id: 'run-one', taskId: 'task-one', nodes: { agent: {} }, taskState: { taskId: 'task-one', revision: 3, goal: 'Latest human goal', steps: [action()], executionObservations: { total: 1 } }, events: [] };
  const live = reduceRunEvent(run, { type: 'agent.event', runId: 'run-one', nodeId: 'agent', data: { type: 'task.execution', taskId: 'task-one', executionObservations: { total: 2 } } });
  assert.equal(live.taskState.goal, 'Latest human goal'); assert.equal(live.taskState.executionObservations.total, 2);
  const delayed = adoptFetchedRun(live, { ...run, taskState: { taskId: 'task-one', revision: 2, goal: 'Older plan', steps: [], executionObservations: { total: 3 } } });
  assert.equal(delayed.taskState.revision, 3); assert.equal(delayed.taskState.goal, 'Latest human goal'); assert.equal(delayed.taskState.executionObservations.total, 3);
  const newerPlan = adoptFetchedRun(delayed, { ...run, taskState: { taskId: 'task-one', revision: 4, goal: 'New human revision', steps: [] } });
  assert.equal(newerPlan.taskState.goal, 'New human revision'); assert.equal(newerPlan.taskState.executionObservations.total, 3);
  const olderJournal = adoptFetchedRun(newerPlan, { ...run, taskState: { taskId: 'task-one', revision: 4, executionObservations: { total: 2, unavailable: true } } });
  assert.equal(olderJournal.taskState.executionObservations.total, 3);
});

test('fresh unavailable journal health preserves known receipts; stale healthy views cannot erase the warning', () => {
  const known = { taskId: 'task-one', revision: 7, goal: 'Current human goal', steps: [action()], executionObservations: { total: 5, recent: [{ callId: 'known-upload' }], unresolved: [{ callId: 'known-failure' }], note: 'Runtime receipts, not outcome confirmation.' } };
  // Exact pre-fix unavailable shape: no total or timestamp is present.
  const unavailable = newerTaskState(known, { taskId: 'task-one', revision: 7, goal: 'Must not replace human goal', executionObservations: { unavailable: true, code: 'PLANNING_EXECUTION_UNAVAILABLE', note: 'Saved receipts unavailable; inspect actual effects.' } }, 'task-one');
  assert.equal(unavailable.goal, known.goal); assert.equal(unavailable.executionObservations.unavailable, true);
  assert.equal(unavailable.executionObservations.total, 5); assert.deepEqual(unavailable.executionObservations.recent, known.executionObservations.recent);
  const stale = newerTaskState(unavailable, known, 'task-one'); assert.equal(stale.executionObservations.unavailable, true);
  const observedUnavailable = newerTaskState(stale, { ...known, executionObservations: { unavailable: true, code: 'PLANNING_EXECUTION_UNAVAILABLE', note: 'Unavailable', healthObservedAt: '2026-10-23T20:00:02.000Z' } }, 'task-one');
  const staleHealth = newerTaskState(observedUnavailable, { ...known, executionObservations: { ...known.executionObservations, healthObservedAt: '2026-10-23T20:00:01.000Z' } }, 'task-one');
  assert.equal(staleHealth.executionObservations.unavailable, true);
  const delayedHigherSequence = newerTaskState(observedUnavailable, { ...known, executionObservations: { ...known.executionObservations, total: 6, healthObservedAt: '2026-10-23T20:00:01.000Z' } }, 'task-one');
  assert.equal(delayedHigherSequence.executionObservations.total, 6); assert.equal(delayedHigherSequence.executionObservations.unavailable, true, 'More historical receipts do not establish availability after a later warning.');
  const recovered = newerTaskState(staleHealth, { ...known, executionObservations: { ...known.executionObservations, healthObservedAt: '2026-10-23T20:00:03.000Z' } }, 'task-one');
  assert.equal(recovered.executionObservations.unavailable, undefined); assert.equal(recovered.executionObservations.code, undefined); assert.equal(recovered.executionObservations.total, 5);
  const delayedWarning = newerTaskState(recovered, { ...known, executionObservations: { unavailable: true, code: 'PLANNING_EXECUTION_UNAVAILABLE', healthObservedAt: '2026-10-23T20:00:02.000Z' } }, 'task-one');
  assert.equal(delayedWarning.executionObservations.unavailable, undefined);
});

test('the last valid large recovery receipt can be omitted from an8k read while the durable journal retains it', () => {
  const long = prefix => prefix + 'x'.repeat(159 - prefix.length), active = Array.from({ length: 20 }, (_, index) => long('step-' + index));
  let state;
  const context = { runId: long('run'), nodeId: long('node'), scopeStepId: long('scope'), planRevision: 2, activeStepIds: active };
  for (let index = 0; index < 24; index++) state = appendExecutionReceipt(state, executionReceipt({ callId: long('failure-' + index), tool: 'relay_browser', action: 'fill', success: false, operationKey: 'a'.repeat(64), code: 'BROWSER_VALIDATION' }, context)).state;
  state = appendExecutionReceipt(state, executionReceipt({ callId: long('recovery'), tool: 'relay_browser', action: 'fill', success: true, operationKey: 'a'.repeat(64) }, context)).state;
  state.taskId = 't'.repeat(120);
  const view = executionView(state);
  assert.ok(JSON.stringify(view).length <= 8000); assert.ok(view.recentNotShown > 0);
  assert.equal(state.recent.at(-1).recoveredCallIds.length, 24); assert.equal(state.recoveredFailures, 24);
});

test('actual engine tool dispatch publishes journal updates at unchanged plan revision, while Off creates none', async t => {
  const f = await fixture(t); let engine, admittedId;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', supportsTools: true }] }; }
    async runAgent(options) {
      let saved;
      if (!/TASK PLANNING MODE: OFF/.test(options.developerInstructions)) {
        const read = payload(await options.onToolCall({ name: 'relay_task', callId: 'actual-read', arguments: { action: 'read' } }));
        saved = payload(await options.onToolCall({ name: 'relay_task', callId: 'actual-plan', arguments: { action: 'plan', expectedRevision: read.revision, plan: { layout: 'sequence' }, steps: [{ ...action(), result: 'The fixture file and its recorded write receipt.', note: 'Write the specified content, inspect the returned receipt, and compare the journal event and unchanged plan revision.' }] } }));
      }
      const result = await options.onToolCall({ name: 'relay_workspace', callId: 'actual-write', arguments: { action: 'write', path: 'checked-fixture.txt', text: 'Known fixture result.' } });
      assert.equal(result.success, true);
      const live = engine.getRun(admittedId);
      if (saved) { assert.equal(live.taskState.revision, saved.revision); assert.equal(live.taskState.executionObservations.total, 1); assert.equal(live.taskState.steps[0].status, 'active'); }
      else assert.equal(live.taskState?.executionObservations, undefined);
      return { output: 'The actual fixture write completed; this alone does not finish the requested milestone.' };
    }
  }
  engine = await new HarnessEngine({ runtime: new Runtime(), tasks: f.store, dataDir: f.directory, defaultCwd: f.cwd }).init();
  const workflow = { name: 'Execution integration fixture', settings: { maxParallel: 1 }, nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture-model', prompt: 'Write a checked fixture.' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }] };
  try {
    for (const planningMode of ['on', 'off']) {
      const admitted = engine.startRun({ workflow, input: 'Write the fixture output.', planningMode }); admittedId = admitted.id;
      const deadline = Date.now() + 7000; let settled;
      while (Date.now() < deadline) { settled = engine.getRun(admitted.id); if (settled.settled) break; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.equal(settled.status, 'completed', settled.error); assert.equal(settled.settled, true);
      if (planningMode === 'on') { assert.equal(settled.taskState.executionObservations.total, 1); assert.ok(settled.events.some(event => event.data?.type === 'task.execution')); }
      else await assert.rejects(readFile(f.store.executionFile(admitted.id)), { code: 'ENOENT' });
    }
  } finally { await engine.close(); }
});
