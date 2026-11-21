import {createHash} from 'node:crypto';
import {validDirectArguments} from './direct-execution-api.mjs';
import {createDirectPlanningBrowserTools} from './direct-planning-browser-tools.mjs';

const nativeNames=Object.freeze({blackice_planning_graph_read:'relay_planning_read',blackice_planning_graph_write:'relay_planning_write',blackice_planning_module:'relay_planning_module'});
export const NATIVE_PLANNING_TOOL_NAMES=Object.freeze(Object.values(nativeNames));
const fail=(message,code='NATIVE_PLANNING_SCOPE')=>Object.assign(new Error(message),{code,status:403});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition=entry=>({...entry.definition,type:'function',name:nativeNames[entry.definition.name],description:entry.definition.name==='blackice_planning_graph_read'
 ?"Read this conversation's saved Planning graph. list finds graph IDs; templates lists available templates. schema with writeAction returns the current write-action fields; field optionally selects one nested field. get reads graphRequestId. source reads a source; response_history and attempts read saved contributions and execution results; program pages the graph's XML with offset/limit. Reads do not start workers."
 :entry.definition.name==='blackice_planning_graph_write'
 ?"Create or edit this conversation's Planning graph. Use relay_planning_read action:\"schema\" with the intended writeAction for its current fields, then read the graph for current revisions. create_request/add_module creates graph content; update_module/update_program changes it; assign/link/add_source records relationships or sources; record_response saves a contribution with nodeId, expectedNodeRevision and values. These writes save graph data without starting workers or performing external actions."
 :"Run or cancel one analytical Planning module in this conversation. run needs its current node revision and starts a model worker with no action tools. Read attempts and response_history for the completed result; an admission receipt only confirms that execution started. cancel targets an exact active attempt and preserves its saved results."});

/** Host-only provider. taskId is the canonical conversation root, never model input.
 * extraTools may expose the shared analytical module admission adapter only.
 * Automatic response-cycle orchestration is retired; no legacy fallback is attached.
 */
export function createNativePlanningTools({store,getExecutionSnapshot=null,onChange=()=>{},extraTools=[]}={}){
 if(!Array.isArray(extraTools)||extraTools.some(entry=>entry.definition?.name!=='blackice_planning_module'||typeof entry.execute!=='function')||extraTools.length>1)
  throw fail('Only the host analytical module adapter may extend native Planning.','NATIVE_PLANNING_CONFIGURATION');
 const provider=async({taskId,runId,nodeId,signal,canWrite=true})=>{
  if(!taskId||!runId||!nodeId)throw fail('Native Planning requires a saved host task, run and node.');
  const conversationId=taskId,actor={type:'agent',id:runId+':'+nodeId},writer=store.runtimeWriter();
  const shared=createDirectPlanningBrowserTools({store,getExecutionSnapshot,onChange,
   getCatalog:async()=>({...await store.list({conversationId}),conversations:[],errors:[]}),
   writerContext:args=>({actor,clientRequestId:'native:'+digest([runId,nodeId,args.requestId]),
    recordResponse:(requestId,moduleId,value,options)=>writer.recordSupervisedResponse(requestId,moduleId,value,options)})
  });
  const entries=[...shared,...extraTools].map(entry=>({...entry,definition:definition(entry)})).filter(entry=>canWrite||!entry.definition.mutating);
  return {tools:entries.map(entry=>entry.definition),async handle(call,context={}){
   const entry=entries.find(entry=>entry.definition.name===call.name);
   if(!entry||call.namespace)throw fail('This native Planning tool is not attached.');
   let args;try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):structuredClone(call.arguments);}catch{throw fail('Use Planning arguments.','NATIVE_PLANNING_INVALID');}
   if(!validDirectArguments(args,entry.definition.inputSchema))throw fail('Use the exact attached Planning tool schema.','NATIVE_PLANNING_INVALID');
   if(args.conversationId&&args.conversationId!==conversationId)throw fail('Planning access is restricted to this conversation.');
   if(args.action==='list'||args.action==='create_request')args.conversationId=conversationId;
   if(args.graphRequestId&&args.action!=='create_request'){
    const request=await store.get(args.graphRequestId);
    if(request.conversationId!==conversationId)throw fail('Planning access is restricted to this conversation.');
   }
   return entry.execute(args,{signal:context.signal||signal,nativeContext:{taskId,runId,nodeId,clientRequestId:'native:'+digest([runId,nodeId,args.requestId])}});
  }};
 };
 // Schema restoration never invokes or expands the saved tool catalog.
 provider.catalog=[...createDirectPlanningBrowserTools({store}),...extraTools].map(definition);
 return provider;
}
