import { app, BrowserWindow, BaseWindow, WebContentsView, dialog } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { createLiveBrowserWindow } from '../../desktop/browser-surface.mjs';
import { captureHiddenPage } from '../../desktop/browser-capture.mjs';

const dataDir = process.argv.find(value => value.startsWith('--fixture-data='))?.slice(15);
if (!dataDir || !path.isAbsolute(dataDir)) throw Error('A disposable fixture directory is required.');
const emergencyExit = error => {
  try { writeFileSync(path.join(dataDir, 'result.json'), JSON.stringify({ ok: false, error: String(error?.stack || error || 'Native fixture failed.') })); }
  finally { app.exit(1); }
};
process.on('uncaughtException', emergencyExit);
process.on('unhandledRejection', emergencyExit);
// Disposable automation must never open Electron's own error dialog.
dialog.showErrorBox = (title, content) => emergencyExit(Error(String(title) + ': ' + String(content)));
app.setPath('userData', path.join(dataDir, 'profile'));
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false);window.setSkipTaskbar(true);
  window.on('show', () => {window.hide();emergencyExit(Error('A disposable fixture window became visible.'));});
});
app.on('window-all-closed', () => {});
const stages = [], stage = value => { stages.push(value); writeFileSync(path.join(dataDir, 'progress.json'), JSON.stringify(stages)); };
const fixtureTimeout = setTimeout(() => { writeFileSync(path.join(dataDir, 'result.json'), JSON.stringify({ ok: false, error: 'Native fixture timed out.', stages })); app.exit(1); }, 65000);
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const until = async (label, read, match) => { const deadline = Date.now() + 12000; for (;;) { const value = await read(); if (match(value)) return value; if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(); } };
const evaluate = async (contents, expression) => {
  const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error('The disposable fixture expression failed.');
  return result.result?.value;
};
app.whenReady().then(async () => {
  let driver, shell, server, result, inspectedContents;
  const fixtureUsername = 'fixture-user', fixturePassword = 'fixture-only-password';
  const fixtureAuthorization = 'Basic ' + Buffer.from(fixtureUsername + ':' + fixturePassword).toString('base64');
  const checks = [], check = (label, fn) => { fn(); checks.push(label); stage(label); };
  const inputState = async () => inspectedContents && !inspectedContents.isDestroyed()
    ? evaluate(inspectedContents, '({inputValue:document.querySelector("#name")?.value,result:document.querySelector("#result")?.textContent,activeElement:document.activeElement?.id||document.activeElement?.tagName,hasFocus:document.hasFocus(),visibility:document.visibilityState,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight},inputHit:document.elementFromPoint(80,45)?.id,buttonHit:document.elementFromPoint(80,105)?.id})') : null;
  const recordInput = async label => { const state = await inputState(); writeFileSync(path.join(dataDir, 'input-state.json'), JSON.stringify({ stage: label, ...state }, null, 2)); };
  try {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/auth') {
        if (req.headers.authorization === fixtureAuthorization) return res.end('<title>Authenticated fixture</title><h1>FIXTURE_SIGNED_IN</h1>');
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BLACKICE fixture site"' });
        return res.end('<h1>Website sign-in required</h1>');
      }
      if (req.url === '/auth-cancel') {
        // A distinct realm always challenges, even if Chromium preemptively
        // presents the previous site's synthetic credentials from its cache.
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BLACKICE fixture cancel"' });
        return res.end('<h1>Cancelled website sign-in fixture</h1>');
      }
      if (req.url === '/popup') return res.end('<title>Native popup</title><h1>Popup ready</h1><script>opener.postMessage("native-popup-ready","*")</script>');
      res.end('<title>Native browser fixture</title><body style="background:#487a29"><input id="name" aria-label="Name" style="position:absolute;left:30px;top:30px;width:240px;height:30px"><button id="save" style="position:absolute;left:30px;top:90px;width:180px;height:30px" onclick="document.querySelector(\'#result\').textContent=\'SAVED:\'+document.querySelector(\'#name\').value+\':\'+event.isTrusted">Save</button><p id="result" style="position:absolute;top:150px"></p><script>window.messages=[];addEventListener("message",e=>messages.push(e.data))</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    stage('start-driver');
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads'), liveSurface: true,
      createSurfaceWindow: options => createLiveBrowserWindow({ BaseWindow, WebContentsView, options }) }).init();
    stage('driver-ready');
    shell = new BrowserWindow({ width: 1000, height: 800, show: false, focusable: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await shell.loadURL('data:text/html,<title>Disposable native browser host</title><body style="background:black">Browser chrome</body>');
    stage('shell-ready');
    const opened = await driver.perform({ action: 'open', url: origin + '/' }, { source: 'user' }), tab = driver.tab(opened.tabId), wc = tab.window.webContents;
    inspectedContents = wc;
    check('non-offscreen-page', () => assert.equal(wc.isOffscreen(), false));
    await driver.setHostSurface(shell, { action: 'attach', tabId: tab.id, bounds: { x: 20, y: 110, width: 700, height: 500 } });
    check('real-view-attached', () => assert.ok(shell.contentView.children.includes(tab.window.view)));
    await until('live viewport resize', () => evaluate(wc, 'innerWidth'), value => value === 700);
    // Hidden, nonfocusable hosts do not provide OS pointer hit-testing. Capture
    // the live compositor, then use explicit DOM focus plus Chromium keyboard
    // commands. This validates the shared WebContents, not physical human input.
    await captureHiddenPage(wc); stage('hidden-view-capture');
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate(wc, 'document.querySelector("#name").focus();true');
    await recordInput('field-focused');
    await wc.debugger.sendCommand('Input.insertText', { text: 'Native typing' });
    await recordInput('text-inserted');
    const typed = await until('focused Chromium text input', () => evaluate(wc, 'document.querySelector("#name").value'), value => value === 'Native typing');
    check('focused-chromium-text-input', () => assert.equal(typed, 'Native typing'));
    // This host deliberately cannot receive physical OS focus. Exercise page
    // state programmatically; native pointer/key activation belongs to the
    // visible packaged-desktop acceptance, not this hidden fixture.
    await evaluate(wc, 'document.querySelector("#save").click();true');
    const value = await evaluate(wc, 'document.querySelector("#result").textContent');
    check('shared-page-state', () => assert.equal(value, 'SAVED:Native typing:false'));
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    const read = await driver.perform({ action: 'read', tabId: tab.id }, { source: 'user' });
    check('same-webcontents-agent-read', () => assert.ok(read.frames.some(frame => frame.text.includes('SAVED:Native typing:false'))));
    const capture = await driver.perform({ action: 'screenshot', tabId: tab.id }, { source: 'user' });
    const scale = await evaluate(wc, 'devicePixelRatio');
    check('same-live-page-capture', () => { assert.equal(capture.width, Math.round(700 * scale)); assert.equal(capture.height, Math.round(500 * scale)); });
    await driver.setHostSurface(shell, { action: 'bounds', bounds: { x: 20, y: 110, width: 600, height: 450 } });
    await until('native bounds update', () => evaluate(wc, 'innerWidth'), value => value === 600);
    shell.hide(); await pause();
    check('parent-hide-retains-attachment', () => assert.equal(driver.surface.status().tabId, tab.id));
    stage('before-popup');
    await evaluate(wc, 'window.fixturePopup=window.open(' + JSON.stringify(origin + '/popup') + ',"_blank");true');
    const child = await until('adopted popup', () => [...driver.tabs.values()].find(page => page.parentTabId === tab.id), Boolean);
    await until('opener message', () => evaluate(wc, 'messages'), values => values.includes('native-popup-ready'));
    check('native-popup-opener', () => assert.equal(child.window.webContents.session, wc.session));
    // Deterministic same-WebContents redirect while viewport-only setup awaits.
    const childContents=child.window.webContents,readViewport=childContents.executeJavaScript.bind(childContents),send=childContents.debugger.sendCommand.bind(childContents.debugger);
    let raced=false,attachInput=0;
    childContents.executeJavaScript=async(expression,...args)=>{
      const value=await readViewport(expression,...args);
      if(!raced&&expression==='({width:innerWidth,height:innerHeight})'){raced=true;await readViewport("location.replace('#viewport-race');true");await new Promise(r=>setTimeout(r,30));}
      return value;
    };
    childContents.debugger.sendCommand=(method,...args)=>{if(method.startsWith('Input.'))attachInput++;return send(method,...args);};
    await driver.setHostSurface(shell, { action: 'attach', tabId: child.id, bounds: { x: 20, y: 110, width: 600, height: 450 } });
    assert.equal(raced,true);assert.equal(attachInput,0);assert.ok(childContents.getURL().endsWith('#viewport-race'));
    childContents.executeJavaScript=readViewport;childContents.debugger.sendCommand=send;
    check('redirect-during-viewport-attaches-without-input',()=>assert.equal(driver.surface.status().tabId,child.id));
    const childView = child.window.view;
    check('popup-stays-inside-host', () => assert.ok(shell.contentView.children.includes(childView)));
    check('race-fixture-remains-hidden',()=>assert.equal(shell.isVisible(),false));
    result = { ok: true, checks };
  } catch (error) {
    let state;
    try { state = await Promise.race([inputState(), new Promise(resolve => setTimeout(() => resolve({ diagnosticTimeout: true }), 2000))]); }
    catch (diagnosticError) { state = { diagnosticError: diagnosticError.message }; }
    result = { ok: false, checks, error: error.stack || error.message, inputState: state };
    writeFileSync(path.join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
  }
  try { await driver?.close(); shell?.destroy(); if (server) await new Promise(resolve => server.close(resolve)); }
  catch (error) { result.ok = false; result.shutdownError = error.stack || error.message; }
  await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
  clearTimeout(fixtureTimeout);
  app.exit(result.ok ? 0 : 1);
});
