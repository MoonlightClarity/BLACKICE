import { createCompatibleStreamAccumulator } from './provider-compatible-stream.mjs';

export const RESPONSE_FUNCTION_NAME = 'blackice_response';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Never retain arbitrary provider strings in diagnostics.
export const providerFinishReason = value => ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(value) ? value : 'unknown';
const invalid = (detail, finishReason) => Object.assign(new Error('The response-only data function ' + detail + '. No action tool was executed.'), {
  code: 'PROVIDER_RESPONSE_FUNCTION_INVALID', ...(finishReason === undefined ? {} : { providerFinishReason: providerFinishReason(finishReason) }),
});
function envelope(message, finishReason) {
  if (!object(message) || message.role !== undefined && message.role !== 'assistant') throw invalid('has an invalid assistant envelope', finishReason);
  if (message.content !== undefined && message.content !== null && message.content !== '') throw invalid('included unexpected message content', finishReason);
  if (message.refusal !== undefined && message.refusal !== null && message.refusal !== '' || message.function_call !== undefined) throw invalid('included a refusal or legacy function call', finishReason);
}

/** Validate one complete data envelope. Return its exact argument bytes, not reserialized JSON. */
export function responseFunctionOutput(message, finishReason) {
  envelope(message, finishReason);
  if (finishReason !== 'tool_calls') throw invalid('did not finish with the expected function-call termination', finishReason);
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) throw invalid('must contain exactly one call', finishReason);
  const call = message.tool_calls[0];
  if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id ||
      call.index !== undefined && call.index !== 0 || !object(call.function) || call.function.name !== RESPONSE_FUNCTION_NAME)
    throw invalid('returned an unexpected call identity', finishReason);
  const args = call.function.arguments;
  if (typeof args !== 'string' || !args.trim()) throw invalid('has no JSON arguments', finishReason);
  const formatFailure = detail => {
    const cause = invalid(detail, finishReason);
    // Only a complete, exact expected envelope may offer bounded format-failure
    // data to the caller's existing repair policy. This is not accepted output.
    if (args.length <= RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS) Object.assign(cause, { code: 'PROVIDER_RESPONSE_FORMAT', responseFormatOutput: args });
    return cause;
  };
  let value;
  try { value = JSON.parse(args); } catch { throw formatFailure('returned incomplete or invalid JSON arguments'); }
  if (!object(value)) throw formatFailure('arguments must be a JSON object');
  // Parseability is transport validation only. The caller's full host schema and
  // semantic validators remain authoritative, including constraints omitted on wire.
  return args;
}

/** Strict response-only framing on top of the ordinary metadata-preserving assembler. */
export function createResponseFunctionAccumulator() {
  const stream = createCompatibleStreamAccumulator();
  let id, typeSeen = false, callSeen = false, ended = false;
  const validateChoices = choices => {
    if (choices === undefined) return; // Usage/heartbeat events can have no choice.
    if (!Array.isArray(choices) || choices.length > 1 || choices.some(choice => !object(choice) || choice.index !== undefined && choice.index !== 0))
      throw invalid('returned ambiguous choices');
  };
  const append = (delta, finishReason) => {
    if (delta !== undefined && delta !== null) {
      envelope(delta, finishReason);
      if (delta.tool_calls !== undefined && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 1))
        throw invalid('streamed ambiguous calls', finishReason);
      for (const part of delta.tool_calls || []) {
        if (ended || !object(part) || part.index !== undefined && part.index !== 0) throw invalid('streamed an unexpected call index', finishReason);
        callSeen = true;
        if (part.id !== undefined) {
          if (typeof part.id !== 'string' || !part.id || id !== undefined && id !== part.id) throw invalid('changed its call identity', finishReason);
          id = part.id;
        }
        if (part.type !== undefined) {
          if (part.type !== 'function') throw invalid('streamed an unexpected call type', finishReason);
          typeSeen = true;
        }
        if (part.function !== undefined && (!object(part.function) ||
          ['name', 'arguments'].some(key => part.function[key] !== undefined && typeof part.function[key] !== 'string')))
          throw invalid('streamed invalid function fields', finishReason);
      }
      stream.append(delta);
    }
    if (finishReason !== undefined && finishReason !== null) {
      if (ended) throw invalid('reported duplicate termination', finishReason);
      ended = true;
    }
  };
  return { validateChoices, append, message: () => {
    const message = stream.message(null);
    // The general assembler defaults this field for compatible action tools;
    // response serialization requires the provider to have actually supplied it.
    if (callSeen && !typeSeen) delete message.tool_calls[0].type;
    return message;
  } };
}


/** Private bounded wire evidence; never reinsert these frames as executable history. */
export const RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS = 256000;
export function createResponseFunctionEvidence() {
  const evidence = { transport: 'chat-completions-forced-function', functionName: RESPONSE_FUNCTION_NAME, frames: [], capturedCharacters: 0, truncated: false };
  const retain = (key, value) => {
    const raw = JSON.stringify(value);
    if (raw === undefined) return;
    const remaining = RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS - evidence.capturedCharacters;
    if (raw.length <= remaining) {
      if (key === 'frames') evidence.frames.push(structuredClone(value)); else evidence[key] = structuredClone(value);
      evidence.capturedCharacters += raw.length;
    } else {
      // A bounded raw prefix is explicitly incomplete and never accepted output.
      evidence.truncated = true;
      if (remaining > 0) { evidence.rawEnvelopePrefix = raw.slice(0, remaining); evidence.capturedCharacters += remaining; }
    }
  };
  return { evidence, capture: choices => retain('frames', choices), finish: (message, reason) => {
    evidence.providerFinishReason = providerFinishReason(reason);
    // Complete framing supersedes frames only when the whole envelope fits.
    const raw = JSON.stringify(message);
    if (raw.length <= RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS) {
      evidence.frames = []; evidence.capturedCharacters = 0; evidence.truncated = false; delete evidence.rawEnvelopePrefix;
      retain('message', message);
    } else retain('message', message);
    return evidence;
  } };
}
