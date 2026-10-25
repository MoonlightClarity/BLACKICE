/** Presentation groups annotate the backend's recorded status; they do not
 * change task state, infer step completion, or dispatch work. */
export const TASK_BOARD_LANES=Object.freeze([
  {id:'working',label:'Working'},
  {id:'attention',label:'Needs attention'},
  {id:'completed',label:'Completed'},
  {id:'saved',label:'Saved'},
]);
export function savedTaskLane(item){
  const status=item?.runStatus||item?.status;
  if(['queued','running','waiting'].includes(status))return'working';
  if(['failed','cancelled','interrupted','blocked','needs_attention'].includes(status))return'attention';
  return status==='completed'?'completed':'saved';
}
export function savedTaskStatus(item){
  const status=item?.runStatus||item?.status;
  if(status==='cancelled'&&item?.settled===false)return'Stopping';
  return({queued:'Queued',running:'Working',waiting:'Waiting',failed:'Failed',cancelled:'Stopped',interrupted:'Interrupted',completed:'Completed',blocked:'Blocked',needs_attention:'Needs attention'})[status]||status||'Saved';
}
export function taskBoard(items=[]){
  const lanes=TASK_BOARD_LANES.map(lane=>({...lane,items:[]})),byId=new Map(lanes.map(lane=>[lane.id,lane]));
  for(const item of items)byId.get(savedTaskLane(item)).items.push(item);
  return{loaded:items.length,lanes};
}
/** Operations bind runs on attempt receipts, rather than on the job itself.
 * A queued retry may still have an earlier linked attempt worth inspecting. */
export function jobLinkedRun(job){
  const attempts=Array.isArray(job?.attempts)?job.attempts:[];
  for(let index=attempts.length-1;index>=0;index--){
    const attempt=attempts[index];
    if(typeof attempt?.runId==='string'&&attempt.runId)return{runId:attempt.runId,attemptNumber:attempt.number||index+1,current:index===attempts.length-1};
  }
  return typeof job?.runId==='string'&&job.runId?{runId:job.runId,attemptNumber:null,current:true}:null;
}
