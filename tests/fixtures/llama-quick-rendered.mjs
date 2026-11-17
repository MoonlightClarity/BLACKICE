import {app,BrowserWindow} from 'electron';
import http from 'node:http';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const profile=mkdtempSync(path.join(os.tmpdir(),'blackice-llama-ui-render-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
async function main(){
const root=fileURLToPath(new URL('../..',import.meta.url)),out=path.join(root,'verification','llama-quick');
await mkdir(out,{recursive:true});

const server=http.createServer(async(req,res)=>{try{const route=new URL(req.url,'http://localhost').pathname;
 const filename=route==='/'?'tests/fixtures/llama-quick-rendered.html':route==='/config.mjs'?'lib/llama-cpp-launch-config.mjs':route.startsWith('/next/')?'public'+route:null;
 if(!filename||filename.includes('..')){res.writeHead(404);return res.end();}
 let text=await readFile(path.join(root,filename),'utf8');
 if(route==='/config.mjs')text=text.replace("import path from 'node:path';",'const path = {};');
 res.setHeader('Content-Type',filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'text/javascript');res.end(text);
 }catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));

const win=new BrowserWindow({show:false,width:980,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true}});
const errors=[];win.webContents.on('console-message',(event)=>{if(event.level==='error')errors.push(event.message);});
const js=code=>win.webContents.executeJavaScript(code);
const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+code);};
const results=[];
try{
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/');await wait('window.ready && document.querySelector("#next-llama-runtime-status").textContent.includes("CPU")');
 assert.equal(await js('document.querySelector("#next-local-engine").value'), 'llamacpp');
 for(const width of [980,390]){
  win.setContentSize(width,1000);await new Promise(r=>setTimeout(r,100));
  const geometry=await js('({width:innerWidth,scroll:document.querySelector(".next-panel").scrollWidth,advanced:document.querySelector("#next-llama-launch-settings").open,download:document.querySelector("#next-llama-setup").open,writes:calls.filter(c=>c.method==="POST").length})');
  assert.ok(geometry.scroll<=width);assert.equal(geometry.advanced,false);assert.equal(geometry.download,false);assert.equal(geometry.writes,0);results.push(geometry);
  await writeFile(path.join(out,'setup-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await js('window.picked=["C:\\\\Models\\\\research.gguf"];document.querySelector("#next-llama-model-browse").click()');
 await wait('document.querySelector("#next-llama-model-name").value==="research"');
 await js('document.querySelector("#next-llama-model-start").click();document.querySelector("#next-llama-model-start").click()');
 await wait('document.querySelector("#next-llama-default-feedback").textContent.includes("Ready in")');
 assert.equal(await js('calls.filter(c=>c.route==="/api/local-models/load").length'),1);
 assert.equal(await js('calls.filter(c=>c.route==="/api/local-models/config"&&c.method==="POST").length'),1);
 await new Promise(r=>setTimeout(r,150));
 await writeFile(path.join(out,'loaded-390.png'),(await win.webContents.capturePage()).toPNG());
 await js('window.picked=["C:\\\\Models\\\\second.gguf"];document.querySelector("#next-llama-model-browse").click()');
 await wait('document.querySelector("#next-llama-model-name").value==="second"');
 await js('document.querySelector("#next-llama-model-start").click()');
 await wait('document.querySelector("#next-llama-default-feedback").textContent.includes("Loaded second")');
 assert.equal(await js('calls.filter(c=>c.route==="/api/local-models/load").length'),2);
 assert.equal(await js('calls.filter(c=>c.route==="/api/local-models/config"&&c.method==="POST").at(-1).body.settings.modelPaths.research'), 'C:\\Models\\research.gguf');
 await new Promise(r=>setTimeout(r,150));
 await writeFile(path.join(out,'second-model-390.png'),(await win.webContents.capturePage()).toPNG());
 assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'rendered.json'),JSON.stringify({passed:true,results,errors,fixtureOnly:true,realModelStarted:false},null,2));
 console.log('Rendered acceptance passed '+JSON.stringify(results));
}catch(e){console.error(e);await writeFile(path.join(out,'rendered.json'),JSON.stringify({passed:false,error:String(e)}));process.exitCode=1;}finally{win.destroy();await new Promise(r=>server.close(r));app.quit();await rm(profile,{recursive:true,force:true}).catch(()=>{});}

} app.disableHardwareAcceleration(); app.whenReady().then(main).catch(e=>{console.error(e);app.exit(1);});