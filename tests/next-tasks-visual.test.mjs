import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_BOARD_LANES,savedTaskLane,savedTaskStatus,taskBoard,jobLinkedRun } from '../public/next/workspaces/tasks-visual-model.mjs';
import { createTasksWorkspace } from '../public/next/workspaces/tasks.mjs';
import { createTaskHistory } from '../public/next/workspaces/task-lifecycle.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{history=false,presentation='board',hook,status={},operationsStatus={}}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
  prototype.replaceChildren=function(...nodes){for(const child of [...this.children])child.remove();this.rawText='';this.append(...nodes);};
  Object.defineProperty(prototype,'elements',{get(){const fields=this.querySelectorAll('[name]');return new Proxy(fields,{get:(target,name)=>name==='namedItem'?id=>fields.find(field=>field.name===id):name in target?Reflect.get(target,name):fields.find(field=>field.name===name)});},configurable:true});
  Object.defineProperty(prototype,'options',{get(){return this.children;},configurable:true});
  const matches=prototype.matches;prototype.matches=function(selector){return matches.call(this,selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g,'[$1="$2"]'));};
  prototype.click=function(){if(!this.disabled)void this.dispatch('click',{},true);};
  const calls=[],listeners=new Set(),navigation=[],notifications=[];
  const tasks=['running','failed','completed',undefined].map((status,index)=>({id:'task-'+index,taskId:'task-'+index,title:'Saved task '+index,status,state:'active',settled:status!=='running',updatedAt:'2026-10-25T10:00:00Z'}));
  const schedule={id:'schedule-a',name:'Scheduled review',revision:1,enabled:false,
    trigger:{type:'cron',expression:'0 9 * * *',timezone:'America/New_York'},input:'Review saved evidence',cwd:'C:\\fixture',overlap:'skip',
    retry:{maxAttempts:0,backoffSeconds:30},limits:{maxIterations:null,runForSeconds:null,endAt:null},attachmentIds:['source-file'],
    workflow:{id:'schedule-workflow',name:'Source review',nodes:[
      {id:'input',type:'input',name:'Task'},
      {id:'agent',type:'agent',name:'Reviewer',model:'gpt-6-luna',effort:'high',prompt:'Review the evidence honestly.'},
      {id:'output',type:'output',name:'Report'}
    ],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}}};
  const removedSchedules=[{id:'old-jobsearch',name:'Previous daily search',revision:2,removedAt:'2026-10-27T10:22:25.610Z',removedBy:'not-recorded',changeHistory:[]}];
  const workflow={id:'workflow-a',name:'Saved workflow',nodes:[],edges:[]};
  const jobs=Array.from({length:80},(_,index)=>({id:'job-'+index,deploymentId:schedule.id,status:index===0?'failed':'completed',createdAt:'2026-10-25T10:00:00Z',
    attempts:[{number:1,runId:'original-'+index,status:'failed'},{number:2,runId:'actual-'+index,status:index===0?'failed':'completed'}]}));
  jobs[0].delivery={destination:'local-inbox',state:'available',revision:2,jobId:'job-0',
    createdAt:'2026-10-25T10:00:00Z',availableAt:'2026-10-25T10:03:00Z',acknowledgedAt:null,
    sourceRunId:'actual-0',outcome:'failed',error:'A verification step failed.',
    preview:'Read the captured evidence before retrying.',previewTruncated:false,previewCharacters:44};
  const api=async(path,method='GET',payload)=>{
    calls.push({path,method,payload});const url=new URL(path,'http://fixture.local');
    if(hook){const result=await hook({path,method,payload},{schedule,jobs,tasks,workflow});if(result!==undefined)return result;}
    if(url.pathname==='/api/conversations/search'){
      const offset=Number(url.searchParams.get('offset')||0),query=url.searchParams.get('q').toLowerCase();
      const matching=tasks.filter(item=>item.state===url.searchParams.get('state')&&item.title.toLowerCase().includes(query));
      return{conversations:structuredClone(matching.slice(offset,offset+40)),hasMore:offset+40<matching.length};
    }
    const lifecycle=path.match(/^\/api\/conversations\/(task-\d+)\/(archive|delete|restore)$/);
    if(lifecycle&&method==='POST'){tasks.find(item=>item.id===lifecycle[1]).state={archive:'archived',delete:'deleted',restore:'active'}[lifecycle[2]];return{rootId:lifecycle[1]};}
    if(path==='/api/operations'){
      const found=jobs.filter(item=>item.delivery?.destination==='local-inbox'&&['available','acknowledged'].includes(item.delivery.state));
      return{status:{healthy:true,paused:false,enabled:0,running:0,availableResults:found.filter(item=>item.delivery.state==='available').length,
        ticker:{state:'running',lastAttemptAt:'2026-10-25T10:02:00Z',lastSuccessAt:'2026-10-25T10:02:00Z'},...operationsStatus},
        deployments:[structuredClone(schedule)],removedDeployments:structuredClone(removedSchedules),jobs:structuredClone(jobs),
        results:{total:found.length,available:found.filter(item=>item.delivery.state==='available').length,
          acknowledged:found.filter(item=>item.delivery.state==='acknowledged').length,
          items:found.map(item=>({id:item.id,deploymentName:'Scheduled review',status:item.status,delivery:structuredClone(item.delivery)}))}};
    }
    if(path==='/api/workflows?view=index')return[{id:workflow.id,name:workflow.name}];
    if(path==='/api/workflows/'+workflow.id)return structuredClone(workflow);
    if(path==='/api/operations/jobs/job-0/acknowledge'&&method==='POST'){
      const d=jobs[0].delivery;
      if(d.state!=='acknowledged'&&payload.expectedRevision!==d.revision)throw Error('Result revision changed');
      if(d.state!=='acknowledged'){d.state='acknowledged';d.revision++;d.acknowledgedAt='2026-10-25T10:04:00Z';}
      return{jobId:'job-0',delivery:structuredClone(d)};
    }
    if(path==='/api/operations/deployments/schedule-a'&&method==='PUT'){
      if(payload.expectedRevision!==schedule.revision)throw Error('The deployment changed. Reload before saving (409).');
      const {expectedRevision,...update}=payload;Object.assign(schedule,structuredClone(update));schedule.revision++;return structuredClone(schedule);
    }
    if(path==='/api/operations/schedule-preview'&&method==='POST')return{occurrences:[{local:'Oct 28, 2026, 9:00 AM EDT'}]};
    if(path==='/api/operations/deployments'&&method==='POST')return{id:'created-schedule'};
    if(path.startsWith('/api/operations/')&&method==='POST')return{ok:true};
    throw Error('Unexpected '+method+' '+path);
  };
  const component=(history?createTaskHistory:createTasksWorkspace)({mount:dom.mount,api,presentation,
    events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},getStatus:()=>({cwd:'C:\\fixture',...status}),
    notify:(...args)=>notifications.push(args),onNavigate:(...args)=>navigation.push(args)});
  t.after(()=>component.destroy());
  return{...dom,component,calls,listeners,tasks,jobs,schedule,removedSchedules,navigation,notifications,async clickReady(selector){await dom.click(selector);await settle();}};
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
  assert.equal(f.$('#next-tasks-tab-timeline').getAttribute('aria-selected'),'true');
  assert.equal(f.$('#next-tasks-panel-timeline').hidden,false);assert.equal(f.listeners.size,2);
  assert.equal(f.$('#next-tasks-timeline').dataset.taskPresentation,'timeline');
  await f.key(f.$('#next-tasks-tab-timeline'),'End');await settle();
  await f.key(f.$('#next-tasks-tab-jobs'),'ArrowLeft');await settle();
  await f.key(f.$('#next-tasks-tab-results'),'ArrowLeft');await settle();
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

test('Results are locally available without claiming delivery or auto-acknowledging a read',async t=>{
  const f=fixture(t);f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-results');
  assert.match(f.$('#next-tasks-results-count').textContent,/1 awaiting review/);
  assert.match(f.$('#next-tasks-results').textContent,/A verification step failed/);
  assert.match(f.$('#next-tasks-results').textContent,/Read the captured evidence/);
  assert.equal(f.$('[data-result-job-id="job-0"]')!==null,true);
  await f.clickReady('[data-result-run-id="actual-0"]');
  assert.deepEqual(f.navigation.at(-1),['chat',{conversationId:'actual-0'}]);
  assert.equal(f.jobs[0].delivery.state,'available','opening the run is not user acknowledgement');
  assert.equal(f.calls.some(item=>item.method!=='GET'),false);
  await f.clickReady('[data-result-acknowledge="job-0"]');
  assert.equal(f.jobs[0].delivery.state,'acknowledged');
  assert.equal(f.jobs[0].delivery.revision,3);
  assert.equal(f.calls.filter(item=>item.method==='POST').length,1);
  const request=f.calls.find(item=>item.method==='POST');
  assert.equal(request.path,'/api/operations/jobs/job-0/acknowledge');
  assert.deepEqual(request.payload,{expectedRevision:2});
  assert.match(f.$('#next-tasks-results-count').textContent,/0 awaiting review/);
  assert.equal(f.$('[data-result-acknowledge="job-0"]'),null);
  assert.match(f.$('#next-tasks-results').textContent,/Reviewed:/);
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

test('Removed schedules remain inspectable as source-limited historical entries without rearming',async t=>{
  const f=fixture(t);f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  const history=f.$('#next-tasks-removed');
  assert.equal(history.hidden,false);
  assert.match(history.textContent,/Previous daily search/);
  assert.match(history.textContent,/not-recorded/);
  assert.match(history.textContent,/does not identify who removed/);
  assert.equal(f.calls.some(item=>item.method!=='GET'),false);
  assert.equal(f.schedule.enabled,false);
});
test('Schedules inspection shows saved cron, model, instructions and linked receipts without writes',async t=>{
  const f=fixture(t);f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');await f.clickReady('[data-schedule-inspect="schedule-a"]');
  const detail=f.$('#next-tasks-schedule-detail');
  assert.equal(detail.hidden,false);
  for(const fragment of ['Scheduled review','Daily at 9:00 AM','America/New_York','gpt-6-luna','Review saved evidence','schedule-a','Saved job history (80)'])
    assert.ok(detail.textContent.includes(fragment),fragment+' visible in inspection');
  assert.ok(f.$('[data-schedule-run-id="actual-0"]'));
  await f.clickReady('[data-schedule-run-id="actual-0"]');
  assert.deepEqual(f.navigation.at(-1),['chat',{conversationId:'actual-0'}]);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  await f.clickReady('[data-schedule-inspect-preview="schedule-a"]');
  assert.match(detail.textContent,/Oct 28, 2026, 9:00 AM EDT/);
  assert.equal(f.calls.some(call=>call.method==='PUT'),false,'inspection preview is read-only');
  await f.clickReady('[data-schedule-close="schedule-a"]');assert.equal(detail.hidden,true);
});

test('Schedules surface overdue time, ticker health and durable collapsed-slot evidence',async t=>{
  const f=fixture(t);
  f.schedule.overdue=true;f.schedule.overdueSince='2026-10-25T09:00:00Z';
  f.schedule.occurrenceHistory=[
    {kind:'admitted',scheduledAt:1792918800000,observedAt:1792918850000,jobId:'job-0'},
    {kind:'skipped',scheduledAt:1792922400000,throughAt:1792944000000,observedAt:1792944000000,reason:'backlog-collapsed'}
  ];
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  assert.match(f.$('#next-tasks-deployments').textContent,/Overdue since/);
  await f.clickReady('[data-schedule-inspect="schedule-a"]');
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/Last successful tick/);
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/backlog-collapsed/);
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/Recent scheduled occurrences/);
  assert.equal(f.calls.some(item=>item.method!=='GET'),false);
});

test('schedule creation requires an explicit outbound selection and keeps local results the default',async t=>{
  const f=fixture(t);f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form'),type=form.querySelector('[name=outboundType]'),url=form.querySelector('[name=outboundUrl]');
  assert.equal(type.value,'local');
  assert.equal(url.closest('label').hidden,true);
  const recovery=form.querySelector('[name=catchUpPolicy]'),age=form.querySelector('[name=catchUpMaxAge]');
  assert.equal(recovery.value,'skip');
  assert.equal(age.closest('label').hidden,true);
  form.querySelector('[name=name]').value='Research delivery fixture';
  form.querySelector('[name=input]').value='Read and summarize the original research.';
  await form.dispatch('submit');await settle();
  const created=f.calls.filter(call=>call.method==='POST'&&call.path==='/api/operations/deployments');
  assert.equal(created.length,1);
  assert.deepEqual(created[0].payload.deliveryTarget,{type:'local'});
  assert.deepEqual(created[0].payload.missedRunPolicy,{onResume:'skip',maxAgeSeconds:86400});
  recovery.value='once';await recovery.dispatch('change',{},true);
  age.value='3600';assert.equal(age.closest('label').hidden,false);
  type.value='webhook';await type.dispatch('change',{},true);
  assert.equal(url.closest('label').hidden,false);
  url.value='https://alerts.example.com/private/token';
  form.querySelector('[name=name]').value='Webhook research';
  form.querySelector('[name=input]').value='Review more original evidence.';
  await form.dispatch('submit');await settle();
  const second=f.calls.filter(call=>call.method==='POST'&&call.path==='/api/operations/deployments');
  assert.equal(second.length,2);
  assert.deepEqual(second[1].payload.deliveryTarget,{type:'webhook',url:'https://alerts.example.com/private/token'});
  assert.deepEqual(second[1].payload.missedRunPolicy,{onResume:'once',maxAgeSeconds:3600});
  assert.equal(url.value,'','secret URL field clears on successful save');
  assert.equal(type.value,'local','default returns to local for the next schedule');
});

test('schedule inspection and edits keep the configured webhook path private',async t=>{
  const f=fixture(t);
  f.schedule.deliveryTarget={type:'webhook',host:'alerts.example.com',configured:true};
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-inspect="schedule-a"]');
  const detail=f.$('#next-tasks-schedule-detail');
  assert.match(detail.textContent,/HTTPS webhook configured at alerts\.example\.com/);
  assert.equal(detail.textContent.includes('private/token'),false);
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]');
  assert.equal(form.querySelector('[name=outboundType]').value,'webhook');
  assert.equal(form.querySelector('[name=outboundUrl]').value,'');
  await form.dispatch('submit');await settle();
  const update=f.calls.find(call=>call.method==='PUT');
  assert.ok(update);
  assert.equal(Object.hasOwn(update.payload,'deliveryTarget'),false,'omitting a new URL preserves the pinned secret in storage');
});

test('Schedule editor previews changes, preserves pinned attachments and only writes on Save',async t=>{
  const f=fixture(t);f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');await f.clickReady('[data-schedule-inspect="schedule-a"]');
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]');assert.ok(form);
  const set=(key,value)=>{const el=form.querySelector('[name="'+key+'"]');assert.ok(el,key);el.value=value;};
  set('name','Daily research');set('input','Check original evidence and write fresh leads.');
  set('triggerType','cron');set('expression','30 10 * * MON-FRI');set('timezone','America/New_York');
  set('maxAttempts','1');set('backoffSeconds','45');set('maxIterations','12');
  set('overlap','queue');set('agentModel','gpt-6-luna');set('agentEffort','ultra');
  form.querySelector('[name="enabled"]').checked=true;
  assert.equal(f.calls.some(call=>call.method==='PUT'),false,'opening editor writes nothing');
  await f.clickReady('[data-schedule-preview="schedule-a"]');
  assert.match(form.textContent,/Oct 28, 2026, 9:00 AM EDT/);
  assert.equal(f.calls.some(call=>call.method==='PUT'),false,'preview writes nothing');
  await form.dispatch('submit');await settle();
  const call=f.calls.find(item=>item.method==='PUT');
  assert.equal(call.path,'/api/operations/deployments/schedule-a');
  assert.equal(call.payload.expectedRevision,1);
  assert.deepEqual(call.payload.trigger,{type:'cron',expression:'30 10 * * MON-FRI',timezone:'America/New_York'});
  assert.equal(call.payload.overlap,'queue');assert.equal(call.payload.retry.backoffSeconds,45);
  assert.equal(call.payload.limits.maxIterations,12);
  assert.equal(call.payload.workflow.nodes.find(node=>node.type==='agent').effort,'ultra');
  assert.equal(Object.hasOwn(call.payload,'attachmentIds'),false);
  assert.deepEqual(f.schedule.attachmentIds,['source-file']);
  assert.equal(f.schedule.revision,2);assert.equal(f.schedule.enabled,true);
  assert.ok(f.$('[data-schedule-edit-open="schedule-a"]'));
});

test('Schedule revision conflicts preserve unsaved edits until explicit reload',async t=>{
  const f=fixture(t);f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');await f.clickReady('[data-schedule-inspect="schedule-a"]');
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]'),name=form.querySelector('[name="name"]');
  name.value='Keep local draft';
  await f.clickReady('#next-tasks-tab-board');await f.clickReady('#next-tasks-tab-schedules');
  assert.strictEqual(f.$('[data-schedule-edit="schedule-a"]'),form,'refresh preserves form');
  f.schedule.revision=3;
  await f.clickReady('#next-tasks-refresh');
  assert.strictEqual(f.$('[data-schedule-edit="schedule-a"]'),form);
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/changed after you opened the editor/i);
  await form.dispatch('submit');await settle();
  assert.strictEqual(f.$('[data-schedule-edit="schedule-a"]'),form);
  assert.equal(name.value,'Keep local draft');
  assert.match(form.textContent,/Reload before saving/i);
  await f.clickReady('[data-schedule-reload="schedule-a"]');
  assert.notStrictEqual(f.$('[data-schedule-edit="schedule-a"]'),form);
  assert.equal(f.$('[data-schedule-edit="schedule-a"]').querySelector('[name="name"]').value,'Scheduled review');
  assert.equal(f.schedule.revision,3);
});

test('a timing edit preserves the legacy Chat context preset with an unavailable model catalog',async t=>{
  const f=fixture(t);
  const agent=f.schedule.workflow.nodes.find(node=>node.type==='agent');
  agent.context={preset:'900k',windowTokens:900000,autoCompact:false};
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-inspect="schedule-a"]');
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]');
  assert.equal(form.elements.contextPreset.value,'900k');
  form.elements.time.value='10:00';
  await form.dispatch('submit');await settle();
  const {payload}=f.calls.find(call=>call.method==='PUT');
  assert.equal(payload.trigger.expression,'0 10 * * *');
  assert.equal(Object.hasOwn(payload,'workflow'),false);
});

test('Saved job receipts are expandable without a run-history fetch',async t=>{
  const f=fixture(t);f.component.enter();await settle();await f.clickReady('#next-tasks-tab-jobs');
  const receipt=f.$('[data-job-inspect="job-0"]');
  assert.ok(receipt);assert.match(receipt.textContent,/Job ID|Source|Schedule revision|Attempt 2/);
  assert.equal(f.calls.some(call=>call.path==='/api/runs'),false);
});

const readinessGraph=(schedule,state='awaiting_input')=>({id:'readiness-request',viability:{nodeId:'viability',deploymentId:schedule.id},
  nodes:[{id:'viability',readiness:{state,viability:{state,blockingFacts:[{id:'address',question:'Which address should the report use?',consequence:'The report requires your actual address.'}],issues:state==='needs_evidence'?['Read the supplied document before deciding whether the address is missing.']:[]}}}],
  viabilityAction:{deployment:structuredClone(schedule)}});

test('an explicit schedule readiness check preserves disabled state and links the exact saved Planning request',async t=>{
  const f=fixture(t,{hook:async(call,{schedule})=>{
    if(call.path==='/api/operations/deployments/schedule-a/readiness'){
      schedule.revision++;schedule.viabilityRef={requestId:'readiness-request',responseId:'readiness-response'};
      return readinessGraph(schedule);
    }
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  assert.equal(f.calls.some(call=>call.path.endsWith('/readiness')),false);
  await f.clickReady('[data-schedule-readiness="schedule-a"]');
  assert.equal(f.schedule.enabled,false);
  assert.match(f.$('#next-tasks-deployments').textContent,/Which address should the report use/);
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);
  assert.deepEqual(f.calls.find(call=>call.path.endsWith('/readiness')).payload,{});
  await f.clickReady('[data-schedule-readiness-open="schedule-a"]');
  assert.deepEqual(f.navigation.at(-1),['planning',{requestId:'readiness-request',nodeId:'viability'}]);
  assert.equal(f.calls.some(call=>call.path.endsWith('/trigger')),false);
});

test('Run now checks a draft and admits one job without enabling recurrence',async t=>{
  let triggerCalls=0;
  const f=fixture(t,{hook:async(call,{schedule})=>{
    if(call.path.endsWith('/trigger')&&++triggerCalls===1)throw Object.assign(Error('Readiness required'),{code:'TASK_VIABILITY_REQUIRED'});
    if(call.path.endsWith('/readiness')){
      schedule.revision++;
      const graph=readinessGraph(schedule,'ready');
      graph.viabilityAction.canRun=true;
      return graph;
    }
    if(call.path.endsWith('/trigger'))return{id:'new-job',status:'queued'};
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-trigger="schedule-a"]');
  const actions=f.calls.filter(call=>call.method==='POST');
  assert.deepEqual(actions.map(call=>call.path.split('/').at(-1)),['trigger','readiness','trigger']);
  assert.ok(actions[0].payload.idempotencyKey);
  assert.equal(actions[2].payload.idempotencyKey,actions[0].payload.idempotencyKey);
  assert.equal(f.schedule.enabled,false);
  assert.match(f.$('#next-tasks-info').textContent,/Run requested.*Job history/);
});

test('Run now shows the actual missing fact and does not send a second trigger',async t=>{
  const f=fixture(t,{hook:async(call,{schedule})=>{
    if(call.path.endsWith('/trigger'))throw Object.assign(Error('Readiness required'),{code:'TASK_VIABILITY_REQUIRED'});
    if(call.path.endsWith('/readiness'))return readinessGraph(schedule);
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-trigger="schedule-a"]');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/trigger')).length,1);
  assert.match(f.$('#next-tasks-info').textContent,/job did not start/);
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/Which address should the report use/);
});

test('Run now explains a failed readiness check without leaking provider details',async t=>{
  const f=fixture(t,{hook:async call=>{
    if(call.path.endsWith('/trigger'))throw Object.assign(Error('Readiness required'),{code:'TASK_VIABILITY_REQUIRED'});
    if(call.path.endsWith('/readiness'))throw Object.assign(Error('invalid_json_schema: uniqueItems'),{code:'TASK_VIABILITY_INFERENCE_FAILED'});
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-trigger="schedule-a"]');
  const message=f.$('#next-tasks-info').textContent;
  assert.match(message,/could not finish checking.*schedule is still saved.*No job was started/);
  assert.doesNotMatch(message,/invalid_json_schema|uniqueItems/);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/trigger')).length,1);
});

test('an uncertain Run now response is never retried or mistaken for a readiness rejection',async t=>{
  const f=fixture(t,{hook:async call=>{
    if(call.path.endsWith('/trigger'))throw Object.assign(Error('Connection timed out'),{uncertain:true});
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-trigger="schedule-a"]');
  assert.deepEqual(f.calls.filter(call=>call.method==='POST').map(call=>call.path.split('/').at(-1)),['trigger']);
  assert.match(f.$('#next-tasks-info').textContent,/Check Job history before trying again/);
});

test('a paused Run now points to the action that resumes both the scheduler and task inbox',async t=>{
  const operationsStatus={paused:true,blockedReason:'Emergency stop requested. Resume the inbox when ready.'};
  const f=fixture(t,{operationsStatus,hook:async call=>{
    if(call.path.endsWith('/trigger'))return{id:'new-job',status:'queued'};
    if(call.path.endsWith('/resume')){
      assert.deepEqual(call.payload,{resumeInbox:true});
      Object.assign(operationsStatus,{paused:false,blockedReason:null});
      return operationsStatus;
    }
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-trigger="schedule-a"]');
  assert.match(f.$('#next-tasks-info').textContent,/Run queued.*Resume schedules and inbox/);
  assert.equal(f.$('#next-tasks-resume').textContent,'Resume schedules and inbox');
  await f.clickReady('#next-tasks-resume');
  assert.match(f.$('#next-tasks-info').textContent,/Schedules ready/);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/trigger')).length,1);
});

test('job summaries translate incompatible model requests while keeping the exact receipt',async t=>{
  const detail='{"error":{"code":"invalid_json_schema","message":"criteria.items.not is unsupported"}}';
  const f=fixture(t,{hook:async(call,{jobs})=>{
    if(call.path==='/api/operations'){jobs[0].error=detail;jobs[0].delivery.error=detail;}
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-jobs');
  const row=f.$('[data-job-id="job-0"]');
  assert.match(row.querySelector('.next-task-job-meta').textContent,/BLACKICE sent a request the model could not accept/);
  assert.doesNotMatch(row.querySelector('.next-task-job-meta').textContent,/invalid_json_schema/);
  assert.match(row.querySelector('details').textContent,/invalid_json_schema/);
  await f.clickReady('#next-tasks-tab-results');
  assert.doesNotMatch(f.$('#next-tasks-results').textContent,/invalid_json_schema/);
});

test('a blocked Enable shows returned factual questions and never claims the schedule was enabled',async t=>{
  const f=fixture(t,{hook:async(call,{schedule})=>{
    if(call.path==='/api/operations/deployments/schedule-a'&&call.method==='PUT'){
      assert.equal(call.payload.enabled,true);schedule.revision++;schedule.enabled=false;
      return {...structuredClone(schedule),readiness:{state:'awaiting_input',requestId:'readiness-request',question:'Which address should the report use?'}};
    }
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-toggle="schedule-a"]');
  assert.equal(f.schedule.enabled,false);assert.equal(f.$('[data-schedule-toggle="schedule-a"]').textContent,'Enable');
  assert.match(f.$('#next-tasks-schedule-detail').textContent,/Which address should the report use/);
  assert.match(f.notifications.at(-1)[0],/disabled draft/);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
  assert.equal(f.calls.some(call=>call.path.endsWith('/trigger')),false);
});

test('enabled creation that returns a disabled draft displays the actual result and its Planning link',async t=>{
  const f=fixture(t,{hook:async(call,{schedule})=>{
    if(call.path==='/api/operations/deployments'&&call.method==='POST'){
      assert.equal(call.payload.enabled,true);Object.assign(schedule,{name:call.payload.name,input:call.payload.input,enabled:false,revision:2});
      return {...structuredClone(schedule),readiness:{state:'awaiting_input',requestId:'readiness-request',question:'Which address should the report use?'}};
    }
  }});f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form');form.querySelector('[name=name]').value='New report';form.querySelector('[name=input]').value='Prepare the report';form.querySelector('[name=enabled]').checked=true;
  await form.dispatch('submit');await settle();
  assert.equal(form.querySelector('[name=enabled]').checked,false);
  assert.match(f.$('#next-tasks-preview-output').textContent,/disabled draft.*Which address/s);
  assert.ok(f.$('[data-schedule-readiness-open="schedule-a"]'));
  assert.equal(f.calls.filter(call=>call.path==='/api/operations/deployments'&&call.method==='POST').length,1);
});

test('source recovery is shown before personal factual questions and checking alone never triggers a schedule',async t=>{
  const f=fixture(t,{hook:async(call,{schedule})=>call.path.endsWith('/readiness')?readinessGraph(schedule,'needs_evidence'):undefined});
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-readiness="schedule-a"]');
  const card=f.$('[data-schedule-readiness-state="needs_evidence"]');
  assert.match(card.textContent,/Read the supplied document/);assert.doesNotMatch(card.textContent,/Which address should/);
  assert.equal(f.calls.some(call=>call.method==='PUT'||call.path.endsWith('/trigger')),false);
});

test('human scheduling controls create exact repeating intervals and reveal cron only when chosen',async t=>{
  const f=fixture(t);
  f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form'),fields=form.elements;
  assert.equal(fields.trigger.value,'daily');
  assert.equal(fields.intervalAmount.disabled,true);
  fields.trigger.value='interval';await fields.trigger.dispatch('change',{},true);
  assert.equal(fields.intervalAmount.value,'30');
  assert.equal(fields.intervalUnit.value,'minutes');
  assert.equal(fields.intervalAmount.disabled,false);
  assert.equal(form.querySelector('[data-schedule-for="interval"]').hidden,false);
  assert.equal(form.querySelector('[data-schedule-for="cron"]').hidden,true);
  fields.name.value='Repeating source review';
  fields.input.value='Review original evidence.';
  await form.dispatch('submit');await settle();
  const created=f.calls.find(call=>call.path==='/api/operations/deployments'&&call.method==='POST');
  assert.ok(created);
  assert.deepEqual(created.payload.trigger,{type:'interval',everySeconds:1800});
  fields.trigger.value='daily';await fields.trigger.dispatch('change',{},true);
  assert.equal(form.querySelector('[data-schedule-for="interval"]').hidden,true);
  assert.equal(fields.intervalAmount.disabled,true);
  assert.equal(form.querySelector('[name=time]').closest('label').hidden,false);
  fields.trigger.value='cron';await fields.trigger.dispatch('change',{},true);
  assert.equal(form.querySelector('[data-schedule-for="cron"]').hidden,false);
  assert.equal(form.querySelector('[data-schedule-for="interval"]').hidden,true);
});

test('schedule creation uses the device time zone and shows intervals in local time',async t=>{
  const occurrence=new Date('2026-11-09T18:00:00.000Z');
  const f=fixture(t,{hook:call=>{
    if(call.path==='/api/operations/schedule-preview'){
      const iso=occurrence.toISOString();
      return {occurrences:[{at:occurrence.getTime(),iso,local:iso}]};
    }
  }});
  f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');
  const fields=f.$('#next-tasks-form').elements;
  assert.equal(fields.timezone.value,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  fields.trigger.value='interval';await fields.trigger.dispatch('change',{},true);
  await f.clickReady('#next-tasks-preview');
  assert.equal(f.$('#next-tasks-preview-output').textContent,occurrence.toLocaleString());
});

test('editing clock-aligned cron shows readable timing before any technical expression',async t=>{
  const f=fixture(t);
  f.schedule.trigger={type:'cron',expression:'*/15 * * * *',timezone:'America/New_York'};
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  assert.match(f.$('#next-tasks-deployments').textContent,/Every 15 minutes/);
  await f.clickReady('[data-schedule-inspect="schedule-a"]');
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]');
  assert.equal(form.elements.triggerType.value,'cron');
  assert.equal(form.querySelector('[name=expression]').closest('label').hidden,true);
  assert.match(form.textContent,/Current timing: Every 15 minutes/);
  const technical=[...form.querySelectorAll('button')].find(b=>b.textContent==='Edit advanced cron expression');
  assert.ok(technical);
  await f.clickReady(technical);
  assert.equal(form.querySelector('[name=expression]').closest('label').hidden,false);
  assert.equal(form.elements.expression.value,'*/15 * * * *');
  assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});

const chatStatus={defaultModel:'gpt-6-luna',models:[
  {id:'gpt-6-luna',displayName:'GPT-6 Luna',available:true,providerId:'codex',
    supportsReasoningSelection:true,supportedReasoningEfforts:['default','high','ultra'],
    serviceTiers:[{id:'priority'}],contextWindowTokens:100000,maxContextWindowTokens:300000},
  {id:'gpt-5.6',displayName:'GPT-5.6',available:true,providerId:'codex',
    supportsReasoningSelection:true,supportedReasoningEfforts:['default','high','ultra'],
    serviceTiers:[{id:'priority'}],contextWindowTokens:100000,maxContextWindowTokens:300000},
],runtimeSettings:{defaultContext:{preset:'model',autoCompact:true}}};

test('new schedule configures Chat model, reasoning, speed, planning, execution and context without a saved workflow',async t=>{
  const f=fixture(t,{status:chatStatus});
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form'),fields=form.elements;
  assert.equal(fields.taskType.value,'chat');
  assert.equal(f.$('#next-tasks-workflow-fields').hidden,true);
  fields.name.value='Scheduled intelligence';
  fields.input.value='Review new evidence';
  fields.agentModel.value='gpt-6-luna';await fields.agentModel.dispatch('change',{},true);
  fields.agentEffort.value='high';
  fields.agentServiceTier.value='fast';
  fields.planningMode.value='forced';
  fields.planningExecutionMode.value='plan_only';
  fields.contextPreset.value='custom';await fields.contextPreset.dispatch('change',{},true);
  fields.contextWindowTokens.value='200000';
  fields.contextAutoCompact.checked=false;
  fields.contextCompactAtTokens.value='100000';
  await form.dispatch('submit');await settle();
  const call=f.calls.find(c=>c.path==='/api/operations/deployments'&&c.method==='POST');
  assert.ok(call,f.$('#next-tasks-preview-output').textContent);
  const {payload}=call,agent=payload.workflow.nodes.find(n=>n.type==='agent');
  assert.equal(payload.workflow.nodes.length,3);
  assert.equal(payload.input,'Review new evidence');
  assert.equal(payload.planningExecutionMode,'plan_only');
  assert.equal(agent.model,'gpt-6-luna');
  assert.equal(agent.effort,'high');
  assert.equal(agent.serviceTier,'fast');
  assert.equal(payload.workflow.settings.planningMode,'on');
  assert.equal(payload.workflow.settings.planningEnforcement,'forced');
  assert.equal(payload.workflow.settings.planningExecutionMode,'plan_only');
  assert.equal(payload.workflow.settings.context.windowTokens,200000);
  assert.equal(agent.context.autoCompact,false);
  assert.equal(agent.context.compactAtTokens,100000);
  assert.deepEqual(payload.attachmentIds,[]);
  assert.equal(f.calls.some(c=>c.path.startsWith('/api/workflows/')&&c.path!=='/api/workflows?view=index'),false);
});

test('Chat schedules infer their name from the task instead of requiring a second input',async t=>{
  const f=fixture(t,{status:chatStatus});f.component.enter();await settle();
  await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form');
  assert.equal(form.elements.name.hasAttribute('required'),false);
  form.elements.input.value='Daily competitive intelligence report\nPrioritize new evidence';
  await form.dispatch('submit');await settle();
  const saved=f.calls.find(call=>call.path==='/api/operations/deployments'&&call.method==='POST');
  assert.ok(saved);
  assert.equal(saved.payload.name,'Daily competitive intelligence report');
});

test('schedule explicitly using a saved workflow retains its own multi-agent configuration',async t=>{
  const f=fixture(t,{status:chatStatus});
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  const form=f.$('#next-tasks-form'),fields=form.elements;
  fields.taskType.value='workflow';await fields.taskType.dispatch('change',{},true);
  assert.equal(f.$('#next-tasks-workflow-fields').hidden,false);
  assert.equal(f.$('#next-tasks-chat-fields').hidden,true);
  fields.name.value='Saved research process';fields.input.value='Run existing process';
  await form.dispatch('submit');await settle();
  const call=f.calls.find(c=>c.path==='/api/operations/deployments'&&c.method==='POST');
  assert.ok(call,f.$('#next-tasks-preview-output').textContent);
  assert.equal(call.payload.workflow.id,'workflow-a');
  assert.equal(Object.hasOwn(call.payload,'planningExecutionMode'),false);
  assert.equal(f.calls.some(c=>c.path==='/api/workflows/workflow-a'),true);
});

test('editing a schedule updates Chat profile without altering pinned attachments or already admitted work',async t=>{
  const f=fixture(t,{status:chatStatus});
  f.component.enter();await settle();await f.clickReady('#next-tasks-tab-schedules');
  await f.clickReady('[data-schedule-inspect="schedule-a"]');
  await f.clickReady('[data-schedule-edit-open="schedule-a"]');
  const form=f.$('[data-schedule-edit="schedule-a"]'),fields=form.elements;
  fields.agentModel.value='gpt-5.6';await fields.agentModel.dispatch('change',{},true);
  fields.agentEffort.value='ultra';fields.agentServiceTier.value='fast';
  fields.planningMode.value='forced';fields.planningExecutionMode.value='plan_only';
  fields.contextPreset.value='custom';await fields.contextPreset.dispatch('change',{},true);
  fields.contextWindowTokens.value='200000';
  await form.dispatch('submit');await settle();
  const call=f.calls.find(c=>c.path==='/api/operations/deployments/schedule-a'&&c.method==='PUT');
  assert.ok(call,form.textContent.slice(-500));
  assert.equal(call.payload.planningExecutionMode,'plan_only');
  const agent=call.payload.workflow.nodes.find(n=>n.type==='agent');
  assert.equal(agent.model,'gpt-5.6');
  assert.equal(agent.effort,'ultra');
  assert.equal(agent.serviceTier,'fast');
  assert.equal(call.payload.workflow.settings.planningEnforcement,'forced');
  assert.equal(call.payload.workflow.settings.planningExecutionMode,'plan_only');
  assert.equal(agent.context.windowTokens,200000);
  assert.equal(Object.hasOwn(call.payload,'attachmentIds'),false);
  assert.deepEqual(f.schedule.attachmentIds,['source-file']);
  assert.equal(f.schedule.revision,2);
});
