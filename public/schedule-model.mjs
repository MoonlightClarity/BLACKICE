/** Human-sized schedule controls map directly to the server's persisted trigger. */
export function scheduleTriggerFromDraft(draft={}){
  const recurrence=draft.trigger||'daily';
  if(recurrence==='manual'||recurrence==='webhook')return{type:recurrence};
  if(recurrence==='interval'){
    const seconds=Number(draft.seconds);if(!Number.isSafeInteger(seconds)||seconds<10||seconds>2592000)throw new Error('Choose an interval from 10 seconds to 30 days.');
    return{type:'interval',everySeconds:seconds};
  }
  const timezone=String(draft.timezone||'').trim();if(!timezone)throw new Error('Enter a time zone, such as America/New_York.');
  if(recurrence==='cron'){
    const expression=String(draft.expression||'').trim();if(!expression)throw new Error('Enter a five-field cron expression.');
    return{type:'cron',expression,timezone};
  }
  if(!['daily','weekdays','weekly'].includes(recurrence))throw new Error('Choose when this task should run.');
  const match=/^(\d{2}):(\d{2})$/.exec(String(draft.time||''));if(!match||Number(match[1])>23||Number(match[2])>59)throw new Error('Choose a valid time.');
  const weekday=String(draft.weekday??'1');if(recurrence==='weekly'&&!/^[0-6]$/.test(weekday))throw new Error('Choose a day of the week.');
  return{type:'cron',expression:`${Number(match[2])} ${Number(match[1])} * * ${recurrence==='daily'?'*':recurrence==='weekdays'?'1-5':weekday}`,timezone};
}

export function scheduleDraftFromTrigger(trigger={},timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'){
  const base={trigger:trigger.type||'daily',seconds:trigger.everySeconds||3600,time:'09:00',weekday:'1',timezone:trigger.timezone||timezone,expression:trigger.expression||'0 9 * * *'};
  if(trigger.type!=='cron')return base;
  const match=/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(trigger.expression||'');
  if(!match||Number(match[1])>59||Number(match[2])>23)return base;
  return{...base,trigger:match[3]==='*'?'daily':match[3]==='1-5'?'weekdays':'weekly',time:`${match[2].padStart(2,'0')}:${match[1].padStart(2,'0')}`,weekday:/^[0-6]$/.test(match[3])?match[3]:'1'};
}

export function scheduleLabel(trigger={}){
  if(trigger.type==='interval')return`Every ${trigger.everySeconds}s`;
  if(trigger.type==='webhook')return'Webhook';if(trigger.type==='manual')return'Manual';
  const draft=scheduleDraftFromTrigger(trigger,'UTC'),zone=trigger.timezone||'UTC';
  if(draft.trigger==='daily')return`Daily at ${draft.time} · ${zone}`;
  if(draft.trigger==='weekdays')return`Weekdays at ${draft.time} · ${zone}`;
  if(draft.trigger==='weekly')return`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][Number(draft.weekday)]} at ${draft.time} · ${zone}`;
  return`${trigger.expression||'Cron'} · ${zone}`;
}
