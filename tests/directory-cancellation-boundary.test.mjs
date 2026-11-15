import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
const done=()=>({output:JSON.stringify({status:'complete',nextAction:'none',finding:'Fixture work',candidate_answer:'Finished',uncertainty:''})});
const tool={type:'function',name:'fixture_effect',description:'Synthetic fixture only',inputSchema:{type:'object'}};
async function fixture(t,runtime,dispatchTool,signal){const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-cancel-native-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const runner=new ShadowdancerDirectory({cwd,conversationId:'fixture',runId:'run',model:'fixture',runtime,signal,baseTools:[tool],dispatchTool});await runner.open();return runner;}
test('cancelled Directory rejects a later tool before dispatcher entry',async t=>{
 const controller=new AbortController();let effects=0;
 const runner=await fixture(t,{runAgent:async options=>{
  controller.abort();
  await assert.rejects(options.onToolCall({name:'fixture_effect',callId:'late',arguments:{}}),{code:'DIRECTORY_ADMISSION_STOPPED',actionDispatched:false});
  return done();
 }},async()=>{effects++;return {success:true};},controller.signal);
 await assert.rejects(runner.infer('work','modules/cancel',{objective:'Synthetic task'}),{name:'AbortError'});
 assert.equal(effects,0);
});
test('cancellation after a completed effect keeps its receipt but publishes no phase completion',async t=>{
 const controller=new AbortController();let effects=0;
 const runner=await fixture(t,{runAgent:async options=>{
  await options.onToolCall({name:'fixture_effect',callId:'once',arguments:{}});controller.abort();return done();
 }},async()=>{effects++;return {success:true,contentItems:[{type:'inputText',text:'fixture receipt retained'}]};},controller.signal);
 await assert.rejects(runner.infer('work','modules/cancel',{objective:'Synthetic task'}),{name:'AbortError'});
 assert.equal(effects,1);
 const receipt=JSON.parse(await readFile(path.join(runner.turnRoot,'modules/cancel/tools/0001.json'),'utf8'));assert.equal(receipt.result.success,true);
 await assert.rejects(readFile(path.join(runner.turnRoot,'modules/cancel/output.json')),{code:'ENOENT'});
});
