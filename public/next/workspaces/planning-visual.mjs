import { buildWorkflowMapModel } from '../../workflow-map.mjs';
import { projectViewModel } from '../../project-view-model.mjs';

const note = step => String(step.note || '');

/** Drafts keep a full revision, never a metadata-only catalog row. */
export function createPlanningDraft(plan) {
  if (!Array.isArray(plan?.steps)) throw Error('Load the saved plan before editing it.');
  return { base: plan, latest: plan, goal: String(plan.goal || ''), notes: new Map(plan.steps.map(step => [step.id, note(step)])), detachedNotes: [], error: '' };
}

export function planningDraftDirty(draft) {
  return draft.goal !== String(draft.base.goal || '') || draft.base.steps.some(step => (draft.notes.get(step.id) || '') !== note(step));
}

export function planningDraftOperations(draft) {
  const operations = [];
  if (draft.goal.trim() !== String(draft.base.goal || '')) operations.push({ type: 'metadata', patch: { goal: draft.goal.trim() } });
  for (const step of draft.base.steps) if ((draft.notes.get(step.id) || '') !== note(step)) operations.push({ type: 'update', stepId: step.id, patch: { note: draft.notes.get(step.id) || '' } });
  return operations;
}

export function acceptPlanningSnapshot(draft, plan) {
  if (!Array.isArray(plan?.steps) || plan.taskId !== draft.base.taskId || plan.revision < draft.latest.revision) return draft;
  if (!planningDraftDirty(draft)) return { ...createPlanningDraft(plan), detachedNotes: draft.detachedNotes, error: draft.error };
  return { ...draft, latest: plan };
}

/** Explicit rebase preserves edits by saved step ID and retains removed notes. */
export function rebasePlanningDraft(draft) {
  const previous = draft.base, latest = draft.latest, old = new Map(previous.steps.map(step => [step.id, step])), ids = new Set(latest.steps.map(step => step.id));
  const detachedNotes = [...draft.detachedNotes];
  for (const step of previous.steps) if (!ids.has(step.id) && (draft.notes.get(step.id) || '') !== note(step)) {
    detachedNotes.push({ id: step.id, title: step.title || step.id, note: draft.notes.get(step.id) || '' });
  }
  return {
    ...draft, base: latest,
    goal: draft.goal === String(previous.goal || '') ? String(latest.goal || '') : draft.goal,
    notes: new Map(latest.steps.map(step => [step.id, old.has(step.id) && (draft.notes.get(step.id) || '') !== note(old.get(step.id)) ? draft.notes.get(step.id) || '' : note(step)])),
    detachedNotes, error: 'Draft kept. Save explicitly to apply it to the latest revision.',
  };
}

/** A delayed receipt cannot consume text typed after its submitted version. */
export function commitPlanningDraft(draft, saved, submitted) {
  const latest = draft.latest.revision > saved.revision ? draft.latest : saved;
  return {
    ...draft, base: saved, latest,
    goal: draft.goal === submitted.goal ? String(saved.goal || '') : draft.goal,
    notes: new Map(saved.steps.map(step => [step.id, draft.notes.get(step.id) === submitted.notes.get(step.id) ? note(step) : draft.notes.get(step.id) ?? note(step)])),
    error: 'Saved revision ' + saved.revision + '.',
  };
}

/** Real project dependencies and reviewed receipts; no synthetic schedule dates. */
export function projectVisualModel(project) {
  const graph = buildWorkflowMapModel({ kind: 'project', project }), tracking = projectViewModel(project);
  return { ...graph, tracking, progress: project.summary?.progress || { total: tracking.total, completed: tracking.reviewed, percent: tracking.percent }, milestones: project.summary?.milestones || tracking.milestones };
}
