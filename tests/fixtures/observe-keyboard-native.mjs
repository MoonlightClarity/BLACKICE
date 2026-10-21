/** Native acceptance: real public Activity UI and HTTP API, owned loopback sign-in pages only. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, session } from 'electron';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessServer } from '../../server.mjs';
import { BrowserWorkspace } from '../../lib/browser.mjs';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
import { BrowserRouter } from '../../desktop/browser-router.mjs';
import { appFingerprint } from '../../scripts/release-check.mjs';
import { RemoteAccessManager } from '../../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './remote-transport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const values = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--profile-dir', '--out', '--receipt', '--nonce', '--display'].includes(args[i]) && args[i + 1], 'Use the four fixture arguments and optional --display hidden|visible.');
  assert.equal(values[args[i]], undefined); values[args[i]] = args[i + 1];
}
const profile = values['--profile-dir'], out = values['--out'], receipt = values['--receipt'], nonce = values['--nonce'];
const displayMode = values['--display'] || 'hidden', visibleUI = displayMode === 'visible';
assert.ok(['hidden', 'visible'].includes(displayMode), 'Only the owned fixture app window may be shown explicitly.');
assert.equal(process.platform, 'win32'); assert.ok([profile, out, receipt].every(value => typeof value === 'string' && path.isAbsolute(value)));
assert.match(nonce, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
assert.equal(profile, path.join(out, 'owned-profile-' + nonce)); assert.equal(receipt, path.join(out, 'native-observe-keyboard-result-' + nonce + '.json'));
assert.ok(!existsSync(profile) && !existsSync(receipt), 'The fixture requires a new profile and receipt.');
assert.ok(path.relative(ROOT, out).startsWith('..' + path.sep), 'Acceptance artifacts must be outside the candidate.');
mkdirSync(out, { recursive: true }); mkdirSync(profile); app.setPath('userData', profile); assert.equal(app.requestSingleInstanceLock(), true);
const resolverRules = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
app.commandLine.appendSwitch('host-resolver-rules', resolverRules); app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { schema: 1, fixture: 'observe-keyboard-native', nonce, candidate: ROOT, profile, pid: process.pid, platform: process.platform, electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome, startedAt: new Date().toISOString(), passed: false, checks: [], errors: [], evidence: [], providerTurnsRequested: 0, externalAccountsTested: false, cleanup: false, forcedCleanup: false, sourceUnchanged: false, profileRemoved: false, inputMethod: 'Trusted Chromium keyboard and pointer protocol; owned synthetic Unicode paste; no operating-system input', displayMode, focusMethod: visibleUI ? 'Native focus on the explicitly requested owned app window' : 'Chromium focus emulation on a hidden offscreen app window', networkPolicy: { loopbackOnly: true, resolverRules }, foregroundEvents: [] };
const progress = path.join(out, 'native-observe-keyboard-progress-' + nonce + '.json');
const SOURCE_FILES = ['server.mjs', 'lib/browser.mjs', 'desktop/browser-driver.mjs', 'desktop/browser-router.mjs', 'desktop/browser-capture.mjs', 'public/app.js', 'public/configure-ui.mjs', 'public/chatgpt-connector-ui.mjs', 'public/mission-ui.mjs', 'public/mission-model.mjs', 'public/model-picker.mjs', 'public/model-routes.mjs', 'public/observe-ui.mjs', 'public/observe-model.mjs', 'public/observe.css', 'tests/fixtures/observe-keyboard-native.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex')])));
let driver, browser, harness, fixtureServer, ui, origin, fixtureOrigin, holdNext, activeGate, failNextPreview = false;
const externalOpens = [];
const actions = [], pendingActions = new Set(), fixtureClients = new Set(), served = { signin: 0, oauth: 0, progress: 0, submissions: 0, continues: 0, unexpected: 0 };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const lateRedirect = defer();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function checkpoint(stage) { report.stage = stage; report.updatedAt = new Date().toISOString(); writeFileSync(progress, JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify({ stage, checks: report.checks.length }) + '\n'); }
function check(name, condition, detail) { assert.ok(condition, name); assert.ok(!report.checks.includes(name), 'Check names must be unique.'); report.checks.push(name); if (detail) report.evidence.push({ check: name, detail }); checkpoint(name); }
async function bounded(name, work, ms = 12000) { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(name + ' timed out after ' + ms + ' ms.')), ms); })]); } finally { clearTimeout(timer); } }
async function until(name, predicate, ms = 10000) { const deadline = Date.now() + ms; do { if (await predicate()) return; await delay(30); } while (Date.now() < deadline); throw Error(name + ' did not settle.'); }
const evaluate = source => bounded('owned app renderer evaluation', ui.webContents.executeJavaScript(source), 6000);
const inspect = (tabId, source) => bounded('owned sign-in renderer inspection', driver.tabs.get(tabId).window.webContents.executeJavaScript(source), 6000);
const state = tabId => inspect(tabId, '({email:document.querySelector("#email")?.value,password:document.querySelector("#password")?.value,passwordType:document.querySelector("#password")?.type,active:document.activeElement.id,submits:globalThis.qaSubmits,stage:globalThis.qaStage,url:location.href})');
const cdp = (method, parameters) => bounded('app input ' + method, ui.webContents.debugger.sendCommand(method, parameters), 6000);
async function pointer(x, y) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
async function click(selector) {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.disabled)throw Error('Owned UI control unavailable: '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); if(!r.width||!r.height)throw Error('Owned UI control hidden'); const point={x:r.x+r.width/2,y:r.y+r.height/2};globalThis.qaAddressRecord?.({type:'aim',target:el,clientX:point.x,clientY:point.y}); return point; })()`);
  await pointer(point.x, point.y);
}
async function addressDiagnostics(label, { start = false, stop = false } = {}) {
  const value = await evaluate(`(() => {
    const describe=node=>node?{tag:node.tagName,id:node.id,action:node.dataset?.observeBrowser,connected:node.isConnected}:null,rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom}};
    if(${start}){
      globalThis.qaAddressEvents=[];globalThis.qaAddressOriginalInput=document.querySelector('#observe-browser-url');globalThis.qaAddressOriginalSummary=document.querySelector('#observe-browser-tools > summary');
      globalThis.qaAddressRecord=event=>{if(qaAddressEvents.length>=100)return;const hit=Number.isFinite(event.clientX)?document.elementFromPoint(event.clientX,event.clientY):null;qaAddressEvents.push({type:event.type,time:performance.now(),target:describe(event.target),related:describe(event.relatedTarget),active:describe(document.activeElement),x:event.clientX,y:event.clientY,hit:describe(hit),toolsOpen:document.querySelector('#observe-browser-tools')?.open,busy:document.querySelector('#observe-browser')?.getAttribute('aria-busy'),originalInputConnected:qaAddressOriginalInput.isConnected,originalSummaryConnected:qaAddressOriginalSummary.isConnected});};
      for(const name of ['pointerdown','pointerup','click','focusin','focusout','keydown'])document.addEventListener(name,qaAddressRecord,true);
    }
    const input=document.querySelector('#observe-browser-url'),r=rect(input),summary=document.querySelector('#observe-browser-tools > summary'),value=input?.value||'',hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;
    const result={label:${JSON.stringify(label)},active:describe(document.activeElement),width:innerWidth,height:innerHeight,rootScroll:document.scrollingElement?.scrollTop,activityScroll:document.querySelector('#observe-workspace .observe-scroll')?.scrollTop,toolsOpen:document.querySelector('#observe-browser-tools')?.open,addressRect:r,summaryRect:rect(summary),centerHit:describe(hit),addressHittable:hit===input,addressVisible:input?.checkVisibility?.({visibilityProperty:true}),value:value.length<=512?value:null,valueLength:value.length,busy:document.querySelector('#observe-browser')?.getAttribute('aria-busy'),events:[...(globalThis.qaAddressEvents||[])]};
    if(${stop}&&globalThis.qaAddressRecord){for(const name of ['pointerdown','pointerup','click','focusin','focusout','keydown'])document.removeEventListener(name,qaAddressRecord,true);globalThis.qaAddressRecord=null;}
    return result;
  })()`);
  (report.addressTransition ||= []).push(value); return value;
}
async function localClickAcrossPreview(selector, label) {
  const gate = gateNext('screenshot', 'capture');
  let point, releaseNeeded = false;
  try {
    await bounded(label + ' preview capture entered', gate.entered.promise);
    const frame = actions.filter(entry => entry.action === 'screenshot').at(-1);
    point = await evaluate(`(() => {const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2};if(document.elementFromPoint(point.x,point.y)!==target)throw Error('Owned local pointer target is not hittable');globalThis.qaLocalPointerTarget=target;globalThis.qaAddressRecord?.({type:'aim',target,clientX:point.x,clientY:point.y});return point;})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    releaseNeeded = true;
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    assert.equal(browser.status().busy, true, 'The local mouse press must begin during the held preview capture.');
    await addressDiagnostics(label + ' pressed during the held preview');
    gate.release.resolve();
    await until(label + ' preview completes before mouse release', async () => frame.completedAt && pendingActions.size === 0 && await evaluate('document.querySelector("#observe-browser").getAttribute("aria-busy")==="false"'));
    const retainedBeforeRelease = await evaluate(`globalThis.qaLocalPointerTarget.isConnected && globalThis.qaLocalPointerTarget===document.querySelector(${JSON.stringify(selector)})`);
    await addressDiagnostics(label + ' after preview completion, before mouse release');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    releaseNeeded = false;
    const after = await addressDiagnostics(label + ' after the single mouse release');
    const result = { selector, retainedBeforeRelease, after };
    (report.localPointerRefresh ||= []).push(result); return result;
  } finally {
    gate.release.resolve();
    if (releaseNeeded) await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }).catch(() => {});
  }
}
const keyCodes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 46, Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39 };
const punctuationKeys = { ' ': ['Space', 32], '.': ['Period', 190], ',': ['Comma', 188], '/': ['Slash', 191], ':': ['Semicolon', 186, true], ';': ['Semicolon', 186], '-': ['Minus', 189], '_': ['Minus', 189, true], '=': ['Equal', 187], '+': ['Equal', 187, true], '!': ['Digit1', 49, true], '@': ['Digit2', 50, true], '#': ['Digit3', 51, true], '$': ['Digit4', 52, true], '%': ['Digit5', 53, true], '^': ['Digit6', 54, true], '&': ['Digit7', 55, true], '*': ['Digit8', 56, true], '(': ['Digit9', 57, true], ')': ['Digit0', 48, true] };
async function key(key, { control = false, shift = false, text } = {}) {
  const printable = key.length === 1;
  const physical = punctuationKeys[key] || (/^[a-z]$/i.test(key) ? ['Key' + key.toUpperCase(), key.toUpperCase().charCodeAt(0), key !== key.toLowerCase()] : /^\d$/.test(key) ? ['Digit' + key, key.charCodeAt(0)] : [key, keyCodes[key]]);
  assert.ok(physical[1], 'Owned keyboard fixture requires a real Windows virtual key mapping for ' + key);
  const modifiers = (control ? 2 : 0) | (shift || physical[2] ? 8 : 0);
  const value = { key, code: physical[0], windowsVirtualKeyCode: physical[1], modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...value, ...(text !== undefined || printable && !control ? { text: text ?? key, unmodifiedText: text ?? key } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...value });
}
async function type(text) { for (const character of text) await key(character); }
async function waitField(tabId, field, expected) { await until('contained ' + field + ' value', async () => (await state(tabId))[field] === expected); }
async function readyPreview(tabId) {
  await until('public Observe screenshot', () => evaluate(`(() => { const tab=document.querySelector('[data-observe-browser="tab"][data-tab-id=${JSON.stringify(tabId)}]'), image=document.querySelector('#observe-browser-image'), point=document.querySelector('[data-observe-browser="point"]'); return tab?.getAttribute('aria-selected')==='true' && image?.complete && image.naturalWidth>0 && point && !point.disabled; })()`), 18000);
}
async function currentPreview(tabId, url, after = 0) {
  const urlHash = createHash('sha256').update(url).digest('hex');
  await until('automatic preview of the current login step', async () => {
    const frame = actions.filter(entry => entry.action === 'screenshot' && entry.tabId === tabId && entry.startedAt >= after && entry.completedAt && entry.urlHash === urlHash).at(-1);
    if (!frame?.imageSha256) return false;
    const displayed = await evaluate(`(() => { const image=document.querySelector('#observe-browser-image'),point=document.querySelector('[data-observe-browser="point"]'); return image?.complete && image.naturalWidth && point && !point.disabled ? image.src : ''; })()`);
    return displayed && createHash('sha256').update(displayed).digest('hex') === frame.imageSha256;
  }, 18000);
  await readyPreview(tabId);
}
async function fieldPoint(tabId, field, { scroll = true } = {}) {
  await readyPreview(tabId);
  const point = await inspect(tabId, `(() => { const r=document.querySelector(${JSON.stringify('#' + field)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}; })()`);
  const shown = await evaluate(`(() => { const image=document.querySelector('#observe-browser-image'); if(${scroll})image.scrollIntoView({block:'nearest'}); const r=image.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  return { x: shown.x + point.x * shown.width / point.width, y: shown.y + point.y * shown.height / point.height };
}
async function clickField(tabId, field, options) {
  const point = await fieldPoint(tabId, field, options);
  await pointer(point.x, point.y);
  await until('preview keyboard capture', () => evaluate('document.activeElement?.id === "observe-browser-input"'));
}
function gateNext(action, phase = 'after') { assert.equal(holdNext, undefined); const gate = { action, phase, entered: defer(), release: defer() }; holdNext = gate; activeGate = gate; return gate; }
async function settled() { await until('input requests settled', () => pendingActions.size === 0); await delay(150); }
async function inputViewport(label) {
  const value = await evaluate(`(async () => {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}},image=document.querySelector('#observe-browser-image'),proxy=document.querySelector('#observe-browser-input'),ancestors=[];
    for(let node=image?.parentElement;node;node=node.parentElement)ancestors.push({tag:node.tagName,id:node.id,classes:node.className,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,rect:rect(node)});
    const css=proxy?getComputedStyle(proxy):null;
    return {width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,documentHasFocus:document.hasFocus(),visibilityState:document.visibilityState,visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft,pageTop:visualViewport.pageTop,pageLeft:visualViewport.pageLeft,scale:visualViewport.scale}:null,documentScrollTop:document.scrollingElement?.scrollTop,documentScrollLeft:document.scrollingElement?.scrollLeft,activeElement:document.activeElement?.id,image:rect(image),heading:rect(document.querySelector('.observe-browser-heading')),app:rect(document.querySelector('#app')),proxy:rect(proxy),proxyStyle:css?{position:css.position,top:css.top,left:css.left,minHeight:css.minHeight,maxHeight:css.maxHeight,padding:css.padding,borderWidth:css.borderWidth,fontSize:css.fontSize,lineHeight:css.lineHeight}:null,ancestors};
  })()`);
  const record = { label, ...value, nativeWindow: { visible: ui.isVisible(), focused: ui.isFocused(), focusable: ui.isFocusable(), offscreen: ui.webContents.isOffscreen(), bounds: ui.getBounds(), contentBounds: ui.getContentBounds() } }; (report.inputViewports ||= []).push(record); return record;
}
async function checkInputViewport(name, before, { requireHeading = true } = {}) {
  const after = await inputViewport(name), close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1;
  after.criteria = {
    viewportUnchanged: close(after.width, before.width) && close(after.height, before.height),
    rootScrollUnchanged: ['scrollX', 'scrollY', 'documentScrollTop', 'documentScrollLeft'].every(key => close(after[key], before[key])),
    ancestorScrollUnchanged: after.ancestors.length === before.ancestors.length && after.ancestors.every((node, index) => node.tag === before.ancestors[index].tag && node.id === before.ancestors[index].id && close(node.scrollTop, before.ancestors[index].scrollTop) && close(node.scrollLeft, before.ancestors[index].scrollLeft)),
    previewUnmoved: after.image && before.image && ['x', 'y', 'width', 'height'].every(key => close(after.image[key], before.image[key])),
    headingUnmoved: after.heading && before.heading && ['top', 'bottom'].every(key => close(after.heading[key], before.heading[key])),
    headingVisible: !requireHeading || after.heading?.top >= 0 && after.heading?.bottom < after.height,
    captureRetained: after.activeElement === 'observe-browser-input',
    nativeFocusRetained: !visibleUI || after.documentHasFocus && after.visibilityState === 'visible' && after.nativeWindow.visible && after.nativeWindow.focused && !after.nativeWindow.offscreen
  };
  if (!Object.values(after.criteria).every(Boolean)) {
    const filename = 'observe-keyboard-viewport-failure.png';
    await fs.writeFile(path.join(out, filename), (await bounded('failed typing viewport screenshot', ui.webContents.capturePage(), 6000)).toPNG());
    report.viewportFailureScreenshot = filename; checkpoint('recorded viewport disruption after native input');
  }
  check(name, Object.values(after.criteria).every(Boolean), { before: before.label, after: after.label, criteria: after.criteria });
}
function signin(label) { return `<!doctype html><html><head><meta charset="utf-8"><title>Owned sign-in ${label}</title><style>body{font:20px system-ui;margin:36px;background:#f6f8ff;color:#10172a}label{display:block;margin:24px 0 8px}input{display:block;width:390px;height:42px;font:20px system-ui;padding:6px}button{margin-top:24px;padding:10px}p{font-size:14px}</style></head><body><h1>Owned sign-in ${label}</h1><p>Disposable keyboard acceptance. No account or network sign-in.</p><form><label for="email">Email</label><input id="email" name="email" type="text" inputmode="email" autocomplete="off" spellcheck="false"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off"><button type="submit">Local continue</button></form><script>globalThis.qaSubmits=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();globalThis.qaSubmits++});</script></body></html>`; }
function progressingSignIn(step) {
  const field = (id, label, type = 'text') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" autocomplete="off"><button id="next" type="submit">Next</button>`;
  const content = step === 'start' ? field('email', 'Owned email') : step === 'verify' ? field('email', 'Owned verification value') : '<p>Loading the password field…</p>';
  const script = step === 'password'
    ? `setTimeout(()=>{document.querySelector('form').innerHTML=${JSON.stringify(field('password', 'Owned password', 'password'))};qaStage='password'},400);document.querySelector('form').onsubmit=e=>{e.preventDefault();qaSubmits++;qaStage='redirect-pending';fetch('/signin/progress/continue').then(response=>{if(response.ok)location.assign('/signin/progress/verify')})};`
    : step === 'verify' ? `document.querySelector('form').onsubmit=e=>{e.preventDefault();qaSubmits++;qaStage='loading-confirmation';setTimeout(()=>{document.querySelector('form').innerHTML=${JSON.stringify(field('email', 'Owned confirmation note'))};qaStage='confirmation'},400)};` : '';
  const interactions = step === 'verify' ? `<section style="margin-top:28px"><button id="native-dialog" type="button" onclick="qaDialogCount++;qaDialogResult=confirm('Owned native confirmation')">Owned confirmation</button><input id="native-file" type="file" hidden style="display:none"><button id="native-file-button" type="button" onclick="qaFileClicks++;document.querySelector('#native-file').click()">Choose owned upload</button></section>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Owned login progression ${step}</title><style>body{font:20px system-ui;margin:36px;background:#edf7f2;color:#10172a}form{margin-top:${step === 'password' ? 130 : 50}px}label,input{display:block;margin:12px 0}input{width:390px;height:42px;font:20px system-ui;padding:6px}button{padding:10px}</style></head><body><h1>Owned login progression</h1><p>Disposable localhost forms. No external account.</p><form method="post" action="/signin/progress/submit">${content}</form>${interactions}<script>globalThis.qaSubmits=0;globalThis.qaDialogCount=0;globalThis.qaFileClicks=0;globalThis.qaStage=${JSON.stringify(step === 'password' ? 'loading-password' : step)};${script}</script></body></html>`;
}
function disabledControllers() {
  const runtime = new EventEmitter(); runtime.status = () => ({ connected: false, authenticated: false, models: [{ id: 'chatgpt::chat-mode', model: 'chatgpt::chat-mode', displayName: 'ChatGPT Chat Mode', providerId: 'chatgpt', providerType: 'browser', experimental: true, available: false, supportsTools: false, supportsImages: false, supportsReasoningSelection: false, routeState: 'sign-in-required', setupAction: 'chat-mode' }], providers: [], activeTurns: 0 }); runtime.init = async () => {}; runtime.start = async () => runtime.status(); runtime.close = async () => {};
  runtime.runAgent = async () => { report.providerTurnsRequested++; throw Error('This acceptance fixture must not request a provider turn.'); };
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false, busy: false }); desktop.setEnabled = async () => desktop.status();
  const applicationWorkspace = new EventEmitter(); applicationWorkspace.status = () => ({ available: false, sessions: [], documents: [], supportedApps: [], documentStorage: { healthy: true } }); applicationWorkspace.close = async () => {};
  return { runtime, desktop, applicationWorkspace };
}
// Dependency injection matches the HTTP fixture: only the returned setup tab
// is synthetic. The model picker, setup request, app handoff and page UI are real.
class OwnedChatMode {
  constructor(tabId) { this.tabId = tabId; this.calls = []; }
  async init() { return this; }
  status() { return { available: true, experimental: true, state: 'sign-in-required', ready: false, providerTransportVerified: false, message: 'Sign in on the owned local acceptance page.' }; }
  async openSetup() { this.calls.push('setup'); return { status: this.status(), tabId: this.tabId }; }
  async refresh() { this.calls.push('refresh'); return this.status(); }
  async close() { this.closed = true; }
}
app.on('browser-window-created', (_event, window) => { for (const name of ['show', 'focus']) window.on(name, () => report.foregroundEvents.push({ windowId: window.id, name })); });

async function run() {
  try {
    checkpoint('binding candidate and starting isolated servers');
    report.sourceHashesBefore = await sourceHashes(); report.sourceFingerprintBefore = report.appFingerprintBefore = await appFingerprint(ROOT); report.version = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
    fixtureServer = http.createServer((req, res) => {
      fixtureClients.add(req.socket.remoteAddress);
      const requested = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && requested.pathname === '/signin/progress/submit') {
        let bytes = 0; req.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) req.destroy(); });
        req.on('end', () => { served.submissions++; res.writeHead(303, { Location: '/signin/progress/redirect', 'Cache-Control': 'no-store' }); res.end(); }); return;
      }
      if (req.method === 'GET' && requested.pathname === '/signin/progress/continue') {
        served.continues++; void bounded('owned late navigation release', lateRedirect.promise, 10000).then(() => { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); }, () => { res.writeHead(504); res.end(); }); return;
      }
      if (req.method === 'GET' && requested.pathname === '/signin/progress/redirect') { served.progress++; res.writeHead(302, { Location: '/signin/progress/password', 'Cache-Control': 'no-store' }); return res.end(); }
      if (req.method === 'GET' && /^\/signin\/progress\/(start|password|verify)$/.test(requested.pathname)) {
        served.progress++; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; connect-src 'self'" }); return res.end(progressingSignIn(requested.pathname.split('/').at(-1)));
      }
      if (req.method === 'GET' && /^\/signin\/(a|b|replaced)$/.test(requested.pathname)) { served.signin++; if (requested.search.length >= 10000) served.oauth++; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'" }); return res.end(signin(requested.pathname.split('/').at(-1))); }
      if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); } served.unexpected++; res.writeHead(404); res.end();
    });
    await bounded('owned sign-in server startup', new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve); })); fixtureOrigin = 'http://127.0.0.1:' + fixtureServer.address().port;
    driver = new ElectronBrowserDriver({ dataDir: profile, downloadDir: path.join(profile, 'downloads') }); await bounded('contained driver initialization', driver.init(), 20000); await driver.session.setProxy({ mode: 'direct' });
    browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }) });
    const perform = browser.perform.bind(browser);
    browser.perform = (args, options) => {
      const entry = { action: args.action, tabId: args.tabId, browser: args.browser, expectedUrl: args.expectedUrl, expectedDocumentId: args.expectedDocumentId, key: args.key, modifiers: args.modifiers, textLength: typeof args.text === 'string' ? args.text.length : undefined, startedAt: Date.now() };
      actions.push(entry); const gate = holdNext?.action === args.action ? holdNext : undefined; if (gate) holdNext = undefined;
      const operation = (async () => {
        if (args.action === 'screenshot' && failNextPreview) { failNextPreview = false; entry.injectedPreviewFailure = true; entry.completedAt = Date.now(); throw Error('Owned temporary renderer preview failure.'); }
        if (gate?.phase === 'before') { gate.entered.resolve(); await bounded('owned delayed request', gate.release.promise, 10000); }
        const originalCDP = driver.cdp, originalCapture = driver.capture;
        if (gate?.phase === 'driver') driver.cdp = async function (...parameters) {
          const result = await originalCDP.apply(this, parameters);
          if (parameters[1] === 'Input.insertText') { gate.entered.resolve(); await bounded('owned delayed native input receipt', gate.release.promise, 10000); }
          return result;
        };
        if (gate?.phase === 'capture') driver.capture = async function (...parameters) {
          const result = await originalCapture.apply(this, parameters); gate.entered.resolve(); await bounded('owned delayed screenshot receipt', gate.release.promise, 10000); return result;
        };
        let result; try { result = await perform(args, options); } finally { if (gate?.phase === 'driver') driver.cdp = originalCDP; if (gate?.phase === 'capture') driver.capture = originalCapture; }
        entry.completedAt = Date.now(); entry.documentId = result?.documentId;
        if (typeof result?.url === 'string') entry.urlHash = createHash('sha256').update(result.url).digest('hex');
        if (typeof result?.imageUrl === 'string') entry.imageSha256 = createHash('sha256').update(result.imageUrl).digest('hex');
        if (gate?.phase === 'after') { gate.entered.resolve(); await bounded('owned delayed response', gate.release.promise, 10000); } return result;
      })();
      pendingActions.add(operation); operation.then(() => pendingActions.delete(operation), () => pendingActions.delete(operation)); return operation;
    };
    const oauthUrl = fixtureOrigin + '/signin/a?client_id=owned-keyboard-fixture&response_type=code&redirect_uri=' + encodeURIComponent(fixtureOrigin + '/signin/replaced') + '&scope=openid%20email&state=' + 'owned-local-state-'.repeat(600);
    assert.ok(new URL(oauthUrl).search.length >= 10000 && oauthUrl.length < 14000); report.ownedOAuthUrlLength = oauthUrl.length;
    const first = await browser.perform({ action: 'open', browser: 'relay', url: oauthUrl }, { source: 'user' });
    const second = await browser.perform({ action: 'open', browser: 'relay', url: fixtureOrigin + '/signin/b' }, { source: 'user' });
    const a = first.tabId, b = second.tabId; report.fixtureTabs = [a, b];
    const chatMode = new OwnedChatMode(a);
    const remoteFixture = createRemoteTransportFixture({ hostname: 'native-onboarding.tailtest.ts.net', config: {} });
    const remoteAccess = new RemoteAccessManager({ dataDir: path.join(profile, 'harness'), transport: remoteFixture.transport, defaultHttpsPort: 8443 });
    harness = await createHarnessServer({ port: 0, dataDir: path.join(profile, 'harness'), defaultCwd: path.join(profile, 'workspace'), remoteAccess, autoAttachDesktop: false, emailExecutableHint: '', browser, chatMode, openExternal: async url => { externalOpens.push(url); }, ...disabledControllers() }); origin = await harness.listen();
    const uiSession = session.fromPartition('persist:observe-keyboard-ui-' + nonce); await uiSession.setProxy({ mode: 'direct' });
    uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const uploadPath = path.join(profile, 'owned-upload.txt'), uploadText = 'Owned native file chooser acceptance.\n', pickerPreload = path.join(profile, 'owned-picker-preload.cjs');
    await fs.writeFile(uploadPath, uploadText);
    await fs.writeFile(pickerPreload, `const {contextBridge}=require('electron');let calls=0;contextBridge.exposeInMainWorld('relayDesktop',{pickFiles:async()=>{calls++;return [${JSON.stringify(uploadPath)}]},fixturePickerCalls:()=>calls});\n`);
    ui = new BrowserWindow({ width: 1450, height: 900, useContentSize: true, show: false, focusable: visibleUI, skipTaskbar: true, frame: false, webPreferences: { session: uiSession, preload: pickerPreload, offscreen: !visibleUI, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true, paintWhenInitiallyHidden: true } });
    ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); ui.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    await bounded('real public app load', ui.loadURL(origin), 20000); ui.webContents.debugger.attach('1.3'); await cdp('Emulation.setFocusEmulationEnabled', { enabled: !visibleUI });
    if (visibleUI) {
      ui.show(); ui.focus(); ui.webContents.focus();
      await until('explicitly requested owned app has real native focus', async () => ui.isVisible() && ui.isFocused() && await evaluate('document.hasFocus() && document.visibilityState==="visible"'));
    }
    await until('public workspace navigation', () => evaluate('Boolean(document.querySelector("[data-mode=observe]"))'), 15000);
    await evaluate('globalThis.qaKeys=[];document.addEventListener("keydown",e=>qaKeys.push({trusted:e.isTrusted,target:e.target.id,key:e.key}),true)');
    await until('real Chat model picker', () => evaluate('Boolean(document.querySelector(".conversation-model-choice .model-picker-button"))'));
    await click('.conversation-model-choice .model-picker-button');
    await until('Chat Mode model route', () => evaluate(`Boolean(document.querySelector(${JSON.stringify('.model-picker-panel:not([hidden]) .model-picker-option[data-model-value="chatgpt::chat-mode"]')}))`));
    await click('.model-picker-panel:not([hidden]) .model-picker-option[data-model-value="chatgpt::chat-mode"]'); await readyPreview(a);
    await until('focused Chat Mode entry', () => evaluate('document.querySelector("#observe-workspace").classList.contains("observe-page-focus") && document.activeElement?.dataset?.observeBrowser==="point"'));
    check('The real model picker opens Chat Mode setup on its exact owned contained tab', chatMode.calls.join(',') === 'setup' && await evaluate('document.querySelector("#observe-browser").classList.contains("observe-browser-focused") && [...document.querySelectorAll(".model-picker-panel")].every(panel=>panel.hidden)'));
    check('Real public Activity browser loads both owned sign-in tabs', await evaluate('!document.querySelector("#observe-workspace").hidden && document.querySelectorAll("[data-observe-browser=tab]").length===2'));
    check('Sign-in entry focuses the page and places typing guidance before the image', await evaluate('(() => {const help=document.querySelector("#observe-browser-input-help"),image=document.querySelector("#observe-browser-image"),tools=document.querySelector("#observe-browser-tools");return document.activeElement?.dataset?.observeBrowser==="point" && help?.dataset.active==="false" && help.textContent.includes("Click a field below and type") && Boolean(help.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING) && tools && !tools.open;})()'));
    const localForm = await inspect(a, '(() => {const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},r=rect(document.querySelector("form"));return {left:r.left,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,rect:r,devicePixelRatio,scrollX,scrollY,visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft}:null,fields:["email","password"].map(id=>{const r=rect(document.getElementById(id));return {id,x:r.x+r.width/2,y:r.y+r.height/2,rect:r}})}})()');
    const layout = await evaluate(`(() => {
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},describe=e=>e?{tag:e.tagName,id:e.id,className:typeof e.className==='string'?e.className:''}:null;
      const image=document.querySelector('#observe-browser-image'),r=rect(image),form=${JSON.stringify(localForm)},root=document.querySelector('#observe-workspace'),style=getComputedStyle(image),ancestors=[];
      for(let e=image.parentElement;e&&ancestors.length<10;e=e.parentElement){const css=getComputedStyle(e);ancestors.push({...describe(e),rect:rect(e),scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,scrollHeight:e.scrollHeight,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,clientWidth:e.clientWidth,display:css.display,position:css.position,overflowX:css.overflowX,overflowY:css.overflowY,minWidth:css.minWidth,maxWidth:css.maxWidth});}
      return {width:innerWidth,height:innerHeight,outerWidth,outerHeight,devicePixelRatio,scrollX,scrollY,scroll:root.scrollTop,imageTop:r.top,imageWidth:r.width,formTop:r.top+form.top*r.height/form.height,formBottom:r.top+form.bottom*r.height/form.height,
        visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft}:null,
        image:{rect:r,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,widthAttribute:image.getAttribute('width'),heightAttribute:image.getAttribute('height'),cssWidth:style.width,cssHeight:style.height,objectFit:style.objectFit,display:style.display},point:rect(document.querySelector('[data-observe-browser="point"]')),ancestors,
        fields:form.fields.map(field=>{const x=r.left+field.x*r.width/form.width,y=r.top+field.y*r.height/form.height,hit=document.elementFromPoint(x,y);return {id:field.id,x,y,hittable:Boolean(hit?.closest('[data-observe-browser="point"]')),hit:describe(hit)}})};
    })()`);
    layout.requestedSize = { width: 1450, height: 900 };
    layout.nativeWindow = { bounds: ui.getBounds(), contentBounds: ui.getContentBounds(), contentSize: ui.getContentSize() };
    layout.containedPage = localForm;
    layout.criteria = { availableNativeViewport: layout.width === 1450 && layout.height >= 720 && layout.height <= 900 && Math.abs(layout.width - layout.nativeWindow.contentBounds.width) <= 1 && Math.abs(layout.height - layout.nativeWindow.contentBounds.height) <= 1 && Math.abs(layout.width - layout.nativeWindow.contentSize[0]) <= 1 && Math.abs(layout.height - layout.nativeWindow.contentSize[1]) <= 1, workspaceAtTop: layout.scroll === 0, imageStartsAboveFold: layout.imageTop >= 0 && layout.imageTop < 300, imageWideEnough: layout.imageWidth > 600, formStartsWithinImage: layout.formTop >= layout.imageTop, formEndsAboveFold: layout.formBottom < layout.height, fieldsHittableAboveFold: layout.fields.every(field => field.hittable && field.y > 0 && field.y < layout.height) };
    report.signinLayout = layout;
    const signinEntryImage = await bounded('initial sign-in screenshot', ui.webContents.capturePage(), 6000);
    await fs.writeFile(path.join(out, 'observe-keyboard-signin-entry.png'), signinEntryImage.toPNG()); report.signinEntryScreenshot = 'observe-keyboard-signin-entry.png'; layout.screenshotSize = signinEntryImage.getSize();
    checkpoint('recorded initial sign-in geometry before acceptance');
    check('A ten-thousand-character OAuth-shaped local URL leaves the sign-in form above the fold in the available Windows viewport', Object.values(layout.criteria).every(Boolean), layout);
    check('The full local OAuth address remains exact while the sign-in heading omits its query', await evaluate(`document.querySelector('#observe-browser-url').value===${JSON.stringify(oauthUrl)} && document.querySelector('.observe-browser-page-title').textContent.length<350 && !document.querySelector('.observe-browser-page-title').textContent.includes('state=')`));

    checkpoint('normal typing while the initial preview click is pending');
    const clickGate = gateNext('click', 'before'); await clickField(a, 'email', { scroll: false }); await bounded('held preview click admitted', clickGate.entered.promise);
    const typingViewport = await inputViewport('Focused page before the first native character');
    await key('a'); await checkInputViewport('The first native character preserves the app viewport and visible sign-in heading', typingViewport);
    await type('lpha'); await checkInputViewport('Queued native typing preserves every preview ancestor scroll position', typingViewport);
    check('Native characters wait for the preview click to select the remote field', (await state(a)).email === '' && !actions.some(entry => entry.action === 'type'));
    clickGate.release.resolve(); await waitField(a, 'email', 'alpha'); await settled();
    await checkInputViewport('Settled native typing and preview rendering keep the page in place', typingViewport);
    check('Click then ordinary trusted typing enters the contained email field', (await state(a)).active === 'email');
    check('One field click visibly activates keyboard capture in the focused sign-in page', actions.filter(entry => entry.action === 'click').length === 1 && await evaluate('document.activeElement?.id==="observe-browser-input" && document.querySelector("#observe-browser-input-help").dataset.active==="true" && document.querySelector("#observe-browser-input-help").textContent.includes("Typing goes to this page")'));

    checkpoint('field click and text during the natural post-input preview refresh');
    const initialTypeFinished = actions.filter(entry => entry.action === 'type').at(-1).completedAt;
    await until('initial input preview refresh settled', async () => pendingActions.size === 0 && actions.some(entry => entry.action === 'screenshot' && entry.startedAt >= initialTypeFinished && entry.completedAt) && await evaluate('document.querySelector("#observe-browser").getAttribute("aria-busy")==="false"'));
    await evaluate('globalThis.qaRefreshPoint=document.querySelector("[data-observe-browser=point]")');
    const refreshGate = gateNext('screenshot', 'capture'); await type('r'); await waitField(a, 'email', 'alphar'); await bounded('natural post-input screenshot refresh entered', refreshGate.entered.promise);
    const duringRefresh = actions.filter(entry => ['click', 'type', 'press'].includes(entry.action)).length;
    await clickField(a, 'password', { scroll: false }); await type('during-refresh');
    await checkInputViewport('A field switch and queued text during preview refresh preserve the viewport', typingViewport);
    check('A field click and immediate text queue while the real preview capture is busy', browser.status().busy === true && (await state(a)).email === 'alphar' && (await state(a)).password === '' && actions.filter(entry => ['click', 'type', 'press'].includes(entry.action)).length === duringRefresh && await evaluate('document.querySelector("#observe-browser").getAttribute("aria-busy")==="true" && globalThis.qaRefreshPoint===document.querySelector("[data-observe-browser=point]") && !globalThis.qaRefreshPoint.disabled'));
    refreshGate.release.resolve(); await waitField(a, 'password', 'during-refresh'); await settled();
    check('The queued refresh-time click selects the password field before its text without a second click', (await state(a)).email === 'alphar' && (await state(a)).password === 'during-refresh' && actions.filter(entry => entry.action === 'click').length === 2);
    await key('a', { control: true }); await key('Backspace'); await waitField(a, 'password', ''); await key('Tab', { shift: true }); await type('alpha'); await waitField(a, 'email', 'alpha'); await settled();

    checkpoint('physical field click spanning preview refresh completion');
    const beforeGestureTypeFinished = actions.filter(entry => entry.action === 'type').at(-1).completedAt;
    await until('pre-gesture preview refresh settled', async () => pendingActions.size === 0 && actions.some(entry => entry.action === 'screenshot' && entry.startedAt >= beforeGestureTypeFinished && entry.completedAt) && await evaluate('document.querySelector("#observe-browser").getAttribute("aria-busy")==="false"'));
    await evaluate('globalThis.qaGesturePoint=document.querySelector("[data-observe-browser=point]");globalThis.qaGestureImage=document.querySelector("#observe-browser-image")');
    const gestureGate = gateNext('screenshot', 'capture'); await type('g'); await waitField(a, 'email', 'alphag'); await bounded('gesture screenshot refresh entered', gestureGate.entered.promise);
    const gestureFrame = actions.filter(entry => entry.action === 'screenshot').at(-1), gestureClicks = actions.filter(entry => entry.action === 'click').length;
    const gesturePoint = await fieldPoint(a, 'password', { scroll: false });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...gesturePoint });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...gesturePoint, button: 'left', clickCount: 1 });
    assert.equal(browser.status().busy, true, 'The physical mouse press must begin during the held refresh.');
    gestureGate.release.resolve();
    await until('preview render completes before physical mouse release', async () => gestureFrame.completedAt && pendingActions.size === 0 && await evaluate('document.querySelector("#observe-browser").getAttribute("aria-busy")==="false"'));
    const gestureNodesRetained = await evaluate('globalThis.qaGesturePoint===document.querySelector("[data-observe-browser=point]") && globalThis.qaGestureImage===document.querySelector("#observe-browser-image")');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...gesturePoint, button: 'left', clickCount: 1 });
    await until('capture after refresh-spanning mouse release', () => evaluate('document.activeElement?.id === "observe-browser-input"'));
    await type('spanning-refresh'); await waitField(a, 'password', 'spanning-refresh'); await settled();
    check('A physical field click spanning refresh completion keeps its target and forwards exactly one click before typing', gestureNodesRetained && actions.filter(entry => entry.action === 'click').length === gestureClicks + 1 && (await state(a)).email === 'alphag' && (await state(a)).password === 'spanning-refresh');
    await key('a', { control: true }); await key('Backspace'); await waitField(a, 'password', ''); await key('Tab', { shift: true }); await type('alpha'); await waitField(a, 'email', 'alpha'); await settled();

    await key('Backspace'); await waitField(a, 'email', 'alph');
    await checkInputViewport('Backspace preserves the app viewport while editing the contained field', typingViewport);
    check('Backspace edits the contained field', (await state(a)).email === 'alph');
    await key('a', { control: true }); await type('person@example.test'); await waitField(a, 'email', 'person@example.test');
    await checkInputViewport('Control+A replacement preserves the app viewport', typingViewport);
    check('Control+A replaces the contained field without selecting the local app', (await state(a)).email === 'person@example.test');
    await key('Tab'); await until('Tab enters password', async () => (await state(a)).active === 'password'); await type('OwnedOnly42!'); await waitField(a, 'password', 'OwnedOnly42!'); await settled();
    await checkInputViewport('Tab and masked password typing keep the visible page in place', typingViewport);
    const snapshot = await browser.perform({ action: 'snapshot', browser: 'relay', tabId: a }, { source: 'user' });
    const passwordControl = snapshot.frames.flatMap(frame => frame.elements || []).find(item => item.type === 'password');
    check('Password typing remains masked and absent from snapshots and the local input buffer', (await state(a)).passwordType === 'password' && passwordControl && !Object.hasOwn(passwordControl, 'value') && !JSON.stringify(snapshot).includes('OwnedOnly42!') && await evaluate('document.querySelector("#observe-browser-input").value==="" && !document.body.innerText.includes("OwnedOnly42!")'));
    await key('a', { control: true }); await key('Backspace'); await waitField(a, 'password', '');
    await key('Tab', { shift: true }); await until('Shift+Tab returns to email', async () => (await state(a)).active === 'email');
    await checkInputViewport('Shift+Tab preserves the app viewport and keyboard capture', typingViewport);
    check('Tab and Shift+Tab move focus inside the contained sign-in page', (await state(a)).active === 'email');
    // Chromium selects an input's contents when tabbing into it. Place the
    // caret explicitly for the following append-and-switch ordering check.
    await key('End'); await settled();
    const fieldGate = gateNext('type', 'driver'); await type('x'); await bounded('held email text response admitted', fieldGate.entered.promise);
    await clickField(a, 'password'); await type('OwnedOnly42!');
    check('A password field click and immediate typing wait behind an in-flight email edit', browser.status().busy === true && (await state(a)).email === 'person@example.testx' && (await state(a)).password === '');
    fieldGate.release.resolve(); await waitField(a, 'password', 'OwnedOnly42!'); await settled();
    check('Rapid field switching routes password text only after the password click settles', (await state(a)).email === 'person@example.testx' && (await state(a)).password === 'OwnedOnly42!');
    await key('Enter'); await until('one owned form submission', async () => (await state(a)).submits === 1); await settled();
    check('Enter submits the owned sign-in form exactly once', (await state(a)).submits === 1);
    await key('Tab', { shift: true }); await until('email selected again for paste', async () => (await state(a)).active === 'email');
    await key('a', { control: true }); await settled();
    const pasted = 'Jalapeño 東京 🧊';
    await evaluate(`(() => { const input=document.querySelector('#observe-browser-input'); const data=new DataTransfer(); data.setData('text/plain',${JSON.stringify(pasted)}); return input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})); })()`);
    await waitField(a, 'email', pasted); check('Unicode paste reaches the contained field as literal text', (await state(a)).email === pasted, 'The fixture supplies ClipboardEvent data; it never accesses the operating-system clipboard.');
    await checkInputViewport('Unicode paste preserves the app viewport', typingViewport);

    const typeGate = gateNext('type'); await type('x'); await bounded('held text response admitted', typeGate.entered.promise); await type('yz0123456789');
    await checkInputViewport('Rapid queued keys preserve the viewport while a text receipt is pending', typingViewport);
    check('Rapid keys remain queued while an earlier text response is pending', (await state(a)).email === pasted + 'x'); typeGate.release.resolve(); await waitField(a, 'email', pasted + 'xyz0123456789'); await settled();
    check('Queued rapid keys arrive once in their original order', (await state(a)).email === pasted + 'xyz0123456789');
    await checkInputViewport('Draining rapid keys and refreshing the preview preserve the viewport', typingViewport);

    const beforeAddress = await state(a), inputCount = actions.filter(entry => ['type', 'press'].includes(entry.action)).length;
    await addressDiagnostics('Before opening browser tools', { start: true });
    const summaryGesture = await localClickAcrossPreview('#observe-browser-tools > summary', 'Browser tools summary');
    check('A browser-tools summary click spanning preview completion opens its controls without losing the pressed target', summaryGesture.retainedBeforeRelease && summaryGesture.after.toolsOpen === true);
    const addressGesture = await localClickAcrossPreview('#observe-browser-url', 'Local website address');
    const addressClicked = addressGesture.after;
    assert.equal(addressClicked.active?.id, 'observe-browser-url', 'A native click must focus the visible local address field before typing.');
    check('A local address click spanning preview completion retains native focus without entering page capture', addressGesture.retainedBeforeRelease && addressClicked.active?.id === 'observe-browser-url');
    await key('a', { control: true }); const localAddress = fixtureOrigin + '/kept-local'; await type(localAddress); await settled();
    await addressDiagnostics('After local-address typing', { stop: true });
    check('Typing in the local website address field never reaches the contained page', await evaluate(`document.querySelector('#observe-browser-url').value===${JSON.stringify(localAddress)}`) && (await state(a)).email === beforeAddress.email && (await state(a)).password === beforeAddress.password && actions.filter(entry => ['type', 'press'].includes(entry.action)).length === inputCount);

    await clickField(a, 'email'); await settled(); await key('End'); await settled();
    const switchGate = gateNext('type'); await type('s'); await bounded('held old-tab response admitted', switchGate.entered.promise); await type('discarded'); await click('[data-observe-browser="tab"][data-tab-id="' + b + '"]'); switchGate.release.resolve(); await readyPreview(b); await settled();
    check('Switching browser tabs drops queued keys and never types into the replacement tab', (await state(a)).email === beforeAddress.email + 's' && (await state(b)).email === '' && (await state(b)).password === '');

    // Ordinary Activity uses a full-width, uncapped page. Reveal only the owned
    // field before taking the reference; never rescue scrolling after editing.
    assert.equal(await evaluate('document.querySelector("#observe-workspace").classList.contains("observe-page-focus")'), false);
    let ordinaryPoint = await fieldPoint(b, 'email', { scroll: false });
    const ordinaryPreparation = await evaluate(`(() => {const area=document.querySelector('#observe-workspace .observe-scroll'),point=${JSON.stringify(ordinaryPoint)},before=area.scrollTop;if(point.y<80||point.y>innerHeight-80)area.scrollTop+=point.y-innerHeight/2;return {scrollBefore:before,scrollAfter:area.scrollTop,width:innerWidth,height:innerHeight};})()`);
    ordinaryPoint = await fieldPoint(b, 'email', { scroll: false });
    assert.ok(ordinaryPoint.y > 0 && ordinaryPoint.y < ordinaryPreparation.height, 'The owned ordinary-Activity field must be visible before clicking.');
    report.ordinaryActivityPreparation = ordinaryPreparation;
    const ordinaryBeforeClick = await inputViewport('Ordinary Activity before the visible field click');
    await clickField(b, 'email', { scroll: false }); await settled();
    await checkInputViewport('Clicking a visible field in ordinary Activity preserves the surrounding viewport', ordinaryBeforeClick, { requireHeading: false });
    const ordinaryViewport = await inputViewport('Ordinary Activity before native text');
    await key('a'); await waitField(b, 'email', 'a');
    await checkInputViewport('The first ordinary Activity character preserves the full application viewport', ordinaryViewport, { requireHeading: false });
    await fs.writeFile(path.join(out, 'observe-keyboard-ordinary-typing.png'), (await bounded('ordinary typing viewport screenshot', ui.webContents.capturePage(), 6000)).toPNG()); report.ordinaryTypingScreenshot = 'observe-keyboard-ordinary-typing.png';
    await cdp('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await checkInputViewport('Native Chromium IME composition does not reveal or scroll the hidden proxy', ordinaryViewport, { requireHeading: false });
    assert.equal((await state(b)).email, 'a', 'An unfinished composition must not reach the contained page.');
    await cdp('Input.insertText', { text: '日本語' }); await waitField(b, 'email', 'a日本語');
    await checkInputViewport('A native Chromium IME commit reaches the page once without moving the viewport', ordinaryViewport, { requireHeading: false });
    await key('a', { control: true }); await key('Backspace'); await waitField(b, 'email', ''); await settled();
    const navigationGate = gateNext('type'); await type('n'); await bounded('held pre-navigation response admitted', navigationGate.entered.promise);
    await checkInputViewport('Ordinary Activity native typing preserves root and ancestor scroll with an uncapped preview', ordinaryViewport, { requireHeading: false });
    await type('discarded');
    await checkInputViewport('Ordinary Activity queued typing does not push the application above the viewport', ordinaryViewport, { requireHeading: false });
    const oldDocument = actions.filter(entry => entry.action === 'type' && entry.tabId === b).at(-1).expectedDocumentId;
    const navigated = await browser.perform({ action: 'navigate', browser: 'relay', tabId: b, url: fixtureOrigin + '/signin/replaced' }, { source: 'user' });
    navigationGate.release.resolve(); await until('old page input is stopped or replacement view is observed', () => evaluate(`document.body.innerText.includes('Page input could not be confirmed') || document.querySelector('#observe-browser-url')?.value===${JSON.stringify(fixtureOrigin + '/signin/replaced')}`)); await settled();
    check('Navigation changes the document token and discards input queued for the old page', navigated.documentId !== oldDocument && (await state(b)).email === '' && (await state(b)).password === '');
    await currentPreview(b, fixtureOrigin + '/signin/replaced');

    await clickField(b, 'email'); await settled(); await key('Escape'); const escapedCount = actions.filter(entry => ['type', 'press'].includes(entry.action)).length; await type('released'); await settled();
    check('Escape releases preview typing capture without forwarding later keys', await evaluate('document.activeElement?.id!=="observe-browser-input"') && (await state(b)).email === '' && actions.filter(entry => ['type', 'press'].includes(entry.action)).length === escapedCount);

    checkpoint('exercising automatic multi-step sign-in progression');
    await evaluate('globalThis.qaRefreshClicks=0;document.addEventListener("click",event=>{if(event.target.closest?.("[data-observe-browser=refresh]"))qaRefreshClicks++},true)');
    const startURL = fixtureOrigin + '/signin/progress/start', passwordURL = fixtureOrigin + '/signin/progress/password', verifyURL = fixtureOrigin + '/signin/progress/verify';
    const progressStart = Date.now(); await browser.perform({ action: 'navigate', browser: 'relay', tabId: b, url: startURL }, { source: 'user' });
    await currentPreview(b, startURL, progressStart); await clickField(b, 'email'); await type('owned@example.test'); await waitField(b, 'email', 'owned@example.test'); await settled();
    const submissionActions = actions.length; await key('Enter');
    await until('redirected asynchronous password field', async () => (await state(b)).stage === 'password');
    await currentPreview(b, passwordURL, Date.now());
    check('Enter follows an owned POST and two redirects to an asynchronously mounted password form without Refresh', served.submissions === 1 && actions.slice(submissionActions).filter(entry => entry.action === 'press' && entry.key === 'Enter').length === 1 && (await state(b)).url === passwordURL && await evaluate('qaRefreshClicks===0'));

    await clickField(b, 'password'); failNextPreview = true; await type('ProgressOnly42!'); await waitField(b, 'password', 'ProgressOnly42!');
    await until('owned transient preview failure', () => actions.some(entry => entry.injectedPreviewFailure));
    const failedPreview = actions.find(entry => entry.injectedPreviewFailure);
    await currentPreview(b, passwordURL, failedPreview.completedAt + 1);
    check('A transient preview failure retries only reads and preserves the newly typed password', (await state(b)).password === 'ProgressOnly42!' && served.submissions === 1 && actions.filter(entry => entry.injectedPreviewFailure).length === 1 && await evaluate('qaRefreshClicks===0'));

    const beforeNext = actions.length; await clickField(b, 'next');
    await until('Next action settles before the controlled redirect', () => served.continues === 1 && actions.slice(beforeNext).some(entry => entry.action === 'click' && entry.completedAt));
    const nextReceipt = actions.slice(beforeNext).find(entry => entry.action === 'click'), redirectReleasedAt = Date.now(); lateRedirect.resolve();
    await until('late redirect verification page', async () => (await state(b)).stage === 'verify');
    await currentPreview(b, verifyURL, redirectReleasedAt);
    check('A Next redirect that starts after its click receipt advances automatically to the next form', nextReceipt.completedAt <= redirectReleasedAt && served.continues === 1 && (await state(b)).url === verifyURL && await evaluate('qaRefreshClicks===0'));

    await clickField(b, 'email'); await type('246810'); await waitField(b, 'email', '246810'); await settled();
    const verificationDocument = actions.filter(entry => entry.action === 'type' && entry.tabId === b).at(-1).expectedDocumentId;
    await key('Enter'); await until('same-document confirmation form', async () => (await state(b)).stage === 'confirmation');
    await currentPreview(b, verifyURL, Date.now());
    await clickField(b, 'email'); await type('finished'); await waitField(b, 'email', 'finished'); await settled();
    check('A same-document delayed form becomes visible and accepts ordinary typing without Refresh', (await state(b)).submits === 1 && actions.filter(entry => entry.action === 'type' && entry.tabId === b).at(-1).expectedDocumentId === verificationDocument && await evaluate('qaRefreshClicks===0'));
    check('Automatic progression never replays an Enter submission or the Next action', served.submissions === 1 && served.continues === 1 && actions.slice(submissionActions).filter(entry => entry.action === 'press' && entry.key === 'Enter').length === 2 && actions.slice(beforeNext).filter(entry => entry.action === 'click' && entry.startedAt <= redirectReleasedAt).length === 1);

    const dialogPoint = await fieldPoint(b, 'native-dialog'); await pointer(dialogPoint.x, dialogPoint.y);
    await until('native page dialog handoff', () => evaluate('Boolean(document.querySelector("#observe-browser-interaction [data-decision=acknowledge]"))'));
    const dialog = driver.status().tabs.find(tab => tab.tabId === b)?.pendingInteraction;
    check('A real contained confirmation produces a concrete blocked-dialog handoff without automatic acceptance', dialog?.kind === 'javascript_dialog' && dialog.dialogType === 'confirm' && dialog.status === 'blocked' && dialog.tabId === b && dialog.url === verifyURL && typeof dialog.id === 'string' && typeof dialog.documentId === 'string' && await evaluate('document.querySelector("[data-observe-browser=point]").disabled && !document.querySelector("#observe-browser-interaction [data-decision=accept]")'));
    await click('#observe-browser-interaction [data-decision="acknowledge"]'); await currentPreview(b, verifyURL, Date.now());
    check('Acknowledging the disabled native dialog reports its canceled result without replaying the page click', await inspect(b, 'qaDialogCount===1 && qaDialogResult===false') && !driver.status().tabs.find(tab => tab.tabId === b)?.pendingInteraction);

    const filePoint = await fieldPoint(b, 'native-file-button'); await pointer(filePoint.x, filePoint.y);
    await until('native file chooser handoff', () => evaluate('Boolean(document.querySelector("#observe-browser-interaction [data-decision=upload]:not([disabled])"))'));
    const chooser = driver.status().tabs.find(tab => tab.tabId === b)?.pendingInteraction;
    check('A real contained file chooser waits for explicit selection on its owned document', chooser?.kind === 'file_chooser' && chooser.status === 'pending' && chooser.tabId === b && chooser.url === verifyURL && typeof chooser.id === 'string' && await inspect(b, 'document.querySelector("#native-file").files.length===0 && qaFileClicks===1') && await evaluate('window.relayDesktop.fixturePickerCalls()===0'));
    await click('#observe-browser-interaction [data-decision="upload"]');
    await until('owned selected file assigned', () => inspect(b, 'document.querySelector("#native-file").files.length===1'));
    const uploaded = await inspect(b, '(async()=>{const file=document.querySelector("#native-file").files[0];return {name:file.name,size:file.size,text:await file.text(),clicks:qaFileClicks}})()');
    await currentPreview(b, verifyURL, Date.now());
    check('The explicit desktop picker selection uploads exactly the owned file without an operating-system website picker', uploaded.name === 'owned-upload.txt' && uploaded.size === Buffer.byteLength(uploadText) && uploaded.text === uploadText && uploaded.clicks === 1 && !driver.status().tabs.find(tab => tab.tabId === b)?.pendingInteraction && await evaluate('window.relayDesktop.fixturePickerCalls()===1 && qaRefreshClicks===0'));
    report.evidence.push({ nativeDialog: { id: dialog.id, type: dialog.dialogType, status: dialog.status, observedResult: false, originalInvocations: 1 }, nativeChooser: { id: chooser.id, documentId: chooser.documentId, filename: uploaded.name, bytes: uploaded.size, explicitlyPicked: true, picker: 'Owned fixture callback for the real desktop picker integration', websiteNativePickerOpened: false } });

    await click('[data-mode="view"]'); await type('local'); await settled();
    check('Leaving Activity stops contained keyboard input', await evaluate('document.querySelector("#observe-workspace").hidden') && (await state(b)).email === 'finished' && (await state(a)).email === beforeAddress.email + 's');
    const inputActions = actions.filter(entry => ['type', 'press'].includes(entry.action));
    check('Every forwarded input is bound to the explicit relay tab, URL and document', inputActions.length > 10 && inputActions.every(entry => entry.browser === 'relay' && [a, b].includes(entry.tabId) && entry.expectedUrl?.startsWith(fixtureOrigin + '/signin/') && typeof entry.expectedDocumentId === 'string' && entry.expectedDocumentId.startsWith(entry.tabId + ':')));
    const keyEvidence = await evaluate('({count:qaKeys.length,allTrusted:qaKeys.every(e=>e.trusted),capture:qaKeys.filter(e=>e.target==="observe-browser-input").length})');
    check('Ordinary typing is exercised with trusted Chromium keyboard events', keyEvidence.count > 50 && keyEvidence.capture > 30 && keyEvidence.allTrusted);
    check(visibleUI ? 'Only the explicitly requested owned app window can be visible or focused' : 'All browser and app fixture windows remain hidden and nonfocusable', (visibleUI ? report.foregroundEvents.every(event => event.windowId === ui.id) : report.foregroundEvents.length === 0) && BrowserWindow.getAllWindows().every(window => visibleUI && window === ui || !window.isVisible() && !window.isFocused() && !window.isFocusable() && window.webContents.isOffscreen()));
    check('Only owned loopback pages and local forms were used, with no provider turn', served.signin === 3 && served.oauth === 1 && served.progress === 4 && served.submissions === 1 && served.continues === 1 && served.unexpected === 0 && [...fixtureClients].every(client => client === '127.0.0.1' || client === '::ffff:127.0.0.1') && report.providerTurnsRequested === 0 && chatMode.calls.join(',') === 'setup' && (await state(a)).submits === 1 && (await state(b)).submits === 1);
    report.evidence.push({ keyEvidence, inputActions: inputActions.map(({expectedUrl,...entry})=>({...entry,expectedUrlLength:expectedUrl.length,expectedUrlSha256:createHash('sha256').update(expectedUrl).digest('hex')})), served, chatModeSetupCalls: chatMode.calls.length, clipboardAccess: false, remotePasswordLength: (await state(a)).password.length, nativeWindows: BrowserWindow.getAllWindows().length });
    await click('[data-mode="observe"]'); await readyPreview(b); await fs.writeFile(path.join(out, 'observe-keyboard-native.png'), (await ui.webContents.capturePage()).toPNG()); report.screenshot = 'observe-keyboard-native.png';

    checkpoint('connector system browser setup through the real desktop UI');
    await click('[data-mode="view"]'); await click('#mission-task'); await key('a', { control: true });
    const keptDraft = 'Keep this unsent ChatGPT workspace draft.'; await type(keptDraft);
    await until('owned unsent Chat draft', () => evaluate(`document.querySelector('#mission-task').value===${JSON.stringify(keptDraft)}`)); await settled();
    const panelBefore = await evaluate(`(async()=>{const response=await fetch('/api/status');if(!response.ok)throw Error('Owned status unavailable');const status=await response.json();return {draft:document.querySelector('#mission-task').value,model:document.querySelector('#mission-model').value,defaultModel:status.defaultModel??null,runtimeSettings:status.runtimeSettings};})()`);
    const panelTabs = [...driver.tabs.keys()].sort(), panelSetupCount = chatMode.calls.length, panelActionStart = actions.length, panelRuns = harness.engine.listRuns().length, panelExternalStart = externalOpens.length;
    const pluginUrl = 'https://chatgpt.com/plugins';
    check('The injected system browser opener is explicitly available in connector status', await evaluate(`(async()=>{const response=await fetch('/api/chatgpt-connector');return response.ok && (await response.json()).canOpenChatGPT===true;})()`));
    const notPrepared = await evaluate(`(async()=>{const response=await fetch('/api/chatgpt-connector/open-chatgpt',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return response.status;})()`);
    check('An unprepared computer cannot open ChatGPT setup', notPrepared === 409 && externalOpens.length === panelExternalStart);
    const prepared = await evaluate(`(async()=>{const response=await fetch('/api/chatgpt-connector/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmPublic:true})});if(!response.ok)throw Error('Owned preparation failed');return response.json();})()`);
    check('Explicit preparation makes only this fixture computer ready without issuing a ChatGPT grant', prepared.setup.ready === true && prepared.setup.serverUrl === 'https://native-onboarding.tailtest.ts.net:8443/mcp/chatgpt' && prepared.setup.stage === 'register' && prepared.oauth.grants.length === 0 && prepared.oauth.requests.length === 0 && externalOpens.length === panelExternalStart);
    await click('[data-mode="configure"]');
    await until('system browser ChatGPT setup action', () => evaluate(`(() => {const node=document.querySelector('[data-connector-action="open-chatgpt"]');return node && !node.disabled && node.getAttribute('aria-disabled')!=='true' && node.checkVisibility({visibilityProperty:true});})()`));
    check('Opening Settings alone does not launch setup', externalOpens.length === panelExternalStart && chatMode.calls.length === panelSetupCount);
    await click('[data-connector-action="open-chatgpt"]');
    await until('one fixed system browser setup request', () => externalOpens.length === panelExternalStart + 1);
    await until('system browser setup receipt', () => evaluate(`document.querySelector('[data-connector-action="open-chatgpt"]').getAttribute('aria-disabled')!=='true' && document.querySelector('#configure-connector-mount .connector-receipt')?.textContent.includes('setup was requested in your default browser')`));
    check('The connector click requests only generic ChatGPT Plugins in the injected system browser', externalOpens.length === panelExternalStart + 1 && externalOpens.at(-1) === pluginUrl);
    check('The system browser setup keeps Settings open without changing embedded tabs or starting Chat Mode or a run', chatMode.calls.length === panelSetupCount && JSON.stringify([...driver.tabs.keys()].sort()) === JSON.stringify(panelTabs) && report.providerTurnsRequested === 0 && harness.engine.listRuns().length === panelRuns && await evaluate('!document.querySelector("#configure-workspace").hidden && document.querySelector("#observe-workspace").hidden'));
    const screenshotSize = ui.getContentSize();
    if (!visibleUI) {
      const guideHeight = await evaluate(`document.querySelector('#configure-connector-mount').getBoundingClientRect().height`);
      ui.setContentSize(screenshotSize[0], Math.min(2600, Math.max(screenshotSize[1], Math.ceil(guideHeight + 180))));
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    }
    await evaluate(`document.querySelector('#configure-connector-mount').scrollIntoView({block:'start'})`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    report.connectorScreenshot = { contentSize: ui.getContentSize(), fullGuide: await evaluate(`(() => {const r=document.querySelector('#configure-connector-mount').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()`) };
    check('The connector setup screenshot includes the complete guide and its controls', report.connectorScreenshot.fullGuide);
    await fs.writeFile(path.join(out, 'chatgpt-system-browser-setup.png'), (await bounded('system browser setup screenshot', ui.webContents.capturePage(), 6000)).toPNG());
    if (!visibleUI) ui.setContentSize(...screenshotSize);
    await click('[data-mode="view"]');
    const panelAfter = await evaluate(`(async()=>{const response=await fetch('/api/status');if(!response.ok)throw Error('Owned status unavailable');const status=await response.json();return {draft:document.querySelector('#mission-task').value,model:document.querySelector('#mission-model').value,defaultModel:status.defaultModel??null,runtimeSettings:status.runtimeSettings};})()`);
    check('System browser setup preserves the unsent draft, selected model and runtime defaults without submitting work', JSON.stringify(panelAfter) === JSON.stringify(panelBefore) && panelAfter.draft === keptDraft && report.providerTurnsRequested === 0 && harness.engine.listRuns().length === panelRuns && actions.slice(panelActionStart).every(entry => ['screenshot', 'snapshot'].includes(entry.action)));
    report.connectorSetup = { fixtureOnly: true, externalAccountsTested: false, externalNavigationPerformed: false, connectionVerified: false, externalOpenStubCalls: externalOpens.length - panelExternalStart, requestedUrl: externalOpens.at(-1), embeddedTabsPreserved: JSON.stringify([...driver.tabs.keys()].sort()) === JSON.stringify(panelTabs), setupCallsAdded: chatMode.calls.length - panelSetupCount, engineRunsAdded: harness.engine.listRuns().length - panelRuns, draftPreserved: panelAfter.draft === panelBefore.draft, selectedModelPreserved: panelAfter.model === panelBefore.model, defaultModelPreserved: panelAfter.defaultModel === panelBefore.defaultModel, runtimeSettingsPreserved: JSON.stringify(panelAfter.runtimeSettings) === JSON.stringify(panelBefore.runtimeSettings), providerTurnsRequested: report.providerTurnsRequested, screenshot: 'chatgpt-system-browser-setup.png' };
  } catch (cause) {
    report.errors.push(cause.stack || cause.message);
    if (report.addressTransition) try { await addressDiagnostics('Address state at failure', { stop: true }); } catch (error) { report.addressDiagnosticError = error.message; }
    // Diagnostics are restricted to this fixture's owned forms and disposable
    // renderer, so failed native input can be distinguished from a test race.
    try { report.failureEvidence = { actions, tabs: await Promise.all((report.fixtureTabs || []).map(async tabId => ({ tabId, state: await state(tabId), selection: await inspect(tabId, '({start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})') }))), ui: await evaluate('({active:document.activeElement?.id,status:document.querySelector("#observe-browser-status")?.textContent,keys:globalThis.qaKeys})') }; } catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
    checkpoint('native Observe keyboard acceptance failed');
  }
  finally {
    activeGate?.release.resolve(); holdNext?.release.resolve(); lateRedirect.resolve();
    try {
      if (ui && !ui.isDestroyed()) ui.destroy();
      await bounded('closing owned application and contained browsers', harness ? harness.close() : browser?.close() || driver?.close(), 20000);
      if (fixtureServer?.listening) { fixtureServer.closeAllConnections(); await bounded('closing owned sign-in server', new Promise((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve())), 5000); }
      report.cleanup = BrowserWindow.getAllWindows().length === 0 && !fixtureServer?.listening && !harness?.server.listening;
      report.ownedProfileCleanup = { path: profile, createdByFixture: true, windowsClosed: BrowserWindow.getAllWindows().length === 0, serversClosed: !fixtureServer?.listening && !harness?.server.listening, retainedForPostExitCleanup: true, reason: 'Electron owns its userData directory until exit; the parent may remove this exact disposable profile after the recorded PID has exited.' };
      check('Owned application, browsers and loopback servers close completely', report.cleanup);
      report.sourceHashesAfter = await sourceHashes(); report.sourceFingerprintAfter = report.appFingerprintAfter = await appFingerprint(ROOT); report.sourceUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter) && report.appFingerprintBefore === report.appFingerprintAfter;
      check('Native acceptance did not mutate the candidate inputs', report.sourceUnchanged);
    } catch (cause) { report.errors.push('Fixture cleanup or source verification failed: ' + (cause.stack || cause.message)); }
    report.passed = report.errors.length === 0 && report.cleanup && report.sourceUnchanged && report.checks.length >= 63; report.completedAt = new Date().toISOString(); clearTimeout(deadline); checkpoint('native Observe keyboard acceptance complete'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(report.passed ? 0 : 1);
  }
}

// Electron must finish evaluating its ESM entry before it can emit ready.
checkpoint('waiting for Electron readiness');
const deadline = setTimeout(() => { report.errors.push('Native acceptance exceeded its 150-second hard deadline.'); report.forcedCleanup = true; checkpoint('native acceptance deadline'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); }, 150000);
app.whenReady().then(run).catch(cause => { clearTimeout(deadline); report.errors.push(cause.stack || cause.message); report.forcedCleanup = true; checkpoint('native fixture failed before normal completion'); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); });
