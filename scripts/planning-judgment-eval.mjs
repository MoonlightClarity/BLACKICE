#!/usr/bin/env node
// Opt-in local fixture preparation and objective checks; no model is invoked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FIXTURE_ID = 'harbor-goal-preserving-simplification-v1';
const ORIGINAL = 'Harbor is a local evidence-workbench prototype for analysts. It brings source passages, annotations, and assessments into one outline. Each assessment links to the exact supporting passage, and saved annotations remain available offline. The project owner defined the information model and interaction design, directed AI-assisted implementation, and tested complete analyst workflows. The prototype is intended to make source-grounded analysis easier to inspect.';
const PROPOSED = 'Harbor is a local evidence-workbench prototype that brings source passages, annotations, and assessments into one outline. Its owner designed the product, directed AI-assisted implementation, and tested analyst workflows.';
const PROMPT = 'Evaluate whether to adopt the proposed shorter entry for the audience described in brief.md. Use the original as the factual record. The final entry must be at most 45 words and retain the information this audience needs. Prefer the proposed wording unchanged when it satisfies the brief; otherwise provide a concise correction. Do not invent capabilities, adoption, results, or a different implementation role. Write decision.json containing decision (adopt or revise), final_text, and a short explanation identifying the concrete benefit and any relevant information lost. Do not modify the supplied inputs.';
const CASES = [
  { id: 'case-01', expectedDecision: 'revise', brief: 'This entry is for analysts evaluating the prototype for a disconnected evidence-review workflow. They need its purpose and the owner’s contribution, and must be able to tell whether assessments return to exact supporting passages and whether saved annotations remain available offline. These two capabilities distinguish a suitable prototype from a generic note organizer.' },
  { id: 'case-02', brief: 'This entry is for a general project index. Readers need the prototype’s purpose and the owner’s contribution before deciding whether to open its detailed page. Offline behavior and passage-level linking are documented there and are not required in this index entry. Use the proposed wording unchanged if it meets these needs.' }
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const inputs = item => ({ 'original.txt': ORIGINAL + '\n', 'proposed.txt': PROPOSED + '\n', 'brief.md': item.brief + '\n', 'prompt.txt': PROMPT + '\n' });
const manifest = () => ({
  formatVersion: 1, fixtureId: FIXTURE_ID,
  cases: CASES.map(item => ({ id: item.id, output: 'decision.json', protectedSha256: Object.fromEntries(Object.entries(inputs(item)).map(([name, content]) => [name, sha256(content)])) }))
});

export async function prepareEvaluation(root) {
  root = path.resolve(root);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root); // Exclusive: existing roots are never merged or overwritten.
  for (const item of CASES) {
    const directory = path.join(root, item.id);
    await fs.mkdir(directory);
    for (const [name, content] of Object.entries(inputs(item)))
      await fs.writeFile(path.join(directory, name), content, { flag: 'wx', mode: 0o444 });
  }
  const encoded = json(manifest());
  await fs.writeFile(path.join(root, 'manifest.json'), encoded, { flag: 'wx', mode: 0o444 });
  return {
    formatVersion: 1, fixtureId: FIXTURE_ID, status: 'prepared', root,
    manifestSha256: sha256(encoded), modelStarted: false,
    cases: CASES.map(item => ({ id: item.id, workspace: path.join(root, item.id), promptFile: path.join(root, item.id, 'prompt.txt'), outputFile: path.join(root, item.id, 'decision.json') }))
  };
}

async function readOrdinaryFile(file, maxBytes = 65536) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw Error('Expected an ordinary bounded file: ' + path.basename(file));
  return fs.readFile(file);
}
async function checkInputs(root, item) {
  const directory = path.join(root, item.id), issues = [];
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Not an ordinary case directory.');
  } catch { return ['Case directory is missing or not ordinary.']; }
  for (const [name, content] of Object.entries(inputs(item))) {
    try {
      if (sha256(await readOrdinaryFile(path.join(directory, name))) !== sha256(content)) issues.push(name + ': protected input changed');
    } catch { issues.push(name + ': protected input missing or not ordinary'); }
  }
  return issues;
}
function checkSubmission(value, item) {
  const failures = [], checks = [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { status: 'fail', failures: ['decision.json must contain a JSON object.'], checks };
  for (const key of ['decision', 'final_text', 'explanation']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) failures.push(key + ' must be a nonempty string.');
  }
  if (failures.length) return { status: 'fail', failures, checks };
  checks.push('required_fields_and_types');
  if (!['adopt', 'revise'].includes(value.decision)) failures.push('decision must be adopt or revise.');
  else if (item.expectedDecision && value.decision !== item.expectedDecision) failures.push('The decision does not match this constructed case’s expected direction.');
  else checks.push(item.expectedDecision ? 'expected_decision_direction' : 'decision_value');
  const wordCount = value.final_text.trim().split(/\s+/u).length;
  if (wordCount > 45) failures.push('final_text exceeds the 45 whitespace-word limit.');
  else checks.push('word_limit');
  if (item.id === 'case-02' && value.decision === 'adopt') {
    if (value.final_text !== PROPOSED) failures.push('Case 02 declares adopt, but final_text differs from the proposal. Use revise for a changed entry; its adequacy and benefit require semantic review.');
    else checks.push('adopted_wording_matches_proposal');
  }
  return { status: failures.length ? 'fail' : 'pass', failures, checks, wordCount };
}
function reviewFor(item) {
  return {
    status: 'human_review_needed', automatedSemanticAssessment: false,
    review: item.id === 'case-01' ? [
      'Does the actual final wording retain the purpose and owner contribution required by this audience?',
      'Does it communicate assessment-to-exact-supporting-passage links and saved annotations available offline, without broadening the offline claim to the whole application?',
      'Does it preserve the stated prototype status and AI-assisted implementation role without inventing capabilities, adoption or results?',
      'Does the explanation identify a concrete audience-related benefit and relevant information loss, consistent with the actual wording?'
    ] : [
      'Is the explanation faithful to the source and the general-index brief, without invented capabilities, adoption, results or a different owner role?',
      'Does the explanation support adopting or revising for this audience, distinguish omitted detail from lost goal-relevant information, and treat the unchanged-wording preference as conditional on adequacy?',
      'If revising, is the claimed audience-related benefit supported by the actual final wording, with the purpose, owner contribution and factual scope preserved?'
    ]
  };
}
function report(root, cases) {
  const counts = Object.fromEntries(['pass', 'fail', 'invalid'].map(status => [status, cases.filter(item => item.objective.status === status).length]));
  const objectiveStatus = counts.invalid ? 'invalid' : counts.fail ? 'fail' : 'pass';
  return {
    formatVersion: 1, scoringVersion: 2, fixtureId: FIXTURE_ID, root, manifestSha256: sha256(json(manifest())), modelStarted: false,
    status: objectiveStatus === 'invalid' ? 'invalid_evaluation' : objectiveStatus === 'fail' ? 'objective_failed' : 'semantic_review_needed',
    objective: { status: objectiveStatus, counts },
    semantic: { status: 'human_review_needed', automatedSemanticAssessment: false },
    behavioralResult: 'not_determined', cases,
    limitations: [
      'Objective checks do not establish that the revised text preserves the goal, factual scope, owner role or a sound explanation.',
      'Case 02 allows adopt or revise: adequacy and the benefit of a revision require human review. Exact proposed wording is checked only when the agent declares adopt, as declared-choice consistency.',
      'The scorer does not assess private reasoning, planning verbosity, ceremonial alternatives, or a change of mind.',
      'No model or BLACKICE provider is invoked or observed by this tool. Record native run evidence and human semantic review separately.'
    ]
  };
}

export async function scoreEvaluation(root) {
  root = path.resolve(root);
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Evaluation root must be an ordinary directory.');
    if (!(await readOrdinaryFile(path.join(root, 'manifest.json'))).equals(Buffer.from(json(manifest()))))
      throw Error('Manifest differs from the frozen evaluator definition.');
  } catch (error) {
    return report(root, CASES.map(item => ({ id: item.id, objective: { status: 'invalid', failures: [error.message], checks: [] }, semantic: reviewFor(item) })));
  }
  const cases = [];
  for (const item of CASES) {
    const issues = await checkInputs(root, item);
    if (issues.length) {
      cases.push({ id: item.id, objective: { status: 'invalid', failures: issues, checks: [] }, semantic: reviewFor(item) });
      continue;
    }
    let bytes, submission, objective;
    try {
      bytes = await readOrdinaryFile(path.join(root, item.id, 'decision.json'));
      submission = JSON.parse(bytes.toString('utf8'));
      objective = checkSubmission(submission, item);
    } catch (error) { objective = { status: 'fail', failures: ['Missing, unreadable or invalid decision.json: ' + error.message], checks: [] }; }
    cases.push({
      id: item.id, objective, semantic: reviewFor(item),
      ...(bytes ? { outputSha256: sha256(bytes) } : {}),
      ...(submission && typeof submission === 'object' && !Array.isArray(submission) ? { submission: Object.fromEntries(['decision', 'final_text', 'explanation'].filter(key => typeof submission[key] === 'string').map(key => [key, submission[key]])) } : {})
    });
  }
  return report(root, cases);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, flag, root, ...extra] = process.argv.slice(2);
    if (!['prepare', 'score'].includes(command) || flag !== '--root' || !root?.trim() || extra.length)
      throw Error('Usage: planning-judgment-eval.mjs prepare|score --root PATH');
    const result = command === 'prepare' ? await prepareEvaluation(root) : await scoreEvaluation(root);
    process.stdout.write(json(result));
    process.exitCode = result.status === 'invalid_evaluation' ? 2 : result.status === 'objective_failed' ? 1 : 0;
  } catch (error) {
    process.stdout.write(json({ formatVersion: 1, fixtureId: FIXTURE_ID, status: 'error', code: error.code || 'EVALUATION_ERROR', message: error.message, modelStarted: false }));
    process.exitCode = 2;
  }
}
