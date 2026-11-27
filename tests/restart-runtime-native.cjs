const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events'),assert=require('assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await sleep(60);}throw Error('Timed out: '+s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){}async close(){}async runAgent(){throw Error('No model allowed');}}
(async()=>{
 await app.whenReady();app.on('window-all-closed',()=>{});
 const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));
 const {createQuitWindowGate}=await import(pathToFileURL(path.join(root,'desktop/quit-window-gate.mjs')));
 const {DesktopRestartController}=await import(pathToFileURL(path.join(root,'desktop/restart.mjs')));
 server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false,emailExecutableHint:null});
 const url=await server.listen();win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
 const gate=createQuitWindowGate({getWindow:()=>win}),events=[],profileDir=path.join(out,'restart-receipts');
 const controller=new DesktopRestartController({
  profileDir,getIdentity:()=>({pid:process.pid,startedAt:'2026-11-24T00:00:00.000Z',profileDir,mode:'window'}),getLaunchOptions:()=>({execPath:process.execPath,args:[],profileDir,mode:'window'}),
  checkReady:context=>server.assertRestartReady(context),
  prepare:async context=>{await server.beginRestart(context);if(!await gate({signal:context.signal}))throw Object.assign(Error('Renderer veto'),{code:'DESKTOP_RESTART_QUIT_VETOED'});},
  release:()=>server.endRestart(),relaunch:()=>{server.assertRestartPrepared();assert.equal(win.isDestroyed(),true);events.push('relaunch');},quit:()=>events.push('quit')
 });
 await win.loadURL(url+'/#runtime');
 await until("document.querySelector(\"#runtime-status\")?.textContent.includes(\"runtime sources loaded\")");
 await run("document.querySelector(\"#runtime-search\").value=\"Task Decomposition\";document.querySelector(\"#runtime-search\").dispatchEvent(new Event(\"input\",{bubbles:true}))");
 await until("!!document.querySelector(\"[data-runtime-item=\\\"skill:builtin-decomposition\\\"]\")");
 await run("document.querySelector(\"[data-runtime-item=\\\"skill:builtin-decomposition\\\"]\").click()");
 await until("!document.querySelector(\"#runtime-editor\").hidden&&!document.querySelector(\"#runtime-text\").disabled&&document.querySelector(\"#runtime-text\").value.length>0");
 const draft='Actual Runtime draft survives cancelled restart and remains savable.';
 await run('document.querySelector("#runtime-text").value='+JSON.stringify(draft)+';document.querySelector("#runtime-text").dispatchEvent(new Event("input",{bubbles:true}))');
 for(let attempt=0;attempt<2;attempt++){
  await controller.request({requestId:'dirty-restart-'+attempt});const receipt=await controller.waitForHandoff();
  assert.equal(receipt.status,'failed');assert.equal(receipt.error.code,'DESKTOP_RESTART_QUIT_VETOED');assert.equal(receipt.durable,true);
  assert.equal(server.engine.maintenanceRequested,false);assert.deepEqual(events,[]);assert.equal(win.isDestroyed(),false);
  assert.equal(await run('document.querySelector("#runtime-text").value'),draft);
 }
 await run('document.querySelector("#runtime-editor").requestSubmit()');await until("document.querySelector(\"#runtime-save-status\").textContent.includes(\"saved for future turns\")");
 assert.equal(await run('(async()=>{const r=await fetch("/api/skills/builtin-decomposition");return(await r.json()).content})()'),draft);
 await controller.request({requestId:'clean-retry'});const receipt=await controller.waitForHandoff();assert.equal(receipt.status,'restarting');assert.deepEqual(events,['relaunch','quit']);
 await server.close();server=null;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks:['two actual mounted Runtime vetoes produce failed durable receipts','maintenance gate released after each veto','no relaunch or quit armed before consent','exact draft survives','real backend mutation succeeds after veto','clean retry accepts window closure before relaunch and quit']},null,2));app.quit();
})().catch(async e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);try{server?.endRestart();await server?.close();}finally{app.exit(1);}});
setTimeout(()=>{fs.writeFileSync(path.join(out,'timeout.txt'),'Timed out');app.exit(2)},30000).unref();

