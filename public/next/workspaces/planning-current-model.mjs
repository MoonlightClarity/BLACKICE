/** Read-only projections of current conversation, Goal and Directory records.
 * Graph requests are independent artifacts and never determine this view.
 */
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clean = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const strings = value => array(value).filter(item => typeof item === 'string');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const pendingStates = new Set(['queued', 'starting', 'waiting', 'cancelling', 'stopping']);
const terminalLabels = { completed: 'Finished', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };
const phaseLabels = { decompose: 'Plan work', 'context-page': 'Read context', work: 'Execute work', repair: 'Repair',
  integration: 'Synthesize', 'extract-page': 'Extract source', 'page-extract': 'Extract source', 'repository-review': 'Review repository' };

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

/** Context corrections are authoritative for display; deletion is never undone. */
export function planningDirectoryRecord(response) {
  if (!object(response)) return response;
  if (response.managedDeleted === true) return null;
  if (Object.hasOwn(response, 'managedValue')) {
    return response.editMode === 'fields' && object(response.value) && object(response.managedValue)
      ? { ...response.value, ...response.managedValue } : response.managedValue;
  }
  return Object.hasOwn(response, 'value') ? response.value : response;
}

export function planningDirectoryPhases(turns, { runId } = {}) {
  const rows = array(planningDirectoryRecord(turns));
  return rows.filter(row => object(row) && Object.hasOwn(phaseLabels, row.label) && (!runId || row.runId === runId)).map(row => ({
    ...row, id: clean(row.id), runId: clean(row.runId), label: row.label, title: phaseLabels[row.label],
    module: clean(row.module), at: clean(row.at), sourceFiles: strings(row.sourceFiles), excerpt: typeof row.excerpt === 'string' ? row.excerpt : '',
    file: /^[A-Za-z0-9_-]+$/.test(row.runId || '') && /^[A-Za-z0-9_-]+$/.test(row.id || '') ? 'runs/' + row.runId + '/turns/' + row.id + '.json' : null,
  }));
}

export function planningDirectorySummary({ conversation = {}, goal = conversation?.goal, listing, turns } = {}) {
  const files = array(listing?.files).filter(row => object(row) && typeof row.file === 'string');
  const saved = object(listing?.summary) ? listing.summary : {};
  const summary = Object.hasOwn(listing || {}, 'managedSummary')
    ? planningDirectoryRecord({ value: saved, managedValue: listing.managedSummary, editMode: listing.managedSummaryEditMode }) : saved;
  const effective = object(summary) ? summary : {};
  const runId = planningConversationRunId({ ...conversation, goal }) || clean(saved.currentRun);
  const recordedRunId = clean(saved.currentRun);
  const belongsToSelectedRun = !recordedRunId || !runId || recordedRunId === runId;
  const rows = array(planningDirectoryRecord(turns));
  const phases = planningDirectoryPhases(rows, { runId });
  const current = belongsToSelectedRun ? saved : {};
  const invalidation = listing?.invalidation?.staleRuns?.[runId];
  const stale = invalidation?.state === 'stale';
  const reviewStaleReason = stale ? clean(invalidation.reason) || 'Context changed after this review.' : '';
  const status = clean(current.directoryStatus) || 'not_recorded';
  const statusLabel = stale ? 'Context changed' : ({ running: 'In progress', completed: 'Finished', incomplete: 'Unfinished', cancelled: 'Stopped', failed: 'Failed', not_recorded: 'No run record' })[status] || status;
  const outcome = object(current.outcomeAssessment) ? { ...current.outcomeAssessment,
    stale, label: stale ? 'Earlier review' : ({ respond: 'Response reviewed', blocked: 'Unfinished', continue: 'Further work requested', revise: 'Response revision requested' })[current.outcomeAssessment.decision] || 'Recorded outcome review' } : null;
  return {
    available: files.length > 0 || Object.keys(saved).length > 0,
    runId, recordedRunId, belongsToSelectedRun, status, statusLabel, stale, reviewStaleReason,
    request: typeof current.request === 'string' ? current.request : clean(conversation.input) || clean(conversation.task) || clean(goal?.objective),
    modelPhases: turns === undefined ? count(current.modelCalls) : phases.length,
    auditRecords: rows.filter(row => object(row) && (!runId || row.runId === runId)).length,
    totalAuditRecords: rows.length, contextFiles: files.length,
    plannedWorkItems: count(current.plannedWorkItems), planningCalls: count(current.planningCalls),
    outcome, notes: typeof effective.userSummary === 'string' ? effective.userSummary : '',
    pinnedConstraints: strings(effective.pinnedConstraints), failure: current.failure ?? null,
    workItemFiles: files.filter(row => (!runId || row.file.startsWith('runs/' + runId + '/')) && /\/modules\/(?:\d+(?:\.\d+)*\/)+module\.json$/.test(row.file)),
  };
}

/** Work reports stay distinct from an actual recorded verification. */
export function planningDirectoryWorkItems(records, { runId } = {}) {
  const byFile = new Map(array(records).filter(row => object(row) && typeof row.file === 'string').map(row => [row.file, row]));
  const items = [];
  for (const [file, response] of byFile) {
    if (!/\/modules\/(?:\d+(?:\.\d+)*\/)+module\.json$/.test(file) || runId && !file.startsWith('runs/' + runId + '/')) continue;
    const value = planningDirectoryRecord(response);
    if (!object(value)) continue;
    const resultResponse = byFile.get(file.replace(/module\.json$/, 'result.json'));
    const result = planningDirectoryRecord(resultResponse);
    const report = object(result) ? result : {};
    const userEdited = Object.hasOwn(response, 'managedValue') || Boolean(resultResponse && Object.hasOwn(resultResponse, 'managedValue'));
    const verified = report.verified === true && !userEdited;
    const reportedStatus = clean(report.workStatus), recordedStatus = clean(report.status) || clean(value.status);
    let state = verified ? 'verified' : reportedStatus === 'complete' ? 'reported_complete' : ['incomplete', 'blocked'].includes(reportedStatus) ? reportedStatus
      : value.status === 'expanded' ? 'group' : value.status === 'atomic' ? 'planned' : 'recorded';
    if (/^superseded/.test(recordedStatus)) state = 'superseded';
    items.push({ ...value, id: clean(value.id), file, resultFile: resultResponse?.file || null, state,
      label: ({ verified: 'Verified', reported_complete: 'Reported complete', incomplete: 'Unfinished', blocked: 'Blocked', group: 'Group', planned: 'Planned', recorded: 'Work recorded', superseded: 'Superseded' })[state],
      objective: typeof value.objective === 'string' ? value.objective : '', doneWhen: clean(value.doneWhen) || clean(report.completionCriterion),
      dependsOn: strings(value.dependsOn), children: strings(value.children), requirementIds: strings(value.requirementIds),
      finding: typeof report.finding === 'string' ? report.finding : '', answer: typeof report.candidate_answer === 'string' ? report.candidate_answer : '',
      uncertainty: typeof report.uncertainty === 'string' ? report.uncertainty : '', nextAction: typeof report.nextAction === 'string' ? report.nextAction : '',
      verified, userEdited, reportedStatus, recordedStatus,
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
