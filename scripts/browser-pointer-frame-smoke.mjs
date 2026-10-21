/**
 * Run with a candidate's raw Electron executable, never the installed app:
 * electron scripts/browser-pointer-frame-smoke.mjs --output=<absolute-report.json>
 * Optional --source=<checkout> selects the driver under test. The report must
 * live outside that checkout. Only disposable loopback pages and profiles are
 * used; no user sessions, authentication providers or credentials are accessed.
 */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixturePath = fileURLToPath(import.meta.url);
const source = path.resolve(option('source') || path.join(path.dirname(fixturePath), '..'));
const output = option('output');
if (!output || !path.isAbsolute(output)) throw Error('Supply --output=<absolute report path outside source>.');
const reportPath = path.resolve(output), relativeReport = path.relative(source, reportPath);
if (!relativeReport || !relativeReport.startsWith('..' + path.sep) && !path.isAbsolute(relativeReport)) throw Error('Keep machine-specific evidence outside source.');
const root = mkdtempSync(path.join(tmpdir(), 'blackice-pointer-frame-smoke-'));
const profile = path.join(root, 'profile'); mkdirSync(profile, { recursive: true });
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('BLACKICE isolated pointer frame smoke');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP localhost 127.0.0.1');
// The regression requires real separate renderers, verified below by process ID.
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});

const report = { format: 1, suite: 'browser-pointer-frame-native', source, profile,
  platform: process.platform, pid: process.pid, electron: process.versions.electron, node: process.versions.node,
  startedAt: new Date().toISOString(), actualUserBrowserAccessed: false, fixtureURLsAreLoopbackOnly: true,
  sitePerProcessEnabled: true, syntheticPointerEvents: 0, stages: [], checks: [], failures: [], inputs: [], popups: [], observations: [] };
let driver, browser, server, primaryOrigin, secondaryOrigin, phase = 'setup', finished = false;
const sockets = new Set();
const save = () => { mkdirSync(path.dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); };
// A GUI Electron process can outlive its launcher's redirected pipe. Keep
// progress in the durable report so a closed stdout never opens an error box.
const stage = name => { phase = name; report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); save(); };
const check = (name, fn) => { try { fn(); report.checks.push(name); } catch (error) { report.failures.push({ name, error: error.message }); } };
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(['desktop/browser-driver.mjs', 'lib/browser.mjs'].map(async relative => [relative, await digest(path.join(source, relative))])));
async function deadline(work, ms, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = 8000) {
  const end = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= end) throw Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const watchdog = setTimeout(() => {
  if (finished) return;
  report.passed = false; report.error = 'Disposable pointer frame smoke exceeded 90 seconds.'; report.finishedAt = new Date().toISOString();
  try { save(); } catch { /* The watchdog always exits unsuccessfully. */ }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  for (const socket of sockets) socket.destroy(); server?.closeAllConnections();
  app.exit(1);
}, 90000);

function childBootstrap() {
  const evidence = { clicks: 0, events: [], popups: [], ready: true, nodeGlobals: { process: typeof process, require: typeof require } };
  const button = document.querySelector('#sign-in');
  for (const type of ['pointermove', 'pointerdown', 'mousedown', 'mouseup', 'click']) button.addEventListener(type, event => {
    evidence.events.push({ type, trusted: event.isTrusted, target: event.target.id, active: navigator.userActivation.isActive });
  }, true);
  button.addEventListener('click', event => {
    evidence.clicks++;
    const popup = window.open('/popup', '_blank', 'width=500,height=400');
    const entry = { trusted: event.isTrusted, active: navigator.userActivation.isActive, opened: Boolean(popup), closed: false, completion: null };
    evidence.popups.push(entry);
    const complete = event => {
      if (event.source !== popup || event.origin !== location.origin || event.data?.fixture !== 'pointer-complete') return;
      entry.completion = event.data; window.removeEventListener('message', complete);
    };
    window.addEventListener('message', complete);
    if (popup) {
      const timer = setInterval(() => { if (popup.closed) { entry.closed = true; clearInterval(timer); } }, 25);
    }
  });
  globalThis.__pointerFixture = evidence;
}
function popupBootstrap() {
  const message = { fixture: 'pointer-complete', openerPresent: Boolean(opener), nodeGlobals: { process: typeof process, require: typeof require } };
  if (opener) opener.postMessage(message, location.origin);
  // Models an OAuth completion redirect that closes its script-opened window.
  setTimeout(() => window.close(), 200);
}
function page(url) {
  const head = '<!doctype html><html><head><meta charset="utf-8"><title>Disposable pointer frame fixture</title></head>';
  if (url.pathname === '/popup') return `${head}<body>Local completion<script>(${popupBootstrap.toString()})()</script></body></html>`;
  if (url.pathname === '/frame' || url.pathname === '/replacement') return `${head}<body style="margin:0"><button id="sign-in" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:220px;height:50px">Open sign-in popup</button><script>(${childBootstrap.toString()})()</script></body></html>`;
  return `${head}<body style="margin:0"><button id="root" style="position:absolute;left:20px;top:20px">Root control</button><iframe id="sign-in-frame" title="Cross-process sign-in" src="${secondaryOrigin}/frame" style="position:absolute;left:140px;top:140px;width:400px;height:200px;border:6px solid #789;transform:scale(.9) rotate(4deg)"></iframe><script>globalThis.__rootClicks=[];document.querySelector('#root').addEventListener('click',event=>__rootClicks.push({trusted:event.isTrusted}));</script></body></html>`;
}
function localURL(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && [primaryOrigin, secondaryOrigin].includes(url.origin) && !url.username && !url.password; }
  catch { return false; }
}
const frameRead = frame => deadline(frame.executeJavaScript('JSON.parse(JSON.stringify(globalThis.__pointerFixture))'), 4000, 'fixture frame evidence');
async function stable(tab) {
  let last = '', since = performance.now();
  await until(() => {
    const wc = tab.window.webContents;
    const current = JSON.stringify([tab.revision, wc.getURL(), wc.isLoading(), wc.mainFrame.framesInSubtree.map(frame => [frame.processId, frame.routingId, frame.url])]);
    if (current !== last || wc.isLoading()) { last = current; since = performance.now(); return false; }
    return performance.now() - since >= 500;
  }, 'stable fixture documents');
}
async function freshReference(tabId) {
  const snapshot = await browser.perform({ action: 'snapshot', browser: 'relay', tabId });
  const frame = snapshot.frames.find(frame => frame.url.startsWith(secondaryOrigin + '/frame'));
  const button = frame?.elements.find(element => element.name === 'Open sign-in popup' && element.role === 'button');
  assert.ok(button, 'Fresh snapshot must observe the actual cross-process button.');
  return { action: 'click', browser: 'relay', tabId, ref: button.ref, expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId };
}
async function verifyPhase(frame, tabId, count, label, firstEvent) {
  await until(async () => {
    const value = await frameRead(frame);
    return value.clicks === count && value.popups[count - 1]?.closed && value.popups[count - 1]?.completion;
  }, `${label} native popup completion`);
  const evidence = await frameRead(frame), events = evidence.events.slice(firstEvent);
  report.observations.push({ phase: label, evidence, newEvents: events });
  check(`${label}: exactly one trusted click reached the child button`, () => {
    assert.equal(evidence.clicks, count); assert.equal(events.filter(event => event.type === 'click').length, 1);
    assert.deepEqual(events.filter(event => event.type !== 'pointermove').map(event => event.type), ['pointerdown', 'mousedown', 'mouseup', 'click']);
    assert.ok(events.length >= 4); assert.ok(events.every(event => event.trusted && event.target === 'sign-in'));
    assert.equal(events.find(event => event.type === 'click').active, true);
  });
  check(`${label}: trusted activation opened one popup with an intact opener`, () => {
    const popup = evidence.popups[count - 1]; assert.equal(popup.opened, true); assert.equal(popup.trusted, true);
    assert.equal(popup.completion.openerPresent, true); assert.deepEqual(popup.completion.nodeGlobals, { process: 'undefined', require: 'undefined' });
    assert.equal(report.popups.length, count);
  });
  check(`${label}: OAuth completion closed its native window and removed its tab`, () => {
    assert.equal(evidence.popups[count - 1].closed, true); assert.equal(report.popups[count - 1].closed, true);
    assert.equal(driver.tabs.size, 1); assert.ok(driver.tabs.has(tabId));
  });
  check(`${label}: one native press and release used an attached child target`, () => {
    const inputs = report.inputs.filter(input => input.phase === label);
    assert.deepEqual(inputs.filter(input => input.type !== 'mouseMoved').map(input => input.type), ['mousePressed', 'mouseReleased']);
    assert.ok(inputs.every(input => typeof input.sessionId === 'string' && input.sessionId));
    assert.equal(new Set(inputs.filter(input => input.type !== 'mouseMoved').map(input => input.sessionId)).size, 1);
  });
}

async function cleanup() {
  report.cleanup = { errors: [] };
  for (const [label, close] of [['workspace', () => browser?.close()], ['driver', () => driver?.close()]]) {
    try { await deadline(Promise.resolve().then(close), 12000, `${label} cleanup`); } catch (error) { report.cleanup.errors.push(`${label}: ${error.message}`); }
  }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length;
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy(); server.closeAllConnections();
    await deadline(closed, 3000, 'loopback server cleanup');
  }
  try { await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); report.cleanup.temporaryDirectoryRemoved = true; }
  catch (error) { report.cleanup.temporaryDirectoryRemoved = false; report.cleanup.temporaryDirectoryNote = `${error.code || error.message}; disposable directory: ${root}`; }
  if (report.cleanup.errors.length || report.cleanup.remainingWindows) report.passed = false;
}
async function main() {
  try {
    stage('waiting-for-electron-ready'); await app.whenReady();
    report.fixtureHash = await digest(fixturePath); report.sourceHashes = await hashes();
    const { ElectronBrowserDriver } = await import(pathToFileURL(path.join(source, 'desktop/browser-driver.mjs')).href);
    const { BrowserWorkspace } = await import(pathToFileURL(path.join(source, 'lib/browser.mjs')).href);
    stage('starting-loopback-fixture');
    server = http.createServer((request, response) => {
      let url; try { url = new URL(request.url, `http://${request.headers.host}`); } catch { response.writeHead(400); response.end(); return; }
      if (request.method !== 'GET' || !localURL(url.href) || !['/', '/frame', '/replacement', '/popup'].includes(url.pathname)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${primaryOrigin} ${secondaryOrigin}; base-uri 'none'; form-action 'none'`);
      response.end(page(url));
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    primaryOrigin = `http://127.0.0.1:${server.address().port}`; secondaryOrigin = `http://localhost:${server.address().port}`; report.origins = [primaryOrigin, secondaryOrigin];
    stage('initializing-contained-driver');
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    driver = await new ElectronBrowserDriver({ dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'downloads') }).init();
    browser = new BrowserWorkspace({ driver });
    const originalCDP = driver.cdp.bind(driver);
    driver.cdp = (tab, method, params, signal, expected, sessionId) => {
      if (method.startsWith('Input.')) report.inputs.push({ phase, method, type: params.type, x: params.x, y: params.y, sessionId: sessionId || null });
      return originalCDP(tab, method, params, signal, expected, sessionId);
    };
    const opened = await browser.perform({ action: 'open', url: primaryOrigin + '/' }, { source: 'user' });
    const tabId = opened.tabId, tab = driver.tab(tabId), wc = tab.window.webContents;
    wc.on('did-create-window', (window, details) => {
      const item = { url: details.url, closed: false, hidden: !window.isVisible(), offscreen: window.webContents.isOffscreen() };
      report.popups.push(item); window.once('closed', () => { item.closed = true; });
    });
    await stable(tab);
    const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url === secondaryOrigin + '/frame');
    assert.ok(frame, 'Cross-site fixture frame must exist.');
    report.frame = { url: frame.url, processId: frame.processId, mainProcessId: wc.mainFrame.processId };
    check('The target iframe really runs in a separate renderer', () => { assert.ok(Number.isInteger(frame.processId)); assert.ok(Number.isInteger(wc.mainFrame.processId)); assert.notEqual(frame.processId, wc.mainFrame.processId); });
    report.initialFrame = await frameRead(frame);
    check('Cross-process frame remains sandboxed', () => assert.deepEqual(report.initialFrame.nodeGlobals, { process: 'undefined', require: 'undefined' }));

    stage('reference-hover');
    const hoverRef = await freshReference(tabId);
    await browser.perform({ action: 'hover', browser: 'relay', tabId, ref: hoverRef.ref });
    check('Fresh-reference hover reaches the child as trusted input', () => assert.ok(report.inputs.some(input => input.phase === phase && input.type === 'mouseMoved' && input.sessionId)));
    const afterRefHover = await frameRead(frame);
    check('Fresh-reference hover is observed by the actual child button', () => assert.ok(afterRefHover.events.some(event => event.type === 'pointermove' && event.trusted)));
    stage('reference-click');
    await browser.perform(await freshReference(tabId));
    await verifyPhase(frame, tabId, 1, phase, afterRefHover.events.length);

    stage('reset-pointer-to-main-document');
    await browser.perform({ action: 'hover', browser: 'relay', tabId, x: 45, y: 30 });
    const point = await wc.executeJavaScript("(() => { const r=document.querySelector('#sign-in-frame').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
    stage('coordinate-hover');
    const beforeCoordinate = await frameRead(frame);
    await browser.perform({ action: 'hover', browser: 'relay', tabId, ...point });
    const afterCoordinateHover = await frameRead(frame);
    check('Screenshot-coordinate hover reaches the child as trusted input', () => assert.ok(afterCoordinateHover.events.slice(beforeCoordinate.events.length).some(event => event.type === 'pointermove' && event.trusted)));
    const preview = await browser.perform({ action: 'screenshot', browser: 'relay', tabId }, { source: 'user' });
    report.preview = { documentId: preview.documentId, width: preview.width, height: preview.height, point };
    const guard = { browser: 'relay', tabId, expectedUrl: preview.url, expectedDocumentId: preview.documentId };
    stage('coordinate-click');
    await browser.perform({ action: 'click', ...guard, ...point }, { source: 'user' });
    await verifyPhase(frame, tabId, 2, phase, afterCoordinateHover.events.length);

    stage('stale-child-document-guard');
    await wc.executeJavaScript(`document.querySelector('#sign-in-frame').src=${JSON.stringify(secondaryOrigin + '/replacement')}`);
    await stable(tab);
    const replacement = wc.mainFrame.framesInSubtree.find(frame => frame.url === secondaryOrigin + '/replacement');
    assert.ok(replacement, 'Replacement iframe document must exist.');
    const beforeStale = report.inputs.length;
    await assert.rejects(browser.perform({ action: 'click', ...guard, ...point }, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
    check('A child navigation retires the old screenshot before native pointer input', () => { assert.equal(report.inputs.length, beforeStale); assert.equal(report.popups.length, 2); });
    report.replacementClicks = (await frameRead(replacement)).clicks;
    check('The replacement child received zero clicks', () => assert.equal(report.replacementClicks, 0));

    stage('main-document-pointer-regression');
    const mainPreview = await browser.perform({ action: 'screenshot', browser: 'relay', tabId }, { source: 'user' });
    await browser.perform({ action: 'click', browser: 'relay', tabId, x: 45, y: 30, expectedUrl: mainPreview.url, expectedDocumentId: mainPreview.documentId }, { source: 'user' });
    const rootClicks = await wc.executeJavaScript('globalThis.__rootClicks');
    check('Ordinary main-document native input still works exactly once', () => assert.deepEqual(rootClicks, [{ trusted: true }]));
    check('Main-document input stays on the root protocol target', () => assert.ok(report.inputs.filter(input => input.phase === phase).every(input => input.sessionId === null)));
    check('All fixture windows remained hidden, offscreen and sandboxed', () => {
      assert.ok(report.popups.every(popup => popup.hidden && popup.offscreen));
      for (const window of BrowserWindow.getAllWindows()) {
        assert.equal(window.isVisible(), false); assert.equal(window.webContents.isOffscreen(), true);
        const preferences = window.webContents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true);
      }
    });
    const finalHashes = await hashes(); check('Candidate source stayed unchanged during the run', () => assert.deepEqual(finalHashes, report.sourceHashes));
    report.passed = report.failures.length === 0;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  finally {
    try { stage('closing-disposable-fixture'); await cleanup(); } catch (error) { report.passed = false; report.cleanupError = error.stack || String(error); }
    report.finishedAt = new Date().toISOString(); report.stage = 'complete';
    try { save(); } catch { report.passed = false; }
    finished = true; clearTimeout(watchdog);
    app.exit(report.passed ? 0 : 1);
  }
}
// Electron waits for the ESM entry to finish before ready; no top-level await.
void main();
