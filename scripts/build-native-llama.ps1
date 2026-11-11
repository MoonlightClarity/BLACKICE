param(
  [ValidateSet('cpu', 'cuda')][string]$Backend = 'cpu',
  [string]$CMake = 'cmake'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$upstream = Join-Path $source 'third_party\llama.cpp'
if (-not (Test-Path (Join-Path $upstream 'CMakeLists.txt'))) {
  throw "llama.cpp source is missing. From BLACKICE run: git submodule update --init third_party/llama.cpp"
}
$build = Join-Path $source ".build\native-inference\llama.cpp-$Backend"
$output = Join-Path $source 'resources\native-inference\llama.cpp'
$cuda = if ($Backend -eq 'cuda') { 'ON' } else { 'OFF' }
$cmakeCmd = Get-Command $CMake -ErrorAction SilentlyContinue
if (-not $cmakeCmd) {
  throw "CMake is not installed. Install a CMake toolchain and a C/C++ compiler to build the bundled llama.cpp engine."
}
New-Item -ItemType Directory -Path $build -Force | Out-Null
$configure = @('-S', $upstream, '-B', $build, '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF', '-DLLAMA_BUILD_TOOLS=ON',
  '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF',
  "-DGGML_CUDA=$cuda", '-DGGML_NATIVE=OFF')
& $CMake @configure
if ($LASTEXITCODE -ne 0) { throw "llama.cpp CMake configure failed: $LASTEXITCODE" }
& $CMake --build $build --config Release --target llama-cli --parallel 4
if ($LASTEXITCODE -ne 0) { throw "llama.cpp build failed: $LASTEXITCODE" }

$exe = Get-ChildItem (Join-Path $build 'bin') -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'llama-cli.exe' } | Select-Object -First 1
if (-not $exe) { throw 'llama.cpp build succeeded, but llama-cli.exe could not be found.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item $exe.FullName (Join-Path $output 'llama-cli.exe') -Force
# Copy any runtime libraries produced alongside llama-cli (static builds usually need none).
Get-ChildItem $exe.DirectoryName -Filter '*.dll' -File -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $output $_.Name) -Force }
$sourceRevision = (& git -C $upstream rev-parse HEAD).Trim()
$hash = (Get-FileHash (Join-Path $output 'llama-cli.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = @{
  engine = 'llama.cpp'
  backend = $Backend
  sourceRevision = $sourceRevision
  sourceRepository = 'https://github.com/ggml-org/llama.cpp'
  binarySha256 = $hash
  bundledAt = (Get-Date).ToUniversalTime().ToString('o')
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Path (Join-Path $output 'backend.json') -Encoding UTF8
Copy-Item (Join-Path $upstream 'LICENSE') (Join-Path $output 'LICENSE') -Force
Write-Output "Bundled llama.cpp $Backend executable: $(Join-Path $output 'llama-cli.exe')"
Write-Output "Source revision: $sourceRevision"
Write-Output "SHA-256: $hash"
