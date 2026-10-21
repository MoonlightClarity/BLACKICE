import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { initConfigureUI } from '../public/configure-ui.mjs';
import { mountChatGPTConnector, renderChatGPTConnector, connectorProgress } from '../public/chatgpt-connector-ui.mjs';
import { readFile } from 'node:fs/promises';

const setup = (overrides = {}) => ({ ready: true, stage: 'register', serverUrl: 'https://blackice.example/mcp/chatgpt', chatGPTUrl: 'https://chatgpt.com/plugins', checks: [{ key: 'https', label: 'Public HTTPS', ok: true }], verification: { nonce: 'blackice-connect-fixture', prompt: 'Use BLACKICE blackice_direct_status with nonce "blackice-connect-fixture".' }, ...overrides });
const current = () => ({ enabled: true, endpoint: 'https://blackice.example/mcp/chatgpt', setup: setup(), remoteAccess: { enabled: true, mode: 'public' }, oauth: { grants: [], requests: [{ id: 'request_one', displayCode: 'ABCD1234', clientLabel: 'ChatGPT', scopes: ['read', 'files:read', 'commands:run'] }] }, pending: { jobs: [] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('permission review defaults to read and never implies chat-surface verification', () => {
  const html = renderChatGPTConnector({ current: current(), scopes: new Map(), remote: false });
  assert.match(html, /data-connector-scope="read" checked disabled/);
  assert.doesNotMatch(html, /data-connector-scope="commands:run" checked/);
  assert.match(html, /not a system sandbox/);
  assert.match(html, /does not verify the ChatGPT conversation/);
  assert.match(html, /ABCD1234/);
});

test('focused access controls and permission choices survive polling and submit the exact request', async t => {
  const f = planningDOM(t), calls = [];
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return current(); } }); t.after(() => ui.destroy()); await tick();
  const checkbox = f.$('[data-connector-scope="files:read"]'); checkbox.checked = true; checkbox.focus();
  await checkbox.dispatch('change', {}, true);
  await ui.refresh();
  assert.equal(f.$('[data-connector-scope="files:read"]'), checkbox); assert.equal(document.activeElement, checkbox); assert.equal(checkbox.checked, true);
  await checkbox.closest('form').dispatch('submit', {}, true); await tick();
  assert.deepEqual(calls.find(item => item[0].endsWith('/approve-access')), ['/api/chatgpt-connector/approve-access', 'POST', { id: 'request_one', scopes: ['read', 'files:read'] }]);
});

test('Select all chooses only the current request permissions and never approves access', async t => {
  const f = planningDOM(t), calls = [], all = ['read', 'planning:write', 'files:read', 'files:write', 'browser:read', 'browser:write', 'commands:run'];
  const value = current(); value.oauth.requests[0].scopes = [...all, 'unsupported:scope'];
  value.oauth.requests.push({ id: 'request_two', displayCode: 'SECOND12', scopes: ['read', 'files:read'] });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return value; } }); t.after(() => ui.destroy()); await tick();
  const select = f.$('[data-connector-action="select-all-access"][data-connector-id="request_one"]');
  assert.equal(select.type, 'button'); assert.equal(select.textContent, 'Select all'); assert.equal(select.getAttribute('aria-label'), 'Select all permissions for request ABCD1234');
  assert.equal(f.$('[data-connector-request="request_one"] [data-connector-selection]').textContent, '1 of 7 permissions selected');
  select.focus(); await f.click(select);
  const form = f.$('[data-connector-request="request_one"]'), checkboxes = form.querySelectorAll('[data-connector-scope]');
  assert.deepEqual(checkboxes.filter(node => node.checked).map(node => node.dataset.connectorScope), all);
  assert.equal(form.querySelector('[data-connector-scope="read"]').disabled, true);
  assert.equal(form.querySelector('[data-connector-selection]').textContent, '7 of 7 permissions selected');
  assert.equal(form.querySelector('[data-connector-selection]').getAttribute('aria-live'), 'polite');
  assert.equal(f.$('[data-connector-scope="unsupported:scope"]'), null);
  assert.equal(f.$('[data-connector-request="request_two"] [data-connector-scope="files:read"]').checked, false);
  assert.equal(f.document.activeElement, form.querySelector('[data-connector-action="select-all-access"]'));
  await ui.refresh(true);
  assert.deepEqual(f.$('[data-connector-request="request_one"]').querySelectorAll('[data-connector-scope]').filter(node => node.checked).map(node => node.dataset.connectorScope), all);
  assert.ok(calls.every(args => args[0] === '/api/chatgpt-connector'), 'selection and polling make no approval or other mutation request');
  await f.$('[data-connector-request="request_one"]').dispatch('submit', {}, true); await tick();
  assert.deepEqual(calls.find(args => args[0].endsWith('/approve-access')), ['/api/chatgpt-connector/approve-access', 'POST', { id: 'request_one', scopes: all }]);
});

test('Select all remains a choice snapshot and individual changes survive polling', async t => {
  const f = planningDOM(t), calls = []; let value = current();
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return value; } }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="select-all-access"]');
  value = current(); value.oauth.requests[0].scopes.push('files:write'); await ui.refresh(true);
  assert.equal(f.$('[data-connector-scope="files:write"]').checked, false, 'newly offered permissions are not silently selected by a previous click');
  assert.equal(f.$('[data-connector-selection]').textContent, '3 of 4 permissions selected');
  const command = f.$('[data-connector-scope="commands:run"]'); command.checked = false; command.focus(); await command.dispatch('change', {}, true);
  assert.equal(f.$('[data-connector-selection]').textContent, '2 of 4 permissions selected');
  await ui.refresh(); assert.equal(f.$('[data-connector-scope="commands:run"]'), command); assert.equal(command.checked, false);
  await ui.refresh(true); assert.equal(f.$('[data-connector-scope="commands:run"]').checked, false); assert.equal(f.$('[data-connector-selection]').textContent, '2 of 4 permissions selected');
  assert.ok(calls.every(args => args[0] === '/api/chatgpt-connector'));
  await f.$('[data-connector-request="request_one"]').dispatch('submit', {}, true); await tick();
  assert.deepEqual(calls.find(args => args[0].endsWith('/approve-access')), ['/api/chatgpt-connector/approve-access', 'POST', { id: 'request_one', scopes: ['read', 'files:read'] }]);
});

test('Select all ignores busy controls and a request removed while its old form is focused', async t => {
  const f = planningDOM(t), calls = []; let release, value = current(); const pending = new Promise(resolve => { release = resolve; });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return args[0].endsWith('/check-connection') ? pending : value; } }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="check-connection"]');
  assert.equal(f.$('[data-connector-action="select-all-access"]').getAttribute('aria-disabled'), 'true');
  await f.click('[data-connector-action="select-all-access"]'); assert.equal(f.$('[data-connector-scope="files:read"]').checked, false);
  release(value); await tick();
  const stale = f.$('[data-connector-action="select-all-access"]'); stale.focus(); value = ready(); await ui.refresh();
  assert.equal(f.$('[data-connector-action="select-all-access"]'), stale);
  await f.click(stale); assert.equal(f.$('[data-connector-scope="files:read"]').checked, false);
  assert.ok(calls.every(args => ['/api/chatgpt-connector', '/api/chatgpt-connector/check-connection'].includes(args[0])));
});

test('the connector Settings mount retains its exact focused element across app status redraws', t => {
  const f = planningDOM(t), instances = [];
  const snapshot = { status: { connected: false, chatGPTConnector: { available: true, enabled: false }, runtimeSettings: {} }, workflows: [] };
  const ui = initConfigureUI({ mount: f.mount, getSnapshot: () => snapshot, api: async () => ({}), mountConnector({ mount }) { instances.push(mount); mount.innerHTML = '<input id="connector-endpoint" value="https://blackice.example/mcp/chatgpt">'; return { update() {}, destroy() {} }; } }); t.after(() => ui.destroy());
  const field = f.$('#connector-endpoint'); field.focus(); field.setSelectionRange(4, 9);
  snapshot.status.connected = true; ui.update();
  assert.equal(instances.length, 1); assert.equal(f.$('#connector-endpoint'), field); assert.equal(document.activeElement, field); assert.equal(field.selectionStart, 4);
});

test('native setup is offered only by local host capability and describes the direct connection', () => {
  const state = { current: current(), scopes: new Map() };
  assert.doesNotMatch(renderChatGPTConnector(state), /data-connector-action="open-chatgpt"/);
  const html = renderChatGPTConnector({ ...state, canOpenChatGPT: true });
  assert.match(html, /Open ChatGPT setup/);
  assert.match(html, /default browser/);
  assert.match(html, /No client secret or Owner login key is needed/);
  assert.match(html, /Add custom MCP server/);
  assert.doesNotMatch(html, /Currents|plugins_6ad775/);
  assert.doesNotMatch(html, /Open ChatGPT in BLACKICE/);
  assert.doesNotMatch(renderChatGPTConnector({ ...state, canOpenChatGPT: true, remote: true }), /data-connector-action="open-chatgpt"/);
});

test('only an explicit setup click requests the fixed host handoff and duplicate clicks wait', async t => {
  const f = planningDOM(t), calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000,
    api: async (...args) => { calls.push(args); return args[0].endsWith('/open-chatgpt') ? pending : { ...current(), canOpenChatGPT: true }; }
  }); t.after(() => ui.destroy()); await tick();
  await ui.refresh(true);
  assert.ok(calls.every(args => args[0] === '/api/chatgpt-connector'), 'mount and status refresh never open a browser');
  await f.click('[data-connector-action="open-chatgpt"]');
  assert.match(f.mount.textContent, /Requesting setup in your default browser/);
  assert.equal(f.$('[data-connector-action="open-chatgpt"]').getAttribute('aria-disabled'), 'true');
  await f.click('[data-connector-action="open-chatgpt"]');
  assert.equal(calls.filter(args => args[0].endsWith('/open-chatgpt')).length, 1);
  release({ requested: true, connectionVerified: false }); await tick();
  assert.equal(f.$('[data-connector-action="open-chatgpt"]').getAttribute('aria-disabled'), null);
  assert.match(f.$('.connector-receipt').textContent, /was requested/);
  assert.deepEqual(calls.find(args => args[0].endsWith('/open-chatgpt')), ['/api/chatgpt-connector/open-chatgpt', 'POST', {}]);
  assert.ok(calls.every(args => ['/api/chatgpt-connector', '/api/chatgpt-connector/open-chatgpt'].includes(args[0])), 'no Chat Mode, enable, approval, prompt, or model route is called');
});

test('browser launch failure stays visible without claiming authentication and can be retried', async t => {
  const f = planningDOM(t); let opened = 0;
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000,
    api: async path => { if (path.endsWith('/open-chatgpt')) { opened++; throw Error('The default browser could not open setup.'); } return { ...current(), canOpenChatGPT: true }; }
  }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="open-chatgpt"]'); await tick();
  assert.equal(f.$('[role="alert"]').textContent, 'The default browser could not open setup.');
  assert.equal(f.$('[data-connector-action="open-chatgpt"]').getAttribute('aria-disabled'), null);
  assert.equal(f.$('.connector-receipt'), null);
  await f.click('[data-connector-action="open-chatgpt"]'); await tick(); assert.equal(opened, 2);
});

test('an unconfirmed handoff cannot be rendered as an opened or connected browser', async t => {
  const f = planningDOM(t);
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000,
    api: async path => path.endsWith('/open-chatgpt') ? {} : { ...current(), canOpenChatGPT: true }
  }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="open-chatgpt"]'); await tick();
  assert.match(f.$('[role="alert"]').textContent, /not confirmed/);
  assert.equal(f.$('.connector-receipt'), null);
});

test('hosts without an external setup capability expose no launch control', async t => {
  const f = planningDOM(t), calls = [];
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000,
    api: async (...args) => { calls.push(args); return { ...current(), canOpenChatGPT: false }; }
  }); t.after(() => ui.destroy()); await tick();
  assert.equal(f.$('[data-connector-action="open-chatgpt"]'), null);
  assert.deepEqual(calls, [['/api/chatgpt-connector']]);
});

test('Settings retains the existing connector section without a Chat Mode callback', t => {
  const f = planningDOM(t), instances = [];
  const snapshot = { status: { connected: true, chatGPTConnector: { available: true }, runtimeSettings: {} }, workflows: [] };
  const ui = initConfigureUI({ mount: f.mount, getSnapshot: () => snapshot, api: async () => ({}),
    mountConnector(options) { instances.push(options); options.mount.innerHTML = '<h2>ChatGPT connector</h2>'; return { update() {}, destroy() {} }; }
  }); t.after(() => ui.destroy());
  const heading = f.$('#configure-connector-mount h2');
  ui.showWorkflows(); ui.showConnector();
  assert.equal(instances.length, 1); assert.equal(Object.hasOwn(instances[0], 'onOpenChatGPT'), false);
  assert.equal(f.$('#configure-connector-mount h2'), heading); assert.equal(f.document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
});

const ready = (overrides = {}) => ({ ...current(), canOpenChatGPT: true, oauth: { requests: [], grants: [] }, ...overrides });

test('connector progress names observed stages without treating endpoint enablement as a connected chat', () => {
  const active = { id: 'active-grant' }, receipt = { clientId: active.id, tool: 'blackice_direct_status', at: '2026-10-20T20:00:00.000Z' };
  for (const [state, key, busy] of [
    [{ current: ready(), loading: true }, 'checking', true],
    [{ current: ready(), checking: true }, 'checking', true],
    [{ current: ready(), busy: 'open-chatgpt' }, 'opening', true],
    [{ current: ready(), busy: 'approve-access' }, 'approving', true],
    [{ current: ready(), error: 'Connection unavailable.' }, 'attention', false],
    [{ current: ready({ enabled: false }) }, 'disabled', false],
    [{ current: ready({ remoteAccess: { state: 'starting' } }) }, 'https-starting', false],
    [{ current: ready({ remoteAccess: { enabled: true, mode: 'public', state: 'starting' } }) }, 'https-starting', false],
    [{ current: ready({ remoteAccess: { enabled: false, state: 'error' } }) }, 'https-waiting', false],
    [{ current: current() }, 'approval', false],
    [{ current: ready(), setupRequested: true }, 'browser-waiting', false],
    [{ current: ready({ oauth: { requests: [], grants: [active] } }) }, 'authorized', false],
    [{ current: ready({ oauth: { requests: [], grants: [active] }, setup: setup({ verification: { clientId: active.id, receivedAt: receipt.at } }) }) }, 'tool-received', false],
    [{ current: ready() }, 'ready', false],
  ]) {
    const progress = connectorProgress(state); assert.equal(progress.key, key); assert.equal(progress.busy, busy);
    assert.doesNotMatch(progress.label, /connected|verified chat/i);
  }
  for (const setupRequested of [false, true]) assert.match(connectorProgress({ current: ready(), setupRequested }).description, /Add this computer’s address/);
  assert.equal(connectorProgress({ current: ready({ oauth: { requests: [], grants: [active] }, lastAuthenticatedToolCall: { ...receipt, clientId: 'revoked-grant' } }) }).key, 'authorized');
  assert.equal(connectorProgress({ current: ready({ lastAuthenticatedToolCall: receipt }) }).key, 'ready');
  assert.equal(connectorProgress({ current: ready({ oauth: { requests: current().oauth.requests, grants: [active] }, lastAuthenticatedToolCall: receipt }) }).key, 'approval');
});

test('the status region is accessible and motion is limited to actual work with a reduced-motion fallback', async () => {
  const html = renderChatGPTConnector({ current: ready(), scopes: new Map(), loading: true });
  assert.match(html, /data-connector-progress[^>]*role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /data-busy="true"/); assert.match(html, /connector-progress-indicator" aria-hidden="true"/);
  assert.match(html, /aria-disabled="true" aria-busy="true"/);
  const waiting = renderChatGPTConnector({ current: current(), scopes: new Map() }); assert.match(waiting, /data-stage="approval"[^>]*data-busy="false"/);
  const css = await readFile(new URL('../public/chatgpt-connector.css', import.meta.url), 'utf8');
  assert.match(css, /connector-progress\[data-busy=true\][^{]*\{[^}]*animation:connector-progress-spin/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*animation:none/);
});

test('background observation keeps its status region stable and never flashes a checking spinner', async t => {
  const f = planningDOM(t); let release, next;
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async () => next ? next : ready() }); t.after(() => ui.destroy()); await tick();
  const region = f.$('[data-connector-progress]'), markup = region.innerHTML;
  next = new Promise(resolve => { release = resolve; }); const refreshing = ui.refresh();
  assert.equal(f.$('[data-connector-progress]'), region); assert.equal(region.innerHTML, markup); assert.equal(region.getAttribute('data-busy'), 'false');
  release(ready()); await refreshing; assert.equal(f.$('[data-connector-progress]'), region); assert.equal(region.innerHTML, markup);
});

test('explicit status checks show real pending work and clear it when the response arrives', async t => {
  const f = planningDOM(t); let release, next;
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async () => next ? next : ready() }); t.after(() => ui.destroy()); await tick();
  const region = f.$('[data-connector-progress]'); next = new Promise(resolve => { release = resolve; });
  const refreshing = ui.refresh(true); assert.equal(region.getAttribute('data-stage'), 'checking'); assert.equal(region.getAttribute('data-busy'), 'true');
  assert.equal(f.$('[data-connector-action="refresh"]').getAttribute('aria-busy'), 'true');
  release(ready()); await refreshing; assert.equal(region.getAttribute('data-stage'), 'ready'); assert.equal(region.getAttribute('data-busy'), 'false');
});

test('confirmed browser handoff stays a user-action hint until an approval or grant appears', async t => {
  const f = planningDOM(t), calls = []; let release, state = ready(); const pending = new Promise(resolve => { release = resolve; });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return args[0].endsWith('/open-chatgpt') ? pending : state; } }); t.after(() => ui.destroy()); await tick();
  const region = f.$('[data-connector-progress]'); await f.click('[data-connector-action="open-chatgpt"]');
  assert.equal(region.getAttribute('data-stage'), 'opening'); assert.equal(region.getAttribute('data-busy'), 'true');
  release({ requested: true, connectionVerified: false }); await tick(); assert.equal(region.getAttribute('data-stage'), 'browser-waiting'); assert.equal(region.getAttribute('data-busy'), 'false');
  state = ready({ oauth: current().oauth }); await ui.refresh(); assert.equal(region.getAttribute('data-stage'), 'approval');
  state = ready({ oauth: { requests: [], grants: [{ id: 'new-grant', scopes: ['read'] }] } }); await ui.refresh(); assert.equal(region.getAttribute('data-stage'), 'authorized');
  assert.ok(calls.every(args => ['/api/chatgpt-connector', '/api/chatgpt-connector/open-chatgpt'].includes(args[0])));
});

test('status feedback updates without replacing focused permission controls', async t => {
  const f = planningDOM(t); let state = { ...current(), canOpenChatGPT: true };
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async () => state }); t.after(() => ui.destroy()); await tick();
  const checkbox = f.$('[data-connector-scope="files:read"]'), region = f.$('[data-connector-progress]'); checkbox.checked = true; checkbox.focus();
  await checkbox.dispatch('change', {}, true);
  state = ready({ oauth: { requests: [], grants: [{ id: 'new-grant', scopes: ['read'] }] } }); await ui.refresh();
  assert.equal(f.$('[data-connector-scope="files:read"]'), checkbox); assert.equal(f.document.activeElement, checkbox); assert.equal(checkbox.checked, true);
  assert.equal(f.$('[data-connector-progress]'), region); assert.equal(region.getAttribute('data-stage'), 'authorized');
});

test('approval submission keeps a connection hint during the browser exchange gap and disabling clears it', async t => {
  const f = planningDOM(t); let state = { ...current(), canOpenChatGPT: true };
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async path => {
    if (path.endsWith('/approve-access')) state = ready();
    if (path.endsWith('/disable')) state = ready({ enabled: false });
    return state;
  } }); t.after(() => ui.destroy()); await tick();
  await f.$('[data-connector-request="request_one"]').dispatch('submit', {}, true); await tick();
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-stage'), 'browser-waiting');
  await f.click('[data-connector-action="disable"]'); await tick();
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-stage'), 'disabled');
});

test('preparation waits for explicit public consent and copies the current computer endpoint', async t => {
  const f = planningDOM(t), calls = [], copied = [];
  let value = ready({ enabled: false, endpoint: null, remoteAccess: { enabled: false }, setup: setup({ ready: false, serverUrl: null, verification: null }) });
  const endpoint = 'https://this-computer.example/mcp/chatgpt';
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, copy: async text => copied.push(text), api: async (...args) => {
    calls.push(args);
    if (args[0].endsWith('/prepare')) value = ready({ endpoint, setup: setup({ serverUrl: endpoint }) });
    return value;
  } }); t.after(() => ui.destroy()); await tick();
  assert.equal(f.$('[data-connector-action="prepare"]').disabled, true);
  assert.equal(f.$('[data-connector-action="open-chatgpt"]').disabled, true);
  assert.equal(calls.some(args => args[0].endsWith('/prepare')), false);
  const consent = f.$('#connector-public-confirmation'); consent.checked = true; await consent.dispatch('change', {}, true);
  await f.click('[data-connector-action="prepare"]'); await tick();
  assert.deepEqual(calls.find(args => args[0].endsWith('/prepare')), ['/api/chatgpt-connector/prepare', 'POST', { confirmPublic: true }]);
  assert.equal(f.$('#connector-endpoint').value, endpoint);
  await f.click('[data-connector-action="copy"]'); await tick(); assert.deepEqual(copied, [endpoint]);
  assert.ok(calls.every(args => !/disable|revoke/.test(args[0])));
});

test('the exact server prompt is copied and matching receipt requires a separate confirmation click', async t => {
  const f = planningDOM(t), calls = [], copied = [], grant = { id: 'approved-connection', scopes: ['read'] };
  const verification = { nonce: 'server-issued-nonce', prompt: 'Exact server prompt with server-issued-nonce' };
  let value = ready({ oauth: { requests: [], grants: [grant] }, setup: setup({ verification }) });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, copy: async text => copied.push(text), api: async (...args) => {
    calls.push(args);
    if (args[0].endsWith('/confirm-connection')) value = { ...value, setup: setup({ verification: { ...value.setup.verification, confirmedAt: '2026-10-20T21:00:00.000Z' } }) };
    return value;
  } }); t.after(() => ui.destroy()); await tick();
  assert.equal(f.$('[data-connector-action="confirm-connection"]'), null);
  await f.click('[data-connector-action="copy-verification"]'); await tick(); assert.deepEqual(copied, [verification.prompt]);
  value = { ...value, setup: setup({ verification: { ...verification, clientId: grant.id, tool: 'blackice_direct_status', receivedAt: '2026-10-20T20:59:00.000Z' } }) };
  await ui.refresh(true);
  assert.match(f.$('.connector-verification').textContent, /Matching authenticated status check received/);
  assert.doesNotMatch(f.$('.connector-verification').textContent, /Connection confirmed by you/);
  assert.equal(calls.some(args => args[0].endsWith('/confirm-connection')), false);
  await f.click('[data-connector-action="confirm-connection"]'); await tick();
  assert.deepEqual(calls.find(args => args[0].endsWith('/confirm-connection')), ['/api/chatgpt-connector/confirm-connection', 'POST', { nonce: verification.nonce }]);
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-stage'), 'confirmed');
  assert.match(f.$('.connector-verification').textContent, /Connection confirmed by you/);
  assert.equal(f.$('[data-connector-action="confirm-connection"]'), null);
});

test('public diagnostics show retryable failures and never substitute for chat verification', async t => {
  const f = planningDOM(t), calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return args[0].endsWith('/check-connection') ? pending : ready(); } });
  t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="check-connection"]');
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-stage'), 'diagnosing');
  release(ready({ setup: setup({ diagnostics: { ok: false, checks: [{ key: 'oauth', label: 'OAuth discovery', ok: false, detail: 'Network policy blocked this check.' }], limitation: 'This computer only; confirm the result in ChatGPT.' } }) })); await tick();
  assert.match(f.$('.connector-diagnostics').textContent, /Network policy blocked/);
  assert.match(f.$('.connector-diagnostics').textContent, /again/);
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-busy'), 'false');
  assert.equal(f.$('[data-connector-action="check-connection"]').getAttribute('aria-disabled'), null);
  assert.equal(f.$('[data-connector-action="confirm-connection"]'), null);
  assert.deepEqual(calls.find(args => args[0].endsWith('/check-connection')), ['/api/chatgpt-connector/check-connection', 'POST', {}]);
});

test('background status recovery preserves action errors until retry while clearing status errors', async t => {
  const f = planningDOM(t); let launchFails = true, statusFails = false;
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async path => {
    if (path.endsWith('/open-chatgpt')) { if (launchFails) throw Error('Browser setup could not open.'); return { requested: true }; }
    if (statusFails) throw Error('Status is temporarily unavailable.');
    return ready();
  } }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="open-chatgpt"]'); await tick();
  await ui.refresh(); assert.match(f.$('[role="alert"]').textContent, /Browser setup could not open/);
  launchFails = false; await f.click('[data-connector-action="open-chatgpt"]'); await tick();
  assert.equal(f.$('[role="alert"]'), null);
  statusFails = true; await ui.refresh(); assert.match(f.$('[role="alert"]').textContent, /Status is temporarily unavailable/);
  statusFails = false; await ui.refresh(); assert.equal(f.$('[role="alert"]'), null);
});

test('connection permissions describe direct scoped execution and Windows file access without a local approval setting', () => {
  const value = ready({ oauth: { requests: current().oauth.requests, grants: [{ id: 'existing-grant', scopes: ['read', 'files:read', 'files:write', 'commands:run'] }] } });
  const html = renderChatGPTConnector({ current: value, scopes: new Map() });
  assert.match(html, /without a separate BLACKICE approval prompt/);
  assert.match(html, /plugin permission is configured separately/);
  assert.match(html, /Relative file paths use the configured working folder/);
  assert.match(html, /Absolute file and upload paths are allowed/);
  assert.match(html, /Windows account’s permissions/);
  assert.doesNotMatch(html, /data-connector-policy|action-policy|Ask for each action|Allow actions in granted scopes/);
  assert.doesNotMatch(html, /after local approval|require local approval|limited to the configured workspace|inside the configured workspace/);
  assert.match(html, /data-connector-action="revoke" data-connector-id="existing-grant"/);
  assert.match(html, /Allow selected access/, 'OAuth connection consent remains available');
});

test('historical local approvals can be cancelled but cannot be approved or replayed through Settings', async t => {
  const f = planningDOM(t), calls = [];
  const value = ready({ pending: { jobs: [{ jobId: 'old-job', tool: 'blackice_command', owner: { label: 'ChatGPT' }, request: { command: 'Get-ChildItem' }, interaction: { id: 'old-interaction', kind: 'approval', message: 'Review this exact requested action in BLACKICE before it runs.' } }] } });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => { calls.push(args); return value; } }); t.after(() => ui.destroy()); await tick();
  assert.match(f.mount.textContent, /Old approval request/);
  assert.match(f.mount.textContent, /has not been approved or replayed/);
  assert.equal(f.$('[data-connector-action="approve-action"]'), null);
  assert.equal(f.$('[data-connector-action="resolve-action"]'), null);
  assert.ok(calls.every(args => args[0] === '/api/chatgpt-connector'), 'loading never replays a pending action');
  await f.click('[data-connector-action="reject-action"]'); await tick();
  assert.deepEqual(calls.find(args => args[0].endsWith('/reject-action')), ['/api/chatgpt-connector/reject-action', 'POST', { id: 'old-job', interactionId: 'old-interaction' }]);
  assert.ok(calls.every(args => !/approve-action|resolve-action/.test(args[0])));
});

test('required browser interactions retain acknowledge and cancel controls without implying action replay', () => {
  const html = renderChatGPTConnector({ current: ready({ pending: { jobs: [{ jobId: 'browser-job', tool: 'blackice_browser', request: {}, interaction: { id: 'browser-interaction', kind: 'manual', message: 'Complete sign-in in BLACKICE.' } }] } }), scopes: new Map() });
  assert.match(html, /data-connector-action="resolve-action" data-connector-id="browser-job"/);
  assert.match(html, /data-connector-action="reject-action" data-connector-id="browser-job"/);
  assert.match(html, /Acknowledging the interaction does not repeat the action/);
  assert.doesNotMatch(html, /data-connector-action="approve-action"/);
});


const startupState = (overrides = {}) => ({
  available: true, ready: false, canEnable: true, checkedAt: '2026-10-21T12:00:00.000Z',
  checks: [
    { key: 'tailscale', label: 'Tailscale at Windows boot', ok: false, detail: 'Unattended mode is not enabled.' },
    { key: 'blackice', label: 'BLACKICE at Windows sign-in', ok: true, detail: 'The existing sign-in entry is enabled.' },
  ],
  actionLabel: 'Enable Tailscale at boot',
  ...overrides,
});

test('startup diagnostics distinguish current connectivity from verified boot and sign-in settings', () => {
  const state = { current: ready({ startup: startupState() }), scopes: new Map() };
  const html = renderChatGPTConnector(state);
  assert.match(html, /This computer is prepared/);
  assert.match(html, /Tailscale at Windows boot/); assert.match(html, /BLACKICE at Windows sign-in/);
  assert.match(html, /Unattended mode is not enabled/); assert.match(html, /existing sign-in entry is enabled/);
  assert.match(html, /data-connector-action="enable-startup"[^>]*>Enable Tailscale at boot/);
  assert.match(html, /restart has not been tested/);
  assert.doesNotMatch(html, /Automatic startup settings verified/);
  const verified = startupState({ ready: true, checks: startupState().checks.map(check => ({ ...check, ok: true })) });
  const done = renderChatGPTConnector({ ...state, current: ready({ startup: verified }) });
  assert.match(done, /Automatic startup settings verified/); assert.doesNotMatch(done, /data-connector-action="enable-startup"/);
  const incomplete = renderChatGPTConnector({ ...state, current: ready({ startup: startupState({ ready: true }) }) });
  assert.doesNotMatch(incomplete, /Automatic startup settings verified/, 'an aggregate flag cannot override a failed check');
  const unsupported = renderChatGPTConnector({ ...state, current: ready({ startup: startupState({ available: false, canEnable: false }) }) });
  assert.doesNotMatch(unsupported, /data-connector-action="enable-startup"/);
  assert.doesNotMatch(renderChatGPTConnector({ ...state, remote: true }), /data-connector-action="enable-startup"/);
});

test('startup polling never mutates settings and one explicit click waits for verified settlement', async t => {
  const f = planningDOM(t), calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  let value = ready({ startup: startupState() });
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async (...args) => {
    calls.push(args);
    if (args[0].endsWith('/enable-startup')) { await pending; value = ready({ startup: startupState({ ready: true, canEnable: false, checks: startupState().checks.map(check => ({ ...check, ok: true })) }) }); }
    return value;
  } }); t.after(() => ui.destroy()); await tick(); await ui.refresh(true);
  assert.ok(calls.every(args => args[0] === '/api/chatgpt-connector'));
  await f.click('[data-connector-action="enable-startup"]');
  assert.equal(f.$('[data-connector-progress]').getAttribute('data-stage'), 'startup');
  assert.equal(f.$('[data-connector-action="enable-startup"]').getAttribute('aria-disabled'), 'true');
  await f.click('[data-connector-action="enable-startup"]'); await ui.refresh(true);
  assert.equal(calls.filter(args => args[0].endsWith('/enable-startup')).length, 1);
  assert.deepEqual(calls.find(args => args[0].endsWith('/enable-startup')), ['/api/chatgpt-connector/enable-startup', 'POST', {}]);
  release(); await tick();
  assert.equal(f.$('[data-connector-action="enable-startup"]'), null);
  assert.match(f.$('.connector-receipt').textContent, /settings verified/);
  assert.ok(calls.every(args => ['/api/chatgpt-connector', '/api/chatgpt-connector/enable-startup'].includes(args[0])));
});

test('incomplete startup results remain actionable and failed native permission never claims success', async t => {
  const f = planningDOM(t); let fail = false;
  const ui = mountChatGPTConnector({ mount: f.mount, intervalMs: 100000, api: async path => {
    if (path.endsWith('/enable-startup') && fail) throw Error('Windows permission was declined. Enable startup again when ready.');
    return ready({ startup: startupState() });
  } }); t.after(() => ui.destroy()); await tick();
  await f.click('[data-connector-action="enable-startup"]'); await tick();
  assert.match(f.$('.connector-receipt').textContent, /still need attention/);
  assert.doesNotMatch(f.$('[data-connector-startup]').textContent, /settings verified/);
  fail = true; await f.click('[data-connector-action="enable-startup"]'); await tick();
  assert.match(f.$('[role="alert"]').textContent, /Windows permission was declined/);
  assert.equal(f.$('.connector-receipt'), null);
  assert.equal(f.$('[data-connector-action="enable-startup"]').getAttribute('aria-disabled'), null);
});
