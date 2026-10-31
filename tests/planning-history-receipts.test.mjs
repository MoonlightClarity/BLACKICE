import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createKnowledgeToolHandler} from '../lib/knowledge.mjs';

const cwd=path.join(tmpdir(),'blackice-history-receipts-fixture');
const stamp='2026-10-31T00:01:02.000Z';
const confirmation='The request was recorded. Receipt: record-branch-47.';
const event=(data,{nodeId='agent',at=stamp}={})=>({type:'agent.event',runId:'cancelled-turn',nodeId,at,data:{threadId:'thread-original',turnId:'turn-original',...data}});
const nativeReceipt=(callId,text,extra={})=>event({type:'item',stage:'completed',duringSettlement:true,item:{type:'dynamicToolCall',id:callId,tool:'relay_browser',arguments:{action:'getText',tabId:'tab-original'},status:'completed',success:true,contentItems:[{type:'inputText',text}],...extra}});
const savedRun=(events=[],extra={})=>({id:'cancelled-turn',cwd,workflowName:'Record task',status:'cancelled',settled:true,input:'Complete the requested record task.',output:'',error:'Interrupted after tool completion.',createdAt:stamp,finishedAt:stamp,workflow:{nodes:[{id:'agent',name:'Record worker'}]},nodes:{agent:{status:'cancelled',output:''}},events,...extra});
const handlerFor=runs=>createKnowledgeToolHandler({store:{},cwd,runId:'current-turn',getRuns:async()=>runs});
const invoke=async(handler,args)=>{
  const response=await handler({name:'relay_history',arguments:args});
  assert.equal(response.success,true);
  assert.equal(response.contentItems[0].type,'inputText');
  return {response,result:JSON.parse(response.contentItems[0].text)};
};

test('history reads recover completed observations from a cancelled run with no final answer',async()=>{
  const run=savedRun([
    nativeReceipt('confirmation-call',confirmation),
    event({type:'tool.result',tool:'relay_browser',action:'getText',callId:'confirmation-call',status:'completed',success:true,message:'Browser call completed.',duringSettlement:true}),
  ]),before=structuredClone(run),{result}=await invoke(handlerFor([run]),{action:'read',id:run.id});
  assert.equal(result.run.status,'cancelled');
  assert.equal(result.run.output,'');
  assert.equal(result.run.nodes[0].status,'cancelled');
  assert.ok(Array.isArray(result.run.toolReceipts),'saved completed observations must be accessible');
  const receipt=result.run.toolReceipts.find(item=>item.type==='dynamicToolCall');
  assert.match(receipt.text,/record-branch-47/);
  assert.equal(receipt.runId,run.id);
  assert.equal(receipt.nodeId,'agent');
  assert.equal(receipt.callId,'confirmation-call');
  assert.equal(receipt.threadId,'thread-original');
  assert.equal(receipt.turnId,'turn-original');
  assert.equal(receipt.at,stamp);
  assert.equal(receipt.status,'completed');
  assert.equal(receipt.success,true);
  assert.equal(receipt.duringSettlement,true);
  assert.ok(result.run.toolReceipts.some(item=>item.type==='tool.result'&&item.callId==='confirmation-call'),'summary must not replace the richer returned observation');
  assert.deepEqual(run,before,'history retrieval must not rewrite the saved run');
});

test('history search discovers receipt-only evidence and returns its provenance within the existing scope',async()=>{
  const run=savedRun([nativeReceipt('confirmation-call',confirmation)]),other=savedRun([nativeReceipt('other-call',confirmation)],{id:'other-workspace',cwd:path.join(tmpdir(),'blackice-other-workspace')}),current=savedRun([nativeReceipt('current-call',confirmation)],{id:'current-turn'});
  const {result}=await invoke(handlerFor([run,other,current]),{action:'search',query:'record-branch-47'});
  assert.equal(result.totalMatches,1);
  assert.equal(result.results[0].id,run.id);
  assert.match(result.results[0].excerpt,/record-branch-47/);
  assert.equal(result.results[0].matchedReceipt.runId,run.id);
  assert.equal(result.results[0].matchedReceipt.nodeId,'agent');
  assert.equal(result.results[0].matchedReceipt.callId,'confirmation-call');
  const focused=await invoke(handlerFor([run]),{action:'read',id:run.id,query:'confirmation-call'});
  assert.match(focused.result.run.toolReceipts[0].text,/record-branch-47/);
});

test('API and native terminal receipts preserve success and failure without inferring an external outcome',async()=>{
  const run=savedRun([
    event({type:'item',item:{type:'dynamicToolCall',id:'click-call',name:'relay_browser',arguments:{action:'click',selector:'#send'},status:'completed',success:true,contentItems:[{type:'inputText',text:'Clicked Send.'}]}}),
    event({type:'item',stage:'completed',item:{type:'commandExecution',id:'command-call',command:'read-record',status:'completed',exitCode:0,aggregatedOutput:'Saved record number: native-record-19.'}}),
    event({type:'item',stage:'completed',item:{type:'mcpToolCall',id:'connector-call',server:'records',tool:'get_record',status:'completed',result:{content:[{type:'text',text:'Connected record number: connector-record-23.'}]}}}),
    event({type:'tool.result',callId:'failed-call',tool:'relay_browser',action:'getText',status:'failed',success:false,code:'BROWSER_UNAVAILABLE',message:'The page could not be read.'}),
  ]),{result,response}=await invoke(handlerFor([run]),{action:'read',id:run.id});
  assert.ok(Array.isArray(result.run.toolReceipts));
  const click=result.run.toolReceipts.find(item=>item.callId==='click-call'),failed=result.run.toolReceipts.find(item=>item.callId==='failed-call');
  assert.equal(click.tool,'relay_browser');
  assert.equal(click.success,true);
  assert.match(click.text,/Clicked Send/);
  assert.equal(failed.success,false);
  assert.equal(failed.status,'failed');
  assert.equal(failed.code,'BROWSER_UNAVAILABLE');
  assert.ok(result.run.toolReceipts.some(item=>item.callId==='command-call'&&item.text.includes('native-record-19')));
  assert.ok(result.run.toolReceipts.some(item=>item.callId==='connector-call'&&item.text.includes('connector-record-23')));
  assert.doesNotMatch(response.contentItems[0].text,/submitted|submission|applicationConfirmed/,'a successful click is only the recorded click result');
});

test('history excludes unfinished tool calls and non-tool reasoning from receipt reads and searches',async()=>{
  const run=savedRun([
    event({type:'item',stage:'started',item:{type:'dynamicToolCall',id:'unfinished-native',tool:'relay_browser',status:'inProgress',contentItems:[{type:'inputText',text:'UNFINISHED_NATIVE_MARKER'}]}}),
    event({type:'item',item:{type:'dynamicToolCall',id:'unfinished-api',name:'relay_browser',status:'inProgress',contentItems:[{type:'inputText',text:'UNFINISHED_API_MARKER'}]}}),
    event({type:'item',stage:'completed',item:{type:'reasoning',id:'reasoning-item',text:'PRIVATE_REASONING_MARKER'}}),
    nativeReceipt('observed-call','A bounded observation was returned.'),
  ]),handler=handlerFor([run]),{result,response}=await invoke(handler,{action:'read',id:run.id});
  assert.equal(result.run.toolReceipts?.length,1);
  assert.doesNotMatch(response.contentItems[0].text,/UNFINISHED_|PRIVATE_REASONING/);
  for(const query of ['UNFINISHED_NATIVE_MARKER','UNFINISHED_API_MARKER','PRIVATE_REASONING_MARKER'])assert.equal((await invoke(handler,{action:'search',query})).result.totalMatches,0);
});

test('bounded history reads can focus a confirmation near the tail of a large retained receipt',async()=>{
  const marker='TAIL_CONFIRMATION_83',longReceipt='Earlier page text. '.repeat(9000)+marker+' was observed in the returned page.';
  const run=savedRun([
    nativeReceipt('older-confirmation',longReceipt),
    ...Array.from({length:60},(_,index)=>nativeReceipt('later-call-'+index,'Unrelated later observation. '.repeat(2000))),
  ]),handler=handlerFor([run]);
  const ordinary=await invoke(handler,{action:'read',id:run.id});
  assert.equal(ordinary.result.truncated,true);
  assert.ok(ordinary.response.contentItems[0].text.length<=43000);
  const search=await invoke(handler,{action:'search',query:marker});
  assert.equal(search.result.totalMatches,1);
  assert.match(search.result.results[0].excerpt,new RegExp(marker));
  assert.equal(search.result.results[0].matchedReceipt.callId,'older-confirmation');
  const focused=await invoke(handler,{action:'read',id:run.id,query:marker,limit:1});
  assert.equal(focused.result.run.toolReceipts.length,1);
  assert.equal(focused.result.run.toolReceipts[0].callId,'older-confirmation');
  assert.match(focused.result.run.toolReceipts[0].text,new RegExp(marker));
  assert.equal(focused.result.truncated,true);
  assert.equal(focused.result.run.toolReceipts[0].truncated,true);
  assert.ok(focused.result.run.toolReceipts[0].textLength>focused.result.run.toolReceipts[0].text.length);
  assert.ok(focused.response.contentItems[0].text.length<=43000);
});
