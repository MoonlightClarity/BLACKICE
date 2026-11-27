import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

test('native Chromium capture observes fresh compositor state across parked, resized and offscreen views', {
 skip: process.env.RELAY_LIVE_BROWSER_QA!=='1' && 'Set RELAY_LIVE_BROWSER_QA=1 for isolated native browser stress testing.',
 timeout:80000
},async t=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-engine-stress-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const require=createRequire(import.meta.url),fixture=fileURLToPath(new URL('./fixtures/browser-engine-stress-probe.mjs',import.meta.url));
 const child=spawn(require('electron'),[fixture,'--fixture-data='+dir],{env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>output=(output+b.toString()).slice(-6000));
 const timer=setTimeout(()=>child.kill(),75000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer));
 const report=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
 assert.equal(code,0,report.error||output);assert.equal(report.ok,true,report.error);
 assert.equal(report.summary.length,3);
 assert.deepEqual(report.summary.map(row=>row.trials),[24,12,3]);
 for(const row of report.summary){
   assert.equal(row.errors,0,JSON.stringify(row));assert.equal(row.zeroFrames,0,JSON.stringify(row));assert.equal(row.wrongHit,0,JSON.stringify(row));assert.equal(row.wrongClick,0,JSON.stringify(row));
   const synchronized=row.captureMethods.find(item=>item.name==='native-after-two-frames');
   assert.equal(synchronized.trials,row.trials);assert.equal(synchronized.wrong,0,JSON.stringify(row));assert.equal(synchronized.errors,0,JSON.stringify(row));
 }
 assert.equal(report.modes[1].sameWebContents,true);
});