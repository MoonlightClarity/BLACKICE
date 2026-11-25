import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {readFile} from 'node:fs/promises';
import {createQuitWindowGate} from '../desktop/quit-window-gate.mjs';
import {createNativeSafeQuitHandler} from '../desktop/native-parent-lifetime.mjs';
test('quit gate coalesces pending requests and preserves a vetoed window for another attempt',async()=>{
 const w=new EventEmitter();w.webContents=new EventEmitter();w.isDestroyed=()=>false;let closes=0;w.close=()=>{closes++;};
 const gate=createQuitWindowGate({getWindow:()=>w});const first=gate();assert.equal(gate(),first);assert.equal(closes,1);
 w.webContents.emit('will-prevent-unload',{});assert.equal(await first,false);assert.equal(w.listenerCount('closed'),0);
 const second=gate();w.emit('closed');assert.equal(await second,true);assert.equal(closes,2);
});
test('veto does not shut down services or start watchdog; next clean quit drains exactly once',async()=>{
 let allowed=false,shutdowns=0,timers=0,cancelled=0,released=0;
 const handler=createNativeSafeQuitHandler({host:{},prepareQuit:async()=>allowed,shutdown:async()=>{shutdowns++;},onRetained:()=>cancelled++,onReleased:()=>released++,onFailure:e=>{throw e;},setTimer:()=>++timers,clearTimer(){},onTimeout(){}});
 await handler({preventDefault(){}});assert.deepEqual([shutdowns,timers,cancelled,released],[0,0,1,0]);
 allowed=true;await Promise.all([handler({preventDefault(){}}),handler({preventDefault(){}})]);assert.deepEqual([shutdowns,timers,cancelled,released],[1,1,1,1]);
});
test('no window needs no negotiation; throwing close rejects without a dangling listener',async()=>{
 assert.equal(await createQuitWindowGate({getWindow:()=>null})(),true);
 const w=new EventEmitter();w.webContents=new EventEmitter();w.isDestroyed=()=>false;w.close=()=>{throw Error('renderer unavailable');};
 await assert.rejects(createQuitWindowGate({getWindow:()=>w})(),/renderer unavailable/);assert.equal(w.listenerCount('closed'),0);
});
test('frontend cleanup waits for accepted navigation, preserving the cancelled editor session',async()=>{
 const source=await readFile(new URL('../public/next/app.mjs',import.meta.url),'utf8');
 assert.match(source,/addEventListener\('pagehide'/);assert.doesNotMatch(source,/addEventListener\('beforeunload'/);
 const skills=await readFile(new URL('../public/next/workspaces/skills.mjs',import.meta.url),'utf8');
 const beforeUnload=skills.match(/const beforeUnload=event=>\{(.+?)\};hostWindow.addEventListener\('beforeunload',beforeUnload\)/)?.[1];
 assert.ok(beforeUnload,'Skills must register its unsaved editor gate.');
 assert.match(beforeUnload,/if\(drafts\.size\|\|\(newDraft&&newDraft\.content!=='# '\)\|\|rename\|\|\(creation&&el\('folder-name'\)\.value\.trim\(\)\)\)/);
 assert.match(beforeUnload,/event.preventDefault\(\);event.returnValue='';/);
});
test('desktop recovery remains active until accepted close, not before renderer veto',async()=>{
 const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
 assert.match(source,/onAllowed:\(\)=>\{void saveWindowState\(\);\}/);
 assert.doesNotMatch(source,/onAllowed:\(\)=>\{recovery.stop\(\)/);
 const recovery=await readFile(new URL('../desktop/renderer-recovery.mjs',import.meta.url),'utf8');
 assert.match(recovery,/this.listen\(window, 'closed', \(\) => this.stop\(\)\)/);
});

test('unanswered close times out, late close is owned and cannot authorize quit', async () => {
 const w=new EventEmitter();w.webContents=new EventEmitter();w.isDestroyed=()=>false;w.close=()=>w.emit('close',{});
 const late=[];let fire,cleared=0;
 const gate=createQuitWindowGate({getWindow:()=>w,setTimer:callback=>{fire=callback;return 1;},clearTimer:()=>cleared++,onLateClose:window=>late.push(window)});
 const pending=gate();assert.equal(gate.ownsClose(w),true);fire();
 await assert.rejects(pending,{code:'DESKTOP_RESTART_QUIT_TIMEOUT'});
 assert.equal(gate.ownsClose(w),true,'retired close still owns its late native outcome');
 w.emit('closed');await Promise.resolve();
 assert.deepEqual(late,[w]);assert.equal(w.listenerCount('closed'),0);assert.equal(w.webContents.listenerCount('will-prevent-unload'),0);assert.ok(cleared);
});

test('cancelled negotiation accepts neither a late veto nor an independent later close as approval',async()=>{
 const w=new EventEmitter();w.webContents=new EventEmitter();w.isDestroyed=()=>false;w.close=()=>w.emit('close',{});
 const abort=new AbortController();let late=0;const gate=createQuitWindowGate({getWindow:()=>w,onLateClose:()=>late++});
 const pending=gate({signal:abort.signal});abort.abort();await assert.rejects(pending,{code:'DESKTOP_RESTART_CANCELLED'});
 w.webContents.emit('will-prevent-unload',{});assert.equal(gate.ownsClose(w),false);
 const again=new AbortController(),retry=gate({signal:again.signal});again.abort();await assert.rejects(retry,{code:'DESKTOP_RESTART_CANCELLED'});
 w.emit('close',{});assert.equal(gate.ownsClose(w),false,'a fresh user close is not the retired transaction');w.emit('closed');await Promise.resolve();assert.equal(late,0);
});

test('cancelled close followed by a fresh accepted negotiation coalesces exactly one decision',async()=>{
 const w=new EventEmitter();w.webContents=new EventEmitter();w.isDestroyed=()=>false;let closes=0;w.close=()=>{closes++;w.emit('close',{});};
 const gate=createQuitWindowGate({getWindow:()=>w});const abort=new AbortController();const first=gate({signal:abort.signal});abort.abort();await assert.rejects(first,{code:'DESKTOP_RESTART_CANCELLED'});
 const retry=gate();assert.equal(retry,gate());w.emit('closed');assert.equal(await retry,true);assert.equal(closes,2);assert.equal(w.listenerCount('closed'),0);
});
