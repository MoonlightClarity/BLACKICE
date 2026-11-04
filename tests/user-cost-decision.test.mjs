import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUserCostDecision, scoreUserCostDecision, assertUserCostChoice, USER_COST_DECISION_SCHEMA, USER_COST_MAX_UNITS } from '../public/user-cost-decision.mjs';

const cost = (value, basis = 'Explicit estimate in minute-equivalent user-loss units.') => ({ value, basis });
function anchorFor(value) {
  if (value === null) return 'unknown';
  return value === 0 ? 'none' : value <= 5 ? 'brief_rework' : value <= 60 ? 'bounded_rework' : value <= 480 ? 'substantial_rework' : value <= 10_080 ? 'material_setback' : 'major_loss';
}
const risk = (probability, severity, id = 'correctable_error') => ({
  id, probability, severity,
  probabilityBasis: { kind: probability === null ? 'unknown' : 'assumption', rationale: 'Illustrative planning assumption for this comparison, not an observed rate.' },
  severityBasis: { anchor: anchorFor(severity), consequence: 'Time to correct and verify the affected work if this event occurs.', conversionBasis: severity === null ? 'The correction effort has not yet been estimated.' : `${severity} minutes of equivalent correction effort, conditional on the event.` },
});
const option = (id, action, risks = [], friction = 0) => ({
  id, action, reversibility: 'reversible', outcome: `${action} the authorized work and account for its resulting user costs.`, risks,
  delayCost: cost(0, 'No delay beyond the separately counted work.'), interruptionCost: cost(action === 'ask' ? friction : 0, action === 'ask' ? 'User attention needed to read and answer the question.' : 'No user question or interruption.'),
  opportunityCost: cost(action === 'ask' ? 0 : friction, 'Expected foregone progress is explicitly estimated here.'),
  ...(action === 'ask' ? { clarification: { baselineOptionId: 'proceed', informationNeeded: 'The unresolved choice between two concrete task outcomes.', howAnswerChangesAction: 'The answer selects the correct branch before completion.', residualRiskBasis: 'For this illustration, the answer resolves this specific error risk; other risks are separately listed.' } } : {}),
});
function comparison(probability = 0.01, severity = 5, askCost = 2) {
  return {
    decision: 'Proceed on a reasonable assumption or interrupt the user?',
    assumptions: ['These probabilities and conversions are illustrative subjective judgments, not empirical measurements.'],
    hardConstraints: [],
    options: [option('proceed', 'proceed', [risk(probability, severity)]), option('ask', 'ask', [], askCost), option('defer', 'defer', [], 4)],
  };
}
const row = (result, id) => result.comparableCosts.find((item) => item.optionId === id);

test('1% times 5 is 0.05: a 2-unit question cannot override cheaper progress', () => {
  const input = comparison();
  const before = JSON.stringify(input);
  const result = evaluateUserCostDecision(input);
  assert.equal(result.preferredAction, 'proceed');
  assert.equal(result.recommendedOptionId, 'proceed');
  assert.equal(result.recommendedCost, 0.05);
  assert.equal(row(result, 'ask').totalCost, 2);
  assert.equal(row(result, 'ask').informationValue.netValue, -1.95);
  assert.equal(row(result, 'ask').informationValue.breakEven.probability, 0.4);
  assert.equal(result.escalationJustified, false);
  assert.equal(result.overrideRequiresNewEvidence, true);
  assert.match(result.calibration.horizon, /task completion/);
  assert.equal(JSON.stringify(input), before, 'the pure evaluator does not mutate input');
  assert.deepEqual(scoreUserCostDecision(input), result);
  assert.equal(assertUserCostChoice(input, 'proceed').recommendedCost, 0.05);
  assert.throws(() => assertUserCostChoice(input, 'ask'), { code: 'USER_COST_RECALCULATION_REQUIRED' });
});

test('40% times 100 is 40: a useful 2-unit clarification wins', () => {
  const input = comparison(0.4, 100);
  const result = evaluateUserCostDecision(input);
  assert.equal(row(result, 'proceed').totalCost, 40);
  assert.equal(result.preferredAction, 'ask');
  assert.equal(result.recommendedCost, 2);
  assert.equal(row(result, 'ask').informationValue.expectedMistakeCostReduction, 40);
  assert.equal(row(result, 'ask').informationValue.netValue, 38);
  assert.equal(row(result, 'ask').informationValue.breakEven.probability, 0.02);
  assert.equal(result.escalationJustified, true);
  assert.equal(assertUserCostChoice(input, 'ask').preferredAction, 'ask');
});

test('an unhelpful answer retains residual risk and does not earn assumed information value', () => {
  const input = comparison(0.4, 100);
  input.options[1].risks = [risk(0.4, 100, 'unresolved_after_answer')];
  input.options[2].opportunityCost.value = 50;
  const result = evaluateUserCostDecision(input);
  assert.equal(result.preferredAction, 'proceed');
  assert.equal(row(result, 'ask').totalCost, 42);
  assert.equal(row(result, 'ask').informationValue.worthInterrupting, false);
});

test('ties favor progress, then reversibility, then stable id independent of input order', () => {
  const input = comparison(0.4, 5, 2);
  const lessReversible = { ...structuredClone(input.options[0]), id: 'irreversible', reversibility: 'irreversible' };
  const equallyReversible = { ...structuredClone(input.options[0]), id: 'aaa' };
  input.options.push(lessReversible, equallyReversible);
  assert.equal(evaluateUserCostDecision(input).recommendedOptionId, 'aaa');
  input.options.reverse();
  assert.equal(evaluateUserCostDecision(input).recommendedOptionId, 'aaa');
  input.options = [option('proceed', 'proceed', [risk(0.1, 3)]), option('other', 'proceed', [risk(0.3, 1)])];
  assert.equal(evaluateUserCostDecision(input).recommendedOptionId, 'other', 'floating-point equivalent totals use the documented stable tie-break');
});

test('tiny conceivable risks remain tiny without rounding or an uncertainty multiplier', () => {
  const input = comparison(1e-12, 100);
  input.options[0].risks[0].probabilityRange = { min: 0, max: 1 };
  const result = evaluateUserCostDecision(input);
  assert.equal(row(result, 'proceed').totalCost, 1e-10);
  assert.equal(row(result, 'proceed').totalRange.max, 100);
  assert.equal(result.preferredAction, 'proceed', 'the range maximum is not a veto');
  assert.equal(result.sensitivity.affectsNominalRecommendation, false);
  const tiny = comparison(1e-30, 1, 2e-30);
  assert.equal(evaluateUserCostDecision(tiny).recommendedCost, 1e-30);
});

test('all expected consequences plus delay, interruption and opportunity costs are comparable', () => {
  const input = comparison();
  input.options[0].risks = [risk(0.1, 5, 'a'), risk(0.2, 10, 'b')];
  input.options[0].delayCost = cost(1);
  input.options[0].interruptionCost = cost(2);
  input.options[0].opportunityCost = cost(3);
  const result = evaluateUserCostDecision(input);
  assert.equal(row(result, 'proceed').expectedConsequenceCost, 2.5);
  assert.equal(row(result, 'proceed').frictionCost, 6);
  assert.equal(row(result, 'proceed').totalCost, 8.5);
});

test('unknown risk is preserved and prompts internal refinement, never automatic asking', () => {
  const input = comparison(null, 5);
  const result = evaluateUserCostDecision(input);
  assert.equal(result.status, 'needs_estimates');
  assert.equal(result.preferredAction, null);
  assert.equal(row(result, 'proceed').totalCost, null);
  assert.equal(result.escalationJustified, false);
  assert.equal(result.unknowns[0].affectsCost, true);
  assert.match(result.internalNextStep, /continue_other_authorized_work/);
  assert.throws(() => assertUserCostChoice(input, 'ask'), { code: 'USER_COST_RECALCULATION_REQUIRED' });
  input.options[0].risks[0] = risk(0.01, 5);
  assert.equal(assertUserCostChoice(input, 'proceed').preferredAction, 'proceed', 'explicit labeled estimation can complete the comparison');
});

test('an unknown irrelevant factor or dominated bounded option does not halt progress', () => {
  const input = comparison(null, 0);
  assert.equal(evaluateUserCostDecision(input).preferredAction, 'proceed');
  const dominated = comparison();
  dominated.options[2].risks = [{ ...risk(null, 100), probabilityRange: { min: 0.5, max: 1 } }];
  const result = evaluateUserCostDecision(dominated);
  assert.equal(row(result, 'defer').totalCost, null);
  assert.equal(row(result, 'defer').totalRange.min, 54);
  assert.equal(result.preferredAction, 'proceed');
  assert.equal(result.unknowns.length, 1);
});

test('actual sourced constraints affect eligibility separately from expected loss', () => {
  const input = comparison();
  input.hardConstraints = [{ id: 'no_travel', kind: 'user_constraint', rule: 'User disallows required travel.', source: 'Explicit user instruction in the current task.', observedViolation: 'This option commits to the mandatory weekly on-site trip.', blockedOptionIds: ['proceed'] }];
  const result = evaluateUserCostDecision(input);
  assert.equal(row(result, 'proceed').eligible, false);
  assert.equal(row(result, 'proceed').totalCost, 0.05, 'eligibility does not inflate its numeric estimate');
  assert.equal(result.preferredAction, 'ask');
  assert.equal(row(result, 'ask').informationValue.baselineEligible, false);
  input.hardConstraints[0].kind = 'hypothetical_risk';
  assert.throws(() => evaluateUserCostDecision(input), { code: 'INVALID_USER_COST_DECISION' });
  input.hardConstraints[0].kind = 'user_constraint';
  input.hardConstraints[0].source = '';
  assert.throws(() => evaluateUserCostDecision(input), { code: 'INVALID_USER_COST_DECISION' });
});

test('all blocked options call for feasible internal alternatives, not an invented question', () => {
  const input = comparison();
  input.hardConstraints = [{ id: 'limit', kind: 'verified_requirement', rule: 'The actual account does not allow these operations.', source: 'Observed service response for this account.', observedViolation: 'All three operations require the unavailable account capability.', blockedOptionIds: input.options.map((item) => item.id) }];
  const result = evaluateUserCostDecision(input);
  assert.equal(result.status, 'no_eligible_option');
  assert.equal(result.preferredAction, null);
  assert.equal(result.escalationJustified, false);
});

test('unsupported free questions and missing costs are rejected rather than silently zeroed', () => {
  const input = comparison(0.01, 5, 0);
  assert.throws(() => evaluateUserCostDecision(input), /zero-cost asking/);
  input.options[1].interruptionCost.zeroCostJustification = 'Existing one-click response is already supplied in the current input; no additional attention is requested.';
  assert.equal(evaluateUserCostDecision(input).preferredAction, 'ask');
  delete input.options[1].delayCost;
  assert.throws(() => evaluateUserCostDecision(input), /required; do not silently replace unknown/);
});

test('probabilities, severity, anchors, ranges and duplicates have bounded strict validation', () => {
  for (const value of [-1, 1.1, NaN, Infinity, '0.01', undefined]) {
    const input = comparison();
    input.options[0].risks[0].probability = value;
    assert.throws(() => evaluateUserCostDecision(input), { code: 'INVALID_USER_COST_DECISION' });
  }
  for (const value of [-1, USER_COST_MAX_UNITS + 1, Infinity, NaN]) {
    const input = comparison();
    input.options[0].risks[0].severity = value;
    assert.throws(() => evaluateUserCostDecision(input), { code: 'INVALID_USER_COST_DECISION' });
  }
  const anchor = comparison();
  anchor.options[0].risks[0].severityBasis.anchor = 'major_loss';
  assert.throws(() => evaluateUserCostDecision(anchor), /concrete consequence anchor/);
  const bounds = comparison();
  bounds.options[0].risks[0].probabilityRange = { min: 0.5, max: 0.1 };
  assert.throws(() => evaluateUserCostDecision(bounds), /min must not exceed max/);
  bounds.options[0].risks[0].probabilityRange = { min: 0.5, max: 1 };
  assert.throws(() => evaluateUserCostDecision(bounds), /include the central estimate/);
  const duplicate = comparison();
  duplicate.options[1].id = 'proceed';
  assert.throws(() => evaluateUserCostDecision(duplicate), /ids must be unique/);
});

test('empirical claims require actual counts and source, assumptions stay labeled', () => {
  const input = comparison();
  input.options[0].risks[0].probabilityBasis = { kind: 'empirical', rationale: 'Measured comparable events.' };
  assert.throws(() => evaluateUserCostDecision(input), /source and valid event/);
  input.options[0].risks[0].probabilityBasis = { kind: 'empirical', source: 'Controlled sample of 100 comparable cases.', rationale: 'One correction in 100 cases.', events: 1, trials: 100 };
  assert.equal(evaluateUserCostDecision(input).recommendedCost, 0.05);
  input.options[0].risks[0].probability = 0.2;
  assert.throws(() => evaluateUserCostDecision(input), /must match its event/);
  const subjective = evaluateUserCostDecision(comparison());
  assert.equal(row(subjective, 'proceed').riskCosts[0].probabilityBasis.kind, 'assumption');
});

test('a model cannot inject a preferred action or unsupported eligibility override', () => {
  const input = comparison();
  input.preferredAction = 'ask';
  assert.throws(() => evaluateUserCostDecision(input), /computed recommendations cannot be supplied/);
  delete input.preferredAction;
  input.options[0].eligible = false;
  assert.throws(() => evaluateUserCostDecision(input), /unknown property/);
  assert.equal(USER_COST_DECISION_SCHEMA.additionalProperties, false);
});

test('personal encrypted backup compares incremental compromise with lost backup and attention', () => {
  const input = {
    decision: 'Complete the authorized private encrypted Hermes backup for an individual user.',
    horizon: 'The same next 90 days for incremental compromise, possible data loss, delay and user effort.',
    assumptions: [
      'Hypothetical scenario only; no secrets were accessed or cryptographic claims verified by this test.',
      'Individual owner, no organization, two-factor authentication, private GitHub repository, encrypted backup, password derived from first GitHub recovery code kept in Google Drive, and no paid API keys.',
      'Likelihoods below are subjective illustrative assumptions, not empirical exploit or failure rates.',
      'Severity is conditional tangible restoration effort; no enterprise, billing, or organizational obligations are inferred.',
    ],
    hardConstraints: [],
    options: [
      { ...option('proceed', 'proceed', [risk(0.000001, 480, 'incremental_compromise')]), outcome: 'Complete the encrypted backup while retaining the known account protections.' },
      { ...option('defer', 'defer', [risk(0.02, 480, 'work_lost_without_backup')], 10), outcome: 'Leave the requested backup incomplete; account for restoration loss and foregone work.' },
      { ...option('ask', 'ask', [risk(0.000001, 480, 'same_residual_compromise')], 2), outcome: 'Interrupt the individual user without evidence the answer changes the controls.', clarification: { baselineOptionId: 'proceed', informationNeeded: 'Whether to repeat permission the user already supplied.', howAnswerChangesAction: 'No new fact is expected; existing authorization already covers the described backup.', residualRiskBasis: 'The same described controls and incremental risk remain after repeating permission.' } },
    ],
  };
  const result = evaluateUserCostDecision(input);
  assert.equal(result.preferredAction, 'proceed');
  assert.ok(Math.abs(row(result, 'proceed').totalCost - 0.00048) < 1e-18);
  assert.equal(row(result, 'defer').totalCost, 19.6);
  assert.equal(row(result, 'ask').informationValue.expectedMistakeCostReduction, 0);
  assert.equal(row(result, 'ask').informationValue.worthInterrupting, false);
  assert.equal(result.comparableCosts.every((item) => item.blockedBy.length === 0), true);
  assert.match(result.calibration.horizon, /next 90 days/);
});

test('equal background risk cancels in rankings and clarification value', () => {
  const input = comparison();
  const before = evaluateUserCostDecision(input);
  for (const candidate of input.options) {
    candidate.risks.push({
      ...risk(0.03, 100, 'shared_background'),
      probabilityBasis: { kind: 'assumption', rationale: 'Same preexisting account risk under every option in the same horizon; not caused by this action.' },
    });
  }
  const after = evaluateUserCostDecision(input);
  assert.equal(after.preferredAction, before.preferredAction);
  assert.deepEqual(after.rankedOptionIds, before.rankedOptionIds);
  assert.ok(Math.abs(row(after, 'ask').informationValue.expectedMistakeCostReduction - 0.05) < 1e-14);
  assert.match(after.calibration.baselinePolicy, /conditional scenario probability/);
});

test('bounded unknown proceed cost cannot hide a cheaper useful question', () => {
  const input = comparison(null, 100);
  input.options[0].risks[0].probabilityRange = { min: 0.5, max: 1 };
  const result = evaluateUserCostDecision(input);
  assert.equal(result.status, 'evaluated');
  assert.equal(result.recommendedOptionId, 'ask');
  assert.equal(result.recommendedCost, 2);
  assert.equal(row(result, 'proceed').totalCost, null, 'no point estimate is invented');
  assert.deepEqual(row(result, 'proceed').totalRange, { min: 50, max: 100 });
  const information = row(result, 'ask').informationValue;
  assert.equal(information.expectedMistakeCostReduction, null);
  assert.equal(information.incrementalFrictionCost, 2);
  assert.deepEqual(information.netValueRange, { min: 48, max: 98 });
  assert.equal(information.worthInterrupting, true);
  assert.equal(information.evaluationBasis, 'proven_bounds');
  assert.equal(assertUserCostChoice(input, 'ask').preferredAction, 'ask');
});

test('a question with unresolved information value remains an unresolved candidate', () => {
  const input = comparison(null, 100);
  input.options[0].risks[0].probabilityRange = { min: 0, max: 1 };
  const result = evaluateUserCostDecision(input);
  assert.equal(row(result, 'ask').totalCost, 2);
  assert.equal(row(result, 'ask').informationValue.worthInterrupting, null);
  assert.equal(row(result, 'ask').informationValue.evaluationBasis, 'unresolved_bounds');
  assert.equal(result.status, 'needs_estimates');
  assert.equal(result.preferredAction, null, 'neither defer nor ask is silently selected');
  assert.equal(result.escalationJustified, false);
});

test('rounding tolerance uses fixed minimum groups for every input permutation', () => {
  const permutations = (values) => values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, other) => index !== other)).map((rest) => [value, ...rest]));
  for (const scale of [1e-30, 1, 100_000]) {
    const candidates = [
      option('c', 'proceed', [], scale),
      option('b', 'proceed', [], scale * (1 + 6 * Number.EPSILON)),
      option('a', 'proceed', [], scale * (1 + 12 * Number.EPSILON)),
    ];
    for (const ordering of permutations(candidates)) {
      const result = evaluateUserCostDecision({ decision: 'Stable near-tie order.', assumptions: [], hardConstraints: [], options: ordering });
      assert.equal(result.recommendedOptionId, 'b');
      assert.deepEqual(result.rankedOptionIds, ['b', 'c', 'a'], `scale ${scale}; input ${ordering.map((item) => item.id).join(',')}`);
    }
  }
});

test('nonnegative unknown domains prove domination without an explicit range', () => {
  const cheap = option('cheap', 'proceed', [], 1);
  const uncertain = option('uncertain', 'proceed', [risk(null, 100)]);
  uncertain.delayCost = cost(10, 'Ten minutes of known delay plus an unknown additional consequence.');
  const input = { decision: 'Continue despite a dominated unknown.', assumptions: [], hardConstraints: [], options: [cheap, uncertain] };
  const result = evaluateUserCostDecision(input);
  assert.equal(result.status, 'evaluated');
  assert.equal(result.recommendedOptionId, 'cheap');
  assert.equal(row(result, 'uncertain').totalCost, null);
  assert.deepEqual(row(result, 'uncertain').totalRange, { min: 10, max: 110 });
  assert.equal(result.unknowns.length, 1);
  uncertain.interruptionCost = cost(null, 'The interruption cost has not been estimated.');
  const unknownFriction = evaluateUserCostDecision(input);
  assert.equal(unknownFriction.recommendedOptionId, 'cheap');
  assert.equal(row(unknownFriction, 'uncertain').frictionCost, null);
  assert.deepEqual(row(unknownFriction, 'uncertain').totalRange, { min: 10, max: 1_000_110 });
});

test('overflowing break-even thresholds are explicit and survive JSON serialization', () => {
  const input = comparison(0.5, Number.MIN_VALUE);
  const result = evaluateUserCostDecision(input);
  const threshold = row(result, 'ask').informationValue.breakEven;
  assert.equal(result.preferredAction, 'proceed');
  assert.equal(threshold.probability, null);
  assert.equal(threshold.domainPosition, 'above_one');
  assert.equal(threshold.representation, 'overflow');
  assert.deepEqual(threshold.ratio, { numerator: 2, denominator: Number.MIN_VALUE });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'no Infinity or NaN silently becomes null');
  input.options[0].delayCost = cost(4);
  const belowZero = row(evaluateUserCostDecision(input), 'ask').informationValue.breakEven;
  assert.equal(belowZero.domainPosition, 'below_zero');
  assert.equal(belowZero.representation, 'overflow');
  assert.equal(belowZero.probability, null);
  const finiteOutside = row(evaluateUserCostDecision(comparison(0.5, 1)), 'ask').informationValue.breakEven;
  assert.equal(finiteOutside.probability, 2);
  assert.equal(finiteOutside.domainPosition, 'above_one');
  assert.equal(finiteOutside.representation, 'finite');
});
