import { createHash } from 'node:crypto';
import { normalizePlanContract, contractPlanProjection } from '../public/planning-contract-model.mjs';
import { evaluateContractCriteria } from './planning-contract-evidence.mjs';
import { currentContractJudgments, currentContractOperation } from './planning-contract-runtime.mjs';

export const canonicalContractHash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const fail = message => Object.assign(new Error(message), { code: 'TASK_CONTRACT_CYCLE_BINDING', status: 409 });
const sameRef = (a, b) => a && b && ['requestId', 'cycleId', 'nodeId', 'nodeRevision', 'responseId'].every(key => a[key] === b[key]);
const source = (id, title, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { id, title, kind: 'tool_receipt', text, contentHash: textHash(text) };
};
const SOURCE_LIMIT = 38000;

function sourcesFor(data) {
  const id = `cycle:execution:${data.planRef.cycleId}:canonical-contract`;
  const text = JSON.stringify(data);
  if (text.length <= SOURCE_LIMIT) return [source(id, 'Current canonical task and observed outcomes', text)];
  // Source-sized chunks preserve exact data. This is not truncation or a claim
  // that an omitted portion was inspected. The normal total-context gate stays.
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = parts.length;
    if (index >= 120) throw fail('The canonical review evidence exceeds the bounded source catalog.');
    const body = count => ({ kind: 'canonical-task-contract-part', version: 1, taskId: data.taskId, runId: data.runId,
      planEpoch: data.planEpoch, journalSeq: data.journalSeq, index, text: text.slice(cursor, cursor + count) });
    let low = 1, high = Math.min(SOURCE_LIMIT, text.length - cursor);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(body(middle)).length <= SOURCE_LIMIT) low = middle; else high = middle - 1;
    }
    parts.push(source(`${id}:part:${index}`, `Canonical task evidence · part ${index + 1}`, body(low)));
    cursor += low;
  }
  const manifest = source(id, 'Current canonical task evidence manifest', {
    kind: 'canonical-task-contract-manifest', version: 1, taskId: data.taskId, runId: data.runId, planRef: data.planRef,
    planEpoch: data.planEpoch, journalSeq: data.journalSeq, contractSha256: data.contractSha256,
    dataSha256: textHash(text), dataChars: text.length,
    parts: parts.map((part, index) => ({ id: part.id, index, contentHash: part.contentHash })),
  });
  return [manifest, ...parts];
}

/** Called on an atomic host task/journal snapshot, never on a model projection. */
export function buildCanonicalCycleEvidence({ run, taskState, journal, planRef, acceptedPlan, runningOperationIds = [] }) {
  const taskId = run.taskId || run.id;
  if (run.planningContractVersion !== 14 || taskState?.taskId !== taskId || journal?.taskId !== taskId || journal.version !== 3) {
    throw fail('The canonical review must use this run’s actual versioned task and journal.');
  }
  const adoption = taskState.contractAdoption;
  if (!adoption || adoption.version !== 1 || adoption.contractVersion !== 2 || adoption.taskId !== taskId ||
      !sameRef(adoption.planRef, planRef) || adoption.sourceSha256 !== canonicalContractHash(acceptedPlan) ||
      adoption.acceptedContractSha256 !== canonicalContractHash(normalizePlanContract(acceptedPlan?.contract))) {
    throw fail('The current task does not retain the exact accepted Plan authoring provenance.');
  }
  const contract = normalizePlanContract(taskState.contract, { allowEpoch: true });
  if (!Number.isSafeInteger(contract.planEpoch) || !Number.isSafeInteger(journal.journalSeq) || journal.journalSeq < 0 ||
      !Array.isArray(journal.records) || !Array.isArray(journal.findings) || !Array.isArray(journal.judgments)) throw fail('The canonical review snapshot is incomplete.');
  const currentOperation = currentContractOperation(taskState), judgments = currentContractJudgments(taskState, journal);
  const evaluated = evaluateContractCriteria(contract, journal.evidence, { judgments, operations: journal.records, currentOperation });
  const operations = new Map(journal.records.map(record => [record.operationId, record]));
  if (operations.size !== journal.records.length) throw fail('Operation identities are not unique in the canonical review.');
  for (const observed of journal.evidence) {
    const operation = operations.get(observed.operationId);
    if (!operation || operation.workItemId !== observed.workItemId || !operation.evidenceIds?.includes(observed.id)) {
      throw fail('An observation is not bound to its actual admitted operation.');
    }
  }
  const running = new Set(runningOperationIds);
  if ([...running].some(id => !operations.has(id))) throw fail('The active operation projection names an unknown admission.');
  const observedById = new Map(journal.evidence.map(record => [record.id, record]));
  const reconciled = record => record.reconciliationEvidenceIds?.some(id => {
    const confirmation = observedById.get(id)?.confirmation;
    return confirmation && record.commit?.effectKey === confirmation.effectKey && record.effectState === confirmation.status;
  });
  const unresolved = journal.records.filter(record => {
    if (currentOperation && !currentOperation(record)) return false;
    if (running.has(record.operationId)) return true;
    // The host persists dispatched before invoking an adapter. A reservation
    // without a live owner therefore records no dispatched effect.
    if (record.deliveryState === 'reserved') return false;
    return record.deliveryState === 'dispatched' && record.effect !== 'observe' && !reconciled(record) ||
      record.effectState === 'unknown' || record.effect === 'commit' && record.effectState === 'unconfirmed';
  }).map(record => ({
      operationId: record.operationId, workItemId: record.workItemId, deliveryState: record.deliveryState, effectState: record.effectState,
      ...(record.commit ? { effectKey: record.commit.effectKey, destinationKey: record.commit.destinationKey } : {}),
    }));
  const used = new Set(evaluated.criteria.flatMap(criterion => criterion.evidenceIds));
  const latestJudgments = new Map();
  for (const row of judgments) if (row.planEpoch === contract.planEpoch) latestJudgments.set(JSON.stringify([row.workItemId, row.criterionId]), row);
  const blockers = [...latestJudgments.values()].filter(row => row.judgment === 'blocked' && evaluated.criteria.some(criterion => criterion.id === row.criterionId && !criterion.satisfied))
    .map(({ criterionId, note, evidenceIds }) => ({ criterionId, note, evidenceIds }));
  for (const blocker of blockers) for (const id of blocker.evidenceIds) used.add(id);
  for (const finding of journal.findings) for (const id of finding.evidenceIds || []) used.add(id);
  const evidence = journal.evidence.filter(record => used.has(record.id));
  const operationIds = new Set(evidence.map(record => record.operationId));
  const data = {
    kind: 'canonical-task-contract', version: 1, taskId, runId: run.id, planRef: clone(planRef),
    taskRevision: taskState.revision, planEpoch: contract.planEpoch, journalSeq: journal.journalSeq,
    contractSha256: canonicalContractHash(contract), authoringSourceSha256: adoption.sourceSha256,
    contract, acceptanceCriteria: contractPlanProjection(contract).acceptanceCriteria,
    criteria: clone(evaluated.criteria), outcomes: clone(evaluated.outcomes), unresolved,
    complete: evaluated.criteria.length > 0 && evaluated.criteria.every(criterion => criterion.satisfied) && unresolved.length === 0,
    evidence: clone(evidence), findings: clone(journal.findings), ...(blockers.length ? { blockers } : {}),
    operations: journal.records.filter(record => operationIds.has(record.operationId)).map(record => ({
      operationId: record.operationId, workItemId: record.workItemId, runId: record.runId, nodeId: record.nodeId,
      callId: record.callId, tool: record.tool, action: record.action, planEpoch: record.planEpoch,
      deliveryState: record.deliveryState, effectState: record.effectState, evidenceIds: clone(record.evidenceIds),
    })),
    note: 'This is the current canonical task and host-evaluated evidence. The original Plan response remains immutable authoring provenance. Exact observed receipt fields are interpreted under the declared criterion; a click, a judgment, or a historical receipt is not a new confirmed outcome.',
  };
  const external = new Set(contract.criteria.filter(criterion => criterion.kind === 'external-confirmation').map(criterion => criterion.id));
  data.receiptBindings = evaluated.criteria.filter(criterion => external.has(criterion.id) && criterion.satisfied).map(criterion => ({
    id: 'effect-contract-' + canonicalContractHash([run.id, planRef, data.contractSha256, journal.journalSeq, criterion.id, criterion.evidenceIds]).slice(0, 40),
    criterionIds: [criterion.id],
  }));
  const sources = sourcesFor(data), proof = sources[0];
  const effectReceipts = data.receiptBindings.map(binding => ({
    ...binding, state: 'succeeded', effectVerified: true, sourceId: proof.id,
    runId: run.id, planRef: clone(planRef), proofSha256: proof.contentHash,
    canonicalContract: { taskId, planEpoch: contract.planEpoch, journalSeq: journal.journalSeq, contractSha256: data.contractSha256 },
  }));
  return { data, sources, effectReceipts };
}

/** A bounded fallback from the host snapshot, without republishing worker claims. */
export function canonicalOutcomeSummary(data, limitation) {
  const lines = [];
  const line = (value, max = 220) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (data?.kind === 'canonical-task-contract' && Array.isArray(data.criteria) && Array.isArray(data.contract?.criteria)) {
    const supported = data.criteria.filter(criterion => criterion.satisfied === true).length;
    lines.push(`${supported} of ${data.criteria.length} completion criteria are supported by the current record.`);
    const authored = new Map(data.contract.criteria.map(criterion => [criterion.id, criterion]));
    const blockers = new Map((data.blockers || []).map(blocker => [blocker.criterionId, blocker.note]));
    for (const criterion of data.criteria) {
      const definition = authored.get(criterion.id);
      const unit = definition?.kind === 'external-confirmation' ? 'new confirmed outcomes' :
        definition?.kind === 'source-coverage' ? 'required sources with complete observed coverage' :
        definition?.kind === 'observation' ? 'required observed resources' : 'supported assessments';
      const blocker = blockers.get(criterion.id);
      const label = line(definition?.label || definition?.description || criterion.id);
      lines.push(blocker ? `- ${label}. ${line(blocker, 1000)}` : `- ${label}: ${criterion.observedCount} of ${criterion.targetCount} ${unit}.`);
    }
    if (data.unresolved?.length) lines.push(`${data.unresolved.length} operation${data.unresolved.length === 1 ? ' remains' : 's remain'} unsettled or unverified.`);
    if (data.findings?.length) {
      lines.push(`Recorded instruction findings (${data.findings.length}):`);
      for (const finding of data.findings.slice(0, 8)) lines.push(`- ${line(finding.ruleId, 120)}: ${line(finding.message, 2000)}`);
      if (data.findings.length > 8) lines.push(`${data.findings.length - 8} additional findings are preserved in the task record.`);
    }
  } else lines.push('The operational records are preserved. A current verified outcome summary is unavailable.');
  lines.push(line(limitation, 2000));
  return lines.filter(Boolean).join('\n\n');
}
