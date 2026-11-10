import { projectContractTaskState, contractDeliveryPage, createContractDeliveryTracker } from './planning-contract-delivery.mjs';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CONTRACT_RECEIPT_BINDING_SCHEMA, isPlanContractTask, normalizePlanContract, receiptBindingsForCriterion, workItemOperationScopes } from '../public/planning-contract-model.mjs';
import { OPERATIONAL_HOLD_POLICY_VERSION, verifyOperationalHold } from '../public/planning-user-agency.mjs';
import { normalizeContractEvidence, evaluateContractCriteria, checkContractJudgmentEvidence } from './planning-contract-evidence.mjs';
import { describeHostOperation, matchingWorkItemOperationScopes, matchedConfirmationCriterion, normalizeHostOperationResult, operationResourcesWithinScope } from './operation-descriptors.mjs';

// Version 3 evolves the existing .sequence file. It does not create a second
// operation authority or make model-authored milestone prose into a receipt.
export const CONTRACT_JOURNAL_VERSION = 3;
const LIMITS = Object.freeze({ records: 4096, evidence: 16384, findings: 256, bytes: 8 * 1024 * 1024, recent: 48 });
const live = new Set();
const blockedObservations = new WeakMap();
const observationOwnerKey = (taskId, runId, nodeId) => JSON.stringify([taskId, runId, nodeId]);
const clone = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileOf = (store, taskId) => store.file(taskId) + '.sequence';
const fail = (message, code = 'TASK_CONTRACT_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Task stopped.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const argumentsOf = call => { try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { return null; } };
const receipt = (code, message, fields = {}) => ({ success: false, code, contentItems: [{ type: 'inputText', text: JSON.stringify({ code, message, ...fields }) }] });
const sameOwner = (focus, runId, nodeId) => focus.runId === runId && focus.nodeId === nodeId;
const ownerAllows = (item, nodeId, coordinator) => item.owner === nodeId || coordinator && item.owner === 'coordinator';
const active = operation => ['reserved', 'dispatched'].includes(operation.deliveryState) && live.has(operation.operationId);
const reconciledEffect = operation => operation.reconciliationEvidenceIds?.length && ['confirmed', 'absent'].includes(operation.effectState) ? operation.effectState : null;
const effectiveEffect = operation => reconciledEffect(operation) || (operation.deliveryState === 'reserved' ? operation.effect === 'observe' ? 'not-applicable' : 'absent' : operation.deliveryState === 'dispatched' && !active(operation) ? operation.effect === 'observe' ? 'not-applicable' : 'unknown' : operation.effectState);
export function contractRetryReceipts(journal, runId) {
  const receipts = [];
  for (const operation of journal.records) {
    if (operation.runId !== runId || !operation.dispatchedAt ||
        !['dispatched', 'returned', 'interrupted'].includes(operation.deliveryState)) continue;
    const state = reconciledEffect(operation) || (operation.deliveryState === 'dispatched' ? 'unknown' : effectiveEffect(operation));
    const commitment = operation.effect === 'commit' && operation.commit;
    const unknownExternalWrite = state === 'unknown' && operation.effect === 'opaque' &&
      operation.resources.some(resource => resource.access === 'write' && !resource.scopeOnly && /^(?:url|destination):https?:\/\//i.test(resource.key));
    if ((commitment && ['confirmed', 'unknown', 'unconfirmed'].includes(state)) || unknownExternalWrite) {
      receipts.push({ id: operation.operationId, status: state === 'confirmed' ? 'confirmed' : 'uncertain' });
    }
  }
  return receipts;
}
const occupiesCommitSlot = operation => operation.commit && (operation.deliveryState === 'reserved' && active(operation) || ['unknown', 'unconfirmed'].includes(effectiveEffect(operation)));
const pendingCriterionEffects = (journal, criterionId, exceptOperationId = null, currentOperation) => new Set(journal.records.filter(operation => operation.operationId !== exceptOperationId && (!currentOperation || currentOperation(operation)) && occupiesCommitSlot(operation) && operation.criteria?.some(criterion => criterion.id === criterionId)).map(operation => operation.commit.effectKey));
// This is recovery guidance, never a receipt or additional authority. The same
// retained operation still needs the normal adapter's matching host evidence.
const unresolvedBrowserCommit = operation => operation?.tool === 'relay_browser' && operation.effect === 'commit' && operation.commit
  && ['unknown', 'unconfirmed'].includes(effectiveEffect(operation));
export function hasPendingBrowserReceipt(journal, workItemId, criterionId) {
  return journal.records.some(operation => unresolvedBrowserCommit(operation) && operation.workItemId === workItemId
    && operation.criteria?.some(criterion => criterion.id === criterionId));
}
const missingBrowserCommitCriterion = (state, item, call) => state.contractAdoption && item && call.name === 'relay_browser' && !call.namespace
  && !state.contract.criteria.some(criterion => criterion.kind === 'external-confirmation' && item.criterionIds.includes(criterion.id));
const browserCommitCriterionMessage = 'Attach an external-confirmation criterion to this owning work item before submitting. A receipt binding may be added after observing the actual response. No submission was dispatched.';
const commitScopeMessage = 'Bind this actual commitment to one confirmation criterion through its matching operation scope. No commitment was dispatched.';
const commitCriteria = (contract, item, criterionId) => contract?.criteria.filter(criterion =>
  item?.criterionIds.includes(criterion.id) && (!criterionId || criterion.id === criterionId)) || [];
const receiptBindingFields = CONTRACT_RECEIPT_BINDING_SCHEMA.anyOf.map(({ properties, required }) => ({
  formats: properties.format.enum || [properties.format.const],
  required,
  optional: Object.keys(properties).filter(field => !required.includes(field)),
}));
function browserReceiptRecovery(state, operation) {
  if (!unresolvedBrowserCommit(operation)) return null;
  const item = state.contract?.workItems.find(row => row.id === operation.workItemId);
  const current = new Map((state.contract?.criteria || []).map(row => [row.id, row]));
  const ids = (operation.criteria || []).filter(row => row.kind === 'external-confirmation'
    || item?.criterionIds.includes(row.id) && current.get(row.id)?.kind === 'external-confirmation').map(row => row.id);
  const criteria = ids.slice(0, 40).map(id => {
    const criterion = current.get(id), bindings = receiptBindingsForCriterion(criterion);
    const identityMapped = binding => Boolean(binding.format === 'dom-text' ? binding.outcomeFields?.length : binding.identity?.length);
    return { criterionId: id, bindingState: !item?.criterionIds.includes(id) || criterion?.kind !== 'external-confirmation' ? 'criterion-not-current' : !bindings.length ? 'missing'
      : !bindings.some(binding => binding.confirmedValues?.length) ? 'absence-only'
      : !bindings.some(binding => binding.absentValues?.length) ? 'confirmation-only' : 'status-mapping-present',
      ...(bindings.length === 1 ? { format: bindings[0].format, identityMapped: identityMapped(bindings[0]) }
        : bindings.length > 1 ? { formats: [...new Set(bindings.map(binding => binding.format))], identityMapped: bindings.every(identityMapped) } : {}) };
  });
  const names = [...new Set((operation.commit.identityDigests || []).map(row => row.name)
    .filter(name => typeof name === 'string' && name.length <= 256))];
  return { type: 'browser-receipt-recovery', operationId: operation.operationId, workItemId: operation.workItemId,
    effectKey: operation.commit.effectKey, destinationKey: operation.commit.destinationKey,
    effectState: effectiveEffect(operation), reason: !criteria.length ? 'receipt-criterion-required'
      : criteria.some(row => ['missing', 'criterion-not-current'].includes(row.bindingState)) ? 'receipt-binding-missing' : 'receipt-not-matched', criteria,
    ...(!criteria.length ? { recordedCriterionIds: (operation.criteria || []).slice(0, 40).map(row => row.id) } : {}),
    ownerCanObserve: Boolean(item?.effects?.includes('observe')),
    bindReceipt: { tool: 'relay_task', action: 'bind_receipt', expectedRevision: state.revision, workItemId: operation.workItemId,
      ...(criteria.length === 1 && criteria[0].bindingState !== 'criterion-not-current' ? { criterionId: criteria[0].criterionId } : {}) },
    receiptBindingFields,
    observedFormFieldNames: names.slice(0, 20), omittedFormFieldCount: Math.max(0, names.length - 20),
    observation: { tool: 'relay_browser', actions: ['read', 'snapshot'], fields: ['url', 'frames[].semanticRecords', 'frames[].forms'] },
    steps: [
      'Observe a matching current response or actual destination history. A retained rejection from an earlier submission is not proof about this operation. semanticRecords contains observed selectors, attributes and visible text; forms contains actual form actions and control names. Preserve this operation and its effect identity; do not submit again.',
      ...(!criteria.length ? ['The recorded work item has no current receipt criterion with an ID present at dispatch. If its original outcome criterion was misclassified, correct that same ID to external-confirmation on the same work item. Do not add an unrelated receipt criterion or repeat the submission.'] : []),
      'Once the response fields are observed, call relay_task with action "bind_receipt", the expectedRevision and owning workItemId above, the existing external-confirmation criterionId, and one observed receiptBinding. A stale revision needs only relay_task {"action":"read"} and its returned revision. Do not send a contract, expectedPlanEpoch, or a pinned page read to save the binding.',
      'Use exactly the required and optional receiptBindingFields for the observed format. Set version:1. For DOM or JSON, resourceKey is "url:<observed response URL>" or "origin:<observed response origin>". Set record to the observed selector or record, status and outcomeId to the observed field names, and confirmedValues to exact observed status values. Map identity with {field,formField} pairs from the receipt to submitted controls. Use destination for the observed destination field when the response URL differs from the original form destination. For a current response use history:false. For dom-text, record is the observed unique visible selector and confirmedValues contains the exact normalized text. It requires history:false, observed outcomeFields and retained native POST request/document correlation.',
      'Use only observed statuses. Leave confirmedValues empty when nonempty absentValues describes an observed rejection. After saving the binding, call relay_task focus with the owning workItemId and current expectedPlanEpoch from the returned state, then relay_browser read or snapshot on the same observed response or actual history. If the owner lacks observe, use normal Plan refinement to add only that authorized observation scope. Zero records or error prose alone do not prove absence.',
    ] };
}
const locks = descriptor => {
  const concrete = descriptor.resources.filter(resource => resource.scopeOnly !== true);
  return concrete.length ? concrete : descriptor.resources;
};
const conflicts = (left, right) => locks(left).some(a => locks(right).some(b => a.key === b.key && (a.access === 'write' || b.access === 'write')));
export function contractWorkItemSignature(contract, itemId) {
  const selected = new Set(), visit = id => { if (selected.has(id)) return; selected.add(id); for (const dependency of contract.workItems.find(item => item.id === id)?.dependsOn || []) visit(dependency); };
  visit(itemId);
  const items = contract.workItems.filter(item => selected.has(item.id)), criteria = new Set(items.flatMap(item => item.criterionIds));
  return hash({ goal: contract.goal, instructions: contract.instructions, workItems: items, criteria: contract.criteria.filter(item => criteria.has(item.id)) });
}
function validateJournal(value, taskId) {
  if (value?.version !== CONTRACT_JOURNAL_VERSION || value.taskId !== taskId || value.policy !== 'work-items-v2'
      || !Number.isSafeInteger(value.journalSeq) || value.journalSeq < 0
      || !['records', 'evidence', 'focuses', 'judgments', 'findings', 'progress'].every(key => Array.isArray(value[key]))
      || value.records.length > LIMITS.records || value.evidence.length > LIMITS.evidence || value.findings.length > LIMITS.findings)
    throw fail('The canonical operation journal is unavailable. Preserve its bytes and reconcile uncertain effects.', 'TASK_CONTRACT_JOURNAL_DAMAGED', 500);
  const ids = new Set();
  for (const operation of value.records) {
    if (!operation || typeof operation.operationId !== 'string' || ids.has(operation.operationId)
        || !['reserved', 'dispatched', 'returned', 'cancelled-before-dispatch', 'interrupted'].includes(operation.deliveryState)
        || !['not-applicable', 'unconfirmed', 'confirmed', 'absent', 'unknown'].includes(operation.effectState)
        || !Array.isArray(operation.resources) || !Array.isArray(operation.evidenceIds)
        || operation.confirmationCriterionId !== undefined && (operation.effect !== 'commit' || !operation.commit ||
          typeof operation.confirmationCriterionId !== 'string' || !Array.isArray(operation.criteria) || operation.criteria.length !== 1 ||
          operation.criteria[0]?.kind !== 'external-confirmation' || operation.criteria[0]?.id !== operation.confirmationCriterionId)
        || !Number.isSafeInteger(operation.journalSeq) || operation.journalSeq > value.journalSeq)
      throw fail('An operation journal record is invalid. Existing effects were preserved.', 'TASK_CONTRACT_JOURNAL_DAMAGED', 500);
    ids.add(operation.operationId);
  }
  return value;
}
export async function readContractJournal(store, taskId) {
  try {
    const file = fileOf(store, taskId), stat = await fs.stat(file);
    if (stat.size > LIMITS.bytes) throw fail('The operation journal exceeds its supported bound.', 'TASK_CONTRACT_JOURNAL_LIMIT', 413);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== CONTRACT_JOURNAL_VERSION) throw fail('This task retains its previous operation contract. Use an explicit settled migration; do not replace its ledger.', 'TASK_CONTRACT_MIGRATION_REQUIRED');
    return validateJournal(value, taskId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: CONTRACT_JOURNAL_VERSION, policy: 'work-items-v2', taskId, journalSeq: 0, records: [], evidence: [], focuses: [], judgments: [], findings: [], progress: [] };
  }
}
async function saveJournal(store, taskId, journal) {
  validateJournal(journal, taskId);
  const data = JSON.stringify(journal);
  if (Buffer.byteLength(data) > LIMITS.bytes) throw fail('The operation journal reached its supported bound. No new operation was dispatched.', 'TASK_CONTRACT_JOURNAL_LIMIT', 413);
  const target = fileOf(store, taskId), temporary = target + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    // Every caller is under TaskStateStore.enqueue, the same cross-store lock
    // that owns structural plan updates and legacy sequence reservations.
    const token = store.lockOwners?.get(taskId);
    const lock = JSON.parse(await fs.readFile(store.file(taskId) + '.lock', 'utf8'));
    if (!token || lock.token !== token || lock.pid !== process.pid) throw fail('The operation write lock changed.', 'TASK_STATE_LOCK_LOST');
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
const advance = journal => ++journal.journalSeq;
function retainRejection(operation, evidence) {
  const receiptStatus = evidence.validation?.receiptStatus;
  if (operation.rejection || !operation.dispatchedAt || !operation.commit
      || !['dispatched', 'returned', 'interrupted'].includes(operation.deliveryState)
      || evidence.confirmation?.status !== 'absent' || evidence.confirmation.effectKey !== operation.commit.effectKey
      || typeof receiptStatus !== 'string' || !receiptStatus) return;
  const basis = { destinationKey: operation.commit.destinationKey, payloadDigest: operation.commit.payloadDigest,
    attachmentDigests: operation.commit.attachmentDigests, receiptStatus, outcomeId: evidence.confirmation.outcomeId };
  operation.rejection = { key: hash(basis), evidenceId: evidence.id, receiptStatus, outcomeId: evidence.confirmation.outcomeId };
}
function refreshProgress(journal) {
  const progress = new Map();
  for (const operation of journal.records) {
    if (!operation.commit || !operation.dispatchedAt || effectiveEffect(operation) !== 'absent' || !operation.rejection) continue;
    const { effectKey, payloadDigest } = operation.commit, previous = progress.get(effectKey);
    const same = previous?.validationKey === operation.rejection.key && previous?.payloadDigest === payloadDigest;
    const unchangedAttempts = same ? previous.unchangedAttempts + 1 : 1;
    progress.set(effectKey, { effectKey, payloadDigest, validationKey: operation.rejection.key, unchangedAttempts,
      blocked: unchangedAttempts >= 2, lastOperationId: operation.operationId, evidenceId: operation.rejection.evidenceId });
  }
  // This is a projection of distinct dispatched attempts. Re-observing the
  // same receipt or changing a plan cannot create or erase an attempt.
  journal.progress = [...progress.values()];
}
export function currentContractOperation(state) {
  const adoption = state.contractAdoption;
  if (!adoption?.freshEvidence || !adoption.planRef?.cycleId) return undefined;
  return operation => operation.planCycleId === adoption.planRef.cycleId || !operation.planCycleId && operation.runId === adoption.runId;
}
export function currentContractJudgments(state, journal) {
  if (!isPlanContractTask(state)) return [];
  const currentOperation = currentContractOperation(state);
  const delivered = currentOperation ? new Set(journal.records.filter(currentOperation).flatMap(record => record.evidenceIds)) : null;
  const reviewHolds = state.contractAdoption?.operationalHoldPolicy === OPERATIONAL_HOLD_POLICY_VERSION;
  const signatures = new Map();
  return journal.judgments.filter(judgment =>
    (!reviewHolds || judgment.judgment !== 'blocked' || judgment.userAgency)
    && (!delivered || judgment.evidenceIds.every(id => delivered.has(id)))).map(judgment => {
    const priorSignature = judgment.workItemSignature || (state.contractAdoption?.commitPrerequisiteIds?.includes(judgment.criterionId) ? judgment.prerequisiteSignature : null);
    if (!priorSignature || judgment.planEpoch === state.contract.planEpoch) return judgment;
    if (!signatures.has(judgment.workItemId)) signatures.set(judgment.workItemId, contractWorkItemSignature(state.contract, judgment.workItemId));
    return priorSignature === signatures.get(judgment.workItemId) ? { ...judgment, planEpoch: state.contract.planEpoch } : judgment;
  });
}
function evaluation(state, journal, judgments = currentContractJudgments(state, journal)) {
  if (!isPlanContractTask(state)) return { criteria: [], outcomes: [] };
  return evaluateContractCriteria(state.contract, journal.evidence, { judgments, operations: journal.records, currentOperation: currentContractOperation(state) });
}
function missingCurrentCommitPrerequisites(state, journal, view, runId) {
  const ids = state.contractAdoption?.commitPrerequisiteIds;
  if (!ids?.length) return [];
  const delivered = new Set(journal.records.filter(record => record.runId === runId && record.deliveryState === 'returned' && record.success !== false)
    .flatMap(record => record.evidenceIds));
  return ids.filter(id => {
    const row = view.criteria.find(criterion => criterion.id === id);
    return !row?.satisfied || !row.evidenceIds.length || row.evidenceIds.some(evidenceId => !delivered.has(evidenceId));
  });
}
function assessmentRecovery(state, journal, { runId, nodeId, coordinator, workItemIds, criterionIds, preferredWorkItemId } = {}) {
  const { contract } = state;
  const judgmentIds = new Set(contract.criteria.filter(row => row.kind === 'judgment' && (!criterionIds || criterionIds.includes(row.id))).map(row => row.id));
  const owned = contract.workItems.filter(item => ownerAllows(item, nodeId, coordinator) && (!workItemIds || workItemIds.includes(item.id)));
  const pairs = owned.flatMap(item => item.criterionIds.filter(id => judgmentIds.has(id)).map(criterionId => ({ workItemId: item.id, criterionId })));
  if (!pairs.length) return null;
  pairs.sort((a, b) => Number(b.workItemId === preferredWorkItemId) - Number(a.workItemId === preferredWorkItemId));
  const currentOperation = currentContractOperation(state);
  const records = journal.records.filter(row => row.runId === runId && (!currentOperation || currentOperation(row)) && row.deliveryState === 'returned' && row.success === true);
  const byId = new Map(journal.evidence.map(row => [row.id, row]));
  const assessments = pairs.slice(0, 4).map(pair => {
    const evidenceIds = [];
    const recent = records.filter(row => row.workItemId === pair.workItemId).slice(-24).reverse();
    for (const operation of recent) for (const id of operation.evidenceIds) {
      if (evidenceIds.length >= 8 || evidenceIds.includes(id)) continue;
      const evidence = byId.get(id);
      if (evidence && checkContractJudgmentEvidence(contract, [evidence], { ...pair, evidenceIds: [id] }, { operations: [operation] }).valid) evidenceIds.push(id);
    }
    return { ...pair, evidenceIds };
  });
  return { tool: 'relay_task', action: 'assess', expectedPlanEpoch: contract.planEpoch, assessments,
    note: 'Use an owned work item and its judgment criterion. Cite only the saved evidence that actually supports the judgment. If the needed observation belongs to another work item or is missing, focus the owning work item and observe the relevant source there before assessing.' };
}

function commitPrerequisiteRecovery(state, journal, view, items, actor) {
  const workItemIds = [...new Set(items.flatMap(item => item.dependsOn))];
  const missing = view.criteria.filter(row => !row.satisfied).map(row => row.id);
  return assessmentRecovery(state, journal, { ...actor, workItemIds, criterionIds: missing });
}
export function contractRuntimeView(state, journal) {
  const judgments = currentContractJudgments(state, journal);
  const assessed = evaluation(state, journal, judgments), byCriterion = new Map((assessed.criteria || []).map(row => [row.id, row]));
  const currentOperation = currentContractOperation(state), currentRecords = currentOperation ? journal.records.filter(currentOperation) : journal.records;
  const workItems = (state.contract?.workItems || []).map(item => {
    const operations = currentRecords.filter(record => record.workItemId === item.id);
    const unresolved = operations.filter(record => ['unknown', 'unconfirmed'].includes(effectiveEffect(record)) && (record.effect === 'commit' || effectiveEffect(record) === 'unknown'));
    const satisfied = item.criterionIds.every(id => byCriterion.get(id)?.satisfied === true);
    const latestJudgments = new Map();
    for (const row of judgments.filter(row => row.workItemId === item.id && row.planEpoch === state.contract.planEpoch)) latestJudgments.set(row.criterionId, row);
    const judgment = [...latestJudgments.values()].find(row => row.judgment === 'blocked');
    const noProgress = journal.progress.find(row => row.blocked && operations.some(operation => operation.commit?.effectKey === row.effectKey));
    return { id: item.id, title: item.title, owner: item.owner, status: satisfied ? 'satisfied' : judgment || noProgress ? 'blocked' : operations.length ? 'running' : 'pending',
      ready: true, criterionIds: clone(item.criterionIds), evidenceIds: [...new Set(item.criterionIds.flatMap(id => byCriterion.get(id)?.evidenceIds || []))],
      operationCount: operations.length, unresolvedCount: unresolved.length,
      ...((judgment || noProgress) ? { blockedReason: judgment?.note || 'The same observed validation and commit state repeated without progress. Inspect or repair this item; independent work remains available.' } : {}) };
  });
  const byId = new Map(workItems.map(row => [row.id, row]));
  for (const item of state.contract?.workItems || []) {
    const row = byId.get(item.id), missing = item.dependsOn.filter(id => byId.get(id)?.status !== 'satisfied');
    row.ready = row.status !== 'blocked' && missing.length === 0;
    if (missing.length && !row.blockedReason) row.blockedReason = 'Commit prerequisites remain: ' + missing.join(', ') + '. Observations needed to resolve them remain available.';
  }
  const operations = journal.records.slice(-LIMITS.recent).map(record => ({ ...clone(record), effectState: effectiveEffect(record), live: active(record) }));
  return { version: 1, planEpoch: state.contract?.planEpoch || 0, journalSeq: journal.journalSeq, focuses: clone(journal.focuses), workItems,
    criteria: clone(assessed.criteria || []), operations, omittedOperations: Math.max(0, journal.records.length - operations.length),
    evidence: clone(journal.evidence.slice(-96)), omittedEvidence: Math.max(0, journal.evidence.length - 96), outcomes: clone(assessed.outcomes || []),
    findings: clone(journal.findings), unresolved: currentRecords.filter(record => effectiveEffect(record) === 'unknown' || record.effect === 'commit' && effectiveEffect(record) === 'unconfirmed').map(record => ({ operationId: record.operationId, workItemId: record.workItemId, effectState: effectiveEffect(record), resources: clone(record.resources), ...(record.commit ? { commit: clone(record.commit) } : {}) })) };
}
export async function validateContractPlanTransition(store, taskId, previous, next) {
  if (!isPlanContractTask(next)) {
    if (isPlanContractTask(previous)) throw fail('A canonical task cannot be replaced with legacy atomic leaves.', 'TASK_CONTRACT_MIGRATION_REQUIRED');
    return;
  }
  if (!isPlanContractTask(previous) && previous.steps?.length) throw fail('Preserve the legacy plan and use an explicit settled migration.', 'TASK_CONTRACT_MIGRATION_REQUIRED');
  if (next.steps?.length) throw fail('Canonical work items cannot be mixed with a second legacy operation plan.', 'TASK_CONTRACT_INVALID');
  await readContractJournal(store, taskId); // A legacy ledger is never silently replaced.
  normalizePlanContract(next.contract, { allowEpoch: true });
}
const publicResult = state => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(state.contractDelivery || state.view ? state : projectContractTaskState(state)) }] });
export async function applyContractTaskAction({ store, taskId, runId, nodeId, coordinator = true, args, signal, onEvent = () => {} }) {
  check(signal);
  if (args.action === 'read' || args.action === 'review') {
    const state = await store.get(taskId, { signal });
    if (args.action === 'read' && args.view === 'contract') return publicResult(contractDeliveryPage(state, args));
    if (args.action === 'read' && ['operations', 'evidence'].includes(args.view)) {
      const journal = await readContractJournal(store, taskId), offset = args.offset ?? 0, limit = args.limit ?? 48;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Use a nonnegative offset and limit from 1 to 100.');
      const entries = args.view === 'operations' ? journal.records : journal.evidence, items = clone(entries.slice(offset, offset + limit));
      const page = { taskId, revision: state.revision, taskSchemaVersion: 14, contractVersion: 2, planEpoch: state.contract?.planEpoch || 0, journalSeq: journal.journalSeq, view: args.view, offset, limit, total: entries.length, items, nextOffset: null };
      while (items.length && Buffer.byteLength(JSON.stringify(page)) > 18500) items.pop();
      if (!items.length && offset < entries.length) throw fail('This retained journal entry exceeds the bounded reply size. Its exact bytes remain in the operation journal; no entry was silently omitted.', 'TASK_CONTRACT_JOURNAL_ENTRY_LIMIT', 413);
      page.nextOffset = offset + items.length < entries.length ? offset + items.length : null;
      return publicResult(page);
    }
    if (args.action === 'review') return publicResult({ ...state, contractRuntime: { ...state.contractRuntime, review: contractCompletionStatus(state, await readContractJournal(store, taskId)) } });
    return publicResult(state);
  }
  const denial = await store.enqueue(taskId, async () => {
    const state = (await store.load(taskId)).history.at(-1);
    if (!isPlanContractTask(state)) throw fail('Adopt the canonical plan before changing work-item focus.', 'TASK_CONTRACT_REQUIRED');
    const journal = await readContractJournal(store, taskId);
    if (args.action !== 'finding' && args.expectedPlanEpoch !== state.contract.planEpoch) throw fail('The material plan changed. Read its current planEpoch before changing work.', 'TASK_CONTRACT_EPOCH_CONFLICT');
    if (args.action === 'focus') {
      const item = state.contract.workItems.find(item => item.id === args.workItemId);
      if (!item || !ownerAllows(item, nodeId, coordinator)) throw fail('This work item is not owned by this worker.', 'TASK_CONTRACT_OWNERSHIP', 403);
      let focus = journal.focuses.find(row => sameOwner(row, runId, nodeId));
      if (!focus) { focus = { runId, nodeId, workItemId: item.id, generation: 1, planEpoch: state.contract.planEpoch, deliveredPlanEpoch: state.contract.planEpoch }; journal.focuses.push(focus); }
      else { if (focus.workItemId !== item.id || focus.planEpoch !== state.contract.planEpoch) focus.generation++; Object.assign(focus, { workItemId: item.id, planEpoch: state.contract.planEpoch, deliveredPlanEpoch: state.contract.planEpoch }); }
    } else if (args.action === 'assess') {
      const item = state.contract.workItems.find(item => item.id === args.workItemId), criterion = state.contract.criteria.find(item => item.id === args.criterionId);
      const reject = (code, message, status = 409, details = {}) => {
        const actor = { runId, nodeId, coordinator, preferredWorkItemId: args.workItemId };
        const recovery = assessmentRecovery(state, journal, { ...actor, criterionIds: [args.criterionId] }) || assessmentRecovery(state, journal, actor);
        return { ...receipt(code, message, { error: message, status, ...details, ...(recovery ? { recovery } : {}) }), status };
      };
      if (!item || !ownerAllows(item, nodeId, coordinator) || !item.criterionIds.includes(args.criterionId)) return reject('TASK_CONTRACT_OWNERSHIP', 'The assessment is outside this worker’s work item.', 403);
      if (criterion?.kind !== 'judgment') return reject('TASK_CONTRACT_EVIDENCE_REQUIRED', 'Only judgment criteria accept an agent assessment. Observation and confirmation require actual host evidence.');
      if (!['satisfied', 'blocked'].includes(args.judgment) || typeof args.note !== 'string' || !args.note.trim() || args.note.length > 2000 || !Array.isArray(args.evidenceIds) || !args.evidenceIds.length || args.evidenceIds.some(id => !journal.evidence.some(evidence => evidence.id === id))) return reject('TASK_CONTRACT_EVIDENCE_REQUIRED', 'A judgment needs actual saved evidence IDs and a bounded public rationale.');
      const prerequisite = state.contractAdoption?.commitPrerequisiteIds?.includes(criterion.id);
      const reviewHold = args.judgment === 'blocked' &&
        (state.contractAdoption?.operationalHoldPolicy === OPERATIONAL_HOLD_POLICY_VERSION || args.userAgency !== undefined);
      if (args.judgment === 'satisfied' || prerequisite || reviewHold) {
        const checked = checkContractJudgmentEvidence(state.contract, journal.evidence, args, { operations: journal.records });
        if (!checked.valid) return reject('TASK_CONTRACT_EVIDENCE_INELIGIBLE', checked.reason);
      }
      let userAgency = null;
      if (reviewHold) {
        try {
          userAgency = verifyOperationalHold(args.userAgency, {
            criterionId: criterion.id, evidence: journal.evidence.filter(record => args.evidenceIds.includes(record.id)),
            requiredCriterionIds: state.contractAdoption?.requiredCriterionIds,
          });
        } catch (error) {
          if (error?.code?.startsWith('USER_AGENCY_') || error?.code === 'INVALID_USER_COST_DECISION')
            return reject(error.code, error.message, error.status || 400, { holdRecorded: false });
          throw error;
        }
      }
      journal.judgments.push({ id: 'judgment-' + randomUUID(), workItemId: item.id, criterionId: criterion.id, judgment: args.judgment, note: args.note, evidenceIds: clone(args.evidenceIds), planEpoch: state.contract.planEpoch, at: stamp(),
        ...(userAgency ? { userAgency } : {}),
        ...(args.judgment === 'satisfied' || prerequisite ? { workItemSignature: contractWorkItemSignature(state.contract, item.id) } : {}) });
    } else if (args.action === 'finding') {
      const finding = args.finding;
      if (!finding || typeof finding.ruleId !== 'string' || finding.ruleId.length > 120 || typeof finding.message !== 'string' || !finding.message.trim() || finding.message.length > 2000 || !Array.isArray(finding.evidenceIds) || finding.evidenceIds.some(id => !journal.evidence.some(evidence => evidence.id === id))) throw fail('An audit finding needs a rule identity, bounded description and actual evidence references.');
      journal.findings.push({ id: 'finding-' + randomUUID(), ...clone(finding), at: stamp(), disposition: 'audit' });
    } else throw fail('Choose a supported canonical task action.');
    check(signal); advance(journal); await saveJournal(store, taskId, journal);
  }, signal);
  if (denial) return denial;
  const state = await store.get(taskId, { signal }); onEvent({ type: 'task.state', taskId, state }); return publicResult(state);
}
export function contractCompletionStatus(state, journal, { nodeId, coordinator = true } = {}) {
  if (!isPlanContractTask(state)) return { ready: false, complete: false, reason: 'The canonical plan has not been adopted.' };
  const view = contractRuntimeView(state, journal), owned = new Set(state.contract.workItems.filter(item => !nodeId || ownerAllows(item, nodeId, coordinator)).map(item => item.id));
  if (nodeId && !coordinator) { const criteria = new Set(state.contract.workItems.filter(item => owned.has(item.id)).flatMap(item => item.criterionIds)); view.workItems = view.workItems.filter(item => owned.has(item.id)); view.criteria = view.criteria.filter(item => criteria.has(item.id)); view.unresolved = view.unresolved.filter(item => owned.has(item.workItemId)); }
  const currentOperation = currentContractOperation(state);
  const running = journal.records.filter(row => (!currentOperation || currentOperation(row)) && active(row) && (coordinator || owned.has(row.workItemId)));
  const complete = running.length === 0 && view.unresolved.length === 0 && view.criteria.length > 0 && view.criteria.every(row => row.satisfied === true);
  const readyWork = view.workItems.filter(row => row.ready && row.status !== 'satisfied');
  return { ready: running.length === 0 && view.unresolved.length === 0 && (complete || readyWork.length === 0), complete,
    outcome: complete ? 'completed' : view.unresolved.length ? 'uncertain' : 'blocked',
    reason: running.length ? 'Admitted operations are still settling.' : complete ? 'The declared outcome criteria have supporting evidence.' : view.unresolved.length ? 'Some possible effects remain unconfirmed. Preserve them without replay.' : readyWork.length ? 'Owned work remains available.' : 'The remaining work has a recorded blocker.',
    runningOperationIds: running.map(row => row.operationId), remainingWorkItemIds: readyWork.map(row => row.id), criteria: view.criteria, outcomes: view.outcomes, unresolved: view.unresolved, journalSeq: view.journalSeq, planEpoch: state.contract.planEpoch };
}
function descriptorValid(value) {
  if (!value || value.version !== 1 || !['observe', 'interact', 'commit', 'control', 'opaque'].includes(value.effect) || !Array.isArray(value.resources) || value.effect !== 'control' && !value.resources.length || value.resources.length > 64
      || value.resources.some(row => !row || typeof row.key !== 'string' || !row.key || row.key.length > 2048 || !['read', 'write'].includes(row.access))
      || typeof value.operationKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.operationKey)) throw fail('The host operation descriptor is unavailable; no operation was dispatched.', 'TASK_CONTRACT_DESCRIPTOR_INVALID');
  if (value.effect === 'commit' && (!value.commit || !['effectKey', 'destinationKey', 'formKey', 'documentKey', 'payloadDigest'].every(key => typeof value.commit[key] === 'string' && value.commit[key]) || !Array.isArray(value.commit.attachmentDigests))) throw fail('A recognized commit needs its actual destination/form/document and payload binding.', 'TASK_CONTRACT_COMMIT_BINDING');
  return clone(value);
}
const withinScope = (item, descriptor) => matchingWorkItemOperationScopes(item, descriptor).length > 0;
function scopedCommitHold(state, journal, item, descriptor) {
  if (!item || descriptor.effect !== 'commit') return null;
  const targets = new Set(descriptor.resources.filter(resource => !resource.scopeOnly && resource.access === 'write').map(resource => resource.key));
  const affected = new Set(state.contract.criteria.filter(criterion => item.criterionIds.includes(criterion.id) && targets.has(criterion.resourceKey)).map(criterion => criterion.id));
  if (!affected.size) return null;
  const latest = new Map();
  for (const row of currentContractJudgments(state, journal)) {
    if (row.workItemId === item.id && row.planEpoch === state.contract.planEpoch && affected.has(row.criterionId)) latest.set(row.criterionId, row);
  }
  return [...latest.values()].find(row => row.judgment === 'blocked' && row.userAgency) || null;
}
function scopeDenial(descriptor, owned, focus, eligible, ready, rows, prerequisiteRecovery) {
  const focused = owned.find(item => item.id === focus?.workItemId), targets = locks(descriptor), resources = [];
  for (const resource of targets.slice(0, 4)) {
    const entry = { key: resource.key, access: resource.access };
    if (Buffer.byteLength(JSON.stringify([...resources, entry])) > 8192) break;
    resources.push(entry);
  }
  const matching = ready.length > 1 ? ready : eligible;
  const details = {
    operation: { effect: descriptor.effect, resources, omittedResourceCount: targets.length - resources.length },
    focusedWorkItem: focused ? { id: focused.id, allowedEffects: clone(focused.effects) } : null,
    matchingWorkItemIds: matching.slice(0, 16).map(item => item.id), omittedMatchingWorkItemCount: Math.max(0, matching.length - 16),
    ...(targets.some(resource => resource.key === 'browser:relay') ? { resourceGuidance: 'Browser tab inventory uses browser:relay. For an authorized page with a known URL, open that URL directly and read it using the returned tab ID. A denied inventory does not prevent opening a page already in scope. Add inventory scope only when the task actually needs tab inventory.' } : {}),
  };
  if (ready.length > 1) return receipt('TASK_CONTRACT_FOCUS_REQUIRED', 'This operation matches several owned work items outside the current focus. Use focus with one of matchingWorkItemIds before retrying; no operation was dispatched.', { ...details, scopeReason: 'multiple-matching-work-items' });
  if (eligible.length && eligible.every(item => rows.get(item.id)?.status === 'satisfied')) return receipt('TASK_CONTRACT_OUTCOME_SATISFIED', 'The matching owned work items already have their declared outcomes. No additional commitment was dispatched.', { ...details, scopeReason: 'outcomes-already-satisfied' });
  if (eligible.length) {
    const recovery = prerequisiteRecovery(eligible);
    return receipt('TASK_CONTRACT_PREREQUISITE', 'Matching owned work items have unmet commit prerequisites. Inspect their current conditions; no operation was dispatched.', { ...details, scopeReason: 'prerequisites-not-satisfied', ...(recovery ? { recovery } : {}) });
  }
  const scopeReason = !owned.length ? 'no-owned-work-item' : owned.some(item => !workItemOperationScopes(item, descriptor.effect).length &&
    operationResourcesWithinScope(item.resourceKeys, descriptor)) ? 'effect-not-declared' : 'resource-not-covered';
  const message = scopeReason === 'no-owned-work-item' ? 'This worker has no owned work item for the operation.' : scopeReason === 'effect-not-declared'
    ? 'The requested effect is not declared by an owned work item covering these resources. Inspect the declared effects before selecting or materially revising work.'
    : 'No owned work item covers these concrete resources for the requested effect. Inspect the exact host resource identities before selecting or materially revising scoped work.';
  return receipt('TASK_CONTRACT_SCOPE', message + ' No operation was dispatched.', { ...details, scopeReason });
}
export async function createContractPlanningGuard({ store, taskId, runId, nodeId, label, signal, cwd, coordinator = true, executionGuardrails = false, onUpdated, onExecution, getOperationAdapter } = {}) {
  let state = await store.get(taskId, { signal }), delivered = null, deliveredRevision = null, finished = false;
  const registry = store.awareness, id = registry?.register(state, { runId, nodeId, label, scopeStepId: null });
  const reservations = new WeakMap(), outstanding = new Set();
  const ownerKey = observationOwnerKey(taskId, runId, nodeId), blocked = new Map();
  if (runId && executionGuardrails === true) {
    if (!blockedObservations.has(store)) blockedObservations.set(store, new Map());
    blockedObservations.get(store).set(ownerKey, blocked);
  }
  const publish = snapshot => { if (id) onUpdated?.(registry.snapshot(snapshot).workers.find(row => row.id === id)); };
  const acknowledge = snapshot => {
    if (snapshot?.taskId !== taskId || !isPlanContractTask(snapshot)) throw fail('The delivered canonical plan snapshot is invalid.', 'TASK_CONTRACT_DELIVERY_INVALID');
    delivered = { planEpoch: snapshot.contract.planEpoch, signatures: Object.fromEntries(snapshot.contract.workItems.map(item => [item.id, contractWorkItemSignature(snapshot.contract, item.id)])), revision: snapshot.revision };
    deliveredRevision = snapshot.revision;
    if (id) registry.observed(id, snapshot, { read: true }); publish(snapshot);
  };
  const acceptDelivery = createContractDeliveryTracker(taskId, snapshot => {
    if (isPlanContractTask(snapshot)) acknowledge(snapshot);
    else { deliveredRevision = snapshot.revision; if (id) registry.observed(id, snapshot, { read: true }); }
  });
  const emit = async () => { const snapshot = await store.get(taskId); await onExecution?.(snapshot.contractRuntime, snapshot); publish(snapshot); return snapshot; };
  return {
    id, contractVersion: 2,
    deliveredState: () => delivered ? clone(delivered) : { revision: deliveredRevision },
    observeDeliveredSnapshot: acknowledge,
    async before(call, context = {}) {
      const activeSignal = context.signal || signal; check(activeSignal);
      if (finished) return receipt('TASK_CONTRACT_WORKER_FINISHED', 'This worker is no longer active.');
      if (call.name === 'relay_task') {
        const args = argumentsOf(call);
        if (executionGuardrails === true && ['plan', 'artifact', 'checkpoint'].includes(args?.action) && args.expectedRevision !== deliveredRevision)
          return receipt('TASK_CONTRACT_READ_REQUIRED', 'Use the task revision actually delivered to this worker. Read the current state after a concurrent change before its next structural edit.');
        if (executionGuardrails === true && ['focus', 'assess'].includes(args?.action) && args.expectedPlanEpoch !== delivered?.planEpoch) return receipt('TASK_CONTRACT_READ_REQUIRED', 'Use the material plan epoch actually delivered to this worker before changing focus or recording a judgment.');
        return null;
      }
      const adapter = await getOperationAdapter?.(call, context), descriptor = descriptorValid(await (adapter?.describeOperation ? adapter.describeOperation(call, context) : describeHostOperation(call, { cwd, signal: activeSignal })));
      if (descriptor.effect === 'control') return null;
      let denial = null;
      await store.enqueue(taskId, async () => {
        check(activeSignal); state = (await store.load(taskId)).history.at(-1);
        const journal = await readContractJournal(store, taskId), forced = executionGuardrails === true;
        const contract = state.contract, view = contractRuntimeView(state, journal);
        if (forced && !isPlanContractTask(state)) { denial = receipt('TASK_CONTRACT_REQUIRED', 'A canonical plan must be adopted before operational work.'); return; }
        let focus = journal.focuses.find(row => sameOwner(row, runId, nodeId));
        const owned = (contract?.workItems || []).filter(item => ownerAllows(item, nodeId, coordinator));
        const eligible = owned.filter(item => withinScope(item, descriptor));
        let item = eligible.find(row => row.id === focus?.workItemId);
        const rows = new Map(view.workItems.map(row => [row.id, row])), actor = { runId, nodeId, coordinator };
        const prerequisiteRecovery = items => commitPrerequisiteRecovery(state, journal, view, items, actor);
        const ready = eligible.filter(row => ['observe', 'interact'].includes(descriptor.effect) || rows.get(row.id)?.status !== 'satisfied' && row.dependsOn.every(id => rows.get(id)?.status === 'satisfied'));
        if (!item || rows.get(item.id)?.status === 'satisfied' && descriptor.effect !== 'observe') {
          if (ready.length === 1) item = ready[0];
          else if (!focus && ready.length) item = ready[0];
        }
        if (forced && !item) {
          denial = scopeDenial(descriptor, owned, focus, eligible, ready, rows, prerequisiteRecovery);
          if (runId && descriptor.effect === 'observe' && denial.code === 'TASK_CONTRACT_SCOPE') {
            const targets = locks(descriptor);
            const key = hash(targets.map(resource => JSON.stringify([resource.key, [...(resource.scopeKeys || [])].sort()])).sort());
            blocked.delete(key);
            blocked.set(key, { effect: 'observe', resources: targets });
            if (blocked.size > LIMITS.recent) blocked.delete(blocked.keys().next().value);
          }
          return;
        }
        if (forced && ['commit', 'opaque'].includes(descriptor.effect) && rows.get(item.id)?.status === 'satisfied') { denial = receipt('TASK_CONTRACT_OUTCOME_SATISFIED', 'This work item already has its declared outcome. Preserve the confirmation and continue remaining work; no additional commitment was dispatched.'); return; }
        if (forced && (!delivered || delivered.signatures[item.id] !== contractWorkItemSignature(contract, item.id))) { denial = receipt('TASK_CONTRACT_REVIEW_REQUIRED', 'A material plan change affects this work item. Read the current canonical plan before its next operation.', { planEpoch: contract.planEpoch, workItemId: item.id }); return; }
        if (forced && ['commit', 'opaque'].includes(descriptor.effect) && item.dependsOn.some(dependency => rows.get(dependency)?.status !== 'satisfied')) {
          const recovery = prerequisiteRecovery([item]);
          denial = receipt('TASK_CONTRACT_PREREQUISITE', 'A real commit prerequisite remains unmet. Scoped observation and interaction can establish or repair the needed evidence; independent work remains available.', { workItemId: item.id, dependsOn: item.dependsOn, ...(recovery ? { recovery } : {}) }); return;
        }
        if (forced && ['commit', 'opaque'].includes(descriptor.effect)) {
          const missing = missingCurrentCommitPrerequisites(state, journal, view, runId);
          if (missing.length) {
            const recovery = assessmentRecovery(state, journal, { ...actor, criterionIds: missing });
            denial = receipt('TASK_CONTRACT_PREREQUISITE', 'Confirm the eligibility conditions with evidence observed in this run. Earlier runs cannot qualify a new commitment.', { criterionIds: missing, ...(recovery ? { recovery } : {}) }); return;
          }
        }
        if (item && (!focus || focus.workItemId !== item.id || focus.planEpoch !== contract.planEpoch)) {
          if (!focus) { focus = { runId, nodeId, generation: 0 }; journal.focuses.push(focus); }
          Object.assign(focus, { workItemId: item.id, generation: focus.generation + 1, planEpoch: contract.planEpoch, deliveredPlanEpoch: delivered?.planEpoch ?? null });
        }
        if (state.externalRecovery?.required && ['commit', 'opaque'].includes(descriptor.effect)) { denial = receipt('TASK_CONTRACT_RECOVERY_REQUIRED', 'The latest material task state was recovered from an older backup. Preserve its journal and recover the missing intent/ownership state before another commitment; independent observations remain available.'); return; }
        // Unknown effects survive plan edits, renamed items and worker turnover.
        // Observations can reconcile them; unrelated resources can progress.
        if (descriptor.effect !== 'observe') {
          const uncertainty = journal.records.find(row => effectiveEffect(row) === 'unknown' && conflicts(row, descriptor)
            || row.effect === 'commit' && effectiveEffect(row) === 'unconfirmed' && conflicts(row, descriptor));
          if (uncertainty) { const recovery = browserReceiptRecovery(state, uncertainty); denial = receipt('TASK_CONTRACT_EFFECT_UNCERTAIN', 'A conflicting possible effect needs actual observation before another write. Independent observations and resources remain available.', { operationId: uncertainty.operationId, ...(recovery ? { recovery } : {}) }); return; }
        }
        const inFlight = journal.records.find(row => active(row) && conflicts(row, descriptor));
        if (inFlight) { denial = receipt('TASK_CONTRACT_RESOURCE_BUSY', 'An admitted operation is using this resource. Independent resources remain available.', { operationId: inFlight.operationId }); return; }
        let confirmationCriterionId;
        if (descriptor.effect === 'commit') {
          const hold = forced && scopedCommitHold(state, journal, item, descriptor);
          if (hold) { denial = receipt('TASK_CONTRACT_OPERATION_HELD', hold.note, { workItemId: item.id, criterionId: hold.criterionId }); return; }
          if (item?.operationScopes) {
            confirmationCriterionId = matchedConfirmationCriterion(matchingWorkItemOperationScopes(item, descriptor));
            if (!confirmationCriterionId || !commitCriteria(contract, item, confirmationCriterionId).some(criterion => criterion.kind === 'external-confirmation')) {
              denial = receipt('TASK_CONTRACT_COMMIT_SCOPE_AMBIGUOUS', commitScopeMessage, { workItemId: item.id }); return;
            }
          }
          if (forced && missingBrowserCommitCriterion(state, item, call)) {
            denial = receipt('TASK_CONTRACT_RECEIPT_REQUIRED', browserCommitCriterionMessage, { workItemId: item.id, criterionIds: clone(item.criterionIds) });
            return;
          }
          const prior = journal.records.find(row => row.commit?.effectKey === descriptor.commit.effectKey && effectiveEffect(row) === 'confirmed');
          if (prior) { denial = receipt('TASK_CONTRACT_EFFECT_CONFIRMED', 'This exact external effect is already confirmed. Preserve its outcome instead of submitting again.', { operationId: prior.operationId }); return; }
          for (const criterion of commitCriteria(contract, item, confirmationCriterionId).filter(row => row.kind === 'external-confirmation')) {
            const result = view.criteria.find(row => row.id === criterion.id), pending = pendingCriterionEffects(journal, criterion.id, null, currentContractOperation(state));
            if ((result?.observedCount || 0) + pending.size >= (criterion.targetCount || 1)) { denial = receipt('TASK_CONTRACT_OUTCOME_PENDING', 'Existing confirmed and uncertain commitments already occupy this requested outcome count. Reconcile them before another commitment; independent observations remain available.', { criterionId: criterion.id }); return; }
          }
          const stalled = journal.progress.find(row => row.effectKey === descriptor.commit.effectKey && row.payloadDigest === descriptor.commit.payloadDigest && row.unchangedAttempts >= 2);
          if (stalled) { stalled.blocked = true; advance(journal); await saveJournal(store, taskId, journal); denial = receipt('TASK_CONTRACT_NO_PROGRESS', 'This same form payload and observed validation have already repeated without progress. Inspect or repair this item, or continue independent work. Changing plan IDs or wording does not reset the evidence.'); return; }
        }
        const callId = typeof call.callId === 'string' && call.callId ? call.callId : 'host-call-' + randomUUID();
        const priorCall = journal.records.find(row => row.runId === runId && row.nodeId === nodeId && row.callId === callId);
        if (priorCall) { denial = receipt(priorCall.operationKey === descriptor.operationKey ? 'TASK_CONTRACT_CALL_RECORDED' : 'TOOL_CALL_ID_CONFLICT', 'This callback already has a durable operation record. Recover its actual result; no operation was replayed.', { operationId: priorCall.operationId }); return; }
        if (journal.records.length >= LIMITS.records) throw fail('The operation journal reached its supported bound before admission.', 'TASK_CONTRACT_JOURNAL_LIMIT', 413);
        const operation = { operationId: 'operation-' + randomUUID(), workItemId: item?.id || 'unplanned', runId, nodeId, callId,
          ...(state.contractAdoption?.planRef?.cycleId ? { planCycleId: state.contractAdoption.planRef.cycleId } : {}),
          tool: call.name, action: argumentsOf(call)?.action || 'call', planEpoch: contract?.planEpoch || 0, leaseGeneration: focus?.generation || 0,
          journalSeq: advance(journal), deliveryState: 'reserved', effectState: descriptor.effect === 'observe' ? 'not-applicable' : 'unconfirmed',
          effect: descriptor.effect, resources: clone(descriptor.resources), operationKey: descriptor.operationKey,
          ...(descriptor.commit ? { commit: clone(descriptor.commit), criteria: clone(commitCriteria(contract, item, confirmationCriterionId)) } : {}),
          ...(confirmationCriterionId ? { confirmationCriterionId } : {}), startedAt: stamp(), pid: process.pid, evidenceIds: [] };
        journal.records.push(operation); check(activeSignal); await saveJournal(store, taskId, journal);
        live.add(operation.operationId); outstanding.add(operation.operationId); reservations.set(call, { operationId: operation.operationId, descriptor, adapter, context });
      }, activeSignal);
      return denial;
    },
    dispatchContext(call, context = {}) {
      const reservation = reservations.get(call);
      if (!reservation) return context;
      return { ...context, canonicalAdmission:true, operationDescriptor: clone(reservation.descriptor), operationId: reservation.operationId,
        onOperationDispatch: async (fresh,{onAdmission}={}) => {
          check(context.signal || signal);
          const actual = descriptorValid(fresh);
          if (actual.operationKey !== reservation.descriptor.operationKey || hash(actual.resources) !== hash(reservation.descriptor.resources)) throw fail('The observed operation changed while waiting for its resource. Reinspect the actual state; nothing was dispatched.', 'TASK_CONTRACT_DISPATCH_CHANGED');
          await store.enqueue(taskId, async () => {
            check(context.signal || signal);
            const state = (await store.load(taskId)).history.at(-1), journal = await readContractJournal(store, taskId), operation = journal.records.find(row => row.operationId === reservation.operationId);
            if (!operation || operation.deliveryState !== 'reserved') throw fail('This operation reservation is no longer dispatchable.', 'TASK_CONTRACT_DISPATCH_CONFLICT');
            const item = state.contract?.workItems.find(item => item.id === operation.workItemId);
            if (executionGuardrails && (!item || !ownerAllows(item, nodeId, coordinator) || !withinScope(item, actual) || delivered?.signatures[item.id] !== contractWorkItemSignature(state.contract, item.id))) throw fail('A relevant material-plan change invalidated this queued operation. Read the current task; nothing was dispatched.', 'TASK_CONTRACT_REVIEW_REQUIRED');
            const view = contractRuntimeView(state, journal), rows = new Map(view.workItems.map(row => [row.id, row]));
            if (executionGuardrails && ['commit', 'opaque'].includes(actual.effect)) {
              if (rows.get(item.id)?.status === 'satisfied') throw fail('The requested work-item outcome was established while this operation waited. Nothing further was dispatched.', 'TASK_CONTRACT_OUTCOME_SATISFIED');
              if (item.dependsOn.some(dependency => rows.get(dependency)?.status !== 'satisfied')) throw fail('Current evidence no longer establishes a commit prerequisite. Scoped observation and repair remain available; nothing was dispatched.', 'TASK_CONTRACT_PREREQUISITE');
              if (missingCurrentCommitPrerequisites(state, journal, view, runId).length) throw fail('Eligibility conditions still need evidence observed in this run. Nothing was dispatched.', 'TASK_CONTRACT_PREREQUISITE');
            }
            if (state.externalRecovery?.required && ['commit', 'opaque'].includes(actual.effect)) throw fail('Recover the missing material intent before this commitment. Nothing was dispatched.', 'TASK_CONTRACT_RECOVERY_REQUIRED');
            const others = journal.records.filter(row => row.operationId !== operation.operationId);
            if (actual.effect !== 'observe' && others.some(row => (effectiveEffect(row) === 'unknown' || row.effect === 'commit' && effectiveEffect(row) === 'unconfirmed') && conflicts(row, actual))) throw fail('A conflicting possible effect appeared while this operation waited. Observe it before another write; nothing was dispatched.', 'TASK_CONTRACT_EFFECT_UNCERTAIN');
            if (others.some(row => active(row) && conflicts(row, actual))) throw fail('Another admitted operation is using this resource. Nothing was dispatched.', 'TASK_CONTRACT_RESOURCE_BUSY');
            if (actual.effect === 'commit') {
              const hold = executionGuardrails && scopedCommitHold(state, journal, item, actual);
              if (hold) throw fail(hold.note, 'TASK_CONTRACT_OPERATION_HELD');
              if (operation.confirmationCriterionId || item?.operationScopes) {
                const confirmationCriterionId = matchedConfirmationCriterion(matchingWorkItemOperationScopes(item, actual));
                if (!confirmationCriterionId || confirmationCriterionId !== operation.confirmationCriterionId)
                  throw fail(commitScopeMessage, 'TASK_CONTRACT_COMMIT_SCOPE_AMBIGUOUS');
              }
              if (executionGuardrails === true && missingBrowserCommitCriterion(state, item, call)) throw fail(browserCommitCriterionMessage, 'TASK_CONTRACT_RECEIPT_REQUIRED');
              if (others.some(row => row.commit?.effectKey === actual.commit.effectKey && effectiveEffect(row) === 'confirmed')) throw fail('This exact external effect was confirmed while the operation waited. Nothing was repeated.', 'TASK_CONTRACT_EFFECT_CONFIRMED');
              for (const criterion of commitCriteria(state.contract, item, operation.confirmationCriterionId).filter(row => row.kind === 'external-confirmation')) {
                const result = view.criteria.find(row => row.id === criterion.id), pending = pendingCriterionEffects(journal, criterion.id, operation.operationId, currentContractOperation(state));
                if ((result?.observedCount || 0) + pending.size >= (criterion.targetCount || 1)) throw fail('Other confirmed or pending commitments now occupy the requested outcome count. This reservation was not dispatched.', 'TASK_CONTRACT_OUTCOME_PENDING');
              }
              if (journal.progress.some(row => row.effectKey === actual.commit.effectKey && row.payloadDigest === actual.commit.payloadDigest && row.unchangedAttempts >= 2)) throw fail('The same payload and observed validation have already repeated without progress. Nothing was dispatched.', 'TASK_CONTRACT_NO_PROGRESS');
            }
            // Host-only shared admission runs under this same canonical source lock.
            if(onAdmission)await onAdmission({state:clone(state),operation:clone(operation)});
            operation.deliveryState = 'dispatched'; operation.dispatchedAt = stamp(); operation.journalSeq = advance(journal);
            await saveJournal(store, taskId, journal);
          }, context.signal || signal);
        } };

    },
    async dispatchFallback(call, context) { const reservation = reservations.get(call); if (reservation && !reservation.adapter?.describeOperation) await context.onOperationDispatch?.(reservation.descriptor); },
    after(call, result) { return result; },
    observeToolDelivery({ call, result }) {
      if (finished || !['relay_task', 'relay_delegate'].includes(call?.name)) return null;
      return acceptDelivery(result);
    },
    async annotate(call, result, { uncertain = false } = {}) {
      const reservation = reservations.get(call); if (!reservation) return result;
      reservations.delete(call);
      let saved = false, operation, normalizationError;
      try {
        let observed;
        if (!uncertain) {
          const current = (await store.load(taskId)).history.at(-1), journal = await readContractJournal(store, taskId), own = journal.records.find(row => row.operationId === reservation.operationId);
          const item = current.contract?.workItems.find(row => row.id === own?.workItemId);
          evaluation(current, journal); // Validate retained immutable evidence before using it to correlate another receipt.
          const evidenceById = new Map(journal.evidence.map(evidence => [evidence.id, evidence]));
          const commitments = journal.records.filter(row => row.commit).map(row => {
            const evidence = [...new Set([...row.evidenceIds, ...(row.reconciliationEvidenceIds || [])])].map(id => {
              const retained = evidenceById.get(id);
              if (!retained) throw fail('A commitment refers to unavailable retained evidence. Preserve its effect identity until the journal is reconciled.', 'TASK_CONTRACT_JOURNAL_DAMAGED', 500);
              return clone(retained);
            });
            return { operationId: row.operationId, workItemId: row.workItemId, runId: row.runId, nodeId: row.nodeId, deliveryState: row.deliveryState, effectState: effectiveEffect(row), startedAt: row.startedAt, ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}), resources: clone(row.resources), commit: clone(row.commit), evidence,
              ...(row.confirmationCriterionId ? { confirmationCriterionId: row.confirmationCriterionId } : {}) };
          });
          const criteria = [...(current.contract?.criteria.filter(criterion => item?.criterionIds.includes(criterion.id)) || []), ...journal.records.filter(row => row.commit).flatMap(row => row.criteria || [])];
          const uniqueCriteria = [...new Map(criteria.map(criterion => [hash(criterion), criterion])).values()];
          const context = { ...reservation.context, call, descriptor: reservation.descriptor, cwd, criteria: uniqueCriteria, commitments };
          try { observed = await (reservation.adapter?.normalizeOperationResult ? reservation.adapter.normalizeOperationResult(result, context) : normalizeHostOperationResult(result, context)); } catch (error) { normalizationError = { code: error.code || 'TASK_CONTRACT_VERIFICATION_UNAVAILABLE', message: String(error.message || error).slice(0, 500) }; observed = { effectState: reservation.descriptor.effect === 'observe' ? 'not-applicable' : 'unknown', evidence: [] }; }
        }
        await store.enqueue(taskId, async () => {
          const journal = await readContractJournal(store, taskId); operation = journal.records.find(row => row.operationId === reservation.operationId);
          if (!operation || !['reserved','dispatched'].includes(operation.deliveryState)) throw fail('The admitted operation record changed before settlement.', 'TASK_CONTRACT_RECEIPT_CONFLICT');
          const notDispatched = operation.deliveryState === 'reserved', previouslyReconciled = reconciledEffect(operation);
          operation.deliveryState = notDispatched ? 'cancelled-before-dispatch' : uncertain ? 'interrupted' : 'returned'; operation.finishedAt = stamp(); operation.success = result?.success === true;
          if (result?.code) operation.code = String(result.code).slice(0, 100);
          operation.resultDigest = hash(result);
          if (normalizationError) operation.verificationError = normalizationError;
          operation.effectState = notDispatched ? operation.effect === 'observe' ? 'not-applicable' : 'absent' : previouslyReconciled || (uncertain ? operation.effect === 'observe' ? 'not-applicable' : 'unknown' : observed?.effectState || (operation.effect === 'observe' ? 'not-applicable' : 'unconfirmed'));
          for (const input of observed?.evidence || []) {
            const evidence = normalizeContractEvidence(input, { operationId: operation.operationId, workItemId: operation.workItemId, at: operation.finishedAt });
            const prior = journal.evidence.find(row => row.id === evidence.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(evidence)) throw fail('An immutable evidence identity conflicts with saved content.', 'TASK_CONTRACT_EVIDENCE_CONFLICT');
            if (!prior) journal.evidence.push(evidence);
            operation.evidenceIds.push(evidence.id);
            if (evidence.confirmation?.effectKey) {
              for (const earlier of journal.records.filter(row => row.commit?.effectKey === evidence.confirmation.effectKey)) {
                earlier.effectState = evidence.confirmation.status === 'confirmed' ? 'confirmed' : 'absent';
                earlier.reconciliationEvidenceIds = [...new Set([...(earlier.reconciliationEvidenceIds || []), evidence.id])];
                retainRejection(earlier, evidence);
              }
            }
          }
          refreshProgress(journal);
          operation.journalSeq = advance(journal); await saveJournal(store, taskId, journal); saved = true;
        });
        live.delete(reservation.operationId); outstanding.delete(reservation.operationId);
        const snapshot = await emit();
        let recovery = browserReceiptRecovery(snapshot, operation);
        if (!recovery && call.name === 'relay_browser' && !call.namespace && snapshot.contractRuntime?.unresolved?.length
            && (reservation.descriptor.effect === 'observe' || result?.code === 'TASK_CONTRACT_EFFECT_UNCERTAIN')) {
          const journal = await readContractJournal(store, taskId);
          const unresolved = journal.records.find(row => row.tool === 'relay_browser' && row.commit
            && ['unknown', 'unconfirmed'].includes(effectiveEffect(row)) && conflicts(row, reservation.descriptor));
          recovery = browserReceiptRecovery(snapshot, unresolved);
        }
        return { ...result, contentItems: [...(result?.contentItems || []), { type: 'inputText', text: JSON.stringify({ type: 'planning.operation', operationId: operation.operationId, workItemId: operation.workItemId, planEpoch: operation.planEpoch, journalSeq: snapshot.contractRuntime?.journalSeq,
          deliveryState: operation.deliveryState, effectState: operation.effectState, evidenceIds: operation.evidenceIds, ...(normalizationError ? { verificationError: normalizationError } : {}),
          ...(recovery ? { recovery } : {}),
          note: recovery ? (recovery.reason === 'receipt-criterion-required'
            ? 'The retained submission outcome is still uncertain. Resolve the original receipt criterion before attempting to bind a receipt. Do not submit again.'
            : 'The retained submission outcome is still uncertain. Use bind_receipt for the observed mapping, then read the same response. A tool return or a visible message alone does not establish the outcome.')
            : 'The host recorded this actual operation. Continue cohesive work within the same scope; no per-operation plan edit or completion call is required. Tool return does not by itself establish the requested external outcome.' }) }] };
      } catch (error) {
        live.delete(reservation.operationId); outstanding.delete(reservation.operationId);
        return { ...result, contentItems: [...(result?.contentItems || []), { type: 'inputText', text: JSON.stringify({ type: 'planning.execution-warning', code: saved ? 'TASK_CONTRACT_PROJECTION_UNAVAILABLE' : 'TASK_CONTRACT_RECEIPT_UNCERTAIN', operationId: reservation.operationId,
          note: 'The actual tool result is preserved. Its operation receipt or current projection could not be fully saved; reconcile this possible effect before any conflicting replay.', error: String(error?.message || error).slice(0, 500) }) }] };
      }
    },
    async completion() { const current = await store.get(taskId); return contractCompletionStatus(current, await readContractJournal(store, taskId)); },
    finish(status) {
      finished = true;
      for (const operationId of outstanding) live.delete(operationId);
      const pending = blockedObservations.get(store);
      if (pending?.get(ownerKey) === blocked) pending.delete(ownerKey);
      if (id) registry.finish(id, status);
    },
  };
}

// Track observations without treating a new call ID, focus change or repeated
// delivery of the same source as progress. This affects only continuation,
// never the evidence needed for completion or the guard against replay.
function observationProgress(state, journal, nodeId, coordinator, throughSequence = Infinity) {
  const owned = new Set((state.contract?.workItems || []).filter(item => !nodeId || coordinator || ownerAllows(item, nodeId, coordinator)).map(item => item.id));
  const currentOperation = currentContractOperation(state);
  const delivered = new Map(journal.records.filter(row => (!currentOperation || currentOperation(row)) && row.effect === 'observe' && row.deliveryState === 'returned'
    && row.success === true && row.dispatchedAt && !row.verificationError && row.journalSeq <= throughSequence && owned.has(row.workItemId))
    .map(row => [row.operationId, { workItemId: row.workItemId, evidenceIds: new Set(row.evidenceIds) }]));
  const sources = new Set(), coverage = new Map();
  for (const evidence of journal.evidence) {
    const operation = delivered.get(evidence.operationId);
    if (!operation || operation.workItemId !== evidence.workItemId || !operation.evidenceIds.has(evidence.id)
      || !['observation', 'source-coverage'].includes(evidence.kind)) continue;
    const source = evidence.validation?.browserProgress || JSON.stringify([evidence.resourceKey, evidence.sourceVersion ?? evidence.digest]);
    const range = evidence.coverage;
    if (!range) sources.add(source);
    else if (range.start < range.end) {
      const key = JSON.stringify([source, range.unit, range.total]);
      if (!coverage.has(key)) coverage.set(key, []);
      coverage.get(key).push([range.start, range.end]);
    }
  }
  const ranges = [...coverage.keys()].sort().map(key => {
    const merged = [];
    for (const [start, end] of coverage.get(key).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    return [key, merged];
  });
  return { sources: [...sources].sort(), ranges };
}

function firstWorkspaceCommandResult(state, journal, runId, eligible) {
  const currentOperation = currentContractOperation(state);
  const outputs = new Map(journal.evidence.filter(row => row.kind === 'observation' && row.validation?.workspaceCommandOutput === true).map(row => [row.id, row]));
  let first;
  for (const row of journal.records) {
    if (row.runId !== runId || currentOperation && !currentOperation(row) || !eligible.has(row.workItemId) ||
        row.tool !== 'relay_workspace' || row.action !== 'run' || row.effect !== 'opaque' || row.effectState !== 'confirmed' ||
        row.deliveryState !== 'returned' || row.success !== true || !row.dispatchedAt || row.verificationError) continue;
    const hasOutput = row.evidenceIds.some(id => {
      const evidence = outputs.get(id);
      return evidence?.operationId === row.operationId && evidence.workItemId === row.workItemId;
    });
    if (hasOutput && (!first || row.journalSeq < first.journalSeq)) first = row;
  }
  return first;
}

// A material edit helps only if it opens a specific, previously denied host
// observation. This tracks opportunity, not a receipt or permission to dispatch.
function repairedObservationScopes(blocked, state, journal, status, runId, nodeId, coordinator) {
  const repaired = new Map();
  if (!blocked?.size) return repaired;
  const remaining = new Set(status.remainingWorkItemIds);
  const owned = state.contract.workItems.filter(item => ownerAllows(item, nodeId, coordinator));
  const focus = journal.focuses.find(row => sameOwner(row, runId, nodeId));
  for (const [key, descriptor] of blocked) {
    const eligible = owned.filter(item => withinScope(item, descriptor));
    const item = eligible.find(item => item.id === focus?.workItemId)
      || (!focus || eligible.length === 1 ? eligible[0] : null);
    if (!item) continue;
    blocked.delete(key);
    const matched = matchingWorkItemOperationScopes(item, descriptor).flatMap(scope => scope.resourceKeys);
    if (!remaining.has(item.id) || matched.includes('discovery')) continue;
    const scopes = new Set(descriptor.resources.flatMap(resource => [resource.key, ...(resource.scopeKeys || [])]));
    repaired.set(key, [...new Set(matched.filter(scope => scopes.has(scope)))]);
  }
  return repaired;
}

export function createContractCompletionController({ store, taskId, runId, nodeId, coordinator = true, signal, beforeCheck = async () => {}, onState = () => {}, onUpdate = () => {}, onReturn = () => {}, maxReturns = 4, maxObservationReturns = maxReturns, persistentGoal = false } = {}) {
  let returns = 0, previous = null, previousJournalSeq = 0, consecutiveStalls = 0;
  const seenProgress = new Set();
  let recoveryOffered = false, commandResultOffered = false, blockerReviewed = false;
  const ownerKey = observationOwnerKey(taskId, runId, nodeId), repairedTargets = new Set(), repairedScopes = new Set();
  const inspect = async () => {
    check(signal); await beforeCheck(); check(signal);
    const state = await store.get(taskId, { signal }), journal = await readContractJournal(store, taskId);
    const status = contractCompletionStatus(state, journal, { nodeId, coordinator }); onState(state); return { status, state, journal };
  };
  return {
    async beforeFinal() {
      const { status, state, journal } = await inspect();
      const publish = (reviewStatus, update) => onUpdate({ ...update, ...(persistentGoal ? {
        reviewStatus, reviewReason: update.reviewReason ?? status.reason, persistentGoal: true,
        goalStatus: status.complete ? 'complete' : reviewStatus === 'stalled' ? 'stalled'
          : status.ready && reviewStatus !== 'checking_blocker' ? 'blocked' : 'active',
      } : {}) });
      if (status.ready) {
        if (persistentGoal && !status.complete && !blockerReviewed) {
          const unmet = new Set(status.criteria.filter(row => !row.satisfied).map(row => row.id));
          const owned = new Set(state.contract.workItems.filter(item => !nodeId || ownerAllows(item, nodeId, coordinator)).map(item => item.id));
          const latest = new Map();
          for (const judgment of currentContractJudgments(state, journal)) {
            if (judgment.planEpoch === status.planEpoch && owned.has(judgment.workItemId) && unmet.has(judgment.criterionId))
              latest.set(JSON.stringify([judgment.workItemId, judgment.criterionId]), judgment);
          }
          const blockers = [...latest.values()].filter(judgment => judgment.judgment === 'blocked').slice(-4);
          if (blockers.length) {
            blockerReviewed = true;
            returns++; onReturn(); publish('checking_blocker', { ...status, status: 'continuing', contractVersion: 2, returnCount: returns });
            const report = blockers.map(({ criterionId, workItemId, note, evidenceIds }) => ({ criterionId, workItemId, note, evidenceIds }));
            return { continue: true, prompt: 'Check these proposed blockers against the original request and governing sources before ending this goal. Read the applicable source passage if your assessment only cites the observed case. Distinguish a supported contradiction from a missing fact, and determine whether any stated condition for the requirement applies in this case. If the blocker is unsupported, correct the recorded judgment and continue authorized work. If it holds, preserve the evidence and report it. Reuse any existing receipts without repeating an external action.\n' + JSON.stringify(report) };
          }
        }
        publish('current', { status: 'ready', contractVersion: 2, ...status }); return null;
      }
      const observations = observationProgress(state, journal, nodeId, coordinator);
      const signature = hash({
        criteria: persistentGoal
          ? status.criteria.filter(row => row.observedCount).map(row => row.observedCount).sort((a, b) => a - b)
          : status.criteria.map(row => ({ id: row.id, satisfied: row.satisfied, observedCount: row.observedCount, targetCount: row.targetCount })),
        outcomes: status.outcomes.map(row => ({ resourceKey: row.resourceKey, outcomeId: row.outcomeId, effectKey: row.effectKey, status: row.status, prior: row.prior, isNew: row.isNew })),
        unresolved: status.unresolved.map(row => ({ effectState: row.effectState, resources: row.resources, effectKey: row.commit?.effectKey })),
        ...(!persistentGoal ? { remaining: [...status.remainingWorkItemIds].sort(), running: status.runningOperationIds.length } : {}),
        observations,
      });
      const settled = !status.unresolved.length && !status.runningOperationIds.length;
      const repairs = repairedObservationScopes(blockedObservations.get(store)?.get(ownerKey), state, journal, status, runId, nodeId, coordinator);
      let freshScopeRepair = false;
      for (const [target, scopes] of repairs) {
        if (settled && !repairedTargets.has(target) && scopes.some(scope => !repairedScopes.has(scope))) freshScopeRepair = true;
        repairedTargets.add(target);
        for (const scope of scopes) repairedScopes.add(scope);
      }
      // Control calls and unrelated plan edits cannot extend the ordinary cap.
      const withinProgressBudget = returns >= maxReturns && returns < maxObservationReturns && settled
        && (freshScopeRepair || hash(observations) !== hash(observationProgress(state, journal, nodeId, coordinator, previousJournalSeq)));
      // A goal is a completion condition, not a fixed count of model replies.
      // Repeated or alternating states cannot reset the goal's stall check.
      const repeated = (persistentGoal ? seenProgress.has(signature) : signature === previous) && !freshScopeRepair;
      consecutiveStalls = repeated ? consecutiveStalls + 1 : 0;
      const stalled = consecutiveStalls >= (persistentGoal ? 2 : 1);
      const pendingCriteria = status.criteria.filter(row => !row.satisfied);
      const remaining = new Set(status.remainingWorkItemIds);
      const eligible = persistentGoal && stalled && settled ? state.contract.workItems.filter(item =>
        remaining.has(item.id) && (!nodeId || ownerAllows(item, nodeId, coordinator))
        && pendingCriteria.some(row => item.criterionIds.includes(row.id))) : [];
      // One chance to use newly returned command output. Its raw digest and
      // arbitrary command text never count as progress or reset stall checks.
      const firstCommandResult = !commandResultOffered && eligible.length ? firstWorkspaceCommandResult(state, journal, runId, new Set(eligible.map(item => item.id))) : null;
      const commandResult = firstCommandResult?.journalSeq > previousJournalSeq ? firstCommandResult : null;
      const recoverable = !commandResult && !recoveryOffered && eligible[0];
      const stopReason = stalled && !recoverable && !commandResult ? 'no_new_progress'
        : !persistentGoal && returns >= maxReturns && !withinProgressBudget ? 'continuation_limit' : null;
      if (stopReason) {
        const reason = stopReason === 'no_new_progress' ? 'No new host-observed progress was recorded.' : 'The run reached its continuation limit.';
        publish('stalled', { ...status, status: 'stalled', contractVersion: 2, returnCount: returns, stopReason,
          reviewReason: status.reason + ' ' + reason });
        throw fail(status.reason + ' ' + reason + ' The requested outcome is not established; saved operations and uncertainty remain available.', 'TASK_CONTRACT_INCOMPLETE');
      }
      previous = signature; previousJournalSeq = journal.journalSeq;
      if (persistentGoal) seenProgress.add(signature);
      returns++; onReturn(); publish('continuing', { status: 'continuing', contractVersion: 2, returnCount: returns, ...status });
      const scopeGuidance = freshScopeRepair ? '\nThe updated scope now permits a previously blocked observation for remaining work.' : '';
      let workRecovery = '';
      if (commandResult) {
        commandResultOffered = true;
        workRecovery = '\nA workspace command just returned output for the unfinished work. Use that result to inspect or verify its concrete output, assess the applicable criterion, or take the next authorized step. Do not rerun the command.'
          + '\n' + JSON.stringify({ operationId: commandResult.operationId, workItemId: commandResult.workItemId });
      } else if (recoverable) {
        recoveryOffered = true;
        const unmet = pendingCriteria.filter(row => recoverable.criterionIds.includes(row.id)).map(row => {
          const criterion = state.contract.criteria.find(item => item.id === row.id);
          return { id: row.id, description: criterion.description, evidenceNeeded: criterion.accuracy?.evidenceNeeded, reason: row.reason };
        });
        const denied = [...(blockedObservations.get(store)?.get(ownerKey)?.values() || [])].slice(-3)
          .flatMap(row => row.resources.map(({ key }) => key));
        workRecovery = '\nThe previous pass repeated work. Try a different concrete observation or establish a specific blocker for this remaining item. Do not repeat a prior read or submission unchanged.\n'
          + JSON.stringify({ workItem: recoverable.id, objective: recoverable.objective, resources: recoverable.resourceKeys, unmet, denied });
      }
      const unresolvedIds = new Set(status.unresolved.map(operation => operation.operationId));
      const ownedItems = new Set(state.contract?.workItems.filter(item => !nodeId || ownerAllows(item, nodeId, coordinator)).map(item => item.id));
      const pendingBrowser = journal.records.findLast(operation => unresolvedIds.has(operation.operationId)
        && ownedItems.has(operation.workItemId) && operation.tool === 'relay_browser' && operation.effect === 'commit' && operation.commit);
      const recovery = browserReceiptRecovery(state, pendingBrowser);
      const nextAction = recovery
        ? '\nUse the tools to reconcile this exact retained browser submission before returning. If the receipt is already visible, save its observed binding now and then re-read the same response. Do not submit again.\n' + JSON.stringify(recovery)
        : '\nContinue useful owned work, observe unresolved effects before replay, or record a real judgment blocker. Routine tool returns already have host receipts; do not create per-operation planning leaves.';
      const progress = persistentGoal ? {
        goal: state.contract.goal, planEpoch: status.planEpoch, remainingWorkItemIds: status.remainingWorkItemIds,
        pending: pendingCriteria.map(({ id, observedCount, targetCount }) => ({ id, observedCount, targetCount })),
        unresolvedCount: status.unresolved.length,
      } : status;
      const goalGuidance = persistentGoal ? 'The adopted goal remains active. Continue this same request until the evidence establishes the outcome or a specific blocker prevents useful work. ' : '';
      return { continue: true, prompt: goalGuidance + 'The host has not established completion. ' + status.reason + '\n' + JSON.stringify(progress) + scopeGuidance + nextAction + workRecovery };
    },
    async assertReady() { const { status } = await inspect(); if (!status.ready) throw fail(status.reason, 'TASK_CONTRACT_INCOMPLETE'); return status; },
  };
}
