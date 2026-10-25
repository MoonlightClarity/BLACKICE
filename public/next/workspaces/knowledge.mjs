import {text,formatDate} from '../core/dom.mjs';
import {KNOWLEDGE_PAGE_SIZE,KNOWLEDGE_LIST_LIMIT,knowledgeListPath,knowledgeWindow,
  knowledgeDraft,knowledgeDraftChanged,knowledgeSavePayload,knowledgeExpectedRevision,
  knowledgeHistoryRows,knowledgeRestorePayload,knowledgeRecoveryPayload,knowledgeAuthor} from './knowledge-model.mjs';

/** Knowledge reads are lazy and cancellable. Only explicit form actions write. */
export function createKnowledgeWorkspace({mount,api,events,notify}) {
  mount.innerHTML=[
    '<div id="next-knowledge-root" class="next-panel next-knowledge-root"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Knowledge</h1><p>Memories and skills shared with your agents.</p></div>',
    '<div class="next-row"><button type="button" id="next-knowledge-refresh">Refresh</button>',
    '<button type="button" id="next-knowledge-new" class="next-primary">New memory</button></div></header>',
    '<div class="next-knowledge-toolbar">',
    '<label class="next-label">Collection<select id="next-knowledge-kind" class="next-field"><option value="memory">Memories</option><option value="skill">Skills</option></select></label>',
    '<label class="next-label next-knowledge-search">Search<input id="next-knowledge-query" class="next-field" type="search" maxlength="256" placeholder="Find knowledge"></label>',
    '<label class="next-label" id="next-knowledge-type-label">Memory type<select id="next-knowledge-type" class="next-field"><option value="">All types</option><option value="note">Notes</option><option value="fact">Facts</option><option value="assumption">Assumptions</option><option value="decision">Decisions</option></select></label></div>',
    '<div class="next-knowledge-filters"><label class="next-label">Folder filter<input id="next-knowledge-scope" class="next-field" placeholder="All folders" spellcheck="false"></label>',
    '<label class="next-label">Show<select id="next-knowledge-state" class="next-field"><option value="active">Active entries</option><option value="deleted">Trash</option></select></label></div>',
    '<p class="next-knowledge-status" id="next-knowledge-info" role="status" aria-live="polite"></p>',
    '<div class="next-knowledge-layout"><aside aria-label="Saved knowledge"><ul id="next-knowledge-list" class="next-knowledge-list"></ul>',
    '<div class="next-knowledge-list-footer"><button type="button" id="next-knowledge-more" hidden>Show more</button>',
    '<p class="next-help" id="next-knowledge-list-note"></p></div></aside>',
    '<section id="next-knowledge-detail" class="next-card next-knowledge-editor" aria-label="Knowledge editor">',
    '<h2 id="next-knowledge-heading">Open an entry</h2><p id="next-knowledge-editor-info" class="next-knowledge-status" role="status" aria-live="polite">Choose a saved entry or create a memory.</p>',
    '<p id="next-knowledge-stale" class="next-knowledge-status" hidden></p>',
    '<form id="next-knowledge-form" hidden><div id="next-knowledge-entry-meta" class="next-knowledge-entry-meta"></div>',
    '<label class="next-label">Title<input id="next-knowledge-title" class="next-field" maxlength="120" required></label>',
    '<label class="next-label">Summary<textarea id="next-knowledge-summary" class="next-field" maxlength="400" rows="2"></textarea></label>',
    '<label class="next-label">Full content<textarea id="next-knowledge-content" class="next-field" rows="14" required spellcheck="false"></textarea></label>',
    '<div class="next-knowledge-scope-fields"><label class="next-label">Folder scope<input id="next-knowledge-cwd" class="next-field" placeholder="Global · available in all folders" spellcheck="false"></label>',
    '<label id="next-knowledge-memory-type-label" class="next-label">Memory type<select id="next-knowledge-memory-type" class="next-field"><option value="note">Note</option><option value="fact">Fact</option><option value="assumption">Assumption</option><option value="decision">Decision</option></select></label></div>',
    '<p class="next-help">Leave folder scope empty for global knowledge. A folder filter includes global entries.</p>',
    '<div id="next-knowledge-sources"></div><div class="next-row">',
    '<button id="next-knowledge-save" class="next-primary" type="submit">Create memory</button>',
    '<button id="next-knowledge-delete" type="button" hidden>Move to Trash</button>',
    '<button id="next-knowledge-recover" type="button" class="next-primary" hidden>Restore entry</button>',
    '<button id="next-knowledge-discard" type="button" hidden>Reload saved entry</button>',
    '<button id="next-knowledge-history" type="button" hidden>Revision history</button></div></form>',
    '<section id="next-knowledge-history-panel" class="next-knowledge-history" aria-label="Revision history" hidden></section>',
    '</section></div></div></div>',
  ].join('');
  const find=id=>mount.querySelector('#next-knowledge-'+id);
  const els=Object.fromEntries(['root','refresh','new','kind','query','type','type-label','scope','state','info','list','more','list-note',
    'detail','heading','editor-info','stale','form','entry-meta','title','summary','content','cwd','memory-type','memory-type-label',
    'sources','save','delete','recover','discard','history','history-panel'].map(id=>[id,find(id)]));
  const drafts=new Map(),histories=new Map(),revisionSelections=new Map();
  let active=false,destroyed=false,unsubscribe=null,selected=null,items=[],visible=KNOWLEDGE_PAGE_SIZE;
  let listGeneration=0,detailGeneration=0,historyGeneration=0,listController=null,detailController=null,historyController=null;
  let listBusy=false,detailBusy=false,historyBusy=false,mutationBusy=false,listStale=true,timer=null;
  const current=()=>drafts.get(selected);
  const add=(parent,tag,content='',className='')=>text(parent,content,tag,className);
  const info=(node,message,error=false)=>{node.textContent=message;node.dataset.error=String(error);};
  const failure=error=>String(error?.message||error||'This action could not complete.');
  const path=id=>'/api/knowledge/'+encodeURIComponent(id);
  const isCurrent=(token,key)=>active&&!destroyed&&token===detailGeneration&&selected===key;

  function listOptions(){return {kind:els.kind.value,query:els.query.value,memoryType:els.type.value,
    cwd:els.scope.value,deletedOnly:els.state.value==='deleted'};}
  function updateControls(){
    for(const node of [els.kind,els.query,els.type,els.scope,els.state,els.new,els.refresh,els.more])node.disabled=mutationBusy;
    for(const button of els.list.querySelectorAll('button'))button.disabled=mutationBusy;
    const draft=current(),deleted=Boolean(draft?.entry?.deleted),saved=Boolean(draft?.entry);
    for(const field of [els.title,els.summary,els.content,els.cwd]){field.disabled=mutationBusy;field.readOnly=deleted;}
    els['memory-type'].disabled=mutationBusy||deleted;
    els.save.disabled=mutationBusy||detailBusy||deleted||(saved&&!knowledgeDraftChanged(draft));
    els.delete.disabled=mutationBusy||detailBusy;els.discard.disabled=mutationBusy||detailBusy;
    els.recover.disabled=mutationBusy||detailBusy||historyBusy;
    els.history.disabled=mutationBusy||historyBusy;els.more.disabled=mutationBusy||listBusy;
    for(const button of els['history-panel'].querySelectorAll('button'))button.disabled=mutationBusy||historyBusy;
  }
  function markStale(){
    const draft=current();
    const latest=draft?.entry&&items.find(item=>item.id===draft.entry.id);
    const changed=Boolean(latest&&latest.revision!==draft.entry.revision);
    els.stale.hidden=!changed;
    if(changed)els.stale.textContent='This entry has changed since it opened. Your draft is kept. Reload saved entry replaces it with the current version.';
  }
  function paintList(){
    const window=knowledgeWindow(items,visible);els.list.replaceChildren();
    if(!window.items.length)add(els.list,'li','No matching '+(els.kind.value==='skill'?'skills':'memories')+'.','next-empty');
    for(const item of window.items){
      const row=add(els.list,'li');
      const button=add(row,'button');button.type='button';button.dataset.knowledgeId=item.id;
      button.setAttribute('aria-pressed',String(item.id===selected));
      add(button,'strong',item.title||'Untitled entry');
      if(item.summary||item.excerpt)add(button,'p',item.summary||item.excerpt,'next-knowledge-excerpt');
      add(button,'small',[item.memoryType||item.kind,item.cwd||'Global','Revision '+(item.revision||1),knowledgeAuthor(item)].join(' · '));
      button.addEventListener('click',()=>void openEntry(item.id));
    }
    els.more.hidden=!window.hasMore;
    els['list-note'].textContent=window.total>=KNOWLEDGE_LIST_LIMIT
      ?'Showing '+window.items.length+' of the first '+KNOWLEDGE_LIST_LIMIT+' matches. Narrow the search to find more.'
      :window.items.length+' of '+window.total+' entries shown.';
    markStale();updateControls();
  }
  async function loadList(){
    if(!active||destroyed)return;
    const token=++listGeneration;listController?.abort();listController=new AbortController();
    listBusy=true;listStale=false;info(els.info,'Loading knowledge…');updateControls();
    try{
      const result=await api(knowledgeListPath(listOptions()),'GET',undefined,{signal:listController.signal});
      if(!active||token!==listGeneration)return;
      if(!Array.isArray(result))throw Error('Knowledge returned an unreadable list.');
      items=result.slice(0,KNOWLEDGE_LIST_LIMIT);paintList();
      info(els.info,items.length+' matching '+(els.kind.value==='skill'?'skills':'memories')+'.');
    }catch(error){if(active&&token===listGeneration&&error.name!=='AbortError'){
      listStale=true;info(els.info,failure(error),true);
    }}finally{if(token===listGeneration){listBusy=false;if(active)updateControls();}}
  }
  function queueList({reset=false}={}){
    if(reset)visible=KNOWLEDGE_PAGE_SIZE;
    listStale=true;clearTimeout(timer);if(active)timer=setTimeout(()=>void loadList(),220);
  }
  function paintSources(entry){
    els.sources.replaceChildren();
    if(entry?.kind!=='memory'||(!entry.sources?.length&&!entry.relations?.length))return;
    const details=add(els.sources,'details','','next-knowledge-sources');
    add(details,'summary',(entry.sources?.length||0)+' sources · '+(entry.relations?.length||0)+' relationships');
    const list=add(details,'ul');
    for(const source of entry.sources||[])add(list,'li',source);
    for(const relation of entry.relations||[])add(list,'li',relation.type+' → '+relation.targetId);
    add(details,'p','Sources and relationships are preserved when you save.','next-help');
  }
  function paintEditor(){
    const draft=current();if(!draft)return;
    const {entry,values}=draft,kind=values.kind;
    els.form.hidden=false;els.heading.textContent=entry?.deleted?(kind==='skill'?'Skill':'Memory')+' in Trash':entry?entry.title:'New '+kind;
    for(const field of ['title','summary','content','cwd'])els[field].value=values[field];
    els['memory-type'].value=values.memoryType;els['memory-type-label'].hidden=kind!=='memory';
    els.content.maxLength=kind==='skill'?40000:8000;
    els.save.textContent=entry?'Save changes':'Create '+kind;els.save.hidden=Boolean(entry?.deleted);
    els.delete.hidden=!entry||Boolean(entry.deleted);els.recover.hidden=!entry?.deleted;els.discard.hidden=!entry;
    els.history.hidden=!entry;els['entry-meta'].replaceChildren();
    if(entry){
      add(els['entry-meta'],'span','Revision '+entry.revision);
      add(els['entry-meta'],'span',knowledgeAuthor(entry));
      add(els['entry-meta'],'span','Updated '+(formatDate(entry.updatedAt)||'recently'));
    }
    paintSources(entry);markStale();
    info(els['editor-info'],draft.notice?.message||(entry?.deleted?'This entry is in Trash. Restore entry recovers its newest retained active revision. Revision history lets you inspect older versions.'
      :knowledgeDraftChanged(draft)?'Unsaved changes. Your draft stays here when you switch workspaces.'
      :entry?'Saved revision '+entry.revision+'.':'Write the content, then create this '+kind+'.'),draft.notice?.error===true);
    paintHistory();updateControls();
  }
  async function openEntry(id,{reload=false}={}){
    if(mutationBusy||!active)return;
    const token=++detailGeneration;detailController?.abort();historyController?.abort();historyGeneration++;historyBusy=false;
    selected=id;detailBusy=false;
    if(!reload&&drafts.has(id)&&!(els.state.value==='deleted'&&!drafts.get(id).entry?.deleted)){
      if(drafts.get(id).entry?.deleted)drafts.get(id).historyOpen=true;
      paintEditor();paintList();
      if(drafts.get(id).entry?.deleted)void loadHistory();
      return;
    }
    detailBusy=true;els.form.hidden=true;els['history-panel'].hidden=true;
    els.stale.hidden=true;els.heading.textContent='Opening entry';info(els['editor-info'],'Loading full entry…');paintList();
    detailController=new AbortController();
    try{
      const deleted=els.state.value==='deleted'||drafts.get(id)?.entry?.deleted;
      let entry;
      if(deleted){
        const history=await api(path(id)+'/history','GET',undefined,{signal:detailController.signal});
        if(!isCurrent(token,id))return;
        entry=knowledgeHistoryRows(history)[0];
        if(!entry)throw Error('No retained revision is available for this entry.');
        histories.set(id,history);
      }else entry=await api(path(id),'GET',undefined,{signal:detailController.signal});
      if(!isCurrent(token,id))return;
      if(!entry||entry.id!==id||typeof entry.content!=='string')throw Error('Knowledge returned an unreadable entry.');
      const draft=knowledgeDraft(entry);draft.historyOpen=Boolean(entry.deleted);drafts.set(id,draft);
      if(reload&&!deleted)histories.delete(id);
      paintEditor();
    }catch(error){if(isCurrent(token,id)&&error.name!=='AbortError'){
      els.heading.textContent='Entry unavailable';
      if(drafts.has(id)){paintEditor();info(els['editor-info'],failure(error)+' Your draft is kept.',true);}
      else{
        info(els['editor-info'],failure(error),true);
        const retry=add(els['editor-info'],'button','Try again');retry.type='button';
        retry.addEventListener('click',()=>void openEntry(id,{reload:true}));
      }
    }}finally{if(token===detailGeneration){detailBusy=false;if(active)updateControls();}}
  }
  function newEntry(){
    if(mutationBusy)return;
    detailController?.abort();historyController?.abort();detailGeneration++;historyGeneration++;detailBusy=false;historyBusy=false;
    const kind=els.kind.value,key='new:'+kind;
    if(!drafts.has(key))drafts.set(key,knowledgeDraft(null,kind));
    selected=key;paintEditor();paintList();els.title.focus();
  }
  function paintHistory(){
    const draft=current(),panel=els['history-panel'];
    panel.hidden=!draft?.historyOpen;if(panel.hidden)return;
    panel.replaceChildren();
    const heading=add(panel,'div','','next-row');add(heading,'h3','Revision history');
    const refresh=add(heading,'button','Refresh history');refresh.type='button';refresh.id='next-knowledge-history-refresh';
    refresh.addEventListener('click',()=>void loadHistory({force:true}));
    const history=histories.get(selected);
    if(!history){add(panel,'p',historyBusy?'Loading revisions…':'History has not loaded.','next-help');updateControls();return;}
    const rows=knowledgeHistoryRows(history);
    add(panel,'p','Up to 9 retained revisions. Restoring creates a new revision and replaces the editor draft.','next-help');
    const list=add(panel,'ol','','next-knowledge-revisions');list.id='next-knowledge-revisions';
    for(const row of rows){
      const li=add(list,'li'),button=add(li,'button');button.type='button';button.dataset.knowledgeRevision=String(row.revision);
      button.setAttribute('aria-pressed',String(revisionSelections.get(selected)===row.revision));
      add(button,'span','Revision '+row.revision+' · '+(row.action||'saved')+(row.deleted?' · deleted':''));
      add(button,'span',knowledgeAuthor(row)+' · '+(formatDate(row.updatedAt)||''));
      button.addEventListener('click',()=>{revisionSelections.set(selected,row.revision);paintHistory();});
    }
    const revision=rows.find(row=>row.revision===revisionSelections.get(selected));
    if(revision){
      const preview=add(panel,'div','','next-knowledge-revision-preview');
      add(preview,'strong',revision.title||'Untitled entry');
      if(revision.summary)add(preview,'p',revision.summary);
      add(preview,'p',(revision.cwd||'Global')+(revision.memoryType?' · '+revision.memoryType:'')+(revision.deleted?' · Deleted snapshot':''),'next-help');
      const label=add(preview,'label','Full revision content','next-label');
      const content=add(label,'textarea','','next-field');content.id='next-knowledge-revision-content';content.readOnly=true;content.value=revision.content||'';
      if(revision.revision!==history.currentRevision){
        const restore=add(preview,'button',revision.deleted?'Restore deleted state':'Restore revision '+revision.revision,'next-primary');
        restore.id='next-knowledge-restore';restore.type='button';
        restore.addEventListener('click',()=>void mutate('restore',revision.revision));
      }else add(preview,'p','This is the current saved revision.','next-help');
    }
    updateControls();
  }
  async function loadHistory({force=false}={}){
    const draft=current();if(!active||!draft?.entry||mutationBusy)return;
    draft.historyOpen=true;
    if(!force&&histories.has(selected)){paintHistory();return;}
    const key=selected,token=++historyGeneration;historyController?.abort();historyController=new AbortController();historyBusy=true;
    if(force)histories.delete(key);paintHistory();updateControls();
    try{
      const history=await api(path(draft.entry.id)+'/history','GET',undefined,{signal:historyController.signal});
      if(!active||token!==historyGeneration||selected!==key)return;
      histories.set(key,history);paintHistory();
    }catch(error){if(active&&token===historyGeneration&&selected===key&&error.name!=='AbortError')
      info(els['editor-info'],failure(error),true);
    }finally{if(token===historyGeneration){historyBusy=false;if(active){paintHistory();updateControls();}}}
  }
  async function recoverEntry(){
    const draft=current();if(!active||mutationBusy||detailBusy||historyBusy||!draft?.entry?.deleted)return;
    const key=selected,token=++historyGeneration;historyController?.abort();historyController=new AbortController();historyBusy=true;
    draft.recoveryReading=true;
    draft.notice={message:'Reading retained revisions before restoring…',error:false};info(els['editor-info'],draft.notice.message);updateControls();
    try{
      const history=await api(path(draft.entry.id)+'/history','GET',undefined,{signal:historyController.signal});
      if(!active||destroyed||token!==historyGeneration||selected!==key)return;
      histories.set(key,history);const payload=knowledgeRecoveryPayload(history);
      draft.recoveryReading=false;
      await mutate('restore',payload.revision);
    }catch(error){if(active&&!destroyed&&token===historyGeneration&&selected===key&&error.name!=='AbortError'){
      draft.notice={message:failure(error),error:true};info(els['editor-info'],draft.notice.message,true);
    }}finally{draft.recoveryReading=false;if(token===historyGeneration){historyBusy=false;if(active&&!destroyed){paintHistory();updateControls();}}}
  }
  async function mutate(action,revision){
    const draft=current();if(!active||!draft||mutationBusy||detailBusy)return;
    const key=selected;
    let payload;
    try{
      payload=action==='save'?knowledgeSavePayload(draft):action==='delete'
        ?{expectedRevision:knowledgeExpectedRevision(draft.entry)}:knowledgeRestorePayload(histories.get(key),revision);
    }catch(error){info(els['editor-info'],failure(error),true);return;}
    mutationBusy=true;clearTimeout(timer);historyController?.abort();historyGeneration++;historyBusy=false;
    draft.notice={message:action==='save'?'Saving…':action==='delete'?'Deleting…':'Restoring revision…',error:false};
    info(els['editor-info'],draft.notice.message);updateControls();
    try{
      const result=action==='save'?await api('/api/knowledge','POST',payload)
        :action==='delete'?await api(path(draft.entry.id),'DELETE',payload)
        :await api(path(draft.entry.id)+'/restore','POST',payload);
      const entry=action==='delete'?{...draft.entry,...result,action:'delete'}:result;
      if(!entry?.id||!Number.isSafeInteger(entry.revision))throw Error('The action completed with an unreadable result. Refresh before trying it again.');
      const saved=knowledgeDraft(entry);
      saved.notice={message:action==='delete'?'Entry moved to Trash. Restore entry can recover its newest retained active revision.':'Saved revision '+entry.revision+'.',error:false};
      drafts.delete(key);drafts.set(entry.id,saved);histories.delete(key);histories.delete(entry.id);
      revisionSelections.delete(key);selected=entry.id;listStale=true;
      if(action==='restore'&&draft.entry?.deleted&&!entry.deleted)els.state.value='active';
      if(!destroyed&&active)paintEditor();
      notify?.(action==='delete'?'Knowledge entry moved to Trash.':action==='restore'?'Knowledge revision restored.':'Knowledge saved.');
    }catch(error){
      draft.notice={message:failure(error)+(error.status===409?' Your draft is kept. Reload the saved entry or refresh history before trying another action.':''),error:true};
      if(error.status===409)histories.delete(key);
      if(!destroyed&&active){
        info(els['editor-info'],draft.notice.message,true);
        if(error.status===409&&draft.historyOpen)paintHistory();
      }
    }finally{
      mutationBusy=false;clearTimeout(timer);
      if(active&&!destroyed){updateControls();if(listStale)void loadList();}
    }
  }
  for(const field of ['title','summary','content','cwd','memory-type'])els[field].addEventListener('input',()=>{
    const draft=current();if(!draft||mutationBusy||draft.entry?.deleted)return;
    draft.values[field==='memory-type'?'memoryType':field]=els[field].value;delete draft.notice;
    info(els['editor-info'],knowledgeDraftChanged(draft)?'Unsaved changes. Your draft stays here when you switch workspaces.':'No unsaved changes.');
    updateControls();
  });
  els.form.addEventListener('submit',event=>{event.preventDefault();void mutate('save');});
  els.delete.addEventListener('click',()=>void mutate('delete'));
  els.recover.addEventListener('click',()=>void recoverEntry());
  els.discard.addEventListener('click',()=>void openEntry(selected,{reload:true}));
  els.history.addEventListener('click',()=>void loadHistory());
  els.new.addEventListener('click',newEntry);
  els.more.addEventListener('click',()=>{visible+=KNOWLEDGE_PAGE_SIZE;paintList();});
  els.refresh.addEventListener('click',()=>{clearTimeout(timer);void loadList();});
  els.kind.addEventListener('change',()=>{
    els['type-label'].hidden=els.kind.value==='skill';els.new.textContent='New '+els.kind.value;queueList({reset:true});
  });
  for(const element of [els.query,els.scope])element.addEventListener('input',()=>queueList({reset:true}));
  for(const element of [els.type,els.state])element.addEventListener('change',()=>queueList({reset:true}));
  function onEvent(event){
    if(!active||event.type!=='knowledge.updated')return;
    listStale=true;
    if(mutationBusy)return;
    if(knowledgeDraftChanged(current())){
      info(els.info,'Knowledge changed. Your draft is kept; refresh the list when ready.');return;
    }
    queueList();
  }
  return {
    enter(){
      if(active||destroyed)return;active=true;unsubscribe=events?.subscribe(onEvent);void loadList();
      if(selected&&!drafts.has(selected))void openEntry(selected);
      else if(current())paintEditor();
      if(mutationBusy)info(els['editor-info'],'Waiting for the pending knowledge action…');
    },
    leave(){
      const draft=current();if(draft?.recoveryReading){draft.recoveryReading=false;draft.notice={message:'Restore was not started. Choose Restore entry when you return.',error:false};}
      active=false;unsubscribe?.();unsubscribe=null;clearTimeout(timer);
      listController?.abort();detailController?.abort();historyController?.abort();
      listGeneration++;detailGeneration++;historyGeneration++;listBusy=false;detailBusy=false;historyBusy=false;
    },
    destroy(){this.leave();destroyed=true;mount.innerHTML='';},
  };
}
