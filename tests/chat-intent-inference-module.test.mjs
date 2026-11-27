import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { intentInferenceSignals, explicitMethodTitles, boundGoalMethodObjective } from '../lib/chat-intent-inference.mjs';
import { projectPlanningModuleReceipts } from '../public/next/chat/model.mjs';

const id='builtin-intent-inference', artifact='intent-advice';
const task='apply for jobs until 6 AM EST';
const plan={status:'proposed',focus:'first',reason:'Find the most useful next step',actions:[{id:'first',objective:'Inspect the current request',dependsOn:[]}]};
const isIntentPrompt=prompt=>prompt.includes('Shape: {"artifact":{"status":"proposed","interpretation":');
const runShape={chatPlanning:'on',id:'turn-1',taskId:'task-1',nodes:{agent:{}}};
const receipt=(overrides={})=>({type:'planning.module',runId:runShape.id,taskId:runShape.taskId,nodeId:'agent',moduleId:id,artifact,phase:'completed',...overrides});

test('intent triggers catch the reported request without selecting ordinary jobs or generic immediate requests',()=>{
 assert.ok(intentInferenceSignals(task).includes('clock-time'));
 assert.ok(intentInferenceSignals('Please infer my intent before choosing an approach.').includes('explicit-intent'));
 assert.deepEqual(intentInferenceSignals('Find three plausible analyst jobs.'),[]);
 assert.deepEqual(intentInferenceSignals('Correct the typo in the first paragraph.'),[]);
});

test('intent receipt is advisory, scoped, and names an interpretation rather than a recorded plan',()=>{
 assert.deepEqual(projectPlanningModuleReceipts(runShape,[receipt({taskId:'wrong'})]),[]);
 assert.deepEqual(projectPlanningModuleReceipts(runShape,[receipt({runId:'different-turn'})]),[]);
 assert.deepEqual(projectPlanningModuleReceipts(runShape,[receipt({nodeId:'worker'})]),[]);
 assert.deepEqual(projectPlanningModuleReceipts(runShape,[receipt({artifact:'grounded-choice'})]),[]);
 assert.deepEqual(projectPlanningModuleReceipts({...runShape,chatPlanning:'off'},[receipt()]),[]);
 const [row]=projectPlanningModuleReceipts(runShape,[receipt({interpretation:'must not project',reason:'must not project'})]);
 assert.equal(row.label,'Interpretation ready');
 assert.equal(row.title,'Intent Inference');
 assert.doesNotMatch(JSON.stringify(row),/must not project/);
});

test('ambiguous fresh deadline gets a tool-free advice pass without committing a goal; failure and Planning Off keep work moving',async t=>{
 const root=await realpath(tmpdir()), dir=await mkdtemp(path.join(root,'blackice-intent-inference-test-'));
 await writeFile(path.join(dir,'profile-fixture.txt'),'Offline profile: synthetic analyst experience.');
 await writeFile(path.join(dir,'postings-fixture.txt'),'Offline candidate list: Analyst role. No real submission.');
 const calls=[],toolCalls=[];let malformed=false,engine;
 class Fixture extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async close(){}
  async runAgent(options){
   const prep=options.responseOnly===true, input=options.prompt||'';
   const inference=prep&&isIntentPrompt(input);
   calls.push({prep,inference,input,options});
   if(!prep){
    if(/Start by checking current postings\./.test(input)){
     const invoke=async(name,args)=>{
      toolCalls.push([name,args.action||null]);
      const result=await options.onToolCall({name,arguments:args,callId:'intent-fixture-tool-'+toolCalls.length});
      assert.equal(result.success,true,JSON.stringify(result));
      return JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
     };
     const located=await invoke('relay_find_files',{query:'profile-fixture.txt',path:dir});
     assert.equal(located.matches.length,1);
     const profile=await invoke('relay_workspace',{action:'read',path:located.matches[0].path});
     assert.match(profile.content,/Offline profile/);
     const source=await invoke('relay_workspace',{action:'read',path:path.join(dir,'postings-fixture.txt')});
     assert.match(source.content,/Offline candidate list/);
    }
    return {output:'Synthetic final: no external action performed.'};
   }
   if(!inference)return {output:JSON.stringify({artifact:plan})};
   if(malformed)return {output:JSON.stringify({artifact:{status:'proposed',interpretation:[]}})};
   return {output:JSON.stringify({artifact:{status:'proposed',interpretation:'Use the next future 6 AM Eastern as the likely upper bound, not permission to run in the background. Start by checking current postings.',reason:'A fresh forward-looking request did not name a date.'}})};
  }
 }
 t.after(async()=>{
  await engine?.close();
  const actual=await realpath(dir);
  assert.equal(path.dirname(actual),root);
  assert.match(path.basename(actual),/^blackice-intent-inference-test-/);
  await rm(actual,{recursive:true,force:true});
 });
 engine=await new HarnessEngine({runtime:new Fixture(),dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();
 const workflow={id:'intent_fixture',name:'Intent fixture',nodes:[{id:'input',type:'input',name:'Request'},{id:'agent',type:'agent',name:'Assistant',model:'fixture',prompt:'Answer the current request.'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}]};
 const launch=async(task,chatPlanning)=>{
  const start=calls.length;const run=engine.startRun({workflow,input:{task,cwd:dir,chatPlanning}});
  await engine.executions.get(run.id);
  return {run:engine.getRun(run.id),calls:calls.slice(start)};
 };
 const active=await launch(task,'on');
 assert.equal(active.run.status,'completed',active.run.error);
 const infer=active.calls.filter(x=>x.inference);
 assert.equal(infer.length,1);
 assert.deepEqual(infer[0].options.dynamicTools,[]);
 assert.equal(infer[0].options.hostOnlyTools,true);
 assert.equal(infer[0].options.sandbox,'read-only');
 assert.match(infer[0].input,/apply for jobs until 6 AM EST/i);
 assert.match(infer[0].input,/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/,'prep is grounded in a host timestamp, not the model clock');
 const main=active.calls.find(x=>!x.prep);
 assert.match(main.input,/ADVISORY INTENT INFERENCE/);
 assert.match(main.input,/next future 6 AM Eastern/);
 assert.match(main.input,/Start by checking current postings\./);
 const decomposition=active.calls.find(x=>x.prep&&!x.inference);
 assert.match(decomposition.input,/Start by checking current postings\./);
 assert.deepEqual(toolCalls,[['relay_find_files',null],['relay_workspace','read'],['relay_workspace','read']]);
 assert.doesNotMatch(main.input,/For a fresh search or application, go to the sources needed for the task\./);
 assert.doesNotMatch(main.input,/Do not inventory open browser tabs for a fresh task; open the relevant source directly\./);
 const intentAudit=active.run.nodes.agent.instructionAudit.preparations.find(row=>row.id===id).audit;
 assert.equal(intentAudit.sections.some(row=>row.id==='skill-library-intent-inference'),false,'planning response never imports implicit skill text');
 assert.ok(intentAudit.sections.some(row=>row.id==='planning-artifact'),'effective planning protocol is still captured');
 assert.equal(intentAudit.captureStage,'engine-prepared');
 assert.equal(active.run.goal?.deadlineAt,undefined);
 assert.deepEqual(active.run.planningModuleReceipts.filter(x=>x.moduleId===id).map(x=>x.phase),['started','completed']);
 const ledger=await engine.actionDirectories.get(active.run.id,active.run.input);
 assert.equal(ledger.read().revision,1,'only the real plan, not the intent artifact, mutates the outline');
 assert.equal(ledger.read().actions[0].state,'pending');

 malformed=true;
 const rejected=await launch(task,'on');
 assert.equal(rejected.run.status,'completed',rejected.run.error);
 assert.deepEqual(rejected.run.planningModuleReceipts.filter(x=>x.moduleId===id).map(x=>x.phase),['started','failed']);
 const fallback=rejected.calls.find(x=>!x.prep).input;
 assert.match(fallback,/ADVISORY INTENT INFERENCE[\s\S]*clockCandidate/);
 assert.doesNotMatch(fallback,/"interpretation":/);
 const ordinary=await launch('Find three plausible analyst jobs.','on');
 assert.equal(ordinary.run.status,'completed',ordinary.run.error);
 assert.ok(ordinary.calls.every(x=>!x.inference));
 assert.doesNotMatch(ordinary.calls.find(x=>!x.prep).input,/ADVISORY INTENT INFERENCE/);
 const off=await launch(task,'off');
 assert.equal(off.run.status,'completed',off.run.error);
 assert.deepEqual(off.calls.map(x=>x.prep),[false]);
 assert.equal(off.run.planningModuleReceipts,undefined);
});


test('fixed incident replay gives prep the actual next occurrence without recording it as an authorized Goal',async()=>{
 const {prepareChatPlanning}=await import('../lib/chat-planning-engine.mjs');
 const {TaskActionDirectory}=await import('../lib/task-action-directory.mjs');
 const directory=new TaskActionDirectory({taskId:'fresh-task',objective:task});
 const seen=[];
 const runtime={
  status(){return {defaultModel:'fixture'};},
  async runAgent({prompt,dynamicTools}){
   seen.push(prompt);assert.deepEqual(dynamicTools,[]);
   if(!isIntentPrompt(prompt))return {output:JSON.stringify({artifact:plan})};
   assert.match(prompt,/2026-11-19T16:44:00(?:\.000)?Z/);
   assert.match(prompt,/2026-11-20T11:00:00(?:\.000)?Z/,'6 AM EST at 11:44 AM EST is the next calendar day');
   assert.equal(directory.read().revision,0,'inference runs independently of outline mutation');
   return {output:JSON.stringify({artifact:{status:'proposed',interpretation:'Likely 6 AM EST on November 20.',reason:'Future-facing undated clock time.'}})};
  }
 };
 const events=[];
 const run=Object.freeze({id:'fresh-turn',taskId:'fresh-task',input:task,createdAt:'2026-11-19T16:44:00.000Z',chatPlanning:'on'});
 await prepareChatPlanning({run,node:{id:'agent',model:'fixture'},signal:new AbortController().signal,directory,runtime,assertAdmission(){},emit:event=>events.push(event)});
 assert.ok(seen.some(x=>/2026-11-20T11:00:00(?:\.000)?Z/.test(x)));
 assert.deepEqual(events.filter(e=>e.moduleId===id).map(e=>e.phase),['started','completed']);
 assert.equal(directory.read().revision,1);
 assert.equal(run.goal,undefined);
});


test('an explicitly dated cutoff stays fixed instead of silently becoming the following day',async()=>{
 const {prepareChatPlanning}=await import('../lib/chat-planning-engine.mjs');
 const {TaskActionDirectory}=await import('../lib/task-action-directory.mjs');
 const explicit='apply for jobs until today at 6 AM EST';
 const date='2026-11-19T16:44:00.000Z';
 const directory=new TaskActionDirectory({taskId:'explicit-task',objective:explicit});
 const seen=[];
 const runtime={
  status(){return {defaultModel:'fixture'};},
  async runAgent({prompt}){
   seen.push(prompt);
   if(!isIntentPrompt(prompt))return {output:JSON.stringify({artifact:plan})};
   assert.ok(prompt.includes(date));
   assert.match(prompt,/2026-11-19T11:00:00(?:\.000)?Z/);
   assert.doesNotMatch(prompt,/2026-11-20T11:00:00(?:\.000)?Z/);
   return {output:JSON.stringify({artifact:{status:'proposed',interpretation:'The user specified today, and the cutoff has passed.',reason:'Explicit day is not a rolling clock time.'}})};
  }
 };
 const events=[];
 const run={id:'explicit-turn',taskId:'explicit-task',input:explicit,createdAt:date,chatPlanning:'on'};
 await prepareChatPlanning({run,node:{id:'agent',model:'fixture'},signal:new AbortController().signal,directory,runtime,assertAdmission(){},emit:event=>events.push(event)});
 assert.ok(seen.some(x=>/2026-11-19T11:00:00(?:\.000)?Z/.test(x)));
 assert.deepEqual(events.filter(e=>e.moduleId===id).map(e=>e.phase),['started','completed']);
 assert.equal(run.goal,undefined);
});


test('a host-bound expired Goal remains fixed, and a retry does not acquire a fresh deadline',async()=>{
 const {chatIntentContext}=await import('../lib/chat-intent-inference.mjs');
 const fixed='2026-11-19T11:00:00.000Z', createdAt='2026-11-19T16:44:00.000Z';
 const bound=chatIntentContext({input:task,createdAt},{deadlineAt:fixed});
 assert.equal(bound.requestKind,'bound-goal');
 assert.equal(bound.activeGoalDeadline,fixed);
 assert.equal(bound.clockCandidate,undefined);
 const retry=chatIntentContext({input:task,createdAt,retryOf:'earlier-attempt'});
 assert.equal(retry.requestKind,'retry');
 assert.equal(retry.clockCandidate,undefined);
});



test('explicit selected method with coordinated constraints survives initial and bound Goal turns',()=>{
 const objective='Continue the authorized job search until 8:00 AM Eastern on November 26, 2026. Use the current Remote Job Search skill and existing user constraints. Complete applications.';
 assert.deepEqual(explicitMethodTitles(objective),['Remote Job Search']);
 const run={id:'r2',taskId:'t1',goalDispatch:{conversationId:'t1',goalId:'g1',generation:1,epoch:2},goal:{id:'g1',generation:1,objective}};
 assert.deepEqual(explicitMethodTitles(boundGoalMethodObjective(run)),['Remote Job Search']);
 assert.deepEqual(explicitMethodTitles('Read and use the current Remote Job Search skill (revision 14) and Job Search skill, and established user requirements.'),['Remote Job Search','Job Search']);
 for(const input of ['Describe the Remote Job Search skill.','Use the Remote Job Search skill and explain why it is flawed.','> Use the Remote Job Search skill and existing user constraints.','The prior user said "Use the Remote Job Search skill and existing user constraints."']){
   assert.deepEqual(explicitMethodTitles(input),[],input);
 }
});
