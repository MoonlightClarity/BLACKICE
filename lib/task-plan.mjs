// The saved plan is shared by people and agents. Execution bindings may use
// its dependencies, but edits never grant tools or manufacture runtime outcomes.
export const TASK_PLAN_VERSION = 1;
export const TASK_PLAN_LIMITS = Object.freeze({ nodes: 200, depth: 8, dependencies: 199, artifactLinks: 20, stateChars: 64000 });
export const TASK_PLAN_KINDS = Object.freeze(['action', 'sequence', 'parallel', 'choice']);
export const TASK_PLAN_STATUSES = Object.freeze(['pending', 'active', 'blocked', 'done', 'skipped']);
export const TASK_PLAN_DETAILS = Object.freeze(['compact', 'balanced', 'detailed']);

const fail = (message, code = 'INVALID_TASK_PLAN', status = 400) => Object.assign(new Error(message), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const text = (value, name, max, required = false) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${name} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
};
const id = (value, name = 'Step ID') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail(`${name} must be a stable identifier of at most 120 letters, digits, underscores or hyphens.`);
  return value;
};
const vocabularyId = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fail(`${name} must be a saved identifier of at most 100 letters, digits, underscores or hyphens.`);
  return value;
};
const ids = (value, name, max) => {
  if (!Array.isArray(value) || value.length > max) throw fail(`${name} must have at most ${max} identifiers.`);
  const values = value.map(item => id(item, name));
  if (new Set(values).size !== values.length) throw fail(`${name} must contain unique identifiers.`);
  return values;
};
const terminal = step => ['done', 'skipped'].includes(step.status);
const sameWork = (a, b) => a?.title === b.title && a?.doneWhen === b.doneWhen && a?.result === b.result;

export function runtimeTaskPlan(detail = 'balanced') {
  if (!TASK_PLAN_DETAILS.includes(detail)) throw fail('Plan detail must be compact, balanced or detailed.');
  return { planVersion: TASK_PLAN_VERSION, plan: { origin: 'runtime', layout: 'sequence', detail, taskType: 'general' } };
}

function metadata(value = {}, previous = {}, actor = {}) {
  if (!object(value)) throw fail('Plan metadata must be an object.');
  const layout = value.layout ?? previous.layout ?? 'sequence', detail = value.detail ?? previous.detail ?? 'balanced';
  if (!TASK_PLAN_KINDS.includes(layout) || layout === 'action') throw fail('Root layout must be sequence, parallel or choice.');
  if (!TASK_PLAN_DETAILS.includes(detail)) throw fail('Plan detail must be compact, balanced or detailed.');
  const plan = { origin: actor.source === 'human' ? 'human' : 'agent', layout, detail, taskType: vocabularyId(value.taskType ?? previous.taskType ?? 'general', 'Task type') };
  for (const field of ['focusStepId', 'selectedChildId']) {
    const supplied = own(value, field) ? value[field] : previous[field];
    if (supplied !== undefined && supplied !== null) plan[field] = id(supplied, field);
  }
  const method = own(value, 'method') ? value.method : previous.method;
  if (method !== undefined && method !== null) {
    if (!object(method) || !Number.isSafeInteger(method.revision) || method.revision < 1) throw fail('A method reference needs its saved ID and positive revision.');
    plan.method = { id: vocabularyId(method.id, 'Method ID'), revision: method.revision, ...(method.name === undefined ? {} : { name: text(method.name, 'Method name', 160, true) }), ...(method.origin === undefined ? {} : { origin: text(method.origin, 'Method origin', 30, true) }) };
  }
  const authoredBy = {};
  for (const field of ['runId', 'nodeId']) if (actor[field] !== undefined) authoredBy[field] = id(actor[field], field);
  if (Object.keys(authoredBy).length) plan.authoredBy = authoredBy;
  return plan;
}

function makeTree(steps, plan) {
  const byId = new Map(steps.map(step => [step.id, step])), children = new Map([[null, []]]), ancestors = new Map();
  for (const step of steps) {
    if (step.parentId !== null && (!byId.has(step.parentId) || step.parentId === step.id)) throw fail('Every parentId must identify another saved step.');
    if (!children.has(step.parentId)) children.set(step.parentId, []);
    children.get(step.parentId).push(step);
    if (!children.has(step.id)) children.set(step.id, []);
  }
  for (const step of steps) {
    const chain = [], seen = new Set([step.id]); let cursor = step;
    while (cursor.parentId !== null) {
      if (seen.has(cursor.parentId)) throw fail('The plan hierarchy contains a cycle.');
      seen.add(cursor.parentId); chain.push(cursor.parentId); cursor = byId.get(cursor.parentId);
      if (chain.length >= TASK_PLAN_LIMITS.depth) throw fail(`Use at most ${TASK_PLAN_LIMITS.depth} nested plan levels.`, 'TASK_PLAN_LIMIT', 413);
    }
    ancestors.set(step.id, [...chain, null]);
    if (step.kind === 'action' && children.get(step.id).length) throw fail('An action cannot contain child steps. Change its kind to sequence, parallel or choice.');
    if (step.kind !== 'action' && !children.get(step.id).length) throw fail('A plan group needs child steps. Use an action for a single piece of work.');
  }
  const group = key => key === null ? { ...plan, kind: plan.layout, id: null } : byId.get(key);
  for (const key of [null, ...steps.filter(step => step.kind !== 'action').map(step => step.id)]) {
    const parent = group(key), selected = parent.selectedChildId;
    if (selected !== undefined && (parent.kind !== 'choice' || !children.get(key).some(step => step.id === selected))) throw fail('selectedChildId must name a direct child of a choice group.');
    if (parent.kind === 'choice' && children.get(key).length < 2) throw fail('A choice needs at least two alternative child paths.');
  }
  if (plan.focusStepId !== undefined && !byId.has(plan.focusStepId)) throw fail('focusStepId must identify a saved plan step.');
  return { byId, children, ancestors, group };
}

function relationships(steps, tree) {
  const { byId, children, ancestors, group } = tree;
  const prerequisites = new Map(steps.map(step => [step.id, new Map()]));
  const add = (target, dependency, allowSkipped) => {
    const values = prerequisites.get(target); values.set(dependency, values.has(dependency) ? values.get(dependency) && allowSkipped : allowSkipped);
  };
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency) || dependency === step.id) throw fail('Every dependency must identify another saved step.');
      if (ancestors.get(step.id).includes(dependency)) throw fail(`Step "${step.id}" cannot depend on its parent or ancestor "${dependency}": that creates a cycle. Remove that prerequisite because the ancestor completes only after its children. Sequence groups already order their sibling steps.`);
    }
    for (const ancestorId of [step.id, ...ancestors.get(step.id).filter(value => value !== null)]) {
      for (const dependency of byId.get(ancestorId).dependsOn) add(step.id, dependency, false);
    }
    // A sequence constrains each descendant's start, not only its group label.
    for (const parentId of ancestors.get(step.id)) {
      if (group(parentId).kind !== 'sequence') continue;
      const siblings = children.get(parentId), branch = [step.id, ...ancestors.get(step.id)].find(key => siblings.some(item => item.id === key));
      const index = siblings.findIndex(item => item.id === branch);
      if (index > 0) add(step.id, siblings[index - 1].id, true);
    }
  }
  // Completion of a group requires its descendants. Combining these edges with
  // explicit prerequisites catches cycles that cross a hierarchy boundary.
  const graph = new Map([...prerequisites].map(([key, values]) => [key, new Set(values.keys())]));
  for (const step of steps) for (const child of children.get(step.id)) graph.get(step.id).add(child.id);
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    if (visiting.has(key)) throw fail('Plan dependencies and sequence order contain a cycle.');
    if (visited.has(key)) return;
    visiting.add(key); for (const dependency of graph.get(key)) visit(dependency); visiting.delete(key); visited.add(key);
  }
  for (const step of steps) visit(step.id);
  return prerequisites;
}

function choicePath(step, tree) {
  const { ancestors, children, group } = tree;
  for (const parentId of ancestors.get(step.id)) {
    const parent = group(parentId); if (parent.kind !== 'choice') continue;
    const branch = [step.id, ...ancestors.get(step.id)].find(key => children.get(parentId).some(item => item.id === key));
    if (!parent.selectedChildId) return 'awaiting-choice';
    if (parent.selectedChildId !== branch) return 'unselected';
  }
  return 'eligible';
}

function deriveGroups(steps, tree, { rejectClaimedCompletion = false } = {}) {
  const ordered = steps.filter(step => step.kind !== 'action').sort((a, b) => tree.ancestors.get(b.id).length - tree.ancestors.get(a.id).length);
  for (const step of ordered) {
    const children = tree.children.get(step.id), claimed = step.status;
    const allTerminal = children.every(terminal), allSkipped = children.every(child => child.status === 'skipped');
    if (rejectClaimedCompletion && claimed === 'done' && !allTerminal) throw fail('A group cannot be done while a descendant is unfinished. Update the actual child actions first.');
    if (rejectClaimedCompletion && claimed === 'skipped' && !allSkipped) throw fail('Skip each unused child path explicitly with its reason before the group can be skipped.');
    step.status = allSkipped ? 'skipped' : allTerminal ? 'done' : children.some(child => child.status === 'active') ? 'active' : children.some(child => child.status === 'blocked') ? 'blocked' : children.some(terminal) ? 'active' : 'pending';
    delete step.blockedReason; delete step.skipReason;
    if (step.status === 'blocked') step.blockedReason = children.find(child => child.status === 'blocked').blockedReason;
    if (step.status === 'skipped') step.skipReason = 'Every child path was explicitly skipped; inspect their recorded reasons.';
  }
}

function independent(a, b, tree) {
  const left = [a.id, ...tree.ancestors.get(a.id)], right = new Set([b.id, ...tree.ancestors.get(b.id)]);
  const shared = left.find(value => right.has(value));
  return tree.group(shared).kind === 'parallel';
}

/** Validate a proposed agent plan without changing any stored state. */
export function normalizeTaskPlan(value, { previous = {}, actor = {}, artifacts = [], maxChars = TASK_PLAN_LIMITS.stateChars } = {}) {
  if (!object(value) || !Array.isArray(value.steps)) throw fail('A plan needs an array of steps.');
  if (!value.steps.length || value.steps.length > TASK_PLAN_LIMITS.nodes) throw fail(`An agent plan needs from 1 to ${TASK_PLAN_LIMITS.nodes} steps. Use one action for a simple request.`, 'TASK_PLAN_LIMIT', 413);
  const plan = metadata(value.plan, previous.plan, actor), seen = new Set(), oldSteps = new Map((previous.steps || []).map(step => [step.id, step])), artifactSet = new Set(artifacts.map(item => item.id));
  const legacyCompletedIds = [], legacyCriteriaIds = [], steps = []; let length = JSON.stringify(plan).length + 2;
  for (let index = 0; index < value.steps.length; index++) {
    const supplied = value.steps[index]; if (!object(supplied)) throw fail('Each plan step must be an object.');
    const step = { id: id(supplied.id ?? `step-${index + 1}`), title: text(supplied.title, 'Step title', 300, true), parentId: supplied.parentId === undefined || supplied.parentId === null ? null : id(supplied.parentId, 'Parent ID'), kind: supplied.kind ?? 'action', status: supplied.status ?? 'pending', dependsOn: ids(supplied.dependsOn ?? [], 'Dependencies', TASK_PLAN_LIMITS.dependencies) };
    if (seen.has(step.id)) throw fail('Plan step identifiers must be unique.'); seen.add(step.id);
    if (!TASK_PLAN_KINDS.includes(step.kind)) throw fail('Step kind must be action, sequence, parallel or choice.');
    if (!TASK_PLAN_STATUSES.includes(step.status)) throw fail('Step status must be pending, active, blocked, done or skipped.');
    for (const [key, label, max, required] of [['note', 'Step note', 700, false], ['doneWhen', 'Done when', 1000, true], ['evidence', 'Step evidence', 2000, false], ['blockedReason', 'Blocked reason', 1000, true], ['skipReason', 'Skip reason', 1000, true], ['condition', 'Branch condition', 1000, true], ['result', 'Expected result', 1000, true]]) if (supplied[key] !== undefined) step[key] = text(supplied[key], label, max, required);
    if (supplied.stepType !== undefined) step.stepType = vocabularyId(supplied.stepType, 'Step type');
    if (supplied.selectedChildId !== undefined && supplied.selectedChildId !== null) step.selectedChildId = id(supplied.selectedChildId, 'Selected child ID');
    if (supplied.artifactIds !== undefined) {
      step.artifactIds = ids(supplied.artifactIds, 'Artifact links', TASK_PLAN_LIMITS.artifactLinks);
      if (step.artifactIds.some(key => !artifactSet.has(key))) throw fail('Link only artifacts already registered to this task.', 'TASK_PLAN_ARTIFACT_MISSING', 404);
    }
    const old = oldSteps.get(step.id), changed = old && (old.status === 'done' && step.status !== 'done' || !sameWork(old, step));
    if (changed && step.evidence === old.evidence) delete step.evidence;
    if (step.kind === 'action') {
      if (!step.doneWhen) {
        const legacy = previous.planVersion !== TASK_PLAN_VERSION || previous.plan?.legacyCriteriaIds?.includes(step.id);
        if (legacy && old && sameWork(old, step)) legacyCriteriaIds.push(step.id);
        else throw fail('An action needs a short observable doneWhen criterion. Use one clear result for a simple request.');
      }
      if (step.status === 'blocked' && !step.blockedReason) throw fail('A blocked action needs the actual reason it cannot proceed.');
      if (step.status === 'skipped' && !step.skipReason) throw fail('A skipped action needs an explicit reason; unused branches are not completed work.');
      if (step.status === 'done' && !step.evidence?.trim()) {
        const legacy = previous.planVersion !== TASK_PLAN_VERSION || previous.plan?.legacyCompletedIds?.includes(step.id);
        if (legacy && old?.status === 'done' && sameWork(old, step)) legacyCompletedIds.push(step.id);
        else throw fail('A done action needs actual evidence of the result or check, including any limits.');
      }
      if (step.selectedChildId !== undefined) throw fail('Only a choice group can select a child path.');
      if (step.status !== 'blocked') delete step.blockedReason;
      if (step.status !== 'skipped') delete step.skipReason;
    }
    length += JSON.stringify(step).length + 1;
    if (length > maxChars) throw fail('This branching plan exceeds the saved continuity size limit. Shorten its details.', 'TASK_PLAN_LIMIT', 413);
    steps.push(step);
  }
  if (!steps.some(step => step.kind === 'action')) throw fail('An agent plan needs at least one action.');
  if (legacyCompletedIds.length) plan.legacyCompletedIds = legacyCompletedIds;
  if (legacyCriteriaIds.length) plan.legacyCriteriaIds = legacyCriteriaIds;
  const tree = makeTree(steps, plan), prerequisites = relationships(steps, tree);
  deriveGroups(steps, tree, { rejectClaimedCompletion: true });
  const executionRequirements = previous.execution ? taskPlanAvailability({ planVersion: TASK_PLAN_VERSION, plan, steps, execution: previous.execution }).byId : null;
  const active = steps.filter(step => step.kind === 'action' && step.status === 'active');
  for (const step of steps.filter(step => step.kind === 'action')) {
    if (['active', 'blocked', 'done'].includes(step.status) && choicePath(step, tree) !== 'eligible') throw fail('Choose this branch explicitly before recording work on it. Unselected alternatives remain pending or explicitly skipped.');
    if (['active', 'done'].includes(step.status)) for (const [dependency, allowSkipped] of prerequisites.get(step.id)) {
      const required = tree.byId.get(dependency);
      const satisfied = executionRequirements ? executionRequirements[step.id].prerequisites.find(item => item.id === dependency).satisfied : required.status === 'done' || allowSkipped && required.status === 'skipped';
      if (!satisfied) throw fail(`Finish prerequisite “${required.title}” before activating or completing “${step.title}”.`, 'TASK_PLAN_PREREQUISITE', 409);
    }
  }
  for (let left = 0; left < active.length; left++) for (let right = left + 1; right < active.length; right++) if (!independent(active[left], active[right], tree)) throw fail('Multiple active actions must occupy separate paths of a parallel group.');
  return { planVersion: TASK_PLAN_VERSION, plan, steps };
}

/** Counts action leaves only. A selected alternative is never a skipped fact. */
export function taskPlanProgress(state) {
  if (state.planVersion !== TASK_PLAN_VERSION) {
    const steps = state.steps || [];
    return { total: steps.length, done: steps.filter(step => step.status === 'done').length, current: steps.find(step => step.status === 'active') || steps.find(step => step.status === 'blocked') || steps.find(step => step.status === 'pending') || null, source: 'agent-reported-plan' };
  }
  if (!state.steps.length) return { total: 0, done: 0, skipped: 0, current: null, active: [], eligible: [], ready: [], awaitingChoice: [], unselected: [], unresolvedBranches: 0, complete: false, source: 'runtime-plan-scaffold' };
  const tree = makeTree(state.steps, state.plan), prerequisites = relationships(state.steps, tree), leaves = state.steps.filter(step => step.kind === 'action');
  const eligible = [], awaitingChoice = [], unselected = [], ready = [];
  for (const step of leaves) {
    const route = choicePath(step, tree);
    if (step.status === 'skipped') continue;
    if (route === 'awaiting-choice') awaitingChoice.push(step);
    else if (route === 'unselected') unselected.push(step);
    else {
      eligible.push(step);
      if (step.status === 'pending' && [...prerequisites.get(step.id)].every(([dependency, allowSkipped]) => tree.byId.get(dependency).status === 'done' || allowSkipped && tree.byId.get(dependency).status === 'skipped')) ready.push(step);
    }
  }
  const active = eligible.filter(step => step.status === 'active'), blocked = eligible.filter(step => step.status === 'blocked');
  const focused = eligible.find(step => step.id === state.plan.focusStepId && !terminal(step));
  const choice = state.steps.find(step => step.kind === 'choice' && !step.selectedChildId && step.status !== 'skipped');
  const current = focused || active[0] || blocked[0] || ready[0] || choice || eligible.find(step => !terminal(step)) || null;
  const done = eligible.filter(step => step.status === 'done').length, skipped = leaves.filter(step => step.status === 'skipped').length;
  return { total: eligible.length, done, skipped, current, active: active.map(step => step.id), eligible: eligible.map(step => step.id), ready: ready.map(step => step.id), awaitingChoice: awaitingChoice.map(step => step.id), unselected: unselected.map(step => step.id), unresolvedBranches: awaitingChoice.length + unselected.length, complete: done > 0 && done === eligible.length && !awaitingChoice.length && !unselected.length, source: 'agent-reported-plan' };
}

/** Read-only readiness shared by the editor, agent and runtime dispatcher. */
export function taskPlanAvailability(state) {
  const available = { ready: [], active: [], waiting: [], byId: {} };
  if (!state.steps?.length) return available;
  const steps = state.planVersion === TASK_PLAN_VERSION ? state.steps : state.steps.map(step => ({ ...step, parentId: null, kind: 'action', dependsOn: [] }));
  const tree = makeTree(steps, state.plan || { layout: 'sequence' }), requirements = relationships(steps, tree);
  const owners = new Map(Object.entries(state.execution?.nodes || {}).map(([nodeId, execution]) => [execution.scopeStepId, { nodeId, ...execution }]));
  for (const step of steps) {
    const execution = [step.id, ...tree.ancestors.get(step.id)].map(key => owners.get(key)).find(Boolean);
    const owner = execution ? { nodeId: execution.nodeId, label: execution.label, scopeStepId: execution.scopeStepId } : null;
    const prerequisites = [...requirements.get(step.id)].map(([key, allowSkipped]) => {
      const dependency = tree.byId.get(key), bound = [dependency.id, ...tree.ancestors.get(dependency.id)].map(id => owners.get(id)).find(Boolean);
      const reported = dependency.status === 'done' || allowSkipped && dependency.status === 'skipped';
      const outsideOwner = bound && bound.nodeId !== owner?.nodeId;
      const runtimeSatisfied = !outsideOwner || bound.status === 'completed';
      const satisfied = runtimeSatisfied && (outsideOwner && dependency.id === bound.scopeStepId || reported);
      return { id: key, title: dependency.title, status: dependency.status, satisfied: Boolean(satisfied), allowSkipped, ...(outsideOwner ? { executionStatus: bound.status } : {}) };
    });
    const route = choicePath(step, tree), missing = prerequisites.filter(item => !item.satisfied);
    let status = step.status, reason = '';
    if (status === 'blocked') reason = step.blockedReason || 'This work has a recorded blocker.';
    else if (!terminal(step) && route !== 'eligible') { status = route; reason = route === 'awaiting-choice' ? 'Choose a branch before starting this work.' : 'A different branch is selected.'; }
    else if (!terminal(step) && missing.length) { status = 'waiting'; reason = 'Waiting for ' + missing.map(item => item.title).join(', ') + '.'; }
    else if (status === 'pending') {
      if (step.kind === 'choice' && !step.selectedChildId) { status = 'awaiting-choice'; reason = 'Choose a branch before starting this work.'; }
      else { status = 'ready'; reason = 'Its prerequisites are satisfied; this work can proceed independently.'; }
    }
    if (step.kind === 'action' && status === 'ready') available.ready.push(step.id);
    if (step.kind === 'action' && status === 'active') available.active.push(step.id);
    if (step.kind === 'action' && ['waiting', 'blocked', 'awaiting-choice'].includes(status)) available.waiting.push(step.id);
    available.byId[step.id] = { state: status, reason, prerequisites, owner, execution: execution ? { status: execution.status, runId: state.execution.runId, nodeId: execution.nodeId, ...(execution.startedAt ? { startedAt: execution.startedAt } : {}), ...(execution.finishedAt ? { finishedAt: execution.finishedAt } : {}) } : null };
  }
  return available;
}
