'use strict';
const api = require('./native-api.cjs');
const path = require('node:path');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const ownId = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x);
function parseObject(value) { try { const p=typeof value==='string'?JSON.parse(value):value;return p&&typeof p==='object'&&!Array.isArray(p)?p:null; } catch { return null; } }
// A compatible tool message is the operational JSON plus independent appended
// host-receipt text. Never parse a truncated preview as an operational result.
function firstJson(text) {
  if(typeof text!=='string')return null;
  let i=0;while(/\s/.test(text[i]||'')&&i<text.length)i++;
  if(text[i]!=='{'&&text[i]!=='[')return null;
  const start=i,stack=[];let quoted=false,escaped=false;
  for(;i<text.length;i++){
    const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')stack.push(c);
    else if(c==='}'||c===']'){const opening=stack.pop();if((opening==='{'&&c!=='}')||(opening==='['&&c!==']'))return null;if(!stack.length){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}}
  }return null;
}
function parseTranscript(thread) {
  const issues=[],calls=[],byId=new Map();
  if(!Array.isArray(thread?.transcript))return {calls,issues:['Full native transcript missing'],complete:false};
  for(const [messageIndex,message]of thread.transcript.entries()){
    if(message?.role==='assistant'&&Array.isArray(message.tool_calls))for(const raw of message.tool_calls){
      const id=raw?.id;if(!ownId(id)||byId.has(id)){issues.push('Missing or duplicate provider tool-call ID');continue;}
      const args=parseObject(raw.function?.arguments),call={id,tool:raw.function?.name,arguments:args,argumentsSha256:api.sha(raw.function?.arguments??null),messageIndex,resultMessageIndex:null,resultText:null,result:null,receiptId:null};
      if(typeof call.tool!=='string'||!args)issues.push('Unparseable tool call '+id);
      calls.push(call);byId.set(id,call);
    }
    if(message?.role==='tool'){
      const call=byId.get(message.tool_call_id);
      if(!call||call.resultMessageIndex!==null||typeof message.content!=='string'){issues.push('Unmatched, duplicate or non-text tool result');continue;}
      call.resultMessageIndex=messageIndex;call.resultText=message.content;call.result=firstJson(message.content);
      const receipts=[...message.content.matchAll(/(?:^|\n)DIRECTORY HOST RECEIPT (receipt-[1-9]\d*); current revision (\d+)\./g)];
      if(receipts.length===1){call.receiptId=receipts[0][1];call.receiptRevision=Number(receipts[0][2]);}
      else if(receipts.length>1)issues.push('Multiple appended host receipt IDs for '+call.id);
      if(/This tool was interrupted before its result could be confirmed|application stopped before this tool result was confirmed/.test(message.content))call.interruptedPlaceholder=true;
    }
  }
  for(const call of calls)if(call.resultMessageIndex===null)issues.push('Missing tool result '+call.id);
  if(thread.pendingToolCalls?.length||thread.pendingToolResults?.length)issues.push('Pending provider tool exchange remains');
  return {calls,issues,complete:issues.length===0};
}
function findToolResult(events, callId) {
  return events.filter(e=>e?.data?.type==='tool.result'&&e.data.callId===callId).map(e=>({eventId:e.id||null,at:e.at,success:e.data.success,code:e.data.code||null,status:e.data.status,actionDispatched:typeof e.data.actionDispatched==='boolean'?e.data.actionDispatched:null,hostHandlerEntered:typeof e.data.hostHandlerEntered==='boolean'?e.data.hostHandlerEntered:null}));
}
function callRef(runId, callId) {return api.sha(runId+'\0call\0'+callId).slice(0,24);}
// readLocalFile emits each LF-split line as `${number}: ${line}`, including
// the final empty line of a file ending in LF. This gate is for the frozen LF
// METHOD packet: verify the text delivered in the transcript, not metadata alone.
function numberedLfBody(result){
  if(typeof result?.content!=='string'||result.content.includes('\r'))return {sequential:false,lineCount:0,bytes:null,sha256:null};
  const lines=result.content.split('\n'),sequential=lines.every((line,i)=>line.startsWith((i+1)+': '));
  if(!sequential)return {sequential:false,lineCount:lines.length,bytes:null,sha256:null};
  const body=lines.map((line,i)=>line.slice(String(i+1).length+2)).join('\n');
  return {sequential:true,lineCount:lines.length,bytes:Buffer.byteLength(body,'utf8'),sha256:api.sha(body)};
}
function fileMethodDelivery(config,calls,runId){
  const expected=api.windowsPath(path.win32.resolve(config.workspace,config.method.path));
  const resolve=value=>typeof value==='string'&&value.length>0?api.windowsPath(path.win32.resolve(config.workspace,value)):null;
  const effectful=call=>call.tool==='relay_directory_action'&&call.arguments?.action!=='read'||call.tool==='relay_workspace'&&['write','patch','undo_patch','run'].includes(call.arguments?.action);
  const firstEffect=calls.filter(effectful).reduce((min,c)=>Math.min(min,c.messageIndex),Infinity);
  const reads=calls.filter(c=>c.tool==='relay_workspace'&&c.arguments?.action==='read').map(c=>{
    const r=c.result,receipt=c.receipt,body=numberedLfBody(r);
    const checks={
      exactPath:resolve(c.arguments.path)===expected&&resolve(r?.path)===expected,
      successful:c.success===true&&!c.interruptedPlaceholder,
      linkedReceipt:typeof c.receiptId==='string'&&receipt?.id===c.receiptId&&receipt.runId===runId&&receipt.nodeId==='agent'&&receipt.tool==='relay_workspace'&&receipt.state==='returned'&&receipt.success===true,
      expectedHash:r?.sha256===config.method.sha256,
      completeFile:r?.startLine===1&&Number.isSafeInteger(r?.totalLines)&&r.totalLines>0&&r.endLine===r.totalLines&&r.truncated===false&&r.nextStartLine===null&&typeof r.content==='string'&&r.content.length>0,
      deliveredBodySequential:body.sequential,
      deliveredBodyLineCount:body.lineCount===r?.totalLines,
      deliveredBodySize:Number.isSafeInteger(r?.size)&&r.size>0&&body.bytes===r.size,
      deliveredBodyHash:body.sha256===config.method.sha256,
      beforeEffects:Number.isSafeInteger(c.messageIndex)&&Number.isSafeInteger(c.resultMessageIndex)&&c.resultMessageIndex>c.messageIndex&&c.resultMessageIndex<firstEffect
    };
    return {callId:c.id,receiptId:c.receiptId,messageIndex:c.messageIndex,resultMessageIndex:c.resultMessageIndex,deliveredBody:{sha256:body.sha256,bytes:body.bytes,lineCount:body.lineCount},checks,proven:Object.values(checks).every(Boolean)};
  });
  const accepted=reads.find(x=>x.proven);
  return {proven:!!accepted,deliveryMode:'file-read',mechanism:'complete-successful-method-read-in-owned-provider-transcript',path:config.method.path,sha256:config.method.sha256,firstEffectMessageIndex:Number.isFinite(firstEffect)?firstEffect:null,acceptedCallId:accepted?.callId||null,acceptedReceiptId:accepted?.receiptId||null,reads};
}
function completeMachineCoverage(coverage) {
  return coverage?.source==='maximal-host-envelopes'&&coverage.dropped===0&&coverage.entryMetadataOmitted===0&&Array.isArray(coverage.gaps)&&coverage.gaps.length===0;
}
function receiptPageIssues(result,view,runId,taskId) {
  if(result?.complete!==true||!Array.isArray(result.pages)||!result.pages.length)return ['complete page inventory missing'];
  const issues=[],revision=result.pages[0]?.revision;
  if(typeof revision!=='string'||!revision.trim())issues.push('revision missing');
  let expectedOffset=0;
  for(const [index,page]of result.pages.entries()){
    if(page?.runId!==runId||page?.taskId!==taskId||page?.view!==view)issues.push('page '+index+' identity mismatch');
    if(page?.revision!==revision)issues.push('page '+index+' revision changed');
    if(!integer(page?.offset)||page.offset!==expectedOffset)issues.push('page '+index+' cursor mismatch');
    if(index===result.pages.length-1){
      if(page?.nextOffset!==null)issues.push('final cursor is not exhausted');
    }else{
      if(!integer(page?.nextOffset)||page.nextOffset<=page.offset)issues.push('page '+index+' cursor did not advance');
      expectedOffset=page?.nextOffset;
    }
  }
  return issues;
}
// New native validation/boundary refusals carry trusted handler-entry metadata.
// A model-written JSON flag alone is never proof; both host views must agree.
const REFUSAL_CODES=new Set(["BENCHMARK_ACTION","BENCHMARK_ARGUMENTS","BENCHMARK_CHANGED","BENCHMARK_COMMAND","BENCHMARK_CONFLICT","BENCHMARK_DIRECTORY_UNAVAILABLE","BENCHMARK_ENTRY","BENCHMARK_ERROR","BENCHMARK_INITIAL_SOURCE_CHANGED","BENCHMARK_INTEGRITY","BENCHMARK_LINK","BENCHMARK_NODE_UNAVAILABLE","BENCHMARK_PATCH_MATCH","BENCHMARK_PATH","BENCHMARK_PROFILE_INVALID","BENCHMARK_PUBLIC_REPORT_INVALID","BENCHMARK_READ_LINE_TOO_LONG","BENCHMARK_READ_RANGE","BENCHMARK_RECEIPT_CHANGED","BENCHMARK_RECEIPT_INVALID","BENCHMARK_RECEIPT_SCOPE","BENCHMARK_RESUME_UNSUPPORTED","BENCHMARK_RUN_SHAPE","BENCHMARK_SCAFFOLD_CHANGED","BENCHMARK_SCAFFOLD_INVALID","BENCHMARK_SCOPE","BENCHMARK_SIZE","BENCHMARK_SOURCE_CHANGED","BENCHMARK_TOOL_UNAVAILABLE","BENCHMARK_UTF8","BENCHMARK_WORKSPACE_MISMATCH","BENCHMARK_WRITE_READBACK","NATIVE_AGENT_ACTION_INVALID","TOOL_ACTION_INVALID","TOOL_ARGUMENTS_INVALID"]);
function explicitNoDispatchProof(call,runId,events,machineEntries,coverage){
 if(call.success!==false||call.interruptedPlaceholder||call.receiptId||call.receipt||!completeMachineCoverage(coverage))return null;
 const ref=callRef(runId,call.id),raw=events.filter(e=>e.runId===runId&&e.nodeId==='agent'&&e.data?.callId===call.id),machine=machineEntries.filter(e=>e.callRef===ref);
 if(raw.some(e=>e.data.type==='directory.effect'&&e.data.phase==='dispatch'||e.data.actionDispatched===true)||machine.some(e=>e.kind==='directory.effect'&&e.metadata?.phase==='dispatch'||e.metadata?.actionDispatched===true))return null;
 const rawReturns=raw.filter(e=>e.data.type==='tool.result'),machineReturns=machine.filter(e=>e.kind==='tool.result');
 if(rawReturns.length!==1||machineReturns.length!==1)return null;
 const host=rawReturns[0],projected=machineReturns[0],a=host.data,b=projected.metadata;
 if(a.success!==false||b?.success!==false||a.tool!==call.tool||b.tool!==call.tool||!REFUSAL_CODES.has(a.code)||b.code!==a.code||a.actionDispatched!==false||b.actionDispatched!==false||typeof a.hostHandlerEntered!=='boolean'||b.hostHandlerEntered!==a.hostHandlerEntered||!Number.isSafeInteger(projected.sequence))return null;
 if(call.result?.code!==a.code||call.result?.actionDispatched!==false)return null;
 return {reason:'explicit-native-validation-rejection',code:a.code,hostHandlerEntered:a.hostHandlerEntered,rawReturnTimelineOrder:host.timelineOrder??null,machineReturnSequence:projected.sequence,machineCallRef:ref,dispatchObserved:false,completeMaximalTrace:true};
}
function directoryGateRejectionProof(call,runId,events,machineEntries,coverage){
  if(call.tool!=='relay_workspace'||typeof call.arguments?.action!=='string'||call.success!==false||call.interruptedPlaceholder||call.receiptId||call.receipt)return null;
  if(!completeMachineCoverage(coverage))return null;
  const ref=callRef(runId,call.id),raw=events.filter(e=>e.runId===runId&&e.nodeId==='agent'&&e.data?.callId===call.id),machine=machineEntries.filter(e=>e.callRef===ref);
  if(raw.some(e=>e.data.type==='directory.effect'&&e.data.phase==='dispatch')||machine.some(e=>e.kind==='directory.effect'&&e.metadata?.phase==='dispatch'))return null;
  if(raw.some(e=>e.data.type==='tool.result'&&(e.data.actionDispatched===true||e.data.hostHandlerEntered===false))||machine.some(e=>e.kind==='tool.result'&&(e.metadata?.actionDispatched===true||e.metadata?.hostHandlerEntered===false)))return null;
  const gate=x=>x?.phase==='gate'&&x.decision==='reject'&&x.tool==='relay_workspace'&&x.operation===call.arguments.action&&x.code==='DIRECTORY_FOCUS';
  const failed=x=>x?.tool==='relay_workspace'&&x.action===call.arguments.action&&x.code==='DIRECTORY_FOCUS'&&x.success===false;
  const rawGate=raw.find(e=>e.data.type==='directory.effect'&&gate(e.data)),rawReturn=raw.find(e=>e.data.type==='tool.result'&&failed(e.data));
  const machineGate=machine.find(e=>e.kind==='directory.effect'&&gate(e.metadata)),machineReturn=machine.find(e=>e.kind==='tool.result'&&failed(e.metadata));
  if(!rawGate||!rawReturn||!machineGate||!machineReturn||raw.indexOf(rawGate)>=raw.indexOf(rawReturn)||!Number.isSafeInteger(machineGate.sequence)||!Number.isSafeInteger(machineReturn.sequence)||machineGate.sequence>=machineReturn.sequence)return null;
  return {reason:'host-directory-gate-rejection',code:'DIRECTORY_FOCUS',hostHandlerEntered:true,rawGateTimelineOrder:rawGate.timelineOrder??null,rawReturnTimelineOrder:rawReturn.timelineOrder??null,machineGateSequence:machineGate.sequence,machineReturnSequence:machineReturn.sequence,machineCallRef:ref,dispatchObserved:false,completeMaximalTrace:true};
}
function projectEvidence({config,bundle,providerThread,provenance=[]}) {
  api.validate(config);const issues=[],run=bundle?.run,ledger=bundle?.ledger,machine=bundle?.machine;
  try{api.assertOwned(run,config);}catch(e){issues.push(e.message);}
  const runId=run?.id,taskId=run?.taskId,nativeTerminal=api.terminal(run?.status),runSettled=run?.settled===true;
  if(!nativeTerminal||!runSettled)issues.push('Native run is not terminal and settled');
  if(ledger?.runId!==runId||ledger?.taskId!==taskId||ledger?.state?.taskId!==taskId||!Array.isArray(ledger?.state?.receipts)||!Array.isArray(ledger?.state?.actions))issues.push('Task-scoped ledger identity/shape invalid');
  if(machine?.runId!==runId||machine?.taskId!==taskId||machine?.audience!=='machine'||machine?.coverage?.source!=='maximal-host-envelopes'||!Array.isArray(machine?.entries))issues.push('Maximal machine trace identity/availability invalid');
  if(!completeMachineCoverage(machine?.coverage))issues.push('Complete maximal machine trace coverage missing: dropped, omitted or gapped evidence');
  if(providerThread?.id!==run?.nodes?.agent?.threadId||bundle?.providerThreadId!==providerThread?.id||providerThread?.version!==1||providerThread?.providerType!=='compatible'||!Array.isArray(providerThread?.messages)||api.windowsPath(providerThread?.cwd||'')!==api.windowsPath(config.workspace)||`${providerThread?.providerId}::${providerThread?.model}`!==config.model||providerThread?.hostOnlyTools!==true)issues.push('Owned provider transcript identity/protocol invalid');
  const parsed=parseTranscript(providerThread);
  // A complete host rejection can account for an opaque model argument record.
  // Keep its exact source hash; never parse-repair it into an action or command.
  const opaqueArgumentIssues=new Map(parsed.calls.filter(c=>c.arguments===null&&typeof c.tool==='string'&&c.tool.length>0).map(c=>[c.id,'Unparseable tool call '+c.id]));
  issues.push(...parsed.issues.filter(issue=>![...opaqueArgumentIssues.values()].includes(issue)));
  const transcript=Array.isArray(providerThread?.transcript)?providerThread.transcript:[],firstAssistant=transcript.findIndex(x=>x?.role==='assistant');
  const userMessages=transcript.filter((x,i)=>x?.role==='user'&&typeof x.content==='string'&&(firstAssistant<0||i<firstAssistant));
  const submittedTask=config.task.trim(),taskDelivery={proven:run?.input===submittedTask&&userMessages.some(x=>x.content.includes(submittedTask)),mechanism:'exact-native-input-in-provider-user-message',authoredSha256:api.sha(config.task),effectiveSha256:api.sha(submittedTask)};
  if(!taskDelivery.proven)issues.push('Submitted task delivery to provider is unproven');
  const events=Array.isArray(run?.events)?run.events:[],receipts=ledger?.state?.receipts||[],actions=ledger?.state?.actions||[],byReceipt=new Map(receipts.map(x=>[x.id,x]));
  if(new Set(receipts.map(x=>x.id)).size!==receipts.length)issues.push('Duplicate Directory receipt IDs');
  const relevantNodes=Object.entries(run?.nodes||{}).filter(([,n])=>n?.directoryContext);
  let activeCount=0,countersKnown=relevantNodes.length===1,hostReceived=0;
  for(const [id,node]of relevantNodes){const c=node.directoryContext,h=c.hostTools;if(c.runId!==runId||c.taskId!==taskId||c.nodeId!==id||!h||![h.received,h.returned,h.threw].every(integer)||h.returned+h.threw>h.received){countersKnown=false;continue;}activeCount+=h.received-h.returned-h.threw;hostReceived+=h.received;}
  if(!countersKnown){activeCount=null;issues.push('Host handler settlement counters missing or inconsistent');}
  else if(activeCount!==0)issues.push('Host tool handlers remain in flight');
  const machineEntries=Array.isArray(machine?.entries)?machine.entries:[];
  const failures=[],commands=[],unexecutedCommandAttempts=[],calls=[];const linkedReceipts=new Set(),unexpectedWork=[];
  for(const call of parsed.calls){
    const rawEvents=findToolResult(events,call.id),ref=callRef(runId,call.id);
    const machineReturns=machineEntries.filter(e=>e.callRef===ref&&e.kind==='tool.result');
    const successes=[...rawEvents.map(x=>x.success),...machineReturns.map(x=>x.metadata?.success)].filter(x=>typeof x==='boolean');
    const success=successes.length&&successes.every(x=>x===successes[0])?successes[0]:null;
    if(successes.some(x=>x!==successes[0]))issues.push('Contradictory tool-return status '+call.id);
    // The persisted transcript retains payloads; success is independently host-reported.
    const receipt=call.receiptId?byReceipt.get(call.receiptId):null;
    if(receipt){linkedReceipts.add(receipt.id);if(receipt.runId!==runId||receipt.nodeId!=='agent'||receipt.tool!==call.tool||receipt.state!=='returned'||success!==null&&receipt.success!==success)issues.push('Directory receipt binding/status mismatch '+receipt.id);}
    else if(call.receiptId)issues.push('Unknown linked Directory receipt '+call.receiptId);
    const resolvedSuccess=success===null&&receipt&&typeof receipt.success==='boolean'?receipt.success:success;
    // providers.executeTool throws TOOL_UNAVAILABLE before state.onToolCall.
    // It is a model selection failure with no host handler, not unseen work.
    const observedCatalog=run?.nodes?.agent?.toolNames;
    const dispatchSeen=events.some(e=>e.runId===runId&&e.nodeId==='agent'&&e.data?.callId===call.id&&e.data.type==='directory.effect'&&e.data.phase==='dispatch')||machineEntries.some(e=>e.callRef===ref&&e.kind==='directory.effect'&&e.metadata?.phase==='dispatch');
    const unavailable=resolvedSuccess===false&&!receipt&&Array.isArray(observedCatalog)&&!observedCatalog.includes(call.tool)&&[...rawEvents.map(x=>x.code),...machineReturns.map(x=>x.metadata?.code)].includes('TOOL_UNAVAILABLE');
    const knownNoDispatch=unavailable&&!dispatchSeen;
    if(unavailable&&dispatchSeen)issues.push('Dispatch contradicts unavailable-tool result '+call.id);
    const out={...call,success:resolvedSuccess,knownNoDispatch,receipt:receipt||null,resultTextSha256:call.resultText===null?null:api.sha(call.resultText),hostResultEvents:rawEvents,machineCallRef:ref};
    out.noDispatchProof=explicitNoDispatchProof(out,runId,events,machineEntries,machine?.coverage)||directoryGateRejectionProof(out,runId,events,machineEntries,machine?.coverage);
    out.knownNoDispatch=knownNoDispatch||!!out.noDispatchProof;
    out.hostHandlerEntered=out.noDispatchProof?.hostHandlerEntered??(knownNoDispatch?false:null);
    const explicitClaim=resolvedSuccess===false&&!receipt&&(call.result?.actionDispatched===false||rawEvents.some(e=>e.actionDispatched===false)||machineReturns.some(e=>e.metadata?.actionDispatched===false));
    if(explicitClaim&&!out.knownNoDispatch)issues.push('Explicit no-dispatch claim lacks complete corroborating host proof '+call.id);
    out.argumentInterpretation=call.arguments!==null?'object':out.noDispatchProof?.reason==='explicit-native-validation-rejection'?'opaque-host-rejected':'unresolved';
    if(opaqueArgumentIssues.has(call.id)&&out.argumentInterpretation!=='opaque-host-rejected')issues.push(opaqueArgumentIssues.get(call.id));
    calls.push(out);
    if(resolvedSuccess===null&&!call.interruptedPlaceholder)issues.push('Host result status unavailable '+call.id);
    if(resolvedSuccess===false||call.interruptedPlaceholder)failures.push({callId:call.id,tool:call.tool,action:call.arguments?.action||null,receiptId:call.receiptId,code:rawEvents.find(x=>x.code)?.code||call.result?.code||null,...(out.argumentInterpretation==='opaque-host-rejected'?{opaqueArguments:true,argumentsSha256:out.argumentsSha256}:{}),interruptedPlaceholder:!!call.interruptedPlaceholder,resultTextSha256:out.resultTextSha256});
    if(call.tool==='relay_workspace'&&call.arguments?.action==='run'){
      const rejection=out.noDispatchProof;
      if(rejection){
        const attempt={kind:'unexecuted-command-attempt',requestedKind:call.arguments.command==='node test-public.cjs'?'public-smoke':'other',callId:call.id,receiptId:call.receiptId,command:call.arguments.command,requestedCwd:call.arguments.cwd??config.workspace,executed:false,success:false,exitCode:null,timedOut:null,report:null,resultTextSha256:out.resultTextSha256,proof:rejection};
        unexecutedCommandAttempts.push(attempt);out.commandDispatch={executed:false,proof:rejection};
      }else{
      const value=call.result,command={kind:call.arguments.command==='node test-public.cjs'?'public-smoke':'other',callId:call.id,receiptId:call.receiptId,command:call.arguments.command,cwd:value?.cwd||null,exitCode:Number.isInteger(value?.exitCode)?value.exitCode:null,timedOut:typeof value?.timedOut==='boolean'?value.timedOut:null,signal:value?.signal??null,durationMs:value?.durationMs??null,truncated:value?.truncated===true,success:resolvedSuccess,stdoutSha256:typeof value?.stdout==='string'?api.sha(value.stdout):null,stderrSha256:typeof value?.stderr==='string'?api.sha(value.stderr):null,report:null};
      if(command.kind==='public-smoke'&&typeof value?.stdout==='string'){try{const report=JSON.parse(value.stdout.trim());if(report?.schema==='blackice.minicpm.public-smoke.v1')command.report=report;}catch{}}
      if(!receipt||receipt.state!=='returned'||command.exitCode===null||command.timedOut===null||typeof value?.cwd!=='string'||value.command!==call.arguments.command||typeof value.stdout!=='string'||typeof value.stderr!=='string')issues.push('Full command receipt missing/unmatched '+call.id);
      if(!config.allowedCommands.includes(call.arguments.command))unexpectedWork.push({callId:call.id,kind:'unexpected-command',command:call.arguments.command,requires:'Independent owned-process/effect reconciliation; no inferred settlement'});
      commands.push(command);
      }
    }
    if(!out.knownNoDispatch&&['relay_delegate','relay_agents','relay_goal','relay_goals','relay_control'].includes(call.tool)&&!['read','get','list','status','search'].includes(call.arguments?.action))unexpectedWork.push({callId:call.id,kind:'possible-descendant-or-background-work',tool:call.tool,action:call.arguments?.action||null});
    if(call.interruptedPlaceholder&&(dispatchSeen||receipt?.state==='unknown'||!completeMachineCoverage(machine?.coverage)))issues.push('Interrupted operation absence/settlement unproven '+call.id);
  }
  const methodDelivery=(config.method.deliveryMode||'inline')==='file-read'?fileMethodDelivery(config,calls,runId):{proven:userMessages.some(x=>x.content.includes(config.method.text)),deliveryMode:'inline',mechanism:'exact-inline-method-packet-in-provider-user-message',sha256:config.method.sha256};
  if(!methodDelivery.proven)issues.push('Exact method packet delivery to provider is unproven');
  const completedHostCalls=calls.filter(c=>c.tool!=='relay_directory_action'&&!c.interruptedPlaceholder&&c.hostHandlerEntered!==false).length;
  if(countersKnown&&hostReceived!==completedHostCalls)issues.push('Native host handler count does not reconcile with full provider tool exchanges');
  for(const entry of machineEntries)if(entry.kind==='subagent.started')unexpectedWork.push({kind:'native-subagent-started',sequence:entry.sequence,callRef:entry.callRef||null,requires:'Independent descendant settlement evidence'});
  for(const r of receipts)if(!linkedReceipts.has(r.id))issues.push('Ledger receipt has no full transcript return '+r.id);
  const unknown=receipts.filter(r=>r.state==='unknown'&&r.observationOnly!==true&&r.actionDispatched!==false);
  const finalUnknown=Array.isArray(ledger?.final?.unknown)?ledger.final.unknown:null;
  if(finalUnknown===null)issues.push('Directory final unknown-effect inventory missing');
  else if(finalUnknown.length||unknown.length)issues.push('Unknown Directory effects remain');
  const pendingWrites=unknown.filter(r=>r.tool==='relay_workspace');
  if(unexpectedWork.length)issues.push('Unexpected command/descendant work requires separate reconciliation');
  for(const view of ['context','tools','decisions']){
    const pageIssues=receiptPageIssues(bundle?.receiptPages?.[view],view,runId,taskId);if(pageIssues.length)issues.push('Native receipt pages incomplete or mismatched: '+view+' ('+pageIssues.join('; ')+')');
  }
  const finalMessagePresent=events.some(e=>e?.data?.type==='message'&&e.data.phase==='final_answer'&&typeof e.data.text==='string'&&e.data.text.trim().length>0);
  const directoryComplete=ledger?.final?.ready===true&&ledger?.final?.reason==='ready'&&actions.length>0&&actions.every(a=>a.state==='observed');
  const dataValid=issues.length===0;
  const receipt={schema:'blackice.minicpm.agentic-execution-receipt.v1',caseId:config.caseId,workspace:config.workspace,
    run:{id:runId||null,taskId:taskId||null,status:run?.status||null,terminal:nativeTerminal,settled:runSettled},
    actions:{settled:dataValid&&runSettled&&activeCount===0,activeCount,pendingWriteCount:finalUnknown===null?null:pendingWrites.length,commands,unexecutedCommandAttempts,failures,ledgerActiveCount:actions.filter(a=>a.state==='active').length,ledgerPendingCount:actions.filter(a=>a.state==='pending').length,unknownEffectCount:unknown.length,unexpectedWork},
    completion:{agentCompleted:dataValid&&run?.status==='completed'&&finalMessagePresent&&directoryComplete,finalMessagePresent,directoryComplete,directoryFinal:ledger?.final||null},
    evidence:{provenance,providerThreadId:providerThread?.id||null,taskDelivery,methodDelivery,hostReceived,providerToolCalls:parsed.calls.length,ordinaryOmittedEvents:run?.eventRetention?.omittedEvents??null,machineCoverage:machine?.coverage||null,toolTimelineComplete:dataValid,modelIdentityScope:'Explicit native workflow/provider route only; GGUF path/hash and effective inference/context require separate frozen runtime evidence.',limitations:['Native machine trace omits all payloads; exact owned provider transcript supplies full tool calls/results.','Logical Directory active/pending steps are not in-flight host handlers.','Model outcome claims do not independently verify task correctness.','Only frozen allowed commands can use this automatic settlement gate; unexpected command/descendant work requires explicit reconciliation.']}};
  return {validation:{valid:dataValid,issues},receipt,directoryProof:{schema:'blackice.minicpm.directory-evidence.v1',caseId:config.caseId,workspace:config.workspace,runId,taskId,source:'native-provider-transcript-plus-host-ledger',calls:calls.map(({resultText,...x})=>x),ledger,coverage:receipt.evidence}};
}
module.exports={firstJson,parseTranscript,projectEvidence,callRef,fileMethodDelivery};
