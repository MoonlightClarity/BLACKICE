/** Editable current-task outline; no display-group/shared-memory import. */
export function createActionDirectory({frame,api,getRuns}){
 const doc=frame.ownerDocument,make=(tag,value='')=>{const n=doc.createElement(tag);n.textContent=value;return n;},button=(label,fn)=>{const b=make('button',label);b.type='button';b.addEventListener('click',fn);return b;};
 const launch=button('Action outline',()=>void open()),dialog=make('dialog'),heading=make('h2','Action outline'),status=make('p'),tree=make('div'),input=make('input'),deps=make('input'),header=make('header'),toolbar=make('div'),editor=make('div'),objective=make('p');
 launch.hidden=true;dialog.className='next-directory-inspector next-action-outline';dialog.setAttribute('aria-label','Action Directory');input.placeholder='Next action';input.setAttribute('aria-label','New action objective');deps.placeholder='Dependency IDs, optional';deps.setAttribute('aria-label','New action dependencies');
 const close=button('Close',()=>dialog.close()),refresh=button('Refresh',()=>void load()),add=button('Add action',()=>{if(!state||!input.value.trim())return;const id='action-'+Date.now().toString(36);void edit({action:'plan',actions:[...state.actions.map(({id,objective,dependsOn,reason,sourceRefs})=>({id,objective,dependsOn,...(reason?{reason}:{}),...(sourceRefs?{sourceRefs}:{} )})),{id,objective:input.value.trim(),dependsOn:deps.value.split(',').map(x=>x.trim()).filter(Boolean)}]},()=>{input.value='';deps.value='';saveDraft();});});
 header.className='action-outline-header';toolbar.className='action-outline-controls';editor.className='action-outline-editor';objective.className='action-outline-objective';status.className='action-outline-status';status.setAttribute('role','status');tree.className='action-outline-tree';toolbar.append(refresh,close);header.append(heading,toolbar);editor.append(input,deps,add);dialog.append(header,objective,status,editor,tree);frame.append(dialog);(frame.querySelector('.next-chat-head-actions')||frame).append(launch);
 let selected=null,state=null,epoch=0,controller=null,busy=false;const drafts=new Map();
 const saveDraft=()=>{if(selected)drafts.set(selected.taskId||selected.id,{objective:input.value,dependencies:deps.value});};input.addEventListener('input',saveDraft);deps.addEventListener('input',saveDraft);
 const url=()=>'/api/conversations/'+encodeURIComponent(selected.id)+'/action-directory?taskId='+encodeURIComponent(selected.taskId||selected.id);
 const isFailed=r=>r.success===false||r.threw===true;
 function paint(){
  const expanded=new Set([...tree.querySelectorAll('details')].filter(row=>row.open).map(row=>row.dataset.actionId));
  tree.replaceChildren();objective.textContent=state.objective;status.textContent='Revision '+state.revision+' \u00b7 Receipts record attempts, not proof of completion.';
  const appendAttempt=(parent,r)=>{const label=r.state==='unknown'?(r.threw?'Error; outcome unknown':'Outcome unknown'):isFailed(r)?(r.actionDispatched===false?'Failed before dispatch':'Failed'):'Returned';const receipt=make('li',[label,r.tool,r.code,r.id].filter(Boolean).join(' \u00b7 '));if(isFailed(r)||r.state==='unknown')receipt.dataset.warning='true';parent.append(receipt);};
  for(const action of state.actions){
   const dependencyBlock=state.dependencyBlocked?.find(item=>item.id===action.id),evidence=state.receipts.filter(r=>r.actionId===action.id||r.linkedByActionId===action.id);
   const row=make('details'),title=make('summary'),body=make('div'),tools=make('div'),note=make('input'),attempts=make('ul');
   row.className='action-outline-row';row.dataset.actionId=action.id;row.open=expanded.has(action.id)||action.id===state.focus;
   title.append(make('strong',action.objective));const stateLabel=make('small',dependencyBlock?'Waiting on blocked action':action.state==='observed'?'Recorded':action.state==='active'?'Current':action.state==='blocked'?'Blocked':'Pending');stateLabel.className='action-outline-chip';title.append(stateLabel);
   const failed=evidence.filter(r=>r.state!=='unknown'&&isFailed(r)).length,unknown=evidence.filter(r=>r.state==='unknown').length;
   if(failed||unknown){const warning=make('small',[failed&&failed+' failed',unknown&&unknown+' unresolved'].filter(Boolean).join(' \u00b7 '));warning.className='action-outline-chip';warning.dataset.warning='true';title.append(warning);}
   body.className='action-outline-detail';body.append(make('p','Action ID: '+action.id),make('p','Depends on: '+(action.dependsOn.join(', ')||'none')));
   if(dependencyBlock)body.append(make('p','Blocked by: '+dependencyBlock.blockedBy.join(', ')));
   if(action.observation)body.append(make('p',action.observation.authority+': '+action.observation.claim));
   if(evidence.length){attempts.className='action-outline-attempts';for(const r of evidence)appendAttempt(attempts,r);body.append(attempts);}
   const editable=action.state==='pending'||action.state==='active';
   {tools.className='action-outline-controls';note.setAttribute('aria-label','Reason to block '+action.id);note.placeholder='Reason this step cannot proceed';const focus=button('Set as current',()=>void edit({action:'focus',id:action.id}));focus.disabled=!editable||Boolean(dependencyBlock)||action.id===state.focus||(Array.isArray(state.ready)&&!state.ready.includes(action.id));tools.append(focus,note,button('Mark blocked',()=>{if(!note.value.trim()){status.textContent='Enter the reason beside this action.';return;}void edit({action:'block',id:action.id,claim:note.value.trim()});}));body.append(tools);}
   row.append(title,body);tree.append(row);
  }
  const unassigned=state.receipts.filter(r=>!r.actionId&&!r.linkedByActionId&&(isFailed(r)||r.state==='unknown'));
  if(unassigned.length){const aside=make('section'),attempts=make('ul');aside.className='action-outline-unassigned';attempts.className='action-outline-attempts';for(const r of unassigned)appendAttempt(attempts,r);aside.append(make('h3','Attempts not assigned to a step'),attempts);tree.append(aside);}
  if(!state.actions.length&&!unassigned.length){const empty=make('p','No actions recorded yet.');empty.className='action-outline-status';tree.append(empty);}
 }
 async function load(){if(!selected||!dialog.open)return;const token=++epoch;controller?.abort();controller=new AbortController();try{const result=await api(url(),'GET',undefined,{signal:controller.signal});if(token!==epoch||!dialog.open)return;if(result.taskId!==(selected.taskId||selected.id)||result.runId!==selected.id)throw Error('Directory task scope changed.');state=result.state;paint();}catch(error){if(token===epoch)status.textContent=error.message;}}
 async function edit(change,accepted){if(!state||busy)return;const token=epoch,revision=state.revision;busy=true;add.disabled=true;try{const result=await api(url(),'POST',{...change,revision});if(token!==epoch||!dialog.open)return;state=result.state;accepted?.();paint();}catch(error){if(token===epoch)status.textContent=error.message+' Your draft is unchanged. Refresh before retrying.';}finally{busy=false;add.disabled=false;}}
 async function open(){const run=getRuns()?.at(-1);if(!run)return;selected=run;state=null;objective.textContent='';status.textContent='Loading actions...';const draft=drafts.get(run.taskId||run.id);input.value=draft?.objective||'';deps.value=draft?.dependencies||'';if(dialog.showModal)dialog.showModal();else dialog.open=true;await load();}
 function reset(){saveDraft();epoch++;controller?.abort();state=null;selected=null;tree.replaceChildren();}
 // Chromium queues close events. A close from the prior opening must not
 // abort the new selection or clear its outline after a quick reopen.
 dialog.addEventListener('close',()=>{if(!dialog.open)reset();});dialog.addEventListener('cancel',reset);
 return{open,refresh(id){launch.hidden=!id;if(dialog.open&&selected?.id!==id){dialog.close();reset();}},destroy(){reset();launch.remove();dialog.remove();}};
}
