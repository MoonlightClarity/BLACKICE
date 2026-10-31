/** The Planning application edits the same durable task document used by agents. */
const fail = (message, status = 400, code = 'PLANNING_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ACTIVE = new Set(['queued', 'running', 'waiting']);

export function planningQuery(params) {
  const keys = ['query', 'state', 'limit', 'offset', 'groupId', 'taskId'];
  if ([...params.keys()].some(key => !keys.includes(key) || params.getAll(key).length !== 1)) throw fail('Use each supported Planning search field once.');
  const query = params.get('query') ?? '', state = params.get('state') ?? 'active';
  if (query.length > 500 || query.includes('\0')) throw fail('Use a Planning search of at most 500 characters.');
  if (!['all', 'active', 'archived', 'deleted'].includes(state)) throw fail('Choose active chats, archived chats, all saved chats, or Trash.');
  const integer = (name, fallback, minimum, maximum) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw fail(`Planning ${name} is outside its supported range.`);
    return Number(value);
  };
  const filters = {};
  for (const key of ['groupId', 'taskId']) if (params.has(key)) {
    const value = params.get(key);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw fail('Choose an existing plan or group identifier.');
    if (key !== 'groupId' || value !== 'all') filters[key] = value;
  }
  return { query, state, limit: integer('limit', 40, 1, 100), offset: integer('offset', 0, 0, 1000000), ...filters };
}

export function planningConversations({ conversations, engine }) {
  const byTask = new Map();
  for (const item of conversations.list('all')) {
    const taskId = item.taskId || item.rootId || item.id;
    byTask.set(taskId, { taskId, title: item.title, runId: item.latestRunId || item.runId || item.id, runStatus: item.status, bucket: item.state, updatedAt: item.updatedAt });
  }
  // Include a newly admitted task before its first archive capture completes.
  // Catalog metadata does not need full snapshots of transcripts, nodes or plans.
  // Preserve listRuns' newest-first order, including equal-timestamp precedence.
  const runs = engine.runs instanceof Map ? [...engine.runs.values()].reverse() : engine.listRuns();
  for (const run of runs) {
    const taskId = run.taskId || run.id, previous = byTask.get(taskId);
    if (!previous || Date.parse(run.updatedAt || run.createdAt) >= Date.parse(previous.updatedAt || 0)) {
      byTask.set(taskId, { taskId, title: previous?.title || (typeof run.input === 'string' ? run.input.slice(0, 140) : run.workflowName || 'Task'), runId: run.id, runStatus: run.status, bucket: previous?.bucket || 'active', updatedAt: run.updatedAt || run.createdAt });
    }
  }
  return byTask;
}

const emptyOrganization = () => ({ revision: 0, groups: [], plans: [], projects: [], updatedAt: null, healthy: true });
export async function readPlanningOrganization({ planningOrganization }) {
  if (!planningOrganization) return emptyOrganization();
  try { return { ...await planningOrganization.get(), healthy: true }; }
  catch (error) { return { ...emptyOrganization(), revision: null, healthy: false, error: error.message, code: error.code || 'PLANNING_ORGANIZATION_STORAGE' }; }
}
const organizationSummary = (organization, visiblePlans = [], visibleProjects = []) => {
  const plans = new Set(visiblePlans), projects = new Set(visibleProjects);
  return {
    revision: organization.revision, healthy: organization.healthy !== false, updatedAt: organization.updatedAt,
    groups: organization.groups.map(group => ({ ...group, planCount: organization.plans.filter(item => item.groupId === group.id && plans.has(item.taskId)).length, projectCount: organization.projects.filter(item => item.groupId === group.id && projects.has(item.projectId)).length })),
    ...(organization.healthy === false ? { error: organization.error, code: organization.code } : {}),
  };
};

export async function listPlanningWorkspace({ tasks, conversations, engine, planningOrganization }, options) {
  options = { query: '', state: 'active', limit: 40, offset: 0, ...options };
  const metadata = planningConversations({ conversations, engine });
  const organization = await readPlanningOrganization({ planningOrganization }), assignments = new Map(organization.plans.map(item => [item.taskId, item])), groups = new Map(organization.groups.map(group => [group.id, group]));
  const bucket = [...metadata.values()].filter(item => options.state === 'all' ? ['active', 'archived'].includes(item.bucket) : item.bucket === options.state);
  const visible = bucket.filter(item => (!options.taskId || item.taskId === options.taskId) && (!options.groupId || options.groupId === 'all' || (assignments.get(item.taskId)?.groupId || 'ungrouped') === options.groupId));
  const query = options.query.trim().toLocaleLowerCase();
  const result = await tasks.listPlans({ query: options.query, limit: options.limit, offset: options.offset, taskIds: visible.map(item => item.taskId), ...(query ? { queryTaskIds: visible.filter(item => [item.title, assignments.get(item.taskId)?.name, groups.get(assignments.get(item.taskId)?.groupId)?.name].some(value => String(value || '').toLocaleLowerCase().includes(query))).map(item => item.taskId) } : {}) });
  const health = conversations.status();
  return {
    ...result,
    plans: result.plans.map(plan => {
      const item = metadata.get(plan.taskId);
      const assignment = assignments.get(plan.taskId), groupId = assignment?.groupId || null;
      return { ...plan, name: assignment?.name || null, title: assignment?.name || item?.title || plan.goal, conversationTitle: item?.title || null, groupId, groupName: groups.get(groupId)?.name || null, organizationRevision: organization.revision, runId: item?.runId || null, runStatus: item?.runStatus || null, bucket: item?.bucket || 'unknown', editable: ['active', 'archived'].includes(item?.bucket), running: ACTIVE.has(item?.runStatus) };
    }),
    organization: organizationSummary(organization, bucket.map(item => item.taskId)),
    healthy: result.healthy !== false && health.healthy !== false && organization.healthy !== false,
    errors: [...(result.errors || []), ...(health.healthy === false ? [{ code: 'PLANNING_HISTORY_UNAVAILABLE', error: health.error || 'Some conversation metadata is unavailable.' }] : []), ...(organization.healthy === false ? [{ code: organization.code, error: organization.error }] : [])],
    state: options.state,
  };
}

export async function projectPlanningWorkspace({ projects, planningOrganization }, project) {
  const organization = await readPlanningOrganization({ planningOrganization }), assignments = new Map(organization.projects.map(item => [item.projectId, item])), groups = new Map(organization.groups.map(group => [group.id, group]));
  const decorate = value => {
    const assignment = assignments.get(value.id), groupId = assignment?.groupId || null;
    return { ...value, groupId, groupName: groups.get(groupId)?.name || null, archived: assignment?.archived === true, organizationRevision: organization.revision };
  };
  if (project) return { ...decorate(project), organization: organizationSummary(organization) };
  const snapshot = projects.snapshot(), visible = snapshot.projects.map(decorate);
  return { ...snapshot, projects: visible, organization: organizationSummary(organization, [], visible.filter(item => !item.archived).map(item => item.id)) };
}

function assertProjectArchivable(projects, project) {
  const active = project.status === 'running' || project.tasks.some(task => {
    const phase = task.status === 'verifying' ? task.attempts.at(-1)?.verification : task.attempts.at(-1)?.implementation;
    const prepared = task.status === 'verifying' && task.attempts.at(-1)?.mode === 'review_only' && phase?.status === 'prepared';
    return ['running', 'verifying'].includes(task.status) && !prepared || task.attempts.some(attempt => [attempt.implementation, attempt.verification].some(value => ['dispatching', 'running'].includes(value?.status)));
  });
  if (active) throw fail('Pause this project and wait for its implementation and review runs to settle before archiving it.', 409, 'PLANNING_PROJECT_ACTIVE');
  for (const task of project.tasks) projects.assertAttemptsSettled?.(task);
}

export async function editPlanningOrganization({ planningOrganization, tasks, conversations, engine, projects, onUpdated, actor }, value) {
  if (!planningOrganization) throw fail('Plan organization is unavailable.', 503, 'PLANNING_ORGANIZATION_UNAVAILABLE');
  const saved = await planningOrganization.edit(value, { actor, validateTargets: async operations => {
    const metadata = planningConversations({ conversations, engine });
    for (const operation of operations) {
      if (operation.type === 'update_plan') {
        const item = metadata.get(operation.taskId);
        if (!item) throw fail('This plan is not attached to an available saved chat.', 404, 'PLANNING_TASK_UNAVAILABLE');
        if (!['active', 'archived'].includes(item.bucket)) throw fail('Restore this chat before renaming or grouping its plan.', 409, 'PLANNING_CHAT_READ_ONLY');
        await tasks.get(operation.taskId);
      } else if (operation.type === 'update_project') {
        if (!projects) throw fail('Saved projects are unavailable.', 503, 'PLANNING_PROJECT_UNAVAILABLE');
        const project = projects.get(operation.projectId);
        if (operation.archived === true) assertProjectArchivable(projects, project);
      }
    }
  } });
  const summary = organizationSummary({ ...saved, healthy: true });
  onUpdated?.({ type: 'planning.updated', data: { organizationRevision: saved.revision, taskIds: saved.taskIds, projectIds: saved.projectIds, source: 'human', ...(actor ? { actor } : {}) }, at: new Date().toISOString() });
  return { ...summary, createdGroupIds: saved.createdGroupIds, taskIds: saved.taskIds, projectIds: saved.projectIds };
}

export function guardArchivedProjectExecution(projects, planningOrganization) {
  for (const method of ['start', 'retryTask', 'reviewTask']) {
    const original = projects[method].bind(projects);
    projects[method] = (...args) => planningOrganization.withState(async organization => {
      if (organization.projects.some(item => item.projectId === args[0] && item.archived)) throw fail('Restore this project from Archive before starting or retrying its work.', 409, 'PLANNING_PROJECT_ARCHIVED');
      return original(...args);
    });
  }
}

export async function editPlanningWorkspace({ tasks, conversations, engine, onUpdated, source = 'human', actor }, taskId, value) {
  if (!object(value) || Object.keys(value).some(key => !['expectedRevision', 'operations'].includes(key)) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 || !Array.isArray(value.operations) || !value.operations.length) throw fail('Supply the saved expectedRevision and one or more Planning operations.');
  const metadata = planningConversations({ conversations, engine }).get(taskId);
  if (!metadata) throw fail('This plan is not attached to an available saved chat.', 404, 'PLANNING_TASK_UNAVAILABLE');
  if (!['active', 'archived'].includes(metadata.bucket)) throw fail('Restore this chat before editing its plan.', 409, 'PLANNING_CHAT_READ_ONLY');
  if (!['human', 'agent', 'external-agent'].includes(source) || source === 'external-agent' && actor?.type !== 'external-agent') throw fail('Use a verified Planning author.');
  const state = await tasks.editPlan(taskId, { operations: value.operations }, { expectedRevision: value.expectedRevision, source, executionGuardrails: engine.runtimeSettings?.get()?.executionGuardrails === true, ...(actor ? { actor } : {}) });
  // A plan edit changes the work document, never the run's execution outcome.
  for (const run of engine.runs.values()) {
    if ((run.taskId || run.id) !== taskId || !engine.adoptTaskState(run, state)) continue;
    engine.notify('agent.event', run, undefined, { type: 'task.state', taskId, state, source, ...(actor ? { actor } : {}) });
  }
  onUpdated?.({ type: 'planning.updated', data: { taskId, revision: state.revision, state, source, ...(actor ? { actor } : {}) }, at: new Date().toISOString() });
  return state;
}

const awarenessTask = async ({ tasks, conversations, engine }, taskId, { editing = false } = {}) => {
  const metadata = planningConversations({ conversations, engine }).get(taskId);
  if (!metadata) throw fail('This plan is not attached to an available saved chat.', 404, 'PLANNING_TASK_UNAVAILABLE');
  if (editing && !['active', 'archived'].includes(metadata.bucket)) throw fail('Restore this chat before editing its plan.', 409, 'PLANNING_CHAT_READ_ONLY');
  return tasks.get(taskId);
};

export async function readPlanningAwareness(context, taskId) {
  return context.tasks.awareness.snapshot(await awarenessTask(context, taskId));
}

export async function updatePlanningPresence(context, taskId, value, { actor, release = false } = {}) {
  const state = await awarenessTask(context, taskId, { editing: !release });
  const human = actor || { type: 'local-human', id: 'local-user', name: 'Local user' };
  return release ? context.tasks.awareness.clearPresence(state, value, human) : context.tasks.awareness.setPresence(state, value, human);
}
