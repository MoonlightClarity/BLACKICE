/** Skills are inspectable sources, not automatically admitted task instructions. */
export function createSkillsWorkspace({mount,api,events,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-skills-root"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Skills</h1><p>Inspect procedures available to BLACKICE. Discovery does not mean a skill is active in a turn.</p></div>',
    '<div class="next-row"><button id="skills-refresh" type="button">Refresh catalog</button><button id="skills-new" type="button" class="next-primary">New saved skill</button></div></header>',
    '<div class="next-skills-filters">',
    '<label class="next-label">Find a skill<input id="skills-query" class="next-field" type="search" maxlength="256" placeholder="Search titles, descriptions and saved content"></label>',
    '<label class="next-label">Source<select id="skills-source" class="next-field"><option value="all">All sources</option><option value="bundled">BLACKICE built-in</option><option value="saved">Saved procedures</option><option value="codex">Codex discovery</option></select></label>',
    '<label class="next-label">Working folder<input id="skills-cwd" class="next-field" spellcheck="false" placeholder="Default working folder"></label></div>',
    '<p id="skills-status" class="next-skills-status" role="status" aria-live="polite"></p>',
    '<p id="skills-source-status" class="next-skills-status"></p>',
    '<div class="next-skills-layout"><aside class="next-skills-aside" aria-label="Available skills">',
    '<ul id="skills-list" class="next-skills-list"></ul></aside>',
    '<section class="next-card next-skills-inspector" aria-label="Skill inspector">',
    '<header class="next-skills-inspector-head"><h2 id="skills-heading">Select a skill</h2><div class="next-row">',
    '<button id="skills-reload" type="button" hidden>Reload content</button>',
    '<button id="skills-edit" type="button" class="next-primary" hidden>Manage in Knowledge</button></div></header>',
    '<p id="skills-detail-status" class="next-skills-status" role="status" aria-live="polite">Choose a discovered or saved skill to read its full content.</p>',
    '<dl id="skills-meta" class="next-skills-meta"></dl><pre id="skills-content" class="next-skills-content" hidden></pre>',
    '</section></div></div></div>'
  ].join('');
  const el=id=>mount.querySelector('#skills-'+id);
  const nodes=Object.fromEntries(['query','source','cwd','refresh','new','status','source-status','list','heading','reload','edit','detail-status','meta','content'].map(id=>[id,el(id)]));
  let active=false,destroyed=false,unsubscribe=null,items=[],selection=null,detail=null,queue=null;
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
    source:{bundled:'BLACKICE bundled',saved:'Local saved knowledge',codex:'Codex discovery'},
    loaded:{host_loaded:'Loaded by host (conditional use)',not_verified:'No per-turn loading evidence',not_loaded_in_blackice:'Excluded from BLACKICE native sessions'},
    applicability:{conditional:'Depends on task settings',in_scope:'In current folder scope',other_workspace:'Saved for another working folder',excluded_by_host:'Excluded by host'},
  };
  const label=(kind,value)=>readable[kind]?.[value]||value||'Unknown';
  const detailPath=id=>'/api/skills/'+encodeURIComponent(id)+'?cwd='+encodeURIComponent(nodes.cwd.value);
  const listPath=refresh=>'/api/skills?'+new URLSearchParams({source:nodes.source.value,query:nodes.query.value,cwd:nodes.cwd.value,refresh:String(refresh)});
  const isSelected=(epoch,id)=>active&&!destroyed&&detailEpoch===epoch&&selection===id;
  function paintList(){
    nodes.list.replaceChildren();
    if(items.length===0)create(nodes.list,'li','No matching skills in this source and search.','next-skills-empty');
    for(const item of items){
      const row=create(nodes.list,'li');
      const button=create(row,'button');
      button.type='button';button.dataset.skillId=item.id;button.setAttribute('aria-pressed',String(selection===item.id));
      create(button,'strong',item.title||'Unnamed skill');
      if(item.summary)create(button,'span',item.summary,'next-skills-description');
      create(button,'small',label('source',item.source)+' · '+(item.scope==='workspace'?'Folder-scoped':item.scope==='global'?'Global':item.scope==='first_party'?'First party':'Native')+' · '+label('applicability',item.applicability));
      button.addEventListener('click',()=>void select(item.id));
    }
  }
  function showDetailInfo(record){
    nodes.meta.replaceChildren();
    const fields=[
      ['Source',label('source',record.source)],
      ['Scope',record.scope==='workspace'?'Saved working folder':record.scope==='global'?'Global':record.scope==='first_party'?'First party':'Native discovery'],
      ['Source / folder',record.source==='saved'?(record.path?'Saved knowledge, folder scope: '+record.path:'Saved knowledge, global scope'):(record.path||'Bundled with BLACKICE')],
      ['Loaded',label('loaded',record.loaded)],
      ['Enabled',record.source==='codex'?'No in BLACKICE sessions':record.enabled===true?'Yes':record.enabled===false?'No':'No per-skill enabled state'],
      ['Applicability',label('applicability',record.applicability)],
      ['Applies when',record.appliesWhen||'No specific applicability recorded'],
      ['Revision',record.revision==null?'Not versioned here':String(record.revision)],
      ['Use semantics',record.execution||'Read only'],
    ];
    for(const [field,value] of fields){
      create(nodes.meta,'dt',field);create(nodes.meta,'dd',value);
    }
    nodes.heading.textContent=record.title;
    nodes.content.textContent=record.content;
    nodes.content.hidden=false;
    nodes.reload.hidden=false;
    nodes.edit.hidden=record.source!=='saved';
    nodes.edit.disabled=false;
    state(nodes['detail-status'],'Full source content shown. This inspection does not enable or apply it.');
  }
  function clearDetail(message='Select a skill to inspect its source and content.'){
    detail=null;nodes.heading.textContent='Select a skill';
    nodes.meta.replaceChildren();nodes.content.hidden=true;nodes.content.textContent='';
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
      if(!nodes.cwd.value&&typeof result.cwd==='string')nodes.cwd.placeholder='Default: '+result.cwd;
      paintList();
      state(nodes.status,items.length+' skill'+(items.length===1?'':'s')+' shown'+(result.truncated?' (catalog limit reached; narrow your search).':'.'));
      const native=result.sources?.codex;
      if(native?.status==='partial'||native?.status==='error'||native?.status==='unavailable')
        state(nodes['source-status'],'Codex discovery '+native.status+': '+(native.reason||'Not connected.'),native.status==='error');
      else if(native?.status==='available')state(nodes['source-status'],'Codex discovery available. Native entries remain disabled in BLACKICE sessions.');
      else state(nodes['source-status'],'Showing saved and packaged skills. Codex discovery was not requested.');
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
  nodes.source.addEventListener('change',()=>schedule({reset:true}));
  nodes.cwd.addEventListener('input',()=>schedule({reset:true}));
  nodes.refresh.addEventListener('click',()=>{clearTimeout(refreshTimer);void load({refresh:true});});
  nodes.reload.addEventListener('click',()=>{if(selection)void select(selection,{force:true});});
  nodes.edit.addEventListener('click',()=>{
    if(detail?.source!=='saved'||!selection||detail.id!==selection)return;
    onNavigate?.('knowledge',{knowledgeId:selection.slice(6)});
  });
  nodes.new.addEventListener('click',()=>onNavigate?.('knowledge',{knowledgeId:null}));
  return {
    enter(){
      if(active||destroyed)return;
      active=true;unsubscribe=events?.subscribe(onEvent);
      void load();
      // leave() invalidates and aborts pending detail reads. Resume a selected
      // but unsettled inspector from a fresh request; the old epoch cannot paint.
      if(selection&&!detail)void select(selection,{force:true});
    },
    leave(){active=false;unsubscribe?.();unsubscribe=null;clearTimeout(refreshTimer);listController?.abort();detailController?.abort();listEpoch++;detailEpoch++;nodes.refresh.disabled=false;},
    destroy(){this.leave();destroyed=true;mount.innerHTML='';}
  };
}
