/** Actual renderer QA in a hidden Electron window; entirely synthetic data. */
import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {projectConversationGoal} from '../public/next/chat/model.mjs';
import {makeFixture} from './next-fixture-server.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'verification');
mkdirSync(out,{recursive:true});
const qa=path.join(root,'.build','goal-mode-qa');mkdirSync(qa,{recursive:true});
const fail=error=>{writeFileSync(path.join(out,'goal-mode-visual.json'),JSON.stringify({passed:false,error:String(error?.stack||error)}));app.exit(1);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const phase=label=>writeFileSync(path.join(qa,'progress.json'),JSON.stringify({label,at:new Date().toISOString()}));
phase('initializing');
const profile=mkdtempSync(path.join(tmpdir(),'blackice-goal-visual-'));
app.setPath('userData',profile);app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
const fixture=makeFixture(),state=fixture.state,posts=[],errors=[],checks={};

const first=structuredClone(state.runs.at(-1));first.status='completed';first.settled=true;first.nodes.agent.status='completed';first.nodes.agent.output='The implementation is in place. I am checking the remaining interactions and then the final result.';
first.taskState=null;first.events=[];first.input='Add persistent goals to this conversation.';
state.runs=[first];state.conversations=[{...state.conversations[0],title:'Goal mode · Build and verify',status:'completed',settled:true}];
let goal={id:'visual-goal',revision:1,objective:'Build a complete feature, verify the result, and keep working until the outcome is achieved. Preserve the conversation, the selected model, and the work already done.',status:'active',turns:3,totalTurns:3,maxTurns:null,lastReason:'The core implementation is complete. Continue with the remaining checks.',currentRunId:first.id,running:false};
const base=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
fixture.server.on('request',async(req,res)=>{
  const route=new URL(req.url,'http://fixture').pathname;
  state.conversations[0].goal=projectConversationGoal(goal);
  if(/^\/api\/conversations\/[^/]+\/goal$/.test(route)){
    if(req.method==='GET')return json(res,{goal});
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');posts.push({route,body});
    if(goal&&body.expectedRevision!==goal.revision)return json(res,{error:'Goal revision changed'},409);
    if(body.action==='clear')goal=null;
    else if(body.action==='pause')goal={...goal,status:'paused',running:false,lastReason:'Paused by user.',revision:goal.revision+1};
    else if(body.action==='resume')goal={...goal,status:'active',running:false,turns:0,lastReason:'Ready to continue.',revision:goal.revision+1};
    else goal={...(goal||{id:'visual-goal',status:'active',turns:0,currentRunId:first.id,running:false}),objective:body.objective,maxTurns:body.maxTurns,revision:(goal?.revision||0)+1};
    fixture.send({type:'goal.updated',data:{conversationId:first.taskId,goal}});return json(res,{goal});
  }
  if(/^\/api\/conversations\/(?:sample-run-\d+|visual-next)$/.test(route))return json(res,{goal:projectConversationGoal(goal),rootId:first.taskId,state:'active',title:state.conversations[0].title,runs:state.runs});
  return base(req,res);
});
let window;
const until=async(fn,label,ms=16000)=>{phase(label);const end=Date.now()+ms;let last;while(Date.now()<end){try{if(await fn())return;}catch(error){last=error;}await sleep(60);}throw Error(label+' timed out '+(last?.message||''));};
const evaluate=expression=>window.webContents.executeJavaScript(expression,true);
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
const fill=(selector,value)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
const capture=async name=>{phase('capture '+name);await sleep(90);const image=await Promise.race([window.webContents.capturePage(),sleep(12000).then(()=>{throw Error('Capture timeout');})]);const shot=image.getSize().width>1100?image.resize({width:1100}):image;const file=path.join(out,name.replace(/\.png$/,'.jpg'));const data=shot.toJPEG(78);await writeFile(file,data);return{file,bytes:data.length,size:shot.getSize()};};
const geometry=async selector=>{
  const r=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height,hit:h===e||e.contains(h),width:innerWidth,height:innerHeight};})()');
  assert.ok(r.x>=-1&&r.y>=-1&&r.right<=r.width+1&&r.bottom<=r.height+1&&r.w>0&&r.h>0&&r.hit,selector+' visible and hittable '+JSON.stringify(r));return r;
};
async function verify(){try{
  phase('waiting for Electron');await app.whenReady();phase('starting fixture');await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1400,height:900,webPreferences:{sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',event=>{if(/Uncaught/.test(event.message||''))errors.push(event.message);});
  phase('loading fixture');await Promise.race([window.loadURL('http://127.0.0.1:'+fixture.server.address().port+'/next/'),sleep(15000).then(()=>{throw Error('Fixture load timed out');})]);
  await until(()=>evaluate('Boolean(document.querySelector(".next-conversation"))'),'Conversation catalog');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").textContent'),'Autonomy: Off');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").getAttribute("aria-checked")'),'false');
  checks.defaultAutonomyOff=true;
  await click('.next-conversation');
  await until(()=>evaluate('!document.querySelector("#next-chat-goal-card").hidden&&!document.querySelector("#next-chat-send").disabled'),'Goal and history loaded');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-status").textContent'),'Ready to continue');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").textContent'),'Autonomy: On');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").getAttribute("aria-checked")'),'true');
  checks.explicitAutonomyOn=true;
  await geometry('#next-chat-goal-pause');await geometry('#next-chat-goal-toggle');
  assert.equal(await evaluate('document.querySelector("#next-chat-subtitle").textContent'),'Goal ready');
  assert.ok((await evaluate('document.querySelector(".next-conversation-meta").textContent')).includes('Goal ready'));
  checks.sidebarPreservesGoalState=true;checks.readyIsNotRunning=true;checks.desktop=await capture('goal-mode-desktop.png');
  await fill('#next-chat-input','/goal pause');await evaluate('document.querySelector("#next-chat-form").requestSubmit();true');
  await until(()=>evaluate('document.querySelector("#next-chat-goal-status").textContent==="Paused"&&!document.querySelector("#next-chat-goal-resume").disabled'),'Slash pause');
  assert.equal(posts.length,1);assert.equal(posts[0].body.action,'pause');assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").textContent'),'Autonomy: Off');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").getAttribute("aria-checked")'),'false');
  checks.explicitAutonomyOff=true;
  checks.slashCommandUsesGoalEndpoint=true;
  await click('#next-chat-goal-toggle');await until(()=>evaluate('document.querySelector("#next-chat-goal-status").textContent==="Ready to continue"'),'Resume');
  assert.equal(await evaluate('document.querySelector("#next-chat-goal-toggle").getAttribute("aria-checked")'),'true');
  assert.equal(posts.length,2);assert.equal(posts[1].body.action,'resume');
  checks.pauseAndResume=true;
  const next={...structuredClone(first),id:'visual-next',parentRunId:first.id,status:'running',settled:false,nodes:{agent:{status:'running',threadId:'visual-thread',turnId:'visual-turn',output:''}},events:[],input:'Continue the current goal.'};
  state.runs.push(next);goal={...goal,revision:goal.revision+1,currentRunId:next.id,turns:1,totalTurns:4,running:true,lastReason:'Verifying the feature in the same conversation.'};
  fixture.send({type:'goal.updated',data:{conversationId:first.taskId,goal}});
  await until(()=>evaluate('document.querySelector("#next-chat-goal-status").textContent==="Running"&&document.querySelector("#next-chat-send").textContent==="Direct"'),'New goal turn followed');
  assert.equal(await evaluate('document.querySelectorAll(".next-conversation").length'),1);checks.sameConversationAutoFollow=true;
  await click('#next-chat-goal-edit');await until(()=>evaluate('document.querySelector("#next-chat-goal-dialog").open'),'Goal editor');
  await geometry('#next-chat-goal-input');await geometry('#next-chat-goal-save');
  checks.editor=await capture('goal-mode-editor.png');await click('#next-chat-goal-cancel');
  window.setSize(760,850);
  await until(()=>evaluate('innerWidth===760'),'Narrow viewport');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await geometry('#next-chat-goal-pause');await geometry('#next-chat-goal-toggle');
  checks.narrow=await capture('goal-mode-narrow.png');
  await click('#next-chat-goal-edit');await geometry('#next-chat-goal-input');await geometry('#next-chat-goal-save');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  checks.narrowEditor=await capture('goal-mode-narrow-editor.png');await click('#next-chat-goal-cancel');
  next.status='completed';next.settled=true;next.nodes.agent.status='completed';
  goal={...goal,revision:goal.revision+1,status:'interrupted',running:false,lastReason:'Recovered after an interruption.'};
  fixture.send({type:'goal.updated',data:{conversationId:first.taskId,goal}});
  await until(()=>evaluate('document.querySelector("#next-chat-goal-status").textContent==="Interrupted"&&!document.querySelector("#next-chat-goal-resume").hidden'),'Interrupted resume');
  checks.interruptedResume=true;
  assert.equal(errors.length,0);assert.equal(window.isVisible(),false);checks.hiddenWindow=true;
  await writeFile(path.join(out,'goal-mode-visual.json'),JSON.stringify({passed:true,checks,posts,errors},null,2));
  console.log(JSON.stringify({passed:true,checks,posts:posts.length,errors}));
}catch(error){await writeFile(path.join(out,'goal-mode-visual.json'),JSON.stringify({passed:false,error:error.stack,checks,posts,errors},null,2));console.error(error.stack);process.exitCode=1;}
finally{if(window&&!window.isDestroyed())window.destroy();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});app.exit(process.exitCode||0);}

}
void verify();
