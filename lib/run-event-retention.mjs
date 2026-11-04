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
const RESULT_TEXT_CHARS = 4096;
const RESULT_TEXT_BYTES = RUN_EVENT_LIMITS.maxAuxiliaryEventBytes / 2;
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const range = (value, start, end) => {
  // Offsets are UTF-16 code units, as in String.slice. Do not split a pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start] || '') && /[\uD800-\uDBFF]/.test(value[start - 1])) start++;
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end] || '') && /[\uD800-\uDBFF]/.test(value[end - 1] || '')) end--;
  return { start, end, text: value.slice(start, end) };
};
function captureResultText(value) {
  const length = value.length, sha256 = digest(value);
  const render = count => {
    const head = Math.ceil(count / 2), tail = Math.floor(count / 4), middle = count - head - tail;
    const ranges = count >= length ? [range(value, 0, length)] : [
      range(value, 0, head), range(value, Math.floor((length - middle) / 2), Math.floor((length - middle) / 2) + middle), range(value, length - tail, length)
    ].filter(item => item.end > item.start);
    const retainedChars = ranges.reduce((sum, item) => sum + item.text.length, 0);
    return { version: 1, length, sha256, retainedChars, omittedChars: length - retainedChars, truncated: retainedChars < length, ranges };
  };
  let low = 0, high = Math.min(length, RESULT_TEXT_CHARS);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(render(mid)) <= RESULT_TEXT_BYTES) low = mid; else high = mid - 1; }
  return render(low);
}

/** Read only captured text. A hash identifies omitted bytes; it never supplies them. */
export function retainedToolResult(item) {
  const saved = item?.retainedResult;
  if (object(saved) && saved.version === 1 && (saved.length === null || Number.isSafeInteger(saved.length) && saved.length >= 0)
    && (saved.sha256 === null || hashString(saved.sha256)) && typeof saved.truncated === 'boolean'
    && Array.isArray(saved.ranges) && saved.ranges.length <= 3) {
    const ranges = []; let end = 0, retainedChars = 0;
    for (const part of saved.ranges) {
      if (!object(part) || !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start < end || part.end < part.start
        || saved.length !== null && part.end > saved.length || typeof part.text !== 'string' || part.text.length !== part.end - part.start) return null;
      ranges.push({ start: part.start, end: part.end, text: part.text }); end = part.end; retainedChars += part.text.length;
    }
    const omittedChars = saved.length === null ? null : saved.length - retainedChars;
    const normalized = { version: 1, length: saved.length, sha256: saved.sha256, retainedChars, omittedChars, truncated: saved.length === null || omittedChars > 0, ranges };
    if (retainedChars !== saved.retainedChars || omittedChars !== saved.omittedChars || normalized.truncated !== saved.truncated
      || retainedChars > RESULT_TEXT_CHARS || bytes(normalized) > RESULT_TEXT_BYTES) return null;
    if (!normalized.truncated && (ranges.length !== 1 || ranges[0].start !== 0 || !hashString(saved.sha256) || digest(ranges[0].text) !== saved.sha256)) return null;
    return normalized;
  }
  if (saved !== undefined) return null;
  // Older run records retain only a prefix. Preserve that limitation, including
  // an unknown original length if a digest exists without an omission count.
  if (typeof item?.resultExcerpt !== 'string' || !item.resultExcerpt || item.resultExcerpt.length > 300) return null;
  const excerpt = item.resultExcerpt, hasHash = hashString(item.fullResultSha256);
  const omitted = Number.isSafeInteger(item.omittedChars) && item.omittedChars >= 0 ? item.omittedChars : hasHash ? null : 0;
  if (omitted === 0 && hasHash && digest(excerpt) !== item.fullResultSha256) return null;
  return { version: 1, length: omitted === null ? null : excerpt.length + omitted, sha256: hasHash ? item.fullResultSha256 : omitted === 0 ? digest(excerpt) : null,
    retainedChars: excerpt.length, omittedChars: omitted, truncated: omitted !== 0, ranges: [{ start: 0, end: excerpt.length, text: excerpt }] };
}
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
    const item = data.item; let args = item.arguments;
    if (typeof args === 'string') try { args = JSON.parse(args); } catch { args = null; }
    let action = text(item.action, 100), target = text(item.target, 170);
    if (object(args)) { action = text(args.action, 100); target = text(args.tabId || args.path || args.stepId, 170); }
    const originalText = Array.isArray(item.contentItems)
      ? item.contentItems.filter(x => typeof x?.text === 'string').map(x => x.text).join('\n') : '';
    const retainedResult = originalText ? captureResultText(originalText) : retainedToolResult(item);
    const excerpt = originalText ? text(originalText, 300) : text(item.resultExcerpt, 300);
    const unavailableResult = !originalText && !retainedResult && (item.retainedResult !== undefined || Boolean(excerpt));
    return { ...event, data: {
      type: 'item', stage: data.stage,
      item: {
        type: 'dynamicToolCall', id: item.id,
        tool: item.tool || item.name, action, target, status: item.status,
        success: item.success, ...(item.code ? { code: item.code } : {}),
        ...(excerpt ? { resultExcerpt: excerpt } : {}),
        ...(retainedResult ? { retainedResult } : unavailableResult ? { retainedResult: { version: 1, unavailable: 'invalid_record' } } : {}),
        ...(retainedResult?.length > 300 ? { fullResultSha256: retainedResult.sha256, omittedChars: retainedResult.length - (excerpt?.length || 0) }
          : retainedResult?.truncated && retainedResult.sha256 ? { fullResultSha256: retainedResult.sha256 }
            : unavailableResult ? { ...(hashString(item.fullResultSha256) ? { fullResultSha256: item.fullResultSha256 } : {}), ...(Number.isSafeInteger(item.omittedChars) && item.omittedChars >= 0 ? { omittedChars: item.omittedChars } : {}) } : {})
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
