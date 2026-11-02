import {createHash} from 'node:crypto';
import {parseModuleResponse} from '../public/planning-browser-model.mjs';

/** A provider turn, a checked Planning response, adoption and task effects are
 * separate facts. This receipt describes one recorded invocation, never general
 * model capability or successful execution of the user's task. */
export function planningInvocationEvidence(request,attemptId,{providerResponse,settlementFailed=false}={}){
  const attempt=request?.attempts?.find(item=>item.id===attemptId),node=request?.nodes?.find(item=>item.id===attempt?.nodeId);
  const response=request?.responses?.find(item=>item.id===attempt?.responseId);
  const output=attempt?.output??attempt?.partialOutput;
  let structuredResponseValid=false;
  if(typeof output==='string'&&attempt?.node?.kind)try{
    const parsed=parseModuleResponse(output,attempt.node.kind,{sources:attempt.sources||[],pipelineVersion:attempt.pipelineVersion||attempt.cycleContext?.pipelineVersion||1});structuredResponseValid=!parsed.missingFields?.length;
  }catch{}
  const outputHash=typeof output==='string'?createHash('sha256').update(output).digest('hex'):null;
  const durableResponseRecorded=Boolean(structuredResponseValid&&attempt?.status==='completed'&&response&&
    response.nodeId===attempt.nodeId&&response.provenance?.kind==='runtime'&&response.provenance.attemptId===attempt.id&&
    attempt.outputHash===outputHash&&response.provenance.contentHash===outputHash);
  const currentForNode=Boolean(durableResponseRecorded&&node?.response?.id===response.id&&response.nodeRevision===node.revision);
  const stageReady=Boolean(currentForNode&&(node.readiness?.cycle?node.readiness.cycle.analysisReady===true:node.readiness?.state==='ready'));
  const observedProviderResponse=providerResponse|| (durableResponseRecorded?'completed':'unobserved');
  const status=settlementFailed?'unconfirmed':attempt?.status==='cancelled'?'cancelled':
    durableResponseRecorded?currentForNode?stageReady?'succeeded':'needs_evidence':'stale':
      attempt?.status==='failed'||observedProviderResponse==='completed'?'failed':'unverified';
  return {scope:'planning-invocation',status,requestId:request?.id||null,nodeId:attempt?.nodeId||null,
    kind:attempt?.node?.kind||node?.kind||null,pipelineVersion:attempt?.pipelineVersion||attempt?.cycleContext?.pipelineVersion||1,attemptId:attempt?.id||attemptId||null,
    model:attempt?.metadata?.model||attempt?.model||null,providerResponse:observedProviderResponse,
    structuredResponseValid,durableResponseRecorded,currentForNode,stageReady,
    dispatchReady:currentForNode&&node?.readiness?.cycle?.dispatchReady===true,
    ...(durableResponseRecorded?{responseId:response.id,outputHash,nodeRevision:response.nodeRevision}:{}),
    checkedAt:attempt?.finishedAt||null,adoptionVerified:false,effectsVerified:false};
}

export function planningCycleEvidence(request,cycle,{adoptedPlanRef}={}){
  const stages=Object.entries(cycle.stageNodeIds||{}).map(([stage,nodeId])=>{
    const node=request.nodes.find(item=>item.id===nodeId),attemptId=request.attempts?.findLast(item=>item.nodeId===nodeId)?.id;
    return {stage,...planningInvocationEvidence(request,attemptId)};
  });
  const plan=request.nodes.find(item=>item.id===cycle.stageNodeIds?.plan),ref=adoptedPlanRef;
  const planAdopted=Boolean(plan?.response&&plan.readiness?.cycle?.analysisReady===true&&ref&&
    ref.requestId===request.id&&ref.cycleId===cycle.id&&ref.nodeId===plan.id&&ref.nodeRevision===plan.revision&&ref.responseId===plan.response.id);
  return {scope:'planning-cycle',stages,planAdopted,
    ...(planAdopted?{planRef:structuredClone(ref)}:{}),taskSuccessVerified:false};
}
