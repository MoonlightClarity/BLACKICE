import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { applicationTarget, applicationSubmissionKind, applicationDescriptorTarget, inspectApplicationHistory } from '../lib/application-history.mjs';

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
