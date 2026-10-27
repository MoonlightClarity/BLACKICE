import {text,formatDate} from '../core/dom.mjs';

const KINDS=['soul','user'];
const LIMITS={soul:64000,user:96000};
const NAMES={soul:'SOUL.md',user:'USER.md'};
const HISTORY_PAGE=10,HISTORY_LIMIT=100;
const signature=doc=>String(doc?.revision)+':'+String(doc?.diskHash||doc?.hash||'');
const message=error=>String(error?.message||error||'The identity file could not be updated.');
const endpoint=kind=>'/api/identity/'+kind;
const record=()=>({doc:null,draft:'',previous:null,incoming:null,notice:null,loading:false,busy:false,
  read:0,controller:null,historyRead:0,historyController:null,historyLoading:false,history:null,
  historyError:'',historyOpen:false,visible:HISTORY_PAGE,stale:true});

/** Global files use explicit guarded saves; navigation never writes or discards a draft. */
export function createIdentitySettings({mount,api,events,notify=()=>{}}) {
  mount.innerHTML=[
    '<section class="next-card next-identity-settings" aria-labelledby="next-identity-title">',
    '<h2 id="next-identity-title">Identity &amp; profile</h2>',
    '<p class="next-help">Global character and user preferences shared across all working folders. SOUL.md stays fixed during development and learning. You can edit it here or explicitly ask BLACKICE to revise it. Saved changes apply to the next agent turn; current turns keep their original snapshot.</p>',
    '<div class="next-identity-tabs" role="tablist" aria-label="Identity files">',
    '<button id="next-identity-soul" type="button" role="tab" aria-controls="next-identity-editor">Soul</button>',
    '<button id="next-identity-user" type="button" role="tab" aria-controls="next-identity-editor">User profile</button></div>',
    '<div id="next-identity-editor" role="tabpanel" aria-labelledby="next-identity-soul">',
    '<div class="next-identity-heading"><div><h3 id="next-identity-name">SOUL.md</h3>',
    '<p id="next-identity-description" class="next-help"></p></div>',
    '<button id="next-identity-reload" type="button">Reload file</button></div>',
    '<p id="next-identity-path" class="next-identity-path"></p>',
    '<p id="next-identity-warning" class="next-identity-warning" hidden></p>',
    '<div id="next-identity-conflict" class="next-identity-conflict" hidden>',
    '<p>The saved file has changed. Your draft is kept. Choose the text to continue editing.</p>',
    '<div class="next-row"><button id="next-identity-use-file" type="button">Use file version</button>',
    '<button id="next-identity-keep-draft" type="button">Keep my draft</button></div></div>',
    '<form id="next-identity-form">',
    '<label class="next-label" for="next-identity-content">Markdown</label>',
    '<textarea id="next-identity-content" class="next-field next-identity-content" rows="15" spellcheck="false"></textarea>',
    '<div class="next-identity-save-row"><p id="next-identity-state" class="next-help" role="status"></p>',
    '<span id="next-identity-count" class="next-help"></span>',
    '<button id="next-identity-save" type="submit" class="next-primary">Save changes</button></div></form>',
    '<p id="next-identity-notice" class="next-identity-notice" role="status" aria-live="polite"></p>',
    '<button id="next-identity-recover" type="button" hidden>Recover previous draft</button>',
    '<button id="next-identity-history" type="button" aria-expanded="false" aria-controls="next-identity-history-panel">Version history</button>',
    '<section id="next-identity-history-panel" class="next-identity-history" aria-label="Saved identity revisions" hidden>',
    '<p id="next-identity-history-info" class="next-help" role="status"></p>',
    '<ol id="next-identity-versions"></ol>',
    '<button id="next-identity-more" type="button" hidden>Show more revisions</button></section>',
    '</div></section>',
  ].join('');
  const find=id=>mount.querySelector('#next-identity-'+id);
  const ui=Object.fromEntries(['soul','user','editor','name','description','reload','path','warning','conflict',
    'use-file','keep-draft','form','content','state','count','save','notice','recover','history','history-panel',
    'history-info','versions','more'].map(id=>[id,find(id)]));
  const states={soul:record(),user:record()};
  let selected='soul',active=false,destroyed=false,unsubscribe=null;
  const current=()=>states[selected];
  const dirty=state=>Boolean(state.doc)&&state.draft!==state.doc.content;
  function setNotice(state,value,error=false){state.notice={message:value,error};}
  function validDocument(doc,kind){
    if(!doc||doc.kind!==kind||typeof doc.content!=='string'||doc.content.length>LIMITS[kind]||
      !Number.isSafeInteger(doc.revision)||doc.revision<0||!/^[a-f0-9]{64}$/.test(doc.diskHash||doc.hash||''))
      throw Error('BLACKICE returned an unreadable identity file. Reload before saving.');
    return doc;
  }
  function invalidateRead(state){state.read++;state.controller?.abort();state.controller=null;state.loading=false;}
  function invalidateHistory(state){state.historyRead++;state.historyController?.abort();state.historyController=null;state.historyLoading=false;}
  function renderHistory(){
    const state=current(),kind=selected;ui['history-panel'].hidden=!state.historyOpen;
    ui.history.setAttribute('aria-expanded',String(state.historyOpen));ui.versions.textContent='';
    ui.more.hidden=true;
    if(!state.historyOpen)return;
    ui['history-info'].textContent=state.historyError||(state.historyLoading?'Loading saved revisions…':
      state.history?.length?'Restoring a saved version creates a new current revision. Up to '+HISTORY_LIMIT+' recent revisions are available here.':'No saved revisions available.');
    ui['history-info'].dataset.error=String(Boolean(state.historyError));
    for(const version of (state.history||[]).slice(0,state.visible)){
      const row=text(ui.versions,'','li','next-identity-version');
      const details=text(row,'','div');
      text(details,'Revision '+version.revision+(version.revision===state.doc?.revision?' · current':''),'strong');
      text(details,[formatDate(version.updatedAt)||'Date unavailable',Number(version.chars||0).toLocaleString()+' characters'].join(' · '),'small');
      const button=text(row,'Restore this version','button');button.setAttribute('type','button');
      button.dataset.identityRevision=String(version.revision);
      button.disabled=state.busy||state.loading||Boolean(state.incoming)||version.revision===state.doc?.revision;
      button.addEventListener('click',()=>void restore(kind,version.revision));
    }
    ui.more.hidden=!(state.history&&state.visible<state.history.length);
    ui.more.textContent='Show '+Math.min(HISTORY_PAGE,(state.history?.length||0)-state.visible)+' more revisions';
  }
  function render({history=true}={}){
    if(!active||destroyed)return;
    const state=current(),doc=state.doc;
    for(const kind of KINDS){ui[kind].setAttribute('aria-selected',String(kind===selected));ui[kind].tabIndex=kind===selected?0:-1;}
    ui.editor.setAttribute('aria-labelledby','next-identity-'+selected);
    ui.name.textContent=NAMES[selected];
    ui.description.textContent=selected==='soul'?'Fixed BLACKICE identity, voice, and working style. Yours to edit.':'Confirmed facts and preferences about you.';
    ui.path.textContent=doc?.path||'';ui.warning.hidden=!doc?.warning;ui.warning.textContent=doc?.warning||'';
    ui.conflict.hidden=!state.incoming;ui.content.setAttribute('aria-label',NAMES[selected]+' Markdown');
    ui.content.maxLength=LIMITS[selected];
    if(ui.content.value!==state.draft)ui.content.value=state.draft;
    ui.content.disabled=!doc;
    ui.count.textContent=state.draft.length.toLocaleString()+' / '+LIMITS[selected].toLocaleString();
    ui.state.textContent=state.busy?'Saving…':!doc?state.loading?'Loading identity file…':'File unavailable. Reload to try again.':
      dirty(state)?'Unsaved changes. Your draft stays here when you switch settings or workspaces.':'Saved · revision '+doc.revision;
    ui.save.disabled=!doc||!dirty(state)||state.busy||state.loading||Boolean(state.incoming);
    ui.reload.disabled=state.busy||state.loading;
    ui.history.disabled=!doc||state.busy;
    ui['use-file'].disabled=state.busy;ui['keep-draft'].disabled=state.busy;
    ui.recover.hidden=state.previous===null;ui.recover.disabled=state.busy;
    ui.notice.textContent=state.notice?.message||'';ui.notice.dataset.error=String(state.notice?.error===true);
    ui.notice.setAttribute('role',state.notice?.error?'alert':'status');
    if(history)renderHistory();
  }
  async function load(kind,{explicit=false}={}){
    const state=states[kind];if(!active||destroyed||state.busy)return;
    invalidateRead(state);const token=state.read;state.controller=new AbortController();state.loading=true;
    if(kind===selected)render();
    try{
      const doc=validDocument(await api(endpoint(kind),'GET',undefined,{signal:state.controller.signal}),kind);
      if(destroyed||!active||token!==state.read)return;
      if(state.doc&&dirty(state)&&signature(doc)!==signature(state.doc))state.incoming=doc;
      else {
        const wasDirty=dirty(state);state.doc=doc;state.incoming=null;
        if(!wasDirty)state.draft=doc.content;
      }
      state.stale=false;
      if(explicit)setNotice(state,state.incoming?'Newer file loaded. Your draft is kept.':'File reloaded. Your draft is kept.');
    }catch(error){if(!destroyed&&active&&token===state.read&&error.name!=='AbortError'){
      state.stale=true;setNotice(state,message(error),true);
    }}finally{if(token===state.read){state.loading=false;state.controller=null;if(kind===selected)render();}}
  }
  async function loadHistory(kind){
    const state=states[kind];if(!active||destroyed||!state.doc||state.busy)return;
    invalidateHistory(state);const token=state.historyRead;state.historyController=new AbortController();state.historyLoading=true;
    if(kind===selected)renderHistory();
    try{
      const result=await api(endpoint(kind)+'/versions','GET',undefined,{signal:state.historyController.signal});
      if(!active||destroyed||token!==state.historyRead)return;
      if(!Array.isArray(result))throw Error('BLACKICE returned an unreadable revision history.');
      state.history=result.filter(item=>Number.isSafeInteger(item?.revision)&&item.revision>0)
        .sort((a,b)=>b.revision-a.revision).slice(0,HISTORY_LIMIT);
      state.historyError='';
    }catch(error){if(active&&!destroyed&&token===state.historyRead&&error.name!=='AbortError')state.historyError=message(error);}
    finally{if(token===state.historyRead){state.historyLoading=false;state.historyController=null;if(kind===selected)renderHistory();}}
  }
  async function mutate(kind,revision){
    const state=states[kind];if(!active||destroyed||!state.doc||state.busy||state.loading||state.incoming)return;
    const restoring=revision!==undefined;
    if(!restoring&&!dirty(state))return;
    if(restoring&&!state.history?.some(item=>item.revision===revision))return;
    const submitted=state.draft,doc=state.doc;
    if(submitted.length>LIMITS[kind]){setNotice(state,NAMES[kind]+' exceeds its character limit.',true);render();return;}
    invalidateRead(state);invalidateHistory(state);state.busy=true;
    const payload={expectedRevision:doc.revision,expectedHash:doc.diskHash||doc.hash,
      ...(restoring?{revision}:{content:submitted})};
    if(kind===selected)render();
    try{
      const saved=validDocument(await api(endpoint(kind)+(restoring?'/restore':''),restoring?'POST':'PUT',payload),kind);
      if(destroyed)return;
      if(restoring&&submitted!==saved.content&&submitted!==doc.content)state.previous=submitted;
      state.doc=saved;state.incoming=null;
      if(state.draft===submitted)state.draft=saved.content;
      state.history=null;state.stale=false;
      const receipt=restoring?'Restored revision '+revision+' as revision '+saved.revision+'.':NAMES[kind]+' saved · revision '+saved.revision+'.';
      setNotice(state,receipt);if(active)notify(receipt);
    }catch(error){if(!destroyed){setNotice(state,message(error),true);state.stale=error.status===409||state.stale;}}
    finally{
      state.busy=false;
      if(active&&!destroyed){if(kind===selected){render();if(state.historyOpen&&!state.history)void loadHistory(kind);}
        if(state.stale)void load(kind);}
    }
  }
  const restore=(kind,revision)=>mutate(kind,revision);
  function select(kind){
    if(!KINDS.includes(kind)||destroyed)return;selected=kind;render();
    const state=current();if(!state.doc||state.stale)void load(kind);
    if(state.historyOpen&&!state.history)void loadHistory(kind);
  }
  for(const kind of KINDS){
    ui[kind].addEventListener('click',()=>select(kind));
    ui[kind].addEventListener('keydown',event=>{
      let next;if(event.key==='ArrowLeft'||event.key==='ArrowRight')next=kind==='soul'?'user':'soul';
      else if(event.key==='Home')next='soul';else if(event.key==='End')next='user';else return;
      event.preventDefault();select(next);ui[next].focus();
    });
  }
  ui.content.addEventListener('input',()=>{current().draft=ui.content.value;render({history:false});});
  ui.form.addEventListener('submit',event=>{event.preventDefault();void mutate(selected);});
  ui.reload.addEventListener('click',()=>{void load(selected,{explicit:true});if(current().historyOpen)void loadHistory(selected);});
  ui.history.addEventListener('click',()=>{const state=current();state.historyOpen=!state.historyOpen;render();if(state.historyOpen)void loadHistory(selected);});
  ui.more.addEventListener('click',()=>{current().visible=Math.min(HISTORY_LIMIT,current().visible+HISTORY_PAGE);renderHistory();});
  ui['use-file'].addEventListener('click',()=>{
    const state=current();if(!state.incoming||state.busy)return;
    if(dirty(state))state.previous=state.draft;
    state.doc=state.incoming;state.draft=state.doc.content;state.incoming=null;setNotice(state,'File version loaded.');render();
  });
  ui['keep-draft'].addEventListener('click',()=>{
    const state=current();if(!state.incoming||state.busy)return;
    state.doc=state.incoming;state.incoming=null;setNotice(state,'Your draft is kept. Save changes to update the current file.');render();
  });
  ui.recover.addEventListener('click',()=>{
    const state=current();if(state.previous===null||state.busy)return;
    const value=state.previous;state.previous=dirty(state)?state.draft:null;state.draft=value;
    setNotice(state,'Previous draft recovered. Save changes to keep it.');render();
  });
  const onEvent=receipt=>{
    if(receipt?.type!=='identity.updated')return;
    for(const state of Object.values(states)){state.stale=true;state.history=null;}
    if(active){void load(selected);if(current().historyOpen)void loadHistory(selected);}
  };
  return {
    enter(){if(destroyed||active)return;active=true;unsubscribe=events?.subscribe?.(onEvent);render();void load(selected);if(current().historyOpen)void loadHistory(selected);},
    leave(){active=false;unsubscribe?.();unsubscribe=null;for(const state of Object.values(states)){invalidateRead(state);invalidateHistory(state);}},
    destroy(){this.leave();destroyed=true;mount.textContent='';},
  };
}
