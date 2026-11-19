import {inferGoalDeadline} from './goal-deadline.mjs';

const clockTime=/\b(?:until|by|before|through)\s+(?:(?:today|tomorrow|tonight|\d{4}-\d\d-\d\d)\s+(?:at\s+)?)?(?:at\s+)?(?:\d{1,2}(?::\d\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b|noon\b|midnight\b)/i;
const explicitZone=/\b(?:EST|EDT|ET|Eastern(?:\s+Time)?|UTC|GMT|America\/New_York)\b/i;
export function intentInferenceSignals(text) {
 if(typeof text!=='string')return [];
 const signals=[];
 if(clockTime.test(text))signals.push('clock-time');
 if(/^\s*(?:please\s+)?apply\s+(?:for|to)\s+(?:(?:new|remote|suitable|some)\s+)*(?:jobs|roles|positions|openings)\b/i.test(text))signals.push('external-action-scope');
 if(/\b(?:what i meant|i mean|not what i (?:meant|asked)|intent inference|infer (?:my|the) intent|what do i mean)\b/i.test(text))signals.push('explicit-intent');
 if(/\b(?:pick up where we left off|same as (?:before|last time)|continue (?:that|the previous) (?:run|task|work)|resume (?:the|that) (?:goal|run)|use the usual (?:one|version)|whichever makes sense)\b/i.test(text))signals.push('reference-or-continuation');
 return signals;
}

export function chatIntentContext(run,boundGoal) {
 const signals=intentInferenceSignals(run.input);
 if(!signals.length)return null;
 const epoch=Date.parse(run.createdAt);
 const context={signals,referenceTime:Number.isFinite(epoch)?new Date(epoch).toISOString():null,
  requestKind:boundGoal?'bound-goal':run.retryOf?'retry':run.parentRunId?'current-follow-up':'fresh-request'};
 if(boundGoal){
  context.activeGoalDeadline=boundGoal.deadlineAt||null;
  return context;
 }
 // Use the existing parser as a clock calculation only. This object does not
 // create a Goal, change admission, authorize tools, or move any saved cutoff.
 if(!run.retryOf&&signals.includes('clock-time')&&explicitZone.test(run.input)&&Number.isFinite(epoch)){
  try {
   const parsed=inferGoalDeadline(run.input,epoch);
   if(parsed&&explicitZone.test(parsed.deadlineExpression))context.clockCandidate={instant:parsed.deadlineAt,timeZone:parsed.deadlineTimeZone,expression:parsed.deadlineExpression,
    alreadyElapsed:Date.parse(parsed.deadlineAt)<=epoch};
  } catch(error) {
   if(['GOAL_DEADLINE_AMBIGUOUS','GOAL_DEADLINE_INVALID'].includes(error?.code))context.clockCandidateUnresolved=true;
  }
 }
 return context;
}

