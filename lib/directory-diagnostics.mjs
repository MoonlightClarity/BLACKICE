import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalar=value=>typeof value==='string'?value.slice(0,240):typeof value==='number'||typeof value==='boolean'?value:null;
const contextReceipt=value=>({schemaVersion:value.schemaVersion===1?1:null,runId:scalar(value.runId),taskId:scalar(value.taskId),nodeId:scalar(value.nodeId),preparedAt:scalar(value.preparedAt),providerObservedAt:scalar(value.providerObservedAt),requestSource:scalar(value.requestSource),attachments:{selectedCount:Number.isSafeInteger(value.attachments?.selectedCount)?value.attachments.selectedCount:null,included:typeof value.attachments?.included==='boolean'?value.attachments.included:null},identityIncluded:value.identityIncluded===true,providerSession:scalar(value.providerSession),continuity:{method:scalar(value.continuity?.method),sourceRunId:scalar(value.continuity?.sourceRunId),retainedChars:Number.isSafeInteger(value.continuity?.retainedChars)?value.continuity.retainedChars:null,truncated:value.continuity?.truncated===true},pastChats:scalar(value.pastChats)});
export function projectDirectoryDiagnostics(run,{offset=0,limit=30,revision,view='context',q=''}={}){
 if(!['context','tools'].includes(view)||typeof q!=='string'||q.length>120)throw Object.assign(Error('Choose Context or Tool calls and a short metadata search.'),{status:400});
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Object.assign(Error('Use a bounded Directory page.'),{status:400});
 const receipts=Object.entries(run.nodes||{}).filter(([nodeId,node])=>node.directoryContext?.runId===run.id&&node.directoryContext?.taskId===(run.taskId||run.id)&&node.directoryContext?.nodeId===nodeId).map(([nodeId,node])=>({nodeId,context:{...contextReceipt(node.directoryContext),toolCatalog:Array.isArray(node.toolNames)?node.toolNames.filter(name=>typeof name==='string'&&/^[A-Za-z0-9_:-]{1,120}$/.test(name)).slice(0,200):null}}));
 const actions=[];
 for(const [index,event] of (run.events||[]).entries()){
  const d=event.data||{},item=d.item||{};
  if(d.type!=='tool.result'&&!(d.type==='item'&&['dynamicToolCall','commandExecution','mcpToolCall','fileChange'].includes(item.type))&&!['compaction','context.compacted'].includes(d.type))continue;
  actions.push({eventId:'event:'+index,nodeId:scalar(event.nodeId),callId:scalar(d.callId||item.callId||item.id),kind:d.type,tool:scalar(d.tool||d.name||item.tool||item.name||item.type),action:scalar(d.action),state:scalar(d.status||item.status)||(d.success===true?'returned-success':d.success===false?'returned-error':'unknown'),code:scalar(d.code),at:scalar(event.at),sourceHash:hash(event)});
 }
 const current=hash([run.id,run.updatedAt,run.directoryDiagnostics,receipts,actions]);
 if(revision&&revision!==current)throw Object.assign(Error('Directory changed. Refresh to read current records.'),{status:409,code:'DIRECTORY_CHANGED'});
 const filtered=view==='tools'?actions.filter(action=>JSON.stringify(action).toLowerCase().includes(q.toLowerCase())):[];
 return{view,taskId:run.taskId||run.id,runId:run.id,enabled:run.directoryDiagnostics==='on',receipts,actions:filtered.slice(offset,offset+limit),offset,nextOffset:offset+limit<filtered.length?offset+limit:null,revision:current,coverage:{state:'partial',reason:(run.directoryDiagnostics==='on'?'Directory diagnostics: ':'Not recorded in Directory mode; retained evidence only. ')+'Host provenance and retained action metadata only. Not a complete execution log, private reasoning, or proof of task completion.',retainedEvents:(run.events||[]).length,omittedEvents:run.eventRetention?.omittedEvents??null,receiptAvailability:receipts.length?'recorded':'not recorded'}};
}
