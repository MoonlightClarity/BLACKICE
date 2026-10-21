import test from 'node:test';
import assert from 'node:assert/strict';
import { initConfigureUI } from '../public/configure-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

test('remote Settings keeps its mounted pairing and credential draft through unrelated renders and status updates', async t => {
  let ui; t.after(() => ui?.destroy()); const f = planningDOM(t), calls = [], updates = [], instances = [];
  const snapshot = { status: { connected: true, authenticated: true, defaultModel: 'default', remoteAccess: { state: 'disabled' }, desktopLifecycle: { visible: true }, runtimeSettings: {} }, workflows: [] };
  ui = initConfigureUI({ mount: f.mount, getSnapshot: () => snapshot, api: async (...args) => { calls.push(args); return { visible: false }; }, mountRemote(options) {
    instances.push(options); options.mount.innerHTML = '<input id="remote-agent-name" value="Review agent"><output id="remote-agent-token">one-time-credential</output><button id="desktop-background">Keep running</button>';
    return { update(value) { updates.push(value); }, destroy() { instances.push('destroyed'); } };
  } });
  const remote = f.$('#configure-remote-mount'), name = f.$('#remote-agent-name'), token = f.$('#remote-agent-token'); name.value = 'My unsaved agent name'; name.focus(); name.setSelectionRange(3, 12, 'backward');
  snapshot.status.defaultModel = 'provider::changed'; snapshot.status.remoteAccess = { state: 'ready', enabled: true }; ui.update();
  assert.equal(f.$('#configure-remote-mount'), remote); assert.equal(f.$('#remote-agent-name'), name); assert.equal(f.$('#remote-agent-token'), token); assert.equal(token.textContent, 'one-time-credential'); assert.equal(name.value, 'My unsaved agent name'); assert.equal(document.activeElement, name); assert.deepEqual([name.selectionStart, name.selectionEnd, name.selectionDirection], [3, 12, 'backward']); assert.equal(instances.length, 1); assert.equal(updates.at(-1).status.state, 'ready');
  await instances[0].onBackground(); assert.deepEqual(calls.at(-1), ['/api/desktop/background', 'POST', {}]);
});
