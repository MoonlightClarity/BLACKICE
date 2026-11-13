import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanningOntology,planningOntologyInstructions,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
import {readConversationOntology} from '../public/next/chat/ontology-preferences.mjs';
import {readConversationExecutionModes} from '../public/next/chat/execution-preferences.mjs';
import {modularCompletionEnabled} from '../lib/modular-completion.mjs';
import {chatGPTStartChatTool} from '../lib/chatgpt-start-chat.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
const allOff=policy=>PLANNING_ONTOLOGY_MODULES.filter(m=>m.id!=='subagents').every(m=>policy.modules[m.id]===false);
test('unconfigured UI and policy opt out of extra reasoning and Directory',()=>{
 const options=normalizeChatOptions(),policy=normalizePlanningOntology();
 assert.ok(allOff(policy));assert.ok(allOff(options.planningOntology));
 assert.equal(options.directoryMode,'off');
 assert.equal(readConversationExecutionModes().directoryMode,'off');
 assert.ok(allOff(readConversationOntology().planningOntology));
 assert.equal(modularCompletionEnabled(policy),false,'all Off does not silently run completion reviews');
 assert.match(planningOntologyInstructions(policy),/All Planning modules are Off/);
 assert.match(planningOntologyInstructions(policy),/Availability does not require a separate worker/);
});
test('saved defaults, conversation choices and explicit Directory On survive',()=>{
 const selected=normalizePlanningOntology({version:2,modules:{verification:true,inference:true}});
 assert.equal(modularCompletionEnabled(selected),true);
 const defaults=readConversationOntology({defaults:selected});
 assert.deepEqual(defaults.planningOntology,selected);
 const runs=[{planningOntology:selected,executionModes:{directoryMode:'on'}}];
 assert.deepEqual(readConversationOntology({runs}).planningOntology,selected);
 assert.equal(readConversationExecutionModes({runs}).directoryMode,'on');
 assert.equal(normalizeChatOptions({directoryMode:'on'}).directoryMode,'on');
 assert.equal(normalizeChatOptions({directoryMode:'auto'}).directoryMode,'on','legacy explicit auto remains compatible');
 assert.ok(allOff(normalizePlanningOntology()),'selected policy does not mutate factory defaults');
});
test('connector omitted choices match UI; explicit and saved choices remain available',async()=>{
 const starts=[],engine={startRun(args){starts.push(args);return{id:'r',taskId:'r',status:'queued'};},runtimeSettings:{get:()=>({})}};
 const tool=chatGPTStartChatTool({engine,defaultCwd:'C:/fixture'});
 const args={requestId:'sparse-default',message:'Inspect a file'};
 await tool.execute(args,{client:{id:'fixture'}});
 assert.equal(starts[0].input.directoryMode,'off');assert.ok(allOff(starts[0].input.planningOntology));
 assert.equal(tool.durableArguments(args).directoryMode,'off');
 const selected=normalizePlanningOntology({version:2,modules:{verification:true}});
 engine.runtimeSettings.get=()=>({planningOntology:selected});
 await tool.execute({...args,requestId:'selected',directoryMode:'on'},{client:{id:'fixture'}});
 assert.equal(starts[1].input.directoryMode,'on');assert.deepEqual(starts[1].input.planningOntology,selected);
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
test('stored Directory On/Off/legacy auto remain explicit while absent drafts default Off',()=>{
 for(const [saved,expected] of [['on','on'],['off','off'],['auto','on'],[undefined,'off']]){
  const storage={getItem:()=>JSON.stringify(saved===undefined?{}:{directoryMode:saved})};
  assert.equal(readConversationExecutionModes({storage}).directoryMode,expected);
 }
 for(const choice of ['mandatory','optional','auto','on',true]){
  assert.equal(normalizePlanningOntology({version:1,modules:{inference:choice}}).modules.inference,true);
 }
});
