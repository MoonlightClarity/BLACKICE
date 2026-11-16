# BLACKICE v2.39.99 — proposed verified disposable GitHub-hosted Windows intake.
# Future independent root review/dispatch only; NEVER execute on Dylan's computer.
# Requires prior STEP-SCOPED GitHub token download (fetcher), but this step has NO token.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference=$false
function Assert($Condition,[string]$Message) {
  if (!$Condition) { throw [InvalidOperationException]::new($Message) }
}
function Same-Path([string]$A,[string]$B) {
  return [IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\')
}
function Under-Path([string]$File,[string]$Directory) {
  return [IO.Path]::GetFullPath($File).StartsWith(
    [IO.Path]::GetFullPath($Directory).TrimEnd('\')+'\',
    [StringComparison]::OrdinalIgnoreCase)
}
function Verify-File([string]$File,[int64]$Bytes,[string]$Sha256) {
  Assert (Test-Path -LiteralPath $File -PathType Leaf) 'Required exact input file missing.'
  $item=Get-Item -LiteralPath $File -ErrorAction Stop
  Assert (!$item.PSIsContainer -and !(($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'Input path is not an ordinary file.'
  Assert ($item.Length -eq $Bytes) 'Expected immutable input byte count changed.'
  Assert ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Sha256) 'Immutable input SHA256 mismatch.'
}
function Write-Receipt([string]$File,$Value) {
  Assert (!(Test-Path -LiteralPath $File)) 'Receipt output already exists; do not replay.'
  $utf8=[Text.UTF8Encoding]::new($false)
  $bytes=$utf8.GetBytes(($Value|ConvertTo-Json -Depth 30)+[Environment]::NewLine)
  $h=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$h.Write($bytes,0,$bytes.Length);$h.Flush($true)}
  finally {$h.Dispose()}
}
function Read-Json([string]$File,[int64]$Limit) {
  $info=Get-Item -LiteralPath $File -ErrorAction Stop
  Assert (!$info.PSIsContainer -and !$info.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -and $info.Length -gt 0 -and $info.Length -le $Limit) 'Bounded JSON receipt missing or nonregular.'
  return (Get-Content -LiteralPath $File -Raw -ErrorAction Stop | ConvertFrom-Json -AsHashtable)
}
function Assert-Hosted {
  Assert ($IsWindows) 'Native disposable Windows runner required.'
  Assert ($env:GITHUB_ACTIONS -ceq 'true') 'Genuine GitHub Actions context required.'
  Assert ($env:RUNNER_ENVIRONMENT -ceq 'github-hosted') 'Never run on a self-hosted/user PC.'
  Assert ($env:RUNNER_OS -ceq 'Windows' -and $env:RUNNER_ARCH -ceq 'X64') 'Hosted Windows x64 required.'
  Assert ($env:GITHUB_REPOSITORY -ceq 'MoonlightClarity/BLACKICE' -and $env:GITHUB_SERVER_URL -ceq 'https://github.com') 'Unexpected GitHub host or repository.'
  Assert ($env:EXPECTED_WORKFLOW_COMMIT -cmatch '^[a-f0-9]{40}$' -and $env:GITHUB_SHA -ceq $env:EXPECTED_WORKFLOW_COMMIT) 'Workflow SHA not independently approved.'
  Assert ($env:RUNNER_TEMP -and [IO.Path]::IsPathRooted($env:RUNNER_TEMP)) 'Actual RUNNER_TEMP absent.'
  Assert ($env:GITHUB_WORKSPACE -and [IO.Path]::IsPathRooted($env:GITHUB_WORKSPACE)) 'Actual checked-out workflow absent.'
  # The step that fetched draft assets receives GITHUB_TOKEN; this installer stage MUST NOT.
  Assert (![bool]$env:GITHUB_TOKEN) 'Never propagate credential into installer/native subprocess.'
}
function Extract-Pinned-Supplement([string]$Archive,[string]$Destination) {
  $allowed=@{
    'validation/compatibility-manifest.json'=@{bytes=2349;sha='a2bcbd87d168ab589acb7116324648b74140d3de5a6b800371220b54d7784054'}
    'validation/source-reconstruct-PORTABLE.REVIEW.mjs'=@{bytes=16368;sha='25c99f2092ba7c9d2a59d93ba961238f7e748d045a30c656626b67fc7425cad8'}
    'validation/external-suite-verifier-sparse-compat.REVIEW.mjs'=@{bytes=15610;sha='f219d90c3550f62cc42a77ef47dd022c9b23bb2f6e6a70c17c77fc574fcf65fe'}
    'validation/windows-installer-sparse-compat.REVIEW.ps1'=@{bytes=35831;sha='f713d549f9b923b3005519983a0e40bcbb2099723a61d20fb52550871568530d'}
  }
  Assert (!(Test-Path -LiteralPath $Destination)) 'Previous extracted supplement exists.'
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipHandle=[IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $present=@{}
    $total=[int64]0
    foreach($entry in $zipHandle.Entries){
      $name=[string]$entry.FullName
      Assert ($name -and $name -notmatch '^[A-Za-z]:|^/|^\\|\\|//|:' -and $name -notmatch '\.\.' -and $name -notmatch '[<>|?*]' -and !$name.Contains([char]0)) 'Supplement has unsafe ZIP entry path.'
      Assert ($seen.Add($name)) 'Duplicate/case-colliding ZIP entry.'
      Assert ((($entry.ExternalAttributes -shr 16) -band 0xF000) -ne 0xA000) 'Archive link prohibited.'
      if($name -ceq 'validation/'){
        Assert ($entry.Length -eq 0) 'Supplement directory entry contains data.'
        continue
      }
      Assert ($allowed.ContainsKey($name)) 'Unexpected supplement ZIP file.'
      Assert ($entry.Length -eq $allowed[$name].bytes) 'Supplement uncompressed file size changed.'
      $total+=$entry.Length
      Assert ($total -le 90000) 'Supplement decompression bound exceeded.'
      $present[$name]=$entry
    }
    Assert ($present.Count -eq $allowed.Count -and $seen.Count -eq $allowed.Count+1) 'Supplement ZIP file inventory incomplete.'
    New-Item -ItemType Directory -Path $Destination -ErrorAction Stop|Out-Null
    foreach($name in $allowed.Keys){
      $target=[IO.Path]::GetFullPath((Join-Path $Destination ($name.Replace('/','\'))))
      Assert (Under-Path $target $Destination) 'Supplement extraction target escapes disposable directory.'
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      $inputStream=$present[$name].Open()
      $outStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $inputStream.CopyTo($outStream);$outStream.Flush($true) }
      finally { $inputStream.Dispose();$outStream.Dispose() }
      Verify-File $target ([int64]$allowed[$name].bytes) ([string]$allowed[$name].sha)
    }
    Assert (@(Get-ChildItem -LiteralPath $Destination -File -Recurse).Count -eq $allowed.Count) 'Unexpected extracted supplement files.'
  }finally{$zipHandle.Dispose()}
}
Assert-Hosted
$workspace=Join-Path $env:RUNNER_TEMP 'b99'
Assert (Under-Path $workspace $env:RUNNER_TEMP) 'Workspace outside actual runner temp.'
Assert (Test-Path -LiteralPath $workspace -PathType Container) 'Verified fetch step did not create workspace.'
$pathCandidate=Join-Path $workspace 'da1cb32-v23999-sparse-git-compat-002\source\lib\vendor\catalyst\upstream\src\domain\techniquesCatalogWorkflowsDecisionUncertainty.ts'
Assert ([IO.Path]::GetFullPath($pathCandidate).Length -lt 245) 'Windows filename would exceed safe short-path budget.'
$downloadReceipt=Read-Json (Join-Path $workspace 'download-receipt.json') 16384
Assert ($downloadReceipt.kind -ceq 'genuine-hosted-readonly-draft-intake' -and
  $downloadReceipt.realHostedEnvironmentAsserted -eq $true -and
  $downloadReceipt.releaseId -eq 446663182 -and
  $downloadReceipt.draft -eq $true -and
  $null -eq $downloadReceipt.publishedAt -and
  $downloadReceipt.gitTagAbsent -eq $true -and
  $downloadReceipt.workflowCommit -ceq $env:GITHUB_SHA -and
  @($downloadReceipt.assets).Count -eq 3) 'Actual GitHub-hosted draft download receipt incomplete.'
$setup=Join-Path $workspace 'Blackice-2.39.99-Setup.exe'
$zipSource=Join-Path $workspace 'da1cb32-v23999-minimal-runner-inputs-REVIEW-002.zip'
$zipCompat=Join-Path $workspace 'da1cb32-v23999-sparse-git-compatibility-supplement-REVIEW-001.zip'
$zipVendor=Join-Path $workspace '7zip-win-x64.tar.gz'
Verify-File $setup 115734689 '7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'
Verify-File $zipSource 19515258 '2fa2fc4fd79113b7819ae7e7ab3b89ac4b25c2709997fb8a349774620b1ee606'
Verify-File $zipCompat 24521 'd78315f5a72569153ced00c5778032a51ffca90ee50981b1387801f157186327'
Verify-File $zipVendor 491982 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'
$vendorRoot=Join-Path $workspace 'vendor'
Assert (!(Test-Path -LiteralPath $vendorRoot)) 'Prior vendor tool extraction exists.'
$entries=@(& tar.exe -tzf $zipVendor)
Assert ($LASTEXITCODE -eq 0) 'Vendor tar.gz listing failed.'
$expectedEntries=@('7zip/','7zip/LICENSE.txt','7zip/bin/','7zip/bin/7za.ps1','7zip/bin/7za.exe','7zip/COPYING')
Assert ((($entries|Sort-Object) -join '|') -ceq (($expectedEntries|Sort-Object) -join '|')) 'Pinned immutable vendor tool archive members changed.'
New-Item -ItemType Directory -Path $vendorRoot -ErrorAction Stop|Out-Null
& tar.exe -xzf $zipVendor -C $vendorRoot
Assert ($LASTEXITCODE -eq 0) 'Vendor tar.gz extraction failed.'
$archiver=Join-Path $vendorRoot '7zip\bin\7za.exe'
Verify-File $archiver 849920 '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'
# Never execute unverified vendor binary.
$compatRoot=Join-Path $workspace 'compat'
Extract-Pinned-Supplement $zipCompat $compatRoot
$compatManifest=Read-Json (Join-Path $compatRoot 'validation\compatibility-manifest.json') 8192
Assert ($compatManifest.sourceCommit -ceq 'da1cb32b24b6a80eb94a1f5ab9a7992598e07201' -and
  $compatManifest.sourceBundleZipSha256 -ceq '2fa2fc4fd79113b7819ae7e7ab3b89ac4b25c2709997fb8a349774620b1ee606' -and
  $compatManifest.originalInstallerAssetId -eq 753681965 -and
  $compatManifest.originalInstallerSha256 -ceq '7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022') 'Compatibility manifest does not bind exact frozen source/installer.'
$reconstructor=Join-Path $compatRoot 'validation\source-reconstruct-PORTABLE.REVIEW.mjs'
$sidecar=Join-Path $compatRoot 'validation\external-suite-verifier-sparse-compat.REVIEW.mjs'
$validator=Join-Path $compatRoot 'validation\windows-installer-sparse-compat.REVIEW.ps1'
Verify-File $reconstructor 16368 '25c99f2092ba7c9d2a59d93ba961238f7e748d045a30c656626b67fc7425cad8'
Verify-File $sidecar 15610 'f219d90c3550f62cc42a77ef47dd022c9b23bb2f6e6a70c17c77fc574fcf65fe'
Verify-File $validator 35831 'f713d549f9b923b3005519983a0e40bcbb2099723a61d20fb52550871568530d'
# Existing source-owned reconstruction consumes only original ZIP002 and exact
# archive/working tree objects. It does NOT fetch historical Git ancestry.
& node $reconstructor --prepare --workspace $workspace --archiver $archiver
Assert ($LASTEXITCODE -eq 0) 'Exact source/Git object reconstruction failed; no installer admitted.'
$root=Join-Path $workspace 'da1cb32-v23999-sparse-git-compat-002'
$sourceRoot=Join-Path $root 'source'
$bundleInputs=Join-Path $root 'inputs'
$proof=Read-Json (Join-Path $workspace 'da1cb32-v23999-sparse-git-compat-source-reconstruction-002.json') 10000
Assert ($proof.status -ceq 'passed_source_only_no_runner_or_installer' -and
  $proof.gitHead -ceq 'da1cb32b24b6a80eb94a1f5ab9a7992598e07201' -and
  $proof.gitTree -ceq 'efa4caf563ed3c4e7e0499707c3d40579b56043e' -and
  $proof.originalSourceIndexSha256 -ceq '45f03fccacd3c10cc9743c33fca35e9541220544b09aaf6b4d4c5b2881475b6d' -and
  $proof.originalAppFingerprint -ceq '099cc02d06f8ba4702f3c2743a407af091fac89f7b8079082fee567a65443855' -and
  $proof.gitPorcelainClean -eq $true -and $proof.strictNoUnexpectedFiles -eq $true) 'Git source proof does not establish exact clean source.'
Assert ((Under-Path $sourceRoot $env:RUNNER_TEMP) -and (Under-Path $bundleInputs $env:RUNNER_TEMP)) 'Source escaped disposable temp.'
$sourceHead=(& git -C $sourceRoot rev-parse HEAD).Trim()
Assert ($LASTEXITCODE -eq 0 -and $sourceHead -ceq $proof.gitHead) 'Real reconstructed Git HEAD changed.'
$sourceTree=(& git -C $sourceRoot rev-parse 'HEAD^{tree}').Trim()
Assert ($LASTEXITCODE -eq 0 -and $sourceTree -ceq $proof.gitTree) 'Real reconstructed Git tree changed.'
Assert (@(& git -C $sourceRoot status --porcelain=v1 --untracked-files=all).Count -eq 0) 'Reconstructed exact Git source no longer clean.'
$receiptOriginal=Join-Path $bundleInputs 'suite\windows-2.39.99.json'
$tapOriginal=Join-Path $bundleInputs 'suite\suite.tap'
$terminalOriginal=Join-Path $bundleInputs 'suite\terminal.json'
$manifestOriginal=Join-Path $bundleInputs 'release\blackice-public-release.json'
Verify-File $receiptOriginal 5105 '653f5b47ae4c63f336018baaf4a184d03c484296ab3a7c8428b608fce61f8444'
Verify-File $tapOriginal 2173230 'e95db70970eccf633551d74d26e94eade607988dcbb01a87bfc57238ff18b2fa'
Verify-File $terminalOriginal 5933 'db49b225af40d563b06bfee1465713dc3fe85874cb03b0f33343b1af3918df79'
Verify-File $manifestOriginal 564 '379f6c45b1291544db1859fde0bff064ab39c31462a2d5db418223b5b11d360e'
$distribution=Join-Path $workspace 'dist'
Assert (!(Test-Path -LiteralPath $distribution)) 'Prior distribution directory exists.'
New-Item -ItemType Directory -Path $distribution -ErrorAction Stop|Out-Null
Copy-Item -LiteralPath $setup -Destination (Join-Path $distribution 'Blackice-2.39.99-Setup.exe') -ErrorAction Stop
Copy-Item -LiteralPath $manifestOriginal -Destination (Join-Path $distribution 'blackice-public-release.json') -ErrorAction Stop
Verify-File (Join-Path $distribution 'Blackice-2.39.99-Setup.exe') 115734689 '7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'
Verify-File (Join-Path $distribution 'blackice-public-release.json') 564 '379f6c45b1291544db1859fde0bff064ab39c31462a2d5db418223b5b11d360e'
$evidence=Join-Path $workspace 'verification'
Assert (!(Test-Path -LiteralPath $evidence)) 'Existing verification attempt; never duplicate installed effects.'
New-Item -ItemType Directory -Path $evidence -ErrorAction Stop|Out-Null
$preflight=[ordered]@{
 format=1;product='BLACKICE';kind='genuine-hosted-VM-preinstall-input-check'
 checkedAt=[DateTime]::UtcNow.ToString('o')
 sourceCommit=$proof.gitHead;sourceTree=$proof.gitTree
 appFingerprint=$proof.originalAppFingerprint;sourceIndexSha256=$proof.originalSourceIndexSha256
 draftReleaseId=446663182
 installerAssetId=753681965;installerBytes=115734689;installerSha256='7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'
 sourceZIPAssetId=754534773;sourceZIPSha256='2fa2fc4fd79113b7819ae7e7ab3b89ac4b25c2709997fb8a349774620b1ee606'
 compatibilityAssetId=754540104;compatibilitySha256='d78315f5a72569153ced00c5778032a51ffca90ee50981b1387801f157186327'
 vendorArchiveSha256='be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'
 archiverExeSha256='223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'
 sidecarSha256='f219d90c3550f62cc42a77ef47dd022c9b23bb2f6e6a70c17c77fc574fcf65fe'
 validatorPS1Sha256='f713d549f9b923b3005519983a0e40bcbb2099723a61d20fb52550871568530d'
 realHostedRunnerIdentityAsserted=$true
 distinctWorkflowCommit=$env:GITHUB_SHA
 installedValidationPending=$true
 noCredentialsInInstallerEnvironment=$true
}
Write-Receipt (Join-Path $evidence 'blackice-intake-preinstall.json') $preflight
# Explicit no-token boundary between read-only download step and native app.
Assert (![bool]$env:GITHUB_TOKEN) 'Token appeared before installer admission.'
# Existing reviewed product verifier retains its exact source, suite, image, PE
# requestedExecutionLevel, registry, both shortcut targets, installed-file hashes,
# hidden runtime startup/restart/shutdown, disposable backup/restore, diagnostics,
# profile sentinel and clean uninstall. No code is bypassed below.
$parameters=@{
 SourceRoot=$sourceRoot
 Distribution=$distribution
 EvidenceDirectory=$evidence
 Tag='v2.39.99'
 ExpectedSha256='7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'
 ExpectedFingerprint='099cc02d06f8ba4702f3c2743a407af091fac89f7b8079082fee567a65443855'
 ExpectedSourceCommit='da1cb32b24b6a80eb94a1f5ab9a7992598e07201'
 ExpectedWorkflowCommit=$env:GITHUB_SHA
 ExpectedSourceTree='efa4caf563ed3c4e7e0499707c3d40579b56043e'
 ExpectedSourceIndexSha256='45f03fccacd3c10cc9743c33fca35e9541220544b09aaf6b4d4c5b2881475b6d'
 ExternalSuiteReceipt=$receiptOriginal
 ExternalSuiteTap=$tapOriginal
 ExternalSuiteTerminal=$terminalOriginal
 ExternalSuiteVerifier=$sidecar
 ExpectedExternalVerifierSha256='f219d90c3550f62cc42a77ef47dd022c9b23bb2f6e6a70c17c77fc574fcf65fe'
 ExpectedSuiteReceiptSha256='653f5b47ae4c63f336018baaf4a184d03c484296ab3a7c8428b608fce61f8444'
 ExpectedSuiteTapSha256='e95db70970eccf633551d74d26e94eade607988dcbb01a87bfc57238ff18b2fa'
 ExpectedSuiteTerminalSha256='db49b225af40d563b06bfee1465713dc3fe85874cb03b0f33343b1af3918df79'
 ExpectedManifestSha256='379f6c45b1291544db1859fde0bff064ab39c31462a2d5db418223b5b11d360e'
}
& $validator @parameters
$report=Read-Json (Join-Path $evidence 'blackice-windows-install-validation.json') 1000000
$readiness=Read-Json (Join-Path $evidence 'blackice-public-readiness.json') 1000000
Assert ($report.passed -eq $true -and $report.cleanup.passed -eq $true -and
  $report.cleanup.forcedTerminationUsed -eq $false) 'Native Windows install/uninstall acceptance did not pass.'
Assert ($readiness.passed -eq $true -and $readiness.publicReleaseReady -eq $true -and
  $readiness.classification -ceq 'ready-for-public-release-unsigned' -and
  $readiness.published -eq $false -and
  $readiness.signing.publisherVerified -eq $false) 'Source-owned public release check did not pass as explicitly unsigned.'
Write-Receipt (Join-Path $evidence 'blackice-intake-terminal.json') ([ordered]@{
 format=1;product='BLACKICE';kind='genuine-VM-disposable-installer-intake-result'
 at=[DateTime]::UtcNow.ToString('o')
 sourceCommit='da1cb32b24b6a80eb94a1f5ab9a7992598e07201'
 originalInstallerAssetId=753681965;originalInstallerSha256='7b5d2e6c82485a97d04888c5a055691a186a8ce220b12887396ab656c5652022'
 installedGuardsPassed=$true;shortcutChecksPassed=$true
 runtimeAndUninstallChecksPassed=$true
 sourceOwnedReleaseReadyUnsigned=$true
 published=$false;tagCreatedOrMoved=$false
})
Write-Output 'BLACKICE 2.39.99: verified disposable hosted install/shortcut/runtime/uninstall and unsigned source release gate; NOT PUBLISHED.'
