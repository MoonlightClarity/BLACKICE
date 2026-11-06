import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID', status: 400 });

function canonical(value, depth = 0) {
  if (depth > 100) throw invalid('The attached tool catalog is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key], depth + 1)]));
  throw invalid('The attached tool catalog must contain only JSON values.');
}

function normalizedContract(value) {
  if (!object(value) || Object.keys(value).some(key => !['version', 'planningContractVersion', 'catalogHash'].includes(key))
    || value.version !== 1 || !Number.isSafeInteger(value.planningContractVersion) || value.planningContractVersion < 1
    || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash))
    throw invalid('Use a versioned execution contract bound to the exact attached tool catalog.');
  return { version: 1, planningContractVersion: value.planningContractVersion, catalogHash: value.catalogHash };
}

/** Host metadata, not a model-authored grant or a claim of native schema introspection. */
export function createProviderExecutionContract({ dynamicTools = [], planningContractVersion } = {}) {
  if (!Array.isArray(dynamicTools) || !Number.isSafeInteger(planningContractVersion) || planningContractVersion < 1)
    throw invalid('Execution contract creation requires an attached tool array and a planning contract version.');
  const catalogHash = createHash('sha256').update(JSON.stringify(canonical(dynamicTools))).digest('hex');
  return Object.freeze({ version: 1, planningContractVersion, catalogHash });
}

/** A caller must settle the old session and make this boundary explicit; never auto-replay it. */
export function providerExecutionContractRequiresFreshSession(previous, next) {
  if (next === undefined || next === null) return false; // Existing legacy calls keep their captured behavior.
  const current = normalizedContract(next);
  if (previous === undefined || previous === null) return true;
  let saved;
  try { saved = normalizedContract(previous); } catch { return true; }
  return saved.planningContractVersion !== current.planningContractVersion || saved.catalogHash !== current.catalogHash;
}

/** Verify the current host catalog; the engine separately owns saved-session compatibility. */
export function validateProviderExecutionContract({ providerExecutionContract, dynamicTools = [], responseOnly = false } = {}) {
  if (providerExecutionContract === undefined) return undefined;
  if (responseOnly) throw invalid('Response-only preparation cannot carry an operational execution contract.');
  const supplied = normalizedContract(providerExecutionContract);
  const actual = createProviderExecutionContract({ dynamicTools, planningContractVersion: supplied.planningContractVersion });
  if (supplied.catalogHash !== actual.catalogHash) throw invalid('The execution contract does not match the exact attached tool catalog.');
  return actual;
}
