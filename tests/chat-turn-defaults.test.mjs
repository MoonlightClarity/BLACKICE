import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
import {CHAT_DEFAULTS,NEW_CHAT_RECEIPT_DEPTH,chatTurnMode} from '../public/chat-turn-defaults.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('new composer uses global defaults; existing conversation choices and local drafts win',()=>{
 const enabled={directoryActions:'on',chatPlanning:'on',pastChats:'on'};
 for(const [key,value] of Object.entries(enabled)){
  assert.equal(chatTurnMode(key,{defaults:enabled}),value);
  assert.equal(chatTurnMode(key,{defaults:enabled,existing:true,saved:'off'}),'off');
  assert.equal(chatTurnMode(key,{defaults:enabled,draft:'off'}),'off');
 }
 assert.equal(chatTurnMode('pastChats',{existing:true,defaults:{pastChats:'off'}}),'on','historical unspecified policy is unchanged');
 assert.equal(NEW_CHAT_RECEIPT_DEPTH,'maximal');
});
test('ordinary new Chat defaults are permanent per run, explicit choices win, and same request replays across default changes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-chat-defaults-'));
 const runtime=new class extends EventEmitter{
  status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
  async runAgent(){return{output:'Fixture response'};}
 };
 const runtimeSettings=await new RuntimeSettingsStore({dataDir:root}).init();
 const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 engine.runtimeSettings=runtimeSettings;
 t.after(async()=>{await engine.close();await runtimeSettings.close();await fs.rm(root,{recursive:true,force:true});});
 const options=run=>Object.fromEntries([...Object.keys(CHAT_DEFAULTS),'directoryDiagnostics'].map(key=>[key,run[key]]));
 const shipped={...CHAT_DEFAULTS,directoryDiagnostics:'maximal'};
 let request;
 const api=async(route,_method,body)=>{
  if(route==='/api/workflows')return engine.saveWorkflow(body);
  if(route==='/api/runs'){request=body;return engine.startRun(body);}
  return engine.continueRun(route.split('/')[3],body);
 };
 const sent=await submitChat({api,runs:[],task:'First ordinary Chat',model:'fixture',cwd:root});
 await engine.executions.get(sent.run.id);
 const original=request;
 assert.deepEqual(options(engine.getRun(sent.run.id)),shipped);
 await runtimeSettings.update({chatDefaults:{directoryActions:'on',chatPlanning:'on',pastChats:'on'}});
 assert.equal(engine.startRun(original).id,sent.run.id,'replay must match authored request despite later global edits');
 const continued=engine.continueRun(sent.run.id,{nodeId:'agent',message:'Keep original settings'});
 await engine.executions.get(continued.id);
 assert.deepEqual(options(engine.getRun(continued.id)),shipped);
 const next=await submitChat({api,runs:[],task:'New ordinary Chat',model:'fixture',cwd:root,directoryActions:'off',chatPlanning:'off'});
 await engine.executions.get(next.run.id);
 assert.deepEqual(options(engine.getRun(next.run.id)),{directoryActions:'off',chatPlanning:'off',directoryDiagnostics:'maximal',pastChats:'on'});
 const explicit=engine.continueRun(next.run.id,{nodeId:'agent',message:'Update just this conversation',pastChats:'off',directoryDiagnostics:'off'});
 await engine.executions.get(explicit.id);
 assert.deepEqual(options(engine.getRun(explicit.id)),{...CHAT_DEFAULTS,directoryDiagnostics:'off'});
 const afterExplicit=engine.continueRun(explicit.id,{nodeId:'agent',message:'Keep prior receipt depth'});
 await engine.executions.get(afterExplicit.id);
 assert.equal(engine.getRun(afterExplicit.id).directoryDiagnostics,'off');
 assert.deepEqual(options(engine.getRun(next.run.id)),{directoryActions:'off',chatPlanning:'off',directoryDiagnostics:'maximal',pastChats:'on'});
 const independent=engine.startRun({workflow:createMissionWorkflow({task:'Independent workflow',model:'fixture',cwd:root,id:'workflow-test'}),input:{task:'Independent workflow',cwd:root}});
 await engine.executions.get(independent.id);
 assert.equal(independent.pastChats,undefined,'configured Chat preferences do not reconfigure other workflow sources');
});
