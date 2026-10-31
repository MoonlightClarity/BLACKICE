/** Read-only Activity projections over the existing run archive and direct ledger.
 * Listing never hydrates saved turns or tool payloads. Detail reads one source.
 */
const ACTIVE = new Set(['queued','running','waiting','awaiting_input','cancelling']);
const TERMINAL = new Set(['completed','succeeded','failed','cancelled','interrupted','skipped']);
const ATTENTION = new Set(['failed','interrupted','blocked','needs_attention','awaiting_input','waiting']);
const SOURCES = new Set(['runs','tools','all']);
const FILTERS = new Set(['all','active','attention','finished']);
const stamp = value => Date.parse(value || '') || 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const invalid = message => Object.assign(new Error(message), { status:400, code:'ACTIVITY_INVALID' });
const unavailable = message => Object.assign(new Error(message), { status:503, code:'ACTIVITY_SOURCE_UNAVAILABLE' });
const missing = () => Object.assign(new Error('This activity record is unavailable.'), { status:404, code:'ACTIVITY_NOT_FOUND' });
const normalize = value => string(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const compact = (value, maximum = 180) => string(value).replace(/\s+/gu,' ').trim().slice(0,maximum);
const boundedNumber = (value, fallback, min, max) => {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw invalid('Choose a supported activity page.');
  return selected;
};
export function activityOptions({source='runs',status='all',q='',offset=0,limit=40} = {}) {
  if (!SOURCES.has(source) || !FILTERS.has(status)) throw invalid('Choose a supported activity source and status.');
  if (typeof q !== 'string' || q.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(q)) throw invalid('Search activity with up to 200 characters.');
  return {source,status,q:q.trim(),offset:boundedNumber(offset,0,0,10000000),limit:boundedNumber(limit,40,1,100)};
}
export function activityText(value, maximum = 12000) {
  const source = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value,null,2);
  return {text:source.slice(0,maximum),totalCharacters:source.length,truncated:source.length > maximum};
}
function errorProjection(value, code) {
  if (!value && !code) return null;
  const raw = typeof value === 'string' ? value : value?.message || value?.error || '';
  const result = activityText(typeof raw === 'string' ? raw : JSON.stringify(raw),1200);
  return {code:string(code || value?.code) || null,message:result.text,totalCharacters:result.totalCharacters,truncated:result.truncated};
}
function toolCounts(run) {
  const summaries = Object.values(run.nodes || {}).map(node=>node?.toolSummary).filter(plain);
  if (!summaries.length) return null;
  const result = {completed:0,failed:0,unresolved:0,omittedUnresolved:0};
  for (const value of summaries) {
    result.completed += Math.max(0,Number(value.completed)||0);
    result.failed += Math.max(0,Number(value.failed)||0);
    result.omittedUnresolved += Math.max(0,Number(value.omittedUnresolved)||0);
    result.unresolved += (Array.isArray(value.issues)?value.issues:[]).filter(issue=>issue && issue.resolved !== true).length;
  }
  result.unresolved += result.omittedUnresolved;
  return result;
}
function lifecycle(status, settled, {error,effects,unresolved=0}={}) {
  const statusConflict = ACTIVE.has(status) && settled === true;
  const known = ACTIVE.has(status) || TERMINAL.has(status) || ATTENTION.has(status);
  const active = !statusConflict && (ACTIVE.has(status) || settled === false);
  const attention = statusConflict || !known || ATTENTION.has(status) || unresolved > 0
    || Boolean(error?.message) || status === 'cancelled' && effects?.possible === true && effects?.confirmed !== true;
  return {active,attention,finished:TERMINAL.has(status) && settled === true,statusConflict};
}
export function projectActivityItem(kind, source, context = {}) {
  if (!plain(source) || typeof source.id !== 'string' || !source.id) return null;
  const status = string(source.status) || 'unknown';
  const settled = kind === 'tools'
    ? TERMINAL.has(status) ? true : ACTIVE.has(status) ? false : null
    : typeof source.settled === 'boolean' ? source.settled : null;
  const error = errorProjection(source.error,source.errorCode);
  const counts = kind === 'runs' ? toolCounts(source) : null;
  const effects = kind === 'tools' && plain(source.effects)
    ? {possible:source.effects.possible === true,confirmed:source.effects.confirmed === true} : undefined;
  const state = lifecycle(status,settled,{error,effects,unresolved:counts?.unresolved||0});
  const item = {kind,id:source.id,key:kind+':'+source.id,
    title:kind === 'runs' ? compact(context.title || source.title || source.input || source.workflowName || source.workflow?.name) || 'Saved run'
      : compact(source.tool || 'Direct action')+(source.action || source.arguments?.action ? ' · '+compact(source.action || source.arguments.action,80) : ''),
    status,settled,...state,createdAt:string(source.createdAt)||null,updatedAt:string(source.updatedAt || source.createdAt)||null,
    startedAt:string(source.startedAt)||null,finishedAt:string(source.finishedAt)||null,error};
  if (kind === 'runs') {
    item.taskId = context.taskId || source.taskId || source.id;
    item.parentRunId = source.parentRunId || null;
    item.conversationState = context.conversationState || 'unknown';
    item.workflowName = compact(source.workflowName || source.workflow?.name) || null;
    item.nodeCount = plain(source.nodes) ? Object.keys(source.nodes).length : null;
    item.toolCounts = counts;
    item.requestId = source.metadata?.clientRequestId || null;
  } else {
    item.requestId = source.requestId || null; item.tool = source.tool || null;
    item.action = source.action || source.arguments?.action || (source.tool === 'blackice_run_command' ? 'run' : null);
    item.revision = Number.isSafeInteger(source.revision) ? source.revision : null;
    item.effects = effects; item.resultAvailable = source.resultAvailable === true || source.result != null;
    item.interaction = source.interaction ? {kind:source.interaction.kind || null,message:activityText(source.interaction.message,1200).text,id:source.interaction.id || null} : null;
  }
  return item;
}
function conversationContext(conversations, source, roots=new Map(), entries=conversations?.entries) {
  let taskId=string(source.taskId) || roots.get(source.id),current=source;
  if (!taskId) {
    const visited=new Set(),trail=[];
    while (current) {
      if (roots.has(current.id)) { taskId=roots.get(current.id);break; }
      if (string(current.taskId)) { taskId=current.taskId;break; }
      if (visited.has(current.id)) { taskId=[...visited].sort()[0];break; }
      visited.add(current.id);trail.push(current.id);
      const parent=current.parentRunId && entries?.get?.(current.parentRunId);
      if (!parent) { taskId=current.id;break; }
      current=parent;
    }
    taskId ||= source.id;
    for (const id of trail) roots.set(id,taskId);
  }
  roots.set(source.id,taskId);
  const saved = conversations?.states?.[taskId];
  return {taskId,title:saved?.title || entries?.get?.(taskId)?.title || source.title,
    conversationState:conversations?.stateRecoveryRequired ? 'unknown' : saved?.state || 'active'};
}
function archiveHealth(conversations) {
  // ConversationArchive.status also groups every historical turn. Its health
  // fields are already current; reading them keeps long legacy chains linear.
  if (conversations && ['stateError','stateWriteError','error','writeFailures'].some(key=>key in conversations)) {
    const error=conversations.stateError || conversations.stateWriteError || conversations.error
      || (conversations.writeFailures?.size?'Some conversation changes could not be saved.':null)
      || (conversations.stateRecoveryRequired?'Saved conversation organization is unavailable.':null);
    return {healthy:!error,error};
  }
  return conversations?.status?.();
}
function errorMessage(error) { return compact(error?.message || error?.error || String(error),1500) || 'This activity source could not be read.'; }
function searchable(item) {
  return normalize([item.title,item.id,item.taskId,item.parentRunId,item.requestId,item.tool,item.action,item.status,item.workflowName,item.error?.code,item.error?.message].filter(Boolean).join(' '));
}
function evidenceRow(value, {id,type,label,status,at,nodeId,tool,action,success}={}) {
  return {id,type,label,status:status||null,at:at||null,nodeId:nodeId||null,tool:tool||null,action:action||null,
    ...(typeof success === 'boolean'?{success}:{}),...activityText(value,16000)};
}
function runEvidence(run) {
  const records = [], events = Array.isArray(run.events) ? run.events : [], failures=new Set();
  const failureKey=value=>JSON.stringify([value.tool,value.action||'call',value.code||'TOOL_FAILED',value.message||'The tool did not complete.']);
  const toolItems = new Set(['dynamicToolCall','commandExecution','fileChange','mcpToolCall','webSearch']);
  for (let index=0;index<events.length;index++) {
    const event=events[index]; if (!plain(event)) continue;
    const data=plain(event.data)?event.data:event, type=data.type || event.type;
    if (!['tool.result','error','capability','turn'].includes(type) && !(type === 'item' && toolItems.has(data.item?.type))) continue;
    if (type === 'capability' && data.available !== false) continue;
    if (type === 'tool.result' && data.success === false) failures.add(failureKey(data));
    const tool=data.tool || data.item?.tool || data.item?.name || (type==='item'?data.item.type:null);
    const label=type==='tool.result'?'Tool result':type==='item'?'Tool receipt':type==='error'?'Recorded error':type==='capability'?'Capability unavailable':'Turn status';
    records.push({value:data,id:run.id+':event:'+index,type,label:label+(tool?': '+tool:''),
      status:data.status || data.item?.status,at:event.at || data.at,nodeId:event.nodeId,tool,action:data.action,success:data.success});
  }
  const retainedEvents=records.length;records.reverse();let summaryCount=0;
  for (const [nodeId,node] of Object.entries(run.nodes||{})) {
    const issues=Array.isArray(node?.toolSummary?.issues)?node.toolSummary.issues:[];
    for (let index=0;index<issues.length;index++) {
      const issue=issues[index];if(!plain(issue))continue;
      if (issue.resolved!==true && failures.has(failureKey(issue))) continue;
      records.push({value:{source:'node.toolSummary.issues',...issue},id:run.id+':node:'+nodeId+':issue:'+index,
        type:'tool.issue',label:'Retained tool issue'+(issue.tool?': '+issue.tool:''),status:issue.resolved===true?'recovered':'unresolved',
        nodeId,tool:issue.tool,action:issue.action,at:issue.at||null});
      summaryCount++;
    }
  }
  return {records,totalEvents:events.length,omittedEvents:events.length-retainedEvents,summaryCount};
}
function pageEvidence(records, options, extra={}, project=value=>value) {
  const offset=boundedNumber(options?.offset,0,0,10000000),limit=boundedNumber(options?.limit,50,1,100);
  return {items:records.slice(offset,offset+limit).map(project),total:records.length,offset,limit,nextOffset:offset+limit<records.length?offset+limit:null,...extra};
}
function runDetail(run, conversations, options) {
  if (!plain(run) || typeof run.id !== 'string' || !plain(run.nodes) || !Array.isArray(run.workflow?.nodes)) throw unavailable('The saved run is incomplete or unreadable.');
  const nodes=Object.entries(run.nodes), definition=new Map(run.workflow.nodes.map(node=>[node.id,node]));
  const evidence=runEvidence(run);
  return {item:projectActivityItem('runs',run,conversationContext(conversations,run)),input:activityText(run.input),
    output:activityText(run.output),error:errorProjection(run.error,run.errorCode),
    nodes:nodes.slice(0,80).map(([id,node])=>({id,name:definition.get(id)?.name || id,type:definition.get(id)?.type || null,
      status:string(node?.status)||'unknown',startedAt:node?.startedAt||null,finishedAt:node?.finishedAt||null,
      model:node?.resolvedModel || definition.get(id)?.model || null,error:errorProjection(node?.error,node?.errorCode),output:activityText(node?.output,6000),
      toolCounts:node?.toolSummary?toolCounts({nodes:{[id]:node}}):null})),
    nodeTotal:nodes.length,nodesTruncated:nodes.length>80,
    evidence:pageEvidence(evidence.records,options,{totalEvents:evidence.totalEvents,omittedEvents:evidence.omittedEvents,retainedSummaryRows:evidence.summaryCount,retainedOnly:true},row=>evidenceRow(row.value,row)),
    notice:'Only retained execution receipts are shown. Older saved conversations may no longer contain tool traces; missing receipts do not establish whether a tool ran. Completed is the recorded execution status, not independent proof that the requested outcome occurred.'};
}
function jobDetail(record, options) {
  if (!plain(record) || typeof record.id !== 'string' || typeof record.tool !== 'string' || !string(record.status) || !plain(record.arguments)
    || record.result != null && (!plain(record.result) || typeof record.result.success !== 'boolean' || !Array.isArray(record.result.contentItems))) throw unavailable('The saved action receipt is incomplete or unreadable.');
  const content=Array.isArray(record.result?.contentItems)?record.result.contentItems:[],records=[],texts=[];
  let imageCount=0;
  for (let index=0;index<content.length;index++) {
    const part=content[index];
    if (part?.type==='inputImage') { imageCount++;continue; }
    if (part?.type!=='inputText' || typeof part.text!=='string') continue;
    texts.push(part.text);
    // Long receipts remain inspectable through bounded chunks, without putting
    // a multi-megabyte command result into a single DOM node.
    const parts=Math.max(1,Math.ceil(part.text.length/12000));
    for (let chunk=0;chunk<parts;chunk++) records.push(evidenceRow(part.text.slice(chunk*12000,(chunk+1)*12000),{
      id:record.id+':result:'+index+':'+chunk,type:'tool.result',label:'Saved result'+(parts>1?' · part '+(chunk+1)+' of '+parts:''),
      status:record.status,at:record.finishedAt || record.updatedAt,tool:record.tool,action:record.arguments?.action,success:record.result?.success}));
  }
  if (record.error) records.push(evidenceRow(record.error,{id:record.id+':error',type:'error',label:'Recorded error',status:record.status,at:record.updatedAt,tool:record.tool}));
  if (record.interaction) records.push(evidenceRow(record.interaction,{id:record.id+':interaction',type:'interaction',label:'Waiting for input',status:record.status,at:record.updatedAt,tool:record.tool}));
  return {item:projectActivityItem('tools',record),input:activityText(record.arguments),output:activityText(texts.join('\n\n')),
    error:errorProjection(record.error),nodes:[],nodeTotal:0,nodesTruncated:false,
    evidence:pageEvidence(records,options,{imageCount,retainedOnly:true}),
    notice:record.transientArguments?'Some input was not retained by the original tool. The saved result and effects are shown exactly as recorded.'
      :imageCount?imageCount+' image receipt'+(imageCount===1?' is':'s are')+' retained in the original action record; this view shows text evidence.'
      :'These are the original saved action results. A successful tool receipt describes that action; inspect its evidence for the broader task outcome.'};
}
export function createActivityService({conversations,engine,directExecution}={}) {
  return {
    async list(value={}) {
      const options=activityOptions(value),sources={},items=[];
      const requested=options.source==='all'?['runs','tools']:[options.source];
      for (const kind of requested) {
        try {
          if (kind==='runs') {
            const archive=conversations?.entries,live=engine?.runs;
            if (!(archive instanceof Map) && !(live instanceof Map)) throw unavailable('The saved run index is unavailable.');
            const merged=new Map(archive instanceof Map?archive:[]);
            if (live instanceof Map) for (const [id,run] of live) merged.set(id,run);
            const roots=new Map();
            for (const source of merged.values()) {
              const item=projectActivityItem('runs',source,conversationContext(conversations,source,roots,merged));
              if (item) items.push(item);
            }
            const health=archiveHealth(conversations);
            sources.runs={available:true,...(health?.healthy===false?{warning:errorMessage(health.error || 'Saved conversation storage needs attention; the retained index may be incomplete.')}:{})};
          } else {
            if (directExecution?.storageError || directExecution?.jobs?.storageError) throw unavailable(errorMessage(directExecution.storageError || directExecution.jobs.storageError));
            if (typeof directExecution?.jobs?.snapshot!=='function') throw unavailable('The direct action index is unavailable.');
            const records=await directExecution.jobs.snapshot();
            if (!Array.isArray(records)) throw unavailable('The direct action index could not be read.');
            for (const source of records) { const item=projectActivityItem('tools',source);if(item)items.push(item); }
            sources.tools={available:true};
          }
        } catch(error) { sources[kind]={available:false,error:errorMessage(error)}; }
      }
      const words=normalize(options.q).split(/\s+/u).filter(Boolean);
      const matching=items.filter(item=>{if(!words.length)return true;const haystack=searchable(item);return words.every(word=>haystack.includes(word));});
      const counts={all:matching.length,active:0,attention:0,finished:0};
      for (const item of matching) for (const key of ['active','attention','finished']) if(item[key])counts[key]++;
      const selected=matching.filter(item=>options.status==='all'||item[options.status]);
      selected.sort((a,b)=>Number(b.active)-Number(a.active)||stamp(b.updatedAt)-stamp(a.updatedAt)||b.id.localeCompare(a.id));
      return {items:selected.slice(options.offset,options.offset+options.limit),total:selected.length,offset:options.offset,limit:options.limit,
        nextOffset:options.offset+options.limit<selected.length?options.offset+options.limit:null,counts,sources,
        partial:Object.values(sources).some(source=>source.available===false || source.warning),generatedAt:new Date().toISOString()};
    },
    async detail(kind,id,options={}) {
      if (!['runs','tools'].includes(kind)) throw invalid('Choose a run or direct action.');
      if (typeof id!=='string' || !(kind==='tools'?/^direct_[a-f0-9]{64}$/:/^[a-zA-Z0-9_-]{1,100}$/).test(id)) throw invalid('Choose a valid activity identifier.');
      boundedNumber(options.offset,0,0,10000000);boundedNumber(options.limit,50,1,100);
      if (kind==='runs') {
        if (typeof conversations?.get!=='function') throw unavailable('Saved run details are unavailable.');
        const run=await conversations.get(id);
        if (!run || run.id!==id) throw missing();
        return runDetail(run,conversations,options);
      }
      if (directExecution?.storageError || directExecution?.jobs?.storageError) throw unavailable(errorMessage(directExecution.storageError || directExecution.jobs.storageError));
      if (typeof directExecution?.jobs?.get!=='function') throw unavailable('Saved action details are unavailable.');
      const record=await directExecution.jobs.get(id);
      if (!record || record.id!==id) throw missing();
      return jobDetail(record,options);
    },
  };
}
