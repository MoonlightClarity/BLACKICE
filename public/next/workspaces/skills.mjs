/** Read-only release catalog. No persistent selection and no model activation. */
export function createSkillsWorkspace({mount,api}) {
  mount.innerHTML='<div class="next-panel next-skills-root"><div class="next-panel-inner"><header class="next-panel-head"><div><h1>Skills</h1><p>Release-owned methods, read only when relevant. The model cannot edit this catalog through managed tools.</p></div><button id="skills-refresh" type="button">Refresh catalog</button></header><label class="next-label">Find a skill<input id="skills-query" class="next-field" type="search" maxlength="256"></label><p id="skills-status" role="status" aria-live="polite"></p><div class="next-skills-layout"><aside aria-label="Available skills"><ul id="skills-list" class="next-skills-list"></ul></aside><section class="next-card next-skills-inspector" aria-label="Skill inspector"><h2 id="skills-heading">Select a skill</h2><p id="skills-detail-status" role="status" aria-live="polite">Reading here does not activate a skill in a conversation.</p><dl id="skills-meta" class="next-skills-meta"></dl><pre id="skills-content" class="next-skills-content" hidden></pre></section></div></div></div>';
  const el=id=>mount.querySelector('#skills-'+id), nodes=Object.fromEntries(['query','refresh','status','list','heading','detail-status','meta','content'].map(id=>[id,el(id)]));
  let active=false,destroyed=false,listEpoch=0,detailEpoch=0,listController,detailController,timer,selected=null,items=[];
  const add=(parent,tag,value)=>{const node=mount.ownerDocument.createElement(tag);node.textContent=String(value);parent.append(node);return node;};
  const clear=()=>{nodes.heading.textContent='Select a skill';nodes.meta.replaceChildren();nodes.content.textContent='';nodes.content.hidden=true;nodes['detail-status'].textContent='Reading here does not activate a skill in a conversation.';};
  function paint(){nodes.list.replaceChildren();if(!items.length)add(nodes.list,'li','No matching skills.');for(const item of items){const row=add(nodes.list,'li',''),button=add(row,'button',item.title);button.type='button';button.dataset.skillId=item.id;button.setAttribute('aria-pressed',String(selected===item.id));button.addEventListener('click',()=>void select(item.id));}}
  async function select(id){
    selected=id;const epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();clear();paint();nodes['detail-status'].textContent='Loading skill…';
    try{const entry=await api('/api/skills/'+encodeURIComponent(id),'GET',undefined,{signal:detailController.signal});if(!active||destroyed||epoch!==detailEpoch)return;
      nodes.heading.textContent=entry.title;for(const [label,value] of [['Source','Release-owned, read-only'],['When to use',entry.appliesWhen],['Scope',entry.scope],['Revision',entry.revision]]){add(nodes.meta,'dt',label);add(nodes.meta,'dd',value);}
      nodes.content.textContent=entry.content;nodes.content.hidden=false;nodes['detail-status'].textContent='Available on demand. This view is not evidence that a model used it.';
    }catch(error){if(active&&epoch===detailEpoch&&error.name!=='AbortError')nodes['detail-status'].textContent=error.message;}
  }
  async function load(){
    const epoch=++listEpoch;listController?.abort();listController=new AbortController();nodes.refresh.disabled=true;nodes.status.textContent='Loading catalog…';
    try{const result=await api('/api/skills?query='+encodeURIComponent(nodes.query.value),'GET',undefined,{signal:listController.signal});if(!active||destroyed||epoch!==listEpoch)return;
      if(!Array.isArray(result.entries))throw Error('Unreadable skill catalog.');items=result.entries;if(selected&&!items.some(item=>item.id===selected)){selected=null;++detailEpoch;detailController?.abort();clear();}paint();nodes.status.textContent=items.length+' skills available. Selection does not save instructions or change a conversation.';
    }catch(error){if(active&&epoch===listEpoch&&error.name!=='AbortError')nodes.status.textContent=error.message;}
    finally{if(active&&epoch===listEpoch)nodes.refresh.disabled=false;}
  }
  nodes.query.addEventListener('input',()=>{clearTimeout(timer);++listEpoch;listController?.abort();++detailEpoch;detailController?.abort();selected=null;clear();if(active)timer=setTimeout(()=>void load(),150);});
  nodes.refresh.addEventListener('click',()=>{clearTimeout(timer);if(active)void load();});
  return {
    openSkillId(id){if(active)void select(id);},
    enter(){if(active||destroyed)return;active=true;void load();if(selected)void select(selected);},
    leave(){active=false;clearTimeout(timer);++listEpoch;++detailEpoch;listController?.abort();detailController?.abort();nodes.refresh.disabled=false;},
    destroy(){this.leave();destroyed=true;mount.innerHTML='';}
  };
}
