/** Editable current-task outline; no display-group/shared-memory import. */
export function createActionDirectory({frame,api,getRuns}){
 const doc=frame.ownerDocument,make=(tag,value='')=>{const n=doc.createElement(tag);n.textContent=value;return n;},button=(label,fn)=>{const b=make('button',label);b.type='button';b.addEventListener('click',fn);return b;};
 const launch=button('Action outline',()=>void open()),dialog=make('dialog'),heading=make('h2','Directory'),status=make('p'),tree=make('div'),input=make('input'),deps=make('input');
 launch.hidden=true;dialog.className='next-directory-inspector';dialog.setAttribute('aria-label','Action Directory');input.placeholder='Next action';input.setAttribute('aria-label','New action objective');deps.placeholder='Dependency IDs, optional';deps.setAttribute('aria-label','New action dependencies');
 const close=button('Close',()=>dialog.close()),refresh=button('Refresh',()=>void load()),add=button('Add action',()=>{if(!state||!input.value.trim())return;const id='action-'+Date.now().toString(36);void edit({action:'plan',actions:[...state.actions.map(({id,objective,dependsOn,reason,sourceRefs})=>({id,objective,dependsOn,...(reason?{reason}:{}),...(sourceRefs?{sourceRefs}:{} )})),{id,objective:input.value.trim(),dependsOn:deps.value.split(',').map(x=>x.trim()).filter(Boolean)}]},()=>{input.value='';deps.value='';saveDraft();});});
 dialog.append(heading,close,refresh,status,input,deps,add,tree);frame.append(dialog);(frame.querySelector('.next-chat-head-actions')||frame).append(launch);
 let selected=null,state=null,epoch=0,controller=null,busy=false;const drafts=new Map();
 const saveDraft=()=>{if(selected)drafts.set(selected.taskId||selected.id,{objective:input.value,dependencies:deps.value});};input.addEventListener('input',saveDraft);deps.addEventListener('input',saveDraft);
 const url=()=>'/api/conversations/'+encodeURIComponent(selected.id)+'/action-directory?taskId='+encodeURIComponent(selected.taskId||selected.id);
 function paint(){tree.replaceChildren();heading.textContent='Directory: '+state.objective;status.textContent='Revision '+state.revision+'. Claims are authored; receipts show observed work, not verified task completion.';
  for(const action of state.actions){const row=make('details'),title=make('summary',action.id+' · '+action.state+' · '+action.objective);row.open=action.id===state.focus;row.append(title,make('p','Depends on: '+(action.dependsOn.join(', ')||'none')));if(action.observation)row.append(make('p',action.observation.authority+': '+action.observation.claim));
   const note=make('input');note.setAttribute('aria-label','Reason to block '+action.id);note.placeholder='Reason to block or redirect';row.append(note,button('Focus',()=>void edit({action:'focus',id:action.id})),button('Block',()=>{if(!note.value.trim()){status.textContent='Enter the reason beside this action.';return;}void edit({action:'block',id:action.id,claim:note.value.trim()});}));
   const evidence=state.receipts.filter(r=>r.actionId===action.id);for(const r of evidence)row.append(make('p',r.id+' · '+r.tool+' · '+r.state+(r.success===false?' · returned failure':'')));tree.append(row);
  }
 }
 async function load(){if(!selected||!dialog.open)return;const token=++epoch;controller?.abort();controller=new AbortController();try{const result=await api(url(),'GET',undefined,{signal:controller.signal});if(token!==epoch||!dialog.open)return;if(result.taskId!==(selected.taskId||selected.id)||result.runId!==selected.id)throw Error('Directory task scope changed.');state=result.state;paint();}catch(error){if(token===epoch)status.textContent=error.message;}}
 async function edit(change,accepted){if(!state||busy)return;const token=epoch,revision=state.revision;busy=true;add.disabled=true;try{const result=await api(url(),'POST',{...change,revision});if(token!==epoch||!dialog.open)return;state=result.state;accepted?.();paint();}catch(error){if(token===epoch)status.textContent=error.message+' Your draft is unchanged. Refresh before retrying.';}finally{busy=false;add.disabled=false;}}
 async function open(){const run=getRuns()?.at(-1);if(!run)return;selected=run;state=null;const draft=drafts.get(run.taskId||run.id);input.value=draft?.objective||'';deps.value=draft?.dependencies||'';if(dialog.showModal)dialog.showModal();else dialog.open=true;await load();}
 function reset(){saveDraft();epoch++;controller?.abort();state=null;selected=null;tree.replaceChildren();}
 // Chromium queues close events. A close from the prior opening must not
 // abort the new selection or clear its outline after a quick reopen.
 dialog.addEventListener('close',()=>{if(!dialog.open)reset();});dialog.addEventListener('cancel',reset);
 return{open,refresh(id){launch.hidden=!id;if(dialog.open&&selected?.id!==id){dialog.close();reset();}},destroy(){reset();launch.remove();dialog.remove();}};
}
