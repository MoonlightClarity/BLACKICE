import { createHash } from 'node:crypto';
import { swarmWriteInputSchema } from './swarm-action-contract.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestId = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' };
const ident = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]{1,100}$' };
const error = (message, code = 'SWARM_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status });
const response = data => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] });

/** OAuth-connector-only project ledger adapter (not a native worker tool).
 * The host authenticates a grant, not a chat/worker. Successful writes acknowledge
 * coordination storage only, never dispatch, delivery or verified execution.
 */
export function createSwarmDirectTools({ board, isClosing = () => false } = {}) {
  if (!board?.apply || !board?.snapshot) throw error('Swarm ledger not initialized.');
  // DirectExecutionAPI supplies the authenticated OAuth grant as context.client.
  // There is no verified per-chat/per-worker identity in this adapter. A claimed
  // nativeContext is deliberately insufficient: the engine has not registered
  // this tool in its native-worker catalog.
  const actorFor = ({ client } = {}) => {
    if (typeof client?.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(client.id))
      throw error('An authenticated connector grant context is required.', 'SWARM_ACTOR_REQUIRED', 401);
    return { kind: 'connector', id: client.id, label: 'Connector OAuth grant (shared across chats)' };
  };
  const identityScope = Object.freeze({
    kind: 'oauth-grant', hostAuthority: 'DirectExecutionAPI authenticated client',
    individualChatVerified: false, individualWorkerVerified: false, nativeWorkerToolsRegistered: false,
    description: 'All chats sharing an OAuth grant have the same Swarm actor and permissions. A registered worker actorId binds a grant, not a particular chat or model worker.',
  });
  return [
    {
      definition: {
        name: 'blackice_swarm_read', scope: 'read', requiredScopes: ['read'], mutating: false,
        description: 'Read Swarm PROJECT MANAGEMENT. self.id is the host-authenticated OAuth grant, SHARED by every ChatGPT chat using that grant; it does NOT authenticate an individual conversation or worker. Returns owner/scope/dependencies, proposed/queued/delivered/accepted/completed stages, ready requests versus coordinator decisions, integration and stale/failed evidence. A saved report is NOT verified dispatch, delivery, worker activity or release. Optional projectId selects one project.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'],
          properties: { requestId, projectId: ident } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      durableArguments: args => ({ requestId: args.requestId, projectId: args.projectId || null }),
      execute: async (args, context = {}) => response({
        ...board.snapshot(args.projectId || null),
        self: context.client?.id ? { ...actorFor(context), identityScope: 'oauth-grant' } : null,
        identityScope,
      }),
    },
    {
      definition: {
        name: 'blackice_swarm_write', scope: 'planning:write', requiredScopes: ['planning:write'], mutating: true,
        description: 'Write Swarm PROJECT MANAGEMENT only. Discover the oneOf action discriminator for exact required value fields and optimistic revision. Read before writing. The actor is the authenticated OAuth GRANT: same-grant chats have identical authority and cannot be distinguished as workers. Only bound grant/human may assert assigned delivery/readiness. Ready requests are not coordinator approvals. Ledger writes do not dispatch workers or verify external effects. Native engine Swarm tool registration is absent.',
        inputSchema: swarmWriteInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      durableArguments: args => ({ requestId: args.requestId, mutationId: args.mutationId,
        action: args.action, payloadSha256: digest(args) }),
      execute: async (args, context = {}) => {
        if (context.signal?.aborted || isClosing()) throw error('Swarm write did not start.');
        const actor = actorFor(context);
        const { requestId: _transport, ...input } = args;
        return response({ ...(await board.apply(input, actor)), identityScope });
      },
    },
  ];
}
