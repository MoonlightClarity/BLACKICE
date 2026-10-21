import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fixtureFile = fileURLToPath(new URL('./fixtures/browser-auth-live.mjs', import.meta.url));
const enabled = process.env.RELAY_LIVE_BROWSER_QA === '1';

async function launchFixture({ dataDir, origin, phase }) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [fixtureFile, `--fixture-data=${dataDir}`, `--fixture-origin=${origin}`, `--fixture-phase=${phase}`], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-8000); });
  const timeout = setTimeout(() => child.kill(), 60000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timeout));
  let result;
  try { result = JSON.parse(await readFile(path.join(dataDir, `${phase}.json`), 'utf8')); }
  catch { assert.fail(`Hidden authentication fixture did not save a result (${phase}, exit ${code}). ${output}`); }
  assert.equal(code, 0, `Hidden authentication fixture failed (${phase}): ${result.error || output}`);
  assert.equal(result.ok, true, result.error);
  return result;
}

test('Relay-owned sign-in and local storage survive a full process restart without foregrounding', { skip: !enabled && 'Set RELAY_LIVE_BROWSER_QA=1 to run disposable hidden Electron browsers.', timeout: 150000 }, async t => {
  // Every account and cookie in this test belongs to this disposable local site.
  // It does not prove authentication reuse from an external user browser.
  const tempRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(tempRoot, 'relay-browser-auth-'));
  assert.ok(path.resolve(dataDir).startsWith(`${tempRoot}${path.sep}`));
  assert.match(path.basename(dataDir), /^relay-browser-auth-/);
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  let logins = 0, authenticatedPages = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/login') {
      logins++;
      res.writeHead(302, { 'Set-Cookie': 'relay_disposable_login=signed-in; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600', Location: '/account' });
      res.end(); return;
    }
    if (req.url?.startsWith('/account')) {
      if (!/(?:^|;\s*)relay_disposable_login=signed-in(?:;|$)/.test(req.headers.cookie || '')) { res.end('<h1>Signed out fixture</h1>'); return; }
      authenticatedPages++;
      res.end(`<h1>Signed in fixture</h1><p id="preference"></p><button onclick="localStorage.setItem('relay_disposable_preference','compact');document.querySelector('#preference').textContent='PREFERENCE_SAVED'">Remember fixture preference</button><button onclick="window.open('/account?popup=1','_blank')">Open account popup</button><script>document.querySelector('#preference').textContent=localStorage.getItem('relay_disposable_preference')==='compact'?'PREFERENCE_RESTORED':'PREFERENCE_EMPTY'</script>`); return;
    }
    res.end('<h1>Signed out fixture</h1><button onclick="location.href=\'/login\'">Sign in to fixture</button>');
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seeded = await launchFixture({ dataDir, origin, phase: 'seed' });
  assert.equal(logins, 1);
  const resumed = await launchFixture({ dataDir, origin, phase: 'resume' });
  assert.notEqual(seeded.processId, resumed.processId, 'the persistence check must use a different Electron process');
  assert.equal(logins, 1, 'restored authentication must not repeat the sign-in endpoint');
  assert.ok(authenticatedPages >= 4, 'both main pages and popups must actually reach the authenticated server route');
  assert.equal(seeded.hidden, true); assert.equal(resumed.hidden, true);
  assert.equal(resumed.authenticated, true); assert.equal(resumed.preferenceRestored, true);
  assert.equal(resumed.externalBrowserReuseTested, false);
});
