import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanningOntology,planningOntologyInstructions,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
import {modularCompletionEnabled} from '../lib/modular-completion.mjs';
import {chatGPTStartChatTool} from '../lib/chatgpt-start-chat.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
const lightweightDefault=policy=>PLANNING_ONTOLOGY_MODULES.filter(m=>!['subagents','time_management'].includes(m.id)).every(m=>policy.modules[m.id]===false)&&policy.modules.time_management===true;
test('unconfigured Chat has no Directory or automatic module policy while legacy normalization remains deterministic',()=>{
 const options=normalizeChatOptions(),policy=normalizePlanningOntology();
 assert.deepEqual(options,{model:'default',effort:'default',serviceTier:'default',verbosity:'auto',planningMode:'off',planningExecutionMode:'automatic'});
 assert.ok(lightweightDefault(policy));assert.equal(modularCompletionEnabled(policy),false);
});
test('Chat ignores saved module and Directory choices without rewriting historical values',()=>{
 const selected=normalizePlanningOntology({version:2,modules:{verification:true,inference:true}}),before=JSON.stringify(selected);
 assert.equal(modularCompletionEnabled(selected),true);
 for(const directoryMode of ['on','off','auto']){
  const options=normalizeChatOptions({planningOntology:selected,directoryMode,model:'fixture',effort:'high',serviceTier:'fast'});
  assert.deepEqual(options,{model:'fixture',effort:'high',serviceTier:'fast',verbosity:'auto',planningMode:'off',planningExecutionMode:'automatic'});
 }
 assert.equal(JSON.stringify(selected),before);
});
test('connector legacy policy fields remain bounded compatibility data and Directory execution is rejected',async()=>{
 const starts=[],engine={startRun(args){starts.push(args);return{id:'r',taskId:'r',status:'queued'};},runtimeSettings:{get:()=>({})}};
 const tool=chatGPTStartChatTool({engine,defaultCwd:'C:/fixture'});
 const args={requestId:'sparse-default',message:'Inspect a file'};
 await tool.execute(args,{client:{id:'fixture'}});
 assert.equal(starts[0].input.directoryMode,'off');assert.ok(lightweightDefault(starts[0].input.planningOntology));
 assert.equal(tool.durableArguments(args).directoryMode,'off');
 const selected=normalizePlanningOntology({version:2,modules:{verification:true}});
 engine.runtimeSettings.get=()=>({planningOntology:selected});
 await assert.rejects(tool.execute({...args,requestId:'selected',directoryMode:'on'},{client:{id:'fixture'}}),{code:'DIRECTORY_RETIRED'});
 await tool.execute({...args,requestId:'selected-off',directoryMode:'off'},{client:{id:'fixture'}});
 assert.equal(starts[1].input.directoryMode,'off');assert.deepEqual(starts[1].input.planningOntology,selected);
 await assert.rejects(tool.execute({...args,message:'x'.repeat(50001)},{client:{id:'fixture'}}),/Directory Off/);
 assert.equal(starts.length,2,'oversized implicit Off input is rejected before admission');
});

test('explicit legacy and full saved policies remain unchanged on disk across startup',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-default-choices-'));
 const store=new RuntimeSettingsStore({dataDir:dir});
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
 const modules=Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id})=>[id,'auto']));
 modules.feasibility='off';
 const original=JSON.stringify({planningOntology:{version:1,modules}});
 await writeFile(store.file,original);
 await store.init();
 const normalized=store.get().planningOntology;
 assert.equal(normalized.modules.inference,true);assert.equal(normalized.modules.feasibility,false);
 assert.equal(normalized.modules.verification,true);
 assert.equal(await readFile(store.file,'utf8'),original,'startup must not rewrite explicit legacy choices');
 const allOn=normalizePlanningOntology({version:2,modules:Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id})=>[id,true]))});
 await store.update({planningOntology:allOn});
 assert.deepEqual(store.get().planningOntology,allOn);
});
test('legacy no-execution constraints remain explicit while retired Directory options are omitted',()=>{
 for(const directoryMode of ['on','off','auto',undefined]){
  const saved={directoryMode,planningExecutionMode:'plan_only'},before=JSON.stringify(saved);
  const options=normalizeChatOptions(saved);assert.equal(options.directoryMode,undefined);assert.equal(options.planningExecutionMode,'plan_only');
  assert.equal(JSON.stringify(saved),before);
 }
 for(const choice of ['mandatory','optional','auto','on',true])assert.equal(normalizePlanningOntology({version:1,modules:{inference:choice}}).modules.inference,true);
});
