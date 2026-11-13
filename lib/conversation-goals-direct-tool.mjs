import { createHash } from 'node:crypto';

const payload = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const fail = (message, code = 'GOAL_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

/** Direct controls use the same durable goal and runner as BLACKICE Chat. */
export function conversationGoalsDirectTool({ goals, isClosing = () => false } = {}) {
  if (typeof goals?.get !== 'function' || typeof goals?.control !== 'function')
    throw fail('An initialized conversation goal service is required.', 'GOAL_UNAVAILABLE', 503);
  return {
    definition: {
      name: 'blackice_goal',
      scope: 'read',
      requiredScopes: ['read'],
      mutating: true,
      description: 'Read, set, edit, pause, resume, or clear the persistent goal in an existing BLACKICE conversation. Set and resume can launch the saved conversation model and consume provider tokens. Goals continue in that same conversation until completed or paused; the default turn budget is unlimited. Uses the existing authorized connection with no extra per-run approval. Read the current revision before edits. A returned run confirms admission, not completion.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['requestId', 'conversationId', 'action'],
        properties: {
          requestId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' },
          conversationId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' },
          action: { type: 'string', enum: ['get', 'set', 'update', 'pause', 'resume', 'clear'] },
          objective: { type: 'string', minLength: 1, description: 'The whole outcome to pursue. Include what done means and relevant constraints.' },
          expectedRevision: { type: 'integer', minimum: 1 },
          maxTurns: { type: ['integer', 'null'], minimum: 1, description: 'Optional total turn budget. Omit or use null for unlimited; add a limit only when requested.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    durableArguments: args => ({
      requestId: args.requestId, conversationId: args.conversationId, action: args.action,
      ...(args.objective !== undefined ? { objectiveCharacters: args.objective.length,
        objectiveSha256: createHash('sha256').update(args.objective).digest('hex') } : {}),
      ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
      ...(Object.hasOwn(args, 'maxTurns') ? { maxTurns: args.maxTurns } : {}),
    }),
    async execute(args, { signal, client } = {}) {
      if (signal?.aborted) throw fail('Cancelled before changing the goal.', 'ABORT_ERR', 409);
      if (args.action === 'get') return payload({ goal: await goals.get(args.conversationId) });
      if (isClosing()) throw fail('BLACKICE is shutting down. The goal was not changed.', 'GOAL_UNAVAILABLE', 503);
      if (!client?.id) throw fail('An authenticated connection is required.', 'GOAL_UNAUTHORIZED', 401);
      const requestId = 'connector_goal_' + createHash('sha256').update(client.id + '\0' + args.requestId).digest('hex').slice(0, 40);
      const { conversationId, ...value } = args;
      return payload(await goals.control(conversationId, { ...value, requestId }));
    },
  };
}
