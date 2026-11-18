const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,server;const checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=s=>win.webContents.executeJavaScript(s);
const until=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await sleep(100);}throw Error('Timed out: '+s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('No model run allowed');}}
(async()=>{
 await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0});const base=await server.listen();
 win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadURL(base+'/#skills');await until('!!document.querySelector("[data-skill-id]")');

 const create=async name=>{await run('document.querySelector("#skills-folder-name").value='+JSON.stringify(name)+';document.querySelector("#skills-folder-form").requestSubmit()');await until('document.querySelector("#skills-folder-name").value===""');return run('fetch("/api/skills/folders").then(r=>r.json())');};
 let state=await create('Career');const parent=state.folders[0].id;state=await create('Research');const child=state.folders.find(x=>x.name==='Research').id;
 await run(`document.querySelector('[data-folder-name="${child}"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}))`);
 await until('fetch("/api/skills/folders").then(r=>r.json()).then(s=>s.folders.find(f=>f.id==='+JSON.stringify(child)+').parentId==='+JSON.stringify(parent)+')');
 await run(`(()=>{const dataTransfer=new DataTransfer();document.querySelector("[data-skill-id=builtin-browser]").dispatchEvent(new DragEvent("dragstart",{dataTransfer,bubbles:true}));document.querySelector('[data-folder-id="${child}"]').dispatchEvent(new DragEvent("drop",{dataTransfer,bubbles:true}));})()`);
 await until('fetch("/api/skills/folders").then(r=>r.json()).then(s=>s.assignments["builtin-browser"]==='+JSON.stringify(child)+')');
 await run('document.querySelector("[data-skill-id=builtin-browser]").click()');await until('!document.querySelector("#skills-editor").hidden');
 checks.push('Ctrl+Enter nests a folder and drag assigns a skill through actual UI/API');
 for(const width of [1200,640]){win.setSize(width,900);await sleep(200);const rect=await run('(()=>{const r=document.querySelector(".next-skills-layout").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()');if(rect.left<0||rect.right>rect.width)throw Error('Overflow '+JSON.stringify(rect));fs.writeFileSync(path.join(out,'skills-'+width+'.png'),(await win.webContents.capturePage()).toPNG());checks.push('Folder outline and single document fit '+width);}
 await win.reload();await until('document.querySelectorAll("[data-folder-id]").length===2');state=await run('fetch("/api/skills/folders").then(r=>r.json())');if(state.assignments['builtin-browser']!==child||state.folders.find(x=>x.id===child).parentId!==parent)throw Error('Organization lost');checks.push('Reload preserves nested folders and skill placement');
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0)});setTimeout(()=>app.exit(2),45000).unref();
