import test from 'node:test';import assert from 'node:assert/strict';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {taskSkillQueries,discoverTaskSkills,diversifySkillCandidates} from '../lib/task-skill-discovery.mjs';

test('recurring work gains a general resource-allocation method independent of domain and employer criteria',async()=>{
 const c=createSkillsCatalog();try{
  const metadata=await c.taskMetadata();
  for(const prompt of ['Apply for jobs','Find and submit applications for remote positions','Prioritize several software repairs under a time budget','Decide which of three supplier problems to investigate before the deadline']){
   const plan=discoverTaskSkills(prompt,metadata);
   assert(plan.selection.facets.includes('resource-allocation'),prompt);
   assert(plan.automatic.some(s=>s.id==='library-long-term-judgment'),prompt);
   assert(plan.selection.decisions.some(d=>d.id==='library-long-term-judgment'&&d.decision==='selected'),prompt);
  }
  for(const prompt of ['Apply to this specific opening','Copy the exact text of the document','Audit the job-search skill', 'Write a short thank-you email']){
   const selection=discoverTaskSkills(prompt,metadata);
   assert(!selection.automatic.some(s=>s.id==='library-long-term-judgment'),prompt);
  }
  const disabled=discoverTaskSkills('Apply for jobs',metadata,{excludeIds:['library-long-term-judgment']});
  assert(!disabled.automatic.some(s=>s.id==='library-long-term-judgment'));
  assert(disabled.selection.decisions.some(d=>d.id==='library-long-term-judgment'&&d.decision==='already-loaded'));
 }finally{await c.close();}
});

test('diverse candidates retain the highest relevance while choosing complementary methods before duplicates',()=>{
 const rec=(id,score,description,tags)=>({entry:{id,title:id,description,tags},score,auto:false,receipt:{id,decision:'candidate'}});
 const rows=[rec('source-analysis',100,'Compare several source documents for factual evidence',['research']),
 rec('source-analysis-copy',94,'Compare several source documents for factual evidence',['research']),
 rec('source-analysis-duplicate',90,'Compare several source documents for factual evidence',['research']),
 rec('implementation-test',83,'Test executable implementation against observed behavior',['coding']),
 rec('decision-allocation',80,'Choose the next option based on delay and opportunity cost',['methods'])];
 const selected=diversifySkillCandidates(rows,{limit:3});
 assert.equal(selected[0].entry.id,'source-analysis');
 assert(selected.some(r=>r.entry.id==='implementation-test'));
 assert(selected.some(r=>r.entry.id==='decision-allocation'));
 assert.equal(new Set(selected.map(r=>r.entry.id)).size,3);
 assert.deepEqual(selected.map(r=>r.receipt.candidateRank),[1,2,3]);
 assert.deepEqual(rows.map(r=>r.entry.id),['source-analysis','source-analysis-copy','source-analysis-duplicate','implementation-test','decision-allocation'],'source order is not mutated');
 assert.throws(()=>diversifySkillCandidates(rows,{limit:33}),/limit/);
});

test('skill maintenance never auto-runs the operational method being audited',async()=>{
 const c=createSkillsCatalog();try{
  const metadata=await c.taskMetadata();
  for(const task of ['Audit the job search skills system and evaluate selection', 'Review the skills infrastructure methods', 'Diagnose the job search workflow']){
   const result=discoverTaskSkills(task,metadata);
   assert(!result.automatic.some(s=>s.id==='library-long-term-judgment'||s.id==='library-job-search'),task);
  }
 }finally{await c.close();}
});
