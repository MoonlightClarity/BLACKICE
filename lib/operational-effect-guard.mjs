import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applicationDescriptorTarget, createApplicationHistoryGate } from './application-history.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409, actionDispatched: false });
const active = row => row.state==='unknown' || row.state==='confirmed' && row.effect==='commit';
const now = () => new Date().toISOString();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10000;
const clone = value => structuredClone(value);
const relevant = (descriptor, call) => descriptor?.effect==='commit' || descriptor?.effect==='opaque' && call?.name==='relay_browser' || call?.name==='relay_workspace' && ['write','patch','undo_patch'].includes(typeof call.arguments==='string'?JSON.parse(call.arguments).action:call.arguments?.action);
const safeCall = call => call && ['relay_browser', 'relay_workspace'].includes(call.name) && !call.namespace;
const parseReceipt = result => {
  for (const item of result?.contentItems || []) if (item?.type === 'inputText') try {
    const value = JSON.parse(item.text);
    if (value && typeof value === 'object' && (typeof value.actionDispatched === 'boolean' || typeof value.inputDispatched === 'boolean')) return value;
  } catch {}
  return {};
};
const evidenceResult = (descriptor, observation) => {
  const confirmed = observation?.effectState === 'confirmed' && descriptor.effect === 'commit'
    && Array.isArray(observation.evidence)
    && observation.evidence.some(item => item.confirmation?.status === 'confirmed'
      && item.confirmation.effectKey === descriptor.commit?.effectKey);
  return confirmed ? 'confirmed' : 'unknown';
};
const writeConflict = (a,b) => {
  if (a.effectKey && b.effectKey) return a.effectKey===b.effectKey;
  const common=a.resources.filter(key=>b.resources.includes(key));
  // Ambiguity about one control cannot monopolize unrelated controls on a tab.
  if(a.effect==='opaque'||b.effect==='opaque')
    return a.operationKey===b.operationKey || common.some(key=>key.startsWith('form:'));
  return common.length>0;
};
/** Host receipt plus independently checked file bytes; no plan/model pass. */
async function verifiedWorkspaceEffect(call,result,descriptor){
  if(result?.success!==true||call?.name!=='relay_workspace')return false;
  let args,body;
  try{
    args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
    body=JSON.parse(result.contentItems?.find(item=>item.type==='inputText')?.text||'null');
  }catch{return false;}
  if(!['write','patch','undo_patch'].includes(args?.action)||typeof body?.path!=='string'||!path.isAbsolute(body.path))return false;
  const canonicalPath=path.resolve(body.path).replace(/\\/g,'/');
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

const descriptorKeys = descriptor => {
  const chosen = (descriptor.resources || []).filter(item => item.scopeOnly !== true && item.access === 'write').map(item => item.key);
  return [...new Set(chosen)].sort();
};

/** Independent operational claims, not planning contracts or completion checks. */
export function createOperationalEffectGuard({ store, cwd, taskId, runId, nodeId, onEvent = () => {} } = {}) {
  if (!store || typeof store.enqueue !== 'function' || typeof store.file !== 'function')
    throw new Error('Durable operational effect storage is required for unprotected native effects.');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
    throw new Error('Operational effect receipts require an absolute workspace.');
  if (!taskId || !runId || !nodeId) throw new Error('Operational effect receipts need exact task, run and worker IDs.');
  const storeKey = 'native-effects-' + digest(process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)).slice(0, 32);
  const file = store.file(storeKey) + '.effects';
  const application = createApplicationHistoryGate({store,cwd,taskId});
  async function read() {
    let value;
    try {
      const info = await fs.stat(file);
      if (info.size > MAX_BYTES) throw new Error('Effect journal exceeded its bound.');
      value = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {version:1,root:path.resolve(cwd),records:[]};
      throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The saved operational effect journal cannot be read. Preserve it and inspect its records before another consequential action.');
    }
    if (value?.version !== 1 || value.root !== path.resolve(cwd) || !Array.isArray(value.records)
        || value.records.length > MAX_RECORDS || value.records.some(row => !row || typeof row.operationId !== 'string'
          || typeof row.taskId !== 'string' || typeof row.runId !== 'string' || typeof row.effect !== 'string'
          || !['unknown','absent','confirmed'].includes(row.state) || !Array.isArray(row.resources)
          || row.resources.some(key => typeof key !== 'string')))
      throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The saved operational effect journal is invalid. No consequential action was dispatched.');
    return value;
  }
  async function write(value) {
    const contents = JSON.stringify(value);
    if (value.records.length > MAX_RECORDS || Buffer.byteLength(contents) > MAX_BYTES)
      throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The operational effect journal is full; preserve its existing receipts.');
    const lockOwner = store.lockOwners?.get(storeKey);
    if (!lockOwner) throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','An operational effect lock is not held.');
    const holder = JSON.parse(await fs.readFile(store.file(storeKey) + '.lock', 'utf8'));
    if (holder.pid !== process.pid || holder.token !== lockOwner)
      throw fail('OPERATIONAL_RECEIPTS_UNAVAILABLE','The operational effect lock changed before saving.');
    const temporary = file + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary,'wx',0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle=null;
      await fs.rename(temporary,file);
    } finally {await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true});}
  }
  const serialized = operation => store.enqueue(storeKey, operation);
  async function reserve(descriptor, operationId) {
    return serialized(async()=>{
      const journal=await read(),row={
        operationId,taskId,runId,nodeId,at:now(),effect:descriptor.effect,
        effectKey:typeof descriptor.commit?.effectKey==='string'?descriptor.commit.effectKey:null,
        operationKey:descriptor.operationKey,resources:descriptorKeys(descriptor),state:'unknown'
      };
      if(journal.records.some(item=>active(item)&&writeConflict(item,row)))
        throw fail('OPERATIONAL_EFFECT_UNCERTAIN','The same native external effect or affected resource already has an unresolved or confirmed claim. Inspect the original outcome; this operation was not dispatched.');
      journal.records.push(row);
      await write(journal);
      return clone(row);
    });
  }
  async function settle(operationId, state, note, resultDigest) {
    return serialized(async()=>{
      const journal=await read(),row=journal.records.find(item=>item.operationId===operationId);
      if (!row) throw fail('OPERATIONAL_RECEIPT_MISSING','The native effect was dispatched but its saved claim could not be found. Do not replay it.');
      if (row.state !== 'unknown') return clone(row);
      row.state=state;row.settledAt=now();if(note)row.note=String(note).slice(0,500);
      if(typeof resultDigest==='string')row.resultDigest=resultDigest;
      await write(journal);return clone(row);
    });
  }
  const records=async()=>clone((await read()).records);
  function wrap(rawHandler) {
    if (typeof rawHandler !== 'function') return rawHandler;
    const wrapped=async(call,context={})=>{
      if(!safeCall(call))return rawHandler(call,context);
      const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
      if(['tabs','diagnostics','snapshot','read','screenshot','downloads','wait','open','navigate','back','forward','reload','list','search','patch_history'].includes(args?.action)
        ||call.name==='relay_workspace'&&args?.action==='run')
        return rawHandler(call,context);
      let reservation=null,description=null;
      const operationId='native:'+digest([taskId,runId,nodeId,call.callId||randomUUID()].join(':')).slice(0,40);
      const onOperationDispatch=async descriptor=>{
        if(relevant(descriptor,call)) {
          const target=applicationDescriptorTarget(descriptor);
          if(target){
            const coverage=await application.check({descriptor,operationId,reserve:descriptor.effect==='commit'});
            reservation=coverage ? {operationId,kind:'application',descriptor} : null;
          }else {
            await reserve(descriptor,operationId);
            reservation={operationId,kind:'generic',descriptor};
          }
          description=descriptor;
        }
        if (context.onOperationDispatch) await context.onOperationDispatch(descriptor);
      };
      let receipt,thrown;
      try {receipt=await rawHandler(call,{...context,onOperationDispatch});}
      catch(error){thrown=error;}
      if(reservation) {
        let state='unknown',observed;
        const body=parseReceipt(receipt),explicitAbsent=thrown?.actionDispatched===false
          || thrown?.inputDispatched===false || body.actionDispatched===false || body.inputDispatched===false;
        if(explicitAbsent)state='absent';
        else if(receipt?.success===true && typeof rawHandler.normalizeOperationResult==='function') {
          try {
            observed=await rawHandler.normalizeOperationResult(receipt,{
              ...context,call,descriptor:description,cwd,criteria:[],commitments:[],
            });
            state=evidenceResult(description,observed);
            if(call.name==='relay_workspace'&&await verifiedWorkspaceEffect(call,receipt,description))state='confirmed';
            if(observed?.actionDispatched===false || observed?.inputDispatched===false)state='absent';
          }catch{}
        }
        try {
          if(reservation.kind==='generic')await settle(operationId,state,undefined,digest(JSON.stringify({success:receipt?.success===true,code:receipt?.code||thrown?.code||null,receipt:receipt?.contentItems||[]})));
          else if(state==='absent' || state==='confirmed')
            await application.reconcile([{operationId,commit:description.commit,deliveryState:state==='absent'?'cancelled-before-dispatch':'returned',effectState:state,
              reconciliationEvidenceIds:state==='confirmed'?(observed?.evidence||[]).filter(item=>item.confirmation?.effectKey===description.commit?.effectKey).map(item=>item.id):[]}],
              {notDispatchedOperationId:state==='absent'?operationId:null});
        }catch(error){
          onEvent({type:'operation.receipt.warning',code:'OPERATIONAL_RECEIPT_UNCERTAIN',operationId,message:String(error.message).slice(0,500)});
        }
        const note={type:'operational.effect',operationId,effect:description.effect,state,
          source:reservation.kind,confirmation:'A tool result is not proof of external acceptance',
          deduplication:'One exact destination or resource; unrelated work can continue'};
        onEvent(note);
        if(receipt)receipt={...receipt,contentItems:[...(receipt.contentItems||[]),{type:'inputText',text:JSON.stringify(note)}]};
      }
      if(thrown)throw thrown;
      return receipt;
    };
    wrapped.describeOperation=rawHandler.describeOperation?.bind(rawHandler);
    wrapped.normalizeOperationResult=rawHandler.normalizeOperationResult?.bind(rawHandler);
    return wrapped;
  }
  return {wrap,records,scopeId:storeKey};
}
