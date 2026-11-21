import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {ProviderRuntime} from '../lib/providers.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {benchmarkFixture,fixtureWorkflow} from './helpers/minicpm-benchmark-fixture.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const completed=text=>({id:'completion-fixture',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]});
const json=(res,body,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));};
const sse=event=>'data: '+JSON.stringify(event)+'\n\n';
class NoModel extends EventEmitter{
 status(){return{connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('No external model is permitted in this transport fixture.');}
}
async function harness(t,handler,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-benchmark-transport-')),workspace=path.join(root,'workspace'),dataDir=path.join(root,'provider'),directory=path.join(root,'traces');
 fs.mkdirSync(workspace);
 const context={schema:'blackice.minicpm.provider-trace-context.v1',directory,workspace,runId:'bound-run',taskId:'bound-run',nodeId:'agent',clientRequestId:'bound-request'};
 const requests=[],beforePosts=[],errors=[],events=[];
 const server=createServer(async(req,res)=>{
  try{
   if(req.method==='GET')return json(res,{data:[]});
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   const request={url:req.url,method:req.method,headers:req.headers,bytes,body:JSON.parse(bytes.toString('utf8'))};requests.push(request);
   await handler(request,res,requests.length);
  }catch(error){errors.push(error);if(!res.headersSent)json(res,{error:{message:error.message}},500);else res.destroy();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const fetchImpl=async(url,init)=>{
  if(init?.method==='POST'){
   const record={url,headers:new Headers(init.headers),body:init.body,context};beforePosts.push(record);options.beforeFetch?.(record);
  }
  return options.fetchImpl?options.fetchImpl(url,init):fetch(url,init);
 };
 const runtime=await new ProviderRuntime({codex:new NoModel(),dataDir,fetchImpl,idleTimeoutMs:2000,modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
 t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture-model',contextWindowTokens:65536}],maxTokens:128,maxSteps:options.maxSteps??6});
 return{root,workspace,dataDir,directory,context,runtime,requests,beforePosts,events,
  run:extra=>runtime.runAgent({cwd:workspace,model:'fixture::fixture-model',prompt:'Read the fixture and report its observed result.',hostOnlyTools:true,benchmarkTrace:context,...extra,onEvent:event=>{events.push(event);extra?.onEvent?.(event);}}),
  thread:async()=>{const id=events.find(e=>e.type==='thread')?.threadId||fs.readdirSync(path.join(dataDir,'provider-threads')).find(n=>n.endsWith('.json'))?.slice(0,-5);assert.ok(id);return runtime.readThread(id);}
 };
}
function exchanges(thread){const list=thread.benchmarkTransportTrace?.exchanges;assert.ok(Array.isArray(list));return list.map(ref=>({ref,record:JSON.parse(fs.readFileSync(ref.settled.path,'utf8'))}));}
function attempts(record){return record.attempts.map(a=>JSON.parse(fs.readFileSync(a.evidence.path,'utf8')));}
function injectWriteFailure(basename){
 const originalOpen=fs.openSync,originalWrite=fs.writeSync,files=new Map();let triggered=false;
 const restore=()=>{fs.openSync=originalOpen;fs.writeSync=originalWrite;};
 fs.openSync=(file,...args)=>{const fd=originalOpen(file,...args);files.set(fd,String(file));return fd;};
 fs.writeSync=(fd,...args)=>{
  if(path.basename(files.get(fd)||'')===basename){triggered=true;restore();throw Object.assign(Error('fixture disk failure'),{code:'ENOSPC'});}
  return originalWrite(fd,...args);
 };
 return{restore,triggered:()=>triggered};
}

test('actual ProviderRuntime fetch sees durable exact request and host binding before dispatch',async t=>{
 let proved=0;
 const h=await harness(t,(_req,res)=>json(res,completed('verified')),{beforeFetch:({headers,body,context})=>{
  const id=headers.get('x-blackice-exchange-id'),attempt=headers.get('x-blackice-attempt-id'),dir=path.join(context.directory,id);
  const bytes=fs.readFileSync(path.join(dir,'request.json')),opened=JSON.parse(fs.readFileSync(path.join(dir,'exchange-open.json'),'utf8')),start=JSON.parse(fs.readFileSync(path.join(dir,'attempt-0001-open.json'),'utf8'));
  assert.deepEqual(bytes,Buffer.from(body));assert.equal(sha(bytes),headers.get('x-blackice-request-sha256'));assert.equal(start.attemptId,attempt);assert.equal(start.requestSha256,sha(bytes));assert.equal(opened.binding.runId,context.runId);assert.equal(start.complete,false);proved++;
 }});
 const result=await h.run();assert.equal(result.output,'verified');assert.equal(proved,1);
 const [x]=exchanges(await h.thread());assert.equal(x.record.complete,true);assert.equal(x.record.binding.runId,'bound-run');assert.equal(x.record.binding.taskId,'bound-run');assert.equal(x.record.binding.nodeId,'agent');assert.equal(x.record.binding.clientRequestId,'bound-request');
 assert.equal(x.record.binding.threadId,result.threadId);assert.equal(x.record.binding.turnId,result.turnId);assert.equal(x.record.binding.messageId,result.turnId+':message-0');
});
test('actual 503 recovery keeps exact request/exchange but creates a new attempt identity',async t=>{
 const h=await harness(t,(_req,res,n)=>n===1?json(res,{error:{message:'Temporary service failure.'}},503,{'retry-after':'0'}):json(res,completed('recovered')));
 assert.equal((await h.run()).output,'recovered');assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0].bytes,h.requests[1].bytes);
 assert.equal(h.requests[0].headers['x-blackice-exchange-id'],h.requests[1].headers['x-blackice-exchange-id']);assert.notEqual(h.requests[0].headers['x-blackice-attempt-id'],h.requests[1].headers['x-blackice-attempt-id']);
 const [x]=exchanges(await h.thread()),a=attempts(x.record);assert.equal(x.record.complete,true);assert.equal(a.length,2);assert.deepEqual(a.map(v=>v.outcome),['http-rejected','accepted']);assert.ok(a.every(v=>v.complete));assert.equal(a[0].requestSha256,a[1].requestSha256);
});
test('actual tool continuation creates a second exchange without executing the tool twice',async t=>{
 let executions=0;
 const h=await harness(t,(_req,res,n)=>json(res,n===1?{id:'completion-tool',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-fixture',type:'function',function:{name:'fixture_read',arguments:'{}'}}]}}]}:completed('tool verified')));
 const result=await h.run({dynamicTools:[{type:'function',name:'fixture_read',description:'Read fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}],onToolCall:async()=>{executions++;return{success:true,contentItems:[{type:'inputText',text:'saved result'}]};}});
 assert.equal(result.output,'tool verified');assert.equal(executions,1);assert.equal(h.requests.length,2);
 const rows=exchanges(await h.thread());assert.equal(rows.length,2);assert.notEqual(rows[0].ref.exchangeId,rows[1].ref.exchangeId);assert.equal(rows[0].record.binding.turnId,rows[1].record.binding.turnId);
 assert.equal(rows[0].record.binding.messageId,result.turnId+':message-0');assert.equal(rows[1].record.binding.messageId,result.turnId+':message-1');
 assert.equal(h.requests[1].body.messages.at(-1).tool_call_id,'call-fixture');assert.equal(h.requests[1].body.messages.at(-1).content,'saved result');
});
test('actual SSE capture preserves raw UTF-8 entity bytes and completion ID',async t=>{
 const expected=Buffer.from(sse({id:'completion-unicode',choices:[{index:0,delta:{content:'λ🙂'},finish_reason:null}]})+sse({id:'completion-unicode',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n');
 const h=await harness(t,async(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(let i=0;i<expected.length;i+=3){res.write(expected.subarray(i,i+3));await new Promise(resolve=>setImmediate(resolve));}res.end();});
 assert.equal((await h.run()).output,'λ🙂');const [x]=exchanges(await h.thread()),[a]=attempts(x.record);
 assert.equal(a.terminal,'done-marker');assert.deepEqual(fs.readFileSync(a.response.path),expected);assert.equal(a.response.sha256,sha(expected));assert.deepEqual(x.record.responseIds,['completion-unicode']);assert.equal(x.record.complete,true);
});
test('uncertain network failure is saved incomplete and never replayed',async t=>{
 const h=await harness(t,(_req,res)=>res.destroy());await assert.rejects(h.run(),{code:'PROVIDER_NETWORK'});assert.equal(h.requests.length,1);
 const [x]=exchanges(await h.thread()),[a]=attempts(x.record);assert.equal(x.record.complete,false);assert.equal(a.outcome,'failed');assert.equal(a.http,null);assert.equal(h.runtime.active.size,0);
});
test('service failure after accepted SSE bytes is never retried',async t=>{
 const h=await harness(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(sse({id:'partial-response',choices:[{index:0,delta:{content:'partial'}}]})+sse({error:{code:503,message:'Service unavailable.'}}));});
 await assert.rejects(h.run(),{code:'PROVIDER_SERVICE'});assert.equal(h.requests.length,1);const [x]=exchanges(await h.thread()),[a]=attempts(x.record);assert.equal(a.http.status,200);assert.equal(x.record.complete,false);assert.ok(a.response.bytes>0);
});
for(const terminal of ['done','eof'])test('semantic truncation with '+terminal+' boundary remains incomplete without replay',async t=>{
 const h=await harness(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(sse({id:'incomplete-response',choices:[{index:0,delta:{content:'unfinished'}}]})+(terminal==='done'?'data: [DONE]\n\n':''));});
 await assert.rejects(h.run(),{code:'PROVIDER_PROTOCOL'});assert.equal(h.requests.length,1);const [x]=exchanges(await h.thread()),[a]=attempts(x.record);
 assert.equal(a.complete,true);assert.equal(x.record.complete,false);assert.equal(x.record.semantic.success,false);assert.equal(a.terminal,terminal==='done'?'done-marker':'eof');
});
test('model length stop preserves PROVIDER_TRUNCATED and marks exchange incomplete',async t=>{
 const h=await harness(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(sse({id:'length-response',choices:[{index:0,delta:{content:'prefix'},finish_reason:'length'}]})+'data: [DONE]\n\n');});
 await assert.rejects(h.run(),{code:'PROVIDER_TRUNCATED'});assert.equal(h.requests.length,1);const [x]=exchanges(await h.thread());
 assert.equal(x.record.complete,false);assert.equal(x.record.semantic.incomplete,true);assert.equal(x.record.semantic.providerFinishReason,'length');
});
test('cancellation of an accepted stream retains bytes but no invented terminal or replay',async t=>{
 const controller=new AbortController(),h=await harness(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(sse({id:'cancelled-response',choices:[{index:0,delta:{content:'observed before cancellation'}}]}));});
 await assert.rejects(h.run({signal:controller.signal,onEvent:event=>{if(event.type==='delta')controller.abort();}}),{code:'ABORT_ERR'});
 assert.equal(h.requests.length,1);const [x]=exchanges(await h.thread()),[a]=attempts(x.record);assert.equal(x.record.complete,false);assert.equal(a.terminal,null);assert.ok(a.response.bytes>0);assert.equal(h.runtime.active.size,0);
});
test('response.text fallback cannot claim byte-complete benchmark evidence',async t=>{
 const h=await harness(t,()=>{}, {fetchImpl:async(_url,init)=>init?.method==='GET'?new Response('{"data":[]}'):{ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify(completed('unobserved bytes'))}});
 await assert.rejects(h.run(),{code:'BENCHMARK_TRACE_INCOMPLETE'});assert.equal(h.beforePosts.length,1);const [x]=exchanges(await h.thread()),[a]=attempts(x.record);
 assert.equal(a.terminal,'unavailable-reader');assert.equal(a.response.bytes,0);assert.equal(x.record.complete,false);
});
test('request evidence write failure prevents HTTP dispatch',async t=>{
 const h=await harness(t,(_req,res)=>json(res,completed('must not dispatch'))),fault=injectWriteFailure('request.json');
 try{await assert.rejects(h.run(),cause=>['ENOSPC','BENCHMARK_TRACE_IO'].includes(cause.code));}finally{fault.restore();}
 assert.equal(fault.triggered(),true);assert.equal(h.beforePosts.length,0);assert.equal(h.requests.length,0);
 const dirs=fs.existsSync(h.directory)?fs.readdirSync(h.directory):[];assert.ok(dirs.every(dir=>!fs.existsSync(path.join(h.directory,dir,'exchange-settled.json'))));
});
test('final exchange write failure retains partial binding and never replays accepted HTTP',async t=>{
 const h=await harness(t,(_req,res)=>json(res,completed('accepted once'))),fault=injectWriteFailure('exchange-settled.json');
 try{await assert.rejects(h.run(),cause=>['ENOSPC','BENCHMARK_TRACE_IO'].includes(cause.code));}finally{fault.restore();}
 assert.equal(fault.triggered(),true);assert.equal(h.requests.length,1);
 const thread=await h.thread(),failure=thread.benchmarkTransportTraceFailure;assert.ok(failure?.exchange,'partial exchange reference must survive failed finalization');
 assert.equal(failure.exchange.binding.runId,'bound-run');assert.equal(failure.exchange.request.sha256,sha(h.requests[0].bytes));assert.equal(failure.exchange.attempts.length,1);
 assert.deepEqual(fs.readFileSync(failure.exchange.request.path),h.requests[0].bytes);assert.equal(h.runtime.active.size,0);
});
test('invalid benchmark context cannot dispatch or create transport artifacts',async t=>{
 const h=await harness(t,(_req,res)=>json(res,completed('must not run')));
 await assert.rejects(h.run({benchmarkTrace:{...h.context,directory:h.workspace}}),{code:'BENCHMARK_TRACE_INVALID'});assert.equal(h.beforePosts.length,0);assert.equal(fs.existsSync(h.directory),false);
});
for(const remote of [false,true])test('ordinary '+(remote?'remote':'local')+' compatible requests have no trace headers or artifacts',async t=>{
 const h=await harness(t,(_req,res)=>json(res,completed('ordinary')),{...(remote?{fetchImpl:async(_url,init)=>new Response(JSON.stringify(init?.method==='GET'?{data:[]}:completed('ordinary')),{headers:{'content-type':'application/json'}})}:{})});
 if(remote)await h.runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'https://provider.invalid/v1',models:['fixture-model'],maxTokens:128});
 assert.equal((await h.run({benchmarkTrace:undefined,hostOnlyTools:false})).output,'ordinary');assert.equal(h.beforePosts.length,1);
 assert.ok(![...h.beforePosts[0].headers.keys()].some(name=>name.startsWith('x-blackice-')));assert.equal(fs.existsSync(h.directory),false);assert.equal((await h.thread()).benchmarkTransportTrace,undefined);
});
test('benchmark tracing rejects a remote endpoint before posting correlation headers',async t=>{
 const h=await harness(t,()=>{}, {fetchImpl:async()=>new Response('{"data":[]}')});
 await h.runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'https://provider.invalid/v1',models:['fixture-model'],maxTokens:128});
 await assert.rejects(h.run(),{code:'BENCHMARK_TRACE_ENDPOINT'});assert.equal(h.beforePosts.length,0);assert.equal(fs.existsSync(h.directory),false);
});
test('actual HarnessEngine supplies admitted run/node/client identities to the production provider trace',async t=>{
 const cleanup=[],f=benchmarkFixture({after:fn=>cleanup.push(fn)});
 const h=await harness(t,(_req,res)=>json(res,{id:'engine-response',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'engine-read-method',type:'function',function:{name:'relay_workspace',arguments:'{"action":"read","path":"METHOD.md"}'}}]}}]}),{maxSteps:1});
 const engine=await new HarnessEngine({runtime:h.runtime,dataDir:path.join(f.root,'engine-trace'),defaultCwd:f.workspace}).init();
 t.after(async()=>{await engine.close();for(const fn of cleanup)await fn();});
 const workflow=structuredClone(fixtureWorkflow);workflow.id='trace-engine-fixture';workflow.nodes.find(n=>n.type==='agent').model='fixture::fixture-model';
 workflow.settings={...workflow.settings,context:{preset:'custom',windowTokens:65536,autoCompact:false,outputReserveTokens:4096,headroomTokens:512}};
 const start=engine.startRun({requestId:'trace-engine-request',workflow,input:{task:'Read METHOD.md using the supplied benchmark tool.',cwd:f.workspace,directoryMode:'off',directoryActions:'on',chatPlanning:'off',pastChats:'off',directoryDiagnostics:'maximal',benchmark:structuredClone(f.request),benchmarkBudget:{wallMs:30000}}});
 await engine.executions.get(start.id);const run=engine.getRun(start.id);assert.equal(run.settled,true);assert.equal(h.requests.length,1);
 const thread=await h.runtime.readThread(run.nodes.agent.threadId),[x]=exchanges(thread);
 assert.equal(x.record.binding.runId,run.id);assert.equal(x.record.binding.taskId,run.taskId);assert.equal(x.record.binding.nodeId,'agent');assert.equal(x.record.binding.clientRequestId,'trace-engine-request');assert.equal(x.record.binding.threadId,run.nodes.agent.threadId);assert.equal(x.record.binding.turnId,run.nodes.agent.turnId);
 assert.equal(path.dirname(x.ref.directory),path.join(path.dirname(f.request.scaffoldReceiptPath),'provider-traces',run.id,'agent'));
 assert.equal(h.requests[0].headers['x-blackice-exchange-id'],x.ref.exchangeId);assert.equal(h.requests[0].headers['x-blackice-attempt-id'],x.record.attempts[0].attemptId);assert.equal(x.record.request.sha256,sha(h.requests[0].bytes));assert.equal(x.record.complete,true);
});


test('attempt settlement disk failure retains opened binding and raw bytes without replay',async t=>{
 const answer=completed('response survived attempt settlement failure'),h=await harness(t,(_req,res)=>json(res,answer));
 const fault=injectWriteFailure('attempt-0001-settled.json');
 try{await assert.rejects(h.run(),cause=>{assert.equal(cause.code,'ENOSPC');return true;});}finally{fault.restore();}
 assert.equal(fault.triggered(),true);assert.equal(h.requests.length,1);assert.equal(h.beforePosts.length,1);
 const [x]=exchanges(await h.thread());assert.equal(x.record.complete,false);assert.equal(x.record.semantic.success,false);assert.equal(x.record.semantic.error.code,'ENOSPC');
 assert.deepEqual(x.record.attempts,[]);assert.equal(x.record.openedAttempts.length,1);
 const opened=x.record.openedAttempts[0];assert.equal(opened.settlementError.code,'ENOSPC');assert.equal(opened.attemptId,h.requests[0].headers['x-blackice-attempt-id']);
 const start=JSON.parse(fs.readFileSync(opened.opened.path,'utf8'));
 assert.equal(start.binding.runId,h.context.runId);assert.equal(start.binding.nodeId,h.context.nodeId);assert.equal(start.requestSha256,sha(h.requests[0].bytes));
 assert.deepEqual(fs.readFileSync(opened.responsePath),Buffer.from(JSON.stringify(answer)));
 assert.deepEqual(fs.readFileSync(x.record.request.path),h.requests[0].bytes);
});
test('bounded HTTP error diagnostics retain received bytes and mark read-limit incomplete',async t=>{
 const responseBytes=Buffer.from(JSON.stringify({error:{message:'x'.repeat(200000)}}));
 const h=await harness(t,(_req,res)=>{res.writeHead(400,{'content-type':'application/json'});res.end(responseBytes);});
 await assert.rejects(h.run(),cause=>{assert.match(cause.code,/^PROVIDER_/);return true;});
 assert.equal(h.requests.length,1);assert.equal(h.beforePosts.length,1);
 const [x]=exchanges(await h.thread()),[attempt]=attempts(x.record);
 assert.equal(x.record.complete,false);assert.equal(attempt.complete,false);assert.equal(attempt.http.status,400);assert.equal(attempt.outcome,'http-rejected');assert.equal(attempt.terminal,'read-limit');
 const received=fs.readFileSync(attempt.response.path);assert.ok(received.length>=128000);assert.ok(received.length<=responseBytes.length);assert.deepEqual(received,responseBytes.subarray(0,received.length));assert.equal(sha(received),attempt.response.sha256);assert.equal(attempt.captureError,null);
});
