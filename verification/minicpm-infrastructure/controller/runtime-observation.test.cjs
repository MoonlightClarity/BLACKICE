'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeRuntimeObservation:normalizeRuntimeRaw,STARTUP_SCHEMA}=require('./runtime-observation.cjs');
const {attachPublication}=require('./fixtures/context-publication.cjs');
// These preexisting condition cases now include explicit synthetic lifecycle bytes.
function normalizeRuntimeObservation(value){const f=attachPublication(value);return normalizeRuntimeRaw(f.input,f.bytes);}
const a='a'.repeat(64),b='b'.repeat(64);
function fixture(){
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
function rejected(change,code){
 const v=fixture();change(v);
 const result=normalizeRuntimeObservation(v);
 assert.equal(result.complete,false);
 if(code)assert.ok([...result.missing,...result.conflicts].some(x=>x.code===code),JSON.stringify(result));
 return result;
}
test('projects exact loaded native values and preserves floating-point sampler observations',()=>{
 const r=normalizeRuntimeObservation(fixture());
 assert.equal(r.complete,true,JSON.stringify(r));
 assert.deepEqual(r.missing,[]);assert.deepEqual(r.conflicts,[]);
 assert.equal(r.conditions.runtime.ctxSize,262144);
 assert.equal(r.conditions.runtime.gpuLayers,25);
 assert.equal(r.conditions.runtime.flashAttention,true);
 assert.equal(r.conditions.sampling.topP,0.949999988079071);
 assert.equal(r.conditions.sampling.minP,0.05000000074505806);
 assert.equal(r.conditions.config.savedRevision,19);
 assert.equal(r.conditions.config.appliedRevision,19);
 assert.equal(r.conditions.model.sha256,a);
 assert.equal(r.at,'2026-11-21T09:00:10.000Z');
 assert.match(r.provenance.observations.startupReceipt.canonicalSha256,/^[a-f0-9]{64}$/);
 assert.equal(r.provenance.fields['runtime.cacheK'][0].method.kind,'runtime-log');
});
test('keeps zero-valued effective choices without substituting defaults',()=>{
 const v=fixture();v.startupReceipt.runtime.gpuLayers=0;v.startupReceipt.runtime.flashAttention=false;
 Object.assign(v.propsResponse.json.default_generation_settings.params,{seed:0,temperature:0,top_k:0,top_p:0,min_p:0});
 const r=normalizeRuntimeObservation(v);assert.equal(r.complete,true);assert.equal(r.conditions.runtime.gpuLayers,0);assert.equal(r.conditions.sampling.topK,0);
});
test('saved settings alone never prove a loaded runtime',()=>{
 const v={now:'2026-11-21T09:00:10.000Z',maxEvidenceAgeMs:2000,modelId:'minicpm-test',
 configSnapshot:{at:'2026-11-21T09:00:10.000Z',revision:19,settings:{ctxSize:262144,threads:6,seed:1234},process:{owned:false,appliedRevision:null}}};
 const r=normalizeRuntimeObservation(v);assert.equal(r.complete,false);assert.equal(r.conditions.runtime.ctxSize,null);assert.equal(r.conditions.sampling.seed,null);
});
for(const value of [-1,4294967295])test('random seed '+value+' is unsuitable for fixed campaign admission',()=>{
 rejected(v=>{v.propsResponse.json.default_generation_settings.params.seed=value;},'random-seed');
});
for(const state of ['unloaded','loading','sleeping','error'])test('catalog state '+state+' is not loaded evidence',()=>{
 const r=rejected(v=>{v.catalogResponse.json.data[0].status={value:state};},'model-not-loaded');
 assert.equal(r.conditions.runtime.loaded,null);
});
test('sleeping props cannot establish a currently allocated context',()=>{
 rejected(v=>{v.propsResponse.json.is_sleeping=true;},'sleep-state-unresolved');
});
test('router dummy props are explicitly rejected',()=>{
 rejected(v=>{v.propsResponse.json.role='router';v.propsResponse.json.default_generation_settings.n_ctx=0;},'router-dummy-props');
});
test('exact model selection rejects absent and duplicated catalog entries',()=>{
 rejected(v=>{v.catalogResponse.json.data=[];},'exact-single-model-required');
 rejected(v=>{v.catalogResponse.json.data.push(structuredClone(v.catalogResponse.json.data[0]));},'exact-single-model-required');
});
test('foreign model file cannot be paired with current model hash',()=>{
 const r=rejected(v=>{v.propsResponse.json.model_path='C:\\models\\other.gguf';},'identity-conflict');
 assert.equal(r.conditions.model.sha256,null);assert.equal(r.conditions.runtime.ctxSize,null);
});
test('Windows paths compare canonically without accepting relative paths',()=>{
 const v=fixture();v.propsResponse.json.model_path='c:/MODELS/minicpm.gguf';
 assert.equal(normalizeRuntimeObservation(v).complete,true);
 rejected(v=>{v.propsResponse.json.model_path='minicpm.gguf';},'missing-or-invalid-identity');
});
test('new PID rejects an old startup receipt',()=>{
 const r=rejected(v=>{v.processIdentity.pid=43;},'identity-conflict');
 assert.equal(r.conditions.runtime.threads,null);
});
test('PID reuse with a different start time rejects an old startup receipt',()=>{
 rejected(v=>{v.processIdentity.startedAt='2026-11-21T09:00:00.500Z';},'identity-conflict');
});
test('same-process context reinitialization rejects the earlier startup id',()=>{
 rejected(v=>{v.propsResponse.json.blackice_runtime.startupId='context-2';},'identity-conflict');
});
test('legacy props without a context identity remain incomplete',()=>{
 rejected(v=>{delete v.propsResponse.json.blackice_runtime;},'missing-or-invalid-identity');
});
test('a foreign executable hash or build invalidates the runtime binding',()=>{
 rejected(v=>{v.processIdentity.binarySha256='c'.repeat(64);},'identity-conflict');
 rejected(v=>{v.propsResponse.json.build_info='another-build';},'identity-conflict');
 rejected(v=>{v.startupReceipt.binarySha256='c'.repeat(64);},'identity-conflict');
});
test('different loaded weights invalidate an otherwise matching runtime',()=>{
 rejected(v=>{v.startupReceipt.modelSha256='c'.repeat(64);},'identity-conflict');
});
test('conflicting allocated context observations remain explicit',()=>{
 const r=rejected(v=>{v.startupReceipt.runtime.ctxSize=32768;},'context-conflict');
 assert.equal(r.conditions.runtime.ctxSize,null);assert.ok(r.conflicts.some(x=>x.code==='catalog-context-conflict'));
});
test('training context is not substituted for runtime allocation',()=>{
 const v=fixture();v.catalogResponse.json.data[0].meta.n_ctx_train=131072;
 assert.equal(normalizeRuntimeObservation(v).complete,true);
 rejected(v=>{delete v.propsResponse.json.default_generation_settings.n_ctx;},'missing-model-props-context');
});
test('conflicting actual slot counts remain explicit',()=>{
 const r=rejected(v=>{v.propsResponse.json.total_slots=2;},'slot-conflict');
 assert.equal(r.conditions.runtime.parallel,null);
});
test('automatic and missing runtime parameters do not borrow saved settings',()=>{
 const r=rejected(v=>{v.startupReceipt.runtime.cacheV='auto';delete v.startupReceipt.runtime.threads;
  v.configSnapshot.settings={threads:6,cacheTypeV:'q8_0'};},'missing-effective-value');
 assert.equal(r.conditions.runtime.cacheV,null);assert.equal(r.conditions.runtime.threads,null);
});
test('launch arguments cannot masquerade as a runtime getter',()=>{
 const r=rejected(v=>{v.startupReceipt.fieldSources.batch={kind:'requested-setting',detail:'--batch-size 2048'};},'missing-runtime-provenance');
 assert.equal(r.conditions.runtime.batch,null);
});
test('dropped or incomplete startup evidence cannot pass',()=>{
 rejected(v=>{v.startupReceipt.complete=false;},'complete-startup-receipt-required');
 rejected(v=>{v.startupReceipt.droppedEvents=1;},'complete-startup-receipt-required');
 rejected(v=>{delete v.startupReceipt.droppedEvents;},'complete-startup-receipt-required');
});
test('unbounded clock omission cannot silently claim freshness',()=>{
 rejected(v=>{delete v.now;},'explicit-clock-and-age-required');
 rejected(v=>{delete v.maxEvidenceAgeMs;},'explicit-clock-and-age-required');
});
test('a stale snapshot fails while older initialization of the same live context is allowed',()=>{
 rejected(v=>{v.propsResponse.at='2026-11-21T09:00:02.000Z';},'stale-observation');
 const v=fixture();v.processIdentity.startedAt='2026-11-20T09:00:00.000Z';
 v.startupReceipt.processStartedAt=v.processIdentity.startedAt;v.propsResponse.json.blackice_runtime.processStartedAt=v.processIdentity.startedAt;
 v.startupReceipt.at='2026-11-20T09:00:01.000Z';
 assert.equal(normalizeRuntimeObservation(v).complete,true);
});
test('future observations or initialization before process start cannot pass',()=>{
 rejected(v=>{v.catalogResponse.at='2026-11-21T09:00:11.000Z';},'future-observation');
 rejected(v=>{v.startupReceipt.at='2026-11-21T08:59:59.000Z';},'context-time-not-bound');
});
test('earliest fresh read is retained instead of replacing it with the last read',()=>{
 const v=fixture();v.modelIdentity.at='2026-11-21T09:00:09.000Z';
 const r=normalizeRuntimeObservation(v);assert.equal(r.complete,true);assert.equal(r.at,'2026-11-21T09:00:09.000Z');
});
test('external process or unapplied configuration cannot be called fully observed',()=>{
 rejected(v=>{v.configSnapshot.process.owned=false;},'owned-stable-process-required');
 rejected(v=>{v.configSnapshot.process.appliedRevision=18;},'revision-conflict');
 rejected(v=>{v.configSnapshot.process.pendingRestart=true;},'restart-pending');
});
test('failed HTTP observations and string-valued samplers fail visibly',()=>{
 rejected(v=>{v.propsResponse.status=503;},'successful-model-props-required');
 rejected(v=>{v.catalogResponse.status=404;},'successful-catalog-required');
 rejected(v=>{v.propsResponse.json.default_generation_settings.params.top_p='0.95';},'missing-effective-value');
});
test('normalization is deterministic and does not mutate caller evidence',()=>{
 const v=fixture(),before=JSON.stringify(v),a=normalizeRuntimeObservation(v),b=normalizeRuntimeObservation(v);
 assert.equal(JSON.stringify(v),before);assert.deepEqual(a,b);
 a.provenance.fields['runtime.cacheK'][0].method.detail='changed';
 assert.equal(v.startupReceipt.fieldSources.cacheK.detail,'process-bound K (q8_0) startup log');
});

test('the public runtime entry point rejects reference-only or mismatched lifecycle proof bytes',()=>{
 const f=attachPublication(fixture()),missing=normalizeRuntimeRaw(f.input);
 assert.equal(missing.complete,false);assert.equal(missing.conditions.runtime.loaded,null);
 assert.ok(missing.missing.some(x=>x.code==='independently-read-artifact-bytes-required'));
 const wrong={...f.bytes,contextPrefixBytes:Buffer.from('unrelated\n')};
 assert.equal(normalizeRuntimeRaw(f.input,wrong).complete,false);
});
