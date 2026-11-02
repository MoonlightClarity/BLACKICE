import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {isEntry,parseArgs,crc32Counter,decodeRow,analyzeFrame,validateAnimation,mapPoint,validateGeometry,validateEvidence,reassessSavedPresentation}=require('../verification/probe-workbench-presentation-motion.cjs');
const row={x:32,y:32,cellWidth:16,cellHeight:32,cells:32,zero:{r:96,g:160,b:216},one:{r:240,g:196,b:72}};
const animation={width:1920,height:1080,background:{r:208,g:220,b:232},counter:row,crcCounter:{...row,y:80}};
const encoded=value=>Array.from({length:32},(_,bit)=>({...((value>>>bit)&1?row.one:row.zero)}));
const frame=value=>({grid:Array.from({length:40},()=>({...animation.background})),counter:encoded(value),crcCounter:encoded(crc32Counter(value)),animation});
test('entry and arguments bind exact executable script and explicit bounded output',()=>{
  const script=fileURLToPath(new URL('../verification/probe-workbench-presentation-motion.cjs',import.meta.url));
  assert.equal(isEntry({nodeMain:false,electron:'44',argv:['electron',script],script}),true);
  assert.equal(isEntry({nodeMain:false,electron:undefined,argv:['node',script],script}),false);
  assert.equal(isEntry({nodeMain:false,electron:'44',argv:['electron','other.cjs',script],script}),false);
  const output=path.resolve('fresh.json');assert.equal(parseArgs(['--output='+output]).durationMs,5000);
  assert.equal(parseArgs(['--output='+output]).visibleFixture,false);
  assert.equal(parseArgs(['--output='+output,'--allow-visible-window']).visibleFixture,true);
  for(const args of [[],['--output=relative.json'],['--output='+output,'--duration-ms=9000'],['--output='+output,'--output='+output],['--output='+output,'--live']])assert.throws(()=>parseArgs(args));
});
test('counter and CRC parsing accepts bright source changes and rejects torn or wrong-colour markers',()=>{
  assert.equal(crc32Counter(0),0x2144df1c);
  for(const value of [0,1,63,128,0x81234567,0xffffffff]){
    assert.equal(decodeRow(encoded(value),row),value);assert.equal(analyzeFrame(frame(value)).counterValid,true);
  }
  const torn=frame(128);torn.crcCounter=encoded(crc32Counter(127));assert.equal(analyzeFrame(torn).counterValid,false);
  assert.equal(decodeRow(Array.from({length:32},()=>({r:0,g:0,b:0})),row),null);
});
test('full black and flat presentation samples fail while the intentionally uniform bright background does not',()=>{
  const good=analyzeFrame(frame(4));assert.equal(good.black,false);assert.equal(good.flat,false);
  const black={grid:Array(40).fill({r:0,g:0,b:0}),counter:Array(32).fill({r:0,g:0,b:0}),crcCounter:Array(32).fill({r:0,g:0,b:0}),animation};
  assert.equal(analyzeFrame(black).black,true);assert.equal(analyzeFrame(black).flat,true);
  const white={...black,grid:Array(40).fill({r:255,g:255,b:255}),counter:Array(32).fill({r:255,g:255,b:255}),crcCounter:Array(32).fill({r:255,g:255,b:255})};
  assert.equal(analyzeFrame(white).black,false);assert.equal(analyzeFrame(white).flat,true);
});
test('source counter rows and physical child geometry are bounded to the exact owned window',()=>{
  assert.equal(validateAnimation(animation),animation);
  assert.throws(()=>validateAnimation({...animation,counter:{...row,x:1900}}));
  const start={helperPid:42,workbenchWindowHwnd:'123'},geometry={rootAlive:true,childAlive:true,rootVisible:true,rootPid:42,childPid:42,actualParent:'123',actualRoot:'123',captureRect:{left:100,top:100,right:1120,bottom:800},childRect:{left:110,top:140,right:1110,bottom:790}};
  assert.equal(validateGeometry(geometry,start),geometry);
  assert.throws(()=>validateGeometry({...geometry,rootPid:99},start));
  assert.throws(()=>validateGeometry({...geometry,childRect:{...geometry.childRect,right:1200}},start));
  const point=mapPoint({x:960,y:540},geometry,1020,700);assert.deepEqual(point,{x:510,y:365});
});
test('temporal acceptance rejects static screenshots, insufficient duration/motion, black/flat frames, activation and input',()=>{
  const video={videoFrames:180,durationMs:5000,blackFrames:0,flatFrames:0,invalidCounterFrames:0,distinctValidCounters:140,validCounterRegressions:0};
  const final={networkStarted:false,hostInputSent:0,guestInputSent:0,helperEverForeground:false,helperForegroundChangeCount:0,foregroundUnchanged:true,framesProduced:250};
  assert.equal(validateEvidence(video,final).passed,true);
  assert.equal(validateEvidence(video,{...final,foregroundUnchanged:false,foregroundChangeCount:3}).passed,true);
  for(const change of [{videoFrames:1},{durationMs:2000},{durationMs:NaN},{distinctValidCounters:1},{blackFrames:1},{flatFrames:1},{invalidCounterFrames:1},{validCounterRegressions:1}])assert.throws(()=>validateEvidence({...video,...change},final));
  for(const change of [{networkStarted:true},{guestInputSent:1},{hostInputSent:1},{helperEverForeground:true},{helperForegroundChangeCount:1},{framesProduced:1}])assert.throws(()=>validateEvidence(video,{...final,...change}));
});
test('explicit exact-window GDI readback is counted as surface samples rather than video or monitor frames',()=>{
  const output=path.resolve('fresh.json');assert.equal(parseArgs(['--output='+output,'--capture-backend=gdi-window']).captureBackend,'gdi-window');
  assert.throws(()=>parseArgs(['--output='+output,'--capture-backend=desktop']));
  const samples={samplesRead:400,durationMs:4990,blackFrames:0,flatFrames:0,invalidCounterFrames:0,distinctValidCounters:180,validCounterRegressions:0};
  const final={networkStarted:false,hostInputSent:0,guestInputSent:0,helperEverForeground:false,helperForegroundChangeCount:0,foregroundUnchanged:true,framesProduced:250};
  const passed=validateEvidence(samples,final,'gdi-surface');assert.equal(passed.captureKind,'gdi-surface');assert.equal(passed.observedSamples,400);assert.match(passed.limitation,/not physical monitor/);
  assert.throws(()=>validateEvidence({...samples,samplesRead:20},final,'gdi-surface'));
});
test('default invocation refuses before Electron/helper/window startup without writing artifacts',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-motion-refuse-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'never-created.json'),script=fileURLToPath(new URL('../verification/probe-workbench-presentation-motion.cjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'--output='+output],{windowsHide:true,shell:false,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/--allow-visible-window is required/);assert.match(result.stderr,/No helper or window was created/);
  await assert.rejects(stat(output),{code:'ENOENT'});await assert.rejects(stat(output+'.profile'),{code:'ENOENT'});
});
test('saved-only reassessment binds immutable samples, build and artifacts while allowing unrelated foreground changes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-motion-saved-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),save=(file,value)=>writeFile(file,JSON.stringify(value));
  const repo=path.join(root,'repo'),source=path.join(repo,'scripts/workbench-freerdp-client/main.cpp'),runtime=path.join(root,'runtime');
  await mkdir(path.dirname(source),{recursive:true});await mkdir(runtime);
  const executable=path.join(root,'helper.exe'),manifest=path.join(runtime,'runtime-manifest.json');
  await writeFile(source,'source');await writeFile(executable,'helper');await writeFile(manifest,'manifest');
  const receipt={executable,runtimeDirectory:runtime,sha256:sha('helper'),sourceSha256:sha('source'),runtimeManifestSha256:sha('manifest')};
  const buildReceiptPath=path.join(root,'build.json');await save(buildReceiptPath,receipt);
  const reportPath=path.join(root,'original.json'),outputPath=path.join(root,'reassessment.json');
  await writeFile(reportPath+'.observer-source.cjs','original observer');await writeFile(reportPath+'.collector-source.ps1','original collector');
  const samples=Array.from({length:160},(_,counter)=>({atMs:counter*25,black:false,flat:false,counterValid:true,counter,darkFraction:0}));
  const raw={method:'exact-child-getdc-bitblt-gdi-surface',samplesRead:160,durationMs:3975,blackFrames:0,flatFrames:0,invalidCounterFrames:0,validCounterRegressions:0,distinctValidCounters:160,
    ownerVerified:true,occlusionChecked:true,printWindowUsed:false,forcedPaint:false,desktopCaptured:false,samples};
  await save(reportPath+'.gdi.json',raw);
  const start={helperPid:42,workbenchWindowHwnd:'123',childHwnd:'456'},geometry={rootAlive:true,childAlive:true,rootVisible:true,rootPid:42,childPid:42,actualParent:'123',actualRoot:'123',captureRect:{left:100,top:100,right:1120,bottom:800},childRect:{left:110,top:140,right:1110,bottom:790}};
  await save(reportPath+'.gdi-input.json',start);
  const artifacts=[];for(const suffix of ['before','after']){const file=reportPath+'.'+suffix+'.png';await writeFile(file,suffix);artifacts.push({file,sha256:sha(suffix)});}
  const original={passed:false,captureBackend:'gdi-window',helperExited:true,start,geometry,gdi:{...raw,artifacts},observerSourceSha256:sha('original observer'),collectorSourceSha256:sha('original collector'),
    build:{helperSha256:receipt.sha256,sourceSha256:receipt.sourceSha256,runtimeManifestSha256:receipt.runtimeManifestSha256,receiptSha256:sha(await readFile(buildReceiptPath))},
    final:{networkStarted:false,hostInputSent:0,guestInputSent:0,helperEverForeground:false,helperForegroundChangeCount:0,foregroundUnchanged:false,foregroundChangeCount:3,framesProduced:250}};
  await save(reportPath,original);const originalBytes=await readFile(reportPath);
  const result=await reassessSavedPresentation({reportPath,outputPath,buildReceiptPath,repo});
  assert.equal(result.passed,true);assert.equal(result.newObservation,false);assert.equal(result.originalReport.passed,false);assert.equal(result.foreground.globalChanges,3);assert.equal(result.foreground.helperEverForeground,false);
  assert.deepEqual(result.metrics,{samplesRead:160,durationMs:3975,blackFrames:0,flatFrames:0,invalidCounterFrames:0,validCounterRegressions:0,distinctValidCounters:160});
  assert.deepEqual(await readFile(reportPath),originalBytes);assert.match(result.limitations.join(' '),/not physical monitor/);
  await assert.rejects(reassessSavedPresentation({reportPath,outputPath,buildReceiptPath,repo}),{code:'EEXIST'});
  await writeFile(executable,'changed helper');await assert.rejects(reassessSavedPresentation({reportPath,outputPath:path.join(root,'tampered.json'),buildReceiptPath,repo}),/Current helper\/source\/runtime bytes differ/);
  await writeFile(executable,'helper');await save(reportPath+'.gdi.json',{...raw,blackFrames:1});await assert.rejects(reassessSavedPresentation({reportPath,outputPath:path.join(root,'tampered-samples.json'),buildReceiptPath,repo}),/samples differ/);
  assert.deepEqual(await readFile(reportPath),originalBytes);
});
test('actual Electron bootstrap writes an inert entry receipt without a helper, media or window',{skip:process.platform!=='win32'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-motion-entry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'entry.json'),script=fileURLToPath(new URL('../verification/probe-workbench-presentation-motion.cjs',import.meta.url));
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='ELECTRON_RUN_AS_NODE')delete env[key];
  const result=spawnSync(require('electron'),[script,'--entry-smoke','--output='+output],{windowsHide:true,shell:false,encoding:'utf8',timeout:15000,env});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  const receipt=JSON.parse(await readFile(output,'utf8'));assert.equal(receipt.entered,true);assert.equal(receipt.windowCreated,false);assert.equal(receipt.helperStarted,false);assert.equal(receipt.networkStarted,false);assert.equal(receipt.hostInputSent,0);assert.equal(receipt.guestInputSent,0);
});
