/** Absolute Goal cutoffs, resolved from the user's original clock/time-zone intent. */
const error = (message, code='GOAL_DEADLINE_INVALID') =>
  Object.assign(new Error(message), {code, status:400});
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const FIXED_ZONES = {EST:-300, EDT:-240, UTC:0};
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/i;
// A deliberately bounded grammar: never accept a time prefix while ignoring a
// timezone/date suffix such as "PST" or "tomorrow".
const TIME = /^\s*(?:(today|tomorrow|\d{4}-\d\d-\d\d)\s+(?:at\s+)?)?(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?:\s+(EST|EDT|ET|Eastern(?:\s+Time)?|UTC|GMT|America\/New_York|[A-Za-z_]+\/[A-Za-z_]+))?(?:(?:\s+on)?\s+(today|tomorrow|\d{4}-\d\d-\d\d))?/i;
const UNTIL = /\buntil\b/gi;
const TEMPORAL = /^(?:at\b|(?:today|tomorrow|tonight|next|this|mon|tue|wed|thu|fri|sat|sun)\b|\d|\b(?:morning|evening|night|noon|midnight)\b)/i;
const FORMATTERS = new Map();

export function canonicalGoalZone(value, fallback=localZone()) {
  const zone=String(value??fallback).trim();
  if (/^EST$/i.test(zone))return 'EST'; // Fixed UTC-05:00; not daylight-aware.
  if (/^EDT$/i.test(zone))return 'EDT'; // Fixed UTC-04:00.
  if (/^(?:ET|Eastern(?:\s+Time)?|America\/New_York)$/i.test(zone))return 'America/New_York';
  if (/^(?:UTC|GMT|Z)$/i.test(zone))return 'UTC';
  try { return new Intl.DateTimeFormat('en-US',{timeZone:zone}).resolvedOptions().timeZone; }
  catch { throw error('Unsupported Goal deadline time zone: '+zone+'. Supply an IANA zone or an explicit UTC offset.'); }
}
function parts(epoch, zone) {
  if(Object.hasOwn(FIXED_ZONES,zone)) {
    const date=new Date(epoch+FIXED_ZONES[zone]*60000);
    return {year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),hour:date.getUTCHours(),minute:date.getUTCMinutes(),second:date.getUTCSeconds()};
  }
  if (!FORMATTERS.has(zone)) FORMATTERS.set(zone,new Intl.DateTimeFormat('en-GB',{
    timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }));
  const fields=Object.fromEntries(FORMATTERS.get(zone).formatToParts(epoch)
    .filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  return {year:fields.year,month:fields.month,day:fields.day,hour:fields.hour%24,minute:fields.minute,second:fields.second};
}
function calendar(year,month,day) {
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)
    throw error('The Goal deadline contains an invalid calendar date.');
  return {year,month,day};
}
function plusDay(date, delta) {
  const d=new Date(Date.UTC(date.year,date.month-1,date.day+delta));
  return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
}
function instantCandidates(date, hour,minute,second,zone) {
  const target=Date.UTC(date.year,date.month-1,date.day,hour,minute,second);
  if (Object.hasOwn(FIXED_ZONES,zone)) return [target-FIXED_ZONES[zone]*60000];
  // Each exact local-time match is an absolute instant. Spring gaps have zero
  // matches; autumn folds have two and require explicit offset disambiguation.
  const results=[];
  for(let offset=-14*60;offset<=14*60;offset+=15) {
    const utc=target-offset*60000,p=parts(utc,zone);
    if(p.year===date.year&&p.month===date.month&&p.day===date.day&&p.hour===hour
       &&p.minute===minute&&p.second===second)results.push(utc);
  }
  return [...new Set(results)].sort((a,b)=>a-b);
}
function calendarWord(word,now,zone) {
  const today=parts(now,zone),base={year:today.year,month:today.month,day:today.day};
  if (/^today$/i.test(word))return base;
  if (/^tomorrow$/i.test(word))return plusDay(base,1);
  const [y,m,d]=word.split('-').map(Number);
  return calendar(y,m,d);
}
function ensureUnique(candidates, zone) {
  if (!candidates.length) throw error('This local deadline time does not exist in '+zone+' (DST spring gap). Use an explicit UTC offset.');
  if (candidates.length>1) throw error('This local deadline time is ambiguous in '+zone+' (DST fall-back). Use an explicit UTC offset.','GOAL_DEADLINE_AMBIGUOUS');
  return candidates[0];
}
export function parseDeadlineInstant(value) {
  if(typeof value!=='string')throw error('Use an absolute ISO 8601 deadline with Z or an explicit UTC offset.');
  const match=ISO.exec(value);
  if(!match)throw error('Use an absolute ISO 8601 deadline with Z or an explicit UTC offset.');
  const [,ys,mos,ds,hs,mins,ss,fraction='',suffix,sign,oh,om]=match;
  const [year,month,day,hour,minute,second]=[ys,mos,ds,hs,mins,ss].map(Number);
  calendar(year,month,day);
  const offset=suffix.toUpperCase()==='Z'?0:(sign==='-'?-1:1)*(Number(oh)*60+Number(om));
  if(hour>23||minute>59||second>59||Math.abs(offset)>14*60||(oh&&Number(oh)===14&&Number(om)!==0))
    throw error('The ISO deadline has an invalid hour, minute, second or UTC offset.');
  const ms=Number(fraction.padEnd(3,'0'));
  const expected=Date.UTC(year,month-1,day,hour,minute,second,ms)-offset*60000;
  if(!Number.isFinite(expected)||Date.parse(value)!==expected)
    throw error('The ISO deadline does not identify a valid absolute instant.');
  return new Date(expected).toISOString();
}
function assertZoneMatchesOffset(iso, instant, zone) {
  const match=ISO.exec(iso);
  if(!match || match[8].toUpperCase()==='Z' || Object.hasOwn(FIXED_ZONES,zone))return;
  const [,ys,mos,ds,hs,mins,ss]=match, p=parts(Date.parse(instant),zone);
  if(Number(ys)!==p.year||Number(mos)!==p.month||Number(ds)!==p.day||Number(hs)!==p.hour
     ||Number(mins)!==p.minute||Number(ss)!==p.second)
    throw error('The explicit UTC offset contradicts the provided time zone at that instant.');
}
export function inferGoalDeadline(objective, nowMs=Date.now(), defaultZone=localZone()) {
  const string=String(objective||'');
  const clauses=[];
  UNTIL.lastIndex=0;
  for(const token of string.matchAll(UNTIL)) {
    const remainder=string.slice(token.index+token[0].length);
    const match=TIME.exec(remainder);
    if(!match){
      if(TEMPORAL.test(remainder.trim()))throw error('A Goal deadline was mentioned but its time or zone is unsupported. Use "until 6 AM EST" or an explicit ISO deadline.');
      continue;
    }
    const boundary=remainder.slice(match[0].length);
    // Do not silently interpret 6 AM PST, 6 AM tomorrow in an unsupported
    // place, 6 AM on Friday, or an unrecognized offset as computer local time.
    if(boundary.length && !/^(?:\s*$|[.!?,;:\n)]|\s+(?:and|then|to|for|unless|while|after)\b)/i.test(boundary))
      throw error('Unrecognized or ambiguous text after the Goal deadline: '+boundary.trim().slice(0,90));
    const [,before,hours,mins='',amPm,wordZone,after]=match;
    if(before && after && before.toLowerCase()!==after.toLowerCase())
      throw error('Conflicting dates in Goal deadline.');
    const dateWord=before||after||null,zone=canonicalGoalZone(wordZone||defaultZone,defaultZone);
    const hour=(Number(hours)%12)+(/^p/i.test(amPm)?12:0),minute=mins?Number(mins):0;
    const local=parts(nowMs,zone);
    const start=dateWord?calendarWord(dateWord,nowMs,zone):{year:local.year,month:local.month,day:local.day};
    let chosen;
    for(let d=0;d<(dateWord?1:2);d++) {
      const candidates=instantCandidates(plusDay(start,d),hour,minute,0,zone);
      // If this is an unqualified time already past today, tomorrow is valid;
      // but an impossible/ambiguous upcoming time is not silently skipped.
      if(!dateWord && d===0 && candidates.length===1 && candidates[0]<=nowMs)continue;
      chosen=ensureUnique(candidates,zone);break;
    }
    if(chosen===undefined)throw error('Could not resolve Goal deadline from computer time.');
    clauses.push({deadlineAt:new Date(chosen).toISOString(),deadlineTimeZone:zone,
      deadlineExpression:('until'+match[0]).trim(),deadlineSource:'objective'});
  }
  if(clauses.length>1)throw error('Multiple time cutoffs were found in the Goal objective; supply one explicit deadline.');
  return clauses[0]||null;
}
/** A saved absolute instant and even an explicit null clearance survive ordinary edits. */
export function resolveGoalDeadline(input, nowMs=Date.now(), previous=null, zone=localZone()) {
  if (Object.hasOwn(input,'deadlineAt')) {
    if(input.deadlineAt===null){
      if(input.deadlineTimeZone!==undefined)throw error('Clearing a deadline cannot supply a time zone.');
      return {deadlineAt:null,deadlineTimeZone:null,deadlineExpression:null,deadlineSource:'explicit-clear'};
    }
    const deadlineAt=parseDeadlineInstant(input.deadlineAt);
    const canonical=input.deadlineTimeZone?canonicalGoalZone(input.deadlineTimeZone,zone)
      :(/Z$/i.test(input.deadlineAt)?'UTC':String(input.deadlineAt).slice(-6));
    if(Object.hasOwn(FIXED_ZONES,canonical)&&/[+-]\d\d:\d\d$/.test(input.deadlineAt)) {
      const expected=FIXED_ZONES[canonical],suffix=ISO.exec(input.deadlineAt),sign=suffix[9]==='-'?-1:1;
      const received=sign*(Number(suffix[10])*60+Number(suffix[11]));
      if(expected!==received)throw error('The explicit UTC offset conflicts with '+canonical+'.');
    }
    if(/^[+-]\d\d:\d\d$/.test(canonical)===false)assertZoneMatchesOffset(input.deadlineAt,deadlineAt,canonical);
    return {deadlineAt,deadlineTimeZone:canonical,deadlineExpression:input.deadlineAt,deadlineSource:'explicit'};
  }
  if(input.deadlineTimeZone!==undefined)throw error('Changing a time zone requires an explicit deadlineAt edit.');
  if(previous && (Object.hasOwn(previous,'deadlineAt')||previous.deadlineSource==='explicit-clear'))
    return {deadlineAt:previous.deadlineAt??null,deadlineTimeZone:previous.deadlineTimeZone??null,
      deadlineExpression:previous.deadlineExpression??null,deadlineSource:previous.deadlineSource??null};
  return inferGoalDeadline(input.objective,nowMs,zone)||
    {deadlineAt:null,deadlineTimeZone:null,deadlineExpression:null,deadlineSource:null};
}
export function goalDeadlineDue(goal,nowMs=Date.now(),monotonicDue=false) {
  return Boolean(goal?.deadlineExpiredAt || (goal?.deadlineAt && (nowMs>=Date.parse(goal.deadlineAt)||monotonicDue)));
}
export function deadlineDisplay(goal) {
  return goal?.deadlineAt?'Goal stops at '+goal.deadlineAt+' ('+(goal.deadlineTimeZone||'UTC')+').':'';
}
