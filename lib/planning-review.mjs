import { createHash } from 'node:crypto';
import { taskPlanAvailability, taskPlanProgress } from './task-plan.mjs';
import { planningRelevance } from './planning-awareness.mjs';

export const PLANNING_REVIEW_LIMITS = Object.freeze({ history: 16, historyChars: 12000, summary: 1200, outcomes: 32 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code = 'INVALID_PLANNING_REVIEW', status = 400) => Object.assign(new Error(message), { code, status });
const present = value => typeof value === 'string' && value.trim().length > 0;
const scopeOf = value => value || null;

export function normalizePlanningReview(value) {
  if (!object(value) || Object.keys(value).some(key => !['decision', 'summary', 'nextStepId'].includes(key))
    || !['continue', 'respond', 'blocked'].includes(value.decision)
    || !present(value.summary) || value.summary.length > PLANNING_REVIEW_LIMITS.summary || value.summary.includes('\0'))
    throw fail('Review needs decision continue, respond or blocked and a concise nonempty summary of actual findings, remaining work and limits. Record outcomes and next actions, not private reasoning.');
  if (value.decision === 'continue' ? !id(value.nextStepId) : value.nextStepId !== undefined)
    throw fail('A continue review needs one saved nextStepId; respond and blocked reviews omit nextStepId.', 'TASK_PLAN_REVIEW_NEXT_REQUIRED');
  return { decision: value.decision, summary: value.summary.trim(), ...(value.nextStepId ? { nextStepId: value.nextStepId } : {}) };
}

// No clocks, revision counters, review records, or derived UI projections enter
// this fingerprint. Saving a review cannot invalidate itself. A sibling worker
// may progress independently, but changed prerequisites still invalidate it.
export function planningReviewSignature(state, scopeStepId = null) {
  const relevance = planningRelevance(state, scopeStepId), relevantIds = new Set(relevance.stepIds);
  const artifactIds = new Set((state.steps || []).filter(step => relevantIds.has(step.id)).flatMap(step => step.artifactIds || []));
  const ownerId = Object.entries(state.execution?.nodes || {}).find(([, binding]) => binding.scopeStepId === scopeStepId)?.[0];
  const artifacts = (state.artifacts || []).filter(artifact => !scopeStepId || artifactIds.has(artifact.id) || ownerId && artifact.provenance?.nodeId === ownerId);
  const execution = Object.entries(state.execution?.nodes || {}).filter(([, binding]) => relevantIds.has(binding.scopeStepId))
    .filter(([, binding]) => binding.scopeStepId !== scopeStepId)
    .filter(([nodeId]) => scopeStepId || nodeId !== state.execution?.coordinatorNodeId)
    .map(([nodeId, binding]) => ({ nodeId, scopeStepId: binding.scopeStepId, status: binding.status, runId: state.execution.runId }));
  const { authoredBy, origin, ...plan } = state.plan || {};
  return hash({ relevance: relevance.signature, plan, artifacts, execution,
    ...(!scopeStepId ? { externalActions: state.externalActions || [], externalRecovery: state.externalRecovery || null } : {}) });
}

export const planningReviewContextSignature = context => hash(context ?? null);

function reviewWork(state, scopeStepId) {
  const relevance = planningRelevance(state, scopeStepId), owned = new Set(relevance.ownStepIds);
  if (scopeStepId && !state.steps.some(step => step.id === scopeStepId)) throw fail('The review assignment no longer exists. Read the current shared plan.', 'TASK_PLAN_OWNERSHIP', 403);
  const progress = taskPlanProgress(state), selected = new Set(progress.eligible || []), unresolved = new Set(progress.awaitingChoice || []);
  const available = taskPlanAvailability(state);
  const actions = state.steps.filter(step => (step.kind || 'action') === 'action' && owned.has(step.id));
  return { owned, available, actions, selected: actions.filter(step => selected.has(step.id)),
    unresolved: actions.filter(step => unresolved.has(step.id)),
    ready: actions.filter(step => ['ready', 'active'].includes(available.byId[step.id]?.state)) };
}

export function validatePlanningReviewDecision(state, review, { scopeStepId = null } = {}) {
  const work = reviewWork(state, scopeStepId);
  if (review.decision === 'continue') {
    if (!work.ready.some(step => step.id === review.nextStepId))
      throw fail('Continue needs an owned, eligible saved action that is ready or active. Refine or revisit the remaining work first, then name that next leaf.', 'TASK_PLAN_REVIEW_NEXT_REQUIRED', 409);
  } else if (review.decision === 'respond') {
    if (!work.selected.some(step => step.status === 'done') || work.unresolved.length
      || work.selected.some(step => !['done', 'skipped'].includes(step.status)
        || work.available.byId[step.id]?.prerequisites.some(prerequisite => !prerequisite.satisfied)))
      throw fail('The selected work is not complete. Record actual outcomes, resolve remaining branches, and finish or explicitly dispose of affected work before reviewing for a final response. Use continue for another saved leaf or blocked for an actual obstacle.', 'TASK_PLAN_REVIEW_INCOMPLETE', 409);
  } else {
    if (work.ready.length || !work.selected.some(step => step.status === 'blocked' && present(step.blockedReason)))
      throw fail('A blocked review needs an actual saved blocker and no owned ready or active work. Record the obstacle honestly and continue available work before stopping.', 'TASK_PLAN_REVIEW_NOT_BLOCKED', 409);
  }
  return work;
}

// Runtime-stamped evidence that this actor reported an outcome after a saved
// prospective leaf. One latest marker per actor survives rolling plan history;
// creating a blocked initial outline or republishing old done work is not work.
export function recordPlanningOutcome(previous, next, { runId, nodeId, scopeStepId = null, schemaVersion, source = 'agent', revision = previous.revision + 1 } = {}) {
  if (!(schemaVersion >= 10) || source !== 'agent' || !id(runId) || !id(nodeId)) return next;
  const owned = new Set(planningRelevance(next, scopeStepId).ownStepIds), prior = new Map(previous.steps.map(step => [step.id, step]));
  const reported = next.steps.find(step => {
    const old = prior.get(step.id);
    return old && owned.has(step.id) && (step.kind || 'action') === 'action'
      && (step.status === 'done' && present(step.evidence) || step.status === 'blocked' && present(step.blockedReason))
      && (old.status !== step.status || old.evidence !== step.evidence || old.blockedReason !== step.blockedReason || (old.attempt || 1) !== (step.attempt || 1));
  });
  if (!reported) return next;
  const outcome = { runId, nodeId, scopeStepId: scopeOf(scopeStepId), stepId: reported.id, attempt: reported.attempt || 1,
    status: reported.status, revision };
  return { ...next, planningOutcomes: [...(previous.planningOutcomes || []).filter(item => item.runId !== runId || item.nodeId !== nodeId || item.scopeStepId !== outcome.scopeStepId), outcome].slice(-PLANNING_REVIEW_LIMITS.outcomes) };
}

export function appendPlanningReview(state, value, { runId, nodeId, scopeStepId = null, context = null, sequenceSignature, executionGuardrails = false } = {}) {
  if (!id(runId) || !id(nodeId)) throw fail('A review requires the current runtime run and node identity.', 'TASK_PLAN_OWNERSHIP', 403);
  const review = normalizePlanningReview(value), scope = scopeOf(scopeStepId);
  const owned = new Set(planningRelevance(state, scope).ownStepIds);
  const reported = (state.planningOutcomes || []).some(item => item.runId === runId && (item.nodeId === nodeId && item.scopeStepId === scope
    || nodeId === state.execution?.coordinatorNodeId && state.execution?.runId === runId && owned.has(item.stepId)
      && ['completed', 'failed', 'cancelled'].includes(state.execution.nodes[item.nodeId]?.status)));
  if (executionGuardrails === true && !reported)
    throw fail('First perform a saved current-turn reasoning or tool leaf and record its actual finding or blocker. An initial plan or a status-only read cannot substitute for returning to planning after work.', 'TASK_PLAN_REASSESSMENT_REQUIRED', 409);
  if (executionGuardrails === true) validatePlanningReviewDecision(state, review, { scopeStepId: scope });
  const entry = { ...review, runId, nodeId, scopeStepId: scope, reviewedRevision: state.revision, at: new Date().toISOString(),
    signature: planningReviewSignature(state, scope), contextSignature: planningReviewContextSignature(context), sequenceSignature };
  const history = [...(state.planningReviews || []), entry].slice(-PLANNING_REVIEW_LIMITS.history);
  while (history.length > 1 && JSON.stringify(history).length > PLANNING_REVIEW_LIMITS.historyChars) history.shift();
  return { ...state, planningReviews: history };
}

export function planningReviewStatus(state, { runId, nodeId, scopeStepId = null, context = null } = {}) {
  const review = (state.planningReviews || []).findLast(item => item.runId === runId && item.nodeId === nodeId && item.scopeStepId === scopeOf(scopeStepId));
  const missing = reason => ({ current: false, ready: false, ...(review ? { review, decision: review.decision } : {}), code: 'TASK_PLAN_REASSESSMENT_REQUIRED', reason });
  if (!review) return missing('Return to planning after the actual work and save a review before the final response.');
  if (review.signature !== planningReviewSignature(state, scopeStepId) || review.contextSignature !== planningReviewContextSignature(context))
    return missing('The work, observations or accepted direction changed after the saved review. Reassess the current plan before responding.');
  try { validatePlanningReviewDecision(state, review, { scopeStepId }); }
  catch (error) { return { current: false, ready: false, review, decision: review.decision, reason: error.message, code: error.code }; }
  return { current: true, ready: ['respond', 'blocked'].includes(review.decision), review, decision: review.decision,
    ...(review.decision === 'continue' ? { code: 'TASK_PLAN_REASSESSMENT_REQUIRED', reason: `Continue the saved next leaf ${review.nextStepId}, then return to planning before responding.` } : { reason: '' }) };
}

/** Old summaries are optional bounded history. Compact them against the actual
 * task budget before they crowd out a required current review or new work.
 * Earlier complete task revisions still retain their original records. */
export function compactPlanningReviewRecords(state, maxChars, { keepLatestReview = false } = {}) {
  if (!state.planningReviews?.length && !state.planningOutcomes?.length) return state;
  const next = { ...state, ...(state.planningReviews ? { planningReviews: [...state.planningReviews] } : {}),
    ...(state.planningOutcomes ? { planningOutcomes: [...state.planningOutcomes] } : {}) };
  const large = () => JSON.stringify(next).length > maxChars;
  while (large() && next.planningReviews?.length > (keepLatestReview ? 1 : 0)) next.planningReviews.shift();
  if (next.planningReviews && !next.planningReviews.length) delete next.planningReviews;
  while (large() && next.planningOutcomes?.length > 1) next.planningOutcomes.shift();
  return next;
}

export function validateSavedPlanningReviews(state) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const revision = value => Number.isSafeInteger(value) && value > 0;
  if (state.planningReviews !== undefined && (!Array.isArray(state.planningReviews) || state.planningReviews.length > PLANNING_REVIEW_LIMITS.history || JSON.stringify(state.planningReviews).length > PLANNING_REVIEW_LIMITS.historyChars
    || state.planningReviews.some(item => {
      if (!object(item) || Object.keys(item).some(key => !['decision', 'summary', 'nextStepId', 'runId', 'nodeId', 'scopeStepId', 'reviewedRevision', 'at', 'signature', 'contextSignature', 'sequenceSignature'].includes(key))) return true;
      try { normalizePlanningReview({ decision: item.decision, summary: item.summary, ...(item.nextStepId === undefined ? {} : { nextStepId: item.nextStepId }) }); } catch { return true; }
      return !id(item.runId) || !id(item.nodeId) || item.scopeStepId !== null && !id(item.scopeStepId) || !revision(item.reviewedRevision)
        || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || new Date(item.at).toISOString() !== item.at
        || !digest(item.signature) || !digest(item.contextSignature) || !digest(item.sequenceSignature);
    }))) throw fail('Saved planning reviews are damaged. Existing task files were preserved.', 'TASK_STATE_DAMAGED', 500);
  if (state.planningOutcomes !== undefined && (!Array.isArray(state.planningOutcomes) || state.planningOutcomes.length > PLANNING_REVIEW_LIMITS.outcomes
    || state.planningOutcomes.some(item => !object(item) || Object.keys(item).some(key => !['runId', 'nodeId', 'scopeStepId', 'stepId', 'attempt', 'status', 'revision'].includes(key))
      || !id(item.runId) || !id(item.nodeId) || item.scopeStepId !== null && !id(item.scopeStepId) || !id(item.stepId) || !revision(item.attempt) || !revision(item.revision) || !['done', 'blocked'].includes(item.status))))
    throw fail('Saved planning outcome identities are damaged. Existing task files were preserved.', 'TASK_STATE_DAMAGED', 500);
}
