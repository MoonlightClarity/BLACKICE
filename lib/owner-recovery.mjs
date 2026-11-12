import { randomUUID, createHash } from 'node:crypto';
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), {code, status:409, actionDispatched:false});
/** Process-local, exact pending-call recovery. Approval never survives a restart,
 * changes the old receipt, or grants authority to a new call. */
export function createOwnerRecovery({enabled=false, timeoutMs=300000, now=Date.now}={}) {
  const rows=new Map(); let closed=false;
  const check = (request, state='pending') => {
    const entry=rows.get(request?.requestId);
    if (!entry || entry.row.revision!==request.revision || entry.row.state!==state)
      throw fail('OWNER_RECOVERY_STALE','This exact pending action is no longer available.');
    if(now()>=entry.deadline){entry.finish('expired');throw fail('OWNER_RECOVERY_EXPIRED','This pending action expired. Nothing was dispatched.');}
    return entry;
  };
  const list=()=>[...rows.values()].map(e=>clone(e.row));
  const read=id=>rows.has(id)?clone(rows.get(id).row):null;
  function request({taskId,runId,nodeId,operationId,candidate,claims,signal}) {
    if(!enabled||closed)throw fail('OWNER_RECOVERY_UNAVAILABLE','Native owner recovery is unavailable.');
    if(signal?.aborted)throw fail('OWNER_RECOVERY_CANCELLED','The run stopped. Nothing was dispatched.');
    if(!candidate||!Array.isArray(claims)||!claims.length||JSON.stringify({candidate,claims}).length>55000)
      throw fail('OWNER_RECOVERY_UNAVAILABLE','This exact action cannot be fully reviewed.');
    if(rows.size>=100){for(const [id,e] of rows)if(e.row.state!=='pending')rows.delete(id);}
    if(rows.size>=100)throw fail('OWNER_RECOVERY_LIMIT','Too many actions are awaiting review.');
    const requestId=randomUUID(),deadline=now()+timeoutMs;
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const row={requestId,revision:1,state:'pending',oneUse:true,taskId,runId,nodeId,operationId,
      createdAt:new Date(now()).toISOString(),expiresAt:new Date(deadline).toISOString(),
      candidate:clone(candidate),claims:clone(claims),
      risk:'An older opaque command has an unresolved outcome and could have affected this destination. Allowing this one exact action accepts that uncertainty; it does not establish that the older command failed without effects.'};
    const entry={row,deadline,finish(state){
      if(row.state!=='pending')return;
      row.state=state;row.revision++;row.updatedAt=new Date(now()).toISOString();
      clearTimeout(entry.timer);signal?.removeEventListener('abort',abort);
      if(state==='approved')resolve({requestId,binding:hash({candidate:row.candidate,claims:row.claims}),claims:clone(row.claims)});
      else reject(fail('OWNER_RECOVERY_'+state.toUpperCase(),'This pending action was '+state+'. Nothing was dispatched.'));
    }};
    const abort=()=>entry.finish('cancelled');
    entry.timer=setTimeout(()=>entry.finish('expired'),timeoutMs);entry.timer.unref?.();
    signal?.addEventListener('abort',abort,{once:true});rows.set(requestId,entry);
    return promise;
  }
  function act(value,state){
    if(value?.actor!=='native-owner-confirmation')throw fail('OWNER_RECOVERY_ACTOR','Use the native owner review.');
    const entry=check(value);entry.finish(state);return clone(entry.row);
  }
  function consumed(id, state='consumed'){
    const e=rows.get(id);
    if(!e||e.row.state!=='approved')throw fail('OWNER_RECOVERY_STALE','This approval is no longer available.');
    if(now()>=e.deadline){e.row.state='expired';e.row.revision++;throw fail('OWNER_RECOVERY_EXPIRED','This approval expired before dispatch.');}
    e.row.state=state;e.row.revision++;return clone(e.row);
  }
  return {enabled,request,list,read,approve:value=>act(value,'approved'),cancel:value=>act(value,'cancelled'),consumed,
    abandon(id){const e=rows.get(id);if(e?.row.state==='approved'){e.row.state='invalidated';e.row.revision++;}},
    close(){closed=true;for(const e of rows.values()){if(e.row.state==='approved'){e.row.state='invalidated';e.row.revision++;}else e.finish('cancelled');}}};
}
