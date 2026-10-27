import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAutomaticKnowledgeAdmission } from './analysis-quality.mjs';

const copy=value=>structuredClone(value), now=()=>new Date().toISOString();
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const abort=()=>Object.assign(error('Learning review cancelled.'),{name:'AbortError'});
const check=signal=>{if(signal?.aborted)throw abort();};
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const workspace=value=>{if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))throw error('Learning needs an absolute working folder.');return path.resolve(value);};
const scope=value=>process.platform==='win32'?value.toLowerCase():value;
const same=(a,b)=>scope(a)===scope(b);
const bounded=(value,label,max,required=true)=>{if(typeof value!=='string'||value.length>max||value.includes('\0')||(required&&!value.trim()))throw error(`${label} must be ${required?'nonempty ':''}text of at most ${max} characters.`);return value.trim();};
const secret=/(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|password|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?[^\s"']{8,})/i;
const clean=value=>String(value||'').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g,'[redacted]').replace(/((?:api[_ -]?key|password|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*)[^\s]+/gi,'$1[redacted]');
const clip=(value,max)=>clean(value).slice(0,max);
const terminal=run=>run&&['completed','failed','cancelled'].includes(run.status)&&run.settled!==false;
const lessonRevision=item=>({revision:item.revision,title:item.title,summary:item.summary,content:item.content,whenToUse:item.whenToUse,verification:item.verification,confidence:item.confidence,evidence:copy(item.evidence),status:item.status,at:item.updatedAt,...(item.provenance?{provenance:copy(item.provenance)}:{}),...(item.profileEntry?{profileEntry:copy(item.profileEntry),profileUpdated:item.profileUpdated===true}:{})});
const retainedReviews=reviews=>{const result=[...reviews];while(result.length>LEARNING_LIMITS.reviews){const index=result.findIndex(item=>!['queued','running','committing','interrupted'].includes(item.status));if(index<0)break;result.splice(index,1);}return result;};
export const LEARNING_LIMITS=Object.freeze({reviews:150,lessons:200,feedback:300,history:8,proposals:6,evidenceChars:36000,contextChars:6000,bytes:16*1024*1024});

export const LEARNING_TOOL={type:'function',name:'relay_learn',description:'Record an evidence-backed lesson, reusable skill or explicit user fact from this review. Record needs kind, key, title, content and evidence; include a short summary when useful, otherwise title is used. Writes commit automatically after the review finishes. Cite exact quotes from provided evidence IDs. Use a stable topic key to improve an existing lesson instead of creating duplicates. Check record receipts and repair rejected calls before finish. Finish even when no durable learning is warranted. This adapts local skills/context, never model weights or application code.',inputSchema:{type:'object',additionalProperties:false,required:['action'],anyOf:[{properties:{action:{enum:['record']}},required:['action','kind','key','title','content','evidence']},{properties:{action:{enum:['finish']}},required:['action','summaryOfReview']}],properties:{
  action:{type:'string',enum:['record','finish']},kind:{type:'string',enum:['strategy','skill','fact']},key:{type:'string',maxLength:80},title:{type:'string',maxLength:120},summary:{type:'string',maxLength:400},content:{type:'string',maxLength:12000},whenToUse:{type:'string',maxLength:1200},verification:{type:'string',maxLength:2000},evidence:{type:'array',minItems:1,maxItems:5,items:{type:'object',additionalProperties:false,required:['id','quote'],properties:{id:{type:'string',maxLength:100},quote:{type:'string',minLength:8,maxLength:1200}}}},summaryOfReview:{type:'string',maxLength:1600}
}}};

/** Only recorded observations and direct user text enter the reflection evidence pack. */
export function buildLearningEvidence(run,feedback=[]){
  if(!terminal(run))throw error('Wait for the run to finish stopping before reviewing it.',409);
  const entries=[{id:'task',kind:'user',text:clip(run.input,8000)},{id:'outcome',kind:'outcome',text:clip(JSON.stringify({status:run.status,output:run.output,error:run.error}),7000)}];
  let used=entries.reduce((sum,item)=>sum+item.text.length,0),truncated=String(run.input||'').length>8000||String(run.output||'').length>6800;
  for(const [id,node]of Object.entries(run.nodes||{}).filter(([id])=>run.workflow?.nodes?.find(item=>item.id===id)?.type==='agent').slice(0,12)){
    const text=clip(JSON.stringify({nodeId:id,name:run.workflow?.nodes?.find(item=>item.id===id)?.name,status:node.status,output:node.output,error:node.error}),1400);
    if(used+text.length>26000){truncated=true;break;}entries.push({id:`node_${id}`,kind:'agent_result',text});used+=text.length;
  }
  const events=(run.events||[]).filter(event=>!['delta','message','reasoning'].includes(event.data?.type)&&event.data?.item?.type!=='reasoning').slice(-35);
  for(let index=0;index<events.length;index++){
    const event=events[index],data=event.data||{};
    const text=clip(JSON.stringify({at:event.at,nodeId:event.nodeId,type:data.type,action:data.action,tool:data.tool,status:data.status,message:data.message,item:data.item?{type:data.item.type,command:data.item.command,exitCode:data.item.exitCode,status:data.item.status,output:data.item.aggregatedOutput?.slice(0,400)}:undefined}),700);
    if(used+text.length>LEARNING_LIMITS.evidenceChars){truncated=true;break;}entries.push({id:`event_${index}`,kind:'observed_action',text});used+=text.length;
  }
  for(const item of feedback.slice(-4)){const text=clip(item.comment||`The user rated this result ${item.value}.`,2200);if(used+text.length>LEARNING_LIMITS.evidenceChars){truncated=true;break;}entries.push({id:`feedback_${item.id}`,kind:item.comment?.trim()?'user_feedback':'feedback_signal',rating:item.value,text});used+=text.length;}
  return{runId:run.id,cwd:workspace(run.cwd),status:run.status,createdAt:run.createdAt,finishedAt:run.finishedAt,entries,truncated};
}

/** Durable, evidence-linked skill/strategy adaptation; no application source or model weights are modified. */
export class LearningStore extends EventEmitter{
  constructor({dataDir,runtime,knowledge,getRun,isForegroundBusy=()=>false,onProfileFact,onProfileFactUndo,getRuntimeSettings,delayMs=800,reviewTimeoutMs=90000,io=fs}={}){
    super();if(!dataDir||!runtime||!knowledge||typeof getRun!=='function')throw error('Learning requires storage, runtime, knowledge and run access.');
    this.file=path.join(path.resolve(dataDir),'learning.json');this.runtime=runtime;this.knowledge=knowledge;this.getRun=getRun;this.isForegroundBusy=isForegroundBusy;this.onProfileFact=onProfileFact;this.onProfileFactUndo=onProfileFactUndo;this.getRuntimeSettings=getRuntimeSettings;this.io=io;this.delayMs=delayMs;this.reviewTimeoutMs=reviewTimeoutMs;
    // Saved choices are loaded unchanged in init; only a genuinely new profile gets this default.
    this.settings={mode:'auto'};this.reviews=[];this.lessons=[];this.feedbackEntries=[];this.queue=[];this.active=null;this.timer=null;this.writes=Promise.resolve();this.admissions=Promise.resolve();this.operations=new Set();this.closed=false;this.initialized=false;this.lastError=null;this.recovered=false;
  }
  async init(){
    await this.io.mkdir(path.dirname(this.file),{recursive:true});
    const read=async file=>{if((await this.io.stat(file)).size>LEARNING_LIMITS.bytes)throw error('Learning history exceeds its storage limit.');const data=JSON.parse(await this.io.readFile(file,'utf8'));if(data.version!==1||!['auto','manual','off'].includes(data.settings?.mode)||!Array.isArray(data.reviews)||!Array.isArray(data.lessons)||!Array.isArray(data.feedback)||data.lessons.length>LEARNING_LIMITS.lessons||data.feedback.length>LEARNING_LIMITS.feedback)throw error('Learning history has an invalid format.');for(const item of [...data.reviews,...data.lessons,...data.feedback])if(!plain(item)||typeof item.id!=='string'||!path.isAbsolute(item.cwd||''))throw error('Learning history contains an invalid record.');for(const item of data.lessons)if(!['strategy','skill','fact'].includes(item.kind)||typeof item.content!=='string'||!Array.isArray(item.evidence)||!Array.isArray(item.history)||!Number.isSafeInteger(item.revision))throw error('Learning history contains an invalid lesson.');return data;};
    let data;
    try{data=await read(this.file);}catch(cause){try{data=await read(`${this.file}.bak`);if(cause.code!=='ENOENT')await this.io.rename(this.file,`${this.file}.corrupt-${randomUUID()}`);this.recovered=true;}catch(backup){if(cause.code!=='ENOENT'||backup.code!=='ENOENT')throw error(`Cannot load learning history: ${cause.message}. Existing files were preserved.`,500);}}
    if(data){this.settings=data.settings;this.reviews=data.reviews;this.lessons=data.lessons;this.feedbackEntries=data.feedback;}
    for(const review of this.reviews){
      if(['queued','running','committing'].includes(review.status)){
        // Recover only changes whose actual knowledge write carries this review's provenance.
        for(const pending of review.pendingChanges||[]){try{const saved=this.knowledge.get(pending.knowledgeId);if(saved.provenance?.nodeId===`learning-${review.id}`){const index=this.lessons.findIndex(item=>item.id===pending.id);const recovered={...pending,knowledgeRevision:saved.revision};if(index<0)this.lessons.push(recovered);else this.lessons[index]=recovered;review.committedIds=[...new Set([...(review.committedIds||[]),pending.id])];}}catch{}}
        review.status='interrupted';review.error='Relay restarted during this review. Confirmed knowledge writes were retained; retry the review for anything unfinished.';review.finishedAt=now();delete review.pendingChanges;
      }
    }
    this.initialized=true;await this.persist();return this;
  }
  assertOpen(){if(!this.initialized)throw error('Learning is not initialized.',503);if(this.closed)throw error('Learning is shutting down.',503);}
  track(operation){this.assertOpen();const promise=operation();this.operations.add(promise);promise.then(()=>this.operations.delete(promise),()=>this.operations.delete(promise));return promise;}
  serializeAdmission(operation){const pending=this.admissions.catch(()=>{}).then(operation);this.admissions=pending;return pending;}
  updateSettings(value){return this.track(()=>this.serializeAdmission(()=>this.updateSettingsImpl(value)));}
  scheduleAfterRun(run){return this.track(()=>this.serializeAdmission(()=>this.scheduleAfterRunImpl(run)));}
  learnNow(runId,options){return this.track(()=>this.serializeAdmission(()=>this.learnNowImpl(runId,options)));}
  feedback(runId,value,comment){return this.track(()=>this.serializeAdmission(()=>this.feedbackImpl(runId,value,comment)));}
  removeLesson(id){return this.track(()=>this.removeLessonImpl(id));}
  recordKnowledgeChange(entry){return this.track(()=>this.recordKnowledgeChangeImpl(entry));}
  recordKnowledgeDeletion(id,entry){return this.track(()=>this.recordKnowledgeDeletionImpl(id,entry));}
  restoreLesson(id,revision){return this.track(()=>this.restoreLessonImpl(id,revision));}
  persist({admitReview,addFeedback}={}){
    this.writes=this.writes.catch(()=>{}).then(async()=>{
      // Build each snapshot when its write begins. A later write cannot resurrect a rejected admission.
      const reviews=retainedReviews(admitReview?[...this.reviews,admitReview]:this.reviews),feedback=(addFeedback?[...this.feedbackEntries,addFeedback]:this.feedbackEntries).slice(-LEARNING_LIMITS.feedback);
      const snapshot=JSON.stringify({version:1,settings:this.settings,reviews,lessons:this.lessons,feedback});
      if(Buffer.byteLength(snapshot)>LEARNING_LIMITS.bytes)throw error('Learning history is full. Remove an old learned item before saving more.',507);
      const temp=`${this.file}.${randomUUID()}.tmp`;
      try{
        try{const previous=await this.io.readFile(this.file,'utf8');if(JSON.parse(previous).version===1)await this.io.writeFile(`${this.file}.bak`,previous,{mode:0o600});}catch(cause){if(cause.code!=='ENOENT')throw cause;}
        const handle=await this.io.open(temp,'w',0o600);try{await handle.writeFile(snapshot);await handle.sync();}finally{await handle.close();}
        await this.io.rename(temp,this.file);
        if(admitReview){this.reviews.push(admitReview);this.queue.push(admitReview.id);}
        this.reviews=retainedReviews(this.reviews);
        if(addFeedback)this.feedbackEntries=feedback;
        this.lastError=null;
      }finally{await this.io.rm(temp,{force:true}).catch(()=>{});}
    }).catch(cause=>{this.lastError=cause.message;this.changed();throw cause;});return this.writes;
  }
  changed(){this.emit('updated',this.status());}
  status(){return{mode:this.settings.mode,enabled:this.settings.mode!=='off',activeReviewId:this.active?.review.id||null,activeRunId:this.active?.review.runId||null,queued:this.queue.length,reviews:this.reviews.length,lessons:this.lessons.filter(item=>item.status!=='deleted').length,skills:this.lessons.filter(item=>item.kind==='skill'&&item.status!=='deleted').length,facts:this.lessons.filter(item=>item.kind==='fact'&&item.status!=='deleted').length,healthy:!this.lastError,error:this.lastError,recovered:this.recovered,adaptation:'Evidence-backed local skills and strategies; no model training or application code changes.'};}
  listReviews({cwd,limit=60}={}){return copy(this.reviews.filter(item=>!cwd||same(item.cwd,workspace(cwd))).slice(-Math.min(150,Math.max(1,limit))).reverse());}
  lessonView(item){let knowledge=null;try{knowledge=this.knowledge.get(item.knowledgeId);}catch{}return{...copy(item),...(knowledge?{title:knowledge.title,summary:knowledge.summary,content:knowledge.content,knowledgeRevision:knowledge.revision,knowledgeProvenance:copy(knowledge.provenance),userEdited:knowledge.provenance?.source==='user'}:{missingKnowledge:true,userEdited:item.provenance?.source==='user'})};}
  listLessons({cwd,includeDeleted=true}={}){return this.lessons.filter(item=>(!cwd||same(item.cwd,workspace(cwd)))&&(includeDeleted||item.status!=='deleted')).map(item=>this.lessonView(item)).reverse();}
  snapshot({cwd}={}){return{status:this.status(),settings:copy(this.settings),reviews:this.listReviews({cwd}),lessons:this.listLessons({cwd}),feedback:copy(this.feedbackEntries.filter(item=>!cwd||same(item.cwd,workspace(cwd))).slice(-60).reverse())};}
  getReview(id){const value=this.reviews.find(item=>item.id===id);if(!value)throw error('Learning review not found.',404);return copy(value);}
  getContext(cwd,{query='',maxChars=LEARNING_LIMITS.contextChars}={}){
    const result={lessons:[],skills:[],facts:[],truncated:false};if(this.settings.mode==='off')return result;
    const terms=String(query).toLowerCase().split(/\W+/).filter(word=>word.length>2).slice(0,20),budget=Math.min(12000,Math.max(500,Number(maxChars)||LEARNING_LIMITS.contextChars));
    const entries=this.listLessons({cwd,includeDeleted:false}),admit=createAutomaticKnowledgeAdmission(entries);
    const candidates=entries.filter(item=>!item.missingKnowledge&&admit(item)).map(item=>({item,score:terms.reduce((sum,term)=>sum+Number(`${item.title} ${item.summary} ${item.whenToUse}`.toLowerCase().includes(term)),0)})).filter(({item,score})=>item.kind==='fact'||!terms.length||score>0).sort((a,b)=>b.score-a.score||b.item.updatedAt.localeCompare(a.item.updatedAt));
    for(const{item}of candidates){const collection=item.kind==='fact'?result.facts:item.kind==='skill'?result.skills:result.lessons;const value={id:item.id,knowledgeId:item.knowledgeId,title:item.title,summary:item.summary,confidence:item.confidence,whenToUse:item.whenToUse,userEdited:item.userEdited===true,provenance:copy(item.provenance),knowledgeProvenance:copy(item.knowledgeProvenance),evidenceRunIds:[...new Set(item.evidence.map(e=>e.runId))],...(item.kind==='skill'?{}:{guidance:item.content.slice(0,item.kind==='fact'?1000:1600)})};collection.push(value);if(JSON.stringify(result).length>budget){collection.pop();result.truncated=true;continue;}if(collection.length>=8){result.truncated=true;break;}}
    return result;
  }
  async updateSettingsImpl(value){this.assertOpen();if(!plain(value)||!['auto','manual','off'].includes(value.mode))throw error('Choose automatic, manual or off learning.');this.settings={mode:value.mode};if(value.mode!=='auto'){for(const id of this.queue){const review=this.reviews.find(item=>item.id===id);if(review&&(value.mode==='off'||review.reason!=='manual')){review.status='cancelled';review.error=value.mode==='off'?'Learning was turned off.':'Automatic learning was disabled.';review.finishedAt=now();}}this.queue=this.queue.filter(id=>this.reviews.find(item=>item.id===id)?.status==='queued');}if(value.mode==='off'||(value.mode==='manual'&&this.active&&this.active.review.reason!=='manual'))await this.cancelBackground(value.mode==='off'?'Learning turned off.':'Automatic learning was disabled.');await this.persist();this.changed();if(value.mode==='auto')this.kick();return this.status();}
  async scheduleAfterRunImpl(run){this.assertOpen();if(this.settings.mode!=='auto'||!terminal(run))return null;return this.enqueueImpl(run,'automatic');}
  async learnNowImpl(runId,{force=false}={}){this.assertOpen();if(this.settings.mode==='off')throw error('Learning is off. Select manual or automatic learning first.',409);const run=await this.getRun(runId);this.assertOpen();return this.enqueueImpl(run,'manual',{force});}
  async retryReview(id){return this.learnNow(this.getReview(id).runId,{force:true});}
  async feedbackImpl(runId,value,comment=''){
    this.assertOpen();if(!['good','bad'].includes(value))throw error('Feedback must be good or bad.');bounded(comment,'Feedback',2000,false);const run=await this.getRun(runId);this.assertOpen();if(!terminal(run))throw error('Wait for the task to finish before reviewing its result.',409);
    const record={id:randomUUID(),runId,cwd:workspace(run.cwd),value,comment:clean(comment),createdAt:now()};await this.persist({addFeedback:record});this.changed();if(this.settings.mode==='auto')await this.enqueueImpl(run,'feedback');return copy(record);
  }
  enqueue(run,reason,options){return this.serializeAdmission(()=>this.enqueueImpl(run,reason,options));}
  async enqueueImpl(run,reason,{force=false}={}){
    this.assertOpen();
    if(!terminal(run))throw error('Wait for the run to finish before learning from it.',409);
    const feedback=this.feedbackEntries.filter(item=>item.runId===run.id),evidence=buildLearningEvidence(run,feedback),fingerprint=hash(JSON.stringify(evidence));
    const duplicate=[...this.reviews].reverse().find(item=>item.fingerprint===fingerprint&&!['failed','cancelled','interrupted'].includes(item.status));if(duplicate&&!force)return copy(duplicate);
    const agent=run.workflow?.nodes?.filter(item=>item.type==='agent').at(-1),actual=[...(run.events||[])].reverse().find(event=>event.data?.type==='thread'&&event.data?.model)?.data?.model;
    const review={id:randomUUID(),runId:run.id,cwd:evidence.cwd,workflowName:run.workflowName||'Task',status:'queued',reason,fingerprint,createdAt:now(),startedAt:null,finishedAt:null,model:actual||((agent?.model&&agent.model!=='default')?agent.model:this.runtime.status().defaultModel)||null,codexHistory:this.getRuntimeSettings?.()?.codexHistory==='relay'?'relay':'codex',evidence,feedbackIds:feedback.map(item=>item.id),committedIds:[],summary:'',usage:null};
    await this.persist({admitReview:review});this.changed();this.kick();return copy(review);
  }
  kick(delay=this.delayMs){if(this.closed||this.settings.mode==='off'||this.active||this.timer||!this.queue.length)return;this.timer=setTimeout(()=>{this.timer=null;void this.pump().catch(cause=>{this.lastError=cause.message;this.changed();});},delay);this.timer.unref?.();}
  async pump(){
    if(this.closed||this.settings.mode==='off'||this.active||!this.queue.length)return;if(this.isForegroundBusy()){this.kick(400);return;}
    const id=this.queue.shift(),review=this.reviews.find(item=>item.id===id);if(!review||review.status!=='queued'){this.kick();return;}
    const controller=new AbortController(),active={review,controller,committing:false,promise:null};this.active=active;
    active.promise=this.executeReview(active).finally(()=>{if(this.active===active)this.active=null;this.changed();this.kick();});await active.promise;
  }
  async executeReview(active){
    const{review,controller}=active,signal=controller.signal;review.status='running';review.startedAt=now();review.toolReceipts=[];review.acceptedProposalCount=0;this.changed();
    const proposals=[],evidenceMap=new Map(review.evidence.entries.map(item=>[item.id,item]));let finished=false,calls=0;
    const savedCatalog=this.knowledge.context(review.cwd),existingKnowledge=Object.fromEntries(['memories','skills'].map(kind=>[kind,(savedCatalog[kind]||[]).map(item=>({id:item.id,revision:item.revision,title:clip(item.title,120),summary:clip(item.summary,180),scope:item.scope}))]));
    while(JSON.stringify(existingKnowledge).length>LEARNING_LIMITS.contextChars){const collection=existingKnowledge.skills.length>=existingKnowledge.memories.length?existingKnowledge.skills:existingKnowledge.memories;collection.pop();}
    const existing=this.listLessons({cwd:review.cwd,includeDeleted:false}).slice(0,50).map(item=>({id:item.id,key:item.key,kind:item.kind,title:item.title,summary:item.summary,content:item.kind==='skill'?item.content.slice(0,5000):item.content.slice(0,1600),revision:item.revision,confidence:item.confidence,userEdited:item.userEdited===true}));
    const prompt=`You are Relay's post-task learning reviewer. Review only the evidence below. This is strategy and skill adaptation, NOT model training. Do not execute commands, browse, inspect the filesystem, alter application code, or use any tool except relay_learn. Never claim benchmark gains or successful verification that the evidence does not show.\n\nExtract at most 6 useful durable items; zero is valid. Prefer updating the same stable topic key instead of duplicates. The existing saved knowledge catalog also includes memories and skills saved directly during the task. When a durable item is already covered by a saved memory or skill, make zero new records for it. Do not duplicate direct saved entries under a new learning key or rewrite them merely to rephrase the same guidance. Preserve manually edited items; do not replace the user's corrections. Save only a durable preference, repeated constraint, reusable procedure or specific recovery insight that will help a later task. Routine task completion, one-off requests, obvious advice, praise and a restatement of the task are not learning; finish with zero records when nothing durable emerged. Skills describe WHEN, PROCEDURE, PITFALLS and VERIFICATION, not incident logs. A single failed task supports only a tentative scoped strategy, not a universal rule or a proven working skill. A completed run is an observed outcome, not proof that every claim was verified. Preserve uncertainty and include how the next agent should check applicability. Facts about the user must come from an exact direct-user task/feedback quote, never a website, tool output, or the assistant's guesses. A quotation must substantiate the actual fact, not merely come from the same task. Do not promote hypotheses, test fixtures or role-play into the real user profile. Never save credentials, tokens, passwords, transient status, or broad personality assumptions. All learning is scoped to this folder. Current user instructions override learned context.\n\nFor each relay_learn record call include action=record, kind, a stable key, title, content, and evidence=[{id,quote}]. Include a concise summary (at most 400 characters); if omitted, title is used. Skills should also include whenToUse and verification. Await and inspect every record receipt; fix rejected records before finishing. Do not submit finish in parallel with records or claim any rejected record was saved. Finish with relay_learn(action=finish,summaryOfReview=...). Free text alone changes nothing.\n\nEXISTING SAVED KNOWLEDGE (metadata only)\n${JSON.stringify(existingKnowledge)}\n\nEXISTING LEARNING\n${JSON.stringify(existing)}\n\nOBSERVED RUN EVIDENCE\n${JSON.stringify(review.evidence)}`;
    try{
      if(!['relay','codex'].includes(review.codexHistory))review.codexHistory=this.getRuntimeSettings?.()?.codexHistory==='relay'?'relay':'codex';
      await this.persist();check(signal);const selectedModel=this.runtime.status().models?.find(item=>item.model===review.model||item.id===review.model),supported=selectedModel?.supportedReasoningEfforts?.map(item=>item.reasoningEffort||item)||[],effort=supported.includes('low')?'low':selectedModel?.defaultReasoningEffort||supported[0];const result=await this.runtime.runAgent({cwd:review.cwd,prompt,model:review.model||undefined,codexHistory:review.codexHistory,...(effort?{effort}:{}),signal,timeoutMs:this.reviewTimeoutMs,dynamicTools:[LEARNING_TOOL],onToolCall:async(call,context={})=>{
        const receipt={at:now(),tool:String(call.name||'').slice(0,80),action:clip(call.arguments?.action,30),kind:clip(call.arguments?.kind,30),key:clip(call.arguments?.key,80),argumentKeys:plain(call.arguments)?Object.keys(call.arguments).slice(0,16):[]};try{
        const signals=[signal,context.signal].filter(Boolean),effective=AbortSignal.any(signals);check(effective);if(call.name!=='relay_learn')throw error('Only the learning record tool is attached to this review.');if(++calls>12)throw error('Learning review tool limit reached.');
        const args=call.arguments;if(!plain(args)||Object.keys(args).some(key=>!Object.hasOwn(LEARNING_TOOL.inputSchema.properties,key)))throw error('Invalid learning record arguments.');
        if(args.action==='finish'){if(!proposals.length&&review.toolReceipts.some(item=>item.action==='record'&&!item.success))throw error('No record was accepted. Repair the rejected record calls before finishing: record requires kind, key, title, content and exact evidence quotes; summary may be omitted and defaults to title. This rejected finish leaves the review open for corrected records.');review.modelSummary=bounded(args.summaryOfReview||'Reviewed the run; no additional durable changes were needed.','Review summary',1600);review.summary='Review finished; checking accepted changes before saving.';finished=true;receipt.success=true;return{success:true,contentItems:[{type:'inputText',text:JSON.stringify({reviewed:true,proposed:proposals.length,saved:0,commitPending:true,message:'Only accepted record calls can be saved after the review returns. A summary does not create a learning item.'})}]};}
        if(args.action!=='record'||finished)throw error('Record evidence-backed items before finishing the review.');if(proposals.length>=LEARNING_LIMITS.proposals)throw error('Save at most six learning items per review.');
        const proposal=this.validateProposal(args,review,evidenceMap);
        // A foreground save already has its own provenance and undo history. Keep it instead of
        // creating another item for an identical body observed by the background reviewer.
        const savedKind=proposal.kind==='skill'?'skills':'memories',covered=(existingKnowledge[savedKind]||[]).find(candidate=>{
          if(this.lessons.some(lesson=>lesson.knowledgeId===candidate.id))return false;
          try{const saved=this.knowledge.get(candidate.id);return(saved.cwd===null||same(saved.cwd,review.cwd))&&saved.content.trim()===proposal.body;}catch{return false;}
        });
        if(covered){review.existingKnowledgeIds=[...new Set([...(review.existingKnowledgeIds||[]),covered.id])];receipt.success=true;receipt.noop=true;receipt.knowledgeId=covered.id;return{success:true,contentItems:[{type:'inputText',text:JSON.stringify({recordedForCommit:false,alreadySaved:true,knowledgeId:covered.id,message:'This exact content is already saved in the library. Its original source and revision history were retained; do not create another copy.'})}]};}
        const key=hash(`${scope(review.cwd)}:${proposal.kind}:${proposal.key}`).slice(0,28);const index=proposals.findIndex(item=>item.id===`learn_${key}`);const item={...proposal,id:`learn_${key}`,knowledgeId:`learned_${key}`};const previous=this.lessons.find(lesson=>lesson.id===item.id);if(previous&&(previous.status==='deleted'||this.lessonView(previous).missingKnowledge))throw error('The user deleted this learned item. Do not recreate it automatically; only an explicit Restore action can restore it.');if(previous&&this.lessonView(previous).userEdited)throw error('This learned item was edited by the user. Preserve their version; do not replace it automatically.');if(index<0)proposals.push(item);else proposals[index]=item;
        check(effective);review.acceptedProposalCount=proposals.length;receipt.success=true;receipt.lessonId=item.id;return{success:true,contentItems:[{type:'inputText',text:JSON.stringify({recordedForCommit:true,id:item.id,kind:item.kind})}]};
        }catch(cause){receipt.success=false;receipt.error=clip(cause.message,800);throw cause;}finally{review.toolReceipts.push(receipt);review.toolReceipts=review.toolReceipts.slice(-20);this.changed();}
      },onEvent:event=>{if(signal.aborted)return;if(event.threadId)review.threadId=String(event.threadId).slice(0,160);if(event.turnId)review.turnId=String(event.turnId).slice(0,160);if(event.type==='usage')review.usage=copy(event.usage);this.changed();}});
      check(signal);if(result.threadId)review.threadId=String(result.threadId).slice(0,160);if(result.turnId)review.turnId=String(result.turnId).slice(0,160);if(!finished)throw error('The reviewer did not submit a structured learning result. Nothing was saved. Retry the review.',502);review.usage=copy(result.usage||review.usage);
      if(!proposals.length&&review.toolReceipts.some(item=>item.action==='record'&&!item.success))throw error('No learning items were saved: record requests were rejected. Inspect the tool receipts and retry the review.',502);
      // Once a durable commit starts, foreground preemption waits for it to finish.
      // No application actions run here; this avoids half-cancelled knowledge/profile writes.
      active.committing=true;review.status='committing';review.pendingChanges=proposals.map(item=>this.nextLesson(item,review));review.appliedIds=[];review.noopIds=[];if(this.lessons.length+review.pendingChanges.filter(item=>!this.lessons.some(existing=>existing.id===item.id)).length>LEARNING_LIMITS.lessons)throw error('The learning library is full. Delete an old item before saving another.',507);await this.persist();this.changed();
      for(const lesson of review.pendingChanges){
        const previous=this.lessons.find(item=>item.id===lesson.id);
        if(previous&&previous.content===lesson.content&&previous.evidence.some(item=>item.runId===review.runId)&&previous.status!=='deleted'){review.noopIds.push(previous.id);continue;}
        const knowledge=await this.knowledge.upsert({id:lesson.knowledgeId,kind:lesson.kind==='skill'?'skill':'memory',title:lesson.title,summary:lesson.summary,content:lesson.content,cwd:lesson.cwd},{source:'agent',runId:review.runId,nodeId:`learning-${review.id}`,reason:review.reason==='manual'?'Requested learning':'Automatic learning'});lesson.knowledgeRevision=knowledge.revision;
        const index=this.lessons.findIndex(item=>item.id===lesson.id);if(index<0){if(this.lessons.length>=LEARNING_LIMITS.lessons)throw error('The learning library is full. Delete an old item before saving another.',507);this.lessons.push(lesson);}else this.lessons[index]=lesson;
        review.committedIds.push(lesson.id);review.appliedIds.push(lesson.id);await this.persist();
        if(lesson.kind==='fact'&&this.onProfileFact){try{await this.syncProfileFact(lesson,previous);}catch(cause){lesson.profileError=cause.message;}}
      }
      delete review.pendingChanges;review.status=review.appliedIds.length?'completed':'no_changes';review.summary=review.appliedIds.length?`${review.appliedIds.length} evidence-backed ${review.appliedIds.length===1?'item was':'items were'} saved.${review.noopIds.length?` ${review.noopIds.length} existing items were unchanged.`:''}`:review.noopIds.length?'No new changes were saved; the accepted items already matched their saved evidence.':review.existingKnowledgeIds?.length?'No duplicate changes were saved; the accepted content already exists in the library.':'No learning items were saved. The review found no additional durable changes to commit.';review.finishedAt=now();await this.persist();
    }catch(cause){delete review.pendingChanges;review.status=signal.aborted&&!active.committing?'cancelled':'failed';review.error=clean(cause.message);review.summary=review.appliedIds?.length?`${review.appliedIds.length} items were saved before this review stopped. Inspect the saved items and error before retrying.`:'No learning items were saved by this review.';review.finishedAt=now();if(review.status==='cancelled'&&active.reason)review.error=active.reason;if(review.status==='cancelled'&&!this.closed&&this.settings.mode==='auto'&&/foreground|new task/i.test(active.reason||'')){review.status='queued';review.finishedAt=null;this.queue.unshift(review.id);}await this.persist();}
    finally{active.committing=false;this.changed();}
  }
  validateProposal(args,review,evidenceMap){
    if(!['strategy','skill','fact'].includes(args.kind))throw error('Choose a strategy, skill or explicit fact.');const key=bounded(args.key,'Stable topic key',80).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'');if(!key)throw error('Use a meaningful stable topic key.');
    const title=bounded(args.title,'Title',120),summary=bounded(args.summary===undefined||typeof args.summary==='string'&&!args.summary.trim()?title:args.summary,'Summary',400),body=bounded(args.content,'Learning content',args.kind==='skill'?12000:4000),whenToUse=bounded(args.whenToUse||'When this working folder and task match the cited evidence.','Applicability',1200),verification=bounded(args.verification||'Verify the current state and outcome before relying on this observation.','Verification',2000);
    if(secret.test(`${title}\n${summary}\n${body}\n${whenToUse}\n${verification}`))throw error('Credentials and secrets cannot be saved as learning.');if(!Array.isArray(args.evidence)||!args.evidence.length||args.evidence.length>5)throw error('Cite one to five exact evidence quotes.');
    const evidence=args.evidence.map(item=>{if(!plain(item)||Object.keys(item).some(key=>!['id','quote'].includes(key)))throw error('Invalid evidence citation.');const source=evidenceMap.get(item.id),quote=bounded(item.quote,'Evidence quote',1200);if(quote.length<8||!source||!source.text.includes(quote))throw error('Evidence quote must exactly match a provided source.');return{runId:review.runId,reviewId:review.id,id:item.id,kind:source.kind,quote,status:review.evidence.status,at:now()};});
    if(args.kind==='fact'&&!evidence.every(item=>['user','user_feedback'].includes(item.kind)))throw error('User facts require exact direct-user task or feedback quotes, not assistant, tool or website text.');
    const latestFeedback=this.feedbackEntries.filter(item=>item.runId===review.runId).at(-1);
    if(args.kind==='skill'&&(review.evidence.status!=='completed'||latestFeedback?.value==='bad'))throw error('A failed or negatively rated run supports a tentative strategy, not a proven reusable skill. Record a scoped strategy and verification plan.');
    return{kind:args.kind,key,title,summary,whenToUse,verification,body,evidence};
  }
  nextLesson(proposal,review){
    const stored=this.lessons.find(item=>item.id===proposal.id),previous=stored?this.lessonView(stored):null,evidence=[...(previous?.evidence||[]),...proposal.evidence].filter((item,index,all)=>all.findIndex(other=>other.runId===item.runId&&other.id===item.id&&other.quote===item.quote)===index).slice(-20);
    const successful=new Set(evidence.filter(item=>item.status==='completed').map(item=>item.runId)),negative=this.feedbackEntries.filter(item=>item.runId===review.runId).at(-1)?.value==='bad';const confidence=proposal.kind==='fact'?'explicit_user_statement':negative?'tentative_after_negative_feedback':successful.size>=2?'supported_by_multiple_runs':review.evidence.status==='completed'?'observed_once':review.evidence.status==='cancelled'?'tentative_after_interruption':'tentative_after_failure';
    const content=proposal.kind==='skill'?`# ${proposal.title}\n\n## When to use\n${proposal.whenToUse}\n\n## Procedure and pitfalls\n${proposal.body}\n\n## Verification\n${proposal.verification}\n\n## Evidence and limits\n${confidence.replaceAll('_',' ')}. Source runs: ${[...new Set(evidence.map(item=>item.runId))].join(', ')}. Check current conditions; this is not a measured performance improvement.`:`${proposal.body}\n\nUse when: ${proposal.whenToUse}\nVerify: ${proposal.verification}\nEvidence: ${confidence.replaceAll('_',' ')}; run ${review.runId}. Current instructions override this learned context.`;
    const history=previous?[...(previous.history||[]),lessonRevision(previous)].slice(-LEARNING_LIMITS.history):[];
    return{id:proposal.id,knowledgeId:proposal.knowledgeId,key:proposal.key,kind:proposal.kind,cwd:review.cwd,title:proposal.title,summary:proposal.summary,content,whenToUse:proposal.whenToUse,verification:proposal.verification,confidence,evidence,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||now(),updatedAt:now(),status:'active',history,provenance:{source:'learning',action:previous?'updated':'created',reviewId:review.id,runId:review.runId,trigger:review.reason,model:review.model,at:now()}};
  }
  profileFact(lesson,{saved=false}={}){
    if(saved&&lesson.profileEntry)return copy(lesson.profileEntry);
    const source=[...(lesson.evidence||[])].reverse().find(item=>['user','user_feedback'].includes(item.kind));
    return source?{fact:lesson.summary||lesson.title,sourceQuote:source.quote,sourceRunId:source.runId,sourceLearningId:lesson.id,cwd:lesson.cwd}:null;
  }
  async syncProfileFact(lesson,previous){
    if(lesson.kind!=='fact'||!this.onProfileFact)return;
    const entry=this.profileFact(lesson);if(!entry)return;
    const source=[...lesson.evidence].reverse().find(item=>['user','user_feedback'].includes(item.kind));
    const trustedUserText=source.kind==='user'?await Promise.resolve().then(()=>this.getRun(source.runId)).then(run=>run.input).catch(()=>source.quote):this.feedbackEntries.find(item=>`feedback_${item.id}`===source.id)?.comment||source.quote;
    const result=await this.onProfileFact({...entry,trustedUserText,...(previous?.profileUpdated?{expectedProfileEntry:this.profileFact(previous,{saved:true})}:{})});
    lesson.profileEntry=entry;lesson.profileUpdated=result?.factSync?.managed!==false;delete lesson.profileError;
  }
  async undoProfileFact(lesson){
    if(lesson.kind!=='fact'||!lesson.profileUpdated||!this.onProfileFactUndo)return;
    const entry=this.profileFact(lesson,{saved:true});if(entry)await this.onProfileFactUndo(entry);
    lesson.profileUpdated=false;delete lesson.profileError;
  }
  async removeLessonImpl(id){this.assertOpen();await this.cancelBackground('Learning changed by the user.');const lesson=this.lessons.find(item=>item.id===id);if(!lesson)throw error('Learned item not found.',404);await this.undoProfileFact(lesson);try{await this.knowledge.remove(lesson.knowledgeId);}catch(cause){if(cause.status!==404)throw cause;}lesson.status='deleted';lesson.updatedAt=now();await this.persist();this.changed();return this.lessonView(lesson);}
  async recordKnowledgeChangeImpl(entry){
    this.assertOpen();const lesson=this.lessons.find(item=>item.knowledgeId===entry?.id);if(!lesson||entry.revision===lesson.knowledgeRevision||entry.provenance?.source!=='user')return null;await this.cancelBackground('Learned instructions were edited by the user.');
    const previous=copy(lesson),restored=lesson.history.find(item=>item.title===entry.title&&item.summary===entry.summary&&item.content===entry.content);
    try{await this.undoProfileFact(lesson);}catch(cause){lesson.profileError=cause.message;}
    lesson.history=[...(lesson.history||[]),lessonRevision(previous)].slice(-LEARNING_LIMITS.history);
    Object.assign(lesson,{...(restored?{whenToUse:restored.whenToUse,verification:restored.verification,confidence:restored.confidence,evidence:copy(restored.evidence)}:{}),title:entry.title,summary:entry.summary,content:entry.content,knowledgeRevision:entry.revision,revision:previous.revision+1,status:'active',updatedAt:now(),userEdited:true,provenance:{source:'user',action:restored?'restored':'edited',...(restored?{restoredFrom:restored.revision}:{}),at:now()}});
    if(restored&&lesson.kind==='fact'&&!lesson.profileError){try{await this.syncProfileFact(lesson);}catch(cause){lesson.profileError=cause.message;}}
    await this.persist();this.changed();return this.lessonView(lesson);
  }
  async recordKnowledgeDeletionImpl(knowledgeId,previousEntry){
    this.assertOpen();if(previousEntry)await this.recordKnowledgeChange(previousEntry);const lesson=this.lessons.find(item=>item.knowledgeId===knowledgeId);if(!lesson)return null;await this.cancelBackground('A learned item was deleted by the user.');try{await this.undoProfileFact(lesson);}catch(cause){lesson.profileError=cause.message;}lesson.status='deleted';lesson.updatedAt=now();await this.persist();this.changed();return this.lessonView(lesson);
  }
  async restoreLessonImpl(id,revision){
    this.assertOpen();await this.cancelBackground('Restoring a learned item.');const lesson=this.lessons.find(item=>item.id===id);if(!lesson)throw error('Learned item not found.',404);
    const saved=revision===undefined||revision===lesson.revision?copy(lesson):copy(lesson.history.find(item=>item.revision===revision));if(!saved)throw error('Learning revision not found.',404);
    const previous=copy(lesson),restored={...lesson,...saved,status:'active',revision:previous.revision+1,updatedAt:now(),userEdited:true,provenance:{source:'user',action:'restored',restoredFrom:saved.revision,at:now()},history:[...(previous.history||[]),lessonRevision(previous)].slice(-LEARNING_LIMITS.history)};
    const knowledge=await this.knowledge.upsert({id:restored.knowledgeId,kind:restored.kind==='skill'?'skill':'memory',title:restored.title,summary:restored.summary,content:restored.content,cwd:restored.cwd},{source:'user'});
    Object.assign(lesson,restored,{knowledgeRevision:knowledge.revision});if(lesson.kind==='fact'){try{await this.syncProfileFact(lesson,previous);}catch(cause){lesson.profileError=cause.message;}}await this.persist();this.changed();return this.lessonView(lesson);
  }
  cancelBackground(reason='A foreground task took priority.'){
    clearTimeout(this.timer);this.timer=null;const active=this.active;if(active){active.reason=reason;if(!active.committing)active.controller.abort();return active.promise||Promise.resolve();}return Promise.resolve();
  }
  async close(){if(this.closePromise)return this.closePromise;this.closed=true;this.closePromise=(async()=>{await this.cancelBackground('Relay is shutting down.');await Promise.allSettled([...this.operations]);for(const id of this.queue){const review=this.reviews.find(item=>item.id===id);if(review?.status==='queued'){review.status='cancelled';review.error='Relay closed before the review started.';review.finishedAt=now();}}this.queue=[];await this.persist();await this.writes;})();return this.closePromise;}
}
