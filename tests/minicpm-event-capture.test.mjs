import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {CONFIG,SCHEMA,createParser,capture,requestStop,publicSummary}=require('../verification/minicpm-agent-tools-v2/capture-events.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
const initial={type:'runtime.status',data:{ready:true},at:'2026-11-22T00:00:00.000Z'};
const frame=(value,newline='\n')=>Buffer.from('data: '+JSON.stringify(value)+newline+newline);
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const put=(file,value)=>fs.writeFileSync(file,JSON.stringify(value)+'\n');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-event-capture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dirs=Object.fromEntries(['candidate','profile','receipts','workspace','evidence'].map(name=>{
    const directory=path.join(root,name);fs.mkdirSync(directory);return [name,directory];
  }));
  const appFingerprint='a'.repeat(64),rawElectron=path.join(root,'electron.exe');
  const processIdentity={pid:43210,startedAt:'2026-11-22T00:00:00.000Z',executable:rawElectron,
    url:'http://127.0.0.1:43210/',version:'fixture',profileMode:'custom'};
  const preparedReceiptPath=path.join(dirs.receipts,'prepared.json'),launchReceiptPath=path.join(dirs.receipts,'launch.json');
  put(preparedReceiptPath,{schema:'blackice.native-candidate-preparation.v1',status:'prepared',candidateRoot:dirs.candidate,profileDir:dirs.profile,rawElectron});
  put(launchReceiptPath,{schema:'blackice.native-candidate-launch.v1',status:'ready',candidateRoot:dirs.candidate,profileDir:dirs.profile,
    rawElectron,appFingerprint,process:processIdentity});
  const runtimePath=path.join(dirs.profile,'desktop-runtime.json');put(runtimePath,processIdentity);
  const config={schema:CONFIG,preparedReceiptPath,preparedReceiptSha256:hash(fs.readFileSync(preparedReceiptPath)),
    launchReceiptPath,launchReceiptSha256:hash(fs.readFileSync(launchReceiptPath)),appFingerprint,
    outputDir:path.join(dirs.evidence,'capture'),workspaceRoots:[dirs.workspace],maxDurationMs:5000,connectTimeoutMs:1000};
  return {root,dirs,config,runtimePath,processIdentity,appFingerprint};
}
function wire({opening=frame(initial),type='text/event-stream'}={}) {
  let controller,cancelled=0;
  const calls=[],cookie='relay_session_43210=fixture-private-cookie';
  const stream=new ReadableStream({start(value){controller=value;},cancel(){cancelled++;}});
  const fetch=async(url,options)=>{
    calls.push({url,method:options.method,redirect:options.redirect,headers:options.headers});
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    if(url.endsWith('/api/events')){
      assert.equal(options.headers.Cookie,cookie);
      assert.equal(options.headers.Origin,'http://127.0.0.1:43210');
      if(opening)controller.enqueue(opening);
      return new Response(stream,{status:200,headers:{'Content-Type':type}});
    }
    assert.equal(url,'http://127.0.0.1:43210/');
    return new Response('fixture',{status:200,headers:{'Set-Cookie':cookie+'; HttpOnly'}});
  };
  return {fetch,calls,cookie,enqueue:chunk=>controller.enqueue(chunk),end:()=>controller.close(),
    error:()=>controller.error(new Error('fixture-private-disconnection-detail')),get cancelled(){return cancelled;}};
}
const deps=(f,w,extra={})=>({fingerprint:async()=>f.appFingerprint,alive:async()=>true,fetch:w.fetch,pollIntervalMs:5,...extra});
function evidence(f,result) {
  assert.equal(json(path.join(f.config.outputDir,'final.json')).status,result.status);
  if(result.artifacts)for(const ref of Object.values(result.artifacts)){
    const bytes=fs.readFileSync(ref.path);assert.equal(bytes.length,ref.bytes);assert.equal(hash(bytes),ref.sha256);
  }
  return fs.readFileSync(path.join(f.config.outputDir,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

test('SSE parser preserves split UTF-8, CRLF and multiline JSON without repairing malformed data',()=>{
  const value={type:'agent.event',data:{type:'message',text:'A😀e\u0301👩‍💻終'}};
  const text=JSON.stringify(value,null,2);
  const bytes=Buffer.from(': fixture\r\n'+text.split('\n').map(line=>'data: '+line+'\r\n').join('')+'\r\n');
  const received=[],parser=createParser((event,meta)=>received.push({event,meta}));
  for(const byte of bytes)parser.push(Buffer.from([byte]));
  parser.finish();
  assert.equal(received.length,1);assert.deepEqual(received[0].event,value);
  assert.equal(received[0].meta.jsonSha256,hash(Buffer.from(text)));
  assert.throws(()=>createParser(()=>{}).push(Buffer.from('retry: 1000\n\n')),{code:'SSE_UNSUPPORTED_FIELD'});
});

test('owned fake stream becomes ready before admission and saves exact full events with readback hashes',async t=>{
  const f=fixture(t),w=wire();
  const fullText='Exact source/result 😀 e\u0301 👩‍💻\n'+('payload-'.repeat(3500));
  const event={type:'agent.event',runId:'run-a',nodeId:'agent',at:'2026-11-22T00:00:01.000Z',
    data:{type:'item',stage:'completed',threadId:'thread-a',turnId:'turn-a',
      item:{type:'dynamicToolCall',id:'call-a',tool:'relay_code',arguments:{action:'check',check:'public',path:'src/index.cjs'},
        status:'completed',success:true,contentItems:[{type:'inputText',text:fullText}]}}};
  const bytes=frame(event,'\r\n');
  let ownerAdmissionObserved=false;
  const result=await capture(f.config,deps(f,w,{onReady:ready=>{
    assert.equal(ready.status,'ready');assert.equal(ready.eventCount,1);
    assert.equal(json(path.join(f.config.outputDir,'ready.json')).captureId,ready.captureId);
    assert.equal(fs.readFileSync(path.join(f.config.outputDir,'stream.sse')).equals(frame(initial)),true);
    ownerAdmissionObserved=true;
    const emoji=bytes.indexOf(Buffer.from('😀'));
    for(const part of [bytes.subarray(0,emoji+1),bytes.subarray(emoji+1,emoji+3),bytes.subarray(emoji+3)])w.enqueue(part);
    setImmediate(()=>requestStop(f.config.outputDir,'fixture-owner-stop'));
  }}));
  assert.equal(ownerAdmissionObserved,true);assert.equal(result.status,'stopped');assert.equal(result.error,null);
  assert.equal(result.transportClosed,true);assert.equal(w.cancelled,1);assert.equal(result.eventCount,2);
  assert.equal(w.calls.length,2);assert.equal(w.calls.every(call=>call.method==='GET'),true);
  const rows=evidence(f,result);
  assert.equal(rows[1].event.data.item.contentItems[0].text,fullText);
  assert.equal(rows[1].event.runId,'run-a');assert.equal(rows[1].event.data.item.id,'call-a');
  assert.equal(rows[1].event.data.threadId,'thread-a');
  assert.equal(fs.readFileSync(result.artifacts.raw.path).equals(Buffer.concat([frame(initial),bytes])),true);
  assert.equal(result.coverage.reconnects,0);assert.equal(result.coverage.serverSequenceAvailable,false);
  assert.equal(result.coverage.providerConsumptionProven,false);assert.equal(result.coverage.runSettlementProven,false);
  const publicText=JSON.stringify(publicSummary(result));
  assert.equal(publicText.includes(fullText),false);assert.equal(publicText.includes(w.cookie),false);
  for(const name of ['manifest.json','ready.json','final.json'])assert.equal(fs.readFileSync(path.join(f.config.outputDir,name),'utf8').includes(w.cookie),false);
  assert.equal(requestStop(f.config.outputDir).status,'stop-requested');
});

test('runtime/source/profile and receipt mismatches reject before any GET or output creation',async t=>{
  const cases=[
    ['pid',f=>put(f.runtimePath,{...f.processIdentity,pid:43211}),{},'RUNTIME_IDENTITY'],
    ['profile',f=>put(f.runtimePath,{...f.processIdentity,profileMode:'default'}),{},'RUNTIME_IDENTITY'],
    ['source',()=>{}, {fingerprint:async()=>'b'.repeat(64)},'RUNTIME_SOURCE_CHANGED'],
    ['receipt pin',f=>{f.config.launchReceiptSha256='b'.repeat(64);},{},'CAPTURE_PIN_CHANGED'],
    ['not alive',()=>{}, {alive:async()=>false},'RUNTIME_NOT_ALIVE'],
  ];
  for(const [name,change,overrides,code] of cases)await t.test(name,async t=>{
    const f=fixture(t),w=wire();change(f);
    await assert.rejects(capture(f.config,deps(f,w,overrides)),{code});
    assert.equal(w.calls.length,0);assert.equal(fs.existsSync(f.config.outputDir),false);
  });
});

test('capture refuses evidence inside the model workspace and refuses an existing output directory',async t=>{
  for(const mode of ['workspace','existing'])await t.test(mode,async t=>{
    const f=fixture(t),w=wire();
    if(mode==='workspace')f.config.outputDir=path.join(f.dirs.workspace,'private-capture');
    else fs.mkdirSync(f.config.outputDir);
    await assert.rejects(capture(f.config,deps(f,w)),{code:mode==='workspace'?'CAPTURE_EVIDENCE_SCOPE':'CAPTURE_OUTPUT_EXISTS'});
    assert.equal(w.calls.length,0);
  });
});

test('unexpected EOF is a failed capture with preserved originals and no reconnect',async t=>{
  const f=fixture(t),w=wire();
  const result=await capture(f.config,deps(f,w,{onReady:()=>w.end()}));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'SSE_UNEXPECTED_EOF');
  assert.equal(result.ready,true);assert.equal(result.eventCount,1);assert.equal(result.stop,null);
  assert.equal(w.calls.length,2);evidence(f,result);
});

test('disconnection remains failed and does not expose transport error contents',async t=>{
  const f=fixture(t),w=wire();
  const result=await capture(f.config,deps(f,w,{onReady:()=>w.error()}));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'SSE_DISCONNECTED');
  assert.equal(w.calls.length,2);assert.equal(JSON.stringify(result).includes('fixture-private-disconnection-detail'),false);
  evidence(f,result);
});

test('malformed JSON is archived but never repaired or made ready',async t=>{
  const malformed=Buffer.from('data: {"type":"runtime.status",broken}\n\n'),f=fixture(t),w=wire({opening:malformed});
  const result=await capture(f.config,deps(f,w));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'SSE_JSON');assert.equal(result.ready,false);
  assert.equal(fs.existsSync(path.join(f.config.outputDir,'ready.json')),false);
  assert.equal(fs.readFileSync(result.artifacts.raw.path).equals(malformed),true);evidence(f,result);
});

test('a missing initial runtime status cannot produce capture readiness',async t=>{
  const f=fixture(t),w=wire({opening:frame({type:'agent.event',runId:'unexpected',data:{type:'message',text:'already running'}})});
  const result=await capture(f.config,deps(f,w));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'SSE_INITIAL_EVENT');
  assert.equal(result.ready,false);assert.equal(result.eventCount,0);evidence(f,result);
});

test('explicit stop does not hide a truncated JSON frame or partial UTF-8 sequence',async t=>{
  for(const [name,bytes,code] of [
    ['frame',Buffer.from('data: {"type":"agent.event"'),'SSE_TRUNCATED'],
    ['UTF-8',Buffer.from([0x64,0x61,0x74,0x61,0x3a,0x20,0xf0,0x9f]),'SSE_UTF8'],
  ])await t.test(name,async t=>{
    const f=fixture(t),w=wire();
    const result=await capture(f.config,deps(f,w,{onReady:()=>{
      w.enqueue(bytes);setImmediate(()=>requestStop(f.config.outputDir));
    }}));
    assert.equal(result.status,'failed');assert.equal(result.error.code,code);assert.ok(result.stop);
    assert.equal(fs.readFileSync(result.artifacts.raw.path).equals(Buffer.concat([frame(initial),bytes])),true);
    evidence(f,result);
  });
});

test('a silent opening stream fails its readiness deadline and does not reconnect',async t=>{
  const f=fixture(t),w=wire({opening:null});f.config.connectTimeoutMs=100;
  const result=await capture(f.config,deps(f,w));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'CAPTURE_READY_TIMEOUT');
  assert.equal(result.ready,false);assert.equal(w.calls.length,2);evidence(f,result);
});

test('a stop request for another capture fails closed',async t=>{
  const f=fixture(t),w=wire();
  const result=await capture(f.config,deps(f,w,{onReady:()=>{
    put(path.join(f.config.outputDir,'stop-request.json'),{schema:'blackice.minicpm.event-capture-stop.v1',captureId:'foreign'});
  }}));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'CAPTURE_STOP_IDENTITY');
  assert.equal(result.stop,null);evidence(f,result);
});

test('runtime replacement during a capture prevents a successful final receipt',async t=>{
  const f=fixture(t),w=wire();
  const result=await capture(f.config,deps(f,w,{onReady:()=>{
    put(f.runtimePath,{...f.processIdentity,pid:43211});requestStop(f.config.outputDir);
  }}));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'RUNTIME_IDENTITY');
  assert.equal(result.ready,true);evidence(f,result);
});

test('artifact readback detects bytes not written by the capture worker',async t=>{
  const f=fixture(t),w=wire();
  const result=await capture(f.config,deps(f,w,{onReady:()=>{
    fs.appendFileSync(path.join(f.config.outputDir,'stream.sse'),'foreign-bytes');
    requestStop(f.config.outputDir);
  }}));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'CAPTURE_ARTIFACT_MISMATCH');
  assert.equal(result.artifacts,null);assert.equal(json(path.join(f.config.outputDir,'final.json')).status,'failed');
});

test('capture-size bound is explicit and preserves the received oversize chunk',async t=>{
  const f=fixture(t),w=wire();f.config.maxBytes=1;
  const result=await capture(f.config,deps(f,w));
  assert.equal(result.status,'failed');assert.equal(result.error.code,'CAPTURE_SIZE_LIMIT');
  assert.equal(result.ready,false);assert.equal(result.rawBytes,frame(initial).length);evidence(f,result);
});
