import { createHash } from 'node:crypto';
import { normalizePlanContract, isPlanContractTask } from '../public/planning-contract-model.mjs';

export const CONTRACT_REPLY_BYTES = 19000;
const hash = text => createHash('sha256').update(text).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const fail = message => Object.assign(new Error(message), { code: 'TASK_CONTRACT_DELIVERY_INVALID', status: 409 });
const copy = value => structuredClone(value);
const contractText = state => JSON.stringify(state.contract);

/** A common projection is applied before every provider-specific formatter.
 * Providers retain this exact bounded payload and report successful handoff.
 * A manifest is never a read of the omitted canonical intent. */
export function projectContractTaskState(state) {
  if (!isPlanContractTask(state) && state.taskSchemaVersion !== 14) return state;
  const base = { taskId: state.taskId, revision: state.revision, taskSchemaVersion: 14, contractVersion: 2, steps: [],
    goal: String(state.goal || '').slice(0, 4000), snapshotComplete: false };
  if (!state.contract) return { ...base, contractDelivery: { version: 1, kind: 'empty', revision: state.revision } };
  const text = contractText(state), viewHash = hash(text), totalChars = text.length;
  const delivery = { version: 1, kind: 'complete', revision: state.revision, planEpoch: state.contract.planEpoch, viewHash, totalChars };
  const value = { ...base, contract: copy(state.contract), contractDelivery: delivery,
    ...(state.contractAdoption ? { contractAdoption: copy(state.contractAdoption) } : {}),
    ...(state.contractRuntime ? { contractRuntime: copy(state.contractRuntime) } : {}),
    ...(state.interruption ? { interruption: copy(state.interruption) } : {}) };
  const view = value.contractRuntime;
  if (view) {
    for (const field of ['evidence', 'operations']) {
      const omitted = field === 'evidence' ? 'omittedEvidence' : 'omittedOperations';
      while (bytes(value) > CONTRACT_REPLY_BYTES && view[field]?.length) { view[field].shift(); view[omitted] = (view[omitted] || 0) + 1; }
    }
    for (const field of ['outcomes', 'findings', 'focuses', 'unresolved', 'criteria', 'workItems']) {
      while (bytes(value) > CONTRACT_REPLY_BYTES && view[field]?.length) { view[field].pop(); const key = 'omitted' + field[0].toUpperCase() + field.slice(1); view[key] = (view[key] || 0) + 1; }
    }
  }
  if (bytes(value) <= CONTRACT_REPLY_BYTES) return value;
  const nextRead = { action: 'read', view: 'contract', expectedRevision: state.revision, viewHash, offset: 0, charCount: 8000 };
  return { ...base, planEpoch: state.contract.planEpoch, contractDelivery: { ...delivery, kind: 'manifest', nextRead },
    note: 'The exact canonical contract exceeds this reply budget. Follow the pinned contract pages; this manifest does not acknowledge omitted intent.',
    ...(state.contractRuntime ? { journalSeq: state.contractRuntime.journalSeq, omittedOperations: (state.contractRuntime.operations?.length || 0) + (state.contractRuntime.omittedOperations || 0) } : {}) };
}

export function contractDeliveryPage(state, args) {
  if (!['expectedRevision', 'viewHash', 'offset', 'charCount', 'limit'].some(key => args[key] !== undefined)) return projectContractTaskState(state);
  if (!isPlanContractTask(state)) throw fail('There is no canonical contract to page.');
  if (args.limit !== undefined) throw fail('Use charCount, not limit, for a pinned contract page.');
  const text = contractText(state), viewHash = hash(text);
  if (args.expectedRevision !== state.revision || args.viewHash !== viewHash) throw Object.assign(fail('The canonical contract changed. Read its current manifest; do not combine pages from different revisions.'), { code: 'TASK_STATE_CONFLICT', currentRevision: state.revision });
  const offset = args.offset ?? 0, requested = args.charCount ?? 8000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(requested) || requested < 1 || requested > 8000) throw fail('Use the returned pinned offset and charCount from 1 to 8000.');
  let count = Math.min(requested, text.length - offset);
  while (count > 0 && Buffer.byteLength(text.slice(offset, offset + count)) > 12000) count = Math.max(1, Math.floor(count * .8));
  const chunk = text.slice(offset, offset + count), end = offset + chunk.length;
  return { taskId: state.taskId, revision: state.revision, taskSchemaVersion: 14, contractVersion: 2, planEpoch: state.contract.planEpoch, view: 'contract',
    contractDelivery: { version: 1, kind: 'page', revision: state.revision, planEpoch: state.contract.planEpoch, viewHash, totalChars: text.length, offset, length: chunk.length },
    text: chunk, nextRead: end < text.length ? { action: 'read', view: 'contract', expectedRevision: state.revision, viewHash, offset: end, charCount: requested } : null };
}

/** Delivery coverage is ephemeral worker state; it never changes task intent.
 * Only the exact payload passed to the successful adapter handoff is supplied. */
export function createContractDeliveryTracker(taskId, acknowledge) {
  const pages = new Map(); let latestRevision = 0, latestHash = null;
  return result => {
    let accepted = null;
    for (const item of result?.contentItems || []) {
      if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
      let state; try { state = JSON.parse(item.text); } catch { continue; }
      if (state?.taskId !== taskId || state.taskSchemaVersion !== 14 || state.contractVersion !== 2 || state.contractDelivery?.version !== 1) continue;
      const meta = state.contractDelivery;
      if (!Number.isSafeInteger(state.revision) || state.revision < 1 || meta.revision !== state.revision || state.revision < latestRevision || state.revision === latestRevision && meta.viewHash && meta.viewHash === latestHash) continue;
      if (meta.kind === 'empty' && !state.contract) { accepted = state; latestRevision = state.revision; acknowledge(state); continue; }
      if (!/^[a-f0-9]{64}$/.test(meta.viewHash || '') || !Number.isSafeInteger(meta.totalChars) || meta.totalChars < 1 || meta.totalChars > 120000) continue;
      if (meta.kind === 'complete') {
        try {
          normalizePlanContract(state.contract, { allowEpoch: true }); const contract = copy(state.contract), text = JSON.stringify(contract);
          if (meta.totalChars !== text.length || meta.viewHash !== hash(text) || meta.planEpoch !== contract.planEpoch) continue;
          accepted = { ...state, contract }; latestRevision = state.revision; latestHash = meta.viewHash; acknowledge(accepted);
        } catch {}
        continue;
      }
      if (meta.kind !== 'page' || typeof state.text !== 'string' || !Number.isSafeInteger(meta.offset) || meta.offset < 0 || meta.length !== state.text.length || meta.offset + meta.length > meta.totalChars) continue;
      const key = state.revision + ':' + meta.viewHash;
      let record = pages.get(key);
      if (!record) { record = { meta, chunks: new Map() }; pages.set(key, record); if (pages.size > 4) pages.delete(pages.keys().next().value); }
      if (record.meta.totalChars !== meta.totalChars || record.meta.planEpoch !== meta.planEpoch) { pages.delete(key); continue; }
      if (record.chunks.has(meta.offset) && record.chunks.get(meta.offset) !== state.text) { pages.delete(key); continue; }
      record.chunks.set(meta.offset, state.text);
      const chunks = [...record.chunks].sort((a,b) => a[0] - b[0]); let offset = 0, text = '';
      for (const [start, chunk] of chunks) { if (start !== offset) break; text += chunk; offset += chunk.length; }
      if (offset !== meta.totalChars || hash(text) !== meta.viewHash) continue;
      try {
        const contract = JSON.parse(text); normalizePlanContract(contract, { allowEpoch: true });
        if (contract.planEpoch !== meta.planEpoch) continue;
        accepted = { taskId, revision: state.revision, taskSchemaVersion: 14, contractVersion: 2, steps: [], contract, contractDelivery: { ...meta, kind: 'complete' } };
        latestRevision = state.revision; latestHash = meta.viewHash; acknowledge(accepted); pages.delete(key);
      } catch {}
    }
    return accepted;
  };
}
