import { text } from '../core/dom.mjs';
import { taskBoard, savedTaskStatus } from './tasks-visual-model.mjs';

export const taskId = item => item?.taskId || item?.rootId || item?.id;
export const taskIsRunning = item => ['queued','running','waiting'].includes(item?.runStatus || item?.status) || item?.settled === false;
export const taskActions = state => state === 'deleted' ? ['restore'] : state === 'archived' ? ['restore','delete'] : ['archive','delete'];
export const taskActionLabel = action => ({archive:'Archive',restore:'Restore',delete:'Move to Trash'})[action];

/** Organization changes affect the saved task family, never its execution.
 * A partial bulk failure is reported and is never retried automatically.
 */
export async function changeTaskState(api, items, action) {
  if (!['archive','restore','delete'].includes(action)) throw Error('Choose a supported task action.');
  const succeeded=[],failed=[];
  for (const item of items) {
    const id=taskId(item);
    if (!id || !taskActions(item.state || item.bucket || 'active').includes(action)) {
      failed.push({id,error:'This task is no longer in the selected view.'});continue;
    }
    try {
      await api('/api/conversations/'+encodeURIComponent(id)+'/'+action,'POST',{});
      succeeded.push(id);
    } catch(error) { failed.push({id,error:error.message || 'The task could not be updated.'}); }
  }
  return {succeeded,failed};
}

/** A bounded metadata catalog shared by Tasks and Activity. No full run reads. */
export function createTaskHistory({mount,api,events,notify=()=>{},onNavigate,prefix='next-task-history',presentation='timeline'}={}) {
  const board=presentation==='board';
  mount.innerHTML=`<header class="next-task-history-head"><div><h2>${board?'Work board':'Task history'}</h2><p class="next-help">${board?'Status of the tasks loaded in this view.':'Recent saved work, in the order returned by your search.'}</p></div><button type="button" id="${prefix}-refresh">Refresh tasks</button></header>
    <div class="next-task-filters"><label class="next-label">Task history<select class="next-field" id="${prefix}-state"><option value="active">Active</option><option value="archived">Archived</option><option value="deleted">Trash</option></select></label><label class="next-label">Find tasks<input class="next-field" id="${prefix}-query" type="search" maxlength="200"></label></div>
    <div class="next-task-bulk" id="${prefix}-bulk"></div><p class="next-help next-task-status" role="status" id="${prefix}-status"></p><div class="${board?'next-task-board':'next-task-timeline'}" id="${prefix}-list"></div><button type="button" id="${prefix}-more" hidden>Show more tasks</button>`;
  mount.dataset.taskPresentation=board?'board':'timeline';
  const $=part=>mount.querySelector('#'+prefix+'-'+part);
  const ui={state:$('state'),query:$('query'),bulk:$('bulk'),status:$('status'),list:$('list'),more:$('more')};
  let active=false,destroyed=false,reading=0,writing=false,items=[],nextOffset=0,hasMore=false,unsubscribe=null,timer=null,error='';
  const selected=new Set();
  const add=(parent,tag,label,cls)=>text(parent,label,tag,cls);
  function button(parent,label,handler){const node=add(parent,'button',label);node.type='button';node.disabled=writing;node.addEventListener('click',handler);return node;}
  function paintBulk() {
    ui.bulk.replaceChildren();
    const chosen=items.filter(item=>selected.has(taskId(item)));
    const all=button(ui.bulk,chosen.length===items.length&&items.length?'Clear selection':'Select visible tasks',()=>{
      if(writing)return;
      if(chosen.length===items.length)selected.clear();else for(const item of items)selected.add(taskId(item));paint();
    });all.disabled=writing||!items.length;
    add(ui.bulk,'span',chosen.length+' selected','next-help');
    for(const action of chosen.length?taskActions(ui.state.value):[]) {
      const node=button(ui.bulk,taskActionLabel(action)+' selected',()=>void mutate(chosen,action));
      node.dataset.taskBulkAction=action;node.disabled=writing||!chosen.length||(action==='delete'&&chosen.some(taskIsRunning));
    }
  }
  function card(parent,item){
    const id=taskId(item),card=add(parent,'article','','next-task-card');card.dataset.taskId=id;
    const row=add(card,'div','','next-task-card-head'),label=add(row,'label','','next-task-select');
    const check=add(label,'input','');check.type='checkbox';check.checked=selected.has(id);check.disabled=writing;
    check.setAttribute('aria-label','Select '+(item.title||'task'));
    check.addEventListener('change',()=>{check.checked?selected.add(id):selected.delete(id);paintBulk();});
    const title=button(row,item.title||'Saved task',()=>onNavigate?.('chat',{conversationId:id}));title.className='next-task-title';
    title.setAttribute('aria-label','Open task: '+(item.title||'Saved task'));
    const menu=add(row,'details','','next-task-menu'),summary=add(menu,'summary','Actions');summary.setAttribute('aria-label','Actions for '+(item.title||'Saved task'));
    const actions=add(menu,'div','','next-task-menu-actions');
    for(const action of taskActions(item.state||ui.state.value)){
      const node=button(actions,taskActionLabel(action),()=>void mutate([item],action));node.dataset.taskAction=action;
      if(action==='delete'&&taskIsRunning(item)){node.disabled=true;node.title='Stop the task and wait for it to settle before moving it to Trash.';}
    }
    if(taskIsRunning(item))add(actions,'p','Archiving does not stop this task. Stop it from its conversation.','next-help');
    const meta=add(card,'div','','next-task-meta'),badge=add(meta,'span',savedTaskStatus(item),'next-status-pill');badge.dataset.state=item.runStatus||item.status||'saved';
    const stamp=item.updatedAt||item.createdAt,date=new Date(stamp);
    if(stamp&&Number.isFinite(date.getTime())){const time=add(meta,'time',date.toLocaleString());time.dateTime=date.toISOString();}
    return card;
  }
  function paint() {
    if(destroyed)return;
    ui.list.replaceChildren();
    if(board){
      const model=taskBoard(items);
      for(const lane of model.lanes){
        const section=add(ui.list,'section','','next-task-lane');section.dataset.taskLane=lane.id;
        section.setAttribute('aria-labelledby',prefix+'-lane-'+lane.id);
        const heading=add(section,'header','','next-task-lane-head'),title=add(heading,'h3',lane.label);title.id=prefix+'-lane-'+lane.id;
        add(heading,'span',lane.items.length,'next-task-lane-count');
        const body=add(section,'div','','next-task-lane-body');
        if(!lane.items.length)add(body,'p','No loaded tasks','next-task-lane-empty');
        for(const item of lane.items)card(body,item);
      }
    }else{
      if(!items.length)add(ui.list,'p','No tasks in this view.','next-empty');
      for(const item of items)card(ui.list,item);
    }
    paintBulk();ui.more.hidden=!hasMore;ui.more.disabled=writing;
    ui.status.textContent=error||items.length+' loaded task'+(items.length===1?'':'s')+(hasMore?' · more available':'');
  }
  async function load({more=false}={}) {
    if(!active||destroyed)return;
    const token=++reading,state=ui.state.value,query=ui.query.value.trim(),offset=more?nextOffset:0;
    try {
      const result=await api('/api/conversations/search?'+new URLSearchParams({q:query,state,limit:'40',offset:String(offset)}));
      if(!active||destroyed||token!==reading)return;
      if(!Array.isArray(result?.conversations))throw Error('Saved tasks could not be read.');
      items=more?[...items,...result.conversations]:result.conversations;
      nextOffset=offset+result.conversations.length;hasMore=result.hasMore===true&&result.conversations.length>0;
      const visible=new Set(items.map(taskId));for(const id of selected)if(!visible.has(id))selected.delete(id);
      paint();
    } catch(cause) {if(active&&token===reading){error=cause.message;paint();}}
  }
  async function mutate(chosen,action) {
    if(!active||writing||!chosen.length)return;
    writing=true;reading++;error='';paint();
    try {
      const result=await changeTaskState(api,chosen,action);
      for(const id of result.succeeded)selected.delete(id);
      error=result.failed.length?result.succeeded.length+' updated; '+result.failed.length+' could not be updated. '+result.failed.map(row=>row.error).join(' '):'';
      if(error)notify(error,true);else notify(result.succeeded.length+' task'+(result.succeeded.length===1?'':'s')+' '+({archive:'archived',delete:'moved to Trash',restore:'restored'})[action]+'.');
      if(active)await load();
    } finally {writing=false;if(active)paint();}
  }
  function reset(){reading++;selected.clear();items=[];hasMore=false;error='';paint();void load();}
  ui.state.addEventListener('change',reset);
  ui.query.addEventListener('input',()=>{reading++;clearTimeout(timer);timer=setTimeout(reset,200);});
  $('refresh').addEventListener('click',()=>{error='';void load();});
  ui.more.addEventListener('click',()=>void load({more:true}));
  return {
    enter(){if(active||destroyed)return;active=true;unsubscribe=events.subscribe(event=>{
      if(!active||!['conversations.updated','conversations.changed'].includes(event.type))return;
      clearTimeout(timer);timer=setTimeout(()=>void load(),450);
    });void load();},
    leave(){active=false;reading++;unsubscribe?.();unsubscribe=null;clearTimeout(timer);},
    destroy(){this.leave();destroyed=true;mount.replaceChildren();},
  };
}
