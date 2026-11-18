const {app,BrowserWindow}=require('electron'),fs=require('fs/promises'),{mkdtempSync,mkdirSync,writeFileSync}=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{pathToFileURL}=require('url');
const moduleUrl=pathToFileURL(__filename);
const out=new URL('../../verification/browser-ui/',moduleUrl).pathname.replace(/^\/(?=[A-Za-z]:)/,'');mkdirSync(out,{recursive:true});
const profile=mkdtempSync(path.join(os.tmpdir(),'blackice-ui-'));
app.setPath('userData',profile);app.disableHardwareAcceleration();
const report={checks:[],sizes:[]};let win,fixture;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>{fs.mkdir(out,{recursive:true}).then(()=>fs.writeFile(path.join(out,'result.json'),JSON.stringify({...report,error:'watchdog'}))).finally(()=>app.exit(2));},45000);
(app.isReady()?Promise.resolve():app.whenReady()).then(async()=>{
 await fs.mkdir(out,{recursive:true});const {makeFixture}=await import('../next-fixture-server.mjs');fixture=makeFixture({nativeBrowser:true});
 fixture.state.tabs.push({...fixture.state.tabs[0],tabId:'fixture-other-task',title:'Other task tab',owner:{taskId:'other',nodeId:'worker'},ownershipKind:'ai',conversationId:'another',inUse:true});
 fixture.state.browserStatusGate=s=>{s.collections=[{id:'research',name:'Research'},{id:'companies',name:'Companies',parentId:'research'}];s.tabs[0].collectionId='companies';};
 await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
 const source=await fs.readFile(new URL('../next-browser-native-headless.mjs',moduleUrl),'utf8');
 const stub=source.replace(/\r/g,'').split('const stub=')[1].split(';\n\ntry{')[0].replace(/\r/g,'');
 // Extract only the existing IPC test stub, never execute its Chrome launcher.
 const text=stub.slice(stub.indexOf('`')+1,stub.lastIndexOf('`'));
 await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
 await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:text});
 await win.loadURL('http://127.0.0.1:'+fixture.server.address().port+'/next/#browser');
 const js=s=>win.webContents.executeJavaScript(s);
 const until=async(fn)=>{for(let i=0;i<150;i++){if(await fn())return;await sleep(30);}throw Error('condition timeout');};
 await until(()=>js("!!window.__nativeBrowser?.status().attached"));
 await until(()=>js("!!document.querySelector('[data-collection-id=companies]')"));
 assert.equal(await js("document.querySelector('[data-collection-id=companies]').parentElement.closest('[data-collection-id]').dataset.collectionId"),'research');
 assert.equal(await js("document.querySelectorAll('[data-tab-id]').length"),2);assert.equal(await js("!!document.querySelector('#next-browser-personal')"),false);assert.equal(await js("[...document.querySelectorAll('.next-browser-tab-owner')].some(n=>!n.hidden&&n.textContent==='In use')"),true);const beforeClose=fixture.state.browserActions.filter(a=>a.action==='close').length;await js("window.confirm=()=>false;document.querySelector('[data-close-tab=fixture-other-task]').click()");await sleep(50);assert.equal(fixture.state.browserActions.filter(a=>a.action==='close').length,beforeClose);report.checks.push('Marked tab close cancellation sends no close action');report.checks.push('All task and personal tabs share folder outline; in-use badge replaces conversation grouping');report.checks.push('Nested folders and native-surface attachment preserved');await js("document.querySelector('[data-folder-control=\"edit:research\"]').click()");assert.equal(await js("document.querySelector('.next-browser-folder-rename').value"),'Research');await js("document.querySelector('.next-browser-folder-rename').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");report.checks.push('Folder text starts rename without expanding or changing tabs');
 const click=s=>js('document.querySelector('+JSON.stringify(s)+').click()');
 assert.equal(await js("document.querySelector('#next-browser-tools').hidden"),true);
 await click('#next-browser-tools-toggle');
 assert.equal(await js("document.querySelector('#next-browser-tools-toggle').getAttribute('aria-expanded')"),'true');
 await js("document.querySelector('#next-browser-downloads-toggle').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 assert.equal(await js("document.activeElement.id"),'next-browser-tools-toggle');
 assert.equal(await js("document.querySelector('#next-browser-tools').hidden"),true);
 report.checks.push('Tools disclosure and Escape focus restoration');
 await click('#next-browser-tools-toggle');await click('#next-browser-downloads-toggle');
 assert.equal(await js("document.querySelector('#next-browser-downloads').hidden"),false);
 await click('#next-browser-downloads-toggle');await click('#next-browser-tools-toggle');
 await click('.next-browser-folder-add');
 await js("document.querySelector('[aria-label=\"Folder name\"]').value='Unsaved folder'");
 for(const width of [1200,780,640]){
   win.setSize(width,width===780?560:800);await sleep(180);
   const size=await js("(()=>{const p=document.querySelector('#next-browser-native-page').getBoundingClientRect(),s=document.querySelector('.next-native-browser-sidebar').getBoundingClientRect();return {width:innerWidth,page:{x:p.x,y:p.y,width:p.width,height:p.height},rail:{x:s.x,y:s.y,width:s.width,height:s.height},overflow:document.documentElement.scrollWidth>innerWidth}})()");
   assert.equal(size.overflow,false);assert.ok(size.page.width>300);assert.ok(size.page.height>240);
   assert.equal(await js("document.querySelector('[aria-label=\"Folder name\"]').value"),'Unsaved folder');
   const bounds=await js('window.__nativeBrowser.status().bounds');assert.ok(bounds);assert.equal(bounds.x,Math.ceil(size.page.x));assert.equal(bounds.y,Math.ceil(size.page.y));assert.equal(bounds.width,Math.floor(size.page.width));assert.equal(bounds.height,Math.floor(size.page.height));report.sizes.push({...size,bounds});await fs.writeFile(path.join(out,'browser-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 report.checks.push('Folder draft retained; responsive page area and no horizontal overflow at 1200,780,640');
 await click('#next-browser-passwords');
 await until(()=>js("location.hash.includes('settings')"));
 report.checks.push('Passwords still opens settings');await click('.next-tab[data-space=browser]');await until(()=>js("!document.querySelector('.next-native-browser').closest('[hidden]')"));assert.equal(await js("document.querySelector('.next-browser-folder-editor').hidden"),true);assert.equal(await js("document.querySelector('[aria-label=\"Folder name\"]').value"),'Unsaved folder');assert.equal(await js("document.querySelector('#next-browser-tools').hidden"),true);report.checks.push('Leaving Browser hides transient tools/editor while preserving folder draft');
 report.ok=true;
}).catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));
 win?.destroy();await fixture?.close();fixture?.server.close();clearTimeout(watchdog);app.exit(report.ok?0:1);
});

