/** Run with Node. Launches a disposable Electron fixture, then removes its profile after normal exit. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);

async function launchFixture() {
  const profile = await mkdtemp(path.join(tmpdir(), 'blackice-frontend-native-'));
  const resultPath = path.join(profile, 'native-result.json');
  let child, finished = false, output = '';
  try {
    const executable = process.env.BLACKICE_ELECTRON || require('electron');
    assert.equal(typeof executable, 'string', 'Set BLACKICE_ELECTRON to the Electron executable if the package is unavailable.');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [filename, '--frontend-fixture-profile=' + profile, '--frontend-fixture-result=' + resultPath], {
      cwd: path.dirname(path.dirname(filename)), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Native frontend fixture exceeded 45 seconds.\n' + output)); }, 45000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); finished = true; resolve({ code, signal }); });
    });
    assert.deepEqual(exit, { code: 0, signal: null }, 'Native fixture exited abnormally.\n' + output);
    let result;
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); }
    catch (error) { throw Error('Native fixture did not write its normal-quit receipt: ' + error.message + '\n' + output); }
    assert.equal(result.ok, true, result.error || output);
    assert.equal(result.willQuit, true);
    assert.equal(result.normalWindowClose, true);
    assert.equal(result.isolatedUserData, true);
    console.log('PASS ' + JSON.stringify(result));
  } finally {
    if (child && !finished) child.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

async function runNativeFixture() {
  // These synchronous calls run before the first await and before Electron ready.
  const { app, BrowserWindow, nativeImage } = require('electron');
  const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
  const profile = argument('--frontend-fixture-profile'), resultPath = argument('--frontend-fixture-result');
  assert.ok(profile && resultPath, 'Launch this fixture with node tests/desktop-frontend-native.mjs.');
  assert.equal(app.isReady(), false, 'The temporary userData path must be set before Electron ready.');
  app.setPath('userData', profile);
  const sessionPath = path.join(profile, 'session'); mkdirSync(sessionPath, { recursive: true }); app.setPath('sessionData', sessionPath);
  const progress = stage => console.log('NATIVE frontend fixture: ' + stage);
  progress('temporary profile configured before ready');
  app.on('window-all-closed', () => {});
  let window, frontend, result = { ok: false, normalWindowClose: false };
  app.once('will-quit', () => {
    writeFileSync(resultPath, JSON.stringify({ ...result, willQuit: true, isolatedUserData: app.getPath('userData') === profile }));
  });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label) => {
    for (let i = 0; i < 100; i++) { const value = await read(); if (value) return value; await pause(20); }
    throw Error(label + ' timed out');
  };
  try {
    const { createFrontendDevtools } = await import('../desktop/frontend-devtools.mjs');
    progress('waiting for Electron ready');
    await app.whenReady();
    progress('Electron ready');
    window = new BrowserWindow({ width: 840, height: 640, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.setMenu(null);
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><title>Native frontend fixture</title>
      <style>body{font:16px sans-serif;background:#e8f3ff;margin:20px}button{padding:12px}#scroll{margin-top:20px;width:300px;height:120px;overflow:auto;background:white}#long{height:1200px;background:linear-gradient(#ffffff,#70a0e0)}</style></head>
      <body><h1>Disposable native frontend</h1><button id="increment" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Increment</button>
      <output id="count">0</output><input id="message" aria-label="Message" value="fixture">
      <details id="fixture-menu"><summary id="menu-summary">Menu</summary><button id="menu-action">Menu action</button><summary id="second-summary">Not the first summary</summary></details>
      <details id="fixture-outer"><summary>Outer menu</summary><details open><summary id="nested-summary">Nested menu</summary><button id="nested-action">Nested action</button></details></details>
      <div style="position:fixed;visibility:hidden"><button id="css-hidden">CSS hidden</button></div>
      <div style="position:fixed;opacity:0"><button id="css-transparent">Transparent ancestor</button></div>
      <button id="outside-viewport" style="position:fixed;top:-200px;left:0">Offscreen</button>
      <div id="scroll"><div id="long">Scrollable fixture</div></div></body></html>`));
    progress('fixture page loaded');
    frontend = createFrontendDevtools({ getWindow: () => window, getAppMetrics: () => app.getAppMetrics() });
    const command = (method, params = {}, target = 'frontend') => frontend.execute({ action: 'cdp', target, method, params });
    const evaluate = async (expression, target = 'frontend') => {
      const receipt = await frontend.execute({ action: 'evaluate', target, expression });
      assert.equal(receipt.result.exceptionDetails, undefined, JSON.stringify(receipt.result.exceptionDetails));
      return receipt.result.result?.value;
    };
    const state = await frontend.execute({ action: 'state' });
    assert.equal(state.main.processId, process.pid);
    assert.equal(state.window.webContentsId, window.webContents.id);
    assert.equal(state.window.rendererProcessId, window.webContents.getOSProcessId());
    assert.notEqual(state.window.rendererProcessId, process.pid);
    assert.ok(state.appMetrics.some(metric => metric.pid === process.pid));
    assert.equal(await evaluate('Promise.resolve(6 * 7)'), 42);
    await command('Runtime.enable');
    const snapshot = await frontend.execute({ action: 'snapshot' });
    assert.equal(snapshot.snapshot.title, 'Native frontend fixture');
    assert.ok(snapshot.snapshot.text.includes('Disposable native frontend'));
    assert.equal(snapshot.snapshot.controls.find(control => control.id === 'message').value, 'fixture');

    progress('checking snapshot visibility');
    const visibility = [];
    const setMenus = open => evaluate(`document.querySelector('#fixture-menu').open=${open};document.querySelector('#fixture-outer').open=${open};true`);
    for (const mode of ['native', 'fallback']) {
      if (mode === 'fallback') await evaluate(`globalThis.fixtureVisibilityDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'checkVisibility');Object.defineProperty(Element.prototype,'checkVisibility',{value:undefined,configurable:true,writable:true});true`);
      for (const opened of [false, true]) {
        await setMenus(opened);
        const current = (await frontend.execute({ action: 'snapshot' })).snapshot;
        const byId = new Map(current.controls.map(control => [control.id, control]));
        for (const id of ['menu-summary','menu-action','second-summary','nested-summary','nested-action','css-hidden','css-transparent','outside-viewport'])
          assert.ok(byId.has(id), mode + ': hidden controls remain in the snapshot: ' + id);
        assert.equal(byId.get('menu-summary').visible, true, mode + ': the first summary remains visible');
        assert.equal(byId.get('menu-summary').inViewport, true);
        for (const id of ['menu-action','second-summary','nested-summary','nested-action'])
          assert.equal(byId.get(id).visible, opened, mode + ': details visibility for ' + id);
        for (const id of ['css-hidden','css-transparent']) {
          assert.equal(byId.get(id).visible, false, mode + ': CSS visibility for ' + id);
          assert.equal(byId.get(id).inViewport, false);
        }
        assert.equal(byId.get('outside-viewport').visible, true, mode + ': offscreen is distinct from hidden');
        assert.equal(byId.get('outside-viewport').inViewport, false);
        visibility.push({ mode, opened, retainedHiddenControls: true });
      }
    }
    await evaluate(`if(globalThis.fixtureVisibilityDescriptor)Object.defineProperty(Element.prototype,'checkVisibility',globalThis.fixtureVisibilityDescriptor);else delete Element.prototype.checkVisibility;delete globalThis.fixtureVisibilityDescriptor;true`);
    await setMenus(false);

    const center = selector => evaluate('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    const button = await center('#increment');
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
    assert.equal(await evaluate('document.querySelector("#count").textContent'), '1');
    const scroll = await center('#scroll');
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...scroll });
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scroll, deltaX: 0, deltaY: 160 });
    const scrollTop = await until(() => evaluate('document.querySelector("#scroll").scrollTop'), 'Native wheel scrolling');
    const screenshot = await frontend.execute({ action: 'screenshot' });
    assert.equal(screenshot.mimeType, 'image/png');
    assert.match(screenshot.imageUrl, /^data:image\/png;base64,/);
    const decoded = nativeImage.createFromDataURL(screenshot.imageUrl);
    assert.equal(decoded.isEmpty(), false);
    assert.deepEqual(decoded.getSize(), { width: screenshot.width, height: screenshot.height });
    assert.ok(screenshot.width > 100 && screenshot.height > 100);

    await evaluate('console.log("native-frontend-event"); true');
    const events = await frontend.execute({ action: 'events', target: 'frontend', after: 0, limit: 1000 });
    assert.ok(events.events.some(event => event.method === 'Runtime.consoleAPICalled' && event.params.args.some(arg => arg.value === 'native-frontend-event')));
    const thrown = await frontend.execute({ action: 'evaluate', expression: 'throw new Error("native-evaluation-probe")' });
    assert.match(thrown.result.exceptionDetails.exception.description, /native-evaluation-probe/);
    await assert.rejects(command('Fixture.unknownMethod'), /wasn't found|not found|method/i);

    const profiles = {};
    for (const target of ['frontend', 'main']) {
      progress('profiling ' + target);
      await command('Profiler.enable', {}, target);
      await command('Profiler.setSamplingInterval', { interval: 1000 }, target);
      const started = await command('Profiler.start', {}, target);
      const functionName = target === 'main' ? 'nativeMainProfileWork' : 'nativeRendererProfileWork';
      const workload = await evaluate('(function ' + functionName + '(){const end=Date.now()+120;let value=0;while(Date.now()<end)value=Math.imul(value+1,31);return {value,pid:' + (target === 'main' ? 'process.pid' : 'null') + '};})()', target);
      const stopped = await command('Profiler.stop', {}, target);
      const profileResult = stopped.result.profile;
      assert.equal(started.processId, stopped.processId);
      assert.ok(profileResult.nodes.length > 1 && profileResult.samples.length > 0, target + ' profiler must retain state across separate calls');
      assert.ok(profileResult.nodes.some(node => node.callFrame.functionName === functionName), target + ' profile must contain the evaluated workload');
      if (target === 'main') {
        assert.equal(workload.pid, process.pid); assert.equal(stopped.processId, process.pid);
        assert.equal(stopped.processRole, 'electron-main');
      } else {
        assert.equal(stopped.processId, window.webContents.getOSProcessId()); assert.equal(stopped.processRole, 'renderer');
      }
      profiles[target] = { processId: stopped.processId, nodes: profileResult.nodes.length, samples: profileResult.samples.length };
    }
    assert.equal(window.webContents.debugger.isAttached(), true);
    frontend.close(); frontend.close();
    assert.equal(window.isDestroyed(), false, 'Closing developer access must leave the app window alive.');
    assert.equal(window.webContents.debugger.isAttached(), false, 'Owned native debugger must detach on close.');
    await assert.rejects(frontend.execute({ action: 'state' }), { code: 'FRONTEND_DEVTOOLS_CLOSED' });
    result = { ok: true, hostPid: process.pid, rendererPid: state.window.rendererProcessId,
      checks: { snapshot: true, snapshotVisibility: true, evaluate: true, rawClick: true, rawWheel: true, screenshot: true, events: true, exceptions: true, protocolErrors: true, developerSessionsClosed: true },
      visibility, scrollTop, screenshot: { width: screenshot.width, height: screenshot.height }, profiles };
  } catch (error) {
    result = { ok: false, error: error.stack || String(error) };
  } finally {
    progress('closing fixture normally');
    try {
      frontend?.close();
      if (window && !window.isDestroyed()) {
        const closed = new Promise(resolve => window.once('closed', resolve)); window.close(); await closed;
        result.normalWindowClose = true;
      }
    } catch (error) { result.ok = false; result.error = [result.error, error.stack || String(error)].filter(Boolean).join('\n'); }
    app.quit();
  }
}

// Electron must finish evaluating its entry module before app.ready can fire.
if (process.versions.electron) void runNativeFixture().catch(error => {
  console.error(error.stack || error); require('electron').app.exit(1);
});
else {
  try { await launchFixture(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
