// This is a deliberately narrow premature-exit check, not an authorization
// classifier, a completion oracle, or a replacement for the effect journal.
const directRequest = /^(?:please\s+|(?:can|could|would|will) you\s+(?:please\s+)?)?(send|submit|apply|file|publish|post|upload|download|install|update|edit|save|create|rename|move|copy|delete|archive|schedule|book|cancel|run|fix|complete)\s+\S/i;
const remaining = /(?:^|[.!?]\s+|\n)\s*(?:\*\*)?I (?:have not|haven['’]t|did not|didn['’]t|still need to|have yet to) (?:yet )?([a-z]+)(?:\s+(?:or|and)\s+([a-z]+))?\b/gi;
const aliases = {
  send: /^(send|sent)$/, submit: /^(submit|submitted|apply|applied)$/, apply: /^(apply|applied|submit|submitted)$/,
  file: /^filed?$/, update: /^updated?$/, save: /^saved?$/, create: /^created?$/, rename: /^renamed?$/,
  move: /^moved?$/, copy: /^(copy|copied)$/, delete: /^deleted?$/, archive: /^archived?$/, schedule: /^scheduled?$/,
  cancel: /^(cancel|canceled|cancelled)$/, run: /^(run|ran)$/, complete: /^completed?$/,
};
function admitsCurrentAction(output, action) {
  return [...output.matchAll(remaining)].some(([,first,second]) => [first,second].some(word => {
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
export function createChatExecutionReview({ input, canContinue, onContinue }) {
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
      const output = candidate?.output;
      if (retried || unsafe || pending.size || !observedRead || candidate?.signal?.aborted || (Number.isInteger(candidate?.remainingSteps) && candidate.remainingSteps < 2) || candidate?.incomplete ||
          typeof output !== 'string' || !admitsCurrentAction(output, action) || blocker.test(output) || !canContinue()) return null;
      retried = true;
      onContinue?.();
      return { continue: true, prompt: 'Continue only the current user request; do not resume any earlier task. Your proposed answer reports that the requested action is not done, and this turn has only read-only tool results. Use the evidence already in this turn and take the next available step under the original authorization. Do not repeat any earlier or uncertain effects, bypass consent, or change the requested scope. If a real blocker prevents progress, report it plainly; otherwise verify the requested result and report what happened.' };
    }
  };
}
