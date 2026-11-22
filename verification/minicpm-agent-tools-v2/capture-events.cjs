'use strict';
// BC3: read-only original SSE archive. Importing this file performs no I/O.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {verifyRuntime} = require('./native-control.cjs');
const CONFIG = 'blackice.minicpm.event-capture-config.v1';
const SCHEMA = 'blackice.minicpm.event-capture.v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message || code), {code}); };
const check = (value, code) => { if (!value) fail(code); };
const same = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root,file) => { const relative=path.relative(root,file); return relative==='' || (!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)); };
const absolute = value => { check(typeof value==='string'&&path.isAbsolute(value),'CAPTURE_PATH'); return path.resolve(value); };
const readJSON = file => JSON.parse(fs.readFileSync(file,'utf8'));
const codeOf = error => typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'CAPTURE_FAILED';

function fileRef(file) {
  const stat=fs.lstatSync(file);
  check(stat.isFile()&&!stat.isSymbolicLink(),'CAPTURE_FILE');
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  let bytes=0;
  try { let count; while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){ hash.update(buffer.subarray(0,count));bytes+=count; } }
  finally { fs.closeSync(fd); }
  return {path:path.resolve(file),bytes,sha256:hash.digest('hex')};
}
function pinned(file, expected) {
  check(/^[a-f0-9]{64}$/.test(expected||''),'CAPTURE_PIN');
  const ref=fileRef(absolute(file));
  check(ref.sha256===expected,'CAPTURE_PIN_CHANGED');
  return ref;
}
function writeNew(file,value) {
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx');
  try { fs.writeFileSync(fd,bytes);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const ref=fileRef(file);check(ref.sha256===sha(bytes),'CAPTURE_ARTIFACT_MISMATCH');return ref;
}
function sink(file) {
  const fd=fs.openSync(file,'wx'),hash=createHash('sha256');let bytes=0,closed=false;
  return {
    write(value){const b=Buffer.isBuffer(value)?value:Buffer.from(value);fs.writeFileSync(fd,b);hash.update(b);bytes+=b.length;},
    sync(){if(!closed)fs.fsyncSync(fd);},
    close(){if(!closed){try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);closed=true;}}},
    ref(){check(closed,'CAPTURE_SINK_OPEN');const actual=fileRef(file);check(actual.bytes===bytes&&actual.sha256===hash.copy().digest('hex'),'CAPTURE_ARTIFACT_MISMATCH');return actual;},
    get bytes(){return bytes;},
  };
}
async function bounded(promise,ms,code) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(code),{code})),ms);})]); }
  finally { clearTimeout(timer); }
}

/** Strict framing for the observed server: UTF-8, data fields and comments, LF/CRLF.
 * No retry/id interpretation, replay, repair or silent dropping of malformed frames. */
function createParser(onEvent,{maxFrameChars=16*1024*1024}={}) {
  const decoder=new TextDecoder('utf-8',{fatal:true}),data=[];
  let buffer='',frameChars=0;
  function line(value) {
    if(value.endsWith('\r'))value=value.slice(0,-1);
    check(!value.includes('\r'),'SSE_FRAMING');
    frameChars+=value.length+1;check(frameChars<=maxFrameChars,'SSE_FRAME_LIMIT');
    if(value===''){
      if(data.length){
        const text=data.join('\n');let event;
        try{event=JSON.parse(text);}catch{fail('SSE_JSON');}
        check(object(event)&&typeof event.type==='string'&&event.type.length>0,'SSE_EVENT');
        onEvent(event,{jsonSha256:sha(Buffer.from(text,'utf8'))});
      }
      data.length=0;frameChars=0;return;
    }
    if(value.startsWith(':'))return;
    const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);
    check(field==='data','SSE_UNSUPPORTED_FIELD');
    let text=colon<0?'':value.slice(colon+1);if(text.startsWith(' '))text=text.slice(1);
    data.push(text);
  }
  return {
    push(bytes){
      try{buffer+=decoder.decode(bytes,{stream:true});}catch{fail('SSE_UTF8');}
      let end;
      while((end=buffer.indexOf('\n'))>=0){const next=buffer.slice(0,end);buffer=buffer.slice(end+1);line(next);}
      check(buffer.length+frameChars<=maxFrameChars,'SSE_FRAME_LIMIT');
    },
    finish(){
      try{buffer+=decoder.decode();}catch{fail('SSE_UTF8');}
      check(buffer.length===0&&data.length===0,'SSE_TRUNCATED');
    },
  };
}
function configState(config) {
  const allowed=['schema','preparedReceiptPath','preparedReceiptSha256','launchReceiptPath','launchReceiptSha256','appFingerprint','outputDir','workspaceRoots','maxDurationMs','connectTimeoutMs','maxBytes'];
  check(object(config)&&Object.keys(config).every(key=>allowed.includes(key))&&config.schema===CONFIG,'CAPTURE_CONFIG');
  const preparation=pinned(config.preparedReceiptPath,config.preparedReceiptSha256),prepared=readJSON(preparation.path);
  check(prepared.schema==='blackice.native-candidate-preparation.v1'&&prepared.status==='prepared','CAPTURE_PREPARATION');
  const launchRef=pinned(config.launchReceiptPath,config.launchReceiptSha256);
  check(same(path.dirname(preparation.path),path.dirname(launchRef.path)),'CAPTURE_LAUNCH_DIRECTORY');
  const candidateRoot=fs.realpathSync(absolute(prepared.candidateRoot)),profileDir=fs.realpathSync(absolute(prepared.profileDir));
  check(/^[a-f0-9]{64}$/.test(config.appFingerprint||''),'CAPTURE_FINGERPRINT');
  const outputDir=absolute(config.outputDir),parent=fs.realpathSync(path.dirname(outputDir));
  check(same(path.dirname(outputDir),parent),'CAPTURE_OUTPUT_LINK');
  check(!fs.existsSync(outputDir),'CAPTURE_OUTPUT_EXISTS');
  check(Array.isArray(config.workspaceRoots)&&config.workspaceRoots.length>0&&config.workspaceRoots.length<=32,'CAPTURE_WORKSPACES');
  const workspaceRoots=config.workspaceRoots.map(root=>fs.realpathSync(absolute(root)));
  check(workspaceRoots.every(root=>fs.statSync(root).isDirectory()),'CAPTURE_WORKSPACES');
  check([...workspaceRoots,candidateRoot,profileDir].every(root=>!inside(root,outputDir)),'CAPTURE_EVIDENCE_SCOPE');
  const maxDurationMs=config.maxDurationMs??3600000,connectTimeoutMs=config.connectTimeoutMs??15000,maxBytes=config.maxBytes??512*1024*1024;
  check(Number.isSafeInteger(maxDurationMs)&&maxDurationMs>=10&&maxDurationMs<=86400000,'CAPTURE_DURATION');
  check(Number.isSafeInteger(connectTimeoutMs)&&connectTimeoutMs>=10&&connectTimeoutMs<=60000,'CAPTURE_CONNECT_TIMEOUT');
  check(Number.isSafeInteger(maxBytes)&&maxBytes>=1&&maxBytes<=4*1024*1024*1024,'CAPTURE_SIZE');
  return {candidateRoot,profileDir,rawElectron:absolute(prepared.rawElectron),appFingerprint:config.appFingerprint,
    preparation,launchReceiptPath:launchRef.path,launchRef,outputDir,workspaceRoots,maxDurationMs,connectTimeoutMs,maxBytes};
}
const coverage = Object.freeze({
  scope:'received-original-SSE-bytes-and-events',reconnects:0,serverSequenceAvailable:false,
  missingEventDetection:'transport-and-parser-only-no-server-sequence-or-replay',
  providerConsumptionProven:false,localDeliveryRequiresContinuityJoin:true,runSettlementProven:false,
});

async function capture(config,deps={}) {
  const state=configState(config);
  const identity=await verifyRuntime(state,deps);
  const sourceRefs=[fileRef(__filename),fileRef(require.resolve('./native-control.cjs'))];
  fs.mkdirSync(state.outputDir);
  const captureId=randomUUID(),startedAt=new Date().toISOString(),stopPath=path.join(state.outputDir,'stop-request.json');
  const manifest={schema:SCHEMA,captureId,startedAt,workerPid:process.pid,appFingerprint:state.appFingerprint,
    candidateRoot:state.candidateRoot,profileDir:state.profileDir,preparation:state.preparation,launchRef:state.launchRef,
    origin:identity.origin,workspaceRoots:state.workspaceRoots,sources:sourceRefs,coverage};
  writeNew(path.join(state.outputDir,'manifest.json'),manifest);
  const raw=sink(path.join(state.outputDir,'stream.sse')),events=sink(path.join(state.outputDir,'events.jsonl'));
  const controller=new AbortController();
  let reader,readerCancellation,ready=null,sequence=0,initial=false,stop=null,failure=null,closed=false;
  const fetchImpl=deps.fetch||fetch;
  function cancelReader() {
    if(reader&&!readerCancellation)readerCancellation=Promise.allSettled([Promise.resolve().then(()=>reader.cancel()),reader.closed]).then(()=>{closed=true;});
  }
  function abort(error){if(!failure&&!stop)failure=error;controller.abort(error);cancelReader();}
  function stopNow(request){if(failure||stop)return;stop=request;controller.abort();cancelReader();}
  const timeout=setTimeout(()=>abort(Object.assign(new Error(),{code:'CAPTURE_TIMEOUT'})),state.maxDurationMs);
  const opening=setTimeout(()=>{if(!ready)abort(Object.assign(new Error(),{code:'CAPTURE_READY_TIMEOUT'}));},state.connectTimeoutMs);
  const poll=setInterval(()=>{
    try{
      if(!fs.existsSync(stopPath))return;
      const request=readJSON(stopPath);
      check(request.schema==='blackice.minicpm.event-capture-stop.v1'&&request.captureId===captureId,'CAPTURE_STOP_IDENTITY');
      stopNow({requestedAt:request.requestedAt,observedAt:new Date().toISOString(),reason:request.reason});
    }catch(error){abort(Object.assign(new Error(),{code:error.code==='CAPTURE_STOP_IDENTITY'?error.code:'CAPTURE_STOP_INVALID'}));}
  },deps.pollIntervalMs??250);
  const onSignal=()=>stopNow({requestedAt:new Date().toISOString(),observedAt:new Date().toISOString(),reason:'owner-signal'});
  deps.signal?.addEventListener('abort',onSignal,{once:true});
  if(deps.signal?.aborted)onSignal();
  const parser=createParser((event,meta)=>{
    if(!initial){check(event.type==='runtime.status'&&object(event.data),'SSE_INITIAL_EVENT');initial=true;}
    const row={sequence:++sequence,receivedAt:new Date().toISOString(),...meta,event};
    events.write(JSON.stringify(row)+'\n');
  });
  try{
    const home=await fetchImpl(identity.origin+'/',{method:'GET',redirect:'error',signal:controller.signal});
    check(home.ok,'CAPTURE_SESSION_HTTP');
    const cookies=home.headers.getSetCookie?.()||[];
    const cookie=cookies.map(value=>value.split(';',1)[0]).find(value=>/^relay_session_[0-9]+=/.test(value));
    check(cookie,'CAPTURE_SESSION_COOKIE');
    if(home.body)await bounded(home.body.cancel(),2000,'CAPTURE_SESSION_CLOSE');
    const response=await fetchImpl(identity.origin+'/api/events',{method:'GET',redirect:'error',signal:controller.signal,
      headers:{Cookie:cookie,Origin:identity.origin,Accept:'text/event-stream'}});
    check(response.ok,'CAPTURE_STREAM_HTTP');
    check(response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()==='text/event-stream','CAPTURE_STREAM_TYPE');
    check(typeof response.body?.getReader==='function','CAPTURE_STREAM_BODY');
    reader=response.body.getReader();
    if(controller.signal.aborted)cancelReader();
    while(true){
      let next;
      try{next=await reader.read();}catch(error){if(stop||failure)break;fail('SSE_DISCONNECTED');}
      if(next.done){closed=true;if(stop||failure)break;fail('SSE_UNEXPECTED_EOF');}
      const bytes=Buffer.from(next.value);
      raw.write(bytes);raw.sync();
      check(raw.bytes<=state.maxBytes,'CAPTURE_SIZE_LIMIT');
      parser.push(bytes);events.sync();
      if(initial&&!ready&&!stop&&!failure){
        await verifyRuntime(state,deps);
        if(stop||failure)break;
        ready={schema:SCHEMA,captureId,status:'ready',readyAt:new Date().toISOString(),workerPid:process.pid,
          appFingerprint:state.appFingerprint,launchRef:state.launchRef,origin:identity.origin,
          rawBytes:raw.bytes,eventCount:sequence,coverage};
        writeNew(path.join(state.outputDir,'ready.json'),ready);
        clearTimeout(opening);
        await deps.onReady?.(ready);
      }
      if(stop||failure)break;
    }
  }catch(error){if(!stop&&!failure)failure=error;}
  finally{
    clearTimeout(timeout);clearTimeout(opening);clearInterval(poll);
    deps.signal?.removeEventListener('abort',onSignal);
    controller.abort();cancelReader();
    try{if(readerCancellation)await bounded(readerCancellation,2000,'CAPTURE_SHUTDOWN_UNCONFIRMED');}
    catch(error){failure=error;closed=false;}
    try{parser.finish();}catch(error){failure ||= error;}
    try{raw.close();events.close();}catch(error){failure ||= Object.assign(new Error(),{code:'CAPTURE_ARTIFACT_CLOSE'});}
  }
  let artifacts;
  try{artifacts={raw:raw.ref(),events:events.ref()};}catch(error){failure ||= error;}
  try{
    await verifyRuntime(state,deps);
    for(const ref of sourceRefs)check(fileRef(ref.path).sha256===ref.sha256,'CAPTURE_SOURCE_CHANGED');
  }catch(error){failure ||= error;}
  if(!stop&&!failure)failure=Object.assign(new Error(),{code:'CAPTURE_STOP_MISSING'});
  const result={schema:SCHEMA,captureId,status:failure?'failed':'stopped',startedAt,finishedAt:new Date().toISOString(),
    ready: Boolean(ready),readyAt:ready?.readyAt||null,workerPid:process.pid,appFingerprint:state.appFingerprint,
    launchRef:state.launchRef,eventCount:sequence,rawBytes:raw.bytes,transportClosed:closed,
    stop:stop||null,error:failure?{code:codeOf(failure)}:null,artifacts:artifacts||null,coverage};
  writeNew(path.join(state.outputDir,'final.json'),result);
  return result;
}
function requestStop(outputDir,reason='owner-request') {
  outputDir=absolute(outputDir);const manifest=readJSON(path.join(outputDir,'manifest.json'));
  check(manifest.schema===SCHEMA&&typeof manifest.captureId==='string','CAPTURE_STOP_IDENTITY');
  check(typeof reason==='string'&&reason.length>0&&reason.length<=200,'CAPTURE_STOP_REASON');
  const target=path.join(outputDir,'stop-request.json');
  if(fs.existsSync(target)){check(readJSON(target).captureId===manifest.captureId,'CAPTURE_STOP_IDENTITY');return {status:'stop-requested',captureId:manifest.captureId,receipt:fileRef(target)};}
  const temporary=target+'.'+randomUUID()+'.tmp';
  writeNew(temporary,{schema:'blackice.minicpm.event-capture-stop.v1',captureId:manifest.captureId,requestedAt:new Date().toISOString(),reason});
  check(!fs.existsSync(target),'CAPTURE_STOP_EXISTS');fs.renameSync(temporary,target);
  return {status:'stop-requested',captureId:manifest.captureId,receipt:fileRef(target)};
}
function publicSummary(result) {
  return {status:result.status,captureId:result.captureId,ready:result.ready,eventCount:result.eventCount,
    rawBytes:result.rawBytes,transportClosed:result.transportClosed,error:result.error,
    artifacts:result.artifacts,providerConsumptionProven:false,runSettlementProven:false};
}
async function main(argv=process.argv.slice(2)) {
  check(argv.length===2&&['start','stop'].includes(argv[0]),'CAPTURE_USAGE');
  if(argv[0]==='stop')return requestStop(argv[1]);
  const control=new AbortController();
  const stop=()=>control.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return publicSummary(await capture(readJSON(absolute(argv[1])),{signal:control.signal}));}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
module.exports={CONFIG,SCHEMA,createParser,capture,requestStop,publicSummary,main};
if(require.main===module)main().then(result=>{console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;})
  .catch(error=>{console.error(JSON.stringify({status:'failed',error:{code:codeOf(error)}}));process.exitCode=1;});
