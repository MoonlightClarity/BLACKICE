param([switch]$SelfTestOnly,[string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$runtime=Join-Path $repo '.build\workbench-freerdp\msys64\ucrt64'
$compiler=Join-Path $repo '.build\workbench-freerdp-compiler\msys64\ucrt64\bin'
$source=Join-Path $PSScriptRoot 'workbench-freerdp-client\main.cpp'
$output=Join-Path $repo '.build\workbench-freerdp-client.exe'
$receiptPath=Join-Path $repo '.build\workbench-freerdp-client-build.json'
$runtimeLock=Join-Path $repo 'docs\workbench-freerdp-dependencies.lock.json'
$compilerLock=Join-Path $repo 'docs\workbench-freerdp-compiler.lock.json'
$iconSvg=Join-Path $repo 'desktop\workbench-icon.svg'
$iconPng=Join-Path $repo 'desktop\workbench-icon.png'
$iconIco=Join-Path $repo 'desktop\workbench-icon.ico'
$iconManifest=Join-Path $repo 'desktop\workbench-icon.manifest.json'
$iconBuilder=Join-Path $repo 'desktop\build-icon.mjs'
$iconResource=Join-Path $PSScriptRoot 'workbench-freerdp-client\workbench-icon.rc'
$iconObject=Join-Path $repo '.build\workbench-freerdp-icon.o'
$windres=Join-Path $compiler 'windres.exe'
if(!$RuntimeDirectory){$RuntimeDirectory=Join-Path $repo '.build\workbench-freerdp-runtime-openssl'}
$RuntimeDirectory=[IO.Path]::GetFullPath($RuntimeDirectory)
$runtimeManifest=Join-Path $RuntimeDirectory 'runtime-manifest.json'
if(!(Test-Path -LiteralPath $runtimeManifest)){throw 'Stage and verify the pinned FreeRDP runtime, including its OpenSSL providers, first.'}
$opensslConfig=Join-Path $RuntimeDirectory 'etc\ssl\openssl.cnf'
$opensslModules=Join-Path $RuntimeDirectory 'lib\ossl-modules'
if(!(Test-Path -LiteralPath $opensslConfig) -or !(Test-Path -LiteralPath (Join-Path $opensslModules 'legacy.dll'))){throw 'The staged runtime OpenSSL config and legacy provider are required.'}
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
$binding=[ordered]@{sourceSha256=(Hash $source);compilerLockSha256=(Hash $compilerLock);runtimeLockSha256=(Hash $runtimeLock);runtimeManifestSha256=(Hash $runtimeManifest)}
$iconBinding=[ordered]@{resourceId=101;svgSha256=(Hash $iconSvg);pngSha256=(Hash $iconPng);icoSha256=(Hash $iconIco);
 rcSha256=(Hash $iconResource);manifestSha256=(Hash $iconManifest);buildScriptSha256=(Hash $PSCommandPath);
 iconBuilderSha256=(Hash $iconBuilder);windresSha256=(Hash $windres)}
# This executable hash was verified against .MTREE in the SHA-locked MSYS2
# mingw-w64-ucrt-x86_64-binutils 2.47-4 archive. Never use a PATH-selected tool.
if($iconBinding.windresSha256 -ne '38ab4f34eb2a76cfece48026d737a1321c5441b70d35ad7daee96325ea1ae210'){
 throw 'The resource compiler does not match the pinned binutils archive.'
}
$derived=Get-Content -LiteralPath $iconManifest -Raw|ConvertFrom-Json
if($derived.schemaVersion -ne 1 -or $derived.source -ne 'workbench-icon.svg' -or
 $derived.sourceSha256 -ne $iconBinding.svgSha256 -or $derived.pngSha256 -ne $iconBinding.pngSha256 -or
 $derived.icoSha256 -ne $iconBinding.icoSha256 -or ($derived.sizes -join ',') -ne '16,24,32,48,64,128,256'){
 throw 'Render the Workbench icon from its vector source with the pinned Electron first.'
}
if($SelfTestOnly){
 if(!(Test-Path -LiteralPath $receiptPath)){throw 'A successful native build receipt is required before SelfTestOnly.'}
 $saved=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
 if($saved.schema -ne 2 -or $saved.executable -ne $output -or $saved.source -ne $source -or $saved.runtimeDirectory -ne $RuntimeDirectory -or !(Test-Path -LiteralPath $output) -or $saved.sha256 -ne (Hash $output)){throw 'The saved native build receipt does not match this executable.'}
 foreach($key in $binding.Keys){if($saved.$key -ne $binding[$key]){throw 'The saved native build receipt no longer matches its source or dependency locks.'}}
 if($saved.selfTest.iconResourcePresent -ne $true -or !$saved.selfTest.iconResource -or
  (($saved.selfTest.iconResource.PSObject.Properties.Name|Sort-Object) -join ',') -ne (($iconBinding.Keys|Sort-Object) -join ',')){
  throw 'A verified embedded Workbench icon build receipt is required before SelfTestOnly.'
 }
 foreach($key in $iconBinding.Keys){if($saved.selfTest.iconResource.$key -ne $iconBinding[$key]){throw 'The embedded icon receipt no longer matches its current source, resources or build tools.'}}
}
if(!(Test-Path (Join-Path $runtime 'include\freerdp3\freerdp\freerdp.h'))){throw 'Prepare the locked FreeRDP runtime first.'}
if(!(Test-Path (Join-Path $compiler 'g++.exe'))){throw 'Prepare the separate locked FreeRDP compiler first.'}
$previousPath=$env:PATH
$previousConfig=$env:OPENSSL_CONF; $previousModules=$env:OPENSSL_MODULES
try {
 $env:PATH="$compiler;$previousPath"
 if(!$SelfTestOnly){
  & $windres '--input-format=rc' '--output-format=coff' '--target=pe-x86-64' '--codepage=65001' '-I' (Split-Path $iconResource -Parent) '-i' $iconResource '-o' $iconObject
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $iconObject)){throw 'The pinned resource compiler could not embed the Workbench icon.'}
  $arguments=@('-std=c++17','-municode','-O2','-Wall','-Wextra','-Wno-deprecated-declarations','-Wno-unknown-pragmas','-static-libgcc','-static-libstdc++','-I',"$runtime\include",'-I',"$runtime\include\freerdp3",'-I',"$runtime\include\winpr3",'-L',"$runtime\lib",$source,$iconObject,'-o',$output,'-lfreerdp-client3','-lfreerdp3','-lwinpr3','-l:libcjson.a','-luser32','-lgdi32','-lws2_32','-lcrypt32','-lshell32')
  & (Join-Path $compiler 'g++.exe') @arguments
  if($LASTEXITCODE -ne 0){throw 'The native Workbench renderer did not compile.'}
 }
 if(!(Test-Path $output)){throw 'Build the native Workbench renderer first.'}
 $expectedOutputHash=Hash $output
 # Runtime self-test deliberately has no access to the original MSYS2 bin tree.
 $env:PATH="$RuntimeDirectory\bin;$env:SystemRoot\System32;$env:SystemRoot"
 $env:OPENSSL_CONF=$opensslConfig; $env:OPENSSL_MODULES=$opensslModules
 # Spawn with no console or visible window. The self-test creates only its own
 # hidden parent, never connects to a VM and never sends host input.
 $psi=[Diagnostics.ProcessStartInfo]::new()
 $psi.FileName=$output; $psi.Arguments='--self-test'; $psi.UseShellExecute=$false
 $psi.CreateNoWindow=$true; $psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
 $child=[Diagnostics.Process]::Start($psi)
 if(!$child.WaitForExit(15000)){ $child.Kill(); throw 'The isolated native renderer self-test exceeded its deadline.' }
 $stdout=$child.StandardOutput.ReadToEnd(); $stderr=$child.StandardError.ReadToEnd()
 if($child.ExitCode -ne 0){throw "The isolated native renderer self-test failed (exit $($child.ExitCode)). $stderr"}
 $test=$stdout.Trim()|ConvertFrom-Json
 if(!$test.ok -or !$test.result.selfTest -or $test.result.networkStarted -or !$test.result.foregroundUnchanged){throw 'The isolated native renderer self-test receipt did not match.'}
 foreach($key in @('sourceSha256','compilerLockSha256','runtimeLockSha256','runtimeManifestSha256')){
  $file=@{sourceSha256=$source;compilerLockSha256=$compilerLock;runtimeLockSha256=$runtimeLock;runtimeManifestSha256=$runtimeManifest}[$key]
  if((Hash $file) -ne $binding[$key]){throw 'Native source or dependency locks changed during the build/self-test.'}
 }
 if(!$test.result.digestReady){throw 'The staged native runtime did not pass the public digest preflight.'}
 if($test.result.iconResourcePresent -ne $true){throw 'The native self-test could not load its embedded Workbench icon.'}
 $iconFiles=@{svgSha256=$iconSvg;pngSha256=$iconPng;icoSha256=$iconIco;rcSha256=$iconResource;
  manifestSha256=$iconManifest;buildScriptSha256=$PSCommandPath;iconBuilderSha256=$iconBuilder;windresSha256=$windres}
 foreach($key in $iconFiles.Keys){if((Hash $iconFiles[$key]) -ne $iconBinding[$key]){throw 'Workbench icon source or resource tools changed during the build/self-test.'}}
 $test.result|Add-Member -NotePropertyName iconResource -NotePropertyValue ([pscustomobject]$iconBinding) -Force
 if((Hash $output) -ne $expectedOutputHash){throw 'The native executable changed during its self-test.'}
 $receipt=[ordered]@{schema=2;source=$source;executable=$output;sha256=(Hash $output);runtimeDirectory=$RuntimeDirectory;freerdpVersion='3.32.2';compilerVersion='16.2.0';selfTest=$test.result;liveVmVerified=$false}
 foreach($key in $binding.Keys){$receipt[$key]=$binding[$key]}
 if(!$SelfTestOnly){
  $temporary=$receiptPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $receiptPath -Force
 }
 $receipt|ConvertTo-Json -Depth 8
}finally{$env:PATH=$previousPath;$env:OPENSSL_CONF=$previousConfig;$env:OPENSSL_MODULES=$previousModules}
