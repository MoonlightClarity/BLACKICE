import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const control=require('../verification/minicpm-agent-tools-v2/native-control.cjs');
const candidateRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hashFile=file=>sha(fs.readFileSync(file));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');return file;};
const appFingerprint='a'.repeat(64);
// The focused controller suite must never contact an app or model.
globalThis.fetch=async()=>{throw Error('REAL_NETWORK_FORBIDDEN_IN_BC2_TEST');};
async function fixture(t,{taskId='D0',model=control.MODELS[0]}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-bc2-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profileDir=path.join(root,'profile'),receiptDir=path.join(root,'receipts');
  fs.mkdirSync(profileDir);fs.mkdirSync(receiptDir);
  const rawElectron=path.join(root,'mock-electron.exe');
  const preparedReceiptPath=write(path.join(receiptDir,'prepared.json'),{
    schema:'blackice.native-candidate-preparation.v1',status:'prepared',candidateRoot,profileDir,rawElectron,
    selectedModels:control.MODELS,nativeDefaults:{maxSteps:null}
  });
  const processIdentity={pid:12345,startedAt:'2026-11-22T02:00:00.000Z',executable:rawElectron,url:'http://127.0.0.1:61480/',version:'2.40.73',profileMode:'custom'};
  const runtimeFile=write(path.join(profileDir,'desktop-runtime.json'),processIdentity);
  const launchReceiptPath=write(path.join(receiptDir,'launch.json'),{
    schema:'blackice.native-candidate-launch.v1',status:'ready',candidateRoot,profileDir,rawElectron,appFingerprint,
    sourceCommit:'df936640e96c0976e782de862520daa76963c695',process:processIdentity
  });
  const deps={fingerprint:async()=>appFingerprint,alive:async()=>true};
  const config={preparedReceiptPath,preparedReceiptSha256:hashFile(preparedReceiptPath),launchReceiptPath,
    attemptDir:path.join(root,'attempt-1'),taskId,model,wallMs:3600000};
  const prepared=await control.prepare(config,deps);
  return {root,profileDir,runtimeFile,launchReceiptPath,deps,config,prepared,
    statePath:prepared.statePath,request:read(prepared.requestRef.path),state:()=>read(prepared.statePath)};
}
function nativeRun(f,{id='owned-run-1',status='running',settled=false}={}){
  const q=f.request;
  return {id,taskId:id,workflow:structuredClone(q.workflow),input:q.input.task.trim(),cwd:q.input.cwd,
    metadata:{clientRequestId:q.requestId,clientRequestHash:'b'.repeat(64)},
    benchmark:{...q.input.benchmark,caseId:f.config.taskId,workspace:q.input.cwd},
    benchmarkBudget:q.input.benchmarkBudget,planningMode:'off',executionModes:{directoryMode:'off'},
    directoryActions:'on',chatPlanning:'on',pastChats:'off',directoryDiagnostics:'maximal',
    status,settled,createdAt:'2026-11-22T02:01:00.000Z',finishedAt:settled?'2026-11-22T02:02:00.000Z':null,
    nodes:{agent:{status,settled,threadId:'fresh-'+id,reused:false}},events:[],output:settled?'Saved source and checked public tests.':'',
    eventRetention:{omittedEvents:0}};
}
function apiFor(run,{gap=false,badCursor=false,multiplePages=false}={}){
  const calls=[];
  const request=async(method,endpoint,body)=>{
    calls.push({method,endpoint,body});
    const u=new URL(endpoint,'http://127.0.0.1');
    if(endpoint==='/api/runs'&&method==='GET')return [];
    if(endpoint==='/api/runs'&&method==='POST')return structuredClone(run);
    if(endpoint==='/api/runs/'+run.id)return structuredClone(run);
    if(u.pathname.endsWith('/action-directory'))return {runId:run.id,taskId:run.taskId,state:{actions:[]},final:{ready:true,reason:'ready'}};
    if(u.pathname.endsWith('/export'))return {format:'relay-conversation',version:1,turns:[],included:{toolTraces:false,providerSessions:false}};
    if(u.searchParams.get('view')==='machine')return {
      schemaVersion:1,audience:'machine',runId:run.id,taskId:run.taskId,terminal:{status:run.status,settled:run.settled},
      coverage:{source:'maximal-host-envelopes',observed:5,retained:gap?4:5,dropped:gap?1:0,gaps:gap?[{from:2,to:2}]:[],entryMetadataOmitted:0},nodes:[],entries:[]};
    if(u.pathname.endsWith('/receipts')){
      const offset=Number(u.searchParams.get('offset')||0),view=u.searchParams.get('view');
      return {view,runId:run.id,taskId:run.taskId,offset,revision:'stable-'+view,actions:[],receipts:[],
        nextOffset:badCursor?offset:multiplePages&&offset===0?50:null};
    }
    throw Error('Unexpected mocked API route '+endpoint);
  };
  return {request,calls};
}
async function admitted(t,options={}){
  const f=await fixture(t,options),run=nativeRun(f,{status:'completed',settled:true});
  const api=apiFor(run);await control.start(f.statePath,{...f.deps,request:api.request});
  return {...f,run,api};
}
function forbidModelOverrides(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)){
    assert.ok(!['context','effort','serviceTier','maxTokens','max_tokens','maxOutputTokens','maxSteps'].includes(key),'Unexpected model override '+key);
    forbidModelOverrides(item);
  }
}
test('prepare uses the real factory and frozen scaffold for both models in one retained profile',async t=>{
  const f=await fixture(t,{taskId:'L1'});
  const profileBefore=hashFile(f.runtimeFile),q=f.request;
  assert.equal(q.input.benchmark.profile,control.PROFILE);
  assert.equal(q.input.chatPlanning,'on');assert.equal(q.input.directoryActions,'on');
  assert.equal(q.input.pastChats,'off');assert.equal(q.input.directoryMode,'off');assert.equal(q.input.planningMode,'off');
  assert.equal(q.input.benchmarkBudget.wallMs,3600000);assert.equal(q.benchmarkBudget,undefined);
  assert.match(q.input.task,/Use Modular Development/);
  forbidModelOverrides(q);
  const receipt=read(f.prepared.scaffoldRef.path);
  assert.equal(receipt.publicCaseCount,2);assert.equal(Object.keys(receipt.immutableFiles).length,7);
  assert.equal(receipt.immutableFiles['METHOD.md'],control.METHOD.sha256);
  assert.equal(hashFile(control.FROZEN.methodPath),control.PINS.method,'The historical frozen method is preserved.');
  const method=fs.readFileSync(path.join(f.prepared.workspace,'METHOD.md'),'utf8');
  assert.equal(method,fs.readFileSync(control.METHOD.path,'utf8'));
  for(const tool of ['relay_workspace','relay_directory_action','relay_code','relay_skills'])assert.ok(method.includes(tool));
  assert.ok(!method.includes('Use only relay_workspace and relay_directory_action'));
  const task=read(path.join(f.prepared.workspace,'task.json'));
  const originalTask=read(path.join(control.FROZEN.fixturesDir,'tasks.json')).find(value=>value.id===task.id);
  assert.equal(task.contract,originalTask.contract);
  assert.equal(fs.readFileSync(path.join(f.prepared.workspace,'TASK.md'),'utf8'),require(control.FROZEN.scaffoldModule).taskText(task));
  assert.deepEqual(read(path.join(f.prepared.workspace,'public-cases.json')),read(path.join(control.FROZEN.baseRoot,'public-cases.json'))[task.id]);
  for(const [name,pin]of Object.entries(receipt.immutableFiles))assert.equal(hashFile(path.join(f.prepared.workspace,name)),pin);
  assert.match(fs.readFileSync(path.join(f.prepared.workspace,'src','index.cjs'),'utf8'),/TODO/);
  assert.equal(read(path.join(control.FROZEN.fixturesDir,'tasks.json'))[0].maxOutputTokens,8192);
  const second=await control.prepare({...f.config,attemptDir:path.join(f.root,'attempt-2'),model:control.MODELS[1]},f.deps);
  assert.equal(second.profileDir,f.prepared.profileDir);assert.notEqual(second.workspace,f.prepared.workspace);
  assert.notEqual(second.requestId,f.prepared.requestId);assert.notEqual(read(second.requestRef.path).workflow.id,q.workflow.id);
  assert.equal(read(second.requestRef.path).workflow.nodes.find(n=>n.type==='agent').model,'gpt-6-luna');
  assert.equal(hashFile(f.runtimeFile),profileBefore,'Preparation must not reset or edit the candidate profile.');
});
test('prepare rejects foreign existing targets, unsupported models, extra budgets and changed preparation pins',async t=>{
  const f=await fixture(t),before=hashFile(f.prepared.requestRef.path);
  await assert.rejects(control.prepare(f.config,f.deps),{code:'TARGET_EXISTS'});
  await assert.rejects(control.prepare({...f.config,model:'default'},f.deps),{code:'MODEL_INVALID'});
  await assert.rejects(control.prepare({...f.config,maxOutputTokens:8192},f.deps),{code:'CONFIG_INVALID'});
  await assert.rejects(control.prepare({...f.config,preparedReceiptSha256:'0'.repeat(64)},f.deps),{code:'SOURCE_CHANGED'});
  assert.equal(hashFile(f.prepared.requestRef.path),before);
});
test('prepared status is offline and does not submit or inspect another run',async t=>{
  const f=await fixture(t);let called=false;
  const result=await control.status(f.statePath,{...f.deps,request:async()=>{called=true;throw Error('forbidden');}});
  assert.equal(result.phase,'prepared');assert.equal(called,false);
});
test('runtime identity, candidate drift and process death fail before native API calls',async t=>{
  const f=await fixture(t);let calls=0;
  const deps={...f.deps,request:async()=>{calls++;throw Error('forbidden');}};
  const original=read(f.runtimeFile);write(f.runtimeFile,{...original,pid:999});
  await assert.rejects(control.start(f.statePath,deps),{code:'RUNTIME_IDENTITY'});
  write(f.runtimeFile,original);
  const launch=read(f.launchReceiptPath),substitute=path.join(f.root,'different-electron.exe');
  write(f.runtimeFile,{...original,executable:substitute});
  write(f.launchReceiptPath,{...launch,rawElectron:substitute,process:{...launch.process,executable:substitute}});
  await assert.rejects(control.start(f.statePath,deps),{code:'RUNTIME_IDENTITY'});
  write(f.launchReceiptPath,launch);write(f.runtimeFile,original);
  await assert.rejects(control.start(f.statePath,{...deps,fingerprint:async()=>'c'.repeat(64)}),{code:'RUNTIME_SOURCE_CHANGED'});
  await assert.rejects(control.start(f.statePath,{...deps,alive:async()=>false}),{code:'RUNTIME_NOT_ALIVE'});
  assert.equal(calls,0);assert.equal(f.state().phase,'prepared');
});
test('start sends one exact saved request and subsequent start/status only read its run',async t=>{
  const f=await fixture(t),run=nativeRun(f),api=apiFor(run),deps={...f.deps,request:api.request};
  const before=hashFile(f.runtimeFile);
  const result=await control.start(f.statePath,deps);
  assert.equal(result.admission,'started');assert.equal(result.runId,run.id);
  assert.deepEqual(api.calls.find(c=>c.method==='POST').body,f.request);
  assert.ok(fs.existsSync(path.join(f.config.attemptDir,'admission-intent.json')));
  assert.equal((await control.start(f.statePath,deps)).admission,'recovered');
  run.status='completed';run.settled=true;
  assert.equal((await control.status(f.statePath,deps)).run.settled,true);
  assert.equal(api.calls.filter(c=>c.method==='POST').length,1);assert.equal(hashFile(f.runtimeFile),before);
});
test('lost admission response reconciles stable requestId without a second POST',async t=>{
  const f=await fixture(t),run=nativeRun(f);let posts=0,accepted=false;
  const request=async(method,endpoint)=>{
    if(method==='POST'){posts++;accepted=true;throw Object.assign(Error('response lost'),{code:'MOCK_TRANSPORT'});}
    if(endpoint==='/api/runs')return accepted?[run]:[];
    if(endpoint==='/api/runs/'+run.id)return run;
    throw Error('unexpected route');
  };
  const deps={...f.deps,request};
  await assert.rejects(control.start(f.statePath,deps),{code:'MOCK_TRANSPORT'});
  assert.equal(f.state().phase,'admission-unknown');assert.ok(fs.existsSync(f.state().admissionFailureRef.path));
  const recovered=await control.start(f.statePath,deps);
  assert.equal(recovered.runId,run.id);assert.equal(recovered.admission,'recovered');assert.equal(posts,1);
});
test('unknown absent admission and crash-window intent refuse blind retry',async t=>{
  const f=await fixture(t);let posts=0;
  const request=async method=>{if(method==='POST'){posts++;throw Error('unknown');}return [];};
  await assert.rejects(control.start(f.statePath,{...f.deps,request}));
  await assert.rejects(control.start(f.statePath,{...f.deps,request}),{code:'ADMISSION_UNRESOLVED'});
  assert.equal(posts,1);
  const second=await control.prepare({...f.config,attemptDir:path.join(f.root,'crash-attempt')},f.deps);
  write(path.join(f.root,'crash-attempt','admission-intent.json'),{requestId:second.requestId});
  await assert.rejects(control.start(second.statePath,{...f.deps,request}),{code:'ADMISSION_UNRESOLVED'});
  assert.equal(posts,1);
});
test('foreign, duplicate and resumed runs cannot satisfy admission recovery',async t=>{
  const f=await fixture(t),run=nativeRun(f);
  const cases=[
    {runs:[{...run,cwd:path.join(f.root,'foreign')}],code:'RUN_IDENTITY'},
    {runs:[run,structuredClone(run)],code:'ADMISSION_DUPLICATE'},
    {runs:[{...run,parentRunId:'old'}],code:'RUN_IDENTITY'},
    {runs:[{...run,nodes:{agent:{...run.nodes.agent,resumeThreadId:'old-thread'}}}],code:'RUN_REUSED'},
  ];
  for(const c of cases)await assert.rejects(control.start(f.statePath,{...f.deps,request:async method=>{assert.equal(method,'GET');return c.runs;}}),{code:c.code});
  assert.equal(fs.existsSync(path.join(f.config.attemptDir,'admission-intent.json')),false);
});
test('concurrent operations cannot dispatch duplicate starts',async t=>{
  const f=await fixture(t),run=nativeRun(f),api=apiFor(run),deps={...f.deps,request:api.request};
  const first=control.start(f.statePath,deps);
  await assert.rejects(control.start(f.statePath,deps),{code:'ATTEMPT_BUSY'});
  await first;assert.equal(api.calls.filter(c=>c.method==='POST').length,1);
});
test('collection requires actual settled status and grade requires collection',async t=>{
  const f=await fixture(t),run=nativeRun(f,{status:'completed',settled:false}),api=apiFor(run),deps={...f.deps,request:api.request};
  await control.start(f.statePath,deps);
  await assert.rejects(control.collect(f.statePath,deps),{code:'RUN_UNSETTLED'});
  assert.equal(api.calls.filter(c=>c.endpoint.includes('receipts')).length,0);
  await assert.rejects(control.grade(f.statePath),{code:'COLLECTION_REQUIRED'});
});
test('collect pages exact revisions, saves actual responses, and never fabricates public checks',async t=>{
  const f=await admitted(t),api=apiFor(f.run,{multiplePages:true});
  const result=await control.collect(f.statePath,{...f.deps,request:api.request});
  assert.equal(result.captureStatus,'captured');assert.equal(result.qualificationStatus,'unverified');
  const saved=read(result.collectionRef.path);
  assert.equal(saved.run.id,f.run.id);assert.equal(saved.receiptPages.tools.pages.length,2);
  assert.match(api.calls.find(c=>c.endpoint.includes('offset=50')).endpoint,/revision=stable-/);
  assert.equal(saved.execution,undefined,'No synthetic execution receipt is constructed from metadata.');
  const grade=await control.grade(f.statePath);
  assert.equal(grade.gradeStatus,'unavailable');assert.equal(grade.gradeRef,null);
  assert.match(grade.missing.join(' '),/actual accepted public-check/);
});
test('dropped coverage and invalid page cursors remain saved and block grading',async t=>{
  const f=await admitted(t);
  for(const options of [{gap:true},{badCursor:true}]){
    const api=apiFor(f.run,options),result=await control.collect(f.statePath,{...f.deps,request:api.request});
    assert.equal(result.captureStatus,'incomplete');assert.ok(result.missing.length);
    assert.ok(fs.existsSync(result.collectionRef.path));
    await assert.rejects(control.grade(f.statePath),{code:'EVIDENCE_INCOMPLETE'});
  }
  assert.equal(fs.readdirSync(path.join(f.root,'attempt-1','records')).filter(x=>x.startsWith('collection-')).length,2);
});
test('settlement changing during collection preserves failed capture',async t=>{
  const f=await admitted(t),api=apiFor(f.run);let reads=0;
  const request=async(method,endpoint,body)=>{
    if(endpoint==='/api/runs/'+f.run.id&&++reads===2)return {...f.run,settled:false};
    return api.request(method,endpoint,body);
  };
  await assert.rejects(control.collect(f.statePath,{...f.deps,request}),{code:'RUN_UNSETTLED'});
  const captured=read(f.state().collectionRef.path);
  assert.equal(captured.errors.at(-1).part,'final-run-confirmation');
});
test('grade rejects an unbound verifier and execution evidence inside model workspace',async t=>{
  const f=await admitted(t);await control.collect(f.statePath,{...f.deps,request:f.api.request});
  const execution={schema:'blackice.minicpm.agentic-execution-receipt.v1',caseId:f.config.taskId,workspace:f.prepared.workspace,
    run:{id:f.run.id,taskId:f.run.taskId,status:f.run.status,terminal:true,settled:true},
    actions:{settled:true,activeCount:0,pendingWriteCount:0,commands:[],failures:[]},completion:{agentCompleted:true,finalMessagePresent:true}};
  const file=write(path.join(f.root,'execution.json'),execution);
  await assert.rejects(control.grade(f.statePath,{executionReceiptPath:file},{verifyExecutionEvidence:async()=>({verified:true,workflowVerified:true,sourceRefs:[]})}),{code:'EXECUTION_EVIDENCE_MISSING'});
  const wrong=write(path.join(f.prepared.workspace,'src','execution.json'),execution);
  await assert.rejects(control.grade(f.statePath,{executionReceiptPath:wrong},{verifyExecutionEvidence:async()=>{throw Error('must not run');}}),{code:'EVIDENCE_SCOPE'});
  assert.equal(f.state().gradeRef,undefined);
});
test('public grade summaries exclude every private failure, answer and error value',()=>{
  const secret='PRIVATE_CASE_VALUE_SHOULD_NEVER_APPEAR';
  const report={caseId:'L1',grade:{semanticPass:false,caseCount:40,executedCases:40,passedCases:12,
    failures:[{actual:secret,expected:secret,args:[secret]}],compileError:secret,workerError:secret},
    artifactError:secret,execution:{private:secret},scaffoldIntegrity:true,validArtifactPass:false,
    sourceSnapshotSha256:'f'.repeat(64),publicSmoke:{finalArtifactVerified:false,lastCommand:{stdout:secret}}};
  const result=control.publicGrade(report);
  assert.equal(result.passedCases,12);assert.equal(result.caseCount,40);assert.equal(result.scored,true);
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(result.failures,undefined);assert.equal(result.execution,undefined);
});


// These tests inject source-bound host receipt fixtures. Only the frozen saved-source
// grading worker executes; there is no native app, model, or fabricated live claim.
function executionFixture(f,commands){
  const sourcePath=write(path.join(f.root,'host-public-check-source.json'),{
    schema:'bc2.synthetic-accepted-host-results.v1',runId:f.run.id,taskId:f.run.taskId,commands
  });
  const execution={schema:'blackice.minicpm.agentic-execution-receipt.v1',caseId:f.config.taskId,workspace:f.prepared.workspace,
    run:{id:f.run.id,taskId:f.run.taskId,status:f.run.status,terminal:true,settled:true},
    actions:{settled:true,activeCount:0,pendingWriteCount:0,commands,
      failures:commands.filter(c=>c.exitCode!==0||c.timedOut).map(c=>({receiptId:c.receiptId,code:c.timedOut?'MOCK_TIMEOUT':'MOCK_PUBLIC_FAILURE'}))},
    completion:{agentCompleted:true,finalMessagePresent:true}};
  const executionReceiptPath=write(path.join(f.root,'execution.json'),execution);
  const verifyExecutionEvidence=async({state,capture,execution:actual})=>{
    const source=read(sourcePath);
    assert.equal(source.runId,capture.run.id);assert.equal(source.taskId,capture.run.taskId);
    assert.equal(actual.caseId,state.caseId);assert.deepEqual(actual.actions.commands,source.commands);
    return {verified:true,workflowVerified:true,sourceRefs:[{path:sourcePath,bytes:fs.statSync(sourcePath).size,sha256:hashFile(sourcePath)}]};
  };
  return {executionReceiptPath,verifyExecutionEvidence};
}
function savedSource(f,text){
  fs.writeFileSync(path.join(f.prepared.workspace,'src','index.cjs'),text);
  return require(path.join(control.FROZEN.baseRoot,'support','grade-modules.cjs')).snapshotModules(f.prepared.workspace);
}
function publicCommand(f,receiptId,{snapshot,passed=false,timedOut=false,exitCode=passed?0:2,report=true}={}){
  const result=report?{schema:'blackice.minicpm.public-smoke.v1',taskId:f.config.taskId,
    semanticPass:passed,caseCount:2,executedCases:2,passedCases:passed?2:0,sourceSnapshotSha256:snapshot.sha256}:null;
  return {kind:'public-smoke',receiptId,command:'node test-public.cjs',cwd:f.prepared.workspace,
    exitCode,signal:timedOut?'SIGTERM':null,timedOut,truncated:false,
    stdout:result?JSON.stringify(result):'',stderr:'',report:result};
}
test('a real frozen L1 grade accepts an earlier timeout followed by repair and final public pass',async t=>{
  const f=await admitted(t,{taskId:'L1'});
  const snapshot=savedSource(f,"function sumPositiveEven(values) { return values.filter(v => v > 0 && v % 2 === 0).reduce((a, b) => a + b, 0); }\nmodule.exports = { sumPositiveEven };\n");
  await control.collect(f.statePath,{...f.deps,request:f.api.request});
  const commands=[
    publicCommand(f,'receipt-earlier',{snapshot,timedOut:true,exitCode:null,report:false}),
    publicCommand(f,'receipt-final',{snapshot,passed:true})
  ];
  const evidence=executionFixture(f,commands);
  const result=await control.grade(f.statePath,{executionReceiptPath:evidence.executionReceiptPath},{verifyExecutionEvidence:evidence.verifyExecutionEvidence});
  assert.equal(result.gradeStatus,'graded');assert.equal(result.grade.validArtifactPass,true);
  assert.equal(result.grade.caseCount,40);assert.equal(result.grade.passedCases,40);
  assert.equal(result.grade.finalPublicVerified,true);
  const report=read(result.gradeRef.path);
  assert.deepEqual(report.execution.actions.commands,commands,'The earlier timed-out receipt must remain unchanged.');
  assert.equal(report.toolFailureCount,1);assert.equal(report.publicSmoke.commandCount,2);
});
test('a known final D0 timeout with no public report scores saved source without claiming verification',async t=>{
  const f=await admitted(t);
  const snapshot=savedSource(f,"function directorySmoke(value) { return 'ok:' + value; }\nmodule.exports = { directorySmoke };\n");
  await control.collect(f.statePath,{...f.deps,request:f.api.request});
  const evidence=executionFixture(f,[publicCommand(f,'receipt-timeout',{snapshot,timedOut:true,exitCode:null,report:false})]);
  const result=await control.grade(f.statePath,{executionReceiptPath:evidence.executionReceiptPath},{verifyExecutionEvidence:evidence.verifyExecutionEvidence});
  assert.equal(result.gradeStatus,'graded');assert.equal(result.grade.scored,false);
  assert.equal(result.grade.validArtifactPass,true);assert.equal(result.grade.passedCases,2);
  assert.equal(result.grade.finalPublicVerified,false);
});
test('known final public and artifact failure returns the real frozen score and retains unsuccessful checks',async t=>{
  const f=await admitted(t,{taskId:'L1'});
  const snapshot=savedSource(f,"function sumPositiveEven(values) { return 0; }\nmodule.exports = { sumPositiveEven };\n");
  await control.collect(f.statePath,{...f.deps,request:f.api.request});
  const commands=[publicCommand(f,'receipt-known-failure',{snapshot,passed:false})],evidence=executionFixture(f,commands);
  const result=await control.grade(f.statePath,{executionReceiptPath:evidence.executionReceiptPath},{verifyExecutionEvidence:evidence.verifyExecutionEvidence});
  assert.equal(result.gradeStatus,'graded');assert.equal(result.grade.caseCount,40);
  assert.ok(result.grade.passedCases<40);assert.equal(result.grade.validArtifactPass,false);
  assert.equal(result.grade.finalPublicVerified,false);
  const privateReport=read(result.gradeRef.path);
  assert.deepEqual(privateReport.execution.actions.commands,commands);
  assert.equal(result.grade.failures,undefined);
});
test('source binding does not promote an unknown public command terminal state into grading evidence',async t=>{
  const f=await admitted(t);
  const snapshot=savedSource(f,"function directorySmoke(value) { return 'ok:' + value; }\nmodule.exports = { directorySmoke };\n");
  await control.collect(f.statePath,{...f.deps,request:f.api.request});
  const command=publicCommand(f,'receipt-unknown',{snapshot,exitCode:null,report:false});
  const evidence=executionFixture(f,[command]);
  await assert.rejects(control.grade(f.statePath,{executionReceiptPath:evidence.executionReceiptPath},{verifyExecutionEvidence:evidence.verifyExecutionEvidence}),{code:'PUBLIC_CHECK_EVIDENCE'});
  assert.equal(f.state().gradeRef,undefined);
});
