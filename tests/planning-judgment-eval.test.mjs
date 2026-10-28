import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareEvaluation, scoreEvaluation, FIXTURE_ID } from '../scripts/planning-judgment-eval.mjs';

const revised = 'Harbor is a local analyst evidence-workbench prototype linking assessments to exact supporting passages and keeping saved annotations available offline. Its owner designed the information model and interactions, directed AI-assisted implementation, and tested complete analyst workflows.';
const revisedExplanation = 'This keeps the purpose and contribution concise while restoring the passage links and offline saved annotations needed for the disconnected review workflow.';
const adoptedExplanation = 'The proposal retains the purpose and owner contribution needed for an index. The omitted passage-link and offline details are available on the detailed page and are not needed here.';
const caseResult = (report, id) => report.cases.find(item => item.id === id);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-judgment-test-'));
  const root = path.join(parent, 'evaluation with spaces');
  await prepareEvaluation(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}
async function write(root, id, value) {
  await fs.writeFile(path.join(root, id, 'decision.json'), JSON.stringify(value, null, 2) + '\n');
}
async function validOutputs(root) {
  const proposed = (await fs.readFile(path.join(root, 'case-02/proposed.txt'), 'utf8')).trimEnd();
  await write(root, 'case-01', { decision: 'revise', final_text: revised, explanation: revisedExplanation });
  await write(root, 'case-02', { decision: 'adopt', final_text: proposed, explanation: adoptedExplanation });
  return proposed;
}

test('prepare freezes shared inputs and separate briefs and refuses to overwrite an existing root', async t => {
  const root = await fixture(t);
  for (const name of ['original.txt', 'proposed.txt', 'prompt.txt'])
    assert.deepEqual(await fs.readFile(path.join(root, 'case-01', name)), await fs.readFile(path.join(root, 'case-02', name)));
  assert.notEqual(await fs.readFile(path.join(root, 'case-01/brief.md'), 'utf8'), await fs.readFile(path.join(root, 'case-02/brief.md'), 'utf8'));
  const encoded = await fs.readFile(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(encoded);
  assert.equal(sha256(encoded),'e7b1d377c6869923514c85809e6cffc9d613a35d1e56faa55f2e9b8586b8445e','Scoring changes preserve the original frozen manifest and input hashes.');
  assert.equal(manifest.fixtureId, FIXTURE_ID);
  assert.equal(Object.hasOwn(manifest,'scoringVersion'),false);
  assert.equal(manifest.cases.length, 2);
  for (const item of manifest.cases) {
    assert.equal(Object.keys(item.protectedSha256).length, 4);
    assert.equal(Object.hasOwn(item, 'expectedDecision'), false);
    for (const [name, expected] of Object.entries(item.protectedSha256))
      assert.equal(sha256(await fs.readFile(path.join(root, item.id, name))), expected);
  }
  await assert.rejects(prepareEvaluation(root), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(root, 'manifest.json')), encoded);
});

test('well-formed expected decisions remain semantic-pending, never an overall behavioral pass', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const report = await scoreEvaluation(root);
  assert.equal(report.objective.status, 'pass');
  assert.equal(report.objective.counts.pass, 2);
  assert.equal(report.status, 'semantic_review_needed');
  assert.equal(report.scoringVersion,2);
  assert.equal(report.behavioralResult, 'not_determined');
  assert.equal(report.modelStarted, false);
  assert.equal(report.semantic.automatedSemanticAssessment, false);
  for (const item of report.cases) {
    assert.equal(item.semantic.status, 'human_review_needed');
    assert.ok(item.semantic.review.length > 0);
    assert.match(item.outputSha256, /^[a-f0-9]{64}$/);
  }
});

test('objective acceptance deliberately does not certify unsupported semantic claims', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  await write(root, 'case-01', { decision: 'revise', final_text: 'Harbor guarantees every analysis is correct.', explanation: 'Shorter is always better.' });
  const report = await scoreEvaluation(root);
  assert.equal(caseResult(report, 'case-01').objective.status, 'pass');
  assert.equal(report.status, 'semantic_review_needed');
  assert.equal(report.behavioralResult, 'not_determined');
});

test('case 01 adoption fails its explicit capability expectation without rejecting a case 02 revision', async t => {
  const root = await fixture(t);
  const proposed = await validOutputs(root);
  await write(root, 'case-01', { decision: 'adopt', final_text: proposed, explanation: 'Use it.' });
  await write(root, 'case-02', { decision: 'revise', final_text: proposed.replace('Its owner designed the product','Its owner defined the information model and interaction design'), explanation: 'The more specific owner contribution helps index readers understand the work performed.' });
  const report = await scoreEvaluation(root);
  assert.equal(report.status, 'objective_failed');
  assert.equal(report.objective.counts.fail, 1);
  assert.ok(caseResult(report,'case-01').objective.failures.some(message => message.includes('expected direction')));
  assert.equal(caseResult(report,'case-02').objective.status,'pass');
  assert.equal(caseResult(report,'case-02').semantic.status,'human_review_needed');
});

test('a bounded case 02 clarity revision remains pending semantic judgment rather than automatically failing or passing behavior', async t => {
  const root=await fixture(t);
  await validOutputs(root);
  await write(root,'case-02',{
    decision:'revise',
    final_text:'Harbor is a local evidence-workbench prototype that brings source passages, annotations, and assessments into one outline to make source-grounded analysis easier to inspect. Its owner designed the information model and interactions, directed AI-assisted implementation, and tested analyst workflows.',
    explanation:'The purpose and specific design contribution are clearer for index readers; offline and passage-link details remain on the detailed page.'
  });
  const report=await scoreEvaluation(root);
  assert.equal(report.objective.status,'pass');
  assert.equal(report.status,'semantic_review_needed');
  assert.equal(report.behavioralResult,'not_determined');
  assert.equal(report.scoringVersion,2);
  const result=caseResult(report,'case-02');
  assert.equal(result.semantic.automatedSemanticAssessment,false);
  assert.ok(result.objective.checks.includes('decision_value'));
  assert.ok(!result.objective.checks.includes('adopted_wording_matches_proposal'));
});

test('45 whitespace words meet the objective limit and 46 do not', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  for (const count of [45, 46]) {
    await write(root, 'case-01', { decision: 'revise', final_text: Array(count).fill('word').join(' \n '), explanation: 'A candidate for manual review.' });
    const result = caseResult(await scoreEvaluation(root), 'case-01');
    assert.equal(result.objective.wordCount, count);
    assert.equal(result.objective.status, count === 45 ? 'pass' : 'fail');
    assert.equal(result.semantic.status, 'human_review_needed');
  }
});

test('declaring adopt while changing case 02 text fails declared-choice consistency', async t => {
  const root = await fixture(t);
  const proposed = await validOutputs(root);
  await write(root, 'case-02', { decision: 'adopt', final_text: proposed.replace('Its owner', 'The owner'), explanation: adoptedExplanation });
  const result = caseResult(await scoreEvaluation(root), 'case-02');
  assert.equal(result.objective.status, 'fail');
  assert.ok(result.objective.failures.some(message => message.includes('declares adopt')));
  assert.ok(result.objective.checks.includes('decision_value'));
  assert.equal(result.semantic.automatedSemanticAssessment, false);
});

test('missing, empty, invalidly typed or invalid-enum fields cannot pass', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const base = { decision: 'revise', final_text: revised, explanation: revisedExplanation };
  const missing = { ...base }; delete missing.explanation;
  for (const value of [null, [], missing, { ...base, explanation: '' }, { ...base, final_text: 42 }, { ...base, decision: 'accept' }]) {
    await write(root, 'case-01', value);
    assert.equal(caseResult(await scoreEvaluation(root), 'case-01').objective.status, 'fail');
  }
});

test('missing output and malformed JSON are objective failures', async t => {
  const root = await fixture(t);
  let report = await scoreEvaluation(root);
  assert.equal(report.objective.counts.fail, 2);
  await validOutputs(root);
  await fs.writeFile(path.join(root, 'case-01/decision.json'), '{ "decision": "revise"');
  report = await scoreEvaluation(root);
  assert.equal(caseResult(report, 'case-01').objective.status, 'fail');
  assert.equal(caseResult(report, 'case-02').objective.status, 'pass');
});

test('a changed protected input invalidates the case even with acceptable output', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const input = path.join(root, 'case-01/brief.md');
  await fs.chmod(input, 0o644);
  await fs.writeFile(input, 'A different audience.\n');
  const report = await scoreEvaluation(root);
  assert.equal(report.status, 'invalid_evaluation');
  assert.equal(caseResult(report, 'case-01').objective.status, 'invalid');
  assert.equal(caseResult(report, 'case-02').objective.status, 'pass');
});

test('rewriting manifest hashes cannot legitimize changed protected inputs', async t => {
  const root = await fixture(t);
  await validOutputs(root);
  const input = path.join(root, 'case-01/brief.md'), file = path.join(root, 'manifest.json');
  await fs.chmod(input, 0o644);
  await fs.writeFile(input, 'A different audience.\n');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.cases[0].protectedSha256['brief.md'] = sha256(await fs.readFile(input));
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  const report = await scoreEvaluation(root);
  assert.equal(report.objective.counts.invalid, 2);
  assert.equal(report.behavioralResult, 'not_determined');
});
