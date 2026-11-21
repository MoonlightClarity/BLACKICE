'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const c=require('./run-conditions.cjs'),campaign=require('./campaign-controller.cjs'),api=require('./native-api.cjs');
const vm=require('node:vm');
const AT='2026-11-21T05:00:00.000Z',GRANT='connection-test',MODEL='minicpm_test::original',PAYLOAD='9'.repeat(64);
const plus=ms=>new Date(Date.parse(AT)+ms).toISOString();
function manifest(){return {schema:c.MANIFEST_SCHEMA,maxEvidenceAgeMs:30000,shared:{
 source:{appVersion:'2.40.71',sha256:'1'.repeat(64),stable:true},
 instructions:{coreSha256:'2'.repeat(64),selectedPolicySha256:'3'.repeat(64),auditStage:'adapter-prepared',auditStatus:'accepted'},
 tools:{names:['relay_workspace','relay_directory_action'],schemaSha256:'4'.repeat(64)},
 modes:{directoryActions:'on',directoryMode:'off',chatPlanning:'off',pastChats:'off'},
 context:{windowTokens:262144,autoCompact:false,outputReserveTokens:4096,headroomTokens:512},
 provider:{maxTokens:8192,maxSteps:null},
 runtime:{loaded:true,binarySha256:'5'.repeat(64),build:'b12359-b1b770d90',ctxSize:262144,cacheK:'q8_0',cacheV:'q8_0',parallel:1,threads:6,threadsBatch:6,batch:2048,ubatch:512,gpuLayers:25,flashAttention:true},
 sampling:{seed:7,temperature:0.8,topK:40,topP:0.95,minP:0.05},
 config:{savedRevision:18,appliedRevision:18,pendingRestart:false}
 },arms:{original:{path:'C:/models/original.gguf',sha256:'6'.repeat(64)},edited:{path:'C:/models/edited.gguf',sha256:'7'.repeat(64)}}};}
function config(m=manifest()){const text='Read the task and save the code.\n';const cfg={controllerId:'condition_test',requestId:'request_test',workflowId:'workflow_test',caseId:'D0',connectionId:GRANT,origin:'http://127.0.0.1:53151',workspace:'C:/benchmark/D0/original',task:'Task.\n'+text,method:{text,sha256:api.sha(text)},model:MODEL,context:{preset:'custom',...m.shared.context},budgets:{wallMs:300000,settlementGraceMs:60000,pollIntervalMs:1000,windowMs:4000,fetchTimeoutMs:1000,maxReceiptPages:8},allowedCommands:['node test-public.cjs']};cfg.benchmark={profile:'minicpm-code-v1',scaffoldReceiptPath:'C:/receipts/D0-original.json',scaffoldReceiptSha256:api.sha(scaffoldText(cfg))};return cfg;}
function binding(phase='admission',extra={}){return {phase,arm:'original',connectionId:GRANT,model:MODEL,now:AT,...(phase==='final'?{runId:'owned_run',requestId:'request_test',payloadSha256:PAYLOAD,notBeforeAt:AT}:{}),...extra};}
function observation(m=manifest(),phase='admission',extra={}){const arm=extra.arm||'original';return {schema:c.EVIDENCE_SCHEMA,at:AT,connectionId:GRANT,manifestSha256:c.manifestSha256(m),phase,arm,model:MODEL,conditions:{...structuredClone(m.shared),model:structuredClone(m.arms[arm])},...(phase==='final'?{runId:'owned_run',requestId:'request_test',payloadSha256:PAYLOAD}:{}),...extra};}
function preparedBody(cfg){return {requestId:cfg.requestId,workflow:{id:cfg.workflowId,nodes:[{id:'agent',type:'agent',model:cfg.model}],settings:{cwd:cfg.workspace,planningMode:'off',context:cfg.context}},input:{task:cfg.task,cwd:cfg.workspace,directoryMode:'off',directoryActions:'on',directoryDiagnostics:'maximal',chatPlanning:'off',pastChats:'off',planningMode:'off',benchmark:cfg.benchmark}};}
function ownedRun(cfg,status='running'){return {id:'owned_run',taskId:'owned_run',createdAt:AT,status,settled:status==='failed',cwd:cfg.workspace,input:cfg.task.trim(),metadata:{clientRequestId:cfg.requestId},workflow:preparedBody(cfg).workflow,executionModes:{directoryMode:'off',chatPlanning:'off',pastChats:'off'},directoryActions:'on',directoryDiagnostics:'maximal',chatPlanning:'off',pastChats:'off',benchmark:normalizedProfile(cfg),nodes:{agent:{threadId:'provider_owned',toolNames:['relay_workspace','relay_directory_action'],directoryContext:{runId:'owned_run',taskId:'owned_run',nodeId:'agent',hostTools:{received:0,returned:0,threw:0}}}},events:[],eventRetention:{omittedEvents:0}};}

function scaffoldText(cfg){
 const names=['METHOD.md','TASK.md','task.json','public-cases.json','test-public.cjs','test-support/grade-modules.cjs','test-support/module-worker.cjs'];
 const immutableFiles=Object.fromEntries(names.map((name,i)=>[name,String(i+1).repeat(64)]));immutableFiles['METHOD.md']=cfg.method.sha256;
 return JSON.stringify({schema:'blackice.minicpm.directory-smoke-scaffold.v1',caseId:cfg.caseId,scored:false,workspace:cfg.workspace,publicCaseCount:2,immutableFiles,initialSource:{'src/index.cjs':'8'.repeat(64)},method:{path:'METHOD.md',sha256:cfg.method.sha256}})+'\n';
}
function normalizedProfile(cfg){
 const receipt=JSON.parse(scaffoldText(cfg));
 const profile={schema:'blackice.minicpm.benchmark-profile.v1',profile:'minicpm-code-v1',workspace:cfg.workspace,caseId:cfg.caseId,publicCaseCount:2,command:'node test-public.cjs',scaffoldReceiptPath:cfg.benchmark.scaffoldReceiptPath,scaffoldReceiptSha256:cfg.benchmark.scaffoldReceiptSha256,immutableFiles:receipt.immutableFiles,limits:{maxModules:32,maxSourceBytes:200000,maxDepth:8,commandTimeoutMs:10000},isolation:'Enforced benchmark tool/API boundary with a restricted pure-function worker; not an operating-system sandbox.',functionName:'directorySmoke'};
 profile.contractSha256=c.digest(profile);return profile;
}
async function simulateCleanup(operation,run){
 const requests=[],responses=[run,{...run,status:'cancelled',settled:true}];
 class Clock extends Date{constructor(...args){super(...(args.length?args:[AT]));}static now(){return Date.parse(AT);}}
 const context={location:{origin:'http://127.0.0.1:53151'},Date:Clock,AbortSignal:{timeout:()=>({})},setTimeout:callback=>callback(),fetch:async(route,options)=>{requests.push({route,method:options.method});return {ok:true,status:200,text:async()=>JSON.stringify(responses.shift())};}};
 const result=await vm.runInNewContext(operation.arguments.expression,context);return {result,requests};
}

function create(){const m=manifest(),cfg=config(m);return campaign.createCampaign({config:cfg,manifest:m,arm:'original',scaffoldReceiptText:scaffoldText(cfg)},AT);}
function operate(state,value,opts={now:AT,connectionId:GRANT,evidence:observation(state.manifest)}){
 const planned=campaign.planNext(state,opts);assert.equal(planned.type,'submit');let next=campaign.commitOperation(state,planned,opts);
 const jobId='direct_'+String(next.controller.nextIndex).padStart(64,'0');
 next=campaign.recordSubmission(next,{jobId,connectionId:GRANT,requestId:next.controller.pending.requestId});
 return campaign.acceptResponse(next,{jobId,connectionId:GRANT,jobStatus:'succeeded',jobSettled:true,value,evidence:{path:'C:/evidence/result.json',sha256:'a'.repeat(64)}},opts.now);
}
function prepared(){const s=create();return operate(s,{kind:'prepare',body:preparedBody(s.controller.config)});}
function running(){const s=prepared();return operate(s,{kind:'start',run:ownedRun(s.controller.config)});}
function collected(s=running(),collectAt=AT){
 let run=ownedRun(s.controller.config,'failed');
 s=operate(s,{kind:'observe',run,startedAt:AT,finishedAt:AT,observations:[{at:AT,status:'failed',settled:true}],cancellations:[]},{now:AT,connectionId:GRANT});
 const pages=Object.fromEntries(['context','tools','decisions'].map(view=>[view,{complete:true,pages:[{view,runId:run.id,taskId:run.taskId,revision:'revision-'+view,offset:0,nextOffset:null,actions:[]}]}]));
 const bundle={kind:'collect',run,providerThreadId:'provider_owned',ledger:{runId:run.id,taskId:run.taskId,state:{taskId:run.taskId,actions:[],receipts:[],revision:0},final:{ready:false,reason:'no-actions',unknown:[]}},machine:{audience:'machine',runId:run.id,taskId:run.taskId,coverage:{source:'maximal-host-envelopes',dropped:0,entryMetadataOmitted:0,gaps:[]},entries:[]},receiptPages:pages};
 return operate(s,bundle,{now:collectAt,connectionId:GRANT});
}
function transcript(state){
 const cfg=state.controller.config,messages=[{role:'user',content:cfg.task}];
 const providerText=JSON.stringify({version:1,id:'provider_owned',providerId:'minicpm_test',providerType:'compatible',model:'original',cwd:cfg.workspace,hostOnlyTools:true,messages,transcript:messages})+'\n';
 return {providerText,providerEvidence:{path:'C:/evidence/provider.json',sha256:api.sha(providerText)}};
}
function payload(state,extra={}){return {runId:state.controller.run.id,requestId:state.binding.requestId,model:state.binding.model,manifestSha256:state.manifestSha256,connectionId:GRANT,arm:state.binding.arm,at:AT,payloadSha256:PAYLOAD,...extra};}
function projected(bind=true,collectAt=AT){
 let s=collected(running(),collectAt);if(bind)s=campaign.bindPayload(s,payload(s),{now:collectAt,connectionId:GRANT});
 return campaign.attachTranscript(s,transcript(s));
}
test('M5 manifest requires fixed condition fields, explicit age and both path/hash-only arms',()=>{
 for(const m of [{}, {...manifest(),shared:{}}, {...manifest(),maxEvidenceAgeMs:undefined}])assert.throws(()=>c.validateManifest(m));
 const m=manifest();delete m.shared.provider.maxSteps;assert.throws(()=>c.validateManifest(m),/required path/);
 const extra=manifest();extra.arms.edited.runtime={threads:2};assert.throws(()=>c.validateManifest(extra),/Model arm/);
});
test('M5 complete matching profile accepts explicit null maxSteps and keeps arm differences limited to model identity',()=>{
 const m=manifest();assert.equal(c.assessConditions(m,observation(m),binding()).status,'matching');
 const edited=observation(m,'admission',{arm:'edited',model:'minicpm_test::edited'});
 assert.equal(c.assessConditions(m,edited,binding('admission',{arm:'edited',model:'minicpm_test::edited'})).status,'matching');
 assert.equal(edited.conditions.provider.maxSteps,null);assert.equal(edited.manifestSha256,c.manifestSha256(m));
});
for(const group of ['source','instructions','tools','modes','context','provider','runtime','sampling','config'])test('M5 missing '+group+' observations remain unknown despite complete:true',()=>{
 const m=manifest(),e=observation(m);delete e.conditions[group];e.complete=true;
 const r=c.assessConditions(m,e,binding());assert.equal(r.status,'unknown');assert.equal(r.matching,false);assert.ok(r.reasons.length);
});
for(const key of ['threads','threadsBatch','batch','ubatch','gpuLayers','flashAttention'])test('M5 auto-valued effective '+key+' is unknown',()=>{
 const m=manifest(),e=observation(m);e.conditions.runtime[key]='auto';assert.equal(c.assessConditions(m,e,binding()).status,'unknown');
});
test('M5 unloaded runtime, unapplied revision and unresolved random seed do not become ready',()=>{
 const m=manifest(),e=observation(m);e.conditions.runtime.loaded=false;e.conditions.config.appliedRevision=null;e.conditions.sampling.seed=4294967295;
 const r=c.assessConditions(m,e,binding());assert.equal(r.status,'unknown');assert.ok(r.reasons.some(x=>x.field==='conditions.runtime.loaded'));assert.ok(r.reasons.some(x=>x.field==='conditions.config.appliedRevision'));assert.ok(r.reasons.some(x=>x.field==='conditions.sampling.seed'));
});
const driftCases=[
 ['source',e=>{e.conditions.source.sha256='b'.repeat(64);}],
 ['policy',e=>{e.conditions.instructions.selectedPolicySha256='b'.repeat(64);}],
 ['catalog',e=>{e.conditions.tools.names.push('relay_identity');}],
 ['mode',e=>{e.conditions.modes.pastChats='on';}],
 ['context',e=>{e.conditions.context.windowTokens=32768;}],
 ['runtime',e=>{e.conditions.runtime.threads=4;}],
 ['sampling',e=>{e.conditions.sampling.temperature=0.7;}],
 ['configuration',e=>{e.conditions.config.savedRevision=19;}],
 ['GGUF',e=>{e.conditions.model.sha256='b'.repeat(64);}]
];
for(const [name,change]of driftCases)test('M5 changed '+name+' reports drift with a field reason',()=>{
 const m=manifest(),e=observation(m);change(e);const r=c.assessConditions(m,e,binding());assert.equal(r.status,'drifted');assert.ok(r.reasons.some(x=>x.status==='drifted'&&x.field));
});
test('M5 stale and future evidence are unknown, with an inclusive explicit age boundary',()=>{
 const m=manifest(),e=observation(m);assert.equal(c.assessConditions(m,e,binding('admission',{now:plus(30000)})).status,'matching');
 assert.equal(c.assessConditions(m,e,binding('admission',{now:plus(30001)})).reasons[0].code,'stale-evidence');
 assert.equal(c.assessConditions(m,{...e,at:plus(1)},binding()).reasons[0].code,'future-evidence');
});
for(const field of ['connectionId','manifestSha256','phase','arm','model'])test('M5 wrong admission '+field+' cannot match',()=>{
 const m=manifest(),e=observation(m);e[field]=field==='manifestSha256'?'f'.repeat(64):'wrong';
 assert.notEqual(c.assessConditions(m,e,binding()).status,'matching');
});
for(const field of ['runId','requestId','payloadSha256'])test('M5 final '+field+' is independently bound',()=>{
 const m=manifest(),e=observation(m,'final');e[field]=field==='payloadSha256'?'f'.repeat(64):'other';
 assert.equal(c.assessConditions(m,e,binding('final')).status,'drifted');
});
test('M5 provider payload digests belong to each run rather than shared arm policy',()=>{
 const m=manifest(),a=observation(m,'final'),b=observation(m,'final',{arm:'edited',model:'minicpm_test::edited',runId:'edited_run',requestId:'edited_request',payloadSha256:'8'.repeat(64)});
 assert.equal(c.assessConditions(m,a,binding('final')).status,'matching');
 assert.equal(c.assessConditions(m,b,binding('final',{arm:'edited',model:b.model,runId:b.runId,requestId:b.requestId,payloadSha256:b.payloadSha256})).status,'matching');
 assert.equal(a.manifestSha256,b.manifestSha256);assert.notEqual(a.payloadSha256,b.payloadSha256);
});
test('M5 guarded start requires a fresh manifest-bound observation at planning and commit',()=>{
 const s=prepared();assert.equal(campaign.planNext(s,{now:AT,connectionId:GRANT}).type,'blocked');
 const opts={now:AT,connectionId:GRANT,evidence:observation(s.manifest)},planned=campaign.planNext(s,opts);
 assert.equal(planned.operation.kind,'start');assert.throws(()=>campaign.commitOperation(s,planned,{now:AT,connectionId:GRANT}));
 assert.throws(()=>campaign.commitOperation(s,planned,{...opts,now:plus(30001)}));
 const committed=campaign.commitOperation(s,planned,opts);assert.equal(committed.controller.pending.kind,'start');assert.equal(committed.admission.assessment.status,'matching');
});
test('M5 a forged legacy start plan cannot bypass the guarded transition',()=>{
 const s=create(),legacy={type:'submit',operation:{kind:'start',requestId:'forged',connectionId:GRANT,arguments:{},argumentsSha256:api.sha({})}};
 assert.throws(()=>campaign.commitOperation(s,legacy,{now:AT,connectionId:GRANT,evidence:observation(s.manifest)}));
});
test('M5 requested and prepared context/modes must match before any start',()=>{
 const m=manifest(),cfg=config(m);cfg.context.windowTokens=32768;assert.throws(()=>campaign.createCampaign({manifest:m,config:cfg,arm:'original',scaffoldReceiptText:scaffoldText(cfg)},AT));
 const s=create(),body=preparedBody(s.controller.config);body.input.pastChats='on';
 const bad=operate(s,{kind:'prepare',body});assert.equal(bad.controller.phase,'blocked');assert.equal(campaign.planNext(bad,{now:AT,connectionId:GRANT}).type,'blocked');
});
test('M5 profile drift never prevents recovery of the exact pending operation',()=>{
 const s=prepared(),opts={now:AT,connectionId:GRANT,evidence:observation(s.manifest)};
 const p=campaign.planNext(s,opts),pending=campaign.commitOperation(s,p,opts),changed=observation(s.manifest);changed.conditions.runtime.threads=1;
 const recovery=campaign.planNext(pending,{now:plus(40000),connectionId:GRANT,evidence:changed});
 assert.equal(recovery.type,'recover-same-operation');assert.deepEqual(recovery.operation.arguments,pending.controller.pending.arguments);assert.equal(recovery.operation.requestId,pending.controller.pending.requestId);
});
test('M5 owned-run observation/cancellation and settled collection remain available under drift',()=>{
 const s=running(),changed=observation(s.manifest);changed.conditions.runtime.threads=1;
 const p=campaign.planNext(s,{now:plus(300000),connectionId:GRANT,evidence:changed});
 assert.equal(p.operation.kind,'observe');assert.match(p.operation.arguments.expression,/cancel/);
 const settled=operate(s,{kind:'observe',run:ownedRun(s.controller.config,'failed'),observations:[],cancellations:[]},{now:AT,connectionId:GRANT});
 assert.equal(campaign.planNext(settled,{now:AT,connectionId:GRANT,evidence:changed}).operation.kind,'collect');
});
test('M5 already committed admission can settle after its observation expires',()=>{
 const s=prepared(),opts={now:AT,connectionId:GRANT,evidence:observation(s.manifest)};
 let p=campaign.commitOperation(s,campaign.planNext(s,opts),opts);const id='direct_'+'d'.repeat(64);
 p=campaign.recordSubmission(p,{jobId:id,requestId:p.controller.pending.requestId,connectionId:GRANT});
 p=campaign.acceptResponse(p,{jobId:id,connectionId:GRANT,jobStatus:'succeeded',jobSettled:true,value:{kind:'start',run:ownedRun(p.controller.config)},evidence:{path:'C:/evidence/start.json',sha256:'a'.repeat(64)}},plus(40000));
 assert.equal(p.controller.phase,'running');
});
test('M5 raw transcript bytes are required; a complete flag or wrong content hash cannot supply a projection',()=>{
 const s=collected();assert.throws(()=>campaign.attachTranscript(s,{providerEvidence:{path:'x',sha256:'a'.repeat(64)},projection:{validation:{valid:true},complete:true}}));
 const t=transcript(s);t.providerText+=' ';assert.throws(()=>campaign.attachTranscript(s,t),/bytes/);
 const accepted=campaign.attachTranscript(s,transcript(s));assert.equal(accepted.phase,'awaiting-final-conditions');assert.equal(accepted.controller.projection.validation.valid,true);
});
for(const field of ['runId','requestId','model','manifestSha256','connectionId'])test('M5 payload binding rejects another '+field,()=>{
 const s=running(),p=payload(s,{[field]:field==='manifestSha256'?'f'.repeat(64):'wrong'});assert.throws(()=>campaign.bindPayload(s,p,{now:AT,connectionId:GRANT}));
});
test('M5 absence of run payload binding or final observations cannot complete a campaign',()=>{
 let s=projected(false);s=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest,'final')});assert.equal(s.phase,'awaiting-final-conditions');assert.equal(s.finalRecord.assessment.status,'unknown');
 s=campaign.finalize(projected(),{now:AT,connectionId:GRANT});assert.equal(s.phase,'awaiting-final-conditions');assert.equal(s.finalRecord.assessment.status,'unknown');
});
test('M5 final matching conditions complete settled evidence without changing a failed model result into success',()=>{
 const s=projected(),done=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest,'final')});
 assert.equal(done.phase,'complete');assert.equal(campaign.planNext(done,{now:AT,connectionId:GRANT}).type,'complete');
 assert.equal(done.controller.projection.receipt.run.status,'failed');assert.equal(done.controller.projection.receipt.completion.agentCompleted,false);
 assert.throws(()=>campaign.finalize(done,{now:AT,connectionId:GRANT,evidence:observation(done.manifest,'final')}),/immutable/);
});
test('M5 recorded final drift cannot be erased by later restoring matching settings',()=>{
 let s=projected(),e=observation(s.manifest,'final');e.conditions.runtime.threads=1;
 s=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:e});assert.equal(s.phase,'disqualified');
 s=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest,'final')});assert.equal(s.phase,'disqualified');assert.equal(s.finalRecord.assessment.status,'drifted');
 assert.equal(campaign.planNext(s,{now:AT,connectionId:GRANT}).type,'blocked');
});
test('M5 caller-supplied completion flags and changed projections do not validate a campaign',()=>{
 const s=projected();s.phase='complete';assert.throws(()=>campaign.planNext(s,{now:AT,connectionId:GRANT}),/completion lacks/);
 const changed=projected();changed.controller.projection.receipt.run.id='foreign';assert.throws(()=>campaign.finalize(changed,{now:AT,connectionId:GRANT,evidence:observation(changed.manifest,'final')}),/projection changed/);
});
test('M5 synthetic idle state remains unknown without inventing loaded runtime observations',()=>{
 const raw=fs.readFileSync(path.join(__dirname,'../native-baseline.json'));assert.equal(api.sha(raw),'6f02b3ca246a1a39f23b6da71edc8756203f5f02c9e8db4ec476121cabc03f25');
 const live=JSON.parse(raw);assert.equal(live.fixture.synthetic,true);assert.equal(live.fixture.kind,'synthetic-idle-runtime');assert.equal(live.localConfig.process.owned,false);assert.equal(live.router.code,'ECONNREFUSED');assert.equal(live.loadedRuntimeObservation.available,false);
 const m=manifest();m.shared.source.appVersion=live.appVersion;m.shared.source.sha256=live.identities.sourceDigest;m.shared.instructions.coreSha256=live.core.sha256;m.shared.runtime.binarySha256=live.identities.runtimeDigest;
 m.arms.original={path:live.identities.modelFiles[0].path,sha256:live.identities.modelFiles[0].sha256};m.arms.edited={path:live.identities.modelFiles[1].path,sha256:live.identities.modelFiles[1].sha256};
 const e={schema:c.EVIDENCE_SCHEMA,at:live.capturedAt,connectionId:live.connectionId,manifestSha256:c.manifestSha256(m),phase:'admission',arm:'original',model:MODEL,complete:true,conditions:{
 source:{appVersion:live.appVersion,sha256:live.identities.sourceDigest,stable:live.identities.sourceFiles.every(x=>x.stable===true)},
 instructions:{coreSha256:live.core.sha256},provider:{maxTokens:live.provider.maxTokens,maxSteps:live.provider.maxSteps},
 model:m.arms.original,runtime:{loaded:false,binarySha256:live.identities.runtimeDigest},
 config:{savedRevision:live.localConfig.revision,appliedRevision:live.localConfig.process.appliedRevision,pendingRestart:live.localConfig.process.pendingRestart}
 }};
 const r=c.assessConditions(m,e,binding('admission',{now:live.router.at,connectionId:live.connectionId}));
 assert.equal(r.status,'unknown');assert.equal(r.matching,false);assert.ok(r.reasons.some(x=>x.field==='conditions.runtime.loaded'));assert.ok(r.reasons.some(x=>x.field==='conditions.runtime.threads'));assert.ok(r.reasons.some(x=>x.field==='conditions.config.appliedRevision'));
 assert.equal(api.sha(fs.readFileSync(path.join(__dirname,'../native-baseline.json'))),api.sha(raw));
});


test('M5 native prepare actually carries the benchmark request and frozen context',async()=>{
 const cfg=config(),op=api.prepare(cfg,0),moduleUrl=require('node:url').pathToFileURL(path.join(__dirname,'../../../public/mission-model.mjs')).href;
 const missionModule=await import(moduleUrl);
 const expression=op.arguments.expression.replace("await import('/mission-model.mjs')",'missionModule');
 assert.notEqual(expression,op.arguments.expression);
 const value=await new Function('location','missionModule','return '+expression)({origin:cfg.origin},missionModule);
 assert.deepEqual(value.body.input.benchmark,cfg.benchmark);assert.deepEqual(value.body.workflow.settings.context,cfg.context);
 assert.equal(value.body.input.directoryActions,'on');assert.equal(value.body.input.pastChats,'off');
});
test('M5 fresh campaigns cannot omit the profile or forge controller receipt bytes',()=>{
 const m=manifest(),cfg=config(m),raw=scaffoldText(cfg);delete cfg.benchmark;
 assert.throws(()=>campaign.createCampaign({config:cfg,manifest:m,arm:'original',scaffoldReceiptText:raw},AT),/benchmark profile/);
 const valid=config(m);assert.throws(()=>campaign.createCampaign({config:valid,manifest:m,arm:'original',scaffoldReceiptText:raw+' '},AT),/receipt bytes/);
});
for(const mutation of ['digest','mode','context','profile'])test('M5 prepared '+mutation+' mutation is refused before start planning and commit',()=>{
 const s=prepared();
 if(mutation==='digest')s.controller.authoredBody.input.task='Changed task';
 if(mutation==='mode')s.controller.authoredBody.input.pastChats='on';
 if(mutation==='context')s.controller.authoredBody.workflow.nodes[0].context={...s.controller.config.context,windowTokens:32768};
 if(mutation==='profile')delete s.controller.authoredBody.input.benchmark;
 if(mutation!=='digest')s.controller.authoredBodySha256=api.sha(s.controller.authoredBody);
 const next=campaign.planNext(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest)});
 assert.equal(next.type,'blocked');assert.equal(next.reason,'prepared-request-integrity-or-condition-mismatch');
});
test('M5 unknown current grant cannot inherit the saved grant for start, recovery or cleanup',()=>{
 const s=prepared(),opts={now:AT,connectionId:GRANT,evidence:observation(s.manifest)},pending=campaign.commitOperation(s,campaign.planNext(s,opts),opts);
 for(const state of [s,pending,running()])assert.equal(campaign.planNext(state,{now:AT,evidence:observation(state.manifest)}).type,'blocked');
});
const admittedDriftCases=[
 ['missing profile',r=>{delete r.benchmark;}],
 ['forged profile receipt',r=>{r.benchmark.scaffoldReceiptSha256='f'.repeat(64);}],
 ['Directory Actions mode',r=>{r.directoryActions='off';}],
 ['legacy Directory mode',r=>{r.executionModes.directoryMode='on';}],
 ['Chat Planning mode',r=>{r.chatPlanning='on';}],
 ['Past Chats mode',r=>{r.pastChats='on';}],
 ['node context override',r=>{r.workflow.nodes[0].context={...r.workflow.settings.context,windowTokens:32768};}],
 ['scaffold contract',r=>{r.benchmark.immutableFiles['TASK.md']='f'.repeat(64);r.benchmark.contractSha256=c.digest(Object.fromEntries(Object.entries(r.benchmark).filter(([key])=>key!=='contractSha256')));}]
];
for(const [name,change]of admittedDriftCases)test('M5 admitted '+name+' drift preserves identity and immediate owned cancellation',async()=>{
 const s=prepared(),run=ownedRun(s.controller.config);change(run);const active=operate(s,{kind:'start',run});
 assert.equal(active.controller.run.id,'owned_run');assert.equal(active.controller.phase,'running');assert.equal(active.drifted,true);assert.ok(active.runConditionFailures.length);
 const plan=campaign.planNext(active,{now:AT,connectionId:GRANT});assert.equal(plan.operation.kind,'observe');
 const output=await simulateCleanup(plan.operation,run);assert.equal(output.result.run.settled,true);
 assert.deepEqual(output.requests,[{route:'/api/runs/owned_run',method:'GET'},{route:'/api/runs/owned_run/cancel',method:'POST'}]);
 if(['missing profile','forged profile receipt','Directory Actions mode','legacy Directory mode'].includes(name))assert.throws(()=>api.assertOwned(run,active.controller.config));
});
test('M5 condition drift never permits cancellation of a foreign request',async()=>{
 const s=running(),plan=campaign.planNext(s,{now:plus(300000),connectionId:GRANT}),foreign=ownedRun(s.controller.config);foreign.metadata.clientRequestId='foreign';
 const output=await simulateCleanup(plan.operation,foreign);assert.match(output.result.error.message,/IDENTITY_MISMATCH/);assert.equal(output.requests.length,1);
});
test('M5 restored profile observations cannot erase earlier admitted mode drift',()=>{
 let s=prepared(),run=ownedRun(s.controller.config);run.directoryActions='off';s=operate(s,{kind:'start',run});s=collected(s);
 s=campaign.bindPayload(s,payload(s),{now:AT,connectionId:GRANT});s=campaign.attachTranscript(s,transcript(s));
 s=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest,'final')});assert.equal(s.phase,'disqualified');assert.equal(s.finalRecord.assessment.status,'drifted');
});
test('M5 final evidence from before settled collection or payload capture remains unknown',()=>{
 let s=projected(true,plus(1000)),done=campaign.finalize(s,{now:plus(1000),connectionId:GRANT,evidence:observation(s.manifest,'final')});
 assert.equal(done.phase,'awaiting-final-conditions');assert.ok(done.finalRecord.assessment.reasons.some(x=>x.code==='before-settled-observation'));
 s=projected(false);s=campaign.bindPayload(s,payload(s,{at:plus(1000)}),{now:plus(1000),connectionId:GRANT});
 done=campaign.finalize(s,{now:plus(1000),connectionId:GRANT,evidence:observation(s.manifest,'final')});assert.equal(done.phase,'awaiting-final-conditions');
 const ready=campaign.finalize(done,{now:plus(1000),connectionId:GRANT,evidence:observation(s.manifest,'final',{at:plus(1000)})});assert.equal(ready.phase,'complete');
});

function continuation(state,extra={}){
 return observation(state.manifest,'continuation',{runId:state.controller.run.id,requestId:state.binding.requestId,...extra});
}
test('M5 accepted continuation drift is permanent and still permits owned cleanup',()=>{
 let s=running(),changed=continuation(s);changed.conditions.runtime.threads=1;
 s=campaign.recordConditions(s,{now:AT,connectionId:GRANT,evidence:changed});
 assert.equal(s.drifted,true);assert.equal(s.conditionHistory.at(-1).accepted,true);
 const planned=campaign.planNext(s,{now:AT,connectionId:GRANT});assert.equal(planned.operation.kind,'observe');
 s=campaign.recordConditions(s,{now:AT,connectionId:GRANT,evidence:continuation(s)});
 assert.equal(s.conditionHistory.at(-1).assessment.status,'matching');assert.equal(s.drifted,true);
 s=collected(s);s=campaign.bindPayload(s,payload(s),{now:AT,connectionId:GRANT});s=campaign.attachTranscript(s,transcript(s));
 s=campaign.finalize(s,{now:AT,connectionId:GRANT,evidence:observation(s.manifest,'final')});
 assert.equal(s.phase,'disqualified');assert.equal(s.finalRecord.assessment.status,'drifted');
});
test('M5 cleanup commit automatically records supplied continuation drift before execution',async()=>{
 let s=running(),e=continuation(s);e.conditions.context.windowTokens=131072;
 const opts={now:AT,connectionId:GRANT,evidence:e},p=campaign.planNext(s,opts);
 const response=await simulateCleanup(p.operation,s.controller.run);assert.ok(response.requests.some(x=>x.method==='POST'&&x.route.endsWith('/cancel')));
 s=campaign.commitOperation(s,p,opts);assert.equal(s.drifted,true);assert.equal(s.conditionHistory.at(-1).accepted,true);assert.equal(s.controller.pending.kind,'observe');
});
for(const [label,change]of [
 ['run',e=>{e.runId='foreign';}],['request',e=>{e.requestId='foreign';}],
 ['manifest',e=>{e.manifestSha256='f'.repeat(64);}],['connection',e=>{e.connectionId='foreign';}],
 ['stale',e=>{e.at=plus(-31000);}],['future',e=>{e.at=plus(1);}],
 ['before admission',e=>{e.at=plus(-1);}]
])test('M5 '+label+' continuation evidence cannot prove drift or block cleanup',()=>{
 let s=running(),e=continuation(s);e.conditions.runtime.threads=1;change(e);
 s=campaign.recordConditions(s,{now:AT,connectionId:GRANT,evidence:e});
 const record=s.conditionHistory.at(-1);assert.equal(record.accepted,false);assert.equal(record.assessment.status,'unknown');assert.equal(s.drifted,false);
 assert.equal(campaign.planNext(s,{now:AT,connectionId:GRANT}).operation.kind,'observe');
 assert.equal(campaign.recordConditions(s,{now:AT,connectionId:GRANT,evidence:continuation(s)}).conditionHistory.at(-1).assessment.status,'matching');
});
test('M5 missing or malformed continuation observations are recorded explicitly without obstructing cleanup',()=>{
 for(const value of [undefined,null,{},[]]){
  const s=running(),opts={now:AT,connectionId:GRANT,evidence:value},p=campaign.planNext(s,opts),next=campaign.commitOperation(s,p,opts);
  assert.equal(next.controller.pending.kind,'observe');assert.equal(next.drifted,false);
  assert.equal(next.conditionHistory.at(-1).accepted,false);assert.equal(next.conditionHistory.at(-1).assessment.status,'unknown');
 }
 const s=running(),next=campaign.recordConditions(s,{now:AT,evidence:continuation(s)});
 assert.equal(next.conditionHistory.at(-1).assessment.reasons[0].code,'connection-changed-or-unverified');
});

test('M5 copied legacy CLI refuses fresh initialization and leaves no journal',()=>{
 const cli=require('./controller-cli.cjs').main,dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'m5-cli-init-'));
 try{const journal=path.join(dir,'journal.json');assert.throws(()=>cli(['init','--config',path.join(dir,'not-read.json'),'--journal',journal]),/Fresh benchmark campaigns require campaign-controller/);assert.equal(fs.existsSync(journal),false);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('M5 copied legacy CLI refuses a new start without changing the existing journal',()=>{
 const cli=require('./controller-cli.cjs').main,dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'m5-cli-start-'));
 try{const journal=path.join(dir,'journal.json');fs.writeFileSync(journal,JSON.stringify(prepared().controller));const before=fs.readFileSync(journal);
  assert.throws(()=>cli(['next','--journal',journal,'--connection',GRANT]),/New benchmark starts require campaign-controller/);
  assert.deepEqual(fs.readFileSync(journal),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('M5 copied legacy CLI preserves exact owned cleanup and pending recovery',()=>{
 const cli=require('./controller-cli.cjs').main,dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'m5-cli-cleanup-'));
 try{const journal=path.join(dir,'journal.json'),owned=running().controller;owned.deadlineAt=new Date(Date.now()-1000).toISOString();owned.cleanupDeadlineAt=new Date(Date.now()+60000).toISOString();fs.writeFileSync(journal,JSON.stringify(owned));
  const next=cli(['next','--journal',journal,'--connection',GRANT]);assert.equal(next.type,'submit');assert.equal(next.operation.kind,'observe');assert.match(next.operation.arguments.expression,/cancel/);
  const saved=fs.readFileSync(journal),pending=JSON.parse(saved).pending;assert.equal(pending.requestId,next.operation.requestId);assert.deepEqual(pending.arguments,next.operation.arguments);
  const recovery=cli(['next','--journal',journal,'--connection',GRANT]);assert.notEqual(recovery.type,'submit');assert.deepEqual(fs.readFileSync(journal),saved);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
