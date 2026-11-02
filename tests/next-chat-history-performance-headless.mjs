/** Real DOM transcript regressions. Synthetic data in disposable headless Chromium. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';


async function rendererChecks(){
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  const {paintHistory,captureChatScroll,restoreChatScroll}=await import('/next/chat/render.mjs');
  const style=document.createElement('link');style.rel='stylesheet';style.href='/next/chat.css';document.head.append(style);
  await new Promise((resolve,reject)=>{style.onload=resolve;style.onerror=reject;});
  const scroll=document.createElement('div');scroll.style.cssText='height:350px;width:850px;overflow:auto;overflow-anchor:none';
  const timeline=document.createElement('div');scroll.append(timeline);document.body.append(scroll);const view={timeline,scroll};
  let markdownCalls=0,created=0;
  const originalCreate=document.createElement;
  document.createElement=function(...args){created++;return originalCreate.apply(this,args);};
  const markdown=text=>{markdownCalls++;return '<p>'+text+'</p>';};
  const make=(i)=>({id:'history-'+i,input:'Question '+i,status:'completed',settled:true,workflow:{nodes:[]},nodes:{},
    precomputedMessages:[{id:'work-'+i,nodeId:'agent',role:'assistant',phase:'commentary',text:('Saved working details '+i+' ').repeat(4000)},
      {id:'answer-'+i,nodeId:'agent',role:'assistant',phase:'final_answer',text:('Visible answer '+i+'<br>').repeat(35)}],
    planningActivity:[]});
  const runs=Array.from({length:12},(_,i)=>make(i));
  const latest=runs.at(-1);latest.status='running';latest.settled=false;
  latest.taskState={taskId:latest.id,revision:1,goal:'Live task',steps:[{id:'first',title:'Read inputs',status:'active',evidence:'SAVED_EVIDENCE',doneWhen:'Verified'},
    {id:'group',title:'Group',kind:'sequence',status:'pending'},{id:'child',parentId:'group',title:'Nested step',status:'pending'}]};
  let callback=null;const options={markdown,onStop:(kind,id)=>callback={kind,id},messageLimits:new Map()};
  const initialStart=performance.now();paintHistory(view,runs,options);const initialMs=performance.now()-initialStart;
  check(timeline.querySelectorAll('.next-chat-turn').length===12,'Keep all windowed turns');
  check(timeline.querySelectorAll('.next-chat-audit-node').length===0,'Closed work histories must not mount their full rows');
  check(!timeline.textContent.includes('Saved working details'),'Closed work text must remain deferred');
  check(markdownCalls===11,'Markdown must render visible settled answers only: '+markdownCalls);
  const first=timeline.querySelector('.next-chat-turn'),firstResponse=first.querySelector('.next-chat-response');
  const firstDetails=first.querySelector('details');firstDetails.open=true;await pause();
  const history=firstDetails.querySelector('.next-chat-outline-history');check(Boolean(history),'Opening details must populate History');
  history.open=true;await pause();
  const record=history.querySelector('.next-chat-audit-node');check(Boolean(record),'Opening History must populate summaries');
  check(!record.querySelector('.next-message-body'),'Collapsed records must defer their large content');
  record.open=true;await pause();check(record.textContent.includes('Saved working details'),'Opening a record must show its complete saved text');
  const summary=record.querySelector('summary');summary.focus({preventScroll:true});
  const selection=getSelection(),range=document.createRange();range.selectNodeContents(firstResponse.querySelector('p'));selection.removeAllRanges();selection.addRange(range);
  const selectedText=selection.toString();
  created=0;const beforeMarkdown=markdownCalls;
  const observer=new MutationObserver(()=>{});observer.observe(first,{subtree:true,childList:true,attributes:true,characterData:true});
  const start=performance.now();
  for(let i=0;i<100;i++){
    latest.taskState={...latest.taskState,revision:i+2};paintHistory(view,runs,options);
  }
  const updatesMs=performance.now()-start,updateCreated=created,oldTurnMutations=observer.takeRecords().length;observer.disconnect();
  check(first===timeline.querySelector('.next-chat-turn')&&firstResponse===first.querySelector('.next-chat-response'),'Live Planning must retain settled turn DOM');
  check(oldTurnMutations===0&&markdownCalls===beforeMarkdown,'Live Planning must not mutate or reparse older answers');
  check(record.open&&document.activeElement===summary,'Updates must preserve an open disclosure and keyboard focus');
  check(selection.toString()===selectedText,'Live updates must preserve selected text in an older answer');
  check(updateCreated<10000,'Updates must not rebuild all12 turns or full closed histories: '+updateCreated);
  // Nested state survives a close, a changed live turn, and reopening.
  const liveDetails=timeline.querySelector('[data-run-id="'+latest.id+'"] .next-chat-details');liveDetails.open=true;await pause();
  const branch=liveDetails.querySelector('[data-disclosure-id="'+latest.id+':step:first"]');branch.open=true;await pause();
  check(branch.textContent.includes('SAVED_EVIDENCE'),'Plan evidence remains available on demand');
  liveDetails.open=false;await pause();latest.taskState={...latest.taskState,revision:103};paintHistory(view,runs,options);
  const rebuilt=timeline.querySelector('[data-run-id="'+latest.id+'"] .next-chat-details');check(!rebuilt.open&&!rebuilt.querySelector('.next-chat-details-body'),'Changed closed plan must remain lazy');
  rebuilt.open=true;await pause();check(rebuilt.querySelector('[data-disclosure-id="'+latest.id+':step:first"]').open,'Reopening must retain nested disclosure state');
  // Appended output below the reader must not move their current text.
  scroll.scrollTop=first.offsetHeight+200;await pause();
  let position=captureChatScroll(view);const before=scroll.scrollTop;
  latest.precomputedMessages.push({id:'new-output',nodeId:'agent',role:'assistant',phase:'final_answer',text:'Later answer '.repeat(100)});
  paintHistory(view,runs,options);restoreChatScroll(view,position);
  check(Math.abs(scroll.scrollTop-before)<2,'Output below the viewport must not shift older text');
  // Loading earlier responses must anchor the same visible message.
  const anchorKey=position.key;const find=()=>[...timeline.querySelectorAll('[data-scroll-anchor]')].find(node=>node.dataset.scrollAnchor===anchorKey);
  const offset=find().getBoundingClientRect().top-scroll.getBoundingClientRect().top;
  position=captureChatScroll(view);const older=make(-1);runs.unshift(older);paintHistory(view,runs,{...options,count:13});restoreChatScroll(view,position);
  check(Math.abs(find().getBoundingClientRect().top-scroll.getBoundingClientRect().top-offset)<2,'Earlier responses must preserve the visible message position');
  // Readers at the bottom still follow new output.
  scroll.scrollTop=scroll.scrollHeight;position=captureChatScroll(view);latest.precomputedMessages.push({id:'last-output',role:'assistant',text:'More final output '.repeat(100)});
  paintHistory(view,runs,{...options,count:13});restoreChatScroll(view,position);check(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<2,'Bottom-follow behavior must remain intact');
  // Retained handlers use the latest callbacks; changed settled text invalidates.
  const failed=runs[1];failed.status='failed';paintHistory(view,runs,{...options,count:13});
  paintHistory(view,runs,{...options,count:13,onStop:(kind,id)=>callback={kind,id,latest:true}});
  [...timeline.querySelectorAll('[data-run-id="'+failed.id+'"] button')].find(node=>node.textContent==='Retry').click();check(callback?.latest===true,'Reused buttons must call the current handler');
  failed.precomputedMessages.at(-1).text='Revised saved answer';paintHistory(view,runs,{...options,count:13});check(timeline.querySelector('[data-run-id="'+failed.id+'"]').textContent.includes('Revised saved answer'),'Changed saved message text must invalidate its turn');
  // Per-turn pagination still invalidates a cached turn without losing data.
  const long=make(100);long.precomputedMessages=Array.from({length:400},(_,i)=>({id:'long-'+i,role:'assistant',phase:'final_answer',text:'Saved reply '+i}));
  const limits=new Map();let limit=80;const paintLong=()=>paintHistory(view,[long],{markdown,messageLimits:limits,onMoreMessages:()=>{limit+=80;limits.set(long.id,limit);paintLong();}});
  paintLong();check(timeline.querySelectorAll('[data-role="assistant"] .next-message-body').length===80,'A long turn must remain windowed');
  timeline.querySelector('.next-message-more').click();check(timeline.querySelectorAll('[data-role="assistant"] .next-message-body').length===160&&long.precomputedMessages.length===400,'Show earlier messages must expand only its requested window and retain all saved data');
  document.createElement=originalCreate;scroll.remove();style.remove();
  return {turns:12,workingCharacters:12*('Saved working details 0 '.length*4000),initialMs,liveUpdates:100,updatesMs,updateCreated,oldTurnMutations,closedHistoriesDeferred:true,disclosureFocusPreserved:true,olderAndAppendAnchoring:true,bottomFollow:true};
}
const fixture=makeFixture(),directory=await mkdtemp(path.join(tmpdir(),'blackice-chat-history-performance-'));
const errors=[],networkCalls=[],base=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
fixture.server.on('request',(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/next/chat-history-performance-fixture'){
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end('<!doctype html><html><head><title>Chat transcript regression fixture</title><style>.next-conversation-row{min-height:24px}.next-conversation-menu{display:grid}.next-conversation-list{height:260px;overflow:auto}</style></head><body data-chat-history-performance-fixture="ready"></body></html>');return;
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
  const pageUrl='http://127.0.0.1:'+fixture.server.address().port+'/next/chat-history-performance-fixture';
  child=spawn(process.env.BLACKICE_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1360,850',pageUrl],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',()=>{});child.on('error',error=>errors.push(error.message));
  const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'Headless startup');
  const target=await until(async()=>{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(item=>item.type==='page'&&item.url===pageUrl);},'Fixture page');
  await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(packet.id&&pending.has(packet.id)){const job=pending.get(packet.id);pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.text||'Page exception');});});
  await send('Runtime.enable');await send('Page.enable');await until(()=>evaluate('document.location.href==='+JSON.stringify(pageUrl)+'&&document.body?.dataset.chatHistoryPerformanceFixture==="ready"&&document.readyState==="complete"'),'Fixture ready');
  const renderer=await evaluate('('+rendererChecks.toString()+')()');

  assert.equal(errors.length,0,errors.join('\n'));assert.deepEqual(networkCalls,[]);
  console.log('PASS '+JSON.stringify({renderer,syntheticData:true,headless:true,realApiCalls:networkCalls.length}));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{try{if(ws?.readyState===WebSocket.OPEN)await send('Browser.close');}catch{}try{ws?.close();}catch{}try{child?.kill();}catch{}fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
