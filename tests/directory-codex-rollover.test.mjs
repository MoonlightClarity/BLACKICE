import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexRuntime} from '../lib/codex.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

test('Directory rollover consumes the actual Codex typed failure only after durable tool settlement',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-codex-rollover-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const native=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'fixture'});
 native._send=()=>{};native._emitRun=()=>{};
 let effects=0,sessions=0,runner,release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const tool={type:'function',name:'fixture_export',description:'Synthetic effect',inputSchema:{type:'object'}};
 const runtime={runAgent:async options=>{
  if(++sessions===2){
   assert.equal(effects,1);assert.equal(native.threads.size,0);
   const rows=await runner.actionJournal.events();const outcome=rows.find(r=>r.event.kind==='outcome');
   assert.equal(outcome.event.result.success,true);
   assert.match((await runner.actionJournal.inspect({id:outcome.id,source:true})).text,/export receipt/);
   return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Export receipt retained',candidate_answer:'Verified',uncertainty:''})};
  }
  let reject;const result=new Promise((_resolve,no)=>reject=no);result.catch(()=>{});
  const state={threadId:'old',turnId:'turn',messages:new Map(),dynamicTools:[tool],toolController:new AbortController(),approvalCancels:new Set(),toolCalls:new Set(),keepLoaded:true,reject,onToolCall:options.onToolCall};
  native.threads.set('old',state);
  const call=native._dynamicToolCall({id:1,params:{threadId:'old',turnId:'turn',tool:tool.name,callId:'export',arguments:{}}});
  await started;
  native._notification('turn/completed',{threadId:'old',turn:{id:'turn',status:'failed',items:[],error:{message:'capacity',codexErrorInfo:'contextWindowExceeded'}}});
  assert.equal(sessions,1);release();await call;return result;
 }};
 runner=new ShadowdancerDirectory({cwd,conversationId:'fixture',runId:'run',model:'fixture',runtime,actionDirectory:true,baseTools:[tool],
  getAuthoritativeContext:async()=> 'Keep the source; never repeat a completed export.',
  dispatchTool:async()=>{entered();await gate;effects++;return {success:true,contentItems:[{type:'inputText',text:'export receipt 1'}]};}});
 await runner.open();await runner.infer('work','modules/1',{objective:'Export once and verify receipt',doneWhen:'One verified export'});
 assert.equal(sessions,2);assert.equal(effects,1);
});
