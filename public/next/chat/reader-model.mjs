import { conversationRuns, messagesOfRun } from './model.mjs';

/** Convert a full archived execution family into a chat-only transfer.
 * Full event traces remain in the backend and are never sent to the UI thread.
 */
export function projectFamily(family) {
  const runs=conversationRuns(family);
  const projected=runs.map(run=>{
    const messages=messagesOfRun(run);
    const nodes=Object.fromEntries(Object.entries(run.nodes||{}).map(([id,node])=>[
      id,{status:node.status,threadId:node.threadId,resumeThreadId:node.resumeThreadId,
        turnId:node.turnId,turnStatus:node.turnStatus,model:node.resolvedModel,
        output:node.output},
    ]));
    return {
      id:run.id,taskId:run.taskId,parentRunId:run.parentRunId,retryOf:run.retryOf,
      createdAt:run.createdAt,updatedAt:run.updatedAt,
      input:run.input,status:run.status,settled:run.settled,output:run.output,
      workflow:{id:run.workflow?.id,name:run.workflow?.name,
        nodes:(run.workflow?.nodes||[]).map(n=>({id:n.id,type:n.type,name:n.name,model:n.model}))},
      // The worker returns bounded task metadata, never an entire state history
      // or tool/agent trace. Artifacts themselves are fetched only on click.
      taskState:run.taskState&&{
        taskId:run.taskState.taskId||run.taskId,revision:run.taskState.revision,
        goal:run.taskState.goal,
        steps:(run.taskState.steps||[]).slice(0,150).map(step=>({
          id:step.id,title:step.title,status:step.status,note:String(step.note||'').slice(0,500),
        })),
        artifacts:(run.taskState.artifacts||[]).slice(0,40).map(a=>({
          id:a.id,title:a.title,fileName:a.fileName,contentType:a.contentType,size:a.size,sha256:a.sha256,
        })),
      },
      nodes,precomputedMessages:messages,events:[],
    };
  });
  return {rootId:family?.rootId||null,state:family?.state||'active',
    title:family?.title||'',runs:projected,truncated:family?.truncated===true};
}
