import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {wantsJobSearchSkill,wantsIntentInferenceSkill} from '../lib/chat-intent-inference.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {submitChat} from '../public/next/chat/send.mjs';

const id='library-job-search';
const example='Find three current U.S. remote intelligence roles posted within the last week. Do not apply.';
const heading='JOB SEARCH (advisory execution method; not permission)';
const accepted={type:'skill_context_submitted',skillId:id,title:'Job Search',source:'bundled',sourceRevision:'3'};

test('current actionable job requests select only the job skill, not the general intent skill',()=>{
 for(const input of [example,'Apply for jobs until 6 AM EST.','Job search for me. Stop at 3 jobs.','Can you shortlist remote open roles?','Please load the Job Search skill.','Search job boards for research roles.']){
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
 assert.ok(content.indexOf('## Start with the posting date')<content.indexOf('## Open more than one discovery route'));
 for(const expected of [/rolling last seven days unless the current request specifies a different window/,
  /original posting or opening date/,/current search timestamp/,/last-published or last-updated field cannot/,
  /distinctly reopened or new requisition[\s\S]*corroborates the opening event and date/,
  /Check age and whether the role is still accepting applications separately/,/older or unknown-age roles out of the verified recent count/,
  /multiple relevant job boards and company career sites in parallel/,/Rank verified primary matches first/,
  /direct and adjacent searches in parallel from the first pass/,/do not require exhausting every primary search/,
  /venture firm.s public portfolio jobs page/,/funding announcement proves none of these/,/Do not assume all contracts are gig work/,
  /exact requisition\/posting ID/,/verify it reaches the same live form/,/elapsed submission deadline/,
  /archived mirror is not enough/,/genuine role gates/,/Candidates almost never meet every listed requirement/,/cycle|cycling through copies/,/search is not permission to apply/,
  /never repeat an effect/i,/"Up to N" is a cap, not a completion minimum/,/Find and verify each promising exact vacancy as you go/,/report the honest shortfall/,/count only a confirmed submission/])assert.match(content,expected);
});

test('fit ignores listed years even for director roles and credits work under adjacent titles',async()=>{
 const {content,provenance}=await createSkillsCatalog().detail({id});
 assert.equal(provenance.revision,'3');
 for(const expected of [/Ignore every numerical years-of-experience requirement when evaluating fit/,
  /Do not use it to filter, rank, downlevel, or decide not to apply/,
  /director role lists 10\+ years/,/actual results[\s\S]*interview outcomes/,
  /administrative titles has evaluated conflicting sources[\s\S]*do not claim a formal director or intelligence analyst title/,
  /Never claim a license or clearance the candidate does not hold/,
  /add nonoverlapping periods in adjacent roles/,/Do not turn three years of supported work into zero/,
  /fill it accurately and let the employer decide; do not self-reject/])assert.match(content,expected);
});

test('routine fields use known answers without added friction and behavioral essays are an effort decision',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 for(const expected of [/A job application is not a deposition/,
  /do not ask for documents to prove every routine answer/,
  /Relatives at the employer:[\s\S]*leave an unresolved answer blank/,
  /Sponsorship:[\s\S]*authorized to work now[\s\S]*need sponsorship now or in the future/,
  /Privacy:[\s\S]*acknowledge the notice[\s\S]*Leave optional marketing and unrelated sharing unchecked/,
  /Do not mistake a separate waiver/,
  /Behavioral questions in the application are the effort exception/,
  /a decision about time, not a verdict on fit/,/Save deeper interview preparation for a screen or interview/])assert.match(content,expected);
});

test('worked discovery tactics explain what to do after stale, missing, or misleading source evidence',async()=>{
 const {content}=await createSkillsCatalog().detail({id});
 assert.ok(content.length<=20000,'Job Search must fit the automatic execution context budget');
 for(const expected of [/### Everyday tactics/,/### Advanced tactics/,/Search by the work and by neighboring titles/,
  /blank page as no openings/,/Make one source change before declaring a shortfall/,
  /site:job-boards\.greenhouse\.io/,/after:YYYY-MM-DD[\s\S]*does not establish/,
  /first_published[\s\S]*distinct from .updated_at/,/publishedAt.+last publication/,
  /same ID twelve days ago/,/funding date is a reason to look, not the posting date/,
  /applicantLocationRequirements[\s\S]*baseSalary/,/direct competitors or alternative vendors/,/first seen, not first posted/,/when you verified it/,
  /career-manager\/blob\/main\/job-search\/SKILL.md/])assert.match(content,expected);
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
 let engine,runtime;
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
  await engine?.close();await runtime?.close();await catalog.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const actual=await realpath(dir);assert.equal(path.dirname(actual),root);
  assert.match(path.basename(actual),/^blackice-job-skill-/);
  await rm(actual,{recursive:true,force:true});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
 await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dir}).init();
 const api=async(route,_method,body)=>route==='/api/workflows'?body:engine.startRun(body);
 const invoke=async task=>{
  const start=await submitChat({api,runs:[],task,model:'fixture::fixture',cwd:dir,chatPlanning:'off',directoryActions:'off'});
  await engine.executions.get(start.run.id);
  const run=engine.getRun(start.run.id);
  assert.equal(run.status,'completed',run.error);
  assert.deepEqual(before.at(-1),[],'transport has not yet accepted the prompt');
  return {prompt:JSON.stringify(prompts.at(-1)),receipts:run.skillLoadReceipts||[]};
 };
 const job=await invoke(example);
 assert.ok(job.prompt.includes(heading));assert.ok(job.prompt.includes('rolling last seven days'));assert.ok(job.prompt.includes('### Advanced tactics'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===id),[accepted]);
 assert.ok(job.receipts.every(r=>r.skillId!=='library-intent-inference'));

 const ordinary=await invoke('Write a short explanation of how job search works.');
 assert.ok(!ordinary.prompt.includes(heading));assert.ok(ordinary.receipts.every(r=>r.skillId!==id));

 await catalog.delete({id,value:{expectedRevision:1}});
 const deleted=await invoke(example);
 assert.ok(!deleted.prompt.includes(heading));assert.ok(deleted.receipts.every(r=>r.skillId!==id));
 assert.equal(prompts.length,3,'no extra provider calls for skill selection');
});
