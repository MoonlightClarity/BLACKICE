// Scope-limited ChatGPT access to BLACKICE's existing durable scheduler.
// No shell commands, scheduler bypass, or model calls are performed here.
import { stat } from 'node:fs/promises';
import path from 'node:path';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fail = (message, status = 400, code = 'CHATGPT_SCHEDULE_ARGUMENTS_INVALID') =>
  Object.assign(new Error(message), { status, code });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const scheduleId = { ...str(120), pattern: '^[A-Za-z0-9_-]{1,120}$' };
const whole = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const optional = field => ({ anyOf: [field, { type: 'null' }] });
const trigger = schema({
  type: { enum: ['manual', 'webhook', 'interval', 'cron'] },
  expression: str(256), timezone: str(100), everySeconds: whole(1, Number.MAX_SAFE_INTEGER),
}, ['type']);
const retry = schema({ maxAttempts: whole(0, 3), backoffSeconds: whole(1, 3600) });
const limits = schema({
  maxIterations: optional(whole(1, Number.MAX_SAFE_INTEGER)),
  runForSeconds: optional(whole(1, Math.floor(Number.MAX_SAFE_INTEGER / 1000))),
  endAt: optional(str(64)),
});
const outboundTarget = { oneOf: [
  schema({type:{const:'local'}},['type']),
  schema({type:{const:'webhook'},url:str(2048)},['type','url']),
] };
const patch = { ...schema({
  name: str(160), input: str(50000), cwd: str(4096), enabled: { type: 'boolean' },
  overlap: { enum: ['parallel', 'queue', 'skip'] }, trigger, retry, limits: optional(limits),
  deliveryTarget: outboundTarget,
  missedRunPolicy: schema({onResume:{enum:['skip','once']},maxAgeSeconds:whole(60,604800)},['onResume','maxAgeSeconds']),
  agentModel: str(400),
  agentEffort: { enum: ['inherit', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
}), minProperties: 1 };
const definitions = [
  ['blackice_list_schedules', 'Inspect saved BLACKICE cronjobs and other schedules, including their current revision, trigger, assigned model and next run. Read only; no job starts.', 'read',
    schema({ query: { type: 'string', maxLength: 500 }, offset: whole(0, 1000000), limit: whole(1, 100), includeRemoved: { type: 'boolean' } })],
  ['blackice_get_schedule', 'Inspect one actual saved schedule, its full instructions and pinned workflow, scheduler status, and bounded job/run receipts. Read its revision before editing. Does not expose webhook credentials or start work.', 'read',
    schema({ scheduleId, jobOffset: whole(0, 1000000), jobLimit: whole(1, 30) }, ['scheduleId'])],
  ['blackice_list_schedule_results', 'Read saved local scheduled-result receipts across active or removed schedules. Available means stored locally, not delivered to ChatGPT or read by a person.', 'read',
    schema({ scheduleId, state: { enum: ['all', 'available', 'acknowledged'] }, offset: whole(0, 1000000), limit: whole(1, 25) })],
  ['blackice_preview_schedule', 'Preview the next calendar cron or interval occurrences in its declared timezone, without admitting work. Supply scheduleId OR an explicit proposed trigger.', 'read',
    { ...schema({ scheduleId, trigger, count: whole(1, 10) }), oneOf: [{ required: ['scheduleId'] }, { required: ['trigger'] }] }],
  ['blackice_edit_schedule', 'Atomically edit the saved schedule at expectedRevision. Changes affect future admissions only; active jobs and recorded history remain pinned. Read before changing; on conflict, inspect and reconcile. Uses existing connector command capability.', 'commands:run',
    schema({ scheduleId, expectedRevision: whole(1, Number.MAX_SAFE_INTEGER), patch }, ['scheduleId', 'expectedRevision', 'patch'])],
  ['blackice_run_schedule', 'Admit one manual run of a saved BLACKICE schedule. A stable idempotencyKey deduplicates identical requests; the returned job receipt is not evidence the run completed. Uses existing connector command capability.', 'commands:run',
    schema({ scheduleId, idempotencyKey: { ...str(160), pattern: '^[A-Za-z0-9_.:-]{1,160}$' } }, ['scheduleId', 'idempotencyKey'])],
].map(([name, description, scope, inputSchema]) => ({
  name, description, scope, inputSchema,
  annotations: { readOnlyHint: scope === 'read', destructiveHint: false, idempotentHint: name !== 'blackice_run_schedule', openWorldHint: false },
}));

const valid = (value, spec) => {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.anyOf) return spec.anyOf.some(item => valid(value, item));
  if (spec.oneOf && spec.oneOf.filter(item => valid(value, item)).length !== 1) return false;
  if (spec.required && (!object(value) || !spec.required.every(key => Object.hasOwn(value, key)))) return false;
  if (Object.hasOwn(spec, 'const') && value !== spec.const || spec.enum && !spec.enum.includes(value)) return false;
  if (spec.type === 'null') return value === null;
  if (spec.type === 'object') return object(value) && Object.keys(value).length >= (spec.minProperties || 0)
    && (spec.required || []).every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, item]) => Object.hasOwn(spec.properties || {}, key) ? valid(item, spec.properties[key]) : spec.additionalProperties !== false);
  if (spec.type === 'string') return typeof value === 'string' && value.length >= (spec.minLength || 0) && value.length <= (spec.maxLength ?? Infinity) && !value.includes('\0') && (!spec.pattern || new RegExp(spec.pattern).test(value));
  if (spec.type === 'integer') return Number.isSafeInteger(value) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  return spec.type === undefined;
};
const summary = schedule => ({
  id: schedule.id, name: schedule.name, revision: schedule.revision,
  enabled: schedule.enabled, trigger: clone(schedule.trigger), timezone: schedule.trigger?.timezone || null,
  nextAt: schedule.nextAt || null, overlap: schedule.overlap, admittedJobs: schedule.admittedJobs || 0,
  limitStatus: schedule.limitStatus || null,deliveryTarget:schedule.deliveryTarget||{type:'local'},
  missedRunPolicy:schedule.missedRunPolicy||{onResume:'skip',maxAgeSeconds:86400},
  models: [...new Set((schedule.workflow?.nodes || []).filter(node => node.type === 'agent').map(node => node.model || 'default'))],
});
const receipt = job => ({
  id: job.id, deploymentId: job.deploymentId, deploymentRevision: job.deploymentRevision,
  source: job.source, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt || null,
  finishedAt: job.finishedAt || null, error: job.error || null, retryHold: job.retryHold || null,
  delivery: job.delivery?.destination === 'local-inbox' ? { ...clone(job.delivery) } : null,
  attempts: (job.attempts || []).map(attempt => ({
    number: attempt.number, status: attempt.status, runId: attempt.runId || null, inboxId: attempt.inboxId || null,
    startedAt: attempt.startedAt || null, finishedAt: attempt.finishedAt || null, error: attempt.error || null,
  })),
});
export class ChatGPTSchedulesAPI {
  constructor({ operations, isClosing = () => false } = {}) {
    this.operations = operations;
    this.isClosing = isClosing;
  }
  tools(client) { return definitions.filter(tool => !client || client.scopes?.includes(tool.scope)).map(clone); }
  async call(name, args, client) {
    const tool = definitions.find(item => item.name === name);
    if (!tool) throw fail('Unknown schedule tool.', 404, 'CHATGPT_TOOL_UNKNOWN');
    if (!client || !Array.isArray(client.scopes)) throw fail('Connect to BLACKICE first.', 401, 'CHATGPT_AUTH_REQUIRED');
    if (!client.scopes.includes(tool.scope)) throw Object.assign(fail('This action requires the ' + tool.scope + ' permission.', 403, 'CHATGPT_SCOPE_REQUIRED'), { scope: tool.scope });
    if (!valid(args, tool.inputSchema)) throw fail('Use the declared arguments for ' + name + '.');
    if (!this.operations || typeof this.operations.getDeployment !== 'function') throw fail('The BLACKICE scheduler is unavailable.', 503, 'CHATGPT_SCHEDULER_UNAVAILABLE');
    if (tool.scope !== 'read' && this.isClosing()) throw fail('BLACKICE is closing. Read the schedule after it reopens.', 503, 'PROFILE_MAINTENANCE');
    if (name === 'blackice_list_schedules') {
      const query = (args.query || '').trim().toLowerCase(), offset = args.offset || 0, limit = args.limit || 40;
      const found = this.operations.list().filter(schedule => !query || [schedule.id,schedule.name,schedule.input].some(value => String(value || '').toLowerCase().includes(query)));
      const removed = args.includeRemoved === true && typeof this.operations.removedDeployments === 'function'
        ? this.operations.removedDeployments().filter(item => !query || [item.id,item.name].some(value => String(value || '').toLowerCase().includes(query)))
        : [];
      return { schedules: found.slice(offset, offset + limit).map(summary), total: found.length,
        removedSchedules: removed, removedCount: removed.length,
        offset, nextOffset: offset + limit < found.length ? offset + limit : null, scheduler: this.operations.status() };
    }
    if (name === 'blackice_get_schedule') {
      const schedule = this.operations.getDeployment(args.scheduleId);
      const history = this.operations.snapshot().jobs.filter(job => job.deploymentId === schedule.id);
      const offset = args.jobOffset || 0, limit = args.jobLimit || 10;
      return { schedule, jobHistory: { total: history.length, offset, nextOffset: offset + limit < history.length ? offset + limit : null, jobs: history.slice(offset, offset + limit).map(receipt) }, scheduler: this.operations.status() };
    }
    if (name === 'blackice_list_schedule_results') {
      const offset = args.offset || 0, limit = args.limit || 20, state = args.state || 'all';
      const filtered = this.operations.snapshot().jobs.filter(job =>
        job.delivery?.destination === 'local-inbox' &&
        ['available','acknowledged'].includes(job.delivery.state) &&
        (!args.scheduleId || job.deploymentId === args.scheduleId) &&
        (state === 'all' || job.delivery.state === state));
      return { results: filtered.slice(offset, offset + limit).map(receipt), total: filtered.length,
        offset, nextOffset: offset + limit < filtered.length ? offset + limit : null };
    }
    if (name === 'blackice_preview_schedule') {
      const candidate = args.scheduleId ? this.operations.getDeployment(args.scheduleId).trigger : args.trigger;
      return this.operations.previewSchedule({ trigger: candidate, count: args.count || 5 });
    }
    if (name === 'blackice_run_schedule') {
      const result = await this.operations.trigger(args.scheduleId, { source: 'manual', idempotencyKey: args.idempotencyKey });
      return receipt(result);
    }
    const original = this.operations.getDeployment(args.scheduleId);
    if (original.revision !== args.expectedRevision) throw Object.assign(fail('This schedule changed. Reinspect and reconcile before editing.', 409, 'SCHEDULE_REVISION_CONFLICT'), { currentRevision: original.revision });
    const { agentModel, agentEffort, ...fields } = args.patch;
    if (agentModel !== undefined || agentEffort !== undefined) {
      const workflow = clone(original.workflow), agents = workflow.nodes.filter(node => node.type === 'agent');
      if (agents.length !== 1) throw fail('Model changes need a single-agent workflow. Edit the saved workflow separately.');
      if (agentModel !== undefined) agents[0].model = agentModel.trim();
      if (agentEffort !== undefined) {
        if (agentEffort === 'inherit') delete agents[0].effort;
        else agents[0].effort = agentEffort;
      }
      fields.workflow = workflow;
    }
    if (fields.retry) fields.retry = { ...original.retry, ...fields.retry };
    if (fields.limits) fields.limits = { ...original.limits, ...fields.limits };
    if (fields.cwd !== undefined) {
      // The folder is host-local; never assume that a relative or nonexistent path is safe.
      if (!path.isAbsolute(fields.cwd)) throw fail('Choose an existing absolute working folder.');
      try { if (!(await stat(fields.cwd)).isDirectory()) throw fail('Choose an existing absolute working folder.'); }
      catch { throw fail('Choose an existing absolute working folder.'); }
    }
    return summary(await this.operations.update(args.scheduleId, { ...fields, expectedRevision: args.expectedRevision }, {actor:'chatgpt-connector'}));
  }
}
