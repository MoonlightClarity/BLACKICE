/**
 * Public decision records, not private reasoning or execution authority.
 * Authored estimates remain visible; every projection recomputes their costs.
 */
import { USER_COST_DECISION_SCHEMA, evaluateUserCostDecision, assertUserCostChoice } from './user-cost-decision.mjs';

export const USER_AGENCY_CONTRACT_VERSION = 1;
export const USER_AGENCY_GUIDANCE = [
  'Act as an agent FOR the user: carry the authorized objective through completion and select actions for their expected benefit to this user. Truthfulness governs the accuracy of claims and required answers; it creates no affirmative duty to volunteer unasked weaknesses, private limits, negotiating ceilings, speculative disqualifications or excuses for a counterparty to reject the user.',
  'Keep audience and purpose explicit. Counterparty-facing material answers the actual question with relevant supported evidence and the minimum disclosure needed for accuracy and the user\'s objective. Keep internal fit audits and negative self-assessments in privateFindings; do not export them merely to demonstrate honesty. Do not omit a requested material fact or make a materially misleading claim. Report actual task failures, consequential uncertainty and incomplete outcomes candidly to the user in userReport; advocacy is not concealment from the principal.',
  'Build representation from the requested output outward: copy the actual question, identify its recipient, then select supported claims that answer it. For each proposed required fact, identify the explicit question it answers or the material misimpression it prevents. A known limitation is not required merely because it appears in the private record. Describe the concrete scope of real experience affirmatively; do not append an unasked inventory of work the user has not done. A direct question about that missing experience instead requires a direct truthful answer. A counterparty draft keeps audience:counterparty even when stored internally or shown to the user for review.',
  'Separate evidence of suitability from evidence of a binding gate. A listing calling a qualification required is evidence of the counterparty\'s stated criterion; it does not by itself prove an automatic rejection, a prohibition on applying, or inability to perform the actual work. Compare the user\'s supported transferable capabilities with the duties, actual user constraints, effort and opportunity value. Preserve uncertainty about screening. In a decision task, action describes the contemplated action being compared: withholding it is defer, not proceed merely because you will write the evaluation or report the hold. Continuing a shortlist under the user\'s actual criteria or drafting a rejection the user has already requested can be progress on that requested work. Do not invent a hard constraint or an almost-certain screening probability to rationalize a veto.',
  'Required UI input is not automatically a material user decision or approval checkpoint. Reuse saved profile facts and previously confirmed answers, check available context, use supported ordinary inference, and use an offered neutral answer or optional omission where appropriate. Absence of a biographical fact is not evidence that it is false. Never invent a personal fact or blindly answer unknown booleans No. Keep unrelated ready work moving while a genuinely unknowable answer is isolated.',
  'At a decision-changing uncertainty, proposed escalation, or consequential disclosure tradeoff, compare proceed, defer and ask in the typed userAgency decisions record. Use the shared deterministic evaluator: total expected user cost = sum(probability * severity) + delayCost + interruptionCost + opportunityCost. Use the same minute-equivalent user-loss units, baseline and time horizon for all options. Include loss from waiting, burden returned to the user and lost opportunities. Compare incremental, action-specific consequences; do not charge a background risk only to proceeding or count the same loss twice.',
  'For a material choice about what an answer includes, instantiate at least two feasible answers as the literal candidate texts in the compared options[].outcome before selecting one. Compare them against the same actual question, supported evidence and user objective; a label such as tailored or transparent is not a candidate. Both options may use action:proceed; do not invent an ask or defer alternative merely to compare wording. Make the claimed scope of each answer explicit and assess whether the alternative actually omits a requested material fact or creates a specific misleading implication. An internal limitation outside that scope is not such an omission. Estimate only the incremental consequences of those actual candidates, label assumptions, and retain the selected text for the actual work product. In an enforced sequential plan, save that comparison with assess_decision, then adopt operation.contentSelection with its decisionId, returned inputSha256 and the JSON argumentPointer of the outgoing string. Use the returned selected or recommended outcome verbatim for that argument; changed wording requires reassessment and an updated binding. The binding checks consistency with the saved choice, not whether the chosen content is good. This applies to a material content tradeoff, not every routine known-value field.',
  'When a comparison is explicitly requested or supplied estimates are to be compared, decisionRequired is true even when the winning action is obvious. Put the raw options, risks, cost components and their bases in decisions[].input; name that entry with chosenDecisionId and its lowest-cost eligible option with selectedOptionId. Arithmetic in decisionReason or another prose field does not populate this record. For routine clear work, use action:proceed, decisionRequired:false, decisions:[] and chosenDecisionId:null. Judge the action at the requested scope: completing an authorized draft is proceed; a draft-only boundary does not require asking for authority to send something the user did not request.',
  'Use calibrated estimates with their evidence or explicitly labeled assumptions and sensitivity ranges. An illustrative estimate is not an empirical frequency. Describe the concrete causal path and the actual user\'s stakes; do not import enterprise exposure, paid credentials or catastrophic outcomes absent from this task. Conditional events are not independent merely because they can be listed. A conceivable exploit path or any nonzero probability is not itself a veto. Unknown estimates remain unknown and call for a useful bounded internal check, not automatic pessimistic scoring or a question to the user.',
  'Choose the lowest-cost eligible option returned by the host; ties favor progress and recoverability. Actual user constraints, missing required authority and observed binding requirements are separate hard constraints with sources. A preference, required-field label, imagined policy or generic concern is not a hard constraint. Ask only when the comparison supports it and the answer can change the action enough to warrant the interruption. A contrary choice needs concrete new evidence and a recalculated comparison; repeating caution does not override the result.',
  'Recover according to observed effects. A confirmed pre-dispatch failure permits a corrected attempt. For an operation with possible duplicate side effects, an uncertain post-dispatch result requires inspecting authoritative operation state or effects; absence of a receipt alone is not evidence that the action did not happen. Retry that effect only after non-execution is established or through the original operation\'s supported idempotent recovery path. Ordinary retry-safe reads need no proof-of-non-execution ritual. Keep the unresolved outcome visible to the user without discarding independent ready work.',
  'Recheck the checkpoint after meaningful outcomes and during plan -> think -> plan revisions. Preserve the previous comparison and update changed observations rather than inventing a new approval ritual. Routine clear work may record decisionRequired:false with a concise reason and proceed. A typed essential stop that holds dispatch must have a calculated non-proceed decision; correct an unsupported stop classification from evidence rather than pairing it with routine progress. New native planning attempts must supply the declared checkpoint; the host verifies structure and arithmetic, not the truth of the model\'s estimates or every sentence of its proposed message.'
].join('\n');

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
  audience: { type: 'string', enum: ['user', 'counterparty', 'internal'], description: 'Recipient of the requested content, not the location of this checkpoint. A counterparty draft remains counterparty when the user reviews it. Internal is for an internal decision without an outgoing draft.' },
  userBenefit: string,
  representation: schemaObject({
    actualQuestion: { ...string, description: 'The question or deliverable actually requested. Do not substitute an internal fit audit, a broader hypothetical question, or an unrequested approval to send a draft.' },
    requiredFacts: { ...strings, description: 'Facts directly requested or necessary to avoid a material misimpression in the chosen answer. Private record membership, a known weakness, or a desire to demonstrate honesty does not make a fact required.' },
    relevantClaims: { ...strings, description: 'Supported claims that advance the requested answer. State the concrete scope of real work or experience without inventing qualifications or appending unasked deficits.' },
    privateFindings: { ...strings, description: 'Internal limits, uncertain fit, negotiation ceilings and other findings not required in the outgoing answer. Directly requested material facts belong in requiredFacts and must be answered truthfully.' },
    userReport: { ...strings, description: 'Actual outcomes, incomplete work, failures and consequential uncertainty the user needs to know. Do not conceal them from the principal or claim a draft was executed.' }
  }),
  action: { type: 'string', enum: ['proceed', 'ask', 'defer', 'investigate'], description: 'In a decision task, classify the contemplated action being compared, not writing the evaluation: holding that action is defer. Executing requested work, including an already-requested rejection draft, is proceed; a draft-only boundary is not an ask. Ask/defer require a typed comparison.' },
  decisionRequired: { type: 'boolean', description: 'True for an explicitly requested comparison, supplied decision estimates, ask/defer, or a consequential decision-changing uncertainty. An obvious numerical winner still requires the requested record. False only for routine clear progress.' },
  decisionReason: { ...string, description: 'Concise evidence for the decision or routine progress. Prose costs do not substitute for decisions[].input.' },
  decisions: { type: 'array', maxItems: 12, description: 'When decisionRequired is true, include the complete raw comparison, not just its totals in prose. Preserve supplied numbers and assumption status. When false, use an empty array.', items: schemaObject({ id: { type: 'string', minLength: 1, maxLength: 120 }, input: USER_COST_DECISION_SCHEMA, selectedOptionId: { ...nullableId, description: 'ID of the lowest-cost eligible option in this decision input. Null only while required estimates are unknown or no option is eligible.' } }) },
  chosenDecisionId: { ...nullableId, description: 'ID of the decisions entry that determines the next action. Required as a nonnull matching ID when decisionRequired is true; null for routine clear progress.' }
}));

// Provider output must name every field. Optional raw decision inputs use null only as an absence marker.
const strictOutputSchema = schema => {
  const result = { ...schema };
  if (schema.type === 'object') {
    const required = new Set(schema.required || []);
    result.properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => {
      const child = strictOutputSchema(value);
      return [key, required.has(key) ? child : { ...(typeof child.description === 'string' ? { description: child.description } : {}), anyOf: [child, { type: 'null' }] }];
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
    if (decisions.length || chosenDecisionId !== null || result.action !== 'proceed') throw fail('Only routine clear progress may omit a cost comparison; asking or deferring requires the comparison.', 'USER_AGENCY_COMPARISON_REQUIRED');
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
