# Diagnostic-only installer exercise. Never run on a user's actual Windows desktop.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('clean','upgrade')][string]$Mode,
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$Distribution,
  [Parameter(Mandatory)][string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Assert($ok,[string]$message) {
  if(!$ok){throw [InvalidOperationException]::new($message)}
}
function Hash([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function ReadJson([string]$path) {
  return (Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -AsHashtable)
}
function SavedReport {
  New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
  $f=Join-Path $EvidenceDirectory ($Mode+'.json')
  [IO.File]::WriteAllText($f,($report|ConvertTo-Json -Depth 30)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}
function Registered {
  $guid='d614cce4-27be-5cb2-b718-e6d9659f75c3'
  $reg=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
  try {
    $entries=@()
    foreach($name in @("Software\$guid","Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")) {
      $key=$reg.OpenSubKey($name)
      if($key) {
        try {
          $entries+=@{path=$name;location=[string]$key.GetValue('InstallLocation');version=[string]$key.GetValue('DisplayVersion');display=[string]$key.GetValue('DisplayName')}
        }finally{$key.Dispose()}
      }
    }
    return $entries
  }finally{$reg.Dispose()}
}
function Shortcuts {
  $matches=@()
  foreach($folder in @('Desktop','Programs')) {
    $dir=[Environment]::GetFolderPath($folder)
    if(!$dir -or !(Test-Path -LiteralPath $dir)){continue}
    $matches+=@(Get-ChildItem -LiteralPath $dir -File -Recurse -Filter 'BLACKICE.lnk' | Select-Object -ExpandProperty FullName)
  }
  return $matches
}
function InvokeSetup([string]$exe,[string]$arguments) {
  $job=Start-Job -ArgumentList $exe,$arguments -ScriptBlock {
    param($file,$argsText)
    $ErrorActionPreference='Stop'
    $proc=Start-Process -FilePath $file -ArgumentList $argsText -PassThru -Wait
    return [int]$proc.ExitCode
  }
  try {
    $done=Wait-Job -Job $job -Timeout 300
    Assert ($null -ne $done -and $job.State -eq 'Completed') 'Installer process tree exceeded 300 seconds.'
    $result=@(Receive-Job -Job $job -ErrorAction Stop)
    Assert ($result.Count -eq 1 -and $result[0] -eq 0) 'Installer returned nonzero exit code.'
  }finally{
    if($job.State -eq 'Running'){Stop-Job -Job $job}
    Remove-Job -Job $job -Force
  }
}
function FingerprintPair([string]$installedApp) {
  Push-Location $SourceRoot
  try {
    $code="import {appFingerprint} from './scripts/release-check.mjs'; console.log(JSON.stringify({source:await appFingerprint(process.argv[1]),installed:await appFingerprint(process.argv[2])}));"
    $output=@(& node --input-type=module --eval $code $SourceRoot $installedApp)
    Assert ($LASTEXITCODE -eq 0 -and $output.Count -eq 1) 'Application fingerprint computation failed.'
    return ($output[0] | ConvertFrom-Json -AsHashtable)
  }finally{Pop-Location}
}
function CheckVersion([string]$exe,[string]$version) {
  Assert (Test-Path -LiteralPath $exe -PathType Leaf) 'Installed BLACKICE.exe missing.'
  $actual=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  Assert ($actual -match ('^'+[regex]::Escape($version)+'(?:\.0)?(?:\+\S+)?$')) ('Wrong installed version: '+$actual)
}
function CheckRegistration([string]$version,[string]$installDir) {
  $entries=@(Registered)
  Assert ($entries.Count -ge 2) 'Installer registration incomplete.'
  $uninstall=@($entries | Where-Object {$_.path -match 'Uninstall'})
  Assert ($uninstall.Count -eq 1 -and $uninstall[0].version -ceq $version) 'Uninstaller registry version mismatch.'
  $installs=@($entries | Where-Object {$_.path -notmatch 'Uninstall'})
  Assert ($installs.Count -eq 1 -and [IO.Path]::GetFullPath($installs[0].location).TrimEnd('\') -ieq $installDir.TrimEnd('\')) 'Install registration path mismatch.'
}
function CheckShortcuts {
  $paths=@(Shortcuts)
  Assert ($paths.Count -eq 2) 'Expected one user desktop and one user Start Menu shortcut.'
  return $paths
}

Assert ($IsWindows -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') 'Diagnostic requires a disposable GitHub-hosted Windows runner.'
Assert ($env:GITHUB_REF -ceq 'refs/heads/recovery/full-lineage-24085-20261127') 'Diagnostic cannot run on release branches.'
$SourceRoot=[IO.Path]::GetFullPath($SourceRoot)
$Distribution=[IO.Path]::GetFullPath($Distribution)
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
Assert ($EvidenceDirectory.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) 'Diagnostic evidence must stay under RUNNER_TEMP.'
$commit=(& git -C $SourceRoot rev-parse HEAD).Trim()
Assert ($LASTEXITCODE -eq 0 -and $commit -ceq $env:GITHUB_SHA) 'Diagnostic checkout does not match workflow commit.'
$work=Join-Path $env:RUNNER_TEMP ('blackice-diagnostic-'+[Guid]::NewGuid().ToString('N'))
$install=Join-Path $work 'install'
$exe=Join-Path $install 'BLACKICE.exe'
$app=Join-Path $install 'resources\app'
$profile=Join-Path $env:APPDATA 'Relay'
$sentinel=Join-Path $profile 'BLACKICE-UPGRADE-SENTINEL.txt'
$setup=Join-Path $Distribution 'Blackice-2.40.85-Setup.exe'
$manifest=Join-Path $Distribution 'blackice-public-release.json'
$report=[ordered]@{format=1;product='BLACKICE';classification='recovery-installer-diagnostic-only';mode=$Mode;sourceCommit=$commit;version='2.40.85';githubRunId=$env:GITHUB_RUN_ID;passed=$false;publicReleaseReady=$false;published=$false;stage='preflight';checks=@();errors=@()}
$installStarted=$false
$sentinelHash=$null
$uninstaller=$null
$mainPassed=$false
$cleanupPassed=$false
try {
  Assert (@(Registered).Count -eq 0) 'Runner already has BLACKICE registry records.'
  Assert (@(Shortcuts).Count -eq 0) 'Runner already has BLACKICE shortcuts.'
  Assert (!(Test-Path -LiteralPath $profile)) 'Runner already contains a Relay user profile.'
  Assert (!(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\BLACKICE'))) 'Runner already has a BLACKICE program directory.'
  Assert (@(Get-Process -Name BLACKICE -ErrorAction SilentlyContinue).Count -eq 0) 'Runner already has BLACKICE running.'
  Assert (Test-Path -LiteralPath $setup -PathType Leaf) 'Fresh candidate installer missing.'
  $m=ReadJson $manifest
  $hash=Hash $setup
  Assert ($m.version -ceq '2.40.85' -and $m.artifact.sha256 -ceq $hash -and $m.artifact.size -eq (Get-Item -LiteralPath $setup).Length) 'Candidate manifest hash or version mismatch.'
  $
  $
  $report.checks+=@{name='candidate-manifest-bound';passed=$true}
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  if($Mode -eq 'upgrade') {
    $report.stage='baseline-download'
    $base='https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.40.84'
    $oldSetup=Join-Path $work 'Blackice-2.40.84-Setup.exe'
    $oldManifest=Join-Path $work 'old-release.json'
    Invoke-WebRequest -Uri ($base+'/Blackice-2.40.84-Setup.exe') -OutFile $oldSetup -TimeoutSec 240
    Invoke-WebRequest -Uri ($base+'/blackice-public-release.json') -OutFile $oldManifest -TimeoutSec 30
    $old=ReadJson $oldManifest
    Assert ($old.version -ceq '2.40.84' -and $old.artifact.sha256 -ceq (Hash $oldSetup) -and $old.artifact.size -eq (Get-Item $oldSetup).Length) 'Published 2.40.84 baseline hash mismatch.'
    $
    $report.stage='baseline-install'
    $installStarted=$true
    InvokeSetup $oldSetup "/S /currentuser /D=$install"
    CheckVersion $exe '2.40.84'
    CheckRegistration '2.40.84' $install
    $oldPair=FingerprintPair $app
    Assert ($oldPair.installed -ceq $old.appFingerprint) 'Published 2.40.84 installed application differs from released manifest.'
    $
    $report.checks+=@{name='published-baseline-installed';passed=$true}
  }
  New-Item -ItemType Directory -Path $profile -Force | Out-Null
  [IO.File]::WriteAllText($sentinel,('Preserve this unique profile state: '+[Guid]::NewGuid().ToString('N')),[Text.UTF8Encoding]::new($false))
  $sentinelHash=Hash $sentinel
  $report.stage='candidate-install'
  $installStarted=$true
  InvokeSetup $setup "/S /currentuser /D=$install"
  CheckVersion $exe '2.40.85'
  CheckRegistration '2.40.85' $install
  Assert ((Hash $sentinel) -ceq $sentinelHash) 'Installer altered existing user profile sentinel.'
  $pair=FingerprintPair $app
  Assert ($pair.source -ceq $m.appFingerprint -and $pair.installed -ceq $m.appFingerprint) 'Installed application not identical to source/manifest fingerprint.'
  $index=Get-Content -LiteralPath (Join-Path $app 'public\next\index.html') -Raw
  Assert ($index.Contains('data-space="runtime"') -and !$index.Contains('data-space="skills"')) 'Recovered Runtime navigation missing or obsolete Skills tab returned.'
  foreach($name in @('public\next\workspaces\runtime.mjs','public\next\runtime.css','lib\tool-failure-loop.mjs','lib\model-tool-schema-annotations.mjs')){
    Assert (Test-Path -LiteralPath (Join-Path $app $name) -PathType Leaf) ('Missing recovered app feature: '+$name)
  }
  $
  $report.checks+=@{name='installed-source-fingerprint';passed=$true;fingerprint=$pair.installed}
  if($Mode -eq 'upgrade'){Assert ($pair.installed -cne $report.baselineFingerprint) 'Upgrade failed to change application source.';$report.checks+=@{name='actual-published-version-upgrade';passed=$true}}
  $report.stage='native-runtime'
  $runtimeFile=Join-Path $work 'runtime-validation.json'
  & node (Join-Path $SourceRoot 'scripts\verify-installed-runtime.mjs') --app-dir $app --exe $exe --test-root (Join-Path $work 'runtime') --report $runtimeFile --expected-version '2.40.85' --expected-fingerprint $m.appFingerprint --hidden-only
  Assert ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $runtimeFile)) 'Native Runtime verification failed.'
  $runtime=ReadJson $runtimeFile
  Assert ($runtime.passed -eq $true -and @($runtime.failures).Count -eq 0) 'Native Runtime report contains failures.'
  foreach($key in @('startup','restart','window','shutdown','profileBackup','diagnostics')){
    Assert ($runtime[$key].passed -eq $true) ('Native runtime did not pass '+$key)
  }
  Assert ($runtime.shutdown.nativeQuitVerified -eq $true -and $runtime.shutdown.forcedTerminationUsed -eq $false) 'Native Runtime required forced termination.'
  $
  Assert ((Hash $sentinel) -ceq $sentinelHash) 'Runtime verification altered existing user profile sentinel.'
  $report.checks+=@{name='native-runtime-and-profile';passed=$true}
  $mainPassed=$true
}catch{
  $report.errors+=@{stage=$report.stage;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}
}finally{
  $report.stage='uninstall'
  try {
    if($installStarted) {
      $uninstallers=@(Get-ChildItem -LiteralPath $install -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue)
      Assert ($uninstallers.Count -eq 1) 'Cannot uniquely identify installed uninstaller.'
      $uninstaller=$uninstallers[0].FullName
      InvokeSetup $uninstaller '/S /currentuser'
      $deadline=[DateTime]::UtcNow.AddSeconds(20)
      while((Test-Path -LiteralPath $install) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 250}
      Assert (!(Test-Path -LiteralPath $install)) 'Uninstall left the owned application directory.'
      Assert (@(Registered).Count -eq 0) 'Uninstall left registered application records.'
      Assert (@(Shortcuts).Count -eq 0) 'Uninstall left application shortcuts.'
      Assert (@(Get-Process -Name BLACKICE -ErrorAction SilentlyContinue).Count -eq 0) 'Uninstall left application process.'
      if($sentinelHash){Assert ((Test-Path -LiteralPath $sentinel) -and (Hash $sentinel) -ceq $sentinelHash) 'Uninstaller altered persistent profile.'}
      $report.checks+=@{name='clean-uninstall-and-profile-retention';passed=$true}
    }
    $cleanupPassed=$true
  }catch{
    $report.errors+=@{stage='uninstall';error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}
  }
  $report.passed=$mainPassed -and $cleanupPassed
  $report.stage='finished'
  $report.completedAt=[DateTime]::UtcNow.ToString('o')
  SavedReport
}
Assert $report.passed 'Recovery installer diagnostic failed; inspect uploaded evidence. This is not a release qualification.'