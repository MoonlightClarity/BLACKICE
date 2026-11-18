import {folderPath,descendants} from '../core/folder-tree.mjs';
export function browserCollectionTree(collections,tabs){
 const map=new Map((collections||[]).map(f=>[f.id,{...f,children:[],tabs:[]}]));
 const roots=[],loose=[];for(const f of map.values()){let id=f.parentId,valid=map.has(id),seen=new Set([f.id]);while(id){if(seen.has(id)){valid=false;break;}seen.add(id);id=map.get(id)?.parentId;}(valid?map.get(f.parentId).children:roots).push(f);}
 for(const tab of tabs||[])(map.get(tab.collectionId)?.tabs||loose).push(tab);return {roots,loose};
}
// One app-owned tree moves the existing tab rows. Selection/close handlers and
// host collection/ownership persistence remain authoritative, without an extension.
export function createBrowserFolders({api,getTabs,getSelected,isBusy,refresh,notice}){
 let collections=[],host=null,pending=false,destroyed=false,editor=null,rows=[],extras=[],selectedBefore=null;
 const collapsed=new Set();
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
 function dismiss(){editor?.remove();editor=null;paint();}
 function edit(folder=null,tabId=null){
  if(blocked())return;
  editor?.remove();const form=el('form',null,'next-browser-folder-editor');editor=form;
  form.setAttribute('aria-label',tabId?'Move tab to folder':folder?'Edit tab folder':'New tab folder');
  const heading=el('strong',tabId?'Move tab':folder?'Edit folder':'New folder');form.append(heading);
  const parent=el('select');parent.setAttribute('aria-label',tabId?'Folder':'Parent folder');
  const none=el('option',tabId?'Unfiled':'Top level');none.value='';parent.append(none);
  const excluded=folder?descendants(collections,folder.id):new Set();
  for(const f of collections)if(!excluded.has(f.id)){const o=el('option',folderPath(collections,f.id));o.value=f.id;parent.append(o);}
  let name;if(!tabId){name=el('input');name.value=folder?.name||'';name.placeholder='Folder name';name.maxLength=200;name.required=true;name.setAttribute('aria-label','Folder name');form.append(name);}
  parent.value=tabId?getTabs().find(t=>t.tabId===tabId)?.collectionId||'':folder?.parentId||'';form.append(parent);
  const save=button(tabId?'Move':'Save',()=>{});save.type='submit';form.append(save,button('Cancel',dismiss));
  if(folder)form.append(button('Remove folder, keep tabs',async()=>{if(await request('collection_remove',{collectionId:folder.id}))dismiss();}));
  form.addEventListener('submit',async e=>{e.preventDefault();const action=tabId?'tab_collect':folder?'collection_rename':'collection_create';const args=tabId?{tabId,collectionId:parent.value||null}:{...(folder?{collectionId:folder.id}:{}),name:name.value,parentCollectionId:parent.value||null};if(await request(action,args))dismiss();});
  form.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!pending)dismiss();}});
  paint();(name||parent).focus();
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
  const toolbar=el('div',null,'next-browser-folder-toolbar');toolbar.append(el('strong','Tabs'),button('+ Folder',()=>edit(), 'next-browser-folder-add'));if(editor?.hidden)toolbar.append(button('Resume folder edit',()=>{editor.hidden=false;paint();editor.querySelector('input,select')?.focus();},'next-browser-folder-resume'));host.append(toolbar);
  const tabRow=tab=>{const row=byId.get(tab.tabId);if(!row)return null;
   row.draggable=!blocked();row.ondragstart=e=>{if(blocked()){e.preventDefault();return;}e.dataTransfer.setData('application/x-blackice-tab',tab.tabId);e.dataTransfer.effectAllowed='move';};
   row.oncontextmenu=e=>{e.preventDefault();edit(null,tab.tabId);};
   row.querySelector('.next-browser-tab-move')?.remove();const move=button('Move',()=>edit(null,tab.tabId),'next-browser-tab-move');move.setAttribute('aria-label','Move '+(tab.title||tab.url||'tab')+' to folder');row.append(move);return row;};
  const count=f=>f.tabs.length+f.children.reduce((n,c)=>n+count(c),0);
  function branch(f){
   const group=el('section',null,'next-browser-folder-group');group.dataset.collectionId=f.id;
   const heading=el('div',null,'next-browser-folder-heading'),content=el('div',null,'next-browser-folder-children');content.hidden=collapsed.has(f.id);
   const toggle=button(content.hidden?'\u25b8':'\u25be',()=>{collapsed.has(f.id)?collapsed.delete(f.id):collapsed.add(f.id);paint();},'next-browser-folder-toggle');toggle.dataset.folderControl='toggle:'+f.id;toggle.setAttribute('aria-expanded',String(!content.hidden));toggle.setAttribute('aria-label',(content.hidden?'Expand ':'Collapse ')+f.name);
   const label=f.id?button(f.name,()=>edit(f),'next-browser-folder-name next-browser-folder-menu'):el('span',f.name,'next-browser-folder-name');
   if(f.id){label.setAttribute('aria-label','Rename '+folderPath(collections,f.id));label.title='Rename folder';label.dataset.folderControl='edit:'+f.id;}
   const total=el('span',String(count(f)),'next-browser-folder-count');total.setAttribute('aria-label',count(f)+' tabs');
   heading.append(toggle,label,total);group.append(heading,content);
   for(const tab of f.tabs){const row=tabRow(tab);if(row)content.append(row);}for(const child of f.children)content.append(branch(child));
   group.addEventListener('dragover',e=>{if(!blocked()&&[...e.dataTransfer.types].includes('application/x-blackice-tab'))e.preventDefault();});
   group.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();void request('tab_collect',{tabId:e.dataTransfer.getData('application/x-blackice-tab'),collectionId:f.id||null});});
   return group;
  }
  for(const f of tree.roots)host.append(branch(f));
  host.append(branch({id:'',name:'Unfiled',tabs:tree.loose,children:[]}));
  host.append(...transientRows,...extras);
  if(editor){host.append(editor);for(const n of editor.querySelectorAll('button,input,select'))n.disabled=blocked();}
  if(editor&&!editor.hidden&&editor.contains(focus))focus.focus({preventScroll:true});
  else if(focusKey)[...host.querySelectorAll('[data-folder-control]')].find(n=>n.dataset.folderControl===focusKey)?.focus({preventScroll:true});
  else if(focusTab)[...host.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===focusTab)?.focus({preventScroll:true});
 }
 return {
  captureFocus(strip){const id=strip.ownerDocument?.activeElement?.dataset?.tabId;return()=>{if(id)[...strip.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===id)?.focus?.({preventScroll:true});};},
  groupTabs(strip){host=strip;rows=[...strip.querySelectorAll('.next-browser-tab-group')];extras=[...strip.children].filter(n=>n.classList.contains('next-native-more-tabs')||n.classList.contains('next-browser-tabs-empty'));paint();},
  leave(){if(editor){editor.hidden=true;paint();}},
  update(data){collections=Array.isArray(data.collections)?data.collections:[];},render:paint,
  destroy(){destroyed=true;editor?.remove();editor=null;rows=[];host=null;}
 };
}
