import { app, safeStorage } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserWorkspace } from '../../lib/browser.mjs';

const dataDir = process.argv.find(a => a.startsWith('--fixture-data='))?.slice(15);
if (!dataDir) throw new Error('Temporary fixture directory required.');
app.setPath('userData', path.join(dataDir, 'profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
let browser, driver, server; const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
try {
  server = http.createServer((req, res) => {
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="relay-fixture.txt"' }); res.end('RELAY_BROWSER_DOWNLOAD'); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/frame')) { res.end(`<label>Frame field<input aria-label="Frame field"></label><button onclick="document.querySelector('p').textContent='FRAME_DONE:'+event.isTrusted">Frame submit</button><p>${req.url.includes('reload') ? 'FRAME_RELOADED' : ''}</p><button onclick="location.href='/frame?reload=1'">Reload frame</button>`); return; }
    if (req.url === '/popup') { res.end('<h1>POPUP_READY</h1>'); return; }
    if (req.url === '/page2') { setTimeout(() => res.end('<h1>NAVIGATION_SETTLED</h1>'), 150); return; }
    if (req.url === '/big') { res.end(`<h1>Large page</h1>${Array.from({length: 500}, (_,i) => `<button>Button ${i}</button>`).join('')}`); return; }
    if (req.url === '/complex') { res.end(`<h1>Complex controls</h1><div style="display:contents"><button onclick="document.querySelector('#state').textContent='CONTENTS_DONE'">Contents button</button></div><p id="state"></p><div id="outer"></div><script>const outer=document.querySelector('#outer').attachShadow({mode:'open'});outer.innerHTML='<div id="inner"></div>';const inner=outer.querySelector('#inner').attachShadow({mode:'open'});inner.innerHTML='<button>Nested shadow</button><p></p>';inner.querySelector('button').onclick=()=>inner.querySelector('p').textContent='NESTED_DONE'</script><button onclick="document.querySelector('#overlay').style.display='block'">Show overlay</button><button>Covered button</button><div id="overlay" style="display:none;position:fixed;inset:0;background:black;z-index:100"><button onclick="this.parentElement.remove()">Close overlay</button></div><div role="list" aria-label="Tasks" style="height:100px;width:200px;overflow:auto" onscroll="this.querySelector('span').textContent='VISIBLE_AFTER_SCROLL'"><div style="height:2000px"><span>Scroll to load</span></div></div><a href="/page2">Next page</a>`); return; }
    const port = server.address().port;
    res.end(`<!doctype html><html><head><title>Relay browser fixture</title></head><body style="background:#000;color:white"><h1>Browser fixture</h1><label>Name<input aria-label="Name"></label><button id="save" onclick="document.querySelector('#result').textContent='SAVED:'+document.querySelector('input').value+':'+event.isTrusted">Save name</button><p id="result"></p><select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select><div id="shadow"></div><script>const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<button>Shadow button</button><p></p>';r.querySelector('button').onclick=()=>r.querySelector('p').textContent='SHADOW_DONE'</script><iframe title="Cross origin frame" src="http://localhost:${port}/frame"></iframe><button onclick="document.querySelector('#swap').outerHTML='<input aria-label=&quot;Replacement&quot;>'">Replace field</button><input id="swap" aria-label="Old field"><label>Upload<input type="file" aria-label="Upload file" onchange="document.querySelector('#file-result').textContent=this.files[0].name"></label><p id="file-result"></p><a href="/download" download>Download fixture</a><button onclick="window.open('/popup','_blank')">Open popup</button><button onclick="setTimeout(()=>document.querySelector('#later').textContent='ASYNC_READY',150)">Load later</button><p id="later"></p><form onsubmit="event.preventDefault();document.querySelector('#form-result').textContent='ENTER_SUBMITTED'"><input aria-label="Enter field"><button>Submit form</button></form><p id="form-result"></p></body></html>`);
  });
  await new Promise(resolve => server.listen(0, resolve));
  driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads') }).init();
  browser = new BrowserWorkspace({ driver });
  let snapshot = await browser.perform({ action: 'open', url: `http://127.0.0.1:${server.address().port}/` });
  const id = snapshot.tabId;
  const fresh = async () => snapshot = await browser.perform({ action: 'snapshot', tabId: id });
  const ref = name => { const found = snapshot.frames.flatMap(f => f.elements).find(e => e.name === name); assert.ok(found, `Missing ${name}`); return found.ref; };
  const act = async (action, name, extra = {}) => snapshot = await browser.perform({ action, tabId: id, ...(name ? { ref: ref(name) } : {}), ...extra });
  check('Cross-origin frame inspected', () => assert.ok(snapshot.frames.some(f => f.elements.some(e => e.name === 'Frame field'))));
  const firstContents = driver.tab(id).window.webContents;
  await firstContents.executeJavaScript(`for (const name of ['Fixture authorization', 'Fixture sponsorship', 'Fixture privacy']) { const el = document.createElement('select'); el.setAttribute('aria-label', name); el.innerHTML = '<option value="">Choose</option><option value="yes">Yes</option>'; document.body.append(el); }`);
  const observedRefs = [];
  for (const query of ['Fixture authorization', 'Fixture sponsorship', 'Fixture privacy']) {
    const observed = await browser.perform({ action: 'read', tabId: id, query });
    observedRefs.push(observed.frames.flatMap(frame => frame.elements).find(element => element.name === query)?.ref);
  }
  assert.ok(observedRefs.every(Boolean));
  for (const current of observedRefs) snapshot = await browser.perform({ action: 'select', tabId: id, ref: current, value: 'yes' });
  check('Separate filtered reads retain the same-document controls for later actions', () => assert.equal(snapshot.frames[0].elements.filter(element => element.name?.startsWith('Fixture ') && element.value === 'yes').length, 3));
  await firstContents.executeJavaScript("globalThis.fixtureSaveClicks=0;document.querySelector('#save').addEventListener('click',()=>globalThis.fixtureSaveClicks++)");
  const originalCapture = firstContents.capturePage.bind(firstContents); let captureAttempts = 0;
  if (process.argv.includes('--fixture-capture-transient')) firstContents.capturePage = async (...params) => {
    captureAttempts++;
    if (captureAttempts === 1) { await firstContents.executeJavaScript("document.querySelector('#save').style.marginLeft='160px'"); throw new Error('UnknownVizError'); }
    return originalCapture(...params);
  };
  await act('fill', 'Name', { text: 'ORBIT' }); await act('click', 'Save name');
  check('Trusted browser click + actual field input', () => assert.ok(snapshot.frames[0].text.includes('SAVED:ORBIT:true')));
  const saveClicks = await firstContents.executeJavaScript('globalThis.fixtureSaveClicks');
  check('Consequential browser click is dispatched once', () => assert.equal(saveClicks, 1));
  if (process.argv.includes('--fixture-capture-transient')) {
    check('Transient hidden capture retries and refreshes moved target geometry', () => assert.equal(captureAttempts, 2)); firstContents.capturePage = originalCapture;
    const inputCDP = driver.cdp.bind(driver); let presses = 0;
    driver.cdp = async (tab, method, params, signal) => { const value = await inputCDP(tab, method, params, signal); if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { presses++; throw new Error('UnknownVizError'); } return value; };
    try { await assert.rejects(act('click', 'Save name'), /UnknownVizError/); } finally { driver.cdp = inputCDP; }
    const clicksAfterError = await firstContents.executeJavaScript('globalThis.fixtureSaveClicks');
    check('An input failure is reported without replaying the consequential click', () => { assert.equal(presses, 1); assert.equal(clicksAfterError, 2); }); await fresh();
  }
  await act('select', 'Choice', { value: 'two' });
  check('Native select changed', () => assert.equal(snapshot.frames[0].elements.find(e => e.name === 'Choice').value, 'two'));
  await act('click', 'Shadow button'); check('Open shadow DOM action', () => assert.ok(snapshot.frames[0].text.includes('SHADOW_DONE'), JSON.stringify(snapshot)));
  await act('fill', 'Frame field', { text: 'FRAME' }); await act('click', 'Frame submit'); check('Trusted cross-origin frame action', () => assert.ok(snapshot.frames.some(f => f.text.includes('FRAME_DONE:true'))));
  const oldFrameRef = ref('Frame field'); await act('click', 'Reload frame'); snapshot = await browser.perform({ action: 'wait', tabId: id, text: 'FRAME_RELOADED' });
  await assert.rejects(browser.perform({ action: 'fill', tabId: id, ref: oldFrameRef, text: 'must not target replacement' }), /stale|fresh snapshot/); checks.push('Frame navigation cannot reuse an earlier document ref'); await fresh();
  const stale = ref('Old field'); await act('click', 'Replace field');
  await assert.rejects(browser.perform({ action: 'fill', tabId: id, ref: stale, text: 'no' }), /stale|fresh snapshot/); checks.push('Detached refs fail without touching replacement');
  const upload = path.join(dataDir, 'upload-fixture.txt'); await fs.writeFile(upload, 'RELAY_UPLOAD');
  await act('upload', 'Upload file', { paths: [upload], expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId }); check('File upload + change event', () => assert.ok(snapshot.frames[0].text.includes('upload-fixture.txt')));
  await act('click', 'Download fixture');
  let downloads; for (let i = 0; i < 50; i++) { downloads = await browser.perform({ action: 'downloads' }); if (downloads.downloads[0]?.status === 'completed') break; await new Promise(r => setTimeout(r, 30)); }
  check('Download saved to unique local file', () => assert.equal(downloads.downloads[0]?.status, 'completed'));
  assert.equal(await fs.readFile(downloads.downloads[0].path, 'utf8'), 'RELAY_BROWSER_DOWNLOAD');
  await act('click', 'Load later'); snapshot = await browser.perform({ action: 'wait', tabId: id, text: 'ASYNC_READY' }); checks.push('Conditional wait observes actual completion');
  await act('fill', 'Enter field', { text: 'hello' }); await act('press', 'Enter field', { key: 'Enter' });
  check('Browser-only keypress submits form', () => assert.ok(snapshot.frames[0].text.includes('ENTER_SUBMITTED')));
  await act('click', 'Open popup'); const tabs = await browser.perform({ action: 'tabs' }); check('Popup becomes independent managed tab', () => assert.equal(tabs.tabs.length, 2));
  const popupId = tabs.tabs.find(t => t.tabId !== id).tabId; await browser.perform({ action: 'wait', tabId: popupId, text: 'POPUP_READY' });
  assert.equal(await driver.tab(popupId).window.webContents.executeJavaScript('!!window.opener'), true); checks.push('Popup preserves opener for sign-in flows');
  const image = await browser.perform({ action: 'screenshot', tabId: id }); check('Background screenshot returns actual pixels', () => assert.match(image.imageUrl, /^data:image\/png;base64,/));
  check('All agent browser windows remain hidden', () => assert.ok(driver.status().tabs.every(t => !t.visible)));
  snapshot = await browser.perform({ action: 'navigate', tabId: id, url: `http://127.0.0.1:${server.address().port}/complex` });
  await act('click', 'Contents button'); check('display:contents descendants remain reachable', () => assert.ok(snapshot.frames[0].text.includes('CONTENTS_DONE')));
  await act('click', 'Nested shadow'); check('Nested shadow hosts pass hit testing', () => assert.ok(snapshot.frames[0].text.includes('NESTED_DONE')));
  await act('click', 'Show overlay'); await assert.rejects(act('click', 'Covered button'), /covers/); checks.push('Covered controls fail without clicking through overlays');
  await fresh(); await act('click', 'Close overlay'); await act('scroll', 'Tasks', { direction: 'down', amount: 500 });
  snapshot = await browser.perform({ action: 'wait', tabId: id, text: 'VISIBLE_AFTER_SCROLL' }); checks.push('Virtualized scroll observes loaded state');
  await act('click', 'Next page'); check('Click waits for navigation', () => assert.ok(snapshot.frames[0].text.includes('NAVIGATION_SETTLED')));
  snapshot = await browser.perform({ action: 'back', tabId: id }); check('Back waits for current document', () => assert.ok(snapshot.frames[0].text.includes('Complex controls')));
  snapshot = await browser.perform({ action: 'forward', tabId: id }); check('Forward waits for current document', () => assert.ok(snapshot.frames[0].text.includes('NAVIGATION_SETTLED')));
  snapshot = await browser.perform({ action: 'reload', tabId: id }); check('Reload waits for current document', () => assert.ok(snapshot.frames[0].text.includes('NAVIGATION_SETTLED')));
  snapshot = await browser.perform({ action: 'navigate', tabId: id, url: `http://127.0.0.1:${server.address().port}/big` });
  check('Large page results are bounded', () => assert.ok(snapshot.frames[0].truncated && snapshot.frames[0].elements.length <= 400));
  snapshot = await browser.perform({ action: 'snapshot', tabId: id, query: 'Button 450' }); check('Progressive query finds controls beyond initial budget', () => assert.ok(snapshot.frames[0].elements.some(e => e.name === 'Button 450')));
  const awaitAdapterSettlement = async work => {
    assert.equal(typeof work?.then, 'function', 'capture the actual adapter operation before cancellation');
    let timeout;
    try { await Promise.race([work, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Cancelled browser adapter did not settle within its cleanup deadline.')), 3000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(browser.active, null, 'adapter cleanup must finish before another action can start');
    assert.equal(browser.status().recovery, undefined, 'cancelled work must release its recovery barrier only after cleanup');
  };
  const originalCDP = driver.cdp.bind(driver), pointerAbort = new AbortController(); let mouseReleased = false;
  driver.cdp = async (tab, method, params, signal) => { const value = await originalCDP(tab, method, params, signal); if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pointerAbort.abort(); if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') mouseReleased = true; return value; };
  const pointerWork = browser.perform({ action: 'click', tabId: id, ref: ref('Button 450') }, { signal: pointerAbort.signal }), pointerSettlement = browser.active?.settled;
  await assert.rejects(pointerWork, /cancelled/); await awaitAdapterSettlement(pointerSettlement); assert.equal(mouseReleased, true); checks.push('Cancellation after pointer down releases virtual button before adapter settlement');
  const keyAbort = new AbortController(); let keyReleased = false;
  driver.cdp = async (tab, method, params, signal) => { const value = await originalCDP(tab, method, params, signal); if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') keyAbort.abort(); if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') keyReleased = true; return value; };
  const keyWork = browser.perform({ action: 'press', tabId: id, key: 'Tab' }, { signal: keyAbort.signal }), keySettlement = browser.active?.settled;
  await assert.rejects(keyWork, /cancelled/); await awaitAdapterSettlement(keySettlement); assert.equal(keyReleased, true); checks.push('Cancellation after key down releases virtual key before adapter settlement'); driver.cdp = originalCDP;
  if (safeStorage.isEncryptionAvailable()) { const phrase = 'disposable-provider-vault-fixture'; const encrypted = safeStorage.encryptString(phrase); check('Actual Windows vault roundtrip keeps ciphertext distinct', () => { assert.equal(safeStorage.decryptString(encrypted), phrase); assert.ok(!encrypted.includes(Buffer.from(phrase))); }); }
  // Close flushes metadata; a fresh driver restores saved tabs in the same persistent profile.
  await browser.close(); browser = null;
  driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(dataDir, 'downloads') }).init();
  check('Tabs restored after browser restart', () => assert.equal(driver.status().tabs.length, 2));
  await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify({ ok: true, checks }));
} catch (e) { let state; try { state = await browser?.perform({ action: 'snapshot' }); } catch {} await fs.writeFile(path.join(dataDir, 'result.json'), JSON.stringify({ ok: false, checks, error: e.stack, state })); console.error(e.stack); process.exitCode = 1; }
finally { await browser?.close(); await driver?.close(); server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve()); app.exit(process.exitCode || 0); }
}).catch(e => { console.error(e); app.exit(1); });
