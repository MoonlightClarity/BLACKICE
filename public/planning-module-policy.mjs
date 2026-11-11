/** Lightweight module policy. This is not the legacy planning contract or a task admission gate. */
export const PLANNING_MODULE_STATES = Object.freeze(['mandatory', 'optional', 'forbidden']);
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
  version: 1,
  autoSelect: true,
  modules: Object.freeze(Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id}) => [id, id === 'anti_overalignment' ? 'mandatory' : 'optional']))),
});
const ids = new Set(PLANNING_ONTOLOGY_MODULES.map(({id}) => id));
const validRecord = value => value && typeof value === 'object' && !Array.isArray(value);

/** Invalid policies never silently escalate to mandatory or relax forbidden. */
export function normalizePlanningOntology(value, { strict = false } = {}) {
  const invalid = message => { throw Object.assign(new Error(message), {code:'PLANNING_ONTOLOGY_INVALID',status:400}); };
  if (value === undefined || value === null) return { version:1, autoSelect:true, modules:{...DEFAULT_PLANNING_ONTOLOGY.modules} };
  if (!validRecord(value) || Object.keys(value).some(key => !['version','autoSelect','modules'].includes(key)))
    return invalid('Choose a Planning ontology with autoSelect and named modules.');
  if (value.version !== undefined && value.version !== 1) return invalid('Unsupported Planning ontology version.');
  if (value.autoSelect !== undefined && typeof value.autoSelect !== 'boolean') return invalid('Automatic module selection must be true or false.');
  if (value.modules !== undefined && (!validRecord(value.modules) || Object.keys(value.modules).some(key=>!ids.has(key))))
    return invalid('Planning ontology contains an unknown module.');
  const modules={...DEFAULT_PLANNING_ONTOLOGY.modules};
  for (const [id,state] of Object.entries(value.modules || {})) {
    if (!PLANNING_MODULE_STATES.includes(state)) return invalid('Choose Mandatory, Optional or Forbidden for '+id+'.');
    modules[id]=state;
  }
  if (strict && Object.keys(value.modules || {}).length !== ids.size) return invalid('Supply every module state when saving a complete ontology.');
  return {version:1,autoSelect:value.autoSelect!==false,modules};
}
/**
 * Stop decisions are local to the smallest genuinely blocked operation.
 * This does not add a host gate, extra approval or model round trip.
 */
export const ANTI_OVERALIGNMENT_STOP_CALIBRATION = Object.freeze([
  'MINIMUM-SCOPE BLOCKING: Even an affirmatively established, binding obstacle must block ONLY its smallest affected field, action, destination or branch. It never implicitly blocks the whole task, conversation, batch, cronjob or unrelated opportunities.',
  'Treat a blocked leaf as deferred pending resolution, preserve its exact current uncertainty and evidence, and immediately continue independently actionable leaves. If one application is blocked, continue other applications. If one site or model is unavailable, use available alternatives. The desired goal and unfinished work remain open.',
  'Do not mark a parent, entire job search or agent run as blocked or failed merely because a child is blocked. An all-work pause is justified only by an explicit user-wide stop or after verifying that NO independent authorized work of any kind remains; report that as partial progress with unresolved items, never fabricated completion.',
  'STOP ADMISSION IS STRICT: A missing resume statement, unverified skill, hypothetical eligibility issue, model preference, general caution, untested failure, task-contract error or uncertain field is not an affirmative stop. A "required" form field is an input requirement, not permission for the model to invent a disqualifying rule.',
  'A local stop requires concrete evidence that the exact next operation cannot currently be performed truthfully or with available capabilities, such as a binding user constraint, a verified external requirement, a consequential personal declaration without a supportable answer, actual withheld authorization, or an unreconciled possible duplicate effect. Use inexpensive relevant checks and alternatives first.',
  'For sponsorship Yes/No without an explicit known answer, do not presume Yes, do not invent No, and never block other applications: consult supported prior facts and context; answer truthfully when evidence permits; otherwise park only that single form field or dependent application until the missing fact can be resolved.',
  'Overcautious ambiguity and certainty bias are not decision criteria. Compare upside, likelihood, downside, reversibility, delay and opportunity cost with grounded qualitative judgment or explicitly labeled estimates. User hard gates remain binding, but employer wishlists and inferred prerequisites are not automatically hard gates.',
  'Inspect previous submission records and destination receipts before possibly repeated external effects; an open tab is not proof of a duplicate or its cause. If the effect remains uncertain, quarantine only that affected submission while other applications proceed.',
  'No separate stop checklist, planning contract, loop, extra provider pass or user approval ritual. In the final user report, distinguish completed outcomes, parked leaf items and unverified external results; name only actual evidence and blockers.'
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
/** No full planning cycle, saved contract, extra model request or forced review is necessary. */
export function planningOntologyInstructions(config) {
  const policy=normalizePlanningOntology(config);
  const mandatory=[],optional=[],forbidden=[];
  for(const {id,label} of PLANNING_ONTOLOGY_MODULES){
    const value=`${label}: ${descriptions[id]}`;
    if(policy.modules[id]==='mandatory')mandatory.push(value);
    else if(policy.modules[id]==='forbidden')forbidden.push(value);
    else optional.push(value);
  }
  const parts=[
    'MODULAR PLANNING ONTOLOGY (replaces the forced planning contract)',
    'This policy does not require a saved plan, task-state checkpoint, recursive step ledger, or separate model call before work. Take useful action directly. Keep the response timely. A module is a method, not a new mandatory provider round trip.',
    mandatory.length?'MANDATORY: Apply these methods where their subject exists; do not create artificial work just to show a method. '+mandatory.join('; '):'No mandatory reasoning modules.',
    forbidden.length?'FORBIDDEN: Do not invoke or emulate these optional planning methods, including through another selected method. '+forbidden.join('; '):'No forbidden planning methods.',
    policy.autoSelect
      ? 'AUTOMATIC SELECTION: For each user-Optional module, the model may select task-local Mandatory, Optional or Forbidden based on expected value, complexity, available tools and time. User-Mandatory and user-Forbidden remain fixed. Resolve inline, without a separate selection pass or planning contract; do not pretend the temporary choice changes saved defaults.'
      : 'MANUAL SELECTION: Do not proactively use OPTIONAL modules. They are available only when expressly requested for this task by the user.',
    optional.length?'OPTIONAL: '+optional.join('; '):'No optional planning modules.',
    'Explicit user module states take precedence over automatic selection. A forbidden module is never implied by a mandatory one. Missing module capabilities should be reported accurately, not presented as model unavailability. Preserve factual accuracy and real user constraints without inventing approval checkpoints.',
  ];
  return parts.join('\n');
}
