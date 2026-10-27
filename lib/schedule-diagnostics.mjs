// Durable, bounded occurrence accounting and live scheduler-health projection.
// The run/inbox ledger remains authoritative for actual execution and completion.
export const OCCURRENCE_HISTORY_LIMIT = 24;
export function appendOccurrence(deployment, {kind, scheduledAt, observedAt, reason, throughAt, jobId}) {
  if (!['admitted','skipped','refused'].includes(kind) || !Number.isFinite(scheduledAt) || !Number.isFinite(observedAt)) {
    throw Error('An occurrence receipt needs a valid action and clock.');
  }
  const receipt = {
    kind, scheduledAt, observedAt,
    ...(typeof reason === 'string' ? {reason} : {}),
    ...(Number.isFinite(throughAt) ? {throughAt} : {}),
    ...(typeof jobId === 'string' ? {jobId} : {}),
  };
  deployment.occurrenceHistory = [...(Array.isArray(deployment.occurrenceHistory) ? deployment.occurrenceHistory : []).slice(1 - OCCURRENCE_HISTORY_LIMIT), receipt];
  return receipt;
}
export function scheduleOverdue(deployment, now) {
  return deployment.enabled === true && !deployment.removed && ['cron','interval'].includes(deployment.trigger?.type)
    && Number.isFinite(deployment.nextAt) && deployment.nextAt <= now;
}
export function schedulerPulse({now, pollMs, lastAttemptAt = null, lastSuccessAt = null, lastError = null,
  paused = false, blockedReason = null, stopped = false, activeSchedules = 0, overdueSchedules = 0}) {
  const ageMs = Number.isFinite(lastSuccessAt) ? Math.max(0, now - lastSuccessAt) : null;
  const staleAfterMs = Math.max(15000, pollMs * 5);
  const state = stopped ? 'stopped'
    : paused ? 'paused'
    : blockedReason ? 'blocked'
    : lastError ? 'error'
    : activeSchedules === 0 ? 'idle'
    : ageMs === null ? 'starting'
    : ageMs > staleAfterMs ? 'stale' : 'running';
  return {
    state, lastAttemptAt: Number.isFinite(lastAttemptAt) ? new Date(lastAttemptAt).toISOString() : null,
    lastSuccessAt: Number.isFinite(lastSuccessAt) ? new Date(lastSuccessAt).toISOString() : null,
    lastError, activeSchedules, overdueSchedules, staleAfterMs,
  };
}
