import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {CodexRuntime} from '../lib/codex.mjs';

const call=(action,tabId='one')=>({name:'relay_browser',arguments:{action,browser:'relay',tabId,...(action==='fill'?{ref:'field-1',text:'value'}:action==='click'?{ref:'field-2'}:{})}});
const taskOwner={taskId:'test-task',runId:'test-run',nodeId:'agent'};
const setup=t=>{
 const dispatch=[];
 const driver={status:()=>({available:true,contained:true,tabs:[{tabId:'one',owner:taskOwner},{tabId:'two',owner:taskOwner}],activeTab:'one'}),perform:async args=>{
  dispatch.push(args);
  return {tabId:args.tabId,url:'https://fixture.example.test/form',documentId:args.tabId+':1',frames:[{name:'main',elements:[]}]};
 }};
 const browser=new BrowserWorkspace({driver});t.after(()=>browser.close());
 return{dispatch,handler:createBrowserToolHandler({browser,owner:taskOwner})};
};
test('OpenAI-compatible and local llama.cpp provider runtime reaches shared browser admission',async t=>{
 for(const preset of ['compatible','llamacpp']){
  const f=setup(t),events=[];
  const runtime={emitRun:(_state,event)=>events.push(event),store:{redact:value=>value}};
  const controller=new AbortController();
  const state={controller,config:{type:'compatible',preset:preset==='llamacpp'?'llamacpp':'custom',baseUrl:preset==='llamacpp'?'http://localhost:8080/v1/':'https://api.fixture.test/v1/'},
   tools:[{wireName:'relay_browser',name:'relay_browser'}],onToolCall:f.handler,toolCalls:new Set()};
  const execute=(item,n)=>ProviderRuntime.prototype.executeTool.call(runtime,state,
   {id:'call-'+n,name:item.name,arguments:JSON.stringify(item.arguments)});
  assert.equal((await execute(call('fill'),1)).success,true);
  const blocked=await execute(call('click'),2);
  assert.equal(blocked.success,false);assert.equal(blocked.code,'BROWSER_REOBSERVE_REQUIRED',preset);
  assert.equal(blocked.actionDispatched,false);
  assert.equal(f.dispatch.length,1,preset);
  const observed=await execute(call('snapshot'),3);assert.equal(observed.success,true);
  assert.equal((await execute(call('click'),31)).code,'BROWSER_REOBSERVE_REQUIRED','A provider batch cannot pre-issue a speculative next call');
  const token=JSON.parse(observed.contentItems[0].text).observationReceipt;
  assert.match(token,/^obs-[a-f0-9-]{36}$/);
  assert.equal((await execute({name:'relay_browser',arguments:{...call('click').arguments,observationReceipt:token}},4)).success,true);
  assert.deepEqual(f.dispatch.map(x=>x.action),['fill','snapshot','click'],preset);
 }
});
test('Codex native tool-call adapter reaches same shared browser admission',async t=>{
 const f=setup(t),answers=[],events=[];
 const state={turnId:'turn-fixture',dynamicTools:[{type:'function',name:'relay_browser'}],
  toolController:new AbortController(),onToolCall:f.handler,messages:new Map(),
  approvalCancels:new Set(),done:false,toolCalls:new Set()};
 const runtime={child:{},threads:new Map([['thread-fixture',state]]),
  _emitRun:(_state,event)=>events.push(event),
  _send:message=>answers.push(message),
  _cancel:(_state,error)=>{throw error}};
 const execute=async(item,n)=>{
  await CodexRuntime.prototype._dynamicToolCall.call(runtime,{
   id:n,params:{threadId:'thread-fixture',turnId:'turn-fixture',callId:'call-'+n,tool:'relay_browser',arguments:item.arguments}
  });
  return answers.at(-1)?.result;
 };
 assert.equal((await execute(call('fill'),1)).success,true);
 const blocked=await execute(call('click'),2);
 assert.equal(blocked.success,false);assert.equal(blocked.code,'BROWSER_REOBSERVE_REQUIRED');
 assert.equal(blocked.actionDispatched,false);
 assert.equal(f.dispatch.length,1);
 const observed=await execute(call('snapshot'),3);assert.equal(observed.success,true);
 assert.equal((await execute(call('click'),31)).code,'BROWSER_REOBSERVE_REQUIRED','Codex native batch cannot pre-issue a speculative next call');
 const token=JSON.parse(observed.contentItems[0].text).observationReceipt;
 assert.match(token,/^obs-[a-f0-9-]{36}$/);
 assert.equal((await execute({name:'relay_browser',arguments:{...call('click').arguments,observationReceipt:token}},4)).success,true);
 assert.deepEqual(f.dispatch.map(x=>x.action),['fill','snapshot','click']);
});
