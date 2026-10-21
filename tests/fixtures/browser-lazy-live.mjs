import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserWorkspace } from '../../lib/browser.mjs';

const dataDir = process.argv.find(value => value.startsWith('--fixture-data='))?.slice(15);
if (!dataDir) throw new Error('Disposable fixture directory required.');
app.setPath('userData', path.join(dataDir, 'profile')); app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let browser, driver, server, failed = false, foregrounded = false; const requests = [];
  try {
    server = http.createServer((req, res) => { requests.push(req.url); res.setHeader('Content-Type', 'text/html'); res.end(`<title>Loaded ${req.url}</title><h1>Actual page ${req.url}</h1><button>Main page control</button>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(path.join(dataDir, 'browser-tabs.json'), JSON.stringify([{ url: `${origin}/saved`, title: 'Saved page title' }, { url: `${origin}/never-load`, title: 'Unused saved page' }]));
    app.on('browser-window-created', (_event, window) => { window.on('show', () => { foregrounded = true; }); window.on('focus', () => { foregrounded = true; }); });
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads') }).init(); browser = new BrowserWorkspace({ driver });
    const initial = await browser.perform({ action: 'tabs' });
    assert.equal(initial.tabs.length, 2); assert.equal(initial.tabs[0].title, 'Saved page title');
    assert.ok(initial.tabs.every(tab => tab.suspended && !tab.loading && !tab.visible));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(requests.length, 0, 'initialization and tab listing must never request the saved pages');
    await browser.perform({ action: 'close', tabId: initial.tabs[1].tabId });
    assert.equal(requests.length, 0, 'closing an unused tab must not load it');
    let snapshot = await browser.perform({ action: 'read', tabId: initial.tabs[0].tabId });
    assert.match(snapshot.frames[0].text, /Actual page \/saved/); assert.ok(snapshot.frames[0].elements.some(element => element.name === 'Main page control'));
    assert.equal(requests.filter(url => url === '/saved').length, 1);
    assert.equal(driver.status().tabs[0].suspended, false);
    const replaced = driver.newTab(`${origin}/stale-login`, { restore: true, title: 'Stale login' });
    snapshot = await browser.perform({ action: 'navigate', tabId: replaced.id, url: `${origin}/replacement` });
    assert.match(snapshot.frames[0].text, /Actual page \/replacement/); assert.equal(requests.includes('/stale-login'), false);
    const reloaded = driver.newTab(`${origin}/reload`, { restore: true });
    snapshot = await browser.perform({ action: 'reload', tabId: reloaded.id });
    assert.match(snapshot.frames[0].text, /Actual page \/reload/); assert.equal(requests.filter(url => url === '/reload').length, 1, 'first reload should resume once');
    assert.equal(requests.includes('/never-load'), false);
    const hidden = !foregrounded && BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()); assert.equal(hidden, true);
    await browser.close(); browser = null;
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-tabs.json'), 'utf8')).tabs;
    assert.ok(persisted.some(tab => tab.url === `${origin}/saved` && tab.title === 'Loaded /saved'));
    await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify({ ok: true, noStartupRequests: true, closedPageNeverLoaded: true, firstReadLoadsPage: true, navigateSkipsStaleURL: true, reloadLoadsOnce: true, hidden }));
  } catch (error) { failed = true; await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify({ ok: false, error: error.stack })); }
  finally { await browser?.close(); await driver?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); if (failed) app.exit(1); else app.quit(); }
}).catch(async () => { await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify({ ok: false, error: 'The disposable restoration fixture failed to initialize.' })); app.exit(1); });
