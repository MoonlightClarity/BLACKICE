# Provision the reproducible Windows FreeRDP toolchain for BLACKICE Workbench.
# No GUI, VM launch, desktop focus change, host configuration or guest mutation.
# The client and every transitive UCRT64 package are replayed from the committed lock.
[CmdletBinding()]
param(
  [string]$BuildRoot = '',
  [string]$LockPath = '',
  [switch]$VerifyOnly,
  [switch]$FreezeLock
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'workbench-freerdp-lock.ps1')
if(-not $LockPath){$LockPath=Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\workbench-freerdp-dependencies.lock.json'}
$lock=Read-WorkbenchFreeRdpLock $LockPath
if(-not [Environment]::Is64BitOperatingSystem){throw 'FreeRDP Windows Workbench requires 64-bit Windows.'}
if(-not $BuildRoot){$BuildRoot=Join-Path (Split-Path $PSScriptRoot -Parent) '.build\workbench-freerdp'}
$BuildRoot=[IO.Path]::GetFullPath($BuildRoot)
$msysRoot=Join-Path $BuildRoot 'msys64'
$downloadDir=Join-Path $BuildRoot 'downloads'
$archiveUrl=[string]$lock.bootstrap.url
$archive=Join-Path $downloadDir ([IO.Path]::GetFileName(([uri]$archiveUrl).AbsolutePath))
$archiveSHA=[string]$lock.bootstrap.sha256
$packageName=[string]$lock.freerdp.name
$packageVersion=[string]$lock.freerdp.version
$packageSHA=[string]$lock.freerdp.sha256
$exe=Join-Path $msysRoot 'ucrt64\bin\wfreerdp.exe'
$bash=Join-Path $msysRoot 'usr\bin\bash.exe'
function Assert-Hash([string]$file,[string]$expected){
  if(-not (Test-Path -LiteralPath $file)){throw "Missing pinned artifact: $file"}
  $got=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if($got -ne $expected){throw "Pinned SHA-256 mismatch: $file; expected=$expected; actual=$got"}
}
function Invoke-Msys([string]$cmd){
  $previousSystem=$env:MSYSTEM;$previousChere=$env:CHERE_INVOKING
  try {
    $env:MSYSTEM='UCRT64';$env:CHERE_INVOKING='1'
    & $bash -lc $cmd
    if($LASTEXITCODE -ne 0){throw "MSYS2 command failed ($LASTEXITCODE): $cmd"}
  } finally {$env:MSYSTEM=$previousSystem;$env:CHERE_INVOKING=$previousChere}
}
if(-not $VerifyOnly){
  New-Item -ItemType Directory -Force -Path $downloadDir|Out-Null
  if(-not (Test-Path -LiteralPath $bash)){
    if(-not (Test-Path -LiteralPath $archive)){
      Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archive -TimeoutSec 180
    }
    Assert-Hash $archive $archiveSHA
    $tar=Join-Path $env:WINDIR 'System32\tar.exe'
    if(-not (Test-Path $tar)){throw 'Windows tar.exe is required.'}
    & $tar -xf $archive -C $BuildRoot
    if($LASTEXITCODE -ne 0){throw 'MSYS2 archive extraction failed.'}
  }
  if(-not (Test-Path -LiteralPath $bash)){throw 'MSYS2 bootstrap was incomplete.'}
  $cache=Join-Path $msysRoot 'var\cache\pacman\pkg'
  New-Item -ItemType Directory -Force -Path $cache|Out-Null
  foreach($artifact in $lock.packageArtifacts){
    $destination=Join-Path $cache $artifact.file
    if(-not (Test-Path -LiteralPath $destination)){
      $uri='https://repo.msys2.org/mingw/ucrt64/'+[uri]::EscapeDataString($artifact.file)
      $partial=$destination+'.download'
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $partial -TimeoutSec 180
        Assert-Hash $partial $artifact.sha256
        Move-Item -LiteralPath $partial -Destination $destination
      } finally {if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial}}
    }
  }
  # Fail before executing any package if a transitive archive was changed.
  Assert-WorkbenchFreeRdpArtifacts $lock $cache
  $packagePaths=@($lock.packageArtifacts|ForEach-Object { "'/var/cache/pacman/pkg/$($_.file)'" })
  # Keep the full package list out of Windows/MSYS command-line length limits.
  $installName='blackice-freerdp-'+[guid]::NewGuid().ToString('N')+'.sh'
  $installScript=Join-Path $msysRoot "tmp\$installName"
  New-Item -ItemType Directory -Force -Path (Split-Path $installScript -Parent)|Out-Null
  $lines=@('set -eu','packages=(')+$packagePaths+@(')','pacman --noconfirm --needed -U "${packages[@]}"')
  try {
    [IO.File]::WriteAllText($installScript,($lines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    Invoke-Msys "bash /tmp/$installName"
  } finally {if(Test-Path -LiteralPath $installScript){Remove-Item -LiteralPath $installScript}}
}
if(-not (Test-Path -LiteralPath $exe)){throw 'Pinned wfreerdp.exe has not been installed.'}
$installed=([string](Invoke-Msys "pacman -Q $packageName")).Trim()
if($installed -ne "$packageName $packageVersion"){
  throw "FreeRDP version mismatch: expected $packageName $packageVersion, found '$installed'"
}
$inventory=@(Invoke-Msys 'pacman -Q' | Where-Object {$_ -match '^\S+ \S+$'})
$cache=Join-Path $msysRoot 'var\cache\pacman\pkg'
Assert-WorkbenchFreeRdpArtifacts $lock $cache
Assert-WorkbenchFreeRdpInventory $lock $inventory
$artifacts=@($lock.packageArtifacts)
$manifest=[ordered]@{
  schema=1;captureUtc=[DateTime]::UtcNow.ToString('o')
  bootstrap=[ordered]@{url=$archiveUrl;sha256=$archiveSHA}
  freerdp=[ordered]@{name=$packageName;version=$packageVersion;sha256=$packageSHA}
  packages=$inventory;packageArtifacts=$artifacts
  runtime=[ordered]@{executable='msys64/ucrt64/bin/wfreerdp.exe';hypervConsolePort=2179;windowMode='embedded parent HWND';hostWindowActivation='forbidden'}
}
New-Item -ItemType Directory -Path $BuildRoot -Force|Out-Null
$manifestPath=Join-Path $BuildRoot 'freerdp-dependencies.lock.json'
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
if($FreezeLock){
  $target=Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\workbench-freerdp-dependencies.lock.json'
  Copy-Item -LiteralPath $manifestPath -Destination $target -Force
}
Write-Output ("FreeRDP_READY="+$exe)
Write-Output ("FreeRDP_VERSION="+$installed)
Write-Output ("DEPENDENCY_MANIFEST="+$manifestPath)
