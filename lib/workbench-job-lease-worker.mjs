import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

const {folder,jobId,scopeHash,lifetimeMs}=workerData??{};
let stopping=false,timer=null,activeWrite=null,ready=false;
let lastSuccessfulLeaseExpiresAt=0;
const deadline=performance.now()+lifetimeMs;
const expired=()=>performance.now()>=deadline;
const stages=new Set(['validate_path','open_temp','write_temp','replace','cleanup','worker_start','worker_exit','expired']);
const codes=new Set(['EPERM','EACCES','EBUSY','ENOENT','ENOTDIR','EEXIST','EINVAL','EIO','ETIMEDOUT']);
const diagnostic=(stage,error)=>({stage:stages.has(stage)?stage:'worker_exit',code:codes.has(error?.code)?error.code:'UNKNOWN'});
const notify=(type,details={})=>{try{parentPort.postMessage({type,...details})}catch{}};
function ordinaryFolder(){
  if(typeof folder!=='string'||!path.isAbsolute(folder)||!/^[a-f0-9]{32}$/.test(jobId??'')||
    !/^[a-f0-9]{64}$/.test(scopeHash??'')||!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1||lifetimeMs>120000||
    path.basename(folder)!==jobId||path.basename(path.dirname(folder))!=='agent-jobs'||
    path.basename(path.dirname(path.dirname(folder)))!=='.blackice-workbench')throw Error();
  for(let cursor=folder;;cursor=path.dirname(cursor)){
    const info=fs.lstatSync(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw Error();
    if(cursor===path.dirname(cursor))break;
  }
  const target=path.join(folder,'lease.json');
  try{const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink())throw Error();}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
async function writeLease(){
  let stage='validate_path';
  try{ordinaryFolder()}catch(error){throw diagnostic(stage,error)}
  if(stopping||expired())return false;
  if(lastSuccessfulLeaseExpiresAt&&performance.now()>=lastSuccessfulLeaseExpiresAt)throw {stage:'expired',code:'ETIMEDOUT'};
  const target=path.join(folder,'lease.json'),temporary=path.join(folder,'lease.json.'+randomBytes(8).toString('hex')+'.tmp');
  let handle,problem=null,written=false;
  try{
    stage='open_temp';
    handle=fs.openSync(temporary,'wx',0o600);
    stage='write_temp';
    const payloadExpiresAt=performance.now()+1500;
    const payload=JSON.stringify({version:1,jobId,scopeHash,expiresAt:new Date(Date.now()+1500).toISOString()});
    fs.writeFileSync(handle,payload,'utf8');
    fs.closeSync(handle);handle=null;
    // Windows readers may deny FILE_SHARE_DELETE briefly. Retry only replacement
    // contention, without refreshing the sealed payload or an existing lease.
    const retryUntil=Math.min(performance.now()+150,deadline,payloadExpiresAt,lastSuccessfulLeaseExpiresAt||Infinity);
    while(!stopping&&!expired()){
      stage='validate_path';ordinaryFolder();
      stage='replace';
      if(performance.now()>=payloadExpiresAt||lastSuccessfulLeaseExpiresAt&&performance.now()>=lastSuccessfulLeaseExpiresAt)throw {code:'ETIMEDOUT'};
      try{fs.renameSync(temporary,target);lastSuccessfulLeaseExpiresAt=payloadExpiresAt;written=true;break;}
      catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes(error?.code)||performance.now()>=retryUntil)throw error;
        await delay(Math.min(25,Math.max(1,retryUntil-performance.now())));
        if(performance.now()>=retryUntil)throw error;
      }
    }
  }catch(error){problem=diagnostic(stage,error)}
  finally{
    try{if(handle!==null&&handle!==undefined)fs.closeSync(handle);fs.rmSync(temporary,{force:true})}
    catch(error){problem??=diagnostic('cleanup',error)}
  }
  if(problem)throw problem;
  return written;
}
function end(type,details={}){stopping=true;clearTimeout(timer);notify(type,details);parentPort.close();}
async function tick(){
  if(stopping)return;
  if(expired()){end('expired',{stage:'expired',code:'ETIMEDOUT'});return;}
  let written;
  try{activeWrite=writeLease();written=await activeWrite;}catch(error){if(!stopping)end('error',diagnostic(error?.stage,error));return;}
  finally{activeWrite=null;}
  if(stopping)return;
  if(expired()||!written){end('expired',{stage:'expired',code:'ETIMEDOUT'});return;}
  if(!ready){ready=true;notify('ready')}
  timer=setTimeout(()=>void tick(),Math.min(100,Math.max(1,deadline-performance.now())));
}
parentPort.on('message',async message=>{
  if(message?.type!=='stop'||stopping)return;
  stopping=true;clearTimeout(timer);
  try{await activeWrite}catch{}
  notify('stopped');parentPort.close();
});
void tick();
