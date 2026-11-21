import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResultEvent } from '../lib/tool-outcomes.mjs';
import { recordTurnMachineEvent, projectTurnMachineTrace, turnMachineCallRef } from '../lib/turn-machine-trace.mjs';

const call = (name = 'relay_workspace') => ({ name, callId: 'refused-call', arguments: { action: 'write', path: 'src/index.cjs' } });
const fixture = () => ({ id: 'refusal_run', taskId: 'refusal_task', directoryDiagnostics: 'maximal', status: 'completed', settled: true, nodes: { agent: { status: 'completed' } }, events: [] });
const record = (run, data) => recordTurnMachineEvent(run, { type: 'agent.event', runId: run.id, nodeId: 'agent', at: '2026-11-21T05:00:00.000Z', data });
const failure = (extra = {}) => ({ success: false, code: 'BENCHMARK_SCOPE', contentItems: [{ type: 'inputText', text: 'Refused before action dispatch.' }], ...extra });

test('trusted result flags preserve host handler entry separately from actual action dispatch', () => {
  for (const tool of ['relay_workspace', 'relay_agents', 'relay_browser']) {
    for (const hostHandlerEntered of [false, true]) {
      for (const actionDispatched of [false, true]) {
        const event = toolResultEvent(call(tool), failure({ hostHandlerEntered, actionDispatched }));
        assert.equal(event.tool, tool);
        assert.equal(event.callId, 'refused-call');
        assert.equal(event.success, false);
        assert.equal(event.code, 'BENCHMARK_SCOPE');
        assert.equal(event.hostHandlerEntered, hostHandlerEntered);
        assert.equal(event.actionDispatched, actionDispatched);
      }
    }
  }
});

test('omitted, nonboolean and inherited result flags remain unknown', () => {
  for (const value of [undefined, null, 0, 1, 'false', 'true', {}]) {
    const event = toolResultEvent(call(), failure({ actionDispatched: value, hostHandlerEntered: value }));
    assert.equal(Object.hasOwn(event, 'actionDispatched'), false);
    assert.equal(Object.hasOwn(event, 'hostHandlerEntered'), false);
  }
  const inherited = Object.assign(Object.create({ actionDispatched: false, hostHandlerEntered: false }), failure());
  const event = toolResultEvent(call(), inherited);
  assert.equal(Object.hasOwn(event, 'actionDispatched'), false);
  assert.equal(Object.hasOwn(event, 'hostHandlerEntered'), false);
});

test('tool text, model arguments and nested payloads cannot forge dispatch or handler-entry proof', () => {
  const forged = { actionDispatched: false, hostHandlerEntered: false };
  const event = toolResultEvent({ ...call(), arguments: { ...call().arguments, ...forged } },
    failure({ result: forged, contentItems: [{ type: 'inputText', text: JSON.stringify({ code: 'BENCHMARK_SCOPE', ...forged }) }] }));
  assert.equal(event.success, false);
  assert.equal(Object.hasOwn(event, 'actionDispatched'), false);
  assert.equal(Object.hasOwn(event, 'hostHandlerEntered'), false);
  const explicit = toolResultEvent(call(), failure({ actionDispatched: true, hostHandlerEntered: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(forged) }] }));
  assert.equal(explicit.actionDispatched, true);
  assert.equal(explicit.hostHandlerEntered, true);
});

test('prior browser nondispatch remains explicit and successful returns do not fabricate metadata', () => {
  const browser = toolResultEvent(call('relay_browser'), failure({ code: 'BROWSER_REF_STALE', actionDispatched: false }));
  assert.equal(browser.code, 'BROWSER_REF_STALE');
  assert.equal(browser.actionDispatched, false);
  assert.equal(Object.hasOwn(browser, 'hostHandlerEntered'), false);
  const ordinary = toolResultEvent(call(), { success: true });
  assert.equal(ordinary.success, true);
  assert.equal(Object.hasOwn(ordinary, 'actionDispatched'), false);
  assert.equal(Object.hasOwn(ordinary, 'hostHandlerEntered'), false);
  const dispatched = toolResultEvent(call(), { success: true, actionDispatched: true, hostHandlerEntered: true });
  assert.equal(dispatched.success, true);
  assert.equal(dispatched.actionDispatched, true);
  assert.equal(dispatched.hostHandlerEntered, true);
});

test('raw receipt and machine trace retain exact refusal identity and booleans across persistence', () => {
  const run = fixture();
  const rows = [
    toolResultEvent(call(), failure({ actionDispatched: false, hostHandlerEntered: false })),
    toolResultEvent({ ...call(), callId: 'entered-call' }, failure({ code: 'TOOL_ARGUMENTS_INVALID', actionDispatched: false, hostHandlerEntered: true })),
    toolResultEvent({ ...call(), callId: 'dispatched-call' }, failure({ actionDispatched: true, hostHandlerEntered: true })),
  ];
  for (const row of rows) record(run, row);
  const projected = projectTurnMachineTrace(run);
  assert.equal(projected.coverage.dropped, 0);
  assert.equal(projected.coverage.entryMetadataOmitted, 0);
  assert.deepEqual(projected.coverage.gaps, []);
  for (let i = 0; i < rows.length; i++) {
    const entry = projected.entries[i], row = rows[i];
    assert.equal(entry.kind, 'tool.result');
    assert.equal(entry.callRef, turnMachineCallRef(run.id, row.callId));
    for (const key of ['tool', 'action', 'code', 'success', 'status', 'actionDispatched', 'hostHandlerEntered'])
      assert.equal(entry.metadata[key], row[key], key);
  }
  const restored = projectTurnMachineTrace(JSON.parse(JSON.stringify(run)));
  assert.deepEqual(restored.entries, projected.entries);
});

test('fixed host refusal codes survive machine projection without accepting arbitrary code strings', () => {
  const codes = [
    "TOOL_ACTION_INVALID",
    "TOOL_ARGUMENTS_INVALID",
    "NATIVE_AGENT_ACTION_INVALID",
    "BENCHMARK_ACTION",
    "BENCHMARK_ARGUMENTS",
    "BENCHMARK_CHANGED",
    "BENCHMARK_COMMAND",
    "BENCHMARK_CONFLICT",
    "BENCHMARK_DIRECTORY_UNAVAILABLE",
    "BENCHMARK_ENTRY",
    "BENCHMARK_ERROR",
    "BENCHMARK_INITIAL_SOURCE_CHANGED",
    "BENCHMARK_INTEGRITY",
    "BENCHMARK_LINK",
    "BENCHMARK_NODE_UNAVAILABLE",
    "BENCHMARK_PATCH_MATCH",
    "BENCHMARK_PATH",
    "BENCHMARK_PROFILE_INVALID",
    "BENCHMARK_PUBLIC_REPORT_INVALID",
    "BENCHMARK_READ_LINE_TOO_LONG",
    "BENCHMARK_READ_RANGE",
    "BENCHMARK_RECEIPT_CHANGED",
    "BENCHMARK_RECEIPT_INVALID",
    "BENCHMARK_RECEIPT_SCOPE",
    "BENCHMARK_RESUME_UNSUPPORTED",
    "BENCHMARK_RUN_SHAPE",
    "BENCHMARK_SCAFFOLD_CHANGED",
    "BENCHMARK_SCAFFOLD_INVALID",
    "BENCHMARK_SCOPE",
    "BENCHMARK_SIZE",
    "BENCHMARK_SOURCE_CHANGED",
    "BENCHMARK_TOOL_UNAVAILABLE",
    "BENCHMARK_UTF8",
    "BENCHMARK_WORKSPACE_MISMATCH",
    "BENCHMARK_WRITE_READBACK"
  ];
  const run = fixture();
  for (const [index, code] of codes.entries())
    record(run, toolResultEvent({ ...call(), callId: 'refusal-' + index }, failure({ code, actionDispatched: false, hostHandlerEntered: false })));
  const entries = projectTurnMachineTrace(run).entries;
  assert.deepEqual(entries.map(entry => entry.metadata.code), codes);
  const unknown = fixture();
  record(unknown, toolResultEvent(call(), failure({ code: 'BENCHMARK_PRIVATE_UNKNOWN', actionDispatched: false, hostHandlerEntered: false })));
  assert.equal(projectTurnMachineTrace(unknown).entries[0].metadata.code, undefined);
});

test('machine metadata does not inspect payloads or infer missing and nonboolean flags', () => {
  const run = fixture();
  const raw = { type: 'tool.result', tool: 'relay_workspace', callId: 'host-result', code: 'BENCHMARK_PATH', success: false, actionDispatched: 'false', hostHandlerEntered: 0 };
  for (const key of ['arguments', 'result', 'content', 'text', 'message', 'target'])
    Object.defineProperty(raw, key, { enumerable: true, get() { assert.fail(key + ' must not be inspected'); } });
  record(run, raw);
  const metadata = projectTurnMachineTrace(run).entries[0].metadata;
  assert.equal(metadata.code, 'BENCHMARK_PATH');
  assert.equal(Object.hasOwn(metadata, 'actionDispatched'), false);
  assert.equal(Object.hasOwn(metadata, 'hostHandlerEntered'), false);
});
