import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { initConfigureUI } from '../public/configure-ui.mjs';
import { browserCredentialsView, mountBrowserCredentials } from '../public/browser-credentials-ui.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = (id = 'login-one', revision = 1) => ({ credentialId: id, revision, origin: 'https://example.test', username: `${id}@example.test`, label: `Fixture ${id}`, source: 'user', createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z' });
const status = () => ({ localManagement: true, vault: { available: true, healthy: true, revision: 2, capabilities: { save: true, delete: true }, entries: [entry(), entry('login-two', 2)] }, mirror: { available: true, healthy: true, revision: 7, settings: { enabled: false, destination: 'chrome' }, capabilities: { configure: true, queue: true, beginImport: true }, entries: [], batches: [] }, destinations: [{ id: 'chrome', available: true, supported: true }, { id: 'firefox', available: true, supported: true }, { id: 'neo', available: false, supported: true }] });
async function mounted(t, handler, options = {}) {
  const f = planningDOM(t), calls = []; let current = status(), serial = 0;
  const ui = mountBrowserCredentials({ mount: f.mount, intervalMs: 100000, makeRequestId: () => `fixture-request-${++serial}`, api: async (...args) => { calls.push(args); if (args[0] === '/api/browser-credentials') return structuredClone(current); return handler?.(args, current); }, ...options });
  t.after(() => ui.destroy()); await tick();
  return { ...f, ui, calls, get current() { return current; }, set current(value) { current = value; } };
}
async function fill(f) {
  f.$('#credentials-add').open = true;
  await f.input('#credentials-origin', 'https://signin.example.test/login?discard=query');
  await f.input('#credentials-username', 'synthetic-user@example.test');
  await f.input('#credentials-label', 'Synthetic login');
  await f.input('#credentials-password', 'only-a-synthetic-test-password');
}
async function select(f, id = 'login-one') { const field = f.$(`[data-credentials-select="${id}"]`); field.checked = true; await field.dispatch('change', {}, true); }

test('password UI projects only metadata and strips unexpected secret, path and URL query fields', () => {
  const current = status(); current.vault.entries[0].password = 'never-render-this'; current.vault.entries[0].origin = 'https://example.test/login?token=never-render-this';
  current.mirror.batches = [{ batchId: 'batch-one', state: 'awaiting_browser_import', count: 1, destination: 'chrome', filePath: 'C:/private-secret.csv', password: 'never-render-this' }];
  const view = browserCredentialsView(current);
  assert.equal(view.vault.entries[0].origin, 'https://example.test');
  assert.doesNotMatch(JSON.stringify(view), /never-render-this|private-secret|filePath|password/);
  assert.equal(browserCredentialsView({ vault: { entries: [{ origin: 'https://user:secret@example.test' }] } }).vault.entries[0].origin, '');
});

test('remote password management has no local form and never loads vault metadata', async t => {
  const f = await mounted(t, undefined, { presence: { localManagement: false } });
  assert.equal(f.calls.length, 0); assert.equal(f.$('#credentials-password'), null);
  assert.match(f.mount.textContent, /host computer/);
});

test('the local login form accepts HTTPS only and retains the masked draft after rejecting HTTP', async t => {
  const f = await mounted(t); await fill(f); await f.input('#credentials-origin', 'http://example.test/login');
  await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick();
  assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
  assert.equal(f.$('#credentials-password').value, 'only-a-synthetic-test-password');
  assert.match(f.$('#credentials-error').textContent, /valid HTTPS/);
  assert.equal(browserCredentialsView({ vault: { entries: [{ origin: 'http://example.test' }] } }).vault.entries[0].origin, '');
});

test('a local password stays in its original masked field during polling and clears only after confirmed save', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await mounted(t, async ([path, , body], current) => { assert.equal(path, '/api/browser-credentials/save'); await held; current.vault.revision = 3; return { credentialId: 'new-fixture', revision: 1, vaultRevision: 3, existing: false }; });
  await fill(f); const password = f.$('#credentials-password'); password.focus(); password.setSelectionRange(2, 8);
  await f.ui.refresh();
  assert.equal(f.$('#credentials-password'), password); assert.equal(password.type, 'password'); assert.equal(password.value, 'only-a-synthetic-test-password'); assert.equal(password.getAttribute('value'), null);
  assert.doesNotMatch(f.mount.innerHTML, /only-a-synthetic-test-password/); assert.equal(f.document.activeElement, password);
  await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick();
  assert.equal(password.value, 'only-a-synthetic-test-password'); assert.equal(password.readOnly, true);
  assert.deepEqual(f.calls.find(item => item[0].endsWith('/save')), ['/api/browser-credentials/save', 'POST', { requestId: 'fixture-request-1', expectedRevision: 2, origin: 'https://signin.example.test', username: 'synthetic-user@example.test', label: 'Synthetic login', password: 'only-a-synthetic-test-password' }]);
  release(); await tick();
  assert.equal(f.$('#credentials-password'), password); assert.equal(password.value, ''); assert.equal(password.readOnly, false); assert.match(f.$('#credentials-receipt').textContent, /confirmed|saved in the encrypted vault/);
});

test('a revision conflict retains the local form and requires a new explicit save after status review', async t => {
  let saves = 0;
  const f = await mounted(t, async ([path], current) => { assert.equal(path, '/api/browser-credentials/save'); if (++saves === 1) { current.vault.revision = 3; throw Object.assign(Error('private submission must not be echoed'), { code: 'CREDENTIAL_REVISION_CONFLICT', status: 409 }); } return { credentialId: 'new-fixture', revision: 1, vaultRevision: 4 }; });
  await fill(f); await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick();
  assert.equal(saves, 1); assert.equal(f.$('#credentials-password').value, 'only-a-synthetic-test-password'); assert.equal(f.$('#credentials-password').readOnly, false); assert.match(f.$('#credentials-error').textContent, /vault changed/);
  await f.ui.refresh(); assert.equal(saves, 1);
  await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick();
  const calls = f.calls.filter(item => item[0].endsWith('/save')); assert.equal(calls[1][2].expectedRevision, 3); assert.notEqual(calls[0][2].requestId, calls[1][2].requestId); assert.equal(f.$('#credentials-password').value, '');
});

test('an uncertain save never replays on polling and its explicit retry keeps the exact request identity and body', async t => {
  let saves = 0;
  const f = await mounted(t, async ([path], current) => { assert.equal(path, '/api/browser-credentials/save'); if (++saves === 1) { current.vault.revision = 3; throw Object.assign(Error('a server error including only-a-synthetic-test-password'), { uncertain: true }); } return { credentialId: 'new-fixture', revision: 1, vaultRevision: 3, existing: true }; });
  await fill(f); await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick();
  assert.equal(f.$('#credentials-password').readOnly, true); assert.equal(f.$('[data-credentials-action="retry-save"]').hidden, false); assert.doesNotMatch(f.$('#credentials-error').textContent, /synthetic-test-password/);
  await f.ui.refresh(); assert.equal(saves, 1);
  await f.click('[data-credentials-action="retry-save"]'); await tick();
  const calls = f.calls.filter(item => item[0].endsWith('/save')); assert.deepEqual(calls[1], calls[0]); assert.equal(f.$('#credentials-password').value, '');
});

test('a replacement draft survives a concurrent entry change and needs explicit revision review', async t => {
  const f = await mounted(t, async ([path, , body]) => { assert.equal(path, '/api/browser-credentials/save'); assert.equal(body.credentialId, 'login-one'); assert.equal(body.revision, 2); assert.equal(body.expectedRevision, 3); return { credentialId: 'login-one', revision: 3, vaultRevision: 4 }; });
  await f.click('[data-credentials-action="edit"][data-credential-id="login-one"]');
  const password = f.$('#credentials-password'); assert.equal(password.value, ''); await f.input('#credentials-password', 'synthetic-replacement');
  f.current.vault.entries[0].revision = 2; f.current.vault.entries[0].username = 'updated-fixture@example.test'; f.current.vault.revision = 3;
  await f.ui.refresh(); assert.equal(password.value, 'synthetic-replacement'); assert.equal(f.$('#credentials-save').disabled, true);
  assert.match(f.$('#credentials-editing').textContent, /updated-fixture@example.test/);
  await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick(); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
  await f.click('[data-credentials-action="review-revision"]'); assert.equal(f.$('#credentials-save').disabled, false);
  await f.$('#credentials-login-form').dispatch('submit', {}, true); await tick(); assert.equal(password.value, '');
});

test('destroy and revocation of local management clear the connected secret input', async t => {
  const f = await mounted(t); await fill(f); const old = f.$('#credentials-password');
  f.ui.update({ localManagement: false }); assert.equal(old.value, ''); assert.equal(f.$('#credentials-password'), null); assert.match(f.mount.textContent, /host computer/);
  const current = f.current; current.vault.entries[0].password = 'not-an-allowed-field'; await f.ui.refresh(); assert.doesNotMatch(f.mount.textContent, /not-an-allowed-field/);
});

test('automatic copying is opt-in encrypted queueing; preferences and polling never begin native import', async t => {
  const f = await mounted(t, async ([path, , body], current) => { assert.equal(path, '/api/browser-credentials/mirror/configure'); current.mirror.revision++; current.mirror.settings = { enabled: body.enabled, destination: body.destination }; return current.mirror; });
  assert.equal(f.$('#credentials-auto-queue').checked, false); assert.match(f.mount.textContent, /queue remains encrypted/);
  f.$('#credentials-destination').value = 'firefox'; await f.$('#credentials-destination').dispatch('change', {}, true);
  f.$('#credentials-auto-queue').checked = true; await f.$('#credentials-auto-queue').dispatch('change', {}, true);
  await f.ui.refresh(); assert.equal(f.$('#credentials-destination').value, 'firefox'); assert.equal(f.$('#credentials-auto-queue').checked, true);
  await f.$('#credentials-preferences').dispatch('submit', {}, true); await tick();
  assert.deepEqual(f.calls.filter(item => item[1] === 'POST'), [['/api/browser-credentials/mirror/configure', 'POST', { enabled: true, destination: 'firefox', expectedRevision: 7 }]]);
});

test('copy sends only explicitly selected revisions and starts one truthful native import handoff', async t => {
  const f = await mounted(t, async ([path, , body], current) => {
    if (path.endsWith('/queue')) { current.mirror.revision = 8; current.mirror.entries = [{ id: 'queue-one', credentialId: 'login-two', credentialRevision: 2, destination: 'chrome', state: 'pending' }]; return { revision: 8, entries: current.mirror.entries }; }
    assert.equal(path, '/api/browser-credentials/mirror/begin'); current.mirror.revision = 9; current.mirror.entries[0].state = 'awaiting_browser_import'; current.mirror.entries[0].batchId = 'batch-one'; current.mirror.batches = [{ batchId: 'batch-one', state: 'awaiting_browser_import', count: 1, destination: 'chrome', expiresAt: '2026-10-20T16:05:00Z', entryIds: ['queue-one'] }]; return { ...current.mirror.batches[0], revision: 9 };
  });
  await select(f, 'login-two'); await f.click('[data-credentials-action="copy-selected"]'); await tick();
  const posts = f.calls.filter(item => item[1] === 'POST'); assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], ['/api/browser-credentials/mirror/queue', 'POST', { credentials: [{ credentialId: 'login-two', revision: 2 }], destination: 'chrome', requestId: 'fixture-request-1', expectedRevision: 7 }]);
  assert.deepEqual(posts[1], ['/api/browser-credentials/mirror/begin', 'POST', { ids: ['queue-one'], expectedRevision: 8, requestId: 'fixture-request-2' }]);
  assert.match(f.$('#credentials-batches').textContent, /Awaiting browser import/); assert.match(f.$('#credentials-batches').textContent, /Opening the browser does not mean the import completed/); assert.doesNotMatch(f.$('#credentials-batches').textContent, /Confirmed by you/);
});

test('an uncertain native handoff retries only its admitted begin request, never requeues selected passwords', async t => {
  let begins = 0;
  const f = await mounted(t, async ([path], current) => {
    if (path.endsWith('/queue')) return { revision: 8, entries: [{ id: 'queue-one', credentialId: 'login-one', credentialRevision: 1, destination: 'chrome', state: 'pending' }] };
    if (++begins === 1) throw Object.assign(Error('handoff timed out'), { uncertain: true });
    return { batchId: 'batch-one', state: 'awaiting_browser_import', revision: 9 };
  });
  await select(f); await f.click('[data-credentials-action="copy-selected"]'); await tick(); await f.ui.refresh();
  assert.equal(begins, 1); assert.equal(f.$('[data-credentials-action="retry-operation"]').hidden, false);
  await f.click('[data-credentials-action="retry-operation"]'); await tick();
  const posts = f.calls.filter(item => item[1] === 'POST'); assert.equal(posts.filter(item => item[0].endsWith('/queue')).length, 1); assert.deepEqual(posts[1], posts[2]);
});

test('selection is invalidated when the stored password revision changes, before a new export can start', async t => {
  const f = await mounted(t); await select(f); f.current.vault.entries[0].revision++;
  await f.ui.refresh(); assert.equal(f.$('#credentials-selected').textContent, '0 selected'); assert.match(f.$('#credentials-receipt').textContent, /Select|select them again/);
  await f.click('[data-credentials-action="copy-selected"]'); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
});

test('polling during a preserved pointer and focused row cannot select an unseen credential revision', async t => {
  const f = await mounted(t), old = f.$('[data-credentials-select="login-one"]'); old.focus();
  await old.dispatch('pointerdown', {}, true);
  f.current.vault.entries[0].revision = 2; f.current.vault.entries[0].username = 'changed@example.test'; f.current.vault.revision++;
  await f.ui.refresh(); assert.equal(f.$('[data-credentials-select="login-one"]'), old);
  await f.page('blur'); await tick(); old.checked = true; await old.dispatch('change', {}, true); await tick();
  assert.equal(old.checked, false); assert.equal(f.$('#credentials-selected').textContent, '0 selected');
  assert.match(f.$('#credentials-error').textContent, /changed after it was displayed/);
  await f.click('[data-credentials-action="copy-selected"]'); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
  f.$('[data-credentials-action="refresh"]').focus(); await f.ui.refresh();
  const fresh = f.$('[data-credentials-select="login-one"]'); assert.notEqual(fresh, old); assert.equal(fresh.dataset.credentialRevision, '2');
  fresh.checked = true; await fresh.dispatch('change', {}, true); assert.equal(f.$('#credentials-selected').textContent, '1 selected');
});

test('a preserved queued checkbox cannot select a revision that changed during polling', async t => {
  const f = await mounted(t); f.current.mirror.entries = [{ id: 'queue-one', credentialId: 'login-one', credentialRevision: 1, destination: 'chrome', state: 'pending' }]; await f.ui.refresh();
  const old = f.$('[data-credentials-queue="queue-one"]'); old.focus(); await old.dispatch('pointerdown', {}, true);
  f.current.mirror.entries[0].credentialRevision = 2; f.current.mirror.revision++;
  await f.ui.refresh(); assert.equal(f.$('[data-credentials-queue="queue-one"]'), old);
  await f.page('blur'); await tick(); old.checked = true; await old.dispatch('change', {}, true); await tick();
  assert.equal(old.checked, false); assert.match(f.$('#credentials-error').textContent, /queue entry changed/);
  await f.click('[data-credentials-action="copy-queued"]'); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
});

test('a browser reported unavailable cannot be used for native copying', async t => {
  const f = await mounted(t); await select(f); f.$('#credentials-destination').value = 'neo'; await f.$('#credentials-destination').dispatch('change', {}, true);
  assert.match(f.$('#credentials-destination-note').textContent, /not available/); assert.equal(f.$('[data-credentials-action="copy-selected"]').getAttribute('aria-disabled'), 'true');
  await f.click('[data-credentials-action="copy-selected"]'); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
});

test('user import confirmation is explicit and remains a user report rather than verified browser sync', async t => {
  const f = await mounted(t, async ([path, , body], current) => { assert.equal(path, '/api/browser-credentials/mirror/confirm'); assert.deepEqual(body, { batchId: 'batch-one', expectedRevision: 7 }); current.mirror.revision++; current.mirror.batches[0].state = 'confirmed_by_user'; return { ...current.mirror.batches[0], revision: current.mirror.revision }; });
  f.current.mirror.batches = [{ batchId: 'batch-one', state: 'awaiting_browser_import', count: 1, destination: 'firefox', expiresAt: '2026-10-20T16:05:00Z' }]; await f.ui.refresh();
  assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
  f.$('[data-credentials-action="confirm"]').focus(); await f.click('[data-credentials-action="confirm"]'); await tick();
  assert.match(f.$('#credentials-batches').textContent, /Confirmed by you/); assert.match(f.$('#credentials-batches').textContent, /not independently verified/);
});

test('a lost handoff reply can recover its terminal receipt without exporting or claiming fresh success', async t => {
  let begins = 0;
  const f = await mounted(t, async ([path], current) => {
    if (path.endsWith('/queue')) return { revision: 8, entries: [{ id: 'queue-one', credentialId: 'login-one', credentialRevision: 1, destination: 'chrome', state: 'pending' }] };
    if (++begins === 1) throw Object.assign(Error('reply lost'), { uncertain: true });
    current.mirror.batches = [{ batchId: 'batch-one', count: 1, destination: 'chrome', state: 'cancelled' }];
    return { ...current.mirror.batches[0], revision: 10, existing: true };
  });
  await select(f); await f.click('[data-credentials-action="copy-selected"]'); await tick();
  await f.click('[data-credentials-action="retry-operation"]'); await tick();
  assert.match(f.$('#credentials-receipt').textContent, /existing import receipt is cancelled/); assert.match(f.$('#credentials-receipt').textContent, /No new file/); assert.equal(f.$('[data-credentials-action="retry-operation"]').hidden, true); assert.match(f.$('#credentials-batches').textContent, /Cancelled/);
  assert.equal(f.calls.filter(item => item[0].endsWith('/queue')).length, 1);
});

test('cancel targets only the displayed batch and does not imply deleting passwords already imported', async t => {
  const f = await mounted(t, async ([path, , body], current) => { assert.equal(path, '/api/browser-credentials/mirror/cancel'); assert.deepEqual(body, { batchId: 'batch-one', expectedRevision: 7 }); current.mirror.revision++; current.mirror.batches[0].state = 'cancelled'; return { ...current.mirror.batches[0], revision: current.mirror.revision }; });
  f.current.mirror.batches = [{ batchId: 'batch-one', state: 'awaiting_browser_import', count: 1, destination: 'firefox', expiresAt: '2026-10-20T16:05:00Z' }]; await f.ui.refresh();
  await f.click('[data-credentials-action="cancel"]'); await tick();
  assert.match(f.$('#credentials-batches').textContent, /Cancelled/); assert.match(f.$('#credentials-batches').textContent, /already completed in the browser is not undone/);
});

test('a queue receipt that does not match the selected login never starts a native export', async t => {
  const f = await mounted(t, async () => ({ revision: 8, entries: [{ id: 'wrong-queue', credentialId: 'login-two', credentialRevision: 2, destination: 'chrome', state: 'pending' }] }));
  await select(f); await f.click('[data-credentials-action="copy-selected"]'); await tick();
  assert.equal(f.calls.filter(item => item[0].endsWith('/begin')).length, 0); assert.match(f.$('#credentials-error').textContent, /could not confirm/);
});

test('copying queued entries requires one destination and preserves exact queued identities', async t => {
  const f = await mounted(t); f.current.mirror.entries = [{ id: 'queue-one', credentialId: 'login-one', credentialRevision: 1, destination: 'chrome', state: 'pending' }, { id: 'queue-two', credentialId: 'login-two', credentialRevision: 2, destination: 'firefox', state: 'pending' }]; await f.ui.refresh();
  for (const id of ['queue-one', 'queue-two']) { const field = f.$(`[data-credentials-queue="${id}"]`); field.checked = true; await field.dispatch('change', {}, true); }
  await f.click('[data-credentials-action="copy-queued"]'); assert.match(f.$('#credentials-error').textContent, /one available browser/); assert.equal(f.calls.filter(item => item[1] === 'POST').length, 0);
});

test('a queued status update cannot remove a control in the middle of a physical pointer gesture', async t => {
  const f = await mounted(t); const old = f.$('[data-credentials-action="edit"]'); await old.dispatch('pointerdown', {}, true);
  f.current.vault.entries.push(entry('login-three')); await f.ui.refresh();
  assert.equal(f.$('[data-credentials-action="edit"]'), old); assert.equal(old.isConnected, true);
  await f.page('blur'); await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.$('[data-credentials-entry="login-three"]') !== null, true);
});

test('background notices are deferred until a pointer gesture ends, keeping the form layout stable', async t => {
  const f = await mounted(t); await select(f); const notice = f.$('#credentials-receipt'); assert.equal(notice.hidden, true);
  await f.$('[data-credentials-action="copy-selected"]').dispatch('pointerdown', {}, true);
  f.current.vault.entries[0].revision++; await f.ui.refresh();
  assert.equal(notice.hidden, true, 'a changed selection cannot insert a notice above a pressed control');
  await f.page('blur'); await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /selected logins changed/);
});

test('Settings status changes preserve the live password field, focus, selection and local draft', async t => {
  const f = planningDOM(t), current = status(), snapshot = { status: { connected: false, browserCredentials: { available: true, localManagement: true }, runtimeSettings: {} }, workflows: [] };
  const ui = initConfigureUI({ mount: f.mount, getSnapshot: () => snapshot, api: async path => path === '/api/browser-credentials' ? current : {} }); t.after(() => ui.destroy()); await tick();
  const password = f.$('#credentials-password'); password.value = 'synthetic-unsaved'; password.focus(); password.setSelectionRange(2, 7);
  snapshot.status.connected = true; snapshot.status.defaultModel = 'provider::new'; ui.update();
  assert.equal(f.$('#credentials-password'), password); assert.equal(password.value, 'synthetic-unsaved'); assert.equal(f.document.activeElement, password); assert.deepEqual([password.selectionStart, password.selectionEnd], [2, 7]);
  ui.destroy(); assert.equal(password.value, '');
});
