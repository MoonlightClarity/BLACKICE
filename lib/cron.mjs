const MINUTE = 60_000, DAY = 86_400_000;
const months = Object.fromEntries(['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].map((name,index)=>[name,index+1]));
const weekdays = Object.fromEntries(['SUN','MON','TUE','WED','THU','FRI','SAT'].map((name,index)=>[name,index]));
const invalid = message => Object.assign(new Error(message), { status:400, code:'INVALID_CRON' });
const epoch = (year,month,day) => { const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(0,0,0,0);return date.getTime(); };

function field(source,min,max,label,names={}) {
  const values=new Set(), wildcard=source.includes('*'), width=label==='Day of week'?7:max-min+1;
  const number=value=>{const normalized=names[value]??(/^[0-9]+$/.test(value)?Number(value):NaN);if(!Number.isSafeInteger(normalized)||normalized<min||normalized>max)throw invalid(`${label} must be ${min} to ${max}${Object.keys(names).length?' or a three-letter name':''}.`);return normalized;};
  for(const segment of source.split(',')) {
    const parts=segment.split('/');if(parts.length>2||!parts[0])throw invalid(`Invalid ${label.toLowerCase()} list or step.`);
    const step=parts.length===2&&/^[0-9]+$/.test(parts[1])?Number(parts[1]):parts.length===1?1:NaN;
    if(!Number.isSafeInteger(step)||step<1||step>width)throw invalid(`${label} step must be 1 to ${width}.`);
    let start,end;
    if(parts[0]==='*'){start=min;end=max;}
    else {const range=parts[0].split('-');if(range.length>2)throw invalid(`Invalid ${label.toLowerCase()} range.`);start=number(range[0]);end=range.length===2?number(range[1]):parts.length===2?max:start;if(end<start)throw invalid(`${label} ranges must run from low to high.`);}
    for(let value=start;value<=end;value+=step)values.add(label==='Day of week'&&value===7?0:value);
  }
  return {values:[...values].sort((a,b)=>a-b),has:value=>values.has(value),wildcard};
}

/** Five-field calendar cron. No commands, seconds, macros, or Quartz extensions.
 * Field/day/DST semantics: https://man7.org/linux/man-pages/man5/crontab.5.html */
export function parseCron(expression, timezone) {
  if(typeof expression!=='string'||expression.length>256||expression.includes('\0'))throw invalid('Use a five-field cron expression of at most 256 characters.');
  const normalized=expression.trim().replace(/\s+/g,' ').toUpperCase(),parts=normalized.split(' ');
  if(parts.length!==5)throw invalid('Cron needs five fields: minute hour day-of-month month day-of-week.');
  if(typeof timezone!=='string'||timezone.length>128||!/^\w+(?:\/[\w+\-]+)*$/.test(timezone))throw invalid('Choose an IANA timezone such as America/New_York or UTC.');
  let formatter,zone;
  try{formatter=new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});zone=formatter.resolvedOptions().timeZone;}catch{throw invalid('Choose a valid IANA timezone such as America/New_York or UTC.');}
  const minute=field(parts[0],0,59,'Minute'),hour=field(parts[1],0,23,'Hour'),day=field(parts[2],1,31,'Day of month'),month=field(parts[3],1,12,'Month',months),weekday=field(parts[4],0,7,'Day of week',weekdays);
  // With an unrestricted weekday, an impossible date must fail immediately,
  // instead of scanning years of minutes (February 30, April 31, and so on).
  if(weekday.wildcard&&!month.values.some(value=>day.values.some(date=>date<=new Date(epoch(2000,value+1,0)).getUTCDate())))throw invalid('This cron expression has no matching calendar date.');
  const local=timestamp=>Object.fromEntries(formatter.formatToParts(timestamp).filter(part=>['year','month','day','hour','minute','second'].includes(part.type)).map(part=>[part.type,Number(part.value)]));
  const matchesDay=(year,m,d)=>{if(!month.has(m))return false;const dom=day.has(d),dow=weekday.has(new Date(epoch(year,m,d)).getUTCDay());return day.wildcard||weekday.wildcard?dom&&dow:dom||dow;};
  return {expression:normalized,timezone:zone,minute,hour,day,month,weekday,local,matchesDay};
}

/** Next real instants, strictly after `after`. Missing wall minutes are skipped;
 * repeated wall minutes produce both distinct instants. Gregorian days repeat
 * within 400 years, so even impossible wildcard combinations have bounded work. */
export function cronOccurrences(trigger,{after=Date.now(),count=5}={}) {
  if(!Number.isFinite(after)||!Number.isFinite(new Date(after).getTime()))throw invalid('A valid schedule start time is required.');
  if(!Number.isSafeInteger(count)||count<1||count>10)throw invalid('Preview count must be 1 to 10.');
  const parsed=parseCron(trigger?.expression,trigger?.timezone),start=parsed.local(after),startDay=epoch(start.year,start.month,start.day),end=epoch(start.year+400,start.month,start.day),found=[];
  for(let date=startDay;date<=end&&found.length<count;date+=DAY) {
    const dayDate=new Date(date),year=dayDate.getUTCFullYear(),month=dayDate.getUTCMonth()+1,day=dayDate.getUTCDate();
    if(!parsed.matchesDay(year,month,day))continue;
    // Sample surrounding UTC days to include both sides of offset
    // transitions, including half-hour folds and complete skipped local dates.
    // Every proposed instant is round-tripped, so a gap never shifts a job.
    const offsets=new Set();
    for(let sample=date-36*60*MINUTE;sample<=date+60*60*MINUTE;sample+=6*60*MINUTE){const parts=parsed.local(sample);offsets.add(epoch(parts.year,parts.month,parts.day)+(parts.hour*60+parts.minute)*MINUTE+parts.second*1000-sample);}
    const candidates=new Set();
    for(const hour of parsed.hour.values)for(const minute of parsed.minute.values)for(const offset of offsets){const at=date+(hour*60+minute)*MINUTE-offset;if(at<=after)continue;const parts=parsed.local(at);if(parts.year===year&&parts.month===month&&parts.day===day&&parts.hour===hour&&parts.minute===minute&&parts.second===0)candidates.add(at);}
    for(const at of [...candidates].sort((a,b)=>a-b)){found.push(at);if(found.length===count)break;}
  }
  if(found.length<count)throw invalid('This cron expression has no matching future calendar date.');
  return found;
}

export function cronPreview(trigger,{after=Date.now(),count=5}={}) {
  const parsed=parseCron(trigger?.expression,trigger?.timezone),normalized={type:'cron',expression:parsed.expression,timezone:parsed.timezone},display=new Intl.DateTimeFormat('en-US',{timeZone:parsed.timezone,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}),occurrences=cronOccurrences(normalized,{after,count}).map(at=>({at,iso:new Date(at).toISOString(),local:display.format(at)}));
  return {trigger:normalized,nextAt:occurrences[0].at,timezone:parsed.timezone,occurrences,semantics:{missingTimes:'skip',repeatedTimes:'twice',dayMatch:'OR'}};
}
