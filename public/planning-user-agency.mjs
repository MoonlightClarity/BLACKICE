/**
 * Public decision records, not private reasoning or execution authority.
 * Authored estimates remain visible; every projection recomputes their costs.
 */
import { USER_COST_DECISION_SCHEMA, evaluateUserCostDecision, assertUserCostChoice } from './user-cost-decision.mjs';

export const USER_AGENCY_CONTRACT_VERSION = 1;
export const OPERATIONAL_HOLD_POLICY_VERSION = 1;
const operationalHoldExample = 'For example, an application form marking a routine Yes/No question required is insufficient grounds to stop. Check the available records and choose a supported answer when the expected consequence to the user warrants proceeding. Treat a counterparty preference as context for that decision. An actual denial, withheld authority, or an unsupported consequential declaration calls for review of the affected action and continued work on other viable paths.';
export const USER_AGENCY_GUIDANCE = [
  'Act as an agent FOR the user: carry the authorized objective through completion and select actions for their expected benefit to this user. Truthfulness governs the accuracy of claims and required answers; it creates no affirmative duty to volunteer unasked weaknesses, private limits, negotiating ceilings, speculative disqualifications or excuses for a counterparty to reject the user.',
  'Keep audience and purpose explicit. Counterparty-facing material answers the actual question with relevant supported evidence and the minimum disclosure needed for accuracy and the user\'s objective. Keep internal fit audits and negative self-assessments in privateFindings; do not export them merely to demonstrate honesty. Do not omit a requested material fact or make a materially misleading claim. Report actual task failures, consequential uncertainty and incomplete outcomes candidly to the user in userReport; advocacy is not concealment from the principal.',
  'Required UI input is not automatically a material user decision or approval checkpoint. Reuse saved profile facts and previously confirmed answers, check available context, use supported ordinary inference, and use an offered neutral answer or optional omission where appropriate. Absence of a biographical fact is not evidence that it is false. Never invent a personal fact or blindly answer unknown booleans No. Keep unrelated ready work moving while a genuinely unknowable answer is isolated.',
  operationalHoldExample,
  'At a decision-changing uncertainty, proposed escalation, or consequential disclosure tradeoff, compare proceed, defer and ask in the typed userAgency decisions record. Use the shared deterministic evaluator: total expected user cost = sum(probability * severity) + delayCost + interruptionCost + opportunityCost. Use the same minute-equivalent user-loss units, baseline and time horizon for all options. Include loss from waiting, burden returned to the user and lost opportunities. Compare incremental, action-specific consequences; do not charge a background risk only to proceeding or count the same loss twice.',
  'Use calibrated estimates with their evidence or explicitly labeled assumptions and sensitivity ranges. An illustrative estimate is not an empirical frequency. Describe the concrete causal path and the actual user\'s stakes; do not import enterprise exposure, paid credentials or catastrophic outcomes absent from this task. Conditional events are not independent merely because they can be listed. A conceivable exploit path or any nonzero probability is not itself a veto. Unknown estimates remain unknown and call for a useful bounded internal check, not automatic pessimistic scoring or a question to the user.',
  'Choose the lowest-cost eligible option returned by the host; ties favor progress and recoverability. Actual user constraints, missing required authority and observed binding requirements are separate hard constraints with sources. A preference, required-field label, imagined policy or generic concern is not a hard constraint. Ask only when the comparison supports it and the answer can change the action enough to warrant the interruption. A contrary choice needs concrete new evidence and a recalculated comparison; repeating caution does not override the result.',
  'Recheck the checkpoint after meaningful outcomes and during plan -> think -> plan revisions. Preserve the previous comparison and update changed observations rather than inventing a new approval ritual. Routine clear work may record decisionRequired:false with a concise reason and proceed. A typed essential stop that holds dispatch must have a calculated non-proceed decision; correct an unsupported stop classification from evidence rather than pairing it with routine progress. New native planning attempts must supply the declared checkpoint; the host verifies structure and arithmetic, not the truth of the model\'s estimates or every sentence of its proposed message.'
].join('\n');

/** Saved schema 13 tool identities predate the operational-hold example. */
export const USER_AGENCY_GUIDANCE_V13 = USER_AGENCY_GUIDANCE.replace('\n' + operationalHoldExample, '');

const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
const string = { type: 'string', maxLength: 4000 };
const strings = { type: 'array', maxItems: 24, items: string };
const nullableId = { anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'null' }] };
const schemaObject = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const USER_AGENCY_CHECKPOINT_SCHEMA = freeze(schemaObject({
  version: { type: 'number', enum: [USER_AGENCY_CONTRACT_VERSION] },
  audience: { type: 'string', enum: ['user', 'counterparty', 'internal'] },
  userBenefit: string,
  representation: schemaObject({ actualQuestion: string, requiredFacts: strings, relevantClaims: strings, privateFindings: strings, userReport: strings }),
  action: { type: 'string', enum: ['proceed', 'ask', 'defer', 'investigate'] },
  decisionRequired: { type: 'boolean' },
  decisionReason: string,
  decisions: { type: 'array', maxItems: 12, items: schemaObject({ id: { type: 'string', minLength: 1, maxLength: 120 }, input: USER_COST_DECISION_SCHEMA, selectedOptionId: nullableId }) },
  chosenDecisionId: nullableId
}));

// Provider output must name every field. Optional raw decision inputs use null only as an absence marker.
const strictOutputSchema = schema => {
  const result = { ...schema };
  if (schema.type === 'object') {
    const required = new Set(schema.required || []);
    result.properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => {
      const child = strictOutputSchema(value);
      return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }];
    }));
    result.required = Object.keys(result.properties);
  }
  if (schema.items) result.items = strictOutputSchema(schema.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) result[key] = schema[key].map(strictOutputSchema);
  return result;
};
export const USER_AGENCY_OUTPUT_SCHEMA = freeze(strictOutputSchema(USER_AGENCY_CHECKPOINT_SCHEMA));

const fail = (message, code = 'USER_AGENCY_INVALID') => Object.assign(new Error(message), { code, status: 400 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected, label) => {
  if (!object(value) || Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) throw fail(label + ' must contain exactly the declared fields.');
};
const text = (value, label, required = false, max = 4000) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw fail(label + ' must be bounded' + (required ? ', nonempty' : '') + ' text.');
  return value.trim();
};
const id = (value, label) => {
  const result = text(value, label, true, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw fail(label + ' must be a stable identifier.');
  return result;
};
const list = (value, label) => {
  if (!Array.isArray(value) || value.length > 24) throw fail(label + ' must be a bounded list.');
  return value.map(item => text(item, label, true));
};

// Normalize the strict provider representation without changing required unknown estimates, inventing values,
// or discarding unknown keys. The unchanged evaluator still enforces every contextual requirement.
function normalizeOptionalDecisionFields(value, schema = USER_COST_DECISION_SCHEMA) {
  if (Array.isArray(value) && schema.items) return value.map(item => normalizeOptionalDecisionFields(item, schema.items));
  if (!object(value) || !schema.properties || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(item === null && Object.hasOwn(schema.properties, key) && !required.has(key)))
    .map(([key, item]) => [key, Object.hasOwn(schema.properties, key) ? normalizeOptionalDecisionFields(item, schema.properties[key]) : item]));
}

/** Pure normalization. Never accepts caller-authored totals or a claimed recommendation. */
export function normalizeUserAgencyCheckpoint(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail('This new planning attempt requires a userAgency checkpoint. Use a short no-decision reason for routine clear work; do not create an approval step.', 'USER_AGENCY_REQUIRED');
    return null;
  }
  try { if (JSON.stringify(value).length > 40000) throw fail('Keep the user-agency checkpoint within 40,000 characters.'); }
  catch (error) { if (error.code) throw error; throw fail('Use a serializable, bounded checkpoint.'); }
  keys(value, Object.keys(USER_AGENCY_CHECKPOINT_SCHEMA.properties), 'User-agency checkpoint');
  if (value.version !== USER_AGENCY_CONTRACT_VERSION) throw fail('Unsupported user-agency contract version.');
  if (!['user', 'counterparty', 'internal'].includes(value.audience)) throw fail('Declare the actual audience.');
  if (!['proceed', 'ask', 'defer', 'investigate'].includes(value.action)) throw fail('Declare a supported action.');
  if (typeof value.decisionRequired !== 'boolean') throw fail('decisionRequired must be Boolean.');
  const representationKeys = ['actualQuestion', 'requiredFacts', 'relevantClaims', 'privateFindings', 'userReport'];
  keys(value.representation, representationKeys, 'Representation review');
  const representation = { actualQuestion: text(value.representation.actualQuestion, 'Actual question') };
  for (const key of representationKeys.slice(1)) representation[key] = list(value.representation[key], 'Representation ' + key);
  if (!Array.isArray(value.decisions) || value.decisions.length > 12) throw fail('Use at most twelve consequential decisions per checkpoint.');
  const seen = new Set(), evaluations = new Map();
  const decisions = value.decisions.map(item => {
    keys(item, ['id', 'input', 'selectedOptionId'], 'Agency decision');
    const decisionId = id(item.id, 'Decision ID');
    if (seen.has(decisionId)) throw fail('Decision IDs must be unique.');
    seen.add(decisionId);
    const selectedOptionId = item.selectedOptionId === null ? null : id(item.selectedOptionId, 'Selected option ID');
    // The pure evaluator validates all inputs before the raw record is copied.
    const input = normalizeOptionalDecisionFields(item.input);
    const evaluation = selectedOptionId === null ? evaluateUserCostDecision(input) : assertUserCostChoice(input, selectedOptionId);
    evaluations.set(decisionId, evaluation);
    return { id: decisionId, input: JSON.parse(JSON.stringify(input)), selectedOptionId };
  });
  const chosenDecisionId = value.chosenDecisionId === null ? null : id(value.chosenDecisionId, 'Chosen decision ID');
  const result = { version: USER_AGENCY_CONTRACT_VERSION, audience: value.audience, userBenefit: text(value.userBenefit, 'User benefit', true), representation,
    action: value.action, decisionRequired: value.decisionRequired, decisionReason: text(value.decisionReason, 'Decision reason', true), decisions, chosenDecisionId };
  if (!result.decisionRequired) {
    if (decisions.length || chosenDecisionId !== null || result.action !== 'proceed') {
      const message = 'For routine authorized progress, use action:"proceed", decisionRequired:false, decisions:[], and chosenDecisionId:null. An authorized observation can proceed even when its result is unknown. Asking, deferring, or investigating a decision requires decisionRequired:true and a chosen comparison.';
      throw Object.assign(fail(message, 'USER_AGENCY_COMPARISON_REQUIRED'), { issues: [{ path: 'response.userAgency', message }] });
    }
    return result;
  }
  if (!chosenDecisionId || !seen.has(chosenDecisionId)) throw fail('Name the compared decision that determines this next action.', 'USER_AGENCY_COMPARISON_REQUIRED');
  const chosen = decisions.find(item => item.id === chosenDecisionId), evaluation = evaluations.get(chosenDecisionId);
  if (evaluation.status === 'evaluated') {
    if (!chosen.selectedOptionId) throw fail('Select the lowest-cost eligible option before taking the compared action.', 'USER_AGENCY_COMPARISON_REQUIRED');
    if (result.action !== evaluation.preferredAction) throw fail('The declared action contradicts the calculated recommendation. Supply concrete new evidence and recalculate; generic caution is not an override.', 'USER_COST_RECALCULATION_REQUIRED');
  } else if (evaluation.status === 'no_eligible_option') {
    if (chosen.selectedOptionId !== null || result.action !== 'defer') throw fail('Recorded binding constraints leave no eligible option. Defer only the affected action and continue independent work.');
  } else if (chosen.selectedOptionId !== null || result.action !== 'investigate') {
    throw fail('Missing decision estimates call for a bounded internal investigation, not an automatic ask or worst-case veto.', 'USER_COST_RECALCULATION_REQUIRED');
  }
  return result;
}

/** Couple an enforced checkpoint to the same typed stop that holds dispatch. */
export function assertUserAgencyDispatchConsistency(checkpoint, requirements, { required = false } = {}) {
  if (!required) return;
  const stops = (requirements || []).filter(item => item.importance === 'essential' && item.resolution === 'blocked' && item.stopKind && item.value && item.sourceIds?.length);
  if (stops.length && (!checkpoint?.decisionRequired || !['ask', 'defer'].includes(checkpoint.action)))
    throw fail('A typed essential stop holds the affected dispatch and cannot be paired with routine progress. Correct a misclassified stop from evidence, or compare the actual constraints and costs and select a calculated ask/defer action. Continue independent ready work.', 'USER_AGENCY_DISPATCH_CONTRADICTION');
}

/** Recomputed projection for native and external planners; no new authority is granted. */
export function evaluateUserAgencyCheckpoint(value, options = {}) {
  const checkpoint = normalizeUserAgencyCheckpoint(value, options);
  if (!checkpoint) return null;
  const comparisons = checkpoint.decisions.map(item => ({ id: item.id, evaluation: evaluateUserCostDecision(item.input) }));
  const chosen = comparisons.find(item => item.id === checkpoint.chosenDecisionId)?.evaluation;
  const decision = checkpoint.decisions.find(item => item.id === checkpoint.chosenDecisionId);
  const option = decision?.input.options.find(item => item.id === decision.selectedOptionId);
  const preferredAction = chosen?.preferredAction ?? checkpoint.action;
  const directive = chosen?.internalNextStep || (preferredAction === 'ask'
    ? 'Ask the specific justified question needed to determine: ' + option.clarification.informationNeeded + '. Its calculated information value warrants the interruption. Continue independent ready work.'
    : preferredAction === 'defer'
      ? 'Defer only the affected action under the recorded comparison or binding constraints, preserve its current state, and continue independent ready work.'
      : preferredAction === 'investigate'
        ? 'Resolve the specific missing estimate or evidence through a bounded internal check. Continue independent ready work; missing arithmetic does not automatically become a user question.'
        : 'Proceed with the selected authorized work using supported facts; do not add an unnecessary user question or approval checkpoint.');
  return {
    checkpoint,
    comparisons,
    selectedDecisionId: checkpoint.chosenDecisionId,
    preferredAction,
    directive,
    overrideRequiresNewEvidence: true,
    assurance: 'The host validates the declared choice and recalculates costs. Estimates, causal claims and message relevance remain evidence-based agent judgments; this record is not task-effect proof.'
  };
}

/** Verify the existing user-interest decision before an operational judgment can stop work. */
export function verifyOperationalHold(value, { evidence, criterionId, requiredCriterionIds = [] }) {
  const checkpoint = normalizeUserAgencyCheckpoint(value, { required: true });
  const decision = checkpoint.decisions.find(item => item.id === checkpoint.chosenDecisionId);
  if (!decision || !['ask', 'defer'].includes(checkpoint.action) || !decision.input.options.some(option => option.action === 'proceed'))
    throw fail('Compare a concrete way to proceed against deferring or asking. Keep the work available when the user-interest decision favors proceeding or a bounded check.', 'USER_AGENCY_HOLD_NOT_JUSTIFIED');
  const observed = new Map(evidence.map(item => [item.id, item]));
  for (const constraint of decision.input.hardConstraints) {
    const source = observed.get(constraint.source);
    const pinnedUserConstraint = constraint.source === 'criterion:' + criterionId && requiredCriterionIds.includes(criterionId);
    if (constraint.kind === 'user_constraint') {
      if (!pinnedUserConstraint)
        throw fail('A user constraint must name this exact user-required criterion. An outside preference cannot establish user authority.', 'USER_AGENCY_HOLD_EVIDENCE');
    } else if (source?.kind !== 'validation' && source?.confirmation?.status !== 'absent') {
      throw fail('A counterparty preference or required field label is insufficient to disqualify proceeding. Compare the actual user consequences, or cite an observed rejection.', 'USER_AGENCY_HOLD_EVIDENCE');
    }
  }
  return checkpoint;
}
