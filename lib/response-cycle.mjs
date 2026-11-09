import {createHash} from 'node:crypto';
import {aggregateTokenUsage,tokenUsageMeasurement} from '../public/token-usage.mjs';
import {RESPONSE_CYCLE_STAGES,RESPONSE_CYCLE_PIPELINE_VERSION,responseCycleStages,RESPONSE_CYCLE_LIMITS,planningExecutionModeOf,parseResponseCycleResponse,analyticalSubproblem,analyticalSubproblems,sameSubproblemRequest,workflowChildHandoffReady} from '../public/response-cycle-model.mjs';
import {planningNodeSources,planningResponseBody} from '../public/planning-browser-model.mjs';
import {validateTaskAccuracy,deferredOwnerChecks} from '../public/task-viability-model.mjs';
import {validateWorkbenchVerification,assertWorkbenchVerificationBinding,validateWorkbenchControlVerification,verificationCanonical} from './workbench-effect-verification.mjs';
import {planningCycleEvidence} from './planning-invocation.mjs';
import {preparePlanningReviewMedia,loadPlanningReviewMedia,planningMediaSourceId,retainedPlanningCaptures} from './planning-review-media.mjs';
import {planningReviewObservationSources,capturePlanningGuestObservationEvents} from './planning-review-observations.mjs';
import {readContractJournal,contractCompletionStatus} from './planning-contract-runtime.mjs';
import {buildCanonicalCycleEvidence,canonicalContractHash,canonicalOutcomeSummary} from './planning-contract-cycle.mjs';
import {describeHostOperation} from './operation-descriptors.mjs';

const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const fail=(message,code='RESPONSE_CYCLE_BLOCKED',status=409)=>Object.assign(new Error(message),{code,status});
const titleOf=value=>String(value||'Untitled request').replace(/\s+/g,' ').replace(/^[#>*\s]+/,'').trim().slice(0,150);
const requiredText=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.includes('\0')||value.length>max)throw fail(label+' must be nonempty bounded text.','RESPONSE_CYCLE_INVALID',400);return value.trim();};
const refOf=(request,cycle)=>{const plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);return {requestId:request.id,cycleId:cycle.id,nodeId:plan.id,nodeRevision:plan.revision,responseId:plan.response?.id||null};};
const samePlan=(a,b)=>a&&b&&['requestId','nodeId','nodeRevision','responseId'].every(key=>a[key]===b[key]);
const cycleOf=(request,id)=>{const value=request.cycles?.find(item=>item.id===id)||request.responseCycle?.cycles?.find(item=>item.id===id);if(!value)throw fail('Response cycle not found.','RESPONSE_CYCLE_NOT_FOUND',404);return value;};
const actor={type:'host',id:'response-cycle'};
const evidence=(id,title,value,kind='source')=>{const text=typeof value==='string'?value:JSON.stringify(value);return {id,kind,title:title.slice(0,240),text,contentHash:createHash('sha256').update(text).digest('hex')};};
const EXECUTION_CONTEXT_CHARS=240000,EXECUTION_TEXT_CHARS=96000,EXECUTION_OUTPUT_CHARS=12000;
// This definition is supplied by the host before Planning. An actor cannot
// defer an arbitrary guest criterion by attaching ownership assertions to it.
export const HOST_CONTROL_CRITERION=Object.freeze({id:'host-control-restoration',label:'Human VM control restored',description:'The host observes USER ownership after this run returns its authorized VM control, with the enabled sharing features restored.',verification:'effect'});
const hostControlCriterion=value=>{
  if(!value||Object.keys(value).some(key=>!Object.hasOwn(HOST_CONTROL_CRITERION,key)&&key!=='accuracy')||Object.keys(HOST_CONTROL_CRITERION).some(key=>value[key]!==HOST_CONTROL_CRITERION[key]))return false;
  try{validateTaskAccuracy(value.accuracy);return true;}catch{return false;}
};
const handoffContractSource=cycle=>evidence('cycle:handoff-contract:'+cycle.id,'Host-owned VM handback obligation',{version:1,criterion:HOST_CONTROL_CRITERION,instruction:'If this task requires claiming AGENT control, include this exact host-owned criterion in the Plan. A read-only task that never claims control needs no synthetic handoff or control claim. Use this ID only for final host control restoration. Keep all requested guest installation/configuration outcomes as separate effect criteria verified before handback; do not duplicate future control restoration under another criterion. Only this host-owned criterion may be deferred until after return_user_control.'});
const executionHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function executionText(value,budget,metadata={}){
  const text=typeof value==='string'?value:'',length=text.length;
  const render=count=>{
    const ranges=[];
    if(count>=length)ranges.push({start:0,end:length,text});
    else if(count>0){
      const head=Math.ceil(count/2),tail=Math.floor(count/4),middle=count-head-tail,start=Math.max(head,Math.floor((length-middle)/2));
      for(const [from,size]of [[0,head],[start,middle],[length-tail,tail]])if(size)ranges.push({start:from,end:from+size,text:text.slice(from,from+size)});
    }
    return {...metadata,length,truncated:count<length,ranges};
  };
  const full=render(length);if(JSON.stringify(full).length<=budget)return full;
  let low=0,high=Math.min(length,Math.max(0,budget));
  while(low<high){const middle=Math.ceil((low+high)/2);if(JSON.stringify(render(middle)).length<=budget)low=middle;else high=middle-1;}
  const result=render(low);return JSON.stringify(result).length<=budget?result:null;
}
function executionParts(record,index,call){
  const parts=[],add=(path,value,extra={})=>{if(typeof value==='string'&&value)parts.push({record:index,path,value,...extra});};
  if(record.tool==='relay_browser'&&record.success===true&&Array.isArray(record.reviewObservation?.frames)){
    const {url,title,documentId,frames}=record.reviewObservation;
    call.documents.push({record:index,url,title,documentId,visibleText:frames.map(frame=>({
      frameIndex:frame.index,length:frame.length,retainedPrefixLength:frame.text.length,sourceTruncated:frame.sourceTruncated
    }))});
    for(const [frameIndex,frame]of frames.entries())add('/reviewObservation/frames/'+frameIndex+'/text',frame.text,{kind:'visible-text'});
    call.records[index].browserSnapshot=true;
  }
  const returned=(path,value)=>{
    let parsed;try{parsed=JSON.parse(value);}catch{}
    if(parsed&&typeof parsed==='object'&&Array.isArray(parsed.frames)){
      const fields=Object.fromEntries(['url','title','success','status','code','error','message'].filter(key=>parsed[key]!==undefined).map(key=>{
        const text=typeof parsed[key]==='string'?parsed[key]:JSON.stringify(parsed[key]);
        return [key,text.length<=2000?parsed[key]:{length:text.length,sha256:executionHash(text),truncated:true}];
      }));
      call.documents.push({record:index,...fields});
      for(const key of ['error','message'])if(parsed[key]!==undefined)add(path+'#/'+key,typeof parsed[key]==='string'?parsed[key]:JSON.stringify(parsed[key]),{kind:key});
      for(const [frameIndex,frame]of parsed.frames.entries()){
        if(!frame||typeof frame!=='object')continue;
        for(const [elementIndex,element]of (Array.isArray(frame.elements)?frame.elements:[]).entries())if(['status','alert'].includes(element?.role))add(path+'#/frames/'+frameIndex+'/elements/'+elementIndex+'/name',element.name,{role:element.role});
        add(path+'#/frames/'+frameIndex+'/text',frame.text,{kind:'visible-text'});
      }
      call.records[index].browserSnapshot=true;
    }else add(path,value);
  };
  for(const [key,items]of [['contentItems',record.contentItems],['content',record.content],['result/content',record.result?.content]])if(Array.isArray(items))for(const [part,item]of items.entries()){
    if(typeof item?.text==='string')returned('/'+key+'/'+part+'/text',item.text);
    else if(item&&typeof item==='object')call.records[index].omittedMedia=(call.records[index].omittedMedia||0)+1;
  }
  for(const key of ['aggregatedOutput','output','stdout','stderr','message'])add('/'+key,record[key],{...(key==='message'?{kind:'message'}:{})});
  if(record.error!==undefined)add('/error',typeof record.error==='string'?record.error:JSON.stringify(record.error),{kind:'error'});
  if(record.result!==undefined&&!Array.isArray(record.result?.content))returned('/result',typeof record.result==='string'?record.result:JSON.stringify(record.result));
  if(record.changes!==undefined)add('/changes',JSON.stringify(record.changes));
  return parts;
}
export function executionProjection(run,cycleId,outputs,{output,reservedContextChars=0}={}){
  if(!Number.isSafeInteger(reservedContextChars)||reservedContextChars<0)throw fail('The reserved verification context budget is invalid.','RESPONSE_CYCLE_CONTEXT_BUDGET',400);
  const projectionBudgetChars=Math.max(0,EXECUTION_CONTEXT_CHARS-reservedContextChars);
  const nodes=[],groups=new Map();let rawChars=0,receiptCount=0,omittedArguments=0;
  for(const item of outputs){
    const output=typeof item.output==='string'?item.output:'';
    nodes.push({nodeId:item.nodeId,title:item.title,status:item.status,reused:Boolean(item.reused),outputSha256:executionHash(output),outputLength:output.length,output:null,_output:output});
    for(const event of item.toolReceipts||[]){
      const data=event?.data||event,record=data?.type==='item'&&data.item?data.item:data,raw=JSON.stringify(event),callId=data.callId??record.callId??record.id??null;
      let args=record.arguments;if(typeof args==='string')try{args=JSON.parse(args);}catch{args=null;}
      const key=JSON.stringify([item.nodeId,callId??'receipt-'+receiptCount]);let group=groups.get(key);
      if(!group){group={call:{nodeId:item.nodeId,callId,tool:record.tool||record.name||record.type,action:record.action||args?.action||args?.method,records:[],documents:[],observations:[]},parts:[]};groups.set(key,group);}
      group.call.action??=record.action||args?.action||args?.method;
      const call=group.call,index=call.records.length,reference={sha256:executionHash(raw),length:raw.length,type:record.type||data.type,
        ...Object.fromEntries(['status','success','code','exitCode'].filter(field=>record[field]!==undefined).map(field=>[field,clone(record[field])])),
        ...Object.fromEntries(['threadId','turnId','stage','duringSettlement'].filter(field=>data[field]!==undefined).map(field=>[field,clone(data[field])])),...(event.at?{at:event.at}:{})};
      if(record.arguments!==undefined)omittedArguments++;
      call.records.push(reference);group.parts.push(...executionParts(record,index,call));rawChars+=raw.length;receiptCount++;
    }
  }
  for(const group of groups.values()){group.call.observationCount=group.parts.length;group.call.omittedObservationCount=group.parts.length;}
  const singleAnswer=outputs.length===1&&typeof outputs[0].output==='string'?outputs[0].output:null;
  const candidateAnswer=singleAnswer??(typeof output==='string'?output:'');
  const originalRequest=typeof run.viability?.baseInput==='string'?run.viability.baseInput:typeof run.input==='string'?run.input:'';
  const userDelivery={recipient:'original-user',objective:executionText(originalRequest,6000),
    candidateAnswer:executionText(candidateAnswer,EXECUTION_OUTPUT_CHARS),
    candidateAnswerIsUnverified:true,
    candidateSourceNodeIds:outputs.filter(item=>typeof item.output==='string'&&item.output).map(item=>item.nodeId)};
  const calls=[...groups.values()].map(group=>group.call),projection={version:1,maxContextChars:EXECUTION_CONTEXT_CHARS,reservedContextChars,projectionBudgetChars,textBudgetChars:EXECUTION_TEXT_CHARS,outputBudgetChars:EXECUTION_OUTPUT_CHARS,userDelivery,
    rawReceiptChars:rawChars,receiptRecordCount:receiptCount,callCount:calls.length,originalRecords:{runId:run.id,toolRecords:'events',workerOutputs:'nodes[].output'},
    omittedArguments,browserSnapshotProjection:{kept:['URL/title and returned status/errors','status/alert names','visible frame text ranges'],omitted:['tab/browser inventories','other element attributes','other browser snapshot fields']},provenanceTables:{},truncated:omittedArguments>0};
  // Intern repeated provenance only when it saves space. Ref indexes name exact
  // strings in the manifest; each original event still has its own hash/status.
  for(const field of ['threadId','turnId','at']){
    const counts=new Map();for(const call of calls)for(const record of call.records)if(typeof record[field]==='string')counts.set(record[field],(counts.get(record[field])||0)+1);
    const values=[...counts].filter(([value,count])=>count>=3&&value.length>12).map(([value])=>value);
    if(values.length){projection.provenanceTables[field]=values;const indexes=new Map(values.map((value,index)=>[value,index]));for(const call of calls)for(const record of call.records)if(indexes.has(record[field])){record[field+'Ref']=indexes.get(record[field]);delete record[field];}}
  }
  let remainingOutput=EXECUTION_OUTPUT_CHARS;
  for(const [index,node]of nodes.entries()){
    node.output=executionText(node._output,Math.floor(remainingOutput/(nodes.length-index)));
    remainingOutput-=JSON.stringify(node.output).length;delete node._output;
    if(!node.output||node.output.truncated)projection.truncated=true;
  }
  // Repeated observations share exact text, not inferred meaning. Every call
  // keeps its own original-record and path alias, including later status/errors.
  const paths=[],pathIndexes=new Map(),shared=new Map();
  const priority=part=>part.role||part.kind==='error'?0:part.kind==='visible-text'?1:2;
  for(const group of groups.values()){
    const call=group.call,hasRich=group.parts.some(part=>call.records[part.record].type!=='tool.result');
    const parts=group.parts.filter(part=>!(hasRich&&call.records[part.record].type==='tool.result'&&call.records[part.record].success===true&&part.kind==='message'));
    parts.sort((a,b)=>priority(a)-priority(b)||(a.kind==='visible-text'&&b.kind==='visible-text'?b.value.length-a.value.length:0));
    const selected=parts.slice(0,16);call.omittedObservationCount=group.parts.length-selected.length;
    for(const part of selected){
      if(!pathIndexes.has(part.path)){pathIndexes.set(part.path,paths.length);paths.push(part.path);}
      if(!shared.has(part.value))shared.set(part.value,{id:'text-'+shared.size,value:part.value,priority:priority(part)});
      const entry=shared.get(part.value);entry.priority=Math.min(entry.priority,priority(part));
      call.observations.push({record:part.record,pathRef:pathIndexes.get(part.path),textRef:entry.id,...(part.role?{role:part.role}:{})});
    }
    if(call.omittedObservationCount||call.records.some(record=>record.omittedMedia||record.browserSnapshot))projection.truncated=true;
  }
  projection.pathTable=paths;projection.sharedTextCount=shared.size;
  // Keep each raw receipt's hash, length and time local. Repeated status and
  // runtime identity fields share an exact object, without changing its values.
  const receiptMetadata=new Map();
  for(const call of calls)for(const record of call.records){
    const metadata=Object.fromEntries(Object.entries(record).filter(([key])=>!['sha256','length','at','atRef'].includes(key))),key=JSON.stringify(metadata);
    if(!receiptMetadata.has(key))receiptMetadata.set(key,{metadata,records:[]});
    receiptMetadata.get(key).records.push(record);
  }
  projection.receiptMetadataTable=[];
  for(const [encoded,group]of receiptMetadata)if(group.records.length>=2&&(group.records.length-1)*encoded.length>group.records.length*24){
    const metadataRef=projection.receiptMetadataTable.length;projection.receiptMetadataTable.push(group.metadata);
    for(const record of group.records){for(const key of Object.keys(group.metadata))delete record[key];record.metadataRef=metadataRef;}
  }
  const entries=[...shared.values()].map(entry=>({...entry,base:{id:entry.id,length:entry.value.length,truncated:true,ranges:[]}}));
  // Count all references and empty text descriptors before allocating content.
  // This leaves no dangling reference even when an excerpt has no usable range.
  const metadataChars=JSON.stringify({nodes,calls,projection,texts:entries.map(entry=>entry.base)}).length;
  projection.metadataChars=metadataChars;
  // Immutable criterion proofs share the same final-review context. Reserve
  // their exact text lengths before allocating lossy observation excerpts;
  // neither proofs nor receipt identities/status/provenance may be shortened.
  const textAllowance=Math.min(EXECUTION_TEXT_CHARS,Math.max(0,projectionBudgetChars-metadataChars-8192));let remaining=textAllowance;
  projection.availableTextBudgetChars=textAllowance;
  const weight=entry=>Math.sqrt(Math.min(entry.value.length,8000));
  entries.sort((a,b)=>a.priority-b.priority||Number(a.value.length>128)-Number(b.value.length>128));
  let remainingWeight=entries.reduce((sum,entry)=>sum+weight(entry),0);const texts=[];
  for(const entry of entries){
    const baseSize=JSON.stringify(entry.base).length,full=executionText(entry.value,entry.value.length*6+1000,{id:entry.id}),fullCost=JSON.stringify(full).length-baseSize;
    const share=Math.floor(remaining*weight(entry)/Math.max(1,remainingWeight));
    const allowance=Math.min(6000,remaining,(fullCost<=256||entry.priority===0&&fullCost<=1024)?fullCost:share);
    const observed=executionText(entry.value,baseSize+allowance,{id:entry.id})||entry.base;
    texts.push(observed);remaining-=Math.max(0,JSON.stringify(observed).length-baseSize);remainingWeight-=weight(entry);
    if(observed.truncated)projection.truncated=true;
  }
  projection.projectedTextChars=textAllowance-remaining;
  const manifest={version:1,runId:run.id,projection,nodes,note:(!nodes.length?'No operational output was recorded. ':'')+'A receipt metadataRef indexes projection.receiptMetadataTable; merge those exact fields with the receipt before reading its status or provenance. Each observation pathRef indexes projection.pathTable; textRef names an exact shared texts[].id across these source records. Tool observations retain their original status and provenance. A successful call alone does not verify an external effect. Excerpts and hashes do not establish omitted content; original records remain in the saved run.'};
  const bodies=[],pack=(key,rows,extra={})=>{
    let body={version:1,runId:run.id,...extra,[key]:[]};
    for(const row of rows){
      const next={...body,[key]:[...body[key],row]};
      if(JSON.stringify(next).length>36000){if(!body[key].length)return false;bodies.push(body);body={version:1,runId:run.id,[key]:[row]};if(JSON.stringify(body).length>36000)return false;}
      else body=next;
    }
    if(body[key].length||Object.keys(extra).length)bodies.push(body);return true;
  };
  const {nodes:nodeRows,...header}=manifest;
  const packed=pack('nodes',nodeRows,header)&&pack('calls',calls)&&pack('texts',texts);
  const limited=!packed||bodies.reduce((sum,body)=>sum+JSON.stringify(body).length,0)>projectionBudgetChars;
  if(limited){
    projection.truncated=true;projection.reviewLimited=true;projection.omittedCallCount=calls.length;
    projection.callIndex={sha256:executionHash(calls),length:JSON.stringify(calls).length};
    projection.omittedTables={paths:{count:paths.length,sha256:executionHash(paths)},provenance:{sha256:executionHash(projection.provenanceTables)},receiptMetadata:{count:projection.receiptMetadataTable.length,sha256:executionHash(projection.receiptMetadataTable)}};
    delete projection.pathTable;delete projection.provenanceTables;delete projection.receiptMetadataTable;
    bodies.length=0;
    const kept=nodes.slice(0,16).map(node=>({...node,output:executionText(outputs.find(item=>item.nodeId===node.nodeId)?.output||'',600)}));
    projection.omittedNodeCount=nodes.length-kept.length;
    bodies.push({version:1,runId:run.id,projection,nodes:kept,note:'The receipt identity index exceeded the bounded evaluation context. The analytical review was not performed. The original run outputs and tool observations remain available by their run, node and call identities.'});
  }
  return {limited,records:bodies.map((body,index)=>evidence('cycle:execution:'+cycleId+':projection:'+index,'Observed workflow results'+(index?' · part '+(index+1):''),body,'tool_receipt'))};
}
export function recordedExecutionOutputs(run){
  return run.workflow.nodes.filter(node=>node.type==='agent').map(node=>({nodeId:node.id,title:node.name,status:run.nodes[node.id].status,
    output:run.nodes[node.id].output||'',reused:run.nodes[node.id].reused===true,
    toolReceipts:run.events.filter(event=>event.nodeId===node.id&&(event.data?.type==='tool.result'||event.data?.type==='item'&&
      ['dynamicToolCall','commandExecution','fileChange','mcpToolCall'].includes(event.data.item?.type)&&
      (event.data.stage==='completed'||event.data.item.status==='completed'))).map(clone)}));
}
function executionReviewContext(run,request,cycle,outputs,{output=run.output,mediaSource=null,canonical=null}={}){
  const retainedReceipts=(cycle.effectReceipts||[]).filter(receipt=>!receipt.canonicalContract&&receipt.runId===run.id&&samePlan(receipt.planRef,refOf(request,cycle))&&
    receipt.planRef.cycleId===cycle.id&&request.sources.some(source=>source.id===receipt.sourceId&&source.contentHash===receipt.proofSha256)),
    effectReceipts=[...retainedReceipts,...(canonical?.effectReceipts||[])],
    proofSources=[...request.sources.filter(source=>retainedReceipts.some(receipt=>receipt.sourceId===source.id)).map(source=>evidence(source.id,source.title,source.text,source.kind)),...(canonical?.sources||[])],
    visualSources=mediaSource?[mediaSource]:[],plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan),
    observations=planningReviewObservationSources({run,planRef:refOf(request,cycle),planCompletedAt:plan.response?.provenance?.at}),
    projected=executionProjection(run,cycle.id,outputs,{output,reservedContextChars:[...proofSources,...visualSources,...observations.records].reduce((sum,source)=>sum+source.text.length,0)});
  return {projected,effectReceipts,proofSources,reviewContext:observations.manifest,observationSources:observations.records,records:[...projected.records,...proofSources,...visualSources,...observations.records]};
}
function projectionIdentity(sources){
  const bodies=sources.map(source=>JSON.parse(source.text)),header=bodies.find(body=>body.projection),calls=bodies.flatMap(body=>body.calls||[]);
  return {callsHash:header?.projection?.reviewLimited?header.projection.callIndex?.sha256:executionHash(calls.map(call=>({nodeId:call.nodeId,callId:call.callId,tool:call.tool,action:call.action,records:call.records.map(({sha256,length})=>({sha256,length}))}))),
    nodes:bodies.flatMap(body=>body.nodes||[]).map(({output,...identity})=>identity)};
}
const profileFields=['model','effort','serviceTier'];
const effortValues=new Set(['default','none','minimal','low','medium','high','xhigh','max','ultra']);
const profileInput=value=>{
  const result={};
  if(value.model!==undefined)result.model=requiredText(value.model,'Cycle model',500);
  if(value.effort!==undefined){if(!effortValues.has(value.effort))throw fail('Choose a supported reasoning effort.','RESPONSE_CYCLE_PROFILE_INVALID',400);result.effort=value.effort;}
  if(value.serviceTier!==undefined){if(!['default','fast'].includes(value.serviceTier))throw fail('Choose Standard or Fast service.','RESPONSE_CYCLE_PROFILE_INVALID',400);result.serviceTier=value.serviceTier;}
  return result;
};

/** Five bounded stages, recursive handoffs, and an explicit caller-neutral plan-only boundary. */
export class ResponseCycleService{
  constructor({store,runner,taskViability,engine,conversations,getSettings=()=>({}),onUpdated=()=>{}}={}){
    if(!store?.runtimeWriter||!runner?.start)throw fail('Response cycles need the Planning store and response runtime.','RESPONSE_CYCLE_CONFIG',500);
    Object.assign(this,{store,runner,taskViability,engine,conversations,getSettings,onUpdated});
    this.writer=store.runtimeWriter();this.queues=new Map();this.cycleRuns=new Map();this.runBindings=new Map();this.closed=false;
    this.reviewMediaResolver=(attempt,options)=>this.resolveReviewMedia(attempt,options);this.runner.resolveReviewMedia=this.reviewMediaResolver;
    this.usageUpdates=new Map();this.runtimeUsageListener=event=>this.queueLiveUsageRefresh(event);this.runner.on?.('updated',this.runtimeUsageListener);
  }
  serialize(id,work){
    if(this.closed)return Promise.reject(fail('Response cycles are closed.','RESPONSE_CYCLE_CLOSED',503));
    const next=(this.queues.get(id)||Promise.resolve()).catch(()=>{}).then(work);this.queues.set(id,next);
    next.finally(()=>{if(this.queues.get(id)===next)this.queues.delete(id);}).catch(()=>{});return next;
  }
  updated(request){try{this.onUpdated({type:'planning.browser.updated',at:new Date().toISOString(),data:{requestId:request.id,revision:request.revision,conversationId:request.conversationId}});}catch{}return request;}
  reviewWorkspace(){return this.engine?.workbench?.config?.folders?.find(item=>item.id==='workspace'&&item.readWrite===true)?.hostPath;}
  async reviewRun(request,cycle){
    const id=cycle.execution?.runId||cycle.linkedRunId;let run;
    try{run=this.engine?.getRun?.(id);}catch{}
    if(!run)run=await this.conversations?.get?.(id);
    if(!run||run.id!==id||run.responseCycle?.requestId!==request.id||run.responseCycle?.cycleId!==cycle.id||!samePlan(run.responseCycle?.planRef,refOf(request,cycle))||run.responseCycle.planRef.cycleId!==cycle.id)throw fail('The visual evidence no longer matches its adopted execution.','PLANNING_MEDIA_BINDING');
    return run;
  }
  async reviewMediaSource(run,request,cycle,{signal}={}){
    signal?.throwIfAborted();
    return preparePlanningReviewMedia({run,planRef:refOf(request,cycle),workspace:this.reviewWorkspace(),assertCurrent:()=>signal?.throwIfAborted()});
  }
  async resolveReviewMedia(attempt,{signal}={}){
    if(!['think','respond'].includes(attempt.node?.kind)||!attempt.node?.cycleId)return null;
    const source=attempt.sources.find(item=>item.id===planningMediaSourceId(attempt.node.cycleId));if(!source)return null;
    const request=await this.store.get(attempt.requestId),cycle=cycleOf(request,attempt.node.cycleId),node=request.nodes.find(item=>item.id===attempt.nodeId);
    if(node?.revision!==attempt.nodeRevision||cycle.stageNodeIds[attempt.node.kind]!==attempt.nodeId||!['completed','failed','cancelled','unknown'].includes(cycle.execution?.state)||request.sources.find(item=>item.id===source.id)?.contentHash!==source.contentHash)throw fail('The captured visual-review inputs changed before delivery.','PLANNING_MEDIA_BINDING');
    const planRef=refOf(request,cycle),plan=request.nodes.find(item=>item.id===planRef.nodeId);
    if(!attempt.inputs?.some(item=>item.nodeId===plan.id&&item.responseId===plan.response?.id&&item.responseRevision===plan.response?.revision))throw fail('Visual review requires the captured current Plan input.','PLANNING_MEDIA_BINDING');
    const run=await this.reviewRun(request,cycle),workspace=this.reviewWorkspace();
    const media=await loadPlanningReviewMedia({run,planRef,workspace,source,assertCurrent:()=>signal?.throwIfAborted()});
    const latest=await this.store.get(attempt.requestId),current=cycleOf(latest,cycle.id),currentRun=await this.reviewRun(latest,current);
    signal?.throwIfAborted();
    if(this.reviewWorkspace()!==workspace||latest.nodes.find(item=>item.id===attempt.nodeId)?.revision!==attempt.nodeRevision||!samePlan(planRef,refOf(latest,current))||latest.sources.find(item=>item.id===source.id)?.contentHash!==source.contentHash)throw fail('Visual-review inputs changed while the retained image was read. No provider turn was started.','PLANNING_MEDIA_BINDING');
    const captures=retainedPlanningCaptures(currentRun,planRef).selected.map(item=>item.descriptor);
    if(media.delivery.images.some(image=>!captures.some(item=>Object.keys(item).every(key=>item[key]===image[key]))))throw fail('The captured execution changed while its image was read. No provider turn was started.','PLANNING_MEDIA_BINDING');
    return media;
  }
  verificationContext(run,request,{allowEmpty=false}={}){
    const adopted=run.responseCycle?.planRef||run.viability?.planRef,cycleId=run.responseCycle?.cycleId||adopted?.cycleId;
    if(!adopted||!cycleId||run.planningMode==='off')throw fail('Observed-effect verification needs the current adopted plan.','WORKBENCH_EFFECT_PLAN_REQUIRED');
    const cycle=cycleOf(request,cycleId),plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan),planRef=refOf(request,cycle);
    if(!samePlan(adopted,planRef)||adopted.cycleId!==planRef.cycleId||!plan.readiness.cycle?.analysisReady||cycle.linkedRunId&&cycle.linkedRunId!==run.id)throw fail('The adopted plan changed before effect verification.','RESPONSE_CYCLE_PLAN_CONFLICT');
    const criteria=clone(plan.response.acceptanceCriteria.filter(item=>item.verification==='effect'));
    if(this.handoffBinding(run,request,cycle,planRef)){
      const reserved=plan.response.acceptanceCriteria.find(item=>item.id===HOST_CONTROL_CRITERION.id);
      if(reserved&&!hostControlCriterion(reserved))throw fail('The reserved host control obligation cannot be renamed or used for a guest outcome.','WORKBENCH_HOST_CONTROL_CONTRACT_CONFLICT');
      // This is a host obligation bound to the adopted Plan, not invented model
      // acceptance. Omitting it from the response cannot disable restoration.
      if(!reserved)criteria.push(clone(HOST_CONTROL_CRITERION));
    }
    if(!criteria.length&&!allowEmpty)throw fail('The adopted plan has no effect criteria to verify.','WORKBENCH_EFFECT_PLAN_REQUIRED');
    return {planRef,criterionIds:criteria.map(item=>item.id),criteria};
  }
  async getExecutionPlan(run){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId,adopted=run.responseCycle?.planRef||run.viability?.planRef;
    if(!requestId||!adopted)throw fail('Execution refinement needs the current adopted Plan.','TASK_PLAN_HANDOFF_SOURCE_REQUIRED');
    return this.serialize(requestId,async()=>{
      const request=await this.store.get(requestId),cycle=cycleOf(request,adopted.cycleId),plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan),planRef=refOf(request,cycle);
      if(!samePlan(adopted,planRef)||adopted.cycleId!==planRef.cycleId||!plan.readiness.cycle?.analysisReady||cycle.linkedRunId&&cycle.linkedRunId!==run.id)
        throw fail('The adopted Plan changed before execution refinement.','RESPONSE_CYCLE_PLAN_CONFLICT');
      const body=planningResponseBody(plan.response);
      return {planRef:clone(planRef),sha256:hash(body),plan:clone(body)};
    });
  }
  async canonicalExecutionEvidence(run,request,{signal}={}){
    if(run.planningContractVersion!==14)return null;
    if(run.workbenchAuthorization)throw fail('This VM task requires its captured legacy verifier contract until its canonical adapter is available.','TASK_CONTRACT_ADAPTER_UNAVAILABLE');
    const tasks=this.engine?.tasks,taskId=run.taskId||run.id,adopted=run.responseCycle?.planRef||run.viability?.planRef;
    if(!tasks?.enqueue||!adopted)throw fail('The current canonical task and accepted Plan are required for final review.','TASK_CONTRACT_CYCLE_BINDING');
    const cycle=cycleOf(request,adopted.cycleId),planRef=refOf(request,cycle),plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);
    if(!samePlan(adopted,planRef)||adopted.cycleId!==planRef.cycleId||cycle.linkedRunId&&cycle.linkedRunId!==run.id)throw fail('The canonical task belongs to a different accepted Plan.','RESPONSE_CYCLE_PLAN_CONFLICT');
    return tasks.enqueue(taskId,async()=>{
      signal?.throwIfAborted();
      const state=(await tasks.load(taskId)).history.at(-1),journal=await readContractJournal(tasks,taskId),completion=contractCompletionStatus(state,journal);
      const canonical=buildCanonicalCycleEvidence({run,taskState:state,journal,planRef,acceptedPlan:planningResponseBody(plan.response),runningOperationIds:completion.runningOperationIds});
      return {...canonical,completion};
    },signal);
  }
  canonicalHandoffReadiness(run,args,canonical){
    const {data,completion,effectReceipts}=canonical;
    if(!['status','final','cancelled'].includes(args.reason)&&!samePlan(args.planRef,data.planRef))throw fail('Read the current exact accepted Plan before declaring handback.','RESPONSE_CYCLE_PLAN_CONFLICT');
    const stopped=args.signal?.aborted===true||run.status==='cancelled';
    const pending=data.criteria.filter(criterion=>!criterion.satisfied).map(criterion=>criterion.id);
    return {ready:stopped||completion.ready===true,complete:!stopped&&data.complete,planRef:data.planRef,
      pendingCriterionIds:pending,deferredCriterionIds:[],eligibleDeferredControlCriteria:[],verifiedReceiptIds:effectReceipts.map(receipt=>receipt.id),
      controlRestorationPending:false,planEpoch:data.planEpoch,journalSeq:data.journalSeq,unresolved:clone(data.unresolved),
      progressKey:canonicalContractHash({
        criteria:data.contract.criteria.map(criterion=>{const observed=data.criteria.find(item=>item.id===criterion.id);return {kind:criterion.kind,resourceKey:criterion.resourceKey||null,targetCount:observed.targetCount,observedCount:observed.observedCount,satisfied:observed.satisfied};}).sort((a,b)=>canonicalContractHash(a).localeCompare(canonicalContractHash(b))),
        outcomes:data.outcomes.map(({resourceKey,outcomeId,status,prior,isNew})=>({resourceKey,outcomeId,status,prior,isNew})).sort((a,b)=>canonicalContractHash(a).localeCompare(canonicalContractHash(b))),
        unresolved:data.unresolved.map(({effectKey,destinationKey,effectState})=>({effectKey:effectKey||null,destinationKey:destinationKey||null,effectState})).sort((a,b)=>canonicalContractHash(a).localeCompare(canonicalContractHash(b))) }),
      ...(!data.complete&&(stopped||completion.ready)?{exitAllowed:true}:{}),
      reason:stopped?'Execution stopped; preserve actual partial results and pending effects.':completion.reason};
  }
  async getVerificationContext(run){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId)throw fail('Observed-effect verification needs a saved plan.','WORKBENCH_EFFECT_PLAN_REQUIRED');
    return this.verificationContext(run,await this.store.get(requestId));
  }
  async supplyExecutionContract(request,cycle,run){
    if(run.planningContractVersion!==14)return request;
    let currentContract=null;
    if(this.engine?.tasks)try{
      const state=await this.engine.tasks.get(run.taskId||run.id);currentContract=state.contract||null;
      if(state.contractAdoption?.planRef?.cycleId===cycle.id){
        if(!request.sources.some(source=>source.id==='cycle:execution-contract:'+cycle.id))throw fail('The original canonical authoring source is missing. Preserve the accepted Plan and its task evidence.','TASK_CONTRACT_CYCLE_BINDING');
        return request;
      }
    }catch(error){if(error.code!=='TASK_STATE_MISSING')throw error;}
    const workspace=await describeHostOperation({name:'relay_workspace',arguments:{action:'list',path:'.'}},{cwd:run.cwd}),
      workspaceResourceKey=workspace.resources.find(resource=>resource.key.startsWith('workspace:'))?.key;
    if(!workspaceResourceKey)throw fail('The task workspace does not have a current host resource identity.','TASK_CONTRACT_RESOURCE_UNAVAILABLE');
    const source=evidence('cycle:execution-contract:'+cycle.id,'Canonical execution contract',{
      taskSchemaVersion:14,contractVersion:2,workspaceResourceKey,initialOwner:'coordinator',currentContract,
      workflow:{coordinatorNodeId:run.workflow?.planning?.coordinatorNodeId||null,agents:(run.workflow?.nodes||[]).filter(node=>node.type==='agent').map(node=>({id:node.id,label:node.name||node.id}))},
      instructions:'Author one canonical contract of bounded work items. The host adopts this exact contract; no second operational outline is authored. Use the supplied workspaceResourceKey for this task folder and exact resource or host ancestor keys for other targets (origin:<URL origin> for a bounded browser destination); discovery permits observations only. Keep cohesive form interactions together. List order is not a prerequisite. Model prose is not outcome evidence; declared external confirmations require actual bound receipt observations. Ordinary audit instructions never create authorization barriers.'
    });
    if(request.sources.find(item=>item.id===source.id)?.contentHash===source.contentHash)return request;
    return this.writer.configureResponseCycle(request.id,{sources:[source]});
  }
  async supplyHandoffContract(request,cycle,run){
    if(run.workbenchAuthorization?.source!=='explicit-user-task'||run.workbenchAuthorization?.scope!=='configured-vm')return request;
    const source=handoffContractSource(cycle);
    if(request.sources.find(item=>item.id===source.id)?.contentHash===source.contentHash)return request;
    return this.writer.configureResponseCycle(request.id,{sources:[source]});
  }
  handoffBinding(run,request,cycle,planRef){
    const bound=run.responseCycle?.handoffContract,source=handoffContractSource(cycle);
    return Boolean(bound&&verificationCanonical(bound.planRef)===verificationCanonical(planRef)&&bound.sourceId===source.id&&bound.sourceHash===source.contentHash&&request.sources.some(item=>item.id===source.id&&item.contentHash===source.contentHash&&item.text===source.text));
  }
  handoffReadiness(run,args,request){
    const context=this.verificationContext(run,request,{allowEmpty:true}),cycle=cycleOf(request,context.planRef.cycleId),auth=run.workbenchAuthorization;
    if(!['status','final'].includes(args.reason)&&verificationCanonical(args.planRef)!==verificationCanonical(context.planRef))throw fail('Read the current exact adopted Plan before declaring handback.','RESPONSE_CYCLE_PLAN_CONFLICT');
    const eligible=this.handoffBinding(run,request,cycle,context.planRef)&&context.criteria.some(hostControlCriterion)?[HOST_CONTROL_CRITERION]:[];
    const verified=[];
    for(const receipt of cycle.effectReceipts||[]){
      if(receipt.state!=='succeeded'||receipt.effectVerified!==true||receipt.runId!==run.id||verificationCanonical(receipt.planRef)!==verificationCanonical(context.planRef))continue;
      const proofSource=request.sources.find(item=>item.id===receipt.sourceId&&item.kind==='tool_receipt'&&item.contentHash===receipt.proofSha256&&createHash('sha256').update(item.text).digest('hex')===item.contentHash);
      if(!proofSource)continue;
      try{
        const proof=JSON.parse(proofSource.text),identity=proof.jobId||proof.verificationId;
        if(proof.runId!==run.id||verificationCanonical(proof.planRef)!==verificationCanonical(context.planRef)||receipt.id!=='effect-'+hash([run.id,identity,receipt.criterionIds?.[0]]).slice(0,40)||receipt.criterionIds?.length!==1||!proof.criterionIds?.includes(receipt.criterionIds[0]))continue;
        if(receipt.sourceId!=='cycle:execution:'+cycle.id+':verification:'+(proof.kind==='host-control-state'?'control-'+proof.verificationId:proof.jobId)||proof.jobId&&receipt.jobId!==proof.jobId||proof.verificationId&&receipt.verificationId!==proof.verificationId)continue;
        const assertions=proof.assertions.map(({actual,passed,...assertion})=>assertion);
        if(proof.kind==='host-control-state'){
          if(!eligible.some(item=>item.id===receipt.criterionIds[0]))continue;
          const live=this.engine?.workbench?.consoleControl?.status();
          validateWorkbenchControlVerification({...proof,assertions},context,live?{owner:live.owner,revision:live.revision,authorizedReturn:auth?.returned===true&&auth.userRevision===live.revision,featuresRestored:auth?.featuresRestored===true&&auth.userRevision===live.revision}:null);
        }else{
          if(receipt.criterionIds.includes(HOST_CONTROL_CRITERION.id))continue;
          const record={...proof,assertions},declaration=assertWorkbenchVerificationBinding(record,run.workbenchVerifications?.[proof.jobId]);
          validateWorkbenchVerification(record,context);
          if(verificationCanonical(declaration)!==verificationCanonical(proof.declaration))continue;
        }
        verified.push(receipt);
      }catch{}
    }
    const deferred=args.deferredControlVerification,declaredIds=deferred?.criterionIds||[];
    const validDeferred=declaredIds.length>0&&declaredIds.every(id=>eligible.some(item=>item.id===id))&&deferred.assertions?.length>0&&deferred.assertions.every(item=>declaredIds.includes(item.criterionId)&&item.operator==='equals'&&((item.path==='control.owner'&&item.expected==='user')||(['control.authorizedReturn','control.featuresRestored'].includes(item.path)&&item.expected===true)))&&declaredIds.every(id=>['control.owner','control.authorizedReturn','control.featuresRestored'].every(path=>deferred.assertions.some(item=>item.criterionId===id&&item.path===path)));
    if(deferred&&!validDeferred)throw fail('Only the exact host-owned restoration criterion can defer its predeclared USER ownership and feature-restoration assertions.','WORKBENCH_HANDOFF_DECLARATION_INVALID');
    const deferredIds=validDeferred?declaredIds:[],satisfied=new Set(verified.flatMap(item=>item.criterionIds));
    const pending=context.criterionIds.filter(id=>!satisfied.has(id)&&!deferredIds.includes(id)&&!(args.reason==='final'&&auth?.consumed!==true&&id===HOST_CONTROL_CRITERION.id&&eligible.length));
    const facts=request.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility)?.readiness.viability?.blockingFacts||[];
    const live=this.engine?.workbench?.consoleControl?.status(),diagnostic=args.evidence,failed=diagnostic?.verified===true&&diagnostic.resolved===false&&typeof diagnostic.callId==='string'&&diagnostic.ownerRevision===live?.revision&&((diagnostic.code==='WORKBENCH_AGENT_UNAVAILABLE'&&diagnostic.prerequisite==='guest_identity_changed')||(diagnostic.code==='WORKBENCH_CONTROL_HELD_BY_USER'&&live?.owner==='user'));
    const blocker=facts.find(fact=>fact.resolution==='blocked'),blocked=args.reason==='blocked'&&Boolean(blocker||failed),cancelled=args.reason==='cancelled'&&args.signal?.aborted===true;
    const controlLost=auth?.consumed===true&&(!live||auth.returned!==true&&(live.owner!=='agent'||live.revision!==auth.agentRevision)||auth.returned===true&&live.revision!==auth.userRevision);
    const priorExit=auth?.returned===true&&['blocked','cancelled','trusted-stalled','trusted-cancelled'].includes(auth.handoff?.reason);
    const stopped=args.reason==='final'&&Boolean(controlLost||priorExit||args.signal?.aborted===true);
    const controlRestorationPending=args.reason==='final'&&auth?.consumed===true&&auth.returned!==true&&live?.owner==='agent'&&live.revision===auth.agentRevision;
    const declarations=Object.values(run.workbenchVerifications||{}).filter(item=>item.status==='declared'&&verificationCanonical(item.planRef)===verificationCanonical(context.planRef)).map(item=>[item.jobId,hash(item)]).sort();
    const jobs=new Map();for(const event of run.events||[]){const item=event.data;if(item?.type==='tool.result'&&item.tool==='relay_workbench'&&['run_guest_script','verify_guest_script','guest_job','cancel_guest_job'].includes(item.action)&&/^[a-f0-9]{32}$/.test(item.jobId||''))jobs.set(item.jobId,[item.jobId,item.status,item.code||null]);}
    return {ready:pending.length===0&&!controlRestorationPending||blocked||cancelled||stopped,planRef:context.planRef,pendingCriterionIds:pending,deferredCriterionIds:deferredIds,eligibleDeferredControlCriteria:clone(eligible),verifiedReceiptIds:verified.map(item=>item.id),controlRestorationPending,progressKey:hash([context.planRef,pending,verified.map(item=>item.id).sort(),controlRestorationPending,declarations,[...jobs.values()].sort()]),...(blocker||failed?{blocker:blocker||diagnostic}:{}),...(blocked||cancelled||stopped?{exitAllowed:true}:{}),reason:blocked?'Concrete current blocker permits an honest incomplete handback.':cancelled||stopped?'Execution stopped or ownership changed; preserve partial results without reclaiming control.':pending.length?'Current adopted-plan effects remain unverified: '+pending.join(', '):controlRestorationPending?'This run still owns VM control; return it after completed effects and verify the actual host restoration.':'Current adopted-plan effect receipts are present. Analytical evidence and final outcome review remain required.'};
  }
  async getHandoffReadiness(run,args={reason:'status'}){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId||!(run.responseCycle?.planRef||run.viability?.planRef))return {ready:true,planRef:null,pendingCriterionIds:[],progressKey:'no-adopted-plan',reason:'No adopted operational Plan is bound.'};
    const request=await this.store.get(requestId),canonical=await this.canonicalExecutionEvidence(run,request,{signal:args.signal?.aborted?undefined:args.signal});
    return canonical?this.canonicalHandoffReadiness(run,args,canonical):this.handoffReadiness(run,args,request);
  }
  async withHandoffReadiness(run,args,dispatch){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId)return dispatch(await this.getHandoffReadiness(run,args));
    return this.serialize(requestId,async()=>{
      if(run.planningContractVersion===14){
        const request=await this.store.get(requestId),canonical=await this.canonicalExecutionEvidence(run,request,{signal:args.signal?.aborted?undefined:args.signal});
        return dispatch(this.canonicalHandoffReadiness(run,args,canonical));
      }
      return this.writer.withViabilityRequest(requestId,request=>dispatch(this.handoffReadiness(run,args,request)));
    });
  }
  async recordVerifiedEffects(run,record,{assertCurrent=()=>{}}={}){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId)throw fail('Observed-effect verification needs a saved plan.','WORKBENCH_EFFECT_PLAN_REQUIRED');
    return this.serialize(requestId,async()=>{
      assertCurrent();const request=await this.store.get(requestId);assertCurrent();
      const context=this.verificationContext(run,request),cycle=cycleOf(request,context.planRef.cycleId);
      if(record.criterionIds?.includes(HOST_CONTROL_CRITERION.id))throw fail('Host control restoration cannot be proved by a guest script.','WORKBENCH_EFFECT_VERIFICATION_INVALID');
      const declaration=assertWorkbenchVerificationBinding(record,run.workbenchVerifications?.[record.jobId]);
      const proof={...validateWorkbenchVerification(record,context),declaration,runId:run.id},sourceId='cycle:execution:'+cycle.id+':verification:'+proof.jobId;
      return this.persistVerifiedEffects(request,cycle,run,proof,sourceId,{assertCurrent});
    });
  }
  async recordVerifiedControlEffects(run,record,{assertCurrent=()=>{}}={}){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId)throw fail('Host-control verification needs a saved plan.','WORKBENCH_EFFECT_PLAN_REQUIRED');
    return this.serialize(requestId,async()=>{
      assertCurrent();const request=await this.store.get(requestId);assertCurrent();
      const context=this.verificationContext(run,request),cycle=cycleOf(request,context.planRef.cycleId),live=this.engine?.workbench?.consoleControl?.status(),auth=run.workbenchAuthorization;
      if(run.responseCycle?.handoffContract&&record.criterionIds?.some(id=>id!==HOST_CONTROL_CRITERION.id))throw fail('Host ownership assertions cannot verify guest installation or configuration criteria.','WORKBENCH_EFFECT_VERIFICATION_INVALID');
      const currentControl=live?{owner:live.owner,revision:live.revision,authorizedReturn:auth?.returned===true&&auth.userRevision===live.revision,featuresRestored:auth?.featuresRestored===true&&auth.userRevision===live.revision}:null;
      let proof={...validateWorkbenchControlVerification(record,context,currentControl),runId:run.id};
      const sourceId='cycle:execution:'+cycle.id+':verification:control-'+proof.verificationId,previous=request.sources.find(source=>source.id===sourceId);
      if(previous){
        const captured=JSON.parse(previous.text);
        // Re-observing unchanged host state does not manufacture a new event.
        // Keep the first captured time; every other declaration field is exact.
        if(verificationCanonical({...captured,observedAt:proof.observedAt})===verificationCanonical(proof))proof=captured;
      }
      return this.persistVerifiedEffects(request,cycle,run,proof,sourceId,{assertCurrent});
    });
  }
  async persistVerifiedEffects(request,cycle,run,proof,sourceId,{assertCurrent}){
      const requestId=request.id,identity=proof.jobId||proof.verificationId;
      if(JSON.stringify(proof).length>40000)throw fail('The complete verification script, captured output and assertions exceed the saved evidence limit. Use a smaller independent verification; no effect receipt was recorded.','WORKBENCH_EFFECT_EVIDENCE_LIMIT');
      const source=evidence(sourceId,proof.kind==='host-control-state'?'Observed human control restoration':'Observed guest criterion verification',proof,'tool_receipt'),existing=request.sources.find(item=>item.id===sourceId);
      if(existing&&existing.contentHash!==source.contentHash)throw fail('This verification job already names different evidence.','RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT');
      const receipts=proof.criterionIds.map(criterionId=>({id:'effect-'+hash([run.id,identity,criterionId]).slice(0,40),state:'succeeded',effectVerified:true,criterionIds:[criterionId],sourceId,runId:run.id,planRef:proof.planRef,...(proof.jobId?{jobId:proof.jobId}:{verificationId:proof.verificationId}),proofSha256:source.contentHash}));
      const previous=cycle.effectReceipts||[];
      for(const receipt of receipts){const old=previous.find(item=>item.id===receipt.id);if(old&&verificationCanonical(old)!==verificationCanonical(receipt))throw fail('The observed-effect receipt is immutable.','RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT');}
      assertCurrent();
      if(!existing||receipts.some(receipt=>!previous.some(item=>item.id===receipt.id))){
        const saved=await this.writer.configureResponseCycle(requestId,{expectedRevision:request.revision,sources:[source],cyclePatch:{id:cycle.id,effectReceipts:[...previous,...receipts.filter(receipt=>!previous.some(item=>item.id===receipt.id))]}});
        try{assertCurrent();}catch(error){await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycle.id,effectReceipts:previous}});throw error;}
        this.updated(saved);
      }
      return {sourceId,receipts};
  }
  inheritedProfile(request,cycle){
    const seen=new Set();let current=cycle;
    while(current&&!seen.has(current.id)){seen.add(current.id);if(current.executionProfile)return current.executionProfile;current=current.parentCycleId?cycleOf(request,current.parentCycleId):null;}
    return null;
  }
  async executionProfile(request,cycle,value={}){
    const supplied=profileInput(value),settings=await this.getSettings()||{};
    const legacy=request.viability?.executionProfile||request.responseCycle?.executionProfile;
    const firstAttempt=request.attempts.find(attempt=>Object.values(cycle.stageNodeIds).includes(attempt.nodeId));
    const bound=this.inheritedProfile(request,cycle)||((cycle.linkedRunId||firstAttempt)?legacy||(firstAttempt?{model:firstAttempt.model,effort:firstAttempt.effort,serviceTier:firstAttempt.serviceTier}:null):null);
    const seed=bound||legacy||{},profile={model:seed.model||settings.defaultModel||'default',effort:seed.effort||settings.defaultEffort||'default',serviceTier:seed.serviceTier||settings.defaultServiceTier||'default'};
    if(!bound)Object.assign(profile,supplied);
    // Resolve aliases once using the existing runtime snapshot. This never starts
    // Codex, discovers models, imports user records, or changes the app default.
    if(['default','codex'].includes(profile.model)){
      const runtime=this.runner.runtime,resolved=runtime?.resolveModel?.(profile.model);
      if(resolved?.available===false)throw fail(resolved.error||'The selected model is unavailable. Choose a concrete configured model.','RESPONSE_CYCLE_MODEL_UNAVAILABLE');
      const selected=resolved?.model?(resolved.providerId&&resolved.providerId!=='codex'?resolved.providerId+'::'+resolved.model:resolved.model):runtime?.status?.().defaultModel;
      if(typeof selected!=='string'||!selected.trim()||['default','codex'].includes(selected))throw fail('Choose a concrete configured model before running this cycle.','RESPONSE_CYCLE_MODEL_UNAVAILABLE');
      profile.model=selected;
    }
    if(bound)for(const field of profileFields)if(supplied[field]!==undefined&&!(field==='model'&&supplied[field]==='default')&&supplied[field]!==profile[field])throw fail('This cycle already has a saved model profile. Create a new cycle to choose another model, reasoning effort, or service tier.','RESPONSE_CYCLE_PROFILE_LOCKED');
    profileInput(profile);
    if(profile.serviceTier==='fast'&&profile.model.includes('::'))throw fail('Fast service is available only for supported Codex models. Choose Standard for this API model.','FAST_MODE_UNAVAILABLE',400);
    return profile;
  }
  async bindProfile(request,cycle,value={}){
    const executionProfile=await this.executionProfile(request,cycle,value);
    if(cycle.executionProfile)return request;
    return this.writer.configureResponseCycle(request.id,{expectedRevision:request.revision,cyclePatch:{id:cycle.id,executionProfile}});
  }
  assertRevision(request,value,{plan=false,cycleId}={}){
    if(!Number.isSafeInteger(value.expectedRequestRevision)||value.expectedRequestRevision!==request.revision)throw fail('The request changed. Read the current plan before acting.','RESPONSE_CYCLE_CONFLICT');
    if(cycleId){const cycle=cycleOf(request,cycleId),node=request.nodes.find(item=>item.id===cycleId);if(value.expectedCycleRevision!==node.revision)throw fail('The response cycle changed. Read its current revision.','RESPONSE_CYCLE_CONFLICT');
      if(plan){const ref=refOf(request,cycle);if(value.expectedPlanRevision!==ref.nodeRevision||value.expectedPlanResponseId!==ref.responseId)throw fail('The plan changed. Review the current revision before continuing.','RESPONSE_CYCLE_PLAN_CONFLICT');}}
  }
  actionKey(value){return requiredText(value.clientRequestId,'Client request ID',160);}
  previousAction(request,action,cycleId,value){
    const key=this.actionKey(value),old=request.responseCycle?.actionReceipts?.find(item=>item.key===key);
    if(old&&(old.action!==action||old.cycleId!==cycleId||old.fingerprint!==hash(value)))throw fail('This request ID names different cycle work.','RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT');
    return old;
  }
  async saveAction(requestId,action,cycleId,value,cycleAction,{status='completed'}={}){
    const current=await this.store.get(requestId),receipt={key:this.actionKey(value),action,cycleId,fingerprint:hash(value),status,cycleAction,at:new Date().toISOString()};
    return this.writer.configureResponseCycle(requestId,{expectedRevision:current.revision,rootPatch:{actionReceipts:[...(current.responseCycle?.actionReceipts||[]).filter(item=>item.key!==receipt.key),receipt].slice(-100)}});
  }
  createCycle(requestId,value,options={}){return this.serialize(requestId,()=>this.createCurrent(requestId,value,options));}
  async createCurrent(requestId,value,{internal=false,feasibilityNodeId,linkedRunId,acceptanceCriteria,sourceIds,key,required=true,subproblemRequest}={}){
    if(subproblemRequest&&!analyticalSubproblem(subproblemRequest))throw fail('Workflow work belongs in the owning executable Plan, not an analytical child.','RESPONSE_CYCLE_CAPABILITY');
    const request=await this.store.get(requestId),client=this.actionKey(value),cycleId='cycle-'+hash([requestId,client]).slice(0,32),previous=request.responseCycle?.cycles?.find(item=>item.id===cycleId);
    if(previous){if(previous.createFingerprint!==hash(value))throw fail('This cycle ID names a different problem.','RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT');return {...request,cycleAction:{cycleId}};}
    if(!internal)this.assertRevision(request,value);
    const title=requiredText(value.title,'Cycle title',240),objective=requiredText(value.purpose,'Cycle purpose',12000),mode=planningExecutionModeOf(value.planningExecutionMode)||'automatic';
    const parent=value.parentNodeId?request.nodes.find(item=>item.id===value.parentNodeId):null;
    if(value.parentNodeId&&!parent)throw fail('Select an existing stage for this child cycle.','RESPONSE_CYCLE_NOT_FOUND',404);
    if(parent?.kind==='cycle')throw fail('Refine a specific stage inside the cycle.','RESPONSE_CYCLE_INVALID',400);
    if(parent&&!internal&&value.expectedParentRevision!==parent.revision)throw fail('The parent stage changed.','RESPONSE_CYCLE_CONFLICT');
    const parentCycle=parent?.cycleId?cycleOf(request,parent.cycleId):null,depth=parentCycle?parentCycle.depth+1:0,limits={...RESPONSE_CYCLE_LIMITS.recursion,...request.responseCycle?.limits};
    if(depth>limits.maxDepth||(request.responseCycle?.cycles?.length||0)>=limits.maxCycles)throw fail('This response reached its recursive work limit. Narrow the open subproblem before continuing.','RESPONSE_CYCLE_BUDGET');
    if(parent&&(request.responseCycle?.cycles||[]).filter(item=>item.parentStageId===parent.id).length>=(limits.maxChildren||8))throw fail('This stage reached its child-cycle limit. Resolve or revise its existing subproblems first.','RESPONSE_CYCLE_BUDGET');
    if(parentCycle&&titleOf(objective).toLowerCase()===titleOf(parentCycle.objective).toLowerCase())throw fail('A child cycle must ask a smaller question than its parent.','RESPONSE_CYCLE_RECURSION');
    const stageNodeIds=Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,stage.id==='feasibility'&&feasibilityNodeId?feasibilityNodeId:cycleId+'-'+stage.id]));
    if(parent&&sourceIds){const allowed=new Set((parent.response?.sources||planningNodeSources(request,parent.id)).map(source=>source.id));if(sourceIds.some(id=>!allowed.has(id)))throw fail('A child may use only evidence actually captured by its parent stage.','RESPONSE_CYCLE_SOURCE_SCOPE');}
    const inheritedProfile=parentCycle&&this.inheritedProfile(request,parentCycle);
    const cycle={id:cycleId,pipelineVersion:RESPONSE_CYCLE_PIPELINE_VERSION,title,objective,parentCycleId:parentCycle?.id||null,parentStageId:parent?.id||null,stageNodeIds,depth,planningExecutionMode:mode,state:'pending',key:key||cycleId,required,acceptanceCriteria:acceptanceCriteria||[],sourceIds:sourceIds??null,...(inheritedProfile?{executionProfile:clone(inheritedProfile)}:{}),...(subproblemRequest?{request:clone(subproblemRequest)}:{}),createFingerprint:hash(value),...(linkedRunId?{linkedRunId}:{}),execution:{required:Boolean(linkedRunId),state:linkedRunId?'pending':'not_required'},createdAt:new Date().toISOString()};
    const context=evidence('cycle:context:'+cycleId,'Purpose and completion criteria · '+title,{title,objective,acceptanceCriteria:cycle.acceptanceCriteria,parentStage:parent?.title||null,originalRequest:request.objective,scope:'Analytical stage work. External effects require the separate operational workflow.'});
    const saved=await this.writer.configureResponseCycle(requestId,{expectedRevision:request.revision,createCycle:cycle,sources:[context],...(!parent&&(!request.responseCycle?.rootCycleId||linkedRunId)?{rootPatch:{rootCycleId:cycleId,...(linkedRunId?{linkedRunId}:{} )}}:{})});
    return {...this.updated(saved),cycleAction:{cycleId}};
  }
  async ensureRoot(request,run){
    if(!this.runBindings.has(run.id))this.runBindings.set(run.id,{requestId:request.id,excludedAttemptIds:request.attempts.map(attempt=>attempt.id)});
    const existing=request.responseCycle?.rootCycleId;
    if(existing){
      let cycle=cycleOf(request,existing);
      if(cycle.pipelineVersion!==RESPONSE_CYCLE_PIPELINE_VERSION&&(cycle.continuedPlanRef||cycle.execution?.required&&!['pending','not_required'].includes(cycle.execution.state))){
        // A new operational preparation gets a new intent-first root. Keep the
        // historical adopted plan, execution and proof bindings untouched.
        const created=await this.createCurrent(request.id,{title:titleOf(run.input),purpose:request.objective,planningExecutionMode:run.planningExecutionMode||run.workflow?.settings?.planningExecutionMode||'automatic',clientRequestId:'intent-first-root-'+run.id},{internal:true,linkedRunId:run.id});
        const next=cycleOf(created,created.cycleAction.cycleId);
        let saved=await this.taskViability.writer.configureViability(request.id,{viability:{nodeId:next.stageNodeIds.feasibility}});
        this.runBindings.set(run.id,{...this.runBindings.get(run.id),requestId:request.id,cycleId:next.id});
        this.publishRunProgress(saved,cycleOf(saved,next.id),'inference');return saved;
      }
      if(cycle.pipelineVersion!==RESPONSE_CYCLE_PIPELINE_VERSION){request=await this.writer.configureResponseCycle(request.id,{upgradePipeline:cycle.id});cycle=cycleOf(request,existing);}
      const mode=planningExecutionModeOf(run.planningExecutionMode)||run.workflow?.settings?.planningExecutionMode||'automatic';
      this.runBindings.set(run.id,{...this.runBindings.get(run.id),requestId:request.id,cycleId:cycle.id});
      const saved=await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycle.id,linkedRunId:run.id,planningExecutionMode:mode,execution:{required:true,state:'pending'},state:'preparing'},rootPatch:{linkedRunId:run.id}});
      this.publishRunProgress(saved,cycleOf(saved,cycle.id),responseCycleStages(cycle)[0].id);
      return saved;
    }
    const created=await this.createCurrent(request.id,{title:titleOf(run.viability?.baseInput||run.input),purpose:request.objective,planningExecutionMode:run.planningExecutionMode||run.workflow?.settings?.planningExecutionMode||'automatic',clientRequestId:'root-response-cycle'},{internal:true,feasibilityNodeId:request.nodes.some(node=>node.id==='viability')?'viability':undefined,linkedRunId:run.id});
    this.runBindings.set(run.id,{...this.runBindings.get(run.id),requestId:request.id,cycleId:created.cycleAction.cycleId});
    const saved=await this.writer.configureResponseCycle(request.id,{requestTitle:titleOf(run.viability?.baseInput||run.input),cyclePatch:{id:created.cycleAction.cycleId,state:'preparing'}});
    this.publishRunProgress(saved,cycleOf(saved,created.cycleAction.cycleId),'inference');
    return saved;
  }
  publishRunProgress(request,cycle,stage){
    const runId=cycle.linkedRunId||request.responseCycle?.linkedRunId,binding=this.runBindings.get(runId),run=this.engine?.runs?.get?.(runId);
    if(!run||binding?.requestId!==request.id||binding?.cycleId!==cycle.id)return;
    this.engine.updateResponseCycleProgress?.(run,{requestId:request.id,cycleId:cycle.id,planRef:refOf(request,cycle),state:'running',stage,title:cycle.title,
      planning:planningCycleEvidence(request,cycle,{adoptedPlanRef:run.responseCycle?.planning?.planAdopted?run.responseCycle.planRef:null})});
  }
  queueLiveUsageRefresh(event){
    const {requestId,workerStatus}=event?.data||{};
    if(this.closed||!requestId||!['completed','failed','cancelled','repairing'].includes(workerStatus))return;
    // Accounting must not queue behind drive(), which is waiting on this same worker.
    const work=(this.usageUpdates.get(requestId)||Promise.resolve()).catch(()=>{}).then(()=>this.captureLiveRunUsage(requestId));
    this.usageUpdates.set(requestId,work);
    work.finally(()=>{if(this.usageUpdates.get(requestId)===work)this.usageUpdates.delete(requestId);}).catch(()=>{});
    return work;
  }
  async captureLiveRunUsage(requestId){
    const candidates=[...this.runBindings].filter(([,binding])=>binding.requestId===requestId&&binding.cycleId).map(([id,binding])=>({id,binding,run:this.engine?.runs?.get?.(id)})).filter(item=>item.run&&item.run.settled!==true);
    if(this.closed||!candidates.length)return;
    const current=item=>!this.closed&&this.engine?.runs?.get?.(item.id)===item.run&&item.run.settled!==true&&this.runBindings.get(item.id)?.requestId===requestId&&this.runBindings.get(item.id)?.cycleId===item.binding.cycleId;
    const report=(item,error)=>{if(current(item))item.run.planningUsageError={message:String(error?.message||error),code:error?.code||'PLANNING_USAGE_REFRESH'};};
    let request;try{request=await this.store.get(requestId);}catch(error){for(const item of candidates)report(item,error);return;}
    for(const item of candidates){
      if(!current(item))continue;
      try{
        const binding=this.runBindings.get(item.id),changed=await this.captureRunUsage(item.run,{request,cycleId:binding.cycleId,excludedAttemptIds:binding.excludedAttemptIds});
        if(changed&&current(item))this.engine.notify?.('run.updated',item.run,undefined,this.engine.snapshot(item.run));
      }catch(error){report(item,error);}
    }
  }
  async captureRunUsage(run,{request,excludedAttemptIds,cycleId}={}){
    const binding=this.runBindings.get(run.id),requestId=request?.id||binding?.requestId||run.responseCycle?.requestId;
    if(!requestId||!binding&&excludedAttemptIds===undefined)return;
    request??=await this.store.get(requestId);cycleId??=binding?.cycleId||run.responseCycle?.cycleId;
    const excluded=new Set(excludedAttemptIds??binding?.excludedAttemptIds??[]);
    const cycleIds=new Set([cycleId]);let changed=true;
    while(changed){changed=false;for(const child of request.cycles||[])if(cycleIds.has(child.parentCycleId)&&!cycleIds.has(child.id)&&(!child.linkedRunId||child.linkedRunId===run.id)){cycleIds.add(child.id);changed=true;}}
    const nodeIds=new Set((request.cycles||[]).filter(cycle=>cycleIds.has(cycle.id)).flatMap(cycle=>Object.values(cycle.stageNodeIds)));
    const previous=JSON.stringify(run.planningAttempts||[]),hadError=Boolean(run.planningUsageError);
    const records=new Map((run.planningAttempts||[]).map(attempt=>[attempt.requestId+'\0'+attempt.attemptId,attempt]));
    for(const attempt of request.attempts||[]){
      if(excluded.has(attempt.id)||!nodeIds.has(attempt.nodeId)||['queued','running'].includes(attempt.status))continue;
      const usage=attempt.usage||attempt.metadata?.usage;
      if(!usage&&attempt.status!=='completed')continue;
      const record={requestId,attemptId:attempt.id,nodeId:attempt.nodeId,cycleId:request.nodes.find(node=>node.id===attempt.nodeId)?.cycleId||cycleId,usage:clone(usage||tokenUsageMeasurement())};
      records.set(requestId+'\0'+attempt.id,record);
    }
    run.planningAttempts=[...records.values()];run.planningUsage=aggregateTokenUsage(run.planningAttempts.map(attempt=>attempt.usage));delete run.planningUsageError;
    return hadError||previous!==JSON.stringify(run.planningAttempts);
  }
  async publishLinkedRun(request,cycleId,{excludedAttemptIds=request.attempts.map(attempt=>attempt.id)}={}){
    const cycle=cycleOf(request,cycleId),runId=cycle.execution?.runId||cycle.linkedRunId;
    if(!runId||!this.engine?.publishResponseCycle||!['completed','failed','cancelled','unknown'].includes(cycle.execution?.state))return null;
    let run;try{run=this.engine.getRun(runId);}catch{
      run=await this.conversations?.get(runId);if(run)this.engine.restoreArchivedRun(run);
    }
    if(!run)throw fail('The original conversation is unavailable; its checked graph response is preserved.','RESPONSE_CYCLE_RUN_MISSING',404);
    if(run.settled!==true)throw fail('Wait for the original run to settle before publishing its checked response.','RESPONSE_CYCLE_RUN_BUSY');
    if(run.responseCycle?.requestId!==request.id||run.responseCycle?.cycleId!==cycleId)throw fail('This response cycle no longer matches the original conversation.','RESPONSE_CYCLE_PLAN_CONFLICT');
    const planRef=refOf(request,cycle);
    if(!samePlan(run.responseCycle.planRef,planRef))throw fail('The checked response uses a changed plan. The original conversation has been preserved for review.','RESPONSE_CYCLE_PLAN_CONFLICT');
    await this.captureRunUsage(run,{request,excludedAttemptIds,cycleId});
    const response=request.nodes.find(node=>node.id===cycle.stageNodeIds.respond),ready=cycle.state==='completed'&&response?.readiness.cycle?.analysisReady===true;
    const answer=ready?response.response.values.answer:null,question=run.viability?.awaitingInput?run.viability.question:null;
    const details={requestId:request.id,cycleId,planRef,state:cycle.state,planningAttempts:run.planningAttempts,
      planning:planningCycleEvidence(request,cycle,{adoptedPlanRef:planRef}),
      ...(ready?{output:question&&!answer.includes(question)?answer+'\n\n'+question:answer,responseId:response.response.id,outcome:response.readiness.cycle.outcome,partial:false}:{partial:true,output:'The final response has not passed its checks. '+(cycle.summary||'Review the open Planning stage.'),error:cycle.failure||null})};
    const published=this.engine.publishResponseCycle(runId,details);
    await this.engine.persist();
    if(this.conversations)await this.conversations.capture(published);
    return published;
  }
  budget(request){return {used:(request.attempts||[]).filter(attempt=>attempt.node?.cycleId).length,max:request.responseCycle?.limits?.maxProviderTurns||160,maxPasses:request.responseCycle?.limits?.maxPassesPerStage||3};}
  async linkInputs(request,cycle,stageId){
    const stages=responseCycleStages(cycle),at=stages.findIndex(stage=>stage.id===stageId),from=cycle.stageNodeIds[stageId],links=[],removeLinks=[],priorIds=new Set(stages.slice(0,at).map(stage=>cycle.stageNodeIds[stage.id]));
    for(const edge of request.edges)if(edge.from===from&&Object.values(cycle.stageNodeIds).includes(edge.to)&&edge.kind==='consumes'&&edge.id==='input-'+hash([from,edge.to]).slice(0,32)&&!priorIds.has(edge.to))removeLinks.push(edge.id);
    for(const stage of stages.slice(0,at)){const node=request.nodes.find(item=>item.id===cycle.stageNodeIds[stage.id]);if(node?.response)links.push({id:'input-'+hash([from,node.id]).slice(0,32),kind:'consumes',from,to:node.id});}
    for(const child of request.cycles||[])if(child.parentStageId===from&&analyticalSubproblem(child.request)){const id='child-'+hash([from,child.id]).slice(0,32);if(child.required!==false&&child.state==='completed')links.push({id,kind:'depends_on',from,to:child.stageNodeIds.respond});else if(request.edges.some(edge=>edge.id===id))removeLinks.push(id);}
    return links.length||removeLinks.length?this.writer.configureResponseCycle(request.id,{links,removeLinks}):request;
  }
  async syncExistingChildren(request,parentNodeId,options){
    for(const original of request.cycles.filter(child=>child.parentStageId===parentNodeId&&analyticalSubproblem(child.request))){
      let child=cycleOf(request,original.id);
      if(['stale','needs_review','pending','planned','needs_evidence','waiting_children'].includes(child.state)){
        try{request=await this.drive(request.id,child.id,{...options,through:'respond'});}
        catch(error){if(options.signal?.aborted)throw error;request=await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:child.id,state:'failed',failure:{code:error.code||'RESPONSE_CYCLE_CHILD_FAILED',message:error.message},summary:error.message}});}
        child=cycleOf(request,child.id);
      }
      if(!['completed','failed','cancelled'].includes(child.state))continue;
      const result=request.nodes.find(node=>node.id===child.stageNodeIds.respond),source=evidence('cycle:child:'+parentNodeId+':'+child.id,'Child result · '+child.title,{title:child.title,objective:child.objective,state:child.state,...(result.response?{answer:result.response.values.answer,coverage:result.response.coverage,outcome:result.readiness.cycle?.outcome||'unresolved',responseId:result.response.id,responseRevision:result.response.revision}:{outcome:'unresolved',failure:child.failure||child.summary||'No checked child response was produced.'})});
      if(request.sources.find(item=>item.id===source.id)?.contentHash!==source.contentHash)request=await this.writer.configureResponseCycle(request.id,{sources:[source]});
    }
    return request;
  }
  assertSubproblemBindings(request,node){
    for(const item of node?.response?.subproblems||[]){
      const bound=request.cycles.find(child=>child.parentStageId===node.id&&child.key===item.key);
      if(bound?.request&&!sameSubproblemRequest(bound.request,item))throw fail('A subproblem key cannot change its objective, completion contract or execution target. Preserve the original result and use a new key for different work.','RESPONSE_CYCLE_RECURSION');
    }
  }
  async runStage(requestId,cycleId,stageId,{signal,budget,runKey,hostOnlyTools}={}){
    for(let pass=0;pass<(budget?.maxPasses||3);pass++){
      signal?.throwIfAborted();let request=await this.store.get(requestId),cycle=cycleOf(request,cycleId);
      if(request.viability?.recoveryIssue)return request;
      request=await this.bindProfile(request,cycle);cycle=cycleOf(request,cycleId);
      this.assertSubproblemBindings(request,request.nodes.find(node=>node.id===cycle.stageNodeIds[stageId]));
      request=await this.syncExistingChildren(request,cycle.stageNodeIds[stageId],{signal,budget,runKey,hostOnlyTools});
      request=await this.linkInputs(request,cycle,stageId);cycle=cycleOf(request,cycleId);
      let node=request.nodes.find(item=>item.id===cycle.stageNodeIds[stageId]);
      if(!node.readiness.cycle?.analysisReady){
        if(['think','respond'].includes(stageId)&&cycle.execution?.required&&!['completed','failed','cancelled','unknown'].includes(cycle.execution.state))return request;
        if(budget.used>=budget.max)throw fail('The response reached its model-work limit. Review the remaining subproblem before continuing.','RESPONSE_CYCLE_BUDGET');
        const inputs=hash([node.id,node.revision,planningNodeSources(request,node.id).filter(source=>source.kind!=='response').map(source=>[source.id,source.contentHash||hash(source.text)]),request.edges.filter(edge=>edge.from===node.id),runKey,pass]);
        const stable='cycle-stage-'+inputs.slice(0,64),prior=request.attempts.find(attempt=>attempt.nodeId===node.id&&attempt.clientRequestId===stable);
        if(prior&&['failed','cancelled'].includes(prior.status))return request;
        const profile=cycle.executionProfile;
        signal?.throwIfAborted();
        this.publishRunProgress(request,cycle,stageId);
        const claim=await this.runner.start({requestId,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:stable,...profile,automatic:false,cycleRun:true,providerBudget:budget,signal,...(hostOnlyTools?{hostOnlyTools:true}:{})});
        await this.runner.wait(requestId,claim.attempt.id,{signal});signal?.throwIfAborted();request=await this.store.get(requestId);node=request.nodes.find(item=>item.id===node.id);
        this.publishRunProgress(request,cycleOf(request,cycleId),stageId);
      }
      if(!node.response)return request;
      this.assertSubproblemBindings(request,node);
      const subproblems=analyticalSubproblems(node.response.subproblems);
      let expanded=false;
      for(const subproblem of subproblems){
        signal?.throwIfAborted();let current=await this.store.get(requestId),child=current.responseCycle.cycles.find(item=>item.parentStageId===node.id&&item.key===subproblem.key);
        if(child&&(child.objective!==subproblem.objective||child.request&&!sameSubproblemRequest(child.request,subproblem)))throw fail('A recursive subproblem key was reused for a different objective or completion contract. Give the revised problem a new descriptive key.','RESPONSE_CYCLE_RECURSION');
        if(!child){
          current=await this.createCurrent(requestId,{parentNodeId:node.id,title:subproblem.title,purpose:subproblem.objective,planningExecutionMode:'automatic',clientRequestId:'child-'+hash([node.id,subproblem.key]).slice(0,64)},{internal:true,acceptanceCriteria:subproblem.acceptanceCriteria,sourceIds:subproblem.sourceIds,key:subproblem.key,required:subproblem.required,subproblemRequest:subproblem});
          child=cycleOf(current,current.cycleAction.cycleId);expanded=true;
        }
        child=cycleOf(current,child.id);
        if(!['completed','failed','cancelled'].includes(child.state)){
          try{await this.drive(requestId,child.id,{through:'respond',signal,budget,runKey,hostOnlyTools});}
          catch(error){if(signal?.aborted)throw error;await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:child.id,state:'failed',failure:{code:error.code||'RESPONSE_CYCLE_CHILD_FAILED',message:error.message},summary:error.message}});}
          expanded=true;
        }
        current=await this.store.get(requestId);child=cycleOf(current,child.id);
        const resultNode=current.nodes.find(item=>item.id===child.stageNodeIds.respond);
        if(!['completed','failed','cancelled'].includes(child.state)){if(subproblem.required)return current;continue;}
        const source=evidence('cycle:child:'+node.id+':'+child.id,'Child result · '+child.title,{title:child.title,objective:child.objective,state:child.state,...(resultNode.response?{answer:resultNode.response.values.answer,coverage:resultNode.response.coverage,outcome:resultNode.readiness.cycle?.outcome||'unresolved',responseId:resultNode.response.id,responseRevision:resultNode.response.revision}:{outcome:'unresolved',failure:child.failure||child.summary||'No checked child response was produced.'})});
        const old=current.sources.find(item=>item.id===source.id);
        if(old?.contentHash!==source.contentHash){await this.writer.configureResponseCycle(requestId,{sources:[source]});expanded=true;}
      }
      request=await this.store.get(requestId);node=request.nodes.find(item=>item.id===node.id);
      if(node.readiness.cycle?.analysisReady&&!expanded)return request;
      if(!expanded&&!subproblems.length)return request;
    }
    throw fail('This stage did not converge within its refinement limit. Its findings and child results are saved for revision.','RESPONSE_CYCLE_BUDGET');
  }
  async drive(requestId,cycleId,{through='respond',signal,budget,runKey,hostOnlyTools}={}){
    let request=await this.store.get(requestId);budget??=this.budget(request);
    signal?.throwIfAborted();
    if(cycleOf(request,cycleId).state!=='running')request=await this.writer.configureResponseCycle(requestId,{expectedRevision:request.revision,cyclePatch:{id:cycleId,state:'running'}});
    for(const stage of responseCycleStages(cycleOf(request,cycleId))){
      request=await this.runStage(requestId,cycleId,stage.id,{signal,budget,runKey,hostOnlyTools});const cycle=cycleOf(request,cycleId),node=request.nodes.find(item=>item.id===cycle.stageNodeIds[stage.id]);
      if(!node.readiness.cycle?.analysisReady){
        const state=request.viability?.recoveryIssue?'needs_evidence':['failed','cancelled'].includes(node.readiness.state)?node.readiness.state:node.readiness.cycle?.state||node.readiness.state;
        const lastAttempt=[...request.attempts].reverse().find(attempt=>attempt.nodeId===node.id);
        const summary=request.viability?.recoveryIssue?.message||(node.readiness.cycle?.issues||[]).join(' ')||lastAttempt?.message||'This stage needs a usable checked response before progression.';
        const failure=state==='failed'?{code:lastAttempt?.metadata?.errorCode||'RESPONSE_CYCLE_STAGE_FAILED',message:lastAttempt?.message||summary}:null;
        return this.updated(await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state,summary,failure}}));
      }
      if(stage.id===through)break;
    }
    const cycle=cycleOf(request,cycleId),planRef=refOf(request,cycle),state=through==='plan'?'planned':'completed';
    return this.updated(await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state,planRef,summary:'',failure:null},rootPatch:{stageAttempts:request.attempts.filter(attempt=>attempt.node?.cycleId).length}}));
  }
  runCycle(requestId,cycleId,value,options={}){
    const key=requestId+'\0'+cycleId,fingerprint=hash(value),active=this.cycleRuns.get(key);
    if(active){
      if(active.fingerprint===fingerprint)return active.promise;
      return Promise.reject(fail(active.clientRequestId===value.clientRequestId?'This request ID names different cycle work.':'This cycle is already running. Its saved model profile cannot change during work.',active.clientRequestId===value.clientRequestId?'RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT':'RESPONSE_CYCLE_BUSY'));
    }
    const operation=this.serialize(requestId,async()=>{
    let request=await this.store.get(requestId);const prior=this.previousAction(request,'run',cycleId,value);if(prior?.status==='completed'){await this.publishLinkedRun(request,cycleId);return {...request,cycleAction:prior.cycleAction};}
    const excludedAttemptIds=request.attempts.map(attempt=>attempt.id);
    if(!prior)this.assertRevision(request,value,{cycleId});let cycle=cycleOf(request,cycleId);const mode=prior?.cycleAction?.planningExecutionMode||planningExecutionModeOf(value.planningExecutionMode)||cycle.planningExecutionMode;
    if(!prior&&(['preparing','running','executing','evaluating','continuing'].includes(cycle.state)||request.attempts.some(attempt=>Object.values(cycle.stageNodeIds).includes(attempt.nodeId)&&['queued','running'].includes(attempt.status))))throw fail('This cycle has active work. Wait for its saved result before requesting another run.','RESPONSE_CYCLE_BUSY');
    if(!prior&&cycle.pipelineVersion!==RESPONSE_CYCLE_PIPELINE_VERSION&&!cycle.continuedPlanRef&&(!cycle.execution?.required||['pending','not_required'].includes(cycle.execution.state))){request=await this.writer.configureResponseCycle(request.id,{upgradePipeline:cycle.id});cycle=cycleOf(request,cycleId);}
    const profile=prior?.cycleAction?.executionProfile||await this.executionProfile(request,cycle,value);
    if(!prior)request=await this.saveAction(requestId,'run',cycleId,value,{cycleId,state:'running',planningExecutionMode:mode,executionProfile:profile},{status:'pending'});
    if(cycle.executionProfile&&hash(cycle.executionProfile)!==hash(profile))throw fail('The saved cycle profile differs from this pending run.','RESPONSE_CYCLE_PROFILE_LOCKED');
    if(!cycle.executionProfile)request=await this.writer.configureResponseCycle(requestId,{expectedRevision:request.revision,cyclePatch:{id:cycleId,executionProfile:profile}});
    cycle=cycleOf(request,cycleId);
    request=await this.writer.configureResponseCycle(requestId,{expectedRevision:request.revision,cyclePatch:{id:cycleId,planningExecutionMode:mode,state:'running',summary:'',failure:null}});
    const stopAtPlan=mode==='plan_only'||Boolean(cycle.linkedRunId&&!['completed','failed','cancelled','unknown'].includes(cycle.execution?.state));
    try{
      if(!stopAtPlan)request=await this.refreshSettledExecutionProjection(request,cycleId,{signal:options.signal});
      request=await this.drive(requestId,cycleId,{through:stopAtPlan?'plan':'respond',signal:options.signal,budget:this.budget(request),runKey:value.clientRequestId});
    }
    catch(error){try{await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:options.signal?.aborted?'cancelled':'failed',summary:String(error.message||error).slice(0,1800),failure:{code:error.code||'RESPONSE_CYCLE_FAILED',message:String(error.message||error).slice(0,1800)}}});}catch{}throw error;}
    let current=cycleOf(request,cycleId);
    if(stopAtPlan&&request.nodes.find(node=>node.id===current.stageNodeIds.plan)?.readiness.cycle?.analysisReady)request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'paused_after_plan',planRef:refOf(request,current)}});
    current=cycleOf(request,cycleId);await this.publishLinkedRun(request,cycleId,{excludedAttemptIds});const action={cycleId,state:current.state,planRef:refOf(request,current),executionProfile:current.executionProfile};
    request=await this.saveAction(requestId,'run',cycleId,value,action);return {...this.updated(request),cycleAction:action};
    });
    this.cycleRuns.set(key,{fingerprint,clientRequestId:value.clientRequestId,promise:operation});
    operation.finally(()=>{if(this.cycleRuns.get(key)?.promise===operation)this.cycleRuns.delete(key);}).catch(()=>{});
    return operation;
  }
  async retainedObservationRun(run){
    // Conversation witnesses survive the engine's bounded event ring. Keep
    // the actual execution window intact for the projection identity guard.
    let saved;try{saved=await this.conversations?.get(run.id);}catch{}
    const witnesses=capturePlanningGuestObservationEvents(run,saved?.planningGuestObservationEvents);
    return witnesses?{...run,planningGuestObservationEvents:witnesses}:run;
  }
  async refreshSettledExecutionProjection(request,cycleId,{signal}={}){
    const cycle=cycleOf(request,cycleId),runId=cycle.execution?.runId||cycle.linkedRunId;
    if(!runId||!['completed','failed','cancelled','unknown'].includes(cycle.execution?.state))return request;
    signal?.throwIfAborted();
    let run;try{run=this.engine?.getRun?.(runId);}catch{run=await this.conversations?.get(runId);}
    if(!run||run.settled!==true||['queued','running','waiting'].includes(run.status)||!Array.isArray(run.events)||!Array.isArray(run.workflow?.nodes))
      throw fail('The original settled execution records are unavailable. No operational work was restarted.','RESPONSE_CYCLE_RUN_MISSING');
    if(run.responseCycle?.requestId!==request.id||run.responseCycle?.cycleId!==cycle.id||!samePlan(run.responseCycle.planRef,refOf(request,cycle)))
      throw fail('The original execution no longer matches this adopted plan.','RESPONSE_CYCLE_PLAN_CONFLICT');
    run=await this.retainedObservationRun(run);
    const prefix='cycle:execution:'+cycle.id+':projection:',previous=request.sources.filter(source=>source.id.startsWith(prefix)),mediaSource=await this.reviewMediaSource(run,request,cycle,{signal}),
      canonical=await this.canonicalExecutionEvidence(run,request,{signal}),review=executionReviewContext(run,request,cycle,recordedExecutionOutputs(run),{mediaSource,canonical});
    if(review.projected.limited||review.records.reduce((sum,source)=>sum+source.text.length,0)>EXECUTION_CONTEXT_CHARS)
      throw fail('The exact receipt identity index and verification proofs exceed the bounded final-review context. Original evidence is preserved.','RESPONSE_CYCLE_CONTEXT_BUDGET');
    // Re-budget excerpts only. A partial archive or changed event window must
    // never silently replace the identities/statuses used by the first review.
    if(previous.length&&JSON.stringify(projectionIdentity(previous))!==JSON.stringify(projectionIdentity(review.projected.records)))
      throw fail('The saved execution receipt identities changed. Original evidence is preserved for review.','RESPONSE_CYCLE_EXECUTION_CONFLICT');
    const mediaChanged=mediaSource&&request.sources.find(source=>source.id===mediaSource.id)?.contentHash!==mediaSource.contentHash,
      contextChanged=request.sources.find(source=>source.id===review.reviewContext.id)?.contentHash!==review.reviewContext.contentHash,
      canonicalChanged=canonical&&request.sources.find(source=>source.id===canonical.sources[0].id)?.contentHash!==canonical.sources[0].contentHash;
    if(!mediaChanged&&!contextChanged&&!canonicalChanged&&previous.length===review.projected.records.length&&previous.every(source=>review.projected.records.some(next=>next.id===source.id&&next.contentHash===source.contentHash)))return request;
    signal?.throwIfAborted();
    return this.writer.configureResponseCycle(request.id,{expectedRevision:request.revision,replaceSourcePrefix:canonical?'cycle:execution:'+cycle.id+':':prefix,
      sources:canonical?review.records:[...review.projected.records,...(mediaSource?[mediaSource]:[]),...review.observationSources],
      ...(canonical?{cyclePatch:{id:cycle.id,effectReceipts:review.effectReceipts}}:{}),
      reviewContext:{cycleId:cycle.id,sourceId:review.reviewContext.id,sourceHash:review.reviewContext.contentHash},...(mediaSource?{reviewMedia:{cycleId:cycle.id,sourceId:mediaSource.id,sourceHash:mediaSource.contentHash}}:{})});
  }
  editPlan(requestId,cycleId,value,options={}){return this.serialize(requestId,async()=>{
    let request=await this.store.get(requestId);const prior=this.previousAction(request,'edit_plan',cycleId,value);if(prior?.status==='completed')return {...request,cycleAction:prior.cycleAction};
    if(!prior)this.assertRevision(request,value,{plan:true,cycleId});const cycle=cycleOf(request,cycleId),node=request.nodes.find(item=>item.id===cycle.stageNodeIds.plan);
    if(!['paused_after_plan','planned','needs_review','stale'].includes(cycle.state))throw fail('Pause or complete planning before editing its saved plan.','RESPONSE_CYCLE_PLAN_BUSY');
    const legacyControlPlan=options.actor?.type==='agent'&&options.legacyControlPlan===true;
    // A cached control catalog cannot author the new field. Retain an existing checkpoint instead of downgrading it.
    const planInput=legacyControlPlan&&value.plan&&typeof value.plan==='object'&&!Array.isArray(value.plan)&&value.plan.userAgency==null&&node.response?.userAgency?{...value.plan,userAgency:clone(node.response.userAgency)}:value.plan;
    const body=planningResponseBody(parseResponseCycleResponse(planInput,'plan',{sources:planningNodeSources(request,node.id),pipelineVersion:cycleOf(request,cycleId).pipelineVersion||1}));
    if(!prior)request=await this.saveAction(requestId,'edit_plan',cycleId,value,{cycleId,state:'editing',planRef:refOf(request,cycle)},{status:'pending'});
    const writeOptions={expectedNodeRevision:value.expectedPlanRevision,clientRequestId:'plan-edit-'+hash(value.clientRequestId).slice(0,64),actor:options.actor||{type:'human',id:'user'},...(legacyControlPlan?{legacyControlPlan:true}:{}),...(options.receipt?{receipt:options.receipt}:{})};
    if(options.actor?.type==='external-agent')request=await this.store.externalWriter().recordResponse(requestId,node.id,body,writeOptions);
    else if(options.actor?.type==='agent')request=await this.writer.recordSupervisedResponse(requestId,node.id,body,writeOptions);
    else request=await this.store.recordHumanResponse(requestId,node.id,body,writeOptions);
    request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'paused_after_plan',planRef:refOf(request,cycle),continuedPlanRef:null}});
    const action={cycleId,state:'paused_after_plan',planRef:refOf(request,cycle)};request=await this.saveAction(requestId,'edit_plan',cycleId,value,action);
    return {...this.updated(request),cycleAction:action};
  });}
  async answerQuestion(requestId,value,options={}){
    const initial=await this.store.get(requestId),nodeId=value.nodeId||initial.viability?.nodeId||'viability',selected=initial.nodes.find(node=>node.id===nodeId);
    if(!selected?.cycleId){const {nodeId:_nodeId,expectedRequestRevision:_requestRevision,...answer}=value;return this.taskViability.answer(requestId,answer,{...options,operations:options.operations||this.engine?.operations});}
    return this.serialize(requestId,async()=>{
      const caller=['agent','external-agent'].includes(options.actor?.type)?clone(options.actor):null,receiptValue={...value,caller};
      let request=await this.store.get(requestId),node=request.nodes.find(item=>item.id===nodeId),cycle=cycleOf(request,node.cycleId),root=cycle;
      while(root.parentCycleId)root=cycleOf(request,root.parentCycleId);
      const prior=this.previousAction(request,'answer',cycle.id,receiptValue);if(prior?.status==='completed')return {...request,cycleAction:prior.cycleAction};
      if(prior?.cycleAction?.engineRequestId){const accepted=this.engine?.clientRequestRunId(prior.cycleAction.engineRequestId);if(accepted){const action={cycleId:root.id,resumedRunId:accepted,state:'continuing'};request=await this.saveAction(requestId,'answer',cycle.id,receiptValue,action);return {...this.updated(request),cycleAction:action};}}
      const answer=requiredText(value.answer,'Factual answer',12000);
      if(!prior){
        if(request.viability?.definition&&this.taskViability)request=await this.taskViability.refreshSources(request,request.viability.definition,{signal:options.signal});
        node=request.nodes.find(item=>item.id===nodeId);
        if(node.kind!=='viability'||node.revision!==value.expectedNodeRevision||node.response?.id!==value.expectedResponseId||node.readiness.viability?.state!=='awaiting_input'||!node.readiness.viability.blockingFacts.some(fact=>fact.id===value.requirementId))throw fail('The factual question changed. Read the current stage before answering.','TASK_VIABILITY_ANSWER_CONFLICT');
        request=await this.saveAction(requestId,'answer',cycle.id,receiptValue,{cycleId:root.id,state:'checking_answer',pendingIntent:root.pendingIntent||null},{status:'pending'});
      }
      const sourceId='viability:answer:cycle-'+hash([requestId,nodeId,value.clientRequestId]).slice(0,48);
      request=await this.taskViability.writer.configureViability(requestId,{sources:[evidence(sourceId,(caller?'Supervising model answer · ':'User answer · ')+node.title,answer,caller?'source':'user_input')]});
      if(root.planningExecutionMode==='plan_only'){
        request=await this.runStage(requestId,cycle.id,'feasibility',{signal:options.signal,budget:this.budget(request),runKey:value.clientRequestId});
        request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:root.id,state:'paused_after_plan'}});
      }else request=await this.drive(requestId,root.id,{through:'plan',signal:options.signal,budget:this.budget(request),runKey:value.clientRequestId});
      root=cycleOf(request,root.id);let action={cycleId:root.id,state:root.state};
      const intent=prior?.cycleAction?.pendingIntent||root.pendingIntent,plan=request.nodes.find(item=>item.id===root.stageNodeIds.plan);
      if(root.planningExecutionMode!=='plan_only'&&intent?.kind==='continue_request'&&plan.readiness.cycle?.dispatchReady){
        const engineRequestId='cycle-answer-'+hash(intent.id).slice(0,64);
        request=await this.saveAction(requestId,'answer',cycle.id,receiptValue,{...action,engineRequestId,pendingIntent:intent},{status:'pending'});
        action=await this.writer.withViabilityRequest(requestId,current=>{
          const currentRoot=cycleOf(current,root.id),currentPlan=current.nodes.find(item=>item.id===currentRoot.stageNodeIds.plan);
          if(currentRoot.pendingIntent?.id!==intent.id||!currentPlan.readiness.cycle?.dispatchReady)throw fail('The pending task or its dependencies changed before continuation.','RESPONSE_CYCLE_PLAN_CONFLICT');
          const resumed=this.engine.resumeViabilityRun(intent.runId,{message:'Continue the original request using the factual answers recorded in Planning.',requestId:engineRequestId,readinessChecked:true});
          return {cycleId:root.id,resumedRunId:resumed.id,state:'continuing'};
        });
        request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:root.id,pendingIntent:null,state:'continuing'}});
      }
      request=await this.saveAction(requestId,'answer',cycle.id,receiptValue,action);return {...this.updated(request),cycleAction:action};
    });
  }
  continueCycle(requestId,cycleId,value,options={}){return this.serialize(requestId,async()=>{
    let request=await this.store.get(requestId);const prior=this.previousAction(request,'continue',cycleId,value);if(prior?.status==='completed')return {...request,cycleAction:prior.cycleAction};
    if(prior?.cycleAction?.engineRequestId){const accepted=this.engine?.clientRequestRunId(prior.cycleAction.engineRequestId);if(accepted){const action={cycleId,resumedRunId:accepted,state:'continuing',planRef:prior.cycleAction.planRef};request=await this.saveAction(requestId,'continue',cycleId,value,action);return {...this.updated(request),cycleAction:action};}}
    if(!prior)this.assertRevision(request,value,{plan:true,cycleId});let cycle=cycleOf(request,cycleId),planRef=prior?.cycleAction?.planRef||refOf(request,cycle);
    if(!['paused_after_plan','planned','needs_review','stale',...(prior?['continuing']:[])].includes(cycle.state))throw fail('This response is not waiting at the plan boundary.','RESPONSE_CYCLE_NOT_PAUSED');
    if(request.viability?.definition&&this.taskViability)request=await this.taskViability.refreshSources(request,request.viability.definition,{signal:options.signal});
    cycle=cycleOf(request,cycleId);const plan=request.nodes.find(item=>item.id===cycle.stageNodeIds.plan),feasibility=request.nodes.find(item=>item.id===cycle.stageNodeIds.feasibility);
    if(!samePlan(planRef,refOf(request,cycle))||!plan.readiness.cycle?.analysisReady)throw fail('The plan or its evidence changed. Refresh planning before continuing.','RESPONSE_CYCLE_PLAN_CONFLICT');
    if(cycle.linkedRunId&&(!feasibility.readiness.cycle?.dispatchReady||!plan.readiness.cycle?.dispatchReady))throw fail('Resolve the remaining essential facts or required subproblem before operational work can continue.','RESPONSE_CYCLE_FACTS_REQUIRED');
    const originalRunId=prior?.cycleAction?.linkedRunId||cycle.linkedRunId,engineRequestId=originalRunId?'planned-'+hash([originalRunId,planRef]).slice(0,64):null;
    if(!prior)request=await this.saveAction(requestId,'continue',cycleId,value,{cycleId,state:'continuing',planRef,linkedRunId:originalRunId||null,engineRequestId},{status:'pending'});
    let action;
    if(originalRunId){
      let previous;try{previous=this.engine.getRun(originalRunId);}catch{previous=await this.conversations?.get(originalRunId);if(previous)this.engine.restoreArchivedRun(previous);}
      if(!previous)throw fail('The original conversation is unavailable. The edited plan is preserved.','RESPONSE_CYCLE_RUN_MISSING',404);
      action=await this.writer.withViabilityRequest(requestId,current=>{
        const currentCycle=cycleOf(current,cycleId),currentPlan=current.nodes.find(item=>item.id===currentCycle.stageNodeIds.plan);
        if(!samePlan(planRef,refOf(current,currentCycle))||!currentPlan.readiness.cycle?.analysisReady||!currentPlan.readiness.cycle?.dispatchReady)throw fail('The plan or a required child result changed before continuation.','RESPONSE_CYCLE_PLAN_CONFLICT');
        const resumed=this.engine.resumePlannedRun(originalRunId,{requestId:engineRequestId,planRef});
        return {cycleId,resumedRunId:resumed.id,state:'continuing',planRef};
      });
      request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'continuing',continuedPlanRef:planRef}});
    }else{
      request=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'running',continuedPlanRef:planRef}});
      request=await this.drive(requestId,cycleId,{through:'respond',signal:options.signal,budget:this.budget(request),runKey:value.clientRequestId});
      action={cycleId,state:cycleOf(request,cycleId).state,planRef};
    }
    request=await this.saveAction(requestId,'continue',cycleId,value,action);return {...this.updated(request),cycleAction:action};
  });}
  supportsHostOnlyToolDispatch(){return this.runner.supportsHostOnlyToolDispatch?.()===true&&this.taskViability.supportsHostOnlyToolDispatch?.()===true;}
  async forRun(run,{signal,hostOnlyTools}={}){
    const mode=planningExecutionModeOf(run.planningExecutionMode)||run.workflow?.settings?.planningExecutionMode||'automatic';
    if(run.planningMode==='off'&&run.metadata?.managedBy!=='operations')return {skipped:true,blockedNodeIds:[]};
    const preflight=()=>this.taskViability.forRun(run,{signal,hostOnlyTools,assessManaged:run.planningMode!=='off',beforeAssess:async(request)=>{
      let current=await this.ensureRoot(request,run),cycle=cycleOf(current,current.responseCycle.rootCycleId);
      if(cycle.pipelineVersion!==RESPONSE_CYCLE_PIPELINE_VERSION)return;
      current=await this.supplyHandoffContract(current,cycle,run);
      current=await this.supplyExecutionContract(current,cycle,run);
      current=await this.runStage(current.id,cycle.id,'inference',{signal,budget:this.budget(current),runKey:run.id,hostOnlyTools});
      const inference=current.nodes.find(node=>node.id===cycle.stageNodeIds.inference);
      if(!inference.readiness.cycle?.analysisReady)return {skipAssessment:true};
      await this.linkInputs(current,cycleOf(current,cycle.id),'feasibility');
    }});
    const existingRequestId=run.viability?.requestId||run.responseCycle?.requestId;
    // A resumed engine can begin immediately. Keep its source/context writes
    // behind the continuation's durable receipt before preparing the next turn.
    const checked=existingRequestId?await this.serialize(existingRequestId,preflight):await preflight();
    if(run.planningMode==='off')return checked;
    if(checked.skipped&&!checked.managed)return checked;
    if(!checked.requestId)throw fail('Task readiness did not provide a Planning request.','RESPONSE_CYCLE_CONFIG',500);
    return this.serialize(checked.requestId,async()=>{
      let request=await this.store.get(checked.requestId);if(!request.responseCycle?.rootCycleId)request=await this.ensureRoot(request,run);
      const sameRequest=run.responseCycle?.requestId===request.id;
      const cycleId=this.runBindings.get(run.id)?.cycleId||(sameRequest&&(run.responseCycle?.continuationPlanRef?.cycleId||run.responseCycle?.cycleId))||request.responseCycle.rootCycleId;let cycle=cycleOf(request,cycleId);
      this.runBindings.set(run.id,{...this.runBindings.get(run.id),requestId:request.id,cycleId});
      const continuation=run.responseCycle?.continuationPlanRef||run.continuationPlanRef||null;
      if(continuation&&!samePlan(continuation,refOf(request,cycle)))throw fail('The continued plan revision is no longer current.','RESPONSE_CYCLE_PLAN_CONFLICT');
      request=await this.drive(request.id,cycleId,{through:'plan',signal,budget:this.budget(request),runKey:run.id,hostOnlyTools});cycle=cycleOf(request,cycleId);
      const plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan),planRef=refOf(request,cycle);
      if(continuation&&!samePlan(continuation,planRef))throw fail('Preparing this response changed the reviewed plan. Review the updated plan before execution.','RESPONSE_CYCLE_PLAN_CONFLICT');
      if(cycle.state==='failed'){
        // A failed analytical attempt is an execution failure, not a request
        // for the user to supply a missing fact or approve operational work.
        if(request.viability?.pendingIntent)request=await this.taskViability.writer.configureViability(request.id,{completeIntentId:request.viability.pendingIntent.id,viability:{pendingIntent:null}});
        await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycleId,pendingIntent:null}});
        return {...checked,skipped:false,cycleId,requestId:request.id,planRef,state:'failed',blockedNodeIds:run.workflow.nodes.filter(node=>node.type==='agent').map(node=>node.id),awaitingInput:false,question:'',error:cycle.failure||{code:'RESPONSE_CYCLE_STAGE_FAILED',message:cycle.summary||'Planning failed before operational work could start.'}};
      }
      // Ordinary automatic runs honor the existing advisory execution setting.
      // A valid snapshot can record unknown facts that the operational worker's
      // tools can recover; those findings must not prevent that worker starting.
      const feasibilityNode=request.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility);
      const feasibilityReadiness=feasibilityNode?.readiness.viability;
      const confirmedBlocker=feasibilityReadiness?.blockingFacts?.some(fact=>fact.resolution==='blocked');
      const advisory=!confirmedBlocker&&(run.runtimeSettings?.planningGuardrails ?? run.runtimeSettings?.executionGuardrails)===false&&mode==='automatic'&&run.metadata?.managedBy!=='operations'&&!request.viability?.recoveryIssue&&Boolean(plan.readiness.cycle?.analysisReady);
      const inference=request.nodes.find(node=>node.id===cycle.stageNodeIds.inference);
      const context=JSON.stringify({pipelineVersion:cycle.pipelineVersion||1,inference:inference?.response?planningResponseBody(inference.response):null,feasibility:checked.context?JSON.parse(checked.context):null,plan:plan.response?planningResponseBody(plan.response):null,planRef,instruction:(advisory?'The recorded plan and readiness findings are advisory for this automatic run. Use available evidence and tools to investigate unresolved facts, adapt the plan to observations, and record results against its acceptance criteria.':'Execute the current recorded plan, preserve its constraints and dependencies, and record observations for every acceptance criterion. Treat required unresolved facts as dependencies.')+' Carry the inferred delegated task to completion under existing authority. Resolve model-repairable prerequisites with bounded checks before costly dependent work. Do not turn an action request into instructions for the human or hand back because of an installable program, already-authorized ordinary terms, a discoverable workflow or one malformed read. Stop the affected mutation for a confirmed missing right, explicit constraint, human Take or unresolved live operation; disclose its evidence and remedy and continue independent ready work.'});
      if(!plan.readiness.cycle?.analysisReady){await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycleId,pendingIntent:{id:'cycle-hold-'+run.id,kind:'continue_request',runId:run.id}}});return {...checked,skipped:false,cycleId,requestId:request.id,state:cycle.state,blockedNodeIds:run.workflow.nodes.filter(node=>node.type==='agent').map(node=>node.id),awaitingInput:true,question:cycle.summary||'The response plan needs a usable checked result before execution.',context};}
      if(mode==='plan_only'&&!continuation){
        if(request.viability?.pendingIntent)request=await this.taskViability.writer.configureViability(request.id,{completeIntentId:request.viability.pendingIntent.id,viability:{pendingIntent:null}});
        request=await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycleId,state:'paused_after_plan',planRef,linkedRunId:run.id}});
        return {...checked,skipped:false,cycleId,requestId:request.id,state:'paused_after_plan',pausedAfterPlan:true,planRef,
          responseCycle:{state:'paused_after_plan',planning:planningCycleEvidence(request,cycle)},
          blockedNodeIds:run.workflow.nodes.filter(node=>node.type==='agent').map(node=>node.id),awaitingInput:false,context,question:'Plan ready. Review or edit it, then continue from this exact revision when you choose.'};
      }
      const unresolvedRequiredChildren=request.cycles.filter(item=>item.parentCycleId===cycleId&&item.required!==false&&analyticalSubproblem(item.request)).some(child=>{const result=request.nodes.find(node=>node.id===child.stageNodeIds.respond),readiness=result?.readiness.cycle;return !readiness?.dispatchReady&&!workflowChildHandoffReady({state:child.state,analysisReady:readiness?.analysisReady,workflowHandoff:readiness?.workflowHandoff},{workflowOwner:{cycleId},requiredAcceptanceCriteria:plan.response?.acceptanceCriteria||[]});});
      if(!advisory&&!plan.readiness.cycle.dispatchReady&&(!checked.awaitingInput||unresolvedRequiredChildren)){
        const state=unresolvedRequiredChildren?'waiting_children':'needs_evidence',question=unresolvedRequiredChildren?'A required subproblem remains unresolved. Review its result before dependent work can continue.':'A recorded preparatory dependency remains unresolved. The proposed work is saved in Planning for review or continuation.';
        await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycleId,state,summary:question,pendingIntent:{id:'cycle-hold-'+run.id,kind:'continue_request',runId:run.id}}});
        return {...checked,skipped:false,cycleId,requestId:request.id,planRef,state,blockedNodeIds:run.workflow.nodes.filter(node=>node.type==='agent').map(node=>node.id),awaitingInput:true,question,context};
      }
      // Unknown facts requiring owner-accessible record or capability checks remain
      // unresolved dependencies, not questions to the human before the owner may
      // inspect them. A managed schedule may defer only findings for which the
      // readiness response did not actually ask the user a factual question.
      // The host's generic fallback question is not such a request. Confirmed
      // missing resources and authored factual questions remain held.
      const managedOwnerChecks=run.metadata?.managedBy!=='operations'||deferredOwnerChecks(feasibilityNode?.response,feasibilityReadiness);
      const ownerChecksDeferred=mode==='automatic'&&!advisory&&managedOwnerChecks
        &&checked.awaitingInput===true&&!request.viability?.recoveryIssue
        &&['awaiting_input','needs_evidence'].includes(feasibilityReadiness?.state)
        &&feasibilityReadiness.analysisReady===true
        &&feasibilityReadiness.blockingFacts.length>0
        &&feasibilityReadiness.blockingFacts.every(fact=>fact.resolution==='unknown')
        &&plan.readiness.cycle?.analysisReady===true&&!unresolvedRequiredChildren;
      const awaitingInput=Boolean(checked.awaitingInput&&!advisory&&!ownerChecksDeferred);
      if((advisory||ownerChecksDeferred)&&request.viability?.pendingIntent)request=await this.taskViability.writer.configureViability(request.id,{completeIntentId:request.viability.pendingIntent.id,viability:{pendingIntent:null}});
      const preparationState=confirmedBlocker?'blocked':awaitingInput?'awaiting_input':'executing';
      request=await this.writer.configureResponseCycle(request.id,{cyclePatch:{id:cycleId,state:preparationState,summary:confirmedBlocker?checked.question||'A confirmed resource prerequisite blocks the affected work.':'',planRef,linkedRunId:run.id,execution:{required:true,state:'running'},pendingIntent:awaitingInput?{id:'cycle-hold-'+run.id,kind:'continue_request',runId:run.id}:null}});
      return {...checked,skipped:false,cycleId,requestId:request.id,planRef,state:preparationState,context,
        responseCycle:{requestId:request.id,cycleId,state:preparationState,...(request.sources.some(item=>item.id===handoffContractSource(cycle).id&&item.contentHash===handoffContractSource(cycle).contentHash)?{handoffContract:{version:1,planRef,sourceId:handoffContractSource(cycle).id,sourceHash:handoffContractSource(cycle).contentHash}}:{}),planning:planningCycleEvidence(request,cycleOf(request,cycleId),{adoptedPlanRef:awaitingInput?null:planRef})},
        ...(advisory?{advisory:true,blockedNodeIds:[],awaitingInput:false}:ownerChecksDeferred?{ownerChecksDeferred:true,blockedNodeIds:[],awaitingInput:false,question:''}:{})};
    });
  }
  async finishRun(run,{signal,outputs=[],output,taskState,hostOnlyTools}={}){
    const requestId=run.responseCycle?.requestId||run.viability?.requestId;
    if(!requestId||run.planningMode==='off'||run.responseCycle?.state==='paused_after_plan')return null;
    return this.serialize(requestId,async()=>{
      signal?.throwIfAborted();
      let request=await this.store.get(requestId),cycleId=run.responseCycle?.cycleId||run.responseCycle?.planRef?.cycleId||request.responseCycle?.rootCycleId;if(!cycleId)return null;
      const currentCycle=cycleOf(request,cycleId),usedPlan=run.responseCycle?.planRef||run.viability?.planRef,currentPlan=request.nodes.find(node=>node.id===currentCycle.stageNodeIds.plan);
      if(usedPlan&&(!samePlan(usedPlan,refOf(request,currentCycle))||!currentPlan.readiness.cycle?.analysisReady)){
        const summary='The plan or its evidence changed while work was running. The recorded outputs belong to the earlier plan and require review against the new revision.';
        await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'stale',summary}});
        signal?.throwIfAborted();
        return {requestId,cycleId,state:'stale',responseCycle:{requestId,cycleId,state:'stale'},output:run.planningContractVersion===14?canonicalOutcomeSummary(null,summary):[...outputs.filter(item=>item.output).map(item=>(item.title||'Workflow result')+'\n'+item.output),summary].join('\n\n'),partial:true};
      }
      const canonical=await this.canonicalExecutionEvidence(run,request,{signal});
      const evidenceRun=await this.retainedObservationRun(run),mediaSource=await this.reviewMediaSource(run,request,currentCycle,{signal}),{projected,effectReceipts,records,reviewContext}=executionReviewContext(evidenceRun,request,currentCycle,outputs,{output,mediaSource,canonical});
      const state=outputs.some(item=>item.status==='failed')?'failed':outputs.some(item=>item.status==='cancelled')?'cancelled':'completed';
      request=await this.writer.configureResponseCycle(requestId,{replaceSourcePrefix:'cycle:execution:'+cycleId+':',sources:records,reviewContext:{cycleId,sourceId:reviewContext.id,sourceHash:reviewContext.contentHash},...(mediaSource?{reviewMedia:{cycleId:cycleId,sourceId:mediaSource.id,sourceHash:mediaSource.contentHash}}:{}),cyclePatch:{id:cycleId,state:'evaluating',execution:{required:true,state,runId:run.id},effectReceipts}});
      signal?.throwIfAborted();
      if(projected.limited||records.reduce((sum,source)=>sum+source.text.length,0)>EXECUTION_CONTEXT_CHARS){
        const summary='The operational records are preserved, but their receipt index exceeds the bounded evaluation context. The final analytical review was not performed.';
        await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'needs_evidence',summary}});
        signal?.throwIfAborted();
        return {requestId,cycleId,state:'needs_evidence',responseCycle:{requestId,cycleId,state:'needs_evidence'},output:canonical?canonicalOutcomeSummary(canonical.data,summary):[...outputs.filter(item=>item.output).map(item=>(item.title||'Worker report')+'\n'+item.output),summary].join('\n\n'),partial:true};
      }
      request=await this.drive(requestId,cycleId,{through:'respond',signal,budget:this.budget(request),runKey:run.id,hostOnlyTools});
      signal?.throwIfAborted();
      if(canonical){
        const latest=await this.canonicalExecutionEvidence(run,request,{signal});
        if(latest.sources[0].contentHash!==canonical.sources[0].contentHash){
          const summary='The canonical task or operation evidence changed during final review. Its actual results remain recorded; the final assessment must use the current snapshot.';
          await this.writer.configureResponseCycle(requestId,{replaceSourcePrefix:'cycle:execution:'+cycleId+':canonical-contract',sources:latest.sources,cyclePatch:{id:cycleId,state:'stale',summary,effectReceipts:latest.effectReceipts}});
          return {requestId,cycleId,state:'stale',responseCycle:{requestId,cycleId,state:'stale'},output:canonicalOutcomeSummary(latest.data,summary),partial:true};
        }
      }
      const cycle=cycleOf(request,cycleId),response=request.nodes.find(node=>node.id===cycle.stageNodeIds.respond);
      if(!response.readiness.cycle?.analysisReady){
        const summary='The operational results are recorded, but the final response has not passed its checks. '+(cycle.summary||'Review the open Planning stage.');
        return {requestId,cycleId,state:cycle.state,responseCycle:{requestId,cycleId,state:cycle.state},output:canonical?canonicalOutcomeSummary(canonical.data,summary):summary,partial:true,...(cycle.failure?{error:clone(cycle.failure)}:{})};
      }
      const answer=response.response.values.answer,question=run.viability?.awaitingInput?run.viability.question:null;
      return {requestId,cycleId,state:'completed',responseCycle:{requestId,cycleId,state:'completed',outcome:response.readiness.cycle.outcome},output:question&&!answer.includes(question)?answer+'\n\n'+question:answer,responseId:response.response.id,outcome:response.readiness.cycle.outcome};
    });
  }
  async settleRun(run,{state,error}={}){
    if(!['failed','cancelled'].includes(state))return null;
    const binding=this.runBindings.get(run.id),requestId=run.responseCycle?.requestId||run.viability?.requestId||binding?.requestId;
    if(!requestId)return null;
    return this.serialize(requestId,async()=>{
      const request=await this.store.get(requestId),cycleId=run.responseCycle?.cycleId||run.responseCycle?.planRef?.cycleId||binding?.cycleId||request.responseCycle?.rootCycleId;
      if(!cycleId)return null;
      const summary=String(error?.message||error||run.error||(state==='cancelled'?'Work was stopped. Its recorded results remain available.':'The workflow failed. Its recorded results remain available.')).slice(0,1800);
      const current=cycleOf(request,cycleId),execution=['completed','failed','cancelled','unknown'].includes(current.execution?.state)?current.execution:{required:true,state,runId:run.id};
      let settledRequest=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state,summary,execution,failure:{code:error?.code||run.errorCode||'RESPONSE_CYCLE_'+state.toUpperCase(),message:summary}}});
      if(state==='cancelled'){
        const owned=new Set([cycleId]);let changed=true;
        while(changed){changed=false;for(const child of request.cycles)if(!owned.has(child.id)&&owned.has(child.parentCycleId)&&(!child.linkedRunId||child.linkedRunId===run.id)){owned.add(child.id);changed=true;}}
        for(const child of request.cycles.filter(item=>item.id!==cycleId&&owned.has(item.id)&&!['completed','failed','cancelled'].includes(item.state)).sort((a,b)=>b.depth-a.depth)){
          settledRequest=await this.writer.configureResponseCycle(requestId,{cyclePatch:{id:child.id,state:'cancelled',summary,failure:{code:'RESPONSE_CYCLE_PARENT_CANCELLED',message:summary}}});
        }
      }
      run.responseCycle={...run.responseCycle,requestId,cycleId,state};
      return this.updated(settledRequest);
    });
  }
  async close(){this.closed=true;this.runner.off?.('updated',this.runtimeUsageListener);await Promise.allSettled([...this.queues.values(),...this.usageUpdates.values()]);}
}
