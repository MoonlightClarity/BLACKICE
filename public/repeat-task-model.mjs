import { PLANNING_INPUT_MODES, normalizePlanningMode, planningEffortIntent } from './planning-mode.mjs';

/** Repeat one admitted recipe; follow-up graphs may contain only a selected agent. */
export function repeatTaskSeed(completed, original) {
  if (completed?.status !== 'completed' || completed.settled !== true) throw new Error('Wait for this task to finish before making it repeatable.');
  if (completed.taskState?.planVersion === 1 ? completed.taskState.progress?.complete !== true : (completed.taskState?.steps || []).some(step => step.status !== 'done')) throw new Error('Finish the remaining milestones before making this task repeatable.');
  const taskId = completed.taskId || completed.id;
  if (!original || original.id !== taskId || !original.workflow || typeof original.cwd !== 'string') throw new Error('The original task is unavailable. Describe the repeatable task in Schedule a task.');
  const input = typeof original.input === 'string' ? original.input : original.input?.task || '';
  if (!input.trim()) throw new Error('The original task is unavailable. Describe the repeatable task in Schedule a task.');
  const workflow = structuredClone(original.workflow);
  const planningMode = [original.planningMode, original.input?.planningMode, workflow.settings?.planningMode].find(value => PLANNING_INPUT_MODES.includes(value));
  const planDetail = [original.planDetail, original.input?.planDetail, workflow.settings?.planDetail].find(value => ['compact', 'balanced', 'detailed'].includes(value));
  if (planningMode !== undefined || planDetail !== undefined) workflow.settings = { ...workflow.settings, ...(planningMode === undefined ? {} : { planningMode: normalizePlanningMode(planningMode) }), ...(planDetail === undefined ? {} : { planDetail }) };
  for (const node of workflow.nodes || []) {
    if (node.type !== 'agent') continue;
    // Executed workflows contain the effective effort; a new recipe needs the authored choice.
    const effort = planningEffortIntent(node, original.nodes?.[node.id]);
    if (effort === undefined) delete node.effort;
    else node.effort = effort;
  }
  return { input, cwd: original.cwd, workflow, attachmentIds: [...(original.attachmentIds || [])], repeatTask: true };
}
