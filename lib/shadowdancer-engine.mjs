import {aggregateTokenUsage,tokenUsageMeasurement,TOKEN_USAGE_FIELDS} from '../public/token-usage.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runShadowdancerDirectory} from './shadowdancer-directory.mjs';
import {usesDirectory} from './conversation-execution-modes.mjs';
import {createProviderExecutionContract} from './provider-execution-contract.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code,status:400});
export function assertDirectoryWorkflow(graph,input,mode){
  if(!usesDirectory(input,mode))return;
  const agents=graph?.nodes?.filter(x=>x.type==='agent')||[];
  if(agents.length!==1||graph?.planning?.shared===true||graph?.planning?.mode==='shared'||graph?.planning?.enabled||agents[0]?.assignment||graph?.planning?.coordinatorNodeId)
    throw fail('DIRECTORY_WORKFLOW_UNSUPPORTED','Directory mode requires one independently owned Chat agent. Turn Directory Off for shared or multi-agent workflows.');
}
/** Execute through the ordinary fully prepared host dispatcher, never a second effect path. */
export async function runPreparedDirectoryAgent({runtime,options,input,conversationId,runId,model,getAcceptedDirections,agentInstructions,harnessInstructions,evidenceContext,onProgress,onResult}){
  const {threadId,turnId,continuity,usageBaseline,onEvent,onBeforeFinal,onToolCall,...prepared}=options;
  const requestOnly=value=>String(value||'').split(/\r?\nSOURCE:\s*\r?\n/i)[0];
  const authoritativeContext=()=>{const source=getAcceptedDirections?.()||{},clean=row=>row?{...row,text:requestOnly(row.text)}:null;return JSON.stringify({agentInstructions,hostHarnessInstructions:harnessInstructions,currentUserRequest:clean(source.currentUserRequest),priorUserRequests:(source.priorUserRequests||[]).map(clean),acceptedDirections:(source.acceptedDirections||[]).map(clean)});};
  const usageByTurn=new Map();let totalUsage,lastUsage=null;
  const canonicalUsage=value=>{const row=value&&typeof value==='object'&&!Array.isArray(value)?value:{};const record=TOKEN_USAGE_FIELDS.some(key=>Object.hasOwn(row,key))||Object.hasOwn(row,'samples')?row:(row.total&&typeof row.total==='object'?row.total:row);return aggregateTokenUsage([Object.hasOwn(record,'samples')?record:{...record,samples:1}]);};
  const recordUsage=(id,usage,completed=false)=>{if(!usage||typeof usage!=='object'){if(!completed||usageByTurn.has(id))return;usage=tokenUsageMeasurement({});}const row=canonicalUsage(usage);usageByTurn.set(id,row);lastUsage=usage.last&&typeof usage.last==='object'?canonicalUsage(usage.last):(row.samples===1?structuredClone(row):null);const aggregate=aggregateTokenUsage(usageByTurn.values());totalUsage={...aggregate,total:structuredClone(aggregate),last:lastUsage,modelContextWindow:null};onEvent?.({type:'usage',usage:totalUsage,shadowdancer:true});};
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
  const pilot=await runShadowdancerDirectory({
    input,cwd:options.cwd,conversationId,runId,model,signal:options.signal,canWrite,
    baseTools:prepared.dynamicTools||[],dispatchTool:dispatch,
    createRepositoryHandler:request=>{assertRepository(request.cwd);return dispatch;},executeTestCommand,
    getAuthoritativeContext:authoritativeContext,evidenceContext,
    runtime:{runAgent:async phase=>{
      const {directoryTurnId,...phaseOptions}=phase;
      const tools=phaseOptions.dynamicTools||[];
      const contract=phaseOptions.responseOnly||!prepared.providerExecutionContract?undefined:createProviderExecutionContract({dynamicTools:tools,planningContractVersion:14});
      const result=await runtime.runAgent({...prepared,...phaseOptions,hostOnlyTools:true,model,
        // Each phase gets the same authoritative developer instructions but no provider history.
        developerInstructions:options.developerInstructions,codexHistory:'relay',
        dynamicTools:tools,onToolCall:phaseOptions.onToolCall,
        providerExecutionContract:contract,
        onToolResultDelivered:prepared.onToolResultDelivered?event=>prepared.onToolResultDelivered({...event,callId:directoryTurnId+':'+event.callId}):undefined,
        onBeforeFinal:undefined,
        onEvent:event=>{
          // Leaf JSON is private reasoning evidence, not the Chat answer or a resumable coordinator session.
          if(event.type==='usage'){recordUsage(directoryTurnId,event.usage);return;}
          if(['thread','delta','message','context'].includes(event.type)||event.type==='item'&&['agentMessage','reasoning','exitedReviewMode'].includes(event.item?.type))return;
          const {threadId:ignoredThread,turnId:ignoredTurn,...diagnostic}=event;
          onEvent?.({...diagnostic,directoryTurnId});
        }});
      recordUsage(directoryTurnId,result?.usage,true);
      return result;
    }},onProgress,
  });
  const denial=await onBeforeFinal?.({output:pilot.answer});
  if(denial)throw fail('DIRECTORY_FINAL_BLOCKED','The ordinary Chat completion boundary withheld this answer: '+JSON.stringify(denial).slice(0,1500));
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
  if(!cursor.parentRunId){if(cursor.id!==familyId)throw Object.assign(new Error('Directory cannot restore a detached conversation descendant. Reload the complete conversation or use Directory Off.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});break;}
  cursor=family.get(cursor.parentRunId);
  if(!cursor)throw Object.assign(new Error('Directory needs the complete saved user history. Reload this conversation or use Directory Off; no restrictions were discarded.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});
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
   throw Object.assign(new Error('An earlier user restriction is available only as a truncated excerpt. Reload the complete conversation or use Directory Off.'),{code:'DIRECTORY_HISTORY_UNAVAILABLE',status:409});
 }
 const result=[...rows.values()].sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0)||(a.messageIndex??-1)-(b.messageIndex??-1));
 if(JSON.stringify(result).length>64000)throw Object.assign(new Error('Exact prior user restrictions exceed the bounded Directory context. Use Directory Off; no restrictions were silently summarized.'),{code:'DIRECTORY_AUTHORITATIVE_CONTEXT_LIMIT',status:409});
 return result;
}
