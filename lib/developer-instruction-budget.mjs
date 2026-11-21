/** Model context limits are handled by the runtime. This composer never
 * truncates instructions; it also returns the exact ordered source sections. */
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
  const definitions = [
    ['core', 'Harness mechanics', 'lib/harness-identity.mjs; lib/engine.mjs', core],
    ['capabilities', 'Attached tool routing', 'lib/tool-routing.mjs', capabilities],
    ['planning', 'Selected planning mode', 'lib/engine.mjs', planning],
    ['worker', 'Delegated worker scope', 'lib/task-state.mjs', worker],
    ['analysis', 'Selected document and planning procedure', 'lib/document-analysis-policy.mjs; lib/tradecraft-planning.mjs', analysis],
  ];
  const sections = definitions.map(([id, title, source, value]) => ({ id, title, source, role: 'developer', text: asText(value), reason: 'Included by the active engine configuration' })).filter(item => item.text);
  const mandatory = [core, capabilities, planning, worker].map(asText).join('');
  const sourceContext = asText(analysis), instructions = mandatory + sourceContext;
  if (limit !== null && instructions.length > limit) {
    const error = new Error('Developer instructions exceed the explicitly configured character limit. No instructions were truncated or moved to a lower-priority prompt.');
    error.code = 'DEVELOPER_INSTRUCTION_LIMIT_EXCEEDED';
    error.budget = {coreChars:mandatory.length, analysisChars:sourceContext.length, totalChars:instructions.length, limit};
    throw error;
  }
  return {instructions, sections, promptSupplement:'', mode:sourceContext ? 'full' : 'core-only',
    coreChars:mandatory.length, analysisChars:sourceContext.length, totalChars:instructions.length, limit};
}
