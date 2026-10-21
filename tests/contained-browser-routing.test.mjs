import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('contained web tasks do not start or automate Neo and pause page work after a quiet sign-in report',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-contained-routing-')),cwd=path.join(root,'workspace');await mkdir(cwd);
 let native=0,pages=0;
 const connections={redact:String,signedBrowser:{available:true,connectionId:'browseros-neo'},refreshSignedBrowser:async()=>{native++;return{available:true};},list:()=>[],status:()=>({}),call:async()=>{native++;},close:async()=>{}};
 let tabs=[{tabId:'personal-tab',url:'https://personal.example/'}];
 const browser={status:()=>({available:true,contained:true,tabs,activeTab:'personal-tab'}),perform:async(args,options)=>{pages++;assert.equal(args.browser,'relay');assert.ok(options.owner?.taskId);assert.ok(options.owner?.runId);assert.ok(options.owner?.nodeId);tabs.push({tabId:'contained-tab',url:args.url,owner:{...options.owner}});return{tabId:'contained-tab',url:args.url};},close:async()=>{}};
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'demo',models:[{id:'demo',model:'demo',available:true}]};}
  async runAgent(options){
   assert.match(options.prompt,/BACKGROUND WORKSPACE/);assert.match(options.developerInstructions,/contained (?:relay_browser|browser)/);
   assert.doesNotMatch(options.prompt,/Use it by default for website work/);
   for(const action of ['tools','call']){
    const result=await options.onToolCall({name:'relay_connections',arguments:{action,connectionId:'browseros-neo',name:'tabs',arguments:{action:'new',url:'https://example.com/'}}});
    assert.equal(result.success,false);assert.match(result.contentItems[0].text,/External Neo interaction is disabled/);
   }
   const foreign=await options.onToolCall({name:'relay_browser',arguments:{action:'read',tabId:'personal-tab'}});assert.equal(foreign.success,false);assert.equal(foreign.code,'BROWSER_TAB_OWNERSHIP');assert.equal(pages,0);
   assert.equal((await options.onToolCall({name:'relay_browser',arguments:{action:'open',browser:'relay',url:'https://example.com/'}})).success,true);
   const report=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://example.com/',reason:'sign-in',evidence:'login-form'}});assert.equal(report.success,true);assert.match(report.contentItems[0].text,/Observe/);
   const repeat=await options.onToolCall({name:'relay_browser',arguments:{action:'click',tabId:'contained-tab',ref:'submit'}});assert.equal(repeat.success,false);assert.match(repeat.contentItems[0].text,/actions are paused/);
   return{output:'Sign in inside Observe to continue. Nothing submitted.'};
  }
 }
 const engine=new HarnessEngine({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:cwd,connections,browser});await engine.init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const task='Inspect https://example.com/ in the contained browser.';const started=engine.startRun({workflow:createMissionWorkflow({task,model:'demo',cwd,id:'contained-routing'}),input:task});
 await engine.executions.get(started.id);const result=engine.getRun(started.id);assert.equal(result.status,'completed',result.error);assert.equal(result.browserSignIn.browser,'relay');assert.equal(native,0);assert.equal(pages,1);
});
