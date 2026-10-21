import { app } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise only disposable local pages, never the installed browser profile.
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = path.resolve(option('source') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const output = option('output');
if (!output) throw Error('Supply --output=<absolute report path outside source>.');
const reportPath = path.resolve(output);
if (reportPath.startsWith(source + path.sep)) throw Error('Keep machine-specific evidence outside source.');
const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-input-smoke-'));
const profile = path.join(root, 'profile');
await fs.mkdir(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const { ElectronBrowserDriver } = await import(pathToFileURL(path.join(source, 'desktop/browser-driver.mjs')).href);
const { BrowserWorkspace } = await import(pathToFileURL(path.join(source, 'lib/browser.mjs')).href);
const hash = async relative => createHash('sha256').update(await fs.readFile(path.join(source, relative))).digest('hex');
const report = { format: 1, source, platform: process.platform, electron: process.versions.electron, startedAt: new Date().toISOString(), actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, checks: [], samples: [] };
let browser, driver, server;
const stage = name => { report.stage = name; console.log(name); };
const deadline = setTimeout(async () => {
  report.passed = false; report.error = 'Disposable input smoke exceeded 60 seconds.';
  try { await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  finally { console.error(JSON.stringify(report)); app.exit(1); }
}, 60000);

async function main() {
try {
  stage('waiting-for-electron-ready');
  await app.whenReady();
  stage('starting-local-fixture');
  report.driverHash = await hash('desktop/browser-driver.mjs');
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/frame') { response.end(`<p>Local child frame</p>${'<button>Frame control</button>'.repeat(80)}`); return; }
    if (request.url === '/next') { response.end('<h1>Next document</h1><input id="next" autofocus>'); return; }
    response.end(`<!doctype html><html><head><title>Disposable BLACKICE input fixture</title></head><body>
      <label>Fixture field<input id="field" aria-label="Fixture field"></label>
      <button id="next" onclick="location.href='/next'">Next document</button>
      <script>globalThis.fixtureClicks=0;document.querySelector('#field').addEventListener('click',()=>globalThis.fixtureClicks++);</script>
      ${'<button>Local control</button>'.repeat(300)}${'<iframe src="/frame" title="Local child"></iframe>'.repeat(5)}
    </body></html>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  stage('initializing-browser-driver');
  driver = await new ElectronBrowserDriver({ dataDir: root, downloadDir: path.join(root, 'downloads') }).init();
  browser = new BrowserWorkspace({ driver });
  stage('loading-local-page');
  const opened = await browser.perform({ action: 'open', url: `http://127.0.0.1:${server.address().port}/` }, { source: 'user' });
  const tabId = opened.tabId, contents = driver.tab(tabId).window.webContents;
  const originalSnapshot = driver.snapshot.bind(driver), originalSettle = driver.settle.bind(driver);
  let snapshots = 0, settles = 0;
  driver.snapshot = (...args) => { snapshots++; return originalSnapshot(...args); };
  driver.settle = (...args) => { settles++; return originalSettle(...args); };
  let lastGuard, lastPoint;
  for (let index = 0; index < 3; index++) {
    stage(`measuring-click-and-type-${index}`);
    await contents.executeJavaScript("document.querySelector('#field').value=''");
    const preview = await browser.perform({ action: 'screenshot', browser: 'relay', tabId }, { source: 'user' });
    const point = await contents.executeJavaScript("(()=>{const r=document.querySelector('#field').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    const guard = { browser: 'relay', tabId, expectedUrl: preview.url, expectedDocumentId: preview.documentId };
    lastGuard = guard; lastPoint = point;
    const before = { snapshots, settles }, start = performance.now();
    const clicked = await browser.perform({ ...guard, action: 'click', ...point }, { source: 'user' });
    const clickMs = performance.now() - start;
    const text = `BLACKICE fixture ${index} — ✓`;
    await browser.perform({ ...guard, action: 'type', text }, { source: 'user' });
    const clickAndTypeMs = performance.now() - start;
    assert.equal(await contents.executeJavaScript("document.querySelector('#field').value"), text);
    assert.equal(clicked.receipt.clicked, true);
    report.samples.push({ clickMs, clickAndTypeMs, snapshots: snapshots - before.snapshots, settles: settles - before.settles });
  }
  assert.equal(await contents.executeJavaScript('globalThis.fixtureClicks'), 3);
  stage('checking-stale-input-and-navigation');
  report.checks.push('Three trusted clicks and ordered Unicode input reached the actual hidden page exactly once');
  await assert.rejects(browser.perform({ ...lastGuard, expectedDocumentId: lastGuard.expectedDocumentId + ':stale', action: 'click', ...lastPoint }, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(await contents.executeJavaScript('globalThis.fixtureClicks'), 3);
  report.checks.push('A stale document guard prevented pointer dispatch');
  const nextPoint = await contents.executeJavaScript("(()=>{const r=document.querySelector('#next').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const navigated = new Promise(resolve => contents.once('did-finish-load', resolve));
  await browser.perform({ ...lastGuard, action: 'click', ...nextPoint }, { source: 'user' });
  await navigated;
  await assert.rejects(browser.perform({ ...lastGuard, action: 'type', text: 'MUST_NOT_REACH_NEW_PAGE' }, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(await contents.executeJavaScript("document.querySelector('#next').value"), '');
  report.checks.push('Navigation invalidated prior-document input before it could reach the replacement document');
  assert.ok(driver.status().tabs.every(tab => !tab.visible));
  report.checks.push('Every browser window remained hidden');
  if (process.argv.includes('--expect-fast')) {
    assert.ok(report.samples.every(sample => sample.snapshots === 0 && sample.settles === 0));
    report.checks.push('Guarded manual clicks did not wait for post-click settling or DOM snapshots');
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  report.medianClickMs = median(report.samples.map(sample => sample.clickMs));
  report.medianClickAndTypeMs = median(report.samples.map(sample => sample.clickAndTypeMs));
  assert.equal(await hash('desktop/browser-driver.mjs'), report.driverHash);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
} finally {
  stage('closing-fixture');
  try { await browser?.close(); await driver?.close(); } catch (error) { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  clearTimeout(deadline);
  app.exit(process.exitCode || 0);
}
}
// Electron emits ready after its ESM entry finishes evaluating.
void main();
