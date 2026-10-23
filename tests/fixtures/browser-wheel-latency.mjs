/** Real native wheel acceptance, launched only with a new owned profile. */
import { app, BrowserWindow, session, screen } from 'electron';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option('fixture-root'), nonce = option('fixture-nonce'), resultFile = option('fixture-result');
if (!root || !path.isAbsolute(root) || !/^blackice-browser-rebuild-/.test(path.basename(root)) || !resultFile || !path.isAbsolute(resultFile)) throw Error('Use verify-browser-rebuild.mjs --wheel-only and its new disposable profile.');
const marker = JSON.parse(readFileSync(path.join(root, 'fixture-marker.json'), 'utf8'));
if (marker.suite !== 'native-browser-wheel' || marker.nonce !== nonce) throw Error('The disposable fixture marker does not match.');
const sourceRoot=option('source-root');if(!sourceRoot||!path.isAbsolute(sourceRoot))throw Error('Supply the measured source root.');
const {createHarnessServer}=await import(pathToFileURL(path.join(sourceRoot,'server.mjs')));
const {ElectronBrowserDriver}=await import(pathToFileURL(path.join(sourceRoot,'desktop/browser-driver.mjs')));
const {BrowserRouter}=await import(pathToFileURL(path.join(sourceRoot,'desktop/browser-router.mjs')));
const {BrowserWorkspace}=await import(pathToFileURL(path.join(sourceRoot,'lib/browser.mjs')));
const profile = path.join(root, 'profile'), dataDir = path.join(root, 'data');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('BLACKICE isolated browser wheel acceptance');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 0.0.0.0, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const report = { format: 1, suite: 'native-browser-wheel', fixtureNonce: nonce, platform: process.platform, electron: process.versions.electron, node: process.versions.node, pid: process.pid,
  startedAt: new Date().toISOString(), actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, chain: ['BrowserWorkspace', 'BrowserRouter', 'ElectronBrowserDriver'], checks: [], stages: [], actions: [], requests: [], cleanup: { complete: false, errors: [] } };
let driver, browser, server, frontend, harness, foregrounded = false, finished = false;
const sockets = new Set(), save = () => writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
const stage = name => { report.stage = name; report.stages.push({ name, at: new Date().toISOString() }); save(); };
const check = (name, fn) => { fn(); report.checks.push(name); save(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read, matches, ms = 5000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (matches(value)) return value; await wait(30); } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}
async function action(args) {
  const start = Date.now(), result = await browser.perform({ browser: 'relay', ...args }, { source: 'user' });
  report.actions.push({ action: args.action, milliseconds: Date.now() - start }); return result;
}
const guard = page => ({ tabId: page.tabId, expectedUrl: page.url, expectedDocumentId: page.documentId });
const documentHTML = `<!doctype html><meta charset="utf-8"><title>Owned wheel fixture</title>
  <style>body{margin:0;height:4000px;background:linear-gradient(#fff,#cbd5e1);font:18px sans-serif}h1{margin:20px} .pane{position:fixed;top:100px;left:100px;width:360px;height:240px;overflow:auto;overscroll-behavior:contain;border:2px solid #2563eb;background:#fff} .content{width:1200px;height:1800px;background:repeating-linear-gradient(0deg,#e0f2fe 0 60px,#fff 60px 120px)}#blocked{left:600px;width:240px}label{position:fixed;top:30px;left:600px}</style>
  <h1>Native wheel fixture</h1><div id="pane" class="pane"><div class="content">Nested scroll pane</div></div><div id="blocked" class="pane"><div class="content">Page handles this wheel itself</div></div>
  <script>globalThis.fixture={wheels:[],blocked:0};document.addEventListener('wheel',event=>{fixture.wheels.push({trusted:event.isTrusted,deltaX:event.deltaX,deltaY:event.deltaY,x:event.clientX,y:event.clientY});},{passive:true});document.querySelector('#blocked').addEventListener('wheel',event=>{event.preventDefault();fixture.blocked++;},{passive:false});</script>`;
const readState = contents => contents.executeJavaScript("({pageY:scrollY,paneX:document.querySelector('#pane').scrollLeft,paneY:document.querySelector('#pane').scrollTop,blockedY:document.querySelector('#blocked').scrollTop,wheels:fixture.wheels,blocked:fixture.blocked})");
const watchdog = setTimeout(() => { report.passed = false; report.error = 'Native wheel acceptance exceeded its deadline.'; report.forcedCleanup = true; save(); app.exit(1); }, 125000);


async function frontendAcceptance(contents) {
  stage('checking-real-frontend-wheel-route');
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  class OfflineRuntime extends EventEmitter {
    status() { return { connected: false, authenticated: false, activeTurns: 0, models: [], providers: [] }; }
    async init() {} async start() { return this.status(); } async close() {}
    async runAgent() { report.frontend.modelCalls++; throw Error('No model may run in native wheel acceptance.'); }
  }
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false, busy: false }); desktop.setEnabled = async () => desktop.status();
  const applications = new EventEmitter(); applications.status = () => ({ available: false, sessions: [], documents: [], supportedApps: [], documentStorage: { healthy: true } }); applications.close = async () => {};
  report.frontend = { previewRequests: [], imageTimings: [], widths: [], wheelRequests: [], wheelResponses: [], frontendEvents: [], externalRequests: 0, modelCalls: 0, pageErrors: [] };
  harness = await createHarnessServer({ port: 0, dataDir: path.join(root, 'frontend-data'), defaultCwd: workspace, runtime: new OfflineRuntime(), desktop, applicationWorkspace: applications, browser, autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: '' });
  await harness.learning.updateSettings({ mode: 'manual' });
  const base = await harness.listen();
  const frontendSession = session.fromPartition('persist:wheel-frontend-' + nonce);
  frontendSession.webRequest.onBeforeRequest((details, callback) => {
    const parsed = new URL(details.url);
    const allowed = ['data:', 'blob:', 'about:'].includes(parsed.protocol) || parsed.hostname === '127.0.0.1';
    if (!allowed) report.frontend.externalRequests++;
    callback({ cancel: !allowed });
  });
  frontend = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { session: frontendSession, offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, paintWhenInitiallyHidden: true } });
  const wc = frontend.webContents, debug = wc.debugger;
  stage('loading-real-frontend');
  await wc.loadURL(base);
  stage('attaching-real-frontend-input');
  debug.attach('1.3');
  debug.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') report.frontend.pageErrors.push(params.exceptionDetails?.text || 'exception');
    if (method === 'Network.requestWillBeSent' && params.request.method === 'POST') {
      const route = new URL(params.request.url).pathname;
      let value; try { value = JSON.parse(params.request.postData || '{}'); } catch { return; }
      if (value.action === 'screenshot') report.frontend.previewRequests.push({requestId:params.requestId,at:Date.now(),preview:value.preview===true});
      if (value.action === 'scroll') report.frontend.wheelRequests.push({ requestId: params.requestId, route, browser: value.browser, x: value.x, y: value.y, deltaX: value.deltaX, deltaY: value.deltaY, guarded: Boolean(value.expectedUrl && value.expectedDocumentId) });
    }
    if (method === 'Network.responseReceived' && report.frontend.wheelRequests.some(value => value.requestId === params.requestId)) report.frontend.wheelResponses.push({ requestId: params.requestId, status: params.response.status });
    const preview=report.frontend.previewRequests.find(value=>value.requestId===params.requestId);
    if(preview&&method==='Network.responseReceived'){preview.responseAt=Date.now();preview.status=params.response.status;}
    if(preview&&method==='Network.loadingFinished'){preview.loadedAt=Date.now();preview.encodedBytes=params.encodedDataLength;}
  });
  await Promise.all(['Runtime.enable', 'Network.enable'].map(method => debug.sendCommand(method)));
  const evaluate = expression => wc.executeJavaScript(expression);
  const visible = selector => evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');return !!(n&&n.getClientRects().length&&!n.closest("[hidden],[inert]"));})()');
  const waitVisible = selector => until(selector, () => visible(selector), Boolean, 15000);
  async function click(selector) {
    await waitVisible(selector);
    const point = await evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');n.scrollIntoView({block:"center",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(n.disabled||!n.contains(document.elementFromPoint(x,y)))throw Error("Control is not reachable");return{x,y};})()');
    for (const type of ['mousePressed', 'mouseReleased']) await debug.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
  stage('opening-real-frontend-browser-surface');
  await click('#workspace-modes [data-mode="observe"]');
  await click('[data-observe-surface="browser"]');
  await until('decoded actual browser preview', () => evaluate('(()=>{const n=document.querySelector("#observe-browser-image");return !!(n&&n.complete&&n.naturalWidth>1000&&!n.closest("button").disabled);})()'), Boolean, 15000);
  await evaluate('globalThis.__wheelAcceptance=[];document.addEventListener("wheel",event=>{const item={trusted:event.isTrusted,target:event.target.id,deltaX:event.deltaX,deltaY:event.deltaY,prevented:false};__wheelAcceptance.push(item);setTimeout(()=>item.prevented=event.defaultPrevented,0);},true);');
  async function pointAt(x, y) {
    return evaluate('(()=>{const n=document.querySelector("#observe-browser-image");n.scrollIntoView({block:"center",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+' + x + '*r.width/n.naturalWidth,y=r.top+' + y + '*r.height/n.naturalHeight;const hit=document.elementFromPoint(x,y);if(hit!==n||x<0||x>=innerWidth||y<0||y>=innerHeight||n.closest("button").disabled)throw Error("Preview point is not reachable");return{x,y,width:innerWidth,height:innerHeight,imageWidth:r.width,imageHeight:r.height,scrollY,activityScroll:document.querySelector(".observe-scroll")?.scrollTop||0};})()');
  }
  async function wheelAt(point, deltaX, deltaY) {
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, button: 'none' });
  }
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    stage('real-frontend-wheel-' + width);
    frontend.setContentSize(width, height);
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await until('frontend viewport width', () => evaluate('innerWidth'), value => value === width);
    await contents.executeJavaScript('scrollTo(0,0);document.querySelector("#pane").scrollTo(0,0);document.querySelector("#blocked").scrollTo(0,0);fixture.wheels=[];fixture.blocked=0;');
    await wait(150);
    const point = await pointAt(250, 200), requestsBefore = report.frontend.wheelRequests.length;
    await wheelAt(point, 72, 140);
    const moved = await until('real frontend wheel reaches native pane', () => readState(contents), value => value.paneX > 35 && value.paneY > 80);
    const frontendEvent = await until('trusted handled frontend wheel event', () => evaluate('__wheelAcceptance.at(-1)'), value => value?.trusted && value?.prevented);
    check('Actual ' + width + 'px preview routes a trusted pointer wheel through HTTP into the nested pane', () => {
      assert.equal(frontendEvent.target, 'observe-browser-image'); assert.equal(moved.pageY, 0); assert.equal(moved.wheels.length, 1); assert.equal(moved.wheels[0].trusted, true);
      assert.equal(moved.wheels[0].deltaX, 72); assert.equal(moved.wheels[0].deltaY, 140);
      assert.ok(report.frontend.wheelRequests.length > requestsBefore); assert.equal(report.frontend.wheelRequests.at(-1).guarded, true);
    });
    const blockedPoint = await pointAt(700, 200);
    await wheelAt(blockedPoint, 0, 200);
    const blocked = await until('cancelled wheel through actual frontend', () => readState(contents), value => value.blocked === 1);
    await wait(120);
    const unchanged = await readState(contents), localScroll = await evaluate('({scrollY,activityScroll:document.querySelector(".observe-scroll")?.scrollTop||0})');
    check('Actual ' + width + 'px preview respects page wheel cancellation and keeps Activity stationary', () => {
      assert.equal(blocked.blockedY, 0); assert.equal(unchanged.blockedY, 0); assert.equal(unchanged.pageY, 0);
      assert.equal(localScroll.scrollY, blockedPoint.scrollY); assert.equal(localScroll.activityScroll, blockedPoint.activityScroll);
      assert.equal(unchanged.wheels.length, 2); assert.ok(unchanged.wheels.every(value => value.trusted));
    });
    report.frontend.widths.push({ width, height, point, moved, cancelled: unchanged });
  }
  report.frontend.frontendEvents = await evaluate('__wheelAcceptance');
  check('The real frontend wheel route completes without page errors, model calls or external traffic', () => {
    assert.equal(report.frontend.wheelRequests.length, 4); assert.equal(report.frontend.wheelResponses.length, 4);
    assert.ok(report.frontend.wheelResponses.every(value => value.status === 200));
    assert.equal(report.frontend.pageErrors.length, 0); assert.equal(report.frontend.modelCalls, 0); assert.equal(report.frontend.externalRequests, 0);
  });

  // Measure what the frontend actually paints, rather than only an input receipt.
  stage('measuring-sustained-wheel-painted-feedback');
  await evaluate("(()=>{globalThis.__imageLatency=[];const record=(event,n)=>{const entry={event,at:Date.now(),role:n.id||'detached',codec:n.src?.slice(0,n.src.indexOf(';')),width:n.naturalWidth,height:n.naturalHeight};if(event==='load'&&n.id==='observe-browser-image'&&n.naturalWidth){try{const c=document.createElement('canvas');c.width=432;c.height=32;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(n,8,160,432,32,0,0,432,32);const pixels=ctx.getImageData(0,0,432,32).data;const pixel=i=>{const index=(16*432+i*24+12)*4;return{r:pixels[index],g:pixels[index+1],b:pixels[index+2]};};const a=pixel(0),b=pixel(17);if(a.g>160&&a.r<110&&a.b<110&&b.r>160&&b.b>160&&b.g<110){let value=0;for(let i=0;i<16;i++){const p=pixel(i+1);if(p.r+p.g+p.b>430)value|=1<<i;}entry.markerY=value;}}catch{entry.probeFailed=true;}}__imageLatency.push(entry);};const original=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=function(){record('decode-start',this);const result=original.call(this);result.then(()=>record('decode-end',this),()=>record('decode-error',this));return result;};document.addEventListener('load',event=>{if(event.target.id==='observe-browser-image')record('load',event.target);},true);let priorSource;const changed=()=>{const n=document.querySelector('#observe-browser-image');if(n&&n.src!==priorSource){priorSource=n.src;record('src',n);}};new MutationObserver(changed).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});changed();})()");
  await contents.executeJavaScript(`(()=>{
    document.querySelector('.content').style.height='10000px';
    document.querySelector('.content').style.width='10000px';
    const scene=document.createElement('div');scene.style.cssText='position:fixed;inset:0;display:grid;grid-template-columns:repeat(8,1fr);grid-auto-rows:110px;pointer-events:none;z-index:-1';for(let i=0;i<80;i++){const card=document.createElement('section');card.style.cssText='padding:8px;margin:3px;border:1px solid #64748b;border-radius:5px;background:linear-gradient(135deg,hsl('+((i*47)%360)+' 65% 86%),#fafafa);font:12px sans-serif;color:#183044';card.innerHTML='<b>Project '+(i+1)+'</b><p>Research, planning and delivery</p><small>Progress '+((i*13)%101)+'% · updated today</small>';scene.append(card);}document.body.append(scene);
    document.querySelector('#pane .content').innerHTML=Array.from({length:100},(_,i)=>'<p style="margin:0;padding:16px;border-bottom:1px solid #64748b">Task '+i+' · Scroll with both axes · Planning and delivery status</p>').join('');
    const marker=document.createElement('div');marker.id='latency-marker';
    marker.style.cssText='position:fixed;z-index:999999;left:8px;top:160px;display:flex;height:32px;pointer-events:none';
    for(let i=0;i<18;i++){const cell=document.createElement('span');cell.style.cssText='display:block;width:24px;height:32px';marker.append(cell);}
    document.body.append(marker);fixture.scrolls=[];
    const pane=document.querySelector('#pane');
    const update=()=>{const value=Math.round(pane.scrollTop);marker.children[0].style.background='#00ff00';marker.children[17].style.background='#ff00ff';for(let i=0;i<16;i++)marker.children[i+1].style.background=(value&(1<<i))?'#ffffff':'#000000';fixture.scrolls.push({at:Date.now(),y:value,x:pane.scrollLeft});};
    pane.addEventListener('scroll',update,{passive:true});update();
  })()`);
  report.performance = { measurement: 'actual-frontend-offscreen-paint-barcode', eventCount: 60, scheduledIntervalMs: 16, widths: [], pipeline: [], captures: [] };
  const originalWorkspacePerform = browser.perform.bind(browser), originalDriverPerform = driver.perform.bind(driver), originalCapture = driver.capture.bind(driver);
  const pendingTimings = [];
  browser.perform = async (args, options) => {
    if (!['scroll', 'screenshot'].includes(args.action)) return originalWorkspacePerform(args, options);
    const timing = { action: args.action, enqueuedAt: Date.now() }; pendingTimings.push(timing); report.performance.pipeline.push(timing);
    try { const value = await originalWorkspacePerform(args, options); timing.returnedAt = Date.now(); if (value.imageUrl) { timing.imageBytes = Math.floor(value.imageUrl.length * 3 / 4); timing.codec = value.imageUrl.slice(0, value.imageUrl.indexOf(';')); } return value; }
    catch (error) { timing.error = error.code || error.message; throw error; }
  };
  driver.perform = async (args, options) => {
    const timing = pendingTimings.find(value => value.action === args.action && value.startedAt === undefined);
    if (timing) { timing.startedAt = Date.now(); timing.queueMs = timing.startedAt - timing.enqueuedAt; }
    try { return await originalDriverPerform(args, options); }
    finally { if (timing) { timing.finishedAt = Date.now(); timing.driverMs = timing.finishedAt - timing.startedAt; } }
  };
  driver.capture = async (...args) => {
    const timing = { startedAt: Date.now() }; report.performance.captures.push(timing);
    try {
      const result=await originalCapture(...args);timing.copiedAt=Date.now();
      const crop=result.image.crop({x:8,y:160,width:432,height:32}),size=crop.getSize(),bitmap=crop.getBitmap();
      const pixel=cell=>{const x=Math.floor((cell+.5)*size.width/18),y=Math.floor(size.height/2),i=(y*size.width+x)*4;return{b:bitmap[i],g:bitmap[i+1],r:bitmap[i+2]};};
      const first=pixel(0),last=pixel(17);timing.markerY=null;
      if(first.g>160&&first.r<110&&first.b<110&&last.r>160&&last.b>160&&last.g<110){let value=0;for(let i=0;i<16;i++){const rgb=pixel(i+1);if(rgb.r+rgb.g+rgb.b>430)value|=1<<i;}timing.markerY=value;}
      return result;
    } finally { timing.finishedAt = Date.now(); timing.captureMs = (timing.copiedAt||timing.finishedAt) - timing.startedAt; timing.probeMs=timing.finishedAt-(timing.copiedAt||timing.finishedAt); }
  };
  let paintedTarget = null;
  const percentile = (values, p) => { const sorted = values.slice().sort((a,b)=>a-b); return sorted.length ? sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)] : null; };
  const samplePaint = (_event, _dirty, image) => {
    if (!paintedTarget) return;
    const target = paintedTarget, size = image.getSize(), bitmap = image.getBitmap();
    const pixel = cell => {
      const x = Math.floor((target.image.x + (8 + (cell + 0.5) * 24) * target.image.width / target.image.naturalWidth) * size.width / target.width);
      const y = Math.floor((target.image.y + 176 * target.image.height / target.image.naturalHeight) * size.height / target.height);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
      const index = (y * size.width + x) * 4; return { b: bitmap[index], g: bitmap[index+1], r: bitmap[index+2] };
    };
    const left = pixel(0), right = pixel(17);
    if (!left || !right || left.g < 160 || left.r > 110 || left.b > 110 || right.r < 160 || right.b < 160 || right.g > 110) { target.invalidPaints++; target.lastProbe={left,right,size,bitmapBytes:bitmap.length}; if(target.invalidPaints===10)writeFileSync(resultFile+'.paint-'+target.width+'.png',image.toPNG()); return; }
    let value = 0;
    for (let bit=0;bit<16;bit++) { const rgb=pixel(bit+1); if (rgb.r+rgb.g+rgb.b>430) value|=1<<bit; }
    const last = target.paints.at(-1);
    if (!last || value !== last.y) target.paints.push({ at: Date.now(), y: value });
  };
  wc.on('paint', samplePaint);
  try {
    for (const [width,height] of [[1440,900],[390,844]]) {
      stage('sustained-wheel-painted-' + width);
      frontend.setContentSize(width,height);
      await debug.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await until('latency viewport',()=>evaluate('innerWidth'),value=>value===width);
      await contents.executeJavaScript('scrollTo(0,0);document.querySelector("#pane").scrollTo(0,0);fixture.wheels=[];fixture.scrolls=[];');
      const point = await pointAt(250,200);
      const imageGeometry = await evaluate('(()=>{const n=document.querySelector("#observe-browser-image"),r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight};})()');
      const trial = {width,height,image:imageGeometry,point,paints:[],sends:[],invalidPaints:0,pipelineStart:report.performance.pipeline.length};
      trial.frontendViewport=await evaluate('({width:innerWidth,height:innerHeight,devicePixelRatio,visualViewport:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}})');
      trial.nativeViewport=await contents.executeJavaScript('({width:innerWidth,height:innerHeight,devicePixelRatio})');
      trial.frameRates={frontend:wc.getFrameRate(),native:contents.getFrameRate()};
      trial.warmup=[];for(let warm=0;warm<3;warm++){const at=Date.now();await browser.perform({action:'screenshot',browser:'relay',tabId:driver.activeTab},{source:'user'});trial.warmup.push({format:'ordinary-png',milliseconds:Date.now()-at});}
      paintedTarget=trial; report.performance.widths.push(trial);
      // Let the ordinary product polling display the new marker before input.
      await until('initial actual painted barcode',()=>trial.paints.at(-1),value=>value?.y===0,12000);
      trial.paints=[]; trial.invalidPaints=0;
      const baselineScroll = await readState(contents);
      assert.equal(baselineScroll.paneY,0); assert.equal(baselineScroll.pageY,0);
      await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none'});
      trial.startAt=Date.now(); const dispatched=[];
      for(let index=0;index<60;index++){
        const due=trial.startAt+index*16; if(Date.now()<due)await wait(due-Date.now());
        const send={index,dueAt:due,at:Date.now(),deltaX:3,deltaY:12};trial.sends.push(send);
        // Input generation follows the clock even while the product is waiting
        // for HTTP/capture receipts, as a real sustained trackpad gesture does.
        const delivered=debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:send.deltaX,deltaY:send.deltaY,button:'none'}).then(()=>{send.ackAt=Date.now();});
        delivered.catch(()=>{});dispatched.push(delivered);
      }
      trial.lastSentAt=trial.sends.at(-1).at;await Promise.all(dispatched);
      const finalState=await until('all sustained deltas reach native pane',()=>readState(contents),value=>value.paneY>=715&&value.paneX>=175,12000);
      trial.nativeReachedAt=Date.now();trial.native=finalState;
      await until('final position really painted in preview',()=>trial.paints.at(-1),value=>value?.y>=715,12000);
      trial.caughtUpAt=Date.now();
      trial.scrolls=await contents.executeJavaScript('fixture.scrolls');
      const moving=trial.paints.filter(value=>value.y>0),gaps=moving.slice(1).map((value,index)=>value.at-moving[index].at);
      const sendGaps=trial.sends.slice(1).map((value,index)=>value.at-trial.sends[index].at);
      const ages=moving.map(paint=>{const scroll=trial.scrolls.find(value=>value.y>=paint.y);return scroll?paint.at-scroll.at:null;}).filter(value=>value!==null);
      trial.metrics={firstPaintMs:moving[0].at-trial.startAt,paintedUpdates:moving.length,paintGapP95Ms:percentile(gaps,.95),paintGapMaxMs:gaps.length?Math.max(...gaps):null,paintAgeP95Ms:percentile(ages,.95),paintAgeMaxMs:ages.length?Math.max(...ages):null,tailDrainMs:Math.max(0,moving.at(-1).at-trial.lastSentAt),nativeDrainMs:Math.max(0,trial.nativeReachedAt-trial.lastSentAt),sendDurationMs:trial.lastSentAt-trial.startAt,sendGapP95Ms:percentile(sendGaps,.95),sendGapMaxMs:Math.max(...sendGaps),scheduledLatenessMaxMs:Math.max(...trial.sends.map(value=>value.at-value.dueAt)),deliveredDeltaY:finalState.wheels.reduce((sum,value)=>sum+value.deltaY,0),deliveredDeltaX:finalState.wheels.reduce((sum,value)=>sum+value.deltaX,0)};
      trial.imageTimings=(await evaluate('__imageLatency')).filter(value=>value.at>=trial.startAt&&value.at<=trial.caughtUpAt);
      const ready=trial.imageTimings.filter(value=>value.event==='load'&&value.role==='observe-browser-image'&&value.markerY>0);trial.metrics.firstDisplayReadyMs=ready.length?ready[0].at-trial.startAt:null;
      check('Sustained ' + width + 'px wheel reaches and visibly paints its final position',()=>{
        assert.equal(trial.sends.length,60);assert.equal(trial.metrics.deliveredDeltaY,720);assert.equal(trial.metrics.deliveredDeltaX,180);assert.ok(finalState.wheels.every(value=>value.trusted));assert.equal(finalState.pageY,0);assert.ok(moving.length>=2);assert.ok(Number.isFinite(trial.metrics.firstPaintMs));assert.ok(Number.isFinite(trial.metrics.firstDisplayReadyMs));assert.ok(trial.metrics.tailDrainMs<12000);
      });
      paintedTarget=null;save();await wait(500);
    }
  } finally { report.frontend.imageTimings=await evaluate('__imageLatency'); wc.removeListener('paint',samplePaint); browser.perform=originalWorkspacePerform;driver.perform=originalDriverPerform;driver.capture=originalCapture; }
  check('Sustained latency measurement makes no model calls, external requests or frontend errors',()=>{assert.equal(report.frontend.modelCalls,0);assert.equal(report.frontend.externalRequests,0);assert.equal(report.frontend.pageErrors.length,0);});

  frontend.destroy(); frontend = null;
}

async function main() {
  try {
    stage('starting-isolated-wheel-browser'); await app.whenReady();
    report.display={primary:screen.getPrimaryDisplay().id,all:screen.getAllDisplays().map(value=>({id:value.id,bounds:value.bounds,workArea:value.workArea,scaleFactor:value.scaleFactor,displayFrequency:value.displayFrequency,rotation:value.rotation})),frontendOffscreen:true,nativeOffscreen:true};
    app.on('browser-window-created', (_event, window) => { window.on('show', () => { foregrounded = true; }); window.on('focus', () => { foregrounded = true; }); });
    await fs.mkdir(dataDir, { recursive: true });
    server = http.createServer((request, response) => {
      report.requests.push({ path: request.url, method: request.method });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(documentHTML);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`; report.origin = origin;
    driver = await new ElectronBrowserDriver({ dataDir, downloadDir: path.join(root, 'downloads') }).init();
    browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }), timeoutMs: 10000 });
    let page = await action({ action: 'open', url: origin + '/' });
    const contents = driver.tab(page.tabId).window.webContents;
    const initialFrame = await action({ action: 'screenshot', tabId: page.tabId });
    check('A real hidden browser renders the owned fixture', () => { assert.match(initialFrame.imageUrl, /^data:image\/png;base64,/); assert.ok(Number.isFinite(initialFrame.width) && initialFrame.width > 1000); assert.ok(Number.isFinite(initialFrame.height) && initialFrame.height > 400); });

    stage('scrolling-nested-pane-in-both-axes');
    const moved = await action({ action: 'scroll', ...guard(page), x: 250, y: 200, deltaX: 120.5, deltaY: 180.5 });
    const nested = await until('nested pane to move', () => readState(contents), value => value.paneX > 50 && value.paneY > 100);
    check('Native wheel scrolls the nested pane in both axes without moving the outer page', () => {
      assert.equal(nested.pageY, 0); assert.equal(nested.wheels.length, 1); assert.equal(nested.wheels[0].trusted, true);
      assert.equal(nested.wheels[0].deltaX, 120.5); assert.equal(nested.wheels[0].deltaY, 180.5);
      assert.equal(moved.documentId, page.documentId); assert.equal(moved.frames, undefined); assert.equal(moved.receipt.scrolled, true);
    });
    await action({ action: 'scroll', ...guard(page), x: 250, y: 200, deltaX: -40, deltaY: -60 });
    const reversed = await until('nested pane reverse movement', () => readState(contents), value => value.paneX < nested.paneX && value.paneY < nested.paneY);
    check('Negative deltas reverse both nested scroll directions', () => { assert.equal(reversed.pageY, 0); assert.equal(reversed.wheels.length, 2); });

    stage('scrolling-document-and-respecting-page-wheel-handlers');
    await action({ action: 'scroll', ...guard(page), x: 1000, y: 400, deltaX: 0, deltaY: 320 });
    const down = await until('outer document to move down', () => readState(contents), value => value.pageY > 200);
    check('Wheel outside the pane scrolls the long document', () => { assert.equal(down.paneX, reversed.paneX); assert.equal(down.paneY, reversed.paneY); });
    await action({ action: 'scroll', ...guard(page), x: 1000, y: 400, deltaX: 0, deltaY: -160 });
    const up = await until('outer document to move up', () => readState(contents), value => value.pageY < down.pageY);
    check('Upward wheel gestures move the document in the expected direction', () => assert.ok(up.pageY < down.pageY));
    await action({ action: 'scroll', ...guard(page), x: 700, y: 200, deltaX: 0, deltaY: 200 });
    const handled = await until('page wheel handler', () => readState(contents), value => value.blocked === 1);
    await wait(100);
    const stable = await readState(contents);
    check('A page can handle and cancel its own trusted wheel event', () => { assert.equal(handled.blockedY, 0); assert.equal(stable.blockedY, 0); assert.equal(stable.pageY, up.pageY); assert.equal(stable.wheels.length, 5); assert.ok(stable.wheels.every(event => event.trusted)); });
    report.observed = { nested, reversed, down, up, handled: stable };
    await frontendAcceptance(contents);

    stage('rejecting-stale-input-and-closing-fixture');
    const stale = guard(page); page = await action({ action: 'navigate', tabId: page.tabId, url: origin + '/next' });
    await assert.rejects(action({ action: 'scroll', ...stale, x: 250, y: 200, deltaX: 0, deltaY: 120 }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
    check('A wheel from the old document never reaches a replacement page', () => assert.notEqual(page.documentId, stale.expectedDocumentId));
    assert.equal((await readState(contents)).wheels.length, 0);
    await action({ action: 'close', tabId: page.tabId });
    check('The disposable page closes and no browser window takes desktop focus', () => { assert.equal(browser.status().tabs.length, 0); assert.equal(foregrounded, false); assert.equal(BrowserWindow.getAllWindows().length, 0); });
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  finally {
    stage('closing-owned-wheel-fixture');
    frontend?.destroy(); frontend = null;
    try { if (harness) { await harness.close(); harness = null; } await (browser ? browser.close() : driver?.close()); } catch (error) { report.cleanup.errors.push(error.message); }
    if (server?.listening) {
      const closed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections?.(); server.closeAllConnections();
      for (const socket of sockets) socket.destroy(); await closed;
    }
    try { await until('owned fixture sockets to close', () => sockets.size, value => value === 0, 3000); }
    catch (error) { report.cleanup.errors.push(error.message); }
    report.cleanup.remainingWindows = BrowserWindow.getAllWindows().length; report.cleanup.remainingSockets = sockets.size;
    report.cleanup.complete = !report.cleanup.errors.length && report.cleanup.remainingWindows === 0 && report.cleanup.remainingSockets === 0;
    if (!report.cleanup.complete) report.passed = false;
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    finished = true; clearTimeout(watchdog); save(); if (report.passed) app.quit(); else app.exit(1);
  }
}
void main().catch(error => { if (finished) return; report.passed = false; report.error = error.stack || String(error); report.forcedCleanup = true; clearTimeout(watchdog); save(); app.exit(1); });
