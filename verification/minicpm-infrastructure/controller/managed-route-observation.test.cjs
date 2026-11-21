'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {normalizeManagedRouteObservation:normalizeManagedRaw,SCHEMA}=require('./managed-route-observation.cjs');
const {attachPublication}=require('./fixtures/context-publication.cjs');
const normalizeManagedRouteObservation=value=>normalizeManagedRaw(value,value.fixtureRuntimeBytes);
const {STARTUP_SCHEMA}=require('./runtime-observation.cjs');
const {digest}=require('./policy-contract.cjs');
const a='a'.repeat(64),b='b'.repeat(64),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE=Date.parse('2026-11-21T09:00:00.000Z'),at=n=>new Date(BASE+n).toISOString();
const PINS={
 'lib/context.mjs':'ea3cc177988cea021b879e421a892dae52e03a254085e01946ad852906b3bccf',
 'server.mjs':'a43ffce743443febbab59b348bdfd9f8dbf8820805e854c5eb7b1d3e50b2e0dd',
 'desktop/main.mjs':'7cd2ca0c35e3f10fa9b01603a2c564bedfb3553925eaea0e9f71fce4f03b0fae',
 'lib/engine.mjs':'b21774d804c1763151967bbeaa4b58dbafd142f3bef58233b3183402a35fd99f',
 'lib/providers.mjs':'c8d703b85f7d3f3cd03830e7ce0afd20d28601b865703b44d8a91843dde51fd7',
};
function runtimeFixture(){
 const at='2026-11-21T09:00:10.000Z',startedAt='2026-11-21T09:00:00.000Z';
 const modelId='minicpm-test',modelPath='C:\\models\\minicpm.gguf',exe='C:\\runtime\\llama-server.exe';
 const runtime={ctxSize:262144,parallel:1,threads:6,threadsBatch:6,batch:2048,ubatch:512,cacheK:'q8_0',cacheV:'q8_0',gpuLayers:25,flashAttention:true};
 const fieldSources=Object.fromEntries(Object.keys(runtime).map(k=>[k,{kind:'runtime-getter',detail:'fixture getter for '+k}]));
 fieldSources.gpuLayers={kind:'runtime-internal',detail:'actual device tensor placement'};
 fieldSources.cacheK={kind:'runtime-log',detail:'process-bound K (q8_0) startup log'};
 return {
  now:at,maxEvidenceAgeMs:2000,modelId,
  modelIdentity:{at,path:modelPath,sha256:a},
  bundleIdentity:{at,path:exe,binarySha256:b,build:'b12359-b1b770d90'},
  processIdentity:{at,pid:42,startedAt,executablePath:exe,binarySha256:b},
  configSnapshot:{at,revision:19,process:{owned:true,appliedRevision:19,pendingRestart:false,starting:false,stopping:false}},
  catalogResponse:{at,status:200,json:{data:[{id:modelId,status:{value:'loaded'},meta:{n_ctx:262144,n_ctx_train:262144}}]}},
  propsResponse:{at,status:200,json:{
   model_alias:modelId,model_path:modelPath,build_info:'b12359-b1b770d90',is_sleeping:false,total_slots:1,
   default_generation_settings:{n_ctx:262144,params:{seed:1234,temperature:0,top_k:40,top_p:0.949999988079071,min_p:0.05000000074505806}},
   blackice_runtime:{startupId:'context-1',pid:42,processStartedAt:startedAt},
  }},
  startupReceipt:{schema:STARTUP_SCHEMA,id:'context-1',at:'2026-11-21T09:00:01.000Z',observedAt:at,pid:42,processStartedAt:startedAt,
   modelId,modelPath,modelSha256:a,binarySha256:b,build:'b12359-b1b770d90',complete:true,droppedEvents:0,runtime,fieldSources},
 };
}

// Synthetic native-shaped evidence only. Passing tests does not qualify a model.
function fixture({retry=false,foreign=false,counting=true,cold=false,duration=7000}={}){
 const root='C:\\trace\\D0',ri=runtimeFixture(),now=at(duration+1000),binding={runId:'run_demo',nodeId:'agent',threadId:'provider_demo',turnId:'turn_demo',requestId:'request_demo',model:ri.modelId};
 for(const name of ['modelIdentity','bundleIdentity','processIdentity','configSnapshot','catalogResponse','propsResponse'])ri[name].at=now;
 ri.now=now;ri.startupReceipt.observedAt=now;ri.processIdentity.startedAt=at(cold?500:0);ri.startupReceipt.processStartedAt=ri.processIdentity.startedAt;
 const options={preset:'custom',windowTokens:262144,autoCompact:false,outputReserveTokens:8192,headroomTokens:512};
 const contextStatus={preset:'custom',requestedWindowTokens:262144,modelWindowTokens:262144,configuredModelWindowTokens:262144,effectiveWindowTokens:262144,windowSource:'runtime-reported',outputReserveTokens:8192,headroomTokens:512,inputBudgetTokens:253440,autoCompact:false,compactionCount:0};
 const tools=[{type:'function',function:{name:'relay_directory_action'}},{type:'function',function:{name:'relay_workspace'}}],system='Observed system instructions.',user='Task for run_demo; read METHOD.md and save source.';
 const body={model:ri.modelId,messages:[{role:'system',content:system},{role:'user',content:user}],tools,stream:true,max_tokens:8192};
 const audit={version:1,captureStage:'adapter-prepared',adapter:'compatible',delivery:'accepted',capturedAt:at(3800),acceptedAt:at(4100),developer:{sha256:sha(system)},tools:{status:'accepted',sha256:sha(JSON.stringify(tools))}};
 const nativeRun={id:binding.runId,taskId:binding.runId,createdAt:at(0),status:'completed',settled:true,input:'Task for run_demo',metadata:{clientRequestId:binding.requestId},
 workflow:{id:'workflow_demo',settings:{context:options},nodes:[{id:'agent',type:'agent',model:'local_llamacpp::'+ri.modelId}]},
 nodes:{agent:{threadId:binding.threadId,turnId:binding.turnId,resolvedModel:'local_llamacpp::'+ri.modelId,instructionAudit:audit}}};
 const providerThread={version:1,id:binding.threadId,providerId:'local_llamacpp',providerType:'compatible',model:ri.modelId,developerInstructions:system,messages:[{role:'user',content:user}],compactions:[],contextOptions:options,contextStatus};
 const row=status=>({id:binding.runId,taskId:binding.runId,createdAt:at(0),status,settled:status==='completed',metadata:{clientRequestId:binding.requestId},workflow:nativeRun.workflow});
 const snap=(start,end,rows)=>({startedAt:at(start),finishedAt:at(end),status:200,method:'GET',path:'/api/runs',bytes:Buffer.from(JSON.stringify(rows))});
 const sourceIdentity={appVersion:'2.40.72',files:{...PINS}};sourceIdentity.sha256=digest(sourceIdentity);
 const value={now,maxEvidenceAgeMs:2000,runBinding:binding,nativeRun,providerThread,runtimeInput:ri,
 sourceObservation:{at:now,sourceIdentity},osObservation:{at:now,processes:[
 {pid:41,parentPid:1,startedAt:at(-2000),executablePath:ri.bundleIdentity.path},
 {pid:42,parentPid:41,startedAt:ri.processIdentity.startedAt,executablePath:ri.bundleIdentity.path},
 ]},hostActivity:{before:snap(-500,-400,[]),active:[snap(100,200,[row('running')])],after:snap(duration+100,duration+200,[row('completed')])},
 trace:{root,startedAt:at(duration+300),finishedAt:at(duration+600),inventoryBefore:{at:at(duration+350),files:[]},inventoryAfter:{at:at(duration+550),files:[]},artifacts:[]}};
 const config={enabled:true,outputDirectory:root},configText=JSON.stringify(config),configSha=sha(configText);
 const proc=new Map(),byFile=new Map();
 function event(pid,kind,name,data,ms){
  const processId=pid===41?'router-one':'child-one',file=path.win32.join(root,pid+'-'+processId+'.'+(kind==='process'?'process.jsonl':'ctx-context-1.jsonl'));
  const rows=byFile.get(file)||[],sequence=(proc.get(pid)||0)+1;proc.set(pid,sequence);
  const e={schema:'blackice.minicpm.live-trace.v1',event:name,at:at(ms),pid,processId,processStartedAt:pid===41?at(-2000):ri.processIdentity.startedAt,processSequence:sequence,fileSequence:rows.length+1,data};
  rows.push(e);byFile.set(file,rows);return e;
 }
 function file(name,bytes){const f=path.win32.join(root,name),raw=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);value.trace.artifacts.push({path:f,bytes:raw,rereadBytes:Buffer.from(raw)});return {path:f,bytes:raw.length,sha256:sha(raw)};}
 function received(pid,id,parent,payload,route,ms){
  const processId=pid===41?'router-one':'child-one',bytes=Buffer.from(JSON.stringify(payload)),ref=file(pid+'-'+processId+'.request-'+id+'.body.bin',bytes);
  return event(pid,'process','http_request',{serverRequestId:id,parentServerRequestId:parent||'',method:'POST',path:route,bodyObserved:true,bodySha256:ref.sha256,bodyBytes:ref.bytes,body:ref,exchangeId:'',attemptId:'',hostRequestSha256:''},ms);
 }
 event(41,'process','process_start',{configBytesUtf8:configText,configSha256:configSha,effectiveConfig:config},-1000);
 event(42,'process','process_start',{configBytesUtf8:configText,configSha256:configSha,effectiveConfig:config},cold?510:10);
 event(42,'context','context_start',{startupId:'context-1',configBytesUtf8:configText,configSha256:configSha,effectiveConfig:config},1000);
 const rawStartup={...ri.startupReceipt,startupId:'context-1',projector:null,configSha256:configSha,traceFile:path.win32.join(root,'42-child-one.ctx-context-1.jsonl')};
 delete rawStartup.observedAt;delete rawStartup.modelSha256;delete rawStartup.binarySha256;
 ri.propsResponse.json.blackice_runtime=structuredClone(rawStartup);
 ri.startupReceipt={...structuredClone(rawStartup),observedAt:now,modelSha256:a,binarySha256:b};
 const startupFile=file('42-child-one.ctx-context-1.startup.json',JSON.stringify(rawStartup)+'\n');
 event(42,'context','runtime_startup',{startupId:'context-1',receipt:startupFile,runtime:rawStartup},1100);
 if(counting){
  received(41,'r-count','',body,'/v1/chat/completions/input_tokens',2500);
  received(42,'c-count','r-count',body,'/v1/chat/completions/input_tokens',2510);
  for(const pid of [41,42]){const id=pid===41?'r-count':'c-count';event(pid,'process','http_response_observed',{serverRequestId:id,status:200},2600);event(pid,'process','http_generator_end',{serverRequestId:id,status:200,streaming:false,transportProviderSuccess:null,producerExhausted:null,sinkDoneCalled:null,chunkWriteFailed:null,complete:true},2610);}
 }
 function generation(number,payload,base){
  const rid='r-gen-'+number,cid='c-gen-'+number,completionId='opaque-native-completion-'+number;
  received(41,rid,'',payload,'/v1/chat/completions',cold&&number===1?300:base-100);
  received(42,cid,rid,payload,'/v1/chat/completions',base);
  // httplib's header/logger observation can precede the entire streaming task.
  event(42,'process','http_response_observed',{serverRequestId:cid,status:200},base+1);
  event(41,'process','http_response_observed',{serverRequestId:rid,status:200},base+2);
  const params={...ri.propsResponse.json.default_generation_settings.params,max_tokens:8192,n_predict:8192,stream:true,samplers:['top_k','top_p','min_p','temperature'],chat_format:'chatml',reasoning_format:'none',lora:[]};
  event(42,'context','task_registered',{startupId:'context-1',taskId:number,serverRequestId:cid,completionId,nPromptPositions:3,allPromptPositionsAreText:true,promptTokenIds:[1,2,3],renderedPrompt:'actual chat template',generationParams:params},base+10);
  event(42,'context','task_slot_assigned',{startupId:'context-1',taskId:number,slotId:0,nPredictMax:8192,samplerSeed:1234,samplerChain:'logits -> top-k -> top-p -> min-p -> temperature -> dist '},base+20);
  event(42,'context','sample_logits',{startupId:'context-1',taskId:number,slotId:0,sampleId:number,sampledTokenId:10+number,rawFloat32Sha256:'c'.repeat(64)},base+100);
  event(42,'context','accepted_token',{startupId:'context-1',taskId:number,slotId:0,ordinal:1,tokenId:10+number},base+110);
  event(42,'context','task_terminal',{startupId:'context-1',taskId:number,outcome:'completed',slotId:0,completionId,nDecoded:1,nPromptPositions:3,nPromptCached:0,stopType:1,truncated:false,sampleLogitEvents:1,acceptedTokenEvents:1,traceComplete:true,droppedEvents:0},base+200);
  event(42,'context','slot_release',{startupId:'context-1',taskId:number,slotId:0,hadTaskTerminal:true},base+210);
  event(42,'process','http_generator_end',{serverRequestId:cid,status:200,streaming:true,transportProviderSuccess:true,producerExhausted:true,sinkDoneCalled:true,chunkWriteFailed:false,complete:true},base+220);
  event(41,'process','http_generator_end',{serverRequestId:rid,status:200,streaming:true,transportProviderSuccess:true,producerExhausted:true,sinkDoneCalled:true,chunkWriteFailed:false,complete:true},base+230);
 }
 generation(1,body,4000);
 if(retry)generation(2,structuredClone(body),5500);
 if(foreign){const other=structuredClone(body);other.messages[1].content='Unrelated host task';generation(2,other,5500);}
 for(const [name,rows]of byFile)value.trace.artifacts.push({path:name,bytes:Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n'),rereadBytes:Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 seal(value);return value;
}
function seal(v){
 const rows=v.trace.artifacts.map((f,n)=>({path:f.path,size:f.bytes.length,identity:{dev:'1',ino:String(n+1),birthtimeNs:'1795250000000000000'}}));
 v.trace.inventoryBefore.files=structuredClone(rows);v.trace.inventoryAfter.files=structuredClone(rows);
 for(const f of v.trace.artifacts)f.rereadBytes=Buffer.from(f.bytes);
 const native=v.runtimeInput.propsResponse.json.blackice_runtime;
 const prefix=v.trace.artifacts.find(f=>f.path===native.traceFile),startup=v.trace.artifacts.find(f=>f.path===native.traceFile.replace(/\.jsonl$/,'.startup.json'));
 if(prefix&&startup){const proof=attachPublication(v.runtimeInput,{contextPrefixBytes:prefix.bytes,startupArtifactBytes:startup.bytes});v.runtimeInput=proof.input;v.fixtureRuntimeBytes=proof.bytes;}
}
function changeEvents(v,change,{resequence=false}={}){
 const all=[];
 for(const f of v.trace.artifacts.filter(f=>f.path.endsWith('.jsonl')))for(const e of f.bytes.toString().trimEnd().split('\n').map(JSON.parse))all.push({file:f,event:e});
 change(all);
 if(resequence){
  for(const pid of new Set(all.map(x=>x.event.pid))){const rows=all.filter(x=>x.event.pid===pid).sort((a,b)=>a.event.processSequence-b.event.processSequence);rows.forEach((x,n)=>x.event.processSequence=n+1);}
 }
 for(const f of v.trace.artifacts.filter(f=>f.path.endsWith('.jsonl'))){
  const rows=all.filter(x=>x.file===f).map(x=>x.event).sort((a,b)=>a.processSequence-b.processSequence);
  if(resequence)rows.forEach((e,n)=>e.fileSequence=n+1);
  f.bytes=Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n');
 }
 seal(v);
}
function rejected(change,code,options){
 const v=fixture(options);change(v);const q=normalizeManagedRouteObservation(v);
 assert.equal(q.complete,false,JSON.stringify(q));assert.equal(q.capture,null);
 if(code)assert.ok([...q.missing,...q.conflicts].some(x=>x.code===code),JSON.stringify({missing:q.missing,conflicts:q.conflicts}));return q;
}

function allEvents(v){return v.trace.artifacts.filter(f=>f.path.endsWith('.jsonl')).flatMap(f=>f.bytes.toString().trimEnd().split('\n').map(JSON.parse));}
function changeBody(v,edit){
 const refs=new Map();
 for(const f of v.trace.artifacts.filter(f=>f.path.includes('.request-')&&f.path.endsWith('.body.bin'))){
  const p=JSON.parse(f.bytes);edit(p,f);f.bytes=Buffer.from(JSON.stringify(p));refs.set(f.path,{path:f.path,bytes:f.bytes.length,sha256:sha(f.bytes)});
 }
 changeEvents(v,rows=>{for(const {event:e}of rows)if(e.event==='http_request'&&refs.has(e.data.body.path)){e.data.body=refs.get(e.data.body.path);e.data.bodyBytes=e.data.body.bytes;e.data.bodySha256=e.data.body.sha256;}});
}
function removeEvent(v,name,filter=()=>true){changeEvents(v,rows=>{for(let n=rows.length-1;n>=0;n--)if(rows[n].event.event===name&&filter(rows[n].event))rows.splice(n,1);},{resequence:true});}
function mutateEvent(v,name,edit,filter=()=>true){changeEvents(v,rows=>{for(const {event:e}of rows)if(e.event===name&&filter(e))edit(e);});}
function checkComplete(v){
 const q=normalizeManagedRouteObservation(v);
 assert.equal(q.complete,true,JSON.stringify({missing:q.missing,conflicts:q.conflicts}));
 assert.equal(q.capture.complete,true);return q;
}
test('complete observed managed generation is an unscored exclusive-route bootstrap',()=>{
 const v=fixture(),before=structuredClone(v),q=checkComplete(v);
 assert.equal(q.schema,SCHEMA);assert.equal(q.scorable,false);assert.equal(q.traceComparable,false);
 assert.equal(q.providerExchangeBinding,'unbound');assert.equal(q.bindingTier,'exclusive-route');
 assert.equal(q.capture.kind,'exclusive-route');assert.equal(q.capture.exclusiveRoute.matchingFirstRequestCount,1);
 assert.equal(q.capture.request.path,'/v1/chat/completions');assert.equal(q.capture.request.at,at(4000));
 assert.equal(q.capture.runtime.pid,42);assert.equal(q.capture.response.id,'opaque-native-completion-1');
 assert.equal(q.payload.sha256,q.capture.request.bodySha256);
 assert.equal(q.taskSpans[0].samplerChain,'logits -> top-k -> top-p -> min-p -> temperature -> dist ');
 assert.equal(q.taskSpans[0].nativeCounts.stopType,1);
 assert.deepEqual(structuredClone(v),before);assert.deepEqual(normalizeManagedRouteObservation(v),q);
});
test('identical counting payloads remain separately observed and do not create generation ambiguity',()=>{
 const q=checkComplete(fixture());assert.equal(q.countingRequests.length,2);assert.equal(q.generationRequests.length,2);
 assert.equal(q.countingRequests[0].body.sha256,q.payload.sha256);
});
test('historical before and active snapshots survive a legitimate five-minute run',()=>{
 const v=fixture({duration:300000}),q=checkComplete(v);
 assert.ok(Date.parse(v.now)-Date.parse(v.hostActivity.before.finishedAt)>v.maxEvidenceAgeMs);
 assert.equal(q.provenance.hostActivity.length,3);
});
test('cold router ingress can predate child birth; the child request anchors the descriptor',()=>{
 const v=fixture({cold:true,counting:false}),q=checkComplete(v);
 assert.ok(Date.parse(q.taskSpans[0].routerRequest.at)<Date.parse(q.capture.runtime.processStartedAt));
 assert.equal(q.capture.request.at,at(4000));
});
test('response logger may precede task and stream completion',()=>{
 const q=checkComplete(fixture()),task=q.taskSpans[0];
 assert.ok(Date.parse(task.http.child.response.at)<Date.parse(task.registration.at));
 assert.ok(Date.parse(task.http.child.generator.at)>Date.parse(task.terminal.at));
});
test('native counter values are retained without invented upstream count equivalence',()=>{
 const v=fixture();mutateEvent(v,'task_terminal',e=>e.data.nDecoded=2);
 assert.equal(checkComplete(v).taskSpans[0].nativeCounts.nDecoded,2);
});
test('native float32 task parameters accept correctly normalized request overrides',()=>{
 const v=fixture();changeBody(v,p=>p.top_p=0.95);
 assert.equal(checkComplete(v).taskSpans[0].generationParams.top_p,Math.fround(0.95));
});
test('identical first generation retry is ambiguous even if both attempts completed',()=>{
 rejected(()=>{},'unique-observation-required',{retry:true});
});
test('foreign generation content anywhere in the bounded inventory fails binding',()=>{
 rejected(()=>{},'unbound-generation-traffic',{foreign:true});
});
test('prefix-like and counting paths cannot replace the exact generation route',()=>{
 rejected(v=>mutateEvent(v,'http_request',e=>e.data.path='/v1/chat/completions/extra',e=>e.data.path==='/v1/chat/completions'),'unique-observation-required');
});
test('a raw model response cannot substitute for native run, thread, audit and runtime evidence',()=>{
 const q=normalizeManagedRouteObservation({complete:true,capture:{complete:true}});
 assert.equal(q.complete,false);assert.equal(q.capture,null);assert.ok(q.missing.length+q.conflicts.length>0);
});
for(const [name,change]of [
 ['run ID',v=>v.nativeRun.id='other_run'],
 ['client request ID',v=>v.nativeRun.metadata.clientRequestId='other_request'],
 ['provider thread',v=>v.providerThread.id='provider_other'],
 ['model',v=>v.providerThread.model='other_model'],
 ['node turn',v=>v.nativeRun.nodes.agent.turnId='other_turn'],
 ['audit developer digest',v=>v.nativeRun.nodes.agent.instructionAudit.developer.sha256=a],
 ['audit tools digest',v=>v.nativeRun.nodes.agent.instructionAudit.tools.sha256=a],
])test('rejects mismatched '+name,()=>rejected(change));
test('unaccepted audit and compacted transcript cannot qualify',()=>{
 rejected(v=>v.nativeRun.nodes.agent.instructionAudit.delivery='prepared','observed-accepted-audit-required');
 rejected(v=>v.providerThread.compactions.push({at:at(3000)}),'uncompacted-initial-thread-required');
});
test('other active host work invalidates the observed exclusive activity window',()=>{
 rejected(v=>v.hostActivity.active[0].bytes=Buffer.from(JSON.stringify([{id:'run_foreign',status:'running',settled:false}])),'other-active-or-unsettled-host-run');
});
test('an active owned observation is required and cannot be reconstructed from final status',()=>{
 rejected(v=>v.hostActivity.active=[],'owned-active-snapshot-required');
});
test('raw complete host array is required, not a paginated wrapper or corrupted JSON',()=>{
 rejected(v=>v.hostActivity.before.bytes=Buffer.from('{"runs":[],"next":"cursor"}'),'complete-unpaginated-run-list-required');
 rejected(v=>v.hostActivity.before.bytes=Buffer.from('[broken'),'invalid-json-or-utf8');
});
test('host before observation must actually precede fresh admission',()=>{
 rejected(v=>v.hostActivity.before.finishedAt=at(10),'snapshot-before-fresh-admission-required');
});
for(const [name,change]of [
 ['final host',v=>v.hostActivity.after.finishedAt=at(500)],
 ['source',v=>v.sourceObservation.at=at(0)],
 ['OS process chain',v=>v.osObservation.at=at(0)],
 ['runtime props',v=>v.runtimeInput.propsResponse.at=at(0)],
])test('stale '+name+' evidence fails while historical snapshots remain allowed',()=>rejected(change));
test('unsupported current provider source fails even with a recomputed identity hash',()=>{
 rejected(v=>{v.sourceObservation.sourceIdentity.files['lib/providers.mjs']=a;v.sourceObservation.sourceIdentity.sha256=digest({appVersion:'2.40.72',files:v.sourceObservation.sourceIdentity.files});});
});
test('router parent ID must join the actual independently observed request',()=>{
 rejected(v=>mutateEvent(v,'http_request',e=>e.data.parentServerRequestId='missing',e=>e.pid===42&&e.data.path==='/v1/chat/completions'),'unique-observation-required');
});
test('native process births and independently observed ancestry must agree',()=>{
 rejected(v=>v.osObservation.processes[1].parentPid=999,'router-not-in-observed-child-ancestry');
 rejected(v=>v.osObservation.processes[1].startedAt=at(1));
 rejected(v=>v.osObservation.processes[1].executablePath='C:\\other\\llama-server.exe','executable-path-mismatch');
});
test('stable readback cannot conceal changed request bytes relative to native body digest',()=>{
 rejected(v=>{const f=v.trace.artifacts.find(f=>f.path.endsWith('request-c-gen-1.body.bin'));f.bytes=Buffer.from('{"changed":true}');seal(v);},'referenced-artifact-mismatch');
});
test('raw startup receipt, native event, current props and R3 enrichment must agree',()=>{
 rejected(v=>{const f=v.trace.artifacts.find(f=>f.path.endsWith('.startup.json'));const p=JSON.parse(f.bytes);p.runtime.ctxSize=4096;f.bytes=Buffer.from(JSON.stringify(p)+'\n');seal(v);},'referenced-artifact-mismatch');
});
test('reread drift, replacement and directory growth all invalidate the bounded snapshot',()=>{
 rejected(v=>{const f=v.trace.artifacts[0];f.rereadBytes=Buffer.from('changed');},'missing-changed-or-unread-artifact');
 rejected(v=>v.trace.inventoryAfter.files[0].identity.ino='999','changed-or-incomplete-bounded-snapshot');
 rejected(v=>v.trace.inventoryAfter.files.push({path:'C:\\trace\\D0\\new.body.bin',size:0,identity:{dev:'1',ino:'99',birthtimeNs:'1795250000000000000'}}),'changed-or-incomplete-bounded-snapshot');
});
test('omitted observed files and paths outside the trace root are rejected',()=>{
 rejected(v=>v.trace.artifacts.pop(),'omitted-observed-artifacts');
 rejected(v=>{v.trace.artifacts[0].path='C:\\elsewhere\\body.bin';seal(v);},'invalid-file-identity-or-scope');
});
test('torn tails and per-file gaps fail instead of silently cropping inconvenient bytes',()=>{
 rejected(v=>{const f=v.trace.artifacts.find(f=>f.path.endsWith('.jsonl'));f.bytes=f.bytes.subarray(0,f.bytes.length-1);seal(v);},'torn-jsonl-tail');
 rejected(v=>mutateEvent(v,'task_registered',e=>e.fileSequence+=1),'invalid-identity-or-file-sequence');
});
test('globally missing cross-file process sequence fails even with intact local sequence',()=>{
 rejected(v=>mutateEvent(v,'task_registered',e=>e.processSequence+=1000),'incomplete-cross-file-process-sequence');
});
test('an applicable native invalid marker rejects otherwise positive terminal evidence',()=>{
 rejected(v=>{v.trace.artifacts.push({path:'C:\\trace\\D0\\42-child-one.invalid.json',bytes:Buffer.from(JSON.stringify({schema:'blackice.minicpm.trace-invalid.v1',pid:42,processId:'child-one',complete:false,reason:'write-failure',droppedEvents:1}))});seal(v);},'selected-process-invalid-marker');
});
for(const name of ['task_registered','task_slot_assigned','task_terminal','slot_release','http_response_observed','http_generator_end'])
 test('missing '+name+' remains an explicit incomplete observation',()=>rejected(v=>removeEvent(v,name),'unique-observation-required'));
for(const [field,value]of [['complete',false],['transportProviderSuccess',false],['producerExhausted',false],['sinkDoneCalled',false],['chunkWriteFailed',true]])
 test('streaming '+field+' must report successful producer and transport completion',()=>rejected(v=>mutateEvent(v,'http_generator_end',e=>e.data[field]=value,e=>e.data.streaming===true),'successful-complete-http-terminal-required'));
test('old streaming evidence missing the new independent completion fields is unsupported',()=>{
 rejected(v=>mutateEvent(v,'http_generator_end',e=>delete e.data.producerExhausted,e=>e.data.streaming===true),'successful-complete-http-terminal-required');
});
test('router and child status observations both matter despite their early logger time',()=>{
 rejected(v=>mutateEvent(v,'http_response_observed',e=>e.data.status=503,e=>e.pid===41&&e.data.serverRequestId==='r-gen-1'),'successful-complete-http-terminal-required');
});
test('task terminals bind completion identity, exact event counts and native counter types',()=>{
 rejected(v=>mutateEvent(v,'task_terminal',e=>e.data.completionId='wrong'),'unique-complete-counted-task-terminal-required');
 rejected(v=>mutateEvent(v,'task_terminal',e=>e.data.acceptedTokenEvents=2),'unique-complete-counted-task-terminal-required');
 rejected(v=>mutateEvent(v,'task_terminal',e=>e.data.stopType='eos'),'unique-complete-counted-task-terminal-required');
});
test('sampled and accepted token sequences must match',()=>{
 rejected(v=>mutateEvent(v,'accepted_token',e=>e.data.tokenId=99),'complete-matching-sampled-and-accepted-tokens-required');
});
test('sampler string and resolved seed are actual task observations',()=>{
 rejected(v=>mutateEvent(v,'task_slot_assigned',e=>e.data.samplerChain=[]),'actual-sampler-and-slot-required');
 rejected(v=>mutateEvent(v,'task_slot_assigned',e=>delete e.data.samplerSeed),'actual-sampler-and-slot-required');
});
test('effective task sampling and output budget cannot silently drift',()=>{
 rejected(v=>mutateEvent(v,'task_registered',e=>e.data.generationParams.top_p=0.5),'effective-task-parameter-differs');
 rejected(v=>mutateEvent(v,'task_registered',e=>delete e.data.generationParams),'actual-task-generation-parameters-required');
 rejected(v=>mutateEvent(v,'task_registered',e=>{e.data.generationParams.n_predict=2048;e.data.generationParams.max_tokens=2048;}));
});
test('actual provider context and runtime window are required without budget defaults',()=>{
 rejected(v=>delete v.providerThread.contextStatus,'observed-provider-context-options-and-status-required');
 rejected(v=>v.providerThread.contextStatus.effectiveWindowTokens=32768);
 rejected(v=>v.providerThread.contextOptions.autoCompact=true,'observed-provider-context-options-and-status-required');
});

test('foreign generation begun before the host window still fails if it overlaps',()=>{
 rejected(v=>{
  changeEvents(v,rows=>{
   for(const {event:e}of rows){
    if(e.event==='http_request'&&e.data.path==='/v1/chat/completions'){e.at=at(-700);e.processStartedAt=at(-2000);}
    if(e.pid===42)e.processStartedAt=at(-2000);
   }
  });
 },'generation-before-owned-admission');
});
test('unaccounted generation aliases or other POST operations cannot disappear into otherRequests',()=>{
 for(const route of ['/completion','/v1/completions','/slots/0'])rejected(v=>mutateEvent(v,'http_request',e=>e.data.path=route,e=>e.data.path==='/v1/chat/completions'),'unaccounted-overlapping-post-traffic');
});
test('an unaccounted native task is rejected even if no known chat HTTP route accompanies it',()=>{
 rejected(v=>changeEvents(v,rows=>{
  const r=rows.find(x=>x.event.event==='task_registered'),extra=structuredClone(r.event);extra.data.taskId=88;extra.data.serverRequestId='unknown';extra.processSequence=999;extra.at=at(4500);rows.push({file:r.file,event:extra});
 },{resequence:true}),'unaccounted-overlapping-native-task');
});
test('actual task prompt positions must all be text and agree with observed token IDs',()=>{
 rejected(v=>mutateEvent(v,'task_registered',e=>delete e.data.allPromptPositionsAreText),'exact-chat-task-registration-required');
 rejected(v=>mutateEvent(v,'task_registered',e=>e.data.nPromptPositions=4),'exact-chat-task-registration-required');
});
test('sample and accepted evidence must bind the assigned slot as well as task and startup',()=>{
 rejected(v=>mutateEvent(v,'sample_logits',e=>e.data.slotId=9),'complete-matching-sampled-and-accepted-tokens-required');
 rejected(v=>mutateEvent(v,'accepted_token',e=>e.data.slotId=9),'complete-matching-sampled-and-accepted-tokens-required');
});

test('the public managed-route entry point cannot qualify without independently supplied current-context bytes',()=>{
 const v=fixture(),missing=normalizeManagedRaw(v);
 assert.equal(missing.complete,false);assert.equal(missing.capture,null);
 assert.ok(missing.missing.some(x=>x.code==='independent-runtime-observation-incomplete'));
 const wrong={...v.fixtureRuntimeBytes,startupArtifactBytes:Buffer.from('{}\n')},q=normalizeManagedRaw(v,wrong);
 assert.equal(q.complete,false);assert.equal(q.capture,null);
});
