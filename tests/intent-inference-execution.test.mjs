import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {wantsIntentInferenceSkill} from '../lib/chat-intent-inference.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {projectExecutionSkill} from '../lib/execution-skill-brief.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

const id='library-intent-inference';
const bundledIntent=JSON.parse(await readFile(new URL('../lib/skill-library/index.json',import.meta.url),'utf8')).entries.find(entry=>entry.id===id);
const bundledIntentBody=await readFile(new URL('../lib/skill-library/'+bundledIntent.bodyFile,import.meta.url),'utf8');
const jobs="I'm trying to get out of human data work and into intelligence research. Find suitable roles.";
const reporting='We need to stop copying figures across trackers. Find an alternative for our weekly report.';
const block='INTENT INFERENCE (advisory execution method; not permission)';

test('automatic intent context is selected by a current direction change, not ordinary topics or quoted mentions',()=>{
 for(const text of [jobs,reporting,'The goal is to move out of labeling work; find analysis roles.','Please load the Intent Inference skill.','I need to replace our workflow.'])
  assert.equal(wantsIntentInferenceSkill(text),true,text);
 for(const text of ['Find three plausible analyst jobs.','Job skills include intent inference.','I want to replace a word.',
   'The archived prompt says "I am trying to get out of data labeling".','> '+jobs,
   '`\x60\x60text\n'+reporting+'\n`\x60\x60','The sample says \u201c'+jobs+'\u201d','Skills: Intent Inference'])
  assert.equal(wantsIntentInferenceSkill(text),false,text);
});

test('Planning Off execution gets only the accepted, effective Intent Inference body',async t=>{
 const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-intent-context-'));
 const dataDir=path.join(dir,'engine'),catalog=createSkillsCatalog({dataDir});
 let engine,accept=true;
 const main=[];
 class Fixture extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async close(){}
  async runAgent(o){
   assert.notEqual(o.responseOnly,true,'this advisory method does not open a separate planning phase');
   const turn=[...engine.runs.values()].at(-1);
   main.push({prompt:o.prompt,acceptedAtEntry:[...(turn.skillLoadReceipts||[])],thread:o.threadId});
   o.onPromptAccepted?.(o.prompt+' altered');
   assert.deepEqual(turn.skillLoadReceipts||[],[],'altered or not-yet-accepted prompt cannot emit receipts');
   if(accept){o.onPromptAccepted?.(o.prompt);o.onPromptAccepted?.(o.prompt);}
   if(o.dynamicTools?.some(tool=>tool.name==='relay_directory_action')){
    const call=async(name,args,callId)=>{
     const result=await o.onToolCall({name,arguments:args,callId});
     assert.equal(result.success,true,JSON.stringify(result));
     return JSON.parse(result.contentItems[0].text);
    };
    const directory=(args,callId)=>call('relay_directory_action',args,callId);
    let d=await directory({action:'read'},'read');
    d=await directory({action:'plan',revision:d.revision,actions:[{id:'inspect',objective:'Inspect the local fixture folder',dependsOn:[]}]},'plan');
    await directory({action:'focus',revision:d.revision,id:'inspect'},'focus');
    await call('relay_workspace',{action:'list',path:dir},'list');
    d=await directory({action:'read'},'read2');
    await directory({action:'observe',outcome:'objective-met',revision:d.revision,id:'inspect',claim:'The folder listing returned',receipts:[d.receipts[0].id]},'observe');
    assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);
   }
   const threadId=o.threadId||'fixture-thread-'+main.length;
   o.onEvent?.({type:'thread',threadId,model:o.model,codexHistory:'codex'});
   return {output:'Synthetic response.',threadId,codexHistory:'codex'};
  }
 }
 t.after(async()=>{
  await engine?.close();await catalog.close();
  const actual=await realpath(dir);assert.equal(path.dirname(actual),root);
  assert.match(path.basename(actual),/^blackice-intent-context-/);
  await rm(actual,{recursive:true,force:true});
 });
 engine=await new HarnessEngine({runtime:new Fixture(),dataDir,defaultCwd:dir}).init();
 engine.runtimeSettings={get:()=>({codexHistory:'codex'})};
 const invoke=async(task,directoryActions='off')=>{
  const workflow=createMissionWorkflow({id:'mission_chat_intent_context',task,model:'fixture',cwd:dir,planningMode:'off'});
  const v=engine.startRun({workflow,input:{task,cwd:dir,chatPlanning:'off',directoryActions,directoryDiagnostics:'maximal'}});
  await engine.executions.get(v.id);
  const run=engine.getRun(v.id);
  assert.equal(run.status,'completed',run.error);
  assert.deepEqual(main.at(-1).acceptedAtEntry,[]);
  return {id:v.id,prompt:main.at(-1).prompt,receipts:run.skillLoadReceipts||[]};
 };
 const defaultRun=await invoke(jobs,'on');
 assert.ok(defaultRun.prompt.includes(block));
 assert.ok(defaultRun.prompt.includes(projectExecutionSkill({id,content:bundledIntentBody,description:bundledIntent.description}).text),'bounded current method projection reaches execution');
 assert.ok(!defaultRun.prompt.includes(bundledIntentBody),'full method is read on demand');
 assert.equal(defaultRun.prompt.split(block).length,2);
 assert.deepEqual(defaultRun.receipts.filter(r=>r.skillId===id),
  [{type:'skill_context_submitted',skillId:id,title:'Intent Inference',source:'bundled',sourceRevision:bundledIntent.source.revision,contentMode:'brief'}]);

 const resumeSeed=await invoke(jobs);
 const continued=engine.continueRun(resumeSeed.id,{nodeId:'agent',message:jobs,directoryActions:'off',chatPlanning:'off'});
 await engine.executions.get(continued.id);
 const followup=engine.getRun(continued.id);
 assert.equal(followup.status,'completed',followup.error);
 assert.ok(main.at(-1).thread,'fixture reused the native provider thread');
 assert.ok(!main.at(-1).prompt.includes(block),'do not reload a skill when resuming the provider thread');
 assert.ok((followup.skillLoadReceipts||[]).every(r=>r.skillId!==id));
 const noMatch=await invoke('Find three plausible analyst jobs.');
 assert.ok(!noMatch.prompt.includes(block));
 assert.ok(noMatch.receipts.every(r=>r.skillId!==id));

 const ownerMethod='# Owner method\nOwner method controls what may be repeated.';
 const edited=await catalog.save({id,value:{expectedRevision:1,content:ownerMethod}});
 const custom=await invoke(reporting);
 assert.ok(custom.prompt.includes('Owner method controls what may be repeated.'),'the owner-defined purpose reaches execution');
 assert.ok(!custom.prompt.includes(ownerMethod),'full owner body is available for on-demand read');
 assert.ok(!custom.prompt.includes(bundledIntentBody));
 assert.doesNotMatch(custom.prompt,/^# Intent Inference$/m);
 assert.deepEqual(custom.receipts.find(r=>r.skillId===id),{type:'skill_context_submitted',skillId:id,title:'Owner method',source:'user',sourceRevision:2,contentMode:'brief'});

 accept=false;
 const unaccepted=await invoke(reporting);
 assert.ok(unaccepted.prompt.includes(block));
 assert.deepEqual(unaccepted.receipts,[]);
 accept=true;

 await catalog.delete({id,value:{expectedRevision:edited.revision}});
 const deleted=await invoke(jobs);
 assert.ok(!deleted.prompt.includes(block));
 assert.ok(deleted.receipts.every(r=>r.skillId!==id));

 await writeFile(path.join(dataDir,'skill-edits','skills.json'),'malformed');
 const unavailable=await invoke(jobs);
 assert.ok(!unavailable.prompt.includes(block));
 assert.ok(unavailable.receipts.every(r=>r.skillId!==id));
});
