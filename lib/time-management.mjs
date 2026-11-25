import {planningModuleEnabled} from '../public/planning-module-policy.mjs';

// Time management is telemetry, not model-facing behavioral guidance.
// Wrapping a tool preserves its exact return value, including failures.
export function createTimeManagement({policy,now=()=>performance.now()}={}){
  if(!planningModuleEnabled(policy,'time_management'))return null;
  const started=now();let calls=0,toolMs=0,errors=0;
  const snapshot=()=>({source:'host-time-observation',scope:'current-node-execution',
    elapsedMs:Math.max(0,Math.round(now()-started)),toolCalls:calls,
    toolElapsedMs:Math.round(toolMs),toolErrors:errors,
    outcomeCount:'not-inferred-from-tool-calls',deadline:'none-imposed'});
  return {snapshot,wrap:handler=>async(...args)=>{
    const begin=now();
    try{const value=await handler(...args);if(value?.success===false)errors++;return value;}
    catch(error){errors++;throw error;}
    finally{calls++;toolMs+=Math.max(0,now()-begin);}
  }};
}
