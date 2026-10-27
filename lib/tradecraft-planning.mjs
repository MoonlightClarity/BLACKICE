import { inspectJudgmentTraceability } from './analysis-quality.mjs';

/**
 * BLACKICE's adaptive analytic work architecture.
 *
 * Informed by the 2009 Tradecraft Primer, especially the timeline on PDF
 * page 42 (printed page 38). Techniques are reusable passes, not mandatory
 * statuses in a linear ontology. The user's goal and actual evidence select
 * the method; the source is not itself a source of task-specific facts.
 *
 * Keep these instructions separate from document- or resume-specific claims.
 */
export const TRADECRAFT_TIMELINE = Object.freeze([
  Object.freeze({
    phase: 'framing',
    recurring: true,
    methods: Object.freeze(['key_assumptions_check', 'brainstorming', 'outside_in']),
    reason: 'Frame the actual question, decision boundary and untested premises; repeat when the frame changes.'
  }),
  Object.freeze({
    phase: 'investigation',
    recurring: true,
    methods: Object.freeze(['information_quality', 'competing_hypotheses', 'indicators']),
    reason: 'Inspect source quality and use evidence to discriminate hypotheses rather than accumulate favorable citations.'
  }),
  Object.freeze({
    phase: 'challenge',
    recurring: true,
    methods: Object.freeze(['devils_advocacy', 'team_a_team_b', 'red_team', 'what_if']),
    reason: 'Use targeted contrarian passes when a leading interpretation becomes strong, fragile or consequential.'
  }),
  Object.freeze({
    phase: 'decision',
    recurring: true,
    methods: Object.freeze(['assumptions_recheck', 'sensitivity', 'decision_test', 'signposts']),
    reason: 'Revisit decisive assumptions and map options to observed effects, constraints, and triggers for reconsideration.'
  })
]);
const ANALYTIC_REQUEST = /\b(?:analy[sz]e|assessment|assess|evaluat|investigat|research|diagnos|compare|intelligence|forecast|strategy|decid|recommend|why|interpret|examin|review)\w*\b/i;
const DECISION_REQUEST = /\b(?:should\s+(?:i|we)|what\s+should|recommend(?:s|ed|ing|ation|ations)?|decisions?|choos(?:e|ing)|which\s+option|strategy\s+for|improv(?:e|es|ed|ing|ement|ements)|optimi[sz](?:e|es|ed|ing|ation)|action\s+plan|how\s+to\s+get|what\s+can\s+(?:i|we)\s+do)\b/i;
const SCOPED_EDIT = /\b(?:only\s+(?:check|fix|correct|proofread)\s+(?:the\s+)?(?:typos?|grammar|spelling|formatting)|(?:typos?|grammar|spelling|formatting)\s+only|proofread)\b/i;
const NO_RECOMMENDATIONS = /\b(?:no\s+(?:advice|recommendations?)|(?:do\s+not|don't|without)\s+(?:give\s+)?recommend(?:ations?|ing)?|analysis\s+only)\b/i;
// Relevance hints for optional plan UI advice; never a gate on the shared method.
export function tradecraftTaskFrame(task='') {
  const text=String(task??'');
  const scopedEdit = SCOPED_EDIT.test(text);
  return Object.freeze({
    analytical: !scopedEdit && ANALYTIC_REQUEST.test(text),
    decisionSpecified: !scopedEdit && !NO_RECOMMENDATIONS.test(text) && DECISION_REQUEST.test(text)
  });
}
export function tradecraftPlanningInstructions({task='',mode='on'}={}) {
  if(mode==='off')return '';
  const frame=tradecraftTaskFrame(task);
  if(!frame.analytical && !frame.decisionSpecified)return '';
  const detail='Scale the visible outline to the useful work. Develop distinct analytical subquestions only when their evidence or consequence differs; never enlarge a plan solely because a legacy setting was Maximal.';
  return [
    '\n\nADAPTIVE ANALYTIC PLANNING — VISIBLE WORK RECORDS',
    'Use the shared general analytical method; this addendum only concerns live plan continuity. Choose and revisit useful methods without compulsory stages or method counts. Source collection may be batched; analytical questions whose evidence, tests or consequences differ retain their own work and findings.',
    detail,
    'Provisional source-based Think observations remain useful and visible. Save revisions as evidence accumulates, then put the integrated findings and decisions in Respond. Do not manufacture steps, evidence, verification, or confidence to satisfy a template.'
  ].join('\n');
}

/**
 * Advisory on every saved plan revision. Optional questions follow the user's
 * stated task, not an analytical quality inferred from progress. It never marks a step
 * complete, changes plan topology, blocks delivery, or claims comprehension.
 * Page 42's recurring techniques are suggestions, not permissions or stages.
 */
export function tradecraftPlanPulse({ task = '', state = {}, documentContext = null } = {}) {
  const frame = tradecraftTaskFrame(task || state.goal || '');
  if (SCOPED_EDIT.test(String(task || ''))
    || !frame.analytical && !frame.decisionSpecified && !documentContext) return null;
  const suppliedRequest = typeof task === 'string' && Boolean(task.trim());
  // Repeat the actual request at this decision point, not the mutable plan
  // goal. Long pasted sources stay bounded and are explicitly excerpts.
  const requestLimit = 4000;
  const requestText = suppliedRequest && task.length > requestLimit
    ? task.slice(0, requestLimit / 2) + '\n[request excerpt: middle omitted]\n' + task.slice(-requestLimit / 2)
    : task;
  const actions = (Array.isArray(state.steps) ? state.steps : [])
    .filter(step => (step.kind || 'action') === 'action');
  const done = actions.filter(step => step.status === 'done').length;
  const nonterminal = actions.filter(step => !['done', 'skipped'].includes(step.status));
  const types = actions.map(step => String(step.stepType || '')).filter(Boolean);
  const occurrences = new Map();
  for (const kind of types) occurrences.set(kind, (occurrences.get(kind) || 0) + 1);
  const repeatedMethods = [...occurrences].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));
  const argumentReview = inspectJudgmentTraceability(actions);
  const suggestions = [];
  if (argumentReview.referenceErrors.length) suggestions.push({
    technique: 'information_quality',
    question: 'An explicit source-step relationship is broken in sourceIntegrity. Correct that actual link.'
  });
  suggestions.push({
    technique: 'goal_alignment',
    question: 'Does the current work address the actual user question, scope and accepted purpose? Keep a broad request broad; a recorded plan goal is not a replacement for the request.'
  }, {
    technique: 'comparison_test',
    question: 'For the consequential inference or change being considered now: explanatory alternatives predict different observations; evaluative alternatives compare the strongest feasible current approach and changes under the same actual goal, audience and constraints, with relevant evidence available to each. Analysis need not produce a choice or recommendation.'
  }, {
    technique: 'consequence_test',
    question: 'Which actual evidence discriminates the alternatives and changes the useful finding or proposed action? For a change, test the incremental gain and loss against the current state; a possible benefit alone does not establish superiority. Retain unresolved uncertainty rather than invent a winner.'
  });
  return {
    advisory: true,
    planRevision: Number.isSafeInteger(state.revision) ? state.revision : null,
    completedActions: done, totalActions: actions.length,
    unfinishedActions: nonterminal.length,
    allActionsTerminal: actions.length > 0 && nonterminal.length === 0,
    explicitDecisionInLatestRequest: suppliedRequest && frame.decisionSpecified,
    requestContext: {
      source: suppliedRequest ? 'current-user-request' : 'recorded-plan-goal-fallback',
      ...(suppliedRequest ? { text: requestText, truncated: task.length > requestLimit } : {}),
      ...(documentContext ? { artifactFunctionHint: documentContext.artifactFunctionHint,
        analysisIntent: documentContext.analysisIntent, purposeSource: documentContext.purposeSource } : {}),
      note: 'Artifact-function hints are provisional context, not complete user goals. Recorded plan goals are work records, not user instructions.'
    },
    repeatedMethods,
    sourceIntegrity: {
      source: 'recorded-step-relationships',
      referenceErrors: argumentReview.referenceErrors.slice(0, 12),
      omittedReferenceErrors: Math.max(0, argumentReview.referenceErrors.length - 12),
      note: 'Only factual broken explicit step references are reported. This does not assess source accuracy or the usefulness of the reasoning.'
    },
    nextPasses: suggestions.slice(0, 3),
    note: 'Suggestions are not mandatory milestones or independently verified reasoning. Revisit techniques whenever actual evidence changes the question.'
  };
}

/** Non-blocking diagnostics for action claims; never substitutes for judging their content. */
export function assessActionClaim({decision='',assumption='',basis='',mechanism='',feasibility='',test='',intervention=''}={}) {
  const fields={decision,assumption,basis,mechanism,feasibility,test,intervention};
  const missing=Object.entries(fields)
    .filter(([,value])=>typeof value!=='string'||!value.trim())
    .map(([name])=>name);
  return { supportedForm:missing.length===0, missing, isRecommendation:typeof intervention==='string'&&Boolean(intervention.trim()) };
}
