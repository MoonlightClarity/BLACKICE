import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_BOARD_LANES,savedTaskLane,savedTaskStatus,taskBoard,jobLinkedRun } from '../public/next/workspaces/tasks-visual-model.mjs';
import { createTasksWorkspace } from '../public/next/workspaces/tasks.mjs';
import { createTaskHistory } from '../public/next/workspaces/task-lifecycle.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{history=false,presentation='board'}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
  prototype.replaceChildren=function(...nodes){for(const child of [...this.children])child.remove();this.rawText='';this.append(...nodes);};
  Object.defineProperty(prototype,'elements',{get(){const fields=this.querySelectorAll('[name]');return new Proxy(fields,{get:(target,name)=>name==='namedItem'?id=>fields.find(field=>field.name===id):name in target?Reflect.get(target,name):fields.find(field=>field.name===name)});},configurable:true});
  Object.defineProperty(prototype,'options',{get(){return this.children;},configurable:true});
  const matches=prototype.matches;prototype.matches=function(selector){return matches.call(this,selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g,'[$1="$2"]'));};
  prototype.click=function(){if(!this.disabled)void this.dispatch('click',{},true);};
  const calls=[],listeners=new Set(),navigation=[],notifications=[];
  const tasks=['running','failed','completed',undefined].map((status,index)=>({id:'task-'+index,taskId:'task-'+index,title:'Saved task '+index,status,state:'active',settled:status!=='running',updatedAt:'2026-10-25T10:00:00Z'}));
  const schedule={id:'schedule-a',name:'Scheduled review',revision:1,enabled:false,trigger:{type:'manual'},input:'Review saved evidence'};
  const workflow={id:'workflow-a',name:'Saved workflow',nodes:[],edges:[]};
  const jobs=Array.from({length:80},(_,index)=>({id:'job-'+index,deploymentId:schedule.id,status:index===0?'failed':'completed',createdAt:'2026-10-25T10:00:00Z',
    attempts:[{number:1,runId:'original-'+index,status:'failed'},{number:2,runId:'actual-'+index,status:index===0?'failed':'completed'}]}));
  const api=async(path,method='GET',payload)=>{
    calls.push({path,method,payload});const url=new URL(path,'http://fixture.local');
    if(url.pathname==='/api/conversations/search'){
      const offset=Number(url.searchParams.get('offset')||0),query=url.searchParams.get('q').toLowerCase();
      const matching=tasks.filter(item=>item.state===url.searchParams.get('state')&&item.title.toLowerCase().includes(query));
      return{conversations:structuredClone(matching.slice(offset,offset+40)),hasMore:offset+40<matching.length};
    }
    const lifecycle=path.match(/^\/api\/conversations\/(task-\d+)\/(archive|delete|restore)$/);
    if(lifecycle&&method==='POST'){tasks.find(item=>item.id===lifecycle[1]).state={archive:'archived',delete:'deleted',restore:'active'}[lifecycle[2]];return{rootId:lifecycle[1]};}
    if(path==='/api/operations')return{status:{healthy:true,paused:false,enabled:0,running:0},deployments:[structuredClone(schedule)],jobs:structuredClone(jobs)};
    if(path==='/api/workflows?view=index')return[{id:workflow.id,name:workflow.name}];
    if(path==='/api/workflows/'+workflow.id)return structuredClone(workflow);
    if(path==='/api/operations/deployments/schedule-a'&&method==='PUT'){assert.equal(payload.expectedRevision,schedule.revision);schedule.enabled=payload.enabled;schedule.revision++;return structuredClone(schedule);}
    if(path==='/api/operations/deployments'&&method==='POST')return{id:'created-schedule'};
    if(path.startsWith('/api/operations/')&&method==='POST')return{ok:true};
    throw Error('Unexpected '+method+' '+path);
  };
  const component=(history?createTaskHistory:createTasksWorkspace)({mount:dom.mount,api,presentation,
    events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},getStatus:()=>({cwd:'C:\\fixture'}),
    notify:(...args)=>notifications.push(args),onNavigate:(...args)=>navigation.push(args)});
  t.after(()=>component.destroy());
  return{...dom,component,calls,listeners,tasks,jobs,schedule,navigation,notifications,async clickReady(selector){await dom.click(selector);await settle();}};
}

test('task board groups only recorded task status and counts only its loaded items',()=>{
  const values=['queued','running','waiting','failed','cancelled','interrupted','completed',null,'imported-status'].map(status=>({status})),before=structuredClone(values);
  const model=taskBoard(values);assert.equal(model.loaded,9);assert.deepEqual(model.lanes.map(lane=>[lane.id,lane.items.length]),[['working',3],['attention',3],['completed',1],['saved',2]]);
  assert.deepEqual(values,before);assert.equal(savedTaskLane({status:'done'}),'saved','A step claim cannot become a completed run.');
  assert.equal(savedTaskStatus({status:'cancelled',settled:false}),'Stopping');assert.equal(savedTaskLane({status:'cancelled',settled:false}),'attention');
  assert.equal(savedTaskStatus({status:'imported-status'}),'imported-status');assert.equal(TASK_BOARD_LANES.length,4);
});

test('job links use actual attempt receipts and distinguish a queued retry from its previous run',()=>{
  assert.deepEqual(jobLinkedRun({id:'not-a-run',runId:'legacy',attempts:[{number:1,runId:'first'},{number:2,runId:'second'}]}),{runId:'second',attemptNumber:2,current:true});
  assert.deepEqual(jobLinkedRun({attempts:[{number:1,runId:'first'},{number:2,runId:null}]}),{runId:'first',attemptNumber:1,current:false});
  assert.equal(jobLinkedRun({id:'job-only',attempts:[{inboxId:'not-a-run'}]}),null);
  assert.deepEqual(jobLinkedRun({runId:'legacy'}),{runId:'legacy',attemptNumber:null,current:true});
});

test('Tasks opens on an honest status board and loads no hidden schedule, workflow or full-run data',async t=>{
  const f=fixture(t);assert.equal(f.calls.length,0);f.component.enter();await settle();
  assert.equal(f.$('#next-tasks-tab-board').getAttribute('aria-selected'),'true');assert.equal(f.$('#next-tasks-panel-schedules').hidden,true);assert.equal(f.$('#next-tasks-panel-jobs').hidden,true);
  assert.deepEqual(f.calls.map(call=>new URL(call.path,'http://fixture.local').pathname),['/api/conversations/search']);
  assert.deepEqual(f.mount.querySelectorAll('[data-task-lane]').map(node=>node.dataset.taskLane),['working','attention','completed','saved']);
  assert.equal(f.mount.querySelectorAll('[data-task-id]').length,4);assert.match(f.$('#next-tasks-history-status').textContent,/4 loaded tasks/);
  const card=f.$('[data-task-id="task-0"]');assert.equal(card.querySelector('details').open,false);
  assert.equal(card.querySelector('[data-task-action="delete"]').disabled,true);
  await f.clickReady(card.querySelector('.next-task-title'));assert.deepEqual(f.navigation,[['chat',{conversationId:'task-0'}]]);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false,'Opening a task is navigation, not a write.');
});

test('Tasks tabs support keyboard navigation, preserve schedule drafts, and release hidden board subscriptions',async t=>{
  const f=fixture(t);f.component.enter();await settle();assert.equal(f.listeners.size,2);
  await f.key(f.$('#next-tasks-tab-board'),'ArrowRight');await settle();
  assert.equal(f.$('#next-tasks-tab-schedules').getAttribute('aria-selected'),'true');assert.equal(f.document.activeElement,f.$('#next-tasks-tab-schedules'));
  assert.equal(f.$('#next-tasks-panel-board').hidden,true);assert.equal(f.$('#next-tasks-panel-schedules').hidden,false);assert.equal(f.listeners.size,1);
  assert.equal(f.calls.filter(call=>call.path==='/api/workflows?view=index').length,1);assert.equal(f.calls.some(call=>call.path==='/api/workflows/workflow-a'),false);
  await f.input('[name="name"]','Unfinished schedule draft');await f.input('[name="input"]','Unfinished instructions');await f.input('[name="cwd"]','C:\\draft');
  await f.clickReady('#next-tasks-tab-board');assert.equal(f.listeners.size,2);await f.clickReady('#next-tasks-tab-schedules');
  assert.equal(f.$('[name="name"]').value,'Unfinished schedule draft');assert.equal(f.$('[name="input"]').value,'Unfinished instructions');assert.equal(f.$('[name="cwd"]').value,'C:\\draft');
  f.component.leave();assert.equal(f.listeners.size,0);f.component.enter();await settle();assert.equal(f.$('[name="name"]').value,'Unfinished schedule draft');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
  await f.key(f.$('#next-tasks-tab-schedules'),'End');await settle();assert.equal(f.$('#next-tasks-tab-jobs').getAttribute('aria-selected'),'true');
});

test('Job history is bounded and opens the latest linked attempt instead of the job identity',async t=>{
  const f=fixture(t);f.component.enter();await settle();await f.clickReady('#next-tasks-tab-jobs');
  assert.equal(f.calls.some(call=>call.path.startsWith('/api/workflows')),false);assert.equal(f.mount.querySelectorAll('[data-job-id]').length,35);
  await f.clickReady('[data-job-run-id="actual-0"]');assert.deepEqual(f.navigation.at(-1),['chat',{conversationId:'actual-0'}]);
  await f.clickReady('#next-tasks-jobs-more');assert.equal(f.mount.querySelectorAll('[data-job-id]').length,70);
  await f.clickReady('#next-tasks-jobs-more');assert.equal(f.mount.querySelectorAll('[data-job-id]').length,80);assert.equal(f.$('#next-tasks-jobs-more').hidden,true);
  assert.equal(f.calls.some(call=>call.path==='/api/runs'),false);
});

test('compact board menus and bulk selection retain archive/Trash/Restore without drag writes',async t=>{
  const f=fixture(t,{history:true});f.component.enter();await settle();
  assert.equal(f.mount.querySelectorAll('[data-task-bulk-action]').length,0,'Unselected bulk operations stay out of the toolbar.');
  const card=f.$('[data-task-id="task-2"]'),menu=card.querySelector('details');menu.open=true;
  await f.clickReady(card.querySelector('[data-task-action="archive"]'));assert.equal(f.tasks[2].state,'archived');
  f.$('#next-task-history-state').value='archived';await f.$('#next-task-history-state').dispatch('change');await settle();
  await f.clickReady(f.$('[data-task-id="task-2"]').querySelector('[data-task-action="delete"]'));assert.equal(f.tasks[2].state,'deleted');
  f.$('#next-task-history-state').value='deleted';await f.$('#next-task-history-state').dispatch('change');await settle();
  await f.clickReady(f.$('[data-task-id="task-2"]').querySelector('[data-task-action="restore"]'));assert.equal(f.tasks[2].state,'active');
  assert.deepEqual(f.calls.filter(call=>call.method!=='GET').map(call=>call.path),['/api/conversations/task-2/archive','/api/conversations/task-2/delete','/api/conversations/task-2/restore']);
});

test('timeline presentation preserves backend search order and task menu actions',async t=>{
  const f=fixture(t,{history:true,presentation:'timeline'});f.component.enter();await settle();
  assert.equal(f.mount.dataset.taskPresentation,'timeline');assert.equal(f.mount.querySelectorAll('[data-task-lane]').length,0);
  assert.deepEqual(f.mount.querySelectorAll('[data-task-id]').map(node=>node.dataset.taskId),f.tasks.map(item=>item.id));
  assert.equal(f.mount.querySelectorAll('.next-task-meta time').length,4);assert.ok(f.$('[data-task-id="task-1"]').querySelector('[data-task-action="archive"]'));
});
