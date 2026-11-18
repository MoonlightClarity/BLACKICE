const {app,BrowserWindow}=require('electron'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),assert=require('assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();let win,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const run=async s=>{try{return await win.webContents.executeJavaScript(s,true);}catch(e){throw Error(s+'\\n'+e.message);}};const until=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await sleep(80);}throw Error(s);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{id:'gpt-6-luna',available:true}],defaultModel:'gpt-6-luna'};}async start(){}async close(){}async runAgent(){throw Error('No model');}}
(async()=>{await app.whenReady();const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});const url=await server.listen();const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
const request=async(body)=>{const r=await fetch(url+(body?'/api/operations/folders':'/api/operations'),{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(await r.text());const value=await r.json();return body?value:value.organization;};
let org=await request();org=await request({action:'create',name:'Parent',expectedRevision:org.revision});const parent=org.folders.find(f=>f.name==='Parent').id;org=await request({action:'create',name:'Child',parentId:parent,expectedRevision:org.revision});
win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadURL(url+'/next/#cronjobs');await until('!!document.querySelector(".next-schedule-new-folder")');

await run('document.querySelector(".next-tab[data-space=chat]").click();true');
await until('!!document.querySelector("#next-chat-folder-new")');
await run('document.querySelector("#next-chat-folder-new").click();document.querySelector("#next-chat-folder-name").value="test";document.querySelector("#next-chat-folder-form").requestSubmit();true');
await until('!!document.querySelector(".next-chat-folder-name")');
await until('!!document.querySelector(".next-chat-folder-name")');


assert.equal(await run('!!document.querySelector("#next-chat-folder-settings")'),false);
assert.equal(await run('!!document.querySelector("#next-chat-folder-filter")'),false);
assert.equal(await run('!!document.querySelector("#next-chat-folder-parent")'),false);
assert.equal(await run('document.querySelector(".next-chat-folder-create svg").namespaceURI'),'http://www.w3.org/2000/svg');
await run('document.querySelector(".next-chat-folder-name").click();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector(".next-chat-folder-create").click();document.querySelector("#next-chat-folder-name").value="Child";document.querySelector("#next-chat-folder-form").requestSubmit();true');
await until('!document.querySelector("#next-chat-folder-form") || document.querySelector("#next-chat-folder-form").hidden');
let tree=await run('(async()=>await(await fetch("/api/conversation-folders?state=active")).json())()');
let rootFolder=tree.folderOrganization.folders.find(f=>f.name==='test'),child=tree.folderOrganization.folders.find(f=>f.name==='Child');assert.equal(child.parentId,rootFolder.id);
await until(`document.querySelector('[data-chat-folder="${rootFolder.id}"]').contains(document.querySelector('[data-chat-folder="${child.id}"]'))`);
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
await run(`document.querySelector('[data-chat-folder="${child.id}"] > summary .next-chat-folder-name').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,shiftKey:true,bubbles:true}));true`);
await until(`!document.querySelector('[data-chat-folder="${rootFolder.id}"]').contains(document.querySelector('[data-chat-folder="${child.id}"]'))`);
await until('!document.querySelector("#next-chat-folder-form") || document.querySelector("#next-chat-folder-form").hidden');
await run(`(()=>{const source=document.querySelector('[data-chat-folder="${child.id}"] > summary'),target=document.querySelector('[data-chat-folder="${rootFolder.id}"] > summary'),data=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));return true;})()`);
await until(`document.querySelector('[data-chat-folder="${rootFolder.id}"]').contains(document.querySelector('[data-chat-folder="${child.id}"]'))`);
await win.reload();await until('!!document.querySelector(".next-chat-folder-new-chat")');
for(const width of [1200,640]){win.setContentSize(width,500);await sleep(150);fs.writeFileSync(path.join(out,'chat-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}


win.setContentSize(1200,500);await sleep(180);
await run('document.querySelector(".next-chat-folder-name").click();true');
assert.equal(await run('getComputedStyle(document.querySelector(".next-chat-folder-name")).display'),'none');
assert.equal(await run('document.activeElement.className'),'next-chat-folder-rename');
await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
assert.equal(await run('!!document.querySelector(".next-chat-folder-rename")'),false);

await run('document.querySelector("#next-chat-new").click();true');
for(const width of [1200,640,390]){
 win.setContentSize(width,500);await sleep(180);
 const state=await run('({width:innerWidth,scroll:document.documentElement.scrollWidth,views:document.querySelector(".next-sidebar-views").children.length})');
 assert.ok(state.scroll<=state.width);assert.equal(state.views,2);
 fs.writeFileSync(path.join(out,'refresh-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 if(width<=640)await run('document.querySelector("#next-chat-mobile-list").click();true');
 if(width<=640){
  await until('document.querySelector("#next-chat").dataset.showList==="true" && getComputedStyle(document.querySelector(".next-chat-sidebar")).display!=="none" && getComputedStyle(document.querySelector(".next-chat-main")).visibility==="hidden"');
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await sleep(200);
  const shown=await run('(()=>{const side=document.querySelector(".next-chat-sidebar"),r=side.getBoundingClientRect(),hit=document.elementFromPoint(r.left+20,r.top+20);return {display:getComputedStyle(side).display,left:r.left,right:r.right,width:r.width,hit:side.contains(hit),main:getComputedStyle(document.querySelector(".next-chat-main")).visibility};})()');
  assert.equal(shown.hit,true);assert.equal(shown.main,'hidden');assert.ok(shown.left>=0&&shown.right<=width&&shown.width>width-4);
  fs.writeFileSync(path.join(out,'sidebar-visible-'+width+'.json'),JSON.stringify(shown,null,2));
 }
 const bounds=await run('(()=>{const row=document.querySelector(".next-chat-folder-heading"),button=row.querySelector(".next-chat-folder-new-chat");return {row:row.getBoundingClientRect().height,button:button.getBoundingClientRect().height,wrap:getComputedStyle(button).whiteSpace}})()');
 assert.ok(bounds.row<=45,JSON.stringify(bounds));assert.ok(bounds.button<=30);assert.equal(bounds.wrap,'nowrap');
 fs.writeFileSync(path.join(out,'folders-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 if(width<=640)await run('document.querySelector("#next-chat-mobile-close").click();true');
}

await run('document.querySelector("#next-chat-bucket").value="active";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-archive")');
await run('document.querySelector(".next-chat-folder-archive").click();true');
assert.match(await run('document.querySelector("#next-chat-folder-delete-label").textContent'),/every nested folder and chat/);
await run('document.querySelector("#next-chat-folder-delete-cancel").click();true');
assert.equal(await run('document.querySelector("#next-chat-folder-delete-dialog").open'),false);
await run('document.querySelector(".next-chat-folder-archive").click();document.querySelector("#next-chat-folder-delete-confirm").click();true');
await until('!document.querySelector("#next-chat-folder-delete-dialog").open');
await run('document.querySelector("#next-chat-bucket").value="archived";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-restore")');
let archived=await run('(async()=>await(await fetch("/api/conversations?state=archived")).json())()');assert.equal(archived.conversations.length,1);
await run('document.querySelector(".next-chat-folder-restore").click();document.querySelector("#next-chat-folder-delete-confirm").click();true');
await until('!document.querySelector("#next-chat-folder-delete-dialog").open');
await run('document.querySelector("#next-chat-bucket").value="active";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-remove")');
await run('document.querySelector(".next-chat-folder-remove").click();document.querySelector("#next-chat-folder-delete-confirm").click();true');
await until('!document.querySelector("#next-chat-folder-delete-dialog").open');
await run('document.querySelector("#next-chat-bucket").value="deleted";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-restore")');
await win.reload();await until('!!document.querySelector("#next-chat-bucket")');await run('document.querySelector("#next-chat-bucket").value="deleted";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');await until('!!document.querySelector(".next-chat-folder-restore")');
let deleted=await run('(async()=>await(await fetch("/api/conversations?state=deleted")).json())()');assert.equal(deleted.conversations.length,1);
await run('document.querySelector(".next-chat-folder-restore").click();document.querySelector("#next-chat-folder-delete-confirm").click();true');
await until('!document.querySelector("#next-chat-folder-delete-dialog").open');
await run('document.querySelector("#next-chat-bucket").value="active";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('!!document.querySelector(".next-chat-folder-new-chat")');
saved=await run('(async()=>await(await fetch("/api/conversations?state=active")).json())()');assert.equal(saved.conversations.length,2);

await run('document.querySelector("#next-chat-folder-new").click();document.querySelector("#next-chat-folder-name").value="Empty";document.querySelector("#next-chat-folder-form").requestSubmit();true');
await until('[...document.querySelectorAll(".next-chat-folder-name")].some(n=>n.textContent==="Empty")');
await run('const row=[...document.querySelectorAll(".next-chat-folder-name")].find(n=>n.textContent==="Empty").closest("details");row.querySelector(".next-chat-folder-remove").click();document.querySelector("#next-chat-folder-delete-confirm").click();true');
await until('!document.querySelector("#next-chat-folder-delete-dialog").open');
assert.equal(await run('[...document.querySelectorAll(".next-chat-folder-name")].some(n=>n.textContent==="Empty")'),false);

await run('document.querySelector(".next-chat-folder-create").click();document.querySelector("#next-chat-folder-name").value="Keep this draft";document.querySelector("#next-chat-bucket").value="archived";document.querySelector("#next-chat-bucket").dispatchEvent(new Event("change"));true');
await until('document.querySelector("#next-chat-list").contains(document.querySelector("#next-chat-folder-form"))');
assert.equal(await run('document.querySelector("#next-chat-folder-name").value'),'Keep this draft');
assert.match(await run('document.querySelector("#next-chat-folder-draft-context").textContent'),/original destination unavailable/);
await run('document.querySelector("#next-chat-folder-cancel").click();true');
assert.equal(await run('!!document.querySelector("#next-chat-list #next-chat-folder-form")'),false);
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks:['Manual nested creation, keyboard move, drag nesting and reload through actual UI','Recursive Archive/Trash/Restore and empty-folder Trash through actual HTTP UI; unrelated chat retained','No automatic folder controls','Actual HTTP folder and global new placement','Close keeps draft and history','1200/640/390 no horizontal overflow','Folder action stays on one compact row','View and multiselect share one row','Mobile folder show/dismiss retained']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);globalThis.failed=true;}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(globalThis.failed?1:0);});setTimeout(()=>app.exit(2),60000).unref();
