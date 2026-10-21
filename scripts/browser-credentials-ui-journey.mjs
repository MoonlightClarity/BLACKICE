import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PASSWORD_MANAGER_UI_FEATURES = ['passwordManagerLocal', 'passwordManagerNativeHandoff', 'passwordManagerMobile'];
export const PASSWORD_MANAGER_UI_CHECKS = [
  'Password manager opens in local Settings with encrypted fixture storage and Chrome, Firefox and Neo destinations',
  'The real local password form saves two logins, clears each masked password, and exposes only metadata',
  'Password manager polling and unrelated Settings updates preserve the same masked draft, focus and selection',
  'Opting into automatic browser copying queues encrypted entries without exporting a file or opening a browser',
  'Copy to browser password manager exports only the explicitly selected credential revision through one native handoff',
  'The import UI shows awaiting browser import and native profile and unlock instructions without claiming synchronization',
  'Explicit user confirmation records confirmed_by_user and removes the temporary CSV without claiming independent verification',
  'Password manager form, saved logins and import controls remain usable at 390px without horizontal overflow',
  'Password manager form, saved logins and import controls remain usable at 320px without horizontal overflow',
  'Password manager acceptance leaves no local secret draft, temporary CSV, real browser import or extra model turn',
];
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const expectedCSV = entries => 'name,url,username,password\r\n' + entries.map(entry => [new URL(entry.origin).hostname, entry.origin, entry.username, entry.password].map(quote).join(',')).join('\r\n') + '\r\n';

/** AES and native-open test doubles only. No browser process, OS key store or real login is used. */
export function createPasswordManagerUIFixture({ dataDir }) {
  const key = randomBytes(32), opens = [], exports = [];
  const logins = [
    { origin: 'https://password-ui.example.test', username: 'synthetic-primary@example.test', label: 'QA primary login', password: 'fixture-only-' + randomBytes(18).toString('base64url') },
    { origin: 'https://other-password-ui.example.test', username: 'synthetic-other@example.test', label: 'QA other login', password: 'fixture-only-' + randomBytes(18).toString('base64url') },
  ];
  let selection = [];
  return {
    logins, opens, exports, draftPassword: 'fixture-draft-' + randomBytes(18).toString('base64url'),
    expectExport(entries) { selection = [...entries]; },
    options: {
      credentialStorage: {
        storageBackend: 'dpapi', // Deliberate injected interface label; this fixture does NOT verify DPAPI.
        encryptSecret(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
        decryptSecret(value) { const raw = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'); },
      },
      protectCredentialTemporaryDirectory: async () => ({ protected: true, fixtureOnly: true }),
      browserCredentialDestinations: {
        async status() { return [{ id: 'chrome', name: 'Google Chrome' }, { id: 'firefox', name: 'Mozilla Firefox' }, { id: 'neo', name: 'BrowserOS Neo' }].map(item => ({ ...item, available: true, supported: true, automaticImport: false })); },
        async open(destination, options) { assert.equal(options.source, 'user'); assert.ok(['chrome', 'firefox', 'neo'].includes(destination)); assert.equal(opens.length, 0, 'The UI journey must start exactly one native-open fixture.'); opens.push({ destination, fixtureOnly: true, importCompleted: false }); return { requested: true, windowVerified: false, importCompleted: false, profileVerified: false }; },
        async close() {},
      },
      async revealCredentialImportFile(filePath) {
        const relative = path.relative(path.resolve(dataDir), path.resolve(filePath));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(filePath) === 'passwords.csv', 'The fixture may inspect only its disposable password CSV.');
        const bytes = await fs.readFile(filePath, 'utf8'), csvMatches = selection.length === 1 && bytes === expectedCSV(selection);
        assert.ok(csvMatches, 'The temporary CSV must contain exactly the selected synthetic login, with no extra entry.');
        assert.equal(exports.length, 0, 'Only one temporary export may be handed off.');
        exports.push({ filePath, destination: opens.at(-1)?.destination, csvMatches, count: selection.length });
      },
    },
  };
}

/** The real Settings UI, routes, vault, mirror and temporary-file cleanup; native import is a fixture. */
export async function browserCredentialsUIJourney({ api, app, runtime, fixture, report, cdp, session, evaluate, until, waitVisible, click, fill, select, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.passwordManager = { fixtureOnly: true, encryptedStorage: 'Injected AES-256-GCM test double', nativeDPAPIVerified: false, nativeBrowserImportPerformed: false, modelTurnsBefore: runtime.calls.length, handoffs: [] };
  const originalDraft = await evaluate(() => document.querySelector('#mission-task').value);
  const current = () => api('/api/browser-credentials');
  const ready = selector => until('the ready Password manager control ' + selector, () => evaluate(selector => {
    const node = document.querySelector(selector);
    return Boolean(node && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }));
  }, selector));
  const press = async selector => { await ready(selector); await click(selector); };
  const idle = () => until('the Password manager request to settle', () => evaluate(() => document.querySelector('#configure-credentials-mount')?.getAttribute('aria-busy') === 'false'));
  const fillPassword = async value => {
    await ready('#credentials-password');
    await evaluate(() => { const field = document.querySelector('#credentials-password'); field.scrollIntoView({ block: 'center', behavior: 'instant' }); field.focus(); field.select(); });
    await cdp.call('Input.insertText', { text: value }, session);
    assert.ok(await evaluate(value => { const field = document.querySelector('#credentials-password'); return field?.type === 'password' && field.value === value; }, value), 'Trusted browser input must reach the masked fixture password field.');
  };
  const secretsAbsent = () => evaluate(values => {
    const html = document.documentElement.outerHTML, rendered = document.body.textContent, stored = [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).map(key => storage.getItem(key) || ''));
    return { markup: values.every(value => !html.includes(value)), text: values.every(value => !rendered.includes(value)), storage: values.every(value => stored.every(item => !item.includes(value))), url: values.every(value => !location.href.includes(value)), masked: document.querySelector('#credentials-password')?.type === 'password', passwordAttributeAbsent: !document.querySelector('#credentials-password')?.hasAttribute('value') };
  }, [...fixture.logins.map(item => item.password), fixture.draftPassword]);
  const noExports = async () => { try { return (await fs.readdir(app.browserCredentialMirror.exportRoot)).length === 0; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
  const metadataOnly = value => fixture.logins.every(login => !JSON.stringify(value).includes(login.password));
  const readCount = () => cdp.networkUrls.filter(value => new URL(value).pathname === '/api/browser-credentials').length;
  const originalDesktopVisible = (await api('/api/status')).desktopLifecycle?.visible;
  let desktopChanged = false;
  try {
    await resize(1440, 900); await click('#workspace-modes [data-mode="configure"]'); await waitVisible('.browser-credentials'); await idle();
    const initial = await current();
    assert.ok(initial.localManagement && initial.vault.available && initial.vault.healthy && initial.mirror.available && initial.mirror.healthy);
    assert.equal(initial.vault.entries.length, 0); assert.equal(initial.mirror.settings.enabled, false);
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#credentials-destination option')].map(option => ({ id: option.value, label: option.textContent }))), [{ id: 'chrome', label: 'Google Chrome' }, { id: 'firefox', label: 'Mozilla Firefox' }, { id: 'neo', label: 'BrowserOS Neo' }]);
    assert.equal(await evaluate(() => document.querySelector('#credentials-auto-queue').checked), false);
    check(PASSWORD_MANAGER_UI_CHECKS[0]);

    await click('#credentials-add > summary'); await waitVisible('#credentials-password');
    const saved = [];
    for (const login of fixture.logins) {
      await fill('#credentials-origin', login.origin); await fill('#credentials-username', login.username); await fill('#credentials-label', login.label); await fillPassword(login.password);
      assert.ok(Object.values(await secretsAbsent()).every(Boolean), 'The synthetic password must remain absent from markup, visible text, browser storage and URLs.');
      await press('#credentials-save');
      const value = await until('the saved synthetic login metadata', async () => { const value = await current(); return value.vault.entries.find(item => item.origin === login.origin && item.username === login.username); });
      await idle();
      assert.ok(await evaluate(() => document.querySelector('#credentials-password').value === ''), 'A confirmed save must clear the local password field.');
      assert.ok(metadataOnly(await current()), 'Status responses must contain only credential metadata.'); saved.push(value);
    }
    const sealed = await fs.readFile(app.browserCredentials.store.file, 'utf8');
    assert.ok(fixture.logins.every(login => !sealed.includes(login.password)), 'The actual vault file must not contain the synthetic passwords in plaintext.');
    assert.equal(await evaluate(() => document.querySelectorAll('[data-credentials-select]:checked').length), 0);
    evidence.savedCount = saved.length; evidence.passwordsClearedAfterSave = true; evidence.metadataOnly = true; evidence.encryptedFixtureAtRest = true;
    check(PASSWORD_MANAGER_UI_CHECKS[1]); report.features.passwordManagerLocal = true;

    await fill('#credentials-origin', 'https://unsaved-password-ui.example.test'); await fill('#credentials-username', 'unsaved-fixture@example.test'); await fillPassword(fixture.draftPassword);
    await evaluate(() => { const field = document.querySelector('#credentials-password'); field.focus(); field.setSelectionRange(3, 10, 'backward'); globalThis.__qaPasswordDraft = { field, selection: [field.selectionStart, field.selectionEnd, field.selectionDirection], scrollTop: field.scrollTop }; });
    const beforePoll = readCount();
    await api(originalDesktopVisible ? '/api/desktop/background' : '/api/desktop/show', 'POST', {}); desktopChanged = true;
    await until('an unrelated Settings status update during the password draft', () => evaluate(selector => Boolean(document.querySelector(selector)), originalDesktopVisible ? '#desktop-show' : '#desktop-background'));
    await until('an automatic password metadata poll', () => readCount() > beforePoll);
    await idle();
    const retained = await evaluate(expected => {
      const field = document.querySelector('#credentials-password'), saved = globalThis.__qaPasswordDraft;
      return { sameNode: field === saved.field, focused: document.activeElement === field, draftMatches: field.value === expected, selection: JSON.stringify([field.selectionStart, field.selectionEnd, field.selectionDirection]) === JSON.stringify(saved.selection), scroll: field.scrollTop === saved.scrollTop, masked: field.type === 'password' };
    }, fixture.draftPassword);
    assert.ok(Object.values(retained).every(Boolean), 'Automatic polling and the unrelated status update must preserve the exact masked draft and its focus.');
    evidence.draftPreservation = retained; assert.ok(Object.values(await secretsAbsent()).every(Boolean));
    check(PASSWORD_MANAGER_UI_CHECKS[2]);
    await press('[data-credentials-action="clear-draft"]');
    assert.ok(await evaluate(() => document.querySelector('#credentials-password').value === ''));
    await evaluate(() => { delete globalThis.__qaPasswordDraft; });

    await select('#credentials-destination', 'firefox'); await click('#credentials-auto-queue'); await press('#credentials-save-preferences');
    const queued = await until('the explicit automatic encrypted queue preference', async () => { const value = await current(); return value.mirror.settings.enabled && value.mirror.settings.destination === 'firefox' && value.mirror.entries.length === saved.length && value; });
    await idle();
    assert.deepEqual(queued.mirror.entries.map(item => [item.credentialId, item.credentialRevision, item.destination, item.state]).sort(), saved.map(item => [item.credentialId, item.revision, 'firefox', 'pending']).sort());
    assert.equal(fixture.opens.length, 0); assert.equal(fixture.exports.length, 0); assert.ok(await noExports());
    const encryptedQueue = await fs.readFile(app.browserCredentialMirror.store.file, 'utf8'); assert.ok(fixture.logins.every(login => !encryptedQueue.includes(login.password)));
    evidence.automaticQueue = { optIn: true, pending: queued.mirror.entries.length, nativeHandoffs: 0, temporaryFiles: 0 };
    check(PASSWORD_MANAGER_UI_CHECKS[3]);

    await waitVisible(`[data-credentials-select="${saved[0].credentialId}"]`); await click(`[data-credentials-select="${saved[0].credentialId}"]`);
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('[data-credentials-select]:checked')].map(input => input.dataset.credentialsSelect)), [saved[0].credentialId]);
    fixture.expectExport([fixture.logins[0]]);
    await press('[data-credentials-action="copy-selected"]');
    const awaiting = await until('one native import batch awaiting the user', async () => { const value = await current(); return value.mirror.batches.length === 1 && value.mirror.batches[0].state === 'awaiting_browser_import' && fixture.exports.length === 1 && value; });
    await idle(); await waitVisible('[data-credentials-action="confirm"]');
    const batch = awaiting.mirror.batches[0], copied = awaiting.mirror.entries.filter(item => item.batchId === batch.batchId), untouched = awaiting.mirror.entries.find(item => item.credentialId === saved[1].credentialId);
    assert.deepEqual(copied.map(item => [item.credentialId, item.credentialRevision, item.destination]), [[saved[0].credentialId, saved[0].revision, 'firefox']]);
    assert.equal(batch.count, 1); assert.equal(untouched.state, 'pending'); assert.equal(untouched.batchId, null); assert.equal(fixture.opens.length, 1); assert.equal(fixture.exports[0].csvMatches, true); assert.equal(fixture.opens[0].destination, 'firefox'); await fs.access(fixture.exports[0].filePath);
    evidence.selectedCredential = { credentialId: saved[0].credentialId, revision: saved[0].revision }; evidence.selectedCount = 1; evidence.unselectedRemainedPending = true;
    check(PASSWORD_MANAGER_UI_CHECKS[4]);
    const words = await evaluate(() => document.querySelector('#credentials-batches').textContent);
    assert.match(words, /Awaiting browser import/); assert.match(words, /profile/); assert.match(words, /unlock/); assert.match(words, /Import passwords/); assert.match(words, /does not mean the import completed/); assert.doesNotMatch(words, /Confirmed by you|[Ss]ynced|[Ss]ynchroni[sz]ed/);
    assert.ok(Object.values(await secretsAbsent()).every(Boolean));
    evidence.awaitingImport = true; evidence.nativeImportClaimed = false;
    check(PASSWORD_MANAGER_UI_CHECKS[5]); report.features.passwordManagerNativeHandoff = true;
    await evaluate(() => document.querySelector('#credentials-batches').scrollIntoView({ block: 'center', behavior: 'instant' })); await screenshot('59-password-manager-import-desktop.jpg');

    // Measure the actual visible controls, not merely a page-level scrollbar.
    for (const [width, index] of [[390, 7], [320, 8]]) {
      await resize(width, 844);
      const measured = await evaluate(async () => {
        const root = document.querySelector('.browser-credentials');
        const selectors = ['#credentials-origin', '#credentials-username', '#credentials-password', '#credentials-save', '#credentials-destination', '[data-credentials-action="copy-selected"]', '[data-credentials-action="confirm"]', '[data-credentials-action="cancel"]'];
        const controls = [];
        for (const selector of selectors) {
          const node = document.querySelector(selector); node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const box = node.getBoundingClientRect(), front = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          controls.push({ selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, visible: node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }), hit: Boolean(front && node.contains(front)) });
        }
        return { width: innerWidth, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, controls };
      });
      assert.equal(measured.width, width); assert.ok(measured.scrollWidth <= measured.clientWidth + 2);
      assert.ok(measured.controls.every(value => value.visible && value.hit && value.width >= 80 && value.height >= 30 && value.left >= -1 && value.right <= width + 1 && value.top >= -1 && value.bottom <= 845), 'Every measured password manager field and import control must fit and be hittable at the requested narrow width.');
      report.measurements.push({ label: `${width}px password manager controls`, ...measured });
      check(PASSWORD_MANAGER_UI_CHECKS[index], await geometry(`${width}px password manager`));
      await screenshot(`60-password-manager-${width}.jpg`);
    }
    report.features.passwordManagerMobile = true; await resize(1440, 900);

    await press('[data-credentials-action="confirm"]');
    const confirmed = await until('the explicit user import confirmation', async () => { const value = await current(); return value.mirror.batches[0]?.state === 'confirmed_by_user' && value; });
    await idle();
    await until('the truthful confirmed import UI', () => evaluate(() => /Confirmed by you/.test(document.querySelector('#credentials-batches').textContent) && /not independently verified/.test(document.querySelector('#credentials-batches').textContent)));
    assert.equal(confirmed.mirror.batches[0].batchId, batch.batchId); assert.equal(confirmed.mirror.batches.length, 1); await assert.rejects(fs.access(fixture.exports[0].filePath), { code: 'ENOENT' });
    assert.equal(fixture.opens.length, 1); assert.ok(await noExports());
    evidence.confirmation = { state: 'confirmed_by_user', independentlyVerified: false, temporaryFileRemoved: true };
    check(PASSWORD_MANAGER_UI_CHECKS[6]);

    // Return the disposable Settings preferences and desktop fixture to an idle state.
    await click('#credentials-auto-queue'); await press('#credentials-save-preferences');
    await until('automatic copying disabled after the fixture', async () => !(await current()).mirror.settings.enabled); await idle();
    if (desktopChanged) { await api(originalDesktopVisible ? '/api/desktop/show' : '/api/desktop/background', 'POST', {}); desktopChanged = false; }
    assert.ok(Object.values(await secretsAbsent()).every(Boolean)); assert.ok(await evaluate(() => document.querySelector('#credentials-password').value === '')); assert.ok(await noExports()); assert.equal(runtime.calls.length, evidence.modelTurnsBefore);
    assert.equal(fixture.opens.length, 1); assert.equal(fixture.exports.length, 1);
    check(PASSWORD_MANAGER_UI_CHECKS[9]);
    await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); assert.equal(await evaluate(() => document.querySelector('#mission-task').value), originalDraft);
  } finally {
    evidence.handoffs = fixture.exports.map(value => ({ destination: value.destination, fileName: path.basename(value.filePath), selectedCount: value.count, csvMatches: value.csvMatches, fixtureOnly: true }));
    evidence.nativeOpenCalls = fixture.opens.length; evidence.modelTurnsAfter = runtime.calls.length;
    await evaluate(() => { const input = document.querySelector('#credentials-password'); if (input) input.value = ''; delete globalThis.__qaPasswordDraft; }).catch(() => {});
    if (desktopChanged) await api(originalDesktopVisible ? '/api/desktop/show' : '/api/desktop/background', 'POST', {}).catch(() => {});
  }
}
