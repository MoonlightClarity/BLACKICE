import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHistory, changeTaskState } from '../public/next/workspaces/task-lifecycle.mjs';
import { createPlanningWorkspace } from '../public/next/workspaces/planning.mjs';
import { createTasksWorkspace } from '../public/next/workspaces/tasks.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function domFixture(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
  prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
  Object.defineProperty(prototype,'elements',{get(){const fields=this.querySelectorAll('[name]');return new Proxy(fields,{get:(target,name)=>name==='namedItem'?id=>fields.find(field=>field.name===id):name in target?Reflect.get(target,name):fields.find(field=>field.name===name)});},configurable:true});
  Object.defineProperty(prototype,'options',{get(){return this.children;},configurable:true});
  const matches=prototype.matches;prototype.matches=function(selector){return matches.call(this,selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g,'[$1="$2"]'));};
  return dom;
}
const task=(id,extra={})=>({id,rootId:id,taskId:id,title:'Task '+id,state:'active',status:'completed',settled:true,...extra});
const plan=(id,extra={})=>({taskId:id,title:'Plan '+id,goal:'Goal '+id,revision:1,bucket:'active',editable:true,runStatus:'completed',steps:[{id:'check',title:'Check result',note:'Saved note',status:'pending'}],...extra});
function fixture(t,{planning=false,tasksWorkspace=false,request}={}){
  const dom=domFixture(t),calls=[],listeners=new Set(),notifications=[],navigation=[];
  const tasks=[task('a'),task('b')],plans=[plan('a'),plan('b')],projects=[{id:'project-a',name:'Project A',status:'draft',tasks:[],organizationRevision:0,archived:false}];
  let organizationRevision=0;
  async function backend(path,method='GET',payload){
    const url=new URL(path,'http://fixture.local');
    if(method==='GET'&&url.pathname==='/api/conversations/search'){
      const all=tasks.filter(item=>item.state===url.searchParams.get('state')&&item.title.toLowerCase().includes(url.searchParams.get('q').toLowerCase())),offset=Number(url.searchParams.get('offset'));
      return{conversations:structuredClone(all.slice(offset,offset+40)),hasMore:all.length>offset+40};
    }
    if(method==='GET'&&url.pathname==='/api/planning')return{plans:structuredClone(plans.filter(item=>(url.searchParams.get('state')==='all'?item.bucket!=='deleted':item.bucket===url.searchParams.get('state'))&&(!url.searchParams.has('taskId')||item.taskId===url.searchParams.get('taskId'))).map(({steps,...summary})=>({...summary,stepCount:steps.length}))),nextOffset:null};
    if(method==='GET'&&/^\/api\/tasks\/[^/]+$/.test(url.pathname))return structuredClone(plans.find(item=>item.taskId===url.pathname.split('/').pop()));
    if(method==='GET'&&url.pathname==='/api/projects')return{projects:structuredClone(projects.map(item=>({...item,organizationRevision})))};
    const state=path.match(/^\/api\/conversations\/([^/]+)\/(archive|delete|restore)$/);
    if(method==='POST'&&state){
      const item=tasks.find(item=>item.taskId===state[1]);if(!item)throw Error('Not found');
      if(state[2]==='delete'&&(!item.settled||item.status==='running'))throw Error('Wait for the conversation to finish stopping before moving it to Trash.');
      item.state={archive:'archived',delete:'deleted',restore:'active'}[state[2]];
      const saved=plans.find(plan=>plan.taskId===item.taskId);if(saved){saved.bucket=item.state;saved.editable=item.state!=='deleted';}return{rootId:item.taskId,state:item.state};
    }
    const edit=path.match(/^\/api\/tasks\/([^/]+)\/plan\/edit$/);
    if(method==='POST'&&edit){
      const saved=plans.find(plan=>plan.taskId===edit[1]);
      if(saved.revision!==payload.expectedRevision)throw Object.assign(Error('The plan changed. Reload it before saving.'),{status:409});
      for(const operation of payload.operations)if(operation.type==='metadata')saved.goal=operation.patch.goal;else saved.steps.find(step=>step.id===operation.stepId).note=operation.patch.note;
      saved.revision++;return structuredClone(saved);
    }
    if(path==='/api/planning/organization'&&method==='POST'){
      if(payload.expectedRevision!==organizationRevision)throw Object.assign(Error('Plan organization changed. Refresh before changing it.'),{status:409});
      for(const operation of payload.operations)projects.find(item=>item.id===operation.projectId).archived=operation.archived;
      return{revision:++organizationRevision};
    }
    throw Error('Unexpected API '+method+' '+path);
  }
  const api=async(path,method='GET',payload)=>{const call={path,method,payload};calls.push(call);return request?request(call,backend):backend(path,method,payload);};
  const component=(planning?createPlanningWorkspace:tasksWorkspace?createTasksWorkspace:createTaskHistory)({mount:dom.mount,api,
    events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
    notify:(...args)=>notifications.push(args),onNavigate:(...args)=>navigation.push(args)});
  if(planning)dom.$('#next-planning-type').value='conversation';
  t.after(()=>component.destroy());
  return{...dom,component,calls,tasks,plans,projects,notifications,navigation,listeners,
    async select(selector,value){dom.$(selector).value=value;await dom.$(selector).dispatch('change');await settle();},
    async button(label,parent=dom.mount){const node=parent.querySelectorAll('button').find(node=>node.textContent===label);assert.ok(node,'Missing button '+label);await dom.click(node);await settle();},
    async submit(){await dom.$('#next-planning-edit').dispatch('submit');await settle();},
  };
}

test('task history is lazy, uses bounded metadata, and archives, trashes and restores the real task family',async t=>{
  const f=fixture(t);assert.equal(f.calls.length,0);f.component.enter();await settle();
  assert.match(f.calls[0].path,/conversations\/search\?q=&state=active&limit=40&offset=0/);
  assert.equal(f.$('[data-task-id="a"]').textContent.includes('Archive'),true);
  await f.click(f.$('[data-task-id="a"]').querySelector('[data-task-action="archive"]'));await settle();assert.equal(f.tasks[0].state,'archived');
  assert.equal(f.$('[data-task-id="a"]'),null);
  await f.select('#next-task-history-state','archived');await f.click(f.$('[data-task-id="a"]').querySelector('[data-task-action="delete"]'));await settle();
  assert.equal(f.tasks[0].state,'deleted');await f.select('#next-task-history-state','deleted');
  await f.click(f.$('[data-task-id="a"]').querySelector('[data-task-action="restore"]'));await settle();assert.equal(f.tasks[0].state,'active');
  assert.equal(f.calls.some(call=>/^\/api\/runs(?:\/|$)/.test(call.path)),false,'History must never load full runs.');
});

test('bulk task changes run once per selected task, retain failures and never replay uncertain mutations',async t=>{
  const f=fixture(t,{request:async(call,backend)=>{
    if(call.path==='/api/conversations/b/archive')throw Error('Disk save failed; refresh to inspect the current state.');return backend(call.path,call.method,call.payload);
  }});f.component.enter();await settle();await f.button('Select visible tasks');
  await f.click(f.$('[data-task-bulk-action="archive"]'));await settle();
  assert.equal(f.tasks[0].state,'archived');assert.equal(f.tasks[1].state,'active');
  assert.match(f.$('#next-task-history-status').textContent,/1 updated; 1 could not.*Disk save failed/);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,2);
  assert.equal(f.$('[data-task-id="b"]').querySelector('input').checked,true);
  await f.button('Refresh tasks');assert.equal(f.calls.filter(call=>call.method==='POST').length,2);
});

test('running task Archive does not cancel work and Trash waits for settlement',async t=>{
  const f=fixture(t);f.tasks[0].status='running';f.tasks[0].settled=false;f.component.enter();await settle();
  const row=f.$('[data-task-id="a"]');assert.equal(row.querySelector('[data-task-action="delete"]').disabled,true);
  await f.click(row.querySelector('[data-task-action="archive"]'));await settle();
  assert.equal(f.tasks[0].state,'archived');assert.equal(f.tasks[0].status,'running');
  assert.deepEqual(f.calls.filter(call=>call.method!=='GET').map(call=>call.path),['/api/conversations/a/archive']);
});

test('superseded task reads cannot repopulate another filter and hidden workspaces unsubscribe',async t=>{
  const waiting=deferred();let held=true;
  const f=fixture(t,{request:async(call,backend)=>{
    const result=await backend(call.path,call.method,call.payload);if(held&&call.method==='GET'){held=false;await waiting.promise;}return result;
  }});f.tasks[1].state='archived';f.component.enter();await settle();
  await f.select('#next-task-history-state','archived');waiting.resolve();await settle();
  assert.equal(f.$('[data-task-id="a"]'),null);assert.ok(f.$('[data-task-id="b"]'));
  f.component.leave();assert.equal(f.listeners.size,0);const count=f.calls.length;
  for(const listener of f.listeners)listener({type:'conversations.updated'});await settle();assert.equal(f.calls.length,count);
  f.component.enter();await settle();assert.equal(f.listeners.size,1);
});

test('bounded task pages expose later tasks without loading a full conversation',async t=>{
  const f=fixture(t);f.tasks.splice(0,2,...Array.from({length:85},(_,i)=>task('page-'+i)));f.component.enter();await settle();
  assert.equal(f.mount.querySelectorAll('[data-task-id]').length,40);await f.button('Show more tasks');
  assert.equal(f.mount.querySelectorAll('[data-task-id]').length,80);await f.button('Show more tasks');
  assert.equal(f.mount.querySelectorAll('[data-task-id]').length,85);assert.equal(f.$('#next-task-history-more').hidden,true);
});

test('Planning retains per-plan drafts across switching, leaving and Archive/Trash/Restore',async t=>{
  const f=fixture(t,{planning:true});f.component.enter();await settle();
  await f.button('Open plan',f.$('[data-plan-id="a"]'));await f.input('#next-planning-goal','Unsaved A');
  await f.button('Open plan',f.$('[data-plan-id="b"]'));await f.input('#next-planning-goal','Unsaved B');
  await f.button('Open plan',f.$('[data-plan-id="a"]'));assert.equal(f.$('#next-planning-goal').value,'Unsaved A');
  f.component.leave();f.component.enter();await settle();assert.equal(f.$('#next-planning-goal').value,'Unsaved A');
  await f.click(f.$('#next-planning-list').querySelector('[data-plan-id="a"]').querySelector('[data-plan-action="archive"]'));await settle();
  await f.select('#next-planning-state','archived');await f.button('Open plan',f.$('[data-plan-id="a"]'));assert.equal(f.$('#next-planning-goal').value,'Unsaved A');
  await f.click(f.$('#next-planning-list').querySelector('[data-plan-id="a"]').querySelector('[data-plan-action="delete"]'));await settle();
  await f.select('#next-planning-state','deleted');await f.button('Open plan',f.$('[data-plan-id="a"]'));assert.equal(f.$('#next-planning-goal').readOnly,true);
  await f.click(f.$('#next-planning-list').querySelector('[data-plan-id="a"]').querySelector('[data-plan-action="restore"]'));await settle();
  await f.select('#next-planning-state','active');await f.button('Open plan',f.$('[data-plan-id="a"]'));assert.equal(f.$('#next-planning-goal').value,'Unsaved A');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/plan/edit')).length,0,'Switching or restoring must never save a draft.');
});

test('Planning hydrates only the selected metadata summary and map inspection never edits the saved tree',async t=>{
  const f=fixture(t,{planning:true});f.component.enter();await settle();
  assert.deepEqual(f.calls.filter(call=>/^\/api\/tasks\/[^/]+$/.test(call.path)).map(call=>call.path),['/api/tasks/a']);
  assert.ok(f.$('[data-plan-map-node="check"]'));
  await f.click(f.$('[data-plan-map-node="check"]'));
  assert.equal(f.$('textarea[data-step-id="check"]').value,'Saved note');
  await f.click('#next-plan-zoom-in');await f.click('#next-plan-fit');await f.click('#next-plan-outline-view');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
  await f.button('Open plan',f.$('[data-plan-id="b"]'));
  assert.equal(f.$('#next-planning-goal').value,'Goal b');
  assert.deepEqual(f.calls.filter(call=>/^\/api\/tasks\/[^/]+$/.test(call.path)).map(call=>call.path),['/api/tasks/a','/api/tasks/b']);
});

test('a late selected-plan hydration cannot overwrite a newly selected plan',async t=>{
  const waiting=deferred();let held=true;
  const f=fixture(t,{planning:true,request:async(call,backend)=>{
    const result=await backend(call.path,call.method,call.payload);
    if(call.path==='/api/tasks/a'&&held){held=false;await waiting.promise;}return result;
  }});f.component.enter();await settle();
  await f.button('Open plan',f.$('[data-plan-id="b"]'));
  assert.equal(f.$('#next-planning-goal').value,'Goal b');waiting.resolve();await settle();
  assert.equal(f.$('#next-planning-goal').value,'Goal b');assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
});

test('Planning late Save preserves newer typing and cannot replace a newly selected plan',async t=>{
  const waiting=deferred();const f=fixture(t,{planning:true,request:async(call,backend)=>{
    if(call.path.endsWith('/plan/edit'))await waiting.promise;return backend(call.path,call.method,call.payload);
  }});f.component.enter();await settle();await f.button('Open plan',f.$('[data-plan-id="a"]'));await f.input('#next-planning-goal','Submitted A');
  const saving=f.submit();await settle();await f.input('#next-planning-goal','Newer A');
  await f.button('Open plan',f.$('[data-plan-id="b"]'));await f.input('#next-planning-goal','B draft');waiting.resolve();await saving;await settle();
  assert.equal(f.$('#next-planning-goal').value,'B draft');assert.equal(f.plans[0].goal,'Submitted A');
  assert.equal(f.$('#next-planning-save').disabled,false,'The current plan can save after another plan receipt settles.');
  await f.button('Open plan',f.$('[data-plan-id="a"]'));assert.equal(f.$('#next-planning-goal').value,'Newer A');await f.submit();
  assert.equal(f.plans[0].goal,'Newer A');assert.equal(f.calls.filter(call=>call.path.endsWith('/plan/edit')).at(-1).payload.expectedRevision,2);
});

test('Planning conflicts preserve drafts and rebase only after an explicit review action',async t=>{
  const f=fixture(t,{planning:true});f.component.enter();await settle();await f.button('Open plan',f.$('[data-plan-id="a"]'));await f.input('#next-planning-goal','Local goal');
  f.plans[0].revision=2;f.plans[0].goal='External goal';f.plans[0].steps.push({id:'new-step',title:'New worker step',note:'External note',status:'pending'});
  await f.submit();assert.match(f.$('#next-planning-receipt').textContent,/plan changed/);assert.equal(f.$('#next-planning-goal').value,'Local goal');
  await f.button('Refresh');await f.button('Open plan',f.$('[data-plan-id="a"]'));await f.button('Keep draft against latest version');
  await f.click(f.$('[data-plan-map-node="new-step"]'));
  assert.equal(f.calls.filter(call=>call.path.endsWith('/plan/edit')).length,1);assert.equal(f.$('textarea[data-step-id="new-step"]').value,'External note');
  await f.submit();assert.equal(f.plans[0].goal,'Local goal');assert.equal(f.plans[0].steps.at(-1).note,'External note');
});

test('project plans have genuine Archive and Restore with organization revision checks and no invented Trash',async t=>{
  const f=fixture(t,{planning:true});f.component.enter();await settle();await f.select('#next-planning-type','project');
  await f.click(f.$('[data-plan-id="project-a"]').querySelector('[data-plan-action="archive"]'));await settle();assert.equal(f.projects[0].archived,true);
  assert.equal(f.$('[data-plan-id="project-a"]'),null);await f.select('#next-planning-state','archived');
  assert.ok(f.$('[data-plan-id="project-a"]'));assert.equal(f.$('[data-plan-id="project-a"]').querySelector('[data-plan-action="delete"]'),null);
  await f.click(f.$('[data-plan-id="project-a"]').querySelector('[data-plan-action="restore"]'));await settle();
  assert.equal(f.projects[0].archived,false);
  assert.deepEqual(f.calls.filter(call=>call.path==='/api/planning/organization').map(call=>call.payload.expectedRevision),[0,1]);
});

test('unsupported lifecycle actions fail before dispatch',async()=>{
  let writes=0;await assert.rejects(changeTaskState(async()=>{writes++;},[task('a')],'purge'),/supported task action/);assert.equal(writes,0);
});

test('schedule Remove is explicit, keeps creation drafts, preserves failures and never retries on refresh',async t=>{
  const schedules=[{id:'schedule-a',name:'Retain its history',input:'Original instructions',enabled:false,revision:2,trigger:{type:'manual'}}];
  let fail=true;
  const f=fixture(t,{tasksWorkspace:true,request:async(call,backend)=>{
    if(call.path==='/api/operations')return{status:{healthy:true,paused:false},deployments:structuredClone(schedules),jobs:[]};
    if(call.path==='/api/workflows?view=index')return[];
    if(call.path==='/api/operations/deployments/schedule-a'&&call.method==='DELETE'){
      if(fail)throw Error('Schedule removal could not be saved.');schedules.length=0;return{removed:true};
    }
    return backend(call.path,call.method,call.payload);
  }});
  f.component.enter();await settle();
  await f.click('#next-tasks-tab-schedules');await settle();
  await f.input('[name="name"]','Unfinished schedule draft');await f.input('[name="cwd"]','C:\\unsaved-folder');
  assert.match(f.mount.textContent,/Running work and job history remain/);
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  await f.click(f.$('[data-schedule-remove="schedule-a"]'));await settle();
  assert.match(f.$('#next-tasks-info').textContent,/could not be saved/);assert.equal(f.$('[name="name"]').value,'Unfinished schedule draft');
  await f.click('#next-tasks-refresh');await settle();assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
  f.component.leave();f.component.enter();await settle();assert.equal(f.$('[name="cwd"]').value,'C:\\unsaved-folder');
  fail=false;await f.click(f.$('[data-schedule-remove="schedule-a"]'));await settle();assert.equal(schedules.length,0);
  assert.equal(f.$('[name="name"]').value,'Unfinished schedule draft');assert.equal(f.calls.filter(call=>call.method==='DELETE').length,2);
});

test('Planning reconciles external revisions and Trash while retaining draft text, focus and caret',async t=>{
  const f=fixture(t,{planning:true});f.component.enter();await settle();await f.button('Open plan',f.$('[data-plan-id="a"]'));
  await f.input('#next-planning-goal','Local unfinished goal');f.$('#next-planning-goal').focus();f.$('#next-planning-goal').setSelectionRange(3,8);
  f.plans[0].revision=2;f.plans[0].goal='External updated goal';
  for(const listener of f.listeners)listener({type:'planning.updated'});
  await new Promise(resolve=>setTimeout(resolve,650));await settle();
  assert.equal(f.$('#next-planning-goal').value,'Local unfinished goal');assert.equal(f.document.activeElement,f.$('#next-planning-goal'));
  assert.equal(f.$('#next-planning-goal').selectionStart,3);assert.equal(f.$('#next-planning-goal').selectionEnd,8);
  assert.match(f.$('#next-planning-detail').textContent,/The saved plan changed/);assert.match(f.$('#next-planning-detail').textContent,/Keep draft against latest version/);
  f.plans[0].bucket='deleted';f.plans[0].editable=false;
  for(const listener of f.listeners)listener({type:'conversations.changed',data:{rootId:'a',state:'deleted'}});
  await new Promise(resolve=>setTimeout(resolve,650));await settle();
  assert.equal(f.$('#next-planning-goal').value,'Local unfinished goal');assert.equal(f.$('#next-planning-goal').readOnly,true);
  assert.ok(f.$('#next-planning-detail').querySelector('[data-plan-action="restore"]'));
  assert.equal(f.$('#next-planning-detail').querySelector('[data-plan-action="archive"]'),null);
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
  assert.ok(f.calls.some(call=>call.path.includes('taskId=a')&&call.path.includes('state=deleted')));
});

test('a successful schedule Save immediately restores live schedule controls after its own refresh',async t=>{
  const schedules=[],workflow={id:'fixture-flow',name:'Fixture flow',nodes:[],edges:[]};
  const f=fixture(t,{tasksWorkspace:true,request:async(call,backend)=>{
    if(call.path==='/api/operations')return{status:{healthy:true,paused:false},deployments:structuredClone(schedules),jobs:[]};
    if(call.path==='/api/workflows?view=index')return[{id:workflow.id,name:workflow.name}];
    if(call.path==='/api/workflows/'+workflow.id)return workflow;
    if(call.path==='/api/operations/deployments'&&call.method==='POST'){
      schedules.push({...call.payload,id:'new-schedule',revision:1});return schedules[0];
    }
    return backend(call.path,call.method,call.payload);
  }});f.component.enter();await settle();
  await f.click('#next-tasks-tab-schedules');await settle();
  await f.input('[name="name"]','New schedule');await f.input('[name="input"]','Only explicit work');await f.input('[name="cwd"]','C:\\fixture');
  await f.$('#next-tasks-form').dispatch('submit');await settle();
  assert.equal(schedules.length,1);assert.equal(f.$('#next-tasks-form').inert,false);
  const controls=f.$('#next-tasks-deployments').querySelectorAll('button');assert.equal(controls.length,3);assert.ok(controls.every(node=>!node.disabled));
});
