import { REASONING_LEVELS, reasoningModel } from './reasoning-model.mjs';

/** Shared planning vocabulary. Servers validate input strictly; UI fallbacks are display-only. */
export const PLANNING_MODES = Object.freeze(['maximal', 'on', 'auto', 'off']);

export const PLANNING_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'maximal', label: 'Maximal', description: 'Expand the outline with branches, alternatives and checks.' }),
  Object.freeze({ value: 'on', label: 'On', description: 'Always create a visible outline before answering.' }),
  Object.freeze({ value: 'auto', label: 'Auto', description: 'Scale the outline to the task.' }),
  Object.freeze({ value: 'off', label: 'Off', description: 'Skip automatic planning and keep existing notes.' }),
]);

export function normalizePlanningMode(value, { fallback = 'auto' } = {}) {
  return PLANNING_MODES.includes(value) ? value : PLANNING_MODES.includes(fallback) ? fallback : 'auto';
}

export const planningModeLabel = value => PLANNING_MODE_OPTIONS.find(option => option.value === normalizePlanningMode(value)).label;
export const planningModeDescription = value => PLANNING_MODE_OPTIONS.find(option => option.value === normalizePlanningMode(value)).description;

/** Legacy depth remains a compatibility hint; the backend decides Auto's effective detail. */
export function planningModeDetail(value, legacyDetail) {
  if (normalizePlanningMode(value) === 'maximal') return 'detailed';
  return ['compact', 'balanced', 'detailed'].includes(legacyDetail) ? legacyDetail : undefined;
}

/** Catalog-based preview and admission share exactly the same bounded choice. */
export function selectPlanningEffort({ mode, status, model, requestedEffort, defaultEffort }) {
  const requested = requestedEffort ?? null;
  if (mode === 'maximal' && (requested === null || requested === 'default')) {
    const selected = reasoningModel(status, model);
    const advertised = (selected?.supportedReasoningEfforts || []).map(item => typeof item === 'string' ? item : item?.reasoningEffort);
    const effort = [...REASONING_LEVELS].reverse().find(value => advertised.includes(value));
    if (effort) return { effort, source: 'maximal-model-catalog', requestedEffort: requested };
  }
  const effort = requestedEffort ?? defaultEffort ?? 'default';
  return { effort, source: requested === null ? 'application-default' : 'request', requestedEffort: requested };
}

/** Restore authored intent when an executed node becomes a new saved recipe. */
export function planningEffortIntent(node = {}, state) {
  const choice = state?.effortSelection;
  const valid = value => value === 'default' || REASONING_LEVELS.includes(value);
  if (choice && ['request', 'application-default', 'maximal-model-catalog'].includes(choice.source) && node.effort === choice.effort) return valid(choice.requestedEffort) ? choice.requestedEffort : undefined;
  return valid(node.effort) ? node.effort : undefined;
}
