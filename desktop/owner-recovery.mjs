const fail = (message, code = 'OWNER_RECOVERY_INVALID') => Object.assign(new Error(message), { code });
const actor = 'native-owner-confirmation';
function requestOf(args) {
  const value = args[0];
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'requestId') || !Object.hasOwn(value, 'revision')
    || typeof value.requestId !== 'string' || !value.requestId.length || value.requestId.length > 256
    || !(typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 256
      || Number.isSafeInteger(value.revision) && value.revision >= 0)) throw fail('Choose an exact pending recovery request and revision.');
  return { requestId: value.requestId, revision: value.revision };
}
function pending(row, request) {
  if (!row || row.requestId !== request.requestId || row.revision !== request.revision || row.state !== 'pending')
    throw fail('This recovery request is no longer pending. Refresh its current state; nothing was approved.', 'OWNER_RECOVERY_STALE');
  return row;
}
export function ownerRecoveryDialog(row) {
  // The renderer supplies only an identity. All material displayed data comes
  // from the host's frozen candidate, never caller-provided confirmation prose.
  if (!row || row.oneUse !== true || !row.candidate || !Array.isArray(row.claims) || !row.claims.length || typeof row.risk !== 'string')
    throw fail('This action has no complete owner review description.');
  const details = JSON.stringify({ taskId: row.taskId, runId: row.runId, nodeId: row.nodeId,
    candidate: row.candidate, retainedUncertainty: row.claims, expiresAt: row.expiresAt }, null, 2);
  if (details.length > 60000 || row.risk.length > 4000) throw fail('This action is too large for a complete native review. No action was approved.');
  return { type: 'warning', title: 'Review one blocked BLACKICE action',
    message: 'Allow this one exact action despite the retained uncertainty?',
    detail: row.risk + '\n\nThe older UNKNOWN records will remain unchanged. This is not proof they had no effects, and it does not authorize replaying them. Normal duplicate and other effect checks still apply. Approval expires with this pending action.\n\n' + details,
    buttons: ['Cancel action', 'Allow this one action'], defaultId: 0, cancelId: 0, noLink: true };
}
/** Native main-window workflow, not a security boundary against arbitrary code
 * already running as the same OS user. No HTTP/tool approval flag is exposed. */
export function createOwnerRecoveryHandlers({ trustedSender, control, showMessageBox }) {
  if (typeof trustedSender !== 'function' || typeof showMessageBox !== 'function') throw new TypeError('Owner review requires a trusted native window and native dialog.');
  const reviewing = new Set();
  const available = event => {
    if (!trustedSender(event)) throw fail('BLACKICE desktop request is not allowed.', 'OWNER_RECOVERY_SENDER');
    if (!control || !['read', 'approve', 'cancel'].every(key => typeof control[key] === 'function')) throw fail('Native owner recovery is unavailable.', 'OWNER_RECOVERY_UNAVAILABLE');
  };
  const review = async (event, ...args) => {
    available(event); const request = requestOf(args);
    if (reviewing.has(request.requestId)) throw fail('This action already has an open native review.', 'OWNER_RECOVERY_REVIEW_ACTIVE');
    reviewing.add(request.requestId);
    try {
      const row = pending(await control.read(request.requestId), request);
      const answer = await showMessageBox(ownerRecoveryDialog(row));
      available(event);
      pending(await control.read(request.requestId), request);
      if (answer?.response !== 1) return await control.cancel({ ...request, actor });
      return await control.approve({ ...request, actor });
    } finally { reviewing.delete(request.requestId); }
  };
  const cancel = async (event, ...args) => {
    available(event); const request = requestOf(args);
    pending(await control.read(request.requestId), request);
    return await control.cancel({ ...request, actor });
  };
  return { review, cancel };
}