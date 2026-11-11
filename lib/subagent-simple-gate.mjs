/**
 * Cheap, host-only delegation admission. No forecast, language-model call,
 * probability math, model inspection, or disk I/O. This is a necessary
 * parallelism check, NOT a claim that delegation will be faster.
 */
export function evaluateParallelAdmission({tasks=[],maxParallel=1}={}) {
  const base={phase:'admission',gateVersion:1,mode:'static_dag',providerCalls:0};
  if (!Number.isSafeInteger(maxParallel) || maxParallel<2)
    return {...base,allowed:false,code:'SUBAGENT_NO_PARALLEL_CAPACITY',
      reason:'This execution has fewer than two concurrent worker slots.'};
  if (!Array.isArray(tasks) || tasks.length<2)
    return {...base,allowed:false,code:'SUBAGENT_SINGLE_WORK_ITEM',
      reason:'A single delegated work item cannot reduce the critical path through worker parallelism.'};
  const byId=new Map(tasks.map(task=>[task.id,task]));
  const memo=new Map(),stack=new Set();
  function layer(id) {
    if (memo.has(id))return memo.get(id);
    if (stack.has(id))return Infinity;
    stack.add(id);
    const deps=(byId.get(id)?.dependsOn||[]).filter(ref=>byId.has(ref));
    const value=deps.length?1+Math.max(...deps.map(layer)):0;
    stack.delete(id);memo.set(id,value);
    return value;
  }
  const cohorts=new Map();
  for (const task of tasks) {
    const value=layer(task.id);
    if (!Number.isFinite(value))
      return {...base,allowed:false,code:'SUBAGENT_CYCLIC_DAG',reason:'Worker dependencies contain a cycle.'};
    cohorts.set(value,(cohorts.get(value)||0)+1);
  }
  const width=Math.max(0,...cohorts.values());
  if(width<2)return {...base,allowed:false,code:'SUBAGENT_SERIAL_DAG',
    reason:'The proposed dependency graph offers no simultaneous worker tasks.',parallelWidth:width};
  return {...base,allowed:true,code:'SUBAGENT_PARALLEL_BATCH',reason:'At least two work items can run concurrently.',
    parallelWidth:Math.min(width,maxParallel)};
}
