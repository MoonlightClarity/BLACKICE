import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTriggerLabel, scheduleEditDraft, scheduleUpdateFromDraft, scheduleJobs } from '../public/next/workspaces/schedule-inspection-model.mjs';

const deployment = () => ({
  id:'schedule-one',revision:4,name:'Daily job search',input:'Find and rank new roles',cwd:'C:\\work',enabled:true,
  trigger:{type:'cron',expression:'0 9 * * *',timezone:'America/New_York'},overlap:'skip',
  retry:{maxAttempts:0,backoffSeconds:30},limits:{maxIterations:10,runForSeconds:null,endAt:null},attachmentIds:['resume'],
  workflow:{id:'workflow-one',name:'Single researcher',nodes:[
    {id:'input',type:'input',name:'Start'},
    {id:'research',type:'agent',name:'Research',model:'gpt-6-luna',prompt:'Use original evidence.',effort:'high',serviceTier:'default'},
    {id:'output',type:'output',name:'Results'}
  ],edges:[{source:'input',target:'research'},{source:'research',target:'output'}],settings:{maxParallel:1}}
});

test('cron inspection reads stored facts without modifying the saved schedule',()=>{
  const original=deployment(),before=structuredClone(original);
  assert.equal(scheduleTriggerLabel(original.trigger),'0 9 * * * · America/New_York');
  assert.equal(scheduleTriggerLabel({type:'interval',everySeconds:120}),'Every 120 seconds');
  assert.equal(scheduleTriggerLabel({type:'webhook'}),'webhook');
  const draft=scheduleEditDraft(original);
  assert.equal(draft.agentModel,'gpt-6-luna');assert.equal(draft.agentEffort,'high');
  assert.equal(draft.maxIterations,'10');
  assert.equal(draft.timezone,'America/New_York');
  assert.deepEqual(original,before);
});

test('schedule updates round-trip unchanged workflow and omit pinned attachments instead of replacing them',()=>{
  const original=deployment(),draft=scheduleEditDraft(original),before=structuredClone(original);
  draft.name='New title';draft.input='Inspect new postings';draft.expression='30 8 * * MON-FRI';draft.overlap='queue';
  draft.maxAttempts='2';draft.backoffSeconds='60';draft.runForSeconds='172800';
  const update=scheduleUpdateFromDraft(original,draft);
  assert.equal(update.expectedRevision,4);
  assert.deepEqual(update.trigger,{type:'cron',expression:'30 8 * * MON-FRI',timezone:'America/New_York'});
  assert.deepEqual(update.retry,{maxAttempts:2,backoffSeconds:60});
  assert.deepEqual(update.limits,{maxIterations:10,runForSeconds:172800,endAt:null});
  assert.equal(Object.hasOwn(update,'workflow'),false);
  assert.equal(Object.hasOwn(update,'attachmentIds'),false);
  assert.deepEqual(original,before);
});

test('model-only changes copy exact workflow and preserve other agent properties',()=>{
  const original=deployment(),draft=scheduleEditDraft(original);
  draft.agentModel='gpt-5.6';draft.agentEffort='ultra';
  const update=scheduleUpdateFromDraft(original,draft);
  const agent=update.workflow.nodes.find(node=>node.type==='agent');
  assert.equal(agent.model,'gpt-5.6');assert.equal(agent.effort,'ultra');
  assert.equal(agent.prompt,'Use original evidence.');assert.equal(agent.serviceTier,'default');
  assert.equal(original.workflow.nodes.find(node=>node.type==='agent').model,'gpt-6-luna');
  assert.equal(Object.hasOwn(update,'attachmentIds'),false);
});

test('complex pinned graphs remain intact and do not accidentally retarget several agents',()=>{
  const original=deployment();
  original.workflow.nodes.splice(2,0,{id:'review',type:'agent',name:'Review',model:'gpt-6-luna',prompt:'Review results.'});
  original.workflow.edges.push({source:'research',target:'review'});
  const draft=scheduleEditDraft(original);
  assert.equal(draft.agentModel,null);
  draft.input='New instructions';
  const update=scheduleUpdateFromDraft(original,draft);
  assert.equal(Object.hasOwn(update,'workflow'),false);
  assert.equal(update.input,'New instructions');
});

test('invalid edits are rejected before attempting any write',()=>{
  const original=deployment();
  for(const [key,value] of [
    ['name',''],['cwd',''],['overlap','magic'],['maxAttempts','-1'],['maxAttempts','4'],
    ['backoffSeconds','0'],['maxIterations','0'],['runForSeconds','abc'],['endAt','2030-01-01T12:00']
  ]){
    const draft=scheduleEditDraft(original);draft[key]=value;
    assert.throws(()=>scheduleUpdateFromDraft(original,draft),undefined,key);
  }
  const interval=scheduleEditDraft(original);interval.triggerType='interval';interval.everySeconds='0';
  assert.throws(()=>scheduleUpdateFromDraft(original,interval),/Interval/);
  interval.everySeconds='120';
  assert.deepEqual(scheduleUpdateFromDraft(original,interval).trigger,{type:'interval',everySeconds:120});
  const manual=scheduleEditDraft(original);manual.triggerType='manual';
  assert.deepEqual(scheduleUpdateFromDraft(original,manual).trigger,{type:'manual'});
});

test('restart catch-up editor is explicit, age-bounded and defaults to skipping missed runs',()=>{
 const original=deployment(),draft=scheduleEditDraft(original);
 assert.equal(draft.catchUpPolicy,'skip');
 assert.equal(draft.catchUpMaxAge,'86400');
 const defaultEdit=scheduleUpdateFromDraft(original,draft);
 assert.deepEqual(defaultEdit.missedRunPolicy,{onResume:'skip',maxAgeSeconds:86400});
 draft.catchUpPolicy='once';draft.catchUpMaxAge='7200';
 const updated=scheduleUpdateFromDraft(original,draft);
 assert.deepEqual(updated.missedRunPolicy,{onResume:'once',maxAgeSeconds:7200});
 for(const [field,value] of [['catchUpPolicy','unknown'],['catchUpMaxAge','0'],['catchUpMaxAge','700000'],['catchUpMaxAge','x']]){
   const invalid=scheduleEditDraft(original);invalid[field]=value;
   assert.throws(()=>scheduleUpdateFromDraft(original,invalid),/catch-up|missed-run/i);
 }
});

test('editor opts in to HTTPS delivery explicitly and never reveals or erases an existing secret URL',()=>{
  const initial=deployment();
  const first=scheduleEditDraft(initial);
  assert.equal(first.outboundType,'local');
  assert.equal(first.outboundUrl,'');
  first.outboundType='webhook';
  assert.throws(()=>scheduleUpdateFromDraft(initial,first),/Enter the HTTPS webhook URL/);
  first.outboundUrl='https://alerts.example.com/private/token';
  const enabled=scheduleUpdateFromDraft(initial,first);
  assert.deepEqual(enabled.deliveryTarget,{type:'webhook',url:'https://alerts.example.com/private/token'});
  const saved={...deployment(),deliveryTarget:{type:'webhook',host:'alerts.example.com',configured:true}};
  const preserved=scheduleEditDraft(saved);
  assert.equal(preserved.outboundType,'webhook');
  assert.equal(preserved.outboundUrl,'','inspection never materializes the saved URL');
  assert.equal(Object.hasOwn(scheduleUpdateFromDraft(saved,preserved),'deliveryTarget'),false,'blank URL keeps the exact previously saved destination');
  preserved.outboundType='local';
  assert.deepEqual(scheduleUpdateFromDraft(saved,preserved).deliveryTarget,{type:'local'});
});

test('history inspection uses recorded deployment IDs and preserves original receipts',()=>{
  const jobs=[{id:'other',deploymentId:'another'},{id:'latest',deploymentId:'schedule-one'},{id:'older',deploymentId:'schedule-one'}],before=structuredClone(jobs);
  const result=scheduleJobs({jobs},'schedule-one',1);
  assert.equal(result.total,2);assert.deepEqual(result.jobs,[jobs[1]]);
  assert.deepEqual(jobs,before);
});
