'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const journal=require('./campaign-journal.cjs'),campaign=require('./campaign-controller.cjs'),api=require('./native-api.cjs');

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

function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'campaign.json');}
function pending(state){return campaign.commitOperation(state,campaign.planNext(state,{now:AT,connectionId:GRANT}),{now:AT,connectionId:GRANT});}
test('R1 whole envelope is fsynced/read back and keeps manifest, binding, scaffold and pending operation',t=>{
 const file=temp(t),initial=create(),r=journal.create(file,initial);
 assert.equal(r.sha256,api.sha(fs.readFileSync(file)));assert.deepEqual(journal.load(file).state,initial);
 const next=pending(initial),saved=journal.save(file,next,{expected:r}),loaded=journal.load(file);
 assert.deepEqual(loaded.state,next);assert.equal(loaded.receipt.sha256,saved.sha256);
 assert.ok(loaded.state.manifest&&loaded.state.binding&&loaded.state.scaffoldReceiptText&&loaded.state.controller.pending);
 assert.equal(fs.existsSync(file+'.lock'),false);
});
test('R1 rejects partial legacy or corrupted guarded state without creating a journal',t=>{
 const file=temp(t),state=create();
 for(const bad of [state.controller,{...state,revision:-1},{...state,manifestSha256:'f'.repeat(64)}])assert.throws(()=>journal.create(file,bad));
 assert.equal(fs.existsSync(file),false);
});
test('R1 create and replacement require explicit exact revision/content CAS',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),next=pending(state),before=fs.readFileSync(file);
 assert.throws(()=>journal.create(file,state),{code:'JOURNAL_CONFLICT'});
 assert.throws(()=>journal.save(file,next),{code:'JOURNAL_EXPECTED_REQUIRED'});
 for(const expected of [{revision:99,sha256:r.sha256},{revision:r.revision,sha256:'f'.repeat(64)}])assert.throws(()=>journal.save(file,next,{expected}),{code:'JOURNAL_CONFLICT'});
 assert.throws(()=>journal.save(file,state,{expected:r}),{code:'JOURNAL_REVISION'});
 assert.deepEqual(fs.readFileSync(file),before);
});
test('R1 stale reader cannot overwrite a newer committed whole campaign',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),next=pending(state);journal.save(file,next,{expected:r});
 assert.throws(()=>journal.save(file,next,{expected:r}),{code:'JOURNAL_CONFLICT'});
 assert.deepEqual(journal.load(file).state,next);
});
test('R1 concurrent writer lock blocks mutation and cannot be reclaimed while owner lives',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),lock=Buffer.from(JSON.stringify({schema:'blackice.minicpm.campaign-lock.v1',pid:process.pid,token:'current-test',createdAt:AT,journal:file}));
 fs.writeFileSync(file+'.lock',lock);const before=fs.readFileSync(file);
 assert.throws(()=>journal.save(file,pending(state),{expected:r}),{code:'JOURNAL_LOCKED'});
 assert.throws(()=>journal.recoverLock(file,{expected:r,lockSha256:api.sha(lock)}),{code:'JOURNAL_OWNER_UNSETTLED'});
 assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(file+'.lock'),lock);
});
test('R1 crash before rename preserves old journal and recovery proves dead owner without losing staging bytes',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),next=pending(state),input=path.join(path.dirname(file),'next.json');fs.writeFileSync(input,JSON.stringify(next));
 const script="const fs=require('node:fs'),j=require("+JSON.stringify(require.resolve('./campaign-journal.cjs'))+");fs.renameSync=()=>process.exit(73);j.save("+JSON.stringify(file)+",JSON.parse(fs.readFileSync("+JSON.stringify(input)+",'utf8')),{expected:"+JSON.stringify(r)+"});";
 const child=cp.spawnSync(process.execPath,['-e',script],{encoding:'utf8'});assert.equal(child.status,73,child.stderr);
 assert.deepEqual(journal.load(file).state,state);const lock=journal.inspectLock(file);assert.equal(lock.status,'gone');
 const staging=fs.readdirSync(path.dirname(file)).filter(x=>x.endsWith('.tmp'));assert.equal(staging.length,1);
 assert.throws(()=>journal.save(file,next,{expected:r}),{code:'JOURNAL_LOCKED'});
 assert.throws(()=>journal.recoverLock(file,{expected:r,lockSha256:'f'.repeat(64)}),{code:'JOURNAL_CONFLICT'});
 const recovered=journal.recoverLock(file,{expected:r,lockSha256:lock.sha256});assert.equal(recovered.recovered,true);assert.equal(recovered.stagingFilesPreserved,true);
 assert.ok(fs.existsSync(recovered.archive.path));assert.ok(fs.existsSync(path.join(path.dirname(file),staging[0])));
 journal.save(file,next,{expected:r});assert.deepEqual(journal.load(file).state,next);
});
test('R1 stable raw evidence is immutable, exact-byte hashed and read back',t=>{
 const file=temp(t),dir=path.dirname(file),bytes=Buffer.from('{"receipt":"raw"}\n');
 const a=journal.saveEvidence(dir,'native-receipt',bytes),b=journal.saveEvidence(dir,'native-receipt',bytes);
 assert.deepEqual(a,b);assert.deepEqual(fs.readFileSync(a.path),bytes);assert.equal(a.sha256,api.sha(bytes));
 fs.writeFileSync(a.path,'changed');assert.throws(()=>journal.saveEvidence(dir,'native-receipt',bytes),{code:'EVIDENCE_CONFLICT'});
});

test('R1 a valid different campaign cannot replace the frozen journal identity',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),other=inputs();other.config.requestId='other_request';
 const changed=campaign.createCampaign(other,AT);changed.revision=state.revision+1;
 assert.throws(()=>journal.save(file,changed,{expected:r}),{code:'JOURNAL_IDENTITY'});assert.deepEqual(journal.load(file).state,state);
});
test('R1 crash after rename preserves the committed pending operation for exact recovery',t=>{
 const file=temp(t),state=create(),r=journal.create(file,state),next=pending(state),input=path.join(path.dirname(file),'next.json');fs.writeFileSync(input,JSON.stringify(next));
 const script="const fs=require('node:fs'),j=require("+JSON.stringify(require.resolve('./campaign-journal.cjs'))+");const rename=fs.renameSync;fs.renameSync=(...a)=>{rename(...a);process.exit(74);};j.save("+JSON.stringify(file)+",JSON.parse(fs.readFileSync("+JSON.stringify(input)+",'utf8')),{expected:"+JSON.stringify(r)+"});";
 const child=cp.spawnSync(process.execPath,['-e',script],{encoding:'utf8'});assert.equal(child.status,74,child.stderr);
 const committed=journal.load(file),lock=journal.inspectLock(file);assert.deepEqual(committed.state,next);assert.equal(lock.status,'gone');
 assert.throws(()=>journal.recoverLock(file,{expected:r,lockSha256:lock.sha256}),{code:'JOURNAL_CONFLICT'});
 journal.recoverLock(file,{expected:committed.receipt,lockSha256:lock.sha256});
 const recovered=campaign.planNext(journal.load(file).state,{now:AT,connectionId:GRANT});assert.equal(recovered.type,'recover-same-operation');assert.deepEqual(recovered.operation.arguments,next.controller.pending.arguments);
});

test('R1 typed stores reject other schemas while guarded default stays unchanged',t=>{
 const file=temp(t),schema='blackice.test.qualification.v1';
 const typed=journal.createJournalStore({schema,validateState:s=>{assert.equal(s.scorable,false);assert.equal(typeof s.binding,'string');},identityOf:s=>api.sha(JSON.stringify([s.schema,s.scorable,s.binding]))});
 const q={schema,revision:0,scorable:false,binding:'fixed'};typed.create(file,q);
 assert.deepEqual(typed.load(file).state,q);assert.throws(()=>journal.load(file),{code:'JOURNAL_SCHEMA'});
 assert.throws(()=>typed.validate(create()),{code:'JOURNAL_SCHEMA'});
 assert.throws(()=>typed.save(file,{...q,revision:1,binding:'changed'},{expected:typed.load(file).receipt}),{code:'JOURNAL_IDENTITY'});
 const next={...q,revision:1,observation:'saved'};typed.save(file,next,{expected:typed.load(file).receipt});assert.deepEqual(typed.load(file).state,next);
});
test('R1 typed factory requires an explicit code-owned schema validator and identity',()=>{
 for(const options of [{},{schema:'test'},{schema:'test',validateState:()=>{}}])assert.throws(()=>journal.createJournalStore(options),{code:'JOURNAL_STORE_CONTRACT'});
 const typed=journal.createJournalStore({schema:'test',validateState:()=>{},identityOf:()=>null});assert.throws(()=>typed.validate({schema:'test',revision:0}),{code:'JOURNAL_IDENTITY'});
});
