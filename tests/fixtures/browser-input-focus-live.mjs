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
const resultPath = path.join(dataDir, 'result.json'), checks = [], observations = [];
const emergencyExit = error => {
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, mode, checks, observations, error: String(error?.stack || error) }));
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
const timer = setTimeout(() => emergencyExit(Error('Input focus fixture timed out.')), 35000);
const markup = '<!doctype html><title>Controlled input fixture</title><input aria-label="Connector title" id="name"><input aria-label="Server URL" id="url"><input aria-label="Keyboard-dependent title" id="keyboard"><p id="keyboard-state">Title required</p><button id="save" disabled>Save connector</button><p id="message">Connector title is required</p><script>' +
  'window.fixture={model:{name:"",url:""},events:[],focusEvents:0};' +
  'for(const el of document.querySelectorAll("input")){' +
  'for(const type of ["focus","focusin","blur","focusout","beforeinput","input","change","keydown","keypress","keyup"])el.addEventListener(type,e=>{fixture.events.push({id:el.id,type,key:e.key||"",trusted:e.isTrusted,focused:document.hasFocus(),value:el.value,active:document.activeElement.id});if(type==="focus")fixture.focusEvents++;});' +
  'el.addEventListener("input",e=>{fixture.model[el.id]=el.value;document.querySelector("#save").disabled=!(fixture.model.name&&fixture.model.url);document.querySelector("#message").textContent=fixture.model.name?"":"Connector title is required";});}' +
  'document.querySelector("#keyboard").addEventListener("keyup",e=>{document.querySelector("#keyboard-state").textContent=e.target.value||"Title required";});' +
  '</script>';
app.whenReady().then(async () => {
  let driver, shell, server, result;
  try {
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(markup); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads'),
      ...(mode === 'live' ? { liveSurface: true, createSurfaceWindow: options => createLiveBrowserWindow({ BaseWindow, WebContentsView, options }) } : {}),
    }).init();
    let snapshot = await driver.perform({ action: 'open', url: origin + '/' });
    const tab = driver.tab(snapshot.tabId), wc = tab.window.webContents;
    const focusCommands = [], sendCommand = wc.debugger.sendCommand.bind(wc.debugger);
    wc.debugger.sendCommand = (method, params, ...rest) => {
      if (method === 'Emulation.setFocusEmulationEnabled') focusCommands.push(params.enabled);
      return sendCommand(method, params, ...rest);
    };
    const fresh = async () => snapshot = await driver.perform({ action: 'snapshot', tabId: tab.id });
    const ref = name => { const item = snapshot.frames.flatMap(frame => frame.elements).find(item => item.name === name); assert.ok(item, 'Missing field ' + name); return item.ref; };
    const guard = () => ({ expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId });
    const action = async args => { await fresh(); return driver.perform({ tabId: tab.id, ...args, ...guard() }); };
    const fill = async (name, text) => { await fresh(); return driver.perform({ action: 'fill', tabId: tab.id, ref: ref(name), text, ...guard() }); };
    const state = () => wc.executeJavaScript('({raw:{name:document.querySelector("#name").value,url:document.querySelector("#url").value},selection:[document.querySelector("#name").selectionStart,document.querySelector("#name").selectionEnd],active:document.activeElement.id,focused:document.hasFocus(),disabled:document.querySelector("#save").disabled,keyboard:{raw:document.querySelector("#keyboard").value,committed:document.querySelector("#keyboard-state").textContent},...structuredClone(fixture)})');
    observations.push({ stage: 'initial', state: await state() });
    await fill('Connector title', 'BLACKICE');
    await fill('Server URL', 'https://connector.example.test/mcp');
    observations.push({ stage: 'filled', state: await state() });
    await fresh(); await driver.perform({ action: 'press', tabId: tab.id, ref: ref('Connector title'), key: 'a', modifiers: ['Control'], ...guard() });
    observations.push({ stage: 'selected', state: await state() });
    await action({ action: 'press', key: 'Backspace' });
    observations.push({ stage: 'cleared', state: await state() });
    assert.equal(observations[1].state.model.name, 'BLACKICE', 'Trusted text input must update the application model.');
    assert.equal(observations[1].state.disabled, false, 'Required fields must enable the form.');
    assert.ok(observations[1].state.focusEvents >= 2, 'Hidden fields must receive native focus events.');
    assert.deepEqual(observations[2].state.selection, [0, 8], 'Control+A must select the input contents.');
    assert.equal(observations[3].state.raw.name, '', 'Backspace must clear the selected input.');
    assert.equal(observations[3].state.model.name, '', 'Deletion must update application state.');
    assert.ok(observations[3].state.events.some(event => event.type === 'keydown' && event.key === 'Backspace' && event.trusted));
    checks.push('hidden-fill-updates-model-and-focus', 'editing-keys-select-and-delete');
    await fill('Connector title', 'Clear this value'); await fill('Connector title', '');
    let current = await state();
    assert.equal(current.raw.name, ''); assert.equal(current.model.name, '');
    checks.push('empty-fill-delivers-trusted-deletion');
    await action({ action: 'type', text: 'BLACKICE α東京🚀' });
    current = await state();
    assert.equal(current.model.name, 'BLACKICE α東京🚀');
    await action({ action: 'press', key: 'Tab' });
    current = await state();
    assert.equal(current.active, 'url');
    assert.ok(current.events.some(event => event.id === 'name' && event.type === 'blur' && event.trusted));
    checks.push('unicode-typing-reaches-application-state', 'tab-delivers-native-blur-and-focus');
    await fill('Keyboard-dependent title', 'Bulk value');
    assert.equal((await state()).keyboard.committed, 'Title required', 'The fixture must require keyboard events, independently of DOM value.');
    await fill('Keyboard-dependent title', '');
    for (const key of 'bB1!:@_+?/') await action({ action: 'press', key });
    await action({ action: 'press', key: 'Space' });
    await action({ action: 'press', key: 'a', modifiers: ['Shift'] });
    await action({ action: 'press', key: '1', modifiers: ['Shift'] });
    current = await state();
    assert.equal(current.keyboard.raw, 'bB1!:@_+?/ A!');
    assert.equal(current.keyboard.committed, current.keyboard.raw);
    assert.ok(current.events.filter(event => event.id === 'keyboard' && event.type === 'keypress').length >= 13);
    assert.ok(current.events.filter(event => event.id === 'keyboard').every(event => event.trusted));
    await action({ action: 'press', key: 'a', modifiers: ['Control'] });
    await action({ action: 'press', key: 'Backspace' });
    current = await state();
    assert.equal(current.keyboard.raw, '');
    assert.equal(current.keyboard.committed, 'Title required');
    checks.push('printable-press-commits-key-dependent-validation-and-preserves-shortcuts');
    if (mode === 'live') {
      shell = new BrowserWindow({ width: 900, height: 700, show: false, focusable: false, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await shell.loadURL('data:text/html,<title>Hidden input fixture host</title>');
      await driver.setHostSurface(shell, { action: 'attach', tabId: tab.id, bounds: { x: 0, y: 100, width: 800, height: 500 } });
      await fill('Connector title', 'Attached view'); await fill('Connector title', '');
      assert.equal((await state()).model.name, '');
      await driver.setHostSurface(shell, { action: 'hide' });
      await fill('Connector title', 'Parked again'); await fill('Connector title', '');
      assert.equal((await state()).model.name, '');
      checks.push('attached-and-reparked-views-retain-working-input');
    }
    assert.equal(focusCommands.length % 2, 0);
    assert.ok(focusCommands.every((enabled, index) => enabled === (index % 2 === 0)));
    if (mode === 'live') assert.ok(focusCommands.length > 0);
    else assert.equal(focusCommands.length, 0);
    checks.push('focus-emulation-is-released-after-each-native-action');
    assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    result = { ok: true, mode, checks, observations, electron: process.versions.electron, onlyLoopback: true, liveProfileAccessed: false };
  } catch (error) { result = { ok: false, mode, checks, observations, error: error.stack || error.message }; }
  try { await driver?.close(); shell?.destroy(); if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
  catch (error) { result.ok = false; result.shutdownError = error.stack || error.message; }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); clearTimeout(timer); app.exit(result.ok ? 0 : 1);
}).catch(emergencyExit);
