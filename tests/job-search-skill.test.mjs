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
import {wantsJobSearchSkill,wantsJobSearchExecutionSkill,wantsIntentInferenceSkill,wantsBrowserNavigationSkill} from '../lib/chat-intent-inference.mjs';
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
 "Reuse application history and submission receipts already available",
 "If necessary, load the relevant index once for a candidate batch",
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
 "Use applicable prior application answers, saved user records, and context",
 "Complete contact and experience fields and attach the designated resume",
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
const accepted={type:'skill_context_submitted',skillId:id,title:'Job Search',source:'bundled',sourceRevision:'agency-efficiency-20261125',contentMode:'brief'};

test('current actionable job requests select only the job skill, not the general intent skill',()=>{
 for(const input of [example,'Apply for jobs until 6 AM EST.','Apply for the Circana Senior Product Manager, AI Evaluation & Quality position.','Apply to this job opening.','Job search for me. Stop at 3 jobs.','Can you shortlist remote open roles?','Please load the Job Search skill.','Search job boards for research roles.']){
  assert.equal(wantsJobSearchSkill(input),true,input);
  if(!input.startsWith('Apply'))assert.equal(wantsIntentInferenceSkill(input),false,input);
 }
 for(const input of ['Improve our job search skill.','How does job search work?','Find the jobs in the queue.','Find current roles and permissions.',
   'The user wrote: "Find three market analyst jobs."','> '+example,
   '`\x60\x60text\n'+example+'\n`\x60\x60','\u201c'+example+'\u201d'])assert.equal(wantsJobSearchSkill(input),false,input);
});
const diagnosisOnlyWorkflows=[
 'Run the job search workflow, but only diagnose it; do not take any actions.',
 'Restart the job-search workflow. Diagnose only.',
 'Run the job search workflow in simulation mode.',
 'Run the job search workflow for diagnosis only.',
];
test('explicit operational workflow commands select Job Search without selecting diagnostic examples',()=>{
 for(const input of [
  'Restart the real BLACKICE job-search/application workflow as a diagnostic endurance test in Chat Mode.',
  'Run my job search workflow and only shortlist roles.',
  'Resume the job application workflow.',
  'Conduct my real overnight remote job search and submit genuine applications until 6 AM EST.',
  'Carry out my remote job search and submit applications.',
  'Please perform the job search workflow.',
  'Could you conduct my remote job search?',
  'Begin the remote job search.',
   'Continue my real overnight remote job search and submit genuine applications until 6 AM EST.',
 ]) {
  assert.equal(wantsJobSearchExecutionSkill(input),true,input);
  assert.equal(wantsJobSearchSkill(input),false,"the legacy selector is unchanged: "+input);
  assert.equal(wantsBrowserNavigationSkill(input),false,"workflow syntax alone does not load browser guidance: "+input);
 }
 for(const input of [
  'Diagnose why we failed to restart the real BLACKICE job-search/application workflow.',
  'Explain how to resume the job search workflow.',
  'Run the job search workflow as a dry run without searching.',
  'Use this example: "Restart the real BLACKICE job-search/application workflow."',
  '> Restart the real BLACKICE job-search/application workflow.',
  'Restart the BLACKICE job runtime scheduler.',
  'Run the job-search skill tests.',
  'Run the job-search workflow tests.',
  'Run the job-search workflow as a simulation.',
  'Conduct the remote job search workflow as a dry run.',
  'Perform the job search workflow tests.',
  'Carry out the remote job search skill audit.',
  'Explain how to conduct a remote job search.',
  '> Conduct my real overnight remote job search.',
  'Conduct the job search workflow, but only diagnose it; do not take any actions.',
  ...diagnosisOnlyWorkflows,
 ]) assert.equal(wantsJobSearchExecutionSkill(input),false,input);
});

test('the discoverable packaged skill prioritizes employer sources, W-2 fit and live requisitions',async()=>{
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
  /Start with actual vacancies on relevant employers.*careers pages and public ATS boards/,
  /Search by outputs and duties as well as titles/,
  /Check promising exact vacancies rather than exhausting broad searches first/i,
  /portfolio.s hiring companies/,
  /funding announcement or indexed snippet does not establish/,
  /A W-2 contract or a posting that offers a W-2 option is not the same as a 1099 gig/,
  /exact requisition\/posting ID/,
  /same vacancy accepts applications/,
  /Retire closed or expired postings/,
  /archived mirror[\s\S]*alone is insufficient/,
  /genuine role gates/,
  /explicit 1099, freelance, independent-contractor, or per-task paid work is a mismatch/,
  /Indeed and aggregate job boards as supplementary discovery routes/,
  /findings for a search[\s\S]*user asked to apply/,
  /before retrying/,
  /“Up to N” is a cap, not a completion minimum/,
  /Check promising exact vacancies rather than exhausting broad searches first/,
  /honest shortfall/,
  /Count only a confirmed submission/,
 ])assert.match(content,expected);
});

test('new applications reuse history by batch and reconcile exact requisitions before submission',async()=>{
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
 assert.equal(provenance.revision,'agency-efficiency-20261125');
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
  /Use applicable prior application answers, saved user records, and context/,
  /Complete contact and experience fields and attach the designated resume/,
  /same requisition/,
  /continue independent authorized work/,
  /preserve the application as pending/,
  /reasonable inferences/,
  /lengthy essays and take-homes/,
  /do not add unsolicited resume tailoring/,
  /current designated application resume unchanged by default/,
  /Do not tailor, rewrite, reformat, or create role-specific resume versions unless the user explicitly requests it/,
  /do not stop at the first workspace hit/,
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
  /employers.*careers pages and public ATS boards/,
  /current documented read interface/,
  /Distinguish first publication from updates or republication/,
  /Do not copy endpoint schemas from an old source file/,
  /fresh republish timestamp does not erase an older dated copy/,
  /remote geography, travel, compensation basis/,
  /direct competitors/,
  /Distinguish first publication from updates or republication/,
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

test('Compatible provider uses job skills only when explicitly requested and honors current edits and deletions',{timeout:20000},async t=>{
 const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-job-skill-'));
 const dataDir=path.join(dir,'engine'),catalog=createSkillsCatalog({dataDir});
 let engine,runtime,identity;
 const workers=[],assessors=[];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET')return res.end(JSON.stringify({data:[{id:'fixture'}]}));
  let raw='';for await(const part of req)raw+=part;
  const request=JSON.parse(raw),current=[...engine.runs.values()].at(-1);
  const assessment=syntheticOutcomeAssessment(request,current.input,workers.at(-1));
  if(assessment){
   assessors.push(request);
   return res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(assessment)}}]}));
  }
  workers.push(request);
  return res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic read-only reply.'}}]}));
 });
 t.after(async()=>{
  await engine?.close();await runtime?.close();await catalog.close();await identity?.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const actual=await realpath(dir);assert.equal(path.dirname(actual),root);
  await rm(actual,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
 await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',
  baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
  models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
 identity=await new IdentityStore({dataDir}).init();
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dir,identity,
  browser:{status:()=>({available:true,contained:true,tabs:[]}),
    perform:()=>assert.fail('Fixture does not touch actual websites')}}).init();
 const api=async(route,_method,body)=>route==='/api/workflows'?body:engine.startRun(body);
 const invoke=async task=>{
  const workerStart=workers.length,reviewStart=assessors.length;
  const started=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir,
    chatPlanning:'off',directoryActions:'off'});
  await engine.executions.get(started.run.id);
  const run=engine.getRun(started.run.id);
  assert.equal(run.status,'completed',run.error);
  assert.equal(workers.length-workerStart,2,'main response and one evidence check');
  assert.equal(assessors.length-reviewStart,1,'one read-only assessment');
  return{prompt:JSON.stringify(workers[workerStart].messages),receipts:run.skillLoadReceipts||[],
    input:run.input};
 };
 const ordinary=await invoke(example);
 assert.equal(ordinary.input,example);
 assert.deepEqual(ordinary.receipts,[]);
 assert.doesNotMatch(ordinary.prompt,/JOB SEARCH \(advisory execution method\)/);
 assert.doesNotMatch(ordinary.prompt,/ANTI-COMPLETION BIAS \(bundled execution method\)/);
 const id='library-job-search';
 const bundled=await catalog.detail({id});
 const explicitTask='Use the Job Search skill. Then prepare an application readiness checklist.';
 const first=await invoke(explicitTask);
 assert.ok(first.prompt.includes(JSON.stringify(bundled.content).slice(1,-1)),'explicit selection transmits the effective complete method');
 assert.equal(first.receipts.find(item=>item.skillId===id).contentMode,'full');
 const edited=await catalog.save({id,value:{expectedRevision:bundled.revision,
   content:'# Job Search\nCurrent owner procedure: OWNER_CURRENT_JOB_8181.'}});
 const revised=await invoke(explicitTask);
 assert.match(revised.prompt,/OWNER_CURRENT_JOB_8181/);
 assert.ok(!revised.prompt.includes(JSON.stringify(bundled.content).slice(1,-1)),'the obsolete revision cannot be re-injected');
 assert.equal(revised.receipts.find(item=>item.skillId===id).sourceRevision,edited.revision);
 await catalog.delete({id,value:{expectedRevision:edited.revision}});
 const deleted=await invoke(explicitTask);
 assert.deepEqual(deleted.receipts,[]);
 assert.doesNotMatch(deleted.prompt,/OWNER_CURRENT_JOB_8181/);
});
