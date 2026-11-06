import { REASONING_LEVELS, reasoningModel } from './reasoning-model.mjs';

/** One user-facing Planning choice; legacy records retain their existing execution contract. */
export const PLANNING_MODES = Object.freeze(['forced', 'advisory', 'off']);
/** On/Auto/Maximal remain accepted as historical aliases, not new user choices. */
export const PLANNING_INPUT_MODES = Object.freeze([...PLANNING_MODES, 'on', 'auto', 'maximal']);
export const isPlanningMode = value => PLANNING_INPUT_MODES.includes(value);
export const PLANNING_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'forced', label: 'Forced', description: 'Require a current saved plan before work proceeds, and track progress against its outcomes. No extra user approval.' }),
  Object.freeze({ value: 'advisory', label: 'Advisory', description: 'Planning is available and encouraged, but does not block operations.' }),
  Object.freeze({ value: 'off', label: 'Off', description: 'No automatic Planning requirement. Existing plans remain available.' }),
]);
/** Explicit three-state choices; null means preserve the legacy run policy. */
export const planningEnforcementOf = value => PLANNING_MODES.includes(value) ? value : null;
/** Separate enforced Planning from legacy, broader execution checkpoints. */
export function planningGuardrailsRequired(mode, enforcement, legacyGuardrails = false) {
  if (normalizePlanningMode(mode) === 'off') return false;
  if (enforcement === 'forced') return true;
  if (enforcement === 'advisory') return false;
  return legacyGuardrails === true;
}
export function planningChoice(value, { fallback = 'forced' } = {}) {
  if (PLANNING_MODES.includes(value)) return value;
  return ['on', 'auto', 'maximal'].includes(value) ? 'advisory' : fallback;
}
/** Internal planning contract stays On/Off while enforcement is selected per run. */
export function normalizePlanningMode(value, { fallback = 'on' } = {}) {
  const selected = isPlanningMode(value) ? value : fallback;
  return selected === 'off' ? 'off' : 'on';
}
export const planningModeLabel = value => PLANNING_MODE_OPTIONS.find(option => option.value === planningChoice(value)).label;
export const planningModeDescription = value => PLANNING_MODE_OPTIONS.find(option => option.value === planningChoice(value)).description;

/** On is maximal substantive planning; old display hints cannot weaken it. */
export function planningModeDetail(mode, legacyDetail) {
  if (normalizePlanningMode(mode) === 'on') return 'detailed';
  return ['compact', 'balanced', 'detailed'].includes(legacyDetail) ? legacyDetail : undefined;
}

/** Catalog-based preview and admission share exactly the same bounded choice. */
export function selectPlanningEffort({ mode, status, model, requestedEffort, defaultEffort }) {
  const requested = requestedEffort ?? null;
  // The Planning switch does not select or amplify model reasoning effort.
  // Older maximal records still read as Planning On, but effort is independent.
  let effort = requestedEffort ?? defaultEffort ?? 'default';
  if (requested === null && effort !== 'default') {
    const advertised = (reasoningModel(status, model)?.supportedReasoningEfforts || [])
      .map(item => typeof item === 'string' ? item : item?.reasoningEffort)
      .filter(Boolean);
    // An application default unsupported by the selected model must not make
    // Planning On/Off silently select a different maximum. Use model default.
    if (advertised.length && !advertised.includes(effort)) effort = 'default';
  }
  return { effort, source: requested === null ? 'application-default' : 'request', requestedEffort: requested };
}

/** Restore authored intent when an executed node becomes a new saved recipe. */
export function planningEffortIntent(node = {}, state) {
  const choice = state?.effortSelection;
  const valid = value => value === 'default' || REASONING_LEVELS.includes(value);
  if (choice && ['request', 'application-default', 'maximal-model-catalog'].includes(choice.source) && node.effort === choice.effort) return valid(choice.requestedEffort) ? choice.requestedEffort : undefined;
  return valid(node.effort) ? node.effort : undefined;
}
