import {folderRows,descendants} from '../core/folder-tree.mjs';
const functionalGroups=new Map([
 ['data','Data & spreadsheets'],['documents','Documents'],['methods','General methods'],
 ['research','Research & web'],['web','Research & web'],['coding','Software & QA'],['accessibility','Software & QA'],
 ['diagram','Visual communication'],['charts','Visual communication'],['writing','Writing & handoffs'],
]);
const generalMethods=new Set(['builtin-decomposition','builtin-task-grounding','builtin-structured-analysis']);
const skillOrder=new Intl.Collator('en',{sensitivity:'base',numeric:true});
const compareSkills=(a,b)=>skillOrder.compare(a.title,b.title)||skillOrder.compare(a.id,b.id);
const otherGroup='Other skills';
const methodsGroup=functionalGroups.get('methods');
const groupOf=item=>(generalMethods.has(item.id)?methodsGroup:functionalGroups.get(item.tags?.[0]))||otherGroup;
const groupPriority=name=>name===methodsGroup?0:name===otherGroup?2:1;
const compareGroups=(a,b)=>groupPriority(a)-groupPriority(b)||skillOrder.compare(a,b);
/** The document is authoritative. Folders only organize the view. */
export function createSkillsWorkspace({mount,api}) {
 mount.innerHTML='<div class="next-panel next-skills-root"><div class="next-panel-inner"><header class="next-panel-head"><div><h1>Skills</h1></div><div class="next-skills-actions"><button id="skills-new" type="button">New skill</button><button id="skills-refresh" type="button">Refresh</button></div></header><label class="next-label">Find a skill<input id="skills-query" class="next-field" type="search" maxlength="256"></label><p id="skills-status" role="status" aria-live="polite"></p><div class="next-skills-layout"><aside class="next-skills-aside" aria-label="Skills and folders"><form id="skills-folder-form" class="skills-inline-create" hidden><label class="next-label">New folder<input id="skills-folder-name" class="next-field" maxlength="60" required></label><button id="skills-create-save" type="submit">Create folder</button><button id="skills-create-cancel" type="button">Cancel</button></form><div id="skills-root" class="skills-tree-root" title="Drop here to move to the top level"><span>Skills</span><button id="skills-new-folder" type="button">New folder</button><button id="skills-manage-folders-button" type="button">Manage folders</button></div><details id="skills-folder-manager"><summary>Manage folders and categories</summary><p class="next-help">Delete user folders or category folders without deleting skills. Folder contents move to their parent or to Other skills.</p><ul id="skills-folder-manager-list" class="next-skills-list"></ul></details><ul id="skills-list" class="next-skills-list"></ul><details id="skills-removed-categories"><summary>Deleted category folders</summary><ul id="skills-removed-category-list" class="next-skills-list"></ul></details><details id="skills-trash"><summary>Deleted skills</summary><p class="next-help">Deleted skills are excluded from future skill lookups. Restore brings back your last saved edit, or the current bundled default. Discarded unsaved changes are not restored. Deleted skills keep their folder placement; restore and move them before deleting that folder.</p><ul id="skills-trash-list" class="next-skills-list"></ul></details></aside><section class="next-card next-skills-inspector" aria-label="Skill document"><h2 id="skills-heading">Select a skill</h2><p id="skills-detail-status" role="status" aria-live="polite"></p><form id="skills-editor" hidden><div class="next-skills-actions"><button id="skills-save" type="submit">Save</button><button id="skills-discard" type="button">Discard changes</button></div><p id="skills-save-status" role="status" aria-live="polite"></p><label class="next-label">Skill document<textarea id="skills-edit-content" maxlength="200000" class="next-field" rows="24" required spellcheck="false"></textarea></label></form><section id="skills-delete-confirm" class="skills-delete-confirm" hidden role="alert"><p id="skills-delete-message"></p><button id="skills-delete-yes" type="button">Delete skill</button><button id="skills-delete-cancel" type="button">Cancel</button></section></section></div></div></div>';
 const retained=new Map();const el=id=>mount.querySelector('#skills-'+id)||retained.get(id),add=(parent,tag,text)=>{const node=mount.ownerDocument.createElement(tag);if(text!==undefined)node.textContent=String(text);parent.append(node);return node;};
 for(const id of ['folder-form','folder-name','create-save','create-cancel'])retained.set(id,el(id));
 const paths={folder:'M3 7V5h6l2 2h10v13H3z',plus:'M3 7V5h6l2 2h10v13H3z M12 10v7 M8.5 13.5h7',chevron:'m9 5 7 7-7 7',check:'m5 12 4 4 10-11',close:'m6 6 12 12 M18 6 6 18',trash:'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v7 M14 10v7',refresh:'M20 7v5h-5 M19 12a7 7 0 1 0-2 5',move:'M3 8V6h6l2 2h10v11H3z M9 13h8 m-3-3 3 3-3 3',back:'m15 5-7 7 7 7',save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8'};
 const svg=kind=>'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="'+paths[kind]+'"></path></svg>';
 function icon(node,kind,label){node.innerHTML=svg(kind);node.classList.add('skills-icon-action');node.setAttribute('aria-label',label);node.title=label;}
 for(const[id,kind,label]of[['new-folder','plus','New folder'],['create-save','check','Create folder'],['create-cancel','close','Cancel new folder'],['refresh','refresh','Refresh skills'],['save','save','Save skill'],['discard','refresh','Discard changes'],['delete-yes','trash','Delete skill'],['delete-cancel','close','Cancel deletion']])icon(el(id),kind,label);
 mount.querySelector('.next-skills-aside').append(el('delete-confirm'));
  // The destination picker is independent of the paginated or collapsed outline.
  const moveDialog=add(mount.querySelector('.next-skills-root'),'dialog');moveDialog.id='skills-move-dialog';moveDialog.className='skills-move-dialog';moveDialog.setAttribute('aria-labelledby','skills-move-heading');
  const moveHeading=add(moveDialog,'h2','Move');moveHeading.id='skills-move-heading';
  const moveDescription=add(moveDialog,'p','Choose a destination. Moving a skill does not modify its document.');moveDescription.className='next-help';
  const moveLabel=add(moveDialog,'label','Find destination');moveLabel.className='next-label';
  const moveSearch=add(moveLabel,'input');moveSearch.type='search';moveSearch.id='skills-move-query';moveSearch.className='next-field';moveSearch.maxLength=256;
  const moveOptions=add(moveDialog,'div');moveOptions.id='skills-move-options';moveOptions.className='skills-move-options';moveOptions.setAttribute('role','group');moveOptions.setAttribute('aria-label','Move destinations');
  const moveNote=add(moveDialog,'p');moveNote.id='skills-move-status';moveNote.setAttribute('role','status');moveNote.setAttribute('aria-live','polite');
  const moveCancel=add(moveDialog,'button','Cancel');moveCancel.id='skills-move-cancel';moveCancel.type='button';
  const deleteFolderPanel=add(mount.querySelector('.next-skills-aside'),'section');
  deleteFolderPanel.id='skills-folder-delete-confirm';deleteFolderPanel.hidden=true;deleteFolderPanel.setAttribute('role','alertdialog');
  const deleteFolderHeading=add(deleteFolderPanel,'h3','Delete folder?');
  const deleteFolderInfo=add(deleteFolderPanel,'p');
  const deleteFolderYes=add(deleteFolderPanel,'button','Delete folder');deleteFolderYes.type='button';deleteFolderYes.id='skills-folder-delete-yes';
  const deleteFolderCancel=add(deleteFolderPanel,'button','Cancel');deleteFolderCancel.type='button';deleteFolderCancel.id='skills-folder-delete-cancel';
  const inspectorMove=add(el('editor').querySelector('.next-skills-actions'),'button');inspectorMove.id='skills-move-selected';inspectorMove.type='button';inspectorMove.hidden=true;icon(inspectorMove,'move','Move selected skill');
 const hostWindow=window,open=new Set(),closedCategories=new Set(),searchDisclosure=new Map(),drafts=new Map(),pages=new Map();
 let active=false,destroyed=false,listEpoch=0,detailEpoch=0,controller,detailController,timer,selected=null,items=[],organization=null,busy=false,saving=false,uncertain=false,creation=null,entry=null,rename=null,dragging=null,deleteTarget=null,trashItems=[],newDraft=null,moveTarget=null,folderDeleteTarget=null;
 const pageSize=10;
 const displayGroup=item=>organization?.removedCategories?.includes('category:'+groupOf(item))?otherGroup:groupOf(item);
 const blocked=()=>busy||saving||!!deleteTarget||!!folderDeleteTarget||uncertain||!organization;
 const disclosureBlocked=()=>busy||saving||!!deleteTarget||!organization;
 function openFolder(id){open.add(id);if(el('query').value.trim())searchDisclosure.set(id,true);}
 function controls(){
  for(const node of mount.querySelectorAll('button,input,textarea'))node.disabled=busy||saving||!!deleteTarget||!!folderDeleteTarget;
  deleteFolderYes.disabled=deleteFolderCancel.disabled=busy||saving;
  for(const node of el('folder-form').querySelectorAll('button,input'))node.disabled=blocked();
  for(const node of el('list').querySelectorAll('button,input'))node.disabled=blocked();
  // A failed write calls for refreshing before editing again, not before
  // browsing the last successfully loaded folder tree.
  for(const node of el('list').querySelectorAll('[data-folder-toggle],[data-category-toggle]'))node.disabled=disclosureBlocked();
  el('create-cancel').disabled=busy||saving||!!deleteTarget;
  el('create-save').disabled=blocked()||!!(creation?.parentId&&!organization?.folders.some(row=>row.id===creation.parentId));
  for(const node of el('list').querySelectorAll('.skills-folder-remove'))node.disabled=blocked()||!!creation;
  el('query').disabled=busy||saving||!!deleteTarget||!!creation||!!rename;
  el('new-folder').disabled=blocked()||!!rename||!!creation;for(const node of el('list').querySelectorAll('[data-new-subfolder]'))node.disabled=blocked()||!!rename||!!creation;
  el('new').disabled=blocked()||!!rename||!!creation||!!newDraft;
  el('save').disabled=busy||saving||!!deleteTarget||(newDraft?!newDraft.content.trim():!entry?.userEditable||!drafts.has(selected));
  el('discard').disabled=busy||saving||!!deleteTarget||(!newDraft&&!drafts.has(selected));
  for(const node of mount.querySelectorAll('[data-boundary]'))node.disabled=blocked()||node.dataset.boundary==='true';
  el('edit-content').readOnly=!newDraft&&!entry?.userEditable;el('delete-yes').disabled=el('delete-cancel').disabled=busy||saving;
   for(const node of el('list').querySelectorAll('[data-move-skill],[data-move-folder]'))node.disabled=blocked()||!!rename||!!creation||!!newDraft;
   inspectorMove.disabled=blocked()||!!rename||!!creation||!!newDraft||!entry;
   moveSearch.disabled=blocked();moveCancel.disabled=busy||saving||!!deleteTarget;
   for(const node of moveOptions.querySelectorAll('[data-move-destination]'))node.disabled=blocked()||node.dataset.currentDestination==='true';
 }
 function clear(){entry=null;inspectorMove.hidden=true;deleteTarget=null;el('delete-confirm').hidden=true;el('editor').hidden=true;el('heading').textContent='Select a skill';el('detail-status').textContent='Select a skill to read or edit its document.';}
 function focusFolder(id){[...el('list').querySelectorAll('[data-folder-name]')].find(n=>n.dataset.folderName===id)?.focus?.();}
 function moveFolder(id,parentId,revision=organization?.revision){
  if(blocked())return;
  const row=organization.folders.find(x=>x.id===id);if(!row||row.parentId===parentId)return;
  if(parentId!==null&&descendants(organization.folders,id).has(parentId)){el('status').textContent='A folder cannot be moved into itself or its children.';return;}
  void mutate({action:'update',id,parentId},{expectedRevision:revision,onSaved:()=>{if(parentId)openFolder(parentId);},afterPaint:()=>focusFolder(id),successMessage:'Folder moved.'});
 }
 function closeMove(restoreFocus=true){
   const target=moveTarget;moveTarget=null;
   if(moveDialog.open)moveDialog.close();
   if(!restoreFocus||!target||!active||destroyed)return;
   const key=target.kind==='skill'?'moveSkill':'moveFolder';
   const found=[...el('list').querySelectorAll('[data-move-skill],[data-move-folder]')].find(node=>node.dataset[key]===target.id);
   (found||(target.kind==='skill'&&entry?.id===target.id?inspectorMove:null))?.focus?.();
  }
  function renderMoveOptions(){
   if(!moveTarget||!organization)return;
   moveOptions.replaceChildren();
   const query=moveSearch.value.trim().toLocaleLowerCase();
   const current=moveTarget.kind==='folder'
    ? organization.folders.find(row=>row.id===moveTarget.id)?.parentId??null
    : organization.assignments?.[moveTarget.id]??null;
   const excluded=moveTarget.kind==='folder'?descendants(organization.folders,moveTarget.id):new Set();
   const choices=[
    ['Top level',[{id:null,label:moveTarget.kind==='skill'?'Automatic grouping (top level)':'Top-level folders'}]],
    ['Folders',folderRows(organization.folders).filter(row=>!excluded.has(row.id)).sort((a,b)=>skillOrder.compare(a.path,b.path)||skillOrder.compare(a.id,b.id)).map(row=>({id:row.id,label:row.path}))],
   ];
   if(moveTarget.kind==='skill'){
    const categories=[...new Set([...functionalGroups.values(),otherGroup,...items.map(groupOf)])].sort((a,b)=>skillOrder.compare(a,b));
    choices.push(['Categories',categories.map(name=>({id:'category:'+name,label:name}))]);
   }
   let shown=0;
   for(const [heading,entries] of choices){
    const matches=entries.filter(row=>row.label.toLocaleLowerCase().includes(query));
    if(!matches.length)continue;
    const title=add(moveOptions,'h3',heading);title.className='skills-move-group-heading';
    for(const row of matches){
     const button=add(moveOptions,'button',row.label+(current===row.id?' (current)':''));button.type='button';
     button.className='skills-move-choice';button.dataset.moveDestination=row.id??'';
     button.dataset.currentDestination=String(current===row.id);
     if(current===row.id){button.disabled=true;button.setAttribute('aria-current','location');}
     button.addEventListener('click',()=>commitMove(row.id));
     shown++;
    }
   }
   moveNote.textContent=shown?shown+' matching destinations.':'No matching destinations.';
  }
  function openMove(kind,id,title){
   if(!active||blocked()||rename||creation||newDraft)return;
   const exists=kind==='skill'?items.some(item=>item.id===id):organization.folders.some(row=>row.id===id);
   if(!exists)return;
   moveTarget={kind,id,title,revision:organization.revision};
   moveHeading.textContent='Move '+(kind==='skill'?'skill':'folder')+': '+title;
   moveSearch.value='';renderMoveOptions();
   if(!moveDialog.open)moveDialog.showModal();
   moveSearch.focus();
  }
  function commitMove(destination){
   const target=moveTarget;
   if(!target||blocked()||rename||creation||newDraft)return;
   if(target.kind==='folder'){
    const row=organization.folders.find(item=>item.id===target.id);
    if(!row||row.parentId===destination||destination!==null&&descendants(organization.folders,target.id).has(destination))return;
    closeMove(false);moveFolder(target.id,destination,target.revision);
    return;
   }
   if((organization.assignments[target.id]??null)===destination)return;
   closeMove(false);
   void mutate({action:'assign',skillId:target.id,folderId:destination},{
    expectedRevision:target.revision,
    onSaved:()=>{
     if(destination?.startsWith('category:'))closedCategories.delete(destination.slice(9));
     else if(destination){let folderId=destination;while(folderId){openFolder(folderId);folderId=organization.folders.find(row=>row.id===folderId)?.parentId??null;}}
    },
    afterPaint:()=>{if(entry?.id===target.id)inspectorMove.focus?.();},
    successMessage:'Skill moved.'
   });
  }
  moveSearch.addEventListener('input',renderMoveOptions);
  moveCancel.addEventListener('click',()=>closeMove());
  moveDialog.addEventListener('cancel',event=>{event.preventDefault();closeMove();});
  inspectorMove.addEventListener('click',()=>{if(entry)openMove('skill',entry.id,entry.title);});
  function indent(id,outdent){
  if(blocked()||rename||creation)return;
  const rows=organization.folders,row=rows.find(x=>x.id===id);if(!row)return;
  if(outdent){const parent=rows.find(x=>x.id===row.parentId);if(parent)moveFolder(id,parent.parentId);return;}
  const siblings=rows.filter(x=>x.parentId===row.parentId),index=siblings.findIndex(x=>x.id===id);
  if(index>0)moveFolder(id,siblings[index-1].id);else el('status').textContent='No preceding folder to indent under.';
 }
 function drag(node,kind,id){
  node.draggable=true;
  node.addEventListener('dragstart',event=>{if(blocked()||rename||creation){event.preventDefault();return;}dragging={kind,id,revision:organization.revision};event.dataTransfer?.setData('application/x-blackice-skills',id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
  node.addEventListener('dragend',()=>{dragging=null;});
 }
 function drop(node,target,category=false){
  node.addEventListener('dragover',event=>{if(dragging&&(!category||dragging.kind==='skill')&&!blocked()){node.classList.add('skills-drop-target');event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}});
  node.addEventListener('dragleave',()=>node.classList.remove('skills-drop-target'));
  node.addEventListener('drop',event=>{node.classList.remove('skills-drop-target');event.preventDefault();event.stopPropagation();const from=dragging;dragging=null;if(!from||blocked()||(category&&from.kind!=='skill'))return;
   if(from.kind==='folder')moveFolder(from.id,target,from.revision);
   else void mutate({action:'assign',skillId:from.id,folderId:target},{expectedRevision:from.revision,onSaved:()=>{if(category)closedCategories.delete(target.slice(9));else if(target)openFolder(target);}});
  });
 }
 function startRename(id){
  if(blocked()||creation)return;const row=organization.folders.find(x=>x.id===id);if(!row)return;
  if(rename&&rename.id!==id){el('status').textContent='Save or cancel the current folder name first.';return;}
  rename??={id,value:row.name,revision:organization.revision};paint();
  const input=el('list').querySelector('[data-folder-rename]');input?.focus?.();input?.select?.();
 }
 function saveRename(){
  if(!rename||blocked())return;const current=rename;
  void mutate({action:'update',id:current.id,name:current.value},{expectedRevision:current.revision,onSaved:()=>{rename=null;},afterPaint:()=>focusFolder(current.id)});
 }
 function focusPage(key,direction){
  const buttons=[...mount.querySelectorAll('[data-page-key]')].filter(node=>node.dataset.pageKey===(key??'root')&&!node.disabled);
  (buttons.find(node=>node.dataset.pageDirection===direction)??buttons[0])?.focus?.();
 }
 function pageRows(rows,key,parent,name){
  const count=Math.max(1,Math.ceil(rows.length/pageSize)),page=Math.min(pages.get(key)||0,count-1);pages.set(key,page);
  if(count>1){
   const li=add(parent,'li'),nav=add(li,'nav');li.className='skills-pagination-row';nav.className='skills-pagination';nav.setAttribute('aria-label',key==='trash'?'Deleted skills pages':key===null?'Skills pages':'Pages in '+(name??organization?.folders.find(row=>row.id===key)?.name));
   const pageButton=(direction,delta,iconKind,label)=>{
    const target=page+delta,button=add(nav,'button');
    button.type='button';icon(button,iconKind,label);button.dataset.pageKey=key??'root';button.dataset.pageDirection=direction;button.dataset.boundary=String(target<0||target>=count);
    button.addEventListener('click',()=>{if(blocked()||target<0||target>=count)return;pages.set(key,target);paint();focusPage(key,direction);});
   };
   pageButton('previous',-1,'back','Previous page');
   const position=add(nav,'span',(page+1)+' / '+count);position.setAttribute('aria-label','Page '+(page+1)+' of '+count);
   pageButton('next',1,'chevron','Next page');
  }
  return rows.slice(page*pageSize,(page+1)*pageSize);
 }
 function renderDocument(item,parent){
  const li=add(parent,'li');li.className='skills-document-line';
  const button=add(li,'button',item.title);button.type='button';button.className='skills-document-row';button.dataset.skillId=item.id;button.setAttribute('aria-pressed',String(selected===item.id));button.addEventListener('click',()=>void select(item.id));drag(button,'skill',item.id);
  const move=add(li,'button');move.type='button';move.className='skills-document-move';move.dataset.moveSkill=item.id;icon(move,'move','Move skill '+item.title);move.addEventListener('click',()=>openMove('skill',item.id,item.title));
   const remove=add(li,'button','Delete');remove.type='button';remove.className='skills-document-delete';remove.dataset.deleteSkill=item.id;icon(remove,'trash','Delete '+item.title);remove.addEventListener('click',()=>requestDelete(item));
 }
 function renderDisclosure(line,id,name,expanded,toggle){
  function activate(){if(disclosureBlocked())return;toggle();paint();[...el('list').querySelectorAll('[data-folder-toggle]')].find(node=>node.dataset.folderToggle===id)?.focus?.();}
  const arrow=add(line,'button');arrow.type='button';arrow.dataset.folderToggle=id;arrow.className='skills-folder-arrow';arrow.setAttribute('aria-expanded',String(expanded));icon(arrow,'chevron',(expanded?'Collapse ':'Expand ')+name);arrow.classList.toggle('is-open',expanded);arrow.addEventListener('click',activate);return activate;
 }
 function renderFolderIcon(line){const folderIcon=add(line,'span');folderIcon.className='skills-folder-icon';folderIcon.setAttribute('aria-hidden','true');folderIcon.innerHTML=svg('folder');}
 function renderCategory(name,documents,parent){
  const id='category:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),expanded=!closedCategories.has(name);
  const branch=add(parent,'li');branch.className='skills-folder-branch skills-category-branch';
  const row=add(branch,'div');row.className='skills-folder-row';row.dataset.skillCategory=name;drop(row,'category:'+name,true);
  const activate=renderDisclosure(row,id,name,expanded,()=>{expanded?closedCategories.add(name):closedCategories.delete(name);});
  renderFolderIcon(row);
  const label=add(row,'button',name);label.type='button';label.className='skills-folder-name';label.dataset.categoryToggle=id;label.setAttribute('aria-expanded',String(expanded));label.addEventListener('click',activate);
   if(name!==otherGroup){const remove=add(row,'button','Delete');remove.type='button';remove.className='skills-folder-remove';remove.dataset.deleteCategory=name;remove.setAttribute('aria-label','Delete category folder '+name);remove.addEventListener('click',()=>requestFolderDelete('category:'+name));}
  const children=add(branch,'ul');children.className='next-skills-list';children.hidden=!expanded;if(expanded)for(const item of pageRows(documents,id,children,name))renderDocument(item,children);
 }
 function paint(){
  el('folder-form').remove();el('folder-form').hidden=!creation;
  const list=el('list');list.replaceChildren();const allRows=folderRows(organization?.folders||[]),matchingFolders=new Set(),searching=!!el('query').value.trim();
  if(searching)for(const item of items){let id=organization?.assignments[item.id];while(id&&!matchingFolders.has(id)){matchingFolders.add(id);id=allRows.find(row=>row.id===id)?.parentId;}}
  if(creation?.parentId){let id=creation.parentId;while(id&&!matchingFolders.has(id)){matchingFolders.add(id);id=allRows.find(row=>row.id===id)?.parentId;}}
  const rows=searching?allRows.filter(row=>matchingFolders.has(row.id)):allRows;
  function renderChildren(parentId,parent){
   if(creation?.parentId===parentId){const line=add(parent,'li');line.className='skills-folder-create-line';line.append(el('folder-form'));}
   const placement=item=>organization?.assignments[item.id]??null;
   const documents=items.filter(item=>(placement(item)?.startsWith('category:')?null:placement(item))===parentId);
   const grouped=parentId===null&&!searching;
   if(!searching)documents.sort(compareSkills);
   const groups=new Map();
   if(grouped)for(const item of items)groups.set(displayGroup(item),[]);
   if(grouped)for(const item of documents){const name=placement(item)?.startsWith('category:')&&!organization?.removedCategories?.includes(placement(item))?placement(item).slice(9):displayGroup(item);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(item);}
   const children=[...rows.filter(row=>row.parentId===parentId).map(row=>({row})),...(grouped?[...groups.keys()].sort(compareGroups).map(category=>({category})):documents.map(item=>({item})))];
   for(const child of pageRows(children,parentId,parent)){
    if(child.item){renderDocument(child.item,parent);continue;}
    if(child.category){renderCategory(child.category,groups.get(child.category),parent);continue;}
   const row=child.row;
   const li=add(parent,'li');li.className='skills-folder-branch';
   const line=add(li,'div');line.className='skills-folder-row';line.dataset.folderId=row.id;drag(line,'folder',row.id);drop(line,row.id);
   const expanded=searching?(searchDisclosure.get(row.id)??true):open.has(row.id);
   renderDisclosure(line,row.id,row.name,expanded,()=>{
    if(searching)searchDisclosure.set(row.id,!expanded);
    else expanded?open.delete(row.id):open.add(row.id);
   });
   renderFolderIcon(line);
   if(rename?.id===row.id){
    const input=add(line,'input');input.value=rename.value;input.maxLength=60;input.dataset.folderRename=row.id;input.setAttribute('aria-label','Folder name');input.addEventListener('input',()=>{rename.value=input.value;});input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveRename();}if(event.key==='Escape'){event.preventDefault();rename=null;paint();focusFolder(row.id);}});
    const save=add(line,'button','✓');save.type='button';icon(save,'check','Save folder name');save.addEventListener('click',saveRename);
    const cancel=add(line,'button','×');cancel.type='button';icon(cancel,'close','Cancel folder rename');cancel.addEventListener('click',()=>{rename=null;paint();focusFolder(row.id);});
   }else{
    const name=add(line,'button',row.name);name.type='button';name.className='skills-folder-name';name.dataset.folderName=row.id;name.setAttribute('aria-label','Rename folder '+row.name);name.addEventListener('click',()=>startRename(row.id));
    name.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();indent(row.id,event.shiftKey);}});
    const move=add(line,'button');move.type='button';move.dataset.moveFolder=row.id;move.className='skills-folder-move';icon(move,'move','Move folder '+row.name);move.addEventListener('click',()=>openMove('folder',row.id,row.name));
     const child=add(line,'button');child.type='button';child.dataset.newSubfolder=row.id;icon(child,'plus','New subfolder in '+row.name);child.addEventListener('click',()=>startCreate(row.id));
    const remove=add(line,'button','Delete');remove.type='button';remove.className='skills-folder-remove';remove.title='Delete folder (keep all skills)';remove.setAttribute('aria-label','Delete folder '+row.name);remove.addEventListener('click',()=>requestFolderDelete(row.id));
   }
   const children=add(li,'ul');children.className='next-skills-list';children.hidden=!expanded;if(expanded)renderChildren(row.id,children);
   }
  }
  renderChildren(null,list);
  if(creation&&!el('folder-form').parentNode){const line=add(list,'li');line.className='skills-folder-create-line';const missing=creation.parentId&&!organization?.folders.some(row=>row.id===creation.parentId);add(line,'p',missing?'Original folder "'+creation.parentName+'" is no longer available. Cancel to choose a new location.':'New folder in "'+creation.parentName+'".');line.append(el('folder-form'));}


  if(!items.length)add(list,'li','No matching skills.');
  el('trash-list').replaceChildren();for(const item of pageRows(trashItems,'trash',el('trash-list'))){const li=add(el('trash-list'),'li'),assigned=organization?.assignments?.[item.id],location=folderRows(organization?.folders||[]).find(row=>row.id===assigned)?.path;add(li,'span',item.title+(location?' · '+location:''));const restore=add(li,'button','Restore');restore.type='button';restore.dataset.restoreSkill=item.id;icon(restore,'refresh','Restore '+item.title);restore.addEventListener('click',()=>void restoreSkill(item));}if(!trashItems.length)add(el('trash-list'),'li','No deleted skills.');
   renderFolderManager();
   controls();
  }
   function renderFolderManager(){
    const manager=el('folder-manager-list'),deleted=el('removed-category-list');manager.replaceChildren();deleted.replaceChildren();
    const categories=[...new Set([...functionalGroups.values(),otherGroup])].filter(name=>name!==otherGroup);
    for(const row of organization?.folders||[]){
      const line=add(manager,'li');line.className='runtime-folder-management-line';
      add(line,'span',row.name);
      const deleteButton=add(line,'button','Delete');deleteButton.type='button';deleteButton.dataset.manageFolderDelete=row.id;
      deleteButton.setAttribute('aria-label','Delete folder '+row.name);
      deleteButton.addEventListener('click',()=>requestFolderDelete(row.id));
    }
    for(const category of categories){
      if(organization?.removedCategories?.includes('category:'+category)){
        const line=add(deleted,'li');line.className='runtime-folder-management-line';
        add(line,'span',category);
        const restore=add(line,'button','Restore');restore.type='button';restore.dataset.restoreCategory=category;
        restore.addEventListener('click',()=>void mutate({action:'restore_category',category:'category:'+category},
          {successMessage:'Category folder restored.'}));
      }else{
        const line=add(manager,'li');line.className='runtime-folder-management-line';
        add(line,'span',category+' · automatic category');
        const del=add(line,'button','Delete');del.type='button';del.dataset.manageCategoryDelete=category;
        del.addEventListener('click',()=>requestFolderDelete('category:'+category));
      }
    }
    el('removed-categories').hidden=!organization?.removedCategories?.length;
  }
  function showNewSkill(){
  entry=null;inspectorMove.hidden=true;el('heading').textContent='New skill';el('editor').hidden=false;
  el('detail-status').textContent='Start with # Your skill name, then write when and how to use it.';
  el('edit-content').value=newDraft.content;el('save-status').textContent=newDraft.error;
  icon(el('save'),'check','Create skill');icon(el('discard'),'close','Cancel new skill');controls();
 }
 async function createSkill(){
  if(!newDraft||busy||saving||deleteTarget||!newDraft.content.trim())return;
  saving=true;controls();el('save-status').textContent='Creating skill...';
  const draft=newDraft;
  try{
   const saved=await api('/api/skills','POST',{content:draft.content});
   newDraft=null;selected=saved.id;
   el('query').value='';pages.clear();searchDisclosure.clear();closedCategories.delete(groupOf(saved));
   if(active&&!destroyed){await load();if(active&&!destroyed){selected=saved.id;showEntry(saved);el('save-status').textContent='Skill created.';}}
  }catch(error){
   draft.error=error.message+' Your draft is still here.';
   if(active&&!destroyed)el('save-status').textContent=draft.error;
  }finally{saving=false;if(active&&!destroyed)controls();}
 }
 function showEntry(value){
  icon(el('save'),'save','Save skill');icon(el('discard'),'refresh','Discard changes');
  entry=value;inspectorMove.hidden=false;icon(inspectorMove,'move','Move skill '+value.title);const draft=drafts.get(value.id);el('heading').textContent=value.title;el('editor').hidden=false;
  el('edit-content').value=draft?.content??value.content;
  el('save-status').textContent=draft?.error||(draft?'Unsaved changes.':'Saved.');
  el('detail-status').textContent=(value.source==='user'?'Your saved document':'Bundled document')+' · revision '+value.revision+'. Used on the next explicit skill read.';
  controls();
 }
 async function saveSkill(){
  if(saving||busy||deleteTarget||!entry)return;const id=entry.id,draft=drafts.get(id);if(!draft)return;
  saving=true;controls();el('save-status').textContent='Saving...';
  try{const saved=await api('/api/skills/'+encodeURIComponent(id),'POST',{expectedRevision:draft.expectedRevision,content:draft.content});drafts.delete(id);items=items.map(item=>item.id===id?{...item,...saved}:item);if(active&&!destroyed&&selected===id){showEntry(saved);paint();el('save-status').textContent='Saved.';}}
  catch(error){draft.error=error.message+' Your changes are preserved. Discard changes to load the saved document.';if(active&&!destroyed&&selected===id)el('save-status').textContent=draft.error;}
  finally{saving=false;if(active&&!destroyed)controls();}
 }
 async function select(id){
  if(saving||busy||deleteTarget||newDraft)return;selected=id;const epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();clear();paint();el('detail-status').textContent='Loading skill...';
  try{const value=await api('/api/skills/'+encodeURIComponent(id),'GET',undefined,{signal:detailController.signal});if(active&&!destroyed&&epoch===detailEpoch)showEntry(value);}
  catch(error){if(active&&epoch===detailEpoch&&error.name!=='AbortError')el('detail-status').textContent=error.message;}
 }
 async function load(){
  const epoch=++listEpoch;controller?.abort();controller=new AbortController();el('status').textContent='Loading skills and folders...';
  try{const[result,folders,deleted]=await Promise.all([api('/api/skills?query='+encodeURIComponent(el('query').value),'GET',undefined,{signal:controller.signal}),api('/api/skills/folders','GET',undefined,{signal:controller.signal}),api('/api/skills?source=deleted','GET',undefined,{signal:controller.signal})]);if(!active||destroyed||epoch!==listEpoch)return false;
   if(!Array.isArray(result.entries)||!Array.isArray(folders.folders)||!Array.isArray(deleted.entries))throw Error('Unreadable skills or folder catalog.');
   items=result.entries;trashItems=deleted.entries;organization=folders;uncertain=false;
   if(!newDraft&&selected&&!items.some(x=>x.id===selected)){selected=null;++detailEpoch;detailController?.abort();clear();}
   paint();el('status').textContent=items.length+' skills.';return true;
  }catch(error){if(active&&epoch===listEpoch&&error.name!=='AbortError')el('status').textContent=error.message;return false;}
 }
 async function mutate(payload,{expectedRevision=organization?.revision,onSaved=()=>{},afterPaint=()=>{},successMessage='Folder changes saved.'}={}){
  if(blocked())return;let completed=false;busy=true;controls();++listEpoch;controller?.abort();
  try{const result=await api('/api/skills/folders','POST',{...payload,expectedRevision});if(!active||destroyed)return;organization=result;onSaved();paint();completed=true;el('status').textContent=successMessage;}
  catch(error){if(!active||destroyed)return;uncertain=true;el('status').textContent=error.message+' Refresh before another folder edit. Your changes are preserved.';}
  finally{busy=false;if(active&&!destroyed){controls();if(completed)afterPaint();}}
 }
  function requestFolderDelete(id){
  if(blocked()||creation||rename||newDraft)return;
  if(id.startsWith('category:')){
    const category=id.slice('category:'.length);
    if(category===otherGroup||organization?.removedCategories?.includes(id))return;
    const count=items.filter(item=>displayGroup(item)===category).length;
    folderDeleteTarget={id,kind:'category',category,revision:organization.revision};
    deleteFolderInfo.textContent='Delete category folder "'+category+'"? '+count+' skill(s) will move to Other skills. No skill documents will be deleted.';
    deleteFolderPanel.hidden=false;controls();deleteFolderCancel.focus?.();return;
  }
  const folder=organization.folders.find(row=>row.id===id);if(!folder)return;
  const skills=Object.values(organization.assignments||{}).filter(value=>value===id).length;
  const children=organization.folders.filter(row=>row.parentId===id).length;
  folderDeleteTarget={id:folder.id,name:folder.name,parentId:folder.parentId,revision:organization.revision};
  deleteFolderInfo.textContent='Delete "'+folder.name+'"? '+skills+' skill(s) and '+children+' child folder(s) will move to '+(folder.parentId?'the parent folder':'the top level')+'. No skill documents are deleted.';
  deleteFolderPanel.hidden=false;controls();deleteFolderCancel.focus?.();
 }
 function cancelFolderDelete(){folderDeleteTarget=null;deleteFolderPanel.hidden=true;controls();}
 deleteFolderCancel.addEventListener('click',cancelFolderDelete);
 deleteFolderYes.addEventListener('click',()=>{
  const target=folderDeleteTarget;if(!target||busy||saving)return;cancelFolderDelete();
  void mutate(target.kind==='category'?{action:'remove_category',category:target.id}:{action:'remove',id:target.id,relocateContents:true},{expectedRevision:target.revision,
   onSaved:()=>{open.delete(target.id);pages.delete(target.id);if(target.parentId)open.add(target.parentId);},
   afterPaint:()=>target.parentId?focusFolder(target.parentId):el('new-folder').focus?.(),
   successMessage:target.kind==='category'?'Category folder deleted; skills are preserved in Other skills.':'Folder deleted. All skills and child folders were preserved and moved to its parent.'});
 });
 function startCreate(parentId){
  if(blocked()||rename||creation)return;
  if(parentId!==null&&!organization.folders.some(row=>row.id===parentId))return;
  creation={id:globalThis.crypto.randomUUID(),parentId,parentName:organization.folders.find(row=>row.id===parentId)?.name||'Skills',revision:organization.revision};
  if(parentId)openFolder(parentId);pages.delete(parentId);el('folder-name').value='';paint();el('folder-name').focus?.();
 }
 function cancelCreate(){const parentId=creation?.parentId;creation=null;el('folder-name').value='';paint();if(parentId)focusFolder(parentId);else el('new-folder').focus?.();}
  el('new-folder').addEventListener('click',()=>startCreate(null));
  el('manage-folders-button').addEventListener('click',()=>{el('folder-manager').open=true;el('folder-manager').scrollIntoView?.({block:'nearest'});});
 el('create-cancel').addEventListener('click',cancelCreate);
 el('folder-form').addEventListener('keydown',event=>{if(event.key==='Escape'&&!busy){event.preventDefault();cancelCreate();}});
 el('folder-form').addEventListener('submit',event=>{event.preventDefault();if(!creation||(creation.parentId&&!organization.folders.some(row=>row.id===creation.parentId)))return;const name=el('folder-name').value.trim();if(!name)return;const current=creation;void mutate({action:'create',id:current.id,name,parentId:current.parentId},{expectedRevision:current.revision,onSaved:()=>{creation=null;el('folder-name').value='';if(current.parentId)openFolder(current.parentId);},afterPaint:()=>focusFolder(current.id)});});
 drop(el('root'),null);
 el('query').addEventListener('input',()=>{clearTimeout(timer);pages.clear();searchDisclosure.clear();++listEpoch;controller?.abort();if(active)timer=setTimeout(()=>void load(),150);});
 el('new').addEventListener('click',()=>{
  if(blocked()||newDraft)return;
  ++detailEpoch;detailController?.abort();const previousId=selected;selected=null;clear();
  newDraft={content:'# ',error:'',previousId};showNewSkill();
  const field=el('edit-content');field.focus?.();field.setSelectionRange?.(2,2);
 });
 el('refresh').addEventListener('click',()=>{clearTimeout(timer);if(active&&!busy&&!saving&&!deleteTarget)void load().then(ok=>{if(ok&&selected)void select(selected);});});
 el('edit-content').addEventListener('input',()=>{
  if(saving||deleteTarget)return;
  if(newDraft){newDraft.content=el('edit-content').value;newDraft.error='';el('save-status').textContent='';controls();return;}
  if(!entry?.userEditable)return;
  const draft=drafts.get(selected)||{expectedRevision:entry.revision,content:entry.content};draft.content=el('edit-content').value;draft.error='';drafts.set(selected,draft);el('save-status').textContent='Unsaved changes.';controls();
 });
 el('editor').addEventListener('submit',event=>{event.preventDefault();if(newDraft)void createSkill();else void saveSkill();});
 el('discard').addEventListener('click',()=>{if(saving||deleteTarget)return;if(newDraft){const id=newDraft.previousId;newDraft=null;clear();if(id)void select(id);else{controls();el('new').focus?.();}return;}drafts.delete(selected);void select(selected);});

 function cancelDelete(){deleteTarget=null;el('delete-confirm').hidden=true;controls();[...el('list').querySelectorAll('[data-delete-skill]')].find(node=>node.dataset.deleteSkill===selected)?.focus?.();}
 function requestDelete(target=entry){
  if(saving||busy||deleteTarget||!target?.userEditable)return;
  deleteTarget={id:target.id,title:target.title,revision:drafts.get(target.id)?.expectedRevision??target.revision};
  el('delete-message').textContent='Delete "'+target.title+'"? It will be removed from Skills and future skill lookups. '+(drafts.has(target.id)?'Your unsaved changes will be discarded. ':'')+'You can restore your last saved edit, or the current bundled default, from Deleted skills.';
  el('delete-confirm').hidden=false;controls();el('delete-cancel').focus?.();
 }
 async function deleteSkill(){
  if(saving||busy||!deleteTarget)return;const target=deleteTarget;
  saving=true;++listEpoch;++detailEpoch;controller?.abort();detailController?.abort();controls();
  try{
   await api('/api/skills/'+encodeURIComponent(target.id),'DELETE',{expectedRevision:target.revision});
   drafts.delete(target.id);items=items.filter(x=>x.id!==target.id);if(selected===target.id)selected=null;deleteTarget=null;
   if(active&&!destroyed){clear();await load();el('status').textContent='Skill deleted. You can restore it from Deleted skills.';}
  }catch(error){
   deleteTarget=null;if(active&&!destroyed){el('delete-confirm').hidden=true;el('save-status').textContent=error.message+' Deletion was not confirmed. Your unsaved changes are preserved; refresh to inspect the saved state.';}
  }finally{saving=false;if(active&&!destroyed)controls();}
 }
 async function restoreSkill(item){
  if(saving||busy||deleteTarget)return;saving=true;++listEpoch;controller?.abort();controls();
  try{await api('/api/skills/'+encodeURIComponent(item.id)+'/restore','POST',{expectedRevision:item.revision});if(active&&!destroyed){await load();el('status').textContent='Skill restored.';}}
  catch(error){if(active&&!destroyed)el('status').textContent=error.message+' Restore was not confirmed. Refresh to inspect the saved state.';}
  finally{saving=false;if(active&&!destroyed)controls();}
 }
 el('delete-yes').addEventListener('click',()=>void deleteSkill());
 el('delete-cancel').addEventListener('click',cancelDelete);
 el('delete-confirm').addEventListener('keydown',event=>{if(event.key==='Escape'&&!saving){event.preventDefault();cancelDelete();}});
 const beforeUnload=event=>{if(drafts.size||(newDraft&&newDraft.content!=='# ')||rename||(creation&&el('folder-name').value.trim())){event.preventDefault();event.returnValue='';}};hostWindow.addEventListener('beforeunload',beforeUnload);
 clear();controls();
 return {openSkillId(id){if(saving||busy||deleteTarget||newDraft)return;selected=id;if(active)void select(id);},enter(){if(active||destroyed)return;active=true;void load();if(newDraft&&!saving)showNewSkill();else if(selected)void select(selected);},leave(){active=false;closeMove(false);dragging=null;deleteTarget=null;folderDeleteTarget=null;deleteFolderPanel.hidden=true;el('delete-confirm').hidden=true;clearTimeout(timer);++listEpoch;++detailEpoch;controller?.abort();detailController?.abort();},destroy(){this.leave();hostWindow.removeEventListener('beforeunload',beforeUnload);destroyed=true;mount.replaceChildren();}};
}
