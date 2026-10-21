/** Windows acceptance: DPAPI, production opaque tools and hidden Chromium;
 * only newly owned HTTPS forms and a disposable encrypted profile are used. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, safeStorage } from 'electron';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWorkspace } from '../../lib/browser.mjs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BrowserCredentialVault } from '../../lib/browser-credentials.mjs';
import { BrowserCredentialMirror } from '../../lib/browser-credential-mirror.mjs';
import { credentialTemporaryProtection } from '../../lib/credential-temp-protection.mjs';
import { createBrowserCredentialToolHandler } from '../../lib/browser-credential-tools.mjs';
import { appFingerprint } from '../../scripts/release-check.mjs';
import { createFixtureCertificate, FIXTURE_HOSTNAME } from './remote-access-native-tls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), values = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--profile-dir', '--out', '--receipt', '--nonce'].includes(args[index]) && args[index + 1]);
  assert.equal(values[args[index]], undefined); values[args[index]] = args[index + 1];
}
const profile = values['--profile-dir'], out = values['--out'], receipt = values['--receipt'], nonce = values['--nonce'];
assert.equal(process.platform, 'win32'); assert.ok([profile, out, receipt].every(value => typeof value === 'string' && path.isAbsolute(value)));
assert.match(nonce, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
assert.equal(profile, path.join(out, 'owned-profile-' + nonce)); assert.equal(receipt, path.join(out, 'native-browser-credentials-result-' + nonce + '.json'));
assert.ok(!existsSync(profile) && !existsSync(receipt)); assert.ok(path.relative(ROOT, out).startsWith('..' + path.sep), 'Native evidence must be outside the candidate.');
mkdirSync(out, { recursive: true }); mkdirSync(profile); app.setPath('userData', profile); assert.equal(app.requestSingleInstanceLock(), true);
const resolverRules = `MAP ${FIXTURE_HOSTNAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
app.commandLine.appendSwitch('host-resolver-rules', resolverRules); app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = { schema: 1, fixture: 'browser-credentials-native', nonce, pid: process.pid, profile, candidate: ROOT, platform: process.platform, electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome, startedAt: new Date().toISOString(), passed: false, checks: [], errors: [], cleanup: false, forcedCleanup: false, sourceUnchanged: false, providerTurnsRequested: 0, externalAccountsTested: false, actualBrowserImportPerformed: false, networkPolicy: { loopbackOnly: true, resolverRules, certificatePinning: true }, foregroundEvents: [], features: {} };
const progress = path.join(out, 'native-browser-credentials-progress-' + nonce + '.json');
const SOURCE_FILES = ['lib/browser-credentials.mjs', 'lib/browser-credential-mirror.mjs', 'lib/browser-credential-tools.mjs', 'lib/credential-temp-protection.mjs', 'lib/browser.mjs', 'lib/engine.mjs', 'lib/browser-signin.mjs', 'desktop/browser-driver.mjs', 'desktop/browser-router.mjs', 'desktop/browser-capture.mjs', 'tests/fixtures/browser-credentials-native.mjs', 'tests/fixtures/remote-access-native-tls.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex')])));
let driver, workspace, vault, mirror, firstServer, secondServer, origin, foreignOrigin, tls, activeGate;
const receipts = [], snapshots = [], clients = new Set(), served = { pages: 0, unexpected: 0, submissions: 0 }, handoffs = [], protectedDirectories = new Set();
const dataDir = path.join(profile, 'credential-data');
const storage = { storageBackend: 'dpapi', isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(), encryptSecret: value => safeStorage.encryptString(value), decryptSecret: value => safeStorage.decryptString(value) };
function checkpoint(stage) { report.stage = stage; report.updatedAt = new Date().toISOString(); writeFileSync(progress, JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify({ stage, checks: report.checks.length }) + '\n'); }
function check(name, value) { assert.ok(value, name); assert.ok(!report.checks.includes(name)); report.checks.push(name); checkpoint(name); }
async function bounded(name, promise, milliseconds = 10000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(name + ' timed out.'), { code: 'FIXTURE_TIMEOUT' })), milliseconds); })]); } finally { clearTimeout(timer); } }
async function until(name, predicate) { const end = Date.now() + 12000; do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end); throw Object.assign(Error(name + ' did not settle.'), { code: 'FIXTURE_TIMEOUT' }); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const safeFailure = cause => ({ stage: report.stage, code: /^[A-Z][A-Z0-9_]{1,70}$/.test(cause?.code || '') ? cause.code : 'FIXTURE_CHECK_FAILED', frames: String(cause?.stack || '').split('\n').slice(1).filter(line => line.includes('browser-credentials-native.mjs')).slice(0, 4).map(line => line.trim()) });
const handle = entry => ({ credentialId: entry.credentialId, revision: entry.revision, origin: entry.origin });
const inspect = (tabId, code) => bounded('owned Chromium inspection', driver.tabs.get(tabId).window.webContents.executeJavaScript(code));
const tool = async arguments_ => { const handler = createBrowserCredentialToolHandler({ vault, browser: workspace, ownerId: 'native-owned:' + nonce }); const result = await bounded('opaque credential operation', handler({ name: 'relay_credentials', arguments: arguments_ }), 20000); receipts.push(result); return result; };
const payload = result => JSON.parse(result.contentItems[0].text);
const snapshot = async tabId => { const value = await bounded('fresh observed credential fields', workspace.perform({ action: 'snapshot', browser: 'relay', tabId })); snapshots.push(value); return value; };
const form = () => `<form id="signup"><label>Username<input id="username" name="username" type="email" autocomplete="username"></label><label>Password<input id="password" name="password" type="password" autocomplete="new-password"></label><label>Confirm password<input id="confirmation" name="confirmation" type="password" autocomplete="new-password"></label><button type="submit">Owned submit</button></form>`;
function serve(req, res) {
  clients.add(req.socket.remoteAddress); const requested = new URL(req.url, 'https://' + req.headers.host);
  if (requested.hostname !== FIXTURE_HOSTNAME || req.method !== 'GET') { served.unexpected++; if (req.method === 'POST') served.submissions++; res.writeHead(400); return res.end(); }
  if (requested.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!['/signup', '/frame', '/replacement'].includes(requested.pathname)) { served.unexpected++; res.writeHead(404); return res.end(); }
  served.pages++;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src ${origin} ${foreignOrigin}; form-action 'none'; connect-src 'none'; base-uri 'none'` });
  const children = requested.pathname === '/signup' ? `<iframe id="same" title="Same origin form" src="/frame"></iframe><iframe id="foreign" title="Different origin form" src="${foreignOrigin}/frame"></iframe>` : '';
  res.end(`<!doctype html><html><head><title>Owned protected credential fixture</title><style>body{font:16px system-ui;background:#eef0f4;color:#111;margin:16px}label{display:block;margin:8px}input{display:block;width:250px;height:26px}iframe{width:440px;height:310px;border:1px solid #888;margin:8px}button{margin:8px}</style></head><body><h1>Owned HTTPS form</h1>${form()}${children}<script>globalThis.qaReady=true;globalThis.qaSubmits=0;globalThis.qaInputs=0;document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();qaSubmits++;});document.addEventListener('input',()=>{qaInputs++;});</script></body></html>`);
}
function target(entry, view, frameUrl = view.url) {
  const frame = view.frames.find(value => value.url === frameUrl); assert.ok(frame, 'The owned frame must appear in the actual snapshot.');
  const find = name => frame.elements.find(value => value.name === name)?.ref;
  const result = { browser: 'relay', tabId: view.tabId, ...handle(entry), expectedUrl: view.url, expectedDocumentId: view.documentId, passwordRef: find('Password'), confirmationRef: find('Confirm password'), usernameRef: find('Username') };
  assert.ok(result.passwordRef && result.confirmationRef && result.usernameRef); return result;
}
async function fieldsMatch(entry, args) {
  return vault.withSecret(handle(entry), async value => {
    const frame = driver.tabs.get(args.tabId).refs.get(args.passwordRef); if (!frame) return false;
    return bounded('boolean-only owned password comparison', frame.executeJavaScript(`(() => {const p=document.querySelector('#password'),c=document.querySelector('#confirmation'),u=document.querySelector('#username');return p.type==='password'&&c.type==='password'&&p.value===${JSON.stringify(value.password)}&&c.value===${JSON.stringify(value.password)}&&u.value===${JSON.stringify(value.username)}&&qaSubmits===0;})()`));
  });
}
async function noPlaintext(entry, extra = []) {
  const paths = [];
  async function visit(directory) { for (const item of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); assert.ok(!item.isSymbolicLink()); if (item.isDirectory()) await visit(file); else if (item.isFile()) paths.push(file); } }
  await visit(vault.store.directory);
  return vault.withSecret(handle(entry), async value => {
    const bytes = await Promise.all(paths.map(file => fs.readFile(file)));
    return bytes.every(buffer => !buffer.includes(Buffer.from(value.password))) && !JSON.stringify([receipts, snapshots, report, extra]).includes(value.password);
  });
}
async function rejectedWithoutDecrypt(args) {
  let decryptions = 0; const access = vault.withSecret.bind(vault);
  vault.withSecret = (...values_) => { decryptions++; return access(...values_); };
  try { const result = await tool({ action: 'fill', ...args }); return result.success === false && decryptions === 0; }
  finally { vault.withSecret = access; }
}
app.on('browser-window-created', (_event, window) => { for (const name of ['show', 'focus']) window.on(name, () => report.foregroundEvents.push({ windowId: window.id, name })); });

async function run() {
  try {
    checkpoint('binding owned credential inputs'); report.sourceHashesBefore = await sourceHashes(); report.appFingerprintBefore = await appFingerprint(ROOT); report.sourceFingerprintBefore = report.appFingerprintBefore; report.version = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
    check('Windows protected credential encryption is available in the disposable Electron profile', safeStorage.isEncryptionAvailable() && process.platform === 'win32' && app.getPath('userData') === profile);
    report.encryptionBackend = 'windows-dpapi';
    tls = createFixtureCertificate();
    firstServer = https.createServer({ key: tls.key, cert: tls.certificate }, serve); secondServer = https.createServer({ key: tls.key, cert: tls.certificate }, serve);
    for (const server of [firstServer, secondServer]) await bounded('owned HTTPS startup', new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
    origin = `https://${FIXTURE_HOSTNAME}:${firstServer.address().port}`; foreignOrigin = `https://${FIXTURE_HOSTNAME}:${secondServer.address().port}`;
    driver = new ElectronBrowserDriver({ dataDir: profile, downloadDir: path.join(profile, 'downloads') }); await bounded('contained driver startup', driver.init(), 20000); await driver.session.setProxy({ mode: 'direct' });
    const certificateFingerprint = new X509Certificate(tls.certificate).fingerprint256;
    driver.session.setCertificateVerifyProc((request, callback) => { let matches = false; try { matches = request.hostname === FIXTURE_HOSTNAME && new X509Certificate(request.certificate.data).fingerprint256 === certificateFingerprint; } catch {} callback(matches ? 0 : -2); });
    workspace = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }) });
    vault = await new BrowserCredentialVault({ dataDir, ...storage }).init();
    check('The actual encrypted vault is available and starts with no saved logins', (await vault.status()).available === true && (await vault.list()).length === 0);
    const generated = await tool({ action: 'generate', origin, username: 'owned@example.test', label: 'Native acceptance only', requestId: 'native_signup', length: 24 });
    const entry = payload(generated); report.credential = handle(entry);
    check('Opaque generation saves a credential before returning its handle without a password', generated.success && entry.saved === true && entry.passwordReturned === false && typeof entry.credentialId === 'string' && entry.revision === 1 && !Object.hasOwn(entry, 'password') && existsSync(vault.store.file));
    const envelope = JSON.parse(await fs.readFile(vault.store.file, 'utf8'));
    check('The durable vault stores a protected envelope rather than a login record', envelope.encoding === 'base64' && typeof envelope.sealed === 'string' && !Object.hasOwn(envelope, 'entries') && await noPlaintext(entry));
    await vault.close(); vault = await new BrowserCredentialVault({ dataDir, ...storage }).init();
    const repeated = await tool({ action: 'generate', origin, username: 'owned@example.test', label: 'Native acceptance only', requestId: 'native_signup', length: 24 });
    check('A same-owner generation retry after reopening returns the original credential and revision', repeated.success && payload(repeated).existing && payload(repeated).credentialId === entry.credentialId && payload(repeated).revision === entry.revision && (await vault.list()).length === 1);
    const changed = await tool({ action: 'generate', origin, username: 'another@example.test', requestId: 'native_signup', length: 24 });
    check('A changed generation request cannot rotate or replace the saved password', !changed.success && (await vault.list()).length === 1 && (await vault.list())[0].revision === 1);
    const own = await tool({ action: 'list', origin }), other = await tool({ action: 'list', origin: foreignOrigin });
    check('Credential lookup returns metadata for the exact HTTPS origin only', own.success && payload(own).credentials.length === 1 && other.success && payload(other).credentials.length === 0);
    const opened = await workspace.perform({ action: 'open', browser: 'relay', url: origin + '/signup' });
    await until('owned main form and child frames', () => inspect(opened.tabId, 'qaReady===true && document.querySelector("#same").contentDocument?.querySelector("#password")?.type==="password"'));
    let view; await until('actual frame snapshot', async () => { view = await snapshot(opened.tabId); return view.frames.some(value => value.url === foreignOrigin + '/frame' && value.elements.some(item => item.type === 'password')); });
    let selected = target(entry, view);
    check('Actual Chromium observes password refs on a pinned owned HTTPS document', await inspect(opened.tabId, `isSecureContext && location.origin===${JSON.stringify(origin)}`) && view.documentId.startsWith(opened.tabId + ':') && view.frames.flatMap(frame => frame.elements).filter(element => element.type === 'password').every(element => !Object.hasOwn(element, 'value')));
    await inspect(opened.tabId, 'document.querySelector("#confirmation").hidden=true');
    check('A hidden confirmation field rejects the whole operation before decrypting or writing', await rejectedWithoutDecrypt(selected) && await inspect(opened.tabId, 'document.querySelector("#password").value===""&&qaInputs===0'));
    await inspect(opened.tabId, 'document.querySelector("#confirmation").hidden=false');
    const filled = await tool({ action: 'fill', ...selected });
    check('The opaque tool fills password, confirmation and username through the actual contained driver', filled.success && payload(filled).filled && await fieldsMatch(entry, selected));
    check('Filling reports no requested submission and emits no secret-bearing receipt', payload(filled).submissionRequested === false && payload(filled).passwordFilled === true && payload(filled).confirmationFilled === true && payload(filled).usernameFilled === true && await noPlaintext(entry));
    view = await snapshot(opened.tabId); selected = target(entry, view);
    check('Post-fill model snapshots continue to omit password values', view.frames.flatMap(frame => frame.elements).filter(element => element.type === 'password').every(element => !Object.hasOwn(element, 'value')) && await noPlaintext(entry));
    await inspect(opened.tabId, 'document.querySelector("#password").type="text";document.querySelector("#confirmation").type="text"');
    const shownPassword = await snapshot(opened.tabId);
    check('A site show-password toggle cannot expose an opaque-filled value in model snapshots', shownPassword.frames.find(frame => frame.url === shownPassword.url).elements.filter(element => ['Password', 'Confirm password'].includes(element.name)).every(element => !Object.hasOwn(element, 'value')) && await noPlaintext(entry));
    let agentCaptureBlocked = false; try { await workspace.perform({ action: 'screenshot', browser: 'relay', tabId: opened.tabId }); } catch (cause) { agentCaptureBlocked = cause.code === 'BROWSER_CREDENTIAL_CAPTURE_BLOCKED'; }
    const humanPreview = await workspace.perform({ action: 'screenshot', browser: 'relay', tabId: opened.tabId }, { source: 'user' });
    check('Agent screenshots are blocked after protected filling while the local human preview remains available', agentCaptureBlocked && typeof humanPreview.imageUrl === 'string' && humanPreview.imageUrl.startsWith('data:image/png;base64,') && humanPreview.width > 0 && humanPreview.height > 0);
    await inspect(opened.tabId, 'document.querySelector("#password").type="password";document.querySelector("#confirmation").type="password"');
    const sameFrame = target(entry, view, origin + '/frame'), sameFilled = await tool({ action: 'fill', ...sameFrame });
    check('A visible same-origin child frame can receive the exact credential', sameFilled.success && await fieldsMatch(entry, sameFrame));
    const foreign = target(entry, view, foreignOrigin + '/frame');
    check('A different-origin child frame cannot receive the credential', await rejectedWithoutDecrypt(foreign));
    await inspect(opened.tabId, 'document.querySelector("#password").value="";document.querySelector("#confirmation").value="";document.querySelector("#password").type="text";');
    check('A password ref changed to a text field is rejected before secret access', await rejectedWithoutDecrypt(selected) && await inspect(opened.tabId, 'document.querySelector("#password").value===""'));
    await inspect(opened.tabId, 'document.querySelector("#password").type="password"');
    const commit = await driver.prepareCredentialFill(selected);
    await inspect(opened.tabId, 'document.querySelector("#confirmation").readOnly=true');
    let commitRejected = false; try { await vault.withSecret(handle(entry), value => commit(value)); } catch { commitRejected = true; }
    check('Field editability is checked again inside the secret commit after preflight', commitRejected && await inspect(opened.tabId, 'document.querySelector("#password").value===""&&document.querySelector("#confirmation").value===""'));
    await inspect(opened.tabId, 'document.querySelector("#confirmation").readOnly=false');
    const reserved = driver.tabs.get(opened.tabId); reserved.purpose = 'chat-mode';
    check('The reserved human ChatGPT conversation tab is rejected before decryption', await rejectedWithoutDecrypt(selected)); delete reserved.purpose;
    const gate = { entered: deferred(), release: deferred() }; activeGate = gate;
    const heldRead = workspace.perform({ action: 'snapshot', browser: 'relay', tabId: opened.tabId }, { source: 'user', beforeDispatch: async () => { gate.entered.resolve(); await gate.release.promise; } });
    await bounded('held browser queue', gate.entered.promise);
    let authorized = true, openedSecrets = 0; const access = vault.withSecret.bind(vault); vault.withSecret = (...values_) => { openedSecrets++; return access(...values_); };
    const delayed = workspace.fillCredential(selected, { vault, beforeDispatch: () => { if (!authorized) throw Object.assign(Error('Revoked owned grant.'), { code: 'FIXTURE_REVOKED' }); } });
    authorized = false; gate.release.resolve(); await heldRead; let revoked = false; try { await delayed; } catch { revoked = true; } finally { vault.withSecret = access; activeGate = null; }
    check('A queued fill rechecks fresh authorization before decrypting', revoked && openedSecrets === 0 && await inspect(opened.tabId, 'document.querySelector("#password").value===""'));
    await workspace.perform({ action: 'navigate', browser: 'relay', tabId: opened.tabId, url: origin + '/replacement' });
    check('A changed top-level URL rejects the earlier credential target before secret access', await rejectedWithoutDecrypt(selected));
    const freshImage = await workspace.perform({ action: 'screenshot', browser: 'relay', tabId: opened.tabId });
    check('Agent screenshots become available after a real main-document replacement clears the protected form', typeof freshImage.imageUrl === 'string' && freshImage.imageUrl.startsWith('data:image/png;base64,') && await inspect(opened.tabId, 'document.querySelector("#password").value===""'));
    const replacement = await snapshot(opened.tabId), replacementTarget = target(entry, replacement);
    await workspace.perform({ action: 'navigate', browser: 'relay', tabId: opened.tabId, url: replacement.url });
    check('A same-URL replacement document invalidates its earlier password refs and document token', await rejectedWithoutDecrypt(replacementTarget));
    report.features.opaqueGenerateFill = true; report.features.exactDocumentAndOriginGuards = true; report.features.maskedSnapshots = true; report.features.protectedAgentCapture = true; report.features.sameRequestRetry = true; report.features.revocationBeforeDispatch = true;

    checkpoint('checking the explicit protected browser-copy lifecycle');
    const protect = credentialTemporaryProtection({ dataDir });
    mirror = await new BrowserCredentialMirror({ dataDir, vault, ...storage, protectTemporaryDirectory: async directory => {
      assert.ok(!existsSync(path.join(directory, 'passwords.csv')), 'No plaintext file may precede Windows ACL protection.');
      const result = await protect(directory); assert.equal(result.protected, true); protectedDirectories.add(directory); return result;
    }, beginImport: async value => {
      assert.ok(protectedDirectories.has(path.dirname(value.filePath))); assert.ok(value.filePath.startsWith(dataDir + path.sep));
      const csv = await fs.readFile(value.filePath, 'utf8');
      // This owned callback replaces only the external browser handoff. The
      // vault, encrypted queue, actual ACL and CSV creation are production code.
      assert.ok(csv.startsWith('name,url,username,password\r\n') && csv.includes('owned@example.test'));
      handoffs.push({ batchId: value.batchId, filePath: value.filePath, count: value.count, bytes: Buffer.byteLength(csv) });
      return { requested: true, importCompleted: false };
    } }).init();
    let mirrorState = await mirror.status();
    check('The encrypted outbound copy queue starts disabled and empty', mirrorState.available && mirrorState.settings.enabled === false && mirrorState.entries.length === 0 && handoffs.length === 0);
    const queued = await mirror.queue({ credentials: [handle(entry)].map(({ credentialId, revision }) => ({ credentialId, revision })), destination: 'chrome', requestId: 'owned_queue' }, { source: 'user', expectedRevision: mirrorState.revision });
    check('Explicit local queuing saves metadata without exporting or launching a browser', queued.entries.length === 1 && queued.entries[0].state === 'pending' && handoffs.length === 0 && await noPlaintext(entry));
    const batch = await bounded('protected owned import handoff', mirror.beginImport({ ids: queued.entries.map(value => value.id), requestId: 'owned_handoff' }, { source: 'user', expectedRevision: queued.revision }), 20000);
    check('An explicit owned handoff creates its CSV only after actual Windows user ACL protection', batch.state === 'awaiting_browser_import' && handoffs.length === 1 && handoffs[0].count === 1 && existsSync(handoffs[0].filePath) && protectedDirectories.has(path.dirname(handoffs[0].filePath)));
    const containsExpected = await vault.withSecret(handle(entry), async value => (await fs.readFile(handoffs[0].filePath, 'utf8')).includes('"' + value.password.replaceAll('"', '""') + '"'));
    check('The protected temporary CSV contains the selected credential while receipts omit it', containsExpected && !Object.hasOwn(batch, 'filePath') && await vault.withSecret(handle(entry), async value => !JSON.stringify([batch, report, receipts]).includes(value.password)));
    const retry = await mirror.beginImport({ ids: queued.entries.map(value => value.id), requestId: 'owned_handoff' }, { source: 'user', expectedRevision: batch.revision });
    check('An uncertain handoff retry reuses the same batch without a second export', retry.existing && retry.batchId === batch.batchId && handoffs.length === 1);
    const cancelled = await mirror.cancel({ batchId: batch.batchId }, { source: 'user', expectedRevision: retry.revision });
    check('Local cancellation deletes the owned plaintext file and preserves encrypted credential metadata', cancelled.state === 'cancelled' && !existsSync(handoffs[0].filePath) && (await vault.list()).length === 1 && await noPlaintext(entry));
    const queuedAgain = await mirror.queue({ credentials: [{ credentialId: entry.credentialId, revision: entry.revision }], destination: 'chrome', requestId: 'owned_queue_close' }, { source: 'user', expectedRevision: cancelled.revision });
    await bounded('owned close-cleanup handoff', mirror.beginImport({ ids: queuedAgain.entries.map(value => value.id), requestId: 'owned_handoff_close' }, { source: 'user', expectedRevision: queuedAgain.revision }), 20000);
    await mirror.close(); mirror = null;
    check('Closing the copy manager removes every temporary file owned by this fixture instance', handoffs.length === 2 && handoffs.every(value => !existsSync(value.filePath)) && await noPlaintext(entry));
    report.features.protectedTemporaryImport = true; report.temporaryCopy = { method: 'windows-user-acl', protectedBeforeWrite: true, handoffs: handoffs.length, selectedCredentials: 1, actualBrowserImportPerformed: false, cancelled: true, cleanupOnClose: true };
    check('Native credential acceptance never submits a form, contacts a real account or requests a provider turn', served.submissions === 0 && served.unexpected === 0 && report.providerTurnsRequested === 0 && clients.size > 0 && [...clients].every(value => ['127.0.0.1', '::ffff:127.0.0.1'].includes(value)));
    check('Every contained credential window remains hidden, nonfocusable and offscreen', report.foregroundEvents.length === 0 && BrowserWindow.getAllWindows().length > 0 && BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused() && !window.isFocusable() && window.webContents.isOffscreen()));
    check('Saved vault, queue and native evidence contain no generated password text', await noPlaintext(entry));
    report.features.actualDPAPI = true; report.features.noHostFocus = true;
  } catch (cause) { report.errors.push(safeFailure(cause)); checkpoint('native credential acceptance failed'); }
  finally {
    activeGate?.release.resolve();
    try {
      await bounded('closing owned credential queue', mirror?.close(), 15000); await bounded('closing owned vault', vault?.close());
      await bounded('closing owned contained browser', workspace ? workspace.close() : driver?.close(), 20000);
      for (const server of [firstServer, secondServer]) if (server?.listening) { server.closeAllConnections(); await bounded('closing owned TLS server', new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))); }
      report.cleanup = BrowserWindow.getAllWindows().length === 0 && !firstServer?.listening && !secondServer?.listening && handoffs.every(value => !existsSync(value.filePath));
      report.ownedProfileCleanup = { path: profile, createdByFixture: true, windowsClosed: BrowserWindow.getAllWindows().length === 0, serversClosed: !firstServer?.listening && !secondServer?.listening, temporaryExportsRemoved: handoffs.every(value => !existsSync(value.filePath)), retainedForPostExitCleanup: true, reason: 'The parent removes this exact newly owned profile only after the recorded Electron PID exits.' };
      check('Owned credential windows, servers and protected temporary exports close completely', report.cleanup);
      report.sourceHashesAfter = await sourceHashes(); report.appFingerprintAfter = await appFingerprint(ROOT); report.sourceFingerprintAfter = report.appFingerprintAfter; report.sourceUnchanged = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      check('Native credential acceptance leaves all candidate runtime inputs unchanged', report.sourceUnchanged);
    } catch (cause) { report.errors.push(safeFailure(cause)); }
    report.passed = report.errors.length === 0 && report.cleanup && report.sourceUnchanged && report.checks.length === 35; report.finishedAt = new Date().toISOString(); clearTimeout(deadline); checkpoint('native credential acceptance complete'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(report.passed ? 0 : 1);
  }
}
checkpoint('waiting for native credential readiness');
const deadline = setTimeout(() => { report.errors.push({ stage: report.stage, code: 'FIXTURE_HARD_DEADLINE' }); report.forcedCleanup = true; writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); }, 150000);
app.whenReady().then(run).catch(cause => { clearTimeout(deadline); report.errors.push(safeFailure(cause)); report.forcedCleanup = true; writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); });
