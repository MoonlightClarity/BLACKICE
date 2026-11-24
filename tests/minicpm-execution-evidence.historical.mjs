import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createBenchmarkExchangeTrace} from '../lib/provider-exchange-trace.mjs';
const require=createRequire(import.meta.url);
const control=require('../verification/minicpm-agent-tools-v2/native-control.cjs');
const verifier=require('../verification/minicpm-agent-tools-v2/verify-execution.cjs');
const {snapshotModules}=require(path.join(control.FROZEN.baseRoot,'support','grade-modules.cjs'));
const candidateRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const ref=file=>({path:file,bytes:fs.statSync(file).size,sha256:sha(fs.readFileSync(file))});
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');return ref(file);};
const textOf=call=>call.contentItems.filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
const at=n=>new Date(Date.parse('2026-11-22T03:00:01.000Z')+n*100).toISOString();
const correctSource="// Unicode remains exact: 👩🏽‍💻 e\u0301\nmodule.exports = { directorySmoke: value => 'ok:' + value };\n";
// These fixtures exercise only saved fake transport files. No app or model may be contacted.
globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN_IN_BC4_TEST');};

async function fixture(t,{route='native',timeoutFirst=false,finalFailure=false,noCheck=false,omitEarlierDelivery=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-bc4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profileDir=path.join(root,'profile'),receiptDir=path.join(root,'receipts');fs.mkdirSync(profileDir);fs.mkdirSync(receiptDir);
  const rawElectron=path.join(root,'fake-electron.exe'),appFingerprint='b'.repeat(64),model=control.MODELS[route==='native'?1:0];
  const preparedRef=write(path.join(receiptDir,'prepared.json'),{schema:'blackice.native-candidate-preparation.v1',status:'prepared',candidateRoot,profileDir,rawElectron,selectedModels:control.MODELS});
  const launchRef=write(path.join(receiptDir,'launch.json'),{schema:'blackice.native-candidate-launch.v1',status:'ready',candidateRoot,profileDir,rawElectron,appFingerprint,
    process:{pid:123,startedAt:'2026-11-22T02:59:00.000Z',executable:rawElectron,url:'http://127.0.0.1:61480',version:'2.40.73',profileMode:'custom'}});
  const prepared=await control.prepare({preparedReceiptPath:preparedRef.path,preparedReceiptSha256:preparedRef.sha256,launchReceiptPath:launchRef.path,attemptDir:path.join(root,'attempt'),taskId:'D0',model,wallMs:3600000},{fingerprint:async()=>appFingerprint});
  const statePath=prepared.statePath,state=read(statePath),request=read(state.requestRef.path),runId='fixture-'+randomUUID(),threadId='fresh-'+randomUUID();
  Object.assign(state,{phase:'admitted',runId,launchRef});
  const sourcePath=path.join(state.workspace,'src','index.cjs'),initial=fs.readFileSync(sourcePath),initialSnapshot=snapshotModules(state.workspace);
  const source=finalFailure?"module.exports = { directorySmoke: value => 'wrong' };\n":correctSource;
  fs.writeFileSync(sourcePath,source);const finalSnapshot=snapshotModules(state.workspace),sourceHash=sha(source);
  const run={id:runId,taskId:runId,workflow:structuredClone(request.workflow),input:request.input.task.trim(),cwd:state.workspace,metadata:{clientRequestId:state.requestId},
    benchmark:{...request.input.benchmark,caseId:'D0',workspace:state.workspace},benchmarkBudget:request.input.benchmarkBudget,
    planningMode:'off',executionModes:{directoryMode:'off'},pastChats:'off',directoryActions:'on',chatPlanning:'on',directoryDiagnostics:'maximal',
    status:noCheck?'cancelled':'completed',settled:true,createdAt:'2026-11-22T03:00:00.000Z',finishedAt:'2026-11-22T03:01:00.000Z',
    nodes:{agent:{status:noCheck?'cancelled':'completed',threadId,reused:false,benchmarkEvidenceMode:route==='native'?'native-codex-receipts':'compatible-provider-trace'}},
    events:[],output:noCheck?'':'Saved and checked.',eventRetention:{omittedEvents:0},planningModuleReceipts:[{type:'planning.module',moduleId:'builtin-decomposition',phase:'completed',actionId:'implement'}],
    skillLoadReceipts:[{type:'skill_context_submitted',skillId:'library-modular-development',title:'Modular Development',source:'bundled',sourceRevision:'fixture'},
      {type:'skill_loaded',skillId:'library-modular-development',title:'Modular Development'}]};
  const ledger={version:1,taskId:runId,actions:[{id:'implement',state:'observed',observation:{authority:'agent',claim:'Fixture only',receipts:[]}}],receipts:[],revision:1,actionRevision:1,focus:null,nextReceipt:1};
  const f={root,statePath,state,request,run,ledger,launchRef,preparedRef,sourcePath,source,sourceHash,initial,initialSnapshot,finalSnapshot,route,calls:[],events:[],captureDir:path.join(state.attemptDir,'capture-fixture'),omitEarlierDelivery};
  function add(name,args,body,{success=true}={}){
    const n=f.calls.length+1,id='exec-'+randomUUID(),receiptId='receipt-'+n;
    const call={type:'dynamicToolCall',id,tool:name,arguments:args,status:'completed',success,contentItems:[{type:'inputText',text:JSON.stringify(body)},{type:'inputText',text:'DIRECTORY HOST RECEIPT '+receiptId+'; current revision '+n+'. This is handler activity, not verified task completion.'}]};
    f.calls.push(call);ledger.receipts.push({id:receiptId,taskId:runId,runId,nodeId:'agent',actionId:'implement',tool:name,state:'returned',at:at(n),returnedAt:at(n),success,actionDispatched:true});return call;
  }
  f.add=add;
  function command({hash=sourceHash,bytes=Buffer.byteLength(source),snapshot=finalSnapshot,timeout=false,failed=false}={}){
    const report={schema:'blackice.minicpm.public-smoke.v1',taskId:'D0',semanticPass:!failed,caseCount:2,executedCases:2,passedCases:failed?0:2,sourceSnapshotSha256:snapshot.sha256,failures:[]};
    const base={cwd:state.workspace,exitCode:timeout?null:failed?1:0,signal:null,timedOut:timeout,truncated:false,durationMs:3,
      stdout:timeout?'':JSON.stringify(report),stderr:'',command:'node test-public.cjs',shell:'none',executable:process.execPath,args:['test-public.cjs'],actionDispatched:true,
      reportValid:!timeout,sourceSnapshotVerified:!timeout,sourceSnapshotBeforeSha256:snapshot.sha256,sourceSnapshotAfterSha256:snapshot.sha256};
    const receipt={...base,kind:'public',language:'javascript',path:'src/index.cjs',performed:true,checkedSource:{sha256:hash,bytes},sourceAtomic:false,sourceBinding:'fixture',
      nativeResult:{success:!timeout&&!failed,contentItems:[{type:'inputText',text:JSON.stringify(base)}]}};
    return add('relay_code',{action:'check',language:'javascript',path:'src/index.cjs',check:'public',expectedHash:hash},
      {...receipt,action:'check',check:{kind:'public',performed:true,passed:!timeout&&!failed,receipt},source:{before:{sha256:hash,bytes},after:{sha256:hash,bytes},unchanged:true}},{success:!timeout&&!failed});
  }
  f.command=command;
  if(!noCheck){
    add('relay_skills',{action:'search',query:'modular development'},{entries:[{id:'library-modular-development',title:'Modular Development'}],totalMatches:1,truncated:false});
    add('relay_skills',{action:'read',id:'library-modular-development'},{entry:{id:'library-modular-development',title:'Modular Development',content:'Synthetic method text. No private fixture data.'}});
    if(timeoutFirst)command({hash:sha(initial),bytes:initial.length,snapshot:initialSnapshot,timeout:true});
    const saved={path:sourcePath,bytesWritten:Buffer.byteLength(source),atomic:true,beforeHash:sha(initial),sha256:sourceHash,readbackVerified:true,actionDispatched:true};
    f.save=add('relay_code',{action:'save',language:'javascript',path:'src/index.cjs',format:'raw',code:source,expectedHash:sha(initial)},
      {...saved,action:'save',language:'javascript',format:'raw',saved:true,sourceSha256:sourceHash,sourceBytes:Buffer.byteLength(source),
        readback:{verified:true,sha256:sourceHash,bytes:Buffer.byteLength(source),receipt:{path:sourcePath,size:Buffer.byteLength(source),sha256:sourceHash,contentOmitted:true}},checks:{performed:false},saveReceipt:saved});
    f.finalCall=command({failed:finalFailure});ledger.actions[0].observation.receipts=[ledger.receipts.at(-1).id];
  }else{
    run.skillLoadReceipts=[];run.planningModuleReceipts=[];ledger.actions=[];
  }
  f.build=()=>build(f);await f.build();return f;
}
async function build(f){
  const {state,run,ledger,calls}=f;
  const events=[{type:'runtime.status',data:{},at:'2026-11-22T02:59:59.000Z'},
    {type:'run.created',runId:run.id,at:run.createdAt,data:{id:run.id}}];
  calls.forEach((call,i)=>{
    events.push({type:'agent.event',runId:run.id,nodeId:'agent',at:at(i+1),data:{type:'directory.effect',phase:'returned',callId:call.id,tool:call.tool,operation:call.arguments?.action,receiptId:ledger.receipts[i].id,receiptActionId:'implement',success:call.success}});
    events.push({type:'agent.event',runId:run.id,nodeId:'agent',at:at(i+1),data:{type:'item',stage:'completed',threadId:run.nodes.agent.threadId,turnId:'turn-main',item:structuredClone(call)}});
  });
  events.push({type:'run.updated',runId:run.id,at:run.finishedAt,data:{id:run.id,status:run.status,settled:true}});
  f.events=events;run.events=structuredClone(events.filter(e=>e.runId===run.id));
  let delivered=calls;if(f.omitEarlierDelivery)delivered=calls.filter(c=>c===f.finalCall);if(f.omitFinalDelivery)delivered=delivered.filter(c=>c!==f.finalCall);
  run.toolContinuity={version:1,sequence:calls.length,omittedRecords:calls.length-delivered.length,records:delivered.map((call,i)=>({
    runId:run.id,taskId:run.taskId,nodeId:'agent',callId:call.id,tool:call.tool,action:call.arguments?.action,sequence:i+1,
    delivery:'local-stream-write-not-provider-consumption',resultTextSha256:sha(textOf(call)),text:textOf(call),sourceChars:textOf(call).length,retainedChars:textOf(call).length,omittedChars:0,partial:false,success:call.success}))};
  const capture={schema:control.SCHEMA+'.capture',at:'2026-11-22T03:01:02.000Z',launchRef:f.launchRef,requestRef:state.requestRef,run,errors:[],
    ledger:{runId:run.id,taskId:run.taskId,state:ledger,final:{ready:true,reason:'ready',pending:[],blocked:[],focus:null,unknown:[]}},
    machine:{runId:run.id,taskId:run.taskId,terminal:{status:run.status,settled:true},coverage:{source:'maximal-host-envelopes',dropped:0,gaps:[],entryMetadataOmitted:0}},
    receiptPages:Object.fromEntries(['context','tools','decisions'].map(k=>[k,{pages:[],complete:true}]))};
  f.capture=capture;state.collectionRef=write(path.join(state.attemptDir,'records','collection-fixture.json'),capture);write(f.statePath,state);
  fs.mkdirSync(f.captureDir,{recursive:true});
  const captureId='capture-fixture',coverage={scope:'received-original-SSE-bytes-and-events',reconnects:0,serverSequenceAvailable:false,missingEventDetection:'transport-and-parser-only-no-server-sequence-or-replay',providerConsumptionProven:false,localDeliveryRequiresContinuityJoin:true,runSettlementProven:false};
  const raw=events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('');
  fs.writeFileSync(path.join(f.captureDir,'stream.sse'),raw);
  fs.writeFileSync(path.join(f.captureDir,'events.jsonl'),events.map((event,i)=>JSON.stringify({sequence:i+1,receivedAt:'2026-11-22T03:01:01.000Z',jsonSha256:sha(JSON.stringify(event)),event})+'\n').join(''));
  const shared={schema:'blackice.minicpm.event-capture.v1',captureId,appFingerprint:state.appFingerprint,launchRef:f.launchRef};
  write(path.join(f.captureDir,'manifest.json'),{...shared,startedAt:'2026-11-22T02:59:58.000Z',candidateRoot,profileDir:state.profileDir,preparation:f.preparedRef,origin:'http://127.0.0.1:61480',workspaceRoots:[state.workspace],
    sources:[ref(path.join(candidateRoot,'verification','minicpm-agent-tools-v2','capture-events.cjs')),ref(path.join(candidateRoot,'verification','minicpm-agent-tools-v2','native-control.cjs'))],coverage});
  write(path.join(f.captureDir,'ready.json'),{...shared,status:'ready',readyAt:'2026-11-22T02:59:59.000Z',coverage});
  f.finalPath=path.join(f.captureDir,'final.json');
  write(f.finalPath,{...shared,status:'stopped',startedAt:'2026-11-22T02:59:58.000Z',finishedAt:'2026-11-22T03:01:03.000Z',ready:true,readyAt:'2026-11-22T02:59:59.000Z',eventCount:events.length,rawBytes:Buffer.byteLength(raw),transportClosed:true,
    stop:{requestedAt:'2026-11-22T03:01:02.000Z',observedAt:'2026-11-22T03:01:03.000Z',reason:'fixture-owner'},error:null,
    artifacts:{raw:ref(path.join(f.captureDir,'stream.sse')),events:ref(path.join(f.captureDir,'events.jsonl'))},coverage});
  if(f.route==='compatible'){
    const traceRoot=path.join(path.dirname(state.scaffoldRef.path),'provider-traces',run.id,'agent');fs.rmSync(traceRoot,{recursive:true,force:true});
    const [providerId,model]=state.model.split('::'),messages=[{role:'system',content:'Synthetic transport fixture.'},{role:'user',content:f.request.input.task}];
    for(const call of calls)messages.push({role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.tool,arguments:JSON.stringify(call.arguments)}}]},
      {role:'tool',tool_call_id:call.id,content:textOf(call)});
    const tools=['relay_code','relay_skills','relay_workspace','relay_directory_action'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
    const trace=createBenchmarkExchangeTrace({context:{schema:'blackice.minicpm.provider-trace-context.v1',directory:traceRoot,workspace:state.workspace,runId:run.id,taskId:run.taskId,nodeId:'agent',clientRequestId:state.requestId},
      threadId:run.nodes.agent.threadId,turnId:'turn-main',messageId:'message-main',providerId,model,providerType:'compatible',target:'http://127.0.0.1:61000/v1/chat/completions',serializedBody:JSON.stringify({model,messages,tools,stream:true})});
    const body=JSON.stringify({model,messages,tools,stream:true});trace.beginAttempt(body);trace.observeHTTP({status:200,headers:{get:()=>null}});
    trace.appendResponse(Buffer.from('data: {"choices":[]}\n\ndata: [DONE]\n\n'));trace.terminal('done-marker');trace.finishAttempt({outcome:'accepted'});trace.finishSemantic({success:true,result:{termination:{providerFinishReason:'stop'}}});
    f.traceRoot=traceRoot;
  }
}
function editBody(call,fn){const body=JSON.parse(call.contentItems[0].text);fn(body);call.contentItems[0].text=JSON.stringify(body);}
async function prepare(f,{archive=f.route==='native',label='proof'}={}){
  return verifier.prepareExecutionEvidence({statePath:f.statePath,evidenceDir:path.join(f.state.attemptDir,'records',label),...(archive?{eventCaptureFinalPath:f.finalPath}:{})});
}
async function hook(f,result){const state=read(f.statePath),capture=read(state.collectionRef.path),execution=read(result.executionRef.path);return verifier.verifyExecutionEvidence({state,capture,execution,executionRef:result.executionRef});}

test('native original SSE, Directory receipt and exact local-delivery hash prove Unicode saved bytes',async t=>{
  const f=await fixture(t),result=await prepare(f);
  assert.equal(result.scoringEligible,true,JSON.stringify(result.missing));assert.equal(result.finalPublicVerified,true);assert.equal(result.methodCompliant,true);
  const proof=await hook(f,result);assert.equal(proof.verified,true);assert.equal(proof.workflowVerified,true);assert.equal(proof.providerConsumptionProven,false);
  assert.equal(read(result.sourceSnapshotRef.path).sha256,f.finalSnapshot.sha256);
  assert.equal(fs.readFileSync(f.sourcePath,'utf8'),correctSource);assert.ok(proof.sourceRefs.every(r=>!r.path.startsWith(f.state.workspace+path.sep)));
  const grade=await control.grade(f.statePath,{executionReceiptPath:result.executionRef.path},{verifyExecutionEvidence:verifier.verifyExecutionEvidence});
  assert.equal(grade.gradeStatus,'graded');assert.equal(grade.grade.scored,false);assert.equal(grade.grade.semanticPass,true);assert.equal(grade.grade.finalPublicVerified,true);
});
test('compatible proof comes from actual serialized accepted-request trace files',async t=>{
  const f=await fixture(t,{route:'compatible'}),result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.equal(result.finalPublicVerified,true);
  const proof=await hook(f,result);assert.equal(proof.verified,true);
  const execution=read(result.executionRef.path);assert.equal(execution.actions.commands[0].delivery,'accepted-compatible-request');
  assert.ok(proof.sourceRefs.some(r=>r.path.endsWith('request.json')&&r.path.includes('provider-traces')));
  assert.ok(proof.sourceRefs.some(r=>r.path.endsWith('-response.bin')));
});
test('timeout then repair/pass retains both terminal check receipts',async t=>{
  const f=await fixture(t,{timeoutFirst:true}),result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.equal(result.failedPublicCommandCount,1);assert.equal(result.publicCommandCount,2);assert.equal(result.finalPublicVerified,true);
  const commands=read(result.executionRef.path).actions.commands;assert.equal(commands[0].exitCode,null);assert.equal(commands[0].timedOut,true);assert.equal(commands[0].report,undefined);assert.equal(commands[1].exitCode,0);
  assert.equal((await hook(f,result)).verified,true);
});
test('known final failure stays gradeable without claiming final public verification',async t=>{
  const f=await fixture(t,{finalFailure:true}),result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.equal(result.finalPublicVerified,false);assert.equal(result.failedPublicCommandCount,1);
  const grade=await control.grade(f.statePath,{executionReceiptPath:result.executionRef.path},{verifyExecutionEvidence:verifier.verifyExecutionEvidence});
  assert.equal(grade.gradeStatus,'graded');assert.equal(grade.grade.semanticPass,false);assert.equal(grade.grade.finalPublicVerified,false);
});
test('cancelled no-dispatch attempt remains unscored integration and has no invented check',async t=>{
  const f=await fixture(t,{noCheck:true}),result=await prepare(f);
  assert.equal(result.scoringEligible,false);assert.equal(result.executionRef,null);assert.equal(result.publicCommandCount,0);assert.ok(result.missing.includes('NO_DISPATCHED_PUBLIC_CHECK'));
  assert.equal(fs.existsSync(path.join(f.state.attemptDir,'records','proof','execution.json')),false);
});
test('earlier optional continuity eviction is coverage only when final check joins',async t=>{
  const f=await fixture(t,{omitEarlierDelivery:true}),result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.ok(result.coverage.optionalEarlierDeliveryGaps.length>=3);
  assert.equal(result.skills.modularContextSubmitted,true);assert.equal(result.skills.modularLoadReceipt,true);assert.equal(result.skills.modularReadDeliveryJoined,false);
  assert.equal((await hook(f,result)).verified,true);
});
test('missing final local-delivery join blocks verification even with a successful SSE result',async t=>{
  const f=await fixture(t);f.omitFinalDelivery=true;await f.build();const result=await prepare(f);
  assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
});
test('submitted skill context is distinct from loaded/read/delivered method compliance',async t=>{
  const f=await fixture(t);f.run.skillLoadReceipts=f.run.skillLoadReceipts.filter(r=>r.type!=='skill_loaded');await f.build();const result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.equal(result.skills.modularContextSubmitted,true);assert.equal(result.skills.modularLoadReceipt,false);assert.equal(result.methodCompliant,false);assert.equal(result.providerConsumptionProven,false);
});
test('a missing replacement guard is method noncompliance while a conflicting guard is invalid evidence',async t=>{
  const f=await fixture(t);delete f.save.arguments.expectedHash;await f.build();const missing=await prepare(f);
  assert.equal(missing.scoringEligible,true);assert.equal(missing.methodCompliant,false);
  f.save.arguments.expectedHash='0'.repeat(64);await f.build();const conflict=await prepare(f,{label:'conflict'});
  assert.equal(conflict.scoringEligible,false);assert.ok(conflict.missing.includes('SAVE_GUARD_CONFLICT'));
});
test('save byte readback and frozen immutable fixture changes fail closed',async t=>{
  const f=await fixture(t);editBody(f.save,b=>{b.readback.sha256='0'.repeat(64);});await f.build();const badSave=await prepare(f);
  assert.ok(badSave.missing.includes('SAVE_READBACK'));
  fs.appendFileSync(path.join(f.state.workspace,'TASK.md'),'changed');const badFixture=await prepare(f,{label:'fixture-drift'});
  assert.ok(badFixture.missing.includes('IMMUTABLE_FIXTURE_CHANGED'));
});
test('final source mutation after last actual check is unavailable',async t=>{
  const f=await fixture(t);fs.appendFileSync(f.sourcePath,'// later edit\n');const result=await prepare(f);
  assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('FINAL_SOURCE_SNAPSHOT_MISMATCH'));assert.ok(result.missing.includes('FINAL_SOURCE_IDENTITY_MISMATCH'));
});
test('the hook rechecks raw evidence and rejects edited execution or snapshot receipts',async t=>{
  const f=await fixture(t),result=await prepare(f),execution=read(result.executionRef.path);execution.actions.commands[0].exitCode=9;write(result.executionRef.path,execution);
  await assert.rejects(hook(f,result),{code:'EVIDENCE_CHANGED'});
});
test('wrong run/thread/Directory joins and conflicting repeated call IDs are rejected',async t=>{
  const f=await fixture(t);f.ledger.receipts.at(-1).runId='foreign-run';await f.build();const wrong=await prepare(f);
  assert.ok(wrong.missing.includes('DIRECTORY_RECEIPT_IDENTITY'));
  f.ledger.receipts.at(-1).runId=f.run.id;
  const duplicate=structuredClone(f.finalCall);duplicate.arguments.path='src/foreign.cjs';f.calls.push(duplicate);f.ledger.receipts.push({...f.ledger.receipts.at(-1),id:'receipt-99'});await f.build();
  const conflict=await prepare(f,{label:'duplicate'});assert.ok(conflict.missing.includes('TOOL_CALL_CONFLICT'));
});
test('truncated raw capture is rejected without a JSON reserialization shortcut',async t=>{
  const f=await fixture(t),final=read(f.finalPath),raw=fs.readFileSync(final.artifacts.raw.path);
  fs.writeFileSync(final.artifacts.raw.path,raw.subarray(0,-1));final.artifacts.raw=ref(final.artifacts.raw.path);final.rawBytes=final.artifacts.raw.bytes;write(f.finalPath,final);
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('SSE_TRUNCATED'));
});
test('unknown command execution stays unavailable; safe summaries exclude result values',async t=>{
  const f=await fixture(t);editBody(f.finalCall,b=>{
    b.check.receipt.exitCode=null;b.check.receipt.timedOut=false;b.check.receipt.signal=null;
    b.check.receipt.stdout='PRIVATE_FIXTURE_VALUE_MUST_NOT_BE_PRINTED';
  });await f.build();const result=await prepare(f);
  assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('PUBLIC_TERMINAL_UNKNOWN'));assert.ok(!JSON.stringify(result).includes('PRIVATE_FIXTURE_VALUE'));
});

test('settled Directory final-review failure preserves saved-artifact grading',async t=>{
  const f=await fixture(t);f.run.status='failed';f.run.nodes.agent.status='failed';f.run.output='';
  f.ledger.actions[0].state='active';delete f.ledger.actions[0].observation;await f.build();
  f.capture.ledger.final={ready:false,reason:'pending-actions',pending:['implement'],blocked:[],focus:'implement',unknown:[]};
  f.state.collectionRef=write(f.state.collectionRef.path,f.capture);write(f.statePath,f.state);
  const result=await prepare(f);
  assert.equal(result.scoringEligible,true,JSON.stringify(result.missing));assert.equal(result.workflowComplete,false);assert.equal(result.finalPublicVerified,true);
  const execution=read(result.executionRef.path);assert.equal(execution.run.status,'failed');assert.equal(execution.completion.agentCompleted,false);
  const grade=await control.grade(f.statePath,{executionReceiptPath:result.executionRef.path},{verifyExecutionEvidence:verifier.verifyExecutionEvidence});
  assert.equal(grade.gradeStatus,'graded');assert.equal(grade.grade.semanticPass,true);assert.equal(grade.grade.finalPublicVerified,true);
});
