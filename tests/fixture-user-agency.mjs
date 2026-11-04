/** Fresh synthetic evidence for routine current-contract planning responses. */
export function fixtureUserAgency() {
  return {
    version: 1,
    audience: 'internal',
    userBenefit: 'Complete the bounded authorized fixture objective using the supplied evidence.',
    representation: {
      actualQuestion: 'Carry out the bounded task described by this test fixture.',
      requiredFacts: [], relevantClaims: [], privateFindings: [], userReport: []
    },
    action: 'proceed',
    decisionRequired: false,
    decisionReason: 'The fixture supplies the facts and authority needed for this routine step; no decision-changing uncertainty remains.',
    decisions: [],
    chosenDecisionId: null
  };
}

/** Use only when the fixture explicitly supplies a failed or unavailable prerequisite. */
export function fixtureDeferredUserAgency(reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw Error('Supply the fixture evidence for deferring the affected action.');
  const cost = (value, basis) => ({ value, basis });
  const option = (id, action, risks, delay, interruption) => ({
    id, action, reversibility: 'reversible', outcome: action === 'defer'
      ? 'Preserve the affected work until its failed prerequisite is repaired; continue independent ready work.'
      : action === 'ask' ? 'Ask whether the user can supply a working prerequisite or an acceptable alternative.'
        : 'Repeat the affected operation while its recorded failed prerequisite remains unchanged.',
    risks,
    delayCost: cost(delay, 'Illustrative minute-equivalent loss from delay within this bounded fixture step.'),
    interruptionCost: cost(interruption, action === 'ask' ? 'Three illustrative minute-equivalents for the user to read and answer.' : 'No user interruption.'),
    opportunityCost: cost(0, 'Independent ready work continues; no additional lost opportunity in this bounded fixture comparison.'),
    ...(action === 'ask' ? { clarification: {
      baselineOptionId: 'proceed',
      informationNeeded: 'Whether a working prerequisite or acceptable alternative is available from the user.',
      howAnswerChangesAction: 'An effective alternative would replace the affected failed operation; otherwise it remains deferred.',
      residualRiskBasis: 'Give asking its favorable illustrative case: an effective answer removes the repeated-work loss, but its interruption cost still exceeds bounded deferral.'
    } } : {})
  });
  return {
    ...fixtureUserAgency(),
    action: 'defer', decisionRequired: true,
    decisionReason: reason + ' Defer only this affected action because the synthetic comparison makes repeated failed work and a user interruption more costly.',
    decisions: [{ id: 'fixture_blocked_work', selectedOptionId: 'defer', input: {
      decision: 'How should the fixture handle this recorded failed or unavailable prerequisite? ' + reason,
      assumptions: [
        'These are explicit synthetic assumptions in minute-equivalent user-loss units over the same next-step horizon, not measured frequencies.',
        'Repeating the unchanged failed operation loses eight minute-equivalents; bounded deferral loses one; a favorable user answer costs three.'
      ],
      hardConstraints: [],
      options: [
        option('proceed', 'proceed', [{
          id: 'repeat_failed_work', probability: 1, severity: 8,
          probabilityBasis: { kind: 'assumption', rationale: 'The fixture supplies the unchanged failed prerequisite: ' + reason },
          severityBasis: { anchor: 'bounded_rework', consequence: 'Repeat work that cannot satisfy the fixture criterion before repairing its prerequisite.', conversionBasis: 'Eight illustrative minute-equivalents of wasted work and recovery.' }
        }], 0, 0),
        option('defer', 'defer', [], 1, 0),
        option('ask', 'ask', [], 0, 3)
      ]
    } }],
    chosenDecisionId: 'fixture_blocked_work'
  };
}

/** Use only for a specific required fact the fixture says the captured records do not supply. */
export function fixtureAskingUserAgency(question) {
  if (typeof question !== 'string' || !question.trim()) throw Error('Supply the specific missing-fact question.');
  const cost = (value, basis) => ({ value, basis });
  const option = (id, action, delay, interruption, opportunity, outcome) => ({
    id, action, reversibility: 'reversible', outcome, risks: [],
    delayCost: cost(delay, 'Illustrative minute-equivalent loss from delaying the fact-dependent result.'),
    interruptionCost: cost(interruption, action === 'ask' ? 'Two illustrative minute-equivalents to read and supply the specific factual answer.' : 'No user interruption.'),
    opportunityCost: cost(opportunity, 'Incremental lost value of leaving this fixture result incomplete within the same task-completion horizon; independent work continues.'),
    ...(action === 'ask' ? { clarification: {
      baselineOptionId: 'proceed', informationNeeded: question,
      howAnswerChangesAction: 'Use the supplied fact for the dependent step without inventing a personal fact or asking again.',
      residualRiskBasis: 'The fixture supplies an exact usable answer on clarification; it removes the dependent-result delay assumed for the other options.'
    } } : {})
  });
  return {
    ...fixtureUserAgency(),
    action: 'ask', decisionRequired: true,
    decisionReason: 'The fixture has checked the supplied records and still lacks the specific required fact. This answer changes the dependent action and its illustrative information benefit exceeds the interruption.',
    decisions: [{ id: 'fixture_missing_fact', selectedOptionId: 'ask', input: {
      decision: 'Obtain the specific missing fact or leave the dependent fixture result incomplete: ' + question,
      assumptions: ['All losses are explicitly synthetic minute-equivalent estimates over the same task-completion horizon, not empirical measurements. Independent ready work continues in every option; no personal fact is invented.'],
      hardConstraints: [],
      options: [
        option('proceed', 'proceed', 0, 0, 8, 'Continue only supported independent work while the requested fact-dependent result remains incomplete.'),
        option('defer', 'defer', 5, 0, 0, 'Postpone the affected result without obtaining the fact needed to finish it.'),
        option('ask', 'ask', 0, 2, 0, 'Obtain the specific required answer and complete the dependent result.')
      ]
    } }],
    chosenDecisionId: 'fixture_missing_fact'
  };
}
