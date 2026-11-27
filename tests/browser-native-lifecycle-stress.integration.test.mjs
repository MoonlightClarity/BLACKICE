import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

test('native renderer lifetimes and exact control input survive unrelated frame churn', {
 skip: process.env.RELAY_LIVE_BROWSER_QA!=='1' && 'Set RELAY_LIVE_BROWSER_QA=1 for isolated native browser stress testing.',
 timeout:80000
},async t=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-native-lifecycle-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const require=createRequire(import.meta.url),fixture=fileURLToPath(new URL('./fixtures/browser-native-lifecycle-stress.mjs',import.meta.url));
 const child=spawn(require('electron'),[fixture,'--fixture-data='+dir],{env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>output=(output+b.toString()).slice(-6000));
 const timer=setTimeout(()=>child.kill(),75000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer));
 const report=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
 assert.equal(code,0,report.error||output);assert.equal(report.ok,true,report.error);
 assert.equal(report.summary.trials,24);
 assert.equal(report.summary.snapshotFailures,0,JSON.stringify(report.trials));
 assert.equal(report.summary.currentRoot,24);
 assert.equal(report.summary.clickTrials,6);
 assert.equal(report.summary.clickFailures,0,JSON.stringify(report.trials));
 assert.ok(report.churn.nativeReplacements>100,'must actually exercise native frame churn');
 assert.equal(report.churn.rootRevisionAfter,report.churn.rootRevisionBefore);
 assert.equal(report.redirect.oldRefRetired,true);
 assert.equal(report.redirect.newRoot,true);
 for(const [key,value] of Object.entries(report.lifecycle))assert.equal(value,true,key);
 assert.equal(report.siblingPreserved,true);
 assert.equal(report.metrics.at(-1).contents,0);
 assert.equal(report.metrics.at(-1).renderers,0);
});