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

/** The immutable objective carried by an exactly bound Goal turn is a task-method
 * selection input, not additional permission or a controller mutation. Using
 * the run's admitted snapshot avoids losing owner methods during the short
 * currentRunId/epoch synchronization window. All model and tool admissions
 * remain governed by ConversationGoals.assertProviderAdmission. */
export function boundGoalMethodObjective(run) {
 const binding=run?.goalDispatch, goal=run?.goal, rootId=run?.taskId||run?.id;
 if(!binding||!goal||!rootId||binding.conversationId!==rootId
    || binding.goalId!==goal.id || binding.generation!==goal.generation
    || !Number.isSafeInteger(binding.epoch) || binding.epoch<0
    || typeof goal.objective!=='string'||!goal.objective.trim())return null;
 return goal.objective;
}

// Main-turn guidance for an explicit change of direction, not a topic classifier.
// Keep the input bounded and ignore quoted examples or pasted history.
export function currentRequestText(input, limit = 8000) {
 if(typeof input!=='string')return '';
 let fence=null;
 return input.slice(0,limit).split(/\r?\n/).flatMap(line=>{
  const delimiter=/^\s*(`\x60{2,}|~{3,})/.exec(line)?.[1][0];
  if(delimiter){if(!fence)fence=delimiter;else if(fence===delimiter)fence=null;return [];}
  if(fence||/^\s*>/.test(line))return [];
  return [line.replace(/["“][^"”\n]*["”]/g,' ')];
 }).join('\n');
}
export function wantsIntentInferenceSkill(input) {
 const current=currentRequestText(input);
 return /(?:^|[.!?]\s+|\n)\s*(?:please\s+)?(?:use|load|read)\s+(?:the\s+)?intent inference skill\b/i.test(current)
  || /\b(?:(?:i|we)\s+(?:(?:am|are)\s+(?:trying|looking)|want|need|plan|would like)|(?:i['\u2019]m|we['\u2019]re)\s+(?:trying|looking)|(?:the|my|our)\s+goal\s+is)\s+to\s+(?:get\s+out\s+of|move\s+(?:away\s+from|out\s+of)|transition\s+(?:away\s+from|out\s+of)|stop\s+\w+ing\b|replace\s+(?:our|my|the)\s+(?:workflow|process|approach)\b)(?:\s+\S|[.!?]|$)/i.test(current);
}
export function wantsJobSearchSkill(input) {
 const current=currentRequestText(input);
 // Select only a current job-search command, not a passing mention or job-system task.
 return /(?:^|[.!?]\s+|\n)\s*(?:please\s+)?(?:use|load|read)\s+(?:the\s+)?job search skill\b/i.test(current)
  || /(?:^|[.!?]\s+|\n)\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:job[ -]search|search\s+(?:job boards|jobs)\b|(?:find|shortlist|look for|search for|identify|locate|apply\s+(?:for|to))\s+(?:[^.!?;\r\n]|\bU\.S\.){0,125}?\b(?:jobs?|job\s+openings?|openings?|positions?|roles?)\b)(?!\s+(?:in (?:this|the) (?:repository|codebase|database|queue|scheduler)|permissions|and permissions))(?:\s|[.!?,;:]|$)/i.test(current);
}
// Main Job Search delivery only. Browser navigation, task grounding and
// delegated prompt selection retain their existing direct-request rules.
export function wantsJobSearchExecutionSkill(input) {
 const current=currentRequestText(input,50000);
 const workflow=/^\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:run|restart|resume|continue|conduct|perform|carry\s+out|undertake|start|begin|do)\s+(?:(?:the|a|my|our|real|actual|BLACKICE|overnight|ongoing|remote)\s+)*(?:job[ -]search(?:\s*\/\s*application)?|job[ -]application)\b(?:\s+workflow\b)?/i.exec(current);
 if(!workflow)return wantsJobSearchSkill(input);
 const scope=current.slice(workflow[0].length);
 return !/^\s+(?:tests?|fixtures?|simulat(?:ion|or)|skills?|discussion|documentation|implementation|code|methods?|strategy|research)\b/i.test(scope)
  && !/\b(?:dry[ -]run|(?:simulation|diagnos(?:e|is|tic)|mock)[ -]only|only\s+diagnose|as\s+a\s+(?:simulation|mock)|in\s+(?:simulation|mock)\s+mode)\b/i.test(scope)
  && !/\b(?:no\s+live\s+(?:actions?|search(?:es)?|browsing)|without\s+(?:actually\s+)?(?:searching|browsing|running\s+it)|(?:do not|don['\u2019]t)\s+(?:actually\s+)?(?:search|browse|run\s+it|(?:take|perform|execute)\s+(?:any\s+)?(?:live\s+)?actions?))\b/i.test(scope);
}
// Exact, explicitly requested method names. Do not select from quoted examples,
// model reports, or loose keyword matches against skill bodies. The engine
// resolves these names against the effective catalog for the bound request.
export function explicitMethodTitles(input) {
 const current=currentRequestText(input,50000);
 const names=[];
 const command=/(?:^|[.!?]\s+|\n)\s*(?:please\s+)?(?:read\s+and\s+use|load\s+and\s+use|read|load|use)\s+(?:the\s+)?(?:current\s+)?([^.!?;\r\n]{1,500})/gi;
 for(const match of current.matchAll(command)){
  const parts=match[1].split(/\s+skill(?:\s*\(revision\s+\d+\))?\s*(?:,\s*(?:and\s+)?|\s+and\s+|$)/i);
  // A final empty fragment establishes that this is a complete selection
  // clause, not a request to edit, critique, or describe the mentioned skill.
  if(parts.length<2||parts.at(-1).trim())continue;
  for(const part of parts.slice(0,-1)){
   const title=part.trim().replace(/^(?:the\s+)?(?:current\s+)?/i,'');
   if(title&&title.length<=200&&!names.some(name=>name.toLowerCase()===title.toLowerCase()))names.push(title);
  }
 }
 return names;
}
export function wantsBrowserNavigationSkill(input, { previousTask } = {}) {
 const current=currentRequestText(input);
 if (typeof previousTask==='string' && /^\s*(?:please\s+)?(?:continue|resume|go on|keep going)[.!]?\s*$/i.test(current))
  return wantsBrowserNavigationSkill(previousTask);
 return wantsJobSearchSkill(input)
  || /(?:^|[.!?]\s+|\n)\s*(?:please\s+)?(?:use|load|read)\s+(?:the\s+)?browser navigation(?: and continuity)? skill\b/i.test(current)
  || /(?:^|[.!?]\s+|\n)\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:open|visit|navigate to|inspect|check|resume|continue|use|search)\s+[^.!?;\r\n]{0,100}?(?:\b(?:browser|website|web page|portal|tab)\b|https?:\/\/)/i.test(current);
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

