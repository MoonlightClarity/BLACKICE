import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
for(const initialWebsite of [false,true])test('native sign-in catalog remains '+(initialWebsite?'attached':'absent')+' when follow-up wording changes',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'native-signin-catalog-')),calls=[];let browserEffects=0;
 class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}async runAgent(options){calls.push(options);options.onEvent({type:'thread',threadId:'current-thread'});return{output:'Inspected catalog only',threadId:'current-thread'};}}
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,browser:{status:()=>({available:true,contained:true,tabs:[]}),perform:async()=>{browserEffects++;throw Error('No browser effects authorized');}}}).init();
 t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
 const initial=initialWebsite?'Inspect https://example.test sign-in':'Explain the supplied arithmetic';
 const workflow=createMissionWorkflow({id:'fixture',task:initial,model:'fixture',cwd:dir,planningMode:'off'});
 const first=engine.startRun({workflow,input:initial});await engine.executions.get(first.id);assert.equal(engine.getRun(first.id).status,'completed');
 const next=engine.continueRun(first.id,{nodeId:'agent',message:initialWebsite?'Continue the same check':'Now inspect https://example.test'});await engine.executions.get(next.id);assert.equal(engine.getRun(next.id).status,'completed',engine.getRun(next.id).error);
 assert.equal(calls.length,2);assert.equal(calls[0].dynamicTools.some(tool=>tool.name==='relay_browser_signin'),initialWebsite);assert.deepEqual(calls[1].dynamicTools,calls[0].dynamicTools);assert.equal(browserEffects,0);
});
