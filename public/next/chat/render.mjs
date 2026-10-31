import { text, formatDate } from '../core/dom.mjs';
import { runText, messagesOfRun, windowedRuns, windowedMessages, CHAT_MESSAGE_BATCH, rootId, lastRunId, running, CHAT_INDEX_BATCH, conversationIndexWindow } from './model.mjs';
import { chatOptionChoices } from './options-model.mjs';
import { createRegisteredArtifactResolver } from '../../conversation-model.mjs';
import { taskPlanView } from '../../task-plan-model.mjs';
import { chatDisplayPhases, chatWorkSummary, chatProgressPreview, chatOutlineStatusLabel } from './planning-timeline.mjs';

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
    '</div></div><footer class="next-chat-composer-area"><section id="next-chat-cycle-notice" class="next-chat-cycle-notice" hidden><span id="next-chat-cycle-status" role="status"></span><button type="button" id="next-chat-open-plan">Open plan in Planning</button></section><div id="next-chat-command-menu" class="next-chat-command-menu" role="listbox" aria-label="Chat commands" hidden></div><form class="next-chat-compose" id="next-chat-form">',
    '<textarea id="next-chat-input" class="next-chat-input" aria-label="Message BLACKICE" aria-autocomplete="list" aria-controls="next-chat-command-menu" aria-expanded="false" placeholder="Message BLACKICE…" rows="2"></textarea>',
    '<div id="next-chat-attachments"></div>',
    '<div class="next-chat-options"><button type="button" id="next-chat-commands" class="next-chat-commands" aria-label="Chat commands" title="Chat commands" aria-haspopup="listbox" aria-controls="next-chat-command-menu" aria-expanded="false">/</button><div class="next-chat-model"><span>Model</span><select id="next-chat-model" aria-label="Model"><option value="default">Default</option></select></div>',
    '<label>Reasoning <select id="next-chat-effort"><option value="default">Model default</option></select></label>',
    '<label>Speed <select id="next-chat-tier"><option value="default">Standard</option></select></label>',
    '<label>Planning <select id="next-chat-plan"><option value="on">On</option><option value="off">Off</option></select></label>',
    '<label>Execution <select id="next-chat-execution-mode" title="Plan only pauses after Plan. Continue explicitly from the saved plan."><option value="automatic">Automatic</option><option value="plan_only">Plan only</option></select></label>',
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
    cycleNotice:find('next-chat-cycle-notice'),cycleStatus:find('next-chat-cycle-status'),openPlan:find('next-chat-open-plan'),executionMode:find('next-chat-execution-mode'),
    form:find('next-chat-form'),input:find('next-chat-input'),commands:find('next-chat-commands'),commandMenu:find('next-chat-command-menu'),attachments:find('next-chat-attachments'),model:find('next-chat-model'),plan:find('next-chat-plan'),
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
    const status=String(item.status==='completed'&&item.settled===true?'Response saved':item.status==='completed'&&item.settled===false?'Finishing…':item.status||'Saved').replaceAll('_',' ');
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
  const doc=view.timeline.ownerDocument;
  const disclosures=new Map(Array.from(view.timeline.querySelectorAll('details[data-disclosure-id]'),node=>[node.dataset.disclosureId,node.open]));
  const focused=doc.activeElement;
  const focusId=focused?.tagName==='SUMMARY'?focused.parentElement?.dataset.disclosureId:null;
  let restoreFocus=null;
  const disclosure=(parent,key,className)=>{
    const node=text(parent,'','details',className);node.dataset.disclosureId=key;
    node.open=disclosures.get(key)===true;
    const summary=text(node,'','summary');
    if(key===focusId)restoreFocus=summary;
    return {node,summary};
  };
  const {shown,hidden}=windowedRuns(runs,count), fragment=doc.createDocumentFragment();
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
    const planView=state?taskPlanView(state,{runStatus:run.status,settled:run.settled}):null;
    const resolveArtifact=createRegisteredArtifactResolver(run);
    const appendAssistant=(parent,message)=>{
      const body=text(parent,'','div','next-message-body');
      if(running(run)||typeof markdown!=='function')body.textContent=message.text;
      else {
        body.innerHTML=markdown(message.text,{resolveArtifact});
        if(onArtifact)body.addEventListener('click',event=>{const link=event.target.closest?.('[data-task-artifact][data-task-id]');if(link&&body.contains(link)){event.preventDefault();onArtifact({taskId:link.dataset.taskId,artifactId:link.dataset.taskArtifact});}});
      }
    };
    const phases=chatDisplayPhases(run,messages);
    const isWork=phase=>phase.phase==='plan'||phase.phase==='think'||phase.provisional;
    const workPhases=phases.filter(isWork);
    const progress=chatWorkSummary(workPhases);
    for(const phase of phases){
      if(phase.phase==='direction'){
        for(const entry of phase.entries){
          const article=text(section,'','article','next-message');article.dataset.role='user';
          text(article,'You','div','next-message-title');text(article,entry.message.text,'div','next-message-body');
        }
      }else if(!isWork(phase)){
        const article=text(section,'','article','next-message next-chat-response');
        article.dataset.role='assistant';article.dataset.timelineId=phase.id;
        for(const entry of phase.entries)appendAssistant(article,entry.message);
      }
    }
    if(running(run)){
      const live=text(section,'','div','next-chat-activity');
      live.dataset.liveOutput=run.id;live.setAttribute('role','status');
      live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');
      const focus=planView?.focus;
      const current=focus&&['active','blocked'].includes(focus.status)?focus:null;
      const preview=run.status==='queued'?'Waiting to start…':current?.blockedReason||current?.title||
        (phases.at(-1)?.phase==='respond'?'Finishing…':progress.preview)||'Working…';
      live.textContent=chatProgressPreview(preview==='Saved progress'?'Working…':preview);
    }
    const hasPlan=Boolean(state&&Array.isArray(state.steps)&&state.steps.length);
    if(workPhases.length||hasPlan){
      const {node:audit,summary}=disclosure(section,run.id+':details','next-chat-details');
      summary.textContent=hasPlan?'Plan':'Details';
      summary.setAttribute('aria-label',hasPlan?'Plan: expandable steps and evidence':'Details: recorded actions');
      const body=text(audit,'','div','next-chat-details-body');
      if(hasPlan){
        const {done,total,skipped}=planView.progress;
        text(body,done+' of '+total+' steps complete'+(skipped?' · '+skipped+' skipped':''),'p','next-help next-chat-outline-progress');
        const appendOutline=(list,items)=>{
          for(const item of items){
            const row=text(list,'','li','next-chat-outline-item');row.dataset.stepId=item.id;row.dataset.stepNumber=item.number;
            const fields=[['Done when',item.doneWhen],['Evidence',item.evidence],['Blocked by',item.blockedReason]]
              .filter(([,value])=>typeof value==='string'&&value.trim());
            let line,content;
            if(item.children.length||fields.length){
              const branch=disclosure(row,run.id+':step:'+item.id,'next-chat-outline-node');
              line=branch.summary;line.className='next-chat-outline-line';
              content=text(branch.node,'','div','next-chat-outline-content');
            }else line=text(row,'','div','next-chat-outline-line next-chat-outline-leaf');
            text(line,item.number,'span','next-chat-outline-number');
            text(line,item.title,'span','next-chat-outline-title');
            const badge=text(line,chatOutlineStatusLabel(item),'small','next-chat-outline-state');badge.dataset.state=item.status||'pending';
            if(item.isGroup)badge.title='Recorded progress of the saved steps in this group';
            if(item.children.length)appendOutline(text(content,'','ol','next-chat-plan-outline'),item.children);
            for(const [label,value]of fields){
              const field=text(content,'','p','next-chat-outline-evidence');
              text(field,label+' · ','strong');text(field,value,'span');
            }
          }
        };
        appendOutline(text(body,'','ol','next-chat-plan-outline'),planView.roots);
      }
      if(workPhases.length){
        const {node:history,summary:historySummary}=disclosure(body,run.id+':history','next-chat-outline-history');
        historySummary.textContent='History';
        if(progress.count)text(history,progress.count+' recorded '+(progress.count===1?'update':'updates'),'p','next-help next-chat-details-count');
        const list=text(history,'','ol','next-chat-audit-outline');
        for(const phase of phases){
          if(!isWork(phase)&&phase.phase!=='direction')continue;
          for(const entry of phase.entries){
            const row=text(list,'','li');row.dataset.phase=phase.phase;
            if(!entry.message){row.dataset.activityId=entry.id;row.dataset.activitySource=entry.source;}
            const {node:record,summary:recordSummary}=disclosure(row,run.id+':activity:'+entry.id,'next-chat-audit-node');
            const label=entry.message?(phase.phase==='direction'?'You · ':'')+chatProgressPreview(entry.message.text):
              [nodeNames.size>1&&nodeNames.get(entry.nodeId),entry.title].filter(Boolean).join(' · ');
            text(recordSummary,label,'span');
            if(entry.at)text(recordSummary,new Date(entry.at).toLocaleTimeString(),'time','next-help');
            const content=text(record,'','div','next-chat-outline-evidence');
            if(entry.message){
              if(phase.phase==='direction')text(content,entry.message.text,'p');
              else appendAssistant(content,entry.message);
            }else text(content,entry.text,'p');
            if(entry.nextStepId)text(content,'Next saved step: '+entry.nextStepId,'p','next-help');
          }
        }
      }
    }
    if(state){
      if(Array.isArray(state.artifacts)&&state.artifacts.length){
        const {node:details,summary}=disclosure(section,run.id+':files','next-chat-task-summary');
        summary.textContent='Files · '+state.artifacts.length;
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
    const pill=text(footer,run.status==='completed'&&run.settled===true?'Response saved':run.status==='completed'&&run.settled===false?'Finishing…':run.status||'saved','span','next-status-pill');
    pill.dataset.state=run.status||'saved';
    if(run.status==='completed'&&run.settled===true&&hasPlan&&!planView.complete)text(footer,'Unfinished steps','span','next-turn-note');
    if (['failed','cancelled'].includes(run.status) && run.settled===true) {
      const retry=text(footer,'Retry','button');retry.type='button';retry.addEventListener('click',()=>onStop?.('retry',run.id));
    }
    if(running(run)){const stop=text(footer,'Stop','button');stop.type='button';stop.addEventListener('click',()=>onStop?.('stop',run.id));}
  }
  view.timeline.replaceChildren(fragment);
  restoreFocus?.focus({preventScroll:true});
}
export function paintModels(view,status,selected={}) {
  const choices=chatOptionChoices(status||{},typeof selected==='string'?{model:selected}:selected);
  const fill=(select,items,value,{retain=false}={})=>{
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
    const chosen=items.some(row=>row.id===value&&(retain||!row.disabled))?value:'default';
    if(select.value!==chosen)select.value=chosen;
  };
  fill(view.model,choices.models,choices.selected.model,{retain:true});
  if(view.model) {
    const current=choices.defaultInfo;
    const detail=current?.id?'Default resolves to '+current.id+(current.available?'':' (currently unavailable)'):'Default model has not yet been resolved.';
    view.model.title=detail;
    view.model.setAttribute('aria-label','Model. '+detail);
  }
  fill(view.effort,choices.efforts,choices.selected.effort);
  fill(view.tier,choices.tiers,choices.selected.serviceTier);
  if(view.plan)view.plan.value=choices.selected.planningMode;
  if(view.executionMode)view.executionMode.value=choices.selected.planningExecutionMode;
  return choices;
}
