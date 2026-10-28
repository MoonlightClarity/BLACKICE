import { validateJudgmentLedger, validateJudgmentAudit, validateJudgmentDelivery, inspectJudgmentTraceability } from './analysis-quality.mjs';

/**
 * Evidence-led document analysis is not equivalent to a completed read operation.
 * Current user task + attachments only; not archived projects or user identity.
 * The plan gate checks traceability and coverage, not semantic correctness.
 */
export const DOCUMENT_ANALYSIS_STAGES = Object.freeze([
  { stepType: 'source_inventory', label: 'Source inventory and coverage', intent: 'Read all pages and inventory every material section or record with source locators.' },
  { stepType: 'unit_analysis', label: 'Section- or record-level interpretation', intent: 'Analyze each distinct source unit separately, including concrete claims, metrics, roles and dates.' },
  { stepType: 'cross_analysis', label: 'Cross-record synthesis', intent: 'Reconcile relationships, chronology, contradictions, alternatives and uncertainty across units.' },
  { stepType: 'evidence_audit', label: 'Claim-by-claim quality audit', intent: 'Trace major judgments to locations, identify unsupported generalities and check gaps.' },
  { stepType: 'delivery', label: 'Evidence-led findings', intent: 'Deliver findings at a depth warranted by the source, with examples, implications and limitations.' }
]);
const DOC_KINDS = new Set(['pdf', 'text', 'document']);
const ACTION = /\b(?:analy[sz]e|assess|evaluate|critique|review|audit|examine|interpret|fact[ -]?check|verify|compare|rewrite|tailor|edit|improve|optimi[sz]e|should\s+(?:i|we))\b/i;
const SUBJECT = /\b(?:(?:resume|résumé|cv|curriculum vitae|document|report|paper|proposal|brief|contract|transcript|portfolio|file|pdf|attachment|article|material)s?|attached)(?![\p{L}\p{N}_])/iu;
// A document mentioned as background does not make a separate operational
// request a document analysis. Require the requested action to target the
// artifact, or an explicit reference to an attached/previously named one.
const DIRECT_DOCUMENT_ACTION = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:re-)?` + ACTION.source + String.raw`\s+(?:(?:the|this|that|these|those|a|an|my|our|your|their|his|her|its|following|attached|uploaded|provided|supplied|given|original|current|existing|full|entire|complete|master|draft|detailed|all|of|first|pages|two|three|multiple|several|[\p{L}][\p{L}\p{M}'’\-]*['’]s|\d+(?:[-\s]page)?)\s+){0,8}` + SUBJECT.source, 'giu');
const INDIRECT_DOCUMENT_ACTION = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:re-)?` + ACTION.source + String.raw`\s+(?:(?:the|this|my|your|their|candidate(?:['’]s)?)\s+){0,3}(?:leadership|experience|skills|strengths|qualifications|claims|accuracy|contents|language|evidence|arguments|sections)(?:\s+as\s+(?:presented|described|documented|stated|written))?\s+(?:in|within|of|from|using)\s+(?:(?:the|this|my|your|their|attached|provided|following|original)\s+){0,4}` + SUBJECT.source, 'giu');
function affirmativeMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const clause = text.slice(0, match.index).split(/(?:[.!?;\n]|\b(?:but|however|instead)\b)/i).at(-1);
    if (!/\b(?:do\s+not|don['’]t|never|avoid|without|must\s+not|no\s+need\s+to)\b/i.test(clause)) matches.push(match);
  }
  return matches.sort((a, b) => a.index - b.index);
}
const hasAffirmativeMatch = (text, patterns) => affirmativeMatches(text, patterns).length > 0;
const documentTarget = match => [...match[0].matchAll(new RegExp(SUBJECT.source, 'giu'))].at(-1)?.[0] || '';
const REFERENCED_DOCUMENT_ACTION = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:re-)?` + ACTION.source + String.raw`\s+(?:it|this|that|these|those|them)\b`, 'giu');
const RESUME = /\b(?:resume|résumé|cv|curriculum vitae)(?![\p{L}\p{N}_])/iu;
const SHORT = /\b(?:briefly|quick(?:ly)?|one.paragraph|in a sentence|short answer|tl;?dr|tldr|just summarize|bullet.summary)\b/i;
const SCOPED = /\b(?:only (?:check|fix|correct|proofread)|typos? only|grammar only|spelling only|formatting only|proofread)\b/i;
const fail = message => Object.assign(new Error(message), { status: 422, code: 'DOCUMENT_ANALYSIS_COVERAGE_REQUIRED' });
const hasLocator = value => /\b(?:page\s*\d+|pages\s*\d|p\.\s*\d+|line\s*\d+|lines\s*\d+|section\s*[:#\-]?\s*\S+|role\s*[:#\-]?\s*\S+|entry\s*[:#\-]?\s*\S+|paragraph\s*\d+|heading\s*[:#\-]?\s*\S+|experience|education|projects|skills|summary)\b/i.test(String(value||''));

export function documentAnalysisContract({ task = '', attachments = [], priorUserRequests = [] } = {}) {
  const input = String(task || ''), entries = Array.isArray(attachments) ? attachments : [];
  // Only actual same-conversation user requests supply inherited purpose. Agent
  // plan goals, source prose and another chat's preferences are not substitutes.
  const refersBack = ACTION.test(input) && /\b(?:it|its|this|that|these|those|them|same|again|further)\b/i.test(input)
    || /^\s*(?:please\s+)?(?:(?:continue|proceed|keep going|go deeper|more detail|again)\b|(?:why|how so)\??\s*$)/i.test(input);
  const requests = [...(refersBack && Array.isArray(priorUserRequests) ? priorUserRequests : [])
    .filter(row => typeof row?.text === 'string' && typeof row?.runId === 'string'), { text: input, runId: null }];
  if (!requests.some(row => ACTION.test(row.text)) || SCOPED.test(input)) return null;
  const supported = entries.filter(entry => DOC_KINDS.has(String(entry?.kind||'').toLowerCase()));
  const subject = requests.filter(row => SUBJECT.test(row.text)).at(-1);
  if (!subject && !supported.length) return null;
  let targetName = '';
  for (const row of requests) {
    const direct = affirmativeMatches(row.text, [DIRECT_DOCUMENT_ACTION, INDIRECT_DOCUMENT_ACTION]);
    if (direct.length) targetName = documentTarget(direct.at(-1));
    for (const reference of affirmativeMatches(row.text, [REFERENCED_DOCUMENT_ACTION])) {
      // Resolve an immediate correction such as 'do not just review the report;
      // improve it' only when no intervening object can own the pronoun.
      const preceding = [DIRECT_DOCUMENT_ACTION, INDIRECT_DOCUMENT_ACTION].flatMap(pattern => [...row.text.matchAll(pattern)])
        .filter(match => match.index + match[0].length <= reference.index)
        .sort((a, b) => a.index - b.index).at(-1);
      const bridge = preceding && row.text.slice(preceding.index + preceding[0].length, reference.index);
      if (preceding && /^[\s,;:—–-]*(?:(?:and|then|but|instead|also)\s*)?$/i.test(bridge)) targetName = documentTarget(preceding);
      else if (!SUBJECT.test(row.text) && (targetName || supported.length)) targetName ||= 'document';
    }
  }
  if (!targetName) return null;
  const explicitShort = SHORT.test(input), resume = RESUME.test(targetName);
  const explicitMethod = /\b(?:use|using|follow|following|apply|applying|with)\b[^\n]{0,60}\b(?:saved|skill|checklist|procedure|method)\b/i.test(input);
  let purpose = null;
  for (const row of requests) {
    const marketing = /\b(?:marketing|persuasi|positioning|presentation|conversion|design|layout)\w*\b/i.test(row.text);
    const verification = hasAffirmativeMatch(row.text, [/\b(?:fact[ -]?check|verify|verification\s+of|background[ -]?check|factual accuracy|authenticity)\b/gi])
      || !marketing && hasAffirmativeMatch(row.text, [/\baudit\b/gi]);
    const editorial = /\b(?:rewrite|tailor|shorten|optimi[sz]e|improve|polish|edit|fix|ats keywords|proofread)\b/i.test(row.text);
    if (verification || editorial || marketing) purpose = { intent: verification ? 'verification' : editorial ? 'editorial' : 'interpretive', row };
  }
  const verification = purpose?.intent === 'verification', editorial = purpose?.intent === 'editorial';
  const multiPage = supported.some(entry => Number(entry.pageCount || 0) >= 2);
  const pastedDocument = input.length >= 2000;
  const dense = resume && (supported.length > 0 || pastedDocument) || multiPage || supported.some(entry => entry.kind === 'text' && Number(entry.size || 0) >= 12000);
  return Object.freeze({
    type: resume ? 'resume' : 'document',
    // A source-function hint helps choose the analysis, never replaces the
    // user's actual goal or an accepted purpose established in conversation.
    artifactFunctionHint: verification ? 'factual-verification' : resume ? 'candidate-marketing' : 'establish-from-source',
    dense, explicitShort, explicitMethod,
    analysisIntent: verification ? 'verification' : editorial ? 'editorial' : 'interpretive',
    purposeSource: purpose ? { kind: purpose.row.runId ? 'prior-user-request' : 'current-user-request', ...(purpose.row.runId ? { runId: purpose.row.runId } : {}) } : { kind: 'artifact-function-hint' },
    requiresJudgments: dense && !explicitShort && (!editorial || verification),
    planningArchitecture: 'adaptive-tradecraft',
    // Legacy stage types remain readable but are not compulsory for new plans.
    requiredStepTypes: [],
    enforcePlan: dense && !explicitShort,
    attachmentCount: supported.length,
    pagesKnown: supported.reduce((sum, entry) => sum + (Number.isSafeInteger(entry?.pageCount) ? entry.pageCount : 0), 0)
  });
}

export function documentAnalysisVerbosity(_contract, configured = 'balanced') {
  // Source coverage determines the internal work, not a different user-facing
  // length preference. Specific current requests still take precedence.
  return configured;
}

export function documentAnalysisInstructions(contract, { planningMode = 'on' } = {}) {
  if (!contract) return '';
  const domain = contract.analysisIntent === 'verification'
    ? 'REQUESTED FACTUAL VERIFICATION: Inspect consequential claims, supporting or conflicting evidence and what can actually be checked. Distinguish source assertions from corroboration where it affects the requested check. The explicit verification goal takes precedence over the artifact’s ordinary function.'
    : contract.type === 'resume'
    ? 'CANDIDATE MARKETING LENS: Unless the user establishes another purpose, assess how the whole record presents the candidate in the best supportable light. Interpret cumulative, gig, contract, concurrent and project work in context. The most repeated job setting is not automatically the scope of the candidate’s capabilities or intended pitch. Separate underlying assets, their presentation and predictions about readers; conventional tenure, authority or a single identity are not default merit standards. Emphasize legitimate strengths; weaken a claim only for a consequential contradiction, misleading implication or actual audience requirement.'
    : 'DOCUMENT FUNCTION: Establish from the request, accepted context and actual source what this artifact is meant to do—such as persuade, inform a choice, explain, record, instruct or establish commitments. Assess it against that use and audience. A source’s completeness as a record, persuasiveness as a proposal and usefulness for a decision are different questions. Do not import the standards of one function into another.';
  const plan = contract.enforcePlan && planningMode !== 'off'
    ? 'LIVE ANALYTICAL WORK: Save a prospective relay_task outline, then revise it after inspecting the source. Plan the work needed to enable the actual user outcome, including interactions among material records and the comparisons that could change the choice. Source locations and completed actions preserve continuity; they do not establish that the goal was met. Choose and revisit methods where useful, with no required stages, judgment count or output template. Record findings in whatever compact form keeps the evidence-to-consequence reasoning inspectable. If using optional J1 records, ordinary source locators are valid; an explicit step:<id> must refer to a different completed source action. Do not fill analytical labels just to satisfy a form.'
    : '';
  return '\n\nSOURCE ARTIFACT CONTEXT — OPTIONAL LENS\n'
    + 'Use the shared general analytical method. This artifact lens is a starting context hint, never a replacement for the actual goal or accepted conversation context.\n'
    + domain + '\n'
    + 'Inspect material records and relationships with real locators for consequential claims; read coverage is internal work, not a prescribed response length. Distinguish what the source says from what its presentation makes visible. For changes to wording, selection, order or form, identify the actual current state and incremental destination; give usable wording when useful. Reading an authoring skill or its polish checklist does not establish a visual defect in this source. A viable legible artifact needs no style change without a supported benefit to its use. Marketing may emphasize supportable strengths and omit irrelevant internal caveats; an unspecified detail or lack of independent corroboration alone need not weaken a legitimate pitch. Explain inaccessible material only where it matters.\n'
    + plan + '\n';
}

/**
 * Enforces inspect → interpret → synthesize → audit → deliver structure.
 * A step title or evidence string does not prove understanding; incomplete
 * recorded work must not masquerade as a fully audited plan.
 */
export function validateDocumentAnalysisOutline(planned, { contract, previous = {}, mode = 'on' } = {}) {
  if (!contract?.enforcePlan || mode === 'off') return planned;
  if (contract.planningArchitecture === 'adaptive-tradecraft') {
    const actions=(planned?.steps||[]).filter(step=>(step.kind||'action')==='action');
    const previousActions=(previous?.steps||[]).filter(step=>(step.kind||'action')==='action');
    // First outline is prospective. Later plan revisions may choose and repeat
    // methods in any evidence-driven order; fixed analytic lanes are not required.
    if (contract.requiresJudgments && previousActions.length===0
      && actions.some(step=>['done','skipped'].includes(step.status)))
      throw fail('Record the provisional outline first; examine the actual material and then revise the plan before completing work.');
    // An optional argument record may cite ordinary source locators or explicit
    // step:<id> references. Check only the latter's actual saved relationship;
    // this is traceability, not certification of an inference or a new stage.
    const prior = new Map(previousActions.map(step => [step.id, step]));
    const issueKey = issue => JSON.stringify([issue.stepId, issue.judgmentId, issue.sourceId, issue.kind]);
    const priorErrors = new Set(inspectJudgmentTraceability(previousActions).referenceErrors.map(issueKey));
    const errors = inspectJudgmentTraceability(actions).referenceErrors.filter(issue => {
      const step = actions.find(row => row.id === issue.stepId), old = prior.get(issue.stepId);
      return old?.status !== 'done' || old.evidence !== step.evidence || !priorErrors.has(issueKey(issue));
    });
    if (errors.length) {
      const issue = errors[0];
      throw fail('The recorded judgment ' + issue.judgmentId + ' in ' + issue.stepId
        + ' cites step:' + issue.sourceId + ' (' + issue.kind + '). Cite an actual completed source action or an ordinary source locator.');
    }
    // No semantic claims are inferred from arbitrary text labels or status.
    return planned;
  }
  const steps = (planned?.steps || []).filter(step => (step.kind || 'action') === 'action');
  const earlier = previous?.steps || [];
  // Historical plans are evidence of what actually happened; do not retroactively
  // make a completed pre-policy conversation impossible to maintain.
  if (earlier.length && !earlier.some(step => DOCUMENT_ANALYSIS_STAGES.some(stage => stage.stepType === step.stepType))
    && !steps.some(step => DOCUMENT_ANALYSIS_STAGES.some(stage => stage.stepType === step.stepType))) return planned;
  // Record the proposed analysis before declaring any part complete.
  // This guarantees at least one source-informed revision between the first
  // outline and a finished interpretive assessment.
  if (contract.requiresJudgments && earlier.length === 0 && steps.some(step => ['done', 'skipped'].includes(step.status)))
    throw fail('Save the first analytical outline with pending steps. Inspect the source, then revise that plan with actual evidence before marking stages done.');
  const indices = new Map();
  for (const stage of DOCUMENT_ANALYSIS_STAGES) {
    const matches = steps.map((step, i) => ({ step, i })).filter(({step}) => step.stepType === stage.stepType);
    if (!matches.length) throw fail('Dense document analysis needs a "' + stage.stepType + '" action (' + stage.label + '). Plan source coverage, interpretation, cross-analysis, evidence audit and delivery.');
    indices.set(stage.stepType, matches);
  }
  const ordering = DOCUMENT_ANALYSIS_STAGES.map(stage => indices.get(stage.stepType)[0].i);
  if (ordering.some((v,i) => i && v < ordering[i-1])) throw fail('Use evidence order: inventory, unit analysis, cross-analysis, evidence audit, delivery.');
  const inventoryDone = indices.get('source_inventory').some(({step})=>step.status==='done');
  const unit = indices.get('unit_analysis');
  if (inventoryDone && contract.type === 'resume' && contract.dense && unit.length < 2) throw fail('The resume inventory is complete, but analysis still has only one unit-level action. Split it into separately evidenced role/section interpretations before claiming coverage.');
  if (unit.some(({step})=>step.status==='done' && !hasLocator(step.evidence)))
    throw fail('A completed record analysis needs an actual source locator (page, line, role, or section) in its evidence. Generic "reviewed" statements cannot satisfy it.');
  for (const type of ['source_inventory', 'cross_analysis', 'evidence_audit']) {
    if (indices.get(type).some(({step}) => step.status === 'done' && !hasLocator(step.evidence)
      && !(contract.requiresJudgments && type === 'cross_analysis' && /^Sources:\s*\S+/im.test(step.evidence || ''))))
      throw fail('A completed ' + type + ' step needs evidence anchored to an actual page, line, role or section. A generic completion assertion is insufficient.');
  }
  const allUnitsDone = unit.every(({step}) => step.status==='done');
  const synthesisDone = indices.get('cross_analysis').every(({step})=>step.status==='done');
  const auditDone = indices.get('evidence_audit').every(({step})=>step.status==='done');
  if (indices.get('cross_analysis').some(({step})=>step.status==='done') && !allUnitsDone)
    throw fail('Do not complete cross-document synthesis before all source-level analysis actions are done.');
  if (indices.get('evidence_audit').some(({step})=>step.status==='done') && (!allUnitsDone || !synthesisDone))
    throw fail('The evidence audit cannot finish before record-level interpretation and cross-record synthesis.');
  if (indices.get('delivery').some(({step})=>step.status==='done') && !auditDone)
    throw fail('Delivery cannot be marked done until the evidence audit is complete. Correct unsupported generalities and verify coverage.');
  if (contract.requiresJudgments) {
    const priorById = new Map(earlier.map(step => [step.id, step]));
    const unchangedCompletion = step => {
      const old = priorById.get(step.id);
      return old?.status === 'done' && step.status === 'done'
        && old.evidence === step.evidence && old.doneWhen === step.doneWhen
        && old.result === step.result && old.title === step.title;
    };
    const allJudgments = new Set();
    for (const { step } of indices.get('cross_analysis')) {
      if (step.status !== 'done') continue;
      // Validate completed synthesis in the current saved plan even when it
      // was authored in an earlier revision. A later audit should not have to
      // rewrite previously verified judgments to see them.
      const ledger = validateJudgmentLedger(step.evidence, unit.map(x => x.step),
        { required: contract.type === 'resume' && unit.length >= 5 ? 3 : 2 });
      if (!ledger.valid) {
        if (!unchangedCompletion(step))
          throw fail('Cross-analysis is not yet a defensible argument: ' + ledger.errors.slice(0, 4).join(' | '));
        // Preserve genuinely historical records. New audits still cannot
        // claim completion without valid, traceable source-linked judgments.
        continue;
      }
      for (const id of ledger.ids) allJudgments.add(id);
    }
    // Audits and deliveries reference the valid current saved synthesis,
    // regardless of which previous plan revision recorded it.
    for (const { step } of indices.get('evidence_audit')) {
      if (step.status !== 'done' || unchangedCompletion(step)) continue;
      if (!allJudgments.size) throw fail('Audit a current source-linked argument ledger before completing the evidence audit.');
      const result = validateJudgmentAudit(step.evidence, [...allJudgments]);
      if (!result.valid) throw fail('Evidence audit has not challenged the synthesized judgments: ' + result.errors.join(' | '));
    }
    for (const { step } of indices.get('delivery')) {
      if (step.status !== 'done' || unchangedCompletion(step)) continue;
      if (!allJudgments.size) throw fail('Complete the current source-linked argument ledger before delivery.');
      const result = validateJudgmentDelivery(step.evidence, [...allJudgments]);
      if (!result.valid) throw fail('Delivery must reference the synthesized judgments ' + result.missing.join(', ') + ' in its completion evidence.');
    }
  }
  return planned;
}
