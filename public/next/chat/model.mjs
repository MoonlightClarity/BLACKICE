/** Conversation shaping independent of the legacy interface and execution views. */
const text = value => typeof value === 'string' ? value : '';
export const runText = run => typeof run?.input === 'string' ? run.input : text(run?.input?.task);
export const running = run => ['queued','running','waiting'].includes(run?.status) || run?.settled === false;
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
  const messages = [], byId = new Map(), anonymous = new Map(); let serial = 0;
  function entry(id, nodeId, role = 'assistant') {
    let item = byId.get(id);
    if (!item) { item = { id, nodeId, role, text: '', phase: null }; byId.set(id, item); messages.push(item); }
    return item;
  }
  for (const receipt of run?.events || []) {
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
      if (!content.trim()) continue;
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
    const output = text(run.nodes?.[node.id]?.output); if (!output.trim()) continue;
    const shown = assistantMessages.get(node.id)||[];
    if (shown.some(m => m.text.trim() === output.trim())) continue;
    const combined = shown.map(m=>m.text).join('');
    if (combined.trim() === output.trim()) continue;
    if (!shown.length || run.nodes[node.id]?.status === 'completed') {
      const saved={id:node.id+':saved-output',nodeId:node.id,
        role:'assistant',text:output,phase:'final_answer'};
      messages.push(saved);
      if(!assistantMessages.has(node.id))assistantMessages.set(node.id,[]);
      assistantMessages.get(node.id).push(saved);
    }
  }
  if (!messages.some(m=>m.role==='assistant') && text(run?.output).trim())
    messages.push({ id:'saved-result',role:'assistant',text:run.output,phase:'final_answer' });
  return messages.filter(m=>m.text.trim());
}
const TERMINAL_CHAT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export function canContinueRun(run) {
  return Boolean(run && run.settled === true && TERMINAL_CHAT_STATUSES.has(run.status));
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
    const agent = [...(run.workflow?.nodes || [])].reverse().find(node =>
      node.type === 'agent' && TERMINAL_CHAT_STATUSES.has(run.nodes?.[node.id]?.status));
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
