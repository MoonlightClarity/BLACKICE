import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createActivityInspector} from '../public/next/chat/activity-inspector.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t){
 const dom=planningDOM(t),actions=dom.element('div');actions.className='next-chat-head-actions';dom.mount.append(actions);let run='a',hook,listener;const calls=[];
 const reply=(view,title=view)=>({revision:'one',view,items:[{id:view,title,text:view==='internal'?'STRUCTURED ONLY':'visible '+view,source:'saved fixture'}],nextOffset:null,coverage:{scope:'Retained events in this run',retainedEvents:4,omittedEvents:2}});
 const api=async route=>{const url=new URL(route,'http://fixture');assert.match(url.pathname,/^\/api\/conversations\/[^/]+\/activity$/);const params=url.searchParams;assert.equal(params.has('runId'),false);calls.push(Object.fromEntries(params));return hook?.(params)||reply(params.get('view'));};
 const inspector=createActivityInspector({frame:dom.mount,getRunId:()=>run,api,events:{subscribe(fn){listener=fn;return ()=>{};}}});t.after(()=>inspector.destroy());
 return {dom,inspector,calls,reply,emit:()=>listener({runId:run,data:{type:"message"}}),setRun:id=>{run=id;inspector.refresh(id);},hook:fn=>hook=fn,category:async value=>{dom.$('.next-activity-view').value=value;await dom.$('.next-activity-view').dispatch('change');await tick();}};
}
test('mounted activity defaults to updates and keeps internal content inaccessible until selected',async t=>{
 const f=fixture(t);await f.inspector.open();assert.equal(f.calls[0].view,'updates');assert.ok(!f.dom.mount.textContent.includes('STRUCTURED ONLY'));assert.match(f.dom.$('.next-activity-coverage').textContent,/2 earlier events omitted/);
 await f.category('tools');assert.equal(f.calls.at(-1).view,'tools');assert.ok(!f.dom.mount.textContent.includes('STRUCTURED ONLY'));
 await f.category('internal');assert.match(f.dom.mount.textContent,/STRUCTURED ONLY/);
 f.dom.$('.next-activity-inspector').close();await f.inspector.open();assert.equal(f.dom.$('.next-activity-view').value,'updates');assert.ok(!f.dom.mount.textContent.includes('STRUCTURED ONLY'));
});
test('new filter, close and conversation switch discard stale pending responses',async t=>{
 const f=fixture(t);await f.inspector.open();const pending=deferred();f.hook(params=>params.get('view')==='internal'?pending.promise:null);
 await f.category('internal');await f.category('updates');pending.resolve(f.reply('internal','STALE INTERNAL'));await tick();assert.ok(!f.dom.mount.textContent.includes('STALE INTERNAL'));
 const later=deferred();f.hook(()=>later.promise);const loading=f.inspector.open();f.setRun('b');later.resolve(f.reply('updates','WRONG CONVERSATION'));await loading;assert.ok(!f.dom.mount.textContent.includes('WRONG CONVERSATION'));
});
test('search and next page preserve category scope and revision while changed-source errors remain explicit',async t=>{
 const f=fixture(t);await f.inspector.open();f.hook(params=>params.get('offset')==='0'?{...f.reply(params.get('view')),nextOffset:30}:Promise.reject(Object.assign(Error('changed'),{code:'ACTIVITY_CHANGED'})));
 f.dom.$('.next-activity-search').value='query';await f.dom.$('.next-activity-controls').dispatch('submit');await tick();assert.equal(f.calls.at(-1).q,'query');
 await f.dom.click('.next-activity-more');await tick();assert.equal(f.calls.at(-1).revision,'one');assert.equal(f.calls.at(-1).view,'updates');assert.match(f.dom.$('.next-activity-status').textContent,/Activity changed/);
});

test('live updates preserve active search and paged inspection until Refresh',async t=>{
 const f=fixture(t);await f.inspector.open();f.dom.$('.next-activity-search').value='needle';f.emit();assert.equal(f.calls.length,1);assert.match(f.dom.$('.next-activity-status').textContent,/New activity available/);
 f.dom.$('.next-activity-search').value='';f.hook(params=>({...f.reply('updates'),nextOffset:params.get('offset')==='0'?30:null}));await f.dom.click('.next-activity-refresh');await tick();await f.dom.click('.next-activity-more');await tick();const count=f.calls.length;f.emit();assert.equal(f.calls.length,count);assert.match(f.dom.$('.next-activity-status').textContent,/current results are preserved/);
 await f.dom.click('.next-activity-refresh');await tick();assert.equal(f.calls.at(-1).offset,'0');
});
