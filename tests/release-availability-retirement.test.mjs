import test from 'node:test';
import assert from 'node:assert/strict';
import { retireReleaseAvailability } from '../scripts/release-availability-retirement.mjs';

const identity = { id: 'release-test-responder', pid: 42, port: 51000 };
const generation = 7;
const closedPing = () => ({
  ...identity, generation, targetAttached: false, lifetimeConnected: false,
  state: { app: 'BLACKICE', available: false, state: 'closed', code: 'BLACKICE_CLOSED' },
});

function fixture(options = {}) {
  const trace = [], pings = [], intents = [];
  let admissions = 0, pingIndex = 0, stops = 0, observations = 0;
  const callbacks = {
    marker: { ...identity },
    expectedGeneration: generation,
    async control(action) {
      trace.push(action);
      if (action === 'ping') {
        const reply = { ...closedPing(), ...(options.pingChanges?.[pingIndex++] || {}) };
        pings.push(reply);
        return reply;
      }
      assert.equal(action, 'stop');
      stops++;
      if (options.stopError) throw options.stopError;
      return Object.hasOwn(options, 'stopReply') ? options.stopReply : { id: identity.id, stopping: true };
    },
    async verifyAdmission() {
      trace.push('admission');
      admissions++;
      return options.admit ? options.admit(admissions) : true;
    },
    async recordStopIntent(value) {
      trace.push('intent');
      intents.push(value);
      if (options.intentError) throw options.intentError;
      return Object.hasOwn(options, 'intentResult') ? options.intentResult : true;
    },
    async observeRetirement() {
      trace.push('observe');
      observations++;
      if (options.observationError) throw options.observationError;
      return Object.hasOwn(options, 'observationResult') ? options.observationResult : true;
    },
  };
  return {
    trace, pings, intents, callbacks,
    run: () => retireReleaseAvailability(callbacks),
    counts: () => ({ admissions, stops, observations }),
  };
}

test('release retirement composes raw closed pings, durable intent, one stop and observed completion', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { retired: true, stopAcknowledged: true, stopErrorCode: null });
  assert.deepEqual(f.trace, ['admission', 'ping', 'admission', 'ping', 'intent', 'admission', 'stop', 'observe']);
  assert.deepEqual(f.counts(), { admissions: 3, stops: 1, observations: 1 });
  assert.equal(f.pings.length, 2);
  for (const ping of f.pings) assert.deepEqual(ping.state, closedPing().state);
  assert.deepEqual(f.intents, [{ ...identity, generation }]);
  assert.equal(Object.isFrozen(f.intents[0]), true);
  assert.deepEqual(Object.keys(f.intents[0]).sort(), ['generation', 'id', 'pid', 'port']);
});

test('both raw ping checks refuse changed identity, generation, attachment or flattened state', async () => {
  const invalid = [
    { id: 'another-responder' }, { pid: identity.pid + 1 }, { port: identity.port + 1 },
    { generation: generation + 1 }, { targetAttached: true }, { lifetimeConnected: true },
    { state: { state: 'closing' } }, { state: 'closed' },
  ];
  for (const change of invalid) {
    for (const index of [0, 1]) {
      const pingChanges = index === 0 ? [change] : [{}, change];
      const f = fixture({ pingChanges });
      await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_PING' });
      assert.equal(f.counts().stops, 0);
      assert.equal(f.counts().observations, 0);
      assert.equal(f.intents.length, 0);
      assert.equal(f.pings.length, index + 1);
    }
  }
});

test('every caller admission requires explicit true, including the recheck after intent', async () => {
  for (const refusedAt of [1, 2, 3]) {
    for (const result of [false, undefined]) {
      const f = fixture({ admit: call => call === refusedAt ? result : true });
      await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_ADMISSION' });
      assert.equal(f.counts().admissions, refusedAt);
      assert.equal(f.counts().stops, 0);
      assert.equal(f.counts().observations, 0);
      assert.equal(f.intents.length, refusedAt === 3 ? 1 : 0);
    }
  }
});

test('a caller ownership exception after intent prevents stop', async () => {
  const changedOwner = new Error('fixture: caller observed a newly opened owner');
  const f = fixture({ admit: call => { if (call === 3) throw changedOwner; return true; } });
  await assert.rejects(f.run(), error => error === changedOwner);
  assert.deepEqual(f.counts(), { admissions: 3, stops: 0, observations: 0 });
});

test('durable intent must succeed explicitly before the stop request', async () => {
  for (const intentResult of [false, undefined]) {
    const f = fixture({ intentResult });
    await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_INTENT' });
    assert.equal(f.counts().stops, 0);
    assert.equal(f.counts().observations, 0);
  }
  const intentError = new Error('fixture: durable receipt unavailable');
  const f = fixture({ intentError });
  await assert.rejects(f.run(), error => error === intentError);
  assert.equal(f.counts().stops, 0);
});

test('uncertain stop acknowledgements use one observation and never resend stop', async () => {
  for (const stopReply of [null, {}, { id: 'another-responder', stopping: true }, { id: identity.id, stopping: false }]) {
    const f = fixture({ stopReply });
    assert.deepEqual(await f.run(), {
      retired: true, stopAcknowledged: false,
      stopErrorCode: 'RELEASE_AVAILABILITY_STOP_ACK_UNCONFIRMED',
    });
    assert.deepEqual(f.counts(), { admissions: 3, stops: 1, observations: 1 });
    assert.deepEqual(f.trace.slice(-2), ['stop', 'observe']);
  }
});

test('stop transport errors are sanitized and reconciled without replay', async () => {
  const stopError = Object.assign(new Error('fixture-private-transport-detail'), { code: 'FIXTURE_PRIVATE_CODE' });
  const f = fixture({ stopError });
  const result = await f.run();
  assert.deepEqual(result, {
    retired: true, stopAcknowledged: false,
    stopErrorCode: 'RELEASE_AVAILABILITY_STOP_REQUEST_FAILED',
  });
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
  assert.equal(JSON.stringify(result).includes('FIXTURE_PRIVATE_CODE'), false);
  assert.deepEqual(f.counts(), { admissions: 3, stops: 1, observations: 1 });
});

test('positive retirement proof is required after either acknowledged or uncertain stop', async () => {
  for (const observationResult of [false, undefined]) {
    for (const uncertain of [false, true]) {
      const f = fixture({
        observationResult,
        ...(uncertain ? { stopError: new Error('fixture: lost acknowledgement') } : {}),
      });
      await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_RETIREMENT_UNCONFIRMED' });
      assert.deepEqual(f.counts(), { admissions: 3, stops: 1, observations: 1 });
    }
  }
});

test('an observation exception preserves uncertainty without a second stop', async () => {
  const observationError = new Error('fixture: bounded retirement observation timed out');
  const f = fixture({ observationError, stopError: new Error('fixture: lost acknowledgement') });
  await assert.rejects(f.run(), error => error === observationError);
  assert.deepEqual(f.counts(), { admissions: 3, stops: 1, observations: 1 });
});

test('public input rejects secret marker fields and missing callback contracts before control', async () => {
  for (const marker of [
    { ...identity, token: 'synthetic-field-must-not-enter-helper' },
    { ...identity, controlPort: 51001 },
    { ...identity, id: '' }, { ...identity, pid: 0 }, { ...identity, port: 1023 },
  ]) {
    const f = fixture();
    f.callbacks.marker = marker;
    await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_INPUT' });
    assert.deepEqual(f.trace, []);
  }
  for (const expectedGeneration of [undefined, 0, 1.5]) {
    const f = fixture();
    f.callbacks.expectedGeneration = expectedGeneration;
    await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_INPUT' });
    assert.deepEqual(f.trace, []);
  }
  for (const key of ['control', 'verifyAdmission', 'recordStopIntent', 'observeRetirement']) {
    const f = fixture();
    delete f.callbacks[key];
    await assert.rejects(f.run(), { code: 'RELEASE_AVAILABILITY_INPUT' });
    assert.deepEqual(f.trace, []);
  }
});

