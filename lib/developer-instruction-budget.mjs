/** Preserve the complete instruction hierarchy. Model context limits are
 * handled by the runtime; BLACKICE imposes no default character budget here. */
export const DEVELOPER_INSTRUCTION_LIMIT = null;
export const DEVELOPER_INSTRUCTION_TARGET = null;

const asText = value => {
  if (typeof value !== 'string') throw new TypeError('Developer instruction sections must be text.');
  return value;
};
export function composeAgentDeveloperInstructions({
  core = '', capabilities = '', planning = '', worker = '', analysis = '',
  limit = DEVELOPER_INSTRUCTION_TARGET
} = {}) {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError('Invalid explicit developer instruction limit.');
  const mandatory = [core, capabilities, planning, worker].map(asText).join('');
  const sourceContext = asText(analysis), instructions = mandatory + sourceContext;
  if (limit !== null && instructions.length > limit) {
    const error = new Error('Developer instructions exceed the explicitly configured character limit. No instructions were truncated or moved to a lower-priority prompt.');
    error.code = 'DEVELOPER_INSTRUCTION_LIMIT_EXCEEDED';
    error.budget = {coreChars:mandatory.length, analysisChars:sourceContext.length, totalChars:instructions.length, limit};
    throw error;
  }
  return {instructions, promptSupplement:'', mode:sourceContext ? 'full' : 'core-only',
    coreChars:mandatory.length, analysisChars:sourceContext.length, totalChars:instructions.length, limit};
}
