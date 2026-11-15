const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');const label=process.argv[2]||'before';const out=path.join(__dirname,label);fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(__dirname,'profile-'+label));
app.on('window-all-closed',()=>{});let win;app.whenReady().then(async()=>{
try{
 const source=fs.readFileSync(path.join(root,'public/next/index.html'),'utf8');
 const css=[...source.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(x=>x[1].split('?')[0]);
 const html='<!doctype html><html><head><meta charset="utf-8">'+css.map(x=>`<link rel="stylesheet" href="../../public${x}">`).join('')+'</head><body><main id="mount"></main><script type="module" src="./fixture.mjs"></script></body></html>';
 fs.writeFileSync(path.join(__dirname,'fixture.html'),html);
 win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true}});
 win.webContents.on('console-message',(_e,l,m)=>fs.appendFileSync(path.join(out,'console.txt'),m+'\n'));
 await win.loadFile(path.join(__dirname,'fixture.html'));
 await win.webContents.executeJavaScript('window.ready');
 const results=[];
 for(const [width,height,zoom] of [[1100,900,1],[500,720,1],[360,640,1],[1100,900,1.5]]){
  if(results.length){win.destroy();win=new BrowserWindow({width,height,show:false,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true}});await win.loadFile(path.join(__dirname,'fixture.html'));await win.webContents.executeJavaScript('window.ready');}win.webContents.setZoomFactor(zoom);
  const metrics=await win.webContents.executeJavaScript(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(window.measure()))))`);
  results.push({width,height,zoom,...metrics});fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(results,null,2));
  const shot=await win.webContents.capturePage();fs.writeFileSync(path.join(out,`${width}-${height}-${zoom}.png`),shot.toPNG());
 }
 win.webContents.focus();await win.webContents.executeJavaScript('view.autonomyModels.querySelector("input").focus()');
 const initial=await win.webContents.executeJavaScript('document.activeElement.checked');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await new Promise(r=>setTimeout(r,100));
 const toggled=await win.webContents.executeJavaScript('document.activeElement.checked');
 assert.notEqual(initial,toggled,'Space toggles focused checkbox');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await new Promise(r=>setTimeout(r,100));
 assert(await win.webContents.executeJavaScript('document.activeElement===view.autonomyModels.querySelectorAll("input")[1]'),'Tab reaches next checkbox');
 const scroll=await win.webContents.executeJavaScript('view.autonomyModels.scrollTop=view.autonomyModels.scrollHeight;view.autonomyDialog.scrollTop=view.autonomyDialog.scrollHeight;view.autonomyModels.scrollTop>0 && view.autonomySave.getBoundingClientRect().bottom<=innerHeight');
 assert(scroll,'list and dialog scroll make save reachable');
 fs.writeFileSync(path.join(out,'scrolled-footer.png'),(await win.webContents.capturePage()).toPNG());
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(r=>setTimeout(r,100));
 assert(await win.webContents.executeJavaScript('!view.autonomyDialog.open'),'Escape closes dialog');
 await win.webContents.executeJavaScript('view.autonomySettings.click()');
 const behavior=await win.webContents.executeJavaScript('window.behavior()');
 Object.assign(behavior,{keyboardSpace:true,keyboardTab:true,keyboardEscape:true,scrollToSave:true});
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({source:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),electron:process.versions.electron,styles:css,results,behavior},null,2));
 for(const m of results){assert(m.boxWidth<=24,'checkbox inherits text input width');assert(m.nameWidth>=100,'readable label column');assert(m.rowOverflow<=1,'row overflow');assert(m.dialogOverflow<=1,'dialog overflow');assert(m.listScrollable,'large list scrolls');}
 assert(behavior.filter&&behavior.preserved&&behavior.closed&&behavior.reopened,'control behavior');console.log('rendered acceptance passed');app.exit(0);
}catch(e){console.error(e);app.exit(1);}
});
