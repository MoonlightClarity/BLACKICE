/**
 * Explicit Chat Planning pass. The host supplies the currently admitted task,
 * an inline module runner, and Directory's canonical read/compare-and-commit.
 * This adapter stores no plan, changes no action state, and dispatches no work.
 */
export const CHAT_PLANNING_MODULES = Object.freeze([
  Object.freeze({ id: 'builtin-decomposition', title: 'Task decomposition', artifact: 'pending-actions',
    brief: 'Identify the critical path for this task. Propose up to eight useful pending actions, each with an ID, objective and dependencies. Focus the smallest action that advances the requested outcome. Do not claim that any action ran.' }),
  Object.freeze({ id: 'builtin-task-grounding', title: 'Calibrated Depth and Action', artifact: 'grounded-choice',
    brief: 'Use the actual request, available evidence, authorization, and costs of delaying or acting. Choose or revise a useful pending action. A real gap may call for an evidence-gathering action instead of a task-wide stop. Do not treat assumptions as receipts.' }),
  Object.freeze({ id: 'builtin-structured-analysis', title: 'Structured Analytic Techniques', artifact: 'revised-choice',
    brief: 'When an unresolved choice matters, compare the live alternatives using evidence that can change the decision. Return a concise revision or reaffirmation of the best pending action and why. Do not repeat checks that cannot improve the choice.' }),
]);
const MODULES = new Map(CHAT_PLANNING_MODULES.map(module => [module.id,module]));
const identifier = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const bounded = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const invalid = (code) => Object.assign(Error(code),{code});
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
const picked = (snapshot,id) => snapshot.actions?.find(action=>action.id===id);
const recordKey = /^[A-Z][A-Z0-9_]{0,79}$/;
const allowedCodes = new Set(['PLANNING_ARTIFACT_INVALID','PLANNING_RECEIPT_SCOPE','PLANNING_ACTION_NOT_PENDING',
  'PLANNING_LEDGER_RESULT_INVALID','PLANNING_SCOPE_CHANGED','PLANNING_MODE_OFF','PLANNING_MODE_INVALID']);
const validRevision = value => Number.isSafeInteger(value) && value>=0;

function refs(values,snapshot) {
  if (!Array.isArray(values) || values.length>8 || !values.every(identifier) || new Set(values).size!==values.length) throw invalid('PLANNING_ARTIFACT_INVALID');
  if (!values.every(id=>snapshot.receipts?.some(receipt=>receipt.id===id && receipt.taskId===snapshot.taskId && receipt.state==='returned'))) throw invalid('PLANNING_RECEIPT_SCOPE');
  return [...values];
}

function proposalFor(module, output, snapshot) {
  if (!output || typeof output!=='object' || !bounded(output.reason,500)) throw invalid('PLANNING_ARTIFACT_INVALID');
  const reason = output.reason.trim(), sourceRefs = refs(output.sourceRefs ?? [],snapshot);
  // A provider may request a missing observation. This is neither a ledger
  // mutation nor terminal task state; the host can continue independent work.
  if (output.status==='needs-evidence') return {status:'needs-evidence'};
  if (output.status!=='proposed' || !identifier(output.focus)) throw invalid('PLANNING_ARTIFACT_INVALID');
  const proposal={ moduleId:module.id, artifact:module.artifact, focus:output.focus, reason, sourceRefs };
  if (module.artifact==='pending-actions') {
    if (!Array.isArray(output.actions) || !output.actions.length || output.actions.length>8) throw invalid('PLANNING_ARTIFACT_INVALID');
    proposal.actions=output.actions.map(action=>{
      if (!action || !identifier(action.id) || !bounded(action.objective,300) || !Array.isArray(action.dependsOn)
        || action.dependsOn.length>8 || !action.dependsOn.every(identifier) || new Set(action.dependsOn).size!==action.dependsOn.length
        || Object.keys(action).some(key=>!['id','objective','dependsOn'].includes(key))) throw invalid('PLANNING_ARTIFACT_INVALID');
      if (picked(snapshot,action.id)?.state && picked(snapshot,action.id).state!=='pending') throw invalid('PLANNING_ACTION_NOT_PENDING');
      return {id:action.id, objective:action.objective.trim(), dependsOn:[...action.dependsOn]};
    });
    const ids=new Set(proposal.actions.map(action=>action.id));
    if (ids.size!==proposal.actions.length || !ids.has(proposal.focus)) throw invalid('PLANNING_ARTIFACT_INVALID');
    const pending=new Map(proposal.actions.map(action=>[action.id,action]));
    const visit=(id,ancestors)=>{
      if (ancestors.has(id)) throw invalid('PLANNING_ARTIFACT_INVALID');
      const action=pending.get(id);
      if (!action) { if (!picked(snapshot,id)) throw invalid('PLANNING_ARTIFACT_INVALID'); return; }
      for (const dep of action.dependsOn) visit(dep,new Set([...ancestors,id]));
    };
    for (const id of ids) visit(id,new Set());
  } else {
    if (own(output,'actions') || picked(snapshot,proposal.focus)?.state!=='pending') throw invalid('PLANNING_ACTION_NOT_PENDING');
    if (module.artifact==='revised-choice') {
      if (!Array.isArray(output.alternatives) || output.alternatives.length<2 || output.alternatives.length>4
        || new Set(output.alternatives).size!==output.alternatives.length || !output.alternatives.includes(output.focus)
        || !output.alternatives.every(id=>identifier(id) && picked(snapshot,id)?.state==='pending')) throw invalid('PLANNING_ARTIFACT_INVALID');
      proposal.alternatives=[...output.alternatives];
    }
  }
  return {status:'proposed',proposal};
}

function providerSnapshot(snapshot) {
  const actions=Array.isArray(snapshot.actions)?snapshot.actions.slice(0,32):[];
  const receipts=Array.isArray(snapshot.receipts)?snapshot.receipts.filter(row=>row?.taskId===snapshot.taskId).slice(-32):[];
  return {
    taskId:snapshot.taskId, revision:snapshot.revision,
    objective:typeof snapshot.objective==='string'?snapshot.objective.slice(0,2000):'',
    focus:identifier(snapshot.focus)?snapshot.focus:null,
    actions:actions.map(({id,objective,dependsOn,state,reason})=>({id,objective,dependsOn:[...dependsOn],state,...(reason?{reason}:{})})),
    receipts:receipts.map(({id,state,actionId,tool,success,code})=>({id,state,actionId,tool,success,code})),
  };
}
/** Each admitted run/node gets one bounded pass, at most one attempt per entry.
 * commit({ taskId, runId, nodeId, expectedRevision, proposal, signal }) is the
 * single Directory CAS. It must recheck live admission atomically at commit.
 * invoke must not start another agent/session or dispatch operational tools.
 * Events name execution of the module adapter, not thought or task execution.
 */
export function createChatPlanningPass({mode,taskId,runId,nodeId,signal,read,commit,invoke,assertAdmission,emit=()=>{}}={}) {
  if (mode!=='on' && mode!=='off') throw invalid('PLANNING_MODE_INVALID');
  if (mode==='on' && (![taskId,runId,nodeId].every(identifier) || ![read,commit,invoke,assertAdmission].every(fn=>typeof fn==='function'))) throw invalid('PLANNING_SCOPE_CHANGED');
  const attempts=new Map();
  let queue=Promise.resolve();
  const scope={taskId,runId,nodeId};
  const publish=(module,phase,details={})=>emit({type:'planning.module',...scope,moduleId:module.id,artifact:module.artifact,phase,...details});
  async function attempt(module,decision) {
    let started=false;
    try {
      signal?.throwIfAborted();
      await assertAdmission({...scope,signal});
      signal?.throwIfAborted();
      const snapshot=await read({taskId,signal});
      if (snapshot?.taskId!==taskId || !validRevision(snapshot.revision)) throw invalid('PLANNING_SCOPE_CHANGED');
      signal?.throwIfAborted();
      started=true;
      publish(module,'started',{revision:snapshot.revision});
      const response=await invoke({module,...scope,snapshot:providerSnapshot(snapshot),signal,...(decision?{decision}:{})});
      signal?.throwIfAborted();
      // Only the agreed adapter protocol can distinguish a provider result from
      // the fact its stream ended successfully. A generic final has no artifact.
      if (response?.transport!=='completed' || !response.output) throw invalid('PLANNING_ARTIFACT_INVALID');
      const result=proposalFor(module,response.output,snapshot);
      if(result.status==='needs-evidence') {
        publish(module,'needs-evidence',{revision:snapshot.revision});
        return {status:'needs-evidence'};
      }
      await assertAdmission({...scope,signal});
      signal?.throwIfAborted();
      const receipt=await commit({...scope,expectedRevision:snapshot.revision,proposal:result.proposal,signal});
      if (receipt?.taskId!==taskId || !validRevision(receipt.revision) || receipt.revision<=snapshot.revision)
        throw invalid('PLANNING_LEDGER_RESULT_INVALID');
      publish(module,'completed',{revision:receipt.revision,actionId:result.proposal.focus});
      return {status:'completed',revision:receipt.revision,actionId:result.proposal.focus};
    } catch(error) {
      const status=signal?.aborted?'cancelled':'failed';
      const candidate=typeof error?.code==='string' && recordKey.test(error.code) ? error.code : '';
      const code=allowedCodes.has(candidate)?candidate:status==='cancelled'?'PLANNING_CANCELLED':'PLANNING_ATTEMPT_FAILED';
      if (started) publish(module,status,{code});
      return {status,code};
    }
  }
  function run(moduleId,{decision}={}) {
    if (mode==='off') return Promise.reject(invalid('PLANNING_MODE_OFF'));
    const module=MODULES.get(moduleId);
    if (!module || (decision!==undefined && !bounded(decision,8000))) return Promise.reject(invalid('PLANNING_ARTIFACT_INVALID'));
    if (attempts.has(moduleId)) return attempts.get(moduleId);
    const work=queue.then(()=>attempt(module,decision));
    attempts.set(moduleId,work);
    queue=work.catch(()=>{});
    return work;
  }
  return {run};
}
