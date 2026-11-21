import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { applicationTarget, applicationSubmissionKind, applicationDescriptorTarget, inspectApplicationHistory } from '../lib/application-history.mjs';
import * as historyModule from '../lib/application-history.mjs';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const url = 'https://jobs.ashbyhq.com/ExampleCo/' + first;
const other = 'https://jobs.ashbyhq.com/ExampleCo/' + second;
const descriptor = (value = url, title = 'Senior Product Manager | ExampleCo', effect = 'commit') => ({
  effect, applicationPage: { url: value, title, submission: 'final' },
  commit: { destinationKey: 'destination:' + value + '/application', effectKey: 'effect-one', pageUrl: value },
});
const target = (value = url, title = 'Senior Product Manager | ExampleCo') => ({ ...applicationTarget(value), title });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-application-history-test-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await mkdir(cwd);
  const stores = [];
  const makeStore = async () => {
    const store = await new TaskStateStore({ dataDir }).init();
    stores.push(store); return store;
  };
  const store = await makeStore();
  t.after(async () => { for (const item of stores) await item.close(); await rm(directory, { recursive: true, force: true }); });
  return { cwd, dataDir, store, makeStore,
    write: (name, text) => writeFile(path.join(cwd, name), text) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code); assert.equal(error.actionDispatched, false); return true;
});

test('recognized requisition identity preserves distinct IDs and normalizes Greenhouse hosts', () => {
  assert.equal(applicationTarget(url + '/application?utm_source=x').key, applicationTarget(url).key);
  assert.notEqual(applicationTarget(url).key, applicationTarget(other).key);
  assert.equal(applicationTarget('https://boards.greenhouse.io/acme/jobs/123').key,
    applicationTarget('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x').key);
  assert.equal(applicationTarget('https://example.com/jobs/123'), null);
  assert.equal(applicationTarget('https://user:secret@jobs.ashbyhq.com/ExampleCo/' + first), null);
  assert.equal(applicationDescriptorTarget({ ...descriptor(), effect: 'observe' }), null);
  assert.throws(() => applicationDescriptorTarget({ ...descriptor(), commit: { destinationKey: 'destination:' + other } }),
    { code: 'APPLICATION_HISTORY_TARGET_AMBIGUOUS' });
});

test('escaped CRLF JSONL records remain searchable across dates', async t => {
  const f = await fixture(t);
  await f.write('application_log.jsonl', JSON.stringify({ url: other, status: 'submitted' }) + String.raw`\r\n` +
    JSON.stringify({ url, status: 'applied', evidence: 'Receipt says application received.' }));
  const history = await inspectApplicationHistory(f.cwd, target());
  assert.deepEqual(history.errors, []);
  assert.equal(history.matches.length, 1);
  assert.equal(history.matches[0].record, 2);
});

test('structured company/title records without URLs require review', async t => {
  const f = await fixture(t);
  await f.write('applications.json', JSON.stringify({ rows: [{ company: 'ExampleCo', title: 'Senior Product Manager', status: 'submitted_confirmed' }] }));
  assert.equal((await inspectApplicationHistory(f.cwd, target())).matches[0].reason, 'reported-company-role');
});

test('ordinary CSV quoting and embedded comma are parsed', async t => {
  const f = await fixture(t);
  await f.write('applications.csv', 'company,title,url,status,evidence\r\nExampleCo,"Senior Product Manager, Platform",' +
    url + ',submitted,"Application received, thank you"\r\n');
  const history = await inspectApplicationHistory(f.cwd, target());
  assert.deepEqual(history.errors, []);
  assert.equal(history.matches[0].reason, 'reported-prior-requisition');
});

test('host submit labels distinguish final applications from intermediate forms', () => {
  for (const label of ['Submit Application', 'Send application', 'Apply now'])
    assert.equal(applicationSubmissionKind(label), 'final', label);
  for (const label of ['Next', 'Continue', 'Save draft', 'Log in'])
    assert.equal(applicationSubmissionKind(label), 'intermediate', label);
  for (const label of [undefined, '', 'Submit'])
    assert.equal(applicationSubmissionKind(label), 'unknown', String(label));
});

test('nested audit records retain their explicit parent requisition identity', async t => {
  const f = await fixture(t);
  await f.write('application_audit.json', JSON.stringify({duplicateKeys:[{key:applicationTarget(other).key,
    records:[{employer:'ExampleCo',role:'Senior Product Manager',status:'submitted_confirmed'}]}]}));
  assert.equal((await inspectApplicationHistory(f.cwd,target())).matches.length,0);
  assert.equal((await inspectApplicationHistory(f.cwd,target(other))).matches[0].reason,'reported-prior-requisition');
});
test('Greenhouse embedded job application query preserves exact identity', () => {
  assert.equal(applicationTarget('https://boards.greenhouse.io/embed/job_app?for=exampleco&token=123&source=other').key,
    applicationTarget('https://job-boards.greenhouse.io/exampleco/jobs/123').key);
});

const customPage='https://careers.fixture.invalid/careers';
const customContext={kind:'application-page-context',precision:'origin-and-path-context-only',url:customPage,origin:'https://careers.fixture.invalid'};
const applicationObservation=(label='Submit application',url=customPage)=>({
 url,title:'Careers | ExampleCo',frames:[{forms:[{action:url,method:'post'}],elements:[{tag:'button',type:'submit',role:'button',name:label}]}]
});

test('custom application context requires an observed application submit and sanitizes page identity',()=>{
 const lookup=historyModule.applicationHistoryTarget;
 assert.equal(typeof lookup,'function','observed custom application context has a separate target helper');
 const observed=applicationObservation('Submit application',customPage+'?access_token=private-query#private-fragment');
 assert.deepEqual(lookup(observed),customContext);
 assert.equal(applicationTarget(customPage),null,'custom page paths do not become ATS requisitions');
 assert.deepEqual(lookup({url}),applicationTarget(url),'existing ATS identities stay unchanged');
 for(const label of ['Send message','Sign in','Apply','Apply now','Submit']){
  assert.equal(lookup(applicationObservation(label)),null,label+' alone is not an application form');
 }
 assert.equal(lookup({...observed,frames:[{forms:[],elements:observed.frames[0].elements}]}),null);
 assert.equal(lookup({...observed,frames:[{forms:[{}],elements:[{tag:'button',type:'button',name:'Submit application'}]}]}),null);
 assert.equal(lookup(applicationObservation('Submit application','https://user:secret@careers.fixture.invalid/careers')),null);
});

test('custom application history reports distinct roles as related context rather than exact matches',async t=>{
 const f=await fixture(t);
 const rows=[
  {url:customPage+'?token=private-query#private-fragment',employer:'ExampleCo',role:'Research Analyst',status:'submitted_confirmed'},
  {url:customPage,employer:'ExampleCo',role:'Training Specialist',status:'submitted_confirmed'},
  {url:'https://careers.fixture.invalid/jobs/another',employer:'Different Recorded Employer',role:'Other Role',status:'uncertain'},
  {url:'https://elsewhere.invalid/careers',employer:'ExampleCo',role:'Research Analyst',status:'submitted_confirmed'},
  {url:customPage,employer:'ExampleCo',role:'Draft Role',status:'draft'},
  {job_url:customPage,records:[{employer:'ExampleCo',role:'Nested Role',status:'uncertain'}]},
  {url:'https://user:private-credential@careers.fixture.invalid/careers',role:'Credential URL Role',status:'submitted_confirmed'}
 ];
 await f.write('applications_custom.json',JSON.stringify(rows));
 const result=await inspectApplicationHistory(f.cwd,customContext);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.matches,[],'related employer-site history is never an exact requisition match');
 assert.ok(Array.isArray(result.related),'custom context is returned separately from exact matches');
 assert.deepEqual(result.related.map(row=>row.reported.role),['Research Analyst','Training Specialist','Nested Role','Other Role']);
 assert.deepEqual(result.related.map(row=>row.relationship),['same-observed-origin-and-path','same-observed-origin-and-path','same-observed-origin-and-path','same-observed-origin']);
 assert.equal(result.related[3].reported.employer,'Different Recorded Employer','shared origins do not rewrite recorded employer identity');
 assert.ok(result.related.every(row=>row.source==='applications_custom.json'&&Number.isInteger(row.record)));
 assert.equal(result.relatedTruncated,false);
 assert.doesNotMatch(JSON.stringify(result),/private-query|private-fragment|private-credential/);
 assert.equal(Object.hasOwn(result,'eligible'),false);
 assert.equal(Object.hasOwn(result,'nativeConfirmation'),false);
});

test('custom application history keeps legacy claims and errors contextual without missing-key matches',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.cwd,'.application-registry'));
 await f.write('.application-registry/claims.json',JSON.stringify({
  unrelated:{url:'https://elsewhere.invalid/careers',status:'claimed'},
  current:{url:customPage+'?token=private-query',status:'claimed',role:'Research Analyst'},
  another:{url:'https://careers.fixture.invalid/jobs/another',status:'uncertain',role:'Training Specialist'}
 }));
 await f.write('applications_broken.json','{bad');
 const result=await inspectApplicationHistory(f.cwd,customContext);
 assert.deepEqual(result.errors,['applications_broken.json']);
 assert.deepEqual(result.matches,[]);
 assert.ok(Array.isArray(result.related));
 assert.equal(result.related.length,2,'unrelated claims with no ATS key must not match an absent custom key');
 assert.deepEqual(result.related.map(row=>row.reported.status),['claimed','uncertain']);
 assert.ok(result.related.every(row=>row.source==='.application-registry/claims.json'&&row.reason==='existing-claim-or-outcome'));
 const missing=await inspectApplicationHistory(path.join(f.cwd,'missing'),customContext);
 assert.deepEqual(missing.errors,['workspace-unreadable']);
 assert.deepEqual(missing.related,[]);
 assert.equal(missing.relatedTruncated,false);
});

test('custom application history bounds related output and prioritizes the observed page path',async t=>{
 const f=await fixture(t);
 const rows=Array.from({length:43},(_,index)=>({url:'https://careers.fixture.invalid/jobs/'+index,role:'Other '+index,status:'submitted'}));
 rows.push({url:customPage,role:'R'.repeat(300),status:'submitted_confirmed'});
 await f.write('applications_many.json',JSON.stringify(rows));
 const result=await inspectApplicationHistory(f.cwd,customContext);
 assert.ok(Array.isArray(result.related));
 assert.equal(result.related.length,40);
 assert.equal(result.relatedTruncated,true);
 assert.equal(result.related[0].relationship,'same-observed-origin-and-path');
 assert.equal(result.related[0].reported.role.length,256);
 assert.deepEqual(result.related[0].reportedFieldsTruncated,['role']);
 assert.deepEqual(result.matches,[]);
});
