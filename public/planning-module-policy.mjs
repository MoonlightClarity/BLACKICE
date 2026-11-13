/** Lightweight module policy. This is not the legacy planning contract or a task admission gate. */
export const PLANNING_MODULE_STATES = Object.freeze(['on', 'off']);
export const PLANNING_ONTOLOGY_MODULES = Object.freeze([
  { id: 'inference', label: 'Intent inference', description: 'Infer the intended outcome, constraints and relevant context without a separate model pass.' },
  { id: 'feasibility', label: 'Feasibility', description: 'Check real capabilities, dependencies and actual blockers proportionally.' },
  { id: 'decomposition', label: 'Task decomposition', description: 'Break complex work into actionable substeps only when valuable.' },
  { id: 'branching', label: 'Conditional logic', description: 'Use nested IF/ELIF/ELSE and Boolean reasoning when real branches exist.' },
  { id: 'replanning', label: 'Recursive reassessment', description: 'Reconsider earlier choices after meaningful new evidence.' },
  { id: 'metacognition', label: 'Metacognition', description: 'Challenge assumptions and compare competing interpretations.' },
  { id: 'anti_overalignment', label: 'Anti-overalignment calibration', description: 'Detect invented hard gates, overstrict filtering, weak-context decisions, and planning rules that obstruct the explicitly authorized user goal; prefer calibrated, evidence-based action.' },
  { id: 'verification', label: 'Outcome verification', description: 'Check claims and completed effects against available evidence.' },
  { id: 'subagents', label: 'Subagent orchestration', description: 'Delegate separable work to subagents when supported and worthwhile.' },
]);
export const DEFAULT_PLANNING_ONTOLOGY = Object.freeze({
  version: 2,
  modules: Object.freeze(Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id}) => [id, id === 'subagents']))),
});
const ids = new Set(PLANNING_ONTOLOGY_MODULES.map(({id}) => id));
const validRecord = value => value && typeof value === 'object' && !Array.isArray(value);

/** Boolean module choices. Legacy prohibitions remain Off except retired delegation choices.
 * Delegation uses its default behavior. Normalization never rewrites historical run snapshots.
 */
export function normalizePlanningOntology(value, { strict = false } = {}) {
  const invalid = message => { throw Object.assign(new Error(message), {code:'PLANNING_ONTOLOGY_INVALID',status:400}); };
  if (value === undefined || value === null) return {version:2,modules:{...DEFAULT_PLANNING_ONTOLOGY.modules}};
  if (!validRecord(value)) return invalid('Choose a Planning policy with named On/Off modules.');
  const legacy=value.version===undefined||value.version===1;
  if (!legacy&&value.version!==2) return invalid('Unsupported Planning policy version.');
  if(Object.keys(value).some(key=>!(legacy?['version','autoSelect','modules']:['version','modules']).includes(key)))
    return invalid('The On/Off policy accepts only version and modules.');
  if(legacy&&value.autoSelect!==undefined&&typeof value.autoSelect!=='boolean')return invalid('Invalid legacy automatic-selection value.');
  if(value.modules!==undefined&&(!validRecord(value.modules)||Object.keys(value.modules).some(key=>!ids.has(key))))return invalid('Planning policy contains an unknown module.');
  const modules={...DEFAULT_PLANNING_ONTOLOGY.modules};
  const oldStates={mandatory:true,optional:true,auto:true,forbidden:false,on:true,off:false};
  for(const [id,state] of Object.entries(value.modules||{})){
    if(typeof state==='boolean')modules[id]=state;
    else if(legacy&&Object.hasOwn(oldStates,state))modules[id]=oldStates[state];
    else return invalid('Choose On or Off (a Boolean) for '+id+'.');
  }
  // Delegation is automatic, not a selectable Planning module. Accept the saved
  // field for old policies, but never carry a hidden On/Off override into new work.
  modules.subagents=true;
  if(strict&&Object.keys(value.modules||{}).length!==ids.size)return invalid('Supply every module when saving a complete policy.');
  return {version:2,modules};
}
export function planningModuleEnabled(policy,id){return Boolean(policy&&normalizePlanningOntology(policy).modules[id]===true);}
/**
 * Stop decisions are local to the smallest genuinely blocked operation.
 * This does not add a host gate, extra approval or model round trip.
 */
export const ANTI_OVERALIGNMENT_STOP_CALIBRATION = Object.freeze([
  'MINIMUM-SCOPE BLOCKING: Even an affirmatively established, binding obstacle must block ONLY its smallest affected field, action, destination or branch. It never implicitly blocks the whole task, conversation, batch, cronjob or unrelated opportunities.',
  'Treat a blocked leaf as deferred pending resolution, preserve its exact current uncertainty and evidence, and immediately continue independently actionable leaves. If one application is blocked, continue other applications. If one site or model is unavailable, use available alternatives. The desired goal and unfinished work remain open.',
  'Do not mark a parent, entire job search or agent run as blocked or failed merely because a child is blocked. An all-work pause is justified only by an explicit user-wide stop or after verifying that NO independent authorized work of any kind remains; report that as partial progress with unresolved items, never fabricated completion.',
  'STOP ADMISSION IS STRICT: A missing resume statement, unverified skill, hypothetical eligibility issue, model preference, general caution, untested failure, task-contract error or uncertain field is not an affirmative stop. A "required" form field is an input requirement, not permission for the model to invent a disqualifying rule.',
  'A local stop requires concrete evidence that the exact next operation cannot currently be performed truthfully or with available capabilities, such as a binding user constraint, a verified external requirement, actual withheld authorization, or an unreconciled possible duplicate effect. Use inexpensive relevant checks and alternatives first.',
  'SOURCE AND INFERENCE CALIBRATION: User-supplied answers and user uncertainty policy govern. Satisficing permits grounded probability-based inference, not a records-only gate. Agent plans and checkpoints add no user constraints. Distinguish supplied facts, inferred answers and unknowns; never invent evidence, certainty or false certifications. Preserve actual authorization limits.',
  'SHARED UNCERTAINTY: When one prerequisite recurs, reassess the shared assumption and context once under user uncertainty policy. Repeatedly parking leaves or browsing for exceptions is not progress. Report only the residual actual blocker.',
  'Overcautious ambiguity and certainty bias are not decision criteria. Compare upside, likelihood, downside, reversibility, delay and opportunity cost with grounded qualitative judgment or explicitly labeled estimates. User hard gates remain binding, but employer wishlists and inferred prerequisites are not automatically hard gates.',
  'Inspect previous submission records and destination receipts before possibly repeated external effects; an open tab is not proof of a duplicate or its cause. If the effect remains uncertain, quarantine only that affected submission while other applications proceed.',
  'No separate per-action checklist, mandatory planning contract or user approval ritual. In the final user report, distinguish completed outcomes, parked leaf items and unverified external results; name only actual evidence and blockers.'
]);
const descriptions = {
  inference:'identify user intent and real constraints before acting',
  feasibility:'check resources and actual blocking dependencies at the point of need',
  decomposition:'decompose meaningful compound work into actionable subtasks',
  branching:'apply IF/ELIF/ELSE over observed facts when a consequential branch exists',
  replanning:'revisit prior conclusions or paths when new evidence changes the action',
  metacognition:'test a material assumption against its strongest relevant alternative',
  anti_overalignment:ANTI_OVERALIGNMENT_STOP_CALIBRATION.join(' '),
  verification:'verify consequential claims and external effects with available observations',
  subagents:'delegate distinct parallelizable work and reconcile actual worker results',
};
/** On is a user choice, not permission for a model to downgrade a module. */
export function planningOntologyInstructions(config) {
  const policy=normalizePlanningOntology(config),on=[],off=[];
  for(const {id,label} of PLANNING_ONTOLOGY_MODULES){
    if(id==='subagents')continue;
    if(policy.modules[id])on.push(label+': '+descriptions[id]);else off.push(label);
  }
  return [
    'BLACKICE PLANNING MODULES — ON / OFF',
    'The listed On/Off modules are explicit user choices. On means apply the module at the relevant stage of this task. Off means do not invoke that module. Do not change these module choices during a task.',
    'OPTIONAL DELEGATION: The delegation tool remains available. Use it when the user requests delegation or expected task benefit outweighs coordination, latency and token cost; otherwise work directly. Reconcile actual worker results. Availability does not require a separate worker or imply a default-on reasoning module.',
    'Enabled modules cooperate with Directory execution and its persisted evidence. Carry observations and dependencies forward across fresh contexts. A context reset does not invalidate recorded observations or end the delegated task.',
    on.length?'ON: '+on.join('; '):'All Planning modules are Off.',
    off.length?'OFF: '+off.join('; '):'No Planning modules are Off.',
    'Apply enabled methods proportionally to the actual task. Do not invent extra steps, new hard gates, approval rituals or perfect-completion conditions. A module need not consume a separate provider call. Completion review checks actual outcomes and continues genuinely unfinished work; it must not mistake an abbreviated display for missing evidence.',
  ].join('\n');
}
