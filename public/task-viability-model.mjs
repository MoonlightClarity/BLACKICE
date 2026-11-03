/** Structured public findings for the shared request/schedule readiness check. */
const field = (id, label, description, grounding = 'prospective') => Object.freeze({ id, label, description, prompt: description, required: true, grounding });
export const VIABILITY_TEMPLATE = Object.freeze({ kind: 'viability', label: 'Check task readiness', description: 'Check actual resources against the intended task before costly work; expose concrete blockers and distinguish model-repairable gaps, unknowns and nonblocking symptoms.', fields: Object.freeze([
  field('objective', 'Requested outcome', 'State the current requested outcome, including any correction or cancellation in later user input.', 'required'),
  field('essentialInputs', 'Essential inputs and preferences', 'Separate actual required inputs and hard constraints from preferences. Match accuracy to the requested decision: exact, a bounded estimate, or qualitative. A preferred qualification is not an essential requirement.', 'required'),
  field('evidenceRecovery', 'Evidence already checked', 'Identify the supplied records, earlier answers and relevant evidence inspected before calling a fact missing.', 'required'),
  field('feasiblePath', 'Plausible route', 'Describe a feasible route using actual capabilities and known inputs, or state the material dependency that prevents it.'),
  field('inferenceLimits', 'Inference and its limits', 'Use supported ordinary inferences. State permitted assumptions, ranges or omissions at the accuracy the task needs. Do not invent consequential personal facts or precision. Given fictional or stipulated premises are the scope of the task, not a request to verify external reality.'),
  field('independentWork', 'Independent useful work', 'Identify useful work that does not depend on an unresolved essential fact. Do not claim it was performed.'),
  field('recheckWhen', 'What would change this check', 'Identify a change that could alter the decision or violate a real constraint. State when checking is sufficient; if no decision-changing unknown remains, say so.')
]) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(message), { code: 'TASK_VIABILITY_INVALID', status: 400 });
const text = (value, label, max = 4000, required = false) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(label + ' must be bounded text.');
  return value.trim();
};
const list = (value, label, max = 40, { evidenceRefs = false } = {}) => {
  if (!Array.isArray(value) || value.length > max) throw fail(label + ' must be a bounded list.');
  const values = value.map(item => text(item, label, 300, true));
  // Repeating one exact source ID cannot increase evidentiary coverage.
  // Canonicalize these references instead of spending provider retries on syntax.
  if (evidenceRefs) return [...new Set(values)];
  if (new Set(values).size !== values.length) throw fail(label + ' cannot contain duplicates.');
  return values;
};
export const planningExplanatoryValueField = field => !['answer', 'observedResult', 'claim'].includes(field);
/** Readability only: these findings cannot consist solely of their evidence identifiers. */
export function planningReadableFindingIssues(value, sources = []) {
  const ids = [...new Set(sources.map(source => typeof source === 'string' ? source : source?.id).filter(id => typeof id === 'string' && id.length))].sort((a, b) => b.length - a.length);
  if (!ids.length || !value) return [];
  const onlyReferences = text => {
    if (typeof text !== 'string' || !text.trim()) return false;
    let found = false, remainder = text;
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      remainder = remainder.replace(new RegExp(escaped, 'g'), (match, offset, whole) => {
        const before = whole[offset - 1], after = whole[offset + match.length];
        if (before && /[\p{L}\p{N}_]/u.test(before) || after && /[\p{L}\p{N}_]/u.test(after)) return match;
        found = true; return '';
      });
    }
    remainder = remainder.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '').replace(/\b(?:and|or)\b/gi, '');
    return found && /^[\s\p{P}\p{S}]*$/u.test(remainder);
  };
  const issues = [], check = (path, text) => {
    if (issues.length < 12 && onlyReferences(text)) issues.push({ path, message: 'Write a readable public finding here; put evidence identifiers in grounding or sourceIds.' });
  };
  for (const [field, text] of Object.entries(value.values || {})) if (planningExplanatoryValueField(field)) check('values.' + field, text);
  // Check declared explanations, never identifier fields or literal findings.
  // A requested answer, claim, result summary or excerpt may itself be an ID.
  const explanatoryFields = {
    checks: ['note'], challengeResponses: ['note'], requirements: ['rationale'],
    inferences: ['limitation'], acceptanceCriteria: ['description'], steps: ['description'],
    criterionResults: ['rationale'], childResults: ['usedFor'], coverage: ['limitation'],
    subproblems: ['objective', 'reason']
  };
  for (const [collection, fields] of Object.entries(explanatoryFields)) {
    if (!Array.isArray(value[collection])) continue;
    for (const [index, item] of value[collection].entries()) {
      for (const field of fields) check(collection + '[' + index + '].' + field, item?.[field]);
      if (collection === 'subproblems' && Array.isArray(item?.acceptanceCriteria)) {
        for (const [criterionIndex, criterion] of item.acceptanceCriteria.entries()) check('subproblems[' + index + '].acceptanceCriteria[' + criterionIndex + '].description', criterion?.description);
      }
    }
  }
  return issues;
}
export function validatePlanningReadableFindings(value, sources = []) {
  const issues = planningReadableFindingIssues(value, sources);
  if (issues.length) throw Object.assign(new Error(issues[0].path + ': ' + issues[0].message), { code: 'PLANNING_RESPONSE_READABILITY', status: 400, issues });
  return value;
}
const schemaTree = value => JSON.parse(JSON.stringify(value));
export const TASK_ACCURACY_FIELDS = Object.freeze(['mode', 'tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'unknownPolicy', 'stopWhen']);
/** The target describes sufficient accuracy; it does not certify a claim or fill missing facts. */
export function validateTaskAccuracy(value) {
  if (value === undefined || value === null) return undefined;
  if (!object(value) || Object.keys(value).some(key => !TASK_ACCURACY_FIELDS.includes(key)) || TASK_ACCURACY_FIELDS.some(key => !Object.hasOwn(value, key))) throw fail('Use the declared task accuracy fields.');
  if (!['exact', 'bounded_estimate', 'qualitative'].includes(value.mode)) throw fail('Accuracy must be exact, bounded_estimate or qualitative.');
  if (!['block', 'assumption', 'range', 'omit'].includes(value.unknownPolicy)) throw fail('State whether unresolved uncertainty blocks, permits a stated assumption or range, or permits omission.');
  return { mode: value.mode, tolerance: text(value.tolerance, 'Accuracy tolerance', 2000, value.mode === 'bounded_estimate'),
    decisionThreshold: text(value.decisionThreshold, 'Decision threshold', 2000), evidenceNeeded: text(value.evidenceNeeded, 'Evidence needed', 2000, true),
    consequence: text(value.consequence, 'Consequence of being wrong', 2000, true), unknownPolicy: value.unknownPolicy, stopWhen: text(value.stopWhen, 'Sufficient checking condition', 2000, true) };
}
export function taskAccuracySchema() {
  const string = { type: 'string' };
  return schemaTree({ anyOf: [{ type: 'object', additionalProperties: false, required: [...TASK_ACCURACY_FIELDS], properties: {
    mode: { type: 'string', enum: ['exact', 'bounded_estimate', 'qualitative'] }, tolerance: string, decisionThreshold: string,
    evidenceNeeded: string, consequence: string, unknownPolicy: { type: 'string', enum: ['block', 'assumption', 'range', 'omit'] }, stopWhen: string
  } }, { type: 'null' }] });
}
/** The only agent-authored stop claims recognized by readiness. Uncertainty is not one. */
export const PLANNING_STOP_KINDS = Object.freeze(['user_prohibited', 'target_denied', 'known_false_certification', 'human_control_taken', 'unreconciled_dispatch']);
export const VIABILITY_REQUIREMENT_FIELDS = Object.freeze(['id', 'label', 'importance', 'basis', 'consequence', 'resolution', 'value', 'sourceIds', 'checkedSourceIds', 'rationale', 'inferable', 'omissionAllowed', 'question', 'dependentNodeIds']);
export function validateViabilityRequirements(value) {
  if (!Array.isArray(value) || value.length > 60) throw fail('Readiness needs at most 60 explicit requirement findings.');
  const ids = new Set();
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !VIABILITY_REQUIREMENT_FIELDS.includes(key) && key !== 'accuracy' && key !== 'stopKind') || VIABILITY_REQUIREMENT_FIELDS.some(key => !Object.hasOwn(item, key))) throw fail('Use the declared readiness requirement fields.');
    const id = text(item.id, 'Requirement ID', 120, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw fail('Requirements need unique stable IDs.');
    ids.add(id);
    if (!['essential', 'preference'].includes(item.importance)) throw fail('A requirement is essential or a preference.');
    if (!['user', 'task', 'external'].includes(item.basis)) throw fail('Record the actual source of the requirement.');
    if (!['observed', 'inference', 'omission', 'unknown','blocked','repairable','nonblocking'].includes(item.resolution)) throw fail('Use an observed fact, supported inference, permitted omission, unknown, confirmed blocker, model-repairable gap or nonblocking symptom.');
    if (typeof item.inferable !== 'boolean' || typeof item.omissionAllowed !== 'boolean') throw fail('State whether inference and omission are appropriate.');
    const result = { id, label: text(item.label, 'Requirement', 500, true), importance: item.importance, basis: item.basis,
      consequence: text(item.consequence, 'Consequence', 2000, item.importance === 'essential'), resolution: item.resolution,
      value: text(item.value, 'Resolved value'), sourceIds: list(item.sourceIds, 'Evidence source IDs', 40, { evidenceRefs: true }), checkedSourceIds: list(item.checkedSourceIds, 'Checked source IDs', 100, { evidenceRefs: true }),
      rationale: text(item.rationale, 'Resolution rationale', 4000, true), inferable: item.inferable, omissionAllowed: item.omissionAllowed,
      question: text(item.question, 'Public factual question', 2000), dependentNodeIds: list(item.dependentNodeIds, 'Dependent workflow node IDs', 100) };
    const accuracy = validateTaskAccuracy(item.accuracy); if (accuracy) result.accuracy = accuracy;
    if (item.stopKind !== undefined && item.stopKind !== null) {
      if (!PLANNING_STOP_KINDS.includes(item.stopKind)) throw fail('A stop must name an allowed concrete stop condition.');
      result.stopKind = item.stopKind;
    }
    // An unknown can be preserved for the owning worker without manufacturing a user question.
    return result;
  });
}
export function viabilityRequirementSchema() {
  const string = { type: 'string' }, strings = { type: 'array', items: string };
  return schemaTree({ type: 'array', items: { type: 'object', additionalProperties: false, required: [...VIABILITY_REQUIREMENT_FIELDS, 'stopKind', 'accuracy'], properties: {
    id: string, label: string, importance: { type: 'string', enum: ['essential', 'preference'] }, basis: { type: 'string', enum: ['user', 'task', 'external'] },
    consequence: string, resolution: { type: 'string', enum: ['observed', 'inference', 'omission', 'unknown','blocked','repairable','nonblocking'] }, value: string,
    sourceIds: strings, checkedSourceIds: strings, rationale: string, inferable: { type: 'boolean' }, omissionAllowed: { type: 'boolean' }, question: string, dependentNodeIds: strings, stopKind: { anyOf: [{ type: 'string', enum: [...PLANNING_STOP_KINDS] }, { type: 'null' }] }, accuracy: taskAccuracySchema()
  } } });
}
const sourceIdentity = source => [source.id, source.contentHash || '', source.text || '', source.revision ?? null];
const canonicalResponseValue=value=>Array.isArray(value)?value.map(canonicalResponseValue):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalResponseValue(value[key])])):value;
const responseSourceIdentity=source=>JSON.stringify(canonicalResponseValue({id:source.id,kind:source.kind,responseId:source.responseId,revision:source.revision,text:source.text??null,contentHash:source.contentHash??null,provenance:source.provenance??null}));
/** This computes readiness of recorded findings, never truth of the underlying claims. */
export function evaluateViabilityResponse(response, sources = [], { workflowNodeIds = null,upstreamResponses=[] } = {}) {
  if (!response) return { state: 'needs_evidence', analysisReady: false, blockingFacts: [], preferences: [], issues: ['No structured readiness response has been recorded.'] };
  let requirements;
  try { requirements = validateViabilityRequirements(response.requirements); }
  catch (error) { return { state: 'needs_evidence', analysisReady: false, blockingFacts: [], preferences: [], issues: [error.message] }; }
  const current = new Map(sources.filter(source => source.kind !== 'response').map(source => [source.id, source]));
  const captured = new Map((response.sources || []).filter(source => source.kind !== 'response').map(source => [source.id, source]));
  // Response sources are not base facts. Validate only cited, exact current
  // host-bound inputs; unrelated/self/later responses must not stale the check.
  const currentResponses=new Map(sources.filter(source=>source.kind==='response').map(source=>[source.id,source]));
  const capturedResponses=new Map((response.sources||[]).filter(source=>source.kind==='response').map(source=>[source.id,source]));
  const inputs=(response.inputs||[]).flatMap(input=>[input,...(input.subtree||[])]);
  const usableUpstream=id=>{
    const now=currentResponses.get(id),then=capturedResponses.get(id);
    if(!now||!then||id!=='response:'+now.responseId||now.responseId===response.id||!Number.isSafeInteger(now.revision)||now.revision<1||!['runtime','human','external_agent','supervising_model'].includes(now.provenance?.kind)||responseSourceIdentity(now)!==responseSourceIdentity(then))return false;
    const bound=upstreamResponses.find(item=>item.nodeId&&item.nodeId!==response.nodeId&&item.responseId===now.responseId&&item.responseRevision===now.revision);
    return Boolean(bound&&inputs.some(input=>input.nodeId===bound.nodeId&&input.responseId===bound.responseId&&input.responseRevision===bound.responseRevision));
  };
  const staleSources = [...current.values()].filter(source => !captured.has(source.id) || JSON.stringify(sourceIdentity(source)) !== JSON.stringify(sourceIdentity(captured.get(source.id)))).map(source => source.id);
  for (const source of captured.values()) if (!current.has(source.id)) staleSources.push(source.id);
  const issues = planningReadableFindingIssues(response, response.sources || []).map(issue => issue.path + ': ' + issue.message), blockingFacts = [], preferences = [],repairableGaps=[],nonblockingSymptoms=[],unresolvedFacts=[],unverifiedStopClaims=[];
  const analysisIssues = [...issues], sourceCoverage = [];
  const suppliedFacts = [...current.values()].filter(source => !source.id.startsWith('request:') && source.id !== 'viability:workflow').map(source => source.id);
  for (const requirement of requirements) {
    if (requirement.importance === 'preference') { preferences.push({ id: requirement.id, label: requirement.label }); continue; }
    // Preserve unknown facts for the owning run; automatic execution defers their resolution.
    if (requirement.resolution === 'unknown') unresolvedFacts.push({ id: requirement.id, label: requirement.label, question: requirement.question, consequence: requirement.consequence, affectedNodeIds: requirement.dependentNodeIds, checkedSourceIds: requirement.checkedSourceIds, rationale: requirement.rationale });
    // The model cannot manufacture a stop from generic caution or a missing answer.
    if (requirement.resolution === 'blocked' && !requirement.stopKind) {
      unverifiedStopClaims.push({ id: requirement.id, label: requirement.label, reason: 'No concrete stopKind was identified.', sourceIds: requirement.sourceIds });
      continue;
    }
    const references = [...requirement.sourceIds, ...requirement.checkedSourceIds];
    const responseReferences=references.filter(id=>capturedResponses.has(id)||currentResponses.has(id));
    for(const id of responseReferences)if(currentResponses.has(id)&&capturedResponses.has(id)&&responseSourceIdentity(currentResponses.get(id))!==responseSourceIdentity(capturedResponses.get(id))&&!staleSources.includes(id))staleSources.push(id);
    const missing = references.filter(id => !capturedResponses.has(id)&&!currentResponses.has(id)&&(!captured.has(id) || !current.has(id)));
    let reason, coverageOnly = false;
    if (missing.length) reason = 'A recorded evidence reference is unavailable.';
    else if(responseReferences.some(id=>!usableUpstream(id)))reason='A cited upstream response is not the unchanged current consumed prerequisite.';
    else if (workflowNodeIds && requirement.dependentNodeIds.some(id => !workflowNodeIds.includes(id))) reason = 'A dependency names a workflow node outside this request.';
    else if (requirement.resolution === 'unknown' && !requirement.checkedSourceIds.length) { reason = 'Inspect the captured sources before treating this essential fact as missing.'; coverageOnly = true; }
    else if (requirement.resolution === 'unknown' && suppliedFacts.some(id => !requirement.checkedSourceIds.includes(id))) { reason = 'Inspect all supplied records and earlier answers before treating this essential fact as missing.'; coverageOnly = true; }
    else if (requirement.resolution === 'unknown') reason = 'An essential fact remains unresolved.';
    else if (['blocked','repairable','nonblocking'].includes(requirement.resolution)&&(!requirement.value||!requirement.sourceIds.length))reason='A resource classification needs actual diagnostic evidence and a concrete finding.';
    else if (requirement.resolution === 'blocked') reason = 'A confirmed resource prerequisite prevents the affected work.';
    else if (requirement.resolution === 'inference' && !requirement.inferable) reason = 'This consequential fact cannot responsibly be inferred.';
    else if (requirement.resolution === 'omission' && !requirement.omissionAllowed) reason = 'The requested task does not permit omission of this fact.';
    else if (requirement.resolution === 'omission' && requirement.accuracy && requirement.accuracy.unknownPolicy !== 'omit') reason = 'The saved accuracy target does not permit omission of this essential fact.';
    else if (['observed', 'inference'].includes(requirement.resolution) && (!requirement.value || !requirement.sourceIds.length)) reason = 'A resolved essential fact needs actual captured evidence.';
    else if (requirement.resolution === 'omission' && !requirement.sourceIds.length) reason = 'A permitted omission needs a source supporting that option.';
    if(!reason&&requirement.resolution==='repairable')repairableGaps.push({id:requirement.id,label:requirement.label,affectedNodeIds:requirement.dependentNodeIds,finding:requirement.value,remedy:requirement.rationale,sourceIds:requirement.sourceIds});
    if(!reason&&requirement.resolution==='nonblocking')nonblockingSymptoms.push({id:requirement.id,label:requirement.label,finding:requirement.value,rationale:requirement.rationale,sourceIds:requirement.sourceIds});
    if (reason) {
      const question = requirement.question || 'What is the correct ' + requirement.label + '?';
      blockingFacts.push({ id: requirement.id, label: requirement.label, question, consequence: requirement.consequence, dependentNodeIds: requirement.dependentNodeIds, reason,resolution:requirement.resolution,diagnostic:requirement.value,remedy:requirement.rationale,sourceIds:requirement.sourceIds });
      if (!['An essential fact remains unresolved.','A confirmed resource prerequisite prevents the affected work.'].includes(reason)) {
        issues.push(reason);
        if (coverageOnly) sourceCoverage.push({ requirementId: requirement.id, missingSourceIds: suppliedFacts.filter(id => !requirement.checkedSourceIds.includes(id)), message: reason });
        else analysisIssues.push(reason);
      }
    }
  }
  // Incomplete inspection metadata still holds strict dispatch and factual questions.
  // It is not a reason to prevent a grounded plan from arranging the missing inspection.
  // Never fill checkedSourceIds or change an unknown into an observed fact here.
  return { state: staleSources.length ? 'stale' : issues.length ? 'needs_evidence' : blockingFacts.some(fact=>fact.resolution==='blocked')?'blocked':blockingFacts.length ? 'awaiting_input' : 'ready',
    analysisReady: !staleSources.length && !analysisIssues.length, analysisIssues, sourceCoverage, blockingFacts,repairableGaps,nonblockingSymptoms,unresolvedFacts,unverifiedStopClaims, preferences, issues, staleSources };
}

