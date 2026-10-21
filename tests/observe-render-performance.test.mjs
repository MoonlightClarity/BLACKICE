import test from 'node:test';
import assert from 'node:assert/strict';
import { initObserveUI } from '../public/observe-ui.mjs';

// Mount the actual controller. A controllable animation-frame source lets these
// tests exercise bursts and cancellation without timing assumptions or Electron.
function fixture(t) {
  const elements = new Map(), listeners = new Map(), frames = new Map(), watches = [];
  let serial = 0, renders = 0, eventSerial = 0;
  const element = key => {
    if (!elements.has(key)) {
      let text = '';
      const value = { innerHTML: '', hidden: false, value: '', scrollHeight: 100,
        scrollTop: 0, clientHeight: 100, classList: { toggle() {} } };
      Object.defineProperty(value, 'textContent', { get: () => text, set(next) {
        if (key === '#observe-live-title') {
          renders++;
          if (value.failNext) { value.failNext = false; throw Error('injected display failure'); }
        }
        text = next;
      } });
      elements.set(key, value);
    }
    return elements.get(key);
  };
  const mount = { hidden: false, isConnected: true, innerHTML: '', classList: { add() {} },
    querySelector: element, querySelectorAll: () => [], contains: () => true,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name) };
  const run = { id: 'live', status: 'running', input: 'Observed task', settled: false,
    workflow: { nodes: [{ id: 'writer', type: 'agent', name: 'Writer' }], edges: [] },
    nodes: { writer: { status: 'running' } }, events: [] };
  const snapshot = { currentRun: run, runs: [run] };
  const ui = initObserveUI({ mount, getSnapshot: () => snapshot,
    requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    subscribe(id, handlers) {
      const watch = { id, handlers, closed: 0 }; watches.push(watch);
      return () => watch.closed++;
    } });
  t.after(() => ui.destroy());
  ui.enter();
  return { ui, mount, snapshot, run, watches, frames, element, listeners,
    get renders() { return renders; },
    flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    delta(text) { ui.handleEvent({ type: 'agent.event', runId: run.id, nodeId: 'writer',
      at: new Date(Date.parse('2026-10-21T12:00:00Z') + eventSerial++).toISOString(), data: { type: 'delta', delta: text } }); },
  };
}

const edit = (sequence, path) => ({ runId: 'live', source: 'filesystem', sequence,
  at: '2026-10-21T12:00:00Z', path, change: 'created' });

test('Observe ingests every delta immediately and its parent frame consumes one pending display update', t => {
  const f = fixture(t), before = f.renders;
  for (let index = 0; index < 1000; index++) f.delta(String(index % 10));
  assert.equal(f.frames.size, 1);
  assert.equal(f.renders, before, 'ingestion must not rebuild the view');
  const staleFrame = [...f.frames.values()][0];
  // app.js calls update() from its shared frame before this controller's frame.
  f.ui.update();
  assert.equal(f.renders, before + 1);
  assert.equal(f.frames.size, 0);
  assert.ok(f.element('#observe-feed').innerHTML.includes('0123456789'.repeat(100)), 'all deltas were ingested before either display frame');
  staleFrame();
  assert.equal(f.renders, before + 1, 'a delivered but cancelled callback cannot duplicate the parent render');
});

test('direct subscription edits and delegated messages share one frame and retain their latest evidence', t => {
  const f = fixture(t), watch = f.watches[0], before = f.renders;
  watch.handlers.onReady({ sequence: 0 });
  for (let index = 1; index <= 120; index++) {
    watch.handlers.onEdit(edit(index, `file-${index}.txt`));
    f.delta('x');
  }
  watch.handlers.onPresentation({ title: 'Latest presentation' });
  assert.equal(f.frames.size, 1);
  assert.equal(f.renders, before);
  f.flush();
  assert.equal(f.renders, before + 1);
  assert.match(f.element('#observe-pinned').innerHTML, /file-120\.txt/);
  assert.equal(f.element('#observe-live-title').textContent, 'Latest presentation');
  assert.match(f.element('#observe-feed').innerHTML, /x/);
});

test('reconnect ingestion changes edit admission synchronously before the next frame', t => {
  const f = fixture(t), handlers = f.watches[0].handlers;
  handlers.onReady({ sequence: 0 });
  handlers.onEdit(edit(8, 'before-reconnect.txt'));
  handlers.onError('Disconnected', { reconnecting: true });
  handlers.onEdit(edit(9, 'must-not-be-admitted.txt'));
  handlers.onReady({ sequence: 0, reconnected: true });
  handlers.onEdit(edit(1, 'after-reconnect.txt'));
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.match(f.element('#observe-pinned').innerHTML, /after-reconnect\.txt/);
  const history = f.element('#observe-feed').innerHTML + f.element('#observe-older-feed').innerHTML;
  assert.match(history, /before-reconnect\.txt/);
  assert.doesNotMatch(history, /must-not-be-admitted/);
  assert.equal(f.element('#observe-error').textContent, '');
  assert.match(f.element('#observe-session-note').textContent, /disconnected may be missing/);
});

test('stopping closes the subscription immediately and stale callbacks cannot add evidence', t => {
  const f = fixture(t), watch = f.watches[0], before = f.renders;
  watch.handlers.onReady({ sequence: 0 });
  f.delta('completed message');
  watch.handlers.onStopped();
  assert.equal(watch.closed, 1);
  assert.equal(f.renders, before);
  watch.handlers.onEdit(edit(1, 'late-after-stop.txt'));
  watch.handlers.onPresentation({ title: 'Stale title' });
  f.flush();
  assert.equal(f.renders, before + 1);
  assert.match(f.element('#observe-feed').innerHTML, /completed message/);
  assert.doesNotMatch(f.element('#observe-pinned').innerHTML, /late-after-stop/);
  assert.notEqual(f.element('#observe-live-title').textContent, 'Stale title');
  assert.match(f.element('#observe-session-note').textContent, /Live watching has stopped/);
});

test('leaving and reopening invalidates pending frames without cancelling new observation work', t => {
  const f = fixture(t), oldWatch = f.watches[0];
  f.delta('OLD_OBSERVATION');
  const oldFrame = [...f.frames.values()][0];
  f.ui.leave();
  assert.equal(f.frames.size, 0);
  assert.equal(oldWatch.closed, 1);
  assert.equal(f.element('#observe-feed').innerHTML, '');
  f.ui.enter();
  const before = f.renders;
  f.delta('NEW_OBSERVATION');
  oldFrame();
  oldWatch.handlers.onPresentation({ title: 'Old callback' });
  assert.equal(f.renders, before);
  assert.equal(f.frames.size, 1, 'the fresh frame survives a stale callback');
  f.flush();
  assert.match(f.element('#observe-feed').innerHTML, /NEW_OBSERVATION/);
  assert.doesNotMatch(f.element('#observe-feed').innerHTML, /OLD_OBSERVATION/);
  assert.notEqual(f.element('#observe-live-title').textContent, 'Old callback');
  f.delta('pending at destroy');
  const destroyedFrame = [...f.frames.values()][0];
  f.ui.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
  destroyedFrame();
  assert.equal(f.element('#observe-feed').innerHTML, '');
});

test('scheduled rendering rechecks visibility and does not paint a hidden workspace', t => {
  const f = fixture(t), before = f.renders;
  f.delta('hidden receipt');
  f.mount.hidden = true;
  f.flush();
  assert.equal(f.renders, before);
  f.ui.update();
  assert.equal(f.watches[0].closed, 1);
  assert.equal(f.element('#observe-feed').innerHTML, '');
});

test('a failed display frame reports the failure and does not strand future updates', t => {
  const previous = globalThis.blackiceUIResilience, errors = [];
  globalThis.blackiceUIResilience = { report: error => errors.push(error) };
  t.after(() => { if (previous === undefined) delete globalThis.blackiceUIResilience; else globalThis.blackiceUIResilience = previous; });
  const f = fixture(t);
  f.element('#observe-live-title').failNext = true;
  f.delta('first');
  assert.doesNotThrow(() => f.flush());
  assert.equal(errors.length, 1);
  assert.equal(f.frames.size, 0);
  f.delta(' second');
  f.flush();
  assert.match(f.element('#observe-feed').innerHTML, /first second/);
  assert.equal(f.frames.size, 0);
});
