import { text } from '../core/dom.mjs';
import { normalizeBrowserAddress } from '../../browser-address.mjs';

export function nativePageBounds(rect,viewport) {
  if(!rect||!viewport||![rect.left,rect.top,rect.width,rect.height,viewport.width,viewport.height].every(Number.isFinite))return null;
  const x=Math.ceil(Math.max(0,rect.left)),y=Math.ceil(Math.max(0,rect.top));
  const right=Math.floor(Math.min(viewport.width,rect.left+rect.width));
  const bottom=Math.floor(Math.min(viewport.height,rect.top+rect.height));
  return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
export function nativeBrowserTabs(status) {
  return (Array.isArray(status?.tabs)?status.tabs:[]).filter(tab=>tab
    &&(tab.browser==='relay'||!tab.browser&&tab.contained===true)
    &&tab.purpose!=='chat-mode'&&typeof tab.tabId==='string'&&tab.tabId.length>0&&tab.tabId.length<=200);
}
export function nativeBrowserSelection(status,previous) {
  const tabs=nativeBrowserTabs(status);
  return [status?.activeTab,status?.browsers?.relay?.activeTab,previous,tabs[0]?.tabId]
    .find(id=>tabs.some(tab=>tab.tabId===id))||null;
}

/** Coalesce geometry updates without queueing stale page attachments. Hide is
 * dispatched immediately; the native host also revokes pending attachments. */
export function createNativeBrowserSurface({surface,onError=()=>{},onAttached=()=>{}}) {
  let desired=null,applied=null,inflight=false,failed=false,revision=0,epoch=0,closed=false;
  const same=(a,b)=>a?.tabId===b?.tabId&&JSON.stringify(a?.bounds)===JSON.stringify(b?.bounds);
  const hideNow=()=>{
    try{Promise.resolve(surface({action:'hide'})).catch(()=>{});}catch{}
  };
  async function flush(){
    if(closed||inflight||failed||!desired)return;
    const target=desired,token=revision,lifecycle=epoch;
    const action=applied?.tabId===target.tabId?'bounds':'attach';
    inflight=true;
    try{
      const result=await surface({action,...(action==='attach'?{tabId:target.tabId}:{}),bounds:target.bounds});
      if(!closed&&lifecycle===epoch&&desired?.tabId===target.tabId){
        if(result?.attached!==true||result.tabId!==target.tabId){if(token===revision)throw Error('The browser page could not be displayed.');return;}
        applied=target;
        if(token===revision)onAttached(target.tabId);
      }
    }catch(error){if(!closed&&token===revision&&desired){failed=true;applied=null;onError(error);}}
    finally{
      inflight=false;
      if(!closed&&desired&&token!==revision)void flush();
    }
  }
  return {
    show(tabId,bounds){
      if(closed)return;
      if(!tabId||!bounds){this.hide();return;}
      const target={tabId,bounds};
      if(same(target,desired))return;
      if(desired&&desired.tabId!==tabId){failed=false;epoch++;applied=null;hideNow();}
      desired=target;revision++;void flush();
    },
    hide(){desired=null;applied=null;failed=false;revision++;epoch++;hideNow();},
    retry(){
      if(closed||!desired)return;
      // An explicit navigation can recreate a renderer or recover a failed
      // attachment without a new tab ID or viewport size. Passive paints do
      // not retry the failed request.
      applied=null;failed=false;revision++;epoch++;hideNow();void flush();
    },
    focus(){if(desired&&applied?.tabId===desired.tabId)try{Promise.resolve(surface({action:'focus'})).catch(()=>{});}catch{}},
    destroy(){closed=true;this.hide();},
  };
}

/** The actual Chromium page occupies the native viewport. Mouse, text,
 * selection, scrolling, menus and browser dialogs are handled by Chromium. */
export function createNativeBrowserWorkspace({mount,api,events,notify=()=>{}}) {
  const document=mount.ownerDocument,window=document.defaultView,bridge=window.relayDesktop;
  mount.innerHTML=[
    '<div class="next-native-browser" data-browser-mode="native">',
    '<div class="next-browser-navigation" aria-label="Browser navigation">',
    '<div class="next-browser-tabs" id="next-browser-tabs" role="tablist" aria-label="Browser tabs"></div>',
    '<form id="next-browser-form" class="next-row next-browser-address" role="search">',
    '<button type="button" id="next-browser-back" aria-label="Back" title="Back">←</button>',
    '<button type="button" id="next-browser-forward" aria-label="Forward" title="Forward">→</button>',
    '<button type="button" id="next-browser-reload" aria-label="Reload page" title="Reload page (Ctrl+R)">↻</button>',
    '<input class="next-field" type="text" id="next-browser-url" autocomplete="url" spellcheck="false" inputmode="url" aria-label="Website address" placeholder="Search or enter a website address">',
    '<button type="submit" id="next-browser-go" class="next-primary">Go</button>',
    '<button type="button" id="next-browser-new" aria-label="New tab" title="New tab (Ctrl+T)">+ Tab</button>',
    '<button type="button" id="next-browser-downloads-toggle" aria-expanded="false" aria-controls="next-browser-downloads">Downloads</button>',
    '</form></div>',
    '<p id="next-browser-status" class="next-native-browser-status" role="status" aria-live="polite"></p>',
    '<section id="next-browser-downloads" class="next-native-downloads" aria-label="Downloads" hidden></section>',
    '<form id="next-browser-auth" class="next-native-auth" aria-labelledby="next-browser-auth-title" hidden>',
    '<h2 id="next-browser-auth-title"></h2><p id="next-browser-auth-realm"></p>',
    '<div class="next-native-auth-fields"><label>Username<input id="next-browser-auth-user" class="next-field" autocomplete="username" maxlength="4096"></label>',
    '<label>Password<input id="next-browser-auth-password" class="next-field" type="password" autocomplete="current-password" maxlength="4096"></label>',
    '<button id="next-browser-auth-submit" class="next-primary" type="submit">Sign in</button>',
    '<button id="next-browser-auth-cancel" type="button">Cancel</button></div>',
    '<p id="next-browser-auth-note" role="status" aria-live="polite"></p></form>',
    '<div id="next-browser-native-page" class="next-native-browser-page" tabindex="-1" aria-label="Browser page"></div>',
    '</div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id),ui={
    tabs:$('next-browser-tabs'),url:$('next-browser-url'),form:$('next-browser-form'),
    back:$('next-browser-back'),forward:$('next-browser-forward'),reload:$('next-browser-reload'),
    go:$('next-browser-go'),newTab:$('next-browser-new'),page:$('next-browser-native-page'),
    status:$('next-browser-status'),downloads:$('next-browser-downloads'),downloadsToggle:$('next-browser-downloads-toggle'),
    auth:$('next-browser-auth'),authTitle:$('next-browser-auth-title'),authRealm:$('next-browser-auth-realm'),
    authUser:$('next-browser-auth-user'),authPassword:$('next-browser-auth-password'),authSubmit:$('next-browser-auth-submit'),
    authCancel:$('next-browser-auth-cancel'),authNote:$('next-browser-auth-note'),
  };
  let active=false,destroyed=false,selected=null,tabs=[],downloads=[],busy=false,openingBlank=null,
    generation=0,refreshSequence=0,pendingSelection=null,addressRevision=0,selectionRevision=0,unsubscribe=null,
    refreshTimer=null,geometryFrame=null,tabLimit=80,downloadsKey='',emptyKey='',pendingNavigation=null,authKey=null,
    activeOperation=null,newTabDrain=false,failedBlankDraft=null,deferredError=null,surfaceReady=false,preferBackendSelection=false;
  const tabNodes=new Map();
  const addressDrafts=new Map(),newTabRequests=[];
  const authDrafts=new Map(),authPending=new Set(),authAnswered=new Set(),authFocused=new Set();
  const current=()=>!openingBlank&&tabs.find(tab=>tab.tabId===selected)||null;
  const addressKey=()=>openingBlank||selected;
  const pageAddress=tab=>tab?.url==='about:blank'?'':tab?.url||'';
  function paintAddress(force=false){
    const draft=addressDrafts.get(addressKey());
    if(draft?.dirty)ui.url.value=draft.value;
    else if(force||document.activeElement!==ui.url)ui.url.value=openingBlank?'':pageAddress(current());
  }
  const challengeKey=challenge=>JSON.stringify([challenge.tabId,challenge.challengeId||challenge.id]);
  function tabChallenge(tab){
    const challenge=tab?.pendingInteraction;
    if(challenge?.kind!=='http_auth'||challenge.status!=='pending'||!(challenge.challengeId||challenge.id))return null;
    return {...challenge,tabId:tab.tabId};
  }
  function currentChallenge(){
    let challenge=tabChallenge(current());
    if(pendingNavigation?.action==='open'){
      let origin;try{origin=new URL(pendingNavigation.url).origin;}catch{}
      challenge=tabs.filter(tab=>!pendingNavigation.existing.has(tab.tabId)).map(tabChallenge)
        .find(item=>item&&item.origin===origin)||challenge;
    }else if(pendingNavigation?.tabId){
      challenge=tabChallenge(tabs.find(tab=>tab.tabId===pendingNavigation.tabId))||challenge;
    }
    return challenge&&!authAnswered.has(challengeKey(challenge))?challenge:null;
  }
  function saveAuthDraft(){
    if(authKey&&!authPending.has(authKey))authDrafts.set(authKey,{username:ui.authUser.value,password:ui.authPassword.value});
  }
  function renderAuth(){
    const challenge=currentChallenge(),key=challenge?challengeKey(challenge):null;
    if(key!==authKey){
      saveAuthDraft();authKey=key;
      const draft=authDrafts.get(key);ui.authUser.value=draft?.username||'';ui.authPassword.value=draft?.password||'';
      ui.authNote.textContent='';
    }
    ui.auth.hidden=!challenge;
    if(!challenge)return;
    ui.authTitle.textContent=challenge.isProxy?(challenge.host?'Sign in to proxy '+challenge.host+(challenge.port?':'+challenge.port:''):'Proxy sign-in'):'Sign in to '+(challenge.origin||'this website');
    ui.authRealm.textContent=challenge.realm||'';ui.authRealm.hidden=!challenge.realm;
    const submitting=authPending.has(key);
    for(const control of [ui.authUser,ui.authPassword,ui.authSubmit,ui.authCancel])control.disabled=submitting;
    if(submitting)ui.authNote.textContent='Submitting…';
    if(!authFocused.has(key)){
      authFocused.add(key);
      queueMicrotask(async()=>{
        if(!active||authKey!==key||ui.auth.hidden)return;
        try{await bridge.browserSurface({action:'focus-chrome'});}catch{}
        if(active&&authKey===key&&!ui.auth.hidden)ui.authUser.focus({preventScroll:true});
      });
    }
  }
  async function answerAuth(cancel=false){
    const challenge=currentChallenge();if(!active||!challenge)return;
    const key=challengeKey(challenge);if(authPending.has(key))return;
    const request={action:cancel?'cancel-auth':'authenticate',tabId:challenge.tabId,challengeId:challenge.challengeId||challenge.id};
    if(!cancel){request.username=ui.authUser.value;request.password=ui.authPassword.value;}
    authDrafts.delete(key);ui.authUser.value='';ui.authPassword.value='';authPending.add(key);renderAuth();
    try{
      await bridge.browserSurface(request);
      authAnswered.add(key);
      if(active){render();await refresh();}
    }catch{
      if(active&&authKey===key)ui.authNote.textContent=cancel?'The sign-in request could not be cancelled. Try again.':'The sign-in details could not be submitted. Try again.';
    }finally{
      authPending.delete(key);
      if(active)renderAuth();
    }
  }
  function notice(message,error=false){
    if(!active)return;
    ui.status.textContent=String(message||'');ui.status.dataset.error=String(error);
    if(error)notify(message,true);
    scheduleGeometry();
  }
  const surface=createNativeBrowserSurface({
    surface:request=>bridge.browserSurface(request),
    onError:error=>{if(active){pendingSelection=null;ui.page.dataset.attached='false';notice(error.message,true);}},
    onAttached:tabId=>{if(active&&selected===tabId&&!openingBlank){
      pendingSelection=null;ui.page.dataset.attached='true';
    }},
  });
  function geometry(){
    geometryFrame=null;
    if(!active||!surfaceReady||mount.hidden||!current()){surface.hide();return;}
    const bounds=nativePageBounds(ui.page.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight});
    surface.show(selected,bounds);
  }
  function scheduleGeometry(){
    if(active&&geometryFrame===null)geometryFrame=window.requestAnimationFrame(geometry);
  }
  function renderTabs(){
    const visible=tabs.slice(0,tabLimit);
    const chosen=tabs.find(tab=>tab.tabId===selected);
    if(chosen&&!visible.includes(chosen))visible.push(chosen);
    const records=visible.map(tab=>({id:'tab:'+tab.tabId,tab}));
    if(openingBlank)records.push({id:'opening:'+openingBlank.revision,tab:null});
    const retained=new Set(records.map(record=>record.id));
    for(const [id,nodes] of tabNodes)if(!retained.has(id)){nodes.group.remove();tabNodes.delete(id);}
    for(let index=0;index<records.length;index++){
      const {id,tab}=records[index];let nodes=tabNodes.get(id);
      if(!nodes){
        const group=document.createElement('div');group.className='next-browser-tab-group';
        const button=text(group,'','button','next-browser-tab');button.type='button';button.setAttribute('role','tab');
        const close=text(group,'×','button','next-browser-tab-close');close.type='button';
        button.addEventListener('click',()=>{if(!busy&&tab)select(tab.tabId);});
        close.addEventListener('click',()=>{if(!busy&&tab)void operate('close',{tabId:tab.tabId});});
        nodes={group,button,close};tabNodes.set(id,nodes);
      }
      const label=tab?.url==='about:blank'?'New tab':tab?.title||tab?.url||'New tab…',chosen=tab?!openingBlank&&tab.tabId===selected:Boolean(openingBlank);
      if(nodes.button.textContent!==label)nodes.button.textContent=label;
      nodes.button.dataset.tabId=tab?.tabId||'';
      nodes.button.title=tab?(tab.owner?'Task tab · ':'')+(tab.url||label):'New tab';
      nodes.button.setAttribute('aria-selected',String(chosen));nodes.button.tabIndex=chosen?0:-1;
      nodes.button.classList.toggle('next-primary',chosen);nodes.button.disabled=busy;
      nodes.close.dataset.closeTab=tab?.tabId||'';nodes.close.disabled=busy||!tab;nodes.close.setAttribute('aria-label','Close '+label);
      if(ui.tabs.children[index]!==nodes.group)ui.tabs.insertBefore(nodes.group,ui.tabs.children[index]||null);
    }
    ui.tabs.querySelector('.next-native-more-tabs')?.remove();
    if(tabs.length>visible.length){
      const more=text(ui.tabs,'More tabs ('+(tabs.length-visible.length)+')','button','next-native-more-tabs');more.type='button';
      more.addEventListener('click',()=>{tabLimit+=80;renderTabs();scheduleGeometry();});
    }
  }
  function renderDownloads(){
    ui.downloadsToggle.textContent='Downloads'+(downloads.length?' ('+downloads.length+')':'');
    const key=JSON.stringify(downloads);
    if(key===downloadsKey)return;downloadsKey=key;ui.downloads.replaceChildren();
    text(ui.downloads,'Downloads','h2');
    if(!downloads.length)text(ui.downloads,'Downloaded files appear here.','p','next-help');
    for(const item of downloads.slice(-40).reverse()){
      const row=text(ui.downloads,'','div','next-native-download');
      text(row,item.name||'Download','strong');
      text(row,[item.status||'pending',item.status==='completed'?item.path:''].filter(Boolean).join(' · '),'span');
    }
  }
  function render(){
    renderTabs();renderDownloads();renderAuth();
    const tab=current(),key=tab?'page':openingBlank?'new':'empty';
    ui.back.disabled=busy||!tab||tab.canGoBack===false;
    ui.forward.disabled=busy||!tab||tab.canGoForward===false;
    ui.reload.disabled=busy||!tab;
    ui.go.disabled=busy||Boolean(openingBlank);ui.newTab.disabled=false;
    if(key!==emptyKey){
      emptyKey=key;ui.page.replaceChildren();ui.page.dataset.attached='false';
      const panel=text(ui.page,'','div','next-native-browser-empty');
      text(panel,key==='page'?'Opening page…':key==='new'?'New tab':'Browse the web','h1');
      if(key!=='page')text(panel,'Enter an address above to open a page.','p');
    }
    if(!tab)surface.hide();
    if(ui.status.dataset.error!=='true')ui.status.textContent=busy?'Working…':tab?.loading?'Loading…':'';
    scheduleGeometry();
  }
  function select(tabId){
    if(!active||busy||!tabs.some(tab=>tab.tabId===tabId))return;
    selectionRevision++;
    preferBackendSelection=false;surfaceReady=true;
    pendingNavigation=null;
    refreshSequence++;
    surface.hide();
    selected=tabId;pendingSelection=tabId;
    paintAddress(true);ui.status.dataset.error='false';
    ui.page.dataset.attached='false';render();
  }
  async function drainNewTabs(){
    if(newTabDrain||destroyed)return;newTabDrain=true;
    try{while(active&&!busy&&newTabRequests.length){
      const request=newTabRequests.shift();await operate('open',{url:'about:blank'},{newTab:request});
    }}finally{newTabDrain=false;}
  }
  function newTab(){
    if(!active||destroyed)return;
    const request={revision:++selectionRevision};newTabRequests.push(request);openingBlank=request;
    preferBackendSelection=false;
    if(failedBlankDraft){addressDrafts.set(request,failedBlankDraft);failedBlankDraft=null;}
    refreshSequence++;surface.hide();ui.page.dataset.attached='false';paintAddress(true);render();ui.url.focus({preventScroll:true});
    void drainNewTabs();
  }
  function applyStatus(data,{preferred}={}){
    if(!active||!data||!Array.isArray(data.tabs))return;
    const previous=selected;tabs=nativeBrowserTabs(data);
    const liveChallenges=new Set(tabs.map(tabChallenge).filter(Boolean).map(challengeKey));
    for(const collection of [authDrafts,authAnswered,authFocused])for(const key of collection.keys())if(!liveChallenges.has(key))collection.delete(key);
    if(authKey&&!liveChallenges.has(authKey)){authKey=null;ui.authUser.value='';ui.authPassword.value='';}
    downloads=(Array.isArray(data.downloads)?data.downloads:[]).filter(item=>item&&(!item.browser||item.browser==='relay'));
    selected=[preferred,pendingSelection,preferBackendSelection?nativeBrowserSelection(data):null,selected].find(id=>tabs.some(tab=>tab.tabId===id))||nativeBrowserSelection(data,selected);
    preferBackendSelection=false;surfaceReady=true;
    if(!tabs.some(tab=>tab.tabId===pendingSelection))pendingSelection=null;
    for(const key of addressDrafts.keys())if(typeof key==='string'&&!tabs.some(tab=>tab.tabId===key))addressDrafts.delete(key);
    paintAddress(selected!==previous);
    render();
  }
  async function refresh(options={}){
    if(!active)return;
    const token=generation,sequence=++refreshSequence;
    try{
      const data=await api('/api/browser/status?view=contained');
      if(active&&token===generation&&sequence===refreshSequence)applyStatus(data,options);
    }catch(error){if(active&&token===generation&&sequence===refreshSequence)notice(error.message,true);}
  }
  async function operate(action,extra={},options={}){
    if(!active||busy||destroyed)return;
    const tabId=extra.tabId||selected,key=options.newTab||addressKey(),submittedAddressRevision=addressDrafts.get(key)?.revision;
    if(action!=='open'&&!tabId)return;
    const navigation=['open','navigate','back','forward','reload'].includes(action);
    const operation={action,tabId:action==='open'?null:tabId,url:extra.url,existing:new Set(tabs.map(tab=>tab.tabId)),
      selectionRevision:options.newTab?.revision??selectionRevision,newTab:options.newTab||null};
    activeOperation=operation;pendingNavigation=navigation?operation:null;refreshSequence++;
    busy=true;ui.status.dataset.error='false';render();
    try{
      const result=await api('/api/browser/action','POST',{action,browser:'relay',...(action==='open'?{}:{tabId}),...extra},{deadlineMs:30000});
      if(destroyed||activeOperation!==operation)return;
      const ownsSelection=operation.selectionRevision===selectionRevision;
      if(action==='open'){
        if(typeof result?.tabId!=='string'||!result.tabId)throw Error('The new browser tab was not confirmed. Refresh before trying again.');
        const draft=addressDrafts.get(key);
        if(draft?.dirty&&(options.newTab||draft.revision!==submittedAddressRevision))addressDrafts.set(result.tabId,draft);
        addressDrafts.delete(key);
        if(options.newTab&&openingBlank===options.newTab)openingBlank=null;
        if(ownsSelection){selected=result.tabId;pendingSelection=selected;}
      }else if(action==='navigate'&&addressDrafts.get(key)?.revision===submittedAddressRevision)addressDrafts.delete(key);
      if(action==='close'){
        addressDrafts.delete(tabId);
        if(selected===tabId){selected=null;pendingSelection=null;surface.hide();}
      }
      refreshSequence++;
      if(active){
        await refresh(action==='open'&&ownsSelection?{preferred:selected}:{});
        if(ownsSelection)paintAddress(true);
        if(ownsSelection&&selected===tabId&&!openingBlank&&['navigate','back','forward','reload'].includes(action))surface.retry();
        if(options.newTab&&ownsSelection&&selected===result.tabId)ui.url.focus({preventScroll:true});
      }
    }catch(error){
      if(!destroyed&&activeOperation===operation){
        if(options.newTab){
          if(openingBlank===options.newTab){failedBlankDraft=addressDrafts.get(options.newTab)||null;openingBlank=null;if(active)paintAddress(true);}
          addressDrafts.delete(options.newTab);
        }
        if(active)notice(error.message,true);else deferredError=error.message;
      }
    }
    finally{
      if(activeOperation===operation){activeOperation=null;busy=false;if(pendingNavigation===operation)pendingNavigation=null;if(active)render();void drainNewTabs();}
    }
  }
  ui.form.addEventListener('submit',event=>{
    event.preventDefault();let url;
    try{url=normalizeBrowserAddress(ui.url.value);}catch(error){notice(error.message,true);return;}
    if(!busy&&!openingBlank)void operate(!selected?'open':'navigate',{url});
  });
  ui.url.addEventListener('input',()=>{addressDrafts.set(addressKey(),{value:ui.url.value,dirty:true,revision:++addressRevision});});
  ui.auth.addEventListener('submit',event=>{event.preventDefault();void answerAuth();});
  ui.authCancel.addEventListener('click',()=>void answerAuth(true));
  ui.newTab.addEventListener('click',newTab);
  ui.back.addEventListener('click',()=>void operate('back'));
  ui.forward.addEventListener('click',()=>void operate('forward'));
  ui.reload.addEventListener('click',()=>void operate('reload'));
  ui.downloadsToggle.addEventListener('click',()=>{
    ui.downloads.hidden=!ui.downloads.hidden;ui.downloadsToggle.setAttribute('aria-expanded',String(!ui.downloads.hidden));scheduleGeometry();
  });
  ui.page.addEventListener('focus',()=>surface.focus());
  function shortcut(kind){
    if(!active||mount.hidden)return;
    if(kind==='address'){ui.url.focus({preventScroll:true});ui.url.select();}
    if(kind==='new-tab')ui.newTab.click();
    if(kind==='close-tab'){if(!openingBlank&&selected)void operate('close');}
    if(kind==='reload')ui.reload.click();
    if(kind==='back')ui.back.click();
    if(kind==='forward')ui.forward.click();
    if((kind==='next-tab'||kind==='previous-tab')&&!busy){
      const choices=tabs.map(tab=>tab.tabId);
      if(choices.length){const index=choices.indexOf(selected),step=kind==='next-tab'?1:-1;
        select(choices[(index+step+choices.length)%choices.length]);}
    }
  }
  const keydown=event=>{
    if(!active)return;
    if(event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&['ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();shortcut(event.key==='ArrowLeft'?'back':'forward');return;
    }
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key==='Tab'){
      event.preventDefault();shortcut(event.shiftKey?'previous-tab':'next-tab');return;
    }
    if((!event.ctrlKey&&!event.metaKey)||event.altKey||event.shiftKey)return;
    const kind={l:'address',t:'new-tab',w:'close-tab',r:'reload'}[event.key.toLowerCase()];
    if(kind){event.preventDefault();shortcut(kind);}
  };
  document.addEventListener('keydown',keydown);
  const unsubscribeShortcut=bridge.onBrowserShortcut?.(shortcut);
  const observer=typeof window.ResizeObserver==='function'?new window.ResizeObserver(scheduleGeometry):null;
  observer?.observe(ui.page);
  window.addEventListener('resize',scheduleGeometry);
  window.addEventListener('scroll',scheduleGeometry,true);
  const onEvent=event=>{
    if(!active||typeof event?.type!=='string'||!event.type.startsWith('browser.'))return;
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh();},100);
  };
  return {
    enter(){if(destroyed||active)return;active=true;generation++;surfaceReady=false;preferBackendSelection=!busy&&!openingBlank;unsubscribe=events.subscribe(onEvent);render();void refresh();void drainNewTabs();if(deferredError){notice(deferredError,true);deferredError=null;}},
    // Global status can be an older cached snapshot. Re-read the browser's own
    // state through its sequenced endpoint instead of repainting that snapshot.
    updateStatus(status){if(active&&status?.browser)onEvent({type:'browser.status'});},
    leave(){saveAuthDraft();active=false;generation++;refreshSequence++;pendingSelection=null;
      unsubscribe?.();unsubscribe=null;clearTimeout(refreshTimer);refreshTimer=null;
      if(geometryFrame!==null)window.cancelAnimationFrame(geometryFrame);geometryFrame=null;
      ui.page.dataset.attached='false';surface.hide();},
    destroy(){this.leave();destroyed=true;newTabRequests.length=0;addressDrafts.clear();authDrafts.clear();ui.authUser.value='';ui.authPassword.value='';surface.destroy();observer?.disconnect();unsubscribeShortcut?.();
      document.removeEventListener('keydown',keydown);window.removeEventListener('resize',scheduleGeometry);
      window.removeEventListener('scroll',scheduleGeometry,true);mount.innerHTML='';},
  };
}
