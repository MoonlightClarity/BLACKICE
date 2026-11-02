import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbenchJobLease} from '../lib/workbench-job-lease.mjs';
import {spawn} from 'node:child_process';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-job-lease-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const jobId='a'.repeat(32),scopeHash='b'.repeat(64),folder=path.join(root,'.blackice-workbench','agent-jobs',jobId);
  await fs.mkdir(folder,{recursive:true});return {root,folder,jobId,scopeHash,lifetimeMs:10000};
}
test('lease worker stays fresh while the MAIN JavaScript thread is blocked, and stops without later writes',async t=>{
  const f=await fixture(t),lease=createWorkbenchJobLease(f);await lease.ready;
  t.after(()=>lease.stop().catch(()=>{}));
  const target=path.join(f.folder,'lease.json');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);
  const observed=Date.now(),info=await fs.stat(target),value=JSON.parse(await fs.readFile(target,'utf8'));
  assert.ok(observed-info.mtimeMs<500,'worker renewal stalled with the main thread');
  assert.ok(Date.parse(value.expiresAt)>observed+900&&Date.parse(value.expiresAt)<=Date.now()+1500);
  assert.deepEqual(Object.keys(value).sort(),['expiresAt','jobId','scopeHash','version']);
  assert.equal(value.jobId,f.jobId);assert.equal(value.scopeHash,f.scopeHash);assert.equal(lease.error,null);
  await lease.stop();const stopped=await fs.readFile(target,'utf8');await delay(300);
  assert.equal(await fs.readFile(target,'utf8'),stopped);assert.deepEqual(await fs.readdir(f.folder),['lease.json']);
});
test('a fixed monotonic budget expires without renewal or extension and reports a redacted error',async t=>{
  const f=await fixture(t),lease=createWorkbenchJobLease({...f,lifetimeMs:400});await lease.ready;
  await delay(650);assert.equal(lease.error?.code,'WORKBENCH_JOB_LEASE');assert.equal(lease.error.message.includes(f.root),false);
  assert.equal(lease.error.leaseStage,'expired');assert.equal(lease.error.leaseCode,'ETIMEDOUT');
  const target=path.join(f.folder,'lease.json'),expired=await fs.readFile(target,'utf8');await delay(200);
  assert.equal(await fs.readFile(target,'utf8'),expired);await assert.rejects(lease.stop(),{code:'WORKBENCH_JOB_LEASE'});
});
test('invalid identities, budgets and linked job parents never create a lease outside the ordinary private folder',async t=>{
  const f=await fixture(t);
  for(const changed of [{folder:'relative'},{jobId:'../escape'},{scopeHash:'bad'},{lifetimeMs:0},{lifetimeMs:120001},{lifetimeMs:1.5},
    {folder:path.join(f.root,f.jobId)}])assert.throws(()=>createWorkbenchJobLease({...f,...changed}),{code:'WORKBENCH_JOB_LEASE'});
  const outside=path.join(f.root,'outside');await fs.mkdir(outside);
  await fs.rmdir(f.folder);await fs.symlink(outside,f.folder,process.platform==='win32'?'junction':'dir');
  const lease=createWorkbenchJobLease(f);await assert.rejects(lease.ready,{code:'WORKBENCH_JOB_LEASE'});
  assert.equal(lease.error.leaseStage,'validate_path');assert.equal(lease.error.leaseCode,'UNKNOWN');
  await assert.rejects(lease.stop(),{code:'WORKBENCH_JOB_LEASE'});assert.deepEqual(await fs.readdir(outside),[]);
});
test('a replaced lease-file link or unexpected filesystem error fails closed rather than updating another file',async t=>{
  const f=await fixture(t),outsideFolder=path.join(f.root,'outside'),outside=path.join(outsideFolder,'protected.json');
  await fs.mkdir(outsideFolder);await fs.writeFile(outside,'preserve');
  const lease=createWorkbenchJobLease(f);await lease.ready;
  t.after(()=>lease.stop().catch(()=>{}));
  const target=path.join(f.folder,'lease.json');await fs.rm(target);await fs.symlink(outsideFolder,target,process.platform==='win32'?'junction':'dir');
  for(let i=0;i<30&&!lease.error;i++)await delay(20);
  assert.equal(lease.error?.code,'WORKBENCH_JOB_LEASE');assert.equal(await fs.readFile(outside,'utf8'),'preserve');
  assert.equal(lease.error.leaseStage,'validate_path');assert.equal(lease.error.leaseCode,'UNKNOWN');
  await assert.rejects(lease.stop(),{code:'WORKBENCH_JOB_LEASE'});
});

async function waitFor(predicate,description,timeoutMs=4000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){if(await predicate())return;await delay(10)}
  assert.fail(description);
}
async function windowsReader(t,f,{deleteShare=false}={}){
  await fs.mkdir(f.root,{recursive:true});
  const suffix=deleteShare?'delete':'locked',script=path.join(f.root,'reader-'+suffix+'.ps1');
  const ready=path.join(f.root,suffix+'.ready'),release=path.join(f.root,suffix+'.release');
  await fs.writeFile(script,`param([string]$Target,[string]$Ready,[string]$Release,[switch]$DeleteShare)
$ErrorActionPreference='Stop'
$share=[System.IO.FileShare]::ReadWrite
if($DeleteShare){$share=$share -bor [System.IO.FileShare]::Delete}
$handle=[System.IO.File]::Open($Target,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,$share)
try {
  [System.IO.File]::WriteAllText($Ready,'ready')
  $until=[DateTime]::UtcNow.AddSeconds(5)
  while(-not [System.IO.File]::Exists($Release) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 5}
} finally {$handle.Dispose()}
`);
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Target',path.join(f.folder,'lease.json'),'-Ready',ready,'-Release',release,...deleteShare?['-DeleteShare']:[]],{windowsHide:true,stdio:'ignore'});
  let spawnError;child.on('error',error=>{spawnError=error});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let released=false;
  const unlock=async()=>{if(released)return;released=true;await fs.writeFile(release,'release');await exited};
  t.after(unlock);
  await waitFor(async()=>{if(spawnError)throw spawnError;try{return(await fs.stat(ready)).isFile()}catch{return false}},'the isolated read-only fixture did not acquire its file handle');
  return {unlock};
}
test('Windows non-delete-share readers are retried briefly and persistent contention reports only a replace code',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),lease=createWorkbenchJobLease(f);await lease.ready;t.after(()=>lease.stop().catch(()=>{}));
  const reader=await windowsReader(t,f),initial=await fs.readFile(path.join(f.folder,'lease.json'),'utf8');
  await delay(115);await reader.unlock();
  await waitFor(async()=>await fs.readFile(path.join(f.folder,'lease.json'),'utf8')!==initial,'lease did not resume after a short reader lock');
  assert.equal(lease.error,null,'short Windows share contention must not cancel a healthy job');
  const persistent=await windowsReader(t,{...f,root:path.join(f.root,'persistent')});
  await waitFor(()=>lease.error!==null,'persistent share contention must fail closed',1000);
  assert.equal(lease.error.code,'WORKBENCH_JOB_LEASE');assert.equal(lease.error.leaseStage,'replace');
  assert.ok(['EPERM','EACCES','EBUSY'].includes(lease.error.leaseCode));
  assert.doesNotMatch(JSON.stringify(lease.error),/blackice-job-lease|lease\.json|reader-|[A-Z]:\\/i);
  const stopped=await fs.readFile(path.join(f.folder,'lease.json'),'utf8');await delay(200);
  assert.equal(await fs.readFile(path.join(f.folder,'lease.json'),'utf8'),stopped);
  await persistent.unlock();await assert.rejects(lease.stop(),{code:'WORKBENCH_JOB_LEASE'});
  assert.deepEqual(await fs.readdir(f.folder),['lease.json']);
});
test('Windows delete-share readers either permit replacement or produce bounded fail-closed diagnostics',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),lease=createWorkbenchJobLease(f);await lease.ready;t.after(()=>lease.stop().catch(()=>{}));
  const reader=await windowsReader(t,f,{deleteShare:true}),target=path.join(f.folder,'lease.json');
  try{
    const initial=await fs.readFile(target,'utf8');await delay(400);
    if(lease.error){
      assert.equal(lease.error.leaseStage,'replace');assert.ok(['EPERM','EACCES','EBUSY'].includes(lease.error.leaseCode));
      const stopped=await fs.readFile(target,'utf8');await delay(150);assert.equal(await fs.readFile(target,'utf8'),stopped);
    }else assert.notEqual(await fs.readFile(target,'utf8'),initial);
  }finally{await reader.unlock()}
  if(lease.error)await assert.rejects(lease.stop(),{code:'WORKBENCH_JOB_LEASE'});else await lease.stop();
  assert.deepEqual(await fs.readdir(f.folder),['lease.json']);
});

test('metadata renewals bypass a saturated shared libuv pool while MAIN is blocked',{timeout:30000},async t=>{
  const f=await fixture(t),moduleUrl=new URL('../lib/workbench-job-lease.mjs',import.meta.url).href;
  const source=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {pbkdf2} from 'node:crypto';
    import {Worker} from 'node:worker_threads';
    import {setTimeout as delay} from 'node:timers/promises';
    import {createWorkbenchJobLease} from ${JSON.stringify(moduleUrl)};
    const f=${JSON.stringify(f)},state=new Int32Array(new SharedArrayBuffer(8));
    const blocked=new Promise((resolve,reject)=>pbkdf2('public-fixture','public-salt',20000000,32,'sha256',error=>error?reject(error):resolve()));
    const probe=new Worker("const {workerData}=require('node:worker_threads');const fs=require('node:fs');const s=new Int32Array(workerData.state);Atomics.store(s,1,1);fs.stat(workerData.file,()=>Atomics.store(s,0,1));",{eval:true,workerData:{state:state.buffer,file:f.folder},execArgv:[]});
    for(let i=0;i<200&&Atomics.load(state,1)!==1;i++)await delay(5);
    assert.equal(Atomics.load(state,1),1,'the pool probe did not start');
    const lease=createWorkbenchJobLease(f);
    try {
      await Promise.race([lease.ready,delay(1200).then(()=>{throw Error('worker startup was blocked by the shared pool')})]);
      assert.equal(Atomics.load(state,0),0,'the async pool was not saturated at measurement start');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);
      const now=Date.now(),file=f.folder+'/lease.json',stat=fs.statSync(file),value=JSON.parse(fs.readFileSync(file,'utf8'));
      assert.equal(Atomics.load(state,0),0,'the asynchronous pool released before the synchronous lease inspection');
      assert.ok(now-stat.mtimeMs<500,'metadata renewal incorrectly depends on the global pool');
      assert.ok(Date.parse(value.expiresAt)>now+900&&Date.parse(value.expiresAt)<=Date.now()+1500);
      assert.equal(lease.error,null);
      await lease.stop();
      process.stdout.write(JSON.stringify({passed:true,poolStillBlocked:true,leaseAgeMs:now-stat.mtimeMs})+'\\n');
    } finally {await lease.stop().catch(()=>{});await probe.terminate();await blocked}
  `;
  const child=spawn(process.execPath,['--input-type=module','--eval',source],{windowsHide:true,env:{...process.env,UV_THREADPOOL_SIZE:'1'},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill()});
  let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;assert.ok(output.length<4096)});child.stderr.on('data',chunk=>{errors+=chunk;assert.ok(errors.length<16384)});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
  assert.equal(code,0,errors);const result=JSON.parse(output.trim());
  assert.equal(result.passed,true);assert.equal(result.poolStillBlocked,true);assert.ok(result.leaseAgeMs<500);
});
