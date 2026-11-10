import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { applicationTarget, applicationSubmissionKind, applicationDescriptorTarget, inspectApplicationHistory, createApplicationHistoryGate } from '../lib/application-history.mjs';

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
    write: (name, text) => writeFile(path.join(cwd, name), text),
    gate: (taskId = 'task-one', selected = store) => createApplicationHistoryGate({ store: selected, cwd, taskId }) };
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

test('older dated ledger blocks even when the newest ledger is empty', async t => {
  const f = await fixture(t);
  await f.write('job_search_2025-01-01.jsonl', JSON.stringify({ url, status: 'submitted_confirmed' }) + '\n');
  await f.write('job_search_2026-11-10.jsonl', '');
  const history = await inspectApplicationHistory(f.cwd, target());
  assert.equal(history.errors.length, 0);
  assert.equal(history.sources.length, 2);
  assert.equal(history.matches[0].source, 'job_search_2025-01-01.jsonl');
  await rejectsCode(f.gate().check({ descriptor: descriptor(), operationId: 'old-ledger', reserve: true }), 'APPLICATION_HISTORY_PRIOR');
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

test('Markdown company/title narrative with no URL requires review', async t => {
  const f = await fixture(t);
  const fifteen = 'https://jobs.ashbyhq.com/OtherCo/' + first;
  await f.write('job_search_2025-01-02.md', '- Submitted the Senior Product Manager application to OtherCo.\n');
  await rejectsCode(f.gate().check({ descriptor: descriptor(fifteen, 'Senior Product Manager | OtherCo'), operationId: 'narrative' }),
    'APPLICATION_HISTORY_PRIOR');
  const history = await inspectApplicationHistory(f.cwd, target(fifteen, 'Senior Product Manager | OtherCo'));
  assert.equal(history.matches[0].reason, 'narrative-company-role');
});

test('structured company/title records without URLs require review', async t => {
  const f = await fixture(t);
  await f.write('applications.json', JSON.stringify({ rows: [{ company: 'ExampleCo', title: 'Senior Product Manager', status: 'submitted_confirmed' }] }));
  assert.equal((await inspectApplicationHistory(f.cwd, target())).matches[0].reason, 'reported-company-role');
});

test('different explicit requisition at the same company is not a fuzzy duplicate', async t => {
  const f = await fixture(t);
  await f.write('applications.jsonl', JSON.stringify({ company: 'ExampleCo', title: 'Senior Product Manager', url: other, status: 'submitted' }));
  const result = await f.gate().check({ descriptor: descriptor(), operationId: 'different-id', reserve: true });
  assert.equal(result.covered, true);
});

test('ordinary CSV quoting and embedded comma are parsed', async t => {
  const f = await fixture(t);
  await f.write('applications.csv', 'company,title,url,status,evidence\r\nExampleCo,"Senior Product Manager, Platform",' +
    url + ',submitted,"Application received, thank you"\r\n');
  const history = await inspectApplicationHistory(f.cwd, target());
  assert.deepEqual(history.errors, []);
  assert.equal(history.matches[0].reason, 'reported-prior-requisition');
});

test('negative and draft history does not invent a submission', async t => {
  const f = await fixture(t);
  await f.write('applications.jsonl', [
    { url, status: 'not_submitted' }, { url, status: 'draft', evidence: 'No application was submitted' },
  ].map(JSON.stringify).join('\n'));
  await f.write('job_search_notes.md', 'ExampleCo Senior Product Manager was not yet submitted.\n');
  assert.equal((await f.gate().check({ descriptor: descriptor() })).covered, true);
});

test('malformed JSON, CSV and invalid UTF-8 fail closed', async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [['applications.json', '{"broken":'], ['application_log.csv', 'url,status\n"unfinished'],
    ['job_search_notes.txt', Buffer.from([0xc3, 0x28])]]) {
    await f.write(name, bytes);
    await rejectsCode(f.gate().check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_INCOMPLETE');
    await rm(path.join(f.cwd, name));
  }
});

test('oversized supported source fails closed rather than silently truncating', async t => {
  const f = await fixture(t);
  await f.write('applications.txt', '');
  await truncate(path.join(f.cwd, 'applications.txt'), 16 * 1024 * 1024 + 1);
  await rejectsCode(f.gate().check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_INCOMPLETE');
});

test('symlinked source is rejected where file symlink creation is available', async t => {
  const f = await fixture(t), external = path.join(f.cwd, 'source.txt');
  await writeFile(external, 'Nothing here.');
  try { await symlink(external, path.join(f.cwd, 'applications.txt'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Host does not permit fixture file symlinks.'); return; } throw error; }
  await rejectsCode(f.gate().check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_INCOMPLETE');
});

test('separate TaskStateStore instances reserve a requisition only once', async t => {
  const f = await fixture(t), secondStore = await f.makeStore();
  const results = await Promise.allSettled([
    f.gate('task-one').check({ descriptor: descriptor(), operationId: 'race-one', reserve: true }),
    f.gate('task-two', secondStore).check({ descriptor: descriptor(), operationId: 'race-two', reserve: true }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'APPLICATION_HISTORY_RESERVED');
});

test('UNKNOWN survives a new store instance and fences retries', async t => {
  const f = await fixture(t);
  await f.gate().check({ descriptor: descriptor(), operationId: 'lost-outcome', reserve: true });
  await f.store.close();
  const reopened = await f.makeStore();
  await rejectsCode(f.gate('task-two', reopened).check({ descriptor: descriptor(), operationId: 'retry', reserve: true }), 'APPLICATION_HISTORY_RESERVED');
});

test('only exact operation/effect and evidence-backed host outcomes reconcile UNKNOWN', async t => {
  const f = await fixture(t), gate = f.gate();
  await gate.check({ descriptor: descriptor(), operationId: 'exact-operation', reserve: true });
  const base = { operationId: 'exact-operation', commit: { effectKey: 'effect-one', pageUrl: url }, effectState: 'absent', reconciliationEvidenceIds: ['host-proof'] };
  for (const record of [{ ...base, operationId: 'wrong-operation' }, { ...base, commit: { effectKey: 'wrong-effect', pageUrl: url } },
    { ...base, reconciliationEvidenceIds: [] }, { ...base, effectState: 'unknown' }]) {
    await gate.reconcile([record]);
    await rejectsCode(gate.check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_RESERVED');
  }
  await f.gate('different-task').reconcile([base]);
  await rejectsCode(gate.check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_RESERVED');
  await gate.reconcile([base]);
  assert.equal((await gate.check({ descriptor: descriptor(), operationId: 'retry-after-absence', reserve: true })).covered, true);
});

test('confirmed host outcome stays fenced and cancelled-before-dispatch can release', async t => {
  const f = await fixture(t), gate = f.gate();
  await gate.check({ descriptor: descriptor(), operationId: 'confirmed-operation', reserve: true });
  await gate.reconcile([{ operationId: 'confirmed-operation', commit: { effectKey: 'effect-one', pageUrl: url },
    effectState: 'confirmed', reconciliationEvidenceIds: ['host-confirmation'] }]);
  await rejectsCode(gate.check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_RESERVED');
  await gate.check({ descriptor: descriptor(other), operationId: 'cancelled-operation', reserve: true });
  await gate.reconcile([{ operationId: 'cancelled-operation', commit: { effectKey: 'effect-one', pageUrl: url }, deliveryState: 'cancelled-before-dispatch' }]);
  assert.equal((await gate.check({ descriptor: descriptor(other), operationId: 'new-operation', reserve: true })).covered, true);
});

test('ordinary reads and unknown URLs pass; opaque recognized input fails closed', async t => {
  const f = await fixture(t), gate = f.gate();
  await f.write('applications.json', 'not JSON');
  assert.equal(await gate.check({ descriptor: descriptor(url, '', 'observe') }), null);
  assert.equal(await gate.check({ descriptor: descriptor('https://example.com/general-form') }), null);
  await rejectsCode(gate.check({ descriptor: descriptor(url, '', 'opaque') }), 'APPLICATION_HISTORY_UNINSPECTED');
});

test('existing helper claims block without importing them as confirmation', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, '.application-registry'));
  await f.write('.application-registry/claims.json', JSON.stringify({ original: { url, status: 'uncertain' } }));
  await rejectsCode(f.gate().check({ descriptor: descriptor() }), 'APPLICATION_HISTORY_PRIOR');
});

test('natural em-dash page titles retain company/role narrative review', async t => {
  const f = await fixture(t);
  await f.write('job_search_notes.md', 'Submitted Senior Product Manager at ExampleCo.\n');
  assert.equal((await inspectApplicationHistory(f.cwd, target(url, 'Senior Product Manager — ExampleCo'))).matches.length, 1);
});

async function childReservation(f, taskId, { abrupt = false } = {}) {
  const moduleUrl = new URL('../lib/application-history.mjs', import.meta.url).href;
  const storeUrl = new URL('../lib/task-state.mjs', import.meta.url).href;
  const source = `
    import { TaskStateStore } from ${JSON.stringify(storeUrl)};
    import { createApplicationHistoryGate } from ${JSON.stringify(moduleUrl)};
    const store = await new TaskStateStore({dataDir: ${JSON.stringify(f.dataDir)}}).init();
    const gate = createApplicationHistoryGate({store, cwd: ${JSON.stringify(f.cwd)}, taskId: ${JSON.stringify(taskId)}});
    try {
      await gate.check({descriptor: ${JSON.stringify(descriptor())}, operationId: ${JSON.stringify(taskId + '-operation')}, reserve:true});
      process.stdout.write('RESERVED\\n', () => { ${abrupt ? "process.exit(79);" : "store.close().then(() => process.exit(0));"} });
    } catch(error) {
      process.stdout.write(String(error.code) + '\\n', () => { store.close().then(() => process.exit(0)); });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => { if (stderr || ![0, 79].includes(code)) reject(new Error('Child failed: ' + code + ' ' + stderr)); else resolve({code, stdout:stdout.trim()}); });
  });
}

test('separate OS processes racing on the same data directory reserve once', async t => {
  const f = await fixture(t);
  const results = await Promise.all([childReservation(f, 'process-one'), childReservation(f, 'process-two')]);
  assert.deepEqual(results.map(row => row.stdout).sort(), ['APPLICATION_HISTORY_RESERVED', 'RESERVED']);
  await rejectsCode(f.gate('parent').check({descriptor:descriptor(), operationId:'parent-retry', reserve:true}), 'APPLICATION_HISTORY_RESERVED');
});

test('abrupt child exit after durable reservation keeps UNKNOWN after process restart', async t => {
  const f = await fixture(t);
  const firstChild = await childReservation(f, 'crashed-process', {abrupt:true});
  assert.deepEqual(firstChild, {code:79, stdout:'RESERVED'});
  const secondChild = await childReservation(f, 'restart-process');
  assert.deepEqual(secondChild, {code:0, stdout:'APPLICATION_HISTORY_RESERVED'});
});

test('ordinary capitalized CSV headers preserve exact prior submissions', async t => {
  const f = await fixture(t);
  await f.write('applications.csv', 'Company,Title,URL,Status\nExampleCo,Senior Product Manager,' + url + ',submitted\n');
  await rejectsCode(f.gate().check({descriptor:descriptor()}), 'APPLICATION_HISTORY_PRIOR');
});
test('Markdown machine-style outcome labels preserve prior submissions', async t => {
  const f = await fixture(t);
  await f.write('applications.md', '| ExampleCo | Senior Product Manager | ' + url + ' | submitted_confirmed |\n');
  await rejectsCode(f.gate().check({descriptor:descriptor()}), 'APPLICATION_HISTORY_PRIOR');
});

test('valid UTF16 BOM ledger preserves exact prior submission', async t => {
  const f = await fixture(t);
  const raw = JSON.stringify({url, status:'submitted'});
  await f.write('applications.json', Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(raw, 'utf16le')]));
  await rejectsCode(f.gate().check({descriptor:descriptor()}), 'APPLICATION_HISTORY_PRIOR');
});
test('host submit labels distinguish final applications from intermediate forms', () => {
  for (const label of ['Submit Application', 'Send application', 'Apply now'])
    assert.equal(applicationSubmissionKind(label), 'final', label);
  for (const label of ['Next', 'Continue', 'Save draft', 'Log in'])
    assert.equal(applicationSubmissionKind(label), 'intermediate', label);
  for (const label of [undefined, '', 'Submit'])
    assert.equal(applicationSubmissionKind(label), 'unknown', String(label));
});

test('intermediate POST controls do not create application claims or block a later final check', async t => {
  const f = await fixture(t), gate = f.gate();
  const intermediate = descriptor(); intermediate.applicationPage.submission = 'intermediate';
  assert.equal(await gate.check({ descriptor: intermediate, operationId: 'next-page', reserve: true }), null);
  const unknown = descriptor(); unknown.applicationPage.submission = 'unknown';
  await rejectsCode(gate.check({ descriptor: unknown, operationId: 'ambiguous', reserve: true }), 'APPLICATION_HISTORY_SUBMISSION_UNCLASSIFIED');
  assert.equal((await gate.check({ descriptor: descriptor(), operationId: 'real-final', reserve: true })).covered, true);
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
