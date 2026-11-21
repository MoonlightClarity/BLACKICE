'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const driver=require('./campaign-driver.cjs'),journal=require('./campaign-journal.cjs'),campaign=require('./campaign-controller.cjs'),api=require('./native-api.cjs'),conditions=require('./run-conditions.cjs');

const AT='2026-11-21T08:00:00.000Z',GRANT='native-driver-test',MODEL='fixture::original';
const plus=n=>new Date(Date.parse(AT)+n).toISOString();
function inputs(){
 const manifest={schema:'blackice.minicpm.run-manifest.v1',maxEvidenceAgeMs:30000,shared:{
 source:{appVersion:'2.40.72',sha256:'1'.repeat(64),stable:true},
 instructions:{coreSha256:'2'.repeat(64),selectedPolicySha256:'3'.repeat(64),auditStage:'adapter-prepared',auditStatus:'accepted'},
 tools:{names:['relay_workspace','relay_directory_action'],schemaSha256:'4'.repeat(64)},
 modes:{directoryActions:'on',directoryMode:'off',chatPlanning:'off',pastChats:'off'},
 context:{windowTokens:262144,autoCompact:false,outputReserveTokens:4096,headroomTokens:512},
 provider:{maxTokens:8192,maxSteps:null},
 runtime:{loaded:true,binarySha256:'5'.repeat(64),build:'b12359',ctxSize:262144,cacheK:'q8_0',cacheV:'q8_0',parallel:1,threads:6,threadsBatch:6,batch:2048,ubatch:512,gpuLayers:25,flashAttention:true},
 sampling:{seed:7,temperature:0.8,topK:40,topP:0.95,minP:0.05},
 config:{savedRevision:18,appliedRevision:18,pendingRestart:false}
 },arms:{original:{path:'C:/models/original.gguf',sha256:'6'.repeat(64)},edited:{path:'C:/models/edited.gguf',sha256:'7'.repeat(64)}}};
 const method='Read, save, and verify.\n',config={controllerId:'driver_test',requestId:'request_driver',workflowId:'workflow_driver',caseId:'D0',connectionId:GRANT,origin:'http://127.0.0.1:53151',workspace:'C:/fixture/D0/original',task:'Implement the saved task.\n'+method,method:{text:method,sha256:api.sha(method)},model:MODEL,context:{preset:'custom',...manifest.shared.context},budgets:{wallMs:300000,settlementGraceMs:60000,pollIntervalMs:1000,windowMs:4000,fetchTimeoutMs:1000,maxReceiptPages:8},allowedCommands:['node test-public.cjs']};
 const names=['METHOD.md','TASK.md','task.json','public-cases.json','test-public.cjs','test-support/grade-modules.cjs','test-support/module-worker.cjs'];
 const immutableFiles=Object.fromEntries(names.map((name,i)=>[name,String(i+1).repeat(64)]));immutableFiles['METHOD.md']=config.method.sha256;
 const scaffoldReceiptText=JSON.stringify({schema:'blackice.minicpm.directory-smoke-scaffold.v1',caseId:'D0',scored:false,workspace:config.workspace,publicCaseCount:2,immutableFiles,initialSource:{'src/index.cjs':'8'.repeat(64)},method:{path:'METHOD.md',sha256:config.method.sha256}})+'\n';
 config.benchmark={profile:'minicpm-code-v1',scaffoldReceiptPath:'C:/fixture-receipts/D0.json',scaffoldReceiptSha256:api.sha(scaffoldReceiptText)};
 return {manifest,config,arm:'original',scaffoldReceiptText};
}
function create(){return campaign.createCampaign(inputs(),AT);}

function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-driver-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let sequence=0;
 const save=(name,value,raw=false)=>{const f=path.join(dir,name);fs.writeFileSync(f,raw?value:JSON.stringify(value));return f;};
 const input=inputs(),file=path.join(dir,'campaign.json'),go=(command,options={})=>driver.execute(command,{journal:file,connection:GRANT,now:AT,...options});
 const created=go('init',{config:save('config.json',input.config),manifest:save('manifest.json',input.manifest),scaffold:save('scaffold.json',input.scaffoldReceiptText,true),arm:'original'});
 const read=()=>journal.load(file);
 const obs=(phase='admission',extra={})=>({schema:conditions.EVIDENCE_SCHEMA,at:AT,connectionId:GRANT,manifestSha256:conditions.manifestSha256(input.manifest),phase,arm:'original',model:MODEL,conditions:{...structuredClone(input.manifest.shared),model:input.manifest.arms.original},...(phase==='admission'?{}:{runId:'owned_driver_run',requestId:input.config.requestId}),...extra});
 function admission(operation){
  const jobId='direct_'+String(++sequence).padStart(64,'0'),job={jobId,requestId:operation.requestId,tool:'blackice_frontend',action:'evaluate',status:'queued',settled:false,revision:1};
  go('record-submission',{admission:save('admission-'+sequence+'.json',{structuredContent:job})});return job;
 }
 function response(job,value,{pieces=1,artifact=null,status='succeeded',settled=true}={}){
  const text=JSON.stringify(artifact||{target:'frontend',method:'Runtime.evaluate',result:{result:{type:'object',value}}}),size=Math.ceil(text.length/pieces),files=[];
  for(let offset=0;offset<text.length;offset+=size){
   const chunk=text.slice(offset,offset+size),next=offset+chunk.length;
   files.push(save('result-'+(++sequence)+'.json',{structuredContent:{...job,status,settled,revision:3,updatedAt:AT,result:{success:true,text:{text:chunk,offset,limit:size,totalCharacters:text.length,nextOffset:next===text.length?null:next}}}}));
  }return files;
 }
 function complete(value,options={}){
  const plan=go('next',{conditions:save('conditions-'+(++sequence)+'.json',obs()),...options}),job=admission(plan.operation),files=response(job,value);
  return go('accept',{resultPages:files,...options});
 }
 return {dir,file,input,created,save,go,read,obs,admission,response,complete};
}
function body(cfg){return {requestId:cfg.requestId,workflow:{id:cfg.workflowId,nodes:[{id:'agent',type:'agent',model:cfg.model}],settings:{cwd:cfg.workspace,planningMode:'off',context:cfg.context}},input:{task:cfg.task,cwd:cfg.workspace,directoryActions:'on',directoryMode:'off',directoryDiagnostics:'maximal',chatPlanning:'off',pastChats:'off',planningMode:'off',benchmark:cfg.benchmark}};}
function profile(h){
 const cfg=h.input.config,r=JSON.parse(h.input.scaffoldReceiptText),p={schema:'blackice.minicpm.benchmark-profile.v1',profile:'minicpm-code-v1',workspace:cfg.workspace,caseId:'D0',publicCaseCount:2,command:'node test-public.cjs',scaffoldReceiptPath:cfg.benchmark.scaffoldReceiptPath,scaffoldReceiptSha256:cfg.benchmark.scaffoldReceiptSha256,immutableFiles:r.immutableFiles,limits:{maxModules:32,maxSourceBytes:200000,maxDepth:8,commandTimeoutMs:10000},isolation:'Enforced benchmark tool/API boundary with a restricted pure-function worker; not an operating-system sandbox.',functionName:'directorySmoke'};p.contractSha256=conditions.digest(p);return p;
}
function run(h,status='running'){
 const cfg=h.input.config;return {id:'owned_driver_run',taskId:'owned_driver_run',createdAt:AT,status,settled:status==='failed',cwd:cfg.workspace,input:cfg.task.trim(),metadata:{clientRequestId:cfg.requestId},workflow:body(cfg).workflow,executionModes:{directoryMode:'off',chatPlanning:'off',pastChats:'off'},directoryActions:'on',directoryDiagnostics:'maximal',chatPlanning:'off',pastChats:'off',benchmark:profile(h),nodes:{agent:{threadId:'provider_driver',toolNames:['relay_workspace','relay_directory_action'],directoryContext:{runId:'owned_driver_run',taskId:'owned_driver_run',nodeId:'agent',hostTools:{received:0,returned:0,threw:0}}}},events:[],eventRetention:{omittedEvents:0}};
}
function prepared(h){h.complete({kind:'prepare',body:body(h.input.config)});}
function running(h){prepared(h);h.complete({kind:'start',run:run(h)});}
function collected(h){
 running(h);const r=run(h,'failed');
 h.complete({kind:'observe',run:r,startedAt:AT,finishedAt:plus(1),observations:[{at:plus(1),status:'failed',settled:true}],cancellations:[]});
 const receiptPages=Object.fromEntries(['context','tools','decisions'].map(view=>[view,{complete:true,pages:[{view,runId:r.id,taskId:r.id,revision:'revision-'+view,offset:0,nextOffset:null,actions:[]}]}]));
 h.complete({kind:'collect',run:r,providerThreadId:'provider_driver',ledger:{runId:r.id,taskId:r.id,state:{taskId:r.id,actions:[],receipts:[],revision:0},final:{ready:false,reason:'no-actions',unknown:[]}},machine:{audience:'machine',runId:r.id,taskId:r.id,coverage:{source:'maximal-host-envelopes',dropped:0,entryMetadataOmitted:0,gaps:[]},entries:[]},receiptPages},{now:plus(2)});
}
function bind(h){
 const bytes='{"actual":"initial adapter payload"}\n',s=h.read().state,b={runId:s.controller.run.id,requestId:s.binding.requestId,model:s.binding.model,manifestSha256:s.manifestSha256,connectionId:GRANT,arm:'original',at:plus(3),payloadSha256:api.sha(bytes)};
 h.go('bind-payload',{now:plus(3),payloadBinding:h.save('binding.json',b),payload:h.save('payload.json',bytes,true)});return b;
}
function attach(h){
 const messages=[{role:'user',content:h.input.config.task}],thread={version:1,id:'provider_driver',providerId:'fixture',providerType:'compatible',model:'original',cwd:h.input.config.workspace,hostOnlyTools:true,messages,transcript:messages};
 return h.go('attach-transcript',{now:plus(4),providerThread:h.save('thread.json',JSON.stringify(thread)+'\n',true)});
}
test('R2 init stores complete campaign plus exact source evidence',t=>{
 const h=setup(t),s=h.read().state;assert.equal(h.created.type,'campaign-created');assert.equal(s.schema,campaign.SCHEMA);
 assert.equal(s.driverEvidence.records[0].receipts.length,3);for(const r of s.driverEvidence.records[0].receipts)assert.equal(api.sha(fs.readFileSync(r.path)),r.sha256);
});
test('R2 next returns only the operation already committed to the complete journal',t=>{
 const h=setup(t),out=h.go('next'),s=h.read().state;
 assert.equal(out.type,'submit');assert.equal(out.operation.tool,'blackice_frontend');assert.deepEqual(out.operation.arguments,s.controller.pending.arguments);
 assert.equal(out.journal.sha256,h.read().receipt.sha256);assert.equal(s.manifestSha256,h.created.manifestSha256);
});
test('R2 lost submission response retains identical request and arguments across restart',t=>{
 const h=setup(t),a=h.go('next'),b=h.go('next');assert.equal(b.type,'recover-same-operation');
 assert.equal(a.operation.requestId,b.operation.requestId);assert.deepEqual(a.operation.arguments,b.operation.arguments);assert.equal(a.journal.sha256,b.journal.sha256);
 const before=h.read().receipt.sha256;assert.throws(()=>h.go('next',{connection:'changed-grant'}),{code:'DRIVER_CONNECTION'});assert.equal(h.read().receipt.sha256,before);
});
test('R2 admission is exact and pending admitted jobs recover through get_job',t=>{
 const h=setup(t),p=h.go('next'),bad={jobId:'direct_'+'a'.repeat(64),requestId:'wrong',tool:'blackice_frontend',action:'evaluate'};
 assert.throws(()=>h.go('record-submission',{admission:h.save('wrong.json',bad)}),{code:'DRIVER_JOB_IDENTITY'});
 const job=h.admission(p.operation),out=h.go('next');assert.equal(out.type,'recover-pending-job');assert.equal(out.tool,'blackice_get_job');assert.equal(out.arguments.jobId,job.jobId);
});
test('R2 complete ordered pages preserve exact bytes and reconcile prepare',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),files=h.response(job,{kind:'prepare',body:body(h.input.config)},{pieces:3});
 const out=h.go('accept',{resultPages:files});assert.equal(out.controllerPhase,'prepared');assert.equal(h.read().state.controller.pending,null);
 const proof=JSON.parse(fs.readFileSync(h.read().state.controller.history[0].evidence.path,'utf8'));assert.equal(proof.pages.length,3);
 for(const r of proof.pages)assert.equal(api.sha(fs.readFileSync(r.path)),r.sha256);
});
test('R2 missing, overlapping and changed-revision pages cannot advance the pending action',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),files=h.response(job,{kind:'prepare',body:body(h.input.config)},{pieces:3}),before=h.read().receipt.sha256;
 assert.throws(()=>h.go('accept',{resultPages:files.slice(0,1)}),{code:'DRIVER_PAGE_INCOMPLETE'});
 assert.throws(()=>h.go('accept',{resultPages:[files[0],files[0],...files.slice(1)]}),{code:'DRIVER_PAGE_COVERAGE'});
 const changed=JSON.parse(fs.readFileSync(files[1],'utf8'));changed.structuredContent.revision=4;
 assert.throws(()=>h.go('accept',{resultPages:[files[0],h.save('changed-page.json',changed),...files.slice(2)]}),{code:'DRIVER_PAGE_IDENTITY'});
 assert.equal(h.read().receipt.sha256,before);
});
test('R2 foreign result request or job is rejected even when content appears correct',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),files=h.response({...job,requestId:'foreign'},{kind:'prepare',body:body(h.input.config)});
 assert.throws(()=>h.go('accept',{result:files[0]}),{code:'DRIVER_JOB_IDENTITY'});assert.equal(h.read().state.controller.pending.jobId,job.jobId);
});
test('R2 unsettled job preserves pending identity and returns an explicit nonpassing status',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),files=h.response(job,null,{status:'running',settled:false});
 const out=h.go('accept',{result:files[0]});assert.equal(out.ok,false);assert.equal(out.type,'job-not-settled');assert.equal(h.read().state.controller.pending.jobId,job.jobId);
});
test('R2 settled failed job is retained and cannot silently become a prepared campaign',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),files=h.response(job,null,{status:'failed'});
 const out=h.go('accept',{result:files[0]});assert.equal(out.ok,false);assert.equal(out.controllerPhase,'blocked');assert.equal(h.read().state.controller.history[0].jobStatus,'failed');
});
test('R2 oversized frontend artifacts require recorded receipt and exact saved bytes',t=>{
 const h=setup(t),p=h.go('next'),job=h.admission(p.operation),full=JSON.stringify({success:true,contentItems:[{type:'inputText',text:JSON.stringify({result:{result:{value:{kind:'prepare',body:body(h.input.config)}}}})}]});
 const artifact={inline:false,artifact:{complete:true,path:'C:/saved/large.json',sha256:api.sha(full),bytes:Buffer.byteLength(full)}},files=h.response(job,null,{artifact});
 assert.throws(()=>h.go('accept',{result:files[0],artifact:h.save('artifact.json',full,true)}),{code:'DRIVER_ARTIFACT_UNRECORDED'});
 let out=h.go('accept',{result:files[0]});assert.equal(out.type,'retrieve-complete-saved-artifact');assert.deepEqual(h.read().state.controller.pending.artifactRequired,artifact.artifact);
 assert.throws(()=>h.go('accept',{result:files[0],artifact:h.save('bad-artifact.json',full+' ',true)}),{code:'DRIVER_ARTIFACT_IDENTITY'});
 out=h.go('accept',{result:files[0],artifact:h.save('good-artifact.json',full,true)});assert.equal(out.controllerPhase,'prepared');
});
test('R2 missing, stale and drifted admission observations cannot return a start operation',t=>{
 const h=setup(t);prepared(h);assert.equal(h.go('next').type,'blocked');
 for(const obs of [h.obs('admission',{at:plus(-30001)}),h.obs('admission',{conditions:{...h.obs().conditions,sampling:{...h.input.manifest.shared.sampling,seed:8}}})]){
  const out=h.go('next',{conditions:h.save('blocked-conditions.json',obs)});assert.equal(out.type,'blocked');assert.equal(out.operation,undefined);assert.equal(h.read().state.controller.pending,null);
 }
});
test('R2 matching admission is durably bound before returning start arguments',t=>{
 const h=setup(t);prepared(h);const out=h.go('next',{conditions:h.save('admission-conditions.json',h.obs())}),s=h.read().state;
 assert.equal(out.operation.kind,'start');assert.equal(s.admission.assessment.status,'matching');assert.equal(s.controller.pending.argumentsSha256,api.sha(out.operation.arguments));assert.equal(s.admission.evidence.connectionId,GRANT);
});
test('R2 payload binding requires matching exact saved initial payload bytes',t=>{
 const h=setup(t);running(h);const s=h.read().state,b={runId:s.controller.run.id,requestId:s.binding.requestId,model:MODEL,manifestSha256:s.manifestSha256,connectionId:GRANT,arm:'original',at:AT,payloadSha256:'f'.repeat(64)};
 assert.throws(()=>h.go('bind-payload',{payloadBinding:h.save('bad-binding.json',b),payload:h.save('actual-payload.json','{}',true)}),{code:'DRIVER_PAYLOAD_IDENTITY'});assert.equal(h.read().state.payloadBinding,null);
 bind(h);assert.ok(h.read().state.payloadBinding);
});
test('R2 settled failed model evidence remains failed while final matching campaign completes',t=>{
 const h=setup(t);collected(h);const b=bind(h),out=attach(h);assert.equal(out.validation.valid,true);assert.equal(out.phase,'awaiting-final-conditions');
 let final=h.obs('final',{at:plus(1),payloadSha256:b.payloadSha256});let result=h.go('finalize',{now:plus(5),conditions:h.save('too-early.json',final)});assert.equal(result.phase,'awaiting-final-conditions');assert.equal(result.type,'final-conditions-unverified');assert.equal(result.ok,false);assert.equal(result.campaignComplete,false);
 final={...final,at:plus(5)};result=h.go('finalize',{now:plus(5),conditions:h.save('final.json',final)});assert.equal(result.phase,'complete');
 const s=h.read().state;assert.equal(s.controller.projection.receipt.run.status,'failed');assert.equal(s.controller.projection.receipt.completion.agentCompleted,false);
 const before=h.read().receipt.sha256;assert.equal(h.go('next').type,'complete');assert.equal(h.read().receipt.sha256,before);
 assert.throws(()=>h.go('record-conditions',{conditions:h.save('later.json',final)}),{code:'DRIVER_COMPLETE'});
});
test('R2 accepted drift stays recorded while exact owned cleanup can still be committed',t=>{
 const h=setup(t);running(h);const obs=h.obs('continuation',{at:plus(1)});obs.conditions.sampling.seed=9;
 const recorded=h.go('record-conditions',{now:plus(1),conditions:h.save('drift.json',obs)});assert.equal(recorded.drifted,true);
 const out=h.go('next',{now:plus(2)});assert.equal(out.operation.kind,'observe');assert.equal(h.read().state.drifted,true);assert.ok(h.read().state.runConditionFailures.length);
 assert.ok(out.operation.arguments.expression.includes('owned_driver_run'));assert.ok(out.operation.arguments.expression.includes(plus(2)));
});
test('R2 CLI reports saved state and fails duplicate options without effects',t=>{
 const h=setup(t),cli=require.resolve('./campaign-driver-cli.cjs'),args=['status','--journal',h.file,'--connection',GRANT];
 const good=cp.spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).type,'campaign-status');
 const before=h.read().receipt.sha256,bad=cp.spawnSync(process.execPath,[cli,...args,'--journal',h.file],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(JSON.parse(bad.stdout).error.message,/Duplicate/);assert.equal(h.read().receipt.sha256,before);
});
