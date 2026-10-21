import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {DesktopStartup, createStartupIndicator} from '../desktop/startup.mjs';

const held=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function windows({failLoad=false}={}){
  const created=[];
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.visible=false;this.destroyed=false;this.shows=0;this.loads=[];const contents=new EventEmitter();contents.session={webRequest:{onBeforeRequest:fn=>{contents.request=fn;}},setPermissionRequestHandler:fn=>{contents.permission=fn;},setPermissionCheckHandler:fn=>{contents.permissionCheck=fn;},setDevicePermissionHandler:fn=>{contents.devicePermission=fn;},setUSBProtectedClassesHandler:fn=>{contents.usbProtectedClasses=fn;}};contents.setWindowOpenHandler=fn=>{contents.open=fn;};this.webContents=contents;created.push(this);}
    removeMenu(){this.menuRemoved=true;}
    isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}
    show(){this.visible=true;this.shows++;this.emit('show');}
    destroy(){this.destroyed=true;this.visible=false;this.emit('closed');}
    loadURL(url){this.loads.push(url);return failLoad?Promise.reject(new Error('fixture load failure')):Promise.resolve();}
    userClose(){this.emit('close');this.destroy();}
  }
  return {Window,created};
}

test('the static startup indicator is isolated and becomes visible only after its first frame',async()=>{
  const f=windows(),indicator=createStartupIndicator({BrowserWindow:f.Window});assert.equal(f.created.length,1);const window=f.created[0];
  assert.equal(window.visible,false);assert.equal(window.options.show,false);assert.equal(window.menuRemoved,true);
  assert.deepEqual(window.options.webPreferences,{partition:'blackice-startup',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,devTools:false,spellcheck:false});
  assert.equal('preload' in window.options.webPreferences,false);assert.equal(window.options.webPreferences.partition.startsWith('persist:'),false);
  await tick();const url=window.loads[0],html=decodeURIComponent(url.split(',').slice(1).join(','));
  assert.match(html,/Starting BLACKICE…/);assert.match(html,/Preparing your workspace/);assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/prefers-reduced-motion/);
  assert.doesNotMatch(html,/<script|<iframe|<img|https?:\/\/|ipcRenderer|cookie|localStorage/i);
  assert.deepEqual(window.webContents.open({url:'https://external.invalid'}),{action:'deny'});
  for(const name of ['will-navigate','will-redirect','will-attach-webview']){let prevented=false;window.webContents.emit(name,{preventDefault(){prevented=true;}});assert.equal(prevented,true);}
  let admitted;window.webContents.request({url},value=>{admitted=value;});assert.deepEqual(admitted,{cancel:false});window.webContents.request({url:'https://external.invalid'},value=>{admitted=value;});assert.deepEqual(admitted,{cancel:true});
  window.webContents.permission(null,'camera',value=>{admitted=value;});assert.equal(admitted,true);assert.equal(window.webContents.permissionCheck(),true);assert.equal(window.webContents.devicePermission({deviceType:'usb'}),true);assert.deepEqual(window.webContents.usbProtectedClasses({protectedClasses:['hid']}),[]);
  window.emit('ready-to-show');assert.equal(await indicator.ready,true);assert.equal(window.visible,true);indicator.dispose();assert.equal(window.destroyed,true);
});

test('handoff keeps the indicator until the real workspace is both ready and visible',async()=>{
  const f=windows(),indicator=createStartupIndicator({BrowserWindow:f.Window});const window=f.created[0];window.emit('ready-to-show');await indicator.ready;
  let visible=false;const workspace={isDestroyed:()=>false,isVisible:()=>visible};
  assert.equal(indicator.handoff(workspace,false),false);assert.equal(indicator.handoff(workspace,true),false);assert.equal(window.destroyed,false);
  visible=true;assert.equal(indicator.handoff(workspace,false),false);assert.equal(window.destroyed,false);assert.equal(indicator.handoff(workspace,true),true);assert.equal(window.destroyed,true);
});

test('normal startup shows progress before a held backend and disposes it after workspace handoff',async()=>{
  const f=windows(),gate=held(),order=[];let indicator;
  const startup=new DesktopStartup({createIndicator(){order.push('indicator');return indicator=createStartupIndicator({BrowserWindow:f.Window});}});
  const initializing=(async()=>{await startup.step(async()=>{order.push('maintenance');});await startup.step(async()=>{order.push('restore');});await startup.showIndicator();await startup.step(async()=>{order.push('backend');await gate.promise;});})();
  await tick();assert.deepEqual(order,['maintenance','restore','indicator']);const window=f.created[0];window.emit('ready-to-show');await tick();assert.deepEqual(order,['maintenance','restore','indicator','backend']);assert.equal(window.visible,true);
  gate.resolve();await initializing;assert.equal(startup.handoff({isVisible:()=>true,isDestroyed:()=>false},true),true);assert.equal(window.destroyed,true);
});

test('headless startup constructs no indicator even while backend initialization is pending',async()=>{
  let created=0;const gate=held(),startup=new DesktopStartup({headless:true,createIndicator(){created++;throw Error('No headless window.');}});
  assert.equal(await startup.showIndicator(),false);const backend=startup.step(()=>gate.promise);await tick();assert.equal(created,0);gate.resolve();await backend;assert.equal(created,0);
});

test('quit before startup admits no work or windows',async()=>{
  let calls=0;const startup=new DesktopStartup({createIndicator(){calls++;}});startup.stop();
  await assert.rejects(startup.showIndicator(),{code:'BLACKICE_STARTUP_CANCELLED'});await assert.rejects(startup.step(()=>{calls++;}),{code:'BLACKICE_STARTUP_CANCELLED'});await startup.drain();assert.equal(calls,0);
});

test('closing the indicator requests quit once and a cancelled first paint never reveals it',async()=>{
  const f=windows();let quits=0;let startup;
  startup=new DesktopStartup({createIndicator:()=>createStartupIndicator({BrowserWindow:f.Window,onQuit(){quits++;startup.stop();}})});
  const showing=startup.showIndicator();await tick();const window=f.created[0];window.userClose();await assert.rejects(showing,{code:'BLACKICE_STARTUP_CANCELLED'});window.emit('ready-to-show');await startup.drain();assert.equal(window.shows,0);assert.equal(quits,1);
});

test('quit drains a held backend and closes its late instance without adopting it',async()=>{
  const gate=held(),started=held(),order=[],startup=new DesktopStartup();
  const initialization=startup.step(async()=>{started.resolve();return gate.promise;},async value=>{order.push('close-late');await value.close();});
  await started.promise;startup.stop();let drained=false;const draining=startup.drain().then(()=>{drained=true;});await tick();assert.equal(drained,false);
  gate.resolve({async close(){order.push('closed');}});await assert.rejects(initialization,{code:'BLACKICE_STARTUP_CANCELLED'});await draining;assert.deepEqual(order,['close-late','closed']);assert.equal(drained,true);
});

test('initialization errors remain visible to the caller and stop cleans the startup window',async()=>{
  const f=windows(),startup=new DesktopStartup({createIndicator:()=>createStartupIndicator({BrowserWindow:f.Window})});const showing=startup.showIndicator();await tick();f.created[0].emit('ready-to-show');await showing;
  await assert.rejects(startup.step(()=>{throw Error('fixture backend failure');}),/fixture backend failure/);startup.stop();await startup.drain();assert.equal(f.created[0].destroyed,true);assert.equal(startup.handoff({isVisible:()=>true,isDestroyed:()=>false},true),false);
});

test('shutdown closes an assigned harness before draining the workspace load it releases',async()=>{
  const loading=held(),entered=held(),order=[],startup=new DesktopStartup();
  const workspace=startup.step(async()=>{entered.resolve();await loading.promise;order.push('load-settled');});
  await entered.promise;startup.stop();
  await startup.drainAfter(async()=>{order.push('harness-close');loading.resolve();});
  await assert.rejects(workspace,{code:'BLACKICE_STARTUP_CANCELLED'});assert.deepEqual(order,['harness-close','load-settled']);
});

test('a failed static page load rejects safely and stop removes the failed indicator',async()=>{
  const f=windows({failLoad:true}),startup=new DesktopStartup({createIndicator:()=>createStartupIndicator({BrowserWindow:f.Window})});
  await assert.rejects(startup.showIndicator(),{message:'The BLACKICE startup window could not be loaded.'});startup.stop();await startup.drain();assert.equal(f.created[0].shows,0);assert.equal(f.created[0].destroyed,true);
});

test('desktop wiring preserves recovery ordering, window security, cancellation and packaged helper',async()=>{
  const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8'),builder=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');
  const start=source.slice(source.indexOf('app.whenReady().then(async () => {'));
  assert.ok(start.indexOf('awaitProfileMaintenance')<start.indexOf('recoverProfileRestore'));assert.ok(start.indexOf('recoverProfileRestore')<start.indexOf('startup.showIndicator()'));assert.ok(start.indexOf('startup.showIndicator()')<start.indexOf('startLocalHarness(dataDir, defaultCwd)'));
  assert.match(source,/headless: launch\.headless \|\| launch\.background, createIndicator:/);assert.match(source,/else if \(launch\.quit\)/);
  assert.match(source,/startup\.step\(\(\) => startLocalHarness\(dataDir, defaultCwd\), value => value\.instance\.close\(\)\)/);
  assert.match(source,/desktopLifecycle\.stop\(\);\s*startup\.stop\(\)/);assert.match(source,/startup\.drainAfter\(\(\) => harness\?\.close\(\)\)/);
  assert.match(source,/mainWindow\.on\('show', handoffStartup\)/);assert.match(source,/startup\.handoff\(mainWindow, readyToShow\)/);assert.match(source,/!startup\.stopped && !desktopLifecycle\.stopped/);
  assert.match(source,/preload: path\.join\(DESKTOP_DIR, 'preload\.cjs'\)/);assert.match(source,/nodeIntegration: false, contextIsolation: true, sandbox: true/);assert.match(source,/\.\.\.\(windowState\.bounds \|\| \{\}\)/);
  assert.match(builder,/^  - desktop\/(?:startup\.mjs|\*\*\/\*\.mjs)$/m,'the desktop runtime files must include the startup indicator');
});
