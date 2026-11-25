import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {discoverTaskSkills,taskSkillQueries} from '../lib/task-skill-discovery.mjs';

async function fixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-auto-method-'));
 const catalog=createSkillsCatalog({dataDir});
 t.after(async()=>{await catalog.close();await rm(dataDir,{recursive:true,force:true});});
 const remote=await catalog.create({value:{content:'# Remote Job Search\n\nFind and pursue remote employment using current postings.\n\n## Procedure\nDATE_FIRST_BODY_SENTINEL'}});
 const invoices=await catalog.create({value:{content:'# Month-end Controls\n\nReconcile supplier invoices against the bank ledger.\n\n## Procedure\nINVOICE_BODY_SENTINEL'}});
 const irrelevant=await catalog.create({value:{content:'# Garden Watering\n\nPlan irrigation for garden plants.'}});
 return {catalog,remote,invoices,irrelevant};
}

test('automatically discover the remote method from actual job intent, not a named request',async t=>{
 const {catalog,remote,irrelevant}=await fixture(t);
 const metadata=await catalog.taskMetadata();
 assert.ok(metadata.every(row=>!Object.hasOwn(row,'content')));
 assert.ok(!JSON.stringify(metadata).includes('DATE_FIRST_BODY_SENTINEL'));
 for(const request of [
  'Find and apply to fully remote positions posted today.',
  'Apply to remote jobs for me until 6 AM EST.',
  'Continue my real overnight remote job search and submit genuine applications.',
  'Conduct my real overnight remote job search and submit genuine applications until 6 AM EST Tuesday November 24, 2026 (11:00 UTC). Apply within my requested range: US-compatible fully remote W-2 employment. Discover broad current postings date-first, not by predicted applicant fit or familiar employer; optimize incremental return relative to time. Reconcile existing application and outreach records. Do not stop at an arbitrary application count.',
  'Carry out my remote job search and submit applications.',
 ]){
  assert.ok(taskSkillQueries(request).intent.includes('remote job search'),request);
  const selected=discoverTaskSkills(request,metadata).automatic;
  assert.ok(selected.some(row=>row.id===remote.id),request);
  assert.ok(!selected.some(row=>row.id===irrelevant.id),request);
 }
});

test('new owner methods can be discovered through purpose, without their title',async t=>{
 const {catalog,invoices,remote}=await fixture(t);
 const metadata=await catalog.taskMetadata();
 const request='Reconcile supplier invoices against the bank ledger for February.';
 assert.ok(!request.includes('Month-end Controls'));
 const selected=discoverTaskSkills(request,metadata).automatic;
 assert.ok(selected.some(row=>row.id===invoices.id));
 assert.ok(!selected.some(row=>row.id===remote.id));
});

test('diagnostic discussion and quoted tasks are not operational job-skill selections',async t=>{
 const {catalog,remote}=await fixture(t);
 const metadata=await catalog.taskMetadata();
 for(const request of [
  'Explain how remote job search works.',
  'Diagnose the remote job search workflow.',
  'Review the remote job search skill.',
  '> Apply to remote jobs for me.',
  'Run the remote job search workflow as a dry run.',
  'Conduct the remote job search workflow as a dry run.',
  'Conduct the remote job search workflow tests.',
  'Explain how to conduct a remote job search.',
 ]){
  assert.ok(!discoverTaskSkills(request,metadata).automatic.some(row=>row.id===remote.id),request);
 }
});

test('metadata reflects revision, deletion, and excludes already delivered methods',async t=>{
 const {catalog,remote}=await fixture(t);
 const request='Apply to remote jobs for me.';
 let metadata=await catalog.taskMetadata();
 assert.ok(!discoverTaskSkills(request,metadata,{excludeIds:[remote.id]}).automatic.some(row=>row.id===remote.id));
 await catalog.save({id:remote.id,value:{expectedRevision:remote.revision,content:'# Remote Job Search\n\nSearch fresh remote vacancies first.'}});
 metadata=await catalog.taskMetadata();
 assert.equal(discoverTaskSkills(request,metadata).automatic.find(row=>row.id===remote.id).revision,3);
 await catalog.delete({id:remote.id,value:{expectedRevision:3}});
 assert.ok(!(await catalog.taskMetadata()).some(row=>row.id===remote.id));
});

test('automatically load the anti-anchoring analysis method for document, code and evidence analysis',async t=>{
 const {catalog}=await fixture(t);
 const method=await catalog.create({value:{content:'---\nactivation: [substantive-analysis]\n---\n# Evidence Reconstruction\n\nReconstruct the whole before judging.'}});
 const metadata=await catalog.taskMetadata();
 for(const request of ['Analyze the following resume as employer.','Review this code for bugs','Assess the evidence in this report','Critique the argument','Analyze this document','Diagnose the startup failure','Give me an analysis of this report','What do you think of this resume?']){
  assert.ok(discoverTaskSkills(request,metadata).automatic.some(e=>e.id===method.id),request);
 }
 for(const request of ['Send me the text of the resume','Write a simple thank-you email','Review the reverse outline skill.','> Analyze this document.']){
  assert.ok(!discoverTaskSkills(request,metadata).automatic.some(e=>e.id===method.id),request);
 }
});

test('applicability and strong topical eligibility are independent of skill provenance',()=>{
 const variants=[
  {id:'builtin-method',source:'bundled',revision:1,ownerCreated:false},
  {id:'library-method',source:'user',revision:9,ownerCreated:false},
  {id:'user-method',source:'user',revision:2,ownerCreated:true}
 ];
 const methods=variants.map(row=>({...row,title:'Arbitrary Evidence Method',description:'Reconstruct material evidence.',activationDeclared:true,activation:['substantive-analysis']}));
 const selection=discoverTaskSkills('Analyze the following resume as employer.',methods);
 assert.equal(selection.automatic.length,3);
 assert.ok(selection.selection.decisions.every(row=>row.decision==='selected'&&row.reason==='declared-applicability'));
 assert.equal(discoverTaskSkills('Send me the text of the resume',methods).automatic.length,0);
 const topical=variants.map(row=>({...row,title:'Read a PDF for evidence',description:'Extract source evidence from a PDF.'}));
 assert.equal(discoverTaskSkills('Read a PDF for evidence.',topical).automatic.length,3);
});

test('effective owner declarations can override a packaged applicability default',async t=>{
 const {catalog}=await fixture(t);
 const builtin=await catalog.detail({id:'builtin-decomposition'});
 const task='Create a multistep migration plan with dependencies';
 assert.ok(discoverTaskSkills(task,await catalog.taskMetadata()).automatic.some(x=>x.id===builtin.id));
 const edited=await catalog.save({id:builtin.id,value:{expectedRevision:builtin.revision,content:'---\nactivation: none\n---\n'+builtin.content}});
 const rows=await catalog.taskMetadata(),entry=rows.find(x=>x.id===builtin.id);
 assert.equal(entry.source,'user');assert.equal(entry.revision,edited.revision);assert.equal(entry.activationDeclared,true);assert.deepEqual(entry.activation,[]);
 const result=discoverTaskSkills(task,rows);
 assert.ok(!result.automatic.some(x=>x.id===builtin.id));assert.equal(result.selection.decisions.find(x=>x.id===builtin.id).decision,'not-applicable');
});

test('generic completion similarity and a specialist subject mismatch do not activate methods',async t=>{
 const {catalog}=await fixture(t);
 const rows=await catalog.taskMetadata();
 assert.ok(!discoverTaskSkills('Keep the core completion contract only.',rows).automatic.some(x=>x.id==='library-verify-a-working-slice'));
 const recover=discoverTaskSkills('Recover website interactions after stale input controls stop responding.',rows);
 assert.ok(recover.automatic.some(x=>x.id==='library-browser-navigation'));
 assert.ok(!recover.automatic.some(x=>x.id==='library-accessibility-spot-check'));
});
