/** Conversation shaping independent of the legacy interface and execution views. */
const text = value => typeof value === 'string' ? value : '';
const hasVisibleChatText = value => typeof value === 'string' && /[^\s\p{Default_Ignorable_Code_Point}]/u.test(value);
export const runText = run => typeof run?.input === 'string' ? run.input : text(run?.input?.task);
export const running = run => ['queued','running','waiting'].includes(run?.status) || run?.settled === false;
const phaseIds=new Set(['feasibility','inference','plan','think','respond']);
const evidenceText=value=>typeof value==='string'&&value.length<=200?value:null;
export function projectCyclePlanning(cycle){
  const value=cycle?.planning;if(value?.scope!=='planning-cycle'||!Array.isArray(value.stages))return undefined;
  const seen=new Set(),stages=[];
  for(const item of value.stages.slice(0,5)){
    if(!phaseIds.has(item?.stage)||seen.has(item.stage)||item.scope!=='planning-invocation')continue;seen.add(item.stage);
    stages.push({stage:item.stage,scope:'planning-invocation',status:['succeeded','needs_evidence','stale','failed','cancelled','unconfirmed','unverified'].includes(item.status)?item.status:'unverified',
      attemptId:evidenceText(item.attemptId),responseId:evidenceText(item.responseId),nodeId:evidenceText(item.nodeId),
      nodeRevision:Number.isSafeInteger(item.nodeRevision)&&item.nodeRevision>0?item.nodeRevision:null,
      outputHash:typeof item.outputHash==='string'&&/^[a-f0-9]{64}$/.test(item.outputHash)?item.outputHash:null,
      structuredResponseValid:item.structuredResponseValid===true,durableResponseRecorded:item.durableResponseRecorded===true,
      currentForNode:item.currentForNode===true,stageReady:item.stageReady===true});
  }
  const ref=value.planRef,planRef=ref&&{requestId:evidenceText(ref.requestId),cycleId:evidenceText(ref.cycleId),nodeId:evidenceText(ref.nodeId),
    nodeRevision:Number.isSafeInteger(ref.nodeRevision)&&ref.nodeRevision>0?ref.nodeRevision:null,responseId:evidenceText(ref.responseId)};
  return {scope:'planning-cycle',stages,planAdopted:value.planAdopted===true,...(planRef?{planRef}:{}),taskSuccessVerified:false};
}
const checkedPhase=phase=>phase?.status==='succeeded'&&phase.structuredResponseValid&&phase.durableResponseRecorded&&phase.currentForNode&&phase.stageReady&&
  Boolean(phase.attemptId&&phase.responseId&&phase.outputHash&&phase.nodeRevision);
export function planningProgressForRun(run){
  const cycle=run?.responseCycle;
  if(!cycle?.requestId)return null;
  const preparing=running(run)&&['preparing','running','evaluating'].includes(cycle.state);
  const stage={feasibility:'Checking task',inference:'Assessing options',plan:'Preparing plan',think:'Reviewing results',respond:'Preparing response'}[cycle.stage];
  const proof=projectCyclePlanning(cycle),plan=proof?.stages.find(item=>item.stage==='plan'),checkedPlan=checkedPhase(plan),ref=proof?.planRef;
  const planAdopted=Boolean(checkedPlan&&proof.planAdopted&&ref&&['requestId','cycleId','nodeId','nodeRevision','responseId'].every(key=>ref[key]===cycle.planRef?.[key])&&
    ref.requestId===cycle.requestId&&ref.cycleId===cycle.cycleId&&ref.nodeId===plan.nodeId&&ref.nodeRevision===plan.nodeRevision&&ref.responseId===plan.responseId);
  const label=preparing?'Planning'+(stage?' · '+stage:''):
    cycle.state==='paused_after_plan'?(checkedPlan?'Plan checked · awaiting review':'Planning result unverified'):
    cycle.state==='executing'?(planAdopted?'Plan adopted · working on task':'Planning result unverified'):
    cycle.state==='completed'?(checkedPhase(proof?.stages.find(item=>item.stage==='respond'))?'Planning review completed':'Planning result unverified'):
    ({needs_evidence:'Planning needs evidence',needs_user_input:'Planning needs your input'})[cycle.state]||'';
  // A saved cycle is evidence, not a persistent notification. Keep explicit
  // plan review and input holds actionable, but never alert on historical failure.
  const actionable=cycle.state==='paused_after_plan'||
    cycle.state==='needs_user_input'&&run.status==='blocked';
  const showNotice=Boolean(label&&(running(run)||actionable));
  return {preparing,label,showNotice,requestId:cycle.requestId,checkedPlan,planAdopted};
}
export const rootId = item => item?.taskId || item?.rootId || item?.id || '';
export const lastRunId = item => item?.runId || item?.latestRunId || item?.id || '';
export function summaries(value = []) {
  return (Array.isArray(value) ? value : []).filter(item => item && rootId(item))
    .sort((a,b) => (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
}
export function filterSummaries(items, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return !needle ? items : items.filter(item =>
    (String(item.rootTitle || item.title || '') + ' ' + String(item.originalTask || '')).toLocaleLowerCase().includes(needle));
}

// Keep a very large saved catalog searchable without mounting thousands of
// interactive buttons. The active conversation remains reachable when it is
// older than the currently exposed batch; pagination never drops metadata.
export const CHAT_INDEX_BATCH = 80;
export function conversationIndexWindow(items, limit = CHAT_INDEX_BATCH, selected = '') {
  const count = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : CHAT_INDEX_BATCH;
  const shown = items.slice(0, count);
  const hidden = items.length - shown.length;
  let pinned = null;
  if (hidden && selected && !shown.some(item => rootId(item) === selected)) {
    for (let i = shown.length; i < items.length; i++) {
      if (rootId(items[i]) === selected) { pinned = items[i]; break; }
    }
  }
  return { shown, hidden, pinned };
}
export const conversationBucket = value => ['active','archived','deleted'].includes(value) ? value : null;
export const conversationActionState = action => ({archive:'archived',restore:'active',delete:'deleted'})[action] || null;
export function conversationManagementTarget(item, bucket = 'active', runs = []) {
  if (!item) return null;
  return {id:rootId(item),runId:lastRunId(item),state:item.state==null?bucket:conversationBucket(item.state)||'unknown',
    title:item.rootTitle||item.title||'Conversation',working:running(item)||runs.some(running)};
}
/** Resolve the exact family/version selected by a person before any mutation. */
export function resolveConversationSelection(selection, resolve, action) {
  if (!(selection instanceof Map)||!selection.size) throw Error('Select at least one conversation.');
  if (!conversationActionState(action)) throw Error('Choose Archive, Restore, or Move to Trash.');
  const result=[];
  for (const [id,expected] of selection) {
    const current=resolve(id);
    if (!current||current.runId!==expected?.runId||current.state!==expected?.state)
      throw Error('A selected chat changed. Review the selection before trying again.');
    if (!conversationBucket(current.state)) throw Error('This chat’s saved state is unavailable. Refresh history before changing it.');
    if (action==='archive'&&current.state!=='active') throw Error('Only active chats can be archived.');
    if (action==='restore'&&current.state==='active') throw Error('This chat is already active.');
    if (action==='delete'&&current.state==='deleted') throw Error('This chat is already in Trash.');
    if (action==='delete'&&current.working) throw Error('Stop working chats before moving them to Trash.');
    result.push(current);
  }
  return result;
}
export function conversationRuns(value) {
  const runs = Array.isArray(value?.runs) ? value.runs : [];
  return runs.filter(run => run && typeof run.id === 'string').sort((a,b) =>
    (Date.parse(a.createdAt || '') || 0) - (Date.parse(b.createdAt || '') || 0) || a.id.localeCompare(b.id));
}
export function messagesOfRun(run) {
  const messages = [], byId = new Map(), anonymous = new Map(); let serial = 0, eventOrder = 0, eventAt;
  function entry(id, nodeId, role = 'assistant') {
    let item = byId.get(id);
    if (!item) { item = { id, nodeId, role, text: '', phase: null, order: eventOrder, ...(eventAt ? { at: eventAt } : {}) }; byId.set(id, item); messages.push(item); }
    return item;
  }
  for (const [order, receipt] of (Array.isArray(run?.events) ? run.events : []).entries()) {
    eventOrder = Number.isFinite(receipt?.timelineOrder) ? receipt.timelineOrder : order; eventAt = typeof receipt?.at === 'string' ? receipt.at : undefined;
    const d = receipt?.data || receipt || {}, nodeId = receipt?.nodeId || d.nodeId || 'agent';
    if (d.type === 'steer' && d.accepted !== false && text(d.text).trim()) {
      const id = 'direction:' + nodeId + ':' + (receipt.at || serial++) + ':' + d.text;
      const item = entry(id, nodeId, 'user'); item.text = d.text; item.direction = true; item.delivery = d.delivery;
      anonymous.delete(nodeId); continue;
    }
    if (d.type === 'delta' && text(d.delta)) {
      const id = d.itemId ? nodeId + ':' + d.itemId : anonymous.get(nodeId) || nodeId + ':stream-' + serial++;
      anonymous.set(nodeId,id);const item=entry(id,nodeId);item.text += d.delta;if(d.provisional)item.provisional=true;continue;
    }
    if (d.type === 'message' || d.type === 'item' && d.item?.type === 'agentMessage') {
      const content = text(d.text ?? d.item?.text);
      if (!hasVisibleChatText(content)) continue;
      // The response cycle publishes its checked delivery after the provider's
      // streamed final. Keep the receipt, but render an unchanged adjacent
      // final only once. Directions, other speakers and revised answers still
      // retain their own chronology.
      const previous = messages.at(-1);
      if (d.responseCycleFinal === true && previous?.role === 'assistant' &&
          previous.nodeId === nodeId && previous.phase === 'final_answer' && !previous.provisional &&
          previous.text.trim() === content.trim()) continue;
      const itemId = d.itemId || d.item?.id;
      const id = itemId ? nodeId + ':' + itemId : anonymous.get(nodeId) || nodeId + ':message-' + serial++;
      const item = entry(id,nodeId); item.text=content;item.phase=d.phase||d.item?.phase||item.phase;if(d.provisional)item.provisional=true;
      anonymous.delete(nodeId);continue;
    }
    if (d.type === 'item' && ['dynamicToolCall','mcpToolCall','commandExecution','fileChange'].includes(d.item?.type)) anonymous.delete(nodeId);
  }
  // Each saved agent's output only needs its own messages. Repeatedly
  // filtering the whole transcript for every agent made large multi-agent
  // histories quadratic even inside the background reader worker.
  const assistantMessages=new Map();
  for(const message of messages){
    if(message.role!=='assistant')continue;
    if(!assistantMessages.has(message.nodeId))assistantMessages.set(message.nodeId,[]);
    assistantMessages.get(message.nodeId).push(message);
  }
  for (const node of run?.workflow?.nodes || []) {
    if (node.type !== 'agent' || run.nodes?.[node.id]?.reused) continue;
    const output = text(run.nodes?.[node.id]?.output); if (!hasVisibleChatText(output)) continue;
    const shown = assistantMessages.get(node.id)||[];
    if (shown.some(m => m.text.trim() === output.trim())) continue;
    const combined = shown.map(m=>m.text).join('');
    if (combined.trim() === output.trim()) continue;
    if (!shown.length || run.nodes[node.id]?.status === 'completed') {
      const saved={id:node.id+':saved-output',nodeId:node.id,
        role:'assistant',text:output,phase:'final_answer',order:(run?.events?.length||0)+messages.length,
        at:run.nodes[node.id]?.finishedAt||run.finishedAt||run.updatedAt};
      messages.push(saved);
      if(!assistantMessages.has(node.id))assistantMessages.set(node.id,[]);
      assistantMessages.get(node.id).push(saved);
    }
  }
  // Aggregate output can contain only agent headings when a provider returned
  // whitespace. Known empty agent outputs must not become an invented answer.
  // Older saves without per-agent output still retain their aggregate fallback.
  const agentStates=(run?.workflow?.nodes||[]).filter(node=>node.type==='agent'&&!run.nodes?.[node.id]?.reused).map(node=>run.nodes?.[node.id]);
  const emptyAgentOutputs=agentStates.length>0&&agentStates.every(node=>typeof node?.output==='string'&&!hasVisibleChatText(node.output));
  if (!messages.some(m=>m.role==='assistant'&&hasVisibleChatText(m.text)) && !emptyAgentOutputs && hasVisibleChatText(run?.output))
    messages.push({ id:'saved-result',role:'assistant',text:run.output,phase:'final_answer',order:(run?.events?.length||0)+messages.length,at:run.finishedAt||run.updatedAt });
  return messages.filter(m=>hasVisibleChatText(m.text));
}
/** Only a bounded public error message crosses the archived-chat reader. */
export function chatErrorText(value) {
  return typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,2000):'';
}
/** A finished turn is not proof that the provider delivered an answer. */
export function chatResponseState(run, messages=[]) {
  const hasResponse=messages.some(message=>message.role==='assistant'&&hasVisibleChatText(message.text)&&!message.provisional&&
    !['commentary','working','progress','unverified_answer'].includes(message.phase));
  const completed=run?.status==='completed'&&run?.settled===true;
  const pausedAfterPlan=completed&&run.responseCycle?.state==='paused_after_plan';
  const missing=completed&&!pausedAfterPlan&&!hasResponse;
  const failed=run?.status==='failed'&&run?.settled===true;
  const errors=failed?[...new Set([run.error,...Object.values(run.nodes||{}).filter(node=>node?.status==='failed').map(node=>node.error)]
    .map(chatErrorText).filter(Boolean))].slice(0,4):[];
  return {hasResponse,missing,pausedAfterPlan,errors,needsFollowup:missing||failed&&!hasResponse};
}
/** Keep the conversation header consistent with the delivered-response timeline. */
/** Compact standing-goal state is separate from the latest turn's status. */
export function projectConversationGoal(goal) {
  if(!goal||typeof goal!=='object'||!['active','waiting','paused','completed','blocked','interrupted','budget_exhausted'].includes(goal.status))return null;
  return {id:String(goal.id||'').slice(0,160),revision:Number.isSafeInteger(goal.revision)?goal.revision:0,status:goal.status,
    ...(typeof goal.running==='boolean'?{running:goal.running}:{}),
    ...(goal.pauseRequest?{pauseRequest:{status:['paused','unverified'].includes(goal.pauseRequest.status)?goal.pauseRequest.status:'pausing',settled:goal.pauseRequest.settled===true}}:{}),
    ...(typeof goal.runStatus==='string'?{runStatus:goal.runStatus.slice(0,40)}:{}),
    turns:Number.isSafeInteger(goal.turns)?goal.turns:0,maxTurns:Number.isSafeInteger(goal.maxTurns)?goal.maxTurns:null,
    currentRunId:typeof goal.currentRunId==='string'?goal.currentRunId.slice(0,160):null};
}
export function conversationGoalStatus(goal,run) {
  const value=projectConversationGoal(goal);if(!value)return null;
  const working=typeof value.running==='boolean'?value.running:run?.status==='running'&&run?.settled!==true;
  if(value.pauseRequest?.status==='unverified')return 'Pause needs verification';
  if(value.pauseRequest?.status==='pausing')return 'Pausing';
  if(working)return 'Running';
  if(value.status==='active'){
    const phase=value.runStatus||run?.status;
    return phase==='queued'?'Goal queued':phase==='waiting'?'Goal waiting':'Goal ready';
  }
  return {paused:'Goal paused',waiting:'Goal waiting',completed:'Goal completed',blocked:'Goal needs attention',
    interrupted:'Goal interrupted',budget_exhausted:'Goal turn limit reached'}[value.status];
}

export function chatHeaderStatus(run,goal=run?.goal) {
  const goalStatus=conversationGoalStatus(goal,run);if(goalStatus)return goalStatus;
  if (!run) return 'Local workspace';
  if (planningProgressForRun(run)?.preparing) return 'Planning';
  if (run.status!=='completed') return run.status||'Saved';
  if (run.settled===false) return 'Finishing';
  const response=chatResponseState(run,messagesOfRun(run));
  return response.pausedAfterPlan?'Plan ready':response.hasResponse?'Saved response':response.missing?'No response received':'Finished';
}
const TERMINAL_CHAT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export function canContinueRun(run) {
  return Boolean(run && run.settled === true && (TERMINAL_CHAT_STATUSES.has(run.status)||run.status==='blocked'&&run.viability?.awaitingInput===true));
}
export function replyTarget(runs) {
  const history = Array.isArray(runs) ? runs : [];
  // The last saved turn owns the reply target. In particular, do not skip
  // a failed model and silently resume an earlier successful model.
  const run = history.at(-1) || null;
  if (running(run)) {
    const agent = run.status === 'running' && run.workflow?.nodes?.find(node =>
      node.type === 'agent' && run.nodes?.[node.id]?.status === 'running'
      && (['opening','inquiry-opening','inquiry','main-opening'].includes(run.nodes?.[node.id]?.runtimePhase)
        || run.nodes?.[node.id]?.threadId && run.nodes?.[node.id]?.turnId));
    // Opening/handoff directions queue inside the active execution; an inquiry
    // uses its actual live turn. Never target an older idle coordinator thread.
    return { run, active: Boolean(agent), nodeId: agent?.id || null };
  }
  if (canContinueRun(run)) {
    const agents=[...(run.workflow?.nodes||[])].reverse().filter(node=>node.type==='agent');
    const held=run.status==='blocked'&&run.viability?.awaitingInput===true;
    const agent=(held&&agents.find(node=>run.nodes?.[node.id]?.viabilityHeld===true))
      ||(run.status==='failed'&&agents.find(node=>run.nodes?.[node.id]?.status==='failed'))
      // A provider or planning failure can settle the overall run before its
      // selected agent starts; keep that agent available for a model switch.
      ||(run.status==='failed'&&agents.find(node=>!TERMINAL_CHAT_STATUSES.has(run.nodes?.[node.id]?.status)))
      ||agents.find(node=>TERMINAL_CHAT_STATUSES.has(run.nodes?.[node.id]?.status));
    // A provider can fail before creating a thread. The engine reconstructs
    // context from saved conversation history, so a thread ID is not required.
    if (agent) return { run, nodeId: agent.id, active: false };
  }
  return { run, nodeId: null, active: false };
}
export const CHAT_MESSAGE_BATCH=80;
export function windowedMessages(messages, count=CHAT_MESSAGE_BATCH) {
  const list=Array.isArray(messages)?messages:[];
  const size=Number.isFinite(count)?Math.max(1,Math.floor(count)):CHAT_MESSAGE_BATCH;
  const visible=Math.min(list.length,size);
  return {shown:list.slice(-visible),hidden:list.length-visible};
}
export function messageLimitsAfterRefresh(previousRuns, nextRuns, limits) {
  const nextLimits=new Map();
  if(!limits?.size)return nextLimits;
  const previous=new Map(previousRuns.map(run=>[run.id,run]));
  const next=new Map(nextRuns.map(run=>[run.id,run]));
  const messages=run=>Array.isArray(run.precomputedMessages)?run.precomputedMessages:messagesOfRun(run);
  for(const [id,limit] of limits){
    const before=previous.get(id),after=next.get(id);
    if(!before||!after)continue;
    // Only explicitly expanded turns retain their revealed boundary. A fixed
    // tail count would otherwise hide those messages as new replies arrive.
    const revealed=new Set(windowedMessages(messages(before),limit).shown
      .map(message=>message.id).filter(id=>typeof id==='string'&&id));
    const current=messages(after);
    const boundary=current.findIndex(message=>revealed.has(message.id));
    // A removed/replaced transcript starts with the normal bounded viewport.
    if(boundary>=0)nextLimits.set(id,current.length-boundary);
  }
  return nextLimits;
}
export function windowedRuns(runs, count = 12) {
  const n = Math.min(runs.length, Math.max(1, Math.floor(count)));
  return { shown: runs.slice(-n), hidden: runs.length - n };
}

export const UNKNOWN_CHAT_MODEL = '__saved_model_unknown__';
const STORAGE_KEY = 'blackice.next.chatModelOverrides';
export function concreteChatModel(value) {
  if (typeof value !== 'string') return null;
  const model=value.trim();
  return model && model.length<=400 && !['default','codex',UNKNOWN_CHAT_MODEL].includes(model) ? model : null;
}

/** Preserve bounded authoritative identity before the reader discards raw traces. */
export function recordedChatModels(run) {
  const threads=new Map(), result={};
  for (const event of Array.isArray(run?.events)?run.events:[]) {
    const data=event?.data||event, id=event?.nodeId||data?.nodeId;
    const model=data?.type==='thread'&&concreteChatModel(data.model);
    if (id&&model) threads.set(id,model);
  }
  const definitions=new Map((run?.workflow?.nodes||[]).filter(n=>n?.type==='agent').map(n=>[n.id,n]));
  for (const id of new Set([...definitions.keys(),...Object.keys(run?.nodes||{})])) {
    const node=run?.nodes?.[id]||{}, definition=definitions.get(id);
    const evidence=[
      [node.resolvedModel,'resolvedModel'],
      [threads.get(id),'thread'],
      [node.modelEvidence?.model,node.modelEvidence?.source||'saved'],
      [node.model,'node'],
      [definition?.model,'workflow'],
    ].find(([model])=>concreteChatModel(model));
    if(evidence) result[id]={model:concreteChatModel(evidence[0]),source:evidence[1]};
  }
  return result;
}
/** Merge one same-run event without losing identity projected from older traces. */
export function mergeChatRunUpdate(previous, updated) {
  if (!previous || previous.id!==updated?.id) return previous;
  const rawNodes=updated.nodes||previous.nodes||{};
  const fresh=recordedChatModels({...previous,...updated,nodes:rawNodes,events:Array.isArray(updated.events)?updated.events:[]});
  const remembered=recordedChatModels(previous);
  const observed=evidence=>['resolvedModel','thread','saved-thread','saved'].includes(evidence?.source);
  const nodes=Object.fromEntries(Object.entries(rawNodes).map(([id,node])=>{
    const evidence=observed(fresh[id])?fresh[id]:observed(remembered[id])?remembered[id]:fresh[id]||remembered[id];
    return [id,{...node,...(Object.hasOwn(node,'error')?{error:chatErrorText(node.error)||undefined}:{}),...(evidence?{modelEvidence:evidence}:{})}];
  }));
  const result={...previous,status:updated.status??previous.status,settled:updated.settled??previous.settled,
    nodes,output:updated.output??previous.output,updatedAt:updated.updatedAt||previous.updatedAt};
  if(Object.hasOwn(updated,'error'))result.error=chatErrorText(updated.error)||undefined;
  if(Object.hasOwn(updated,'errorCode'))result.errorCode=updated.errorCode;
  if(Object.hasOwn(updated,'viability'))result.viability=updated.viability?.awaitingInput===true?{awaitingInput:true}:undefined;
  if(Object.hasOwn(updated,'responseCycle')){
    const cycle=updated.responseCycle;
    result.responseCycle=cycle?{state:cycle.state,stage:cycle.stage,requestId:cycle.requestId,cycleId:cycle.cycleId,
      title:String(cycle.title||'').slice(0,240),summary:String(cycle.summary||'').slice(0,1200),
      ...(projectCyclePlanning(cycle)?{planning:projectCyclePlanning(cycle)}:{}),
      planRef:cycle.planRef&&{requestId:cycle.planRef.requestId,...(cycle.planRef.cycleId?{cycleId:cycle.planRef.cycleId}:{}),nodeId:cycle.planRef.nodeId,nodeRevision:cycle.planRef.nodeRevision,responseId:cycle.planRef.responseId}}:undefined;
  }
  return result;
}

export function conversationModelEvidence(runs=[]) {
  const target=replyTarget(runs), run=target.run;
  if(!run) return null;
  const nodeId=target.nodeId||[...(run.workflow?.nodes||[])].reverse().find(n=>n.type==='agent'&&!run.nodes?.[n.id]?.reused)?.id;
  if(!nodeId) return null;
  const saved=recordedChatModels(run)[nodeId];
  if(saved) return {...saved,runId:run.id,nodeId};
  // A matching saved thread is evidence; an unrelated older chat model is not.
  const current=run.nodes?.[nodeId]||{}, threadId=current.threadId||current.resumeThreadId;
  if(threadId) for(const previous of runs.slice(0,-1).reverse()) {
    for(const [id,node] of Object.entries(previous.nodes||{})) {
      if(node.threadId!==threadId&&node.resumeThreadId!==threadId) continue;
      const prior=recordedChatModels(previous)[id];
      if(prior) return {...prior,source:'saved-thread',runId:previous.id,nodeId:id};
    }
  }
  return null;
}

/** Only explicit, unsent choices belong in browser storage, keyed by chat root. */
export function createConversationModelSelection({storage}={}) {
  const overrides=new Map(), revisions=new Map();
  try {
    const saved=JSON.parse(storage?.getItem(STORAGE_KEY)||'{}');
    if(saved.version===1) for(const [owner,model] of Object.entries(saved.overrides||{}).slice(-100)) {
      if(owner&&owner.length<=200&&(concreteChatModel(model)||owner==='new'&&model==='default')) overrides.set(owner,model);
    }
  } catch {}
  const persist=()=>{
    while(overrides.size>100) overrides.delete(overrides.keys().next().value);
    try {storage?.setItem(STORAGE_KEY,JSON.stringify({version:1,overrides:Object.fromEntries(overrides)}));} catch {}
  };
  return {
    read(owner,runs=[]) {
      const explicit=overrides.has(owner);
      const saved=owner==='new'?null:conversationModelEvidence(runs);
      return {owner,revision:revisions.get(owner)||0,explicit,
        model:explicit?overrides.get(owner):owner==='new'?'default':saved?.model||UNKNOWN_CHAT_MODEL,
        evidence:saved};
    },
    choose(owner,value,status={}) {
      const model=value==='default'&&owner!=='new'?concreteChatModel(status.defaultModel):value;
      if(!(concreteChatModel(model)||owner==='new'&&model==='default')) throw Error('Choose an available model for this conversation.');
      overrides.delete(owner);overrides.set(owner,model);revisions.set(owner,(revisions.get(owner)||0)+1);persist();
      return model;
    },
    consume(submitted) {
      if(!submitted?.explicit||(revisions.get(submitted.owner)||0)!==submitted.revision) return false;
      overrides.delete(submitted.owner);revisions.set(submitted.owner,submitted.revision+1);persist();return true;
    },
  };
}
