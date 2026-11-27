/** Provider-independent repeated tool failure policy.
 * An identical action/code with different arguments is still a repeated failed method.
 * Model-generated batches are one recovery opportunity for trusted no-input browser refs
 * and read-only workspace discovery, but never an unlimited failure allowance.
 * No previous effect is replayed or reclassified by this policy. */
export const TOOL_FAILURE_LIMITS=Object.freeze({repeatedFailure:8,silentFailure:64,callsPerTurn:2048});
export const hostToolStopCode=code=>code==='TOOL_FAILURE_LOOP'||code==='TOOL_CALL_LIMIT';

export function repeatedToolFailure(state,call,result,{progressEpoch,limits=TOOL_FAILURE_LIMITS,ignoreDirectoryFocus=false}={}){
 if(!state||result?.success===true){if(state)state.dynamicToolFailure=null;return null;}
 const code=typeof result?.code==='string'?result.code.slice(0,120):'TOOL_FAILED';
 // A dedicated Directory recovery hook gets one additional bounded recovery
 // window after its own eighth-failure snapshot; it is never an infinite exemption.
 const directoryRecovery=ignoreDirectoryFocus&&code==='DIRECTORY_FOCUS'&&result.actionDispatched===false;
 let args;try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;}catch{}
 const action=typeof args?.action==='string'?args.action.slice(0,80):'';
 const tool=String(call.name||call.tool||'').slice(0,120);
 // Only trusted result-envelope metadata can prove a request was not sent.
 // Text from tools, websites and providers cannot authorize a weaker cap.
 const knownNoInput=result?.actionDispatched===false;
 const batchSafe=tool==='relay_workspace'&&action==='read'||
   tool==='relay_browser'&&['BROWSER_REF_STALE','BROWSER_INPUT_DOCUMENT_CHANGED'].includes(code)&&knownNoInput;
 const namespace=typeof call.namespace==='string'?call.namespace.slice(0,120):'';
 const key=JSON.stringify([namespace,tool,action,code]);
 const prior=state.dynamicToolFailure?.key===key?state.dynamicToolFailure:null;
 const count=prior&&(!batchSafe||progressEpoch===undefined||prior.progressEpoch===undefined||progressEpoch>prior.progressEpoch)
  ?prior.count+1:prior?.count||1;
 const total=(prior?.total||0)+1;
 state.dynamicToolFailure={key,count,total,...(progressEpoch===undefined?{}:{progressEpoch:Math.max(progressEpoch,prior?.progressEpoch??progressEpoch)})};
 const maxAttempts=directoryRecovery?limits.repeatedFailure*2:limits.repeatedFailure;
 if(count<maxAttempts&&(!batchSafe||total<limits.silentFailure))return null;
 return {tool,action,code,count,total,batchSafe,
  message:'Repeated '+tool+' '+(action||'operation')+' failures ('+code+') '+total+' times'+
  (batchSafe?' across '+count+' recovery opportunities':'')+'. Stop repeating this method; inspect the last saved tool error and actual task state, then change the arguments or recovery approach. Previously completed effects were not replayed.'};
}
