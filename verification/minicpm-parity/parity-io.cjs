'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash,randomUUID}=require('node:crypto');
const {sha,fail,insist}=require('./parity-contract.cjs');
const execFileAsync=promisify(execFile);
const clock=()=>new Date().toISOString();
function writeAll(fd,bytes){let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);insist(n>0,'File write made no progress.','PARITY_IO');offset+=n;}}
function save(file,value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);const fd=fs.openSync(file,'wx');try{writeAll(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const actual=fs.readFileSync(file);insist(actual.equals(bytes),'File readback differs.','PARITY_IO');return {path:file,bytes:actual.length,sha256:sha(actual)};}
const saveJSON=(file,value)=>save(file,JSON.stringify(value,null,2)+'\n');
function publishTraceConfig({livePath,bytes,expectedPreviousBytes=null,preimagePath=null,record={}}){
 insist(path.isAbsolute(livePath)&&Buffer.isBuffer(bytes),'Absolute live config path and exact bytes required.','PARITY_TRACE_CONFIG');
 insist(expectedPreviousBytes===null||Buffer.isBuffer(expectedPreviousBytes),'Expected previous config must be exact bytes.','PARITY_TRACE_CONFIG');
 Object.assign(record,{path:livePath,complete:false,stage:'checking-preimage',requestedSha256:sha(bytes),requestedBytes:bytes.length,previous:null,temporary:null});
 fs.mkdirSync(path.dirname(livePath),{recursive:true});
 if(expectedPreviousBytes===null){
  insist(!fs.existsSync(livePath),'Metadata-off requires a new shared trace-config path.','PARITY_TRACE_CONFIG_EXISTS');
  record.published=save(livePath,bytes);
 }else{
  insist(path.isAbsolute(preimagePath||'')&&preimagePath!==livePath,'Separate immutable preimage path required.','PARITY_TRACE_CONFIG');
  const before=fs.readFileSync(livePath);record.previous={...save(preimagePath,before),sourcePath:livePath,expectedSha256:sha(expectedPreviousBytes)};
  insist(before.equals(expectedPreviousBytes),'Live trace config does not equal the exact preceding activation-off bytes.','PARITY_TRACE_CONFIG_PREIMAGE');
  record.stage='writing-replacement';const temporary=livePath+'.next-'+randomUUID();record.temporary=save(temporary,bytes);
  insist(fs.readFileSync(livePath).equals(before),'Live trace config changed before replacement.','PARITY_TRACE_CONFIG_PREIMAGE');
  fs.renameSync(temporary,livePath);record.stage='replacement-published';
  const actual=fs.readFileSync(livePath);insist(actual.equals(bytes),'Published trace config readback differs.','PARITY_TRACE_CONFIG');
  record.published={path:livePath,bytes:actual.length,sha256:sha(actual)};
 }
 record.complete=true;record.stage='verified';record.completedAt=clock();return record;
}
const safeError=e=>({name:e?.name||'Error',code:e?.code||null,message:String(e?.message||e)});
async function hashFile(file,deadline){
 insist(path.isAbsolute(file),'Absolute identity path required.');
 const before=fs.statSync(file);insist(before.isFile(),'Identity is not a regular file.');
 const hash=createHash('sha256'),stream=fs.createReadStream(file,{highWaterMark:4*1024*1024});
 const timer=setTimeout(()=>stream.destroy(fail('Identity hashing deadline expired.','PARITY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{for await(const bytes of stream)hash.update(bytes);}finally{clearTimeout(timer);stream.destroy();}
 const after=fs.statSync(file);
 insist(before.size===after.size&&before.mtimeMs===after.mtimeMs,'File changed during identity hashing.','PARITY_IDENTITY_CHANGED');
 return {path:file,bytes:after.size,mtimeMs:after.mtimeMs,sha256:hash.digest('hex')};
}
async function bundleIdentity(executable,deadline){
 const files=[executable,...fs.readdirSync(path.dirname(executable)).filter(n=>/\.dll$/i.test(n)).sort().map(n=>path.join(path.dirname(executable),n))],out=[];
 for(const file of files)out.push(await hashFile(file,deadline));return out;
}
async function portFree(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(resolve));});}
async function powershell(script,timeoutMs=7000){
 insist(process.platform==='win32','This runner requires native Windows.','PARITY_PLATFORM');
 const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const r=await execFileAsync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:timeoutMs,maxBuffer:4*1024*1024});
 return JSON.parse(r.stdout.replace(/^\uFEFF/,'').trim());
}
async function scanServers(){
 return powershell("$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^llama-(server|cli)\\.exe$' } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $items -Depth 5 -Compress");
}
async function inspectChild(pid,port){
 insist(Number.isSafeInteger(pid)&&pid>0&&Number.isInteger(port),'Invalid owned process inspection.');
 const script="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"'; if(!$p){throw 'Owned process is absent'}; $m=@((Get-Process -Id "+pid+" -ErrorAction Stop).Modules | ForEach-Object {[pscustomobject]@{name=$_.ModuleName;path=$_.FileName}}); $l=@(Get-NetTCPConnection -State Listen -LocalPort "+port+" -ErrorAction Stop | ForEach-Object {[pscustomobject]@{pid=[int]$_.OwningProcess;address=$_.LocalAddress;port=[int]$_.LocalPort}}); [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');modules=$m;listeners=$l} | ConvertTo-Json -Depth 8 -Compress";
 return powershell(script);
}
const RESTART_ORIGIN_SOURCE=Object.freeze({
 relativePath:'lib/desktop-restart-origin.mjs',
 sha256:'db7403f6793239462edb4e81606ec2fb22422a271282bd611b75826f15590d44',
 environmentKey:'BLACKICE_RESTART_ORIGIN',
 purpose:'Random per-direct-command application restart capability; excluded only from the owned model child.'
});
function childEnvironment(traceConfigPath,inherited=process.env){
 const env={...inherited},removed=[],removedProvenance=[];
 for(const key of Object.keys(env)){
  const restart=key.toUpperCase()===RESTART_ORIGIN_SOURCE.environmentKey;
  if(restart||/^LLAMA_ARG_|^BLACKICE_TRACE_/i.test(key)){
   removed.push(key);removedProvenance.push({name:key,valueSha256:sha(String(env[key])),reason:restart?'application-only-restart-capability':'explicit-runtime-and-trace-configuration'});
   delete env[key];
  }
 }
 const ordered=()=>Object.fromEntries(Object.entries(env).sort(([a],[b])=>a.localeCompare(b)));
 const fingerprint=sha(JSON.stringify(ordered()));
 const baseVariableHashes=Object.fromEntries(Object.entries(ordered()).map(([name,value])=>[name,sha(String(value))]));
 if(traceConfigPath)env.BLACKICE_TRACE_CONFIG=traceConfigPath;
 const actualFingerprint=sha(JSON.stringify(ordered()));
 const actualVariableHashes=Object.fromEntries(Object.entries(ordered()).map(([name,value])=>[name,sha(String(value))]));
 return {env,removed:removed.sort(),removedProvenance:removedProvenance.sort((a,b)=>a.name.localeCompare(b.name)),fingerprint,baseVariableHashes,actualFingerprint,actualVariableHashes,
  fingerprintScope:'Child environment before the separately captured, explicitly controlled BLACKICE_TRACE_CONFIG path is injected.'};
}
function captureLog(stream,file,bound,onFailure){
 const fd=fs.openSync(file,'wx');let bytes=0,closed=false,problem=null;
 stream.on('data',chunk=>{if(problem)return;try{const data=Buffer.from(chunk);insist(bytes+data.length<=bound,'Child log exceeded its byte bound.','PARITY_LOG_LIMIT');writeAll(fd,data);bytes+=data.length;}catch(e){problem=safeError(e);onFailure(e);}});
 const snapshot=()=>fs.readFileSync(file).toString('utf8');
 const close=()=>{if(!closed){closed=true;try{fs.fsyncSync(fd);}catch(e){problem||=safeError(e);}try{fs.closeSync(fd);}catch(e){problem||=safeError(e);}}const actual=fs.readFileSync(file);return {path:file,bytes:actual.length,sha256:sha(actual),error:problem};};
 return {snapshot,close,get error(){return problem;}};
}
function waitExit(child,ms){if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve(true);return new Promise(resolve=>{const end=()=>{clearTimeout(timer);resolve(true);};const timer=setTimeout(()=>{child.removeListener('exit',end);resolve(false);},ms);child.once('exit',end);});}
async function settleChild(child,budgetMs){
 const at=clock();if(!child?.pid)return {settled:true,spawned:false,at};
 let requested=null,killError=null;
 if(child.exitCode===null&&child.signalCode===null){requested='SIGTERM via the owned ChildProcess handle';try{child.kill('SIGTERM');}catch(e){killError=safeError(e);}}
 let settled=await waitExit(child,Math.max(1,Math.floor(budgetMs*.75)));
 if(!settled){try{child.kill('SIGKILL');requested+='; SIGKILL via the same owned handle';}catch(e){killError||=safeError(e);}settled=await waitExit(child,Math.max(1,Math.floor(budgetMs*.2)));}
 return {at,finishedAt:clock(),pid:child.pid,settled,requested,exitCode:child.exitCode,signalCode:child.signalCode,killError,
  scope:'Only this spawned standalone child. No port-based, process-name-based, or global process termination.'};
}
function requestRecorder({directory,port,profile,signal,deadline,requests}){
 let sequence=0;
 return async function request(name,route,body,{timeoutMs=profile.limits.requestMs}={}){
  const index=++sequence,folder=path.join(directory,String(index).padStart(3,'0')+'-'+name);fs.mkdirSync(folder);
  const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)),exchangeId=randomUUID(),attemptId=randomUUID(),method=body===undefined?'GET':'POST';
  const requestBody=save(path.join(folder,'request.body.bin'),bytes);
  const headers={Accept:'application/json, text/event-stream','X-Blackice-Exchange-Id':exchangeId,'X-Blackice-Attempt-Id':attemptId,'X-Blackice-Request-Sha256':requestBody.sha256,...(body===undefined?{}:{'Content-Type':'application/json'})};
  const entry={index,name,at:clock(),method,route,exchangeId,attemptId,bodySha256:requestBody.sha256,bodyBytes:bytes.length,body:requestBody,headers,complete:false};requests.push(entry);
  saveJSON(path.join(folder,'request-open.json'),entry);
  const responsePath=path.join(folder,'response.body.bin');
  const remaining=Math.min(timeoutMs,deadline-Date.now());insist(remaining>0,'Probe deadline expired.','PARITY_TIMEOUT');
  const combined=AbortSignal.any([signal,AbortSignal.timeout(remaining)]);
  const fd=fs.openSync(responsePath,'wx');let count=0,response=null,ended=false,reader=null,cause=null;
  try{
   response=await fetch('http://127.0.0.1:'+port+route,{method,headers,...(body===undefined?{}:{body:bytes}),redirect:'error',signal:combined});
   entry.response={status:response.status,headers:Object.fromEntries(response.headers.entries()),bodyPath:responsePath,complete:false};
   insist(response.body?.getReader,'Response body reader is unavailable.','PARITY_PROTOCOL');reader=response.body.getReader();
   while(true){const next=await reader.read();if(next.done){ended=true;break;}const b=Buffer.from(next.value);insist(count+b.length<=profile.limits.responseBytes,'Response exceeded the explicit bound.','PARITY_RESPONSE_LIMIT');writeAll(fd,b);count+=b.length;}
   fs.fsyncSync(fd);
  }catch(e){cause=e;entry.error=safeError(e);}
  finally{if(reader){if(!ended)try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}try{fs.fsyncSync(fd);}catch(e){cause||=e;entry.error||=safeError(e);}fs.closeSync(fd);}
  const actual=fs.readFileSync(responsePath);entry.response={...(entry.response||{}),bodyPath:responsePath,bodySha256:sha(actual),bodyBytes:actual.length,complete:ended&&!cause,terminal:ended?'http-body-eof':'incomplete'};
  entry.complete=entry.response.complete;entry.finishedAt=clock();entry.settled=saveJSON(path.join(folder,'request-settled.json'),entry);
  if(cause)throw cause;
  return {request:entry,response:entry.response,bytes:actual,json:()=>JSON.parse(actual.toString('utf8'))};
 };
}
module.exports={RESTART_ORIGIN_SOURCE,publishTraceConfig,clock,save,saveJSON,safeError,hashFile,bundleIdentity,portFree,scanServers,inspectChild,childEnvironment,captureLog,settleChild,requestRecorder};
