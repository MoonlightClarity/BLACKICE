import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {publicBuilderConfiguration,publicSigningConfiguration} from '../scripts/release-signing.mjs';
import {readWorkbenchNativePackage,stageWorkbenchNative,verifyInstalledWorkbenchNative,selfTestWorkbenchNative,downloadPinnedArchive} from '../scripts/package-workbench-native.mjs';
import {activateOpenSslProviders} from '../scripts/package-workbench-freerdp.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex'),serialize=o=>Buffer.from(JSON.stringify(o,null,2)+'\n');
test('actual electron-builder parent merge copies the verified native destination exactly once',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-native-config-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^blackice-native-config-/);await fs.rm(directory,{recursive:true,force:true});});
  const source=fileURLToPath(new URL('..',import.meta.url)),nativeStage=path.join(directory,'native-public-fixture');
  const config=publicBuilderConfiguration(await publicSigningConfiguration({}),{source,output:path.join(directory,'output')});
  // This is the generated public config's dynamic stage; the real inheritance
  // resolver must not merge a second, static copy into the same destination.
  config.extraResources=[{from:nativeStage,to:'workbench-native',filter:['**/*']}];
  const {getConfig}=createRequire(import.meta.url)('app-builder-lib/out/util/config/config.js');
  const merged=await getConfig(source,null,config);
  const native=merged.extraResources.filter(row=>row.to==='workbench-native'||row.to?.startsWith('workbench-native/'));
  assert.equal(native.length,1,'Two merged copies race on identical files and cannot be shipped.');
  assert.equal(native[0].from,nativeStage);assert.equal(native[0].to,'workbench-native');
});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-native-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),resources=path.join(root,'installed/resources'),output=path.join(resources,'workbench-native'),cache=path.join(root,'cache'),app=path.join(resources,'app');await fs.mkdir(source,{recursive:true});
  const archive=Buffer.from('pinned archive fixture'),archiveName='mingw-w64-ucrt-x86_64-openssl-1-any.pkg.tar.zst',pkg='mingw-w64-ucrt-x86_64-openssl';
  const cfg=Buffer.from('[provider_sect]\n[default_sect]\n'),generated=Buffer.from(activateOpenSslProviders(cfg.toString()));
  const helper=Buffer.from('exact accepted helper'),notices=Buffer.from('upstream notices');
  const lock=serialize({packageArtifacts:[{file:archiveName,sha256:sha(archive)}]});
  const manifest=serialize({schema:1,sourceLockSHA256:sha(lock),packages:[{name:pkg,archive:archiveName,sha256:sha(archive)}],files:[{path:'etc/ssl/openssl.cnf.dist',kind:'config-source',package:pkg,sourcePath:'ucrt64/etc/ssl/openssl.cnf.dist',size:cfg.length,sha256:sha(cfg)},{path:'etc/ssl/openssl.cnf',kind:'generated-config',package:pkg,size:generated.length,sha256:sha(generated)},{path:'THIRD-PARTY-NOTICES.txt',kind:'notices',size:notices.length,sha256:sha(notices)}]});
  const acceptance=serialize({schema:1,scope:'local-preview',fullAcceptance:false,helperSha256:sha(helper),runtimeManifestSha256:sha(manifest),timingBasis:'decoded-surface',detachedControls:true,checks:{sameConsolePixels:true,inputOwnership:true,noHostActivation:true,motionAndLatency:true,lifecycle:true}});
  const inputs={'workbench-freerdp-client.exe':helper,'runtime-manifest.json':manifest,'dependency-lock.json':lock,'acceptance.json':acceptance,'runtime-notices.txt':notices};
  for(const[n,b]of Object.entries(inputs))await fs.writeFile(path.join(source,n),b);
  const descriptor={schema:1,helper:'workbench-freerdp-client.exe',helperSha256:sha(helper),runtime:'runtime',runtimeManifestSha256:sha(manifest),dependencyLock:'dependency-lock.json',dependencyLockSha256:sha(lock),acceptance:'acceptance.json'};
  const outputFiles={'workbench-freerdp-client.exe':helper,'runtime/runtime-manifest.json':manifest,'dependency-lock.json':lock,'acceptance.json':acceptance,'runtime/THIRD-PARTY-NOTICES.txt':notices,'runtime/etc/ssl/openssl.cnf.dist':cfg,'runtime/etc/ssl/openssl.cnf':generated,'native-display.json':serialize(descriptor)};
  const inventory={schema:1,scope:'local-preview',fullAcceptance:false,helperSourceSha256:sha('fixture source'),descriptor,sourceFiles:Object.entries(inputs).map(([path,b])=>({path,bytes:b.length,sha256:sha(b)})).sort((a,b)=>a.path.localeCompare(b.path)),files:Object.entries(outputFiles).map(([path,b])=>({path,bytes:b.length,sha256:sha(b)})).sort((a,b)=>a.path.localeCompare(b.path)),archives:[{file:archiveName,sha256:sha(archive),url:'https://repo.msys2.org/mingw/ucrt64/'+archiveName}]};await fs.writeFile(path.join(source,'package.json'),serialize(inventory));
  let extracted=0,verified=0;const options={sourceDirectory:source,outputDirectory:output,cacheDirectory:cache,systemDirectory:path.join(root,'System32'),download:async({file,sha256})=>{assert.equal(sha256,sha(archive));await fs.writeFile(file,archive,{flag:'wx'})},extract:async({directory,members})=>{extracted++;assert.deepEqual(members,['ucrt64/etc/ssl/openssl.cnf.dist']);await fs.mkdir(path.join(directory,'ucrt64/etc/ssl'),{recursive:true});await fs.writeFile(path.join(directory,members[0]),cfg)},verifyRuntime:async({outputDirectory})=>{verified++;assert.equal(await fs.readFile(path.join(outputDirectory,'etc/ssl/openssl.cnf'),'utf8'),generated.toString());return true}};
  return {root,source,resources,output,cache,app,inventory,options,get extracted(){return extracted},get verified(){return verified}};
}
test('stages exact pinned files then verifies actual installed sibling resources',async t=>{
 const f=await fixture(t),r=await stageWorkbenchNative(f.options);assert.equal(r.verified,true);assert.equal(r.fullAcceptance,false);assert.equal(f.extracted,1);assert.equal(f.verified,1);
 await fs.mkdir(path.join(f.app,'resources/workbench-native'),{recursive:true});await fs.copyFile(path.join(f.source,'package.json'),path.join(f.app,'resources/workbench-native/package.json'));
 const installed=await verifyInstalledWorkbenchNative({appDirectory:f.app,resourcesDirectory:f.resources,systemDirectory:f.options.systemDirectory,verifyRuntime:f.options.verifyRuntime});assert.equal(installed.filesVerified,8);assert.equal(installed.scope,'local-preview');
 await fs.appendFile(path.join(f.output,'workbench-freerdp-client.exe'),'tamper');await assert.rejects(verifyInstalledWorkbenchNative({appDirectory:f.app,resourcesDirectory:f.resources,verifyRuntime:async()=>true}));
});
test('rejects altered source helper before downloading or extracting',async t=>{const f=await fixture(t);await fs.appendFile(path.join(f.source,'workbench-freerdp-client.exe'),'changed');await assert.rejects(stageWorkbenchNative(f.options));assert.equal(f.extracted,0)});
test('rejects an archive URL outside the pinned official source',async t=>{const f=await fixture(t);f.inventory.archives[0].url='https://example.invalid/changed';await fs.writeFile(path.join(f.source,'package.json'),serialize(f.inventory));await assert.rejects(readWorkbenchNativePackage(f.source))});
test('does not promote missing behavioral checks into native preview acceptance',async t=>{const f=await fixture(t),file=path.join(f.source,'acceptance.json'),a=JSON.parse(await fs.readFile(file,'utf8'));a.checks.motionAndLatency=false;const b=serialize(a);await fs.writeFile(file,b);Object.assign(f.inventory.sourceFiles.find(r=>r.path==='acceptance.json'),{sha256:sha(b),bytes:b.length});await fs.writeFile(path.join(f.source,'package.json'),serialize(f.inventory));await assert.rejects(readWorkbenchNativePackage(f.source))});
test('refuses a linked product folder before reading its accepted helper',async t=>{const f=await fixture(t),link=path.join(f.root,'linked');await fs.symlink(f.source,link,process.platform==='win32'?'junction':'dir');await assert.rejects(readWorkbenchNativePackage(link))});
test('rejects corrupt cached archive without using or repairing it',async t=>{const f=await fixture(t);await fs.mkdir(f.cache,{recursive:true});await fs.writeFile(path.join(f.cache,f.inventory.archives[0].file),'wrong');await assert.rejects(stageWorkbenchNative(f.options));assert.equal(f.extracted,0);assert.equal(await fs.readFile(path.join(f.cache,f.inventory.archives[0].file),'utf8'),'wrong')});
test('rejects source bytes changed during dependency verification and leaves no output',async t=>{const f=await fixture(t);f.options.verifyRuntime=async()=>{await fs.appendFile(path.join(f.source,'acceptance.json'),' ');return true};await assert.rejects(stageWorkbenchNative(f.options));await assert.rejects(fs.stat(f.output),{code:'ENOENT'})});
test('rejects staged helper bytes changed during dependency verification',async t=>{const f=await fixture(t);f.options.verifyRuntime=async({outputDirectory})=>{await fs.appendFile(path.join(path.dirname(outputDirectory),'workbench-freerdp-client.exe'),'changed');return true};await assert.rejects(stageWorkbenchNative(f.options));await assert.rejects(fs.stat(f.output),{code:'ENOENT'})});
test('rejects unexpected installed files even when every expected hash matches',async t=>{const f=await fixture(t);await stageWorkbenchNative(f.options);await fs.mkdir(path.join(f.app,'resources/workbench-native'),{recursive:true});await fs.copyFile(path.join(f.source,'package.json'),path.join(f.app,'resources/workbench-native/package.json'));await fs.writeFile(path.join(f.output,'unreviewed.dll'),'x');await assert.rejects(verifyInstalledWorkbenchNative({appDirectory:f.app,resourcesDirectory:f.resources,verifyRuntime:async()=>true}))});
test('refuses a preexisting native stage rather than replacing its bytes',async t=>{const f=await fixture(t);await fs.mkdir(f.output,{recursive:true});await fs.writeFile(path.join(f.output,'sentinel'),'existing');await assert.rejects(stageWorkbenchNative(f.options));assert.equal(await fs.readFile(path.join(f.output,'sentinel'),'utf8'),'existing')});
test('selftest requires the actual digest, buffered presentation, detached controls and icon flags',async t=>{const f=await fixture(t);await stageWorkbenchNative(f.options);const result={ok:true,result:{selfTest:true,networkStarted:false,foregroundUnchanged:true,digestReady:true,detachedControlsVerified:true,bufferedPresentationVerified:true,iconResourcePresent:true}};const executeFile=async(_exe,args,options)=>{assert.deepEqual(args,['--self-test']);assert.equal(options.windowsHide,true);assert.equal(options.timeout,15000);return{stdout:JSON.stringify(result)}};assert.equal((await selfTestWorkbenchNative({directory:f.output,systemDirectory:f.options.systemDirectory,executeFile})).passed,true);result.result.digestReady=false;await assert.rejects(selfTestWorkbenchNative({directory:f.output,systemDirectory:f.options.systemDirectory,executeFile}))});
test('download accepts only the pinned bytes, without a network model or executable',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-native-download-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const b=Buffer.from('expected archive'),file=path.join(root,'archive');let calls=0;await downloadPinnedArchive({url:'https://repo.msys2.org/pinned',file,sha256:sha(b),fetchImpl:async(_url,o)=>{calls++;assert.equal(o.redirect,'error');return new Response(b)}});assert.equal(calls,1);assert.deepEqual(await fs.readFile(file),b)});
