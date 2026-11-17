(() => {
 'use strict';
 const scopes=new WeakMap();
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 function connect(host){
  if(scopes.has(host))return;const state={collapsed:new Set(),model:null,key:'',editor:null};scopes.set(host,state);
  host.dataset.blackiceTabExtension='ready';
  const request=(action,args={})=>{if(state.model?.busy)return;host.setAttribute('data-blackice-tab-request',JSON.stringify({action,...args}));host.dispatchEvent(new CustomEvent('blackice-tab-action',{bubbles:false}));};
  function editor(folder,tabId){
   if(state.model?.busy)return;
   state.editor?.remove();const form=el('form',null,'blackice-tab-editor');form.setAttribute('aria-label',tabId?'Move tab to folder':folder?'Edit tab folder':'New tab folder');
   const parent=el('select');parent.setAttribute('aria-label',tabId?'Folder':'Parent folder');
   const none=el('option',tabId?'Unfiled':'Top level');none.value='';parent.append(none);
   const excluded=new Set(folder?[folder.id]:[]);for(let changed=true;changed;){changed=false;for(const f of state.model.collections)if(excluded.has(f.parentId)&&!excluded.has(f.id)){excluded.add(f.id);changed=true;}}
   for(const f of state.model.collections)if(!excluded.has(f.id)){const o=el('option',f.name);o.value=f.id;parent.append(o);}
   let name;if(!tabId){name=el('input');name.value=folder?.name||'';name.placeholder='Folder name';name.maxLength=200;name.required=true;name.setAttribute('aria-label','Folder name');form.append(name);}
   parent.value=tabId?state.model.tabs.find(t=>t.tabId===tabId)?.collectionId||'':folder?.parentId||'';form.append(parent);
   const save=el('button',tabId?'Move':'Save');save.type='submit';form.append(save);
   const cancel=el('button','Cancel');cancel.type='button';cancel.onclick=()=>{form.remove();state.editor=null;};form.append(cancel);
   if(folder){const remove=el('button','Remove folder, keep tabs');remove.type='button';remove.onclick=()=>{request('collection_remove',{collectionId:folder.id});form.remove();state.editor=null;};form.append(remove);}
   form.onsubmit=e=>{e.preventDefault();const action=tabId?'tab_collect':folder?'collection_rename':'collection_create',args=tabId?{tabId,collectionId:parent.value||null}:{...(folder?{collectionId:folder.id}:{}),name:name.value,parentCollectionId:parent.value||null};request(action,args);form.remove();state.editor=null;};
   form.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();form.remove();state.editor=null;}};host.append(form);state.editor=form;(name||parent).focus();
  }
  function paint(){
   const raw=host.getAttribute('data-blackice-tab-model');if(!raw||raw===state.key)return;
   let model;try{model=JSON.parse(raw);}catch{return;}
   if(model.version!==1||!Array.isArray(model.tabs)||!Array.isArray(model.collections))return;state.key=raw;state.model=model;
   const active=document.activeElement,focusId=active?.dataset?.tabId;
   const rows=[...host.querySelectorAll('.next-browser-tab-group')],byId=new Map(model.tabs.map(t=>[t.tabId,t])),folders=new Map(model.collections.map(f=>[f.id,f])),buckets=new Map();
   for(const f of model.collections)buckets.set(f.id,[]);buckets.set('',[]);
   for(const row of rows){const id=row.querySelector('[data-tab-id]')?.dataset.tabId,f=byId.get(id)?.collectionId;buckets.get(folders.has(f)?f:'').push(row);row.draggable=true;row.ondragstart=e=>{e.dataTransfer.setData('application/x-blackice-tab',id);e.dataTransfer.effectAllowed='move';};row.oncontextmenu=e=>{e.preventDefault();editor(null,id);};}
   const extras=[...host.children].filter(n=>!n.classList.contains('next-browser-tab-group')&&!n.classList.contains('blackice-tab-folder')&&!n.classList.contains('blackice-tab-add')&&!n.classList.contains('blackice-tab-editor'));
   host.replaceChildren();
   const label=f=>{const names=[f.name],seen=new Set([f.id]);let p=folders.get(f.parentId);while(p&&!seen.has(p.id)){names.unshift(p.name);seen.add(p.id);p=folders.get(p.parentId);}return names.join(' / ');};
   for(const [id,items]of buckets){if(!id&&!items.length)continue;const folder=folders.get(id),group=el('section',null,'blackice-tab-folder');group.dataset.collectionId=id;
    const toggle=el('button',(folder?label(folder):'Unfiled')+' ('+items.length+')','blackice-tab-folder-toggle');toggle.type='button';toggle.setAttribute('aria-expanded',String(!state.collapsed.has(id)));toggle.title=folder?'Click to collapse; double-click or right-click to edit':'Unfiled tabs';
    const content=el('div',null,'blackice-tab-folder-tabs');content.hidden=state.collapsed.has(id);content.append(...items);
    toggle.onclick=()=>{state.collapsed.has(id)?state.collapsed.delete(id):state.collapsed.add(id);content.hidden=state.collapsed.has(id);toggle.setAttribute('aria-expanded',String(!content.hidden));};
    if(folder){toggle.ondblclick=()=>editor(folder);toggle.oncontextmenu=e=>{e.preventDefault();editor(folder);};}
    group.ondragover=e=>{if([...e.dataTransfer.types].includes('application/x-blackice-tab'))e.preventDefault();};
    group.ondrop=e=>{const tabId=e.dataTransfer.getData('application/x-blackice-tab');if(model.tabs.some(t=>t.tabId===tabId)){e.preventDefault();request('tab_collect',{tabId,collectionId:id||null});}};
    group.append(toggle);if(folder){const menu=el('button','…','blackice-tab-folder-menu');menu.type='button';menu.title='Edit folder';menu.setAttribute('aria-label','Edit '+label(folder));menu.disabled=model.busy;menu.onclick=()=>editor(folder);group.append(menu);}group.append(content);host.append(group);
   }
   const add=el('button','+ Folder','blackice-tab-add');add.type='button';add.disabled=model.busy;add.onclick=()=>editor(null);host.append(add,...extras);
   if(state.editor){host.append(state.editor);for(const c of state.editor.querySelectorAll('button,input,select'))c.disabled=model.busy;}
   if(focusId)[...host.querySelectorAll('[data-tab-id]')].find(n=>n.dataset.tabId===focusId)?.focus({preventScroll:true});
  }
  new MutationObserver(paint).observe(host,{attributes:true,attributeFilter:['data-blackice-tab-model']});paint();
 }
 new MutationObserver(()=>document.querySelectorAll('[data-blackice-tab-model]').forEach(connect)).observe(document,{childList:true,subtree:true});
 document.querySelectorAll('[data-blackice-tab-model]').forEach(connect);
})();