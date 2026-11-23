import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyJobEngagement} from '../lib/jobsearch-engagement.mjs';
import {triageJobSearchCandidates} from '../lib/jobsearch-batch-triage.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';

const url='https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application';
const employerCandidate=(overrides={})=>({
  url,remote:true,allowedStates:['FL'],requiredTravel:false,
  baseSalaryMin:110000,baseSalaryMax:160000,employmentType:'Full-time',
  ...overrides,
});
const history={byKey:new Map(),files:0,parsedRows:0,sources:[],errors:[],manifest:'synthetic',coverageComplete:true};
const triage=(candidate)=>triageJobSearchCandidates(history,[employerCandidate(candidate)]).candidates[0];

test('explicit independent contractor in a full-time salaried-looking posting is non-W2',()=>{
  const p=employerCandidate({employmentType:'Full-time 1099 independent contractor',description:'Remote with advertised annual compensation $120,000'});
  assert.equal(classifyJobEngagement(p).kind,'non_w2');
  const row=triage(p);
  assert.equal(row.disposition,'not_eligible');
  assert(row.reasons.includes('non_W2_engagement'));
});

test('per-task work is a contractor signal even when the summary incorrectly says full-time',()=>{
  const row=triage({employmentType:'Full-time',description:'This role is paid per task. Work assignments are flexible.'});
  assert.equal(row.engagement.kind,'non_w2');
  assert.equal(row.disposition,'not_eligible');
});

test('freelance role label matters, employer name and its market do not',()=>{
  assert.equal(triage({role:'Freelance AI evaluator',employmentType:'Full-time'}).disposition,'not_eligible');
  const staff=triage({
    employer:'Gigwork / Independent Contractor Data Platform',
    role:'Internal Product Operations Manager',
    employmentType:'Regular full-time employee',
    description:'Build software tools for our freelancer and gig-economy customers.'
  });
  assert.equal(staff.engagement.kind,'employee');
  assert.equal(staff.disposition,'candidate');
});

test('W-2 contracts are not misclassified as 1099 and contract-to-hire remains actionable',()=>{
  const w2=triage({employmentType:'Full-time W-2 contract'});
  assert.equal(w2.engagement.kind,'employee');
  assert.equal(w2.disposition,'candidate');
  const unclear=triage({employmentType:'Contract-to-hire full-time'});
  assert.equal(unclear.engagement.kind,'contract_unclear');
  assert.equal(unclear.disposition,'candidate');
  assert(unclear.reasons.includes('payroll_type_not_stated'));
});

test('roles offering W-2 or 1099 stay actionable when a W-2 choice exists',()=>{
  const row=triage({employmentType:'Full-time: W-2 employee or 1099 independent contractor'});
  assert.equal(row.engagement.kind,'w2_option');
  assert.equal(row.disposition,'candidate');
  assert(row.reasons.includes('choose_W2_option'));
});

test('full-time salary alone does not prove W-2, but missing proof cannot block the user objective',()=>{
  const row=triage({employmentType:'Full-time',description:'Remote salaried position, annual range $110,000-$160,000.'});
  assert.equal(row.engagement.kind,'unspecified');
  assert.equal(row.disposition,'candidate');
  assert(row.reasons.includes('employment_arrangement_not_explicit'));
});

test('contractor hiring on the product side does not make an employee staff vacancy freelance',()=>{
  const row=triage({
    employmentType:'Regular salaried employee',
    role:'Full-time Operations Manager',
    description:'Our customers hire independent contractors. You would improve our gig-economy product.'
  });
  assert.equal(row.engagement.kind,'employee');
  assert.equal(row.disposition,'candidate');
});

test('a Freelancer Success Manager is an internal company role unless the vacancy says otherwise',()=>{
  const row=triage({
    title:'Freelancer Success Manager',
    employmentType:'Full-time',
    description:'Help our gig economy marketplace coordinate freelance creators and independent contractors.'
  });
  assert.equal(row.engagement.kind,'unspecified');
  assert.equal(row.disposition,'candidate');
});

test('genuine contractor language in the actual role description defeats a remote full-time badge',()=>{
  const row=triage({employmentType:'Full-time remote',description:'You will be hired as an independent contractor. Payments are made by assignment.'});
  assert.equal(row.engagement.kind,'non_w2');
  assert.equal(row.disposition,'not_eligible');
});

test('role-level 1099 labels are distinguished from platform descriptions',()=>{
  for(const description of [
    'Employment type: Independent contractor. Hours may vary.',
    'This is a 1099 contractor position with remote assignments.',
    'Freelance role available; compensation is per assignment.'
  ]){
    const row=triage({employmentType:'Full-time',description});
    assert.equal(row.engagement.kind,'non_w2',description);
    assert.equal(row.disposition,'not_eligible',description);
  }
});

test('employer ATS leads are ranked ahead of search engines and Indeed without discarding those leads',()=>{
  const inputs=[
    employerCandidate({url:'https://www.indeed.com/viewjob?jk=abc123',fitScore:100}),
    employerCandidate({url:'https://www.google.com/search?q=remote+analyst',fitScore:98}),
    employerCandidate({url:'https://careers.aiapply.co/jobs/program-manager-operations-remote-us',fitScore:70}),
    employerCandidate({url,fitScore:65})
  ];
  const result=triageJobSearchCandidates(history,inputs).candidates;
  assert.deepEqual(result.map(row=>row.position),[2,3,0,1]);
  assert.deepEqual(result.map(row=>row.sourceKind),['employer','employer_ats','third_party_board','search_engine']);
  assert(result.every(row=>row.disposition==='candidate'));
});

test('a search-result URL stays a search lead even if metadata calls it an employer posting',()=>{
  const row=triage({
    url:'https://www.indeed.com/viewjob?jk=mislabelled',
    sourceType:'employer',
    isEmployerListing:true
  });
  assert.equal(row.sourceKind,'third_party_board');
  assert.equal(row.disposition,'candidate');
});

test('an explicit 1099 employer ATS posting ranks below an eligible third-party lead',()=>{
  const official=employerCandidate({url,employmentType:'Full-time independent contractor',fitScore:99});
  const aggregator=employerCandidate({url:'https://www.indeed.com/viewjob?jk=another',fitScore:50});
  const result=triageJobSearchCandidates(history,[official,aggregator]).candidates;
  assert.deepEqual(result.map(row=>row.position),[1,0]);
  assert.equal(result[0].disposition,'candidate');
  assert.equal(result[1].disposition,'not_eligible');
});

test('bundled job-search guidance uses employer-first discovery and autonomy without a new W2 verification gate',async()=>{
  const catalog=createSkillsCatalog();
  try {
    const skill=await catalog.detail({id:'library-job-search'});
    assert.equal(skill.source,'bundled');
    assert.match(skill.content,/Start with actual vacancies on relevant employers' careers pages/i);
    assert.match(skill.content,/general search engines, Indeed and aggregate job boards as supplementary discovery routes/i);
    assert.match(skill.content,/W-2 contract or a posting that offers a W-2 option/i);
    assert.match(skill.content,/do not require a separate proof exercise/i);
    assert.match(skill.content,/A salaried full-time staff job at an AI-data or gig-platform company is not automatically gig work/i);
  } finally {await catalog.close();}
});
