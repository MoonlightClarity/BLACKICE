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
const verifier=require('../verification/minicpm-agent-tools-v2/verify-execution-v2.cjs');
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
globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN_IN_BC5_TEST');};

async function fixture(t,{route='native',timeoutFirst=false,finalFailure=false,noCheck=false,omitEarlierDelivery=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-bc5-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
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
  if(f.witnesses)for(const call of calls.filter(c=>f.witnesses==='all'||c===f.finalCall)) {
    const text=textOf(call);
    events.push({type:'agent.event',runId:run.id,nodeId:'agent',at:at(calls.length+1),data:{
      type:'tool.result.delivered',schema:'blackice.native-tool-delivery.v1',runId:run.id,taskId:run.taskId,nodeId:'agent',callId:call.id,tool:call.tool,
      resultTextSha256:sha(text),sourceChars:text.length,delivery:'local-stream-write-not-provider-consumption',
      textProjection:'inputText-joined-with-newline',sensitiveContentOmitted:false,
      binaryItemsOmitted:call.contentItems.filter(item=>item?.type!=='inputText').length}});
  }
  events.push({type:'run.updated',runId:run.id,at:run.finishedAt,data:{id:run.id,status:run.status,settled:true}});
  f.mutateEvents?.(events);
  f.events=events;run.events=structuredClone(events.filter(e=>e.runId===run.id));
  let delivered=calls;if(f.omitEarlierDelivery)delivered=calls.filter(c=>c===f.finalCall);if(f.omitFinalDelivery)delivered=delivered.filter(c=>c!==f.finalCall);
  run.toolContinuity={version:1,sequence:calls.length,omittedRecords:calls.length-delivered.length,records:delivered.map((call,i)=>({
    runId:run.id,taskId:run.taskId,nodeId:'agent',callId:call.id,tool:call.tool,action:call.arguments?.action,sequence:i+1,
    delivery:'local-stream-write-not-provider-consumption',resultTextSha256:sha(textOf(call)),text:textOf(call),sourceChars:textOf(call).length,retainedChars:textOf(call).length,omittedChars:0,partial:false,success:call.success}))};
  f.mutateContinuity?.(run.toolContinuity);
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


const deliveryEvent=(events,callId)=>events.find(e=>e.data?.type==='tool.result.delivered'&&e.data.callId===callId);
const returnedEvent=(events,callId)=>events.find(e=>e.data?.type==='directory.effect'&&e.data.phase==='returned'&&e.data.callId===callId);
const completedEvent=(events,callId)=>events.find(e=>e.data?.type==='item'&&e.data.item?.id===callId);
async function witnessed(t,options={}) {
  const f=await fixture(t,options);f.witnesses='final';f.omitFinalDelivery=true;await f.build();return f;
}

test('versioned witness proves an evicted final result while preserving exact Unicode and joined text',async t=>{
  const f=await witnessed(t,{omitEarlierDelivery:true});
  f.finalCall.contentItems[0].text=JSON.stringify({...JSON.parse(f.finalCall.contentItems[0].text),diagnostic:'👩🏽‍💻 e\u0301'});
  await f.build();const result=await prepare(f);
  assert.equal(result.schema,'blackice.minicpm.execution-evidence.v2');
  assert.equal(result.scoringEligible,true,JSON.stringify(result.missing));assert.equal(result.finalPublicVerified,true);
  assert.equal(result.methodCompliant,true);assert.ok(result.coverage.optionalEarlierDeliveryGaps.length>=3);
  const report=read(result.reportRef.path),detail=report.toolResults.find(c=>c.callId===f.finalCall.id),w=detail.delivery.nativeWitness;
  assert.equal(detail.delivery.resultTextSha256,sha(textOf(f.finalCall)));assert.equal(w.sourceChars,textOf(f.finalCall).length);
  assert.notEqual(w.sourceChars,Buffer.byteLength(textOf(f.finalCall)));assert.equal(w.binaryItemsOmitted,0);
  assert.ok(w.sequence>w.returnedSequence);assert.equal(w.textProjection,'inputText-joined-with-newline');
  assert.equal(w.delivery,'local-stream-write-not-provider-consumption');assert.equal(detail.delivery.providerConsumptionProven,false);
  assert.equal((await hook(f,result)).verified,true);
  assert.equal(fs.readFileSync(f.sourcePath,'utf8'),correctSource);
  const grade=await control.grade(f.statePath,{executionReceiptPath:result.executionRef.path},{verifyExecutionEvidence:verifier.verifyExecutionEvidence});
  assert.equal(grade.gradeStatus,'graded');assert.equal(grade.grade.semanticPass,true);assert.equal(grade.grade.scored,false);
});
test('retained continuity still proves old native evidence without a new event',async t=>{
  const f=await fixture(t),result=await prepare(f);assert.equal(result.scoringEligible,true);
  const detail=read(result.reportRef.path).toolResults.find(c=>c.callId===f.finalCall.id);
  assert.ok(detail.delivery.continuitySequence);assert.equal(detail.delivery.nativeWitness,undefined);
  assert.equal((await hook(f,result)).verified,true);
});
test('a missing final witness and evicted continuity remain unavailable',async t=>{
  const f=await witnessed(t);f.witnesses=null;await f.build();const result=await prepare(f);
  assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
});

const invalidWitnesses=[
  ['envelope run',e=>{e.runId='foreign';}],['payload run',e=>{e.data.runId='foreign';}],
  ['task',e=>{e.data.taskId='foreign';}],['envelope node',e=>{e.nodeId='foreign';}],['payload node',e=>{e.data.nodeId='foreign';}],
  ['call',e=>{e.data.callId='foreign';}],['tool',e=>{e.data.tool='relay_workspace';}],
  ['hash',e=>{e.data.resultTextSha256='0'.repeat(64);}],['length',e=>{e.data.sourceChars++;}],
  ['schema',e=>{e.data.schema='blackice.native-tool-delivery.v0';}],['projection',e=>{e.data.textProjection='some-text';}],
  ['consumption claim',e=>{e.data.delivery='provider-consumed';}],['missing field',e=>{delete e.data.taskId;}],
  ['binary flag type',e=>{e.data.binaryItemsOmitted=false;}],['sensitive flag type',e=>{e.data.sensitiveContentOmitted=0;}],
  ['omission mismatch',e=>{e.data.binaryItemsOmitted=1;}],['negative length',e=>{e.data.sourceChars=-1;}],
];
for(const [name,mutate]of invalidWitnesses)test('target witness rejects '+name,async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>mutate(deliveryEvent(events,f.finalCall.id));await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.equal(result.executionRef,undefined);
  assert.ok(result.missing.some(code=>code.startsWith('NATIVE_DELIVERY_')),JSON.stringify(result.missing));
});
test('unrelated traffic cannot substitute for the final witness',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>{const e=deliveryEvent(events,f.finalCall.id);e.runId=e.data.runId=e.data.taskId='other-run';};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
});
test('pre-return event is rejected even when the result later completes',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>{const e=deliveryEvent(events,f.finalCall.id);events.splice(events.indexOf(e),1);events.splice(events.indexOf(returnedEvent(events,f.finalCall.id)),0,e);};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('NATIVE_DELIVERY_PRE_RETURN'));
});
test('post-return event may precede the independent full completion notification',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>{const e=deliveryEvent(events,f.finalCall.id);events.splice(events.indexOf(e),1);events.splice(events.indexOf(returnedEvent(events,f.finalCall.id))+1,0,e);};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,true,JSON.stringify(result.missing));assert.equal((await hook(f,result)).verified,true);
});
test('identical duplicate witnesses deduplicate and conflicting duplicates fail',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>events.push(structuredClone(deliveryEvent(events,f.finalCall.id)));await f.build();
  const good=await prepare(f);assert.equal(good.scoringEligible,true);assert.equal((await hook(f,good)).verified,true);
  f.mutateEvents=events=>{const e=structuredClone(deliveryEvent(events,f.finalCall.id));e.data.sourceChars++;events.push(e);};await f.build();
  const bad=await prepare(f,{label:'conflict'});assert.equal(bad.scoringEligible,false);assert.ok(bad.missing.includes('NATIVE_DELIVERY_CONFLICT'));
});
test('witness cannot override conflicting retained continuity',async t=>{
  const f=await witnessed(t);f.omitFinalDelivery=false;f.mutateContinuity=c=>{c.records.find(r=>r.callId===f.finalCall.id).resultTextSha256='0'.repeat(64);};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('NATIVE_DELIVERY_CONTINUITY_CONFLICT'));
});
test('hash-only witness without the full result is unavailable',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>{const e=completedEvent(events,f.finalCall.id);events.splice(events.indexOf(e),1);};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('NATIVE_DELIVERY_RESULT_UNAVAILABLE'));
});
test('truncated result cannot satisfy a complete text witness',async t=>{
  const f=await witnessed(t);f.mutateEvents=events=>{completedEvent(events,f.finalCall.id).data.item.contentItems[0].text='truncated';};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('NATIVE_DELIVERY_RESULT_MISMATCH'));
});
test('redacted and binary witnesses never establish final public text delivery',async t=>{
  const redacted=await witnessed(t);redacted.mutateEvents=events=>{const d=deliveryEvent(events,redacted.finalCall.id).data;d.sensitiveContentOmitted=true;d.resultTextSha256=null;d.sourceChars=null;};await redacted.build();
  const r=await prepare(redacted);assert.equal(r.scoringEligible,false);assert.ok(r.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
  const binary=await witnessed(t);binary.finalCall.contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,fixture'});await binary.build();
  const b=await prepare(binary);assert.equal(b.scoringEligible,false);assert.ok(b.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
});
test('a malformed non-string text item cannot be silently omitted from proof',async t=>{
  const f=await witnessed(t);f.finalCall.contentItems.push({type:'inputText',text:null});
  // DE1 follows the existing projection and excludes non-string text.
  f.witnesses=null;await f.build();
  f.mutateEvents=events=>{const value=f.finalCall.contentItems.filter(x=>x?.type==='inputText'&&typeof x.text==='string').map(x=>x.text).join('\n');events.push({type:'agent.event',runId:f.run.id,nodeId:'agent',data:{type:'tool.result.delivered',schema:'blackice.native-tool-delivery.v1',runId:f.run.id,taskId:f.run.taskId,nodeId:'agent',callId:f.finalCall.id,tool:f.finalCall.tool,resultTextSha256:sha(value),sourceChars:value.length,delivery:'local-stream-write-not-provider-consumption',textProjection:'inputText-joined-with-newline',sensitiveContentOmitted:false,binaryItemsOmitted:0}});};await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,false);assert.ok(result.missing.includes('FINAL_CHECK_DELIVERY_UNAVAILABLE'));
});
test('optional control-tool events without host receipts do not replace protected proof',async t=>{
  const f=await witnessed(t,{omitEarlierDelivery:true});const call=f.calls[0];call.tool='relay_directory_action';call.arguments={action:'list'};call.contentItems=call.contentItems.slice(0,1);f.ledger.receipts[0].tool=call.tool;f.witnesses='all';await f.build();
  const result=await prepare(f);assert.equal(result.scoringEligible,true,JSON.stringify(result.missing));
  const detail=read(result.reportRef.path).toolResults.find(c=>c.callId===call.id);assert.equal(detail.delivery,null);assert.equal(detail.deliveryWitnessCoverage.code,'NATIVE_DELIVERY_PROTECTED_RECEIPT_UNAVAILABLE');
});
test('timeout then repair and known final failure retain artifact-scoring semantics',async t=>{
  const f=await witnessed(t,{timeoutFirst:true,omitEarlierDelivery:true});const result=await prepare(f);
  assert.equal(result.scoringEligible,true);assert.equal(result.failedPublicCommandCount,1);assert.equal(result.publicCommandCount,2);assert.equal(result.finalPublicVerified,true);assert.equal((await hook(f,result)).verified,true);
  const failed=await witnessed(t,{finalFailure:true});const final=await prepare(failed);assert.equal(final.scoringEligible,true);assert.equal(final.finalPublicVerified,false);assert.equal((await hook(failed,final)).verified,true);
});
test('compatible proof still uses accepted request traces and ignores native witnesses',async t=>{
  const f=await witnessed(t,{route:'compatible'});f.mutateEvents=events=>{deliveryEvent(events,f.finalCall.id).data.resultTextSha256='0'.repeat(64);};await f.build();
  const result=await prepare(f,{archive:true});assert.equal(result.scoringEligible,true);assert.equal((await hook(f,result)).verified,true);
  const detail=read(result.reportRef.path).toolResults.find(c=>c.callId===f.finalCall.id);assert.equal(detail.delivery.kind,'accepted-compatible-request');assert.equal(detail.delivery.nativeWitness,undefined);
});
test('hook rechecks exact raw witness bytes and the actual execution receipt',async t=>{
  const f=await witnessed(t),result=await prepare(f);assert.equal(result.scoringEligible,true);
  const raw=path.join(f.captureDir,'stream.sse'),before=fs.readFileSync(raw);fs.appendFileSync(raw,'\n');
  await assert.rejects(hook(f,result));fs.writeFileSync(raw,before);
  const receipt=read(result.executionRef.path);receipt.actions.commands[0].exitCode=123;write(result.executionRef.path,receipt);await assert.rejects(hook(f,result));
});
