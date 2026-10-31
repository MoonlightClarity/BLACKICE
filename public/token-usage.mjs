/** Token counts retain whether providers actually reported them.
 * samples counts returned model responses, not estimated tokens or HTTP attempts.
 */
export const TOKEN_USAGE_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens']);

export function reportedTokenCount(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

export function tokenUsageAvailability(usage, field = 'totalTokens') {
  const status = usage?.availability?.[field];
  if (status === 'unavailable' || reportedTokenCount(usage?.[field]) === null) return 'unavailable';
  return status === 'partial' ? 'partial' : 'reported';
}

function samplesOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const samples = reportedTokenCount(usage.samples);
  if (samples !== null) return Math.floor(samples);
  // Legacy/native usage objects have no availability metadata.
  return TOKEN_USAGE_FIELDS.some(field => reportedTokenCount(usage[field]) !== null) ? 1 : 0;
}

export function emptyTokenUsage() {
  return {
    ...Object.fromEntries(TOKEN_USAGE_FIELDS.map(field => [field, null])),
    samples: 0,
    availability: Object.fromEntries(TOKEN_USAGE_FIELDS.map(field => [field, 'unavailable'])),
  };
}

export function tokenUsageMeasurement(counts = {}) {
  const result = emptyTokenUsage();
  result.samples = 1;
  for (const field of TOKEN_USAGE_FIELDS) {
    result[field] = reportedTokenCount(counts?.[field]);
    result.availability[field] = result[field] === null ? 'unavailable' : 'reported';
  }
  return result;
}

export function aggregateTokenUsage(values = []) {
  const records = Array.from(values).filter(value => samplesOf(value) > 0);
  const result = emptyTokenUsage();
  result.samples = records.reduce((sum, value) => sum + samplesOf(value), 0);
  for (const field of TOKEN_USAGE_FIELDS) {
    let sum = 0, reported = false, missing = false;
    for (const value of records) {
      const status = tokenUsageAvailability(value, field);
      if (status === 'unavailable') { missing = true; continue; }
      sum += reportedTokenCount(value[field]);
      reported = true;
      if (status === 'partial') missing = true;
    }
    result[field] = reported ? sum : null;
    result.availability[field] = reported ? (missing ? 'partial' : 'reported') : 'unavailable';
  }
  return result;
}

export function tokenUsagePresentation(usage) {
  const usageStatus = tokenUsageAvailability(usage);
  const totalTokens = usageStatus === 'unavailable' ? null : reportedTokenCount(usage.totalTokens);
  const hasUsage = totalTokens !== null;
  if (!samplesOf(usage)) return { totalTokens, hasUsage, usageStatus, usageLabel: null, usageTitle: '' };
  if (!hasUsage) return {
    totalTokens, hasUsage, usageStatus,
    usageLabel: 'Token usage unavailable',
    usageTitle: 'The provider did not report total token usage for this response.',
  };
  const count = totalTokens.toLocaleString();
  return {
    totalTokens, hasUsage, usageStatus,
    usageLabel: usageStatus === 'partial' ? 'At least ' + count + ' tokens' : count + ' tokens',
    usageTitle: usageStatus === 'partial'
      ? 'At least ' + count + ' tokens were reported; some model calls did not report total usage.'
      : count + ' total tokens across this response’s model calls',
  };
}
