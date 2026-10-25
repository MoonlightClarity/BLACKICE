import { createChatFrame, paintIndex, paintIntroduction, paintHistory, paintModels } from './render.mjs';
import { summaries, filterSummaries, conversationRuns, rootId, lastRunId, running, CHAT_INDEX_BATCH, CHAT_MESSAGE_BATCH, messageLimitsAfterRefresh, conversationBucket, conversationActionState, conversationManagementTarget, resolveConversationSelection } from './model.mjs';
import { submitChat, replyState } from './send.mjs';
import { createConversationReader } from './reader-client.mjs';
import { initAttachmentsUI } from '../../attachments-ui.mjs';
import { escapeHTML } from '../core/dom.mjs';
import { normalizeChatOptions, validateChatOptions } from './options-model.mjs';
import { createArtifactViewer } from './artifacts.mjs';

export function createChatWorkspace({ mount, api, events, getStatus, notify = () => {} }) {
  const view = createChatFrame(mount);
  const reader = createConversationReader({api});
  const artifacts = createArtifactViewer({mount,api,notify});
  view.shell.dataset.reader=reader.usingWorker?'worker':'fallback';
  const state = { active:false, selected:null, list:[], runs:[], bucket:'active', count:12,
    loading:false, pending:false, broken:false, connected:false, markdown:null, generation:0,
    refreshing:false, inputOwner:'new', drafts:new Map(), stream:[], liveTimer:null, listTimer:null,
    dataController:null, unsubscribe:null, lastLoadedAt:0,
    indexLimit:CHAT_INDEX_BATCH, indexQuery:'',messageLimits:new Map(),
    attachmentIds:new Map(), attachmentsPending:false,managing:false,selecting:false,selection:new Map(),visible:[],listRead:0,destroyed:false,inputRevision:0,
    options:normalizeChatOptions((()=>{try{return JSON.parse(localStorage.getItem('blackice.next.chatOptions')||'{}');}catch{return{};}})()) };
  const root = () => rootId(state.selected) || 'new';
  const selectedBucket=()=>state.selected?.state||state.bucket;
  const refreshChoices=(status=getStatus?.()||{})=>{
    paintModels(view,status,state.options);
    state.options=normalizeChatOptions({model:view.model.value,effort:view.effort.value,
      serviceTier:view.tier.value,planningMode:view.plan.value});
  };
  const persistOptions=()=>{try{localStorage.setItem('blackice.next.chatOptions',JSON.stringify(state.options));}catch{}};
  try{const saved=JSON.parse(localStorage.getItem('blackice.next.drafts')||'{}');
    for(const [key,value] of Object.entries(saved))if(typeof value==='string'&&value.length<=10000)state.drafts.set(key,value);
  }catch{}
  view.input.value=state.drafts.get('new')||'';
  let draftTimer=null;
  const saveDraft=()=>{state.drafts.set(state.inputOwner,view.input.value);
    try{localStorage.setItem('blackice.next.drafts',JSON.stringify(Object.fromEntries([...state.drafts].slice(-50))));}catch{}};
  const scheduleDraft=()=>{clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,250);};
  const choose = key => {
    if (state.inputOwner === key) return;
    state.drafts.set(state.inputOwner,view.input.value);
    state.inputOwner=key;
    view.input.value=state.drafts.get(key)||'';
    resize();
  };
  const resize = () => { view.input.style.height='auto';view.input.style.height=Math.min(180,Math.max(58,view.input.scrollHeight))+'px'; };
  const showError = error => { state.broken=true;view.hint.classList.add('next-chat-error');view.hint.textContent=String(error?.message||error||'An operation failed.'); };
  const hint = text => { state.broken=false;view.hint.classList.remove('next-chat-error');view.hint.textContent=text; };
  const updateHead = () => {
    const item=state.selected,bucket=selectedBucket(),latest=state.runs.at(-1),busy=state.pending||state.managing;
    view.title.textContent=item?.rootTitle||item?.title||'New conversation';
    view.subtitle.textContent=(item&&bucket!=='active'?(bucket==='deleted'?'In Trash':bucket==='archived'?'Archived':'History state unavailable')+' · ':'')+(latest ? latest.status==='completed'?'Saved response':latest.status||'Saved':'Local workspace');
    view.archive.hidden=!item;
    view.archive.textContent=bucket==='active'?'Archive':'Restore';
    view.archive.disabled=busy||!conversationBucket(bucket);
    view.rename.hidden=!item||bucket==='deleted';
    view.rename.disabled=busy;
    view.trash.hidden=!item||bucket==='deleted';view.trash.disabled=busy||state.runs.some(running)||running(item)||!conversationBucket(bucket);
    view.trash.title=state.runs.some(running)||running(item)?'Stop this chat before moving it to Trash.':'';
    view.exports.hidden=!item;
    if(item)for(const [link,format]of [[view.exportMarkdown,'markdown'],[view.exportJson,'json']])link.href='/api/conversations/'+encodeURIComponent(lastRunId(item))+'/export?format='+format;
    view.stop.hidden=!state.runs.some(running);
    view.stop.disabled=busy;
    const next=replyState(state.runs);
    view.send.textContent=next.active?'Direct':'Send';
    view.send.disabled=busy||state.attachmentsPending||bucket!=='active'||!next.canSend;
    view.input.disabled=bucket!=='active'||state.managing;
    view.input.placeholder=bucket==='active'?'Message BLACKICE…':'Restore this conversation to reply';
    drawManagement();
  };
  let attachmentsUI;
  try {
    const saved=JSON.parse(localStorage.getItem('blackice.next.attachments')||'{}');
    for(const [key,value] of Object.entries(saved))if(Array.isArray(value)&&value.length<=10&&value.every(id=>typeof id==='string'&&/^file_[A-Za-z0-9_-]+$/.test(id)))state.attachmentIds.set(key,value);
  }catch{}
  const persistAttachments=()=>{try{localStorage.setItem('blackice.next.attachments',JSON.stringify(Object.fromEntries([...state.attachmentIds].slice(-50))));}catch{}};
  attachmentsUI=initAttachmentsUI({mount:view.attachments,api,getDraftKey:root,
    getIds:key=>state.attachmentIds.get(key)||[],
    setIds:async(ids,key)=>{state.attachmentIds.set(key,ids);persistAttachments();attachmentsUI?.refreshEditability();},
    onPendingChange:pending=>{state.attachmentsPending=pending;updateHead();if(pending)hint('Uploading files…');},
    canEdit:()=>!state.pending&&!state.managing&&selectedBucket()==='active',
    pickFiles:globalThis.window?.relayDesktop?.pickFiles?()=>window.relayDesktop.pickFiles():undefined,
    escape:escapeHTML,icon:()=>'',toast:notify});
  function indexPaint() {
    const query=view.search.value;
    if(query!==state.indexQuery){state.indexQuery=query;state.indexLimit=CHAT_INDEX_BATCH;}
    state.visible=paintIndex(view,filterSummaries(state.list,query),root(),item=>{view.shell.dataset.showList='false';void open(item);},{
      limit:state.indexLimit,
      onMore:()=>{state.indexLimit+=CHAT_INDEX_BATCH;indexPaint();},
      selecting:state.selecting,selection:state.selection,busy:state.managing||state.pending,
      onToggle:(item,checked)=>{if(state.managing)return;if(checked){const target=managementTarget(rootId(item));state.selection.set(target.id,{runId:target.runId,state:target.state});}else state.selection.delete(rootId(item));managementMessage('');drawManagement();},
      onAction:(item,action)=>action==='rename'?startRename(item):void requestManagement(action,selectionFor(item)),
    });
    drawManagement();
  }
  async function loadList({ initialize=false }={}) {
    if (!state.active||state.managing) return;
    const token=++state.listRead,bucket=state.bucket;
    try {
      const answer=await api('/api/conversations?state='+encodeURIComponent(state.bucket));
      if (!state.active||token!==state.listRead||bucket!==state.bucket||state.managing) return;
      state.list=summaries(answer.conversations).map(item=>({...item,state:conversationBucket(item.state)||bucket}));indexPaint();
      const current=state.list.find(item=>rootId(item)===root());
      if(current){state.selected={...state.selected,...current};updateHead();}
      if(initialize&&!state.selected) {
        let remembered='';
        try { remembered=localStorage.getItem('blackice.next.selected')||localStorage.getItem('relay.mission.returnRun')||''; } catch{}
        const chosen=state.list.find(item=>rootId(item)===remembered||lastRunId(item)===remembered);
        if(chosen) await open(chosen);
      }
    }catch(error){if(state.active&&token===state.listRead){showError(error);notify('Could not load conversations: '+error.message,true);}}
  }
  function managementTarget(id){
    const listed=state.list.find(item=>rootId(item)===id),selected=root()===id?state.selected:null;
    return conversationManagementTarget(listed||selected,state.bucket,selected?state.runs:[]);
  }
  function selectionFor(item){const target=managementTarget(rootId(item));return target?new Map([[target.id,{runId:target.runId,state:target.state}]]):new Map();}
  function managementMessage(text,error=false){view.managementStatus.hidden=!text;view.managementStatus.textContent=text;view.managementStatus.dataset.error=String(error);}
  function drawManagement(){
    const busy=state.managing||state.pending,count=state.selection.size;
    view.select.hidden=state.selecting;view.select.disabled=busy||!state.list.length;
    view.select.setAttribute('aria-expanded',String(state.selecting));view.bulk.hidden=!state.selecting;view.bulk.setAttribute('aria-busy',String(state.managing));
    view.bulkCount.textContent=state.managing?'Updating '+count+' selected…':count+' selected';
    const all=state.visible.length>0&&state.visible.every(item=>state.selection.has(rootId(item)));
    view.bulkAll.textContent=all?'Clear visible':'Select visible';view.bulkAll.disabled=busy||!state.visible.length;view.bulkCancel.disabled=busy;
    for(const [button,action]of [[view.bulkArchive,'archive'],[view.bulkRestore,'restore'],[view.bulkDelete,'delete']]){
      button.hidden=action==='archive'?state.bucket!=='active':action==='restore'?state.bucket==='active':state.bucket==='deleted';
      let problem='';try{resolveConversationSelection(state.selection,managementTarget,action);}catch(error){problem=error.message;}
      button.disabled=busy||Boolean(problem);button.title=problem;
    }
    view.bucket.disabled=state.managing||state.pending;view.search.disabled=state.managing;view.newButton.disabled=busy;
  }
  async function requestManagement(action,selection,{confirmed=false}={}){
    if(state.destroyed||!state.active||state.pending||state.managing)return;
    let targets;
    try{targets=resolveConversationSelection(selection,managementTarget,action);}
    catch(error){managementMessage(error.message,true);return;}
    if(action==='delete'&&!confirmed){
      trashSelection=new Map(selection);view.trashMessage.textContent=targets.length===1?'Move “'+targets[0].title+'” to Trash?':'Move '+targets.length+' selected chats to Trash?';
      view.trashDialog.showModal();return;
    }
    state.managing=true;++state.listRead;managementMessage('Updating conversations…');indexPaint();updateHead();attachmentsUI.refreshEditability();
    let completed=0;const failures=[];
    try{
      for(const original of targets){
        if(state.destroyed)break;
        try{
          const [current]=resolveConversationSelection(new Map([[original.id,original]]),managementTarget,action);
          await api('/api/conversations/'+encodeURIComponent(current.runId)+'/'+action,'POST',{});
          if(state.destroyed)break;
          const destination=conversationActionState(action);
          state.list=state.list.filter(item=>rootId(item)!==current.id);
          if(state.selected&&root()===current.id)state.selected={...state.selected,state:destination};
          if(destination===state.bucket)state.list=summaries([...state.list,{...original,state:destination}]);
          state.selection.delete(current.id);completed++;
        }catch(error){failures.push(String(error?.message||'Request failed.'));}
      }
      if(state.destroyed)return;
      const description=action==='archive'?'archived':action==='restore'?'restored':'moved to Trash';
      const result=(completed?completed+' '+(completed===1?'chat':'chats')+' '+description+'. ':'')+(failures.length?failures.length+' could not be changed. '+failures[0]:'');
      managementMessage(result,failures.length>0);if(completed)notify(completed+' '+(completed===1?'chat':'chats')+' '+description+'.');
      if(!state.selection.size)state.selecting=false;
    }finally{
      state.managing=false;
      if(!state.destroyed){indexPaint();updateHead();attachmentsUI.refreshEditability();if(state.active)void loadList();}
    }
  }
  let trashSelection=null,renameTarget=null;
  const closeTrash=()=>{trashSelection=null;if(view.trashDialog.open)view.trashDialog.close();};
  function startRename(item){
    if(state.pending||state.managing||state.destroyed)return;
    const target=managementTarget(rootId(item));if(!target||target.state==='deleted')return;
    renameTarget=target;view.renameInput.value=target.title;view.renameError.hidden=true;view.renameDialog.showModal();view.renameInput.focus();view.renameInput.select();
  }
  view.renameForm.addEventListener('submit',async event=>{
    event.preventDefault();if(!renameTarget||state.managing||state.pending)return;
    const target=renameTarget,current=managementTarget(target.id),title=view.renameInput.value.trim();
    if(!current||current.runId!==target.runId||current.state!==target.state){view.renameError.textContent='This chat changed. Close this dialog and try again.';view.renameError.hidden=false;return;}
    if(!title||title.length>120){view.renameError.textContent='Use a title of 1 to 120 characters.';view.renameError.hidden=false;return;}
    state.managing=true;++state.listRead;view.renameSave.disabled=true;view.renameCancel.disabled=true;view.renameInput.readOnly=true;drawManagement();updateHead();
    try{
      await api('/api/conversations/'+encodeURIComponent(target.runId)+'/rename','POST',{title});
      if(state.destroyed)return;
      state.list=state.list.map(item=>rootId(item)===target.id?{...item,title,rootTitle:title}:item);
      if(root()===target.id)state.selected={...state.selected,title,rootTitle:title};
      renameTarget=null;view.renameDialog.close();notify('Conversation renamed.');
    }catch(error){if(!state.destroyed){view.renameError.textContent=error.message;view.renameError.hidden=false;}}
    finally{state.managing=false;if(!state.destroyed){view.renameSave.disabled=false;view.renameCancel.disabled=false;view.renameInput.readOnly=false;indexPaint();updateHead();}}
  });
  view.renameCancel.addEventListener('click',()=>{renameTarget=null;view.renameDialog.close();});
  view.renameDialog.addEventListener('cancel',event=>{if(state.managing)event.preventDefault();else renameTarget=null;});
  view.trashCancel.addEventListener('click',closeTrash);
  view.trashDialog.addEventListener('cancel',()=>{trashSelection=null;});
  view.trashConfirm.addEventListener('click',()=>{const selection=trashSelection;closeTrash();if(selection)void requestManagement('delete',selection,{confirmed:true});});
  view.select.addEventListener('click',()=>{if(state.pending||state.managing)return;state.selecting=true;state.selection.clear();managementMessage('');indexPaint();});
  view.bulkCancel.addEventListener('click',()=>{if(state.managing)return;state.selecting=false;state.selection.clear();managementMessage('');indexPaint();view.select.focus();});
  view.bulkAll.addEventListener('click',()=>{
    if(state.managing||state.pending)return;
    const all=state.visible.length&&state.visible.every(item=>state.selection.has(rootId(item)));
    for(const item of state.visible){const target=managementTarget(rootId(item));if(all)state.selection.delete(target.id);else state.selection.set(target.id,{runId:target.runId,state:target.state});}
    managementMessage('');indexPaint();
  });
  for(const [button,action]of [[view.bulkArchive,'archive'],[view.bulkRestore,'restore'],[view.bulkDelete,'delete']])button.addEventListener('click',()=>void requestManagement(action,new Map(state.selection)));
  async function loadMarkdown() {
    if (state.markdown) return;
    try {
      const { renderMarkdown }=await import('../../editor-model.mjs');
      if (!state.active) return;
      state.markdown=renderMarkdown;
      if(state.runs.length) render({preserve:true});
    }catch { /* Plain, safely escaped messages remain readable. */ }
  }
  function render({preserve=false}={}) {
    const atBottom=view.scroll.scrollHeight-view.scroll.scrollTop-view.scroll.clientHeight<100;
    const lastTop=view.scroll.scrollTop,lastHeight=view.scroll.scrollHeight;
    paintHistory(view,state.runs,{count:state.count,markdown:state.markdown,
      onOlder:()=>{state.count=Math.min(state.runs.length,state.count+12);render({preserve:true});},
      onMoreMessages:id=>{
        const run=state.runs.find(item=>item.id===id);
        if(!run)return;
        const next=(state.messageLimits.get(id)||CHAT_MESSAGE_BATCH)+CHAT_MESSAGE_BATCH;
        state.messageLimits.set(id,next);
        render({preserve:true});
      },
      messageLimits:state.messageLimits,
      onStop:(kind,id)=>{void runAction(kind,id);},
      onArtifact:ref=>{void artifacts.open(ref).catch(showError);} });
    if(!preserve||atBottom)view.scroll.scrollTop=view.scroll.scrollHeight;
    else view.scroll.scrollTop=lastTop+Math.max(0,view.scroll.scrollHeight-lastHeight);
    updateHead();
  }
  async function open(item,{refresh=false}={}) {
    if (!state.active||state.managing||(state.pending&&!refresh)) return;
    const id=rootId(item);
    state.generation++;
    state.dataController?.abort();
    const controller=new AbortController();state.dataController=controller;
    state.selected=item;
    if(!refresh){clearTimeout(state.liveTimer);state.liveTimer=null;state.stream.length=0;
      state.runs=[];state.count=12;state.messageLimits.clear();choose(id);
      attachmentsUI.refreshEditability();paintIntroduction(view,'Loading saved conversation…');}
    updateHead();indexPaint();
    let family;
    try { family=await reader.load(lastRunId(item),{signal:controller.signal}); }
    catch(error){if(controller.signal.aborted||error.name==='AbortError')return;
      if(state.active&&state.dataController===controller){
        showError(error);
        view.timeline.replaceChildren();
        const panel=document.createElement('div');panel.className='next-chat-intro';
        const heading=document.createElement('h2');heading.textContent='Conversation history unavailable';
        const note=document.createElement('p');note.textContent=error.message+' Your saved work and ongoing agents are unaffected.';
        const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';
        retry.addEventListener('click',()=>void open(item));
        panel.append(heading,note,retry);view.timeline.append(panel);
      }
      return;}
    if(!state.active||state.dataController!==controller||controller.signal.aborted) return;
    state.selected={...state.selected,...(family.state?{state:family.state}:{}),...(family.title?{title:family.title,rootTitle:family.title}:{})};
    const runs=conversationRuns(family);
    state.messageLimits=messageLimitsAfterRefresh(state.runs,runs,state.messageLimits);
    state.runs=runs;state.lastLoadedAt=Date.now();
    render({preserve:refresh});hint('Enter to send · Shift+Enter for a new line');
    try { localStorage.setItem('blackice.next.selected',id); } catch {}
    if(!state.markdown) void loadMarkdown();
  }
  function showNew({focus=true}={}) {
    if(state.managing)return;
    state.generation++;state.dataController?.abort();
    clearTimeout(state.liveTimer);state.liveTimer=null;state.stream.length=0;
    state.selected=null;state.runs=[];state.count=12;state.messageLimits.clear();
    choose('new');attachmentsUI.refreshEditability();
    paintIntroduction(view);indexPaint();updateHead();
    if(focus)view.input.focus({preventScroll:true});
    try {localStorage.removeItem('blackice.next.selected');}catch{}
    hint('Enter to send · Shift+Enter for a new line');
  }
  async function runAction(kind,id) {
    if(state.pending||state.managing||!state.active)return;
    state.pending=true;updateHead();hint(kind==='retry'?'Starting retry…':'Requesting Stop…');
    try {
      const suffix=kind==='retry'?'retry':'cancel';
      await api('/api/runs/'+encodeURIComponent(id)+'/'+suffix,'POST',{});
      notify(kind==='retry'?'Retry started.':'Stop requested.');
      await open(state.selected,{refresh:true});
    }catch(error){showError(error);}finally{state.pending=false;updateHead();}
  }
  async function send() {
    if(state.pending||state.managing||state.attachmentsPending||selectedBucket()!=='active')return;
    const task=view.input.value.trim();if(!task)return;
    const submittedOwner=state.inputOwner,submittedRevision=state.inputRevision;
    state.pending=true;updateHead();hint('Sending your message…');
    const previous=state.selected,current=state.runs;
    try {
      let status=getStatus?.();
      if(!status?.cwd)status=await api('/api/status');
      const options=validateChatOptions(status||{},state.options);
      const result=await submitChat({api,runs:current,task,model:options.model,
        effort:options.effort,serviceTier:options.serviceTier,
        planningMode:options.planningMode,attachmentIds:[...(state.attachmentIds.get(root())||[])],
        cwd:(()=>{try{return localStorage.getItem('blackice.next.cwd')||status?.cwd||'';}catch{return status?.cwd||'';}})()});
      const unchanged=state.inputOwner===submittedOwner&&state.inputRevision===submittedRevision;
      if(unchanged){state.drafts.set(submittedOwner,'');view.input.value='';resize();saveDraft();}
      else saveDraft();
      state.attachmentIds.set(root(),[]);persistAttachments();attachmentsUI.reset({cancelPending:false});
      if(result.mode==='direction') {
        hint(result.receipt.delivery==='queued'?'Direction queued.':'Direction delivered.');
      } else if(result.run?.id) {
        const run=result.run;
        const item=previous ? {...previous,runId:run.id,latestRunId:run.id}
          : {id:run.taskId||run.id,taskId:run.taskId||run.id,runId:run.id,title:task,updatedAt:new Date().toISOString(),status:run.status};
        if(!previous&&!unchanged&&state.inputOwner===submittedOwner){state.drafts.set(rootId(item),view.input.value);state.drafts.set(submittedOwner,'');state.inputOwner=rootId(item);saveDraft();}
        if(state.bucket!=='active'){state.bucket='active';view.bucket.value='active';state.list=[];state.selection.clear();state.selecting=false;}
        item.state='active';state.list=summaries([item,...state.list.filter(entry=>rootId(entry)!==rootId(item))]);
        state.pending=false;
        await open(item);
        hint('Message sent. BLACKICE is working.');
      }else hint('Message accepted. Open the saved conversation to inspect the result.');
      void loadList();
    } catch(error) {showError(error);notify(error.message,true);}
    finally {state.pending=false;updateHead();}
  }
  function paintLive() {
    state.liveTimer=null;
    if (!state.active || !state.stream.length) {state.stream.length=0;return;}
    const append=state.stream.join('');state.stream.length=0;
    const latest=state.runs.at(-1);
    if(!latest)return;
    const marker=[...view.timeline.querySelectorAll('[data-live-output]')].find(node=>node.dataset.liveOutput===latest.id);
    if(!marker)return;
    if(marker.dataset.streaming!=='true'){marker.dataset.streaming='true';marker.textContent='';marker.classList.add('next-message-body','streaming');}
    marker.append(marker.ownerDocument.createTextNode(append));
    const atBottom=view.scroll.scrollHeight-view.scroll.scrollTop-view.scroll.clientHeight<140;
    if(atBottom)view.scroll.scrollTop=view.scroll.scrollHeight;
  }
  function queueLive(chunk) {
    if(!chunk || typeof chunk!=='string')return;
    state.stream.push(chunk);
    if(!state.liveTimer)state.liveTimer=setTimeout(paintLive,85);
  }
  let settleTimer=null;
  function onEvent(event) {
    if(!state.active)return;
    if(['conversations.changed','conversations.updated'].includes(event.type)) {
      clearTimeout(state.listTimer);state.listTimer=setTimeout(()=>{void loadList();},800);return;
    }
    if(event.type==='runtime.status')return;
    if(event.type==='run.updated'){
      const updated=event.data?.run||event.data;
      const item=state.list.find(item=>lastRunId(item)===event.runId);
      if(item&&updated?.id===event.runId){item.status=updated.status;item.settled=updated.settled;indexPaint();}
      if(lastRunId(state.selected)===event.runId&&updated?.id===event.runId)state.selected={...state.selected,status:updated.status,settled:updated.settled};
    }
    if(!event.runId || !state.runs.some(run=>run.id===event.runId))return;
    const data=event.data || {};
    if(data.type==='delta'&&typeof data.delta==='string'&&event.runId===state.runs.at(-1)?.id)queueLive(data.delta);
    if(event.type==='run.updated') {
      const updated=data.run||data;
      if(updated?.id===event.runId) {
        const i=state.runs.findIndex(run=>run.id===event.runId);
        if(i>=0) {
          const old=state.runs[i];state.runs[i]={...old,status:updated.status,settled:updated.settled,
            nodes:updated.nodes||old.nodes,output:updated.output??old.output,updatedAt:updated.updatedAt||old.updatedAt};
          if(!running(updated)&&running(old)) {
            clearTimeout(settleTimer);
            settleTimer=setTimeout(()=>{if(state.active&&state.selected)void open(state.selected,{refresh:true});},220);
          }
          updateHead();
        }
      }
    }
    if(event.type==='node.updated'&&data.status==='completed') {
      clearTimeout(settleTimer);
      settleTimer=setTimeout(()=>{if(state.active&&state.selected)void open(state.selected,{refresh:true});},650);
    }
  }
  for(const [element,key] of [[view.model,'model'],[view.effort,'effort'],
    [view.tier,'serviceTier'],[view.plan,'planningMode']])element?.addEventListener('change',()=>{
      state.options[key]=element.value;refreshChoices();persistOptions();
    });
  view.newButton.addEventListener('click',()=>{if(state.pending||state.managing)return;const changed=state.bucket!=='active';state.bucket='active';view.bucket.value='active';state.selection.clear();state.selecting=false;if(changed){state.list=[];state.indexLimit=CHAT_INDEX_BATCH;}showNew();if(changed)void loadList();});
  // Search the full lightweight catalog after typing settles, but paint only
  // a bounded batch. A keystroke never synchronously rebuilds the sidebar.
  let searchTimer=null;
  view.search.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{searchTimer=null;indexPaint();},95);
  });
  view.bucket.addEventListener('change',()=>{
    if(state.managing||state.pending){view.bucket.value=state.bucket;return;}
    state.selecting=false;state.selection.clear();managementMessage('');closeTrash();
    state.bucket=view.bucket.value;state.list=[];state.indexLimit=CHAT_INDEX_BATCH;
      state.generation++;showNew({focus:false});void loadList();
  });
  view.form.addEventListener('submit',event=>{event.preventDefault();void send();});
  view.input.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.isComposing) {
      event.preventDefault();void send();
    }
  });
  view.input.addEventListener('input',()=>{state.inputRevision++;resize();scheduleDraft();});
  view.list.addEventListener('click',event=>{for(const menu of view.list.querySelectorAll('.next-conversation-actions[open]'))if(!menu.contains(event.target))menu.open=false;});
  view.list.addEventListener('toggle',event=>{if(event.target.matches?.('.next-conversation-actions[open]'))event.target.querySelector('.next-conversation-menu')?.scrollIntoView({block:'nearest'});},true);
  view.list.addEventListener('keydown',event=>{
    if(event.key==='Escape'){for(const menu of view.list.querySelectorAll('.next-conversation-actions[open]')){menu.open=false;menu.querySelector('summary')?.focus();}return;}
    const row=event.target.closest?.('.next-conversation-row'),button=row?.querySelector('.next-conversation');
    if(!button||state.pending||state.managing)return;
    if(event.key==='F2'){event.preventDefault();const item=state.list.find(item=>rootId(item)===button.dataset.conversation);if(item)startRename(item);}
    if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){const menu=row.querySelector('.next-conversation-actions');if(menu){event.preventDefault();menu.open=true;menu.querySelector('button')?.focus();}}
  });
  view.list.addEventListener('contextmenu',event=>{
    const row=event.target.closest?.('.next-conversation-row'),menu=row?.querySelector('.next-conversation-actions');
    if(menu&&!state.pending&&!state.managing){event.preventDefault();for(const other of view.list.querySelectorAll('.next-conversation-actions[open]'))other.open=false;menu.open=true;menu.querySelector('button')?.focus();}
  });
  view.archive.addEventListener('click',()=>{if(state.selected)void requestManagement(selectedBucket()==='active'?'archive':'restore',selectionFor(state.selected));});
  view.trash.addEventListener('click',()=>{if(state.selected)void requestManagement('delete',selectionFor(state.selected));});
  view.rename.addEventListener('click',()=>{if(state.selected)startRename(state.selected);});
  view.stop.addEventListener('click',()=>{const target=state.runs.findLast(running);if(target)void runAction('stop',target.id);});
  view.mobileList.addEventListener('click',()=>{view.shell.dataset.showList=view.shell.dataset.showList==='true'?'false':'true';});
  return {
    enter() {
      if(state.active||state.destroyed)return;
      state.active=true;
      state.unsubscribe=events.subscribe(onEvent);
      refreshChoices();
      view.bucket.value=state.bucket;attachmentsUI.refreshEditability();
      if(state.selected){
        if(state.runs.some(running)||Date.now()-state.lastLoadedAt>30000)void open(state.selected,{refresh:true});
        void loadList();
      }
      else void loadList({initialize:true});
      updateHead();
    },
    leave() {
      state.active=false;state.generation++;state.listRead++;state.unsubscribe?.();state.unsubscribe=null;
      closeTrash();if(view.renameDialog.open){view.renameDialog.close();if(!state.managing)renameTarget=null;}
      state.dataController?.abort();artifacts.cancel();
      clearTimeout(state.listTimer);clearTimeout(state.liveTimer);clearTimeout(settleTimer);
      clearTimeout(searchTimer);searchTimer=null;
      clearTimeout(draftTimer);saveDraft();
      state.stream.length=0;
    },
    updateStatus(status) {refreshChoices(status);},
    openConversationId(id){if(!id)return;const item=state.list.find(row=>rootId(row)===id||lastRunId(row)===id)||{id,runId:id,title:'Conversation'};void open(item);},
    getState() {return {active:state.active,selected:root(),runCount:state.runs.length,listing:state.list.length,selectionCount:state.selection.size,managing:state.managing};},
    destroy(){this.leave();state.destroyed=true;reader.close();artifacts.destroy();attachmentsUI.destroy();mount.innerHTML='';}
  };
}
