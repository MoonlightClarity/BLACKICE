import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserRouter } from '../desktop/browser-router.mjs';
import { agentBrowserRequest, browserOwnerKey, BrowserWorkspace } from '../lib/browser.mjs';
import { observeBrowserModel } from '../public/observe-model.mjs';

class FakeDriver extends EventEmitter {
  constructor(tabs = [], metadata = {}) { super(); this.tabs = tabs.map(tabId => ({ tabId, url: `https://example.com/${tabId}` })); this.activeTab = tabs[0] || null; this.calls = []; this.metadata = metadata; this.closeCalls = 0; this.showCalls = []; }
  status() { return { ...this.metadata, tabs: this.tabs, activeTab: this.activeTab, downloads: [{ id: 'download', ...(this.activeTab ? { tabId: this.activeTab } : {}) }] }; }
  async perform(args, options) { this.calls.push({ args, options }); if (args.action === 'open') { this.activeTab = 'opened'; this.tabs.push({ tabId: this.activeTab, url: args.url }); } if (args.action === 'close') { this.tabs = this.tabs.filter(tab => tab.tabId !== args.tabId); this.activeTab = this.tabs[0]?.tabId || null; } return { tabId: args.tabId || this.activeTab, tabs: this.tabs, frames: [{ text: 'Actual adapter result' }] }; }
  async show(tabId) { this.showCalls.push(tabId); return { tabId, visible: true }; }
  async close() { this.closeCalls++; }
}

test('restart cleanup reports driver uncertainty and settlement through router and workspace', async () => {
  const relay = new FakeDriver(), updates = [];
  relay.stopForRestart = async ({ onEffect }) => {
    onEffect({ loads: [{ tabId: 'ordinary', outcome: 'uncertain' }], interactions: [], downloads: [] });
    onEffect({ loads: [{ tabId: 'ordinary', outcome: 'stopped' }], interactions: [], downloads: [] });
    return { loads: [{ tabId: 'ordinary', outcome: 'stopped' }], interactions: [], downloads: [] };
  };
  const workspace = new BrowserWorkspace({ driver: new BrowserRouter({ independent: relay }) });
  const result = await workspace.stopForRestart({ onEffect: value => updates.push(value) });
  assert.equal(updates[0].browsers.relay.loads[0].outcome, 'uncertain');
  assert.equal(updates[1].browsers.relay.loads[0].outcome, 'stopped');
  assert.deepEqual(result, updates[1]);
  await workspace.close();
});

async function nativePopupFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-router-popup-')), session = new EventEmitter();
  session.extensions = { loadExtension: async () => ({ id: 'fixture-compatibility' }) };
  session.cookies = new EventEmitter(); session.webRequest = { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} };
  session.setPermissionRequestHandler = session.setPermissionCheckHandler = session.setDevicePermissionHandler = session.setUSBProtectedClassesHandler = () => {};
  session.flushStorageData = async () => {};
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.url = ''; this.title = 'Fixture page'; this.destroyed = false;
      const wc = this.webContents = new EventEmitter(), debugger_ = wc.debugger = new EventEmitter();
      debugger_.isAttached = () => debugger_.attached === true; debugger_.attach = () => { debugger_.attached = true; }; debugger_.sendCommand = async () => ({});
      wc.isOffscreen = () => options.webPreferences.offscreen; wc.isDestroyed = () => this.destroyed;
      wc.getURL = () => this.url; wc.getTitle = () => this.title; wc.isLoading = wc.isLoadingMainFrame = () => false;
      wc.setWindowOpenHandler = handler => { wc.openHandler = handler; }; wc.loadURL = async url => { this.url = url; };
      wc.mainFrame = { processId: 1, routingId: 1, framesInSubtree: [], executeJavaScript: async () => {
        this.beforeSnapshot?.();
        return { url: this.url, title: this.title, elements: [], text: 'Fixture page', readyState: 'complete' };
      } };
    }
    removeMenu() {} isDestroyed() { return this.destroyed; } isVisible() { return false; } isFocusable() { return this.options.focusable !== false; }
    hide() {} destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  // Use the actual driver and its did-create-window adoption; replace only
  // Electron's native boundary. No HTTP server or real browser is started.
  const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url), key = '__routerPopupFixture_' + randomUUID().replaceAll('-', '');
  let source = await readFile(sourceURL, 'utf8');
  source = source.replace("import { BrowserWindow, session } from 'electron';", 'const {BrowserWindow,session}=globalThis[' + JSON.stringify(key) + '];').replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => "from '" + new URL(relative, sourceURL).href + "'");
  globalThis[key] = { BrowserWindow: Window, session: { fromPartition: () => session } };
  let Driver;
  try { ({ ElectronBrowserDriver: Driver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); }
  finally { delete globalThis[key]; }
  const protection = Object.assign(new EventEmitter(), { status: () => ({ available: true, enabled: false }), tabStatus: () => ({}), match: () => ({ cancel: false }), forgetTab() {}, close: async () => {} });
  const driver = new Driver({ dataDir: directory, downloadDir: path.join(directory, 'downloads'), protection });
  await driver.compatibilityReady;
  const router = new BrowserRouter({ independent: driver });
  t.after(async () => { await router.close(); await rm(directory, { recursive: true, force: true }); });
  const popup = (parent, url = 'https://identity.example.test/signin') => {
    const response = parent.window.webContents.openHandler({ url }); assert.equal(response.action, 'allow');
    const childWindow = new Window(response.overrideBrowserWindowOptions); childWindow.url = url;
    parent.window.webContents.emit('did-create-window', childWindow, { url });
    const child = [...driver.tabs.values()].find(tab => tab.window === childWindow);
    assert.ok(child, 'The actual driver must adopt the native child.');
    return child;
  };
  return { driver, router, popup };
}

test('native popup navigation follows its selected parent through the router and preserves pinned previews', async t => {
  const { driver, router, popup } = await nativePopupFixture(t);
  const parent = driver.newTab('https://site.example.test/login'); await parent.loading;
  assert.equal(router.status().activeTab, parent.id);
  const child = popup(parent), status = router.status();
  assert.equal(status.browsers.relay.activeTab, child.id);
  assert.equal(status.activeTab, child.id);
  assert.equal(observeBrowserModel(status).selected.tabId, child.id);
  assert.equal(observeBrowserModel(status, parent.id).selected.tabId, parent.id, 'An explicitly pinned Observe page stays selected.');
  child.window.url = 'https://site.example.test/feed'; child.window.title = 'Feed';
  child.window.webContents.emit('did-frame-navigate', {}, child.window.url, 200, 'OK', true);
  const redirected = observeBrowserModel(router.status()).selected;
  assert.equal(redirected.tabId, child.id); assert.equal(redirected.url, 'https://site.example.test/feed');
});

test('a native task popup follows the observed task without changing another owner selection', async t => {
  const { driver, router, popup } = await nativePopupFixture(t);
  const owner = { taskId: 'task', runId: 'run', nodeId: 'agent' }, other = { taskId: 'other', runId: 'other-run', nodeId: 'other-agent' };
  const personal = driver.newTab('https://personal.example.test/'), parent = driver.newTab('https://site.example.test/login', { owner }), unrelated = driver.newTab('https://other.example.test/', { owner: other });
  await Promise.all([personal.loading, parent.loading, unrelated.loading]);
  await router.perform({ action: 'snapshot', tabId: parent.id }, { source: 'user' });
  const child = popup(parent), status = router.status();
  assert.equal(driver.activeTab, parent.id, 'Task popup adoption updates ownerActiveTabs rather than the personal selection.');
  assert.equal(status.activeTab, child.id);
  assert.equal(status.ownerActiveTabs[browserOwnerKey(owner)], child.id);
  assert.equal(agentBrowserRequest({ action: 'read' }, status, owner).tabId, child.id);
  assert.equal(agentBrowserRequest({ action: 'read' }, status, other).tabId, unrelated.id);
  const background = popup(unrelated), afterBackground = router.status();
  assert.equal(afterBackground.activeTab, child.id, 'Another task popup cannot replace the followed page.');
  assert.equal(agentBrowserRequest({ action: 'read' }, afterBackground, other).tabId, background.id);
});

test('a late parent action receipt does not replace the popup adopted during that action', async t => {
  const { driver, router, popup } = await nativePopupFixture(t), parent = driver.newTab('https://site.example.test/login'); await parent.loading;
  assert.equal(router.status().activeTab, parent.id);
  let child;
  parent.window.beforeSnapshot = () => {
    parent.window.beforeSnapshot = null; child = popup(parent);
    assert.equal(router.status().activeTab, child.id, 'Status observers may see the popup before the action resolves.');
  };
  const result = await router.perform({ action: 'snapshot', tabId: parent.id }, { source: 'user' });
  assert.equal(result.tabId, parent.id, 'The receipt must continue to describe the original operation.');
  assert.equal(router.status().activeTab, child.id);
});

test('a closed native popup returns follow selection to its parent rather than the first personal page', async t => {
  const { driver, router, popup } = await nativePopupFixture(t);
  const other = driver.newTab('https://unrelated.example.test/'), parent = driver.newTab('https://site.example.test/login');
  await Promise.all([other.loading, parent.loading]); assert.equal(router.status().activeTab, parent.id);
  const child = popup(parent); assert.equal(router.status().activeTab, child.id);
  child.window.destroy();
  assert.equal(driver.activeTab, other.id, 'The driver default alone selects the first personal page.');
  const status = router.status(); assert.equal(status.activeTab, parent.id); assert.equal(observeBrowserModel(status).selected.tabId, parent.id);
});

test('closing the router cannot turn a late adapter completion into a successful page action', async () => {
  const independent = new FakeDriver(['relay-tab']); let finish;
  independent.perform = () => new Promise(resolve => { finish = resolve; });
  const router = new BrowserRouter({ independent });
  const action = router.perform({ action: 'click', tabId: 'relay-tab', ref: 'button' });
  await router.close(); finish({ tabId: 'relay-tab', receipt: { clicked: true } });
  await assert.rejects(action, { code: 'BROWSER_CLOSED' }); assert.equal(router.status().activeTab, null);
});

test('pre-cancelled actions never reach an adapter and late cancellation never reports success', async () => {
  const independent = new FakeDriver(['relay-tab']), router = new BrowserRouter({ independent }), before = new AbortController(); before.abort();
  try {
    await assert.rejects(router.perform({ action: 'click', tabId: 'relay-tab' }, { signal: before.signal }), { name: 'AbortError' });
    assert.equal(independent.calls.length, 0);
    let finish; independent.perform = () => new Promise(resolve => { finish = resolve; });
    const during = new AbortController(), action = router.perform({ action: 'click', tabId: 'relay-tab' }, { signal: during.signal });
    during.abort(); finish({ tabId: 'relay-tab', receipt: { clicked: true } }); await assert.rejects(action, { name: 'AbortError' });
  } finally { await router.close(); }
});

test('an owned task open cannot change a manually selected router page', async () => {
  const independent = new FakeDriver(['personal']), router = new BrowserRouter({ independent });
  try {
    assert.equal(router.status().activeTab, 'personal');
    await router.perform({ action: 'open', url: 'https://task.example/' }, { owner: { taskId: 'task', runId: 'run', nodeId: 'node' } });
    assert.equal(router.status().activeTab, 'personal');
  } finally { await router.close(); }
});


test('retired Firefox adapter is never initialized, listed, selected, closed or called',async()=>{
 const independent=new FakeDriver(['mail']),firefox=new FakeDriver(['old']);
 const router=await new BrowserRouter({independent,firefox}).init();
 assert.deepEqual(Object.keys(router.status().browsers),['relay']);
 assert.deepEqual(router.status().tabs.map(t=>t.tabId),['mail']);
 await assert.rejects(router.perform({action:'open',browser:'firefox',url:'https://example.test'}),{code:'BROWSER_VALIDATION'});
 assert.equal(firefox.calls.length,0);await router.close();assert.equal(firefox.closeCalls,0);
});
test('contained webmail uses ordinary open read fill click upload and screenshot routing',async()=>{
 const driver=new FakeDriver(),router=await new BrowserRouter({independent:driver}).init();
 const opened=await router.perform({action:'open',url:'https://mail.example.test'});
 for(const action of ['read','fill','click','upload','screenshot'])await router.perform({action,tabId:opened.tabId,ref:'field',text:'draft',paths:['fixture.txt']});
 assert.deepEqual(driver.calls.map(c=>c.args.action),['open','read','fill','click','upload','screenshot']);
 assert.equal(router.status().activeTab,opened.tabId);await router.close();assert.equal(driver.closeCalls,1);
});
test('desktop and UI no longer wire Firefox or a separate email composer',async()=>{
 const source=async p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 assert.doesNotMatch(await source('desktop/main.mjs'),/LazyFirefoxDriver|firefox-lazy|independent, firefox/);
 assert.doesNotMatch(await source('server.mjs'),/pathname === '\/api\/browser\/firefox\/disconnect'/);
 assert.doesNotMatch(await source('public/browser-ui.mjs'),/firefoxSection|browser-firefox-disconnect|Firefox pages/);
 assert.doesNotMatch(await source('public/app.js'),/showEmailWorkspace|import\('\/email-ui.mjs'\)/);
 assert.match(await source('server.mjs'),/EMAIL_RETIRED/);
});

test('contained unknown tab cannot reach the driver',async()=>{
 const independent=new FakeDriver(['known']),router=new BrowserRouter({independent});
 try{
  for(const action of ['fill','click','snapshot'])await assert.rejects(router.perform({action,browser:'relay',tabId:'unknown',ref:'control',text:'fixture'}),{code:'BROWSER_TAB_NOT_FOUND'});
  assert.equal(independent.calls.length,0);
 }finally{await router.close();}
});
test('contained show rejects without opening or foregrounding the native window',async()=>{
 const independent=new FakeDriver(['known']),router=new BrowserRouter({independent});
 try{
  await assert.rejects(router.show('known'),{code:'BROWSER_CONTAINED'});
  assert.deepEqual(independent.showCalls,[]);assert.equal(independent.calls.length,0);
 }finally{await router.close();}
});
test('contained changed events detach after failed close and close remains idempotent',async()=>{
 const independent=new FakeDriver(),failure=new Error('Contained close failed');
 independent.close=async()=>{independent.closeCalls++;throw failure;};
 const router=new BrowserRouter({independent});let changed=0;router.on('changed',()=>changed++);
 independent.emit('changed');assert.equal(changed,1);
 await assert.rejects(router.close(),error=>error===failure);assert.equal(independent.closeCalls,1);
 independent.emit('changed');assert.equal(changed,1);assert.equal(independent.listenerCount('changed'),0);
 await assert.rejects(router.close(),error=>error===failure);assert.equal(independent.closeCalls,1);
 assert.equal(router.status().available,false);await assert.rejects(router.perform({action:'tabs'}),{code:'BROWSER_CLOSED'});
});
test('concurrent contained shutdown callers share one close promise and failure',async()=>{
 const independent=new FakeDriver(),failure=new Error('Contained close pending');let release;
 independent.close=()=>{independent.closeCalls++;return new Promise((_resolve,reject)=>{release=()=>reject(failure);});};
 const router=new BrowserRouter({independent}),first=router.close(),second=router.close();assert.equal(first,second);
 let settled=false;const observed=second.catch(error=>{settled=true;assert.equal(error,failure);});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(independent.closeCalls,1);
 release();await observed;await assert.rejects(first,error=>error===failure);await assert.rejects(router.init(),{code:'BROWSER_CLOSED'});
});
test('contained folder routing works without an active tab and forwards releaseOwner',async()=>{
 const owner={taskId:'task',runId:'run',nodeId:'node'},independent=new FakeDriver();let releases=0;
 independent.perform=async function(args,options){this.calls.push({args,options});return{folder:{id:'folder',kind:'user',name:args.name}};};
 independent.releaseOwner=async(value,options)=>{releases++;assert.deepEqual(value,owner);assert.deepEqual(options,{reason:'test'});return{suspended:['owned'],retained:[]};};
 const router=new BrowserRouter({independent});
 try{
  assert.equal(router.status().activeTab,null);
  const result=await router.perform({action:'folder_create',name:'Research'},{source:'user'});
  assert.equal(result.folder.name,'Research');assert.deepEqual(independent.calls[0].args,{action:'folder_create',name:'Research'});
  assert.deepEqual(independent.calls[0].options,{source:'user'});
  assert.deepEqual(await router.releaseOwner(owner,{reason:'test'}),{suspended:['owned'],retained:[]});assert.equal(releases,1);
 }finally{await router.close();}
});
