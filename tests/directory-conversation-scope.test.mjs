import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {directoryKnowledgeAdmission,directoryContextConfiguration} from '../lib/directory-conversation-scope.mjs';
import {contextSnapshot,normalizeContextOptions} from '../lib/context.mjs';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {LearningStore} from '../lib/learning.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {readShadowdancerFile,importShadowdancerContext,deleteShadowdancerContext} from '../lib/shadowdancer-context.mjs';

test('Directory uses the supported native maximum and defers unknown capacities to the provider',()=>{
  const model={id:'native',contextWindowTokens:272000,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'};
  const selected=directoryContextConfiguration({model});
  assert.equal(selected.options.preset,'extended');
  assert.equal(selected.inputBudgetTokens,872000*.95-8192-8192);
  assert.equal(selected.options.compactAtTokens,selected.inputBudgetTokens,'default compaction must not discard the upper fifth of usable context');
  assert.ok(selected.knownCapacity);
  const explicit=directoryContextConfiguration({model,context:{preset:'custom',windowTokens:96000}});
  assert.equal(explicit.options.windowTokens,96000,'an intentional conversation override remains available');
  const unresolved=directoryContextConfiguration();
  assert.equal(unresolved.knownCapacity,false);
  assert.equal(unresolved.inputBudgetTokens,Infinity);
  const snapshot=contextSnapshot({options:unresolved.options,messages:['x'.repeat(600000)]});
  assert.equal(snapshot.effectiveWindowTokens,null);
  assert.equal(snapshot.windowSource,'unresolved');
  assert.ok(snapshot.estimatedInputTokens<snapshot.inputBudgetTokens,'unknown long-context models have no invented 128K ceiling');
  assert.equal(snapshot.compactAtTokens,Infinity);
  assert.equal(normalizeContextOptions({preset:'custom',windowTokens:8000000}).windowTokens,8000000);
});

test('Directory automatic knowledge follows conversation lineage rather than shared workspace',()=>{
  const run={id:'current',taskId:'first',directoryUserHistory:[{runId:'archived-parent'}]};
  const admit=directoryKnowledgeAdmission({run,runs:[{id:'first'},{id:'previous',taskId:'first'},{id:'foreign',taskId:'other'}]});
  for(const runId of ['first','previous','current','archived-parent'])assert.equal(admit({provenance:{runId}}),true);
  assert.equal(admit({provenance:{runId:'foreign'}}),false);
  assert.equal(admit({provenance:{source:'user'}}),false,'an unscoped workspace note is not a conversation import');
  assert.equal(admit({provenance:{runId:'first'},evidenceRunIds:['foreign']}),false,'a blended note must be explicitly imported');
});

test('conversation admission happens before retained-learning selection fills the context',()=>{
  const store=new LearningStore({dataDir:os.tmpdir(),runtime:{},getRun:()=>null,knowledge:{get:id=>({title:id,summary:id,content:id,revision:1,provenance:{source:'user',runId:id==='current-note'?'current':'other'}})}});
  store.settings={mode:'manual'};
  store.lessons=Array.from({length:16},(_,i)=>({id:'lesson-'+i,knowledgeId:i===0?'current-note':'foreign-'+i,kind:'fact',cwd:os.tmpdir(),status:'active',updatedAt:new Date(i*1000).toISOString(),provenance:{source:'user',runId:i===0?'current':'other'},evidence:[{runId:i===0?'current':'other'}]}));
  const result=store.getContext(os.tmpdir(),{admit:directoryKnowledgeAdmission({run:{id:'current'}})});
  assert.deepEqual(result.facts.map(row=>row.knowledgeId),['current-note']);
});

const workflow={name:'Conversation context fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Chat',model:'fixture::context',prompt:'Answer the current question.',sandbox:'danger-full-access'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
  calls=[];
  store={get:()=>({baseUrl:'https://example.invalid/v1'})};
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::context',models:[{id:'fixture::context',supportsTools:true}]};}
  async runAgent(options){
    this.calls.push(options);
    const input=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
    const value=input.label==='decompose'?{atomic:true}:input.label==='integration'?{answer:this.answer||'A reasoned fixture answer.',used_refs:input.payload.required_refs}:{status:'complete',nextAction:'',finding:'A supported fixture answer.',candidate_answer:'A reasoned fixture answer.',uncertainty:''};
    return {output:JSON.stringify(value)};
  }
}
test('production Directory excludes other conversation catalogs and retains its own saved notes',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'directory-conversation-scope-')),cwd=path.join(root,'workspace'),dataDir=path.join(root,'data');await mkdir(cwd);
  const knowledge=await new KnowledgeStore({dataDir}).init(),runtime=new Runtime();
  const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,knowledge}).init();
  engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
  t.after(async()=>{await engine.close();await knowledge.writeChain;await rm(root,{recursive:true,force:true});});
  const first=engine.startRun({workflow,input:{task:'Explain the local fixture.',directoryMode:'on',subagentsMode:'off'}});
  await engine.executions.get(first.id);assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
  const own=await knowledge.upsert({kind:'memory',title:'CURRENT_CONVERSATION_NOTE',summary:'CURRENT_CONVERSATION_NOTE',content:'Same conversation evidence.',cwd},{source:'agent',runId:first.id,nodeId:'agent'});
  await knowledge.upsert({kind:'memory',title:'FOREIGN_CONVERSATION_NOTE',summary:'FOREIGN_CONVERSATION_NOTE',content:'Other conversation evidence.',cwd},{source:'agent',runId:'unrelated-run',nodeId:'agent'});
  await knowledge.upsert({kind:'memory',title:'UNSCOPED_WORKSPACE_NOTE',summary:'UNSCOPED_WORKSPACE_NOTE',content:'No conversation source.',cwd});
  const continuation=engine.continueRun(first.id,{nodeId:'agent',message:'Continue explaining the same fixture.',directoryMode:'on',subagentsMode:'off'});
  await engine.executions.get(continuation.id);
  const saved=engine.getRun(continuation.id);assert.equal(saved.status,'completed',saved.error);
  assert.deepEqual(saved.nodes.agent.knowledgeCatalog.memories.map(row=>row.id),[own.id]);
  const context=JSON.parse(await readFile(path.join(cwd,'.shadowdancer',first.id,'runs',continuation.id,'context/imports/0001/source.json'),'utf8'));
  assert.match(context.content,/CURRENT_CONVERSATION_NOTE/);
  assert.doesNotMatch(context.content,/FOREIGN_CONVERSATION_NOTE|UNSCOPED_WORKSPACE_NOTE/);

  const sourceFile='runs/foreign-context/sources/page-0001/source.json';
  const sourcePath=path.join(cwd,'.shadowdancer','foreign-context',sourceFile);
  await mkdir(path.dirname(sourcePath),{recursive:true});
  await writeFile(sourcePath,JSON.stringify({content:'EXPLICIT_IMPORT_SOURCE'}));
  await writeFile(path.join(path.dirname(sourcePath),'unselected.json'),JSON.stringify({content:'UNSELECTED_FOREIGN_SOURCE'}));
  const original=await readShadowdancerFile({cwd,conversationId:'foreign-context',file:sourceFile});
  const imported=await importShadowdancerContext({cwd,conversationId:first.id,
    source:{cwd,conversationId:'foreign-context',runId:'foreign-context',file:sourceFile},expectedSourceHash:original.hash,reason:'Use selected reference'});
  runtime.answer='The selected EXPLICIT_IMPORT_SOURCE was considered.';
  const importedRun=engine.continueRun(continuation.id,{nodeId:'agent',message:'Use the selected reference in this explanation.'});
  await engine.executions.get(importedRun.id);assert.equal(engine.getRun(importedRun.id).status,'completed',engine.getRun(importedRun.id).error);
  const importedEvidence=JSON.parse(await readFile(path.join(cwd,'.shadowdancer',first.id,'runs',importedRun.id,'context/imports/0001/source.json'),'utf8'));
  assert.match(importedEvidence.content,/EXPLICIT_IMPORT_SOURCE/);
  assert.doesNotMatch(importedEvidence.content,/UNSELECTED_FOREIGN_SOURCE/);
  const copy=await readShadowdancerFile({cwd,conversationId:first.id,file:imported.file});
  await deleteShadowdancerContext({cwd,conversationId:first.id,file:imported.file,expectedHash:copy.hash,reason:'Remove this reference'});
  runtime.answer='The explanation uses the remaining current context.';
  const deletedRun=engine.continueRun(importedRun.id,{nodeId:'agent',message:'Answer again using the revised current context.'});
  await engine.executions.get(deletedRun.id);assert.equal(engine.getRun(deletedRun.id).status,'completed',engine.getRun(deletedRun.id).error);
  const deletedEvidence=JSON.parse(await readFile(path.join(cwd,'.shadowdancer',first.id,'runs',deletedRun.id,'context/imports/0001/source.json'),'utf8'));
  assert.doesNotMatch(deletedEvidence.content,/EXPLICIT_IMPORT_SOURCE|UNSELECTED_FOREIGN_SOURCE/,'deleted contents must not return through the previous final-answer handoff');
  assert.ok(JSON.parse(deletedEvidence.content).managedContext.deletedFiles.some(row=>row.file===imported.file));
});
