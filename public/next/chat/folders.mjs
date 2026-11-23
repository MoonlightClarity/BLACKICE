import {folderRows} from '../core/folder-tree.mjs';
import {rootId} from './model.mjs';

const choice = (doc,value,label) => {
  const option=doc.createElement('option');option.value=value;option.textContent=label;return option;
};
const short = error => String(error?.message||error||'Folder change failed.').slice(0,300);

// UI controller for *saved conversation* folder membership. The server is the
// sole authority for persisted revision, manual folder membership.
export function createConversationFolderUI({view,api,notify=()=>{},getItems,getBucket,getSelectedRoot,
  isBusy=()=>false,isActive=()=>true,onChanged=()=>{},onRefresh=()=>{},onError=()=>{}}) {
  let organization={revision:0,healthy:true,folders:[],counts:{byId:{},ungrouped:0,total:0}};
  let draft=null;
  let localBusy=false, destroyed=false, formRevision=0, movingRoot=null, movingRevision=null, pendingAction=null, lastUndo=null;
  const isWritable=()=>!destroyed&&!localBusy&&!isBusy()&&organization.healthy!==false;
  const folderById=id=>organization.folders.find(folder=>folder.id===id)||null;
  const nameOf=id=>folderById(id)?.name||'Unfiled';
  const getItem=id=>getItems().find(item=>rootId(item)===id);
  function notice(message='',bad=false) {
    view.folderStatus.hidden=!message;
    view.folderStatus.textContent=message;
    view.folderStatus.dataset.error=bad?'true':'false';
    if(bad)onError(new Error(message));
  }
  function refresh() {
    if(destroyed)return;
    if(draft){const parent=folderById(draft.parentId);view.folderDraftContext.textContent=draft.parentId?'New subfolder in '+draft.parentName+(!parent||(parent.state||'active')!==getBucket()?' (original destination unavailable here)':''):'New top-level folder';}
    const disabled=localBusy||isBusy()||organization.healthy===false;

    for(const element of [view.folderNew])element.disabled=disabled||Boolean(draft)||getBucket()!=='active';
    view.folderSave.disabled=disabled;view.folderCancel.disabled=disabled;
    view.folderUndo.hidden=!lastUndo;
    view.folderUndo.disabled=disabled;
    if(organization.healthy===false)notice(organization.error||'Folder metadata cannot be read. Existing chats are safe.',true);
    if(movingRoot!==null&&view.folderMoveDialog.open)renderMoveChoices();
  }
  function accept(snapshot) {
    if(!snapshot || !Array.isArray(snapshot.folders))return;
    organization=snapshot;
    refresh();
  }
  const filtered=items=>items;
  const visibleFolders=()=>{const folders=organization.folders.filter(folder=>(folder.state||'active')===getBucket()),ids=new Set(folders.map(f=>f.id));return folders.map(f=>({...f,parentId:ids.has(f.parentId)?f.parentId:null}));};
  const folderNames=()=>new Map(visibleFolders().map(folder=>[folder.id,folder.name]));
  async function save(operations,{success,after,expectedRevision=organization.revision,retryConflict=true}={}) {
    if(!isWritable())return false;
    localBusy=true;refresh();
    try {
      let result;
      for(let attempt=0;attempt<2;attempt++){
        try {
          result=await api('/api/conversation-folders/edit','POST',{
            expectedRevision:attempt?organization.revision:expectedRevision,operations
          });
          break;
        } catch(error) {
          // Only an explicit server revision rejection establishes that the
          // operation did not commit. No ambiguous request is ever replayed.
          if(!retryConflict || attempt!==0 || error?.status!==409 && error?.code!=='FOLDER_REVISION')throw error;
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
  function closeDraft(){if(localBusy)return;draft=null;view.folderForm.hidden=true;onChanged();}
  function formOpen(parentId=null) {
    if(!isWritable()||draft||getBucket()!=='active')return;
    if(parentId&&!folderById(parentId))return;
    formRevision=organization.revision;
    draft={parentId,parentName:parentId?nameOf(parentId):null,node:view.folderForm};
    view.folderName.value='';view.folderName.setAttribute('aria-label',parentId?'New subfolder in '+nameOf(parentId):'New top-level folder');
    view.folderDialogError.hidden=true;view.folderForm.hidden=false;refresh();onChanged();view.folderName.focus();
  }
  const folderOrder=new Intl.Collator('en',{sensitivity:'base',numeric:true});
  function renderMoveChoices(opening=false){
    if(movingRoot===null)return;
    const doc=view.folderMoveTarget.ownerDocument;
    const item=getItem(movingRoot);
    const selected=opening?(item?.folderId||''):view.folderMoveTarget.value;
    const query=view.folderMoveSearch.value.trim().toLocaleLowerCase();
    const rows=folderRows(visibleFolders()).sort((a,b)=>folderOrder.compare(a.path,b.path)||folderOrder.compare(a.id,b.id));
    const all=[{id:'',path:'Unfiled'},...rows];
    const matches=all.filter(row=>row.path.toLocaleLowerCase().includes(query));
    const options=matches.map(row=>choice(doc,row.id,row.path));
    if(!matches.some(row=>row.id===selected)){
      const original=all.find(row=>row.id===selected);
      const retained=choice(doc,selected,original?original.path+' (selected)':'Unavailable: selected folder');
      retained.disabled=!original;
      options.unshift(retained);
    }
    view.folderMoveTarget.replaceChildren(...options);
    view.folderMoveTarget.value=selected;
    const valid=selected===''||rows.some(row=>row.id===selected);
    view.folderMoveSave.disabled=!isWritable()||!valid;
    view.folderMoveCount.textContent=matches.length+' matching destinations.'+(valid?'':' Choose an available folder.');
  }
  function moveOpen(item) {
    if(!item||!isWritable())return;
    movingRoot=rootId(item);movingRevision=organization.revision;
    view.folderMoveTitle.textContent='Organize: '+String(item.title||'Conversation').slice(0,80);
    view.folderMoveReason.textContent='Choose where to keep this chat. Moving it does not share context.';
    view.folderMoveSearch.value='';
    renderMoveChoices(true);
    view.folderMoveDialog.showModal();view.folderMoveSearch.focus();
  }
  async function moveChat(item,destination,expectedRevision) {
    const previous=item.folderSource?{folderId:item.folderId??null,source:item.folderSource,
      reason:String(item.folderReason||'').slice(0,240)}:
      {folderId:null,source:'manual',reason:'Undo move: manually kept Unfiled.'};
    const id=rootId(item);
    const ok=await save([{type:'assign',rootId:id,folderId:destination}],{
      success:'Chat moved to '+(destination?nameOf(destination):'Unfiled')+'.',
      expectedRevision,retryConflict:false,
      after:()=>{lastUndo={rootId:id,previous};}
    });
    return ok;
  }
  function onRowAction(item,action) { if(action==='move_folder')moveOpen(item); }
  function onListLoaded(items,snapshot) {
    accept(snapshot);
    refresh();
  }
  function stop() {
    for(const dialog of [view.folderMoveDialog,view.folderDeleteDialog])if(dialog.open)dialog.close();
    movingRoot=null;movingRevision=null;pendingAction=null;
  }
  function destroy() {destroyed=true;stop();}
  view.folderNew.addEventListener('click',()=>formOpen(null));
  view.folderCancel.addEventListener('click',closeDraft);
  view.folderForm.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeDraft();}});
  view.folderForm.addEventListener('dragstart',event=>{event.preventDefault();event.stopPropagation();});
  view.folderForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const name=view.folderName.value.trim();
    if(!name)return;
    if(!draft)return;
    const parentId=draft.parentId;
    const ok=await save([{type:'create_folder',name,parentId}],{expectedRevision:formRevision,retryConflict:false,
      success:'Folder created.',
      after:()=>{draft=null;view.folderForm.hidden=true;}
    });
    if(!ok){view.folderDialogError.hidden=false;view.folderDialogError.textContent=view.folderStatus.textContent;}
  });
  view.folderDeleteDialog.addEventListener('cancel',event=>{if(localBusy)event.preventDefault();else pendingAction=null;});
  view.folderDeleteCancel.addEventListener('click',()=>{if(localBusy)return;pendingAction=null;view.folderDeleteDialog.close();});
  view.folderDeleteConfirm.addEventListener('click',async()=>{
    if(!pendingAction||!isWritable())return;
    const request=pendingAction;localBusy=true;view.folderDeleteConfirm.disabled=true;view.folderDeleteCancel.disabled=true;refresh();
    try{
      const result=await api('/api/conversation-folders/'+encodeURIComponent(request.id)+'/'+request.action,'POST',{expectedRevision:request.revision,expectedMetadataRevision:request.lifecycleRevision});
      accept(result.folderOrganization);pendingAction=null;lastUndo=null;view.folderDeleteDialog.close();notice(request.action==='delete'?'Folder and its chats moved to Trash.':request.action==='archive'?'Folder and its chats archived.':'Folder and its chats restored.');
      onRefresh();onChanged();
    }catch(error){view.folderDeleteError.hidden=false;view.folderDeleteError.textContent=short(error);}
    finally{localBusy=false;view.folderDeleteConfirm.disabled=false;view.folderDeleteCancel.disabled=false;refresh();}
  });
  view.folderMoveSearch.addEventListener('input',()=>renderMoveChoices());
  view.folderMoveTarget.addEventListener('change',()=>renderMoveChoices());
  view.folderMoveCancel.addEventListener('click',()=>{movingRoot=null;movingRevision=null;view.folderMoveDialog.close();});
  view.folderMoveDialog.addEventListener('cancel',()=>{movingRoot=null;movingRevision=null;});
  view.folderMoveForm.addEventListener('submit',event=>{
    event.preventDefault();
    const item=getItem(movingRoot),destination=view.folderMoveTarget.value||null;
    const selected=organization.folders.some(folder=>folder.id===destination&&(folder.state||'active')===getBucket())||destination===null;
    if(!selected||!isWritable()){notice('The selected folder is no longer available. Choose another destination.',true);return;}
    const expectedRevision=movingRevision;
    movingRoot=null;movingRevision=null;view.folderMoveDialog.close();
    if(item&&destination!==(item.folderId||null))void moveChat(item,destination,expectedRevision);
  });
  view.folderUndo.addEventListener('click',()=>{
    if(!lastUndo)return;
    const undo=lastUndo;
    void save([{type:'restore_assignment',rootId:undo.rootId,previous:undo.previous}],{
      success:'Previous folder placement restored.',
      after:()=>{lastUndo=null;}
    });
  });

  function beginRename(id){
    if(!folderById(id)||!isWritable()||getBucket()!=='active')return null;
    refresh();
    const revision=organization.revision,before=folderById(id).name;
    return async name=>{
      if(organization.revision!==revision||folderById(id)?.name!==before){notice('Folder changed while editing. Your draft was kept. Press Escape and reopen to edit the current name.',true);return false;}
      return save([{type:'rename_folder',folderId:id,name}],{success:'Folder renamed.',expectedRevision:revision,retryConflict:false});
    };
  }
  function beginMove(kind,id){
    if(!isWritable()||getBucket()!=='active')return null;const revision=organization.revision;
    return parentId=>save([kind==='folder'?{type:'move_folder',folderId:id,parentId}:{type:'assign',rootId:id,folderId:parentId}],{expectedRevision:revision,retryConflict:false,success:'Moved.'});
  }
  function folderAction(id,action){
    if(!isWritable()||!folderById(id))return;
    if(draft){notice('Save or cancel the new folder first.',true);return;}
    pendingAction={id,action,revision:organization.revision,lifecycleRevision:organization.lifecycleRevision};
    const verb=action==='delete'?'Move to Trash':action==='archive'?'Archive':'Restore';
    view.folderDeleteTitle.textContent=verb+' folder?';
    view.folderDeleteLabel.textContent='"'+nameOf(id)+'" and every nested folder and chat will '+(action==='delete'?'move to Trash.':action==='archive'?'move to Archive.':'return to Active. Restore its parent folder first if needed.')+(action==='restore'?'':' You can restore them, but the chats’ Receipts will be permanently removed.');
    view.folderDeleteConfirm.textContent=verb;view.folderDeleteError.hidden=true;view.folderDeleteDialog.showModal();
  }
  const removeFolder=id=>folderAction(id,'delete');

  return {folderAction,get folders(){return visibleFolders();},createFolder:formOpen,get draft(){return draft;},beginMove,removeFolder,beginRename,accept,filtered,folderNames,onRowAction,onListLoaded,stop,destroy,refresh,
    get selected(){return 'all';},get organization(){return organization;}};
}

/** Assign only after a real accepted run exists. Never replay a send to fix placement. */
export async function placeNewConversation(api,rootId,folderId=null){
 const snapshot=await api('/api/conversation-folders?state=active','GET');
 const organization=snapshot?.folderOrganization;
 if(!organization||organization.healthy===false)throw Error('Folder metadata could not be read.');
 if(folderId&&!organization.folders.some(folder=>folder.id===folderId))throw Error('The selected folder no longer exists.');
 return api('/api/conversation-folders/edit','POST',{expectedRevision:organization.revision,operations:[{type:'assign',rootId,folderId}]});
}
