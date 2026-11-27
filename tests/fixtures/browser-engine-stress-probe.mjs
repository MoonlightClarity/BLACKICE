import {app, BaseWindow, WebContentsView, BrowserWindow, session} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createLiveBrowserWindow} from '../../desktop/browser-surface.mjs';
import {captureHiddenPage} from '../../desktop/browser-capture.mjs';
const out=process.argv.find(a=>a.startsWith('--fixture-data='))?.slice(15);
if(!out||!path.isAbsolute(out))throw Error('Isolated data directory required');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
const report={ok:false,electron:process.versions.electron,chromium:process.versions.chrome,modes:[],checks:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timeout=(promise,ms=3000)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('native operation timeout')),ms);Promise.resolve(promise).then(v=>{clearTimeout(t);resolve(v)},e=>{clearTimeout(t);reject(e)})});
let server,host;const handles=[];
const html='<!doctype html><meta charset="utf-8"><style>body{margin:0}#marker{position:fixed;left:0;top:0;width:60px;height:60px;background:#ff0000}button{position:fixed;left:calc(50% - 80px);top:100px;width:160px;height:50px}</style><div id="marker"></div><button id="target">Native target</button><script>window.ticks=0;window.clicks=0;window.trusted=0;window.keepTicks=!location.search.includes("idle");function tick(){ticks++;if(keepTicks)requestAnimationFrame(tick)}if(keepTicks)requestAnimationFrame(tick);target.addEventListener("click",e=>{clicks++;if(e.isTrusted)trusted++});window.setMarker=c=>{marker.style.background=c};window.rect=()=>{const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight,visibility:document.visibilityState,ticks,clicks,trusted}}</script>';
async function probe(wc, mode, index, phase){
 const row={mode,index,phase};
 try {
  const t=performance.now();const before=await timeout(wc.executeJavaScript('rect()'));await sleep(130);const after=await timeout(wc.executeJavaScript('rect()'));row.frames=after.ticks-before.ticks;row.viewport=[after.w,after.h];row.visibility=after.visibility;
  // Each comparison changes the marker to its opposite before capturing.
  const nextColor=async()=>{const color=await timeout(wc.executeJavaScript('getComputedStyle(marker).backgroundColor'));return color.includes('255, 0, 0')?'#00ff00':'#ff0000'};
  const sample=async(name,method)=>{
   const expected=await nextColor();const start=performance.now();
   await timeout(wc.executeJavaScript('setMarker('+JSON.stringify(expected)+')'));
   const image=await method();
   const bytes=image.crop({x:10,y:10,width:1,height:1}).toBitmap();const red=bytes[2],green=bytes[1];
   return {name,ms:Math.round(performance.now()-start),marker:[red,green],expected,match:expected==='#00ff00'?green>200&&red<50:red>200&&green<50,imageSize:image.getSize()};
  };
  if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
  const capture=()=>timeout(wc.capturePage(undefined,{stayHidden:true}),3500);
  const frame=()=>timeout(wc.executeJavaScriptInIsolatedWorld(1001,[{code:'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'}]),1500);
  
  row.captures=[];
  // Ensure earlier sample is painted before testing the next opposite color.
  for(const [name,fn] of [['native-immediate',capture],['native-after-two-frames',async()=>{const result=await captureHiddenPage(wc);return result.image}]]){
   await frame();try{row.captures.push(await sample(name,fn))}catch(e){row.captures.push({name,error:String(e.message||e)})}
  }
  row.captureMs=Math.round(performance.now()-t);row.imageSize=row.captures[0]?.imageSize;row.marker=row.captures[0]?.marker;row.markerMatches=row.captures[0]?.match;
  const point=await timeout(wc.executeJavaScript('rect()'));
  const hit=await timeout(wc.debugger.sendCommand('DOM.getNodeForLocation',{x:Math.floor(point.x),y:Math.floor(point.y)}));
  const desc=await timeout(wc.debugger.sendCommand('DOM.describeNode',{backendNodeId:hit.backendNodeId}));
  row.hitCorrect=desc.node.nodeName==='BUTTON'&&desc.node.attributes?.includes('target')===true;
  if(row.hitCorrect){
   const send=type=>timeout(wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1}));
   await send('mousePressed');await send('mouseReleased');const state=await timeout(wc.executeJavaScript('rect()'));row.clickDelta=state.clicks-point.clicks;row.trustedDelta=state.trusted-point.trusted;
  }
 }catch(e){row.error=String(e.message||e)}
 return row;
}
app.whenReady().then(async()=>{
 try{
  server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  host=new BaseWindow({show:false,focusable:false,skipTaskbar:true,width:960,height:700});
  const s=session.fromPartition('native-engine-probe');
  const options={width:1280,height:900,webPreferences:{session:s,contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false,webSecurity:true}};
  // Raw Electron native surfaces, bypass all tool handlers and DOM ref guards.
  const views=Array.from({length:8},()=>createLiveBrowserWindow({BaseWindow,WebContentsView,options}));handles.push(...views);
  await Promise.all(views.map((v,i)=>timeout(v.webContents.loadURL(url+'/?view='+i),12000)));
  await sleep(250);
  const parked=[];
  for(let round=0;round<3;round++)parked.push(...await Promise.all(views.map((v,i)=>probe(v.webContents,'parked',i,round))));
  report.modes.push({name:'eight-parked-live-views',rows:parked});fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify(report));
  const reparent=[];
  const v=views[0],id=v.webContents.id;
  for(let round=0;round<6;round++){
   v.attach(host,{x:0,y:0,width:round%2?880:640,height:round%2?600:480});
   reparent.push(await probe(v.webContents,'attached-hidden',0,round));
   v.hide();
   reparent.push(await probe(v.webContents,'reparked',0,round));
  }
  report.modes.push({name:'reparent-and-resize',sameWebContents:id===v.webContents.id,rows:reparent});
  const offscreen=new BrowserWindow({...options,show:false,focusable:false,skipTaskbar:true,webPreferences:{...options.webPreferences,offscreen:true}});
  handles.push(offscreen);await timeout(offscreen.webContents.loadURL(url+'/?offscreen'),12000);await sleep(250);
  const off=[];for(let round=0;round<3;round++)off.push(await probe(offscreen.webContents,'offscreen',0,round));report.modes.push({name:'offscreen-comparison',rows:off});
  report.summary=report.modes.map(m=>({mode:m.name,trials:m.rows.length,errors:m.rows.filter(r=>r.error).length,zeroFrames:m.rows.filter(r=>r.frames===0).length,wrongHit:m.rows.filter(r=>r.hitCorrect===false).length,wrongClick:m.rows.filter(r=>r.hitCorrect&&r.clickDelta!==1).length,captureMethods:['native-immediate','native-after-two-frames'].map(name=>{const samples=m.rows.flatMap(r=>r.captures||[]).filter(x=>x.name===name);const times=samples.map(x=>x.ms).filter(Number.isFinite).sort((a,b)=>a-b);return {name,trials:samples.length,wrong:samples.filter(x=>x.match===false).length,errors:samples.filter(x=>x.error).length,medianMs:times[Math.floor(times.length/2)],maxMs:times.at(-1)}})}));
  // Dormant pages must not depend on a site's own animation loop to stay capturable.
  const idle=views[1].webContents;await timeout(idle.loadURL(url+'/?idle'),12000);
  for(const handle of handles)if(handle.webContents!==idle&&!handle.isDestroyed())handle.destroy();
  report.idle=[];
  for(let index=0;index<4;index++){
   if(index===2){await idle.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await idle.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});}
   await sleep([1800,2400,3100,1800][index]);
   const row={index,kind:index===2?'after-focus-release':'dormant',backgroundThrottling:idle.getBackgroundThrottling()},start=performance.now();
   try{
    const expected=index%2?'#ff0000':'#00ff00';
    await timeout(idle.executeJavaScript('setMarker('+JSON.stringify(expected)+')'));
    const result=await captureHiddenPage(idle),bytes=result.image.crop({x:10,y:10,width:1,height:1}).toBitmap();
    row.marker=[bytes[2],bytes[1]];row.match=expected==='#00ff00'?bytes[1]>200&&bytes[2]<50:bytes[2]>200&&bytes[1]<50;
    row.ticks=await timeout(idle.executeJavaScript('ticks'));row.retries=result.retries;
   }catch(error){row.error=error.message;row.code=error.code;row.captureStage=error.captureStage;}
   row.ms=Math.round(performance.now()-start);report.idle.push(row);
  }
  report.ok=true;
 }catch(e){report.error=String(e.stack||e)}
 finally{for(const h of handles)try{if(!h.isDestroyed())h.destroy()}catch{};try{host?.destroy()}catch{};try{server?.closeAllConnections();await new Promise(r=>server?server.close(r):r())}catch{};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1)}
}).catch(e=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,error:String(e.stack||e)}));app.exit(1)});
setTimeout(()=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({...report,ok:false,error:'fixture deadline'}));app.exit(2)},65000).unref();
