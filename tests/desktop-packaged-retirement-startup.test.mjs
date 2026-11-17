import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const executable=process.env.BLACKICE_PACKAGED_STARTUP_QA_EXE;
const sourceDirectory=process.env.BLACKICE_DESKTOP_STARTUP_QA_SOURCE;
const title=sourceDirectory?'real Electron source desktop main reaches ready with UIA retired and no launcher window':'real packaged desktop main reaches ready with UIA retired and no launcher window';
test(title, {skip:!executable,timeout:120000},async t=>{
 assert.equal(process.platform,'win32');assert.ok(path.isAbsolute(executable));
 const root=await mkdtemp(path.join(tmpdir(),'blackice-packaged-startup-'));
 const profile=path.join(root,'profile'),appdata=path.join(root,'appdata');
 await mkdir(appdata,{recursive:true});
 const args=[...(sourceDirectory?[sourceDirectory]:[]),'--headless','--profile-dir',profile];
 const child=spawn(executable,args,{windowsHide:true,env:{...process.env,APPDATA:appdata,LOCALAPPDATA:path.join(root,'localappdata')},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',exit=null,exited=false,spawnError=null;
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const done=new Promise(resolve=>{child.once('exit',(code,signal)=>{exit={code,signal};exited=true;resolve();});child.once('error',error=>{spawnError={code:error.code,message:error.message};exited=true;resolve();});});
 let runtime,cookie,trace,desktop;const evidence={root,executable,args,pid:child.pid};
 t.after(async()=>{
  if(!exited&&runtime?.url&&cookie){try{await fetch(runtime.url+'/api/shutdown',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});}catch{}}
  await Promise.race([done,delay(10000)]);if(!exited){child.kill();await Promise.race([done,delay(5000)]);}
  Object.assign(evidence,{exit,exited,spawnError,stdout,stderr,runtime,trace,desktop,sourceDirectory});
  await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log('Desktop startup evidence: '+path.join(root,'evidence.json'));
  if(!spawnError){assert.equal(exited,true,'fixture process must exit');assert.equal(exit?.code,0,'fixture must shut down cleanly');}
 });
 const until=Date.now()+90000;
 while(Date.now()<until&&!exited){
  try{runtime=JSON.parse(await readFile(path.join(profile,'desktop-runtime.json'),'utf8'));
   const files=await readdir(path.join(profile,'diagnostics','startup-critical'));
   for(const file of files.filter(x=>/^launch-.*\.json$/.test(x))){const value=JSON.parse(await readFile(path.join(profile,'diagnostics','startup-critical',file),'utf8'));if(value.state?.outcome==='ready')trace=value;}
   if(trace)break;
  }catch{}
  await delay(200);
 }
 assert.equal(exited,false,'launcher exited: '+JSON.stringify(spawnError)+' '+stderr);assert.ok(trace,'real desktop-ready checkpoint missing');
 assert.equal(runtime.pid,child.pid);assert.equal(runtime.lifecycle.mode,'headless');assert.equal(runtime.lifecycle.windowVisible,false);
 const home=await fetch(runtime.url+'/');cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();
 const request=await fetch(runtime.url+'/api/desktop/status',{headers:{Cookie:cookie}});desktop=await request.json();
 assert.equal(request.status,200);assert.equal(desktop.retired,true);assert.equal(desktop.enabled,false);
 const attach=await fetch(runtime.url+'/api/desktop/attach',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
 assert.equal(attach.status,410);assert.equal((await attach.json()).actionDispatched,false);
 const main=await readFile(path.join(sourceDirectory||path.join(path.dirname(executable),'resources','app'),'desktop','main.mjs'));
 const expected=await readFile(new URL('../desktop/main.mjs',import.meta.url));
 assert.deepEqual(main,expected);evidence.desktopMainSha256=createHash('sha256').update(main).digest('hex');
});
