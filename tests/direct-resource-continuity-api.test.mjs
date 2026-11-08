import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DirectExecutionAPI,DIRECT_EXECUTION_SCOPES} from '../lib/direct-execution-api.mjs';
const client={id:'continuity-owner',label:'Test',kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
const receipt=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'direct-continuity-'));
 const api=new DirectExecutionAPI({dataDir:root,allowedRoot:root}); await api.init();
 t.after(async()=>{await api.close();await rm(root,{recursive:true,force:true});});
 return api;
}
async function saved(api,id,url,{who=client,scopes=['browser:read'],text='Observed page'}={}) {
 const {job}=await api.jobs.admit({ownerId:who.id,requestId:id,tool:'blackice_browser_read',arguments:{action:'read',url},requiredScopes:scopes,client:who,mutating:false});
 await api.jobs.update(job.id,()=>({status:'succeeded',dispatched:true,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),result:receipt({url,text})}));
 await new Promise(r=>setTimeout(r,3)); return job.id;
}
test('getJob automatically returns earlier resource receipts without treating them as task success',async t=>{
 const api=await fixture(t),url='https://example.test/orders/42';
 const prior=await saved(api,'prior',url,{text:'Destination displayed order receipt'});
 const current=await saved(api,'current',url);
 const result=await api.getJob(current,client);
 assert.equal(result.resourceHistory.observations.length,1);
 assert.equal(result.resourceHistory.observations[0].jobId,prior);
 assert.equal(result.outcomeVerification.status,'not-assessed');
 assert.equal(result.outcomeVerification.successDelta,null);
 const original=await api.jobs.get(current,{ownerId:client.id});
 assert.equal(JSON.stringify(original.result).includes('resourceHistory'),false);
 assert.equal((await api.getJob(current,client,{offset:1})).resourceHistory,undefined);
});
test('different resources do not imply an absent lifetime outcome; missing recall is explicit',async t=>{
 const api=await fixture(t);
 await saved(api,'first','https://example.test/orders/1');
 const id=await saved(api,'second','https://example.test/orders/2');
 const result=await api.getJob(id,client);
 assert.equal(result.resourceHistory.observations.length,0);
 assert.equal(result.resourceHistory.outcome,'unknown');
 api.jobs.resourceHistory=async()=>{throw Error('disk read failed');};
 const failed=await api.getJob(id,client);
 assert.equal(failed.resourceHistory.available,false);
 assert.equal(failed.result.success,true);
});
test('scope loss during history enrichment never releases historical receipt',async t=>{
 const api=await fixture(t),url='https://example.test/orders/3';
 await saved(api,'prior-private',url,{scopes:['browser:read','files:read']});
 const id=await saved(api,'current-public',url);
 const restricted={...client,scopes:['read','browser:read']};
 assert.equal((await api.getJob(id,restricted)).resourceHistory.observations.length,0);
});
