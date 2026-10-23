const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const directory = process.argv.find(value => value.startsWith('--fixture-data='))?.slice(15);
if (!directory || !path.isAbsolute(directory)) throw Error('An isolated fixture directory is required.');
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});
const report = { fixtureOnly: true, liveUserBrowserAccessed: false, checks: [], ok: false };
let driver, server;
const markup = (frame = false) => `<!doctype html><title>Trusted fill fixture</title><style>body{padding:24px}input,textarea{display:block;margin:10px;width:260px}iframe{width:450px;height:220px}</style>
<input aria-label="${frame ? 'Frame field' : 'Preferred Name'}" id="name" value="Initial text"><input aria-label="Address" id="address"><textarea aria-label="Notes" id="notes">Initial notes</textarea>
<input aria-label="Email" id="email" type="email" value="old@example.test"><input aria-label="Number" id="number" type="number" value="123"><input aria-label="Read only" id="readonly" readonly value="preserve"><input aria-label="Disabled" id="disabled" disabled value="preserve">
<input aria-label="Navigate on focus" id="navigate" value="preserve"><input aria-label="Redirect on select" id="redirect" value="preserve">
<button id="commit">Commit fixture</button><div aria-label="Rich text" role="textbox" contenteditable="true" id="rich">Initial rich</div>
${frame ? '' : '<iframe title="Cross-origin fixture" src="http://localhost:PORT/frame"></iframe>'}
<script>
window.fixture={fields:{},events:[]};
for(const el of document.querySelectorAll('input,textarea,[contenteditable]')){
 const item=fixture.fields[el.id]={draft:'',committed:'',trustedInputs:0,focused:false,blurs:0};
 el.addEventListener('focus',e=>{item.focused=e.isTrusted;fixture.events.push({id:el.id,type:'focus',trusted:e.isTrusted});});
 el.addEventListener('input',e=>{fixture.events.push({id:el.id,type:'input',trusted:e.isTrusted});if(e.isTrusted&&item.focused&&document.activeElement===el){item.draft=el.isContentEditable?el.textContent:el.value;item.trustedInputs++;}});
 el.addEventListener('blur',e=>{fixture.events.push({id:el.id,type:'blur',trusted:e.isTrusted});if(e.isTrusted&&item.focused&&item.trustedInputs){item.committed=item.draft;item.blurs++;}item.focused=false;});
}
document.getElementById('navigate').addEventListener('focus',()=>location.hash='changed-during-fill');
document.getElementById('redirect').addEventListener('keydown',event=>{if(event.code==='KeyA')document.getElementById('address').focus();});
</script>`;
const check = (name, fn) => { fn(); report.checks.push(name); };
async function main() {
  await app.whenReady();
  const { ElectronBrowserDriver } = await import(pathToFileURL(path.resolve(__dirname, '../../desktop/browser-driver.mjs')));
  server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(markup(req.url === '/frame').replace('PORT', String(server.address().port))); });
  await new Promise(resolve => server.listen(0, resolve));
  driver = await new ElectronBrowserDriver({ dataDir: directory, downloadDir: path.join(directory, 'downloads') }).init();
  let snapshot = await driver.perform({ action: 'open', url: `http://127.0.0.1:${server.address().port}/` });
  const tab = driver.tab(snapshot.tabId), wc = tab.window.webContents;
  const fresh = async () => snapshot = await driver.perform({ action: 'snapshot', tabId: tab.id });
  const ref = name => { const value = snapshot.frames.flatMap(frame => frame.elements).find(item => item.name === name); assert.ok(value, `Missing synthetic ${name} target`); return value.ref; };
  const fill = async (name, text) => { await fresh(); return driver.perform({ action: 'fill', tabId: tab.id, ref: ref(name), text, expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId }); };
  const commit = async () => { await fresh(); return driver.perform({ action: 'click', tabId: tab.id, ref: ref('Commit fixture'), expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId }); };
  const state = () => wc.executeJavaScript('structuredClone(window.fixture)');
  const baseline = await wc.executeJavaScript(`(()=>{const el=document.getElementById('name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'DOM only false-positive');el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:'DOM only false-positive'}));el.dispatchEvent(new Event('change',{bubbles:true}));return{rawMatches:el.value==='DOM only false-positive',applicationMissing:fixture.fields.name.committed==='',trustedInputs:fixture.fields.name.trustedInputs};})()`);
  check('DOM-only native setter plus synthetic events reproduces unchanged application state', () => { assert.equal(baseline.rawMatches, true); assert.equal(baseline.applicationMissing, true); assert.equal(baseline.trustedInputs, 0); });
  await fill('Preferred Name', 'Lumen α東京🚀'); await fill('Address', '123 Synthetic Street'); await commit();
  let current = await state();
  check('trusted focus input and blur commit both required fields', () => { assert.equal(current.fields.name.committed, 'Lumen α東京🚀'); assert.equal(current.fields.address.committed, '123 Synthetic Street'); assert.ok(current.fields.name.trustedInputs > 0 && current.fields.name.blurs > 0); assert.ok(current.fields.address.trustedInputs > 0 && current.fields.address.blurs > 0); });
  await fill('Preferred Name', 'Replacement'); await commit(); current = await state();
  check('fill replaces existing input rather than appending', () => assert.equal(current.fields.name.committed, 'Replacement'));
  await fill('Preferred Name', ''); await commit(); current = await state();
  check('empty fill clears with trusted input and application commit', () => assert.equal(current.fields.name.committed, ''));
  await fill('Notes', 'Line1\n東京🚀'); await commit(); current = await state();
  check('textarea replacement and Unicode newlines commit through trusted input', () => assert.equal(current.fields.notes.committed, 'Line1\n東京🚀'));
  await fill('Email', 'new@example.test'); await fill('Number', '456'); await commit(); current = await state();
  check('email and numeric text inputs replace existing values', () => { assert.equal(current.fields.email.committed, 'new@example.test'); assert.equal(current.fields.number.committed, '456'); });
  await fill('Rich text', 'Rich replacement'); await commit(); current = await state();
  check('contenteditable trusted replacement remains supported', () => assert.equal(current.fields.rich.committed, 'Rich replacement'));
  await fill('Rich text', ''); await commit(); current = await state();
  check('contenteditable empty replacement uses trusted deletion', () => assert.equal(current.fields.rich.committed, ''));
  for (const name of ['Read only', 'Disabled']) { await fresh(); const target = ref(name); await assert.rejects(driver.perform({ action: 'fill', tabId: tab.id, ref: target, text: 'must not write', expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId }), /read only|disabled/); }
  const protectedValues = await wc.executeJavaScript(`['readonly','disabled'].map(id=>({value:document.getElementById(id).value,trustedInputs:fixture.fields[id].trustedInputs}))`);
  check('readonly and disabled controls preserve original values', () => assert.deepEqual(protectedValues, [{ value: 'preserve', trustedInputs: 0 }, { value: 'preserve', trustedInputs: 0 }]));
  await fresh(); const stale = { expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId + '-stale' };
  await assert.rejects(driver.perform({ action: 'fill', tabId: tab.id, ref: ref('Address'), text: 'must not write', ...stale }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' }); report.checks.push('stale document guard rejects before input');
  await fill('Frame field', 'Frame 東京🚀'); await fill('Address', 'Main remains separate');
  const child = wc.mainFrame.framesInSubtree.find(frame => frame !== wc.mainFrame && frame.url.includes('/frame')); assert.ok(child);
  const childState = await child.executeJavaScript('({field:structuredClone(window.fixture.fields.name),raw:document.getElementById("name").value})');
  check('cross-origin iframe fill reaches its own trusted application state', () => { assert.equal(childState.raw, 'Frame 東京🚀'); assert.equal(childState.field.committed, 'Frame 東京🚀'); assert.ok(childState.field.trustedInputs > 0); });
  report.frameProcesses = { main: wc.mainFrame.processId, child: child.processId, crossProcess: wc.mainFrame.processId !== child.processId };
  await fresh(); await assert.rejects(driver.perform({ action: 'fill', tabId: tab.id, ref: ref('Redirect on select'), text: 'must not reach another field', expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId }), /lost focus/);
  const redirected = await wc.executeJavaScript(`({raw:document.getElementById('redirect').value,address:document.getElementById('address').value})`);
  check('selection key focus redirection cannot send replacement into another field', () => { assert.equal(redirected.raw, 'preserve'); assert.equal(redirected.address, 'Main remains separate'); });
  await fresh(); await assert.rejects(driver.perform({ action: 'fill', tabId: tab.id, ref: ref('Navigate on focus'), text: 'must not follow navigation' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  const navigated = await wc.executeJavaScript('document.getElementById("navigate").value');
  check('ref-only fill captures identity and stops if focus navigates the document', () => assert.equal(navigated, 'preserve'));
  check('contained browser never opens or focuses an OS window', () => { assert.equal(tab.window.isVisible(), false); assert.equal(tab.window.isFocusable(), false); assert.equal(tab.window.isFocused(), false); });
  report.ok = true;
}
const watchdog = setTimeout(() => { report.error = 'Owned fixture exceeded its deadline'; void finish(1); }, 90000);
let finished = false;
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  try { await driver?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); }
  catch { report.cleanupError = true; code = 1; }
  report.closedWindows = BrowserWindow.getAllWindows().length === 0;
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit(code);
}
main().then(() => finish(0), error => { report.error = error.message; report.stack = error.stack; return finish(1); });
