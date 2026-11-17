import path from 'node:path';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
import { inspectLlamaBundle } from '../lib/llama-cpp-bundle.mjs';
import { LlamaCppServerSupervisor } from '../lib/llama-cpp-supervisor.mjs';
const root=path.resolve(process.argv[2] || '.build/llama.cpp');
const modelFile=path.resolve(process.argv[3] || '.build/llama-evidence/stories260K.gguf');
const runtime=await inspectLlamaBundle({root});console.log('runtime',runtime);
assert.equal(runtime.available,true);
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const modelFixture=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-model-revision-'));
const secondModelFile=path.join(modelFixture,'second.gguf');await fs.copyFile(modelFile,secondModelFile);
try {
for(const backend of ['cpu','vulkan','fallback','automatic']) {
 const port=await freePort();
 const request=async(_engine,route,{body}={})=>{
   let r;try {r=await fetch('http://127.0.0.1:'+port+route,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,headers:body?{'content-type':'application/json'}:undefined,signal:AbortSignal.timeout(30000)});}catch(e){throw Object.assign(e,{code:'LOCAL_ENGINE_OFFLINE'});}
   const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;
 };
 const supervisor=new LlamaCppServerSupervisor({request,port,readinessTimeoutMs:15000,resolveBundledRuntime:async()=>backend==='automatic'?runtime:({available:true,backend:'Vulkan',executablePath:process.execPath,fallbackPath:path.join(root,'cpu','llama-server.exe')})});
 try {
  const config={executablePath:['fallback','automatic'].includes(backend)?'':path.join(root,backend,'llama-server.exe'),modelPaths:{fixture:modelFile},ctxSize:512};
  let lease=await supervisor.acquire(config,1);
  if(backend==='fallback')assert.equal(supervisor.runtime.backend,'CPU');
  console.log(backend,'ready',supervisor.child.pid,await request('llamacpp','/models'));
  const load=await request('llamacpp','/models/load',{body:{model:'fixture'}});assert.equal(load.success,true);
  const completion=await request('llamacpp','/completion',{body:{model:'fixture',prompt:'Once upon a time',n_predict:4,temperature:0}});
  assert.equal(typeof completion.content,'string');console.log(backend,'inference',JSON.stringify(completion.content));
  const firstPid=supervisor.child.pid;
  const nextConfig={...config,modelPaths:{fixture:modelFile,second:secondModelFile}};
  const inflight=request('llamacpp','/completion',{body:{model:'fixture',prompt:'Once upon a time',n_predict:64,temperature:0}});
  await assert.rejects(supervisor.acquire(nextConfig,2),{code:'LOCAL_LLAMA_RESTART_BUSY'});
  assert.equal(supervisor.child.pid,firstPid);await inflight;
  lease.release();lease=await supervisor.acquire(nextConfig,2);
  assert.notEqual(supervisor.child.pid,firstPid);assert.throws(()=>process.kill(firstPid,0));
  assert.equal((await request('llamacpp','/models/load',{body:{model:'second'}})).success,true);
  const secondCompletion=await request('llamacpp','/completion',{body:{model:'second',prompt:'Once upon a time',n_predict:4,temperature:0}});
  assert.equal(typeof secondCompletion.content,'string');
  console.log(backend,'A-to-B live revision confirmed; in-flight A preserved',JSON.stringify(secondCompletion.content));
  const pid=supervisor.child.pid;
  const childList=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object -ExpandProperty ProcessId`],{windowsHide:true});
  const children=childList.stdout.trim().split(/\s+/).map(Number).filter(n=>n>0);assert.ok(children.length>0,'router child must really be running');
  console.log(backend,'owned router children',children);
  lease.release();await supervisor.close();
  for(const childPid of children)assert.throws(()=>process.kill(childPid,0),'model child must terminate');
  assert.throws(()=>process.kill(pid,0));
  await assert.rejects(()=>request('llamacpp','/props'));console.log(backend,'closed confirmed',pid);
 }finally{await supervisor.close();}
}

} finally { await fs.rm(modelFixture,{recursive:true,force:true}); }
