import { text } from '../core/dom.mjs';
import { normalizeBrowserAddress } from '../../browser-address.mjs';
import { browserFrame, pagePoint, browserInputGuard, wheelPixels, pendingDialog } from './browser-model.mjs';
import { createNativeBrowserWorkspace } from './browser-native.mjs';

/** Interactive, contained Chromium surface. This is a native-browser capture,
 * not a copied webpage, iframe, or a separate foreground browser window.
 * All page input is tied to one observed URL + document identity.
 */
export function createBrowserWorkspace(options) {
  if(typeof globalThis.window?.relayDesktop?.browserSurface==='function')return createNativeBrowserWorkspace(options);
  const {mount,api,events,notify}=options;
  mount.innerHTML=[
    '<div class="next-panel next-browser-layout"><div class="next-panel-inner next-browser-workspace">',
    '<header class="next-panel-head"><div><h1>Browser</h1><p>Contained native Chromium pages · no external browser window</p></div>',
    '<button type="button" id="next-browser-refresh">Refresh tabs</button></header>',
    '<div class="next-browser-navigation" id="next-browser-navigation" aria-label="Browser navigation">',
    '<div class="next-browser-tabs" id="next-browser-tabs" role="tablist" aria-label="Contained tabs"></div>',
    '<form id="next-browser-form" class="next-row next-browser-address" role="search">',
    '<button type="button" id="next-browser-back" aria-label="Back" title="Back">←</button>',
    '<button type="button" id="next-browser-forward" aria-label="Forward" title="Forward">→</button>',
    '<button type="button" id="next-browser-reload" aria-label="Reload page" title="Reload page">↻</button>',
    '<input class="next-field" type="text" id="next-browser-url" autocomplete="url" spellcheck="false" inputmode="url" aria-label="Website address" placeholder="Search or enter a website address">',
    '<button type="submit" class="next-primary">Go</button><button type="button" id="next-browser-new" aria-label="New tab" title="New tab (Ctrl+T)">+ Tab</button></form>',
    '</div>',
    '<div class="next-row next-browser-actions">',
    '<button type="button" id="next-browser-inspect">Read page</button>',
    '<button type="button" id="next-browser-shot" class="next-primary">Refresh view</button>',
    '<button type="button" id="next-browser-close">Close tab</button>',
    '<label class="next-browser-auto-label"><input type="checkbox" id="next-browser-auto"> Live preview</label></div>',
    '<p class="next-help" id="next-browser-status" role="status" aria-live="polite">Choose a contained page.</p>',
    '<section class="next-browser-dialog" id="next-browser-interaction" hidden aria-live="polite"></section>',
    '<div class="next-browser-visual" id="next-browser-preview">',
    '<div class="next-browser-no-frame">Open or select a page to view it inside BLACKICE.</div></div>',
    '<form class="next-row next-browser-input" id="next-browser-type-form">',
    '<label class="next-label">Type into page<input class="next-field" id="next-browser-type" maxlength="16384" autocomplete="off" placeholder="Text for selected browser field"></label>',
    '<button type="submit" id="next-browser-type-send">Type</button>',
    '<label class="next-label">Page key<select class="next-field" id="next-browser-key">',
    '<option>Enter</option><option>Tab</option><option>Escape</option><option>Backspace</option>',
    '<option>ArrowUp</option><option>ArrowDown</option><option>ArrowLeft</option><option>ArrowRight</option><option>Space</option>',
    '</select></label><button type="button" id="next-browser-key-send">Send key</button></form>',
    '<details class="next-card next-browser-text-panel"><summary>Page text and controls</summary>',
    '<pre id="next-browser-readout">Read the page to inspect its text and controls.</pre></details>',
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id),ui={
    tabs:$('next-browser-tabs'),status:$('next-browser-status'),preview:$('next-browser-preview'),
    url:$('next-browser-url'),inspect:$('next-browser-inspect'),shot:$('next-browser-shot'),
    close:$('next-browser-close'),refresh:$('next-browser-refresh'),newTab:$('next-browser-new'),
    back:$('next-browser-back'),forward:$('next-browser-forward'),reload:$('next-browser-reload'),
    form:$('next-browser-form'),typeForm:$('next-browser-type-form'),
    typeInput:$('next-browser-type'),typeSend:$('next-browser-type-send'),
    key:$('next-browser-key'),keySend:$('next-browser-key-send'),
    auto:$('next-browser-auto'),dialog:$('next-browser-interaction'),readout:$('next-browser-readout'),
  };
  let active=false,destroyed=false,selected=null,tabs=[],frame=null,busy=false,sequence=0,lifecycle=0,
    openIntent=null,preferredSelection=null,preferBackend=false,needCapture=false,
    unsubscribe=null,pollTimer=null,wheelTimer=null,wheelQueue=null,watch=false,pending=null;
  const addressDrafts=new Map(),emptyDraft={value:'',dirty:false,revision:0};
  const current=()=>tabs.find(item=>item.tabId===selected)||null;
  const displayAddress=url=>url==='about:blank'?'':url||'';
  const tabTitle=tab=>tab.url==='about:blank'?'New tab':tab.title||tab.url||'Page';
  function addressDraft(tabId=selected){
    if(!tabId)return emptyDraft;
    if(!addressDrafts.has(tabId))addressDrafts.set(tabId,{value:displayAddress(tabs.find(tab=>tab.tabId===tabId)?.url),dirty:false,revision:0});
    return addressDrafts.get(tabId);
  }
  const editingAddress=()=>openIntent&&!openIntent.failed?openIntent.address:addressDraft();
  function paintAddress(){
    const draft=editingAddress();
    if(!draft.dirty&&(!openIntent||openIntent.failed))draft.value=displayAddress(current()?.url);
    ui.url.value=draft.value;
  }
  const selectedSnapshot=()=>selected&&frame?.tabId===selected&&frame?.url===current()?.url?frame:null;
  const awaitingDialog=()=>pending?.status==='pending';
  const notice=(message,error=false)=>{
    if(!active)return;
    ui.status.textContent=String(message||'');
    ui.status.dataset.error=String(error);
    if(error)notify?.(message,true);
  };
  function renderTabs() {
    const fragment=ui.tabs.ownerDocument.createDocumentFragment();
    if(!tabs.length)text(fragment,'No contained pages yet.','p','next-help');
    for(const tab of tabs){
      const group=text(fragment,'','div','next-browser-tab-group');
      const button=text(group,tabTitle(tab),'button');
      button.type='button';button.dataset.tabId=tab.tabId;button.className='next-browser-tab';
      button.setAttribute('role','tab');button.setAttribute('aria-selected',String(tab.tabId===selected));
      if(tab.tabId===selected)button.classList.add('next-primary');
      button.disabled=busy;
      button.title=tab.url||tab.title||'Contained page';
      button.addEventListener('click',()=>{
        if(busy)return;
        select(tab.tabId);
      });
      const close=text(group,'×','button','next-browser-tab-close');
      close.type='button';close.disabled=busy;close.title='Close tab';close.dataset.closeTab=tab.tabId;
      close.setAttribute('aria-label','Close '+tabTitle(tab));
      close.addEventListener('click',()=>{if(!busy)void operate('close',{tabId:tab.tabId});});
    }
    ui.tabs.replaceChildren(fragment);
  }
  function renderDialog(){
    ui.dialog.replaceChildren();
    const interaction=pending;
    if(!interaction){ui.dialog.hidden=true;return;}
    ui.dialog.hidden=false;
    const heading=text(ui.dialog,'Browser interaction','h3');
    const message=text(ui.dialog,interaction.message||'The page needs a decision.','p','next-help');
    if(interaction.kind==='javascript_dialog')heading.textContent='Browser '+interaction.dialogType;
    if(interaction.kind==='file_chooser')heading.textContent='Choose files for this page';
    if(interaction.status==='blocked'){
      heading.textContent='Browser notice';
      return;
    }
    const controls=text(ui.dialog,'','div','next-row');
    let promptInput=null;
    if(interaction.kind==='javascript_dialog'&&interaction.dialogType==='prompt'&&interaction.status==='pending') {
      promptInput=text(ui.dialog,'','input','next-field');
      promptInput.value=interaction.defaultPrompt||'';
      promptInput.type='text';promptInput.maxLength=4096;
      promptInput.setAttribute('aria-label','Response to browser prompt');
    }
    const add=(label,decision)=>{
      const button=text(controls,label,'button');
      button.type='button';button.disabled=busy;
      button.addEventListener('click',()=>void decide(interaction,decision,promptInput?.value));
    };
    if(interaction.kind==='file_chooser'){add('Choose files…','upload');add('Dismiss','dismiss');}
    else if(interaction.kind==='javascript_dialog'){add('Accept','accept');add('Dismiss','dismiss');}
    // Dialog messages are always textContent; websites cannot inject controls.
    void message;
  }
  function showFrame(value){
    ui.preview.replaceChildren();
    const actual=value&&selectedSnapshot();
    if(!actual){
      text(ui.preview,selected?'Refresh the view to interact with the selected page.':'Open a contained page to begin.','div','next-browser-no-frame');
      return;
    }
    const button=text(ui.preview,'','button','next-browser-page');
    button.type='button';button.setAttribute('aria-label','Contained website. Click a field on this page to interact.');
    button.disabled=busy||awaitingDialog();
    const img=button.ownerDocument.createElement('img');
    img.id='next-browser-image';img.src=actual.imageUrl;img.alt='Contained browser page, captured by BLACKICE';
    img.width=actual.width;img.height=actual.height;img.draggable=false;button.append(img);
    button.addEventListener('click',event=>{
      if(busy||awaitingDialog())return;
      const point=pagePoint(actual,event,img.getBoundingClientRect());
      if(point)void operate('click',point);
    });
  }
  function render(){
    if(!active||destroyed)return;
    renderTabs();
    const tab=current(),ready=Boolean(tab),hasFrame=Boolean(selectedSnapshot());
    for(const button of [ui.inspect,ui.shot,ui.close])button.disabled=busy||!ready;
    for(const button of [ui.typeSend,ui.keySend])button.disabled=busy||!hasFrame||awaitingDialog();
    ui.typeInput.disabled=busy||!hasFrame||awaitingDialog();
    ui.newTab.disabled=busy;
    for(const button of [ui.back,ui.forward,ui.reload])button.disabled=busy||!ready;
    ui.auto.disabled=busy&&!watch;
    const image=ui.preview.querySelector('.next-browser-page');
    if(image)image.disabled=busy||awaitingDialog();
    if(!frame||frame.tabId!==selected)showFrame(null);
    renderDialog();
    if(!busy&&!awaitingDialog()&&ui.status.dataset.error!=='true')ui.status.textContent=
      ready?'Page: '+(tab.url||tab.title||'Contained tab'):'Choose a contained page.';
  }
  function select(tabId){
    if(!active||busy||destroyed)return;
    if(openIntent?.failed&&!openIntent.existing.has(tabId))addressDrafts.set(tabId,openIntent.address);
    openIntent=null;preferredSelection=tabId;
    selected=tabId;frame=null;pending=null;wheelQueue=null;
    clearTimeout(wheelTimer);wheelTimer=null;sequence++;
    ui.readout.textContent='Read the page to inspect its text and controls.';
    ui.preview.replaceChildren();
    paintAddress();render();void operate('tab_select',{tabId});
  }
  const containedTabs=data=>(Array.isArray(data.tabs)?data.tabs:[]).filter(item=>
    item?.browser==='relay'&&item.visible===false&&typeof item.tabId==='string'&&item.tabId.length<=200);
  function applyStatus(data){
    const old=selected;tabs=containedTabs(data);
    const backend=[data.activeTab,data.browsers?.relay?.activeTab].find(id=>tabs.some(tab=>tab.tabId===id));
    const valid=id=>tabs.some(tab=>tab.tabId===id);
    selected=[preferredSelection,preferBackend?backend:null,selected,backend,tabs[0]?.tabId].find(valid)||null;
    preferBackend=false;
    if(preferredSelection===backend)preferredSelection=null;
    if(openIntent?.failed&&selected&&!openIntent.existing.has(selected)){
      addressDrafts.set(selected,openIntent.address);openIntent=null;
    }
    if(old!==selected||frame?.url!==current()?.url){
      frame=null;pending=null;wheelQueue=null;clearTimeout(wheelTimer);wheelTimer=null;
      ui.preview.replaceChildren();
    }
    pending=pendingDialog(current()?.pendingInteraction,selected)||pending;
    if(!current())pending=null;
    paintAddress();render();
  }
  async function refresh({capture=false}={}){
    if(!active||destroyed)return;
    const generation=++sequence;
    try{
      const data=await api('/api/browser/status?view=contained');
      if(!active||destroyed||generation!==sequence)return;
      applyStatus(data);
      if(capture&&selected){if(busy)needCapture=true;else void screenshot();}
    }catch(error){if(active&&generation===sequence)notice(error.message,true);}
  }
  async function screenshot({preview=false}={}){
    if(!active||destroyed||busy||!selected)return;
    const tabId=selected,oldFrame=selectedSnapshot(),session=lifecycle;
    busy=true;render();
    try{
      const payload={action:'screenshot',browser:'relay',tabId,
        ...(preview&&oldFrame?{...browserInputGuard(oldFrame,tabId),preview:true}:{})};
      const result=await api('/api/browser/action','POST',payload,{deadlineMs:20000});
      if(!active||destroyed||session!==lifecycle||selected!==tabId)return;
      const incoming=browserFrame(result,tabId);
      if(!incoming)throw Error('The selected browser page returned an invalid screenshot.');
      frame=incoming;pending=pendingDialog(result.pendingInteraction,tabId)||null;
      ui.status.dataset.error='false';
      notice('Page ready · '+incoming.width+' × '+incoming.height+' · click or scroll inside BLACKICE.');
    }catch(error){if(active&&!destroyed&&session===lifecycle&&selected===tabId){frame=null;notice('Browser screenshot unavailable: '+error.message,true);}}
    finally{busy=false;if(active&&!destroyed){showFrame(frame);render();if(needCapture&&selected){needCapture=false;void screenshot();}}}
  }
  async function operate(action,extra={},intent={}){
    if(!active||destroyed||busy)return;
    const tabId=extra.tabId||selected;
    if(action!=='open'&&!tabId)return;
    if(['click','scroll','type','press','interaction','upload'].includes(action)&&!selectedSnapshot())
      return notice('Refresh the exact contained page before sending input.',true);
    const submission=intent.submission,session=lifecycle;
    if(action==='open'){
      openIntent={address:intent.blank?{value:'',dirty:false,revision:0}:submission?.draft||{value:ui.url.value,dirty:true,revision:0},existing:new Set(tabs.map(tab=>tab.tabId)),failed:false};
      paintAddress();ui.url.focus({preventScroll:true});
    }
    const opening=action==='open'?openIntent:null;
    sequence++;needCapture=false;busy=true;render();let succeeded=false;
    try{
      const guard=['click','scroll','type','press','interaction','upload'].includes(action)
        ?browserInputGuard(selectedSnapshot(),tabId):{};
      const result=await api('/api/browser/action','POST',{action,browser:'relay',
        ...(action==='open'?{}:{tabId}),...guard,...extra},{deadlineMs:25000});
      if(destroyed)return;
      if(action==='open'){
        if(typeof result?.tabId!=='string'||!result.tabId)throw Error('The browser did not confirm a new tab. Refresh tabs to inspect the saved pages.');
        selected=result.tabId;preferredSelection=selected;frame=null;pending=null;
        addressDrafts.set(selected,opening.address);openIntent=null;
      }
      if(action==='close'){
        addressDrafts.delete(tabId);tabs=tabs.filter(tab=>tab.tabId!==tabId);
        if(tabId===selected){frame=null;pending=null;selected=null;preferredSelection=null;preferBackend=true;}
      }
      if(submission&&submission.draft.revision===submission.revision){submission.draft.dirty=false;submission.draft.value=displayAddress(result?.url||extra.url);}
      if(action==='read'&&active&&session===lifecycle&&selected===tabId){
        const content=(Array.isArray(result.frames)?result.frames:[]).map(f=>
          [String(f.title||''),String(f.url||''),String(f.text||'')].filter(Boolean).join('\n')).join('\n\n');
        ui.readout.textContent=content||'No page text was returned.';
        ui.readout.closest('details')?.setAttribute('open','');
      }
      if(action==='interaction'||action==='upload')pending=null;
      const changed=['open','close','tab_select','navigate','back','forward','reload','click','scroll','type','press','interaction','upload'].includes(action);
      if(changed) {
        frame=null;if(active)ui.preview.replaceChildren();
        if(action==='type'&&active)ui.typeInput.value='';
      }
      if(result?.pendingInteraction)pending=pendingDialog(result.pendingInteraction,action==='open'?selected:tabId);
      succeeded=true;
      if(changed&&active){
        const generation=++sequence;
        const data=await api('/api/browser/status?view=contained');
        if(!active||destroyed||generation!==sequence)return;
        applyStatus(data);
      }
      if(active){ui.status.dataset.error='false';notice(action==='read'?'Page text updated.':'Browser action completed. Refreshing the contained view…');}
    }catch(error){if(opening&&openIntent===opening)opening.failed=true;if(action==='tab_select')preferredSelection=null;if(active&&!destroyed){paintAddress();notice(error.message,true);}}
    finally{
      if(!succeeded)needCapture=false;
      busy=false;if(active&&!destroyed){showFrame(frame);render();
        if(selected&&((succeeded&&action!=='read')||needCapture)){needCapture=false;void screenshot();}}
    }
  }
  async function decide(interaction,decision,promptText) {
    if(!active||busy||!awaitingDialog()||pending.id!==interaction.id)return;
    if(decision==='upload'){
      const pick=globalThis.window?.relayDesktop?.pickFiles;
      if(typeof pick!=='function')return notice('Choose files from the BLACKICE Windows app.',true);
      try{
        const result=await pick();
        const paths=Array.isArray(result)?result:result?.filePaths||[];
        if(!paths.length)return;
        await operate('upload',{chooserId:interaction.id,paths});
      }catch(error){notice(error.message,true);}
      return;
    }
    await operate('interaction',{interactionId:interaction.id,decision,
      ...(decision==='accept'&&interaction.dialogType==='prompt'?{promptText:String(promptText||'').slice(0,4096)}:{})});
  }
  ui.form.addEventListener('submit',event=>{
    event.preventDefault();
    if(busy)return;
    let url;
    try{url=normalizeBrowserAddress(ui.url.value);}catch(error){return notice(error.message,true);}
    const draft=editingAddress(),submission={draft,revision:draft.revision};
    if(openIntent?.failed)openIntent=null;
    void operate(!selected?'open':'navigate',{url},{submission});
  });
  ui.url.addEventListener('input',()=>{const draft=editingAddress();draft.value=ui.url.value;draft.dirty=true;draft.revision++;});
  ui.newTab.addEventListener('click',()=>{
    void operate('open',{url:'about:blank'},{blank:true});
  });
  ui.back.addEventListener('click',()=>void operate('back'));
  ui.forward.addEventListener('click',()=>void operate('forward'));
  ui.reload.addEventListener('click',()=>void operate('reload'));
  ui.refresh.addEventListener('click',()=>void refresh({capture:true}));
  ui.inspect.addEventListener('click',()=>void operate('read'));
  ui.shot.addEventListener('click',()=>void screenshot());
  ui.close.addEventListener('click',()=>void operate('close'));
  ui.typeForm.addEventListener('submit',event=>{
    event.preventDefault();
    const value=ui.typeInput.value;
    if(value)void operate('type',{text:value});
  });
  ui.keySend.addEventListener('click',()=>void operate('press',{key:ui.key.value}));
  ui.auto.addEventListener('change',()=>{
    watch=ui.auto.checked;clearInterval(pollTimer);pollTimer=null;
    if(active&&watch)pollTimer=setInterval(()=>{if(active&&!busy&&selected)void screenshot({preview:true});},1800);
  });
  ui.preview.addEventListener('wheel',event=>{
    const img=ui.preview.querySelector('#next-browser-image');
    const currentFrame=selectedSnapshot();
    if(!img||!currentFrame||busy||awaitingDialog()||event.ctrlKey||event.metaKey)return;
    const point=pagePoint(currentFrame,event,img.getBoundingClientRect());
    const pixels=wheelPixels(event,currentFrame);
    if(!point||!pixels||!event.cancelable)return;
    event.preventDefault();
    const guardKey=currentFrame.tabId+'|'+currentFrame.documentId;
    if(wheelQueue?.key!==guardKey)wheelQueue={key:guardKey,point,deltaX:0,deltaY:0};
    wheelQueue.deltaX=Math.max(-2000,Math.min(2000,wheelQueue.deltaX+pixels.deltaX));
    wheelQueue.deltaY=Math.max(-2000,Math.min(2000,wheelQueue.deltaY+pixels.deltaY));
    clearTimeout(wheelTimer);
    wheelTimer=setTimeout(()=>{
      const pendingWheel=wheelQueue;wheelQueue=null;wheelTimer=null;
      if(pendingWheel&&(pendingWheel.deltaX||pendingWheel.deltaY))
        void operate('scroll',{...pendingWheel.point,deltaX:pendingWheel.deltaX,deltaY:pendingWheel.deltaY});
    },95);
  },{passive:false});
  const keydown=event=>{
    if(!active||mount.hidden||!event.ctrlKey||event.altKey||event.shiftKey)return;
    const key=event.key.toLowerCase();
    if(key==='l'){event.preventDefault();ui.url.focus({preventScroll:true});ui.url.select();}
    else if(key==='t'){event.preventDefault();ui.newTab.click();}
    else if(key==='r'){event.preventDefault();ui.reload.click();}
    else if(key==='w'&&selected){event.preventDefault();ui.close.click();}
  };
  mount.ownerDocument.addEventListener('keydown',keydown);
  let refreshTimer=null;
  const onEvent=event=>{
    if(!active||!event.type.startsWith('browser.'))return;
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{void refresh();},800);
  };
  return {
    enter(){if(active||destroyed)return;active=true;lifecycle++;preferBackend=true;unsubscribe=events.subscribe(onEvent);void refresh({capture:true});
      if(watch&&!pollTimer)pollTimer=setInterval(()=>{if(active&&!busy&&selected)void screenshot({preview:true});},1800);},
    leave(){active=false;lifecycle++;sequence++;needCapture=false;unsubscribe?.();unsubscribe=null;
      clearInterval(pollTimer);pollTimer=null;clearTimeout(refreshTimer);refreshTimer=null;
      clearTimeout(wheelTimer);wheelTimer=null;wheelQueue=null;frame=null;pending=null;
      ui.preview.replaceChildren();},
    destroy(){this.leave();destroyed=true;addressDrafts.clear();openIntent=null;mount.ownerDocument.removeEventListener('keydown',keydown);mount.innerHTML='';},
  };
}
