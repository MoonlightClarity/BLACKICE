/** On-demand diagnostic outline. Never supplies this projection to a model. */
export function createTurnReceiptsInspector({frame,api,getRuns,showLauncher=true,onBack}){
 const doc=frame.ownerDocument,make=(tag,value='')=>{const n=doc.createElement(tag);n.textContent=value;return n;};
 const launch=make('button','Turn receipts');launch.type='button';launch.hidden=true;launch.title='Inspect this task’s context provenance and retained action receipts';
 if(showLauncher)(frame.querySelector('.next-chat-head-actions')||frame).append(launch);
 const category=make('select'),search=make('input');category.setAttribute('aria-label','Receipt category');for(const [name,label] of [['context','Context'],['tools','Tool calls'],['failures','Tool failures'],['decisions','Outline decisions']]){const option=make('option',label);option.value=name;category.append(option);}category.value='context';search.type='search';search.maxLength=120;search.placeholder='Filter receipts';search.setAttribute('aria-label','Filter receipts');search.hidden=true;
 const dialog=make('dialog'),heading=make('h2','Turn receipts'),close=make('button','Close'),turn=make('select'),refresh=make('button','Refresh'),status=make('p'),tree=make('div'),more=make('button','More actions');
 dialog.className='next-directory-inspector';dialog.setAttribute('aria-label','Turn receipts');turn.setAttribute('aria-label','Receipt turn');status.setAttribute('role','status');for(const b of [close,refresh,more])b.type='button';more.hidden=true;
 dialog.append(heading,close);
 if(typeof onBack==='function'){const back=make('button','Back to Receipts');back.type='button';back.addEventListener('click',()=>{dialog.close();void onBack();});dialog.append(back);}
 const machine=make('div'),copyTrace=make('button','Copy trace JSON'),downloadTrace=make('button','Download trace JSON');
 machine.hidden=true;copyTrace.type=downloadTrace.type='button';machine.append(copyTrace,downloadTrace);
 dialog.append(turn,category,search,refresh,machine,status,tree,more);frame.append(dialog);
 let taskId=null,generation=0,controller=null,exportController=null,offset=null,revision=null,destroyed=false;
 const reset=()=>{generation++;controller?.abort();exportController?.abort();controller=null;offset=null;revision=null;tree.replaceChildren();more.hidden=true;machine.hidden=true;};
 function options(){const all=getRuns()||[],latest=all.at(-1);taskId=latest&&(latest.taskId||latest.id);return all.filter(r=>(r.taskId||r.id)===taskId);}
 function branch(parent,label,body){const detail=make('details'),summary=make('summary',label);detail.append(summary);if(body!==undefined)detail.append(make('pre',body));parent.append(detail);return detail;}
 async function load(append=false){
  if(destroyed||!dialog.open||!turn.value||!taskId)return;generation++;controller?.abort();controller=new AbortController();const token=generation,id=turn.value,root=taskId;
  if(!append){offset=null;revision=null;tree.replaceChildren();}more.hidden=true;status.textContent='Reading selected task records…';
  const query=new URLSearchParams({taskId:root,offset:String(append?offset||0:0),limit:'30',view:category.value,q:search.value});if(append&&revision)query.set('revision',revision);
  try{const result=await api('/api/conversations/'+encodeURIComponent(id)+'/receipts?'+query,'GET',undefined,{signal:controller.signal});if(destroyed||!dialog.open||token!==generation||taskId!==root||turn.value!==id)return;
   if(result.taskId!==root||result.runId!==id)throw Error('Turn receipts scope mismatch.');
   revision=result.revision;offset=result.nextOffset;machine.hidden=result.depth!=='maximal';status.textContent=result.coverage.reason+' Context: '+result.coverage.receiptAvailability+'.';
   if(!append){const task=branch(tree,'Task '+root);task.open=true;const selected=branch(task,'Turn '+id+(' · '+(result.depth==='maximal'?'Maximal':result.depth==='detailed'||result.enabled?'Detailed':'Basic')));selected.open=true;branch(selected,'Saved turn state',JSON.stringify(result.terminal||{},null,2));selected.append(make('p',result.terminal?.code?'Recorded cause: '+result.terminal.code:'No recorded cause.'));
    for(const receipt of category.value==='context'?result.receipts:[]){if(receipt.context.hostTools)branch(selected,'BLACKICE tool handler calls (not all provider actions)',JSON.stringify(receipt.context.hostTools,null,2));branch(selected,'Context prepared · '+receipt.nodeId,JSON.stringify(receipt.context,null,2));}
    const label=make('p','Source: turn receipts for the selected task. Prepared inputs and provider activity do not prove which sources the model used. A tool return does not prove task completion.');selected.append(label);}
   const host=tree.querySelector('details details')||tree;for(const action of result.actions)branch(host,(action.tool||action.action||action.kind)+' · '+action.state,JSON.stringify(action,null,2));more.hidden=offset===null;
  }catch(error){if(!destroyed&&dialog.open&&token===generation)status.textContent=error.message;}
 }
 async function open(){reset();const rows=options();turn.replaceChildren();for(const run of rows){const option=make('option',run.id);option.value=run.id;turn.append(option);}turn.value=rows.at(-1)?.id||'';if(!turn.value)return;if(typeof dialog.showModal==='function')dialog.showModal();else dialog.open=true;await load();}
 category.addEventListener('change',()=>{search.hidden=category.value==='context';search.value='';void load();});search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void load();}});
 async function exportMachine(format){
  if(destroyed||!dialog.open||machine.hidden||!turn.value||!taskId)return;
  exportController?.abort();const pending=new AbortController();exportController=pending;
  const id=turn.value,root=taskId,valid=()=>!pending.signal.aborted&&!destroyed&&dialog.open&&turn.value===id&&taskId===root;
  status.textContent='Preparing the Maximal trace.';
  try{
   const query=new URLSearchParams({taskId:root,view:'machine'});
   const value=await api('/api/conversations/'+encodeURIComponent(id)+'/receipts?'+query,'GET',undefined,{signal:pending.signal});
   if(!valid())return;
   if(value.taskId!==root||value.runId!==id)throw Error('Trace scope mismatch.');
   const serialized=JSON.stringify(value);
   if(format==='copy')await doc.defaultView.navigator.clipboard.writeText(serialized);
   else{
    const url=URL.createObjectURL(new Blob([serialized],{type:'application/json'})),link=make('a');
    link.href=url;link.download='blackice-turn-'+id+'-maximal.json';dialog.append(link);
    try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
   }
   if(valid())status.textContent=format==='copy'?'Maximal trace copied.':'Maximal trace download started.';
  }catch(error){if(valid())status.textContent=error.message||'Could not export the trace.';}
 }
 copyTrace.addEventListener('click',()=>void exportMachine('copy'));downloadTrace.addEventListener('click',()=>void exportMachine('download'));
 launch.addEventListener('click',()=>void open());close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{if(!dialog.open)reset();});dialog.addEventListener('cancel',reset);turn.addEventListener('change',()=>{machine.hidden=true;exportController?.abort();void load();});refresh.addEventListener('click',()=>void load());more.addEventListener('click',()=>void load(true));
 return{open,refresh(id){launch.hidden=!id;if(!id&&dialog.open){dialog.close();reset();return;}if(dialog.open){const current=options();if(!current.some(r=>r.id===turn.value)){dialog.close();reset();}}},destroy(){destroyed=true;reset();launch.remove();dialog.remove();}};
}
