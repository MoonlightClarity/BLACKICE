import {createHash} from 'node:crypto';
import {receiptDepth} from './directory-context-receipt.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(value)?value:null;
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)?value:null;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const bool=value=>typeof value==='boolean'?value:null;
const choice=(value,values)=>values.includes(value)?value:null;
const contextReceipt=value=>({schemaVersion:value.schemaVersion===1?1:null,runId:token(value.runId),taskId:token(value.taskId),nodeId:token(value.nodeId),preparedAt:date(value.preparedAt),providerObservedAt:date(value.providerObservedAt),requestSource:choice(value.requestSource,['current-request','retry-of-saved-request','goal-dispatch','autonomy-dispatch']),attachments:{selectedCount:integer(value.attachments?.selectedCount),included:bool(value.attachments?.included)},identityIncluded:bool(value.identityIncluded),providerSession:choice(value.providerSession,['fresh','resumed-opaque']),continuity:{method:choice(value.continuity?.method,['none','saved-messages','automatic-compaction']),sourceRunId:token(value.continuity?.sourceRunId),retainedChars:integer(value.continuity?.retainedChars),truncated:bool(value.continuity?.truncated)},pastChats:choice(value.pastChats,['on','off']),...(value.hostTools?{hostTools:{received:integer(value.hostTools.received),returned:integer(value.hostTools.returned),threw:integer(value.hostTools.threw)}}:{})});
export function projectTurnReceipts(run,{offset=0,limit=30,revision,view='context',q=''}={}){
 if(!['context','tools','decisions'].includes(view)||typeof q!=='string'||q.length>120)throw Object.assign(Error('Choose Context, Tool calls, or Outline decisions and a short metadata search.'),{status:400});
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Object.assign(Error('Use a bounded Turn receipts page.'),{status:400});
 const receipts=Object.entries(run.nodes||{}).filter(([nodeId,node])=>node.directoryContext?.runId===run.id&&node.directoryContext?.taskId===(run.taskId||run.id)&&node.directoryContext?.nodeId===nodeId).map(([nodeId,node])=>({nodeId,context:{...contextReceipt(node.directoryContext),toolCatalog:Array.isArray(node.toolNames)?node.toolNames.filter(name=>token(name)).slice(0,200):null}}));
 const terminal={status:choice(run.status,['queued','running','completed','failed','cancelled','interrupted','paused','pending','succeeded']),settled:bool(run.settled),finishedAt:date(run.finishedAt),code:token(run.errorCode)};
 const actions=[];
 // Context never reads action detail or raw payloads. Tools project only bound metadata.
 if(view!=='context')for(const [index,event] of (run.events||[]).entries()){
  if(event.runId!==run.id||!Object.hasOwn(run.nodes||{},event.nodeId))continue;
  const d=event.data||{},item=d.item||{};
  if(view==='decisions'){
   if(d.type!=='directory.mutation')continue;
   actions.push({eventId:token(event.id)||'event:'+index,nodeId:token(event.nodeId),at:date(event.at),kind:d.type,
    action:choice(d.operation,['read','plan','focus','refine','observe','block']),state:choice(d.phase,['applied','rejected']),
    revisionPresent:bool(d.revisionPresent),revisionType:choice(d.revisionType,['undefined','null','array','number','string','boolean','object']),submittedRevision:integer(d.submittedRevision),
    boundActionRevision:integer(d.boundActionRevision),comparisonRevision:integer(d.comparisonRevision),comparisonActionRevision:integer(d.comparisonActionRevision),
    resultRevision:integer(d.resultRevision),resultActionRevision:integer(d.resultActionRevision),linkedReadCount:integer(d.linkedReadCount),code:token(d.code),reason:choice(d.reason,['action-snapshot-changed','mutation-rejected','host-snapshot-binding'])});
   continue;
  }
  if(d.type!=='tool.result'&&!(d.type==='item'&&['dynamicToolCall','commandExecution','mcpToolCall','fileChange'].includes(item.type))&&!['compaction','context.compacted'].includes(d.type))continue;
  actions.push({eventId:token(event.id)||'event:'+index,nodeId:token(event.nodeId),callId:token(d.callId||item.callId||item.id),kind:d.type,tool:token(d.tool||d.name||item.tool||item.name||item.type),action:token(d.action),state:choice(d.status||item.status,['queued','running','completed','failed','cancelled','started','in_progress','succeeded'])||(d.success===true?'returned-success':d.success===false?'returned-error':'unknown'),code:token(d.code),at:date(event.at)});
 }
 const current=hash([view,run.id,run.updatedAt,run.directoryDiagnostics,terminal,receipts,actions]);
 if(revision&&revision!==current)throw Object.assign(Error('Turn receipts changed. Refresh to read current records.'),{status:409,code:'TURN_RECEIPTS_CHANGED'});
 const filtered=actions.filter(action=>JSON.stringify(action).toLowerCase().includes(q.toLowerCase()));
 const depth=receiptDepth(run.directoryDiagnostics);
 return{view,taskId:run.taskId||run.id,runId:run.id,depth,enabled:depth!=='basic',terminal,receipts,actions:filtered.slice(offset,offset+limit),offset,nextOffset:offset+limit<filtered.length?offset+limit:null,revision:current,coverage:{state:'partial',reason:(depth==='basic'?'Full receipts were not recorded; retained evidence only. ':'Recorded turn receipts: ')+'Host provenance and retained action metadata only. Not a complete execution log, private reasoning, or proof of task completion.',retainedEvents:(run.events||[]).length,omittedEvents:integer(run.eventRetention?.omittedEvents),receiptAvailability:receipts.length?'recorded':'not recorded'}};
}
