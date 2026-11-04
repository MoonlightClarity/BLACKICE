/**
 * Deterministic user-cost comparison. Pure ES module: no filesystem, clock,
 * provider, network, or browser dependencies.
 *
 * One loss unit is one minute of avoidable user effort, or an explicitly
 * justified equivalent user loss. Non-time outcomes must explain that
 * conversion; the scale is a planning judgment, not a monetary valuation of
 * health, rights, or a person. Probabilities are assumptions unless supported
 * by a cited empirical numerator/denominator. Uncertainty has no multiplier.
 *
 * Total = sum(probability * consequence severity) + delay + interruption +
 * lost opportunity. Include consequences of inaction and delay as well as
 * action; do not double-count the same consequence across terms. Only actual,
 * sourced hard constraints affect eligibility. A conceivable bad outcome is
 * a risk estimate, never a constraint or an automatic veto.
 * Use the same baseline and horizon across options: existing background risk
 * belongs to every affected option or is excluded from every option when
 * comparing incremental risk. Add distinct consequences only. Correlated
 * access steps need a stated joint/conditional scenario probability; this
 * evaluator never assumes independent steps or multiplies their likelihoods.
 *
 * For ask, risks describe the expected residual consequences AFTER asking,
 * including the possibility of an unhelpful answer. Its information benefit
 * must beat its incremental friction against an eligible proceed baseline.
 * Missing estimates remain null. They request internal estimation/retrieval
 * while other authorized work continues, never an automatic user question.
 */

export const USER_COST_MAX_UNITS = 1_000_000;
export const USER_COST_ANCHORS = Object.freeze([
  Object.freeze({ id: 'none', minExclusive: null, maxInclusive: 0, description: 'No tangible user loss.' }),
  Object.freeze({ id: 'brief_rework', minExclusive: 0, maxInclusive: 5, description: 'Up to five minutes of correction, attention, or explicitly equivalent loss.' }),
  Object.freeze({ id: 'bounded_rework', minExclusive: 5, maxInclusive: 60, description: 'More than five minutes and up to one hour of rework or explicitly equivalent loss.' }),
  Object.freeze({ id: 'substantial_rework', minExclusive: 60, maxInclusive: 480, description: 'More than one hour and up to one workday of effort or explicitly equivalent loss.' }),
  Object.freeze({ id: 'material_setback', minExclusive: 480, maxInclusive: 10_080, description: 'More than one workday and up to one week of minute-equivalent tangible lost work, money, access, or opportunity.' }),
  Object.freeze({ id: 'major_loss', minExclusive: 10_080, maxInclusive: USER_COST_MAX_UNITS, description: 'A named, tangible loss exceeding one week of minute-equivalent user loss; explain the concrete magnitude and conversion.' }),
]);

export const USER_COST_CALIBRATION = Object.freeze({
  unit: 'minute_equivalent_user_loss',
  definition: '1 unit = 1 minute of avoidable user effort, or a documented equivalent user loss.',
  defaultHorizon: 'From this decision through task completion and verification; use the same horizon for every option and all consequences.',
  probabilityDefault: 'Judgmental assumption, not empirical frequency.',
  empiricalPolicy: 'An empirical fraction describes the cited observed sample, not a guaranteed underlying probability. Calibrated, adjusted, posterior, and hypothetical estimates remain labeled assumptions with their source and rationale.',
  unknownPolicy: 'Preserve null central estimates. The validated nonnegative domains supply bounds, not imputed estimates: probability 0..1 and loss 0..1000000. Refine material unknowns internally and continue other authorized work. Unknown is neither zero nor catastrophe nor a reason to ask by itself.',
  uncertaintyPolicy: 'Ranges inform sensitivity only. No uncertainty multiplier, worst-case veto, or invented enterprise/security/compliance obligation.',
  hardConstraintPolicy: 'Only a concrete applicable constraint with its source and observed violation blocks an option; ordinary uncertainty and hypothetical harm do not.',
  consequencePolicy: 'Name a tangible user outcome and justify its minute-equivalent severity; abstract honesty, liability, cybersecurity, or discomfort is not a consequence estimate.',
  baselinePolicy: 'Compare incremental action-specific risks on one common baseline and horizon; include shared background risk in all affected options or exclude it from all. Sum distinct consequences without double-counting. For correlated events supply a justified joint or conditional scenario probability, not an invented independence product.',
  tiePolicy: 'Sort exact numeric costs first. Form each rounding-tolerance tie group around its fixed exact minimum, then prefer progress, reversibility, and stable option id. Approximate pairwise equality is never a sort comparator.',
});

const stringSchema = { type: 'string', minLength: 1, maxLength: 2400 };
const idSchema = { type: 'string', minLength: 1, maxLength: 120 };
const nullableNumber = (maximum) => ({ type: ['number', 'null'], minimum: 0, maximum });
const rangeSchema = (maximum) => ({
  type: 'object', additionalProperties: false, required: ['min', 'max'],
  properties: { min: { type: 'number', minimum: 0, maximum }, max: { type: 'number', minimum: 0, maximum } },
});
const costSchema = {
  type: 'object', additionalProperties: false, required: ['value', 'basis'],
  properties: { value: nullableNumber(USER_COST_MAX_UNITS), basis: stringSchema, zeroCostJustification: stringSchema },
};

/** Shared by the direct tool schema and persisted planning decision schema. */
export const USER_COST_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'assumptions', 'hardConstraints', 'options'],
  properties: {
    decision: stringSchema,
    horizon: stringSchema,
    assumptions: { type: 'array', maxItems: 32, items: stringSchema },
    hardConstraints: {
      type: 'array', maxItems: 32,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'rule', 'source', 'observedViolation', 'blockedOptionIds'],
        properties: {
          id: idSchema,
          kind: { type: 'string', enum: ['user_constraint', 'required_authorization', 'verified_requirement'] },
          rule: stringSchema, source: stringSchema, observedViolation: stringSchema,
          blockedOptionIds: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: idSchema },
        },
      },
    },
    options: {
      type: 'array', minItems: 2, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'action', 'reversibility', 'outcome', 'risks', 'delayCost', 'interruptionCost', 'opportunityCost'],
        properties: {
          id: idSchema,
          action: { type: 'string', enum: ['proceed', 'ask', 'defer'] },
          reversibility: { type: 'string', enum: ['reversible', 'partly_reversible', 'irreversible'] },
          outcome: stringSchema,
          risks: {
            type: 'array', maxItems: 32,
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'probability', 'severity', 'probabilityBasis', 'severityBasis'],
              properties: {
                id: idSchema, probability: nullableNumber(1), severity: nullableNumber(USER_COST_MAX_UNITS),
                probabilityRange: rangeSchema(1), severityRange: rangeSchema(USER_COST_MAX_UNITS),
                probabilityBasis: {
                  type: 'object', additionalProperties: false, required: ['kind', 'rationale'],
                  properties: {
                    kind: { type: 'string', enum: ['assumption', 'user_estimate', 'empirical', 'unknown'] },
                    rationale: stringSchema, source: stringSchema,
                    events: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                    trials: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                  },
                },
                severityBasis: {
                  type: 'object', additionalProperties: false,
                  required: ['anchor', 'consequence', 'conversionBasis'],
                  properties: {
                    anchor: { type: 'string', enum: [...USER_COST_ANCHORS.map((item) => item.id), 'unknown'] },
                    consequence: stringSchema, conversionBasis: stringSchema,
                  },
                },
              },
            },
          },
          delayCost: costSchema, interruptionCost: costSchema, opportunityCost: costSchema,
          clarification: {
            type: 'object', additionalProperties: false,
            required: ['baselineOptionId', 'informationNeeded', 'howAnswerChangesAction', 'residualRiskBasis'],
            properties: {
              baselineOptionId: idSchema, informationNeeded: stringSchema,
              howAnswerChangesAction: stringSchema, residualRiskBasis: stringSchema,
            },
          },
        },
      },
    },
  },
};

function invalid(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = 'INVALID_USER_COST_DECISION';
  error.path = path;
  throw error;
}

function validateSchema(value, schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const isInteger = schema.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value);
  if (!types.includes(type) && !isInteger) invalid(path, `expected ${types.join(' or ')}; missing estimates must be explicit null`);
  if (type === 'number') {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
      invalid(path, `must be finite and between ${schema.minimum} and ${schema.maximum}`);
    }
  }
  if (type === 'string' && (value.trim().length < (schema.minLength || 0) || value.length > schema.maxLength)) invalid(path, 'requires nonempty bounded text');
  if (schema.enum && !schema.enum.includes(value)) invalid(path, `expected one of ${schema.enum.join(', ')}`);
  if (type === 'array') {
    if (value.length < (schema.minItems || 0) || value.length > schema.maxItems) invalid(path, 'array length is outside the allowed bounds');
    if (schema.uniqueItems && new Set(value).size !== value.length) invalid(path, 'items must be unique');
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
  if (type === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(path, 'must be a plain object');
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) invalid(`${path}.${name}`, 'required; do not silently replace unknown values with zero');
    for (const [name, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, name)) invalid(`${path}.${name}`, 'unknown property; computed recommendations cannot be supplied or overridden');
      validateSchema(item, schema.properties[name], `${path}.${name}`);
    }
  }
}

// A relative tolerance handles 0.1 + 0.2 without flattening tiny nonzero risks.
function numericCompare(a, b) {
  const tolerance = Number.EPSILON * 8 * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  return Math.abs(a - b) <= tolerance ? 0 : a < b ? -1 : 1;
}

function uniqueIds(items, path) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) invalid(path, 'ids must be unique');
}

function validateRange(range, estimate, path) {
  if (!range) return;
  if (range.min > range.max) invalid(path, 'min must not exceed max');
  if (estimate !== null && (estimate < range.min || estimate > range.max)) invalid(path, 'range must include the central estimate');
}

function validateInput(input) {
  validateSchema(input, USER_COST_DECISION_SCHEMA, 'decision');
  uniqueIds(input.options, 'decision.options');
  uniqueIds(input.hardConstraints, 'decision.hardConstraints');
  const options = new Map(input.options.map((option) => [option.id, option]));
  for (const constraint of input.hardConstraints) {
    for (const id of constraint.blockedOptionIds) if (!options.has(id)) invalid(`constraint.${constraint.id}`, `unknown blocked option ${id}`);
  }
  for (const option of input.options) {
    const path = `option.${option.id}`;
    uniqueIds(option.risks, `${path}.risks`);
    for (const risk of option.risks) {
      const riskPath = `${path}.risk.${risk.id}`;
      const basis = risk.probabilityBasis;
      if (basis.kind === 'unknown' && risk.probability !== null) invalid(riskPath, 'unknown probability basis requires a null estimate');
      if (basis.kind === 'empirical') {
        if (!basis.source || !Number.isSafeInteger(basis.events) || !Number.isSafeInteger(basis.trials) || basis.trials <= 0 || basis.events > basis.trials) invalid(riskPath, 'empirical probability requires a source and valid event/trial counts');
        if (risk.probability === null || numericCompare(risk.probability, basis.events / basis.trials) !== 0) invalid(riskPath, 'empirical probability must match its event/trial counts; label adjusted or hypothetical estimates as assumptions');
      } else if (basis.events !== undefined || basis.trials !== undefined) {
        invalid(riskPath, 'event/trial counts require empirical kind');
      }
      if (basis.kind === 'user_estimate' && !basis.source) invalid(riskPath, 'user_estimate requires the source of the user-provided estimate');
      const anchor = USER_COST_ANCHORS.find((item) => item.id === risk.severityBasis.anchor);
      if (risk.severity === null) {
        if (risk.severityBasis.anchor !== 'unknown') invalid(riskPath, 'unknown severity requires the unknown anchor');
      } else if (!anchor || risk.severity > anchor.maxInclusive || (anchor.minExclusive !== null && risk.severity <= anchor.minExclusive)) {
        invalid(riskPath, 'severity does not match its concrete consequence anchor');
      }
      validateRange(risk.probabilityRange, risk.probability, `${riskPath}.probabilityRange`);
      validateRange(risk.severityRange, risk.severity, `${riskPath}.severityRange`);
    }
    if (option.action === 'ask') {
      if (!option.clarification) invalid(path, 'ask requires its information value, baseline, and expected residual-risk basis');
      const baseline = options.get(option.clarification.baselineOptionId);
      if (!baseline || baseline.action !== 'proceed') invalid(path, 'ask baseline must identify a proceed option');
      if (option.interruptionCost.value === 0 && !option.interruptionCost.zeroCostJustification) invalid(path, 'zero-cost asking requires an explicit zeroCostJustification; user attention is not free by default');
    } else if (option.clarification) {
      invalid(path, 'clarification belongs only to an ask option');
    }
  }
}

function multiply(a, b) {
  // An explicitly zero consequence/probability is zero even if its other
  // factor is unknown; this is arithmetic, not an imputed estimate.
  return a === 0 || b === 0 ? 0 : a === null || b === null ? null : a * b;
}

function sumKnown(values) {
  return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + value, 0);
}

function bounds(risk) {
  const p = valueBounds(risk.probability, 1, risk.probabilityRange);
  const s = valueBounds(risk.severity, USER_COST_MAX_UNITS, risk.severityRange);
  return { min: p.min * s.min, max: p.max * s.max };
}

function valueBounds(value, maximum, explicitRange) {
  // Domain bounds are not a guess of the unknown central estimate.
  return explicitRange || (value === null ? { min: 0, max: maximum } : { min: value, max: value });
}

function sumBounds(ranges) {
  return { min: ranges.reduce((sum, range) => sum + range.min, 0), max: ranges.reduce((sum, range) => sum + range.max, 0) };
}

function subtractBounds(a, b) {
  return { min: a.min - b.max, max: a.max - b.min };
}

function optionPreference(a, b) {
  const actionRank = { proceed: 0, defer: 1, ask: 2 };
  const reversibilityRank = { reversible: 0, partly_reversible: 1, irreversible: 2 };
  return actionRank[a.action] - actionRank[b.action] || reversibilityRank[a.reversibility] - reversibilityRank[b.reversibility] || (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0);
}

function rankOptions(options) {
  const exactOrder = [...options].sort((a, b) => a.totalCost - b.totalCost || optionPreference(a, b));
  const ranking = [];
  for (let start = 0; start < exactOrder.length;) {
    const fixedMinimum = exactOrder[start].totalCost;
    let end = start + 1;
    while (end < exactOrder.length && numericCompare(exactOrder[end].totalCost, fixedMinimum) === 0) end += 1;
    ranking.push(...exactOrder.slice(start, end).sort(optionPreference));
    start = end;
  }
  return ranking;
}

function breakEvenProbability(numerator, severity) {
  const ratio = numerator / severity;
  const representation = !Number.isFinite(ratio) ? 'overflow' : ratio === 0 && numerator !== 0 ? 'underflow' : 'finite';
  return {
    probability: representation === 'finite' ? ratio : null,
    domainPosition: numerator < 0 ? 'below_zero' : numerator > severity ? 'above_one' : 'within_unit_interval',
    representation,
    ratio: { numerator, denominator: severity },
  };
}

export function evaluateUserCostDecision(input) {
  validateInput(input);
  const unknowns = [];
  const comparableCosts = input.options.map((option) => {
    const constraints = input.hardConstraints.filter((constraint) => constraint.blockedOptionIds.includes(option.id));
    const riskCosts = option.risks.map((risk) => {
      const expectedCost = multiply(risk.probability, risk.severity);
      if (risk.probability === null) unknowns.push({ optionId: option.id, path: `risks.${risk.id}.probability`, affectsCost: expectedCost === null, basis: risk.probabilityBasis.rationale });
      if (risk.severity === null) unknowns.push({ optionId: option.id, path: `risks.${risk.id}.severity`, affectsCost: expectedCost === null, basis: risk.severityBasis.conversionBasis });
      return { riskId: risk.id, probability: risk.probability, severity: risk.severity, expectedCost, range: bounds(risk), probabilityBasis: { ...risk.probabilityBasis }, severityBasis: { ...risk.severityBasis } };
    });
    for (const name of ['delayCost', 'interruptionCost', 'opportunityCost']) {
      if (option[name].value === null) unknowns.push({ optionId: option.id, path: name, affectsCost: true, basis: option[name].basis });
    }
    const expectedConsequenceCost = sumKnown(riskCosts.map((risk) => risk.expectedCost));
    const expectedConsequenceRange = sumBounds(riskCosts.map((risk) => risk.range));
    const frictionValues = [option.delayCost.value, option.interruptionCost.value, option.opportunityCost.value];
    const frictionCost = sumKnown(frictionValues);
    const frictionRange = sumBounds(frictionValues.map((value) => valueBounds(value, USER_COST_MAX_UNITS)));
    return {
      optionId: option.id, action: option.action, reversibility: option.reversibility, outcome: option.outcome,
      eligible: constraints.length === 0,
      blockedBy: constraints.map((constraint) => ({ ...constraint, blockedOptionIds: [...constraint.blockedOptionIds] })),
      riskCosts, expectedConsequenceCost, expectedConsequenceRange,
      delayCost: { ...option.delayCost }, interruptionCost: { ...option.interruptionCost }, opportunityCost: { ...option.opportunityCost },
      frictionCost, frictionRange, totalCost: sumKnown([expectedConsequenceCost, frictionCost]),
      totalRange: sumBounds([expectedConsequenceRange, frictionRange]),
      informationValue: null,
    };
  });
  const byId = new Map(comparableCosts.map((option) => [option.optionId, option]));
  for (const option of input.options.filter((item) => item.action === 'ask')) {
    const row = byId.get(option.id);
    const baseline = byId.get(option.clarification.baselineOptionId);
    const complete = baseline.totalCost !== null && row.totalCost !== null;
    const reduction = baseline.expectedConsequenceCost !== null && row.expectedConsequenceCost !== null ? baseline.expectedConsequenceCost - row.expectedConsequenceCost : null;
    const incrementalFriction = row.frictionCost !== null && baseline.frictionCost !== null ? row.frictionCost - baseline.frictionCost : null;
    const netValueRange = subtractBounds(baseline.totalRange, row.totalRange);
    // Known central estimates govern nominal decisions. Only when a central
    // estimate is missing can bounds prove information value or dominance.
    const worthInterrupting = complete
      ? numericCompare(baseline.totalCost, row.totalCost) > 0
      : numericCompare(baseline.totalRange.min, row.totalRange.max) > 0 ? true
        : numericCompare(baseline.totalRange.max, row.totalRange.min) <= 0 ? false : null;
    row.informationValue = {
      ...option.clarification,
      baselineEligible: baseline.eligible,
      expectedMistakeCostReduction: reduction,
      expectedMistakeCostReductionRange: subtractBounds(baseline.expectedConsequenceRange, row.expectedConsequenceRange),
      incrementalFrictionCost: incrementalFriction,
      incrementalFrictionCostRange: subtractBounds(row.frictionRange, baseline.frictionRange),
      netValue: complete ? baseline.totalCost - row.totalCost : null,
      netValueRange,
      worthInterrupting,
      evaluationBasis: complete ? 'central_estimates' : worthInterrupting === null ? 'unresolved_bounds' : 'proven_bounds',
      qualification: baseline.eligible ? 'Question must improve expected user outcomes by more than its incremental interruption, delay, and opportunity cost.' : 'Proceed baseline is blocked by a sourced actual constraint; compare feasible options without treating that constraint as a speculative risk.',
    };
    if (baseline.riskCosts.length === 1 && baseline.riskCosts[0].severity > 0 && baseline.frictionCost !== null && row.totalCost !== null) {
      row.informationValue.breakEven = {
        riskId: baseline.riskCosts[0].riskId,
        ...breakEvenProbability(row.totalCost - baseline.frictionCost, baseline.riskCosts[0].severity),
        currentProbability: baseline.riskCosts[0].probability,
        policy: 'Holding severity, residual risk after asking, and other costs fixed, ask beats this proceed option only above this probability; equality favors proceeding. The threshold is algebra, not an empirical rate.',
      };
    }
  }
  const eligible = comparableCosts.filter((option) => option.eligible);
  const asksWithoutInformationValue = (option) => option.action === 'ask' && option.informationValue.baselineEligible && option.informationValue.worthInterrupting !== true;
  const unresolved = eligible.filter((option) => option.totalCost === null || (asksWithoutInformationValue(option) && option.informationValue.worthInterrupting === null));
  const rankable = rankOptions(eligible.filter((option) => option.totalCost !== null && !asksWithoutInformationValue(option)));
  // Do not hide a known-cost question whose information value is unresolved.
  // Nor let an unknown whose domain lower bound exceeds the best known cost
  // stall progress. Keep the central estimate null in either case.
  const materiallyIncomplete = unresolved.filter((option) => !rankable[0] || numericCompare(option.totalRange.min, rankable[0].totalCost) <= 0);
  const status = eligible.length === 0 ? 'no_eligible_option' : materiallyIncomplete.length ? 'needs_estimates' : 'evaluated';
  const winner = status === 'evaluated' ? rankable[0] || null : null;
  const overlappingOptions = winner ? eligible.filter((option) => option.optionId !== winner.optionId && option.totalRange.min !== null && winner.totalRange.max !== null && numericCompare(option.totalRange.min, winner.totalRange.max) <= 0).map((option) => option.optionId) : [];
  const rationale = winner
    ? `${winner.optionId} has the lowest eligible expected user cost within numeric precision (${winner.totalCost} minute-equivalent units). Each rounding-tolerance tie group is anchored to its fixed exact minimum, then prefers progress, reversibility, and stable option id. A higher-cost question or deferral requires concrete new evidence and a recalculated comparison.`
    : status === 'needs_estimates'
      ? 'An eligible option has an explicit unknown estimate. Do not convert uncertainty to catastrophe, zero, an authorization failure, or an automatic question. Refine internally from existing evidence or labeled assumptions and continue other authorized work.'
      : 'Every option violates a sourced actual constraint. Construct another feasible option; this result does not itself authorize a user interruption.';
  return {
    version: 1, decision: input.decision, status,
    calibration: { ...USER_COST_CALIBRATION, horizon: input.horizon || USER_COST_CALIBRATION.defaultHorizon, anchors: USER_COST_ANCHORS.map((anchor) => ({ ...anchor })), assumptions: [...input.assumptions] },
    preferredAction: winner?.action || null, recommendedOptionId: winner?.optionId || null,
    recommendedCost: winner?.totalCost ?? null,
    rankedOptionIds: rankable.map((option) => option.optionId),
    comparableCosts, unknowns,
    sensitivity: { overlappingOptionIds: overlappingOptions, affectsNominalRecommendation: false, policy: 'Overlapping ranges disclose that different plausible estimates may change the winner. They do not replace the stated central expected costs with worst-case values or override this nominal recommendation.' },
    escalationJustified: winner?.action === 'ask',
    overrideRequiresNewEvidence: true,
    overridePolicy: 'Do not choose another option from vague caution or free-text rationale. Record concrete new evidence or a corrected assumption, update the estimates or actual constraints, and recompute first.',
    internalNextStep: status === 'needs_estimates' ? 'refine_estimates_and_continue_other_authorized_work' : status === 'no_eligible_option' ? 'construct_feasible_option_and_continue_other_authorized_work' : null,
    rationale,
  };
}

export const scoreUserCostDecision = evaluateUserCostDecision;

/** Recompute from raw input; never trust a model-supplied preferred action. */
export function assertUserCostChoice(input, optionId) {
  const result = evaluateUserCostDecision(input);
  if (!result.recommendedOptionId || optionId !== result.recommendedOptionId) {
    const error = new Error(`User-cost decision requires ${result.recommendedOptionId || 'internal estimate/option refinement'}; ${optionId} cannot be chosen without concrete new evidence and recomputation.`);
    error.code = 'USER_COST_RECALCULATION_REQUIRED';
    error.decision = result;
    throw error;
  }
  return result;
}
