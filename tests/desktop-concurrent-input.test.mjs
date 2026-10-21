import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopController } from '../lib/desktop.mjs';
import { createDesktopToolHandler } from '../lib/desktop-tools.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ref = 'uia_0123456789ab_1';

test('concurrent user cursor movement is returned as observation and never rejects, replays or redirects desktop inspection', async () => {
  // This state is entirely synthetic. The test never reads or moves the real pointer.
  const user = { cursorX: 100, cursorY: 200, foreground: 'user-window' }, fixture = { value: 'Existing text', inspections: 0 };
  const entered = deferred(), release = deferred(), requests = [], events = [];
  const desktop = new DesktopController({ platform: 'win32', runner: async request => {
    requests.push(structuredClone(request)); const before = { ...user };
    if (request.action === 'get_text') { entered.resolve(); await release.promise; }
    else if (request.action === 'inspect') fixture.inspections++;
    else assert.fail(`Unexpected native action: ${request.action}`);
    return { ok: true, mode: 'background_uia', physicalInput: false, mechanism: 'accessibility-inspection', observedInput: { cursorMoved: before.cursorX !== user.cursorX || before.cursorY !== user.cursorY, foregroundChanged: before.foreground !== user.foreground }, text: fixture.value };
  } });
  desktop.setEnabled(true); const invoke = createDesktopToolHandler({ desktop, onEvent: event => events.push(event) });
  const work = invoke({ name: 'relay_desktop', arguments: { action: 'get_text', ref } }); await entered.promise;
  user.cursorX = 750; user.cursorY = 350; release.resolve();
  const result = await work, metadata = JSON.parse(result.contentItems[0].text);
  assert.equal(result.success, true); assert.equal(fixture.value, 'Existing text'); assert.equal(metadata.text, 'Existing text');
  assert.deepEqual(metadata.observedInput, { cursorMoved: true, foregroundChanged: false }); assert.equal(metadata.physicalInput, false);
  assert.deepEqual(user, { cursorX: 750, cursorY: 350, foreground: 'user-window' }, 'the controller never restores or owns the user’s pointer');
  assert.deepEqual(requests, [{ action: 'get_text', ref, maxCharacters: 4000 }], 'movement must not trigger a replay, coordinate fallback or focus action');
  assert.equal(desktop.status().enabled, true); assert.equal(desktop.status().lastError, null);
  assert.deepEqual(events.map(event => event.status), ['running', 'completed']);
  const next = await invoke({ name: 'relay_desktop', arguments: { action: 'inspect', ref } }); assert.equal(next.success, true); assert.equal(fixture.inspections, 1);
  assert.deepEqual(requests.map(request => request.action), ['get_text', 'inspect']);
});

test('a concurrent user foreground change stays observational and is not attributed to Relay or used to seize focus back', async () => {
  const user = { foreground: 'first-user-window' }, entered = deferred(), release = deferred(), requests = [];
  const desktop = new DesktopController({ platform: 'win32', runner: async request => {
    requests.push(structuredClone(request)); const originalForeground = user.foreground; entered.resolve(); await release.promise;
    return { ok: true, physicalInput: false, observedInput: { cursorMoved: false, foregroundChanged: originalForeground !== user.foreground }, providerNote: 'The foreground changed during this action. An application provider or concurrent user activity can change focus; Relay did not request focus.' };
  } });
  desktop.setEnabled(true); const invoke = createDesktopToolHandler({ desktop });
  const work = invoke({ name: 'relay_desktop', arguments: { action: 'inspect', ref } }); await entered.promise;
  user.foreground = 'second-user-window'; release.resolve();
  const result = await work, metadata = JSON.parse(result.contentItems[0].text);
  assert.equal(result.success, true); assert.deepEqual(metadata.observedInput, { cursorMoved: false, foregroundChanged: true });
  assert.match(metadata.providerNote, /application provider or concurrent user activity/); assert.match(metadata.providerNote, /Relay did not request focus/);
  assert.equal(user.foreground, 'second-user-window'); assert.deepEqual(requests, [{ action: 'inspect', ref, query: '', maxDepth: 5, maxNodes: 150 }]);
  assert.equal(desktop.status().enabled, true); assert.equal(desktop.status().lastError, null);
});
