const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,fixture;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
(async()=>{await app.whenReady();const {makeFixture}=await import(pathToFileURL(path.join(root,'tests/next-fixture-server.mjs')));fixture=makeFixture();fixture.state.tabs=[];
await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:false,backgroundThrottling:false}});
await win.loadURL('http://127.0.0.1:'+fixture.server.address().port+'/next/#browser');
let label;for(let i=0;i<100;i++){label=await run('document.querySelector("#next-browser-tabs .next-browser-tabs-empty")?.textContent');if(label)break;await sleep(100);}
if(!/^No .*tabs/.test(label||''))throw Error('Missing actual browser empty message: '+label);
if(await run('document.querySelector("#next-browser-tabs fragment")!==null'))throw Error('DocumentFragment was rendered as an element');
await sleep(1000);fs.writeFileSync(path.join(out,'empty.png'),(await win.webContents.capturePage()).toPNG());
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,label,realDOM:true},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();if(fixture){fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));await fixture.close();}app.exit(process.exitCode||0);});setTimeout(()=>app.exit(2),40000).unref();
