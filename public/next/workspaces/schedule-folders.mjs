import { text } from '../core/dom.mjs';

// Folder edits affect organization only. Schedule controls remain owned by tasks.mjs.
export function createScheduleFolders({ mount, api, notify, refresh }) {
  let organization = { revision: 0, folders: [], assignments: {} }, pending = false, lastRevision = -1;
  const closed = new Set();
  let fileSelects = [], folderButtons = [], activeDrag = null;
  let knownDeployments = new Set(), outlineContainer = null;
  const add = (parent, tag, value, cls) => text(parent, value, tag, cls);
  const manager = add(mount, 'details', '', 'next-card next-schedule-folder-manager');
  add(manager, 'summary', 'Manage folders');
  add(manager, 'p', 'Folders organize cronjobs. Moving or removing a folder does not change schedules or run jobs.', 'next-help');
  const form = add(manager, 'form', '', 'next-schedule-folder-form');
  function field(label, tag, name) {
    const wrapper = add(form, 'label', label, 'next-label');
    const el = add(wrapper, tag, '', 'next-field'); el.name = name; return el;
  }
  const selected = field('Folder to edit', 'select', 'folder');
  const name = field('Folder name', 'input', 'name'); name.required = true; name.maxLength = 120;
  const parent = field('Create inside', 'select', 'parent');
  const actions = add(form, 'div', '', 'next-row');
  const save = add(actions, 'button', 'Create folder'); save.type = 'submit';
  const remove = add(actions, 'button', '\u00d7', 'next-schedule-folder-remove'); remove.type = 'button'; remove.hidden = true; remove.title = 'Remove selected folder only; keep every cronjob'; remove.setAttribute('aria-label','Remove selected folder only');
  const notice = add(manager, 'p', '', 'next-help'); notice.setAttribute('role', 'status');
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
    save.textContent = folder ? 'Save folder' : 'Create folder'; remove.hidden = !folder;
    parent.parentElement.firstChild.textContent = folder ? 'Move inside' : 'Create inside';
  }
  selected.addEventListener('change', editSelection);
  async function mutate(payload) {
    if (pending) return false;
    for (const select of [...fileSelects,...folderButtons]) select.disabled = true;
    pending = true; save.disabled = remove.disabled = selected.disabled = name.disabled = parent.disabled = true; notice.textContent = '';
    try {
      organization = await api('/api/operations/folders', 'POST', { ...payload, expectedRevision: organization.revision });
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
    if (await mutate({ action: selected.value ? 'update' : 'create', id: selected.value, name: name.value, parentId: parent.value || null })) {
      selected.value = ''; editSelection(); notice.textContent = 'Folder saved.';
    }
  });
  async function removeFolder(id) {
    if (!id || pending) return;
    if (await mutate({ action: 'remove', id })) {
      selected.value = ''; editSelection(); notice.textContent = 'Folder removed. Its cronjobs are Unfiled; child folders moved up one level.';
    }
  }
  remove.addEventListener('click',()=>void removeFolder(selected.value));
  add(manager, 'p', 'Drag folders and cronjobs to organize them. Ctrl+Enter indents into the preceding folder; Ctrl+Shift+Enter moves out one level. Remove folder keeps every cronjob.', 'next-help');
  function currentParent(item){
    return item.kind==='folder'?organization.folders.find(folder=>folder.id===item.id)?.parentId||null:organization.assignments?.[item.id]||null;
  }
  function focusItem(item){
    const attribute=item.kind==='folder'?'scheduleFolder':'scheduleId';
    const row=[...(outlineContainer?.querySelectorAll(item.kind==='folder'?'[data-schedule-folder]':'[data-schedule-id]')||[])].find(value=>value.dataset[attribute]===item.id);
    row?.querySelector('summary')?.focus();
  }
  async function move(item,parentId){
    if(pending||!item)return;
    if(item.kind==='schedule'){
      if(!knownDeployments.has(item.id)||currentParent(item)===(parentId||null))return;
      const result=await mutate({action:'assign',deploymentId:item.id,folderId:parentId||null});focusItem(item);return result;
    }
    const folder=organization.folders.find(folder=>folder.id===item.id);
    if(!folder||folder.parentId===(parentId||null))return;
    const visited=new Set();
    for(let cursor=parentId;cursor;cursor=organization.folders.find(value=>value.id===cursor)?.parentId){
      if(visited.has(cursor)||cursor===folder.id){notice.textContent='A folder cannot be moved inside itself.';return;}
      visited.add(cursor);
    }
    const result=await mutate({action:'update',id:folder.id,name:folder.name,parentId:parentId||null});focusItem(item);return result;
  }
  function draggable(element,item){
    element.draggable=true;
    element.addEventListener('dragstart',event=>{
      if(pending){event.preventDefault();return;}
      event.stopPropagation();activeDrag=item;
      event.dataTransfer?.setData('application/x-blackice-schedule',JSON.stringify(item));
      if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
    });
    element.addEventListener('dragend',()=>{activeDrag=null;});
    element.addEventListener('keydown',event=>{
      if(!(event.ctrlKey||event.metaKey)||event.key!=='Enter')return;
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
  return {
    leave(){manager.open=false;activeDrag=null;},
    group(container, deployments, value) {
      outlineContainer=container;
      organization = value || { revision: 0, folders: [], assignments: {} };
      if (lastRevision !== organization.revision) {
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
          const summary = add(details, 'summary', folder.name);
          draggable(summary,{kind:'folder',id:folder.id});dropTarget(summary,folder.id);
          summary.title='Drag to move. Ctrl+Enter indents; Ctrl+Shift+Enter moves out one level.';
          const direct = deployments.filter(item => organization.assignments?.[item.id] === folder.id).length;
          const descendants = new Set([folder.id]);
          for (let changed = true; changed;) { changed = false; for (const item of folders) if (descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
          const count = deployments.filter(item => descendants.has(organization.assignments?.[item.id])).length;
          const badge = add(summary, 'span', String(count), 'next-status-pill'); badge.title = 'Cronjobs in this folder and subfolders';
          const deleteButton=add(summary,'button','\u00d7','next-schedule-folder-remove');deleteButton.type='button';deleteButton.disabled=pending;folderButtons.push(deleteButton);deleteButton.title='Remove folder only; keep every cronjob';deleteButton.setAttribute('aria-label','Remove folder '+path(folder.id));deleteButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void removeFolder(folder.id);});
          details.addEventListener('toggle', () => details.open ? closed.delete(folder.id) : closed.add(folder.id));
          const children = add(details, 'div', '', 'next-schedule-folder-children');
          branch(folder.id, children, next);
          const cards = add(children, 'div', '', 'next-grid'); targets.set(folder.id, cards);
          if (!direct && !folders.some(item => item.parentId === folder.id)) add(cards, 'p', 'Empty folder', 'next-help');
        }
      }
      branch(null, container);
      const unfiled = add(container, 'section', '', 'next-schedule-unfiled'); const unfiledHeading=add(unfiled, 'h3', 'Unfiled');dropTarget(unfiledHeading,null);unfiledHeading.title='Drop here to move to the top level.';
      const cards = add(unfiled, 'div', '', 'next-grid'); targets.set('', cards);
      if (!deployments.some(item => !targets.has(organization.assignments?.[item.id]))) add(cards, 'p', 'No unfiled cronjobs.', 'next-help');
      return {
        target: task => targets.get(organization.assignments?.[task.id]) || cards,
        outlineControl(row,task){
          const handle=row.querySelector('summary');
          draggable(handle,{kind:'schedule',id:task.id});
          handle.title='Drag to a folder. Ctrl+Enter indents; Ctrl+Shift+Enter moves out one level.';
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
