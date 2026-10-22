/** Native acceptance for the contained browser. Launched only by its owned runner. */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BrowserWorkspace, createBrowserToolHandler } from '../../lib/browser.mjs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option('fixture-root'), nonce = option('fixture-nonce'), resultFile = option('fixture-result');
if (!root || !path.isAbsolute(root) || !/^blackice-browser-rebuild-/.test(path.basename(root)) || !resultFile || !path.isAbsolute(resultFile)) throw Error('Use the browser rebuild runner and its new disposable profile.');
const marker = JSON.parse(readFileSync(path.join(root, 'fixture-marker.json'), 'utf8'));
if (marker.suite !== 'native-browser-rebuild' || marker.nonce !== nonce) throw Error('The disposable fixture marker does not match.');
const profile = path.join(root, 'profile'), dataDir = path.join(root, 'data'), downloadDir = path.join(root, 'downloads');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('BLACKICE isolated browser rebuild acceptance');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 0.0.0.0, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const report = { format: 1, suite: 'native-browser-rebuild', fixtureNonce: nonce, platform: process.platform, electron: process.versions.electron, node: process.versions.node, pid: process.pid,
  startedAt: new Date().toISOString(), actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, chain: ['createBrowserToolHandler', 'BrowserWorkspace', 'BrowserRouter', 'ElectronBrowserDriver'], checks: [], stages: [], actions: [], requests: [], cleanup: { complete: false, errors: [] } };
let driver, browser, handler, mainServer, identityServer, origin, identityOrigin, foregrounded = false, finished = false;
const sockets = new Set(), effects = { saves: 0, downloads: 0, uploads: [] };
const owner = { taskId: 'browser-rebuild-fixture', runId: 'native-acceptance', nodeId: 'direct', allowUserTabs: true };
const save = () => writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
const stage = name => { report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); save(); };
const check = (name, fn) => { fn(); report.checks.push(name); save(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(work, ms, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(label, read, matches = Boolean, ms = 6000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (matches(value)) return value; await wait(30); } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}
const text = snapshot => (snapshot.frames || []).map(frame => frame.text).join('\n');
const ref = (snapshot, name) => {
  const item = (snapshot.frames || []).flatMap(frame => frame.elements || []).find(element => element.name === name);
  assert.ok(item, `The real page must expose ${name}`); return item.ref;
};
const guard = snapshot => ({ expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId });
async function tool(args, { expectedCode } = {}) {
  const started = Date.now(), result = await handler({ name: 'relay_browser', arguments: { browser: 'relay', ...args } });
  const metadata = JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
  report.actions.push({ action: args.action, ...(args.tabId ? { tabId: args.tabId } : {}), success: result.success, code: result.code || null, milliseconds: Date.now() - started });
  if (expectedCode) { assert.equal(result.success, false); assert.equal(result.code, expectedCode); return metadata; }
  assert.equal(result.success, true, `${args.action}: ${metadata.code || result.code || ''} ${metadata.error || ''}`);
  return { ...metadata, ...(result.contentItems.some(item => item.type === 'inputImage') ? { imagePresent: true } : {}) };
}
async function startWorkspace() {
  driver = await new ElectronBrowserDriver({ dataDir, downloadDir }).init();
  browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }), timeoutMs: 15000 });
  handler = createBrowserToolHandler({ browser, owner, validateUploadPath: async file => {
    const relative = path.relative(path.join(root, 'uploads'), path.resolve(file));
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !(await fs.stat(file)).isFile()) throw Error('The fixture uploads only its own ordinary files.');
  } });
}
async function listen(server) {
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
function page() {
  return `<!doctype html><meta charset="utf-8"><title>BLACKICE owned browser rebuild fixture</title>
    <style>body{font:16px sans-serif;padding:18px}button,input,select{font:inherit;margin:4px;padding:6px}#hover{width:280px;height:45px;border:1px solid;padding:8px;margin-top:12px}</style>
    <h1>Browser rebuild fixture</h1><p id="preference"></p>
    <label>Name<input id="name" aria-label="Fixture name"></label><button id="save">Save fixture</button><p id="saved"></p>
    <label>Typed<input id="typed" aria-label="Typed field"></label><select aria-label="Fixture choice"><option value="one">One</option><option value="two">Two</option></select>
    <div id="hover">Coordinate hover target</div><button id="confirm">Confirm fixture action</button><p id="confirmed"></p>
    <label>Upload<input id="upload" type="file" aria-label="Upload fixture"></label><input id="hidden-upload" type="file" hidden><button id="choose">Choose hidden upload</button><p id="uploaded"></p>
    <a id="download" href="/download" download>Download fixture</a><button id="popup">Open fixture popup</button><button id="remember">Remember fixture preference</button>
    <script>
      globalThis.fixtureState={saves:0,saveTrusted:false,hoverTrusted:false,dialogCalls:0,confirmResult:null,uploadEvents:0,popupMessages:[]};
      document.querySelector('#preference').textContent=localStorage.getItem('blackice_rebuild_preference')==='compact'?'PREFERENCE_RESTORED':'PREFERENCE_EMPTY';
      document.querySelector('#save').onclick=async event=>{fixtureState.saves++;fixtureState.saveTrusted=event.isTrusted;await fetch('/effect',{method:'POST',body:document.querySelector('#name').value});document.querySelector('#saved').textContent='SAVED:'+document.querySelector('#name').value;};
      document.querySelector('#hover').onmouseenter=event=>{fixtureState.hoverTrusted=event.isTrusted;};
      document.querySelector('#confirm').onclick=()=>{fixtureState.dialogCalls++;fixtureState.confirmResult=confirm('Approve the disposable fixture action?');document.querySelector('#confirmed').textContent=fixtureState.confirmResult?'CONFIRM_ACCEPTED':'CONFIRM_DISMISSED';};
      for(const [id,kind] of [['upload','visible'],['hidden-upload','chooser']])document.getElementById(id).onchange=async event=>{fixtureState.uploadEvents++;const bytes=await event.target.files[0].arrayBuffer();await fetch('/uploaded?kind='+kind,{method:'POST',body:bytes});document.querySelector('#uploaded').textContent='UPLOADED:'+kind;};
      document.querySelector('#choose').onclick=()=>document.querySelector('#hidden-upload').click();
      document.querySelector('#popup').onclick=()=>{globalThis.fixturePopup=window.open(${JSON.stringify(identityOrigin + '/popup')},'_blank');};
      addEventListener('message',event=>{if(event.data?.nonce===${JSON.stringify(nonce)}&&event.source===globalThis.fixturePopup)fixtureState.popupMessages.push({origin:event.origin,phase:event.data.phase});});
      document.querySelector('#remember').onclick=()=>{localStorage.setItem('blackice_rebuild_preference','compact');document.querySelector('#preference').textContent='PREFERENCE_SAVED';};
    </script>`;
}
function serverFor(identity) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    report.requests.push({ site: identity ? 'identity' : 'main', path: url.pathname, method: request.method });
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (identity && url.pathname === '/popup') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<h1>Identity fixture popup</h1><button onclick="location.href='/return'">Complete popup</button><script>window.opener?.postMessage({nonce:${JSON.stringify(nonce)},phase:'identity'},${JSON.stringify(origin)});</script>`); return;
    }
    if (identity && url.pathname === '/return') { response.writeHead(302, { Location: origin + '/popup-complete' }); response.end(); return; }
    if (identity) { response.writeHead(404); response.end(); return; }
    if (url.pathname === '/effect' && request.method === 'POST') { for await (const _ of request) {} effects.saves++; response.writeHead(204); response.end(); return; }
    if (url.pathname === '/uploaded' && request.method === 'POST') {
      const parts = []; for await (const part of request) parts.push(part);
      effects.uploads.push({ kind: url.searchParams.get('kind'), text: Buffer.concat(parts).toString('utf8') }); response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/download') { effects.downloads++; response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="browser-rebuild-fixture.txt"' }); response.end('BLACKICE_REBUILD_DOWNLOAD_' + nonce); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/popup-complete') { response.end(`<h1>Popup completed</h1><script>window.opener?.postMessage({nonce:${JSON.stringify(nonce)},phase:'complete'},${JSON.stringify(origin)});</script>`); return; }
    response.end(page());
  });
}
async function cleanup() {
  try { await deadline(browser ? browser.close() : driver?.close(), 10000, 'browser cleanup'); browser = null; driver = null; }
  catch (error) { report.cleanup.errors.push(error.message); }
  for (const server of [mainServer, identityServer]) if (server?.listening) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.(); server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    try { await deadline(closed, 3000, 'loopback server cleanup'); } catch (error) { report.cleanup.errors.push(error.message); }
  }
  report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length;
  report.cleanup.remainingSockets = sockets.size;
  report.cleanup.complete = report.cleanup.errors.length === 0 && report.cleanup.remainingWindows === 0;
}
const watchdog = setTimeout(() => {
  report.passed = false; report.error = 'The owned native fixture exceeded its 85-second deadline.'; report.forcedCleanup = true; save(); app.exit(1);
}, 85000);

async function main() {
  try {
    stage('starting-isolated-browser');
    await app.whenReady();
    app.on('browser-window-created', (_event, window) => { window.on('show', () => { foregrounded = true; }); window.on('focus', () => { foregrounded = true; }); });
    await fs.mkdir(dataDir, { recursive: true }); await fs.mkdir(downloadDir, { recursive: true }); await fs.mkdir(path.join(root, 'uploads'), { recursive: true });
    mainServer = serverFor(false); identityServer = serverFor(true);
    origin = await listen(mainServer); identityOrigin = await listen(identityServer);
    report.origins = [origin, identityOrigin];
    await startWorkspace();
    const folder = (await browser.perform({ action: 'folder_create', browser: 'relay', name: 'Owned acceptance folder' }, { source: 'user' })).folder;
    const parent = await browser.perform({ action: 'open', browser: 'relay', folderId: folder.id, url: origin + '/parent' }, { source: 'user' });
    let snapshot = await tool({ action: 'open', folderId: folder.id, parentTabId: parent.tabId, url: origin + '/work' });
    const tabId = snapshot.tabId;
    check('The tool opens a personal-folder child with the requested parent and no invented task owner', () => {
      const tab = browser.status().tabs.find(value => value.tabId === tabId);
      assert.equal(tab.folderId, folder.id); assert.equal(tab.parentTabId, parent.tabId);
      // Public personal-tab records omit owner; the native tab stores null.
      assert.equal(Object.hasOwn(tab, 'owner'), false); assert.equal(driver.tab(tabId).owner, null);
      assert.match(text(snapshot), /Browser rebuild fixture/);
    });

    stage('checking-guarded-read-hover-and-input');
    snapshot = await tool({ action: 'read', tabId, ...guard(snapshot) });
    check('A document-guarded read reaches the actual page through the complete tool chain', () => assert.match(text(snapshot), /Browser rebuild fixture/));
    const contents = driver.tab(tabId).window.webContents;
    const hoverPoint = await contents.executeJavaScript("(()=>{const r=document.querySelector('#hover').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    snapshot = await tool({ action: 'hover', tabId, ...guard(snapshot), ...hoverPoint });
    const hoverTrusted = await contents.executeJavaScript('fixtureState.hoverTrusted');
    check('Coordinate hover delivers a native trusted pointer event', () => { assert.equal(snapshot.receipt.hovered, true); assert.equal(hoverTrusted, true); });
    snapshot = await tool({ action: 'fill', tabId, ref: ref(snapshot, 'Fixture name'), text: 'ORBIT' });
    snapshot = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Save fixture') });
    await until('one saved server effect', () => effects.saves === 1);
    const saved = await contents.executeJavaScript('({saves:fixtureState.saves,trusted:fixtureState.saveTrusted,value:document.querySelector("#name").value})');
    check('Trusted form input reaches the local server exactly once', () => assert.deepEqual(saved, { saves: 1, trusted: true, value: 'ORBIT' }));
    snapshot = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Typed field') });
    await tool({ action: 'type', tabId, ...guard(snapshot), text: 'Café ✓ — browser' });
    const typed = await contents.executeJavaScript('document.querySelector("#typed").value');
    check('Guarded Unicode typing reaches the focused field', () => assert.equal(typed, 'Café ✓ — browser'));
    snapshot = await tool({ action: 'snapshot', tabId });
    snapshot = await tool({ action: 'select', tabId, ref: ref(snapshot, 'Fixture choice'), value: 'two' });
    check('Native selection changes the real form value', () => assert.equal(snapshot.frames.flatMap(frame => frame.elements).find(value => value.name === 'Fixture choice').value, 'two'));

    stage('resolving-observed-dialog-without-replay');
    const dialog = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Confirm fixture action') });
    const interaction = dialog.pendingInteraction;
    check('An observed JavaScript dialog releases the browser queue for a supported decision', () => { assert.equal(interaction?.kind, 'javascript_dialog'); assert.equal(interaction.status, 'pending'); assert.equal(browser.status().busy, false); });
    const decided = await tool({ action: 'interaction', tabId, interactionId: interaction.id, expectedUrl: interaction.url, expectedDocumentId: interaction.documentId, decision: 'accept' });
    await until('dialog command settlement', () => !driver.tab(tabId).suspendedWork.size);
    snapshot = await tool({ action: 'wait', tabId, text: 'CONFIRM_ACCEPTED', timeoutMs: 5000 });
    const dialogEffects = await contents.executeJavaScript('({calls:fixtureState.dialogCalls,value:fixtureState.confirmResult})');
    check('The exact dialog is decided without replaying its original click', () => { assert.equal(decided.receipt.replayed, false); assert.deepEqual(dialogEffects, { calls: 1, value: true }); });

    stage('uploading-owned-files-and-downloading');
    const visibleFile = path.join(root, 'uploads', 'visible-fixture.txt'), chooserFile = path.join(root, 'uploads', 'chooser-fixture.txt');
    const visibleBytes = 'Visible upload café ' + nonce, chooserBytes = 'Chooser upload ✓ ' + nonce;
    await fs.writeFile(visibleFile, visibleBytes); await fs.writeFile(chooserFile, chooserBytes);
    snapshot = await tool({ action: 'upload', tabId, ...guard(snapshot), ref: ref(snapshot, 'Upload fixture'), paths: [visibleFile] });
    await until('visible upload bytes', () => effects.uploads.find(value => value.kind === 'visible'));
    check('Observed file-ref upload delivers the exact selected bytes', () => { assert.equal(snapshot.receipt.deliveryVerified, true); assert.deepEqual(effects.uploads.filter(value => value.kind === 'visible'), [{ kind: 'visible', text: visibleBytes }]); });
    const choosing = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Choose hidden upload') });
    const chooser = choosing.pendingInteraction || driver.status().tabs.find(value => value.tabId === tabId)?.pendingInteraction;
    assert.equal(chooser?.kind, 'file_chooser'); assert.equal(chooser.status, 'pending');
    snapshot = await tool({ action: 'upload', tabId, chooserId: chooser.id, expectedUrl: chooser.url, expectedDocumentId: chooser.documentId, paths: [chooserFile] });
    await until('chooser upload bytes', () => effects.uploads.find(value => value.kind === 'chooser'));
    check('The intercepted file chooser delivers its exact file without a native picker', () => { assert.equal(snapshot.receipt.deliveryVerified, true); assert.deepEqual(effects.uploads.filter(value => value.kind === 'chooser'), [{ kind: 'chooser', text: chooserBytes }]); });
    snapshot = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Download fixture') });
    const downloaded = await until('completed file download', () => tool({ action: 'downloads' }), value => value.downloads.some(item => item.tabId === tabId && item.status === 'completed'));
    const download = downloaded.downloads.find(item => item.tabId === tabId && item.status === 'completed');
    assert.equal(path.dirname(download.path), downloadDir);
    const downloadedText = await fs.readFile(download.path, 'utf8');
    check('The actual attachment is downloaded once with unchanged bytes', () => { assert.equal(effects.downloads, 1); assert.equal(downloadedText, 'BLACKICE_REBUILD_DOWNLOAD_' + nonce); });

    stage('opening-redirecting-and-closing-native-popup');
    snapshot = await tool({ action: 'snapshot', tabId });
    await tool({ action: 'click', tabId, ref: ref(snapshot, 'Open fixture popup') });
    const popup = await until('adopted popup', () => browser.status().tabs.find(value => value.parentTabId === tabId));
    let popupSnapshot = await tool({ action: 'wait', tabId: popup.tabId, text: 'Identity fixture popup', timeoutMs: 5000 });
    assert.equal(new URL(popupSnapshot.url).origin, identityOrigin);
    const opener = await driver.tab(popup.tabId).window.webContents.executeJavaScript('(()=>{let isolated=false;try{void window.opener.document}catch{isolated=true}return{present:!!window.opener,isolated}})()');
    check('A native popup keeps its opener and ordinary cross-origin isolation', () => assert.deepEqual(opener, { present: true, isolated: true }));
    popupSnapshot = await tool({ action: 'click', tabId: popup.tabId, ref: ref(popupSnapshot, 'Complete popup') });
    popupSnapshot = await tool({ action: 'wait', tabId: popup.tabId, text: 'Popup completed', timeoutMs: 5000 });
    await until('popup completion message', () => contents.executeJavaScript('fixtureState.popupMessages'), values => values.some(value => value.phase === 'complete'));
    const messages = await contents.executeJavaScript('fixtureState.popupMessages');
    check('The popup redirects and messages its original opener exactly once per phase', () => { assert.equal(new URL(popupSnapshot.url).origin, origin); assert.deepEqual(messages, [{ origin: identityOrigin, phase: 'identity' }, { origin, phase: 'complete' }]); });
    await tool({ action: 'close', tabId: popup.tabId, ...guard(popupSnapshot) });
    check('A guarded tool close removes its own popup and preserves its parent', () => { assert.equal(browser.status().tabs.some(value => value.tabId === popup.tabId), false); assert.equal(browser.status().tabs.some(value => value.tabId === tabId), true); });

    stage('suspending-reviving-and-checking-document-identity');
    snapshot = await tool({ action: 'snapshot', tabId });
    snapshot = await tool({ action: 'click', tabId, ref: ref(snapshot, 'Remember fixture preference') });
    const oldGuard = guard(snapshot), oldContents = contents;
    const suspended = await tool({ action: 'suspend', tabId });
    check('Explicit suspension releases the real page while retaining its tab identity', () => { assert.equal(suspended.receipt.suspended, true); assert.equal(oldContents.isDestroyed(), true); assert.equal(driver.tab(tabId).window, null); });
    snapshot = await tool({ action: 'read', tabId });
    check('An explicit read revives the same saved tab and its local state', () => { assert.equal(snapshot.tabId, tabId); assert.notEqual(driver.tab(tabId).window.webContents, oldContents); assert.match(text(snapshot), /PREFERENCE_RESTORED/); assert.notEqual(snapshot.documentId, oldGuard.expectedDocumentId); });
    await tool({ action: 'read', tabId, ...oldGuard }, { expectedCode: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
    await tool({ action: 'close', tabId, ...oldGuard }, { expectedCode: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
    check('Stale read and close guards preserve the replacement document and tab', () => assert.equal(browser.status().tabs.some(value => value.tabId === tabId), true));
    snapshot = await tool({ action: 'read', tabId, ...guard(snapshot) });
    const image = await tool({ action: 'screenshot', tabId });
    check('The revived tab returns real pixels through the tool result', () => { assert.equal(image.imagePresent, true); assert.ok(image.width > 0 && image.height > 0); });

    stage('confirming-durable-close-and-download-provenance');
    await tool({ action: 'close', tabId, ...guard(snapshot) });
    const savedAfterClose = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-tabs.json'), 'utf8'));
    check('Successful tool close has already persisted removal before returning', () => { assert.equal(savedAfterClose.tabs.some(value => value.tabId === tabId), false); assert.ok(savedAfterClose.tabs.some(value => value.tabId === parent.tabId)); });
    const retained = await tool({ action: 'downloads' });
    check('A completed owned download stays retrievable after its source tab closes', () => assert.ok(retained.downloads.some(value => value.id === download.id && value.status === 'completed')));

    stage('recreating-the-driver-and-verifying-instance-lifetime');
    const firstDriver = driver, firstDownloadCount = firstDriver.downloads.length, sharedSession = firstDriver.session;
    await browser.close(); browser = null; driver = null;
    const noDriverDownloads = sharedSession.listenerCount('will-download'), noDriverCookies = sharedSession.cookies.listenerCount('changed');
    const requestsBeforeRestore = report.requests.length;
    await startWorkspace();
    await wait(150);
    const restored = await tool({ action: 'tabs' });
    check('A fresh driver restores retained metadata without reopening closed pages or fetching saved pages', () => {
      assert.deepEqual(restored.tabs.map(value => value.tabId), [parent.tabId]); assert.equal(restored.tabs[0].suspended, true); assert.equal(report.requests.length, requestsBeforeRestore);
      assert.equal(restored.tabs[0].folderId, folder.id); assert.ok(restored.folders.some(value => value.id === folder.id));
    });
    check('The replacement driver installs exactly one fresh set of session listeners', () => { assert.equal(driver.session, sharedSession); assert.equal(sharedSession.listenerCount('will-download'), noDriverDownloads + 1); assert.equal(sharedSession.cookies.listenerCount('changed'), noDriverCookies + 1); });
    snapshot = await tool({ action: 'read', tabId: parent.tabId });
    assert.match(text(snapshot), /PREFERENCE_RESTORED/);
    snapshot = await tool({ action: 'click', tabId: parent.tabId, ref: ref(snapshot, 'Download fixture') });
    const replacementDownloads = await until('replacement-driver download', () => tool({ action: 'downloads' }), value => value.downloads.some(item => item.status === 'completed'));
    check('Only the replacement driver handles new downloads after the first instance closes', () => { assert.equal(replacementDownloads.downloads.length, 1); assert.equal(firstDriver.downloads.length, firstDownloadCount); assert.equal(effects.downloads, 2); });
    await tool({ action: 'close', tabId: parent.tabId, ...guard(snapshot) });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'browser-tabs.json'), 'utf8')).tabs, []);
    check('The final owned tab closes durably and leaves no retained fixture pages', () => assert.equal(browser.status().tabs.length, 0));
    check('All native windows remain hidden and no consequential action is replayed', () => { assert.equal(foregrounded, false); assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused())); assert.equal(effects.saves, 1); assert.equal(effects.uploads.length, 2); });
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.stack || String(error);
    try { report.failureState = { tabs: driver?.status().tabs, lifecycle: browser?.status().lifecycle }; } catch {}
  } finally {
    stage('closing-owned-native-fixture');
    await cleanup();
    if (!report.cleanup.complete) report.passed = false;
    report.effects = { saves: effects.saves, downloads: effects.downloads, uploadKinds: effects.uploads.map(value => value.kind) };
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    finished = true; clearTimeout(watchdog); save();
    if (report.passed) app.quit(); else app.exit(1);
  }
}
void main().catch(error => { if (finished) return; report.passed = false; report.error = error.stack || String(error); report.forcedCleanup = true; clearTimeout(watchdog); save(); app.exit(1); });
