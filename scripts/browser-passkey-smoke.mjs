/**
 * Run with a candidate's raw Electron executable, never the installed app.
 * electron scripts/browser-passkey-smoke.mjs --output=<absolute-report.json>
 * Add --source=<checkout> to exercise a different checkout with this fixture.
 * Add --baseline-capabilities to observe native capability values without the
 * conditional-site simulation or any expectation that those values are false.
 * No mode calls CredentialsContainer.get/create or creates an authenticator.
 */
import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixturePath = fileURLToPath(import.meta.url);
const source = path.resolve(option('source') || path.join(path.dirname(fixturePath), '..'));
const output = option('output');
if (!output || !path.isAbsolute(output)) throw Error('Supply --output=<absolute report path outside source>.');
const reportPath = path.resolve(output), relativeReport = path.relative(source, reportPath);
if (!relativeReport || !relativeReport.startsWith('..' + path.sep) && !path.isAbsolute(relativeReport)) throw Error('Keep machine-specific evidence outside source.');
const baseline = process.argv.includes('--baseline-capabilities');
const root = mkdtempSync(path.join(tmpdir(), 'blackice-passkey-smoke-'));
const profile = path.join(root, 'profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setName('BLACKICE isolated passkey smoke');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP localhost 127.0.0.1');
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});

const report = {
  format: 1, suite: 'browser-passkey-native', source, profile,
  mode: baseline ? 'baseline-capabilities-only' : 'conditional-capability-correction',
  platform: process.platform, electron: process.versions.electron, node: process.versions.node,
  startedAt: new Date().toISOString(), actualUserBrowserAccessed: false,
  fixtureURLsAreLoopbackOnly: true, actualCredentialRequests: 0,
  referenceSessionIsSeparateAndInMemory: true, stages: [], checks: [], failures: [], contexts: [],
  sitePerProcessEnabled: true,
};
let driver, browser, server, referenceSession, primaryOrigin, secondaryOrigin, finished = false;
const fixtureSockets = new Set(), referenceWindows = new Set();
const save = () => { mkdirSync(path.dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); };
const stage = name => { report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); save(); console.log(`[passkey-smoke] ${name}`); };
const verify = (label, check) => {
  try { check(); report.checks.push(label); }
  catch (error) { report.failures.push({ label, error: error.message }); }
};
const watchdog = setTimeout(() => {
  if (finished) return;
  report.passed = false; report.error = 'Disposable passkey smoke exceeded 90 seconds.'; report.finishedAt = new Date().toISOString();
  try { save(); } catch (error) { console.error(error); }
  try {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    for (const socket of fixtureSockets) socket.destroy();
    server?.closeAllConnections();
  } catch (error) { console.error(error); }
  console.error(`[passkey-smoke] watchdog expired; report: ${reportPath}`);
  app.exit(1);
}, 90000);

async function deadline(work, milliseconds, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const end = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() >= end) throw Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function sourceHashes() {
  const files = ['desktop/browser-driver.mjs', 'lib/browser.mjs'];
  const walk = async relative => {
    const stat = await fs.stat(path.join(source, relative));
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(path.join(source, relative))) await walk(path.join(relative, entry));
    } else if (stat.isFile()) files.push(relative);
  };
  for (const entry of await fs.readdir(path.join(source, 'desktop'))) if (/passkey|webauthn|browser-compatibility/i.test(entry)) await walk(path.join('desktop', entry));
  const hashes = {};
  for (const relative of files.sort()) hashes[relative.split(path.sep).join('/')] = await digest(path.join(source, relative));
  return hashes;
}

// This function becomes the FIRST inline script in every HTTP document. Probe
// calls happen synchronously during that script; host reads only the saved
// promises/results later. The simulated site's "request" is only a counter.
function pageBootstrap(config) {
  const firstScript = { readyState: document.readyState, scriptCount: document.scripts.length, bodyAbsent: document.body === null };
  const evidence = { documentToken: crypto.randomUUID(), role: config.role, href: location.href, origin: location.origin, firstScript, records: [], emptyFrameAliasesMatch: null };
  const errors = error => ({ name: String(error?.name || 'Error'), message: String(error?.message || error) });
  function explicitMethods(realm) {
    try {
      const credentials = realm.navigator.credentials, prototype = realm.CredentialsContainer?.prototype;
      return Object.fromEntries(['get', 'create'].map(name => {
        const method = credentials?.[name], descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, name);
        return [name, { type: typeof method, name: method?.name, length: method?.length,
          source: typeof method === 'function' ? realm.Function.prototype.toString.call(method) : null,
          own: Boolean(credentials && Object.hasOwn(credentials, name)), prototypeMatch: Boolean(prototype && method === prototype[name]),
          descriptor: descriptor ? { writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable } : null }];
      }));
    } catch (error) { return { error: errors(error) }; }
  }
  function query(realm, role) {
    const record = { role, href: realm.location.href, origin: realm.origin, secureContext: realm.isSecureContext,
      topLevel: realm === realm.top, caller: { ...firstScript }, explicit: explicitMethods(realm),
      nodeGlobals: { process: typeof realm.process, require: typeof realm.require },
      simulationEnabled: config.simulate, attempts: { conditionalProbe: 0, clientCapabilities: 0 } };
    evidence.records.push(record);
    const key = realm.PublicKeyCredential;
    // Invoke both methods now, before the parser can run any later page script.
    const call = (name, field) => {
      try {
        if (typeof key?.[name] !== 'function') throw Error(`${name} is unavailable`);
        const result = Reflect.apply(key[name], key, []);
        record[field + 'ReturnedPromise'] = Boolean(result && typeof result.then === 'function');
        return Promise.resolve(result).then(value => { record[field] = value; }, error => { record[field + 'Error'] = errors(error); });
      } catch (error) { record[field + 'Error'] = errors(error); return Promise.resolve(); }
    };
    const conditional = call('isConditionalMediationAvailable', 'conditional'), capabilities = call('getClientCapabilities', 'capabilities');
    return Promise.all([conditional, capabilities]).then(() => {
      // Stand-ins for two common site's feature-detection branches. Never call
      // native get/create, even if an unpatched page advertises support.
      if (config.simulate && record.conditional === true) record.attempts.conditionalProbe++;
      if (config.simulate && record.capabilities?.conditionalGet === true) record.attempts.clientCapabilities++;
    });
  }
  const pending = [query(globalThis, 'document')];
  if (config.emptyFrame) {
    const frame = document.createElement('iframe'); frame.name = 'immediate-empty-frame'; frame.hidden = true;
    document.documentElement.appendChild(frame);
    const direct = frame.contentWindow, viaFrames = window.frames[window.frames.length - 1];
    evidence.emptyFrameAliasesMatch = direct === viaFrames;
    // No load event, timeout, body script or await is allowed before these calls.
    pending.push(query(direct, 'empty-iframe:contentWindow'), query(viaFrames, 'empty-iframe:window.frames'));
  }
  let parentAccessible = true;
  try { void parent.document; } catch { parentAccessible = false; }
  evidence.parentAccessible = parentAccessible;
  evidence.openerPresent = Boolean(opener);
  const done = Promise.all(pending);
  globalThis.__blackicePasskeySmoke = { read: () => done.then(() => ({ ...evidence, explicitAtRead: explicitMethods(globalThis) })) };
  if (config.popupURL) document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#open-popup').addEventListener('click', () => { window.open(config.popupURL, '_blank'); });
  }, { once: true });
}

const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const urlFor = (origin, pathname, audience) => `${origin}${pathname}?audience=${audience}`;
function fixturePage(requestURL) {
  const reference = requestURL.searchParams.get('audience') === 'reference', audience = reference ? 'reference' : 'contained';
  const role = requestURL.pathname === '/frame' ? requestURL.hostname === 'localhost' ? 'cross-origin' : 'same-origin' : requestURL.pathname === '/popup' ? 'popup' : 'top';
  const top = role === 'top', popupURL = top ? urlFor(primaryOrigin, '/popup', audience) : null;
  const config = { role, simulate: !baseline && !reference, emptyFrame: top || role === 'popup', popupURL };
  return `<!doctype html><html><head><script>(${pageBootstrap.toString()})(${JSON.stringify(config)})</script><meta charset="utf-8"><title>Disposable passkey capability fixture</title></head><body>
    <h1>${escapeHTML(role)} capability fixture</h1>${top ? `<button id="open-popup">Open local fixture popup</button><iframe title="Same-origin fixture" src="${escapeHTML(urlFor(primaryOrigin, '/frame', audience))}" allow="publickey-credentials-get *; publickey-credentials-create *"></iframe><iframe title="Cross-origin fixture" src="${escapeHTML(urlFor(secondaryOrigin, '/frame', audience))}" allow="publickey-credentials-get *; publickey-credentials-create *"></iframe>` : ''}
    </body></html>`;
}
function localURL(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && [primaryOrigin, secondaryOrigin].includes(url.origin) && !url.username && !url.password; }
  catch { return false; }
}
async function collect(contents, label, expectedRoles) {
  await until(() => !contents.isDestroyed() && !contents.isLoading(), `${label} document loading`);
  const frames = [...new Set([contents.mainFrame, ...contents.mainFrame.framesInSubtree])].filter(frame => localURL(frame.url));
  const pages = await Promise.all(frames.map(async frame => {
    const value = await deadline(frame.executeJavaScript("(() => { const fixture = globalThis.__blackicePasskeySmoke; if (!fixture) throw Error('First inline capability evidence is missing'); return fixture.read(); })()"), 8000, `${label} first-script result`);
    return { ...value, frameURL: frame.url, frameName: frame.name, webContentsId: contents.id,
      frameProcessId: frame.processId, mainFrameProcessId: contents.mainFrame.processId };
  }));
  report.contexts.push({ label, pages });
  verify(`${label}: expected real frame contexts loaded`, () => assert.deepEqual(pages.map(page => page.role).sort(), [...expectedRoles].sort()));
  for (const page of pages) {
    const id = `${label}/${page.role}`;
    verify(`${id}: probes originated in the first inline script`, () => assert.deepEqual(page.firstScript, { readyState: 'loading', scriptCount: 1, bodyAbsent: true }));
    verify(`${id}: loaded the intended loopback origin`, () => assert.equal(page.origin, page.role === 'cross-origin' ? secondaryOrigin : primaryOrigin));
    verify(`${id}: cross-origin relationship is real`, () => assert.equal(page.parentAccessible, page.role !== 'cross-origin'));
    if (page.role === 'cross-origin') verify(`${id}: cross-origin frame runs in another renderer process`, () => {
      assert.ok(Number.isInteger(page.frameProcessId)); assert.ok(Number.isInteger(page.mainFrameProcessId));
      assert.notEqual(page.frameProcessId, page.mainFrameProcessId);
    });
    verify(`${id}: explicit methods remain intact after loading`, () => assert.deepEqual(page.explicitAtRead, page.records.find(record => record.role === 'document')?.explicit));
    if (['top', 'popup'].includes(page.role)) verify(`${id}: immediate empty iframe is reachable through both aliases`, () => {
      assert.equal(page.emptyFrameAliasesMatch, true);
      assert.deepEqual(page.records.map(record => record.role).sort(), ['document', 'empty-iframe:contentWindow', 'empty-iframe:window.frames'].sort());
    });
    for (const record of page.records) verify(`${id}/${record.role}: secure native capability queries and sandbox`, () => {
      assert.equal(record.secureContext, true);
      assert.deepEqual(record.caller, page.firstScript);
      assert.deepEqual(record.nodeGlobals, { process: 'undefined', require: 'undefined' });
      assert.equal(record.conditionalError, undefined); assert.equal(record.capabilitiesError, undefined);
      assert.equal(record.conditionalReturnedPromise, true); assert.equal(record.capabilitiesReturnedPromise, true);
      assert.equal(typeof record.conditional, 'boolean');
      assert.ok(record.capabilities && typeof record.capabilities === 'object');
      assert.equal(typeof record.capabilities.conditionalGet, 'boolean');
      for (const method of Object.values(record.explicit)) { assert.equal(method.type, 'function'); assert.match(method.source, /\[native code\]/); assert.equal(method.prototypeMatch, true); assert.equal(method.own, false); }
    });
  }
  return pages;
}
function compare(pages, references, label) {
  for (const page of pages) for (const record of page.records) {
    const id = `${label}/${page.role}/${record.role}`, native = references.find(item => item.role === page.role)?.records.find(item => item.role === record.role);
    verify(`${id}: native explicit get/create and other capability fields preserved`, () => {
      assert.ok(native, 'Matching unmodified reference context is required');
      assert.deepEqual(record.explicit, native.explicit);
      const withoutConditionalGet = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'conditionalGet'));
      assert.deepEqual(withoutConditionalGet(record.capabilities), withoutConditionalGet(native.capabilities));
      assert.deepEqual(Object.keys(record.capabilities).sort(), Object.keys(native.capabilities).sort());
    });
    verify(`${id}: ${baseline ? 'capability-only baseline never simulates requests' : 'first-script correction prevents conditional-site attempts'}`, () => {
      assert.equal(record.simulationEnabled, !baseline);
      assert.deepEqual(record.attempts, { conditionalProbe: 0, clientCapabilities: 0 });
      if (!baseline) { assert.equal(record.conditional, false); assert.equal(record.capabilities.conditionalGet, false); }
    });
  }
}
function referenceOptions() {
  return { width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { session: referenceSession, offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, disableDialogs: true } };
}
function configureReference(window) {
  referenceWindows.add(window);
  window.webContents.setWindowOpenHandler(({ url }) => localURL(url) ? { action: 'allow', overrideBrowserWindowOptions: referenceOptions() } : { action: 'deny' });
  window.webContents.on('did-create-window', child => configureReference(child));
}
async function cleanUp() {
  report.cleanup = { errors: [] };
  for (const [label, close] of [['workspace', () => browser?.close()], ['driver', () => driver?.close()]]) {
    try { await deadline(Promise.resolve().then(close), 15000, `${label} cleanup`); }
    catch (error) { report.cleanup.errors.push(`${label}: ${error.message}`); }
  }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length;
  if (server) {
    const closing = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    for (const socket of fixtureSockets) socket.destroy(); server.closeAllConnections();
    try { await deadline(closing, 3000, 'loopback server cleanup'); } catch (error) { report.cleanup.errors.push(error.message); }
  }
  report.cleanup.remainingFixtureSockets = fixtureSockets.size;
  try { await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); report.cleanup.temporaryDirectoryRemoved = true; }
  catch (error) {
    // Windows can retain Chromium session file handles until this disposable
    // process exits. Report the exact owned directory instead of touching any
    // other profile or spawning a deletion process.
    report.cleanup.temporaryDirectoryRemoved = false;
    report.cleanup.temporaryDirectoryNote = `${error.code || error.message}; disposable directory: ${root}`;
  }
  if (report.cleanup.errors.length || report.cleanup.remainingWindows) report.passed = false;
}

async function main() {
  try {
    stage('waiting-for-electron-ready');
    await app.whenReady();
    report.fixtureHash = await digest(fixturePath); report.sourceHashes = await sourceHashes();
    const { ElectronBrowserDriver } = await import(pathToFileURL(path.join(source, 'desktop/browser-driver.mjs')).href);
    const { BrowserWorkspace } = await import(pathToFileURL(path.join(source, 'lib/browser.mjs')).href);
    stage('starting-loopback-only-fixture');
    server = http.createServer((request, response) => {
      let url;
      try { url = new URL(request.url, `http://${request.headers.host}`); }
      catch { response.writeHead(400); response.end(); return; }
      if (request.method !== 'GET' || !localURL(url.href) || !['/top', '/next', '/frame', '/popup'].includes(url.pathname)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; frame-src about: ${primaryOrigin} ${secondaryOrigin}; base-uri 'none'; form-action 'none'`);
      response.setHeader('Permissions-Policy', `publickey-credentials-get=(self "${primaryOrigin}" "${secondaryOrigin}"), publickey-credentials-create=(self "${primaryOrigin}" "${secondaryOrigin}")`);
      response.end(fixturePage(url));
    });
    server.on('connection', socket => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    primaryOrigin = `http://127.0.0.1:${server.address().port}`; secondaryOrigin = `http://localhost:${server.address().port}`;
    report.origins = [primaryOrigin, secondaryOrigin];
    referenceSession = session.fromPartition(`blackice-passkey-reference-${randomUUID()}`, { cache: false });
    referenceSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    referenceSession.setPermissionCheckHandler(() => false);
    referenceSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !localURL(details.url) }));
    const reference = new BrowserWindow(referenceOptions()); configureReference(reference);
    stage('querying-unmodified-reference-first-scripts');
    await deadline(reference.loadURL(urlFor(primaryOrigin, '/top', 'reference')), 15000, 'native reference load');
    const nativePages = await collect(reference.webContents, 'native-reference', ['top', 'same-origin', 'cross-origin']);
    stage('querying-unmodified-reference-popup');
    await reference.webContents.executeJavaScript("document.querySelector('#open-popup').click()", true);
    await until(() => [...referenceWindows].some(window => window !== reference && !window.isDestroyed() && window.webContents.getURL().startsWith(primaryOrigin + '/popup') && !window.webContents.isLoading()), 'native reference popup');
    const nativePopup = [...referenceWindows].find(window => window !== reference && !window.isDestroyed());
    const nativePopupPages = await collect(nativePopup.webContents, 'native-reference-popup', ['popup']);
    verify('Native popup preserves window.opener', () => assert.equal(nativePopupPages[0].openerPresent, true));
    nativePopup.destroy(); reference.destroy();
    stage('initializing-real-contained-driver');
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    driver = await new ElectronBrowserDriver({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'downloads') }).init();
    assert.notEqual(driver.session, referenceSession, 'Reference session must not receive the contained session correction.');
    browser = new BrowserWorkspace({ driver });
    stage('checking-initial-contained-first-scripts');
    const opened = await browser.perform({ action: 'open', url: urlFor(primaryOrigin, '/top', 'contained') }, { source: 'user' });
    const tabId = opened.tabId; let contents = driver.tab(tabId).window.webContents;
    const initial = await collect(contents, 'contained-initial', ['top', 'same-origin', 'cross-origin']); compare(initial, nativePages, 'contained-initial');
    stage('checking-reload-first-scripts');
    await browser.perform({ action: 'reload', browser: 'relay', tabId }, { source: 'user' });
    const reloaded = await collect(contents, 'contained-reload', ['top', 'same-origin', 'cross-origin']); compare(reloaded, nativePages, 'contained-reload');
    verify('Reload created a fresh document before the probes', () => assert.notEqual(reloaded.find(page => page.role === 'top').documentToken, initial.find(page => page.role === 'top').documentToken));
    stage('checking-new-document-first-scripts');
    await browser.perform({ action: 'navigate', browser: 'relay', tabId, url: urlFor(primaryOrigin, '/next', 'contained') }, { source: 'user' });
    const navigated = await collect(contents, 'contained-new-document', ['top', 'same-origin', 'cross-origin']); compare(navigated, nativePages, 'contained-new-document');
    verify('Navigation created a different document', () => assert.notEqual(navigated.find(page => page.role === 'top').documentToken, reloaded.find(page => page.role === 'top').documentToken));
    stage('checking-trusted-window-open-and-adopted-popup');
    const preview = await browser.perform({ action: 'screenshot', browser: 'relay', tabId }, { source: 'user' });
    const point = await contents.executeJavaScript("(() => { const r = document.querySelector('#open-popup').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    await browser.perform({ action: 'click', browser: 'relay', tabId, ...point, expectedUrl: preview.url, expectedDocumentId: preview.documentId }, { source: 'user' });
    await until(() => [...driver.tabs.values()].some(tab => tab.parentTabId === tabId && tab.window && !tab.window.isDestroyed() && tab.window.webContents.getURL().startsWith(primaryOrigin + '/popup') && !tab.window.webContents.isLoading()), 'contained adopted popup');
    const popup = [...driver.tabs.values()].find(tab => tab.parentTabId === tabId);
    const popupPages = await collect(popup.window.webContents, 'contained-adopted-popup', ['popup']); compare(popupPages, nativePopupPages, 'contained-adopted-popup');
    verify('Adopted local popup preserves its opener and parent tab', () => { assert.equal(popupPages[0].openerPresent, true); assert.equal(popup.parentTabId, tabId); });
    await browser.perform({ action: 'close', browser: 'relay', tabId: popup.id }, { source: 'user' });
    stage('checking-suspend-resume-with-recreated-window');
    const oldContents = contents, oldContentsId = contents.id;
    const suspended = await browser.perform({ action: 'suspend', browser: 'relay', tabId }, { source: 'user' });
    assert.equal(suspended.receipt.suspended, true); assert.equal(oldContents.isDestroyed(), true); assert.equal(driver.tab(tabId).window, null);
    await browser.perform({ action: 'screenshot', browser: 'relay', tabId }, { source: 'user' });
    contents = driver.tab(tabId).window.webContents;
    const resumed = await collect(contents, 'contained-resumed', ['top', 'same-origin', 'cross-origin']); compare(resumed, nativePages, 'contained-resumed');
    verify('Resume recreated both the renderer window and document', () => { assert.notEqual(contents.id, oldContentsId); assert.notEqual(resumed.find(page => page.role === 'top').documentToken, navigated.find(page => page.role === 'top').documentToken); });
    verify('All owned browser windows remained hidden and sandboxed', () => {
      for (const window of BrowserWindow.getAllWindows()) {
        assert.equal(window.isVisible(), false);
        const preferences = window.webContents.getLastWebPreferences();
        assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
      }
      assert.ok(driver.status().tabs.every(tab => !tab.visible && localURL(tab.url)));
    });
    const finalHashes = await sourceHashes();
    verify('Candidate source remained unchanged during the run', () => assert.deepEqual(finalHashes, report.sourceHashes));
    report.passed = report.failures.length === 0;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  finally {
    try { stage('closing-disposable-fixture'); } catch (error) { report.passed = false; console.error(error); }
    try { await cleanUp(); } catch (error) { report.passed = false; report.cleanupError = error.stack || String(error); }
    report.finishedAt = new Date().toISOString(); report.stage = 'complete';
    try { save(); } catch (error) { report.passed = false; console.error(error); }
    finished = true; clearTimeout(watchdog);
    console.log(JSON.stringify({ passed: report.passed, mode: report.mode, checks: report.checks.length, failures: report.failures.length, reportPath }));
    app.exit(report.passed ? 0 : 1);
  }
}
// Electron emits ready after its ESM entry finishes evaluating. Do not await
// app.whenReady() at module top level or the standalone fixture can deadlock.
void main();
