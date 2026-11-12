import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applicationDescriptorTarget, createApplicationHistoryGate } from './application-history.mjs';
import { validNativeSubmissionObservation } from '../desktop/browser-submission-observation.mjs';
import { normalizeOperationalReceiptBinding } from './operational-receipts.mjs';
import { assertNoRetainedEffectConflict } from './legacy-operational-claims.mjs';
import { describeHostOperation } from './operation-descriptors.mjs';
import { workspaceRecoveryBinding } from './owner-recovery-workspace.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const fail = (code,message) => Object.assign(new Error(message), {code,status:409,actionDispatched:false});
const MAX_BYTES=8*1024*1024, MAX_RECORDS=10000;
const parseArgs=call=>typeof call?.arguments==='string'?JSON.parse(call.arguments):call?.arguments||{};
const safeCall=call=>call&&!call.namespace&&['relay_browser','relay_workspace'].includes(call.name);
const reads=new Set(['tabs','diagnostics','snapshot','read','screenshot','downloads','wait','list','search','patch_history']);
const relevant=(descriptor,call)=>descriptor?.effect==='commit'||descriptor?.effect==='opaque'&&call.name==='relay_browser'||call.name==='relay_workspace'&&['write','patch','undo_patch'].includes(parseArgs(call).action);
const bodyOf=result=>{for(const item of result?.contentItems||[])if(item?.type==='inputText')try{const value=JSON.parse(item.text);if(value&&typeof value==='object'&&!Array.isArray(value)&&!value.type?.startsWith('operational.'))return value;}catch{}return{};};
const descriptorKeys=descriptor=>[...new Set((descriptor.resources||[]).filter(item=>item.scopeOnly!==true&&item.access==='write').map(item=>item.key))].sort();
const conflict=(a,b)=>{
  if(a.state==='absent')return false;
  if(a.effectKey&&b.effectKey&&a.effectKey===b.effectKey)return true;
  if(a.state==='confirmed')return false;
  const common=a.resources.filter(key=>b.resources.includes(key));
  if(a.effect==='commit'||b.effect==='commit'||a.effect==='opaque'||b.effect==='opaque')return a.operationKey===b.operationKey||common.some(key=>key.startsWith('path:'))||common.some(key=>key.startsWith('form:'))&&(!a.resources.some(key=>key.startsWith('tab:'))||!b.resources.some(key=>key.startsWith('tab:'))||common.some(key=>key.startsWith('tab:')));
  return common.length>0;
};
const receipt=(value,success=true)=>({success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
const owned=(row,taskId,nodeId)=>row.taskId===taskId&&row.nodeId===nodeId;
const commitment=row=>({operationId:row.operationId,deliveryState:row.deliveryState||'interrupted',effectState:row.state,commit:row.descriptor?.commit,evidence:row.evidence||[]});
function matchingCorrelation(proof,row){
  const value=proof?.validation?.correlation,commit=row.descriptor?.commit;
  return proof?.kind==='observation'&&proof.validation?.source==='native-form-navigation'&&validNativeSubmissionObservation(value)
    &&commit&&value.operationId===row.operationId&&value.effectKey===commit.effectKey&&value.destinationKey===commit.destinationKey
    &&value.payloadDigest===commit.payloadDigest&&value.requestPayloadDigest===commit.requestPayloadDigest
    &&commit.documentKey==='document:'+value.sourceDocumentId&&proof.sourceVersion===value.documentId;
}
function acceptedBrowserProofs(observation,row){
  const evidence=Array.isArray(observation?.evidence)?observation.evidence:[];
  const correlations=evidence.filter(proof=>matchingCorrelation(proof,row));
  const confirmations=evidence.filter(proof=>proof?.kind==='external-confirmation'&&proof.confirmation?.effectKey===row.effectKey
    &&['confirmed','absent'].includes(proof.confirmation?.status)&&proof.confirmation.prior!==true
    &&proof.validation?.adapter==='relay_browser'&&proof.validation?.source==='host-correlated-native-form-text'
    &&proof.validation.operationId===row.operationId&&proof.validation.destinationKey===row.descriptor.commit.destinationKey
    &&correlations.some(item=>item.validation.correlation.requestId===proof.validation.requestId
      &&item.sourceVersion===proof.sourceVersion&&item.sourceVersion===proof.validation.documentId));
  // The mapping is authored by a caller. A correlated visible text is a fact,
  // but its claimed business meaning is not protocol-authenticated. In
  // particular, an error response cannot prove the server did nothing.
  const interpretations=confirmations.map(proof=>({provenance:'caller-mapped-native-text',
    interpretedState:proof.confirmation.status,observedText:proof.validation.receiptStatus,
    operationId:row.operationId,requestId:proof.validation.requestId,documentId:proof.validation.documentId,
    bindingDigest:proof.validation.bindingDigest,observationDigest:proof.digest,
    assurance:'Business acceptance and absence are not established by this mapping.'}));
  return {evidence:correlations,interpretations,state:'unknown'};
}
/** Host receipt plus independently checked file bytes; no plan/model pass. */
async function verifiedWorkspaceEffect(call,result,descriptor){
  if(result?.success!==true||call?.name!=='relay_workspace')return false;
  let args,body;
  try{
    args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
    body=JSON.parse(result.contentItems?.find(item=>item.type==='inputText')?.text||'null');
  }catch{return false;}
  if(!['write','patch','undo_patch'].includes(args?.action)||typeof body?.path!=='string'||!path.isAbsolute(body.path))return false;
  const canonicalPath=(await fs.realpath(body.path)).replace(/\\/g,'/');
  const resourceKey='path:'+(process.platform==='win32'?canonicalPath.toLowerCase():canonicalPath);
  if(!descriptor.resources.some(item=>item.key===resourceKey&&!item.scopeOnly))return false;
  const expected=args.action==='write'&&typeof args.text==='string'
    ?createHash('sha256').update(args.text).digest('hex')
    :typeof body.afterHash==='string'&&/^[a-f0-9]{64}$/.test(body.afterHash)?body.afterHash:null;
  if(!expected||args.action==='write'&&body.atomic!==true||args.action!=='write'&&body.status!=='applied')return false;
  let handle;
  try{
    handle=await fs.open(body.path,'r');const info=await handle.stat();
    if(!info.isFile()||info.size>32*1024*1024)return false;
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(65536);
    for(let offset=0;offset<info.size;){
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,info.size-offset),offset);
      if(!bytesRead)return false;
      hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;
    }
    return hash.digest('hex')===expected;
  }catch{return false;}finally{await handle?.close().catch(()=>{});}
}

/** Durable host operations. Planning intent and completion never authorize this journal. */
export function createOperationalEffectGuard({store,cwd,taskId,runId,nodeId,onEvent=()=>{},ownerRecovery,signal}={}){
  if(!store||typeof store.enqueue!=='function'||typeof store.file!=='function'||!path.isAbsolute(cwd||'')||!taskId||!runId||!nodeId)throw new Error('Independent effects require durable storage and exact host workspace/worker identity.');
  const storeKey='native-effects-'+digest(process.platform==='win32'?path.resolve(cwd).toLowerCase():path.resolve(cwd)).slice(0,32),file=store.file(storeKey)+'.effects';
  const application=createApplicationHistoryGate({store,cwd,taskId}),pending=new Map(),handlers=new Map();
  const serialized=operation=>store.enqueue(storeKey,operation);
  async function read(){
    let value;
    try{const stat=await fs.stat(file);if(stat.size>MAX_BYTES)throw new Error('Journal too large');value=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')return{version:1,root:path.resolve(cwd),records:[]};throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The operational journal cannot be read. Preserve it; ordinary inspection remains available.');}
    if(value?.version!==1||value.root!==path.resolve(cwd)||!Array.isArray(value.records)||value.records.length>MAX_RECORDS
      ||value.records.some(row=>!row||typeof row.operationId!=='string'||typeof row.taskId!=='string'||typeof row.runId!=='string'||typeof row.effect!=='string'
        ||!['unknown','absent','confirmed'].includes(row.state)||!Array.isArray(row.resources)||row.resources.some(key=>typeof key!=='string')
        ||row.descriptor&&(!row.callDigest||row.descriptor.operationKey!==row.operationKey||!Array.isArray(row.evidence))))
      throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The retained operational journal is invalid. No consequential action was dispatched.');
    return value;
  }
  async function write(value){
    const contents=JSON.stringify(value);
    if(value.records.length>MAX_RECORDS||Buffer.byteLength(contents)>MAX_BYTES)throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The operational journal is full; preserve its receipts.');
    const assertOwner=async()=>{const token=store.lockOwners?.get(storeKey),holder=JSON.parse(await fs.readFile(store.file(storeKey)+'.lock','utf8'));if(!token||holder.pid!==process.pid||holder.token!==token)throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The operational journal lock changed.');};
    const temporary=file+'.'+randomUUID()+'.tmp';let handle;
    try{await assertOwner();handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(contents);await handle.sync();await handle.close();handle=null;await assertOwner();await fs.rename(temporary,file);}
    finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
  }
  const records=async()=>clone((await read()).records);
  async function mirror(row){
    if(!row.application||row.state==='unknown')return;
    await application.reconcile([{...commitment(row),reconciliationEvidenceIds:(row.evidence||[]).filter(item=>item.confirmation?.effectKey===row.effectKey).map(item=>item.id)}],{notDispatchedOperationId:row.deliveryState==='cancelled-before-dispatch'?row.operationId:null});
  }
  async function saveOutcome(operationId,{state='unknown',deliveryState,evidence=[],interpretations=[],result,resultDigest,note}={}){
    const row=await serialized(async()=>{
      const journal=await read(),row=journal.records.find(item=>item.operationId===operationId&&owned(item,taskId,nodeId));
      if(!row)throw fail('OPERATIONAL_RECEIPT_MISSING','The original operation receipt is missing. Do not replay it.');
      if(deliveryState)row.deliveryState=deliveryState;
      if(resultDigest)row.resultDigest=resultDigest;
      if(result&&Buffer.byteLength(JSON.stringify(result))<=65536)row.result=clone(result);
      row.evidence||=[];
      for(const proof of evidence){const id='native-proof:'+digest(proof);if(!row.evidence.some(item=>item.id===id))row.evidence.push({...clone(proof),id,at:now()});}
      row.interpretations||=[];
      for(const value of interpretations){const id='interpretation:'+digest(value);if(!row.interpretations.some(item=>item.id===id))row.interpretations.push({...clone(value),id,at:now()});}
      if(row.state==='unknown'&&['absent','confirmed'].includes(state)){row.state=state;row.settledAt=now();}
      if(note)row.note=String(note).slice(0,500);
      await write(journal);return clone(row);
    });
    await mirror(row);return row;
  }
  async function desiredWorkspace(call,descriptor){
    if(call.name!=='relay_workspace')return null;
    const args=parseArgs(call),key=descriptor.resources.find(item=>!item.scopeOnly&&item.key.startsWith('path:'))?.key;
    if(!key)return null;
    if(args.action==='write'&&typeof args.text==='string')return{pathKey:key,sha256:digest(args.text)};
    return null;
  }
  async function reserve(call,descriptor,operationId,callDigest){
    const expectation=await desiredWorkspace(call,descriptor),isApplication=Boolean(applicationDescriptorTarget(descriptor));
    if(isApplication)await application.check({descriptor,operationId,reserve:false});
    const row=await serialized(async()=>{
      const journal=await read(),candidate={operationId,callId:call.callId||null,callDigest,taskId,runId,nodeId,at:now(),adapter:call.name,action:parseArgs(call).action,
        effect:descriptor.effect,effectKey:descriptor.commit?.effectKey||null,operationKey:descriptor.operationKey,resources:descriptorKeys(descriptor),state:'unknown',deliveryState:'dispatched',descriptor:clone(descriptor),evidence:[],interpretations:[],application:isApplication,...(expectation?{expectation}:{})};
      const prior=journal.records.find(item=>item.operationId===operationId||conflict(item,candidate));
      if(prior)throw fail('OPERATIONAL_EFFECT_UNCERTAIN','The same native effect or resource is retained as '+prior.operationId+'. '+(owned(prior,taskId,nodeId)?'Inspect it with relay_effects read.':'Only its original task and worker can inspect or reconcile it; this worker cannot access that receipt.')+' No operation was dispatched; unrelated work remains available.');
      journal.records.push(candidate);await write(journal);return clone(candidate);
    });
    if(isApplication)try{await application.check({descriptor,operationId,reserve:true});}catch(error){await saveOutcome(operationId,{state:'absent',deliveryState:'cancelled-before-dispatch'});throw error;}
    return row;
  }
  async function nativeObservation(raw,call,result,descriptor,rows,context){
    if(call.name!=='relay_browser'||typeof raw.normalizeOperationalResult!=='function')return null;
    const receiptBindings=[...new Map(rows.flatMap(row=>row.receiptBindings||[]).map(binding=>[digest(binding),binding])).values()];
    return raw.normalizeOperationalResult(result,{...context,call,descriptor,cwd,receiptBindings,commitments:rows.filter(row=>row.descriptor?.commit).map(commitment)});
  }
  async function observeRead(raw,call,result,context={}){
    if(result?.success!==true)return;
    if(raw.operationOwner&&(raw.operationOwner.taskId!==taskId||raw.operationOwner.nodeId!==nodeId))return;
    const rows=(await records()).filter(row=>owned(row,taskId,nodeId)&&row.descriptor&&row.adapter===call.name);
    for(const row of rows.filter(row=>row.application&&row.state!=='unknown'))await mirror(row);
    const unresolved=rows.filter(row=>row.state==='unknown');if(!unresolved.length)return;
    const descriptor=await raw.describeOperation(call,context);
    if(descriptor.effect!=='observe')return;
    if(call.name==='relay_browser'){
      const observed=await nativeObservation(raw,call,result,descriptor,rows,context);
      for(const row of unresolved){const proof=acceptedBrowserProofs(observed,row);if(proof.evidence.length)await saveOutcome(row.operationId,proof);}
    }else if(parseArgs(call).action==='read'){
      const body=bodyOf(result);
      for(const row of unresolved){
        if(!row.expectation||body.sha256!==row.expectation.sha256||!descriptor.resources.some(item=>!item.scopeOnly&&item.key===row.expectation.pathKey))continue;
        // A native full-file hash plus current independently read bytes proves the desired content, not historical acceptance.
        if(await verifiedWorkspaceEffect({name:'relay_workspace',arguments:{action:'patch'}},receipt({path:body.path,status:'applied',afterHash:body.sha256}),row.descriptor))
          await saveOutcome(row.operationId,{state:'confirmed',evidence:[{kind:'observation',resourceKey:row.expectation.pathKey,digest:body.sha256,validation:{adapter:'relay_workspace',source:'native-file-readback',operationId:row.operationId}}]});
      }
    }
  }
  function wrap(raw){
    if(typeof raw!=='function')return raw;
    if(raw.operationAdapter)handlers.set(raw.operationAdapter,raw);
    const wrapped=async(call,context={})=>{
      call=clone(call);
      if(call?.namespace&&['relay_browser','relay_workspace'].includes(call.name))return receipt({code:'OPERATIONAL_NATIVE_NAMESPACE',error:'Native effects cannot be dispatched through a namespaced call.',actionDispatched:false},false);
      if(!safeCall(call))return raw(call,context);
      handlers.set(call.name,raw);
      const args=parseArgs(call);
      if(reads.has(args.action)){
        const result=await raw(call,context);
        if(args.action!=='run')try{await observeRead(raw,call,result,context);}catch(error){onEvent({type:'operation.receipt.warning',code:'OPERATIONAL_RECEIPT_UNCERTAIN',message:String(error.message).slice(0,500)});}
        return result;
      }
      const callDigest=digest({name:call.name,arguments:args}),callId=call.callId||randomUUID(),operationId='native:'+digest([taskId,runId,nodeId,callId]).slice(0,40);
      if(pending.has(operationId)){const active=pending.get(operationId);if(active.callDigest!==callDigest)throw fail('OPERATIONAL_CALL_ID_REUSED','The same call ID has different arguments.');return clone(await active.promise);}
      const execute=async()=>{
        let previous,journalError;try{previous=(await records()).find(row=>row.operationId===operationId);}catch(error){journalError=error;}
        if(previous){if(previous.callDigest!==callDigest)throw fail('OPERATIONAL_CALL_ID_REUSED','The same call ID has different arguments.');if(previous.result)return clone(previous.result);throw fail('OPERATIONAL_EFFECT_UNCERTAIN','This exact operation is retained but has no recoverable result. Inspect it; it was not repeated.');}
        if(raw.operationOwner&&(raw.operationOwner.taskId!==taskId||raw.operationOwner.nodeId!==nodeId))throw fail('OPERATIONAL_OWNER_MISMATCH','The native adapter belongs to another worker.');
        const descriptor=await (typeof raw.describeOperation==='function' ? raw.describeOperation(call,context)
          : call.name==='relay_workspace'&&args.action==='run' ? describeHostOperation(call,{cwd})
          : Promise.reject(fail('OPERATION_DESCRIPTOR_UNAVAILABLE','The native operation descriptor is unavailable.')));
        if(descriptor.effect==='observe'){
          const result=await raw(call,context);
          try{await observeRead(raw,call,result,context);}catch{}
          return result;
        }
        const legacyCall={tool:call.name,action:args.action};
        let recovery=null,recoveryBinding=null;
        try { await assertNoRetainedEffectConflict(store,taskId,descriptor,legacyCall); }
        catch(error) {
          if(!ownerRecovery?.enabled||!error.recoveryClaims?.length||args.action==='run')
            return {...receipt({code:error.code,error:error.message,actionDispatched:false},false),code:error.code};
          try{
            if(call.name==='relay_workspace'&&['write','patch','undo_patch'].includes(args.action))
              recoveryBinding=await workspaceRecoveryBinding(descriptor);
            else if(call.name==='relay_browser'&&typeof raw.captureRecoveryBinding==='function'&&typeof raw.revalidateRecoveryBinding==='function')
              recoveryBinding=await raw.captureRecoveryBinding(call,context);
            else throw fail('OWNER_RECOVERY_UNAVAILABLE','This operation has no exact recoverable target. Ordinary inspection remains available.');
            onEvent({type:'operation.recovery.pending',operationId,message:'One exact action awaits native owner review; no action was dispatched.'});
            recovery=await ownerRecovery.request({taskId,runId,nodeId,operationId,signal:signal||context.signal,
              candidate:{tool:call.name,action:args.action,target:descriptorKeys(descriptor).join("\n"),summary:args.action+' on the exact retained target',
                parameters:clone(args),preconditions:clone(recoveryBinding),descriptor:clone(descriptor)},claims:error.recoveryClaims});
          }catch(recoveryError){return {...receipt({code:recoveryError.code,error:recoveryError.message,actionDispatched:false},false),code:recoveryError.code};}
        }
        // Opaque workspace commands are not new receipt authority, but they must
        // still respect historical uncertainty before their actual dispatch.
        let reservation=null,result,thrown,dispatchAdmission;
        const dispatchContext={...context,...(recovery?{recoveryBinding}:{}),operationId,operationDescriptor:descriptor,onOperationDispatch:current=>dispatchAdmission=store.enqueue('native-recovery-admission',async()=>{
          if(journalError)throw journalError;
          if(current.operationKey!==descriptor.operationKey)throw fail('OPERATION_DESCRIPTOR_CHANGED','The operation changed before dispatch.');
          if(signal?.aborted||context.signal?.aborted)throw fail('OWNER_RECOVERY_CANCELLED','The run stopped before dispatch.');
          if(recovery){
            if(call.name==='relay_workspace'){
              if(digest(await workspaceRecoveryBinding(current))!==digest(recoveryBinding))throw fail('OWNER_RECOVERY_PRECONDITION','The file changed while awaiting review.');
            }else await raw.revalidateRecoveryBinding(recoveryBinding,call,context);
          }
          await assertNoRetainedEffectConflict(store,taskId,current,legacyCall,{acceptedClaims:recovery?.claims||[]});
          if(relevant(current,call))reservation=await reserve(call,current,operationId,callDigest);
          if(context.onOperationDispatch)await context.onOperationDispatch(current);
          if(recovery){ownerRecovery.consumed(recovery.requestId);onEvent({type:'operation.recovery.authorized',operationId,requestId:recovery.requestId,binding:recovery.binding,claimDigests:recovery.claims.map(row=>row.digest),message:'Owner accepted retained uncertainty for this exact action only; old outcomes remain unchanged.'});}
        })};
        try{result=await raw(call,dispatchContext);}catch(error){thrown=error;}
        // Queue cancellation can return before an in-progress admission finishes.
        // Settle its eventual reservation before returning, without replaying input.
        if(dispatchAdmission)try{await dispatchAdmission;}catch{}
        if(recovery)ownerRecovery.abandon(recovery.requestId);
        if(reservation){
          const body=bodyOf(result),absent=thrown?.actionDispatched===false||thrown?.inputDispatched===false||body.actionDispatched===false||body.inputDispatched===false;
          let state=absent?'absent':'unknown',evidence=[],interpretations=[];
          if(!absent&&result?.success===true){
            try{const observed=await nativeObservation(raw,call,result,descriptor,[reservation],context),proof=acceptedBrowserProofs(observed,reservation);state=proof.state;evidence=proof.evidence;interpretations=proof.interpretations;
              if(call.name==='relay_workspace'&&await verifiedWorkspaceEffect(call,result,descriptor)){state='confirmed';evidence=[{kind:'observation',resourceKey:reservation.resources.find(key=>key.startsWith('path:')),digest:digest(body),validation:{adapter:'relay_workspace',source:'native-write-readback',operationId}}];}}
            catch{}
          }
          const note={type:'operational.effect',operationId,effect:descriptor.effect,state,source:reservation.application?'application':'generic',confirmation:'Tool return is not proof of external acceptance',deduplication:'One exact destination or resource; unrelated work can continue'};
          const returned=result?{...result,contentItems:[...(result.contentItems||[]),{type:'inputText',text:JSON.stringify(note)}]}:undefined;
          try{const saved=await saveOutcome(operationId,{state,evidence,interpretations,deliveryState:absent?'cancelled-before-dispatch':thrown?'interrupted':'returned',result:returned,resultDigest:digest(result||{code:thrown?.code||null,message:thrown?.message||null})});note.state=saved.state;}
          catch(error){note.state='unknown';onEvent({type:'operation.receipt.warning',code:'OPERATIONAL_RECEIPT_UNCERTAIN',operationId,message:String(error.message).slice(0,500)});}
          onEvent(note);if(result)result={...result,contentItems:[...(result.contentItems||[]),{type:'inputText',text:JSON.stringify(note)}]};
        }
        if(thrown)throw thrown;return result;
      };
      const promise=execute();pending.set(operationId,{callDigest,promise});try{return await promise;}finally{pending.delete(operationId);}
    };
    wrapped.describeOperation=raw.describeOperation?.bind(raw);wrapped.normalizeOperationResult=raw.normalizeOperationResult?.bind(raw);wrapped.normalizeOperationalResult=raw.normalizeOperationalResult?.bind(raw);return wrapped;
  }
  async function handle(call,context={}){
    try{
      if(call.name!=='relay_effects'||call.namespace)throw fail('OPERATIONAL_TOOL_INVALID','Use the native operational receipt tool.');
      const args=parseArgs(call),allowed=['action','operationId','tabId','receiptBinding'];
      if(Object.keys(args).some(key=>!allowed.includes(key))||!['list','read','reconcile'].includes(args.action))throw fail('OPERATIONAL_TOOL_INVALID','Use list, read, or reconcile with supported fields.');
      const rows=(await records()).filter(row=>owned(row,taskId,nodeId));
      if(args.action==='list'){if(Object.keys(args).length!==1)throw fail('OPERATIONAL_TOOL_INVALID','List takes only action.');return receipt({total:rows.length,truncated:rows.length>100,operations:rows.slice(-100).map(({operationId,adapter,action,state,deliveryState,at,settledAt,evidence,interpretations})=>({operationId,adapter,action,state,deliveryState,at,settledAt,evidenceCount:evidence?.length||0,interpretationCount:interpretations?.length||0}))});}
      if(typeof args.operationId!=='string')throw fail('OPERATIONAL_TOOL_INVALID','Select an exact retained operation ID.');
      const row=rows.find(item=>item.operationId===args.operationId);
      if(!row)throw fail('OPERATIONAL_RECEIPT_NOT_FOUND','This worker has no such retained operation.');
      if(args.action==='read'){if(args.tabId!==undefined||args.receiptBinding!==undefined)throw fail('OPERATIONAL_TOOL_INVALID','Read takes only the retained operation ID.');return receipt(row);}
      if(row.state!=='unknown')return receipt(row);
      const raw=handlers.get('relay_browser');
      if(row.adapter!=='relay_browser'||!row.descriptor?.commit||!raw||typeof args.tabId!=='string'||!args.tabId)throw fail('OPERATIONAL_RECONCILIATION_UNAVAILABLE','Use ordinary native reads for local files. This browser receipt requires its retained native POST and an available owned response page.');
      if(raw.operationOwner&&(raw.operationOwner.taskId!==taskId||raw.operationOwner.nodeId!==nodeId))throw fail('OPERATIONAL_OWNER_MISMATCH','The native browser belongs to another worker.');
      const binding=args.receiptBinding?normalizeOperationalReceiptBinding(args.receiptBinding):null;
      if(binding&&binding.outcomeFields.some(name=>(row.descriptor.commit.identityDigests||[]).filter(item=>item.name===name).length!==1))throw fail('OPERATIONAL_RECEIPT_BINDING_INVALID','Receipt identity must use actual submitted form-field names.');
      const observedCall={name:'relay_browser',callId:call.callId,arguments:{action:'read',browser:'relay',tabId:args.tabId}};
      const descriptor=await raw.describeOperation(observedCall,context),result=await raw(observedCall,{...context,operationDescriptor:descriptor});
      if(result?.success!==true)return result;
      const candidate={...row,receiptBindings:binding?[binding]:row.receiptBindings||[]};
      const observed=await nativeObservation(raw,observedCall,result,descriptor,[candidate],context),proof=acceptedBrowserProofs(observed,candidate);
      if(binding&&proof.evidence.some(item=>matchingCorrelation(item,row))){
        await serialized(async()=>{const journal=await read(),current=journal.records.find(item=>item.operationId===row.operationId&&owned(item,taskId,nodeId));if(!current)throw fail('OPERATIONAL_RECEIPT_MISSING','The operation receipt changed.');
          if(current.receiptBindings?.length&&digest(current.receiptBindings)!==digest([binding]))throw fail('OPERATIONAL_RECEIPT_BINDING_CHANGED','The retained receipt mapping cannot be reinterpreted. Read it and preserve the original evidence.');
          current.receiptBindings=[binding];await write(journal);});
      }
      if(proof.evidence.length)await saveOutcome(row.operationId,proof);
      return receipt({operation:(await records()).find(item=>item.operationId===row.operationId),observation:result,outcomeAssurance:'Native request/response and observed text are retained. This adapter does not establish business acceptance or absence; unrelated work may continue.'});
    }catch(error){return receipt({code:error.code||'OPERATIONAL_RECEIPTS_UNAVAILABLE',error:String(error.message).slice(0,1000),actionDispatched:false},false);}
  }
  const attach=(name,raw)=>{if(typeof raw==='function')handlers.set(name,raw);};
  return{wrap,records,handle,attach,scopeId:storeKey};
}
