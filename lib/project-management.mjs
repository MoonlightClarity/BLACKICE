const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(message), { status: 400, code: 'PROJECT_ERROR' });
const text = (value, label, max, required = false) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
};
export const projectIdentifier = (value, label = 'Identifier') => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fail(`${label} must contain 1 to 100 letters, numbers, underscores or hyphens.`);
  return value;
};
export function projectDate(value, label = 'Due date') {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail(`${label} must be a real date in YYYY-MM-DD format, or empty.`);
  return value;
}
export function projectTextList(value, label, { maxItems = 20, maxLength = 1000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw fail(`${label} must be a list of at most ${maxItems} text entries.`);
  const result = value.map(item => text(item, label, maxLength, true));
  if (new Set(result).size !== result.length) throw fail(`${label} must not contain duplicates.`);
  return result;
}
export const PROJECT_MANAGEMENT_FIELDS = Object.freeze(['name', 'priority', 'owner', 'dueDate', 'notes', 'tags', 'milestones']);

/** Planning fields never stand in for execution or acceptance receipts. */
export function projectManagement(value, tasks) {
  const priority = value.priority ?? 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw fail('Project priority must be low, normal, high or urgent.');
  const taskIds = new Set(tasks.map(task => task.id)), ids = new Set();
  const milestones = value.milestones ?? [];
  if (!Array.isArray(milestones) || milestones.length > 30) throw fail('Use at most 30 project milestones.');
  return {
    priority, owner: text(value.owner ?? '', 'Project owner', 160), dueDate: projectDate(value.dueDate ?? ''),
    notes: text(value.notes ?? '', 'Project notes', 12000), tags: projectTextList(value.tags ?? [], 'Project tags', { maxItems: 12, maxLength: 60 }),
    milestones: milestones.map((item, index) => {
      if (!object(item)) throw fail('Each milestone must be an object.');
      const id = projectIdentifier(item.id ?? `milestone-${index + 1}`, 'Milestone ID');
      if (ids.has(id)) throw fail('Milestone IDs must be unique.'); ids.add(id);
      const linked = item.taskIds ?? [];
      if (!Array.isArray(linked) || linked.length > 100 || new Set(linked).size !== linked.length || linked.some(taskId => !taskIds.has(taskId))) throw fail('A milestone must refer to unique tasks in this project.');
      const done = item.done ?? false;
      if (typeof done !== 'boolean') throw fail('Manual milestone completion must be true or false.');
      if (linked.length && done) throw fail('A milestone linked to tasks completes only when those tasks pass review. Use an unlinked milestone for a manual check.');
      return { id, title: text(item.title, 'Milestone title', 300, true), taskIds: [...linked], dueDate: projectDate(item.dueDate ?? '', 'Milestone due date'), done };
    })
  };
}
export function projectStepMetadata(task) {
  return { stepType: projectIdentifier(task.stepType ?? 'create', 'Step type'), inputs: projectTextList(task.inputs ?? [], 'Step inputs'), result: text(task.result ?? '', 'Expected step result', 2000) };
}
export function projectMethodReference(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['builtin', 'custom'].includes(value.origin)) throw fail('The method reference needs its saved ID, revision, name, task type and origin.');
  return { id: projectIdentifier(value.id, 'Method ID'), revision: value.revision, name: text(value.name, 'Method name', 160, true), taskType: projectIdentifier(value.taskType, 'Task type'), origin: value.origin };
}
export function projectContext(value) { return text(value ?? '', 'Project input context', 8000); }
/** An explicit suffix boundary keeps generated bindings separate from authored context. */
export function projectMethodContext(value, context, method) {
  const generated = value === undefined ? '' : value;
  if (typeof generated !== 'string' || generated.includes('\0') || generated.length > 8000) throw fail('Generated method input context must be text of at most 8000 characters.');
  if (generated && (!method || context !== generated && !context.endsWith('\n\n' + generated))) throw fail('Generated method input context must have a method reference and be the exact final block of the shared context. Restore that block, or clear methodContext to keep all context as authored text.');
  return generated;
}

/** Derived on read from real task states; manual milestones have separate provenance. */
export function projectSummary(project, { today = new Date().toISOString().slice(0, 10), blockedReason = null } = {}) {
  const tasks = project.tasks, byId = new Map(tasks.map(task => [task.id, task]));
  const prepared = task => task.status === 'verifying' && task.attempts?.at(-1)?.mode === 'review_only' && task.attempts.at(-1).verification?.status === 'prepared';
  const ready = task => prepared(task) || task.status === 'pending' && task.dependsOn.every(id => byId.get(id)?.status === 'completed');
  const active = tasks.filter(task => ['running', 'verifying'].includes(task.status) && !prepared(task));
  const blocked = tasks.filter(task => task.status === 'blocked'), completed = tasks.filter(task => task.status === 'completed');
  const readyTasks = tasks.filter(ready), waiting = tasks.filter(task => task.status === 'pending' && !ready(task));
  let nextAction;
  if (active.length) nextAction = { kind: 'wait', taskId: active[0].id, label: active[0].status === 'verifying' ? 'Review in progress' : 'Step in progress', detail: project.status === 'paused' ? 'The current phase may finish. Resume explicitly to admit more work.' : 'Follow the current run and its independent review.' };
  else if (project.status === 'completed') nextAction = { kind: 'complete', taskId: null, label: 'All steps passed review', detail: 'Inspect the saved evidence or reuse this plan as a new draft.' };
  else if (blockedReason) nextAction = { kind: 'inspect', taskId: readyTasks[0]?.id ?? null, label: 'Execution is paused', detail: blockedReason };
  else if (blocked.length) nextAction = { kind: 'review', taskId: blocked[0].id, label: 'Inspect blocked step', detail: blocked[0].error || 'Inspect its implementation and review receipts before choosing a recovery action.' };
  else if (readyTasks.length) nextAction = { kind: project.status === 'running' ? 'wait' : project.status === 'draft' ? 'start' : 'resume', taskId: readyTasks[0].id, label: project.status === 'running' ? 'Waiting for an execution slot' : project.status === 'draft' ? 'Review the plan, then start' : 'Resume when ready', detail: prepared(readyTasks[0]) ? 'A separate review is prepared for the original result; implementation will not repeat.' : readyTasks[0].title };
  else nextAction = { kind: 'inspect', taskId: waiting[0]?.id ?? null, label: 'Inspect the remaining plan', detail: 'The remaining steps are waiting for their prerequisites.' };
  const milestones = (project.milestones ?? []).map(item => {
    const linked = item.taskIds.map(id => byId.get(id)), checked = linked.filter(task => task.status === 'completed').length;
    const done = linked.length ? checked === linked.length : item.done;
    return { ...structuredClone(item), total: linked.length, completed: checked, percent: linked.length ? Math.round(checked / linked.length * 100) : done ? 100 : 0, status: done ? 'completed' : linked.some(task => task.status === 'blocked') ? 'blocked' : linked.some(task => task.status !== 'pending') ? 'active' : 'planned', completion: linked.length ? 'agent-reviewed' : 'manual', overdue: Boolean(item.dueDate && item.dueDate < today && !done) };
  });
  return { progress: { total: tasks.length, completed: completed.length, active: active.length, blocked: blocked.length, ready: readyTasks.length, waiting: waiting.length, percent: tasks.length ? Math.round(completed.length / tasks.length * 100) : 0 }, nextAction, milestones, overdue: Boolean(project.dueDate && project.dueDate < today && project.status !== 'completed') };
}
