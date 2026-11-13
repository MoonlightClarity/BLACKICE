/** Synthetic lifecycle acceptance. Uses a disposable, strictly headless Chrome. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';

const root=process.cwd();
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
      return json(res,{rootId:item.taskId,state:item.state,title:item.title,runs:[{id:item.runId,taskId:item.taskId,input:'Question for '+item.title,status:item.status,settled:item.settled,createdAt:item.updatedAt,responseCycle:{requestId:'saved-plan-'+item.taskId,cycleId:'saved-cycle',state:item.taskId==='good'?'paused_after_plan':item.taskId==='live'?'running':'failed',stage:'plan',title:'Saved planning'},workflow:{nodes:[{id:'agent',type:'agent',name:'BLACKICE agent'}]},nodes:{agent:{status:item.status,threadId:'thread-'+item.taskId,turnId:item.status==='running'?'live-turn-'+item.taskId:undefined,output:'Saved answer for '+item.title}},events:[]}]});
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
  child=spawn(process.env.BLACKICE_TEST_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1360,850','http://127.0.0.1:'+fixture.server.address().port+'/next/'],{stdio:['ignore','ignore','pipe'],windowsHide:true});child.stderr.on('data',()=>{});
  const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'Headless startup');
  const target=await until(async()=>{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(item=>item.type==='page'&&item.url.includes('/next/'));},'Fixture page');
  await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(packet.id&&pending.has(packet.id)){const job=pending.get(packet.id);pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.text||'Page exception');});});
  await send('Runtime.enable');await send('Page.enable');
  await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===80'),'Catalog');

  await open('live');await until(()=>evaluate('document.querySelector("#next-chat-timeline").textContent.includes("Saved answer for Chat live")'),'Live history');
  const emit=(nodeId,status)=>fixture.send({type:'agent.event',runId:'turn-live',nodeId,at:new Date().toISOString(),data:{type:'planning.reassessment',module:'modular-outcome',status,reviewStatus:status,sequence:2,reviewReason:'Fixture recovery'}});
  emit('agent','recovering');
  await until(()=>evaluate('!!document.querySelector(".next-chat-efficiency-warning")'),'Live recovery warning');
  checks.liveWarning=true;
  emit('other','reviewing');await sleep(150);
  assert.equal(await evaluate('!!document.querySelector(".next-chat-efficiency-warning")'),true);checks.otherNodeDoesNotHide=true;
  const style=await evaluate('(()=>{const e=document.querySelector(".next-chat-efficiency-warning"),s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,role:e.getAttribute("role"),rect:e.getBoundingClientRect().height}})()');
  assert.equal(style.color,'rgb(244, 215, 120)');assert.equal(style.role,'status');assert.ok(style.rect>0);
  await mkdir(root+'/verification',{recursive:true});
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(root+'/verification/outcome-recovery-warning.png',Buffer.from(shot.data,'base64'));
  emit('agent','reviewing');await until(()=>evaluate('!document.querySelector(".next-chat-efficiency-warning")'),'Recovery cleared');
  checks.clearsOnReassessment=true;assert.equal(posts.length,0);assert.equal(errors.length,0);
  console.log('PASS '+JSON.stringify({checks,style,posts,errors,headless:true,syntheticData:true}));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{try{await send('Browser.close');}catch{}try{ws?.close();}catch{}try{child?.kill();}catch{}fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
