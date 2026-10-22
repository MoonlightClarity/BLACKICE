#!/usr/bin/env node
// Browser-only actual-frontend acceptance using an owned server, profile and deterministic page adapter.
// --stage before captures the unmodified UI; --stage after additionally checks browser usability changes.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, item, index, all) => item.startsWith('--') ? [...out, [item.slice(2), all[index + 1]?.startsWith('--') ? true : all[index + 1] ?? true]] : out, []));
const candidate = path.resolve(args.candidate || '.'), out = path.resolve(args.out || './browser-usability-qa-output');
const report = { candidate, stage: args.stage || 'after', startedAt: new Date().toISOString(), checks: [], measurements: [], screenshots: [], pageErrors: [], networkUrls: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(label, fn, ms = 12000) { const end = Date.now() + ms; do { const value = await fn(); if (value) return value; await delay(50); } while (Date.now() < end); throw Error('Timed out: ' + label); }
const check = (label, value) => { assert.ok(value, label); report.checks.push(label); };
const sourceFiles = ['public/observe.css','public/observe-ui.mjs','public/observe-model.mjs','public/browser-address.mjs','public/browser-tree.css'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(candidate, name))).digest('hex')])));

class CDP {
  constructor(socket) { this.socket = socket; this.counter = 0; this.pending = new Map(); socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const item = this.pending.get(value.id); if (!item) return; this.pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(item.method + ': ' + value.error.message)) : item.resolve(value.result || {}); } else { if (value.method === 'Runtime.exceptionThrown') report.pageErrors.push(value.params.exceptionDetails); if (value.method === 'Network.requestWillBeSent') report.networkUrls.push(value.params.request.url); } }); }
  static async connect(url) { const socket = new WebSocket(url); const cdp = new CDP(socket); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); return cdp; }
  call(method, params = {}, sessionId) { const id = ++this.counter; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Error(method + ' timed out')); }, 12000); this.pending.set(id, { method, resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  close() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('Owned browser closed')); } this.pending.clear(); this.socket.close(); }
}

const importAt = name => import(pathToFileURL(path.join(candidate, name)).href);
let app, browser, cdp, session, browserLog, root, containedFixture, readUIDiagnostics;
async function main() {
  await fs.mkdir(out, { recursive: true }); report.before = await hashes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-focused-ui-')); const dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace'), profile = path.join(root, 'browser'); await fs.mkdir(cwd);
  const [{ createHarnessServer }, { WorkspaceFixtureRuntime, ContainedBrowserFixture }] = await Promise.all([importAt('server.mjs'), importAt('scripts/planning-remote-ui-qa.mjs')]);
  const runtime = new WorkspaceFixtureRuntime(cwd); runtime.runAgent = async () => { throw Error('This screenshot fixture must not start a model turn'); };
  class BrowserUsabilityFixture extends ContainedBrowserFixture {
    constructor() { super(); this.versions = new Map(); this.scrollHold = null; }
    identity(tab) { return { tabId: tab.tabId, url: tab.url, documentId: `${tab.tabId}:qa:${this.versions.get(tab.tabId) || 1}` }; }
    document(tab) { return { ...super.document(tab), ...this.identity(tab) }; }
    async perform(value, options = {}) {
      const tab = this.tabs.find(item => item.tabId === value.tabId);
      if (['reload', 'scroll', 'type'].includes(value.action)) {
        assert.equal(options.source, 'user'); assert.equal(value.browser, 'relay'); assert.equal(this.enabled, true);
        assert.ok(tab, 'The request addresses an existing fixture page.');
        this.requests.push({ kind: 'page', ...structuredClone(value) });
        if (value.action === 'reload') {
          this.versions.set(tab.tabId, (this.versions.get(tab.tabId) || 1) + 1);
          this.updated(); return this.document(tab);
        }
        const identity = this.identity(tab);
        assert.equal(value.expectedUrl, identity.url); assert.equal(value.expectedDocumentId, identity.documentId);
        if (value.action === 'scroll') {
          assert.ok(['x', 'y', 'deltaX', 'deltaY'].every(key => Number.isFinite(value[key])));
          assert.ok(value.x >= 0 && value.x < 960 && value.y >= 0 && value.y < 540);
          if (this.scrollHold && !this.scrollHold.started) { this.scrollHold.started = true; await this.scrollHold.promise; }
        }
        return { ...identity, receipt: { completed: true, action: value.action } };
      }
      if (value.action === 'navigate' && tab) this.versions.set(tab.tabId, (this.versions.get(tab.tabId) || 1) + 1);
      if (value.action === 'screenshot' && tab?.suspended) { tab.suspended = false; this.updated(); }
      const result = await super.perform(value, options);
      if (value.action === 'screenshot') return { ...result, ...this.identity(tab) };
      return result;
    }
  }
  const contained = containedFixture = new BrowserUsabilityFixture(); contained.enabled = true;
  contained.tabs = [
    { tabId:'qa-tab-1', browser:'relay', visible:false, title:'Interface review notes', url:'https://notes.example.test/interface', folderId:'research', parentTabId:null, loading:false },
    { tabId:'qa-tab-2', browser:'relay', visible:false, title:'Release checklist and verification', url:'https://docs.example.test/release', folderId:'research', parentTabId:'qa-tab-1', loading:false },
    { tabId:'qa-tab-3', browser:'relay', visible:false, title:'Design reference — navigation and spacing', url:'https://design.example.test/reference', folderId:'references', parentTabId:null, loading:false },
    { tabId:'qa-tab-4', browser:'relay', visible:false, title:'Earlier research (saved)', url:'https://archive.example.test/research', folderId:'references', parentTabId:null, suspended:true, loading:false },
  ]; contained.counter = 4; contained.activeTab = 'qa-tab-2';
  const originalStatus = contained.status.bind(contained); contained.status = () => ({ ...originalStatus(), folders:[{id:'research',name:'BLACKICE refinement',kind:'user'},{id:'references',name:'Reference material',kind:'user'}], capacity:{live:3,maxLive:32,saved:4,maxSaved:256,perTaskLive:8} });
  const desktop = new EventEmitter(); desktop.status = () => ({available:false,enabled:false,busy:false}); desktop.setEnabled = async () => desktop.status();
  const applicationWorkspace = new EventEmitter(); applicationWorkspace.status = () => ({available:false,sessions:[],documents:[],supportedApps:[],documentStorage:{healthy:true}}); applicationWorkspace.close = async () => {};
  app = await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime,desktop,applicationWorkspace,browser:contained,autoAttachDesktop:false}); await app.learning.updateSettings({mode:'manual'});
  check('Browser fixture starts without model calls',runtime.calls.length===0);
  if(args['seed-only']){report.ok=true;return;}
  const origin = await app.listen(); report.origin = origin;
  const candidates = [args.edge, process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'),process.env.ProgramFiles && path.join(process.env.ProgramFiles,'Microsoft','Edge','Application','msedge.exe'),'/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean);
  let binary; for (const file of candidates) { try { if ((await fs.stat(file)).isFile()) { binary=file;break; } } catch {} } if(!binary)throw Error('Supply an installed browser path with --edge');
  browserLog = await fs.open(path.join(out,'browser.log'),'w');
  browser=spawn(binary,['--headless=new','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--disable-extensions','--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE 127.0.0.1','--window-size=1440,900',...(process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox']:[]),'about:blank'],{windowsHide:true,shell:false,stdio:['ignore','ignore',browserLog.fd]}); report.ownedBrowserPid=browser.pid;
  let spawnError; browser.on('error',e=>{spawnError=e;});
  const endpoint=await until('owned browser endpoint',async()=>{if(spawnError)throw spawnError;if(browser.exitCode!==null)throw Error('Owned browser exited');try{const [port,url]=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);return port&&url&&'ws://127.0.0.1:'+port+url;}catch{return false;}},25000);
  cdp=await CDP.connect(endpoint); const target=await cdp.call('Target.createTarget',{url:'about:blank'});session=(await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await Promise.all(['Page.enable','Runtime.enable','Network.enable'].map(method=>cdp.call(method,{},session)));
  const evaluate=async(fn,...values)=>{const result=await cdp.call('Runtime.evaluate',{expression:'('+fn.toString()+')(...'+JSON.stringify(values)+')',returnByValue:true,awaitPromise:true},session);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  readUIDiagnostics=()=>evaluate(()=>{
    const address=document.querySelector('#observe-browser-url'),form=document.querySelector('#observe-browser-address-form'),active=document.activeElement,card=document.querySelector('#observe-browser');
    const formEvents=(globalThis.__qaFormEvents||[]).map((item,index)=>({...item,prevented:globalThis.__qaFormEventRefs?.[index]?.defaultPrevented}));
    const wheelEvents=(globalThis.__qaWheelEvents||[]).map((item,index)=>({...item,prevented:globalThis.__qaWheelEventRefs?.[index]?.defaultPrevented}));
    return{address:address?.value,selection:address?[address.selectionStart,address.selectionEnd,address.selectionDirection]:null,addressValid:address?.validity.valid,addressValidationMessage:address?.validationMessage,activeElement:active?{tag:active.tagName,id:active.id,action:active.dataset?.observeBrowser,type:active.type,value:active.value}:null,status:document.querySelector('#observe-browser-status')?.textContent,draft:Boolean(document.querySelector('#observe-browser-new-draft')),busy:card?.getAttribute('aria-busy'),submitDisabled:form?.querySelector('[type="submit"]')?.disabled,selected:document.querySelector('#observe-browser-tabs [aria-selected="true"]')?.dataset?.tabId,tabs:[...document.querySelectorAll('#observe-browser-tabs [role="tab"]')].map(tab=>({id:tab.dataset.tabId,action:tab.dataset.observeBrowser,selected:tab.getAttribute('aria-selected')})),formEvents,wheelEvents};
  });
  const visible=selector=>evaluate(selector=>{const n=document.querySelector(selector);return Boolean(n&&n.getClientRects().length&&!n.closest('[hidden],[inert]'));},selector);
  const wait=selector=>until(selector,()=>visible(selector));
  const frames=()=>evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const click=async selector=>{await wait(selector);const point=await evaluate(selector=>{const n=document.querySelector(selector);n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(n.disabled||!n.contains(document.elementFromPoint(x,y)))throw Error('Unreachable control '+selector);return{x,y};},selector);for(const type of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point},session);await frames();};
  const fill=async(selector,text)=>{await wait(selector);await evaluate(selector=>{const n=document.querySelector(selector);n.scrollIntoView({block:'center'});n.focus();n.select();},selector);await cdp.call('Input.insertText',{text},session);};
  const key=async(value,code,virtualCode,modifiers=0)=>{
    const event={key:value,code,windowsVirtualKeyCode:virtualCode,modifiers};
    await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',...event},session);
    try{
      // Match desktop/browser-driver.mjs: Enter needs its native character
      // event for an address input's implicit form submission. Keydown alone
      // exercises JS keyboard handlers but does not synthesize keypress.
      if(value==='Enter')await cdp.call('Input.dispatchKeyEvent',{type:'char',text:'\r',...event},session);
    }finally{await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',...event},session);}
    await frames();
  };
  const resize=async(width,height)=>{await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},session);await delay(100);await frames();};
  const capture=async name=>{await evaluate(async()=>{await document.fonts.ready;});await frames();const {data}=await cdp.call('Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false},session);const file=path.join(out,name+'.jpg');await fs.writeFile(file,Buffer.from(data,'base64'));report.screenshots.push(file);};
  const measure=async label=>{const value=await evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,controls:[...document.querySelectorAll('#observe-browser button,#observe-browser-url,#observe-browser .observe-browser-tree-page>button')].filter(n=>n.getClientRects().length&&!n.closest('[hidden],[inert]')).map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{selector:n.id||n.dataset.planningAction||n.dataset.observeBrowser||n.className,text:n.textContent.trim().slice(0,80),font:parseFloat(s.fontSize),width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})}));report.measurements.push({label,...value});check(label+' has no page overflow',value.documentWidth<=value.width+1&&value.bodyWidth<=value.width+1);return value;};
  await resize(1440,900);await cdp.call('Page.navigate',{url:origin},session);await wait('#mission-task');
  await evaluate(()=>{
    globalThis.__qaFormEvents=[];globalThis.__qaFormEventRefs=[];
    const observe=event=>{
      if(!event.target.closest?.('#observe-browser-address-form'))return;
      const item={type:event.type,trusted:event.isTrusted,cancelable:event.cancelable,target:event.target.id||event.target.tagName,key:event.key,code:event.code,charCode:event.charCode,value:document.querySelector('#observe-browser-url')?.value};
      // Retain the native event and sample cancellation after dispatch. A
      // capture-listener microtask can run before bubbling handlers cancel it.
      globalThis.__qaFormEvents.push(item);globalThis.__qaFormEventRefs.push(event);
      if(globalThis.__qaFormEvents.length>120){globalThis.__qaFormEvents.shift();globalThis.__qaFormEventRefs.shift();}
    };
    for(const type of ['keydown','keypress','keyup','submit','invalid'])document.addEventListener(type,observe,true);
  });
  contained.frameImage=await evaluate(()=>{const c=document.createElement('canvas');c.width=960;c.height=540;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,960,540);g.addColorStop(0,'#182e3d');g.addColorStop(1,'#0b141e');x.fillStyle=g;x.fillRect(0,0,960,540);x.fillStyle='#d4e8f2';x.font='28px sans-serif';x.fillText('Interface review notes',48,76);x.fillStyle='#9eb9c9';x.font='18px sans-serif';x.fillText('Local fixture — no website or account was contacted.',48,114);x.strokeStyle='#365d70';x.strokeRect(48,160,700,180);x.fillStyle='#bbd4e0';x.fillText('Readability · navigation · retained drafts',70,205);return c.toDataURL('image/png');});contained.updated();
  await resize(1440,900);await click('#workspace-modes [data-mode="observe"]');await wait('[data-observe-surface="browser"]');await click('[data-observe-surface="browser"]');await wait('#observe-browser');await until('browser frame settles',()=>evaluate(()=>document.querySelector('#observe-browser').getAttribute('aria-busy')==='false'&&Boolean(document.querySelector('#observe-browser-image'))));
  const addressDraft='https://draft.example.test/unsent-address';await fill('#observe-browser-url',addressDraft);await evaluate(()=>{globalThis.__qaAddressField=document.querySelector('#observe-browser-url');});
  const browserFirstView=async()=>{
    await evaluate(()=>{
      // The browser is a card inside Activity's scrolling viewport. Resetting
      // the card itself does not undo scrollIntoView on folder controls.
      const card=document.querySelector('#observe-browser'),owner=card?.closest('.observe-scroll');
      if(!owner)throw Error('The browser has no Activity scroll owner');
      owner.scrollTop=0;
      if(document.scrollingElement)document.scrollingElement.scrollTop=0;
    });
    await frames();
  };
  const browserChrome=()=>evaluate(()=>{
    const box=selector=>{const n=document.querySelector(selector);if(!n)return{missing:true};const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,front=document.elementFromPoint(x,y);return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:{x,y},hit:n.contains(front),hitFront:front?{tag:front.tagName,id:front.id,class:front.getAttribute('class')||''}:null,inViewport:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,font:parseFloat(getComputedStyle(n).fontSize)};};
    const selected=document.querySelector('#observe-browser-tabs [aria-selected="true"]'),id=selected?.dataset.tabId;
    const card=document.querySelector('#observe-browser'),owner=card.closest('.observe-scroll'),ownerRect=owner.getBoundingClientRect();
    return{width:innerWidth,height:innerHeight,scrollTop:owner.scrollTop,scrollOwner:{tag:owner.tagName,id:owner.id,class:owner.getAttribute('class')||'',scrollTop:owner.scrollTop,scrollHeight:owner.scrollHeight,clientHeight:owner.clientHeight,top:ownerRect.top,bottom:ownerRect.bottom,overflowY:getComputedStyle(owner).overflowY},cardScrollTop:card.scrollTop,strip:box('#observe-browser-tabs'),address:box('#observe-browser-url'),submit:box('#observe-browser-address-form [type="submit"]'),tab:box('#observe-browser-tabs [aria-selected="true"]'),close:id?box('[data-observe-browser="close"][data-tab-id="'+id+'"]'):{missing:true},navigation:box('.observe-browser-navigation'),reload:box('.observe-browser-navigation [data-observe-browser="reload"]'),image:box('#observe-browser-image'),selected:id,foldersOpen:document.querySelector('#observe-browser-tree')?.open,toolsOpen:document.querySelector('#observe-browser-tools')?.open};
  });
  const settled=()=>until('browser preview settles',()=>evaluate(()=>document.querySelector('#observe-browser').getAttribute('aria-busy')==='false'));
  for(const [width,height] of [[1440,900],[1100,800],[780,800],[390,844],[320,844]]){
    await resize(width,height);await browserFirstView();await settled();
    const chrome=await browserChrome();report.measurements.push({label:'Browser first-view controls '+width,...chrome});
    check('Browser first-view address and selected tab exist at '+width,!chrome.address.missing&&!chrome.tab.missing);
    if(width>=1100)check('Tabs, address and active close target visible without scrolling at '+width,chrome.scrollTop===0&&[chrome.strip,chrome.address,chrome.submit,chrome.close].every(item=>item.inViewport&&item.hit));
    if(report.stage==='after'){
      check('Resizing keeps the selected tab close target visible at '+width,!chrome.close.missing&&chrome.close.inViewport&&chrome.close.hit&&chrome.close.left>=chrome.strip.left-1&&chrome.close.right<=chrome.strip.right+1);
      check('Primary address and reload controls fit the viewport at '+width,[chrome.address,chrome.submit,chrome.reload].every(item=>!item.missing&&item.inViewport&&item.hit));
      check('The page begins within the first viewport at '+width,!chrome.image.missing&&chrome.image.top<height-80);
      check('Secondary browser tools start collapsed at '+width,chrome.toolsOpen===false);
    }
    await measure('Browser '+width);await capture('browser-'+width);
    check('Address draft and field identity preserved at '+width,await evaluate(draft=>document.querySelector('#observe-browser-url').value===draft&&document.querySelector('#observe-browser-url')===globalThis.__qaAddressField,addressDraft));
  }
  if(report.stage==='after'){
    const pages=action=>contained.requests.filter(item=>item.kind==='page'&&(!action||item.action===action));
    const mutations=()=>pages().filter(item=>!['snapshot','screenshot'].includes(item.action));
    const selected=()=>evaluate(()=>document.querySelector('#observe-browser-tabs [data-observe-browser="tab"][aria-selected="true"]')?.dataset.tabId||null);
    const selectedAndSettled=id=>until('settled selected tab '+id,async()=>await selected()===id&&!await evaluate(()=>document.querySelector('#observe-browser').getAttribute('aria-busy')==='true'));
    const select=async id=>{await click('[data-observe-browser="tab"][data-tab-id="'+id+'"]');await selectedAndSettled(id);};
    const addressValue=()=>evaluate(()=>document.querySelector('#observe-browser-url').value);
    const secondary=async action=>{
      const hasTools=await evaluate(()=>Boolean(document.querySelector('#observe-browser-tools'))),wasOpen=await evaluate(()=>document.querySelector('#observe-browser-tools')?.open);
      if(hasTools&&!wasOpen)await click('#observe-browser-tools > summary');
      await click('[data-observe-browser="'+action+'"]');await settled();
      if(hasTools&&!wasOpen&&await evaluate(()=>document.querySelector('#observe-browser-tools')?.open))await click('#observe-browser-tools > summary');
      await browserFirstView();
    };
    const exactMutations=(from,expected)=>assert.deepEqual(mutations().slice(from).map(({kind,...item})=>item),expected);

    // A viewport change reveals selection; ordinary polling must not undo a
    // subsequent deliberate horizontal scroll through the tab strip.
    await browserFirstView();await settled();
    const stripPoint=await evaluate(()=>{const strip=document.querySelector('#observe-browser-tabs'),rect=strip.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,left:strip.scrollLeft,max:strip.scrollWidth-strip.clientWidth};});
    check('The compact fixture has horizontal tab overflow',stripPoint.max>30);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:stripPoint.x,y:stripPoint.y,deltaX:stripPoint.left>20?-300:300,deltaY:0,modifiers:0},session);
    await until('a deliberate native tab-strip scroll',()=>evaluate(before=>Math.abs(document.querySelector('#observe-browser-tabs').scrollLeft-before)>10,stripPoint.left));
    let deliberateStripScroll=NaN,stripStableSince=Date.now();
    await until('the native tab-strip scroll settles',async()=>{const left=await evaluate(()=>document.querySelector('#observe-browser-tabs').scrollLeft);if(!Number.isFinite(deliberateStripScroll)||Math.abs(left-deliberateStripScroll)>.25){deliberateStripScroll=left;stripStableSince=Date.now();return false;}return Date.now()-stripStableSince>=180;});
    await secondary('refresh');
    check('Preview refresh preserves deliberate tab-strip scrolling after resize',await evaluate(before=>Math.abs(document.querySelector('#observe-browser-tabs').scrollLeft-before)<2,deliberateStripScroll));
    check('Scrolling the tab strip does not send page-wheel input',pages('scroll').length===0);
    await resize(1440,900);await browserFirstView();await settled();
    await select('qa-tab-2');
    const pinnedMutations=mutations().length;
    contained.activeTab='qa-tab-3';contained.updated();await secondary('refresh');
    check('Manual tab selection and its unsent address remain pinned during active-page changes',await selected()==='qa-tab-2'&&await addressValue()===addressDraft&&await evaluate(()=>document.querySelector('#observe-browser-follow').getAttribute('aria-pressed')==='false'));
    await secondary('follow');await selectedAndSettled('qa-tab-3');
    check('Follow active page explicitly selects the current agent page',await selected()==='qa-tab-3');
    await select('qa-tab-2');
    for(const [name,code,virtualCode,expected] of [['Home','Home',36,'qa-tab-1'],['End','End',35,'qa-tab-4'],['ArrowLeft','ArrowLeft',37,'qa-tab-3'],['Home','Home',36,'qa-tab-1'],['ArrowRight','ArrowRight',39,'qa-tab-2']]){
      await evaluate(()=>document.querySelector('#observe-browser-tabs [data-observe-browser="tab"][aria-selected="true"]').focus());
      await key(name,code,virtualCode);await selectedAndSettled(expected);
    }
    check('Keyboard arrows, Home and End preserve the selected tab and its address draft',await selected()==='qa-tab-2'&&await addressValue()===addressDraft);
    check('Pinning, following and keyboard tab selection do not navigate or create pages',mutations().length===pinnedMutations);

    const draftStart=mutations().length,tabCount=contained.tabs.length;
    await click('[data-observe-browser="new"]');await wait('#observe-browser-new-draft');
    check('New tab starts with a focused empty address and a local selected draft',await evaluate(()=>document.querySelector('#observe-browser-url').value===''&&document.activeElement.id==='observe-browser-url'&&Boolean(document.querySelector('[data-observe-browser="draft-tab"][aria-selected="true"]'))));
    check('Opening the new-tab draft does not create or navigate a backend page',contained.tabs.length===tabCount&&mutations().length===draftStart);
    const localDraft='draft-only.qa.example.test/unfinished';await fill('#observe-browser-url',localDraft);
    await browserFirstView();await capture('browser-new-tab-draft-1440');
    await resize(320,844);await browserFirstView();await measure('New tab draft 320');await capture('browser-new-tab-draft-320');
    check('The local new-tab draft survives resizing without a backend mutation',await addressValue()===localDraft&&mutations().length===draftStart);
    await key('Escape','Escape',27);await until('Escape cancels local new tab',async()=>!await visible('#observe-browser-new-draft'));await selectedAndSettled('qa-tab-2');
    check('Escape restores the previous page and its exact unsent address',await addressValue()===addressDraft&&mutations().length===draftStart&&contained.tabs.length===tabCount);
    await resize(1440,900);await browserFirstView();
    await click('[data-observe-browser="new"]');await wait('#observe-browser-new-draft');await fill('#observe-browser-url','cancel-only.qa.example.test/');await click('[data-observe-browser="cancel-new"]');await selectedAndSettled('qa-tab-2');
    check('Cancel new tab restores the previous page without changing its backend state',await addressValue()===addressDraft&&mutations().length===draftStart&&contained.tabs.length===tabCount);

    await click('[data-observe-browser="new"]');await wait('#observe-browser-new-draft');
    await fill('#observe-browser-url','opened.qa.example.test/library');const enterEventStart=await evaluate(()=>globalThis.__qaFormEvents.length);await key('Enter','Enter',13);
    await until('one new tab from submitting its draft',()=>contained.tabs.length===tabCount+1);const openedId=contained.tabs.at(-1).tabId;await selectedAndSettled(openedId);
    report.enterSubmission=await evaluate(start=>globalThis.__qaFormEvents.map((item,index)=>({...item,prevented:globalThis.__qaFormEventRefs[index].defaultPrevented})).slice(start),enterEventStart);
    check('Native Enter produces its keypress and exactly one trusted form submission',report.enterSubmission.some(event=>event.type==='keypress'&&event.key==='Enter'&&event.trusted)&&report.enterSubmission.filter(event=>event.type==='submit'&&event.trusted).length===1);
    exactMutations(draftStart,[{url:'https://opened.qa.example.test/library',action:'open',browser:'relay'}]);
    check('Submitting the new-tab draft opens its normalized address exactly once',await addressValue()==='https://opened.qa.example.test/library'&&!await visible('#observe-browser-new-draft'));
    const navigateStart=mutations().length;
    await fill('#observe-browser-url','opened.qa.example.test/next');await click('#observe-browser-address-form [type="submit"]');await settled();
    exactMutations(navigateStart,[{url:'https://opened.qa.example.test/next',action:'navigate',browser:'relay',tabId:openedId}]);
    check('Go navigates only the selected page once',contained.tabs.find(tab=>tab.tabId===openedId)?.url==='https://opened.qa.example.test/next');
    const openedDraft='https://retained.qa.example.test/not-submitted';await fill('#observe-browser-url',openedDraft);
    const closeStart=mutations().length;await click('[data-observe-browser="close"][data-tab-id="qa-tab-1"]');await settled();
    exactMutations(closeStart,[{action:'close',browser:'relay',tabId:'qa-tab-1'}]);
    check('Closing another tab preserves the selected page and its address draft',await selected()===openedId&&await addressValue()===openedDraft&&!contained.tabs.some(tab=>tab.tabId==='qa-tab-1'));
    await evaluate(()=>document.querySelector('#observe-browser-tabs [data-observe-browser="tab"][aria-selected="true"]').focus());
    const deleteStart=mutations().length;await key('Delete','Delete',46);await selectedAndSettled('qa-tab-4');
    exactMutations(deleteStart,[{action:'close',browser:'relay',tabId:openedId}]);
    check('Delete closes the selected last tab and selects a surviving neighbor',!contained.tabs.some(tab=>tab.tabId===openedId)&&await selected()==='qa-tab-4');

    await select('qa-tab-2');const refreshStart=mutations().length,capturesBefore=pages('screenshot').length;
    await secondary('refresh');
    check('Refresh preview captures the page without reloading or navigating it',pages('screenshot').length>capturesBefore&&mutations().length===refreshStart&&await addressValue()===addressDraft);
    const reloadStart=mutations().length,documentBefore=contained.identity(contained.tabs.find(tab=>tab.tabId==='qa-tab-2')).documentId;
    await click('.observe-browser-navigation [data-observe-browser="reload"]');await settled();
    exactMutations(reloadStart,[{action:'reload',browser:'relay',tabId:'qa-tab-2'}]);
    check('Reload page reloads the selected page once and preserves its unsent address',contained.identity(contained.tabs.find(tab=>tab.tabId==='qa-tab-2')).documentId!==documentBefore&&await addressValue()===addressDraft);

    // Hold only the first fixture reply while native wheel events arrive. This
    // exercises the real UI queue without changing event behavior or defaults.
    const scrollStart=pages('scroll').length,wheelCaptureStart=pages('screenshot').length;
    const wheelPoint=await evaluate(()=>{
      const image=document.querySelector('#observe-browser-image');image.scrollIntoView({block:'center',inline:'nearest'});
      const rect=image.getBoundingClientRect(),x=Math.max(rect.left+2,Math.min(rect.right-2,innerWidth/2)),y=Math.max(rect.top+2,Math.min(rect.bottom-2,innerHeight/2));
      if(!image.contains(document.elementFromPoint(x,y)))throw Error('The fixture page is not reachable for wheel input.');
      globalThis.__qaWheelEvents=[];globalThis.__qaWheelEventRefs=[];
      globalThis.__qaWheelListener=event=>{if(!event.target.closest?.('[data-observe-browser="point"]'))return;const item={trusted:event.isTrusted,cancelable:event.cancelable,deltaX:event.deltaX,deltaY:event.deltaY,clientX:event.clientX,clientY:event.clientY};globalThis.__qaWheelEvents.push(item);globalThis.__qaWheelEventRefs.push(event);};
      document.addEventListener('wheel',globalThis.__qaWheelListener,true);
      return{x,y,expectedX:Math.floor((x-rect.left)/rect.width*960),expectedY:Math.floor((y-rect.top)/rect.height*540),ownerScroll:document.querySelector('#observe-browser').closest('.observe-scroll').scrollTop};
    });
    const deltas=[[0,80],[25,45],[-10,-20],[0,30],[5,25]],hold=deferred();contained.scrollHold=hold;
    const expected={deltaX:deltas.reduce((sum,item)=>sum+item[0],0),deltaY:deltas.reduce((sum,item)=>sum+item[1],0)};
    const readWheelEvents=()=>evaluate(()=>globalThis.__qaWheelEvents.map((item,index)=>({...item,prevented:globalThis.__qaWheelEventRefs[index].defaultPrevented})));
    report.wheel={point:wheelPoint,expected,events:[],requests:[]};
    const releaseTimer=setTimeout(()=>hold.resolve(),6500);
    try{
      for(let index=0;index<deltas.length;index++){
        const[deltaX,deltaY]=deltas[index];await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:wheelPoint.x,y:wheelPoint.y,deltaX,deltaY,modifiers:0},session);
        await until('trusted wheel event '+index,()=>evaluate(count=>globalThis.__qaWheelEvents.length>=count,index+1));
        if(index===0)await until('first guarded wheel request held by fixture',()=>hold.started===true);
      }
      check('Wheel events can arrive during a pending page receipt',pages('scroll').length===scrollStart+1);
      hold.resolve();
      await until('all wheel delta reaches the selected page exactly once',()=>{const receipts=pages('scroll').slice(scrollStart);return Math.abs(receipts.reduce((sum,item)=>sum+item.deltaX,0)-expected.deltaX)<0.01&&Math.abs(receipts.reduce((sum,item)=>sum+item.deltaY,0)-expected.deltaY)<0.01;});
      await until('wheel scrolling refreshes the preview',()=>pages('screenshot').length>wheelCaptureStart);await settled();
      const receipts=pages('scroll').slice(scrollStart),identity=contained.identity(contained.tabs.find(tab=>tab.tabId==='qa-tab-2'));
      const wheelEvents=await readWheelEvents();report.wheel.events=wheelEvents;report.wheel.requests=receipts;
      check('Wheel and trackpad deltas retain the exact page identity and mapped point',receipts.length<=deltas.length&&receipts.every(item=>item.tabId===identity.tabId&&item.browser==='relay'&&item.expectedUrl===identity.url&&item.expectedDocumentId===identity.documentId&&Math.abs(item.x-wheelPoint.expectedX)<=1&&Math.abs(item.y-wheelPoint.expectedY)<=1));
      check('Every tested wheel event is trusted and consumed by the contained page',wheelEvents.length===deltas.length&&wheelEvents.every(item=>item.trusted&&item.prevented));
      check('Wheel scrolling preserves the unsent address and does not scroll the surrounding workspace',await addressValue()===addressDraft&&await evaluate(before=>Math.abs(document.querySelector('#observe-browser').closest('.observe-scroll').scrollTop-before)<2,wheelPoint.ownerScroll));
    }finally{
      clearTimeout(releaseTimer);hold.resolve();contained.scrollHold=null;
      report.wheel.requests=pages('scroll').slice(scrollStart);
      try{report.wheel.events=await readWheelEvents();}catch(error){report.wheel.observationError=String(error);}
      await evaluate(()=>{document.removeEventListener('wheel',globalThis.__qaWheelListener,true);delete globalThis.__qaWheelListener;}).catch(()=>{});
    }
    await browserFirstView();await capture('browser-after-actions-1440');
    report.behaviorMutations=mutations();
  }
  report.pageActions=contained.requests.filter(request=>request.kind==='page');
  check('Real frontend has no uncaught exceptions',report.pageErrors.length===0);
  check('No external website requests',report.networkUrls.filter(url=>/^https?:/.test(url)&&new URL(url).origin!==origin).length===0);
  check('No model calls',runtime.calls.length===0);
  if(report.stage==='before')check('Baseline capture did not submit browser navigation',!contained.requests.some(request=>['open','navigate'].includes(request.action)));
  report.after=await hashes();check('Candidate files unchanged during capture',JSON.stringify(report.before)===JSON.stringify(report.after));report.ok=true;
}
try { await main(); } catch(error) {
  report.ok=false;report.error=error.stack||String(error);console.error(report.error);
  report.pageActions=structuredClone(containedFixture?.requests.filter(request=>request.kind==='page')||[]);
  report.failureDiagnostics={activeTab:containedFixture?.activeTab,tabs:structuredClone(containedFixture?.tabs||[]),pageActions:report.pageActions,...(report.wheel?{wheel:report.wheel}:{})};
  if(readUIDiagnostics){try{report.failureDiagnostics.ui=await readUIDiagnostics();}catch(diagnosticError){report.failureDiagnostics.uiError=String(diagnosticError);}}
  if(cdp&&session){try{const{data}=await cdp.call('Page.captureScreenshot',{format:'jpeg',quality:75,fromSurface:true,captureBeyondViewport:false},session);await fs.writeFile(path.join(out,'failure.jpg'),Buffer.from(data,'base64'));}catch{}}
} finally {
  if(cdp){try{await cdp.call('Browser.close');}catch{}cdp.close();}
  if(browser&&browser.exitCode===null&&browser.signalCode===null){await Promise.race([once(browser,'exit'),delay(3000)]);if(browser.exitCode===null&&browser.signalCode===null){report.cleanupError='Owned headless browser did not exit normally';report.ok=false;}}
  await browserLog?.close().catch(()=>{});try{await app?.close();report.serverClosed=true;}catch(e){report.cleanupError=e.message;report.ok=false;}
  if(root){try{assert.ok(path.basename(root).startsWith('blackice-focused-ui-'));await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});report.disposableStateRemoved=true;}catch(e){report.cleanupError=e.message;report.ok=false;}}
  report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'browser-usability-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,screenshots:report.screenshots.length,report:path.join(out,'browser-usability-report.json'),error:report.error,cleanupError:report.cleanupError}));if(!report.ok)process.exitCode=1;
}
