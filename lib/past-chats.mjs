// Host scope for BLACKICE's own prior-chat tools. This is not a filesystem,
// provider-memory, or same-conversation continuity boundary.
export function pastChatsMode(value){
  if(value===undefined||value==='on'||value==='off')return value;
  throw Object.assign(new Error('Choose Past Chats Off or On.'),{status:400,code:'PAST_CHATS_MODE_INVALID'});
}
export const pastChatsAllowed=run=>run?.pastChats!=='off';

export function pastChatsRunVisible(engine,run,target){
  if(pastChatsAllowed(run))return true;
  const root=run.taskId||run.id,seen=new Set();
  for(let current=target;current&&!seen.has(current.id);){
    seen.add(current.id);
    if((current.taskId||current.id)===root)return true;
    const owner=current.nativeController;
    if(!owner?.runId)return false;
    if(owner.runId===run.id)return true;
    current=engine.runs.get(owner.runId);
  }
  return false;
}


// Ordinary Chat creates a workflow whose title is the first prompt. The
// generated namespace and exact product description distinguish these from
// explicitly authored workflows, including those saved before this switch.
export function pastChatsWorkflowVisible(run,workflow){
  return pastChatsAllowed(run)||workflow.id===run.workflowId||
    !(workflow.id.startsWith('mission_chat_')&&workflow.description==='A focused task started from Mission.');
}
