const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,server;const checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await sleep(100);}throw Error('Timed out: '+s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('No model run allowed');}}
(async()=>{
 await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0});const base=await server.listen();
 win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadURL(base+'/#skills');await until('!!document.querySelector("[data-skill-id]")');

 const select=async()=>{await run('document.querySelector("[data-skill-id=builtin-browser]").click()');await until('!document.querySelector("#skills-content").hidden');};
 await select();
 const original=await run('document.querySelector("#skills-content").textContent');
 await run('document.querySelector("#skills-edit").click()');await until('!document.querySelector("#skills-editor").hidden');
 const text='Human edited instructions.\nUse this exact saved text.';
 await run('document.querySelector("#skills-edit-content").value='+JSON.stringify(text)+';document.querySelector("#skills-edit-content").dispatchEvent(new Event("input",{bubbles:true}))');
 for(const width of [1200,640]){win.setSize(width,900);await run('document.querySelector("#skills-editor").scrollIntoView({block:"start"})');await sleep(200);const rect=await run('(()=>{const r=document.querySelector("#skills-editor").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()');if(rect.left<0||rect.right>rect.width)throw Error('Editor overflow '+JSON.stringify(rect));fs.writeFileSync(path.join(out,'editor-'+width+'.png'),(await win.webContents.capturePage()).toPNG());checks.push('Editor fits '+width);}
 await run('document.querySelector("#skills-editor").requestSubmit()');await until('document.querySelector("#skills-detail-status").textContent.startsWith("Skill saved.")');
 if(await run('document.querySelector("#skills-content").textContent')!==text)throw Error('Saved view differs');
 checks.push('Actual UI saves and displays human-edited instructions');
 await win.reload();await until('!!document.querySelector("[data-skill-id]")');await select();
 if(await run('document.querySelector("#skills-content").textContent')!==text)throw Error('Reload lost edit');
 checks.push('Page reload retains exact human text');
 // Restart the server against the same isolated data folder.
 await win.loadURL('about:blank');await server.close();server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0});const restarted=await server.listen();
 await win.loadURL(restarted+'/#skills');await until('!!document.querySelector("[data-skill-id]")');await select();
 if(await run('document.querySelector("#skills-content").textContent')!==text)throw Error('Restart lost edit');
 checks.push('Server restart retains exact human text');
 const bundled=await import(pathToFileURL(path.join(root,'lib/release-skills.mjs')));if(bundled.readReleaseSkill('builtin-browser').content!==original)throw Error('Bundled original changed');
 checks.push('Bundled original remains unchanged');
 // Another writer wins; stale UI draft must survive a conflict.
 await run('document.querySelector("#skills-edit").click();document.querySelector("#skills-edit-content").value="Keep conflicting draft";document.querySelector("#skills-edit-content").dispatchEvent(new Event("input",{bubbles:true}))');
 await run('(async()=>{const e=await fetch("/api/skills/builtin-browser").then(r=>r.json());const {title,summary,scope,appliesWhen}=e;const r=await fetch("/api/skills/builtin-browser",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedRevision:e.revision,title,summary,scope,appliesWhen,content:"Another human edit"})});if(!r.ok)throw Error(await r.text());})()');
 await run('document.querySelector("#skills-editor").requestSubmit()');await until('document.querySelector("#skills-save-status").textContent.includes("draft is preserved")');
 if(await run('document.querySelector("#skills-edit-content").value')!=='Keep conflicting draft')throw Error('Conflict lost draft');
 await run('document.querySelector("#skills-discard").click()');await until('!document.querySelector("#skills-content").hidden');
 if(await run('document.querySelector("#skills-content").textContent')!=='Another human edit')throw Error('Discard failed to reload');
 checks.push('Concurrent edit conflict preserves draft; discard loads current version');
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0)});setTimeout(()=>app.exit(2),45000).unref();
