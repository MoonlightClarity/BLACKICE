// Keep rejected evidence intact: never silently truncate a work record.
export const PLANNING_EVIDENCE_LIMIT = 2000;

export function checkPlanningEvidenceLength(value) {
  if (typeof value !== 'string' || value.length <= PLANNING_EVIDENCE_LIMIT) return;
  const actualLength = value.length, maxLength = PLANNING_EVIDENCE_LIMIT;
  const message = `Planning evidence is ${actualLength} UTF-16 code units; the limit is ${maxLength} (${actualLength - maxLength} over). Shorten the evidence while retaining the material result and limits, then retry the update with the current revision. Do not repeat work already performed solely to correct this record.`;
  throw Object.assign(new Error(message), { code: 'TASK_PLAN_EVIDENCE_TOO_LONG', status: 400, actualLength, maxLength });
}
