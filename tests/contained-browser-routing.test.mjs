import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('contained browser exposes screenshot-relative visual control input with its document guard', () => {
 const fields=BROWSER_TOOL.inputSchema.properties;
 assert.match(fields.x.description,/visible page control/);
 assert.match(fields.x.description,/screenshot-relative CSS pixels/);
 assert.match(fields.expectedDocumentId.description,/coordinate click or hover/);
});

test('contained ownership and sign-in pause retain BLACKICE-only task browser routing',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-contained-routing-')),cwd=path.join(root,'workspace');await mkdir(cwd);
 let native=0,pages=0,refreshes=0;
 const catalog=[{name:'tabs',inputSchema:{type:'object'}},{name:'run',description:'BrowserOS neo SDK: browser.pages.list() and browser.cdp().',inputSchema:{type:'object'}}];
 const config={id:'browseros-neo',name:'BrowserOS Neo',enabled:true,connected:true,toolCount:catalog.length},client={tools:catalog,connected:true};
 const connections={redact:String,signedBrowser:{available:true,connectionId:config.id},configs:new Map([[config.id,config]]),clients:new Map([[config.id,client]]),refreshSignedBrowser:async()=>{refreshes++;return{available:true};},list:()=>[config],status:()=>({}),connect:async()=>client,tools:async()=>({tools:catalog}),call:async(_id,name,args,options)=>{options.onDispatch?.();native++;return{content:[{type:'text',text:JSON.stringify({name,args})}]};},close:async()=>{}};
 let tabs=[{tabId:'personal-tab',url:'https://personal.example/'}];
 const browser={status:()=>({available:true,contained:true,tabs,activeTab:'personal-tab'}),perform:async(args,options)=>{pages++;assert.equal(args.browser,'relay');assert.ok(options.owner?.taskId);assert.ok(options.owner?.runId);assert.ok(options.owner?.nodeId);tabs.push({tabId:'contained-tab',url:args.url,owner:{...options.owner}});return{tabId:'contained-tab',url:args.url};},close:async()=>{}};
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'demo',models:[{id:'demo',model:'demo',available:true}]};}
  async runAgent(options){
   assert.match(options.prompt,/BACKGROUND WORKSPACE/);assert.match(options.developerInstructions,/contained (?:relay_browser|browser)/);
   assert.match(options.prompt,/Use only the BLACKICE contained browser/);
   assert.match(options.prompt,/Do not call Chrome/);
   assert.match(options.prompt,/Preserve an in-progress form/);
   assert.deepEqual(options.dynamicTools.find(tool=>tool.name==='relay_connections').inputSchema.properties.action.enum,['connections','tools','call']);
   const foreign=await options.onToolCall({name:'relay_browser',arguments:{action:'read',tabId:'personal-tab'}});assert.equal(foreign.success,false);assert.equal(foreign.code,'BROWSER_TAB_OWNERSHIP');assert.equal(pages,0);
   const discovered=await options.onToolCall({name:'relay_connections',arguments:{action:'tools',connectionId:config.id}});
   assert.equal(discovered.success,false);assert.equal(discovered.code,'BROWSER_CONTAINED_ONLY');assert.equal(discovered.receipt.actionDispatched,false);
   const opened=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:config.id,name:'tabs',arguments:{action:'new',url:'https://another.example/'}}});
   assert.equal(opened.success,false);assert.equal(opened.code,'BROWSER_CONTAINED_ONLY');assert.equal(opened.receipt.actionDispatched,false);
   assert.equal((await options.onToolCall({name:'relay_browser',arguments:{action:'open',browser:'relay',url:'https://example.com/'}})).success,true);
   const report=await options.onToolCall({name:'relay_browser_signin',arguments:{site:'https://example.com/',reason:'sign-in',evidence:'login-form'}});assert.equal(report.success,true);assert.match(report.contentItems[0].text,/Observe/);
   const repeat=await options.onToolCall({name:'relay_browser',arguments:{action:'click',tabId:'contained-tab',ref:'submit'}});assert.equal(repeat.success,false);assert.match(repeat.contentItems[0].text,/actions are paused/);
   const nativeAfterPause=await options.onToolCall({name:'relay_connections',arguments:{action:'call',connectionId:config.id,name:'run',arguments:{code:'return await browser.pages.list();'}}});
   assert.equal(nativeAfterPause.success,false);assert.equal(nativeAfterPause.code,'BROWSER_CONTAINED_ONLY');assert.equal(nativeAfterPause.receipt.actionDispatched,false);
   return{output:'Contained sign-in is paused; independent preparation can continue without a native browser.'};
  }
 }
 const engine=new HarnessEngine({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:cwd,connections,browser});await engine.init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const task='Inspect https://example.com/ using only the BLACKICE browser.';const started=engine.startRun({workflow:createMissionWorkflow({task,model:'demo',cwd,id:'contained-routing',planningMode:'off'}),input:task});
 await engine.executions.get(started.id);const result=engine.getRun(started.id);assert.equal(result.status,'completed',result.error);assert.equal(result.browserSignIn.browser,'relay');assert.equal(native,0);assert.equal(refreshes,0,'native work is dispatched only through explicit gateway calls');assert.equal(pages,1);
});
