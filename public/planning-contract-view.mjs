import { planningChoice } from './planning-mode.mjs';

const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const array = value => Array.isArray(value) ? value : [];
const statuses = { pending: 'pending', running: 'active', blocked: 'blocked', satisfied: 'done' };

/** A presentation projection of the canonical work items. It never writes legacy steps. */
export function contractTaskPlanView(state, { goal = '', runStatus = '', settled = false, planningMode = 'on', planningAvailable = true, planningStatus = '', planningMessage = '' } = {}) {
  const contract = state.contract, runtime = state.contractRuntime;
  const current = runtime?.version === 1 && runtime.planEpoch === contract.planEpoch;
  const runtimeItems = new Map((current ? array(runtime.workItems) : []).map(item => [item.id, item]));
  const actualCriteria = new Map((current ? array(runtime.criteria) : []).map(item => [item.id, item]));
  const criteria = array(contract.criteria).slice(0, 200).map(criterion => {
    const actual = actualCriteria.get(criterion.id);
    return { ...criterion, satisfied: actual?.satisfied === true, observedCount: count(actual?.observedCount),
      targetCount: count(actual?.targetCount) || count(criterion.targetCount) || 1,
      evidenceIds: array(actual?.evidenceIds).filter(value => typeof value === 'string'),
      reason: text(actual?.reason) || (current ? 'No supporting evidence recorded.' : 'Execution evidence is not current for this plan.') };
  });
  const byId = new Map(), total = Math.min(array(contract.workItems).length, 200);
  const nodes = array(contract.workItems).slice(0, 200).map((item, index) => {
    const actual = runtimeItems.get(item.id), workStatus = Object.hasOwn(statuses, actual?.status) ? actual.status : 'pending';
    const node = { ...item, source: item, contractWorkItem: true, workStatus, status: statuses[workStatus],
      id: text(item.id), title: text(item.title) || 'Work item ' + (index + 1),
      kind: 'work-item', isGroup: false, parentId: null, children: [], branch: 'included', order: index,
      depth: 1, number: String(index + 1), position: index + 1, siblingCount: total,
      dependsOn: array(item.dependsOn), owner: item.owner ? { nodeId: item.owner, label: item.owner } : null,
      criterionIds: array(item.criterionIds), evidenceIds: array(actual?.evidenceIds),
      operationCount: count(actual?.operationCount), unresolvedCount: count(actual?.unresolvedCount),
      blockedReason: text(actual?.blockedReason), ready: actual?.ready === true, eligible: actual?.ready === true,
      statusLabel: ({ pending: actual?.ready ? 'Ready' : 'Pending', running: 'Working', blocked: 'Blocked', satisfied: 'Satisfied' })[workStatus],
      resourceKeys: array(item.resourceKeys), effects: array(item.effects), objective: text(item.objective),
      leafCount: 0, doneCount: 0, skippedCount: 0, waitingOn: [] };
    byId.set(node.id, node); return node;
  });
  for (const node of nodes) node.waitingOn = node.dependsOn.map(id => byId.get(id)).filter(item => item && item.workStatus !== 'satisfied');
  const operations = array(runtime?.operations).slice(-160).map(value => ({
    operationId: text(value.operationId), workItemId: text(value.workItemId), runId: text(value.runId), nodeId: text(value.nodeId),
    tool: text(value.tool), action: text(value.action), journalSeq: count(value.journalSeq),
    deliveryState: text(value.deliveryState), effectState: text(value.effectState),
    startedAt: text(value.startedAt), finishedAt: text(value.finishedAt), success: typeof value.success === 'boolean' ? value.success : undefined,
    code: text(value.code), evidenceIds: array(value.evidenceIds).filter(value => typeof value === 'string'),
  }));
  const findings = array(runtime?.findings).slice(-100).filter(value => value?.disposition === 'audit').map(value => ({
    id: text(value.id), ruleId: text(value.ruleId), message: text(value.message), at: text(value.at), disposition: 'audit',
  }));
  const active = nodes.filter(item => item.workStatus === 'running'), blocked = nodes.filter(item => item.workStatus === 'blocked');
  const focuses = current ? array(runtime.focuses) : [], selected = byId.get(focuses.at(-1)?.workItemId);
  const focus = selected || active[0] || blocked[0] || nodes.find(item => item.ready) || nodes[0] || null;
  const progress = { total: nodes.length, done: nodes.filter(item => item.workStatus === 'satisfied').length, skipped: 0 };
  const unresolved = current ? array(runtime.unresolved).length : 0;
  const complete = current && criteria.length > 0 && criteria.every(item => item.satisfied) && progress.total > 0 && progress.done === progress.total && !unresolved;
  planningMode = planningStatus === 'off' ? 'off' : planningChoice(planningMode);
  const planningEnabled = planningMode !== 'off', live = ['queued', 'running', 'waiting'].includes(runStatus);
  const actualGoal = text(contract.goal) || text(state.goal) || text(goal), title = actualGoal.replace(/\s+/g, ' ').trim() || 'Your task';
  const phase = !planningEnabled ? 'paused' : blocked.length || unresolved ? 'blocked' : complete ? 'complete' : live ? 'working' : 'paused';
  return { state, plan: contract, contract, contractVersion: 2, runtimeCurrent: current, taskId: text(state.taskId), goal: actualGoal, title,
    nodes, byId, roots: nodes, leaves: nodes, includedLeaves: nodes, options: [], active, blocked, focus, progress, complete, live, settled,
    phase, origin: state.plan?.origin === 'human' ? 'human' : 'agent', unchosen: [], unresolvedBranches: 0, rootChoicePending: false,
    planningMode, planningEnabled, planningAvailable, planningStatus, planningMessage, method: null, runStatus,
    criteria, operations, findings, unresolved,
    omittedOperations: count(runtime?.omittedOperations) + Math.max(0, array(runtime?.operations).length - operations.length),
    journalSeq: count(runtime?.journalSeq), planEpoch: count(contract.planEpoch) };
}
