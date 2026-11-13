import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {VisualArtifacts,nativeVisualTools} from '../lib/visual-artifacts.mjs';
import {VISUAL_EXAMPLE} from '../public/visual-document.mjs';
import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';

test('native visual works with Planning off and restores its saved tool schema',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'visual-native-'));await mkdir(path.join(directory,'work'));
 const store=new VisualArtifacts({dataDir:directory});let visualId;
 class Runtime extends EventEmitter{status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}async close(){}async runAgent(o){const review=fixtureOutcomeReview(o);if(review)return review;const tool=o.dynamicTools.find(t=>t.name==='relay_visual');assert.equal(tool.type,'function');const response=await o.onToolCall({name:'relay_visual',arguments:{action:'create',requestId:'visual',document:VISUAL_EXAMPLE}});assert.equal(response.success,true);visualId=JSON.parse(response.contentItems[0].text).id;return finishFixtureCandidate(o,{output:'Saved an editable diagram.',threadId:'visual-thread'});}}
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:directory,defaultCwd:path.join(directory,'work'),nativeVisualTools:nativeVisualTools(store)}).init();engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
 t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
 const run=engine.startRun({workflow:{id:'visual',name:'Visual',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Draw the evidence relationships.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}},input:'Draw the competing explanations.',planningMode:'off'});
 await engine.executions.get(run.id);const done=engine.getRun(run.id);assert.equal(done.status,'completed',JSON.stringify(done));const saved=await store.read({conversationId:run.taskId||run.id,artifactId:visualId});assert.equal(saved.runId,run.id);const restored=engine.nativeHistoryDescription(done,done.workflow.nodes.find(n=>n.id==='agent'),done.nodes.agent,'fixture');assert.ok(restored.dynamicTools.some(t=>t.name==='relay_visual'));
});
