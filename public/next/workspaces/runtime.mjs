import {renderInstructionAudit} from './instruction-audit.mjs';
const esc=value=>String(value??'');
const nice=(el,tag,value='',className='')=>{
 const node=el.ownerDocument.createElement(tag);node.textContent=esc(value);if(className)node.className=className;el.append(node);return node;
};
const enc=value=>encodeURIComponent(value);
const key=(kind,id)=>kind+':'+id;
const GROUPS=[
 ['system','System instructions'],
 ['planning','Planning & routing'],
 ['execution','Execution & browser'],
 ['tool','Internal tools'],
 ['skill','Skills & methods'],
 ['deleted','Deleted skills']
];
function layerGroup(id,role){
 if(id==='core'||id==='identity-tools')return'system';
 if(/planning|capabilit|preparation|goal|worker|assigned|directory|contract|outline/.test(id))return'planning';
 return'execution';
}
const err=error=>String(error?.message||error||'The change was not saved.');
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));

/** Skills-style editor for the authoritative model-facing Runtime configuration. */
export function createRuntimeWorkspace({mount,api,notify=()=>{}}){
 mount.innerHTML=`<div class="next-panel next-skills-root next-runtime-root"><div class="next-panel-inner">
  <header class="next-panel-head"><div><h1>Runtime</h1>
   <p class="next-help">Edit active system instructions, planning and routing, internal tools, and skills. No global Developer/System override.</p></div>
   <div class="next-skills-actions"><button id="runtime-add" type="button">Add</button><button id="runtime-refresh" type="button">Refresh</button></div>
  </header>
  <label class="next-label">Find an instruction, tool, or skill<input id="runtime-search" class="next-field" type="search" maxlength="256"></label>
  <p id="runtime-status" role="status" aria-live="polite"></p>
  <div class="next-skills-layout"><aside class="next-skills-aside" aria-label="Runtime sources">
   <ul id="runtime-tree" class="next-skills-list"></ul>
  </aside><section class="next-card next-skills-inspector" aria-label="Runtime item">
   <h2 id="runtime-heading">Select a runtime item</h2>
   <p id="runtime-source" class="next-help"></p>
   <form id="runtime-editor" class="next-stack" hidden>
    <label class="next-label" for="runtime-title">Name<input id="runtime-title" class="next-field" maxlength="200"></label>
    <label class="next-label" for="runtime-description">Description<textarea id="runtime-description" class="next-field" rows="2" maxlength="1200"></textarea></label>
    <label class="next-label" id="runtime-source-label-row" for="runtime-source-label">Source label<input id="runtime-source-label" class="next-field" maxlength="300"></label>
    <div id="runtime-model-fields" class="runtime-form-columns">
     <label class="next-label" for="runtime-role">Model instruction role<select id="runtime-role" class="next-field"><option value="developer">System / developer</option><option value="prompt">Prompt</option></select></label>
     <label class="next-label" for="runtime-order">List order<input type="number" id="runtime-order" class="next-field" min="-10000" max="10000" step="1"></label>
    </div>
    <label id="runtime-enabled-row" class="runtime-check"><input id="runtime-enabled" type="checkbox"> Enabled for future turns</label>
    <label class="next-label" for="runtime-text">Current model-facing text<textarea id="runtime-text" class="next-field" rows="17" spellcheck="false" maxlength="200000"></textarea></label>
    <label class="next-label" id="runtime-schema-row" for="runtime-schema" hidden>Model-visible input schema (JSON)<span class="next-help">Edit descriptions, titles, examples and defaults. Executable actions, required fields and validation rules come from the tool handler and cannot be changed through text alone.</span><textarea id="runtime-schema" class="next-field" rows="9" spellcheck="false" maxlength="100000"></textarea></label>
    <details id="runtime-original"><summary>View shipped/observed original</summary><pre id="runtime-default"></pre></details>
    <div class="next-skills-actions"><button type="submit" id="runtime-save" class="next-primary">Save changes</button>
     <button type="button" id="runtime-delete">Delete / disable</button>
     <button type="button" id="runtime-restore">Restore</button><button type="button" id="runtime-discard">Discard draft</button></div>
    <p id="runtime-save-status" role="status"></p>
   </form>
   <section id="runtime-delete-confirm" class="skills-delete-confirm" role="alertdialog" hidden>
    <p id="runtime-delete-message"></p><button type="button" id="runtime-delete-yes">Confirm</button>
    <button type="button" id="runtime-delete-cancel">Cancel</button></section>
   <form id="runtime-new-form" class="next-stack" hidden>
    <label class="next-label">New item type<select id="runtime-new-kind" class="next-field">
     <option value="layer">Instruction layer</option><option value="skill">Skill</option></select></label>
    <label class="next-label">Name<input id="runtime-new-title" class="next-field" maxlength="120" required></label>
    <label class="next-label">Description<textarea id="runtime-new-description" class="next-field" rows="2" maxlength="1200"></textarea></label>
    <label class="next-label">Source label<input id="runtime-new-source-label" class="next-field" maxlength="300" value="Owner-added execution layer"></label>
    <label class="next-label">Role<select id="runtime-new-role" class="next-field"><option value="developer">System / developer</option><option value="prompt">Prompt</option></select></label>
    <label class="next-label">List order<input id="runtime-new-order" type="number" class="next-field" value="0" min="-10000" max="10000"></label>
    <label class="runtime-check"><input id="runtime-new-enabled" type="checkbox" checked> Enabled</label>
    <label class="next-label">Instructions<textarea id="runtime-new-text" class="next-field" rows="12" maxlength="200000" required></textarea></label>
    <div class="next-skills-actions"><button id="runtime-create" class="next-primary">Create</button><button id="runtime-new-cancel" type="button">Cancel</button></div>
   </form>
  </section></div>
  <details id="runtime-audits"><summary>Historical execution audit (read only)</summary>
   <p class="next-help">Saved execution instruction snapshots are immutable. Changes here affect only future turns.</p>
   <div class="next-row"><input id="runtime-run-id" class="next-field" placeholder="Saved run ID" maxlength="120">
   <button type="button" id="runtime-inspect">Inspect execution</button></div>
   <p id="runtime-audit-status" role="status"></p><div id="runtime-audit-content" class="next-instruction-content"></div>
  </details>
 </div></div>`;
 const $=id=>mount.querySelector('#runtime-'+id);
 let active=false,destroyed=false,loading=false,saving=false,epoch=0,selected=null,pendingSelection=null,items=[],revisions={layer:0,tool:0},
  core=null,coreDefault=null,current=null,editDrafts=new Map(),confirmation=null;
 const selectedItem=()=>items.find(item=>item.key===selected);
 const changed=()=>{
  if(!current)return false;
  return JSON.stringify(readFields())!==JSON.stringify(current.snapshot);
 };
 function readFields(){
  const item=current?.item;
  return{
   title:$('title').value,description:$('description').value,sourceLabel:$('source-label').value,role:$('role').value,
   order:Number($('order').value||0),enabled:$('enabled').checked,
   text:$('text').value,schema:$('schema').value,
   ...(item?.kind==='skill'?{revision:item.revision}:{})
  };
 }
 const status=(message,save=false)=>{$(save?'save-status':'status').textContent=message;};
 const draft=()=>{if(!current)return;if(changed())editDrafts.set(current.item.key,readFields());
   else editDrafts.delete(current.item.key);};
 function controls(){
  for(const row of mount.querySelectorAll('button,input,textarea,select'))
   if(row.closest('#runtime-editor')||row.closest('#runtime-new-form'))
    row.disabled=saving||loading;
  $('role').disabled=saving||loading||current?.item?.kind!=='layer';
  $('text').disabled=saving||loading||Boolean(current?.item?.deleted);
  $('save').disabled=saving||loading||!current||current.item.deleted||!changed();
  $('delete').disabled=saving||loading||!current||current.item.deleted||
   (current.item.kind==='tool'&&!current.item.enabled)||
   (current.item.kind==='layer'&&!current.item.enabled&&!current.item.custom);
  $('restore').disabled=saving||loading||!current||
   (current.item.kind==='skill'?!current.item.deleted:current.item.kind==='layer'?
     current.item.custom?current.item.enabled:current.item.id==='core'?
     (core?.content===coreDefault?.content&&current.item.mode==='default'):
     !current.item.overridden:!current.item.overridden);
  $('delete-yes').disabled=$('delete-cancel').disabled=saving;
 }
 function paint(){
  const query=$('search').value.trim().toLowerCase(),tree=$('tree');
  tree.replaceChildren();
  for(const [group,title] of GROUPS){
   const shown=items.filter(item=>item.group===group
    &&(!query||(item.name+' '+item.id+' '+(item.description||'')).toLowerCase().includes(query)));
   if(!shown.length)continue;
   const branch=nice(tree,'li');branch.className='skills-folder-branch runtime-category';
   const header=nice(branch,'h3',title,'runtime-category-title');
   const children=nice(branch,'ul','','next-skills-list');
   for(const item of shown){
    const li=nice(children,'li','','skills-document-line');
    const button=nice(li,'button',item.name,'skills-document-row');
    button.type='button';button.dataset.runtimeItem=item.key;button.setAttribute('aria-pressed',String(selected===item.key));
    button.addEventListener('click',()=>void select(item.key));
    const tag=nice(li,'span',item.deleted?'Deleted':item.enabled===false?'Disabled':item.kind==='skill'?'Skill':item.kind==='tool'?'Tool':'Layer','runtime-kind');
   }
  }
  if(!tree.children.length)nice(tree,'li','No matching runtime items.','next-help');
 }
 function hideEditors(){
  $('editor').hidden=true;$('new-form').hidden=true;$('delete-confirm').hidden=true;
  confirmation=null;current=null;
 }
 const find=item=>item?.kind==='skill'?'/api/skills/'+enc(item.id):'';
 async function select(key){
  if(saving||loading){pendingSelection=key;return;}
  if(current&&changed())draft();
  selected=key;
  const item=selectedItem();
  $('new-form').hidden=true;$('delete-confirm').hidden=true;confirmation=null;
  paint();
  if(!item){hideEditors();$('heading').textContent='Select a runtime item';return;}
  const token=++epoch;
  $('heading').textContent=item.name;
  $('source').textContent=item.source||'';
  $('editor').hidden=false;
  let body=item.detail;
  if(item.kind==='skill'&&!item.deleted){
   loading=true;controls();
   try{body=await api(find(item),'GET');if(token!==epoch||!active)return;item.detail=body;}
   catch(error){if(token===epoch)status(err(error),true);loading=false;controls();
    if(pendingSelection){const next=pendingSelection;pendingSelection=null;await select(next);}
    return;}
   loading=false;
   if(pendingSelection){const next=pendingSelection;pendingSelection=null;await select(next);return;}
  }
  const tool=item.kind==='tool',skill=item.kind==='skill',layer=item.kind==='layer';
  $('model-fields').hidden=!layer;$('source-label-row').hidden=!layer;
  $('description').parentElement.hidden=tool||skill;
  $('role').disabled=!layer;
  $('enabled-row').hidden=skill;
  $('schema-row').hidden=!tool;
  $('title').readOnly=tool;
  $('description').readOnly=skill;
  $('text').maxLength=skill?200000:tool?12000:24000;
  $('text').disabled=item.deleted;
  const snapshot={
   title:item.name,description:item.description||'',sourceLabel:item.source||'',role:item.role||'developer',order:item.order??0,
   enabled:item.enabled!==false,text:skill?(body?.content||''):tool?item.description||'':item.text||'',
   schema:tool?JSON.stringify(item.inputSchema??{},null,2):'',...(skill?{revision:body?.revision??item.revision}:{})
  };
  current={item,snapshot};
  const values=editDrafts.get(key)||snapshot;
  $('title').value=values.title;$('description').value=values.description;$('source-label').value=values.sourceLabel;
  $('role').value=values.role;$('order').value=String(values.order);$('enabled').checked=values.enabled;
  $('text').value=values.text;$('schema').value=values.schema;
  $('default').textContent=skill?body?.content||'':tool?(item.defaultDescription||'')+'\n\n'+JSON.stringify(item.defaultSchema??{},null,2):item.defaultText??'No shipped text; the source is generated for each task.';
  $('source').textContent=(item.source||'')+' · '+(skill?'Skill revision '+(body?.revision??'?'):layer?'Layer configuration revision '+revisions.layer:'Tool catalog revision '+revisions.tool);
  $('delete').textContent=skill?'Delete skill':item.kind==='tool'?'Disable tool':'Delete / disable layer';
  $('restore').textContent=skill?'Restore skill':item.kind==='tool'?'Restore tool defaults':item.custom?'Enable custom layer':'Restore shipped layer';
  status(item.schemaWarning|| (item.deleted?'This skill is deleted. Restore it to edit.':
    item.kind==='layer'&&!item.enabled?'This instruction is disabled. Its saved text will be used if enabled.':
    'Editing this item changes the next model turn.'),true);
  controls();
 }
 function groupCatalog(data){
  const rows=[];
  for(const layer of data.layer.layers||[]){
   rows.push({kind:'layer',key:key('layer',layer.id),group:layerGroup(layer.id,layer.role),id:layer.id,
    name:layer.title,title:layer.title,description:layer.description,source:layer.source,origin:layer.origin,role:layer.role,order:layer.order,
    enabled:layer.enabled,mode:layer.mode,custom:layer.custom,overridden:layer.overridden,
    defaultText:layer.defaultText,
    text:layer.enabled?layer.text:layer.inactiveText??layer.text,
    sourceRevision:layer.sourceRevision,sourceHash:layer.sourceHash});
  }
  for(const tool of data.tool.tools||[]){
   rows.push({kind:'tool',key:key('tool',tool.name),group:'tool',id:tool.name,name:tool.name,
    description:tool.description,source:tool.source||'Host tool',enabled:tool.enabled,
    inputSchema:tool.inputSchema,defaultSchema:tool.defaultSchema,
    defaultDescription:tool.defaultDescription,overridden:tool.overridden,
    schemaWarning:tool.schemaWarning});
  }
  for(const [kind,catalog] of [['skill',data.skill],['deleted',data.deleted]]){
   for(const skill of catalog.entries||[]){
    rows.push({kind:'skill',key:key(kind,skill.id),group:kind==='deleted'?'deleted':'skill',id:skill.id,name:skill.title,
     description:skill.description||'',source:skill.source,enabled:kind!=='deleted',deleted:kind==='deleted',
     revision:skill.revision,loaded:skill.loaded});
   }
  }
  return rows;
 }
 async function load(){
  if(!active||saving||destroyed)return;
  const token=++epoch;loading=true;controls();status('Loading current runtime instructions and tools…');
  try{
   const [layer,tool,skill,deleted,ownerCore,ownerCoreDefault]=await Promise.all([
    api('/api/execution-layers','GET'),
    api('/api/tool-descriptions','GET'),
    api('/api/skills','GET'),
    api('/api/skills?source=deleted','GET'),
    api('/api/instructions/core','GET'),
    api('/api/instructions/core/versions/0','GET')
   ]);
   if(!active||destroyed||token!==epoch)return;
   core=ownerCore;coreDefault=ownerCoreDefault;
   const coreRow=layer.layers.find(item=>item.id==='core');
   if(coreRow){coreRow.defaultText=ownerCoreDefault.content;
    coreRow.sourceRevision=ownerCore.revision;coreRow.sourceHash=ownerCore.hash;}
   revisions={layer:layer.revision,tool:tool.revision};items=groupCatalog({layer,tool,skill,deleted});
   const requested=pendingSelection||selected;
   const chosen=requested&&items.some(item=>item.key===requested)?requested:items.find(item=>item.id==='core')?.key??items[0]?.key;
   pendingSelection=null;
   status(items.length+' runtime sources loaded. Edits affect future turns.');
   loading=false;paint();if(chosen)await select(chosen);else hideEditors();
  }catch(error){status(err(error));loading=false;controls();}
 }
 async function mutate(action){
  if(!current||saving||loading)return;
  const item=current.item,values=readFields(),savedSnapshot=current.snapshot;
  saving=true;controls();status('Saving '+item.name+'…',true);
  let partialCoreWrite=false;
  try{
   if(item.kind==='layer'){
    const fields=Object.fromEntries(['title','description','sourceLabel','role','order','enabled']
     .filter(field=>values[field]!==savedSnapshot[field]).map(field=>[field,values[field]]));
    if(item.id==='core'){
     if(values.text!==savedSnapshot.text){
      if(!core)throw Error('Current source revision unavailable.');
      // Legacy core layer replacements must not keep shadowing the canonical edit.
      if(item.mode==='replacement')fields.text=values.text;
      core=await api('/api/instructions/core','PUT',{content:values.text,expectedRevision:core.revision,expectedHash:core.hash});
      partialCoreWrite=true;
     }
    }else if(values.text!==savedSnapshot.text)fields.text=values.text;
    if(Object.keys(fields).length)
     await api('/api/execution-layers','PUT',{action:'update',id:item.id,fields,expectedRevision:revisions.layer});
    partialCoreWrite=false;
   }else if(item.kind==='tool'){
    const update={name:item.id,description:values.text,enabled:values.enabled,expectedRevision:revisions.tool};
    // A text-only edit must not pin the old model schema over future built-in changes.
    if(values.schema!==savedSnapshot.schema){
     try{update.inputSchema=JSON.parse(values.schema);}
     catch{throw Error('Input schema is not valid JSON. The draft was preserved.');}
    }
    await api('/api/tool-descriptions','PUT',update);
   }else if(item.kind==='skill'){
    let body=values.text;
    if(!/^\s*#[ \t]+/.test(body))body='# '+values.title.trim()+'\n\n'+body;
    else body=body.replace(/^(\s*#[ \t]+)[^\r\n]*/,(_,prefix)=>prefix+values.title.trim());
    await api('/api/skills/'+enc(item.id),'POST',{expectedRevision:item.detail?.revision??item.revision,content:body});
   }
   editDrafts.delete(item.key);current=null;notify('Runtime item saved.');saving=false;await load();
   if(pendingSelection){const target=pendingSelection;pendingSelection=null;await select(target);}
   status(item.name+' saved for future turns.',true);
  }catch(error){status(partialCoreWrite
   ?'Canonical system instructions were saved, but the effective layer update failed. The model may still receive an older instruction override. Reload and reconcile. The current draft was retained. '+err(error)
   :err(error)+' The current draft was retained.',true);saving=false;controls();}
 }
 async function destructive(){
  if(!confirmation||saving)return;
  const item=confirmation.item;
  confirmation=null;$('delete-confirm').hidden=true;saving=true;controls();
  try{
   if(item.kind==='skill'){
    if(item.deleted)await api('/api/skills/'+enc(item.id)+'/restore','POST',{expectedRevision:item.revision});
    else await api('/api/skills/'+enc(item.id),'DELETE',{expectedRevision:item.detail?.revision??item.revision});
   }else if(item.kind==='tool'){
    await api('/api/tool-descriptions','PUT',{name:item.id,action:'disable',expectedRevision:revisions.tool});
   }else await api('/api/execution-layers','PUT',{id:item.id,
    action:item.custom?'delete':'disable',expectedRevision:revisions.layer});
   editDrafts.delete(item.key);current=null;selected=null;saving=false;await load();
   status('Runtime item changed. No historical execution was rewritten.');
  }catch(error){status(err(error)+' Reload before retrying.');saving=false;controls();}
 }
 $('search').addEventListener('input',paint);
 $('refresh').addEventListener('click',()=>void load());
 $('editor').addEventListener('input',()=>{draft();controls();status('Unsaved changes.',true);});
 $('editor').addEventListener('change',()=>{draft();controls();});
 $('editor').addEventListener('submit',event=>{event.preventDefault();void mutate('save');});
 $('discard').addEventListener('click',()=>{if(current){editDrafts.delete(current.item.key);void select(current.item.key);}});
 $('delete').addEventListener('click',()=>{
  if(!current)return;
  confirmation={item:current.item};
  $('delete-message').textContent=current.item.kind==='skill'
   ?'Delete "'+current.item.name+'"? Future skill lookups will exclude it; restore remains possible.'
   :'Disable "'+current.item.name+'" for future model turns? This does not delete executable code or historical receipts.';
  $('delete-confirm').hidden=false;$('delete-cancel').focus?.();
 });
 $('delete-cancel').addEventListener('click',()=>{confirmation=null;$('delete-confirm').hidden=true;});
 $('delete-yes').addEventListener('click',()=>void destructive());
 $('restore').addEventListener('click',async()=>{
  if(!current||saving)return;const item=current.item;saving=true;controls();
  try{
   if(item.kind==='skill')await api('/api/skills/'+enc(item.id)+'/restore','POST',{expectedRevision:item.revision});
   else if(item.kind==='layer'){
    if(item.id==='core'&&core&&coreDefault&&core.content!==coreDefault.content)
     core=await api('/api/instructions/core','PUT',{content:coreDefault.content,expectedRevision:core.revision,expectedHash:core.hash});
    if(item.custom||item.overridden)
      await api('/api/execution-layers','PUT',{action:item.custom?'enable':'reset',id:item.id,expectedRevision:revisions.layer});
   }
   else await api('/api/tool-descriptions','PUT',{name:item.id,description:null,expectedRevision:revisions.tool});
   editDrafts.delete(item.key);current=null;saving=false;await load();status('Restored for future turns.');
  }catch(error){saving=false;controls();status(err(error),true);}
 });
 $('add').addEventListener('click',()=>{if(saving)return;hideEditors();selected=null;paint();$('heading').textContent='New Runtime item';$('new-form').hidden=false;$('new-title').focus?.();});
 $('new-cancel').addEventListener('click',()=>{ $('new-form').hidden=true;if(items[0])void select(items[0].key);});
 $('new-form').addEventListener('submit',async event=>{
  event.preventDefault();if(saving)return;
  const kind=$('new-kind').value,title=$('new-title').value.trim(),text=$('new-text').value.trim(),role=$('new-role').value;
  const description=$('new-description').value,sourceLabel=$('new-source-label').value.trim();
  const order=Number($('new-order').value||0),enabled=$('new-enabled').checked;
  if(!title||!text)return;
  saving=true;controls();
  try{
   if(kind==='layer'){
    const response=await api('/api/execution-layers','PUT',{action:'add',title,role,text,description,sourceLabel,order,enabled,expectedRevision:revisions.layer});
    selected=key('layer',response.affected);
   }else{
    const result=await api('/api/skills','POST',{content:'# '+title+'\n\n'+text});
    selected=key('skill',result.id);
   }
   saving=false;current=null;$('new-form').hidden=true;await load();status('New Runtime item created.');
  }catch(error){saving=false;controls();status(err(error));}
 });
 $('inspect').addEventListener('click',async()=>{
  const id=$('run-id').value.trim();if(!id)return;
  $('audit-status').textContent='Loading immutable saved instructions…';
  try{const payload=await api('/api/runs/'+enc(id)+'/instructions','GET');
   const output=$('audit-content');output.replaceChildren();
   for(const node of payload.nodes||[]){
    const section=nice(output,'section','','runtime-audit-node');
    nice(section,'h3',node.name||node.nodeId||'Execution node');
    const body=nice(section,'div');
    renderInstructionAudit(body,node.audit);
   }
   if(!(payload.nodes||[]).length)nice(output,'p','No captured instructions were available.');
   $('audit-status').textContent='Captured audit for '+id+' (read only).';
  }catch(error){$('audit-status').textContent=err(error);}
 });
 return{
  enter(){if(active||destroyed)return;active=true;void load();},
  leave(){active=false;epoch++;},
  destroy(){this.leave();destroyed=true;mount.replaceChildren();},
  selectItem(kind,id){selected=key(kind,id);if(active)void select(selected);}
 };
}
