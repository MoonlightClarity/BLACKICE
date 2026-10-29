import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFrontendDevtools } from '../desktop/frontend-devtools.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class FakeDebugger extends EventEmitter {
  constructor({ attached = false, handle = async () => ({}) } = {}) {
    super(); this.attached = attached; this.handle = handle; this.calls = []; this.attaches = []; this.detaches = 0;
  }
  isAttached() { return this.attached; }
  attach(version) { this.attached = true; this.attaches.push(version); }
  detach() { this.detaches++; this.attached = false; this.emit('detach', {}, 'target closed'); }
  sendCommand(method, params, sessionId) { this.calls.push({ method, params, sessionId }); return this.handle(method, params, sessionId); }
}

class FakeInspector extends EventEmitter {
  constructor() { super(); this.connects = 0; this.disconnects = 0; this.calls = []; this.handle = () => ({}); }
  connect() { this.connects++; }
  disconnect() { this.disconnects++; }
  post(method, params, callback) {
    this.calls.push({ method, params });
    try { callback(null, this.handle(method, params)); }
    catch (error) { callback(error); }
  }
}

function fakeWindow(debug = new FakeDebugger(), id = 21) {
  const contents = new EventEmitter();
  Object.assign(contents, {
    id, debugger: debug, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:1234/',
    getTitle: () => 'BLACKICE', getOSProcessId: () => 2000 + id, getZoomFactor: () => 1,
    capturePage: async () => ({ getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('PNG'), isEmpty: () => false }),
  });
  const window = { id: id + 100, webContents: contents, closes: 0, isDestroyed: () => false,
    isVisible: () => true, isFocused: () => true, isMinimized: () => false,
    getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }), close() { this.closes++; } };
  return window;
}

function setup(t, options = {}) {
  const debug = options.debug || new FakeDebugger(), window = options.window || fakeWindow(debug);
  const inspector = options.inspector || new FakeInspector();
  const controller = createFrontendDevtools({ getWindow: () => window, inspectorSessionFactory: () => inspector, ...options });
  t.after(() => controller.close());
  return { controller, window, debug, inspector };
}

test('state distinguishes actual main and renderer identity without attaching either debugger', async t => {
  const appMetrics = [{ pid: 123, type: 'Browser', cpu: { percentCPUUsage: 4 } }];
  const { controller, debug, inspector } = setup(t, { getAppMetrics: () => appMetrics });
  const state = await controller.execute({ action: 'state' });
  assert.equal(state.main.processId, process.pid);
  assert.equal(state.window.rendererProcessId, 2021);
  assert.equal(state.window.webContentsId, 21);
  assert.equal(state.window.url, 'http://127.0.0.1:1234/');
  assert.deepEqual(state.appMetrics, appMetrics);
  assert.equal(typeof state.main.cpuMicroseconds.user, 'number');
  assert.equal(typeof state.main.eventLoopUtilization.utilization, 'number');
  assert.equal(state.main.inspectorConnected, false);
  assert.equal(debug.attaches.length, 0); assert.equal(inspector.connects, 0);
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('raw frontend CDP forwards arbitrary method, exact parameters and session ID, retaining attachment across calls', async t => {
  const protocol = { arbitrary: ['response'] }, params = { nested: { owner: true } };
  const debug = new FakeDebugger({ handle: async () => protocol });
  const { controller, window } = setup(t, { debug });
  const result = await controller.execute({ action: 'cdp', method: 'Owner.CustomMethod', params, sessionId: 'worker-session' });
  assert.equal(debug.calls[0].method, 'Owner.CustomMethod');
  assert.equal(debug.calls[0].params, params);
  assert.equal(debug.calls[0].sessionId, 'worker-session');
  assert.equal(result.result, protocol);
  assert.equal(result.sessionId, 'worker-session');
  assert.equal(result.processId, null); // A child-session PID is not the host renderer PID.
  assert.equal(result.webContentsProcessId, 2021);
  await controller.execute({ action: 'cdp', method: 'Profiler.start' });
  await controller.execute({ action: 'cdp', method: 'Profiler.stop' });
  assert.deepEqual(debug.attaches, ['1.3']); assert.equal(debug.detaches, 0);
  controller.close(); controller.close();
  assert.equal(debug.detaches, 1); assert.equal(window.closes, 0);
});

test('evaluate preserves RemoteObjects and exceptions while allowing caller protocol options', async t => {
  const response = { result: { type: 'bigint', unserializableValue: '123n' }, exceptionDetails: { text: 'Uncaught', lineNumber: 7 } };
  const debug = new FakeDebugger({ handle: async () => response });
  const { controller } = setup(t, { debug });
  const receipt = await controller.execute({ action: 'evaluate', expression: '123n', params: {
    awaitPromise: false, returnByValue: false, contextId: 81, userGesture: true,
  } });
  assert.deepEqual(debug.calls[0], { method: 'Runtime.evaluate', params: {
    awaitPromise: false, returnByValue: false, contextId: 81, userGesture: true, expression: '123n',
  }, sessionId: undefined });
  assert.equal(receipt.result, response);
  assert.equal(receipt.result.result.unserializableValue, '123n');
  assert.deepEqual(receipt.result.exceptionDetails, response.exceptionDetails);
});

test('snapshot exposes its actual DOM result and reports evaluation failure without inventing a snapshot', async t => {
  let response = { result: { type: 'object', value: { url: 'http://localhost/', text: 'Conversations', controls: [] } } };
  const debug = new FakeDebugger({ handle: async () => response });
  const { controller } = setup(t, { debug });
  const receipt = await controller.execute({ action: 'snapshot', snapshotOptions: { textLimit: 0, controlLimit: 7 } });
  assert.equal(receipt.snapshot, response.result.value);
  assert.match(debug.calls[0].params.expression, /"textLimit":0,"controlLimit":7/);
  response = { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Execution context gone' } };
  const failed = await controller.execute({ action: 'snapshot' });
  assert.equal(failed.result, response); assert.equal(Object.hasOwn(failed, 'snapshot'), false);
});

test('native screenshot forwards requested rect and returns PNG image dimensions', async t => {
  const { controller, window, debug } = setup(t);
  const rect = { x: 4, y: 6, width: 240, height: 160 }; let received;
  window.webContents.capturePage = async value => {
    received = value;
    return { isEmpty: () => false, getSize: () => ({ width: 240, height: 160 }), toPNG: () => Buffer.from([137, 80, 78, 71]) };
  };
  const receipt = await controller.execute({ action: 'screenshot', rect });
  assert.equal(received, rect); assert.equal(receipt.width, 240); assert.equal(receipt.height, 160);
  assert.equal(receipt.imageUrl, 'data:image/png;base64,iVBORw==');
  assert.equal(debug.attaches.length, 0);
});

test('events paginate both targets with explicit overflow, byte accounting and selective clearing', async t => {
  const { controller, debug, inspector } = setup(t);
  await controller.execute({ action: 'cdp', method: 'Runtime.enable', eventLimit: 2, eventByteLimit: 10000 });
  for (let index = 1; index <= 3; index++) debug.emit('message', {}, 'Runtime.sample', { index }, 'child');
  let receipt = await controller.execute({ action: 'events', limit: 1, clear: true });
  assert.equal(receipt.events.length, 1); assert.equal(receipt.events[0].sequence, 2);
  assert.equal(receipt.events[0].sessionId, 'child'); assert.equal(receipt.nextCursor, 2);
  assert.equal(receipt.overflow.totalDropped, 1); assert.equal(receipt.overflow.frontend, 1);
  assert.equal(receipt.remaining, 1); assert.equal(receipt.buffered, 1); assert.equal(receipt.cleared, 1);
  await controller.execute({ action: 'cdp', target: 'main', method: 'Runtime.enable' });
  inspector.emit('inspectorNotification', { method: 'Runtime.sample', params: { index: 4 } });
  const main = await controller.execute({ action: 'events', target: 'main' });
  assert.equal(main.events.length, 1); assert.equal(main.events[0].processId, process.pid);
  receipt = await controller.execute({ action: 'events', after: 2 });
  assert.deepEqual(receipt.events.map(event => event.sequence), [3]);
  receipt.events[0].params.index = 99;
  assert.equal((await controller.execute({ action: 'events', after: 2 })).events[0].params.index, 3);
  receipt = await controller.execute({ action: 'events', eventByteLimit: 1 });
  assert.equal(receipt.buffered, 0); assert.equal(receipt.bytes, 0); assert.equal(receipt.overflow.totalDropped, 3);
  debug.emit('message', {}, 'Tracing.dataCollected', { chunk: 'large' });
  receipt = await controller.execute({ action: 'events' });
  assert.equal(receipt.events.length, 0); assert.equal(receipt.overflow.totalDropped, 4);
});

test('main inspector session persists across profiler calls and exposes its own process', async t => {
  const inspector = new FakeInspector();
  const profile = { nodes: [{ id: 1 }], samples: [1], timeDeltas: [1000] };
  inspector.handle = method => method === 'Profiler.stop' ? { profile } : {};
  const { controller, debug } = setup(t, { inspector, getWindow: () => null });
  await controller.execute({ action: 'cdp', target: 'main', method: 'Profiler.enable' });
  await controller.execute({ action: 'cdp', target: 'main', method: 'Profiler.start' });
  const receipt = await controller.execute({ action: 'cdp', target: 'main', method: 'Profiler.stop' });
  assert.equal(receipt.processId, process.pid); assert.equal(receipt.processRole, 'electron-main');
  assert.deepEqual(receipt.result.profile, profile);
  assert.equal(inspector.connects, 1); assert.equal(debug.attaches.length, 0);
  assert.equal((await controller.execute({ action: 'state' })).window, null);
  await assert.rejects(controller.execute({ action: 'cdp', target: 'main', method: 'Runtime.enable', sessionId: 'child' }),
    { code: 'MAIN_INSPECTOR_SESSION_ROUTING_UNAVAILABLE' });
  controller.close(); assert.equal(inspector.disconnects, 1);
});

test('original protocol errors propagate without retrying or replacing their data', async t => {
  const original = Object.assign(new Error('Protocol rejected the command'), { code: -32000, data: { detail: 'native' } });
  const debug = new FakeDebugger({ handle: async () => { throw original; } });
  const { controller } = setup(t, { debug });
  await assert.rejects(controller.execute({ action: 'cdp', method: 'Owner.Error' }), error => error === original);
  assert.equal(debug.calls.length, 1);
});

test('cancellation distinguishes no dispatch from an in-flight command and never replays', async t => {
  const held = deferred(), debug = new FakeDebugger({ handle: () => held.promise });
  const { controller } = setup(t, { debug });
  const before = new AbortController(); before.abort();
  await assert.rejects(controller.execute({ action: 'evaluate', expression: 'work()' }, { signal: before.signal }),
    error => error.code === 'ABORT_ERR' && error.commandDispatched === false);
  assert.equal(debug.attaches.length, 0); assert.equal(debug.calls.length, 0);
  const during = new AbortController();
  const request = controller.execute({ action: 'evaluate', expression: 'work()' }, { signal: during.signal });
  assert.equal(debug.calls.length, 1); during.abort();
  await assert.rejects(request, error => error.commandDispatched === true && error.executionMayContinue === true);
  held.resolve({ result: { type: 'undefined' } });
  await Promise.resolve(); assert.equal(debug.calls.length, 1);
});

test('closing a borrowed frontend debugger removes only this adapter listeners', async t => {
  const debug = new FakeDebugger({ attached: true }), outside = () => {};
  debug.on('message', outside);
  const { controller, window } = setup(t, { debug });
  await controller.execute({ action: 'cdp', method: 'Runtime.enable' });
  assert.equal(debug.listenerCount('message'), 2);
  controller.close();
  assert.equal(debug.detaches, 0); assert.equal(debug.isAttached(), true);
  assert.deepEqual(debug.listeners('message'), [outside]); assert.equal(window.closes, 0);
  await assert.rejects(controller.execute({ action: 'state' }), { code: 'FRONTEND_DEVTOOLS_CLOSED' });
});

test('replacing the frontend releases only owned attachment and targets the new webContents', async t => {
  const first = fakeWindow(), second = fakeWindow(new FakeDebugger(), 42); let current = first;
  const { controller } = setup(t, { getWindow: () => current });
  await controller.execute({ action: 'cdp', method: 'Runtime.enable' });
  current = second;
  const receipt = await controller.execute({ action: 'cdp', method: 'Runtime.enable' });
  assert.equal(receipt.webContentsId, 42); assert.equal(receipt.processId, 2042);
  assert.equal(first.webContents.debugger.detaches, 1);
  assert.equal(first.webContents.debugger.listenerCount('message'), 0);
  assert.equal(second.webContents.debugger.attaches.length, 1);
  controller.close(); assert.equal(second.webContents.debugger.detaches, 1);
  assert.equal(first.closes + second.closes, 0);
});

test('destroyed frontend releases listeners without calling invalid native debugger methods', async t => {
  const { controller, window, debug } = setup(t);
  await controller.execute({ action: 'cdp', method: 'Runtime.enable' });
  window.webContents.isDestroyed = () => true;
  debug.isAttached = () => { throw Error('Native object has been destroyed'); };
  assert.doesNotThrow(() => window.webContents.emit('destroyed'));
  assert.equal(debug.listenerCount('message'), 0);
  assert.equal(window.webContents.listenerCount('destroyed'), 0);
  assert.doesNotThrow(() => controller.close());
  assert.equal(window.closes, 0);
});
