// Explicit isolated integration probe: an OWN GPU-enabled Electron window.
// Hidden by default; --visible-composition explicitly permits showInactive.
// No host input, automatic guest input, foreground restoration or app install.
// --wake-display permits one recorded benign MOVE under actual agent ownership.
const {createHash}=require('node:crypto');
const entryPath=require('node:path');
const probeClock=require('node:perf_hooks').performance;

function isProbeEntry({electron=process.versions.electron,argv=process.argv,script=__filename,nodeMain=require.main===module}={}){
  if(nodeMain)return true;
  // Electron's CommonJS bootstrap can leave require.main pointing at its own
  // loader. Bind that runtime's explicit entry argument to this exact file.
  if(!electron||typeof argv?.[1]!=='string')return false;
  try{return entryPath.resolve(argv[1]).toLowerCase()===entryPath.resolve(script).toLowerCase()}catch{return false;}
}

const compositionBackground={r:19,g:173,b:71};
const failEvidence=(message,diagnostics)=>{const error=Error(message);if(diagnostics)error.diagnostics=diagnostics;throw error};
function nativeCaptureRectangle(geometry){
  const available=geometry?.extendedFrameBoundsAvailable===true;
  const rectangle=available?geometry.extendedFrameBounds:geometry?.windowRect;
  if(!rectangle||!['left','top','right','bottom'].every(key=>Number.isSafeInteger(rectangle[key]))||
    rectangle.right<=rectangle.left||rectangle.bottom<=rectangle.top)failEvidence('The native capture rectangle is invalid.');
  return {rectangle,source:available?'DWMWA_EXTENDED_FRAME_BOUNDS':'GetWindowRect',
    width:rectangle.right-rectangle.left,height:rectangle.bottom-rectangle.top};
}
function noOwnedForegroundActivation(value){
  return value?.samples>=2&&!value.error&&value.probeForegroundSamples===0&&value.ownedProcessForegroundSamples===0;
}
function validateDetachedGeometry(value,windowHwnd,expectedPid){
  if(!/^\d{1,20}$/.test(windowHwnd||'')||!value?.parentAlive||!value.childAlive||value.actualRoot!==windowHwnd||
    value.actualParent!==windowHwnd||value.rootPid!==expectedPid||value.childPid!==expectedPid||
    (value.rootStyle&0x40000000)!==0||(value.childStyle&0x40000000)===0||
    (value.rootStyle&0x00c00000)!==0x00c00000||(value.rootStyle&0x00040000)===0||
    !['left','top','right','bottom'].every(key=>Number.isSafeInteger(value.childRect?.[key])&&value.childRect[key]===value.clientScreenRect?.[key]))
    failEvidence('The detached native window or its fitted client viewport could not be verified.');
  return {actualTopLevelVerified:true,standardWindow:true,viewportFitsClient:true,windowHwnd,rootPid:expectedPid};
}
async function verifyDetachedAnchorSurvival({viewer,workbench,worker,windowHwnd,owner,assertCurrent=()=>{}}){
  assertCurrent();const status=await viewer.status();assertCurrent();
  if(viewer.native?.worker!==worker||worker.exitCode!==null||worker.killed||status.detached!==true||
    status.connected!==true||status.displayReady!==true||status.workbenchWindowHwnd!==windowHwnd||
    status.inputOwner!==owner||workbench.consoleControl.status().owner!==owner)
    failEvidence('Destroying the launcher HWND changed the detached session, native root or input owner.');
  const frame=await workbench.adapter.frame();assertCurrent();
  if(!Buffer.isBuffer(frame?.bytes)||frame.bytes.length<54||!Number.isSafeInteger(frame.sequence)||frame.sequence<1||
    ![frame.width,frame.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096))
    failEvidence('The detached decoded frame API did not survive launcher HWND destruction.');
  return {sessionSurvived:true,frameAvailable:true,ownerUnchanged:true,sameHelperPid:true,sameWindowHwnd:true,
    windowVisible:status.windowVisible===true,frame:{width:frame.width,height:frame.height,sequence:frame.sequence,
      sha256:createHash('sha256').update(frame.bytes).digest('hex')},status};
}
async function isolatedAcceptanceEnvironment(output,env=process.env,{lstat=require('node:fs/promises').lstat}={}){
  if(!entryPath.isAbsolute(output||''))failEvidence('An absolute isolated probe output is required.');
  const pending=output+'.pending-acceptance.json';
  try{await lstat(pending);failEvidence('The isolated pending acceptance path must be absent.');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return {env:{...env,BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE:pending},
    evidence:{path:pending,missingAtPreflight:true,scope:'isolated-probe-only',binaryAndRuntimeVerificationRequired:true}};
}
function evidenceGrid(capture,windowRect,childRect){
  if(!Buffer.isBuffer(capture?.bitmap)||![capture.width,capture.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||
    capture.bitmap.length!==capture.width*capture.height*4)failEvidence('The owned-window capture bitmap is invalid.');
  for(const rectangle of [windowRect,childRect])if(!rectangle||!['left','top','right','bottom'].every(k=>Number.isSafeInteger(rectangle[k]))||
    rectangle.right<=rectangle.left||rectangle.bottom<=rectangle.top)failEvidence('The composed-window geometry is invalid.');
  if(childRect.left<windowRect.left||childRect.top<windowRect.top||childRect.right>windowRect.right||childRect.bottom>windowRect.bottom)
    failEvidence('The native child does not fit its owned capture window.');
  const points=[];
  for(let row=0;row<24;row++)for(let column=0;column<32;column++){
    const u=(column+.5)/32,v=(row+.5)/24;
    const x=Math.floor((childRect.left-windowRect.left+u*(childRect.right-childRect.left))*capture.width/(windowRect.right-windowRect.left));
    const y=Math.floor((childRect.top-windowRect.top+v*(childRect.bottom-childRect.top))*capture.height/(windowRect.bottom-windowRect.top));
    points.push({u,v,offset:(y*capture.width+x)*4});
  }
  return points;
}
const capturedRgb=(bytes,offset,order)=>order==='BGRA'?{r:bytes[offset+2],g:bytes[offset+1],b:bytes[offset]}:{r:bytes[offset],g:bytes[offset+1],b:bytes[offset+2]};
const colourError=(a,b)=>Math.max(...['r','g','b'].map(key=>Math.abs(a[key]-b[key])));
function inspectCompositionBackground(capture,windowRect,childRect){
  const points=evidenceGrid(capture,windowRect,childRect);
  const options=['BGRA','RGBA'].map(order=>({order,matchingFraction:points.filter(point=>colourError(capturedRgb(capture.bitmap,point.offset,order),compositionBackground)<=8).length/points.length}));
  const best=options.sort((a,b)=>b.matchingFraction-a.matchingFraction)[0];
  if(best.matchingFraction<.98)failEvidence('The exact owned-window source did not show its distinct background when the native child was hidden.');
  return {...best,sampledPixels:points.length,background:compositionBackground};
}
function inspectComposedNative(capture,windowRect,childRect,reference,order){
  const points=evidenceGrid(capture,windowRect,childRect),bytes=reference?.bytes,width=reference?.width,height=reference?.height;
  if(!Buffer.isBuffer(bytes)||![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||bytes.length!==54+width*height*4||
    bytes.toString('ascii',0,2)!=='BM'||bytes.readUInt32LE(10)!==54||bytes.readUInt32LE(14)!==40||bytes.readUInt16LE(28)!==32||
    bytes.readUInt32LE(30)!==0||bytes.readInt32LE(18)!==width||Math.abs(bytes.readInt32LE(22))!==height||!['BGRA','RGBA'].includes(order))
    failEvidence('The decoded reference BMP could not be independently compared.');
  const topDown=bytes.readInt32LE(22)<0,colours=new Set(),errors=[];
  for(const point of points){
    const x=Math.min(width-1,Math.floor(point.u*width)),y=Math.min(height-1,Math.floor(point.v*height));
    const expected=capturedRgb(bytes,54+((topDown?y:height-1-y)*width+x)*4,'BGRA');
    // A nearly black/flat source cannot prove that a black native overlay drew.
    if(Math.max(expected.r,expected.g,expected.b)<40||colourError(expected,compositionBackground)<40)continue;
    colours.add(`${expected.r},${expected.g},${expected.b}`);
    errors.push(colourError(capturedRgb(capture.bitmap,point.offset,order),expected));
  }
  errors.sort((a,b)=>a-b);
  const matchingFraction=errors.length?errors.filter(error=>error<=20).length/errors.length:0;
  const diagnostics={eligiblePixels:errors.length,distinctReferenceColours:colours.size,matchingFraction,
    minimumMatchingFraction:.9,maximumAllowedChannelError:20,
    p50MaximumChannelError:errors[Math.ceil(errors.length*.5)-1]??null,p95MaximumChannelError:errors[Math.ceil(errors.length*.95)-1]??null,
    maximumChannelError:errors.at(-1)??null,capture:{width:capture.width,height:capture.height},captureRectangle:windowRect,childRectangle:childRect,
    reference:{width,height},channelOrder:order};
  if(errors.length<24||colours.size<4)failEvidence('The decoded guest reference has insufficient bright, distinct colours to prove native composition.',diagnostics);
  if(matchingFraction<.9)failEvidence('The actual composed window did not match its decoded native child; occlusion, frame changes or capture mapping remain unverified.',diagnostics);
  return {passed:true,...diagnostics,comparison:'actual owned-window desktop capture versus independently decoded BMP',physicalInputToPhoton:false};
}
async function runExplicitProbeWake({enabled,guard,workbench,viewer,record,initial,now=()=>probeClock.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=5000}){
  if(!enabled)return;
  if(!guard||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>10000)failEvidence('An actual bounded Workbench ownership guard is required for probe wake.');
  const before=await guard.check();guard.assert();
  if(before.consoleControl?.owner!=='agent')failEvidence('The actual Workbench agent must own input before probe wake.');
  record.wakeDisplay={explicitOptIn:true,expectedOwner:'agent',ownershipBefore:{owner:before.consoleControl.owner,revision:before.consoleControl.revision},
    attempted:false,atomicWithGlobalServerInputQueue:false,ownershipMonitorIntervalMs:100};
  // The explicit flag authorizes exactly one MOVE. A VMMS placeholder can be
  // black plus a white stripe and classify not-dark without being a desktop.
  record.wakeDisplay.attempted=true;record.guestInputSent++;
  const result=await workbench.consoleControl.run(assertCurrent=>{
    guard.assert();assertCurrent();
    return workbench.adapter.wake({owner:'agent'},()=>{guard.assert();assertCurrent();});
  });
  record.wakeDisplay.nativeReceipt=result;
  const after=await guard.check();guard.assert();
  record.wakeDisplay.ownershipAfter={owner:after.consoleControl.owner,revision:after.consoleControl.revision};
  if(after.consoleControl.owner!=='agent'||after.consoleControl.revision!==before.consoleControl.revision)
    failEvidence('Actual Workbench ownership changed during the single probe wake.');
  if(result?.wake?.requested!==true||result.wake.queued!==true||result.wake.desktopAwakeConfirmed!==false)
    failEvidence('The probe did not receive a bounded queued-only wake receipt.');
  const deadline=now()+timeoutMs;
  while(now()<deadline){
    guard.assert();const status=await viewer.status();guard.assert();
    if(status.frameHealth?.available===true&&status.frameHealth.dark===false&&
      Number.isSafeInteger(status.frameHealth.distinctColors)&&status.frameHealth.distinctColors>=4){
      record.wakeDisplay.decodedNotDarkObserved=true;record.wakeDisplay.status=status;return;
    }
    await pause(100);
  }
  failEvidence('The one explicit wake was queued, but a not-dark decoded surface with enough distinct colours was not observed within the bound.');
}
module.exports={compositionBackground,inspectCompositionBackground,inspectComposedNative,isProbeEntry,runExplicitProbeWake,noOwnedForegroundActivation,validateDetachedGeometry,verifyDetachedAnchorSurvival,isolatedAcceptanceEnvironment,nativeCaptureRectangle};

if(isProbeEntry()){
const {app,BrowserWindow,screen,desktopCapturer}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const repo=path.resolve(__dirname,'..');
const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const output=option('output');
if(!output||!path.isAbsolute(output))throw Error('An explicit absolute --output receipt path is required.');
if(process.argv.includes('--entry-smoke')){
  // An actual Electron bootstrap check that cannot reach any VM, preflight,
  // native helper or window construction. Its output/profile belong to this run.
  app.setPath('userData',path.join(path.dirname(output),'native-electron-entry-smoke-profile'));
  const bootWatchdog=setTimeout(()=>app.exit(2),8000);
  app.whenReady().then(async()=>{
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(output,JSON.stringify({version:1,probe:'native-electron-entry-smoke',entered:true,
      electron:process.versions.electron,nodeMainMatched:require.main===module,argvEntryMatched:isProbeEntry({nodeMain:false}),
      networkStarted:false,vmHelperStarted:false,windowCreated:false,gpuDisabledByProbe:false})+'\n',{flag:'wx'});
    clearTimeout(bootWatchdog);app.exit(0);
  }).catch(()=>{clearTimeout(bootWatchdog);app.exit(1)});
}else{
const visibleComposition=process.argv.includes('--visible-composition');
const detachedProbe=visibleComposition||process.argv.includes('--detached-window');
const wakeDisplay=process.argv.includes('--wake-display');
// This probe deliberately destroys its only window before writing the final
// lifecycle receipt. Keep Electron alive until the explicit bounded finish.
app.on('window-all-closed',()=>{});
app.setPath('userData',path.join(path.dirname(output),'native-electron-probe-profile'));
const receipt={version:1,probe:detachedProbe?'isolated-detached-native-workbench':'isolated-hidden-electron-native-child',at:new Date().toISOString(),networkConnectExplicit:true,
  mode:detachedProbe?'detached-window':'hidden-lifecycle',gpuDisabledByProbe:false,
  guestInputSent:0,hostInputSent:0,realAppChanged:false,passed:false};
let viewer,parent,watchdog,finishing=false,foregroundObserver,globalOwnership;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(value,message)=>{if(!value)throw Error(message)};
const ps=async script=>{
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const {stdout}=await execute(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',encoded],
    {windowsHide:true,shell:false,timeout:10000,maxBuffer:32768});
  return JSON.parse(stdout.trim());
};
const inspect=async(child,parentHandle)=>ps(`
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class NativeProbe {
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int i);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
[StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT rect);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT rect);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT point);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,uint attribute,out RECT rect,int size);
}
'@
$child=[IntPtr]::new([Int64]'${child}');$parent=[IntPtr]::new([Int64]'${parentHandle}');
$oldDpi=[NativeProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));
$rect=New-Object NativeProbe+RECT;$parentRect=New-Object NativeProbe+RECT;$clientRect=New-Object NativeProbe+RECT;$origin=New-Object NativeProbe+POINT;$extended=New-Object NativeProbe+RECT;$dwmResult=-1;try{
[void][NativeProbe]::GetWindowRect($child,[ref]$rect);[void][NativeProbe]::GetWindowRect($parent,[ref]$parentRect);
[void][NativeProbe]::GetClientRect($parent,[ref]$clientRect);[void][NativeProbe]::ClientToScreen($parent,[ref]$origin);
$dwmResult=[NativeProbe]::DwmGetWindowAttribute($parent,9,[ref]$extended,[Runtime.InteropServices.Marshal]::SizeOf($extended))}finally{
if($oldDpi -ne [IntPtr]::Zero){[void][NativeProbe]::SetThreadDpiAwarenessContext($oldDpi)}};$childPid=[uint32]0;
[void][NativeProbe]::GetWindowThreadProcessId($child,[ref]$childPid);
$foreground=[NativeProbe]::GetForegroundWindow();$foregroundPid=[uint32]0;[void][NativeProbe]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid);
$rootPid=[uint32]0;[void][NativeProbe]::GetWindowThreadProcessId($parent,[ref]$rootPid);
[ordered]@{childAlive=[NativeProbe]::IsWindow($child);parentAlive=[NativeProbe]::IsWindow($parent);
parentVisible=[NativeProbe]::IsWindowVisible($parent);childVisible=[NativeProbe]::IsWindowVisible($child);
actualParent=[NativeProbe]::GetParent($child).ToInt64().ToString();childStyle=[NativeProbe]::GetWindowLongPtr($child,-16).ToInt64();
rootStyle=[NativeProbe]::GetWindowLongPtr($parent,-16).ToInt64();rootPid=$rootPid;actualRoot=[NativeProbe]::GetAncestor($parent,2).ToInt64().ToString();
foreground=$foreground.ToInt64().ToString();foregroundPid=$foregroundPid;childPid=$childPid;
childRect=@{left=$rect.left;top=$rect.top;right=$rect.right;bottom=$rect.bottom};
windowRect=@{left=$parentRect.left;top=$parentRect.top;right=$parentRect.right;bottom=$parentRect.bottom};
extendedFrameBoundsAvailable=($dwmResult -eq 0 -and $extended.right -gt $extended.left -and $extended.bottom -gt $extended.top);dwmBoundsHresult=$dwmResult;
extendedFrameBounds=@{left=$extended.left;top=$extended.top;right=$extended.right;bottom=$extended.bottom};
clientScreenRect=@{left=$origin.x;top=$origin.y;right=$origin.x+$clientRect.right;bottom=$origin.y+$clientRect.bottom};
inspectorThreadPerMonitorV2=($oldDpi -ne [IntPtr]::Zero);childDpi=[NativeProbe]::GetDpiForWindow($child);parentDpi=[NativeProbe]::GetDpiForWindow($parent);
width=$rect.right-$rect.left;height=$rect.bottom-$rect.top}|ConvertTo-Json -Compress`);
async function observeForeground(expected,owned){
  const script=`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class ForegroundRead {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
}
'@
$until=[DateTime]::UtcNow.AddSeconds(90)
while([DateTime]::UtcNow -lt $until){$window=[ForegroundRead]::GetForegroundWindow();$owner=[uint32]0;[void][ForegroundRead]::GetWindowThreadProcessId($window,[ref]$owner);[Console]::WriteLine($window.ToInt64().ToString()+':'+$owner.ToString());[Console]::Out.Flush();Start-Sleep -Milliseconds 20}`;
  const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  const result={intervalMs:20,samples:0,transitions:0,probeForegroundSamples:0,ownedProcessForegroundSamples:0,unchanged:true},ready={};
  const ownedProcesses=new Set([process.pid]),seenProcesses=new Map();
  const addOwnedProcess=pid=>{if(Number.isSafeInteger(pid)&&pid>0&&!ownedProcesses.has(pid)){ownedProcesses.add(pid);result.ownedProcessForegroundSamples+=seenProcesses.get(pid)||0;}};
  ready.promise=new Promise((resolve,reject)=>{ready.resolve=resolve;ready.reject=reject});
  let buffer='',previous=expected,stopped=false;
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>4096){result.error='Foreground sample exceeded its bound.';result.unchanged=false;child.kill();return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      const parsed=/^(\d{1,20}):(\d{1,10})$/.exec(value);
      if(!parsed){result.error='Foreground sample was invalid.';result.unchanged=false;continue;}
      const window=parsed[1],pid=Number(parsed[2]);addOwnedProcess(viewer?.native?.worker?.pid);
      seenProcesses.set(pid,(seenProcesses.get(pid)||0)+1);
      result.samples++;if(window!==previous)result.transitions++;previous=window;
      if(window===owned)result.probeForegroundSamples++;if(ownedProcesses.has(pid))result.ownedProcessForegroundSamples++;
      if(window!==expected)result.unchanged=false;
      ready.resolve();
    }
  });
  child.once('error',()=>{result.error='Foreground observer could not start.';result.unchanged=false;ready.reject(Error(result.error))});
  child.once('exit',()=>{if(!stopped){result.error='Foreground observer ended before cleanup.';result.unchanged=false;ready.reject(Error(result.error))}});
  const observer={result,addOwnedProcess,stop:async()=>{stopped=true;child.kill();await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(1000)]);
    result.ownedProcessIds=[...ownedProcesses];result.noOwnedForegroundActivation=noOwnedForegroundActivation(result);}};
  try{await Promise.race([ready.promise,delay(5000).then(()=>{throw Error('Foreground observer did not start.')})]);return observer;}
  catch(error){await observer.stop();throw error;}
}
async function captureOwnedWindow(label,geometry,directory,targetHandle){
  assert(!finishing&&!parent.isDestroyed(),'The owned capture parent was closed');
  assert(/^\d{1,20}$/.test(targetHandle||''),'An exact probe-owned native window handle is required');
  const sourceId=`window:${targetHandle}:0`;
  const captureBounds=nativeCaptureRectangle(geometry);
  const sources=await Promise.race([desktopCapturer.getSources({types:['window'],fetchWindowIcons:false,
    thumbnailSize:{width:Math.min(1800,captureBounds.width),height:Math.min(1800,captureBounds.height)}}),
    delay(8000).then(()=>{throw Error('Owned-window desktop capture exceeded its bound.')})]);
  const source=sources.find(value=>value.id===sourceId);
  assert(source&&!source.thumbnail.isEmpty(),'The exact owned-window capture source was unavailable');
  const size=source.thumbnail.getSize(),bitmap=source.thumbnail.toBitmap({scaleFactor:1}),png=source.thumbnail.toPNG({scaleFactor:1});
  const file=path.join(directory,label+'.png');await fs.writeFile(file,png,{flag:'wx'});
  return {bitmap,...size,evidence:{sourceId,windowHwnd:targetHandle||parent.getNativeWindowHandle().readBigUInt64LE().toString(),parentHwnd:parent.getNativeWindowHandle().readBigUInt64LE().toString(),
    file,sha256:createHash('sha256').update(png).digest('hex'),width:size.width,height:size.height,source:'owned-window-desktop-capture',captureBounds}};
}
async function controlOwnedDetached(windowHwnd,pid,action,width=0,height=0){
  assert(/^\d{1,20}$/.test(windowHwnd)&&Number.isSafeInteger(pid)&&pid>0&&['close','resize'].includes(action),'Choose only this probe-owned native window');
  if(action==='resize')assert([width,height].every(n=>Number.isSafeInteger(n)&&n>=400&&n<=4096),'Bound the owned window resize');
  return ps(`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OwnedWindowControl {
[DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
[DllImport("user32.dll",SetLastError=true)]public static extern bool PostMessageW(IntPtr h,uint message,IntPtr wp,IntPtr lp);
[DllImport("user32.dll",SetLastError=true)]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
[StructLayout(LayoutKind.Sequential)]public struct RECT {public int left,top,right,bottom;}
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT rect);
}
'@
$priorDpi=[OwnedWindowControl]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));if($priorDpi -eq [IntPtr]::Zero){throw 'PMv2 operation context could not be established.'}
try{
$window=[IntPtr]::new([Int64]'${windowHwnd}');$owner=[uint32]0;[void][OwnedWindowControl]::GetWindowThreadProcessId($window,[ref]$owner)
if(-not [OwnedWindowControl]::IsWindow($window) -or $owner -ne ${pid} -or ([OwnedWindowControl]::GetWindowLongPtr($window,-16).ToInt64() -band 0x40000000)){throw 'Owned top-level identity changed.'}
$ok=${action==='close'?'[OwnedWindowControl]::PostMessageW($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)':`[OwnedWindowControl]::SetWindowPos($window,[IntPtr]::Zero,0,0,${width},${height},0x0002 -bor 0x0004 -bor 0x0010)`}
if(-not $ok){throw 'Owned window operation failed.'};$actual=New-Object OwnedWindowControl+RECT;[void][OwnedWindowControl]::GetWindowRect($window,[ref]$actual)
[ordered]@{accepted=$ok;action='${action}';operationThreadPerMonitorV2=$true;requested=@{width=${width};height=${height}};
actual=@{left=$actual.left;top=$actual.top;right=$actual.right;bottom=$actual.bottom;width=$actual.right-$actual.left;height=$actual.bottom-$actual.top}}|ConvertTo-Json -Compress
}finally{[void][OwnedWindowControl]::SetThreadDpiAwarenessContext($priorDpi)}`);
}
async function waitDetachedStatus(predicate,timeoutMs=4000){
  const deadline=probeClock.now()+timeoutMs;
  while(probeClock.now()<deadline){globalOwnership?.assert();const value=await viewer.status();if(predicate(value))return value;await delay(100);}
  throw Error('The detached Workbench did not confirm its bounded window transition.');
}
async function proveDetachedPresentation(workbench,attached){
  const root=attached.workbenchWindowHwnd,child=attached.childHwnd,pid=viewer.native.worker.pid,directory=output+'.composition';
  assert(attached.detached===true&&/^\d{1,20}$/.test(root||''),'A real detached Workbench HWND is required');
  await fs.mkdir(directory);await delay(250);
  const initial=await inspect(child,root),identity=validateDetachedGeometry(initial,root,pid);
  assert(initial.parentVisible&&initial.childVisible,'The detached native window did not open');
  const compare=async(label)=>{
    const geometry=await inspect(child,root);validateDetachedGeometry(geometry,root,pid);
    const reference=await workbench.adapter.frame(),bounds=nativeCaptureRectangle(geometry);
    const referenceFile=path.join(directory,label+'-decoded.bmp');await fs.writeFile(referenceFile,reference.bytes,{flag:'wx'});
    const referenceEvidence={file:referenceFile,width:reference.width,height:reference.height,sequence:reference.sequence,
      sha256:createHash('sha256').update(reference.bytes).digest('hex')};
    const geometryFile=path.join(directory,label+'-geometry.json'),diagnosticsFile=path.join(directory,label+'-comparison.json');
    await fs.writeFile(geometryFile,JSON.stringify({geometry,captureBounds:bounds,reference:referenceEvidence},null,2),{flag:'wx'});
    receipt.comparisonArtifacts??=[];receipt.comparisonArtifacts.push({label,geometry:geometryFile,reference:referenceFile,diagnostics:diagnosticsFile});
    const capture=await captureOwnedWindow(label,geometry,directory,root);
    let comparison,order;const attempts=[];
    for(const candidate of ['BGRA','RGBA']){
      try{comparison=inspectComposedNative(capture,bounds.rectangle,geometry.childRect,reference,candidate);order=candidate;attempts.push({channelOrder:candidate,passed:true,...comparison});break;}
      catch(error){attempts.push({channelOrder:candidate,passed:false,error:error.message,...error.diagnostics});}
    }
    await fs.writeFile(diagnosticsFile,JSON.stringify({passed:!!comparison,geometry,captureBounds:bounds,capture:capture.evidence,reference:referenceEvidence,attempts},null,2),{flag:'wx'});
    if(!comparison)failEvidence('The native window pixel comparison failed; preserved geometry, BMP and channel-error diagnostics require review.',
      {geometryFile,referenceFile,diagnosticsFile,captureBounds:bounds,attempts});
    return {...comparison,geometry,captureBounds:bounds,channelOrder:order,capture:capture.evidence,reference:referenceEvidence};
  };
  const composition=await compare('detached-visible');
  const beforeClose=await viewer.status(),owner=workbench.consoleControl.status().owner;
  assert(Number.isSafeInteger(beforeClose.windowCloseRevision),'Native close revision was unavailable');
  await controlOwnedDetached(root,pid,'close');
  const hidden=await waitDetachedStatus(value=>value.connected===true&&value.windowVisible===false&&value.windowCloseRevision>beforeClose.windowCloseRevision);
  const hiddenFrame=await workbench.adapter.frame();
  assert(hiddenFrame.bytes.length>=54&&hiddenFrame.sequence>=1&&hidden.inputOwner===owner&&workbench.consoleControl.status().owner===owner,'Native window close lost its decoded frame or input owner');
  const hiddenReference=path.join(directory,'hidden-session-decoded.bmp');await fs.writeFile(hiddenReference,hiddenFrame.bytes,{flag:'wx'});
  const userClose={windowHidden:true,sessionConnected:true,frameAvailable:true,agentFrameApiAvailable:true,agentInputNotExercised:true,
    ownerUnchanged:true,windowCloseRevisionAdvanced:true,beforeRevision:beforeClose.windowCloseRevision,afterRevision:hidden.windowCloseRevision,
    hiddenCapture:{file:hiddenReference,width:hiddenFrame.width,height:hiddenFrame.height,sequence:hiddenFrame.sequence,sha256:createHash('sha256').update(hiddenFrame.bytes).digest('hex')}};
  const reopened=await viewer.perform({action:'visible',visible:true});
  assert(reopened.windowVisible===true&&reopened.workbenchWindowHwnd===root&&viewer.native.worker.pid===pid&&reopened.inputOwner===owner,'Showing the hidden Workbench replaced its session or owner');
  await delay(250);const reopenedComposition=await compare('detached-reopened');
  const oldWidth=initial.windowRect.right-initial.windowRect.left,oldHeight=initial.windowRect.bottom-initial.windowRect.top;
  const requested={width:Math.max(640,oldWidth-80),height:Math.max(480,oldHeight-60)};
  const resizeOperation=await controlOwnedDetached(root,pid,'resize',requested.width,requested.height);await delay(250);
  const resized=await inspect(child,root);validateDetachedGeometry(resized,root,pid);
  receipt.detachedResizeAttempt={requested,operation:resizeOperation,geometry:resized};
  await fs.writeFile(path.join(directory,'detached-resize-geometry.json'),JSON.stringify(receipt.detachedResizeAttempt,null,2),{flag:'wx'});
  const actual={width:resized.windowRect.right-resized.windowRect.left,height:resized.windowRect.bottom-resized.windowRect.top};
  if(actual.width!==requested.width||actual.height!==requested.height)failEvidence(
    `The normal native window did not resize: requested ${requested.width}x${requested.height}, actual ${actual.width}x${actual.height} physical pixels.`,receipt.detachedResizeAttempt);
  const resizedComposition=await compare('detached-resized');
  return {passed:true,detached:true,workbenchWindowHwnd:root,...identity,composition,userClose,
    reopened:{windowVisible:true,sameWindowHwnd:true,sameHelperPid:true,ownerUnchanged:true,compositionPassed:true,composition:reopenedComposition},
    resized:{geometryVerified:true,requested,geometry:resized,compositionPassed:true,composition:resizedComposition},
    limitation:'Actual composed native-window pixels; no physical input-to-photon or clipboard claim.'};
}
const waitExit=async worker=>{
  if(worker.exitCode!==null)return {exited:true,exitCode:worker.exitCode};
  return Promise.race([new Promise(resolve=>worker.once('exit',code=>resolve({exited:true,exitCode:code}))),delay(6000).then(()=>({exited:false}))]);
};
app.whenReady().then(async()=>{
  receipt.gpuFeatureStatus=app.getGPUFeatureStatus();
  watchdog=setTimeout(()=>{receipt.error='Integration probe exceeded its bounded lifetime.';void finish(1)},70000);
  const [{WorkbenchNativeSurface},{WorkbenchConsoleControl}]=await Promise.all([
    import(pathToFileURL(path.join(repo,'desktop/workbench-native-surface.mjs')).href),
    import(pathToFileURL(path.join(repo,'lib/workbench-console-control.mjs')).href)]);
  if(wakeDisplay){
    const profile=option('profile-dir')||path.join(app.getPath('appData'),'Relay');
    const runtimeBytes=await fs.readFile(path.join(profile,'desktop-runtime.json'));
    assert(runtimeBytes.length<=65536,'Desktop runtime identity exceeded its bound');
    const runtime=JSON.parse(runtimeBytes.toString('utf8'));
    assert(path.isAbsolute(runtime.executable||''),'The actual Workbench executable identity is unavailable');
    const appDirectory=option('app-dir')||path.join(path.dirname(runtime.executable),'resources','app');
    const [{connectBrowserCLI},{OwnershipGuard}]=await Promise.all([
      import(pathToFileURL(path.join(appDirectory,'lib/browser-cli.mjs')).href),
      import(pathToFileURL(path.join(repo,'verification/measure-workbench-native-session.mjs')).href)]);
    const {request}=await connectBrowserCLI({'profile-dir':profile},{expectedExecutable:runtime.executable,
      fetchImpl:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(15000)})});
    globalOwnership=new OwnershipGuard(request,async()=>{await viewer?.close().catch(()=>{})},100);
    await globalOwnership.start();globalOwnership.assert();
  }
  const consoleControl=new WorkbenchConsoleControl();
  const workbench={config:{vmName:option('vm-name')||'BLACKICE-Workbench'},consoleControl,
    setGuestConsoleOwnershipHook:hook=>consoleControl.setTransitionHook(hook),
    setGuestNativeConsoleAdapter:adapter=>consoleControl.serialize(()=>{workbench.adapter=adapter})};
  parent=new BrowserWindow({show:false,width:1000,height:800,...(visibleComposition?{frame:false,focusable:false,alwaysOnTop:false,skipTaskbar:true}:{}),
    backgroundColor:'#13ad47',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await parent.loadURL('data:text/html,'+encodeURIComponent('<title>Isolated native VM composition test</title><style>html,body{margin:0;width:100%;height:100%;background:#13ad47}</style>'));
  const probeAcceptance=await isolatedAcceptanceEnvironment(output);receipt.isolatedAcceptance=probeAcceptance.evidence;
  viewer=new WorkbenchNativeSurface({appDirectory:repo,resourcesDirectory:process.resourcesPath,isPackaged:false,
    getWorkbench:()=>workbench,getWindow:()=>parent,allowUnacceptedProbe:true,detachedWindow:detachedProbe,env:probeAcceptance.env,
    scaleFactor:host=>screen.getDisplayMatching(host.getBounds()).scaleFactor*host.webContents.getZoomFactor(),
    contentScaleFactor:host=>host.webContents.getZoomFactor()});
  await viewer.bindWorkbench();receipt.gate=await viewer.capability();
  const parentHandle=parent.getNativeWindowHandle().readBigUInt64LE().toString();
  receipt.before=await inspect('0',parentHandle);
  foregroundObserver=await observeForeground(receipt.before.foreground,parentHandle);
  const attached=await viewer.perform(detachedProbe?{action:'attach',timeoutMs:10000}:{action:'attach',bounds:{x:10,y:20,width:640,height:480},timeoutMs:10000},parent);
  receipt.attached=attached;assert(attached.displayReady,'No verified native decoded frame');
  foregroundObserver.addOwnedProcess(viewer.native.worker.pid);
  await runExplicitProbeWake({enabled:wakeDisplay,guard:globalOwnership,workbench,viewer,record:receipt,initial:attached});
  receipt.build={helperSha256:viewer.build.helperSha256,runtimeManifestSha256:viewer.build.runtimeManifestSha256};
  const native=viewer.native,worker=native.worker;
  const frame=await workbench.adapter.frame();receipt.frame={width:frame.width,height:frame.height,sequence:frame.sequence,bytes:frame.bytes.length,contentType:frame.contentType};
  assert(frame.bytes.length>=54&&frame.sequence>=1,'Explicit native backend frame was unavailable');
  if(detachedProbe){
    receipt.detachedPresentation=await proveDetachedPresentation(workbench,attached);
    assert(receipt.detachedPresentation.passed,'Detached native composition did not pass');
    receipt.resized=receipt.detachedPresentation.resized.geometry;
  }else{
    receipt.embedded=await inspect(attached.childHwnd,parentHandle);
    assert(receipt.embedded.actualParent===parentHandle,'Native HWND was not a child of the hidden Electron parent');
    assert((receipt.embedded.childStyle&0x40000000)!==0,'Native HWND is not WS_CHILD');
    assert(receipt.embedded.parentVisible===false&&receipt.embedded.childVisible===false,'The isolated test parent became visible');
    await viewer.perform({action:'bounds',bounds:{x:30,y:40,width:800,height:600}},parent);
    receipt.resized=await inspect(attached.childHwnd,parentHandle);
    const factor=screen.getDisplayMatching(parent.getBounds()).scaleFactor*parent.webContents.getZoomFactor();
    receipt.displayScaleFactor=screen.getDisplayMatching(parent.getBounds()).scaleFactor;
    receipt.zoomFactor=parent.webContents.getZoomFactor();receipt.physicalViewportScale=factor;
    assert(receipt.resized.width===Math.round(800*factor)&&receipt.resized.height===Math.round(600*factor),'Native DIP-to-physical resize did not match');
    receipt.hidden=await viewer.perform({action:'visible',visible:false});assert(receipt.hidden.shown===false,'Hide was not acknowledged');
    receipt.shown=await viewer.perform({action:'visible',visible:true});assert(receipt.shown.displayReady&&receipt.shown.shown,'Show lost its native frame');
  }
  assert(consoleControl.status().owner==='agent','Probe changed the existing input owner');
  receipt.closed=await viewer.close();receipt.explicitClose=await waitExit(worker);assert(receipt.explicitClose.exited,'Explicit close left the helper running');
  const second=await viewer.perform(detachedProbe?{action:'attach',timeoutMs:10000}:{action:'attach',bounds:{x:0,y:0,width:640,height:480},timeoutMs:10000},parent);
  foregroundObserver.addOwnedProcess(viewer.native.worker.pid);
  assert(second.displayReady,'Second independent native session did not decode a frame');
  const orphanWorker=viewer.native.worker;parent.destroy();receipt.parentDestroyed=true;
  if(detachedProbe){
    await delay(250);
    receipt.anchorClose=await verifyDetachedAnchorSurvival({viewer,workbench,worker:orphanWorker,windowHwnd:second.workbenchWindowHwnd,
      owner:consoleControl.status().owner,assertCurrent:()=>globalOwnership?.assert()});
    const anchorState=await inspect('0',parentHandle);assert(!anchorState.parentAlive,'The launcher anchor HWND was not destroyed');
    receipt.anchorClose.anchorDestroyed=true;
    receipt.anchorClose.geometry=await inspect(second.childHwnd,second.workbenchWindowHwnd);
    validateDetachedGeometry(receipt.anchorClose.geometry,second.workbenchWindowHwnd,orphanWorker.pid);
    receipt.sessionClosed=await viewer.destroy();receipt.sessionClose=await waitExit(orphanWorker);
    assert(receipt.sessionClose.exited,'Explicit session destruction left the detached helper running');
  }else{
    receipt.parentClose=await waitExit(orphanWorker);assert(receipt.parentClose.exited,'Parent destruction left an orphan helper');
  }
  receipt.after=await inspect(second.childHwnd,detachedProbe?second.workbenchWindowHwnd:parentHandle);
  assert(!receipt.after.childAlive&&!receipt.after.parentAlive,'Destroyed parent/child HWND remained alive');
  receipt.noForegroundChangeAtCheckpoints=[receipt.embedded,receipt.resized,receipt.after].filter(Boolean).every(value=>value.foreground===receipt.before.foreground);
  receipt.inputOwner=consoleControl.status().owner;receipt.passed=true;await finish(0);
}).catch(async error=>{receipt.error=String(error.message||error).slice(0,600);receipt.code=error.code;if(error.diagnostics)receipt.comparisonFailure=error.diagnostics;await finish(1)});
async function finish(code){
  if(finishing)return;finishing=true;
  clearTimeout(watchdog);try{await viewer?.destroy()}catch(error){receipt.cleanupError=error.message;code=1}
  if(globalOwnership){await globalOwnership.stop();receipt.actualOwnershipGuard={revision:globalOwnership.revision,cancelled:!!globalOwnership.lost};
    if(globalOwnership.lost){receipt.error||='Actual Workbench ownership changed during the probe.';receipt.passed=false;code=1;}}
  if(parent&&!parent.isDestroyed())parent.destroy();
  if(foregroundObserver){await foregroundObserver.stop();receipt.foregroundSampling=foregroundObserver.result;
    receipt.noForegroundChangeThroughout=receipt.foregroundSampling.unchanged;
    const checkpoints=[receipt.before,receipt.embedded,receipt.detachedPresentation?.composition?.geometry,receipt.resized,receipt.after].filter(Boolean);
    receipt.noOwnedForegroundActivation=receipt.foregroundSampling.noOwnedForegroundActivation&&checkpoints.every(value=>
      !receipt.foregroundSampling.ownedProcessIds.includes(value.foregroundPid));
    if(!receipt.noOwnedForegroundActivation){receipt.error||='The probe observed owned foreground activation or could not verify its foreground samples.';receipt.passed=false;code=1;}}
  await fs.mkdir(path.dirname(output),{recursive:true});const temporary=output+'.'+process.pid+'.tmp';
  const handle=await fs.open(temporary,'wx');
  try{await handle.writeFile(JSON.stringify(receipt,null,2));await handle.sync()}finally{await handle.close()}
  await fs.rename(temporary,output);
  app.exit(code);
}
}
}
