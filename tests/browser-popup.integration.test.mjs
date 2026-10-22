import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fixtureFile = fileURLToPath(new URL('./fixtures/browser-popup-live.mjs', import.meta.url));
const enabled = process.env.RELAY_LIVE_BROWSER_QA === '1';
const nonce = 'disposable-popup-fixture';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function launchFixture({ dataDir, origin, identityOrigin }) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Electron and Chromium write directly to a file. There is no stdout pipe to
  // break when the command runner detaches or a page renderer shuts down.
  const logPath = path.join(dataDir, 'electron.log');
  const log = await open(logPath, 'wx');
  let timeout, stopTimer, exit, timedOut = false;
  try {
    const child = spawn(require('electron'), [fixtureFile, `--fixture-data=${dataDir}`, `--fixture-origin=${origin}`, `--fixture-identity-origin=${identityOrigin}`], { env: environment, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        stopTimer = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 3000);
      } else child.kill('SIGKILL');
    }, 75000);
    exit = await completed;
  } finally { clearTimeout(timeout); clearTimeout(stopTimer); await log.close(); }
  const output = (await readFile(logPath, 'utf8')).slice(-8000);
  let result;
  try { result = JSON.parse(await readFile(path.join(dataDir, 'result.json'), 'utf8')); }
  catch { assert.fail(`Native popup fixture did not save a result (${JSON.stringify(exit)}, timedOut=${timedOut}). Logs: ${logPath}\n${output}`); }
  assert.equal(timedOut, false, `Native popup fixture timed out. Logs: ${logPath}\n${output}`);
  assert.equal(exit.code, 0, `Native popup fixture failed: ${result.error || result.shutdownError || output}. Evidence: ${dataDir}`);
  assert.equal(result.ok, true, result.error || result.shutdownError);
  return result;
}

test('native cross-origin popups redirect, message their opener and follow or close without breaking Observe pins or task routing', { skip: !enabled && 'Set RELAY_LIVE_BROWSER_QA=1 to run disposable hidden Electron browsers.', timeout: 100000 }, async t => {
  const tempRoot = path.resolve(tmpdir()), dataDir = await mkdtemp(path.join(tempRoot, 'relay-browser-popup-'));
  assert.ok(path.resolve(dataDir).startsWith(`${tempRoot}${path.sep}`));
  let passed = false, origin, identityOrigin;
  const requests = [];
  const serverFor = site => http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (site === 'app' && url.pathname === '/unrelated') { res.end('<title>Unrelated fixture</title><h1>Unrelated first personal tab</h1>'); return; }
    const flow = url.searchParams.get('flow');
    if (!['personal', 'task'].includes(flow) || url.searchParams.get('nonce') !== nonce) { res.writeHead(400); res.end('Invalid fixture request'); return; }
    requests.push({ site, route: url.pathname, flow });
    const query = new URLSearchParams({ flow, nonce });
    const payload = phase => JSON.stringify({ kind: 'blackice-popup-fixture', flow, nonce, phase });
    if (site === 'app' && url.pathname === '/parent') {
      res.end(`<title>Fixture parent ${flow}</title><h1>Fixture parent ${flow}</h1><button id="open-popup">Open identity popup</button><script>
        window.fixtureMessages = []; window.fixturePopup = null;
        localStorage.setItem(${JSON.stringify(`blackice_fixture_${flow}`)}, ${JSON.stringify(nonce)});
        addEventListener('message', event => {
          const value = event.data;
          if (value?.kind !== 'blackice-popup-fixture') return;
          fixtureMessages.push({ flow: value.flow, nonce: value.nonce, phase: value.phase, origin: event.origin, sourceMatches: event.source === fixturePopup, ...(value.storage === undefined ? {} : { storage: value.storage }) });
        });
        document.querySelector('#open-popup').onclick = () => { window.fixturePopup = window.open(${JSON.stringify(`${identityOrigin}/identity?${query}`)}, '_blank'); };
      </script>`); return;
    }
    if (site === 'identity' && url.pathname === '/identity') {
      res.end(`<title>Cross-origin identity</title><h1>Cross-origin identity ready</h1><button id="complete">Complete fixture sign-in</button><script>
        window.opener?.postMessage(${payload('identity')}, ${JSON.stringify(origin)});
        document.querySelector('#complete').onclick = () => { location.href = ${JSON.stringify(`/complete?${query}`)}; };
      </script>`); return;
    }
    if (site === 'identity' && url.pathname === '/complete') {
      res.writeHead(302, { Location: `${origin}/feed?${query}` }); res.end(); return;
    }
    if (site === 'app' && url.pathname === '/feed') {
      res.end(`<title>Fixture feed</title><h1>Fixture feed ready</h1><script>
        window.opener?.postMessage({ ...${payload('feed')}, storage: localStorage.getItem(${JSON.stringify(`blackice_fixture_${flow}`)}) }, ${JSON.stringify(origin)});
        addEventListener('message', event => {
          const value = event.data;
          if (event.source === window.opener && event.origin === ${JSON.stringify(origin)} && value?.kind === 'blackice-popup-close' && value.flow === ${JSON.stringify(flow)} && value.nonce === ${JSON.stringify(nonce)}) window.close();
        });
      </script>`); return;
    }
    res.writeHead(404); res.end('Unknown fixture route');
  });
  const servers = [serverFor('app'), serverFor('identity')];
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    if (passed) await rm(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    else t.diagnostic(`Disposable popup failure evidence retained at ${dataDir}`);
  });
  [origin, identityOrigin] = await Promise.all(servers.map(listen));
  assert.notEqual(origin, identityOrigin);
  const result = await launchFixture({ dataDir, origin, identityOrigin });
  assert.ok(result.electron, 'the fixture must run in actual Electron');
  assert.equal(result.suite, 'native-popup-redirect-selection');
  assert.equal(result.hidden, true);
  assert.equal(result.onlyDisposableLocalSites, true);
  assert.equal(result.actualUserBrowserAccessed, false);
  assert.equal(result.fullObserveUiTested, false, 'Observe DOM behavior has its own test suite; this fixture checks its model against native router events');
  assert.deepEqual(result.flows.map(flow => flow.flow), ['personal', 'task']);
  for (const flow of result.flows) {
    assert.equal(flow.taskOwned, flow.flow === 'task');
    for (const key of ['crossOriginOpener', 'identityMessage', 'httpRedirect', 'feedMessage', 'sharedStorage', 'followedPopup', 'explicitPinPreserved', 'closedToParent']) assert.equal(flow[key], true, `${flow.flow}: ${key}`);
    for (const [site, route] of [['app', '/parent'], ['identity', '/identity'], ['identity', '/complete'], ['app', '/feed']]) {
      assert.equal(requests.filter(request => request.site === site && request.route === route && request.flow === flow.flow).length, 1, `${flow.flow} must request ${site}${route} exactly once`);
    }
  }
  passed = true;
});
