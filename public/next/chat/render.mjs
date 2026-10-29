import { text, formatDate } from '../core/dom.mjs';
import { runText, messagesOfRun, windowedRuns, windowedMessages, CHAT_MESSAGE_BATCH, rootId, lastRunId, running, CHAT_INDEX_BATCH, conversationIndexWindow } from './model.mjs';
import { chatOptionChoices } from './options-model.mjs';
import { createRegisteredArtifactResolver } from '../../conversation-model.mjs';
import { taskPlanView } from '../../task-plan-model.mjs';
import { chatTimeline } from './planning-timeline.mjs';

export function createChatFrame(mount) {
  mount.innerHTML = [
    '<div class="next-chat" id="next-chat"><aside class="next-chat-sidebar">',
    '<div class="next-sidebar-head"><div class="next-sidebar-row"><strong>Conversations</strong><button id="next-chat-new" type="button">+ New</button></div>',
    '<input class="next-field next-sidebar-search" type="search" id="next-chat-search" placeholder="Search" aria-label="Find a conversation">',
    '<select class="next-field next-sidebar-filter" id="next-chat-bucket" aria-label="Conversation view">',
    '<option value="active">Active</option><option value="archived">Archive</option><option value="deleted">Trash</option></select>',
    '<button id="next-chat-select" type="button" aria-controls="next-chat-bulk" aria-expanded="false">Multi-select</button>',
    '<section id="next-chat-bulk" class="next-chat-bulk" aria-label="Selected conversations" hidden>',
    '<div class="next-chat-bulk-heading"><span id="next-chat-bulk-count" role="status">0 selected</span><button id="next-chat-bulk-cancel" type="button">Cancel</button></div>',
    '<button id="next-chat-bulk-all" type="button">Select visible</button>',
    '<div class="next-chat-bulk-actions"><button id="next-chat-bulk-archive" type="button" disabled>Archive</button>',
    '<button id="next-chat-bulk-restore" type="button" hidden disabled>Restore</button>',
    '<button id="next-chat-bulk-delete" type="button" disabled>Move to Trash</button></div></section>',
    '<p id="next-chat-management-status" class="next-chat-management-status" role="status" hidden></p></div>',
    '<div class="next-conversation-list" id="next-chat-list"></div></aside>',
    '<div class="next-chat-main"><header class="next-chat-head">',
    '<button id="next-chat-mobile-list" type="button" hidden>Chats</button>',
    '<div class="next-chat-heading"><strong id="next-chat-title">New conversation</strong><small id="next-chat-subtitle">Local workspace</small></div>',
    '<div class="next-chat-head-actions"><button type="button" id="next-chat-rename" hidden>Rename</button>',
    '<button type="button" id="next-chat-archive" hidden>Archive</button>',
    '<button type="button" id="next-chat-delete" hidden>Move to Trash</button>',
    '<details id="next-chat-export" class="next-chat-export" hidden><summary>Export</summary><div>',
    '<a id="next-chat-export-markdown" download>Markdown</a><a id="next-chat-export-json" download>JSON</a></div></details>',
    '<button type="button" id="next-chat-stop" hidden>Stop</button></div></header>',
    '<div class="next-chat-scroll" id="next-chat-scroll"><div class="next-chat-timeline" id="next-chat-timeline">',
    '<div class="next-chat-intro"><h1>What would you like to work on?</h1><p>BLACKICE can use your local workspace, tools, and connected services. Start a conversation or return to saved work.</p></div>',
    '</div></div><footer class="next-chat-composer-area"><form class="next-chat-compose" id="next-chat-form">',
    '<textarea id="next-chat-input" class="next-chat-input" aria-label="Message BLACKICE" placeholder="Message BLACKICE…" rows="2"></textarea>',
    '<div id="next-chat-attachments"></div>',
    '<div class="next-chat-options"><label>Model <select id="next-chat-model"><option value="default">Default</option></select></label>',
    '<label>Reasoning <select id="next-chat-effort"><option value="default">Model default</option></select></label>',
    '<label>Speed <select id="next-chat-tier"><option value="default">Standard</option></select></label>',
    '<label>Planning <select id="next-chat-plan"><option value="on">On</option><option value="off">Off</option></select></label>',
    '<span class="next-chat-spacer"></span><button class="next-primary" type="submit" id="next-chat-send">Send</button></div></form>',
    '<p id="next-chat-hint" class="next-chat-hint" role="status">Enter to send · Shift+Enter for a new line</p>',
    '</footer></div>',
    '<dialog id="next-chat-trash-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-trash-title">',
    '<h2 id="next-chat-trash-title">Move to Trash?</h2><p id="next-chat-trash-message"></p><p>You can restore chats from Trash. Saved messages and files are preserved.</p>',
    '<div class="next-chat-dialog-actions"><button id="next-chat-trash-cancel" type="button" autofocus>Cancel</button><button id="next-chat-trash-confirm" type="button">Move to Trash</button></div></dialog>',
    '<dialog id="next-chat-rename-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-rename-title">',
    '<form id="next-chat-rename-form"><h2 id="next-chat-rename-title">Rename chat</h2><label class="next-label">Chat title<input id="next-chat-rename-input" class="next-field" maxlength="120" required></label>',
    '<p id="next-chat-rename-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button id="next-chat-rename-cancel" type="button">Cancel</button><button id="next-chat-rename-save" type="submit" class="next-primary">Save</button></div></form></dialog>',
    '</div>',
  ].join('');
  const find = id => mount.querySelector('#'+id);
  return { shell:find('next-chat'),list:find('next-chat-list'),search:find('next-chat-search'),bucket:find('next-chat-bucket'),
    newButton:find('next-chat-new'),mobileList:find('next-chat-mobile-list'),
    title:find('next-chat-title'),subtitle:find('next-chat-subtitle'),rename:find('next-chat-rename'),archive:find('next-chat-archive'),
    trash:find('next-chat-delete'),exports:find('next-chat-export'),exportMarkdown:find('next-chat-export-markdown'),exportJson:find('next-chat-export-json'),
    select:find('next-chat-select'),bulk:find('next-chat-bulk'),bulkCount:find('next-chat-bulk-count'),bulkCancel:find('next-chat-bulk-cancel'),bulkAll:find('next-chat-bulk-all'),
    bulkArchive:find('next-chat-bulk-archive'),bulkRestore:find('next-chat-bulk-restore'),bulkDelete:find('next-chat-bulk-delete'),managementStatus:find('next-chat-management-status'),
    trashDialog:find('next-chat-trash-dialog'),trashMessage:find('next-chat-trash-message'),trashCancel:find('next-chat-trash-cancel'),trashConfirm:find('next-chat-trash-confirm'),
    renameDialog:find('next-chat-rename-dialog'),renameForm:find('next-chat-rename-form'),renameInput:find('next-chat-rename-input'),renameError:find('next-chat-rename-error'),renameCancel:find('next-chat-rename-cancel'),renameSave:find('next-chat-rename-save'),
    stop:find('next-chat-stop'),scroll:find('next-chat-scroll'),timeline:find('next-chat-timeline'),
    form:find('next-chat-form'),input:find('next-chat-input'),attachments:find('next-chat-attachments'),model:find('next-chat-model'),plan:find('next-chat-plan'),
    effort:find('next-chat-effort'),tier:find('next-chat-tier'),send:find('next-chat-send'),hint:find('next-chat-hint') };
}

// Keep DOM identity while live metadata changes. The cache contains only the
// exposed window, so the full searchable catalog never becomes a DOM cache.
const indexViews = new WeakMap();

export function paintIndex(view, items, chosen, onSelect, {limit=CHAT_INDEX_BATCH,onMore,selecting=false,selection=new Map(),onToggle,onAction,busy=false}={}) {
  const list=view.list,doc=list.ownerDocument;
  let cache=indexViews.get(list);
  if(!cache){cache={rows:new Map()};indexViews.set(list,cache);}
  cache.onMore=onMore;
  const {shown,hidden,pinned}=conversationIndexWindow(items,limit,chosen);
  const visible=pinned?[pinned,...shown]:shown,order=[],retained=new Set();
  const focused=list.contains(doc.activeElement)?doc.activeElement:null,scrollTop=list.scrollTop;
  const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  const marker=(key,label,className,tag='p')=>{
    if(!cache[key]){const node=doc.createElement(tag);node.className=className;cache[key]=node;}
    setText(cache[key],label);return cache[key];
  };
  if(!items.length)order.push(marker('empty','No conversations here.','next-chat-placeholder'));
  if(pinned)order.push(marker('pinned','Current conversation','next-conversation-pinned-label'));
  for(const item of visible){
    const id=rootId(item),title=String(item.rootTitle||item.title||'Conversation');
    const bucket=item.state||'active',actions=Boolean(onAction)&&!selecting;
    let entry=cache.rows.get(id);
    if(!entry||entry.selecting!==selecting||entry.hasActions!==actions||entry.bucket!==bucket){
      const row=doc.createElement('div');row.className='next-conversation-row';
      entry={row,selecting,hasActions:actions,bucket,controls:new Map(),exports:[]};
      cache.rows.set(id,entry);
      if(selecting){
        const choice=text(row,'','label','next-conversation-choice');
        const check=text(choice,'','input');check.type='checkbox';check.dataset.chatSelect=id;
        entry.check=check;
        check.addEventListener('change',()=>entry.onToggle?.(entry.item,check.checked));
      }
      const button=text(row,'','button','next-conversation');
      button.type='button';button.dataset.conversation=id;
      entry.button=button;entry.titleNode=text(button,'','span','next-conversation-title');
      const foot=text(button,'','span','next-conversation-meta');
      entry.statusNode=text(foot,'');entry.dateNode=text(foot,'');
      button.addEventListener('click',()=>entry.onSelect?.(entry.item));
      if(actions){
        const menu=text(row,'','details','next-conversation-actions');entry.menu=menu;
        entry.summary=text(menu,'…','summary');
        const contents=text(menu,'','div','next-conversation-menu');
        for(const [action,label]of [...(bucket!=='deleted'?[['rename','Rename']]:[]),[bucket==='active'?'archive':'restore',bucket==='active'?'Archive':'Restore'],...(bucket!=='deleted'?[['delete','Move to Trash']]:[])]){
          const control=text(contents,label,'button');control.type='button';control.dataset.chatAction=action;
          entry.controls.set(action,control);
          control.addEventListener('click',()=>{menu.open=false;entry.onAction?.(entry.item,action);});
        }
        for(const [format,label]of [['markdown','Export Markdown'],['json','Export JSON']]){
          const link=text(contents,label,'a');link.download='';entry.exports.push([link,format]);
        }
      }
    }
    // Event handlers read the latest row and callbacks even when a refreshed
    // catalog has identical visible text but a newer continuation identifier.
    entry.item=item;entry.onSelect=onSelect;entry.onToggle=onToggle;entry.onAction=onAction;
    if(entry.title!==title){
      setText(entry.titleNode,title);entry.title=title;
      entry.check?.setAttribute('aria-label','Select '+title);
      entry.summary?.setAttribute('aria-label','Actions for '+title);
    }
    const status=String(item.status||'Saved').replaceAll('_',' ');
    if(entry.status!==status){setText(entry.statusNode,status);entry.status=status;}
    const date=item.updatedAt||item.createdAt;
    if(entry.date!==date){setText(entry.dateNode,formatDate(date));entry.date=date;}
    const selected=id===chosen;
    if(entry.selected!==selected){entry.button.setAttribute('aria-current',String(selected));entry.selected=selected;}
    if(entry.button.disabled!==busy)entry.button.disabled=busy;
    if(entry.check){
      const checked=selection.has(id);
      if(entry.check.checked!==checked)entry.check.checked=checked;
      if(entry.check.disabled!==busy)entry.check.disabled=busy;
    }
    const working=running(item);
    for(const [action,control]of entry.controls){
      const disabled=busy||(action==='delete'&&working);
      if(control.disabled!==disabled)control.disabled=disabled;
      if(action==='delete'){
        const hint=working?'Stop this chat before moving it to Trash.':'';
        if(control.title!==hint)control.title=hint;
      }
    }
    const runId=lastRunId(item);
    if(entry.runId!==runId){
      for(const [link,format]of entry.exports)link.href='/api/conversations/'+encodeURIComponent(runId)+'/export?format='+format;
      entry.runId=runId;
    }
    retained.add(id);order.push(entry.row);
  }
  if(hidden>0){
    const more=marker('more','Show '+Math.min(CHAT_INDEX_BATCH,hidden)+' more ('+hidden+' remaining)','next-conversation-more','button');
    if(!cache.moreBound){more.type='button';more.addEventListener('click',()=>cache.onMore?.());cache.moreBound=true;}
    order.push(more);
  }
  // Move only rows whose order changed. Unchanged updates do not replace
  // children, close a menu, blur a focused control, or reset the scroll position.
  let moved=false;
  for(let index=0;index<order.length;index++){
    const existing=list.childNodes[index]||null;
    if(existing!==order[index]){list.insertBefore(order[index],existing);moved=true;}
  }
  while(list.childNodes.length>order.length){list.lastChild.remove();moved=true;}
  for(const id of cache.rows.keys())if(!retained.has(id))cache.rows.delete(id);
  if(moved){
    list.scrollTop=scrollTop;
    if(focused?.isConnected&&doc.activeElement!==focused)focused.focus({preventScroll:true});
  }
  return visible;
}

export function paintIntroduction(view, message = '') {
  view.timeline.innerHTML='';
  const intro=text(view.timeline,'','div','next-chat-intro');
  text(intro,'What would you like to work on?','h1');
  text(intro,message||'Start a new conversation, or choose saved work from the left.','p');
}
/**
 * Message categorization for callers that only need phase counts. Transcript
 * rendering uses chatTimeline so a later planning return keeps its chronology.
 */
export function chatMessagePhases(messages) {
  const directions=[], thinking=[], responding=[];
  for(const message of Array.isArray(messages)?messages:[]){
    if(message?.role==='user'){directions.push(message);continue;}
    if(message?.role!=='assistant')continue;
    const final=['final_answer','unverified_answer','outcome'].includes(message.phase);
    if(!final && (message.provisional || ['commentary','working','progress'].includes(message.phase)))
      thinking.push(message);
    else responding.push(message);
  }
  return {directions,thinking,responding};
}

export function paintHistory(view, runs, { count=12, markdown, onOlder, onStop, onArtifact, onMoreMessages, messageLimits, getAttachment }={}) {
  const {shown,hidden}=windowedRuns(runs,count), fragment=view.timeline.ownerDocument.createDocumentFragment();
  if (hidden > 0) {
    const older=text(fragment,'Show earlier responses ('+hidden+')','button','next-older');
    older.type='button';older.addEventListener('click',()=>onOlder?.());
  }
  if (!shown.length) {
    const placeholder=text(fragment,'The conversation has no saved responses yet.','div','next-chat-intro');
    placeholder.dataset.empty='true';
  }
  for (let index=0; index<shown.length; index++) {
    const run=shown[index];
    const section=text(fragment,'','section','next-chat-turn');section.dataset.runId=run.id;
    const request=runText(run);
    const earlier=index>0?shown[index-1]:undefined;
    // Build once per visible turn: otherwise each streamed message searches
    // the entire workflow node array for its display name.
    const nodeNames=new Map();
    for(const node of run.workflow?.nodes||[]){
      if(node?.id&&!nodeNames.has(node.id))nodeNames.set(node.id,node.name||'BLACKICE');
    }
    // Suppress duplicate original prompt when a retry carries the same request.
    if (request && !(run.retryOf && earlier && runText(earlier)===request)) {
      const user=text(section,'','article','next-message');user.dataset.role='user';
      text(user,'You','div','next-message-title');
      text(user,request,'div','next-message-body');
      const fileIds=Array.isArray(run.attachmentIds)?[...new Set(run.attachmentIds)]:[];
      if(fileIds.length){
        const files=text(user,'','div','next-message-files');
        files.setAttribute('aria-label',fileIds.length===1?'1 attached file':fileIds.length+' attached files');
        text(files,'Attached','span','next-message-files-label');
        for(const id of fileIds){
          const name=getAttachment?.(id)?.name;
          const filename=typeof name==='string'&&name.trim()?name:'Filename unavailable';
          const chip=text(files,'📎 '+filename,'span','next-message-file');
          chip.title=filename;
        }
      }
    }
    const allMessages=Array.isArray(run.precomputedMessages)?run.precomputedMessages:messagesOfRun(run);
    const {shown:messages,hidden:olderMessages}=windowedMessages(
      allMessages,messageLimits?.get(run.id)??CHAT_MESSAGE_BATCH);
    if(olderMessages>0){
      const more=text(section,'Show earlier messages ('+olderMessages+')','button','next-older next-message-more');
      more.type='button';more.dataset.messageRun=run.id;
      more.addEventListener('click',()=>onMoreMessages?.(run.id));
    }
    const state=run===shown.at(-1)?run.taskState:null;
    const resolveArtifact=createRegisteredArtifactResolver(run);
    const appendAssistant=(parent,message)=>{
      const body=text(parent,'','div','next-message-body next-chat-phase-paragraph');
      if(running(run)||typeof markdown!=='function')body.textContent=message.text;
      else {
        body.innerHTML=markdown(message.text,{resolveArtifact});
        if(onArtifact)body.addEventListener('click',event=>{const link=event.target.closest?.('[data-task-artifact][data-task-id]');if(link&&body.contains(link)){event.preventDefault();onArtifact({taskId:link.dataset.taskId,artifactId:link.dataset.taskArtifact});}});
      }
    };
    for(const phase of chatTimeline(run,messages)){
      if(phase.phase==='direction'){
        for(const entry of phase.entries){
          const article=text(section,'','article','next-message');article.dataset.role='user';
          text(article,'You','div','next-message-title');text(article,entry.message.text,'div','next-message-body');
        }
        continue;
      }
      const group=text(section,'','section','next-chat-phase');group.dataset.phase=phase.phase;group.dataset.timelineId=phase.id;
      if(phase.active){group.dataset.state='active';group.setAttribute('aria-current','step');}
      const provisional=phase.entries.some(entry=>entry.message?.provisional||entry.message?.phase==='unverified_answer');
      text(group,phase.phase==='plan'?'Plan':phase.phase==='think'?'Think':provisional?'Respond · provisional':'Respond','h3','next-chat-phase-title');
      if(phase.phase==='think')text(group,'Recorded findings and working updates · provisional','p','next-help');
      for(const entry of phase.entries){
        if(entry.message){appendAssistant(group,entry.message);continue;}
        const item=text(group,'','div','next-chat-phase-paragraph');item.dataset.activityId=entry.id;item.dataset.activitySource=entry.source;
        const label=[nodeNames.size>1&&nodeNames.get(entry.nodeId),entry.title].filter(Boolean).join(' · ');
        text(item,label,'strong');
        if(entry.at)text(item,' · '+new Date(entry.at).toLocaleTimeString(),'span','next-help');
        text(item,entry.text,'p');
        if(entry.nextStepId)text(item,'Next saved step: '+entry.nextStepId,'p','next-help');
      }
    }
    if (running(run)) {
      const live=text(section,'','div','next-chat-activity');
      live.dataset.liveOutput=run.id;
      live.textContent=run.status==='queued'?'Waiting to start…':'Working…';
    }
    if(state) {

      if(Array.isArray(state.steps)&&state.steps.length){
        const details=text(section,'','details','next-chat-task-summary');
        const summary=text(details,'','summary');
        const actions=state.steps.filter(step=>(step.kind||'action')==='action');
        const complete=actions.filter(step=>step.status==='completed'||step.status==='done').length;
        summary.textContent='Saved outline · '+complete+' / '+actions.length+' actions · '+(running(run)?actions.find(step=>step.status==='active')?.title||'Agent working':!actions.length?'No actions recorded':complete===actions.length?'All actions marked done':'Run ended with unfinished work');
        if(state.updatedAt) text(details,'Last saved plan activity: '+new Date(state.updatedAt).toLocaleTimeString(),'p','next-help');
        const steps=text(details,'','ol');
        const appendOutline=(list,items)=>{
          list.setAttribute('style','list-style: none');
          for(const item of items){
            const row=text(list,'','li');row.dataset.stepId=item.id;row.dataset.stepNumber=item.number;
            text(row,item.number+' '+item.title,'span');
            const badge=text(row,item.status||'pending','span','next-status-pill');badge.dataset.state=item.status||'pending';
            if(item.children.length)appendOutline(text(row,'','ol'),item.children);
          }
        };
        appendOutline(steps,taskPlanView(state).roots);
      }
      if(Array.isArray(state.artifacts)&&state.artifacts.length){
        const details=text(section,'','details','next-chat-task-summary');
        const summary=text(details,'Files · '+state.artifacts.length,'summary');
        for(const artifact of state.artifacts){
          if(typeof artifact.id!=='string')continue;
          const file=text(details,'','div','next-chat-saved-file');
          const button=text(file,artifact.title||artifact.fileName||'Saved file','button');
          button.type='button';
          button.addEventListener('click',()=>onArtifact?.({
            taskId:state.taskId||run.taskId,artifactId:artifact.id,
          }));
          if(artifact.size!=null)text(file,Number(artifact.size).toLocaleString()+' bytes','span','next-help');
        }
      }
    }
    const footer=text(section,'','div','next-turn-meta');
    const pill=text(footer,run.status||'saved','span','next-status-pill');
    pill.dataset.state=run.status||'saved';
    if (['failed','cancelled'].includes(run.status) && run.settled===true) {
      const retry=text(footer,'Retry','button');retry.type='button';retry.addEventListener('click',()=>onStop?.('retry',run.id));
    }
    if(running(run)){const stop=text(footer,'Stop','button');stop.type='button';stop.addEventListener('click',()=>onStop?.('stop',run.id));}
  }
  view.timeline.replaceChildren(fragment);
}
export function paintModels(view,status,selected={}) {
  const choices=chatOptionChoices(status||{},typeof selected==='string'?{model:selected}:selected);
  const fill=(select,items,value)=>{
    if(!select)return;
    // Runtime status can arrive repeatedly while the model menu is open.
    // Keep the existing option nodes when the choices are unchanged so a
    // status paint cannot interrupt keyboard focus or native select input.
    const same=select.options?.length===items.length&&items.every((row,i)=>{
      const option=select.options[i];
      return option.value===row.id&&option.textContent===row.label&&option.disabled===Boolean(row.disabled);
    });
    if(!same){
      const fragment=select.ownerDocument.createDocumentFragment();
      for(const row of items){
        const option=select.ownerDocument.createElement('option');
        option.value=row.id;option.textContent=row.label;option.disabled=Boolean(row.disabled);
        fragment.append(option);
      }
      select.replaceChildren(fragment);
    }
    const chosen=items.some(row=>row.id===value&&!row.disabled)?value:'default';
    if(select.value!==chosen)select.value=chosen;
  };
  fill(view.model,choices.models,choices.selected.model);
  if(view.model) {
    const current=choices.defaultInfo;
    const detail=current?.id?'Default resolves to '+current.id+(current.available?'':' (currently unavailable)'):'Default model has not yet been resolved.';
    view.model.title=detail;
    view.model.setAttribute('aria-label','Model. '+detail);
  }
  fill(view.effort,choices.efforts,choices.selected.effort);
  fill(view.tier,choices.tiers,choices.selected.serviceTier);
  if(view.plan)view.plan.value=choices.selected.planningMode;
}
