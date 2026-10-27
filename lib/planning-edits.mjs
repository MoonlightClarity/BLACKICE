import { normalizeTaskPlan, runtimeTaskPlan, TASK_PLAN_LIMITS } from './task-plan.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'INVALID_PLAN_EDIT', status = 400) => Object.assign(new Error(message), { code, status });
const own = (value, key) => Object.hasOwn(value, key);
const editable = new Set(['title', 'kind', 'status', 'note', 'doneWhen', 'result', 'evidence', 'blockedReason', 'skipReason', 'condition', 'artifactIds', 'stepType']);
const clearable = new Set(['doneWhen', 'note', 'result', 'evidence', 'blockedReason', 'skipReason', 'condition', 'artifactIds', 'stepType']);
const structural = new Set(['parentId', 'kind', 'dependsOn', 'selectedChildId']);
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail('Use a valid saved step ID.');
  return value;
};

export function planningScope(steps, scopeStepId) {
  const result = new Set([id(scopeStepId)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) if (result.has(step.parentId) && !result.has(step.id)) { result.add(step.id); changed = true; }
  }
  return result;
}

function validateScope(before, after, scopeStepId) {
  if (!scopeStepId) return;
  const beforeIds = planningScope(before, scopeStepId), afterIds = planningScope(after, scopeStepId);
  if (!after.some(step => step.id === scopeStepId)) throw fail('Keep the assigned work group; edit its child work instead.', 'TASK_PLAN_OWNERSHIP', 403);
  const rootBefore = before.find(step => step.id === scopeStepId), rootAfter = after.find(step => step.id === scopeStepId);
  if (!rootBefore || rootBefore.parentId !== rootAfter.parentId) throw fail('Assigned work cannot be moved outside its ownership group.', 'TASK_PLAN_OWNERSHIP', 403);
  const stripDerived = step => ({ ...step, ...(step.kind && step.kind !== 'action' ? { status: 'pending', blockedReason: undefined, skipReason: undefined } : {}) });
  const outsideBefore = before.filter(step => !beforeIds.has(step.id)).map(stripDerived);
  const outsideAfter = after.filter(step => !afterIds.has(step.id)).map(stripDerived);
  if (JSON.stringify(outsideBefore) !== JSON.stringify(outsideAfter)) throw fail('This worker may edit only its assigned work and its own group. Read the current shared plan and preserve other work.', 'TASK_PLAN_OWNERSHIP', 403);
}

function keepExecutionScopes(state, steps) {
  for (const execution of Object.values(state.execution?.nodes || {})) {
    if (!steps.some(step => step.id === execution.scopeStepId)) throw fail('Keep each assigned execution group. Edit or explicitly skip its child actions without removing the worker link.', 'TASK_PLAN_EXECUTION_BOUND', 409);
  }
}

/** One atomic batch edits the current saved graph; it never changes runtime receipts. */
export function applyPlanningEdits(state, value, options = {}) {
  if (!object(value) || Object.keys(value).some(key => key !== 'operations') || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 100) throw fail('Supply from 1 to 100 plan edit operations.');
  const steps = structuredClone(state.steps), plan = { ...(state.plan || runtimeTaskPlan().plan) };
  let goal = state.goal;
  const find = stepId => {
    id(stepId); const step = steps.find(item => item.id === stepId);
    if (!step) throw fail('That step is not in the current saved plan.', 'TASK_STEP_MISSING', 404);
    return step;
  };
  const checkOwner = stepId => {
    if (options.scopeStepId && !planningScope(steps, options.scopeStepId).has(stepId)) throw fail('This edit is outside the worker’s assigned work.', 'TASK_PLAN_OWNERSHIP', 403);
  };
  const insert = (items, parentId, beforeId) => {
    if (parentId !== null) find(parentId);
    let at = steps.length;
    if (beforeId !== undefined && beforeId !== null) {
      const before = find(beforeId);
      if ((before.parentId ?? null) !== parentId) throw fail('Place a step before a sibling in the destination group.');
      at = steps.indexOf(before);
    }
    steps.splice(at, 0, ...items);
  };
  for (const operation of value.operations) {
    if (!object(operation) || typeof operation.type !== 'string') throw fail('Each edit needs an operation type.');
    const fields = { add: ['type', 'step', 'beforeId'], update: ['type', 'stepId', 'patch'], remove: ['type', 'stepId'], move: ['type', 'stepId', 'parentId', 'beforeId'], dependencies: ['type', 'stepId', 'dependsOn'], choose: ['type', 'stepId', 'selectedChildId'], metadata: ['type', 'patch'] }[operation.type];
    if (!fields || Object.keys(operation).some(key => !fields.includes(key))) throw fail('Use only the declared edit operations (add, update, remove, move, dependencies, choose, metadata) and their fields. Read relay_task describe for each operation shape.');
    if (operation.type === 'metadata') {
      if (options.scopeStepId) throw fail('The coordinator or human owns the shared goal and root layout.', 'TASK_PLAN_OWNERSHIP', 403);
      if (!object(operation.patch) || !Object.keys(operation.patch).length || Object.keys(operation.patch).some(key => !['goal', 'layout', 'detail', 'focusStepId', 'decisionCriteria', 'metacognition'].includes(key))) throw fail('Plan metadata edits support goal, layout, detail, focusStepId, decisionCriteria and the optional judgment frame.');
      const { goal: nextGoal, ...metadata } = operation.patch;
      if (metadata.layout !== undefined && !['sequence', 'parallel', 'choice'].includes(metadata.layout) || metadata.detail !== undefined && !['compact', 'balanced', 'detailed'].includes(metadata.detail)) throw fail('Use a supported plan layout and detail level.');
      if (own(operation.patch, 'goal')) {
        if (typeof nextGoal !== 'string' || !nextGoal.trim() || nextGoal.includes('\0') || nextGoal.length > 2000) throw fail('The goal needs from 1 to 2,000 characters.');
        goal = nextGoal.trim();
      }
      Object.assign(plan, metadata); continue;
    }
    if (operation.type === 'add') {
      if (!object(operation.step)) throw fail('Add needs a complete step.');
      const step = structuredClone(operation.step); id(step.id);
      if (steps.some(item => item.id === step.id)) throw fail('The new step ID is already in use.');
      if (Object.keys(step).some(key => !editable.has(key) && !structural.has(key) && key !== 'id')) throw fail('A new step contains an unsupported field.');
      step.parentId ??= null;
      if (options.scopeStepId) checkOwner(step.parentId);
      insert([step], step.parentId, operation.beforeId); continue;
    }
    if (operation.type === 'choose' && operation.stepId === null) {
      if (options.scopeStepId) throw fail('The worker cannot select the shared root branch.', 'TASK_PLAN_OWNERSHIP', 403);
      if (!own(operation, 'selectedChildId')) throw fail('Choose needs a child ID or null to clear the selection.');
      plan.selectedChildId = operation.selectedChildId; continue;
    }
    const step = find(operation.stepId); checkOwner(step.id);
    if (operation.type === 'update') {
      if (!object(operation.patch) || !Object.keys(operation.patch).length || Object.keys(operation.patch).some(key => !editable.has(key))) throw fail('Update needs editable step fields. Use move, dependencies or choose for relationships.');
      if (own(operation.patch, 'status') && (step.kind || 'action') !== 'action') throw fail('A group’s status derives from its child actions. Update the actual work instead.');
      for (const [key, value] of Object.entries(operation.patch)) {
        if (value === null && clearable.has(key)) delete step[key];
        else step[key] = structuredClone(value);
      }
    } else if (operation.type === 'remove') {
      const removed = planningScope(steps, step.id);
      for (let index = steps.length - 1; index >= 0; index--) if (removed.has(steps[index].id)) steps.splice(index, 1);
    } else if (operation.type === 'move') {
      if (!own(operation, 'parentId')) throw fail('Move needs the destination parentId, or null for the root.');
      const parentId = operation.parentId; if (parentId !== null) id(parentId);
      if (options.scopeStepId) checkOwner(parentId);
      const subtree = planningScope(steps, step.id);
      if (subtree.has(parentId) || subtree.has(operation.beforeId)) throw fail('A step cannot be moved inside or before its own subtree.');
      const moving = steps.filter(item => subtree.has(item.id));
      for (let index = steps.length - 1; index >= 0; index--) if (subtree.has(steps[index].id)) steps.splice(index, 1);
      step.parentId = parentId; insert(moving, parentId, operation.beforeId);
    } else if (operation.type === 'dependencies') step.dependsOn = structuredClone(operation.dependsOn);
    else if (operation.type === 'choose') {
      if (!own(operation, 'selectedChildId')) throw fail('Choose needs a child ID or null to clear the selection.');
      step.selectedChildId = operation.selectedChildId;
    }
  }
  keepExecutionScopes(state, steps);
  validateScope(state.steps, steps, options.scopeStepId);
  if (!steps.length) {
    if (options.source !== 'human') throw fail('Keep at least one actionable step in the live plan.');
    const scaffold = runtimeTaskPlan(plan.detail); scaffold.plan.layout = plan.layout;
    return { ...scaffold, steps: [], goal };
  }
  if (steps.length > TASK_PLAN_LIMITS.nodes) throw fail('The plan exceeds its supported node limit.', 'TASK_PLAN_LIMIT', 413);
  for (const step of steps) if (step.kind && step.kind !== 'action') { step.status = 'pending'; delete step.blockedReason; delete step.skipReason; }
  return { ...normalizeTaskPlan({ plan, steps }, { previous: state, actor: options, artifacts: state.artifacts }), goal };
}

/** A scoped plan replaces only the worker's own children, retaining all other authors. */
export function replaceOwnedPlan(state, value, options) {
  const scope = planningScope(state.steps, options.scopeStepId), root = state.steps.find(step => step.id === options.scopeStepId);
  if (!root || !Array.isArray(value.steps) || !value.steps.length) throw fail('Read the current assigned group and supply its actionable child plan.', 'TASK_PLAN_OWNERSHIP', 403);
  const outside = value.steps.filter(step => !scope.has(step.id) && state.steps.some(old => old.id === step.id));
  for (const step of outside) if (JSON.stringify(step) !== JSON.stringify(state.steps.find(old => old.id === step.id))) throw fail('A worker plan cannot replace another owner’s work.', 'TASK_PLAN_OWNERSHIP', 403);
  const supplied = structuredClone(value.steps.filter(step => !outside.includes(step)));
  const replacementRoot = supplied.find(step => step.id === root.id) || { ...root, kind: value.plan?.layout || (root.kind === 'action' ? 'sequence' : root.kind), ...(value.plan && own(value.plan, 'selectedChildId') ? { selectedChildId: value.plan.selectedChildId } : {}) };
  replacementRoot.parentId = root.parentId;
  const children = supplied.filter(step => step.id !== root.id).map(step => ({ ...step, parentId: step.parentId == null ? root.id : step.parentId }));
  const proposed = state.steps.flatMap(step => step.id === root.id ? [replacementRoot, ...children] : scope.has(step.id) ? [] : [step]);
  keepExecutionScopes(state, proposed); validateScope(state.steps, proposed, options.scopeStepId);
  for (const step of proposed) if (step.kind && step.kind !== 'action') { step.status = 'pending'; delete step.blockedReason; delete step.skipReason; }
  return normalizeTaskPlan({ plan: state.plan, steps: proposed }, { previous: state, actor: options, artifacts: state.artifacts });
}
