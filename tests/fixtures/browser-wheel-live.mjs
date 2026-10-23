/** Real native wheel acceptance, launched only with a new owned profile. */
import { app, BrowserWindow, session } from 'electron';
import { EventEmitter } from 'node:events';
import { createHarnessServer } from '../../server.mjs';
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
let driver, browser, server, frontend, harness, foregrounded = false, finished = false;
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
const watchdog = setTimeout(() => { report.passed = false; report.error = 'Native wheel acceptance exceeded its deadline.'; report.forcedCleanup = true; save(); app.exit(1); }, 75000);


async function frontendAcceptance(contents) {
  stage('checking-real-frontend-wheel-route');
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  class OfflineRuntime extends EventEmitter {
    status() { return { connected: false, authenticated: false, activeTurns: 0, models: [], providers: [] }; }
    async init() {} async start() { return this.status(); } async close() {}
    async runAgent() { report.frontend.modelCalls++; throw Error('No model may run in native wheel acceptance.'); }
  }
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false, busy: false }); desktop.setEnabled = async () => desktop.status();
  const applications = new EventEmitter(); applications.status = () => ({ available: false, sessions: [], documents: [], supportedApps: [], documentStorage: { healthy: true } }); applications.close = async () => {};
  report.frontend = { widths: [], wheelRequests: [], wheelResponses: [], frontendEvents: [], externalRequests: 0, modelCalls: 0, pageErrors: [] };
  harness = await createHarnessServer({ port: 0, dataDir: path.join(root, 'frontend-data'), defaultCwd: workspace, runtime: new OfflineRuntime(), desktop, applicationWorkspace: applications, browser, autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: '' });
  await harness.learning.updateSettings({ mode: 'manual' });
  const base = await harness.listen();
  const frontendSession = session.fromPartition('persist:wheel-frontend-' + nonce);
  frontendSession.webRequest.onBeforeRequest((details, callback) => {
    const parsed = new URL(details.url);
    const allowed = ['data:', 'blob:', 'about:'].includes(parsed.protocol) || parsed.hostname === '127.0.0.1';
    if (!allowed) report.frontend.externalRequests++;
    callback({ cancel: !allowed });
  });
  frontend = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { session: frontendSession, offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, paintWhenInitiallyHidden: true } });
  const wc = frontend.webContents, debug = wc.debugger;
  stage('loading-real-frontend');
  await wc.loadURL(base);
  stage('attaching-real-frontend-input');
  debug.attach('1.3');
  debug.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') report.frontend.pageErrors.push(params.exceptionDetails?.text || 'exception');
    if (method === 'Network.requestWillBeSent' && params.request.method === 'POST') {
      const route = new URL(params.request.url).pathname;
      let value; try { value = JSON.parse(params.request.postData || '{}'); } catch { return; }
      if (value.action === 'scroll') report.frontend.wheelRequests.push({ requestId: params.requestId, route, browser: value.browser, x: value.x, y: value.y, deltaX: value.deltaX, deltaY: value.deltaY, guarded: Boolean(value.expectedUrl && value.expectedDocumentId) });
    }
    if (method === 'Network.responseReceived' && report.frontend.wheelRequests.some(value => value.requestId === params.requestId)) report.frontend.wheelResponses.push({ requestId: params.requestId, status: params.response.status });
  });
  await Promise.all(['Runtime.enable', 'Network.enable'].map(method => debug.sendCommand(method)));
  const evaluate = expression => wc.executeJavaScript(expression);
  const visible = selector => evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');return !!(n&&n.getClientRects().length&&!n.closest("[hidden],[inert]"));})()');
  const waitVisible = selector => until(selector, () => visible(selector), Boolean, 15000);
  async function click(selector) {
    await waitVisible(selector);
    const point = await evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');n.scrollIntoView({block:"center",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(n.disabled||!n.contains(document.elementFromPoint(x,y)))throw Error("Control is not reachable");return{x,y};})()');
    for (const type of ['mousePressed', 'mouseReleased']) await debug.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
  stage('opening-real-frontend-browser-surface');
  await click('#workspace-modes [data-mode="observe"]');
  await click('[data-observe-surface="browser"]');
  await until('decoded actual browser preview', () => evaluate('(()=>{const n=document.querySelector("#observe-browser-image");return !!(n&&n.complete&&n.naturalWidth>1000&&!n.closest("button").disabled);})()'), Boolean, 15000);
  await evaluate('globalThis.__wheelAcceptance=[];document.addEventListener("wheel",event=>{const item={trusted:event.isTrusted,target:event.target.id,deltaX:event.deltaX,deltaY:event.deltaY,prevented:false};__wheelAcceptance.push(item);setTimeout(()=>item.prevented=event.defaultPrevented,0);},true);');
  async function pointAt(x, y) {
    return evaluate('(()=>{const n=document.querySelector("#observe-browser-image");n.scrollIntoView({block:"center",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+' + x + '*r.width/n.naturalWidth,y=r.top+' + y + '*r.height/n.naturalHeight;const hit=document.elementFromPoint(x,y);if(hit!==n||x<0||x>=innerWidth||y<0||y>=innerHeight||n.closest("button").disabled)throw Error("Preview point is not reachable");return{x,y,width:innerWidth,height:innerHeight,imageWidth:r.width,imageHeight:r.height,scrollY,activityScroll:document.querySelector(".observe-scroll")?.scrollTop||0};})()');
  }
  async function wheelAt(point, deltaX, deltaY) {
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, button: 'none' });
  }
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    stage('real-frontend-wheel-' + width);
    frontend.setContentSize(width, height);
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await until('frontend viewport width', () => evaluate('innerWidth'), value => value === width);
    await contents.executeJavaScript('scrollTo(0,0);document.querySelector("#pane").scrollTo(0,0);document.querySelector("#blocked").scrollTo(0,0);fixture.wheels=[];fixture.blocked=0;');
    await wait(150);
    const point = await pointAt(250, 200), requestsBefore = report.frontend.wheelRequests.length;
    await wheelAt(point, 72, 140);
    const moved = await until('real frontend wheel reaches native pane', () => readState(contents), value => value.paneX > 35 && value.paneY > 80);
    const frontendEvent = await until('trusted handled frontend wheel event', () => evaluate('__wheelAcceptance.at(-1)'), value => value?.trusted && value?.prevented);
    check('Actual ' + width + 'px preview routes a trusted pointer wheel through HTTP into the nested pane', () => {
      assert.equal(frontendEvent.target, 'observe-browser-image'); assert.equal(moved.pageY, 0); assert.equal(moved.wheels.length, 1); assert.equal(moved.wheels[0].trusted, true);
      assert.equal(moved.wheels[0].deltaX, 72); assert.equal(moved.wheels[0].deltaY, 140);
      assert.ok(report.frontend.wheelRequests.length > requestsBefore); assert.equal(report.frontend.wheelRequests.at(-1).guarded, true);
    });
    const blockedPoint = await pointAt(700, 200);
    await wheelAt(blockedPoint, 0, 200);
    const blocked = await until('cancelled wheel through actual frontend', () => readState(contents), value => value.blocked === 1);
    await wait(120);
    const unchanged = await readState(contents), localScroll = await evaluate('({scrollY,activityScroll:document.querySelector(".observe-scroll")?.scrollTop||0})');
    check('Actual ' + width + 'px preview respects page wheel cancellation and keeps Activity stationary', () => {
      assert.equal(blocked.blockedY, 0); assert.equal(unchanged.blockedY, 0); assert.equal(unchanged.pageY, 0);
      assert.equal(localScroll.scrollY, blockedPoint.scrollY); assert.equal(localScroll.activityScroll, blockedPoint.activityScroll);
      assert.equal(unchanged.wheels.length, 2); assert.ok(unchanged.wheels.every(value => value.trusted));
    });
    report.frontend.widths.push({ width, height, point, moved, cancelled: unchanged });
  }
  report.frontend.frontendEvents = await evaluate('__wheelAcceptance');
  check('The real frontend wheel route completes without page errors, model calls or external traffic', () => {
    assert.equal(report.frontend.wheelRequests.length, 4); assert.equal(report.frontend.wheelResponses.length, 4);
    assert.ok(report.frontend.wheelResponses.every(value => value.status === 200));
    assert.equal(report.frontend.pageErrors.length, 0); assert.equal(report.frontend.modelCalls, 0); assert.equal(report.frontend.externalRequests, 0);
  });
  frontend.destroy(); frontend = null;
}

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
    await frontendAcceptance(contents);

    stage('rejecting-stale-input-and-closing-fixture');
    const stale = guard(page); page = await action({ action: 'navigate', tabId: page.tabId, url: origin + '/next' });
    await assert.rejects(action({ action: 'scroll', ...stale, x: 250, y: 200, deltaX: 0, deltaY: 120 }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
    check('A wheel from the old document never reaches a replacement page', () => assert.notEqual(page.documentId, stale.expectedDocumentId));
    assert.equal((await readState(contents)).wheels.length, 0);
    await action({ action: 'close', tabId: page.tabId });
    check('The disposable page closes and no browser window takes desktop focus', () => { assert.equal(browser.status().tabs.length, 0); assert.equal(foregrounded, false); assert.equal(BrowserWindow.getAllWindows().length, 0); });
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  finally {
    stage('closing-owned-wheel-fixture');
    frontend?.destroy(); frontend = null;
    try { if (harness) { await harness.close(); harness = null; } await (browser ? browser.close() : driver?.close()); } catch (error) { report.cleanup.errors.push(error.message); }
    if (server?.listening) {
      const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections?.(); server.closeAllConnections();
      for (const socket of sockets) socket.destroy(); await closed;
    }
    try { await until('owned fixture sockets to close', () => sockets.size, value => value === 0, 3000); }
    catch (error) { report.cleanup.errors.push(error.message); }
    report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length; report.cleanup.remainingSockets = sockets.size;
    report.cleanup.complete = !report.cleanup.errors.length && report.cleanup.remainingWindows === 0 && report.cleanup.remainingSockets === 0;
    if (!report.cleanup.complete) report.passed = false;
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    finished = true; clearTimeout(watchdog); save(); if (report.passed) app.quit(); else app.exit(1);
  }
}
void main().catch(error => { if (finished) return; report.passed = false; report.error = error.stack || String(error); report.forcedCleanup = true; clearTimeout(watchdog); save(); app.exit(1); });
