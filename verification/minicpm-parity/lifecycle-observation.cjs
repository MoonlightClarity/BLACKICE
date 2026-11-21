'use strict';
// Pure single-process sleep/wake qualification. This is not a model-quality score.
const path=require('node:path'),crypto=require('node:crypto');
const C=require('./parity-contract.cjs');
const {observeTextPositionCorrespondence}=require('./text-position-correspondence.cjs');
const {normalizeContextPublication}=require('../minicpm-infrastructure/controller/context-publication-observation.cjs');
const SCHEMA='blackice.minicpm.runtime-lifecycle-observation.v1',MANIFEST_SCHEMA='blackice.minicpm.fresh-lifecycle-bundle.v1';
const SOURCE_COMMIT='b1b770d90d94cad9e9ea5b993bdbc383a522fb28';
const ORIGINAL_SHA='0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a';
const SHA=/^[a-f0-9]{64}$/,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0,positive=v=>integer(v)&&v>0;
const text=v=>typeof v==='string'&&v.length>0;
const bytes=v=>Buffer.isBuffer(v)?v:v instanceof Uint8Array?Buffer.from(v.buffer,v.byteOffset,v.byteLength):null;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const key=p=>typeof p==='string'?path.win32.normalize(p).toLowerCase():'';
const absolute=p=>typeof p==='string'&&/^[A-Za-z]:[\\/]/.test(p)&&path.win32.isAbsolute(p);
const time=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))?Date.parse(s):null;
const same=(a,b)=>C.same(a,b),must=(ok,code,message)=>C.insist(ok,message,code);
function identity(row){return object(row)&&absolute(row.path)&&positive(row.bytes)&&SHA.test(row.sha256||'');}
function validateManifest(manifest,{manifestPath,executable,executableSha256}){
 must(manifest?.schema===MANIFEST_SCHEMA&&manifest.sourceState?.sourceCommit===SOURCE_COMMIT,'LIFECYCLE_MANIFEST','Exact reviewed fresh lifecycle manifest/source is required.');
 must(absolute(manifestPath)&&absolute(executable)&&SHA.test(executableSha256||'')&&identity(manifest.binary),'LIFECYCLE_MANIFEST','Explicit manifest and executable identities are required.');
 const bin=path.win32.join(path.win32.dirname(manifestPath),'bin');
 must(key(path.win32.dirname(executable))===key(bin)&&path.win32.basename(executable).toLowerCase()==='llama-server.exe'&&key(manifest.binary.path)===key(executable)&&manifest.binary.sha256===executableSha256,'LIFECYCLE_MANIFEST','Executable does not belong to the bound frozen bin directory.');
 must(Array.isArray(manifest.files)&&manifest.files.length>1&&manifest.files.every(identity),'LIFECYCLE_MANIFEST','Frozen executable/DLL identities are required.');
 const paths=manifest.files.map(x=>key(x.path));
 must(new Set(paths).size===paths.length&&manifest.files.every(x=>key(path.win32.dirname(x.path))===key(bin)&&(key(x.path)===key(executable)||/\.dll$/i.test(x.path))),'LIFECYCLE_MANIFEST','Frozen file paths are duplicate or outside the bundle.');
 must(manifest.files.some(x=>key(x.path)===key(executable)&&x.bytes===manifest.binary.bytes&&x.sha256===manifest.binary.sha256),'LIFECYCLE_MANIFEST','Binary and file-list identity differ.');
 must(Array.isArray(manifest.loadedMathLibraries)&&manifest.loadedMathLibraries.length>0&&manifest.loadedMathLibraries.every(x=>identity(x)&&manifest.files.some(f=>key(f.path)===key(x.path)&&f.bytes===x.bytes&&f.sha256===x.sha256)),'LIFECYCLE_MANIFEST','Observed math library identities are not bound to frozen files.');
 must(typeof manifest.version==='string'&&Array.isArray(manifest.cliReceipts)&&manifest.cliReceipts.length>0,'LIFECYCLE_MANIFEST','Frozen version output and CLI receipt references are required.');
 const versions=[...manifest.version.matchAll(/^version: [^\r\n]+ \(build (0|[1-9]\d*), commit ([a-f0-9]{7,40})\)\r?$/gm)];
 must(versions.length===1&&SOURCE_COMMIT.startsWith(versions[0][2]),'LIFECYCLE_BUILD','Observed CLI build cannot be bound to pinned source.');
 return {manifestSchema:manifest.schema,build:'b'+versions[0][1]+'-'+versions[0][2],binary:structuredClone(manifest.binary),files:structuredClone(manifest.files)};
}
function compareBundle(actual,manifest){
 must(Array.isArray(actual)&&actual.length===manifest.files.length,'LIFECYCLE_BUNDLE','Actual bundle file inventory differs.');
 for(const f of manifest.files)must(actual.filter(a=>key(a.path)===key(f.path)&&a.bytes===f.bytes&&a.sha256===f.sha256).length===1,'LIFECYCLE_BUNDLE','Actual frozen file identity differs: '+path.win32.basename(f.path));
 return true;
}
function parseArtifactJSON(raw,label){
 const b=bytes(raw);must(b!==null,'LIFECYCLE_BYTES','Exact bytes missing: '+label);
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{throw C.fail('Invalid UTF-8 JSON: '+label,'LIFECYCLE_JSON');}
}
function observeLifecycle(input={}){
 const result={schema:SCHEMA,complete:false,scorable:false,throughputClaim:false,scope:'One observed awake/sleep/wake cycle and one settled native generation; not continuous liveness or whole-process clean shutdown.',publications:{before:null,after:null},sleep:null,task:null,positionMappings:[],phases:{initializationMicrobatches:0,requestMicrobatches:0,failedGraphAttempts:[]},volume:{inventoryComplete:false,files:0,bytes:0,measuredTensorEvents:null,emptyTensorEvents:null,sampledTokens:null,acceptedTokens:null,logitVectorFiles:0},failures:[]};
 try{
  const profile=C.validateProfile(input.profile),proc=input.processIdentity,configBytes=bytes(input.config?.bytes),config=parseArtifactJSON(configBytes,'trace config');
  must(positive(proc?.pid)&&time(proc.startedAt)!==null&&absolute(proc.executablePath),'LIFECYCLE_PROCESS','Actual independent child identity is required.');
  must(input.modelIdentity?.sha256===ORIGINAL_SHA&&absolute(input.modelIdentity.path),'LIFECYCLE_MODEL','Unchanged original GGUF identity is required.');
  must(config.schema==='blackice.minicpm.trace-config.v1'&&config.enabled===true&&config.activationCaptureEnabled===false&&config.logitVectorSteps===0&&config.maxBytes===profile.trace.maxBytes&&same(config.tensorSelection,profile.trace.tensorSelection)&&absolute(config.outputDirectory)&&absolute(input.config.path)&&sha(configBytes)===input.config.sha256,'LIFECYCLE_CONFIG','Exact immutable metadata-only trace config is required.');
  const publication=(name,value)=>{
   must(object(value)&&object(value.input)&&object(value.raw),'LIFECYCLE_PUBLICATION','Missing publication capture '+name);
   const q=normalizeContextPublication({...value.input,now:input.now,maxEvidenceAgeMs:120000},value.raw);result.publications[name]=q;
   must(q.complete,'LIFECYCLE_PUBLICATION','Current publication '+name+' is incomplete: '+JSON.stringify({missing:q.missing,conflicts:q.conflicts}));
   const n=value.input.propsResponse.json.blackice_runtime,p=value.input.propsResponse.json;
   must(n.pid===proc.pid&&n.processStartedAt===proc.startedAt&&key(n.modelPath)===key(input.modelIdentity.path)&&n.modelId===profile.modelAlias&&n.build===input.expectedBuild,'LIFECYCLE_PUBLICATION','Publication is not the observed process/model/build.');
   for(const [field,value]of Object.entries(profile.runtime)){
    if(field==='jinja')continue;
    const expected=field==='flashAttention'?value==='on':value;
    must(n.runtime?.[field]===expected,'LIFECYCLE_RUNTIME','Actual runtime field differs: '+field);
   }
   must(p.default_generation_settings?.n_ctx===profile.runtime.ctxSize&&p.total_slots===profile.runtime.parallel&&n.totalContextSize===profile.runtime.ctxSize&&n.projector?.loaded===false&&p.modalities?.vision===false&&p.modalities?.video===false,'LIFECYCLE_RUNTIME','Actual full context/slots or absent projector is unverified.');
   const map={seed:'seed',temperature:'temperature',topK:'top_k',topP:'top_p',minP:'min_p'};
   for(const[field,wire]of Object.entries(map)){const expected=['seed','topK'].includes(field)?profile.sampling[field]:Math.fround(profile.sampling[field]);must(p.default_generation_settings?.params?.[wire]===expected,'LIFECYCLE_SAMPLING','Observed sampler differs: '+field);}
   must(n.configSha256===sha(configBytes),'LIFECYCLE_CONFIG','Context used different trace configuration.');
   return n;
  };
  const first=publication('before',input.before),second=publication('after',input.after);
  must(first.id!==second.id,'LIFECYCLE_CONTEXT_REUSED','Wake did not publish a fresh context identity.');
  must(same(first.runtime,second.runtime)&&same(first.fieldSources,second.fieldSources),'LIFECYCLE_RUNTIME','Effective runtime changed across sleep/wake.');
  const asleep=input.sleep?.json;
  must(input.sleep?.status===200&&asleep?.is_sleeping===true&&asleep.blackice_runtime_state==='sleeping'&&asleep.blackice_runtime===null&&same(asleep.blackice_previous_runtime,first),'LIFECYCLE_SLEEP','Sleeping state did not explicitly retire the current publication.');
  must(time(input.before.input.currentPublication.propsAfterResponse.at)<=time(input.sleep.at)&&time(input.sleep.at)<=time(input.completion?.request?.at),'LIFECYCLE_ORDER','Sleep/request observation order is invalid.');
  result.sleep={at:input.sleep.at,previousStartupId:first.id,currentRuntime:null};

  const artifacts=input.trace?.artifacts;
  must(Array.isArray(artifacts)&&artifacts.length>0&&artifacts.length<=1000,'LIFECYCLE_TRACE','Bounded complete trace artifacts are required.');
  const files=new Map(),events=[];let processId=null,total=0;
  for(const a of artifacts){
   const b=bytes(a.bytes),again=bytes(a.rereadBytes),relative=path.win32.relative(config.outputDirectory,a.path||'');
   must(absolute(a.path)&&relative&&!relative.startsWith('..')&&!path.win32.isAbsolute(relative)&&b&&again&&b.equals(again),'LIFECYCLE_TRACE','Trace path or independent byte reread differs.');
   must(!files.has(key(a.path)),'LIFECYCLE_TRACE','Duplicate trace artifact.');
   total+=b.length;must(total<=config.maxBytes,'LIFECYCLE_TRACE_LIMIT','Trace capture exceeds its configured byte bound.');
   const f={path:a.path,bytes:b.length,sha256:sha(b),raw:b};files.set(key(a.path),f);
   result.volume.files++;result.volume.bytes=total;
   if(a.path.endsWith('.invalid.json'))throw C.fail('Native invalid marker is present.','LIFECYCLE_NATIVE_INVALID');
   if(/\.sample-\d+\.f32$/.test(a.path))result.volume.logitVectorFiles++;
   if(!a.path.endsWith('.jsonl'))continue;
   must(b.length>0&&b[b.length-1]===10,'LIFECYCLE_TRACE_PARTIAL','Trace JSONL ends with a partial line.');
   const lines=new TextDecoder('utf-8',{fatal:true}).decode(b).split('\n');lines.pop();
   for(let index=0;index<lines.length;index++){
    const e=JSON.parse(lines[index]);
    must(e.schema==='blackice.minicpm.live-trace.v1'&&e.pid===proc.pid&&e.processStartedAt===proc.startedAt&&text(e.processId)&&positive(e.processSequence)&&e.fileSequence===index+1&&object(e.data),'LIFECYCLE_TRACE_IDENTITY','Native event identity or sequence is invalid.');
    if(processId===null)processId=e.processId;must(processId===e.processId,'LIFECYCLE_TRACE_IDENTITY','Unexpected second native process identity.');
    must(path.win32.basename(a.path).startsWith(proc.pid+'-'+processId+'.'),'LIFECYCLE_TRACE_IDENTITY','Native filename/header identity differs.');
    e.evidence={path:a.path,line:index+1};events.push(e);
   }
  }
  result.volume.inventoryComplete=true;
  result.volume.measuredTensorEvents=events.filter(e=>e.event==='tensor_statistics').length;result.volume.emptyTensorEvents=events.filter(e=>e.event==='tensor_empty').length;result.volume.sampledTokens=events.filter(e=>e.event==='sample_logits').length;result.volume.acceptedTokens=events.filter(e=>e.event==='accepted_token').length;
  const contextPaths=new Map([[first.id,first.traceFile],[second.id,second.traceFile]]);
  for(const e of events){const expected=e.data.startupId===undefined?path.win32.join(config.outputDirectory,proc.pid+'-'+processId+'.process.jsonl'):contextPaths.get(e.data.startupId);must(expected&&key(e.evidence.path)===key(expected),'LIFECYCLE_CONTEXT','Native event belongs to an unobserved context or contradictory file.');}
  events.sort((a,b)=>a.processSequence-b.processSequence);
  must(events.every((e,n)=>e.processSequence===n+1),'LIFECYCLE_TRACE_GAP','Native process sequence is missing or duplicated.');
  const one=(rows,label)=>{must(rows.length===1,'LIFECYCLE_UNIQUE','Expected one '+label+', observed '+rows.length);return rows[0];};
  const processStart=one(events.filter(e=>e.event==='process_start'),'process start');
  must(key(processStart.data.executablePath)===key(proc.executablePath)&&processStart.data.sourceCommit===SOURCE_COMMIT&&processStart.data.configSource==='explicit-environment-override','LIFECYCLE_PROCESS','Actual executable/source/configuration source differs.');
  must(processStart.data.configPath===input.config.path&&processStart.data.configSha256===sha(configBytes)&&processStart.data.configBytesUtf8===configBytes.toString('utf8'),'LIFECYCLE_CONFIG','Actual process configuration source differs.');
  const contexts=new Map();
  for(const id of [first.id,second.id]){
   const rows=events.filter(e=>e.data.startupId===id),start=one(rows.filter(e=>e.event==='context_start'),'context start '+id),pub=one(rows.filter(e=>e.event==='runtime_startup'),'publication '+id);
   must(start.processSequence<pub.processSequence&&pub.data.runtime.id===id,'LIFECYCLE_CONTEXT','Context publication order is invalid.');
   must(start.data.configSha256===sha(configBytes)&&start.data.configBytesUtf8===configBytes.toString('utf8'),'LIFECYCLE_CONFIG','Context configuration changed.');
   const ref=pub.data.receipt,f=files.get(key(ref?.path));
   must(f&&f.bytes===ref.bytes&&f.sha256===ref.sha256&&same(parseArtifactJSON(f.raw,'native startup'),pub.data.runtime),'LIFECYCLE_STARTUP','Native startup artifact/event differs.');
   must(same(pub.data.runtime,id===first.id?first:second),'LIFECYCLE_STARTUP','Full trace publication differs from observed props.');
   contexts.set(id,{rows,start,pub,ends:rows.filter(e=>e.event==='context_end')});
  }
  must(events.filter(e=>e.event==='context_start').length===2,'LIFECYCLE_CONTEXT','Unexpected extra context creation.');
  const old=contexts.get(first.id),current=contexts.get(second.id),oldEnd=one(old.ends,'ended first context');
  must(oldEnd.data.complete===true&&oldEnd.data.droppedEvents===0&&oldEnd.processSequence<current.start.processSequence,'LIFECYCLE_CONTEXT','The old context was not cleanly retired before recreation.');
  must(current.ends.length<=1&&current.ends.every(e=>time(e.at)>time(input.after.input.currentPublication.propsAfterResponse.at)),'LIFECYCLE_CONTEXT','The claimed new awake context had already ended.');
  const host=input.completion,bodyBytes=bytes(host?.requestBytes),responseBytes=bytes(host?.responseBytes);
  must(host?.request?.method==='POST'&&host.request.route==='/completion'&&host.request.complete===true&&bodyBytes&&sha(bodyBytes)===host.request.bodySha256&&bodyBytes.length===host.request.bodyBytes&&host.response?.status===200&&host.response.complete===true&&responseBytes&&sha(responseBytes)===host.response.bodySha256&&responseBytes.length===host.response.bodyBytes&&host.response.terminal==='http-body-eof','LIFECYCLE_HTTP','Complete exact host completion exchange is required.');
  const requestBody=parseArtifactJSON(bodyBytes,'completion request');
  must(same(requestBody,{...C.completionBody(profile),n_predict:8}),'LIFECYCLE_REQUEST','The fixed tiny native request differs.');
  const returned=C.validateCompletion(parseArtifactJSON(responseBytes,'completion response'));
  const nativeRequests=events.filter(e=>e.event==='http_request'&&e.data.method==='POST');
  const http=one(nativeRequests,'generation POST');
  const hd=http.data,savedBody=files.get(key(hd.body?.path));
  must(hd.path==='/completion'&&hd.bodyObserved===true&&hd.exchangeId===host.request.exchangeId&&hd.attemptId===host.request.attemptId&&hd.hostRequestSha256===sha(bodyBytes)&&hd.bodySha256===sha(bodyBytes)&&savedBody&&savedBody.raw.equals(bodyBytes)&&savedBody.bytes===hd.bodyBytes&&savedBody.bytes===hd.body.bytes&&savedBody.sha256===hd.body.sha256,'LIFECYCLE_REQUEST_BINDING','Native raw request is not the exact owned host attempt.');
  must(host.response.headers?.['x-blackice-server-request-id']===hd.serverRequestId&&host.response.headers?.['x-blackice-attempt-id']===hd.attemptId,'LIFECYCLE_REQUEST_BINDING','Observed response headers do not bind to the native attempt.');
  const registered=one(events.filter(e=>e.event==='task_registered'),'registered generation'),rd=registered.data;
  must(rd.startupId===second.id&&registered.processSequence>current.pub.processSequence&&rd.serverRequestId===hd.serverRequestId&&Number.isInteger(rd.taskId)&&text(rd.completionId),'LIFECYCLE_TASK','Generation did not bind to the new published context.');
  const taskRows=current.rows.filter(e=>e.data.taskId===rd.taskId),assigned=one(taskRows.filter(e=>e.event==='task_slot_assigned'),'assigned slot'),slot=assigned.data.slotId;
  must(integer(slot)&&assigned.processSequence>registered.processSequence,'LIFECYCLE_TASK','Actual ordered slot assignment is unavailable.');
  must(rd.renderedPrompt===requestBody.prompt&&Array.isArray(rd.promptTokenIds)&&rd.promptTokenIds.length>0&&rd.promptTokenIds.every(integer)&&rd.generationParams?.n_predict===8&&rd.generationParams?.stream===false,'LIFECYCLE_TASK','Actual native task prompt/generation controls differ.');
  for(const [field,wire]of Object.entries({seed:'seed',temperature:'temperature',topK:'top_k',topP:'top_p',minP:'min_p'})){const expected=['seed','topK'].includes(field)?profile.sampling[field]:Math.fround(profile.sampling[field]);must(rd.generationParams?.[wire]===expected,'LIFECYCLE_TASK','Actual generation sampler differs: '+field);}
  const terminal=one(taskRows.filter(e=>e.event==='task_terminal'),'task terminal'),release=one(taskRows.filter(e=>e.event==='slot_release'),'slot release');
  const samples=taskRows.filter(e=>e.event==='sample_logits'),accepted=taskRows.filter(e=>e.event==='accepted_token');
  must(terminal.data.outcome==='completed'&&terminal.data.traceComplete===true&&terminal.data.droppedEvents===0&&terminal.data.truncated===false&&terminal.data.completionId===rd.completionId&&terminal.data.slotId===slot&&release.data.hadTaskTerminal===true&&release.data.slotId===slot&&release.processSequence>terminal.processSequence,'LIFECYCLE_TERMINAL','Task/release termination is incomplete.');
  must(samples.length>0&&samples.length===accepted.length&&terminal.data.sampleLogitEvents===samples.length&&terminal.data.acceptedTokenEvents===accepted.length,'LIFECYCLE_TOKENS','Native token counts differ.');
  must(samples.every((e,n)=>e.data.slotId===slot&&integer(e.data.sampledTokenId)&&e.data.sampledTokenId===accepted[n].data.tokenId&&e.processSequence<accepted[n].processSequence&&accepted[n].processSequence<terminal.processSequence&&e.data.rawFloat32Vector===undefined&&e.data.logitsAvailable===true&&positive(e.data.vocabularySize)&&SHA.test(e.data.rawFloat32Sha256||''))&&accepted.every((e,n)=>e.data.slotId===slot&&e.data.ordinal===n+1),'LIFECYCLE_TOKENS','Native sampled/accepted token sequence differs.');
  const response=one(events.filter(e=>e.event==='http_response_observed'&&e.data.serverRequestId===hd.serverRequestId),'HTTP status observation'),generator=one(events.filter(e=>e.event==='http_generator_end'&&e.data.serverRequestId===hd.serverRequestId),'HTTP generator terminal');
  must(response.data.status===200&&generator.data.status===200&&generator.data.complete===true&&generator.data.streaming===false&&['transportProviderSuccess','producerExhausted','sinkDoneCalled','chunkWriteFailed'].every(k=>generator.data[k]===null),'LIFECYCLE_HTTP','Nonstream generator/status evidence differs.');
  const batches=new Map();
  for(const e of current.rows.filter(e=>e.event==='server_batch_begin')){
   must(e.processSequence>current.pub.processSequence&&positive(e.data.batchId)&&Array.isArray(e.data.rows)&&e.data.rows.length>0&&!batches.has(e.data.batchId),'LIFECYCLE_BATCH','Request batch is missing or precedes publication.');
   must(e.data.rows.every((r,n)=>r.batchRow===n&&r.taskId===rd.taskId&&r.slotId===slot&&integer(r.tokenId)&&Number.isInteger(r.embeddingRow)&&r.embeddingRow<0&&Array.isArray(r.positions)&&r.positions.length===4&&r.positions.every(Number.isInteger)&&typeof r.output==='boolean'),'LIFECYCLE_BATCH','Request batch ownership is incomplete.');batches.set(e.data.batchId,e);
  }
  for(const e of events.filter(e=>e.event==='microbatch_begin')){
   const context=contexts.get(e.data.startupId);must(context,'LIFECYCLE_PHASE','Microbatch belongs to an unexpected context.');
   if(e.processSequence<context.pub.processSequence){must(e.data.phase==='initialization','LIFECYCLE_PHASE','Actual pre-publication work was not initialization.');result.phases.initializationMicrobatches++;continue;}
   const b=batches.get(e.data.batchId);
   must(e.data.startupId===second.id&&e.data.phase==='request'&&e.data.sourceMappingComplete===true&&b&&b.processSequence<e.processSequence&&Array.isArray(e.data.rows)&&e.data.rows.length>0&&e.data.nTokens===e.data.rows.length&&positive(e.data.nPositionSections)&&e.data.nPositionSections<=4,'LIFECYCLE_PHASE','Actual request work lacks published phase/ownership.');
   for(const [index,r]of e.data.rows.entries()){
    const bound=b.data.rows[r.batchRow],positionCorrespondence=observeTextPositionCorrespondence({serverRow:bound,microbatchRow:r,nPositionSections:e.data.nPositionSections});
    result.positionMappings.push({startupId:e.data.startupId,batchId:e.data.batchId,microbatchId:e.data.microbatchId,microRow:r.microRow,batchRow:r.batchRow,taskId:bound?.taskId??null,slotId:bound?.slotId??null,positionCorrespondence});
    must(bound&&r.microRow===index&&r.inputKind==='token'&&r.tokenId===bound.tokenId&&Array.isArray(r.positions)&&positionCorrespondence.complete&&Array.isArray(r.sequenceIds)&&r.sequenceIds.length>0&&r.sequenceIds.every(integer)&&r.sequenceIds.includes(slot)&&r.output===bound.output,'LIFECYCLE_PHASE','Microbatch row is not mapped to the owned request. Position conflicts: '+JSON.stringify(positionCorrespondence.conflicts));
   }
   const end=one(current.rows.filter(x=>x.event==='microbatch_end'&&x.data.batchId===e.data.batchId&&x.data.microbatchId===e.data.microbatchId),'microbatch end');
   must(end.processSequence>e.processSequence&&typeof end.data.graphStatus==='number','LIFECYCLE_PHASE','Microbatch termination is missing.');
   if(end.data.graphStatus===0)must(end.data.complete===true&&end.data.activationCaptureEnabled===false&&Array.isArray(end.data.missingOrDuplicateTensors)&&end.data.missingOrDuplicateTensors.length===0,'LIFECYCLE_PHASE','Successful metadata compute has incomplete coverage.');
   else {must(end.data.complete===false,'LIFECYCLE_PHASE','Failed graph attempt was mislabeled complete.');result.phases.failedGraphAttempts.push({batchId:e.data.batchId,microbatchId:e.data.microbatchId,graphStatus:end.data.graphStatus});}
   result.phases.requestMicrobatches++;
  }
  must(result.phases.requestMicrobatches>0&&batches.size>0,'LIFECYCLE_PHASE','No owned post-wake compute was observed.');
  for(const sample of samples){const b=batches.get(sample.data.batchId),row=b?.data.rows?.[sample.data.batchRow];must(row&&row.taskId===rd.taskId&&row.slotId===slot&&row.output===true&&b.processSequence<sample.processSequence,'LIFECYCLE_TOKENS','Sample is not mapped to an actual owned output row.');}
  result.volume.measuredTensorEvents=events.filter(e=>e.event==='tensor_statistics').length;result.volume.emptyTensorEvents=events.filter(e=>e.event==='tensor_empty').length;result.volume.sampledTokens=samples.length;result.volume.acceptedTokens=accepted.length;
  must(result.volume.measuredTensorEvents===0&&result.volume.emptyTensorEvents===0&&result.volume.logitVectorFiles===0,'LIFECYCLE_METADATA_ONLY','Metadata-only probe unexpectedly captured activation/vector files.');
  result.task={startupId:second.id,taskId:rd.taskId,slotId:slot,completionId:rd.completionId,serverRequestId:hd.serverRequestId,acceptedTokenIds:accepted.map(e=>e.data.tokenId),sampledTokenIds:samples.map(e=>e.data.sampledTokenId),returnedCompletion:returned,returnedTokenMapping:'Preserved separately; no equivalence to native accepted tokens is inferred.',httpMeaning:'Client observed a complete response body. Native nonstream generator completion is scoped generator evidence, not a transport success boolean.'};
  result.complete=true;
 }catch(e){result.failures.push({code:e.code||e.name,message:String(e.message||e)});}
 return result;
}
module.exports={SCHEMA,MANIFEST_SCHEMA,SOURCE_COMMIT,ORIGINAL_SHA,validateManifest,compareBundle,observeLifecycle};
