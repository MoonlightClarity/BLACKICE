import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {normalizeResourceUrl,directResourceKeys} from '../lib/direct-resource-history.mjs';
const url='https://example.com/resource/42?id=one';
const scopes=['browser:read'];
async function harness(t){
 const dir=await mkdtemp(path.join(tmpdir(),'resource-history-')), stores=[];
 t.after(async()=>{for(const s of stores)await s.close();await rm(dir,{recursive:true,force:true});});
 return ()=>{const s=new DirectExecutionJobs({dataDir:dir});stores.push(s);return s;};
}
async function add(s,id,{ownerId='owner',resource=url,requiredScopes=scopes,result,status='succeeded'}={}){
 const {job}=await s.admit({ownerId,requestId:id,tool:'blackice_browser_read',arguments:{action:'read',expectedUrl:resource},requiredScopes,client:{id:ownerId,scopes:requiredScopes},mutating:false});
 return s.update(job.id,()=>({status,dispatched:true,finishedAt:new Date().toISOString(),result:result===undefined?{success:true,contentItems:[{type:'inputText',text:JSON.stringify({url:resource,text:'Observed confirmation, not independent proof'})}]}:result}));
}
const query=(s,extra={})=>s.resourceHistory({ownerId:'owner',scopes,urls:[url],...extra});
test('URL identity preserves resource query, ordering and path; only tracking and fragment stripped',()=>{
 assert.equal(normalizeResourceUrl(url+'&utm_source=x#part'),url);
 assert.equal(normalizeResourceUrl('https://x.test/?a=1&&b=2'), 'https://x.test/?a=1&&b=2');
 assert.notEqual(normalizeResourceUrl(url),normalizeResourceUrl(url.replace('one','two')));
 assert.notEqual(normalizeResourceUrl('https://x.test/?a=1&b=2'),normalizeResourceUrl('https://x.test/?b=2&a=1'));
 assert.notEqual(normalizeResourceUrl('https://x.test/item/1'),normalizeResourceUrl('https://x.test/item/1/apply'));
 assert.equal(normalizeResourceUrl('https://x.test/item/1/apply',{aliases:[{from:'https://x.test/item/1/apply',to:'https://x.test/item/1'}]}),'https://x.test/item/1');
 assert.equal(normalizeResourceUrl('https://user:password@x.test/'),null);
 assert.equal(normalizeResourceUrl('file:///secret'),null);
});
test('private inputs and arbitrary links are not indexed; observed connected result is supported',()=>{
 assert.deepEqual(directResourceKeys({tool:'blackice_browser_action',arguments:{action:'fill',expectedUrl:url},result:{contentItems:[{type:'inputText',text:JSON.stringify({url})}]}}),[]);
 assert.deepEqual(directResourceKeys({tool:'blackice_run_command',arguments:{url}}),[]);
 assert.deepEqual(directResourceKeys({tool:'blackice_connected_browser_action',arguments:{argumentsOmitted:true},result:{contentItems:[{type:'inputText',text:JSON.stringify({result:{url}})}]}}),[url]);
 assert.deepEqual(directResourceKeys({tool:'blackice_connected_browser_action',arguments:{arguments:{url}},result:null}),[]);
});
test('automatic durable backfill survives reopen and preserves uncertain outcomes',async t=>{
 const make=await harness(t),s=make();const prior=await add(s,'day-one');
 await add(s,'different',{resource:url.replace('one','two')});
 await s.close();const reopened=make(),r=await query(reopened);
 assert.equal(r.observations.length,1);assert.equal(r.observations[0].jobId,prior.id);
 assert.equal(r.observations[0].outcome,'unknown');assert.equal(r.outcome,'unknown');
 assert.equal((await query(reopened,{excludeJobId:prior.id})).observations.length,0);
});
test('owner and all required scopes isolate both matches and payloads',async t=>{
 const make=await harness(t),s=make();await add(s,'foreign',{ownerId:'other'});
 await add(s,'restricted',{requiredScopes:['browser:read','files:read']});
 assert.equal((await query(s)).observations.length,0);
 assert.equal((await query(s,{scopes:['browser:read','files:read']})).observations.length,1);
 assert.equal((await query(s,{ownerId:'other'})).observations.length,1);
});
test('missing and interrupted receipts never imply success',async t=>{
 const make=await harness(t),s=make();
 assert.equal((await query(s)).observations.length,0);
 await add(s,'interrupted',{status:'interrupted',result:null});
 const r=await query(s);assert.equal(r.observations[0].resultAvailable,false);assert.equal(r.observations[0].outcome,'unknown');
});
test('bounded query hydrates only selected matches and limits evidence',async t=>{
 const make=await harness(t),s=make();
 for(let i=0;i<24;i++)await add(s,'item-'+i,{result:{success:true,contentItems:[{type:'inputText',text:'x'.repeat(10000)}]}});
 let reads=0;const original=s.fullRecord.bind(s);s.fullRecord=async v=>{reads++;return original(v);};
 const r=await query(s,{limit:3});assert.equal(reads,3);assert.equal(r.observations.length,3);assert.equal(r.truncated,true);
 assert.equal(r.observations[0].observation.length,1600);assert.equal(r.observations[0].observationTruncated,true);
 await assert.rejects(query(s,{limit:21}));
});
