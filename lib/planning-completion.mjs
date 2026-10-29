import { createHash } from 'node:crypto';
import { planningReviewStatus, planningReviewSignature } from './planning-review.mjs';
import { planningSequenceStatus } from './planning-sequence.mjs';

const fail = (message, code) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Task stopped.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The completion boundary records a return to Planning, not private thinking.
 * A compliant turn reviews naturally. A premature final is a candidate only;
 * the same runtime session continues without replaying any operation. */
export function createPlanningCompletionController({
  store, taskId, runId, nodeId, scopeStepId = null, signal,
  getContext = () => null, hasPlan = () => true, beforeCheck = async () => {},
  getContinuationContext,
  onState = () => {}, onUpdate = () => {}, onReturn = () => {},
  maxReturns = 4,
}) {
  let returns = 0, previousUnmetSignature = null;
  const inspect = async () => {
    check(signal);
    await beforeCheck();
    check(signal);
    return store.enqueue(taskId, async () => {
      const state = await store.get(taskId, { signal });
      onState(state);
      const context = getContext();
      const review = planningReviewStatus(state, { runId, nodeId, scopeStepId, context });
      const sequence = await planningSequenceStatus(store, taskId, state, { scopeStepId });
      check(signal);
      // A new accepted direction while reading the dispatch journal cannot borrow
      // a review of the previous request.
      const current = hash(context) === hash(getContext());
      const running = sequence.running?.length > 0;
      const unreported = sequence.unreported?.length > 0;
      const uncertain = sequence.uncertain?.length > 0;
      const sequenceCurrent = review.review?.sequenceSignature === sequence.signature;
      const recorded = hasPlan();
      const ready = recorded && review.ready && current && sequenceCurrent && !running && !unreported
        && (!uncertain || review.decision === 'blocked');
      const reason = !recorded ? 'No prospective plan was recorded for this turn.'
        : running ? 'A planned operation is still running.'
        : unreported ? 'The latest dispatched operation has no saved outcome.'
        : !current ? 'An accepted user direction changed during final reassessment.'
        : review.review && !sequenceCurrent ? 'The dispatched work changed after the saved review.'
        : uncertain && review.decision !== 'blocked' ? 'An interrupted operation still has an uncertain effect.'
        : review.reason;
      return { state, context, review, ready, reason, sequence,
        signature: hash({ plan: planningReviewSignature(state, scopeStepId), context: getContext(),
          sequence: sequence.signature, recorded, review: review.review || null }) };
    }, signal);
  };
  const publish = (status, reviewStatus) => onUpdate({
    reviewStatus, returnCount: returns,
    ...(status.review.review ? { review: {
      decision: status.review.review.decision, summary: status.review.review.summary,
      reviewedRevision: status.review.review.reviewedRevision,
      at: status.review.review.at,
      ...(status.review.review.nextStepId ? { nextStepId: status.review.review.nextStepId } : {}),
    } } : {}),
    ...(!status.ready ? { reviewReason: status.reason } : { reviewReason: null }),
  });
  return {
    async beforeFinal() {
      const status = await inspect();
      if (status.ready) { publish(status, 'current'); return null; }
      onReturn();
      if (returns >= maxReturns || previousUnmetSignature === status.signature) {
        publish(status, 'stalled');
        throw fail('The agent repeatedly attempted to finish without completing the required return to Planning. Its candidate answers remain unpublished; saved work and actual tool results are preserved. ' + status.reason, 'TASK_PLAN_REASSESSMENT_STALLED');
      }
      previousUnmetSignature = status.signature;
      returns++;
      publish(status, 'continuing');
      const currentContext = getContinuationContext?.();
      let deliveredContext = currentContext === undefined ? '' : JSON.stringify(currentContext);
      if (deliveredContext.length > 40000) deliveredContext = deliveredContext.slice(0, 20000)
        + '\n[Accepted user context excerpt: middle omitted]\n' + deliveredContext.slice(-20000);
      const prompt = [
        'RETURN TO PLANNING BEFORE THE FINAL RESPONSE',
        'Your preceding answer is an unpublished candidate. Continue this same accepted task; do not start a new task, ask the user to continue, or repeat completed operations.',
        status.reason,
        'Call relay_task read for the current revision. Reconcile the last reasoning or tool leaf with its actual finding and limits. A status update alone is not reassessment of the remaining plan.',
        'Decide what the finding means for the requested outcome. IF more work is needed, save the smallest next substeps or use revisit on the earlier affected step, then execute one eligible leaf and reassess again. ELIF work is blocked, preserve the actual blocker and useful partial result. ELSE record why the result and consequential checks are sufficient.',
        'Use relay_task action:"review", expectedRevision:<current revision>, review:{decision:"continue"|"respond"|"blocked",summary:"concise findings, remaining gaps and why this next action is appropriate",nextStepId:"required only when continuing"}. Use describe for the exact schema. A respond review requires completed selected work; blocked must report the real unresolved work. Do not invent a change or reversal when the existing plan is sound.',
        'After a fresh respond or blocked review, compose the final answer from the recorded findings. Final composition may think again; do not expose private reasoning. Any further work, revised facts, plan change or accepted user direction requires another review before finishing.',
        ...(deliveredContext ? ['CURRENT ACCEPTED USER CONTEXT (host supplied; preserve these actual directions):\n' + deliveredContext] : []),
      ].join('\n\n');
      return { continue: true, prompt };
    },
    async assertReady() {
      const status = await inspect();
      if (!status.ready) {
        publish(status, status.review.current ? 'required' : 'stale');
        throw fail('The final response has no current post-work Planning reassessment. Its answer was withheld. ' + status.reason, 'TASK_PLAN_REASSESSMENT_REQUIRED');
      }
      publish(status, 'current');
      return status;
    },
  };
}
