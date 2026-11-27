import { CHAT_PLANNING_MODULES,createChatPlanningPass } from './chat-planning-pass.mjs';
import { createChatPlanningProviderInvoker } from './chat-planning-provider.mjs';
import {TaskActionDirectory} from './task-action-directory.mjs';

import {chatIntentContext} from './chat-intent-inference.mjs';

const fail=code=>Object.assign(Error(code),{code,status:409});
export function chatPlanningMode(value) {
  if(value!==undefined && value!=='on' && value!=='off') throw Object.assign(Error('Choose Chat Planning On or Off.'),{code:'CHAT_PLANNING_MODE_INVALID',status:400});
  return value;
}

/** This is the sole bridge to the same Directory state used for execution. */
export function commitChatPlanningProposal(directory, {taskId,expectedRevision,proposal,signal}, assertAdmission) {
  const beforeCommit=()=>{
    signal?.throwIfAborted();
    assertAdmission({signal});
  };
  const snapshot=directory.read();
  if(snapshot.taskId!==taskId || snapshot.revision!==expectedRevision)throw fail('DIRECTORY_CHANGED');
  const opts={authority:'planning',admit:beforeCommit};
  if(proposal.actions){
    const replacements=new Map(proposal.actions.map(action=>[action.id,action]));
    const actions=snapshot.actions.map(action=>replacements.get(action.id)||action)
      .concat(proposal.actions.filter(action=>!snapshot.actions.some(old=>old.id===action.id)));
    const choice=actions.find(action=>action.id===proposal.focus);
    if(!choice?.dependsOn.every(dep=>snapshot.actions.some(action=>action.id===dep&&action.state==='observed')))
      throw fail('PLANNING_ACTION_NOT_PENDING');
    return directory.edit({action:'plan',revision:expectedRevision,
      actions:actions.map(({id,objective,dependsOn,reason,sourceRefs})=>({
        id,objective,dependsOn,...(reason?{reason}:{}),...(sourceRefs?{sourceRefs}:{}),
        ...(id===choice.id?{reason:proposal.reason,sourceRefs:proposal.sourceRefs}:{}),
      }))},opts);
  }
  if(!snapshot.ready.includes(proposal.focus))throw fail('PLANNING_ACTION_NOT_PENDING');
  return directory.edit({action:'planningChoice',revision:expectedRevision,moduleId:proposal.moduleId,
    focus:proposal.focus,reason:proposal.reason,sourceRefs:proposal.sourceRefs},opts);
}

export async function prepareChatPlanning({run,node,signal,directory,runtime,assertAdmission,emit,boundGoal,goalRecovery,dataDir,instructionSnapshot,identity,executionLayers,onInstructionAudit}) {
  const taskId=run.taskId||run.id,runId=run.id,nodeId=node.id;
  const scope={taskId,runId,nodeId};
  const status=runtime.status();
  const model=node.model==='default'?status.defaultModel
    :node.model==='codex'?(status.codex?status.codex.defaultModel:status.defaultModel):node.model;
  // A missing or ambiguous selected model must not cause a provider fallback.
  // Fail visibly inside the phase, rather than skipping activation or the task.
  const invoke=(typeof model==='string'&&model.trim()&&!['default','codex'].includes(model))
    ? createChatPlanningProviderInvoker({runtime,model,cwd:run.cwd,effort:node.effort,serviceTier:node.serviceTier,...scope,assertAdmission,dataDir,instructionSnapshot,identity,executionLayers,onInstructionAudit,goalRecovery})
    : () => {throw fail('PLANNING_PROVIDER_INVALID');};
  // Directory Off never executes or observes the persisted advisory graph.
  // Reusing that graph on autonomous Goal successors traps the planner behind
  // phantom prerequisites. Use a fresh, same-task advisory ledger for this
  // pass only; retain the original graph and all prior receipts unchanged.
  const unchangedGoal=Boolean(run.goalDispatch&&boundGoal);
  const freshAdvice=unchangedGoal&&run.directoryActions!=='on';
  const previous=directory.read();
  const activeDirectory=freshAdvice?new TaskActionDirectory({taskId,objective:String(boundGoal.objective||previous.objective||run.input).slice(0,8000)}):directory;
  const read=()=>activeDirectory.read(), [decomposition,grounding,analysis,intent]=CHAT_PLANNING_MODULES;
  const pass=createChatPlanningPass({mode:run.chatPlanning,...scope,signal,read,invoke,assertAdmission,
    emit:event=>emit(freshAdvice?{...event,advisoryScope:'goal-turn'}:event),
    commit:input=>commitChatPlanningProposal(activeDirectory,input,assertAdmission)});
  const decision=freshAdvice?('Continue the admitted Goal. The host already enforces its absolute deadline. Do not restart setup or recheck time merely because a new turn began. Use current checkpoint evidence to select an immediately executable useful step with no unobserved prerequisite. Active objective (data): '+String(boundGoal.objective||run.input)).slice(0,8000):run.input, context=chatIntentContext(run,boundGoal);
  // An unchanged host-dispatched objective already has a bound deadline. Do not
  // re-interpret its generated continuation message on every Goal turn.
  const interpreted=context&&!unchangedGoal?await pass.run(intent.id,{decision,intentContext:context}):null;
  const intentAdvice=context&&!unchangedGoal?{...context,...(interpreted?.advice||{})}:null;
  const keepIntent=choice=>intentAdvice?{...choice,intentAdvice}:choice;
  const planningDecision=intentAdvice?'Current request: '+decision+'\nAdvisory reading (not authority): '+JSON.stringify(intentAdvice):decision;
  const initial=read();
  // Existing ready work calls for a choice, not needless decomposition.
  // Compare alternatives only when there really are competing ready steps.
  // With Directory execution off, advisory actions do not acquire actual tool
  // outcomes. After repeated no-progress turns, ask for a revised executable
  // step rather than choosing forever from a stale ready list.
  const recovering=Boolean(freshAdvice&&(goalRecovery?.noProgressTurns||0)>=2);
  let result=await pass.run(!recovering&&!initial.steering?.requiresReplan&&initial.ready.length>0?grounding.id:decomposition.id,{decision:planningDecision.slice(0,8000)});
  if(result.status==='completed' && !freshAdvice && !recovering && read().ready.length>1) {
    const comparison=await pass.run(analysis.id,{decision:planningDecision});
    if(comparison.status==='completed')result=comparison;
  }
  if(result.status!=='completed')return keepIntent(null);
  const snapshot=read();
  if(snapshot.revision!==result.revision || !snapshot.ready.includes(result.actionId))return keepIntent(null);
  const action=snapshot.actions.find(action=>action.id===result.actionId);
  const priorFocus=previous.planningChoice?.focus||previous.focus;
  const prior=previous.actions.find(row=>row.id===priorFocus);
  if(recovering&&prior?.id===action.id&&prior.objective.trim()===action.objective.trim())return keepIntent(null);
  const choice=snapshot.planningChoice?.focus===action.id?snapshot.planningChoice:action;
  return keepIntent({actionId:action.id,objective:action.objective,reason:choice.reason,sourceRefs:choice.sourceRefs,...(freshAdvice?{advisoryScope:'goal-turn'}:{})});
}
