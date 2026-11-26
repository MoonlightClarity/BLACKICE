/** Read-only human view. Categories are projections of existing records, not a
 * new action model. Internal outputs are never requested until selected. */
let sequence=0;
export function createActivityInspector({frame,getRunId,api,events,onTurnReceipts}){
 const doc=frame.ownerDocument,make=(tag,cls,value='')=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(value)e.textContent=value;return e;};
 const button=(cls,value,fn)=>{const e=make('button',cls,value);e.setAttribute('type','button');e.addEventListener('click',fn);return e;};
 const dialog=make('dialog','next-activity-inspector'),head=make('header','next-activity-head'),title=make('h2','','Receipts');title.id='activity-title-'+(++sequence);dialog.setAttribute('aria-labelledby',title.id);
 const launch=button('next-activity-open','Receipts',()=>open());launch.hidden=true;launch.title='Inspect updates, tool calls and saved outputs';
 const actions=frame.querySelector('.next-chat-head-actions')||frame.querySelector('.pb-header-actions')||frame.querySelector('.pc-header-actions');actions?.insertBefore(launch,actions.querySelector('#next-chat-stop'));
 const close=button('next-activity-close','Close',()=>dialog.close());head.append(title);
 if(typeof onTurnReceipts==='function')head.append(button('next-activity-turn-receipts','Turn receipts',()=>{dialog.close();void onTurnReceipts();}));
 head.append(close);
 const controls=make('form','next-activity-controls'),search=make('input','next-activity-search');search.setAttribute('type','search');search.setAttribute('aria-label','Search selected activity');search.placeholder='Search selected activity';search.maxLength=200;
 const view=make('select','next-activity-view');view.setAttribute('aria-label','Activity category');for(const [value,label] of [['updates','Updates'],['tools','Tool calls'],['failures','Tool failures'],['internal','Internal outputs']]){const option=make('option','',label);option.value=value;view.append(option);}view.value='updates';
 const submit=make('button','','Search');submit.setAttribute('type','submit');const refreshButton=button('next-activity-refresh','Refresh',()=>load());
 const distinct=make('input','next-activity-distinct-toggle');distinct.type='checkbox';distinct.checked=true;distinct.setAttribute('aria-label','Show distinct failures');
 const distinctLabel=make('label','next-activity-distinct-label');distinctLabel.append(distinct,make('span','','Distinct failures'));distinctLabel.hidden=true;
 const backGroup=button('next-activity-back-groups','Back to distinct failures',()=>{selectedGroup=null;updateMode();void load();});backGroup.hidden=true;
 controls.append(view,search,distinctLabel,backGroup,submit,refreshButton);
 const privacy=make('p','next-help','Internal outputs are hidden by default. Select Internal outputs to inspect saved structured reports. Private reasoning is not shown.');
 const status=make('p','next-activity-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const scope=make('p','next-help next-activity-coverage'),rows=make('ol','next-activity-results'),more=button('next-activity-more','Next page',()=>load({more:true}));more.hidden=true;
 dialog.append(head,controls,privacy,status,scope,rows,more);frame.append(dialog);
 const style=make('style');style.textContent=`.next-activity-inspector{box-sizing:border-box;width:min(850px,94vw);max-height:88vh;border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--next-workspace-background);color:var(--text)}.next-activity-inspector::backdrop{background:#0008}.next-activity-head,.next-activity-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.next-activity-head h2{flex:1;margin:0}.next-activity-controls{margin-top:16px}.next-activity-controls input{flex:1;min-width:160px}.next-activity-controls input,.next-activity-controls select{background:var(--next-control-background);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px}.next-activity-results{padding:0;list-style:none;max-height:51vh;overflow:auto}.next-activity-results li{padding:12px 0;border-bottom:1px solid var(--line)}.next-activity-results summary{cursor:pointer;overflow-wrap:anywhere}.next-activity-results pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,Consolas,monospace}.next-activity-source{overflow-wrap:anywhere;font-size:11px;color:var(--muted)}.next-activity-coverage{font-size:12px;line-height:1.45}.next-activity-status{font-size:13px}.next-activity-controls button,.next-activity-head button{flex:none}`;frame.append(style);style.textContent+='.next-activity-distinct-label{display:inline-flex;align-items:center;gap:6px;font-size:13px}.next-activity-distinct-label[hidden],.next-activity-back-groups[hidden]{display:none}.next-activity-results .next-activity-show-occurrences{margin-top:10px}';
 let runId=null,generation=0,controller=null,nextOffset=null,revision=null,destroyed=false,timer=null,paged=false,selectedGroup=null;
 const reset=()=>{generation++;controller?.abort();controller=null;clearTimeout(timer);timer=null;nextOffset=null;revision=null;paged=false;selectedGroup=null;rows.replaceChildren();more.hidden=true;updateMode();};
 const updateMode=()=>{distinctLabel.hidden=view.value!=='failures'||selectedGroup!==null;backGroup.hidden=view.value!=='failures'||selectedGroup===null;};
 const active=(id,token)=>!destroyed&&dialog.open&&id===runId&&token===generation;
 function coverage(value={}){return [value.scope,Number.isSafeInteger(value.recordedFailures)?value.recordedFailures+' recorded failures.':'',Number.isSafeInteger(value.omittedFailures)&&value.omittedFailures>0?value.omittedFailures+' older failure receipts omitted.':'',Number.isSafeInteger(value.retainedEvents)?value.retainedEvents+' retained events.':'',Number.isSafeInteger(value.omittedEvents)?value.omittedEvents+' earlier events omitted from this run index.':view.value==='internal'?'':'Earlier omission count unavailable.',
 Number.isSafeInteger(value.missingSummary)&&value.missingSummary>0?value.missingSummary+' older failures lack distinct-category indexing; some rare causes may be unavailable.':'',
 Number.isSafeInteger(value.distinctOverflow)&&value.distinctOverflow>0?value.distinctOverflow+' failures exceeded the distinct index capacity; do not assume this list is exhaustive.':'',value.details].filter(Boolean).join(' ');}
 async function load({more:append=false}={}){
  if(!runId||destroyed||!dialog.open)return;
  const offset=append?nextOffset:0;if(append&&offset===null)return;
  clearTimeout(timer);timer=null;paged=append;generation++;controller?.abort();controller=new AbortController();const token=generation,id=runId;
  if(!append){rows.replaceChildren();revision=null;nextOffset=null;}
  more.hidden=true;status.textContent='Loading '+(view.value==='internal'?'saved structured outputs':'activity')+'…';
  const params=new URLSearchParams({view:view.value,q:search.value,offset:String(offset),limit:'30'});
   if(view.value==='failures'){params.set('scope','task');if(selectedGroup)params.set('group',selectedGroup);else if(distinct.checked)params.set('distinct','1');}
   if(append&&revision)params.set('revision',revision);
  try{
   const result=await api('/api/conversations/'+encodeURIComponent(id)+'/activity?'+params,'GET',undefined,{signal:controller.signal});if(!active(id,token))return;
   revision=result.revision;nextOffset=result.nextOffset;scope.textContent=coverage(result.coverage);
    status.textContent=selectedGroup?result.items.length+' retained occurrences on this page; '+(result.occurrenceTotal??result.totalMatches)+' reported in this category.':
      view.value==='failures'&&distinct.checked?(result.totalMatches??result.items.length)+' distinct categories; '+(result.occurrenceTotal??result.items.length)+' reported failure occurrences.':
      result.items.length?result.items.length+' records on this page.':result.nextOffset!==null?'No matches on this page. Continue to search later retained events.':'No matching records in this search scope.';
   for(const item of result.items){const row=make('li'),detail=make('details'),heading=make('summary','',item.title);if(item.at){const time=make('time','next-help',' · '+new Date(item.at).toLocaleTimeString());heading.append(time);}detail.append(heading,make('pre','',item.text),make('p','next-activity-source','Source: '+item.source+(item.sourceHash?' · SHA-256 '+item.sourceHash:'')));
    if(item.truncated)detail.append(make('p','next-help','Preview shortened. Only the retained event content is available here.'));row.dataset.activityId=item.id;if(item.view==='updates')row.append(make('p','next-activity-preview',item.text.slice(0,350)+(item.text.length>350?'...':'')));
     if(item.grouped){const retained=item.retainedCount||0;
       if(retained)detail.append(button('next-activity-show-occurrences','Inspect '+retained+' retained receipts',()=>{selectedGroup=item.groupId;updateMode();void load();}));
       else detail.append(make('p','next-help','This historical failure category was preserved after its individual receipts were pruned. No individual record remains to open.'));
       if(item.attention==='unclassified')detail.append(make('p','next-help','Unclassified: a generic code can represent different underlying causes. Inspect individual occurrences when available.'));
     }
     row.append(detail);rows.append(row);}
   more.hidden=nextOffset===null;
  }catch(error){if(active(id,token)){status.textContent=error.code==='ACTIVITY_CHANGED'?'Activity changed while paging. Refresh to search the latest records.':'Could not load activity: '+error.message;}}
 }
 controls.addEventListener('submit',event=>{event.preventDefault();selectedGroup=null;updateMode();void load();});
  distinct.addEventListener('change',()=>{selectedGroup=null;updateMode();void load();});
  view.addEventListener('change',()=>{search.value='';selectedGroup=null;distinct.checked=true;updateMode();void load();});
 dialog.addEventListener('close',()=>{if(!dialog.open){reset();runId=null;}});dialog.addEventListener('cancel',()=>{reset();runId=null;});
 const unsubscribe=events?.subscribe?.(event=>{if(!dialog.open||event.runId!==runId||view.value==='internal'||timer)return;if(!['message','steer','tool.result','planning.reassessment'].includes(event.data?.type))return;const inspecting=()=>paged||search.value.trim()||rows.querySelector('details[open]');if(inspecting()){status.textContent='New activity available. Refresh when ready; current results are preserved.';return;}timer=setTimeout(()=>{timer=null;if(inspecting()){status.textContent='New activity available. Refresh when ready; current results are preserved.';return;}void load();},600);timer?.unref?.();});
 async function open(){reset();runId=getRunId?.();if(!runId)return;view.value='updates';search.value='';distinct.checked=true;selectedGroup=null;updateMode();scope.textContent='';if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.open=true;}await load();}
 return {open,refresh(id){launch.hidden=!id;if(dialog.open&&id!==runId){dialog.close();reset();runId=null;}},destroy(){destroyed=true;reset();unsubscribe?.();launch.remove();dialog.remove();style.remove();}};
}
