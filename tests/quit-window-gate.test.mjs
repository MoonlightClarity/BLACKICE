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
 const skills=await readFile(new URL('../public/next/workspaces/skills.mjs',import.meta.url),'utf8');assert.match(skills,/drafts.size\|\|rename/);assert.match(skills,/event.preventDefault\(\)/);
});
