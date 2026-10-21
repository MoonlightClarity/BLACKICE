import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LazyFirefoxDriver } from '../desktop/firefox-lazy.mjs';

function fixture({ startResult } = {}) {
  const calls = { discover: 0, start: 0, create: 0, close: 0, stop: 0 };
  const driver = new LazyFirefoxDriver({
    discover: async () => { calls.discover++; return { available: true, profileName: 'fixture', reason: 'Existing profile' }; },
    start: async () => { calls.start++; return startResult || { started: true, ready: true, endpoint: 'ws://127.0.0.1:1234/session', profileName: 'fixture', stop: async () => { calls.stop++; return { closed: true }; } }; },
    createDriver: async options => {
      calls.create++; const child = new EventEmitter(); child.closed = false; child.connected = true;
      child.status = () => ({ tabs: [], activeTab: null });
      child.perform = async args => ({ tabId: 'task', action: args.action });
      child.close = async () => { calls.close++; child.closed = true; await options.onClose(); };
      return child;
    },
  });
  return { driver, calls };
}

test('Firefox status and closing an unused adapter never launch or read authentication', async () => {
  const { driver, calls } = fixture(); await driver.init();
  driver.status(); await driver.perform({ action: 'tabs' }); await driver.perform({ action: 'downloads' }); await driver.close();
  assert.deepEqual(calls, { discover: 1, start: 0, create: 0, close: 0, stop: 0 });
});

test('Firefox starts only for an explicit task and waits for profile release before disconnect completes', async () => {
  const { driver, calls } = fixture(); await driver.init();
  await driver.perform({ action: 'open', url: 'https://example.test/' }); await driver.perform({ action: 'snapshot', tabId: 'task' });
  assert.equal(driver.status().firefox.connected, true); assert.equal(calls.start, 1);
  await driver.disconnect(); assert.equal(driver.status().firefox.connected, false); assert.equal(driver.status().firefox.running, false);
  assert.equal(calls.close, 1); assert.equal(calls.stop, 1);
  await driver.perform({ action: 'open', url: 'https://example.test/' }); assert.equal(calls.start, 2); await driver.close();
});

test('running or unavailable Firefox refuses tasks without connecting to a different profile', async () => {
  const { driver, calls } = fixture({ startResult: { started: false, reason: 'Firefox is already running.' } }); await driver.init();
  await assert.rejects(driver.perform({ action: 'open', url: 'https://example.test/' }), /already running/); assert.equal(calls.create, 0); await driver.close();
});

test('cancellation after Firefox starts still closes it and releases its profile without a self-wait deadlock', async () => {
  const { driver, calls } = fixture(); await driver.init(); const controller = new AbortController();
  const create = driver.createDriver; driver.createDriver = async options => { const child = await create(options); controller.abort(); return child; };
  await assert.rejects(driver.perform({ action: 'open', url: 'https://example.test/' }, { signal: controller.signal }), /cancelled/);
  assert.equal(calls.close, 1); assert.equal(calls.stop, 1); assert.equal(driver.status().firefox.running, false); await driver.close();
});

test('failed handshake retains ownership and disconnect retries supported cleanup until exit is confirmed', async () => {
  let running = true, stops = 0, starts = 0, cleanups = 0;
  const launch = { started: true, ready: true, endpoint: 'ws://127.0.0.1:1234/session', owned: true,
    get running() { return running; }, stop: async ({ closeBrowser }) => { stops++; await closeBrowser({endpoint:launch.endpoint}); if (stops > 1) running = false; return {closed:!running}; } };
  const adapter = new LazyFirefoxDriver({ discover:async()=>({available:true}), start:async()=>{starts++;return launch;},
    createDriver:async()=>{throw Error('Handshake failed');}, closeSession:async()=>{cleanups++;} });
  await adapter.init(); await assert.rejects(adapter.ensure(), /Handshake/);
  assert.equal(adapter.status().firefox.recoveryRequired,true);
  await assert.rejects(adapter.disconnect(), /clean exit/); assert.equal(adapter.launched,launch);
  await adapter.disconnect(); assert.equal(starts,1); assert.equal(cleanups,2); assert.equal(adapter.status().firefox.running,false);
  await adapter.close();
});

test('concurrent disconnect callers share cleanup and reject new actions until it finishes', async () => {
  const {driver,calls}=fixture(); await driver.init(); await driver.ensure();
  let release; const close=driver.driver.close;
  driver.driver.close=async()=>{await new Promise(resolve=>release=resolve);await close();};
  const first=driver.disconnect(),second=driver.disconnect(); assert.equal(first,second);
  await assert.rejects(driver.ensure(),/closing/); release(); await first; assert.equal(calls.close,1); await driver.close();
});

test('reconnecting a closed transport retains the running owned Firefox handle instead of starting again', async () => {
  let running = true, starts = 0, creates = 0, stops = 0;
  const launch = { started: true, ready: true, owned: true, endpoint: 'ws://127.0.0.1:1234/session', get running() { return running; },
    stop: async () => { stops++; running = false; return { closed: true }; } };
  const adapter = new LazyFirefoxDriver({ discover: async () => ({ available: true }),
    start: async () => { starts++; return starts === 1 ? launch : { started: false, reason: 'Firefox is already running.' }; },
    createDriver: async options => {
      creates++; assert.equal(options.endpoint, launch.endpoint);
      const driver = new EventEmitter(); driver.connected = true; driver.closed = false; driver.status = () => ({ tabs: [] });
      driver.close = async () => { driver.closed = true; driver.connected = false; await options.onClose(); }; return driver;
    } });
  try {
    await adapter.init(); const disconnected = await adapter.ensure(); disconnected.closed = true; disconnected.connected = false;
    const restored = await adapter.ensure(); assert.notEqual(restored, disconnected);
    assert.equal(starts, 1, 'a failed transport must not launch another process or overwrite its existing handle');
    assert.equal(creates, 2); assert.equal(adapter.launched, launch); assert.equal(adapter.status().firefox.connected, true);
    await adapter.disconnect(); assert.equal(stops, 1); assert.equal(running, false);
  } finally { await adapter.close(); }
});

test('retrying a failed handshake reconnects through its retained owned endpoint and still closes that process', async () => {
  let running = true, starts = 0, creates = 0, stops = 0;
  const launch = { started: true, ready: true, owned: true, endpoint: 'ws://127.0.0.1:1234/session', get running() { return running; },
    stop: async () => { stops++; running = false; return { closed: true }; } };
  const adapter = new LazyFirefoxDriver({ discover: async () => ({ available: true }),
    start: async () => { starts++; return starts === 1 ? launch : { started: false, reason: 'Firefox is already running.' }; },
    createDriver: async options => {
      if (++creates === 1) throw new Error('Disposable handshake failed.');
      assert.equal(options.endpoint, launch.endpoint);
      const driver = new EventEmitter(); driver.connected = true; driver.closed = false; driver.status = () => ({ tabs: [] });
      driver.close = async () => { driver.closed = true; driver.connected = false; await options.onClose(); }; return driver;
    } });
  try {
    await adapter.init(); await assert.rejects(adapter.ensure(), /handshake failed/);
    assert.equal(adapter.launched, launch); assert.equal(adapter.status().firefox.running, true);
    await adapter.ensure(); assert.equal(starts, 1); assert.equal(creates, 2); assert.equal(adapter.launched, launch);
    await adapter.disconnect(); assert.equal(stops, 1); assert.equal(running, false);
  } finally { await adapter.close(); }
});
