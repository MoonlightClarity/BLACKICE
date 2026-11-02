import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const supervisor=fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function ordinaryBytes(file,limit){
  const info=await fs.lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=limit,'Preflight snapshot must contain bounded ordinary files.');
  const bytes=await fs.readFile(file);assert.ok(bytes.length<=limit);return bytes;
}
async function snapshot(){
  const observed=process.env.BLACKICE_WORKBENCH_PREFLIGHT_OBSERVED_JOB;
  if(observed){
    assert.ok(path.isAbsolute(observed),'Observed fixture requires an absolute local job path.');
    const bridge=path.resolve(observed,'..','..');
    const [job,body,host,agent]=await Promise.all([ordinaryBytes(path.join(observed,'job.json'),12000),ordinaryBytes(path.join(observed,'body.ps1'),524288),
      ordinaryBytes(path.join(bridge,'host-info.json'),16384),ordinaryBytes(path.join(bridge,'agent-state.json'),32000)]);
    return {job,body,host,agent,observed:true};
  }
  const body=Buffer.from("throw 'This guard fixture must never execute.'\r\n"),now=new Date(),jobId='a'.repeat(32),agentId='b'.repeat(32);
  const meta={version:1,jobId,scriptSha256:sha(body),hostName:os.hostname(),guestName:'BLACKICE-GUEST-FIXTURE',guestSessionId:999,
    agentId,deadlineAt:new Date(+now+30000).toISOString(),scopeHash:'c'.repeat(64),workspaceGuestRoot:'W:\\',ownerRevision:1,timeoutMs:30000,hostToGuestOffsetMs:0};
  return {job:Buffer.from(JSON.stringify(meta)),body,host:Buffer.from(JSON.stringify({version:1,hostName:meta.hostName})),
    agent:Buffer.from(JSON.stringify({version:1,agentId,sessionId:meta.guestSessionId,interactive:true,heartbeatAt:now.toISOString(),guestRoot:'W:\\'})),observed:false};
}

test('actual supervisor scope/context reject host identity before any job mutation, with bounded agent metadata retries',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-preflight-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.match(path.basename(root),/^blackice-preflight-/);await fs.rm(root,{recursive:true,force:true})});
  const saved=await snapshot(),meta=JSON.parse(saved.job.toString('utf8').replace(/^\uFEFF/,''));
  assert.match(meta.jobId,/^[a-f0-9]{32}$/);assert.match(meta.workspaceGuestRoot,/^[A-Za-z]:\\$/);
  assert.equal(sha(saved.body),meta.scriptSha256,'The observed body must retain its exact staged hash.');
  const workspace=path.join(root,'workspace'),bridge=path.join(workspace,'.blackice-workbench'),job=path.join(bridge,'agent-jobs',meta.jobId);
  await fs.mkdir(job,{recursive:true});
  await Promise.all([fs.writeFile(path.join(job,'job.json'),saved.job),fs.writeFile(path.join(job,'body.ps1'),saved.body),
    fs.writeFile(path.join(bridge,'host-info.json'),saved.host),fs.writeFile(path.join(bridge,'agent-state.json'),saved.agent)]);
  const checker=path.join(root,'check.ps1');
  await fs.writeFile(checker,String.raw`
param([string]$Source,[string]$Workspace,[string]$LogicalRoot,[string]$JobId)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source);$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor source did not parse.'}
$strings=$ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)
$guard=@($strings|Where-Object {$_.Value.StartsWith('function Read-JobJson')})[0].Value
if(!$guard -or $guard -match 'Add-Type|Start-Process|CreateJobObject|Set-Content|WriteAllText|WriteAllBytes|CreateNew|Start-Job|Invoke-Expression'){throw 'Guard source unexpectedly contains mutation or process creation.'}
$computerBefore=$env:COMPUTERNAME;$sessionBefore=[Diagnostics.Process]::GetCurrentProcess().SessionId
$nativeBefore=$null -ne ('BLACKICEAgentJob' -as [type])
. ([scriptblock]::Create($guard))
$script:realReader=(Get-Command Read-JobJson).ScriptBlock
$script:reads=[Collections.Generic.List[string]]::new()
$script:FixtureWorkspace=$Workspace;$script:FixtureLogicalRoot=$LogicalRoot
function Join-Path([string]$Path,[string]$ChildPath){return [IO.Path]::Combine($Path,$ChildPath)}
function Split-Path([string]$Path,[switch]$Parent,[switch]$Leaf){
  if($Leaf){return [IO.Path]::GetFileName($Path.TrimEnd('\'))}
  if($Parent){return [IO.Path]::GetDirectoryName($Path)}
  throw 'Fixture requires an explicit path operation.'
}
function Map-Fixture([string]$File){
  if($File.StartsWith($script:FixtureLogicalRoot,[StringComparison]::OrdinalIgnoreCase)){
    return Join-Path $script:FixtureWorkspace $File.Substring($script:FixtureLogicalRoot.Length).TrimStart('\')
  }
  return $File
}
function Get-Item {
  [CmdletBinding()]param([string]$LiteralPath)
  Microsoft.PowerShell.Management\Get-Item -LiteralPath (Map-Fixture $LiteralPath) -ErrorAction Stop
}
function Read-JobJson([string]$File,[int]$Limit=8192){
  $script:reads.Add((Split-Path $File -Leaf))
  & $script:realReader (Map-Fixture $File) $Limit
}
$logicalFolder=Join-Path $LogicalRoot ('.blackice-workbench\agent-jobs\'+$JobId)
foreach($name in @('Get-JobScope','Get-JobContext')){
  $failure=$null
  try{&$name $logicalFolder|Out-Null}catch{$failure=$_.Exception.Message}
  if($failure -cne 'Refusing to execute outside the exact interactive Windows guest.'){throw 'Actual scope/context did not reject at the host identity guard.'}
}
if(($script:reads -join ',') -cne 'job.json,host-info.json,job.json,host-info.json'){throw 'Host preflight read agent/body data before rejecting host identity.'}
if($computerBefore -cne $env:COMPUTERNAME -or $sessionBefore -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'Fixture altered real host identity.'}
if(($null -ne ('BLACKICEAgentJob' -as [type])) -ne $nativeBefore){throw 'Fixture created the native job type.'}
$physical=Join-Path $Workspace ('.blackice-workbench\agent-jobs\'+$JobId)
if(@(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $physical -File).Count -ne 2){throw 'Host preflight mutated the job folder.'}

# Exercise the actual source Assert-JobAgent independently, without spoofing
# COMPUTERNAME/session or running Get-JobContext as a fabricated guest.
$meta=& $script:realReader (Join-Path $physical 'job.json')
$context=@{Bridge=(Join-Path $LogicalRoot '.blackice-workbench');Workspace=$LogicalRoot;Meta=$meta}
$script:state=[pscustomobject]@{version=1;agentId=$meta.agentId;sessionId=$meta.guestSessionId;interactive=$true;heartbeatAt=[datetime]::UtcNow.ToString('o');guestRoot=$LogicalRoot}
$script:attempts=0;$script:sleeps=[Collections.Generic.List[int]]::new();$script:mode='recover';$script:mono=0;$script:leaseValid=$true
function Job-MonotonicMs(){return $script:mono}
function Test-JobLease($Context){return $script:leaseValid}
function Start-Sleep([int]$Milliseconds){$script:sleeps.Add($Milliseconds);$script:mono+=$Milliseconds}
function Read-JobJson([string]$File,[int]$Limit=8192){
  $script:attempts++
  if($script:mode -eq 'missing' -or ($script:mode -eq 'recover' -and $script:attempts -lt 3)){throw [IO.FileNotFoundException]::new('Synthetic missing-file gap.')}
  if($script:mode -eq 'access' -or ($script:mode -eq 'access_recover' -and $script:attempts -lt 3)){throw [UnauthorizedAccessException]::new('Synthetic replacement access gap.')}
  if($script:mode -eq 'sharing' -or ($script:mode -eq 'sharing_recover' -and $script:attempts -lt 3)){throw [IO.IOException]::new('Synthetic sharing gap.',-2147024864)}
  if($script:mode -eq 'lock' -or ($script:mode -eq 'delete_recover' -and $script:attempts -lt 3)){throw [IO.IOException]::new('Synthetic lock/delete gap.',$(if($script:mode -eq 'lock'){-2147024863}else{-2147024593}))}
  if($script:mode -eq 'other_io'){throw [IO.IOException]::new('Synthetic nontransient IO failure.',-2147024809)}
  if($script:mode -eq 'malformed'){throw [FormatException]::new('Synthetic invalid metadata.')}
  return $script:state
}
Assert-JobAgent $context
if($script:attempts -ne 3 -or ($script:sleeps -join ',') -cne '25,25'){throw 'Missing-file recovery exceeded three reads or two 25ms waits.'}
foreach($mode in @('access_recover','sharing_recover','delete_recover')){
  $script:mode=$mode;$script:attempts=0;$script:sleeps.Clear();$script:mono=0;Assert-JobAgent $context
  if($script:attempts -ne 3 -or ($script:sleeps -join ',') -cne '25,25'){throw 'A transient replacement read did not recover within bounded waits.'}
}
foreach($mode in @('missing','access','sharing','lock','other_io','malformed','changed')){
  $script:mode=$mode;$script:attempts=0;$script:sleeps.Clear();$script:mono=0;$script:state.agentId=$meta.agentId
  if($mode -eq 'changed'){$script:state.agentId=if($meta.agentId -eq ('d'*32)){'e'*32}else{'d'*32}}
  $rejected=$false;try{Assert-JobAgent $context}catch{$rejected=$true}
  if(!$rejected){throw 'Invalid metadata passed actual Assert-JobAgent.'}
  if($mode -in @('missing','access','sharing','lock')){
    if($script:attempts -ne 41 -or $script:sleeps.Count -ne 40 -or $script:mono -ne 1000){throw 'Persistent replacement retries exceeded their monotonic one-second bound.'}
  }elseif($script:attempts -ne 1 -or $script:sleeps.Count -ne 0){throw 'Malformed/changed identity was retried instead of rejected.'}
}
$script:state.agentId=$meta.agentId;$script:mode='access';$script:attempts=0;$script:sleeps.Clear();$script:mono=0;$script:leaseValid=$false
$rejected=$false;try{Assert-JobAgent $context}catch{$rejected=$true}
if(!$rejected -or $script:attempts -ne 1 -or $script:sleeps.Count){throw 'A failed current authorization was ignored during metadata contention.'}
$script:leaseValid=$true;$context.AgentFreshUntilMonotonicMs=100;$script:attempts=0;$script:mono=0;$script:sleeps.Clear()
$rejected=$false;try{Assert-JobAgent $context}catch{$rejected=$true}
if(!$rejected -or $script:mono -ne 100 -or $script:attempts -ne 5){throw 'Metadata retry outlived its last actually verified heartbeat freshness.'}
$context.AgentFreshUntilMonotonicMs=20000;$context.Deadline=[datetime]::UtcNow.AddSeconds(-1);$script:attempts=0;$script:mono=0;$script:sleeps.Clear()
$rejected=$false;try{Assert-JobAgent $context}catch{$rejected=$true}
if(!$rejected -or $script:attempts -ne 1 -or $script:sleeps.Count){throw 'An expired job deadline was ignored during metadata contention.'}
@{passed=$true;hostIdentityRejected=$true;contextCalled=$true;scopeCalled=$true;jobFolderUnchanged=$true;bodyExecuted=$false;
  supervisorEntryExecuted=$false;nativeTypeCreated=$false;childStarted=$false;identitySpoofed=$false;retryBudgetMs=1000;maxWaitMs=25;changedAttempts=1;malformedAttempts=1}|ConvertTo-Json -Compress
`);
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(executable,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',checker,'-Source',supervisor,
    '-Workspace',workspace,'-LogicalRoot',meta.workspaceGuestRoot,'-JobId',meta.jobId],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout.trim());
  assert.equal(receipt.passed,true);assert.equal(receipt.hostIdentityRejected,true);assert.equal(receipt.contextCalled,true);assert.equal(receipt.jobFolderUnchanged,true);
  for(const name of ['bodyExecuted','supervisorEntryExecuted','nativeTypeCreated','childStarted','identitySpoofed'])assert.equal(receipt[name],false,name);
  assert.equal(receipt.retryBudgetMs,1000);assert.equal(receipt.maxWaitMs,25);assert.equal(receipt.changedAttempts,1);assert.equal(receipt.malformedAttempts,1);
  assert.deepEqual((await fs.readdir(job)).sort(),['body.ps1','job.json']);assert.equal(sha(await fs.readFile(path.join(job,'body.ps1'))),meta.scriptSha256);
  t.diagnostic(saved.observed?'Exact observed job/body/host-info/agent-state snapshot verified without exposing its contents.':'Portable synthetic metadata snapshot verified.');
});
