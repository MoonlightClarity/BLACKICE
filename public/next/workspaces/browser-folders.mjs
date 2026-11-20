import {browserIconButton,browserIconMarkup} from './browser-usage-ui.mjs';
import {folderPath,descendants} from '../core/folder-tree.mjs';
export function browserCollectionTree(collections,tabs){
 const map=new Map((collections||[]).map(f=>[f.id,{...f,children:[],tabs:[]}]));
 const roots=[],loose=[];for(const f of map.values()){let id=f.parentId,valid=map.has(id),seen=new Set([f.id]);while(id){if(seen.has(id)){valid=false;break;}seen.add(id);id=map.get(id)?.parentId;}(valid?map.get(f.parentId).children:roots).push(f);}
 for(const tab of tabs||[])(map.get(tab.collectionId)?.tabs||loose).push(tab);return {roots,loose};
}
// One app-owned tree moves the existing tab rows. Selection/close handlers and
// host collection/ownership persistence remain authoritative, without an extension.
export function createBrowserFolders({api,getTabs,getSelected,isBusy,refresh,notice,onModalChange=()=>{}}){
 let collections=[],host=null,pending=false,destroyed=false,editor=null,editorDialog=null,syncMoveDestination=null,rows=[],extras=[],selectedBefore=null;
 const collapsed=new Set(),renameDrafts=new Map();let renaming=null;
 const blocked=()=>pending||isBusy()||destroyed;
 const el=(tag,label,cls)=>{const n=host.ownerDocument.createElement(tag);if(label)n.textContent=label;if(cls)n.className=cls;return n;};
 const button=(label,fn,cls)=>{const n=el('button',label,cls);n.type='button';n.disabled=blocked();n.addEventListener('click',fn);return n;};
 async function request(action,args){
  if(blocked())return false;
  if(action==='tab_collect'&&!getTabs().some(t=>t.tabId===args.tabId))return false;
  pending=true;paint();
  try{await api('/api/browser/action','POST',{browser:'relay',action,...args});if(!destroyed)await refresh();return true;}
  catch(error){if(!destroyed)notice(error.message,true);return false;}
  finally{pending=false;if(!destroyed)paint();}
 }
 function moveFolder(id,parentId){
  if(!collections.some(f=>f.id===id)||id===parentId||descendants(collections,id).has(parentId))return;
  return request('collection_move',{collectionId:id,parentCollectionId:parentId||null});
 }
 async function outlineKey(e,folderId,tabId){
  if(e.key!=='Enter'||!e.ctrlKey||e.altKey||e.metaKey||e.target.closest('input,select,textarea'))return;
  e.preventDefault();e.stopPropagation();if(blocked())return;
  const folder=collections.find(f=>f.id===folderId),tab=getTabs().find(t=>t.tabId===tabId);
  const parentId=folder?folder.parentId:tab?.collectionId;
  let target;
  if(e.shiftKey){if(!parentId)return;target=collections.find(f=>f.id===parentId)?.parentId||null;}
  else{const siblings=collections.filter(f=>(f.parentId||null)===(parentId||null));
   const index=folder?siblings.findIndex(f=>f.id===folderId):siblings.length;target=siblings[index-1]?.id;
   if(!target){notice('No preceding folder to indent into. Drag onto a folder instead.');return;}}
  const tree=host,doc=tree.ownerDocument,hadFocus=e.target===doc.activeElement;
  const moved=folder?await moveFolder(folderId,target):tab?await request('tab_collect',{tabId,collectionId:target}):false;
  if(destroyed||host!==tree||!tree.isConnected||tree.closest('[hidden]'))return;
  if(moved&&collapsed.delete(target))paint();
  // Rebuilding the busy outline temporarily disables its labels and drops focus.
  // Restore only a previously focused control, never a newer focus outside the outline.
  if(hadFocus&&doc.activeElement===doc.body){
   const controls=folder?tree.querySelectorAll('[data-folder-control]'):tree.querySelectorAll('[data-tab-id]');
   [...controls].find(n=>folder?n.dataset.folderControl==='edit:'+folderId:n.dataset.tabId===tabId)?.focus({preventScroll:true});
  }
 }
 function dropTarget(node,parentId){
  node.addEventListener('dragover',e=>{if(blocked())return;const types=[...e.dataTransfer.types];
   if(types.includes('application/x-blackice-tab')||types.includes('application/x-blackice-folder')){e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';node.dataset.dropTarget='true';}});
  node.addEventListener('dragleave',()=>{delete node.dataset.dropTarget;});
  node.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();delete node.dataset.dropTarget;if(blocked())return;
   const folder=e.dataTransfer.getData('application/x-blackice-folder'),tab=e.dataTransfer.getData('application/x-blackice-tab');
   if(folder)void moveFolder(folder,parentId);else if(tab)void request('tab_collect',{tabId:tab,collectionId:parentId||null});
  });
 }
 function rename(folder){
  if(blocked())return;renaming=folder.id;paint();
  const input=renameDrafts.get(folder.id);input?.focus();input?.select?.();
 }
 function renameField(folder){
  let input=renameDrafts.get(folder.id);if(input){input.disabled=blocked();return input;}
  input=el('input',null,'next-browser-folder-rename');input.disabled=blocked();input.value=folder.name;input.maxLength=200;input.setAttribute('aria-label','Rename '+folder.name);
  input.addEventListener('keydown',async e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!pending){renameDrafts.delete(folder.id);renaming=null;paint();[...host.querySelectorAll('[data-folder-control]')].find(n=>n.dataset.folderControl==='edit:'+folder.id)?.focus();}}
   if(e.key==='Enter'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();e.stopPropagation();if(!input.value.trim()){notice('Folder name cannot be empty.',true);return;}
    if(await request('collection_rename',{collectionId:folder.id,name:input.value,expectedName:folder.name})){renameDrafts.delete(folder.id);renaming=null;paint();[...host.querySelectorAll('[data-folder-control]')].find(n=>n.dataset.folderControl==='edit:'+folder.id)?.focus();}
   }
  });renameDrafts.set(folder.id,input);return input;
 }
 function dismiss(){editorDialog?.close?.();editorDialog?.remove();editorDialog=null;editor?.remove();editor=null;syncMoveDestination=null;onModalChange(false);paint();}
 function edit(tabId=null,parentId=null){
  if(blocked())return;
  editorDialog?.close?.();editorDialog?.remove();editorDialog=null;editor?.remove();syncMoveDestination=null;const form=el('form',null,'next-browser-folder-editor');editor=form;
  const createLabel=parentId?'New subfolder in '+folderPath(collections,parentId):'New folder';
  form.setAttribute('aria-label',tabId?'Move tab to folder':parentId?createLabel:'New tab folder');
  const heading=el('strong',tabId?'Move '+(getTabs().find(tab=>tab.tabId===tabId)?.title||'tab'):createLabel);form.append(heading);
  if(tabId){editorDialog=el('dialog',null,'next-chat-management-dialog next-browser-move-dialog');editorDialog.setAttribute('aria-label','Move '+(getTabs().find(tab=>tab.tabId===tabId)?.title||'tab')+' to folder');editorDialog.append(form);editorDialog.addEventListener('cancel',event=>{event.preventDefault();if(!pending)dismiss();});}
  const input=el(tabId?'select':'input');
  if(tabId)input.setAttribute('aria-label','Folder');
  else{input.placeholder='Folder name';input.maxLength=200;input.required=true;input.setAttribute('aria-label','Folder name');}
  form.append(input);
  const save=button(tabId?'Move':'Save',()=>{});save.type='submit';form.append(save,button('Cancel',dismiss));
  if(tabId){
   const status=el('p','The selected folder no longer exists. Choose another destination.','next-browser-move-status');status.setAttribute('role','status');status.hidden=true;form.append(status);
   let initial=getTabs().find(t=>t.tabId===tabId)?.collectionId||'',rendered='',previous=new Map(),missingLabel=null;
   syncMoveDestination=()=>{
    const selected=initial??input.value;initial=null;
    const options=new Map(collections.map(f=>[f.id,folderPath(collections,f.id)]));
    const missing=!!selected&&!options.has(selected);
    missingLabel=missing?(previous.get(selected)??missingLabel??'selected folder'):null;
    const choices=[['','Unfiled',false],...Array.from(options,([id,label])=>[id,label,false])];
    if(missing)choices.push([selected,'Unavailable: '+missingLabel,true]);
    const next=JSON.stringify(choices);
    if(next!==rendered){
     input.replaceChildren(...choices.map(([id,label,unavailable])=>{const option=el('option',label);option.value=id;option.disabled=unavailable;return option;}));
     input.value=selected;rendered=next;
    }
    previous=options;
    save.disabled=blocked()||missing;status.hidden=!missing;input.setAttribute('aria-invalid',String(missing));
    return !missing;
   };
   input.addEventListener('change',syncMoveDestination);
  }
  form.addEventListener('submit',async e=>{e.preventDefault();if(editor!==form||syncMoveDestination?.()===false)return;const action=tabId?'tab_collect':'collection_create';const args=tabId?{tabId,collectionId:input.value||null}:{name:input.value,parentCollectionId:parentId};if(await request(action,args)){if(!tabId)collapsed.delete(parentId);dismiss();}});
  form.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!pending)dismiss();}});
  paint();form.scrollIntoView?.({block:'nearest'});input.focus();
 }
 function paint(){
  if(!host||destroyed)return;
  const focus=host.ownerDocument.activeElement,focusKey=focus?.dataset?.folderControl,focusTab=focus?.dataset?.tabId;
  const active=getSelected(),activeFolder=getTabs().find(t=>t.tabId===active)?.collectionId;
  const ancestry=[],visited=new Set();let ancestor=activeFolder;while(ancestor&&!visited.has(ancestor)){visited.add(ancestor);ancestry.push(ancestor);ancestor=collections.find(f=>f.id===ancestor)?.parentId;}
  const selectionKey=JSON.stringify([active,ancestry]);
  if(selectionKey!==selectedBefore){selectedBefore=selectionKey;let id=activeFolder;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);collapsed.delete(id);id=collections.find(f=>f.id===id)?.parentId;}}
  const visible=new Map(getTabs().map(t=>[t.tabId,t]));
  const byId=new Map(rows.map(row=>[row.querySelector('[data-tab-id]')?.dataset.tabId,row]).filter(([id])=>visible.has(id)));
  const transientRows=rows.filter(row=>!visible.has(row.querySelector('[data-tab-id]')?.dataset.tabId));
  const tree=browserCollectionTree(collections,getTabs());
  host.replaceChildren();host.classList.add('next-browser-folder-tree');host.setAttribute('role','region');host.setAttribute('aria-label','Browser folders and tabs');host.dataset.folderBusy=String(blocked());
  const toolbar=el('div',null,'next-browser-folder-toolbar');toolbar.append(el('strong','Tabs'),button('+ Folder',()=>edit(), 'next-browser-folder-add'));if(editor?.hidden)toolbar.append(button('Resume folder edit',()=>{editor.hidden=false;paint();editor.querySelector('input,select')?.focus();},'next-browser-folder-resume'));browserIconButton(toolbar.querySelector('.next-browser-folder-add'),'folder','New folder');host.append(toolbar);toolbar.title='Drop here to move to top level';dropTarget(toolbar,null);
  const tabRow=tab=>{const row=byId.get(tab.tabId);if(!row)return null;
   row.draggable=!blocked();row.ondragstart=e=>{if(blocked()){e.preventDefault();return;}e.dataTransfer.setData('application/x-blackice-tab',tab.tabId);e.dataTransfer.effectAllowed='move';};
   row.onkeydown=e=>void outlineKey(e,null,tab.tabId);row.oncontextmenu=e=>{e.preventDefault();edit(tab.tabId);};
   row.querySelector('.next-browser-tab-move')?.remove();const move=button('Move',()=>edit(tab.tabId),'next-browser-tab-move');browserIconButton(move,'move','Move '+(tab.title||tab.url||'tab')+' to folder');row.append(move);return row;};
  const count=f=>f.tabs.length+f.children.reduce((n,c)=>n+count(c),0);
  function branch(f){
   const group=el('section',null,'next-browser-folder-group');group.dataset.collectionId=f.id;
   const heading=el('div',null,'next-browser-folder-heading'),content=el('div',null,'next-browser-folder-children');content.hidden=collapsed.has(f.id);
   const toggle=button(null,()=>{collapsed.has(f.id)?collapsed.delete(f.id):collapsed.add(f.id);paint();},'next-browser-folder-toggle');toggle.dataset.folderControl='toggle:'+f.id;toggle.setAttribute('aria-expanded',String(!content.hidden));browserIconButton(toggle,content.hidden?'caretRight':'caretDown',(content.hidden?'Expand ':'Collapse ')+f.name);
   const label=f.id?button(f.name,()=>rename(f),'next-browser-folder-name next-browser-folder-menu'):el('span',f.name,'next-browser-folder-name');
   if(f.id){label.setAttribute('aria-label','Rename '+folderPath(collections,f.id));label.title='Rename folder';label.dataset.folderControl='edit:'+f.id;}
   const total=el('span',String(count(f)),'next-browser-folder-count');total.setAttribute('aria-label',count(f)+' tabs');
   const icon=el('span',null,'next-browser-folder-icon');icon.setAttribute('aria-hidden','true');icon.innerHTML=browserIconMarkup('folderOutline');
   heading.append(toggle,icon,renaming===f.id?renameField(f):label,total);
   if(f.id){const child=button(null,()=>edit(null,f.id),'next-browser-folder-child');child.dataset.folderControl='create:'+f.id;browserIconButton(child,'folder','New subfolder in '+folderPath(collections,f.id));heading.append(child);
    const remove=button(null,()=>void request('collection_remove',{collectionId:f.id}),'next-browser-folder-remove');remove.dataset.folderControl='remove:'+f.id;browserIconButton(remove,'close','Remove folder '+folderPath(collections,f.id),'Remove folder, keep tabs');heading.append(remove);}
   group.append(heading,content);heading.title='Drag to move. Ctrl+Enter: indent. Ctrl+Shift+Enter: outdent.';
   if(f.id){heading.draggable=!blocked();heading.addEventListener('dragstart',e=>{if(e.target.closest('input,select,textarea')){e.preventDefault();e.stopPropagation();return;}if(blocked()){e.preventDefault();return;}e.stopPropagation();e.dataTransfer.setData('application/x-blackice-folder',f.id);e.dataTransfer.effectAllowed='move';});heading.addEventListener('keydown',e=>void outlineKey(e,f.id,null));}
   dropTarget(heading,f.id);dropTarget(group,f.id);
   for(const child of f.children)content.append(branch(child));for(const tab of f.tabs){const row=tabRow(tab);if(row)content.append(row);}
   return group;
  }
  for(const f of tree.roots)host.append(branch(f));
  host.append(branch({id:'',name:'Unfiled',tabs:tree.loose,children:[]}));
  host.append(...transientRows,...extras);
  if(editor){if(editorDialog){if(!editorDialog.isConnected)host.parentElement.append(editorDialog);if(editor.hidden){editorDialog.close?.();onModalChange(false);}else if(!editorDialog.open){onModalChange(true);editorDialog.showModal?.();}}else host.insertBefore(editor,toolbar.nextSibling||host.children[1]||null);for(const n of editor.querySelectorAll('button,input,select'))n.disabled=blocked();syncMoveDestination?.();}
  if(renaming&&renameDrafts.get(renaming)===focus)focus.focus({preventScroll:true});
  else if(editor&&!editor.hidden&&editor.contains(focus))focus.focus({preventScroll:true});
  else if(focusKey)[...host.querySelectorAll('[data-folder-control]')].find(n=>n.dataset.folderControl===focusKey)?.focus({preventScroll:true});
  else if(focusTab)[...host.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===focusTab)?.focus({preventScroll:true});
 }
 return {
  captureFocus(strip){const id=strip.ownerDocument?.activeElement?.dataset?.tabId;return()=>{if(id)[...strip.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===id)?.focus?.({preventScroll:true});};},
  groupTabs(strip){host=strip;rows=[...strip.querySelectorAll('.next-browser-tab-group')];extras=[...strip.children].filter(n=>n.classList.contains('next-native-more-tabs')||n.classList.contains('next-browser-tabs-empty'));paint();},
  leave(){renaming=null;if(editor)editor.hidden=true;paint();},
  update(data){collections=Array.isArray(data.collections)?data.collections:[];},render:paint,
  destroy(){destroyed=true;onModalChange(false);renameDrafts.clear();editorDialog?.close?.();editorDialog?.remove();editorDialog=null;editor?.remove();editor=null;syncMoveDestination=null;rows=[];host=null;}
 };
}
