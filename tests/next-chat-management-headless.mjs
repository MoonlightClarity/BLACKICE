/** Synthetic lifecycle acceptance. Uses a disposable, strictly headless Chrome. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';

const fixture=makeFixture(),directory=await mkdtemp(path.join(tmpdir(),'blackice-chat-lifecycle-'));
const records=new Map(),mutations=[],posts=[],errors=[],checks={};let heldList=null,holdFamily=null,failFamilyOnce=null,failOnce=null,holdMutation=null,holdSend=null;
const make=(id,state='active',status='completed',title='Chat '+id)=>({id:'turn-'+id,taskId:id,rootId:id,runId:'turn-'+id,latestRunId:'turn-'+id,title,state,status,settled:status==='completed',updatedAt:'2026-10-25T12:00:00Z'});
for(const item of [make('draft'),make('other'),make('good'),make('bad'),make('live','active','running'),make('archived','archived'),make('trashed','deleted'),...Array.from({length:120},(_,i)=>make('bulk-'+i,'active','completed',i===119?'Deep needle':'Bulk fixture '+String(i).padStart(3,'0')))])records.set(item.taskId,item);
const base=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
fixture.server.on('request',async(req,res)=>{
  const url=new URL(req.url,'http://fixture'),pathname=url.pathname;
  if(req.method==='POST')posts.push(pathname);
  if(pathname.endsWith('/steer')&&holdSend){const gate=holdSend;holdSend=null;for await(const part of req){}await new Promise(resolve=>{gate.release=resolve;});return json(res,{accepted:true,delivery:'queued'});}
  if(pathname==='/api/conversations'&&req.method==='GET'){
    const list=[...records.values()].filter(item=>item.state===url.searchParams.get('state')).map(item=>({...item}));
    if(heldList){const gate=heldList;heldList=null;gate.release=()=>json(res,{conversations:list});return;}
    return json(res,{conversations:list});
  }
  const match=/^\/api\/conversations\/([^/]+)(?:\/(archive|restore|delete|rename))?$/.exec(pathname);
  if(match){
    const item=[...records.values()].find(item=>item.runId===match[1]||item.taskId===match[1]);if(!item)return json(res,{error:'Saved chat missing'},404);
    if(req.method==='GET'){
      if(holdFamily?.id===item.taskId){const gate=holdFamily;holdFamily=null;await new Promise(resolve=>{gate.release=resolve;});}
      if(failFamilyOnce===item.taskId){failFamilyOnce=null;return json(res,{error:'Synthetic history unavailable.'},503);}
      return json(res,{rootId:item.taskId,state:item.state,title:item.title,runs:[{id:item.runId,taskId:item.taskId,input:'Question for '+item.title,status:item.status,settled:item.settled,createdAt:item.updatedAt,workflow:{nodes:[{id:'agent',type:'agent',name:'BLACKICE agent'}]},nodes:{agent:{status:item.status,threadId:'thread-'+item.taskId,turnId:item.status==='running'?'live-turn-'+item.taskId:undefined,output:'Saved answer for '+item.title}},events:[]}]});
    }
    if(req.method==='POST'&&match[2]){
      let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');mutations.push({id:item.taskId,runId:match[1],action:match[2],body});
      if(holdMutation){const gate=holdMutation;holdMutation=null;await new Promise(resolve=>{gate.release=resolve;});}
      if(failOnce===item.taskId){failOnce=null;return json(res,{error:'Synthetic save unavailable; no automatic retry.'},503);}
      if(match[2]==='delete'&&(item.status!=='completed'||!item.settled))return json(res,{error:'Wait for the conversation to finish stopping before moving it to Trash.'},409);
      if(match[2]==='rename')item.title=body.title;else item.state={archive:'archived',restore:'active',delete:'deleted'}[match[2]];
      return json(res,{rootId:item.taskId,state:item.state,title:item.title});
    }
  }
  return base(req,res);
});
let child,ws,nextId=1;const pending=new Map();
const until=async(fn,label,ms=12000)=>{let last;const end=Date.now()+ms;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await sleep(80);}throw Error(label+' timed out '+(last?.message||''));};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
const input=(selector,value,event='input')=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event('+JSON.stringify(event)+',{bubbles:true}));return true;})()');
const open=id=>click('.next-conversation[data-conversation="'+id+'"]');
const filter=async bucket=>{await input('#next-chat-bucket',bucket,'change');await until(()=>evaluate('document.querySelector("#next-chat-bucket").value==='+JSON.stringify(bucket)+'&&Boolean(document.querySelector(".next-conversation"))'),'Loaded '+bucket);};
const select=id=>click('[data-chat-select="'+id+'"]');
const idle=()=>until(()=>evaluate('!document.querySelector("#next-chat-new").disabled'),'Chat mutation settled');
const ready=id=>until(()=>evaluate('document.querySelector("#next-chat-title").textContent==='+JSON.stringify(records.get(id).title)+'&&document.querySelector("#next-chat-timeline").textContent.includes('+JSON.stringify('Saved answer for '+records.get(id).title)+')&&!document.querySelector("#next-chat-send").disabled'),'Ready history '+id);
const geometry=async selector=>{const r=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height,hit:h===e||e.contains(h),width:innerWidth,height:innerHeight};})()');assert.ok(r.x>=0&&r.y>=0&&r.right<=r.width&&r.bottom<=r.height&&r.w>0&&r.h>0&&r.hit,selector+' must be visible and hittable: '+JSON.stringify(r));};
try{
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));const profile=path.join(directory,'chrome');await mkdir(profile);
  child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1360,850','http://127.0.0.1:'+fixture.server.address().port+'/next/'],{stdio:['ignore','ignore','pipe'],windowsHide:true});child.stderr.on('data',()=>{});
  const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'Headless startup');
  const target=await until(async()=>{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(item=>item.type==='page'&&item.url.includes('/next/'));},'Fixture page');
  await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(packet.id&&pending.has(packet.id)){const job=pending.get(packet.id);pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.text||'Page exception');});});
  await send('Runtime.enable');await send('Page.enable');
  await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===80'),'Bounded synthetic catalog');
  await evaluate(`(()=>{if(![...document.styleSheets].some(sheet=>sheet.href&&new URL(sheet.href).pathname==='/next/chat-management.css')){const link=document.createElement('link');link.rel='stylesheet';link.href='/next/chat-management.css';document.head.append(link);}return true;})()`);
  await open('draft');await until(()=>evaluate('document.querySelector("#next-chat-timeline").textContent.includes("Saved answer for Chat draft")'),'Saved chat');
  await input('#next-chat-input','Preserve my unfinished reply');await click('#next-chat-archive');await idle();
  assert.equal(records.get('draft').state,'archived');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Preserve my unfinished reply');assert.equal(await evaluate('document.querySelector("#next-chat-input").disabled'),true);assert.match(await evaluate('document.querySelector("#next-chat-subtitle").textContent'),/Archived/);
  await click('#next-chat-archive');await idle();assert.equal(records.get('draft').state,'active');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Preserve my unfinished reply');assert.equal(await evaluate('document.querySelector("#next-chat-input").disabled'),false);checks.archiveRestoreDraft=true;
  assert.match(await evaluate('document.querySelector("#next-chat-export-markdown").getAttribute("href")'),/turn-draft\/export\?format=markdown$/);
  await click('.next-conversation[data-conversation="other"] + .next-conversation-actions [data-chat-action="archive"]');await idle();assert.equal(records.get('other').state,'archived');assert.equal(await evaluate('document.querySelector("#next-chat-title").textContent'),'Chat draft');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Preserve my unfinished reply');checks.rowTargetAndExport=true;
  await click('#next-chat-delete');await until(()=>evaluate('document.querySelector("#next-chat-trash-dialog").open'),'Trash confirmation');await click('#next-chat-trash-cancel');assert.equal(mutations.filter(item=>item.action==='delete').length,0);
  await click('#next-chat-delete');await click('#next-chat-trash-confirm');await idle();assert.equal(records.get('draft').state,'deleted');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Preserve my unfinished reply');
  await filter('deleted');await open('draft');await until(()=>evaluate('document.querySelector("#next-chat-title").textContent==="Chat draft"'),'Trash reader');assert.equal(await evaluate('document.querySelector("#next-chat-delete").hidden'),true);await click('#next-chat-archive');await idle();assert.equal(records.get('draft').state,'active');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Preserve my unfinished reply');checks.reversibleTrash=true;
  await filter('active');const familyGate={id:'live'};holdFamily=familyGate;await open('live');await until(()=>Boolean(familyGate.release),'Held live history');
  assert.equal(await evaluate('document.querySelector("#next-chat-send").disabled'),true);assert.equal(await evaluate('document.querySelector("#next-chat-input").disabled'),false);
  await input('#next-chat-input','Draft while history loads');const loadingPosts=posts.length;await evaluate('document.querySelector("#next-chat-form").requestSubmit();true');
  assert.match(await evaluate('document.querySelector("#next-chat-hint").textContent'),/still loading/);assert.equal(posts.length,loadingPosts);assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Draft while history loads');
  familyGate.release();await ready('live');assert.equal(await evaluate('document.querySelector("#next-chat-send").textContent'),'Direct');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Draft while history loads');checks.loadingDraftNoNewRun=true;
  assert.equal(await evaluate('document.querySelector("#next-chat-delete").disabled'),true);assert.equal(await evaluate('document.querySelector(".next-conversation[data-conversation=live] + details [data-chat-action=delete]").disabled'),true);checks.workingTrashGuard=true;
  await input('#next-chat-input','Submit this live direction');holdSend={};const direction=holdSend;await evaluate('document.querySelector("#next-chat-form").requestSubmit();true');await until(()=>Boolean(direction.release),'Pending direction');await input('#next-chat-input','A newer unfinished direction');await open('good');assert.equal(await evaluate('document.querySelector("#next-chat-title").textContent'),'Chat live');direction.release();await idle();assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'A newer unfinished direction');checks.pendingDirectionDraft=true;
  failFamilyOnce='good';await open('good');await until(()=>evaluate('document.querySelector("#next-chat-timeline").textContent.includes("Conversation history unavailable")'),'Failed history shown');
  assert.equal(await evaluate('document.querySelector("#next-chat-send").disabled'),true);await input('#next-chat-input','Draft after history failure');const failedReadPosts=posts.length;await evaluate('document.querySelector("#next-chat-form").requestSubmit();true');
  assert.match(await evaluate('document.querySelector("#next-chat-hint").textContent'),/Retry opening/);assert.equal(posts.length,failedReadPosts);assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Draft after history failure');
  await open('live');await ready('live');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'A newer unfinished direction');checks.failedHistoryDraftNoNewRun=true;
  await click('#next-chat-select');await click('#next-chat-bulk-all');assert.equal(await evaluate('document.querySelector("#next-chat-bulk-count").textContent'),'80 selected');assert.equal(await evaluate('document.querySelectorAll("[data-chat-select]").length'),80);await click('#next-chat-bulk-cancel');checks.boundedVisibleSelection=true;
  await input('#next-chat-search','needle');await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===1'),'Full catalog search');await open('bulk-119');await until(()=>evaluate('document.querySelector("#next-chat-title").textContent==="Deep needle"'),'Deep selection');await input('#next-chat-search','');await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===81'),'Pinned deep selection');checks.deepSearchAndPinned=true;
  await click('#next-chat-select');await select('good');await select('bad');failOnce='bad';await click('#next-chat-bulk-archive');await idle();assert.equal(records.get('good').state,'archived');assert.equal(records.get('bad').state,'active');assert.equal(await evaluate('document.querySelector("#next-chat-bulk-count").textContent'),'1 selected');assert.match(await evaluate('document.querySelector("#next-chat-management-status").textContent'),/1 could not be changed/);
  const failedPosts=mutations.length;await click('.next-tab[data-space=settings]');await until(()=>evaluate('Boolean(document.querySelector("#next-settings-model"))'),'Settings leave');await click('.next-tab[data-space=chat]');await until(()=>evaluate('document.querySelector("#next-chat-bulk-count").textContent==="1 selected"'),'Selection return');assert.equal(mutations.length,failedPosts);await click('#next-chat-bulk-archive');await idle();assert.equal(records.get('bad').state,'archived');checks.partialFailureNoReplay=true;
  await click('#next-chat-select');await select('draft');const stale=records.get('draft');stale.runId=stale.latestRunId='new-turn-draft';fixture.send({type:'conversations.updated'});await until(()=>evaluate('document.querySelector("#next-chat-bulk-archive").disabled&&document.querySelector("#next-chat-bulk-archive").title.includes("changed")'),'Stale selection rejects');assert.equal(mutations.length,failedPosts+1);await click('#next-chat-bulk-cancel');checks.staleSelection=true;
  await open('draft');await until(()=>evaluate('document.querySelector("#next-chat-title").textContent==="Chat draft"'),'Renamed target');await click('#next-chat-rename');await input('#next-chat-rename-input','Renamed <literal> chat');await evaluate('document.querySelector("#next-chat-rename-form").requestSubmit();true');await idle();assert.equal(records.get('draft').title,'Renamed <literal> chat');assert.equal(await evaluate('document.querySelector("#next-chat-title").textContent'),'Renamed <literal> chat');checks.explicitRename=true;
  await click('#next-chat-select');await select('draft');holdMutation={};const gate=holdMutation;await click('#next-chat-bulk-archive');await until(()=>Boolean(gate.release),'Held lifecycle write');const beforeDuplicate=mutations.length;await click('#next-chat-bulk-archive');assert.equal(mutations.length,beforeDuplicate);assert.equal(await evaluate('document.querySelector("#next-chat-bucket").disabled'),true);gate.release();await idle();assert.equal(records.get('draft').state,'archived');checks.serializedNoDuplicate=true;
  const listGate={};heldList=listGate;fixture.send({type:'conversations.updated'});await until(()=>Boolean(listGate.release),'Held old active list');await filter('archived');listGate.release();await sleep(180);assert.equal(await evaluate('document.querySelector("#next-chat-bucket").value'),'archived');assert.equal(await evaluate('Boolean(document.querySelector(".next-conversation[data-conversation=other]"))'),true);checks.staleListIsolation=true;
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});await click('#next-chat-select');await select('draft');await geometry('#next-chat-bulk-all');await geometry('#next-chat-bulk-restore');await geometry('#next-chat-bulk-delete');await click('#next-chat-bulk-delete');await geometry('#next-chat-trash-confirm');await geometry('#next-chat-trash-cancel');assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await click('#next-chat-trash-cancel');await click('#next-chat-bulk-cancel');checks.compactGeometry=true;
  await evaluate('(()=>{const list=document.querySelector("#next-chat-list");list.scrollTop=list.scrollHeight;const menu=[...list.querySelectorAll(".next-conversation-actions")].at(-1);menu.querySelector("summary").click();return true;})()');
  // Scroll alignment can quantize fractional layout coordinates. Permit at most
  // one physical pixel; the action visibility and hit checks below remain strict.
  try{await until(()=>evaluate('(()=>{const menu=document.querySelector(".next-conversation-actions[open] .next-conversation-menu"),list=document.querySelector("#next-chat-list");if(!menu)return false;const a=menu.getBoundingClientRect(),b=list.getBoundingClientRect(),pixel=1/devicePixelRatio;return a.top>=b.top-pixel&&a.bottom<=b.bottom+pixel;})()'),'Last row menu stays inside scrollable catalog');}
  catch(error){
    try{console.error('MENU_GEOMETRY '+JSON.stringify(await evaluate(`(()=>{
      const measure=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {tag:e.tagName,className:e.className,box:r.toJSON(),clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,position:s.position,height:s.height,minHeight:s.minHeight,maxHeight:s.maxHeight,overflowY:s.overflowY,display:s.display,flex:s.flex,margin:s.margin,padding:s.padding,centerHit:hit===e||e.contains(hit),hitTag:hit?.tagName,hitClass:hit?.className};};
      const list=document.querySelector('#next-chat-list'),details=[...list.querySelectorAll('.next-conversation-actions[open]')];
      return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},list:measure(list),sidebar:measure(document.querySelector('.next-chat-sidebar')),head:measure(document.querySelector('.next-sidebar-head')),openMenus:details.map(e=>({details:measure(e),row:measure(e.closest('.next-conversation-row')),summary:measure(e.querySelector('summary')),menu:measure(e.querySelector('.next-conversation-menu')),controls:[...e.querySelectorAll('.next-conversation-menu button,.next-conversation-menu a')].map(c=>({label:c.textContent,...measure(c)}))})),styles:[...document.styleSheets].map(s=>s.href)};
    })()`)));}catch(diagnosticError){console.error('MENU_GEOMETRY_FAILED '+diagnosticError.message);}
    throw error;
  }
  await geometry('.next-conversation-actions[open] [data-chat-action=delete]');await geometry('.next-conversation-actions[open] a:last-child');checks.lastRowMenuReachable=true;
  await click('#next-chat-new');assert.equal(await evaluate('document.querySelector("#next-chat-bucket").value'),'active');assert.equal(await evaluate('document.querySelector("#next-chat-input").disabled'),false);assert.equal(await evaluate('document.querySelector("#next-chat-title").textContent'),'New conversation');
  await filter('deleted');await click('#next-chat-new');assert.equal(await evaluate('document.querySelector("#next-chat-bucket").value'),'active');assert.equal(await evaluate('document.querySelector("#next-chat-input").disabled'),false);checks.newFromArchiveAndTrash=true;
  assert.ok(mutations.every(item=>item.action==='rename'?Object.keys(item.body).join(',')==='title':Object.keys(item.body).length===0));assert.ok(!mutations.some(item=>item.action==='delete'&&item.id==='live'));assert.equal(errors.length,0,errors.join('\n'));
  if(process.env.BLACKICE_CHAT_MANAGEMENT_SCREENSHOT){const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(process.env.BLACKICE_CHAT_MANAGEMENT_SCREENSHOT,Buffer.from(shot.data,'base64'));}
  console.log('PASS '+JSON.stringify({checks,mutationCount:mutations.length,syntheticData:true,headless:true}));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{try{await send('Browser.close');}catch{}try{ws?.close();}catch{}try{child?.kill();}catch{}fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
