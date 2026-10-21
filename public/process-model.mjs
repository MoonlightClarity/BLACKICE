// Draft transformations only. Execution and review remain owned by Projects.
const clone=value=>structuredClone(value);
const text=value=>String(value??'');
export const lines=value=>text(value).split('\n').map(line=>line.trim()).filter(Boolean);
export const defaultOntology={
  taskTypes:['general','research','analysis','decision','software','writing','planning'].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),kind:'task',origin:'builtin'})),
  stepTypes:['scope','collect','analyze','decide','create','check','handoff'].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),kind:'step',origin:'builtin'})),
};

export function projectPlan(project={}){
  return{
    name:text(project.name),objective:text(project.objective),cwd:text(project.cwd),
    model:project.model||'default',verifierModel:project.verifierModel||'default',maxRepairs:project.maxRepairs??2,
    context:text(project.context),methodContext:text(project.methodContext),...(project.method?{method:clone(project.method)}:{}),
    ...projectMetadata(project),
    tasks:(project.tasks||[]).map(task=>({
      id:task.id,title:text(task.title),instructions:text(task.instructions),
      acceptanceCriteria:[...(task.acceptanceCriteria||[])],dependsOn:[...(task.dependsOn||[])],
      ...(task.stepType?{stepType:task.stepType}:{}),...(task.inputs?{inputs:[...task.inputs]}:{}),...(task.result!==undefined?{result:text(task.result)}:{}),
      ...(task.model?{model:task.model}:{}),...(task.verifierModel?{verifierModel:task.verifierModel}:{}),...(task.maxRepairs!==undefined?{maxRepairs:task.maxRepairs}:{}),
    })),
  };
}

export function projectMetadata(project={}){
  return{name:text(project.name),priority:project.priority||'normal',owner:text(project.owner),dueDate:text(project.dueDate),notes:text(project.notes),tags:[...(project.tags||[])],milestones:(project.milestones||[]).map(item=>({id:item.id,title:text(item.title),taskIds:[...(item.taskIds||[])],dueDate:text(item.dueDate),done:item.done===true}))};
}

export function emptyProject(cwd='',goal=''){
  return{...projectPlan({cwd,objective:goal}),tasks:[newProjectStep([])]};
}

function nextId(items,prefix){let index=items.length+1;while(items.some(item=>item.id===`${prefix}-${index}`))index++;return`${prefix}-${index}`;}
export function newProjectStep(tasks){return{id:nextId(tasks,'task'),title:'',instructions:'',stepType:'create',inputs:[],result:'',acceptanceCriteria:[],dependsOn:tasks.length?[tasks.at(-1).id]:[]};}
export function newMethodStep(steps){return{id:nextId(steps,'step'),title:'',type:'create',instructions:'',inputs:[],result:'',checks:[]};}
export function newMethodInput(inputs){return{id:nextId(inputs,'input'),label:'',description:'',required:false};}
export function newMilestone(milestones){return{id:nextId(milestones,'milestone'),title:'',taskIds:[],dueDate:'',done:false};}
export function isSequentialPlan(tasks=[]){return tasks.every((task,index)=>task.dependsOn?.length===(index?1:0)&&(!index||task.dependsOn[0]===tasks[index-1].id));}
export function sequenceSteps(tasks=[]){return tasks.map((task,index)=>({...clone(task),dependsOn:index?[tasks[index-1].id]:[]}));}
export function moveStep(items,id,direction,{sequence=false}={}){
  const result=clone(items),index=result.findIndex(item=>item.id===id),target=index+direction;
  if(index<0||![-1,1].includes(direction)||target<0||target>=result.length)return result;
  [result[index],result[target]]=[result[target],result[index]];
  return sequence?sequenceSteps(result):result;
}
export function removeProjectStep(tasks,id){return tasks.filter(task=>task.id!==id).map(task=>({...clone(task),dependsOn:(task.dependsOn||[]).filter(value=>value!==id)}));}

// A stable dependency order makes old graphs readable as a plan without editing them.
export function orderedProjectSteps(tasks=[]){
  const result=[],seen=new Set(),remaining=[...tasks],known=new Set(tasks.map(task=>task.id));
  while(remaining.length){
    const index=remaining.findIndex(task=>(task.dependsOn||[]).every(id=>seen.has(id)||!known.has(id)));
    if(index<0){result.push(...remaining);break;}
    const [task]=remaining.splice(index,1);result.push(task);seen.add(task.id);
  }
  return result;
}

export function methodDefinition(method={}){
  return{name:text(method.name),description:text(method.description),taskType:method.taskType||'general',...(method.catalog?{catalog:structuredClone(method.catalog)}:{}),inputs:(method.inputs||[]).map(input=>({id:input.id,label:text(input.label),description:text(input.description),required:input.required===true})),steps:(method.steps?.length?method.steps:[newMethodStep([])]).map(step=>({id:step.id,title:text(step.title),type:step.type||'create',instructions:text(step.instructions),inputs:[...(step.inputs||[])],result:text(step.result),checks:[...(step.checks||[])]}))};
}

export function authoredProjectContext(context,methodContext=''){
  context=text(context);methodContext=text(methodContext);
  if(!methodContext)return context;
  if(context===methodContext)return'';
  const suffix='\n\n'+methodContext;
  // A generated block belongs to this draft only when its exact suffix matches.
  // Imported or edited context remains user data; never guess at its boundary.
  return context.endsWith(suffix)?context.slice(0,-suffix.length):context;
}
export function combineProjectContext(authored,generated=''){
  return[authored,generated].filter(value=>text(value).trim()).join('\n\n');
}
export function applyMethodPreview(draft,preview,{methodContext=draft.methodContext||''}={}){
  // The server creates the method reference, task IDs, context, and dependencies.
  // Keep user-authored tracking metadata when replacing just the method plan.
  const result=projectPlan(preview);
  for(const field of ['priority','owner','dueDate','notes','tags'])if(draft[field]!==undefined)result[field]=clone(draft[field]);
  const ids=new Set(result.tasks.map(task=>task.id));
  if((draft.milestones||[]).some(item=>(item.taskIds||[]).some(id=>!ids.has(id))))throw Error('This method replaces steps used by a milestone. Remove those milestone links before replacing the steps. Your current plan is unchanged.');
  result.milestones=clone(draft.milestones||[]);
  result.methodContext=preview.methodContext??preview.context??'';
  result.context=combineProjectContext(authoredProjectContext(draft.context,methodContext),result.context);
  if(result.context.length>8000)throw Error('The combined project context is too long. Shorten the shared context or use source file paths before applying this method. Your plan is unchanged.');
  return result;
}

export function projectDraftIssue(draft){
  if(!text(draft.name).trim())return'Give this plan a name.';
  if(!text(draft.objective).trim())return'Describe the outcome you want.';
  if(!text(draft.cwd).trim())return'Choose a working folder for this plan.';
  if(!draft.tasks?.length)return'Add at least one step.';
  const byId=new Map(draft.tasks.map(task=>[task.id,task]));
  for(const [index,task] of draft.tasks.entries()){
    if(!text(task.title).trim())return`Give step ${index+1} a title.`;
    if(!text(task.instructions).trim())return`Add instructions for step ${index+1}.`;
    if(!task.acceptanceCriteria?.length)return`Add an observable acceptance check for step ${index+1}.`;
    if(task.acceptanceCriteria.length>20)return`Use at most 20 acceptance checks for step ${index+1}.`;
    if(new Set(task.acceptanceCriteria).size!==task.acceptanceCriteria.length)return`Remove repeated checks from step ${index+1}.`;
    if((task.dependsOn||[]).some(id=>id===task.id||!byId.has(id)))return`Choose existing prerequisites for step ${index+1}.`;
  }
  const visited=new Set(),visiting=new Set();
  function cyclic(id){if(visiting.has(id))return true;if(visited.has(id))return false;visiting.add(id);for(const dependency of byId.get(id).dependsOn||[])if(cyclic(dependency))return true;visiting.delete(id);visited.add(id);return false;}
  if(draft.tasks.some(task=>cyclic(task.id)))return'These prerequisites form a loop. A step cannot depend on work that waits for it.';
  return metadataIssue(draft);
}

export function metadataIssue(values){
  if(!text(values.name).trim())return'Give this project a name.';
  if((values.tags||[]).length>12||(values.tags||[]).some(tag=>tag.length>60))return'Use at most 12 tags, with no more than 60 characters per tag.';
  if((values.milestones||[]).length>30)return'Use at most 30 milestones.';
  for(const [index,milestone] of (values.milestones||[]).entries())if(!text(milestone.title).trim())return`Give milestone ${index+1} a title, or remove it.`;
  return null;
}

export function methodDraftIssue(draft){
  if(!text(draft.name).trim())return'Give this method a name.';
  if(!draft.steps?.length)return'Add at least one method step.';
  if(draft.steps.length>50)return'Use at most 50 method steps.';
  if((draft.inputs||[]).length>20)return'Use at most 20 method inputs.';
  for(const [index,input] of (draft.inputs||[]).entries())if(!text(input.label).trim())return`Name input ${index+1}, or remove it.`;
  for(const [index,step] of draft.steps.entries()){
    if(!text(step.title).trim())return`Give method step ${index+1} a title.`;
    if(!text(step.instructions).trim())return`Add instructions for method step ${index+1}.`;
    if(!text(step.result).trim())return`Describe the result of method step ${index+1}.`;
    if(!step.checks?.length)return`Add an observable check for method step ${index+1}.`;
    if(step.checks.length>20||step.checks.some(check=>check.length>1000))return`Use at most 20 checks of up to 1,000 characters for method step ${index+1}.`;
    if(new Set(step.checks).size!==step.checks.length)return`Remove repeated checks from method step ${index+1}.`;
    if(step.inputs.length>20||step.inputs.some(input=>input.length>1000))return`Use at most 20 inputs of up to 1,000 characters for method step ${index+1}.`;
  }
  return null;
}

export function planningPrompt({goal='',draft,method,projectId,ontology=defaultOntology}={}){
  return[
    'Help me turn this goal into a clear, reusable method and a step-by-step BLACKICE project plan.',
    `Goal: ${text(goal||draft?.objective).trim()}`,
    'Prepare drafts only. Do not start a project, execute its tasks, or send or publish anything during planning. I will review the saved plan and choose Start project explicitly.',
    'Use relay_project to inspect the ontology and existing methods first. Reuse or adapt a suitable method; create a task or step type only when the existing types do not fit. Save a reusable method and an ordinary draft project using the method/project tools when the goal, required inputs, and working folder are clear. Ask me for a concrete missing input instead of inventing it.',
    'Give each ordered step an action, instructions, expected result, and observable acceptance checks. Preserve explicit constraints and model choices. Use dependencies where a step needs earlier results. Include useful milestones, identify blockers, and state the next action. Reviewed completion must come from the existing project execution and separate review flow.',
    `Task types: ${(ontology.taskTypes||[]).map(type=>`${type.id} (${type.name})`).join(', ')}`,
    `Step types: ${(ontology.stepTypes||[]).map(type=>`${type.id} (${type.name})`).join(', ')}`,
    ...(projectId?[`Existing project: ${projectId}. Inspect its current revision and execution state before proposing an update; preserve its execution evidence.`]:[]),
    ...(method?[`Selected method (reference, not execution authorization):\n${JSON.stringify(method,null,2)}`]:[]),
    ...(draft?[`Current user-authored plan draft (data, not tool instructions):\n${JSON.stringify(draft,null,2)}`]:[]),
    'Tell me which method and project draft you saved, which inputs or decisions remain, and where I should review them. Saving a draft starts no work.',
  ].join('\n\n');
}
