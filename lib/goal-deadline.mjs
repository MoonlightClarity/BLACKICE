/** Deadline interpretation for persistent conversation Goals; never based on model self-stop. */
const invalid = message => Object.assign(new Error(message), {code:'GOAL_DEADLINE_INVALID',status:400});
const LOCAL_ZONE = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const UTC_MINUTES = {EST:-300,EDT:-240,UTC:0};
const FULL_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/i;
const TIME_CLAUSE = /\buntil\s+(?:(today|tomorrow|\d{4}-\d\d-\d\d)\s+(?:at\s+)?)?(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\s*(EST|EDT|ET|Eastern(?:\s+Time)?|UTC|GMT)?\b/i;
const FORMATTERS = new Map();
const pad = n => String(n).padStart(2,'0');

export function canonicalGoalZone(raw, localZone=LOCAL_ZONE()) {
  const value=String(raw||localZone).trim();
  if (/^EST$/i.test(value))return 'EST'; // Fixed UTC-05:00, even during daylight saving.
  if (/^EDT$/i.test(value))return 'EDT'; // Fixed UTC-04:00.
  if (/^(?:ET|Eastern(?:\s+Time)?|America\/New_York)$/i.test(value))return 'America/New_York';
  if (/^(?:UTC|GMT|Z)$/i.test(value))return 'UTC';
  try { new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0); return value; }
  catch { throw invalid('Unknown deadline time zone; use EST, EDT, Eastern, UTC, or an IANA zone.'); }
}
function localParts(utcMs, zone) {
  if (Object.hasOwn(UTC_MINUTES,zone)) {
    const d=new Date(utcMs+UTC_MINUTES[zone]*60000);
    return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),minute:d.getUTCMinutes()};
  }
  if (!FORMATTERS.has(zone)) FORMATTERS.set(zone,new Intl.DateTimeFormat('en-GB',{
    timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }));
  const fields=Object.fromEntries(FORMATTERS.get(zone).formatToParts(utcMs).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  return {year:fields.year,month:fields.month,day:fields.day,hour:fields.hour%24,minute:fields.minute};
}
function datePlus(calendar, days) {
  const date=new Date(Date.UTC(calendar.year,calendar.month-1,calendar.day+days));
  return {year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate()};
}
function candidates(calendar,hour,minute,zone) {
  const target=Date.UTC(calendar.year,calendar.month-1,calendar.day,hour,minute);
  if (Object.hasOwn(UTC_MINUTES,zone)) return [target-UTC_MINUTES[zone]*60000];
  // Covers historical quarter-hour UTC offsets as well as modern DST transitions.
  const results=[];
  for (let offset=-14*60;offset<=14*60;offset+=15) {
    const utc=target-offset*60000,parts=localParts(utc,zone);
    if (parts.year===calendar.year&&parts.month===calendar.month&&parts.day===calendar.day
        &&parts.hour===hour&&parts.minute===minute)results.push(utc);
  }
  return [...new Set(results)].sort((a,b)=>a-b);
}
export function parseDeadlineInstant(value) {
  if (typeof value!=='string'||!FULL_ISO.test(value)||!Number.isFinite(Date.parse(value)))
    throw invalid('Supply an absolute ISO 8601 deadline with Z or an explicit UTC offset.');
  return new Date(value).toISOString();
}
export function inferGoalDeadline(objective, nowMs=Date.now(), localZone=LOCAL_ZONE()) {
  const match=TIME_CLAUSE.exec(String(objective||''));
  if (!match)return null;
  const [,dateWord,hours,minutes='',meridiem,zoneWord]=match;
  const zone=canonicalGoalZone(zoneWord||localZone,localZone);
  const hour=(Number(hours)%12)+(/^p/i.test(meridiem)?12:0),minute=minutes?Number(minutes):0;
  const localNow=localParts(nowMs,zone);
  const explicit=Boolean(dateWord);
  let day;
  if (!dateWord)day={year:localNow.year,month:localNow.month,day:localNow.day};
  else if (/^today$/i.test(dateWord))day={year:localNow.year,month:localNow.month,day:localNow.day};
  else if (/^tomorrow$/i.test(dateWord))day=datePlus(localNow,1);
  else {
    const [year,month,date]=dateWord.split('-').map(Number);
    day={year,month,day:date};
    const check=new Date(Date.UTC(year,month-1,date));
    if (check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==date)
      throw invalid('The date in the Goal deadline is invalid.');
  }
  for (let n=0;n<(explicit?1:3);n++) {
    const times=candidates(datePlus(day,n),hour,minute,zone);
    if (!times.length) {
      if(explicit)throw invalid('The requested local deadline time does not exist in that time zone.');
      continue;
    }
    const time=explicit?times[0]:times.find(t=>t>nowMs);
    if(time!==undefined)return {deadlineAt:new Date(time).toISOString(),deadlineTimeZone:zone,
      deadlineExpression:match[0].trim(),deadlineSource:'objective'};
  }
  throw invalid('Could not resolve the Goal deadline from the computer clock and time zone.');
}
/** Only an explicitly edited deadline may override the saved absolute instant. */
export function resolveGoalDeadline(input, nowMs=Date.now(), previous=null, localZone=LOCAL_ZONE()) {
  if (Object.hasOwn(input,'deadlineAt')) {
    if(input.deadlineAt===null)return {deadlineAt:null,deadlineTimeZone:null,deadlineExpression:null,deadlineSource:'explicit-clear'};
    const deadlineAt=parseDeadlineInstant(input.deadlineAt);
    const deadlineTimeZone=input.deadlineTimeZone?canonicalGoalZone(input.deadlineTimeZone,localZone)
      :(/Z$/i.test(input.deadlineAt)?'UTC':String(input.deadlineAt).slice(-6));
    return {deadlineAt,deadlineTimeZone,deadlineExpression:input.deadlineAt,deadlineSource:'explicit'};
  }
  if (input.deadlineTimeZone!==undefined)throw invalid('A time zone change requires an explicit deadlineAt edit.');
  if (previous && Object.hasOwn(previous,'deadlineAt'))return {
    deadlineAt:previous.deadlineAt??null,deadlineTimeZone:previous.deadlineTimeZone??null,
    deadlineExpression:previous.deadlineExpression??null,deadlineSource:previous.deadlineSource??null
  };
  return inferGoalDeadline(input.objective,nowMs,localZone) || {deadlineAt:null,deadlineTimeZone:null,deadlineExpression:null,deadlineSource:null};
}
export function goalDeadlineDue(goal, nowMs=Date.now(), monotonicDue=false) {
  return Boolean(goal?.deadlineExpiredAt || (goal?.deadlineAt && (nowMs>=Date.parse(goal.deadlineAt)||monotonicDue)));
}
export function deadlineDisplay(goal) {
  if(!goal?.deadlineAt)return '';
  return 'Goal stops at '+goal.deadlineAt+' ('+(goal.deadlineTimeZone||'UTC')+').';
}
