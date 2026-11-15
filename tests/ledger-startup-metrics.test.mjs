import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DirectExecutionJobs } from '../lib/direct-execution-jobs.mjs';
import { DiagnosticsStore } from '../lib/diagnostics.mjs';
import { LEDGER_METRIC_FIELDS, LedgerStartupMetrics } from '../lib/ledger-startup-metrics.mjs';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ledger-metrics-')),stores=[];
 t.after(async()=>{await Promise.allSettled(stores.map(s=>s.close()));await fs.rm(dir,{recursive:true,force:true});});
 const make=options=>{const s=new DirectExecutionJobs({dataDir:dir,...options});stores.push(s);return s;};
 return {dir,make};
}
const admission={ownerId:'PRIVATE_OWNER',requestId:'private-request',tool:'blackice_workspace_read',arguments:{action:'read',path:'PRIVATE_PATH'},requiredScopes:['files:read'],client:{id:'PRIVATE_OWNER',scopes:['files:read']},mutating:false};
function valid(event) {
 assert.equal(event.event,'direct_jobs_startup');for(const key of LEDGER_METRIC_FIELDS)assert.ok(Number.isSafeInteger(event[key])&&event[key]>=0,key);
 assert.doesNotMatch(JSON.stringify(event),/PRIVATE_|private-request/);
}
test('startup metrics report validation, recovery and bounded counters without receipt payloads',async t=>{
 const {make}=await fixture(t),a=make();const job=(await a.admit(admission)).job;await a.close();
 const events=[],b=make({onStartupDiagnostics:e=>events.push(e)});await b.init();
 assert.equal(events.length,1);const e=events[0];valid(e);assert.equal(e.outcome,'ready');assert.equal(e.receipts,1);assert.equal(e.recovered,1);assert.ok(e.bytes>0);
 assert.equal((await b.get(job.id)).status,'interrupted');assert.equal(events.length,1);assert.equal(b.startupMetrics,null);
});
test('failed validation stays fail closed and telemetry does not expose offending content',async t=>{
 const {make,dir}=await fixture(t),a=make();const job=(await a.admit(admission)).job;await a.close();
 await fs.writeFile(path.join(dir,'direct-execution-jobs',job.id+'.json'),'PRIVATE_INVALID_JSON');
 const events=[],b=make({onStartupDiagnostics:e=>events.push(e)});
 await assert.rejects(b.init(),{code:'DIRECT_JOB_STORAGE'});assert.equal(events.length,1);valid(events[0]);assert.equal(events[0].outcome,'failed');assert.equal(events[0].stage,'scan');assert.equal(events[0].recovered,0);assert.equal(b.startupMetrics,null);
 assert.equal(await fs.readFile(path.join(dir,'direct-execution-jobs',job.id+'.json'),'utf8'),'PRIVATE_INVALID_JSON');
});
test('throwing or rejected telemetry callbacks cannot change ledger readiness',async t=>{
 const {make}=await fixture(t);
 for(const callback of [()=>{throw Error('PRIVATE_CALLBACK');},async()=>{throw Error('PRIVATE_ASYNC');}]){
  const s=make({onStartupDiagnostics:callback});await s.init();assert.equal(s.startup.phase,'ready');await s.close();
 }
});
test('diagnostics persistence accepts only the fixed metric shape and discards arbitrary text',async t=>{
 const {dir}=await fixture(t),d=new DiagnosticsStore({dataDir:dir,version:'2.39.94'});t.after(()=>d.close());
 const m=new LedgerStartupMetrics();
 // A short startup may finish before the first histogram sample. Zero is valid;
 // the persistence contract must not depend on scheduler timing.
 const e=m.finish('ready');valid(e);
 assert.equal(await d.record({...e,path:'PRIVATE_PATH',message:'PRIVATE_MESSAGE',extra:{secret:'PRIVATE_CONTENT'}}),true);
 assert.equal(d.events.length,1);assert.doesNotMatch(JSON.stringify(d.events),/PRIVATE_/);
 assert.equal(await d.record({...e,bytes:NaN}),false);
 assert.equal(await d.record({...e,stage:'PRIVATE_PATH'}),false);
 assert.equal(await d.record({...e,component:'browser'}),false);
 assert.equal(Object.keys(d.events[0]).length,LEDGER_METRIC_FIELDS.length+6);
});
test('unobserved stores do not allocate instrumentation or emit anything during later reads',async t=>{
 const {make}=await fixture(t),s=make();await s.init();assert.equal(s.startupMetrics,null);assert.equal(s.onStartupDiagnostics,null);
 const j=(await s.admit(admission)).job;await s.get(j.id);assert.equal(s.startupMetrics,null);
});
