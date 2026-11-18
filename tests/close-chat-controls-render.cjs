const {app,BrowserWindow}=require('electron'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),assert=require('assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const run=async s=>{try{return await win.webContents.executeJavaScript(s,true);}catch(e){throw Error(s+'\\n'+e.message);}};const until=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await sleep(80);}throw Error(s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{id:'gpt-6-luna',available:true}],defaultModel:'gpt-6-luna'};}async start(){}async close(){}async runAgent(){throw Error('No model');}}
(async()=>{await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});const url=await server.listen();const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
const request=async(body)=>{const r=await fetch(url+(body?'/api/operations/folders':'/api/operations'),{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(await r.text());const value=await r.json();return body?value:value.organization;};
let org=await request();org=await request({action:'create',name:'Parent',expectedRevision:org.revision});const parent=org.folders.find(f=>f.name==='Parent').id;org=await request({action:'create',name:'Child',parentId:parent,expectedRevision:org.revision});
win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadURL(url+'/next/#cronjobs');await until('!!document.querySelector(".next-schedule-folder-manager")');

await run('document.querySelector(".next-tab[data-space=chat]").click();true');
await until('!!document.querySelector("#next-chat-folder-new")');
await run('document.querySelector("#next-chat-folder-new").click();document.querySelector("#next-chat-folder-name").value="test";document.querySelector("#next-chat-folder-form").requestSubmit();true');
await until('document.querySelector("#next-chat-folder-filter").options.length>2');
await run('document.querySelector("#next-chat-folder-filter").value="all";document.querySelector("#next-chat-folder-filter").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-name")');

await run('document.querySelector(".next-chat-folder-new-chat").click();true');
assert.match(await run('document.querySelector("#next-chat-title").textContent'),/test/);
await run('document.querySelector("#next-chat-input").value="Folder request";document.querySelector("#next-chat-input").dispatchEvent(new Event("input"));document.querySelector("#next-chat-form").requestSubmit();true');
await until('document.querySelector("#next-chat-hint").textContent.includes("Message sent")');
let saved=await run('(async()=>await(await fetch("/api/conversations?state=active")).json())()');
fs.writeFileSync(path.join(out,'first-result.json'),JSON.stringify({saved,hint:await run('document.querySelector("#next-chat-hint").textContent')},null,2));assert.equal(saved.conversations.length,1);assert.ok(saved.conversations[0].folderId);assert.equal(saved.conversations[0].folderSource,'manual');
await run('document.querySelector("#next-chat-input").value="Keep this unsent draft";document.querySelector("#next-chat-input").dispatchEvent(new Event("input"));document.querySelector("#next-chat-close").click();true');
assert.match(await run('document.querySelector("#next-chat-title").textContent'),/Unfiled/);
assert.match(await run('localStorage.getItem("blackice.next.drafts")'),/Keep this unsent draft/);
await run('document.querySelector("#next-chat-new").click();document.querySelector("#next-chat-input").value="Global request";document.querySelector("#next-chat-input").dispatchEvent(new Event("input"));document.querySelector("#next-chat-form").requestSubmit();true');
await until('document.querySelector("#next-chat-hint").textContent.includes("Message sent")');
saved=await run('(async()=>await(await fetch("/api/conversations?state=active")).json())()');assert.equal(saved.conversations.length,2);
assert.equal(saved.conversations.filter(c=>!c.folderId&&c.folderSource==='manual').length,1);
await win.reload();await until('!!document.querySelector(".next-chat-folder-new-chat")');
for(const width of [1200,640]){win.setSize(width,900);await sleep(150);fs.writeFileSync(path.join(out,'chat-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}

await run('(async()=>{document.body.innerHTML="<div id=browser-proof></div>";const {createBrowserWorkspace}=await import("/next/workspaces/browser.mjs");window.browserProof={tabs:[{tabId:"one",title:"Disposable research",url:"https://fixture.invalid/one",browser:"relay",visible:false},{tabId:"two",title:"Protected draft",url:"https://fixture.invalid/two",browser:"relay",visible:false,inUse:true}],collections:[{id:"folder",name:"Research",parentId:null}],calls:[]};const state=window.browserProof;window.proofWorkspace=createBrowserWorkspace({mount:document.querySelector("#browser-proof"),events:{subscribe:()=>()=>{}},api:async(route,method,body)=>{state.calls.push({route,method,body});if(route.startsWith("/api/browser/status"))return structuredClone(state);if(route==="/api/browser/close-all"){state.tabs=state.tabs.filter(t=>t.inUse);return{closed:1,failedTabs:[]};}if(body.action==="tab_collect"){state.tabs.find(t=>t.tabId===body.tabId).collectionId=body.collectionId;return{};}return{ok:true};},notify(){}});window.proofWorkspace.enter();return true;})()');
await until('!!document.querySelector(".next-browser-tab-move")');
await run('document.querySelector(".next-browser-tab-move").click();true');
assert.equal(await run('document.querySelector(".next-browser-folder-editor").parentElement.tagName'),'DIALOG');
assert.equal(await run('document.querySelector(".next-browser-move-dialog").open'),true);
await run('document.querySelector(".next-browser-folder-editor select").value="folder";document.querySelector(".next-browser-folder-editor").requestSubmit();true');
await until('!document.querySelector(".next-browser-folder-editor")');
assert.equal(await run('window.browserProof.tabs[0].collectionId'),'folder');
await run('document.querySelector(".next-browser-tab-move").click();true');
for(const width of [1200,640]){win.setSize(width,900);await sleep(150);fs.writeFileSync(path.join(out,'browser-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
await run('document.querySelector(".next-browser-folder-editor select").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));window.confirm=()=>true;document.querySelector("#next-browser-close-all").click();true');
await until('window.browserProof.tabs.length===1');assert.equal(await run('window.browserProof.tabs[0].tabId'),'two');
await run('window.proofWorkspace.destroy();true');
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks:['Folder +New persists manual destination through real HTTP','Close chat preserves unsent draft and saved history','Global new manually unfiled','Reload preserves both records','1200 and 640 captures','Actual browser DOM Move dialog and close-all against isolated fake tabs; in-use retained']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0);});setTimeout(()=>app.exit(2),60000).unref();
