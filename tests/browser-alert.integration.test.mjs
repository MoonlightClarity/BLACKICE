import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,open} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
for(const mode of ['live','offscreen'])test('native '+mode+' informational alert releases without focus or effect replay',{skip:process.env.RELAY_LIVE_BROWSER_QA!=='1',timeout:40000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-alert-'));let passed=false;
 t.after(async()=>{if(passed)await rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:100});});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const executable=process.env.BLACKICE_QA_ELECTRON||createRequire(import.meta.url)('electron');
 const log=await open(path.join(dir,'electron.log'),'wx');
 const child=spawn(executable,[fileURLToPath(new URL('./fixtures/browser-alert-live.mjs',import.meta.url)),'--fixture-data='+dir,'--fixture-mode='+mode],{env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
 const timer=setTimeout(()=>child.kill(),30000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>clearTimeout(timer));await log.close();
 const report=JSON.parse(await readFile(path.join(dir,'result.json'),'utf8'));console.log(JSON.stringify(report));
 assert.equal(code,0,JSON.stringify(report)+' Evidence: '+dir);assert.equal(report.ok,true);passed=true;
});
