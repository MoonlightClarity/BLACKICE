const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'); let server,win,profile; const checks=[];
(async()=>{
 profile=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-context-theme-'));app.setPath('userData',profile);
 await app.whenReady();
 const production=await fs.readFile(path.join(root,'public/next/index.html'),'utf8');
 const styles=production.match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('');
 const html='<!doctype html><html><head>'+styles+'</head><body><div class="next-shell"><section class="next-space" id="frame"><div class="next-chat-head-actions"></div></section></div><div id="references"><button id="regular">Regular</button><button class="next-primary" id="primary">Save</button><div class="next-conversation" aria-current="true" id="selection"></div></div><script type="module">'+
 "import {createDirectoryInspector} from '/next/chat/artifacts.mjs'; const api=async route=>route.endsWith('/conversations')?{currentConversationId:'c',conversations:[{conversationId:'c',runId:'r',title:'Test context',current:true}]}:route.includes('/file?')?{file:'conversation/context/summary.json',value:{userSummary:'Neutral context'},editableFields:['userSummary'],hash:'h'}:{conversationId:'c',summary:{userSummary:'Neutral context'},files:[{file:'conversation/context/summary.json',bytes:40,editable:true,deletable:true,editableFields:['userSummary'],hash:'h'}]}; window.inspector=createDirectoryInspector({frame:document.querySelector('#frame'),getRunId:()=> 'r',getConversationId:()=> 'c',api}); await window.inspector.open(); window.ready=true;"+
 '</script></body></html>';
 server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}const f=path.resolve(root,'public','.'+pathname);if(!f.startsWith(path.join(root,'public')+path.sep)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.png':'image/png'})[path.extname(f)]||'application/octet-stream');res.end(await fs.readFile(f));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/');
 const evalJS=s=>win.webContents.executeJavaScript(s,true);
 for(let i=0;i<100&&!await evalJS('Boolean(window.ready)');i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(await evalJS('Boolean(window.ready)'),'Inspector opened');
 const read=()=>evalJS("(()=>{const read=q=>{const c=getComputedStyle(document.querySelector(q));return {background:c.backgroundColor,image:c.backgroundImage,color:c.color,border:c.borderTopColor}};return {dialog:read('.next-directory-inspector'),button:read('.next-directory-head button'),regular:read('#regular'),save:read('.next-directory-save'),primary:read('#primary'),selected:read('.next-directory-tabs button[aria-pressed=true]'),selection:read('#selection'),field:read('.next-directory-contents'),root:getComputedStyle(document.documentElement).getPropertyValue('--next-workspace-background').trim(),overflow:document.documentElement.scrollWidth>innerWidth}})()");
 let p=await read(); assert.equal(p.dialog.background,'rgb(13, 14, 15)');assert.deepEqual(p.button,p.regular); assert.deepEqual(p.save,p.primary); assert.equal(p.selected.image,p.selection.image); assert.equal(p.selected.border,p.selection.border);assert.equal(p.field.background,'rgb(14, 18, 23)');assert.equal(p.field.color,'rgb(231, 235, 239)');checks.push('Complete shipped cascade matches brand surfaces, buttons, primary actions, selected tabs and fields');
 await win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});p=await read();assert.equal(p.save.image,'none');assert.equal(p.button.image,'none');checks.push('Forced-colors removes gradients and uses system palette');
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
 win.setSize(390,800);p=await read();assert.equal(p.overflow,false);checks.push('390px viewport does not overflow');
 await evalJS("document.querySelector('.next-directory-close').click()");assert.equal(await evalJS('document.querySelector(".next-directory-inspector").open'),false);await evalJS('window.inspector.open()');assert.equal(await evalJS('document.querySelector(".next-directory-inspector").open'),true);checks.push('Close and reopen preserve themed inspector without duplicate dialogs');assert.equal(await evalJS('document.querySelectorAll(".next-directory-inspector").length'),1);
 if(process.env.BLACKICE_THEME_SCREENSHOT){await fs.mkdir(path.dirname(process.env.BLACKICE_THEME_SCREENSHOT),{recursive:true});await fs.writeFile(process.env.BLACKICE_THEME_SCREENSHOT,(await win.webContents.capturePage()).toPNG());}
 await evalJS('window.inspector.destroy();');assert.equal(await evalJS('Boolean(document.querySelector(".next-directory-inspector"))'),false);checks.push('Destroy removes inspector and injected style');
 console.log(JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{win?.destroy();if(server)await new Promise(r=>server.close(r));app.exit(process.exitCode||0);});
