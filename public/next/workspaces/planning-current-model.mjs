/** Read-only projections of current conversation, Goal records.
 * Graph requests are independent artifacts and never determine this view.
 */
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clean = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const pendingStates = new Set(['queued', 'starting', 'waiting', 'cancelling', 'stopping']);
const terminalLabels = { completed: 'Finished', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };

export const planningConversationId = row => clean(row?.rootId) || clean(row?.taskId) || clean(row?.conversationId) || clean(row?.id);
export const planningConversationRunId = row => {
  // A live goal observation can precede the catalog's next persisted run row.
  const liveGoalRun = row?.goal?.running === true || Boolean(clean(row?.goal?.runStatus));
  return (liveGoalRun ? clean(row?.goal?.currentRunId) : '') || clean(row?.latestRunId) || clean(row?.runId) || clean(row?.goal?.currentRunId) || clean(row?.id);
};
export const planningConversationTitle = row => clean(row?.title) || clean(row?.name) || 'Untitled conversation';

/** Saved, queued and active goal metadata do not imply an executing worker. */
export function planningConversationActivity(row = {}, goal = row?.goal) {
  const savedStatus = clean(row?.status).toLowerCase();
  const goalStatus = clean(goal?.runStatus).toLowerCase();
  const observedGoal = typeof goal?.running === 'boolean' && Object.hasOwn(goal, 'runStatus');
  const liveGoal = goal?.running === true || Boolean(goalStatus);
  let state = liveGoal ? goal?.running === true ? 'running' : goalStatus : savedStatus;
  if (row?.settled === true && !liveGoal) state = Object.hasOwn(terminalLabels, savedStatus) ? savedStatus : 'idle';
  else if (observedGoal && !liveGoal && ['running', ...pendingStates].includes(state)) state = 'unknown';
  if (state === 'running') return { state, label: 'Running', running: true, pending: true };
  if (pendingStates.has(state)) return { state, label: ({ queued: 'Queued', starting: 'Starting', waiting: 'Waiting', cancelling: 'Stopping', stopping: 'Stopping' })[state], running: false, pending: true };
  if (Object.hasOwn(terminalLabels, state)) return { state, label: terminalLabels[state], running: false, pending: false };
  if (state === 'unknown' || row?.state === 'unknown') return { state: 'unknown', label: 'Status unavailable', running: false, pending: false };
  return { state: 'idle', label: 'Saved', running: false, pending: false };
}

export function planningCurrentConversations(payload, { query = '', view = 'active' } = {}) {
  const rows = Array.isArray(payload) ? payload : array(payload?.conversations);
  const byId = new Map();
  for (const row of rows) {
    if (!object(row)) continue;
    const id = planningConversationId(row);
    if (!id || row.state === 'deleted' || row.bucket === 'deleted') continue;
    const previous = byId.get(id);
    if (previous && !(Date.parse(row.updatedAt || row.createdAt || '') > Date.parse(previous.updatedAt || previous.createdAt || ''))) continue;
    byId.set(id, { ...row, conversationId: id, id, runId: planningConversationRunId(row), title: planningConversationTitle(row), activity: planningConversationActivity(row) });
  }
  const term = clean(query).toLowerCase();
  return [...byId.values()].filter(row => {
    const state = row.state || row.bucket || 'active';
    if (view === 'running' && !row.activity.running) return false;
    if (view === 'active' && state !== 'active') return false;
    if (view === 'archived' && state !== 'archived') return false;
    return !term || [row.title, row.id, row.goal?.objective].some(value => clean(value).toLowerCase().includes(term));
  });
}
