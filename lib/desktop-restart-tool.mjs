/** Register only when the desktop app owns the graceful restart controller. */
export function desktopRestartTool({ restart, getJob } = {}) {
  if (typeof restart?.request !== 'function' || typeof getJob !== 'function') throw new TypeError('The desktop restart tool needs its app-owned controller and durable job reader.');
  return {
    definition: {
      name: 'blackice_restart',
      description: 'Schedule a native BLACKICE desktop restart, preserving the current profile and mode. By default active work blocks restart. Set force only when explicitly requested to pause automatic queues and stop cancellable work before the graceful handoff; completed effects remain, stopped work is not replayed, and browser, storage or application-session blockers may still refuse restart. The durable job confirms scheduling, not completed restart; the connection will temporarily disconnect. After reconnecting, inspect the same request and blackice_direct_status before continuing. Never submit a second restart to recover an uncertain request.',
      scope: 'commands:run', requiredScopes: ['commands:run'], mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$',
            description: 'A stable ID for this exact restart under the current connectionId. Retry identical arguments with the same ID only while blackice_direct_status reports the same connectionId. After a connection change, inspect the prior restart before submitting new work.',
          },
          force: {
            type: 'boolean',
            description: 'Explicitly force the restart by pausing automatic queues and stopping cancellable work. Omit or use false for an ordinary restart. Use true only when the user requested a forced restart; browser, storage or application-session blockers may still prevent it.',
          },
        },
        required: ['requestId'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async execute(args, { signal, jobId, client, restartOrigin, waitForRestartReceipt }) {
      if (restartOrigin && typeof waitForRestartReceipt !== 'function') throw new TypeError('The restart origin needs its owning executor receipt reader.');
      const receipt = await restart.request({ requestId: args.requestId, force: args.force ?? false, ownerId: client.id, jobId, signal, waitForReceipt: waitForRestartReceipt || (() => getJob(jobId)), ...(restartOrigin ? { origin: restartOrigin } : {}) });
      return { success: ['scheduled', 'restarting', 'completed'].includes(receipt.status), contentItems: [{ type: 'inputText', text: JSON.stringify(receipt) }] };
    },
  };
}
