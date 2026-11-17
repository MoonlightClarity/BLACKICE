import {text} from '../core/dom.mjs';
export const browserFoldersMarkup=()=>'<details class="next-browser-folders"><summary>Manage folders</summary><div id="next-browser-folders-body"></div></details>';
export function browserCollectionTree(collections,tabs){
 const map=new Map((collections||[]).map(f=>[f.id,{...f,children:[],tabs:[]}]));
 const roots=[],loose=[];
 for(const f of map.values()){let id=f.parentId,valid=map.has(id),seen=new Set([f.id]);while(id){if(seen.has(id)){valid=false;break;}seen.add(id);id=map.get(id)?.parentId;} (valid?map.get(f.parentId).children:roots).push(f);}
 for(const tab of tabs||[])(map.get(tab.collectionId)?.tabs||loose).push(tab);
 return {roots,loose};
}
export function createBrowserFolders({mount,api,getTabs,getSelected,isBusy,select,refresh,notice}){
 const host=mount.querySelector('#next-browser-folders-body'),doc=mount.ownerDocument;
 let collections=[],editing=null,pending=false,destroyed=false,key='',collapsed=new Set(),tabCollapsed=new Set();
 const button=(root,label,fn)=>{const b=text(root,label,'button');b.type='button';b.disabled=pending||isBusy();b.addEventListener('click',fn);return b;};
 async function action(action,args){
  if(pending||isBusy()||destroyed)return;
  pending=true;key='';render();
  try{await api('/api/browser/action','POST',{browser:'relay',action,...args});if(!destroyed){editing=null;await refresh();}}
  catch(error){if(!destroyed)notice(error.message,true);}
  finally{pending=false;key='';if(!destroyed)render();}
 }
 function render(){
  if(destroyed)return;
  const tabs=getTabs(),next=JSON.stringify([collections,tabs.map(t=>[t.tabId,t.title,t.url,t.collectionId]),getSelected(),isBusy(),pending,[...collapsed],editing]);
  if(next===key)return;key=next;
  // Keep editor drafts intact across passive status updates.
  const sameEditor=host.querySelector('form')?.dataset.editor===String(editing?.id??'new');
  const draft=sameEditor?host.querySelector('[data-folder-name]')?.value:undefined,parentDraft=sameEditor?host.querySelector('[data-folder-parent]')?.value:undefined;
  host.replaceChildren();
  const toolbar=text(host,'','div','next-row');
  button(toolbar,'New folder',()=>{editing={id:null,parentId:null};key='';render();});
  const moveLabel=text(toolbar,'Folder for selected tab','label','next-label');const move=text(moveLabel,'','select','next-field');move.setAttribute('aria-label','Folder for selected tab');move.disabled=!getSelected()||pending||isBusy();
  const opt=(parent,id,label)=>{const o=text(parent,label,'option');o.value=id||'';return o;};
  opt(move,'','Unfiled');
  const tree=browserCollectionTree(collections,tabs);
  function options(nodes,depth=0){for(const f of nodes){opt(move,f.id,'  '.repeat(depth)+f.name);options(f.children,depth+1);}}options(tree.roots);
  move.value=tabs.find(t=>t.tabId===getSelected())?.collectionId||'';
  move.addEventListener('change',()=>void action('tab_collect',{tabId:getSelected(),collectionId:move.value||null}));
  const list=text(host,'','div','next-browser-folder-tree');list.setAttribute('aria-label','Manage browser folders');
  function tabRows(parent,rows){if(rows.length)text(parent,rows.length+' tabs','span','next-help');}
  function folders(parent,nodes){for(const folder of nodes){
   const group=text(parent,'','section','next-browser-folder-group'),head=text(group,'','div','next-browser-folder-heading');
   const toggle=button(head,(collapsed.has(folder.id)?'\u25b8 ':'\u25be ')+folder.name,()=>{collapsed.has(folder.id)?collapsed.delete(folder.id):collapsed.add(folder.id);key='';render();});
   const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.setAttribute('class','next-browser-folder-icon');const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M3 5h6l2 3h10v11H3z');icon.append(path);toggle.insertBefore(icon,toggle.firstChild);
   toggle.setAttribute('aria-expanded',String(!collapsed.has(folder.id)));toggle.className='next-browser-folder-toggle';
   button(head,'Edit',()=>{editing={...folder};key='';render();}).setAttribute('aria-label','Edit folder '+folder.name);
   if(!collapsed.has(folder.id)){const children=text(group,'','div','next-browser-folder-children');tabRows(children,folder.tabs);folders(children,folder.children);if(!folder.tabs.length&&!folder.children.length)text(children,'Empty folder','span','next-help');}
  }}folders(list,tree.roots);

  if(!collections.length&&!tabs.length)text(list,'Create folders to organize your tabs.','p','next-help');
  if(editing){
   const form=text(host,'','form','next-browser-folder-editor'),name=text(form,'','input','next-field');form.dataset.editor=String(editing.id??'new');name.dataset.folderName='';name.maxLength=200;name.required=true;name.setAttribute('aria-label','Folder name');name.placeholder='Folder name';name.value=draft??editing.name??'';
   const parent=text(form,'','select','next-field');parent.dataset.folderParent='';parent.setAttribute('aria-label','Parent folder');opt(parent,'','Top level');
   const excluded=new Set(editing.id?[editing.id]:[]);for(let changed=true;changed;){changed=false;for(const f of collections)if(excluded.has(f.parentId)&&!excluded.has(f.id)){excluded.add(f.id);changed=true;}}
   for(const f of collections)if(!excluded.has(f.id))opt(parent,f.id,f.name);
   parent.value=parentDraft??editing.parentId??'';
   const save=text(form,'Save','button');save.type='submit';save.disabled=pending||isBusy();
   button(form,'Cancel',()=>{editing=null;key='';render();});
   if(editing.id)button(form,'Remove folder, keep tabs',()=>void action('collection_remove',{collectionId:editing.id}));
   form.addEventListener('submit',async event=>{event.preventDefault();if(pending||isBusy())return;const id=editing.id,n=name.value,p=parent.value||null;
    if(!id)return action('collection_create',{name:n,parentCollectionId:p});
    // One edit request updates both name and placement atomically.
    await action('collection_rename',{collectionId:id,name:n,parentCollectionId:p});
   });
  }
 }

 // Folder membership belongs to the existing browser tab model. Render it once,
 // in browser chrome, rather than maintaining a second list of the same tabs.
 function captureFocus(host){
  const active=doc.activeElement;
  if(!active||!host.contains?.(active))return ()=>{};
  const tabId=active.dataset.tabId,closeId=active.dataset.closeTab;
  const collectionId=active.classList.contains('next-browser-collection-toggle')?active.parentElement.dataset.collectionId:undefined;
  return ()=>{
   const target=tabId!==undefined?[...host.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===tabId):
    closeId!==undefined?[...host.querySelectorAll('[data-close-tab]')].find(n=>n.dataset.closeTab===closeId):
    collectionId!==undefined?[...host.querySelectorAll('.next-browser-collection-toggle')].find(n=>n.parentElement.dataset.collectionId===collectionId):null;
   if(target&&!target.closest?.('[hidden]'))target.focus?.({preventScroll:true});
  };
 }
 function groupTabs(host){
  const restoreFocus=captureFocus(host);
  const tabs=getTabs(),byId=new Map(tabs.map(t=>[t.tabId,t]));
  const nodes=[...host.querySelectorAll('.next-browser-tab-group')];
  const extra=[...host.children].filter(n=>!n.classList.contains('next-browser-tab-group')&&!n.classList.contains('next-browser-tab-collection'));
  const buckets=new Map(),labels=new Map();
  const tree=browserCollectionTree(collections,[]);
  function paths(rows,prefix=''){for(const f of rows){const name=prefix?prefix+' / '+f.name:f.name;labels.set(f.id,name);paths(f.children,name);}}paths(tree.roots);
  for(const node of nodes){const id=node.querySelector('[data-tab-id]')?.dataset.tabId;const folder=byId.get(id)?.collectionId;const key=labels.has(folder)?folder:'';if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(node);}
  host.replaceChildren();
  for(const [id,rows] of buckets){
   const group=text(host,'','section','next-browser-tab-collection');group.dataset.collectionId=id;
   const heading=button(group,'',()=>{tabCollapsed.has(id)?tabCollapsed.delete(id):tabCollapsed.add(id);groupTabs(host);});
   heading.disabled=false; // Local presentation remains usable during browser requests.
   text(heading,(id?labels.get(id):'Unfiled')+' ('+rows.length+')','span','next-browser-collection-label');
   heading.className='next-browser-collection-toggle';heading.setAttribute('aria-expanded',String(!tabCollapsed.has(id)));heading.title=id?labels.get(id):'Tabs not in a folder';
   const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.setAttribute('class','next-browser-folder-icon');const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M3 5h6l2 3h10v11H3z');icon.append(path);heading.insertBefore(icon,heading.firstChild);
   const items=text(group,'','div','next-browser-collection-tabs');items.hidden=tabCollapsed.has(id);items.append(...rows);
  }
  host.append(...extra);restoreFocus();
 }
 return {captureFocus,groupTabs,update(data){collections=Array.isArray(data.collections)?data.collections:[];render();},render,destroy(){destroyed=true;}};
}
