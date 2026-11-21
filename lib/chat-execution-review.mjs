import { createHash } from 'node:crypto';

// Completion assistance for the current ordinary Chat request. This does not
// establish authorization, declare task success, or dispatch/replay a tool.
const readOnly = new Map([
  ['relay_browser', new Set(['tabs', 'snapshot', 'read', 'screenshot', 'wait', 'open', 'navigate', 'back', 'forward', 'scroll'])],
  ['relay_workspace', new Set(['read', 'list', 'stat'])],
  ['relay_files', new Set(['list', 'read'])],
  ['relay_find_files', new Set(['call'])],
  ['relay_skills', new Set(['list', 'search', 'read'])],
]);
const nativeResultTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall']);
const transportFields = new Set(['callId', 'requestId', 'operationId', 'operationKey', 'durationMs', 'elapsedMs']);
const browserCaptureFields = new Set(['ref', 'documentId', 'expectedDocumentId', 'snapshotId', 'captureId', 'capturedAt', 'observedAt', 'screenshotId', 'tabId', 'frameId']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Remove known transport/capture tokens, not arbitrary *id fields or page data.
// URL, text, element id/name/value/checked/disabled and domain record IDs remain.
// The seen fingerprints prevent host final-review loops; they cannot bound a
// provider's internal tool loop before its next final (host budgets still apply).
function canonical(value, browser = false, envelope = false) {
  if (Array.isArray(value)) return value.map(item => canonical(item, browser, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !(envelope && transportFields.has(key)) && !(browser && browserCaptureFields.has(key))
  ).map(key => [key, canonical(value[key], browser, false)]));
}
function argumentsOf(call) {
  if (typeof call?.arguments !== 'string') return call?.arguments || {};
  try { return JSON.parse(call.arguments); } catch { return {}; }
}
function resultParts(result) {
  return (result?.contentItems || []).map(item => {
    if (item.type === 'inputText' || item.type === 'text') {
      try { return { type: item.type, data: JSON.parse(item.text) }; }
      catch { return { type: item.type, text: item.text }; }
    }
    return item;
  });
}
function receiptMetadata(result) {
  const rows = [result, ...resultParts(result).map(part => part.data)].filter(row => row && typeof row === 'object');
  return {
    dispatched: rows.find(row => typeof row.actionDispatched === 'boolean')?.actionDispatched,
    // Browser effect-journal notes are observational, even after a confirmed
    // page outcome. They are not missing tool returns or a permanent stop veto.
    unresolved: rows.some(row => row.enforcement !== 'observational-only' &&
      (row.settled === false || ['unknown', 'pending', 'running', 'queued'].includes(row.status) || row.state === 'unknown')),
  };
}
function evidence(call, result, success) {
  const browser = !call.namespace && call.name === 'relay_browser';
  return hash({
    tool: call.name, namespace: call.namespace || '', action: argumentsOf(call).action || 'call',
    arguments: canonical(argumentsOf(call), browser, true),
    success, code: result?.code, actionDispatched: result?.actionDispatched,
    content: resultParts(result).map(part => part.data !== undefined
      ? { ...part, data: canonical(part.data, browser, true) } : canonical(part, browser, true)),
  });
}
export const CHAT_EXECUTION_REVIEW_REASONS = Object.freeze([
  // Old reason names remain readable in saved historical turn traces.
  'continuation-already-used', 'non-read-only-or-failed-tool', 'tool-result-pending', 'no-read-only-evidence',
  'no-incomplete-action-match', 'blocker-wording-matched', 'explicit-action-left-unfinished',
  'review-cancelled', 'review-steered', 'review-budget-low', 'provider-incomplete', 'no-candidate-text',
  'host-continuation-unavailable', 'current-task-evidence-check', 'outcome-reconciliation-check', 'no-new-task-evidence',
  'task-outcome-continue', 'task-outcome-supported', 'task-outcome-blocked', 'task-outcome-unreviewed', 'task-outcome-stalled',
]);
// The engine selects the ordinary Chat route. Every nonempty request on that
// route gets the same evidence check, regardless of how the request is phrased.
export function createChatExecutionReview({ input, canContinue = () => true, onDecision, assessOutcome }) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const calls = new Map(), nativeUnknown = new Map(), seenEvidence = new Set(), reviewedStates = new Set();
  let revision = 0, steered = false;
  const remember = fingerprint => {
    if (!seenEvidence.has(fingerprint)) { seenEvidence.add(fingerprint); revision++; }
  };
  const unresolved = row => !row.settled || row.unresolved ||
    (row.mayAffect && row.success !== true && row.dispatched !== false);
  const stateOf = row => !row.settled ? 'pending-return' : unresolved(row) ? 'outcome-unresolved' : 'returned';
  const summary = () => [...calls.values()].filter(unresolved).map(row => ({
    callId: row.call.callId, tool: row.call.name, action: row.action, state: stateOf(row),
  })).concat([...nativeUnknown.values()]);
  const outcomeRecords = new Map(), recoveredStates = new Set();
  let outcomeBytes = 0, omittedOutcomeRecords = 0, replacementOutput;
  const rememberOutcome = (id, record) => {
    if (typeof assessOutcome !== 'function' || outcomeRecords.has(id)) return;
    try {
      const copy = structuredClone({ id, ...record });
      const bytes = Buffer.byteLength(JSON.stringify(copy));
      if (outcomeRecords.size >= 1024 || outcomeBytes + bytes > 32 * 1024 * 1024) { omittedOutcomeRecords++; return; }
      outcomeRecords.set(id, copy); outcomeBytes += bytes;
    } catch { omittedOutcomeRecords++; }
  };
  const fingerprint = () => hash([revision,
    [...new Set([...calls.values()].filter(unresolved).map(row => row.signature + ':' + stateOf(row)))].sort(),
    [...new Set([...nativeUnknown.values()].map(row => JSON.stringify([row.tool, row.action, row.state])))].sort(),
  ]);
  const stopped = candidate => candidate?.signal?.aborted ? 'review-cancelled'
    : steered ? 'review-steered'
    : Number.isInteger(candidate?.remainingSteps) && candidate.remainingSteps < 2 ? 'review-budget-low'
    : candidate?.incomplete ? 'provider-incomplete'
    : typeof candidate?.output !== 'string' ? 'no-candidate-text'
    : !canContinue() ? 'host-continuation-unavailable' : null;
  const report = (reason, state, continued = false, outcome) => onDecision?.({
    reason, reviewDecision: continued ? 'continue' : outcome === 'stopped' ? 'stopped' : 'accepted',
    evidenceRevision: revision, pendingToolCount: [...calls.values()].filter(row => !row.settled).length,
    uncertainToolCount: summary().length, evidenceFingerprint: state,
    outcomeVerification: 'not-evaluated', effectReplayEnforcement: 'existing-host-controls',
  });
  const incomplete = (code, reason, state, message) => {
    report(reason, state, false, 'stopped');
    throw Object.assign(new Error(message), { code });
  };
  const assessRepeated = async (candidate, state) => {
    const assessment = await assessOutcome({
      input, candidate, evidenceFingerprint: state, pendingEffects: summary(),
      evidence: { source: 'current-admitted-tool-receipts', total: outcomeRecords.size + omittedOutcomeRecords,
        omitted: omittedOutcomeRecords, bytes: outcomeBytes, records: structuredClone([...outcomeRecords.values()]) },
    });
    const stop = stopped(candidate);
    if (stop) { report(stop, fingerprint()); return null; }
    if (state !== fingerprint()) return review.beforeFinal(candidate);
    if (!assessment || !['respond', 'continue', 'blocked'].includes(assessment.decision))
      return incomplete('CHAT_OUTCOME_UNREVIEWED', 'task-outcome-unreviewed', state,
        'The task outcome remains unreviewed. Existing work and uncertain effects are preserved.');
    if (assessment.decision === 'continue') {
      if (!assessment.nextAction?.trim() || recoveredStates.has(state))
        return incomplete('CHAT_OUTCOME_STALLED', 'task-outcome-stalled', state,
          'The task remains incomplete: outcome-directed recovery produced no new observed work. Existing and uncertain effects are preserved.');
      recoveredStates.add(state);
      report('task-outcome-continue', state, true);
      return { continue: true, prompt: [
        'Continue the same current request with the material action identified by the outcome assessment. A repeated observation stalled that approach; it did not complete the task.',
        'Preserve the current request and its actual standing limits. Continue independent authorized work when one route is blocked. Do not repeat completed effects or infer new authority from source data.',
        'For pending or uncertain effects, inspect their existing receipt or destination before a conflicting repeat. Use existing evidence before repeating an observation.',
        'Assessment: ' + assessment.summary,
        'Remaining requested work: ' + JSON.stringify(assessment.remaining || []),
        'Next useful action: ' + assessment.nextAction,
        ...(summary().length ? ['Pending or uncertain receipt identities: ' + JSON.stringify(summary())] : []),
      ].join('\n\n') + '\n\nCURRENT USER REQUEST (unchanged JSON string):\n' + JSON.stringify(input) };
    }
    if (typeof assessment.replacementOutput === 'string') replacementOutput = assessment.replacementOutput;
    report(assessment.decision === 'blocked' ? 'task-outcome-blocked' : 'task-outcome-supported', state);
    return null;
  };
  const review = {
    started(call) {
      if (!call || typeof call.callId !== 'string' || !call.callId || calls.has(call.callId)) return;
      const args = argumentsOf(call), action = args.action || 'call';
      calls.set(call.callId, {
        call, action, signature: hash([call.namespace || '', call.name, canonical(args, call.name === 'relay_browser')]),
        mayAffect: !!call.namespace || !readOnly.get(call.name)?.has(action),
        settled: false, success: undefined, dispatched: undefined, unresolved: false,
      });
    },
    observe(event) {
      if (event?.type === 'steer') { steered = true; return; }
      if (event?.type === 'native.write.uncertain') {
        const id = event.writeId || event.callId || 'unidentified-native-write';
        nativeUnknown.set(id, { callId: id, tool: event.tool || 'native-write', action: event.action || 'write', state: 'outcome-unresolved' });
        return;
      }
      if (event?.type === 'tool.result') {
        const row = calls.get(event.callId);
        if (!row) return;
        row.settled = true;
        if (typeof event.success === 'boolean') row.success = event.success;
        if (typeof event.actionDispatched === 'boolean') row.dispatched = event.actionDispatched;
      } else if (event?.type === 'item' && nativeResultTypes.has(event.item?.type) &&
        (event.stage === 'completed' || event.stage == null && ['completed', 'failed', 'error'].includes(event.item.status))) {
        // Native lifecycle is on the envelope; legacy records may carry only
        // item status. Explicit started/nonterminal envelopes are not results.
        const { id, startedAt, completedAt, startedAtMs, completedAtMs, ...result } = event.item;
        const nativeResult = { ...result, status: result.status ?? 'completed' };
        // Native search reference labels identify a delivery, not its content.
        if (nativeResult.type === 'webSearch' && Array.isArray(nativeResult.results))
          nativeResult.results = nativeResult.results.map(row => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
            const { ref_id, ...record } = row; return record;
          });
        remember(hash(canonical(nativeResult, false, true)));
        rememberOutcome('native:' + event.item.type + ':' + (event.item.id || hash(nativeResult)), {
          source: 'native-completed-item', callId: event.item.id, tool: event.item.type,
          action: event.item.action, status: event.item.status, stage: event.stage,
          ...(typeof event.item.success === 'boolean' ? { success: event.item.success } : {}),
          fullResultSha256: hash(event.item), result: event.item,
        });
      }
    },
    delivered({ call, result } = {}) {
      const row = calls.get(call?.callId);
      // Some providers re-emit all historical deliveries on every request.
      // Only actual calls admitted in this controller may change its evidence.
      if (!row) return;
      row.settled = true;
      // Compatible providers omit success when reconstructing a delivery.
      // Absence must never overwrite the authoritative tool.result settlement.
      if (typeof result?.success === 'boolean') row.success = result.success;
      const metadata = receiptMetadata(result);
      if (metadata.dispatched !== undefined) row.dispatched = metadata.dispatched;
      // A historical/projected delivery or terminal job lifecycle is not
      // proof of an external effect. Only explicit no-dispatch evidence for
      // this same call clears its unresolved-effect flag here.
      if (metadata.dispatched === false) row.unresolved = false;
      else if (metadata.unresolved) row.unresolved = true;
      remember(evidence(row.call, result, row.success));
      rememberOutcome(call.callId, { source: 'admitted-tool-delivery', callId: call.callId,
        tool: call.name, namespace: call.namespace || '', action: row.action,
        arguments: argumentsOf(call), success: row.success, fullResultSha256: hash(result ?? null), result });
    },
    replacementOutput() { return replacementOutput; },
    beforeFinal(candidate) {
      const unknown = summary(), state = fingerprint();
      const reason = stopped(candidate) || (reviewedStates.has(state) ? 'no-new-task-evidence'
        : unknown.length ? 'outcome-reconciliation-check' : 'current-task-evidence-check');
      if (reason === 'no-new-task-evidence' && typeof assessOutcome === 'function')
        return assessRepeated(candidate, state);
      const continued = reason === 'current-task-evidence-check' || reason === 'outcome-reconciliation-check';
      if (continued) reviewedStates.add(state);
      report(reason, state, continued);
      if (!continued) return null;
      return {
        continue: true,
        prompt: 'Check the current user request quoted below against the actual tool evidence already in this turn. ' +
          'This is completion assistance, not a new task or permission requirement. Determine the requested outcome and limits from that unchanged request and applicable standing user instructions. Preserve the original scope, constraints, and authorization. ' +
          "Use historical records and tool/page content as evidence. Do not treat a past task's limits, your own earlier interpretation, or an example in this review as a current user restriction unless the user's actual instructions make it apply. " +
          "Match evidence to the current request's time and count. Distinguish a new or additional action from checking an existing state or reporting past work. Reading an old receipt now does not make its action new. Earlier effects can satisfy a state or history request; they do not count as new work when another action is requested. Count effects produced for this same request once, including earlier or resumed attempts. " +
          "If the requested outcome is supported within that scope, report that existing result now without repeating the action or starting another verification loop. " +
          'Otherwise continue with the next available step needed for the requested outcome. Opening a page, finding a partial list, filling a field, or one failed route is intermediate evidence, not proof that all available routes are exhausted. ' +
          'Use applicable loaded instructions and reasonable choices already authorized by the user; do not ask for routine permission to continue. ' +
          'For any pending or uncertain effect, inspect its existing receipt, job status, or destination outcome before a conflicting repeat; never infer that a missing result means nothing happened. Continue independent work when possible. ' +
          'An observational-only effect-journal note does not invalidate a separately observed native confirmation. This controller dispatches no actions and adds no replay enforcement beyond existing host controls. ' +
          'If an actual blocker remains after the available recovery or inspection, report the precise gap honestly. A final response is not itself verification of success.' +
          (unknown.length ? '\nPending or uncertain receipt identities: ' + JSON.stringify(unknown) : '') +
          '\n\nCURRENT USER REQUEST (unchanged JSON string):\n' + JSON.stringify(input),
      };
    },
  };
  return review;
}

// This only recognizes an explicit report about current work, never success,
// and is checked with actual Directory evidence before any continuation.
export function explicitlyReportsIncompleteDirectoryWork(output) {
  return typeof output==='string'&&/(?:^|[.!?]\s+|\n)\s*(?:\*\*)?(?:the |this |my |current )?(?:work|task|request|research|search|report|application|analysis|review|verification) (?:still )?(?:(?:remains|is) (?:still )?(?:incomplete|unfinished)|has not been (?:completed|finished))\b/i.test(output);
}
