import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

test('isolated native browser recovers same-control drift and preserves input/observation boundaries across action types',
 {skip:process.env.RELAY_LIVE_BROWSER_QA!=='1'&&'Set RELAY_LIVE_BROWSER_QA=1 for the isolated native fixture.',timeout:55000},async t=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-stability-regression-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const require=createRequire(import.meta.url);
 const child=spawn(require('electron'),[fileURLToPath(new URL('./fixtures/browser-stabilization-probe.mjs',import.meta.url)),'--fixture-data='+dir],{env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>output=(output+b.toString()).slice(-6000));
 const timer=setTimeout(()=>child.kill(),45000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer));
 const report=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
 assert.equal(code,0,report.error||report.shutdownError||output);
 assert.equal(report.ok,true,report.error);
 assert.equal(report.checks.length,11,JSON.stringify(report));
});
