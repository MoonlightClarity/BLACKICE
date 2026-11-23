const {app,BrowserWindow}=require('electron'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),assert=require('node:assert/strict');
const root=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win,server;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=js=>win.webContents.executeJavaScript(js,true);
const until=async js=>{for(let i=0;i<150;i++){if(await run(js))return;await sleep(40);}throw Error('Renderer did not settle: '+js);};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){}async close(){}async runAgent(){throw Error('No model admission.');}}
(async()=>{
 await app.whenReady();
 const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));
 server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});const url=await server.listen();
 await (await fetch(url)).text();
 win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});
 await win.loadURL(url+'/next/#chat');
 await until('!!document.querySelector("#next-chat-folder-new")');
 await run(fs.readFileSync(path.join(root,'tests/fixtures/chat-folder-move-native-setup.js'),'utf8'));
 await run('window.chatProof.ui.onRowAction(window.chatProof.item,"move_folder");true');
 await until('document.querySelector("#next-chat-folder-move-dialog").open');
 assert.equal(await run('document.activeElement.id'),'next-chat-folder-move-search');
 assert.deepEqual(await run('[...document.querySelector("#next-chat-folder-move-target").options].map(n=>n.textContent)'),['Unfiled','Alpha','Alpha / Bravo','Zebra','Zebra / Delta']);
 await run('(()=>{const q=document.querySelector("#next-chat-folder-move-search");q.value="DELTA";q.dispatchEvent(new Event("input",{bubbles:true}));})()');
 assert.deepEqual(await run('[...document.querySelector("#next-chat-folder-move-target").options].map(n=>n.textContent)'),['Alpha (selected)','Zebra / Delta']);
 assert.equal(await run('window.chatProof.calls.length'),0);
 await run('document.querySelector("#next-chat-folder-move-target").value="deep";document.querySelector("#next-chat-folder-move-form").requestSubmit();true');
 await until('window.chatProof.item.folderId==="deep"');
 assert.equal(await run('window.chatProof.calls[0].body.expectedRevision'),4);
 assert.equal(await run('document.querySelector("#next-chat-folder-move-dialog").open'),false);
 await run('window.chatProof.ui.onRowAction(window.chatProof.item,"move_folder");true');
 await until('document.querySelector("#next-chat-folder-move-dialog").open');
 for(const width of [1200,640,390]){
  win.setSize(width,900);await sleep(200);
  const layout=await run('({overflow:document.documentElement.scrollWidth-innerWidth,dialog:document.querySelector("#next-chat-folder-move-dialog").getBoundingClientRect().width,viewport:innerWidth})');
  assert.ok(layout.overflow<=1,'Horizontal overflow at '+width+': '+JSON.stringify(layout));
  assert.ok(layout.dialog<=layout.viewport,'Dialog escapes viewport at '+width+': '+JSON.stringify(layout));
  fs.writeFileSync(path.join(out,'chat-move-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await run('document.querySelector("#next-chat-folder-move-cancel").click();true');
 assert.equal(await run('window.chatProof.calls.length'),1,'Cancellation is read-only');
 assert.equal(await run('document.querySelector("#next-chat-folder-move-dialog").open'),false);
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks:['Native Chat modal retains selection during case-insensitive folder path search','Explicit Move writes one organization change with pinned revision','Cancel never writes','Native layout at 1200/640/390 has no horizontal overflow']},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();if(server)await server.close();app.exit(process.exitCode||0);});setTimeout(()=>app.exit(2),60000).unref();
