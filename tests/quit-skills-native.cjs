const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events'),assert=require('assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,server,recovery,didClose=false,shutdowns=0,cancelled=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await sleep(60);}throw Error('Timed out: '+s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){}async close(){}async runAgent(){throw Error('No model allowed');}}
(async()=>{
 await app.whenReady();
 const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));
 const {createQuitWindowGate}=await import(pathToFileURL(path.join(root,'desktop/quit-window-gate.mjs')));
 const {createNativeSafeQuitHandler,createNativeParentCloseHandler}=await import(pathToFileURL(path.join(root,'desktop/native-parent-lifetime.mjs')));
 const {DesktopRendererRecovery}=await import(pathToFileURL(path.join(root,'desktop/renderer-recovery.mjs')));
 server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0});
 const url=await server.listen();win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
 recovery=new DesktopRendererRecovery({window:win,url:url+'/#skills',isClosing:()=>didClose,showRecovery:async()=>({response:1})});
 win.on('close',createNativeParentCloseHandler({host:{},onAllowed:()=>{},closeWindow:()=>win.close()}));
 const handler=createNativeSafeQuitHandler({host:{},prepareQuit:createQuitWindowGate({getWindow:()=>win}),shutdown:async()=>{shutdowns++;await server.close();},onRetained:()=>cancelled++,onReleased:()=>{didClose=true;app.quit();},onFailure:e=>{throw e;},onTimeout:()=>{throw Error('Unexpected watchdog');}});
 app.on('before-quit',e=>{if(!didClose)void handler(e);});app.on('window-all-closed',()=>{});
 await win.loadURL(url+'/#skills');await until('!!document.querySelector("[data-skill-id=builtin-decomposition]")');
 await run('document.querySelector("[data-skill-id=builtin-decomposition]").click()');await until('!document.querySelector("#skills-editor").hidden');
 const draft='Actual Skills draft survives veto and saves.';
 await run('document.querySelector("#skills-edit-content").value='+JSON.stringify(draft)+';document.querySelector("#skills-edit-content").dispatchEvent(new Event("input",{bubbles:true}))');
 for(let attempt=0;attempt<2;attempt++){
  app.quit();if(attempt===0)app.quit();await sleep(150);
  assert.equal(cancelled,attempt+1);assert.equal(shutdowns,0);assert.equal(win.isDestroyed(),false);assert.equal(recovery.stopped,false);
  assert.equal(await run('document.querySelector("#skills-edit-content").value'),draft);
  assert.equal(await run('(async()=>{const r=await fetch("/api/skills/builtin-decomposition");return r.status})()'),200);
 }
 await run('document.querySelector("#skills-editor").requestSubmit()');await until('document.querySelector("#skills-save-status").textContent==="Saved."');
 assert.equal(await run('(async()=>{const r=await fetch("/api/skills/builtin-decomposition");return(await r.json()).content})()'),draft);
 app.on('will-quit',()=>{assert.equal(shutdowns,1);assert.equal(recovery.stopped,true);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,cancelled,shutdowns,checks:['actual mounted Skills veto repeated quit','backend HTTP stays available','draft remains exact','save after veto commits exact content','recovery stays active until accepted close','clean quit drains once']},null,2));});
 app.quit();
})().catch(async e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);try{await server?.close();}finally{app.exit(1);}});
setTimeout(()=>{fs.writeFileSync(path.join(out,'timeout.txt'),'Timed out');app.exit(2)},30000).unref();
