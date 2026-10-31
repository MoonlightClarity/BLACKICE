import { conversationRuns, messagesOfRun } from './model.mjs';
import { recordedChatModels } from './model.mjs';
import { projectPlanningActivity } from './planning-timeline.mjs';
import { contextOptions, contextStatistics, compactionStatistics } from '../core/context-controls.mjs';
const records = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];

/** Convert a full archived execution family into a chat-only transfer.
 * Full event traces remain in the backend and are never sent to the UI thread.
 */
export function projectFamily(family) {
  const runs=conversationRuns(family);
  const projected=runs.map(run=>{
    const messages=messagesOfRun(run),models=recordedChatModels(run);
    const nodes=Object.fromEntries(Object.entries(run.nodes||{}).map(([id,node])=>[
      id,{status:node.status,viabilityHeld:node.viabilityHeld===true,threadId:node.threadId,resumeThreadId:node.resumeThreadId,codexHistory:node.codexHistory,
        turnId:node.turnId,turnStatus:node.turnStatus,runtimePhase:node.runtimePhase,model:models[id]?.model,resolvedModel:node.resolvedModel,
        modelEvidence:models[id],
        contextStatus:contextStatistics(node.contextStatus||node.context),lastCompaction:compactionStatistics(node.lastCompaction),
        output:node.output},
    ]));
    return {
      id:run.id,taskId:run.taskId,parentRunId:run.parentRunId,retryOf:run.retryOf,
      createdAt:run.createdAt,updatedAt:run.updatedAt,
      input:run.input,status:run.status,settled:run.settled,output:run.output,
      planningExecutionMode:run.planningExecutionMode,
      viability:run.viability?.awaitingInput===true?{awaitingInput:true}:undefined,
      responseCycle:run.responseCycle&&{
        state:run.responseCycle.state,requestId:run.responseCycle.requestId,cycleId:run.responseCycle.cycleId,
        title:String(run.responseCycle.title||'').slice(0,240),summary:String(run.responseCycle.summary||'').slice(0,1200),
        planRef:run.responseCycle.planRef&&{requestId:run.responseCycle.planRef.requestId,nodeId:run.responseCycle.planRef.nodeId,
          nodeRevision:run.responseCycle.planRef.nodeRevision,responseId:run.responseCycle.planRef.responseId},
      },
      attachmentIds:Array.isArray(run.attachmentIds)?run.attachmentIds.filter(id=>typeof id==='string'):[],
      workflow:{id:run.workflow?.id,name:run.workflow?.name,
        settings:{...(run.workflow?.settings?.context?{context:contextOptions(run.workflow.settings.context)}:{}),codexHistory:run.workflow?.settings?.codexHistory},
        nodes:(run.workflow?.nodes||[]).map(n=>({id:n.id,type:n.type,name:n.name,model:n.model,codexHistory:n.codexHistory,
          ...(n.context?{context:contextOptions(n.context)}:{})}))},
      // The worker returns bounded task metadata, never an entire state history
      // or tool/agent trace. Artifacts themselves are fetched only on click.
      taskState:run.taskState&&{
        taskId:run.taskState.taskId||run.taskId,revision:run.taskState.revision,updatedAt:run.taskState.updatedAt||run.updatedAt,
        goal:run.taskState.goal,plan:run.taskState.plan,
        steps:records(run.taskState.steps).slice(0,200).map(step=>({
          id:step.id,title:step.title,parentId:step.parentId,kind:step.kind,stepType:step.stepType,status:step.status,
          dependsOn:step.dependsOn,selectedChildId:step.selectedChildId,branch:step.branch,operation:step.operation,
          result:step.result,doneWhen:step.doneWhen,attempt:step.attempt,
          note:typeof step.note==='string'?step.note.slice(0,700):undefined,evidence:String(step.evidence||'').slice(0,2500),blockedReason:step.blockedReason,
        })),
        planningReviews:records(run.taskState.planningReviews).slice(-16).map(review=>({
          runId:review.runId,nodeId:review.nodeId,reviewedRevision:review.reviewedRevision,at:review.at,
          decision:review.decision,summary:String(review.summary||'').slice(0,1200),nextStepId:review.nextStepId,
        })),
        artifacts:records(run.taskState.artifacts).slice(0,40).map(a=>({
          id:a.id,title:a.title,fileName:a.fileName,contentType:a.contentType,size:a.size,sha256:a.sha256,
        })),
      },
      nodes,precomputedMessages:messages,planningActivity:projectPlanningActivity(run),events:[],
    };
  });
  return {rootId:family?.rootId||null,state:family?.state||'active',
    title:family?.title||'',runs:projected,truncated:family?.truncated===true};
}
