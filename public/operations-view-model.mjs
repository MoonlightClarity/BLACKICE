const attentionStates=new Set(['failed','cancelled','interrupted']);
export const operationJobGroup=job=>attentionStates.has(job.status)?'attention':['running','dispatching'].includes(job.status)?'active':['queued','retry_wait'].includes(job.status)?'waiting':job.status==='completed'?'completed':'other';
export const operationJobLabel=job=>job.retryHold&&attentionStates.has(job.status)?'Inspect original run':job.status==='retry_wait'&&job.retryStoppedReason?'Waiting for original attempt':({queued:'Queued',dispatching:'Starting',running:'Working',retry_wait:'Waiting to retry',completed:'Completed',failed:'Failed',cancelled:'Stopped',interrupted:'Interrupted'})[job.status]||'Unknown state';
export function operationsViewModel(snapshot,{filter='all',deploymentId='',limit=40}={}){
 const jobs=Array.isArray(snapshot.jobs)?snapshot.jobs:[],deployments=Array.isArray(snapshot.deployments)?snapshot.deployments:[],counts={all:0,attention:0,active:0,waiting:0,completed:0};
 const scoped=jobs.filter(job=>!deploymentId||job.deploymentId===deploymentId);
 for(const job of scoped){counts.all++;const group=operationJobGroup(job);if(Object.hasOwn(counts,group))counts[group]++;}
 const matching=scoped.filter(job=>filter==='all'||operationJobGroup(job)===filter),shown=matching.slice(0,limit);
 const upcoming=deployments.filter(item=>item.enabled&&!item.limitStatus?.reached&&!item.scheduleError&&Number.isFinite(item.nextAt)).sort((a,b)=>a.nextAt-b.nextAt).slice(0,3);
 const s=snapshot.status||{},state=s.error||s.healthy===false?'attention':s.paused||s.blockedReason?'paused':'ready';
 return{counts,jobs:shown,total:matching.length,hasMore:shown.length<matching.length,upcoming,state,label:state==='attention'?'Needs attention':state==='paused'?'Paused':'Ready',retryHeld:scoped.filter(job=>job.retryHold&&attentionStates.has(job.status)).length};
}

/** This is a receipt timeline; unfinished phases are never rendered as successful. */
export function operationAttemptPhases(attempt){
 const phase={status:attempt.status||'unknown',runId:attempt.runId||null,error:attempt.error||null};
 return[{label:'Admitted',at:attempt.createdAt||null,state:attempt.createdAt?'recorded':'unknown'},{label:attempt.runId?'Run linked':'Waiting for run',at:attempt.startedAt||null,state:attempt.runId?'recorded':'pending'},...(attempt.finishedAt?[{label:({completed:'Completed',failed:'Failed',cancelled:'Stopped',interrupted:'Interrupted'})[phase.status]||phase.status,at:attempt.finishedAt,state:phase.status==='completed'?'complete':'attention'}]:[])];
}
