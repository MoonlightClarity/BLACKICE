import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assessPreviewEvidence,assessHiddenPreviewEvidence,assessBufferedHiddenPreviewEvidence,assessSavedTemporalReassessment,recordPreview} from '../verification/record-workbench-native-preview.mjs';

function evidence(){
  const build={sha256:'a'.repeat(64),runtimeManifestSha256:'b'.repeat(64)};
  const session={helperSha256:build.sha256,fixtureLaunch:{guestSessionId:2},fixtureInitial:{guestSessionId:2},
    fixtureFinal:{phase:'closed',complete:true,clickCount:30},close:{ok:true,result:{connected:false}},
    input:{attempts:30,verified:30,p50Ms:46,p95Ms:76,timing:'host submission to changed pixel in decoded RDP surface'},
    motion:{observedFramesPerSecond:28,durationMs:5001,metric:'checksum-valid decoded markers',counterRegressions:0,
      integrity:{valid:true,checksumRequired:true,algorithm:'crc32-ieee-uint32-le'}},status:{surface:{width:1024,height:768},
      certificateVerified:true,selectedProtocol:2,foregroundUnchanged:true,helperEverForeground:false,helperForegroundChangeCount:0},ownerReject:{code:'INPUT_REJECTED'}};
  const embedding={build:{helperSha256:build.sha256,runtimeManifestSha256:build.runtimeManifestSha256},passed:true,
    explicitClose:{exited:true},sessionClose:{exited:true},noOwnedForegroundActivation:true,inputOwner:'agent',
    anchorClose:{anchorDestroyed:true,sessionSurvived:true,frameAvailable:true,ownerUnchanged:true,sameHelperPid:true,sameWindowHwnd:true},
    guestInputSent:0,hostInputSent:0,attached:{perMonitorV2:true},embedded:{childAlive:true,parentVisible:false},
    mode:'detached-window',detachedPresentation:{passed:true,detached:true,actualTopLevelVerified:true,
      composition:{passed:true},userClose:{windowHidden:true,sessionConnected:true,frameAvailable:true,ownerUnchanged:true,
        agentFrameApiAvailable:true,windowCloseRevisionAdvanced:true},
      reopened:{windowVisible:true,sameHelperPid:true,ownerUnchanged:true,compositionPassed:true},resized:{geometryVerified:true,compositionPassed:true}},
    after:{childAlive:false,parentAlive:false}};
  return {build,session,embedding};
}
test('complete real-session and detached composition evidence authorizes only local preview',()=>{
  const {session,embedding,build}=evidence(),result=assessPreviewEvidence(session,embedding,build);
  assert.equal(result.scope,'local-preview');assert.equal(result.fullAcceptance,false);
  assert.equal(result.timingBasis,'decoded-surface');assert.equal(result.measured.verifiedClicks,30);
  assert.ok(result.remaining.includes('physical input-to-photon measurement'));
});
test('stale builds, incomplete cleanup, low motion and foreground changes cannot enable native preview',()=>{
  const mutations=[
    e=>{e.embedding.build.helperSha256='c'.repeat(64)},
    e=>{delete e.session.fixtureFinal},
    e=>{e.session.close.result.connected=true},
    e=>{e.session.input.verified=29},
    e=>{e.session.motion.observedFramesPerSecond=23},
    e=>{e.session.motion.integrity.valid=false},
    e=>{e.session.motion.counterRegressions=1},
    e=>{delete e.session.motion.integrity},
    e=>{e.embedding.sessionClose.exited=false},
    e=>{e.embedding.anchorClose.sessionSurvived=false},
    e=>{e.embedding.noOwnedForegroundActivation=false},
    e=>{e.session.status.helperEverForeground=true},
    e=>{e.session.status.helperForegroundChangeCount=1},
    e=>{e.embedding.detachedPresentation.composition.passed=false},
    e=>{e.embedding.detachedPresentation.userClose.frameAvailable=false},
    e=>{e.embedding.detachedPresentation.userClose.agentFrameApiAvailable=false},
    e=>{e.embedding.detachedPresentation.reopened.sameHelperPid=false},
    e=>{e.embedding.detachedPresentation.reopened.compositionPassed=false},
    e=>{e.embedding.detachedPresentation.resized.geometryVerified=false},
    e=>{e.embedding.mode='hidden-lifecycle'},
    e=>{e.embedding.guestInputSent=1},
    e=>{e.embedding.hostInputSent=1},
    e=>{e.session.fixtureLaunch.guestSessionId=3},
    e=>{e.session.input.timing='input-to-photon'},
  ];
  for(const mutate of mutations){const e=evidence();mutate(e);assert.throws(()=>assessPreviewEvidence(e.session,e.embedding,e.build));}
});

test('unrelated user app switches do not invalidate a probe that never activates its own window',()=>{
  const {session,embedding,build}=evidence();session.status.foregroundUnchanged=false;
  assert.equal(assessPreviewEvidence(session,embedding,build).checks.noHostActivation,true);
});

test('one explicit wake requires unchanged ownership and an accurate queued-only receipt',()=>{
  const {session,embedding,build}=evidence();embedding.guestInputSent=1;
  embedding.wakeDisplay={explicitOptIn:true,attempted:true,expectedOwner:'agent',
    ownershipBefore:{owner:'agent',revision:9},ownershipAfter:{owner:'agent',revision:9},
    nativeReceipt:{wake:{requested:true,queued:true,desktopAwakeConfirmed:false}},decodedNotDarkObserved:true};
  assert.equal(assessPreviewEvidence(session,embedding,build).checks.lifecycle,true);
  for(const mutate of [e=>{e.wakeDisplay.ownershipAfter.revision=10},e=>{e.guestInputSent=2},
    e=>{e.wakeDisplay.nativeReceipt.wake.desktopAwakeConfirmed=true},e=>{e.wakeDisplay.explicitOptIn=false}]){
    const changed=structuredClone(embedding);mutate(changed);
    assert.throws(()=>assessPreviewEvidence(session,changed,build));
  }
});

function hiddenEvidence(){
  const e=evidence();e.session.preflight={vmId:'fixture-vm'};
  e.build.selfTest={selfTest:true,networkStarted:false,foregroundUnchanged:true,bufferedPresentationVerified:true,
    iconResourcePresent:true,iconResource:{resourceId:101},detachedVerified:true,ownershipReleaseVerified:true};
  e.hidden={mode:'hidden-native-lifecycle',passed:true,build:{...e.embedding.build},preflight:{vmId:'fixture-vm'},
    hostInputSent:0,guestInputSent:0,inputOwner:'agent',noOwnedForegroundActivation:true,
    actualOwnershipGuard:{revision:8,cancelled:false},attached:{perMonitorV2:true,detached:true,connected:true,displayReady:true,windowVisible:false},
    hiddenLifecycle:{windowNeverShown:true,networkConnected:true,frameAvailable:true,agentFrameApiAvailable:true,
      ownerUnchanged:true,sameHelperPid:true,sameWindowHwnd:true},anchorClose:{...e.embedding.anchorClose},
    explicitClose:{exited:true},sessionClose:{exited:true},after:{childAlive:false,parentAlive:false}};
  e.presentation={passed:true,basis:'GDI-front-surface-temporal',visibleCompositionProven:false,build:{...e.embedding.build},
    noOwnedForegroundActivation:true,networkStarted:false,hostInputSent:0,guestInputSent:0,helperExited:true,
    temporal:{method:'exact-child-getdc-bitblt-gdi-surface',samplesRead:500,durationMs:4993.7704,distinctValidCounters:161,
      blackFrames:0,flatFrames:0,invalidCounterFrames:0,validCounterRegressions:0,ownerVerified:true,occlusionChecked:true,
      printWindowUsed:false,forcedPaint:false,desktopCaptured:false}};
  return e;
}
test('hidden lifecycle plus front-surface motion is recorded truthfully without a visible-composition claim',()=>{
  const e=hiddenEvidence();e.session.status.foregroundUnchanged=false;
  const result=assessHiddenPreviewEvidence(e.session,e.hidden,e.presentation,e.build);
  assert.equal(result.scope,'local-preview');assert.equal(result.fullAcceptance,false);
  assert.equal(result.presentationEvidence.basis,'GDI-front-surface-temporal+hidden-lifecycle');
  assert.equal(result.presentationEvidence.visibleCompositionProven,false);
  assert.equal(result.presentationEvidence.physicalInputToPhotonProven,false);
  assert.equal(result.presentationEvidence.frontSurfaceSamples,500);
  assert.equal(result.timingBasis,'decoded-surface');assert.equal(result.measured.verifiedClicks,30);
  assert.ok(result.remaining.includes('visible composition on this build'));
  assert.throws(()=>assessPreviewEvidence(e.session,e.hidden,e.build));
});
test('hidden alternative requires exact-build real guest input and moving coherent front-surface samples',()=>{
  const mutations=[
    e=>{e.session.helperSha256='c'.repeat(64)},e=>{e.session.input.verified=29},
    e=>{e.session.motion.counterRegressions=1},e=>{e.session.status.certificateVerified=false},
    e=>{e.build.selfTest.bufferedPresentationVerified=false},e=>{e.build.selfTest.iconResourcePresent=false},
    e=>{e.build.selfTest.iconResource.resourceId=102},e=>{e.build.selfTest.detachedVerified=false},
    e=>{e.presentation.build.helperSha256='c'.repeat(64)},e=>{e.presentation.build.runtimeManifestSha256='c'.repeat(64)},
    e=>{e.presentation.passed=false},e=>{e.presentation.visibleCompositionProven=true},
    e=>{e.presentation.basis='visible-composition'},e=>{e.presentation.temporal.method='print-window'},
    e=>{e.presentation.temporal.samplesRead=499},e=>{e.presentation.temporal.durationMs=4800},
    e=>{e.presentation.temporal.distinctValidCounters=20},e=>{e.presentation.temporal.blackFrames=1},
    e=>{e.presentation.temporal.flatFrames=1},e=>{e.presentation.temporal.invalidCounterFrames=1},
    e=>{e.presentation.temporal.validCounterRegressions=1},e=>{e.presentation.temporal.forcedPaint=true},
    e=>{e.presentation.temporal.printWindowUsed=true},e=>{e.presentation.temporal.desktopCaptured=true},
    e=>{e.presentation.temporal.ownerVerified=false},e=>{e.presentation.noOwnedForegroundActivation=false},
    e=>{e.presentation.networkStarted=true},e=>{e.presentation.guestInputSent=1},e=>{e.presentation.helperExited=false},
  ];
  for(const mutate of mutations){const e=hiddenEvidence();mutate(e);assert.throws(()=>assessHiddenPreviewEvidence(e.session,e.hidden,e.presentation,e.build));}
});
test('hidden lifecycle rejects shown windows, input, lost owner, another VM and incomplete cleanup',()=>{
  const mutations=[
    e=>{e.hidden.build.helperSha256='c'.repeat(64)},e=>{e.hidden.error='failed'},
    e=>{e.hidden.guestInputSent=1},e=>{e.hidden.hostInputSent=1},e=>{e.hidden.inputOwner='user'},
    e=>{e.hidden.actualOwnershipGuard.cancelled=true},e=>{delete e.hidden.actualOwnershipGuard},
    e=>{e.hidden.attached.windowVisible=true},e=>{e.hidden.attached.connected=false},
    e=>{e.hidden.hiddenLifecycle.windowNeverShown=false},e=>{e.hidden.hiddenLifecycle.agentFrameApiAvailable=false},
    e=>{e.hidden.anchorClose.sameHelperPid=false},e=>{e.hidden.sessionClose.exited=false},
    e=>{e.hidden.explicitClose.forced=true},e=>{e.hidden.sessionClose.forced=true},
    e=>{e.hidden.explicitClose.signal='SIGTERM'},e=>{e.hidden.sessionClose.signal='SIGTERM'},
    e=>{e.hidden.after.childAlive=true},e=>{e.hidden.preflight.vmId='another-vm'},
    e=>{e.hidden.noOwnedForegroundActivation=false},
  ];
  for(const mutate of mutations){const e=hiddenEvidence();mutate(e);assert.throws(()=>assessHiddenPreviewEvidence(e.session,e.hidden,e.presentation,e.build));}
});
test('saved temporal reassessment recomputes individual samples and never excuses owned activation or bad source data',()=>{
  const e=hiddenEvidence(),build={...e.presentation.build,sourceSha256:'c'.repeat(64),receiptSha256:'d'.repeat(64)};
  const samples=Array.from({length:500},(_,index)=>({atMs:index*10,black:false,flat:false,counterValid:true,counter:Math.floor(index/3)}));
  const collector={...e.presentation.temporal,samples,durationMs:4990,distinctValidCounters:167};
  const metrics=Object.fromEntries(['samplesRead','durationMs','blackFrames','flatFrames','invalidCounterFrames','validCounterRegressions','distinctValidCounters'].map(key=>[key,collector[key]]));
  const original={probe:'owned-native-presentation-motion',passed:false,failure:{stage:'temporal-acceptance'},build:{...build},
    networkStarted:false,hostInputSent:0,guestInputSent:0,helperExited:true,gdi:{...collector},
    final:{networkStarted:false,hostInputSent:0,guestInputSent:0,helperEverForeground:false,helperForegroundChangeCount:0,
      foregroundChangeCount:3,foregroundUnchanged:false}};
  const reassessment={kind:'saved-temporal-reassessment',passed:true,newObservation:false,originalReport:{passed:false},build,metrics,
    foreground:{helperEverForeground:false,helperForegroundChanges:0,globalChanges:3,globalUnchanged:false}};
  const normalized=assessSavedTemporalReassessment(reassessment,original,collector);
  assert.equal(normalized.basis,'GDI-front-surface-temporal');assert.equal(normalized.visibleCompositionProven,false);
  assert.equal(normalized.originalPassed,false);assert.equal(normalized.temporal.distinctValidCounters,167);
  for(const mutate of [v=>{v.collector.samples[250].counter=1},v=>{v.collector.samples.pop()},
    v=>{v.reassessment.metrics.distinctValidCounters=999},v=>{v.original.final.helperEverForeground=true},
    v=>{v.original.hostInputSent=1},v=>{v.reassessment.build.helperSha256='e'.repeat(64)},
    v=>{v.reassessment.newObservation=true},v=>{v.original.failure.stage='connection'}]){
    const changed=structuredClone({reassessment,original,collector});mutate(changed);
    assert.throws(()=>assessSavedTemporalReassessment(changed.reassessment,changed.original,changed.collector));
  }
});

function bufferedEvidence(){
  const e=hiddenEvidence();e.build.sourceSha256='c'.repeat(64);e.receiptSha256='d'.repeat(64);
  Object.assign(e.build.selfTest,{diagnosticCallbacksVerified:true,vmConnectProtocolVerified:true,classicGraphicsVerified:true,
    sampleVerified:true,presentationVerified:true,fixtureClipVerified:true,fixtureGdiVerified:true,fixtureRestoreVerified:true,
    wakeVerified:true,frameHealthVerified:true,detachedControlsVerified:true,clipboardVerified:true});
  Object.assign(e.session,{sourceSha256:e.build.sourceSha256,runtimeManifestSha256:e.build.runtimeManifestSha256,buildReceiptSha256:e.receiptSha256});
  Object.assign(e.hidden,{windowShowRequested:false,hostPixelsCaptured:false,presentationCompositionProven:false});
  Object.assign(e.hidden.build,{sourceSha256:e.build.sourceSha256,receiptSha256:e.receiptSha256});
  Object.assign(e.hidden.attached,{controls:{available:false},helperPid:42,workbenchWindowHwnd:'101',childHwnd:'102'});
  e.hidden.nativeControls={available:true};e.hidden.nativeControlsIdentity={sameNativeInstanceVerified:true,helperPid:42,workbenchWindowHwnd:'101',childHwnd:'102'};
  e.hidden.window={rootPid:42,childPid:42,root:'101',child:'102'};return e;
}
test('explicit buffered self-test alternative records hidden lifecycle and controls without borrowing temporal evidence',()=>{
  const e=bufferedEvidence(),result=assessBufferedHiddenPreviewEvidence(e.session,e.hidden,e.build,{buildReceiptSha256:e.receiptSha256});
  assert.equal(result.detachedControls,true);assert.equal(result.scope,'local-preview');assert.equal(result.fullAcceptance,false);
  assert.equal(result.presentationEvidence.basis,'buffered-self-test+hidden-lifecycle');
  assert.equal(result.presentationEvidence.visibleCompositionProven,false);assert.equal(result.presentationEvidence.physicalInputToPhotonProven,false);
  assert.equal(result.presentationEvidence.temporalPresentationMeasured,false);assert.equal(Object.hasOwn(result.presentationEvidence,'frontSurfaceSamples'),false);
  assert.equal(Object.hasOwn(result.presentationEvidence,'frontSurfaceDurationMs'),false);assert.equal(result.timingBasis,'decoded-surface');
  assert.ok(result.remaining.includes('temporal front-surface presentation on this build'));
});
test('buffered hidden acceptance requires every deterministic self-test and exact live build/toolbar binding',()=>{
  const flags=['diagnosticCallbacksVerified','vmConnectProtocolVerified','classicGraphicsVerified','sampleVerified','ownershipReleaseVerified',
    'presentationVerified','fixtureClipVerified','fixtureGdiVerified','fixtureRestoreVerified','wakeVerified','frameHealthVerified',
    'detachedVerified','detachedControlsVerified','clipboardVerified','bufferedPresentationVerified','iconResourcePresent'];
  for(const flag of flags){const e=bufferedEvidence();e.build.selfTest[flag]=false;
    assert.throws(()=>assessBufferedHiddenPreviewEvidence(e.session,e.hidden,e.build,{buildReceiptSha256:e.receiptSha256}),flag);}
  for(const mutate of [
    e=>{e.hidden.nativeControls.available=false},e=>{delete e.hidden.nativeControls},
    e=>{e.hidden.nativeControlsIdentity.helperPid=43},e=>{e.hidden.nativeControlsIdentity.workbenchWindowHwnd='999'},
    e=>{e.hidden.nativeControlsIdentity.sameNativeInstanceVerified=false},e=>{e.hidden.window.childPid=43},
    e=>{e.session.helperSha256='e'.repeat(64)},e=>{e.session.sourceSha256='e'.repeat(64)},
    e=>{e.session.runtimeManifestSha256='e'.repeat(64)},e=>{e.session.buildReceiptSha256='e'.repeat(64)},
    e=>{e.hidden.build.helperSha256='e'.repeat(64)},e=>{e.hidden.build.sourceSha256='e'.repeat(64)},
    e=>{e.hidden.build.runtimeManifestSha256='e'.repeat(64)},e=>{e.hidden.build.receiptSha256='e'.repeat(64)},
    e=>{e.receiptSha256=undefined},e=>{e.hidden.windowShowRequested=true},e=>{e.hidden.hostPixelsCaptured=true},
    e=>{e.hidden.presentationCompositionProven=true},e=>{e.hidden.hiddenLifecycle.windowNeverShown=false},
    e=>{e.hidden.inputOwner='user'},e=>{e.hidden.actualOwnershipGuard.cancelled=true},e=>{e.hidden.guestInputSent=1},
    e=>{e.hidden.noOwnedForegroundActivation=false},e=>{e.session.input.verified=29},e=>{e.session.motion.counterRegressions=1},
    e=>{e.session.close.result.connected=true},e=>{e.hidden.preflight.vmId='another-vm'},e=>{e.build.selfTest.networkStarted=true}
  ]){const e=bufferedEvidence();mutate(e);assert.throws(()=>assessBufferedHiddenPreviewEvidence(e.session,e.hidden,e.build,{buildReceiptSha256:e.receiptSha256}));}
});
test('recorder binds buffered-mode files and refuses stale reports, mixed temporal modes and changed build bytes',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-buffered-recorder-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const appRoot=path.join(directory,'app'),runtime=path.join(appRoot,'.build/runtime'),sourceFile=path.join(appRoot,'scripts/workbench-freerdp-client/main.cpp');
  await mkdir(runtime,{recursive:true});await mkdir(path.dirname(sourceFile),{recursive:true});
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),executable=path.join(appRoot,'.build/helper.exe'),manifest=path.join(runtime,'runtime-manifest.json');
  await writeFile(executable,'native-bytes');await writeFile(sourceFile,'source-bytes');await writeFile(manifest,'runtime-bytes');
  const e=bufferedEvidence(),build={...e.build,schema:2,executable,runtimeDirectory:runtime,sha256:hash('native-bytes'),sourceSha256:hash('source-bytes'),runtimeManifestSha256:hash('runtime-bytes')};
  const buildBytes=JSON.stringify(build),receiptSha256=hash(buildBytes);await writeFile(path.join(appRoot,'.build/workbench-freerdp-client-build.json'),buildBytes);
  Object.assign(e.session,{helperSha256:build.sha256,sourceSha256:build.sourceSha256,runtimeManifestSha256:build.runtimeManifestSha256,buildReceiptSha256:receiptSha256});
  Object.assign(e.hidden.build,{helperSha256:build.sha256,sourceSha256:build.sourceSha256,runtimeManifestSha256:build.runtimeManifestSha256,receiptSha256});
  const sessionReport=path.join(directory,'session.json'),hiddenLifecycleReport=path.join(directory,'hidden.json'),output=path.join(directory,'acceptance.json');
  await writeFile(sessionReport,JSON.stringify(e.session));await writeFile(hiddenLifecycleReport,JSON.stringify(e.hidden));
  const args={appRoot,sessionReport,hiddenLifecycleReport,bufferedSelfTest:true,output};
  const result=await recordPreview(args);assert.equal(result.detachedControls,true);assert.equal(result.presentationEvidence.basis,'buffered-self-test+hidden-lifecycle');
  assert.equal(result.evidence.bufferedSelfTest.sha256,receiptSha256);assert.equal(result.evidence.session.sha256,hash(await readFile(sessionReport)));
  assert.equal(Object.hasOwn(result.evidence,'presentationMotion'),false);assert.equal(JSON.parse(await readFile(output,'utf8')).presentationEvidence.temporalPresentationMeasured,false);
  for(const change of [{hiddenLifecycleReport:undefined},{presentationMotionReport:path.join(directory,'old-temporal.json')},{embeddingReport:path.join(directory,'old-visible.json')}])
    await assert.rejects(recordPreview({...args,...change}),/Choose embedding evidence/);
  const rejected=path.join(directory,'rejected.json');
  e.hidden.nativeControls.available=false;await writeFile(hiddenLifecycleReport,JSON.stringify(e.hidden));await assert.rejects(recordPreview({...args,output:rejected}),/toolbar availability/);
  await assert.rejects(stat(rejected),{code:'ENOENT'});e.hidden.nativeControls.available=true;await writeFile(hiddenLifecycleReport,JSON.stringify(e.hidden));
  e.session.helperSha256='a'.repeat(64);await writeFile(sessionReport,JSON.stringify(e.session));await assert.rejects(recordPreview({...args,output:rejected}),/another native build/);
  await writeFile(executable,'changed-native-bytes');await assert.rejects(recordPreview({...args,output:rejected}),/Build bytes changed/);
});
