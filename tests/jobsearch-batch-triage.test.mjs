import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
import {loadJobSearchHistory,triageJobSearchCandidates} from '../lib/jobsearch-batch-triage.mjs';

const old='11111111-1111-4111-8111-111111111111';
const uncertain='22222222-2222-4222-8222-222222222222';
const newReq='33333333-3333-4333-8333-333333333333';
const oldUrl='https://jobs.ashbyhq.com/far.ai/'+old+'/application';
const uncertainUrl='https://jobs.ashbyhq.com/far.ai/'+uncertain+'/application';
const newUrl='https://jobs.ashbyhq.com/far.ai/'+newReq+'/application';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-jobsearch-triage-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const source={records:[
  {url:oldUrl,employer:'FAR.AI',role:'Prior role',status:'confirmed_submitted',record:{confirmationText:'Your application was successfully submitted.'}},
  {url:uncertainUrl,employer:'FAR.AI',role:'Previous different role',status:'uncertain',record:{evidence:'Browser timeout; effect unknown'}},
  {url:'https://jobs.ashbyhq.com/different/'+old+'/application',status:'confirmed'}
 ]};
 await writeFile(path.join(dir,'BLACKICE_job_applications_test.json'),JSON.stringify(source));
 await writeFile(path.join(dir,'FARAI-'+old+'.json'),JSON.stringify({applicationUrl:oldUrl,status:'confirmed',role:'Prior role'}));
 return dir;
}
const base=url=>({url,remote:true,employmentType:'Full time W-2',allowedStates:['FL','NY'],requiredTravel:false,baseSalaryMin:100000,baseSalaryMax:150000});

test('one source pass distinguishes exact confirmed, uncertain, and distinct new Ashby requisitions',async t=>{
 const dir=await fixture(t),index=await loadJobSearchHistory(dir);
 assert.equal(index.coverageComplete,true);
 const result=triageJobSearchCandidates(index,[base(oldUrl),base(uncertainUrl),base(newUrl)]);
 const byPosition=Object.fromEntries(result.candidates.map(row=>[row.position,row]));
 assert.equal(byPosition[0].disposition,'do_not_reapply');
 assert.equal(byPosition[1].disposition,'hold_reconcile');
 assert.equal(byPosition[2].disposition,'candidate');
 assert.equal(byPosition[0].prior.some(row=>row.source.includes('BLACKICE_job')),true);
 assert.equal(byPosition[1].prior.some(row=>row.state==='unknown'),true);
 assert.equal(byPosition[2].prior.length,0);
});

test('skill preferences are not mandatory gates; explicit US remote salary and work eligibility win',async t=>{
 const dir=await fixture(t),index=await loadJobSearchHistory(dir);
 const [r]=triageJobSearchCandidates(index,[{...base(newUrl),skillGaps:['8 years of research leadership','Python experience'],fitScore:70}]).candidates;
 assert.equal(r.disposition,'candidate');
 assert.equal(r.softGaps.length,2);
});

test('explicit no-W2, office, Florida ban, mandatory travel, and salary below floor are real hard gates',async t=>{
 const dir=await fixture(t),index=await loadJobSearchHistory(dir);
 const rows=[
  {...base(newUrl),employmentType:'freelance'},
  {...base(newUrl),remote:false},
  {...base(newUrl),allowedStates:['CA','NY']},
  {...base(newUrl),requiredTravel:true},
  {...base(newUrl),baseSalaryMin:45000,baseSalaryMax:75000}
 ];
 const results=triageJobSearchCandidates(index,rows).candidates;
 assert(results.every(row=>row.disposition==='not_eligible'));
 assert(results.some(row=>row.reasons.includes('florida_excluded')));
});

test('salary band crossing minimum is verification, not a false definitive reject',async t=>{
 const dir=await fixture(t),index=await loadJobSearchHistory(dir);
 const [r]=triageJobSearchCandidates(index,[{...base(newUrl),baseSalaryMin:76000,baseSalaryMax:112000}]).candidates;
 assert.equal(r.disposition,'verify_constraints');
 assert(r.reasons.includes('base_band_crosses_floor'));
});

test('history errors prevent confident new-app clearance while retaining known uncertain effects',async t=>{
 const dir=await fixture(t);await writeFile(path.join(dir,'broken-application.json'),'bad');
 const index=await loadJobSearchHistory(dir);assert.equal(index.coverageComplete,false);
 const rows=triageJobSearchCandidates(index,[base(newUrl),base(uncertainUrl)]).candidates;
 assert.equal(rows.find(x=>x.position===0).disposition,'review_history_coverage');
 assert.equal(rows.find(x=>x.position===1).disposition,'hold_reconcile');
});

test('source changes are read afresh and do not bless stale absence after a new confirmed receipt',async t=>{
 const dir=await fixture(t),first=await loadJobSearchHistory(dir);
 assert.equal(triageJobSearchCandidates(first,[base(newUrl)]).candidates[0].disposition,'candidate');
 await writeFile(path.join(dir,'new-application.json'),JSON.stringify({url:newUrl,status:'submitted_confirmed'}));
 const second=await loadJobSearchHistory(dir);
 assert.notEqual(first.manifest,second.manifest);
 assert.equal(triageJobSearchCandidates(second,[base(newUrl)]).candidates[0].disposition,'do_not_reapply');
});


test('actual employer ATS application-count refusal stays held instead of inviting repeat work',async t=>{
 const dir=await fixture(t);
 const headway='44444444-4444-4444-8444-444444444444';
 const url='https://jobs.ashbyhq.com/headway/'+headway+'/application';
 await writeFile(path.join(dir,'Headway-limited.json'),JSON.stringify({
   applicationUrl:url,status:'not_submitted',
   confirmation:'We could not submit your application. We limit applicants to 2 applications across all roles per 60 days.'
 }));
 const idx=await loadJobSearchHistory(dir);
 const [row]=triageJobSearchCandidates(idx,[base(url)]).candidates;
 assert.equal(row.disposition,'hold_site_limit');
 assert(row.reasons.includes('previous_site_application_limit'));
});

test('an unsubmitted draft without an application-count block is reviewable, not falsely confirmed',async t=>{
 const dir=await fixture(t);
 await writeFile(path.join(dir,'draft.json'),JSON.stringify({applicationUrl:newUrl,status:'not_submitted'}));
 const idx=await loadJobSearchHistory(dir);
 const [row]=triageJobSearchCandidates(idx,[base(newUrl)]).candidates;
 assert.equal(row.disposition,'review_prior_history');
 assert(row.prior.some(p=>p.state==='not_sent'));
});


test('CLI inline JSON avoids any candidate-file write and keeps exact history protections',async t=>{
 const dir=await fixture(t);
 const script=new URL('../scripts/jobsearch-batch-triage.mjs',import.meta.url);
 const text=JSON.stringify([base(oldUrl),base(uncertainUrl),base(newUrl)]);
 const {stdout}=await exec(process.execPath,[fileURLToPath(script),'--history',dir,'--json',text]);
 const result=JSON.parse(stdout);
 assert.equal(result.candidates.length,3);
 assert.equal(result.candidates.find(row=>row.position===0).disposition,'do_not_reapply');
 assert.equal(result.candidates.find(row=>row.position===1).disposition,'hold_reconcile');
 assert.equal(result.candidates.find(row=>row.position===2).disposition,'candidate');
});

test('unknown source and source filename alone never prove a confirmed external submission',async t=>{
 const dir=await fixture(t);
 await writeFile(path.join(dir,'FARAI-'+newReq+'.json'),JSON.stringify({notes:'Mentioned role but no dispatch.'}));
 const idx=await loadJobSearchHistory(dir);
 const [r]=triageJobSearchCandidates(idx,[base(newUrl)]).candidates;
 assert.equal(r.disposition,'candidate');
 assert.equal(r.prior.length,0);
});
