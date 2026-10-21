import {createDraftStore,draftKey,draftWorkspace} from './draft-store.mjs';

/** The saved-task list distinguishes execution intent from storage status. */
export function inboxItemPresentation(item, status={}, items=[]){
  if(item.retryHold&&['failed','cancelled','interrupted'].includes(item.status))return{label:'Inspect original run',detail:'External action needs reconciliation',scheduled:false,position:null};
  if(item.status!=='queued')return{label:({dispatching:'Starting',running:'Working',completed:'Completed',failed:'Failed',cancelled:'Stopped',interrupted:'Interrupted',deleted:'Removed'})[item.status]||item.status,detail:'',scheduled:false,position:null};
  if(item.managedBy)return{label:'Operation',detail:'Managed by its workflow',scheduled:false,position:null};
  const scheduled=item.startWhenIdle===true||status.autoRun===true;
  if(!scheduled)return{label:'Saved',detail:'Start when you choose',scheduled:false,position:null};
  const ready=items.filter(value=>value.status==='queued'&&!value.managedBy&&(value.startWhenIdle===true||status.autoRun===true)),position=ready.findIndex(value=>value.id===item.id)+1;
  return{label:status.paused?'Paused':'Queued',detail:position>0?`${position} in run order`:'Runs when a slot opens',scheduled:true,position:position||null};
}

/** A persistent, ordered inbox. Saving a task never implies starting it. */
export function initInboxUI({api,showModal,closeModal,toast,escape,icon,getCwd=()=>'',getDraft=()=>({}),onOpenRun,onRunStarted,onOpenOperations,draftStore=createDraftStore()}){
  const $=selector=>document.querySelector(selector);
  const state={data:null,selectedId:null,openTarget:null,tab:'queued',draft:null,editingId:null,draftKey:null,context:null,baseRevision:null,persisted:null,restored:false,incoming:null,storageError:'',busy:false,error:'',request:0,view:0,active:false};let poll,view,renderedMarkup,pendingFocus;
  const pendingDraftSaves=new Map(),tabs=['queued','history','deleted'];
  const alive=()=>state.active&&Boolean(view)&&$('#inbox-view')===view,owns=owner=>owner===state.view&&alive();
  const active=item=>['queued','dispatching','running'].includes(item.status),label=value=>String(value||'').replaceAll('_',' '),time=value=>value?new Date(value).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
  const endpoint=id=>`/api/inbox/${encodeURIComponent(id)}`,disabled=()=>state.busy?' disabled':'';
  const selected=()=>state.data?.items.find(item=>item.id===state.selectedId);
  const prefix=context=>draftKey('inbox',draftWorkspace(context))+':';
  const draftData=value=>{value||={};return{title:value.title||'',input:value.input||'',cwd:value.cwd||'',attachmentIds:Array.isArray(value.attachmentIds)?[...value.attachmentIds]:[],...(value.workflow?{workflow:structuredClone(value.workflow)}:{})};};
  const record=()=>({editingId:state.editingId,context:state.context,baseRevision:state.baseRevision,draft:draftData(state.draft)});
  function persistDraft(){if(!state.draft||!state.draftKey||state.editingId&&state.incoming?.status==='deleted')return;if(!state.draft.input.trim()&&!state.draft.title?.trim()){draftStore.remove(state.draftKey,{expected:state.persisted});state.persisted=null;return;}const result=draftStore.save(state.draftKey,record());state.persisted=result.data;state.storageError=result.error||'';}
  function removeItemDrafts(id){for(const cached of draftStore.list(draftKey('inbox')+':'))if(cached.data.editingId===id)draftStore.remove(cached.key,{expected:cached.data});}
  function savedDrafts(){return draftStore.list(prefix(getCwd())).filter(cached=>typeof cached.data.draft?.input==='string'&&typeof cached.data.draft?.cwd==='string');}
  function resumeDraft(cached){
    if(!cached)return false;const value=cached.data,item=value.editingId?state.data?.items.find(item=>item.id===value.editingId):null;
    if(value.editingId&&(!item||item.status==='deleted')){draftStore.remove(cached.key,{expected:value});return false;}
    if(state.draft)persistDraft();
    state.editingId=value.editingId||null;state.context=value.context;state.draftKey=cached.key;state.baseRevision=value.baseRevision;state.persisted=value;
    state.draft={...(item?structuredClone(item):{}),...structuredClone(value.draft),...(item?{revision:value.baseRevision}:{})};state.restored=true;state.storageError='';state.error='';
    state.incoming=item&&(item.revision!==value.baseRevision||['dispatching','running'].includes(item.status))?item:null;render();return true;
  }
  function renderDraftNotice(){
    if(!state.draft||!$('#inbox-editor'))return;
    if(!$('#inbox-draft-notice'))$('.inbox-editor-footer')?.insertAdjacentHTML('beforebegin','<div id="inbox-draft-notice" class="inbox-notice" role="status"></div>');
    const notice=$('#inbox-draft-notice'),other=savedDrafts().filter(cached=>cached.key!==state.draftKey),blocked=state.incoming&&['deleted','dispatching','running'].includes(state.incoming.status);
    const saving=pendingDraftSaves.has(state.draftKey);
    if(notice){notice.hidden=!saving&&!state.restored&&!state.storageError&&!state.incoming&&!other.length;notice.innerHTML=`${state.incoming?`<span>${blocked?'This task is no longer editable.':'The saved task changed.'} Your draft is kept.</span> ${blocked?'<button class="button subtle" data-inbox="draft-as-new" type="button">Keep as new task</button>':'<button class="button subtle" data-inbox="use-saved" type="button">Use saved task</button><button class="button subtle" data-inbox="keep-draft" type="button">Keep draft</button>'}`:escape(saving?'Saving this draft… Your current text is kept.':state.storageError||(state.restored?'Draft restored.':''))}${other.length?`<details><summary>Other drafts · ${other.length}</summary>${other.map(cached=>`<button class="button subtle" type="button" data-inbox="resume-draft" data-key="${escape(cached.key)}">${escape(cached.data.draft.title||cached.data.draft.input.slice(0,60)||'Untitled draft')}</button>`).join('')}</details>`:''}`;}
    const cancel=$('[data-inbox="cancel-edit"]');if(cancel){cancel.dataset.inbox='discard-draft';cancel.textContent='Discard draft';}
    const submit=$('#inbox-editor button[type="submit"]');if(submit)submit.disabled=state.busy||saving||Boolean(state.incoming)||editingQueued();
  }
  function collection(){return(state.data?.items||[]).filter(item=>state.tab==='queued'?active(item):state.tab==='deleted'?item.status==='deleted':!active(item)&&item.status!=='deleted');}
  function configuration(item){const agents=item.workflow?.nodes?.filter(node=>node.type==='agent')||[],models=[...new Set(agents.map(node=>node.model||'default'))];return`${models.length?models.join(', '):'Current default model'}${item.attachmentIds?.length?` · ${item.attachmentIds.length} attached ${item.attachmentIds.length===1?'file':'files'}`:''}`;}
  function header(){return`<div class="modal-header"><span class="inbox-mark">${icon('inbox',25)}</span><div class="modal-title"><h2>Task inbox</h2><p>Capture the next task while your agent finishes the current one.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close task inbox">${icon('close',17)}</button></div>`;}
  const presentation=item=>inboxItemPresentation(item,state.data?.status,state.data?.items);
  const editingQueued=()=>Boolean(state.editingId&&!state.data?.status.paused&&presentation(state.draft||{}).scheduled);
  function queueControls(){const status=state.data.status;if(status.paused)return`<span>Queued starts paused</span><button class="button" data-inbox="resume"${disabled()}>Resume queue</button>`;if(status.autoRun||status.scheduled>0)return`<span>${status.scheduled>0?`${status.scheduled} queued to run`:'Saved tasks run automatically'}</span><button class="button subtle" data-inbox="pause"${disabled()}>Pause queue</button>`;return'<span>Saved tasks wait for you.</span>';}
  function row(item){const view=presentation(item);return`<button class="inbox-row${item.id===state.selectedId?' selected':''}" data-inbox="select" data-id="${escape(item.id)}"${item.id===state.selectedId?' aria-current="true"':''} aria-controls="inbox-detail"><span>${escape(item.title)}</span><small><i class="inbox-state-dot ${item.status==='running'?'running':''}"></i>${escape(view.label)}${view.detail?` · ${escape(view.detail)}`:''}</small></button>`;}
  const controls=()=>[...view?.querySelectorAll?.('button,input,textarea,select,summary,[tabindex]')||[]];
  function focusIdentity(node){
    const group=['inbox-detail','inbox-sidebar','inbox-toolbar','inbox-progress','inbox-footer','inbox-editor-footer','inbox-editor'].find(name=>node.closest?.('.'+name)||node.closest?.('#'+name))||'';
    return JSON.stringify([node.id||'',group,node.tagName,node.type||'',...['inbox','id','tab','runId','direction','key','action'].map(key=>node.dataset?.[key]||'')]);
  }
  function rememberFocus(){
    const focused=document.activeElement;
    if(focused===view)return pendingFocus||null;
    if(!view?.contains?.(focused))return(!focused||focused===document.body||focused.isConnected===false)?pendingFocus||null:null;
    const identity=focusIdentity(focused),matches=controls().filter(node=>focusIdentity(node)===identity);
    return{identity,index:matches.indexOf(focused),start:focused.selectionStart,end:focused.selectionEnd};
  }
  function restoreFocus(saved){
    pendingFocus=null;if(!saved||!alive())return;
    const available=node=>node&&!node.disabled&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0);
    const matches=controls().filter(node=>focusIdentity(node)===saved.identity),target=matches[Math.max(0,saved.index)];
    if(target&&!available(target)&&state.busy){pendingFocus=saved;view.focus?.({preventScroll:true});return;}
    const fallback=controls().find(node=>node.dataset?.inbox==='select'&&node.dataset.id===state.selectedId&&available(node))||controls().find(node=>node.dataset?.inbox==='tab'&&node.dataset.tab===state.tab&&available(node))||controls().find(available);
    const next=available(target)?target:fallback||view;next?.focus?.({preventScroll:true});
    if(next===target&&Number.isInteger(saved.start))try{next.setSelectionRange?.(saved.start,saved.end);}catch{}
  }
  function selectTab(tab,{focus=false}={}){
    if(!tabs.includes(tab))return;state.tab=tab;state.selectedId=null;render();
    if(focus)controls().find(node=>node.dataset?.inbox==='tab'&&node.dataset.tab===tab)?.focus?.({preventScroll:true});
  }
  function render(){
    if(!alive())return;if(state.draft){renderEditor();return;}
    const data=state.data;if(!data){$('#inbox-view').innerHTML=`<div class="inbox-empty">${state.error?`<p class="error-text">${escape(state.error)}</p><button class="button" data-inbox="refresh">Try again</button>`:'Loading saved tasks…'}</div>`;return;}
    const items=collection(),status=data.status;if(!items.some(item=>item.id===state.selectedId))state.selectedId=items[0]?.id||null;
    const saved=rememberFocus(),viewScroll=view.scrollTop||0,listScroll=$('.inbox-list')?.scrollTop||0,detailScroll=$('.inbox-detail')?.scrollTop||0;
    const markup=`<div class="inbox-toolbar"><div class="inbox-auto"><label><input type="checkbox" id="inbox-auto"${status.autoRun?' checked':''}${disabled()}>Run all saved tasks</label><span>${status.autoRun?'On · one saved task at a time.':'Off · saved tasks wait for Run now.'}</span></div><button class="button primary" data-inbox="new"${disabled()}>${icon('plus',14)}Add task</button></div><div class="inbox-progress" role="status"><div><strong>${status.pending}</strong> waiting<span class="inbox-dot">·</span><strong>${status.active}</strong> active<span class="inbox-dot">·</span><strong>${status.completed}</strong> completed</div><div>${queueControls()}</div></div>${status.paused?`<p class="inbox-notice">${escape(status.pauseReason||'Queued starts are paused.')} Run now starts only the task you choose.</p>`:''}${state.error||status.error?`<p class="inbox-error error-text" role="alert">${escape(state.error||status.error)}</p>`:''}<div class="inbox-layout"><aside class="inbox-sidebar"><div class="inbox-tabs" role="tablist" aria-label="Saved tasks"><button role="tab" id="inbox-tab-queued" aria-controls="inbox-panel" tabindex="${state.tab==='queued'?0:-1}" aria-selected="${state.tab==='queued'}" data-inbox="tab" data-tab="queued">Next${status.pending?` · ${status.pending}`:''}</button><button role="tab" id="inbox-tab-history" aria-controls="inbox-panel" tabindex="${state.tab==='history'?0:-1}" aria-selected="${state.tab==='history'}" data-inbox="tab" data-tab="history">History</button><button role="tab" id="inbox-tab-deleted" aria-controls="inbox-panel" tabindex="${state.tab==='deleted'?0:-1}" aria-selected="${state.tab==='deleted'}" data-inbox="tab" data-tab="deleted">Deleted</button></div><div id="inbox-panel" class="inbox-list" role="tabpanel" aria-labelledby="inbox-tab-${state.tab}" tabindex="0">${items.length?items.map(row).join(''):`<div class="inbox-empty compact">${state.tab==='queued'?'Nothing waiting.':state.tab==='history'?'Finished tasks appear here with their actual chat.':'Removed tasks stay available for restore.'}</div>`}</div></aside><section id="inbox-detail" class="inbox-detail" aria-label="Selected task">${detail()}</section></div><footer class="inbox-footer"><label><input type="checkbox" id="inbox-pause-failure"${data.settings.pauseOnFailure?' checked':''}${disabled()}>Pause queued starts after an error</label><button class="button" data-action="close-modal">Done</button></footer>`;
    if(markup===renderedMarkup)return;renderedMarkup=markup;view.innerHTML=markup;
    view.scrollTop=viewScroll;$('.inbox-list').scrollTop=listScroll;$('.inbox-detail').scrollTop=detailScroll;restoreFocus(saved);
  }
  function detail(){
    const item=selected();if(!item)return`<div class="inbox-empty"><span class="inbox-empty-mark">${icon('inbox',42)}</span><h3>Keep the next task ready.</h3><p>Each task keeps its working folder, model, and attached files. Automatic execution starts off. Interrupted work is never repeated blindly after a restart.</p><button class="button" data-inbox="new">${icon('plus',14)}Add a task</button></div>`;
    const queued=state.data.items.filter(value=>value.status==='queued'),position=queued.findIndex(value=>value.id===item.id),running=['running','dispatching'].includes(item.status),view=presentation(item),armed=view.scheduled&&!state.data.status.paused;
    const notice=running?'The agent is working on this task. Open its chat to follow along or stop it.':item.managedBy?'This task belongs to a saved operation. Manage its pause, execution and retries together in Schedules & jobs.':view.scheduled?(state.data.status.paused?'This task will run when you resume the queue.':'Runs when an agent slot opens. You can keep using BLACKICE.') : item.status==='queued'?'Saved for later. Choose Run now when you want it to start.':'';
    return`<div class="inbox-detail-heading"><span class="badge">${escape(view.label)}</span><span>${escape(time(item.createdAt))}</span></div><h3>${escape(item.title)}</h3><p class="inbox-config">${escape(configuration(item))}</p><div class="inbox-actions">
      ${item.status==='queued'&&!item.managedBy&&!item.retryHold?`<button class="button primary" data-inbox="run"${disabled()}>${icon('play',13)}Run now</button><button class="button subtle" data-inbox="move" data-direction="up"${position<=0||state.busy?' disabled':''}>Move up</button><button class="button subtle" data-inbox="move" data-direction="down"${position<0||position===queued.length-1||state.busy?' disabled':''}>Move down</button>`:''}
      ${['failed','cancelled','interrupted'].includes(item.status)&&!item.managedBy&&!item.retryHold?`<button class="button primary" data-inbox="retry"${disabled()}>Save to Next</button>`:''}
      ${item.status==='deleted'?`<button class="button" data-inbox="restore"${disabled()}>Restore task</button>`:`<button class="button" data-inbox="edit"${running||state.busy||item.managedBy?' disabled':''}>${armed?'Pause & edit':'Edit'}</button><button class="button subtle" data-inbox="delete"${running||state.busy?' disabled':''}>${icon('trash',13)}Remove</button>`}
      ${item.managedBy&&onOpenOperations?`<button class="button primary" data-inbox="operations">Manage operation</button>`:''}
      ${(item.retryHold?.runId||item.runId)&&onOpenRun?`<button class="button" data-inbox="open-run" data-run-id="${escape(item.retryHold?.runId||item.runId)}">${item.retryHold?'Open original chat':'Open chat'}</button>`:''}
    </div>${item.retryHold?`<p class="inbox-recovery" role="status">${escape(item.retryHold.message)}</p>`:''}${notice?`<p class="inbox-notice">${escape(notice)}</p>`:''}${item.error?`<p class="inbox-error error-text">${escape(item.error)}</p>`:''}<h4>Task</h4><div class="inbox-task-text">${escape(item.input)}</div><h4>Working folder</h4><p class="inbox-folder">${escape(item.cwd)}</p>${item.attempts.length?`<h4>Execution history</h4><div class="inbox-attempts">${[...item.attempts].reverse().map(attempt=>`<div><span>${escape(label(attempt.status))}<small>${escape(time(attempt.startedAt))}</small></span>${attempt.runId&&onOpenRun?`<button class="button subtle" data-inbox="open-run" data-run-id="${escape(attempt.runId)}">Open chat</button>`:''}${attempt.error?`<p>${escape(attempt.error)}</p>`:''}</div>`).join('')}</div>`:''}`;
  }
  function renderEditor(){
    const draft=state.draft;if(!alive()||!draft)return;const saved=rememberFocus(),scroll=view.scrollTop||0;renderedMarkup=null;
    $('#inbox-view').innerHTML=`<form id="inbox-editor"><div class="inbox-editor-heading"><h3>${state.editingId?'Edit saved task':'Capture a task'}</h3><p>Saving keeps this task in the inbox. Its saved model and attached files travel with it.</p></div>${state.error?`<p class="inbox-error error-text" role="alert">${escape(state.error)}</p>`:''}<label class="field"><span class="field-label">Title${state.editingId?'':' · optional'}</span><input id="inbox-title" maxlength="160" value="${escape(draft.title||'')}"${state.editingId?' required':''}${disabled()}></label><label class="field inbox-editor-task"><span class="field-label">What should the agent do?</span><textarea id="inbox-input" maxlength="50000" required rows="9" placeholder="Describe the next task, expected result, and anything the agent should check."${disabled()}>${escape(draft.input||'')}</textarea></label><label class="field"><span class="field-label">Working folder</span><input id="inbox-cwd" required value="${escape(draft.cwd||getCwd())}"${disabled()}></label><p class="inbox-config">${escape(configuration(draft))}</p><footer class="inbox-editor-footer"><button type="button" class="button" data-inbox="cancel-edit"${disabled()}>Cancel</button><button type="submit" class="button primary"${disabled()}>${icon('save',13)}Save to inbox</button></footer></form>`;
    if(state.editingId&&presentation(state.draft).scheduled)$('#inbox-editor')?.insertAdjacentHTML('afterbegin',`<div id="inbox-queue-edit-notice" class="inbox-notice" role="status">${editingQueued()?`This task is queued to run. <button type="button" class="button subtle" data-inbox="pause">Pause queue to edit</button>`:'Queued starts are paused. Save your changes, then resume the queue when ready.'}</div>`);
    renderDraftNotice();view.scrollTop=scroll;restoreFocus(saved);
  }
  function newDraft(value){if(state.draft)persistDraft();state.editingId=null;state.draft={title:'',input:'',...structuredClone(getDraft()||{}),cwd:getCwd(),...structuredClone(value||{})};state.context=draftWorkspace(state.draft.cwd||getCwd());state.draftKey=prefix(state.context)+draftKey('new',crypto.randomUUID());state.baseRevision=null;state.persisted=null;state.restored=false;state.incoming=null;state.storageError='';state.error='';persistDraft();render();$('#inbox-input')?.focus({preventScroll:true});}
  async function load(){const owner=state.view,request=++state.request;try{const data=await api('/api/inbox');if(request!==state.request||!owns(owner))return;state.data=data;state.error='';if(state.openTarget){const target=data.items.find(item=>item.id===state.openTarget);if(target){state.selectedId=target.id;state.tab=target.status==='deleted'?'deleted':active(target)?'queued':'history';}else state.error='This task is no longer in the inbox.';state.openTarget=null;}if(state.draft&&state.editingId){const live=data.items.find(item=>item.id===state.editingId);if(!live||live.status==='deleted'){removeItemDrafts(state.editingId);state.incoming=live||{status:'deleted'};}else if(live.revision!==state.baseRevision||['dispatching','running'].includes(live.status))state.incoming=live;}render();}catch(cause){if(request===state.request&&owns(owner)){state.error=cause.message;render();}}}
  async function action(operation,message){
    if(state.busy||!alive())return;const owner=state.view;state.busy=true;render();
    try{const result=await operation(()=>owns(owner));if(owns(owner)){state.error='';if(message)toast(message);await load();}return result;}
    catch(cause){if(owns(owner)){state.error=cause.message;toast(cause.message,true);}}
    finally{if(owns(owner)){state.busy=false;render();}}
  }
  document.addEventListener('input',event=>{if(!alive()||!state.draft)return;const field={ 'inbox-title':'title','inbox-input':'input','inbox-cwd':'cwd' }[event.target.id];if(field){state.draft[field]=event.target.value;persistDraft();renderDraftNotice();}});
  document.addEventListener('change',async event=>{if(!alive())return;if(event.target.id==='inbox-auto')await action(()=>api('/api/inbox/settings','POST',{autoRun:event.target.checked}));if(event.target.id==='inbox-pause-failure')await action(()=>api('/api/inbox/settings','POST',{pauseOnFailure:event.target.checked}));});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-inbox]');if(!button||!alive()||state.busy)return;const actionName=button.dataset.inbox,item=selected(),owner=state.view;
    if(actionName==='refresh')return load();if(actionName==='tab')return selectTab(button.dataset.tab);if(actionName==='select'){state.selectedId=button.dataset.id;render();return;}if(actionName==='new')return newDraft();if(actionName==='cancel-edit'){state.draft=null;state.editingId=null;state.error='';render();return;}
    if(actionName==='discard-draft'){draftStore.remove(state.draftKey,{expected:state.persisted});state.draft=null;state.editingId=null;state.draftKey=null;state.persisted=null;state.incoming=null;state.error='';render();return;}
    if(actionName==='resume-draft'){resumeDraft(draftStore.list(prefix(getCwd())).find(cached=>cached.key===button.dataset.key));return;}
    if(actionName==='use-saved'&&state.incoming){draftStore.remove(state.draftKey,{expected:state.persisted});state.draft=structuredClone(state.incoming);state.baseRevision=state.incoming.revision;state.incoming=null;state.persisted=null;state.restored=false;render();return;}
    if(actionName==='keep-draft'&&state.incoming){state.baseRevision=state.incoming.revision;state.draft.revision=state.incoming.revision;state.incoming=null;persistDraft();render();return;}
    if(actionName==='draft-as-new'){const oldKey=state.draftKey,previous=state.persisted;newDraft(draftData(state.draft));draftStore.remove(oldKey,{expected:previous});return;}
    if(actionName==='edit'&&item){
      let editable=item;if(presentation(editable).scheduled&&!state.data.status.paused){const paused=await action(()=>api('/api/inbox/pause','POST',{reason:'Queued starts paused so you can edit a task.'}));if(!paused||!owns(owner))return;editable=state.data.items.find(value=>value.id===item.id);}
      if(!editable||['dispatching','running','deleted'].includes(editable.status)||editable.managedBy){toast('This task started or changed before editing. Open its chat to continue.',true);return;}
      const key=prefix(editable.cwd)+draftKey('item',editable.id),cached=draftStore.load(key);if(cached&&resumeDraft({key,...cached}))return;state.editingId=editable.id;state.draft=structuredClone(editable);state.context=draftWorkspace(editable.cwd);state.draftKey=key;state.baseRevision=editable.revision;state.persisted=null;state.incoming=null;state.restored=false;state.error='';render();return;
    }
    if(actionName==='operations'){try{await onOpenOperations?.();}catch(cause){if(owns(owner))toast(cause.message,true);}return;}
    if(actionName==='open-run'){try{await onOpenRun?.(button.dataset.runId);}catch(cause){if(owns(owner))toast(`The chat could not open: ${cause.message}`,true);}return;}
    if(actionName==='pause')return action(()=>api('/api/inbox/pause','POST',{reason:'Queued starts paused from the task inbox.'}));if(actionName==='resume')return action(()=>api('/api/inbox/resume','POST',{}));
    if(!item)return;if(actionName==='run'){const result=await action(()=>api(`${endpoint(item.id)}/run`,'POST',{}),'Saved task started.');if(result?.run)try{await onRunStarted?.(result.run,{isCurrent:()=>owns(owner)});}catch(cause){if(owns(owner))toast(`The task started, but its view could not open: ${cause.message}`,true);}}
    if(actionName==='retry')await action(()=>api(`${endpoint(item.id)}/retry`,'POST',{}),'Task saved to Next.');if(actionName==='delete')await action(async()=>{const result=await api(endpoint(item.id),'DELETE',{});removeItemDrafts(item.id);return result;},'Task removed.');if(actionName==='restore')await action(()=>api(`${endpoint(item.id)}/restore`,'POST',{}),'Task restored.');
    if(actionName==='move'){const ids=state.data.items.filter(value=>value.status==='queued').map(value=>value.id),from=ids.indexOf(item.id),to=from+(button.dataset.direction==='up'?-1:1);if(from>=0&&to>=0&&to<ids.length){[ids[from],ids[to]]=[ids[to],ids[from]];await action(()=>api('/api/inbox/reorder','POST',{ids}));}}
  });
  function reconcileSave(saved,result,isCurrent){
    const {key,submitted,source}=saved,sameDraft=state.draftKey===key&&Boolean(state.draft),latest=sameDraft?state.draft:source,changed=JSON.stringify(draftData(latest))!==JSON.stringify(submitted.draft);
    draftStore.remove(key,{expected:submitted});
    if(sameDraft){
      if(!changed&&isCurrent()){
        state.draft=null;state.editingId=null;state.draftKey=null;state.persisted=null;state.incoming=null;state.selectedId=result.id;state.tab=active(result)?'queued':'history';
      }else{
        // A reopened copy of the originating draft becomes an edit of the saved
        // item. Its newer text stays intact and cannot create a duplicate task.
        state.editingId=result.id;state.baseRevision=result.revision;state.draft.revision=result.revision;state.incoming=null;persistDraft();
      }
    }else if(changed){
      const expected={...submitted,draft:draftData(latest)},cached=draftStore.load(key)?.data;
      if(JSON.stringify(cached)===JSON.stringify(expected)&&draftStore.remove(key,{expected}).removed)draftStore.save(key,{...expected,editingId:result.id,baseRevision:result.revision});
    }
  }
  document.addEventListener('submit',async event=>{
    if(event.target.id!=='inbox-editor'||!alive())return;event.preventDefault();
    if(state.busy||state.incoming||editingQueued()||pendingDraftSaves.has(state.draftKey))return;
    const draft=structuredClone(state.draft),editing=state.editingId,key=state.draftKey,saved={key,submitted:record(),source:state.draft};pendingDraftSaves.set(key,saved);
    try{await action(async isCurrent=>{
      const payload={input:draft.input,cwd:draft.cwd,...(draft.title?{title:draft.title}:{}),...(editing?{expectedRevision:saved.submitted.baseRevision}:{}),...(!editing?{...(draft.workflow?{workflow:draft.workflow}:{}),attachmentIds:draft.attachmentIds||[]}: {})};
      const result=await api(editing?endpoint(editing):'/api/inbox',editing?'PUT':'POST',payload);reconcileSave(saved,result,isCurrent);return result;
    },'Task saved to inbox.');}
    finally{if(pendingDraftSaves.get(key)===saved)pendingDraftSaves.delete(key);if(alive()&&state.draftKey===key)render();}
  });
  document.addEventListener('keydown',event=>{
    if(!alive())return;
    const tab=event.target.closest?.('[data-inbox="tab"]');
    if(tab&&tabs.includes(tab.dataset.tab)&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();event.stopPropagation();if(state.busy)return;
      const index=tabs.indexOf(tab.dataset.tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      selectTab(tabs[next],{focus:true});return;
    }
    if(!state.draft||!(event.ctrlKey||event.metaKey)||!['s','enter'].includes(event.key.toLowerCase()))return;
    event.preventDefault();event.stopPropagation();if(!state.busy&&!state.incoming&&!pendingDraftSaves.has(state.draftKey))$('#inbox-editor')?.requestSubmit();
  },true);
  function polling(){clearTimeout(poll);const owner=state.view;poll=setTimeout(async()=>{if(!owns(owner))return;if(!state.draft&&!state.busy)await load();if(owns(owner))polling();},1400);}
  function cancel(){if(state.draft)persistDraft();state.active=false;state.view++;state.request++;state.busy=false;state.openTarget=null;clearTimeout(poll);view=null;renderedMarkup=null;pendingFocus=null;}
  return{
    async open({draft,selectedId}={}){
      cancel();state.active=true;const owner=state.view;
      if(selectedId){state.draft=null;state.editingId=null;state.openTarget=selectedId;state.selectedId=selectedId;state.tab='queued';}
      else if(state.draft&&state.context!==draftWorkspace(getCwd())){state.draft=null;state.editingId=null;}
      showModal('inbox',`${header()}<div id="inbox-view" class="inbox-workspace" tabindex="-1"></div>`,true);view=$('#inbox-view');$('#modal-root .modal')?.classList.add('inbox-modal');
      if(draft)newDraft(draft);else render();await load();if(!owns(owner))return;
      if(!draft&&!selectedId&&!state.draft)for(const cached of savedDrafts())if(resumeDraft(cached))break;polling();
    },
    refresh(){if(alive()&&!state.busy&&!state.draft)return load();},cancel,close(){cancel();closeModal();}
  };
}
