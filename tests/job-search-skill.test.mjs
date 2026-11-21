import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {IdentityStore} from '../lib/identity.mjs';
import {ACTION_DIRECTORY_INSTRUCTIONS,ACTION_DIRECTORY_TOOL} from '../lib/task-action-directory.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {wantsJobSearchSkill,wantsIntentInferenceSkill,wantsBrowserNavigationSkill} from '../lib/chat-intent-inference.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {submitChat} from '../public/next/chat/send.mjs';

test('browser continuity applies to current navigation or a bare continuation of the same task',()=>{
 const browse='Open the vendor portal.';
 for(const task of [browse,'Visit https://example.test','Continue in the same browser tab.','Apply to one job for me: Circana.','Read the Browser Navigation and Continuity skill.']) assert.equal(wantsBrowserNavigationSkill(task),true,task);
 for(const task of ['Explain browser navigation.', '> Open the vendor portal.', 'Summarize the document instead.','Continue.']) assert.equal(wantsBrowserNavigationSkill(task),false,task);
 assert.equal(wantsBrowserNavigationSkill('Continue.',{previousTask:browse}),true);
 assert.equal(wantsBrowserNavigationSkill('Summarize the document instead.',{previousTask:browse}),false);
});
const id='library-job-search';
const example='Find three current U.S. remote intelligence roles posted within the last week. Do not apply.';
const heading='JOB SEARCH (advisory execution method; not permission)';
const accepted={type:'skill_context_submitted',skillId:id,title:'Job Search',source:'bundled',sourceRevision:'clarity-20261121'};

test('current actionable job requests select only the job skill, not the general intent skill',()=>{
 for(const input of [example,'Apply for jobs until 6 AM EST.','Apply for the Circana Senior Product Manager, AI Evaluation & Quality position.','Apply to this job opening.','Job search for me. Stop at 3 jobs.','Can you shortlist remote open roles?','Please load the Job Search skill.','Search job boards for research roles.']){
  assert.equal(wantsJobSearchSkill(input),true,input);
  if(!input.startsWith('Apply'))assert.equal(wantsIntentInferenceSkill(input),false,input);
 }
 for(const input of ['Improve our job search skill.','How does job search work?','Find the jobs in the queue.','Find current roles and permissions.',
   'The user wrote: "Find three market analyst jobs."','> '+example,
   '`\x60\x60text\n'+example+'\n`\x60\x60','\u201c'+example+'\u201d'])assert.equal(wantsJobSearchSkill(input),false,input);
});

test('the discoverable packaged skill checks recency and live requisition separately',async()=>{
 const catalog=createSkillsCatalog();
 const {entries}=await catalog.list({query:'job search'});
 assert.equal(entries[0].id,id);
 assert.equal(Object.hasOwn(entries[0],'content'),false);
 const {content}=await catalog.detail({id});
 for(const expected of [
  /rolling last seven days unless the current request specifies a different window/,
  /current search timestamp/,
  /original posting or opening date/,
  /last-published timestamps alone do not establish/,
  /reopened or new requisition[\s\S]*opening event and date/,
  /Check age and whether applications are accepted separately/,
  /older or unknown-age roles outside a verified recent count/,
  /multiple relevant job boards and company career sites in parallel/,
  /direct and adjacent searches from the first pass/,
  /rank primary matches first without waiting to exhaust them/i,
  /venture firm's portfolio jobs page/,
  /funding date or announcement does not establish/,
  /do not assume all contracts are gig work/,
  /exact requisition\/posting ID/,
  /same vacancy accepts applications/,
  /Retire closed or expired postings/,
  /archived mirror[\s\S]*alone is insufficient/,
  /genuine role gates/,
  /findings for a search[\s\S]*user asked to apply/,
  /before retrying/,
  /“Up to N” is a cap, not a completion minimum/,
  /each promising exact vacancy as it appears/,
  /honest shortfall/,
  /Count only a confirmed submission/,
 ])assert.match(content,expected);
});

test('fit ignores listed years even for director roles and credits work under adjacent titles',async()=>{
 const {content,provenance}=await createSkillsCatalog().detail({id});
 assert.equal(provenance.revision,'clarity-20261121');
 for(const expected of [
  /Ignore every numerical years-of-experience requirement when evaluating fit/,
  /Do not use it to filter, rank, downlevel, or decide not to apply/,
  /director role listing 10\+ years/,
  /actual results and user-supplied interview outcomes/,
  /Credit comparable work under administrative, independent, or adjacent titles/,
  /never claim a license, clearance, title, or tool experience/,
  /add nonoverlapping periods/,
  /adjacent title does not turn supported experience into zero/,
  /Answer direct tenure fields accurately/,
  /Do not invent a director title or reject the role merely on the years line/,
 ])assert.match(content,expected);
});

test('routine fields use known answers without added friction and behavioral essays are an effort decision',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 for(const expected of [
  /Read the question, make the best supported call, and enter it/,
  /Do not demand documents or corroboration merely to defend a routine answer/,
  /Hold competing answers to the same standard/,
  /Use known answers about relatives/,
  /leave only that field unresolved and finish independent steps/,
  /reasonable inferences/,
  /acknowledge it when required[\s\S]*Leave optional marketing and unrelated sharing unchecked/,
  /A separate waiver or commitment is a separate choice/,
  /lengthy essays, take-homes, and extensive tailoring/,
  /an effort decision, not a verdict on fit/,
  /Save deeper company preparation for a screen or interview/,
 ])assert.match(content,expected);
});

test('discovery recovery uses current source contracts instead of copied API schemas',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assert.ok(content.length<=20000,'Job Search must fit the automatic execution context budget');
 for(const expected of [
  /Search by outputs and duties as well as titles/,
  /blank page or broken browser reference/,
  /change to another relevant source before declaring a shortfall/,
  /site:job-boards.greenhouse.io/,
  /current documented read interface/,
  /Distinguish first publication from updates or republication/,
  /Do not copy endpoint schemas from an old source file/,
  /fresh republish timestamp does not erase an older dated copy/,
  /remote geography, travel, compensation basis/,
  /direct competitors/,
  /first seen, not first posted/,
  /when checked/,
  /career-manager\/blob\/main\/job-search\/SKILL.md/,
 ])assert.match(content,expected);
 assert.doesNotMatch(content,/\{"action":|action:"/);
});

test('Directory models capped and required searches differently in the instructions and tool field',()=>{
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/use qualifying only for a required minimum/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/For 'up to N', omit qualifying/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/below its cap, including zero, after its agreed routes are checked/);
 assert.match(ACTION_DIRECTORY_INSTRUCTIONS,/requires successful current reads for every declared source/);
 assert.match(ACTION_DIRECTORY_TOOL.inputSchema.properties.actions.items.properties.qualifying.properties.minQualifyingCount.description,/Required lower bound only/);
});

class Native extends EventEmitter {
 status(){return {connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('No native inference in this test');}
}

test('actual Compatible main-turn transport submits the job skill selectively and respects owner deletion',{timeout:15000},async t=>{
 const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-job-skill-'));
 const dataDir=path.join(dir,'engine'),catalog=createSkillsCatalog({dataDir});
 const prompts=[],before=[];
 let engine,runtime,identity;
 const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'fixture'}]}));}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);
  prompts.push(body.messages);
  const run=[...engine.runs.values()].at(-1);
  before.push(structuredClone(run.skillLoadReceipts||[]));
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic read-only reply.'}}]}));
 });
 t.after(async()=>{
  await engine?.close();await runtime?.close();await catalog.close();await identity?.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const actual=await realpath(dir);assert.equal(path.dirname(actual),root);
  assert.match(path.basename(actual),/^blackice-job-skill-/);
  await rm(actual,{recursive:true,force:true});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
 await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
 identity=await new IdentityStore({dataDir}).init();
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dir,identity,browser:{status:()=>({available:true,contained:true,tabs:[]}),perform:()=>assert.fail('No real browser action is part of this test')}}).init();
 const api=async(route,_method,body)=>route==='/api/workflows'?body:engine.startRun(body);
 const invoke=async (task, directoryDiagnostics, expectedCalls=1)=>{
  const requestOffset=prompts.length;
  const start=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir,chatPlanning:'off',directoryActions:'off',directoryDiagnostics});
  await engine.executions.get(start.run.id);
  const run=engine.getRun(start.run.id);
  assert.equal(run.status,'completed',run.error);
  assert.equal(prompts.length-requestOffset,expectedCalls,'only the main request and the expected single evidence review may run');
  assert.deepEqual(before[requestOffset],[],'transport has not yet accepted the main prompt');
  if(expectedCalls===2)assert.deepEqual(before[requestOffset+1],run.skillLoadReceipts,'the review follows accepted main-turn skill delivery');
  return {prompt:JSON.stringify(prompts[requestOffset]),receipts:run.skillLoadReceipts||[],events:run.events.map(event=>event.data)};
 };
 const alignmentId='builtin-task-grounding';
 const alignmentHeading='ANTI-OVERALIGNMENT (advisory execution method; not permission)';
 const antiCompletion='library-anti-completion-bias';
 const completionReceipt=(source,sourceRevision)=>({type:'skill_context_submitted',skillId:antiCompletion,title:'Anti-Completion Bias',source,sourceRevision});
 const browserSkill='library-browser-navigation';
 const job=await invoke(example);
 assert.ok(job.prompt.includes('An empty tab list means there is no tab to reuse'));
 assert.ok(job.prompt.includes('the link opened a new tab'));
 assert.ok(job.receipts.some(r=>r.skillId===browserSkill&&r.sourceRevision==='clarity-20261121'));
 assert.equal(job.prompt.split('ANTI-COMPLETION BIAS (bundled execution method)').length,2);
 assert.ok(job.prompt.includes('Compare the request with the last result you actually observed'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===antiCompletion),[completionReceipt('bundled','clarity-20261121')]);
 assert.ok(job.prompt.includes(alignmentHeading));
 assert.ok(job.prompt.includes('Take the simplest route that delivers the whole result'));
 assert.ok(job.prompt.includes('Name the exact action and the observed obstacle'));
 assert.ok(job.prompt.includes('Make the best supported decision and take the step'));
 assert.doesNotMatch(job.prompt,/sponsor|arbitrat/i,'The actual prompt must not give away either held-out form case');
 assert.ok(job.receipts.some(r=>r.skillId===alignmentId&&r.title==='Anti-Overalignment'&&r.type==='skill_context_submitted'));
 assert.ok(job.prompt.includes(heading));assert.ok(job.prompt.includes('rolling last seven days'));assert.ok(job.prompt.includes('## Verify the exact vacancy'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===id),[accepted]);
 assert.ok(job.receipts.every(r=>r.skillId!=='library-intent-inference'));

 await catalog.save({id:antiCompletion,value:{expectedRevision:1,content:'# Anti-Completion Bias\nUse the owner-defined next-action instruction.'}});
 const ordinary=await invoke('Write a short explanation of how job search works.');
 assert.ok(!ordinary.prompt.includes('BROWSER NAVIGATION AND CONTINUITY ('));
 assert.ok(ordinary.receipts.every(r=>r.skillId!==browserSkill));
 assert.ok(ordinary.prompt.includes('Use the owner-defined next-action instruction.'));
 assert.ok(!ordinary.prompt.includes('Compare the request with the last result you actually observed'));
 assert.deepEqual(ordinary.receipts.filter(r=>r.skillId===antiCompletion),[completionReceipt('user',2)]);
 assert.ok(!ordinary.prompt.includes(alignmentHeading));
 assert.ok(ordinary.prompt.includes('Take the simplest route that delivers the whole result'));
 assert.ok(ordinary.receipts.every(r=>r.skillId!==alignmentId));
 assert.ok(!ordinary.prompt.includes(heading));assert.ok(ordinary.receipts.every(r=>r.skillId!==id));

 await catalog.delete({id,value:{expectedRevision:1}});
 await catalog.delete({id:alignmentId,value:{expectedRevision:1}});
 await catalog.delete({id:antiCompletion,value:{expectedRevision:2}});
 const deleted=await invoke(example);
 assert.ok(!deleted.prompt.includes('ANTI-COMPLETION BIAS ('));
 assert.ok(deleted.receipts.every(r=>r.skillId!==antiCompletion));
 assert.ok(deleted.receipts.some(r=>r.skillId==='library-what-makes-done'));
 assert.ok(!deleted.prompt.includes(alignmentHeading));
 assert.ok(deleted.receipts.every(r=>r.skillId!==alignmentId));
 assert.ok(!deleted.prompt.includes(heading));assert.ok(deleted.receipts.every(r=>r.skillId!==id));
 assert.equal(prompts.length,3,'no extra provider calls for skill selection');
 const instrumented=await invoke('Apply to one job for me: Senior Product Manager.','maximal',2);
 const decisions=instrumented.events.filter(event=>event.type==='chat.execution-review');
 const evidenceFingerprint=decisions[0]?.evidenceFingerprint;
 assert.match(evidenceFingerprint,/^[a-f0-9]{64}$/);
 const evidence={type:'chat.execution-review',reviewMode:'ordinary-chat',evidenceRevision:0,pendingToolCount:0,uncertainToolCount:0,evidenceFingerprint,outcomeVerification:'not-evaluated',effectReplayEnforcement:'existing-host-controls'};
 assert.deepEqual(decisions,[
  {...evidence,reason:'current-task-evidence-check',reviewDecision:'continue'},
  {...evidence,reason:'no-new-task-evidence',reviewDecision:'accepted'},
 ]);
 const ordinaryDepth=await invoke('Apply to one job for me: Senior Product Manager.','off',2);
 assert.deepEqual(ordinaryDepth.events.filter(event=>event.type==='chat.execution-review'),[
  {...evidence,reason:'current-task-evidence-check',reviewDecision:'continue'},
 ],'ordinary receipt depth retains the continuation without the diagnostic accepted-state event');
});
