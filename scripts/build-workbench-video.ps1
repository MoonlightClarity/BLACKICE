# Reproducible native Workbench video helper build (Windows x64).
# No globally installed Go or private binary is required.
param([switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if(-not [Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required.'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$goVersion='go1.27.1'
$download='https://dl.google.com/go/go1.27.1.windows-amd64.zip'
$officialSHA='A3911B5E0E1B1053F25ED0675F4C1C6AAD1E2BFCF253DF2B9BE4CAABD2EDD95D'
$build=Join-Path $repo '.build'
$tools=Join-Path $build 'toolchains'
$archive=Join-Path $tools ($goVersion+'.windows-amd64.zip')
$toolchainHome=Join-Path $tools $goVersion
$go=Join-Path $toolchainHome 'go\bin\go.exe'
$module=Join-Path $repo 'scripts\workbench-native-stream'
$outDir=Join-Path $repo 'resources\guest'
$out=Join-Path $outDir 'workbench-guest-video.exe'
New-Item -ItemType Directory -Path $tools -Force|Out-Null
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()}
if(!$VerifyOnly){
  if(!(Test-Path -LiteralPath $archive)){
    $partial=$archive+'.partial'
    if(Test-Path -LiteralPath $partial){throw 'A partial toolchain download exists; inspect the partial file before retrying.'}
    try{
      $curl=Join-Path $env:SystemRoot 'System32\curl.exe'
      & $curl --location --fail --silent --show-error --connect-timeout 20 --max-time 180 --output $partial $download
      if($LASTEXITCODE -ne 0){throw 'Pinned Go toolchain download failed.'}
      if((Hash $partial) -ne $officialSHA){throw 'Downloaded Go toolchain SHA-256 does not match the official pinned value.'}
      [IO.File]::Move($partial,$archive)
    }finally{if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue}}
  }
  if((Hash $archive) -ne $officialSHA){throw 'Cached Go toolchain SHA-256 mismatch; do not use it.'}
  if(!(Test-Path -LiteralPath $go)){
    if(Test-Path -LiteralPath $toolchainHome){throw 'The cached Go extraction is incomplete; inspect it before retrying.'}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive,$toolchainHome)
  }
}
if(!(Test-Path -LiteralPath $go)){throw 'Pinned Go toolchain not available.'}
$actual=& $go version
if($LASTEXITCODE -ne 0 -or $actual -notmatch 'go version go1[.]27[.]1 windows/amd64'){
  throw ('Unexpected Go version: '+$actual)
}
$env:GOTOOLCHAIN='local'
$env:GOOS='windows'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
$env:GOPATH=Join-Path $build 'go-path'
$env:GOCACHE=Join-Path $build 'go-cache'
$env:GOPROXY='https://proxy.golang.org,direct'
if(!(Test-Path (Join-Path $module 'go.sum'))){throw 'The committed go.sum lockfile is required.'}
if(!$VerifyOnly){
  New-Item -ItemType Directory -Path $outDir -Force|Out-Null
  $temp=$out+'.staged'
  if(Test-Path -LiteralPath $temp){throw 'A previous staged native video build exists; inspect it before retrying.'}
  Push-Location $module
  try{
    & $go mod download
    if($LASTEXITCODE -ne 0){throw 'Pinned module download failed.'}
    & $go mod verify
    if($LASTEXITCODE -ne 0){throw 'Pinned module integrity verification failed.'}
    & $go build -mod=readonly -trimpath -buildvcs=false '-ldflags=-s -w -H=windowsgui' -o $temp .
    if($LASTEXITCODE -ne 0){throw 'Guest native capture build failed.'}
    $metadata=(& $go version -m $temp) -join [Environment]::NewLine
    if($LASTEXITCODE -ne 0 -or
       $metadata -notmatch 'github[.]com/go-mswin/screencapture\s+v0[.]4[.]0' -or
       $metadata -notmatch 'github[.]com/gen2brain/jpegn\s+v0[.]6[.]2'){
      throw 'Guest binary module metadata did not match the pinned capture and SIMD JPEG libraries.'
    }
    if((Get-Item $temp).Length -lt 200000){throw 'Native capture executable is unexpectedly small.'}
    Move-Item -LiteralPath $temp -Destination $out -Force
  }finally{
    Pop-Location
    if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
  }
}
if(!(Test-Path -LiteralPath $out)){throw 'Build output missing.'}
$receipt=[ordered]@{
  format=1
  target='windows-amd64'
  toolchain=$goVersion
  toolchainSha256=$officialSHA.ToLowerInvariant()
  screencapture='github.com/go-mswin/screencapture@v0.4.0'
  jpegEncoder='github.com/gen2brain/jpegn@v0.6.2'
  cgoEnabled=$false
  binary='resources/guest/workbench-guest-video.exe'
  binarySha256=(Hash $out).ToLowerInvariant()
  binaryBytes=(Get-Item $out).Length
  verified=$true
}
New-Item -ItemType Directory -Path $build -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $build 'guest-video-build-receipt.json'),
  ($receipt|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
$receipt|ConvertTo-Json -Compress -Depth 4
