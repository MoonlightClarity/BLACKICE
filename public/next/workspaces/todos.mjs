/** A user-managed outline. No task dispatch, model calls, or memory admission. */
export function createTodosWorkspace({mount,api,events,notify=()=>{}}){
 const doc=mount.ownerDocument;
 const el=(parent,tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;parent.append(n);return n;};
 mount.classList.add('todo-workspace');
 const head=el(mount,'header','','todo-header');el(head,'h1','To-do');el(head,'p','A simple outline for your tasks. Nothing runs automatically.','next-help');
 const tools=el(mount,'div','','todo-tools');
 const btn=(parent,label,fn)=>{const b=el(parent,'button',label);b.type='button';b.addEventListener('click',fn);return b;};
 const refreshButton=btn(tools,'Refresh',async()=>{await refresh();if(!destroyed&&!uncertain){selected=null;render();message('Refreshed. Select a task to edit its current title.');}});
 const summary=el(tools,'span','','next-help');
 const feedback=el(mount,'p','','todo-feedback');feedback.setAttribute('role','status');
 const addForm=el(mount,'form','','todo-add');
 const addLabel=el(addForm,'label','New task');const addInput=el(addLabel,'input');addInput.type='text';addInput.maxLength=250;addInput.setAttribute('aria-label','New task title');addInput.placeholder='Add a task…';
 const addButton=el(addForm,'button','Add task');addButton.type='submit';
 const rootButton=btn(addForm,'At top level',()=>{addParent=null;updateAdd();addInput.focus();});rootButton.hidden=true;
 const outline=el(mount,'section','','todo-outline');outline.setAttribute('aria-label','Task outline');
 const editor=el(mount,'section','','todo-editor');editor.hidden=true;el(editor,'h2','Selected task');
 const editForm=el(editor,'form','','todo-edit-form');const editLabel=el(editForm,'label','Title');const editInput=el(editLabel,'input');editInput.type='text';editInput.maxLength=250;editInput.setAttribute('aria-label','Selected task title');
 const saveButton=el(editForm,'button','Save title');saveButton.type='submit';
 const actions=el(editor,'div','','todo-actions');
 const childButton=btn(actions,'Add subtask',()=>{if(!selected)return;addParent=selected;collapsed.delete(selected);updateAdd();render();addInput.focus();});
 const upButton=btn(actions,'Move up',()=>void move(-1)),downButton=btn(actions,'Move down',()=>void move(1));
 const indentButton=btn(actions,'Indent',()=>{const item=current(),siblings=children(item?.parentId),i=siblings.findIndex(n=>n.id===selected);if(i>0)void mutate({action:'move',id:selected,parentId:siblings[i-1].id,position:children(siblings[i-1].id).length});});
 const outdentButton=btn(actions,'Outdent',()=>{const item=current(),parent=data.items.find(n=>n.id===item?.parentId);if(parent)void mutate({action:'move',id:selected,parentId:parent.parentId??null,position:children(parent.parentId).findIndex(n=>n.id===parent.id)+1});});
 const removeButton=btn(actions,'Delete…',()=>{if(!current()||busy)return;deleteId=selected;deleteRevision=data.revision;deleteText.textContent='Delete “'+current().title+'” and all its subtasks? This cannot be undone here.';dialog.showModal();});
 const dialog=el(mount,'dialog','','todo-delete-dialog');el(dialog,'h2','Delete task?');const deleteText=el(dialog,'p');const deleteActions=el(dialog,'div','','todo-actions');
 const cancelDelete=btn(deleteActions,'Cancel',()=>dialog.close());
 const confirmDelete=btn(deleteActions,'Delete task and subtasks',async()=>{const id=deleteId;if(busy||!id)return;const ok=await mutate({action:'remove',id,expectedRevision:deleteRevision});if(ok)dialog.close();});
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 const legacy=el(mount,'details','','todo-legacy');legacy.hidden=true;el(legacy,'summary','Previous Swarm records');
 el(legacy,'p','Your previous records are preserved separately. Viewing them does not start work or add them to memory.','next-help');
 const legacyButton=btn(legacy,'View preserved records',()=>void loadLegacy());const legacyBody=el(legacy,'div','','todo-legacy-records');
 let data={revision:0,items:[],legacyAvailable:false},selected=null,addParent=null,busy=false,uncertain=false,active=false,destroyed=false,epoch=0,deleteId=null,deleteRevision=0,editRevision=0,unsubscribe=null;
 const collapsed=new Set();
 const current=()=>data.items.find(n=>n.id===selected);
 const children=parentId=>data.items.filter(n=>(n.parentId??null)===(parentId??null)).sort((a,b)=>(a.position??0)-(b.position??0)||a.id.localeCompare(b.id));
 const message=(text,error=false)=>{feedback.textContent=text;feedback.dataset.error=String(error);};
 function updateAdd(){const p=data.items.find(n=>n.id===addParent);if(!p)addParent=null;addInput.placeholder=p?'Add under '+p.title:'Add a task…';rootButton.hidden=!p;addButton.textContent=p?'Add subtask':'Add task';}
 function controls(){
  refreshButton.disabled=busy;cancelDelete.disabled=busy;
  for(const b of [addButton,saveButton,childButton,removeButton,confirmDelete])b.disabled=busy||uncertain;
  for(const b of [addInput,rootButton,editInput])b.disabled=busy;
  for(const b of outline.querySelectorAll('button,input'))b.disabled=busy||uncertain;
  const item=current(),siblings=children(item?.parentId),index=siblings.findIndex(n=>n.id===selected);
  upButton.disabled=busy||uncertain||index<=0;downButton.disabled=busy||uncertain||index<0||index===siblings.length-1;indentButton.disabled=busy||uncertain||index<=0;outdentButton.disabled=busy||uncertain||!item?.parentId;
 }
 function render(){
  outline.replaceChildren();summary.textContent=data.items.filter(n=>n.completed).length+' of '+data.items.length+' completed';
  legacy.hidden=!data.legacyAvailable;
  const visited=new Set();
  function rows(parentId,depth=0){for(const item of children(parentId)){if(visited.has(item.id))continue;visited.add(item.id);
   const row=el(outline,'div','','todo-row');row.style.setProperty('--depth',Math.min(depth,12));row.dataset.id=item.id;row.dataset.selected=String(item.id===selected);row.dataset.completed=String(Boolean(item.completed));
   const nested=children(item.id),fold=btn(row,nested.length?(collapsed.has(item.id)?'▸':'▾'):'·',()=>{collapsed.has(item.id)?collapsed.delete(item.id):collapsed.add(item.id);render();});fold.className='todo-fold';fold.setAttribute('aria-label',(collapsed.has(item.id)?'Expand ':'Collapse ')+item.title);fold.setAttribute('aria-expanded',String(!collapsed.has(item.id)));fold.disabled=!nested.length||busy;
   const check=el(row,'input');check.type='checkbox';check.checked=Boolean(item.completed);check.setAttribute('aria-label','Complete '+item.title);check.addEventListener('change',()=>void mutate({action:'update',id:item.id,completed:check.checked}));
   const title=btn(row,item.title,()=>{selected=item.id;editRevision=data.revision;editInput.value=item.title;render();});title.className='todo-title';title.setAttribute('aria-pressed',String(item.id===selected));
   if(nested.length)el(row,'span',String(nested.length),'todo-child-count');
   if(!collapsed.has(item.id))rows(item.id,depth+1);
  }}
  rows(null);if(!data.items.length)el(outline,'p','No tasks yet. Add your first task above.','todo-empty');
  if(selected&&!current())selected=null;
  editor.hidden=!selected;updateAdd();controls();
 }
 async function refresh(){
  if(destroyed||busy)return;const token=++epoch;
  try{const result=await api('/api/todos');if(destroyed||token!==epoch)return;
   if(!Array.isArray(result.items)||!Number.isSafeInteger(result.revision))throw Error('Invalid task list response.');
   data=result;uncertain=false;render();
  }catch(error){if(!destroyed&&token===epoch)message('Could not load tasks: '+error.message,true);}
 }
 async function mutate(value){
  if(busy||uncertain||destroyed)return false;busy=true;epoch++;controls();message('Saving…');
  try{const result=await api('/api/todos','POST',{expectedRevision:data.revision,...value,requestId:crypto.randomUUID()});
   if(destroyed)return false;if(!Array.isArray(result.items)||!Number.isSafeInteger(result.revision))throw Error('The server did not confirm the saved task list.');
   data=result;editRevision=data.revision;if(value.action==='create'){selected=value.id;editInput.value=value.title;addInput.value='';if(value.parentId)collapsed.delete(value.parentId);}
   render();message('Saved.');return true;
  }catch(error){uncertain=true;if(!destroyed)message('Not confirmed: '+error.message+' Refresh before trying again; this action was not replayed.',true);return false;}
  finally{busy=false;if(!destroyed){render();}}
 }
 async function move(offset){const item=current(),siblings=children(item?.parentId),index=siblings.findIndex(n=>n.id===selected);if(index<0||index+offset<0||index+offset>=siblings.length)return;await mutate({action:'move',id:selected,parentId:item.parentId??null,position:index+offset});}
 async function loadLegacy(){legacyButton.disabled=true;try{const value=await api('/api/todos/legacy');if(!destroyed){legacyBody.textContent='';for(const project of value.projects||[]){el(legacyBody,'h3',project.name||'Untitled project');if(project.objective)el(legacyBody,'p',project.objective);const list=el(legacyBody,'ul');for(const item of project.items||[])el(list,'li',item.title+(item.phase?' ('+item.phase+')':''));}if(value.truncated)el(legacyBody,'p','Some older records are not shown in this bounded view.');}}catch(e){if(!destroyed)message('Could not read preserved records: '+e.message,true);}finally{legacyButton.disabled=false;}}
 addForm.addEventListener('submit',e=>{e.preventDefault();const title=addInput.value.trim();if(title)void mutate({action:'create',id:crypto.randomUUID(),parentId:addParent,position:children(addParent).length,title});});
 editForm.addEventListener('submit',e=>{e.preventDefault();const title=editInput.value.trim();if(title&&selected)void mutate({action:'update',id:selected,title,expectedRevision:editRevision});});
 return {enter(){active=true;if(!unsubscribe)unsubscribe=events?.subscribe(event=>{if(active&&event.type==='todos.updated'&&!busy)void refresh();});void refresh();},leave(){active=false;epoch++;},destroy(){destroyed=true;active=false;epoch++;unsubscribe?.();mount.replaceChildren();}};
}
