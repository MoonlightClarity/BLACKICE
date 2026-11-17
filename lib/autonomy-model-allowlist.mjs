/**
 * One runtime enforcement boundary for autonomous model selection.
 *
 * A calibration allowlist controls which exact model IDs the agent may run.
 * Capability matching, task suitability, and provider quotas are judgment
 * described by the autonomy tool, not a hardcoded provider/model matrix.
 */
const fail = (message, code = 'AUTONOMY_MODEL_NOT_ALLOWED') =>
  Object.assign(new Error(message), {code, status: 403});

const exactModelId = value =>
  typeof value === 'string' && value.length >= 1 && value.length <= 400 &&
  value === value.trim() && !/[\u0000-\u001f\u007f\s]/u.test(value) &&
  value !== '*' && value !== 'default';

export function normalizeAutonomyModelAllowlist(values, {catalog} = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64)
    throw fail('Select between 1 and 64 explicit model IDs for autonomous operation.', 'AUTONOMY_ALLOWLIST_INVALID');
  const available = catalog === undefined ? null : new Set(
    (Array.isArray(catalog) ? catalog : []).flatMap(item =>
      [item?.id, item?.model].filter(exactModelId)
    )
  );
  const unique = new Set();
  for (const id of values) {
    if (!exactModelId(id))
      throw fail('Autonomous model entries must be exact, non-wildcard model IDs.', 'AUTONOMY_ALLOWLIST_INVALID');
    if (available && !available.has(id))
      throw fail('A selected model is not in the current provider catalog: ' + id, 'AUTONOMY_MODEL_UNAVAILABLE');
    unique.add(id);
  }
  return Object.freeze([...unique]);
}

/**
 * Call immediately before every autonomous coordinator/worker model dispatch.
 * Dynamic defaults are resolved first; they can never expand the allowlist.
 */
export function requireAutonomyModel({allowlist, requestedModel, inheritedModel, defaultModel, catalog}) {
  const ids = normalizeAutonomyModelAllowlist(allowlist);
  const selected = requestedModel === undefined || requestedModel === 'default'
    ? inheritedModel === undefined || inheritedModel === 'default' ? defaultModel : inheritedModel
    : requestedModel;
  if (!exactModelId(selected) || !ids.includes(selected))
    throw fail('Autonomous model dispatch was rejected: selected model is not whitelisted.');
  if (catalog !== undefined) {
    const available = new Set((Array.isArray(catalog) ? catalog : []).flatMap(item =>
      [item?.id, item?.model].filter(exactModelId)));
    if (!available.has(selected))
      throw fail('A whitelisted model is currently unavailable: ' + selected, 'AUTONOMY_MODEL_UNAVAILABLE');
  }
  return selected;
}
