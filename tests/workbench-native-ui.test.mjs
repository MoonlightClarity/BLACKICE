import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkbenchWorkspace} from '../public/next/workspaces/workbench.mjs';
const tick=async()=>{for(let index=0;index<12;index++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
class Element{
  constructor(id=''){Object.assign(this,{id,handlers:new Map(),children:[],dataset:{},hidden:false,disabled:false,open:false,value:'',checked:false,textContent:''});}
  addEventListener(name,handler){const list=this.handlers.get(name)||[];list.push(handler);this.handlers.set(name,list);}
  emit(name,event={}){if(name==='click'&&this.disabled)return;for(const fn of this.handlers.get(name)||[])fn({preventDefault(){},...event});}
  append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}
  querySelector(selector){if(selector==='button')return this.button??=new Element('nested-button');return null;}
  querySelectorAll(){return [];}
  removeAttribute(name){if(name==='src')this.src='';}
}
async function fixture(t,{owner='agent',capabilityAvailable=true,apiHandler,nativeHandler,legacyMedia=[]}={}){
  const saved=new Map(['document','relayDesktop','fetch','setInterval','clearInterval'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const elements=new Map(),nativeCalls=[],apiCalls=[],fetches=[],timers=new Map();let html='',timerId=0;
  const mount=new Element('mount');Object.defineProperty(mount,'innerHTML',{get:()=>html,set:value=>{html=value;elements.clear();
    for(const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const el=new Element(match[1]);el.hidden=/\bhidden\b/.test(match[0]);el.disabled=/\bdisabled\b/.test(match[0]);el.checked=/\bchecked\b/.test(match[0]);elements.set(el.id,el);}}});
  mount.querySelector=selector=>elements.get(selector.slice(1))||null;mount.querySelectorAll=()=>legacyMedia;
  mount.replaceChildren=()=>{html='';elements.clear();};
  globalThis.document={createElement:tag=>new Element(tag)};globalThis.fetch=async(...args)=>{fetches.push(args);throw Error('No page capture transport permitted');};
  globalThis.setInterval=(fn,period)=>{const id=++timerId;timers.set(id,{fn,period});return id;};globalThis.clearInterval=id=>timers.delete(id);
  const status={capability:{edition:'Windows 11 Pro',processElevated:true,canManageVM:true},guest:{exists:true,running:true,state:'Running',agent:{paired:true,guestSessionId:2,sharedReadWriteVerified:true,capabilities:['batch_install']}},
    consoleControl:{owner,revision:4},canStart:false,canStop:true,canReadGuestConsole:true,canRunNativeApps:true,canPrepareAgent:true,canPair:true,canProvision:false,
    config:{revision:1,mediaPath:'C:\\saved.iso',folders:[{id:'workspace',hostPath:'C:\\workspace',expectedGuestUNC:'\\\\host\\workspace',readWrite:true}]},media:{valid:true},blockers:[]};
  const native={detached:true,connected:false,displayReady:false,windowVisible:false,windowMinimized:false,inputOwner:owner};
  const appSync={currentSnapshot:{snapshotId:'snapshot',packageCount:3,unmatchedCount:0,createdAt:'2026-11-01T00:00:00Z',recovery:{status:'completed'}},runs:[]};
  globalThis.relayDesktop={vmSurface:async request=>{nativeCalls.push(request);if(nativeHandler){const result=await nativeHandler(request,{native,status});if(result!==undefined){if(request.action==='attach')Object.assign(native,result);return result;}}
    if(request.action==='capability')return {available:capabilityAvailable,accepted:capabilityAvailable,localPreview:true,fullAcceptance:false,detachedWindow:true};
    if(request.action==='attach')Object.assign(native,{connected:true,displayReady:true,windowVisible:true});
    if(request.action==='visible')Object.assign(native,{windowVisible:request.visible,windowMinimized:false});
    return structuredClone(native);}};
  const api=async(route,method,body)=>{apiCalls.push({route,method,body});if(apiHandler){const result=await apiHandler({route,method,body,status,appSync});if(result!==undefined)return result;}
    if(route==='/api/workbench/config'){Object.assign(status.config,body,{revision:status.config.revision+1});return structuredClone(status);}
    if(route==='/api/workbench/app-sync')return structuredClone(appSync);return structuredClone(status);};
  const workspace=createWorkbenchWorkspace({mount,api});t.after(()=>{workspace.destroy();for(const[name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const el=name=>elements.get('wb-'+name),enter=async()=>{workspace.enter();await tick();},open=async()=>{await enter();el('open-window').emit('click');await tick();};
  return {workspace,mount,el,status,native,appSync,nativeCalls,apiCalls,fetches,timers,enter,open};
}
test('Workbench uses the BLACKICE launcher/setup layout with no compatibility or embedded console baggage',async t=>{
  const f=await fixture(t);await f.enter();assert.match(f.mount.innerHTML,/next-panel next-workbench/);assert.match(f.mount.innerHTML,/data-workbench-view="launcher-v2"/);
  assert.match(f.mount.innerHTML,/next-panel-head/);assert.match(f.mount.innerHTML,/Advanced setup/);assert.equal(f.el('vm-settings').open,false);
  assert.doesNotMatch(f.mount.innerHTML,/wb-inspector|wb-console|wb-compatibility|wb-share-clipboard|wb-wake|wb-stop|<canvas|<img|<iframe/);
  const css=await readFile(new URL('../public/next/workbench.css',import.meta.url),'utf8');
  assert.match(css,/var\(--panel\)|shared BLACKICE panel/);assert.doesNotMatch(css,/wb-inspector|fullscreen|position:fixed|wb-vm-workspace|wb-sharing-controls/);
});
test('activation and polling read status only, with no inline stream, capture, input or automatic attach',async t=>{
  const f=await fixture(t);await f.enter();assert.deepEqual(f.nativeCalls.map(call=>call.action),['capability','status']);
  for(const timer of f.timers.values())timer.fn();await tick();
  assert.equal(f.nativeCalls.every(call=>['capability','status'].includes(call.action)),true);
  assert.equal(f.apiCalls.every(call=>call.route==='/api/workbench'&&call.method==='GET'),true);assert.equal(f.fetches.length,0);
  assert.equal(f.el('open-window').disabled,false);assert.equal(f.status.consoleControl.owner,'agent');
});
test('only explicit Open attaches one detached window and never changes ownership or feature preferences',async t=>{
  const f=await fixture(t,{owner:'user'});await f.enter();assert.equal(f.native.connected,false);f.el('open-window').emit('click');f.el('open-window').emit('click');await tick();
  assert.equal(f.nativeCalls.filter(call=>call.action==='attach').length,1);assert.equal(f.el('open-window').textContent,'Show Workbench');assert.equal(f.native.windowVisible,true);
  assert.equal(f.status.consoleControl.owner,'user');assert.equal(f.apiCalls.some(call=>call.method==='POST'),false);assert.equal(f.fetches.length,0);
});
test('Show restores the same minimized or hidden USER window without attaching another session',async t=>{
  const f=await fixture(t,{owner:'user'});Object.assign(f.native,{connected:true,displayReady:true,windowVisible:false,windowMinimized:true});await f.enter();
  assert.match(f.el('window-status').textContent,/minimized/);f.el('open-window').emit('click');await tick();
  assert.equal(f.nativeCalls.some(call=>call.action==='attach'),false);assert.deepEqual(f.nativeCalls.find(call=>call.action==='visible'),{action:'visible',visible:true});
  assert.equal(f.native.windowMinimized,false);assert.equal(f.status.consoleControl.owner,'user');
});
test('leave/destroy stop launcher polling and retain the already authorized native window',async t=>{
  const pending=deferred();const f=await fixture(t,{nativeHandler:request=>request.action==='attach'?pending.promise:undefined});await f.enter();
  f.el('open-window').emit('click');await tick();f.workspace.leave();assert.equal(f.timers.size,0);
  pending.resolve({detached:true,connected:true,displayReady:true,windowVisible:true});await tick();assert.equal(f.native.connected,true);
  await f.enter();assert.equal(f.nativeCalls.filter(call=>call.action==='attach').length,1);f.workspace.destroy();
  assert.equal(f.timers.size,0);assert.equal(f.nativeCalls.some(call=>call.action==='close'||call.action==='visible'&&!call.visible),false);
});
test('failed explicit Open is not replayed by refresh, polling or tab re-entry',async t=>{
  const f=await fixture(t,{nativeHandler:request=>{if(request.action==='attach')throw Error('Native connection unavailable');}});await f.open();
  assert.match(f.el('error').textContent,/Native connection unavailable/);f.el('refresh').emit('click');await tick();
  for(const timer of f.timers.values())timer.fn();await tick();f.workspace.leave();await f.enter();assert.equal(f.nativeCalls.filter(call=>call.action==='attach').length,1);
});
test('unavailable native builds and disabled ownership remain honest without reviving inline controls',async t=>{
  for(const settings of [{capabilityAvailable:false},{owner:'none'}])await t.test(JSON.stringify(settings),async t=>{
    const f=await fixture(t,settings);await f.enter();assert.equal(f.el('open-window').disabled,true);f.el('open-window').emit('click');await tick();
    assert.equal(f.nativeCalls.some(call=>call.action==='attach'),false);assert.equal(f.mount.querySelector('#wb-compatibility'),null);assert.equal(f.mount.querySelector('#wb-console-take'),null);
  });
});
test('Start VM is explicit and never automatically opens a native window after Running',async t=>{
  const f=await fixture(t,{apiHandler:({route,status})=>{if(route==='/api/workbench/start'){Object.assign(status.guest,{running:true,state:'Running'});Object.assign(status,{canStart:false,canReadGuestConsole:true});return structuredClone(status);}}});
  Object.assign(f.status.guest,{running:false,state:'Off'});Object.assign(f.status,{canStart:true,canReadGuestConsole:false});await f.enter();
  assert.equal(f.el('start').hidden,false);assert.equal(f.el('open-window').disabled,true);f.el('start').emit('click');await tick();
  assert.equal(f.apiCalls.filter(call=>call.route==='/api/workbench/start').length,1);assert.equal(f.nativeCalls.some(call=>call.action==='attach'),false);
  assert.equal(f.el('start').hidden,true);assert.equal(f.el('open-window').disabled,false);
});
test('ISO edits survive background refresh and save with the current configuration revision',async t=>{
  const f=await fixture(t);await f.enter();f.el('iso-path').value='C:\\new.iso';f.el('iso-path').emit('input');f.el('refresh').emit('click');await tick();
  assert.equal(f.el('iso-path').value,'C:\\new.iso');assert.match(f.el('media-status').textContent,/unsaved/);
  f.el('save-iso').emit('click');await tick();assert.deepEqual(f.apiCalls.find(call=>call.route==='/api/workbench/config').body,{expectedRevision:1,mediaPath:'C:\\new.iso'});
  assert.equal(f.status.config.mediaPath,'C:\\new.iso');assert.match(f.el('media-status').textContent,/Saved/);assert.equal(f.nativeCalls.some(call=>call.action==='attach'),false);
});
test('folder mapping and explicit preparation/pairing retain their existing setup APIs',async t=>{
  const f=await fixture(t);await f.enter();f.el('host-path').value='C:\\Files\\Example';f.el('read-write').checked=true;f.el('add-folder').emit('submit');await tick();
  const config=f.apiCalls.find(call=>call.route==='/api/workbench/config').body;assert.equal(config.expectedRevision,1);assert.equal(config.folders.length,2);assert.equal(config.folders[1].hostPath,'C:\\Files\\Example');assert.equal(config.folders[1].readWrite,true);
  f.el('prepare-agent').emit('click');await tick();f.el('pair').emit('click');await tick();
  for(const route of ['/api/workbench/prepare-agent','/api/workbench/pair'])assert.deepEqual(f.apiCalls.find(call=>call.route===route).body,{});
  assert.equal(f.apiCalls.some(call=>/guest-command|native\/input|console\/control|desktop\/stream/.test(call.route)),false);
});
test('app inventory is lazy and scan/discovery/rebatch/retry remain explicit under Advanced setup',async t=>{
  const f=await fixture(t,{apiHandler:({route})=>route==='/api/workbench/app-sync/export'?{snapshotId:'new-snapshot',packageCount:3,unmatchedCount:0}:route==='/api/workbench/app-sync/discover'?{status:'completed'}:undefined});await f.enter();
  assert.equal(f.apiCalls.some(call=>call.route.startsWith('/api/workbench/app-sync')),false);f.el('vm-settings').open=true;f.el('vm-settings').emit('toggle');await tick();
  assert.equal(f.apiCalls.filter(call=>call.route==='/api/workbench/app-sync').length,1);
  for(const id of ['apps-scan','apps-rebatch','apps-retry']){f.el(id).emit('click');await tick();}
  for(const route of ['/api/workbench/app-sync/export','/api/workbench/app-sync/discover','/api/workbench/app-sync/rebatch','/api/workbench/app-sync/start'])assert.ok(f.apiCalls.some(call=>call.route===route),route);
  assert.deepEqual(f.apiCalls.find(call=>call.route==='/api/workbench/app-sync/discover').body,{snapshotId:'new-snapshot'});
});
test('mount replacement cancels legacy media source before creating the launcher',async t=>{
  const media=new Element('old-inline-image');media.src='/api/workbench/desktop/stream?v=old';media.onload=()=>{};media.onerror=()=>{};
  const f=await fixture(t,{legacyMedia:[media]});assert.equal(media.src,'');assert.equal(media.onload,null);assert.equal(media.onerror,null);await f.enter();assert.equal(f.fetches.length,0);
});
