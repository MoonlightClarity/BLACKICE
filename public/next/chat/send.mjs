import { stableId } from '../core/dom.mjs';
import { replyTarget, canContinueRun } from './model.mjs';
import {assertExecutablePlanningMode} from '../../response-cycle-model.mjs';

/** Send once; the existing server executes and persists the real run.
 * Failures preserve unsent drafts, and no mutation is silently replayed.
 */
export async function submitChat({ api, runs, task, model, effort = 'default', serviceTier = 'default', planningMode, planningExecutionMode = 'automatic', cwd = '', attachmentIds=[], context, goal, pastChats, directoryDiagnostics, directoryActions, chatPlanning }) {
  for(const value of [directoryActions,chatPlanning])if(value!==undefined&&!['on','off'].includes(value))throw Error('Choose Directory and Planning On or Off.');
  if(directoryDiagnostics!==undefined&&!['on','off','maximal'].includes(directoryDiagnostics))throw Error('Choose Basic, Detailed, or Maximal receipts.');
  if(pastChats!==undefined&&pastChats!=='on'&&pastChats!=='off')throw Error('Choose Past Chats Off or On.');
  const chosenPlanningMode = 'off';
  const latest=replyTarget(runs);
  planningExecutionMode=assertExecutablePlanningMode(planningExecutionMode,latest.run?.planningExecutionMode,latest.run?.workflow?.settings?.planningExecutionMode);
  if(!Array.isArray(attachmentIds)||attachmentIds.length>10||attachmentIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)))throw Error('Invalid attached files.');
  if (typeof task !== 'string' || !task.trim()) throw Error('Enter a message first.');
  const content = task.trim();
  if (latest.run && latest.active) {
    if(attachmentIds.length)throw Error('Files cannot be added to live direction. Send them with the next response.');
    if (!latest.nodeId) throw Error('The working agent cannot receive direction yet.');
    const result = await api('/api/runs/' + encodeURIComponent(latest.run.id) + '/steer','POST',
      { nodeId: latest.nodeId, message: content });
    if (result?.accepted !== true) throw Error('The running agent did not accept that message.');
    return { mode:'direction',runId:latest.run.id,receipt:result };
  }
  if (latest.run && latest.nodeId && canContinueRun(latest.run)) {
    const requestId=stableId('chat');
    const result=await api('/api/runs/' + encodeURIComponent(latest.run.id) + '/continue','POST',
      { nodeId:latest.nodeId,message:content,...(model&&model!=='default'?{model}:{}),effort,serviceTier,planningMode:chosenPlanningMode,planningExecutionMode,attachmentIds,requestId,...(pastChats!==undefined?{pastChats}:{}),...(directoryDiagnostics!==undefined?{directoryDiagnostics}:{}),...(directoryActions!==undefined?{directoryActions}:{}),...(chatPlanning!==undefined?{chatPlanning}:{}),...(context!==undefined?{context:structuredClone(context)}:{}) });
    return { mode:'continued',run:result?.run||result,requestId };
  }
  if (latest.run) throw Error(latest.run.settled === false ? 'This response is still settling. Wait for it to finish before sending again.' : 'This conversation has no stopped agent to continue. Use Retry or start a new conversation.');
  if (!cwd) throw Error('Choose a working folder in Config before starting new work.');
  const requestId=stableId('chat');
  const { createMissionWorkflow }=await import('../../mission-model.mjs');
  const workflow=createMissionWorkflow({ task:content,model:model??'default',effort,serviceTier,cwd,planningMode:chosenPlanningMode,planningExecutionMode,
    id:'mission_' + requestId });
  workflow.settings={...workflow.settings,planningExecutionMode};
  if(context!==undefined){
    workflow.settings.context=structuredClone(context);
    for(const node of workflow.nodes||[])if(node.type==='agent')node.context=structuredClone(context);
  }
  const saved=await api('/api/workflows','POST',workflow);
  const result=await api('/api/runs','POST',{ workflow:saved?.workflow||saved,
    input:{task:content,cwd,...(directoryActions!==undefined?{directoryActions}:{}),...(chatPlanning!==undefined?{chatPlanning}:{}),...(directoryDiagnostics!==undefined?{directoryDiagnostics}:{}),...(pastChats!==undefined?{pastChats}:{}),...(goal?{goal:structuredClone(goal)}:{}),planningMode:chosenPlanningMode,planningExecutionMode,attachmentIds},requestId });
  return { mode:'started',run:result?.run||result,requestId };
}
export function replyState(runs) {
  const target=replyTarget(runs);
  return { ...target, working:Boolean(target.active),
    canSend:!target.run || target.active || Boolean(target.nodeId && canContinueRun(target.run)) };
}

/** Start only from the separate new-task composer; never pass old runs, a
 * provider thread, Goal, current Chat options or existing attachments. */
export async function submitFreshChatTask({api,sourceTaskId,task,requestId=stableId('chat'),cwd}){
  if(typeof sourceTaskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(sourceTaskId)||typeof task!=='string'||!task.trim())throw Error('Choose a saved task and enter the new task.');
  const result=await api('/api/conversations/'+encodeURIComponent(sourceTaskId)+'/fresh-task','POST',
    {task:task.trim(),requestId,...(cwd?{cwd}:{})});
  if(!result?.run?.id||result.run.id!==result.run.taskId||result.run.id===sourceTaskId||result.run.parentRunId||result.run.chatDisplayGroupId!==result.groupId)
    throw Error('The new task receipt could not be verified. Reopen Tasks and retry with the same request.');
  return result;
}
