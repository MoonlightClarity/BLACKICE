// A local result inbox for scheduled jobs. This is not a push delivery channel.
// An agent's terminal status, publication to the local inbox, and a human's
// acknowledgement are three distinct facts, persisted with the operation receipt.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const RESULT_PREVIEW_CHARS = 2400;
export function validLocalResultReceipt(value, expectedJobId) {
  if(!value || typeof value!=='object' || Array.isArray(value) || value.destination!=='local-inbox'
    || !['pending','available','acknowledged'].includes(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision<1
    || value.jobId!==expectedJobId || typeof value.createdAt!=='string' || !Number.isFinite(Date.parse(value.createdAt)))return false;
  const timestamp=value=>value===null || typeof value==='string' && Number.isFinite(Date.parse(value));
  const nullableText=(value,max)=>value===null || typeof value==='string' && value.length<=max;
  if(!timestamp(value.availableAt) || !timestamp(value.acknowledgedAt)
    || !nullableText(value.sourceRunId,120) || !nullableText(value.error,1000) || !nullableText(value.preview,RESULT_PREVIEW_CHARS)
    || typeof value.previewTruncated!=='boolean'
    || value.previewCharacters!==null && (!Number.isSafeInteger(value.previewCharacters)||value.previewCharacters<0))return false;
  if(value.state==='pending')return value.availableAt===null && value.acknowledgedAt===null && value.outcome===null;
  if(!TERMINAL.has(value.outcome) || value.availableAt===null)return false;
  return value.state==='acknowledged' ? value.acknowledgedAt!==null : value.acknowledgedAt===null;
}
const iso = timestamp => new Date(timestamp).toISOString();
const errorText = error => error == null ? null : String(error?.message || error).slice(0, 1000);

export function newPendingResult(jobId, at) {
  return {
    destination: 'local-inbox',
    state: 'pending',
    revision: 1,
    jobId,
    createdAt: iso(at),
    availableAt: null,
    acknowledgedAt: null,
    sourceRunId: null,
    outcome: null,
    error: null,
    preview: null,
    previewTruncated: false,
    previewCharacters: null,
  };
}

export function publishLocalResult(job, run, at) {
  const delivery = job?.delivery;
  if (!delivery || delivery.state !== 'pending' || delivery.destination !== 'local-inbox' || !TERMINAL.has(job.status)) return false;
  const attempt = [...(job.attempts || [])].reverse().find(item => typeof item.runId === 'string' && item.runId);
  const sourceRunId = attempt?.runId || null;
  // A run's output is safe to associate only when the saved operation-inbox
  // binding and engine metadata agree. Missing output is shown as unavailable.
  const verified = Boolean(sourceRunId && run?.id === sourceRunId && attempt?.inboxId
    && run.metadata?.inboxId === attempt.inboxId);
  const output = verified && typeof run.output === 'string' ? run.output : null;
  const excerpt = output === null ? null : output.slice(0, RESULT_PREVIEW_CHARS);
  job.delivery = {
    ...delivery,
    state: 'available',
    revision: delivery.revision + 1,
    availableAt: iso(at),
    sourceRunId,
    outcome: job.status,
    error: errorText(job.error),
    preview: excerpt,
    previewTruncated: output !== null && output.length > RESULT_PREVIEW_CHARS,
    previewCharacters: output === null ? null : output.length,
  };
  return true;
}

export function acknowledgeLocalResult(job, expectedRevision, at) {
  const delivery = job?.delivery;
  if (!delivery || delivery.destination !== 'local-inbox') throw Object.assign(Error('No local result receipt exists for this job.'), { status: 404 });
  if (delivery.state === 'acknowledged') return false; // Idempotent repeat. Never change the result.
  if (delivery.state !== 'available') throw Object.assign(Error('This job has no reviewable result yet.'), { status: 409 });
  if (!Number.isSafeInteger(expectedRevision) || delivery.revision !== expectedRevision)
    throw Object.assign(Error('The result receipt changed. Refresh and review its current state.'), { status: 409 });
  delivery.state = 'acknowledged';
  delivery.revision++;
  delivery.acknowledgedAt = iso(at);
  return true;
}

export function resultInbox(jobs, { limit = 100, includeAcknowledged = false } = {}) {
  const relevant = (jobs || []).filter(job =>
    job.delivery?.destination === 'local-inbox' && (job.delivery.state === 'available' || includeAcknowledged && job.delivery.state === 'acknowledged'));
  const unread = relevant.filter(job => job.delivery.state === 'available');
  const read = relevant.filter(job => job.delivery.state === 'acknowledged');
  return {
    total: relevant.length,
    available: unread.length,
    acknowledged: read.length,
    // Prioritize unread receipts, retaining newest-first order inside each group.
    items: [...unread,...read].slice(0, limit).map(job => ({
      id: job.id,
      deploymentId: job.deploymentId,
      deploymentName: job.deploymentName,
      status: job.status,
      source: job.source,
      createdAt: job.createdAt,
      delivery: structuredClone(job.delivery),
    })),
  };
}
