import {createHash} from 'node:crypto';
import {listShadowdancerContext,readShadowdancerFile} from './shadowdancer-context.mjs';
const fail=message=>Object.assign(Error(message),{code:'ACTIVITY_QUERY',status:400});
const text=(value,max=24000)=>typeof value==='string'?value.slice(0,max):'';
const id=value=>text(value,120);
const actionLabel=tool=>({relay_directory_context:'Saved evidence',relay_browser:'Browser',relay_history:'Saved history'})[tool]||'Tool';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=(value,names)=>Object.fromEntries(names.filter(key=>typeof value?.[key]==='string').map(key=>[key,value[key]]));
export function activityQuery({view='updates',q='',offset=0,limit=30,revision}={}){
 if(!['updates','tools','internal'].includes(view)||typeof q!=='string'||q.length>200||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('Use Updates, Tool calls or Internal outputs, a search of at most 200 characters, and a bounded page.');
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
export function searchRunActivity(run,input={}){
 const query=activityQuery(input),events=Array.isArray(run.events)?run.events:[],revision=hash([events,run.error,run.updatedAt]);
 if(query.revision&&query.revision!==revision)throw Object.assign(Error('Activity changed. Refresh to search the current retained records.'),{code:'ACTIVITY_CHANGED',status:409});
 const rows=events.map(projectActivityEvent).filter(row=>row&&row.view===query.view&&(!query.q||(row.title+'\n'+row.text).toLocaleLowerCase().includes(query.q)));
 if(query.view==='updates'&&typeof run.error==='string'&&(!query.q||run.error.toLocaleLowerCase().includes(query.q)))rows.push({id:'run-error',view:'updates',title:'Run error',text:text(run.error),at:run.updatedAt,source:'saved run status'});
 rows.reverse();
 return {runId:run.id,view:query.view,revision,items:rows.slice(query.offset,query.offset+query.limit).map(row=>({...row,text:text(row.text),truncated:row.text.length>24000})),offset:query.offset,nextOffset:query.offset+query.limit<rows.length?query.offset+query.limit:null,totalMatches:rows.length,
 coverage:{scope:'Newest retained events first; not complete execution history.',retainedEvents:events.length,omittedEvents:Number.isSafeInteger(run.eventRetention?.omittedEvents)?run.eventRetention.omittedEvents:null,details:'Tool calls show metadata, not full arguments or results. Private reasoning is excluded.'}};
}
const outputFile=(file,runId)=>file.startsWith('runs/'+runId+'/')&&/\/(?:output\.json|checkpoints\/\d+\.json)$/.test(file);
function structuredOutput(value){
 const parsed=value?.parsed||value?.report;
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
 // Only explicit work-result and synthesis schemas, never raw provider text,
 // prompts, chain-of-thought, input capsules or arbitrary debug objects.
 if(['complete','incomplete','blocked'].includes(parsed.status))return fields(parsed,['status','nextAction','finding','candidate_answer','uncertainty']);
 if(typeof parsed.answer==='string'&&Array.isArray(parsed.used_refs)&&parsed.used_refs.every(x=>typeof x==='string'))return {answer:parsed.answer,used_refs:parsed.used_refs};
 return null;
}
export async function searchDirectoryOutputs(selected,input={},dependencies={}){
 const query=activityQuery({...input,view:'internal'}),list=dependencies.list||listShadowdancerContext,read=dependencies.read||readShadowdancerFile;
 const historical=(dependencies.run?.events||[]).map(projectActivityEvent).filter(row=>row?.view==='internal').map(row=>({file:row.source,bytes:row.text.length,updatedAt:row.at,row}));
 let listing;
 try{listing=await list(selected);}catch(error){if(error?.code!=='SHADOWDANCER_CONTEXT_NOT_FOUND')throw error;listing={files:[]};}
 const sources=[...historical,...listing.files.filter(row=>outputFile(row.file,selected.runId))],revision=hash(sources.map(x=>[x.file,x.bytes,x.updatedAt,x.row?.sourceHash]));
 if(query.revision&&query.revision!==revision)throw Object.assign(Error('Saved outputs changed. Refresh to search the current records.'),{code:'ACTIVITY_CHANGED',status:409});
 const scanned=sources.slice(query.offset,query.offset+Math.min(query.limit,10)),items=[];let unavailable=0;
 for(const source of scanned){
  if(source.bytes>2*1024*1024){unavailable++;continue;}
  try{if(source.row){const row=source.row;if(!query.q||(row.title+'\n'+row.text).toLocaleLowerCase().includes(query.q))items.push({...row,text:text(row.text),truncated:row.text.length>24000});continue;}
   const record=await read({...selected,file:source.file}),value=structuredOutput(record.value);if(!value)continue;
   const exact=JSON.stringify(value,null,2),title=typeof value.answer==='string'?'Structured synthesis':'Structured work report';
   if(query.q&&!(title+'\n'+source.file+'\n'+exact).toLocaleLowerCase().includes(query.q))continue;
   items.push({id:source.file,view:'internal',title,source:source.file,sourceHash:record.hash,at:source.updatedAt,text:text(exact),truncated:exact.length>24000});
  }catch{unavailable++;}
 }
 return {runId:selected.runId,view:'internal',revision,items,offset:query.offset,nextOffset:query.offset+scanned.length<sources.length?query.offset+scanned.length:null,
 coverage:{scope:'Saved work-result and synthesis JSON plus canonical historical structured messages in this run, searched page by page.',sourceFiles:sources.length,scannedFiles:scanned.length,unavailableFiles:unavailable,details:'Internal outputs are model reports, not verified effects. Prompts, raw provider text and private reasoning are excluded. Files over 2 MiB are not searched here. Other saved records remain in Directory Context.'}};
}
