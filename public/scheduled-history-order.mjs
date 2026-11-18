// Presentation ordering only. Never reorder the scheduler's durable dispatch queue.
const instant=value=>{
  if(value===null||value===undefined||value==='')return null;
  const parsed=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(parsed)?parsed:null;
};
export function jobLastRunAt(job){
  const starts=(job?.attempts||[]).map(row=>instant(row.startedAt)).filter(value=>value!==null);
  return starts.length?Math.max(...starts):instant(job?.startedAt)??instant(job?.createdAt);
}
export function resultAvailableAt(job){
  return instant(job?.delivery?.availableAt)??instant(job?.finishedAt)??instant(job?.createdAt);
}
const newest=(rows,date)=>[...(rows||[])].sort((a,b)=>{
  const left=date(a),right=date(b);
  return left===right?0:left===null?1:right===null?-1:right-left;
});
export const newestJobs=rows=>newest(rows,jobLastRunAt);
export const newestResults=rows=>newest(rows,resultAvailableAt);

/** Upcoming schedules, overdue first; undated/disabled rows follow in stable ID order. */
export function chronologicalSchedules(rows=[]){
  const scheduledAt=row=>row?.enabled===false?null:instant(row?.overdue?row.overdueSince:row?.nextAt)??instant(row?.nextAt);
  return [...rows].sort((a,b)=>{
    const left=scheduledAt(a),right=scheduledAt(b);
    if(left!==right)return left===null?1:right===null?-1:left-right;
    const x=String(a.id),y=String(b.id);return x<y?-1:x>y?1:0;
  });
}
