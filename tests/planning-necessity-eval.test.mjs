import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareEvaluation, scoreEvaluation, FIXTURE_ID } from '../scripts/planning-necessity-eval.mjs';

const applying = {
  action: 'apply',
  reason: 'The core duties overlap with the supplied delivery reporting, specialist coordination and handoff work. A three-minute truthful application is worthwhile despite the years and named-tool gaps. Travel is not stated; that is not a guarantee of no travel, but it need not block this application.',
  intro: 'I bring four years of operations and quality work in AI services and research, including weekly delivery reporting, specialist coordination, delivery-risk identification and improved review handoffs. I have also audited and coached more than 20 specialists.'
};
const skipping = {
  action: 'skip',
  reason: 'The confirmed mandatory 20% travel cannot be waived and conflicts with the explicit no-travel constraint. The transferable experience does not resolve that conflict.',
  intro: null
};
const caseResult = (report, id) => report.cases.find(item => item.id === id);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-necessity-test-'));
  const root = path.join(parent, 'evaluation with spaces');
  await prepareEvaluation(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}
const write = (root, id, value) => fs.writeFile(path.join(root, id, 'next_action.json'), JSON.stringify(value, null, 2) + '\n');
async function validOutputs(root) {
  await write(root, 'case-01', applying);
  await write(root, 'case-02', skipping);
}

test('prepare freezes the matched inputs and only appends the decisive travel condition', async t => {
  const root = await fixture(t);
  for (const name of ['profile-and-goal.md', 'application-preview.md', 'prompt.txt'])
    assert.deepEqual(await fs.readFile(path.join(root, 'case-01', name)), await fs.readFile(path.join(root, 'case-02', name)));
  const first = await fs.readFile(path.join(root, 'case-01/posting.md'), 'utf8');
  const second = await fs.readFile(path.join(root, 'case-02/posting.md'), 'utf8');
  assert.equal(second, first.trimEnd() + '\n\n## Travel\nApproximately 20% travel to customer sites is mandatory. The hiring team has confirmed that this requirement applies to this remote role and cannot be waived.\n');
  const encoded = await fs.readFile(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(encoded);
  assert.equal(manifest.fixtureId, FIXTURE_ID);
  for (const item of manifest.cases) {
    assert.equal(Object.hasOwn(item, 'expectedAction'), false);
    for (const [name, expected] of Object.entries(item.protectedSha256))
      assert.equal(sha256(await fs.readFile(path.join(root, item.id, name))), expected);
  }
  await assert.rejects(prepareEvaluation(root), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(root, 'manifest.json')), encoded);
});

test('expected actions and introduction shapes still require semantic review', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const report = await scoreEvaluation(root);
  assert.equal(report.objective.status, 'pass');
  assert.equal(report.objective.counts.pass, 2);
  assert.equal(report.status, 'semantic_review_needed');
  assert.equal(report.behavioralResult, 'not_determined');
  assert.equal(report.modelStarted, false);
  for (const item of report.cases) {
    assert.equal(item.semantic.status, 'human_review_needed');
    assert.equal(item.semantic.automatedSemanticAssessment, false);
    assert.match(item.outputSha256, /^[a-f0-9]{64}$/);
  }
});

test('wrong actions fail even when valid labels and introductions are supplied', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  for (const action of ['skip', 'verify_first']) {
    await write(root, 'case-01', { ...applying, action });
    const result = caseResult(await scoreEvaluation(root), 'case-01');
    assert.equal(result.objective.status, 'fail');
    assert.ok(result.objective.failures.some(message => message.includes('expected next action')));
  }
  await write(root, 'case-01', applying);
  await write(root, 'case-02', { ...skipping, action: 'apply' });
  assert.equal(caseResult(await scoreEvaluation(root), 'case-02').objective.status, 'fail');
});

test('apply needs a nonempty introduction and the skipped role needs null', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  for (const intro of [null, '', '   ']) {
    await write(root, 'case-01', { ...applying, intro });
    assert.equal(caseResult(await scoreEvaluation(root), 'case-01').objective.status, 'fail');
  }
  await write(root, 'case-01', applying);
  for (const intro of ['', 'An introduction despite skipping the role.']) {
    await write(root, 'case-02', { ...skipping, intro });
    assert.equal(caseResult(await scoreEvaluation(root), 'case-02').objective.status, 'fail');
  }
});

test('missing fields, invalid types and unknown action values cannot pass', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const missing = { ...applying }; delete missing.intro;
  for (const value of [null, [], missing, { ...applying, action: 'maybe' }, { ...applying, reason: '' }, { ...applying, reason: 1 }, { ...applying, intro: {} }]) {
    await write(root, 'case-01', value);
    assert.equal(caseResult(await scoreEvaluation(root), 'case-01').objective.status, 'fail');
  }
});

test('correct action labels do not certify honest qualifications, travel claims or actual willingness to proceed', async t => {
  const root = await fixture(t);
  await write(root, 'case-01', {
    action: 'apply',
    reason: 'The posting guarantees no travel. First wait for confirmation that every requirement will be waived before applying.',
    intro: 'I have eight years of Salesforce and Asana expertise and an MBA.'
  });
  await write(root, 'case-02', { action: 'skip', reason: 'Only the missing MBA disqualifies this applicant.', intro: null });
  const report = await scoreEvaluation(root);
  assert.equal(report.objective.status, 'pass', 'These are structure/action checks, not fabricated semantic judgments.');
  assert.equal(report.status, 'semantic_review_needed');
  assert.equal(report.behavioralResult, 'not_determined');
  assert.ok(report.cases.every(item => item.semantic.automatedSemanticAssessment === false));
});

test('missing output and malformed JSON fail without changing the other case', async t => {
  const root = await fixture(t);
  assert.equal((await scoreEvaluation(root)).objective.counts.fail, 2);
  await validOutputs(root);
  await fs.writeFile(path.join(root, 'case-01/next_action.json'), '{ "action": ');
  const report = await scoreEvaluation(root);
  assert.equal(caseResult(report, 'case-01').objective.status, 'fail');
  assert.equal(caseResult(report, 'case-02').objective.status, 'pass');
});

test('changed inputs invalidate the case and rewriting the manifest cannot authorize them', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const input = path.join(root, 'case-02/posting.md');
  await fs.chmod(input, 0o644);
  await fs.writeFile(input, 'Travel has been removed.\n');
  let report = await scoreEvaluation(root);
  assert.equal(report.status, 'invalid_evaluation');
  assert.equal(caseResult(report, 'case-02').objective.status, 'invalid');
  assert.equal(caseResult(report, 'case-01').objective.status, 'pass');
  const file = path.join(root, 'manifest.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.cases[1].protectedSha256['posting.md'] = sha256(await fs.readFile(input));
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  report = await scoreEvaluation(root);
  assert.equal(report.objective.counts.invalid, 2);
});
