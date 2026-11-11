param(
  [string]$Zig = '',
  [string]$Source = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Source = if ($Source) { $Source } else { Join-Path $root 'scripts\native-kernels\matvec-simd.c' }
$Output = if ($Output) { $Output } else { Join-Path $root 'lib\native-inference\kernels\matvec-simd.wasm' }

if (-not $Zig) {
  $candidate = Get-Command zig.exe -ErrorAction SilentlyContinue
  if ($candidate) { $Zig = $candidate.Source }
  else {
    $candidate = Get-ChildItem (Join-Path $root '.build\native-parity\toolchain') -Filter 'zig.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $Zig = $candidate.FullName }
  }
}
if (-not $Zig -or -not (Test-Path $Zig)) { throw 'Zig compiler not found. Install Zig 0.15.2 to rebuild BLACKICE-owned WebAssembly SIMD kernels.' }

New-Item -ItemType Directory -Force -Path (Split-Path $Output) | Out-Null
$version = (& $Zig version).Trim()
$args = @(
  'cc', '-target', 'wasm32-freestanding', '-O3', '-msimd128',
  '-fno-builtin', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,--export=__heap_base',
  '-Wl,--export=matvec_f32', '-Wl,--max-memory=268435456',
  '-o', $Output, $Source
)
& $Zig @args
if ($LASTEXITCODE -ne 0) { throw "BLACKICE SIMD kernel build failed (Zig code $LASTEXITCODE)." }
if (-not (Test-Path $Output)) { throw 'Zig returned success without producing the requested kernel.' }

$wasmSha = (Get-FileHash -Algorithm SHA256 $Output).Hash.ToLowerInvariant()
$sourceSha = (Get-FileHash -Algorithm SHA256 $Source).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  format = 'blackice-owned-simd-v1'
  kernel = 'matvec_f32'
  author = 'BLACKICE'
  compiler = "zig $version"
  target = 'wasm32-freestanding+simd128'
  source = 'scripts/native-kernels/matvec-simd.c'
  sourceSha256 = $sourceSha
  wasmSha256 = $wasmSha
  quantization = 'none'
}
$manifestPath = Join-Path (Split-Path $Output) 'matvec-simd.manifest.json'
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 $manifestPath
Write-Output "ZIG_VERSION=$version"
Write-Output "WASM=$Output"
Write-Output "WASM_BYTES=$((Get-Item $Output).Length)"
Write-Output "WASM_SHA256=$wasmSha"
