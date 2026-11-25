import {SkillHybridIndex} from '../lib/skill-hybrid-retrieval.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {taskSkillQueries,discoverTaskSkills,diversifySkillCandidates,AUTO_SKILL_BUDGET} from '../lib/task-skill-discovery.mjs';

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

test('public retrieval data cannot become executable skill instructions and installed automatic skills are bounded',()=>{
 const installed=Array.from({length:12},(_,i)=>({id:'method-'+String(i).padStart(2,'0'),title:'Time Allocation Method '+i,description:'Choose the next useful task',source:'bundled',revision:1,activationDeclared:true,activation:['resource-allocation'],tags:['methods'],aliases:[],ownerCreated:false}));
 const result=discoverTaskSkills('Prioritize several tasks under a deadline',installed);
 assert.equal(result.automatic.length,AUTO_SKILL_BUDGET);
 assert.equal(result.selection.automaticLimit,AUTO_SKILL_BUDGET);
 assert.equal(result.selection.deferredAutomatic,installed.length-AUTO_SKILL_BUDGET);
 assert(result.candidates.length>0);
 assert.equal(new Set([...result.automatic,...result.candidates].map(x=>x.id)).size,installed.length);
 assert.equal(result.selection.decisions.filter(x=>x.reason==='automatic-budget').length,installed.length-AUTO_SKILL_BUDGET);
 const external=installed.map((row,i)=>({...row,id:'public-'+i,source:'public-evaluation-only',activationDeclared:false,title:'Time allocation for task priorities'}));
 const observed=discoverTaskSkills('Prioritize several tasks under a deadline',external);
 assert.equal(observed.automatic.length,0);
 assert(observed.candidates.length<=8);
 const declared=discoverTaskSkills('Prioritize several tasks under a deadline',installed.map(x=>({...x,source:'public-evaluation-only'})));
 assert.equal(declared.automatic.length,0);
});
test('reusing a hybrid index preserves deterministic selection without injecting stale skills',()=>{

 const index=new SkillHybridIndex();try{
  const metadata=[{id:'one',title:'Triage support tickets',description:'Triage customer requests',source:'bundled',revision:'a',ownerCreated:false}];
  const a=discoverTaskSkills('Triage support tickets',metadata,{hybridIndex:index});
  const b=discoverTaskSkills('Triage support tickets',metadata,{hybridIndex:index});
  assert.deepEqual(a.automatic.map(x=>x.id),b.automatic.map(x=>x.id));
  const deleted=discoverTaskSkills('Triage support tickets',[],{hybridIndex:index});
  assert.equal(deleted.automatic.length,0);assert.equal(deleted.candidates.length,0);
 }finally{index.close();}
});
