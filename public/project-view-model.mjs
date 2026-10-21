// Shared display semantics: a finished implementation is still awaiting review.
import {orderedProjectSteps} from './process-model.mjs';
export const isPreparedReview=task=>task?.status==='verifying'&&task.attempts?.at(-1)?.mode==='review_only'&&task.attempts.at(-1).verification?.status==='prepared';

// Display eligibility only. The project store also checks live request bindings
// and stopping leases before it stages or admits a reviewer.
export function reviewOriginalSource(task){
  if(task?.status!=='blocked')return null;
  const attempts=task.attempts||[];
  for(const attempt of [...attempts].reverse()){
    const phase=attempt.implementation;if(!phase)return null;
    if(phase.notAdmitted===true&&phase.status==='interrupted'&&!phase.runId)continue;
    if(phase.status!=='completed'||!phase.runId||!phase.requestId)return null;
    if(attempt.mode!=='review_only')return attempt;
    const source=attempts.find(item=>item.number===attempt.sourceAttempt&&item.mode!=='review_only');
    return source?.implementation?.runId===phase.runId&&source.implementation.requestId===phase.requestId&&source.implementation.status==='completed'?source:null;
  }
  return null;
}

export function projectViewModel(project,{blockedReason=null}={}){
  const tasks=Array.isArray(project?.tasks)?project.tasks:[],byId=new Map(tasks.map(task=>[task.id,task]));
  const unresolved=task=>(task.dependsOn||[]).filter(id=>byId.get(id)?.status!=='completed');
  const counts={working:0,blocked:0,ready:0,waiting:0,reviewed:0};
  for(const task of tasks){
    if(task.status==='completed')counts.reviewed++;
    else if(task.status==='blocked')counts.blocked++;
    else if(isPreparedReview(task))counts.ready++;
    else if(['running','verifying'].includes(task.status))counts.working++;
    else if(task.status==='pending')counts[unresolved(task).length?'waiting':'ready']++;
  }
  const blocked=tasks.find(task=>task.status==='blocked'),prepared=tasks.find(isPreparedReview),active=tasks.find(task=>['running','verifying'].includes(task.status)&&!isPreparedReview(task)),ready=tasks.find(task=>task.status==='pending'&&!unresolved(task).length),waiting=tasks.find(task=>task.status==='pending');
  const bucket=blocked||project?.status==='needs_attention'?'attention':active||project?.status==='running'?'working':project?.status==='completed'?'reviewed':'ready';
  let next;
  if(prepared&&!active)next={kind:'ready',title:'Review prepared',description:project.status==='paused'?'Resume to review the existing result with a separate verifier. Implementation and delivery will not repeat.':'Waiting for execution capacity to review the existing result. Implementation and delivery will not repeat.',taskId:prepared.id,label:'Inspect prepared review'};
  else if(blocked)next={kind:'attention',title:'A task needs your attention',description:blocked.error||blocked.attempts?.at(-1)?.verification?.verdict?.summary||'Inspect the saved evidence before preparing another attempt.',taskId:blocked.id,label:'Review blocked task'};
  else if(active)next={kind:'working',title:project.status==='paused'?'Finishing the current phase':active.status==='verifying'?'Review in progress':'Implementation in progress',description:project.status==='paused'?'Active work may finish. Resume explicitly to start the next phase.':'A separate review must pass before dependent tasks start.',taskId:active.id,label:'Inspect current task'};
  else if(project?.status==='completed')next={kind:'reviewed',title:'All tasks are agent-reviewed',description:'Inspect evidence, then save the method as a capability.',taskId:tasks.at(-1)?.id,label:'Inspect review evidence'};
  else if(ready)next={kind:'ready',title:project?.status==='running'?'Next task is ready':project?.status==='paused'?'Ready to resume':'Review the plan before starting',description:project?.status==='running'?'Waiting for execution capacity.':project?.status==='paused'?'Inspect this task, then choose Resume project.':'Start project begins with this task. Saving a plan starts no work.',taskId:ready.id,label:'Inspect next task'};
  else if(waiting){const dependencies=unresolved(waiting);next={kind:'waiting',title:'Waiting for prerequisites',description:`${waiting.title} is waiting for ${dependencies.map(id=>byId.get(id)?.title||id).join(', ')}.`,taskId:waiting.id,label:'Inspect waiting task'};}
  else next={kind:'ready',title:'Inspect this plan',description:'Review the tasks and acceptance checks before starting work.',taskId:null,label:null};
  if(blockedReason&&!active&&(prepared||!blocked)&&project?.status!=='completed')next={...next,title:'Project execution is paused',description:blockedReason,kind:'attention'};
  return{counts,bucket,next,executionHold:blockedReason||null,total:tasks.length,reviewed:counts.reviewed,percent:tasks.length?Math.round(counts.reviewed/tasks.length*100):0,blockedTasks:tasks.filter(task=>task.status==='blocked'),readyTask:ready||null,preparedReview:prepared||null,...projectTracking(project)};
}

// Tracking labels never mark execution complete. Linked milestones use reviewed
// tasks, while a manual milestone has an explicit, independent human checkbox.
export function projectTracking(project,{today=new Date().toISOString().slice(0,10)}={}){
  const tasks=project?.tasks||[],byId=new Map(tasks.map(task=>[task.id,task]));
  const milestones=(project?.milestones||[]).map(item=>{
    const ids=[...new Set(item.taskIds||[])],linked=ids.length>0,completed=ids.filter(id=>byId.get(id)?.status==='completed').length,total=ids.length,done=linked?completed===total:item.done===true;
    const status=done?'completed':ids.some(id=>byId.get(id)?.status==='blocked')?'blocked':ids.some(id=>['running','verifying','completed'].includes(byId.get(id)?.status))?'active':'planned';
    return{...item,taskIds:ids,total,completed,percent:linked?Math.round(completed/total*100):done?100:0,done,status,completion:linked?'agent-reviewed':'manual',overdue:Boolean(item.dueDate&&item.dueDate<today&&!done)};
  });
  let implementationRuns=0,reviewRuns=0;
  const seenImplementation=new Set(),seenReview=new Set();
  for(const task of tasks)for(const attempt of task.attempts||[]){if(attempt.implementation?.runId)seenImplementation.add(attempt.implementation.runId);if(attempt.verification?.runId)seenReview.add(attempt.verification.runId);}
  implementationRuns=seenImplementation.size;reviewRuns=seenReview.size;
  return{milestones,overdue:Boolean(project?.dueDate&&project.dueDate<today&&project.status!=='completed'),evidence:{implementationRuns,reviewRuns}};
}

export function projectPortfolio(projects=[],{filter='all',history='active',blockedReason=null}={}){
  const visible=projects.filter(project=>history==='all'||(history==='archived'?project.archived===true:project.archived!==true));
  const counts={all:visible.length,attention:0,working:0,ready:0,reviewed:0},priority={attention:0,working:1,ready:2,reviewed:3};
  const items=visible.map((project,index)=>{const model=projectViewModel(project,{blockedReason});counts[model.bucket]++;return{project,model,index};});
  return{counts,items:items.filter(item=>filter==='all'||item.model.bucket===filter).sort((a,b)=>priority[a.model.bucket]-priority[b.model.bucket]||a.index-b.index)};
}

/** Names and groups organize saved plans; execution status remains an annotation. */
export function projectGroupOutline(projects=[],{groups=[],history='active',filter='all',blockedReason=null}={}){
  const portfolio=projectPortfolio(projects,{history,filter,blockedReason}),byGroup=new Map();
  for(const group of groups)if(typeof group?.id==='string'&&typeof group.name==='string')byGroup.set(group.id,{id:group.id,name:group.name,items:[]});
  for(const item of portfolio.items){const id=item.project.groupId||null;if(!byGroup.has(id))byGroup.set(id,{id,name:id?item.project.groupName||'Unavailable group':'Ungrouped',items:[]});byGroup.get(id).items.push(item);}
  if(!byGroup.has(null))byGroup.set(null,{id:null,name:'Ungrouped',items:[]});
  const compare=(a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'});
  const outline=[...byGroup.values()].filter(group=>history!=='archived'||group.items.length).sort((a,b)=>a.id===null?1:b.id===null?-1:compare(a.name,b.name)||compare(a.id,b.id));
  for(const group of outline)group.items.sort((a,b)=>compare(a.project.name,b.project.name)||compare(a.project.id,b.project.id));
  return{...portfolio,groups:outline,history,activeCount:projects.filter(project=>project.archived!==true).length,archivedCount:projects.filter(project=>project.archived===true).length};
}

/** The project owns tasks; real attempt phases own workers. Dependencies are links, not parents. */
export function projectTaskOutline(project={}){
  const tasks=orderedProjectSteps(project.tasks||[]),byId=new Map(tasks.map(task=>[task.id,task]));
  return tasks.map((task,index)=>({task,number:index+1,dependencies:(task.dependsOn||[]).map(id=>({id,title:byId.get(id)?.title||id,known:byId.has(id)})),attempts:(task.attempts||[]).map(attempt=>({attempt,workers:['implementation','verification'].filter(kind=>attempt[kind]).map(kind=>({kind,phase:attempt[kind],label:kind==='verification'?'Review worker':attempt.mode==='review_only'?'Original implementation':'Implementation worker',reused:kind==='implementation'&&attempt.mode==='review_only',runId:attempt[kind].runId||null}))}))}));
}
