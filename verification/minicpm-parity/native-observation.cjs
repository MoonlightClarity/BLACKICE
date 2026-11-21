'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {sha}=require('./parity-contract.cjs');
const {observeEmptyTensors}=require('./empty-tensor-observation.cjs');
const {observeTextPositionCorrespondence}=require('./text-position-correspondence.cjs');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function collectNative({directory,pid,probes,activationCaptureEnabled,configBytes,configPath,propsRuntime}){
 const issues=[],files=[],events=[],tasks={},failedMicrobatchAttempts=[],fileMap=new Map();
 const names=fs.existsSync(directory)?fs.readdirSync(directory).filter(n=>n.startsWith(String(pid)+'-')).sort():[];
 const issue=(message,extra={})=>issues.push({error:message,...extra});
 for(const name of names){
  const file=path.join(directory,name),stat=fs.statSync(file);if(!stat.isFile())continue;
  const bytes=fs.readFileSync(file),identity={path:file,bytes:bytes.length,sha256:sha(bytes)};files.push(identity);fileMap.set(path.resolve(file).toLowerCase(),identity);
  if(name.endsWith('.invalid.json'))issue('Native invalid receipt exists.',{file});
  if(!name.endsWith('.jsonl'))continue;
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{issue('Invalid UTF-8 in native JSONL.',{file});continue;}if(!text.endsWith('\n'))issue('Incomplete JSONL tail.',{file});
  let previous=0;
  for(const [lineNo,line] of text.split('\n').entries()){
   if(!line)continue;
   let event;try{event=JSON.parse(line);}catch{issue('Invalid JSONL.',{file,line:lineNo+1});continue;}
   if(event.schema!=='blackice.minicpm.live-trace.v1'||event.pid!==pid||typeof event.event!=='string'||!event.data){issue('Invalid native event identity.',{file,line:lineNo+1});continue;}
   if(!Number.isSafeInteger(event.fileSequence)||event.fileSequence!==previous+1)issue('Missing/non-contiguous fileSequence, including the first event.',{file,line:lineNo+1});
   previous=event.fileSequence;events.push({...event,evidence:{path:file,line:lineNo+1}});
  }
 }
 events.sort((a,b)=>a.processSequence-b.processSequence);
 const processIds=[...new Set(events.map(e=>e.processId))];
 if(processIds.length!==1||typeof processIds[0]!=='string'||!processIds[0])issue('One owned native process identity is required.');
 const processSequences=events.map(e=>e.processSequence);
 if(processSequences.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(processSequences).size!==processSequences.length)issue('Native global process sequence is missing or duplicated.');
 function artifact(ref,label){
  if(!ref||typeof ref.path!=='string'||!path.isAbsolute(ref.path)){issue(label+' artifact reference is absent.');return null;}
  const known=fileMap.get(path.resolve(ref.path).toLowerCase());
  if(!known||known.bytes!==ref.bytes||known.sha256!==ref.sha256){issue(label+' artifact readback differs or is outside this owned process output.',{reference:ref});return null;}
  return known;
 }
 const processStarts=events.filter(e=>e.event==='process_start'),contexts=events.filter(e=>e.event==='context_start'),startups=events.filter(e=>e.event==='runtime_startup');
 if(processStarts.length!==1||contexts.length!==1||startups.length!==1)issue('Exactly one process/context/runtime startup is required.');
 let expectedConfig=null,configSha256=null;
 if(!Buffer.isBuffer(configBytes)&&!(configBytes instanceof Uint8Array))issue('Exact host trace-config bytes are required.');
 else{
  configBytes=Buffer.from(configBytes);configSha256=sha(configBytes);
  try{expectedConfig=JSON.parse(configBytes.toString('utf8'));}catch{issue('Host trace configuration is invalid JSON.');}
 }
 if(expectedConfig){
  const effective={...expectedConfig,logitVectorSteps:expectedConfig.logitVectorSteps??0,maxTensorBytes:67108864,budgetScope:'all recorder files in one process'};
  if(expectedConfig.activationCaptureEnabled!==activationCaptureEnabled||expectedConfig.enabled!==true||path.resolve(expectedConfig.outputDirectory||'').toLowerCase()!==path.resolve(directory).toLowerCase())issue('Host requested trace configuration does not match this observation.');
  for(const e of [...processStarts,...contexts]){
   const d=e.data;
   if(e.event==='process_start'&&(typeof d.configSource!=='string'||!d.configSource||typeof d.configPath!=='string'||typeof configPath!=='string'||path.resolve(d.configPath).toLowerCase()!==path.resolve(configPath).toLowerCase()))issue('Native configuration source/path differs from the explicit host override.');
   if(typeof d.configBytesUtf8!=='string'||!Buffer.from(d.configBytesUtf8).equals(configBytes)||d.configSha256!==configSha256||sha(Buffer.from(d.configBytesUtf8||''))!==configSha256)issue('Native configuration bytes/hash do not match the exact saved host file.',{event:e.event,evidence:e.evidence});
   if(!equal(d.effectiveConfig,effective))issue('Native effective configuration differs.',{event:e.event,expected:effective,actual:d.effectiveConfig});
  }
 }
 const startup=startups[0]?.data;
 if(startup){
  if(startup.runtime?.complete!==true||startup.runtime?.droppedEvents!==0)issue('Native startup receipt is incomplete or reports dropped events.');
  const saved=artifact(startup.receipt,'Runtime startup');
  if(saved){try{const actual=JSON.parse(fs.readFileSync(saved.path,'utf8'));if(!equal(actual,startup.runtime))issue('Runtime startup JSON differs from its event.');}catch{issue('Runtime startup JSON is invalid.');}}
  if(!propsRuntime||!equal(startup.runtime,propsRuntime))issue('Live /props runtime receipt differs from the native startup event.');
  if(startup.runtime?.pid!==pid||startup.runtime?.startupId!==startup.startupId||contexts[0]?.data.startupId!==startup.startupId)issue('Context/startup/PID identity differs.');
 }
 function localArtifact(ref,label,local){const before=issues.length,result=artifact(ref,label);if(issues.length>before)local.push(label+' readback failed.');return result;}
 for(const end of events.filter(e=>e.event==='microbatch_end'&&e.data.batchId!==0)){const d=end.data;if(d.complete===false&&Number.isInteger(d.graphStatus)&&d.graphStatus!==0){failedMicrobatchAttempts.push({evidence:end.evidence,...d});continue;}if(d.complete!==true||d.graphStatus!==0||d.activationCaptureEnabled!==activationCaptureEnabled||!Array.isArray(d.missingOrDuplicateTensors)||d.missingOrDuplicateTensors.length)issue('A nonfailed microbatch end lacks successful complete coverage.',{evidence:end.evidence,data:d});}
 const tensorByTask=new Map(),tensorMappings=[],unassignedTensors=[];
 for(const tensor of events.filter(e=>e.event==='tensor_statistics')){
  const t=tensor.data;if(t.batchId===0||t.phase==='initialization')continue;
  if(t.bytes===0||(Array.isArray(t.shape)&&t.shape.some(size=>size===0))){unassignedTensors.push({evidence:tensor.evidence,data:t,reason:'A zero-sized tensor cannot be counted as measured activation statistics.'});continue;}
  const batches=events.filter(e=>e.event==='server_batch_begin'&&e.data.startupId===t.startupId&&e.data.batchId===t.batchId);
  const micros=events.filter(e=>e.event==='microbatch_begin'&&e.data.startupId===t.startupId&&e.data.batchId===t.batchId&&e.data.microbatchId===t.microbatchId);
  if(batches.length!==1||micros.length!==1||!Array.isArray(batches[0]?.data.rows)||!Array.isArray(micros[0]?.data.rows)||!Array.isArray(t.perToken)||!t.perToken.length){unassignedTensors.push({evidence:tensor.evidence,reason:'Missing exact batch/microbatch/per-token rows.'});continue;}
  const batch=batches[0].data,micro=micros[0].data,sectionCount=micro.nPositionSections;
  if(!Number.isInteger(sectionCount)||sectionCount<1){unassignedTensors.push({evidence:tensor.evidence,reason:'Missing authoritative position-section count.'});continue;}
  const ids=[...new Set(batch.rows.filter(r=>Number.isInteger(r.taskId)&&r.taskId>=0).map(r=>r.taskId))];
  if(ids.length!==1){unassignedTensors.push({evidence:tensor.evidence,reason:'A parallel=1 server batch does not bind exactly one task.'});continue;}
  const joined=[];
  for(const stats of t.perToken){
   const m=micro.rows.filter(r=>r.microRow===stats.microRow),b=m.length===1?batch.rows.filter(r=>r.batchRow===m[0].batchRow):[];
   const positionCorrespondence=observeTextPositionCorrespondence({serverRow:b.length===1?b[0]:null,microbatchRow:m.length===1?m[0]:null,nPositionSections:sectionCount});
   if(m.length!==1||b.length!==1||!Number.isInteger(b[0].taskId)||b[0].taskId<0||m[0].tokenId!==b[0].tokenId||
      !Array.isArray(m[0].positions)||!Array.isArray(b[0].positions)||!positionCorrespondence.complete){
    unassignedTensors.push({evidence:tensor.evidence,microRow:stats.microRow,positionCorrespondence,reason:'Tensor row does not map exactly to the native task/token/positions.'});continue;
   }
   joined.push({taskId:b[0].taskId,slotId:b[0].slotId,microRow:stats.microRow,batchRow:m[0].batchRow,tokenId:b[0].tokenId,positions:m[0].positions,positionCorrespondence});
  }
  if(joined.length!==t.perToken.length)continue;
  const ends=events.filter(e=>e.event==='microbatch_end'&&e.data.startupId===t.startupId&&e.data.batchId===t.batchId&&e.data.microbatchId===t.microbatchId);if(ends.length!==1){unassignedTensors.push({evidence:tensor.evidence,reason:'No unique microbatch end.'});continue;}
  const successful=ends[0].data.complete===true&&ends[0].data.graphStatus===0,taskId=joined[0].taskId,key=String(t.startupId)+':'+taskId;
  if(successful)tensorByTask.set(key,(tensorByTask.get(key)||0)+1);
  tensorMappings.push({evidence:tensor.evidence,successful,graphStatus:ends[0].data.graphStatus,startupId:t.startupId,batchId:t.batchId,microbatchId:t.microbatchId,name:t.name,anchor:t.anchor,layer:t.layer,rows:joined});
 }
 if(unassignedTensors.length)issue('Some non-initialization tensor statistics have no exact task row mapping.',{unassignedTensors});
 const emptyObservation=observeEmptyTensors({events,startupEvent:startups[0],contextEvent:contexts[0],activationCaptureEnabled,tensorSelection:expectedConfig?.tensorSelection});
 issues.push(...emptyObservation.issues);
 const allSamples=events.filter(e=>e.event==='sample_logits');
 if(allSamples.some((e,i)=>e.data.sampleId!==i+1))issue('Context-global sample IDs are missing or non-contiguous.');
 const vectorEvidence=[];
 for(const sample of allSamples){
  if(expectedConfig&&((sample.data.sampleId<=expectedConfig.logitVectorSteps)!==Boolean(sample.data.rawFloat32Vector)))issue('Raw vector availability differs from the configured first context-global samples.',{sampleId:sample.data.sampleId});
  if(!Number.isSafeInteger(sample.data.vocabularySize)||sample.data.vocabularySize<1)issue('Actual vocabulary size is missing from sample logits.');
  if(sample.data.rawFloat32Vector){if(sample.data.rawFloat32Vector.sha256!==sample.data.rawFloat32Sha256||sample.data.rawFloat32Vector.bytes!==4*sample.data.vocabularySize||sample.data.vectorEncoding!=='IEEE754 float32 little-endian, vocabulary token ID order')issue('Saved logit-vector reference does not match the sample digest, vocabulary size, or encoding.',{sampleId:sample.data.sampleId});const a=artifact(sample.data.rawFloat32Vector,'Raw logit vector');if(a)vectorEvidence.push({sampleId:sample.data.sampleId,taskId:sample.data.taskId,...a});}
 }
 for(const [name,probe] of Object.entries(probes||{})){
  const local=[];
  const requests=events.filter(e=>e.event==='http_request'&&e.data.exchangeId===probe.request.exchangeId&&e.data.attemptId===probe.request.attemptId);
  if(requests.length!==1){issue('Exact native HTTP attempt is missing or duplicated.',{probe:name});continue;}
  const http=requests[0],h=http.data,serverRequestId=h.serverRequestId;
  if(h.bodyObserved!==true||h.bodySha256!==probe.request.bodySha256||h.hostRequestSha256!==probe.request.bodySha256||h.bodyBytes!==probe.request.bodyBytes)local.push('Native request does not prove the actual received body.');
  const body=localArtifact(h.body,'Native request body',local);
  if(body){
   if(body.sha256!==probe.request.bodySha256||body.bytes!==probe.request.bodyBytes)local.push('Native request body hash/length differs from host capture.');
   try{if(!fs.readFileSync(body.path).equals(fs.readFileSync(probe.request.body.path)))local.push('Native request bytes differ from exact host bytes.');}catch{local.push('Exact request bytes cannot be read back.');}
  }
  let expectedStreaming=null;
  try{
   const hostBytes=fs.readFileSync(probe.request.body.path),wire=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(hostBytes));
   if(typeof wire?.stream!=='boolean')local.push('Exact request body has no explicit boolean streaming mode.');
   else expectedStreaming=wire.stream;
  }catch{local.push('Exact request streaming mode cannot be read from the saved body.');}
  const registrations=events.filter(e=>e.event==='task_registered'&&e.data.serverRequestId===serverRequestId);
  if(registrations.length!==1){issue('One native task registration is required.',{probe:name});continue;}
  const registration=registrations[0],taskId=registration.data.taskId,startupId=registration.data.startupId;
  if(!Number.isInteger(taskId)||taskId<0||startupId!==startup?.startupId)local.push('Native task/context identity is invalid.');
  const owns=e=>e.data.taskId===taskId&&e.data.startupId===startupId;
  const accepted=events.filter(e=>e.event==='accepted_token'&&owns(e)),samples=allSamples.filter(owns);
  const terminal=events.filter(e=>e.event==='task_terminal'&&owns(e)),release=events.filter(e=>e.event==='slot_release'&&owns(e));
  const observed=events.filter(e=>e.event==='http_response_observed'&&e.data.serverRequestId===serverRequestId);
  const generator=events.filter(e=>e.event==='http_generator_end'&&e.data.serverRequestId===serverRequestId);
  const prompt=registration.data.promptTokenIds,completionId=registration.data.completionId;
  if(!Array.isArray(prompt)||!prompt.length||!prompt.every(x=>Number.isSafeInteger(x)&&x>=0))local.push('Actual post-template prompt tokens are missing.');
  if(typeof completionId!=='string'||!completionId)local.push('Actual completion ID is absent.');
  if(probe.kind==='chat'&&probe.result.responseId!==completionId)local.push('Actual SSE completion ID differs from the registered task.');
  if(!accepted.length||accepted.some((e,i)=>!Number.isSafeInteger(e.data.tokenId)||e.data.tokenId<0||e.data.ordinal!==i+1))local.push('Accepted token IDs/ordinals are missing or non-contiguous.');
  if(!samples.length||samples.some(e=>!Number.isSafeInteger(e.data.sampledTokenId)||e.data.sampledTokenId<0||!Number.isSafeInteger(e.data.sampleId)||e.data.sampleId<1||!/^[a-f0-9]{64}$/.test(e.data.rawFloat32Sha256||'')))local.push('Sampled tokens or exact raw logit hashes are missing.');
  if(!equal(accepted.map(e=>e.data.tokenId),samples.map(e=>e.data.sampledTokenId)))local.push('Accepted tokens differ from the native sampled-token sequence.');
  if(terminal.length!==1||terminal[0].data.traceComplete!==true||terminal[0].data.droppedEvents!==0||terminal[0].data.outcome!=='completed')local.push('No unique complete native task terminal.');
  if(terminal.length===1&&(terminal[0].data.acceptedTokenEvents!==accepted.length||terminal[0].data.sampleLogitEvents!==samples.length||terminal[0].data.completionId!==completionId))local.push('Task terminal counts/identity differ from observed events.');
  if(release.length!==1||release[0].data.hadTaskTerminal!==true)local.push('No fsynced slot-release confirmation.');
  if(observed.length!==1||observed[0].data.status!==200)local.push('No unique successful pre-write HTTP status observation.');
  if(generator.length!==1||generator[0].data.complete!==true||generator[0].data.status!==200)local.push('No unique complete HTTP generator terminal with status 200.');
  if(generator.length===1){
   const g=generator[0].data;
   if(expectedStreaming===null||g.streaming!==expectedStreaming)local.push('Native generator streaming mode differs from the exact request body.');
   if(expectedStreaming===true&&(g.transportProviderSuccess!==true||g.producerExhausted!==true||g.sinkDoneCalled!==true||g.chunkWriteFailed!==false))
    local.push('Streaming completion lacks raw transport success, producer exhaustion, done invocation, or absence of chunk-write failure.');
   if(expectedStreaming===false&&[g.transportProviderSuccess,g.producerExhausted,g.sinkDoneCalled,g.chunkWriteFailed].some(value=>value!==null))
    local.push('Nonstream generator terminal must explicitly leave streaming transport facts null.');
  }
  const activationEvents=tensorByTask.get(String(startupId)+':'+taskId)||0,emptyTensorEvents=emptyObservation.emptyByTask.get(String(startupId)+':'+taskId)||0;
  if(activationCaptureEnabled&&activationEvents===0)local.push('Activation capture is on but no selected tensor event maps to this task.');
  if(!activationCaptureEnabled&&activationEvents!==0)local.push('Activation events appeared while activation capture was off.');
  const batches=events.filter(e=>e.event==='server_batch_begin'&&e.data.startupId===startupId&&Array.isArray(e.data.rows)&&e.data.rows.some(r=>r.taskId===taskId)).map(e=>e.data.batchId);
  const ends=events.filter(e=>e.event==='microbatch_end'&&e.data.startupId===startupId&&batches.includes(e.data.batchId));
  const successfulEnds=ends.filter(e=>e.data.complete===true&&e.data.graphStatus===0);if(!batches.length||batches.some(id=>!successfulEnds.some(e=>e.data.batchId===id)))local.push('A task batch has no successful complete microbatch attempt.');
  if(activationCaptureEnabled&&(!successfulEnds.length||successfulEnds.some(e=>!Array.isArray(e.data.missingOrDuplicateTensors)||e.data.missingOrDuplicateTensors.length)))local.push('Successful native selected-tensor coverage has missing/duplicate tensors.');
  tasks[name]={complete:local.length===0,serverRequestId,taskId,startupId,completionId,promptTokenIds:prompt??null,
   acceptedTokenIds:accepted.map(e=>e.data.tokenId),sampledTokenIds:samples.map(e=>e.data.sampledTokenId),sampleIds:samples.map(e=>e.data.sampleId),
   rawLogitHashes:samples.map(e=>e.data.rawFloat32Sha256),activationEvents,emptyTensorEvents,bindingEvidence:http.evidence,registrationEvidence:registration.evidence,
   terminalEvidence:terminal.map(e=>e.evidence),
   httpEvidence:{requestedStreaming:expectedStreaming,responseStatusObservations:observed.map(e=>({data:e.data,evidence:e.evidence})),generatorTerminals:generator.map(e=>({data:e.data,evidence:e.evidence}))},
   issues:local};
  if(local.length)issue('Native task span did not qualify.',{probe:name,errors:local});
 }
 if(Object.keys(tasks).length!==Object.keys(probes||{}).length)issue('Not every inference request has a native task span.');
 return {schema:'blackice.minicpm.parity-native-observation.v1',complete:issues.length===0,pid,processId:processIds[0]??null,
  startupId:startup?.startupId??null,configSha256,files,tasks,tensorMappings,unassignedTensors,failedMicrobatchAttempts,vectorEvidence,
  emptyTensorMappings:emptyObservation.emptyTensorMappings,unassignedEmptyTensors:emptyObservation.unassignedEmptyTensors,tensorDispositionCounters:emptyObservation.dispositionCounters,
  emptyTensorScope:'Empty tensors prove an observed zero-row final-layer output reduction and contain no measured statistics or raw data hash. Their separate counts never contribute to activationEvents.',
  vectorScope:'Vectors are retained only for the first configured context-global samples. Later samples have exact hashes; no numerical tolerance claim is inferred from missing vectors.',
  httpEvidenceScope:'The HTTP logger observes status before response writes. Streaming completion requires independent producer, done-invocation, chunk-write and raw resource-releaser facts. Nonstream generator completion is not transport proof. Actual client receipt remains separate in the host HTTP captures.',
  issues,lifetimeScope:'Only terminal-confirmed task spans. Deliberate Windows termination does not claim clean process/context destructor events.'};
}
module.exports={collectNative};
