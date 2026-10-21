import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFirefoxDriver } from '../desktop/firefox-driver.mjs';
import { startFirefoxSession, waitForFirefoxExit, checkFirefoxProcesses } from '../lib/firefox-session.mjs';

const execFileAsync = promisify(execFile);
const enabled = process.env.RELAY_LIVE_FIREFOX_QA === '1' && process.platform === 'win32';

test('real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart', { skip: !enabled && 'Set RELAY_LIVE_FIREFOX_QA=1 on Windows to use a new disposable Firefox profile.', timeout: 180000 }, async t => {
  const executable = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(root => path.join(root, 'Mozilla Firefox', 'firefox.exe'));
  let installed = false; for (const file of executable) try { installed ||= (await stat(file)).isFile(); } catch {}
  if (!installed) { t.skip('Firefox is not installed in a standard system folder.'); return; }
  const initial = await checkFirefoxProcesses();
  assert.equal(initial.uncertain, false, 'the disposable test must establish that it owns the only Firefox processes');
  if (initial.running) { t.skip('An existing Firefox session is running; it was left untouched.'); return; }
  const tempRoot = path.resolve(tmpdir()), directory = await mkdtemp(path.join(tempRoot, 'relay-firefox-bidi-'));
  assert.ok(path.resolve(directory).startsWith(`${tempRoot}${path.sep}`)); assert.match(path.basename(directory), /^relay-firefox-bidi-/);
  const profile = path.join(directory, 'new-disposable-profile'), appData = path.join(directory, 'new-appdata'), localData = path.join(directory, 'new-localdata');
  await mkdir(profile); await mkdir(path.join(appData, 'Mozilla', 'Firefox'), { recursive: true }); await mkdir(localData);
  await writeFile(path.join(appData, 'Mozilla', 'Firefox', 'profiles.ini'), `[Profile0]\nName=Disposable BiDi fixture\nIsRelative=0\nPath=${profile}\nDefault=1\n`);
  await writeFile(path.join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("browser.startup.homepage", "about:blank");', 'user_pref("browser.startup.page", 0);', 'user_pref("browser.newtabpage.enabled", false);', 'user_pref("browser.sessionstore.resume_from_crash", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);', 'user_pref("datareporting.healthreport.uploadEnabled", false);', 'user_pref("toolkit.telemetry.enabled", false);', 'user_pref("network.captive-portal-service.enabled", false);', 'user_pref("network.connectivity-service.enabled", false);',
  ].join('\n'));
  const environment = { ...process.env, APPDATA: appData, LOCALAPPDATA: localData };
  let driver, launched, ownedChild, server, signIns = 0; const processIds = [], checks = [];
  const assertHeadless = async () => {
    const script = '$ErrorActionPreference="Stop"; $taskFirefoxWindows=@(Get-Process firefox -ErrorAction SilentlyContinue); [pscustomobject]@{count=$taskFirefoxWindows.Count;visible=@($taskFirefoxWindows|Where-Object {$_.MainWindowHandle -ne 0}).Count}|ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const windows = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')); assert.ok(windows.count > 0); assert.equal(windows.visible, 0, 'headless Firefox must have no native browser window handles');
  };
  const start = async () => {
    launched = await startFirefoxSession({ env: environment, port: 0, timeoutMs: 20000, onSpawn: child => { ownedChild = child; } });
    assert.equal(launched.started, true, launched.reason); assert.equal(launched.ready, true, launched.reason); assert.equal(launched.profilePath, profile);
    processIds.push(launched.pid);
    driver = await createFirefoxDriver({ endpoint: launched.endpoint, profileName: 'Disposable BiDi fixture', profileSource: 'new-disposable-test-profile', onClose: async () => { const exit = await launched.stop(); assert.equal(exit.closed, true, 'owned Firefox must flush its temporary profile and exit gracefully'); } });
    await assertHeadless(); return driver;
  };
  const stop = async () => {
    await driver.close(); driver = null;
    const exit = await waitForFirefoxExit(ownedChild); assert.equal(exit.closed, true); launched = null;
    const remaining = await checkFirefoxProcesses(); assert.equal(remaining.uncertain, false); assert.equal(remaining.running, false, 'all disposable Firefox processes must exit before another test or a real profile starts');
  };
  try {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/frame') { res.end('<label>Frame field<input aria-label="Frame field" value="old frame"></label><button onclick="document.querySelector(\'#frame-result\').textContent=\'FRAME_SAVED:\'+document.querySelector(\'input\').value+\':\'+event.isTrusted">Frame save</button><p id="frame-result"></p>'); return; }
      if (req.url === '/login') { signIns++; res.writeHead(302, { 'Set-Cookie': 'relay_disposable_firefox_login=signed-in; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600', Location: '/account' }); res.end(); return; }
      if (req.url === '/account') { if (!(req.headers.cookie || '').includes('relay_disposable_firefox_login=signed-in')) { res.end('<h1>DISPOSABLE_SIGNED_OUT</h1>'); return; } res.end('<h1>DISPOSABLE_SIGNED_IN</h1><p id="preference"></p><script>document.querySelector(\'#preference\').textContent=localStorage.getItem(\'relay_disposable_preference\')===\'compact\'?\'PREFERENCE_RESTORED\':\'PREFERENCE_MISSING\'</script>'); return; }
      if (req.url === '/second') { res.end('<h1>SECOND_TASK_TAB</h1>'); return; }
      const port = server.address().port;
      res.end(`<title>Disposable Firefox fixture</title><h1>DISPOSABLE_FIREFOX_READY</h1><label>Name<input aria-label="Name" value="old name"></label><button onclick="document.querySelector('#main-result').textContent='MAIN_SAVED:'+document.querySelector('input').value+':'+event.isTrusted">Save name</button><p id="main-result"></p><div contenteditable="true" role="textbox" aria-label="Post draft">old draft</div><p id="rich-result"></p><script>const editor=document.querySelector('[contenteditable]');editor.addEventListener('input',event=>{document.querySelector('#rich-result').textContent='RICH_SAVED:'+editor.textContent+':'+event.isTrusted})</script><iframe title="Cross origin fixture" src="http://localhost:${port}/frame"></iframe><button onclick="setTimeout(()=>document.querySelector('#later').textContent='ASYNC_FIXTURE_READY',100)">Load later</button><p id="later"></p><button onclick="localStorage.setItem('relay_disposable_preference','compact');location.href='/login'">Sign in to disposable fixture</button>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await start(); let snapshot = await driver.perform({ action: 'open', url: `${origin}/` }); const mainId = snapshot.tabId;
    const text = () => snapshot.frames.map(frame => frame.text).join('\n');
    const ref = name => { const control = snapshot.frames.flatMap(frame => frame.elements).find(element => element.name === name); assert.ok(control, `Expected disposable control: ${name}`); return control.ref; };
    const act = async (action, name, extra = {}) => { snapshot = await driver.perform({ action, tabId: mainId, ...(name ? { ref: ref(name) } : {}), ...extra }); };
    assert.match(text(), /DISPOSABLE_FIREFOX_READY/); assert.ok(snapshot.frames.some(frame => frame.url.startsWith('http://localhost:'))); checks.push('Main and actual cross-origin frames are inspected');
    await act('fill', 'Name', { text: 'Orbit' }); await act('click', 'Save name'); assert.match(text(), /MAIN_SAVED:Orbit:true/); checks.push('Main browser input and clicks are trusted');
    await act('fill', 'Frame field', { text: 'Frame orbit' }); await act('click', 'Frame save'); assert.match(text(), /FRAME_SAVED:Frame orbit:true/); checks.push('Cross-origin field input and click work');
    snapshot = await driver.perform({ action: 'snapshot', tabId: mainId, query: 'Post draft' }); assert.ok(snapshot.frames[0].elements.some(element => element.name === 'Post draft'));
    await act('fill', 'Post draft', { text: 'Replacement draft' }); assert.match(text(), /RICH_SAVED:Replacement draft:true/); checks.push('Focused rich-text fill replaces existing text with trusted input');
    await act('click', 'Load later'); snapshot = await driver.perform({ action: 'wait', tabId: mainId, query: 'ASYNC_FIXTURE_READY', timeoutMs: 5000 }); assert.match(text(), /ASYNC_FIXTURE_READY/); checks.push('Conditional wait observes an actual DOM change');
    const image = await driver.perform({ action: 'screenshot', tabId: mainId }); assert.match(image.imageUrl, /^data:image\/png;base64,/); assert.ok(Buffer.from(image.imageUrl.split(',')[1], 'base64').length > 1000); checks.push('Screenshot returns actual PNG pixels');
    const second = await driver.perform({ action: 'open', url: `${origin}/second` }); assert.notEqual(second.tabId, mainId);
    await driver.perform({ action: 'close', tabId: second.tabId }); assert.ok(driver.status().tabs.some(tab => tab.tabId === mainId)); assert.ok(!driver.status().tabs.some(tab => tab.tabId === second.tabId)); checks.push('Owned task tabs have distinct IDs and close independently');
    snapshot = await driver.perform({ action: 'snapshot', tabId: mainId }); await act('click', 'Sign in to disposable fixture'); assert.match(text(), /DISPOSABLE_SIGNED_IN/); assert.match(text(), /PREFERENCE_RESTORED/); assert.equal(signIns, 1);
    await assertHeadless(); await stop(); checks.push('First owned headless process closes gracefully');
    await start(); assert.notEqual(processIds[0], processIds[1]); snapshot = await driver.perform({ action: 'open', url: `${origin}/account` });
    assert.match(text(), /DISPOSABLE_SIGNED_IN/); assert.match(text(), /PREFERENCE_RESTORED/); assert.equal(signIns, 1, 'the second process must use Firefox’s own saved session without another login or data transfer'); checks.push('Same disposable Firefox profile preserves its own sign-in and local storage across two processes');
    await assertHeadless(); await stop(); checks.push('Both Firefox launches stay headless and fully exit');
    t.diagnostic(JSON.stringify({ checks, newDisposableProfile: true, userProfileRead: false, cookieCopy: false, fullyExited: true }));
  } finally {
    if (driver) await driver.close().catch(() => {});
    if (ownedChild && ownedChild.exitCode == null && !ownedChild.signalCode) {
      // Emergency cleanup is limited to this captured NEW disposable process.
      // The actual clean-shutdown assertion above still fails if it was needed.
      ownedChild.kill(); await waitForFirefoxExit(ownedChild, { timeoutMs: 10000 });
    }
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    if (!ownedChild || ownedChild.exitCode != null || ownedChild.signalCode) await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
