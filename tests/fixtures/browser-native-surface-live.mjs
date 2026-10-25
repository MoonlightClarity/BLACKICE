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
    await driver.setHostSurface(shell, { action: 'attach', tabId: child.id, bounds: { x: 20, y: 110, width: 600, height: 450 } });
    const childView = child.window.view;
    check('popup-stays-inside-host', () => assert.ok(shell.contentView.children.includes(childView)));
    await evaluate(child.window.webContents, 'window.close();true').catch(() => {});
    await until('script closed popup', () => driver.tabs.has(child.id), value => value === false);
    check('closed-popup-view-removed', () => assert.ok(!shell.contentView.children.includes(childView)));
    await driver.setHostSurface(shell, { action: 'attach', tabId: tab.id, bounds: { x: 20, y: 110, width: 600, height: 450 } });
    await driver.setHostSurface(shell, { action: 'hide' });
    check('workspace-leave-parks-page', () => { assert.equal(driver.surface.status().attached, false); assert.ok(!shell.contentView.children.includes(tab.window.view)); assert.equal(tab.window.webContents, wc); });
    const parked = await driver.perform({ action: 'screenshot', tabId: tab.id }, { source: 'user' });
    check('background-capture-after-detach', () => assert.ok(parked.imageUrl.startsWith('data:image/png;base64,')));
    // Real loopback HTTP authentication tests the native callback and network
    // continuation. It requires no OS focus or visible test window.
    const authOpen = await driver.perform({ action: 'open', url: origin + '/auth' }, { source: 'user' });
    const authTab = driver.tab(authOpen.tabId), authContents = authTab.window.webContents, challenge = authOpen.pendingInteraction;
    check('native-http-auth-challenge', () => {
      assert.equal(challenge?.kind, 'http_auth'); assert.equal(challenge.status, 'pending');
      assert.equal(challenge.origin, origin); assert.equal(challenge.realm, 'BLACKICE fixture site');
    });
    await driver.setHostSurface(shell, { action: 'attach', tabId: authTab.id, bounds: { x: 20, y: 110, width: 600, height: 450 } });
    await driver.setHostSurface(shell, { action: 'hide' });
    check('native-http-auth-survives-workspace-leave', () => assert.equal(authTab.pendingInteraction?.challengeId, challenge.challengeId));
    await driver.setHostSurface(shell, { action: 'attach', tabId: authTab.id, bounds: { x: 20, y: 110, width: 600, height: 450 } });
    const authReceipt = await driver.setHostSurface(shell, { action: 'authenticate', tabId: authTab.id, challengeId: challenge.challengeId,
      username: fixtureUsername, password: fixturePassword });
    const authenticatedText = await until('native HTTP auth network continuation', () => evaluate(authContents, 'document.body?.textContent||""'), value => value.includes('FIXTURE_SIGNED_IN'));
    check('native-http-auth-submit-resumes-original-page', () => {
      assert.equal(authReceipt.submitted, true); assert.equal(authReceipt.cancelled, false);
      assert.ok(authenticatedText.includes('FIXTURE_SIGNED_IN')); assert.equal(authTab.window.webContents, authContents);
      assert.equal(authTab.pendingInteraction, null);
      assert.ok(!JSON.stringify(authReceipt).includes(fixturePassword), 'The authentication receipt must omit credentials.');
    });
    const cancelOpen = await driver.perform({ action: 'open', url: origin + '/auth-cancel' }, { source: 'user' });
    const cancelTab = driver.tab(cancelOpen.tabId), cancelChallenge = cancelOpen.pendingInteraction;
    assert.equal(cancelChallenge?.kind, 'http_auth');
    const cancelReceipt = await driver.setHostSurface(shell, { action: 'cancel-auth', tabId: cancelTab.id, challengeId: cancelChallenge.challengeId });
    await until('cancelled native HTTP authentication', () => cancelTab.window.webContents.isLoadingMainFrame(), value => value === false);
    check('native-http-auth-cancel-consumes-challenge', () => {
      assert.equal(cancelReceipt.cancelled, true); assert.equal(cancelReceipt.submitted, false); assert.equal(cancelTab.pendingInteraction, null);
    });
    await assert.rejects(driver.setHostSurface(shell, { action: 'authenticate', tabId: cancelTab.id, challengeId: cancelChallenge.challengeId,
      username: fixtureUsername, password: fixturePassword }), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
    // Empty tabs use the same durable API as website tabs. They must have real
    // native renderers, independent IDs and their own saved selection.
    const blankOpen = await driver.perform({ action: 'open', url: 'about:blank' }, { source: 'user' });
    const otherBlankOpen = await driver.perform({ action: 'open', url: 'about:blank' }, { source: 'user' });
    const blankTab = driver.tab(blankOpen.tabId), otherBlankTab = driver.tab(otherBlankOpen.tabId);
    const blankContents = blankTab.window.webContents, otherBlankContents = otherBlankTab.window.webContents;
    inspectedContents = blankContents;
    check('native-blank-tabs-have-independent-identities', () => {
      assert.notEqual(blankTab.id, otherBlankTab.id); assert.notEqual(blankContents.id, otherBlankContents.id);
      for (const id of [blankTab.id, otherBlankTab.id]) {
        const saved = driver.status().tabs.find(page => page.tabId === id);
        assert.equal(saved.url, 'about:blank'); assert.equal(saved.title, 'New tab');
      }
      assert.equal(blankContents.isOffscreen(), false); assert.equal(otherBlankContents.isOffscreen(), false);
    });
    const blankAttach = await driver.setHostSurface(shell, { action: 'attach', tabId: blankTab.id,
      bounds: { x: 20, y: 110, width: 620, height: 420 } });
    await until('native blank viewport', () => evaluate(blankContents, 'innerWidth'), value => value === 620);
    check('native-blank-attaches-real-webcontents', () => {
      assert.equal(blankAttach.attached, true); assert.equal(blankAttach.tabId, blankTab.id);
      assert.equal(blankTab.window.webContents, blankContents); assert.ok(shell.contentView.children.includes(blankTab.window.view));
      assert.equal(blankContents.getURL(), 'about:blank');
    });
    const blankBounds = await driver.setHostSurface(shell, { action: 'bounds', bounds: { x: 20, y: 110, width: 560, height: 380 } });
    assert.deepEqual(blankBounds.bounds, { x: 20, y: 110, width: 560, height: 380 });
    assert.deepEqual(blankTab.window.view.getBounds(), blankBounds.bounds);
    // A hidden compositor can defer viewport layout. Flush one read-only frame
    // while keeping the host hidden, as for the original page above.
    await captureHiddenPage(blankContents);
    const blankSize = await until('native blank resized viewport', () => evaluate(blankContents, '({width:innerWidth,height:innerHeight})'), value => value.width === 560 && value.height === 380);
    check('native-blank-bounds-update-same-renderer', () => {
      assert.deepEqual(blankSize, { width: 560, height: 380 }); assert.equal(blankTab.window.webContents, blankContents);
    });
    const fromBlankURL = origin + '/?from-native-blank=1', tabCount = driver.tabs.size;
    // Navigate from the real page itself; no driver open/navigate operation can
    // silently substitute another tab or renderer for this blank page.
    await evaluate(blankContents, 'setTimeout(()=>location.assign(' + JSON.stringify(fromBlankURL) + '),0);true');
    await until('direct blank-page navigation', () => ({ url: blankContents.getURL(), loading: blankContents.isLoadingMainFrame() }), value => value.url === fromBlankURL && !value.loading);
    const navigatedBlankHasForm = await evaluate(blankContents, 'Boolean(document.querySelector("#name"))');
    check('native-blank-direct-navigation-retains-webcontents', () => {
      assert.equal(navigatedBlankHasForm, true); assert.equal(driver.tabs.size, tabCount);
      assert.equal(driver.tab(blankTab.id).window.webContents, blankContents);
      assert.equal(driver.status().tabs.find(page => page.tabId === blankTab.id).url, fromBlankURL);
      assert.ok(shell.contentView.children.includes(blankTab.window.view));
    });
    await driver.perform({ action: 'close', tabId: blankTab.id }, { source: 'user' });
    await until('closed native blank renderer', () => blankContents.isDestroyed(), Boolean);
    check('closing-one-native-blank-keeps-the-other', () => {
      assert.equal(driver.tabs.has(blankTab.id), false); assert.equal(driver.tabs.has(otherBlankTab.id), true);
      assert.equal(driver.tab(otherBlankTab.id).window.webContents, otherBlankContents);
      assert.equal(otherBlankContents.getURL(), 'about:blank');
    });
    await driver.setHostSurface(shell, { action: 'attach', tabId: otherBlankTab.id,
      bounds: { x: 20, y: 110, width: 560, height: 380 } });
    // Attach itself confirms durable selection. An extra explicit flush here
    // would hide a regression in that receipt's persistence contract.
    const durableBlankState = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-tabs.json'), 'utf8'));
    check('native-blank-attachment-confirms-persisted-selection', () => {
      assert.equal(durableBlankState.activeTab, otherBlankTab.id);
      assert.equal(durableBlankState.tabs.some(page => page.tabId === blankTab.id), false);
      const saved = durableBlankState.tabs.find(page => page.tabId === otherBlankTab.id);
      assert.equal(saved.url, 'about:blank'); assert.equal(saved.title, 'New tab');
    });
    const retainedIds = driver.status().tabs.map(page => page.tabId).sort(), retainedBlankId = otherBlankTab.id;
    const previousBlankContentsId = otherBlankContents.id;
    await driver.close(); driver = null; stage('blank-persistence-driver-closed');
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads'), liveSurface: true,
      createSurfaceWindow: options => createLiveBrowserWindow({ BaseWindow, WebContentsView, options }) }).init();
    check('native-blank-driver-restart-restores-selection-without-renderers', () => {
      assert.deepEqual(driver.status().tabs.map(page => page.tabId).sort(), retainedIds);
      assert.equal(driver.status().activeTab, retainedBlankId);
      assert.ok([...driver.tabs.values()].every(page => page.window === null));
      const saved = driver.status().tabs.find(page => page.tabId === retainedBlankId);
      assert.equal(saved.url, 'about:blank'); assert.equal(saved.title, 'New tab'); assert.equal(saved.suspended, true);
    });
    const restoredAttach = await driver.setHostSurface(shell, { action: 'attach', tabId: retainedBlankId,
      bounds: { x: 20, y: 110, width: 500, height: 350 } });
    const restoredBlank = driver.tab(retainedBlankId), restoredContents = restoredBlank.window.webContents;
    inspectedContents = restoredContents;
    await until('restored native blank viewport', () => evaluate(restoredContents, 'innerWidth'), value => value === 500);
    check('restored-native-blank-materializes-in-hidden-host', () => {
      assert.equal(restoredAttach.attached, true); assert.equal(restoredAttach.tabId, retainedBlankId);
      assert.notEqual(restoredContents.id, previousBlankContentsId); assert.equal(restoredContents.getURL(), 'about:blank');
      assert.ok(shell.contentView.children.includes(restoredBlank.window.view)); assert.equal(restoredContents.isOffscreen(), false);
      assert.equal(shell.isVisible(), false); assert.equal(shell.isFocusable(), false); assert.equal(shell.isFocused(), false);
      assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocusable()));
    });
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
