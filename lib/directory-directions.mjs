// Disposable Directory phase identities stay private, not parent resume IDs.
export function createDirectoryDirections({runtime, rows, onDelivery = () => {}, signal}) {
  const active = new Map(), pending = new Set();
  let closed = false;
  const aggregate = row => {
    const targets=row.delivery.targets;
    row.delivery.status=targets.every(x=>x.status==='delivered')?'delivered'
      :targets.some(x=>x.status==='uncertain')?'uncertain'
      :targets.some(x=>x.status==='rejected')?'rejected':'queued';
  };
  const receipt = row => ({accepted:true,queued:!row.delivery||['queued','attempting'].includes(row.delivery.status),
    delivery:row.delivery?.status==='attempting'?'queued':row.delivery?.status||'queued',
    ...(row.delivery?{directionDelivery:structuredClone(row.delivery)}:{})});
  const deliver = async row => {
    if(closed||signal?.aborted)return receipt(row);
    if(!row.delivery){
      if(!active.size)return receipt(row);
      row.delivery={status:'queued',targets:[...active.values()].map(x=>({...x,status:'waiting'}))};
    }
    const ready=row.delivery.targets.filter(target=>target.status==='waiting'&&active.get(target.directoryTurnId)?.threadId&&active.get(target.directoryTurnId)?.turnId);
    if(!ready.length)return receipt(row);
    for(const target of ready)Object.assign(target,active.get(target.directoryTurnId),{status:'attempting'});
    // Persist claims before sending. An interrupted attempt is never replayed.
    aggregate(row);await onDelivery(row);
    await Promise.all(ready.map(async target=>{
      const phase=active.get(target.directoryTurnId);
      if(closed||signal?.aborted||!phase||phase.threadId!==target.threadId||phase.turnId!==target.turnId){target.status='expired';return;}
      try{
        const result=await runtime.steerAgent(target.threadId,row.text);
        if(result?.threadId&&result.threadId!==target.threadId||result?.turnId&&result.turnId!==target.turnId)throw Error('Direction acknowledgement did not match the targeted phase turn.');
        const queued=result?.queued===true||result?.delivery==='queued';
        Object.assign(target,{receipt:result,status:result?.accepted===false?'rejected':queued?'queued':result?.accepted===true?'delivered':'rejected'});
      }catch(error){Object.assign(target,{status:'uncertain',error:String(error.message).slice(0,500)});}
    }));
    aggregate(row);await onDelivery(row);return receipt(row);
  };
  const track=promise=>{pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
  return{
    async steer(row){if(closed||signal?.aborted)throw Object.assign(new Error('Directory is no longer accepting live directions.'),{code:'TURN_NOT_ACTIVE',status:409});return track(deliver(row));},
    phase({directoryTurnId,threadId,turnId,finished}){
      if(finished){active.delete(directoryTurnId);return;}
      if(closed||signal?.aborted)return;
      const phase=active.get(directoryTurnId)||{directoryTurnId};
      if(threadId)phase.threadId=threadId;if(turnId)phase.turnId=turnId;active.set(directoryTurnId,phase);
      if(phase.threadId&&phase.turnId)for(const row of rows())if(!row.includedIn)track(deliver(row));
    },
    async close(){closed=true;active.clear();await Promise.allSettled([...pending]);},
  };
}
