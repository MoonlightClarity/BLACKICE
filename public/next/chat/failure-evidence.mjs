const choices = {
  codeSource: ['adapter', 'result', 'unavailable'],
  argumentForm: ['object', 'invalid-json', 'array', 'absent', 'non-object'],
  receiptState: ['superseded-or-invalid', 'missing-after-observation', 'new-observation-needed'],
  pointerStage: ['pre-pointer-capture', 'pre-pointer-identity'],
  keyboardStage: ['pre-key-input'],
  bindingReason: ['reference-missing', 'reference-unknown', 'reference-evicted', 'document-changed', 'frame-changed',
    'binding-mismatch', 'control-changed', 'input-identity-invalid', 'input-url-mismatch', 'input-document-mismatch', 'input-reference-mismatch'],
  bindingEvent: ['frame-navigation', 'in-page-navigation', 'renderer-gone', 'tab-suspended'],
  pointerCheck: ['layout-metrics', 'hit-location', 'resolve-hit', 'verify-hit', 'viewport-recheck'],
  pointerVerification: ['renderer-exception', 'hit-mismatch', 'no-verification', 'control-disconnected', 'hidden', 'no-box', 'identity-changed'],
  controlBindingCause: ['control-disconnected', 'hidden', 'no-box', 'identity-changed'],
  controlBindingPhase: ['fill', 'fill-ready'],
  commandStatus: ['exited', 'timed-out', 'signalled', 'unknown'],
  commandError: ['SyntaxError', 'TypeError', 'ReferenceError', 'RangeError', 'URIError', 'AggregateError'],
  commandSignal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGHUP', 'SIGQUIT', 'SIGPIPE'],
};
const flags = ['hostHandlerEntered', 'modalPresent', 'viewportOverlay', 'outOfViewport', 'topUrlChanged',
  'frameUrlChanged', 'frameLineageChanged', 'controlTagChanged', 'controlTypeChanged', 'controlRoleChanged', 'controlNameChanged'];
const counts = ['argumentCount', 'observedRevision', 'currentRevision', 'retiredAtRevision', 'requestedRevision'];
const argumentNames = ['action', 'browser', 'tabId', 'url', 'expectedUrl', 'expectedDocumentId', 'observationReceipt',
  'ref', 'chooserId', 'interactionId', 'decision', 'paths', 'query', 'path', 'cwd', 'command', 'script', 'oldText',
  'expectedHash', 'expectedRevision', 'reference', 'needle', 'offset', 'startOffset', 'maxBytes', 'limit', 'origin',
  'requestId', 'revision', 'credentialId', 'length', 'usernameRef', 'confirmationRef', 'passwordRef', 'submitRef', 'intent'];
const fieldTypes = ['string', 'array', 'object', 'number', 'boolean', 'null', 'undefined'];
const invalidNames = new Set([...argumentNames, 'password', 'username', 'label', 'operation', 'loginOrigin']);
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export function failureRequestShape(original, parsed, invalidJson) {
  if (original === undefined) return { argumentForm: 'absent' };
  if (invalidJson) return { argumentForm: 'invalid-json' };
  const type = typeOf(parsed);
  if (type !== 'object') return { argumentForm: type === 'array' ? 'array' : 'non-object' };
  return { argumentForm: 'object', argumentCount: Math.min(Object.keys(parsed).length, 4096),
    argumentTypes: Object.fromEntries(argumentNames.filter(name => Object.hasOwn(parsed, name)).map(name => [name, typeOf(parsed[name])])) };
}

/** Only bounded classifications and argument types may cross the saved-receipt boundary. */
export function projectFailureEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const safe = {};
  for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(input[key])) safe[key] = input[key];
  for (const key of flags) if (typeof input[key] === 'boolean') safe[key] = input[key];
  for (const key of counts) if (Number.isSafeInteger(input[key]) && input[key] >= 0) safe[key] = input[key];
  const types = argumentNames.filter(name => fieldTypes.includes(input.argumentTypes?.[name]));
  if (types.length) safe.argumentTypes = Object.fromEntries(types.map(name => [name, input.argumentTypes[name]]));
  if (Array.isArray(input.invalidFields)) {
    const invalid = [...new Set(input.invalidFields.slice(0, 64).filter(name => invalidNames.has(name)))].sort();
    if (invalid.length) safe.invalidFields = invalid;
  }
  return Object.keys(safe).length ? safe : null;
}

export function failureCause(evidence) {
  if (!evidence) return [];
  const { receiptState, pointerStage, keyboardStage, bindingReason, pointerCheck, pointerVerification, controlBindingCause,
    modalPresent, viewportOverlay, outOfViewport, commandStatus, commandError, argumentForm, invalidFields } = evidence;
  const cause = [receiptState, pointerStage, keyboardStage, bindingReason, pointerCheck, pointerVerification,
    controlBindingCause, modalPresent, viewportOverlay, outOfViewport, commandStatus, commandError,
    argumentForm === 'invalid-json' ? argumentForm : undefined, invalidFields];
  return cause.some(value => value !== undefined) ? cause : [];
}
