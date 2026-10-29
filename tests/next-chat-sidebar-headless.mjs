/** Actual Next UI geometry over synthetic data; uses a disposable headless Chrome. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';

const fixture=makeFixture(),directory=await mkdtemp(path.join(tmpdir(),'blackice-chat-sidebar-'));
const pending=new Map(),errors=[],measurements=[],screenshots=[];
const output=process.env.BLACKICE_CHAT_SIDEBAR_OUTPUT?path.resolve(process.env.BLACKICE_CHAT_SIDEBAR_OUTPUT):null;
let child,ws,nextId=1;
const until=async(fn,label,ms=12000)=>{let last;const end=Date.now()+ms;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){last=error;}await sleep(80);}throw Error(label+' timed out '+(last?.message||''));};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
const measure=()=>evaluate(`(()=>{
  const box=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),number=k=>parseFloat(s[k])||0;
    const paddingY=number('paddingTop')+number('paddingBottom'),borderY=number('borderTopWidth')+number('borderBottomWidth');
    const paddingX=number('paddingLeft')+number('paddingRight'),borderX=number('borderLeftWidth')+number('borderRightWidth');
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
      paddingY,borderY,contentHeight:r.height-paddingY-borderY,contentWidth:r.width-paddingX-borderX,
      lineHeight:parseFloat(s.lineHeight),fontSize:number('fontSize'),font:s.font,
      boxSizing:s.boxSizing,display:s.display,visibility:s.visibility,hit:hit===e||e.contains(hit)};};
  const select=document.querySelector('#next-chat-bucket'),search=document.querySelector('#next-chat-search');
  const filter=box(select),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=filter.font;
  filter.computedLineHeight=getComputedStyle(select).lineHeight;
  if(!Number.isFinite(filter.lineHeight)){
    const probe=document.createElement('span');probe.textContent=select.selectedOptions[0].textContent;
    probe.style.cssText='all:initial;position:fixed;left:-10000px;top:0;display:inline-block;visibility:hidden;white-space:nowrap;padding:0;border:0;margin:0';
    probe.style.font=filter.font;probe.style.lineHeight=filter.computedLineHeight;
    document.body.appendChild(probe);filter.lineHeight=probe.getBoundingClientRect().height;filter.lineHeightSource='measured-label-line-box';probe.remove();
  }else filter.lineHeightSource='computed-style';
  return {filter,search:box(search),sidebar:box(document.querySelector('.next-chat-sidebar')),
    label:select.selectedOptions[0].textContent,labelWidth:context.measureText(select.selectedOptions[0].textContent).width,
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},documentWidth:document.documentElement.scrollWidth,
    styleLoaded:[...document.styleSheets].some(sheet=>sheet.href&&new URL(sheet.href).pathname==='/next/layout-fixes.css')};
})()`);
try{
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  const profile=path.join(directory,'chrome');await mkdir(profile);if(output)await mkdir(output,{recursive:true});
  child=spawn(process.env.BLACKICE_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',
    '--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0',
    '--user-data-dir='+profile,'--window-size=1360,850','http://127.0.0.1:'+fixture.server.address().port+'/next/'
  ],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let launchError;child.on('error',error=>{launchError=error;});child.stderr.on('data',()=>{});
  const port=await until(async()=>{if(launchError)throw launchError;return Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);},'Headless startup');
  const target=await until(async()=>{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(item=>item.type==='page'&&item.url.includes('/next/'));},'Fixture page');
  await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(packet.id&&pending.has(packet.id)){const job=pending.get(packet.id);pending.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.text||'Page exception');});});
  await send('Runtime.enable');await send('Page.enable');
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-bucket"))'),'Chat frame');
  await evaluate('document.fonts.ready.then(()=>true)');
  for(const width of [1360,780,390,320])for(const zoom of [1,1.25,2]){
    // Desktop zoom shrinks the CSS viewport while increasing its device scale.
    // Record this emulation explicitly; this is not a browser-settings mutation.
    const cssWidth=Math.round(width/zoom),cssHeight=Math.round(850/zoom);
    await send('Emulation.setDeviceMetricsOverride',{width:cssWidth,height:cssHeight,deviceScaleFactor:zoom,mobile:false});
    await settle();
    await evaluate(`(()=>{const sidebar=document.querySelector('.next-chat-sidebar'),r=sidebar.getBoundingClientRect(),s=getComputedStyle(sidebar);if(!r.width||s.display==='none'||r.right<=0||r.x>=innerWidth)document.querySelector('#next-chat-mobile-list').click();return true;})()`);
    await settle();
    const actual=await measure(),label=width+'px at '+zoom+'x',f=actual.filter,s=actual.search,p=actual.sidebar;
    measurements.push({width,zoom,...actual});
    assert.equal(actual.styleLoaded,true,label+': actual layout stylesheet loaded');
    assert.equal(actual.label,'Active',label+': correct dropdown');
    assert.ok(Number.isFinite(f.lineHeight)&&f.contentHeight+0.6>=f.lineHeight,label+': line box fits select content area '+JSON.stringify(f));
    assert.ok(f.contentWidth+1>=actual.labelWidth+f.fontSize,label+': label and native arrow have horizontal space');
    assert.ok(f.width>0&&f.height>0&&f.hit,label+': dropdown visible and hittable');
    assert.ok(s.width>0&&s.height>0&&s.hit,label+': search visible and hittable');
    assert.ok(f.x>=-0.6&&f.right<=actual.viewport.width+0.6&&f.y>=0&&f.bottom<=actual.viewport.height+0.6,label+': dropdown contained in viewport');
    assert.ok(f.x>=p.x-0.6&&f.right<=p.right+0.6,label+': dropdown contained in sidebar');
    assert.ok(Math.abs(f.x-s.x)<1&&Math.abs(f.width-s.width)<1,label+': filter and search align');
    assert.ok(f.height<=s.height+2,label+': compact filter does not exceed search height');
    if(output&&((width===1360&&zoom===1)||(width===390&&zoom===1.25))){
      const name=width===1360?'sidebar-normal.png':'sidebar-compact.png';
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      const destination=path.join(output,name);await writeFile(destination,Buffer.from(shot.data,'base64'));screenshots.push(destination);
    }
  }
  assert.equal(errors.length,0,errors.join('\n'));
  const receipt={checks:measurements.length,measurements,screenshots,zoomMethod:'CSS viewport/device-scale emulation',syntheticData:true,headless:true};
  if(output)await writeFile(path.join(output,'sidebar-geometry.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log('PASS '+JSON.stringify(receipt));
}catch(error){console.error(error.stack||error);process.exitCode=1;if(output)await writeFile(path.join(output,'sidebar-geometry-failure.json'),JSON.stringify({measurements,errors,error:String(error.stack||error)},null,2)+'\n');}
finally{
  if(ws?.readyState===WebSocket.OPEN){try{await send('Browser.close');}catch{}}
  try{ws?.close();}catch{}try{child?.kill();}catch{}
  fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));await fixture.closeKnowledge();
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
