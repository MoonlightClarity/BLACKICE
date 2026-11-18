import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
class Runtime extends EventEmitter{
 calls=[];
 status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
 async runAgent(options){this.calls.push(options);return {output:'Done'};}
}
test('ordinary engine never loads or extracts persistent learning or runs module reviewers',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-context-retired-')),cwd=path.join(root,'work');await mkdir(cwd);
 const runtime=new Runtime(),unexpected=()=>{throw Error('Retired context path invoked');};
 const learning={getContext:unexpected,listLessons:unexpected,scheduleAfterRun:unexpected,cancelBackground:async()=>false};
 const knowledge={context:unexpected};
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:cwd,learning,knowledge,nativeSwarmTools:unexpected,userWorkflows:{list:unexpected,read:unexpected,execute:unexpected}}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 engine.autonomy=new Proxy({}, {get:()=>unexpected});
 engine.runtimeSettings={get:()=>({subagentsEnabled:true,executionGuardrails:false,planningOntology:{version:2,modules:{verification:true,time_management:true,metacognition:true}}})};
 const workflow={name:'Retirement',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',name:'Chat',prompt:'Current task only',sandbox:'danger-full-access'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
 const run=engine.startRun({workflow,input:'Do ordinary work'});await engine.executions.get(run.id);
 const result=engine.getRun(run.id);assert.equal(result.status,'completed',result.error);
 assert.equal(runtime.calls.length,1);assert.equal(result.planningOntology,null);
 assert.doesNotMatch(runtime.calls[0].prompt,/RELEVANT RETAINED|AVAILABLE CATALOG|RELAY KNOWLEDGE/);
 assert.equal(runtime.calls[0].dynamicTools.some(tool=>tool.name==='relay_workspace'),true);
 assert.equal(result.nodes.agent.moduleActivation,undefined);
 assert.equal(runtime.calls[0].dynamicTools.some(tool=>tool.name==='relay_user_workflow'),true);
 assert.equal(runtime.calls[0].dynamicTools.some(tool=>tool.name.startsWith('relay_swarm')),false);
 assert.equal(runtime.calls[0].dynamicTools.some(tool=>tool.name==='relay_autonomy'),false);
});

test('stale autonomous wakes cannot dispatch or continue runs',()=>{
 const error={code:'AUTONOMY_RETIRED',status:410};
 assert.throws(()=>HarnessEngine.prototype.dispatchRun.call({}, {autonomyDispatch:{generation:1}}),error);
 assert.throws(()=>HarnessEngine.prototype.continueRun.call({}, 'old',{}, {autonomyDispatch:{generation:1}}),error);
});
