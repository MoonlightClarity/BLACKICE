import { stableId } from '../core/dom.mjs';
import { replyTarget, canContinueRun } from './model.mjs';

/** Send once; the existing server executes and persists the real run.
 * Failures preserve unsent drafts, and no mutation is silently replayed.
 */
export async function submitChat({ api, runs, task, model, effort = 'default', serviceTier = 'default', planningMode = 'on', planningExecutionMode = 'automatic', cwd = '', attachmentIds=[], context }) {
  if(!['automatic','plan_only'].includes(planningExecutionMode)||planningMode==='off'&&planningExecutionMode==='plan_only')throw Error('Plan only requires Planning On.');
  if(!Array.isArray(attachmentIds)||attachmentIds.length>10||attachmentIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)))throw Error('Invalid attached files.');
  if (typeof task !== 'string' || !task.trim()) throw Error('Enter a message first.');
  const content = task.trim(), latest = replyTarget(runs);
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
      { nodeId:latest.nodeId,message:content,...(model&&model!=='default'?{model}:{}),effort,serviceTier,planningMode,planningExecutionMode,attachmentIds,requestId,...(context!==undefined?{context:structuredClone(context)}:{}) });
    return { mode:'continued',run:result?.run||result,requestId };
  }
  if (latest.run) throw Error(latest.run.settled === false ? 'This response is still settling. Wait for it to finish before sending again.' : 'This conversation has no stopped agent to continue. Use Retry or start a new conversation.');
  if (!cwd) throw Error('Choose a working folder in Settings before starting new work.');
  const requestId=stableId('chat');
  const { createMissionWorkflow }=await import('../../mission-model.mjs');
  const workflow=createMissionWorkflow({ task:content,model:model??'default',effort,serviceTier,cwd,planningMode,planningExecutionMode,
    id:'mission_' + requestId });
  workflow.settings={...workflow.settings,planningExecutionMode};
  if(context!==undefined){
    workflow.settings.context=structuredClone(context);
    for(const node of workflow.nodes||[])if(node.type==='agent')node.context=structuredClone(context);
  }
  const saved=await api('/api/workflows','POST',workflow);
  const result=await api('/api/runs','POST',{ workflow:saved?.workflow||saved,
    input:{task:content,cwd,planningMode,planningExecutionMode,attachmentIds},requestId });
  return { mode:'started',run:result?.run||result,requestId };
}
export function replyState(runs) {
  const target=replyTarget(runs);
  return { ...target, working:Boolean(target.active),
    canSend:!target.run || target.active || Boolean(target.nodeId && canContinueRun(target.run)) };
}
