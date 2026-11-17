import {rootId} from './model.mjs';

const AUTO_BATCH = 40;
const SESSION_BUDGET = 600;
const safeGet = key => { try {return localStorage.getItem(key);} catch {return null;} };
const safeSet = (key,value) => {try {localStorage.setItem(key,value);} catch {}};
const choice = (doc,value,label) => {
  const option=doc.createElement('option');option.value=value;option.textContent=label;return option;
};
const short = error => String(error?.message||error||'Folder change failed.').slice(0,300);

// UI controller for *saved conversation* folder membership. The server is the
// sole authority for persisted revision, source and automatic classification.
export function createConversationFolderUI({view,api,notify=()=>{},getItems,getBucket,getSelectedRoot,
  isBusy=()=>false,isActive=()=>true,onChanged=()=>{},onRefresh=()=>{},onError=()=>{}}) {
  let organization={revision:0,healthy:true,autoEnabled:true,folders:[],counts:{byId:{},ungrouped:0,total:0}};
  let selected=safeGet('blackice.next.chatFolder')||'all';
  let localBusy=false, destroyed=false, formKind='create', formId=null, movingRoot=null, deletingId=null, lastUndo=null;
  let autoTimer=null,autoBusy=false,considered=new Set(),queue=[],processed=0,budget=SESSION_BUDGET;
  const isWritable=()=>!destroyed&&!localBusy&&!isBusy()&&organization.healthy!==false;
  const folderById=id=>organization.folders.find(folder=>folder.id===id)||null;
  const nameOf=id=>folderById(id)?.name||'Unfiled';
  const selectedFolder=()=>selected==='all'||selected==='ungrouped'?null:folderById(selected);
  const getItem=id=>getItems().find(item=>rootId(item)===id);
  function notice(message='',bad=false) {
    view.folderStatus.hidden=!message;
    view.folderStatus.textContent=message;
    view.folderStatus.dataset.error=bad?'true':'false';
    if(bad)onError(new Error(message));
  }
  function refresh() {
    if(destroyed)return;
    const items=getItems(),counts={byId:{},ungrouped:0,total:items.length};
    for(const item of items) {
      if(item.folderId)counts.byId[item.folderId]=(counts.byId[item.folderId]||0)+1;
      else counts.ungrouped++;
    }
    const doc=view.folderFilter.ownerDocument,oldSelected=selected;
    view.folderFilter.replaceChildren(
      choice(doc,'all','All chats ('+counts.total+')'),
      choice(doc,'ungrouped','Unfiled ('+counts.ungrouped+')'),
      ...organization.folders.map(folder=>choice(doc,folder.id,folder.name+' ('+(counts.byId[folder.id]||0)+')'))
    );
    if(oldSelected!=='all'&&oldSelected!=='ungrouped'&&!folderById(oldSelected)){
      selected='all';safeSet('blackice.next.chatFolder',selected);
    }
    view.folderFilter.value=selected;
    const named=Boolean(selectedFolder()),disabled=localBusy||isBusy()||organization.healthy===false;
    view.folderRename.hidden=!named;view.folderDelete.hidden=!named;
    for(const element of [view.folderNew,view.folderRename,view.folderDelete])element.disabled=disabled;
    view.folderAuto.checked=organization.autoEnabled!==false;
    view.folderAuto.disabled=disabled;
    view.folderUndo.hidden=!lastUndo;
    view.folderUndo.disabled=disabled;
    if(organization.healthy===false)notice(organization.error||'Folder metadata cannot be read. Existing chats are safe.',true);
  }
  function accept(snapshot) {
    if(!snapshot || !Array.isArray(snapshot.folders))return;
    const changed=snapshot.generation!==organization.generation;
    organization=snapshot;
    if(changed)for(const item of getItems())if(!item.folderId&&item.folderSource!=='manual')considered.delete(rootId(item));
    refresh();
  }
  function filtered(items) {
    if(selected==='all')return items;
    return items.filter(item=>selected==='ungrouped'?!item.folderId:item.folderId===selected);
  }
  const folderNames=()=>new Map(organization.folders.map(folder=>[folder.id,folder.name]));
  async function save(operations,{success,after}={}) {
    if(!isWritable())return false;
    localBusy=true;refresh();
    try {
      let result;
      for(let attempt=0;attempt<2;attempt++){
        try {
          result=await api('/api/conversation-folders/edit','POST',{
            expectedRevision:organization.revision,operations
          });
          break;
        } catch(error) {
          // Only an explicit server revision rejection establishes that the
          // operation did not commit. No ambiguous request is ever replayed.
          if(attempt!==0 || error?.status!==409 && error?.code!=='FOLDER_REVISION')throw error;
          const fresh=await api('/api/conversation-folders?state='+encodeURIComponent(getBucket()),'GET');
          if(!fresh.folderOrganization?.healthy)throw error;
          organization=fresh.folderOrganization;
        }
      }
      accept(result?.folderOrganization);
      if(typeof after==='function')after();
      if(success){notice(success);notify(success);}
      onRefresh();
      return true;
    } catch(error) {
      notice(short(error),true);
      return false;
    } finally {localBusy=false;refresh();}
  }
  function formOpen(kind,id=null) {
    if(!isWritable())return;
    formKind=kind;formId=id;
    const folder=folderById(id);
    view.folderDialogTitle.textContent=kind==='create'?'Create folder':'Rename folder';
    view.folderSave.textContent=kind==='create'?'Create folder':'Save name';
    view.folderName.value=folder?.name||'';
    view.folderDialogError.hidden=true;
    view.folderDialog.showModal();view.folderName.focus();
    if(kind==='rename')view.folderName.select();
  }
  function moveOpen(item) {
    if(!item||!isWritable())return;
    movingRoot=rootId(item);
    view.folderMoveTitle.textContent='Organize: '+String(item.title||'Conversation').slice(0,80);
    view.folderMoveReason.textContent=item.folderSource==='automatic'?
      (item.folderReason||'Automatically placed using its saved title.'):
      item.folderSource==='manual'?(item.folderReason||'Manually placed.'):
      (item.folderReason||'No confident automatic assignment.');
    const doc=view.folderMoveTarget.ownerDocument;
    view.folderMoveTarget.replaceChildren(choice(doc,'','Unfiled'),
      ...organization.folders.map(folder=>choice(doc,folder.id,folder.name)));
    view.folderMoveTarget.value=item.folderId||'';
    view.folderMoveDialog.showModal();view.folderMoveTarget.focus();
  }
  async function moveChat(item,destination) {
    const previous=item.folderSource?{folderId:item.folderId??null,source:item.folderSource,
      reason:String(item.folderReason||'').slice(0,240)}:
      {folderId:null,source:'manual',reason:'Undo move: manually kept Unfiled.'};
    const id=rootId(item);
    const ok=await save([{type:'assign',rootId:id,folderId:destination}],{
      success:'Chat moved to '+(destination?nameOf(destination):'Unfiled')+'.',
      after:()=>{lastUndo={rootId:id,previous};}
    });
    return ok;
  }
  async function resetAuto(id) {
    const ok=await save([{type:'reset_auto',rootId:id}],{
      success:'Manual placement cleared. Automatic grouping will check the title if enabled.',
      after:()=>{lastUndo=null;considered.delete(id);queue.unshift(id);}
    });
    if(ok)scheduleAuto();
    return ok;
  }
  function onRowAction(item,action) {
    if(action==='move_folder')moveOpen(item);
    else if(action==='reset_folder_auto')void resetAuto(rootId(item));
  }
  // Foreground-only bounded title scans. No implicit provider call, history
  // transcript scan, job start or workflow execution.
  function eligible(item) {
    return rootId(item)!==getSelectedRoot() && item.state!=='deleted' && item.folderSource!=='manual' && !item.folderId && !['queued','running','waiting'].includes(item.status) && item.settled!==false;
  }
  function enqueue(items) {
    if(!isActive()||!organization.autoEnabled||organization.healthy===false)return;
    const old=new Set(queue);
    for(const item of items) {
      const id=rootId(item);
      if(!id||considered.has(id)||old.has(id)||!eligible(item))continue;
      queue.push(id);old.add(id);
    }
    scheduleAuto();
  }
  function scheduleAuto() {
    if(destroyed||autoTimer||autoBusy||!isActive()||!organization.autoEnabled||organization.healthy===false)return;
    if(queue.length&&processed<budget)autoTimer=setTimeout(()=>{autoTimer=null;void stepAuto();},180);
    else if(queue.length&&processed>=budget){
      view.folderMore.hidden=false;
      notice('Automatic title scan paused after '+processed+' chats this visit. You can organize more.',false);
    }
  }
  async function stepAuto() {
    if(autoBusy||localBusy||isBusy()||!isActive()){scheduleAuto();return;}
    const batch=queue.splice(0,Math.min(AUTO_BATCH,budget-processed)).filter(id=>{const item=getItem(id);return item&&eligible(item);});
    if(!batch.length){scheduleAuto();return;}
    autoBusy=true;
    try{
      const earlierGeneration=organization.generation;
      const response=await api('/api/conversation-folders/auto-step','POST',{
        rootIds:batch,excludeRootId:getSelectedRoot()||null
      });
      if(!response.folderOrganization)throw Error('No folder scan receipt.');
      const updates=new Map((response.folderOrganization.updated||[]).map(item=>[item.rootId,item]));
      for(const item of getItems()) {
        const current=updates.get(rootId(item));
        if(current)for(const key of ['folderId','folderSource','folderReason','folderSuggestion'])
          item[key]=current[key];
      }
      accept(response.folderOrganization);
      const accepted=new Set(response.folderOrganization.acceptedRootIds||[]);
      for(const id of batch)if(accepted.has(id))considered.add(id);
      processed+=batch.length;
      if(organization.generation!==earlierGeneration)enqueue(getItems());
      onChanged();
    }catch(error){notice('Automatic title scan stopped: '+short(error),true);queue=[];}
    finally{autoBusy=false;scheduleAuto();}
  }
  function onListLoaded(items,snapshot) {
    accept(snapshot);
    refresh();
    enqueue(items);
  }
  function stop() {
    clearTimeout(autoTimer);autoTimer=null;queue=[];
    for(const dialog of [view.folderDialog,view.folderMoveDialog,view.folderDeleteDialog])if(dialog.open)dialog.close();
    movingRoot=null;deletingId=null;
  }
  function destroy() {destroyed=true;stop();}
  view.folderFilter.addEventListener('change',()=>{
    selected=view.folderFilter.value;safeSet('blackice.next.chatFolder',selected);
    refresh();onChanged();
  });
  view.folderNew.addEventListener('click',()=>formOpen('create'));
  view.folderRename.addEventListener('click',()=>{if(selectedFolder())formOpen('rename',selected);});
  view.folderDelete.addEventListener('click',()=>{
    if(!selectedFolder()||!isWritable())return;
    deletingId=selected;view.folderDeleteLabel.textContent='Delete "'+selectedFolder().name+'"?';
    view.folderDeleteDialog.showModal();
  });
  view.folderCancel.addEventListener('click',()=>view.folderDialog.close());
  view.folderForm.addEventListener('submit',event=>{
    event.preventDefault();
    const name=view.folderName.value.trim(),kind=formKind,id=formId;
    if(!name)return;
    view.folderDialog.close();
    const beforeIds=new Set(organization.folders.map(folder=>folder.id));
    void save([kind==='create'?{type:'create_folder',name}:{type:'rename_folder',folderId:id,name}],{
      success:kind==='create'?'Folder created.':'Folder renamed.',
      after:()=>{if(kind==='create'){
        const added=organization.folders.find(folder=>!beforeIds.has(folder.id));
        if(added){selected=added.id;safeSet('blackice.next.chatFolder',selected);}
      }}
    });
  });
  view.folderDeleteCancel.addEventListener('click',()=>{deletingId=null;view.folderDeleteDialog.close();});
  view.folderDeleteConfirm.addEventListener('click',()=>{
    const id=deletingId;deletingId=null;view.folderDeleteDialog.close();
    if(!id)return;
    void save([{type:'delete_folder',folderId:id}],{
      success:'Folder deleted; all chats and their Archive/Trash states were preserved.',
      after:()=>{selected='all';lastUndo=null;safeSet('blackice.next.chatFolder',selected);}
    });
  });
  view.folderMoveCancel.addEventListener('click',()=>{movingRoot=null;view.folderMoveDialog.close();});
  view.folderMoveForm.addEventListener('submit',event=>{
    event.preventDefault();
    const item=getItem(movingRoot),destination=view.folderMoveTarget.value||null;
    movingRoot=null;view.folderMoveDialog.close();
    if(item)void moveChat(item,destination);
  });
  view.folderMoveAuto.addEventListener('click',()=>{
    const id=movingRoot;movingRoot=null;view.folderMoveDialog.close();
    if(id)void resetAuto(id);
  });
  view.folderAuto.addEventListener('change',()=>{
    const enabled=view.folderAuto.checked;
    void save([{type:'toggle_auto',enabled}],{
      success:enabled?'Automatic title grouping enabled.':'Automatic grouping disabled; existing placements remain.',
      after:()=>{if(enabled){considered.clear();processed=0;enqueue(getItems());}else stop();}
    });
  });
  view.folderUndo.addEventListener('click',()=>{
    if(!lastUndo)return;
    const undo=lastUndo;
    void save([{type:'restore_assignment',rootId:undo.rootId,previous:undo.previous}],{
      success:'Previous folder placement restored.',
      after:()=>{lastUndo=null;}
    });
  });
  view.folderMore.addEventListener('click',()=>{
    budget+=SESSION_BUDGET;view.folderMore.hidden=true;notice('');
    enqueue(getItems());scheduleAuto();
  });
  function manage(id){if(!folderById(id)||!isWritable())return;selected=id;safeSet('blackice.next.chatFolder',selected);refresh();onChanged();view.folderRename.focus();}
  return {manage,accept,filtered,folderNames,onRowAction,onListLoaded,stop,destroy,refresh,
    get selected(){return selected;},get organization(){return organization;}};
}
