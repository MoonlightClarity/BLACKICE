import { normalizePlanContract, contractPlanProjection } from './planning-contract-model.mjs';

const sameRef = (a, b) => a && b && ['requestId', 'cycleId', 'nodeId', 'nodeRevision', 'responseId'].every(key => a[key] === b[key]);

/** Public projection only. The host revalidates its journal before publishing. */
export function canonicalCycleTaskContext(sources, { cycleId, runId, planRef } = {}) {
  const id = `cycle:execution:${cycleId}:canonical-contract`;
  const source = sources?.find(item => item.id === id && item.kind === 'tool_receipt');
  if (!source) return null;
  const invalid = message => ({ invalid: true, sourceId: id, reason: message });
  try {
    let data = JSON.parse(source.text);
    if (data.kind === 'canonical-task-contract-manifest') {
      if (!Array.isArray(data.parts) || !data.parts.length || data.parts.length > 120) return invalid('Canonical evidence parts are unavailable.');
      const seen = new Set();
      let text = '';
      for (let index = 0; index < data.parts.length; index++) {
        const ref = data.parts[index];
        if (ref.index !== index || ref.id !== `${id}:part:${index}` || seen.has(ref.id)) return invalid('Canonical evidence part identities conflict.');
        seen.add(ref.id);
        const part = sources.find(item => item.id === ref.id && item.kind === 'tool_receipt' && item.contentHash === ref.contentHash);
        if (!part) return invalid('A complete canonical evidence part is missing.');
        const body = JSON.parse(part.text);
        if (body.kind !== 'canonical-task-contract-part' || body.version !== 1 || body.index !== index || body.runId !== data.runId ||
            body.taskId !== data.taskId || body.planEpoch !== data.planEpoch || body.journalSeq !== data.journalSeq || typeof body.text !== 'string') return invalid('Canonical evidence parts belong to different snapshots.');
        text += body.text;
      }
      if (text.length !== data.dataChars || text.length > 5 * 1024 * 1024) return invalid('The canonical evidence document is incomplete.');
      const full = JSON.parse(text);
      if (full.contractSha256 !== data.contractSha256 || full.taskId !== data.taskId || full.runId !== data.runId ||
          full.planEpoch !== data.planEpoch || full.journalSeq !== data.journalSeq || !sameRef(full.planRef, data.planRef)) return invalid('The canonical evidence manifest does not match its document.');
      data = full;
    }
    if (data.kind !== 'canonical-task-contract' || data.version !== 1 || data.planRef?.cycleId !== cycleId ||
        runId && data.runId !== runId || planRef && !sameRef(data.planRef, planRef)) return invalid('Canonical evidence belongs to another run or accepted Plan.');
    const contract = normalizePlanContract(data.contract, { allowEpoch: true });
    if (contract.planEpoch !== data.planEpoch || !Number.isSafeInteger(data.journalSeq) || data.journalSeq < 0 ||
        !Array.isArray(data.criteria) || !Array.isArray(data.unresolved) || !Array.isArray(data.outcomes)) return invalid('The canonical outcome projection is invalid.');
    const criteria = new Map(data.criteria.map(criterion => [criterion.id, criterion]));
    if (criteria.size !== data.criteria.length || criteria.size !== contract.criteria.length || contract.criteria.some(criterion => !criteria.has(criterion.id))) return invalid('Canonical criterion definitions and results differ.');
    const complete = data.criteria.every(criterion => criterion.satisfied === true) && data.unresolved.length === 0;
    if (data.complete !== complete) return invalid('Canonical completion disagrees with the saved observations.');
    return { sourceId: id, sourceHash: source.contentHash, taskId: data.taskId, runId: data.runId, planRef: data.planRef,
      contract, planEpoch: data.planEpoch, journalSeq: data.journalSeq, contractSha256: data.contractSha256,
      acceptanceCriteria: contractPlanProjection(contract).acceptanceCriteria,
      criteria: data.criteria, outcomes: data.outcomes, unresolved: data.unresolved, ...(Array.isArray(data.blockers) ? { blockers: data.blockers } : {}), complete };
  } catch { return invalid('The complete canonical review evidence could not be read.'); }
}
