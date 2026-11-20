// This is a deliberately narrow premature-exit check, not an authorization
// classifier, a completion oracle, or a replacement for the effect journal.
const directRequest = /^(?:please\s+|(?:can|could|would|will) you\s+(?:please\s+)?)?(send|submit|apply|file|publish|post|upload|download|install|update|edit|save|create|rename|move|copy|delete|archive|schedule|book|cancel|run|fix|complete)\s+\S/i;
const remaining = /(?:^|[.!?]\s+|\n|,\s*(?:(?:but|and)\s+)?|;\s*)\s*(?:\*\*)?I (?:have not|haven't|did not|didn't|still need to|have yet to) (?:yet )?([a-z]+)(?:\s+(?:[a-z0-9'-]+\s+){0,8}or\s+([a-z]+)|\s+and\s+([a-z]+))?\b/gi;
// A bare summary of noncompletion is not evidence of a blocker. Strip only
// this standalone opening sentence; any explanation or separate blocker stays.
const bareNoncompletion = /^\s*(?:\*\*)?I (?:could not|couldn't|cannot|can't|was unable to) complete (?:the |this )?(?:task|work|request|application|submission)(?: in this turn)?\.(?:\*\*)?(?=\s|$)/i;
const aliases = {
  send: /^(send|sent)$/, submit: /^(submit|submitted|apply|applied)$/, apply: /^(apply|applied|submit|submitted)$/,
  file: /^filed?$/, update: /^updated?$/, save: /^saved?$/, create: /^created?$/, rename: /^renamed?$/,
  move: /^moved?$/, copy: /^(copy|copied)$/, delete: /^deleted?$/, archive: /^archived?$/, schedule: /^scheduled?$/,
  cancel: /^(cancel|canceled|cancelled)$/, run: /^(run|ran)$/, complete: /^completed?$/,
};
function admitsCurrentAction(output, action) {
  return [...output.matchAll(remaining)].some(([,first,second,third]) => [first,second,third].some(word => {
    const value=word?.toLowerCase();
    return value && (aliases[action]?.test(value) ?? (value===action || value===action+'ed'));
  }));
}
const blocker = /[?`"“”]|(?:^|\n)\s*>|\b(?:can(?:not|['’]t)|could(?: not|n['’]t)|unable|need (?:your|you to)|requires?|permission|approval|confirm(?:ation)?|uncertain|not sure|unknown|blocked|missing|unavailable|failed|error|timeout|deadline|expired|logged out|signed out|(?:sign|log) in|captcha|rate limit|stopped|cancelled|canceled)\b/i;
const readOnly = new Map([
  ['relay_browser', new Set(['tabs', 'snapshot', 'read', 'screenshot'])],
  ['relay_workspace', new Set(['read', 'list', 'stat'])],
  ['relay_files', new Set(['list', 'read'])],
  ['relay_find_files', new Set(['call'])],
  ['relay_skills', new Set(['list', 'search', 'read'])],
]);
// The opening directive screens for ambiguous authority. Follow-on instructions
// still constrain the original task; an unrelated negative is not a veto.
const ambiguousOpening = /(?:^|\s)(?:resume|retry|continue|again|as before|previously|earlier|prior|previous|last (?:turn|conversation|run)|if|unless|until|only (?:when|after)|(?:before|by) \d|show me how|explain|simulat\w*|pretend)\b/i;
const negativeAction = /\b(?:do not|don['\u2019]t|never|must not|should not|cannot|can['\u2019]t|without(?: actually)?)(?:\s+(?:actually|ever|yet|really))*\s+([a-z]+)\b/gi;
const conditionalAction = /\bonly\s+([a-z]+)\b[^.!?;\n]*\b(?:if|when|after|once)\b/gi;
const routeVerbs = new Set(['send', 'submit', 'apply']);
function requestedAction(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const action = directRequest.exec(text)?.[1].toLowerCase();
  if (!action) return null;
  const opening = text.split(/[.!?;](?=\s|$)|\n/, 1)[0];
  if (ambiguousOpening.test(opening)) return null;
  for (const [,verb] of [...text.matchAll(negativeAction), ...text.matchAll(conditionalAction)]) {
    const word = verb.toLowerCase();
    if (word === action || aliases[action]?.test(word) || (routeVerbs.has(action) && routeVerbs.has(word))) return null;
  }
  return action;
}
export function explicitChatAction(input) {
  return requestedAction(input) !== null;
}
export const CHAT_EXECUTION_REVIEW_REASONS = Object.freeze([
  'continuation-already-used', 'non-read-only-or-failed-tool', 'tool-result-pending', 'no-read-only-evidence',
  'review-cancelled', 'review-budget-low', 'provider-incomplete', 'no-candidate-text',
  'no-incomplete-action-match', 'blocker-wording-matched', 'host-continuation-unavailable',
  'explicit-action-left-unfinished',
]);
export function createChatExecutionReview({ input, canContinue, onDecision }) {
  const action = requestedAction(input);
  if (!action) return null;
  const pending = new Set();
  let observedRead = false, unsafe = false, retried = false;
  return {
    observe(event) {
      if (event.type === 'native.write.uncertain' || event.type === 'steer' ||
        event.type === 'item' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall'].includes(event.item?.type)) unsafe = true;
      if (event.type !== 'tool.result') return;
      const { tool, action, callId, success } = event;
      if (!readOnly.get(tool)?.has(action) || success !== true) { unsafe = true; return; }
      pending.delete(callId);
      observedRead = true;
    },
    started(call) {
      // A host tool call that never produced a result may still have changed
      // state. Do not interpret a missing receipt as evidence of no effect.
      let args = call.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { unsafe = true; } }
      if (call.namespace || !call.callId || pending.has(call.callId) || !readOnly.get(call.name)?.has(args?.action || "call")) unsafe = true;
      else pending.add(call.callId);
    },
    beforeFinal(candidate) {
      const raw = candidate?.output;
      const output = typeof raw === 'string' ? raw.replace(/[\u2018\u2019]/g, "'").replace(bareNoncompletion, '') : raw;
      const reason = retried ? 'continuation-already-used'
        : unsafe ? 'non-read-only-or-failed-tool'
        : pending.size ? 'tool-result-pending'
        : !observedRead ? 'no-read-only-evidence'
        : candidate?.signal?.aborted ? 'review-cancelled'
        : Number.isInteger(candidate?.remainingSteps) && candidate.remainingSteps < 2 ? 'review-budget-low'
        : candidate?.incomplete ? 'provider-incomplete'
        : typeof output !== 'string' ? 'no-candidate-text'
        : !admitsCurrentAction(output, action) ? 'no-incomplete-action-match'
        : blocker.test(output) ? 'blocker-wording-matched'
        : !canContinue() ? 'host-continuation-unavailable'
        : 'explicit-action-left-unfinished';
      const continued = reason === 'explicit-action-left-unfinished';
      if (continued) retried = true;
      onDecision?.({ reason, reviewDecision: continued ? 'continue' : 'accepted' });
      if (!continued) return null;
      return { continue: true, prompt: 'Continue only the current user request; do not resume any earlier task. Your proposed answer reports that the requested action is not done, and this turn has only read-only tool results. Use the evidence already in this turn and take the next available step under the original authorization. Do not repeat any earlier or uncertain effects, bypass consent, or change the requested scope. If a real blocker prevents progress, report it plainly; otherwise verify the requested result and report what happened.' };
    }
  };
}

// This only recognizes an explicit report about current work, never success,
// and is checked with actual Directory evidence before any continuation.
export function explicitlyReportsIncompleteDirectoryWork(output) {
  return typeof output==='string'&&/(?:^|[.!?]\s+|\n)\s*(?:\*\*)?(?:the |this |my |current )?(?:work|task|request|research|search|report|application|analysis|review|verification) (?:still )?(?:(?:remains|is) (?:still )?(?:incomplete|unfinished)|has not been (?:completed|finished))\b/i.test(output);
}
