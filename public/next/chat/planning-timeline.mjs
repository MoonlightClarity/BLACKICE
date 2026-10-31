import { taskPlanView } from '../../task-plan-model.mjs';

export const CHAT_PLANNING_ACTIVITY_LIMIT = 160;
export const CHAT_PLANNING_ACTIVITY_CHAR_LIMIT = 240000;
const clean = (value, limit = 1200) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const stepList = state => Array.isArray(state?.steps) ? state.steps.filter(step => step && typeof step === 'object' && !Array.isArray(step)).slice(0, 200) : [];
const structure = state => JSON.stringify({ goal: state?.goal, plan: Object.fromEntries(['layout', 'selectedChildId', 'branch', 'facts'].map(key => [key, state?.plan?.[key]])),
  steps: stepList(state).map(step => Object.fromEntries(['id', 'parentId', 'kind', 'title', 'dependsOn', 'selectedChildId', 'branch', 'operation', 'result', 'note', 'doneWhen', 'attempt'].map(key => [key, step[key]]))) });
const reviewId = review => `review:${review.runId}:${review.nodeId}:${review.reviewedRevision}`;
const reviewRows = (runId, state, order = 0) => (Array.isArray(state?.planningReviews) ? state.planningReviews : [])
  .filter(review => review?.runId === runId && ['continue', 'respond', 'blocked'].includes(review.decision) && clean(review.summary))
  .map(review => ({ id: reviewId(review), phase: 'plan', source: 'review', at: time(review.at), order,
    nodeId: clean(review.nodeId, 120), revision: review.reviewedRevision,
    title: review.decision === 'continue' ? 'Reassess · continue' : review.decision === 'blocked' ? 'Reassess · blocked' : 'Reassess · ready to respond',
    text: clean(review.summary), decision: review.decision,
    ...(review.decision === 'continue' && clean(review.nextStepId, 120) ? { nextStepId: clean(review.nextStepId, 120) } : {}) }));

/** Project only public saved planning actions and reported findings. Never read
 * provider reasoning items, tool arguments, raw tool results, or private notes. */
export function planningActivityForEvent(runId, event, previousState = null, order = 0) {
  const data = event?.data || {}, nodeId = clean(data.workerId || event?.nodeId, 120), at = time(event?.at);
  if (data.type === 'item' && data.stage === 'started' && data.item?.type === 'agentMessage' && data.item.phase === 'final_answer' && clean(data.item.id, 120) && at) {
    const reviewed = reviewRows(runId, previousState).some(review => review.nodeId === nodeId && ['respond', 'blocked'].includes(review.decision) && review.at && Date.parse(review.at) < Date.parse(at));
    if (reviewed) return [{ id: `composition:${runId}:${nodeId}:${clean(data.item.id, 120)}`, phase: 'think', source: 'composition', at, order, nodeId,
      title: 'Compose response', text: 'Preparing the response from the reviewed findings.' }];
    return [];
  }
  if (data.type === 'planning.reassessment') {
    if (!['continuing', 'stalled', 'required', 'stale'].includes(data.reviewStatus)) return [];
    return [{ id: `return:${runId}:${nodeId}:${Number(data.returnCount) || 0}:${data.reviewStatus}`, phase: 'plan', source: 'runtime-reassessment', at, order, nodeId,
      title: data.reviewStatus === 'stalled' ? 'Planning return stalled' : 'Return to planning',
      text: clean(data.reviewReason) || 'Reassess the saved findings before the final response.', status: data.reviewStatus }];
  }
  if (data.type !== 'task.state' || !data.state || typeof data.state !== 'object') return [];
  const state = data.state, rows = [], steps = stepList(state), prior = new Map(stepList(previousState).map(step => [step.id, step]));
  const actorNodeId = state.provenance?.runId === runId ? clean(state.provenance.nodeId, 120) || nodeId : nodeId;
  const currentAuthorship = state.plan?.authoredBy?.runId ? state.plan.authoredBy.runId === runId : state.provenance?.runId === runId;
  const newlyAuthored = state.plan?.authoredBy?.runId === runId && previousState?.plan?.authoredBy?.runId !== runId;
  if (steps.length && currentAuthorship && (newlyAuthored || structure(state) !== structure(previousState))) {
    const outline = taskPlanView(state).nodes.slice(0, 8).map(step => `${step.number} ${step.title}`).join(' · ');
    rows.push({ id: `plan:${runId}:${state.revision}`, phase: 'plan', source: 'plan', at: at || time(state.updatedAt), order, nodeId: actorNodeId,
      revision: state.revision, title: stepList(previousState).length ? 'Plan revised' : 'Plan saved', text: clean(outline) });
  }
  for (const step of steps) {
    if ((step.kind || 'action') !== 'action') continue;
    const before = prior.get(step.id), finding = step.status === 'blocked' ? clean(step.blockedReason) : clean(step.evidence);
    if (!finding || !before || !['done', 'blocked'].includes(step.status)) continue;
    const earlier = before.status === 'blocked' ? clean(before.blockedReason) : clean(before.evidence);
    if (finding === earlier && step.status === before.status && (step.attempt || 1) === (before.attempt || 1)) continue;
    rows.push({ id: `finding:${runId}:${state.revision}:${step.id}:${step.attempt || 1}`, phase: 'think', source: 'observation', at: at || time(state.updatedAt), order: order + 0.1, nodeId: actorNodeId,
      stepId: clean(step.id, 120), title: clean(step.title, 300) || 'Recorded finding', text: finding, status: step.status });
  }
  rows.push(...reviewRows(runId, state, order + 0.2));
  return rows;
}

export function mergePlanningActivity(previous = [], additions = []) {
  const rows = new Map();
  for (const value of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(additions) ? additions : [])]) {
    const row = publicActivity(value);
    if (!row) continue;
    // A later full-state snapshot repeats earlier reviews. Preserve the event
    // order captured when each review first appeared.
    if (!rows.has(row.id)) rows.set(row.id, row);
  }
  const bounded = [...rows.values()].sort(compareChronology).slice(-CHAT_PLANNING_ACTIVITY_LIMIT);
  let chars = bounded.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 2);
  while (chars > CHAT_PLANNING_ACTIVITY_CHAR_LIMIT && bounded.length) chars -= JSON.stringify(bounded.shift()).length + 1;
  return bounded;
}

// Saved conversation activity is an allowlisted public projection, never a
// serialized task snapshot or an arbitrary provider/tool payload.
function publicActivity(value) {
  if (!value || typeof value !== 'object') return null;
  const phase = ({ plan: 'plan', review: 'plan', observation: 'think', composition: 'think', 'runtime-reassessment': 'plan' })[value.source];
  const id = clean(value.id, 500);
  if (!phase || value.phase !== phase || !id) return null;
  return { id, phase, source: value.source, at: time(value.at),
    ...(Number.isFinite(value.order) ? { order: value.order } : {}), nodeId: clean(value.nodeId, 120),
    title: clean(value.title, 300), text: clean(value.text),
    ...(Number.isSafeInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}),
    ...(clean(value.stepId, 120) ? { stepId: clean(value.stepId, 120) } : {}),
    ...(['continue', 'respond', 'blocked'].includes(value.decision) ? { decision: value.decision } : {}),
    ...(value.decision === 'continue' && clean(value.nextStepId, 120) ? { nextStepId: clean(value.nextStepId, 120) } : {}),
    ...(['done', 'blocked', 'continuing', 'stalled', 'required', 'stale'].includes(value.status) ? { status: value.status } : {}) };
}

export function projectPlanningActivity(run, { previousState = null } = {}) {
  const saved = (Array.isArray(run?.planningActivity) ? run.planningActivity : []).filter(row =>
    typeof row?.id === 'string' && ['plan', 'finding', 'review', 'return', 'composition'].some(prefix => row.id.startsWith(`${prefix}:${run?.id}:`)));
  let rows = mergePlanningActivity([], saved);
  const recordedRevision = rows.length && Number.isSafeInteger(run?.planningActivityRevision) ? run.planningActivityRevision : 0;
  for (const [order, event] of (Array.isArray(run?.events) ? run.events : []).entries()) {
    if (event?.data?.type === 'task.state' && Number(event.data.state?.revision) <= Math.max(recordedRevision, Number(previousState?.revision) || 0)) continue;
    const additions = planningActivityForEvent(run.id, event, previousState || (event?.data?.type === 'item' ? run.taskState : null), Number.isFinite(event?.timelineOrder) ? event.timelineOrder : order);
    if (additions.length) rows = mergePlanningActivity(rows, additions);
    if (event?.data?.type === 'task.state' && event.data.state) previousState = event.data.state;
  }
  // A rolling event window may omit the review call, while its own dated saved
  // receipt remains available. Do not invent timestamps for other missing work.
  return mergePlanningActivity(rows, reviewRows(run?.id, run?.taskState, (run?.events?.length || 0) + 0.2));
}

function compareChronology(left, right) {
  const a = Date.parse(left.at || ''), b = Date.parse(right.at || '');
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
  return (Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER) - (Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER);
}

/** Preserve the actual Plan/Think/Plan/Think/Respond sequence. Adjacent entries
 * share one heading; a later return creates a new phase section. */
export function chatTimeline(run, messages = []) {
  const activity = projectPlanningActivity(run);
  const entries = [...activity, ...messages.map((message, index) => {
    const final = ['final_answer', 'unverified_answer', 'outcome'].includes(message.phase);
    const phase = message.role === 'user' ? 'direction' : !final && (message.provisional || ['commentary', 'working', 'progress'].includes(message.phase)) ? 'think' : 'respond';
    return { id: `message:${message.id || index}`, source: 'message', phase, at: time(message.at), order: message.order ?? (Number.MAX_SAFE_INTEGER - messages.length + index), message };
  })].sort(compareChronology);
  const groups = [];
  for (const entry of entries) {
    let group = groups.at(-1);
    if (!group || group.phase !== entry.phase || entry.phase === 'direction') {
      group = { id: entry.id, phase: entry.phase, entries: [] }; groups.push(group);
    }
    group.entries.push(entry);
  }
  const current = groups.findLast(group => group.phase !== 'direction');
  if (current && (['queued', 'running', 'waiting'].includes(run?.status) || run?.settled === false)) current.active = true;
  return groups;
}


export function chatProgressPreview(value, fallback = 'Working…') {
  const line = String(value || '').replace(/^[\s#*>`-]+/, '').split(/\r?\n/).find(value => value.trim()) || '';
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return fallback;
  return compact.length > 140 ? compact.slice(0, 137).replace(/\s+\S*$/, '') + '…' : compact;
}

/** A group's saved child progress does not certify its broad title's outcome. */
export function chatOutlineStatusLabel(item) {
  const status = item.statusLabel || item.status || 'Pending';
  if (!item.isGroup) return status;
  const done = Number.isSafeInteger(item.doneCount) ? item.doneCount : 0;
  const total = Number.isSafeInteger(item.leafCount) ? item.leafCount : 0;
  const skipped = Number.isSafeInteger(item.skippedCount) ? item.skippedCount : 0;
  const terminal = ['done', 'skipped'].includes(item.status);
  const progress = total ? done + '/' + total + ' steps' : skipped ? skipped + ' skipped' : terminal ? 'No steps' : '';
  return [terminal ? '' : status, progress, total && skipped ? skipped + ' skipped' : ''].filter(Boolean).join(' · ');
}

/** Short public status for an inline chat update. The full saved
 * activity remains available in chronological order inside the disclosure. */
export function chatWorkSummary(phases) {
  const entries = phases.flatMap(phase => phase.entries);
  const latest = entries.findLast(entry => !['composition','runtime-reassessment','review'].includes(entry.source)) || entries.at(-1);
  const active = phases.some(phase => phase.active);
  const title = 'Details';
  const raw = String(latest?.message?.text || (latest?.source === 'observation' ? latest.text : latest?.title) || latest?.text || 'Saved progress');
  const preview = chatProgressPreview(raw, 'Saved progress');
  return { title, preview, count: entries.length, active };
}

/** Provisional worker replies belong to the work record. A final result or a
 * user direction always breaks the record so its real chronology is retained. */
export function chatDisplayPhases(run, messages) {
  return chatTimeline(run, messages).flatMap(phase => {
    if (phase.phase !== 'respond') return [phase];
    const groups = [];
    for (const entry of phase.entries) {
      const provisional = Boolean(entry.message?.provisional || entry.message?.phase === 'unverified_answer');
      let group = groups.at(-1);
      if (!group || group.provisional !== provisional) {
        group = { ...phase, id: entry.id, entries: [], provisional, active: false };
        groups.push(group);
      }
      group.entries.push(entry);
    }
    if (phase.active && groups.length) groups.at(-1).active = true;
    return groups;
  });
}
