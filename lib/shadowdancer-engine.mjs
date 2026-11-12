import {aggregateTokenUsage,tokenUsageMeasurement,TOKEN_USAGE_FIELDS} from '../public/token-usage.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runShadowdancerDirectory} from './shadowdancer-directory.mjs';
import {usesDirectory} from './conversation-execution-modes.mjs';
import {createProviderExecutionContract} from './provider-execution-contract.mjs';
import {directoryContextConfiguration} from './directory-conversation-scope.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code,status:400});

// A Directory run has many disposable provider sessions. Keep their measured
// capacity separate from aggregate billing usage and from a resumable Chat context.
function directoryContextTracker({model,configuration,usageWindowIsObserved}){
  const phases=new Map(),startedAt=new Date().toISOString();
  const nonnegative=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;
  const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:new Date().toISOString();
  const contextFields=['preset','requestedWindowTokens','modelWindowTokens','configuredModelWindowTokens','effectiveWindowTokens','windowSource',
    'nativeConfiguredWindowTokens','nativeDefaultContextWindowTokens','nativeMaxContextWindowTokens','nativeEffectiveContextWindowPercent',
    'nativeObservedWindowTokens','nativeWindowBasis','inputBudgetTokens','outputReserveTokens','headroomTokens','compactAtTokens',
    'estimatedInputTokens','actualInputTokens','actualOutputTokens','estimateMethod','remainingTokens','remainingIsEstimate','autoCompact','nativeCompaction','invalid'];
  const phase=id=>{
    if(!phases.has(id))phases.set(id,{directoryTurnId:id,phase:null,module:null,status:'running',measurementUpdates:0,
      lastInputTokens:null,peakInputTokens:null,peakObservedAt:null,peakObservedModelWindowTokens:null,observedModelWindowTokens:null,reportedModelWindows:[],
      compactionCount:0,compactions:[],initialContext:null,latestContext:null,lastMeasurement:null});
    return phases.get(id);
  };
  const snapshot=row=>{const {lastMeasurement,...saved}=row;return structuredClone(saved);};
  const window=(row,value)=>{const observed=positive(value);if(observed===null)return;
    row.observedModelWindowTokens=observed;if(!row.reportedModelWindows.includes(observed))row.reportedModelWindows.push(observed);};
  const compact=(row,value,at)=>{
    if(typeof value?.id!=='string'||!value.id||row.compactions.some(item=>item.id===value.id))return;
    row.compactions.push({id:value.id,at:stamp(value.at||at),...(typeof value.method==='string'?{method:value.method}:{})});
    row.compactionCount=Math.max(row.compactionCount,row.compactions.length);
  };
  return {
    progress(value){if(!value?.turnId)return;const row=phase(value.turnId);
      if(typeof value.phase==='string')row.phase=value.phase;if(typeof value.module==='string')row.module=value.module;
      if(value.event==='finished')row.status='completed';},
    usage(id,value,at){const row=phase(id);
      // Native transports report their window on usage notifications. API
      // adapters can copy catalog metadata here during compaction or errors.
      if(usageWindowIsObserved)window(row,value?.modelContextWindow);
      // Native totals accumulate across hundreds of model exchanges. Only the
      // provider's last-input measurement can establish an observed input peak.
      const last=value?.last,availability=last?.availability?.inputTokens;
      const single=last?.samples===undefined||last.samples===1;
      const measured=single&&(availability===undefined||availability==='reported')?nonnegative(last?.inputTokens):null;
      if(measured!==null){
        const signature=JSON.stringify([measured,last?.outputTokens,value?.total?.inputTokens,value?.total?.outputTokens,value?.modelContextWindow]);
        if(signature!==row.lastMeasurement){row.measurementUpdates++;row.lastMeasurement=signature;}
        row.lastInputTokens=measured;
        if(row.peakInputTokens===null||measured>row.peakInputTokens){row.peakInputTokens=measured;row.peakObservedAt=stamp(at);row.peakObservedModelWindowTokens=row.observedModelWindowTokens;}
      }
      return snapshot(row);
    },
    context(id,value,at){const row=phase(id),saved={};
      for(const key of contextFields)if(Object.hasOwn(value||{},key)){
        const entry=value[key];if(entry===null||['string','boolean'].includes(typeof entry)||typeof entry==='number')saved[key]=typeof entry==='number'&&!Number.isFinite(entry)?null:entry;
      }
      row.initialContext??=saved;row.latestContext=saved;
      window(row,value?.nativeObservedWindowTokens);
      if(Number.isSafeInteger(value?.compactionCount)&&value.compactionCount>=0)row.compactionCount=Math.max(row.compactionCount,value.compactionCount);
      compact(row,value?.lastCompaction,at);return snapshot(row);
    },
    compaction(id,value,at){const row=phase(id);compact(row,value,at);return snapshot(row);},
    finish(id,status){phase(id).status=status;},
    summary(status){const rows=[...phases.values()].map(snapshot),measured=rows.filter(row=>row.peakInputTokens!==null);
      const peak=measured.reduce((best,row)=>!best||row.peakInputTokens>best.peakInputTokens?row:best,null);
      return {version:1,scope:'directory-phases',status,startedAt,measurementSource:'provider-reported-last-input',
        configured:{model,options:structuredClone(configuration.options),knownCapacity:configuration.knownCapacity,
          inputBudgetTokens:configuration.knownCapacity?configuration.inputBudgetTokens:null},
        measuredPhases:measured.length,peakInputTokens:peak?.peakInputTokens??null,
        peak:peak?{directoryTurnId:peak.directoryTurnId,phase:peak.phase,module:peak.module,inputTokens:peak.peakInputTokens,modelContextWindowTokens:peak.peakObservedModelWindowTokens,at:peak.peakObservedAt}:null,
        reportedModelWindows:[...new Set(rows.flatMap(row=>row.reportedModelWindows))],
        compactionCount:rows.reduce((total,row)=>total+row.compactionCount,0),phases:rows};
    },
  };
}
export function assertDirectoryWorkflow(graph,input,mode){
  if(!usesDirectory(input,mode))return;
  const agents=graph?.nodes?.filter(x=>x.type==='agent')||[];
  if(agents.length!==1||graph?.planning?.shared===true||graph?.planning?.mode==='shared'||graph?.planning?.enabled||agents[0]?.assignment||graph?.planning?.coordinatorNodeId)
    throw fail('DIRECTORY_WORKFLOW_UNSUPPORTED','Directory mode requires one independently owned Chat agent. Turn Directory Off for shared or multi-agent workflows.');
}
/** Execute through the ordinary fully prepared host dispatcher, never a second effect path. */
export async function runPreparedDirectoryAgent({runtime,options,input,conversationId,runId,model,getAcceptedDirections,agentInstructions,harnessInstructions,evidenceContext,onProgress,onResult,planningOntology,getCompletionAssessment,getCompletionEvidence,supportsAtomicOutcomeReview=false}){
  const {threadId,turnId,continuity,usageBaseline,onEvent,onBeforeFinal,onToolCall,...prepared}=options;
  const requestOnly=value=>String(value||'').split(/\r?\nSOURCE:\s*\r?\n/i)[0];
  const authoritativeContext=()=>{const source=getAcceptedDirections?.()||{},clean=row=>row?{...row,text:requestOnly(row.text)}:null;return JSON.stringify({agentInstructions,hostHarnessInstructions:harnessInstructions,currentUserRequest:clean(source.currentUserRequest),priorUserRequests:(source.priorUserRequests||[]).map(clean),acceptedDirections:(source.acceptedDirections||[]).map(clean)});};
  const usageByTurn=new Map();let totalUsage,lastUsage=null;
  const canonicalUsage=value=>{const row=value&&typeof value==='object'&&!Array.isArray(value)?value:{};const record=TOKEN_USAGE_FIELDS.some(key=>Object.hasOwn(row,key))||Object.hasOwn(row,'samples')?row:(row.total&&typeof row.total==='object'?row.total:row);return aggregateTokenUsage([Object.hasOwn(record,'samples')?record:{...record,samples:1}]);};
  const recordUsage=(id,usage,completed=false,at)=>{if(!usage||typeof usage!=='object'){if(!completed||usageByTurn.has(id))return;usage=tokenUsageMeasurement({});}const observed=contextUsage.usage(id,usage,at),row=canonicalUsage(usage);usageByTurn.set(id,row);lastUsage=usage.last&&typeof usage.last==='object'?canonicalUsage(usage.last):(row.samples===1?structuredClone(row):null);const aggregate=aggregateTokenUsage(usageByTurn.values());totalUsage={...aggregate,total:structuredClone(aggregate),last:lastUsage,modelContextWindow:null};onEvent?.({type:'usage',usage:totalUsage,shadowdancer:true,directoryTurnId:id,directoryUsage:observed});};
  const catalog=await runtime.status?.();
  const selectedModel=(catalog?.models||[]).find(row=>row.model===model||row.id===model)||{};
  const directoryContext=directoryContextConfiguration({model:selectedModel,context:options.context||{}});
  const contextUsage=directoryContextTracker({model,configuration:directoryContext,
    usageWindowIsObserved:!selectedModel.providerId&&!String(model).includes('::')||selectedModel.providerType==='subscription-cli'});
  const canWrite=options.sandbox!=='read-only';
  const quote=value=>process.platform==='win32'?"'"+String(value).replaceAll("'","''")+"'":"'"+String(value).replaceAll("'","'\\''")+"'";
  const assertRepository=repoRoot=>{
    if(path.relative(path.resolve(options.cwd),path.resolve(repoRoot))!=='')
      throw fail('DIRECTORY_REPOSITORY_SCOPE','Directory repository work must use the conversation working folder. Start a new Chat in the required folder rather than changing tool ownership.');
  };
  const dispatch=(call,context)=>onToolCall?onToolCall(call,context):Promise.resolve({success:false,code:'DIRECTORY_TOOL_UNAVAILABLE',contentItems:[{type:'inputText',text:'The prepared Chat dispatcher has no tools.'}]});
  const executeTestCommand=async({repoRoot,executable,tests,timeoutMs,receiptFile})=>{
    assertRepository(repoRoot);
    if(!canWrite)throw fail('DIRECTORY_REPOSITORY_READ_ONLY','Repository verification requires a writable owned Chat workspace.');
    const command=process.platform==='win32'
      ?'Set-Location -LiteralPath '+quote(repoRoot)+'; Remove-Item Env:NODE_TEST_CONTEXT -ErrorAction SilentlyContinue; $env:ELECTRON_RUN_AS_NODE="1"; & '+quote(executable)+' --test --test-reporter=tap '+tests.map(quote).join(' ')+'; exit $LASTEXITCODE'
      :'cd '+quote(repoRoot)+' && env -u NODE_TEST_CONTEXT ELECTRON_RUN_AS_NODE=1 '+quote(executable)+' --test --test-reporter=tap '+tests.map(quote).join(' ');
    const callId='directory-verification:'+createHash('sha256').update(String(receiptFile)).digest('hex');
    const result=await dispatch({name:'relay_workspace',callId,arguments:{action:'run',command,timeoutMs}});
    for(const item of result?.contentItems||[]){
      let value;try{value=JSON.parse(item.text);}catch{continue;}
      if(Number.isInteger(value.exitCode)||value.timedOut)return value;
      if(value.code&&!value.type?.startsWith('operational.'))throw fail(value.code,value.message||value.error||value.code);
    }
    throw fail('DIRECTORY_VERIFICATION_UNCERTAIN','No settled verification command receipt was returned. Do not replay the command.');
  };
  let pilot;
  try{pilot=await runShadowdancerDirectory({
    input,cwd:options.cwd,conversationId,runId,model,signal:options.signal,canWrite,
    inputBudgetTokens:directoryContext.inputBudgetTokens,developerInstructions:options.developerInstructions,
    baseTools:prepared.dynamicTools||[],dispatchTool:dispatch,
    createRepositoryHandler:request=>{assertRepository(request.cwd);return dispatch;},executeTestCommand,
    getAuthoritativeContext:authoritativeContext,evidenceContext,planningOntology,onBeforeFinal,getCompletionAssessment,getCompletionEvidence,supportsAtomicOutcomeReview:supportsAtomicOutcomeReview===true,
    onProgress:value=>{contextUsage.progress(value);onProgress?.(value);},
    runtime:{runAgent:async phase=>{
      const {directoryTurnId,...phaseOptions}=phase;
      const tools=phaseOptions.dynamicTools||[];
      const contract=phaseOptions.responseOnly||!prepared.providerExecutionContract?undefined:createProviderExecutionContract({dynamicTools:tools,planningContractVersion:14});
      let result;
      try{result=await runtime.runAgent({...prepared,...phaseOptions,hostOnlyTools:true,model,context:directoryContext.options,
        // Each phase gets the same authoritative developer instructions but no provider history.
        developerInstructions:options.developerInstructions,codexHistory:'relay',
        dynamicTools:tools,onToolCall:phaseOptions.onToolCall,
        providerExecutionContract:contract,
        onToolResultDelivered:prepared.onToolResultDelivered?event=>prepared.onToolResultDelivered({...event,callId:directoryTurnId+':'+event.callId}):undefined,
        // The scoped work checkpoint can continue tools within this phase.
        // The whole-task completion controller still runs after integration.
        onBeforeFinal:phaseOptions.onBeforeFinal,
        onEvent:event=>{
          try{
          // Leaf JSON is private reasoning evidence, not the Chat answer or a resumable coordinator session.
          if(event.type==='usage'){recordUsage(directoryTurnId,event.usage,false,event.at);return;}
          if(event.type==='context'){onEvent?.({type:'directory.context',...contextUsage.context(directoryTurnId,event.context,event.at)});return;}
          if(event.type==='item'&&event.item?.type==='contextCompaction'){
            if(event.stage==='completed')onEvent?.({type:'directory.compaction',...contextUsage.compaction(directoryTurnId,event.item,event.at)});
            return;
          }
          if(['thread','delta','message'].includes(event.type)||event.type==='item'&&['agentMessage','reasoning','exitedReviewMode'].includes(event.item?.type))return;
          const {threadId:ignoredThread,turnId:ignoredTurn,...diagnostic}=event;
          onEvent?.({...diagnostic,directoryTurnId});
          }finally{
            // The phase's saved-source reader needs original measured context
            // and compaction updates even when Chat suppresses private events.
            phaseOptions.onEvent?.(event);
          }
        }});}catch(error){contextUsage.finish(directoryTurnId,options.signal?.aborted?'cancelled':'failed');throw error;}
      recordUsage(directoryTurnId,result?.usage,true);
      if(result?.context)contextUsage.context(directoryTurnId,result.context);
      contextUsage.finish(directoryTurnId,'completed');
      return result;
    }},
  });}catch(error){
    // Keep the measured peak even when earlier progress events are pruned and
    // a saved dependency later fails before another provider call can start.
    try{onEvent?.({type:'directory.context.summary',contextUsage:contextUsage.summary(options.signal?.aborted?'cancelled':'failed')});}catch{}
    throw error;
  }
  // The Directory runner handles unfinished outcomes inside the same run and
  // reuses persisted dependencies; it does not turn a continuation into failure.
  pilot.stats={...pilot.stats,contextUsage:contextUsage.summary('completed')};
  onEvent?.({type:'directory.context.summary',contextUsage:pilot.stats.contextUsage});
  onResult?.(pilot);
  onEvent?.({type:'message',text:pilot.answer,phase:'final_answer',shadowdancer:true});
  return {output:pilot.answer,...(totalUsage?{usage:totalUsage}:{}),effort:options.effort};
}

/** Recover exact user authority from the saved lineage, not the ordinary bounded excerpt. */
export function directoryUserHistoryFor(previous,historyRuns=[]){
 const familyId=previous.taskId||previous.id;
 const family=new Map(historyRuns.filter(run=>run&&(run.taskId||run.id)===familyId).map(run=>[run.id,run]));family.set(previous.id,previous);
 const rows=new Map(),lineage=[],seen=new Set();let cursor=previous;
 while(cursor){
  if(seen.has(cursor.id))throw Object.assign(new Error('Directory history contains a cycle.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
  seen.add(cursor.id);lineage.push(cursor);
  if(Array.isArray(cursor.directoryUserHistory)){
   for(const row of cursor.directoryUserHistory)rows.set(row.key||row.runId,structuredClone(row));break;
  }
  if(!cursor.parentRunId){if(cursor.id!==familyId)throw Object.assign(new Error('The saved conversation descendant is missing its parent link. Restore the complete conversation history before continuing.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});break;}
  cursor=family.get(cursor.parentRunId);
  if(!cursor)throw Object.assign(new Error('A parent run from this conversation is missing. Restore the complete saved conversation history; no user directions were discarded.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});
 }
 const beforeSource=text=>String(text||'').split(/\r?\nSOURCE:\s*\r?\n/i)[0];
 for(const run of lineage.reverse()){
  for(const row of run.priorUserRequests||[])if(row.source==='user-request'&&!row.truncated)rows.set(row.key||row.runId,{...row,text:beforeSource(row.text)});
  rows.set(run.id,{key:run.id,runId:run.id,source:'user-request',at:run.createdAt,messageIndex:-1,text:beforeSource(run.input)});
  for(const [index,event]of (run.events||[]).entries())if(event.data?.type==='steer'&&event.data.accepted===true){
   const key=run.id+':steer:'+(event.at||index)+':'+createHash('sha256').update(event.data.text).digest('hex').slice(0,12);
   rows.set(key,{key,runId:run.id,source:'user-request',at:event.at||run.createdAt,messageIndex:index,text:beforeSource(event.data.text)});
  }
  for(const row of run.priorUserRequests||[])if(row.truncated&&!rows.has(row.key||row.runId))
   throw Object.assign(new Error('An earlier user direction is available only as a truncated excerpt. Restore its complete source in this conversation before continuing.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});
 }
 const result=[...rows.values()].sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0)||(a.messageIndex??-1)-(b.messageIndex??-1));
 // Keep the complete current-conversation authority. The selected provider's
 // actual context capacity applies when a phase is dispatched; Directory does
 // not impose a second character quota or silently discard older directions.
 return result;
}
