import path from 'node:path';
import {Worker} from 'node:worker_threads';

const stages=new Set(['validate_path','open_temp','write_temp','replace','cleanup','worker_start','worker_exit','expired']);
const codes=new Set(['EPERM','EACCES','EBUSY','ENOENT','ENOTDIR','EEXIST','EINVAL','EIO','ETIMEDOUT']);
const failure=(stage='worker_exit',code)=>Object.assign(Error('The guest job lease could not be maintained.'),{
  code:'WORKBENCH_JOB_LEASE',leaseStage:stages.has(stage)?stage:'worker_exit',leaseCode:codes.has(code)?code:'UNKNOWN'});

/** Metadata-only worker; its fixed lifetime cannot be extended by its caller. */
export function createWorkbenchJobLease({folder,jobId,scopeHash,lifetimeMs}={}){
  if(typeof folder!=='string'||!path.isAbsolute(folder)||/[\0\r\n]/.test(folder)||
    !/^[a-f0-9]{32}$/.test(jobId??'')||!/^[a-f0-9]{64}$/.test(scopeHash??'')||
    path.basename(folder)!==jobId||path.basename(path.dirname(folder))!=='agent-jobs'||
    path.basename(path.dirname(path.dirname(folder)))!=='.blackice-workbench'||
    !Number.isSafeInteger(lifetimeMs)||lifetimeMs<1||lifetimeMs>120000)throw failure('validate_path');
  let worker;try{worker=new Worker(new URL('./workbench-job-lease-worker.mjs',import.meta.url),
    {workerData:{folder:path.resolve(folder),jobId,scopeHash,lifetimeMs},execArgv:[]});}catch(error){throw failure('worker_start',error?.code)}
  let resolveReady,rejectReady,settled=false,exited=false,stopPromise,resolveStop,rejectStop,stopTimer;
  const entry={ready:new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject}),error:null,stop};
  // Callers still receive rejection; this also prevents a failed startup from
  // becoming an unhandled rejection while the main event loop is occupied.
  void entry.ready.catch(()=>{});
  const failed=(stage,code)=>{entry.error??=failure(stage,code);if(!settled){settled=true;rejectReady(entry.error)}};
  worker.on('message',message=>{
    if(message?.type==='ready'&&!settled){settled=true;resolveReady({ready:true})}
    else if(message?.type==='error'||message?.type==='expired')failed(message.stage,message.code);
  });
  worker.on('error',error=>failed('worker_exit',error?.code));
  worker.once('exit',()=>{
    exited=true;clearTimeout(stopTimer);
    if(!stopPromise)failed('worker_exit');
    else if(entry.error)rejectStop(entry.error);else resolveStop();
    if(!settled){settled=true;rejectReady(entry.error??failure())}
  });
  function stop(){
    if(stopPromise)return stopPromise;
    if(exited)return entry.error?Promise.reject(entry.error):Promise.resolve();
    stopPromise=new Promise((resolve,reject)=>{resolveStop=resolve;rejectStop=reject});
    try{worker.postMessage({type:'stop'})}catch(error){failed('worker_exit',error?.code);void worker.terminate().catch(()=>{});}
    stopTimer=setTimeout(()=>{failed('worker_exit','ETIMEDOUT');void worker.terminate().catch(()=>{rejectStop(entry.error)});},2000);
    stopTimer.unref?.();return stopPromise;
  }
  return entry;
}
