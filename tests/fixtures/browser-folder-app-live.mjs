import {app,BrowserWindow,session} from 'electron';
import {promises as fs} from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {ElectronBrowserDriver} from '../../desktop/browser-driver.mjs';import {BrowserWorkspace} from '../../lib/browser.mjs';
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);if(!out)throw Error('Disposable output required');await fs.mkdir(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
const root=fileURLToPath(new URL('../../',import.meta.url));let shell,driver,browser,server;let foreground=false;const calls=[];const report={appOwnedFolders:true,liveUserData:false,checks:[]};
const timer=setTimeout(()=>{fs.writeFile(path.join(out,'result.json'),JSON.stringify({...report,error:'timeout'})).finally(()=>app.exit(1));},45000);
app.whenReady().then(async()=>{
 try{
  app.on('browser-window-created',(_e,w)=>{w.on('show',()=>foreground=true);w.on('focus',()=>foreground=true);});
  report.electron=process.versions.electron;
  await fs.mkdir(path.join(out,'data'),{recursive:true});driver=await new ElectronBrowserDriver({dataDir:path.join(out,'data'),downloadDir:path.join(out,'downloads')}).init();browser=new BrowserWorkspace({driver});
  server=http.createServer(async(req,res)=>{try{
   if(req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(driver.status()));return;}
   if(req.url==='/action'){let body='';for await(const c of req)body+=c;const args=JSON.parse(body);calls.push(args);await browser.perform(args,{source:'user'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(driver.status()));return;}
   if(req.url==='/core/folder-tree.mjs'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,'public/next/core/folder-tree.mjs')));return;}
   if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(await fs.readFile(path.join(root,'public/next/browser.css')));return;}
   if(req.url==='/bridge.mjs'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,'public/next/workspaces/browser-folders.mjs')));return;}
   if(req.url==='/shell'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/browser.css"><style>body{background:#10141b;color:#eee;font:14px sans-serif}button,input,select{background:#252d39;color:#eee;border:1px solid #687484;padding:8px}.next-browser-tab-group{display:flex}.selected{outline:2px solid #8ad}</style><div class="next-browser-navigation"><div class="next-browser-tabs" id="tabs"></div></div><p id="notice"></p><script type="module">'+
   "import{createBrowserFolders}from'/bridge.mjs';let state={tabs:[]},selected=null;const strip=document.querySelector('#tabs');const api=async(_p,_m,args)=>{const r=await fetch('/action',{method:'POST',body:JSON.stringify(args)});if(!r.ok)throw Error(await r.text());return r.json();};const folders=createBrowserFolders({mount:document,getTabs:()=>state.tabs,getSelected:()=>selected,isBusy:()=>false,api,refresh,notice:m=>document.querySelector('#notice').textContent=m});async function refresh(){state=await(await fetch('/status')).json();selected=state.tabs.some(t=>t.tabId===selected)?selected:state.tabs[0]?.tabId;strip.replaceChildren();for(const t of state.tabs){const row=document.createElement('div');row.className='next-browser-tab-group';const b=document.createElement('button');b.dataset.tabId=t.tabId;b.textContent=t.title||t.url;b.onclick=()=>{selected=t.tabId;api('', '',{action:'tab_select',browser:'relay',tabId:t.tabId}).then(refresh)};const close=document.createElement('button');close.textContent='Close';close.dataset.closeTab=t.tabId;close.onclick=()=>api('','',{action:'close',browser:'relay',tabId:t.tabId}).then(refresh);row.append(b,close);strip.append(row);}folders.update(state);folders.groupTabs(strip);}window.fixture={refresh,get state(){return state}};await refresh();"+
   '</script>');return;}
   res.end('<!doctype html><title>Disposable '+req.url+'</title><h1>Native tab '+req.url+'</h1>');
  }catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const first=await browser.perform({action:'open',url:origin+'/one'},{source:'user'}),second=await browser.perform({action:'open',url:origin+'/two'},{source:'user'});const original=driver.status().tabs.map(({tabId,owner,folderId})=>({tabId,owner,folderId}));
  shell=new BrowserWindow({show:false,width:1200,height:600,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
  await shell.loadURL(origin+'/shell');
  const js=s=>shell.webContents.executeJavaScript(s);
  const until=async(test)=>{for(let i=0;i<150;i++){if(await test())return;await new Promise(r=>setTimeout(r,20));}throw Error('condition timed out');};
  await until(()=>js("!!document.querySelector('.next-browser-folder-add')"));
  const idle=()=>until(()=>js("document.querySelector('#tabs').dataset.folderBusy==='false'"));
  report.checks.push('App-owned folder controller loaded without extension; remote native-tab session unchanged');
  await idle();await js("document.querySelector('.next-browser-folder-add').click();document.querySelector('[aria-label=\"Folder name\"]').value='Research';document.querySelector('.next-browser-folder-editor').requestSubmit()");
  await until(()=>driver.status().collections?.some(f=>f.name==='Research'));await until(()=>js("!![...document.querySelectorAll('.next-browser-folder-name')].find(n=>n.textContent.includes('Research'))"));
  const parent=driver.status().collections.find(f=>f.name==='Research').id;
  await idle();await js("document.querySelector('.next-browser-folder-add').click();document.querySelector('[aria-label=\"Folder name\"]').value='Companies';document.querySelector('[aria-label=\"Parent folder\"]').value="+JSON.stringify(parent)+";document.querySelector('.next-browser-folder-editor').requestSubmit()");
  await until(()=>driver.status().collections?.some(f=>f.name==='Companies'));const child=driver.status().collections.find(f=>f.name==='Companies').id;await until(()=>js("document.querySelector('#tabs').dataset.folderBusy==='false'"));
  await until(()=>js("document.querySelectorAll('[data-tab-id]').length===2"));
  await idle();await js("document.querySelector('[data-tab-id="+JSON.stringify(first.tabId)+"]').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));document.querySelector('[aria-label=\"Folder\"]').value="+JSON.stringify(child)+";document.querySelector('.next-browser-folder-editor').requestSubmit()");
  await until(()=>driver.status().tabs.find(t=>t.tabId===first.tabId)?.collectionId===child);
  await until(()=>js("!!document.querySelector('[data-collection-id="+JSON.stringify(child)+"] [data-tab-id="+JSON.stringify(first.tabId)+"]')"));
  report.checks.push('App creates nested folders and moves real native tab through existing host collection action');
  assert.equal(await js(`document.querySelector('[data-collection-id="${child}"]').parentElement.closest('[data-collection-id]').dataset.collectionId`),parent);
  assert.equal(await js(`document.querySelector('[data-collection-id="${child}"] > .next-browser-folder-heading > .next-browser-folder-name').textContent`),'Companies');
  assert.equal(await js(`document.querySelector('[data-collection-id="${parent}"] > .next-browser-folder-heading > .next-browser-folder-name').textContent`),'Research');
  assert.equal(await js("document.querySelectorAll('.next-browser-folder-group').length"),3);
  await js(`document.querySelector('[data-collection-id="${parent}"] > .next-browser-folder-heading > .next-browser-folder-toggle').click()`);
  assert.equal(await js(`document.querySelector('[data-collection-id="${child}"]').closest('[hidden]')!==null`),true);
  await js('window.fixture.refresh()');await idle();
  await until(()=>js(`document.querySelector('[data-collection-id="${child}"]').closest('[hidden]')!==null`));
  await js(`document.querySelector('[data-collection-id="${parent}"] > .next-browser-folder-heading > .next-browser-folder-toggle').click()`);
  await until(()=>js(`document.querySelector('[data-collection-id="${child}"]').getBoundingClientRect().width>0`));
  await new Promise(r=>setTimeout(r,150));
  report.checks.push('App stylesheet loaded for nested folder tree');await fs.writeFile(path.join(out,'nested-tabstrip.png'),(await shell.webContents.capturePage()).toPNG());
  shell.setSize(780,560);await new Promise(r=>setTimeout(r,100));
  report.geometry=await js("({viewport:innerWidth,width:document.querySelector('#tabs').clientWidth,scroll:document.querySelector('#tabs').scrollWidth,overflow:[...document.querySelectorAll('#tabs *')].map(n=>({name:n.className,right:n.getBoundingClientRect().right})).filter(n=>n.right>innerWidth)})");await fs.writeFile(path.join(out,'width-debug.png'),(await shell.webContents.capturePage()).toPNG());
  assert.equal(report.geometry.scroll<=report.geometry.width+1,true);
  assert.equal(await js("[...document.querySelectorAll('.next-browser-folder-menu,.next-browser-folder-add')].every(n=>n.getBoundingClientRect().right<=innerWidth)"),true);
  await fs.writeFile(path.join(out,'nested-780.png'),(await shell.webContents.capturePage()).toPNG());
  report.checks.push('At 780px width folder controls remain visible with no horizontal tree overflow');
  report.checks.push('Child folders are nested inside parent tabstrip with descendant counts, and parent collapse across refresh');

  await idle();await js("(()=>{const row=document.querySelector('[data-tab-id="+JSON.stringify(first.tabId)+"]').parentElement;const transfer=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));document.querySelector('[data-collection-id=\"\"]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));})()");
  await until(()=>driver.status().tabs.find(t=>t.tabId===first.tabId).collectionId===null);
  await idle();await js("(()=>{const row=document.querySelector('[data-tab-id="+JSON.stringify(first.tabId)+"]').parentElement;const transfer=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));document.querySelector('[data-collection-id="+JSON.stringify(child)+"]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));})()");
  await until(()=>driver.status().tabs.find(t=>t.tabId===first.tabId).collectionId===child);
  report.checks.push('Real app dragstart/drop handlers move native tab out of and back into folder');

  await idle();await js("(()=>{const transfer=new DataTransfer();document.querySelector('[data-collection-id="+JSON.stringify(child)+"] > .next-browser-folder-heading').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));document.querySelector('.next-browser-folder-toolbar').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));})()");
  await until(()=>driver.status().collections.find(f=>f.id===child).parentId===null);
  await idle();await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] > .next-browser-folder-heading').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))");
  await until(()=>driver.status().collections.find(f=>f.id===child).parentId===parent);
  await idle();await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] > .next-browser-folder-heading').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,shiftKey:true,bubbles:true}))");
  await until(()=>driver.status().collections.find(f=>f.id===child).parentId===null);
  await idle();await js("(()=>{const transfer=new DataTransfer();document.querySelector('[data-collection-id="+JSON.stringify(child)+"] > .next-browser-folder-heading').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));document.querySelector('[data-collection-id="+JSON.stringify(parent)+"] > .next-browser-folder-heading').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));})()");
  await until(()=>driver.status().collections.find(f=>f.id===child).parentId===parent);
  report.checks.push('Actual folder subtree drag and Ctrl Enter indent/Ctrl Shift Enter outdent persist via host');
  assert.deepEqual(driver.status().tabs.map(({tabId,owner,folderId})=>({tabId,owner,folderId})),original);
  assert.equal(await js("document.querySelectorAll('[data-tab-id]').length"),2);
  assert.equal(await js("document.querySelectorAll('.next-browser-folders').length"),0);
  await idle();await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] .next-browser-folder-toggle').click()");
  assert.equal(await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] .next-browser-folder-children').hidden"),true);
  await idle();await js("window.fixture.refresh()");await until(()=>js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] .next-browser-folder-children')?.hidden===true"));
  report.checks.push('One intrinsic tabstrip, no duplicate folder panel; local collapse survives host refresh; ownership unchanged');
  await idle();await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] .next-browser-folder-toggle').parentElement.querySelector('.next-browser-folder-menu').click();document.querySelector('.next-browser-folder-rename').value='Targets';document.querySelector('.next-browser-folder-rename').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until(()=>driver.status().collections.some(f=>f.id===child&&f.name==='Targets'));
  await idle();await js("document.querySelector('[data-collection-id="+JSON.stringify(child)+"] .next-browser-folder-toggle').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));[...document.querySelectorAll('.next-browser-folder-editor button')].find(n=>n.textContent==='Remove folder, keep tabs').click()");
  await until(()=>!driver.status().collections.some(f=>f.id===child));assert.equal(driver.status().tabs.find(t=>t.tabId===first.tabId).collectionId,parent);
  await until(()=>js("!!document.querySelector('[data-tab-id="+JSON.stringify(first.tabId)+"]')"));
  await idle();await js("document.querySelector('[data-tab-id="+JSON.stringify(first.tabId)+"]').click()");
  await until(()=>driver.status().activeTab===first.tabId);
  await idle();await js("document.querySelector('[data-close-tab="+JSON.stringify(second.tabId)+"]').click()");
  await until(()=>driver.status().tabs.length===1);assert.equal(driver.status().tabs[0].tabId,first.tabId);
  report.checks.push('Rename/remove keeps real tabs; app preserves native select/close handlers');
  await idle();await js('window.fixture.refresh()');await new Promise(r=>setTimeout(r,100));await fs.writeFile(path.join(out,'tabstrip.png'),(await shell.webContents.capturePage({x:0,y:0,width:1000,height:150})).toPNG());
  await driver.flushPersistence();await browser.close();browser=null;
  driver=await new ElectronBrowserDriver({dataDir:path.join(out,'data'),downloadDir:path.join(out,'downloads')}).init();
  assert.equal(driver.status().tabs[0].collectionId,parent);assert.ok(driver.status().collections.some(f=>f.id===parent));report.checks.push('Existing host persistence restores membership and same tab ID after driver restart');
  assert.equal(foreground,false);report.hidden=true;report.ok=true;report.actions=calls;await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));
 }catch(error){report.actions=calls;report.dom=shell&&!shell.isDestroyed()?await shell.webContents.executeJavaScript('document.body.innerHTML'):null;report.ok=false;report.error=error.stack;await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));}
 finally{clearTimeout(timer);setTimeout(()=>app.exit(report.ok?0:1),2000);shell?.destroy();await browser?.close();await driver?.close();server?.close();app.exit(report.ok?0:1);}
});