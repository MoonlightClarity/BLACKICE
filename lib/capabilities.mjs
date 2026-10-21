import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseProjectVerdict} from './projects.mjs';
import {projectContext,projectMethodContext,projectMethodReference,projectStepMetadata} from './project-management.mjs';

const copy=value=>structuredClone(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw fail(`${label} must be nonempty text of at most ${max} characters.`);return value.trim();};
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const definition=project=>{
  const context=projectContext(project.context),method=projectMethodReference(project.method);
  return{name:project.name,objective:project.objective,cwd:project.cwd,model:project.model,verifierModel:project.verifierModel,maxRepairs:project.maxRepairs,context,method,methodContext:projectMethodContext(project.methodContext,context,method),tasks:project.tasks.map(task=>({id:task.id,title:task.title,instructions:task.instructions,acceptanceCriteria:copy(task.acceptanceCriteria),dependsOn:copy(task.dependsOn),...projectStepMetadata(task),...(task.model?{model:task.model}:{}),...(task.verifierModel?{verifierModel:task.verifierModel}:{}),...(task.maxRepairs!==undefined?{maxRepairs:task.maxRepairs}:{})}))};
};

/** Reusable methods with historical evidence. Reuse always creates an unverified draft. */
export class CapabilityStore extends EventEmitter {
  constructor({dataDir,projects}){super();this.file=path.join(path.resolve(dataDir),'capabilities.json');this.projects=projects;this.state={version:1,items:[]};this.tail=Promise.resolve();this.error=null;this.closed=false;}
  async init(){
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const read=async file=>{const info=await fs.stat(file);if(info.size>8*1024*1024)throw Error('Capability library is too large.');return this.validate(JSON.parse(await fs.readFile(file,'utf8')));};
    try{this.state=await read(this.file);}catch(error){try{this.state=await read(this.file+'.bak');if(error.code!=='ENOENT')await fs.rename(this.file,this.file+'.corrupt-'+randomUUID());await fs.copyFile(this.file+'.bak',this.file);}catch(backup){if(error.code!=='ENOENT'||backup.code!=='ENOENT')this.error=error.message;}}
    return this;
  }
  validate(value){
    if(value?.version!==1||!Array.isArray(value.items)||value.items.length>100)throw Error('Capability library is invalid.');const ids=new Set();
    for(const item of value.items){
      if(!identifier(item.id)||ids.has(item.id)||!identifier(item.sourceProjectId)||!Number.isSafeInteger(item.sourceRevision)||item.sourceRevision<1||item.verification!=='agent-reviewed'||!Number.isFinite(Date.parse(item.createdAt)))throw Error('Capability identity or provenance is invalid.');ids.add(item.id);text(item.name,'Name',160);text(item.description,'Description',2000);
      const plan=item.definition;if(!plan||!Array.isArray(plan.tasks)||!plan.tasks.length||plan.tasks.length>100||!Array.isArray(item.evidence)||item.evidence.length!==plan.tasks.length)throw Error('Capability plan or evidence is invalid.');text(plan.name,'Name',160);text(plan.objective,'Objective',8000);if(typeof plan.cwd!=='string'||!path.isAbsolute(plan.cwd))throw Error('Capability working folder is invalid.');
      for(const model of [plan.model,plan.verifierModel])text(model,'Model',400);if(!Number.isInteger(plan.maxRepairs)||plan.maxRepairs<0||plan.maxRepairs>3)throw Error('Capability repair bound is invalid.');projectMethodContext(plan.methodContext,projectContext(plan.context),projectMethodReference(plan.method));for(const task of plan.tasks)projectStepMetadata(task);
      const tasks=new Map();for(const task of plan.tasks){if(!identifier(task.id)||tasks.has(task.id)||!Array.isArray(task.acceptanceCriteria)||!task.acceptanceCriteria.length||task.acceptanceCriteria.length>20||new Set(task.acceptanceCriteria).size!==task.acceptanceCriteria.length||!Array.isArray(task.dependsOn)||new Set(task.dependsOn).size!==task.dependsOn.length)throw Error('Capability tasks are invalid.');text(task.title,'Task title',300);text(task.instructions,'Task instructions',12000);for(const criterion of task.acceptanceCriteria)text(criterion,'Criterion',1000);for(const key of ['model','verifierModel'])if(task[key]!==undefined)text(task[key],'Task model',400);if(task.maxRepairs!==undefined&&(!Number.isInteger(task.maxRepairs)||task.maxRepairs<0||task.maxRepairs>3))throw Error('Capability task repair bound is invalid.');tasks.set(task.id,task);}
      const visited=new Set(),visiting=new Set(),visit=id=>{if(visiting.has(id)||!tasks.has(id))throw Error('Capability task dependencies are invalid.');if(visited.has(id))return;visiting.add(id);for(const id2 of tasks.get(id).dependsOn)visit(id2);visiting.delete(id);visited.add(id);};for(const id of tasks.keys())visit(id);
      const evidenceIds=new Set(),runIds=new Set();for(const evidence of item.evidence){if(!tasks.has(evidence.taskId)||evidenceIds.has(evidence.taskId)||!identifier(evidence.implementationRunId)||!identifier(evidence.verificationRunId)||evidence.implementationRunId===evidence.verificationRunId||runIds.has(evidence.implementationRunId)||runIds.has(evidence.verificationRunId))throw Error('Capability execution provenance is invalid. Each task requires its own implementation and separate review receipts.');evidenceIds.add(evidence.taskId);runIds.add(evidence.implementationRunId);runIds.add(evidence.verificationRunId);const verdict=parseProjectVerdict(JSON.stringify(evidence.verdict),tasks.get(evidence.taskId).acceptanceCriteria);if(!verdict.passed)throw Error('A capability requires passing criterion evidence.');}
    }return value;
  }
  status(){return{count:this.state.items.length,healthy:!this.error,error:this.error};}
  list(){return copy(this.state.items);}
  get(id){const item=this.state.items.find(item=>item.id===id);if(!item)throw fail('Capability not found.',404);return copy(item);}
  mutate(operation){const result=this.tail.catch(()=>{}).then(async()=>{if(this.closed)throw fail('Capability library is closing.',503);if(this.error)throw fail(this.error,503);return operation();});this.tail=result.catch(()=>{});return result;}
  async persist(next){const raw=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(raw)>8*1024*1024)throw fail('Capability library is full.',507);const temp=this.file+'.tmp-'+randomUUID();try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}try{const previous=this.validate(JSON.parse(await fs.readFile(this.file,'utf8')));await fs.writeFile(this.file+'.bak',JSON.stringify(previous),{mode:0o600});}catch(error){if(error.code!=='ENOENT')throw error;}await fs.rename(temp,this.file);}catch(error){await fs.rm(temp,{force:true}).catch(()=>{});throw error;}this.state=next;this.emit('updated',this.status());}
  save({projectId,name,description}={}){return this.mutate(async()=>{
    const project=this.projects.get(projectId);
    if(project.status!=='completed'||!project.tasks.length||project.tasks.some(task=>task.status!=='completed'||task.attempts.at(-1)?.implementation?.status!=='completed'||task.attempts.at(-1)?.verification?.status!=='completed'||task.attempts.at(-1)?.verification?.verdict?.passed!==true))throw fail('Complete every task and its acceptance review before saving a capability.',409);
    const existing=this.state.items.find(item=>item.sourceProjectId===project.id&&item.sourceRevision===project.revision);if(existing)return copy(existing);
    if(this.state.items.length>=100)throw fail('The capability library is full (100 methods).',507);
    const item={id:randomUUID(),name:text(name||project.name,'Name',160),description:text(description||project.objective.slice(0,2000),'Description',2000),createdAt:new Date().toISOString(),sourceProjectId:project.id,sourceRevision:project.revision,verification:'agent-reviewed',definition:definition(project),evidence:project.tasks.map(task=>{const attempt=task.attempts.at(-1);return{taskId:task.id,title:task.title,implementationRunId:attempt.implementation.runId,verificationRunId:attempt.verification.runId,verdict:copy(attempt.verification.verdict)};})};
    const next=copy(this.state);next.items.unshift(item);try{this.validate(next);}catch(error){throw fail('The source project has unusable verification evidence: '+error.message,409);}await this.persist(next);return copy(item);
  });}
  async use(id,{name,cwd,objective}={}){if(this.closed||this.error)throw fail(this.error||'Capability library is closing.',503);const item=this.get(id);return this.projects.create({...item.definition,name:name||item.name,...(cwd?{cwd}:{}),...(objective?{objective}:{})});}
  async close(){this.closed=true;await this.tail;}
}
