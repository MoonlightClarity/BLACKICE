import {app,BaseWindow,WebContentsView} from 'electron';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';
const flag=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const source=path.resolve(flag('source')||process.cwd()),output=flag('output');
if(!output||!path.isAbsolute(output)||path.resolve(output).startsWith(source+path.sep))throw Error('Supply an absolute receipt path outside source.');
const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-capacity-native-'));
app.setPath('userData',path.join(root,'profile'));
app.on('window-all-closed',()=>{});
const report={source,actualUserBrowserAccessed:false,checks:[],stages:[]};
let driver,server,ending=false;
const save=()=>fs.writeFile(output,JSON.stringify(report,null,2));
async function stage(name){report.stages.push({name,at:new Date().toISOString()});await save();}
async function finish(code){
 if(ending)return;ending=true;clearTimeout(timer);
 try{await save();await Promise.race([driver?.close(),new Promise(r=>setTimeout(r,2500))]);server?.closeAllConnections();server?.close();}
 finally{app.exit(code);}
}
const timer=setTimeout(()=>{report.error='native fixture deadline';void finish(1);},55000);
const bounded=(p,ms,label)=>{let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),ms)})]).finally(()=>clearTimeout(timer));};
async function main(){
try{
 await stage('app-ready');await bounded(app.whenReady(),12000,'Electron readiness');
 const {ElectronBrowserDriver}=await import(pathToFileURL(path.join(source,'desktop/browser-driver.mjs')).href);
 const {createLiveBrowserWindow}=await import(pathToFileURL(path.join(source,'desktop/browser-surface.mjs')).href);
 await stage('loopback-start');
 server=http.createServer((req,res)=>{
  if(req.url==='/form'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><input id="draft" value="preserve this form"><p>Interactive</p>');return;}
  res.setHeader('Content-Type','application/rss+xml');res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title><item><title>'+req.url+'</title></item></channel></rss>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await stage('driver-init');
 driver=await bounded(new ElectronBrowserDriver({dataDir:root,downloadDir:path.join(root,'downloads'),maxTaskTabs:2,maxLiveTabs:3,liveSurface:true,createSurfaceWindow:options=>createLiveBrowserWindow({BaseWindow,WebContentsView,options})}).init(),12000,'driver init');
 const owner={taskId:'fixture-task',nodeId:'agent',runId:'r1'};
 const open=part=>bounded(driver.perform({action:'open',url:'http://127.0.0.1:'+server.address().port+part},{owner}),16000,'open '+part);
 await stage('open-feed-one');
 const first=await open('/feed-one');
 const firstTab=driver.tabs.get(first.tabId),firstWindow=firstTab.window,wc=firstWindow.webContents;
 await stage('inspect-feed-native');
 const tree=await bounded(wc.debugger.sendCommand('Page.getFrameTree'),3000,'frame tree');
 const data=await bounded(wc.executeJavaScript('({type:document.contentType,root:document.documentElement?.localName,ready:document.readyState,inputs:document.querySelectorAll("input,textarea,select,form,iframe,object,embed,script,svg").length,processing:[...document.childNodes].filter(n=>n.nodeType===7).map(n=>n.target)})'),3000,'data probe');
 report.checks.push({name:'feed-native',frame:tree.frameTree.frame,document:data,history:wc.navigationHistory?.getAllEntries?.(),lease:firstTab.capacityReadOnlyOpen});
 await stage('open-interactive');
 const form=await open('/form'),formTab=driver.tabs.get(form.tabId),formWindow=formTab.window;
 await stage('open-feed-two-at-capacity');
 const third=await open('/feed-two');
 assert.equal(third.capacityReclamation?.tabId,first.tabId);
 assert.equal(firstTab.window,null);
 assert.equal(driver.tabs.size,3);assert.equal(driver.status().capacity.live,2);
 assert.equal(formTab.window,formWindow);
 const draft=await formWindow.webContents.executeJavaScript('document.querySelector("#draft").value');
 assert.equal(draft,'preserve this form');
 report.checks.push({name:'automatic-reclamation',receipt:third.capacityReclamation,saved:driver.tabs.size,live:driver.status().capacity.live,formRetained:true});
 await stage('resume-original-feed-at-capacity');
 const resumed=await bounded(driver.perform({action:'read',tabId:first.tabId},{owner}),16000,'resume feed');
 assert.equal(resumed.tabId,first.tabId);assert.equal(resumed.capacityReclamation?.tabId,third.tabId);
 assert.equal(formTab.window,formWindow);
 report.checks.push({name:'resume-preserves-other-page',receipt:resumed.capacityReclamation,saved:driver.tabs.size,live:driver.status().capacity.live});
 report.passed=true;
 await finish(0);
}catch(e){report.error=e.stack;await finish(1);}
}
void main();
