'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {sha}=require('./parity-contract.cjs');
const {collectNative}=require('./native-observation.cjs');
function fixture(activationCaptureEnabled=false,streaming=true){
 const root=fs.mkdtempSync(path.join(process.env.BLACKICE_PARITY_TEST_ROOT||os.tmpdir(),'blackice-parity-native-fixture-')),directory=path.join(root,'trace');fs.mkdirSync(directory);
 const pid=12345,prefix=pid+'-fixture',startupId='fixture-context',taskId=7,processId='fixture-process',serverRequestId='fixture-request',completionId='chatcmpl_fixture';
 const config={schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled,outputDirectory:directory,tensorSelection:['attn_norm','attn_post_norm','ffn_out','l_out'],maxBytes:268435456,logitVectorSteps:8};
 const configBytes=Buffer.from(JSON.stringify(config,null,2)+'\n'),configPath=path.join(root,'config.json');fs.writeFileSync(configPath,configBytes);
 const effectiveConfig={...config,maxTensorBytes:67108864,budgetScope:'all recorder files in one process'};
 function file(name,bytes){const p=path.join(directory,prefix+name);fs.writeFileSync(p,bytes);return {path:p,bytes:bytes.length,sha256:sha(bytes)};}
 const bodyBytes=Buffer.from(JSON.stringify({model:'fixture',messages:[{role:'user',content:'fixture'}],stream:streaming})),body=file('.request-fixture.body.bin',bodyBytes),hostBody=path.join(root,'host-request.bin');fs.writeFileSync(hostBody,bodyBytes);
 const vector=file('.ctx-fixture.sample-1.f32',Buffer.from([0,0,128,63,0,0,0,64]));
 const propsRuntime={schema:'blackice.minicpm.runtime-startup.v1',id:startupId,startupId,pid,complete:true,droppedEvents:0,processStartedAt:'2026-11-21T00:00:00.000Z'};
 const startupFile=file('.ctx-fixture.startup.json',Buffer.from(JSON.stringify(propsRuntime)+'\n'));
 const processEvents=[],contextEvents=[];let processSequence=0;
 function event(event,data,file='context'){const list=file==='process'?processEvents:contextEvents;const e={schema:'blackice.minicpm.live-trace.v1',event,pid,processId,processStartedAt:'2026-11-21T00:00:00.000Z',processSequence:++processSequence,fileSequence:list.length+1,data};list.push(e);return e;}
 const source={configSource:'explicit-environment',configPath,configSha256:sha(configBytes),configBytesUtf8:configBytes.toString(),effectiveConfig};
 event('process_start',source,'process');event('context_start',{...source,startupId});event('runtime_startup',{startupId,receipt:startupFile,runtime:propsRuntime});
 const http=event('http_request',{serverRequestId,exchangeId:'host-exchange',attemptId:'host-attempt',bodyObserved:true,bodySha256:body.sha256,bodyBytes:body.bytes,hostRequestSha256:body.sha256,body},'process');
 event('task_registered',{startupId,taskId,completionId,serverRequestId,promptTokenIds:[10,20],renderedPrompt:'fixture'});
 event('task_slot_assigned',{startupId,taskId,slotId:0});
 const batch=event('server_batch_begin',{startupId,batchId:1,rows:[{batchRow:0,taskId,slotId:0,tokenId:20,positions:[1,0,0,0],isPrompt:true,output:true,embeddingRow:-1}]});
 const micro=event('microbatch_begin',{startupId,batchId:1,microbatchId:2,nPositionSections:1,rows:[{microRow:0,batchRow:0,tokenId:20,inputKind:'token',positions:[1],sequenceIds:[0],output:true}]});
 let tensor=null;
 if(activationCaptureEnabled)tensor=event('tensor_statistics',{startupId,batchId:1,microbatchId:2,phase:'decode',name:'l_out-0',anchor:'l_out',layer:0,shape:[1024,1,1,1],strides:[4,4096,4096,4096],bytes:4096,rawFloat32Sha256:'a'.repeat(64),perToken:[{microRow:0,mean:1}]});
 event('microbatch_end',{startupId,batchId:1,microbatchId:2,complete:true,graphStatus:0,activationCaptureEnabled,observedTensors:activationCaptureEnabled?{'l_out-0':1}:{},missingOrDuplicateTensors:[]});
 const sample=event('sample_logits',{startupId,taskId,slotId:0,batchId:1,batchRow:0,sampleId:1,sampledTokenId:5,vocabularySize:2,vectorEncoding:'IEEE754 float32 little-endian, vocabulary token ID order',rawFloat32Sha256:vector.sha256,rawFloat32Vector:vector});
 const accepted=event('accepted_token',{startupId,taskId,slotId:0,ordinal:1,tokenId:5});
 const terminal=event('task_terminal',{startupId,taskId,slotId:0,outcome:'completed',completionId,traceComplete:true,droppedEvents:0,acceptedTokenEvents:1,sampleLogitEvents:1});
 event('slot_release',{startupId,taskId,slotId:0,hadTaskTerminal:true});
 event('http_response_observed',{serverRequestId,status:200},'process');const generator=event('http_generator_end',{serverRequestId,status:200,streaming,complete:true,transportProviderSuccess:streaming?true:null,producerExhausted:streaming?true:null,sinkDoneCalled:streaming?true:null,chunkWriteFailed:streaming?false:null},'process');
 const probes={probe:{kind:'chat',request:{exchangeId:'host-exchange',attemptId:'host-attempt',bodySha256:body.sha256,bodyBytes:body.bytes,body:{path:hostBody}},result:{responseId:completionId}}};
 function flush(){fs.writeFileSync(path.join(directory,prefix+'.process.jsonl'),processEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');fs.writeFileSync(path.join(directory,prefix+'.ctx-fixture.jsonl'),contextEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');}
 const input={directory,pid,probes,activationCaptureEnabled,configBytes,configPath,propsRuntime};
 return {root,input,config,body,vector,source,http,batch,micro,tensor,sample,accepted,terminal,generator,processEvents,contextEvents,flush,observe(){flush();return collectNative(input);},close(){fs.rmSync(root,{recursive:true,force:true});}};
}
test('complete native fixture joins actual received bytes, config/startup and task terminals',()=>{const f=fixture();try{const o=f.observe();assert.equal(o.complete,true,JSON.stringify(o.issues));assert.deepEqual(o.tasks.probe.acceptedTokenIds,[5]);assert.equal(o.vectorEvidence.length,1);}finally{f.close();}});
test('headers-only request or altered raw body cannot qualify',()=>{for(const mutate of [f=>f.http.data.bodyObserved=false,f=>fs.writeFileSync(f.body.path,'changed'),f=>f.http.data.hostRequestSha256='b'.repeat(64)]){const f=fixture();try{mutate(f);assert.equal(f.observe().complete,false);}finally{f.close();}}});
test('native config bytes or live startup mutation cannot be silently accepted',()=>{for(const mutate of [f=>f.source.configBytesUtf8+=' ',f=>f.input.propsRuntime={...f.input.propsRuntime,startupId:'other'},f=>f.source.effectiveConfig.activationCaptureEnabled=true]){const f=fixture();try{mutate(f);assert.equal(f.observe().complete,false);}finally{f.close();}}});
test('missing generator completion, token counts, sample sequence or file events fail',()=>{for(const mutate of [f=>f.generator.data.complete=false,f=>f.terminal.data.acceptedTokenEvents=2,f=>f.sample.data.sampleId=3,f=>f.contextEvents[2].fileSequence+=1]){const f=fixture();try{mutate(f);assert.equal(f.observe().complete,false);}finally{f.close();}}});
test('activation task attribution follows explicit batch and microbatch rows',()=>{const f=fixture(true);try{const o=f.observe();assert.equal(o.complete,true,JSON.stringify(o.issues));assert.equal(o.tasks.probe.activationEvents,1);assert.equal(o.tensorMappings[0].rows[0].taskId,7);assert.equal(f.tensor.data.taskId,undefined);f.tensor.data.perToken[0].microRow=99;assert.equal(f.observe().complete,false);}finally{f.close();}});
test('reduced final-layer tensor can cover only output-mask rows; four server position sections are not falsely compared to one core section',()=>{
 const f=fixture(true);try{f.batch.data.rows.push({batchRow:1,taskId:7,slotId:0,tokenId:21,positions:[2,0,0,0],isPrompt:true,output:true,embeddingRow:-1});f.micro.data.rows.push({microRow:1,batchRow:1,tokenId:21,inputKind:'token',positions:[2],sequenceIds:[0],output:true});f.micro.data.rows[0].output=false;f.tensor.data.perToken=[{microRow:1,mean:1}];assert.equal(f.observe().complete,true);f.micro.data.rows[1].positions=[9];assert.equal(f.observe().complete,false);}finally{f.close();}
});
test('saved logit-vector mutation is detected, never replaced with a tolerance claim',()=>{const f=fixture();try{fs.writeFileSync(f.vector.path,Buffer.alloc(8));assert.equal(f.observe().complete,false);}finally{f.close();}});

test('sample/file digest, vocabulary shape, encoding and accepted-token agreement are separate requirements',()=>{
 for(const mutate of [f=>f.sample.data.rawFloat32Sha256='c'.repeat(64),f=>f.sample.data.vocabularySize=3,f=>f.sample.data.vectorEncoding='unknown',f=>f.accepted.data.tokenId=6]){
  const f=fixture();try{mutate(f);assert.equal(f.observe().complete,false);}finally{f.close();}
 }
});
test('failed graph attempts remain explicit while a successful retry supplies actual coverage',()=>{
 const f=fixture(true);try{
  const oldEnd=f.contextEvents.find(e=>e.event==='microbatch_end'),position=f.contextEvents.indexOf(oldEnd)+1,base=oldEnd.processSequence;
  const goodEnd=structuredClone(oldEnd);oldEnd.data.complete=false;oldEnd.data.graphStatus=1;delete oldEnd.data.missingOrDuplicateTensors;
  const begin=structuredClone(f.micro),tensor=structuredClone(f.tensor);for(const e of [begin,tensor,goodEnd])e.data.microbatchId=3;
  begin.processSequence=base+.1;tensor.processSequence=base+.2;goodEnd.processSequence=base+.3;
  f.contextEvents.splice(position,0,begin,tensor,goodEnd);
  [...f.contextEvents,...f.processEvents].sort((a,b)=>a.processSequence-b.processSequence).forEach((e,i)=>e.processSequence=i+1);
  f.contextEvents.forEach((e,i)=>e.fileSequence=i+1);f.processEvents.forEach((e,i)=>e.fileSequence=i+1);
  const observed=f.observe();assert.equal(observed.complete,true,JSON.stringify(observed.issues));assert.equal(observed.failedMicrobatchAttempts.length,1);assert.equal(observed.tasks.probe.activationEvents,1);assert.deepEqual(observed.tensorMappings.map(x=>x.successful),[false,true]);
 }finally{f.close();}
});

test('streaming terminal preserves raw failure and rejects missing, null or contradictory producer/transport facts',()=>{
 const required={transportProviderSuccess:true,producerExhausted:true,sinkDoneCalled:true,chunkWriteFailed:false};
 const mutations=[];
 for(const [field,value] of Object.entries(required)){
  mutations.push(f=>delete f.generator.data[field],f=>f.generator.data[field]=null,f=>f.generator.data[field]=!value);
 }
 mutations.push(f=>f.generator.data.streaming=false,f=>delete f.generator.data.streaming,f=>f.generator.data.status=500);
 for(const mutate of mutations){
  const f=fixture();try{
   mutate(f);const observed=f.observe();
   assert.equal(observed.complete,false,JSON.stringify(f.generator.data));
   assert.deepEqual(observed.tasks.probe.httpEvidence.generatorTerminals[0].data,f.generator.data);
   assert.equal(observed.tasks.probe.httpEvidence.requestedStreaming,true);
  }finally{f.close();}
 }
 // Exhaustion and done invocation cannot convert the native raw false outcome into success.
 const f=fixture();try{
  f.generator.data.transportProviderSuccess=false;
  const observed=f.observe();assert.equal(observed.complete,false);
  assert.equal(observed.tasks.probe.httpEvidence.generatorTerminals[0].data.transportProviderSuccess,false);
 }finally{f.close();}
});
test('nonstream completion retains null streaming facts and explicitly remains separate from transport proof',()=>{
 const f=fixture(false,false);try{
  f.input.probes.probe.kind='completion';const observed=f.observe();
  assert.equal(observed.complete,true,JSON.stringify(observed.issues));
  assert.equal(observed.tasks.probe.httpEvidence.requestedStreaming,false);
  assert.deepEqual(observed.tasks.probe.httpEvidence.generatorTerminals[0].data,f.generator.data);
  assert.match(observed.httpEvidenceScope,/Nonstream generator completion is not transport proof/);
 }finally{f.close();}
 const fields=['transportProviderSuccess','producerExhausted','sinkDoneCalled','chunkWriteFailed'];
 for(const field of fields)for(const value of [true,false,undefined]){
  const x=fixture(false,false);try{
   if(value===undefined)delete x.generator.data[field];else x.generator.data[field]=value;
   assert.equal(x.observe().complete,false,field+': '+String(value));
  }finally{x.close();}
 }
 for(const stream of [null,'false']){
  const x=fixture(false,stream);try{assert.equal(x.observe().complete,false);}finally{x.close();}
 }
});


function emptyFixture(){
 const f=fixture(true),startup=f.contextEvents.find(e=>e.event==='runtime_startup'),context=f.contextEvents.find(e=>e.event==='context_start');
 const model={modelArchitecture:'qwen35',modelLayerCount:24,modelMtpLayerCount:0,modelEmbeddingSize:1024};
 Object.assign(f.input.propsRuntime,model);Object.assign(context.data,model);
 function syncStartup(){const bytes=Buffer.from(JSON.stringify(f.input.propsRuntime)+'\n');fs.writeFileSync(startup.data.receipt.path,bytes);startup.data.receipt.bytes=bytes.length;startup.data.receipt.sha256=sha(bytes);}
 syncStartup();
 Object.assign(f.micro.data,{phase:'request',graphType:0,nTokens:1,sourceMappingComplete:true,outputMaskObserved:true});
 Object.assign(f.micro.data.rows[0],{output:false,inputKind:'token'});
 Object.assign(f.batch.data.rows[0],{output:false,embeddingRow:-1});
 const end=f.contextEvents.find(e=>e.event==='microbatch_end'),at=f.contextEvents.indexOf(f.tensor),base=f.tensor.processSequence;
 const measured=[],empties=[],selected=f.config.tensorSelection,dispositions=[];
 for(let layer=0;layer<model.modelLayerCount;layer++)for(const anchor of selected){
  const isEmpty=layer===23&&anchor!=='attn_norm',data=isEmpty?{
   startupId:f.micro.data.startupId,batchId:1,microbatchId:2,phase:'request',name:anchor+'-'+layer,anchor,layer,
   type:'f32',shape:[1024,0,1,1],strides:[4,4096,0,0],bytes:0,elementCount:0,...model,graphType:0,
   disposition:'output-mask-empty',sourceMicrobatchRows:1,sourceOutputRows:0,sourceOutputMaskObserved:true,sourceMappingComplete:true,complete:true
  }:{...structuredClone(f.tensor.data),phase:'request',name:anchor+'-'+layer,anchor,layer,type:'f32'};
  const event={...f.tensor,event:isEmpty?'tensor_empty':'tensor_statistics',data,processSequence:base+dispositions.length/1000};
  (isEmpty?empties:measured).push(event);dispositions.push(event);
 }
 f.contextEvents.splice(at,1,...dispositions);
 end.data.observedTensors=Object.fromEntries(dispositions.map(e=>[e.data.name,1]));
 end.data.measuredTensors=Object.fromEntries(measured.map(e=>[e.data.name,1]));
 end.data.emptyTensors=Object.fromEntries(empties.map(e=>[e.data.name,1]));
 function reindex(){
  [...f.contextEvents,...f.processEvents].sort((a,b)=>a.processSequence-b.processSequence).forEach((e,i)=>e.processSequence=i+1);
  f.contextEvents.forEach((e,i)=>e.fileSequence=i+1);f.processEvents.forEach((e,i)=>e.fileSequence=i+1);
 }
 reindex();
 return {...f,model,context,startup,end,measured,empties,syncStartup,reindex,
  setModel(field,value){model[field]=value;f.input.propsRuntime[field]=value;context.data[field]=value;for(const e of empties)e.data[field]=value;syncStartup();}};
}
function rejectedEmpty(mutate,pattern){
 const f=emptyFixture();try{
  mutate(f);const observed=f.observe();
  assert.equal(observed.complete,false,'mutated no-data observation must fail');
  if(pattern)assert.match(JSON.stringify(observed.issues),pattern);
  return observed;
 }finally{f.close();}
}
test('qwen35 empty output reductions retain 3 no-data dispositions separately from 93 measured activations',()=>{
 const f=emptyFixture();try{
  const o=f.observe();assert.equal(o.complete,true,JSON.stringify(o.issues));
  assert.equal(o.tasks.probe.activationEvents,93);assert.equal(o.tasks.probe.emptyTensorEvents,3);
  assert.equal(o.tensorMappings.length,93);assert.equal(o.emptyTensorMappings.length,3);
  assert.deepEqual(o.emptyTensorMappings.map(e=>e.data.anchor),['attn_post_norm','ffn_out','l_out']);
  for(const e of o.emptyTensorMappings){
   assert.equal(e.successful,true);assert.equal(e.rows.length,1);assert.equal(e.rows[0].taskId,7);assert.equal(e.rows[0].output,false);
   assert.equal(e.rows[0].serverOutput,false);assert.equal(e.rows[0].inputKind,'token');assert.equal(e.rows[0].embeddingRow,-1);assert.deepEqual(e.rows[0].sequenceIds,[0]);
   assert.equal(Object.hasOwn(e.data,'perToken'),false);assert.equal(Object.hasOwn(e.data,'rawFloat32Sha256'),false);
   assert.deepEqual(e.data,f.empties.find(x=>x.data.name===e.data.name).data);
  }
  assert.equal(Object.keys(o.tensorDispositionCounters[0].actualObservedTensors).length,96);
  assert.deepEqual(o.tensorDispositionCounters[0].observedTensors,o.tensorDispositionCounters[0].expectedObservedTensors);
  assert.match(o.emptyTensorScope,/never contribute to activationEvents/);
 }finally{f.close();}
});
test('empty observations reject invented metrics, unknown fields and every malformed zero-data descriptor',()=>{
 for(const [field,value]of [['perToken',[]],['statistics',{}],['rawFloat32Sha256','0'.repeat(64)],['extraObservedMetric',0]])
  rejectedEmpty(f=>f.empties[0].data[field]=value,/complete approved no-data descriptor/);
 for(const field of ['sourceOutputMaskObserved','sourceMappingComplete','modelMtpLayerCount','modelEmbeddingSize'])
  rejectedEmpty(f=>delete f.empties[0].data[field],/complete approved no-data descriptor/);
 for(const [field,value]of [['bytes',4],['elementCount',1],['type','f16'],['shape',[1024,1,1,1]],['strides',[4,4096,4096,4096]]])
  rejectedEmpty(f=>f.empties[0].data[field]=value,/exact zero-byte F32/);
});
test('empty final-layer eligibility is bound to actual startup/context model fields and selected post-crop anchors',()=>{
 rejectedEmpty(f=>f.setModel('modelArchitecture','qwen2'),/actual qwen35 startup\/context/);
 rejectedEmpty(f=>f.setModel('modelMtpLayerCount',1),/actual qwen35 startup\/context/);
 rejectedEmpty(f=>{f.context.data.modelLayerCount=25;},/actual qwen35 startup\/context/);
 rejectedEmpty(f=>f.setModel('modelLayerCount',25),/final-layer post-crop/);
 rejectedEmpty(f=>f.setModel('modelEmbeddingSize',512),/exact zero-byte F32/);
 rejectedEmpty(f=>{f.empties[0].data.layer=22;f.empties[0].data.name='attn_post_norm-22';},/final-layer post-crop/);
 rejectedEmpty(f=>{f.empties[0].data.anchor='attn_norm';f.empties[0].data.name='attn_norm-23';},/final-layer post-crop/);
 rejectedEmpty(f=>f.empties[0].data.startupId='foreign-context',/published request/);
});
test('empty output-mask proof must be explicitly observed, all false and matched to exact source rows',()=>{
 const mutations=[
  f=>delete f.micro.data.outputMaskObserved,f=>f.micro.data.outputMaskObserved=false,
  f=>f.micro.data.sourceMappingComplete=false,f=>f.micro.data.rows[0].output=true,
  f=>delete f.micro.data.rows[0].output,f=>f.micro.data.nTokens=2,
  f=>f.micro.data.graphType=1,f=>f.micro.data.phase='initialization',
  f=>f.empties[0].data.sourceMicrobatchRows=2,f=>f.empties[0].data.sourceOutputRows=1,
  f=>f.empties[0].data.sourceOutputMaskObserved=false,f=>f.empties[0].data.sourceMappingComplete=false
 ];
 for(const mutate of mutations)rejectedEmpty(mutate,/explicit, complete, all-false output mask/);
 for(const mutate of [
  f=>f.micro.data.rows[0].tokenId=999,f=>f.micro.data.rows[0].positions=[99],
  f=>f.micro.data.rows[0].batchRow=99,f=>f.batch.data.rows[0].taskId=-1,
  f=>f.batch.data.rows[0].output=true,f=>delete f.batch.data.rows[0].output,
  f=>f.batch.data.rows[0].embeddingRow=0,f=>delete f.batch.data.rows[0].embeddingRow,
  f=>f.batch.data.rows[0].embeddingRow='-1',f=>f.micro.data.rows[0].inputKind='embedding',
  f=>delete f.micro.data.rows[0].inputKind,f=>f.micro.data.rows[0].sequenceIds=[],
  f=>f.micro.data.rows[0].sequenceIds=[1],f=>f.micro.data.rows[0].sequenceIds=[0,1.5]
 ])rejectedEmpty(mutate,/source row does not map exactly/);
 rejectedEmpty(f=>f.micro.data.rows[0].microRow=2,/source micro rows are non-contiguous/);
});
test('empty observations cannot bypass initialization, publication, activation mode or measured-statistic requirements',()=>{
 rejectedEmpty(f=>f.empties[0].data.phase='initialization',/published request/);
 rejectedEmpty(f=>f.empties[0].data.batchId=0,/published request/);
 rejectedEmpty(f=>f.empties[0].data.complete=false,/published request/);
 rejectedEmpty(f=>f.input.activationCaptureEnabled=false,/forbidden when activation capture is off/);
 rejectedEmpty(f=>{f.startup.processSequence=f.end.processSequence+.1;f.reindex();},/ordering does not prove published startup/);
 rejectedEmpty(f=>{
  const e=f.empties[0];e.event='tensor_statistics';e.data.perToken=[{microRow:0,mean:0}];
  f.end.data.measuredTensors[e.data.name]=1;delete f.end.data.emptyTensors[e.data.name];
 },/zero-sized tensor cannot be counted as measured activation statistics/);
 rejectedEmpty(f=>{
  const selected=new Set(f.measured);f.contextEvents.splice(0,f.contextEvents.length,...f.contextEvents.filter(e=>!selected.has(e)));
  f.end.data.measuredTensors={};f.end.data.observedTensors={...f.end.data.emptyTensors};f.reindex();
 },/no selected tensor event maps to this task/);
});
test('successful disposition counters must match actual events and every selected model-layer anchor',()=>{
 for(const field of ['observedTensors','measuredTensors','emptyTensors'])
  rejectedEmpty(f=>delete f.end.data[field],/disposition counters differ/);
 rejectedEmpty(f=>f.end.data.emptyTensors['attn_post_norm-23']=2,/disposition counters differ/);
 rejectedEmpty(f=>f.end.data.measuredTensors['attn_post_norm-23']=1,/disposition counters differ/);
 rejectedEmpty(f=>{
  const e=f.measured[0];f.contextEvents.splice(f.contextEvents.indexOf(e),1);
  delete f.end.data.measuredTensors[e.data.name];delete f.end.data.observedTensors[e.data.name];f.reindex();
 },/every actual model layer/);
 rejectedEmpty(f=>{
  const duplicate=structuredClone(f.empties[0]);duplicate.processSequence+=.1;f.contextEvents.splice(f.contextEvents.indexOf(f.empties[0])+1,0,duplicate);
  f.end.data.emptyTensors[duplicate.data.name]=2;f.end.data.observedTensors[duplicate.data.name]=2;f.reindex();
 },/duplicate an anchor/);
});
test('failed compute preserves empty observations without counting them as successful task coverage',()=>{
 const f=emptyFixture();try{
  const originalEnd=f.end,position=f.contextEvents.indexOf(originalEnd)+1,base=originalEnd.processSequence;
  const begin=structuredClone(f.micro),copies=[...f.measured,...f.empties].map(e=>structuredClone(e)),goodEnd=structuredClone(originalEnd);
  const added=[begin,...copies,goodEnd];
  added.forEach((e,index)=>{e.data.microbatchId=3;e.processSequence=base+(index+1)/(added.length+1);});
  originalEnd.data.complete=false;originalEnd.data.graphStatus=1;delete originalEnd.data.missingOrDuplicateTensors;
  f.contextEvents.splice(position,0,...added);f.reindex();
  const o=f.observe();assert.equal(o.complete,true,JSON.stringify(o.issues));
  assert.equal(o.failedMicrobatchAttempts.length,1);assert.equal(o.tasks.probe.activationEvents,93);assert.equal(o.tasks.probe.emptyTensorEvents,3);
  assert.deepEqual(o.emptyTensorMappings.map(e=>e.successful),[false,false,false,true,true,true]);
  assert.equal(o.tensorDispositionCounters.length,2);
 }finally{f.close();}
});

test('measured tensor joins retain the actual four-section nonzero text expansion',()=>{
 const f=fixture(true);try{
  f.micro.data.nPositionSections=4;f.micro.data.rows[0].positions=[1,1,1,0];
  const before=structuredClone({batch:f.batch.data,micro:f.micro.data}),o=f.observe();
  assert.equal(o.complete,true,JSON.stringify(o.issues));
  const p=o.tensorMappings[0].rows[0].positionCorrespondence;
  assert.equal(p.complete,true);assert.deepEqual(p.serverPositions,[1,0,0,0]);
  assert.deepEqual(p.microbatchPositions,[1,1,1,0]);assert.deepEqual(p.expectedMicrobatchPositions,[1,1,1,0]);
  assert.deepEqual({batch:f.batch.data,micro:f.micro.data},before);
 }finally{f.close();}
});
test('measured tensor joins reject forged expansion, unsupported sections and absent text input proof',()=>{
 for(const mutate of [
  f=>f.micro.data.rows[0].positions=[1,0,0,0],f=>f.micro.data.rows[0].positions=[1,1,1,7],
  f=>f.batch.data.rows[0].positions=[1,1,0,0],f=>f.micro.data.nPositionSections=3,
  f=>f.micro.data.rows[0].inputKind='embedding',f=>delete f.micro.data.rows[0].inputKind,
  f=>f.batch.data.rows[0].embeddingRow=0,f=>delete f.batch.data.rows[0].embeddingRow,
  f=>f.micro.data.rows[0].tokenId=999,f=>f.batch.data.rows[0].taskId=-1
 ]){
  const f=fixture(true);try{
   f.micro.data.nPositionSections=4;f.micro.data.rows[0].positions=[1,1,1,0];mutate(f);
   const o=f.observe();assert.equal(o.complete,false);assert.equal(o.tasks.probe.activationEvents,0);
   assert.ok(o.unassignedTensors.length>0);
   if(o.unassignedTensors[0].positionCorrespondence){const p=o.unassignedTensors[0].positionCorrespondence;assert.deepEqual(p.serverPositions,f.batch.data.rows[0].positions);assert.deepEqual(p.microbatchPositions,f.micro.data.rows[0].positions);}
  }finally{f.close();}
 }
});
test('empty tensor joins use the same four-section rule and keep all mask and ownership proof',()=>{
 const f=emptyFixture();try{
  f.micro.data.nPositionSections=4;f.micro.data.rows[0].positions=[1,1,1,0];
  const o=f.observe();assert.equal(o.complete,true,JSON.stringify(o.issues));
  assert.equal(o.tasks.probe.activationEvents,93);assert.equal(o.tasks.probe.emptyTensorEvents,3);
  for(const e of o.emptyTensorMappings){
   const p=e.rows[0].positionCorrespondence;assert.equal(p.complete,true);
   assert.deepEqual(p.serverPositions,[1,0,0,0]);assert.deepEqual(p.microbatchPositions,[1,1,1,0]);
   assert.equal(e.rows[0].output,false);assert.equal(e.rows[0].serverOutput,false);
   assert.equal(e.rows[0].inputKind,'token');assert.deepEqual(e.rows[0].sequenceIds,[0]);
  }
 }finally{f.close();}
});
test('empty tensor correspondence rejects malformed four-section proof without counting an empty event',()=>{
 for(const mutate of [
  f=>f.micro.data.rows[0].positions=[1,0,0,0],f=>f.micro.data.rows[0].positions=[1,1,1,1],
  f=>f.batch.data.rows[0].positions=[1,0,2,0],f=>f.micro.data.nPositionSections=2,
  f=>f.micro.data.rows[0].inputKind='embedding',f=>f.batch.data.rows[0].embeddingRow=0,
  f=>f.micro.data.rows[0].sequenceIds=[1],f=>f.batch.data.rows[0].output=true,
  f=>f.micro.data.rows[0].tokenId=999,f=>f.batch.data.rows[0].taskId=-1
 ]){
  const f=emptyFixture();try{
   f.micro.data.nPositionSections=4;f.micro.data.rows[0].positions=[1,1,1,0];mutate(f);
   const o=f.observe();assert.equal(o.complete,false);assert.equal(o.tasks.probe.emptyTensorEvents,0);
   assert.equal(o.unassignedEmptyTensors.length,3);
   const p=o.unassignedEmptyTensors[0].positionCorrespondences[0].positionCorrespondence;
   assert.deepEqual(p.serverPositions,f.batch.data.rows[0].positions);assert.deepEqual(p.microbatchPositions,f.micro.data.rows[0].positions);
  }finally{f.close();}
 }
});
