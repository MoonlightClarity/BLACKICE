'use strict';
// BC2: one retained native profile; fresh task/workspace per attempt.
// Importing this module never opens an app, connects to a model, or submits work.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const SCHEMA = 'blackice.minicpm.native-control.v2';
const MODELS = Object.freeze(['local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S', 'gpt-6-luna']);
const PROFILE = 'minicpm-agent-tools-v2';
const METHOD = Object.freeze({path:path.join(__dirname,'METHOD.md'),sha256:'a5beb79a10098d7bf38fabd25779fd91b40e41feb8df0278230a049c95425698'});
const frozenRoot = String.raw`C:\Users\user\Documents\Codex\BLACKICE-minicpm-context-vision-20261120\verification`;
const FROZEN = Object.freeze({
  baseRoot: path.join(frozenRoot, 'minicpm-agentic-v1', 'harness'),
  fixturesDir: path.join(frozenRoot, 'minicpm-surgery', 'benchmark'),
  scaffoldModule: path.join(frozenRoot, 'minicpm-agentic-v2', 'harness-deltas', 'create-v2-workspace.cjs'),
  methodPath: path.join(frozenRoot, 'minicpm-agentic-v2', 'packet', 'METHOD.md'),
  bootstrapPath: path.join(frozenRoot, 'minicpm-agentic-v2', 'packet', 'task-bootstrap.txt'),
});
const PINS = Object.freeze({
  scaffold: '6b7c75400901c7c0357775e4b62e8218bbd6a27372d3d7d51cb50ff58e6ebdbf',
  method: 'f3c64b8bac8c52ef73833be34c857fbb5242eef6f2ebf9bcc5f8d321f8b4ccf5',
  bootstrap: '3211e1350df2ab1b257ff3f4e324e2e540b5d56d830e33bd285bef7fae56c01a',
  tasks: '2ac0b6d2d4477fb75fa1b6ebef27026513364e5d87a9f394b0798d3af3f444dc',
  hidden: '8145fdf3dc456d8d69870230f7d1ea1af1651c688618394ae8e16146df3a883b',
});
const hash = value => createHash('sha256').update(value).digest('hex');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const terminal = run => ['completed','failed','cancelled','blocked'].includes(run?.status);
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function check(ok, code, message) { if (!ok) fail(code, message); }
function absolute(value) {
  check(typeof value === 'string' && path.isAbsolute(value), 'PATH_INVALID', 'An absolute owned path is required.');
  return path.resolve(value);
}
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function outsideWorkspace(state,file) {
  const relative=path.relative(fs.realpathSync(state.workspace),fs.realpathSync(file));
  check(relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'EVIDENCE_SCOPE','Private execution/grade evidence must stay outside the model workspace.');
}
function ref(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'FILE_INVALID', 'Expected a regular evidence/source file.');
  const b = fs.readFileSync(file);
  return {path:path.resolve(file), bytes:b.length, sha256:hash(b)};
}
function verifyRef(value) {
  check(object(value) && /^[a-f0-9]{64}$/.test(value.sha256 || ''), 'PIN_INVALID', 'A SHA-256 source reference is required.');
  const actual = ref(value.path);
  check(actual.sha256 === value.sha256, 'SOURCE_CHANGED', 'A bound source/evidence file changed.');
  return actual;
}
function pinned(file, expected) { return verifyRef({path:file,sha256:expected}); }
function writeNew(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const fd=fs.openSync(file,'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return ref(file);
}
function saveState(file, value) {
  const temporary=file+'.tmp-'+randomUUID();
  writeNew(temporary,value); fs.renameSync(temporary,file);
}
function saveRecord(state, name, value) {
  return writeNew(path.join(state.attemptDir,'records',name+'-'+randomUUID()+'.json'),value);
}
function verifyFrozen() {
  const pins=[
    pinned(FROZEN.scaffoldModule,PINS.scaffold), pinned(FROZEN.methodPath,PINS.method),
    pinned(FROZEN.bootstrapPath,PINS.bootstrap), pinned(path.join(FROZEN.fixturesDir,'tasks.json'),PINS.tasks),
    pinned(path.join(FROZEN.fixturesDir,'hidden-cases.json'),PINS.hidden),
    pinned(METHOD.path,METHOD.sha256),
  ];
  const scaffold = require(FROZEN.scaffoldModule);
  scaffold.verifyBase(FROZEN.baseRoot);
  for(const [name,sha256] of Object.entries(scaffold.basePins)) pins.push(pinned(path.join(FROZEN.baseRoot,name),sha256));
  return {scaffold,pins};
}
async function fingerprint(candidateRoot, deps) {
  if(deps.fingerprint) return deps.fingerprint(candidateRoot);
  const module=await import(pathToFileURL(path.join(candidateRoot,'scripts','release-check.mjs')).href);
  return module.appFingerprint(candidateRoot);
}
function readState(statePath) {
  statePath=absolute(statePath); const state=readJSON(statePath);
  check(state.schema===SCHEMA && samePath(statePath,path.join(state.attemptDir,'state.json')), 'STATE_INVALID', 'Attempt state identity is invalid.');
  verifyRef(state.preparation); verifyRef(state.requestRef); verifyRef(state.scaffoldRef);
  for(const item of state.sources) verifyRef(item);
  verifyFrozen();
  const request=readJSON(state.requestRef.path);
  check(request.requestId===state.requestId && request.workflow.id===state.workflowId, 'REQUEST_CHANGED', 'Saved admission request identity changed.');
  return {state,statePath,request};
}
async function locked(statePath, fn) {
  statePath=absolute(statePath); const lock=statePath+'.lock'; let fd;
  try { fd=fs.openSync(lock,'wx'); } catch(error) { if(error.code==='EEXIST') fail('ATTEMPT_BUSY','Another controller operation owns this attempt; inspect a stale lock before recovery.'); throw error; }
  try { return await fn(readState(statePath)); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function summary(state) {
  return {schema:SCHEMA,statePath:path.join(state.attemptDir,'state.json'),phase:state.phase,caseId:state.caseId,model:state.model,
    profileDir:state.profileDir,workspace:state.workspace,requestId:state.requestId,runId:state.runId||null,
    run:state.runSummary||null,requestRef:state.requestRef,scaffoldRef:state.scaffoldRef,methodRef:state.methodRef,
    collectionRef:state.collectionRef||null,gradeRef:state.gradeRef||null};
}
async function prepare(config, deps={}) {
  check(object(config), 'CONFIG_INVALID','A preparation configuration is required.');
  const allowed=['preparedReceiptPath','preparedReceiptSha256','launchReceiptPath','attemptDir','taskId','model','wallMs'];
  check(Object.keys(config).every(k=>allowed.includes(k)), 'CONFIG_INVALID','Only native identity, attempt, model/task and watchdog fields are accepted; model budgets are not controller options.');
  check(/^(D0|L[1-7])$/.test(config.taskId||''), 'TASK_INVALID','Choose D0 or L1 through L7.');
  check(MODELS.includes(config.model), 'MODEL_INVALID','Choose the exact reviewed MiniCPM or native Luna model.');
  check(Number.isSafeInteger(config.wallMs)&&config.wallMs>=1000&&config.wallMs<=3600000,'WATCHDOG_INVALID','wallMs must be an integer from 1000 through 3600000.');
  const preparation=pinned(absolute(config.preparedReceiptPath),config.preparedReceiptSha256);
  const prepared=readJSON(preparation.path);
  check(prepared.schema==='blackice.native-candidate-preparation.v1'&&prepared.status==='prepared','PREPARATION_INVALID','Use the saved NQ1 preparation receipt.');
  const candidateRoot=fs.realpathSync(absolute(prepared.candidateRoot)),profileDir=fs.realpathSync(absolute(prepared.profileDir)),rawElectron=absolute(prepared.rawElectron);
  const launchReceiptPath=absolute(config.launchReceiptPath),attemptDir=absolute(config.attemptDir);
  check(samePath(path.dirname(launchReceiptPath),path.dirname(preparation.path)),'LAUNCH_INVALID','The launch receipt must belong to the NQ1 receipt directory.');
  check(!fs.existsSync(attemptDir),'TARGET_EXISTS','The attempt target already exists; inspect its saved state instead of recreating it.');
  const {scaffold,pins}=verifyFrozen();
  const appFingerprint=await fingerprint(candidateRoot,deps);
  check(/^[a-f0-9]{64}$/.test(appFingerprint||''),'FINGERPRINT_INVALID','The candidate fingerprint is unavailable.');
  const factoryPath=path.join(candidateRoot,'public','mission-model.mjs');
  const sources=[ref(__filename),ref(factoryPath),ref(path.join(candidateRoot,'scripts','release-check.mjs')),...pins];
  const {createMissionWorkflow}=await import(pathToFileURL(factoryPath).href);
  fs.mkdirSync(path.dirname(attemptDir),{recursive:true});fs.mkdirSync(attemptDir);
  const workspace=path.join(attemptDir,'workspace'),receiptPath=path.join(attemptDir,'scaffold-receipt.json');
  let made;
  try { made=scaffold.createV2Workspace({...FROZEN,methodPath:METHOD.path,taskId:config.taskId,workspace,receiptPath}); }
  catch(error) { writeNew(path.join(attemptDir,'prepare-failure.json'),{code:'PREPARE_FAILED',message:String(error.message)});throw error; }
  const task='Use Modular Development.\n'+made.configFragment.task;
  const requestId='bc2-'+randomUUID(),workflowId='bc2-'+config.taskId+'-'+randomUUID();
  const workflow=createMissionWorkflow({id:workflowId,task,model:config.model,cwd:workspace,planningMode:'off'});
  const request={requestId,workflow,input:{task,cwd:workspace,planningMode:'off',directoryMode:'off',
    directoryActions:'on',chatPlanning:'on',pastChats:'off',directoryDiagnostics:'maximal',
    benchmark:{profile:PROFILE,scaffoldReceiptPath:receiptPath,scaffoldReceiptSha256:made.receiptSha256},
    benchmarkBudget:{wallMs:config.wallMs}}};
  const requestRef=writeNew(path.join(attemptDir,'request.json'),request);
  const state={schema:SCHEMA,phase:'prepared',createdAt:new Date().toISOString(),attemptDir,workspace,caseId:config.taskId,model:config.model,
    candidateRoot,profileDir,rawElectron,appFingerprint,launchReceiptPath,preparation,sources,requestId,workflowId,requestRef,methodRef:ref(METHOD.path),scaffoldRef:ref(receiptPath)};
  writeNew(path.join(attemptDir,'state.json'),state); return summary(state);
}
async function verifyRuntime(state,deps={}) {
  const launchRef=ref(state.launchReceiptPath),launch=readJSON(launchRef.path);
  check(launch.schema==='blackice.native-candidate-launch.v1'&&launch.status==='ready'&&samePath(launch.profileDir,state.profileDir)&&samePath(launch.candidateRoot,state.candidateRoot),
    'RUNTIME_IDENTITY','The ready launch receipt does not identify this prepared candidate profile.');
  if(state.launchRef) check(launchRef.sha256===state.launchRef.sha256,'RUNTIME_CHANGED','The admitted native launch receipt changed.');
  check(launch.appFingerprint===state.appFingerprint&&(await fingerprint(state.candidateRoot,deps))===state.appFingerprint,
    'RUNTIME_SOURCE_CHANGED','The native launch and current candidate sources must match the prepared fingerprint.');
  const runtime=readJSON(path.join(state.profileDir,'desktop-runtime.json')),expected=launch.process;
  check(object(expected)&&Number.isSafeInteger(expected.pid)&&expected.pid>0&&expected.profileMode==='custom','RUNTIME_IDENTITY','A custom-profile process identity is required.');
  for(const key of ['pid','startedAt','executable','url','version','profileMode'])
    check(runtime[key]===expected[key]&&runtime[key]!==undefined,'RUNTIME_IDENTITY','The owned desktop runtime identity changed: '+key);
  check(samePath(expected.executable,launch.rawElectron)&&samePath(launch.rawElectron,state.rawElectron),'RUNTIME_IDENTITY','The launch executable must be the prepared raw Electron.');
  try { if(deps.alive) check(await deps.alive(expected.pid),'RUNTIME_NOT_ALIVE','The owned native process is not alive.'); else process.kill(expected.pid,0); }
  catch(error) { fail('RUNTIME_NOT_ALIVE','The owned native process is not alive or cannot be verified.'); }
  const url=new URL(expected.url);
  check(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/',
    'RUNTIME_URL','The native API must use the exact owned loopback origin.');
  return {launchRef,origin:url.origin};
}
async function transport(identity,deps={}) {
  if(deps.request) return deps.request;
  const home=await fetch(identity.origin+'/',{redirect:'error',signal:AbortSignal.timeout(30000)});
  check(home.ok,'SESSION_UNAVAILABLE','The owned native app did not establish a local session.');
  const cookies=home.headers.getSetCookie?.()||[];
  const cookie=cookies.map(value=>value.split(';',1)[0]).find(value=>/^relay_session_[0-9]+=/.test(value));
  check(cookie,'SESSION_UNAVAILABLE','The owned native session cookie is unavailable.');
  // Cookie stays in process memory; it is never included in state or output.
  return async(method,pathname,body)=>{
    check(typeof pathname==='string'&&pathname.startsWith('/api/')&&!pathname.startsWith('//'),'API_PATH','Only the selected native API is available.');
    const response=await fetch(identity.origin+pathname,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Cookie:cookie,Origin:identity.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok) throw Object.assign(new Error('Native API request failed.'),{code:'NATIVE_HTTP',status:response.status});
    return response.json();
  };
}
function assertRun(state,request,run) {
  check(object(run)&&typeof run.id==='string'&&/^[A-Za-z0-9_-]+$/.test(run.id)&&run.taskId===run.id&&!run.parentRunId&&!run.retryOf,
    'RUN_IDENTITY','Expected one fresh task/run, not a continuation or retry.');
  check(!state.runId||run.id===state.runId,'RUN_IDENTITY','The response belongs to another run.');
  const agents=run.workflow?.nodes?.filter(n=>n.type==='agent')||[];
  check(run.metadata?.clientRequestId===state.requestId&&run.workflow?.id===state.workflowId&&run.input===request.input.task.trim()&&samePath(run.cwd,state.workspace)&&agents.length===1&&agents[0].model===state.model,
    'RUN_IDENTITY','Native admission does not match the saved request.');
  check(run.benchmark?.profile===PROFILE&&run.benchmark.caseId===state.caseId&&run.benchmark.scaffoldReceiptSha256===state.scaffoldRef.sha256&&
    samePath(run.benchmark.scaffoldReceiptPath,state.scaffoldRef.path)&&run.benchmarkBudget?.wallMs===request.input.benchmarkBudget.wallMs&&
    run.pastChats==='off'&&run.directoryActions==='on'&&run.chatPlanning==='on'&&run.planningMode==='off'&&run.executionModes?.directoryMode==='off'&&run.directoryDiagnostics==='maximal',
    'RUN_OPTIONS_CHANGED','The admitted benchmark, modes or watchdog differ from the saved request.');
  for(const node of Object.values(run.nodes||{})) check(!node.resumeThreadId&&!node.reused,'RUN_REUSED','A fresh benchmark cannot reuse a provider conversation or node.');
  return run;
}
function updateRun(state,run) {
  state.runId=run.id; state.phase='admitted';
  state.runSummary={id:run.id,taskId:run.taskId,status:run.status,settled:run.settled===true,finishedAt:run.finishedAt||null,
    threadIds:Object.values(run.nodes||{}).map(n=>n.threadId).filter(Boolean),outputChars:typeof run.output==='string'?run.output.length:0};
}
async function reconcile(state,request,api) {
  const runs=await api('GET','/api/runs');
  check(Array.isArray(runs),'ADMISSION_LOOKUP','Native request recovery did not return a run list.');
  const matches=runs.filter(run=>run.metadata?.clientRequestId===state.requestId);
  check(matches.length<=1,'ADMISSION_DUPLICATE','Multiple runs claim the same saved request ID.');
  return matches.length?assertRun(state,request,matches[0]):null;
}
async function start(statePath,deps={}) {
  return locked(statePath,async({state,request,statePath})=>{
    const identity=await verifyRuntime(state,deps),api=await transport(identity,deps);
    const recovered=state.runId?assertRun(state,request,await api('GET','/api/runs/'+state.runId)):await reconcile(state,request,api);
    if(recovered){state.launchRef=identity.launchRef;updateRun(state,recovered);saveState(statePath,state);return {...summary(state),admission:'recovered'};}
    const intentPath=path.join(state.attemptDir,'admission-intent.json');
    check(state.phase==='prepared'&&!fs.existsSync(intentPath),'ADMISSION_UNRESOLVED','An earlier admission may have taken effect. No second POST was sent; recover the original request ID or inspect the saved failure.');
    state.launchRef=identity.launchRef;
    writeNew(intentPath,{schema:SCHEMA+'.admission-intent',requestId:state.requestId,requestRef:state.requestRef,launchRef:identity.launchRef,at:new Date().toISOString()});
    state.phase='admitting';saveState(statePath,state);
    try {
      const run=assertRun(state,request,await api('POST','/api/runs',request));
      state.admissionRef=saveRecord(state,'admission-response',run);updateRun(state,run);saveState(statePath,state);
      return {...summary(state),admission:'started'};
    } catch(error) {
      // Even an HTTP failure is retained as uncertain; never retry a mutation blindly.
      state.phase='admission-unknown';state.admissionFailure={code:error.code||'NATIVE_TRANSPORT',httpStatus:error.status||null};
      state.admissionFailureRef=saveRecord(state,'admission-failure',{...state.admissionFailure,requestId:state.requestId,at:new Date().toISOString()});
      saveState(statePath,state);throw error;
    }
  });
}
async function status(statePath,deps={}) {
  return locked(statePath,async({state,request,statePath})=>{
    if(state.phase==='prepared')return summary(state);
    const identity=await verifyRuntime(state,deps),api=await transport(identity,deps);
    const run=state.runId?assertRun(state,request,await api('GET','/api/runs/'+state.runId)):await reconcile(state,request,api);
    check(run,'ADMISSION_UNRESOLVED','No matching admitted run is visible; the unknown attempt remains retained.');
    updateRun(state,run);saveState(statePath,state);return summary(state);
  });
}
function checkCapture(capture) {
  const missing=[],run=capture.run,m=capture.machine;
  if(!terminal(run)||run.settled!==true)missing.push('terminal-settled-run');
  if(capture.errors.length)missing.push(...capture.errors.map(x=>x.part));
  if(m?.runId!==run.id||m?.taskId!==run.taskId||m?.terminal?.settled!==true||m?.coverage?.source!=='maximal-host-envelopes')missing.push('bound-maximal-machine-trace');
  if(m?.coverage?.dropped!==0||!Array.isArray(m?.coverage?.gaps)||m.coverage.gaps.length||m?.coverage?.entryMetadataOmitted!==0)missing.push('complete-machine-coverage');
  if((run.eventRetention?.omittedEvents??0)!==0)missing.push('ordinary-event-retention');
  if(capture.ledger?.runId!==run.id||capture.ledger?.taskId!==run.taskId)missing.push('bound-directory-ledger');
  for(const view of ['context','tools','decisions'])if(capture.receiptPages[view]?.complete!==true)missing.push('complete-'+view+'-pages');
  return [...new Set(missing)];
}
async function collect(statePath,deps={}) {
  return locked(statePath,async({state,request,statePath})=>{
    check(state.runId,'RUN_UNBOUND','Recover the admitted run before collection.');
    const identity=await verifyRuntime(state,deps),api=await transport(identity,deps);
    const run=assertRun(state,request,await api('GET','/api/runs/'+state.runId));
    check(terminal(run)&&run.settled===true,'RUN_UNSETTLED','Collection requires a terminal run and settled:true.');
    const capture={schema:SCHEMA+'.capture',at:new Date().toISOString(),launchRef:identity.launchRef,requestRef:state.requestRef,run,errors:[],receiptPages:{}};
    const base='/api/conversations/'+run.id,query='?taskId='+encodeURIComponent(run.taskId);
    async function get(part,url){try{return await api('GET',url);}catch(error){capture.errors.push({part,code:error.code||'CAPTURE_FAILED',httpStatus:error.status||null});return null;}}
    capture.ledger=await get('directory-ledger',base+'/action-directory'+query);
    capture.machine=await get('machine-trace',base+'/receipts'+query+'&view=machine');
    capture.transcript=await get('conversation-transcript',base+'/export?format=json');
    for(const view of ['context','tools','decisions']){
      const result={pages:[],complete:false};capture.receiptPages[view]=result;let offset=0,revision;
      for(let i=0;i<100;i++){
        const page=await get(view+'-page',base+'/receipts'+query+'&view='+view+'&offset='+offset+'&limit=50'+(revision?'&revision='+encodeURIComponent(revision):''));
        if(!page)break;result.pages.push(page);
        if(page.runId!==run.id||page.taskId!==run.taskId||page.offset!==offset||typeof page.revision!=='string'||(revision&&page.revision!==revision)){capture.errors.push({part:view+'-page-identity',code:'RECEIPT_IDENTITY'});break;}
        revision=page.revision;
        if(page.nextOffset===null){result.complete=true;break;}
        if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset){capture.errors.push({part:view+'-cursor',code:'RECEIPT_CURSOR'});break;}
        offset=page.nextOffset;
      }
    }
    let confirmed;
    try {
      confirmed=assertRun(state,request,await api('GET','/api/runs/'+run.id));
      check(terminal(confirmed)&&confirmed.settled===true,'RUN_UNSETTLED','The owned run changed settlement during collection.');
    } catch(error) {
      capture.errors.push({part:'final-run-confirmation',code:error.code||'CAPTURE_FAILED'});
      capture.missing=checkCapture(capture);state.collectionRef=saveRecord(state,'failed-collection',capture);saveState(statePath,state);throw error;
    }
    capture.run=confirmed;capture.missing=checkCapture(capture);
    capture.evidenceLimitations=['Metadata receipts and conversation exports do not prove raw code/tool delivery.','Actual accepted relay_code save/check results, effective skill delivery, Planning and fresh-context evidence need their original host/provider sources.'];
    state.collectionRef=saveRecord(state,'collection',capture);updateRun(state,confirmed);saveState(statePath,state);
    return {...summary(state),captureStatus:capture.missing.length?'incomplete':'captured',missing:capture.missing,qualificationStatus:'unverified',evidenceLimitations:capture.evidenceLimitations};
  });
}
function publicGrade(report) {
  const g=report?.grade||{};
  return {caseId:report?.caseId||null,scored:report?.caseId!=='D0',semanticPass:g.semanticPass===true,
    passedCases:Number.isSafeInteger(g.passedCases)?g.passedCases:null,caseCount:Number.isSafeInteger(g.caseCount)?g.caseCount:null,
    executedCases:Number.isSafeInteger(g.executedCases)?g.executedCases:null,scaffoldIntegrity:report?.scaffoldIntegrity===true,
    validArtifactPass:report?.validArtifactPass===true,finalPublicVerified:report?.publicSmoke?.finalArtifactVerified===true,
    sourceSnapshotSha256:report?.sourceSnapshotSha256||null};
}
async function grade(statePath,options={},deps={}) {
  return locked(statePath,async({state,statePath})=>{
    check(state.collectionRef,'COLLECTION_REQUIRED','Collect settled owned evidence before grading.');verifyRef(state.collectionRef);
    const capture=readJSON(state.collectionRef.path);
    check(checkCapture(capture).length===0,'EVIDENCE_INCOMPLETE','Captured native evidence is missing or dropped; grading remains unavailable.');
    if(typeof deps.verifyExecutionEvidence!=='function') return {...summary(state),gradeStatus:'unavailable',
      missing:['A reviewed adapter must bind actual accepted public-check and settled-action source receipts. Metadata pages and final prose are insufficient.']};
    check(options.executionReceiptPath,'EXECUTION_EVIDENCE_REQUIRED','An actual execution receipt is required.');
    const executionRef=ref(absolute(options.executionReceiptPath));outsideWorkspace(state,executionRef.path);const execution=readJSON(executionRef.path);
    check(execution.schema==='blackice.minicpm.agentic-execution-receipt.v1'&&execution.caseId===state.caseId&&samePath(execution.workspace,state.workspace)&&
      execution.run?.id===capture.run.id&&execution.run?.taskId===capture.run.taskId&&execution.run?.status===capture.run.status&&execution.run?.terminal===true&&execution.run?.settled===true,
      'EXECUTION_IDENTITY','The execution receipt must identify the captured settled run.');
    // No default adapter guesses provider payload formats. Root qualifies one against actual D0 sources.
    const proof=await deps.verifyExecutionEvidence({state,capture,execution,executionRef});
    check(proof?.verified===true&&proof?.workflowVerified===true&&Array.isArray(proof.sourceRefs)&&proof.sourceRefs.length>0,
      'EXECUTION_EVIDENCE_MISSING','Actual source-bound v2 workflow and public-check evidence are required.');
    for(const item of proof.sourceRefs){verifyRef(item);outsideWorkspace(state,item.path);}
    const {gradeArtifact,readExecutionReceipt}=require(path.join(FROZEN.baseRoot,'grade-artifact.cjs'));
    readExecutionReceipt({taskId:state.caseId,workspace:state.workspace,executionReceiptPath:executionRef.path});
    const publicCommands=execution.actions.commands.filter(c=>c.kind==='public-smoke');
    check(publicCommands.length>0&&publicCommands.every(c=>typeof c.receiptId==='string'&&c.receiptId&&c.command==='node test-public.cjs'&&samePath(c.cwd,state.workspace)&&
      typeof c.timedOut==='boolean'&&(Number.isInteger(c.exitCode)||c.exitCode===null&&(c.timedOut===true||c.cancelled===true||typeof c.signal==='string'&&c.signal.length>0))),
      'PUBLIC_CHECK_EVIDENCE','Use source-bound public command receipts with a known terminal result. Failed, timed-out or cancelled checks remain evidence; unknown execution does not.');
    // The frozen grader scores saved source independently of public-test success.
    // Keep every observed failed check; only the final command can verify the final artifact.
    let result;
    try {
      if(state.caseId==='D0'){
        const {snapshotModules,runCases}=require(path.join(FROZEN.baseRoot,'support','grade-modules.cjs'));
        const {task,cases}=require(path.join(FROZEN.baseRoot,'prep','directory-smoke.cjs'));
        const scaffold=readJSON(state.scaffoldRef.path),snapshot=snapshotModules(state.workspace);
        const scaffoldIntegrity=Object.entries(scaffold.immutableFiles).every(([name,pin])=>ref(path.join(state.workspace,name)).sha256===pin);
        const value=runCases(snapshot,task.functionName,cases),last=publicCommands.at(-1);
        result={snapshot,report:{schema:SCHEMA+'.d0-grade',caseId:'D0',scored:false,grade:value,scaffoldIntegrity,
          validArtifactPass:scaffoldIntegrity&&value.semanticPass===true,sourceSnapshotSha256:snapshot.sha256,
          publicSmoke:{finalArtifactVerified:last.exitCode===0&&last.timedOut===false&&last.report?.schema==='blackice.minicpm.public-smoke.v1'&&last.report.taskId==='D0'&&last.report.semanticPass===true&&last.report.caseCount===2&&last.report.executedCases===2&&last.report.passedCases===2&&last.report.sourceSnapshotSha256===snapshot.sha256},
          workflowVerified:true,executionReceiptSha256:executionRef.sha256,evidenceSourceRefs:proof.sourceRefs}};
      }else result=gradeArtifact({taskId:state.caseId,workspace:state.workspace,fixturesDir:FROZEN.fixturesDir,receiptPath:state.scaffoldRef.path,executionReceiptPath:executionRef.path});
    }catch(error){state.gradeFailureRef=saveRecord(state,'private-grade-failure',{message:String(error.message),code:error.code||null});saveState(statePath,state);fail('GRADING_FAILED','Saved-artifact grading failed; inspect the private host receipt.');}
    state.gradeRef=saveRecord(state,'private-grade',result.report);
    state.snapshotRef=saveRecord(state,'private-source-snapshot',result.snapshot);
    state.gradeSummary=publicGrade(result.report);saveState(statePath,state);
    return {...summary(state),gradeStatus:'graded',grade:state.gradeSummary};
  });
}
async function main(argv=process.argv.slice(2)) {
  const [operation,file,...rest]=argv;
  check(['prepare','start','status','collect','grade'].includes(operation)&&file&&rest.length===0,'USAGE','Use native-control.cjs prepare CONFIG.json or start|status|collect|grade STATE.json.');
  const result=operation==='prepare'?await prepare(readJSON(file)):await module.exports[operation](file);
  console.log(JSON.stringify(result,null,2));
  if(result.captureStatus==='incomplete'||result.gradeStatus==='unavailable')process.exitCode=2;
}
module.exports={SCHEMA,PROFILE,MODELS,FROZEN,PINS,METHOD,prepare,start,status,collect,grade,publicGrade,verifyRuntime,checkCapture,main};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:error.code||'CONTROLLER_FAILED',message:error.code?error.message:'Controller operation failed; inspect the saved host evidence.'}));process.exitCode=1;});
