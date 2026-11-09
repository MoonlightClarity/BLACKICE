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
const BROWSER_REVIEW_BYTES = 8 * 1024;
const browserReviewActions = new Set(['open', 'navigate', 'read', 'snapshot', 'wait']);
const durable = event => {
  const data = event?.data;
  return ['message', 'steer'].includes(data?.type)
    || data?.type === 'item' && data.item?.type === 'agentMessage';
};

function browserDocumentUrl(value) {
  if (typeof value !== 'string' || value.length > 8000) return;
  try {
    const url = new URL(value);
    const resource = url.origin + url.pathname;
    if (['https:', 'http:'].includes(url.protocol) && resource.length <= 2000) return resource;
  } catch {}
}

function exactTextPrefix(value, budget) {
  let low = 0, high = Math.min(value.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) - 2 <= budget) low = middle;
    else high = middle - 1;
  }
  if (low < value.length && /[\uD800-\uDBFF]/.test(value[low - 1] || '')) low--;
  return value.slice(0, low);
}

function captureBrowserReview(item, action, args) {
  if (['open', 'navigate'].includes(action) && !browserDocumentUrl(args?.url)) return;
  const raw = item.contentItems?.find(part => part?.type === 'inputText')?.text;
  if (typeof raw !== 'string' || raw.length > 1024 * 1024) return;
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { return; }
  const url = browserDocumentUrl(snapshot?.url);
  if (!url || snapshot.protectedContent || snapshot.success === false || snapshot.error || snapshot.navigationError || !Array.isArray(snapshot.frames)) return;
  const observation = { url, title: text(snapshot.title, 256), documentId: text(snapshot.documentId, 120), frames: [] };
  let remaining = BROWSER_REVIEW_BYTES - bytes(observation);
  for (const [index, frame] of snapshot.frames.slice(0, 30).entries()) {
    if (typeof frame?.text !== 'string' || !frame.text.trim()) continue;
    const part = { index, length: frame.text.length, sourceTruncated: frame.truncated === true, text: '' };
    part.text = exactTextPrefix(frame.text, remaining - bytes(part) - 1);
    if (!part.text) break;
    observation.frames.push(part);
    remaining -= bytes(part) + 1;
  }
  if (observation.frames.length) return observation;
}

/**
 * Live subscribers receive the full observation; the persisted run keeps only
 * its dated, bounded index. Full task states already belong to TaskStateStore
 * and are saved once as run.taskState, not copied on every event. An adopted
 * response cycle keeps a narrow browser text witness for settled review.
 */
export function compactRunEvent(event, { reviewBrowserObservations = false } = {}) {
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
    const item = data.item, tool = item.tool || item.name;
    let args = item.arguments;
    if (typeof args === 'string' && args.length <= RUN_EVENT_LIMITS.maxAuxiliaryEventBytes) try { args = JSON.parse(args); } catch {}
    const action = text(object(args) ? args.action : item.action, 100);
    const target = text(object(args) ? args.tabId || args.path || args.stepId : item.target, 170);
    const hasContent = Array.isArray(item.contentItems);
    const originalText = hasContent ? item.contentItems.filter(x => typeof x?.text === 'string').map(x => x.text).join('\n') : '';
    const excerpt = text(hasContent ? originalText : item.resultExcerpt, 300);
    const omittedChars = hasContent ? originalText.length - 300 : item.omittedChars;
    const browserObservation = tool === 'relay_browser' && browserReviewActions.has(action) && item.success === true
      && (data.stage === 'completed' || item.status === 'completed');
    let reviewObservation;
    if (browserObservation && reviewBrowserObservations && hasContent) reviewObservation = captureBrowserReview(item, action, args);
    else if (browserObservation && !hasContent && item.arguments === undefined && object(item.reviewObservation)
      && bytes(item.reviewObservation) <= BROWSER_REVIEW_BYTES) reviewObservation = item.reviewObservation;
    return { ...event, data: {
      type: 'item', stage: data.stage,
      item: {
        type: 'dynamicToolCall', id: item.id,
        tool, action, target, status: item.status,
        success: item.success, ...(item.code ? { code: item.code } : {}),
        ...(excerpt ? { resultExcerpt: excerpt } : {}),
        ...(omittedChars > 0 ? { fullResultSha256: hasContent ? digest(originalText) : item.fullResultSha256, omittedChars } : {}),
        ...(reviewObservation ? { reviewObservation } : {})
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
  const next = compactRunEvent(event, { reviewBrowserObservations: run.planningMode !== 'off' && Boolean(run.responseCycle?.planRef) });
  run.events ||= [];
  run.events.push(next);
  const existing = run.eventRetention;
  run.eventRetention ||= { compacted: true, bytes: 0, omittedEvents: 0, omittedBytes: 0 };
  run.eventRetention.bytes = (Number.isSafeInteger(existing?.bytes) ? existing.bytes : bytes(run.events.slice(0, -1))) + bytes(next);
  if (run.events.length > RUN_EVENT_LIMITS.maxEvents || run.eventRetention.bytes > RUN_EVENT_LIMITS.perRunBytes)
    compactRunHistory(run);
}
