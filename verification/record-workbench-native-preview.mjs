// Create local preview evidence from real-session probes and explicitly named
// presentation evidence. This never connects, changes VM settings or starts a model.
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireEvidence=(condition,message)=>{if(!condition)throw Error(message)};
function verifyProbeInput(report){
  requireEvidence(report.hostInputSent===0,'The display probe must not send host input.');
  if(report.guestInputSent===0)return;
  const wake=report.wakeDisplay;
  requireEvidence(report.guestInputSent===1&&wake?.explicitOptIn===true&&wake.attempted===true&&
    wake.expectedOwner==='agent'&&wake.ownershipBefore?.owner==='agent'&&wake.ownershipAfter?.owner==='agent'&&
    Number.isSafeInteger(wake.ownershipBefore.revision)&&wake.ownershipBefore.revision===wake.ownershipAfter.revision&&
    wake.nativeReceipt?.wake?.requested===true&&wake.nativeReceipt.wake.queued===true&&
    wake.nativeReceipt.wake.desktopAwakeConfirmed===false&&wake.decodedNotDarkObserved===true,
    'Display evidence permits only an explicitly recorded single wake under unchanged agent ownership.');
}
function verifySessionEvidence(session,build){
  requireEvidence(session&&build&&session.helperSha256===build.sha256,'The guest session refers to another native build.');
  requireEvidence(!session.error&&!session.cleanupError&&session.close?.ok===true&&session.close.result?.connected===false,
    'The guest session probe did not close cleanly.');
  requireEvidence(session.fixtureFinal?.phase==='closed'&&session.fixtureFinal.complete===true&&
    session.fixtureFinal.clickCount===30&&session.fixtureLaunch?.guestSessionId===session.fixtureInitial?.guestSessionId,
    'The interactive guest fixture lacks a matching session and final cleanup receipt.');
  requireEvidence(session.input?.attempts===30&&session.input.verified===30&&
    Number.isFinite(session.input.p50Ms)&&session.input.p50Ms>=0&&session.input.p50Ms<100&&
    Number.isFinite(session.input.p95Ms)&&session.input.p95Ms>=session.input.p50Ms&&
    session.input.timing==='host submission to changed pixel in decoded RDP surface',
    'Thirty verified decoded-surface responses and their measured latency are required.');
  requireEvidence(Number.isFinite(session.motion?.observedFramesPerSecond)&&session.motion.observedFramesPerSecond>=24&&
    session.motion.durationMs>=5000&&session.status?.surface?.width===1024&&session.status.surface.height===768,
    'The local preview requires at least 24 observed guest frames/s at 1024x768 over five seconds.');
  requireEvidence(session.motion.metric==='checksum-valid decoded markers'&&
    session.motion.integrity?.valid===true&&session.motion.integrity.checksumRequired===true&&
    session.motion.integrity.algorithm==='crc32-ieee-uint32-le'&&session.motion.counterRegressions===0,
    'Motion evidence requires checksum-valid markers without a verified regression.');
  requireEvidence(session.status?.certificateVerified===true&&session.status.selectedProtocol===2&&
    session.status.helperEverForeground===false&&session.status.helperForegroundChangeCount===0&&
    session.ownerReject?.code==='INPUT_REJECTED','Native authentication, ownership rejection or foreground evidence is missing.');
}
export function assessPreviewEvidence(session,embedding,build){
  requireEvidence(session&&embedding&&build,'Both live verification reports and a build receipt are required.');
  requireEvidence(session.helperSha256===build.sha256&&embedding.build?.helperSha256===build.sha256&&
    embedding.build?.runtimeManifestSha256===build.runtimeManifestSha256,'Live reports refer to another native build.');
  requireEvidence(!session.error&&!session.cleanupError&&session.close?.ok===true&&session.close.result?.connected===false,
    'The guest session probe did not close cleanly.');
  requireEvidence(session.fixtureFinal?.phase==='closed'&&session.fixtureFinal.complete===true&&
    session.fixtureFinal.clickCount===30&&session.fixtureLaunch?.guestSessionId===session.fixtureInitial?.guestSessionId,
    'The interactive guest fixture lacks a matching session and final cleanup receipt.');
  requireEvidence(session.input?.attempts===30&&session.input.verified===30&&
    Number.isFinite(session.input.p50Ms)&&session.input.p50Ms>=0&&session.input.p50Ms<100&&
    Number.isFinite(session.input.p95Ms)&&session.input.p95Ms>=session.input.p50Ms&&
    session.input.timing==='host submission to changed pixel in decoded RDP surface',
    'Thirty verified decoded-surface responses and their measured latency are required.');
  requireEvidence(Number.isFinite(session.motion?.observedFramesPerSecond)&&session.motion.observedFramesPerSecond>=24&&
    session.motion.durationMs>=5000&&session.status?.surface?.width===1024&&session.status.surface.height===768,
    'The local preview requires at least 24 observed guest frames/s at 1024x768 over five seconds.');
  requireEvidence(session.motion.metric==='checksum-valid decoded markers'&&
    session.motion.integrity?.valid===true&&session.motion.integrity.checksumRequired===true&&
    session.motion.integrity.algorithm==='crc32-ieee-uint32-le'&&session.motion.counterRegressions===0,
    'Motion evidence requires checksum-valid markers without a verified regression.');
  requireEvidence(session.status?.certificateVerified===true&&session.status.selectedProtocol===2&&
    session.status.helperEverForeground===false&&session.status.helperForegroundChangeCount===0&&
    session.ownerReject?.code==='INPUT_REJECTED','Native authentication, ownership rejection or foreground evidence is missing.');
  requireEvidence(embedding.passed===true&&!embedding.error&&!embedding.cleanupError&&
    embedding.explicitClose?.exited===true&&embedding.sessionClose?.exited===true&&
    embedding.anchorClose?.anchorDestroyed===true&&embedding.anchorClose.sessionSurvived===true&&
    embedding.anchorClose.frameAvailable===true&&embedding.anchorClose.ownerUnchanged===true&&
    embedding.anchorClose.sameHelperPid===true&&embedding.anchorClose.sameWindowHwnd===true&&
    embedding.noOwnedForegroundActivation===true&&embedding.inputOwner==='agent'&&
    embedding.attached?.perMonitorV2===true&&embedding.after?.childAlive===false&&
    embedding.after?.parentAlive===false,'The native display/lifecycle probe has not passed.');
  verifyProbeInput(embedding);
  const presentation=embedding.detachedPresentation;
  requireEvidence(embedding.mode==='detached-window'&&presentation?.passed===true&&presentation.detached===true&&
    presentation.actualTopLevelVerified===true&&presentation.composition?.passed===true&&
    presentation.userClose?.windowHidden===true&&presentation.userClose.sessionConnected===true&&
    presentation.userClose.frameAvailable===true&&presentation.userClose.agentFrameApiAvailable===true&&
    presentation.userClose.ownerUnchanged===true&&presentation.userClose.windowCloseRevisionAdvanced===true&&
    presentation.reopened?.windowVisible===true&&presentation.reopened.sameHelperPid===true&&
    presentation.reopened.ownerUnchanged===true&&presentation.reopened.compositionPassed===true&&
    presentation.resized?.geometryVerified===true&&presentation.resized.compositionPassed===true,
    'The detached application must show composed guest pixels, resize, and reopen without losing its session or capture.');
  return {schema:1,scope:'local-preview',helperSha256:build.sha256,runtimeManifestSha256:build.runtimeManifestSha256,
    presentation:'detached-native-window',
    timingBasis:'decoded-surface',checks:{sameConsolePixels:true,inputOwnership:true,noHostActivation:true,motionAndLatency:true,lifecycle:true},
    measured:{width:1024,height:768,framesPerSecond:session.motion.observedFramesPerSecond,
      metric:session.motion.metric,wholeDesktopAtomicityProven:false,guestPaintFramesPerSecond:session.motion.guestPaintFramesPerSecond,
      verifiedClicks:30,p50Ms:session.input.p50Ms,p95Ms:session.input.p95Ms},
    vmId:session.preflight?.vmId,guestSessionId:session.fixtureInitial.guestSessionId,
    fullAcceptance:false,remaining:['1920x1080 performance','physical input-to-photon measurement','clipboard','dynamic guest resolution','clean-host distribution']};
}
/** Hidden lifecycle plus a separately bound front-surface temporal report.
 * This path deliberately makes no visible-composition or photon claim. */
function verifyHiddenLifecycleEvidence(session,hidden,build){
  verifySessionEvidence(session,build);
  const selfTest=build.selfTest;
  requireEvidence(selfTest?.selfTest===true&&selfTest.networkStarted===false&&selfTest.foregroundUnchanged===true&&
    selfTest.bufferedPresentationVerified===true&&selfTest.iconResourcePresent===true&&
    selfTest.iconResource?.resourceId===101&&selfTest.detachedVerified===true&&selfTest.ownershipReleaseVerified===true,
    'The exact build must pass buffered presentation, icon and lifecycle self-tests.');
  requireEvidence(hidden?.mode==='hidden-native-lifecycle'&&hidden.passed===true&&!hidden.error&&!hidden.cleanupError&&
    hidden.build?.helperSha256===build.sha256&&hidden.build.runtimeManifestSha256===build.runtimeManifestSha256&&
    hidden.hostInputSent===0&&hidden.guestInputSent===0&&hidden.noOwnedForegroundActivation===true&&hidden.inputOwner==='agent'&&
    hidden.actualOwnershipGuard?.cancelled===false&&Number.isSafeInteger(hidden.actualOwnershipGuard.revision)&&
    hidden.actualOwnershipGuard.revision>=0,
    'The hidden lifecycle must use this build, preserve agent ownership and send no input.');
  requireEvidence(hidden.attached?.perMonitorV2===true&&hidden.attached.detached===true&&hidden.attached.connected===true&&
    hidden.attached.displayReady===true&&hidden.attached.windowVisible===false&&
    ['windowNeverShown','networkConnected','frameAvailable','agentFrameApiAvailable','ownerUnchanged','sameHelperPid','sameWindowHwnd']
      .every(key=>hidden.hiddenLifecycle?.[key]===true),
    'The actual RDP lifecycle must retain a hidden native window and a readable guest surface.');
  requireEvidence(hidden.anchorClose?.anchorDestroyed===true&&hidden.anchorClose.sessionSurvived===true&&
    hidden.anchorClose.frameAvailable===true&&hidden.anchorClose.ownerUnchanged===true&&hidden.anchorClose.sameHelperPid===true&&
    hidden.anchorClose.sameWindowHwnd===true&&hidden.explicitClose?.exited===true&&hidden.sessionClose?.exited===true&&
    hidden.after?.childAlive===false&&hidden.after.parentAlive===false,
    'The hidden session must survive anchor closure and exit cleanly on explicit close.');
  requireEvidence(typeof session.preflight?.vmId==='string'&&session.preflight.vmId.length>0&&hidden.preflight?.vmId===session.preflight.vmId,
    'Hidden lifecycle and guest input evidence must refer to the same VM.');
}
export function assessHiddenPreviewEvidence(session,hidden,presentation,build){
  verifyHiddenLifecycleEvidence(session,hidden,build);
  requireEvidence(presentation?.passed===true&&presentation.build?.helperSha256===build.sha256&&
    presentation.build.runtimeManifestSha256===build.runtimeManifestSha256,
    'The front-surface temporal report refers to another build or has not passed.');
  const temporal=presentation.temporal;
  requireEvidence(presentation.basis==='GDI-front-surface-temporal'&&presentation.visibleCompositionProven===false&&
    presentation.noOwnedForegroundActivation===true&&presentation.networkStarted===false&&
    presentation.hostInputSent===0&&presentation.guestInputSent===0&&presentation.helperExited===true&&
    temporal?.method==='exact-child-getdc-bitblt-gdi-surface'&&temporal.ownerVerified===true&&temporal.occlusionChecked===true&&
    temporal.printWindowUsed===false&&temporal.forcedPaint===false&&temporal.desktopCaptured===false&&
    Number.isSafeInteger(temporal.samplesRead)&&temporal.samplesRead>=500&&
    Number.isFinite(temporal.durationMs)&&temporal.durationMs>=4900&&temporal.durationMs<=10000&&
    temporal.blackFrames===0&&temporal.flatFrames===0&&temporal.invalidCounterFrames===0&&temporal.validCounterRegressions===0&&
    Number.isSafeInteger(temporal.distinctValidCounters)&&temporal.distinctValidCounters>1&&
    (temporal.distinctValidCounters-1)*1000/temporal.durationMs>=24,
    'Front-surface evidence requires bounded moving checksum-valid markers without black, flat, invalid or regressing samples.');
  return {schema:1,scope:'local-preview',helperSha256:build.sha256,runtimeManifestSha256:build.runtimeManifestSha256,
    presentation:'detached-native-window',presentationEvidence:{basis:'GDI-front-surface-temporal+hidden-lifecycle',
      visibleCompositionProven:false,physicalInputToPhotonProven:false,hiddenLifecycleVerified:true,
      frontSurfaceSamples:temporal.samplesRead,frontSurfaceDurationMs:temporal.durationMs},
    timingBasis:'decoded-surface',checks:{sameConsolePixels:true,inputOwnership:true,noHostActivation:true,motionAndLatency:true,lifecycle:true},
    measured:{width:1024,height:768,framesPerSecond:session.motion.observedFramesPerSecond,metric:session.motion.metric,
      wholeDesktopAtomicityProven:false,guestPaintFramesPerSecond:session.motion.guestPaintFramesPerSecond,
      verifiedClicks:30,p50Ms:session.input.p50Ms,p95Ms:session.input.p95Ms},vmId:session.preflight.vmId,
    guestSessionId:session.fixtureInitial.guestSessionId,fullAcceptance:false,
    remaining:['visible composition on this build','1920x1080 performance','physical input-to-photon measurement','clipboard','dynamic guest resolution','clean-host distribution']};
}

/** Explicitly weaker presentation evidence: deterministic buffered-GDI tests
 * plus an actual hidden RDP lifecycle. This is not a temporal capture. */
export function assessBufferedHiddenPreviewEvidence(session,hidden,build,{buildReceiptSha256}={}){
  verifyHiddenLifecycleEvidence(session,hidden,build);
  const flags=['diagnosticCallbacksVerified','vmConnectProtocolVerified','classicGraphicsVerified','sampleVerified',
    'ownershipReleaseVerified','presentationVerified','fixtureClipVerified','fixtureGdiVerified','fixtureRestoreVerified',
    'wakeVerified','frameHealthVerified','detachedVerified','detachedControlsVerified','clipboardVerified','bufferedPresentationVerified'];
  requireEvidence(flags.every(flag=>build.selfTest?.[flag]===true),
    'The current native build must pass every required deterministic self-test, including detached controls.');
  requireEvidence(/^[a-f0-9]{64}$/.test(buildReceiptSha256??'')&&/^[a-f0-9]{64}$/.test(build.sourceSha256??'')&&
    session.sourceSha256===build.sourceSha256&&session.runtimeManifestSha256===build.runtimeManifestSha256&&
    session.buildReceiptSha256===buildReceiptSha256&&hidden.build.sourceSha256===build.sourceSha256&&
    hidden.build.receiptSha256===buildReceiptSha256,
    'Both current live reports must bind the exact source, runtime and build-receipt bytes.');
  requireEvidence(hidden.windowShowRequested===false&&hidden.hostPixelsCaptured===false&&hidden.presentationCompositionProven===false&&
    hidden.nativeControls?.available===true&&hidden.nativeControlsIdentity?.sameNativeInstanceVerified===true&&
    Number.isSafeInteger(hidden.nativeControlsIdentity.helperPid)&&hidden.nativeControlsIdentity.helperPid>0&&
    hidden.nativeControlsIdentity.helperPid===hidden.attached.helperPid&&
    hidden.nativeControlsIdentity.workbenchWindowHwnd===hidden.attached.workbenchWindowHwnd&&
    hidden.nativeControlsIdentity.childHwnd===hidden.attached.childHwnd&&
    hidden.window?.rootPid===hidden.nativeControlsIdentity.helperPid&&hidden.window.childPid===hidden.nativeControlsIdentity.helperPid&&
    hidden.window.root===hidden.nativeControlsIdentity.workbenchWindowHwnd&&hidden.window.child===hidden.nativeControlsIdentity.childHwnd,
    'The current hidden native lifecycle must prove toolbar availability without showing or capturing a host window.');
  return {schema:1,scope:'local-preview',helperSha256:build.sha256,sourceSha256:build.sourceSha256,
    runtimeManifestSha256:build.runtimeManifestSha256,detachedControls:true,presentation:'detached-native-window',
    presentationEvidence:{basis:'buffered-self-test+hidden-lifecycle',visibleCompositionProven:false,
      physicalInputToPhotonProven:false,hiddenLifecycleVerified:true,bufferedPresentationSelfTestVerified:true,
      detachedControlsSelfTestVerified:true,detachedControlsAvailableInHiddenSession:true,temporalPresentationMeasured:false,
      selfTestFlags:flags},timingBasis:'decoded-surface',
    checks:{sameConsolePixels:true,inputOwnership:true,noHostActivation:true,motionAndLatency:true,lifecycle:true},
    measured:{width:1024,height:768,framesPerSecond:session.motion.observedFramesPerSecond,metric:session.motion.metric,
      wholeDesktopAtomicityProven:false,guestPaintFramesPerSecond:session.motion.guestPaintFramesPerSecond,
      verifiedClicks:30,p50Ms:session.input.p50Ms,p95Ms:session.input.p95Ms},
    vmId:session.preflight.vmId,guestSessionId:session.fixtureInitial.guestSessionId,fullAcceptance:false,
    remaining:['visible composition on this build','temporal front-surface presentation on this build','1920x1080 performance',
      'physical input-to-photon measurement','automatic clipboard sharing on this build','automatic guest resolution on this build','clean-host distribution']};
}
export function assessSavedTemporalReassessment(reassessment,original,collector){
  requireEvidence(reassessment?.kind==='saved-temporal-reassessment'&&reassessment.passed===true&&reassessment.newObservation===false&&
    reassessment.originalReport?.passed===false&&original?.passed===false&&
    original.failure?.stage==='temporal-acceptance'&&original.probe==='owned-native-presentation-motion',
    'A saved temporal reassessment must preserve the original failed observation.');
  requireEvidence(['helperSha256','sourceSha256','runtimeManifestSha256','receiptSha256'].every(key=>
    /^[a-f0-9]{64}$/.test(reassessment.build?.[key]??'')&&original.build?.[key]===reassessment.build[key]),
    'The temporal reassessment and original report must bind the same build.');
  requireEvidence(Array.isArray(collector?.samples)&&collector.samples.length===collector.samplesRead&&collector.samples.length>=500,
    'The temporal collector samples are incomplete.');
  let previousTime=-1,previousCounter=null,regressions=0,black=0,flat=0,invalid=0;const distinct=new Set();
  for(const sample of collector.samples){
    requireEvidence(Number.isFinite(sample.atMs)&&sample.atMs>=previousTime&&typeof sample.black==='boolean'&&typeof sample.flat==='boolean'&&
      typeof sample.counterValid==='boolean','A temporal collector sample is malformed.');previousTime=sample.atMs;
    if(sample.black)black++;if(sample.flat)flat++;
    if(!sample.counterValid){invalid++;continue;}
    requireEvidence(Number.isInteger(sample.counter)&&sample.counter>=0&&sample.counter<=0xffffffff,'A temporal marker is invalid.');
    if(previousCounter!==null&&sample.counter<previousCounter)regressions++;previousCounter=sample.counter;distinct.add(sample.counter);
  }
  const actual={samplesRead:collector.samples.length,durationMs:collector.samples.at(-1).atMs-collector.samples[0].atMs,
    blackFrames:black,flatFrames:flat,invalidCounterFrames:invalid,validCounterRegressions:regressions,distinctValidCounters:distinct.size};
  for(const [key,value] of Object.entries(actual))requireEvidence(Number.isFinite(reassessment.metrics?.[key])&&
    Math.abs(value-reassessment.metrics[key])<0.001&&Math.abs(value-collector[key])<0.001&&Math.abs(value-original.gdi?.[key])<0.001,
    'The saved temporal metrics do not match their individual samples.');
  const final=original.final,foreground=reassessment.foreground;
  requireEvidence(original.helperExited===true&&original.networkStarted===false&&original.hostInputSent===0&&original.guestInputSent===0&&
    final?.networkStarted===false&&final.hostInputSent===0&&final.guestInputSent===0&&final.helperEverForeground===false&&
    final.helperForegroundChangeCount===0&&foreground?.helperEverForeground===false&&foreground.helperForegroundChanges===0&&
    foreground.globalChanges===final.foregroundChangeCount&&foreground.globalUnchanged===final.foregroundUnchanged,
    'The reassessment cannot excuse helper activation, input, network activity or incomplete cleanup.');
  return {passed:true,basis:'GDI-front-surface-temporal',visibleCompositionProven:false,build:reassessment.build,
    noOwnedForegroundActivation:true,networkStarted:false,hostInputSent:0,guestInputSent:0,helperExited:true,
    temporal:{...collector,...actual},reassessedSavedObservation:true,originalPassed:false};
}
async function savedPresentation(report,build,buildReceiptSha256){
  requireEvidence(report.kind==='saved-temporal-reassessment','Supply the immutable saved front-surface temporal reassessment.');
  const readBound=async(reference,parse=false)=>{
    requireEvidence(typeof reference?.file==='string'&&path.isAbsolute(reference.file)&&/^[a-f0-9]{64}$/.test(reference.sha256??''),
      'A saved presentation source is not bound to an exact file.');
    const info=await stat(reference.file);requireEvidence(info.isFile()&&info.size<=4*1024*1024,'A saved presentation source exceeds its bound.');
    const bytes=await readFile(reference.file);requireEvidence(bytes.length<=4*1024*1024&&sha(bytes)===reference.sha256,'A saved presentation source changed.');
    return parse?JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')):bytes;
  };
  const [original,collector]=await Promise.all([readBound(report.originalReport,true),readBound(report.collectorData,true),
    readBound(report.originalObserverSource),readBound(report.originalCollectorSource)]);
  requireEvidence(report.build?.sourceSha256===build.sourceSha256&&report.build.receiptSha256===buildReceiptSha256,
    'The saved presentation used a different source or build receipt.');
  requireEvidence(original.observerSourceSha256===report.originalObserverSource.sha256&&
    original.collectorSourceSha256===report.originalCollectorSource.sha256,'The saved observer sources differ from the original report.');
  const normalized=assessSavedTemporalReassessment(report,original,collector);
  normalized.boundSources=Object.fromEntries(['originalReport','collectorData','originalObserverSource','originalCollectorSource'].map(key=>
    [key,{file:path.basename(report[key].file),sha256:report[key].sha256}]));
  return normalized;
}
async function json(file){
  const info=await stat(file);if(!info.isFile()||info.size>4*1024*1024)throw Error('Verification report exceeds its size limit.');
  return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
}
export async function recordPreview({appRoot,sessionReport,embeddingReport,hiddenLifecycleReport,presentationMotionReport,bufferedSelfTest=false,output}){
  const hidden=hiddenLifecycleReport!==undefined||presentationMotionReport!==undefined||bufferedSelfTest;
  requireEvidence(typeof bufferedSelfTest==='boolean'&&(bufferedSelfTest?
    Boolean(hiddenLifecycleReport&&!presentationMotionReport&&!embeddingReport):
    hidden?Boolean(hiddenLifecycleReport&&presentationMotionReport&&!embeddingReport):Boolean(embeddingReport)),
    'Choose embedding evidence, hidden lifecycle plus temporal evidence, or --buffered-self-test with hidden lifecycle only.');
  const buildReceiptFile=path.join(appRoot,'.build/workbench-freerdp-client-build.json');
  const buildReceiptSha256=sha(await readFile(buildReceiptFile));
  const build=await json(buildReceiptFile);
  requireEvidence(build.schema===2&&sha(await readFile(build.executable))===build.sha256&&
    sha(await readFile(path.join(appRoot,'scripts/workbench-freerdp-client/main.cpp')))===build.sourceSha256&&
    sha(await readFile(path.join(build.runtimeDirectory,'runtime-manifest.json')))===build.runtimeManifestSha256,
    'Build bytes changed after verification. Rebuild and rerun the live probes.');
  const presentation=hidden&&!bufferedSelfTest?await savedPresentation(await json(presentationMotionReport),build,buildReceiptSha256):null;
  const acceptance=bufferedSelfTest?assessBufferedHiddenPreviewEvidence(await json(sessionReport),await json(hiddenLifecycleReport),build,{buildReceiptSha256}):
    hidden?assessHiddenPreviewEvidence(await json(sessionReport),await json(hiddenLifecycleReport),presentation,build):
      assessPreviewEvidence(await json(sessionReport),await json(embeddingReport),build);
  if(presentation?.boundSources)acceptance.presentationEvidence.boundSources=presentation.boundSources;
  requireEvidence(sha(await readFile(buildReceiptFile))===buildReceiptSha256,'The native build receipt changed while recording evidence.');
  acceptance.recordedAt=new Date().toISOString();
  acceptance.evidence={session:{file:path.basename(sessionReport),sha256:sha(await readFile(sessionReport))},
    ...(hidden?{hiddenLifecycle:{file:path.basename(hiddenLifecycleReport),sha256:sha(await readFile(hiddenLifecycleReport))},
      ...(bufferedSelfTest?{bufferedSelfTest:{file:path.basename(buildReceiptFile),sha256:buildReceiptSha256,sourceSha256:build.sourceSha256}}:
        {presentationMotion:{file:path.basename(presentationMotionReport),sha256:sha(await readFile(presentationMotionReport))}})}:
      {embedding:{file:path.basename(embeddingReport),sha256:sha(await readFile(embeddingReport))}})};
  await mkdir(path.dirname(output),{recursive:true});
  const temporary=output+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(acceptance,null,2)+'\n',{flag:'wx'});await rename(temporary,output);
  return acceptance;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({options:{'app-root':{type:'string'},'session-report':{type:'string'},'embedding-report':{type:'string'},
    'hidden-lifecycle-report':{type:'string'},'presentation-motion-report':{type:'string'},'buffered-self-test':{type:'boolean'},output:{type:'string'}}});
  if(!values['session-report'])throw Error('Supply --session-report and the selected presentation/lifecycle reports.');
  const appRoot=path.resolve(values['app-root']||fileURLToPath(new URL('../',import.meta.url)));
  const result=await recordPreview({appRoot,sessionReport:path.resolve(values['session-report']),
    embeddingReport:values['embedding-report']&&path.resolve(values['embedding-report']),
    hiddenLifecycleReport:values['hidden-lifecycle-report']&&path.resolve(values['hidden-lifecycle-report']),
    presentationMotionReport:values['presentation-motion-report']&&path.resolve(values['presentation-motion-report']),
    bufferedSelfTest:values['buffered-self-test']===true,
    output:path.resolve(values.output||path.join(appRoot,'.build/workbench-native-acceptance.json'))});
  console.log(JSON.stringify({scope:result.scope,checks:result.checks,measured:result.measured,fullAcceptance:false}));
}
