/** Native acceptance only. Requests are confined to this process's owned loopback server. */
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { promises as fs, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { BrowserWorkspace } from '../../lib/browser.mjs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { BROWSER_PROTECTION_QA_CHECKS } from '../../scripts/browser-protection-qa.mjs';

const args = process.argv.slice(2), values = {};
for (let index = 0; index < args.length; index += 2) { assert.ok(['--profile-dir', '--out', '--receipt', '--nonce'].includes(args[index]) && args[index + 1]); assert.equal(values[args[index]], undefined); values[args[index]] = args[index + 1]; }
const profile = values['--profile-dir'], out = values['--out'], receipt = values['--receipt'], nonce = values['--nonce'];
assert.equal(process.platform, 'win32'); assert.ok(path.isAbsolute(profile) && path.isAbsolute(out) && path.isAbsolute(receipt)); assert.match(nonce, /^[a-f0-9-]{36}$/); assert.equal(profile, path.join(out, 'owned-profile-' + nonce)); assert.equal(receipt, path.join(out, 'native-browser-result-' + nonce + '.json'));
app.setPath('userData', profile); assert.equal(app.requestSingleInstanceLock(), true);
// The reserved tracker host avoids unrelated public-domain HSTS requirements.
// Its /matomo.js path matches the unmodified bundled EasyPrivacy network rules.
const resolverRules = 'MAP pagead2.googlesyndication.com 127.0.0.1, MAP qa-tracker.blackice.test 127.0.0.1, MAP qa-second.blackice.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
app.commandLine.appendSwitch('host-resolver-rules', resolverRules); app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { schema: 1, nonce, pid: process.pid, profile, platform: process.platform, electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome, checks: [], evidence: [], errors: [], providerTurnsRequested: 0, cleanup: false, forcedCleanup: false, networkPolicy: { loopbackOnly: true, resolverRules, directProxy: false } };
const counts = { pages: 0, legitimate: 0, ads: 0, trackers: 0, unexpected: 0 }, clients = new Set(); let server, driver, workspace, origin, secondOrigin;
const progressFile = path.join(out, 'native-browser-progress-' + nonce + '.json');
function checkpoint(stage) {
  report.stage = stage; report.updatedAt = new Date().toISOString();
  if (driver?.diagnostics) report.diagnostics = driver.diagnostics.snapshot();
  writeFileSync(progressFile, JSON.stringify({ ...report, counts: { ...counts } }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ stage, checks: report.checks.length, counts: { ...counts } }) + '\n');
}
const check = (index, value) => { assert.equal(report.checks.length, index); assert.ok(value, BROWSER_PROTECTION_QA_CHECKS[index]); report.checks.push({ name: BROWSER_PROTECTION_QA_CHECKS[index], passed: true }); checkpoint('passed: ' + BROWSER_PROTECTION_QA_CHECKS[index]); };
function boundedNative(label, promise, milliseconds) {
  checkpoint(label); let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native acceptance timed out during ' + label + '.')), milliseconds); })]).finally(() => clearTimeout(timer));
}
const totalBlockedResources = () => counts.ads + counts.trackers;
async function startDriver() { driver = new ElectronBrowserDriver({ dataDir: profile, downloadDir: path.join(profile, 'downloads') }); await boundedNative('loading production filters and contained driver', driver.init(), 20000); await boundedNative('setting the owned session to a direct connection', driver.session.setProxy({ mode: 'direct' }), 5000); report.networkPolicy.directProxy = true; workspace = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }) }); }
async function page(tabId) { const tab = driver.tabs.get(tabId); assert.ok(tab && !tab.window.isDestroyed()); return boundedNative('inspecting the owned page renderer', tab.window.webContents.executeJavaScript('({ready:globalThis.qaReady===true,content:globalThis.qaContent===true,ad:globalThis.qaAd===true,tracker:globalThis.qaTracker===true,origin:location.origin,title:document.title})'), 5000); }
async function act(action, tabId, url) { checkpoint('contained browser action: ' + action); const result = await workspace.perform({ action, ...(tabId ? { tabId } : {}), ...(url ? { url } : {}) }, { source: 'user' }); const observed = await page(result.tabId || tabId); assert.equal(observed.ready, true); assert.equal(observed.content, true); return { tabId: result.tabId || tabId, page: observed }; }
async function runNativeBrowserAcceptance() {
try {
  checkpoint('Electron ready'); const stat = await fs.lstat(profile); assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false);
  server = http.createServer((req, res) => {
    clients.add(req.socket.remoteAddress); res.setHeader('Cache-Control', 'no-store'); const parsed = new URL(req.url, 'http://' + req.headers.host), hostname = parsed.hostname;
    if (!['127.0.0.1', 'pagead2.googlesyndication.com', 'qa-tracker.blackice.test', 'qa-second.blackice.test'].includes(hostname)) { counts.unexpected++; res.writeHead(400); return res.end(); }
    if (hostname === 'pagead2.googlesyndication.com' && parsed.pathname === '/pagead/js/adsbygoogle.js') { counts.ads++; res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('globalThis.qaAd=true;'); }
    if (hostname === 'qa-tracker.blackice.test' && parsed.pathname === '/matomo.js') { counts.trackers++; res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('globalThis.qaTracker=true;'); }
    if (parsed.pathname === '/legitimate.js') { counts.legitimate++; res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('globalThis.qaContent=true;'); }
    if (parsed.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (parsed.pathname !== '/') { counts.unexpected++; res.writeHead(404); return res.end(); }
    counts.pages++; const port = server.address().port;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BLACKICE contained protection check</title><style>html{color-scheme:dark}body{margin:60px;background:#101218;color:#eef1f7;font:18px system-ui;max-width:800px}h1{font-size:28px}p{line-height:1.6}.good{color:#8ce4ba}code{font-size:15px}</style></head><body><h1>Contained browser protection</h1><p>This page and its scripts are served by an owned local fixture.</p><p id="result">Checking requests…</p><script src="/legitimate.js"></script><script src="http://pagead2.googlesyndication.com:${port}/pagead/js/adsbygoogle.js"></script><script src="http://qa-tracker.blackice.test:${port}/matomo.js"></script><script>globalThis.qaReady=true;const p=document.getElementById('result');p.textContent='Content: '+(globalThis.qaContent?'loaded':'missing')+' · Ad: '+(globalThis.qaAd?'loaded':'blocked')+' · Tracker: '+(globalThis.qaTracker?'loaded':'blocked');p.className=globalThis.qaContent&&!globalThis.qaAd&&!globalThis.qaTracker?'good':'';</script></body></html>`);
  });
  await boundedNative('starting the owned loopback fixture server', new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 5000); origin = `http://127.0.0.1:${server.address().port}`; secondOrigin = `http://qa-second.blackice.test:${server.address().port}`;
  await startDriver(); const initial = workspace.protectionStatus(); report.evidence.push({ stage: 'initial', protection: initial });
  check(0, initial.available && !initial.enabled && initial.ready && initial.source === 'bundled' && initial.engineVersion === '2.20.1' && initial.filterCount > 100000 && app.getPath('userData') === profile && driver.tabs.size === 0);
  await workspace.configureProtection({ action: 'global', enabled: true });
  let first = await act('open', null, origin + '/'); report.evidence.push({ stage: 'protected', counts: { ...counts }, page: first.page, protection: workspace.protectionStatus() });
  check(1, counts.legitimate === 1 && counts.ads === 0 && counts.trackers === 0 && !first.page.ad && !first.page.tracker);
  const perTab = workspace.protectionStatus().tabs.find(tab => tab.tabId === first.tabId); check(2, perTab.origin === origin && perTab.enabled === true && perTab.blockedRequests >= 2 && workspace.protectionStatus().blockedRequests >= 2);
  await workspace.configureProtection({ action: 'site', tabId: first.tabId, origin, enabled: false }); first = await act('reload', first.tabId); report.evidence.push({ stage: 'site-exempt', counts: { ...counts }, page: first.page, protection: workspace.protectionStatus(), diagnostics: driver.diagnostics.snapshot() });
  check(3, first.page.ad && first.page.tracker && counts.ads === 1 && counts.trackers === 1);
  let before = totalBlockedResources(), second = await act('open', null, secondOrigin + '/');
  check(4, second.page.origin === secondOrigin && !second.page.ad && !second.page.tracker && totalBlockedResources() === before && workspace.protectionStatus().tabs.find(tab => tab.tabId === second.tabId).siteExempt === false);
  first = await act('navigate', first.tabId, secondOrigin + '/?navigation=changed'); const saved = await fs.readFile(path.join(profile, 'browser-protection.json'), 'utf8');
  await assert.rejects(workspace.configureProtection({ action: 'site', tabId: first.tabId, origin, enabled: false }), { code: 'BROWSER_PROTECTION_STALE_TAB' }); check(5, await fs.readFile(path.join(profile, 'browser-protection.json'), 'utf8') === saved && first.page.origin === secondOrigin);
  first = await act('navigate', first.tabId, origin + '/?navigation=returned'); await workspace.configureProtection({ action: 'site', tabId: first.tabId, origin, enabled: true }); before = totalBlockedResources(); first = await act('reload', first.tabId);
  check(6, !first.page.ad && !first.page.tracker && totalBlockedResources() === before && workspace.protectionStatus().tabs.find(tab => tab.tabId === first.tabId).enabled === true);
  await workspace.configureProtection({ action: 'site', tabId: first.tabId, origin, enabled: false }); await workspace.configureProtection({ action: 'global', enabled: false }); second = await act('reload', second.tabId); const disabled = workspace.protectionStatus(); report.evidence.push({ stage: 'global-disabled', counts: { ...counts }, protection: disabled });
  check(7, second.page.ad && second.page.tracker && disabled.enabled === false && disabled.tabs.find(tab => tab.tabId === first.tabId).siteExempt === true && disabled.tabs.every(tab => tab.available && tab.origin && !tab.enabled));
  await boundedNative('closing the contained driver before profile restore', workspace.close(), 20000); assert.equal(BrowserWindow.getAllWindows().length, 0); await startDriver(); const restored = workspace.protectionStatus(); report.evidence.push({ stage: 'restored', protection: restored });
  check(8, restored.enabled === false && restored.ready && restored.exemptOrigins.includes(origin) && driver.tabs.size === 2 && driver.status().tabs.every(tab => tab.suspended && !tab.visible));
  await workspace.perform({ action: 'protection', operation: 'global', enabled: true }); assert.equal(workspace.protectionStatus().enabled, true);
  await workspace.configureProtection({ action: 'global', enabled: false }, { source: 'agent' }); await assert.rejects(workspace.perform({ action: 'protection', enabled: false }), { code: 'BROWSER_VALIDATION' }); check(9, workspace.protectionStatus().enabled === false);
  const restoredTab = driver.status().tabs.find(tab => new URL(tab.url).origin === origin); assert.ok(restoredTab); first = await act('navigate', restoredTab.tabId, origin + '/?restored=1');
  await workspace.configureProtection({ action: 'global', enabled: true }); await workspace.configureProtection({ action: 'site', tabId: first.tabId, origin, enabled: true }); before = totalBlockedResources(); first = await act('reload', first.tabId);
  check(10, !first.page.ad && !first.page.tracker && totalBlockedResources() === before && workspace.protectionStatus().enabled === true && workspace.protectionStatus().tabs.find(tab => tab.tabId === first.tabId).enabled === true);
  const capture = await workspace.perform({ action: 'screenshot', tabId: first.tabId }, { source: 'user' }); assert.match(capture.imageUrl, /^data:image\/png;base64,/); await fs.writeFile(path.join(out, 'contained-browser-protection.png'), Buffer.from(capture.imageUrl.split(',')[1], 'base64'));
  check(11, capture.width >= 800 && capture.height >= 600 && BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocusable() && window.webContents.isOffscreen()));
  report.evidence.push({ stage: 'final', counts: { ...counts }, protection: workspace.protectionStatus(), screenshot: 'contained-browser-protection.png' });
  check(12, counts.unexpected === 0 && clients.size > 0 && [...clients].every(value => value === '127.0.0.1' || value === '::ffff:127.0.0.1') && app.commandLine.getSwitchValue('host-resolver-rules') === resolverRules && report.networkPolicy.directProxy && report.providerTurnsRequested === 0);
} catch (cause) { report.errors.push(cause.stack || cause.message); checkpoint('acceptance failed'); }
finally {
  try { await boundedNative('closing owned browser resources', workspace ? workspace.close() : driver?.close(), 20000); if (server?.listening) { server.closeAllConnections(); await boundedNative('closing the owned loopback server', new Promise((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())), 5000); } report.cleanup = BrowserWindow.getAllWindows().length === 0 && !server?.listening; if (report.errors.length === 0) check(13, report.cleanup); }
  catch (cause) { report.errors.push('Native fixture cleanup failed: ' + cause.message); }
  report.completedAt = new Date().toISOString(); checkpoint('native acceptance complete'); await fs.writeFile(receipt, JSON.stringify(report, null, 2) + '\n'); app.quit();
}
}

// Electron waits for its ESM entry module to finish before emitting ready.
// Awaiting app.whenReady() at module scope prevents that event from being reached.
checkpoint('waiting for Electron ready');
const readyDeadline = setTimeout(() => { report.errors.push('Electron did not become ready within 15 seconds.'); report.forcedCleanup = true; checkpoint('Electron readiness timed out'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); }, 15000);
app.whenReady().then(() => { clearTimeout(readyDeadline); return runNativeBrowserAcceptance(); }).catch(cause => { clearTimeout(readyDeadline); report.errors.push(cause.stack || cause.message); report.forcedCleanup = true; checkpoint('native fixture failed before normal completion'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); });
