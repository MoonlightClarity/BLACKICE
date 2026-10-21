import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { taskTitle } from '../public/task-title.mjs';
import { validateWorkflow } from './engine.mjs';
import { externalRetryHold } from './external-retry.mjs';

const copy=value=>structuredClone(value),stamp=()=>new Date().toISOString();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const ACTIVE=new Set(['dispatching','running']),TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
const unfinished=item=>item?.status==='queued'||ACTIVE.has(item?.status);
const STATES=new Set(['queued',...ACTIVE,...TERMINAL,'deleted']);
const text=(value,label,max,required=true)=>{if(typeof value!=='string'||value.length>max||value.includes('\0')||required&&!value.trim())throw fail(`${label} must be ${required?'nonempty ':''}text of at most ${max.toLocaleString()} characters.`);return value.trim();};
const folder=value=>{if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))throw fail('Choose an absolute working folder.');return path.resolve(value);};
const sameFolder=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const attachments=value=>{if(value===undefined)return[];if(!Array.isArray(value)||value.length>10||value.some(id=>typeof id!=='string'||!id.length||id.length>160||!/^[a-zA-Z0-9_-]+$/.test(id))||new Set(value).size!==value.length)throw fail('Use at most 10 unique attachment IDs.');return [...value];};
const enqueueKey=value=>value===undefined?null:text(value,'Enqueue key',160);
export function engineAtCapacity(engine){
  if(engine.closed)return true;
  const execution=engine.executionStatus?.();
  if(execution?.unlimited===true)return false;
  if(Number.isFinite(execution?.availableSlots))return execution.availableSlots<=0;
  if(execution?.capacity===null||engine.maxConcurrentRuns===null)return false;
  const active=new Set([...(engine.executions?.keys?.()||[]),...engine.listRuns().filter(run=>run.settled===false||['queued','running','waiting'].includes(run.status)).map(run=>run.id)]),capacity=Number.isSafeInteger(engine.maxConcurrentRuns)&&engine.maxConcurrentRuns>0?engine.maxConcurrentRuns:1;
  return active.size>=capacity;
}
export const INBOX_LIMITS=Object.freeze({items:300,inputChars:50000,titleChars:160,attempts:12,bytes:24*1024*1024,workflowBytes:1024*1024});

const defaultWorkflow=item=>({id:'inbox-task',name:item.title,nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Relay agent',model:'default',prompt:'Complete the requested task using the available tools. Verify the result and report the work performed and any remaining limitations.'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{cwd:item.cwd,maxParallel:1}});

/** A durable intent journal in front of the engine's persisted admission journal. */
export class TaskInbox extends EventEmitter {
  constructor({dataDir,engine,createWorkflow=defaultWorkflow,delayMs=0}={}){
    super();if(!dataDir||!engine||typeof engine.startRun!=='function')throw fail('The task inbox requires storage and an execution engine.');
    this.file=path.join(path.resolve(dataDir),'inbox.json');this.engine=engine;this.createWorkflow=createWorkflow;this.delayMs=delayMs;
    this.state={version:1,settings:{autoRun:false,pauseOnFailure:true,paused:false,pauseReason:null},items:[]};
    this.tail=Promise.resolve();this.ready=null;this.initialized=false;this.closed=false;this.timer=null;this.pauseEpoch=0;this.stopLatch=null;this.lastError=null;this.recovered=false;this.pumping=false;
    this.onEngineEvent=event=>{if(this.closed)return;if(event.type==='execution.settings')this.kick();else if(event.type==='run.updated'&&event.data?.settled===true)this.enqueue(()=>this.reconcileImpl()).then(()=>this.kick(),()=>{});};
  }
  init(){return this.ready||=(async()=>{
    await fs.mkdir(path.dirname(this.file),{recursive:true});let loaded;
    const read=async file=>{if((await fs.stat(file)).size>INBOX_LIMITS.bytes)throw fail('Task inbox exceeds its storage limit.');return this.validateState(JSON.parse(await fs.readFile(file,'utf8')));};
    try{loaded=await read(this.file);}catch(cause){try{loaded=await read(`${this.file}.bak`);if(cause.code!=='ENOENT')await fs.rename(this.file,`${this.file}.corrupt-${randomUUID()}`);this.recovered=true;}catch(backup){if(cause.code!=='ENOENT'||backup.code!=='ENOENT')throw fail(`Cannot load the task inbox: ${cause.message}. Existing files were preserved.`,500);}}
    if(loaded)this.state=loaded;
    const next=copy(this.state);this.reconcileState(next,{restarting:true});
    if(loaded&&next.settings.autoRun){next.settings.paused=true;next.settings.pauseReason='Relay restarted. Check the saved tasks, then resume automatic execution.';}
    await this.save(next);this.initialized=true;this.engine.on?.('event',this.onEngineEvent);return this;
  })();}
  validateState(value){
    if(!object(value)||value.version!==1||!object(value.settings)||!['autoRun','paused','pauseOnFailure'].every(key=>typeof value.settings[key]==='boolean')||!Array.isArray(value.items)||value.items.filter(unfinished).length>INBOX_LIMITS.items)throw fail('Task inbox has an invalid format.');
    const ids=new Set();for(const item of value.items){
      if(!object(item)||typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id)||ids.has(item.id)||!STATES.has(item.status)||!Number.isSafeInteger(item.revision)||item.revision<1||!Array.isArray(item.attempts)||item.attempts.length>INBOX_LIMITS.attempts||item.startWhenIdle!==undefined&&typeof item.startWhenIdle!=='boolean'||item.source!==undefined&&item.source!=='conversation'||item.startWhenIdle===true&&(!item.enqueueKey||item.source!=='conversation'||item.managedBy))throw fail('Task inbox contains an invalid item.');
      ids.add(item.id);text(item.input,'Task',INBOX_LIMITS.inputChars);text(item.title,'Title',INBOX_LIMITS.titleChars);folder(item.cwd);attachments(item.attachmentIds);if(item.enqueueKey!==undefined)enqueueKey(item.enqueueKey);if(item.workflow)this.workflow(item.workflow);for(const attempt of item.attempts)if(!object(attempt)||typeof attempt.dispatchId!=='string')throw fail('Task inbox contains invalid execution history.');
    }
    return value;
  }
  assertOpen(){if(!this.initialized)throw fail('Task inbox is not initialized.',503);if(this.closed)throw fail('Task inbox is shutting down.',503);}
  enqueue(operation){if(this.closed)return Promise.reject(fail('Task inbox is shutting down.',503));const admitted=this.tail.catch(()=>{}).then(operation);this.tail=admitted;return admitted;}
  mutation(operation){try{this.assertOpen();}catch(cause){return Promise.reject(cause);}return this.enqueue(operation);}
  workflow(value){const normalized=validateWorkflow(value);if(Buffer.byteLength(JSON.stringify(normalized))>INBOX_LIMITS.workflowBytes)throw fail('This saved workflow is too large for an inbox task.');return normalized;}
  pinQueueModels(value){
    const workflow=this.workflow(value),runtime=this.engine.runtime;if(!runtime)return workflow;
    for(const node of workflow.nodes.filter(value=>value.type==='agent'&&(!value.model||['default','codex'].includes(value.model)))){
      if(runtime.resolveModel){const selected=runtime.resolveModel(node.model||'default');if(!selected.available||typeof selected.model!=='string'||!selected.model.trim()||['default','codex'].includes(selected.model))throw fail(selected.error||`Choose an available model for ${node.name||'this task'} in Models.`);node.model=selected.providerId==='codex'?selected.model:`${selected.providerId}::${selected.model}`;}
      else{const status=runtime.status(),model=node.model==='codex'?(status.codex?.defaultModel||status.defaultModel):status.defaultModel;if(typeof model!=='string'||!model.trim()||['default','codex'].includes(model))throw fail('Choose an available default model before queueing this task.');node.model=model;}
    }
    return this.workflow(workflow);
  }
  find(state,id){const item=state.items.find(value=>value.id===id);if(!item)throw fail('Inbox task not found.',404);return item;}
  assertAdmissionCapacity(state=this.state){if(state.items.filter(unfinished).length>=INBOX_LIMITS.items)throw fail('The task inbox has 300 unfinished tasks. Finish or remove queued work before adding another task. Existing history and idempotency keys are retained.',507);}
  async save(next){
    if(next.items.filter(unfinished).length>INBOX_LIMITS.items)throw fail('The task inbox has reached its 300 unfinished-task capacity. Existing history and idempotency keys are retained.',507);
    const data=JSON.stringify(next);if(Buffer.byteLength(data)>INBOX_LIMITS.bytes)throw fail('The task inbox has reached its 24 MiB saved-history budget. Existing receipts and idempotency keys were preserved.',507);
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try{try{const current=await fs.readFile(this.file,'utf8');this.validateState(JSON.parse(current));await fs.writeFile(`${this.file}.bak`,current,{mode:0o600});}catch(cause){if(cause.code!=='ENOENT')throw cause;}
      const handle=await fs.open(temporary,'w',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,this.file);this.state=next;this.lastError=null;this.changed();
    }catch(cause){this.lastError=cause.message;this.changed();throw cause;}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  }
  changed(){this.emit('updated',this.status());}
  status(){const items=this.state.items,unfinishedCount=items.filter(unfinished).length;return{count:items.filter(item=>item.status!=='deleted').length,pending:items.filter(item=>item.status==='queued').length,scheduled:items.filter(item=>item.status==='queued'&&item.startWhenIdle===true).length,ready:items.filter(item=>this.eligible(item)).length,active:items.filter(item=>ACTIVE.has(item.status)).length,completed:items.filter(item=>item.status==='completed').length,failed:items.filter(item=>['failed','cancelled','interrupted'].includes(item.status)).length,deleted:items.filter(item=>item.status==='deleted').length,retryHeld:items.filter(item=>['failed','cancelled','interrupted'].includes(item.status)&&item.retryHold).length,retainedHistory:items.length-unfinishedCount,availableCapacity:Math.max(0,INBOX_LIMITS.items-unfinishedCount),capacity:INBOX_LIMITS.items,historyBudgetBytes:INBOX_LIMITS.bytes,autoRun:this.state.settings.autoRun,paused:Boolean(this.stopLatch||this.state.settings.paused),pauseReason:this.stopLatch||this.state.settings.pauseReason,healthy:!this.lastError,error:this.lastError,recovered:this.recovered};}
  snapshot({cwd,includeDeleted=true}={}){const selected=cwd?folder(cwd):null;return{status:this.status(),settings:{...copy(this.state.settings),paused:this.status().paused,pauseReason:this.status().pauseReason},items:copy(this.state.items.filter(item=>(includeDeleted||item.status!=='deleted')&&(!selected||sameFolder(item.cwd,selected))))};}
  get(id){return copy(this.find(this.state,id));}
  getByEnqueueKey(key){const found=this.state.items.find(item=>item.enqueueKey===enqueueKey(key));return found?copy(found):null;}
  eligible(item){return item.status==='queued'&&!item.managedBy&&(this.state.settings.autoRun||item.startWhenIdle===true);}
  nextAutomatic(){return this.state.items.find(item=>this.eligible(item));}
  hasPendingWork(){return!this.closed&&!this.status().paused&&!this.lastError&&this.state.items.some(item=>this.eligible(item));}
  add(value){return this.capture(value);}
  queue(value){return this.capture(value,{startWhenIdle:true});}
  capture(value,{startWhenIdle=false}={}){return this.mutation(async()=>{
    if(!object(value))throw fail('A task is required.');const input=text(value.input,'Task',INBOX_LIMITS.inputChars),cwd=folder(value.cwd),title=text(value.title||taskTitle(input,{max:INBOX_LIMITS.titleChars}),'Title',INBOX_LIMITS.titleChars);
    if(value.managedBy!==undefined&&value.managedBy!=='operations')throw fail('Unknown task manager.');const key=enqueueKey(value.enqueueKey);if(startWhenIdle&&!key)throw fail('Queued conversations need a stable enqueue key.');if(startWhenIdle&&value.managedBy)throw fail('An operation job cannot also be a queued conversation.');const savedWorkflow=value.workflow?this.workflow(value.workflow):null,attachmentIds=attachments(value.attachmentIds),fingerprint=createHash('sha256').update(JSON.stringify({input,cwd,workflow:savedWorkflow,attachmentIds,managedBy:value.managedBy||null,...(startWhenIdle?{startWhenIdle:true}: {})})).digest('hex');
    if(key){const existing=this.state.items.find(item=>item.enqueueKey===key);if(existing){if(existing.enqueueFingerprint!==fingerprint)throw fail('This enqueue key already belongs to a different task.',409);return copy(existing);}}
    this.assertAdmissionCapacity();
    const item={id:randomUUID(),title,input,cwd,attachmentIds,...(savedWorkflow?{workflow:savedWorkflow}:{}),...(key?{enqueueKey:key,enqueueFingerprint:fingerprint}:{}),...(value.managedBy?{managedBy:value.managedBy}:{}),...(startWhenIdle?{startWhenIdle:true,source:'conversation'}:{}),status:'queued',revision:1,createdAt:stamp(),updatedAt:stamp(),runId:null,dispatchId:null,attempts:[]};if(startWhenIdle)item.workflow=this.pinQueueModels(savedWorkflow||await this.createWorkflow(copy(item)));const next=copy(this.state);next.items.push(item);await this.save(next);this.kick();return copy(item);
  });}
  update(id,value){return this.mutation(async()=>{
    if(!object(value)||Object.keys(value).some(key=>!['input','title','cwd','workflow','attachmentIds','expectedRevision'].includes(key)))throw fail('Invalid task edit.');const next=copy(this.state),item=this.find(next,id);if(item.managedBy)throw fail('This task is a saved operation job. Edit its deployment to change future jobs.',409);if(ACTIVE.has(item.status)||item.status==='deleted')throw fail('Finish or stop an active task before editing it, or restore a deleted task first.',409);if(value.expectedRevision!==undefined&&value.expectedRevision!==item.revision)throw fail('This task changed while it was open. Reload it before saving.',409);
    if(value.input!==undefined)item.input=text(value.input,'Task',INBOX_LIMITS.inputChars);if(value.title!==undefined)item.title=text(value.title,'Title',INBOX_LIMITS.titleChars);if(value.cwd!==undefined)item.cwd=folder(value.cwd);if(value.workflow!==undefined)item.workflow=this.workflow(value.workflow);if(value.attachmentIds!==undefined)item.attachmentIds=attachments(value.attachmentIds);item.revision++;item.updatedAt=stamp();await this.save(next);return copy(item);
  });}
  remove(id){return this.mutation(async()=>{const next=copy(this.state),item=this.find(next,id);if(ACTIVE.has(item.status))throw fail('Stop the running task before removing it.',409);if(item.status!=='deleted'){item.deletedFrom=item.status;item.status='deleted';if(item.startWhenIdle)item.startWhenIdle=false;item.revision++;item.updatedAt=stamp();await this.save(next);}return copy(item);});}
  restore(id){return this.mutation(async()=>{const next=copy(this.state),item=this.find(next,id);if(item.status!=='deleted')throw fail('This task is not deleted.',409);item.status=STATES.has(item.deletedFrom)&&!ACTIVE.has(item.deletedFrom)&&item.deletedFrom!=='deleted'?item.deletedFrom:'interrupted';delete item.deletedFrom;item.revision++;item.updatedAt=stamp();await this.save(next);this.kick();return copy(item);});}
  reorder(ids){return this.mutation(async()=>{const queued=this.state.items.filter(item=>item.status==='queued');if(!Array.isArray(ids)||ids.length!==queued.length||new Set(ids).size!==ids.length||ids.some(id=>!queued.some(item=>item.id===id)))throw fail('Include every queued task exactly once in the desired order.');const next=copy(this.state),ordered=ids.map(id=>this.find(next,id));let index=0;next.items=next.items.map(item=>item.status==='queued'?ordered[index++]:item);await this.save(next);return this.snapshot();});}
  configure(value){return this.mutation(async()=>{if(!object(value)||Object.keys(value).some(key=>!['autoRun','pauseOnFailure'].includes(key))||Object.values(value).some(flag=>typeof flag!=='boolean'))throw fail('Choose automatic execution and pause-on-failure using true or false.');const next=copy(this.state);Object.assign(next.settings,value);await this.save(next);this.kick();return this.status();});}
  pause(reason='Automatic execution was paused.'){this.pauseEpoch++;this.stopLatch=typeof reason==='string'&&reason.trim()?reason.trim().slice(0,600):'Automatic execution was paused.';clearTimeout(this.timer);this.timer=null;this.changed();return this.mutation(async()=>{const next=copy(this.state);next.settings.paused=true;next.settings.pauseReason=this.stopLatch;await this.save(next);return this.status();});}
  resume(){const epoch=this.pauseEpoch;return this.mutation(async()=>{const next=copy(this.state);next.settings.paused=false;next.settings.pauseReason=null;await this.save(next);if(this.pauseEpoch===epoch)this.stopLatch=null;this.changed();this.kick();return this.status();});}
  retryHold(item,runs=this.engine.listRuns()){return externalRetryHold({existing:item.retryHold,runIds:[item.runId,...item.attempts.map(attempt=>attempt.runId)],runs});}
  retry(id){return this.mutation(async()=>{const next=copy(this.state),item=this.find(next,id);if(item.managedBy)throw Object.assign(fail('This task belongs to a saved operation. Inspect and retry its job in Schedules & jobs.',409),{code:'MANAGED_TASK'});if(!['failed','cancelled','interrupted'].includes(item.status))throw fail('Only a failed, cancelled or interrupted task can be requeued.',409);const hold=this.retryHold(item);if(hold){item.retryHold=hold;await this.save(next);throw Object.assign(fail(hold.message,409),{code:hold.code,runId:hold.runId});}item.status='queued';item.runId=null;item.dispatchId=null;item.error=null;if(item.startWhenIdle)item.startWhenIdle=false;item.updatedAt=stamp();item.revision++;await this.save(next);this.kick();return copy(item);});}
  runNow(id,{managedBy}={}){const epoch=this.pauseEpoch;return this.mutation(()=>{const item=this.find(this.state,id);if(item.managedBy&&item.managedBy!==managedBy)throw Object.assign(fail('This task belongs to a saved operation. Use Schedules & jobs so its pause, retry and execution receipts stay together.',409),{code:'MANAGED_TASK'});return this.dispatch(id,{automatic:false,epoch});});}
  kick(){if(this.closed||this.timer||this.pumping||!this.hasPendingWork()||!this.nextAutomatic())return;this.timer=setTimeout(()=>{this.timer=null;void this.pump();},this.delayMs);this.timer.unref?.();}
  async pump(){
    if(this.closed||this.pumping||!this.hasPendingWork())return;this.pumping=true;
    try{await this.enqueue(async()=>{if(!this.hasPendingWork()||this.engineBusy())return;const item=this.nextAutomatic();if(item)await this.dispatch(item.id,{automatic:true,epoch:this.pauseEpoch});});}catch(cause){if(!this.closed&&!this.status().paused){try{await this.pause(`An inbox task could not start: ${cause.message}`);}catch{this.stopLatch='The task inbox could not save its state. Automatic execution is paused.';this.changed();}}}finally{this.pumping=false;if(!this.closed&&this.hasPendingWork()&&!this.engineBusy()&&this.nextAutomatic())this.kick();}
  }
  engineBusy(){return engineAtCapacity(this.engine);}
  async dispatch(id,{automatic,epoch}){
    // A settlement event can be queued behind this dispatch. Apply its outcome
    // before admitting another task, so an earlier pump cannot bypass a failure pause.
    const reconciled=copy(this.state);if(this.reconcileState(reconciled))await this.save(reconciled);
    const item=this.find(this.state,id);if(item.status!=='queued')throw fail('Choose a queued task. Requeue a failed or interrupted task explicitly before starting it.',409);const hold=this.retryHold(item);if(hold){const blocked=copy(this.state),saved=this.find(blocked,id);saved.retryHold=hold;saved.status='interrupted';saved.error=hold.message;saved.updatedAt=stamp();saved.revision++;await this.save(blocked);throw Object.assign(fail(hold.message,409),{code:hold.code,runId:hold.runId});}if(this.engineBusy())throw fail('All agent slots are active or stopping. This task is saved in the inbox.',409);if(this.closed||epoch!==this.pauseEpoch||automatic&&(!this.hasPendingWork()||!this.eligible(item)))throw fail('The queued start was stopped before execution.',409);
    const workflow=this.workflow(item.workflow||await this.createWorkflow(copy(item)));if(this.closed||epoch!==this.pauseEpoch||automatic&&(!this.hasPendingWork()||!this.eligible(this.find(this.state,id))))throw fail('The queued start was stopped before execution.',409);
    const dispatchId=randomUUID(),next=copy(this.state),intent=this.find(next,id);intent.workflow=workflow;intent.status='dispatching';intent.dispatchId=dispatchId;intent.updatedAt=stamp();intent.revision++;intent.attempts.push({dispatchId,runId:null,status:'dispatching',startedAt:stamp(),finishedAt:null});intent.attempts=intent.attempts.slice(-INBOX_LIMITS.attempts);await this.save(next);
    if(this.closed||epoch!==this.pauseEpoch||automatic&&this.status().paused){const stopped=copy(this.state),value=this.find(stopped,id);value.status='queued';value.dispatchId=null;value.attempts.at(-1).status='cancelled_before_start';value.attempts.at(-1).finishedAt=stamp();await this.save(stopped);throw fail('The queued start was stopped before execution.',409);}
    let run,admissionRecovered=false;
    try{run=await this.engine.startRun({workflow,input:{task:item.input,cwd:item.cwd,attachmentIds:[...(item.attachmentIds||[])]},metadata:{inboxId:id,inboxDispatchId:dispatchId}});}catch(cause){
      // Admission can succeed before its acknowledgement fails. The engine's
      // exact dispatch receipt is authoritative; clearing this intent would
      // let a later resume execute the same real-world task a second time.
      const admitted=this.engine.listRuns().filter(value=>value.metadata?.inboxId===id&&value.metadata?.inboxDispatchId===dispatchId);
      if(admitted.length===1){run=admitted[0];admissionRecovered=true;}
      else if(admitted.length>1){const uncertain=copy(this.state),value=this.find(uncertain,id);value.status='interrupted';value.error='More than one run matches this dispatch. Inspect the run history before retrying.';value.updatedAt=stamp();Object.assign(value.attempts.at(-1),{status:'interrupted',error:value.error,finishedAt:stamp()});uncertain.settings.paused=true;uncertain.settings.pauseReason='An inbox task has an uncertain outcome. Inspect it before resuming.';await this.save(uncertain);throw fail(value.error,409);}
      else{
      const deferred=cause.status===409&&this.engineBusy(),localRejection=!deferred&&item.managedBy==='operations'&&Number.isInteger(cause.status)&&cause.status>=400&&cause.status<500,rejected=copy(this.state),value=this.find(rejected,id);value.status=localRejection?'failed':'queued';value.dispatchId=null;value.error=deferred?null:cause.message;value.attempts.at(-1).status=deferred?'deferred':localRejection?'failed':'not_started';value.attempts.at(-1).error=cause.message;value.attempts.at(-1).finishedAt=stamp();if(localRejection)value.finishedAt=stamp();if(!deferred&&!localRejection){rejected.settings.paused=true;rejected.settings.pauseReason=`An inbox task could not start: ${cause.message}`;}await this.save(rejected);if(deferred&&automatic)return{item:this.get(id),run:null,deferred:true};throw cause;
      }
    }
    // A failed bind write keeps the durable dispatch intent. Restart reconciliation finds the engine's metadata.
    const bound=copy(this.state),value=this.find(bound,id);value.status='running';value.runId=run.id;value.updatedAt=stamp();value.attempts.at(-1).runId=run.id;value.attempts.at(-1).status='running';if(admissionRecovered)value.attempts.at(-1).admissionRecovered=true;await this.save(bound);await this.reconcileImpl();return{item:this.get(id),run:copy(run),...(admissionRecovered?{admissionRecovered:true}:{})};
  }
  reconcileState(next,{restarting=false}={}){
    const runs=this.engine.listRuns();let changed=false;
    for(const item of next.items.filter(value=>ACTIVE.has(value.status))){
      const matches=runs.filter(run=>run.metadata?.inboxId===item.id&&run.metadata?.inboxDispatchId===item.dispatchId),bound=runs.find(run=>run.id===item.runId),mismatched=bound&&(bound.metadata?.inboxId!==item.id||bound.metadata?.inboxDispatchId!==item.dispatchId),attempt=item.attempts.find(value=>value.dispatchId===item.dispatchId);
      if(matches.length!==1||mismatched){if(!restarting&&matches.length===0&&!mismatched)continue;const hold=this.retryHold(item,runs);if(hold)item.retryHold=hold;item.status='interrupted';item.revision++;item.error=mismatched?'The saved run belongs to another dispatch. Inspect the actual execution receipts before retrying.':matches.length?'More than one run matches this dispatch. Inspect the run history before retrying.':'Relay stopped before this task could be linked to a saved run. Inspect the workspace before explicitly requeuing it.';item.updatedAt=stamp();if(attempt){attempt.status='interrupted';attempt.error=item.error;attempt.finishedAt=stamp();}next.settings.paused=true;next.settings.pauseReason='An inbox task has an uncertain outcome. Inspect it before resuming.';changed=true;continue;}
      const run=matches[0];if(item.runId!==run.id){item.runId=run.id;if(attempt)attempt.runId=run.id;changed=true;}
      if(run.settled!==false&&['completed','failed','cancelled'].includes(run.status)){
        item.status=run.status;if(run.status!=='completed'){const hold=this.retryHold(item,runs);if(hold)item.retryHold=hold;}item.error=run.error||null;item.finishedAt=run.finishedAt||stamp();item.updatedAt=stamp();item.revision++;if(attempt)Object.assign(attempt,{status:run.status,finishedAt:item.finishedAt,...(run.error?{error:run.error}:{})});
        const isolatedStop=run.status==='cancelled'&&(item.source==='conversation'||item.managedBy==='operations');
        if(run.status!=='completed'&&next.settings.pauseOnFailure&&!isolatedStop&&!(item.managedBy==='operations'&&run.status==='failed')){next.settings.paused=true;next.settings.pauseReason=`The last inbox task ${run.status}. Inspect its result, then resume automatic execution.`;}changed=true;
      }else if(restarting){const hold=this.retryHold(item,runs);if(hold)item.retryHold=hold;item.status='interrupted';item.revision++;item.error='The saved run is not settled. Inspect its outcome before explicitly requeuing this task.';next.settings.paused=true;next.settings.pauseReason='An inbox task was interrupted.';if(attempt){attempt.status='interrupted';attempt.error=item.error;}changed=true;}
    }
    return changed;
  }
  async reconcileImpl(){const next=copy(this.state);if(this.reconcileState(next))await this.save(next);return this.snapshot();}
  reconcile(){return this.mutation(()=>this.reconcileImpl());}
  close(){if(this.closePromise)return this.closePromise;this.closed=true;this.pauseEpoch++;clearTimeout(this.timer);this.timer=null;this.engine.off?.('event',this.onEngineEvent);return this.closePromise=(async()=>{await this.tail.catch(()=>{});if(this.lastError)throw fail(`Task inbox could not finish saving: ${this.lastError}`,500);})();}
}
