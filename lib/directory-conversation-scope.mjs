import {normalizeContextOptions,contextSnapshot,nativeContextSnapshot} from './context.mjs';

/** Automatic Directory context belongs to one conversation.
 * Shared knowledge remains available through explicit tools or context import;
 * using the same workspace does not make another conversation's notes current.
 */
export function directoryKnowledgeAdmission({ run, runs = [] }) {
  const conversationId = run.taskId || run.id;
  const runIds = new Set([conversationId, run.id]);
  for (const saved of runs) {
    if ((saved.taskId || saved.id) === conversationId) runIds.add(saved.id);
  }
  for (const row of run.directoryUserHistory || []) {
    if (typeof row.runId === 'string') runIds.add(row.runId);
  }
  return entry => {
    const sourceIds = [entry?.provenance?.runId, entry?.knowledgeProvenance?.runId,
      ...(entry?.evidenceRunIds || []), ...(entry?.evidence || []).map(row => row?.runId)]
      .filter(id => typeof id === 'string' && id.length);
    return sourceIds.length > 0 && sourceIds.every(id => runIds.has(id));
  };
}

/** Use the selected model's supported capacity, retaining an explicit window.
 * Unknown capacity is left to the provider rather than replaced by a small
 * application budget. Output space and runtime-reported headroom still count.
 */
export function directoryContextConfiguration({model={},context={}}={}) {
  const options=normalizeContextOptions({...context,enforceKnownCapacityOnly:true});
  const native=!!(model.runtimeDefaultContextWindowTokens||model.maxContextWindowTokens||model.effectiveContextWindowPercent);
  if(options.preset==='model'&&Number.isSafeInteger(model.maxContextWindowTokens)&&model.maxContextWindowTokens>0)options.preset='extended';
  const limits=native?nativeContextSnapshot({model,options}):contextSnapshot({options,
    modelWindowTokens:model.contextWindowTokens,modelWindowSource:model.contextWindowSource,maxOutputTokens:model.maxOutputTokens||8192});
  if(Number.isSafeInteger(limits.inputBudgetTokens)&&context.compactAtTokens==null)options.compactAtTokens=limits.inputBudgetTokens;
  return {options,inputBudgetTokens:limits.inputBudgetTokens,knownCapacity:Number.isFinite(limits.inputBudgetTokens)};
}
