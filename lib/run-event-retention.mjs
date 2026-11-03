import { createHash } from 'node:crypto';

export const RUN_EVENT_LIMITS = Object.freeze({
  maxEvents: 2500,
  perRunBytes: 4 * 1024 * 1024,
  maxAuxiliaryEventBytes: 24 * 1024
});
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : undefined;
const digest = value => createHash('sha256').update(value).digest('hex');
const durable = event => {
  const data = event?.data;
  return ['message', 'steer'].includes(data?.type)
    || data?.type === 'item' && data.item?.type === 'agentMessage';
};

/**
 * Live subscribers receive the full observation; the persisted run keeps only
 * its dated, bounded index. Full task states already belong to TaskStateStore
 * and are saved once as run.taskState, not copied on every event.
 */
export function compactRunEvent(event) {
  if (!object(event) || !object(event.data)) return event;
  const data = event.data;
  if (data.type === 'task.state') {
    const state = data.state || {};
    const reviews = Array.isArray(state.planningReviews) ? state.planningReviews.slice(-6)
      .map(r => ({ runId: text(r.runId), nodeId: text(r.nodeId), decision: text(r.decision), at: text(r.at) })) : undefined;
    return { ...event, data: {
      type: data.type, taskId: data.taskId || state.taskId,
      ...(data.source ? { source: data.source } : {}),
      ...(data.actor ? { actor: data.actor } : {}),
      state: {
        taskId: state.taskId, revision: state.revision,
        ...(object(state.plan) ? { plan: { origin: state.plan.origin, authoredBy: state.plan.authoredBy } } : {}),
        ...(reviews ? { planningReviews: reviews } : {})
      },
      fullState: 'saved task state / run.taskState'
    } };
  }
  if (data.type === 'task.execution') {
    const payload = data.observations || data.executionObservations || data;
    return { ...event, data: {
      type: data.type, taskId: data.taskId,
      ...(typeof payload?.total === 'number' ? { total: payload.total } : {}),
      ...(typeof payload?.updatedAt === 'string' ? { updatedAt: payload.updatedAt } : {}),
      fullReceipts: 'saved task execution journal'
    } };
  }
  if (data.type === 'item' && data.item?.type === 'dynamicToolCall') {
    const item = data.item, args = item.arguments;
    let action, target;
    if (object(args)) { action = text(args.action, 100); target = text(args.tabId || args.path || args.stepId, 170); }
    const originalText = Array.isArray(item.contentItems)
      ? item.contentItems.filter(x => typeof x?.text === 'string').map(x => x.text).join('\n') : '';
    const excerpt = text(originalText, 300);
    return { ...event, data: {
      type: 'item', stage: data.stage,
      item: {
        type: 'dynamicToolCall', id: item.id,
        tool: item.tool || item.name, action, target, status: item.status,
        success: item.success, ...(item.code ? { code: item.code } : {}),
        ...(excerpt ? { resultExcerpt: excerpt } : {}),
        ...(originalText.length > 300 ? { fullResultSha256: digest(originalText), omittedChars: originalText.length - 300 } : {})
      }
    } };
  }
  // Keep assistant/user messages intact; the conversation archive also retains
  // them independently. Truncate only oversized auxiliary trace events.
  if (durable(event) || bytes(event) <= RUN_EVENT_LIMITS.maxAuxiliaryEventBytes) return event;
  const raw = JSON.stringify(event);
  return { type: event.type, at: event.at, runId: event.runId, nodeId: event.nodeId,
    data: { type: data.type || 'auxiliary', note: 'Large auxiliary event stored outside the compact run timeline',
      sourceSha256: digest(raw), originalBytes: Buffer.byteLength(raw) } };
}

/** Drop only non-message timeline detail when the per-run byte budget is hit.
 * Original old events are retained in an immutable startup archive; the live
 * owner can still listen for every full event. */
export function compactRunHistory(run, { sourceArchive } = {}) {
  if (!run || !Array.isArray(run.events)) return run;
  const input = run.events;
  const projected = input.map(compactRunEvent);
  const lengths = projected.map(bytes);
  let total = lengths.reduce((a, b) => a + b, 0);
  let removeCount = 0, removeBytes = 0;
  const excluded = new Set();
  for (let i = 0; i < projected.length; i++) {
    if (projected.length - removeCount <= RUN_EVENT_LIMITS.maxEvents && total <= RUN_EVENT_LIMITS.perRunBytes) break;
    if (durable(projected[i])) continue;
    excluded.add(i); removeCount++; removeBytes += lengths[i]; total -= lengths[i];
  }
  // If an unusually long transcript contains more than 2500 durable events,
  // preserve them; the separate conversation archive remains authoritative.
  run.events = projected.filter((_, i) => !excluded.has(i));
  const previous = run.eventRetention || {};
  run.eventRetention = {
    compacted: true, bytes: total,
    omittedEvents: (previous.omittedEvents || 0) + removeCount,
    omittedBytes: (previous.omittedBytes || 0) + removeBytes,
    ...(sourceArchive ? { sourceArchive } : previous.sourceArchive ? { sourceArchive: previous.sourceArchive } : {})
  };
  return run;
}
export function retainRunEvent(run, event) {
  const next = compactRunEvent(event);
  run.events ||= [];
  run.events.push(next);
  const existing = run.eventRetention;
  run.eventRetention ||= { compacted: true, bytes: 0, omittedEvents: 0, omittedBytes: 0 };
  run.eventRetention.bytes = (Number.isSafeInteger(existing?.bytes) ? existing.bytes : bytes(run.events.slice(0, -1))) + bytes(next);
  if (run.events.length > RUN_EVENT_LIMITS.maxEvents || run.eventRetention.bytes > RUN_EVENT_LIMITS.perRunBytes)
    compactRunHistory(run);
}
