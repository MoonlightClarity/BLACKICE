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
const application='Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.';
const historyContract=[
 "Before choosing an application target, discover and read available application history, trackers, and submission receipts",
 "Do this even when the current request does not mention earlier applications",
 "A missing or stale index is not evidence that no application was made",
 "Reconcile each candidate by employer and exact requisition/posting ID",
 "using the authoritative URL and receipt evidence to resolve aliases",
 "another requisition at the same employer is a separate candidate",
 "Preserve positive earlier confirmation even when a newer summary omits it or labels it unchecked",
 "Do not submit again to a confirmed requisition unless the user specifically requested reapplication",
 "Earlier confirmations do not count toward this request's new applications",
 "For an uncertain earlier attempt, check the destination and available receipt before replaying",
 "pursue another eligible role allowed by the request without asking about the blocked option",
 "Before submission, recheck the chosen requisition against the reconciled history and any attempts made during this task",
 "Count only a confirmed submission made for this request as a new application",
 "Record the requisition, outcome, timestamp, and confirmation evidence in the application history",
];
const assertHistoryMethod=content=>{for(const expected of historyContract)assert.ok(content.includes(expected),expected);};
const agreementContract=[
 "A request to apply carries implied consent for the submission steps and agreements required to complete the application",
 "Accept every required agreement",
 "“Yes,” “I agree,” or the equivalent affirmative control",
 "including for arbitration, waivers, applicant-data notices, and other required terms",
 "Do not ask for renewed permission or decline a required agreement because of its legal effect",
 "Honor an explicit user prohibition or prepare-only instruction",
 "Answer factual questions and attestations in good faith",
 "accepting an agreement does not authorize inventing facts",
 "Leave optional marketing and unrelated optional sharing unchecked",
 "Complete submission and verify the result within the user's scope"
];
const assertAgreementMethod=content=>{
 for(const expected of agreementContract)assert.ok(content.includes(expected),expected);
 assert.doesNotMatch(content,/compare its actual effect with the requested application and the user's limits, then make the delegated choice/,'required agreement acceptance is explicit rather than discretionary');
};
const jobSearchCalibrationContract=[
 "Treat that default as a search and ranking preference; an older or unknown posting date alone does not exclude an otherwise suitable role unless the user requested a recency limit.",
 "For a user-requested recent count, keep older or unknown-age roles outside a verified recent count",
 "If first posting remains unknown and the user requires a verified recent opening, keep the lead provisional for that count",
 "Use targeted exact-requisition checks, including the browser's attached history results, to reconcile each candidate",
 "Read the relevant cited record when its outcome needs clarification",
 "A reasonable targeted check that finds no evidence of an earlier submission is sufficient to proceed",
 "describe it as “no evidence found” without claiming exhaustive clearance",
 "Stop broad history reading once that check supports the next action"
];
const assertJobSearchCalibrationMethod=content=>{for(const expected of jobSearchCalibrationContract)assert.ok(content.includes(expected),expected);};
const sharedConfirmationContract=[
  "A requested action includes its required follow-up confirmations",
  "check the user's matching mailbox through available tools, including connected Gmail when available",
  "Match the message to this attempt and complete its required link or code step, then inspect the destination outcome",
  "Keep the attempt pending until the required confirmation and requested outcome are observed",
  "allow delivery time and recheck; an empty first search is not a final failure",
  "Use short waits and continue independent requested work between checks, within the user's actual cutoff",
  "Report a failed route accurately and continue independent work or allowed alternatives toward the requested outcome",
  "Preserve an explicitly fixed target; a different result does not complete it",
  "Inspect uncertain prior effects before repeating them; do not resubmit merely because a message is delayed"
];
const jobConfirmationContract=[
  "Complete required email confirmation through the shared follow-up procedure, including connected Gmail when it is the user's available mailbox",
  "Keep the application pending until the required confirmation is completed and its outcome is verified",
  "Report a failed application and continue the broader search or another suitable role when the request allows alternatives",
  "Preserve an explicitly fixed target; a different application does not fulfill it"
];
const assertJobConfirmationMethod=content=>{for(const expected of jobConfirmationContract)assert.ok(content.includes(expected),expected);};
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

test('new applications discover history before selecting targets and reconcile exact requisitions before submission',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assertHistoryMethod(content);
 assert.ok(content.indexOf('## Reconcile application history')<content.indexOf('## Search current openings'),'history discovery precedes target selection');
 assert.doesNotMatch(content,/Before repeating an application, check any known/,'history discovery must not depend on already knowing this is a repeat');
});

test('an application request carries implied consent for affirmative required agreements while factual answers remain in good faith',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assertAgreementMethod(content);
});

test('job-specific recency and history calibration complements the shared task policy',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assertJobSearchCalibrationMethod(content);
 assert.doesNotMatch(content,/## Allocate effort by expected value/,'general effort policy belongs in common Instructions');
});

test('application confirmations remain pending until observed and failed candidates preserve the broader scope',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assertJobConfirmationMethod(content);
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
  /pursue another eligible route or role allowed by the request without asking for information needed only by the blocked option/,
  /Keep working toward the requested application count/,
  /reasonable inferences/,
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


function syntheticOutcomeAssessment(request,expectedInput,workerRequest){
 const prompt=request.messages?.find(message=>typeof message.content==='string'&&message.content.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW'))?.content;
 if(!prompt)return null;
 const {snapshot}=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
 assert.equal(snapshot.request,expectedInput,'the readonly assessment retains the unchanged ordinary request');
 assert.equal(request.model,workerRequest.model,'assessment uses the same model as the worker');
 assert.equal(request.reasoning_effort,workerRequest.reasoning_effort,'assessment preserves the worker effort');
 assert.deepEqual(request.tools||[],[],'these small inline-evidence fixtures expose no reviewer action tools');
 // This explicit mock disposition exercises transport, not model judgment or
 // a real application outcome. All original worker/history assertions remain.
 return {decision:'respond',summary:'Synthetic transport assessment. No real application outcome is claimed.',
  remaining:[],nextAction:'',evidenceRefs:snapshot.evidence.records.length?[snapshot.evidence.records.at(-1).citationRef]:['user-request'],blockers:[]};
}

class Native extends EventEmitter {
 status(){return {connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('No native inference in this test');}
}

test('actual Compatible main-turn transport submits the job skill selectively and respects owner deletion',{timeout:15000},async t=>{
 const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-job-skill-'));
 const dataDir=path.join(dir,'engine'),catalog=createSkillsCatalog({dataDir});
 const prompts=[],before=[],allRequests=[],workerRequests=[],assessmentRequests=[];
 let engine,runtime,identity;
 const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'fixture'}]}));}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),run=[...engine.runs.values()].at(-1);
  allRequests.push(body);
  const assessment=syntheticOutcomeAssessment(body,run.input,workerRequests.at(-1));
  if(assessment){
   assessmentRequests.push(body);res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(assessment)}}]}));
  }
  workerRequests.push(body);prompts.push(body.messages);
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
 const invoke=async (task, directoryDiagnostics, expectedCalls=2)=>{
  const requestOffset=prompts.length,allOffset=allRequests.length,assessmentOffset=assessmentRequests.length;
  const start=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir,chatPlanning:'off',directoryActions:'off',directoryDiagnostics});
  await engine.executions.get(start.run.id);
  const run=engine.getRun(start.run.id);
  assert.equal(run.status,'completed',run.error);
  assert.equal(prompts.length-requestOffset,expectedCalls,'the original main request and single worker evidence check remain');
  assert.equal(assessmentRequests.length-assessmentOffset,1,'one explicit read-only outcome assessment follows');
  assert.equal(allRequests.length-allOffset,expectedCalls+1,'all provider calls are counted');
  assert.deepEqual(before[requestOffset],[],'transport has not yet accepted the main prompt');
  if(expectedCalls===2)assert.deepEqual(before[requestOffset+1],run.skillLoadReceipts,'the review follows accepted main-turn skill delivery');
  return {prompt:JSON.stringify(prompts[requestOffset]),requests:allRequests.slice(allOffset).map(request=>request.messages),input:run.input,receipts:run.skillLoadReceipts||[],events:run.events.map(event=>event.data)};
 };
 const alignmentId='builtin-task-grounding';
 const alignmentHeading='ANTI-OVERALIGNMENT (advisory execution method; not permission)';
 const antiCompletion='library-anti-completion-bias';
 const completionReceipt=(source,sourceRevision)=>({type:'skill_context_submitted',skillId:antiCompletion,title:'Anti-Completion Bias',source,sourceRevision});
 const browserSkill='library-browser-navigation';
  const completionId='library-what-makes-done',completionSkill=await catalog.detail({id:completionId});
  const assertSharedConfirmationDelivery=record=>{
   assert.ok(record.receipts.some(receipt=>receipt.skillId===completionId&&receipt.source==='bundled'&&receipt.sourceRevision===completionSkill.provenance.revision));
   for(const messages of record.requests){
    const wire=JSON.stringify(messages);
    assert.ok(wire.includes(JSON.stringify(completionSkill.content).slice(1,-1)),'the complete shared confirmation method reaches every actual provider request');
    for(const expected of sharedConfirmationContract)assert.ok(wire.includes(expected),expected);
   }
  };
 const job=await invoke(example);
  assertSharedConfirmationDelivery(job);
 assert.ok(job.prompt.includes('An empty tab list means there is no tab to reuse'));
 assert.ok(job.prompt.includes('the link opened a new tab'));
 const browserRevision=(await catalog.detail({id:browserSkill})).provenance.revision;
 assert.ok(job.receipts.some(r=>r.skillId===browserSkill&&r.sourceRevision===browserRevision));
 assert.equal(job.prompt.split('ANTI-COMPLETION BIAS (bundled execution method)').length,2);
 assert.ok(job.prompt.includes('Compare the request with the last result you actually observed'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===antiCompletion),[completionReceipt('bundled','clarity-20261121')]);
 assert.ok(job.prompt.includes(alignmentHeading));
 assert.ok(job.prompt.includes('Take the simplest route that delivers the whole result'));
 assert.ok(job.prompt.includes('Name the exact action and the observed obstacle'));
 assert.ok(job.prompt.includes('Make the best supported decision and take the step'));
 assert.doesNotMatch(job.prompt,/sponsor/i,'built-in instructions do not give away the unrelated factual form case');
 assert.equal(job.input,example,'built-in agreement policy does not alter the ordinary user request');
 assert.doesNotMatch(job.input,/sponsor|arbitrat/i,'the ordinary user request contains no form-answer coaching');
 assert.ok(job.receipts.some(r=>r.skillId===alignmentId&&r.title==='Anti-Overalignment'&&r.type==='skill_context_submitted'));
 assert.ok(job.prompt.includes(heading));assert.ok(job.prompt.includes('rolling last seven days'));assert.ok(job.prompt.includes('## Verify the exact vacancy'));
 assert.ok(job.prompt.includes('pursue another eligible route or role allowed by the request without asking for information needed only by the blocked option'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===id),[accepted]);
 assert.ok(job.receipts.every(r=>r.skillId!=='library-intent-inference'));

 const applicationRun=await invoke(application);
  assertSharedConfirmationDelivery(applicationRun);
  assertJobConfirmationMethod(applicationRun.prompt);
 assert.equal(applicationRun.input,application,'the admitted task remains the unchanged ordinary request');
 assert.ok(applicationRun.requests.every(messages=>JSON.stringify(messages).includes(application)),'the unchanged user task reaches each real provider request');
 assertHistoryMethod(applicationRun.prompt);
 assert.doesNotMatch(applicationRun.input,/sponsor|arbitrat/i,'the unchanged ordinary apply request contains no agreement-answer coaching');
 assertAgreementMethod(applicationRun.prompt);
 assertJobSearchCalibrationMethod(applicationRun.prompt);
 assertJobSearchCalibrationMethod(job.prompt);
 assert.deepEqual(applicationRun.receipts.filter(r=>r.skillId===id),[accepted]);

 await catalog.save({id:antiCompletion,value:{expectedRevision:1,content:'# Anti-Completion Bias\nUse the owner-defined next-action instruction.'}});
 const ordinary=await invoke('Write a short explanation of how job search works.');
  assertSharedConfirmationDelivery(ordinary);
  assert.equal(ordinary.input,'Write a short explanation of how job search works.','the unrelated ordinary task remains unchanged');
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
  assertSharedConfirmationDelivery(deleted);
 assert.ok(!deleted.prompt.includes('ANTI-COMPLETION BIAS ('));
 assert.ok(deleted.receipts.every(r=>r.skillId!==antiCompletion));
 assert.ok(deleted.receipts.some(r=>r.skillId==='library-what-makes-done'));
 assert.ok(!deleted.prompt.includes(alignmentHeading));
 assert.ok(deleted.receipts.every(r=>r.skillId!==alignmentId));
 assert.ok(!deleted.prompt.includes(heading));assert.ok(deleted.receipts.every(r=>r.skillId!==id));
 assert.equal(prompts.length,8,'four ordinary worker conversations retain their original two requests');
 assert.equal(assessmentRequests.length,4,'one isolated assessment per ordinary conversation');
 assert.equal(allRequests.length,12,'skill selection adds no unaccounted provider calls');
 const instrumented=await invoke('Apply to one job for me: Senior Product Manager.','maximal',2);
 const decisions=instrumented.events.filter(event=>event.type==='chat.execution-review');
 const evidenceFingerprint=decisions[0]?.evidenceFingerprint;
 assert.match(evidenceFingerprint,/^[a-f0-9]{64}$/);
 const evidence={type:'chat.execution-review',reviewMode:'ordinary-chat',evidenceRevision:0,pendingToolCount:0,uncertainToolCount:0,evidenceFingerprint,outcomeVerification:'not-evaluated',effectReplayEnforcement:'existing-host-controls'};
 assert.deepEqual(decisions,[
  {...evidence,reason:'current-task-evidence-check',reviewDecision:'continue'},
  {...evidence,reason:'task-outcome-supported',reviewDecision:'accepted'},
 ]);
 const ordinaryDepth=await invoke('Apply to one job for me: Senior Product Manager.','off',2);
 assert.deepEqual(ordinaryDepth.events.filter(event=>event.type==='chat.execution-review'),[
  {...evidence,reason:'current-task-evidence-check',reviewDecision:'continue'},
 ],'ordinary receipt depth retains the continuation without the diagnostic accepted-state event');
});
