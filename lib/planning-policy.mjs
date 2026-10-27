import { PLANNING_MODES } from '../public/planning-mode.mjs';
export { selectPlanningEffort } from '../public/planning-mode.mjs';

const fail = (message, code = 'PLANNING_MODE_INVALID') => Object.assign(new Error(message), { status: 400, code });

// Unlike UI normalization, admission must reject an invalid explicit setting.
// Keep omission distinct in request receipts and legacy workflow snapshots.
export function planningModeOf(value) {
  if (value === undefined) return undefined;
  if (!PLANNING_MODES.includes(value)) throw fail('Choose maximal, on, auto or off task planning.');
  return value;
}

export function savedPlanningMode(run) {
  return planningModeOf(run.planningMode) ?? planningModeOf(run.workflow?.settings?.planningMode) ?? 'auto';
}

export function planningDetail(mode, legacyDetail) {
  planningModeOf(mode);
  return mode === 'maximal' ? 'detailed' : legacyDetail;
}

// This is a bounded schema check, not a judgment that the proposed method will
// work. Meaningful decomposition, alternatives and checks remain agent-authored.
export function validatePlanningOutline(planned, { mode = 'auto', previous = {} } = {}) {
  planningModeOf(mode);
  if (mode !== 'maximal') return planned;
  if (planned.plan?.detail !== 'detailed') throw fail('Maximal planning requires plan.detail detailed.', 'TASK_PLAN_DETAIL_REQUIRED');
  const oldSteps = new Map((previous.steps || []).map(step => [step.id, step]));
  for (const step of planned.steps || []) {
    if ((step.kind || 'action') !== 'action') continue;
    const old = oldSteps.get(step.id);
    // Preserve accepted human/legacy work, including unfinished rows, when a
    // separate scope is refined. Validate new or changed work without forcing
    // unrelated owners to retrofit a later presentation schema.
    if (old && ['title', 'status', 'doneWhen', 'result', 'note', 'evidence', 'skipReason'].every(key => old[key] === step[key])) continue;
    const missing = ['result', 'doneWhen', 'note'].filter(key => typeof step[key] !== 'string' || !step[key].trim());
    if (missing.length) throw fail(`Maximal action ${step.id} needs ${missing.join(', ')}: record its expected result, observable completion check, and concrete method/check procedure. Preserve old completed evidence; do not add invented work.`, 'TASK_PLAN_DETAIL_REQUIRED');
  }
  return planned;
}

