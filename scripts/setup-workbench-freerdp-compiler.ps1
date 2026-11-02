# Separate, pinned UCRT64 C/C++ compiler for the custom Workbench child renderer.
# Does not install compiler packages into the locked FreeRDP runtime toolchain.
[CmdletBinding()]
param([string]$BuildRoot='', [string]$LockPath='', [string]$BootstrapArchive='', [switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'workbench-freerdp-lock.ps1')
if(-not $LockPath){$LockPath=Join-Path $repo 'docs\workbench-freerdp-compiler.lock.json'}
$lock=Read-WorkbenchFreeRdpLock -Path $LockPath -ClientField compiler -ClientPackage 'mingw-w64-ucrt-x86_64-gcc'
if(-not [Environment]::Is64BitOperatingSystem){throw 'Workbench compiler requires 64-bit Windows.'}
if(-not $BuildRoot){$BuildRoot=Join-Path $repo '.build\workbench-freerdp-compiler'}
$BuildRoot=[IO.Path]::GetFullPath($BuildRoot)
$originalRoot=[IO.Path]::GetFullPath((Join-Path $repo '.build\workbench-freerdp'))
if($BuildRoot.TrimEnd('\').Equals($originalRoot.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){
  throw 'The compiler must use a separate build folder from the locked FreeRDP runtime.'
}
$msysRoot=Join-Path $BuildRoot 'msys64'
$bash=Join-Path $msysRoot 'usr\bin\bash.exe'
$cache=Join-Path $msysRoot 'var\cache\pacman\pkg'
$bin=Join-Path $msysRoot 'ucrt64\bin'
function Assert-CompilerHash([string]$file,[string]$expected){
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw "Missing pinned artifact: $file"}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected){throw "Pinned SHA-256 mismatch: $file"}
}
function Invoke-CompilerMsys([string]$command){
  $previousSystem=$env:MSYSTEM;$previousChere=$env:CHERE_INVOKING
  try {
    $env:MSYSTEM='UCRT64';$env:CHERE_INVOKING='1'
    & $bash -lc $command
    if($LASTEXITCODE -ne 0){throw "Compiler package command failed ($LASTEXITCODE)."}
  } finally {$env:MSYSTEM=$previousSystem;$env:CHERE_INVOKING=$previousChere}
}
Assert-CompilerHash (Join-Path $repo $lock.freerdpHeaders.lock) $lock.freerdpHeaders.sha256
if(-not $VerifyOnly){
  if(-not (Test-Path -LiteralPath $bash)){
    $name=[IO.Path]::GetFileName(([uri]$lock.bootstrap.url).AbsolutePath)
    if(-not $BootstrapArchive){$BootstrapArchive=Join-Path $originalRoot "downloads\$name"}
    if(-not (Test-Path -LiteralPath $BootstrapArchive)){
      $downloads=Join-Path $BuildRoot 'downloads'
      New-Item -ItemType Directory -Force -Path $downloads|Out-Null
      $BootstrapArchive=Join-Path $downloads $name
      if(-not (Test-Path -LiteralPath $BootstrapArchive)){
        Invoke-WebRequest -UseBasicParsing -Uri $lock.bootstrap.url -OutFile $BootstrapArchive -TimeoutSec 180
      }
    }
    Assert-CompilerHash $BootstrapArchive $lock.bootstrap.sha256
    New-Item -ItemType Directory -Force -Path $BuildRoot|Out-Null
    & (Join-Path $env:WINDIR 'System32\tar.exe') -xf $BootstrapArchive -C $BuildRoot
    if($LASTEXITCODE -ne 0){throw 'Compiler MSYS2 bootstrap extraction failed.'}
  }
  New-Item -ItemType Directory -Force -Path $cache|Out-Null
  foreach($artifact in $lock.packageArtifacts){
    $destination=Join-Path $cache $artifact.file
    if(-not (Test-Path -LiteralPath $destination)){
      $uri='https://repo.msys2.org/mingw/ucrt64/'+[uri]::EscapeDataString($artifact.file)
      $partial=$destination+'.download'
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $partial -TimeoutSec 180
        Assert-CompilerHash $partial $artifact.sha256
        Move-Item -LiteralPath $partial -Destination $destination
      } finally {if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial}}
    }
  }
  Assert-WorkbenchFreeRdpArtifacts $lock $cache
  $installName='blackice-compiler-'+[guid]::NewGuid().ToString('N')+'.sh'
  $installPath=Join-Path $msysRoot "tmp\$installName"
  New-Item -ItemType Directory -Force -Path (Split-Path $installPath -Parent)|Out-Null
  $paths=@($lock.packageArtifacts|ForEach-Object {"'/var/cache/pacman/pkg/$($_.file)'"})
  $lines=@('set -eu','packages=(')+$paths+@(')','pacman --noconfirm --needed -U "${packages[@]}"')
  try {
    [IO.File]::WriteAllText($installPath,($lines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    Invoke-CompilerMsys "bash /tmp/$installName"
  } finally {if(Test-Path -LiteralPath $installPath){Remove-Item -LiteralPath $installPath}}
}
if(-not (Test-Path -LiteralPath $bash)){throw 'Pinned compiler toolchain is not installed.'}
Assert-WorkbenchFreeRdpArtifacts $lock $cache
$inventory=@(Invoke-CompilerMsys 'pacman -Q'|Where-Object {$_ -match '^\S+ \S+$'})
Assert-WorkbenchFreeRdpInventory $lock $inventory
$version=([string](& (Join-Path $bin 'g++.exe') -dumpfullversion)).Trim()
if($LASTEXITCODE -ne 0 -or $version -ne ($lock.compiler.version -split '-')[0]){throw 'Installed compiler version does not match the pinned lock.'}
& node (Join-Path $PSScriptRoot 'verify-workbench-compiler.mjs') $BuildRoot $LockPath
if($LASTEXITCODE -ne 0){throw 'Installed compiler byte verification failed.'}
Write-Output ('GCC_READY='+(Join-Path $bin 'gcc.exe'))
Write-Output ('GXX_READY='+(Join-Path $bin 'g++.exe'))
Write-Output ('FREERDP_HEADERS='+$originalRoot+'\msys64\ucrt64\include')
Write-Output ('FREERDP_IMPORT_LIBS='+$originalRoot+'\msys64\ucrt64\lib')
