// Reopening work changes the current attempt, never the history of its effects.
const terminal = step => ['done', 'skipped'].includes(step.status);
const fail = message => Object.assign(new Error(message), { code: 'TASK_PLAN_REVISIT_INVALID', status: 409 });
const snapshotFields = ['result', 'note', 'doneWhen', 'evidence', 'blockedReason', 'skipReason', 'operation', 'reconciliation'];

/** Find affected work using order, inherited dependencies and group completion. */
export function revisitImpact(steps, plan, stepId) {
  const byId = new Map(steps.map(step => [step.id, step]));
  if (!byId.has(stepId)) throw fail('The step to revisit is not in the current saved plan.');
  const children = new Map([[null, []]]);
  for (const step of steps) {
    const parent = step.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(step.id);
    if (!children.has(step.id)) children.set(step.id, []);
  }
  const descendants = root => {
    const found = new Set([root]), queue = [root];
    while (queue.length) for (const child of children.get(queue.shift()) || []) if (!found.has(child)) { found.add(child); queue.push(child); }
    return found;
  };
  const requirements = new Map();
  for (const step of steps) {
    const required = new Set(step.dependsOn || []), seen = new Set([step.id]);
    let branch = step, parentId = branch.parentId ?? null;
    while (true) {
      const parent = parentId === null ? { kind: plan.layout || 'sequence' } : byId.get(parentId);
      if (!parent) throw fail('Restore the missing parent before revisiting this work.');
      for (const dependency of parent.dependsOn || []) required.add(dependency);
      if (parent.kind === 'sequence') {
        const siblings = children.get(parentId), index = siblings.indexOf(branch.id);
        if (index > 0) required.add(siblings[index - 1]);
      }
      if (parentId === null) break;
      if (seen.has(parentId)) throw fail('Repair the hierarchy cycle before revisiting this work.');
      seen.add(parentId); branch = parent; parentId = parent.parentId ?? null;
    }
    requirements.set(step.id, required);
  }
  const target = descendants(stepId), affected = new Set(target);
  for (let changed = true; changed;) {
    changed = false;
    for (const step of steps) {
      // A changed child invalidates its group's completion, but independent
      // siblings are retained unless their actual prerequisites include it.
      const affectedChild = (children.get(step.id) || []).some(child => affected.has(child));
      const affectedDependency = [...requirements.get(step.id)].some(dependency => affected.has(dependency));
      if (!affected.has(step.id) && affectedChild) { affected.add(step.id); changed = true; }
      if (affectedDependency) for (const id of descendants(step.id)) if (!affected.has(id)) { affected.add(id); changed = true; }
    }
  }
  return { target, affected };
}

export function applyRevisit(steps, plan, operation, previous, { at = new Date().toISOString(), revisited = new Set(), scopeIds } = {}) {
  if (typeof operation.reason !== 'string' || !operation.reason.trim() || operation.reason.length > 1000 || operation.reason.includes('\0')) throw fail('Revisit needs the concrete reason for returning to this earlier step (at most 1000 characters).');
  const reason = operation.reason.trim(), { target, affected } = revisitImpact(steps, plan, operation.stepId);
  const oldById = new Map(previous.steps.map(step => [step.id, step]));
  const leaves = steps.filter(step => affected.has(step.id) && (step.kind || 'action') === 'action');
  if (scopeIds && leaves.some(step => !scopeIds.has(step.id))) throw fail('Revisiting this step also affects work outside this assignment. The coordinator must reconcile the shared dependencies.');
  for (const step of leaves) {
    const old = oldById.get(step.id);
    if (!old) throw fail('Save newly added work before revisiting it.');
    if (old.status === 'active') throw fail('Save the active attempt\'s actual result or blocker before revisiting it. Reopening an unresolved attempt would lose the disposition needed to reconcile an in-flight operation.');
    if (revisited.has(step.id)) throw fail('Overlapping revisits would reopen the same attempt twice. Revisit their common parent once or use separate saved revisions.');
    if (JSON.stringify(step) !== JSON.stringify(old)) throw fail('Record the current outcome in a saved step update before revisiting it. Do not change an attempt and archive it in the same edit.');
    const attempt = old.attempt || 1;
    const snapshot = { attempt, status: old.status, at, reason };
    for (const key of snapshotFields) if (old[key] !== undefined) snapshot[key] = structuredClone(old[key]);
    const history = [...(old.pastAttempts || []), snapshot];
    step.attempt = attempt + 1;
    step.pastAttempts = history.slice(-8);
    const omitted = (old.pastAttemptsOmitted || 0) + Math.max(0, history.length - 8);
    if (omitted) step.pastAttemptsOmitted = omitted;
    delete step.evidence; delete step.skipReason; delete step.blockedReason; delete step.reconciliation;
    if (target.has(step.id) || ['pending', 'skipped'].includes(old.status)) step.status = 'pending';
    else {
      step.status = 'blocked';
      step.blockedReason = `Earlier step ${operation.stepId} was reopened: ${reason}. Reassess the preserved previous result after its prerequisites are resolved; existing effects have not been undone.`.slice(0, 1000);
    }
    revisited.add(step.id);
  }
  // Focus is attention, not permission to replay a completed effect.
  plan.focusStepId = operation.stepId;
  return { affectedIds: leaves.map(step => step.id), hadCompletedWork: leaves.some(step => terminal(oldById.get(step.id))) };
}
