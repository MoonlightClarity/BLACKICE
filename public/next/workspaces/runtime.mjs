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
const ROOT=id=>'runtime:'+id;
const SKILL_GROUPS=new Map([
 ['data','Data & spreadsheets'],['documents','Documents'],['methods','General methods'],
 ['research','Research & web'],['web','Research & web'],['coding','Software & QA'],['accessibility','Software & QA'],
 ['diagram','Visual communication'],['charts','Visual communication'],['writing','Writing & handoffs']
]);
const SKILL_CATEGORIES=[...new Set(SKILL_GROUPS.values()),'Other skills'];
const GENERAL_SKILLS=new Set(['builtin-decomposition','builtin-task-grounding','builtin-structured-analysis']);
const skillCategory=item=>'category:'+(GENERAL_SKILLS.has(item.id)?'General methods':SKILL_GROUPS.get(item.tags?.[0])||'Other skills');
// The Markdown document remains authoritative. Only an explicit name edit
// changes its title; body-only edits must not rewrite front matter or headings.
function skillWithTitle(body,title){
 let offset=0,fence;
 for(const line of body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[]){
  const bare=line.replace(/[\r\n]+$/,'');
  const marker=/^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(bare);
  if(fence){
   if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=undefined;
  }else if(marker)fence=marker[1];
  else if(/^ {0,3}#[ \t]+.+/.test(bare)){
   const prefix=/^ {0,3}#[ \t]+/.exec(bare)[0];
   return body.slice(0,offset)+prefix+title+body.slice(offset+bare.length);
  }
  offset+=line.length;
 }
 const front=/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
 const at=front?.[0].length??(body.startsWith('\uFEFF')?1:0),eol=body.includes('\r\n')?'\r\n':'\n';
 return body.slice(0,at)+(at&& !/[\r\n]$/.test(body.slice(0,at))?eol:'')+'# '+title+eol+eol+body.slice(at);
}
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
   <p id="runtime-organization-status" class="next-help" role="status"></p>
   <form id="runtime-category-form" class="runtime-category-form" hidden>
    <label class="next-label" for="runtime-category-name">New subcategory in <span id="runtime-category-parent"></span>
     <input id="runtime-category-name" class="next-field" maxlength="60" required></label>
    <div class="next-skills-actions"><button id="runtime-category-create" type="submit">Create</button>
     <button id="runtime-category-cancel" type="button">Cancel</button></div>
   </form>
   <ul id="runtime-tree" class="next-skills-list"></ul>
   <details id="runtime-removed-categories" hidden><summary>Restore deleted categories</summary><ul id="runtime-removed-list" class="next-skills-list"></ul></details>
  </aside><section class="next-card next-skills-inspector" aria-label="Runtime item">
   <h2 id="runtime-heading">Select a runtime item</h2>
   <p id="runtime-source" class="next-help"></p>
   <div id="runtime-placement" class="runtime-placement" hidden>
    <label class="next-label" for="runtime-move-target">Category<select id="runtime-move-target" class="next-field"></select></label>
    <button id="runtime-move" type="button">Move</button>
   </div>
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
  core=null,coreDefault=null,current=null,editDrafts=new Map(),confirmation=null,
  organization=null,organizationReady=false,organizing=false,categoryParent=null,orgEpoch=0;
 const expanded=new Set(GROUPS.filter(([id])=>id!=='deleted').map(([id])=>ROOT(id)));
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
   ...(item?.kind==='skill'?{revision:current.skillRevision}:{})
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
  const locked=saving||loading||organizing||!organizationReady;
  for(const button of mount.querySelectorAll('[data-add-category],[data-delete-category],[data-restore-category]'))button.disabled=locked;
  $('category-create').disabled=locked||!categoryParent||!treeModel().nodes.has(categoryParent);
  $('category-name').disabled=organizing;
  $('category-cancel').disabled=organizing;
  $('move-target').disabled=locked;
  $('move').disabled=locked||!current||current.item.deleted;
  $('refresh').disabled=saving||organizing;
 }
 function treeModel(){
  const nodes=new Map(),roots=[];
  const add=(id,title,parent,type)=>{
   const node={id,title,parent,type,children:[],items:[]};nodes.set(id,node);
   if(parent===null)roots.push(node);return node;
  };
  for(const [id,title] of GROUPS)add(ROOT(id),title,null,'root');
  const removed=new Set(organization?.removedCategories||[]);
  for(const title of SKILL_CATEGORIES){
   const id='category:'+title;
   if(!removed.has(id))add(id,title,ROOT('skill'),'shipped');
  }
  for(const folder of organization?.folders||[])add(folder.id,folder.name,folder.parentId??ROOT('skill'),'custom');
  for(const node of nodes.values())if(node.parent!==null){
   const parent=nodes.get(node.parent)||nodes.get(ROOT('skill'));
   parent.children.push(node);
  }
  const place=item=>{
   if(item.deleted)return ROOT('deleted');
   const defaultId=item.kind==='skill'?skillCategory(item):ROOT(item.group);
   const explicit=item.kind==='skill'?organization?.assignments?.[item.id]:organization?.runtimeAssignments?.[item.key];
   return nodes.has(explicit)?explicit:nodes.has(defaultId)?defaultId:'category:Other skills';
  };
  for(const item of items)(nodes.get(place(item))||nodes.get(ROOT(item.group)))?.items.push(item);
  return {nodes,roots,place};
 }
 function reveal(item){
  const {nodes,place}=treeModel();
  for(let node=nodes.get(place(item));node;node=nodes.get(node.parent))expanded.add(node.id);
 }
 function paint(){
  const query=$('search').value.trim().toLowerCase(),tree=$('tree'),{roots}=treeModel();
  tree.replaceChildren();
  const matches=item=>!query||(item.name+' '+item.id+' '+(item.description||'')).toLowerCase().includes(query);
  const render=(parent,node,ancestorMatched=false)=>{
   const selfMatched=ancestorMatched||Boolean(query&&node.title.toLowerCase().includes(query));
   const documents=node.items.filter(item=>selfMatched||matches(item));
   const visibleCount=branch=>branch.items.filter(item=>selfMatched||matches(item)).length+
     branch.children.reduce((n,child)=>n+visibleCount(child),0);
   const count=branch=>branch.items.length+branch.children.reduce((n,child)=>n+count(child),0);
   const branch=mount.ownerDocument.createElement('li');branch.className='skills-folder-branch runtime-category';
   branch.dataset.runtimeCategory=node.id;
   const header=nice(branch,'div','','runtime-category-header');
   const toggle=nice(header,'button',node.title+' ('+count(node)+')','runtime-category-toggle');
   toggle.type='button';toggle.dataset.toggleCategory=node.id;
   const open=Boolean(query)||expanded.has(node.id);
   toggle.setAttribute('aria-expanded',String(open));
   toggle.addEventListener('click',()=>{if(query)return;expanded.has(node.id)?expanded.delete(node.id):expanded.add(node.id);paint();});
   if(node.id!==ROOT('deleted')){
    const add=nice(header,'button','+','runtime-category-action');add.type='button';add.dataset.addCategory=node.id;
    add.setAttribute('aria-label','Add subcategory to '+node.title);add.title='Add subcategory';
    add.addEventListener('click',()=>beginCategory(node));
    if(node.type==='custom'||node.type==='shipped'&&node.id!=='category:Other skills'){
     const remove=nice(header,'button','−','runtime-category-action');remove.type='button';remove.dataset.deleteCategory=node.id;
     remove.setAttribute('aria-label','Delete category '+node.title+' (keep contents)');remove.title='Delete category; keep contents';
     remove.addEventListener('click',()=>void removeCategory(node));
    }
   }
   const children=nice(branch,'ul','','next-skills-list runtime-category-children');
   children.hidden=!open;
   for(const child of node.children)render(children,child,selfMatched);
   for(const item of documents){
    const li=nice(children,'li','','skills-document-line');
    const button=nice(li,'button',item.name,'skills-document-row');
    button.type='button';button.dataset.runtimeItem=item.key;button.setAttribute('aria-pressed',String(selected===item.key));
    button.addEventListener('click',()=>void select(item.key));
    nice(li,'span',item.deleted?'Deleted':item.enabled===false?'Disabled':item.kind==='skill'?'Skill':item.kind==='tool'?'Tool':'Layer','runtime-kind');
   }
   if(query&&!selfMatched&&!children.children.length&&!visibleCount(node))return;
   parent.append(branch);
  };
  for(const root of roots)render(tree,root);
  if(!tree.children.length)nice(tree,'li','No matching runtime items.','next-help');
  const removed=$('removed-list');removed.replaceChildren();
  for(const id of organization?.removedCategories||[]){
   const li=nice(removed,'li','','runtime-category-header');nice(li,'span',id.slice(9));
   const restore=nice(li,'button','Restore');restore.type='button';restore.dataset.restoreCategory=id;
   restore.addEventListener('click',()=>void organize({action:'restore_category',category:id},'Category restored.'));
  }
  $('removed-categories').hidden=!removed.children.length;
  controls();
 }
 function refreshPlacement(){
  const item=current?.item,placement=$('placement'),select=$('move-target');
  placement.hidden=!item||item.deleted;
  select.replaceChildren();
  if(!item||item.deleted)return;
  const {roots,place}=treeModel();
  const auto=nice(select,'option','Automatic category');auto.value='';
  function option(node,parents=[]){
   if(node.id===ROOT('deleted'))return;
   const names=[...parents,node.title],row=nice(select,'option',names.join(' / '));row.value=node.id;
   for(const child of node.children)option(child,names);
  }
  for(const root of roots)option(root);
  select.value=place(item);
 }
 function beginCategory(node){
  if(!organizationReady||organizing||saving||loading)return;
  categoryParent=node.id;$('category-parent').textContent=node.title;
  $('category-form').hidden=false;$('category-name').value='';controls();$('category-name').focus?.();
 }
 async function organize(operation,message){
  if(!organizationReady||organizing||saving||loading)return false;
  organizing=true;controls();const ticket=++orgEpoch;
  $('organization-status').textContent='Saving category organization…';
  try{
   const saved=await api('/api/runtime/organization','POST',{...operation,expectedRevision:organization.revision});
   if(destroyed||ticket!==orgEpoch)return false;
   organization=saved;
   $('organization-status').textContent=message;organizing=false;
   if(active){paint();refreshPlacement();controls();}
   return true;
  }catch(error){
   if(destroyed||ticket!==orgEpoch)return false;
   organizing=false;organizationReady=false;
   $('organization-status').textContent=err(error)+' Refresh before another category change. No instruction or skill content was changed.';
   if(active){paint();controls();}
   return false;
  }
 }
 async function removeCategory(node){
  const operation=node.type==='shipped'?{action:'remove_category',category:node.id}:{action:'remove',id:node.id,relocateContents:true};
  await organize(operation,'Category deleted. Items and child categories were kept.');
 }
 function hideEditors(){
  $('editor').hidden=true;$('new-form').hidden=true;$('delete-confirm').hidden=true;$('placement').hidden=true;
  confirmation=null;current=null;
 }
 const find=item=>item?.kind==='skill'?'/api/skills/'+enc(item.id):'';
 async function select(key){
  if(saving||loading){pendingSelection=key;return;}
  if(current&&changed())draft();
  selected=key;
  const item=selectedItem();
  $('new-form').hidden=true;$('delete-confirm').hidden=true;confirmation=null;
  if(item)reveal(item);
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
  const values=editDrafts.get(key)||snapshot;
  current={item,snapshot,skillRevision:values.revision};
  $('title').value=values.title;$('description').value=values.description;$('source-label').value=values.sourceLabel;
  $('role').value=values.role;$('order').value=String(values.order);$('enabled').checked=values.enabled;
  $('text').value=values.text;$('schema').value=values.schema;refreshPlacement();
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
     revision:skill.revision,loaded:skill.loaded,tags:skill.tags||[]});
   }
  }
  return rows;
 }
 async function load(){
  if(!active||saving||organizing||destroyed)return;
  const token=++epoch;loading=true;controls();status('Loading current runtime instructions and tools…');
  try{
   const [layer,tool,skill,deleted,ownerCore,ownerCoreDefault,org]=await Promise.all([
    api('/api/execution-layers','GET'),
    api('/api/tool-descriptions','GET'),
    api('/api/skills','GET'),
    api('/api/skills?source=deleted','GET'),
    api('/api/instructions/core','GET'),
    api('/api/instructions/core/versions/0','GET'),
    api('/api/runtime/organization','GET').then(value=>({value}),error=>({error}))
   ]);
   if(!active||destroyed||token!==epoch)return;
   core=ownerCore;coreDefault=ownerCoreDefault;
   if(org.value){organization=org.value;organizationReady=true;$('organization-status').textContent='';}
   else{organizationReady=false;$('organization-status').textContent='Category organization unavailable: '+err(org.error)+'. Runtime items can still be edited.';}
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
    const body=values.title!==savedSnapshot.title?skillWithTitle(values.text,values.title.trim()):values.text;
    await api('/api/skills/'+enc(item.id),'POST',{expectedRevision:values.revision,content:body});
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
 $('category-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const name=$('category-name').value.trim(),parent=categoryParent;
  if(!name||!parent||!treeModel().nodes.has(parent))return;
  const id='folder-'+globalThis.crypto.randomUUID();
  if(await organize({action:'create',id,name,parentId:parent===ROOT('skill')?null:parent},'Subcategory created.')){
   expanded.add(parent);expanded.add(id);categoryParent=null;$('category-form').hidden=true;paint();
  }
 });
 $('category-cancel').addEventListener('click',()=>{categoryParent=null;$('category-form').hidden=true;});
 $('move').addEventListener('click',async()=>{
  const item=current?.item;if(!item||item.deleted)return;
  const folderId=$('move-target').value||null;
  const operation=item.kind==='skill'?{action:'assign',skillId:item.id,folderId}:{action:'assign_runtime',itemKey:item.key,folderId};
  if(await organize(operation,'Item moved. Runtime behavior is unchanged.')){reveal(item);paint();refreshPlacement();}
 });
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
  const kind=$('new-kind').value,title=$('new-title').value.trim(),text=$('new-text').value,role=$('new-role').value;
  const description=$('new-description').value,sourceLabel=$('new-source-label').value.trim();
  const order=Number($('new-order').value||0),enabled=$('new-enabled').checked;
  if(!title||!text.trim())return;
  saving=true;controls();
  try{
   if(kind==='layer'){
    const response=await api('/api/execution-layers','PUT',{action:'add',title,role,text,description,sourceLabel,order,enabled,expectedRevision:revisions.layer});
    selected=key('layer',response.affected);
   }else{
    const result=await api('/api/skills','POST',{content:skillWithTitle(text,title)});
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
 const beforeUnload=event=>{if(saving||organizing||changed()||editDrafts.size||(!$('category-form').hidden&&$('category-name').value.trim())||(!$('new-form').hidden&&($('new-title').value||$('new-text').value))){event.preventDefault();event.returnValue='';}};
 const hostWindow=window;
 hostWindow.addEventListener('beforeunload',beforeUnload);
 return{
  enter(){if(active||destroyed)return;active=true;void load();},
  leave(){active=false;epoch++;},
  destroy(){this.leave();destroyed=true;hostWindow.removeEventListener('beforeunload',beforeUnload);mount.replaceChildren();},
  openSkillId(id){const target=items.some(item=>item.key===key('deleted',id))?key('deleted',id):key('skill',id);this.selectItem(target.split(':')[0],id);},
  selectItem(kind,id){const target=key(kind,id);if(!active||loading||!items.length){pendingSelection=target;return;}void select(target);}
 };
}
