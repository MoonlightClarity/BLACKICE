import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifiedWorkspaceTestReceipt} from '../lib/workspace-test-receipt.mjs';
import {HarnessEngine} from '../lib/engine.mjs';

const run={name:'relay_workspace',arguments:{action:'run',command:'node --test'}};
const good={success:true,contentItems:[{type:'inputText',text:JSON.stringify({cwd:'C:\\workspace',command:'node --test',exitCode:0,timedOut:false,truncated:false,signal:null,shell:'powershell'})}]};
test('test receipt validator requires actual successful command result and not self-reported prose',()=>{
 assert.equal(verifiedWorkspaceTestReceipt(run,good)?.command,'node --test');
 assert.equal(verifiedWorkspaceTestReceipt(run,{...good,success:false}),null);
 assert.equal(verifiedWorkspaceTestReceipt(run,{...good,contentItems:[{type:'inputText',text:'Everything passed'}]}),null);
 assert.equal(verifiedWorkspaceTestReceipt({...run,arguments:{action:'run',command:'node --test && echo ok'}},good),null,'Call and handler command must agree.');
 assert.equal(verifiedWorkspaceTestReceipt(run,{...good,contentItems:[{type:'inputText',text:JSON.stringify({...JSON.parse(good.contentItems[0].text),exitCode:1})}]}),null);
 assert.equal(verifiedWorkspaceTestReceipt(run,{...good,contentItems:[{type:'inputText',text:JSON.stringify({...JSON.parse(good.contentItems[0].text),truncated:true})}]}),null);
 assert.equal(verifiedWorkspaceTestReceipt({name:'relay_workspace',arguments:{action:'run',command:'echo ok'}},good),null);
 assert.equal(verifiedWorkspaceTestReceipt({name:'relay_workspace',arguments:{action:'read',path:'x'}},good),null);
 assert.equal(verifiedWorkspaceTestReceipt({...run,namespace:'foreign'},good),null);
});
const graph={name:'Check and complete',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Verify source'},
 {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('real successful workspace test produces a bounded exact-receipt completion handoff; host does not auto-close',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'directory-test-handoff-'));
 await writeFile(path.join(root,'sum.mjs'),'export const sum=(a,b)=>a+b;\n');
 await writeFile(path.join(root,'sum.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.mjs';test('sum',()=>assert.equal(sum(2,3),5));\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 runtime.execute=async o=>{
  let seq=0;
  const call=(name,args)=>o.onToolCall({name,arguments:args,callId:'verified-test-'+(++seq)});
  const dir=(action,extras={})=>call('relay_directory_action',{action,...extras});
  assert.equal((await dir('plan',{actions:[{id:'verify',objective:'Run the JavaScript public test and record its evidence',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'verify'})).success,true);
  const check=await call('relay_workspace',{action:'run',command:'node --test'});
  assert.equal(check.success,true,JSON.stringify(check));
  const receipt=check.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(receipt);
  const first=await o.onBeforeFinal({output:'The provided test passed.',signal:o.signal});
  assert.equal(first.continue,true);
  assert.match(first.prompt,/HOST-RETURNED successful workspace test command/);
  assert(first.prompt.includes(receipt));
  assert.match(first.prompt,/not hidden tests or every stated requirement/);
  const state=await dir('read');
  assert.equal(JSON.parse(state.contentItems[0].text).actions[0].state,'active','The first final check did not mutate the Directory.');
  assert.equal((await dir('observe',{id:'verify',outcome:'objective-met',claim:'The requested Node.js test returned exitCode 0',receipts:[receipt]})).success,true);
  assert.equal(await o.onBeforeFinal({output:'Test verified and recorded.',signal:o.signal}),undefined);
  return{output:'Test verified and recorded.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Verify the supplied module using node --test',directoryActions:'on'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
});
