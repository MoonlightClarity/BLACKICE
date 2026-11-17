import {knowledgeFolderTree} from './knowledge-model.mjs';
import {createKnowledgeWorkspace} from './knowledge.mjs';

/** Skills are inspectable sources, not automatically admitted task instructions. */
export function createSkillsWorkspace({mount,api,events,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-skills-root"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Skills</h1><p>Inspect procedures available to BLACKICE. Saved procedures.</p></div>',
    '<div class="next-row"><button id="skills-refresh" type="button">Refresh catalog</button><button id="skills-organize" type="button">Organize saved skills</button><button id="skills-new" type="button" class="next-primary">New saved skill</button></div></header>',
    '<div class="next-skills-filters">',
    '<label class="next-label">Find a skill<input id="skills-query" class="next-field" type="search" maxlength="256" placeholder="Search titles, descriptions and saved content"></label>',
    '<label class="next-label">Source<select id="skills-source" class="next-field"><option value="all">All sources</option><option value="saved">Saved procedures</option></select></label>',
    '<label class="next-label">Working folder<input id="skills-cwd" class="next-field" spellcheck="false" placeholder="Default working folder"></label></div>',
    '<p id="skills-status" class="next-skills-status" role="status" aria-live="polite"></p>',
    '<p id="skills-source-status" class="next-skills-status"></p>',
    '<div class="next-skills-layout"><aside class="next-skills-aside" aria-label="Available skills">',
    '<ul id="skills-list" class="next-skills-list"></ul></aside>',
    '<section class="next-card next-skills-inspector" aria-label="Skill inspector">',
    '<header class="next-skills-inspector-head"><h2 id="skills-heading">Select a skill</h2><div class="next-row">',
    '<button id="skills-reload" type="button" hidden>Reload content</button>',
    '<button id="skills-edit" type="button" class="next-primary" hidden>Edit skill</button></div></header>',
    '<p id="skills-detail-status" class="next-skills-status" role="status" aria-live="polite">Choose a discovered or saved skill to read its full content.</p>',
    '<dl id="skills-meta" class="next-skills-meta"></dl><details id="skills-technical"><summary>Technical details</summary><dl id="skills-tech-meta" class="next-skills-meta"></dl></details><pre id="skills-content" class="next-skills-content" hidden></pre>',
    '</section></div></div></div>'
  ].join('');
  const catalogRoot=mount.querySelector('.next-skills-root');
  const editorMount=document.createElement('div');editorMount.className='next-skills-editor-shell';editorMount.hidden=true;mount.append(editorMount);
  const back=document.createElement('button');back.id='skills-back';back.type='button';back.textContent='Back to skills';const editorNav=document.createElement('nav');editorNav.className='next-skills-editor-nav';editorNav.setAttribute('aria-label','Skill editor navigation');editorNav.append(back);editorMount.append(editorNav);
  const editorBody=document.createElement('div');editorBody.className='next-skills-editor-body';editorMount.append(editorBody);
  const editor=createKnowledgeWorkspace({mount:editorBody,api,events,notify,kind:'skill',idPrefix:'skills-editor',onBusy:busy=>{back.disabled=busy;}});
  let editing=false;
  function editSkill(id){editorMount.classList.remove('next-skills-organizing');editing=true;catalogRoot.hidden=true;editorMount.hidden=false;editor.enter();editor.openSkillId(id);}
  mount.querySelector('#skills-organize').addEventListener('click',()=>{editing=true;catalogRoot.hidden=true;editorMount.hidden=false;editorMount.classList.add('next-skills-organizing');editor.enter();});
  back.addEventListener('click',()=>{if(back.disabled)return;editor.leave();editing=false;editorMount.hidden=true;catalogRoot.hidden=false;if(active)void load();});
  const diagnostics=document.createElement('details');diagnostics.className='next-skills-diagnostics';
  const summary=document.createElement('summary');summary.textContent='External skill diagnostics';diagnostics.append(summary);
  const explanation=document.createElement('p');explanation.textContent='Codex may discover other skills. These are disabled in BLACKICE sessions and are not available skills here.';diagnostics.append(explanation);
  const diagnosticButton=document.createElement('button');diagnosticButton.id='skills-external';diagnosticButton.type='button';diagnosticButton.textContent='Inspect external discoveries';diagnostics.append(diagnosticButton);
  const normalButton=document.createElement('button');normalButton.id='skills-normal';normalButton.type='button';normalButton.textContent='Show BLACKICE skills';diagnostics.append(normalButton);
  mount.querySelector('.next-panel-inner').insertBefore(diagnostics,mount.querySelector('.next-skills-layout'));
  let external=false;
  diagnosticButton.addEventListener('click',()=>{external=true;schedule({reset:true});});
  normalButton.addEventListener('click',()=>{external=false;schedule({reset:true});});
  const el=id=>mount.querySelector('#skills-'+id);
  const nodes=Object.fromEntries(['query','source','cwd','refresh','new','status','source-status','list','heading','reload','edit','detail-status','meta','tech-meta','technical','content'].map(id=>[id,el(id)]));
  let active=false,destroyed=false,unsubscribe=null,items=[],organization=null,folderError=null,selection=null,detail=null,queue=null;
  let listEpoch=0,detailEpoch=0,listController=null,detailController=null,refreshTimer=null;
  const failure=error=>String(error?.message||error||'Skill catalog unavailable.');
  const create=(parent,tag,label='',className='')=>{
    const element=document.createElement(tag);
    if(className)element.className=className;
    element.textContent=String(label);
    parent.append(element);return element;
  };
  const state=(element,message,error=false)=>{element.textContent=message;element.dataset.error=String(error);};
  const readable={
    source:{saved:'Saved procedure',codex:'Codex discovery'},
    loaded:{available_on_demand:'Available to read when needed',host_loaded:'Loaded by host (conditional use)',not_verified:'No per-turn loading evidence',not_loaded_in_blackice:'Excluded from BLACKICE native sessions'},
    applicability:{conditional:'Depends on task settings',in_scope:'In current folder scope',other_workspace:'Saved for another working folder',excluded_by_host:'Excluded by host'},
  };
  const label=(kind,value)=>readable[kind]?.[value]||value||'Unknown';
  const detailPath=id=>'/api/skills/'+encodeURIComponent(id)+'?cwd='+encodeURIComponent(nodes.cwd.value);
  const listPath=refresh=>'/api/skills?'+new URLSearchParams({source:external?'codex':nodes.source.value,query:nodes.query.value,cwd:nodes.cwd.value,refresh:String(refresh)});
  const isSelected=(epoch,id)=>active&&!destroyed&&detailEpoch===epoch&&selection===id;
  const closedFolders=new Set();
  function paintList(){
    nodes.list.replaceChildren();
    if(items.length===0)create(nodes.list,'li','No matching skills in this source and search.','next-skills-empty');
    const appendItem=(parent,item)=>{
      const row=create(parent,'li');
      const button=create(row,'button');
      button.type='button';button.dataset.skillId=item.id;button.setAttribute('aria-pressed',String(selection===item.id));
      button.title=item.title||'Unnamed skill';
      create(button,'strong',button.title);
      button.addEventListener('click',()=>void select(item.id));
    };
    if(external||!organization){for(const item of items)appendItem(nodes.list,item);return;}
    const saved=items.filter(item=>item.source==='saved'),builtins=items.filter(item=>item.source!=='saved');
    // Search reveals matching ancestry without changing the browsing preference.
    // Capture this render's mode: native toggle events may arrive after a newer render.
    const searching=Boolean(nodes.query.value.trim());
    const group=(parent,title,key,entries,children=[])=>{
      const row=create(parent,'li'),section=create(row,'details','','next-skills-folder');section.open=searching||!closedFolders.has(key);
      create(section,'summary',title+' ('+(entries.length+children.reduce((total,child)=>total+count(child),0))+')');
      section.addEventListener('toggle',()=>{if(searching)return;if(section.open)closedFolders.delete(key);else closedFolders.add(key);});
      const list=create(section,'ul','','next-skills-list');for(const child of children)draw(list,child);for(const item of entries)appendItem(list,item);return section;
    };
    const assigned=item=>{const id=organization.assignments?.[item.id.replace(/^saved:/,'')];return organization.folders?.some(folder=>folder.id===id)?id:'';};
    const count=folder=>saved.filter(item=>assigned(item)===folder.id).length+folder.children.reduce((total,child)=>total+count(child),0);
    const draw=(parent,folder)=>{if(count(folder))group(parent,folder.name,folder.id,saved.filter(item=>assigned(item)===folder.id),folder.children);};
    for(const folder of knowledgeFolderTree(organization.folders||[]))draw(nodes.list,folder);
    if(saved.some(item=>!assigned(item)))group(nodes.list,'Unfiled','unfiled',saved.filter(item=>!assigned(item)));
    if(builtins.length)group(nodes.list,'External discoveries','external',builtins);
  }
  function showDetailInfo(record){
    nodes.meta.replaceChildren();nodes['tech-meta'].replaceChildren();nodes.technical.hidden=false;
    const simple=[['Source',record.source==='saved'?'Saved procedure':'External discovery (disabled)'],['Applies to',record.appliesWhen||'Not specified']];
    for(const [field,value] of simple){create(nodes.meta,'dt',field);create(nodes.meta,'dd',value);}
    const fields=[
      ['Source',label('source',record.source)],
      ['Scope',record.scope==='workspace'?'Saved working folder':record.scope==='global'?'Global':record.scope==='first_party'?'First party':'Native discovery'],
      ['Source / folder',record.source==='saved'?(record.path?'Saved knowledge, folder scope: '+record.path:'Saved knowledge, global scope'):(record.path||'External discovery')],
      ['Loaded',label('loaded',record.loaded)],
      ['Enabled',record.source==='codex'?'No in BLACKICE sessions':record.enabled===true?'Yes':record.enabled===false?'No':'No per-skill enabled state'],
      ['Applicability',label('applicability',record.applicability)],
      ['Applies when',record.appliesWhen||'No specific applicability recorded'],
      ['Revision',record.revision==null?'Not versioned here':String(record.revision)],
      ['Use semantics',record.execution||'Read only'],
    ];
    for(const [field,value] of fields){
      create(nodes['tech-meta'],'dt',field);create(nodes['tech-meta'],'dd',value);
    }
    nodes.heading.textContent=record.title;
    nodes.content.textContent=record.content;
    nodes.content.hidden=false;
    nodes.reload.hidden=false;
    nodes.edit.hidden=record.source!=='saved';
    nodes.edit.disabled=false;
    state(nodes['detail-status'],record.source==='codex'?'Disabled in BLACKICE. Inspection does not enable it.':'Read the procedure below, or edit your saved copy.');
  }
  function clearDetail(message='Select a skill to inspect its source and content.'){
    detail=null;nodes.heading.textContent='Select a skill';
    nodes.meta.replaceChildren();nodes['tech-meta'].replaceChildren();nodes.technical.hidden=true;nodes.content.hidden=true;nodes.content.textContent='';
    nodes.reload.hidden=true;nodes.edit.hidden=true;state(nodes['detail-status'],message);
  }
  async function select(id,{force=false}={}){
    if(!active||destroyed)return;
    if(!force&&selection===id&&detail)return;
    selection=id;detail=null;paintList();
    const epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();
    clearDetail('Loading full skill content…');
    nodes.heading.textContent=items.find(item=>item.id===id)?.title||'Opening skill';
    nodes.reload.hidden=false;nodes.reload.disabled=true;
    try{
      const result=await api(detailPath(id),'GET',undefined,{signal:detailController.signal});
      if(!isSelected(epoch,id))return;
      if(!result||result.id!==id||typeof result.content!=='string')throw Error('The skill detail response is unreadable.');
      detail=result;showDetailInfo(result);
    }catch(error){
      if(isSelected(epoch,id)&&error.name!=='AbortError'){
        state(nodes['detail-status'],failure(error)+' Use Reload content to retry.',true);
        nodes.reload.hidden=false;nodes.reload.disabled=false;
      }
    }finally{if(isSelected(epoch,id))nodes.reload.disabled=false;}
  }
  async function load({refresh=false}={}){
    if(!active||destroyed)return;
    const epoch=++listEpoch;listController?.abort();listController=new AbortController();
    nodes.refresh.disabled=true;state(nodes.status,'Discovering available skills…');
    try{
      const result=await api(listPath(refresh),'GET',undefined,{signal:listController.signal});
      if(!active||epoch!==listEpoch)return;
      if(!result||!Array.isArray(result.entries))throw Error('The skill catalog response is unreadable.');
      items=result.entries;
      try{const folders=await api('/api/knowledge/folders','GET',undefined,{signal:listController.signal});if(!active||epoch!==listEpoch)return;organization=folders;folderError=null;}
      catch(error){if(!active||epoch!==listEpoch)return;if(error.name==='AbortError')throw error;organization=null;folderError=error;}
      if(!nodes.cwd.value&&typeof result.cwd==='string')nodes.cwd.placeholder='Default: '+result.cwd;
      paintList();
      state(nodes.status,items.length+(external?' disabled external discoveries':' skill'+(items.length===1?'':'s'))+' shown'+(result.truncated?' (catalog limit reached; narrow your search).':'.'));
      if(folderError)state(nodes.status,nodes.status.textContent+' Folders unavailable; showing an ungrouped catalog. '+failure(folderError),true);
      const native=result.sources?.codex;
      if(!external)state(nodes['source-status'],'Saved procedures.');
      else if(native?.status==='partial'||native?.status==='error'||native?.status==='unavailable')
        state(nodes['source-status'],'Codex discovery '+native.status+': '+(native.reason||'Not connected.'),native.status==='error');
      else if(native?.status==='available')state(nodes['source-status'],'Codex discovery available. Native entries remain disabled in BLACKICE sessions.');
      else state(nodes['source-status'],'Saved procedures.');
      if(selection){
        const entry=items.find(item=>item.id===selection);
        if(!entry){selection=null;detailEpoch++;detailController?.abort();clearDetail('Selected skill is not in the refreshed results.');paintList();}
        else if(detail&&entry.revision!==detail.revision)state(nodes['detail-status'],'This saved skill changed since you opened it. Reload content for the current revision.');
      }
    }catch(error){if(active&&epoch===listEpoch&&error.name!=='AbortError')state(nodes.status,failure(error)+' Refresh catalog to try again.',true);}
    finally{if(active&&epoch===listEpoch)nodes.refresh.disabled=false;}
  }
  function schedule({reset=false}={}){
    if(reset&&selection){selection=null;detailEpoch++;detailController?.abort();clearDetail();paintList();}
    clearTimeout(refreshTimer);
    if(active)refreshTimer=setTimeout(()=>void load(),220);
  }
  function onEvent(event){
    if(event.type!=='knowledge.updated'||!active)return;
    schedule();
  }
  nodes.query.addEventListener('input',()=>schedule({reset:true}));
  nodes.source.addEventListener('change',()=>{external=false;schedule({reset:true});});
  nodes.cwd.addEventListener('input',()=>schedule({reset:true}));
  nodes.refresh.addEventListener('click',()=>{clearTimeout(refreshTimer);void load({refresh:true});});
  nodes.reload.addEventListener('click',()=>{if(selection)void select(selection,{force:true});});
  nodes.edit.addEventListener('click',()=>{
    if(detail?.source!=='saved'||!selection||detail.id!==selection)return;
    editSkill(selection.slice(6));
  });
  nodes.new.addEventListener('click',()=>editSkill(null));
  return {
    openSkillId(id){editSkill(id);},
    enter(){
      if(active||destroyed)return;
      active=true;unsubscribe=events?.subscribe(onEvent);
      if(editing)editor.enter();else void load();
      // leave() invalidates and aborts pending detail reads. Resume a selected
      // but unsettled inspector from a fresh request; the old epoch cannot paint.
      if(selection&&!detail)void select(selection,{force:true});
    },
    leave(){editor.leave();active=false;unsubscribe?.();unsubscribe=null;clearTimeout(refreshTimer);listController?.abort();detailController?.abort();listEpoch++;detailEpoch++;nodes.refresh.disabled=false;},
    destroy(){this.leave();editor.destroy();destroyed=true;mount.innerHTML='';}
  };
}
