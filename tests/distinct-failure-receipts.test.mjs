import test from 'node:test';
import assert from 'node:assert/strict';
import {retainToolFailureHistory} from '../public/next/chat/tool-failure.mjs';
import {searchRunActivity,searchTaskFailures,activityQuery} from '../lib/run-activity-view.mjs';
import {handleConversationActivityHttp} from '../lib/conversation-activity-http.mjs';
import {projectTurnReceipts} from '../lib/turn-receipts.mjs';

const stamp=n=>new Date(Date.UTC(2026,10,26,14,0,n)).toISOString();
const failed=(n,code,options={})=>({
 at:stamp(n),nodeId:'agent',runId:'turn-a',
 data:{type:'tool.result',tool:options.tool||'relay_browser',action:options.action||'click',code,success:false,
   callId:'distinct-call-'+n,...(typeof options.inputDispatched==='boolean'?{inputDispatched:options.inputDispatched}:{})}
});
const run=(id,history)=>({id,taskId:'root',updatedAt:stamp(220),nodes:{agent:{}},events:[],toolFailureHistory:history});

test('one rare historical failure survives two hundred repetitive failures and stays discoverable after receipt rollover',()=>{
 let history=retainToolFailureHistory(undefined,failed(1,'CAPTURE_CRITICAL',{tool:'relay_workspace',action:'read'}));
 for(let n=2;n<=202;n++)history=retainToolFailureHistory(history,failed(n,'BROWSER_REF_STALE',{inputDispatched:false}));
 assert.equal(history.total,202);
 assert.equal(history.receipts.length,128);
 assert.ok(!history.receipts.some(row=>row.code==='CAPTURE_CRITICAL'));
 assert.equal(history.distinctKinds.length,2);
 const family={rootId:'root',runs:[run('turn-a',history)]};
 const distinct=searchTaskFailures(family,{view:'failures',distinct:true,limit:1});
 assert.equal(distinct.totalMatches,2,'pagination is over distinct classes, not over repeats');
 assert.equal(distinct.occurrenceTotal,202);
 assert.equal(distinct.nextOffset,1);
 assert.equal(distinct.coverage.omittedFailures,74);
 assert.equal(distinct.coverage.missingSummary,0,'rare historical type must survive receipt rollover');
 const page=searchTaskFailures(family,{view:'failures',distinct:true,offset:1,limit:1,revision:distinct.revision});
 const all=[...distinct.items,...page.items];
 const rare=all.find(item=>item.text.includes('CAPTURE_CRITICAL'));
 assert.ok(rare,'rare historical class remains visible');
 assert.equal(rare.count,1);
 assert.equal(rare.retainedCount,0);
 const drill=searchTaskFailures(family,{view:'failures',group:rare.groupId});
 assert.equal(drill.totalMatches,0,'do not fabricate an individual receipt that was pruned');
 assert.equal(drill.occurrenceTotal,1);
 const common=all.find(item=>item.text.includes('BROWSER_REF_STALE'));
 assert.equal(common.count,201);
 assert.equal(searchTaskFailures(family,{view:'failures',group:common.groupId,limit:30}).totalMatches,128);
 assert.equal(searchTaskFailures(family,{view:'failures',q:'CAPTURE_CRITICAL',distinct:true}).totalMatches,1);
 assert.equal(searchTaskFailures(family,{view:'failures',q:'distinct-call-202',distinct:true}).items[0].count,1);
 assert.ok(!JSON.stringify(distinct).includes('PRIVATE'));
});

test('group identity includes dispatch proof; distinct groups merge across turns without hiding different consequences',()=>{
 let first=retainToolFailureHistory(undefined,failed(3,'BROWSER_INPUT_DOCUMENT_CHANGED',{inputDispatched:false}));
 first=retainToolFailureHistory(first,failed(4,'BROWSER_INPUT_DOCUMENT_CHANGED',{inputDispatched:false}));
 const second=retainToolFailureHistory(undefined,failed(8,'BROWSER_INPUT_DOCUMENT_CHANGED'));
 const third=retainToolFailureHistory(undefined,failed(10,'BROWSER_INPUT_DOCUMENT_CHANGED',{inputDispatched:false}));
 const family={rootId:'root',runs:[run('turn-a',first),run('turn-b',second),run('turn-c',third)]};
 const result=searchTaskFailures(family,{view:'failures',distinct:true});
 assert.equal(result.totalMatches,2);
 assert.equal(result.occurrenceTotal,4);
 assert.equal(result.items.find(g=>g.count===3).runCount,2);
 assert.equal(result.items.find(g=>g.count===1).attention,'effect not confirmed');
 assert.equal(searchTaskFailures(family,{view:'failures',distinct:true,limit:1}).nextOffset,1);
 assert.equal(searchTaskFailures(family,{view:'failures'}).totalMatches,4);
 const foreign=searchTaskFailures({rootId:'root',runs:[...family.runs,{...run('foreign',first),taskId:'elsewhere'}]},{view:'failures',distinct:true});
 assert.equal(foreign.occurrenceTotal,4);
});

test('legacy failures without trusted fingerprints remain separate and unclassified',()=>{
 const events=[1,2,3].map(n=>({at:stamp(n),nodeId:'agent',runId:'turn-a',
   data:{type:'tool.result',tool:'relay_browser',action:'click',code:'BROWSER_ACTION_FAILED',success:false,rawSecret:'PRIVATE'}}));
 const result=searchRunActivity({id:'turn-a',events,updatedAt:stamp(4)},{view:'failures',distinct:true});
 assert.equal(result.totalMatches,3);
 assert.ok(result.items.every(item=>item.attention==='unclassified'));
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('bad distinct/group parameters cannot change other activity categories',async()=>{
 for(const args of [{distinct:true,view:'tools'},{group:'fg-hack',view:'failures'},{distinct:true,group:'fg-'+'a'.repeat(64),view:'failures'}])
   assert.throws(()=>activityQuery(args),{code:'ACTIVITY_QUERY'});
 const data=[],family={rootId:'root',runs:[run('turn-a',retainToolFailureHistory(undefined,failed(5,'BROWSER_REF_STALE')))]};
 const req=url=>handleConversationActivityHttp({req:{method:'GET',url},res:{},
  pathname:'/api/conversations/turn-a/activity',conversations:{family:async()=>family,get:async()=>family.runs[0]},
  json:(_res,status,body)=>data.push({status,body})});
 await assert.rejects(req('/api/conversations/turn-a/activity?view=failures&scope=task&distinct=bogus'),{code:'ACTIVITY_QUERY'});
 await req('/api/conversations/turn-a/activity?view=failures&scope=task&distinct=1');
 assert.equal(data[0].status,200);
 assert.equal(data[0].body.items[0].grouped,true);
});


test('matching later success is counted without declaring the original task complete',()=>{
 const key='f'.repeat(64);
 const failed={at:stamp(40),nodeId:'agent',data:{type:'tool.result',tool:'relay_browser',action:'click',
   code:'BROWSER_REF_STALE',success:false,operationKey:key,callId:'failed-call'}};
 let history=retainToolFailureHistory(undefined,failed);
 history=retainToolFailureHistory(history,{at:stamp(41),nodeId:'agent',
   data:{type:'tool.result',tool:'relay_browser',action:'click',success:true,operationKey:key,callId:'retry-success'}});
 assert.equal(history.receipts[0].recovered,true);
 assert.equal(history.distinctKinds[0].recoveredCount,1);
 const view=searchTaskFailures({rootId:'root',runs:[run('turn-a',history)]},{view:'failures',distinct:true});
 assert.match(view.items[0].text,/"followedByMatchingToolSuccess": 1/);
 assert.match(view.items[0].text,/"withoutRecordedMatchingSuccess": 0/);
});

test('distinct index cap is explicitly reported instead of silently declaring comprehensive coverage',()=>{
 let history;
 for(let n=0;n<261;n++)history=retainToolFailureHistory(history,failed(n+1,'DISTINCT_KIND_'+n));
 assert.equal(history.distinctKinds.length,256);
 assert.equal(history.distinctOverflow,5);
 const result=searchTaskFailures({rootId:'root',runs:[run('turn-a',history)]},{view:'failures',distinct:true});
 assert.equal(result.coverage.distinctOverflow,5);
 assert.equal(result.totalMatches,261); // Five unindexed types remain visible while their individual receipts are retained.
 assert.equal(result.coverage.missingSummary,0);
});


test('task-scoped distinct indices cannot surface another worker node',()=>{
 const event={at:stamp(3),nodeId:'foreign',data:{type:'tool.result',tool:'relay_browser',
   action:'click',code:'BROWSER_REF_STALE',success:false,callId:'foreign-call'}};
 const history=retainToolFailureHistory(undefined,event);
 const value=run('turn-a',history);
 assert.equal(searchTaskFailures({rootId:'root',runs:[value]},{view:'failures',distinct:true}).totalMatches,0);
 assert.equal(projectTurnReceipts(value,{view:'failures',distinct:true}).actions.length,0);
});

test('legacy Activity uses explicit recorded error metadata when it is still available', () => {
 const row=failed(1,'BROWSER_CAPTURE_TIMEOUT',{inputDispatched:false});
 row.data.message='SECRET_LEGACY_MESSAGE';
 const state={...run('turn-a'),events:[row]};
 const result=searchRunActivity(state,{view:'failures',distinct:true});
 assert.equal(result.totalMatches,1);
 assert.equal(result.items[0].attention,'input not dispatched');
 assert.match(result.items[0].title,/BROWSER_CAPTURE_TIMEOUT/);
 assert.doesNotMatch(JSON.stringify(result),/SECRET_LEGACY_MESSAGE/);
});
