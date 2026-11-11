import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {RESPONSE_CYCLE_STAGES,RESPONSE_CYCLE_PIPELINE_VERSION,canonicalPlanSource} from '../public/response-cycle-model.mjs';
import {PLANNING_BROWSER_LIMITS,PLANNING_BROWSER_VERSION} from '../public/planning-browser-model.mjs';

const copy=value=>structuredClone(value);
export const diagnosticHash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const bytesHash=text=>createHash('sha256').update(text).digest('hex');
const fail=(message,code='PLANNING_DIAGNOSTIC_INVALID',status=409)=>Object.assign(new Error(message),{code,status});
const requireId=value=>{if(typeof value!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).test(value))throw fail('Use a bounded diagnostic action identity.');return value;};
const terminal=new Set(['completed','limited','failed','cancelled','interrupted']);
const profileKeys=['model','effort','serviceTier'];
// A second store must not interrupt a live owner. PID reuse is conservatively busy, never permission to replay.
function ownerAlive(run){if(!Number.isSafeInteger(run?.ownerPid)||run.ownerPid<1)return false;try{process.kill(run.ownerPid,0);return true;}catch(error){return error.code!=='ESRCH';}}
export const DIAGNOSTIC_BUDGET_UNIT='logical_model_invocations';

/** Deliberately no implicit limits, settings inheritance, or physical-request promise. */
export function diagnosticLimits(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['maxProviderTurns','maxCycles','maxDepth','maxPassesPerStage'].includes(key)))throw fail('Supply explicit diagnostic model-turn, cycle, depth and pass limits.');
  const bounds={maxProviderTurns:[1,24],maxCycles:[1,4],maxDepth:[0,2],maxPassesPerStage:[1,3]};
  for(const [key,[minimum,maximum]] of Object.entries(bounds))if(!Number.isSafeInteger(value[key])||value[key]<minimum||value[key]>maximum)throw fail('Diagnostic '+key+' must be between '+minimum+' and '+maximum+'.');
  return copy(value);
}
function runSnapshot(run,request,cycle){
  if(!run||run.id!==cycle.linkedRunId||run.responseCycle?.requestId!==request.id||run.responseCycle?.cycleId!==cycle.id||run.planningContractVersion!==14)throw fail('The saved run does not bind this native canonical Planning capture.','PLANNING_DIAGNOSTIC_BINDING');
  if(!run.workflow?.nodes?.some(node=>node.type==='agent'))throw fail('The captured workflow has no actual agent binding.','PLANNING_DIAGNOSTIC_BINDING');
  return {id:run.id,taskId:run.taskId||run.id,input:run.input,cwd:run.cwd,planningContractVersion:14,workflow:copy(run.workflow),attachmentIds:copy(run.attachmentIds||[]),responseCycle:{requestId:request.id,cycleId:cycle.id,planRef:copy(run.responseCycle.planRef||null)}};
}
function checkAuthoring(source,snapshot){
  let authoring;try{authoring=JSON.parse(source.text);}catch{throw fail('The native canonical authoring capture is unreadable.');}
  const actual=(snapshot.workflow.nodes||[]).filter(node=>node.type==='agent').map(node=>node.id).sort();
  if(authoring.taskSchemaVersion!==14||authoring.contractVersion!==2||diagnosticHash((authoring.workflow?.agents||[]).map(agent=>agent.id).sort())!==diagnosticHash(actual))throw fail('Canonical authoring agents do not match the captured native workflow.','PLANNING_DIAGNOSTIC_BINDING');
  if(!source.provenance||source.provenance.kind!=='runtime_evidence')throw fail('A canonical diagnostic needs the original host-captured authoring source.','PLANNING_DIAGNOSTIC_BINDING');
  if(snapshot.attachmentIds.length){
    const files=authoring.attachmentScope?.files;
    if(!Array.isArray(files)||snapshot.attachmentIds.some(id=>!files.some(file=>file.id===id&&/^[a-f0-9]{64}$/.test(file.sha256)&&file.resourceKey)))throw fail('The native attachment capture is incomplete.','PLANNING_DIAGNOSTIC_BINDING');
  }
  return authoring;
}

/** Store-owned capabilities never cross JSON, HTTP, graph tools, or provider prompts. */
export class PlanningDiagnosticStore {
  #capabilities=new WeakMap();
  #active=new Map();
  constructor(store){this.store=store;}
  isAuthorized(request,capability){return !request.diagnostic||request.diagnostic.state==='running'&&this.#active.get(request.id)===capability&&this.#capabilities.get(capability)===request.id;}
  assertAdmission(request,capability){
    if(!this.isAuthorized(request,capability))throw fail('Diagnostic modules run only through their host-owned bounded diagnostic operation.','PLANNING_DIAGNOSTIC_ADMISSION',403);
  }
  assertPass(request,nodeId){
    if(!request.diagnostic)return;
    const used=request.attempts.filter(attempt=>attempt.nodeId===nodeId&&!attempt.repairOf&&attempt.purpose!=='child_admission').length;
    if(used>=request.diagnostic.capture.limits.maxPassesPerStage)throw fail('This diagnostic stage reached its lifetime generation/refinement pass ceiling.','PLANNING_DIAGNOSTIC_BUDGET');
  }
  assertMutation(request,trusted){
    if(request.diagnostic&&!trusted)throw fail('A diagnostic capture is immutable; ordinary graph edits cannot change it.','PLANNING_DIAGNOSTIC_IMMUTABLE',403);
  }
  validate(request){
    const d=request.diagnostic;if(!d)return;
    if(d.version!==1||!d.capture||d.captureHash!==diagnosticHash(d.capture)||!['captured','running',...terminal].includes(d.state))throw fail('Diagnostic capture or policy integrity failed.','PLANNING_DIAGNOSTIC_INTEGRITY');
    diagnosticLimits(d.capture.limits);
    if(request.conversationId!==request.id||request.responseCycle?.linkedRunId||request.viability?.linkedRunId||request.viability?.pendingIntent)throw fail('A diagnostic cannot have executable conversation bindings.','PLANNING_DIAGNOSTIC_INTEGRITY');
    if(d.budgetUnit!==DIAGNOSTIC_BUDGET_UNIT||d.physicalRequestCeiling!==null||!Array.isArray(d.reservations)||d.reservations.length>d.capture.limits.maxProviderTurns)throw fail('Invalid diagnostic turn accounting.');
    if(d.reservations.some((row,index)=>row.ordinal!==index+1||typeof row.key!=='string')||new Set(d.reservations.map(row=>row.key)).size!==d.reservations.length)throw fail('Invalid diagnostic reservation identities.');
    if(d.capture.sourceRecords.some(original=>{const source=request.sources.find(item=>item.id===original.id);return !source||diagnosticHash(source)!==diagnosticHash(original);}))throw fail('A diagnostic source changed after capture.','PLANNING_DIAGNOSTIC_INTEGRITY');
    if(request.objective!==d.capture.objective||request.cwd!==d.capture.cwd||diagnosticHash(request.responseCycle?.limits)!==diagnosticHash(d.capture.limits))throw fail('Diagnostic inputs or limits changed.','PLANNING_DIAGNOSTIC_INTEGRITY');
    if(d.capture.nodeDefinitions.some(definition=>{const node=request.nodes.find(item=>item.id===definition.id);return !node||Object.entries(definition).some(([key,value])=>node[key]!==value);}))throw fail('A captured root module definition changed.','PLANNING_DIAGNOSTIC_INTEGRITY');
    if(request.attempts.some(attempt=>profileKeys.some(key=>attempt[key]!==d.capture.profile[key])))throw fail('A diagnostic attempt changed its pinned model profile.','PLANNING_DIAGNOSTIC_INTEGRITY');
    const cycles=request.responseCycle?.cycles||[];
    if(cycles.length>d.capture.limits.maxCycles||cycles.some(cycle=>cycle.depth>d.capture.limits.maxDepth||cycle.linkedRunId||cycle.pendingIntent||cycle.execution?.required!==false||cycle.execution?.runId||cycle.continuedPlanRef))throw fail('A diagnostic cannot acquire execution or exceed its captured recursion scope.','PLANNING_DIAGNOSTIC_SCOPE');
    if(cycles.some(cycle=>cycle.executionProfile&&diagnosticHash(cycle.executionProfile)!==diagnosticHash(d.capture.profile)))throw fail('A diagnostic model profile changed.','PLANNING_DIAGNOSTIC_INTEGRITY');
  }
  async capture({sourceRequestId,sourceCycleId,expectedSourceRevision,clientRequestId,limits,profile,run,runtimeOptions={context:null,timeoutMs:null}}){
    requireId(clientRequestId);limits=diagnosticLimits(limits);
    if(!profile||profileKeys.some(key=>typeof profile[key]!=='string'||!profile[key].trim())||Object.keys(profile).some(key=>!profileKeys.includes(key))||['default','codex'].includes(profile.model))throw fail('Pin an explicit diagnostic model, effort and service tier.');
    const fingerprint=diagnosticHash({sourceRequestId,sourceCycleId,expectedSourceRevision,clientRequestId,limits,profile}),id='diagnostic-'+diagnosticHash(clientRequestId).slice(0,48),store=this.store;
    await store.init();
    return store._enqueue('_catalog',()=>store._enqueue(sourceRequestId,async()=>{
      try{const existing=await store._load(id);if(existing.diagnostic?.captureFingerprint!==fingerprint)throw fail('This capture identity names different diagnostic work.','PLANNING_DIAGNOSTIC_IDEMPOTENCY');return store._public(existing);}catch(error){if(error.code!=='PLANNING_REQUEST_NOT_FOUND')throw error;}
      const original=await store._load(sourceRequestId);
      if(original.diagnostic||original.revision!==expectedSourceRevision)throw fail('Read the exact original native request revision before capture.','PLANNING_DIAGNOSTIC_CONFLICT');
      const oldCycle=original.responseCycle?.cycles?.find(item=>item.id===sourceCycleId);
      if(!oldCycle||oldCycle.pipelineVersion!==RESPONSE_CYCLE_PIPELINE_VERSION)throw fail('Select a current native canonical cycle.');
      const snapshot=runSnapshot(run,original,oldCycle),source=original.sources.find(item=>item.id==='cycle:execution-contract:'+oldCycle.id);
      if(!source||!canonicalPlanSource([source]))throw fail('The native canonical authoring source is missing.','PLANNING_DIAGNOSTIC_BINDING');
      checkAuthoring(source,snapshot);
      const at=store.stamp(),cycleId='cycle-'+diagnosticHash([id,'root']).slice(0,32),stageNodeIds=Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,cycleId+'-'+stage.id]));
      const mapping=[],sources=original.sources.filter(item=>!item.id.startsWith('cycle:')||item.id==='cycle:execution-contract:'+oldCycle.id||item.id==='cycle:handoff-contract:'+oldCycle.id).map(item=>{
        const next=copy(item);if(next.id.startsWith('cycle:'))next.id=next.id.replace(oldCycle.id,cycleId);
        mapping.push({sourceId:item.id,sourceHash:bytesHash(item.text||''),recordHash:diagnosticHash(item),diagnosticSourceId:next.id,diagnosticSourceHash:bytesHash(next.text||'')});return next;
      });
      const context={id:'cycle:context:'+cycleId,kind:'source',title:'Captured diagnostic scope',text:JSON.stringify({objective:original.objective,scope:'Historical native canonical authoring diagnostic only. No external work, live ownership, adoption or continuation is available. Preserve unmet operational outcomes as proposed work, never as achieved effects.'}),provenance:{kind:'runtime_evidence'},verified:false};
      context.contentHash=bytesHash(context.text);sources.push(context);
      const nodes=[{id:cycleId,parentId:null,kind:'cycle',title:'Canonical authoring diagnostic',prompt:original.objective,cycleId,revision:1,createdAt:at,updatedAt:at},...RESPONSE_CYCLE_STAGES.map(stage=>{
        const prior=original.nodes.find(node=>node.id===oldCycle.stageNodeIds[stage.id]);if(!prior)throw fail('The native stage definition is incomplete.');
        return {id:stageNodeIds[stage.id],parentId:cycleId,kind:stage.kind,title:prior.title,prompt:prior.prompt||original.objective,cycleId,cycleStage:stage.id,revision:1,createdAt:at,updatedAt:at};
      })];
      const capture={version:1,sourceRequestId,sourceRequestRevision:original.revision,sourceCycleId,sourceRequestHash:diagnosticHash(original),run:snapshot,runHash:diagnosticHash(snapshot),objective:original.objective,cwd:original.cwd,requestProvenance:copy(original.provenance||null),capturedAt:at,nodeDefinitions:nodes.map(({id,parentId,kind,title,prompt,cycleId,cycleStage})=>({id,parentId,kind,title,prompt,cycleId,...(cycleStage?{cycleStage}:{})})),profile:copy(profile),runtimeOptions:copy(runtimeOptions),limits,sourceMapping:mapping,sourceRecords:copy(sources),authoring:{sourceId:source.id.replace(oldCycle.id,cycleId),sourceHash:source.contentHash,byteHash:bytesHash(source.text)},scope:'native_canonical_authoring_snapshot',physicalRequestCeiling:null};
      const request={version:PLANNING_BROWSER_VERSION,id,conversationId:id,title:'Diagnostic · '+original.title.slice(0,220),objective:original.objective,cwd:original.cwd,revision:1,createdAt:at,updatedAt:at,provenance:{kind:'unrecorded',author:'host diagnostic capture',at},nodes,edges:[],responses:[],assignments:[],attempts:[],sources,history:[],idempotency:[],
        diagnostic:{version:1,capture,captureHash:diagnosticHash(capture),captureFingerprint:fingerprint,state:'captured',budgetUnit:DIAGNOSTIC_BUDGET_UNIT,physicalRequestCeiling:null,reservations:[]},
        responseCycle:{version:1,rootCycleId:cycleId,limits:copy(limits),cycles:[{id:cycleId,pipelineVersion:RESPONSE_CYCLE_PIPELINE_VERSION,title:'Canonical authoring diagnostic',objective:original.objective,parentCycleId:null,parentStageId:null,stageNodeIds,depth:0,planningExecutionMode:'plan_only',state:'pending',key:cycleId,required:true,acceptanceCriteria:copy(oldCycle.acceptanceCriteria||[]),sourceIds:null,executionProfile:copy(profile),execution:{required:false,state:'not_required'},createdAt:at,updatedAt:at}]},
        viability:{scope:'request',scopeId:id,nodeId:stageNodeIds.feasibility,fingerprint:diagnosticHash(original.viability?.definition||{}),workflowNodeIds:snapshot.workflow.nodes.filter(node=>node.type==='agent').map(node=>node.id),executionProfile:copy(profile)}};
      const files=(await fs.readdir(store.requestDirectory)).filter(name=>name.endsWith('.json'));if(files.length>=PLANNING_BROWSER_LIMITS.requests)throw fail('Planning request capacity reached.','PLANNING_BROWSER_CAPACITY',507);
      return store._save(null,request,'diagnosticCapture',{actor:'host diagnostic capture'});
    }));
  }
  async begin(id,{expectedRevision,captureHash,clientRequestId}){
    requireId(clientRequestId);return this.store._enqueue(id,async()=>{
      const old=await this.store._load(id),d=old.diagnostic;if(!d)throw fail('Select a captured diagnostic.');
      if(d.captureHash!==captureHash)throw fail('The diagnostic manifest changed.','PLANNING_DIAGNOSTIC_CONFLICT');
      if(d.state!=='captured'){
        if(d.run?.clientRequestId===clientRequestId)return {request:this.store._public(old),created:false};
        throw fail('A diagnostic capture runs once; inspect its saved outcome.','PLANNING_DIAGNOSTIC_SETTLED');
      }
      if(old.revision!==expectedRevision)throw fail('The diagnostic revision changed.','PLANNING_DIAGNOSTIC_CONFLICT');
      const next=copy(old),capability=Object.freeze({}),runId=randomUUID();next.diagnostic.state='running';next.diagnostic.run={id:runId,clientRequestId,ownerPid:process.pid,startedAt:this.store.stamp()};
      const request=await this.store._save(old,next,'diagnosticRun',{actor:'host diagnostic'});
      this.#capabilities.set(capability,id);this.#active.set(id,capability);return {request,capability,created:true};
    });
  }
  async reserve(id,{kind,key,nodeId,attemptId,capability}){
    return this.store._enqueue(id,async()=>{
      const old=await this.store._load(id);if(!old.diagnostic)return {diagnostic:false,created:true};
      this.assertAdmission(old,capability);requireId(key);
      const expectedKind=old.attempts.find(item=>item.id===attemptId)?.purpose==='child_admission'?'child_admission':'module';
      if(kind!==expectedKind||key!==(kind==='child_admission'?'child-admission:':'attempt:')+attemptId)throw fail('A reservation must name its exact invocation and purpose.','PLANNING_DIAGNOSTIC_ADMISSION');
      const d=old.diagnostic,prior=d.reservations.find(item=>item.key===key);
      if(prior)return {diagnostic:true,created:false,ordinal:prior.ordinal,max:d.capture.limits.maxProviderTurns};
      const attempt=old.attempts.find(item=>item.id===attemptId);
      if(!attempt||attempt.nodeId!==nodeId||attempt.status!=='running'||!['module','child_admission'].includes(kind))throw fail('Reserve an actual current diagnostic attempt.','PLANNING_DIAGNOSTIC_ADMISSION');
      if(d.reservations.length>=d.capture.limits.maxProviderTurns)throw fail('The diagnostic reached its logical model-invocation ceiling.','PLANNING_DIAGNOSTIC_BUDGET');
      const next=copy(old),ordinal=d.reservations.length+1;next.diagnostic.reservations.push({key,kind,nodeId,attemptId,ordinal,reservedAt:this.store.stamp(),consumption:'reserved_may_have_dispatched'});
      await this.store._save(old,next,'diagnosticReserve',{actor:'host diagnostic',nodeId});return {diagnostic:true,created:true,ordinal,max:d.capture.limits.maxProviderTurns};
    });
  }
  async finish(id,{state,reason,capability,allowInterrupted=false}){
    if(!terminal.has(state))throw fail('Use a terminal diagnostic outcome.');
    return this.store._enqueue(id,async()=>{
      const old=await this.store._load(id);if(!old.diagnostic)throw fail('Select a diagnostic.');
      if(terminal.has(old.diagnostic.state))return this.store._public(old);
      if(!allowInterrupted)this.assertAdmission(old,capability);
      else if(this.#active.has(id)||old.diagnostic.state==='running'&&ownerAlive(old.diagnostic.run))throw fail('The diagnostic still has an active host owner.');
      const next=copy(old);if(allowInterrupted)for(const attempt of next.attempts.filter(item=>item.status==='running'))Object.assign(attempt,{status:'failed',finishedAt:this.store.stamp(),message:'The diagnostic host stopped; no uncertain invocation was replayed.'});next.diagnostic.state=state;next.diagnostic.finishedAt=this.store.stamp();next.diagnostic.reason=String(reason||'').slice(0,1800);
      const saved=await this.store._save(old,next,'diagnosticFinish',{actor:'host diagnostic'});this.#active.delete(id);return saved;
    });
  }
  async read(id){
    const request=await this.store.get(id);if(!request.diagnostic)throw fail('Select a diagnostic.');
    if(request.diagnostic.state==='running'&&!this.#active.has(id)&&!ownerAlive(request.diagnostic.run))return this.finish(id,{state:'interrupted',reason:'The prior diagnostic host no longer owns this operation. Reserved invocations remain consumed; no work was replayed.',allowInterrupted:true});
    return request;
  }
}

/** No Engine reference: source lookup is read-only and no execution capabilities are held. */
export class PlanningDiagnostics {
  constructor({store,cycles,runner,readRun,getSettings=()=>({})}={}){this.store=store;this.writer=store.runtimeWriter();this.cycles=cycles;this.runner=runner;this.readRun=readRun;this.getSettings=getSettings;this.active=new Map();}
  async capture(value){
    const request=await this.store.get(value.sourceRequestId),cycle=request.cycles.find(item=>item.id===value.sourceCycleId);
    if(!cycle?.linkedRunId)throw fail('Select a saved native linked cycle.');
    const run=await this.readRun(cycle.linkedRunId);
    const settings=this.getSettings()||{};
    return this.writer.captureDiagnostic({...value,run:copy(run),runtimeOptions:{context:copy(settings.defaultContext??null),timeoutMs:settings.runTimeoutMs??null}});
  }
  read(id){return this.writer.readDiagnostic(id);}
  async run(id,value,{signal}={}){
    const current=this.active.get(id);if(current){if(current.clientRequestId!==value.clientRequestId)throw fail('A diagnostic is already active.');return current.promise;}
    const controller=new AbortController(),entry={controller,clientRequestId:value.clientRequestId};this.active.set(id,entry);
    const abort=()=>controller.abort(signal?.reason||new Error('Diagnostic cancelled'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    entry.promise=(async()=>{
      const claim=await this.writer.beginDiagnostic(id,value);if(!claim.created)return this.writer.readDiagnostic(id);
      entry.capability=claim.capability;
      try{
        controller.signal.throwIfAborted();const request=claim.request,d=request.diagnostic,limits=d.capture.limits;
        const result=await this.cycles.drive(id,request.responseCycle.rootCycleId,{through:'plan',signal:controller.signal,budget:{used:d.reservations.length,max:limits.maxProviderTurns,maxPasses:limits.maxPassesPerStage},runKey:d.run.id,diagnosticCapability:claim.capability});
        const plan=result.nodes.find(node=>node.id===result.cycles[0].stageNodeIds.plan),complete=Boolean(plan?.response?.contract&&plan.readiness.cycle?.analysisReady);
        return await this.writer.finishDiagnostic(id,{state:complete?'completed':'limited',reason:complete?'Canonical authoring validated against the immutable snapshot. No contract was adopted and no outcome was executed.':'The bounded diagnostic stopped before a valid canonical Plan. Inspect its saved stage and child limitations.',capability:claim.capability});
      }catch(error){
        return this.writer.finishDiagnostic(id,{state:controller.signal.aborted?'cancelled':/BUDGET|SCOPE/.test(error.code||'')?'limited':'failed',reason:error.message,capability:claim.capability});
      }
    })().finally(()=>{signal?.removeEventListener('abort',abort);this.active.delete(id);});
    return entry.promise;
  }
  async cancel(id){
    const active=this.active.get(id);if(active){active.controller.abort(new Error('Diagnostic cancelled by caller'));return active.promise;}
    const request=await this.read(id);if(request.diagnostic.state==='captured')return this.writer.finishDiagnostic(id,{state:'cancelled',reason:'Cancelled before any diagnostic invocation.',allowInterrupted:true});
    return request;
  }
  async close(){await Promise.allSettled([...this.active].map(([id])=>this.cancel(id)));}
}
