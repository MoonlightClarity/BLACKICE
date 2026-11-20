import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRunEvent, compactRunHistory, retainRunEvent, RUN_EVENT_LIMITS } from '../lib/run-event-retention.mjs';

const { maxEvents, perRunBytes } = RUN_EVENT_LIMITS;
const event = (ordinal, data = { type: 'delta', text: 'trace 🧪' }) =>
  ({ type: 'agent.event', runId: 'test-run', nodeId: 'agent', ordinal, data });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const archive = { relativePath: 'run-event-archives/original.json', sha256: 'a'.repeat(64) };

function equalToFullCompaction(initial, added, { startCompacted = false } = {}) {
  const run = { id: 'test-run', events: structuredClone(initial), eventRetention: { sourceArchive: archive, omittedEvents: 2, omittedBytes: 12 } };
  if (startCompacted) compactRunHistory(run);
  const expected = structuredClone(run);
  for (const entry of added) {
    expected.events.push(compactRunEvent(entry));
    compactRunHistory(expected);
    retainRunEvent(run, entry);
    assert.deepEqual(run.events, expected.events);
    assert.deepEqual(run.eventRetention, expected.eventRetention);
  }
  assert.equal(run.eventRetention.bytes, run.events.reduce((total, entry) => total + bytes(entry), 0));
  return run;
}

test('live count cap trims the oldest auxiliary event around pinned transcript events', () => {
  const initial = Array.from({ length: maxEvents }, (_, i) => event(i));
  initial[0].data = { type: 'message', text: 'user-visible commentary' };
  initial[2].data = { type: 'steer', text: 'accepted direction', accepted: true };
  initial[4].data = { type: 'item', item: { type: 'agentMessage', text: 'assistant answer' } };
  const run = equalToFullCompaction(initial, Array.from({ length: 8 }, (_, i) => event(maxEvents + i)), { startCompacted: true });
  assert.equal(run.events.length, maxEvents);
  assert.deepEqual(run.events.slice(0, 4).map(e => e.ordinal), [0, 2, 4, 11]);
  assert.equal(run.eventRetention.omittedEvents, 10);
  assert.deepEqual(run.eventRetention.sourceArchive, archive);
});

test('live UTF-8 byte cap preserves durable pins and exact omission accounting even above the pin floor', () => {
  const initial = Array.from({ length: 250 }, (_, i) => event(i, { type: 'delta', text: '🧪'.repeat(4000) }));
  const run = equalToFullCompaction(initial, [
    event(250, { type: 'message', text: '☃'.repeat(100000) }),
    event(251, { type: 'message', text: '☃'.repeat(Math.ceil(perRunBytes / 3)) }),
    event(252)
  ], { startCompacted: true });
  assert.deepEqual(run.events.map(e => e.ordinal), [250, 251]);
  assert.equal(run.eventRetention.omittedEvents, 253);
  assert.ok(run.eventRetention.bytes > perRunBytes, 'the existing durable transcript exception remains');
});

test('a pinned transcript can exceed the count cap without evicting any message', () => {
  const initial = Array.from({ length: maxEvents }, (_, i) => event(i, { type: 'message', text: 'saved' }));
  const run = equalToFullCompaction(initial, [
    event(maxEvents, { type: 'steer', text: 'new direction' }),
    event(maxEvents + 1),
    event(maxEvents + 2)
  ], { startCompacted: true });
  assert.equal(run.events.length, maxEvents + 1);
  assert.equal(run.events.at(-1).data.type, 'steer');
  assert.equal(run.eventRetention.omittedEvents, 4);
});

test('reloaded history uses full projection at first overflow before hot trimming', () => {
  const initial = Array.from({ length: maxEvents }, (_, i) => event(i));
  initial[100].data = { type: 'task.state', state: { revision: 100, steps: [{ secret: 'unprojected fixture' }] } };
  initial[101].data = { type: 'tool.result', result: 'x'.repeat(30000) };
  const run = equalToFullCompaction(initial, [event(maxEvents), event(maxEvents + 1)]);
  assert.equal(run.events.find(e => e.ordinal === 100).data.state.steps, undefined);
  assert.equal(run.events.find(e => e.data.type === 'tool.result').data.originalBytes, bytes(initial[101]));
});

test('a saturated live history serializes only new and evicted entries at every logging depth', () => {
  for (const depth of ['off', 'on', 'maximal']) {
    const run = { id: 'test-run', directoryDiagnostics: depth };
    for (let i = 0; i < maxEvents; i++) retainRunEvent(run, event(i));
    const original = JSON.stringify;
    let serializations = 0;
    try {
      JSON.stringify = (...args) => { serializations++; return original(...args); };
      for (let i = 0; i < 20; i++) retainRunEvent(run, event(i + maxEvents));
    } finally {
      JSON.stringify = original;
    }
    assert.ok(serializations <= 100, `${depth}: ${serializations} serializations for 20 appends`);
    assert.equal(run.eventRetention.omittedEvents, 20);
    assert.equal(run.events.length, maxEvents);
    assert.equal(run.events[0].ordinal, 20);
    assert.equal(run.turnMachineTrace?.seen, depth === 'maximal' ? maxEvents + 20 : undefined);
  }
});
