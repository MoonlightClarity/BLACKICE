import {folderRows,descendants} from '../core/folder-tree.mjs';
/** Humans edit effective skills. Model skill tools are read-only; folders only organize the view. */
export function createSkillsWorkspace({mount,api}) {
 mount.innerHTML='<div class="next-panel next-skills-root"><div class="next-panel-inner"><header class="next-panel-head"><div><h1>Skills</h1><p>Your methods, editable here. Model skill tools are read-only.</p></div><button id="skills-refresh" type="button">Refresh</button></header><label class="next-label">Find a skill<input id="skills-query" class="next-field" type="search" maxlength="256"></label><p id="skills-status" role="status" aria-live="polite"></p><div class="next-skills-layout"><aside class="next-skills-aside" aria-label="Available skills"><form id="skills-folder-form" class="next-skills-folder-form"><label class="next-label">New folder<input id="skills-folder-name" class="next-field" maxlength="60" required></label><label class="next-label">Inside<select id="skills-folder-parent" class="next-field"></select></label><button type="submit">Create folder</button></form><ul id="skills-list" class="next-skills-list"></ul><section id="skills-folder-editor" hidden><h2>Selected folder</h2><form id="skills-folder-edit-form"><label class="next-label">Name<input id="skills-folder-edit-name" class="next-field" maxlength="60" required></label><label class="next-label">Inside<select id="skills-folder-edit-parent" class="next-field"></select></label><button type="submit">Save folder</button><button id="skills-folder-remove" type="button">Delete empty folder</button></form></section></aside><section class="next-card next-skills-inspector" aria-label="Skill inspector"><h2 id="skills-heading">Select a skill</h2><p id="skills-detail-status" role="status" aria-live="polite"></p><form id="skills-assignment" hidden><label class="next-label">Folder<select id="skills-assignment-folder" class="next-field"></select></label><button type="submit">Move skill</button></form><dl id="skills-meta" class="next-skills-meta"></dl><button id="skills-edit" type="button" hidden>Edit skill</button><form id="skills-editor" hidden><p>Saved changes apply on the next explicit skill read. Bundled originals stay unchanged.</p><label class="next-label">Title<textarea id="skills-edit-title" maxlength="160" class="next-field" rows="2" required spellcheck="false"></textarea></label><label class="next-label">Summary<textarea id="skills-edit-summary" maxlength="2000" class="next-field" rows="2" required spellcheck="false"></textarea></label><label class="next-label">When to use<textarea id="skills-edit-appliesWhen" maxlength="4000" class="next-field" rows="2" required spellcheck="false"></textarea></label><label class="next-label">Scope<textarea id="skills-edit-scope" maxlength="4000" class="next-field" rows="2" required spellcheck="false"></textarea></label><label class="next-label">Instructions<textarea id="skills-edit-content" maxlength="200000" class="next-field" rows="18" required spellcheck="false"></textarea></label><div class="next-skills-actions"><button type="submit">Save skill</button><button id="skills-discard" type="button">Discard draft</button></div><p id="skills-save-status" role="status" aria-live="polite"></p></form><pre id="skills-content" class="next-skills-content" hidden></pre></section></div></div></div>';
 const el=id=>mount.querySelector('#skills-'+id),add=(parent,tag,text)=>{const node=mount.ownerDocument.createElement(tag);if(text!==undefined)node.textContent=String(text);parent.append(node);return node;};
 let active=false,destroyed=false,listEpoch=0,detailEpoch=0,controller,detailController,timer,selected=null,items=[],organization=null,busy=false,uncertain=false,folder=null,folderEditRevision=null;
 const open=new Set(),drafts=new Map(),fields=['title','summary','appliesWhen','scope','content'];let entry=null,saving=false;
 function controls(){for(const node of mount.querySelectorAll('button,input,select,textarea'))node.disabled=busy||saving;for(const form of [el('folder-form'),el('folder-edit-form'),el('assignment')])for(const node of form.querySelectorAll('button,input,select'))node.disabled=busy||saving||uncertain||!organization;}
 function clear(){entry=null;el('edit').hidden=true;el('editor').hidden=true;el('heading').textContent='Select a skill';el('meta').replaceChildren();el('content').textContent='';el('content').hidden=true;el('assignment').hidden=true;el('detail-status').textContent='Reading here does not activate a skill in a conversation.';}
 function options(select,current,excluded=new Set()){select.replaceChildren();const root=add(select,'option','At top level');root.value='';for(const row of folderRows(organization?.folders||[])){if(excluded.has(row.id))continue;const option=add(select,'option',row.path);option.value=row.id;}select.value=current||'';}
 function editFolder(id){folder=id;const row=organization.folders.find(x=>x.id===id);el('folder-editor').hidden=!row;if(!row)return;folderEditRevision=organization.revision;el('folder-edit-name').value=row.name;options(el('folder-edit-parent'),row.parentId,descendants(organization.folders,id));controls();}
 function paint(){
  const list=el('list');list.replaceChildren();const containers=new Map([[null,list]]);
  for(const row of folderRows(organization?.folders||[])){
   const li=add(containers.get(row.parentId)||list,'li'),details=add(li,'details');details.className='next-skills-folder';details.open=open.has(row.id);
   const summary=add(details,'summary',row.name);summary.dataset.folderId=row.id;
   details.addEventListener('toggle',()=>{if(details.open)open.add(row.id);else open.delete(row.id);});
   const edit=add(details,'button','Edit folder');edit.type='button';edit.dataset.editFolder=row.id;edit.addEventListener('click',()=>editFolder(row.id));
   const children=add(details,'ul');children.className='next-skills-list';containers.set(row.id,children);
  }
  for(const item of items){const parent=containers.get(organization?.assignments[item.id]??null)||list,li=add(parent,'li'),button=add(li,'button',item.title);button.type='button';button.dataset.skillId=item.id;button.setAttribute('aria-pressed',String(selected===item.id));button.addEventListener('click',()=>void select(item.id));}
  if(!items.length)add(list,'li','No matching skills.');
  const parentValue=el('folder-parent').value;options(el('folder-parent'),parentValue);
  if(selected)options(el('assignment-folder'),organization?.assignments[selected]);
  if(folder&&!organization?.folders.some(x=>x.id===folder)){folder=null;el('folder-editor').hidden=true;}
  controls();
 }

 function showEntry(value){
  entry=value;el('heading').textContent=value.title;el('meta').replaceChildren();
  for(const[label,text]of[['Source',value.source==='user'?'Your saved edit':'Bundled original'],['When to use',value.appliesWhen],['Scope',value.scope],['Revision',value.revision]]){add(el('meta'),'dt',label);add(el('meta'),'dd',text);}
  const draft=drafts.get(value.id);el('edit').hidden=!value.userEditable||!!draft;el('editor').hidden=!draft;
  if(draft){for(const key of fields)el('edit-'+key).value=draft[key];el('save-status').textContent=draft.error||'Unsaved draft.';}
  el('content').textContent=value.content;el('content').hidden=!!draft;el('assignment').hidden=false;options(el('assignment-folder'),organization?.assignments[value.id]);controls();el('detail-status').textContent='Reading here does not activate a skill. Model skill tools are read-only.';
 }
 async function saveSkill(){
  if(saving||busy||!entry)return;const id=entry.id,draft=drafts.get(id);if(!draft)return;
  const payload={expectedRevision:draft.expectedRevision};for(const key of fields)payload[key]=draft[key];
  saving=true;controls();el('save-status').textContent='Saving...';
  try{const saved=await api('/api/skills/'+encodeURIComponent(id),'POST',payload);drafts.delete(id);items=items.map(item=>item.id===id?{...item,...saved}:item);if(active&&!destroyed&&selected===id){showEntry(saved);paint();el('detail-status').textContent='Skill saved. Models will read your edit on their next explicit skill read.';}}
  catch(error){draft.error=error.message+' Your draft is preserved. Discard it to load the saved version.';if(active&&!destroyed&&selected===id)el('save-status').textContent=draft.error;}
  finally{saving=false;if(active&&!destroyed)controls();}
 }
 async function select(id){
  if(saving||busy)return;
  selected=id;const epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();clear();paint();el('detail-status').textContent='Loading skill...';
  try{const entry=await api('/api/skills/'+encodeURIComponent(id),'GET',undefined,{signal:detailController.signal});if(!active||destroyed||epoch!==detailEpoch)return;
   showEntry(entry);
  }catch(error){if(active&&epoch===detailEpoch&&error.name!=='AbortError')el('detail-status').textContent=error.message;}
 }
 async function load(){
  const epoch=++listEpoch;controller?.abort();controller=new AbortController();el('status').textContent='Loading skills and folders...';
  try{const[result,folders]=await Promise.all([api('/api/skills?query='+encodeURIComponent(el('query').value),'GET',undefined,{signal:controller.signal}),api('/api/skills/folders','GET',undefined,{signal:controller.signal})]);if(!active||destroyed||epoch!==listEpoch)return false;
   if(!Array.isArray(result.entries)||!Array.isArray(folders.folders))throw Error('Unreadable skills or folder catalog.');
   items=result.entries;organization=folders;uncertain=false;
   if(selected&&!items.some(x=>x.id===selected)){selected=null;++detailEpoch;detailController?.abort();clear();}
   paint();el('status').textContent=items.length+' skills. Folder changes do not edit skill contents.';return true;
  }catch(error){if(active&&epoch===listEpoch&&error.name!=='AbortError')el('status').textContent=error.message;return false;}
 }
 async function mutate(payload,{expectedRevision=organization?.revision,onSaved=()=>{}}={}){
  if(busy||saving||uncertain||!organization)return;busy=true;controls();++listEpoch;controller?.abort();
  try{const result=await api('/api/skills/folders','POST',{...payload,expectedRevision});if(!active||destroyed)return;organization=result;onSaved();paint();el('status').textContent='Folder changes saved.';}
  catch(error){if(!active||destroyed)return;uncertain=true;el('status').textContent=error.message+' Refresh before another edit. Your draft is still here.';}
  finally{busy=false;if(active&&!destroyed)controls();}
 }
 el('folder-form').addEventListener('submit',event=>{event.preventDefault();const name=el('folder-name').value.trim();if(!name)return;void mutate({action:'create',id:globalThis.crypto.randomUUID(),name,parentId:el('folder-parent').value||null},{onSaved:()=>{el('folder-name').value='';}});});
 el('folder-edit-form').addEventListener('submit',event=>{event.preventDefault();if(!folder)return;void mutate({action:'update',id:folder,name:el('folder-edit-name').value.trim(),parentId:el('folder-edit-parent').value||null},{expectedRevision:folderEditRevision,onSaved:()=>editFolder(folder)});});
 el('folder-remove').addEventListener('click',()=>{if(folder)void mutate({action:'remove',id:folder},{expectedRevision:folderEditRevision});});
 el('assignment').addEventListener('submit',event=>{event.preventDefault();if(selected)void mutate({action:'assign',skillId:selected,folderId:el('assignment-folder').value||null});});
 el('query').addEventListener('input',()=>{clearTimeout(timer);++listEpoch;controller?.abort();if(active)timer=setTimeout(()=>void load(),150);});
 el('refresh').addEventListener('click',()=>{clearTimeout(timer);if(active&&!busy&&!saving)void load().then(ok=>{if(ok&&folder)editFolder(folder);if(ok&&selected)void select(selected);});});

 el('edit').addEventListener('click',()=>{if(!entry||saving||!entry.userEditable)return;drafts.set(entry.id,{expectedRevision:entry.revision,...Object.fromEntries(fields.map(key=>[key,entry[key]]))});showEntry(entry);el('editor').scrollIntoView?.({block:'start'});el('edit-content').focus?.();});
 for(const key of fields)el('edit-'+key).addEventListener('input',()=>{const draft=drafts.get(selected);if(!draft||saving)return;draft[key]=el('edit-'+key).value;draft.error='';el('save-status').textContent='Unsaved draft.';});
 el('editor').addEventListener('submit',event=>{event.preventDefault();void saveSkill();});
 el('discard').addEventListener('click',()=>{if(saving)return;drafts.delete(selected);void select(selected);});
 const hostWindow=window;const beforeUnload=event=>{if(drafts.size){event.preventDefault();event.returnValue='';}};hostWindow.addEventListener('beforeunload',beforeUnload);
 clear();controls();
 return {openSkillId(id){if(saving||busy)return;selected=id;if(active)void select(id);},enter(){if(active||destroyed)return;active=true;void load();if(selected)void select(selected);},leave(){active=false;clearTimeout(timer);++listEpoch;++detailEpoch;controller?.abort();detailController?.abort();},destroy(){this.leave();hostWindow.removeEventListener('beforeunload',beforeUnload);destroyed=true;mount.replaceChildren();}};
}
