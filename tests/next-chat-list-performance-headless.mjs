/** Real DOM catalog regression checks. Uses synthetic data and disposable headless Chrome. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';

// These functions are evaluated in Chrome, with the real frontend modules.
async function rendererChecks(){
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const nativeCreate=document.createElement,NativeDateTimeFormat=Intl.DateTimeFormat;
  let created=0,formatters=0;
  document.createElement=function(...args){created++;return nativeCreate.apply(this,args);};
  Intl.DateTimeFormat=new Proxy(NativeDateTimeFormat,{construct(target,args,newTarget){formatters++;return Reflect.construct(target,args,newTarget);}});
  const {paintIndex}=await import(new URL('/next/chat/render.mjs',location.href).href);
  const {filterSummaries}=await import(new URL('/next/chat/model.mjs',location.href).href);
  const list=document.createElement('div');list.style.cssText='height:240px;overflow:auto;width:360px';document.body.append(list);
  const view={list},items=Array.from({length:20000},(_,i)=>({taskId:'catalog-'+i,runId:'turn-'+i,title:i===19999?'Deep searchable needle':'Chat '+i,status:'completed',settled:true,state:'active',updatedAt:'2026-10-25T12:00:00Z'}));
  let oldCalls=0,latestSelect=null,latestAction=null,moreCalls=0,toggle=null;
  const originalOptions={onAction:()=>oldCalls++,onMore:()=>oldCalls++};
  const observer=new MutationObserver(()=>{});
  try{
    const firstStart=performance.now();
    const visible=paintIndex(view,items,'catalog-19999',()=>oldCalls++,originalOptions);
    const firstMs=performance.now()-firstStart;
    check(visible.length===81&&list.querySelectorAll('.next-conversation').length===81,'20k catalog must mount only 80 rows plus the deep selected row');
    check(list.querySelector('.next-conversation').dataset.conversation==='catalog-19999','Deep selected chat must remain pinned and reachable');
    check(list.querySelector('.next-conversation-more').textContent.includes('19920 remaining'),'Show More must retain full catalog count');
    check(formatters===1,'Dates must share one Intl.DateTimeFormat instance');
    const row=list.querySelector('[data-conversation="catalog-10"]').parentElement;
    const button=row.querySelector('.next-conversation'),menu=row.querySelector('details'),summary=menu.querySelector('summary');
    menu.open=true;summary.focus({preventScroll:true});list.scrollTop=150;
    const scrollTop=list.scrollTop;
    observer.observe(list,{subtree:true,childList:true,attributes:true,characterData:true});
    created=0;
    const unchangedStart=performance.now();
    for(let i=0;i<200;i++)paintIndex(view,items,'catalog-19999',()=>oldCalls++,originalOptions);
    const unchangedMs=performance.now()-unchangedStart,unchangedCreated=created,unchangedMutations=observer.takeRecords().length;
    check(unchangedCreated===0,'Unchanged updates must create no DOM elements: '+unchangedCreated);
    check(unchangedMutations===0,'Unchanged updates must mutate no DOM: '+unchangedMutations);
    check(list.querySelector('[data-conversation="catalog-10"]')===button,'Unchanged paints must preserve row/button identity');
    check(menu.open&&document.activeElement===summary&&list.scrollTop===scrollTop,'Unchanged paints must preserve open menu, keyboard focus, and scroll');
    created=0;
    const statusStart=performance.now();
    for(let i=0;i<100;i++){
      items[10]={...items[10],status:i%2?'completed':'running',settled:Boolean(i%2)};
      paintIndex(view,items,'catalog-19999',()=>oldCalls++,originalOptions);
    }
    const statusMs=performance.now()-statusStart,statusCreated=created,statusRecords=observer.takeRecords();
    check(statusCreated===0,'Status updates must reuse the mounted row DOM');
    check(statusRecords.length>0&&statusRecords.length<=400,'A status update must change only its text and action availability');
    check(statusRecords.every(record=>row.contains(record.target)),'Changing one row must not mutate other rows or reorder the catalog');
    check(button===list.querySelector('[data-conversation="catalog-10"]')&&menu.open&&document.activeElement===summary,'Status updates must preserve menu and focus');
    check(!row.querySelector('[data-chat-action="delete"]').disabled,'Completed row must allow Trash again');

    const refreshed=items.map(item=>({...item}));refreshed[10].runId='latest-turn-10';
    const latestOptions={onAction:(item,action)=>{latestAction={item,action};},onMore:()=>moreCalls++};
    paintIndex(view,refreshed,'catalog-19999',item=>{latestSelect=item;},latestOptions);
    button.click();row.querySelector('[data-chat-action="archive"]').click();list.querySelector('.next-conversation-more').click();
    check(latestSelect===refreshed[10]&&latestAction?.item===refreshed[10]&&latestAction.action==='archive','Retained handlers must use the current item and callbacks');
    check(oldCalls===0&&moreCalls===1,'Retained controls must not call stale callbacks');
    check(row.querySelector('a').getAttribute('href').includes('/latest-turn-10/export?'),'Export links must use the newest continuation');

    const beforeMore=button;
    paintIndex(view,refreshed,'catalog-19999',()=>{},{...latestOptions,limit:160});
    check(list.querySelectorAll('.next-conversation').length===161,'Show More must expose another 80 rows while keeping the deep pin');
    check(list.querySelector('[data-conversation="catalog-10"]')===beforeMore,'Show More must reuse already visible rows');
    const filtered=filterSummaries(refreshed,'needle');
    paintIndex(view,filtered,'catalog-19999',()=>{},latestOptions);
    check(list.querySelectorAll('.next-conversation').length===1&&list.querySelector('.next-conversation').dataset.conversation==='catalog-19999','Search must reach items beyond the mounted window');
    paintIndex(view,refreshed,'catalog-19999',()=>{},latestOptions);
    check(list.querySelectorAll('.next-conversation').length===81,'Clearing search must restore a bounded window');

    const selection=new Map([['catalog-10',{runId:'latest-turn-10',state:'active'}]]);
    paintIndex(view,refreshed,'catalog-19999',()=>{},{selecting:true,selection,onToggle:()=>oldCalls++});
    const checkbox=list.querySelector('[data-chat-select="catalog-10"]');
    check(list.querySelectorAll('[data-chat-select]').length===81&&checkbox.checked,'Bulk mode must include exactly the visible rows and preserve selected state');
    const newest=refreshed.map(item=>({...item}));newest[10].runId='newest-turn-10';
    paintIndex(view,newest,'catalog-19999',()=>{},{selecting:true,selection,onToggle:(item,checked)=>{toggle={item,checked};}});
    check(list.querySelector('[data-chat-select="catalog-10"]')===checkbox,'Bulk refresh must preserve checkbox identity');
    checkbox.click();
    check(toggle?.item===newest[10]&&toggle.checked===false&&oldCalls===0,'Bulk handlers must use the newest item and callback');
    paintIndex(view,newest,'catalog-19999',()=>{},{selecting:true,selection,busy:true});
    check(checkbox.disabled&&list.querySelector('[data-conversation="catalog-10"]').disabled,'Busy state must disable selection and navigation');
    paintIndex(view,[],'',()=>{},latestOptions);
    check(list.querySelectorAll('.next-conversation').length===0&&list.textContent==='No conversations here.','Empty results must remove stale rows and markers');
    return {catalogSize:items.length,initialRows:visible.length,firstMs,unchangedPaints:200,unchangedMs,unchangedCreated,unchangedMutations,statusPaints:100,statusMs,statusCreated,statusMutations:statusRecords.length,formatters,focusAndMenu:true,latestCallbacks:true,deepSearchAndMore:true,bulkControls:true};
  }finally{observer.disconnect();list.remove();document.createElement=nativeCreate;Intl.DateTimeFormat=NativeDateTimeFormat;}
}

async function workspaceChecks(){
  const {createChatWorkspace}=await import(new URL('/next/chat/chat.mjs',location.href).href);
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await pause(20);}throw Error(label+' timed out');};
  const make=(id,status='completed',state='active')=>({taskId:id,runId:'turn-'+id,title:'Chat '+id,status,settled:status==='completed',state,updatedAt:'2026-10-25T12:00:00Z'});
  const checks={};let workspace,host,active=0,maxActive=0;
  const fixtures=[];
  const setup=()=>{
    localStorage.clear();host=document.createElement('main');document.body.append(host);
    const mount=host,listReads=[],apiCalls=[],subscribers=new Set(),notices=[];
    const api=(url,method='GET',payload,options={})=>{
      apiCalls.push({url,method});
      if(method!=='GET'||!url.startsWith('/api/conversations?'))throw Error('Unexpected fixture API call: '+method+' '+url);
      return new Promise((resolve,reject)=>{
        const request={url,signal:options.signal,aborted:false,ignoreAbort:false,done:false};
        active++;maxActive=Math.max(maxActive,active);
        const finish=(fn,value)=>{if(request.done)return;request.done=true;active--;fn(value);};
        request.resolve=conversations=>finish(resolve,{conversations});
        request.reject=error=>finish(reject,error);
        request.signal?.addEventListener('abort',()=>{request.aborted=true;if(!request.ignoreAbort)request.reject(new DOMException('Fixture read aborted','AbortError'));},{once:true});
        listReads.push(request);
      });
    };
    const events={subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);}};
    workspace=createChatWorkspace({mount,api,events,getStatus:()=>({cwd:'synthetic-fixture'}),notify:(...args)=>notices.push(args)});
    const fixture={workspace,mount,listReads,apiCalls,notices,emit:event=>{for(const fn of subscribers)fn(event);},query:selector=>mount.querySelector(selector)};
    fixtures.push(fixture);workspace.enter();return fixture;
  };
  const destroy=fixture=>{fixture.workspace.destroy();fixture.mount.remove();};
  const eventStatus=(fixture,item,status)=>fixture.emit({type:'run.updated',runId:item.runId,data:{id:item.runId,status,settled:status==='completed'}});
  try{
    // Exercise the actual workspace event handler against a large catalog.
    let f=setup();await until(()=>f.listReads.length===1,'Initial catalog request');
    const catalog=Array.from({length:20000},(_,i)=>make('workspace-'+i));catalog[0]=make('workspace-0','running');
    f.listReads[0].resolve(catalog);await until(()=>f.workspace.getState().listing===20000,'20k catalog loaded');
    check(f.mount.querySelectorAll('.next-conversation').length===80,'Workspace must render only the first 80 of 20k summaries');
    const list=f.query('#next-chat-list'),row=f.query('[data-conversation="workspace-0"]').parentElement,menu=row.querySelector('details'),summary=menu.querySelector('summary');
    menu.open=true;summary.focus({preventScroll:true});await pause(20);
    const observer=new MutationObserver(()=>{});observer.observe(list,{subtree:true,childList:true,attributes:true,characterData:true});
    const unchangedStart=performance.now();
    for(let i=0;i<1000;i++)eventStatus(f,catalog[0],'running');
    const eventMs=performance.now()-unchangedStart,unchangedMutations=observer.takeRecords().length;
    check(unchangedMutations===0,'Unchanged run.updated events must not mutate the sidebar');
    check(menu.open&&document.activeElement===summary,'Live update noise must preserve an open menu and focus');
    eventStatus(f,catalog[0],'completed');
    const changed=observer.takeRecords();observer.disconnect();
    check(changed.length>0&&changed.every(record=>row.contains(record.target)),'Actual status changes must touch only the changed row');
    check(row.querySelector('.next-conversation-meta').textContent.includes('completed'),'Actual run status must update immediately');
    checks.largeCatalogLiveEvents={catalogSize:20000,unchangedEvents:1000,eventMs,unchangedMutations,statusMutations:changed.length};
    f.query('#next-chat-select').click();f.query('#next-chat-bulk-all').click();
    check(f.query('#next-chat-bulk-count').textContent==='80 selected','Select visible must select only the mounted batch');
    check(f.workspace.getState().selectionCount===80,'Bulk controls must update workspace selection state');
    f.query('#next-chat-bulk-cancel').click();checks.visibleBulkSelection=true;

    // Debounced catalog bursts during a slow read must queue only one follow-up.
    for(let i=0;i<25;i++)f.emit({type:'conversations.updated'});
    await until(()=>f.listReads.length===2,'Held catalog read');
    for(let i=0;i<25;i++)f.emit({type:'conversations.updated'});
    await pause(850);
    for(let i=0;i<25;i++)f.emit({type:'conversations.changed'});
    await pause(850);
    check(f.listReads.length===2&&active===1,'Slow read must not start overlapping catalog requests');
    f.listReads[1].resolve([make('stale-burst')]);
    await until(()=>f.listReads.length===3,'One newest follow-up');
    check(!f.query('[data-conversation="stale-burst"]'),'Superseded catalog must not flash into the UI');
    f.listReads[2].resolve([make('fresh-burst','running')]);
    await until(()=>Boolean(f.query('[data-conversation="fresh-burst"]')),'Newest catalog painted');
    await pause(30);check(f.listReads.length===3&&active===0,'A burst must result in exactly one follow-up');
    checks.coalescedReads=true;

    // A newer status event must invalidate an older, still-running snapshot.
    const fresh=make('fresh-burst','running');f.emit({type:'conversations.updated'});
    await until(()=>f.listReads.length===4,'Status race read');
    eventStatus(f,fresh,'completed');
    check(f.query('.next-conversation-meta').textContent.includes('completed'),'New status must paint before the slow read settles');
    f.listReads[3].resolve([fresh]);await until(()=>f.listReads.length===5,'Fresh read after status event');
    check(f.query('.next-conversation-meta').textContent.includes('completed'),'Older catalog response must not revert a newer status');
    f.listReads[4].resolve([make('fresh-burst')]);await until(()=>active===0,'Status follow-up settled');
    check(f.query('.next-conversation-meta').textContent.includes('completed'),'Follow-up must retain current status');
    checks.statusOvertakesRead=true;

    // Simulate a response already completing when its old bucket is aborted.
    f.emit({type:'conversations.updated'});await until(()=>f.listReads.length===6,'Bucket race read');
    const oldBucket=f.listReads[5];oldBucket.ignoreAbort=true;
    const bucket=f.query('#next-chat-bucket');bucket.value='archived';bucket.dispatchEvent(new Event('change',{bubbles:true}));
    check(oldBucket.signal.aborted,'Changing bucket must abort the previous read');
    oldBucket.resolve([make('wrong-bucket')]);await until(()=>f.listReads.length===7,'Archive read after old response');
    check(f.listReads[6].url.endsWith('state=archived'),'Queued read must use the newest bucket');
    check(!f.query('[data-conversation="wrong-bucket"]'),'Old bucket response must not appear in the new bucket');
    f.listReads[6].resolve([make('right-bucket','completed','archived')]);
    await until(()=>Boolean(f.query('[data-conversation="right-bucket"]')),'Archive response');
    checks.bucketRaceIsolation=true;

    f.emit({type:'conversations.updated'});await until(()=>f.listReads.length===8,'Leave race read');
    const oldLifecycle=f.listReads[7];oldLifecycle.ignoreAbort=true;f.workspace.leave();
    check(oldLifecycle.signal.aborted,'Leaving the workspace must abort the catalog request');
    oldLifecycle.resolve([make('late-after-leave','completed','archived')]);await pause(30);
    check(!f.query('[data-conversation="late-after-leave"]'),'A response after leave must not alter the sidebar');
    f.workspace.enter();await until(()=>f.listReads.length===9,'Reenter catalog request');
    f.listReads[8].resolve([make('returned','completed','archived')]);await until(()=>Boolean(f.query('[data-conversation="returned"]')),'Reenter fresh catalog');
    check(f.notices.length===0,'Aborts and discarded reads must not show errors');
    checks.leaveAndReenter=true;destroy(f);await pause(0);

    // An explicit New action must win over automatic remembered-chat recovery.
    f=setup();localStorage.setItem('blackice.next.selected','remembered');localStorage.setItem('relay.mission.returnRun','remembered');
    await until(()=>f.listReads.length===1,'Remembered initial request');f.query('#next-chat-new').click();
    f.listReads[0].resolve([make('remembered')]);await until(()=>f.workspace.getState().listing===1,'Remembered catalog response');
    check(f.workspace.getState().selected==='new'&&f.query('#next-chat-title').textContent==='New conversation','New must cancel initial automatic remembered-chat selection');
    // History reads use the worker's fetch and are also guarded by the outer networkCalls assertion.
    check(f.listReads.length===1,'Explicit New must keep its one initial catalog read; API calls: '+JSON.stringify(f.apiCalls));
    checks.explicitNewWins=true;destroy(f);await pause(0);
    check(maxActive===1,'Catalog reads must never overlap: '+maxActive);
    check(fixtures.every(fixture=>fixture.apiCalls.every(call=>call.method==='GET')),'Fixture must never start or mutate a conversation');
    return {checks,maxActiveReads:maxActive,catalogReads:fixtures.reduce((total,fixture)=>total+fixture.listReads.length,0),syntheticApi:true};
  }finally{for(const fixture of fixtures){try{fixture.workspace.destroy();fixture.mount.remove();}catch{}}localStorage.clear();}
}

const fixture=makeFixture(),directory=await mkdtemp(path.join(tmpdir(),'blackice-chat-list-performance-'));
const errors=[],networkCalls=[],base=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
fixture.server.on('request',(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/next/chat-list-performance-fixture'){
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end('<!doctype html><html><head><title>Chat catalog regression fixture</title><style>.next-conversation-row{min-height:24px}.next-conversation-menu{display:grid}.next-conversation-list{height:260px;overflow:auto}</style></head><body data-chat-list-performance-fixture="ready"></body></html>');return;
  }
  if(url.pathname.startsWith('/api/')){networkCalls.push(req.method+' '+url.pathname);res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Unexpected real API call from isolated regression fixture'}));return;}
  return base(req,res);
});
let child,ws,nextId=1;const pending=new Map();
const until=async(fn,label,ms=12000)=>{let last;const end=Date.now()+ms;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await sleep(80);}throw Error(label+' timed out '+(last?.message||''));};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
try{
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));const profile=path.join(directory,'chrome');await mkdir(profile);
  const pageUrl='http://127.0.0.1:'+fixture.server.address().port+'/next/chat-list-performance-fixture';
  child=spawn(process.env.BLACKICE_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1360,850',pageUrl],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',()=>{});child.on('error',error=>errors.push(error.message));
  const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'Headless startup');
  const target=await until(async()=>{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(item=>item.type==='page'&&item.url===pageUrl);},'Fixture page');
  await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(packet.id&&pending.has(packet.id)){const job=pending.get(packet.id);pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.text||'Page exception');});});
  await send('Runtime.enable');await send('Page.enable');await until(()=>evaluate('document.location.href==='+JSON.stringify(pageUrl)+'&&document.body?.dataset.chatListPerformanceFixture==="ready"&&document.readyState==="complete"'),'Fixture ready');
  const renderer=await evaluate('('+rendererChecks.toString()+')()');
  const workspace=await evaluate('('+workspaceChecks.toString()+')()');
  assert.equal(errors.length,0,errors.join('\n'));assert.deepEqual(networkCalls,[]);
  console.log('PASS '+JSON.stringify({renderer,workspace,syntheticData:true,headless:true,realApiCalls:networkCalls.length}));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{try{if(ws?.readyState===WebSocket.OPEN)await send('Browser.close');}catch{}try{ws?.close();}catch{}try{child?.kill();}catch{}fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
