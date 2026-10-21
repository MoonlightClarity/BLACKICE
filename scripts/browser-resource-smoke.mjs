/** Run with the candidate's Electron executable, never the running app profile.
 * electron scripts/browser-resource-smoke.mjs --output=<absolute-result.json>
 * The one intentional renderer crash belongs to this disposable process.
 */
import { app } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ElectronBrowserDriver } from '../desktop/browser-driver.mjs';

const outputArgument = process.argv.find(value => value.startsWith('--output='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output='.length)) : null;
const temporary = mkdtempSync(path.join(tmpdir(), 'blackice-browser-resource-smoke-'));
const profile = path.join(temporary, 'profile'), data = path.join(temporary, 'data');
mkdirSync(profile, { recursive: true }); mkdirSync(data, { recursive: true });
app.setPath('userData', profile);
app.setName('BLACKICE isolated browser resource smoke');
app.on('window-all-closed', () => {});

let driver, server, completed = false;
const fixtureSockets = new Set();
const counts = { target: 0, sibling: 0, effects: 0 };
const receipt = { suite: 'browser-resource-native', startedAt: new Date().toISOString(), electron: process.versions.electron, node: process.versions.node, profile, checks: [], stages: [] };
function save(value) { if (output) { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(value, null, 2) + '\n'); } console.log(JSON.stringify(value)); }
function stage(name) {
  receipt.stage = name; receipt.stages.push({ name, at: new Date().toISOString() });
  if (receipt.stages.length > 16) receipt.stages.shift();
  save({ ...receipt, status: 'running', counts });
}
const watchdog = setTimeout(() => {
  if (completed) return;
  save({ ...receipt, success: false, error: 'Native smoke watchdog expired after 45 seconds.', counts });
  app.exit(1);
}, 45_000);
async function deadline(work, milliseconds, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const end = performance.now() + 5000;
  while (!predicate()) { if (performance.now() >= end) throw new Error(`${label} timed out`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function closeFixture() {
  if (!server) return;
  const owned = server; server = null;
  const closing = new Promise((resolve, reject) => owned.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  // Chromium can leave preconnected/keep-alive fixture sockets after its pages
  // close. These sockets belong only to this loopback test server, not BLACKICE
  // or the person's browser. Drain them explicitly before awaiting its close.
  owned.closeIdleConnections?.();
  receipt.fixtureSocketsClosed = fixtureSockets.size;
  for (const socket of fixtureSockets) socket.destroy();
  await deadline(closing, 5000, 'local fixture server cleanup');
}

async function main() {
try {
  stage('waiting-for-electron-ready');
  await app.whenReady();
  stage('starting-local-fixture');
  server = createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (route === '/effect' && request.method === 'POST') { counts.effects++; response.writeHead(204); response.end(); return; }
    if (route === '/target' || route === '/sibling') {
      counts[route.slice(1)]++;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta charset="utf-8"><title>${route.slice(1)}</title><h1>${route.slice(1)} ready</h1><button id="action">Fixture action</button>`);
      return;
    }
    response.writeHead(404); response.end();
  });
  server.on('connection', socket => { fixtureSockets.add(socket); socket.once('close', () => fixtureSockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  stage('initializing-browser-driver');
  driver = await new ElectronBrowserDriver({ dataDir: data, downloadDir: path.join(temporary, 'downloads') }).init();
  assert.equal(driver.protection.status().ready, true, 'The installed bundled browser filters must load.');
  stage('loading-local-pages');
  const tab = driver.newTab(`http://127.0.0.1:${port}/target`);
  const sibling = driver.newTab(`http://localhost:${port}/sibling`);
  await Promise.all([tab.loading, sibling.loading]);
  assert.equal(tab.loadError, undefined); assert.equal(sibling.loadError, undefined);
  const initial = await driver.perform({ action: 'snapshot', tabId: tab.id });
  assert.ok(initial.frames.some(frame => frame.text.includes('target ready')));
  assert.ok(tab.refs.size > 0);
  assert.equal(counts.target, 1); assert.equal(counts.sibling, 1);
  const crashedWindow = tab.window, siblingWindow = sibling.window;
  const targetPid = crashedWindow.webContents.getOSProcessId(), siblingPid = siblingWindow.webContents.getOSProcessId();
  assert.notEqual(targetPid, siblingPid, 'The independent sibling must use a different Chromium renderer for this isolation test.');
  receipt.checks.push({ name: 'local_pages_and_independent_renderers', passed: true, targetPid, siblingPid });
  stage('waiting-for-local-side-effect');

  // The local effect completes, then its renderer response remains pending.
  // Losing that renderer must never run the effect a second time.
  const native = crashedWindow.webContents.executeJavaScript("fetch('/effect', {method:'POST'}).then(() => new Promise(() => {}))");
  const pending = driver.pageWork(tab, native, undefined, 20_000).then(value => ({ success: true, value }), error => ({ success: false, code: error.code, message: error.message }));
  await until(() => counts.effects === 1, 'local side effect');
  stage('crashing-isolated-test-renderer');
  const crashStarted = performance.now();
  crashedWindow.webContents.forcefullyCrashRenderer();
  await until(() => Boolean(tab.rendererFailure), 'renderer crash notification');
  const outcome = await deadline(pending, 5000, 'pending browser operation');
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, 'BROWSER_RENDERER_GONE');
  assert.equal(tab.window, null); assert.equal(crashedWindow.isDestroyed(), true);
  assert.equal(tab.refs.size, 0); assert.equal(driver.tabs.has(tab.id), true);
  assert.equal(driver.status().capacity.live, 1);
  assert.equal(sibling.window, siblingWindow); assert.equal(siblingWindow.isDestroyed(), false);
  assert.equal(counts.target, 1); assert.equal(counts.effects, 1);
  receipt.checks.push({ name: 'native_crash_releases_resources_and_pending_action', passed: true, milliseconds: Math.round((performance.now() - crashStarted) * 10) / 10, reason: tab.rendererFailure.reason, code: outcome.code });

  await assert.rejects(driver.perform({ action: 'read', tabId: tab.id }), error => error.code === 'BROWSER_RENDERER_GONE' && error.actionDispatched === false);
  await assert.rejects(driver.perform({ action: 'click', tabId: tab.id, ref: initial.frames[0].elements[0].ref }), error => error.code === 'BROWSER_RENDERER_GONE');
  assert.equal(tab.window, null); assert.equal(counts.target, 1); assert.equal(counts.effects, 1);
  const siblingResult = await driver.perform({ action: 'snapshot', tabId: sibling.id });
  assert.ok(siblingResult.frames.some(frame => frame.text.includes('sibling ready')));
  receipt.checks.push({ name: 'failed_page_requires_explicit_recovery_and_sibling_remains_usable', passed: true });

  stage('explicit-recovery-and-capture');
  const recovered = await driver.perform({ action: 'reload', tabId: tab.id });
  assert.ok(recovered.frames.some(frame => frame.text.includes('target ready')));
  assert.notEqual(tab.window, crashedWindow); assert.equal(tab.rendererFailure, null);
  assert.equal(counts.target, 2); assert.equal(counts.effects, 1); assert.equal(counts.sibling, 1);
  assert.equal(driver.status().capacity.live, 2);
  const image = await driver.perform({ action: 'screenshot', tabId: tab.id });
  assert.ok(image.width > 0 && image.height > 0);
  assert.equal(tab.window.isVisible(), false); assert.equal(siblingWindow.isVisible(), false);
  receipt.checks.push({ name: 'one_explicit_reload_restores_contained_snapshot_and_capture_without_replay', passed: true, capture: { width: image.width, height: image.height } });
  stage('flushing-browser-persistence');
  await deadline(driver.flushPersistence(), 8000, 'browser persistence flush');
  stage('closing-browser-driver');
  await deadline(driver.close(), 8000, 'browser driver close'); driver = null;
  stage('closing-local-fixture');
  await closeFixture();
  completed = true; clearTimeout(watchdog);
  save({ ...receipt, success: true, finishedAt: new Date().toISOString(), counts });
  app.quit();
} catch (error) {
  receipt.error = { name: error.name, code: error.code, message: error.message, stage: receipt.stage };
  if (driver) await deadline(driver.close(), 5000, 'browser cleanup').catch(() => {});
  await closeFixture().catch(cleanupError => { receipt.cleanupError = cleanupError.message; });
  completed = true; clearTimeout(watchdog);
  save({ ...receipt, success: false, finishedAt: new Date().toISOString(), counts });
  app.exit(1);
}
}
// Electron waits for its ESM entry module to finish before emitting ready.
// Keep the readiness await inside this detached async entry, never at top level.
void main();
