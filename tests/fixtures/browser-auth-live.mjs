import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserWorkspace } from '../../lib/browser.mjs';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataDir = argument('fixture-data'), origin = argument('fixture-origin'), phase = argument('fixture-phase');
if (!dataDir || !origin || !['seed', 'resume'].includes(phase)) throw new Error('Disposable fixture data, origin and phase required.');
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('This fixture only visits its disposable loopback website.');
app.setPath('userData', path.join(dataDir, 'profile'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
let browser, driver, failed = false;
try {
  let foregrounded = false;
  app.on('browser-window-created', (_event, window) => {
    window.on('show', () => { foregrounded = true; });
    window.on('focus', () => { foregrounded = true; });
  });
  driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads') }).init();
  browser = new BrowserWorkspace({ driver });
  let snapshot;
  if (phase === 'seed') {
    snapshot = await browser.perform({ action: 'open', url: `${origin}/` });
    assert.match(snapshot.frames.map(frame => frame.text).join('\n'), /Signed out fixture/);
    const signIn = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === 'Sign in to fixture');
    assert.ok(signIn);
    snapshot = await browser.perform({ action: 'click', tabId: snapshot.tabId, ref: signIn.ref });
  } else {
    assert.equal(driver.status().tabs.length, 2, 'main page and popup metadata must restore from the previous process');
    const account = driver.status().tabs.find(tab => tab.url === `${origin}/account`);
    assert.ok(account, 'restored account tab required');
    snapshot = await browser.perform({ action: 'wait', tabId: account.tabId, text: 'Signed in fixture' });
  }
  const id = snapshot.tabId;
  const accountText = () => snapshot.frames.map(frame => frame.text).join('\n');
  assert.match(accountText(), /Signed in fixture/);
  if (phase === 'seed') {
    const remember = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === 'Remember fixture preference');
    snapshot = await browser.perform({ action: 'click', tabId: id, ref: remember.ref });
    assert.match(accountText(), /PREFERENCE_SAVED/);
    const popup = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === 'Open account popup');
    await browser.perform({ action: 'click', tabId: id, ref: popup.ref });
  } else assert.match(accountText(), /PREFERENCE_RESTORED/, 'localStorage must survive process exit');
  const popup = driver.status().tabs.find(tab => tab.tabId !== id);
  assert.ok(popup, 'sign-in popup must be managed by the same browser');
  const popupSnapshot = await browser.perform({ action: 'wait', tabId: popup.tabId, text: 'Signed in fixture' });
  assert.match(popupSnapshot.frames.map(frame => frame.text).join('\n'), /PREFERENCE_RESTORED/);
  const contents = driver.tab(id).window.webContents;
  assert.equal(await contents.executeJavaScript("document.cookie.includes('relay_disposable_login')"), false, 'HttpOnly login must stay unavailable to page scripts');
  assert.equal(await driver.tab(popup.tabId).window.webContents.executeJavaScript('!!window.opener'), phase === 'seed', 'only the original process can preserve a live opener');
  const hidden = !foregrounded && BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused());
  assert.equal(hidden, true, 'sign-in, restoration and popup actions must never foreground their browser windows');
  await browser.close(); browser = null;
  await fs.writeFile(path.join(dataDir, `${phase}.json`), JSON.stringify({ ok: true, processId: process.pid, authenticated: true, preferenceRestored: phase === 'resume', hidden, externalBrowserReuseTested: false }));
} catch (error) {
  failed = true;
  await fs.writeFile(path.join(dataDir, `${phase}.json`), JSON.stringify({ ok: false, error: error.stack }));
} finally {
  await browser?.close(); await driver?.close();
  if (failed) app.exit(1); else app.quit();
}
}).catch(async error => {
  await fs.writeFile(path.join(dataDir, `${phase}.json`), JSON.stringify({ ok: false, error: error.stack }));
  app.exit(1);
});
