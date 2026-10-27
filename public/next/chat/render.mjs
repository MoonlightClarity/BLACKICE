import { text, formatDate } from '../core/dom.mjs';
import { runText, messagesOfRun, windowedRuns, windowedMessages, CHAT_MESSAGE_BATCH, rootId, lastRunId, running, CHAT_INDEX_BATCH, conversationIndexWindow } from './model.mjs';
import { chatOptionChoices } from './options-model.mjs';
import { createRegisteredArtifactResolver } from '../../conversation-model.mjs';

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

export function paintIndex(view, items, chosen, onSelect, {limit=CHAT_INDEX_BATCH,onMore,selecting=false,selection=new Map(),onToggle,onAction,busy=false}={}) {
  const fragment = view.list.ownerDocument.createDocumentFragment();
  const {shown,hidden,pinned}=conversationIndexWindow(items,limit,chosen);
  if (!items.length) text(fragment,'No conversations here.','p','next-chat-placeholder');
  const add = item => {
    const id = rootId(item), title = item.rootTitle || item.title || 'Conversation';
    const row=text(fragment,'','div','next-conversation-row');
    if(selecting){
      const choice=text(row,'','label','next-conversation-choice');
      const check=text(choice,'','input');check.type='checkbox';check.dataset.chatSelect=id;check.checked=selection.has(id);check.disabled=busy;
      check.setAttribute('aria-label','Select '+title);check.addEventListener('change',()=>onToggle?.(item,check.checked));
    }
    const button = text(row,'','button','next-conversation');
    button.type='button';button.dataset.conversation=id;
    button.disabled=busy;
    button.setAttribute('aria-current',String(id===chosen));
    text(button,title,'span','next-conversation-title');
    const foot=text(button,'','span','next-conversation-meta');
    text(foot,(item.status||'Saved').replaceAll('_',' '));
    text(foot,formatDate(item.updatedAt||item.createdAt));
    button.addEventListener('click',()=>onSelect(item));
    if(!selecting&&onAction){
      const menu=text(row,'','details','next-conversation-actions');
      const summary=text(menu,'…','summary');summary.setAttribute('aria-label','Actions for '+title);
      const actions=text(menu,'','div','next-conversation-menu');
      const bucket=item.state||'active';
      for(const [action,label]of [...(bucket!=='deleted'?[['rename','Rename']]:[]),[bucket==='active'?'archive':'restore',bucket==='active'?'Archive':'Restore'],...(bucket!=='deleted'?[['delete','Move to Trash']]:[])]){
        const control=text(actions,label,'button');control.type='button';control.dataset.chatAction=action;control.disabled=busy||(action==='delete'&&running(item));
        if(action==='delete'&&running(item))control.title='Stop this chat before moving it to Trash.';
        control.addEventListener('click',()=>{menu.open=false;onAction(item,action);});
      }
      for(const [format,label]of [['markdown','Export Markdown'],['json','Export JSON']]){
        const link=text(actions,label,'a');link.href='/api/conversations/'+encodeURIComponent(lastRunId(item))+'/export?format='+format;link.download='';
      }
    }
  };
  // Deep-linked conversations can be older than the visible batch. Keep the
  // current selection accessible without mounting the entire history.
  if (pinned) {
    text(fragment,'Current conversation','p','next-conversation-pinned-label');
    add(pinned);
  }
  for (const item of shown) add(item);
  if (hidden > 0) {
    const more=text(fragment,'Show '+Math.min(CHAT_INDEX_BATCH,hidden)+' more ('+hidden+' remaining)','button','next-conversation-more');
    more.type='button';
    more.addEventListener('click',()=>onMore?.());
  }
  view.list.replaceChildren(fragment);
  return pinned?[pinned,...shown]:shown;
}
export function paintIntroduction(view, message = '') {
  view.timeline.innerHTML='';
  const intro=text(view.timeline,'','div','next-chat-intro');
  text(intro,'What would you like to work on?','h1');
  text(intro,message||'Start a new conversation, or choose saved work from the left.','p');
}
/**
 * One transcript-level section per phase, rather than a label on each paragraph.
 * Think contains visible, user-facing working observations; private reasoning
 * is neither requested nor reconstructed from provider internals.
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
    const phases=chatMessagePhases(messages);
    const state=run===shown.at(-1)?run.taskState:null;
    const sourceNotes=(state?.steps||[]).filter(step=>(step.kind||'action')==='action'
      && typeof step.evidence==='string' && step.evidence.trim());
    const resolveArtifact=createRegisteredArtifactResolver(run);
    const appendAssistant=(parent,message)=>{
      const body=text(parent,'','div','next-message-body next-chat-phase-paragraph');
      if(running(run)||typeof markdown!=='function')body.textContent=message.text;
      else {
        body.innerHTML=markdown(message.text,{resolveArtifact});
        if(onArtifact)body.addEventListener('click',event=>{const link=event.target.closest?.('[data-task-artifact][data-task-id]');if(link&&body.contains(link)){event.preventDefault();onArtifact({taskId:link.dataset.taskId,artifactId:link.dataset.taskArtifact});}});
      }
    };
    for(const message of phases.directions){
      const article=text(section,'','article','next-message');article.dataset.role='user';
      text(article,'You','div','next-message-title');
      text(article,message.text,'div','next-message-body');
    }
    if(phases.thinking.length||sourceNotes.length){
      const group=text(section,'','section','next-chat-phase');group.dataset.phase='think';
      text(group,'Think','h3','next-chat-phase-title');
      text(group,'Working observations and hypotheses · provisional','p','next-help');
      for(const message of phases.thinking)appendAssistant(group,message);
      if(sourceNotes.length){
        const panel=text(group,'','details','next-chat-working-notes');
        panel.open=running(run)||state.steps.some(step=>(step.kind||'action')==='action'
          && step.status!=='done'&&step.status!=='skipped');
        text(panel,'Source observations · '+sourceNotes.length,'summary');
        for(const step of sourceNotes){
          const item=text(panel,'','details','next-chat-working-note');
          text(item,step.title||step.id||'Observation','summary');
          text(item,step.evidence,'div','next-chat-working-note-body');
        }
      }
    }
    if (running(run)) {
      const live=text(section,'','div','next-chat-activity');
      live.dataset.liveOutput=run.id;
      live.textContent=run.status==='queued'?'Waiting to start…':'Working…';
    }
    if(state) {

      if(false){ // Legacy per-message observation panel replaced by grouped Think
        const panel=text(section,'','details','next-chat-working-notes');
        panel.open=running(run)||(state.steps||[]).some(step=>(step.kind||'action')==='action'&&step.status!=='done'&&step.status!=='skipped');
        text(panel,'Think · '+observed.length+' recorded observations (provisional)','summary');
        text(panel,'Source-based working observations; not private model reasoning or verified final conclusions.','p','next-help');
        for(const step of observed){
          const item=text(panel,'','details','next-chat-working-note');
          text(item,step.title||step.id||'Observation','summary');
          text(item,step.evidence,'div','next-chat-working-note-body');
        }
      }
      if(Array.isArray(state.steps)&&state.steps.length){
        const details=text(section,'','details','next-chat-task-summary');
        const summary=text(details,'','summary');
        const actions=state.steps.filter(step=>(step.kind||'action')==='action');
        const complete=actions.filter(step=>step.status==='completed'||step.status==='done').length;
        summary.textContent='Plan · '+complete+' / '+actions.length+' actions · '+(running(run)?actions.find(step=>step.status==='active')?.title||'Agent working':!actions.length?'No actions recorded':complete===actions.length?'All actions marked done':'Run ended with unfinished work');
        if(state.updatedAt) text(details,'Last saved plan activity: '+new Date(state.updatedAt).toLocaleTimeString(),'p','next-help');
        const steps=text(details,'','ol');
        for(const item of state.steps.slice(0,60)){
          const row=text(steps,'','li');
          text(row,item.title||item.id||'Step','span');
          row.appendChild(row.ownerDocument.createTextNode(' '));
          const badge=text(row,item.status||'pending','span','next-status-pill');
          badge.dataset.state=item.status||'pending';
        }
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
    if(phases.responding.length){
      const response=text(section,'','section','next-chat-phase');
      response.dataset.phase='respond';
      const provisional=phases.responding.some(m=>m.provisional||m.phase==='unverified_answer');
      text(response,provisional?'Respond · provisional':'Respond','h3','next-chat-phase-title');
      for(const message of phases.responding)appendAssistant(response,message);
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
