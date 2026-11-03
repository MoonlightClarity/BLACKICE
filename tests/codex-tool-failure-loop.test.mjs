import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CODEX_DYNAMIC_TOOL_LIMITS, codexRepeatedToolFailure } from '../lib/codex.mjs';

const errorReceipt = Object.freeze({ success: false, code: 'INVALID_TASK_VIEW', contentItems: [{ type: 'inputText', text: 'Use the returned expectedRevision and viewHash; restart the first page when absent.' }] });
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

function fixture(onToolCall = async () => errorReceipt) {
  const state = {
    turnId: 'test-turn', dynamicTools: [{ type: 'function', name: 'relay_task' }],
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
        tool: 'relay_task', arguments: { action, view: 'full', offset, expectedRevision: 316 } }
    });
  return { state, events, replies, cancellations, invoke };
}

test('Codex adapter interrupts a repeated invalid view read rather than sending unlimited tool calls', async () => {
  const f = fixture();
  for (let i = 0; i < CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure; i++) await f.invoke(i * 9);
  assert.equal(f.state.cancelError?.code, 'CODEX_TOOL_FAILURE_LOOP');
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.replies.length, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.state.dynamicToolCallCount, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.events.filter(event => event.type === 'tool.result').length, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  await f.invoke(10000);
  assert.equal(f.state.dynamicToolCallCount, CODEX_DYNAMIC_TOOL_LIMITS.repeatedFailure);
  assert.equal(f.cancellations.length, 1);
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
