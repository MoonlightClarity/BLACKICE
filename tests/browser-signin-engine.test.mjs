import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {BrowserWorkspace,browserOwnerKey} from '../lib/browser.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

function containedFixture() {
 const calls=[],tabs=[],ownerActiveTabs={};let nextId=0;
 const status=()=>({available:true,contained:true,tabs:structuredClone(tabs),folders:[],ownerActiveTabs:{...ownerActiveTabs}});
 const browser=new BrowserWorkspace({driver:{
  status,
  async perform(args,{owner}) {
   calls.push(structuredClone(args));
   if(args.action==='open') {
    const tab={tabId:`tab-${++nextId}`,url:args.url,owner};tabs.push(tab);ownerActiveTabs[browserOwnerKey(owner)]=tab.tabId;
    return{tabId:tab.tabId,...status()};
   }
   const tab=tabs.find(value=>value.tabId===args.tabId);
   if(args.action==='navigate')tab.url=args.url;
   if(args.action==='close'){tabs.splice(tabs.indexOf(tab),1);return status();}
   return{...(tab?{tabId:tab.tabId}:{}),...status()};
  },
  async close() {},
 }});
 return{browser,calls};
}
const browse=(options,args)=>options.onToolCall({name:'relay_browser',arguments:args});
const data=result=>JSON.parse(result.contentItems[0].text);

test('a reported contained sign-in leaves inspection, cleanup and unrelated browser work available',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agentdesk-quiet-auth-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
 await mkdir(cwd);
 let nativeCalls=0,windowOpens=0;
 const {browser,calls}=containedFixture();
 const connections={
  signedBrowser:{available:true,connectionId:'browseros-neo',toolNames:['tabs','navigate','snapshot','act']},
  refreshSignedBrowser:async()=>{windowOpens++;return{available:true,connectionId:'browseros-neo'};},
  list:()=>[],status:()=>({}),redact:String,call:async()=>{nativeCalls++;return{content:[{type:'text',text:'Observed the separate signed-in native session.'}]};},
  close:async()=>{},
 };
 class Runtime extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:'model-test',models:[{id:'model-test',model:'model-test',available:true}]};}
  async runAgent(options){
   assert.match(options.prompt,/WEBSITE SIGN-IN BLOCKERS/);
   assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_browser_signin'),true);
   const blockedTab=data(await browse(options,{action:'open',url:'https://www.linkedin.com/login'})).tabId;
   const otherTab=data(await browse(options,{action:'open',url:'https://example.com/'})).tabId;
   const reported=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/feed/',reason:'sign-in',evidence:'login-redirect'}});
   assert.equal(reported.success,true);
   const repeated=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/login',reason:'sign-in',evidence:'login-redirect'}});
   assert.equal(repeated.success,true);
   const guarded=await browse(options,{action:'click',tabId:blockedTab,ref:'submit'});
   assert.equal(guarded.success,false);
   assert.equal(data(guarded).code,'BROWSER_SIGNIN_REQUIRED');assert.equal(data(guarded).actionDispatched,false);
   for(const args of [
    {action:'read',tabId:blockedTab},{action:'tabs'},{action:'click',tabId:otherTab,ref:'ordinary-link'},
    {action:'navigate',tabId:blockedTab,url:'https://example.org/'},{action:'click',tabId:blockedTab,ref:'ordinary-link'},
    {action:'close',tabId:blockedTab},
   ])assert.equal((await browse(options,args)).success,true,args.action);
   const native=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'tabs',arguments:{}}});
   assert.equal(native.success,true);assert.match(native.contentItems[0].text,/separate signed-in native session/);
   return{output:'LinkedIn sign-in is required; nothing was published.'};
  }
 }
 const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd,connections,browser});
 await engine.init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true})});
 const task='Open https://www.linkedin.com/feed/ to inspect sign-in status.';
 const workflow=createMissionWorkflow({task,model:'model-test',cwd,id:'quiet-auth-workflow'});
 const started=engine.startRun({workflow,input:task});
 let run;
 for(let i=0;i<80;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(run.status,'completed',run.error);
 assert.deepEqual(calls.map(value=>value.action),['open','open','read','tabs','click','navigate','click','close']);
 assert.equal(nativeCalls,1);
 assert.equal(windowOpens,0);
 assert.equal(run.browserSignIn.hostname,'www.linkedin.com');assert.equal(run.browserSignIn.browser,'relay');
 assert.equal(run.browserSignIn.status,'awaiting-user');
 assert.equal(run.events.filter(e=>e.data?.type==='browser.signin').length,1,'duplicate reports must be idempotent');
 await engine.persist();
 const contents=JSON.parse(await readFile(path.join(dataDir,'runs.json'),'utf8'));
 assert.equal(contents.find(item=>item.id===run.id)?.browserSignIn?.origin,'https://www.linkedin.com');
});

test('delegated workers can inspect and close the challenged page and use unrelated contained and native tabs',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agentdesk-delegated-auth-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
 await mkdir(cwd);
 let nativeCalls=0;
 const {browser,calls}=containedFixture();
 const connections={
  signedBrowser:{available:true,connectionId:'browseros-neo'},
  refreshSignedBrowser:async()=>({available:true}),list:()=>[],status:()=>({}),
  redact:String,call:async()=>{nativeCalls++;return{content:[{type:'text',text:'Independent native fixture session.'}]};},close:async()=>{},
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
    const blockedTab=data(await browse(options,{action:'open',url:'https://linkedin.com/login'})).tabId;
    const otherTab=data(await browse(options,{action:'open',url:'https://example.com/'})).tabId;
    const reported=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://linkedin.com/feed',reason:'sign-in',evidence:'login-form'}});
    assert.equal(reported.success,true);
    assert.equal(data(await browse(options,{action:'click',tabId:blockedTab,ref:'submit'})).code,'BROWSER_SIGNIN_REQUIRED');
    for(const args of [{action:'read',tabId:blockedTab},{action:'tabs'},{action:'click',tabId:otherTab,ref:'link'},{action:'close',tabId:blockedTab}])assert.equal((await browse(options,args)).success,true,args.action);
    const native=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'tabs',arguments:{}}});
    assert.equal(native.success,true);
    return {output:'LinkedIn sign-in required'};
   }
   const result=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'webcheck',prompt:'Inspect LinkedIn sign in and report any blocker.'}]}});
   assert.equal(result.success,true);
   return {output:'A subagent reported sign-in required.'};
  }
 }
 const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd,connections,browser});
 await engine.init();
 const {RuntimeSettingsStore}=await import('../lib/runtime-settings.mjs');
 const prefs=await new RuntimeSettingsStore({dataDir}).init();engine.runtimeSettings=prefs;
 await prefs.update({subagentsEnabled:true,maxSubagents:2});
 t.after(async()=>{await engine.close();await prefs.close();await rm(root,{recursive:true,force:true})});
 const task='Inspect LinkedIn at https://linkedin.com/feed/ and report login status.';
 const workflow=createMissionWorkflow({task,model:'demo',cwd,id:'subagent-signin'});
 const started=engine.startRun({workflow,input:task});
 let run;
 for(let i=0;i<120;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(run.status,'completed',run.error);
 assert.equal(run.browserSignIn?.hostname,'linkedin.com');assert.equal(run.browserSignIn.browser,'relay');
 assert.equal(run.events.filter(e=>e.data?.type==='browser.signin').length,1);
 assert.deepEqual(calls.map(value=>value.action),['open','open','read','tabs','click','close']);assert.equal(nativeCalls,1);
});
