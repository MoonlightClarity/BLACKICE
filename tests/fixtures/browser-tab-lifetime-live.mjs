import { app, BrowserWindow, BaseWindow, WebContentsView, dialog } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { createLiveBrowserWindow } from '../../desktop/browser-surface.mjs';

const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const dataDir = argument('fixture-data'), mode = argument('fixture-mode');
if (!dataDir || !path.isAbsolute(dataDir) || !['live', 'offscreen'].includes(mode)) throw Error('An isolated fixture directory and browser mode are required.');
const resultPath = path.join(dataDir, 'result.json'), checks = [];
const emergencyExit = error => {
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, mode, checks, error: String(error?.stack || error) }));
  app.exit(1);
};
process.on('uncaughtException', emergencyExit); process.on('unhandledRejection', emergencyExit);
dialog.showErrorBox = (title, message) => emergencyExit(Error(title + ': ' + message));
app.setPath('userData', path.join(dataDir, 'profile'));
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false); window.setSkipTaskbar(true);
  window.on('show', () => { window.hide(); emergencyExit(Error('A fixture window became visible.')); });
});
const timer = setTimeout(() => emergencyExit(Error('Tab lifetime fixture timed out.')), 30000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read, matches) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value; await pause(25); }
  throw Error('Timed out: ' + label);
}
app.whenReady().then(async () => {
  let driver, shell, server, result;
  try {
    const requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url); res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/child') return res.end('<title>Child work page</title><input id="draft"><p>Child page ready</p>');
      if (req.url === '/parent') return res.end('<title>Parent product page</title><button onclick="window.fixturePopup=window.open(\'/child\',\'_blank\')">Open work page</button>');
      res.writeHead(204); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads'),
      ...(mode === 'live' ? { liveSurface: true, createSurfaceWindow: options => createLiveBrowserWindow({ BaseWindow, WebContentsView, options }) } : {}),
    }).init();
    const unrelated = await driver.perform({ action: 'open', url: 'about:blank' }, { source: 'user' });
    const opened = await driver.perform({ action: 'open', url: origin + '/parent' }, { source: 'user' });
    const parent = driver.tab(opened.tabId), parentContents = parent.window.webContents;
    await parentContents.executeJavaScript('document.querySelector("button").click();true');
    const child = await until('child tab adoption', () => [...driver.tabs.values()].find(tab => tab.parentTabId === parent.id), Boolean);
    const childContents = child.window.webContents;
    await until('child document ready', () => childContents.getTitle(), title => title === 'Child work page');
    await childContents.executeJavaScript('document.querySelector("#draft").value="Unsent child draft";true');
    assert.equal(await childContents.executeJavaScript('!!window.opener'), true);
    checks.push('opener-and-child-are-distinct-documents');
    if (mode === 'live') {
      shell = new BrowserWindow({ width: 900, height: 700, show: false, focusable: false, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await shell.loadURL('data:text/html,<title>Hidden fixture host</title>');
      await driver.setHostSurface(shell, { action: 'attach', tabId: child.id, bounds: { x: 0, y: 100, width: 800, height: 500 } });
      assert.ok(shell.contentView.children.includes(child.window.view));
      checks.push('child-attached-in-contained-host');
    }
    const childDocumentId = driver.status().tabs.find(tab => tab.tabId === child.id).documentId;
    await driver.perform({ action: 'close', tabId: parent.id }, { source: 'user' });
    await until('parent renderer closed', () => parentContents.isDestroyed(), Boolean);
    await pause(75);
    assert.equal(driver.tabs.has(parent.id), false);
    assert.equal(driver.tabs.has(child.id), true, 'Closing a tab must not close the page it opened.');
    assert.equal(childContents.isDestroyed(), false);
    assert.equal(driver.tab(child.id).window.webContents, childContents);
    const savedChild = driver.status().tabs.find(tab => tab.tabId === child.id);
    assert.equal(savedChild.parentTabId, null); assert.equal(savedChild.documentId, childDocumentId);
    assert.equal(savedChild.url, origin + '/child');
    assert.equal(await childContents.executeJavaScript('document.querySelector("#draft").value'), 'Unsent child draft');
    assert.equal(requests.filter(url => url === '/child').length, 1, 'The retained child must not be reloaded.');
    checks.push('closing-parent-retains-child-document-and-unsent-state');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-tabs.json'), 'utf8'));
    assert.equal(saved.tabs.some(tab => tab.tabId === parent.id), false);
    assert.equal(saved.tabs.find(tab => tab.tabId === child.id)?.url, origin + '/child');
    assert.equal(driver.tabs.has(unrelated.tabId), true);
    if (mode === 'live') assert.ok(shell.contentView.children.includes(child.window.view));
    checks.push('surviving-tab-state-persists');
    await driver.perform({ action: 'close', tabId: child.id }, { source: 'user' });
    await until('child explicitly closed', () => driver.tabs.has(child.id), present => !present);
    assert.deepEqual(driver.status().tabs.map(tab => tab.tabId), [unrelated.tabId]);
    checks.push('explicit-child-close-preserves-unrelated-tab');
    assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    result = { ok: true, mode, checks, electron: process.versions.electron, onlyLoopback: true, liveProfileAccessed: false };
  } catch (error) { result = { ok: false, mode, checks, error: error.stack || error.message }; }
  try { await driver?.close(); shell?.destroy(); if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
  catch (error) { result.ok = false; result.shutdownError = error.stack || error.message; }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); clearTimeout(timer);
  app.exit(result.ok ? 0 : 1);
}).catch(emergencyExit);
