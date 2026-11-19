const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{pathToFileURL}=require('url');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,fixture;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await sleep(50);}throw Error(s)};
(async()=>{
 await app.whenReady();const {makeFixture}=await import(pathToFileURL(path.join(root,'tests/next-fixture-server.mjs')));fixture=makeFixture();fixture.state.deployments=[];fixture.state.jobs=[];
 await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false,offscreen:true}});
 await win.loadURL('http://127.0.0.1:'+fixture.server.address().port+'/next/#cronjobs');await until('!!document.querySelector(".next-cronjobs-empty")');
 const metrics=[];
 for(const width of [1200,390]){
  win.setSize(width,900);await sleep(150);
  const item=await run('(()=>{const e=document.querySelector(".next-cronjobs-empty"),s=getComputedStyle(e);return{text:e.textContent,card:e.classList.contains("next-empty"),height:e.getBoundingClientRect().height,fontSize:s.fontSize,border:s.borderTopWidth,align:s.textAlign,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
  assert.equal(item.text,'No cronjobs yet.');assert.equal(item.card,false);assert.ok(item.height<=32);assert.equal(item.fontSize,'12px');assert.equal(item.border,'0px');assert.equal(item.align,'left');assert.equal(item.overflow,false);metrics.push({width,...item});
  fs.writeFileSync(path.join(out,'empty-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 assert.equal(await run('document.querySelector("#next-tasks-new-schedule").textContent'),'New cronjob');
 await run('document.querySelector("#next-tasks-new-schedule").click()');assert.equal(await run('document.querySelector("#next-tasks-create").hidden'),false);
 assert.equal(fixture.state.deployments.length,0);
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,metrics,checks:['Quiet inline empty hint at desktop and narrow widths','New cronjob control opens existing form','No schedules created']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();fixture?.server.closeAllConnections?.();if(fixture)await new Promise(r=>fixture.server.close(r));app.exit(process.exitCode||0);});
setTimeout(()=>app.exit(2),60000).unref();
