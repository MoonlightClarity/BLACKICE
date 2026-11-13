import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CODEX_DYNAMIC_TOOL_LIMITS, codexRepeatedToolFailure } from '../lib/codex.mjs';

const errorReceipt = Object.freeze({ success: false, code: 'INVALID_TASK_VIEW', contentItems: [{ type: 'inputText', text: 'Use the returned expectedRevision and viewHash; restart the first page when absent.' }] });
const staleRefReceipt = Object.freeze({ success: false, code: 'BROWSER_REF_STALE', contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'Take a fresh snapshot.', code: 'BROWSER_REF_STALE', actionDispatched: false }) }] });
const documentChangedReceipt = Object.freeze({ success: false, code: 'BROWSER_INPUT_DOCUMENT_CHANGED', contentItems: [{ type: 'inputText', text: JSON.stringify({ code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false }) }] });
const goodReceipt = Object.freeze({ success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] });
const call = (offset, action = 'read') => ({ name: 'relay_task', arguments: { action, view: 'full', offset, expectedRevision: 316 } });

test('invalid saved-plan cursor flood stops after bounded identical failures, ignoring changing offsets', () => {
  const state = {};
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure - 1; i++) {
    assert.equal(codexRepeatedToolFailure(state, call(i * 9), errorReceipt), null);
  }
  const stopped = codexRepeatedToolFailure(state, call(135), errorReceipt);
  assert.equal(stopped?.code, 'CODEX_TOOL_FAILURE_LOOP');
  assert.match(stopped?.message || '', /Repeated relay_task read failures/);
  assert.equal(state.dynamicToolFailure.count, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.doesNotMatch(stopped.message, /offset|application question|email address/i);
});

test('successful calls and different failure types reset the consecutive failure streak', () => {
  const state = {};
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure - 1; i++) {
    assert.equal(codexRepeatedToolFailure(state, call(i), errorReceipt), null);
  }
  assert.equal(codexRepeatedToolFailure(state, call(0), goodReceipt), null);
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure - 1; i++) {
    assert.equal(codexRepeatedToolFailure(state, call(i), errorReceipt), null);
  }
  assert.equal(codexRepeatedToolFailure(state, call(0, 'edit'), errorReceipt), null);
  assert.equal(state.dynamicToolFailure.count, 1);
});

function fixture(onToolCall = async () => errorReceipt, tool = 'relay_task') {
  const state = {
    turnId: 'test-turn', dynamicTools: [{ type: 'function', name: tool }],
    toolController: new AbortController(), onToolCall, messages: new Map(),
    approvalCancels: new Set(), done: false
  };
  const events = [], replies = [], cancellations = [], child = {};
  const runtime = {
    child, threads: new Map([['test-thread', state]]),
    _emitRun(_state, event) { events.push(event); },
    _send(message) { replies.push(message); },
    _cancel(owner, error) { cancellations.push(error); owner.cancelError = error; owner.toolController.abort(); }
  };
  const invoke = (offset, action = 'read') =>
    CodexRuntime.prototype._dynamicToolCall.call(runtime, {
      id: offset + 1, params: { threadId: 'test-thread', turnId: 'test-turn', callId: 'failure-' + offset + '-' + action,
        tool, arguments: { action, path: `source-${offset}.md`, view: 'full', offset, expectedRevision: 316 } }
    });
  const notifyItem = (type, index) => CodexRuntime.prototype._notification.call(runtime, 'item/started', {
    threadId: 'test-thread', turnId: 'test-turn', item: { id: `${type}-${index}`, type },
  });
  return { state, events, replies, cancellations, invoke, notifyItem };
}

test('Codex adapter interrupts a repeated invalid view read rather than sending unlimited tool calls', async () => {
  const f = fixture();
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; i++) {
    if (i) f.notifyItem('reasoning', i);
    await f.invoke(i * 9);
  }
  assert.equal(f.state.cancelError?.code, 'CODEX_TOOL_FAILURE_LOOP');
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.replies.length, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.state.dynamicToolCallCount, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.events.filter(event => event.type === 'tool.result').length, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  await f.invoke(10000);
  assert.equal(f.state.dynamicToolCallCount, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.cancellations.length, 1);
});

test('serialized tool calls with no intervening model progress share one recovery opportunity', async () => {
  const f = fixture(async () => staleRefReceipt, 'relay_browser');
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; i++) {
    f.notifyItem('dynamicToolCall', i);
    await f.invoke(i);
  }
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.replies.length, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.state.dynamicToolFailure.count, 1);
  assert.equal(f.state.dynamicToolFailure.total, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  f.notifyItem('reasoning', 'after-batch');
  await f.invoke(100);
  assert.equal(f.state.dynamicToolFailure.count, 2, 'a later model item marks a new recovery opportunity');
});

test('a silent repeated failure remains bounded even if the model emits no progress item', async () => {
  const f = fixture(async () => staleRefReceipt, 'relay_browser');
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.silentFailure; i++) await f.invoke(i);
  assert.equal(f.state.cancelError?.code, 'CODEX_TOOL_FAILURE_LOOP');
  assert.equal(f.state.dynamicToolFailure.count, 1);
  assert.equal(f.state.dynamicToolFailure.total, CODEX_DYNAMIC_TOOL_LIMITS.silentFailure);
  assert.equal(f.cancellations.length, 1);
});

test('stale browser failures with uncertain effects retain the strict eight-call stop', async () => {
  const uncertain = { ...staleRefReceipt, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: 'Inspect the page.', code: 'BROWSER_REF_STALE' }) }] };
  const f = fixture(async () => uncertain, 'relay_browser');
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; i++) await f.invoke(i);
  assert.equal(f.state.cancelError?.code, 'CODEX_TOOL_FAILURE_LOOP');
  assert.equal(f.state.dynamicToolFailure.count, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.cancellations.length, 1);
});

test('pre-dispatch document-change fill batch allows feedback and never replays calls', async () => {
  let calls = 0, repaired = false;
  const f = fixture(async () => { calls++; return repaired ? goodReceipt : documentChangedReceipt; }, 'relay_browser');
  for (let i = 0; i < 8; i++) { f.notifyItem('dynamicToolCall', i); await f.invoke(i, 'fill'); }
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.state.dynamicToolFailure.count, 1);
  assert.equal(calls, 8);
  repaired = true; f.notifyItem('reasoning', 'fresh-snapshot');
  await f.invoke(99, 'fill');
  assert.equal(calls, 9); assert.equal(f.state.dynamicToolFailure, null);
});
test('document-change recovery still stops repeated opportunities and silent floods', async () => {
  for (const mode of ['opportunities', 'silent']) {
    const f = fixture(async () => documentChangedReceipt, 'relay_browser');
    const limit = mode === 'silent' ? 64 : 8;
    for (let i = 0; i < limit; i++) { if (mode !== 'silent') f.notifyItem('reasoning', i); await f.invoke(i, 'fill'); }
    assert.equal(f.cancellations.length, 1);
    assert.equal(f.state.cancelError.code, 'CODEX_TOOL_FAILURE_LOOP');
  }
});
test('document-change uncertain or dispatched effects retain strict cap', async () => {
  for (const flag of [undefined, true]) {
    const receipt = { ...documentChangedReceipt, contentItems: [{type:'inputText', text:JSON.stringify({code:'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched:flag})}] };
    const f = fixture(async () => receipt, 'relay_browser');
    for (let i = 0; i < 8; i++) await f.invoke(i, 'fill');
    assert.equal(f.cancellations.length, 1);
  }
});
test('per-turn call quota also protects against a pipelined flood of successful calls', async () => {
  let dispatched = 0;
  const f = fixture(async () => { dispatched++; return goodReceipt; });
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.callsPerTurn; i++) await f.invoke(i);
  assert.equal(dispatched, CODEX_DYNAMIC_TOOL_LIMITS.callsPerTurn);
  assert.equal(f.cancellations.length, 0);
  await f.invoke(CODEX_DYNAMIC_TOOL_LIMITS.callsPerTurn);
  assert.equal(f.state.cancelError?.code, 'CODEX_TOOL_CALL_LIMIT');
  assert.equal(dispatched, CODEX_DYNAMIC_TOOL_LIMITS.callsPerTurn);
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.state.dynamicToolCallCount, CODEX_DYNAMIC_TOOL_LIMITS.callsPerTurn);
});

test('parallel distinct workspace read failures allow receipt feedback and corrected reads', async () => {
  let recovery = false;
  const f = fixture(async () => recovery ? goodReceipt : { success: false, contentItems: [{type: 'inputText', text: 'ENOENT'}] }, 'relay_workspace');
  await Promise.all(Array.from({length: 13}, (_, i) => f.invoke(i)));
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.state.dynamicToolFailure.count, 1);
  assert.equal(f.state.dynamicToolFailure.total, 13);
  f.notifyItem('reasoning', 'repair-path');
  recovery = true;
  await f.invoke(99);
  assert.equal(f.state.dynamicToolFailure, null);
  assert.equal(f.cancellations.length, 0);
});

test('workspace repeated reads and repeated batches stop after real recovery opportunities', async () => {
  for (const batchSize of [1, 3]) {
    const f = fixture(async () => errorReceipt, 'relay_workspace');
    for (let epoch = 0; epoch < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; epoch++) {
      f.notifyItem('reasoning', epoch);
      await Promise.all(Array.from({length: batchSize}, (_, i) => f.invoke(epoch * 100 + i)));
    }
    assert.equal(f.cancellations.length, 1);
    assert.equal(f.state.cancelError.code, 'CODEX_TOOL_FAILURE_LOOP');
    assert.equal(f.state.dynamicToolFailure.count, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  }
});

test('workspace read stream without feedback remains bounded by silent cap', async () => {
  const f = fixture(async () => errorReceipt, 'relay_workspace');
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.silentFailure; i++) await f.invoke(i);
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.state.dynamicToolFailure.total, CODEX_DYNAMIC_TOOL_LIMITS.silentFailure);
});

test('workspace mutations retain strict failure cap even within one model batch', async () => {
  const f = fixture(async () => errorReceipt, 'relay_workspace');
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; i++) await f.invoke(i, 'write');
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.state.dynamicToolFailure.count, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
});
test('workspace reads without a proven progress epoch retain the strict stop', () => {
  const state = {};
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure - 1; i++) assert.equal(codexRepeatedToolFailure(state, {name:'relay_workspace', arguments:{action:'read', path:`missing-${i}`}}, errorReceipt), null);
  assert.equal(codexRepeatedToolFailure(state, {name:'relay_workspace', arguments:{action:'read',path:'missing-last'}}, errorReceipt)?.code, 'CODEX_TOOL_FAILURE_LOOP');
});