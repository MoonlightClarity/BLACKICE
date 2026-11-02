import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script=path.resolve('scripts/workbench-agent-job.ps1');
test('guest supervisor has no host input, activation, VM power, model or automatic script retry path',async()=>{
  const source=await readFile(script,'utf8');
  assert.doesNotMatch(source,/SetForegroundWindow|SendKeys|SendInput|mouse_event|SetCursorPos|SetProcessWindowStation|Start-VM|Stop-VM|Invoke-Expression/);
  assert.match(source,/Get-JobContext \$PSScriptRoot/);
  assert.ok(source.indexOf('$context=Get-JobScope $PSScriptRoot')<source.indexOf("$claim=[IO.File]::Open"));
  assert.ok(source.indexOf("$claim=[IO.File]::Open")<source.indexOf('$context=Get-JobContext $PSScriptRoot'));
  assert.ok(source.indexOf('$context=Get-JobContext $PSScriptRoot')<source.indexOf('Add-Type -TypeDefinition $NativeSource'));
  assert.match(source,/if\(!\$ownsClaim\)/);assert.match(source,/preflight-diagnostic-/);
  assert.ok(source.indexOf("$job.Start($shell,$childFile,$PSScriptRoot)")<source.indexOf('[IO.File]::Move($goTemporary,$goFile)'));
  assert.match(source,/limits\.basic\.flags=0x2000/);assert.match(source,/AssignProcessToJobObject\(job,child\.Handle\)/);
  assert.match(source,/info\.active==0/);assert.match(source,/\$childrenStopped=\$job\.StopAndWait\(3000\)/);
  assert.ok(source.indexOf('$childrenStopped=$job.StopAndWait(3000)')<source.indexOf('$record=[ordered]'));
  assert.match(source,/supervisor\.claim\.json/);assert.match(source,/\$budget\.ElapsedMilliseconds -ge \$budgetMs/);
  assert.match(source,/\$remaining -gt 0 -and \$remaining -le 1500/);
  assert.match(source,/Job-HostTime \$meta\.deadlineAt \$meta\.hostToGuestOffsetMs/);
  assert.match(source,/Job-HostTime \$lease\.expiresAt \$Context\.Meta\.hostToGuestOffsetMs/);
  assert.match(source,/\$budgetMs=\[math\]::Max\(0,\[math\]::Min\(\[double\]\$context\.Meta\.timeoutMs/);
});
test('PowerShell guards and child parse; native job code compiles without creating processes or job handles', {skip:process.platform!=='win32'},async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'blackice-job-static-'));t.after(()=>{assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir())+path.sep));assert.match(path.basename(folder),/^blackice-job-static-/);return rm(folder,{recursive:true,force:true})});
  const checker=path.join(folder,'check.ps1');
  await writeFile(checker,String.raw`
param([string]$Source,[string]$Scratch)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source);$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Supervisor did not parse.'}
$strings=$ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)
$native=@($strings|Where-Object {$_.Value.StartsWith('using System;')})[0].Value
$guard=@($strings|Where-Object {$_.Value.StartsWith('function Read-JobJson')})[0].Value
$observation=@($strings|Where-Object {$_.Value.StartsWith('function Convert-BLACKICEObservationValue')})[0].Value
$compatibility=@($strings|Where-Object {$_.Value.StartsWith('function Remove-BLACKICEJsonProviderMetadata')})[0].Value
$tail=@($strings|Where-Object {$_.Value.TrimStart().StartsWith('$context=Get-JobContext $PSScriptRoot')})[0].Value
$child=$guard+[Environment]::NewLine+$observation+[Environment]::NewLine+$compatibility+[Environment]::NewLine+$tail;$childTokens=$null;$childErrors=$null
[void][Management.Automation.Language.Parser]::ParseInput($child,[ref]$childTokens,[ref]$childErrors)
if($childErrors.Count){throw 'Generated child did not parse.'}
Add-Type -TypeDefinition $native
. ([scriptblock]::Create($guard))
$checks=0
function Assert($Value,[string]$Why){if(!$Value){throw $Why};$script:checks++}
function Reject([scriptblock]$Body){$failed=$false;try{&$Body|Out-Null}catch{$failed=$true};Assert $failed 'Expected pure guard rejection.'}
Assert ([BLACKICEAgentJob]::BoundOutput(('x'*20000)).Length -eq 16384) 'ASCII output bound failed.'
$emoji=[char]::ConvertFromUtf32(0x1f9ca);$bounded=[BLACKICEAgentJob]::BoundOutput(($emoji*10000))
Assert ([Text.Encoding]::UTF8.GetByteCount($bounded) -le 16384) 'UTF8 output bound failed.'
[void][Text.UTF8Encoding]::new($false,$true).GetBytes($bounded);$checks++
$limits=[BLACKICEAgentJob].GetNestedType('Limits',[Reflection.BindingFlags]::NonPublic)
$accounting=[BLACKICEAgentJob].GetNestedType('Accounting',[Reflection.BindingFlags]::NonPublic)
Assert ([Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($limits)) -eq 144) '64-bit job limit ABI size mismatch.'
Assert ([Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($accounting)) -eq 48) 'Job accounting ABI size mismatch.'
Reject {Job-Time 'tomorrow'};Reject {Job-Time 123};[void](Job-Time ([datetime]::UtcNow.ToString('o')));$checks++
Assert (!(Job-Number '2')) 'String accepted as JSON number.';Assert (!(Job-Number $true)) 'Boolean accepted as JSON number.'
Assert-JobTimeout 1000;Assert-JobTimeout 120000;$checks+=2
foreach($invalid in @('1000',999,120001,$true,1000.5)){Reject {Assert-JobTimeout $invalid}}
Assert-JobClockOffset (-5000);Assert-JobClockOffset 19999;Assert-JobClockOffset 0;$checks+=3
foreach($badOffset in @('3200',-5001,20000,$true,100.5,$null)){
  $rejected=$false;try{Assert-JobClockOffset $badOffset}catch{$rejected=$true}
  Assert $rejected 'An invalid clock binding was accepted.'
}
$private=Join-Path $Scratch 'private.json';[IO.File]::WriteAllText($private,'{"version":1}',[Text.UTF8Encoding]::new($false))
Assert ((Read-JobJson $private 64).version -eq 1) 'Bounded JSON read failed.'
$script:readProofFile=$private
function ConvertFrom-Json {
  param([Parameter(ValueFromPipeline=$true)][string]$InputObject)
  process{
    # This exclusive read/write open fails if Read-JobJson still holds its stream
    # while invoking the parser. This is our own temporary host fixture only.
    $exclusive=[IO.File]::Open($script:readProofFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try{$script:checks++}finally{$exclusive.Dispose()}
    Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject
  }
}
Assert ((Read-JobJson $private 64).version -eq 1) 'Metadata handle was not released before JSON parsing.'
Remove-Item -LiteralPath Function:\ConvertFrom-Json
[IO.File]::WriteAllText($private,('x'*65));Reject {Read-JobJson $private 64}
[IO.File]::WriteAllBytes($private,[byte[]]@(0xff,0xfe));Reject {Read-JobJson $private 64}
$context=@{Folder=$Scratch;Meta=@{jobId=('a'*32);scopeHash=('b'*64);hostToGuestOffsetMs=0}}
$lease=Join-Path $Scratch 'lease.json'
function Lease([object]$Version=1,[string]$Id=('a'*32),[int]$Milliseconds=1000){
  [IO.File]::WriteAllText($lease,(@{version=$Version;jobId=$Id;scopeHash=('b'*64);expiresAt=[datetime]::UtcNow.AddMilliseconds($Milliseconds).ToString('o')}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
Lease;Assert (Test-JobLease $context) 'Fresh exact lease rejected.'
Lease -Milliseconds -1;Assert (!(Test-JobLease $context)) 'Expired lease accepted.'
Assert ($context.LeaseFailure -eq 'lease_expired') 'Expired lease reason was hidden.'
Lease -Milliseconds 5000;Assert (!(Test-JobLease $context)) 'Unbounded lease accepted.'
Assert ($context.LeaseFailure -eq 'lease_invalid') 'Invalid lease reason was hidden.'
Lease -Id ('c'*32);Assert (!(Test-JobLease $context)) 'Wrong job lease accepted.'
Lease -Version '1';Assert (!(Test-JobLease $context)) 'String version accepted.'
foreach($offset in @(-3200,3200)){
  $context.Meta.hostToGuestOffsetMs=$offset
  # Simulate a different host clock only in JSON values; never change OS clocks.
  Lease -Milliseconds ($offset+1000);Assert (Test-JobLease $context) 'A measured clock offset broke a fresh short lease.'
  Lease -Milliseconds ($offset-100);Assert (!(Test-JobLease $context)) 'A measured clock offset revived an expired lease.'
  Lease -Milliseconds ($offset+1600);Assert (!(Test-JobLease $context)) 'Clock conversion widened the 1.5-second lease.'
  $guestDeadline=[datetime]::UtcNow.AddMilliseconds(120000)
  $hostDeadline=$guestDeadline.AddMilliseconds($offset).ToString('o')
  Assert ([math]::Abs(((Job-HostTime $hostDeadline $offset)-$guestDeadline).TotalMilliseconds) -lt 1) 'Guest deadline conversion did not preserve the declared bound.'
}
$context.Meta.hostToGuestOffsetMs=0
Lease -Milliseconds 100;Start-Sleep -Milliseconds 140;Assert (!(Test-JobLease $context)) 'A nonrenewed short lease stayed valid.'
Lease;[IO.File]::WriteAllText((Join-Path $Scratch 'cancel.json'),'{}');Assert (!(Test-JobLease $context)) 'Cancellation ignored.'
Assert ($context.LeaseFailure -eq 'caller_cancelled') 'Caller cancellation was misreported.'
$body=Join-Path $Scratch 'body.ps1';[IO.File]::WriteAllText($body,'Write-Output "fixture only"',[Text.UTF8Encoding]::new($false))
$hasher=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($body))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()};Assert-JobBody $Scratch $hash;$checks++
[IO.File]::AppendAllText($body,' changed');Reject {Assert-JobBody $Scratch $hash}
@{ok=$true;checks=$checks;supervisorExecuted=$false;childStarted=$false;nativeHandlesCreated=$false}|ConvertTo-Json -Compress
`);
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',checker,'-Source',script,'-Scratch',folder],
    {encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout.trim());
  assert.equal(receipt.ok,true);assert.ok(receipt.checks>=20);assert.equal(receipt.childStarted,false);assert.equal(receipt.nativeHandlesCreated,false);
});
