// Read-only recovery for repeated host-proven Directory focus rejections.
// This module never dispatches a tool, changes a budget, or turns a failure into success.
export const DIRECTORY_TOOL_RECOVERY_THRESHOLD = 8;

export function directoryToolFailure(previous, call, result) {
  if (result?.success !== false || result.code !== 'DIRECTORY_FOCUS' ||
      !Object.hasOwn(result, 'actionDispatched') || result.actionDispatched !== false ||
      typeof call?.name !== 'string' || !call.name) return null;
  let args;
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
  catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const tool = call.name, namespace = typeof call.namespace === 'string' ? call.namespace : null;
  const action = typeof args.action === 'string' ? args.action : '';
  const key = JSON.stringify([namespace, tool, action, result.code]);
  const count = previous?.key === key && Number.isSafeInteger(previous.count) && previous.count > 0
    ? Math.min(DIRECTORY_TOOL_RECOVERY_THRESHOLD, previous.count + 1) : 1;
  return { key, tool, namespace, action, code: result.code, count,
    lastCallId: call.callId ?? call.id ?? null, actionDispatched: false };
}

export function directoryToolRecovery(previous, failure, snapshot, finalStatus, taskScope) {
  if (!Number.isSafeInteger(failure?.count) || failure.count < DIRECTORY_TOOL_RECOVERY_THRESHOLD || failure?.code !== 'DIRECTORY_FOCUS' ||
      failure?.actionDispatched !== false || typeof failure?.key !== 'string' ||
      !Number.isSafeInteger(snapshot?.actionRevision) || !Array.isArray(snapshot?.actions) ||
      !Array.isArray(snapshot?.ready)) return { state: previous };
  const actions = snapshot.actions.map(({ id, objective, state, dependsOn }) => ({ id, objective, state, dependsOn }));
  // Receipt-only revisions and new call IDs do not create another recovery opportunity.
  const directoryState = JSON.stringify({ taskId: snapshot.taskId, actionRevision: snapshot.actionRevision,
    focus: snapshot.focus, actions, ready: snapshot.ready, requiresReplan: snapshot.steering?.requiresReplan === true });
  const recoveredKeys = previous?.directoryState === directoryState ? previous.recoveredKeys : [];
  if (recoveredKeys.includes(failure.key)) return { state: previous };
  const state = { directoryState, recoveredKeys: [...recoveredKeys, failure.key] };
  const current = {
    task: { ...taskScope, taskId: snapshot.taskId },
    directory: { revision: snapshot.revision, actionRevision: snapshot.actionRevision, focus: snapshot.focus,
      readyActions: snapshot.ready, actions, finalStatus },
    rejection: { tool: failure.tool, namespace: failure.namespace, action: failure.action,
      code: failure.code, lastCallId: failure.lastCallId, actionDispatched: false },
  };
  const prompt = 'At least eight consecutive calls of the same tool/action were rejected with DIRECTORY_FOCUS before dispatch. The original failed calls and results remain in this conversation.\n' +
    'Use relay_directory_action to recover the current task: read if its snapshot or binding needs refreshing; plan the matching action if missing; select a ready action and focus its exact id before retrying the rejected operation. Keep earlier successful reads and saved work. A rejected call is not completion; observe only the real result with its actual receipts. Inspect any uncertain earlier effect before repeating it.\n' +
    'This is a read-only host snapshot, not a tool result or a completed action. The same task, tools, history and remaining budget continue.\n' +
    JSON.stringify(current);
  return { state, prompt };
}
