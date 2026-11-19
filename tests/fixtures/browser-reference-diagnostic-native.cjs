const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const directory = process.argv.find(value => value.startsWith('--fixture-data='))?.slice(15);
if (!directory || !path.isAbsolute(directory)) throw Error('An isolated fixture directory is required.');
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const report = { fixtureOnly: true, checks: [], ok: false };
let driver, server;

async function main() {
  await app.whenReady();
  const { ElectronBrowserDriver } = await import(pathToFileURL(path.resolve(__dirname, '../../desktop/browser-driver.mjs')));
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/spa-bootstrap')) {
      res.end('<button>Temporary control</button><script>addEventListener("load",()=>setTimeout(()=>{history.replaceState({}, "", "/spa-ready");document.querySelector("button").textContent="Ready control"},130))</script>');
      return;
    }
    res.end(req.url.startsWith('/frame')
      ? '<button>Frame button</button>'
      : '<button onclick="window.clickCount++">Main button</button><iframe src="/frame-a"></iframe><script>window.clickCount=0</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  driver = await new ElectronBrowserDriver({ dataDir: directory, downloadDir: path.join(directory, 'downloads') }).init();
  let snapshot = await driver.perform({ action: 'open', url: base + '/main-a' });
  const tab = driver.tab(snapshot.tabId), wc = tab.window.webContents;
  const ref = name => {
    const item = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === name);
    assert.ok(item, 'Synthetic observed control missing: ' + name);
    return item.ref;
  };
  async function reject(target, reason, properties = {}) {
    await assert.rejects(driver.observeOperation({ action: 'click', tabId: tab.id, ref: target }), error => {
      assert.equal(error.code, 'BROWSER_REF_STALE');
      assert.equal(error.actionDispatched, false);
      const diagnostic = error.browserReferenceDiagnostic;
      assert.equal(diagnostic.reason, reason);
      assert.ok(Number.isSafeInteger(diagnostic.currentRevision));
      for (const [name, value] of Object.entries(properties)) assert.equal(diagnostic[name], value, name);
      for (const [key, value] of Object.entries(diagnostic)) {
        if (key === 'reason' || value === undefined) continue;
        assert.ok(typeof value === 'boolean' || Number.isSafeInteger(value), key);
      }
      return true;
    });
    report.checks.push(reason);
  }
  await reject('unissued-fixture-ref', 'reference-unknown');
  const priorMainRef = ref('Main button'), priorFrameRef = ref('Frame button');
  const frameChanged = new Promise(resolve => {
    const onNavigate = (_event, url, _response, _status, isMain) => {
      if (!isMain && url.endsWith('/frame-b')) { wc.removeListener('did-frame-navigate', onNavigate); resolve(); }
    };
    wc.on('did-frame-navigate', onNavigate);
  });
  await wc.executeJavaScript("document.querySelector('iframe').src='/frame-b'; undefined");
  await frameChanged;
  await reject(priorFrameRef, 'frame-changed', { frameLineageChanged: true, frameUrlChanged: true });
  const valid = await driver.observeOperation({ action: 'click', tabId: tab.id, ref: priorMainRef });
  assert.equal(valid.current, true);
  snapshot = await driver.perform({ action: 'navigate', tabId: tab.id, url: base + '/main-b' });
  await reject(priorMainRef, 'document-changed', { topUrlChanged: true });
  const removed = ref('Main button');
  await wc.executeJavaScript("document.querySelector('button').remove()");
  await reject(removed, 'control-changed');
  assert.equal(await wc.executeJavaScript('window.clickCount'), 0);
  const expectReady = value => {
    assert.equal(new URL(value.url).pathname, '/spa-ready');
    const names = value.frames.flatMap(frame => frame.elements).map(element => element.name);
    assert.ok(names.includes('Ready control'));
    assert.ok(!names.includes('Temporary control'));
  };
  expectReady(await driver.perform({ action: 'navigate', tabId: tab.id, url: base + '/spa-bootstrap' }));
  expectReady(await driver.perform({ action: 'open', url: base + '/spa-bootstrap' }));
  report.checks.push('open and navigate publish controls only after synthetic SPA commits');
  report.ok = true;
}
let finished = false;
const watchdog = setTimeout(() => { report.error = 'Fixture exceeded its deadline'; void finish(1); }, 60000);
async function finish(code) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  try {
    await driver?.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
  } catch { report.cleanupError = true; code = 1; }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit(code);
}
main().then(() => finish(0), error => { report.error = error.message; report.stack = error.stack; return finish(1); });
