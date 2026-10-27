import { REASONING_LEVELS, reasoningModel } from './reasoning-model.mjs';

/** New planning choices are binary. Old Auto/Maximal records are On aliases. */
export const PLANNING_MODES = Object.freeze(['on', 'off']);
/** Accept historical values at input boundaries; never expose them as new choices. */
export const PLANNING_INPUT_MODES = Object.freeze([...PLANNING_MODES, 'auto', 'maximal']);
export const isPlanningMode = value => PLANNING_INPUT_MODES.includes(value);
export const PLANNING_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'on', label: 'On', description: 'Require full substantive planning: concrete methods, decision-relevant comparisons and observed results.' }),
  Object.freeze({ value: 'off', label: 'Off', description: 'No automatic Planning requirement. Existing plans remain available.' }),
]);
export function normalizePlanningMode(value, { fallback = 'on' } = {}) {
  const selected = isPlanningMode(value) ? value : fallback;
  return selected === 'off' ? 'off' : 'on';
}

export const planningModeLabel = value => PLANNING_MODE_OPTIONS.find(option => option.value === normalizePlanningMode(value)).label;
export const planningModeDescription = value => PLANNING_MODE_OPTIONS.find(option => option.value === normalizePlanningMode(value)).description;

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
