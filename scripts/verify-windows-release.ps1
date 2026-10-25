# Run only in a disposable GitHub-hosted Windows VM. Never use this on a desktop
# with an existing BLACKICE/Agent Desk installation or Relay profile.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$Distribution,
  [Parameter(Mandatory)][string]$EvidenceDirectory,
  [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedFingerprint,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceCommit,
  [Parameter(Mandatory)][ValidatePattern('^verification/[A-Za-z0-9][A-Za-z0-9._-]*\.json$')][string]$SourceTestReceipt
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
function Assert($Condition, [string]$Message) {
  if (!$Condition) { $validationException=[InvalidOperationException]::new($Message); $validationException.Data['validationCheck']=$Message; throw $validationException }
}
function Save-Json($Value, [string]$File) {
  $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $File -Encoding utf8NoBOM
}
function Same-Path([string]$A, [string]$B) {
  return [IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\')
}
function Under-Path([string]$File, [string]$Directory) {
  return $File -and [IO.Path]::GetFullPath($File).StartsWith(
    [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
$guid = 'd614cce4-27be-5cb2-b718-e6d9659f75c3'
function Get-Registration {
  foreach ($hive in @('CurrentUser','LocalMachine')) {
    foreach ($view in @('Registry64','Registry32')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
      try {
        foreach ($kind in @('install','uninstall')) {
          $keyPath = if ($kind -eq 'install') { "Software\$guid" } else { "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" }
          $key = $base.OpenSubKey($keyPath)
          if ($null -eq $key) { continue }
          try {
            [pscustomobject]@{ hive=$hive; view=$view; kind=$kind; key=$keyPath
              displayName=[string]$key.GetValue('DisplayName'); version=[string]$key.GetValue('DisplayVersion')
              installLocation=[string]$key.GetValue('InstallLocation'); uninstall=[string]$key.GetValue('UninstallString') }
          } finally { $key.Dispose() }
        }
      } finally { $base.Dispose() }
    }
  }
}
function Get-AppShortcuts {
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($kind in @('Desktop','Programs','CommonDesktopDirectory','CommonPrograms')) {
      $directory = [Environment]::GetFolderPath($kind)
      if (!$directory -or !(Test-Path -LiteralPath $directory)) { continue }
      foreach ($file in Get-ChildItem -LiteralPath $directory -Filter '*.lnk' -Recurse -File) {
        $shortcut = $shell.CreateShortcut($file.FullName)
        try {
          $target = [string]$shortcut.TargetPath
          if ($file.BaseName -match '^(BLACKICE|Agent Desk|Relay)$' -or [IO.Path]::GetFileName($target) -match '^(BLACKICE|Agent Desk|Relay)\.exe$') {
            [pscustomobject]@{kind=$kind; file=$file.FullName; name=$file.Name; target=$target}
          }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
      }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
function Invoke-Setup([string]$Executable, [string]$Arguments) {
  # Start-Process -Wait on Windows waits for the entire descendant process tree,
  # including NSIS's temporary uninstaller. A job adds a bounded outer wait.
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $job = Start-Job -ArgumentList $Executable,$Arguments -ScriptBlock {
    param($Exe,$ArgsText)
    $ErrorActionPreference='Stop'
    $p = Start-Process -FilePath $Exe -ArgumentList $ArgsText -PassThru -Wait
    [int]$p.ExitCode
  }
  try {
    $completed = Wait-Job -Job $job -Timeout 300
    Assert ($null -ne $completed -and $job.State -eq 'Completed') 'Installer process tree did not complete within five minutes.'
    $codes = @(Receive-Job -Job $job -ErrorAction Stop)
    Assert ($codes.Count -eq 1 -and $codes[0] -eq 0) 'Installer or uninstaller returned a nonzero exit code.'
    return @{exitCode=[int]$codes[0]; elapsedMilliseconds=$watch.ElapsedMilliseconds; waitMode='Start-Process -Wait (process tree)'}
  } finally { if ($job.State -eq 'Running') { Stop-Job $job }; Remove-Job $job -Force }
}
function Get-OwnedProcesses {
  return @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Under-Path $_.ExecutablePath $install) })
}
function Invoke-Node([string[]]$Arguments) {
  $p=[Diagnostics.Process]::new()
  $p.StartInfo=[Diagnostics.ProcessStartInfo]::new($script:Node)
  $p.StartInfo.UseShellExecute=$false
  $p.StartInfo.CreateNoWindow=$true
  $p.StartInfo.RedirectStandardOutput=$true
  $p.StartInfo.RedirectStandardError=$true
  $p.StartInfo.WorkingDirectory=$SourceRoot
  [void]$p.StartInfo.Environment.Remove('ELECTRON_RUN_AS_NODE')
  [void]$p.StartInfo.Environment.Remove('NODE_OPTIONS')
  foreach($argument in $Arguments){$p.StartInfo.ArgumentList.Add($argument)}
  try {
    Assert ($p.Start()) 'Node verification could not start.'
    $output=$p.StandardOutput.ReadToEndAsync(); $errors=$p.StandardError.ReadToEndAsync()
    if (!$p.WaitForExit(360000)) { $p.Kill($true); [void]$p.WaitForExit(5000); throw 'Node verification exceeded six minutes.' }
    [void]$output.Wait(5000); [void]$errors.Wait(5000)
    if($output.IsCompletedSuccessfully){[IO.File]::WriteAllText((Join-Path $work "$stage-node.stdout"),$output.Result)}
    if($errors.IsCompletedSuccessfully){[IO.File]::WriteAllText((Join-Path $work "$stage-node.stderr"),$errors.Result)}
    Assert ($p.ExitCode -eq 0) 'Node verification command failed.'
  } finally { $p.Dispose() }
}
Assert ($IsWindows -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') 'This verifier requires a fresh GitHub-hosted Windows runner.'
Assert ($env:GITHUB_SHA -eq $ExpectedSourceCommit) 'Workflow commit differs from the approved source commit.'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$Distribution = [IO.Path]::GetFullPath($Distribution)
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$commit = (& git -C $SourceRoot rev-parse HEAD).Trim()
Assert ($LASTEXITCODE -eq 0 -and $commit -eq $ExpectedSourceCommit) 'Checkout commit differs from the approved source commit.'
Assert (Under-Path $EvidenceDirectory $env:RUNNER_TEMP) 'Evidence must be written under RUNNER_TEMP.'
$work = Join-Path $env:RUNNER_TEMP ('blackice-native-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $work 'install'
$app = Join-Path $install 'resources\app'
$exe = Join-Path $install 'BLACKICE.exe'
$profile = Join-Path $env:APPDATA 'Relay'
$sentinel = Join-Path $profile 'BLACKICE-RELEASE-VALIDATION-SENTINEL.txt'
$version = $Tag.Substring(1)
$report = [ordered]@{format=1; product='BLACKICE'; version=$version; sourceCommit=$commit
  appFingerprint=$ExpectedFingerprint; artifactSha256=$ExpectedSha256; checkedAt=[DateTime]::UtcNow.ToString('o')
  githubRunId=$env:GITHUB_RUN_ID; githubRunAttempt=$env:GITHUB_RUN_ATTEMPT; platform='win32'; passed=$false; failures=@()}
$stage='preflight'; $started=$false; $installed=$false; $uninstaller=$null; $shortcuts=@(); $sentinelHash=$null
$mainPassed=$false; $cleanupPassed=$false
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
try {
  # Keep an independent Node alive through uninstall; do not depend on the
  # executable whose deletion is one of the checks. Standard runners cache Node.
  $nodes=@()
  $command=Get-Command node -ErrorAction SilentlyContinue
  if($command){$nodes+=$command.Source}
  $cache=Join-Path $env:RUNNER_TOOL_CACHE 'node'
  if(Test-Path -LiteralPath $cache){$nodes+=@(Get-ChildItem -LiteralPath $cache -Directory | ForEach-Object {Join-Path $_.FullName 'x64\node.exe'})}
  $script:Node=$null
  foreach($candidate in $nodes){
    if(!(Test-Path -LiteralPath $candidate -PathType Leaf)){continue}
    $major=& $candidate -p 'process.versions.node.split(".")[0]'
    if($LASTEXITCODE -eq 0 -and [int]$major -ge 22){$script:Node=$candidate;break}
  }
  Assert ($script:Node) 'Runner must provide Node >=22; no installer was run.'
  Assert (@(Get-Registration).Count -eq 0) 'Preexisting BLACKICE registration; refusing installation.'
  Assert (!(Test-Path -LiteralPath $profile)) 'Preexisting Relay profile; refusing installation.'
  foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs'),$env:ProgramFiles,${env:ProgramFiles(x86)})) {
    if (!$root) { continue }
    foreach ($name in @('BLACKICE','Agent Desk','Relay')) {
      Assert (!(Test-Path -LiteralPath (Join-Path $root $name))) 'Preexisting program directory; refusing installation.'
    }
  }
  Assert (@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(BLACKICE|Agent Desk|Relay)\.exe$' }).Count -eq 0) 'Preexisting app process; refusing installation.'
  Assert (@(Get-AppShortcuts).Count -eq 0) 'Preexisting app shortcut; refusing installation.'
  $report.preflight=@{registryViewsChecked=@('HKCU64','HKCU32','HKLM64','HKLM32'); existingRegistrations=0; existingProfiles=0; existingProgramDirectories=0; existingProcesses=0; existingShortcuts=0}
  $stage='artifact'
  $manifestPath=Join-Path $Distribution 'blackice-public-release.json'
  $manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json -AsHashtable
  Assert ($manifest.format -eq 1 -and $manifest.product -eq 'BLACKICE' -and $manifest.version -eq $version) 'Manifest identity mismatch.'
  Assert ($manifest.appFingerprint -eq $ExpectedFingerprint -and $manifest.artifact.name -eq "Blackice-$version-Setup.exe") 'Manifest build binding mismatch.'
  $setup=Join-Path $Distribution $manifest.artifact.name
  $info=Get-Item -LiteralPath $setup
  Assert (!$info.PSIsContainer -and !($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Installer must be a regular file.'
  $sha=(Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert ($sha -eq $ExpectedSha256 -and $sha -eq $manifest.artifact.sha256 -and $info.Length -eq $manifest.artifact.size) 'Installer size or SHA-256 mismatch.'
  if ($sha -eq '1dc370ae766dea12996819e259846cab7df5efe1bfc821f71a8b90ece3aaa59d') { Assert ($info.Length -eq 111436476) 'Pinned candidate size mismatch.' }
  $report.artifact=@{name=$info.Name; bytes=$info.Length; sha256=$sha; manifestSha256=(Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant(); signingStatus=$manifest.signing.status}
  New-Item -ItemType Directory -Path $work,$profile | Out-Null
  [IO.File]::WriteAllText($sentinel,'Disposable BLACKICE validation sentinel ' + [guid]::NewGuid().ToString())
  $sentinelHash=(Get-FileHash $sentinel -Algorithm SHA256).Hash.ToLowerInvariant()
  $stage='install'; $started=$true
  # NSIS requires /D= to be the last argument, without quotation marks.
  $report.install=Invoke-Setup $setup "/S /currentuser /D=$install"
  $installed=$true
  Assert (Test-Path -LiteralPath $exe -PathType Leaf) 'Installed BLACKICE.exe missing.'
  $binary=(Get-Item -LiteralPath $exe).VersionInfo
  Assert ($binary.ProductVersion -match ('^'+[regex]::Escape($version)+'(?:\.0)?(?:\+\S+)?$')) 'Installed executable version mismatch.'
  $report.executable=@{name='BLACKICE.exe';productVersion=$binary.ProductVersion;fileVersion=$binary.FileVersion;sha256=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()}
  $stage='registration'
  $registrations=@(Get-Registration)
  Assert (@($registrations | Where-Object hive -eq 'LocalMachine').Count -eq 0) 'Per-user install wrote machine registration.'
  $uninstallEntries=@($registrations | Where-Object kind -eq 'uninstall')
  Assert (@($registrations | Where-Object kind -eq 'install').Count -gt 0 -and $uninstallEntries.Count -gt 0) 'Required registration missing.'
  foreach ($entry in $registrations) {
    if ($entry.kind -eq 'install') { Assert (Same-Path $entry.installLocation $install) 'Registered install location mismatch.' }
    if ($entry.kind -eq 'uninstall') {
      Assert ($entry.version -eq $version -and $entry.displayName -match '^BLACKICE(?:\s|$)') 'Registered product/version mismatch.'
      Assert ($entry.uninstall -match '^"([^"\r\n]+\.exe)"(?:\s|$)') 'Uninstall command is not an explicit quoted executable.'
      $candidate=$Matches[1]
      Assert ((Under-Path $candidate $install) -and (Same-Path ([IO.Path]::GetDirectoryName($candidate)) $install) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) 'Uninstaller is outside the owned installation.'
      Assert (!$uninstaller -or (Same-Path $candidate $uninstaller)) 'Registry views disagree about uninstaller.'
      $uninstaller=$candidate
    }
  }
  $report.registration=@($registrations | ForEach-Object { @{hive=$_.hive;view=$_.view;kind=$_.kind;displayName=$_.displayName;version=$_.version;installLocation=$(if($_.installLocation){'<owned-install>'}else{$null})} })
  $report.uninstallerName=[IO.Path]::GetFileName($uninstaller)
  $stage='shortcuts'; $shortcuts=@(Get-AppShortcuts)
  foreach ($kind in @('Desktop','Programs')) {
    $matchesForKind=@($shortcuts | Where-Object kind -eq $kind)
    Assert ($matchesForKind.Count -eq 1 -and $matchesForKind[0].name -eq 'BLACKICE.lnk' -and (Same-Path $matchesForKind[0].target $exe)) 'Desktop/Start menu shortcut mismatch.'
  }
  Assert ($shortcuts.Count -eq 2) 'Unexpected common or duplicate app shortcuts.'
  $report.shortcuts=@($shortcuts | ForEach-Object { @{kind=$_.kind;name=$_.name;target='<owned-install>/BLACKICE.exe'} })
  $stage='integrity'
  $integrityScript=Join-Path $work 'integrity.mjs'
  @'
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [src,app,install,out,expected,version,commit,receiptPath]=process.argv.slice(2);
const check=(v,m)=>{if(!v)throw Error(m)};
check(Number(process.versions.node.split('.')[0])>=22,'Node 22 or newer required');
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=async(n,v)=>fs.writeFile(path.join(out,n),JSON.stringify(v,null,2)+'\n');
const {appFingerprint}=await import(pathToFileURL(path.join(src,'scripts/release-check.mjs')));
const {approvedWindowsPackageFile,forbiddenWindowsPackagePath,readWindowsSourceTestReceipt}=await import(pathToFileURL(path.join(src,'scripts/windows-release-inputs.mjs')));
const source=await appFingerprint(src), installed=await appFingerprint(app);
check(source===expected&&installed===source,'Source/installed fingerprint mismatch');
const tracked=new Set(execFileSync('git',['-C',src,'ls-files','-z'],{encoding:'utf8',maxBuffer:8e6}).split('\0'));
const records=[];
async function walk(relative='') {
  for(const name of await fs.readdir(path.join(app,relative))) {
    const p=relative?`${relative}/${name}`:name, file=path.join(app,p), stat=await fs.lstat(file);
    check(!stat.isSymbolicLink(),'Packaged symbolic link'); check(!forbiddenWindowsPackagePath(p),'Excluded/private package path');
    if(stat.isDirectory()) await walk(p);
    else {
      check(stat.isFile()&&approvedWindowsPackageFile(p,version)&&tracked.has(p),'Unapproved or untracked packaged file');
      const bytes=await fs.readFile(file), hash=sha(bytes);
      // release-check compares normalized package metadata on both sides.
      if(p!=='package.json')check(hash===sha(await fs.readFile(path.join(src,p))),'Packaged file differs from checked-out source');
      records.push({path:p,bytes:bytes.length,sha256:hash});
    }
  }
}
await walk();
const licenses=['LICENSE','NOTICE','THIRD-PARTY-NOTICES.md','lib/vendor/ADBLOCK-NOTICES.md','lib/vendor/adblock-source.json','lib/vendor/adblock-filter-data.json','lib/vendor/catalyst/LICENSE.txt','lib/vendor/catalyst/NOTICE.md','lib/vendor/catalyst/LICENSES.md','lib/vendor/pdfium/LICENSE-wrapper.md','lib/vendor/pdfium/LICENSE-PDFium.txt','lib/vendor/pdfium/provenance.json',...['ibmplexmono','oxanium','sharetechmono'].map(n=>`public/assets/fonts/${n}-OFL.txt`)];
const notices=licenses.map(p=>{const record=records.find(r=>r.path===p);check(record?.bytes>0,'Required upstream notice/source missing');return record});
for(const name of ['LICENSE.electron.txt','LICENSES.chromium.html']) {
  const file=path.join(install,name), stat=await fs.lstat(file), bytes=await fs.readFile(file);
  check(stat.isFile()&&!stat.isSymbolicLink()&&bytes.length>100,'Electron license missing');
  notices.push({path:`<electron>/${name}`,bytes:bytes.length,sha256:sha(bytes)});
}
const prior=await readWindowsSourceTestReceipt({directory:src,receiptPath,version,appFingerprint:expected,tracked});
const provenance={sourceCommit:commit,githubRunId:process.env.GITHUB_RUN_ID,githubRunAttempt:process.env.GITHUB_RUN_ATTEMPT};
await save('blackice-source-test-provenance.json',{format:1,product:'BLACKICE',...provenance,...prior,rerunInThisWorkflow:false});
await save('blackice-runtime-integrity.json',{format:1,product:'BLACKICE',...provenance,node:process.version,sourceFingerprint:source,installedFingerprint:installed,filesVerified:records.length,inventorySha256:sha(Buffer.from(JSON.stringify(records.sort((a,b)=>a.path.localeCompare(b.path,'en'))))),privateFileScan:{method:'every installed app file matches tracked source and packaging allowlist',filesExamined:records.length,rejectedFiles:0},notices,passed:true});
'@ | Set-Content -LiteralPath $integrityScript -Encoding utf8NoBOM
  Invoke-Node @($integrityScript,$SourceRoot,$app,$install,$EvidenceDirectory,$ExpectedFingerprint,$version,$commit,$SourceTestReceipt)
  $stage='runtime'
  $runtimeReport=Join-Path $EvidenceDirectory 'blackice-runtime-validation.json'
  Invoke-Node @((Join-Path $SourceRoot 'scripts\verify-installed-runtime.mjs'),'--app-dir',$app,'--exe',$exe,'--test-root',(Join-Path $work 'runtime'),'--report',$runtimeReport,'--expected-version',$version,'--expected-fingerprint',$ExpectedFingerprint,'--hidden-only')
  $runtime=Get-Content -Raw -LiteralPath $runtimeReport | ConvertFrom-Json -AsHashtable
  Assert ($runtime.passed -eq $true -and $runtime.failures.Count -eq 0) 'Native runtime validation failed.'
  foreach ($name in @('startup','restart','window','shutdown','profileBackup','diagnostics')) { Assert ($runtime[$name].passed -eq $true) 'Required native runtime check did not pass.' }
  Assert ($runtime.shutdown.forcedTerminationUsed -eq $false -and $runtime.shutdown.nativeQuitVerified -eq $true -and $runtime.shutdown.ownedProcessesExited -eq $true) 'Native shutdown was not clean.'
  Assert (@(Get-OwnedProcesses).Count -eq 0) 'Disposable native app still running.'
  $mainPassed=$true
} catch {
  $report.failures+=@{stage=$stage;exceptionType=$_.Exception.GetType().Name;code='validation-failed';check=$_.Exception.Data['validationCheck'];scriptLineNumber=$_.InvocationInfo.ScriptLineNumber;scriptLineNumbers=@([regex]::Matches($_.ScriptStackTrace,': line (\d+)') | ForEach-Object {[int]$_.Groups[1].Value})}
  Write-Warning "BLACKICE validation failed at stage: $stage."
} finally {
  $cleanup=[ordered]@{attempted=$started;passed=$false;forcedTerminationUsed=$false}
  if ($started) {
    try {
      $owned=@(Get-OwnedProcesses)
      foreach ($p in $owned) { $process=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if($process){[void]$process.CloseMainWindow()} }
      $deadline=[DateTime]::UtcNow.AddSeconds(10)
      while (@(Get-OwnedProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
      foreach ($p in @(Get-OwnedProcesses)) { Stop-Process -Id $p.ProcessId -Force; $cleanup.forcedTerminationUsed=$true }
      if (!$uninstaller -and (Test-Path -LiteralPath $install)) {
        $found=@(Get-ChildItem -LiteralPath $install -File -Filter 'Uninstall*.exe')
        if ($found.Count -eq 1) { $uninstaller=$found[0].FullName }
      }
      Assert ($installed -and $uninstaller -and (Under-Path $uninstaller $install)) 'No completed owned installation available for clean uninstall.'
      $cleanup.uninstall=Invoke-Setup $uninstaller '/S /currentuser'
      $deadline=[DateTime]::UtcNow.AddSeconds(30)
      while ((Test-Path -LiteralPath $install) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
      Assert (!(Test-Path -LiteralPath $install)) 'Uninstaller left the installation directory behind.'
      Assert (@(Get-Registration).Count -eq 0) 'Uninstaller left application registration behind.'
      Assert (@(Get-AppShortcuts).Count -eq 0) 'Uninstaller left an app shortcut behind.'
      Assert ((Test-Path -LiteralPath $sentinel) -and (Get-FileHash $sentinel -Algorithm SHA256).Hash.ToLowerInvariant() -eq $sentinelHash) 'Uninstaller changed or deleted profile data.'
      Assert (@(Get-OwnedProcesses).Count -eq 0 -and !$cleanup.forcedTerminationUsed) 'App needed forced termination.'
      $cleanup.passed=$true; $cleanup.filesRemaining=0; $cleanup.registrationsRemaining=0; $cleanup.shortcutsRemaining=0
      $cleanup.profileSentinelPreserved=$true; $cleanup.profileSentinelSha256=$sentinelHash
      $cleanupPassed=$true
    } catch {
      $report.failures+=@{stage='cleanup';exceptionType=$_.Exception.GetType().Name;code='cleanup-failed';check=$_.Exception.Data['validationCheck'];scriptLineNumber=$_.InvocationInfo.ScriptLineNumber;scriptLineNumbers=@([regex]::Matches($_.ScriptStackTrace,': line (\d+)') | ForEach-Object {[int]$_.Groups[1].Value})}
      Write-Warning 'BLACKICE cleanup verification failed.'
    }
  }
  $report.cleanup=$cleanup
  $report.passed=$mainPassed -and $cleanupPassed
  Save-Json $report (Join-Path $EvidenceDirectory 'blackice-windows-install-validation.json')
  $nativeReport=Join-Path $EvidenceDirectory 'blackice-runtime-validation.json'
  if(Test-Path -LiteralPath $nativeReport){
    $native=Get-Content -Raw -LiteralPath $nativeReport | ConvertFrom-Json -AsHashtable
    $native.sourceCommit=$commit; $native.githubRunId=$env:GITHUB_RUN_ID; $native.githubRunAttempt=$env:GITHUB_RUN_ATTEMPT
    Save-Json $native $nativeReport
  }
}
Assert $report.passed 'Windows installation/runtime/uninstallation validation failed; no passing release receipt generated.'
$integrity=Get-Content -Raw (Join-Path $EvidenceDirectory 'blackice-runtime-integrity.json') | ConvertFrom-Json -AsHashtable
$prior=Get-Content -Raw (Join-Path $EvidenceDirectory 'blackice-source-test-provenance.json') | ConvertFrom-Json -AsHashtable
$receipts=@{format=1;product='BLACKICE';version=$version;appFingerprint=$ExpectedFingerprint;artifactSha256=$ExpectedSha256
  tests=$prior.tests;sourceTestProvenance=$prior
  installIntegrity=@{passed=$report.passed;filesVerified=$integrity.filesVerified;sourceInstalledMatch=($integrity.sourceFingerprint -eq $integrity.installedFingerprint);shortcutVerified=($shortcuts.Count -eq 2);publicInstallerTested=$installed}
  profileBackup=$runtime.profileBackup;diagnostics=$runtime.diagnostics;sourceCommit=$commit;githubRunId=$env:GITHUB_RUN_ID;githubRunAttempt=$env:GITHUB_RUN_ATTEMPT}
$receiptFile=Join-Path $EvidenceDirectory 'blackice-release-receipts.json'
Save-Json $receipts $receiptFile
$stage='release-gate'
Invoke-Node @((Join-Path $SourceRoot 'scripts\release-check.mjs'),'--distribution',$Distribution,'--receipts',$receiptFile,'--report',(Join-Path $EvidenceDirectory 'blackice-public-readiness.json'))
