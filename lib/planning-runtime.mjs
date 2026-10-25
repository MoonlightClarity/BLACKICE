import { normalizeTaskPlan, taskPlanAvailability, TASK_PLAN_LIMITS } from './task-plan.mjs';

const fail = (message, code = 'INVALID_EXECUTION_PLAN', status = 400) => Object.assign(new Error(message), { code, status });
export const workflowScopeId = nodeId => `agent-${nodeId}`;

/** Bind an explicitly shared workflow to the same durable plan edited by people. */
export function bindWorkflowPlan(state, workflow, { runId, nodeStates = {} } = {}) {
  if (workflow.planning?.shared !== true) throw fail('This workflow did not opt into shared planning.');
  const agents = workflow.nodes.filter(node => node.type === 'agent'), byId = new Map(workflow.nodes.map(node => [node.id, node]));
  const coordinator = workflow.planning.coordinatorNodeId;
  if (!agents.some(node => node.id === coordinator)) throw fail('Shared planning needs one actual coordinator agent.');
  const incoming = nodeId => workflow.edges.filter(edge => edge.target === nodeId).map(edge => edge.source);
  const upstream = nodeId => {
    const found = new Set(), seen = new Set(), visit = key => {
      if (seen.has(key)) return; seen.add(key);
      if (byId.get(key)?.type === 'agent') found.add(key);
      else for (const parent of incoming(key)) visit(parent);
    };
    for (const key of incoming(nodeId)) visit(key);
    return [...found];
  };
  let steps = structuredClone(state.steps), plan = { ...(state.plan || {}), layout: 'parallel' };
  if (steps.length && !state.execution) {
    let historyId = 'prior-plan'; while (steps.some(step => step.id === historyId)) historyId += '-old';
    const history = { id: historyId, title: 'Existing saved work', kind: state.plan?.layout || 'sequence', parentId: null, status: 'pending', dependsOn: [], ...(state.plan?.selectedChildId ? { selectedChildId: state.plan.selectedChildId } : {}) };
    steps = [history, ...steps.map(step => ({ ...step, parentId: step.parentId ?? historyId }))];
  }
  delete plan.selectedChildId;
  const nodes = Object.create(null);
  for (const node of agents) {
    const scopeStepId = workflowScopeId(node.id), existing = steps.find(step => step.id === scopeStepId), assignment = node.assignment || {};
    if (existing && existing.kind === 'action') throw fail('An existing action conflicts with a workflow ownership group. Keep the saved plan and choose a different node ID.', 'TASK_PLAN_OWNERSHIP', 409);
    if (!existing) steps.push(
      { id: scopeStepId, title: node.name, kind: 'sequence', parentId: null, status: 'pending', dependsOn: upstream(node.id).map(workflowScopeId) },
      { id: `${scopeStepId}-work`, title: node.name, kind: 'action', parentId: scopeStepId, status: 'pending', dependsOn: [], doneWhen: assignment.doneWhen || 'The assigned result is produced and the worker records its actual checks and limits.', result: assignment.result || `Complete the assigned work for ${node.name}.`, note: String(assignment.scope || node.prompt).slice(0, 700) }
    );
    const status = ['completed', 'failed', 'cancelled', 'skipped'].includes(nodeStates[node.id]?.status) ? nodeStates[node.id].status : 'queued';
    nodes[node.id] = { scopeStepId, label: node.name, status, kind: 'workflow', ...(nodeStates[node.id]?.startedAt ? { startedAt: nodeStates[node.id].startedAt } : {}), ...(nodeStates[node.id]?.finishedAt ? { finishedAt: nodeStates[node.id].finishedAt } : {}) };
  }
  if (steps.length > TASK_PLAN_LIMITS.nodes) throw fail('This shared workflow exceeds the live plan node limit. Use fewer ownership groups or continue a smaller plan.', 'TASK_PLAN_LIMIT', 413);
  for (const step of steps) if (step.kind !== 'action') { step.status = 'pending'; delete step.blockedReason; delete step.skipReason; }
  const normalized = normalizeTaskPlan({ plan, steps }, { previous: state, artifacts: state.artifacts });
  normalized.plan.origin = 'workflow'; delete normalized.plan.authoredBy;
  return { ...state, ...normalized, execution: { runId, coordinatorNodeId: coordinator, nodes } };
}

/** A report cannot bypass an unfinished real upstream worker. */
export function executionReadiness(state, nodeId) {
  const binding = state.execution?.nodes?.[nodeId];
  if (!binding) return { ready: false, reason: 'This worker has no saved plan assignment.', dependencies: [] };
  const view = taskPlanAvailability(state), scope = view.byId[binding.scopeStepId];
  if (!scope) return { ready: false, reason: 'The assigned work is unavailable.', dependencies: [] };
  const dependencies = new Set();
  for (const prerequisite of scope.prerequisites) {
    const owner = view.byId[prerequisite.id]?.owner;
    if (owner && owner.nodeId !== nodeId) dependencies.add(owner.nodeId);
  }
  const ready = !['blocked', 'waiting', 'awaiting-choice', 'unselected', 'skipped'].includes(scope.state) && scope.prerequisites.every(item => item.satisfied);
  return { ready, reason: ready ? '' : scope.reason || 'The assigned path is not ready.', dependencies: [...dependencies] };
}
