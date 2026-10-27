import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTSchedulesAPI } from '../lib/chatgpt-schedules.mjs';
import { CHATGPT_OAUTH_SCOPES } from '../lib/chatgpt-oauth.mjs';

function fixture(){
  const writes=[],previews=[],runs=new Map();
  const schedule={
    id:'schedule-one',revision:4,name:'Daily search',input:'Find current roles',cwd:'C:\\work',enabled:true,
    trigger:{type:'cron',expression:'0 9 * * *',timezone:'America/New_York'},nextAt:1793106000000,
    overlap:'skip',retry:{maxAttempts:1,backoffSeconds:30},limits:{maxIterations:10,runForSeconds:3600,endAt:null},
    attachmentIds:['source-document'],admittedJobs:3,
    workflow:{id:'workflow-one',name:'Search worker',nodes:[
      {id:'input',type:'input',name:'Task'},
      {id:'agent',type:'agent',name:'Search',model:'gpt-6-luna',prompt:'Use original evidence.',effort:'high'},
      {id:'output',type:'output',name:'Results'}
    ],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}}
  };
  const jobs=[
    {id:'job-newest',deploymentId:'schedule-one',deploymentRevision:4,source:'manual',status:'running',createdAt:'2026-10-27T10:10:10Z',
      attempts:[{number:1,runId:'real-run',status:'running'}],definition:{workflow:{nodes:[{type:'agent',model:'gpt-6-luna'}]}}},
    {id:'job-older',deploymentId:'schedule-one',deploymentRevision:3,source:'cron',status:'completed',createdAt:'2026-10-26T10:10:10Z',
      attempts:[{number:1,runId:'older-run',status:'completed'}]},
    {id:'different',deploymentId:'another',status:'failed'}
  ];
  jobs[1].delivery={destination:'local-inbox',state:'available',revision:2,jobId:'job-older',
    availableAt:'2026-10-26T10:15:00Z',acknowledgedAt:null,outcome:'completed',sourceRunId:'older-run',
    preview:'A verified local result, not a pushed message.',previewTruncated:false,previewCharacters:46};
  const operations={
    list:()=>[structuredClone(schedule)],
    removedDeployments:()=>[{id:'old-search',name:'Removed daily search',removedAt:'2026-10-27T10:22:25Z',removedBy:'not-recorded',revision:2}],
    getDeployment:id=>{if(id!==schedule.id)throw Error('Schedule not found');return structuredClone(schedule);},
    status:()=>({paused:false,blockedReason:null,healthy:true}),
    snapshot:()=>({jobs:structuredClone(jobs)}),
    previewSchedule:value=>{previews.push(value);return{trigger:value.trigger,occurrences:[{local:'Oct 28, 2026, 9:00 AM EDT'}]};},
    update:async(id,update)=>{
      if(id!==schedule.id||update.expectedRevision!==schedule.revision)throw Error('Revision changed');
      writes.push(structuredClone(update));const {expectedRevision,...fields}=update;Object.assign(schedule,structuredClone(fields));schedule.revision++;return structuredClone(schedule);
    },
    trigger:async(id,value)=>{
      if(id!==schedule.id)throw Error('Schedule not found');
      if(runs.has(value.idempotencyKey))return runs.get(value.idempotencyKey);
      const item={id:'new-job',deploymentId:id,source:'manual',status:'queued',createdAt:'2026-10-27T10:11:00Z',attempts:[]};
      runs.set(value.idempotencyKey,item);return item;
    }
  };
  return{api:new ChatGPTSchedulesAPI({operations}),schedule,jobs,writes,previews,runs};
}
const reader={id:'reader',scopes:['read']};
const editor={id:'editor',scopes:['read','commands:run']};

test('cronjob tools add no new permissions to the compatibility OAuth catalog',()=>{
  assert.deepEqual(CHATGPT_OAUTH_SCOPES,['read','files:read','files:write','commands:run','browser:read','browser:write','planning:write']);
  const tools=fixture().api.tools();
  assert.equal(tools.some(tool=>tool.scope==='schedules:write'),false);
  for(const tool of tools){
    const mutating=['blackice_edit_schedule','blackice_run_schedule'].includes(tool.name);
    assert.equal(tool.scope,mutating?'commands:run':'read');
  }
});
test('read-only ChatGPT schedule inspector lists, previews and pages receipts without dispatch',async()=>{
  const f=fixture();
  const names=f.api.tools().map(tool=>tool.name);
  assert.deepEqual(names,['blackice_list_schedules','blackice_get_schedule','blackice_list_schedule_results','blackice_preview_schedule','blackice_edit_schedule','blackice_run_schedule']);
  assert.deepEqual(f.api.tools(reader).map(tool=>tool.name),names.slice(0,4));
  const page=await f.api.call('blackice_list_schedules',{query:'Daily',limit:20},reader);
  assert.equal(page.total,1);assert.equal(page.schedules[0].models[0],'gpt-6-luna');
  assert.equal(page.removedCount,0,'legacy removals require an explicit request');
  const withRemoved=await f.api.call('blackice_list_schedules',{includeRemoved:true},reader);
  assert.equal(withRemoved.removedCount,1);
  assert.equal(withRemoved.removedSchedules[0].removedBy,'not-recorded');
  assert.equal(Object.hasOwn(withRemoved.removedSchedules[0],'webhookToken'),false);
  const detail=await f.api.call('blackice_get_schedule',{scheduleId:'schedule-one',jobLimit:1},reader);
  assert.equal(detail.schedule.revision,4);assert.equal(detail.jobHistory.total,2);
  assert.deepEqual(detail.jobHistory.jobs.map(job=>job.id),['job-newest']);
  assert.deepEqual(detail.jobHistory.jobs[0].attempts[0].runId,'real-run');
  assert.equal(JSON.stringify(detail.jobHistory).includes('definition'),false,'do not echo redundant sensitive snapshots');
  const delivery=await f.api.call('blackice_list_schedule_results',{state:'available'},reader);
  assert.equal(delivery.total,1);
  assert.equal(delivery.results[0].id,'job-older');
  assert.equal(delivery.results[0].delivery.state,'available');
  assert.equal(delivery.results[0].delivery.preview,'A verified local result, not a pushed message.');
  assert.equal(delivery.results[0].delivery.acknowledgedAt,null);
  assert.equal((await f.api.call('blackice_list_schedule_results',{state:'acknowledged'},reader)).total,0);
  assert.equal((await f.api.call('blackice_list_schedule_results',{scheduleId:'another'},reader)).total,0);
  const preview=await f.api.call('blackice_preview_schedule',{scheduleId:'schedule-one',count:3},reader);
  assert.deepEqual(preview.occurrences,[{local:'Oct 28, 2026, 9:00 AM EDT'}]);
  assert.equal(f.previews.length,1);assert.equal(f.writes.length,0);assert.equal(f.runs.size,0);
});

test('schedule mutations reuse existing connector command capability without a new scope',async()=>{
  const f=fixture(),edit={scheduleId:'schedule-one',expectedRevision:4,patch:{input:'Updated instructions'}};
  await assert.rejects(f.api.call('blackice_edit_schedule',edit,reader),/commands:run/);
  await assert.rejects(f.api.call('blackice_edit_schedule',edit,{id:'planner',scopes:['read','planning:write']}),/commands:run/);
  await assert.rejects(f.api.call('blackice_run_schedule',{scheduleId:'schedule-one',idempotencyKey:'run-1'},reader),/commands:run/);
  await assert.rejects(f.api.call('blackice_edit_schedule',{...edit,expectedRevision:3},editor),/Reinspect and reconcile/);
  assert.equal(f.writes.length,0);
});

test('schedule edits update only selected fields and preserve original graph, attachments and history',async()=>{
  const f=fixture(),original=structuredClone(f.schedule),beforeJobs=structuredClone(f.jobs);
  const changed=await f.api.call('blackice_edit_schedule',{
    scheduleId:'schedule-one',expectedRevision:4,
    patch:{name:'New name',trigger:{type:'cron',expression:'30 8 * * MON-FRI',timezone:'America/New_York'},
      overlap:'queue',retry:{maxAttempts:2},limits:{maxIterations:20},
      agentEffort:'ultra'}
  },editor);
  assert.equal(changed.revision,5);assert.equal(f.writes.length,1);
  assert.deepEqual(f.writes[0].retry,{maxAttempts:2,backoffSeconds:30});
  assert.deepEqual(f.writes[0].limits,{maxIterations:20,runForSeconds:3600,endAt:null});
  assert.equal(f.schedule.workflow.nodes.find(node=>node.type==='agent').model,'gpt-6-luna');
  assert.equal(f.schedule.workflow.nodes.find(node=>node.type==='agent').effort,'ultra');
  assert.deepEqual(f.schedule.attachmentIds,original.attachmentIds);
  assert.deepEqual(f.jobs,beforeJobs);
  assert.equal(f.writes[0].expectedRevision,4);
  assert.equal(Object.hasOwn(f.writes[0],'attachmentIds'),false);
});

test('malformed schedule updates are rejected before touching persistence',async()=>{
  const f=fixture();
  for(const args of [
    {scheduleId:'schedule-one',expectedRevision:4,patch:{}},
    {scheduleId:'schedule-one',expectedRevision:4,patch:{enabled:true,secret:'other-field'}},
    {scheduleId:'schedule-one',expectedRevision:4,patch:{retry:{maxAttempts:-1}}},
    {scheduleId:'schedule-one',expectedRevision:4,patch:{trigger:{type:'unknown'}}},
    {scheduleId:'schedule-one',expectedRevision:4,patch:{agentEffort:'fantasy'}},
  ])await assert.rejects(f.api.call('blackice_edit_schedule',args,editor),/declared arguments/);
  await assert.rejects(f.api.call('blackice_preview_schedule',{scheduleId:'schedule-one',trigger:{type:'manual'}},reader),/declared arguments/);
  assert.equal(f.writes.length,0);
});

test('run now returns one admitted durable receipt for a stable key, never a completion claim',async()=>{
  const f=fixture(),args={scheduleId:'schedule-one',idempotencyKey:'cronjob-edit-smoke-001'};
  const first=await f.api.call('blackice_run_schedule',args,editor);
  const second=await f.api.call('blackice_run_schedule',args,editor);
  assert.equal(first.status,'queued');assert.deepEqual(first,second);
  assert.equal(f.runs.size,1);
});
