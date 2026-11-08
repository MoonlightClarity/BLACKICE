// Hidden-only, read-only RDP lifecycle proof. Never shows a test window,
// captures host pixels, sends guest input, wakes a display or transfers control.
const path=require('node:path');
const {createHash}=require('node:crypto');
const {isProbeEntry,isolatedAcceptanceEnvironment,verifyDetachedAnchorSurvival}=require('./probe-workbench-native-electron.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const assert=(condition,message)=>{if(!condition)throw Error(message)};
function validateHiddenWindow(value,{root,child,pid}){
  assert(value?.rootAlive===true&&value.childAlive===true&&value.rootPid===pid&&value.childPid===pid&&
    value.actualParent===root&&value.root===root&&value.child===child&&value.rootVisible===false&&value.childVisible===false&&
    value.rootTopmost===false&&value.childStyleIsChild===true,'The isolated native window was not an owned hidden detached viewport.');
  return {ownedWindowVerified:true,windowHidden:true,notTopmost:true};
}
function validateHiddenStatus(value,expectedRoot){
  assert(value?.detached===true&&value.connected===true&&value.displayReady===true&&value.windowVisible===false&&
    value.inputOwner==='agent'&&value.inputSequence===0&&value.wakeRequests===0&&(!expectedRoot||value.workbenchWindowHwnd===expectedRoot),
    'The hidden native session lost its decoded display, hidden state, root identity or agent owner.');
  return value;
}
async function readHiddenNativeControls({viewer,worker,root,child,assertCurrent=()=>{}}){
  const native=viewer.native;
  assertCurrent();assert(native&&native.worker===worker&&Number.isSafeInteger(worker?.pid)&&worker.pid>0&&
    worker.exitCode===null&&!worker.killed,'The raw native controls worker is not current.');
  const raw=validateHiddenStatus(await native.status(),root);assertCurrent();
  assert(viewer.native===native&&native.worker===worker&&worker.exitCode===null&&!worker.killed&&
    raw.childHwnd===child&&raw.uncertain!==true&&raw.cached!==true&&raw.controls?.available===true,
    'The exact hidden native helper did not prove raw toolbar availability.');
  return {controls:structuredClone(raw.controls),sameNativeInstanceVerified:true,helperPid:worker.pid,
    workbenchWindowHwnd:root,childHwnd:child};
}
async function proveHiddenClose({viewer,workbench,postClose,assertCurrent=()=>{},pause=ms=>new Promise(r=>setTimeout(r,ms))}){
  assertCurrent();const before=validateHiddenStatus(await viewer.status());assertCurrent();
  const worker=viewer.native.worker,root=before.workbenchWindowHwnd;
  await postClose(root,worker.pid);assertCurrent();let after;
  for(let attempt=0;attempt<30;attempt++){
    after=validateHiddenStatus(await viewer.status(),root);assertCurrent();
    if(after.windowCloseRevision>before.windowCloseRevision)break;
    await pause(100);
  }
  assert(after.windowCloseRevision>before.windowCloseRevision,'Hidden WM_CLOSE did not advance the native close receipt.');
  const retained=await verifyDetachedAnchorSurvival({viewer,workbench,worker,windowHwnd:root,owner:'agent',assertCurrent});
  assert(retained.windowVisible===false,'WM_CLOSE showed the hidden native root.');
  return {windowNeverShown:true,networkConnected:true,frameAvailable:true,agentFrameApiAvailable:true,ownerUnchanged:true,
    sameHelperPid:true,sameWindowHwnd:true,closeRevisionAdvanced:true,beforeRevision:before.windowCloseRevision,afterRevision:after.windowCloseRevision,
    frame:retained.frame};
}
module.exports={validateHiddenWindow,validateHiddenStatus,readHiddenNativeControls,proveHiddenClose};

if(isProbeEntry({script:__filename,nodeMain:require.main===module}))void run();
async function run(){
  const {app,BrowserWindow}=require('electron');
  const fs=require('node:fs/promises'),{pathToFileURL}=require('node:url');
  const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
  const execute=promisify(execFile),option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
  const output=option('output'),repo=path.resolve(option('app-root')||path.join(__dirname,'..'));
  if(!output||!path.isAbsolute(output)){process.stderr.write('An absolute fresh --output path is required.\n');app.exit(2);return;}
  const profile=option('profile-dir')||path.join(process.env.APPDATA,'Relay');
  app.on('window-all-closed',()=>{});app.setPath('userData',output+'.profile');
  let viewer,parent,guard,observer,finishing=false;
  const report={schema:1,mode:'hidden-native-lifecycle',at:new Date().toISOString(),passed:false,
    hostInputSent:0,guestInputSent:0,windowShowRequested:false,hostPixelsCaptured:false,presentationCompositionProven:false,
    probeSourceSha256:sha(await fs.readFile(__filename))};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const ps=async code=>{
    const {stdout}=await execute(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],
      {windowsHide:true,timeout:8000,maxBuffer:32768});return JSON.parse(stdout.trim());
  };
  const inspect=(root,child,pid,{close=false}={})=>{
    assert([root,child].every(value=>/^\d{1,20}$/.test(value||''))&&Number.isSafeInteger(pid)&&pid>0,'Invalid owned-window inspection identity.');
    return ps(`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class HiddenProbeWin32 {
[DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]public static extern IntPtr GetParent(IntPtr h);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetStyle(IntPtr h,int i);
[DllImport("user32.dll")]public static extern bool PostMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
$root=[IntPtr]::new([long]${root});$child=[IntPtr]::new([long]${child});$rp=[uint32]0;$cp=[uint32]0
[void][HiddenProbeWin32]::GetWindowThreadProcessId($root,[ref]$rp);[void][HiddenProbeWin32]::GetWindowThreadProcessId($child,[ref]$cp)
${close?`if($rp -ne ${pid} -or $cp -ne ${pid} -or [HiddenProbeWin32]::IsWindowVisible($root)){throw 'Refusing to post close to an unowned or visible window.'}
if(![HiddenProbeWin32]::PostMessageW($root,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Hidden close could not be posted.'}`:''}
@{root='${root}';child='${child}';rootAlive=[HiddenProbeWin32]::IsWindow($root);childAlive=[HiddenProbeWin32]::IsWindow($child);
rootVisible=[HiddenProbeWin32]::IsWindowVisible($root);childVisible=[HiddenProbeWin32]::IsWindowVisible($child);
rootPid=[int]$rp;childPid=[int]$cp;actualParent=[HiddenProbeWin32]::GetParent($child).ToInt64().ToString();
rootTopmost=([HiddenProbeWin32]::GetStyle($root,-20).ToInt64() -band 8) -ne 0;
childStyleIsChild=([HiddenProbeWin32]::GetStyle($child,-16).ToInt64() -band 0x40000000) -ne 0}|ConvertTo-Json -Compress`);
  };
  const observe=async()=>{
    const script=`Add-Type @'
using System;using System.Runtime.InteropServices;public static class HiddenForegroundRead {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}
'@
$until=[DateTime]::UtcNow.AddSeconds(60);while([DateTime]::UtcNow -lt $until){$h=[HiddenForegroundRead]::GetForegroundWindow();$p=[uint32]0;[void][HiddenForegroundRead]::GetWindowThreadProcessId($h,[ref]$p);[Console]::WriteLine($h.ToInt64().ToString()+':'+$p);[Console]::Out.Flush();Start-Sleep -Milliseconds 20}`;
    const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    const result={intervalMs:20,samples:0,transitions:0,ownedProcessForegroundSamples:0,probeForegroundSamples:0};
    const owned=new Set([process.pid]),seen=new Map();let buffer='',prior=null,stopped=false,readyResolve;
    const ready=new Promise(resolve=>readyResolve=resolve);
    const add=pid=>{if(Number.isSafeInteger(pid)&&pid>0&&!owned.has(pid)){owned.add(pid);result.ownedProcessForegroundSamples+=seen.get(pid)||0}};
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>4096){result.error='Foreground observer exceeded its bound.';child.kill();return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);const value=/^(\d+):(\d+)$/.exec(line);
        if(!value){result.error='Invalid foreground sample.';continue;}const hwnd=value[1],pid=Number(value[2]);add(viewer?.native?.worker?.pid);
        seen.set(pid,(seen.get(pid)||0)+1);result.samples++;if(prior!==null&&hwnd!==prior)result.transitions++;prior=hwnd;
        if(owned.has(pid))result.ownedProcessForegroundSamples++;if(pid===process.pid)result.probeForegroundSamples++;readyResolve();}
    });
    child.once('error',()=>{result.error='Foreground observer failed.';readyResolve()});
    child.once('exit',()=>{if(!stopped){result.error='Foreground observer ended early.';readyResolve()}});
    await Promise.race([ready,delay(5000)]);
    if(result.samples===0||result.error){stopped=true;child.kill();throw Error('The hidden foreground observer did not start.');}
    return {add,result,stop:async()=>{stopped=true;child.kill();await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(1000)]);
      result.ownedProcessIds=[...owned];result.noOwnedForegroundActivation=result.samples>=2&&!result.error&&result.ownedProcessForegroundSamples===0;}};
  };
  // A Node child may finish with a termination signal and leave exitCode=null.
  // The native host has already awaited its exit event; do not misreport a
  // confirmed signaled exit as a still-live helper.
  const exit=async worker=>worker.exitCode!==null||worker.signalCode!==null?
    {exited:true,exitCode:worker.exitCode,signal:worker.signalCode||null,forced:worker.signalCode!==null}:
    Promise.race([
      new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({exited:true,exitCode:code,signal:signal||null,forced:!!signal}))),
      delay(6000).then(()=>({exited:false,exitCode:worker.exitCode,signal:worker.signalCode||null}))]);
  const finish=async code=>{
    if(finishing)return;finishing=true;clearTimeout(watchdog);
    try{await viewer?.destroy()}catch{report.cleanupError='The probe helper did not close cleanly.';report.passed=false;code=1}
    if(parent&&!parent.isDestroyed())parent.destroy();
    if(guard){await guard.stop();report.actualOwnershipGuard={revision:guard.revision,cancelled:!!guard.lost};if(guard.lost){report.passed=false;report.error='Actual guest ownership changed.';code=1}}
    if(observer){await observer.stop();report.foregroundSampling=observer.result;report.noOwnedForegroundActivation=observer.result.noOwnedForegroundActivation;
      if(!report.noOwnedForegroundActivation){report.passed=false;report.error='An owned window became foreground or observation was incomplete.';code=1}}
    try{
      const temporary=output+'.'+process.pid+'.tmp';const handle=await fs.open(temporary,'wx');
      try{await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync()}finally{await handle.close()}
      await fs.rename(temporary,output);process.stdout.write(JSON.stringify({passed:report.passed,mode:report.mode,output,guestInputSent:0,hostInputSent:0})+'\n');
    }catch{code=1;process.stderr.write('The hidden lifecycle receipt could not be saved.\n')}
    app.exit(code);
  };
  const watchdog=setTimeout(()=>{report.error='The hidden lifecycle probe exceeded its bound.';void finish(1)},45000);
  try{
    await fs.mkdir(path.dirname(output),{recursive:true});try{await fs.lstat(output);throw Error('Use a fresh report output.')}catch(error){if(error.code!=='ENOENT')throw error}
    const isolated=await isolatedAcceptanceEnvironment(output);report.isolatedAcceptance=isolated.evidence;
    if(process.argv.includes('--entry-smoke')){report.entrySmoke=true;report.passed=true;report.vmHelperStarted=false;report.windowCreated=false;await app.whenReady();await finish(0);return;}
    const runtimeBytes=await fs.readFile(path.join(profile,'desktop-runtime.json'));assert(runtimeBytes.length<=65536,'Desktop identity exceeds its bound.');
    const runtime=JSON.parse(runtimeBytes);assert(path.isAbsolute(runtime.executable||''),'The actual BLACKICE executable is unavailable.');
    const appDirectory=path.join(path.dirname(runtime.executable),'resources/app');
    const [{connectBrowserCLI},{OwnershipGuard},{WorkbenchNativeSurface},{WorkbenchConsoleControl}]=await Promise.all([
      import(pathToFileURL(path.join(appDirectory,'lib/browser-cli.mjs')).href),import(pathToFileURL(path.join(repo,'verification/measure-workbench-native-session.mjs')).href),
      import(pathToFileURL(path.join(repo,'desktop/workbench-native-surface.mjs')).href),import(pathToFileURL(path.join(repo,'lib/workbench-console-control.mjs')).href)]);
    const {request}=await connectBrowserCLI({'profile-dir':profile},{expectedExecutable:runtime.executable,
      fetchImpl:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});
    guard=new OwnershipGuard(request,async()=>{await viewer?.close().catch(()=>{})},100);await guard.start();const actual=await guard.check();
    const consoleControl=new WorkbenchConsoleControl(),workbench={config:{vmName:actual.vmName},consoleControl,
      setGuestConsoleOwnershipHook:hook=>consoleControl.setTransitionHook(hook),setGuestNativeConsoleAdapter:adapter=>consoleControl.serialize(()=>{workbench.adapter=adapter})};
    await app.whenReady();parent=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:640,height:480,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await parent.loadURL('data:text/html,<title>Hidden Workbench lifecycle anchor</title>');assert(!parent.isVisible(),'The anchor must remain hidden.');
    observer=await observe();
    viewer=new WorkbenchNativeSurface({appDirectory:repo,resourcesDirectory:process.resourcesPath,isPackaged:false,env:isolated.env,
      getWorkbench:()=>workbench,getWindow:()=>parent,detachedWindow:true,allowUnacceptedProbe:true,showOnAttach:false});
    const discover=viewer.discover.bind(viewer);viewer.discover=async()=>{const value=await discover();report.preflight={...value,host:'127.0.0.1',port:2179,vmName:actual.vmName};return value;};
    await viewer.bindWorkbench();guard.assert();report.attached=validateHiddenStatus(await viewer.perform({action:'attach',timeoutMs:10000},parent));guard.assert();
    const worker=viewer.native.worker,root=report.attached.workbenchWindowHwnd,child=report.attached.childHwnd;observer.add(worker.pid);
    report.build={helperSha256:viewer.build.helperSha256,runtimeManifestSha256:viewer.build.runtimeManifestSha256};
    const expected=option('expected-helper-sha256');if(expected)assert(expected===report.build.helperSha256,'The candidate helper binding changed.');
    const buildReceipt=await fs.readFile(path.join(repo,'.build/workbench-freerdp-client-build.json'));report.build.receiptSha256=sha(buildReceipt);report.build.sourceSha256=JSON.parse(buildReceipt).sourceSha256;
    report.window=await inspect(root,child,worker.pid);validateHiddenWindow(report.window,{root,child,pid:worker.pid});
    const controls=await readHiddenNativeControls({viewer,worker,root,child,assertCurrent:()=>guard.assert()});
    report.nativeControls=controls.controls;delete controls.controls;report.nativeControlsIdentity=controls;
    const frame=await workbench.adapter.frame();guard.assert();const framePath=output+'.frame.bmp';await fs.writeFile(framePath,frame.bytes,{flag:'wx'});
    report.frame={file:framePath,width:frame.width,height:frame.height,sequence:frame.sequence,bytes:frame.bytes.length,sha256:sha(frame.bytes),source:'native-decoded-surface'};
    report.hiddenLifecycle=await proveHiddenClose({viewer,workbench,assertCurrent:()=>guard.assert(),postClose:()=>inspect(root,child,worker.pid,{close:true})});
    parent.destroy();report.anchorClose={anchorDestroyed:true,...await verifyDetachedAnchorSurvival({viewer,workbench,worker,windowHwnd:root,owner:'agent',assertCurrent:()=>guard.assert()})};
    report.anchorCloseWindow=await inspect(root,child,worker.pid);validateHiddenWindow(report.anchorCloseWindow,{root,child,pid:worker.pid});
    await guard.check();await viewer.destroy();report.explicitClose=await exit(worker);report.sessionClose={...report.explicitClose,operation:'same explicit probe-session destroy'};
    assert(report.explicitClose.exited,'The hidden helper did not exit.');report.after=await inspect(root,child,worker.pid);
    report.after.parentAlive=report.after.rootAlive;assert(!report.after.rootAlive&&!report.after.childAlive,'An isolated HWND survived explicit cleanup.');
    report.inputOwner=consoleControl.status().owner;report.passed=true;await finish(0);
  }catch(error){report.error=String(error.message||error).slice(0,500);report.passed=false;await finish(1)}
}
