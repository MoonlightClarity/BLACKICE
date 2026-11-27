import {app,BaseWindow,WebContentsView,webContents} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {ElectronBrowserDriver} from '../../desktop/browser-driver.mjs';
import {createLiveBrowserWindow} from '../../desktop/browser-surface.mjs';
const out=process.argv.find(a=>a.startsWith('--fixture-data='))?.slice(15);
if(!out||!path.isAbsolute(out))throw Error('Isolated fixture directory required');
fs.mkdirSync(path.join(out,'data'),{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
const report={ok:false,chromium:process.versions.chrome,electron:process.versions.electron,checks:[],trials:[],metrics:[],lifecycle:{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label,limit=4000)=>{const end=Date.now()+limit;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(20)}throw Error('Timed out: '+label)};
const readMetrics=label=>{const m=app.getAppMetrics();return {label,contents:webContents.getAllWebContents().filter(w=>!w.isDestroyed()).length,renderers:m.filter(x=>x.type==='Tab').length,totalWorkingSetKB:m.reduce((n,x)=>n+(x.memory?.workingSetSize||0),0),cpu:m.reduce((n,x)=>n+(x.cpu?.percentCPUUsage||0),0)}};
let driver,server;
app.whenReady().then(async()=>{
 try{
 const html=String.raw`<!doctype html><title>Stable root</title><style>button{position:fixed;left:10px;top:10px;width:200px;height:45px}#frames{padding-top:70px}iframe{width:100px;height:60px}</style><button id="stable">Stable root button</button><div id="frames"></div><script>window.clicks=0;window.churns=0;stable.onclick=e=>{if(e.isTrusted)clicks++};const box=document.querySelector('#frames');let timer;function replace(i){const f=document.createElement('iframe');f.src='/frame?i='+i+'&v='+ ++churns;if(box.children[i])box.children[i].replaceWith(f);else box.append(f)}for(let i=0;i<8;i++)replace(i);window.startChurn=()=>{if(!timer)timer=setInterval(()=>replace(churns%8),24)};window.stopChurn=()=>{clearInterval(timer);timer=null}</script>`;
 server=http.createServer((q,r)=>{const u=new URL(q.url,'http://127.0.0.1');r.setHeader('Cache-Control','no-store');r.setHeader('Content-Type','text/html; charset=utf-8');if(u.pathname==='/frame'){r.end('<title>Transient frame</title><button>Transient '+Number(u.searchParams.get('v'))+'</button>')}else if(u.pathname==='/redirect'){r.writeHead(302,{Location:'/page?redirected='+Number(u.searchParams.get('v'))});r.end()}else r.end(html)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 driver=await new ElectronBrowserDriver({dataDir:path.join(out,'data'),downloadDir:path.join(out,'downloads'),liveSurface:true,createSurfaceWindow:options=>createLiveBrowserWindow({BaseWindow,WebContentsView,options}),maxLiveTabs:16,maxTaskTabs:12}).init();
 const owner={taskId:'lifecycle',runId:'lifecycle-run',nodeId:'agent',conversationId:'lifecycle'};
 const act=args=>driver.perform(args,{source:'agent',owner});
 report.metrics.push(readMetrics('initial'));
 const pages=[];
 for(let i=0;i<4;i++){const p=await act({action:'open',url:url+'/page?tab='+i});pages.push(driver.tab(p.tabId))}
 report.metrics.push(readMetrics('four-live-tabs'));
 const main=pages[0],wc=main.window.webContents;
 const eventCounts={};const observe=(event,...args)=>{eventCounts[event]||={total:0,main:0,invalid:0};let e=eventCounts[event];e.total++;const [isMain,processId,routingId]=event==='did-frame-navigate'?[args[4],args[5],args[6]]:[args[2],args[3],args[4]];if(isMain===true)e.main++;if(typeof isMain!=='boolean'||!Number.isInteger(processId)||!Number.isInteger(routingId))e.invalid++};
 wc.on('did-frame-navigate',(...args)=>observe('did-frame-navigate',...args));wc.on('did-navigate-in-page',(...args)=>observe('did-navigate-in-page',...args));
 for(const tab of pages)await tab.window.webContents.executeJavaScript('startChurn()');
 const initialMainRevision=main.mainRevision;
 // Independent frame replacements occur in the native renderers while snapshots are running.
 for(let i=0;i<24;i++){
  const row={i};
  try{
   const result=await driver.snapshot(main,undefined,undefined);
   const root=result.frames?.[0],ref=root?.elements?.find(e=>e.name==='Stable root button')?.ref;
   row.root=Boolean(ref);row.current=Boolean(ref&&driver.referenceCurrent(main,ref,result.documentId));row.frameCount=result.frames.length;row.frameErrors=result.frameErrors?.length||0;row.documentId=result.documentId;
   if(!row.root||!row.current)row.error='root unavailable or not current';
   if(row.current&&i%4===0){try{const previous=await wc.executeJavaScript('clicks');await act({action:'click',tabId:main.id,ref,expectedUrl:result.url,expectedDocumentId:result.documentId});row.nativeClickDelta=await wc.executeJavaScript('clicks')-previous;}catch(e){row.clickError={code:e.code,message:e.message}}}
  }catch(e){row.error={code:e.code,message:e.message}}
  report.trials.push(row);
  await sleep(12);
 }
 for(const tab of pages)await tab.window.webContents.executeJavaScript('stopChurn()');
 await sleep(120);report.churn={rootRevisionBefore:initialMainRevision,rootRevisionAfter:main.mainRevision,events:eventCounts,nativeReplacements:await wc.executeJavaScript('churns')};
 report.metrics.push(readMetrics('after-frame-churn'));
 // Trigger native main navigation and verify old refs actually retire.
 const before=await driver.snapshot(main);const stale=before.frames[0].elements.find(e=>e.name==='Stable root button').ref;
 const redirected=await act({action:'navigate',tabId:main.id,url:url+'/redirect?v=9'});
 report.redirect={url:redirected.url,oldRefRetired:!driver.referenceCurrent(main,stale),newRoot:!!redirected.frames?.[0]?.elements?.find(e=>e.name==='Stable root button')};
 // Inject a late old-lifetime protocol event into the actual former WebContents.
 // This models the order in which the asynchronous renderer close can arrive.
 const old=pages[1].window,oldWc=old.webContents,oldDebug=oldWc.debugger;
 const oldId=oldWc.id;const target=pages[1];
 driver.suspendTab(target);await driver.activate(target);const newWc=target.window.webContents;
 const fresh=await driver.snapshot(target),newRef=fresh.frames[0].elements.find(e=>e.name==='Stable root button')?.ref;
 const oldMain=target.mainRevision,oldRevision=target.revision,oldReady=target.containmentReady;
 const previousError=target.loadError;
 oldWc.emit('did-frame-navigate',{},url+'/stale',200,'OK',true,1,1);
 oldWc.emit('did-fail-load',{},-105,'Synthetic retired navigation failure',url+'/retired',true);
 oldDebug.emit('detach',{},'target closed');
 report.lifecycle={nativeIdentityReplaced:oldId!==newWc.id,revisionPreserved:target.revision===oldRevision,mainRevisionPreserved:target.mainRevision===oldMain,refPreserved:driver.referenceCurrent(target,newRef),loadErrorPreserved:target.loadError===previousError,containmentPreserved:target.containmentReady===oldReady};
 // Exercise repeated real native suspension/resume and independent sibling lifetime.
 const sibling=pages[2].window.webContents;
 await sibling.executeJavaScript('window.draftMarker="retained sibling"');
 for(let round=0;round<8;round++){
   const p=pages[3];const retired=p.window.webContents;
   driver.suspendTab(p);await driver.activate(p);
   await until(()=>retired.isDestroyed(),'retired webContents destruction');
   const snapshot=await driver.snapshot(p);assert.ok(snapshot.frames[0]?.elements.find(e=>e.name==='Stable root button'));
 }
 report.siblingPreserved=await sibling.executeJavaScript('window.draftMarker')==='retained sibling';
 report.metrics.push(readMetrics('after-eight-suspend-resume'));
 report.summary={trials:report.trials.length,snapshotFailures:report.trials.filter(r=>r.error).length,currentRoot:report.trials.filter(r=>r.root&&r.current).length,clickTrials:report.trials.filter(r=>r.nativeClickDelta!==undefined||r.clickError).length,clickFailures:report.trials.filter(r=>r.clickError||r.nativeClickDelta!==undefined&&r.nativeClickDelta!==1).length,partial:report.trials.filter(r=>r.frameErrors>0).length};
 report.ok=true;
 }catch(e){report.error=String(e.stack||e)}
 finally{try{await driver?.close();if(server)await new Promise(r=>{server.closeAllConnections();server.close(r)})}catch(e){report.shutdownError=String(e)};report.metrics.push(readMetrics('after-driver-close'));fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1)}
}).catch(e=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,error:String(e.stack||e)}));app.exit(1)});
setTimeout(()=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({...report,ok:false,error:'fixture deadline'}));app.exit(2)},65000).unref();