'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawn,spawnSync}=require('node:child_process');
const C=require('./parity-contract.cjs');
const I=require('./parity-io.cjs');
const R=require('./runtime-parity.cjs');
const p=require('./profile.json');
const sse=events=>Buffer.from(events.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n');
function chat(id='chatcmpl_fixture',callId='call_fixture'){
 return C.collectChat(sse([{id,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name:'parity_echo',arguments:'{"value":"parity-ok"}'}}]},finish_reason:null}]},
 {id,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
 {id,choices:[],usage:{prompt_tokens:300,completion_tokens:20,prompt_tokens_details:{cached_tokens:0}}}]));
}
function runtime(){
 const model=path.resolve('fixture.gguf'),props={default_generation_settings:{n_ctx:262144,params:{seed:1234,temperature:Math.fround(.8),top_k:40,top_p:Math.fround(.95),min_p:Math.fround(.05)}},total_slots:1,model_alias:'minicpm-parity',model_path:model,modalities:{vision:false,video:false},chat_template:'fixture',build_info:'fixture'};
 const startupLog='system_info: n_threads = 6 (n_threads_batch = 6)\nllama_context: n_ctx_seq = 262144\nllama_context: n_seq_max = 1\nllama_context: n_batch = 2048\nllama_context: n_ubatch = 512\nllama_context: flash_attn = enabled\nload_tensors: offloaded 25/25 layers to GPU\nllama_kv_cache: size = 10 MiB (262144 cells, 24 layers, 1/1 seqs), K (q8_0): 5 MiB, V (q8_0): 5 MiB\n';
 return {profile:p,props,model,slots:[{id:0,n_ctx:262144,is_processing:false}],startupLog};
}
function saved(){
 const completion={content:'delta',tokens:[42],stopType:'eos'},tool=chat(),answer={...chat(),message:{role:'assistant',content:'parity-ok'},finishReason:'stop'};
 const probes={};for(const name of ['completion-cold','completion-cached','chat-cold-call','chat-cold-answer','chat-cached-call','chat-cached-answer'])probes[name]={request:{bodySha256:'fixture-'+name},response:{bodySha256:'wire-'+name},result:name.startsWith('completion')?structuredClone(completion):structuredClone(name.endsWith('call')?tool:answer)};
 return {schema:C.RUN_SCHEMA,variant:'original',complete:true,collectionComplete:true,parityFindings:{passed:true},identity:{model:{after:{sha256:'a'.repeat(64)}},executable:{before:{sha256:'b'.repeat(64)}}},loadedBackendModules:[{name:'ggml-vulkan.dll',sha256:'c'.repeat(64)}],profile:p,runtime:C.assessRuntime(runtime()),childEnvironmentSha256:'env',probes};
}
test('profile rejects unknown keys and deviations from frozen full-context runtime',()=>{
 assert.equal(C.validateProfile(p).runtime.ctxSize,262144);
 const drift=structuredClone(p);drift.runtime.ctxSize=8192;assert.throws(()=>C.validateProfile(drift));
 const typo=structuredClone(p);typo.runtime.threads_batch=6;assert.throws(()=>C.validateProfile(typo),/unknown keys/);
});
test('argv uses one direct model and all explicit runtime controls without a projector',()=>{
 const args=C.buildArgv(p,{model:path.resolve('fixture.gguf'),port:18081,slotDirectory:path.resolve('owned-slot-state')});
 assert.equal(args[args.indexOf('--ctx-size')+1],'262144');assert.equal(args[args.indexOf('--parallel')+1],'1');
 assert.equal(args[args.indexOf('--flash-attn')+1],'on');assert.equal(args.includes('--mmproj'),false);assert.equal(args.includes('--models-preset'),false);assert.equal(args[args.indexOf('--slot-save-path')+1],path.resolve('owned-slot-state'));
});
test('native token IDs and terminal must be observed; cache size is not reuse',()=>{
 const v={content:'delta',tokens:[1,2],stop:true,truncated:false,stop_type:'eos',tokens_evaluated:20,tokens_cached:999,timings:{prompt_n:1}};
 assert.equal(C.validateCompletion(v).cachedPromptTokens,19);
 for(const change of [{tokens:[]},{tokens:null},{truncated:true},{stop_type:'limit'},{timings:{}}])assert.throws(()=>C.validateCompletion({...v,...change}));
});
test('SSE requires DONE and preserves exact UTF8 content',()=>{
 const bytes=sse([{id:'chat',choices:[{delta:{content:'λ😀'},finish_reason:'stop'}],usage:{prompt_tokens_details:{cached_tokens:0}}}]);
 assert.equal(C.collectChat(bytes).message.content,'λ😀');assert.throws(()=>C.collectChat(bytes.subarray(0,bytes.indexOf(Buffer.from('data: [DONE]')))),/terminal marker/);
 assert.throws(()=>C.collectChat(Buffer.concat([bytes,Buffer.from('data: {}\n\n')])),/followed/);
});
test('length termination, missing cache counts, and unimplemented reasoning details fail explicitly',()=>{
 for(const value of [
 {id:'chat',choices:[{delta:{content:'x'},finish_reason:'length'}],usage:{prompt_tokens_details:{cached_tokens:0}}},
 {id:'chat',choices:[{delta:{content:'x'},finish_reason:'stop'}]},
 {id:'chat',choices:[{delta:{reasoning_details:[{}]},finish_reason:'stop'}],usage:{prompt_tokens_details:{cached_tokens:0}}}
 ])assert.throws(()=>C.collectChat(sse([value])));
});
test('host alias mapping preserves raw tool ID and exact content/arguments',()=>{
 const a=chat('response_a','call_a'),b=chat('response_b','call_b'),aa=C.executeTool(p,a),bb=C.executeTool(p,b);
 assert.equal(a.message.tool_calls[0].id,'call_a');assert.equal(aa.idMapping.observed,'call_a');assert.deepEqual(aa.body,bb.body);
 assert.equal(aa.body.messages[2].tool_calls[0].function.arguments,a.message.tool_calls[0].function.arguments);
 assert.equal(aa.body.messages[3].content,'parity-ok');
});
test('unknown tool and malformed or truncated arguments cannot execute',()=>{
 const a=chat();a.message.tool_calls[0].function.name='shell';assert.throws(()=>C.executeTool(p,a));
 const b=chat();b.message.tool_calls[0].function.arguments='{"value":';assert.throws(()=>C.executeTool(p,b));
});
test('actual runtime evidence is required for context, vision, sampling and startup settings',()=>{
 assert.equal(C.assessRuntime(runtime()).complete,true);
 for(const mutate of [
 x=>x.props.default_generation_settings.n_ctx=8192,x=>x.props.modalities.vision=true,x=>x.props.default_generation_settings.params.seed=4294967295,
 x=>x.startupLog=x.startupLog.replace('n_batch = 2048','n_batch = 512'),x=>x.startupLog=''
 ]){const x=runtime();mutate(x);assert.equal(C.assessRuntime(x).complete,false);}
});
test('original/rebuilt compare maps IDs but does not normalize message text or request bytes',()=>{
 const a=saved(),b=structuredClone(a);b.variant='rebuilt-baseline';
 for(const probe of Object.values(b.probes)){probe.response.bodySha256+='different';if(probe.result.responseId)probe.result.responseId='new_id';if(probe.result.message?.tool_calls)probe.result.message.tool_calls[0].id='new_tool_id';}
 const good=C.compareRuns(a,b,'original-rebuilt');assert.equal(good.passed,true);assert.equal(good.wire.every(x=>x.rawBytesEqual===false),true);assert.ok(good.identityMappings.length);
 b.probes['chat-cold-answer'].result.message.content+=' ';assert.equal(C.compareRuns(a,b,'original-rebuilt').passed,false);
 b.probes['chat-cold-answer'].result.message.content='parity-ok';b.probes['chat-cold-answer'].request.bodySha256='changed';assert.equal(C.compareRuns(a,b,'original-rebuilt').passed,false);
});
test('incomplete runs and missing native activation evidence cannot pass',()=>{
 const a=saved(),b=structuredClone(a);b.variant='rebuilt-baseline';a.complete=false;assert.equal(C.compareRuns(a,b,'original-rebuilt').passed,false);
 a.complete=true;a.variant='instrumented-off';b.variant='instrumented-on';a.traceConfig={enabled:true,activationCaptureEnabled:false};b.traceConfig={enabled:true,activationCaptureEnabled:true};
 assert.equal(C.compareRuns(a,b,'activation-toggle').passed,false);
});
test('CLI refuses omitted or unknown options before any model action',()=>{
 assert.equal(R.parseArgs(['--help']).command,'help');assert.throws(()=>R.parseArgs(['run','--exe','x']),/Missing/);
 assert.throws(()=>R.parseArgs(['compare','--left','x','--right','x','--out','x','--mode','original-rebuilt','--surprise','x']),/Unknown/);
});
test('a complete native invocation accepts SHA-256 option names before any effect',()=>{
 const base=path.resolve('fixture'),args=['run','--exe',path.join(base,'server.exe'),'--exe-sha256','a'.repeat(64),'--model',path.join(base,'model.gguf'),'--model-sha256','b'.repeat(64),'--out',path.join(base,'new'),'--port','18081','--label','original-test','--variant','original','--config',path.join(base,'profile.json'),'--admission',path.join(base,'admission.json')];
 const parsed=R.parseArgs(args);assert.equal(parsed.command,'run');assert.equal(parsed.options['exe-sha256'],'a'.repeat(64));assert.equal(parsed.options.port,18081);
});

test('admission requires fresh explicit checks and raw snapshots',()=>{
 const x={schema:'blackice.minicpm.parity-admission.v1',at:new Date().toISOString(),checks:{appIdle:true,modelIdle:true},statusResponse:{active:0},configResponse:{owned:false},processSnapshot:[]};
 assert.equal(R.validateAdmission(x),x);assert.throws(()=>R.validateAdmission({...x,at:'2000-01-01T00:00:00Z'}),/stale/);assert.throws(()=>R.validateAdmission({...x,statusResponse:null}),/Raw host/);
});
test('help executes without model or file effects',()=>{
 const r=spawnSync(process.execPath,[path.join(__dirname,'runtime-parity.cjs'),'--help'],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/start no model/);
});
test('cleanup settles only its owned child and leaves a separate process alive',async()=>{
 const children=[0,1].map(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}));
 try{const result=await I.settleChild(children[0],3000);assert.equal(result.settled,true);assert.equal(children[1].exitCode,null);assert.equal(children[1].signalCode,null);}
 finally{await I.settleChild(children[0],1000);await I.settleChild(children[1],3000);}
});

test('a complete verbose continuation records instruction deviation without changing its text',()=>{
 const text="The function has been called and the result is 'parity-ok'.";
 const observation=C.validateAnswer({finishReason:'stop',message:{role:'assistant',content:text}});
 assert.equal(observation.exactExpectedAnswer,false);assert.equal(observation.observedAnswer,text);
 assert.equal(C.validateAnswer({finishReason:'stop',message:{role:'assistant',content:'parity-ok'}}).exactExpectedAnswer,true);
 for(const value of [{finishReason:'length',message:{content:text}},{finishReason:'stop',message:{content:''}},{finishReason:'stop',message:{content:text,tool_calls:[{}]}}])assert.throws(()=>C.validateAnswer(value));
});

test('missing identical token arrays and missing backend identity cannot pass comparison',()=>{const a=saved(),b=structuredClone(a);b.variant='rebuilt-baseline';a.probes['completion-cold'].result.tokens=[];b.probes['completion-cold'].result.tokens=[];assert.equal(C.compareRuns(a,b,'original-rebuilt').passed,false);const c=saved(),d=structuredClone(c);d.variant='rebuilt-baseline';delete c.loadedBackendModules;delete d.loadedBackendModules;assert.equal(C.compareRuns(c,d,'original-rebuilt').passed,false);});

test('I/O-compatibility baseline is explicitly labeled rather than called unmodified',()=>{
 const a=saved(),b=structuredClone(a);b.variant='rebuilt-io-compat-baseline';b.label='io-compat-baseline-fixture';
 const value=C.compareRuns(a,b,'original-rebuilt');assert.equal(value.passed,true);assert.match(value.rebuiltSourceScope,/CRT filename I\/O compatibility/);assert.equal(value.runtimeLabels.right,b.label);
});

test('per-command restart capability is absent from actual model-child environments while runtime controls remain visible',()=>{
 const make=(nonce,device='0')=>({...process.env,BLACKICE_RESTART_ORIGIN:nonce,LLAMA_ARG_CTX_SIZE:'7',BLACKICE_TRACE_CONFIG:'discarded-fixture',GGML_VK_VISIBLE_DEVICES:device});
 const a=I.childEnvironment(null,make('fixture-origin-A')),b=I.childEnvironment(null,make('fixture-origin-B'));
 assert.equal(Object.hasOwn(a.env,'BLACKICE_RESTART_ORIGIN'),false);assert.equal(Object.hasOwn(a.env,'LLAMA_ARG_CTX_SIZE'),false);assert.equal(Object.hasOwn(a.env,'BLACKICE_TRACE_CONFIG'),false);
 assert.equal(a.fingerprint,b.fingerprint);assert.deepEqual(a.env,b.env);
 const cleared=x=>x.removedProvenance.find(v=>v.name==='BLACKICE_RESTART_ORIGIN');
 assert.notEqual(cleared(a).valueSha256,cleared(b).valueSha256);assert.equal(cleared(a).reason,'application-only-restart-capability');
 assert.equal(JSON.stringify(a.removedProvenance).includes('fixture-origin-A'),false);
 const child=env=>{const r=spawnSync(process.execPath,['-e',"console.log(JSON.stringify({restartNames:Object.keys(process.env).filter(k=>k.toUpperCase()==='BLACKICE_RESTART_ORIGIN'),device:process.env.GGML_VK_VISIBLE_DEVICES}))"],{env,encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 assert.deepEqual(child(a.env),{restartNames:[],device:'0'});assert.deepEqual(child(b.env),{restartNames:[],device:'0'});
 const changed=I.childEnvironment(null,make('fixture-origin-A','1'));assert.notEqual(a.fingerprint,changed.fingerprint);assert.notEqual(a.actualVariableHashes.GGML_VK_VISIBLE_DEVICES,changed.actualVariableHashes.GGML_VK_VISIBLE_DEVICES);
 assert.equal(changed.env.GGML_VK_VISIBLE_DEVICES,'1');
 const controlled=I.childEnvironment('controlled-trace-path',make('fixture-origin-A'));assert.equal(controlled.fingerprint,a.fingerprint);assert.equal(controlled.env.BLACKICE_TRACE_CONFIG,'controlled-trace-path');assert.notEqual(controlled.actualFingerprint,a.actualFingerprint);
});

function withEnvironment(value,tracePath,extra={}){
 const env=I.childEnvironment(tracePath,{GGML_VK_VISIBLE_DEVICES:'0',...extra});
 value.childEnvironmentSha256=env.fingerprint;
 value.childEnvironmentEvidence={baseSha256:env.fingerprint,actualSha256:env.actualFingerprint,baseVariableHashes:env.baseVariableHashes,actualVariableHashes:env.actualVariableHashes,policy:I.RESTART_ORIGIN_SOURCE,source:{sha256:I.RESTART_ORIGIN_SOURCE.sha256}};
 return value;
}
function instrumentedSaved(activation){
 const value=withEnvironment(saved(),'C:\\fixture\\shared-trace.json');
 value.variant=activation?'instrumented-on':'instrumented-off';value.traceConfigPath='C:\\fixture\\shared-trace.json';
 value.traceConfig={schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:activation,outputDirectory:'C:\\fixture\\native-trace',...p.trace};
 value.traceConfigBytesUTF8=JSON.stringify(value.traceConfig,null,2)+'\n';
 value.traceConfigEvidence={path:'C:\\fixture\\'+(activation?'on':'off')+'-snapshot.json',bytes:Buffer.byteLength(value.traceConfigBytesUTF8),sha256:C.sha(value.traceConfigBytesUTF8)};
 value.traceConfigPublication={path:value.traceConfigPath,complete:true,published:{path:value.traceConfigPath,sha256:value.traceConfigEvidence.sha256},
  previous:activation?{path:'C:\\fixture\\on-preimage.json',sha256:C.sha(JSON.stringify({...value.traceConfig,activationCaptureEnabled:false},null,2)+'\n')}:null};
 value.native={complete:true,tasks:Object.fromEntries(Object.keys(value.probes).map(name=>[name,{complete:true,promptTokenIds:[1,2],acceptedTokenIds:[42],sampledTokenIds:[42],rawLogitHashes:['d'.repeat(64)]}]))};
 return value;
}
test('shared trace publication preserves exact snapshots and rejects a different preimage before replacement',()=>{
 const base=process.env.BLACKICE_PARITY_TEST_ROOT||require('node:os').tmpdir();fs.mkdirSync(base,{recursive:true});const folder=fs.mkdtempSync(path.join(base,'trace-publish-'));
 try{
  const livePath=path.join(folder,'shared','blackice-trace.json'),off=Buffer.from('{"activationCaptureEnabled":false,"outputDirectory":"same"}\n'),on=Buffer.from('{"activationCaptureEnabled":true,"outputDirectory":"same"}\n');
  I.save(path.join(folder,'off-snapshot.json'),off);I.save(path.join(folder,'on-snapshot.json'),on);
  const first={};I.publishTraceConfig({livePath,bytes:off,record:first});assert.equal(first.complete,true);assert.deepEqual(fs.readFileSync(livePath),off);
  const rejected={};assert.throws(()=>I.publishTraceConfig({livePath,bytes:on,expectedPreviousBytes:Buffer.from('different'),preimagePath:path.join(folder,'rejected-preimage.json'),record:rejected}),{code:'PARITY_TRACE_CONFIG_PREIMAGE'});
  assert.equal(rejected.complete,false);assert.equal(rejected.previous.sha256,C.sha(off));assert.deepEqual(fs.readFileSync(livePath),off);
  const second={};I.publishTraceConfig({livePath,bytes:on,expectedPreviousBytes:off,preimagePath:path.join(folder,'on-preimage.json'),record:second});
  assert.equal(second.complete,true);assert.equal(second.path,first.path);assert.deepEqual(fs.readFileSync(livePath),on);assert.deepEqual(fs.readFileSync(second.previous.path),off);assert.deepEqual(fs.readFileSync(path.join(folder,'off-snapshot.json')),off);
  assert.throws(()=>I.publishTraceConfig({livePath,bytes:off,record:{}}),{code:'PARITY_TRACE_CONFIG_EXISTS'});assert.deepEqual(fs.readFileSync(livePath),on);
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('instrumented CLI requires both explicit absolute shared trace paths',()=>{
 const base=path.resolve('fixture'),args=['run','--exe',path.join(base,'server.exe'),'--exe-sha256','a'.repeat(64),'--model',path.join(base,'model.gguf'),'--model-sha256','b'.repeat(64),'--out',path.join(base,'out'),'--port','18081','--label','off-fixture','--variant','instrumented-off','--config',path.join(base,'profile.json'),'--admission',path.join(base,'admission.json'),'--trace-directory',path.join(base,'native')];
 assert.throws(()=>R.parseArgs(args.slice()),/Both explicit trace/);
 assert.equal(R.parseArgs([...args,'--trace-config',path.join(base,'shared.json')]).options['trace-config'],path.join(base,'shared.json'));
 assert.throws(()=>R.parseArgs([...args,'--trace-config','relative.json']),/must be absolute/);
 assert.throws(()=>R.parseArgs([...args,'--trace-config',path.join(base,'out','blackice-trace.json')]),/immutable run snapshot/);
});
test('baseline versus metadata recording discloses exactly the bound trace environment addition',()=>{
 const left=withEnvironment(saved(),null);left.variant='rebuilt-io-compat-baseline';const right=instrumentedSaved(false);
 const value=C.compareRuns(left,right,'baseline-instrumented');assert.equal(value.passed,true,JSON.stringify(value.differences));assert.equal(value.environmentEvidence.rawEnvironmentEqual,false);
 assert.deepEqual(value.environmentEvidence.variableDifferences,[{name:'BLACKICE_TRACE_CONFIG',leftSha256:null,rightSha256:C.sha(right.traceConfigPath)}]);
 const runtimeChange=withEnvironment(structuredClone(right),right.traceConfigPath,{GGML_VK_VISIBLE_DEVICES:'1'});assert.equal(C.compareRuns(left,runtimeChange,'baseline-instrumented').passed,false);
 const unbound=structuredClone(right);unbound.traceConfigPath='C:\\fixture\\foreign.json';assert.equal(C.compareRuns(left,unbound,'baseline-instrumented').passed,false);
 const missing=structuredClone(right);delete missing.childEnvironmentEvidence;assert.equal(C.compareRuns(left,missing,'baseline-instrumented').passed,false);
});
test('activation toggle requires full environment, shared paths and exact config bytes with the retained off preimage',()=>{
 const left=instrumentedSaved(false),right=instrumentedSaved(true);assert.equal(C.compareRuns(left,right,'activation-toggle').passed,true);
 for(const change of [
  value=>{value.traceConfigPath='C:\\fixture\\other.json';},
  value=>{value.childEnvironmentEvidence.actualSha256='e'.repeat(64);},
  value=>{value.traceConfigPublication.previous.sha256='e'.repeat(64);},
  value=>{value.traceConfigBytesUTF8+='\n';value.traceConfigEvidence.sha256=C.sha(value.traceConfigBytesUTF8);value.traceConfigPublication.published.sha256=value.traceConfigEvidence.sha256;},
  value=>{value.traceConfig.maxBytes++;value.traceConfigBytesUTF8=JSON.stringify(value.traceConfig,null,2)+'\n';value.traceConfigEvidence.sha256=C.sha(value.traceConfigBytesUTF8);value.traceConfigPublication.published.sha256=value.traceConfigEvidence.sha256;},
  value=>{value.native.tasks['completion-cold'].rawLogitHashes=['f'.repeat(64)];}
 ]){const changed=structuredClone(right);change(changed);assert.equal(C.compareRuns(left,changed,'activation-toggle').passed,false);}
});
