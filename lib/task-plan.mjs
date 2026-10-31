// The saved plan is shared by people and agents. Execution bindings may use
// its dependencies, but edits never grant tools or manufacture runtime outcomes.
import { checkPlanningEvidenceLength } from './planning-evidence.mjs';
import { normalizePlanningFacts, normalizePlanningBranch, evaluatePlanningBranch } from './planning-logic.mjs';
export const TASK_PLAN_VERSION = 1;
export const TASK_PLAN_LIMITS = Object.freeze({ nodes: 200, depth: 8, dependencies: 199, artifactLinks: 20, stateChars: 256000 });
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
// General decision vocabulary. The three job-search labels remain readable and
// editable in older saved plans; new plans should normally use generic kinds.
export const DECISION_CRITERION_KINDS = Object.freeze([
  'hard_gate','material_barrier','adaptable_gap','stated_requirement',
  'preference','unverified',
  'substantial_skill','trainable_skill','employer_wishlist'
]);
export const DECISION_CRITERION_SOURCES = Object.freeze(['user','external','analyst','employer']);
export const DECISION_EVIDENCE_STATES = Object.freeze([
  'confirmed','reported','inferred','unknown','contradicted'
]);
// Optional, deliberately small: the live plan is not a mandatory introspection form.
export const METACOGNITION_FIELDS = Object.freeze([
  'outcome','keyUncertainty','nextProbe','goodEnough','reassessWhen','observation','lesson'
]);
export function normalizeMetacognitionFrame(value) {
  if (value === null) return null;
  if (!object(value) || Object.keys(value).some(key => !METACOGNITION_FIELDS.includes(key)))
    throw fail('The judgment frame accepts only documented outcome, uncertainty, probe, sufficiency, reassessment and learning fields.');
  const result = {};
  for (const key of METACOGNITION_FIELDS) if (own(value,key)) {
    if (value[key] === null) continue;
    const string = text(value[key], key, 700);
    if (string) result[key] = string;
  }
  return Object.keys(result).length ? result : null;
}
export function normalizeDecisionCriteria(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > 24)
    throw fail('Decision criteria must have at most 24 classified entries.');
  const seen = new Set();
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key=>!['id','label','kind','source','basis','priority','verifiedNonNegotiable','evidenceStatus'].includes(key)))
      throw fail('Decision criteria need supported fields only.');
    const key = id(item.id,'Criterion ID');
    if (seen.has(key)) throw fail('Decision criterion IDs must be unique.');
    seen.add(key);
    const label = text(item.label,'Decision criterion',180,true);
    if (!DECISION_CRITERION_KINDS.includes(item.kind))
      throw fail('Classify the criterion as a real gate, material barrier, adaptable gap, stated requirement, preference or unresolved fact. Legacy skill/wishlist labels are also supported.');
    if (!DECISION_CRITERION_SOURCES.includes(item.source))
      throw fail('Attribute each criterion to the user, external source, employer or analyst inference.');
    const basis = text(item.basis,'Criterion basis',700,true);
    const priority = item.priority === undefined ? 3 : item.priority;
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 5)
      throw fail('Criterion priority must be from 1 to 5.');
    if (item.verifiedNonNegotiable !== undefined && typeof item.verifiedNonNegotiable !== 'boolean')
      throw fail('Verified non-negotiability must be true or false.');
    if (item.kind === 'hard_gate' && item.source === 'analyst')
      throw fail('An analyst inference cannot become a hard gate without user or employer evidence.');
    if (item.kind === 'hard_gate' && ['external','employer'].includes(item.source) && item.verifiedNonNegotiable !== true)
      throw fail('An external or employer requirement is not automatically a hard gate. Verify actual non-negotiability beyond its wording.');
    if (item.evidenceStatus !== undefined && !DECISION_EVIDENCE_STATES.includes(item.evidenceStatus))
      throw fail('Evidence status must distinguish confirmed, reported, inferred, unknown or contradicted.');
    return { id:key,label,kind:item.kind,source:item.source,basis,priority,
      ...(item.verifiedNonNegotiable === undefined ? {} : {verifiedNonNegotiable:item.verifiedNonNegotiable}),
      ...(item.evidenceStatus === undefined ? {} : {evidenceStatus:item.evidenceStatus}) };
  });
}

const terminal = step => ['done', 'skipped'].includes(step.status);
const sameWork = (a, b) => a?.title === b.title && a?.doneWhen === b.doneWhen && a?.result === b.result && JSON.stringify(a?.operation) === JSON.stringify(b.operation);

export function normalizePlanningOperation(value) {
  if (!object(value) || Object.keys(value).some(key => !['kind', 'tool', 'action', 'target'].includes(key)) || !['tool', 'reasoning'].includes(value.kind))
    throw fail('An operation must be one object with kind tool or reasoning, target, and optional tool/action fields.');
  const result = { kind: value.kind, target: text(value.target, 'Operation target', 1000, true) };
  if (value.kind === 'tool') {
    if (typeof value.tool !== 'string' || !/^relay_[a-z_]{1,60}$/.test(value.tool)) throw fail('A tool operation needs one relay_ tool name.');
    result.tool = value.tool;
    if (own(value, 'action')) result.action = text(value.action, 'Operation action', 120, true);
  } else if (own(value, 'tool') || own(value, 'action')) throw fail('A reasoning operation cannot specify a tool or tool action.');
  return result;
}

export function normalizePlanningReconciliation(value) {
  if (!object(value) || Object.keys(value).some(key => !['callId', 'outcome', 'evidence'].includes(key)) || typeof value.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$/.test(value.callId) || !['confirmed', 'absent'].includes(value.outcome))
    throw fail('Reconciliation needs one execution callId, outcome confirmed or absent, and actual observation evidence.');
  return { callId: value.callId, outcome: value.outcome, evidence: text(value.evidence, 'Reconciliation evidence', 2000, true) };
}

const attemptFields = ['attempt', 'pastAttempts', 'pastAttemptsOmitted'];
const snapshotFields = ['result', 'note', 'doneWhen', 'evidence', 'blockedReason', 'skipReason', 'operation', 'reconciliation'];
const snapshotTextLimits = { result: 1000, note: 700, doneWhen: 1000, evidence: 2000, blockedReason: 1000, skipReason: 1000 };
function restoreAttemptHistory(step, supplied, old, revisited) {
  if (!old) {
    if (attemptFields.some(key => own(supplied, key))) throw fail('Attempt history is recorded by revisit, not authored on a new step.');
    return;
  }
  if (!revisited) {
    for (const key of attemptFields) if (old[key] !== undefined) step[key] = structuredClone(old[key]);
    return;
  }
  const oldAttempt = old.attempt || 1;
  if (!Number.isSafeInteger(supplied.attempt) || supplied.attempt !== oldAttempt + 1) throw fail('Revisit must advance the current attempt exactly once.');
  if (!Array.isArray(supplied.pastAttempts) || !supplied.pastAttempts.length || supplied.pastAttempts.length > 8) throw fail('Revisit must retain up to eight bounded previous attempts.');
  const history = supplied.pastAttempts.map(entry => {
    if (!object(entry) || Object.keys(entry).some(key => !['attempt', 'status', 'at', 'reason', ...snapshotFields].includes(key)) || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || !TASK_PLAN_STATUSES.includes(entry.status)) throw fail('A previous attempt needs its attempt number, status, timestamp, reason and recorded work only.');
    if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || new Date(entry.at).toISOString() !== entry.at) throw fail('A previous attempt needs an ISO timestamp.');
    const snapshot = { attempt: entry.attempt, status: entry.status, at: entry.at, reason: text(entry.reason, 'Revisit reason', 1000, true) };
    for (const [key, limit] of Object.entries(snapshotTextLimits)) if (entry[key] !== undefined) snapshot[key] = text(entry[key], `Previous ${key}`, limit);
    if (entry.operation !== undefined) snapshot.operation = normalizePlanningOperation(entry.operation);
    if (entry.reconciliation !== undefined) snapshot.reconciliation = normalizePlanningReconciliation(entry.reconciliation);
    return snapshot;
  });
  const latest = history.at(-1), expectedHistory = [...(old.pastAttempts || []), latest].slice(-8);
  if (latest.attempt !== oldAttempt || latest.status !== old.status || snapshotFields.some(key => JSON.stringify(latest[key]) !== JSON.stringify(old[key]))) throw fail('Revisit must preserve the actual prior attempt, including its evidence and operation.');
  if (JSON.stringify(history) !== JSON.stringify(expectedHistory)) throw fail('Revisit cannot rewrite previous attempt history.');
  const omitted = (old.pastAttemptsOmitted || 0) + Math.max(0, (old.pastAttempts || []).length + 1 - 8);
  if ((supplied.pastAttemptsOmitted || 0) !== omitted) throw fail('Revisit must preserve the count of older omitted attempts.');
  step.attempt = supplied.attempt;
  step.pastAttempts = history;
  if (omitted) step.pastAttemptsOmitted = omitted;
}

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
  const criteria = Object.hasOwn(value,'decisionCriteria') ? value.decisionCriteria : previous.decisionCriteria;
  if (criteria !== undefined) plan.decisionCriteria=normalizeDecisionCriteria(criteria);
  const frame=own(value,'metacognition')?value.metacognition:previous.metacognition;
  if (frame !== undefined) {
    const normalized=normalizeMetacognitionFrame(frame);
    if (normalized) plan.metacognition=normalized;
  }
  const facts = own(value, 'facts') ? value.facts : previous.facts;
  if (facts !== undefined) plan.facts = normalizePlanningFacts(facts);
  const branch = own(value, 'branch') ? value.branch : previous.branch;
  if (branch !== undefined && branch !== null) plan.branch = normalizePlanningBranch(branch);
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

function makeTree(steps, plan, { previous } = {}) {
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
  const groups = new Map(), branchEvaluations = new Map(), previousById = new Map((previous?.steps || []).map(step => [step.id, step]));
  const group = key => groups.get(key);
  for (const key of [null, ...steps.filter(step => step.kind !== 'action').map(step => step.id)]) {
    const parent = key === null ? { ...plan, kind: plan.layout, id: null } : { ...byId.get(key) };
    groups.set(key, parent);
    if (parent.branch !== undefined) {
      if (parent.kind !== 'choice') throw fail('Only a choice group may contain an IF/ELIF/ELSE branch.');
      const branch = normalizePlanningBranch(parent.branch), paths = children.get(key);
      const branchIds = [branch.then, ...(branch.elif || []).map(clause => clause.then), branch.else];
      if (paths.length !== branchIds.length || branchIds.some(id => !paths.some(step => step.id === id))) throw fail(branchIds.length === 2 ? 'THEN and ELSE must name the two direct child paths of this choice.' : 'IF, ELIF and ELSE must name every direct child path of this choice exactly once.');
      const evaluation = evaluatePlanningBranch(branch, plan.facts || []);
      branchEvaluations.set(key, evaluation);
      if (parent.selectedChildId !== undefined && parent.selectedChildId !== evaluation.selectedChildId) {
        const prior = key === null ? previous?.plan : previousById.get(key);
        const carried = prior?.branch && parent.selectedChildId === prior.selectedChildId && prior.selectedChildId === evaluatePlanningBranch(prior.branch, previous?.plan?.facts || []).selectedChildId;
        if (!carried) throw fail('selectedChildId contradicts the Boolean branch. Record the facts and let IF/ELIF/ELSE select its path; unknown facts select neither path.');
      }
      if (evaluation.selectedChildId === null) delete parent.selectedChildId;
      else parent.selectedChildId = evaluation.selectedChildId;
    }
    const selected = parent.selectedChildId;
    if (selected !== undefined && (parent.kind !== 'choice' || !children.get(key).some(step => step.id === selected))) throw fail('selectedChildId must name a direct child of a choice group.');
    if (parent.kind === 'choice' && children.get(key).length < 2) throw fail('A choice needs at least two alternative child paths.');
  }
  if (plan.focusStepId !== undefined && !byId.has(plan.focusStepId)) throw fail('focusStepId must identify a saved plan step.');
  return { byId, children, ancestors, group, branchEvaluations };
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
    // Every earlier sibling constrains future work. An unchanged historical
    // completion may predate newly inserted work and cannot bridge past it.
    for (const parentId of ancestors.get(step.id)) {
      if (group(parentId).kind !== 'sequence') continue;
      const siblings = children.get(parentId), branch = [step.id, ...ancestors.get(step.id)].find(key => siblings.some(item => item.id === key));
      const index = siblings.findIndex(item => item.id === branch);
      for (let earlier = 0; earlier < index; earlier++) add(step.id, siblings[earlier].id, true);
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

function preservesCompletedAttempt(step, old, tree, previousTree, prerequisites, previousPrerequisites) {
  if (!previousTree || old?.status !== 'done' || step.status !== 'done'
    || (old.attempt || 1) !== (step.attempt || 1)) return false;
  for (const key of ['title', 'parentId', 'note', 'result', 'doneWhen', 'operation', 'evidence', 'condition']) {
    if (JSON.stringify(old[key]) !== JSON.stringify(step[key])) return false;
  }
  const explicit = values => [...values].filter(([, allowSkipped]) => !allowSkipped).map(([key]) => key).sort();
  if (JSON.stringify(explicit(prerequisites.get(step.id))) !== JSON.stringify(explicit(previousPrerequisites.get(step.id)))) return false;
  const choices = value => value.ancestors.get(step.id).filter(key => value.group(key).kind === 'choice')
    .map(key => { const group = value.group(key); return { id: key, branch: group.branch, selectedChildId: group.selectedChildId }; });
  return JSON.stringify(choices(tree)) === JSON.stringify(choices(previousTree));
}

function choiceRoute(step, tree) {
  const { ancestors, children, group } = tree;
  // An excluded outer path makes its inner decisions irrelevant, even when an
  // inner predicate has not been observed yet.
  for (const parentId of [...ancestors.get(step.id)].reverse()) {
    const parent = group(parentId); if (parent.kind !== 'choice') continue;
    const branch = [step.id, ...ancestors.get(step.id)].find(key => children.get(parentId).some(item => item.id === key));
    if (!parent.selectedChildId) return { state: 'awaiting-choice', choiceId: parentId, automatic: Boolean(parent.branch), evaluation: tree.branchEvaluations.get(parentId) };
    if (parent.selectedChildId !== branch) return { state: 'unselected', choiceId: parentId, automatic: Boolean(parent.branch), evaluation: tree.branchEvaluations.get(parentId) };
  }
  return { state: 'eligible' };
}
const choicePath = (step, tree) => choiceRoute(step, tree).state;

function deriveGroups(steps, tree, { rejectClaimedCompletion = false } = {}) {
  const ordered = steps.filter(step => step.kind !== 'action').sort((a, b) => tree.ancestors.get(b.id).length - tree.ancestors.get(a.id).length);
  for (const step of ordered) {
    const parent = tree.group(step.id), allChildren = tree.children.get(step.id), claimed = step.status;
    const children = parent.branch && parent.selectedChildId ? allChildren.filter(child => child.id === parent.selectedChildId) : allChildren;
    const allTerminal = children.every(terminal), allSkipped = children.every(child => child.status === 'skipped');
    if (rejectClaimedCompletion && claimed === 'done' && !allTerminal) throw fail('A group cannot be done while a descendant is unfinished. Update the actual child actions first.');
    if (rejectClaimedCompletion && claimed === 'skipped' && !allSkipped) throw fail('Skip each unused child path explicitly with its reason before the group can be skipped.');
    step.status = allSkipped ? 'skipped' : allTerminal ? 'done' : children.some(child => child.status === 'active') ? 'active' : children.some(child => child.status === 'blocked') ? 'blocked' : children.some(terminal) ? 'active' : 'pending';
    delete step.blockedReason; delete step.skipReason;
    if (step.status === 'blocked') step.blockedReason = children.find(child => child.status === 'blocked').blockedReason;
    if (step.status === 'skipped') step.skipReason = parent.branch && parent.selectedChildId ? 'The selected conditional path was explicitly skipped; inspect its recorded reason.' : 'Every child path was explicitly skipped; inspect their recorded reasons.';
  }
}

function independent(a, b, tree) {
  const left = [a.id, ...tree.ancestors.get(a.id)], right = new Set([b.id, ...tree.ancestors.get(b.id)]);
  const shared = left.find(value => right.has(value));
  return tree.group(shared).kind === 'parallel';
}

function protectBranchHistory(previous, tree, revisited) {
  if (!previous.steps?.length) return;
  const byId = new Map(previous.steps.map(step => [step.id, step]));
  const parents = [[null, previous.plan], ...previous.steps.filter(step => step.kind === 'choice').map(step => [step.id, step])];
  for (const [key, parent] of parents) {
    // Legacy manual choices retain their existing representation. Structured
    // decisions cannot silently make their already attempted path disappear.
    if (!parent?.branch) continue;
    const selected = evaluatePlanningBranch(parent.branch, previous.plan?.facts || []).selectedChildId;
    if (!selected || selected === tree.group(key)?.selectedChildId) continue;
    if (key === null) {
      const previousRoots = previous.steps.filter(step => step.parentId == null).map(step => step.id);
      const preserved = [...tree.byId.values()].find(step => {
        if (step.kind !== 'choice' || step.parentId !== null || JSON.stringify(step.branch) !== JSON.stringify(parent.branch) || tree.group(step.id)?.selectedChildId !== selected || choicePath(step, tree) !== 'eligible') return false;
        const children = tree.children.get(step.id);
        return children.length === previousRoots.length && children.every((child, index) => child.id === previousRoots[index]);
      });
      // Shared workflow binding can put the entire old root choice beneath an
      // explicit history group. Its same condition, children and chosen path
      // are still present; this is not a new decision or a replay of old work.
      if (preserved) continue;
    }
    for (const old of previous.steps) {
      if ((old.kind || 'action') !== 'action' || !['active', 'blocked', 'done'].includes(old.status)) continue;
      let cursor = old;
      while (cursor && cursor.id !== selected) cursor = byId.get(cursor.parentId);
      if (cursor && (!revisited.has(old.id) || !tree.byId.has(old.id))) throw fail('Changing a Boolean branch with attempted work requires explicit revisit of the affected actions so their prior results remain recorded.', 'TASK_PLAN_REVISIT_REQUIRED', 409);
    }
  }
}

/** Validate a proposed agent plan without changing any stored state. */
export function normalizeTaskPlan(value, { previous = {}, actor = {}, artifacts = [], maxChars = TASK_PLAN_LIMITS.stateChars, executionGuardrails = false } = {}) {
  if (!object(value) || !Array.isArray(value.steps)) throw fail('A plan needs an array of steps.');
  if (!value.steps.length || value.steps.length > TASK_PLAN_LIMITS.nodes) throw fail(`An agent plan needs from 1 to ${TASK_PLAN_LIMITS.nodes} steps. Use one action for a simple request.`, 'TASK_PLAN_LIMIT', 413);
  const plan = metadata(value.plan, previous.plan, actor), seen = new Set(), oldSteps = new Map((previous.steps || []).map(step => [step.id, step])), artifactSet = new Set(artifacts.map(item => item.id));
  const revisited = new Set(Array.isArray(actor.revisitedStepIds) ? actor.revisitedStepIds : []);
  const legacyCompletedIds = [], legacyCriteriaIds = [], steps = []; let length = JSON.stringify(plan).length + 2;
  for (let index = 0; index < value.steps.length; index++) {
    const supplied = value.steps[index]; if (!object(supplied)) throw fail('Each plan step must be an object.');
    const step = { id: id(supplied.id ?? `step-${index + 1}`), title: text(supplied.title, 'Step title', 300, true), parentId: supplied.parentId === undefined || supplied.parentId === null ? null : id(supplied.parentId, 'Parent ID'), kind: supplied.kind ?? 'action', status: supplied.status ?? 'pending', dependsOn: ids(supplied.dependsOn ?? [], 'Dependencies', TASK_PLAN_LIMITS.dependencies) };
    if (seen.has(step.id)) throw fail('Plan step identifiers must be unique.'); seen.add(step.id);
    if (!TASK_PLAN_KINDS.includes(step.kind)) throw fail('Step kind must be action, sequence, parallel or choice.');
    if (!TASK_PLAN_STATUSES.includes(step.status)) throw fail('Step status must be pending, active, blocked, done or skipped.');
    if (supplied.evidence !== undefined) checkPlanningEvidenceLength(supplied.evidence);
    for (const [key, label, max, required] of [['note', 'Step note', 700, false], ['doneWhen', 'Done when', 1000, true], ['evidence', 'Step evidence', 2000, false], ['blockedReason', 'Blocked reason', 1000, true], ['skipReason', 'Skip reason', 1000, true], ['condition', 'Branch condition', 1000, true], ['result', 'Expected result', 1000, true]]) if (supplied[key] !== undefined) step[key] = text(supplied[key], label, max, required);
    if (supplied.stepType !== undefined) step.stepType = vocabularyId(supplied.stepType, 'Step type');
    if (supplied.operation !== undefined) {
      if (step.kind !== 'action') throw fail('Only an action leaf may specify an operation.');
      step.operation = normalizePlanningOperation(supplied.operation);
    }
    if (supplied.reconciliation !== undefined) {
      if (step.kind !== 'action' || step.status !== 'done') throw fail('Only a done action may record reconciliation of an actually observed result.');
      step.reconciliation = normalizePlanningReconciliation(supplied.reconciliation);
    }
    if (supplied.branch !== undefined && supplied.branch !== null) {
      if (step.kind !== 'choice') throw fail('Only a choice group may contain an IF/ELIF/ELSE branch.');
      step.branch = normalizePlanningBranch(supplied.branch);
    }
    if (supplied.selectedChildId !== undefined && supplied.selectedChildId !== null) step.selectedChildId = id(supplied.selectedChildId, 'Selected child ID');
    if (supplied.artifactIds !== undefined) {
      step.artifactIds = ids(supplied.artifactIds, 'Artifact links', TASK_PLAN_LIMITS.artifactLinks);
      if (step.artifactIds.some(key => !artifactSet.has(key))) throw fail('Link only artifacts already registered to this task.', 'TASK_PLAN_ARTIFACT_MISSING', 404);
    }
    const old = oldSteps.get(step.id), changed = old && (old.status === 'done' && step.status !== 'done' || !sameWork(old, step));
    restoreAttemptHistory(step, supplied, old, revisited.has(step.id));
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
  const tree = makeTree(steps, plan, { previous }), prerequisites = relationships(steps, tree);
  const previousTree = previous.planVersion === TASK_PLAN_VERSION && previous.steps?.length ? makeTree(previous.steps, previous.plan) : null;
  const previousPrerequisites = previousTree ? relationships(previous.steps, previousTree) : null;
  for (const [key, evaluation] of tree.branchEvaluations) {
    const parent = key === null ? plan : tree.byId.get(key);
    if (evaluation.selectedChildId === null) delete parent.selectedChildId;
    else parent.selectedChildId = evaluation.selectedChildId;
  }
  if (executionGuardrails === true) protectBranchHistory(previous, tree, revisited);
  for (const step of steps) if (revisited.has(step.id) && step.status === 'blocked' && choicePath(step, tree) !== 'eligible') {
    // A reopened prerequisite can invalidate results in the former branch. The
    // saved previous attempt retains those effects; the now excluded current
    // attempt has not started and must not masquerade as a live blocker.
    step.status = 'pending';
    delete step.blockedReason;
  }
  deriveGroups(steps, tree, { rejectClaimedCompletion: true });
  const executionRequirements = previous.execution ? taskPlanAvailability({ planVersion: TASK_PLAN_VERSION, plan, steps, execution: previous.execution }).byId : null;
  const active = steps.filter(step => step.kind === 'action' && step.status === 'active');
  if (executionGuardrails === true) for (const step of steps.filter(step => step.kind === 'action')) {
    const historicalCompletion = preservesCompletedAttempt(step, oldSteps.get(step.id), tree, previousTree, prerequisites, previousPrerequisites);
    if (['active', 'blocked', 'done'].includes(step.status) && choicePath(step, tree) !== 'eligible') throw fail('Choose this branch explicitly before recording work on it. Unselected alternatives remain pending or explicitly skipped.');
    if (['active', 'done'].includes(step.status)) for (const [dependency, allowSkipped] of prerequisites.get(step.id)) {
      const required = tree.byId.get(dependency);
      const satisfied = executionRequirements ? executionRequirements[step.id].prerequisites.find(item => item.id === dependency).satisfied : required.status === 'done' || allowSkipped && required.status === 'skipped';
      // New sequence work changes what can run next, not what an unchanged
      // earlier attempt actually did. Explicit prerequisites still apply.
      if (!satisfied && !(allowSkipped && historicalCompletion)) throw fail(`Finish prerequisite “${required.title}” before activating or completing “${step.title}”.`, 'TASK_PLAN_PREREQUISITE', 409);
    }
  }
  if (executionGuardrails === true) for (let left = 0; left < active.length; left++) for (let right = left + 1; right < active.length; right++) if (!independent(active[left], active[right], tree)) throw fail('Multiple active actions must occupy separate paths of a parallel group.');
  if (JSON.stringify({ plan, steps }).length > maxChars) throw fail('This branching plan exceeds the saved continuity size limit. Shorten its details.', 'TASK_PLAN_LIMIT', 413);
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
  const eligible = [], awaitingChoice = [], unselected = [], conditionallySkipped = [], ready = [];
  for (const step of leaves) {
    const route = choiceRoute(step, tree);
    if (step.status === 'skipped') continue;
    if (route.state === 'awaiting-choice') awaitingChoice.push(step);
    else if (route.state === 'unselected') {
      unselected.push(step);
      if (route.automatic) conditionallySkipped.push(step);
    }
    else {
      eligible.push(step);
      if (step.status === 'pending' && [...prerequisites.get(step.id)].every(([dependency, allowSkipped]) => tree.byId.get(dependency).status === 'done' || allowSkipped && tree.byId.get(dependency).status === 'skipped')) ready.push(step);
    }
  }
  const active = eligible.filter(step => step.status === 'active'), blocked = eligible.filter(step => step.status === 'blocked');
  const focused = eligible.find(step => step.id === state.plan.focusStepId && !terminal(step));
  const choice = state.steps.find(step => step.kind === 'choice' && !tree.group(step.id).selectedChildId && step.status !== 'skipped' && choicePath(step, tree) === 'eligible');
  const current = focused || active[0] || blocked[0] || ready[0] || choice || eligible.find(step => !terminal(step)) || null;
  const done = eligible.filter(step => step.status === 'done').length, skipped = leaves.filter(step => step.status === 'skipped').length + conditionallySkipped.length;
  const unresolvedBranches = awaitingChoice.length + unselected.length - conditionallySkipped.length;
  return { total: eligible.length, done, skipped, current, active: active.map(step => step.id), eligible: eligible.map(step => step.id), ready: ready.map(step => step.id), awaitingChoice: awaitingChoice.map(step => step.id), unselected: unselected.map(step => step.id), ...(conditionallySkipped.length ? { conditionallySkipped: conditionallySkipped.map(step => step.id) } : {}), unresolvedBranches, complete: done > 0 && done === eligible.length && !unresolvedBranches, source: 'agent-reported-plan' };
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
    const route = choiceRoute(step, tree), missing = prerequisites.filter(item => !item.satisfied);
    const ownCondition = tree.branchEvaluations.get(step.id), condition = route.evaluation || ownCondition;
    const conditionReason = condition?.value === null ? [condition.missingFactIds.length ? `Observe the unresolved planning facts before choosing this path: ${condition.missingFactIds.join(', ')}.` : '', ...(condition.diagnostics || [])].filter(Boolean).join(' ') : '';
    let status = step.status, reason = '';
    if (status === 'blocked') reason = step.blockedReason || 'This work has a recorded blocker.';
    else if (!terminal(step) && route.state !== 'eligible') { status = route.state; reason = route.state === 'awaiting-choice' ? conditionReason || 'Choose a branch before starting this work.' : route.automatic ? 'The observed IF/ELIF/ELSE condition selects a different path; this path is conditionally skipped, not completed.' : 'A different branch is selected.'; }
    else if (!terminal(step) && missing.length) { status = 'waiting'; reason = 'Waiting for ' + missing.map(item => item.title).join(', ') + '.'; }
    else if (status === 'pending') {
      if (step.kind === 'choice' && !tree.group(step.id).selectedChildId) { status = 'awaiting-choice'; reason = conditionReason || 'Choose a branch before starting this work.'; }
      else { status = 'ready'; reason = 'Its prerequisites are satisfied; this work can proceed independently.'; }
    }
    if (step.kind === 'action' && status === 'ready') available.ready.push(step.id);
    if (step.kind === 'action' && status === 'active') available.active.push(step.id);
    if (step.kind === 'action' && ['waiting', 'blocked', 'awaiting-choice'].includes(status)) available.waiting.push(step.id);
    available.byId[step.id] = { state: status, reason, prerequisites, owner, ...(condition ? { condition: { ...condition, choiceId: route.evaluation ? route.choiceId : step.id } } : {}), execution: execution ? { status: execution.status, runId: state.execution.runId, nodeId: execution.nodeId, ...(execution.startedAt ? { startedAt: execution.startedAt } : {}), ...(execution.finishedAt ? { finishedAt: execution.finishedAt } : {}) } : null };
  }
  return available;
}
