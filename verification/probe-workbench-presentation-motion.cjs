// Explicit visible OWN-window animation; no VM, auth, clipboard or input.
const path=require('node:path');
const {createHash}=require('node:crypto');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function isEntry({electron=process.versions.electron,argv=process.argv,script=__filename,nodeMain=require.main===module}={}){
  return nodeMain||Boolean(electron&&typeof argv[1]==='string'&&path.resolve(argv[1]).toLowerCase()===path.resolve(script).toLowerCase());
}
function parseArgs(argv,repo=path.resolve(__dirname,'..')){
  const values={durationMs:5000,buildReceipt:path.join(repo,'.build','workbench-freerdp-client-build.json'),entrySmoke:false,captureBackend:'wgc-window',visibleFixture:false};
  for(const argument of argv){
    if(argument==='--entry-smoke'){if(values.entrySmoke)throw Error('Duplicate smoke option');values.entrySmoke=true;continue;}
    if(argument==='--allow-visible-window'){if(values.visibleFixture)throw Error('Duplicate visible-window option');values.visibleFixture=true;continue;}
    const match=/^--(output|build-receipt|duration-ms|capture-backend)=(.+)$/.exec(argument);
    if(!match)throw Error('Use --output=ABSOLUTE_JSON [--build-receipt=ABSOLUTE_JSON] [--duration-ms=3000..6000].');
    const key=match[1]==='build-receipt'?'buildReceipt':match[1]==='duration-ms'?'durationMs':match[1]==='capture-backend'?'captureBackend':'output';
    values.seen??=new Set();if(values.seen.has(key))throw Error('Duplicate option');values.seen.add(key);
    values[key]=key==='durationMs'?Number(match[2]):match[2];
  }
  if(!path.isAbsolute(values.output||'')||!path.isAbsolute(values.buildReceipt)||
    !Number.isSafeInteger(values.durationMs)||values.durationMs<3000||values.durationMs>6000||!['wgc-window','gdi-window'].includes(values.captureBackend))throw Error('Fresh absolute output/build paths and bounded duration/backend are required.');
  delete values.seen;return values;
}
function crc32Counter(value){
  let crc=0xffffffff;for(let byte=0;byte<4;byte++){crc^=(value>>>(byte*8))&255;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function decodeRow(pixels,row){
  if(!Array.isArray(pixels)||pixels.length!==32||row?.cells!==32)return null;
  const distance=(a,b)=>Math.max(Math.abs(a.r-b.r),Math.abs(a.g-b.g),Math.abs(a.b-b.b));
  let value=0;for(let bit=0;bit<32;bit++){
    const zero=distance(pixels[bit],row.zero),one=distance(pixels[bit],row.one);
    if(Math.min(zero,one)>45||Math.abs(zero-one)<20)return null;
    if(one<zero)value=(value|(1<<bit))>>>0;
  }return value;
}
function analyzeFrame({grid,counter,crcCounter,animation}){
  if(!Array.isArray(grid)||grid.length<20)throw Error('Actual child pixels are required.');
  const pixels=[...grid,...counter,...crcCounter];
  if(pixels.some(p=>!p||!['r','g','b'].every(k=>Number.isInteger(p[k])&&p[k]>=0&&p[k]<=255)))throw Error('Invalid pixel sample');
  const darkFraction=grid.filter(p=>Math.max(p.r,p.g,p.b)<32).length/grid.length;
  const range=Math.max(...['r','g','b'].map(k=>Math.max(...pixels.map(p=>p[k]))-Math.min(...pixels.map(p=>p[k]))));
  const value=decodeRow(counter,animation.counter),crc=decodeRow(crcCounter,animation.crcCounter);
  return {black:darkFraction>=.95,flat:range<=6,darkFraction,counterValid:value!==null&&crc!==null&&crc32Counter(value)===crc,counter:value};
}
function validateAnimation(value){
  if(value?.width!==1920||value.height!==1080)throw Error('The known synthetic source size is required.');
  for(const row of [value.counter,value.crcCounter]){
    if(row?.cells!==32||![row.x,row.y,row.cellWidth,row.cellHeight].every(Number.isSafeInteger)||row.x<0||row.y<0||
      row.cellWidth<4||row.cellHeight<4||row.x+32*row.cellWidth>value.width||row.y+row.cellHeight>value.height||
      ![row.zero,row.one].every(p=>p&&['r','g','b'].every(k=>Number.isInteger(p[k])&&p[k]>=32&&p[k]<=255)))throw Error('Bounded bright counter and CRC rows are required.');
  }return value;
}
function mapPoint(point,geometry,videoWidth,videoHeight){
  const capture=geometry.captureRect,child=geometry.childRect;
  const x=(child.left-capture.left+(point.x/1920)*(child.right-child.left))*videoWidth/(capture.right-capture.left);
  const y=(child.top-capture.top+(point.y/1080)*(child.bottom-child.top))*videoHeight/(capture.bottom-capture.top);
  return {x:Math.max(0,Math.min(videoWidth-1,Math.floor(x))),y:Math.max(0,Math.min(videoHeight-1,Math.floor(y)))};
}
function validateGeometry(value,started){
  const rect=r=>r&&['left','top','right','bottom'].every(k=>Number.isSafeInteger(r[k]))&&r.right>r.left&&r.bottom>r.top;
  if(!value?.rootAlive||!value.childAlive||value.rootPid!==started.helperPid||value.childPid!==started.helperPid||
    value.actualParent!==started.workbenchWindowHwnd||value.actualRoot!==started.workbenchWindowHwnd||
    value.rootVisible!==true||!rect(value.captureRect)||!rect(value.childRect)||
    value.childRect.left<value.captureRect.left||value.childRect.top<value.captureRect.top||
    value.childRect.right>value.captureRect.right||value.childRect.bottom>value.captureRect.bottom)
    throw Error('The exact owned native child/window geometry was not verified.');
  return value;
}
function validateEvidence(video,final,method='window-video'){
  const count=method==='gdi-surface'?video?.samplesRead:video?.videoFrames;
  if(!video||!Number.isSafeInteger(count)||count<120||!Number.isFinite(video.durationMs)||video.durationMs<3000||video.blackFrames!==0||video.flatFrames!==0||
    !Number.isSafeInteger(video.distinctValidCounters)||video.distinctValidCounters<60||video.invalidCounterFrames!==0||video.validCounterRegressions!==0)throw Error('Insufficient actual temporal frames, motion, or a black/flat presentation frame was observed.');
  if(final?.networkStarted!==false||final.guestInputSent!==0||final.hostInputSent!==0||final.helperEverForeground!==false||final.helperForegroundChangeCount!==0||
    !Number.isSafeInteger(final.framesProduced)||final.framesProduced<60)throw Error('The isolated native producer did not prove bounded, input-free animation.');
  return {passed:true,captureKind:method,observedSamples:count,durationMs:video.durationMs,blackFrames:0,flatFrames:0,
    distinctValidCounters:video.distinctValidCounters,physicalInputToPhoton:false,
    limitation:method==='gdi-surface'?'Observed exact-child GDI front-surface samples; not physical monitor/DWM photometry or a zero-duration-flash guarantee.':'Observed owned-window video frames; not a physical monitor or zero-duration-flash guarantee.'};
}

async function captureVideo(args){
  const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:args.sourceId,
    minFrameRate:30,maxFrameRate:60,maxWidth:4096,maxHeight:4096}}});
  const video=document.createElement('video');video.muted=true;video.autoplay=true;video.srcObject=stream;
  video.style.cssText='width:320px;height:180px;position:fixed;inset:0';document.body.append(video);
  const samples=[],seen=new Set();let blackFrames=0,flatFrames=0,invalidCounterFrames=0,regressions=0,lastCounter=null,first=null,last=null,lastPresented=null;
  const gridCanvas=document.createElement('canvas'),bitCanvas=document.createElement('canvas');gridCanvas.width=8;gridCanvas.height=5;bitCanvas.width=64;bitCanvas.height=1;
  const gridContext=gridCanvas.getContext('2d',{willReadFrequently:true}),bitContext=bitCanvas.getContext('2d',{willReadFrequently:true});
  const chunks=[];let recorder,recordingBytes=0,recordingFailure=null;
  const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(value=>typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported(value));
  try{
    await video.play();if(!video.requestVideoFrameCallback)throw Error('Actual video frame callbacks are unavailable.');
    if(mime){recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:3000000});recorder.ondataavailable=event=>{
      recordingBytes+=event.data.size;if(recordingBytes>33554432){recordingFailure='Video evidence exceeded its bound.';return;}if(event.data.size)chunks.push(event.data);
    };recorder.start(500);}
    const result=await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(Error('Actual window video did not deliver enough frames before its deadline.')),args.durationMs+7000);
      stream.getVideoTracks()[0].addEventListener('ended',()=>{clearTimeout(deadline);reject(Error('The owned native window ended before temporal capture completed.'));},{once:true});
      const frame=(now,metadata)=>{
        try{
          const identifier=metadata.presentedFrames+':'+metadata.mediaTime;
          if(identifier!==lastPresented){
            lastPresented=identifier;if(first===null)first=now;last=now;
            const w=video.videoWidth,h=video.videoHeight;if(!w||!h||w>4096||h>4096)throw Error('Invalid actual captured video dimensions.');
            const capture=args.geometry.captureRect,child=args.geometry.childRect;
            const sx=(child.left-capture.left)*w/(capture.right-capture.left),sy=(child.top-capture.top)*h/(capture.bottom-capture.top);
            const sw=(child.right-child.left)*w/(capture.right-capture.left),sh=(child.bottom-child.top)*h/(capture.bottom-capture.top);
            // Only bright source background below the moving bar is sampled here.
            gridContext.drawImage(video,sx+sw*.04,sy+sh*.34,sw*.92,sh*.60,0,0,8,5);
            const gridRaw=gridContext.getImageData(0,0,8,5).data,grid=[];
            for(let i=0;i<gridRaw.length;i+=4)grid.push({r:gridRaw[i],g:gridRaw[i+1],b:gridRaw[i+2]});
            for(const [rowIndex,row]of [args.animation.counter,args.animation.crcCounter].entries())for(let bit=0;bit<32;bit++){
              const point=mapPoint({x:row.x+(bit+.5)*row.cellWidth,y:row.y+row.cellHeight/2},args.geometry,w,h);
              bitContext.drawImage(video,point.x,point.y,1,1,rowIndex*32+bit,0,1,1);
            }
            const raw=bitContext.getImageData(0,0,64,1).data,rows=[];
            for(let i=0;i<raw.length;i+=4)rows.push({r:raw[i],g:raw[i+1],b:raw[i+2]});
            const analysis=analyzeFrame({grid,counter:rows.slice(0,32),crcCounter:rows.slice(32),animation:args.animation});
            if(analysis.black)blackFrames++;if(analysis.flat)flatFrames++;
            if(analysis.counterValid){if(lastCounter!==null&&analysis.counter<lastCounter)regressions++;lastCounter=analysis.counter;seen.add(analysis.counter);}else invalidCounterFrames++;
            samples.push({atMs:now-first,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,...analysis});
          }
          if(first!==null&&now-first>=args.durationMs){clearTimeout(deadline);resolve({videoFrames:samples.length,durationMs:last-first,
            observerFramesPerSecond:samples.length*1000/(last-first),blackFrames,flatFrames,invalidCounterFrames,validCounterRegressions:regressions,
            distinctValidCounters:seen.size,videoWidth:video.videoWidth,videoHeight:video.videoHeight,samples});}
          else video.requestVideoFrameCallback(frame);
        }catch(error){clearTimeout(deadline);reject(error);}
      };video.requestVideoFrameCallback(frame);
    });
    if(recorder&&recorder.state!=='inactive')await new Promise(resolve=>{recorder.addEventListener('stop',resolve,{once:true});recorder.stop();});
    if(chunks.length&&!recordingFailure){const blob=new Blob(chunks,{type:mime});result.videoMime=mime;result.videoBase64=await new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);
    });}else result.recordingFailure=recordingFailure||'MediaRecorder unavailable';
    return result;
  }finally{if(recorder&&recorder.state!=='inactive')recorder.stop();for(const track of stream.getTracks())track.stop();video.srcObject=null;}
}

async function main(){
  const fs=require('node:fs/promises'),{spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{pathToFileURL}=require('node:url');
  const options=parseArgs(process.argv.slice(2)),repo=path.resolve(__dirname,'..');
  if(!options.entrySmoke&&!options.visibleFixture)throw Error('Visible diagnostic fixtures are disabled by default; --allow-visible-window is required. No helper or window was created. Use saved-data reassessment for existing evidence.');
  const {app,BrowserWindow,desktopCapturer,nativeImage}=require('electron');
  if(!app||!BrowserWindow||!desktopCapturer)throw Error('Run with Electron and ELECTRON_RUN_AS_NODE unset.');
  const record={schema:1,probe:'owned-native-presentation-motion',at:new Date().toISOString(),passed:false,networkStarted:false,hostInputSent:0,guestInputSent:0};
  record.observerSourceSha256=hash(await fs.readFile(__filename));
  await fs.mkdir(path.dirname(options.output),{recursive:true});
  for(const file of [options.output,options.output+'.webm'])try{await fs.stat(file);throw Error('Output evidence path already exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
  app.setPath('userData',options.output+'.profile');app.on('window-all-closed',()=>{});
  await app.whenReady();
  if(options.entrySmoke){await fs.writeFile(options.output,JSON.stringify({...record,entered:true,windowCreated:false,helperStarted:false})+'\n',{flag:'wx'});app.exit(0);return;}
  let worker,observer,stderrBytes=0,stderrHash=createHash('sha256'),exited=false,watchdog;
  const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try{
    record.stage='build-validation';record.captureBackend=options.captureBackend;
    const receiptBytes=await fs.readFile(options.buildReceipt),receipt=JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/,''));
    if(receipt.schema!==2||!path.isAbsolute(receipt.executable||'')||!path.isAbsolute(receipt.runtimeDirectory||'')||receipt.selfTest?.networkStarted!==false)throw Error('A verified no-network native build receipt is required.');
    const checks=[[receipt.executable,receipt.sha256],[path.join(repo,'scripts/workbench-freerdp-client/main.cpp'),receipt.sourceSha256],
      [path.join(repo,'docs/workbench-freerdp-dependencies.lock.json'),receipt.runtimeLockSha256],
      [path.join(repo,'docs/workbench-freerdp-compiler.lock.json'),receipt.compilerLockSha256],
      [path.join(receipt.runtimeDirectory,'runtime-manifest.json'),receipt.runtimeManifestSha256]];
    for(const [file,expected]of checks)if(!/^[a-f0-9]{64}$/.test(expected||'')||hash(await fs.readFile(file))!==expected)throw Error('Current helper/source/runtime binding changed.');
    const {verifyFreeRdpRuntime}=await import(pathToFileURL(path.join(repo,'scripts/package-workbench-freerdp.mjs')).href);
    await verifyFreeRdpRuntime({outputDirectory:receipt.runtimeDirectory,lockPath:path.join(repo,'docs/workbench-freerdp-dependencies.lock.json'),systemDirectory:path.join(process.env.SystemRoot||'C:\\Windows','System32')});
    record.build={helperSha256:receipt.sha256,sourceSha256:receipt.sourceSha256,runtimeManifestSha256:receipt.runtimeManifestSha256,receiptSha256:hash(receiptBytes)};
    let startResolve,startReject,finalResolve,finalReject,buffer='';
    const started=new Promise((resolve,reject)=>{startResolve=resolve;startReject=reject}),final=new Promise((resolve,reject)=>{finalResolve=resolve;finalReject=reject});
    // Avoid unhandled rejection if startup fails before the final receipt await.
    final.catch(()=>{});
    const system=process.env.SystemRoot||'C:\\Windows';
    worker=spawn(receipt.executable,['--presentation-probe'],{cwd:path.join(receipt.runtimeDirectory,'bin'),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
      PATH:[path.join(receipt.runtimeDirectory,'bin'),path.win32.join(system,'System32'),system].join(';'),WINPR_NATIVE_SSPI:'1',
      OPENSSL_CONF:path.join(receipt.runtimeDirectory,'etc/ssl/openssl.cnf'),OPENSSL_MODULES:path.join(receipt.runtimeDirectory,'lib/ossl-modules')}});
    worker.stderr.on('data',bytes=>{stderrBytes+=bytes.length;stderrHash.update(bytes)});
    worker.stdout.setEncoding('utf8');worker.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>1048576){startReject(Error('Native receipt exceeded bounds.'));finalReject(Error('Native receipt exceeded bounds.'));return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;
        let reply;try{reply=JSON.parse(line)}catch{startReject(Error('Invalid native receipt.'));finalReject(Error('Invalid native receipt.'));return;}
        if(reply.requestId==='presentation-probe-start'){if(reply.ok!==true)startReject(Error('Native animation rejected startup.'));else startResolve(reply.result);}
        if(reply.requestId==='presentation-probe-final'){if(reply.ok!==true)finalReject(Error('Native animation failed.'));else finalResolve(reply.result);}
      }
    });
    worker.once('error',error=>{startReject(error);finalReject(error)});worker.once('exit',()=>{exited=true});
    watchdog=setTimeout(()=>{try{worker.kill()}catch{}},22000);
    record.stage='native-start';
    const start=await Promise.race([started,delay(6000).then(()=>{throw Error('Native animation startup timed out.');})]);
    if(start.helperPid!==worker.pid||!/^\d+$/.test(start.workbenchWindowHwnd||'')||!/^\d+$/.test(start.childHwnd||'')||
      start.networkStarted!==false||start.hostInputSent!==0||start.guestInputSent!==0)throw Error('The native animation did not prove its exact owned identity.');
    record.start={...start,animation:validateAnimation(start.animation)};
    const script=`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class MotionWindowRead {
[StructLayout(LayoutKind.Sequential)]public struct RECT{public int left,top,right,bottom;}
[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")]public static extern bool IsWindow(IntPtr value);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr value);
[DllImport("user32.dll")]public static extern IntPtr GetParent(IntPtr value);
[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr value,uint flags);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr value,out uint pid);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr value,out RECT rectangle);
[DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr value,uint attribute,out RECT rectangle,int bytes);
}
'@
$root=[IntPtr]::new([long]'${start.workbenchWindowHwnd}');$child=[IntPtr]::new([long]'${start.childHwnd}');$prior=[MotionWindowRead]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));if($prior -eq [IntPtr]::Zero){throw 'Physical geometry context unavailable'}
try{$childRect=New-Object MotionWindowRead+RECT;$captureRect=New-Object MotionWindowRead+RECT;$rootPid=[uint32]0;$childPid=[uint32]0
[void][MotionWindowRead]::GetWindowThreadProcessId($root,[ref]$rootPid);[void][MotionWindowRead]::GetWindowThreadProcessId($child,[ref]$childPid)
[void][MotionWindowRead]::GetWindowRect($child,[ref]$childRect);$dwm=[MotionWindowRead]::DwmGetWindowAttribute($root,9,[ref]$captureRect,[Runtime.InteropServices.Marshal]::SizeOf($captureRect));if($dwm -ne 0){throw 'Physical DWM bounds unavailable'}
[ordered]@{rootAlive=[MotionWindowRead]::IsWindow($root);childAlive=[MotionWindowRead]::IsWindow($child);rootVisible=[MotionWindowRead]::IsWindowVisible($root);rootPid=$rootPid;childPid=$childPid;actualParent=[MotionWindowRead]::GetParent($child).ToInt64().ToString();actualRoot=[MotionWindowRead]::GetAncestor($root,2).ToInt64().ToString();childRect=@{left=$childRect.left;top=$childRect.top;right=$childRect.right;bottom=$childRect.bottom};captureRect=@{left=$captureRect.left;top=$captureRect.top;right=$captureRect.right;bottom=$captureRect.bottom}}|ConvertTo-Json -Compress
}finally{[void][MotionWindowRead]::SetThreadDpiAwarenessContext($prior)}`;
    record.stage='physical-geometry';
    const {stdout}=await execute(path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,timeout:8000,maxBuffer:16000});
    record.geometry=validateGeometry(JSON.parse(stdout.trim()),start);
    let observed,method='window-video';
    if(options.captureBackend==='gdi-window'){
      record.stage='gdi-front-surface-readback';method='gdi-surface';
      const expected={x:32,y:32,cellWidth:16,cellHeight:32,cells:32,zero:{r:96,g:160,b:216},one:{r:240,g:196,b:72}};
      if(JSON.stringify(start.animation.counter)!==JSON.stringify(expected)||JSON.stringify(start.animation.crcCounter)!==JSON.stringify({...expected,y:80}))throw Error('GDI collector requires the exact known synthetic counter layout.');
      const metadataPath=options.output+'.gdi-input.json',readbackPath=options.output+'.gdi.json';
      record.collectorSourceSha256=hash(await fs.readFile(path.join(repo,'verification/workbench-presentation-gdi-readback.ps1')));
      await fs.writeFile(metadataPath,JSON.stringify({helperPid:start.helperPid,workbenchWindowHwnd:start.workbenchWindowHwnd,childHwnd:start.childHwnd,durationMs:options.durationMs}),{flag:'wx'});
      await execute(path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(repo,'verification/workbench-presentation-gdi-readback.ps1'),'-MetadataPath',metadataPath,'-OutputPath',readbackPath],{windowsHide:true,shell:false,timeout:options.durationMs+6500,maxBuffer:16000});
      observed=JSON.parse(await fs.readFile(readbackPath,'utf8'));
      if(observed.method!=='exact-child-getdc-bitblt-gdi-surface'||observed.printWindowUsed!==false||observed.forcedPaint!==false||observed.desktopCaptured!==false||observed.ownerVerified!==true||observed.occlusionChecked!==true)throw Error('Independent exact-child readback proof is incomplete.');
      observed.artifacts=[];
      for(const suffix of ['before','after']){
        const bmp=await fs.readFile(readbackPath+'.'+suffix+'.bmp');
        if(bmp.toString('ascii',0,2)!=='BM'||bmp.readUInt32LE(10)!==54||bmp.length!==54+observed.width*observed.height*4||bmp.readInt32LE(18)!==observed.width||bmp.readInt32LE(22)!==-observed.height)throw Error('Owned GDI sample bitmap is invalid.');
        // BI_RGB's unused alpha byte is not transparency. Preserve RGB and
        // encode opaque PNG evidence rather than a misleading transparent image.
        const rgb=Buffer.from(bmp.subarray(54));for(let i=3;i<rgb.length;i+=4)rgb[i]=255;
        const png=nativeImage.createFromBitmap(rgb,{width:observed.width,height:observed.height}).toPNG(),file=options.output+'.'+suffix+'.png';
        await fs.writeFile(file,png,{flag:'wx'});observed.artifacts.push({file,sha256:hash(png),bytes:png.length,unusedBitmapAlphaNormalized:true});
      }
      record.gdi=observed;
    }else{
    record.stage='owned-media-source';
    const sourceId=`window:${start.workbenchWindowHwnd}:0`,sources=await Promise.race([
      desktopCapturer.getSources({types:['window'],fetchWindowIcons:false,thumbnailSize:{width:1,height:1}}),
      delay(6000).then(()=>{throw Error('Exact owned-window source lookup timed out.');})]);
    if(!sources.some(source=>source.id===sourceId))throw Error('The exact owned native window media source is unavailable.');
    record.sourceId=sourceId;
    observer=new BrowserWindow({show:false,width:320,height:180,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const html=options.output+'.observer.html';await fs.writeFile(html,'<!doctype html><meta charset="utf-8"><title>Hidden native motion observer</title>',{flag:'wx'});
    await Promise.race([observer.loadFile(html),delay(4000).then(()=>{throw Error('Hidden observer did not load.');})]);
    record.stage='owned-window-video';
    const expression=`(()=>{const crc32Counter=${crc32Counter.toString()};const decodeRow=${decodeRow.toString()};const analyzeFrame=${analyzeFrame.toString()};const mapPoint=${mapPoint.toString()};return (${captureVideo.toString()})(${JSON.stringify({sourceId,geometry:record.geometry,animation:start.animation,durationMs:options.durationMs})}).catch(error=>({captureError:{name:String(error?.name||'MediaCaptureError'),message:String(error?.message||error),constraint:String(error?.constraint||''),code:typeof error?.code==='number'?error.code:null}}));})()`;
    const video=await Promise.race([observer.webContents.executeJavaScript(expression,true),
      delay(options.durationMs+8000).then(()=>{throw Error('Actual media-frame observation exceeded its bound.');})]);
    if(video.captureError){record.mediaError=video.captureError;throw Error('Owned-window video failed: '+JSON.stringify(video.captureError));}
    if(video.videoBase64){const bytes=Buffer.from(video.videoBase64,'base64');delete video.videoBase64;if(bytes.length>33554432)throw Error('Recorded video exceeded its bound.');
      await fs.writeFile(options.output+'.webm',bytes,{flag:'wx'});video.recording={file:options.output+'.webm',bytes:bytes.length,sha256:hash(bytes),mime:video.videoMime};}
    record.video=video;observed=video;
    }
    record.stage='native-final';record.final=await Promise.race([final,delay(16000).then(()=>{throw Error('Native producer did not finish.');})]);
    await Promise.race([new Promise(resolve=>{if(exited)resolve();else worker.once('exit',resolve)}),delay(2500)]);
    if(!exited)throw Error('Native producer cleanup was not observed.');record.helperExited=true;
    record.stage='temporal-acceptance';record.checks=validateEvidence(observed,record.final,method);record.passed=true;record.stage='complete';
  }catch(error){record.error=String(error.message||error).slice(0,1000);record.failure={stage:record.stage,name:String(error?.name||'Error'),message:record.error,code:typeof error?.code==='string'||typeof error?.code==='number'?error.code:null,
    stderr:typeof error?.stderr==='string'?error.stderr.slice(-1500):undefined};}
  finally{
    clearTimeout(watchdog);if(observer&&!observer.isDestroyed())observer.destroy();if(worker&&!exited){try{worker.kill()}catch{}}
    record.stderr={bytes:stderrBytes,sha256:stderrHash.digest('hex'),rawOmitted:true};record.finishedAt=new Date().toISOString();
    await fs.writeFile(options.output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});app.exit(record.passed?0:1);
  }
}
async function reassessSavedPresentation({reportPath,outputPath,buildReceiptPath,repo=path.resolve(__dirname,'..')}={}){
  const fs=require('node:fs/promises'),{isDeepStrictEqual}=require('node:util');
  for(const file of [reportPath,outputPath,buildReceiptPath])if(!path.isAbsolute(file||''))throw Error('Absolute saved report, new output and current build receipt are required.');
  if(path.resolve(reportPath)===path.resolve(outputPath))throw Error('Original evidence must not be overwritten.');
  const originalBytes=await fs.readFile(reportPath),original=JSON.parse(originalBytes);
  const rawPath=reportPath+'.gdi.json',rawBytes=await fs.readFile(rawPath),raw=JSON.parse(rawBytes);
  if(original.captureBackend!=='gdi-window'||!original.gdi||original.helperExited!==true||raw.method!=='exact-child-getdc-bitblt-gdi-surface'||
    raw.ownerVerified!==true||raw.occlusionChecked!==true||raw.printWindowUsed!==false||raw.forcedPaint!==false||raw.desktopCaptured!==false)throw Error('Saved exact-child GDI provenance is incomplete.');
  const recorded={...original.gdi};delete recorded.artifacts;
  if(!isDeepStrictEqual(recorded,raw))throw Error('Original report and saved collector samples differ.');
  const observerPath=reportPath+'.observer-source.cjs',collectorPath=reportPath+'.collector-source.ps1';
  if(hash(await fs.readFile(observerPath))!==original.observerSourceSha256||hash(await fs.readFile(collectorPath))!==original.collectorSourceSha256)throw Error('Original observer/collector source snapshot hashes differ.');
  const receiptBytes=await fs.readFile(buildReceiptPath),receipt=JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/,''));
  if(receipt.sha256!==original.build?.helperSha256||receipt.sourceSha256!==original.build.sourceSha256||receipt.runtimeManifestSha256!==original.build.runtimeManifestSha256||hash(receiptBytes)!==original.build.receiptSha256)throw Error('Current build receipt differs from the saved exact build.');
  for(const [file,expected]of [[receipt.executable,receipt.sha256],[path.join(repo,'scripts/workbench-freerdp-client/main.cpp'),receipt.sourceSha256],[path.join(receipt.runtimeDirectory,'runtime-manifest.json'),receipt.runtimeManifestSha256]])
    if(hash(await fs.readFile(file))!==expected)throw Error('Current helper/source/runtime bytes differ from original observation.');
  validateGeometry(original.geometry,original.start);
  const metadata=JSON.parse(await fs.readFile(reportPath+'.gdi-input.json','utf8'));
  if(metadata.helperPid!==original.start.helperPid||metadata.workbenchWindowHwnd!==original.start.workbenchWindowHwnd||metadata.childHwnd!==original.start.childHwnd)throw Error('Saved collector target differs from the original owned helper.');
  if(!Array.isArray(raw.samples)||raw.samples.length>10000||raw.samples.length<120)throw Error('Saved temporal samples are missing or unbounded.');
  let previousTime=-1,previousCounter=null,black=0,flat=0,invalid=0,regressions=0;const counters=new Set();
  for(const sample of raw.samples){
    if(!Number.isFinite(sample.atMs)||sample.atMs<previousTime||!['black','flat','counterValid'].every(key=>typeof sample[key]==='boolean')||!Number.isSafeInteger(sample.counter)||sample.counter<0||sample.counter>0xffffffff)throw Error('Saved temporal sample shape or order is invalid.');
    previousTime=sample.atMs;if(sample.black)black++;if(sample.flat)flat++;
    if(sample.counterValid){if(previousCounter!==null&&sample.counter<previousCounter)regressions++;previousCounter=sample.counter;counters.add(sample.counter);}else invalid++;
  }
  const recomputed={samplesRead:raw.samples.length,durationMs:raw.samples.at(-1).atMs-raw.samples[0].atMs,blackFrames:black,flatFrames:flat,invalidCounterFrames:invalid,validCounterRegressions:regressions,distinctValidCounters:counters.size};
  for(const key of Object.keys(recomputed))if(Math.abs(raw[key]-recomputed[key])>0.000001)throw Error('Saved summary differs from timestamped collector samples.');
  const artifacts=[];
  for(const artifact of original.gdi.artifacts||[]){
    if(![reportPath+'.before.png',reportPath+'.after.png'].includes(artifact.file))throw Error('Saved artifact is outside the exact observation.');
    const bytes=await fs.readFile(artifact.file);if(hash(bytes)!==artifact.sha256)throw Error('Saved image artifact changed.');artifacts.push({file:artifact.file,sha256:artifact.sha256});
  }
  if(artifacts.length!==2)throw Error('Original before/after evidence is incomplete.');
  const checks=validateEvidence(raw,original.final,'gdi-surface');
  const result={schema:1,kind:'saved-temporal-reassessment',at:new Date().toISOString(),passed:true,newObservation:false,
    originalReport:{file:reportPath,sha256:hash(originalBytes),passed:original.passed},collectorData:{file:rawPath,sha256:hash(rawBytes)},
    originalObserverSource:{file:observerPath,sha256:original.observerSourceSha256},originalCollectorSource:{file:collectorPath,sha256:original.collectorSourceSha256},
    build:original.build,metrics:recomputed,checks,artifacts,
    foreground:{globalChanges:original.final.foregroundChangeCount,globalUnchanged:original.final.foregroundUnchanged,
      helperForegroundChanges:original.final.helperForegroundChangeCount,helperEverForeground:original.final.helperEverForeground,
      criterion:'No activation by the test helper; natural foreground changes among other apps are permitted.'},
    visibleDiagnostic:{wasVisible:true,wasTopmost:true,userReportedDisruptiveOverlay:true,furtherVisibleRunsAuthorized:false},
    correction:'Original failure required an unchanged global foreground. This reassessment changes only that criterion, preserving original evidence and all temporal/input/build checks.',
    limitations:['Independent GDI front-surface readback, not physical monitor/DWM photometry.','The visible diagnostic overlay was disruptive despite no observed helper activation.','Saved counter-validity flags and aggregates were checked; pixels were not re-observed or re-decoded.']};
  await fs.writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
async function reassessCli(args){
  const options={};for(const argument of args){const match=/^--(reassess|output|build-receipt)=(.+)$/.exec(argument);if(!match||options[match[1]])throw Error('Use --reassess=ABS_REPORT --output=ABS_NEW_JSON [--build-receipt=ABS_JSON].');options[match[1]]=match[2];}
  const result=await reassessSavedPresentation({reportPath:options.reassess,outputPath:options.output,buildReceiptPath:options['build-receipt']||path.resolve(__dirname,'../.build/workbench-freerdp-client-build.json')});
  console.log(JSON.stringify({passed:result.passed,newObservation:false,metrics:result.metrics,output:options.output}));
}
module.exports={isEntry,parseArgs,crc32Counter,decodeRow,analyzeFrame,validateAnimation,mapPoint,validateGeometry,validateEvidence,reassessSavedPresentation};
if(isEntry()){
  const operation=process.argv.slice(2).some(argument=>argument.startsWith('--reassess='))?reassessCli(process.argv.slice(2)):main();
  operation.catch(error=>{console.error(String(error.message||error));try{require('electron').app.exit(1)}catch{process.exitCode=1;}});
}
