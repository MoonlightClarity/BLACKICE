import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Actual shell observation pressure',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Inspect command outputs'},
 {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('the real workspace run tool pages repeated large stdout after cumulative pressure while preserving exit status',{timeout:55000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-shell-engine-'));
 await writeFile(path.join(root,'emit.mjs'),
  "process.stdout.write('BEGIN_MARKER\\n'+'e'.repeat(27500)+'\\nFINAL_SHELL_DIAGNOSIS');\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let visibleCount=0,archivedCount=0,savedRef,rawBytes=0,smallBytes=0;
 runtime.execute=async options=>{
  assert(options.dynamicTools.some(tool=>tool.name==='relay_context_page'));
  let seq=0;
  const call=(name,args)=>options.onToolCall({name,arguments:args,callId:'shell-'+(++seq)});
  for(let n=0;n<6;n++){
   const outcome=await call('relay_workspace',{action:'run',command:'node emit.mjs'});
   assert.equal(outcome.success,true,JSON.stringify(outcome));
   const raw=outcome.contentItems[0].text;
   const parsed=JSON.parse(raw);
   assert.equal(parsed.command,'node emit.mjs');
   assert.equal(parsed.exitCode,0);
   assert.equal(parsed.truncated,false);
   assert.equal(parsed.timedOut,false);
   if(parsed.externalContext){
    archivedCount++;
    assert(n>=3,'A moderate first command output should not be externalized eagerly.');
    assert.equal(parsed.outputIsExcerpt,true);
    assert.match(parsed.stdout,/FINAL_SHELL_DIAGNOSIS/);
    assert.match(parsed.nextAction,/complete captured command JSON/);
    rawBytes=parsed.bytes;smallBytes=Buffer.byteLength(raw);
    savedRef=parsed.reference;
   }else{
    visibleCount++;
    assert.match(parsed.stdout,/FINAL_SHELL_DIAGNOSIS/);
    assert(parsed.stdout.length>25000);
   }
  }
  assert(visibleCount>=3);
  assert(archivedCount>=1);
  assert(smallBytes<rawBytes/5,'Large output was genuinely bounded for the model.');
  const search=await call('relay_context_page',{action:'search',reference:savedRef,needle:'FINAL_SHELL_DIAGNOSIS'});
  assert.equal(search.success,true);
  const matches=JSON.parse(search.contentItems[0].text).matches;
  assert.equal(matches.length,1);
  const page=await call('relay_context_page',{action:'read',reference:savedRef,offset:matches[0].offset,maxBytes:512});
  assert.equal(page.success,true);
  assert(JSON.parse(page.contentItems[0].text).text.startsWith('FINAL_SHELL_DIAGNOSIS'));
  const failure=await call('relay_workspace',{action:'run',command:'node -e "process.exit(17)"'});
  const failureStatus=JSON.parse(failure.contentItems[0].text).exitCode;
  assert(Number.isInteger(failureStatus)&&failureStatus!==0,'A command-level failure must remain visible and nonzero, regardless of the shell wrapper exit-code mapping.');
  return{output:'The shell output was retained, then safely paged with exact host exit information.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Inspect repeated large local command output',directoryActions:'off'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 t.diagnostic('Actual command outputs: '+visibleCount+' full, '+archivedCount+' archived; pointer '+smallBytes+' vs original '+rawBytes+' bytes.');
});

test('Action Directory receives unchanged host receipt evidence even when a large command result is archived',{timeout:55000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-shell-dir-engine-'));
 await writeFile(path.join(root,'emit.mjs'),"process.stdout.write('BEGIN\\n'+'e'.repeat(27500)+'\\nEND');\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let archivedCount=0;
 runtime.execute=async options=>{
  let sequence=0,lastReceipt;
  const call=(name,args)=>options.onToolCall({name,arguments:args,callId:'shell-dir-'+(++sequence)});
  const dir=(action,extra={})=>call('relay_directory_action',{action,...extra});
  assert.equal((await dir('plan',{actions:[{id:'inspect',objective:'Inspect captured command output',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'inspect'})).success,true);
  for(let n=0;n<5;n++){
   const returned=await call('relay_workspace',{action:'run',command:'node emit.mjs'});
   assert.equal(returned.success,true);
   const main=JSON.parse(returned.contentItems[0].text);
   assert.equal(main.exitCode,0);
   if(main.externalContext)archivedCount++;
   const hostReceipt=returned.contentItems.at(-1).text;
   assert.match(hostReceipt,/DIRECTORY HOST RECEIPT receipt-\d+/);
   lastReceipt=hostReceipt.match(/receipt-\d+/)?.[0];
  }
  assert(archivedCount>=1,'The active task should have crossed the adaptive threshold.');
  const observed=await dir('observe',{id:'inspect',outcome:'objective-met',claim:'The command returned exit code zero and recorded its output.',receipts:[lastReceipt]});
  assert.equal(observed.success,true,JSON.stringify(observed));
  assert.equal(await options.onBeforeFinal({output:'Completed inspection.',signal:options.signal}),undefined);
  return {output:'Completed inspection with a returned, traceable command outcome.'};
 };
 const started=engine.startRun({workflow:graph,input:{task:'Inspect captured command outputs',directoryActions:'on'}});
 await engine.executions.get(started.id);
 assert.equal(engine.getRun(started.id).status,'completed',engine.getRun(started.id).error);
 const state=(await engine.actionDirectories.get(started.id,'Inspect captured command outputs')).read();
 assert(state.actions.some(action=>action.state==='observed'));
 assert(state.receipts.some(receipt=>receipt.tool==='relay_workspace'&&receipt.success===true));
});
