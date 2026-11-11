import { projectPlanningBrowserExecution } from './planning-browser-http.mjs';
import { readPlanningGraphRequest, planningAttemptMetadata } from './direct-planning-browser-tools.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' };
const requestId = { ...text(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable ID for this exact module action. Retry identical arguments with the same ID to recover admission without starting another worker.' };
const common = { requestId, graphRequestId: id, nodeId: id };
const action = (name, fields, required) => object({ ...common, action: { const: name }, ...fields }, ['requestId', 'action', 'graphRequestId', 'nodeId', ...required]);
const inputSchema = { type: 'object', required: ['requestId', 'action'], oneOf: [
  action('run', { expectedNodeRevision: { type: 'integer', minimum: 1 }, model: text(500), effort: { enum: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, serviceTier: { enum: ['default', 'fast'] } }, ['expectedNodeRevision']),
  action('cancel', { attemptId: id, reason: text(1800) }, ['attemptId']),
] };
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

/** Explicit admission/cancellation is separate from inert graph reads and edits. */
export function createDirectPlanningExecutionTools({ store, runner, executionContext = null, onChange = () => {} } = {}) {
  if (!runner) return [];
  if (!store?.get || typeof runner.start !== 'function' || typeof runner.cancel !== 'function' || typeof runner.status !== 'function') throw fail('Use the app-owned Planning store and runtime.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  if (executionContext !== null && typeof executionContext !== 'function') throw fail('Use a host-owned execution context provider.', 'DIRECT_PLANNING_CONFIGURATION', 503);
  const resolveContext = executionContext || ((_args, {client,jobId}) => { if (!client?.id || !jobId) throw fail('An authenticated durable direct job is required.', 'DIRECT_AUTH_REQUIRED', 401); return {clientRequestId:jobId}; });
  const project = request => { let snapshot = null; try { snapshot = runner.status(); } catch {} return projectPlanningBrowserExecution(request, snapshot); };
  return [{
    definition: {
      name: 'blackice_planning_module',
      description: 'Explicitly run one saved Planning module at its current node revision, or cancel its exact active attempt. run starts a configured-model analytical response worker and can incur provider charges; it returns admission, not a completed answer or proof of external effects. Analytical workers have no action tools. Use blackice_planning_graph_read get/attempts to inspect current host status, then response_history for actual public results. cancel requires the exact request, module and attempt IDs, preserves saved evidence, and never undoes completed effects. Reading, editing or skipping a module never runs it. A settled direct job confirms this control action, not module completion.',
      scope: 'commands:run', requiredScopes: ['commands:run', 'planning:write'], inputSchema, mutating: true,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async execute(args, context = {}) {
      const {signal} = context; signal?.throwIfAborted();
      const {clientRequestId} = await resolveContext(args,context);
      if (typeof clientRequestId !== 'string' || !clientRequestId) throw fail('The host execution context is unavailable.', 'DIRECT_PLANNING_CONFIGURATION', 503);
      const before = await store.get(args.graphRequestId);
      const node = before.nodes.find(item => item.id === args.nodeId);
      if (!node) throw fail('Planning module not found.', 'PLANNING_NODE_NOT_FOUND', 404);
      let admitted = null;
      if (args.action === 'run') {
        if (node.skipReason) throw fail('Resume this skipped module before running it.', 'PLANNING_MODULE_SKIPPED', 409);
        admitted = await runner.start({ requestId: args.graphRequestId, nodeId: args.nodeId, ...pick(args, ['expectedNodeRevision', 'model', 'effort', 'serviceTier']), clientRequestId, automatic: false, signal });
      } else if (args.action === 'cancel') {
        const attempt = (before.attempts || []).find(item => item.id === args.attemptId && item.nodeId === args.nodeId);
        if (!attempt) throw fail('This attempt does not belong to the selected module.', 'PLANNING_ATTEMPT_NOT_FOUND', 404);
        if (!['queued', 'running'].includes(attempt.status)) throw fail('This attempt has already settled. Read its saved outcome.', 'PLANNING_BROWSER_ATTEMPT_SETTLED', 409);
        await runner.cancel(attempt.id, { reason: args.reason || 'Stopped through the connected Planning tools.' });
      } else throw fail('Choose run or cancel.', 'DIRECT_PLANNING_EXECUTION_INVALID');
      const saved = project(await store.get(args.graphRequestId));
      try { await onChange({ type: 'planning.browser.updated', data: { requestId: saved.id, conversationId: saved.conversationId, revision: saved.revision }, at: new Date().toISOString() }); } catch {}
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
        operation: args.action, ...readPlanningGraphRequest(saved, { nodeId: args.nodeId }),
        ...(admitted?.attempt ? { admittedAttempt: planningAttemptMetadata(admitted.attempt) } : {}),
        executionRequested: args.action === 'run', externalActionExecuted: false,
      }) }] };
    },
  }];
}
