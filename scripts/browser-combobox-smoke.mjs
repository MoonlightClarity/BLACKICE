import { app, BaseWindow, WebContentsView } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const flag=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const source=path.resolve(flag('source')||process.cwd()),reportPath=flag('output');
if(!reportPath||!path.isAbsolute(reportPath)||path.resolve(reportPath).startsWith(source+path.sep))throw Error('Supply an absolute evidence path outside the source checkout.');
const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-combobox-'));
app.setPath('userData',path.join(root,'profile'));
app.on('window-all-closed',()=>{});
const report={source,actualUserBrowserAccessed:false,cases:[]};
let driver,server;
const finish=async(code)=>{try{await driver?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await fs.writeFile(reportPath,JSON.stringify(report,null,2));}finally{app.exit(code);}};
const timer=setTimeout(()=>{report.error='fixture timed out';void finish(1);},45000);
const html='<!doctype html><meta charset="utf-8"><title>Disposable custom combobox</title><style>body{font:16px sans-serif;margin:20px;min-height:2200px;padding-top:500px}.container{position:relative;width:360px}input{width:330px;padding:10px}#menu{position:absolute;z-index:10;max-height:100px;overflow:auto;background:white;border:1px solid black;width:330px}#menu [role=option]{padding:10px;cursor:pointer}#menu[hidden]{display:none}#saved{display:block;margin-top:140px}</style><div class="container"><label for="country">Residence country</label><input id="country" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="menu" autocomplete="off"><div id="menu" role="listbox" hidden></div></div><output id="saved" role="status" aria-label="Selected country">NONE</output><script>const input=document.getElementById("country"),menu=document.getElementById("menu"),saved=document.getElementById("saved");let index=0,selected="";const choices=["Canada","United Kingdom","United States","Australia"];window.trace=[];function log(t){trace.push({type:t,focus:document.hasFocus(),active:document.activeElement?.id||"",expanded:input.getAttribute("aria-expanded"),value:input.value,selected});}function close(){menu.hidden=true;input.setAttribute("aria-expanded","false");}function render(){const matches=choices.filter(x=>x.toLowerCase().includes(input.value.toLowerCase()));menu.replaceChildren(...matches.map((choice,i)=>{const n=document.createElement("div");n.id="choice-"+i;n.setAttribute("role","option");n.textContent=choice;n.addEventListener("mousedown",e=>{e.preventDefault();log("option-down")});n.addEventListener("click",()=>choose(choice));return n}));menu.hidden=false;input.setAttribute("aria-expanded","true");index=0;}function choose(choice){selected=choice;input.value=choice;saved.textContent=choice;close();log("selected");}input.addEventListener("focus",()=>{log("focus");render()});input.addEventListener("blur",()=>{log("blur");close();if(!selected)input.value=""});input.addEventListener("input",()=>{log("input");render()});input.addEventListener("click",()=>{log("input-click");render()});input.addEventListener("keydown",e=>{log("key:"+e.key);if(e.key==="ArrowDown"){e.preventDefault();if(menu.hidden)render();index=Math.min(index+1,menu.children.length-1)}if(e.key==="Enter"&&!menu.hidden&&menu.children[index]){e.preventDefault();choose(menu.children[index].textContent)}});window.addEventListener("focus",()=>log("window-focus"));window.addEventListener("blur",()=>{log("window-blur");close();if(!selected)input.value=""});window.addEventListener("scroll",()=>{if(!menu.hidden){log("scroll-close");close();if(!selected)input.value=""}});</script>';
async function main(){
try{
 await app.whenReady();
 const {ElectronBrowserDriver}=await import(pathToFileURL(path.join(source,'desktop/browser-driver.mjs')).href);
 const {createLiveBrowserWindow}=await import(pathToFileURL(path.join(source,'desktop/browser-surface.mjs')).href);
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 driver=await new ElectronBrowserDriver({dataDir:root,downloadDir:path.join(root,'downloads'),liveSurface:true,createSurfaceWindow:options=>createLiveBrowserWindow({BaseWindow,WebContentsView,options})}).init();
 for(const method of ['pointer','keyboard']){
   const page=await driver.perform({browser:'relay',action:'open',url:'http://127.0.0.1:'+server.address().port+'/?case='+method},{source:'user'});
   const tabId=page.tabId,wc=driver.tab(tabId).window.webContents;
   const snapshot=()=>driver.perform({browser:'relay',action:'snapshot',tabId},{source:'user'});
   const fieldOf=p=>p.frames.flatMap(f=>f.elements).find(e=>e.role==='combobox'&&e.name==='Residence country');
   const optionsOf=p=>(p.frames||[]).flatMap(f=>f.elements).filter(e=>e.role==='option').map(e=>({name:e.name,ref:e.ref}));
   const actual=()=>wc.executeJavaScript('({value:document.querySelector("#country").value,expanded:document.querySelector("#country").getAttribute("aria-expanded"),selected:document.querySelector("#saved").textContent,focus:document.hasFocus(),active:document.activeElement?.id,scrollY:window.scrollY,trace:window.trace.slice()})');
   const args=(p)=>({browser:'relay',tabId,expectedUrl:p.url,expectedDocumentId:p.documentId});
   let p=await snapshot(),field=fieldOf(p);
   const row={method,before:await actual(),steps:[]};report.cases.push(row);
   try{
      if(!field)throw Error('fixture field not found');
      let q=await driver.perform({...args(p),action:'fill',ref:field.ref,text:'United States'},{source:'user'});
      row.steps.push({action:'fill',returnedOptions:optionsOf(q),actual:await actual()});
      p=await snapshot();row.steps.push({action:'snapshot',options:optionsOf(p),actual:await actual()});
      if(method==='pointer'){
        const option=optionsOf(p).find(o=>o.name==='United States');
        if(!option){row.result='no visible option after fill';continue;}
        q=await driver.perform({...args(p),action:'click',ref:option.ref},{source:'user'});
      }else{
        field=fieldOf(p);q=await driver.perform({...args(p),action:'press',ref:field.ref,key:'Enter'},{source:'user'});
      }
      row.steps.push({action:method,returnedOptions:optionsOf(q),actual:await actual()});
      row.result=(await actual()).selected;
   }catch(e){row.error={message:e.message,code:e.code};row.afterFailure=await actual();}
 }
 report.passed=report.cases.length===2&&report.cases.every(c=>c.result==='United States'&&c.steps.at(-1).actual.scrollY===0&&!c.steps.at(-1).actual.trace.some(e=>e.type==='scroll-close'));
 clearTimeout(timer);await finish(report.passed?0:1);
}catch(e){report.error=e.stack;clearTimeout(timer);await finish(1);}
}
void main();