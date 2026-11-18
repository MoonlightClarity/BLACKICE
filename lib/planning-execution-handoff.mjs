import { normalizePlanContract } from '../public/planning-contract-model.mjs';
import { OPERATIONAL_HOLD_POLICY_VERSION } from '../public/planning-user-agency.mjs';
import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const executionOutlineHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function adoptExecutionPlanContract({ store, taskId, runId, nodeId, getSource, signal, onUpdate = () => {} }) {
  signal?.throwIfAborted();
  const source = await getSource();
  if (!source?.plan?.contract) throw Object.assign(new Error('The accepted schema-14 Plan must contain its canonical contract. No operational outline will be synthesized.'), { code: 'TASK_CONTRACT_SOURCE_REQUIRED' });
  const contract = normalizePlanContract(source.plan.contract), current = await store.get(taskId, { signal });
  const requiredCriterionIds = source.requiredCriterionIds || [];
  const commitPrerequisiteIds = source.commitPrerequisiteIds || [];
  const matchesSource = candidate => candidate.sha256 === source.sha256
    && executionOutlineHash(candidate.planRef) === executionOutlineHash(source.planRef)
    && executionOutlineHash(candidate.requiredCriterionIds || []) === executionOutlineHash(requiredCriterionIds)
    && executionOutlineHash(candidate.commitPrerequisiteIds || []) === executionOutlineHash(commitPrerequisiteIds)
    && Boolean(candidate.freshEvidence) === Boolean(source.freshEvidence);
  if (!matchesSource(await getSource())) throw Object.assign(new Error('The accepted Plan changed before canonical adoption.'), { code: 'RESPONSE_CYCLE_PLAN_CONFLICT' });
  const adoption = { version: 1, contractVersion: 2, taskId, runId, nodeId, planRef: structuredClone(source.planRef), sourceSha256: source.sha256, acceptedContractSha256: executionOutlineHash(contract), requiredCriterionIds: [...requiredCriterionIds], commitPrerequisiteIds: [...commitPrerequisiteIds],
    ...(source.freshEvidence ? { freshEvidence: true } : {}), operationalHoldPolicy: OPERATIONAL_HOLD_POLICY_VERSION };
  onUpdate({ ...adoption, state: 'adopting', attempts: [] });
  const alreadyAdopted = state => state.contract && state.contractAdoption?.sourceSha256 === source.sha256 && executionOutlineHash(state.contractAdoption.planRef) === executionOutlineHash(source.planRef);
  if (!alreadyAdopted(current)) {
    try { await store.setContract(taskId, contract, { expectedRevision: current.revision, runId, nodeId, schemaVersion: 14, executionGuardrails: true, signal, adoption }); }
    catch (error) { if (error.code !== 'TASK_STATE_CONFLICT' || !alreadyAdopted(await store.get(taskId, { signal }))) throw error; }
  }
  signal?.throwIfAborted();
  if (!matchesSource(await getSource())) throw Object.assign(new Error('The accepted Plan changed during canonical adoption. Its saved historical reference is preserved; no worker was started.'), { code: 'RESPONSE_CYCLE_PLAN_CONFLICT' });
  const snapshot = await store.get(taskId, { signal }), metadata = { ...adoption, state: 'accepted', revision: snapshot.revision, planEpoch: snapshot.contract.planEpoch, attempts: [] };
  onUpdate(metadata); return { snapshot, metadata };
}
