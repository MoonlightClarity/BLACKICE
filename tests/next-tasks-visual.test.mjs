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
        ticker:{state:'running',lastAttemptAt:'2026-10-25T10:02:00Z',lastSuccessAt:'2026-10-25T10:02:00Z'}},
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
    events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},getStatus:()=>({cwd:'C:\\fixture'}),
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
  for(const fragment of ['Scheduled review','0 9 * * *','America/New_York','gpt-6-luna','Review saved evidence','schedule-a','Saved job history (80)'])
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
  set('expression','30 10 * * MON-FRI');set('timezone','America/New_York');
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

test('Saved job receipts are expandable without a run-history fetch',async t=>{
  const f=fixture(t);f.component.enter();await settle();await f.clickReady('#next-tasks-tab-jobs');
  const receipt=f.$('[data-job-inspect="job-0"]');
  assert.ok(receipt);assert.match(receipt.textContent,/Job ID|Source|Schedule revision|Attempt 2/);
  assert.equal(f.calls.some(call=>call.path==='/api/runs'),false);
});
