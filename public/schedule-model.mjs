/** Human-readable schedule controls; cron remains an advanced, opt-in format. */
const intervalUnits = Object.freeze({seconds:1,minutes:60,hours:3600,days:86400});
const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function intervalSecondsFromParts(amount,unit='minutes'){
  const raw=String(amount??'').trim();
  const factor=intervalUnits[String(unit)];
  if(!/^\d+$/.test(raw)||!factor)throw new Error('Choose a positive whole-number interval and unit.');
  const count=Number(raw),seconds=count*factor;
  if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(seconds))throw new Error('The interval must be a positive whole number of seconds.');
  return seconds;
}

export function intervalPartsFromSeconds(seconds=3600){
  const value=Number(seconds);
  if(!Number.isSafeInteger(value)||value<1)throw new Error('The saved interval is invalid.');
  for(const [unit,factor] of [['days',86400],['hours',3600],['minutes',60],['seconds',1]])
    if(value%factor===0)return {intervalAmount:String(value/factor),intervalUnit:unit};
  return {intervalAmount:String(value),intervalUnit:'seconds'};
}

export function scheduleTriggerFromDraft(draft={}){
  const recurrence=draft.trigger||'daily';
  if(recurrence==='manual'||recurrence==='webhook')return{type:recurrence};
  if(recurrence==='interval'){
    const seconds=draft.intervalAmount!=null
      ?intervalSecondsFromParts(draft.intervalAmount,draft.intervalUnit)
      :intervalSecondsFromParts(draft.seconds,'seconds');
    return{type:'interval',everySeconds:seconds};
  }
  const timezone=String(draft.timezone||'').trim();
  if(!timezone)throw new Error('Enter a time zone, such as America/New_York.');
  if(recurrence==='cron'){
    const expression=String(draft.expression||'').trim();
    if(!expression)throw new Error('Enter a five-field cron expression.');
    return{type:'cron',expression,timezone};
  }
  if(!['daily','weekdays','weekly'].includes(recurrence))throw new Error('Choose when this task should run.');
  const match=/^(\d{2}):(\d{2})$/.exec(String(draft.time||''));
  if(!match||Number(match[1])>23||Number(match[2])>59)throw new Error('Choose a valid time.');
  const weekday=String(draft.weekday??'1');
  if(recurrence==='weekly'&&!/^[0-6]$/.test(weekday))throw new Error('Choose a day of the week.');
  return{type:'cron',expression:Number(match[2])+' '+Number(match[1])+' * * '+(recurrence==='daily'?'*':recurrence==='weekdays'?'1-5':weekday),timezone};
}

export function scheduleDraftFromTrigger(trigger={},timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'){
  const seconds=trigger.everySeconds||3600;
  const base={trigger:trigger.type||'daily',seconds,time:'09:00',weekday:'1',timezone:trigger.timezone||timezone,expression:trigger.expression||'0 9 * * *',
    ...intervalPartsFromSeconds(seconds)};
  if(trigger.type!=='cron')return base;
  const match=/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(trigger.expression||'');
  if(!match||Number(match[1])>59||Number(match[2])>23)return base;
  return{...base,trigger:match[3]==='*'?'daily':match[3]==='1-5'?'weekdays':'weekly',
    time:match[2].padStart(2,'0')+':'+match[1].padStart(2,'0'),
    weekday:/^[0-6]$/.test(match[3])?match[3]:'1'};
}

function formatClock(time){
  const [hours,minutes]=time.split(':').map(Number);
  return (hours%12||12)+':'+String(minutes).padStart(2,'0')+(hours<12?' AM':' PM');
}
function humanInterval(seconds){
  const parts=intervalPartsFromSeconds(seconds),count=Number(parts.intervalAmount),unit=parts.intervalUnit;
  return 'Every '+(count===1?unit.slice(0,-1):count+' '+unit);
}

export function scheduleLabel(trigger={}){
  if(trigger.type==='interval')return humanInterval(trigger.everySeconds);
  if(trigger.type==='manual')return 'Only when started manually';
  if(trigger.type==='webhook')return 'When a webhook arrives';
  if(trigger.type!=='cron')return 'No schedule';
  const draft=scheduleDraftFromTrigger(trigger,'UTC'),zone=trigger.timezone||'UTC';
  const clock=formatClock(draft.time);
  if(draft.trigger==='daily')return 'Daily at '+clock+' · '+zone;
  if(draft.trigger==='weekdays')return 'Weekdays at '+clock+' · '+zone;
  if(draft.trigger==='weekly')return 'Every '+weekdays[Number(draft.weekday)]+' at '+clock+' · '+zone;

  // Translate only clock-aligned steps whose cycles divide the hour/day exactly.
  const expression=String(trigger.expression||'').trim();
  if(expression==='* * * * *')return 'Every minute · '+zone;
  const minuteStep=/^\*\/(\d+) \* \* \* \*$/.exec(expression);
  if(minuteStep&&Number(minuteStep[1])>=1&&60%Number(minuteStep[1])===0)
    return humanInterval(Number(minuteStep[1])*60)+' · '+zone;
  if(expression==='0 * * * *')return 'Every hour · '+zone;
  const hourStep=/^0 \*\/(\d+) \* \* \*$/.exec(expression);
  if(hourStep&&Number(hourStep[1])>=1&&24%Number(hourStep[1])===0)
    return humanInterval(Number(hourStep[1])*3600)+' · '+zone;
  const hourlyAt=/^(\d{1,2}) \* \* \* \*$/.exec(expression);
  if(hourlyAt&&Number(hourlyAt[1])<60)return 'Every hour at minute '+String(Number(hourlyAt[1])).padStart(2,'0')+' · '+zone;
  return 'Custom schedule · '+zone;
}
