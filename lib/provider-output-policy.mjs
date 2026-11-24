/**
 * Generation policy is separate from the context space reserved for an answer.
 * Unmarked legacy default budgets use automatic provider/model capacity on every direct API protocol.
 */
export const CONFIGURED_OUTPUT_TOKEN_POLICY = 'configured-limit';
export const PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY = 'provider-default';

const invalid = message => Object.assign(new Error(message), {
  code: 'INVALID_OUTPUT_TOKEN_POLICY', status: 400,
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export {supportsAutomaticOutput as supportsProviderDefaultOutput} from '../public/provider-output-settings.mjs';
import {supportsAutomaticOutput as supportsProviderDefaultOutput,defaultOutputPolicy} from '../public/provider-output-settings.mjs';

export function normalizeOutputTokenPolicy(value, config) {
  // The legacy 8192 value was inserted by BLACKICE even without an owner choice.
  // Preserve non-default legacy values and explicit configured-limit selections.
  const policy = value === undefined ? defaultOutputPolicy(config) : value;
  if (![CONFIGURED_OUTPUT_TOKEN_POLICY, PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY].includes(policy))
    throw invalid('Choose configured-limit or provider-default for the output token policy.');
  if (policy === PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY && !supportsProviderDefaultOutput(config))
    throw invalid('Automatic output capacity requires a supported direct API protocol.');
  return policy;
}

/** Both output-policy choices are pinned on new direct API conversations. */
export function createOutputTokenPolicySnapshot(config) {
  const policy=normalizeOutputTokenPolicy(config?.outputTokenPolicy,config);
  return supportsProviderDefaultOutput(config) ? Object.freeze({version:1,policy}) : undefined;
}

/**
 * An older conversation without a recorded choice inherits the current
 * effective policy. Absence cannot establish that the owner selected the old
 * application default. Explicit saved choices remain pinned.
 */
export function outputTokenPolicyForRecord(record, config) {
  const snapshot = record?.outputTokenPolicy;
  if (snapshot === undefined) return supportsProviderDefaultOutput(config) ? normalizeOutputTokenPolicy(config.outputTokenPolicy,config) : CONFIGURED_OUTPUT_TOKEN_POLICY;
  if (!object(snapshot) || Object.keys(snapshot).sort().join(',') !== 'policy,version'
      || snapshot.version !== 1 || ![PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY,CONFIGURED_OUTPUT_TOKEN_POLICY].includes(snapshot.policy))
    throw invalid('The saved conversation has an unsupported output token policy snapshot.');
  return normalizeOutputTokenPolicy(snapshot.policy, config);
}

/**
 * A finite host-selected subrequest budget (for example a continuity summary)
 * stays finite. null means omit the wire field; it never means JSON null.
 */
export function outputTokenBudgetForRequest(state, config = state.config) {
  const policy = outputTokenPolicyForRecord(state.record, config);
  const explicit = state.responseMaxTokens;
  if (explicit !== undefined && explicit !== null) {
    if (!Number.isSafeInteger(explicit) || explicit < 1)
      throw invalid('An explicit response output budget must be a positive safe integer.');
    return explicit;
  }
  if (policy === PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY && config.type !== 'anthropic') return null;
  if (!Number.isSafeInteger(config?.maxTokens) || config.maxTokens < 1)
    throw invalid('The configured response output budget is unavailable.');
  return config.maxTokens;
}
