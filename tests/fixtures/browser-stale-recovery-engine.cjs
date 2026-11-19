const {app}=require('electron'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');const [root,out]=process.argv.slice(2);
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
let server,driver,harness;const report={synthetic:true,passed:false};
const save=()=>fs.writeFile(path.join(out,'checks.json'),JSON.stringify(report,null,2));
const guard=setTimeout(async()=>{report.watchdog=true;await save();app.exit(2);},35000);
const imp=p=>import(pathToFileURL(path.join(root,p)));
const unpack=item=>JSON.parse(item.contentItems.find(x=>x.type==='inputText').text);
const findRef=page=>page.frames.flatMap(frame=>frame.elements).find(e=>e.name==='Inspect synthetic source')?.ref;
(async()=>{
 await fs.mkdir(path.join(out,'browser'),{recursive:true});await app.whenReady();
 const [{ElectronBrowserDriver},{BrowserWorkspace},{createHarnessServer},{createMissionWorkflow},{projectTurnMachineTrace}]=await Promise.all(['desktop/browser-driver.mjs','lib/browser.mjs','server.mjs','public/mission-model.mjs','lib/turn-machine-trace.mjs'].map(imp));
 server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Fixture findings</title><button onclick="window.fixtureClicks=(window.fixtureClicks||0)+1">Inspect synthetic source</button>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const source='http://127.0.0.1:'+server.address().port+'/results';
 driver=await new ElectronBrowserDriver({dataDir:path.join(out,'browser'),downloadDir:path.join(out,'downloads')}).init();
 class Runtime extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(o){
   const call=(action,args={},id=action)=>o.onToolCall({name:'relay_browser',callId:'fixture-'+id,arguments:{action,browser:'relay',...args}});
   const opened=unpack(await call('open',{url:source}));const ref=findRef(opened);const tab=driver.tab(opened.tabId);assert(ref);
   await tab.window.webContents.executeJavaScript("history.pushState({},'','/results?selected=fixture')");
   const failed=await call('click',{tabId:tab.id,ref},'old');
   assert.equal(failed.success,false);assert.equal(failed.code,'BROWSER_REF_STALE');assert.equal(failed.actionDispatched,false);
   assert.equal(await tab.window.webContents.executeJavaScript('window.fixtureClicks||0'),0);
   const refreshed=unpack(failed).recovery.observation;assert(refreshed,'the stale-ref error should carry a fresh observation');assert.equal(refreshed.tabId,tab.id);
   const current=findRef(refreshed);assert(current);assert.notEqual(current,ref);
   report.noReplay=true;
   const click=await call('click',{tabId:tab.id,ref:current},'new');assert.equal(click.success,true,JSON.stringify(click));
   assert.equal(await tab.window.webContents.executeJavaScript('window.fixtureClicks||0'),1);
   return {output:'Synthetic navigation fixture verified'};
  }
 }
 harness=await createHarnessServer({browser:new BrowserWorkspace({driver}),runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});await harness.listen({waitForRemote:false});
 const workflow=createMissionWorkflow({task:'Inspect a synthetic source',model:'fixture',cwd:out});
 const {id}=harness.engine.startRun({workflow,input:{task:'Inspect a synthetic source',directoryDiagnostics:'maximal'}});
 await harness.engine.executions.get(id);
 const run=harness.engine.runs.get(id);assert.equal(run.status,'completed',run.error);
 const entries=projectTurnMachineTrace(run).entries.filter(e=>e.kind==='browser.reference');
 assert.equal(entries.length,1,JSON.stringify(entries));const {metadata}=entries[0];assert.equal(metadata.bindingReason,'document-changed');assert.equal(metadata.topUrlChanged,true);assert.equal(metadata.actionDispatched,false);assert.notEqual(metadata.observedRevision,undefined);assert.notEqual(metadata.currentRevision,undefined);
 assert(!JSON.stringify(entries).includes('selected=fixture'));report.passed=true;report.receipt=entries[0];
})().catch(e=>{report.error=e.stack;}).finally(async()=>{await save();await Promise.race([(async()=>{await harness?.close();if(!harness)await driver?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));})(),new Promise(r=>setTimeout(r,3000))]);clearTimeout(guard);app.exit(report.passed?0:1);});
