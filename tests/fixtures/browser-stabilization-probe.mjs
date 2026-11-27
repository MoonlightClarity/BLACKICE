import {app,BaseWindow,WebContentsView} from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ElectronBrowserDriver} from '../../desktop/browser-driver.mjs';
import {createLiveBrowserWindow} from '../../desktop/browser-surface.mjs';
const out=process.argv.find(a=>a.startsWith('--fixture-data='))?.slice(15);
if(!out||!path.isAbsolute(out))throw Error('Isolated data directory required');
fs.mkdirSync(path.join(out,'data'),{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
const report={ok:false,checks:[]};let driver,server;
const html='<!doctype html><title>Local browser stabilization fixture</title><div style="height:1700px"></div><button id="target" style="width:220px;height:60px">Exact target</button><div style="height:1800px"></div><input aria-label="Name" id="name"><select aria-label="Choice" id="choice"><option value="a">A</option><option value="b">B</option></select><input type="file" aria-label="Document"><script>window.clicks=0;target.onclick=e=>{window.clicks++;window.trusted=e.isTrusted};</script>';
app.whenReady().then(async()=>{
try {
 server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end(html)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 driver=await new ElectronBrowserDriver({dataDir:path.join(out,'data'),downloadDir:path.join(out,'downloads'),liveSurface:true,createSurfaceWindow:options=>createLiveBrowserWindow({BaseWindow,WebContentsView,options})}).init();
 const owner={taskId:'fixture',runId:'fixture-run',nodeId:'agent',conversationId:'fixture'};
 const act=args=>driver.perform(args,{source:'agent',owner});
 let page=await act({action:'open',url:'http://127.0.0.1:'+server.address().port+'/'});
 const tab=driver.tab(page.tabId),wc=tab.window.webContents;
 const element=name=>page.frames.flatMap(f=>f.elements).find(e=>e.name===name);
 const guard=el=>({tabId:page.tabId,expectedUrl:page.url,expectedDocumentId:page.documentId,...(el?{ref:el.ref}:{})});
 const fresh=async()=>page=await act({action:'snapshot',tabId:page.tabId});
 await wc.executeJavaScript('target.scrollIntoView({block:"center",behavior:"instant"})');await new Promise(r=>setTimeout(r,180));await fresh();
 const point=await wc.executeJavaScript('(()=>{const r=target.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scrollY,scrollX}})()');
 const cmd=(method,params)=>wc.debugger.sendCommand(method,params||{});
 const identify=async(x,y)=>{try{const h=await cmd('DOM.getNodeForLocation',{x:Math.floor(x),y:Math.floor(y)});const d=await cmd('DOM.describeNode',{backendNodeId:h.backendNodeId});return {name:d.node.nodeName,id:d.node.attributes?.includes('target')||false}}catch(e){return {error:e.message}}};
 report.point=point;report.viewportHit=await identify(point.x,point.y);report.documentHit=await identify(point.x+point.scrollX,point.y+point.scrollY);
 try{const c=element('Exact target');assert.ok(c);const clicked=await act({action:'click',...guard(c)});report.clickReceipt=clicked.receipt;report.clicks=await wc.executeJavaScript('({clicks,trusted})');}catch(e){report.clickError={code:e.code,message:e.message,diag:e.browserReferenceDiagnostic,inputDispatched:e.inputDispatched,pointerStage:e.pointerStage};}
 await wc.executeJavaScript('(()=>{const el=document.createElement("button");el.id="moving";el.textContent="Moving target";el.style="position:fixed;left:40px;top:40px;width:160px;height:60px";document.body.append(el);window.moveClicks=0;el.addEventListener("pointerenter",()=>{el.style.left="300px"},{once:true});el.addEventListener("click",()=>{window.moveClicks++})})()');await fresh(); const moving=element('Moving target');assert.ok(moving);try{report.movingReceipt=(await act({action:'click',...guard(moving)})).receipt;}catch(e){report.movingError={code:e.code,message:e.message,diag:e.browserReferenceDiagnostic,inputDispatched:e.inputDispatched,pointerStage:e.pointerStage}};report.moveClicks=await wc.executeJavaScript('window.moveClicks');
 await fresh();try{await act({action:'press',...guard(),key:'Control+v'})}catch(e){report.invalidKey={code:e.code||null,actionDispatched:e.actionDispatched??null,message:e.message};}

 assert.equal(report.clicks.clicks,1);assert.equal(report.clicks.trusted,true);
 assert.equal(report.moveClicks,1,JSON.stringify(report.movingError));assert.ok(report.movingReceipt?.clicked);
 assert.equal(report.invalidKey.code,'BROWSER_VALIDATION');assert.equal(report.invalidKey.actionDispatched,false);
 // Partially covered exact target: its center is obscured, but an edge is free.
 await wc.executeJavaScript('(()=>{const b=document.createElement("button");b.id="partial";b.textContent="Partly covered button";Object.assign(b.style,{position:"fixed",left:"520px",top:"40px",width:"180px",height:"64px",zIndex:"10"});document.body.append(b);const cover=document.createElement("div");cover.id="partial-cover";Object.assign(cover.style,{position:"fixed",left:"589px",top:"40px",width:"42px",height:"64px",background:"black",zIndex:"11"});document.body.append(cover);window.partialClicks=0;window.overlayClicks=0;b.addEventListener("click",e=>{if(e.isTrusted)partialClicks++});cover.addEventListener("click",()=>overlayClicks++)})()');
 await fresh();const partial=element('Partly covered button');assert.ok(partial);
 const partialResult=await act({action:'click',...guard(partial)});assert.ok(partialResult.receipt?.clicked);
 const partialCounts=await wc.executeJavaScript('({button:partialClicks,overlay:overlayClicks})');
 assert.deepEqual(partialCounts,{button:1,overlay:0});
 report.checks.push('partly-covered-exact-control-uses-exposed-native-hit');
 report.checks.push('scrolled-hit-test','same-control-moving-geometry-recovered-once','invalid-key-rejected-before-dispatch');
 // Native fill/select/upload use actual page handlers and independent DOM reads.
 await fresh();let name=element('Name');assert.ok(name);
 let filled=await act({action:'fill',text:'Example Applicant',...guard(name)});assert.equal(filled.receipt.filled,true);assert.equal(await wc.executeJavaScript('document.querySelector("#name").value'),'Example Applicant');
 await fresh();name=element('Name');await act({action:'press',key:'Ctrl+A',...guard(name)});
 await fresh();await act({action:'press',key:'Backspace',...guard(name)});assert.equal(await wc.executeJavaScript('document.querySelector("#name").value'),'');
 await fresh();let choice=element('Choice');assert.ok(choice);let selected=await act({action:'select',value:'b',...guard(choice)});assert.equal(selected.receipt.selected,'b');assert.equal(await wc.executeJavaScript('document.querySelector("#choice").value'),'b');
 await fresh();const doc=element('Document');assert.ok(doc);const file=path.join(out,'sample.txt');fs.writeFileSync(file,'synthetic fixture');
 const uploaded=await act({action:'upload',paths:[file],...guard(doc)});assert.ok(uploaded.receipt);assert.equal(await wc.executeJavaScript('document.querySelector("input[type=file]").files[0].name'),'sample.txt');
 report.checks.push('native-fill-and-key-edit','native-select','native-file-upload');
 // Force a focus change between selection preparation and actual browser input.
 // This is a test-only interception; the subsequent focus check is real Chromium.
 const originalElement=driver.element.bind(driver);await fresh();name=element('Name');
 await wc.executeJavaScript('(()=>{const el=document.createElement("input");el.id="other";el.setAttribute("aria-label","Other");document.body.append(el)})()');
 driver.element=async(...args)=>{const r=await originalElement(...args);if(args[2]==='fill-ready')await wc.executeJavaScript('document.querySelector("#other").focus({preventScroll:true})');return r;};
 let lost;try{await act({action:'fill',text:'Do not write',...guard(name)})}catch(e){lost=e}
 driver.element=originalElement;assert.equal(lost?.code,'BROWSER_INPUT_FOCUS_CHANGED');assert.equal(lost?.inputDispatched,false);
 assert.deepEqual(await wc.executeJavaScript('({name:document.querySelector("#name").value,other:document.querySelector("#other").value})'),{name:'',other:''});
 report.checks.push('same-document-focus-loss-does-not-type-into-another-control');
 // A native effect returned; force only the subsequent observation to fail.
 await fresh();choice=element('Choice');const originalSnapshot=driver.snapshot.bind(driver);
 driver.snapshot=async(...args)=>{throw Object.assign(Error('Synthetic post-input observation churn'),{code:'BROWSER_SNAPSHOT_DOCUMENT_CHANGED'})};
 let post;try{post=await act({action:'select',value:'a',...guard(choice)})}finally{driver.snapshot=originalSnapshot}
 assert.equal(post.receipt.selected,'a');assert.equal(post.observationUnavailable,true);assert.equal(post.actionDispatched,true);assert.deepEqual(post.frames,[]);
 assert.equal(await wc.executeJavaScript('document.querySelector("#choice").value'),'a');
 await fresh();assert.ok(page.frames.length);
 report.checks.push('post-input-observation-loss-retains-only-actual-receipt');
 // Replaced controls must not be retargeted automatically.
 const movingBefore=element('Moving target');await wc.executeJavaScript('document.querySelector("#moving").replaceWith(document.querySelector("#moving").cloneNode(true))');
 let stale;try{await act({action:'click',...guard(movingBefore)})}catch(e){stale=e}
 assert.equal(stale?.code,'BROWSER_REF_STALE');assert.equal(await wc.executeJavaScript('window.moveClicks'),1);
 report.checks.push('replacement-control-is-not-retargeted');
 await wc.executeJavaScript('window.scrollTo({top:1000,behavior:"instant"})');await fresh();const beforeScroll=await wc.executeJavaScript('scrollY');assert.ok(beforeScroll>=900);const scroll=await act({action:'scroll',tabId:page.tabId,direction:'up',amount:200});assert.ok(scroll.receipt);assert.ok(await wc.executeJavaScript('scrollY')<beforeScroll);
 const next=await act({action:'navigate',tabId:page.tabId,url:page.url+'?next=1'});assert.ok(next.url.endsWith('?next=1'));await fresh();assert.ok(page.frames.length);
 report.checks.push('scroll-and-navigation-observation');

 report.ok=true;
} catch(e){report.error=String(e.stack||e)}
finally{try{await driver?.close();if(server)await new Promise(r=>{server.closeAllConnections();server.close(r)})}catch(e){report.shutdownError=String(e)};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1)}
}).catch(e=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,error:String(e.stack||e)}));app.exit(1)});
