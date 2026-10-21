import test from 'node:test';
import assert from 'node:assert/strict';
import {createObserveSubscription} from '../public/observe-stream.mjs';
import {createObserveFeed} from '../public/observe-model.mjs';
import {initObserveUI} from '../public/observe-ui.mjs';

function fixture(extra = {}) {
  const timers=new Map(),sources=[],events=[];let serial=0;
  const options={createSource(url){const source={url,closed:0,close(){this.closed++;}};sources.push(source);return source;},refreshSession:async()=>{},schedule(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},unschedule:id=>timers.delete(id),...extra};
  const close=createObserveSubscription('live',Object.fromEntries(['Ready','Edit','Presentation','Stopped','Error'].map(name=>['on'+name,(...args)=>events.push({type:name,args})])),options);
  return {sources,events,timers,close,next(){const [id,timer]=[...timers.entries()].sort((a,b)=>a[1].delay-b[1].delay)[0];timers.delete(id);return timer.fn();},send(type,data,source=sources.at(-1)){source.onmessage?.({data:JSON.stringify({type,runId:'live',data})});}};
}

test('Observe reconnects after a transport drop, rejects stale callbacks and reports a fresh baseline',async()=>{
  const f=fixture(),first=f.sources[0];f.send('observe.ready',{sequence:8});
  const late=first.onmessage;first.onerror();assert.equal(first.closed,1);assert.equal(f.events.at(-1).args[1].reconnecting,true);
  assert.equal([...f.timers.values()][0].delay,750);await f.next();assert.equal(f.sources.length,2);
  late({data:JSON.stringify({type:'run.edit',runId:'live',data:{path:'stale.txt'}})});assert.equal(f.events.filter(event=>event.type==='Edit').length,0);
  f.send('observe.ready',{sequence:0});assert.equal(f.events.at(-1).args[0].reconnected,true);
  f.send('run.edit',{path:'new.txt',sequence:1});assert.equal(f.events.at(-1).args[0].path,'new.txt');
  f.close();assert.equal(f.sources[1].closed,1);assert.equal(f.timers.size,0);
});

test('Observe retries with bounded backoff while open and closing cancels every pending retry',async()=>{
  const f=fixture();for(const delay of [750,1500,3000,6000,10000,10000]){f.sources.at(-1).onerror();assert.equal([...f.timers.values()][0].delay,delay);await f.next();}
  f.sources.at(-1).onerror();const scheduled=[...f.timers.values()][0].fn;f.close();assert.equal(f.timers.size,0);
  const before=f.sources.length;await scheduled();assert.equal(f.sources.length,before,'a stale timer cannot reopen hidden Observe');
});

test('closing Observe aborts an in-flight session refresh even if its fetch ignores AbortSignal',async()=>{
  let signal;const f=fixture({refreshSession:current=>{signal=current;return new Promise(()=>{});}});
  f.sources[0].onerror();const refreshing=f.next();assert.equal(signal.aborted,false);assert.equal(f.timers.size,1);
  f.close();assert.equal(signal.aborted,true);await refreshing;assert.equal(f.timers.size,0);assert.equal(f.sources.length,1);
});

test('a stalled session refresh has a deadline, and its late completion cannot open a second stream',async()=>{
  let finish;const f=fixture({refreshSession:()=>new Promise(resolve=>{finish=resolve;})});
  f.sources[0].onerror();const refreshing=f.next();await f.next();await refreshing;assert.equal(f.sources.length,2);
  finish();await Promise.resolve();assert.equal(f.sources.length,2);f.close();
});

test('finished runs and filesystem admission errors release the stream without retry loops',()=>{
  for(const type of ['observe.stopped','observe.error']){const f=fixture();f.send(type,type==='observe.error'?{error:'Folder unavailable'}:{reason:'finished'});assert.equal(f.sources[0].closed,1);assert.equal(f.timers.size,0);assert.equal(f.events.at(-1).type,type==='observe.error'?'Error':'Stopped');f.close();assert.equal(f.sources[0].closed,1);}
});

test('new journal sequence numbers cannot discard or overwrite edits captured before reconnection',()=>{
  const feed=createObserveFeed();feed.reset('live');feed.baseline(0);
  const edit=(sequence,path)=>({runId:'live',source:'filesystem',sequence,path,change:'modified'});
  for(let sequence=1;sequence<=8;sequence++)assert.equal(feed.edit(edit(sequence,'before.txt')),true);
  feed.reconnectBaseline(0);assert.equal(feed.edit(edit(1,'after.txt')),true);
  const entries=feed.snapshot().entries;assert.equal(entries.length,9);assert.equal(new Set(entries.map(item=>item.key)).size,9);assert.equal(entries.at(-1).path,'after.txt');
  assert.equal(feed.edit(edit(1,'duplicate.txt')),false);feed.reset();assert.equal(feed.snapshot().entries.length,0);
});

test('live messages preserve spaces and newlines arriving as standalone stream deltas',()=>{
  const feed=createObserveFeed();feed.reset('live');
  for(const [index,delta] of ['Hello',' ','world','\n\n','Next line'].entries())assert.equal(feed.event({type:'agent.event',runId:'live',nodeId:'agent',at:String(index),data:{type:'delta',delta}}),true);
  assert.equal(feed.snapshot().entries.at(-1).text,'Hello world\n\nNext line');
});

test('visible Activity reports reconnecting edits separately from task state and rejects recovery after leaving',t=>{
  const elements=new Map();const element=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',hidden:false,value:'',scrollHeight:100,scrollTop:0,clientHeight:100,classList:{toggle(){}}});return elements.get(key);};
  const mount={hidden:false,isConnected:true,innerHTML:'',classList:{add(){}},querySelector:element,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},contains:()=>true};
  const run={id:'live',status:'running',workflow:{nodes:[]},nodes:{},events:[]};let handlers,closed=0;
  const ui=initObserveUI({mount,getSnapshot:()=>({runs:[run],currentRun:run}),subscribe:(id,value)=>{handlers=value;return()=>closed++;}});
  t.after(()=>ui.destroy());
  ui.enter();handlers.onReady({sequence:0});handlers.onEdit({runId:'live',source:'filesystem',sequence:8,path:'before.txt',change:'created'});
  ui.update();
  assert.equal(element('#observe-stream').textContent,'Task running');assert.equal(element('#observe-viewing').textContent,'Viewing Workflow · Live edits connected');
  handlers.onError('Live edits disconnected. Reconnecting…',{reconnecting:true});
  ui.update();
  assert.equal(element('#observe-stream').textContent,'Task running','a dropped edit stream does not change the task’s execution state');
  assert.equal(element('#observe-viewing').textContent,'Viewing Workflow · Reconnecting live edits…');
  assert.equal(element('#observe-error').hidden,false);assert.equal(element('#observe-error').textContent,'Live edits disconnected. Reconnecting…');
  assert.match(element('#observe-pinned').innerHTML,/before.txt/,'a transport drop keeps the edits already observed');
  handlers.onReady({sequence:0,reconnected:true});ui.update();assert.equal(element('#observe-error').hidden,true);assert.equal(element('#observe-error').textContent,'');
  assert.equal(element('#observe-viewing').textContent,'Viewing Workflow · Live edits connected');assert.equal(element('#observe-stream').textContent,'Task running');
  assert.match(element('#observe-session-note').textContent,/disconnected may be missing/);
  handlers.onEdit({runId:'live',source:'filesystem',sequence:1,path:'after.txt',change:'created'});ui.update();assert.match(element('#observe-pinned').innerHTML,/after.txt/);
  mount.hidden=true;ui.update();assert.equal(closed,1);handlers.onReady({sequence:0,reconnected:true});assert.equal(element('#observe-feed').innerHTML,'');assert.equal(element('#observe-pinned').innerHTML,'');ui.destroy();assert.equal(closed,1);
});
