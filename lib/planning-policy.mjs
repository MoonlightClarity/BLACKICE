import { isPlanningMode, normalizePlanningMode } from '../public/planning-mode.mjs';
export { selectPlanningEffort } from '../public/planning-mode.mjs';

const fail = (message, code = 'PLANNING_MODE_INVALID') => Object.assign(new Error(message), { status: 400, code });

// On/Off is the runtime ontology. Auto and Maximal are input-only aliases
// retained so historical workflows and saved conversations remain readable.
export function planningModeOf(value) {
  if (value === undefined) return undefined;
  if (!isPlanningMode(value)) throw fail('Choose On or Off task planning.');
  return normalizePlanningMode(value);
}

export function savedPlanningMode(run) {
  return planningModeOf(run.planningMode) ?? planningModeOf(run.workflow?.settings?.planningMode) ?? 'on';
}

// Plan detail is authored separately; Planning On never forces maximal detail
// and never implies a higher model reasoning effort.
export function planningDetail(mode, legacyDetail) {
  planningModeOf(mode);
  return legacyDetail;
}

// Structural validity and honest completion evidence remain checked by the
// task-plan store. This switch no longer adds a separate Maximal-only gate.
export function validatePlanningOutline(planned, { mode = 'on' } = {}) {
  planningModeOf(mode);
  return planned;
}
