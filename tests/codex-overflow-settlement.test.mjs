import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexRuntime} from '../lib/codex.mjs';

for(const cancel of [false,true])test('typed overflow waits for admitted native callback; cancellation='+cancel,async()=>{
 const runtime=new CodexRuntime({nativeModelMetadata:false});
 const sent=[];runtime._send=message=>sent.push(message);runtime._emitRun=()=>{};
 let release,entered,settled=false,effects=0;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 let rejectRun;const run=new Promise((_resolve,reject)=>rejectRun=reject);
 const observed=run.catch(error=>{settled=true;return error;});
 const state={threadId:'thread',turnId:'turn',messages:new Map(),dynamicTools:[{type:'function',name:'fixture_effect'}],
  toolController:new AbortController(),approvalCancels:new Set(),toolCalls:new Set(),keepLoaded:true,
  reject:rejectRun,onToolCall:async()=>{entered();await gate;effects++;return {success:true,contentItems:[]};}};
 runtime.threads.set('thread',state);
 const call=runtime._dynamicToolCall({id:1,params:{threadId:'thread',turnId:'turn',tool:'fixture_effect',callId:'one',arguments:{}}});
 await started;
 runtime._notification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'failed',items:[],error:{message:'capacity',codexErrorInfo:'contextWindowExceeded'}}});
 await Promise.resolve();assert.equal(settled,false);assert.equal(runtime.threads.has('thread'),true);
 if(cancel)state.cancelError=Object.assign(new Error('cancelled during settlement'),{code:'ABORT_ERR'});
 await runtime._dynamicToolCall({id:2,params:{threadId:'thread',turnId:'turn',tool:'fixture_effect',callId:'late',arguments:{}}});
 assert.equal(effects,0);release();await call;
 const error=await observed;assert.equal(error.code,cancel?'ABORT_ERR':'CONTEXT_OVERFLOW');
 assert.equal(effects,1);assert.equal(runtime.threads.has('thread'),false);
 assert.equal(sent.find(x=>x.id===2).result.success,false);
});
