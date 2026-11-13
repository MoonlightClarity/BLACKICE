import { createChatFrame, paintIndex, paintIntroduction, paintHistory, paintModels, captureChatScroll, restoreChatScroll } from './render.mjs';
import { createGroupedModelPicker } from '../core/model-picker.mjs';
import { enableProviderForModel } from '../../provider-availability.mjs';
import { summaries, filterSummaries, conversationRuns, rootId, lastRunId, running, planningProgressForRun, CHAT_INDEX_BATCH, CHAT_MESSAGE_BATCH, messageLimitsAfterRefresh, conversationBucket, conversationActionState, conversationManagementTarget, resolveConversationSelection, mergeChatRunUpdate, chatHeaderStatus, projectConversationGoal } from './model.mjs';
import {readConversationExecutionModes,saveConversationExecutionModes,transferNewExecutionModes} from './execution-preferences.mjs';
import { submitChat, replyState } from './send.mjs';
import {createGoalControls,parseGoalCommand} from './goals.mjs';
import { createConversationReader } from './reader-client.mjs';
import { initAttachmentsUI } from '../../attachments-ui.mjs';
import { escapeHTML } from '../core/dom.mjs';
import { normalizeChatOptions, validateChatOptions, restoreChatPlanningOptions, savedChatExecutionMode } from './options-model.mjs';
import { PLANNING_ONTOLOGY_MODULES, normalizePlanningOntology, PLANNING_MODULE_STATES } from '../../planning-module-policy.mjs';
import { readConversationOntology, saveConversationOntology, transferNewOntology, gridOntologyState, updatedGridOntology } from './ontology-preferences.mjs';
import { createConversationModelSelection, concreteChatModel } from './model.mjs';
import { createArtifactViewer, createDirectoryInspector } from './artifacts.mjs';
import { planningActivityForEvent, mergePlanningActivity, chatProgressPreview } from './planning-timeline.mjs';
import { createContextControls, conversationContext, contextStatistics, compactionStatistics } from '../core/context-controls.mjs';

export function createChatWorkspace({ mount, api, events, getStatus, notify = () => {}, onNavigate }) {
  const view = createChatFrame(mount);
  const modelPicker=createGroupedModelPicker({select:view.model,label:'Model',onSetupProvider:typeof onNavigate==='function'?id=>onNavigate('settings',{modelProviderId:id}):undefined,onEnableProvider:async id=>{
    const owner=root(),fresh=await enableProviderForModel(api,runtimeStatus,id);
    if(state.destroyed||!state.active||root()!==owner)return null;
    refreshChoices(fresh);return fresh;
  }});
  const reader = createConversationReader({api});
  const artifacts = createArtifactViewer({mount,api,notify});
  view.shell.dataset.reader=reader.usingWorker?'worker':'fallback';
  const modelSelections=createConversationModelSelection({storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}});
  const state = { active:false, selected:null, list:[], runs:[], bucket:'active', count:12,
    loading:false, pending:false, broken:false, connected:false, markdown:null, generation:0,
    refreshing:false, inputOwner:'new', drafts:new Map(), stream:[], liveTimer:null, listTimer:null,
    dataController:null, unsubscribe:null, lastLoadedAt:0,
    indexLimit:CHAT_INDEX_BATCH, indexQuery:'',messageLimits:new Map(),
    attachmentIds:new Map(), attachmentsPending:false,managing:false,selecting:false,selection:new Map(),visible:[],listRead:0,destroyed:false,inputRevision:0,
    options:{...restoreChatPlanningOptions((()=>{try{return JSON.parse(localStorage.getItem('blackice.next.chatOptions')||'{}');}catch{return{};}})(),getStatus?.()?.runtimeSettings?.planningOntology),model:'default'} };
  let goalControls=null;
  const directoryInspector=createDirectoryInspector({frame:view.shell,api,getConversationId:()=>state.selected,getRunId:()=>state.runs.at(-1)?.id||null});
  let newPlanningExecutionMode=state.options.planningExecutionMode;
  const executionNotice=mount.ownerDocument.createElement('section');
  executionNotice.setAttribute('id','next-chat-execution-notice');
  executionNotice.className='next-chat-cycle-notice';executionNotice.hidden=true;
  const executionExplanation=mount.ownerDocument.createElement('span');
  executionExplanation.textContent='This new draft was saved as Plan-only, which is retired. Automatic can run tools when you send. Saved requests are unchanged.';
  const enableAutomatic=mount.ownerDocument.createElement('button');
  enableAutomatic.setAttribute('id','next-chat-enable-automatic');enableAutomatic.setAttribute('type','button');
  enableAutomatic.textContent='Enable Automatic for new draft';
  executionNotice.append(executionExplanation,enableAutomatic);
  view.form.parentElement.insertBefore(executionNotice,view.form);
  const ontologyRows=new Map();
  const restoreOntology=(conversationId,runs=[])=>{
    const execution=readConversationExecutionModes({conversationId,runs,storage:localStorage});
    state.options.directoryMode=execution.directoryMode;state.options.subagentsMode=execution.subagentsMode;
    view.directoryMode.value=execution.directoryMode;
    const selected=readConversationOntology({conversationId,runs,storage:localStorage,
      defaults:runtimeStatus.runtimeSettings?.planningOntology});
    state.options.planningExecutionMode=savedChatExecutionMode(runs.at(-1),conversationId==='new'?newPlanningExecutionMode:'automatic');
    state.options.planningMode=selected.planningMode;
    state.options.planningOntology=selected.planningOntology;
    view.plan.value=selected.planningMode;
    reflectOntology();
  };
  const persistOntology=()=>saveConversationOntology({conversationId:root(),planningMode:state.options.planningMode,
    planningOntology:state.options.planningOntology,storage:localStorage});
  const commitOntology=(id,choice)=>{
    state.options.planningOntology=updatedGridOntology(state.options.planningOntology,id,choice);
    persistOntology();reflectOntology();
  };
  function reflectOntology(){
    const policy=normalizePlanningOntology(state.options.planningOntology);
    state.options.planningOntology=policy;
    const enabled=state.options.planningMode==='ontology';
    view.ontologyInline.hidden=!enabled;
    for(const [id,boxes] of ontologyRows){
      const selected=gridOntologyState(policy,id);
      for(const [choice,input] of boxes){input.checked=selected===choice;input.disabled=!enabled;}
    }
  }
  for(const module of PLANNING_ONTOLOGY_MODULES.filter(({id})=>id!=='subagents')){
    const card=mount.ownerDocument.createElement('div');
    card.className='next-chat-ontology-module';
    card.setAttribute('role','group');
    card.setAttribute('aria-label',module.label);
    const name=mount.ownerDocument.createElement('span');
    name.className='next-chat-ontology-name';name.textContent=module.label;name.title=module.description;
    const choices=mount.ownerDocument.createElement('span');choices.className='next-chat-ontology-choices';
    const boxes=new Map();
    for(const choice of PLANNING_MODULE_STATES){
      const label=mount.ownerDocument.createElement('label');
      label.className='next-chat-ontology-choice';label.title=module.label+' · '+choice;
      const input=mount.ownerDocument.createElement('input');input.setAttribute('type','checkbox');
      input.setAttribute('aria-label',module.label+' '+choice);
      const initial=choice==='on'?'On':'Off';
      const letter=mount.ownerDocument.createElement('span');letter.textContent=initial;
      label.append(input,letter);choices.append(label);boxes.set(choice,input);
      input.addEventListener('change',()=>{
        if(!input.checked){reflectOntology();return;}
        commitOntology(module.id,choice);
      });
    }
    card.append(name,choices);view.ontologyModules.append(card);ontologyRows.set(module.id,boxes);
  }
  view.ontologySave.addEventListener('click',async()=>{
    if(state.pending)return;
    view.ontologySave.disabled=true;view.ontologyStatus.textContent='Saving…';
    try{
      const saved=await api('/api/runtime/settings','POST',{planningOntology:normalizePlanningOntology(state.options.planningOntology)});
      if(saved?.planningOntology)runtimeStatus={...runtimeStatus,runtimeSettings:{...runtimeStatus.runtimeSettings,planningOntology:saved.planningOntology}};
      view.ontologyStatus.textContent='Saved.';
    }catch(error){view.ontologyStatus.textContent=error.message||'Could not save default.';}
    finally{view.ontologySave.disabled=false;}
  });
  reflectOntology();
  let runtimeStatus=getStatus?.()||{};
  const root = () => rootId(state.selected) || 'new';
  const selectedBucket=()=>state.selected?.state||state.bucket;
  const contextMount=mount.ownerDocument.createElement('section');
  view.form.parentElement.insertBefore(contextMount,view.form);
  const contextControls=createContextControls({mount:contextMount,id:'next-chat-context',automaticCompaction:true,api,
    onClose:()=>view.input.focus({preventScroll:true}),
    onOperationChange:()=>{if(!state.destroyed)updateHead();},
    onComplete:(target,result)=>{
      const run=state.runs.find(item=>item.id===target.runId),node=run?.nodes?.[target.nodeId];
      if(node){
        if(result.context)node.contextStatus=contextStatistics(result.context);
        if(result.compacted)node.lastCompaction=compactionStatistics({...result,at:new Date().toISOString()});
      }
      if(state.active&&state.selected&&state.runs.at(-1)?.id===target.runId)void open(state.selected,{refresh:true});
    }});
  contextControls.select('new',runtimeStatus.runtimeSettings?.defaultContext);
  function syncContext({select=false,reconcile=false}={}){
    const saved=conversationContext(state.runs,runtimeStatus.runtimeSettings?.defaultContext);
    if(select)contextControls.select(root(),saved.context);
    else if(reconcile)contextControls.reconcile(saved.context);
    contextControls.update({status:runtimeStatus,model:state.options.model,contextStatus:saved.contextStatus,
      lastCompaction:saved.lastCompaction,contextOrigin:saved.contextOrigin,target:saved.target,reason:saved.reason,
      busy:state.pending||state.managing,loading:state.loading,readonly:selectedBucket()!=='active'});
  }
  const refreshChoices=(status=getStatus?.()||runtimeStatus)=>{
    runtimeStatus=status;
    state.options.model=modelSelections.read(root(),state.runs).model;
    const choices=paintModels(view,status,state.options);
    modelPicker.update({models:choices.models,status,selected:choices.selected.model});
    state.options=normalizeChatOptions({model:view.model.value,effort:view.effort.value,
      serviceTier:view.tier.value,planningMode:view.plan.value,planningExecutionMode:view.executionMode.value,planningOntology:state.options.planningOntology,directoryMode:view.directoryMode.value});
    reflectOntology();
    if(!state.selected&&!contextControls.dirty)contextControls.reconcile(runtimeStatus.runtimeSettings?.defaultContext);
    syncContext();
  };
  const persistOptions=()=>{try{const {planningOntology,planningMode,directoryMode,subagentsMode,...general}=state.options;localStorage.setItem('blackice.next.chatOptions',JSON.stringify({...general,model:'default',planningExecutionMode:newPlanningExecutionMode}));}catch{}};
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
    saveDraft();
    state.inputOwner=key;
    view.input.value=state.drafts.get(key)??'';
    resize();
    attachmentsUI?.reset({cancelPending:false});
  };
  const resize = () => { view.input.style.height='auto';view.input.style.height=Math.min(180,Math.max(58,view.input.scrollHeight))+'px'; };
  const showError = error => { state.broken=true;view.hint.classList.add('next-chat-error');view.hint.textContent=String(error?.message||error||'An operation failed.'); };
  const hint = text => { state.broken=false;view.hint.classList.remove('next-chat-error');view.hint.textContent=text; };
  function consumeInput(owner,revision){
    if(state.inputOwner!==owner||state.inputRevision!==revision)return;
    view.input.value='';state.inputRevision++;resize();saveDraft();
  }
  const updateHead = () => {
    if(view.model.disabled!==state.pending){view.model.disabled=state.pending;refreshChoices(runtimeStatus);}
    syncContext();
    directoryInspector.refresh(state.selected?state.runs.at(-1)?.id:null);
    const item=state.selected,bucket=selectedBucket(),latest=state.runs.at(-1),busy=state.pending||state.managing||contextControls.isCompacting()||goalControls?.isBusy();
    goalControls?.update({conversationId:root(),running:state.runs.some(run=>run.status==='running'&&run.settled!==true),readonly:bucket!=='active',busy:state.pending||state.managing||state.loading});
    view.directoryMode.disabled=busy||state.loading||bucket!=='active';
    executionNotice.hidden=Boolean(item)||root()!=='new'||bucket!=='active'||state.options.planningExecutionMode!=='plan_only';
    enableAutomatic.disabled=busy||state.loading||state.attachmentsPending;
    view.title.textContent=item?.rootTitle||item?.title||'New conversation';
    const planningProgress=planningProgressForRun(latest);
    view.subtitle.textContent=(item&&bucket!=='active'?(bucket==='deleted'?'In Trash':bucket==='archived'?'Archived':'History state unavailable')+' · ':'')+chatHeaderStatus(latest,goalControls?.getGoal()||item?.goal);
    const cycle=latest?.responseCycle;
    const cycleLabel=planningProgress?.label;
    view.cycleNotice.hidden=bucket!=='active'||!planningProgress?.showNotice;
    view.cycleStatus.textContent=cycleLabel?cycleLabel+(cycle.title?' · '+cycle.title:''):'';
    // Opening the saved graph is read-only and remains available during work.
    view.openPlan.disabled=!cycle?.requestId;
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
    view.send.textContent=state.loading?'Loading…':next.active?'Direct':'Send';
    view.send.disabled=busy||state.loading||Boolean(item&&!state.runs.length)||state.attachmentsPending||bucket!=='active'||!next.canSend;
    view.input.disabled=bucket!=='active'||state.managing;
    view.input.placeholder=bucket==='active'?'Message BLACKICE…':'Restore this conversation to reply';
    drawManagement();
  };
  goalControls=createGoalControls({view,api,notify,onError:showError,onChange:updateHead,
    onGoalChange:(goal,owner)=>{
      const compact=projectConversationGoal(goal);
      state.list=state.list.map(item=>rootId(item)===owner?{...item,goal:compact}:item);
      if(state.selected&&root()===owner)state.selected={...state.selected,goal:compact};
      indexPaint();updateHead();
    },
    getContext:()=>({conversationId:root(),runId:state.runs.at(-1)?.id,draft:view.input.value,
      executionOptions:{...state.options,...(modelSelections.read(root(),state.runs).explicit?{}:{model:undefined}),
        ...(!state.runs.some(running)?{context:contextControls.read()}:{})}}),
    onStart:async(goal,options)=>{const result=await send({goal,taskOverride:goal.objective,consumeDraft:options.consumeDraft});if(!result)throw Error(view.hint.textContent||'Could not start the goal.');return result;},
    onResult:async(result,owner)=>{
      if(state.destroyed||!state.active||root()!==owner||state.pending||!state.selected)return;
      const item=result?.run?.id?{...state.selected,runId:result.run.id,latestRunId:result.run.id}:state.selected;
      await open(item,{refresh:true});
    }});
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
  // A burst of catalog events needs one current read and one newest follow-up,
  // not overlapping fetch/parse/sort/render work for the entire saved catalog.
  let listFlight=null,listController=null,listBucket=null,listRequested=false,listInitialize=null,listWaiters=[];
  function loadList({ initialize=false }={}) {
    if(!state.active||state.managing||state.destroyed)return Promise.resolve(false);
    state.listRead++;listRequested=true;
    if(initialize)listInitialize={bucket:state.bucket,generation:state.generation};
    const completion=new Promise(resolve=>listWaiters.push(resolve));
    if(listFlight){if(listBucket!==state.bucket)listController?.abort();}
    else void runListRead();
    return completion;
  }
  async function runListRead(){
    if(listFlight||!listRequested||!state.active||state.managing||state.destroyed)return;
    listRequested=false;
    const token=state.listRead,bucket=state.bucket,initial=listInitialize;
    listInitialize=null;listBucket=bucket;
    const controller=new AbortController();listController=controller;
    let loaded=false;
    listFlight=Promise.resolve().then(()=>api('/api/conversations?state='+encodeURIComponent(bucket),'GET',undefined,{signal:controller.signal}));
    try{
      const answer=await listFlight;
      if(!state.active||token!==state.listRead||bucket!==state.bucket||state.managing||controller.signal.aborted){
        if(initial&&listRequested&&!listInitialize&&initial.bucket===state.bucket&&initial.generation===state.generation)listInitialize=initial;
        return;
      }
      state.list=summaries(answer.conversations).map(item=>({...item,state:conversationBucket(item.state)||bucket}));indexPaint();
      const current=state.list.find(item=>rootId(item)===root());
      if(current){state.selected={...state.selected,...current};updateHead();}
      loaded=true;
      if(initial&&initial.bucket===state.bucket&&initial.generation===state.generation&&!state.selected){
        let remembered='';
        try{remembered=localStorage.getItem('blackice.next.selected')||localStorage.getItem('relay.mission.returnRun')||'';}catch{}
        const chosen=state.list.find(item=>rootId(item)===remembered||lastRunId(item)===remembered);
        if(chosen)await open(chosen);
      }
    }catch(error){
      if(state.active&&token===state.listRead&&!controller.signal.aborted){showError(error);notify('Could not load conversations: '+error.message,true);}
    }finally{
      listFlight=null;
      if(listController===controller)listController=null;
      if(listRequested&&state.active&&!state.managing&&!state.destroyed)void runListRead();
      else{
        listRequested=false;listInitialize=null;
        const waiters=listWaiters;listWaiters=[];for(const resolve of waiters)resolve(loaded);
      }
    }
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
    const position=preserve?captureChatScroll(view):{atBottom:true};
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
      getAttachment:id=>attachmentsUI.getMetadata(id),
      onStop:(kind,id)=>{void runAction(kind,id);},
      onArtifact:ref=>{void artifacts.open(ref).catch(showError);} });
    restoreChatScroll(view,position,{follow:!preserve});
    updateHead();
  }
  async function open(item,{refresh=false}={}) {
    if (!state.active||state.managing||(state.pending&&!refresh)) return;
    const id=rootId(item);
    state.generation++;
    state.dataController?.abort();
    const controller=new AbortController();state.dataController=controller;state.loading=true;
    state.selected=item;
    if(!refresh){clearTimeout(state.liveTimer);state.liveTimer=null;state.stream.length=0;
      state.runs=[];state.count=12;state.messageLimits.clear();choose(id);restoreOntology(id);
      contextControls.select(id,runtimeStatus.runtimeSettings?.defaultContext);
      attachmentsUI.refreshEditability();paintIntroduction(view,'Loading saved conversation…');}
    refreshChoices();updateHead();indexPaint();
    let family;
    try { family=await reader.load(lastRunId(item),{signal:controller.signal}); }
    catch(error){if(controller.signal.aborted||error.name==='AbortError')return;
      if(state.active&&state.dataController===controller){
        state.loading=false;updateHead();
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
    state.loading=false;
    state.selected={...state.selected,goal:projectConversationGoal(family.goal),...(family.state?{state:family.state}:{}),...(family.title?{title:family.title,rootTitle:family.title}:{})};
    const runs=conversationRuns(family);
    state.messageLimits=messageLimitsAfterRefresh(state.runs,runs,state.messageLimits);
    state.runs=runs;state.lastLoadedAt=Date.now();
    if(refresh)void goalControls.refresh();
    restoreOntology(id,runs);refreshChoices();syncContext({select:!refresh,reconcile:refresh});
    render({preserve:refresh});
    // Resolve names for stored attachment IDs without blocking the transcript.
    if(runs.some(run=>Array.isArray(run.attachmentIds)&&run.attachmentIds.length)) {
      void attachmentsUI.refresh().then(()=>{
        if(state.active&&!state.destroyed&&state.dataController===controller&&!controller.signal.aborted)
          render({preserve:true});
      }).catch(()=>{});
    }
    hint(runs.length?'Enter to send · Shift+Enter for a new line':'No saved response is available to continue. Try opening this conversation again.');
    try { localStorage.setItem('blackice.next.selected',id); } catch {}
    if(!state.markdown) void loadMarkdown();
  }
  function showNew({focus=true}={}) {
    if(state.managing)return;
    state.generation++;state.dataController?.abort();state.loading=false;
    clearTimeout(state.liveTimer);state.liveTimer=null;state.stream.length=0;
    state.selected=null;state.runs=[];state.count=12;state.messageLimits.clear();
    contextControls.select('new',runtimeStatus.runtimeSettings?.defaultContext);
    choose('new');restoreOntology('new');refreshChoices();attachmentsUI.refreshEditability();
    paintIntroduction(view);indexPaint();updateHead();
    if(focus)view.input.focus({preventScroll:true});
    try {localStorage.removeItem('blackice.next.selected');}catch{}
    hint('Enter to send · Shift+Enter for a new line');
  }
  async function runAction(kind,id) {
    if(state.pending||state.managing||contextControls.isCompacting()||!state.active)return;
    state.pending=true;updateHead();hint(kind==='retry'?'Starting retry…':'Requesting Stop…');
    try {
      const suffix=kind==='retry'?'retry':'cancel';
      const saved=state.runs.find(run=>run.id===id);
      if(kind==='retry'&&!saved)throw Error('The saved response is unavailable. Reopen it before retrying.');
      const payload=kind==='retry'?{context:{...conversationContext([saved]).context,autoCompact:true}}:{};
      await api('/api/runs/'+encodeURIComponent(id)+'/'+suffix,'POST',payload);
      notify(kind==='retry'?'Retry started.':'Stop requested.');
      await open(state.selected,{refresh:true});
    }catch(error){showError(error);}finally{state.pending=false;updateHead();}
  }
  async function send({goal,taskOverride,consumeDraft=true}={}) {
    if(state.pending||state.managing||contextControls.isCompacting()||state.attachmentsPending||selectedBucket()!=='active')return;
    if(state.selected&&(state.loading||!state.runs.length)){
      if(state.loading)hint('This conversation is still loading. Your draft is unchanged.');
      else showError('The saved conversation is unavailable. Retry opening it before sending; your draft is unchanged.');
      return;
    }
    const task=String(taskOverride??view.input.value).trim();if(!task)return;
    if(!goal){
      let command;
      try{command=parseGoalCommand(task);}catch(error){showError(error);return;}
      if(command){
        const owner=state.inputOwner,revision=state.inputRevision;
        try{const result=await goalControls.command(command);if(result)consumeInput(owner,revision);return result;}
        catch(error){showError(error);notify(error.message,true);return;}
      }
    }
    const submittedOwner=state.inputOwner,submittedRevision=state.inputRevision,submittedContextOwner=root();
    state.pending=true;updateHead();hint('Sending your message…');
    const previous=state.selected,current=state.runs;
    try {
      let status=getStatus?.();
      if(!status?.cwd)status=await api('/api/status');
      const submittedModel=modelSelections.read(submittedContextOwner,current),active=replyState(current).active;
      const options=active?normalizeChatOptions(state.options):validateChatOptions(status||{},state.options);
      const context=active?undefined:contextControls.read();
      const submittedContextRevision=contextControls.revision;
      const result=await submitChat({api,runs:current,task,model:previous&&!submittedModel.explicit?undefined:options.model,
        effort:options.effort,serviceTier:options.serviceTier,context,goal,
        planningMode:options.planningMode,planningOntology:options.planningOntology,directoryMode:options.directoryMode,planningExecutionMode:options.planningExecutionMode,attachmentIds:[...(state.attachmentIds.get(root())||[])],
        cwd:(()=>{try{return localStorage.getItem('blackice.next.cwd')||status?.cwd||'';}catch{return status?.cwd||'';}})()});
      const unchanged=consumeDraft&&state.inputOwner===submittedOwner&&state.inputRevision===submittedRevision;
      if(unchanged)consumeInput(submittedOwner,submittedRevision);
      else saveDraft();
      state.attachmentIds.set(root(),[]);persistAttachments();attachmentsUI.reset({cancelPending:false});
      if(result.mode==='direction') {
        hint(result.receipt.delivery==='rejected'?'Direction saved; live delivery was rejected.':result.receipt.delivery==='uncertain'?'Direction saved; live delivery is uncertain.':(result.receipt.queued===true||result.receipt.delivery==='queued')?'Direction queued.':'Direction delivered.');
      } else if(result.run?.id) {
        modelSelections.consume(submittedModel);
        const run=result.run;
        if(context!==undefined)contextControls.commit(submittedContextOwner,context,submittedContextRevision);
        const item=previous ? {...previous,runId:run.id,latestRunId:run.id}
          : {id:run.taskId||run.id,taskId:run.taskId||run.id,runId:run.id,title:task,updatedAt:new Date().toISOString(),status:run.status};
        if(!previous)transferNewExecutionModes({conversationId:rootId(item),storage:localStorage});
        if(!previous)transferNewOntology({conversationId:rootId(item),storage:localStorage});
        if(!previous&&!unchanged&&state.inputOwner===submittedOwner){state.drafts.set(rootId(item),view.input.value);state.drafts.set(submittedOwner,'');state.inputOwner=rootId(item);saveDraft();}
        if(state.bucket!=='active'){state.bucket='active';view.bucket.value='active';state.list=[];state.selection.clear();state.selecting=false;}
        item.state='active';state.list=summaries([item,...state.list.filter(entry=>rootId(entry)!==rootId(item))]);
        state.pending=false;
        await open(item);
        hint('Message sent. BLACKICE is working.');
      }else hint('Message accepted. Open the saved conversation to inspect the result.');
      void loadList();
      return result;
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
    // Raw deltas can be interim planning text. Keep their transient preview
    // small; the accepted message event renders the complete chat response and
    // retains interim messages in Details, without promoting them to answers.
    if(marker.dataset.streaming!=='true'){marker.dataset.streaming='true';marker.dataset.streamPreview='';}
    marker.dataset.streamPreview=(marker.dataset.streamPreview+append).slice(0,512);
    marker.textContent=chatProgressPreview(marker.dataset.streamPreview);
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
    if(goalControls.handleEvent(event))return;
    if(event.type==='goal.updated'){
      const {conversationId,goal}=event.data||{};
      state.list=state.list.map(item=>rootId(item)===conversationId?{...item,goal:projectConversationGoal(goal)}:item);
      indexPaint();return;
    }
    if(['conversations.changed','conversations.updated'].includes(event.type)) {
      clearTimeout(state.listTimer);state.listTimer=setTimeout(()=>{void loadList();},800);return;
    }
    if(event.type==='runtime.status'){runtimeStatus=event.data||runtimeStatus;if(root()==='new')restoreOntology('new');refreshChoices(runtimeStatus);updateHead();return;}
    if(event.type==='run.updated'){
      const updated=event.data?.run||event.data;
      const item=state.list.find(item=>lastRunId(item)===event.runId);
      if(item&&updated?.id===event.runId&&(item.status!==updated.status||item.settled!==updated.settled)){
        item.status=updated.status;item.settled=updated.settled;
        if(listFlight)void loadList();
        indexPaint();
      }
      if(lastRunId(state.selected)===event.runId&&updated?.id===event.runId)state.selected={...state.selected,status:updated.status,settled:updated.settled};
    }
    if(!event.runId || !state.runs.some(run=>run.id===event.runId))return;
    const data=event.data || {};
    const currentRun=state.runs.find(run=>run.id===event.runId);
    if(event.type==='agent.event'&&data.type==='thread'&&concreteChatModel(data.model)){
      const node=currentRun.nodes?.[event.nodeId];if(node)node.resolvedModel=data.model;
      refreshChoices();
    }
    if(event.type==='agent.event'&&data.type==='context'&&data.context){
      const node=currentRun.nodes?.[event.nodeId];
      if(node)node.contextStatus=contextStatistics(data.context);
      updateHead();
    }
    if(event.type==='node.updated'){
      const node=currentRun.nodes?.[event.nodeId],updated=data.node||data.state||data;
      if(node){
        if(updated.contextStatus)node.contextStatus=contextStatistics(updated.contextStatus);
        if(updated.lastCompaction)node.lastCompaction=compactionStatistics(updated.lastCompaction);
        if(concreteChatModel(updated.resolvedModel))node.resolvedModel=updated.resolvedModel;
      }
      refreshChoices();updateHead();
    }
    const nextOrder=()=>{
      const previous=currentRun.timelineOrder??Math.max(0,...(currentRun.planningActivity||[]).map(row=>row.order||0),currentRun.precomputedMessages?.at(-1)?.order||0);
      currentRun.timelineOrder=previous+1;return currentRun.timelineOrder;
    };
    if(event.type==='agent.event' && data.type==='task.state' && data.state){
      const current=currentRun;
      if(current && Number(data.state.revision)>Number(current.taskState?.revision||0)){
        current.planningActivity=mergePlanningActivity(current.planningActivity,
          planningActivityForEvent(current.id,event,current.taskState,nextOrder()));
        current.taskState=data.state;
        render({preserve:true});
      }
    }
    if(event.type==='agent.event' && data.type==='planning.reassessment'){
      if(data.module==='modular-outcome'){currentRun.outcomeRecoveryByNode||={};currentRun.outcomeRecoveryByNode[event.nodeId||'agent']=data.status;}
      currentRun.planningActivity=mergePlanningActivity(currentRun.planningActivity,
        planningActivityForEvent(currentRun.id,event,null,nextOrder()));
      render({preserve:true});
    }
    if(event.type==='agent.event' && data.type==='item' && data.stage==='started' && data.item?.type==='agentMessage'){
      const additions=planningActivityForEvent(currentRun.id,event,currentRun.taskState,nextOrder());
      if(additions.length){currentRun.planningActivity=mergePlanningActivity(currentRun.planningActivity,additions);render({preserve:true});}
    }
    if(event.type==='agent.event' && data.type==='steer' && data.accepted!==false && typeof data.text==='string' && data.text.trim()){
      const order=nextOrder(), nodeId=event.nodeId||'agent', id='direction:'+nodeId+':'+(event.at||order)+':'+data.text;
      const messages=currentRun.precomputedMessages ||= [];
      if(!messages.some(message=>message.id===id))messages.push({id,nodeId,role:'user',text:data.text,direction:true,delivery:data.delivery,at:event.at,order});
      render({preserve:true});
    }
    if(event.type==='agent.event' && data.type==='message' && typeof data.text==='string' && data.text.trim()){
      const current=state.runs.find(run=>run.id===event.runId);
      if(current){
        // Completion replaces its transient stream. A queued paint must not
        // append the same accepted answer again below its transcript section.
        if(current===state.runs.at(-1)){state.stream.length=0;clearTimeout(state.liveTimer);state.liveTimer=null;}
        const messages=current.precomputedMessages ||= [];
        const id=(event.nodeId||'agent')+':'+(data.itemId||('live-'+data.text.length+'-'+data.text.slice(0,24)));
        if(!messages.some(message=>message.id===id))
          messages.push({id,nodeId:event.nodeId||'agent',role:'assistant',text:data.text,
            phase:data.phase,provisional:data.provisional===true,at:event.at,order:nextOrder()});
        render({preserve:true});
      }
    }
    if(data.type==='delta'&&typeof data.delta==='string'&&event.runId===state.runs.at(-1)?.id)queueLive(data.delta);
    if(event.type==='run.updated') {
      const updated=data.run||data;
      if(updated?.id===event.runId) {
        const i=state.runs.findIndex(run=>run.id===event.runId);
        if(i>=0) {
          const old=state.runs[i];state.runs[i]=mergeChatRunUpdate(old,updated);
          if(updated.status==='failed')render({preserve:true});
          refreshChoices();
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
    [view.tier,'serviceTier'],[view.plan,'planningMode'],[view.executionMode,'planningExecutionMode'],[view.directoryMode,'directoryMode']])element?.addEventListener('change',()=>{
      if(key==='directoryMode'){
        if(element.disabled){restoreOntology(root(),state.runs);return;}
        try{saveConversationExecutionModes({conversationId:root(),...state.options,[key]:element.value,storage:localStorage});}
        catch(error){restoreOntology(root(),state.runs);showError(error);return;}
      }
      if(key==='model'){
        if(state.pending){refreshChoices(runtimeStatus);return;}
        try{state.options.model=modelSelections.choose(root(),element.value,runtimeStatus);}catch(error){refreshChoices();showError(error);return;}
      }else state.options[key]=element.value;
      if(key==='planningMode'||key==='planningExecutionMode')persistOntology();
      refreshChoices();persistOptions();
    });
  enableAutomatic.addEventListener('click',()=>{
    if(state.destroyed||!state.active||state.selected||root()!=='new'||selectedBucket()!=='active'||state.pending||state.managing||state.loading||state.attachmentsPending||contextControls.isCompacting()||state.options.planningExecutionMode!=='plan_only')return;
    newPlanningExecutionMode='automatic';state.options.planningExecutionMode='automatic';
    persistOptions();refreshChoices();updateHead();
    hint('Automatic enabled for this new draft. Send to start work.');
  });
  view.openPlan.addEventListener('click',()=>{const cycle=state.runs.at(-1)?.responseCycle;if(cycle?.requestId)onNavigate?.('planning',{requestId:cycle.requestId,nodeId:cycle.planRef?.nodeId});});
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
    if(event.isComposing)return;
    if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.isComposing) {
      event.preventDefault();void send();
    }
  });
  view.input.addEventListener('input',()=>{state.inputRevision++;resize();scheduleDraft();updateHead();});
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
      restoreOntology(root(),state.runs);
      refreshChoices();
      view.bucket.value=state.bucket;attachmentsUI.refreshEditability();
      if(state.selected){
        if(!state.runs.length||state.runs.some(running)||Date.now()-state.lastLoadedAt>30000)void open(state.selected,{refresh:true});
        void loadList();
      }
      else void loadList({initialize:true});
      updateHead();
    },
    leave() {

      goalControls.close();
      modelPicker.close({restoreFocus:false});
      state.active=false;state.generation++;state.listRead++;state.unsubscribe?.();state.unsubscribe=null;
      listRequested=false;listInitialize=null;listController?.abort();
      closeTrash();if(view.renameDialog.open){view.renameDialog.close();if(!state.managing)renameTarget=null;}
      state.dataController?.abort();state.loading=false;artifacts.cancel();
      clearTimeout(state.listTimer);clearTimeout(state.liveTimer);clearTimeout(settleTimer);
      clearTimeout(searchTimer);searchTimer=null;
      clearTimeout(draftTimer);saveDraft();
      state.stream.length=0;
    },
    updateStatus(status) {if(status&&typeof status==='object'&&!Array.isArray(status)){runtimeStatus=status;if(root()==='new')restoreOntology('new');refreshChoices(status);updateHead();}},
    openConversationId(id){if(!id)return;const item=state.list.find(row=>rootId(row)===id||lastRunId(row)===id)||{id,runId:id,title:'Conversation'};void open(item);},
    getState() {return {active:state.active,selected:root(),runCount:state.runs.length,listing:state.list.length,selectionCount:state.selection.size,managing:state.managing};},
    destroy(){this.leave();state.destroyed=true;goalControls.destroy();contextControls.destroy();directoryInspector.destroy();modelPicker.destroy();reader.close();artifacts.destroy();attachmentsUI.destroy();mount.innerHTML='';}
  };
}
