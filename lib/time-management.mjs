import {planningModuleEnabled} from '../public/planning-module-policy.mjs';

// Host observations only. No model call, deadline, action cap, or completion claim.
// Diagnostics are outside the journal so changing clocks cannot masquerade as progress.
export function createTimeManagement({policy, now=()=>performance.now(), intervalMs=30000}={}){
  if(!planningModuleEnabled(policy,'time_management'))return null;
  const started=now();let lastNotice=started,calls=0,toolMs=0,errors=0;
  const snapshot=()=>({source:'host-time-observation',scope:'current-node-execution',elapsedMs:Math.max(0,Math.round(now()-started)),
    toolCalls:calls,toolElapsedMs:Math.round(toolMs),toolErrors:errors,
    outcomeCount:'not-inferred-from-tool-calls',deadline:'none-imposed'});
  return {snapshot,wrap:handler=>async (...args)=>{
    const begin=now();let result;
    try{result=await handler(...args);if(result?.success===false)errors++;return decorate(result);}
    catch(error){errors++;throw error;}
    finally{calls++;toolMs+=Math.max(0,now()-begin);}
    function decorate(value){
      const at=now();
      if(at-lastNotice<intervalMs||!Array.isArray(value?.contentItems))return value;
      lastNotice=at;
      const observation={...snapshot(),toolCalls:calls+1,toolElapsedMs:Math.round(toolMs+Math.max(0,at-begin))};
      return {...value,contentItems:[...value.contentItems,{type:'inputText',
        text:'BLACKICE TIME MANAGEMENT OBSERVATION '+JSON.stringify(observation)+'\nReassess whether further depth changes the next useful outcome. This is not a deadline, completion claim, or request to stop.'}]};
    }
  }};
}
