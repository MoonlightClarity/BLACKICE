import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTriggerFromDraft,scheduleDraftFromTrigger,scheduleLabel } from '../public/schedule-model.mjs';

test('simple calendar choices become actual local cron schedules',()=>{
  const common={time:'09:05',timezone:'America/New_York'};
  assert.deepEqual(scheduleTriggerFromDraft({...common,trigger:'daily'}),{type:'cron',expression:'5 9 * * *',timezone:'America/New_York'});
  assert.equal(scheduleTriggerFromDraft({...common,trigger:'weekdays'}).expression,'5 9 * * 1-5');
  assert.equal(scheduleTriggerFromDraft({...common,trigger:'weekly',weekday:'0'}).expression,'5 9 * * 0');
  assert.deepEqual(scheduleTriggerFromDraft({trigger:'cron',expression:'*/15 9-17 * * 1-5',timezone:'UTC'}),{type:'cron',expression:'*/15 9-17 * * 1-5',timezone:'UTC'});
});

test('editing calendar and existing interval triggers round-trips without changing their meaning',()=>{
  for(const trigger of [{type:'manual'},{type:'webhook'},{type:'interval',everySeconds:125},{type:'cron',expression:'5 9 * * *',timezone:'Europe/London'},{type:'cron',expression:'0 0 * * 1-5',timezone:'UTC'},{type:'cron',expression:'59 23 * * 6',timezone:'Asia/Tokyo'},{type:'cron',expression:'*/15 9-17 * * 1-5',timezone:'America/New_York'}])assert.deepEqual(scheduleTriggerFromDraft(scheduleDraftFromTrigger(trigger)),trigger);
  assert.match(scheduleLabel({type:'cron',expression:'5 9 * * *',timezone:'UTC'}),/Daily at 09:05/);
  assert.match(scheduleLabel({type:'cron',expression:'5 9 * * *',timezone:'UTC'}),/5 9 \* \* \*/);
  assert.deepEqual(scheduleTriggerFromDraft({trigger:'interval',seconds:'1'}),{type:'interval',everySeconds:1});
  assert.deepEqual(scheduleTriggerFromDraft({trigger:'interval',seconds:String(31*86400)}),{type:'interval',everySeconds:31*86400});
  assert.match(scheduleLabel({type:'cron',expression:'0 9 * * 1-5',timezone:'UTC'}),/Weekdays/);
  assert.match(scheduleLabel({type:'cron',expression:'0 9 * * 0',timezone:'UTC'}),/Sun at/);
});

test('invalid calendar input fails locally and custom syntax is delegated to the server parser',()=>{
  for(const draft of [{trigger:'daily',time:'24:00',timezone:'UTC'},{trigger:'daily',time:'10:60',timezone:'UTC'},{trigger:'daily',time:'9:00',timezone:'UTC'},{trigger:'weekly',time:'09:00',weekday:'7',timezone:'UTC'},{trigger:'cron',expression:'',timezone:'UTC'},{trigger:'daily',time:'09:00',timezone:''},{trigger:'interval',seconds:'1.2'},{trigger:'interval',seconds:'0'},{trigger:'other'}])assert.throws(()=>scheduleTriggerFromDraft(draft));
  assert.equal(scheduleTriggerFromDraft({trigger:'cron',expression:'server validates this',timezone:'UTC'}).expression,'server validates this');
});
