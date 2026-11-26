const TREE_ICONS={"folder":"M3 7h7l2 2h9v11H3z M3 7V4h6l2 3","folderPlus":"M3 7h7l2 2h9v11H3z M3 7V4h6l2 3 M12 12v6 M9 15h6","plus":"M12 5v14 M5 12h14","check":"M5 12l4 4L19 6","close":"M6 6l12 12 M18 6 6 18","archive":"M3 5h18v4H3z M5 9v11h14V9 M9 13h6","restore":"M4 10a8 8 0 1 1 1 9 M4 4v6h6","trash":"M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13"};
const treeSvg=name=>'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="'+TREE_ICONS[name]+'"/></svg>';
import { bindChatSvgPreviews } from './svg-previews.mjs';
import { text, formatDate } from '../core/dom.mjs';
import { runText, displayChatRequest, messagesOfRun, chatResponseState, windowedRuns, windowedMessages, CHAT_MESSAGE_BATCH, rootId, lastRunId, running, CHAT_INDEX_BATCH, conversationIndexWindow, conversationGoalStatus, projectSkillLoadReceipts, projectPlanningModuleReceipts } from './model.mjs';
import { chatOptionChoices } from './options-model.mjs';
import { createRegisteredArtifactResolver } from '../../conversation-model.mjs';
import { chatToolFailure } from './tool-failure.mjs';
import { taskPlanView } from '../../task-plan-model.mjs';
import { chatDisplayPhases, chatWorkSummary, chatProgressPreview, chatOutlineStatusLabel } from './planning-timeline.mjs';

// A failed run should show the diagnostic it actually saved, regardless of
// provider, model, tool or failure code. Keep the message as plain text.
export function chatRunError(run) {
  if (!run) return null;
  const failedNodes=Object.values(run.nodes||{}).filter(node=>node?.status==='failed');
  if(run.status!=='failed'&&!run.error&&!failedNodes.length) return null;
  const sources=[run.error,...failedNodes.map(node=>node.error)];
  const raw=sources.find(value=>typeof value==='string'&&value.trim()||typeof value?.message==='string'&&value.message.trim());
  const message=(typeof raw==='string'?raw:raw?.message)?.trim()||'This operation failed without a recorded error message.';
  const codes=[run.errorCode,...failedNodes.map(node=>node.errorCode),typeof raw==='object'?raw?.code:null];
  const code=codes.find(value=>typeof value==='string'&&value.trim()||Number.isFinite(value));
  return {message,code:code==null?null:String(code)};
}

export function createChatFrame(mount) {
  mount.innerHTML = [
    '<div class="next-chat" id="next-chat"><aside class="next-chat-sidebar">',
    '<div class="next-sidebar-head"><div class="next-sidebar-row"><strong>Chats</strong><button id="next-chat-mobile-close" type="button" aria-label="Close conversations and folders">Close</button><button id="next-chat-new" type="button">+ New</button></div>',
    '<input class="next-field next-sidebar-search" type="search" id="next-chat-search" placeholder="Search" aria-label="Find a conversation">',
    '<div class="next-sidebar-views"><select class="next-field next-sidebar-filter" id="next-chat-bucket" aria-label="Conversation view">',
    '<option value="active">Active</option><option value="archived">Archive</option><option value="deleted">Trash</option></select><button id="next-chat-select" type="button" aria-controls="next-chat-bulk" aria-expanded="false">Multi-select</button></div>',
    '<div class="next-chat-folder-picker"><button id="next-chat-folder-new" type="button" aria-label="New top-level folder" title="New top-level folder">'+treeSvg('folderPlus')+'</button></div>',
    '',
    '<p id="next-chat-folder-status" class="next-chat-folder-status" role="status" hidden></p><button id="next-chat-folder-undo" type="button" hidden>Undo last move</button>',
    '<section id="next-chat-bulk" class="next-chat-bulk" aria-label="Selected conversations" hidden>',
    '<div class="next-chat-bulk-heading"><span id="next-chat-bulk-count" role="status">0 selected</span><button id="next-chat-bulk-cancel" type="button">Cancel</button></div>',
    '<button id="next-chat-bulk-all" type="button">Select visible</button>',
    '<div class="next-chat-bulk-actions"><button id="next-chat-bulk-archive" type="button" disabled>Archive</button>',
    '<button id="next-chat-bulk-restore" type="button" hidden disabled>Restore</button>',
    '<button id="next-chat-bulk-delete" type="button" disabled>Move to Trash</button></div></section>',
    '<p id="next-chat-management-status" class="next-chat-management-status" role="status" hidden></p></div>',
    '<div class="next-conversation-list" id="next-chat-list"></div></aside>',
    '<div class="next-chat-main"><header class="next-chat-head">',
    '<button id="next-chat-mobile-list" type="button" aria-label="Show conversations and folders" aria-expanded="false">Chats</button>',
    '<div class="next-chat-heading"><strong id="next-chat-title">New conversation</strong><small id="next-chat-subtitle">Local workspace</small></div>',
    '<div class="next-chat-head-actions"><button type="button" id="next-chat-rename" hidden>Rename</button>',
    '<button type="button" id="next-chat-task-menu" hidden aria-haspopup="dialog">Tasks</button>',
    '<button type="button" id="next-chat-close" hidden>Close chat</button>',
    '<button type="button" id="next-chat-archive" hidden>Archive</button>',
    '<button type="button" id="next-chat-delete" hidden>Move to Trash</button>',
    '<details id="next-chat-export" class="next-chat-export" hidden><summary>Export</summary><div>',
    '<a id="next-chat-export-markdown" download>Markdown</a><a id="next-chat-export-json" download>JSON</a></div></details>',
    '<button type="button" id="next-chat-stop" hidden>Stop</button></div></header>',
    '<section class="next-chat-diagnostic-alarm" id="next-chat-diagnostic-alarm" aria-label="Diagnostic alarm" hidden><p id="next-chat-diagnostic-message" role="status" aria-live="polite" aria-atomic="true"></p><button type="button" id="next-chat-diagnostic-receipts">View receipts</button><button type="button" id="next-chat-diagnostic-dismiss">Dismiss</button></section>',
    '<div class="next-chat-scroll" id="next-chat-scroll"><div class="next-chat-timeline" id="next-chat-timeline">',
    '<div class="next-chat-intro"><h1>What would you like to work on?</h1><p>BLACKICE can use your local workspace, tools, and connected services. Start a conversation or return to saved work.</p></div>',
    '</div></div><footer class="next-chat-composer-area"><section id="next-chat-cycle-notice" class="next-chat-cycle-notice" hidden><span id="next-chat-cycle-status" role="status"></span><button type="button" id="next-chat-open-plan">Open plan in Planning</button></section><section id="next-chat-goal-card" class="next-chat-goal-card" aria-label="Persistent Goal Mode" hidden><details id="next-chat-goal-details" class="next-chat-goal-details"><summary class="next-chat-goal-heading"><strong>Goal Mode</strong><span id="next-chat-goal-status" class="next-status-pill" role="status"></span><span id="next-chat-goal-deadline-brief" class="next-chat-goal-deadline-brief" hidden></span><span id="next-chat-goal-progress"></span><span class="next-chat-goal-disclosure">Details</span></summary><div class="next-chat-goal-expanded"><p id="next-chat-goal-deadline" class="next-chat-goal-deadline" hidden></p><p id="next-chat-goal-objective" tabindex="0"></p><p id="next-chat-goal-reason" hidden></p><div class="next-chat-goal-actions"><button id="next-chat-goal-edit" type="button">Edit goal</button><button id="next-chat-goal-pause" type="button" title="Pause current execution and automatic continuation. Saved work and recovery evidence are retained.">Turn off</button><button id="next-chat-goal-resume" type="button" hidden>Turn on</button><button id="next-chat-goal-clear" type="button" title="Remove this goal; keep the conversation">Clear</button></div></div></details></section><form class="next-chat-compose" id="next-chat-form">',
    '<textarea id="next-chat-input" class="next-chat-input" aria-label="Message BLACKICE" placeholder="Message BLACKICE…" rows="2"></textarea>',
    '<div id="next-chat-attachments"></div>',
    '<div class="next-chat-options"><div class="next-chat-model"><span>Model</span><select id="next-chat-model" aria-label="Model"><option value="default">Default</option></select></div>',
    '<label>Reasoning <select id="next-chat-effort"><option value="default">Model default</option></select></label>',
    '<label>Speed <select id="next-chat-tier"><option value="default">Standard</option></select></label>',
    '<label title="Use a task-bound action outline to coordinate execution on the next response.">Directory <select id="next-chat-directory-actions" aria-label="Action Directory for the next response"><option value="off">Off</option><option value="on">On</option></select></label>',
    '<label title="Use the three planning modules to choose and refine actions for this task.">Planning <select id="next-chat-planning-actions" aria-label="Planning for the next response"><option value="off">Off</option><option value="on">On</option></select></label>',
    '<label title="Allow explicit BLACKICE lookups into other saved chats. This does not change the current conversation, browser state, local files, or model-provider memory. Saves when you send.">Search other chats <select id="next-chat-past-chats" aria-label="Search other BLACKICE chats"><option value="off">Off</option><option value="on">On demand</option></select></label>',
    '<input id="next-chat-execution-mode" type="hidden" value="automatic">',
    '<button id="next-chat-goal-toggle" class="next-chat-goal-toggle" type="button" role="switch" aria-checked="false">Goal: Off</button><span class="next-chat-spacer"></span><button class="next-primary" type="submit" id="next-chat-send">Send</button></div>',
    '</form>',
    '<p id="next-chat-hint" class="next-chat-hint" role="status">Enter to send · Shift+Enter for a new line</p>',
    '</footer></div>',
    '<dialog id="next-chat-goal-dialog" class="next-chat-management-dialog next-chat-goal-dialog" aria-labelledby="next-chat-goal-title"><form id="next-chat-goal-form"><h2 id="next-chat-goal-title">Create Goal</h2><p>Goal Mode tracks one explicit objective and its completion evidence.</p><p id="next-chat-goal-context" class="next-chat-goal-context" hidden></p><label class="next-label">Objective and completion criteria<textarea id="next-chat-goal-input" class="next-field" rows="5" maxlength="12000" required placeholder="Describe the outcome and how to know it is done."></textarea></label><label class="next-label">Turn limit (optional)<input id="next-chat-goal-limit" class="next-field" type="number" min="1" step="1" inputmode="numeric" placeholder="No limit"></label><label class="next-label">Stop at computer-local time (optional)<input id="next-chat-goal-deadline-input" class="next-field" type="datetime-local" step="1"></label><p class="next-help">A phrase such as until 6 AM EST also establishes an automatic stop. EST is fixed UTC-05:00; Eastern follows daylight saving time. Saved deadlines do not reset on Resume.</p><p class="next-help">Goal Mode is optional. Turning it off retains the saved goal and progress.</p><p id="next-chat-goal-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button id="next-chat-goal-cancel" type="button">Cancel</button><button id="next-chat-goal-save" type="submit" class="next-primary">Save Goal</button></div></form></dialog><dialog id="next-chat-trash-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-trash-title">',
    '<h2 id="next-chat-trash-title">Move to Trash?</h2><p id="next-chat-trash-message"></p><p>You can restore the chats, but their Receipts will be permanently removed. Saved messages and files are preserved.</p>',
    '<div class="next-chat-dialog-actions"><button id="next-chat-trash-cancel" type="button" autofocus>Cancel</button><button id="next-chat-trash-confirm" type="button">Move to Trash</button></div></dialog>',
    '<dialog id="next-chat-task-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-task-title">',
    '<h2 id="next-chat-task-title">Tasks in this chat</h2><p id="next-chat-task-scope" class="next-help"></p>',
    '<ul id="next-chat-task-list" aria-label="Saved tasks"></ul><p id="next-chat-task-status" role="status"></p>',
    '<form id="next-chat-task-form"><label class="next-label">New task in this chat<textarea id="next-chat-task-input" class="next-field" maxlength="50000" rows="3" required></textarea></label>',
    '<p class="next-help">Starts with default model settings and no earlier task context or attachments. The previous task and its Goal are unchanged.</p>',
    '<button type="submit" class="next-primary" id="next-chat-task-start">Start new task</button></form>',
    '<p id="next-chat-task-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button type="button" id="next-chat-task-cancel">Close</button></div></dialog>',
    '<dialog id="next-chat-rename-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-rename-title">',
    '<form id="next-chat-rename-form"><h2 id="next-chat-rename-title">Rename chat</h2><label class="next-label">Chat title<input id="next-chat-rename-input" class="next-field" maxlength="120" required></label>',
    '<p id="next-chat-rename-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button id="next-chat-rename-cancel" type="button">Cancel</button><button id="next-chat-rename-save" type="submit" class="next-primary">Save</button></div></form></dialog>',
    '<form id="next-chat-folder-form" class="next-chat-folder-draft" hidden><small id="next-chat-folder-draft-context"></small><span aria-hidden="true">'+treeSvg('folder')+'</span><input id="next-chat-folder-name" class="next-field" maxlength="60" required aria-label="New folder name"><button id="next-chat-folder-save" type="submit" aria-label="Create folder" title="Create folder">'+treeSvg('check')+'</button><button id="next-chat-folder-cancel" type="button" aria-label="Cancel folder creation" title="Cancel">'+treeSvg('close')+'</button><p id="next-chat-folder-dialog-error" role="alert" hidden></p></form>',
    '<dialog id="next-chat-folder-move-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-folder-move-title"><form id="next-chat-folder-move-form"><h2 id="next-chat-folder-move-title">Organize chat</h2><p id="next-chat-folder-move-reason"></p><label class="next-label">Find destination<input id="next-chat-folder-move-search" class="next-field" type="search" maxlength="256" autocomplete="off" placeholder="Search folder paths"></label><label class="next-label">Move to<select id="next-chat-folder-move-target" class="next-field" size="7" aria-label="Destination folder"><option value="">Unfiled</option></select></label><p id="next-chat-folder-move-count" class="next-help" role="status" aria-live="polite"></p><p class="next-help">Folder placement changes only when you move the chat. This never shares context with other chats.</p><div class="next-chat-dialog-actions"><button id="next-chat-folder-move-cancel" type="button">Cancel</button><button id="next-chat-folder-move-save" type="submit" class="next-primary">Move</button></div></form></dialog>',
    '<dialog id="next-chat-folder-delete-dialog" class="next-chat-management-dialog" aria-labelledby="next-chat-folder-delete-title"><h2 id="next-chat-folder-delete-title">Move folder?</h2><p id="next-chat-folder-delete-label"></p><p id="next-chat-folder-delete-error" role="alert" hidden></p><div class="next-chat-dialog-actions"><button id="next-chat-folder-delete-cancel" type="button">Cancel</button><button id="next-chat-folder-delete-confirm" type="button" class="next-primary">Delete folder only</button></div></dialog>',
    '</div>',
  ].join('');
  const find = id => mount.querySelector('#'+id);
  return { shell:find('next-chat'),list:find('next-chat-list'),search:find('next-chat-search'),bucket:find('next-chat-bucket'),
    folderNew:find('next-chat-folder-new'),
    folderStatus:find('next-chat-folder-status'),folderUndo:find('next-chat-folder-undo'),
    folderForm:find('next-chat-folder-form'),folderDraftContext:find('next-chat-folder-draft-context'),folderName:find('next-chat-folder-name'),folderDialogError:find('next-chat-folder-dialog-error'),folderCancel:find('next-chat-folder-cancel'),folderSave:find('next-chat-folder-save'),
    folderMoveDialog:find('next-chat-folder-move-dialog'),folderMoveForm:find('next-chat-folder-move-form'),folderMoveTitle:find('next-chat-folder-move-title'),folderMoveReason:find('next-chat-folder-move-reason'),folderMoveSearch:find('next-chat-folder-move-search'),folderMoveCount:find('next-chat-folder-move-count'),folderMoveTarget:find('next-chat-folder-move-target'),folderMoveCancel:find('next-chat-folder-move-cancel'),folderMoveSave:find('next-chat-folder-move-save'),
    folderDeleteDialog:find('next-chat-folder-delete-dialog'),folderDeleteTitle:find('next-chat-folder-delete-title'),folderDeleteError:find('next-chat-folder-delete-error'),folderDeleteLabel:find('next-chat-folder-delete-label'),folderDeleteCancel:find('next-chat-folder-delete-cancel'),folderDeleteConfirm:find('next-chat-folder-delete-confirm'),
    mobileClose:find('next-chat-mobile-close'),newButton:find('next-chat-new'),mobileList:find('next-chat-mobile-list'),
    taskMenu:find('next-chat-task-menu'),taskDialog:find('next-chat-task-dialog'),taskScope:find('next-chat-task-scope'),
    taskList:find('next-chat-task-list'),taskStatus:find('next-chat-task-status'),taskForm:find('next-chat-task-form'),
    taskInput:find('next-chat-task-input'),taskStart:find('next-chat-task-start'),taskError:find('next-chat-task-error'),taskCancel:find('next-chat-task-cancel'),
    title:find('next-chat-title'),subtitle:find('next-chat-subtitle'),rename:find('next-chat-rename'),archive:find('next-chat-archive'),closeChat:find('next-chat-close'),
    trash:find('next-chat-delete'),exports:find('next-chat-export'),exportMarkdown:find('next-chat-export-markdown'),exportJson:find('next-chat-export-json'),
    select:find('next-chat-select'),bulk:find('next-chat-bulk'),bulkCount:find('next-chat-bulk-count'),bulkCancel:find('next-chat-bulk-cancel'),bulkAll:find('next-chat-bulk-all'),
    bulkArchive:find('next-chat-bulk-archive'),bulkRestore:find('next-chat-bulk-restore'),bulkDelete:find('next-chat-bulk-delete'),managementStatus:find('next-chat-management-status'),
    trashDialog:find('next-chat-trash-dialog'),trashTitle:find('next-chat-trash-title'),trashMessage:find('next-chat-trash-message'),trashCancel:find('next-chat-trash-cancel'),trashConfirm:find('next-chat-trash-confirm'),
    renameDialog:find('next-chat-rename-dialog'),renameForm:find('next-chat-rename-form'),renameInput:find('next-chat-rename-input'),renameError:find('next-chat-rename-error'),renameCancel:find('next-chat-rename-cancel'),renameSave:find('next-chat-rename-save'),
    diagnosticAlarm:find('next-chat-diagnostic-alarm'),diagnosticMessage:find('next-chat-diagnostic-message'),diagnosticReceipts:find('next-chat-diagnostic-receipts'),diagnosticDismiss:find('next-chat-diagnostic-dismiss'),
    stop:find('next-chat-stop'),scroll:find('next-chat-scroll'),timeline:find('next-chat-timeline'),
    cycleNotice:find('next-chat-cycle-notice'),cycleStatus:find('next-chat-cycle-status'),openPlan:find('next-chat-open-plan'),executionMode:find('next-chat-execution-mode'),
    form:find('next-chat-form'),input:find('next-chat-input'),attachments:find('next-chat-attachments'),model:find('next-chat-model'),
    goalToggle:find('next-chat-goal-toggle'),goalCard:find('next-chat-goal-card'),goalDetails:find('next-chat-goal-details'),goalDeadlineBrief:find('next-chat-goal-deadline-brief'),goalStatus:find('next-chat-goal-status'),goalObjective:find('next-chat-goal-objective'),goalProgress:find('next-chat-goal-progress'),goalDeadline:find('next-chat-goal-deadline'),goalReason:find('next-chat-goal-reason'),goalEdit:find('next-chat-goal-edit'),goalPause:find('next-chat-goal-pause'),goalResume:find('next-chat-goal-resume'),goalClear:find('next-chat-goal-clear'),goalDialog:find('next-chat-goal-dialog'),goalForm:find('next-chat-goal-form'),goalTitle:find('next-chat-goal-title'),goalInput:find('next-chat-goal-input'),goalContext:find('next-chat-goal-context'),goalLimit:find('next-chat-goal-limit'),goalDeadlineInput:find('next-chat-goal-deadline-input'),goalError:find('next-chat-goal-error'),goalCancel:find('next-chat-goal-cancel'),goalSave:find('next-chat-goal-save'),
    effort:find('next-chat-effort'),tier:find('next-chat-tier'),pastChats:find('next-chat-past-chats'),directoryActions:find('next-chat-directory-actions'),chatPlanning:find('next-chat-planning-actions'),send:find('next-chat-send'),hint:find('next-chat-hint') };
}

// Keep DOM identity while live metadata changes. The cache contains only the
// exposed window, so the full searchable catalog never becomes a DOM cache.
const indexViews = new WeakMap();

export function paintIndex(view, items, chosen, onSelect, {limit=CHAT_INDEX_BATCH,onMore,selecting=false,selection=new Map(),onToggle,onAction,busy=false,folderNames=new Map(),folders=[],groupFolders=false,showEmptyFolders=true,onFolderToggle,onFolderDelete,onFolderMove,onFolderRename,onFolderNew,onFolderCreate,onFolderArchive,onFolderRestore,folderState='active',folderDraft=null,expandFolders=false}={}) {
  const list=view.list,doc=list.ownerDocument;
  let cache=indexViews.get(list);
  if(!cache){cache={rows:new Map(),groups:new Map()};indexViews.set(list,cache);}
  cache.onMore=onMore;
  cache.onFolderMove=onFolderMove;
  if(!cache.dropBound){cache.dropBound=true;list.addEventListener('dragover',e=>{if(cache.drag&&e.target===list)e.preventDefault();});list.addEventListener('drop',e=>{if(e.target!==list||!cache.drag)return;e.preventDefault();const drag=cache.drag;cache.drag=null;void drag.commit(null);});}

  const {shown,hidden,pinned}=conversationIndexWindow(items,limit,chosen);
  const visible=pinned?[pinned,...shown]:shown,order=[],retained=new Set();
  const groupedRows=new Map(),groupCounts=new Map();let moved=false;
  const folderKey=item=>folderNames.has(item.folderId)?item.folderId:'';
  if(groupFolders)for(const item of items){const key=folderKey(item);groupCounts.set(key,(groupCounts.get(key)||0)+1);}
  const parentOf=id=>folders.find(folder=>folder.id===id)?.parentId??null;
  const exposed=()=>visible.filter(item=>{let key=folderKey(item);while(key!==null){if(!cache.groups.get(key)?.node.open)return false;key=parentOf(key);}return true;});
  const focused=list.contains(doc.activeElement)?doc.activeElement:null,scrollTop=list.scrollTop;
  const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  const marker=(key,label,className,tag='p')=>{
    if(!cache[key]){const node=doc.createElement(tag);node.className=className;cache[key]=node;}
    setText(cache[key],label);return cache[key];
  };
  if(!items.length)order.push(marker('empty','No conversations here.','next-chat-placeholder'));
  if(pinned&&!groupFolders)order.push(marker('pinned','Current conversation','next-conversation-pinned-label'));
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
      button.draggable=true;button.addEventListener('dragstart',event=>{const commit=cache.onFolderMove?.('chat',id);if(!commit){event.preventDefault();return;}cache.drag={commit};event.dataTransfer?.setData('text/plain',id);event.stopPropagation();});button.addEventListener('dragend',()=>cache.drag=null);
      entry.button=button;entry.titleNode=text(button,'','span','next-conversation-title');
      const foot=text(button,'','span','next-conversation-meta');
      entry.statusNode=text(foot,'');entry.dateNode=text(foot,'');
      entry.folderNode=text(button,'','small','next-conversation-folder-provenance');
      button.addEventListener('click',()=>entry.onSelect?.(entry.item));
      if(actions){
        const menu=text(row,'','details','next-conversation-actions');entry.menu=menu;
        entry.summary=text(menu,'…','summary');
        const contents=text(menu,'','div','next-conversation-menu');
        for(const [action,label]of [...(bucket!=='deleted'?[['rename','Rename']]:[]),['move_folder','Move to folder...'],[bucket==='active'?'archive':'restore',bucket==='active'?'Archive':'Restore'],...(bucket!=='deleted'?[['delete','Move to Trash']]:[])]){
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
    entry.button.title=title;
    if(entry.title!==title){
      setText(entry.titleNode,title);entry.title=title;
      entry.check?.setAttribute('aria-label','Select '+title);
      entry.summary?.setAttribute('aria-label','Actions for '+title);
    }
    const status=conversationGoalStatus(item.goal,item)||String(item.status==='completed'&&item.settled===true?(Object.values(item.nodes||{}).some(node=>node.directoryOutcome==='incomplete')?'Task incomplete':'Finished'):item.status==='completed'&&item.settled===false?'Finishing…':item.status||'Saved').replaceAll('_',' ');
    if(entry.status!==status){setText(entry.statusNode,status);entry.status=status;}
    const date=item.updatedAt||item.createdAt;
    if(entry.date!==date){setText(entry.dateNode,formatDate(date));entry.date=date;}
    const folderName=item.folderId?folderNames.get(item.folderId)||'Folder':null;
    const badge=folderName?folderName:'';
    setText(entry.folderNode,badge);
    entry.folderNode.hidden=!badge;
    entry.folderNode.title=item.folderReason||'';
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
    retained.add(id);
    if(groupFolders){const key=folderNames.has(item.folderId)?item.folderId:'';
      if(!groupedRows.has(key))groupedRows.set(key,[]);groupedRows.get(key).push(entry.row);
    }else order.push(entry.row);
  }
  const renderedGroups=[];
  if(groupFolders){
    const allGroups=[...folderNames.entries(),['','Unfiled']];
    for(const [key,name] of allGroups){
      const rows=groupedRows.get(key)||[],total=groupCounts.get(key)||0;
      const hasContent=id=>items.some(item=>{let p=folderKey(item);while(p){if(p===id)return true;p=parentOf(p);}return false;});
      if(!total&&(key===''||!showEmptyFolders&&!hasContent(key)))continue;
      let group=cache.groups.get(key);
      if(!group){
        const node=doc.createElement('details');node.className='next-chat-folder-group';node.dataset.chatFolder=key;
        const summary=text(node,'','summary','next-chat-folder-heading');
        const icon=text(summary,'','span','next-chat-tree-folder-icon');icon.setAttribute('aria-hidden','true');icon.innerHTML=treeSvg('folder');
        const label=text(summary,'',key?'button':'span',key?'next-chat-folder-name':''),count=text(summary,'','small');
        if(key){label.type='button';label.addEventListener('click',event=>{
          event.preventDefault();event.stopPropagation();if(group.editor)return;
          const commitRename=group.onRename?.();if(!commitRename)return;
          const input=doc.createElement('input');input.className='next-chat-folder-rename';input.value=group.label.textContent;input.maxLength=60;input.setAttribute('aria-label','Folder name');input.draggable=false;
          group.editor=input;label.hidden=true;summary.insertBefore(input,label);
          const finish=()=>{input.remove();group.editor=null;label.hidden=false;label.focus();};
          input.addEventListener('click',event=>event.stopPropagation());
          input.addEventListener('dragstart',event=>{event.preventDefault();event.stopPropagation();});
          input.addEventListener('keydown',async event=>{
            event.stopPropagation();if(event.key==='Escape'){event.preventDefault();if(!input.disabled)finish();return;}
            if(event.key!=='Enter')return;event.preventDefault();const value=input.value.trim();if(!value||input.disabled){input.setAttribute('aria-invalid','true');return;}
            input.disabled=true;const ok=await commitRename(value);input.disabled=false;
            if(ok)finish();else{input.setAttribute('aria-invalid','true');input.focus();}
          });input.focus();input.select();
        });}
        const body=text(node,'','div','next-chat-folder-children');
        const child=key?text(summary,'','button','next-chat-folder-create'):null;if(child){child.innerHTML=treeSvg('folderPlus');child.type='button';child.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();group.onCreate?.();});}
        const newChat=text(summary,'','button','next-chat-folder-new-chat');newChat.innerHTML=treeSvg('plus');newChat.type='button';newChat.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();group.onNew?.();});
        const remove=key?text(summary,'×','button','next-chat-folder-remove'):null;
        if(remove){remove.innerHTML=treeSvg('trash');remove.type='button';remove.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();group.onDelete?.();});}
        const archive=key?text(summary,'','button','next-chat-folder-archive'):null;const restore=key?text(summary,'','button','next-chat-folder-restore'):null;
        for(const [control,icon,action] of [[archive,'archive','onArchive'],[restore,'restore','onRestore']])if(control){control.innerHTML=treeSvg(icon);control.type='button';control.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();group[action]?.();});}
        summary.draggable=Boolean(key);summary.tabIndex=0;
        summary.addEventListener('dragstart',event=>{if(group.editor){event.preventDefault();return;}const commit=group.beginMove?.();if(!commit){event.preventDefault();return;}cache.drag={commit};event.dataTransfer?.setData('text/plain',key);event.stopPropagation();});
        summary.addEventListener('dragend',()=>cache.drag=null);
        summary.addEventListener('dragover',event=>{if(cache.drag){event.preventDefault();event.stopPropagation();}});
        summary.addEventListener('drop',event=>{if(!cache.drag)return;event.preventDefault();event.stopPropagation();const drag=cache.drag;cache.drag=null;void drag.commit(key||null);});
        summary.addEventListener('keydown',event=>{if(![summary,group.label].includes(event.target)||group.editor||!event.ctrlKey||event.key!=='Enter'||!key)return;event.preventDefault();event.stopPropagation();group.keyboardMove?.(event.shiftKey);});
        group={node,label,count,body,newChat,remove,child,archive,restore};cache.groups.set(key,group);node.open=true;
        node.addEventListener('toggle',()=>{group.onToggle?.();});
      }
      group.onToggle=()=>onFolderToggle?.(exposed());
      group.onDelete=()=>onFolderDelete?.(key);
      group.onArchive=()=>onFolderArchive?.(key);group.onRestore=()=>onFolderRestore?.(key);
      for(const [control,show,label] of [[group.archive,folderState==='active'&&onFolderArchive,'Archive '+name+' folder and its chats'],[group.restore,folderState!=='active'&&onFolderRestore,'Restore '+name+' folder and its chats']])if(control){control.hidden=!show;control.disabled=busy;control.setAttribute('aria-label',label);control.title=label;}
      group.onCreate=()=>onFolderCreate?.(key);
      if(group.child){group.child.hidden=!onFolderCreate||folderState!=='active';group.child.disabled=busy||Boolean(folderDraft);group.child.setAttribute('aria-label','New subfolder in '+name);group.child.title='New subfolder in '+name;}
      group.beginMove=()=>onFolderMove?.('folder',key);
      group.keyboardMove=out=>{const commit=group.beginMove();if(!commit)return;const parent=parentOf(key),siblings=folders.filter(f=>(f.parentId??null)===parent),index=siblings.findIndex(f=>f.id===key);if(out){if(parent)void commit(parentOf(parent));}else if(index>0)void commit(siblings[index-1].id);};
      if(group.remove){group.remove.disabled=busy;group.remove.hidden=!onFolderDelete||folderState==='deleted';group.remove.setAttribute('aria-label','Move '+name+' folder and its chats to Trash');}
      group.onRename=()=>onFolderRename?.(key);
      group.onNew=()=>onFolderNew?.(key||null);group.newChat.hidden=!onFolderNew||folderState!=='active';group.newChat.disabled=busy;group.newChat.setAttribute('aria-label','New chat in '+name);
      if(key){group.label.disabled=busy||!onFolderRename||folderState!=='active';group.label.setAttribute('aria-label','Rename '+name+' folder');group.label.title='Rename folder';}
      if(expandFolders&&total){if(!group.searchExpanded)group.beforeSearchOpen=group.node.open;group.searchExpanded=true;group.node.open=true;}
      else if(group.searchExpanded){group.node.open=group.beforeSearchOpen;group.searchExpanded=false;}
      setText(group.label,name);setText(group.count,String(total));
      const containsChosen=visible.some(item=>rootId(item)===chosen&&(folderNames.has(item.folderId)?item.folderId:'')===key);
      if(containsChosen&&group.chosen!==chosen)group.node.open=true;
      group.chosen=containsChosen?chosen:null;
      const children=[...rows,...folders.filter(f=>f.parentId===key&&(showEmptyFolders||hasContent(f.id))).map(f=>cache.groups.get(f.id)?.node).filter(Boolean)];
      if(folderDraft?.parentId===key){children.unshift(folderDraft.node);let p=key;while(p){cache.groups.get(p)&&(cache.groups.get(p).node.open=true);p=parentOf(p);}}
      if(!rows.length&&!folders.some(f=>f.parentId===key)&&folderDraft?.parentId!==key){if(!group.empty)group.empty=text(doc.createElement('div'),'','p','next-chat-folder-empty');setText(group.empty,total?'Load more chats below to see this folder.':'No chats in this folder.');children.push(group.empty);}
      for(let i=0;i<children.length;i++)if(group.body.childNodes[i]!==children[i]){group.body.insertBefore(children[i],group.body.childNodes[i]||null);moved=true;}
      while(group.body.childNodes.length>children.length)group.body.lastChild.remove();
      renderedGroups.push([key,group]);
    }
  }
  if(groupFolders){
    for(const [key,group] of renderedGroups){
      const parent=parentOf(key),container=parent?cache.groups.get(parent):null;
      if(container){if(group.node.parentElement!==container.body)container.body.append(group.node);if(group.chosen||expandFolders)container.node.open=true;}else order.push(group.node);
    }
  }
  if(groupFolders&&cache.chosen!==chosen){let parent=parentOf(folderKey(items.find(item=>rootId(item)===chosen)||{}));while(parent){const group=cache.groups.get(parent);if(group)group.node.open=true;parent=parentOf(parent);}cache.chosen=chosen;}
  if(folderDraft&&(!folderDraft.parentId||!renderedGroups.some(([id])=>id===folderDraft.parentId)))order.unshift(folderDraft.node);
  if(hidden>0){
    const more=marker('more','Show '+Math.min(CHAT_INDEX_BATCH,hidden)+' more ('+hidden+' remaining)','next-conversation-more','button');
    if(!cache.moreBound){more.type='button';more.addEventListener('click',()=>cache.onMore?.());cache.moreBound=true;}
    order.push(more);
  }
  // Move only rows whose order changed. Unchanged updates do not replace
  // children, close a menu, blur a focused control, or reset the scroll position.
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
  return groupFolders?exposed():visible;
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

const historyViews = new WeakMap();

// Anchor to visible content, rather than adding the transcript's total height
// change: new output below the reader must not move older text under the cursor.
export function captureChatScroll(view) {
  const scroll=view.scroll,top=scroll.scrollTop;
  const atBottom=scroll.scrollHeight-top-scroll.clientHeight<100;
  if(atBottom)return {atBottom};
  const edge=scroll.getBoundingClientRect().top;
  const turn=Array.from(view.timeline.querySelectorAll('.next-chat-turn'))
    .find(node=>node.getBoundingClientRect().bottom>edge);
  const anchor=Array.from(turn?.querySelectorAll('[data-scroll-anchor]')||[])
    .find(node=>node.getBoundingClientRect().bottom>edge);
  return {atBottom,top,key:anchor?.dataset.scrollAnchor,offset:anchor?.getBoundingClientRect().top-edge};
}

export function restoreChatScroll(view,position,{follow=false}={}) {
  const scroll=view.scroll;
  if(follow||position.atBottom){scroll.scrollTop=scroll.scrollHeight;return;}
  const anchor=position.key&&Array.from(view.timeline.querySelectorAll('[data-scroll-anchor]'))
    .find(node=>node.dataset.scrollAnchor===position.key);
  if(anchor)scroll.scrollTop+=anchor.getBoundingClientRect().top-scroll.getBoundingClientRect().top-position.offset;
  else scroll.scrollTop=position.top;
}

export function paintHistory(view, runs, { count=12, markdown, onOlder, onStop, onArtifact, onMoreMessages, messageLimits, getAttachment }={}) {
  const doc=view.timeline.ownerDocument;
  let cache=historyViews.get(view.timeline);
  if(!cache){cache={turns:new Map(),disclosures:new Map()};historyViews.set(view.timeline,cache);}
  // Retain nested disclosure state even while its closed parent is unmounted.
  const disclosures=cache.disclosures;
  for(const node of view.timeline.querySelectorAll('details[data-disclosure-id]'))disclosures.set(node.dataset.disclosureId,node.open);
  cache.callbacks={onOlder,onStop,onArtifact,onMoreMessages};
  const focused=doc.activeElement;
  const focusId=focused?.tagName==='SUMMARY'?focused.parentElement?.dataset.disclosureId:null;
  let restoreFocus=null;
  const disclosure=(parent,key,className)=>{
    const node=text(parent,'','details',className);node.dataset.disclosureId=key;
    node.open=disclosures.get(key)===true;
    const summary=text(node,'','summary');
    node.addEventListener('toggle',()=>{if(node.isConnected)disclosures.set(key,node.open);});
    if(key===focusId)restoreFocus=summary;
    return {node,summary};
  };
  const populate=(node,build)=>{
    let built=false;
    const show=()=>{if(node.open&&!built){built=true;build();}};
    node.addEventListener('toggle',show);show();
  };
  const {shown,hidden}=windowedRuns(runs,count), fragment=doc.createDocumentFragment(),order=[],retained=new Set();
  if (hidden > 0) {
    const older=text(fragment,'Show earlier responses ('+hidden+')','button','next-older');
    older.type='button';older.addEventListener('click',()=>cache.callbacks.onOlder?.());order.push(older);
  }
  if (!shown.length) {
    const placeholder=text(fragment,'The conversation has no saved responses yet.','div','next-chat-intro');
    placeholder.dataset.empty='true';
    order.push(placeholder);
  }
  for (let index=0; index<shown.length; index++) {
    const run=shown[index];
    const request=displayChatRequest(run);
    const earlier=index>0?shown[index-1]:undefined;
    const allMessages=Array.isArray(run.precomputedMessages)?run.precomputedMessages:messagesOfRun(run);
    const delivery=chatResponseState(run,allMessages);
    const {shown:messages,hidden:olderMessages}=windowedMessages(
      allMessages,messageLimits?.get(run.id)??CHAT_MESSAGE_BATCH);
    const failure=chatRunError(run),toolFailure=run.toolFailure??chatToolFailure(run);
    const skillLoads=projectSkillLoadReceipts(run.skillLoadReceipts);
    const planningModules=projectPlanningModuleReceipts(run);
    const signature=[run,...planningModules.flatMap(receipt=>[receipt.moduleId,receipt.phase]),...skillLoads.flatMap(receipt=>[receipt.type,receipt.skillId,receipt.title]),run.status,run.settled,run.output,failure?.message,failure?.code,toolFailure?.label,toolFailure?.detail,request,run.retryOf,earlier&&displayChatRequest(earlier),
      run===shown.at(-1),run.taskState,run.taskState?.revision,run.planningActivity,run.workflow,markdown,
      delivery.missing,delivery.pausedAfterPlan,delivery.needsFollowup,delivery.errors.join('\n'),
      messageLimits?.get(run.id),allMessages.length,...(run.attachmentIds||[]).flatMap(id=>[id,getAttachment?.(id)?.name]),
      ...messages.flatMap(message=>[message.id,message.text,message.phase,message.provisional,message.role,message.at,message.order,message.nodeId,message.direction])];
    const previous=cache.turns.get(run.id);
    retained.add(run.id);
    if(!running(run)&&previous&&signature.length===previous.signature.length&&signature.every((value,i)=>value===previous.signature[i])){
      order.push(previous.section);continue;
    }
    const section=text(fragment,'','section','next-chat-turn');section.dataset.runId=run.id;order.push(section);
    cache.turns.set(run.id,{section,signature});
    // Build once per visible turn: otherwise each streamed message searches
    // the entire workflow node array for its display name.
    const nodeNames=new Map();
    for(const node of run.workflow?.nodes||[]){
      if(node?.id&&!nodeNames.has(node.id))nodeNames.set(node.id,node.name||'BLACKICE');
    }
    // Suppress duplicate original prompt when a retry carries the same request.
    if (request && !(run.retryOf && earlier && displayChatRequest(earlier)===request)) {
      const user=text(section,'','article','next-message');user.dataset.role='user';
      user.dataset.scrollAnchor=run.id+':request';
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
    if(planningModules.length){
      const activity=text(section,'','div','next-chat-planning-modules');
      activity.setAttribute('aria-label','Planning module activity');
      if(running(run))activity.setAttribute('role','status');
      for(const receipt of planningModules)text(activity,receipt.title+': '+receipt.label,'div','next-chat-activity');
    }
    if(skillLoads.length){
      const receipts=text(section,'','div');
      if(running(run))receipts.setAttribute('role','status');
      for(const receipt of skillLoads)
        text(receipts,(receipt.type==='skill_context_submitted'?(receipt.source==='user'?'Owner-edited guidance sent: ':'Bundled guidance sent: '):'Skill loaded: ')+receipt.title,'div','next-chat-activity next-chat-skill-loaded');
    }

    if(olderMessages>0){
      const more=text(section,'Show earlier messages ('+olderMessages+')','button','next-older next-message-more');
      more.type='button';more.dataset.messageRun=run.id;
      more.addEventListener('click',()=>cache.callbacks.onMoreMessages?.(run.id));
    }
    const state=run===shown.at(-1)?run.taskState:null;
    const planView=state?taskPlanView(state,{runStatus:run.status,settled:run.settled}):null;
    const resolveArtifact=createRegisteredArtifactResolver(run);
    const appendAssistant=(parent,message)=>{
      const body=text(parent,'','div','next-message-body');
      if(running(run)||typeof markdown!=='function')body.textContent=message.text;
      else {
        body.innerHTML=markdown(message.text,{resolveArtifact,svgPreviews:true});
        bindChatSvgPreviews(body);
        body.addEventListener('click',event=>{const link=event.target.closest?.('[data-task-artifact][data-task-id]');if(link&&body.contains(link)){event.preventDefault();cache.callbacks.onArtifact?.({taskId:link.dataset.taskId,artifactId:link.dataset.taskArtifact});}});
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
          article.dataset.scrollAnchor=run.id+':'+entry.id;
          text(article,'You','div','next-message-title');text(article,entry.message.text,'div','next-message-body');
        }
      }else if(!isWork(phase)){
        const article=text(section,'','article','next-message next-chat-response');
        article.dataset.role='assistant';article.dataset.timelineId=phase.id;
        article.dataset.scrollAnchor=run.id+':'+phase.id;
        for(const entry of phase.entries)appendAssistant(article,entry.message);
      }
    }
    if(failure){
      const panel=text(section,'','div','next-chat-run-error');
      panel.dataset.scrollAnchor=run.id+':error';
      panel.setAttribute('role','alert');
      const heading=text(panel,'','div','next-chat-run-error-heading');
      text(heading,'Error','strong');
      if(failure.code)text(heading,failure.code,'code','next-chat-run-error-code');
      text(panel,failure.message,'p','next-chat-run-error-message');
    }
    const recoveryEvent=[...(run.events||[])].reverse().find(event=>event.data?.type==='planning.reassessment'&&event.data?.module==='modular-outcome');
    const recoveryStatus=run.outcomeRecoveryByNode?Object.entries(run.outcomeRecoveryByNode).some(([id,status])=>status==='recovering'&&(!run.nodes?.[id]?.status||run.nodes[id].status==='running'))?'recovering':'inactive':recoveryEvent?.data?.status;
    if(running(run)&&recoveryStatus==='recovering'){
      const warning=text(section,'Efficiency warning: trying a different approach.','div','next-chat-efficiency-warning');
      warning.setAttribute('role','status');warning.setAttribute('aria-live','polite');
    }
    if(running(run)&&recoveryStatus!=='recovering'){
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
      populate(audit,()=>{
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
              const appendFields=()=>{
                if(item.children.length)appendOutline(text(content,'','ol','next-chat-plan-outline'),item.children);
                for(const [label,value]of fields){
                  const field=text(content,'','p','next-chat-outline-evidence');
                  text(field,label+' · ','strong');text(field,value,'span');
                }
              };
              if(content)populate(content.parentElement,appendFields);
            }
          };
          appendOutline(text(body,'','ol','next-chat-plan-outline'),planView.roots);
        }
        if(workPhases.length){
          const {node:history,summary:historySummary}=disclosure(body,run.id+':history','next-chat-outline-history');
          historySummary.textContent='History';
          populate(history,()=>{
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
                populate(record,()=>{
                  const content=text(record,'','div','next-chat-outline-evidence');
                  if(entry.message){
                    if(phase.phase==='direction')text(content,entry.message.text,'p');
                    else appendAssistant(content,entry.message);
                  }else text(content,entry.text,'p');
                  if(entry.nextStepId)text(content,'Next saved step: '+entry.nextStepId,'p','next-help');
                });
              }
            }
          });
        }
      });
    }
    if(state){
      if(Array.isArray(state.artifacts)&&state.artifacts.length){
        const {node:details,summary}=disclosure(section,run.id+':files','next-chat-task-summary');
        summary.textContent='Files · '+state.artifacts.length;
        populate(details,()=>{
          for(const artifact of state.artifacts){
            if(typeof artifact.id!=='string')continue;
            const file=text(details,'','div','next-chat-saved-file');
            const button=text(file,artifact.title||artifact.fileName||'Saved file','button');
            button.type='button';
            button.addEventListener('click',()=>cache.callbacks.onArtifact?.({
              taskId:state.taskId||run.taskId,artifactId:artifact.id,
            }));
            if(artifact.size!=null)text(file,Number(artifact.size).toLocaleString()+' bytes','span','next-help');
          }
        });
      }
    }
    // The primary failure already appears in its alert above. Keep distinct
    // node diagnostics, without repeating that same saved message below it.
    const additionalErrors=delivery.errors.filter(error=>error!==failure?.message);
    if(delivery.needsFollowup||additionalErrors.length){
      const note=text(section,'','div','next-chat-result-note');
      if(delivery.missing)text(note,'This turn ended without a response. Send a follow-up to continue this conversation.','p','next-help');
      else if(delivery.needsFollowup&&!delivery.errors.length)text(note,'The turn failed before a response was received. Send a follow-up to continue this conversation.','p','next-help');
      for(const error of additionalErrors)text(note,error,'p','next-chat-error');
      if(delivery.needsFollowup&&run===shown.at(-1)&&view.input){
        const followup=text(note,'Write a follow-up','button');followup.type='button';
        // Preserve the draft and saved context. Never replay an empty turn's tools.
        followup.addEventListener('click',()=>view.input.focus());
      }
    }
    const footer=text(section,'','div','next-turn-meta');
    const directoryIncomplete=Object.values(run.nodes||{}).some(node=>node.directoryOutcome==='incomplete');
    const completedLabel=directoryIncomplete?'Task incomplete':delivery.missing?'No response received':delivery.pausedAfterPlan?'Plan ready':'Response saved';
    const pill=text(footer,run.status==='completed'&&run.settled===true?completedLabel:run.status==='completed'&&run.settled===false?'Finishing…':run.status||'saved','span','next-status-pill');
    pill.dataset.state=run.status||'saved';
    if(toolFailure&&run.settled===true){
      const receipt=text(footer,'','details','next-turn-note');
      text(receipt,toolFailure.label,'summary');
      text(receipt,toolFailure.detail,'p');
    }
    if(run.status==='failed'&&run.settled===true&&Object.values(run.nodes||{}).some(node=>node.directoryCheckpoint==='partial-source-notes'))text(footer,'Task incomplete. Directory keeps the partial, agent-reported source notes.','span','next-turn-note');
    if(run.status==='completed'&&run.settled===true&&hasPlan&&!planView.complete)text(footer,'Unfinished steps','span','next-turn-note');
    if (['failed','cancelled'].includes(run.status) && run.settled===true && !delivery.needsFollowup) {
      const retry=text(footer,'Retry','button');retry.type='button';retry.addEventListener('click',()=>cache.callbacks.onStop?.('retry',run.id));
    }
    if(running(run)){const stop=text(footer,'Stop','button');stop.type='button';stop.addEventListener('click',()=>cache.callbacks.onStop?.('stop',run.id));}
  }
  // Replacing the full transcript throws away Chromium's remembered sizes for
  // content-visibility turns and forces layout again during the next scroll.
  for(let i=0;i<order.length;i++)if(view.timeline.childNodes[i]!==order[i])view.timeline.insertBefore(order[i],view.timeline.childNodes[i]||null);
  while(view.timeline.childNodes.length>order.length)view.timeline.lastChild.remove();
  for(const id of cache.turns.keys())if(!retained.has(id))cache.turns.delete(id);
  for(const key of disclosures.keys())if(!shown.some(run=>key.startsWith(run.id+':')))disclosures.delete(key);
  if(restoreFocus&&doc.activeElement!==focused)restoreFocus.focus({preventScroll:true});
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
    const detail=current?.connectionRemoved?'The default API connection was removed. Choose another model.':current?.id?'Default resolves to '+current.id+(current.available?'':' (currently unavailable)'):'Default model has not yet been resolved.';
    view.model.title=detail;
    view.model.setAttribute('aria-label','Model. '+detail);
  }
  fill(view.effort,choices.efforts,choices.selected.effort);
  fill(view.tier,choices.tiers,choices.selected.serviceTier);
  if(view.executionMode)view.executionMode.value=choices.selected.planningExecutionMode;
  return choices;
}
