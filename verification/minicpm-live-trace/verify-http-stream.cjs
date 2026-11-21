'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cp=require('node:child_process'),net=require('node:net'),http=require('node:http');
const assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const readyText=Buffer.from('data: {"fixture":"ready"}\n\n');
const expectedBody=Buffer.concat([readyText,Buffer.from('data: [DONE]\n\n')]);
const cases=['final-chunk','final-empty','reset-write','reset-done'];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=7000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(20);}throw Error('Deadline: '+label);}
function saved(file,bytes){fs.writeFileSync(file,bytes,{flag:'wx'});const fd=fs.openSync(file,'r+');fs.fsyncSync(fd);fs.closeSync(fd);assert(fs.readFileSync(file).equals(Buffer.from(bytes)));return{path:file,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)};}
function jsonSaved(file,value){return saved(file,JSON.stringify(value,null,2)+'\n');}
function decodeWire(raw){
 const split=raw.indexOf('\r\n\r\n');assert(split>=0,'HTTP header boundary');
 const head=raw.subarray(0,split).toString('latin1');assert.match(head,/^HTTP\/1\.1 200 /);assert.match(head,/transfer-encoding:\s*chunked/i);
 let at=split+4,done=false;const chunks=[];
 while(at<raw.length){const end=raw.indexOf('\r\n',at);assert(end>=0,'Chunk size boundary');const line=raw.subarray(at,end).toString('ascii');assert.match(line,/^[0-9a-f]+$/i);const count=parseInt(line,16);at=end+2;
  assert(count<=16*1024*1024&&at+count+2<=raw.length,'Complete bounded chunk');
  if(count===0){assert.equal(raw.subarray(at,at+2).toString(),'\r\n');at+=2;done=true;break;}
  chunks.push(raw.subarray(at,at+count));at+=count;assert.equal(raw.subarray(at,at+2).toString(),'\r\n');at+=2;
 }
 assert(done,'Actual HTTP zero-chunk terminator');assert.equal(at,raw.length,'No bytes after terminator');return{headers:head,body:Buffer.concat(chunks)};
}
function control(port,method,route,value){return new Promise((resolve,reject)=>{
 const bytes=value===undefined?null:Buffer.from(JSON.stringify(value));
 const request=http.request({host:'127.0.0.1',port,method,path:route,agent:false,headers:bytes?{'content-type':'application/json','content-length':bytes.length}:{}},response=>{
  const parts=[];response.on('data',b=>parts.push(b));response.on('end',()=>{try{const body=Buffer.concat(parts);assert.equal(response.statusCode,200,body.toString());resolve(JSON.parse(body));}catch(e){reject(e);}});response.on('error',reject);
 });request.setTimeout(2500,()=>request.destroy(Error('Control timeout')));request.on('error',reject);request.end(bytes);
});}
async function oneCase(port,name,directory){
 const requestBody=Buffer.from(JSON.stringify({case:name}));
 const request=Buffer.concat([Buffer.from('POST /completion/fixture HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nContent-Type: application/json\r\nContent-Length: '+requestBody.length+'\r\nConnection: close\r\n\r\n'),requestBody]);
 const parts=[],errors=[];let length=0,connected=false,closed=false,reset=false;
 const socket=net.createConnection({host:'127.0.0.1',port});
 socket.setTimeout(9000,()=>socket.destroy(Error('Stream timeout')));
 socket.on('connect',()=>{connected=true;socket.write(request);});
 socket.on('data',b=>{length+=b.length;if(length>20*1024*1024){socket.destroy(Error('Fixture response bound'));return;}parts.push(Buffer.from(b));});
 socket.on('error',e=>errors.push({code:e.code??null,message:e.message}));socket.on('close',()=>{closed=true;});
 try{
  await until(()=>connected,'stream connect');
  if(name.startsWith('reset-')){
   await until(()=>Buffer.concat(parts).includes(readyText),'first actual streamed chunk');
   await until(async()=>{const state=await control(port,'GET','/fixture/state?case='+name);return state.waiting?state:null;},'producer at reset barrier');
   assert.equal(typeof socket.resetAndDestroy,'function','Actual TCP reset API required');socket.resetAndDestroy();reset=true;
   await until(()=>closed,'client reset socket close');
   await control(port,'POST','/fixture/release',{case:name});
  }else await until(()=>closed,'normal HTTP EOF');
  const state=await until(async()=>{const value=await control(port,'GET','/fixture/state?case='+name);return value.completed?value:null;},'producer cleanup');
  assert.equal(state.timedOut,false);assert.equal(state.completed,true);
  const response=Buffer.concat(parts);let decoded=null;
  if(!reset){assert.deepEqual(errors,[]);decoded=decodeWire(response);assert(decoded.body.equals(expectedBody),'Exact SSE bytes plus complete HTTP terminator');assert.equal(state.returnedFinal,true);}
  else{assert(response.includes(readyText));assert(!response.includes(Buffer.from('data: [DONE]')));assert.equal(state.released,true);assert.equal(state.returnedFinal,name==='reset-done');}
  return{case:name,request:saved(path.join(directory,name+'.request.http.bin'),request),requestBodySha256:sha(requestBody),response:saved(path.join(directory,name+'.response.http.bin'),response),decodedBody:decoded?saved(path.join(directory,name+'.body.bin'),decoded.body):null,clientResetIssued:reset,clientClosed:closed,clientErrors:errors,producer:state};
 }finally{if(!closed)socket.destroy();}
}
async function main(executable,mode,directory,dllDirectory){
 assert(['legacy','baseline','instrumented'].includes(mode));for(const p of [executable,directory,dllDirectory])assert(path.isAbsolute(p),'Absolute owned paths required');
 assert(!fs.existsSync(directory),'Fresh fixture evidence directory required');fs.mkdirSync(directory,{recursive:true});
 const env={...process.env,PATH:dllDirectory+';'+process.env.PATH};delete env.BLACKICE_TRACE_CONFIG;
 // Keep this owned fixture independent of service-specific inherited launch hints.
 for(const name of ['AIP_MODE','AIP_HTTP_PORT','AIP_HEALTH_ROUTE','AIP_PREDICT_ROUTE','LLAMA_SERVER_ROUTER_PORT'])delete env[name];
 const traceDirectory=path.join(directory,'trace'),configFile=path.join(directory,'blackice-trace.json');
 if(mode!=='baseline'){
  jsonSaved(configFile,{schema:'blackice.minicpm.trace-config.v1',enabled:true,activationCaptureEnabled:false,outputDirectory:traceDirectory,tensorSelection:['attn_norm'],maxBytes:4194304,logitVectorSteps:0});env.BLACKICE_TRACE_CONFIG=configFile;
 }
 const child=cp.spawn(executable,[],{cwd:dllDirectory,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const stdout=[],stderr=[];let out='',exit=null,spawnError=null;
 child.stdout.on('data',b=>{stdout.push(Buffer.from(b));out+=b.toString('utf8');});child.stderr.on('data',b=>stderr.push(Buffer.from(b)));
 child.on('error',e=>{spawnError=e.message;});child.on('exit',(code,signal)=>{exit={code,signal};});
 let observations=[],failure=null,native=null;
 try{
  const ready=await until(()=>{if(spawnError)throw Error(spawnError);if(exit)throw Error('Fixture exited before ready: '+Buffer.concat(stderr));for(const line of out.split('\n')){try{const value=JSON.parse(line);if(value.event==='ready')return value;}catch{}}return null;},'fixture listener');
  assert.equal(ready.modelStarted,false);assert(ready.port>0&&ready.port<65536);
  for(const name of cases)observations.push(await oneCase(ready.port,name,directory));
  child.stdin.end('stop\n');await until(()=>exit,'owned fixture server exit');assert.equal(exit.code,0,Buffer.concat(stderr).toString());assert.equal(exit.signal,null);
  const emitted=out.trim().split(/\r?\n/).map(JSON.parse);assert.equal(emitted.filter(x=>x.event==='producer_cleanup').length,4);assert.equal(emitted.filter(x=>x.event==='settled').length,1);
  if(mode!=='baseline'){
   const names=fs.readdirSync(traceDirectory);assert(!names.some(n=>n.endsWith('.invalid.json')));const logs=names.filter(n=>n.endsWith('.jsonl'));assert.equal(logs.length,1);
   const traceFile=path.join(traceDirectory,logs[0]),bytes=fs.readFileSync(traceFile);assert(bytes.toString().endsWith('\n'));const events=bytes.toString().trim().split('\n').map(JSON.parse);
   events.forEach((e,n)=>{assert.equal(e.fileSequence,n+1);assert.equal(e.processSequence,n+1);assert.equal(e.pid,child.pid);});
   assert(!events.some(e=>['context_start','runtime_startup','task_registered'].includes(e.event)),'No model context or task');
   const requests=events.filter(e=>e.event==='http_request');assert.equal(requests.length,4);
   native=[];
   for(const observation of observations){const requestsForCase=requests.filter(e=>e.data.bodySha256===observation.requestBodySha256);assert.equal(requestsForCase.length,1);const request=requestsForCase[0];
    const body=fs.readFileSync(request.data.body.path);assert.equal(sha(body),request.data.bodySha256);assert.equal(body.length,request.data.bodyBytes);
    const ends=events.filter(e=>e.event==='http_generator_end'&&e.data.serverRequestId===request.data.serverRequestId),logs=events.filter(e=>e.event==='http_response_observed'&&e.data.serverRequestId===request.data.serverRequestId);assert.equal(ends.length,1);assert.equal(logs.length,1);assert.equal(logs[0].data.status,200);
    const data=ends[0].data,success=!observation.clientResetIssued;assert.equal(data.status,200);assert.equal(data.streaming,true);
    assert.equal(data.transportProviderSuccess,mode==='legacy'?false:success);assert.equal(data.complete,mode==='legacy'?false:success);
    if(mode==='instrumented'){assert.equal(data.producerExhausted,observation.case!=='reset-write');assert.equal(data.sinkDoneCalled,observation.case!=='reset-write');assert.equal(data.chunkWriteFailed,observation.case==='reset-write');}
    native.push({case:observation.case,requestEvent:request,loggerEvent:logs[0],terminalEvent:ends[0]});
   }
   const terminal=events.filter(e=>e.event==='process_end');assert.equal(terminal.length,1);assert.equal(terminal[0].data.complete,true);assert.equal(terminal[0].data.openContexts,0);assert.equal(terminal[0].data.openHttpRequests,0);assert.equal(terminal[0].data.droppedEvents,0);
   native={trace:{path:traceFile,bytes:bytes.length,sha256:sha(bytes)},cases:native,processEnd:terminal[0]};
  }
 }catch(error){failure=error.stack||String(error);}
 finally{if(!exit){child.stdin.destroy();child.kill();await until(()=>exit,'failed fixture cleanup',4000).catch(()=>{});}}
 const receipt={schema:'blackice.minicpm.http-stream-fixture.v1',at:new Date().toISOString(),mode,modelStarted:false,complete:failure===null,oldDefectReproduced:mode==='legacy'&&failure===null,
  binary:{path:executable,bytes:fs.statSync(executable).size,sha256:sha(fs.readFileSync(executable))},pid:child.pid,exit,spawnError,stdout:saved(path.join(directory,'server.stdout.bin'),Buffer.concat(stdout)),stderr:saved(path.join(directory,'server.stderr.bin'),Buffer.concat(stderr)),observations,native,failure};
 const result=jsonSaved(path.join(directory,'result.json'),receipt);console.log(JSON.stringify({complete:receipt.complete,mode,cases:observations.length,modelStarted:false,result}));if(failure)throw Error(failure);
}
if(require.main===module)main(...process.argv.slice(2)).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={main};
