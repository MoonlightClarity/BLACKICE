// Historical schema-13 guarded-worker regression; current canonical behavior has separate engine acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from './fixture-legacy-planning-engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('contained sign-in blocks external browser fallback while independent integrations remain usable',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agentdesk-quiet-auth-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
 await mkdir(cwd);
 let browserCalls=0,nativeCalls=0,independentCalls=0,windowOpens=0;
 const connections={
  signedBrowser:{available:true,connectionId:'browseros-neo',toolNames:['tabs','navigate','snapshot','act']},
  refreshSignedBrowser:async()=>{windowOpens++;return{available:true,connectionId:'browseros-neo'};},
  list:()=>[{id:'fixture-notes',name:'Synthetic local notes'}],status:()=>({}),redact:String,call:async id=>{if(id==='browseros-neo'){nativeCalls++;assert.fail('External browser fallback must never dispatch.');}assert.equal(id,'fixture-notes');independentCalls++;return{content:[{type:'text',text:'Observed the independent synthetic local note.'}]};},
  close:async()=>{},
 };
 class Runtime extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:'model-test',models:[{id:'model-test',model:'model-test',available:true}]};}
  async runAgent(options){
   assert.match(options.prompt,/WEBSITE SIGN-IN AND VERIFICATION/);
   assert.match(options.developerInstructions,/an employer-direct ATS route and any observed email or magic-link login option/);
   assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_browser_signin'),true);
   const reported=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/feed/',reason:'sign-in',evidence:'login-redirect'}});
   assert.equal(reported.success,true);
   const repeated=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/login',reason:'sign-in',evidence:'login-redirect'}});
   assert.equal(repeated.success,true);
   const guarded=await options.onToolCall({name:'relay_browser',arguments:{action:'navigate',tabId:'contained-tab',url:'https://www.linkedin.com/'}});
   assert.equal(guarded.success,false);
   assert.match(guarded.contentItems[0].text,/Browser actions are paused/);
   const native=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'tabs',arguments:{}}});
   assert.equal(native.success,false);assert.equal(native.code,'BROWSER_CONTAINED_ONLY');assert.equal(native.receipt.actionDispatched,false);
    const independent=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'fixture-notes',name:'read_note',arguments:{}}});
    assert.equal(independent.success,true);assert.match(independent.contentItems[0].text,/independent synthetic local note/);
   return{output:'LinkedIn sign-in is required; nothing was published.'};
  }
 }
 const browser={status:()=>({available:true,contained:true}),perform:async()=>{browserCalls++;throw Error('A paused browser action must not reach its driver.');},close:async()=>{}};
 const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd,connections,browser});
 await engine.init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true})});
 const task='Open https://www.linkedin.com/feed/ to inspect sign-in status.';
 const workflow=createMissionWorkflow({task,model:'model-test',cwd,id:'quiet-auth-workflow',planningMode:'off'});
 const started=engine.startRun({workflow,input:task});
 let run;
 for(let i=0;i<80;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(run.status,'completed',run.error);
 assert.equal(browserCalls,0);
 assert.equal(nativeCalls,0);assert.equal(independentCalls,1);
 assert.equal(windowOpens,0);
 assert.equal(run.browserSignIn.hostname,'www.linkedin.com');assert.equal(run.browserSignIn.browser,'relay');
 assert.equal(run.browserSignIn.status,'awaiting-user');
 assert.equal(run.events.filter(e=>e.data?.type==='browser.signin').length,1,'duplicate reports must be idempotent');
 await engine.persist();
 const contents=JSON.parse(await readFile(path.join(dataDir,'runs.json'),'utf8'));
 assert.equal(contents.find(item=>item.id===run.id)?.browserSignIn?.origin,'https://www.linkedin.com');
});

test('native social-login report inspects an owned email alternative and keeps the site unpaused',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-email-fallback-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
 await mkdir(cwd);
 let owner=null,snapshots=0,clicks=0;
 const browser={
  status:()=>({available:true,contained:true,tabs:[{tabId:'auth-tab',url:'https://www.linkedin.com/login',documentId:'auth-tab:1',browser:'relay',purpose:'ordinary',folderId:'task-auth',owner}],activeTab:'auth-tab',folders:[{id:'task-auth',kind:'task',taskId:owner?.taskId}]}),
  perform:async (args,context)=>{
   assert.equal(args.tabId,'auth-tab');
   assert.equal(context?.owner?.nodeId,'agent');
   if(args.action==='snapshot'){
     snapshots++;
     return{tabId:'auth-tab',frames:[{elements:[
      {role:'button',name:'Continue with LinkedIn',ref:'social-1',disabled:false},
      {role:'button',name:'Continue with email',ref:'email-2',disabled:false}
     ]}]};
   }
   if(args.action==='click'){
     clicks++;assert.equal(args.ref,'email-2');
     return{tabId:'auth-tab',actionDispatched:true};
   }
   throw Error('Unexpected website action '+args.action);
  },
  close:async()=>{}
 };
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture',available:true}]};}
  async runAgent(options){
   assert.match(options.prompt,/Recover the existing applicant email from a verified saved resume/);
   const result=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/login',reason:'sign-in',evidence:'login-form'}});
   assert.equal(result.success,true);
   const finding=JSON.parse(result.contentItems[0].text);
   assert.equal(finding.recorded,false);
   assert.equal(finding.emailSignInAvailable,true);
   const clicked=await options.onToolCall({name:'relay_browser',arguments:{action:'click',browser:'relay',tabId:'auth-tab',ref:'email-2',expectedUrl:'https://www.linkedin.com/login',expectedDocumentId:'auth-tab:1'}});
   assert.equal(clicked.success,true,JSON.stringify(clicked));
   return{output:'The contained page offered an email login; I selected it once without submitting an application or claiming authentication.'};
  }
 }
 const engine=new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:cwd,browser});
 await engine.init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true})});
 const task='Inspect https://www.linkedin.com/login and use an observed email-login alternative rather than giving up on social login; do not submit applications.';
 const workflow=createMissionWorkflow({task,model:'fixture',cwd,id:'email-fallback-fixture',planningMode:'off'});
 const started=engine.startRun({workflow,input:task});
 const startRun=engine.getRun(started.id);owner={taskId:startRun.taskId||startRun.id,runId:startRun.id,nodeId:'agent'};
 let run;
 for(let i=0;i<90;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(run.status,'completed',run.error);
 assert.equal(run.browserSignIn,undefined,'no human blocker should be stored while email sign-in is available');
 assert.equal(snapshots,1,'only one read-only alternative inspection');
 assert.equal(clicks,1,'the observed email option was clicked once');
 assert.doesNotMatch(run.nodes.agent.output,/application submitted|sign-in completed/i);
});

test('guarded delegated workers preserve the contained challenge while independent integrations remain usable',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agentdesk-delegated-auth-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
 await mkdir(cwd);
 let calls=0,nativeCalls=0,independentCalls=0;
 const connections={
  signedBrowser:{available:true,connectionId:'browseros-neo'},
  refreshSignedBrowser:async()=>({available:true}),list:()=>[{id:'fixture-notes',name:'Synthetic local notes'}],status:()=>({}),
  redact:String,call:async id=>{if(id==='browseros-neo'){nativeCalls++;assert.fail('External browser fallback must never dispatch.');}assert.equal(id,'fixture-notes');independentCalls++;return{content:[{type:'text',text:'Independent synthetic local note.'}]};},close:async()=>{},
 };
 class Runtime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'demo',models:[{id:'demo',model:'demo',available:true}]};}
  async runAgent(options){
   if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
    assert.ok(options.dynamicTools.some(t=>t.name==='relay_browser_signin'));
    assert.ok(!options.dynamicTools.some(t=>t.name==='relay_delegate'));
    assert.ok(options.dynamicTools.some(t=>t.name==='relay_connections'));
    assert.ok(!options.dynamicTools.some(t=>t.name==='relay_task'));
    assert.match(options.developerInstructions,/The coordinator owns the final remote send/);
    assert.match(options.developerInstructions,/Return the actual evidence and any uncertain existing effects/);
    if(options.prompt.includes('Read the independent synthetic local note.')){
     const independent=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'fixture-notes',name:'read_note',arguments:{}}});
     assert.equal(independent.success,true);return {output:'Independent synthetic local note checked.'};
    }
    const reported=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://linkedin.com/feed',reason:'sign-in',evidence:'login-form'}});
    assert.equal(reported.success,true);
    const second=await options.onToolCall({name:'relay_browser',arguments:{action:'tabs'}});
    assert.equal(second.success,false);
    const native=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'tabs',arguments:{}}});
    assert.equal(native.success,false);assert.equal(native.code,'BROWSER_CONTAINED_ONLY');assert.equal(native.receipt.actionDispatched,false);
     const independent=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'fixture-notes',name:'read_note',arguments:{}}});
     assert.equal(independent.success,true);
    return {output:'LinkedIn sign-in required'};
   }
   const result=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'webcheck',prompt:'Inspect LinkedIn sign in and report any blocker.'},{id:'local-note',prompt:'Read the independent synthetic local note.'}]}});
   assert.equal(result.success,true);
   return {output:'A subagent reported sign-in required.'};
  }
 }
 const browser={status:()=>({available:true,contained:true}),perform:async()=>{calls++;throw Error('A worker cannot bypass the shared browser blocker.');},close:async()=>{}};
 const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd,connections,browser});
 await engine.init();
 const {RuntimeSettingsStore}=await import('../lib/runtime-settings.mjs');
 const prefs=await new RuntimeSettingsStore({dataDir}).init();engine.runtimeSettings=prefs;
 await prefs.update({subagentsEnabled:true,maxSubagents:2,executionGuardrails:true});
 t.after(async()=>{await engine.close();await prefs.close();await rm(root,{recursive:true,force:true})});
 const task='Inspect LinkedIn at https://linkedin.com/feed/ and report login status.';
 const workflow=createMissionWorkflow({task,model:'demo',cwd,id:'subagent-signin',planningMode:'off'});
 const started=engine.startRun({workflow,input:task});
 let run;
 for(let i=0;i<120;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(run.status,'completed',run.error);
 assert.equal(run.browserSignIn?.hostname,'linkedin.com');assert.equal(run.browserSignIn.browser,'relay');
 assert.equal(run.events.filter(e=>e.data?.type==='browser.signin').length,1);
 assert.equal(calls,0);assert.equal(nativeCalls,0);assert.equal(independentCalls,2);
});
