
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {connectorBrowserOwner} from '../lib/connector-browser-owner.mjs';
import {stoppedBrowserOwnerStatus,activeBrowserOwnerStatus,readStoppedTabEffects} from '../lib/browser-stopped-adoption.mjs';
const engine=()=>({runs:new Map(),executionEntries:()=>[]});
async function fixture(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'connector-lifecycle-'));
 const jobs=await new DirectExecutionJobs({dataDir:dir}).init();
 t.after(async()=>{await jobs.close();await rm(dir,{recursive:true,force:true});});
 return {jobs,active:new Map()};
}
async function admit(direct,id,args={}) {
 return (await direct.jobs.admit({ownerId:'client-a',requestId:id,tool:'blackice_browser_action',arguments:{action:'click',...args},requiredScopes:['browser:write'],client:{id:'client-a',scopes:['browser:write']},mutating:true})).job;
}
test('connector lifecycle uses real durable jobs, not fictional engine run IDs',async t=>{
 const direct=await fixture(t),e=engine(),owner=connectorBrowserOwner('client-a'),other=connectorBrowserOwner('client-b');
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,true);
 const row=await admit(direct,'one');
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 assert.equal(stoppedBrowserOwnerStatus(other,e,direct).eligible,true);
 assert.equal(activeBrowserOwnerStatus(owner,e,direct),false);
 await direct.jobs.update(row.id,()=>({status:'running'}));
 assert.equal(activeBrowserOwnerStatus(owner,e,direct),true);
 await direct.jobs.update(row.id,()=>({status:'cancelling'}));
 assert.equal(activeBrowserOwnerStatus(owner,e,direct),false);
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 await direct.jobs.update(row.id,()=>({status:'interrupted',finishedAt:new Date().toISOString(),effects:{possible:true,confirmed:false}}));
 direct.active.set(row.id,{});assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 direct.active.clear();assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,true);
 const effects=await readStoppedTabEffects(owner,e,direct);
 assert.equal(effects.uncertain,true);assert.equal(effects.directJobs[0].jobId,row.id);
 assert.equal((await direct.jobs.get(row.id)).status,'interrupted');
 direct.jobs.storageError=Error('unavailable');assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);assert.equal(activeBrowserOwnerStatus(owner,e,direct),false);direct.jobs.storageError=null;
 assert.equal(stoppedBrowserOwnerStatus(owner,e).eligible,false);
 assert.equal(stoppedBrowserOwnerStatus({...owner,runId:'unknown'},e,direct).eligible,false);
});
test('conversation follows its run family and direct borrower, not stale runId or different grant',async t=>{
 const direct=await fixture(t),e=engine(),owner={taskId:'conversation-a',runId:'old-missing',nodeId:'conversation',conversationId:'conversation-a'};
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 const run={id:'newer-run',taskId:owner.taskId,status:'completed',settled:true};e.runs.set(run.id,run);
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,true);
 const row=await admit(direct,'conversation-job',{conversationId:owner.taskId});
 await direct.jobs.update(row.id,()=>({status:'running'}));
 assert.equal(activeBrowserOwnerStatus(owner,e,direct),true);assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 assert.equal(activeBrowserOwnerStatus(connectorBrowserOwner('client-a'),e,direct),false);
 await direct.jobs.update(row.id,()=>({status:'succeeded',finishedAt:new Date().toISOString(),effects:{possible:true,confirmed:true}}));
 assert.equal(direct.jobs.records.get(row.id).arguments,undefined);
 assert.equal(direct.jobs.records.get(row.id).browserConversationId,owner.taskId);
 direct.active.set(row.id,{});assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 direct.active.clear();assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,true);
 run.status='running';run.settled=false;assert.equal(activeBrowserOwnerStatus(owner,e,direct),true);assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
 run.status='completed';run.settled=true;e.executionEntries=()=>[{run}];assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,false);
});

test('connector lifecycle preserves interrupted effects across actual ledger restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'connector-lifecycle-restart-'));
 let jobs=await new DirectExecutionJobs({dataDir:dir}).init();
 t.after(async()=>{await jobs.close();await rm(dir,{recursive:true,force:true});});
 const direct={jobs,active:new Map()},e=engine(),owner=connectorBrowserOwner('client-a');
 const row=await admit(direct,'restart');
 await jobs.update(row.id,()=>({status:'running',dispatched:true,effects:{possible:true,confirmed:false}}));
 await jobs.close();jobs=await new DirectExecutionJobs({dataDir:dir}).init();direct.jobs=jobs;
 assert.equal(jobs.records.get(row.id).status,'interrupted');
 assert.equal(stoppedBrowserOwnerStatus(owner,e,direct).eligible,true);
 const inherited=await readStoppedTabEffects(owner,e,direct);
 assert.equal(inherited.uncertain,true);assert.equal(inherited.directJobs[0].jobId,row.id);
 assert.equal(activeBrowserOwnerStatus(owner,e,direct),false);
});
