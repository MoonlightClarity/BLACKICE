import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { STARTUP_PHASES, startupPhase } from '../lib/startup-timing.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('startup timing waits for the operation and measures monotonic elapsed time without changing its value', async t => {
  let time = 100.25, calls = 0;
  t.mock.method(performance, 'now', () => time);
  t.mock.method(Date, 'now', () => { throw Error('Wall clock must not measure startup.'); });
  const released = deferred(), events = [], result = { ready: true, privateValue: 'PRIVATE_OPERATION_RESULT' };
  const pending = startupPhase({ record: async event => { events.push(event); } }, 'history', async () => {
    calls++; await released.promise; time = 137.75; return result;
  });
  assert.equal(calls, 1); assert.deepEqual(events, []);
  released.resolve(); assert.equal(await pending, result);
  assert.deepEqual(events, [{ component: 'system', event: 'startup_phase', level: 'info', phase: 'history', durationMs: 38, outcome: 'ready' }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('synchronous and asynchronous failures keep their exact identity and record only failed timing metadata', async t => {
  let time = 50;
  t.mock.method(performance, 'now', () => time);
  for (const asynchronous of [false, true]) {
    const original = Object.assign(new Error('PRIVATE_STARTUP_PATH_AND_CONTENT'), { code: 'PRIVATE_CODE' }), events = [];
    const operation = () => { time += 12.2; if (asynchronous) return Promise.reject(original); throw original; };
    try { await startupPhase({ record: event => { events.push(event); } }, 'browser', operation); assert.fail('The operation must fail.'); }
    catch (error) { assert.equal(error, original); }
    assert.deepEqual(events, [{ component: 'system', event: 'startup_phase', level: 'error', phase: 'browser', durationMs: 12, outcome: 'failed' }]);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  }
});

test('diagnostic throws, rejected writes and unavailable stores cannot replace successful values or original errors', async () => {
  const stores = [undefined, {}, { get record() { throw Error('PRIVATE_GETTER'); } },
    { record() { throw Error('PRIVATE_WRITE_FAILURE'); } }, { record: async () => { throw Error('PRIVATE_ASYNC_WRITE_FAILURE'); } }];
  for (const diagnostics of stores) {
    const result = { private: 'PRIVATE_RESULT' }, failure = { private: 'PRIVATE_ORIGINAL_REJECTION' };
    assert.equal(await startupPhase(diagnostics, 'conversations', () => result), result);
    let caught = false;
    try { await startupPhase(diagnostics, 'direct-jobs', async () => { throw failure; }); }
    catch (error) { caught = true; assert.equal(error, failure); }
    assert.equal(caught, true);
  }
});

test('untrusted phases are rejected before operation, clock reads or diagnostic calls', async t => {
  let operations = 0, writes = 0, clockReads = 0, coerced = false;
  t.mock.method(performance, 'now', () => { clockReads++; return 0; });
  const diagnostics = { record() { writes++; } }, operation = () => { operations++; };
  for (const phase of [undefined, null, '', 'Browser', 'history/PRIVATE_PATH', 'https://PRIVATE_URL.example/', 'window\nPRIVATE_MESSAGE', 1,
    { toString() { coerced = true; return 'browser'; }, toJSON() { coerced = true; return 'PRIVATE_PAYLOAD'; } }, ['browser']]) {
    await assert.rejects(startupPhase(diagnostics, phase, operation), { name: 'TypeError', message: 'Use a supported startup phase.' });
  }
  assert.deepEqual({ operations, writes, clockReads, coerced }, { operations: 0, writes: 0, clockReads: 0, coerced: false });
});

test('every supported phase records a bounded integer duration and invalid operations never run', async t => {
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  const events = [], diagnostics = { record: event => { events.push(event); } };
  for (const phase of STARTUP_PHASES) await startupPhase(diagnostics, phase, () => { time += 2; return phase; });
  assert.deepEqual(events.map(event => event.phase), [...STARTUP_PHASES]);
  assert.ok(events.every(event => event.durationMs === 2 && event.outcome === 'ready'));
  await startupPhase(diagnostics, 'window', () => { time += 2 * 86_400_000; });
  assert.equal(events.at(-1).durationMs, 86_400_000);
  const before = events.length;
  await assert.rejects(startupPhase(diagnostics, 'history', null), { name: 'TypeError', message: 'A startup phase requires an operation.' });
  assert.equal(events.length, before);
});
