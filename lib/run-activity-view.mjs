import {createHash} from 'node:crypto';
import {projectToolFailureHistory} from '../public/next/chat/tool-failure.mjs';
const fail=message=>Object.assign(Error(message),{code:'ACTIVITY_QUERY',status:400});
const text=(value,max=24000)=>typeof value==='string'?value.slice(0,max):'';
const id=value=>text(value,120);
const actionLabel=tool=>({relay_directory_context:'Saved evidence',relay_browser:'Browser',relay_history:'Saved history'})[tool]||'Tool';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=(value,names)=>Object.fromEntries(names.filter(key=>typeof value?.[key]==='string').map(key=>[key,value[key]]));
export function activityQuery({view='updates',q='',offset=0,limit=30,revision}={}){
 if(!['updates','tools','failures','internal'].includes(view)||typeof q!=='string'||q.length>200||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('Use Updates, Tool calls, Tool failures or Internal outputs, a search of at most 200 characters, and a bounded page.');
 return {view,q:q.trim().toLocaleLowerCase(),offset,limit,revision};
}
function historicalStructured(raw){
 if(!raw.trim().startsWith('{'))return null;
 try{const p=JSON.parse(raw),keys=Object.keys(p),work=['status','nextAction','finding','candidate_answer','uncertainty'];
 if(keys.length===5&&work.every(k=>typeof p[k]==='string')&&['complete','incomplete','blocked'].includes(p.status))return p;
 if(keys.length===2&&typeof p.answer==='string'&&Array.isArray(p.used_refs)&&p.used_refs.every(x=>typeof x==='string'))return p;
 }catch{}return null;
}
export function projectActivityEvent(event,index){
 const d=event?.data||{},item=d.item||{},base={id:'event:'+index,at:text(event.at,50),nodeId:id(event.nodeId),source:'retained event'};
 if(d.type==='message'&&d.incomplete===true)return {...base,view:'internal',title:'Incomplete provider output',text:'An incomplete provider output was recorded. Its ambiguous payload is not displayed or searched.',source:'retained event:'+index,sourceHash:hash(event)};
 if(d.type==='message'&&typeof d.text==='string'){
  const structured=historicalStructured(d.text);
  if(structured)return {...base,view:'internal',title:'Historical structured report',text:JSON.stringify(structured,null,2),source:'retained event:'+index,sourceHash:hash(event)};
  return {...base,view:'updates',title:d.phase==='commentary'?'Agent update':'Agent response',text:d.text};
 }
 if(d.type==='steer'&&typeof d.text==='string')return {...base,view:'updates',title:'Your direction',text:d.text};
 if(d.type==='shadowdancer.step'&&['action-started','action-returned','action-uncertain'].includes(d.event))return {...base,view:'updates',title:({'action-started':'Action started','action-returned':'Tool returned','action-uncertain':'Outcome unknown'})[d.event],text:[actionLabel(d.tool),id(d.action),d.event==='action-returned'?'Tool status: '+id(d.receiptStatus)+'. This does not verify task completion.':''].filter(Boolean).join(' · ')};
 if(d.type==='planning.reassessment'&&typeof d.reviewReason==='string')return {...base,view:'updates',title:'Outcome review',text:d.reviewReason};
 if(d.type==='tool.result'||d.type==='item'&&['dynamicToolCall','commandExecution','fileChange','mcpToolCall'].includes(item.type)){
  let args=item.arguments;try{if(typeof args==='string'&&args.length<24000)args=JSON.parse(args);}catch{args=null;}
  const metadata={tool:id(d.tool||d.name||item.tool||item.name||item.type)||'Tool',action:id(d.action||args?.action),stage:id(d.stage),status:id(d.status||item.status),...(typeof d.success==='boolean'?{success:d.success}:typeof item.success==='boolean'?{success:item.success}:{}),callId:id(d.callId||item.callId||item.id),code:id(d.code)};
  return {...base,view:'tools',title:metadata.tool+(metadata.action?' / '+metadata.action:''),text:JSON.stringify(metadata,null,2)};
 }
 // Unknown events, model reasoning, prompts and raw structured payloads are
 // not promoted into the public update or tool metadata projection.
 return null;
}

/** Human-only searchable failure history across the selected conversation.
 * Task scoping is enforced by the caller and repeated here before projection.
 * Only already allowlisted receipts cross this boundary.
 */
export function searchTaskFailures(family,input={}){
 const query=activityQuery({...input,view:'failures'});
 const root=family?.rootId||family?.taskId;
 if(typeof root!=='string'||!root||!Array.isArray(family?.runs))throw fail('Select an existing conversation.');
 const items=[];
 let recordedFailures=0,omittedFailures=0,retainedEvents=0,omittedEvents=0,hasUnknownOmissions=false;
 for(const run of family.runs){
   if((run?.taskId||run?.id)!==root)continue;
   const saved=projectToolFailureHistory(run.toolFailureHistory);
   if(saved){recordedFailures+=saved.total;omittedFailures+=saved.omitted;}
   else hasUnknownOmissions=true;
   retainedEvents+=Array.isArray(run.events)?run.events.length:0;
   if(Number.isSafeInteger(run.eventRetention?.omittedEvents))omittedEvents+=run.eventRetention.omittedEvents;
   for(let offset=0;;){
     const page=searchRunActivity(run,{view:'failures',offset,limit:50});
     for(const row of page.items)items.push({...row,id:run.id+':'+row.id,runId:run.id,source:row.source+' · turn '+run.id});
     if(page.nextOffset===null)break;
     offset=page.nextOffset;
   }
 }
 items.sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0)||b.id.localeCompare(a.id));
 const revision=hash([root,items,recordedFailures,omittedFailures,family.runs.map(run=>[run.id,run.updatedAt])]);
 if(query.revision&&revision!==query.revision)throw Object.assign(Error('Tool failure receipts changed. Refresh the search.'),{code:'ACTIVITY_CHANGED',status:409});
 const filtered=query.q?items.filter(row=>(row.title+'\n'+row.text+'\n'+row.runId).toLocaleLowerCase().includes(query.q)):items;
 return{runId:input.runId||family.runs.at(-1)?.id||root,taskId:root,view:'failures',scope:'task',revision,
   items:filtered.slice(query.offset,query.offset+query.limit),offset:query.offset,
   nextOffset:query.offset+query.limit<filtered.length?query.offset+query.limit:null,totalMatches:filtered.length,
   coverage:{scope:'Saved tool-failure receipts across this conversation, newest first.',recordedFailures,omittedFailures,
     retainedEvents,omittedEvents,details:hasUnknownOmissions?'Some legacy turns have no saved failure history; their event-only records may be incomplete.':'Individual failures remain searchable after event pruning; no raw arguments or tool payloads are included.'}};
}

export function searchRunActivity(run,input={}){
 const query=activityQuery(input),events=Array.isArray(run.events)?run.events:[],history=query.view==='failures'?projectToolFailureHistory(run.toolFailureHistory):null;
 const revision=hash([query.view==='failures'?history:events,run.error,run.updatedAt]);
 if(query.revision&&query.revision!==revision)throw Object.assign(Error('Activity changed. Refresh to search the current retained records.'),{code:'ACTIVITY_CHANGED',status:409});
 const recorded=history?history.receipts.map(row=>({
   id:'failure:'+row.sequence,view:'failures',title:[row.tool,row.action].filter(Boolean).join(' / '),
   text:JSON.stringify({code:row.code,at:row.at,state:row.recovered?'recovered':'unresolved',
     ...(typeof row.actionDispatched==='boolean'?{actionDispatched:row.actionDispatched}:{}),
     ...(typeof row.inputDispatched==='boolean'?{inputDispatched:row.inputDispatched}:{}),
     ...(Number.isInteger(row.exitCode)?{exitCode:row.exitCode}:{})},null,2),
   at:row.at,nodeId:row.nodeId,source:'saved failure receipt'
 })) : query.view==='failures'
   ? events.filter(event=>event?.data?.type==='tool.result'&&event.data.success===false).map(projectActivityEvent).filter(Boolean).map(row=>({...row,view:'failures',source:'retained event (legacy)'}))
   : events.map(projectActivityEvent);
 const rows=recorded.filter(row=>row&&row.view===query.view&&(!query.q||(row.title+'\n'+row.text).toLocaleLowerCase().includes(query.q)));
 if(query.view==='updates'&&typeof run.error==='string'&&(!query.q||run.error.toLocaleLowerCase().includes(query.q)))rows.push({id:'run-error',view:'updates',title:'Run error',text:text(run.error),at:run.updatedAt,source:'saved run status'});
 rows.reverse();
 return {runId:run.id,view:query.view,revision,items:rows.slice(query.offset,query.offset+query.limit).map(row=>({...row,text:text(row.text),truncated:row.text.length>24000})),offset:query.offset,nextOffset:query.offset+query.limit<rows.length?query.offset+query.limit:null,totalMatches:rows.length,
 coverage:{scope:query.view==='failures'&&history?'Newest saved tool failures first; independent of pruned events.':'Newest retained events first; not complete execution history.',retainedEvents:events.length,omittedEvents:Number.isSafeInteger(run.eventRetention?.omittedEvents)?run.eventRetention.omittedEvents:null,recordedFailures:history?.total??null,omittedFailures:history?.omitted??null,details:query.view==='failures'?'Failures contain bounded metadata, not raw payloads or arguments.': 'Tool calls show metadata, not full arguments or results. Private reasoning is excluded.'}};
}
