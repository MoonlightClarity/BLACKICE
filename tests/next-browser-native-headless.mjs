/** Native Browser chrome acceptance with a disposable Chrome profile and IPC stub.
 * Actual Electron page input and view ownership are covered by native backend tests. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';

const chrome=process.env.BLACKICE_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixture=makeFixture({nativeBrowser:true}),directory=await mkdtemp(join(tmpdir(),'blackice-next-native-browser-'));
fixture.state.downloads=[{id:'download-fixture',browser:'relay',name:'Native fixture report.txt',status:'completed',path:'C:\\fixture\\report.txt'}];
const errors=[],counts={};
let browserProcess,socket,nextId=1;
const pending=new Map();
const heldResponses=new Set();
function responseGate(){
  let resolve;const promise=new Promise(done=>{resolve=done;});heldResponses.add(resolve);
  return {promise,release(){heldResponses.delete(resolve);resolve();}};
}
const until=async(fn,label,limitMs=15000)=>{
  const deadline=Date.now()+limitMs;let last;
  while(Date.now()<deadline){try{const value=await fn();if(value)return value;}catch(error){last=error;}await sleep(80);}
  throw Error(label+' timed out. '+(last?.message||''));
};
function connect(url){
  return new Promise((resolve,reject)=>{
    socket=new WebSocket(url);
    const timer=setTimeout(()=>reject(Error('DevTools connection timed out.')),6000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('DevTools connection failed.'));},{once:true});
    socket.addEventListener('message',event=>{
      const packet=JSON.parse(event.data),job=pending.get(packet.id);
      if(job){pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}
      if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.exception?.description||packet.params.exceptionDetails?.text||'Renderer exception');
      if(packet.method==='Runtime.consoleAPICalled'&&packet.params.type==='error')
        errors.push(packet.params.args?.map(arg=>arg.value||arg.description).join(' '));
    });
  });
}
function send(method,params={}){
  const id=nextId++;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools command timed out: '+method));},10000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression){
  const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Page evaluation failed.');
  return result.result?.value;
}
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
const countAction=action=>fixture.state.browserActions.filter(item=>item.action===action).length;
const waitAction=(action,count)=>until(()=>countAction(action)>count,'Browser '+action+' action');
const browserTab='.next-tab[data-space="browser"]';
const chatTab='.next-tab[data-space="chat"]';
async function statusUpdate(label){
  const before=await evaluate('window.__nativeBrowser.statusResponses');
  fixture.send({type:'browser.status',data:{tabs:fixture.state.tabs,activeTab:fixture.state.activeBrowserTab}});
  await until(()=>evaluate('window.__nativeBrowser.statusResponses>'+before),label);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
const stub=`(()=>{
  const calls=[],shortcuts=new Set(),waiting=[];
  let generation=0,attached=null,bounds=null,hold=false,failAttach=false,holdAuth=false,failAuth=false;
  const authWaiting=[];
  const status=()=>({attached:!!attached,tabId:attached,bounds});
  const controls={calls,status,statusResponses:0,holdAttach(value){hold=!!value;},failAttachments(value){failAttach=!!value;},release(){while(waiting.length)waiting.shift()();},
    holdAuthentication(value){holdAuth=!!value;},failAuthentication(value){failAuth=!!value;},
    releaseAuthentication(){while(authWaiting.length)authWaiting.shift()();},
    shortcut(action){for(const callback of shortcuts)callback(action);},pending:()=>waiting.length};
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    const response=await originalFetch(...args);
    if(String(args[0]).includes('/api/browser/status')){await response.clone().json();controls.statusResponses++;}
    return response;
  };
  Object.defineProperty(window,'__nativeBrowser',{value:controls});
  Object.defineProperty(window,'relayDesktop',{value:{platform:'win32',version:'native-ui-fixture',
    onBrowserShortcut(callback){shortcuts.add(callback);return()=>shortcuts.delete(callback);},
    async browserSurface(request){
      calls.push(structuredClone(request));
      if(['authenticate','cancel-auth'].includes(request.action)){
        if(holdAuth)await new Promise(resolve=>authWaiting.push(resolve));
        if(failAuth)throw Error('Synthetic secret must not appear in UI: fixture-password');
        return {tabId:request.tabId,challengeId:request.challengeId,submitted:request.action==='authenticate',cancelled:request.action==='cancel-auth'};
      }
      if(request.action==='hide'){generation++;attached=null;bounds=null;return status();}
      if(request.action==='attach'){
        const own=++generation;attached=null;bounds=null;
        if(failAttach)throw Error('Native fixture attachment is unavailable.');
        if(hold)await new Promise(resolve=>waiting.push(resolve));
        if(own!==generation)return status();
        attached=request.tabId;bounds=structuredClone(request.bounds);return status();
      }
      if(request.action==='bounds'){if(attached)bounds=structuredClone(request.bounds);return status();}
      return status();
    }
  }});
})();`;

try{
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  const profile=join(directory,'chrome');await mkdir(profile,{recursive:true});
  browserProcess=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*',
    '--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1360,850','about:blank'],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';browserProcess.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
  const port=await until(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)[0])||null,
    'Disposable Chrome startup');
  const page=await until(async()=>{
    const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return tabs.find(tab=>tab.type==='page');
  },'Disposable browser page');
  await connect(page.webSocketDebuggerUrl);await send('Runtime.enable');await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:stub});
  await send('Page.navigate',{url:'http://127.0.0.1:'+fixture.server.address().port+'/next/#browser'});
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-native-page"))'),'Native Browser workspace');
  await until(()=>evaluate('window.__nativeBrowser.status().attached'),'Initial native page attachment');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-workspace=browser] [data-browser-mode=native]"))'),true);
  assert.equal(await evaluate('window.__nativeBrowser.status().tabId'),'fixture-tab');
  const geometry=await evaluate(`(()=>{
    const page=document.querySelector('#next-browser-native-page').getBoundingClientRect();
    const toolbar=document.querySelector('.next-native-browser .next-browser-navigation').getBoundingClientRect();
    return {page:{x:page.x,y:page.y,width:page.width,height:page.height},toolbarBottom:toolbar.bottom,
      surface:window.__nativeBrowser.status().bounds,viewport:{width:innerWidth,height:innerHeight}};
  })()`);
  assert.ok(geometry.surface.y>=geometry.toolbarBottom-1,'Native page must start below the complete toolbar.');
  assert.ok(geometry.surface.width>400&&geometry.surface.height>200,'Native page receives useful visible bounds.');
  for(const coordinate of ['x','y','width','height'])
    assert.ok(Math.abs(geometry.surface[coordinate]-geometry.page[coordinate])<=2,'IPC '+coordinate+' follows the page placeholder.');
  assert.ok(geometry.surface.x+geometry.surface.width<=geometry.viewport.width+1);
  assert.ok(geometry.surface.y+geometry.surface.height<=geometry.viewport.height+1);
  assert.equal(await evaluate('Boolean(document.querySelector("#next-browser-shot,#next-browser-inspect,#next-browser-type-form,#next-browser-key-send,#next-browser-native-page img,#next-browser-native-page canvas"))'),false,
    'Native mode has direct page space without screenshot, Read, Type, or Send key controls.');
  assert.equal(fixture.state.browserActions.some(item=>['screenshot','read','type','press','click','scroll'].includes(item.action)),false);
  counts.nativeSurface=true;

  const beforeResize=await evaluate('window.__nativeBrowser.calls.length');
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:700,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate('window.__nativeBrowser.calls.slice('+beforeResize+').some(call=>call.action==="bounds"||call.action==="attach")'),'Native surface resize');
  const resized=await evaluate('window.__nativeBrowser.status().bounds');
  assert.ok(resized.width<geometry.surface.width&&resized.height<geometry.surface.height);
  counts.resize=true;

  await click(chatTab);await evaluate('window.__nativeBrowser.failAttachments(true);true');await click(browserTab);
  await until(()=>evaluate('document.querySelector("#next-browser-status")?.dataset.error==="true" && document.querySelector("#next-browser-status").textContent.includes("is unavailable")'),'Native attachment failure surfaced');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('window.__nativeBrowser.status().attached'),false);
  const failedAttachCount=await evaluate('window.__nativeBrowser.calls.filter(call=>call.action==="attach").length');
  const readsAfterFailure=fixture.calls.filter(call=>call==='GET /api/browser/status').length;
  fixture.send({type:'browser.status',data:{tabs:fixture.state.tabs,activeTab:fixture.state.activeBrowserTab}});
  await until(()=>fixture.calls.filter(call=>call==='GET /api/browser/status').length>readsAfterFailure,'Passive status after attachment failure');
  assert.equal(await evaluate('window.__nativeBrowser.calls.filter(call=>call.action==="attach").length'),failedAttachCount,
    'A passive status event cannot loop failed native attachments.');
  await evaluate('window.__nativeBrowser.failAttachments(false);true');
  const beforeRecoveryReload=countAction('reload');await click('#next-browser-reload');await waitAction('reload',beforeRecoveryReload);
  await until(()=>evaluate('window.__nativeBrowser.status().attached && window.__nativeBrowser.calls.filter(call=>call.action==="attach").length>'+failedAttachCount),'Explicit Reload retries the same native page');
  counts.attachmentRecovery=true;

  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.focus();input.value="An address still being typed";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  fixture.state.tabs[0].url='https://updated.example.test/';
  const statusReads=fixture.calls.filter(call=>call==='GET /api/browser/status').length;
  fixture.send({type:'browser.status',data:{tabs:fixture.state.tabs,activeTab:'fixture-tab'}});
  await until(()=>fixture.calls.filter(call=>call==='GET /api/browser/status').length>statusReads,'Browser status refresh');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'An address still being typed',
    'Status updates preserve the address field draft.');
  counts.addressDraft=true;

  const navigationGate=responseGate();let heldNavigation=null;
  fixture.state.browserActionGate=async(body,snapshot)=>{
    if(body.action!=='navigate')return;
    fixture.state.browserActionGate=null;heldNavigation={body,snapshot};await navigationGate.promise;
  };
  const beforeNavigate=countAction('navigate');
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="https://navigation.example.test/path";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-form").requestSubmit();return true})()');
  await waitAction('navigate',beforeNavigate);
  await until(()=>heldNavigation,'Held navigation response');
  assert.deepEqual(fixture.state.browserActions.filter(item=>item.action==='navigate').at(-1),
    {action:'navigate',browser:'relay',tabId:'fixture-tab',url:'https://navigation.example.test/path'});
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="https://newer-navigation-draft.example.test/";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-downloads-toggle").focus();return true})()');
  await statusUpdate('Status while navigation response is held');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-navigation-draft.example.test/');
  navigationGate.release();
  await until(()=>evaluate('document.querySelector("#next-browser-reload").disabled===false'),'Navigation settles');
  await statusUpdate('Status after delayed navigation response');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-navigation-draft.example.test/',
    'A completed navigation preserves a newer address draft after blur and status refresh.');
  counts.pendingNavigationDraft=true;
  for(const [selector,action] of [['#next-browser-back','back'],['#next-browser-forward','forward'],['#next-browser-reload','reload']]){
    const before=countAction(action);await click(selector);await waitAction(action,before);
    assert.deepEqual(fixture.state.browserActions.filter(item=>item.action===action).at(-1),{action,browser:'relay',tabId:'fixture-tab'});
    await until(()=>evaluate('document.querySelector("#next-browser-reload").disabled===false'),action+' settles');
  }
  counts.navigation=true;

  const openingGate=responseGate();let heldOpen=null;
  fixture.state.browserActionGate=async(body,snapshot)=>{
    if(body.action!=='open')return;
    fixture.state.browserActionGate=null;heldOpen={body,snapshot};await openingGate.promise;
  };
  const beforeOpen=countAction('open');
  await click('#next-browser-new');
  assert.equal(await evaluate('document.activeElement.id'),'next-browser-url');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'');
  await waitAction('open',beforeOpen);
  await until(()=>heldOpen,'Held open response');
  assert.deepEqual(heldOpen.body,{action:'open',browser:'relay',url:'about:blank'});
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="https://newer-open-draft.example.test/";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-downloads-toggle").focus();return true})()');
  await statusUpdate('Status while open response is held');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-open-draft.example.test/');
  await click(chatTab);await click(browserTab);
  assert.equal(await evaluate('document.querySelector("#next-browser-go").disabled'),true,'Workspace return preserves the pending operation.');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-open-draft.example.test/');
  openingGate.release();
  const opened=fixture.state.tabs.find(tab=>tab.tabId===heldOpen.snapshot.tabId);assert.ok(opened);
  assert.equal(opened.url,'about:blank');
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(opened.tabId)),'Opened tab attachment');
  await until(()=>evaluate('document.querySelector("#next-browser-reload").disabled===false'),'Open action settles');
  await statusUpdate('Status after delayed open response');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-open-draft.example.test/',
    'A completed tab open preserves a newer address draft after blur and status refresh.');
  counts.pendingOpenDraft=true;
  assert.deepEqual(fixture.state.browserActions.filter(item=>item.action==='open').at(-1),
    {action:'open',browser:'relay',url:'about:blank'});
  assert.equal(countAction('open'),beforeOpen+1,'Reentry cannot dispatch a second blank open.');
  const beforeBlankNavigate=countAction('navigate');
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="https://second.example.test/";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-form").requestSubmit();return true})()');
  await waitAction('navigate',beforeBlankNavigate);
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Blank navigation settles');
  assert.deepEqual(fixture.state.browserActions.filter(item=>item.action==='navigate').at(-1),
    {action:'navigate',browser:'relay',tabId:opened.tabId,url:'https://second.example.test/'});
  assert.equal(countAction('open'),beforeOpen+1,'Submitting the blank address navigates the same real tab.');
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="Draft for second tab";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await click('.next-browser-tab[data-tab-id="fixture-tab"]');
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Select existing native tab');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'https://newer-navigation-draft.example.test/');
  fixture.state.activeBrowserTab='fixture-tab';
  const oldStatusGate=responseGate();let oldStatusSnapshot=null;
  fixture.state.browserStatusGate=async snapshot=>{
    fixture.state.browserStatusGate=null;oldStatusSnapshot=snapshot;await oldStatusGate.promise;
  };
  fixture.send({type:'browser.status',data:{tabs:fixture.state.tabs,activeTab:'fixture-tab'}});
  await until(()=>oldStatusSnapshot,'Captured status before manual tab switch');
  assert.equal(oldStatusSnapshot.activeTab,'fixture-tab');
  await click('.next-browser-tab[data-tab-id='+JSON.stringify(opened.tabId)+']');
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(opened.tabId)),'Reselect opened native tab');
  fixture.state.activeBrowserTab=opened.tabId;
  const beforeOldStatus=await evaluate('window.__nativeBrowser.statusResponses');oldStatusGate.release();
  await until(()=>evaluate('window.__nativeBrowser.statusResponses>'+beforeOldStatus),'Delayed old status delivered');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('window.__nativeBrowser.status().tabId'),opened.tabId,
    'A delayed status snapshot cannot undo a newer manual native tab selection.');
  assert.equal(await evaluate('document.querySelector(".next-browser-tab[aria-selected=true]").dataset.tabId'),opened.tabId);
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'Draft for second tab');
  counts.perTabDrafts=true;
  counts.delayedStatusSelection=true;
  const beforeClose=countAction('close');await click('[data-close-tab='+JSON.stringify(opened.tabId)+']');
  await waitAction('close',beforeClose);
  assert.deepEqual(fixture.state.browserActions.filter(item=>item.action==='close').at(-1),
    {action:'close',browser:'relay',tabId:opened.tabId});
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Remaining tab attachment');
  counts.tabLifecycle=true;

  const beforeQueuedOpen=countAction('open'),beforeQueuedTabs=new Set(fixture.state.tabs.map(tab=>tab.tabId));
  await evaluate('(()=>{const add=document.querySelector("#next-browser-new");add.click();add.click();add.click();return true})()');
  await until(()=>countAction('open')===beforeQueuedOpen+3,'Three deliberate blank requests');
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Queued blank opens settle');
  const queued=fixture.state.tabs.filter(tab=>!beforeQueuedTabs.has(tab.tabId));
  assert.equal(queued.length,3);assert.equal(new Set(queued.map(tab=>tab.tabId)).size,3);
  assert.ok(queued.every(tab=>tab.url==='about:blank'&&tab.title==='New tab'));
  const selectedBlank=queued.at(-1);
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(selectedBlank.tabId)),'Last requested blank selected');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'');
  assert.equal(await evaluate('document.querySelector("#next-browser-back").disabled && document.querySelector("#next-browser-forward").disabled'),true);
  fixture.state.activeBrowserTab=selectedBlank.tabId;
  await send('Page.reload');
  await until(()=>evaluate('window.__nativeBrowser?.status().tabId==='+JSON.stringify(selectedBlank.tabId)),'Saved blank selected after UI reload');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'');
  assert.equal(countAction('open'),beforeQueuedOpen+3,'UI reload restores the saved blank ID.');
  counts.queuedBlankTabsAndReload=true;

  await click(chatTab);fixture.state.activeBrowserTab='fixture-tab';
  const reentryGate=responseGate();let reentrySnapshot=null;
  fixture.state.browserStatusGate=async snapshot=>{fixture.state.browserStatusGate=null;reentrySnapshot=snapshot;await reentryGate.promise;};
  await click(browserTab);await until(()=>reentrySnapshot,'Held fresh reentry status');
  assert.equal(await evaluate('window.__nativeBrowser.status().attached'),false,'Reentry waits for current saved selection.');
  reentryGate.release();
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Backend selection restored on reentry');
  await click(chatTab);
  const explicitGate=responseGate();let explicitSnapshot=null;
  fixture.state.browserStatusGate=async snapshot=>{fixture.state.browserStatusGate=null;explicitSnapshot=snapshot;await explicitGate.promise;};
  await click(browserTab);await until(()=>explicitSnapshot,'Held entry status before explicit selection');
  await click('.next-browser-tab[data-tab-id='+JSON.stringify(selectedBlank.tabId)+']');
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(selectedBlank.tabId)),'Explicit selection while entry status waits');
  explicitGate.release();await sleep(160);
  assert.equal(await evaluate('window.__nativeBrowser.status().tabId'),selectedBlank.tabId);
  counts.reentrySelection=true;
  for(const tab of queued){
    const before=countAction('close');await click('[data-close-tab='+JSON.stringify(tab.tabId)+']');await waitAction('close',before);
    await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Independent blank close settles');
  }
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Original page after blank cleanup');

  await evaluate('window.__nativeBrowser.shortcut("address");true');
  assert.equal(await evaluate('document.activeElement.id'),'next-browser-url');
  const beforeShortcutReload=countAction('reload');
  await evaluate('window.__nativeBrowser.shortcut("reload");true');await waitAction('reload',beforeShortcutReload);
  await until(()=>evaluate('document.querySelector("#next-browser-reload").disabled===false'),'Shortcut reload settles');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true}));true');
  assert.equal(await evaluate('document.activeElement.id'),'next-browser-url');
  await evaluate('window.__nativeBrowser.shortcut("new-tab");true');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'');
  assert.equal(await evaluate('document.activeElement.id'),'next-browser-url');
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Shortcut blank created');
  const blankShortcut=fixture.state.tabs.find(tab=>tab.url==='about:blank');assert.ok(blankShortcut);
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(blankShortcut.tabId)),'Shortcut blank attachment');
  const beforeBlankClose=countAction('close');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"w",ctrlKey:true,bubbles:true}));true');
  await waitAction('close',beforeBlankClose);
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Close saved blank tab shortcut');
  assert.equal(fixture.state.browserActions.filter(item=>item.action==='close').at(-1).tabId,blankShortcut.tabId);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"t",ctrlKey:true,bubbles:true}));true');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'');
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Ctrl+T blank created');
  const shortcutBlank=fixture.state.tabs.find(tab=>tab.url==='about:blank');assert.ok(shortcutBlank);
  const beforeShortcutOpen=countAction('open'),beforeShortcutNavigate=countAction('navigate');
  await evaluate('(()=>{const input=document.querySelector("#next-browser-url");input.value="https://shortcut.example.test/";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-form").requestSubmit();return true})()');
  await waitAction('navigate',beforeShortcutNavigate);
  const shortcutTab=fixture.state.tabs.find(tab=>tab.url==='https://shortcut.example.test/');assert.ok(shortcutTab);
  assert.equal(shortcutTab.tabId,shortcutBlank.tabId);assert.equal(countAction('open'),beforeShortcutOpen);
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==='+JSON.stringify(shortcutTab.tabId)),'Shortcut-created tab attachment');
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Shortcut navigation settles');
  const beforeShortcutClose=countAction('close');
  await evaluate('window.__nativeBrowser.shortcut("close-tab");true');await waitAction('close',beforeShortcutClose);
  assert.equal(fixture.state.browserActions.filter(item=>item.action==='close').at(-1).tabId,shortcutTab.tabId);
  await until(()=>evaluate('window.__nativeBrowser.status().tabId==="fixture-tab"'),'Native page after shortcut close');
  counts.shortcuts=true;

  await click('#next-browser-downloads-toggle');
  await until(()=>evaluate('document.querySelector("#next-browser-downloads").hidden===false'),'Downloads panel');
  await until(()=>evaluate('window.__nativeBrowser.status().bounds.y>=document.querySelector("#next-browser-downloads").getBoundingClientRect().bottom-1'),'Downloads remain above native page');
  assert.match(await evaluate('document.querySelector("#next-browser-downloads").textContent'),/Native fixture report\.txt/);
  await click('#next-browser-downloads-toggle');
  await until(()=>evaluate('window.__nativeBrowser.status().attached'),'Native page restored after downloads');
  counts.downloads=true;

  const authTab=fixture.state.tabs.find(tab=>tab.tabId==='fixture-tab');
  const authChallenge=id=>({id,challengeId:id,tabId:authTab.tabId,kind:'http_auth',status:'pending',
    origin:'https://auth.example.test',url:'https://auth.example.test/private',realm:'<b>Private area</b>',scheme:'basic',isProxy:false});
  authTab.pendingInteraction=authChallenge('auth-fixture-1');
  await statusUpdate('Website sign-in challenge');
  await until(()=>evaluate('!document.querySelector("#next-browser-auth").hidden'),'Website sign-in form');
  assert.equal(await evaluate('document.activeElement.id'),'next-browser-auth-user');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-title").textContent'),'Sign in to https://auth.example.test');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-realm").textContent'),'<b>Private area</b>');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-realm b")===null'),true,'Realm is plain text.');
  await evaluate('(()=>{const user=document.querySelector("#next-browser-auth-user"),password=document.querySelector("#next-browser-auth-password");user.value="fixture-user";password.value="fixture-password";password.focus();window.__authField=password;return true})()');
  await statusUpdate('Repeated challenge preserves typing');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-password")===window.__authField && document.activeElement===window.__authField && window.__authField.value==="fixture-password"'),true);
  await click(chatTab);await click(browserTab);
  await until(()=>evaluate('!document.querySelector("#next-browser-auth").hidden'),'Sign-in draft after workspace return');
  assert.deepEqual(await evaluate('[document.querySelector("#next-browser-auth-user").value,document.querySelector("#next-browser-auth-password").value]'),['fixture-user','fixture-password']);
  const otherAuthTab={...authTab,tabId:'auth-other-tab',pendingInteraction:null,title:'Other page'};
  fixture.state.tabs.push(otherAuthTab);await statusUpdate('Other tab before sign-in draft switch');
  await click('.next-browser-tab[data-tab-id="auth-other-tab"]');fixture.state.activeBrowserTab='auth-other-tab';
  assert.equal(await evaluate('document.querySelector("#next-browser-auth").hidden'),true);
  await click('.next-browser-tab[data-tab-id="fixture-tab"]');fixture.state.activeBrowserTab='fixture-tab';
  assert.deepEqual(await evaluate('[document.querySelector("#next-browser-auth-user").value,document.querySelector("#next-browser-auth-password").value]'),['fixture-user','fixture-password']);
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  await click('#next-browser-downloads-toggle');
  await until(()=>evaluate('(()=>{const auth=document.querySelector("#next-browser-auth").getBoundingClientRect(),page=window.__nativeBrowser.status().bounds;return page&&page.y>=auth.bottom-1&&page.height>70})()'),'Sign-in and downloads reserve native viewport at minimum window size');
  const authAccess=await evaluate('(()=>{const field=document.querySelector("#next-browser-auth-password");field.scrollIntoView({block:"nearest"});const r=field.getBoundingClientRect();return r.width>100&&r.top>=0&&r.bottom<560&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field})()');
  assert.equal(authAccess,true,'Website credentials remain reachable at minimum window size.');
  await click('#next-browser-downloads-toggle');await send('Emulation.clearDeviceMetricsOverride');
  counts.authDraftAndGeometry=true;

  await evaluate('window.__nativeBrowser.holdAuthentication(true);document.querySelector("#next-browser-auth").requestSubmit();true');
  await until(()=>evaluate('window.__nativeBrowser.calls.some(call=>call.action==="authenticate"&&call.challengeId==="auth-fixture-1")'),'Website credentials via trusted IPC');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-password").value'),'','Submitted credentials are cleared immediately.');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-submit").disabled'),true);
  authTab.pendingInteraction=authChallenge('auth-fixture-2');await statusUpdate('Replacement sign-in challenge during submission');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-password").value'),'');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-submit").disabled'),false);
  await evaluate('window.__nativeBrowser.holdAuthentication(false);window.__nativeBrowser.releaseAuthentication();true');
  await statusUpdate('Late receipt of replaced challenge');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth").hidden'),false,'Old receipt cannot dismiss the replacement challenge.');
  assert.deepEqual(await evaluate('window.__nativeBrowser.calls.find(call=>call.action==="authenticate"&&call.challengeId==="auth-fixture-1")'),
    {action:'authenticate',tabId:'fixture-tab',challengeId:'auth-fixture-1',username:'fixture-user',password:'fixture-password'});
  await evaluate('window.__nativeBrowser.failAuthentication(true);document.querySelector("#next-browser-auth").requestSubmit();true');
  await until(()=>evaluate('document.querySelector("#next-browser-auth-note").textContent.includes("could not be submitted")'),'Generic website sign-in IPC error');
  assert.equal(await evaluate('document.querySelector("[data-workspace=browser]").textContent.includes("fixture-password")'),false);
  await evaluate('window.__nativeBrowser.failAuthentication(false);true');await click('#next-browser-auth-cancel');
  await until(()=>evaluate('document.querySelector("#next-browser-auth").hidden'),'Cancel website sign-in');
  delete authTab.pendingInteraction;await statusUpdate('Cancelled challenge retired');
  authTab.pendingInteraction={...authChallenge('auth-fixture-proxy'),isProxy:true,host:'proxy.example.test',port:8080};
  await statusUpdate('Proxy sign-in identifies the proxy');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-title").textContent'),'Sign in to proxy proxy.example.test:8080');
  await click('#next-browser-auth-cancel');
  await until(()=>evaluate('document.querySelector("#next-browser-auth").hidden'),'Cancel proxy sign-in');
  delete authTab.pendingInteraction;await statusUpdate('Proxy challenge retired');
  counts.authChallengeIdentity=true;

  await click('#next-browser-new');
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Authentication blank created');
  const authOpenGate=responseGate();let authOpening=null;
  fixture.state.browserActionGate=async(body,snapshot)=>{
    if(body.action!=='navigate')return;fixture.state.browserActionGate=null;authOpening={body,snapshot};await authOpenGate.promise;
  };
  const beforeAuthOpen=countAction('navigate');
  await evaluate('(()=>{const field=document.querySelector("#next-browser-url");field.value="https://auth.example.test/private";field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-browser-form").requestSubmit();return true})()');
  await waitAction('navigate',beforeAuthOpen);await until(()=>authOpening,'New tab waiting for website credentials');
  const authNewTab=fixture.state.tabs.find(tab=>tab.url==='https://auth.example.test/private');assert.ok(authNewTab);
  authNewTab.pendingInteraction={...authChallenge('auth-fixture-open'),tabId:authNewTab.tabId};
  await statusUpdate('New tab sign-in before open response');
  await until(()=>evaluate('!document.querySelector("#next-browser-auth").hidden'),'New page credentials while toolbar is busy');
  assert.equal(await evaluate('document.querySelector("#next-browser-go").disabled'),true);
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-submit").disabled'),false,'Website sign-in bypasses queued navigation.');
  await evaluate('document.querySelector("#next-browser-auth-user").value="before-workspace-switch";true');
  await click(chatTab);await click(browserTab);
  await until(()=>evaluate('!document.querySelector("#next-browser-auth").hidden'),'Pending new-tab sign-in remains available after workspace return');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth-user").value'),'before-workspace-switch');
  await evaluate('document.querySelector("#next-browser-auth-user").value="new-tab-user";document.querySelector("#next-browser-auth-password").value="new-tab-password";document.querySelector("#next-browser-auth").requestSubmit();true');
  await until(()=>evaluate('window.__nativeBrowser.calls.some(call=>call.action==="authenticate"&&call.challengeId==="auth-fixture-open")'),'Busy new tab credentials submitted');
  assert.equal(await evaluate('window.__nativeBrowser.calls.find(call=>call.challengeId==="auth-fixture-open").tabId'),authNewTab.tabId);
  delete authNewTab.pendingInteraction;authOpenGate.release();
  await until(()=>evaluate('!document.querySelector("#next-browser-reload").disabled'),'Website open resumes');
  await statusUpdate('Authenticated page status resumes');
  assert.equal(await evaluate('document.querySelector("#next-browser-auth").hidden'),true);
  assert.equal(fixture.state.browserActions.some(item=>Object.hasOwn(item,'password')||Object.hasOwn(item,'username')),false,'Credentials are never sent through ordinary browser HTTP actions.');
  assert.equal(await evaluate('[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes("fixture-password")||value.includes("new-tab-password"))'),false);
  const closeAuthNew=countAction('close');await click('[data-close-tab='+JSON.stringify(authNewTab.tabId)+']');await waitAction('close',closeAuthNew);
  await until(()=>evaluate('!document.querySelector("#next-browser-go").disabled'),'Close website sign-in test tab settles');
  fixture.state.tabs=fixture.state.tabs.filter(tab=>tab.tabId!=='auth-other-tab');fixture.state.activeBrowserTab='fixture-tab';
  await statusUpdate('Restore original browser tab');
  counts.authDuringBlankNavigation=true;

  await click(chatTab);
  await until(()=>evaluate('document.querySelector(".next-tab[aria-selected=true]").dataset.space==="chat"'),'Chat workspace');
  assert.equal(await evaluate('window.__nativeBrowser.status().attached'),false,'Leaving Browser hides its native view.');
  const callsWhileHidden=await evaluate('window.__nativeBrowser.calls.length');
  fixture.send({type:'browser.status',data:{tabs:fixture.state.tabs}});await sleep(300);
  assert.equal(await evaluate('window.__nativeBrowser.calls.length'),callsWhileHidden,'Hidden Browser does not attach or reposition on browser events.');
  await evaluate('window.__nativeBrowser.holdAttach(true);true');await click(browserTab);
  await until(()=>evaluate('window.__nativeBrowser.pending()>0'),'Held native attachment');
  await click(chatTab);
  await until(()=>evaluate('document.querySelector(".next-tab[aria-selected=true]").dataset.space==="chat"'),'Chat during pending attachment');
  const leaveCalls=await evaluate('window.__nativeBrowser.calls.length');
  await evaluate('window.__nativeBrowser.release();true');await sleep(250);
  assert.equal(await evaluate('window.__nativeBrowser.status().attached'),false,'A late native attachment cannot cover Chat.');
  assert.equal(await evaluate('window.__nativeBrowser.calls.slice('+leaveCalls+').some(call=>call.action==="attach")'),false,
    'A stale attachment resolution cannot request another attachment.');
  counts.hideAndLateAttach=true;
  assert.equal(fixture.state.browserActions.some(item=>['screenshot','read','type','press','click','scroll'].includes(item.action)),false);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS native_browser_frontend',JSON.stringify(counts),'api_actions='+fixture.state.browserActions.length);
}catch(error){
  console.error('FAIL native_browser_frontend',error.stack||error);
  console.error('RECENT_REQUESTS',fixture.calls.slice(-25));console.error('RENDER_ERRORS',errors);
  try{console.error('NATIVE_STATE',await evaluate('({active:document.querySelector(".next-tab[aria-selected=true]")?.dataset.space,text:document.querySelector("[data-workspace=browser]")?.innerText?.slice(0,1500),surface:window.__nativeBrowser?.status(),calls:window.__nativeBrowser?.calls.slice(-15)})'));}catch{}
  process.exitCode=1;
}finally{
  for(const release of heldResponses)release();heldResponses.clear();
  try{await send('Browser.close');}catch{}
  try{socket?.close();}catch{}
  try{browserProcess?.kill();}catch{}
  fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));
  await fixture.closeKnowledge();await sleep(180);
  await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
}
