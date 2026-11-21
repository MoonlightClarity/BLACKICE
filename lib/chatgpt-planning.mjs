import { PLAN_EDIT_SCHEMA, PLAN_EDIT_DEFINITIONS, validRemoteArguments as validConnectorArguments } from './remote-agent-api.mjs';
import { planningDocuments, projectPlanningState, listPlanningWorkspace, readPlanningOrganization, editPlanningOrganization, editPlanningWorkspace, projectPlanningWorkspace } from './planning-workspace.mjs';

import { externalPlanningContract } from './planning-document.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400, code = 'CHATGPT_ARGUMENTS_INVALID') => Object.assign(new Error(message), { status, code });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,120}$', minLength: 1, maxLength: 120 };
const nullableId = { anyOf: [id, { type: 'null' }] };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const paging = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const filters = { query: { type: 'string', maxLength: 500 }, state: { enum: ['active', 'archived', 'all'] }, groupId: id, ...paging };
const attemptPaging = { attemptOffset: { type: 'integer', minimum: 0, maximum: 1000000 }, attemptLimit: { type: 'integer', minimum: 1, maximum: 10 } };
const compactText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null;
const fields = (value, limits) => Object.fromEntries(Object.entries(limits).filter(([key]) => value[key] !== undefined).map(([key, limit]) => [key, compactText(value[key], limit)]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const phaseSummary = phase => !object(phase) ? null : {
  ...fields(phase, { requestId: 120, runId: 120, status: 40, createdAt: 64, finishedAt: 64, error: 500 }),
  outputCharacters: typeof phase.output === 'string' ? phase.output.length : 0,
  outputTruncated: phase.outputTruncated === true,
  ...(object(phase.verdict) ? { verdict: { passed: phase.verdict.passed === true, summary: compactText(phase.verdict.summary, 500) } } : {}),
};
function projectSummary(project) {
  return { ...fields(project, { id: 120, name: 160, objective: 8000, status: 40, priority: 20, owner: 160, dueDate: 16, createdAt: 64, updatedAt: 64, finishedAt: 64, pauseReason: 1000, groupId: 120, groupName: 120 }), revision: count(project.revision), archived: project.archived === true, organizationRevision: project.organizationRevision ?? null, taskCount: project.tasks?.length ?? count(project.taskCount), ...(object(project.summary?.progress) ? { progress: Object.fromEntries(['total', 'completed', 'active', 'blocked', 'ready', 'waiting', 'percent'].map(key => [key, count(project.summary.progress[key])])) } : {}) };
}
function taskSummary(task, args) {
  const history = Array.isArray(task.attempts) ? task.attempts : [], attemptLimit = args.attemptLimit || 5, attemptOffset = args.attemptOffset ?? Math.max(0, history.length - attemptLimit);
  const attempts = history.slice(attemptOffset, attemptOffset + attemptLimit).map(attempt => ({ number: count(attempt.number), cycle: count(attempt.cycle), round: count(attempt.round), ...(attempt.mode === 'review_only' ? { mode: 'review_only', sourceAttempt: count(attempt.sourceAttempt) } : {}), implementation: phaseSummary(attempt.implementation), verification: phaseSummary(attempt.verification) }));
  return { ...fields(task, { id: 120, title: 300, status: 40, stepType: 100, completedAt: 64, error: 500 }), round: count(task.round), cycle: count(task.cycle), maxRepairs: count(task.maxRepairs), dependsOn: (task.dependsOn || []).slice(0, 100).map(value => compactText(value, 120)), acceptanceCriteria: (task.acceptanceCriteria || []).slice(0, 20).map(value => compactText(value, 1000)), attempts, totalAttempts: history.length, attemptOffset, previousAttemptOffset: attemptOffset ? Math.max(0, attemptOffset - attemptLimit) : null, nextAttemptOffset: attemptOffset + attempts.length < history.length ? attemptOffset + attempts.length : null };
}
function boundedPage(values, { offset, limit, project, base, key }) {
  // Stored attempts include full workflows and output. Only the projections
  // above cross this boundary, and a large saved outline advances by real rows.
  const page = []; let bytes = Buffer.byteLength(JSON.stringify(base)) + 512;
  for (const value of values.slice(offset, offset + limit)) {
    const item = project(value), size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > 256000) { if (!page.length) throw fail('This saved plan metadata exceeds the connector page limit.', 413, 'CHATGPT_RESULT_LIMIT'); break; }
    page.push(item); bytes += size;
  }
  return { ...base, [key]: page, offset, nextOffset: offset + page.length < values.length ? offset + page.length : null };
}
const organizationOperations = { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: [
  schema({ type: { const: 'create_group' }, id, name: text(120) }, ['type', 'id', 'name']),
  schema({ type: { const: 'rename_group' }, groupId: id, name: text(120) }, ['type', 'groupId', 'name']),
  schema({ type: { const: 'remove_group' }, groupId: id }, ['type', 'groupId']),
  { ...schema({ type: { const: 'update_plan' }, taskId: id, name: { anyOf: [text(160), { type: 'null' }] }, groupId: nullableId }, ['type', 'taskId']), minProperties: 3 },
  schema({ type: { const: 'update_project' }, projectId: id, groupId: nullableId }, ['type', 'projectId', 'groupId']),
] } };

export { validConnectorArguments };

const definitions = [
  ['blackice_list_plans', "Find saved task/conversation plans by query, groupId or exact taskId. Defaults to active; state:archived or all includes archived plans. Returns names, current revisions and run references. Use offset/limit to page results.", 'read', schema({ ...filters, taskId: id })],
  ['blackice_get_plan', "Read a saved task/conversation plan by taskId. Returns its current revision, task work and saved decision/context records. planningAwareness reports current editing and worker read receipts. Use this revision when preparing an edit.", 'read', schema({ taskId: id }, ['taskId'])],
  ['blackice_get_run_result', "Read an existing run by runId. Returns status, settled and saved output; add nodeId for one worker. Page long text by passing output.nextOffset as offset. This reads the run without starting or continuing it.", 'read', schema({ runId: id, nodeId: id, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 50000 } }, ['runId'])],
  ['blackice_list_swarm_plans', "Find saved Swarms projects by query or groupId. Defaults to active; state:archived or all includes archived projects. Returns names, groups, revisions and task counts. Page with offset/limit.", 'read', schema(filters)],
  ['blackice_get_swarm_plan', "Read a Swarms project by projectId, including task status and execution attempt IDs. offset/limit pages tasks. Each task defaults to its latest five attempts; use attemptOffset/attemptLimit for other attempts. Use blackice_get_run_result with a returned runId for worker output. Reading does not start, retry or review work.", 'read', schema({ projectId: id, ...paging, ...attemptPaging }, ['projectId'])],
  ['blackice_get_plan_groups', "Read plan names, group membership and the organization revision. Use that revision with blackice_edit_plan_groups; it is separate from each plan's content revision.", 'read', schema()],
  ['blackice_edit_plan', "Save task/conversation plan operations using taskId and its current expectedRevision. For a new task at revision 0, use create_contract with a complete current contract. For an existing current plan, use replace_contract as the sole operation. Existing legacy graph records retain their graph-edit operations; blackice_get_plan identifies the saved protocol. Use the attached operations schema for fields. The host retains planEpoch and runtime evidence. Changes are saved as one batch and do not execute the plan. After a conflict or lost response, read blackice_get_plan to see what was saved before preparing another edit.", 'planning:write', { ...schema({ taskId: id, expectedRevision: { type: 'integer', minimum: 0 }, operations: PLAN_EDIT_SCHEMA }, ['taskId', 'expectedRevision', 'operations']), $defs: PLAN_EDIT_DEFINITIONS }],
  ['blackice_edit_plan_groups', "Rename/group plans or create, rename and remove groups. Read blackice_get_plan_groups first and pass its organization revision as expectedRevision. operations is an array whose entries use type, such as create_group with id/name or update_plan with taskId/name/groupId. Removing a group keeps its plans. After a conflict or lost response, reread the organization to determine the remaining change.", 'planning:write', schema({ expectedRevision: { type: 'integer', minimum: 0 }, operations: organizationOperations }, ['expectedRevision', 'operations'])],
].map(([name, description, scope, inputSchema]) => ({ name, description, scope, inputSchema, annotations: { readOnlyHint: scope === 'read', destructiveHint: false, idempotentHint: scope === 'read', openWorldHint: false } }));

/** Planning documents are shared with the desktop. This API never admits a model turn. */
export class ChatGPTPlanningAPI {
  constructor(options) { Object.assign(this, options); }
  tools(client) { return definitions.filter(tool => !client || client.scopes?.includes(tool.scope)).map(tool => structuredClone(tool)); }
  async visibleTask(taskId) {
    const item = (await planningDocuments(this, { taskId })).metadata.get(taskId);
    if (!item || !['active', 'archived'].includes(item.bucket)) throw fail('Restore this plan in BLACKICE before accessing it.', 404, 'CHATGPT_PLAN_UNAVAILABLE');
    return item;
  }
  async call(name, args, client) {
    const tool = definitions.find(item => item.name === name);
    if (!tool) throw fail('Unknown planning tool.', 404, 'CHATGPT_TOOL_UNKNOWN');
    if (!client || typeof client.id !== 'string' || !Array.isArray(client.scopes)) throw fail('Connect your BLACKICE account first.', 401, 'CHATGPT_AUTH_REQUIRED');
    if (!client.scopes.includes(tool.scope)) throw Object.assign(fail(`This tool needs the ${tool.scope} permission.`, 403, 'CHATGPT_SCOPE_REQUIRED'), { scope: tool.scope });
    if (!validConnectorArguments(args, tool.inputSchema)) throw fail(`Use the declared arguments for ${name}.`);
    if (tool.scope !== 'read' && this.isClosing?.()) throw fail('BLACKICE is closing. Read the plan again after it reopens.', 503, 'PROFILE_MAINTENANCE');
    if (name === 'blackice_list_plans') return { ...await listPlanningWorkspace({ ...this, planningClient: client }, args), planningContract: externalPlanningContract({ includeSchemas: true }) };
    if (name === 'blackice_get_plan') {
      await this.visibleTask(args.taskId);
      const state = await projectPlanningState(this, await this.tasks.get(args.taskId), client);
      return { ...state, planningContract: externalPlanningContract({ state }), ...(this.tasks.awareness ? { planningAwareness: this.tasks.awareness.snapshot(state) } : {}) };
    }
    if (name === 'blackice_get_run_result') {
      const run = await this.conversations.get(args.runId);
      await this.visibleTask(run.taskId || run.id);
      if (args.nodeId && !Object.hasOwn(run.nodes || {}, args.nodeId)) throw fail('That worker does not belong to this run.', 404, 'CHATGPT_NODE_UNAVAILABLE');
      const output = args.nodeId ? run.nodes[args.nodeId].output || '' : run.output || '', offset = args.offset || 0, limit = args.limit || 12000;
      return { runId: run.id, taskId: run.taskId || run.id, status: run.status, settled: run.settled === true, nodeId: args.nodeId || null, output: { text: output.slice(offset, offset + limit), offset, totalCharacters: output.length, nextOffset: offset + limit < output.length ? offset + limit : null } };
    }
    if (name === 'blackice_get_plan_groups') {
      const organization = await readPlanningOrganization(this), visible = (await planningDocuments(this)).metadata;
      return { ...organization, plans: organization.plans.filter(item => ['active', 'archived'].includes(visible.get(item.taskId)?.bucket)) };
    }
    if (name === 'blackice_list_swarm_plans') {
      const value = await projectPlanningWorkspace(this), state = args.state || 'active', query = (args.query || '').trim().toLocaleLowerCase();
      const all = value.projects.filter(item => (state === 'all' || item.archived === (state === 'archived')) && (!args.groupId || args.groupId === 'all' || (item.groupId || 'ungrouped') === args.groupId) && [item.name, item.objective, item.groupName].some(part => String(part || '').toLocaleLowerCase().includes(query)));
      const offset = args.offset || 0, limit = args.limit || 40;
      return boundedPage(all, { offset, limit, project: projectSummary, key: 'projects', base: { total: all.length, organization: value.organization } });
    }
    if (name === 'blackice_get_swarm_plan') {
      const value = await projectPlanningWorkspace(this, this.projects.get(args.projectId)), offset = args.offset || 0, limit = args.limit || 40;
      const { tasks = [] } = value;
      return boundedPage(tasks, { offset, limit, project: task => taskSummary(task, args), key: 'tasks', base: { ...projectSummary(value), totalTasks: tasks.length, runOutputTool: 'blackice_get_run_result' } });
    }
    const actor = { type: 'external-agent', id: client.id, name: client.label || 'ChatGPT' };
    if (name === 'blackice_edit_plan') {
      const { taskId, ...edit } = args;
      const state = await editPlanningWorkspace({ ...this, source: 'external-agent', actor }, taskId, edit);
      return { ...state, planningContract: externalPlanningContract({ state }) };
    }
    return editPlanningOrganization({ ...this, actor }, args);
  }
}
