import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestId = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' };
const ident = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]{1,100}$' };
const revision = { type: 'integer', minimum: 1 };
const error = (message, code = 'SWARM_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status });
const response = data => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] });

/** Shared model/connector transport. Actor identity comes only from the host, never from arguments.
 * Tool success acknowledges a saved coordination record, not task delivery or execution.
 */
export function createSwarmDirectTools({ board, isClosing = () => false } = {}) {
  if (!board?.apply || !board?.snapshot) throw error('Swarm ledger not initialized.');
  const actorFor = ({ client, nativeContext } = {}) => {
    if (client?.id) return { kind: 'connector', id: String(client.id).slice(0, 100),
      label: String(client.label || 'ChatGPT connector').slice(0, 160) };
    if (nativeContext?.runId && nativeContext?.nodeId)
      return { kind: 'native', id: digest([nativeContext.runId, nativeContext.nodeId]).slice(0, 40),
        label: 'Native worker ' + String(nativeContext.runId).slice(0, 80) };
    throw error('An authenticated worker context is required.', 'SWARM_ACTOR_REQUIRED', 401);
  };
  return [
    {
      definition: {
        name: 'blackice_swarm_read', scope: 'read', requiredScopes: ['read'], mutating: false,
        description: 'Read the separate BLACKICE Swarm PROJECT MANAGEMENT board with the authenticated self identity needed for binding a worker to its coordination scope. Lists workers, owners, dependencies, proposed/queued/delivered/accepted/completed phases, requested versus coordinator-approved readiness, integration, provenance and stale/failed evidence. No worker starts or success is proven; optional projectId selects one project.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'],
          properties: { requestId, projectId: ident } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      durableArguments: args => ({ requestId: args.requestId, projectId: args.projectId || null }),
      execute: async (args, context = {}) => response({
        ...board.snapshot(args.projectId || null),
        self: context.client?.id || context.nativeContext?.runId ? actorFor(context) : null,
      }),
    },
    {
      definition: {
        name: 'blackice_swarm_write', scope: 'planning:write', requiredScopes: ['planning:write'], mutating: true,
        description: 'Bidirectionally update Swarm PROJECT MANAGEMENT, not recursive task Planning. Read current project/item/source revisions first. Specify a stable mutationId to dedupe a lost acknowledgement, then action and exact data. Workers can propose scope/items, add source/evidence, report delivery, accept their assigned work and request readiness; only coordinator/human can queue, decide ready, record integration or complete. A ready request is NEVER an approval. Evidence claims bind exact requirement and source revisions; failed/stale records remain visible. This stores coordination only; no worker starts, merger runs, delivery is verified, or release occurs.',
        inputSchema: { type: 'object', additionalProperties: false,
          required: ['requestId', 'mutationId', 'action'],
          properties: {
            requestId, mutationId: ident,
            action: { type: 'string', enum: ['create_project','edit_project','register_worker','propose_item',
              'edit_item','transition','record_source','record_evidence','resolve_failure',
              'request_ready','decide_ready','record_integration'] },
            projectId: ident, itemId: ident, sourceId: ident, workerId: ident,
            expectedProjectRevision: revision, expectedItemRevision: revision, expectedSourceRevision: revision,
            value: { type: 'object' }, note: { type: 'string' },
          } },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      durableArguments: args => ({ requestId: args.requestId, mutationId: args.mutationId,
        action: args.action, payloadSha256: digest(args) }),
      execute: async (args, context = {}) => {
        if (context.signal?.aborted || isClosing()) throw error('Swarm write did not start.');
        const actor = actorFor(context);
        const { requestId: _transport, ...input } = args;
        return response(await board.apply(input, actor));
      },
    },
  ];
}
