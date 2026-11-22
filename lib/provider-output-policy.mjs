/**
 * Generation policy is separate from the context space reserved for an answer.
 * An omitted policy keeps the existing configured-limit API behavior.
 */
export const CONFIGURED_OUTPUT_TOKEN_POLICY = 'configured-limit';
export const PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY = 'provider-default';

const invalid = message => Object.assign(new Error(message), {
  code: 'INVALID_OUTPUT_TOKEN_POLICY', status: 400,
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the managed local endpoint is qualified to omit a generation maximum. */
export function supportsProviderDefaultOutput(config) {
  return config?.id === 'local_llamacpp' && config.type === 'compatible'
    && config.preset === 'llamacpp'
    && /^http:\/\/(?:localhost|127\.0\.0\.1):8080\/v1\/?$/i.test(config.baseUrl || '')
    && !config.endpoints?.chatCompletions;
}

export function normalizeOutputTokenPolicy(value, config) {
  const policy = value === undefined ? CONFIGURED_OUTPUT_TOKEN_POLICY : value;
  if (![CONFIGURED_OUTPUT_TOKEN_POLICY, PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY].includes(policy))
    throw invalid('Choose configured-limit or provider-default for the output token policy.');
  if (policy === PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY && !supportsProviderDefaultOutput(config))
    throw invalid('Provider-default output is available only for the managed local llama.cpp endpoint.');
  return policy;
}

/** A new opted-in conversation records its choice before its first request. */
export function createOutputTokenPolicySnapshot(config) {
  return normalizeOutputTokenPolicy(config?.outputTokenPolicy, config) === PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY
    ? Object.freeze({ version: 1, policy: PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY }) : undefined;
}

/**
 * Absence means the old configured-limit behavior, even after a provider default
 * changes. Existing histories are not migrated or rewritten during configuration.
 */
export function outputTokenPolicyForRecord(record, config) {
  const snapshot = record?.outputTokenPolicy;
  if (snapshot === undefined) return CONFIGURED_OUTPUT_TOKEN_POLICY;
  if (!object(snapshot) || Object.keys(snapshot).sort().join(',') !== 'policy,version'
      || snapshot.version !== 1 || snapshot.policy !== PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY)
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
  if (policy === PROVIDER_DEFAULT_OUTPUT_TOKEN_POLICY) return null;
  if (!Number.isSafeInteger(config?.maxTokens) || config.maxTokens < 1)
    throw invalid('The configured response output budget is unavailable.');
  return config.maxTokens;
}
