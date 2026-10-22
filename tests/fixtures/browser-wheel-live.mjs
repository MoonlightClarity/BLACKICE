/** Real native wheel acceptance, launched only with a new owned profile. */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BrowserWorkspace } from '../../lib/browser.mjs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option('fixture-root'), nonce = option('fixture-nonce'), resultFile = option('fixture-result');
if (!root || !path.isAbsolute(root) || !/^blackice-browser-rebuild-/.test(path.basename(root)) || !resultFile || !path.isAbsolute(resultFile)) throw Error('Use verify-browser-rebuild.mjs --wheel-only and its new disposable profile.');
const marker = JSON.parse(readFileSync(path.join(root, 'fixture-marker.json'), 'utf8'));
if (marker.suite !== 'native-browser-wheel' || marker.nonce !== nonce) throw Error('The disposable fixture marker does not match.');
const profile = path.join(root, 'profile'), dataDir = path.join(root, 'data');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('BLACKICE isolated browser wheel acceptance');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 0.0.0.0, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const report = { format: 1, suite: 'native-browser-wheel', fixtureNonce: nonce, platform: process.platform, electron: process.versions.electron, node: process.versions.node, pid: process.pid,
  startedAt: new Date().toISOString(), actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, chain: ['BrowserWorkspace', 'BrowserRouter', 'ElectronBrowserDriver'], checks: [], stages: [], actions: [], requests: [], cleanup: { complete: false, errors: [] } };
let driver, browser, server, foregrounded = false, finished = false;
const sockets = new Set(), save = () => writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
const stage = name => { report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); save(); };
const check = (name, fn) => { fn(); report.checks.push(name); save(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read, matches, ms = 5000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (matches(value)) return value; await wait(30); } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}
async function action(args) {
  const start = Date.now(), result = await browser.perform({ browser: 'relay', ...args }, { source: 'user' });
  report.actions.push({ action: args.action, milliseconds: Date.now() - start }); return result;
}
const guard = page => ({ tabId: page.tabId, expectedUrl: page.url, expectedDocumentId: page.documentId });
const documentHTML = `<!doctype html><meta charset="utf-8"><title>Owned wheel fixture</title>
  <style>body{margin:0;height:4000px;background:linear-gradient(#fff,#cbd5e1);font:18px sans-serif}h1{margin:20px} .pane{position:fixed;top:100px;left:100px;width:360px;height:240px;overflow:auto;overscroll-behavior:contain;border:2px solid #2563eb;background:#fff} .content{width:1200px;height:1800px;background:repeating-linear-gradient(0deg,#e0f2fe 0 60px,#fff 60px 120px)}#blocked{left:600px;width:240px}label{position:fixed;top:30px;left:600px}</style>
  <h1>Native wheel fixture</h1><div id="pane" class="pane"><div class="content">Nested scroll pane</div></div><div id="blocked" class="pane"><div class="content">Page handles this wheel itself</div></div>
  <script>globalThis.fixture={wheels:[],blocked:0};document.addEventListener('wheel',event=>{fixture.wheels.push({trusted:event.isTrusted,deltaX:event.deltaX,deltaY:event.deltaY,x:event.clientX,y:event.clientY});},{passive:true});document.querySelector('#blocked').addEventListener('wheel',event=>{event.preventDefault();fixture.blocked++;},{passive:false});</script>`;
const readState = contents => contents.executeJavaScript("({pageY:scrollY,paneX:document.querySelector('#pane').scrollLeft,paneY:document.querySelector('#pane').scrollTop,blockedY:document.querySelector('#blocked').scrollTop,wheels:fixture.wheels,blocked:fixture.blocked})");
const watchdog = setTimeout(() => { report.passed = false; report.error = 'Native wheel acceptance exceeded its deadline.'; report.forcedCleanup = true; save(); app.exit(1); }, 45000);

async function main() {
  try {
    stage('starting-isolated-wheel-browser'); await app.whenReady();
    app.on('browser-window-created', (_event, window) => { window.on('show', () => { foregrounded = true; }); window.on('focus', () => { foregrounded = true; }); });
    await fs.mkdir(dataDir, { recursive: true });
    server = http.createServer((request, response) => {
      report.requests.push({ path: request.url, method: request.method });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(documentHTML);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`; report.origin = origin;
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(root, 'downloads') }).init();
    browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }), timeoutMs: 10000 });
    let page = await action({ action: 'open', url: origin + '/' });
    const contents = driver.tab(page.tabId).window.webContents;
    const initialFrame = await action({ action: 'screenshot', tabId: page.tabId });
    check('A real hidden browser renders the owned fixture', () => { assert.match(initialFrame.imageUrl, /^data:image\/png;base64,/); assert.ok(Number.isFinite(initialFrame.width) && initialFrame.width > 1000); assert.ok(Number.isFinite(initialFrame.height) && initialFrame.height > 400); });

    stage('scrolling-nested-pane-in-both-axes');
    const moved = await action({ action: 'scroll', ...guard(page), x: 250, y: 200, deltaX: 120.5, deltaY: 180.5 });
    const nested = await until('nested pane to move', () => readState(contents), value => value.paneX > 50 && value.paneY > 100);
    check('Native wheel scrolls the nested pane in both axes without moving the outer page', () => {
      assert.equal(nested.pageY, 0); assert.equal(nested.wheels.length, 1); assert.equal(nested.wheels[0].trusted, true);
      assert.equal(nested.wheels[0].deltaX, 120.5); assert.equal(nested.wheels[0].deltaY, 180.5);
      assert.equal(moved.documentId, page.documentId); assert.equal(moved.frames, undefined); assert.equal(moved.receipt.scrolled, true);
    });
    await action({ action: 'scroll', ...guard(page), x: 250, y: 200, deltaX: -40, deltaY: -60 });
    const reversed = await until('nested pane reverse movement', () => readState(contents), value => value.paneX < nested.paneX && value.paneY < nested.paneY);
    check('Negative deltas reverse both nested scroll directions', () => { assert.equal(reversed.pageY, 0); assert.equal(reversed.wheels.length, 2); });

    stage('scrolling-document-and-respecting-page-wheel-handlers');
    await action({ action: 'scroll', ...guard(page), x: 1000, y: 400, deltaX: 0, deltaY: 320 });
    const down = await until('outer document to move down', () => readState(contents), value => value.pageY > 200);
    check('Wheel outside the pane scrolls the long document', () => { assert.equal(down.paneX, reversed.paneX); assert.equal(down.paneY, reversed.paneY); });
    await action({ action: 'scroll', ...guard(page), x: 1000, y: 400, deltaX: 0, deltaY: -160 });
    const up = await until('outer document to move up', () => readState(contents), value => value.pageY < down.pageY);
    check('Upward wheel gestures move the document in the expected direction', () => assert.ok(up.pageY < down.pageY));
    await action({ action: 'scroll', ...guard(page), x: 700, y: 200, deltaX: 0, deltaY: 200 });
    const handled = await until('page wheel handler', () => readState(contents), value => value.blocked === 1);
    await wait(100);
    const stable = await readState(contents);
    check('A page can handle and cancel its own trusted wheel event', () => { assert.equal(handled.blockedY, 0); assert.equal(stable.blockedY, 0); assert.equal(stable.pageY, up.pageY); assert.equal(stable.wheels.length, 5); assert.ok(stable.wheels.every(event => event.trusted)); });
    report.observed = { nested, reversed, down, up, handled: stable };

    stage('rejecting-stale-input-and-closing-fixture');
    const stale = guard(page); page = await action({ action: 'navigate', tabId: page.tabId, url: origin + '/next' });
    await assert.rejects(action({ action: 'scroll', ...stale, x: 250, y: 200, deltaX: 0, deltaY: 120 }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
    check('A wheel from the old document never reaches a replacement page', () => assert.notEqual(page.documentId, stale.expectedDocumentId));
    assert.equal((await readState(contents)).wheels.length, 0);
    await action({ action: 'close', ...guard(page) });
    check('The disposable page closes and no browser window takes desktop focus', () => { assert.equal(browser.status().tabs.length, 0); assert.equal(foregrounded, false); assert.equal(BrowserWindow.getAllWindows().length, 0); });
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  finally {
    stage('closing-owned-wheel-fixture');
    try { await (browser ? browser.close() : driver?.close()); } catch (error) { report.cleanup.errors.push(error.message); }
    if (server?.listening) {
      const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections?.(); server.closeAllConnections();
      for (const socket of sockets) socket.destroy(); await closed;
    }
    report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length; report.cleanup.remainingSockets = sockets.size;
    report.cleanup.complete = !report.cleanup.errors.length && report.cleanup.remainingWindows === 0;
    if (!report.cleanup.complete) report.passed = false;
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    finished = true; clearTimeout(watchdog); save(); if (report.passed) app.quit(); else app.exit(1);
  }
}
void main().catch(error => { if (finished) return; report.passed = false; report.error = error.stack || String(error); report.forcedCleanup = true; clearTimeout(watchdog); save(); app.exit(1); });
