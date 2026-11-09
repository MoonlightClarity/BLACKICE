import { createHash } from 'node:crypto';

// Only the host operation adapter calls this module. Model claims are judgments,
// never confirmation records. The journal owns ordering and provenance.
const KINDS = new Set(['observation', 'source-coverage', 'external-confirmation', 'validation']);
const INPUT_KEYS = new Set(['kind', 'resourceKey', 'sourceVersion', 'digest', 'coverage', 'confirmation', 'validation']);
const RECORD_KEYS = new Set([...INPUT_KEYS, 'id', 'operationId', 'workItemId', 'at']);
const MAX_EVIDENCE = 16384;
const HASH = /^[a-f0-9]{64}$/i;

function plain(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${name} has symbol fields`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TypeError(`${name}.${key} must be a data field`);
    if (allowed && !allowed.has(key)) throw new TypeError(`${name}.${key} is not supported`);
  }
  return value;
}

function string(value, name, limit = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a nonempty bounded string without control characters`);
  }
  return value;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function metadata(value, name, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 256 || depth > 6) throw new TypeError(`${name} exceeds metadata bounds`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 2048) return value;
  if (Array.isArray(value)) return value.map((child, i) => metadata(child, `${name}[${i}]`, depth + 1, budget));
  plain(value, name);
  const copy = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    string(key, `${name} field`, 128);
    copy[key] = metadata(child, `${name}.${key}`, depth + 1, budget);
  }
  return copy;
}

/** Bind one trusted adapter observation to its admitted host operation. */
export function normalizeContractEvidence(input, { operationId, workItemId, at } = {}) {
  plain(input, 'evidence', INPUT_KEYS);
  operationId = string(operationId, 'operationId', 512);
  workItemId = string(workItemId, 'workItemId', 256);
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new TypeError('at must be a UTC ISO timestamp');
  }
  const normalizedAt = new Date(at).toISOString();
  if (normalizedAt !== at.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(3, '0')}Z`)) {
    throw new TypeError('at must name a real UTC calendar instant');
  }
  at = normalizedAt;
  if (!KINDS.has(input.kind)) throw new TypeError('evidence.kind is not supported');
  const value = { kind: input.kind, resourceKey: string(input.resourceKey, 'resourceKey', 4096) };
  if (Object.hasOwn(input, 'sourceVersion')) value.sourceVersion = string(input.sourceVersion, 'sourceVersion', 1024);
  if (Object.hasOwn(input, 'digest')) {
    if (typeof input.digest !== 'string' || !HASH.test(input.digest)) throw new TypeError('digest must be SHA-256');
    value.digest = input.digest.toLowerCase();
  }
  if (Object.hasOwn(input, 'coverage')) {
    const range = plain(input.coverage, 'coverage', new Set(['unit', 'start', 'end', 'total']));
    if (!['bytes', 'lines', 'records'].includes(range.unit)) throw new TypeError('coverage.unit is not supported');
    if (![range.start, range.end, range.total].every(n => Number.isSafeInteger(n) && n >= 0) ||
        range.start > range.end || range.end > range.total) {
      throw new TypeError('coverage must be a zero-based half-open interval within total');
    }
    value.coverage = { unit: range.unit, start: range.start, end: range.end, total: range.total };
  }
  if (Object.hasOwn(input, 'confirmation')) {
    if (input.kind !== 'external-confirmation') throw new TypeError('confirmation requires external-confirmation kind');
    const confirmation = plain(input.confirmation, 'confirmation', new Set(['outcomeId', 'effectKey', 'status', 'prior']));
    if (!['confirmed', 'absent'].includes(confirmation.status)) throw new TypeError('confirmation.status is not supported');
    value.confirmation = {
      outcomeId: string(confirmation.outcomeId, 'confirmation.outcomeId', 2048),
      status: confirmation.status,
    };
    if (Object.hasOwn(confirmation, 'effectKey')) value.confirmation.effectKey = string(confirmation.effectKey, 'confirmation.effectKey', 2048);
    if (Object.hasOwn(confirmation, 'prior')) {
      if (typeof confirmation.prior !== 'boolean') throw new TypeError('confirmation.prior must be boolean');
      value.confirmation.prior = confirmation.prior;
    }
  } else if (input.kind === 'external-confirmation') {
    throw new TypeError('external-confirmation requires an adapter confirmation');
  }
  if (Object.hasOwn(input, 'validation')) {
    plain(input.validation, 'validation');
    value.validation = metadata(input.validation, 'validation');
    if (canonical(value.validation).length > 8192) throw new TypeError('validation exceeds metadata bounds');
  } else if (input.kind === 'validation') {
    throw new TypeError('validation kind requires adapter validation metadata');
  }
  const id = `ev_${sha(canonical({ operationId, workItemId, ...value }))}`;
  return freeze({ id, operationId, workItemId, at, ...value });
}

function records(evidence) {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) throw new TypeError('evidence journal exceeds bounds');
  const seen = new Set();
  const result = [];
  for (const record of evidence) {
    plain(record, 'evidence record', RECORD_KEYS);
    const input = Object.fromEntries(Object.entries(record).filter(([key]) => INPUT_KEYS.has(key)));
    const normalized = normalizeContractEvidence(input, record);
    if (record.id !== normalized.id) throw new TypeError('evidence identity or host binding does not match');
    // A replay cannot change the effective order of an earlier observation.
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    result.push(normalized);
  }
  return result;
}

const unique = values => [...new Set(values)];

function operationScopes(operations) {
  if (!Array.isArray(operations) || operations.length > 4096) throw new TypeError('operation journal exceeds bounds');
  const byId = new Map();
  for (const operation of operations) {
    plain(operation, 'operation');
    const id = string(operation.operationId, 'operation.operationId', 512);
    if (byId.has(id)) throw new TypeError('duplicate operation ID');
    byId.set(id, operation.deliveryState === 'returned' && operation.success !== false && Array.isArray(operation.evidenceIds) && Array.isArray(operation.resources)
      ? { workItemId: operation.workItemId, evidenceIds: new Set(operation.evidenceIds), resources: operation.resources } : null);
  }
  return record => {
    const operation = byId.get(record.operationId);
    if (!operation || operation.workItemId !== record.workItemId || !operation.evidenceIds.has(record.id)) return [];
    // Scope comes from the exact retained concrete resource. Another resource
    // or a scopeOnly marker in the same operation cannot lend its authority.
    const resources = operation.resources.filter(resource => resource?.key === record.resourceKey && resource.scopeOnly !== true);
    return resources.length === 1 && Array.isArray(resources[0].scopeKeys) ? resources[0].scopeKeys : [];
  };
}

const criterionWorkItems = (contract, id) => new Set(contract.workItems.filter(item => Array.isArray(item.criterionIds) && item.criterionIds.includes(id)).map(item => item.id));
const criterionEvidence = (criterion, workItems, scopes) => record =>
  (workItems.size === 0 || workItems.has(record.workItemId)) &&
  (!criterion.resourceKey || record.resourceKey === criterion.resourceKey ||
    ['observation', 'judgment'].includes(criterion.kind) && scopes(record).includes(criterion.resourceKey));

function judgmentEvidenceIssue(judgment, observedById, eligible, criterion) {
  const ids = judgment.evidenceIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 256) return 'A satisfied judgment needs from 1 to 256 saved evidence IDs.';
  for (const id of ids) {
    const record = typeof id === 'string' && observedById.get(id);
    if (!record) return 'A cited evidence ID is not present in the host journal.';
    if (record.workItemId !== judgment.workItemId) return `Evidence ${id} belongs to work item ${record.workItemId}; the assessment belongs to ${judgment.workItemId}.`;
    if (!eligible(record)) return `Evidence ${id} for ${record.resourceKey} does not match criterion ${criterion.id} resource ${criterion.resourceKey}; no retained host scope binding establishes that membership.`;
  }
  return null;
}

/** Check a positive assessment using the same host bindings as evaluation. */
export function checkContractJudgmentEvidence(contract, evidence, judgment, { operations = [] } = {}) {
  const criterion = contract.criteria.find(row => row.id === judgment.criterionId);
  const item = contract.workItems.find(row => row.id === judgment.workItemId);
  if (criterion?.kind !== 'judgment' || !item?.criterionIds.includes(criterion.id)) return { valid: false, reason: 'The judgment criterion is not assigned to this work item.' };
  const observedById = new Map(records(evidence).map(record => [record.id, record]));
  const eligible = criterionEvidence(criterion, criterionWorkItems(contract, criterion.id), operationScopes(operations));
  const issue = judgmentEvidenceIssue(judgment, observedById, eligible, criterion);
  return { valid: issue === null, reason: issue || 'Cited host evidence is relevant to this work item and criterion.' };
}

function outcomeGroups(evidence) {
  const confirmations = evidence.filter(record => record.kind === 'external-confirmation');
  const parents = new Map();
  const root = key => {
    if (!parents.has(key)) parents.set(key, key);
    let current = key;
    while (parents.get(current) !== current) current = parents.get(current);
    while (parents.get(key) !== key) {
      const next = parents.get(key);
      parents.set(key, current);
      key = next;
    }
    return current;
  };
  const aliases = record => [
    canonical(['outcome', record.resourceKey, record.confirmation.outcomeId]),
    ...(record.confirmation.effectKey ? [canonical(['effect', record.confirmation.effectKey])] : []),
  ];
  for (const record of confirmations) {
    const keys = aliases(record);
    const first = root(keys[0]);
    for (const key of keys.slice(1)) parents.set(root(key), first);
  }
  const groups = new Map();
  for (const record of confirmations) {
    const key = root(aliases(record)[0]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map(group => {
    const latest = group.at(-1);
    const prior = group.some(record => record.confirmation.prior === true);
    const effectKeys = unique(group.map(record => record.confirmation.effectKey).filter(Boolean)).sort();
    const key = effectKeys.length ? ['effect', effectKeys[0]] : ['outcome', latest.resourceKey, latest.confirmation.outcomeId];
    const outcome = {
      id: `outcome_${sha(canonical(key))}`,
      resourceKey: latest.resourceKey,
      outcomeId: latest.confirmation.outcomeId,
      ...(effectKeys.length ? { effectKey: effectKeys[0] } : {}),
      status: latest.confirmation.status,
      prior,
      // An unlinked historical receipt cannot establish a new effect for this task.
      isNew: latest.confirmation.status === 'confirmed' && !prior && effectKeys.length > 0,
      evidenceIds: group.map(record => record.id),
      workItemIds: unique(group.map(record => record.workItemId)),
      resourceKeys: unique(group.map(record => record.resourceKey)),
    };
    return { outcome, records: group };
  });
}

function sourceCoverage(evidence, journal) {
  const isSource = record => record.kind === 'source-coverage' || record.coverage ||
    (record.kind === 'observation' && record.sourceVersion);
  const byResource = new Map();
  for (const record of evidence) {
    if (!isSource(record)) continue;
    if (!byResource.has(record.resourceKey)) byResource.set(record.resourceKey, []);
    byResource.get(record.resourceKey).push(record);
  }
  const results = [];
  for (const [resourceKey, source] of byResource) {
    // The canonical host journal, not model text or a caller timestamp, defines
    // observation order. No claim about the current remote state is implied.
    const latest = journal.findLast(record => record.resourceKey === resourceKey && isSource(record));
    const latestVersion = latest.sourceVersion;
    if (!latestVersion) {
      results.push({ resourceKey, complete: false, evidenceIds: [latest.id], unknown: true });
      continue;
    }
    const current = source.filter(record => record.sourceVersion === latestVersion);
    const byUnit = new Map();
    for (const record of current) {
      if (!record.coverage) continue;
      if (!byUnit.has(record.coverage.unit)) byUnit.set(record.coverage.unit, []);
      byUnit.get(record.coverage.unit).push(record);
    }
    let complete = false;
    let supporting = current;
    for (const ranges of byUnit.values()) {
      // Conflicting totals under one stable version cannot certify coverage.
      if (new Set(ranges.map(record => record.coverage.total)).size !== 1) continue;
      const total = ranges[0].coverage.total;
      let cursor = 0;
      const sorted = [...ranges].sort((a, b) => a.coverage.start - b.coverage.start || a.coverage.end - b.coverage.end);
      for (const { coverage } of sorted) {
        if (coverage.start > cursor) break;
        cursor = Math.max(cursor, coverage.end);
      }
      if (cursor === total) {
        complete = true;
        supporting = ranges;
        break;
      }
    }
    results.push({ resourceKey, complete, evidenceIds: unique([...supporting.map(record => record.id), latest.id]), unknown: byUnit.size === 0 });
  }
  return results;
}

/** Evaluate only host evidence, with explicit model judgment kept separate. */
export function evaluateContractCriteria(contract, evidence, { judgments = [], operations = [], currentOperation } = {}) {
  plain(contract, 'contract');
  if (!Array.isArray(contract.criteria) || contract.criteria.length > 200 || !Array.isArray(contract.workItems) || contract.workItems.length > 200) {
    throw new TypeError('contract criteria and workItems must be bounded arrays');
  }
  if (!Array.isArray(judgments) || judgments.length > MAX_EVIDENCE) throw new TypeError('judgments exceed bounds');
  const observed = records(evidence);
  const observedById = new Map(observed.map(record => [record.id, record]));
  const scopes = operationScopes(operations);
  const allWorkItemIds = new Set(contract.workItems.map(item => item.id));
  const groups = outcomeGroups(observed);
  const boundEffects = new Map();
  for (const operation of operations) {
    const effectKey = operation.commit?.effectKey;
    if (!effectKey || !operation.confirmationCriterionId || !['dispatched', 'returned', 'interrupted'].includes(operation.deliveryState)) continue;
    const criteria = boundEffects.get(effectKey) || new Set();
    criteria.add(operation.confirmationCriterionId);
    boundEffects.set(effectKey, criteria);
  }
  const currentOperations = currentOperation ? new Set(operations.filter(currentOperation).map(operation => operation.operationId)) : null;
  const currentEffects = currentOperation ? new Set(operations.filter(operation => currentOperations.has(operation.operationId) && operation.dispatchedAt && operation.commit).map(operation => operation.commit.effectKey)) : null;
  const isCurrent = record => !currentOperations || currentOperations.has(record.operationId);
  if (currentEffects) for (const { outcome, records } of groups) {
    outcome.isNew = outcome.isNew && currentEffects.has(outcome.effectKey) && records.some(isCurrent);
  }
  const criterionIds = new Set();
  const criteria = contract.criteria.map(criterion => {
    plain(criterion, 'criterion');
    const id = string(criterion.id, 'criterion.id', 256);
    if (criterionIds.has(id)) throw new TypeError('duplicate criterion ID');
    criterionIds.add(id);
    if (!['observation', 'source-coverage', 'external-confirmation', 'judgment'].includes(criterion.kind)) throw new TypeError('criterion kind is not supported');
    const targetCount = criterion.targetCount ?? 1;
    if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > MAX_EVIDENCE) throw new TypeError('criterion targetCount must be a bounded positive integer');
    if (criterion.resourceKey !== undefined) string(criterion.resourceKey, 'criterion.resourceKey', 4096);
    const workItems = criterionWorkItems(contract, id);
    const matchesCriterion = criterionEvidence(criterion, workItems, scopes);
    const eligible = record => isCurrent(record) && matchesCriterion(record);
    const candidates = observed.filter(eligible);
    let observedCount = 0;
    let evidenceIds = [];
    let reason;
    if (criterion.kind === 'external-confirmation') {
      const matches = groups.filter(group => {
        if (!group.outcome.isNew) return false;
        const bindings = group.records.map(record => boundEffects.get(record.confirmation.effectKey)).filter(Boolean);
        return bindings.every(ids => ids.size === 1 && ids.has(id)) && group.records.some(eligible);
      });
      observedCount = matches.length;
      evidenceIds = unique(matches.flatMap(group => group.outcome.evidenceIds));
      reason = observedCount >= targetCount ? 'Distinct new destination confirmations recorded.' : 'New confirmed outcomes are below the target; prior, absent, unlinked, and duplicate receipts do not count.';
    } else if (criterion.kind === 'source-coverage') {
      const coverage = sourceCoverage(candidates, currentOperations ? observed.filter(isCurrent) : observed);
      observedCount = coverage.filter(source => source.complete).length;
      evidenceIds = unique(coverage.flatMap(source => source.evidenceIds));
      reason = observedCount >= targetCount ? 'Complete delivered coverage recorded for the latest observed stable source versions.' :
        coverage.some(source => source.unknown) ? 'Source version or delivered coverage is unknown.' : 'Delivered ranges do not cover the required stable sources.';
    } else if (criterion.kind === 'observation') {
      const observations = candidates.filter(record => record.kind !== 'validation');
      observedCount = new Set(observations.map(record => record.resourceKey)).size;
      evidenceIds = observations.map(record => record.id);
      reason = observedCount >= targetCount ? 'Required distinct resources observed by host operations.' : 'Required distinct resource observations are below the target.';
    } else {
      // Latest assessment per work item wins. A claim cannot cite missing or
      // unrelated evidence, nor can it change a mechanically checked criterion.
      const latest = new Map();
      for (const judgment of judgments) {
        if (!judgment || typeof judgment !== 'object' || judgment.criterionId !== id || !allWorkItemIds.has(judgment.workItemId) ||
            (Number.isSafeInteger(contract.planEpoch) && judgment.planEpoch !== contract.planEpoch) ||
            (workItems.size > 0 && !workItems.has(judgment.workItemId))) continue;
        latest.set(judgment.workItemId, judgment);
      }
      let ineligibleReason;
      for (const judgment of latest.values()) {
        const ids = judgment.evidenceIds;
        if (judgment.judgment !== 'satisfied') continue;
        const issue = judgmentEvidenceIssue(judgment, observedById, eligible, criterion);
        if (issue) { ineligibleReason ||= issue; continue; }
        observedCount += 1;
        evidenceIds.push(...ids);
      }
      evidenceIds = unique(evidenceIds);
      reason = observedCount >= targetCount ? 'Explicit judgment supported by cited host evidence.' : ineligibleReason || 'A satisfied judgment with relevant host evidence is still required.';
    }
    return { id, satisfied: observedCount >= targetCount, observedCount, targetCount, evidenceIds, reason };
  });
  return freeze({ criteria, outcomes: groups.map(group => group.outcome) });
}
