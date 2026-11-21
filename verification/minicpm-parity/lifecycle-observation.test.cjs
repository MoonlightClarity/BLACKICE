'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const C=require('./parity-contract.cjs'),O=require('./lifecycle-observation.cjs'),profile=require('./profile.json');
const sha=C.sha,clone=structuredClone,at=n=>new Date(Date.UTC(2026,10,21,13,0,0,n)).toISOString();
function fixture(mutate=()=>{},withWarmup=false){
 const directory='C:\\fixture\\trace',pid=412,processId='process-fixture',model='C:\\fixture\\original.gguf',exe='C:\\fixture\\bundle\\bin\\llama-server.exe';
 const config={schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:false,outputDirectory:directory,tensorSelection:profile.trace.tensorSelection,maxBytes:profile.trace.maxBytes,logitVectorSteps:0};
 const configBytes=Buffer.from(JSON.stringify(config,null,2)+'\n'),configPath='C:\\fixture\\blackice-trace.json',configSha=sha(configBytes),processIdentity={pid,startedAt:at(0),executablePath:exe};
 const runtime=Object.fromEntries(Object.entries(profile.runtime).filter(([k])=>k!=='jinja').map(([k,v])=>[k,k==='flashAttention'?true:v]));
 const makeNative=(id,time)=>({schema:'blackice.minicpm.runtime-startup.v1',id,startupId:id,at:at(time),pid,processStartedAt:at(0),modelId:profile.modelAlias,modelPath:model,build:'b12359-b1b770d90',runtime:clone(runtime),fieldSources:Object.fromEntries(Object.keys(runtime).map(k=>[k,{kind:'runtime-getter',detail:'fixture '+k}])),totalContextSize:262144,projector:{loaded:false,path:'',placementKnown:false,vision:false,audio:false,video:false},modelArchitecture:'qwen35',modelLayerCount:24,modelMtpLayerCount:0,modelEmbeddingSize:1024,configSha256:configSha,traceFile:path.win32.join(directory,pid+'-'+processId+'.ctx-'+id+'.jsonl'),droppedEvents:0,complete:true});
 const first=makeNative('first',2000),second=makeNative('second',8000),events=[];
 const event=(event,data,time,context=null)=>{const e={schema:'blackice.minicpm.live-trace.v1',event,at:at(time),pid,processId,processStartedAt:at(0),data:{...(context?{startupId:context.id}:{}),...data}};events.push(e);return e;};
 event('process_start',{executablePath:exe,sourceCommit:O.SOURCE_COMMIT,configSource:'explicit-environment-override',configPath,configSha256:configSha,configBytesUtf8:configBytes.toString(),effectiveConfig:{...config,maxTensorBytes:67108864,budgetScope:'all recorder files in one process'}},1);
 const start=c=>event('context_start',{configSha256:configSha,configBytesUtf8:configBytes.toString()},Date.parse(c.at)-Date.parse(at(0))-100,c);
 const pub=c=>event('runtime_startup',{runtime:c,receipt:null},Date.parse(c.at)-Date.parse(at(0)),c);
 start(first);
 if(withWarmup){event('microbatch_begin',{batchId:0,microbatchId:1,phase:'initialization',graphType:0,nTokens:1,nPositionSections:1,rows:[{microRow:0,batchRow:0,tokenId:1,positions:[0],sequenceIds:[0],output:true,inputKind:'token'}]},1950,first);event('microbatch_end',{batchId:0,microbatchId:1,graphStatus:0,activationCaptureEnabled:false,observedTensors:{},missingOrDuplicateTensors:[],complete:true},1960,first);}
 pub(first);event('context_end',{complete:true,droppedEvents:0,tensorEvents:0,emptyTensorEvents:0},6200,first);
 const requestBody={...C.completionBody(profile),n_predict:8},requestBytes=Buffer.from(JSON.stringify(requestBody)),requestHash=sha(requestBytes),requestPath=path.win32.join(directory,pid+'-'+processId+'.request-native-request.body.bin');
 event('http_request',{serverRequestId:'native-request',method:'POST',path:'/completion',body:{path:requestPath,bytes:requestBytes.length,sha256:requestHash},bodySha256:requestHash,bodyBytes:requestBytes.length,bodyObserved:true,exchangeId:'exchange',attemptId:'attempt',hostRequestSha256:requestHash},7000);
 start(second);pub(second);
 const taskId=19,slotId=0,completionId='opaque-completion';
 event('task_registered',{taskId,completionId,serverRequestId:'native-request',requestedSlotId:-1,promptTokenIds:[7,8],renderedPrompt:requestBody.prompt,generationParams:{seed:1234,temperature:Math.fround(.8),top_k:40,top_p:Math.fround(.95),min_p:Math.fround(.05),n_predict:8,stream:false}},8100,second);
 event('task_slot_assigned',{taskId,slotId},8110,second);
 event('server_batch_begin',{batchId:1,rows:[{batchRow:0,serverBatchRow:0,taskId,slotId,tokenId:8,positions:[1,0,0,0],output:true,isPrompt:true,embeddingRow:-1}]},8120,second);
 event('microbatch_begin',{batchId:1,microbatchId:7,phase:'request',graphType:0,sourceMappingComplete:true,nTokens:1,nPositionSections:1,rows:[{microRow:0,batchRow:0,tokenId:8,inputKind:'token',positions:[1],sequenceIds:[0],output:true}]},8130,second);
 event('microbatch_end',{batchId:1,microbatchId:7,graphStatus:0,activationCaptureEnabled:false,observedTensors:{},missingOrDuplicateTensors:[],complete:true},8140,second);
 event('sample_logits',{taskId,slotId,batchId:1,batchRow:0,sampleId:1,sampledTokenId:99,logitsAvailable:true,vocabularySize:1000,rawFloat32Sha256:'b'.repeat(64)},8150,second);
 event('accepted_token',{taskId,slotId,ordinal:1,tokenId:99},8160,second);
 event('task_terminal',{taskId,slotId,completionId,outcome:'completed',traceComplete:true,droppedEvents:0,truncated:false,sampleLogitEvents:1,acceptedTokenEvents:1},8170,second);
 event('slot_release',{taskId,slotId,hadTaskTerminal:true},8180,second);
 event('http_generator_end',{serverRequestId:'native-request',status:200,streaming:false,transportProviderSuccess:null,producerExhausted:null,sinkDoneCalled:null,chunkWriteFailed:null,complete:true},8190);
 event('http_response_observed',{serverRequestId:'native-request',status:200},8200);
 const responseValue={content:'delta',tokens:[4,5],stop:true,truncated:false,stop_type:'eos',tokens_evaluated:2,timings:{prompt_n:2}},responseBytes=Buffer.from(JSON.stringify(responseValue));
 const response={status:200,headers:{'x-blackice-server-request-id':'native-request','x-blackice-attempt-id':'attempt'},complete:true,terminal:'http-body-eof',bodyBytes:responseBytes.length,bodySha256:sha(responseBytes)};
 const host={request:{at:at(6900),finishedAt:at(8900),method:'POST',route:'/completion',exchangeId:'exchange',attemptId:'attempt',bodySha256:requestHash,bodyBytes:requestBytes.length,complete:true},requestBytes,response,responseBytes};
 const data={events,event,first,second,config,configBytes,host};mutate(data);
 const artifacts=[],files=new Map();const add=(name,b)=>{artifacts.push({path:name,bytes:b,rereadBytes:Buffer.from(b)});};
 for(const c of [first,second]){const b=Buffer.from(JSON.stringify(c,null,2)+'\n'),ref={path:c.traceFile.replace(/\.jsonl$/,'.startup.json'),bytes:b.length,sha256:sha(b)};for(const e of events.filter(x=>x.event==='runtime_startup'&&x.data.startupId===c.id))e.data.receipt=ref;add(ref.path,b);}
 events.forEach((e,index)=>{e.processSequence=index+1;const file=e.data.startupId===first.id?first.traceFile:e.data.startupId===second.id?second.traceFile:path.win32.join(directory,pid+'-'+processId+'.process.jsonl');const rows=files.get(file)||[];e.fileSequence=rows.length+1;rows.push(e);files.set(file,rows);});
 for(const[file,rows]of files)add(file,Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n'));add(requestPath,requestBytes);
 const publication=(c,name,ms,cut)=>{
  const rows=files.get(c.traceFile).filter(e=>Date.parse(e.at)<=Date.parse(at(cut))),prefix=Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n'),startup=artifacts.find(x=>x.path===c.traceFile.replace(/\.jsonl$/,'.startup.json')).bytes;
  const props={blackice_runtime_state:'awake',blackice_runtime:c,is_sleeping:false,total_slots:1,modalities:{vision:false,video:false},default_generation_settings:{n_ctx:262144,params:{seed:1234,temperature:Math.fround(.8),top_k:40,top_p:Math.fround(.95),min_p:Math.fround(.05)}}};
  const identity={dev:'1',ino:name==='before'?'8':'9',birthtimeNs:'1795250000000000000'};
  return {input:{now:at(10000),maxEvidenceAgeMs:120000,processIdentity,propsResponse:{startedAt:at(ms),at:at(ms+1),status:200,json:clone(props)},startupReceipt:{...clone(c),observedAt:at(ms+1),modelSha256:O.ORIGINAL_SHA,binarySha256:'c'.repeat(64)},currentPublication:{schema:'blackice.minicpm.context-publication-input.v1',contextPrefix:{path:'C:\\fixture\\'+name+'\\context-prefix.jsonl',bytes:prefix.length,sha256:sha(prefix)},startupArtifact:{path:'C:\\fixture\\'+name+'\\startup.native.json',bytes:startup.length,sha256:sha(startup)},contextSource:{path:c.traceFile,highWaterMark:prefix.length,startedAt:at(ms+2),finishedAt:at(ms+3),before:{bytes:prefix.length,identity},after:{bytes:prefix.length,identity:clone(identity)},rereadSha256:sha(prefix)},propsAfterResponse:{startedAt:at(ms+4),at:at(ms+5),status:200,json:clone(props)}}},raw:{contextPrefixBytes:prefix,startupArtifactBytes:startup}};
 };
 return {profile:clone(profile),now:at(10000),processIdentity,modelIdentity:{path:model,sha256:O.ORIGINAL_SHA},expectedBuild:'b12359-b1b770d90',config:{path:configPath,sha256:configSha,bytes:configBytes},before:publication(first,'before',4500,4400),sleep:{at:at(6000),status:200,json:{is_sleeping:true,blackice_runtime_state:'sleeping',blackice_runtime:null,blackice_previous_runtime:clone(first)}},after:publication(second,'after',9000,8900),completion:host,trace:{artifacts}};
}
const rejects=(input,code)=>{const r=O.observeLifecycle(input);assert.equal(r.complete,false);assert.ok(r.failures.some(x=>x.code===code),JSON.stringify(r.failures));return r;};
test('one observed cycle accepts no fabricated wake warmup; native and returned tokens remain separate',()=>{const r=O.observeLifecycle(fixture());assert.equal(r.complete,true,JSON.stringify(r.failures));assert.equal(r.phases.initializationMicrobatches,0);assert.equal(r.phases.requestMicrobatches,1);assert.deepEqual(r.task.acceptedTokenIds,[99]);assert.deepEqual(r.task.returnedCompletion.tokens,[4,5]);assert.equal(r.scorable,false);assert.equal(r.volume.measuredTensorEvents,0);});
test('genuine first-context warmup is retained and correctly scoped',()=>{const r=O.observeLifecycle(fixture(()=>{},true));assert.equal(r.complete,true,JSON.stringify(r.failures));assert.equal(r.phases.initializationMicrobatches,1);});
test('sleeping response may precede old context destruction; missing destruction fails',()=>{assert.equal(O.observeLifecycle(fixture()).complete,true);rejects(fixture(d=>d.events.splice(d.events.findIndex(x=>x.event==='context_end'),1)),'LIFECYCLE_UNIQUE');});
test('new current context cannot already have ended',()=>rejects(fixture(d=>d.event('context_end',{complete:true,droppedEvents:0},8800,d.second)),'LIFECYCLE_PUBLICATION'));
test('new generation must be after native publication and owned by the new context',()=>rejects(fixture(d=>d.events.find(e=>e.event==='task_registered').data.startupId=d.first.id),'LIFECYCLE_TASK'));
test('a request disguised as initialization is rejected',()=>rejects(fixture(d=>d.events.find(e=>e.event==='microbatch_begin').data.phase='initialization'),'LIFECYCLE_PHASE'));
test('microbatch position, sequence, output and embedding row contradictions are rejected',()=>{for(const change of [d=>d.events.find(e=>e.event==='microbatch_begin').data.rows[0].positions[0]=2,d=>d.events.find(e=>e.event==='microbatch_begin').data.rows[0].sequenceIds=[8],d=>d.events.find(e=>e.event==='microbatch_begin').data.rows[0].output=false,d=>d.events.find(e=>e.event==='server_batch_begin').data.rows[0].embeddingRow=0]){const r=O.observeLifecycle(fixture(change));assert.equal(r.complete,false);assert.match(r.failures[0].code,/LIFECYCLE_(BATCH|PHASE)/);}});
test('sample and accepted token contradiction is retained',()=>rejects(fixture(d=>d.events.find(e=>e.event==='accepted_token').data.tokenId=98),'LIFECYCLE_TOKENS'));
test('nonstream generator cannot claim a fabricated raw transport success',()=>rejects(fixture(d=>d.events.find(e=>e.event==='http_generator_end').data.transportProviderSuccess=true),'LIFECYCLE_HTTP'));
test('host raw bytes, exact tiny request and response headers are bound independently',()=>{
 const response=fixture();response.completion.responseBytes=Buffer.from('{}');rejects(response,'LIFECYCLE_HTTP');
 const request=fixture();const changed=JSON.parse(request.completion.requestBytes);changed.seed=2;request.completion.requestBytes=Buffer.from(JSON.stringify(changed));request.completion.request.bodySha256=sha(request.completion.requestBytes);request.completion.request.bodyBytes=request.completion.requestBytes.length;rejects(request,'LIFECYCLE_REQUEST');
 const headers=fixture();headers.completion.response.headers['x-blackice-attempt-id']='other';rejects(headers,'LIFECYCLE_REQUEST_BINDING');
});
test('a stale current receipt and absent independent prefix bytes are incomplete',()=>{const a=fixture();a.after.input.propsResponse.json.blackice_runtime=a.before.input.propsResponse.json.blackice_runtime;rejects(a,'LIFECYCLE_PUBLICATION');const b=fixture();delete b.before.raw.contextPrefixBytes;rejects(b,'LIFECYCLE_PUBLICATION');});
test('trace rewrite, invalid marker and unexpected activation observations fail',()=>{const a=fixture();a.trace.artifacts[0].rereadBytes=Buffer.from('{}');rejects(a,'LIFECYCLE_TRACE');const b=fixture();b.trace.artifacts.push({path:'C:\\fixture\\trace\\412-process-fixture.invalid.json',bytes:Buffer.from('{}'),rereadBytes:Buffer.from('{}')});rejects(b,'LIFECYCLE_NATIVE_INVALID');rejects(fixture(d=>d.event('tensor_statistics',{batchId:1,microbatchId:7},8185,d.second)),'LIFECYCLE_METADATA_ONLY');});
test('exact metadata-only config and full context cannot drift',()=>{const a=fixture();const value=JSON.parse(a.config.bytes);value.activationCaptureEnabled=true;a.config.bytes=Buffer.from(JSON.stringify(value));a.config.sha256=sha(a.config.bytes);rejects(a,'LIFECYCLE_CONFIG');rejects(fixture(d=>d.second.runtime.ctxSize=8192),'LIFECYCLE_RUNTIME');});
test('unknown context records are rejected and unobserved volume is not reported as zero',()=>{rejects(fixture(d=>d.event('cache_event',{startupId:'unobserved-context'},8195)),'LIFECYCLE_CONTEXT');const input=fixture();input.config.bytes=Buffer.from('{}');input.config.sha256=sha(input.config.bytes);const r=rejects(input,'LIFECYCLE_CONFIG');assert.equal(r.volume.inventoryComplete,false);assert.equal(r.volume.measuredTensorEvents,null);});
function manifest(){const binary={path:'C:\\frozen\\bin\\llama-server.exe',bytes:10,sha256:'a'.repeat(64)},dll={path:'C:\\frozen\\bin\\ggml.dll',bytes:11,sha256:'b'.repeat(64)};return {schema:O.MANIFEST_SCHEMA,binary,files:[binary,dll],loadedMathLibraries:[dll,dll],sourceState:{sourceCommit:O.SOURCE_COMMIT},version:'version: fixture (build 12359, commit b1b770d90)\n',cliReceipts:['C:\\frozen\\version.json']};}
test('frozen manifest preserves repeated actual DLL loads but rejects wrong source/path/hash',()=>{const m=manifest(),args={manifestPath:'C:\\frozen\\manifest.json',executable:m.binary.path,executableSha256:m.binary.sha256};assert.equal(O.validateManifest(m,args).build,'b12359-b1b770d90');assert.equal(O.compareBundle(m.files,m),true);for(const changed of [v=>v.sourceState.sourceCommit='f'.repeat(40),v=>v.binary={...v.binary,path:'C:\\other\\bin\\llama-server.exe'},v=>v.loadedMathLibraries[0]={...v.loadedMathLibraries[0],sha256:'c'.repeat(64)}]){const n=clone(m);changed(n);assert.throws(()=>O.validateManifest(n,args));}});
module.exports={fixture};

test('lifecycle request rows accept exact four-section text expansion and retain both raw arrays',()=>{
 const input=fixture(d=>{const e=d.events.find(x=>x.event==='microbatch_begin');e.data.nPositionSections=4;e.data.rows[0].positions=[1,1,1,0];});
 const before=input.trace.artifacts.map(x=>Buffer.from(x.bytes)),o=O.observeLifecycle(input);
 assert.equal(o.complete,true,JSON.stringify(o.failures));assert.equal(o.positionMappings.length,1);
 const m=o.positionMappings[0],p=m.positionCorrespondence;
 assert.equal(m.taskId,19);assert.equal(m.slotId,0);assert.equal(m.batchId,1);assert.equal(m.microbatchId,7);
 assert.equal(p.complete,true);assert.deepEqual(p.serverPositions,[1,0,0,0]);assert.deepEqual(p.microbatchPositions,[1,1,1,0]);assert.deepEqual(p.expectedMicrobatchPositions,[1,1,1,0]);
 input.trace.artifacts.forEach((x,i)=>assert.deepEqual(x.bytes,before[i]));
});
test('lifecycle rejects malformed expansion, embedding and ownership contradictions with raw position evidence',()=>{
 for(const mutate of [
  (b,m)=>m.rows[0].positions=[1,0,0,0],(b,m)=>m.rows[0].positions=[1,1,1,1],
  (b,m)=>b.rows[0].positions=[1,2,0,0],(b,m)=>m.nPositionSections=3,
  (b,m)=>m.rows[0].inputKind='embedding',(b,m)=>m.rows[0].sequenceIds=[9],
  (b,m)=>m.rows[0].tokenId=9,(b,m)=>m.rows[0].output=false
 ]){
  let expected;
  const input=fixture(d=>{const b=d.events.find(x=>x.event==='server_batch_begin').data,m=d.events.find(x=>x.event==='microbatch_begin').data;m.nPositionSections=4;m.rows[0].positions=[1,1,1,0];mutate(b,m);expected={server:structuredClone(b.rows[0].positions),core:structuredClone(m.rows[0].positions)};});
  const o=rejects(input,'LIFECYCLE_PHASE');assert.equal(o.positionMappings.length,1);
  assert.deepEqual(o.positionMappings[0].positionCorrespondence.serverPositions,expected.server);
  assert.deepEqual(o.positionMappings[0].positionCorrespondence.microbatchPositions,expected.core);
 }
 for(const mutate of [b=>b.rows[0].embeddingRow=0,b=>b.rows[0].taskId=20,b=>b.rows[0].slotId=1]){
  rejects(fixture(d=>mutate(d.events.find(x=>x.event==='server_batch_begin').data)),'LIFECYCLE_BATCH');
 }
});
