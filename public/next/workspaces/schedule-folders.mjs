import { text } from '../core/dom.mjs';

// Folder edits affect organization only. Schedule controls remain owned by tasks.mjs.
export function createScheduleFolders({ mount, api, notify, refresh, compact = false }) {
  let organization = { revision: 0, folders: [], assignments: {} }, pending = false, lastRevision = -1;
  const closed = new Set(), unfiledKey=Symbol('Unfiled');
  const renameDrafts = new Map();
  let fileSelects = [], folderButtons = [], activeDrag = null, moveTarget = null;
  let knownDeployments = new Set(), outlineContainer = null;
  const add = (parent, tag, value, cls) => text(parent, value, tag, cls);

  const icons={folder:'M3 7h6l2-3h10v16H3z M15 10v6 M12 13h6',check:'M5 12l4 4L19 6',close:'M6 6l12 12 M18 6L6 18',move:'M3 8V6h6l2 2h10v11H3z M9 13h8 m-3-3 3 3-3 3'};
  function icon(button,kind,label){button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="'+icons[kind]+'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';button.setAttribute('aria-label',label);button.title=label;button.classList.add('next-folder-icon-action');}
  const manager = add(mount, compact?'div':'details', '', compact?'next-schedule-folder-create':'next-card next-schedule-folder-manager');
  const managerTitle=add(manager, compact?'button':'summary', compact?'New folder':'Manage folders');if(compact){managerTitle.type='button';managerTitle.className='next-schedule-new-folder';manager.open=false;icon(managerTitle,'folder','New top-level folder');}
  let createRevision=null, selectedParent=null;
  manager.classList.toggle('next-schedule-folder-create',compact);
  if(!compact)add(manager, 'p', 'Folders organize cronjobs. Moving or removing a folder does not change schedules or run jobs.', 'next-help');
  const form = add(manager, 'form', '', 'next-schedule-folder-form');if(compact){form.hidden=true;form.classList.add('next-schedule-inline-create');}
  function field(label, tag, name) {
    const wrapper = add(form, 'label', label, 'next-label');
    const el = add(wrapper, tag, '', 'next-field'); el.name = name; return el;
  }
  const selected = compact?{value:'',disabled:false}:field('Folder to edit', 'select', 'folder');
  const name = compact?add(form,'input','','next-field'):field('Folder name', 'input', 'name');name.setAttribute('aria-label','New folder name'); name.required = true; name.maxLength = 120;
  const parent = compact?{value:'',disabled:false}:field('Create inside', 'select', 'parent');
  const actions = add(form, 'div', '', 'next-row');
  const save = add(actions, 'button', 'Create folder'); save.type = 'submit';if(compact)icon(save,'check','Create folder');
  const remove = add(actions, 'button', '\u00d7', 'next-schedule-folder-remove'); remove.type = 'button'; remove.hidden = true; remove.title = 'Remove selected folder only; keep every cronjob'; remove.setAttribute('aria-label','Remove selected folder only');
  const notice = add(manager, 'p', '', 'next-help'); notice.setAttribute('role', 'status');
   // Independent destination list; collapsed folders are still immediately accessible.
   const moveDialog=add(mount,'dialog','','next-schedule-move-dialog');
   moveDialog.id='next-schedule-move-dialog';moveDialog.setAttribute('aria-labelledby','next-schedule-move-heading');
   const moveHeading=add(moveDialog,'h2','Move');moveHeading.id='next-schedule-move-heading';
   add(moveDialog,'p','Choose a destination without expanding the folder tree.','next-help');
   const searchLabel=add(moveDialog,'label','Find destination','next-label');
   const moveSearch=add(searchLabel,'input','','next-field');moveSearch.id='next-schedule-move-query';
   moveSearch.type='search';moveSearch.maxLength=256;
   const moveChoices=add(moveDialog,'div','','next-schedule-move-choices');
   moveChoices.id='next-schedule-move-choices';moveChoices.setAttribute('role','group');moveChoices.setAttribute('aria-label','Destination folders');
   const moveStatus=add(moveDialog,'p','','next-help');moveStatus.setAttribute('role','status');
   const moveCancel=add(moveDialog,'button','Cancel');moveCancel.type='button';moveCancel.id='next-schedule-move-cancel';
  function path(id, seen = new Set()) {
    const folder = organization.folders.find(item => item.id === id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    return [path(folder.parentId, seen), folder.name].filter(Boolean).join(' / ');
  }
  function options(select, first, chosen = '') {
    select.replaceChildren(); const root = add(select, 'option', first); root.value = '';
    for (const folder of [...organization.folders].sort((a,b) => path(a.id).localeCompare(path(b.id)))) {
      const option = add(select, 'option', path(folder.id)); option.value = folder.id;
    }
    select.value = chosen;
  }
  function editSelection() {
    const folder = organization.folders.find(item => item.id === selected.value);
    name.value = folder?.name || ''; parent.value = folder?.parentId || '';
    if(!compact)save.textContent = folder ? 'Save folder' : 'Create folder'; remove.hidden = !folder;
    if(!compact)parent.parentElement.firstChild.textContent = folder ? 'Move inside' : 'Create inside';
  }
  if(!compact)selected.addEventListener('change', editSelection);
  function beginCreate(parentId=null){if(pending||manager.open)return;if(compact&&renameDrafts.size){notice.textContent='Finish or cancel the folder rename first.';return;}parent.value=parentId||'';createRevision=organization.revision;if(!compact)managerTitle.textContent=parentId?'New folder in '+path(parentId):'New folder';form.setAttribute('aria-label',parentId?'New folder in '+path(parentId):'New top-level folder');manager.open=true;if(compact){closed.delete(parentId);placeDraft();form.hidden=false;}name.focus();}
  if(compact){managerTitle.addEventListener('click',event=>{if(!manager.open){event.preventDefault();beginCreate();}});const cancel=add(actions,'button','Cancel');cancel.type='button';icon(cancel,'close','Cancel new folder');cancel.addEventListener('click',()=>{if(pending)return;manager.open=false;form.hidden=true;name.value='';parent.value='';});name.addEventListener('keydown',event=>{if(event.key==='Escape'&&!pending){event.preventDefault();manager.open=false;form.hidden=true;name.value='';parent.value='';}});}
  async function mutate(payload, expectedRevision = organization.revision) {
    if (pending) return false;
    for (const select of [...fileSelects,...folderButtons]) select.disabled = true;
    pending = true; save.disabled = remove.disabled = selected.disabled = name.disabled = parent.disabled = true; notice.textContent = '';
    try {
      organization = await api('/api/operations/folders', 'POST', { ...payload, expectedRevision });
      await refresh(); return true;
    } catch (error) {
      notice.textContent = error.message; notify?.(error.message, true);
      // A conflict needs a new snapshot, not an automatic replay of the edit.
      if (error.status === 409) await refresh();
      return false;
    } finally { for (const select of [...fileSelects,...folderButtons]) select.disabled = false; pending = false; save.disabled = remove.disabled = selected.disabled = name.disabled = parent.disabled = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if(compact&&parent.value&&!organization.folders.some(folder=>folder.id===parent.value)){notice.textContent='The destination folder no longer exists. Your draft is preserved. Cancel it to choose another destination.';save.disabled=true;return;}
    if (await mutate({ action: selected.value ? 'update' : 'create', id: selected.value, name: name.value, parentId: parent.value || null },compact?(createRevision??organization.revision):organization.revision)) {
      selected.value = ''; editSelection();if(compact){manager.open=false;form.hidden=true;parent.value='';} notice.textContent = 'Folder saved.';
    }
  });
  async function removeFolder(id) {
    if (!id || pending) return;
    if(compact&&manager.open){notice.textContent='Finish or cancel the new folder before removing a folder.';return;}
    if (await mutate({ action: 'remove', id })) {
      selected.value = ''; editSelection(); notice.textContent = 'Folder removed. Its cronjobs are Unfiled; child folders moved up one level.';
    }
  }
  remove.addEventListener('click',()=>void removeFolder(selected.value));
  if(!compact)add(manager, 'p', 'Drag folders and cronjobs to organize them. Ctrl+Enter indents into the preceding folder; Ctrl+Shift+Enter moves out one level. Remove folder keeps every cronjob.', 'next-help');
  function currentParent(item){
    return item.kind==='folder'?organization.folders.find(folder=>folder.id===item.id)?.parentId||null:organization.assignments?.[item.id]||null;
  }
  function focusItem(item){
    const attribute=item.kind==='folder'?'scheduleFolder':'scheduleId';
    const row=[...(outlineContainer?.querySelectorAll(item.kind==='folder'?'[data-schedule-folder]':'[data-schedule-id]')||[])].find(value=>value.dataset[attribute]===item.id);
    for(let ancestor=row?.parentElement;ancestor;ancestor=ancestor.parentElement){if(ancestor.tagName==='DETAILS'){ancestor.open=true;if(ancestor.dataset.scheduleFolder)closed.delete(ancestor.dataset.scheduleFolder);else if(ancestor.dataset.scheduleUnfiled)closed.delete(unfiledKey);}}
    row?.querySelector('summary')?.focus();
  }
  const folderOrder=new Intl.Collator('en',{sensitivity:'base',numeric:true});
  function moveControl(item){
    const key=item.kind==='folder'?'moveFolder':'moveSchedule';
    return [...(outlineContainer?.querySelectorAll('[data-move-folder],[data-move-schedule]')||[])].find(node=>node.dataset[key]===item.id);
  }
  function closeMove(restoreFocus=true){
    const item=moveTarget?.item;moveTarget=null;
    if(moveDialog.open)moveDialog.close();
    if(restoreFocus&&item)moveControl(item)?.focus?.();
  }
  function excludedFolderIds(id){
    const found=new Set([id]);
    for(let changed=true;changed;){
      changed=false;
      for(const folder of organization.folders){
        if(found.has(folder.parentId)&&!found.has(folder.id)){found.add(folder.id);changed=true;}
      }
    }
    return found;
  }
  function paintMoveOptions(){
    if(!moveTarget)return;
    moveChoices.replaceChildren();
    const search=moveSearch.value.trim().toLocaleLowerCase();
    const current=currentParent(moveTarget.item);
    const excluded=moveTarget.item.kind==='folder'?excludedFolderIds(moveTarget.item.id):new Set();
    const choices=[
      {id:null,name:moveTarget.item.kind==='folder'?'Top-level folders':'Unfiled',group:'Top level'},
      ...organization.folders.filter(folder=>!excluded.has(folder.id))
        .map(folder=>({id:folder.id,name:path(folder.id),group:'Folders'}))
        .sort((a,b)=>folderOrder.compare(a.name,b.name)||folderOrder.compare(a.id,b.id)),
    ].filter(row=>row.name.toLocaleLowerCase().includes(search));
    let group='';
    for(const row of choices){
      if(group!==row.group){group=row.group;add(moveChoices,'h3',group,'next-schedule-move-group');}
      const button=add(moveChoices,'button',row.name+(current===row.id?' (current)':''),'next-schedule-move-choice');
      button.type='button';button.dataset.moveDestination=row.id??'';
      if(current===row.id){button.disabled=true;button.setAttribute('aria-current','location');}
      button.addEventListener('click',()=>void commitMove(row.id));
    }
    moveStatus.textContent=choices.length?choices.length+' matching destinations.':'No matching destinations.';
  }
  function beginMove(item,label){
    if(pending||!item)return;
    if(manager.open||renameDrafts.size){notice.textContent='Finish or cancel folder creation or rename before moving.';return;}
    if(item.kind==='schedule'&&!knownDeployments.has(item.id))return;
    if(item.kind==='folder'&&!organization.folders.some(folder=>folder.id===item.id))return;
    moveTarget={item,revision:organization.revision};
    moveHeading.textContent='Move '+(item.kind==='folder'?'folder':'cronjob')+': '+label;
    moveSearch.value='';paintMoveOptions();
    if(!moveDialog.open)moveDialog.showModal();
    moveSearch.focus();
  }
  async function commitMove(folderId){
    const current=moveTarget;
    if(!current||pending)return;
    closeMove(false);
    const ok=await move(current.item,folderId,current.revision);
    if(ok)moveControl(current.item)?.focus?.();
  }
  moveSearch.addEventListener('input',paintMoveOptions);
  moveCancel.addEventListener('click',()=>closeMove());
  moveDialog.addEventListener('cancel',event=>{event.preventDefault();closeMove();});
  async function move(item,parentId,expectedRevision=organization.revision){
    if(pending||!item)return;
    if(item.kind==='schedule'){
      if(!knownDeployments.has(item.id)||currentParent(item)===(parentId||null))return;
      const result=await mutate({action:'assign',deploymentId:item.id,folderId:parentId||null},expectedRevision);focusItem(item);return result;
    }
    const folder=organization.folders.find(folder=>folder.id===item.id);
    if(!folder||folder.parentId===(parentId||null))return;
    const visited=new Set();
    for(let cursor=parentId;cursor;cursor=organization.folders.find(value=>value.id===cursor)?.parentId){
      if(visited.has(cursor)||cursor===folder.id){notice.textContent='A folder cannot be moved inside itself.';return;}
      visited.add(cursor);
    }
    const result=await mutate({action:'update',id:folder.id,name:folder.name,parentId:parentId||null},expectedRevision);focusItem(item);return result;
  }
  function outlineNavigation(event,element,canRename=false){
    if(!compact||event.ctrlKey||event.metaKey||event.altKey)return false;
    const row=element.parentElement;let next=null;
    const visible=[...(outlineContainer?.querySelectorAll('summary')||[])].filter(value=>{
      const node=value.parentElement;
      if(!node?.dataset.scheduleFolder&&!node?.dataset.scheduleId&&!node?.dataset.scheduleUnfiled)return false;
      for(let ancestor=node.parentElement;ancestor&&ancestor!==outlineContainer;ancestor=ancestor.parentElement)
        if(ancestor.tagName==='DETAILS'&&!ancestor.open)return false;
      return true;
    });const index=visible.indexOf(element);
    if(event.key==='ArrowDown')next=visible[index+1];else if(event.key==='ArrowUp')next=visible[index-1];else if(event.key==='Home')next=visible[0];else if(event.key==='End')next=visible.at(-1);
    else if(event.key==='ArrowLeft'){if(row.open)row.open=false;else next=row.parentElement?.closest?.('[data-schedule-folder], [data-schedule-unfiled]')?.querySelector('summary');}
    else if(event.key==='ArrowRight'){if(!row.open)row.open=true;else next=visible[index+1];}
    else if(event.key==='F2'&&canRename)element.querySelector('.next-schedule-folder-name')?.click();else return false;
    event.preventDefault();event.stopPropagation();next?.focus();return true;
  }
  function draggable(element,item){
    element.draggable=true;
    element.addEventListener('dragstart',event=>{
      if(pending||event.target?.closest?.('button,input,select,textarea')){event.preventDefault();return;}
      event.stopPropagation();activeDrag=item;
      event.dataTransfer?.setData('application/x-blackice-schedule',JSON.stringify(item));
      if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
    });
    element.addEventListener('dragend',()=>{activeDrag=null;});
    element.addEventListener('keydown',event=>{
      if(event.target!==element&&!(item.kind==='folder'&&event.target?.classList?.contains('next-schedule-folder-name')&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'))return;
      if(outlineNavigation(event,element,item.kind==='folder'))return;
      if(event.target?.tagName==='INPUT'||!(event.ctrlKey||event.metaKey)||event.key!=='Enter')return;
      event.preventDefault();event.stopPropagation();
      const parentId=currentParent(item);
      if(event.shiftKey){
        if(parentId)void move(item,organization.folders.find(folder=>folder.id===parentId)?.parentId||null);
        else notice.textContent='Already at the top level.';
      }else{
        const siblings=organization.folders.filter(folder=>(folder.parentId||null)===parentId).sort((a,b)=>a.name.localeCompare(b.name));
        const index=item.kind==='folder'?siblings.findIndex(folder=>folder.id===item.id):siblings.length;
        const previous=siblings[index-1];
        if(previous)void move(item,previous.id);else notice.textContent='No preceding folder to indent into. Drag to a folder instead.';
      }
    });
  }
  function dropTarget(element,parentId){
    element.addEventListener('dragover',event=>{if(activeDrag&&!pending){event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='move';element.classList.add('next-schedule-drop-target');}});
    element.addEventListener('dragleave',()=>element.classList.remove('next-schedule-drop-target'));
    element.addEventListener('drop',event=>{
      if(!activeDrag||pending)return;
      event.preventDefault();event.stopPropagation();element.classList.remove('next-schedule-drop-target');
      const item=activeDrag;activeDrag=null;void move(item,parentId);
    });
  }

  function paintSelection(){if(!compact)return;for(const row of outlineContainer?.querySelectorAll('[data-schedule-folder]')||[])row.classList.toggle('next-folder-selected',row.dataset.scheduleFolder===selectedParent);}
  function placeDraft(){if(!compact||!outlineContainer)return;const row=[...outlineContainer.querySelectorAll('[data-schedule-folder]')].find(row=>row.dataset.scheduleFolder===parent.value);const missing=!!parent.value&&!row;const host=row?.querySelector('.next-schedule-folder-children')||outlineContainer;save.disabled=pending||missing;if(missing){notice.textContent='The destination folder no longer exists. Your draft is preserved. Cancel it to choose another destination.';}if(row){row.open=true;closed.delete(parent.value);}host.insertBefore(form,host.firstChild);form.hidden=!manager.open;}
  return {
    leave(){closeMove(false);manager.open=false;form.hidden=true;activeDrag=null;},
    group(container, deployments, value) {
      outlineContainer=container;
      organization = value || { revision: 0, folders: [], assignments: {} };
      if(compact&&!manager.open&&selectedParent&&!organization.folders.some(folder=>folder.id===selectedParent))selectedParent=null;
      if (!compact && lastRevision !== organization.revision) {
        const chosen = selected.value, chosenParent = parent.value;
        options(selected, 'New folder', chosen); options(parent, 'Top level', chosenParent);
        lastRevision = organization.revision;
      }
      fileSelects = []; folderButtons = [];knownDeployments=new Set(deployments.map(item=>item.id));
      const targets = new Map(), folders = organization.folders || [];
      function branch(parentId, host, ancestors = new Set()) {
        for (const folder of folders.filter(item => (item.parentId || null) === parentId).sort((a,b) => a.name.localeCompare(b.name))) {
          if (ancestors.has(folder.id)) continue;
          const next = new Set(ancestors).add(folder.id);
          const details = add(host, 'details', '', 'next-schedule-folder-branch');
          details.open = !closed.has(folder.id);
          details.dataset.scheduleFolder = folder.id;
          const summary = add(details, 'summary', '');if(compact)summary.addEventListener('click',event=>{if(event.target!==summary)return;selectedParent=folder.id;paintSelection();});
          const label = add(summary,'button',folder.name,'next-schedule-folder-name');label.type='button';label.disabled=pending;folderButtons.push(label);label.title='Rename folder';
          const input = add(summary,'input','','next-field next-schedule-folder-name-input');input.maxLength=120;input.setAttribute('aria-label','Rename folder '+folder.name);input.hidden=!renameDrafts.has(folder.id);input.value=renameDrafts.get(folder.id)?.name??folder.name;label.hidden=!input.hidden;
          const renameActions=compact?add(summary,'span','','next-schedule-rename-actions'):null;
          if(renameActions){renameActions.hidden=input.hidden;for(const [kind,key,label] of [['check','Enter','Save folder name'],['close','Escape','Cancel folder rename']]){const button=add(renameActions,'button','');button.type='button';icon(button,kind,label);button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();input.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));});}}
          function cancelRename(){renameDrafts.delete(folder.id);input.hidden=true;label.hidden=false;if(renameActions)renameActions.hidden=true;label.focus();}
          label.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(pending)return;if(compact){selectedParent=folder.id;paintSelection();}renameDrafts.set(folder.id,{name:folder.name,revision:organization.revision,parentId:folder.parentId||null});input.value=folder.name;label.hidden=true;input.hidden=false;if(renameActions)renameActions.hidden=false;input.focus();input.select?.();});
          input.addEventListener('input',()=>{const draft=renameDrafts.get(folder.id);if(draft)draft.name=input.value;});
          input.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});
          input.addEventListener('dragstart',event=>{event.preventDefault();event.stopPropagation();});
          input.addEventListener('keydown',async event=>{
            event.stopPropagation();
            if(event.key==='Escape'){event.preventDefault();cancelRename();return;}
            if(event.key!=='Enter')return;event.preventDefault();if(pending)return;
            const nextName=input.value.trim();if(!nextName){input.setCustomValidity?.('Enter a folder name.');input.reportValidity?.();return;}input.setCustomValidity?.('');
            if(nextName===folder.name){cancelRename();return;}
            input.disabled=true;
            const draft=renameDrafts.get(folder.id);
            const ok=await mutate({action:'update',id:folder.id,name:nextName,parentId:draft?.parentId??null},draft?.revision??organization.revision);
            input.disabled=false;
            if(ok){renameDrafts.delete(folder.id);await refresh();focusItem({kind:'folder',id:folder.id});}
          });
          draggable(summary,{kind:'folder',id:folder.id});dropTarget(summary,folder.id);
          summary.title='Use Move to choose any folder, or drag. Ctrl+Enter indents; Ctrl+Shift+Enter moves out one level.';
          const direct = deployments.filter(item => organization.assignments?.[item.id] === folder.id).length;
          const descendants = new Set([folder.id]);
          for (let changed = true; changed;) { changed = false; for (const item of folders) if (descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
          const count = deployments.filter(item => descendants.has(organization.assignments?.[item.id])).length;
          if(!compact){const badge = add(summary, 'span', String(count), 'next-status-pill'); badge.title = 'Cronjobs in this folder and subfolders';}
          if(compact){const child=add(summary,'button','','next-schedule-folder-add');child.type='button';icon(child,'folder','New subfolder in '+path(folder.id));child.disabled=pending;folderButtons.push(child);child.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();beginCreate(folder.id);});}
           const folderMove=add(summary,'button','','next-schedule-folder-move');
           folderMove.type='button';folderMove.dataset.moveFolder=folder.id;
           icon(folderMove,'move','Move folder '+path(folder.id));
           folderMove.disabled=pending||manager.open||!!renameDrafts.size;folderButtons.push(folderMove);
           folderMove.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();beginMove({kind:'folder',id:folder.id},path(folder.id));});
          const deleteButton=add(summary,'button','\u00d7','next-schedule-folder-remove');deleteButton.type='button';if(compact)icon(deleteButton,'close','Remove folder '+path(folder.id));deleteButton.disabled=pending;folderButtons.push(deleteButton);deleteButton.title='Remove folder only; keep every cronjob';deleteButton.setAttribute('aria-label','Remove folder '+path(folder.id));deleteButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void removeFolder(folder.id);});
          details.addEventListener('toggle', () => details.open ? closed.delete(folder.id) : closed.add(folder.id));
          const children = add(details, 'div', '', 'next-schedule-folder-children');
          branch(folder.id, children, next);
          const cards = add(children, 'div', '', 'next-grid'); targets.set(folder.id, cards);
          if (!direct && !folders.some(item => item.parentId === folder.id)) add(cards, 'p', 'Empty folder', 'next-help');
        }
      }
      branch(null, container);paintSelection();if(compact&&manager.open)placeDraft();
      const unfiled=add(container,'details','','next-schedule-folder-branch next-schedule-unfiled');
      unfiled.dataset.scheduleUnfiled='true';unfiled.open=!closed.has(unfiledKey);
      const unfiledHeading=add(unfiled,'summary','Unfiled');
      unfiledHeading.title='Drop a cronjob here to unfile it, or a folder to move it to the top level.';
      dropTarget(unfiledHeading,null);
      unfiledHeading.addEventListener('click',()=>{selectedParent=null;paintSelection();});
      unfiledHeading.addEventListener('keydown',event=>{if(event.target===unfiledHeading)outlineNavigation(event,unfiledHeading);});
      unfiled.addEventListener('toggle',()=>unfiled.open?closed.delete(unfiledKey):closed.add(unfiledKey));
      const unfiledChildren=add(unfiled,'div','','next-schedule-folder-children');
      const cards=add(unfiledChildren,'div','','next-grid');targets.set('',cards);
      if (!deployments.some(item => !targets.has(organization.assignments?.[item.id]))) add(cards, 'p', 'No unfiled cronjobs.', 'next-help');
      return {
        target: task => targets.get(organization.assignments?.[task.id]) || cards,
        outlineControl(row,task){
          const handle=row.querySelector('summary');
          draggable(handle,{kind:'schedule',id:task.id});
          handle.title='Use Move to choose any folder, or drag. Ctrl+Enter indents; Ctrl+Shift+Enter moves out one level.';
           const moveButton=add(handle,'button','','next-cronjob-move');
           moveButton.type='button';moveButton.dataset.moveSchedule=task.id;
           icon(moveButton,'move','Move cronjob '+(task.name||'Scheduled task'));
           moveButton.disabled=pending||manager.open||!!renameDrafts.size;
           folderButtons.push(moveButton);
           moveButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();beginMove({kind:'schedule',id:task.id},task.name||'Scheduled task');});
        },
        fileControl(card, task) {
          const label = add(card, 'label', 'File in folder', 'next-label next-schedule-file-control');
          const select = add(label, 'select', '', 'next-field');
          select.setAttribute('aria-label', 'File ' + (task.name || 'cronjob') + ' in folder');
          options(select, 'Unfiled', organization.assignments?.[task.id] || '');
          select.disabled = pending; fileSelects.push(select);
          select.addEventListener('change', async () => {
            select.disabled = true;
            const ok = await mutate({ action: 'assign', deploymentId: task.id, folderId: select.value || null });
            if (!ok) { select.value = organization.assignments?.[task.id] || ''; select.disabled = false; }
          });
        }
      };
    }
  };
}
