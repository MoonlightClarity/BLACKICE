import { createHash } from 'node:crypto';
import {browserBindingReasons,browserBindingNumbers,browserBindingFlags,projectBrowserControlBinding} from './browser-reference-diagnostic.mjs';

export const TURN_MACHINE_TRACE_LIMITS=Object.freeze({ headEntries:3072, tailEntries:9216, entryBytes:1024 });
const VERSION=1;
const list=value=>new Set(value.split(' '));
const envelopeKinds=list('agent.event run.updated node.updated run.created task.updated task.deleted workflows.updated directory.mutation directory.snapshot');
const eventKinds=list('provider.final host.final-review delta item thread turn message steer usage context compaction context.compacted capabilities capability plan planning.module planning.browser.updated planning.continuation chat.execution-review planning.reassessment coordination.resumed coordination.stalled coordination.stopped coordination.waiting task.state task.state.error task.artifacts task.execution tool.result workspace.action workspace.search.coverage workspace.patch browser.action browser.observation browser.reference browser.signin browser.credential browser.scope.cleanup_error browser.scope.released native.write.uncertain execution.contract execution.settings skill_loaded skill_context_submitted subagent.admission subagent.started subagent.completed direction.delivery error diff inquiry.operation inquiry.attachment direct.task.context direct.task.contract.updated directory.mutation directory.snapshot directory.receipt directory.effect directory.final operation.receipt operation.effect effect.result effect.attempt effect.settled');
const itemKinds=list('agentMessage reasoning dynamicToolCall commandExecution fileChange mcpToolCall imageGeneration webSearch browserUse computerUse collabToolCall plan exitedReviewMode enteredReviewMode contextCompaction userMessage');
const statuses=list('queued running waiting accepted pending active observed blocked started completed failed cancelled interrupted paused succeeded settled unknown returned returned-success returned-error in_progress inProgress superseded skipped rejected done error');
const phases=list('started completed failed cancelled needs-evidence not-needed applied rejected bound issued delivered retained lost observed required final_answer commentary before_effect after_effect gate reserved dispatch returned threw before-final after-provider continue-after-checked-block continue-after-reported-incomplete');
const actionKinds=list('read list search run get start plan planningChoice focus note observe block replan revise replace reconcile resolve audit clear pause resume cancel stop register update open close navigate snapshot wait inspect screenshot click fill select scroll type press set write edit rename move delete archive send dispatch verify capture continue retry complete result take moveTab focusTab readText writeFile prepare request bind');
const toolKinds=list('relay_workspace relay_find_files relay_files relay_browser relay_browser_signin relay_browser_credentials relay_goals relay_goal relay_history relay_agents relay_skills relay_task relay_directory_action relay_planning_read relay_planning_write relay_planning_module relay_delegate relay_effect relay_effects relay_operations relay_control relay_windows relay_desktop relay_apps relay_project relay_prompts relay_identity relay_visual relay_attachments relay_email shell commandExecution mcpToolCall fileChange webSearch');
const modules=list('builtin-decomposition builtin-task-grounding builtin-structured-analysis builtin-intent-inference');
const artifacts=list('pending-actions grounded-choice revised-choice intent-advice');
const causes=list('ABORT_ERR GOAL_DEADLINE_REACHED DIRECTORY_CHANGED DIRECTORY_SCOPE DIRECTORY_ACTION DIRECTORY_FOCUS DIRECTORY_UNKNOWN DIRECTORY_CAPACITY DIRECTORY_ACTION_CLOSED DIRECTORY_NOT_READY DIRECTORY_DEPENDENCY DIRECTORY_BLOCKER DIRECTORY_RECORDED_ACTION DIRECTORY_PLAN_REPAIR_REQUIRED DIRECTORY_EVIDENCE DIRECTORY_ACTION_UNFINISHED DIRECTORY_ACTION_TOOLS_REQUIRED DIRECTORY_SNAPSHOT_REQUIRED DIRECTORY_SNAPSHOT_STALE DIRECTORY_SNAPSHOT_UNDELIVERED DIRECTORY_REVISION_REQUIRED DIRECTORY_REVISION_INVALID DIRECTORY_REVISION_STALE DIRECTORY_REVISION_MISSING DIRECTORY_READ_REQUIRED DIRECTORY_SUPPLIED_REVISION_INVALID DIRECTORY_DELIVERED_REVISION_REQUIRED PLANNING_CYCLE_RETIRED PLANNING_ATTEMPT_FAILED PLANNING_CANCELLED PLANNING_ARTIFACT_INVALID PLANNING_ACTION_NOT_PENDING PLANNING_SCOPE_CHANGED PLANNING_PROVIDER_INVALID BROWSER_INPUT_DOCUMENT_CHANGED BROWSER_REF_STALE DIRECTORY_OBSERVATION BROWSER_UNAVAILABLE TOOL_UNAVAILABLE TOOL_NOT_FOUND TOOL_ACTION_INVALID INVALID_ARGUMENTS NETWORK_ERROR HTTP_ERROR PROVIDER_ERROR PROVIDER_IDLE_TIMEOUT TASK_CONTRACT_FRESH_SESSION_REQUIRED HOST_ONLY_TRANSPORT_UNSUPPORTED');
const reasonKinds=list('missing invalid stale not-delivered wrong-scope excluded unknown revision-mismatch missing-revision invalid-revision stale-revision snapshot-required snapshot-not-delivered matching-snapshot cancelled deadline unsupported malformed absent valid missing-revision-number live-revision-changed requested-revision-mismatch never-delivered outdated-bound action-snapshot-changed mutation-rejected host-snapshot-binding ready replan-required no-actions unknown-effects pending-actions blocked-paths plan-repair-required explicit-action-left-unfinished');
const revisionTypes=list('missing undefined null number integer string boolean array object bigint symbol function invalid NaN non-finite');
const providers=list('codex mistral-vibe openai compatible anthropic openrouter together custom native api');
const modelFamilies=list('luna sol astra terra GPT Claude Gemini Qwen Llama Gemma DeepSeek Mistral Nemotron GPT-6-Luna GPT-6-Sol');
const profiles=list('host-only-task-tools planning-response blackice-tools');
const contextSources=list('current-request retry-of-saved-request goal-dispatch autonomy-dispatch fresh resumed-opaque none saved-messages automatic-compaction');
const effortKinds=list('none minimal low medium high xhigh max ultra default');
const modeKinds=list('off on basic detailed maximal');
const counts=[...browserBindingNumbers,'revision','actionRevision','gateRevision','gateActionRevision','reservationRevision','actionCount','pendingCount','blockedCount','dependencyBlockedCount','unmetDependencyCount','readyActionCount','linkedReadCount','unknownCount','returnCount','snapshotRevision','submittedRevision','boundActionRevision','comparisonRevision','comparisonActionRevision','resultRevision','resultActionRevision','boundRevision','deliveredRevision','issuedRevision','liveRevision','acceptedRevision','requestedRevision','expectedRevision','availableRevision','suppliedRevision','epoch','generation','operationCount','total','count','inputTokens','outputTokens','reasoningTokens','reasoningOutputTokens','cachedInputTokens','totalTokens','durationMs','elapsedMs','retainedChars','sourceChars','omittedChars','modelContextWindow','windowTokens','effectiveWindowTokens','estimatedInputTokens','maxOutputTokens','inputBudgetTokens','selectedCount','received','returned','threw','attachedTools','inputImageCount','exitCode','originalBytes','remainingSteps'];
const flags=[...browserBindingFlags,'ready','requiresReplan','dispatchStarted','actionDispatched','revisionPresent','success','settled','truncated','resumed','available','sandboxed','accepted','verified','included','identityIncluded','ambientTools','ambientGmail','native','readOnly','networkAccess','reviewConfigured','incomplete'];
const allowedEnums={providerTermination:list('completed incomplete interrupted failed stop length content_filter function_call tool_calls end_turn max_tokens stop_sequence tool_use pause_turn refusal max_turn_requests cancelled'),terminationField:list('response-status stop-reason finish-reason turn-status'),reviewMode:list('none directory task-contract planning execution-outline ordinary-chat'),reviewDecision:list('not-configured accepted continue rejected superseded'),bindingReason:new Set(browserBindingReasons),type:eventKinds,status:statuses,phase:phases,stage:phases,action:actionKinds,operation:actionKinds,actionState:list('pending active observed blocked'),op:actionKinds,tool:toolKinds,callClass:list('observation effect'),decision:list('allow reject'),moduleId:modules,artifact:artifacts,code:causes,reason:reasonKinds,reasonCode:reasonKinds,suppliedRevisionType:revisionTypes,revisionType:revisionTypes,providerType:providers,provider:providers,modelFamily:modelFamilies,profile:profiles,requestSource:contextSources,providerSession:contextSources,method:contextSources,effort:effortKinds,serviceTier:list('default fast'),pastChats:modeKinds,directoryDiagnostics:modeKinds,chatPlanning:modeKinds,directoryActions:modeKinds};
const safeObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const counter=value=>Number.isSafeInteger(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:undefined;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:undefined;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)?value:undefined;
const reference=(runId,kind,value)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(value)
  ? createHash('sha256').update(runId+'\0'+kind+'\0'+value).digest('hex').slice(0,24):undefined;
export const turnMachineCallRef=(runId, callId)=>reference(runId,'call',callId);
const validRef=value=>typeof value==='string'&&/^[a-f0-9]{24}$/.test(value)?value:undefined;
const numFields=(out,input)=>{for(const key of counts){const val=counter(input?.[key]);if(val!==undefined)out[key]=val;}};
const enumFields=(out,input)=>{for(const [key,values] of Object.entries(allowedEnums)){const val=input?.[key];if(values.has(val))out[key]=val;}};
const boolFields=(out,input)=>{for(const key of flags){const val=input?.[key];if(typeof val==='boolean')out[key]=val;}};
function metadata(out,input){numFields(out,input);enumFields(out,input);boolFields(out,input);return out;}
function searchCoverage(out, data) {
  const dimensions = {
    searchScope: ['explicit-file','explicit-folder','explicit-working-folder','working-folder'],
    searchBackend: ['filesystem','rg'],
    searchRoute: ['rg-unavailable','rg']
  };
  for (const [key, allowed] of Object.entries(dimensions))
    if (allowed.includes(data?.[key])) out[key] = data[key];
  for (const key of ['matchLimit','returnedMatches','scannedFiles','skippedFiles','perFileByteLimit','searchTimeoutMs','searchCaptureChars','searchScanByteLimit']) {
    if (key === 'returnedMatches' && (data?.resultPreviewOnly === true || data?.timedOut === true)) continue;
    const value = counter(data?.[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['timedOut','caseSensitive','resultPreviewOnly']) if (typeof data?.[key] === 'boolean') out[key] = data[key];
}
const browserObservationActions=list('open navigate back forward reload read snapshot wait click hover fill type select press scroll upload interaction');
function browserObservationMetadata(data) {
  const out={tool:'relay_browser',phase:'returned'};
  if(browserObservationActions.has(data?.action))out.action=data.action;
  for(const [key,max] of Object.entries({frameCount:30,contentFrameCount:30,emptyFrameCount:30,unknownFrameCount:30,frameErrorCount:31,enabledControlCount:400,disabledControlCount:400,unknownControlCount:400})){
    const value=counter(data?.[key]);if(value!==undefined&&value<=max)out[key]=value;
  }
  return out;
}
const knownModel=value=>typeof value==='string'&&/^(?:gpt-(?:4(?:\.1|o)?|5(?:\.[1-6])?|6(?:\.[12])?)(?:-(?:mini|nano|codex|luna|sol|astra|terra))?|o[134](?:-mini)?|mistral-vibe)$/.test(value)?value:undefined;
const restoredModel=value=>knownModel(value);
const code=value=>causes.has(value)?value:undefined;
const validRefField=(out,key,value)=>{const v=validRef(value);if(v)out[key]=v;};

function projectEvent(run,event,sequence) {
  const d=event?.data, item=d?.item;
  const entry={sequence,envelope:envelopeKinds.has(event?.type)?event.type:'other-envelope',
    kind:eventKinds.has(d?.type)?d.type:'other-event'};
  const at=timestamp(event?.at);if(at)entry.at=at;
  const nodeRef=reference(run.id,'node',event?.nodeId);
  if(nodeRef&&Object.hasOwn(run.nodes||{},event.nodeId))entry.nodeRef=nodeRef;
  const callRef=entry.kind==='browser.observation' ? validRef(d?.callRef) : turnMachineCallRef(run.id,d?.callId||d?.toolCallId||d?.nativeCallId||item?.callId||item?.id);
  if(callRef)entry.callRef=callRef;
  for(const [key,kind] of [['threadRef','thread'],['turnRef','turn']]){const ref=reference(run.id,kind,d?.[kind+'Id']);if(ref)entry[key]=ref;}
  for(const [key,field] of [['focusRef','focusId'],['receiptActionRef','receiptActionId']]){const ref=reference(run.id,'action',d?.[field]);if(ref)entry[key]=ref;}
  const actionRef=reference(run.id,'action',d?.actionId);
  if(actionRef)entry.actionRef=actionRef;
  const receiptRef=reference(run.id,'receipt',d?.receiptId);
  if(receiptRef)entry.receiptRef=receiptRef;
  const metadataFields=entry.kind==='browser.observation' ? browserObservationMetadata(d) : metadata({},d);
  delete metadataFields.type;
  if(entry.kind==='browser.reference')Object.assign(metadataFields,projectBrowserControlBinding(d));
  if(entry.kind==='workspace.search.coverage')searchCoverage(metadataFields,d);
  // Tool arguments, targets, text and result payload are not touched, even
  // to infer action names or count their bytes. Only producer metadata enters.
  if(itemKinds.has(item?.type))metadataFields.itemKind=item.type;
  if(toolKinds.has(item?.tool||item?.name)||toolKinds.has(d?.name))metadataFields.tool=(toolKinds.has(item?.tool||item?.name)?(item.tool||item.name):d.name);
  if(statuses.has(item?.status)&&!metadataFields.status)metadataFields.status=item.status;
  if(typeof item?.success==='boolean'&&metadataFields.success===undefined)metadataFields.success=item.success;
  if(code(item?.code)&&!metadataFields.code)metadataFields.code=item.code;
  const source=entry.envelope==='run.updated'?(d?.run||d):entry.envelope==='node.updated'?d:null;
  if(source){if(statuses.has(source.status))metadataFields.status=source.status;if(typeof source.settled==='boolean')metadataFields.settled=source.settled;if(code(source.errorCode))metadataFields.code=source.errorCode;}
  const model=knownModel(d?.model);
  if(model)metadataFields.model=model;
  if(d?.model!==undefined)metadataFields.modelRef=reference(run.id,'model',d.model);
  if(d?.providerId!==undefined)metadataFields.providerRef=reference(run.id,'provider',d.providerId);
  if(d?.state?.revision!==undefined&&counter(d.state.revision)!==undefined)metadataFields.revision=d.state.revision;
  if(d?.context)metadataFields.context=metadata({},d.context);
  if(d?.usage){
    metadataFields.usage=metadata({},d.usage);
    for(const group of ['total','last','input','output'])if(safeObject(d.usage[group]))metadataFields.usage[group]=metadata({},d.usage[group]);
  }
  if(Object.keys(metadataFields).length)entry.metadata=metadataFields;
  if(Buffer.byteLength(JSON.stringify(entry))>TURN_MACHINE_TRACE_LIMITS.entryBytes){
    delete entry.metadata;entry.metadataOmitted='entry-byte-limit';
  }
  return entry;
}

function safeRestoredEntry(row,seen) {
  const sequence=counter(row?.sequence);
  if(!sequence||sequence>seen)return null;
  const entry={sequence,envelope:envelopeKinds.has(row.envelope)?row.envelope:'other-envelope',kind:eventKinds.has(row.kind)?row.kind:'other-event'};
  const at=timestamp(row.at);if(at)entry.at=at;
  for(const key of ['nodeRef','callRef','actionRef','receiptRef','threadRef','turnRef','focusRef','receiptActionRef'])validRefField(entry,key,row[key]);
  if(row.metadataOmitted==='entry-byte-limit')entry.metadataOmitted=row.metadataOmitted;
  if(safeObject(row.metadata)){
    const safe=entry.kind==='browser.observation' ? browserObservationMetadata(row.metadata) : metadata({},row.metadata);
    delete safe.type;
    if(entry.kind==='browser.reference')Object.assign(safe,projectBrowserControlBinding(row.metadata));
    if(entry.kind==='workspace.search.coverage')searchCoverage(safe,row.metadata);
    if(itemKinds.has(row.metadata.itemKind))safe.itemKind=row.metadata.itemKind;
    const model=restoredModel(row.metadata.model);if(model)safe.model=model;
    for(const key of ['modelRef','providerRef'])validRefField(safe,key,row.metadata[key]);
    if(safeObject(row.metadata.context))safe.context=metadata({},row.metadata.context);
    if(safeObject(row.metadata.usage)){
      safe.usage=metadata({},row.metadata.usage);
      for(const key of ['total','last','input','output'])if(safeObject(row.metadata.usage[key]))safe.usage[key]=metadata({},row.metadata.usage[key]);
    }
    if(Object.keys(safe).length)entry.metadata=safe;
  }
  if(Buffer.byteLength(JSON.stringify(entry))>TURN_MACHINE_TRACE_LIMITS.entryBytes){delete entry.metadata;entry.metadataOmitted='entry-byte-limit';}
  return entry;
}

export function recordTurnMachineEvent(run,event) {
  if(run?.directoryDiagnostics!=='maximal'||!id(run.id)||event?.runId!==run.id)return;
  const journal=run.turnMachineTrace||={version:VERSION,runId:run.id,taskId:run.taskId||run.id,seen:0,head:[],tail:[]};
  if(journal.version!==VERSION||journal.runId!==run.id||journal.taskId!==(run.taskId||run.id)||
    !Array.isArray(journal.head)||!Array.isArray(journal.tail)||!Number.isSafeInteger(journal.seen)||journal.seen<0||journal.seen>=Number.MAX_SAFE_INTEGER)return;
  const ordinal=++journal.seen,entry=projectEvent(run,event,ordinal);
  const {headEntries,tailEntries}=TURN_MACHINE_TRACE_LIMITS;
  if(ordinal<=headEntries)journal.head.push(entry);
  else journal.tail[(ordinal-headEntries-1)%tailEntries]=entry;
}

export function projectTurnMachineTrace(run) {
  const taskId=id(run?.taskId||run?.id)||null,runId=id(run?.id)||null;
  const journal=run?.turnMachineTrace;
  const captured=run?.directoryDiagnostics==='maximal'&&!!journal&&journal.version===VERSION&&journal.runId===runId&&journal.taskId===taskId&&Array.isArray(journal.head)&&Array.isArray(journal.tail)&&counter(journal.seen)!==undefined;
  const seen=captured?journal.seen:null, bySequence=new Map();
  if(captured){
    for(const row of journal.head.slice(0,TURN_MACHINE_TRACE_LIMITS.headEntries).concat(journal.tail.slice(0,TURN_MACHINE_TRACE_LIMITS.tailEntries))){
      const entry=safeRestoredEntry(row,seen);
      if(entry&&!bySequence.has(entry.sequence))bySequence.set(entry.sequence,entry);
    }
  }
  const entries=[...bySequence.values()].sort((a,b)=>a.sequence-b.sequence);
  const gaps=[];let expected=1;
  for(const entry of entries){
    if(entry.sequence>expected)gaps.push({from:expected,to:entry.sequence-1});
    expected=entry.sequence+1;
  }
  if(captured&&expected<=seen)gaps.push({from:expected,to:seen});
  const omittedMetadata=entries.filter(entry=>entry.metadataOmitted).length;
  const terminal={status:statuses.has(run?.status)?run.status:null,settled:typeof run?.settled==='boolean'?run.settled:null,
    finishedAt:timestamp(run?.finishedAt)||null, code:code(run?.errorCode)||null};
  const nodes=[];
  for(const nodeId of Object.keys(run?.nodes||{}).slice(0,256)){
    const node=run.nodes[nodeId], context=node?.directoryContext;
    const out={nodeRef:reference(runId,'node',nodeId),status:statuses.has(node?.status)?node.status:null};
    if(!out.nodeRef)continue;
    if(captured&&context?.runId===runId&&context?.taskId===taskId&&context?.nodeId===nodeId){
      out.context=metadata({},context);
      if(timestamp(context.preparedAt))out.context.preparedAt=context.preparedAt;
      if(timestamp(context.providerObservedAt))out.context.providerObservedAt=context.providerObservedAt;
      for(const key of ['attachments','continuity','hostTools'])if(safeObject(context[key]))out.context[key]=metadata({},context[key]);
    }
    if(captured&&Array.isArray(node.toolNames))out.catalog={count:node.toolNames.length,known:node.toolNames.slice(0,256).filter(name=>toolKinds.has(name))};
    nodes.push(out);
  }
  return {schemaVersion:VERSION,audience:'machine',taskId,runId,terminal,limits:TURN_MACHINE_TRACE_LIMITS,
    coverage:{source:captured?'maximal-host-envelopes':'not-recorded',observed:seen,retained:entries.length,
      dropped:captured?seen-entries.length:null,gaps,entryMetadataOmitted:captured?omittedMetadata:null,
      ordinaryRetained: Array.isArray(run?.events)?run.events.length:null,ordinaryOmitted:counter(run?.eventRetention?.omittedEvents)??null,
      limitations:['Only host-emitted envelopes during this turn; no hidden reasoning or off-host actions.','Bounded metadata allowlists omit all raw text, arguments, targets, private reasoning, and payloads.','Linkage references are opaque and scoped to this turn.','A return or successful transport is not proof of the intended effect.','Unrecorded and dropped events cannot be reconstructed from the ordinary timeline.']},
    nodes,entries};
}
