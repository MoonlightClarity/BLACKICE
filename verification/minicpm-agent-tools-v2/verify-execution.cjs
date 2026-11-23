'use strict';
// BC4 is offline. Importing or running it never opens an app, calls an API,
// starts a model, executes submitted source, or evaluates private test cases.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const {pathToFileURL} = require('node:url');
const control = require('./native-control.cjs');
const SCHEMA = 'blackice.minicpm.execution-evidence.v1';
const EXECUTION_SCHEMA = 'blackice.minicpm.agentic-execution-receipt.v1';
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_PINS = Object.freeze({
  'verification/minicpm-agent-tools-v2/native-control.cjs': 'eb3330ece0388278dbcdee11e1530f2c955d2be65350fcf1a3e3e8eb2c1e2b5c',
  'verification/minicpm-agent-tools-v2/capture-events.cjs': '7eac9bf2ece62d33f22dea2d935987f5348b6c45925f8890462cb8a80338ff67',
  'lib/provider-tool-delivery.mjs': '2b80ce2894418b8c04b92630f784e4174b60b9887dbc4ad818aac35c8234ea7a',
  'lib/provider-exchange-trace.mjs': 'dd52ea2dd66958b5e4abc58850a6017297830bcb8e62b381b2c59f49d5f409a9',
  'lib/code-block-tool.mjs': '7157216a414ec895b24f5c78f6ff68e31368aef7ae312edc690136847200b5c4',
  'lib/code-check-adapters.mjs': '42fef5ab43340df47bf4fec450322c14ef87bc61073a0dc7f6c39f2f1586ba25',
  'lib/benchmark-workspace.mjs': '39bf63a5e88def1dfb1a5fe04c23b29da9677d1825fd21611384a415bb5147fd',
  'lib/conversation-tool-continuity.mjs': '3e6508d918570338500597debfe9725c4b1f5b7030e788e6a25f0f4416c57450',
  'lib/directory-control-telemetry.mjs': '92183223f779ddb1f7d34cf20c381ba85617942b9b64085dd5879458d1fb4dab',
  'lib/task-action-directory.mjs': '12dbf8db6ab3183e35bc54775d6f242ff07851c823451f993e1afb79c9e8abea',
});
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root,file) => { const rel=path.relative(path.resolve(root),path.resolve(file)); return rel==='' || (!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)); };
const absolute = value => { check(typeof value==='string'&&path.isAbsolute(value),'EVIDENCE_PATH'); return path.resolve(value); };
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const parse = value => { try { return typeof value==='string'?JSON.parse(value):value; } catch { return null; } };
const textOf = result => (result?.contentItems||[]).filter(x=>x?.type==='inputText'&&typeof x.text==='string').map(x=>x.text).join('\n');
const publicCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:'EVIDENCE_INVALID';
function fail(code) { throw Object.assign(new Error(code),{code}); }
function check(value,code) { if(!value)fail(code); }
function fileRef(file) {
  file=absolute(file);const st=fs.lstatSync(file);
  check(st.isFile()&&!st.isSymbolicLink(),'EVIDENCE_FILE');
  const fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024),hash=createHash('sha256');let bytes=0;
  try { for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;hash.update(buffer.subarray(0,count));bytes+=count;} }
  finally {fs.closeSync(fd);}
  return {path:file,bytes,sha256:hash.digest('hex')};
}
function verifyRef(value) {
  check(object(value)&&HASH.test(value.sha256||''),'EVIDENCE_PIN');const actual=fileRef(value.path);
  check(actual.sha256===value.sha256&&(value.bytes===undefined||actual.bytes===value.bytes),'EVIDENCE_CHANGED');return actual;
}
function writeNew(file,value) {
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx');
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const ref=fileRef(file);check(ref.sha256===sha(bytes),'EVIDENCE_WRITE_READBACK');return ref;
}
function scopeFile(state,file) {
  const root=fs.realpathSync(state.workspace),actual=fs.realpathSync(absolute(file));
  check(!inside(root,actual),'EVIDENCE_INSIDE_WORKSPACE');return actual;
}
function sourcePath(state,relative) {
  check(typeof relative==='string'&&relative.length>0,'SOURCE_PATH');
  const file=path.resolve(state.workspace,relative);check(inside(path.join(state.workspace,'src'),file)&&file.endsWith('.cjs'),'SOURCE_SCOPE');
  if(fs.existsSync(file))check(inside(fs.realpathSync(path.join(state.workspace,'src')),fs.realpathSync(file)),'SOURCE_SCOPE');
  return file;
}
function identity(state) {
  const keys=['schema','attemptDir','workspace','caseId','model','candidateRoot','profileDir','appFingerprint','requestId','workflowId','runId','preparation','requestRef','scaffoldRef','methodRef','launchRef','collectionRef','sources'];
  return Object.fromEntries(keys.map(key=>[key,state[key]??null]));
}
function bindState(state,capture,refs) {
  check(state.schema===control.SCHEMA&&object(capture)&&capture.schema===control.SCHEMA+'.capture','STATE_SCHEMA');
  const add=value=>{const ref=verifyRef(value);scopeFile(state,ref.path);refs.set(ref.path.toLowerCase(),ref);return ref;};
  for(const ref of [state.preparation,state.requestRef,state.scaffoldRef,state.collectionRef,...(state.sources||[])])add(ref);
  if(state.methodRef)add(state.methodRef);
  const launchRef=add(capture.launchRef),launch=read(launchRef.path),prepared=read(state.preparation.path);
  check(launch.schema==='blackice.native-candidate-launch.v1'&&launch.status==='ready'&&same(launch.profileDir,state.profileDir)&&same(launch.candidateRoot,state.candidateRoot)&&launch.appFingerprint===state.appFingerprint,'LAUNCH_IDENTITY');
  check(prepared.schema==='blackice.native-candidate-preparation.v1'&&prepared.status==='prepared'&&same(prepared.profileDir,state.profileDir)&&same(prepared.candidateRoot,state.candidateRoot),'PREPARATION_IDENTITY');
  if(state.launchRef)check(isDeepStrictEqual(verifyRef(state.launchRef),launchRef),'LAUNCH_IDENTITY');
  const request=read(state.requestRef.path),run=capture.run,nodes=run?.workflow?.nodes?.filter(n=>n.type==='agent')||[];
  check(request.requestId===state.requestId&&request.workflow?.id===state.workflowId&&run?.id===state.runId&&run.taskId===run.id&&!run.parentRunId&&!run.retryOf,'FRESH_TASK_IDENTITY');
  check(run.metadata?.clientRequestId===state.requestId&&run.workflow?.id===state.workflowId&&run.input===request.input?.task?.trim()&&same(run.cwd,state.workspace)&&nodes.length===1&&nodes[0].model===state.model,'RUN_IDENTITY');
  check(run.benchmark?.profile===control.PROFILE&&run.benchmark.caseId===state.caseId&&same(run.benchmark.scaffoldReceiptPath,state.scaffoldRef.path)&&run.benchmark.scaffoldReceiptSha256===state.scaffoldRef.sha256,'BENCHMARK_IDENTITY');
  check(request.input.chatPlanning==='on'&&request.input.directoryActions==='on'&&request.input.pastChats==='off'&&run.chatPlanning==='on'&&run.directoryActions==='on'&&run.pastChats==='off','RUN_MODES');
  check(Object.values(run.nodes||{}).every(n=>!n.resumeThreadId&&!n.reused),'FRESH_THREAD_IDENTITY');
  check(['completed','failed','cancelled','blocked'].includes(run.status)&&run.settled===true,'RUN_UNSETTLED');
  check(control.checkCapture(capture).length===0,'COLLECTION_INCOMPLETE');
  check(capture.requestRef?.sha256===state.requestRef.sha256&&same(capture.requestRef.path,state.requestRef.path),'COLLECTION_IDENTITY');
  check(capture.ledger?.state?.taskId===run.taskId&&Array.isArray(capture.ledger.state.receipts)&&Array.isArray(capture.ledger.state.actions),'DIRECTORY_IDENTITY');
  const agentId=nodes[0].id,node=run.nodes?.[agentId];
  check(node&&['native-codex-receipts','compatible-provider-trace'].includes(node.benchmarkEvidenceMode),'PROVIDER_EVIDENCE_MODE');
  return {add,request,run,agentId,node,launchRef};
}
function bindDependencies(state,add) {
  for(const [name,pin]of Object.entries(SOURCE_PINS))add({path:path.join(state.candidateRoot,name),sha256:pin});
  add(fileRef(__filename));
  const moduleFile=path.join(control.FROZEN.baseRoot,'support','grade-modules.cjs');
  add({path:moduleFile,sha256:'bd0de91aa956a8f18bd9628dab1266f9f91a91980837514914b5a5a9346bd7cf'});
  // Hash binding only: no private-case parsing or evaluation occurs here.
  add({path:path.join(control.FROZEN.fixturesDir,'tasks.json'),sha256:control.PINS.tasks});
  add({path:path.join(control.FROZEN.fixturesDir,'hidden-cases.json'),sha256:control.PINS.hidden});
  return require(moduleFile).snapshotModules;
}
function readEventCapture(state,capture,finalRef,add) {
  const final=read(add(finalRef).path),dir=path.dirname(finalRef.path);
  const manifestRef=add(fileRef(path.join(dir,'manifest.json'))),readyRef=add(fileRef(path.join(dir,'ready.json'))),manifest=read(manifestRef.path),ready=read(readyRef.path);
  const schema='blackice.minicpm.event-capture.v1';
  check(final.schema===schema&&manifest.schema===schema&&ready.schema===schema&&final.status==='stopped'&&ready.status==='ready'&&final.ready===true&&final.transportClosed===true&&!final.error&&final.stop,'CAPTURE_INCOMPLETE');
  check(final.captureId===manifest.captureId&&final.captureId===ready.captureId&&final.appFingerprint===state.appFingerprint&&manifest.appFingerprint===state.appFingerprint&&ready.appFingerprint===state.appFingerprint,'CAPTURE_IDENTITY');
  check(same(manifest.profileDir,state.profileDir)&&same(manifest.candidateRoot,state.candidateRoot)&&manifest.workspaceRoots?.some(root=>same(root,state.workspace)),'CAPTURE_SCOPE');
  for(const receipt of [manifest,ready,final])check(receipt.launchRef?.sha256===capture.launchRef.sha256&&same(receipt.launchRef.path,capture.launchRef.path),'CAPTURE_LAUNCH');
  check(manifest.preparation?.sha256===state.preparation.sha256&&same(manifest.preparation.path,state.preparation.path),'CAPTURE_PREPARATION');
  check(final.coverage?.reconnects===0&&final.coverage.serverSequenceAvailable===false&&final.coverage.providerConsumptionProven===false,'CAPTURE_COVERAGE');
  const raw=add(final.artifacts?.raw),eventFile=add(final.artifacts?.events);for(const ref of manifest.sources||[])add(ref);
  check(raw.bytes===final.rawBytes,'CAPTURE_LENGTH');
  const rows=fs.readFileSync(eventFile.path,'utf8').split('\n');check(rows.pop()==='','CAPTURE_JSONL');
  let index=0;const events=[];
  const {createParser}=require('./capture-events.cjs');
  const parser=createParser((event,meta)=>{
    const row=parse(rows[index]);check(row&&row.sequence===index+1&&row.jsonSha256===meta.jsonSha256&&isDeepStrictEqual(row.event,event),'CAPTURE_EVENT_MISMATCH');
    if(index===0)check(event.type==='runtime.status','CAPTURE_INITIAL');
    events.push({sequence:index+1,event});index++;
  });
  const fd=fs.openSync(raw.path,'r'),buffer=Buffer.allocUnsafe(65536);
  try {for(;;){const size=fs.readSync(fd,buffer,0,buffer.length,null);if(!size)break;parser.push(buffer.subarray(0,size));}parser.finish();}finally{fs.closeSync(fd);}
  check(index===rows.length&&index===final.eventCount,'CAPTURE_COUNT');
  check(Date.parse(ready.readyAt)<=Date.parse(capture.run.createdAt||capture.run.startedAt)&&Date.parse(final.finishedAt)>=Date.parse(capture.run.finishedAt),'CAPTURE_RUN_WINDOW');
  return {events,coverage:final.coverage};
}
function normalizedCall(call,meta) {
  const name=call.tool||call.name,args=parse(call.arguments),id=call.id||call.callId;
  check(typeof id==='string'&&id&&typeof name==='string','TOOL_CALL_INVALID');
  return {id,name,args:object(args)?args:{},argumentsInvalid:!object(args),nodeId:meta.nodeId,threadId:meta.threadId,turnId:meta.turnId,at:meta.at,order:meta.order,
    result:{success:call.success,contentItems:call.contentItems},delivery:null};
}
function combineCall(map,call) {
  const key=call.nodeId+'\0'+call.id,prior=map.get(key);
  if(prior){
    check(prior.name===call.name&&prior.argumentsInvalid===call.argumentsInvalid&&isDeepStrictEqual(prior.args,call.args)&&textOf(prior.result)===textOf(call.result),'TOOL_CALL_CONFLICT');
    check(prior.threadId===call.threadId,'TOOL_THREAD_CONFLICT');
    if(!prior.delivery&&call.delivery)prior.delivery=call.delivery;
    if(prior.result.success===undefined&&call.result.success!==undefined)prior.result.success=call.result.success;
    return prior;
  }
  map.set(key,call);return call;
}
function nativeCalls(run,agentId,node,events) {
  const map=new Map();
  for(const {sequence,event:e}of events){
    if(e.runId!==run.id||e.nodeId!==agentId||e.type!=='agent.event')continue;
    const d=e.data,i=d?.item;if(d?.type!=='item'||i?.type!=='dynamicToolCall'||!(i.status==='completed'||d.stage==='completed'))continue;
    if(!Array.isArray(i.contentItems))continue;
    check(typeof d.threadId==='string'&&d.threadId===node.threadId&&typeof d.turnId==='string'&&d.turnId,'TOOL_THREAD_IDENTITY');
    const call=normalizedCall(i,{nodeId:agentId,threadId:d.threadId,turnId:d.turnId,at:e.at,order:sequence});
    const joined=(run.toolContinuity?.records||[]).filter(r=>r.runId===run.id&&r.taskId===run.taskId&&r.nodeId===agentId&&r.callId===call.id&&r.tool===call.name&&r.delivery==='local-stream-write-not-provider-consumption'&&r.resultTextSha256===sha(textOf(call.result)));
    if(joined.length)call.delivery={kind:'local-stream-write',resultTextSha256:sha(textOf(call.result)),continuitySequence:joined.at(-1).sequence,providerConsumptionProven:false};
    combineCall(map,call);
  }
  return map;
}
async function compatibleCalls(state,run,agentId,node,add) {
  const root=path.join(path.dirname(state.scaffoldRef.path),'provider-traces',run.id,agentId),map=new Map(),exchanges=[],coverage=[];
  if(!fs.existsSync(root))return {map,exchanges,coverage:[{code:'PROVIDER_TRACES_MISSING'}]};
  const {providerToolResultDeliveries}=await import(pathToFileURL(path.join(state.candidateRoot,'lib','provider-tool-delivery.mjs')).href);
  const directories=fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
  for(const dir of directories){
    check(dir.isDirectory()&&!dir.isSymbolicLink(),'TRACE_DIRECTORY');
    const folder=path.join(root,dir.name),openedRef=add(fileRef(path.join(folder,'exchange-open.json'))),opened=read(openedRef.path),binding=opened.binding;
    check(opened.schema==='blackice.minicpm.provider-exchange.v1'&&opened.exchangeId===dir.name&&binding?.runId===run.id&&binding.taskId===run.taskId&&binding.nodeId===agentId&&binding.clientRequestId===state.requestId&&binding.providerType==='compatible'&&binding.threadId===node.threadId,'TRACE_IDENTITY');
    const requestRef=add(opened.request);check(same(requestRef.path,path.join(folder,'request.json')),'TRACE_REQUEST_PATH');const body=read(requestRef.path);
    check(body.model===binding.model&&state.model===binding.providerId+'::'+binding.model&&Array.isArray(body.messages)&&Array.isArray(body.tools),'TRACE_REQUEST_SHAPE');
    const url=new URL(opened.target);check(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password,'TRACE_TARGET');
    const settlementPath=path.join(folder,'exchange-settled.json');
    if(!fs.existsSync(settlementPath)){coverage.push({exchangeId:dir.name,code:'EXCHANGE_SETTLEMENT_MISSING'});continue;}
    const settled=read(add(fileRef(settlementPath)).path);
    check(settled.exchangeId===opened.exchangeId&&isDeepStrictEqual(settled.binding,binding)&&settled.request?.sha256===requestRef.sha256,'TRACE_SETTLEMENT_IDENTITY');
    const accepted=[];
    for(const item of settled.attempts||[]){
      const a=read(add(item.evidence).path);add(a.opened);if(a.response)add(a.response);
      check(a.schema==='blackice.minicpm.provider-attempt.v1'&&a.attemptId===item.attemptId&&a.exchangeId===opened.exchangeId&&isDeepStrictEqual(a.binding,binding)&&a.requestSha256===requestRef.sha256,'TRACE_ATTEMPT_IDENTITY');
      const valid=a.complete===true&&!a.captureError&&!a.error&&a.outcome==='accepted'&&a.http?.status>=200&&a.http.status<300&&['done-marker','consumer-terminal','eof','json-eof'].includes(a.terminal);
      if(valid)accepted.push(a);else coverage.push({exchangeId:dir.name,attemptId:a.attemptId,outcome:a.outcome,complete:a.complete===true,code:'NON_ACCEPTED_OR_INCOMPLETE_ATTEMPT'});
    }
    exchanges.push({id:dir.name,at:opened.at,requestSha256:requestRef.sha256,acceptedAttempts:accepted.length,semanticSuccess:settled.semantic?.success===true});
    if(!accepted.length)continue;
    // Fail ambiguity before the delivery helper's deliberately conservative drop.
    const ids=new Map();for(const msg of body.messages)if(msg?.role==='assistant')for(const call of msg.tool_calls||[]){const prior=ids.get(call.id);if(prior)check(isDeepStrictEqual(prior,call),'TOOL_CALL_CONFLICT');else ids.set(call.id,call);}
    const tools=body.tools.filter(t=>t?.type==='function'&&typeof t.function?.name==='string').map(t=>({wireName:t.function.name,name:t.function.name}));
    for(const delivery of providerToolResultDeliveries(body,{type:'compatible',tools})){
      const call=normalizedCall({...delivery.call,id:delivery.call.callId,...delivery.result},{nodeId:agentId,threadId:binding.threadId,turnId:binding.turnId,at:opened.at,order:Date.parse(opened.at)});
      call.delivery={kind:'accepted-compatible-request',exchangeId:opened.exchangeId,attemptId:accepted.at(-1).attemptId,requestSha256:requestRef.sha256,resultTextSha256:sha(textOf(call.result)),providerConsumptionProven:false};
      combineCall(map,call);
    }
  }
  return {map,exchanges,coverage};
}
const HOST_MARKER = /^DIRECTORY HOST RECEIPT (receipt-[1-9][0-9]*); current revision ([0-9]+)\. This is handler activity, not verified task completion\.(?: If relevant, cite this same-turn read after focusing the action\.)?$/;
function resultPacket(result) {
  const values=[],markers=[];
  for(const item of result?.contentItems||[]){
    if(item?.type!=='inputText'||typeof item.text!=='string')continue;
    const value=parse(item.text);
    if(object(value)){values.push(value);continue;}
    const marker=HOST_MARKER.exec(item.text);if(marker){markers.push(marker[1]);continue;}
    // Compatible transport flattens text items. Accept only an entire JSON
    // object followed by the exact host marker, never code/prose extraction.
    const index=item.text.lastIndexOf('\nDIRECTORY HOST RECEIPT ');
    if(index>=0){const prefix=parse(item.text.slice(0,index).trimEnd()),tail=HOST_MARKER.exec(item.text.slice(index+1));if(object(prefix)&&tail){values.push(prefix);markers.push(tail[1]);}}
  }
  check(values.length<=1&&markers.length<=1,'TOOL_RESULT_AMBIGUOUS');
  return {body:values[0]||null,receiptId:markers[0]||null};
}
function ledgerJoin(call,packet,run,ledger,events) {
  if(!packet.receiptId)return null;
  const matches=ledger.receipts.filter(r=>r.id===packet.receiptId);
  check(matches.length===1,'DIRECTORY_RECEIPT_IDENTITY');const receipt=matches[0];
  check(receipt.taskId===run.taskId&&receipt.runId===run.id&&receipt.nodeId===call.nodeId&&receipt.tool===call.name&&receipt.state==='returned','DIRECTORY_RECEIPT_IDENTITY');
  if(typeof call.result.success==='boolean'&&typeof receipt.success==='boolean')check(call.result.success===receipt.success,'DIRECTORY_RESULT_CONFLICT');
  const effects=events.map(row=>row.event||row).filter(e=>e.runId===run.id&&e.nodeId===call.nodeId&&e.type==='agent.event'&&e.data?.type==='directory.effect'&&e.data.callId===call.id).map(e=>e.data);
  check(effects.some(e=>e.receiptId===receipt.id&&e.tool===call.name&&['returned','threw'].includes(e.phase)),'DIRECTORY_CALL_JOIN');
  check(effects.filter(e=>e.receiptId).every(e=>e.receiptId===receipt.id),'DIRECTORY_CALL_CONFLICT');
  return receipt;
}
function checkSave(state,call,body,receipt,parseCodeBlockCall) {
  check(receipt&&body.action==='save'&&body.saved===true&&body.actionDispatched===true&&body.readback?.verified===true&&body.readbackVerified===true,'SAVE_RECEIPT');
  const file=sourcePath(state,call.args.path),code=parseCodeBlockCall({name:'relay_code',arguments:call.args}).code,bytes=Buffer.byteLength(code,'utf8'),hash=sha(code);
  check(same(body.path,file)&&body.sha256===hash&&body.sourceSha256===hash&&body.sourceBytes===bytes&&body.readback.sha256===hash&&body.readback.bytes===bytes&&body.bytesWritten===bytes,'SAVE_READBACK');
  check(body.saveReceipt?.sha256===hash&&body.saveReceipt.bytesWritten===bytes&&body.saveReceipt.readbackVerified===true,'SAVE_BACKEND_RECEIPT');
  if(call.args.expectedHash!==undefined)check(HASH.test(call.args.expectedHash)&&body.beforeHash===call.args.expectedHash&&body.saveReceipt.beforeHash===call.args.expectedHash,'SAVE_GUARD_CONFLICT');
  return {callId:call.id,receiptId:receipt.id,path:call.args.path,sha256:hash,bytes,beforeHash:body.beforeHash??null,guarded:call.args.expectedHash!==undefined,readbackVerified:true,delivery:call.delivery?.kind||'unknown'};
}
function knownTerminal(value) {
  return Number.isInteger(value.exitCode)||(value.exitCode===null&&(value.timedOut===true||value.cancelled===true||typeof value.signal==='string'&&value.signal.length>0));
}
function checkPublic(state,call,body,receipt) {
  const value=body.check?.receipt;
  check(receipt&&body.action==='check'&&body.check?.kind==='public'&&body.check.performed===true&&object(value)&&value.performed===true&&value.actionDispatched===true,'PUBLIC_EXECUTION_UNCONFIRMED');
  check(value.command==='node test-public.cjs'&&same(value.cwd,state.workspace)&&value.shell==='none'&&isDeepStrictEqual(value.args,['test-public.cjs']),'PUBLIC_COMMAND_IDENTITY');
  check(typeof value.timedOut==='boolean'&&knownTerminal(value),'PUBLIC_TERMINAL_UNKNOWN');
  const native=resultPacket(value.nativeResult).body;
  check(native&&['command','cwd','exitCode','signal','timedOut','truncated','stdout','stderr','sourceSnapshotBeforeSha256','sourceSnapshotAfterSha256'].every(k=>isDeepStrictEqual(value[k],native[k])),'PUBLIC_BACKEND_RECEIPT');
  const before=body.source?.before,after=body.source?.after;
  check(before&&after&&HASH.test(before.sha256||'')&&before.sha256===after.sha256&&before.bytes===after.bytes&&body.source.unchanged===true,'PUBLIC_SOURCE_CHANGED');
  check(HASH.test(value.sourceSnapshotBeforeSha256||'')&&value.sourceSnapshotBeforeSha256===value.sourceSnapshotAfterSha256,'PUBLIC_SNAPSHOT_CHANGED');
  if(call.args.expectedHash!==undefined)check(call.args.expectedHash===before.sha256,'PUBLIC_SOURCE_GUARD');
  const report=parse(value.stdout);
  return {kind:'public-smoke',callId:call.id,receiptId:receipt.id,command:value.command,cwd:value.cwd,
    exitCode:value.exitCode,signal:value.signal??null,timedOut:value.timedOut,cancelled:value.cancelled===true,truncated:value.truncated===true,
    ...(object(report)?{report}:{}),sourcePath:call.args.path,sourceSha256:after.sha256,sourceBytes:after.bytes,
    sourceSnapshotBeforeSha256:value.sourceSnapshotBeforeSha256,sourceSnapshotAfterSha256:value.sourceSnapshotAfterSha256,
    delivery:call.delivery?.kind||'unknown',resultTextSha256:sha(textOf(call.result)),at:receipt.returnedAt||call.at,order:call.order};
}
function reportSummary(report) {
  return {schema:SCHEMA,status:report.status,caseId:report.caseId,runId:report.runId,model:report.model,
    scoringEligible:report.scoringEligible,workflowComplete:report.workflowComplete,methodCompliant:report.methodCompliance?.compliant===true,
    finalPublicVerified:report.finalPublicVerified,sourceSnapshotSha256:report.sourceSnapshotSha256||null,
    publicCommandCount:report.publicCommandCount||0,failedPublicCommandCount:report.failedPublicCommandCount||0,
    missing:report.missing||[],coverage:report.coverage||{},skills:report.skills||{},providerConsumptionProven:false};
}
async function inspectEvidence(state,capture,eventCaptureFinalRef) {
  const refs=new Map(),bound=bindState(state,capture,refs),{run,node,agentId,add}=bound,snapshotModules=bindDependencies(state,add);
  const scaffold=read(state.scaffoldRef.path);
  const expectedScaffoldSchema=state.caseId==='D0'?'blackice.minicpm.directory-smoke-scaffold.v1':'blackice.minicpm.agentic-scaffold.v1';
  check(scaffold.schema===expectedScaffoldSchema&&scaffold.caseId===state.caseId&&same(scaffold.workspace,state.workspace)&&object(scaffold.immutableFiles),'SCAFFOLD_IDENTITY');
  for(const [name,pin]of Object.entries(scaffold.immutableFiles)){
    const file=path.resolve(state.workspace,name);check(inside(state.workspace,file)&&fileRef(file).sha256===pin,'IMMUTABLE_FIXTURE_CHANGED');
  }
  const snapshot=snapshotModules(state.workspace),eventArchive=eventCaptureFinalRef?readEventCapture(state,capture,eventCaptureFinalRef,add):null;
  const native=node.benchmarkEvidenceMode==='native-codex-receipts';
  check(!native||eventArchive,'NATIVE_CAPTURE_REQUIRED');
  const events=eventArchive?.events||run.events||[];
  let calls,traceCoverage=[],exchanges=[];
  if(native)calls=nativeCalls(run,agentId,node,events);
  else {
    const actual=await compatibleCalls(state,run,agentId,node,add);calls=actual.map;traceCoverage=actual.coverage;exchanges=actual.exchanges;
    // A saved full SSE result can prove execution even if a following request
    // failed. Only an accepted serialized request proves compatible delivery.
    if(eventArchive)for(const call of nativeCalls({...run,toolContinuity:null},agentId,node,events).values())combineCall(calls,call);
  }
  const ledger=capture.ledger.state,commands=[],saves=[],failures=[],deviations=[],coverageGaps=[],details=[];
  check(new Set(ledger.receipts.map(r=>r.id)).size===ledger.receipts.length,'DIRECTORY_DUPLICATE_RECEIPT');
  const unknown=ledger.receipts.filter(r=>r.runId===run.id&&r.state!=='returned');
  const sorted=[...calls.values()].sort((a,b)=>a.order-b.order);
  const {parseCodeBlockCall}=await import(pathToFileURL(path.join(state.candidateRoot,'lib','code-block-tool.mjs')).href);
  for(const call of sorted){
    const packet=resultPacket(call.result),body=packet.body,receipt=ledgerJoin(call,packet,run,ledger,events),success=call.result.success??receipt?.success;
    if(!call.delivery)coverageGaps.push({callId:call.id,tool:call.name,code:'EARLIER_DELIVERY_UNAVAILABLE'});
    if(success===false)failures.push({callId:call.id,tool:call.name,action:call.args.action,receiptId:receipt?.id||null,code:body?.code||null});
    details.push({callId:call.id,nodeId:call.nodeId,tool:call.name,action:call.args.action,receiptId:receipt?.id||null,resultTextSha256:sha(textOf(call.result)),delivery:call.delivery||null});
    if(call.name==='relay_code'&&call.args.action==='save'&&body?.saved===true){
      const save=checkSave(state,call,body,receipt,parseCodeBlockCall);saves.push(save);
      if(HASH.test(save.beforeHash||'')&&!save.guarded)deviations.push({callId:call.id,code:'REPLACEMENT_WITHOUT_EXPECTED_HASH'});
    }
    if(call.name==='relay_workspace'&&['write','patch'].includes(call.args.action)&&receipt?.actionDispatched!==false){
      deviations.push({callId:call.id,code:'WORKSPACE_WRITE_INSTEAD_OF_CODE_SAVE'});
    }
    if(call.name==='relay_code'&&call.args.action==='check'&&call.args.check==='public'){
      if(body?.check?.performed===false||body?.actionDispatched===false)continue;
      commands.push(checkPublic(state,call,body,receipt));
    }
  }
  commands.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.order-b.order);
  const last=commands.at(-1),missing=[];
  if(!last)missing.push('NO_DISPATCHED_PUBLIC_CHECK');
  if(unknown.length)missing.push('UNSETTLED_DIRECTORY_RECEIPTS');
  if(last){
    if(last.delivery==='unknown')missing.push('FINAL_CHECK_DELIVERY_UNAVAILABLE');
    if(last.sourceSnapshotAfterSha256!==snapshot.sha256)missing.push('FINAL_SOURCE_SNAPSHOT_MISMATCH');
    const source=fileRef(sourcePath(state,last.sourcePath));
    if(source.sha256!==last.sourceSha256||source.bytes!==last.sourceBytes)missing.push('FINAL_SOURCE_IDENTITY_MISMATCH');
  }
  const skillReceipts=run.skillLoadReceipts||[],submitted=skillReceipts.some(r=>r.type==='skill_context_submitted'&&r.skillId==='library-modular-development'),loaded=skillReceipts.some(r=>r.type==='skill_loaded'&&r.skillId==='library-modular-development');
  const reads=sorted.filter(c=>c.name==='relay_skills'&&c.args.action==='read'&&c.args.id==='library-modular-development'&&resultPacket(c.result).body?.entry?.id==='library-modular-development');
  const search=sorted.some(c=>c.name==='relay_skills'&&c.args.action==='search');
  if(!submitted)deviations.push({code:'MODULAR_CONTEXT_SUBMISSION_NOT_RECORDED'});
  if(!loaded||!reads.length)deviations.push({code:'MODULAR_SKILL_LOAD_NOT_RECORDED'});
  if(!search)deviations.push({code:'MODULAR_SKILL_DISCOVERY_NOT_RECORDED'});
  if(!saves.length)deviations.push({code:'NO_CODE_SAVE'});
  const publicPassed=last&&last.exitCode===0&&!last.timedOut&&!last.truncated&&last.report?.schema==='blackice.minicpm.public-smoke.v1'&&last.report.taskId===state.caseId&&last.report.semanticPass===true&&last.report.caseCount===scaffold.publicCaseCount&&last.report.executedCases===scaffold.publicCaseCount&&last.report.passedCases===scaffold.publicCaseCount&&last.report.sourceSnapshotSha256===snapshot.sha256;
  const finalObservation=last&&ledger.actions.some(a=>a.state==='observed'&&a.observation?.receipts?.includes(last.receiptId));
  if(publicPassed&&!finalObservation)deviations.push({code:'FINAL_CHECK_NOT_OBSERVED_IN_DIRECTORY'});
  const workflowComplete=run.status==='completed'&&capture.ledger.final?.reason==='ready'&&ledger.actions.every(a=>a.state==='observed');
  const report={schema:SCHEMA,status:missing.length?'unavailable':'verified',caseId:state.caseId,runId:run.id,model:state.model,scoringEligible:missing.length===0,
    workflowComplete,methodCompliance:{compliant:deviations.length===0,deviations},finalPublicVerified:!!publicPassed,
    sourceSnapshotSha256:snapshot.sha256,publicCommandCount:commands.length,failedPublicCommandCount:commands.filter(c=>c.exitCode!==0||c.timedOut||c.cancelled).length,missing,
    freshContext:{pastChats:'off',freshTask:true,resumed:false,threadId:node.threadId||null,scope:'Saved request/run identity; no provider-consumption claim.'},
    skills:{modularContextSubmitted:submitted,modularLoadReceipt:loaded,modularReadExecuted:reads.length>0,modularReadDeliveryJoined:reads.some(c=>!!c.delivery),providerConsumptionProven:false},
    planning:{requested:true,receipts:run.planningModuleReceipts||[]},directory:{final:capture.ledger.final,finalCheckObserved:!!finalObservation,unknownReceiptCount:unknown.length},
    coverage:{route:node.benchmarkEvidenceMode,observedToolResults:calls.size,optionalEarlierDeliveryGaps:coverageGaps,traceGaps:traceCoverage,continuityOmittedRecords:run.toolContinuity?.omittedRecords||0,
      eventCapture:eventArchive?.coverage||null,providerConsumptionProven:false},saves,toolResults:details,providerExchanges:exchanges};
  const execution={schema:EXECUTION_SCHEMA,caseId:state.caseId,workspace:state.workspace,
    run:{id:run.id,taskId:run.taskId,status:run.status,terminal:true,settled:true},
    actions:{settled:unknown.length===0,activeCount:unknown.length,pendingWriteCount:unknown.filter(r=>!r.observationOnly).length,commands,failures},
    completion:{agentCompleted:run.status==='completed',finalMessagePresent:typeof run.output==='string'&&run.output.trim().length>0},
    workflow:{verified:missing.length===0,complete:workflowComplete,methodCompliant:deviations.length===0,finalPublicVerified:!!publicPassed,providerConsumptionProven:false}};
  return {report,execution,snapshot,sourceRefs:[...refs.values()]};
}
async function prepareExecutionEvidence(config) {
  check(object(config)&&Object.keys(config).every(k=>['statePath','evidenceDir','eventCaptureFinalPath'].includes(k)),'CONFIG_INVALID');
  const statePath=absolute(config.statePath),state=read(statePath),evidenceDir=absolute(config.evidenceDir);
  check(same(statePath,path.join(state.attemptDir,'state.json')),'STATE_PATH');
  check(inside(path.join(state.attemptDir,'records'),evidenceDir)&&!same(evidenceDir,path.join(state.attemptDir,'records'))&&!inside(state.workspace,evidenceDir)&&!fs.existsSync(evidenceDir),'EVIDENCE_OUTPUT_SCOPE');
  fs.mkdirSync(path.dirname(evidenceDir),{recursive:true});fs.mkdirSync(evidenceDir);
  const capture=read(verifyRef(state.collectionRef).path),eventCaptureFinalRef=config.eventCaptureFinalPath?fileRef(config.eventCaptureFinalPath):null;
  let inspected;
  try {inspected=await inspectEvidence(state,capture,eventCaptureFinalRef);}
  catch(error){
    const report={schema:SCHEMA,status:'unavailable',caseId:state.caseId,runId:state.runId,model:state.model,scoringEligible:false,missing:[publicCode(error)],providerConsumptionProven:false};
    const reportRef=writeNew(path.join(evidenceDir,'verification.json'),report);return {...reportSummary(report),reportRef};
  }
  const snapshotRef=writeNew(path.join(evidenceDir,'source-snapshot.json'),inspected.snapshot);
  const manifest={schema:SCHEMA+'.manifest',statePath,stateIdentity:identity(state),collectionRef:state.collectionRef,eventCaptureFinalRef,
    sourceRefs:inspected.sourceRefs,sourceSnapshotRef:snapshotRef,executionSha256:sha(JSON.stringify(inspected.execution))};
  const manifestRef=writeNew(path.join(evidenceDir,'manifest.json'),manifest);
  const reportRef=writeNew(path.join(evidenceDir,'verification.json'),{...inspected.report,manifestRef,sourceSnapshotRef:snapshotRef});
  let executionRef=null;
  if(inspected.report.scoringEligible)executionRef=writeNew(path.join(evidenceDir,'execution.json'),{...inspected.execution,evidence:{manifestRef}});
  return {...reportSummary(inspected.report),reportRef,manifestRef,sourceSnapshotRef:snapshotRef,executionRef};
}
async function verifyExecutionEvidence({state,capture,execution,executionRef}) {
  verifyRef(executionRef);scopeFile(state,executionRef.path);
  check(isDeepStrictEqual(read(executionRef.path),execution),'EXECUTION_RECEIPT_CHANGED');
  const manifestRef=verifyRef(execution.evidence?.manifestRef);scopeFile(state,manifestRef.path);const manifest=read(manifestRef.path);
  check(manifest.schema===SCHEMA+'.manifest'&&isDeepStrictEqual(manifest.stateIdentity,identity(state)),'EXECUTION_STATE_CHANGED');
  check(isDeepStrictEqual(verifyRef(manifest.collectionRef),verifyRef(state.collectionRef))&&isDeepStrictEqual(read(manifest.collectionRef.path),capture),'EXECUTION_COLLECTION_CHANGED');
  for(const ref of manifest.sourceRefs||[]){verifyRef(ref);scopeFile(state,ref.path);}
  verifyRef(manifest.sourceSnapshotRef);scopeFile(state,manifest.sourceSnapshotRef.path);
  const actual=await inspectEvidence(state,capture,manifest.eventCaptureFinalRef);
  check(actual.report.scoringEligible&&sha(JSON.stringify(actual.execution))===manifest.executionSha256,'EXECUTION_NOT_VERIFIED');
  const {evidence,...claimed}=execution;check(isDeepStrictEqual(claimed,actual.execution),'EXECUTION_RECEIPT_CONFLICT');
  check(isDeepStrictEqual(read(manifest.sourceSnapshotRef.path),actual.snapshot),'FINAL_SOURCE_CHANGED');
  check(isDeepStrictEqual(manifest.sourceRefs,actual.sourceRefs),'EVIDENCE_SOURCE_SET_CHANGED');
  return {verified:true,workflowVerified:true,sourceRefs:[manifestRef,manifest.sourceSnapshotRef,...actual.sourceRefs],
    workflowComplete:actual.report.workflowComplete,methodCompliant:actual.report.methodCompliance.compliant,
    finalPublicVerified:actual.report.finalPublicVerified,providerConsumptionProven:false};
}
async function main(argv=process.argv.slice(2)) {
  check(argv.length===2&&argv[0]==='prepare','USAGE');return prepareExecutionEvidence(read(absolute(argv[1])));
}
module.exports={SCHEMA,EXECUTION_SCHEMA,SOURCE_PINS,prepareExecutionEvidence,verifyExecutionEvidence,reportSummary,main};
if(require.main===module)main().then(result=>{console.log(JSON.stringify(result));if(!result.scoringEligible)process.exitCode=2;})
  .catch(error=>{console.error(JSON.stringify({status:'unavailable',code:publicCode(error),providerConsumptionProven:false}));process.exitCode=1;});
