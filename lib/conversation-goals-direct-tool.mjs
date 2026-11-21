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
      description: "Manage a goal in an existing conversation. get returns its current revision and state. set saves an objective; update changes it; resume restarts automatic continuation. set/resume can launch the conversation's model. Follow-up turns run in the same conversation while the goal is active. get reports status and lastReason when continuation stops.\npause interrupts the current run; pass its observed pauseRunId and wait for pauseRequest.settled. pause_after_turn lets the current turn finish and prevents the next. clear removes the goal. Use the current expectedRevision for changes; reread after a conflict. Use blackice_get_run_result with a returned run ID to inspect progress and completion.",
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['requestId', 'conversationId', 'action'],
        properties: {
          requestId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' },
          conversationId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' },
          action: { type: 'string', enum: ['get', 'set', 'update', 'pause', 'pause_after_turn', 'resume', 'clear'] },
          objective: { type: 'string', minLength: 1, description: 'The whole outcome to pursue. Include what done means and relevant constraints.' },
          pauseRunId: { type: 'string', minLength: 1, maxLength: 120, description: 'For pause, the exact currentRunId observed. Rejects a changed active turn.' },
          expectedRevision: { type: 'integer', minimum: 1 },
          expectedControl: {type:'object',additionalProperties:false,required:['goalId','generation','status','runId'],
            description:"For pause/resume, copy goalId, generation, status and runId from the current goal. These identify the goal being controlled when progress updates advance its revision.",
            properties:{goalId:{type:'string',minLength:1},generation:{type:'integer',minimum:1},status:{type:'string',enum:['active','waiting','paused','completed','blocked','interrupted','budget_exhausted']},runId:{type:['string','null']}}},
          maxTurns: { type: ['integer', 'null'], minimum: 1, description: 'Defaults to null for unlimited turns. A positive integer sets a total turn limit; update with null to remove an existing limit.' },
          deadlineAt: { type: ['string', 'null'], description: 'Explicit absolute ISO 8601 stop instant with Z or UTC offset. Null explicitly clears the deadline on edit.' },
          deadlineTimeZone: { type: 'string', description: 'Original zone: EST is fixed UTC-05, Eastern follows DST, or IANA zone. Requires explicit deadlineAt.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    durableArguments: args => ({
      requestId: args.requestId, conversationId: args.conversationId, action: args.action,
      ...(args.objective !== undefined ? { objectiveCharacters: args.objective.length,
        objectiveSha256: createHash('sha256').update(args.objective).digest('hex') } : {}),
      ...(args.pauseRunId !== undefined ? {pauseRunId: args.pauseRunId} : {}),
      ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
      ...(args.expectedControl !== undefined ? { expectedControl: structuredClone(args.expectedControl) } : {}),
      ...(Object.hasOwn(args, 'maxTurns') ? { maxTurns: args.maxTurns } : {}),
      ...(Object.hasOwn(args, 'deadlineAt') ? { deadlineAt: args.deadlineAt } : {}),
      ...(Object.hasOwn(args, 'deadlineTimeZone') ? { deadlineTimeZone: args.deadlineTimeZone } : {}),
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
