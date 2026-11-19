
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const [root,out]=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let server,win;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const html='<!doctype html><html data-blackice-ui><meta charset=utf-8><link rel=stylesheet href="/next/base.css"><link rel=stylesheet href="/next/chat.css"><link rel=stylesheet href="/next/controls.css"><body><main id=app></main><script type=module>'+
'import {createActionDirectory} from "/next/chat/action-directory.mjs";'+
'const state={objective:"Read and compare two records",revision:8,focus:"current",ready:[],actions:[{id:"done",objective:"A finished step with a previously failed attempt "+ "LongUnbrokenTitle".repeat(12),state:"observed",dependsOn:[]},{id:"current",objective:"Continue",state:"active",dependsOn:["done"]}],receipts:[{id:"receipt-1",actionId:"done",tool:"relay_browser",state:"returned",success:false,actionDispatched:false,code:"BROWSER_REF_STALE"}]};'+
'window.fixture=createActionDirectory({frame:document.querySelector("#app"),getRuns:()=>[{id:"test",taskId:"test"}],api:async()=>({runId:"test",taskId:"test",state})});await window.fixture.open();window.ready=true;</script>';
const names=['next/base.css','next/chat.css','next/controls.css','next/chat/action-directory.mjs'];
(async()=>{
 await app.whenReady();
 server=http.createServer((req,res)=>{const file=req.url.slice(1);if(!file){res.setHeader('Content-Type','text/html');res.end(html);return;}if(!names.includes(file)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(root,'public',file)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({width:1150,height:700,show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/');const run=s=>win.webContents.executeJavaScript(s);
 for(let i=0;i<100&&!await run('Boolean(window.ready)');i++)await sleep(25);
 assert(await run('Boolean(window.ready)'));
 const checks=[];
 for(const width of [1150,390,320]){
  win.setContentSize(width,500);await sleep(180);
  const details=await run('(()=>{const e=document.querySelector(".next-action-outline"),b=e.getBoundingClientRect(),row=e.querySelector("details");return {left:b.left,right:b.right,innerWidth,overflow:e.scrollWidth-e.clientWidth,collapsed:!row.open,failure:row.querySelector("summary").textContent.includes("1 failed")}})()');
  assert(details.left>=0&&details.right<=details.innerWidth&&details.overflow<=1,JSON.stringify(details));assert(details.collapsed&&details.failure);checks.push(details);
  fs.writeFileSync(path.join(out,'outline-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await run('document.querySelector(".next-action-outline details").open=true;true');
 assert(await run('document.querySelector(".next-action-outline details").textContent.includes("BROWSER_REF_STALE")'));
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);process.exitCode=1}).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0);});setTimeout(()=>app.exit(2),25000).unref();
