/** Register only when the desktop app owns the graceful restart controller. */
export function desktopRestartTool({ restart, getJob } = {}) {
  if (typeof restart?.request !== 'function' || typeof getJob !== 'function') throw new TypeError('The desktop restart tool needs its app-owned controller and durable job reader.');
  return {
    definition: {
      name: 'blackice_restart',
      description: "Schedule BLACKICE's native restart while preserving its profile and mode. Ordinary restart reports active work that prevents it. force:true pauses automatic queues and stops cancellable work before restarting; other reported blockers can still prevent restart. Returns a scheduling job and temporarily disconnects the connector. After reconnecting, read that job and blackice_direct_status.restart.receipt; status completed with the same requestId confirms replacement process startup. Recover an uncertain restart by reading its receipt rather than creating another request.",
      scope: 'commands:run', requiredScopes: ['commands:run'], mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$',
            description: "ID for this restart under the current connectionId. Reuse it with identical arguments to recover the saved receipt. If the connection changed, inspect the earlier restart before submitting another.",
          },
          force: {
            type: 'boolean',
            description: "true pauses automatic queues and stops cancellable work before restart. false or omitted requests an ordinary restart. The receipt identifies any remaining browser, storage or app-session blocker.",
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
