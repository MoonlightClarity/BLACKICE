import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {createWorkbenchJobLease} from '../lib/workbench-job-lease.mjs';

const supervisor=fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url));
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const readerSource=String.raw`
param([string]$Source,[string]$Workspace,[string]$Folder,[string]$Ready,[string]$Go,[string]$RetryReady,[int]$DeadlineMs=5000)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source);$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed.'}
$guard=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.StartsWith('function Read-JobJson')})[0].Value
if(!$guard -or $guard -match 'Add-Type|CreateJobObject|Start-Process|Invoke-Expression'){throw 'Unsafe guard extraction.'}
. ([scriptblock]::Create($guard))
$script:realReader=(Get-Command Read-JobJson).ScriptBlock
$script:agentReads=0;$script:leaseReads=0;$script:transientReads=0
$script:leaseReadFailures=0;$script:lastLeaseReadFailure=$null;$script:retryReadyElapsedMs=$null
function Read-JobJson([string]$File,[int]$Limit=8192){
  if([IO.Path]::GetFileName($File) -eq 'agent-state.json'){$script:agentReads++}
  if([IO.Path]::GetFileName($File) -eq 'lease.json'){$script:leaseReads++}
  try{
    $value=& $script:realReader $File $Limit
    if([IO.Path]::GetFileName($File) -eq 'lease.json' -and $script:transientReads -gt 0 -and $RetryReady -and ![IO.File]::Exists($RetryReady)){
      $script:retryReadyElapsedMs=$clock.Elapsed.TotalMilliseconds
      [IO.File]::WriteAllText($RetryReady,'contended metadata retry read the live lease')
    }
    return $value
  }catch{
    $transient=$false;$leaseFailureKind='other';$leaseFailureCode=$null
    for($e=$_.Exception;$e;$e=$e.InnerException){
      if($e -is [UnauthorizedAccessException] -or ($e -is [IO.IOException] -and ([int64]$e.HResult -band 65535) -in @(2,3,32,33,303))){$transient=$true}
      if($e -is [UnauthorizedAccessException] -or $e -is [IO.IOException]){$leaseFailureKind=if($e -is [UnauthorizedAccessException]){'access'}else{'io'};$leaseFailureCode=([int64]$e.HResult -band 65535)}
    }
    if([IO.Path]::GetFileName($File) -eq 'lease.json'){$script:leaseReadFailures++;$script:lastLeaseReadFailure=@{kind=$leaseFailureKind;nativeCode=$leaseFailureCode}}
    if($transient){$script:transientReads++};throw
  }
}
$jobId=Split-Path $Folder -Leaf
$context=@{Folder=$Folder;Bridge=(Join-Path $Workspace '.blackice-workbench');Workspace=$Workspace;
  Meta=@{version=1;jobId=$jobId;scopeHash=('c'*64);agentId=('b'*32);guestSessionId=2;hostToGuestOffsetMs=0;timeoutMs=10000}}
[IO.File]::WriteAllText($Ready,'ready')
$wait=[Diagnostics.Stopwatch]::StartNew()
while(![IO.File]::Exists($Go)){if($wait.ElapsedMilliseconds -gt 5000){throw 'Fixture start gate expired.'};Start-Sleep -Milliseconds 5}
$context.Deadline=[datetime]::UtcNow.AddMilliseconds($DeadlineMs)
$clock=[Diagnostics.Stopwatch]::StartNew();$accepted=$false;$errorKind=$null;$tagged=$false
try{Assert-JobAgent $context;$accepted=$true}catch{
  $errorKind='other'
  if($_.Exception.Message -like '*paired guest agent changed or expired*'){$errorKind='identity'}
  elseif($_.Exception.Message -like '*deadline*'){$errorKind='deadline'}
  elseif($_.Exception.Message -like '*lease*' -or $_.Exception.Message -like '*cancel*'){$errorKind='lease-or-cancel'}
  elseif($_.Exception -is [ArgumentException]){$errorKind='json'}
  $tagged=([string]$_.ErrorDetails.Message -like 'Agent-state metadata*') -or ($_.Exception.Message -like 'Agent-state metadata*')
}
@{accepted=$accepted;elapsedMs=$clock.Elapsed.TotalMilliseconds;agentReads=$script:agentReads;leaseReads=$script:leaseReads;
  transientReads=$script:transientReads;errorKind=$errorKind;metadataPhase=$context.AgentMetadataFailure;diagnosticTagged=$tagged;
  leaseFailure=$context.LeaseFailure;leaseReadFailures=$script:leaseReadFailures;lastLeaseReadFailure=$script:lastLeaseReadFailure;retryReadyElapsedMs=$script:retryReadyElapsedMs;supervisorEntryExecuted=$false;childStarted=$false;nativeTypeCreated=($null -ne ('BLACKICEAgentJob' -as [type]))}|ConvertTo-Json -Compress
`;
const holderSource=String.raw`
param([string]$File,[string]$Ready,[string]$Release)
$ErrorActionPreference='Stop'
$stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
  [IO.File]::WriteAllText($Ready,'locked');$timer=[Diagnostics.Stopwatch]::StartNew()
  while(![IO.File]::Exists($Release) -and $timer.ElapsedMilliseconds -lt 6000){Start-Sleep -Milliseconds 5}
}finally{$stream.Dispose()}
`;
async function exists(file){try{return(await fs.stat(file)).isFile()}catch(error){if(error.code==='ENOENT')return false;throw error}}
async function until(predicate,why,timeoutMs=5000){const end=Date.now()+timeoutMs;while(Date.now()<end){if(await predicate())return;await delay(10)}assert.fail(why)}
function child(script,args){
  const process=spawn(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';process.stdout.on('data',bytes=>{stdout+=bytes});process.stderr.on('data',bytes=>{stderr+=bytes});
  const done=new Promise((resolve,reject)=>{process.on('error',reject);process.once('exit',code=>resolve({code,stdout,stderr}))});
  return {process,done};
}
async function fixture(t,{locked=true,deadlineMs=5000,changed=false,malformed=false}={}){
  const begun=performance.now(),timing={},mark=name=>{timing[name]=Math.round((performance.now()-begun)*1000)/1000};
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-metadata-share-')),workspace=path.join(root,'workspace');
  const bridge=path.join(workspace,'.blackice-workbench'),jobId='a'.repeat(32),folder=path.join(bridge,'agent-jobs',jobId),file=path.join(bridge,'agent-state.json');
  await fs.mkdir(folder,{recursive:true});
  const heartbeatAtMs=Date.now();mark('heartbeatCreatedMs');
  await fs.writeFile(file,malformed?'{':JSON.stringify({version:1,agentId:(changed?'d':'b').repeat(32),sessionId:2,interactive:true,guestRoot:workspace,heartbeatAt:new Date(heartbeatAtMs).toISOString()}));
  const readerFile=path.join(root,'reader.ps1'),holderFile=path.join(root,'holder.ps1');await fs.writeFile(readerFile,readerSource);await fs.writeFile(holderFile,holderSource);
  const lease=createWorkbenchJobLease({folder,jobId,scopeHash:'c'.repeat(64),lifetimeMs:10000});await lease.ready;mark('leaseReadyMs');
  const ready=path.join(root,'reader.ready'),go=path.join(root,'reader.go'),retryReady=path.join(root,'reader.retry-ready'),lockedReady=path.join(root,'holder.ready'),release=path.join(root,'holder.release');
  const reader=child(readerFile,['-Source',supervisor,'-Workspace',workspace,'-Folder',folder,'-Ready',ready,'-Go',go,'-RetryReady',retryReady,'-DeadlineMs',String(deadlineMs)]);
  let holder=null,unlocked=false;
  const unlock=async()=>{if(unlocked)return;unlocked=true;mark('unlockRequestedMs');if(holder){await fs.writeFile(release,'release');const result=await holder.done;assert.equal(result.code,0,result.stderr)}mark('unlockCompletedMs')};
  t.after(async()=>{
    await unlock().catch(()=>{});await lease.stop().catch(()=>{});
    if(reader.process.exitCode===null)reader.process.kill();if(holder?.process.exitCode===null)holder.process.kill();
    await Promise.allSettled([reader.done,holder?.done]);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});
  });
  await until(()=>exists(ready),'Reader did not load the isolated source guards.');mark('readerReadyMs');
  if(locked){holder=child(holderFile,['-File',file,'-Ready',lockedReady,'-Release',release]);await until(()=>exists(lockedReady),'Read-only fixture holder did not acquire its private metadata file.');mark('holderLockedMs')}
  const start=async()=>{mark('startRequestedMs');await fs.writeFile(go,'go');mark('startWrittenMs')};
  const result=async()=>{const value=await reader.done;mark('resultReceivedMs');assert.equal(value.code,0,value.stderr);const receipt=JSON.parse(value.stdout.trim());
    for(const key of ['supervisorEntryExecuted','childStarted','nativeTypeCreated'])assert.equal(receipt[key],false);return receipt};
  const diagnostics=()=>({timing:{...timing},heartbeatAgeMs:Date.now()-heartbeatAtMs,leaseError:lease.error?{code:lease.error.code,stage:lease.error.leaseStage,nativeCode:lease.error.leaseCode}:null});
  return {root,workspace,bridge,folder,file,lease,start,result,unlock,retryReady,diagnostics};
}

test('actual metadata guard recovers from a real 350 ms Windows share violation while the guest-job lease remains live',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await f.start();await delay(350);await f.unlock();const receipt=await f.result();
  const diagnostic=JSON.stringify({receipt,fixture:f.diagnostics()});t.diagnostic(diagnostic);
  assert.equal(receipt.accepted,true,diagnostic);assert.ok(receipt.elapsedMs>=250&&receipt.elapsedMs<1500,diagnostic);assert.ok(receipt.transientReads>0);assert.ok(receipt.agentReads>1);assert.ok(receipt.leaseReads>0);
});
test('persistent metadata sharing denial fails closed within the monotonic one-second retry budget',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await f.lease.stop();
  // Isolate the metadata budget from concurrent replacement of the separate
  // authorization file: this exact lease stays valid for the entire 1s check.
  await fs.writeFile(path.join(f.folder,'lease.json'),JSON.stringify({version:1,jobId:'a'.repeat(32),scopeHash:'c'.repeat(64),expiresAt:new Date(Date.now()+1500).toISOString()}));
  await f.start();const receipt=await f.result();await f.unlock();
  assert.equal(receipt.accepted,false);assert.ok(receipt.elapsedMs>=800&&receipt.elapsedMs<1500);assert.ok(receipt.transientReads>0);assert.ok(receipt.leaseReads>0);
  assert.equal(receipt.metadataPhase,'transport_exhausted');assert.equal(receipt.diagnosticTagged,true);
});
test('cancellation interrupts contended metadata retries without waiting for the file to unlock',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await f.start();
  await until(()=>exists(f.retryReady),'The contended metadata reader did not reach a live lease retry.');
  await fs.writeFile(path.join(f.folder,'cancel.json'),JSON.stringify({version:1,jobId:'a'.repeat(32),scopeHash:'c'.repeat(64),requestedAt:new Date().toISOString(),reason:'fixture'}));
  const receipt=await f.result();assert.equal(receipt.accepted,false);assert.ok(receipt.elapsedMs<600);assert.ok(receipt.leaseReads>0);await f.unlock();
  assert.equal(receipt.metadataPhase,'authorization_ended');assert.equal(receipt.diagnosticTagged,true);
});
test('deadline and short lease expiry each interrupt contended metadata retries',{skip:process.platform!=='win32'},async t=>{
  for(const mode of ['deadline','lease']){
    const f=await fixture(t,{deadlineMs:mode==='deadline'?180:5000});
    if(mode==='lease'){await f.lease.stop();await fs.writeFile(path.join(f.folder,'lease.json'),JSON.stringify({version:1,jobId:'a'.repeat(32),scopeHash:'c'.repeat(64),expiresAt:new Date(Date.now()+180).toISOString()}))}
    await f.start();const receipt=await f.result();assert.equal(receipt.accepted,false);assert.ok(receipt.elapsedMs<650,mode+' did not fence retries');await f.unlock();
    assert.equal(receipt.metadataPhase,mode==='deadline'?'deadline_elapsed':'authorization_ended');assert.equal(receipt.diagnosticTagged,true);
  }
});
for(const mode of ['changed','malformed'])test(`${mode} successfully read metadata is rejected immediately rather than retried or replaced by cached identity`,{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t,{locked:false,changed:mode==='changed',malformed:mode==='malformed'});await f.start();const receipt=await f.result();
  assert.equal(receipt.accepted,false);assert.equal(receipt.agentReads,1);assert.equal(receipt.transientReads,0);assert.ok(receipt.elapsedMs<600);
  assert.equal(receipt.metadataPhase,mode==='changed'?'identity_or_freshness':'invalid_metadata');assert.equal(receipt.diagnosticTagged,true);
});
