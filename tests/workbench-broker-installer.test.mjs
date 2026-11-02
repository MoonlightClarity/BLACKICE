import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('BLACKICE Electron executable requests administrator elevation by default',async()=>{
  const config=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');
  assert.match(config,/^\s*- scripts\/workbench-headless-broker\.ps1\s*$/m);
  assert.doesNotMatch(config,/^\s*- scripts\/install-workbench-headless-broker\.ps1\s*$/m);
  assert.match(config,/^\s*perMachine: false\s*$/m);
  assert.match(config,/^\s*allowElevation: false\s*$/m);
  assert.match(config,/^\s*requestedExecutionLevel: requireAdministrator\s*$/m);
  assert.doesNotMatch(config,/^\s*requestedExecutionLevel: asInvoker\s*$/m);
});

test('SYSTEM Workbench task only executes a protected Program Files copy, never a per-user app script',async()=>{
  const installer=await readFile(new URL('../scripts/install-workbench-headless-broker.ps1',import.meta.url),'utf8');
  assert.match(installer, /\$protectedRoot=Join-Path \$env:ProgramFiles 'BLACKICE\\Workbench'/);
  assert.match(installer, /\$sourceScript=Join-Path \$app 'scripts\\workbench-headless-broker\.ps1'/);
  assert.match(installer, /Copy-Item -LiteralPath \$sourceScript -Destination \$script/);
  assert.match(installer, /Set-ProtectedAcl \$protectedRoot \$true/);
  assert.match(installer, /Set-ProtectedAcl \$script \$false/);
  assert.match(installer, /\$acl\.SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(installer, /\$acl\.SetOwner\(\$adminSid\)/);
  assert.match(installer, /S-1-5-32-544/);
  assert.match(installer, /S-1-5-18/);
  assert.match(installer, /Get-FileHash \$script -Algorithm SHA256/);
  assert.match(installer, /-ExecutionPolicy Bypass/);
  assert.match(installer, /-LogonType ServiceAccount -RunLevel Highest/);
  assert.match(installer, /-Hidden/);
  assert.match(installer, /Register-ScheduledTask/);
  assert.match(installer, /if\(\$StartNow\)\{Start-ScheduledTask/);
  assert.doesNotMatch(installer,/Start-Process\s|Verb\s+RunAs|SetForegroundWindow|ShowWindow\s*\(|Restart-Computer/);
});

test('broker refuses unauthorized session and exposes only fixed guest-scoped actions',async()=>{
  const broker=await readFile(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url),'utf8');
  assert.match(broker,/\$script:Identity\.User\.Value -eq 'S-1-5-18'/);
  assert.match(broker,/\$script:SessionId -eq 0/);
  assert.match(broker,/if\(\$DiagnosticOnly\)\{throw/);
  assert.match(broker,/\$script:VmName='BLACKICE-Workbench'/);
  assert.match(broker,/NamedPipeServerStream/);
  assert.doesNotMatch(broker,/Invoke-Expression|Start-Process|SetForegroundWindow|SendInput|Stop-Computer/);
});

test('VM resource validation avoids PowerShell automatic $args shadowing',async()=>{
  const broker=await readFile(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url),'utf8');
  assert.match(broker,/function Get-Resources\(\$resourceRequest\)/);
  for(const key of ['minimumMiB','startupMiB','maximumMiB','cpuCount'])
    assert.match(broker,new RegExp('\\$resourceRequest\\.'+key));
  assert.doesNotMatch(broker,/function Get-Resources\(\$args\)/);
});

test('guest thumbnail uses current VM setting data, never host display or VM object as WMI target',async()=>{
  const broker=await readFile(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url),'utf8');
  assert.match(broker,/GetRelated\('Msvm_VirtualSystemSettingData',[\s\S]*?'Msvm_SettingsDefineState'/);
  assert.match(broker,/\$parameters\['TargetSystem'\]=\$settingPath/);
  assert.match(broker,/\$parameters\['WidthPixels'\]=\[uint16\]\$width/);
  assert.match(broker,/\$parameters\['HeightPixels'\]=\[uint16\]\$height/);
  assert.match(broker,/InvokeMethod\('GetVirtualSystemThumbnailImage',\$parameters,\$null\)/);
  assert.doesNotMatch(broker,/GetVirtualSystemThumbnailImage\(\$guest\[0\]/);
  assert.doesNotMatch(broker,/GetDC|BitBlt|PrintWindow|SetForegroundWindow|SendInput/);
});
