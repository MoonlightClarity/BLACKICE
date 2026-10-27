const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const normalizeWindows = value => (Array.isArray(value) ? value : []).filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && /^\d+$/.test(item.id));
const normalizeApps=value=>(Array.isArray(value)?value:[]).filter(item=>item&&typeof item.id==='string'&&item.id.length<=200&&typeof item.name==='string'&&item.name.trim()).map(item=>({...item,folder:String(item.folder||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'')})).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
const safeIcon=value=>typeof value==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)?value:null;
const normalizePins=value=>[...new Set((Array.isArray(value)?value:[]).filter(id=>typeof id==='string'&&id.length>0&&id.length<=200))];
const embedded=value=>value?.attached===true&&value?.embedded===true;

export function installedAppsView(apps,{query='',folder=''}={}) {
  const needle=query.trim().toLocaleLowerCase(),prefix=folder?folder+'/':'';
  const entries=normalizeApps(apps);
  const folders=[...new Set(entries.map(item=>item.folder).filter(value=>value&&(folder?value.startsWith(prefix):true)).map(value=>folder?prefix+value.slice(prefix.length).split('/')[0]:value.split('/')[0]))].sort((a,b)=>a.localeCompare(b));
  const items=entries.filter(item=>needle?needle.split(/\s+/).every(term=>(item.name+' '+item.folder).toLocaleLowerCase().includes(term)):!folder||item.folder===folder||item.folder.startsWith(prefix));
  return {items,folders};
}

export function pinnedAppsView(apps,pinIds,{query='',allApps=false}={}) {
  const entries=normalizeApps(apps),pins=normalizePins(pinIds),byId=new Map(entries.map(app=>[app.id,app]));
  const items=query.trim()||allApps?installedAppsView(entries,{query}).items:pins.map(id=>byId.get(id)||{id,name:'Unavailable application',folder:'',unavailable:true});
  return {items:items.map(app=>({...app,pinned:pins.includes(app.id)})),view:query.trim()?'search':allApps?'all':'pinned'};
}

export function nativePanelBounds(rect, viewport, scale = 1) {
  if (!rect || !viewport || rect.top < 0 || rect.left < 0) return null;
  const ratio = Math.max(.5, Math.min(4, Number(scale) || 1));
  const x = Math.round(rect.left * ratio), y = Math.round(rect.top * ratio);
  const width = Math.floor(Math.min(rect.width, viewport.width - rect.left - 2) * ratio);
  const height = Math.floor(Math.min(rect.height, viewport.height - rect.top - 2) * ratio);
  return width >= 80 && height >= 60 ? { x, y, width, height } : null;
}

/** Actual native windows and owned dialogs are children of a clipping container
 * inside BLACKICE. Applications keep their normal desktop and permissions.
 */
export function initNativeAppsUI({ mount, desktop = globalThis.window?.relayDesktop, isVisible = () => true, scale = () => globalThis.window?.devicePixelRatio || 1, title='Native applications', heading='h2' } = {}) {
  if (!mount) throw Error('Native Applications requires an Applications panel.');
  const send = desktop?.nativeApps;
  const $ = query => mount.querySelector(query);
  const state = { active: false, attached: false, visible: false, id: '', title: '', selected: '', windows: [], dialogs: [],
    busy: false, error: '', message: '', mode: 'native_window', lastBounds: '', timer: null, positionPending: false, polling: false,
    apps:[],catalogLoading:false,catalogLoaded:false,catalogError:'',query:'',allApps:false,appLimit:80,launcherOpen:true,initialized:false,menuMode:'apps',
    pinIds:[],pinsLoading:false,pinsLoaded:false,pinSaving:false,pinUncertain:false,pinError:'',arranging:false,launchRequestId:'' };
  const launchIntents=new Map();
  const doc = mount.ownerDocument || globalThis.document;
  const headingTag=heading==='h1'?'h1':'h2';
  if (doc && !doc.getElementById('blackice-native-app-styles')) {
    const link = doc.createElement('link');
    link.id = 'blackice-native-app-styles'; link.rel = 'stylesheet'; link.href = '/native-apps.css';
    doc.head.append(link);
  }
  mount.innerHTML = [
    '<div class="native-apps-layout">',
    '<header class="native-apps-header"><div><'+headingTag+'>'+escape(title)+'</'+headingTag+'><p>Your Windows apps, together in BLACKICE.</p></div>',
    '<div class="native-app-header-actions"><button type="button" class="native-app-menu-toggle" data-native-app="menu" aria-controls="native-app-launcher" aria-expanded="true">▦ Apps</button>',
    '<button type="button" data-native-app="focus">Focus application</button><button type="button" data-native-app="close-app" title="Close the embedded application" aria-label="Close application">Close application</button></div></header>',
    '<p id="native-app-notice" class="native-app-notice" role="status" aria-live="polite"></p>',
    '<div id="native-app-launch-recovery" class="native-app-launch-recovery" hidden><button type="button" data-native-app="recover-launch">Check loading</button><span>Uses the application already opened.</span></div>',
    '<div id="native-app-stage" class="native-app-stage" aria-label="Embedded native Windows application">',
    '<div id="native-app-placeholder" class="native-app-placeholder"><strong>Open a pinned app or search for an application.</strong><p>Your apps keep their familiar menus, controls and documents.</p></div>',
    '<section id="native-app-launcher" class="native-app-launcher" aria-label="Application launcher">',
    '<div class="native-app-launcher-top"><label class="native-app-search"><span>Find an application</span><input id="native-app-search" type="search" placeholder="Search apps…" autocomplete="off" aria-controls="native-app-catalog"></label>',
    '<button type="button" data-native-app="catalog-refresh" title="Refresh installed applications" aria-label="Refresh installed applications">↻</button><button type="button" data-native-app="menu-close" aria-label="Close application menu">✕</button></div>',
    '<div class="native-app-launcher-body"><div class="native-app-catalog-pane"><div id="native-app-catalog-heading" class="native-app-catalog-heading"></div><p id="native-app-catalog-status" class="native-app-catalog-status" role="status" aria-live="polite"></p><p id="native-app-pin-status" class="native-app-catalog-status" role="status" aria-live="polite"></p><div id="native-app-catalog" class="native-app-catalog"></div></div></div>',
    '<div class="native-app-launcher-bottom"><div class="native-app-view-actions"><button type="button" data-native-app="pinned-view">Pinned apps</button><button type="button" data-native-app="all-apps">All apps</button><button type="button" data-native-app="running">Running windows</button></div><span id="native-app-catalog-count"></span></div>',
    '<section id="native-app-running" class="native-app-running" aria-label="Running application windows" hidden><div class="native-app-running-head"><strong>Running windows</strong><button type="button" data-native-app="refresh">Refresh</button></div><div class="native-apps-toolbar"><label>Choose a window<select id="native-app-picker" aria-label="Select a Windows application"></select></label><button type="button" data-native-app="attach">Load window</button></div></section>',
    '</section></div>',
    '<details class="native-app-launch-options"><summary>Advanced · executable path and arguments</summary><div class="native-app-launch-fields">',
    '<label>Application path<input id="native-app-executable" type="text" placeholder="C:\\Program Files\\Application\\app.exe" autocomplete="off"></label>',
    '<label>Arguments <span>(optional, one per line)</span><textarea id="native-app-arguments" rows="2" placeholder="A document path or application option"></textarea></label>',
    '<button type="button" data-native-app="launch-path">Open path</button><button type="button" data-native-app="launch">Browse executable…</button></div></details>',
    '<footer class="native-app-footer"><span id="native-app-selected"></span><span id="native-app-dialogs"></span></footer></div>'
  ].join('');
  const stage = $('#native-app-stage'), picker = $('#native-app-picker');
  // Headless render fixtures and legacy clients may not construct the new panel.
  if (!stage || !picker) return { enter() {}, leave() {}, update() {}, destroy() {} };
  const view = doc?.defaultView || globalThis.window;
  const iconRequested=new Set(),iconQueue=new Set();let iconLoading=false,iconObserver=null,destroyed=false;
  async function loadIcons() {
    if(iconLoading||destroyed||!send)return;
    iconLoading=true;
    try {
      while(iconQueue.size&&!destroyed){
        const appIds=[...iconQueue].slice(0,24);for(const id of appIds)iconQueue.delete(id);
        let result;try{result=await send({action:'icons',appIds});}catch{continue;}
        if(destroyed)return;
        for(const [id,value] of Object.entries(result?.icons||{})){
          const icon=safeIcon(value),app=state.apps.find(item=>item.id===id);if(!icon||!app||!appIds.includes(id))continue;
          app.icon=icon;
          const node=[...mount.querySelectorAll('[data-native-app="launch-installed"]')].find(button=>button.dataset.appId===id)?.querySelector?.('.native-app-icon');
          if(node)node.outerHTML='<img class="native-app-icon" src="'+escape(icon)+'" alt="" loading="lazy">';
        }
      }
    } finally {iconLoading=false;}
  }
  function requestIcons(ids) {
    for(const id of ids)if(!iconRequested.has(id)&&!safeIcon(state.apps.find(app=>app.id===id)?.icon)){iconRequested.add(id);iconQueue.add(id);}
    if(iconQueue.size)void loadIcons();
  }
  function watchIcons(items) {
    if(!state.active||!state.launcherOpen||state.menuMode!=='apps'||!send)return;
    const Observer=view?.IntersectionObserver||globalThis.IntersectionObserver;
    if(Observer){
      if(!iconObserver)iconObserver=new Observer(entries=>requestIcons(entries.filter(item=>item.isIntersecting).map(item=>item.target.dataset.appId)),{root:$('#native-app-catalog'),rootMargin:'100px'});
      iconObserver.disconnect();for(const node of mount.querySelectorAll('[data-native-app="launch-installed"]'))if(!node.disabled&&!iconRequested.has(node.dataset.appId))iconObserver.observe(node);
    }else requestIcons(items.filter(app=>!app.unavailable).map(app=>app.id));
  }
  const report = error => { state.error = String(error?.message || error || 'Native app operation failed.'); render(); };
  function renderCatalog() {
    const launcher=$('#native-app-launcher');if(launcher)launcher.hidden=!state.launcherOpen;
    const toggle=mount.querySelector('[data-native-app="menu"]');toggle?.setAttribute?.('aria-expanded',String(state.launcherOpen));
    const model=pinnedAppsView(state.apps,state.pinIds,{query:state.query,allApps:state.allApps});
    const heading=$('#native-app-catalog-heading'),headingHtml='<strong>'+(model.view==='search'?'Search results':model.view==='all'?'All apps':'Pinned apps')+'</strong>'+(model.view==='pinned'&&state.pinIds.length>1?'<button type="button" data-native-app="arrange-pins" aria-pressed="'+state.arranging+'">'+(state.arranging?'Done arranging':'Arrange')+'</button>':'');
    if(heading&&heading.innerHTML!==headingHtml)heading.innerHTML=headingHtml;
    const waiting=!state.catalogLoaded||model.view==='pinned'&&!state.pinsLoaded;
    const status=$('#native-app-catalog-status');if(status)status.textContent=state.catalogLoading&&!state.catalogLoaded?'Finding your installed applications…':state.pinsLoading&&!state.pinsLoaded?'Loading pinned apps…':state.catalogError||(!waiting&&!model.items.length?(model.view==='search'?'No applications match “'+state.query+'”.':model.view==='pinned'?'Pin the apps you use most. Search above, then choose the star beside an app.':'No installed applications were found.'):'');
    const pinStatus=$('#native-app-pin-status');if(pinStatus)pinStatus.textContent=state.pinError||(state.pinSaving?'Saving pinned apps…':'');
    const visibleItems=waiting?[]:model.items.slice(0,state.appLimit);
    const appHtml=visibleItems.map(app=>{
      const id=escape(app.id),index=state.pinIds.indexOf(app.id),name=escape(app.name);
      return '<div class="native-app-card'+(app.unavailable?' native-app-unavailable':'')+'"><button type="button" class="native-app-item" data-native-app="launch-installed" data-app-id="'+id+'"'+(app.unavailable?' disabled data-native-blocked="true"':'')+' title="'+(app.unavailable?'This pinned application is unavailable':'Open '+name)+'">'+(safeIcon(app.icon)?'<img class="native-app-icon" src="'+escape(app.icon)+'" alt="" loading="lazy">':'<span class="native-app-icon native-app-icon-fallback" aria-hidden="true">'+escape(app.name.trim().slice(0,1).toUpperCase())+'</span>')+'<span class="native-app-item-copy"><strong>'+name+'</strong>'+((app.unavailable||model.view!=='pinned'&&app.folder)?'<small>'+escape(app.unavailable?'Refresh apps or remove this pin':app.folder.replace(/\//g,' › '))+'</small>':'')+'</span></button>'
        +'<button type="button" class="native-app-pin" data-native-app="toggle-pin" data-app-id="'+id+'" aria-pressed="'+app.pinned+'" aria-label="'+(app.pinned?'Unpin ':'Pin ')+name+'" title="'+(app.pinned?'Unpin':'Pin')+'">'+(app.pinned?'★':'☆')+'</button>'
        +(state.arranging&&model.view==='pinned'?'<div class="native-app-pin-order"><button type="button" data-native-app="pin-earlier" data-app-id="'+id+'" data-native-blocked="'+(index===0)+'" aria-label="Move '+name+' earlier">←</button><button type="button" data-native-app="pin-later" data-app-id="'+id+'" data-native-blocked="'+(index===state.pinIds.length-1)+'" aria-label="Move '+name+' later">→</button></div>':'')+'</div>';
    }).join('')+(model.items.length>state.appLimit?'<button type="button" class="native-app-more" data-native-app="more-apps">Show more applications</button>':'');
    const catalog=$('#native-app-catalog');if(catalog){catalog.dataset.view=model.view;if(catalog.innerHTML!==appHtml)catalog.innerHTML=appHtml;}
    const count=$('#native-app-catalog-count');if(count)count.textContent=waiting?'':model.items.length+' '+(model.view==='pinned'?'pinned app':'application')+(model.items.length===1?'':'s');
    const body=mount.querySelector('.native-app-launcher-body');if(body)body.hidden=state.menuMode==='running';
    const running=$('#native-app-running');if(running)running.hidden=state.menuMode!=='running';
    for(const action of ['pinned-view','all-apps','running'])mount.querySelector('[data-native-app="'+action+'"]')?.setAttribute?.('aria-pressed',String(action==='running'?state.menuMode==='running':state.menuMode==='apps'&&(action==='all-apps'?model.view==='all':model.view==='pinned')));
    watchIcons(visibleItems);
  }
  function render() {
    renderCatalog();
    const choices = state.windows.map(item =>
      '<option value="' + escape(item.id) + '"' + (state.selected === item.id ? ' selected' : '') + '>' +
      escape(item.title) + ' · ' + escape(item.process || 'Application') + '</option>').join('');
    const signature = choices + '|' + state.selected;
    if (picker.dataset.signature !== signature) {
      picker.innerHTML = state.windows.length ? choices : '<option value="">No available windows</option>';
      picker.dataset.signature = signature;
      picker.value = state.windows.some(item => item.id === state.selected) ? state.selected : state.windows[0]?.id || '';
    }
    picker.disabled = !send || state.busy || !state.windows.length;
    for (const button of mount.querySelectorAll('[data-native-app]')) {
      const action = button.dataset.nativeApp;
      button.disabled = !send || state.busy || button.dataset.nativeBlocked==='true' || (['toggle-pin','pin-earlier','pin-later','arrange-pins'].includes(action)&&(!state.pinsLoaded||state.pinSaving||state.pinUncertain)) || (action === 'catalog-refresh'&&(state.catalogLoading||state.pinsLoading||state.pinSaving)) || (action === 'attach' && !state.windows.length) || (['focus','menu-close','close-app'].includes(action) && !state.attached);
    }
    stage.dataset.embedded = String(state.attached);
    $('#native-app-placeholder').hidden = state.attached||state.launcherOpen;
    const intent=launchIntents.get(state.launchRequestId),recovery=$('#native-app-launch-recovery');
    if(recovery)recovery.hidden=!intent||!['failed','uncertain'].includes(intent.phase);
    const recover=mount.querySelector('[data-native-app="recover-launch"]');if(recover){recover.textContent=intent?.canRecover?'Retry loading':'Check loading';recover.disabled=!send||state.busy||intent?.reading===true;}
    const placeholder=$('#native-app-placeholder'),placeholderTitle=placeholder?.querySelector?.('strong'),placeholderText=placeholder?.querySelector?.('p');
    if(placeholderTitle)placeholderTitle.textContent=intent?.pending?intent.message:'Open a pinned app or search for an application.';
    if(placeholderText)placeholderText.textContent=intent?.pending?'The application is starting. You can keep using BLACKICE while its window loads.':'Your apps keep their familiar menus, controls and documents.';
    const notice = $('#native-app-notice');
    notice.textContent = state.error || state.message || (!send
      ? 'Native application hosting requires the BLACKICE Windows desktop app.'
      : state.attached
        ? 'This application and its dialogs are contained in BLACKICE. Windows handles its familiar controls.'
        : 'Choose an application to open it here.');
    notice.classList.toggle('error', !!state.error);
    $('#native-app-selected').textContent = state.attached ? 'Loaded: ' + (state.title || 'Application') : 'No loaded application';
    $('#native-app-dialogs').textContent = state.dialogs.length ? state.dialogs.length + ' application dialog(s)' : '';
  }
  function bounds() {
    const rect = stage.getBoundingClientRect?.();
    if (!rect) return null;
    const viewport = { width: view?.innerWidth || 0, height: view?.innerHeight || 0 };
    // Fit the app to the remaining viewport, including short desktop windows.
    stage.style?.setProperty('--native-stage-height', Math.max(100, Math.min(680, viewport.height - rect.top - 42)) + 'px');
    return nativePanelBounds(stage.getBoundingClientRect(), viewport, scale());
  }
  async function revealBounds() {
    const launchOptions=mount.querySelector('.native-app-launch-options');
    if(launchOptions?.open)launchOptions.open=false;
    let area = bounds();
    if (area) return area;
    // Only an explicit Open/Embed action scrolls the panel. Passive updates
    // continue to hide windows whose stage has scrolled out of view.
    stage.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise(resolve => {
      if (view?.requestAnimationFrame) view.requestAnimationFrame(resolve);
      else setTimeout(resolve, 0);
    });
    area = bounds();
    if (!area) throw Error('The application panel needs more visible space before loading a window.');
    return area;
  }
  async function setLauncher(open,{focus=true}={}) {
    state.launcherOpen=open;if(open)state.menuMode='apps';render();
    if(open){
      if(send){await send({action:'hide'});state.visible=false;}
      if(focus&&state.active&&isVisible())$('#native-app-search')?.focus?.({preventScroll:true});
    }else if(state.active&&isVisible()&&state.attached){state.lastBounds='';await syncPosition();}
  }
  async function loadApps(refresh=false) {
    if(!send||state.catalogLoading)return;
    state.catalogLoading=true;state.catalogError='';render();
    try{const result=await send({action:'apps',...(refresh?{refresh:true}:{})});state.apps=normalizeApps(result?.apps);state.catalogLoaded=true;if(refresh){iconRequested.clear();iconQueue.clear();}}
    catch(error){state.catalogError=error.message||'Installed applications could not be read. Try refreshing.';}
    finally{state.catalogLoading=false;render();}
  }
  async function loadPins() {
    if(!send||state.pinsLoading||state.pinSaving)return;
    state.pinsLoading=true;state.pinError='';render();
    try{
      const result=await send({action:'pins'});
      if(!Array.isArray(result?.appIds))throw Error('Pinned apps could not be loaded. Refresh to try again.');
      state.pinIds=normalizePins(result.appIds);state.pinsLoaded=true;state.pinUncertain=false;
    }catch(error){state.pinError=error.message||'Pinned apps could not be loaded. Refresh to try again.';}
    finally{state.pinsLoading=false;render();}
  }
  async function savePins(appIds) {
    if(!send||!state.pinsLoaded||state.pinSaving||state.pinUncertain)return;
    state.pinSaving=true;state.pinError='';render();
    try{
      const result=await send({action:'set-pins',appIds:normalizePins(appIds)});
      if(!Array.isArray(result?.appIds))throw Error('Pinned apps were not confirmed. Refresh before trying again.');
      state.pinIds=normalizePins(result.appIds);
    }catch(error){
      state.pinError=error.message||'The pin change could not be confirmed.';
      // A lost reply may follow a successful write. Read back; never replay it.
      try{
        const current=await send({action:'pins'});
        if(!Array.isArray(current?.appIds))throw Error('Missing pin snapshot.');
        state.pinIds=normalizePins(current.appIds);state.pinUncertain=false;
      }catch{state.pinUncertain=true;state.pinError+=' Refresh to reload the saved pins before changing them again.';}
    }
    finally{state.pinSaving=false;render();}
  }
  async function syncPosition() {
    if (!send || !state.attached || !state.active || !isVisible()) return;
    if(state.launcherOpen){if(state.visible){await send({action:'hide'});state.visible=false;}return;}
    const area = bounds();
    if (!area) {
      if (state.visible) { state.visible = false; await send({ action: 'hide' }); }
      return;
    }
    const key = JSON.stringify(area);
    if (key !== state.lastBounds) {
      await send({ action: 'position', bounds: area });
      state.lastBounds = key;
    }
    if(!state.active||!isVisible()||state.launcherOpen){await send({action:'hide'});state.visible=false;return;}
    if (!state.visible) { await send({ action: 'show' }); state.visible = true; }
  }
  function schedulePosition() {
    if (!state.attached || !state.active || state.positionPending) return;
    state.positionPending = true;
    const requestFrame = view?.requestAnimationFrame?.bind(view) || (fn => setTimeout(fn, 16));
    requestFrame(() => { state.positionPending = false; void syncPosition().catch(report); });
  }
  async function refresh({ preserveError = false } = {}) {
    if (!send || state.busy) return;
    state.busy = true; if (!preserveError) state.error = ''; render();
    try {
      const [list, status] = await Promise.all([send({ action: 'windows' }), send({ action: 'status' })]);
      state.windows = normalizeWindows(list?.windows);
      state.attached = embedded(status);
      state.visible = status?.visible === true;
      state.id = status?.windowId || ''; state.title = status?.title || '';
      state.mode = status?.mode || 'native_window';
      if (!state.windows.some(item => item.id === state.selected)) state.selected = state.windows[0]?.id || '';
      if (state.attached) { state.lastBounds = ''; await syncPosition(); }
      if(state.launchRequestId)await recoverLaunch(state.launchRequestId);
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; render(); }
  }
  function readLaunchReply(intent,value) {
    if(!value||typeof value!=='object')throw Error('The application status could not be read.');
    const record=value.launchReceipt||(value.result&&value.requestId?value:null),result=record?.result||value,current=value.current||record?.current;
    if((record?.requestId||value.requestId)&&String(record?.requestId||value.requestId)!==intent.requestId)throw Error('The application status belongs to another opening request.');
    const uncertain=record?.state==='uncertain'||value.state==='uncertain'||value.currentStatusUnavailable===true||record?.currentStatusUnavailable===true;
    const verified=result.attached===true&&result.embedded===true&&(!current||current.attached===true&&current.embedded===true&&current.windowId===result.windowId);
    const phase=record?.phase||value.phase||(verified?'embedded':result.pending===true||result.launched===true?'pending':result.cancelled?'cancelled':'failed');
    intent.phase=uncertain?'uncertain':phase==='embedded'&&!verified?'failed':phase;
    intent.pending=['launching','loading','pending','uncertain'].includes(intent.phase);
    intent.canRecover=!uncertain&&intent.phase==='failed'&&Boolean(result.launched||result.windowId);
    intent.receipt=record||value;
    intent.message=intent.phase==='embedded'?intent.label+' is loaded.':intent.phase==='cancelled'?'No application selected.':intent.phase==='launching'?'Opening '+intent.label+'…':intent.pending&&!uncertain?'Loading '+intent.label+' into BLACKICE…':uncertain?'The opening status is uncertain. Check loading or inspect running windows before opening another copy.':result.reason||record?.reason||'The application opened, but its window could not be loaded.';
    if(state.launchRequestId!==intent.requestId)return;
    state.message=intent.message;state.error='';
    if(current){state.attached=current.attached===true&&current.embedded===true;state.visible=state.attached&&current.visible===true;state.id=current.windowId||'';state.title=current.title||'';state.mode=current.mode||'native_window';}
    else if(verified){state.attached=true;state.visible=result.visible===true;state.id=result.windowId||'';state.title=result.title||intent.label;state.mode=result.mode||'native_window';}
    if(result.windowId)state.selected=result.windowId;
    render();schedulePosition();
  }
  async function recoverLaunch(requestId,{retry=false}={}) {
    const intent=launchIntents.get(requestId);if(!send||!intent||intent.reading||destroyed)return;
    intent.reading=true;
    if(retry){intent.phase='loading';intent.pending=true;intent.canRecover=false;intent.message='Loading '+intent.label+' into BLACKICE…';state.launcherOpen=false;state.message=intent.message;state.error='';render();}
    try{
      if(retry)await revealBounds();
      const value=await send({action:'receipt',requestId,...(retry?{recover:true}:{})});
      if(destroyed)return;readLaunchReply(intent,value);
      if(state.launchRequestId===requestId&&state.attached&&(!state.active||!isVisible()||state.launcherOpen)){await send({action:'hide'});state.visible=false;}
    }catch(error){
      intent.phase='uncertain';intent.pending=true;intent.canRecover=false;
      intent.message='The opening status is uncertain. Check loading or inspect running windows before opening another copy.';
      intent.lastError=String(error.message||error);
      if(state.launchRequestId===requestId){state.message=intent.message;state.error=intent.message;}
    }finally{intent.reading=false;if(!destroyed)render();}
  }
  async function launchApplication(name,appId) {
    if(name==='launch-installed'&&!state.apps.some(app=>app.id===appId))throw Error('Refresh the application menu and choose an installed application.');
    const executable=name==='launch-path'?String($('#native-app-executable')?.value||'').trim().replace(/^"(.+)"$/,'$1'):'';
    if(name==='launch-path'&&!executable)throw Error('Enter the application executable path.');
    const args=name==='launch-installed'?[]:String($('#native-app-arguments')?.value||'').split(/\r?\n/).filter(value=>value.length>0);
    const input=name==='launch-installed'?{appId}:executable?{executable,args}:{args},signature=JSON.stringify(input);
    const previous=[...launchIntents.values()].reverse().find(intent=>intent.signature===signature&&intent.phase!=='embedded'&&intent.phase!=='cancelled');
    if(previous){state.launchRequestId=previous.requestId;state.message=previous.message;state.launcherOpen=false;state.lastBounds='';render();return recoverLaunch(previous.requestId,{retry:previous.canRecover});}
    const requestId='ui_'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
    const label=name==='launch-installed'?state.apps.find(app=>app.id===appId).name:executable.split(/[\\/]/).at(-1)||'application';
    const intent={requestId,signature,label,phase:'launching',pending:true,canRecover:false,reading:false,message:'Opening '+label+'…'};
    launchIntents.set(requestId,intent);state.launchRequestId=requestId;state.message=intent.message;state.error='';state.launcherOpen=false;render();
    try{
      const area=await revealBounds();
      if(!state.active||!isVisible())throw Error('The Applications view changed before opening the application.');
      intent.dispatched=true;
      const result=await send({action:'launch',...input,bounds:area,requestId});
      if(destroyed)return;readLaunchReply(intent,result);
      if(state.launchRequestId===requestId&&state.attached&&(!state.active||!isVisible()||state.launcherOpen)){await send({action:'hide'});state.visible=false;}
    }catch(error){
      if(intent.dispatched){intent.phase='uncertain';intent.pending=true;if(state.launchRequestId===requestId){state.message='Checking '+label+' after an interrupted reply…';render();}await recoverLaunch(requestId);}
      else{launchIntents.delete(requestId);if(state.launchRequestId===requestId){state.launchRequestId='';state.error=error.message;state.message='';state.launcherOpen=true;render();}}
    }
    if(!destroyed&&state.launchRequestId===requestId)await refresh({preserveError:true});
  }
  async function action(name,appId) {
    if (!send || state.busy) return;
    if (name === 'refresh') return refresh();
    if(name==='menu')return setLauncher(!state.launcherOpen).catch(report);
    if(name==='menu-close')return setLauncher(false).catch(report);
    if(name==='catalog-refresh')return Promise.all([loadApps(true),loadPins()]);
    if(name==='more-apps'){state.appLimit+=80;render();return;}
    if(name==='pinned-view'||name==='all-apps'){
      state.query='';state.allApps=name==='all-apps';state.arranging=false;state.menuMode='apps';state.appLimit=80;
      $('#native-app-search').value='';render();return;
    }
    if(name==='arrange-pins'){state.arranging=!state.arranging;render();return;}
    if(name==='toggle-pin'){
      const pinned=state.pinIds.includes(appId);
      if(!pinned&&!state.apps.some(app=>app.id===appId))return;
      return savePins(pinned?state.pinIds.filter(id=>id!==appId):[...state.pinIds,appId]);
    }
    if(name==='pin-earlier'||name==='pin-later'){
      const ids=[...state.pinIds],index=ids.indexOf(appId),destination=index+(name==='pin-earlier'?-1:1);
      if(index<0||destination<0||destination>=ids.length)return;
      [ids[index],ids[destination]]=[ids[destination],ids[index]];return savePins(ids);
    }
    if(name==='running'){state.menuMode=state.menuMode==='running'?'apps':'running';state.arranging=false;render();return refresh();}
    if(name==='recover-launch')return recoverLaunch(state.launchRequestId,{retry:launchIntents.get(state.launchRequestId)?.canRecover===true});
    if(['launch','launch-path','launch-installed'].includes(name))return launchApplication(name,appId).catch(report);
    state.busy = true; state.error = ''; state.message = ''; render();
    try {
      if (name === 'attach') {
        const id = picker.value;
        if (!id) throw Error('Choose an application window.');
        state.launcherOpen=false;render();const area = await revealBounds();
        const result = await send({ action: 'attach', windowId: id, bounds: area });
        state.attached = embedded(result); state.visible = state.attached&&result?.visible === true;
        state.id = result?.windowId || id; state.title = result?.title || state.windows.find(item => item.id === id)?.title || '';
        state.mode = result?.mode || 'native_window';
        state.lastBounds = JSON.stringify(area);
      } else if (name === 'focus') {
        state.launcherOpen=false;render();await syncPosition();
        await send({ action: 'focus' });
      } else if (name === 'close-app') {
        const result = await send({ action: 'close-app' });
        state.attached = embedded(result); state.visible = state.attached && result?.visible === true;
        state.id = result?.windowId || ''; state.title = result?.title || '';
        state.closingApp = result?.sessionActive === true;
        state.message = state.closingApp ? 'Close requested. Complete any save or cancel prompt in the embedded application.' : 'Application closed.';
        if (!state.closingApp) { state.launcherOpen = true; state.launchRequestId = ''; state.lastBounds = ''; }
      }
    } catch (error) {
      state.error = error.message;
      if(!state.attached)state.launcherOpen=true;
      // Native failure can release the old window before Windows rejects its
      // replacement. Read the actual host instead of retaining a phantom app.
      try {
        const status = await send({ action: 'status' });
        state.attached = embedded(status); state.visible = state.attached&&status?.visible === true;
        state.id = status?.windowId || ''; state.title = status?.title || ''; state.mode = status?.mode || 'native_window';
      } catch {}
    }
    finally { state.busy = false; render(); }
  }
  const click = event => {
    const button = event.target.closest?.('[data-native-app]');
    if (button && !button.disabled) void action(button.dataset.nativeApp,button.dataset.appId);
  };
  const change = event => { if (event.target === picker) state.selected = picker.value; };
  const input=event=>{if(event.target===$('#native-app-search')){state.query=event.target.value;state.allApps=false;state.arranging=false;state.appLimit=80;state.menuMode='apps';render();}};
  const keydown=event=>{
    if(!state.launcherOpen)return;
    if(event.key==='Escape'&&(state.query||state.allApps||state.menuMode==='running')){event.preventDefault();state.query='';state.allApps=false;state.menuMode='apps';state.arranging=false;$('#native-app-search').value='';render();$('#native-app-search')?.focus?.({preventScroll:true});return;}
    if(event.key==='Escape'&&state.attached){event.preventDefault();void setLauncher(false).then(()=>mount.querySelector('[data-native-app="menu"]')?.focus?.()).catch(report);return;}
    const items=[...(mount.querySelectorAll('#native-app-catalog [data-native-app="launch-installed"]')||[])].filter(button=>!button.disabled);
    if(event.target===$('#native-app-search')&&(event.key==='ArrowDown'||event.key==='Enter')){
      if(items[0]){event.preventDefault();event.key==='Enter'?items[0].click?.():items[0].focus?.();}return;
    }
    const index=items.indexOf(event.target);
    if(index>=0&&['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','Home','End'].includes(event.key)){
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+items.length)%items.length;items[next]?.focus?.();
    }
  };
  const imageError=event=>{
    const target=event.target;
    if(target?.tagName!=='IMG'||!target.classList?.contains?.('native-app-icon'))return;
    const id=target.closest?.('[data-app-id]')?.dataset.appId,app=state.apps.find(item=>item.id===id);
    if(app)delete app.icon;
    target.outerHTML='<span class="native-app-icon native-app-icon-fallback" aria-hidden="true">'+escape(app?.name?.trim().slice(0,1).toUpperCase()||'▦')+'</span>';
  };
  const resize = () => {if(state.active&&isVisible())bounds();schedulePosition();};
  mount.addEventListener('click', click); mount.addEventListener('change', change);mount.addEventListener('input',input);mount.addEventListener('keydown',keydown);mount.addEventListener('error',imageError,true);
  view?.addEventListener?.('resize', resize);
  view?.addEventListener?.('scroll', resize, true);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(stage);
  async function enter() {
    state.active = true;
    if (!send) { render(); return; }
    try {
      const status = await send({ action: 'status' });
      if (!state.active) return;
      state.attached = embedded(status); state.visible = state.attached&&status?.visible === true;
      state.id = status?.windowId || ''; state.title = status?.title || '';
      state.mode = status?.mode || 'native_window';
      if(!state.initialized){state.launcherOpen=!state.attached;state.initialized=true;}
      else if(!state.attached)state.launcherOpen=true;
      if (state.attached) { state.lastBounds = ''; await syncPosition(); }
    } catch (error) { report(error); }
    if (!state.active) return;
    await refresh();
    if (!state.active) return;
    void Promise.all([loadApps(),loadPins()]);bounds();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!state.active || !isVisible() || state.busy || state.polling) return;
      state.polling=true;
      void send({action:'status'}).then(async status=>{
        if(!state.active||!isVisible())return;
        state.attached=embedded(status);state.visible=state.attached&&status?.visible===true;
        if(state.closingApp&&status?.sessionActive!==true){state.closingApp=false;state.launcherOpen=true;state.launchRequestId='';state.lastBounds='';state.message='Application closed.';}
        state.id=status?.windowId||'';state.title=status?.title||'';state.mode=status?.mode||'native_window';
        state.dialogs=state.attached?normalizeWindows((await send({action:'dialogs'}))?.dialogs):[];
        if(state.launchRequestId)await recoverLaunch(state.launchRequestId);
        render();schedulePosition();
      }).catch(error=>{if(state.active)report(error);}).finally(()=>{state.polling=false;});
    }, 1600);
  }
  function leave() {
    state.active = false; clearInterval(state.timer); state.timer = null;
    if (state.attached && state.visible && send) {
      state.visible = false;
      void send({ action: 'hide' }).catch(report);
    }
  }
  function update() { if (state.active && isVisible()) schedulePosition(); }
  async function prepareSurface() {
    if (!state.active || !isVisible()) throw Error('The Applications view is not visible.');
    state.launcherOpen=false;render();
    const area=await revealBounds();
    if (!state.active || !isVisible()) throw Error('The Applications view changed before it was ready.');
    return {surface:'applications',visible:true,bounds:area,observedAt:new Date().toISOString()};
  }
  function observeSurface() {
    const area=state.active&&isVisible()&&!state.launcherOpen?bounds():null;
    return {surface:'applications',visible:!!area,...(area?{bounds:area}:{}),observedAt:new Date().toISOString()};
  }
  function destroy() {
    destroyed=true;iconObserver?.disconnect();iconQueue.clear();leave(); observer?.disconnect(); mount.removeEventListener('click', click);
    mount.removeEventListener('change', change);
    mount.removeEventListener('input',input);mount.removeEventListener('keydown',keydown);mount.removeEventListener('error',imageError,true);
    view?.removeEventListener?.('resize', resize);
    view?.removeEventListener?.('scroll', resize, true);
    mount.innerHTML = '';
  }
  render();
  return { enter, leave, update, refresh, destroy, prepareSurface, observeSurface, getState: () => ({ ...state,pinIds:[...state.pinIds],launch:launchIntents.get(state.launchRequestId)?{...launchIntents.get(state.launchRequestId)}:null }) };
}
