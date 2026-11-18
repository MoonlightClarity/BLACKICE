const {app,BrowserWindow}=require('electron'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),assert=require('assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const run=async s=>{try{return await win.webContents.executeJavaScript(s,true);}catch(e){throw Error(s+'\\n'+e.message);}};const until=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await sleep(80);}throw Error(s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{id:'gpt-6-luna',available:true}],defaultModel:'gpt-6-luna'};}async start(){}async close(){}async runAgent(){throw Error('No model');}}
(async()=>{await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});const url=await server.listen();const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadURL(url+'/next/#browser');await until('!!document.querySelector("#next-browser-new")');
await run('(async()=>{document.body.innerHTML="<div id=browser-proof></div>";window.relayDesktop={browserSurface:async request=>{if(request.tabId)window.proofAttached=request.tabId;return{attached:request.action!=="hide",tabId:window.proofAttached||"one"};}};const {createBrowserWorkspace}=await import("/next/workspaces/browser.mjs");window.browserProof={tabs:[{tabId:"one",title:"Disposable research",url:"https://fixture.invalid/one",browser:"relay",visible:false},{tabId:"two",title:"Protected draft",url:"https://fixture.invalid/two",browser:"relay",visible:false,inUse:true}],collections:[{id:"folder",name:"Research",parentId:null}],calls:[]};const state=window.browserProof;window.proofWorkspace=createBrowserWorkspace({mount:document.querySelector("#browser-proof"),events:{subscribe:()=>()=>{}},api:async(route,method,body)=>{state.calls.push({route,method,body});if(route.startsWith("/api/browser/status"))return structuredClone(state);if(route==="/api/browser/close-all"){state.tabs=state.tabs.filter(t=>t.inUse);return{closed:1,failedTabs:[]};}if(body.action==="tab_collect"){state.tabs.find(t=>t.tabId===body.tabId).collectionId=body.collectionId;return{};}return{ok:true};},notify(){},onNavigate(){}});window.proofWorkspace.enter();return true;})()');
await until('!!document.querySelector(".next-browser-tab-move")');
await run('document.querySelector(".next-browser-tab-move").click();true');
assert.equal(await run('document.querySelector(".next-browser-folder-editor").parentElement.tagName'),'DIALOG');
assert.equal(await run('document.querySelector(".next-browser-move-dialog").open'),true);
await run('document.querySelector(".next-browser-folder-editor select").value="folder";document.querySelector(".next-browser-folder-editor").requestSubmit();true');
await until('!document.querySelector(".next-browser-folder-editor")');
assert.equal(await run('window.browserProof.tabs[0].collectionId'),'folder');
await run('document.querySelector(".next-browser-tab-move").click();true');
for(const width of [1200,640,390]){win.setSize(width,900);await sleep(150);fs.writeFileSync(path.join(out,'browser-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
await run('document.querySelector(".next-browser-folder-editor select").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));window.confirm=()=>true;document.querySelector("#next-browser-tools-toggle").click();document.querySelector("#next-browser-close-all").click();true');
await until('window.browserProof.tabs.length===1');assert.equal(await run('window.browserProof.tabs[0].tabId'),'two');

const controls=await run('[...document.querySelectorAll(".next-browser-icon-button")].map(b=>({id:b.id,label:b.getAttribute("aria-label"),title:b.title,svg:b.querySelector("svg")?.namespaceURI,hidden:b.querySelector("svg")?.getAttribute("aria-hidden"),focusable:b.querySelector("svg")?.getAttribute("focusable")}))');
assert.ok(controls.length>=10);for(const control of controls){assert.ok(control.label);assert.ok(control.title);assert.equal(control.svg,'http://www.w3.org/2000/svg');assert.equal(control.hidden,'true');assert.equal(control.focusable,'false');}
await run('document.querySelector("#next-browser-tools-toggle").click();true');
for(const width of [1200,640,390]){win.setSize(width,900);await sleep(180);assert.equal(await run('document.documentElement.scrollWidth<=innerWidth+1'),true);fs.writeFileSync(path.join(out,'native-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
// A disclosure glyph must not inherit text-label ellipsis, even at large text sizes.
const folderChecks=[];
for(const size of [12,13,16,24,32]){
 await run('document.querySelectorAll(".next-browser-folder-toggle").forEach(b=>b.style.fontSize="'+size+'px");true');
 const metrics=await run('[...document.querySelectorAll(".next-browser-folder-toggle")].map(b=>({label:b.getAttribute("aria-label"),text:b.textContent,overflow:getComputedStyle(b).textOverflow,display:getComputedStyle(b).display}))');
 assert.ok(metrics.length>=2);for(const item of metrics){assert.equal(item.overflow,'clip');assert.equal(item.display,'flex'); /* Inline flex blockifies as a flex item. */assert.ok(item.label);assert.ok(['\u25be','\u25b8'].includes(item.text));}folderChecks.push({size,metrics});
}
await run('document.querySelectorAll(".next-browser-folder-toggle").forEach(b=>b.style.removeProperty("font-size"));document.querySelector(".next-browser-folder-toggle").click();true');
assert.equal(await run('document.querySelector(".next-browser-folder-toggle").getAttribute("aria-expanded")'),'false');
await run('document.querySelector(".next-browser-folder-toggle").click();true');assert.equal(await run('document.querySelector(".next-browser-folder-toggle").getAttribute("aria-expanded")'),'true');
await sleep(150);fs.writeFileSync(path.join(out,'folder-disclosure.png'),(await win.webContents.capturePage()).toPNG());
fs.writeFileSync(path.join(out,'folder-checks.json'),JSON.stringify(folderChecks,null,2));
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,controls,checks:['Real SVG namespace and hidden decorative semantics','All icon controls named with tooltips','Move modal and close unused retain behavior','Native responsive chrome at1200/640/390 without horizontal overflow']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0);});setTimeout(()=>app.exit(2),60000).unref();
