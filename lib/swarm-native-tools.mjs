import { createHash } from 'node:crypto';
import { validDirectArguments } from './direct-execution-api.mjs';
import { swarmWriteInputSchema } from './swarm-action-contract.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (message, code = 'SWARM_NATIVE_SCOPE', status = 403) =>
  Object.assign(new Error(message), { code, status });
const response = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const ident = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]{1,100}$' };
const requestId = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' };
const rev = { type: 'integer', minimum: 1 };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const readSchema = object({ requestId, projectId: ident }, ['requestId']);
const receiveSchema = object({ requestId, projectId: ident, itemId: ident, expectedRequirementRevision: rev },
  ['requestId', 'projectId', 'itemId', 'expectedRequirementRevision']);
const ackSchema = object({ requestId, projectId: ident, itemId: ident, expectedRequirementRevision: rev,
  deliveryId: { type: 'string', pattern: '^delivery_[a-f0-9]{32}$' },
  ackToken: { type: 'string', pattern: '^[a-f0-9]{48}$' } },
['requestId', 'projectId', 'itemId', 'expectedRequirementRevision', 'deliveryId', 'ackToken']);
const names = Object.freeze(['relay_swarm_read', 'relay_swarm_write', 'relay_swarm_receive', 'relay_swarm_ack']);
export const NATIVE_SWARM_TOOL_NAMES = names;
export const nativeSwarmActorId = ({ taskId, runId, nodeId, isWorker = false }) => {
  if (typeof taskId !== 'string' || !taskId.trim() || typeof nodeId !== 'string' || !nodeId.trim()
    || isWorker && (typeof runId !== 'string' || !runId.trim()))
    throw error('Native Swarm requires the host-bound task/node and worker-run identity.', 'SWARM_NATIVE_CONTEXT');
  // A saved coordinator keeps identity across same-chat continuation. Short-lived
  // delegates are isolated by exact run, so a new worker using the same task ID
  // cannot inherit an earlier worker's rights or ambiguous delivery receipts.
  return 'native_' + hash(isWorker
    ? ['worker', taskId, runId, nodeId] : ['coordinator', taskId, nodeId]).slice(0, 56);
};
const definitions = [
  { name: names[0], description: 'Read project management records accessible to this host-bound native task/node. An unbound worker gets its own stable identity but not foreign project records. This read never delivers or acknowledges an assignment.',
    inputSchema: readSchema, mutating: false },
  { name: names[1], description: 'Write a Swarm ledger record with exact action-specific oneOf fields. Identity and worker/coordinator scope come from the actual host engine, never model arguments. The model cannot claim another owner or perform external dispatch by recording a phase. Use a new mutationId only for a new intentional change.',
    inputSchema: swarmWriteInputSchema, mutating: true },
  { name: names[2], description: 'Explicitly prepare a persistent response for this host-bound worker\'s own queued assignment at its exact requirements revision. Prepared does NOT mean the provider consumed it, the worker acknowledged it, or any action executed. Repeated reads return the same delivery ID/token; do not replay uncertain external effects.',
    inputSchema: receiveSchema, mutating: true },
  { name: names[3], description: 'Acknowledge one exact previously prepared native assignment by echoing its unpredictable receipt token and requirement revision. This is a host-observed provider tool callback proving the prior receipt was available to this worker, NOT proof the actual work was performed. Same acknowledgment is idempotent.',
    inputSchema: ackSchema, mutating: true },
].map(item => ({ type: 'function', ...item, annotations: {
  readOnlyHint: !item.mutating, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} }));

const nativeGuidance = '\nSWARM PROJECT COORDINATION\nrelay_swarm tools operate on the management ledger and never run an assignment. First read to discover your stable native identity and accessible projects. A human or the recorded coordinator must bind your identity to an explicit worker scope/owned item. For a queued assigned item, relay_swarm_receive prepares a durable response; only a separate relay_swarm_ack call with the returned token establishes an observed receipt acknowledgment. Neither preparation nor acknowledgment proves work completion. Distinguish a model-reported phase, a host-prepared response, and a host-observed acknowledgment. Respect exact revisions, source evidence and existing owners. Never blindly repeat uncertain effects.';

const checkSignal = (signal, isClosing) => {
  if (signal?.aborted || isClosing()) throw error('Native Swarm dispatch cancelled or closing before admission.',
    'SWARM_NATIVE_CANCELLED', 409);
};

export function createNativeSwarmTools({ board, isClosing = () => false } = {}) {
  if (!board?.snapshot || !board?.apply || !board?.nativePrepareAssignment || !board?.nativeAcknowledgeAssignment)
    throw error('The real durable Swarm board is required for native dispatch.', 'SWARM_NATIVE_CONFIGURATION', 503);
  const provider = async ({ taskId, runId, nodeId, signal, canWrite = true, isWorker = false } = {}) => {
    if (![taskId, runId, nodeId].every(v => typeof v === 'string' && v.trim())
      || typeof canWrite !== 'boolean' || typeof isWorker !== 'boolean')
      throw error('Native Swarm requires the actual host task/run/node and role.', 'SWARM_NATIVE_CONTEXT', 403);
    const actor = { kind: 'native', id: nativeSwarmActorId({taskId,runId,nodeId,isWorker}),
      label: 'Native node ' + nodeId.slice(0, 100) };
    const identity = { ...actor, taskId, nodeId, runId, role: isWorker ? 'scoped-worker' : 'coordinator',
      hostBound: true, origin: 'engine-runtime',
      scope: 'Recorded coordinator or exact assigned worker; no user-supplied actor override.' };
    const scoped = () => {
      const catalog = board.snapshot();
      const own = catalog.projects.filter(project =>
        project.coordinator.kind === actor.kind && project.coordinator.id === actor.id
        || project.workers.some(worker => worker.actorId === actor.id));
      return own;
    };
    const membership = project => {
      const coordinator = project.coordinator.kind === actor.kind && project.coordinator.id === actor.id;
      const workers = project.workers.filter(worker => worker.actorId === actor.id);
      if (workers.length > 1) throw error('Ambiguous native worker identity: one actor is registered to multiple worker records in the same project.', 'SWARM_NATIVE_AMBIGUOUS');
      return { coordinator, worker: workers[0] || null };
    };
    const itemScope = (project, itemId) => {
      const { coordinator, worker } = membership(project);
      const item = project.items.find(entry => entry.id === itemId);
      if (!item || !worker || item.ownerId !== worker.id)
        throw error('This native worker is not bound to the selected item.', 'SWARM_NATIVE_SCOPE');
      return { item, worker, coordinator };
    };
    const ensureProject = (projectId) => {
      const project = scoped().find(project => project.id === projectId);
      if (!project) throw error('This project is not in the native node\'s recorded scope.', 'SWARM_NATIVE_SCOPE');
      return project;
    };
    const guardWrite = args => {
      if (!canWrite) throw error('This native runtime is read-only.', 'SWARM_NATIVE_READ_ONLY');
      if (args.action === 'create_project') {
        if (isWorker) throw error('Delegated native workers cannot create or coordinate projects.', 'SWARM_NATIVE_SCOPE');
        return;
      }
      const project = ensureProject(args.projectId);
      const {coordinator, worker} = membership(project);
      if (coordinator && !isWorker) return;
      if (!worker) throw error('Native worker must be registered to this project.', 'SWARM_NATIVE_SCOPE');
      const permitted = new Set(['propose_item','record_evidence','request_ready','transition']);
      if (!permitted.has(args.action)) throw error('Only a recorded coordinator may edit shared source/ownership/decisions or integration.', 'SWARM_NATIVE_SCOPE');
      if (args.action === 'propose_item') {
        if (args.value.ownerId !== undefined && args.value.ownerId !== null && args.value.ownerId !== worker.id)
          throw error('A native worker cannot propose an item owned by another worker.', 'SWARM_NATIVE_SCOPE');
        return;
      }
      itemScope(project, args.itemId);
      if (args.action === 'transition' && !['delivered','accepted'].includes(args.value.phase))
        throw error('A native worker may only report delivery or accept its own queued assignment.', 'SWARM_NATIVE_SCOPE');
    };
    const available = definitions.filter(def => canWrite || !def.mutating);
    return {
      tools: available.map(def => structuredClone(def)),
      instructions: nativeGuidance,
      identity,
      async handle(call, context = {}) {
        const entry = available.find(def => def.name === call?.name);
        if (!entry || call.namespace) throw error('This native Swarm tool is not attached to the current worker.', 'SWARM_NATIVE_UNAVAILABLE');
        let args;
        try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : structuredClone(call.arguments); }
        catch { throw error('Use exact Swarm JSON tool arguments.', 'SWARM_NATIVE_ARGUMENTS', 400); }
        if (!validDirectArguments(args, entry.inputSchema))
          throw error('Use the declared action-specific Swarm tool schema, including exact ownership revisions.', 'SWARM_NATIVE_ARGUMENTS', 400);
        checkSignal(signal, isClosing); checkSignal(context.signal, isClosing);
        // Either the parent run or this exact provider call may be cancelled.
        const activeSignal = signal && context.signal ? AbortSignal.any([signal, context.signal])
          : context.signal || signal;
        let result;
        if (entry.name === names[0]) {
          const projects = scoped();
          if (args.projectId && !projects.some(project => project.id === args.projectId))
            throw error('The requested project is not in this native actor\'s scope.', 'SWARM_NATIVE_SCOPE');
          result = { self: identity, projects: args.projectId ? projects.filter(project => project.id === args.projectId) : projects,
            deliverySemantics: 'Read has no dispatch effect. Model action and human acceptance remain separate.' };
        } else if (entry.name === names[1]) {
          guardWrite(args);
          const { requestId: _transport, ...body } = args;
          result = { ...await board.apply(body, actor, {signal: activeSignal}),
            self: identity, effect: 'saved-project-ledger-only' };
        } else if (entry.name === names[2]) {
          const project = ensureProject(args.projectId);
          itemScope(project, args.itemId);
          result = { ...await board.nativePrepareAssignment({...args, actor, taskId,runId,nodeId, signal:activeSignal }),
            self: identity, deliverySemantics: 'Host persisted a prepared response; provider consumption and acknowledgment remain unverified.' };
        } else if (entry.name === names[3]) {
          const project = ensureProject(args.projectId);
          itemScope(project, args.itemId);
          result = { ...await board.nativeAcknowledgeAssignment({...args, actor, taskId,runId,nodeId, signal:activeSignal }),
            self: identity, deliverySemantics: 'Host observed explicit acknowledgment through this native tool callback; execution not established.' };
        }
        return response(result);
      },
    };
  };
  // Used only to recover exact previously attached native tool schemas.
  provider.catalog = definitions.map(def => structuredClone(def));
  return provider;
}
