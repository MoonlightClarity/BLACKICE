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
const accepted={type:'skill_context_submitted',skillId:id,title:'Job Search',source:'bundled',sourceRevision:'1'};

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
  /archived mirror is not enough/,/hard filters and genuine role gates[\s\S]*preferred qualifications/,/gap in years, title, or a named tool is not by itself a rejection/,/do not require a perfect match/i,/Candidates almost never meet every listed requirement/,/credible transfer and no concrete blocker/,/three years in research operations[\s\S]*do not claim five years/,/cycle|cycling through copies/,/search is not permission to apply/,
  /never repeat an effect/i,/count only a confirmed submission/])assert.match(content,expected);
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
 assert.ok(job.prompt.includes(heading));assert.ok(job.prompt.includes('rolling last seven days'));
 assert.deepEqual(job.receipts.filter(r=>r.skillId===id),[accepted]);
 assert.ok(job.receipts.every(r=>r.skillId!=='library-intent-inference'));

 const ordinary=await invoke('Write a short explanation of how job search works.');
 assert.ok(!ordinary.prompt.includes(heading));assert.ok(ordinary.receipts.every(r=>r.skillId!==id));

 await catalog.delete({id,value:{expectedRevision:1}});
 const deleted=await invoke(example);
 assert.ok(!deleted.prompt.includes(heading));assert.ok(deleted.receipts.every(r=>r.skillId!==id));
 assert.equal(prompts.length,3,'no extra provider calls for skill selection');
});
