import test from 'node:test';
import assert from 'node:assert/strict';
import { appendOccurrence, scheduleOverdue, schedulerPulse, OCCURRENCE_HISTORY_LIMIT } from '../lib/schedule-diagnostics.mjs';

test('scheduler health distinguishes running, stale, error, paused and stopped',()=>{
  const now=200000;
  const normal={now,pollMs:1000,lastAttemptAt:199000,lastSuccessAt:199000,activeSchedules:1};
  assert.equal(schedulerPulse(normal).state,'running');
  assert.equal(schedulerPulse({...normal,lastSuccessAt:100000}).state,'stale');
  assert.equal(schedulerPulse({...normal,lastError:'tick failed'}).state,'error');
  assert.equal(schedulerPulse({...normal,blockedReason:'inbox stopped'}).state,'blocked');
  assert.equal(schedulerPulse({...normal,paused:true}).state,'paused');
  assert.equal(schedulerPulse({...normal,stopped:true}).state,'stopped');
  assert.equal(schedulerPulse({...normal,activeSchedules:0}).state,'idle');
  assert.equal(schedulerPulse({...normal,lastSuccessAt:null}).state,'starting');
  assert.equal(schedulerPulse(normal).lastSuccessAt,new Date(199000).toISOString());
});
test('overdue means an enabled recurring schedule, not a past manual trigger',()=>{
  const d={enabled:true,trigger:{type:'cron'},nextAt:100};
  assert.equal(scheduleOverdue(d,100),true);
  assert.equal(scheduleOverdue({...d,enabled:false},101),false);
  assert.equal(scheduleOverdue({...d,trigger:{type:'manual'}},101),false);
  assert.equal(scheduleOverdue({...d,nextAt:null},101),false);
  assert.equal(scheduleOverdue({...d,nextAt:102},101),false);
});
test('occurrence journal is bounded, immutable and records ranges without inventing a count',()=>{
  const d={};
  for(let i=0;i<OCCURRENCE_HISTORY_LIMIT+15;i++)appendOccurrence(d,{kind:'skipped',scheduledAt:i,observedAt:i+1,reason:'backlog-collapsed',throughAt:i+100});
  assert.equal(d.occurrenceHistory.length,OCCURRENCE_HISTORY_LIMIT);
  assert.equal(d.occurrenceHistory[0].scheduledAt,15);
  assert.equal(d.occurrenceHistory.at(-1).throughAt,OCCURRENCE_HISTORY_LIMIT+14+100);
  assert.equal(Object.hasOwn(d.occurrenceHistory.at(-1),'count'),false);
  assert.throws(()=>appendOccurrence(d,{kind:'admitted',scheduledAt:null,observedAt:100}),/valid action/);
});
