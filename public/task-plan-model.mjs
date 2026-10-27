// Presentation state for the saved operational plan. This never infers completed
// work from a model response, tool message, or the end of a run.
import { normalizePlanningMode } from './planning-mode.mjs';
const STATUS = new Set(['pending', 'active', 'blocked', 'done', 'skipped']);
const GROUPS = new Set(['sequence', 'parallel', 'choice']);
const copySet = value => new Set(value instanceof Set ? value : Array.isArray(value) ? value : []);
const text = value => typeof value === 'string' ? value : '';
const finiteCount = value => Number.isSafeInteger(value) && value >= 0;

export const planKindLabel = kind => ({ sequence: 'Steps in order', parallel: 'Can run in parallel', choice: 'Choose a path', action: 'Step' }[kind] || 'Step');
export function savedPlanNotes(taskState) {
  const checkpoint = taskState?.checkpoint || {};
  return [['Next action', checkpoint.nextAction], ['Decisions', checkpoint.decisions], ['Completed', checkpoint.completed], ['Next steps', checkpoint.nextSteps], ['Open questions', checkpoint.openQuestions]].map(([label, value]) => ({ label, entries: (Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string' && value.trim()) })).filter(section => section.entries.length);
}

export function taskPlanView(taskState, { goal = '', runStatus = '', settled = false, planningMode = 'on', planningAvailable = true, planningStatus = '', planningMessage = '' } = {}) {
  const state = taskState || {}, plan = state.plan || {}, byId = new Map(), roots = [];
  planningMode = planningStatus === 'off' ? 'off' : normalizePlanningMode(planningMode);
  const planningEnabled = planningMode !== 'off';
  const live = ['queued', 'running', 'waiting'].includes(runStatus);
  for (const [index, step] of (Array.isArray(state.steps) ? state.steps : []).entries()) {
    if (!step || typeof step !== 'object') continue;
    const id = text(step.id) || `saved-step-${index + 1}`;
    if (byId.has(id)) continue;
    byId.set(id, { ...step, id, title: text(step.title) || `Step ${index + 1}`, status: STATUS.has(step.status) ? step.status : 'pending', parentId: text(step.parentId) || null, dependsOn: Array.isArray(step.dependsOn) ? [...new Set(step.dependsOn.filter(id => typeof id === 'string'))] : [], kind: GROUPS.has(step.kind) ? step.kind : 'action', children: [], order: index, source: step });
  }
  // Persisted plans are validated by the server. Tolerate an older imported
  // malformed relationship without losing a row or recursing indefinitely.
  for (const node of byId.values()) {
    const seen = new Set([node.id]); let parent = node.parentId;
    while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); parent = byId.get(parent).parentId; }
    if (parent && seen.has(parent) || node.parentId && !byId.has(node.parentId)) node.parentId = null;
  }
  for (const node of byId.values()) {
    const parent = node.parentId && byId.get(node.parentId);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const nodes = [], leaves = [], options = [];
  function walk(children, parent, branch = 'included', path = []) {
    const parentChoice = parent ? parent.kind === 'choice' : plan.layout === 'choice';
    const chosenId = parent ? parent.selectedChildId : plan.selectedChildId;
    for (const [index, node] of children.entries()) {
      node.depth = path.length + 1; node.number = [...path, index + 1].join('.'); node.position = index + 1; node.siblingCount = children.length;
      node.branch = branch !== 'included' ? branch : parentChoice ? chosenId ? chosenId === node.id ? 'included' : 'not-selected' : 'option' : 'included';
      node.isChoiceOption = parentChoice; node.isSelectedOption = parentChoice && chosenId === node.id;
      if (node.children.length && node.kind === 'action') node.kind = 'sequence';
      node.isGroup = GROUPS.has(node.kind); nodes.push(node);
      if (node.isChoiceOption) options.push(node);
      if (!node.isGroup) leaves.push(node);
      walk(node.children, node, node.branch, [...path, index + 1]);
    }
  }
  walk(roots, null);
  const includedLeaves = leaves.filter(node => node.branch === 'included');
  const savedEligible = Array.isArray(state.progress?.eligible) ? new Set(state.progress.eligible) : null;
  const savedReady = Array.isArray(state.progress?.ready) ? new Set(state.progress.ready) : null;
  for (const node of nodes) {
    const availability = state.availableWork?.byId?.[node.id];
    node.availability = availability && typeof availability === 'object' ? availability : null;
    node.owner = node.availability?.owner || null;
    node.execution = node.availability?.execution || null;
    node.waitingOn = node.dependsOn.map(id => byId.get(id)).filter(Boolean).filter(dependency => !['done', 'skipped'].includes(dependency.status));
    node.eligible = node.branch === 'included' && (savedEligible ? savedEligible.has(node.id) : node.waitingOn.length === 0);
    node.ready = node.branch === 'included' && (savedReady ? savedReady.has(node.id) : node.waitingOn.length === 0);
    node.statusLabel = node.status === 'skipped' ? 'Skipped' : node.branch === 'option' ? 'Option' : node.branch === 'not-selected' ? 'Not chosen' : node.status === 'active' ? live && planningEnabled ? 'Working' : 'Paused here' : node.status === 'blocked' ? 'Blocked' : node.status === 'done' ? 'Done' : node.waitingOn.length || !node.isGroup && savedReady && !node.ready ? 'Waiting' : 'Pending';
    if (node.availability) {
      node.ready = node.availability.state === 'ready';
      node.statusLabel = ({ ready: 'Ready', active: node.execution?.status === 'running' ? 'Working' : 'Active', blocked: 'Blocked', waiting: 'Waiting', 'awaiting-choice': 'Choose path', unselected: 'Not chosen', done: 'Done', skipped: 'Skipped' })[node.availability.state] || node.statusLabel;
    }
    const descendants = [];
    function descend(children) { for (const child of children) { if (child.isGroup) descend(child.children); else descendants.push(child); } }
    descend(node.children);
    node.leafCount = descendants.filter(child => child.branch === 'included' && child.status !== 'skipped').length; node.doneCount = descendants.filter(child => child.branch === 'included' && child.status === 'done').length; node.skippedCount = descendants.filter(child => child.status === 'skipped').length;
  }
  const recorded = state.progress || {}, calculated = { total: includedLeaves.filter(node => node.status !== 'skipped').length, done: includedLeaves.filter(node => node.status === 'done').length, skipped: leaves.filter(node => node.status === 'skipped').length };
  const useRecorded = finiteCount(recorded.total) && finiteCount(recorded.done) && recorded.done <= recorded.total && finiteCount(recorded.skipped ?? 0);
  const progress = useRecorded ? { total: recorded.total, done: recorded.done, skipped: recorded.skipped || 0 } : calculated;
  const active = includedLeaves.filter(node => node.status === 'active'), blocked = includedLeaves.filter(node => node.status === 'blocked');
  const actionable = node => node && node.branch === 'included' && !['done', 'skipped'].includes(node.status);
  const recordedFocus = byId.get(text(recorded.current?.id) || text(recorded.current)), preferredFocus = byId.get(text(plan.focusStepId));
  const focus = (actionable(recordedFocus) && recordedFocus) || (actionable(preferredFocus) && preferredFocus) || active[0] || blocked[0] || includedLeaves.find(node => node.status === 'pending' && node.eligible) || includedLeaves.find(node => node.status === 'pending') || nodes.find(node => node.branch === 'included' && node.kind === 'choice' && !node.selectedChildId && node.status !== 'skipped') || includedLeaves.at(-1) || roots[0] || null;
  const unchosen = nodes.filter(node => node.kind === 'choice' && node.branch === 'included' && !node.selectedChildId);
  const rootChoicePending = plan.layout === 'choice' && !plan.selectedChildId && roots.length > 0;
  const unresolvedBranches = finiteCount(recorded.unresolvedBranches) ? recorded.unresolvedBranches : leaves.filter(node => node.branch !== 'included' && node.status !== 'skipped').length;
  const complete = typeof recorded.complete === 'boolean' ? recorded.complete : progress.done > 0 && progress.done === progress.total && !unchosen.length && !rootChoicePending && !unresolvedBranches;
  const actualGoal = text(state.goal) || text(goal), title = actualGoal.replace(/\s+/g, ' ').trim() || 'Your task';
  const origin = plan.origin === 'human' || plan.origin === 'user' ? 'human' : plan.origin === 'runtime' || !nodes.length ? 'runtime' : 'agent';
  const phase = !planningEnabled ? nodes.length ? 'paused' : 'off' : !nodes.length ? !planningAvailable || planningStatus === 'unavailable' ? 'unavailable' : planningStatus === 'missing' ? 'missing' : live ? 'preparing' : 'empty' : blocked.length ? 'blocked' : complete ? 'complete' : unresolvedBranches && progress.total > 0 && progress.done === progress.total ? 'closing' : live ? 'working' : 'paused';
  return { state, plan, taskId: text(state.taskId), goal: actualGoal, title, nodes, byId, roots, leaves, includedLeaves, options, active, blocked, focus, progress, complete, live, settled, phase, origin, unchosen, unresolvedBranches, rootChoicePending, planningMode, planningEnabled, planningAvailable, planningStatus, planningMessage, method: plan.method || null, runStatus };
}

export function planAncestors(view, id) {
  const result = [], seen = new Set(); let current = view.byId.get(id);
  while (current?.parentId && !seen.has(current.parentId)) { seen.add(current.parentId); current = view.byId.get(current.parentId); if (current) result.unshift(current.id); }
  return result;
}

export function visiblePlanNodes(view, collapsed = new Set()) {
  const result = [];
  function walk(nodes) { for (const node of nodes) { result.push(node); if (!collapsed.has(node.id)) walk(node.children); } }
  walk(view.roots); return result;
}

export function reconcilePlanSession(view, previous = {}) {
  const collapsed = copySet(previous.collapsed), touched = copySet(previous.touched), known = copySet(previous.known);
  for (const id of collapsed) if (!view.byId.get(id)?.isGroup) collapsed.delete(id);
  for (const id of touched) if (!view.byId.get(id)?.isGroup) touched.delete(id);
  for (const node of view.nodes) if (node.isGroup && !known.has(node.id) && (view.plan.detail === 'compact' || view.plan.detail !== 'detailed' && node.depth > 1)) collapsed.add(node.id);
  let selectedId = previous.pinned && view.byId.has(previous.selectedId) ? previous.selectedId : view.focus?.id || (view.byId.has(previous.selectedId) ? previous.selectedId : view.roots[0]?.id) || null;
  if (!previous.pinned) for (const id of planAncestors(view, selectedId)) if (!touched.has(id)) collapsed.delete(id);
  const visible = new Set(visiblePlanNodes(view, collapsed).map(node => node.id));
  if (selectedId && !visible.has(selectedId)) selectedId = planAncestors(view, selectedId).reverse().find(id => visible.has(id)) || view.roots[0]?.id || null;
  return { ...previous, selectedId, collapsed, touched, known: new Set(view.nodes.map(node => node.id)), pinned: previous.pinned === true };
}

export function selectPlanStep(view, session, id, { pinned = true } = {}) {
  if (!view.byId.has(id)) return session;
  const collapsed = copySet(session.collapsed), touched = copySet(session.touched);
  for (const parentId of planAncestors(view, id)) { collapsed.delete(parentId); touched.add(parentId); }
  return { ...session, selectedId: id, collapsed, touched, pinned };
}

export function togglePlanBranch(view, session, id, expanded) {
  if (!view.byId.get(id)?.isGroup) return session;
  const collapsed = copySet(session.collapsed), touched = copySet(session.touched), open = expanded ?? collapsed.has(id);
  if (open) collapsed.delete(id); else collapsed.add(id); touched.add(id);
  const selectedId = !open && planAncestors(view, session.selectedId).includes(id) ? id : session.selectedId;
  return { ...session, selectedId, collapsed, touched, pinned: true };
}

// WAI-ARIA tree navigation. Selection inspects a step; it never starts work or
// changes an agent's selected branch.
export function planKeyboard(view, session, key) {
  const visible = visiblePlanNodes(view, session.collapsed), index = visible.findIndex(node => node.id === session.selectedId), node = view.byId.get(session.selectedId);
  let next = session, focusId = session.selectedId;
  const select = id => { if (id) { next = selectPlanStep(view, session, id); focusId = id; } };
  if (key === 'ArrowDown') select(visible[Math.min(visible.length - 1, Math.max(0, index + 1))]?.id);
  else if (key === 'ArrowUp') select(visible[Math.max(0, index - 1)]?.id);
  else if (key === 'Home') select(visible[0]?.id);
  else if (key === 'End') select(visible.at(-1)?.id);
  else if (key === 'ArrowRight') { if (node?.isGroup && session.collapsed.has(node.id)) next = togglePlanBranch(view, session, node.id, true); else select(node?.children[0]?.id); }
  else if (key === 'ArrowLeft') { if (node?.isGroup && !session.collapsed.has(node.id)) next = togglePlanBranch(view, session, node.id, false); else select(node?.parentId); }
  else if (key === 'Enter' || key === ' ') { if (node?.isGroup) next = togglePlanBranch(view, session, node.id); else next = { ...session, pinned: true }; }
  else if (key === '*') { const siblings = node?.parentId ? view.byId.get(node.parentId)?.children || [] : view.roots; for (const sibling of siblings) if (sibling.isGroup) next = togglePlanBranch(view, next, sibling.id, true); }
  else return { handled: false, session, focusId: null };
  return { handled: true, session: next, focusId };
}

export function planStepContext(view, step) {
  return { step: step?.source || step || null, taskState: view.state };
}
