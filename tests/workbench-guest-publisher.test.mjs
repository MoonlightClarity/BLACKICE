import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../scripts/workbench-guest-agent.ps1',import.meta.url));
const supervisor=fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url));
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const script=String.raw`
param([string]$Source,[string]$Supervisor,[string]$Root)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source);$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Agent source did not parse.'}
$native=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.Contains('public static class BLACKICEGuestJson')})[0].Value
$save=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-Json'},$true))[0].Extent.Text
$heartbeat=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-Heartbeat'},$true))[0].Extent.Text
if(@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Write-Heartbeat'},$true)).Count -ne 1){throw 'Startup heartbeat must stay inside the recoverable agent loop.'}
if(!$native -or !$save -or $save -match 'Move-Item|Remove-Item|WriteAllText'){throw 'Guest publication still uses provider replacement.'}
$extra=@'
public static class BLACKICEPublisherFixture {
 public static volatile bool Stop;
 public static volatile int Writes;
 public static volatile string Error;
 public static System.Threading.Thread Start(string file){
  Stop=false;Writes=0;Error=null;
  var thread=new System.Threading.Thread(delegate(){
   try{while(!Stop){int value=Writes+1;BLACKICEGuestJson.Publish(file,Json(value));Writes=value;System.Threading.Thread.Sleep(2);}}
   catch(System.Exception exception){Error=exception.GetType().FullName+":"+exception.Message+" native="+(exception is System.ComponentModel.Win32Exception?((System.ComponentModel.Win32Exception)exception).NativeErrorCode:0)+" hresult=0x"+exception.HResult.ToString("X8");}
  });thread.IsBackground=true;thread.Start();return thread;
 }
 public static string Json(int value){return "{\"sequence\":"+value+",\"inverse\":"+(-value)+",\"payload\":\""+value+":"+new string('x',4096)+"\"}";}
 public static System.Threading.Thread Hold(string file,int milliseconds){
  var opened=new System.Threading.ManualResetEvent(false);
  var thread=new System.Threading.Thread(delegate(){
   using(var stream=new System.IO.FileStream(file,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.Read)){
    opened.Set();System.Threading.Thread.Sleep(milliseconds);
   }
  });thread.IsBackground=true;thread.Start();if(!opened.WaitOne(3000))throw new System.Exception("Fixture holder did not start.");return thread;
 }
}
'@
Add-Type -TypeDefinition ($native+[Environment]::NewLine+$extra)
. ([scriptblock]::Create($save))
. ([scriptblock]::Create($heartbeat))
$Bridge=$Root
$guardText=[IO.File]::ReadAllText($Supervisor);$guardTokens=$null;$guardErrors=$null
$guardAst=[Management.Automation.Language.Parser]::ParseInput($guardText,[ref]$guardTokens,[ref]$guardErrors)
if($guardErrors.Count){throw 'Supervisor source did not parse.'}
$guard=@($guardAst.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)|Where-Object {$_.Value.StartsWith('function Read-JobJson')})[0].Value
if(!$guard){throw 'Actual metadata reader was not found.'}
. ([scriptblock]::Create($guard))
$file=Join-Path $Root 'agent-state.json'
Save-Json $file ([ordered]@{sequence=0;inverse=0;payload=('0:'+('x'*4096))})
$beforeAcl=[IO.File]::GetAccessControl($file).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$publisher=[BLACKICEPublisherFixture]::Start($file)
$timer=[Diagnostics.Stopwatch]::StartNew();$reads=0;$failures=0;$last=0;$regressions=0
try{
 # Exercise a minimum number of atomic publications, rather than imposing an
 # incidental local-disk throughput target on a flushed SMB transport. The
 # owned fixture still has the same 30-second outer process deadline.
 while($timer.ElapsedMilliseconds -lt 2500 -or $reads -lt 50 -or [BLACKICEPublisherFixture]::Writes -lt 50){
  if([BLACKICEPublisherFixture]::Error){throw ('Fixture publisher failed: '+[BLACKICEPublisherFixture]::Error+' reads='+$reads+' writes='+[BLACKICEPublisherFixture]::Writes+' readFailures='+$failures+' regressions='+$regressions+' elapsedMs='+$timer.ElapsedMilliseconds)}
  try{
   $value=Read-JobJson $file 16000
   if($value.sequence -lt $last){$regressions++}
   if($value.inverse -ne -$value.sequence -or $value.payload -cne (([string]$value.sequence)+':'+('x'*4096))){throw 'Torn publication.'}
   $last=$value.sequence;$reads++
  }catch{$failures++}
 }
}finally{[BLACKICEPublisherFixture]::Stop=$true;if(!$publisher.Join(2000)){throw 'Fixture publisher did not stop.'}}
$afterAcl=[IO.File]::GetAccessControl($file).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$stress=@{reads=$reads;writes=[BLACKICEPublisherFixture]::Writes;failures=$failures;regressions=$regressions;publisherError=[BLACKICEPublisherFixture]::Error;inheritedAclUnchanged=($beforeAcl -ceq $afterAcl)}
$holder=[BLACKICEPublisherFixture]::Hold($file,120);$clock=[Diagnostics.Stopwatch]::StartNew()
[BLACKICEGuestJson]::Publish($file,'{"sequence":7001}');$shortMs=$clock.ElapsedMilliseconds;$holder.Join()
$short=@{elapsedMs=$shortMs;value=(Read-JobJson $file).sequence}
$holder=[BLACKICEPublisherFixture]::Hold($file,600);$clock.Restart();$failure=$false;$code=0
try{[BLACKICEGuestJson]::Publish($file,'{"sequence":7002}')}catch{
 $failure=$true;for($exception=$_.Exception;$exception;$exception=$exception.InnerException){if($exception -is [ComponentModel.Win32Exception]){$code=$exception.NativeErrorCode}}
}
$failedMs=$clock.ElapsedMilliseconds;$retained=(Read-JobJson $file).sequence;$holder.Join()
$persistent=@{failed=$failure;code=$code;elapsedMs=$failedMs;retained=$retained;temporaryFiles=@([IO.Directory]::GetFiles($Root,'*.tmp')).Count}
$AgentId='b'*32;$SessionId=2;$WorkspaceRoot=$Root;$Interactive=$true;$AgentCapabilities=@('capture')
$holder=[BLACKICEPublisherFixture]::Hold($file,600);$heartbeatFailed=$false
try{Write-Heartbeat}catch{$heartbeatFailed=$true}
$heartbeatRetained=(Read-JobJson $file).sequence;$holder.Join();Write-Heartbeat
$heartbeatState=Read-JobJson $file 32000
$recovery=@{failureObserved=$heartbeatFailed;retained=$heartbeatRetained;agentId=$heartbeatState.agentId;failures=$heartbeatState.publication.failures;
 lastErrorCode=$heartbeatState.publication.lastErrorCode;lastFailureAt=$heartbeatState.publication.lastFailureAt;heartbeatAt=$heartbeatState.heartbeatAt}
$unicode='plain '+[char]0x4f60+[char]0x597d+' '+[char]0x03b4+' '+[char]::ConvertFromUtf32(0x1f9ca)
Save-Json $file @{text=$unicode};$roundtrip=(Read-JobJson $file).text -ceq $unicode
$tooLarge=$false;try{[BLACKICEGuestJson]::Publish($file,('x'*524289))}catch{$tooLarge=$true}
$directoryRejected=$false;$destination=Join-Path $Root 'directory-target';[IO.Directory]::CreateDirectory($destination)|Out-Null
try{[BLACKICEGuestJson]::Publish($destination,'{}')}catch{$directoryRejected=$true}
$outsideRejected=$false;try{Save-Json (Join-Path (Split-Path $Root -Parent) 'outside.json') @{invalid=$true}}catch{$outsideRejected=$true}
$linkRejected=$null
if([IO.Directory]::Exists((Join-Path $Root 'linked'))){try{[BLACKICEGuestJson]::Publish((Join-Path $Root 'linked\escape.json'),'{}');$linkRejected=$false}catch{$linkRejected=$true}}
@{stress=$stress;shortLock=$short;persistentLock=$persistent;recovery=$recovery;unicodeRoundtrip=$roundtrip;oversizeRejected=$tooLarge;directoryRejected=$directoryRejected;
 outsideRejected=$outsideRejected;reparseRejected=$linkRejected;agentEntryExecuted=$false;supervisorEntryExecuted=$false;childStarted=$false}|ConvertTo-Json -Compress -Depth 5
`;

async function execute(base){
  const root=await fs.mkdtemp(path.join(base,'blackice-publisher-'));
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-publisher-source-'));
  const file=path.join(local,'fixture.ps1');
  let linked=false;
  try{
    await fs.mkdir(path.join(root,'ordinary'));
    try{await fs.symlink(path.join(root,'ordinary'),path.join(root,'linked'),'junction');linked=true}catch{}
    await fs.writeFile(file,script);
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Source',source,'-Supervisor',supervisor,'-Root',root],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Host fixture exceeded 30 seconds.'))},30000);
      child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.on('error',reject);
      child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
    });
    assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(result.stdout.trim());
    if(linked)assert.equal(receipt.reparseRejected,true);
    for(const key of ['agentEntryExecuted','supervisorEntryExecuted','childStarted'])assert.equal(receipt[key],false);
    return receipt;
  }finally{
    if(linked)await fs.unlink(path.join(root,'linked')).catch(()=>{});
    const relative=path.relative(path.resolve(base),path.resolve(root));
    assert.ok(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
    assert.equal(path.dirname(relative),'.');assert.equal(relative,path.basename(root));assert.match(path.basename(root),/^blackice-publisher-/);
    assert.equal(path.dirname(path.resolve(local)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.match(path.basename(local),/^blackice-publisher-source-/);
    await fs.rm(root,{recursive:true,force:true});await fs.rm(local,{recursive:true,force:true});
  }
}

let localResult;
const local=()=>localResult??=(execute(os.tmpdir()));
test('real Windows publisher and actual supervisor reader observe only complete monotonically published metadata',{skip:process.platform!=='win32'},async()=>{
  const {stress}=await local();assert.ok(stress.reads>=50);assert.ok(stress.writes>=50);assert.equal(stress.failures,0);assert.equal(stress.regressions,0);assert.equal(stress.publisherError,null);assert.equal(stress.inheritedAclUnchanged,true);
});
test('short Windows replacement locks are retried without removing the last published metadata',{skip:process.platform!=='win32'},async()=>{
  const {shortLock}=await local();assert.equal(shortLock.value,7001);assert.ok(shortLock.elapsedMs>=60&&shortLock.elapsedMs<600);
});
test('persistent replacement locks fail closed in bounded time and preserve the previous file',{skip:process.platform!=='win32'},async()=>{
  const {persistentLock}=await local();assert.equal(persistentLock.failed,true);assert.ok([5,32,33,303].includes(persistentLock.code));assert.ok(persistentLock.elapsedMs>=200&&persistentLock.elapsedMs<600);assert.equal(persistentLock.retained,7001);assert.equal(persistentLock.temporaryFiles,0);
});
test('publication preserves Unicode and rejects oversized, escaping, directory and reparse targets',{skip:process.platform!=='win32'},async()=>{
  const result=await local();for(const key of ['unicodeRoundtrip','oversizeRejected','directoryRejected','outsideRejected'])assert.equal(result[key],true);
});
test('a failed heartbeat preserves the old file and the next successful heartbeat reports the failure without changing identity',{skip:process.platform!=='win32'},async()=>{
  const {recovery}=await local();assert.equal(recovery.failureObserved,true);assert.equal(recovery.retained,7001);assert.equal(recovery.agentId,'b'.repeat(32));assert.equal(recovery.failures,1);
  assert.ok([5,32,33,303].includes(recovery.lastErrorCode));assert.ok(Date.parse(recovery.lastFailureAt)<=Date.parse(recovery.heartbeatAt));
});
test('same-directory native replacement is also exercised on an explicitly supplied existing SMB share',{skip:process.platform!=='win32'||!process.env.BLACKICE_PUBLISHER_SMB_ROOT},async()=>{
  const base=process.env.BLACKICE_PUBLISHER_SMB_ROOT;assert.match(base,/^\\\\[^\\]+\\[^\\]+(?:\\[^.][^\\]*)*\\?$/);
  const result=await execute(base);assert.ok(result.stress.reads>=50);assert.ok(result.stress.writes>=50);assert.equal(result.stress.failures,0);assert.equal(result.stress.regressions,0);assert.equal(result.stress.publisherError,null);assert.equal(result.stress.inheritedAclUnchanged,true);
  assert.equal(result.persistentLock.failed,true);assert.equal(result.persistentLock.retained,7001);assert.equal(result.shortLock.value,7001);
});
