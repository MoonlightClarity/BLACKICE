import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {OwnershipGuard} from '../verification/measure-workbench-native-session.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
const require=createRequire(import.meta.url);
const {compositionBackground,inspectCompositionBackground,inspectComposedNative,isProbeEntry,runExplicitProbeWake,noOwnedForegroundActivation,validateDetachedGeometry,verifyDetachedAnchorSurvival,isolatedAcceptanceEnvironment,nativeCaptureRectangle}=require('../verification/probe-workbench-native-electron.cjs');

const windowRect={left:100,top:200,right:164,bottom:248},childRect={left:116,top:208,right:148,bottom:240};
const colour=(x,y)=>({r:64+x*20,g:80+y*20,b:60+((x+y)%4)*40});

test('entry detection handles Electron bootstrap while a Node require remains inert',()=>{
  const script=fileURLToPath(new URL('../verification/probe-workbench-native-electron.cjs',import.meta.url));
  assert.equal(isProbeEntry({nodeMain:false,electron:'40.0',argv:['electron.exe',script],script}),true);
  assert.equal(isProbeEntry({nodeMain:false,electron:undefined,argv:['node',script],script}),false);
  assert.equal(isProbeEntry({nodeMain:false,electron:'40.0',argv:['electron.exe',script+'.other'],script}),false);
  assert.equal(isProbeEntry({nodeMain:false,electron:'40.0',argv:['electron.exe','another-entry.cjs',script],script}),false);
});

test('nonactivation permits natural app changes but rejects any owned foreground window or process',()=>{
  const natural={samples:100,transitions:3,unchanged:false,probeForegroundSamples:0,ownedProcessForegroundSamples:0};
  assert.equal(noOwnedForegroundActivation(natural),true);
  assert.equal(noOwnedForegroundActivation({...natural,probeForegroundSamples:1}),false);
  assert.equal(noOwnedForegroundActivation({...natural,ownedProcessForegroundSamples:1}),false);
  assert.equal(noOwnedForegroundActivation({...natural,error:'observer failed'}),false);
  assert.equal(noOwnedForegroundActivation({...natural,samples:1}),false);
});

test('detached geometry requires its own normal top-level window, same helper identity, and a fitted client viewport',()=>{
  const value={parentAlive:true,childAlive:true,actualRoot:'1234',actualParent:'1234',rootPid:42,childPid:42,
    rootStyle:0x00cf0000,childStyle:0x50000000,childRect:{left:108,top:230,right:900,bottom:700},clientScreenRect:{left:108,top:230,right:900,bottom:700}};
  assert.equal(validateDetachedGeometry(value,'1234',42).standardWindow,true);
  for(const changed of [{actualRoot:'456'},{actualParent:'456'},{rootPid:99},{childPid:99},{rootStyle:0x40000000},{rootStyle:0x00c00000},
    {clientScreenRect:{...value.clientScreenRect,right:901}}])assert.throws(()=>validateDetachedGeometry({...value,...changed},'1234',42),/could not be verified/);
});

test('anchor HWND loss preserves the same detached helper, root, decoded-frame API and owner',async()=>{
  const worker={pid:42,exitCode:null,killed:false},state={detached:true,connected:true,displayReady:true,workbenchWindowHwnd:'1234',inputOwner:'agent',windowVisible:true};
  const frame={bytes:Buffer.alloc(54),sequence:2,width:1024,height:768};
  const workbench={consoleControl:{status:()=>({owner:'agent'})},adapter:{frame:async()=>frame}};
  const viewer={native:{worker},status:async()=>({...state})};
  const result=await verifyDetachedAnchorSurvival({viewer,workbench,worker,windowHwnd:'1234',owner:'agent'});
  assert.equal(result.sessionSurvived,true);assert.equal(result.frameAvailable,true);assert.equal(result.sameHelperPid,true);
  for(const changed of [{connected:false},{inputOwner:'user'},{workbenchWindowHwnd:'4321'}]){
    const altered={...viewer,status:async()=>({...state,...changed})};
    await assert.rejects(verifyDetachedAnchorSurvival({viewer:altered,workbench,worker,windowHwnd:'1234',owner:'agent'}),/changed the detached session/);
  }
  await assert.rejects(verifyDetachedAnchorSurvival({viewer:{...viewer,native:{worker:{...worker}}},workbench,worker,windowHwnd:'1234',owner:'agent'}),/changed the detached session/);
  await assert.rejects(verifyDetachedAnchorSurvival({viewer,workbench:{...workbench,adapter:{frame:async()=>({})}},worker,windowHwnd:'1234',owner:'agent'}),/frame API/);
});

test('only the isolated probe uses a fresh absent acceptance path while retaining verification and existing receipts',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-isolated-acceptance-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'probe.json'),existing=path.join(directory,'accepted.json');await writeFile(existing,'existing product acceptance');
  const sourceEnv={SystemRoot:'C:\\Windows',BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE:existing};
  const result=await isolatedAcceptanceEnvironment(output,sourceEnv);
  assert.equal(result.env.BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE,output+'.pending-acceptance.json');
  assert.equal(result.env.SystemRoot,sourceEnv.SystemRoot);assert.equal(sourceEnv.BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE,existing);
  assert.equal(result.evidence.scope,'isolated-probe-only');assert.equal(result.evidence.binaryAndRuntimeVerificationRequired,true);
  assert.equal(await readFile(existing,'utf8'),'existing product acceptance');
  await writeFile(result.env.BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE,'unexpected pending file');
  await assert.rejects(isolatedAcceptanceEnvironment(output,sourceEnv),/must be absent/);
});

test('actual Electron entry writes a boot receipt without a VM helper, network or window', {skip:process.platform!=='win32'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-electron-entry-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'entry.json'),script=fileURLToPath(new URL('../verification/probe-workbench-native-electron.cjs',import.meta.url));
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='ELECTRON_RUN_AS_NODE')delete env[key];
  const result=spawnSync(require('electron'),[script,'--entry-smoke','--wake-display','--output='+output],{encoding:'utf8',windowsHide:true,timeout:15000,env});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  const receipt=JSON.parse(await readFile(output,'utf8'));
  assert.equal(receipt.entered,true);assert.equal(receipt.argvEntryMatched,true);
  assert.equal(receipt.networkStarted,false);assert.equal(receipt.vmHelperStarted,false);assert.equal(receipt.windowCreated,false);
  assert.equal(receipt.gpuDisabledByProbe,false);
});

test('probe wake requires explicit opt-in and actual agent ownership without taking or ceding control',async()=>{
  let actual={owner:'agent',revision:4},wakes=0,clock=0;const routes=[];
  const guard=new OwnershipGuard(async route=>{routes.push(route);return {consoleControl:{...actual}}});
  const workbench={consoleControl:new WorkbenchConsoleControl(),adapter:{wake:async(value,assertCurrent)=>{
    assertCurrent();assert.deepEqual(value,{owner:'agent'});wakes++;return {inputOwner:'agent',wake:{requested:true,queued:true,desktopAwakeConfirmed:false}};
  }}};
  const record={guestInputSent:0},viewer={status:async()=>({frameHealth:{available:true,dark:false,distinctColors:348}})};
  await runExplicitProbeWake({enabled:false,guard,workbench,viewer,record});assert.equal(wakes,0);assert.deepEqual(routes,[]);
  await runExplicitProbeWake({enabled:true,guard,workbench,viewer,record,now:()=>clock,pause:async ms=>{clock+=ms}});
  assert.equal(wakes,1);assert.equal(record.guestInputSent,1);assert.equal(record.wakeDisplay.decodedNotDarkObserved,true);
  assert.deepEqual(record.wakeDisplay.ownershipBefore,{owner:'agent',revision:4});
  assert.deepEqual(record.wakeDisplay.ownershipAfter,{owner:'agent',revision:4});
  assert.equal(record.wakeDisplay.nativeReceipt.wake.desktopAwakeConfirmed,false);
  assert.equal(record.wakeDisplay.atomicWithGlobalServerInputQueue,false);
  assert.deepEqual(routes,['/api/workbench','/api/workbench']);
  assert.equal(workbench.consoleControl.status().owner,'agent');
  const explicitAgain={guestInputSent:0};
  await runExplicitProbeWake({enabled:true,guard,workbench,viewer,record:explicitAgain,initial:{frameHealth:{available:true,dark:false,distinctColors:2}}});
  assert.equal(wakes,2);assert.equal(explicitAgain.guestInputSent,1);assert.equal(explicitAgain.wakeDisplay.attempted,true);
});

test('probe wake refuses user ownership, fails closed on revision change, and never retries an asleep display',async()=>{
  for(const changed of ['user-before','revision-after','dark-timeout']){
    let actual={owner:changed==='user-before'?'user':'agent',revision:9},wakes=0,time=0;
    const guard=new OwnershipGuard(async()=>({consoleControl:{...actual}}));
    const record={guestInputSent:0},workbench={consoleControl:new WorkbenchConsoleControl(),adapter:{wake:async(_value,assertCurrent)=>{
      assertCurrent();wakes++;if(changed==='revision-after')actual.revision++;
      return {wake:{requested:true,queued:true,desktopAwakeConfirmed:false}};
    }}};
    await assert.rejects(runExplicitProbeWake({enabled:true,guard,workbench,record,
      viewer:{status:async()=>({frameHealth:{available:true,dark:true}})},timeoutMs:200,now:()=>time,pause:async ms=>{time+=ms}}),
      /stopped|not-dark decoded/);
    assert.equal(wakes,changed==='user-before'?0:1);assert.equal(record.guestInputSent,wakes);
    assert.equal(workbench.consoleControl.status().owner,'agent');
  }
});

test('a not-dark two-colour placeholder cannot complete the post-wake content wait',async()=>{
  const guard=new OwnershipGuard(async()=>({consoleControl:{owner:'agent',revision:2}}));
  let reads=0,time=0,wakes=0;
  const workbench={consoleControl:new WorkbenchConsoleControl(),adapter:{wake:async(_value,assertCurrent)=>{
    assertCurrent();wakes++;return {wake:{requested:true,queued:true,desktopAwakeConfirmed:false}};
  }}};
  const record={guestInputSent:0};
  await runExplicitProbeWake({enabled:true,guard,workbench,record,initial:{frameHealth:{available:true,dark:false,distinctColors:2}},
    viewer:{status:async()=>({frameHealth:{available:true,dark:false,distinctColors:++reads===1?2:348}})},
    now:()=>time,pause:async ms=>{time+=ms}});
  assert.equal(wakes,1);assert.equal(reads,2);assert.equal(time,100);assert.equal(record.guestInputSent,1);
  assert.equal(record.wakeDisplay.status.frameHealth.distinctColors,348);
});
function fixture({order='BGRA',shown=true,black=false,flat=false}={}){
  const width=8,height=8,bytes=Buffer.alloc(54+width*height*4);
  bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);
  bytes.writeInt32LE(width,18);bytes.writeInt32LE(-height,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const c=flat?{r:255,g:255,b:255}:colour(x,y),offset=54+(y*width+x)*4;
    bytes[offset]=c.b;bytes[offset+1]=c.g;bytes[offset+2]=c.r;bytes[offset+3]=255;
  }
  const capture={width:64,height:48,bitmap:Buffer.alloc(64*48*4)};
  for(let y=0;y<48;y++)for(let x=0;x<64;x++){
    const inside=x>=16&&x<48&&y>=8&&y<40;
    const c=inside&&shown?(black?{r:0,g:0,b:0}:flat?{r:255,g:255,b:255}:colour(Math.floor((x-16)/4),Math.floor((y-8)/4))):compositionBackground;
    const offset=(y*64+x)*4;
    capture.bitmap[offset]=order==='BGRA'?c.b:c.r;capture.bitmap[offset+1]=c.g;capture.bitmap[offset+2]=order==='BGRA'?c.r:c.b;capture.bitmap[offset+3]=255;
  }
  return {capture,reference:{bytes,width,height}};
}

test('composition compares actual window child pixels against an independent scaled decoded BMP',()=>{
  for(const order of ['BGRA','RGBA']){
    const hidden=fixture({order,shown:false}),background=inspectCompositionBackground(hidden.capture,windowRect,childRect);
    assert.equal(background.order,order);assert.equal(background.matchingFraction,1);
    const shown=fixture({order}),result=inspectComposedNative(shown.capture,windowRect,childRect,shown.reference,background.order);
    assert.equal(result.passed,true);assert.equal(result.matchingFraction,1);assert.equal(result.distinctReferenceColours,64);
    assert.equal(result.physicalInputToPhoton,false);
  }
});

test('DWM visible-frame coordinates correctly map a capture that excludes invisible Win32 resize borders',()=>{
  const shown=fixture(),win32={left:90,top:190,right:174,bottom:258};
  const mapping=nativeCaptureRectangle({windowRect:win32,extendedFrameBoundsAvailable:true,extendedFrameBounds:windowRect});
  assert.equal(mapping.source,'DWMWA_EXTENDED_FRAME_BOUNDS');assert.deepEqual(mapping.rectangle,windowRect);
  assert.equal(inspectComposedNative(shown.capture,mapping.rectangle,childRect,shown.reference,'BGRA').matchingFraction,1);
  assert.throws(()=>inspectComposedNative(shown.capture,win32,childRect,shown.reference,'BGRA'),error=>{
    assert.ok(error.diagnostics.matchingFraction<.9);assert.ok(error.diagnostics.p95MaximumChannelError>20);
    assert.equal(error.diagnostics.minimumMatchingFraction,.9);return true;
  });
  assert.equal(nativeCaptureRectangle({windowRect,extendedFrameBoundsAvailable:false}).source,'GetWindowRect');
});

test('black or occluding captures, insufficient source colours and invalid geometry fail closed',()=>{
  const shown=fixture(),black=fixture({black:true}),hidden=fixture({shown:false}),flat=fixture({flat:true});
  assert.throws(()=>inspectCompositionBackground(shown.capture,windowRect,childRect),/distinct background/);
  assert.throws(()=>inspectComposedNative(black.capture,windowRect,childRect,shown.reference,'BGRA'),/capture mapping remain unverified/);
  assert.throws(()=>inspectComposedNative(hidden.capture,windowRect,childRect,shown.reference,'BGRA'),/capture mapping remain unverified/);
  assert.throws(()=>inspectComposedNative(flat.capture,windowRect,childRect,flat.reference,'BGRA'),/insufficient/);
  assert.throws(()=>inspectComposedNative(shown.capture,windowRect,{...childRect,left:99},shown.reference,'BGRA'),/does not fit/);
  assert.throws(()=>inspectCompositionBackground({...hidden.capture,bitmap:Buffer.alloc(3)},windowRect,childRect),/bitmap is invalid/);
});

test('detached probe captures the exact native window and verifies Close-hide/reopen/resize without activating it',async()=>{
  const source=await readFile(new URL('../verification/probe-workbench-native-electron.cjs',import.meta.url),'utf8');
  assert.match(source,/process\.argv\.includes\('--visible-composition'\)/);
  assert.match(source,/mode:detachedProbe\?'detached-window'/);
  assert.match(source,/detachedWindow:detachedProbe/);
  assert.match(source,/receipt\.detachedPresentation=await proveDetachedPresentation/);
  assert.match(source,/source=sources\.find\(value=>value\.id===sourceId\)/);
  assert.match(source,/const sourceId=`window:\$\{targetHandle\}:0`/);
  assert.match(source,/controlOwnedDetached\(root,pid,'close'\)/);
  assert.match(source,/windowCloseRevision>beforeClose\.windowCloseRevision/);
  assert.match(source,/agentFrameApiAvailable:true,agentInputNotExercised:true/);
  assert.match(source,/controlOwnedDetached\(root,pid,'resize'/);
  assert.match(source,/DwmGetWindowAttribute\(\$parent,9/);
  assert.ok(source.indexOf('await fs.writeFile(referenceFile,reference.bytes')<source.indexOf('inspectComposedNative(capture,bounds.rectangle'));
  assert.match(source,/receipt\.comparisonArtifacts\?\?=\[\]/);
  assert.match(source,/receipt\.comparisonFailure=error\.diagnostics/);
  assert.doesNotMatch(source,/parent\.showInactive\(\)/);
  assert.match(source,/foregroundObserver=await observeForeground/);
  assert.match(source,/receipt\.foregroundSampling\.unchanged/);
  assert.doesNotMatch(source,/disableHardwareAcceleration|capturePage|SetForegroundWindow|SetActiveWindow|\.focus\(/);
});

test('owned-window operation parses and its PMv2 thread scope restores without touching a VM or window', {skip:process.platform!=='win32'},async()=>{
  const source=await readFile(new URL('../verification/probe-workbench-native-electron.cjs',import.meta.url),'utf8');
  const section=source.slice(source.indexOf('async function controlOwnedDetached('),source.indexOf('async function waitDetachedStatus('));
  const body=/return ps\(`([\s\S]*)`\);/.exec(section)?.[1];assert.ok(body);
  const operation=Function('windowHwnd','pid','action','width','height','return `'+body+'`;')('1234',42,'resize',960,720);
  assert.ok(operation.indexOf('$priorDpi=')<operation.indexOf('$window='));assert.match(operation,/finally\{\[void\]\[OwnedWindowControl\]::SetThreadDpiAwarenessContext\(\$priorDpi\)/);
  const script=`$ErrorActionPreference='Stop'
$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(operation).toString('base64')}'))
$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class DpiScopeSmoke {
[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")]public static extern IntPtr GetThreadDpiAwarenessContext();
[DllImport("user32.dll")]public static extern bool AreDpiAwarenessContextsEqual(IntPtr first,IntPtr second);
}
'@
$prior=[DpiScopeSmoke]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));if($prior -eq [IntPtr]::Zero){throw 'PMv2 failed'}
try{if(-not [DpiScopeSmoke]::AreDpiAwarenessContextsEqual([DpiScopeSmoke]::GetThreadDpiAwarenessContext(),[IntPtr]::new(-4))){throw 'Not PMv2'}}
finally{[void][DpiScopeSmoke]::SetThreadDpiAwarenessContext($prior)}
if(-not [DpiScopeSmoke]::AreDpiAwarenessContextsEqual([DpiScopeSmoke]::GetThreadDpiAwarenessContext(),$prior)){throw 'DPI restore failed'}
Write-Output 'PMV2_SCOPE_OK'`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PMV2_SCOPE_OK/);
});
