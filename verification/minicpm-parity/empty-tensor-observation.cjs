'use strict';
// Empty output reductions are observations of no data, never measured activations.
// This is deliberately restricted to the source-proven qwen35 request graph.
const {observeTextPositionCorrespondence}=require('./text-position-correspondence.cjs');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const modelFields=['modelArchitecture','modelLayerCount','modelMtpLayerCount','modelEmbeddingSize'];
const emptyFields=[
 'startupId','batchId','microbatchId','phase','name','anchor','layer','type','shape','strides',
 'bytes','elementCount','modelArchitecture','graphType','modelLayerCount','modelMtpLayerCount',
 'modelEmbeddingSize','disposition','sourceMicrobatchRows','sourceOutputRows',
 'sourceOutputMaskObserved','sourceMappingComplete','complete'
].sort();
const emptyAnchors=new Set(['attn_post_norm','ffn_out','l_out']);
function countNames(events){
 const counts={};
 for(const e of events){const name=e.data?.name;if(typeof name!=='string'||!name)return null;counts[name]=(counts[name]||0)+1;}
 return counts;
}
function sameMicro(event,data){
 return event.data?.startupId===data.startupId&&event.data?.batchId===data.batchId&&event.data?.microbatchId===data.microbatchId;
}
function observeEmptyTensors({events,startupEvent,contextEvent,activationCaptureEnabled,tensorSelection}){
 const issues=[],emptyTensorMappings=[],unassignedEmptyTensors=[],emptyByTask=new Map(),dispositionCounters=[];
 const startup=startupEvent?.data,context=contextEvent?.data,receipt=startup?.runtime;
 const empties=events.filter(e=>e.event==='tensor_empty');
 for(const event of empties){
  const t=event.data,errors=[];
  const reject=message=>errors.push(message);
  if(!plain(t)||!equal(Object.keys(t).sort(),emptyFields))reject('Empty tensor data must contain only the complete approved no-data descriptor; extra statistics, perToken, hashes and unknown fields are forbidden.');
  if(activationCaptureEnabled!==true)reject('Empty tensor observations are forbidden when activation capture is off.');
  if(t.complete!==true||t.disposition!=='output-mask-empty'||t.phase!=='request'||t.graphType!==0||
     !positive(t.batchId)||!positive(t.microbatchId)||t.startupId!==startup?.startupId||context?.startupId!==t.startupId)
   reject('Empty tensor is not bound to a published request/default-graph context.');
  if(t.modelArchitecture!=='qwen35'||!positive(t.modelLayerCount)||t.modelMtpLayerCount!==0||
     !positive(t.modelEmbeddingSize)||!Number.isSafeInteger(4*t.modelEmbeddingSize)||
     modelFields.some(field=>t[field]!==context?.[field]||t[field]!==receipt?.[field]))
   reject('Empty tensor model identity does not match the actual qwen35 startup/context fields with zero MTP layers.');
  if(t.layer!==t.modelLayerCount-1||!emptyAnchors.has(t.anchor)||t.name!==t.anchor+'-'+t.layer||
     !Array.isArray(tensorSelection)||!tensorSelection.includes(t.anchor))
   reject('Empty tensor is not a selected source-proven final-layer post-crop anchor.');
  if(t.type!=='f32'||t.bytes!==0||t.elementCount!==0||
     !equal(t.shape,[t.modelEmbeddingSize,0,1,1])||!equal(t.strides,[4,4*t.modelEmbeddingSize,0,0]))
   reject('Empty tensor descriptor is not the exact zero-byte F32 output reduction.');
  const batches=events.filter(e=>e.event==='server_batch_begin'&&e.data?.startupId===t.startupId&&e.data?.batchId===t.batchId);
  const micros=events.filter(e=>e.event==='microbatch_begin'&&sameMicro(e,t));
  const ends=events.filter(e=>e.event==='microbatch_end'&&sameMicro(e,t));
  const batchEvent=batches[0],microEvent=micros[0],end=ends[0],batch=batchEvent?.data,micro=microEvent?.data;
  const joined=[],positionCorrespondences=[];
  if(batches.length!==1||micros.length!==1||ends.length!==1||!Array.isArray(batch?.rows)||!Array.isArray(micro?.rows))
   reject('Empty tensor lacks one exact server batch, microbatch and terminal.');
  else{
   if(!(startupEvent?.processSequence<batchEvent.processSequence&&batchEvent.processSequence<microEvent.processSequence&&
        microEvent.processSequence<event.processSequence&&event.processSequence<end.processSequence))
    reject('Empty tensor ordering does not prove published startup followed by its request batch, microbatch and terminal.');
   if(micro.phase!=='request'||micro.graphType!==0||micro.outputMaskObserved!==true||micro.sourceMappingComplete!==true||
      !positive(micro.nTokens)||micro.nTokens!==micro.rows.length||t.sourceMicrobatchRows!==micro.rows.length||
      t.sourceOutputRows!==0||t.sourceOutputMaskObserved!==true||t.sourceMappingComplete!==true||
      !positive(micro.nPositionSections)||micro.nPositionSections>4||
      micro.rows.some(row=>!plain(row)||!Object.hasOwn(row,'output')||row.output!==false))
    reject('Empty tensor has no explicit, complete, all-false output mask for its actual nonempty request microbatch.');
   const ids=[...new Set(batch.rows.filter(plain).filter(row=>nonnegative(row.taskId)).map(row=>row.taskId))];
   if(ids.length!==1)reject('A parallel=1 empty tensor server batch must bind exactly one native task.');
   const rowIds=micro.rows.map(row=>row?.microRow),batchRows=micro.rows.map(row=>row?.batchRow);
   if(rowIds.some((value,index)=>value!==index)||new Set(batchRows).size!==batchRows.length)
    reject('Empty tensor source micro rows are non-contiguous or reuse server rows.');
   for(const row of micro.rows){
    if(!plain(row)){reject('Empty tensor contains a malformed source micro row.');continue;}
    const matches=batch.rows.filter(item=>plain(item)&&item.batchRow===row.batchRow);
    const bound=matches[0],positionCorrespondence=observeTextPositionCorrespondence({serverRow:bound,microbatchRow:row,nPositionSections:micro.nPositionSections});
    positionCorrespondences.push({microRow:row.microRow,batchRow:row.batchRow,positionCorrespondence});
    if(!nonnegative(row.batchRow)||matches.length!==1||!nonnegative(bound?.taskId)||bound.taskId!==ids[0]||
       !nonnegative(bound.slotId)||bound.output!==false||!Number.isSafeInteger(bound.embeddingRow)||bound.embeddingRow>=0||
       row.inputKind!=='token'||!Array.isArray(row.sequenceIds)||!row.sequenceIds.length||
       row.sequenceIds.some(id=>!Number.isSafeInteger(id))||!row.sequenceIds.includes(bound.slotId)||
       !nonnegative(bound.tokenId)||row.tokenId!==bound.tokenId||
       !Array.isArray(row.positions)||row.positions.length!==micro.nPositionSections||
       !Array.isArray(bound.positions)||bound.positions.length<micro.nPositionSections||!positionCorrespondence.complete){
     reject('Empty tensor source row does not map exactly to one native task, slot, token and position. Position conflicts: '+JSON.stringify(positionCorrespondence.conflicts));continue;
    }
    joined.push({taskId:bound.taskId,slotId:bound.slotId,microRow:row.microRow,batchRow:row.batchRow,tokenId:bound.tokenId,positions:row.positions,
     inputKind:row.inputKind,sequenceIds:row.sequenceIds,embeddingRow:bound.embeddingRow,output:row.output,serverOutput:bound.output,positionCorrespondence});
   }
   if(joined.length!==micro.rows.length)reject('Empty tensor source row coverage is incomplete.');
  }
  const successful=end?.data.complete===true&&end?.data.graphStatus===0;
  const observation={evidence:event.evidence,data:t,successful,graphStatus:end?.data.graphStatus??null,
   startupEvidence:startupEvent?.evidence??null,contextEvidence:contextEvent?.evidence??null,
   batchEvidence:batchEvent?.evidence??null,microbatchEvidence:microEvent?.evidence??null,terminalEvidence:end?.evidence??null,rows:joined,positionCorrespondences};
  if(errors.length){unassignedEmptyTensors.push({...observation,errors});continue;}
  emptyTensorMappings.push(observation);
  if(successful){const key=String(t.startupId)+':'+joined[0].taskId;emptyByTask.set(key,(emptyByTask.get(key)||0)+1);}
 }
 if(unassignedEmptyTensors.length)issues.push({error:'Some empty tensor observations lack the exact approved no-data/mask/task proof.',unassignedEmptyTensors});
 // New emitters publish separate disposition counters. Old metadata-only receipts
 // remain readable; any empty event or either new counter makes all maps mandatory.
 for(const end of events.filter(e=>e.event==='microbatch_end'&&e.data?.batchId!==0)){
  const d=end.data,measured=events.filter(e=>e.event==='tensor_statistics'&&sameMicro(e,d)),empty=empties.filter(e=>sameMicro(e,d));
  if(!empty.length&&!Object.hasOwn(d,'measuredTensors')&&!Object.hasOwn(d,'emptyTensors'))continue;
  const actualMeasured=countNames(measured),actualEmpty=countNames(empty);
  const actualObserved=actualMeasured&&actualEmpty?{...actualMeasured}:null;
  if(actualObserved)for(const [name,count] of Object.entries(actualEmpty))actualObserved[name]=(actualObserved[name]||0)+count;
  const successful=d.complete===true&&d.graphStatus===0;
  let expectedObserved=null;
  if(activationCaptureEnabled===true&&receipt?.modelArchitecture==='qwen35'&&receipt.modelMtpLayerCount===0&&positive(receipt.modelLayerCount)&&
     Array.isArray(tensorSelection)&&tensorSelection.length&&new Set(tensorSelection).size===tensorSelection.length&&
     tensorSelection.every(anchor=>anchor==='attn_norm'||emptyAnchors.has(anchor))){
   expectedObserved={};for(let layer=0;layer<receipt.modelLayerCount;layer++)for(const anchor of tensorSelection)expectedObserved[anchor+'-'+layer]=1;
  }
  const counters={evidence:end.evidence,startupId:d.startupId,batchId:d.batchId,microbatchId:d.microbatchId,successful,
   observedTensors:d.observedTensors??null,measuredTensors:d.measuredTensors??null,emptyTensors:d.emptyTensors??null,
   actualObservedTensors:actualObserved,actualMeasuredTensors:actualMeasured,actualEmptyTensors:actualEmpty,expectedObservedTensors:expectedObserved};
  dispositionCounters.push(counters);
  if(successful&&(!plain(d.observedTensors)||!plain(d.measuredTensors)||!plain(d.emptyTensors)||
      !equal(d.observedTensors,actualObserved)||!equal(d.measuredTensors,actualMeasured)||!equal(d.emptyTensors,actualEmpty)||
      Object.values(d.observedTensors).some(count=>count!==1)))
   issues.push({error:'Successful microbatch disposition counters differ from actual measured/empty events or duplicate an anchor.',...counters});
  if(successful&&expectedObserved&&!equal(actualObserved,expectedObserved))
   issues.push({error:'Successful qwen35 microbatch does not contain exactly one selected disposition at every actual model layer.',...counters});
 }
 return {issues,emptyTensorMappings,unassignedEmptyTensors,emptyByTask,dispositionCounters};
}
module.exports={observeEmptyTensors};
