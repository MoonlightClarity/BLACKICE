import { PLAN_EDIT_SCHEMA, PLAN_EDIT_DEFINITIONS, validRemoteArguments as validConnectorArguments } from './remote-agent-api.mjs';
import { planningConversations, listPlanningWorkspace, readPlanningOrganization, editPlanningOrganization, editPlanningWorkspace, projectPlanningWorkspace } from './planning-workspace.mjs';

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
  ['blackice_list_plans', 'Find saved BLACKICE plans by name, group or text. Active plans are the default; request archived or all explicitly. Returns saved revisions and actual execution references.', 'read', schema({ ...filters, taskId: id })],
  ['blackice_get_plan', 'Read one shared plan and its revision before editing. Human editing presence is advisory; this read does not acknowledge a revision for another worker.', 'read', schema({ taskId: id }, ['taskId'])],
  ['blackice_get_run_result', 'Read the real status and bounded output of an existing BLACKICE run. This observes an existing run and does not start a model or worker.', 'read', schema({ runId: id, nodeId: id, offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 50000 } }, ['runId'])],
  ['blackice_list_swarm_plans', 'List saved Swarms plans with their names, groups and actual task counts. Active plans are the default. No worker is started.', 'read', schema(filters)],
  ['blackice_get_swarm_plan', 'Read compact Swarms plan, task and attempt metadata with real run identifiers. Defaults to the latest five attempts per task; use attemptOffset and attemptLimit for older receipts. Stored worker prompts and outputs are excluded; use blackice_get_run_result for bounded saved output. Reading never starts, retries or reviews a worker.', 'read', schema({ projectId: id, ...paging, ...attemptPaging }, ['projectId'])],
  ['blackice_get_plan_groups', 'Read saved plan names, group membership and the independent organization revision before changing them.', 'read', schema()],
  ['blackice_edit_plan', 'Apply one atomic batch of plan edits at expectedRevision. Define concrete operations, observed facts and nested IF/ELIF/ELSE conditions, or revisit earlier work with a reason while retaining prior results. A conflict returns currentRevision: reread and reconcile. After an uncertain connection, reread before deciding whether any change remains. Editing a plan never executes it.', 'planning:write', { ...schema({ taskId: id, expectedRevision: { type: 'integer', minimum: 1 }, operations: PLAN_EDIT_SCHEMA }, ['taskId', 'expectedRevision', 'operations']), $defs: PLAN_EDIT_DEFINITIONS }],
  ['blackice_edit_plan_groups', 'Rename or group plans and create, rename or remove named groups at the organization expectedRevision. Removing a group retains its plans. Supply a stable ID for each new group. Reread after conflicts or uncertain responses; do not blindly repeat an edit.', 'planning:write', schema({ expectedRevision: { type: 'integer', minimum: 0 }, operations: organizationOperations }, ['expectedRevision', 'operations'])],
].map(([name, description, scope, inputSchema]) => ({ name, description, scope, inputSchema, annotations: { readOnlyHint: scope === 'read', destructiveHint: false, idempotentHint: scope === 'read', openWorldHint: false } }));

/** Planning documents are shared with the desktop. This API never admits a model turn. */
export class ChatGPTPlanningAPI {
  constructor(options) { Object.assign(this, options); }
  tools(client) { return definitions.filter(tool => !client || client.scopes?.includes(tool.scope)).map(tool => structuredClone(tool)); }
  visibleTask(taskId) {
    const item = planningConversations(this).get(taskId);
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
    if (name === 'blackice_list_plans') return listPlanningWorkspace(this, args);
    if (name === 'blackice_get_plan') {
      this.visibleTask(args.taskId);
      const state = await this.tasks.get(args.taskId);
      return { ...state, ...(this.tasks.awareness ? { planningAwareness: this.tasks.awareness.snapshot(state) } : {}) };
    }
    if (name === 'blackice_get_run_result') {
      const run = await this.conversations.get(args.runId);
      this.visibleTask(run.taskId || run.id);
      if (args.nodeId && !Object.hasOwn(run.nodes || {}, args.nodeId)) throw fail('That worker does not belong to this run.', 404, 'CHATGPT_NODE_UNAVAILABLE');
      const output = args.nodeId ? run.nodes[args.nodeId].output || '' : run.output || '', offset = args.offset || 0, limit = args.limit || 12000;
      return { runId: run.id, taskId: run.taskId || run.id, status: run.status, settled: run.settled === true, nodeId: args.nodeId || null, output: { text: output.slice(offset, offset + limit), offset, totalCharacters: output.length, nextOffset: offset + limit < output.length ? offset + limit : null } };
    }
    if (name === 'blackice_get_plan_groups') {
      const organization = await readPlanningOrganization(this), visible = planningConversations(this);
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
      return editPlanningWorkspace({ ...this, source: 'external-agent', actor }, taskId, edit);
    }
    return editPlanningOrganization({ ...this, actor }, args);
  }
}
