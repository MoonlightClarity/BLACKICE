import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createBenchmarkExchangeTrace,validateBenchmarkTraceContext} from '../lib/provider-exchange-trace.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,overrides={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-exchange-trace-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace'),directory=path.join(root,'host-evidence');fs.mkdirSync(workspace);
 const context={schema:'blackice.minicpm.provider-trace-context.v1',directory,workspace,runId:'owned-run',taskId:'owned-run',nodeId:'agent',clientRequestId:'owned-request'};
 const serializedBody=JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'Preserve exact bytes: λ 🙂'}],stream:true});
 const options={context,threadId:'provider-fixture',turnId:'turn-fixture',messageId:'turn-fixture:message-0',providerId:'fixture',model:'fixture-model',providerType:'compatible',target:'http://127.0.0.1:8080/v1/chat/completions',serializedBody,...overrides};
 return {root,workspace,directory,context,serializedBody,options,create:()=>createBenchmarkExchangeTrace(options)};
}
const response=(status=200,type='application/json')=>({status,headers:new Headers({'content-type':type})});
function finishHTTP(trace,body,{status=200,terminal='eof',outcome='accepted'}={}){
 trace.observeHTTP(response(status));trace.appendResponse(Buffer.from(body));if(terminal!==null)trace.terminal(terminal);
 return trace.finishAttempt({outcome});
}
function settled(trace){return JSON.parse(fs.readFileSync(path.join(trace.reference().directory,'exchange-settled.json'),'utf8'));}

test('trace context requires exact host identity and an evidence directory outside model workspace',t=>{
 const f=fixture(t);assert.deepEqual(validateBenchmarkTraceContext(f.context),f.context);
 assert.equal(validateBenchmarkTraceContext({...f.context,clientRequestId:null}).clientRequestId,null);
 for(const context of [{...f.context,directory:f.workspace},{...f.context,directory:path.join(f.workspace,'child')},{...f.context,runId:'not an ID'},{...f.context,clientRequestId:undefined},{...f.context,directory:'relative'}])assert.throws(()=>validateBenchmarkTraceContext(context),{code:'BENCHMARK_TRACE_INVALID'});
 assert.equal(fs.existsSync(f.directory),false);
});
test('trace rejects remote/protocol/credential endpoints before creating evidence',t=>{
 for(const target of ['https://example.test/v1/chat/completions','http://example.test/v1/chat/completions','https://127.0.0.1:8080/v1/chat/completions','http://user:secret@127.0.0.1:8080/v1/chat/completions']){
  const f=fixture(t,{target});assert.throws(()=>f.create(),{code:'BENCHMARK_TRACE_ENDPOINT'});assert.equal(fs.existsSync(f.directory),false);
 }
});
test('trace rejects wrong model/body or incomplete provider binding before artifacts',t=>{
 for(const overrides of [{serializedBody:'{"model":"other","messages":[]}'},{serializedBody:'{"model":"fixture-model"}'},{messageId:''},{providerType:'openai'}]){
  const f=fixture(t,overrides);assert.throws(()=>f.create());assert.equal(fs.existsSync(f.directory),false);
 }
});
test('exact request and attempt binding are fsynced and readable before dispatch can occur',t=>{
 const f=fixture(t),originalOpen=fs.openSync,originalFsync=fs.fsyncSync,opened=new Map(),synced=[];
 let trace,attempt;
 fs.openSync=(file,...args)=>{const fd=originalOpen(file,...args);opened.set(fd,String(file));return fd;};
 fs.fsyncSync=fd=>{synced.push(opened.get(fd));return originalFsync(fd);};
 try{trace=f.create();attempt=trace.beginAttempt(f.serializedBody);}finally{fs.openSync=originalOpen;fs.fsyncSync=originalFsync;}
 const ref=trace.reference(),request=fs.readFileSync(ref.request.path);
 assert.deepEqual(request,Buffer.from(f.serializedBody));assert.equal(sha(request),attempt.requestSha256);
 for(const name of ['request.json','exchange-open.json','attempt-0001-open.json'])assert.ok(synced.some(file=>file&&path.basename(file)===name),name+' must be fsynced');
 const before=JSON.parse(fs.readFileSync(attempt.evidence.path,'utf8'));assert.equal(before.dispatched,'not-observed');assert.equal(before.attemptId,attempt.attemptId);
 assert.equal(before.binding.runId,'owned-run');assert.equal(before.binding.threadId,'provider-fixture');assert.equal(before.binding.messageId,'turn-fixture:message-0');
 trace.finishAttempt({outcome:'failed',error:Error('Fixture stops before dispatch')});trace.finishSemantic({success:false,error:Error('Fixture stops before dispatch')});
});
test('changed serialized request and overlapping attempts are refused',t=>{
 const f=fixture(t),trace=f.create();assert.throws(()=>trace.beginAttempt(f.serializedBody+' '),{code:'BENCHMARK_TRACE_REQUEST_CHANGED'});
 trace.beginAttempt(f.serializedBody);assert.throws(()=>trace.beginAttempt(f.serializedBody),/previous HTTP attempt/);
 trace.finishAttempt({outcome:'failed',error:Error('test')});trace.finishSemantic({success:false,error:Error('test')});
});
test('503 retry keeps one exchange and body digest but distinct durable attempt IDs',t=>{
 const f=fixture(t),trace=f.create(),a=trace.beginAttempt(f.serializedBody);
 const rejected=finishHTTP(trace,'{"error":"temporary"}',{status:503,outcome:'http-rejected'});
 assert.equal(rejected.complete,true);const b=trace.beginAttempt(f.serializedBody);
 assert.equal(a.exchangeId,b.exchangeId);assert.equal(a.requestSha256,b.requestSha256);assert.notEqual(a.attemptId,b.attemptId);
 finishHTTP(trace,'{"id":"response-1"}');const result=trace.finishSemantic({success:true,result:{incomplete:false,termination:{providerFinishReason:'stop'}}});
 assert.equal(result.complete,true);const record=settled(trace);assert.equal(record.attempts.length,2);
 assert.equal(record.attempts[0].outcome,'http-rejected');assert.equal(record.attempts[1].outcome,'accepted');
 for(const attempt of record.attempts)assert.equal(sha(fs.readFileSync(attempt.evidence.path)),attempt.evidence.sha256);
});
test('raw response bytes preserve split UTF-8 and response IDs without text re-encoding',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);trace.observeHTTP(response(200,'text/event-stream'));
 const bytes=Buffer.from('data: {"id":"response-utf8","text":"λ🙂"}\r\n\r\ndata: [DONE]\r\n\r\n');
 for(let i=0;i<bytes.length;i+=3)trace.appendResponse(bytes.subarray(i,i+3));
 trace.observeEvent({id:'response-utf8'});trace.observeEvent({id:'response-utf8'});trace.terminal('done-marker');
 const attempt=trace.finishAttempt({outcome:'accepted'});assert.deepEqual(fs.readFileSync(attempt.response.path),bytes);assert.equal(attempt.response.sha256,sha(bytes));assert.equal(attempt.response.chunks,Math.ceil(bytes.length/3));
 const result=trace.finishSemantic({success:true,result:{incomplete:false}});assert.equal(result.complete,true);assert.deepEqual(settled(trace).responseIds,['response-utf8']);
});
for(const terminal of [null,'read-limit','unavailable-reader'])test('transport boundary '+String(terminal)+' remains incomplete',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);
 const attempt=finishHTTP(trace,'{}',{terminal});assert.equal(attempt.complete,false);
 assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
test('an accepted outcome without observed HTTP status remains incomplete',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);trace.appendResponse(Buffer.from('{}'));trace.terminal('eof');
 assert.equal(trace.finishAttempt({outcome:'accepted'}).complete,false);assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
for(const [status,outcome]of [[503,'accepted'],[200,'http-rejected']])test('HTTP status '+status+' cannot contradict outcome '+outcome,t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);
 assert.equal(finishHTTP(trace,'{}',{status,outcome}).complete,false);assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
test('semantic failure remains separate from successfully received HTTP bytes',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);assert.equal(finishHTTP(trace,'{}').complete,true);
 const done=trace.finishSemantic({success:false,error:Object.assign(Error('invalid response'),{code:'PROVIDER_PROTOCOL'})});
 assert.equal(done.complete,false);assert.equal(done.semantic.success,false);assert.equal(settled(trace).attempts[0].complete,true);
});
test('explicit incomplete model result cannot become a complete exchange',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);finishHTTP(trace,'{}');
 const done=trace.finishSemantic({success:true,result:{incomplete:true,termination:{providerFinishReason:'length'}}});
 assert.equal(done.complete,false);assert.equal(done.semantic.incomplete,true);
});
test('length finish reason remains incomplete even when the supplied incomplete flag is absent',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);finishHTTP(trace,'{}');
 assert.equal(trace.finishSemantic({success:true,result:{termination:{providerFinishReason:'length'}}}).complete,false);
});
test('response overflow retains saved prefix and a nonpassing terminal artifact',t=>{
 const f=fixture(t,{maxResponseBytes:4}),trace=f.create();trace.beginAttempt(f.serializedBody);trace.observeHTTP(response());trace.appendResponse(Buffer.from('abc'));
 assert.throws(()=>trace.appendResponse(Buffer.from('de')),{code:'BENCHMARK_TRACE_LIMIT'});
 trace.terminal('eof');const attempt=trace.finishAttempt({outcome:'accepted'});assert.equal(attempt.complete,false);assert.equal(attempt.captureError.code,'BENCHMARK_TRACE_LIMIT');assert.equal(fs.readFileSync(attempt.response.path,'utf8'),'abc');
 assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
test('partial disk write failure is visible and cannot be converted into complete capture',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);trace.observeHTTP(response());
 const original=fs.writeSync;let calls=0;
 fs.writeSync=(fd,bytes,offset,length)=>{if(++calls===1)return original(fd,bytes,offset,1);fs.writeSync=original;throw Object.assign(Error('disk full fixture'),{code:'ENOSPC'});};
 try{assert.throws(()=>trace.appendResponse(Buffer.from('abcdef')),{code:'BENCHMARK_TRACE_IO'});}finally{fs.writeSync=original;}
 trace.terminal('eof');const attempt=trace.finishAttempt({outcome:'accepted'});assert.equal(attempt.complete,false);assert.equal(attempt.captureError.code,'ENOSPC');assert.equal(fs.readFileSync(attempt.response.path,'utf8'),'a');
 assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
test('response fsync failure is retained without falsely confirming durable completion',t=>{
 const f=fixture(t),trace=f.create();trace.beginAttempt(f.serializedBody);trace.observeHTTP(response());trace.appendResponse(Buffer.from('{}'));trace.terminal('eof');
 const original=fs.fsyncSync;fs.fsyncSync=()=>{fs.fsyncSync=original;throw Object.assign(Error('fsync fixture'),{code:'EIO'});};
 let attempt;try{attempt=trace.finishAttempt({outcome:'accepted'});}finally{fs.fsyncSync=original;}
 assert.equal(attempt.complete,false);assert.equal(attempt.captureError.code,'EIO');assert.equal(trace.finishSemantic({success:true,result:{incomplete:false}}).complete,false);
});
