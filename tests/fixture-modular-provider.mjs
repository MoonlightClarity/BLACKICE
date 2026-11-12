import assert from 'node:assert/strict';
import { MODULAR_OUTCOME_SCHEMA } from '../lib/modular-completion.mjs';

// Synthetic provider protocol for tests whose outcome is asserted by the test.
// This is not a production evaluator: no real model or external effects occur.
export function fixtureOutcomeReview(options, assess = () => ({ decision: 'respond', summary: 'The asserted synthetic fixture outcome is complete.', remaining: [], nextAction: '', blockers: [] })) {
  if (!options.responseOnly || !options.prompt?.startsWith('BLACKICE MODULAR OUTCOME REVIEW.')) return null;
  assert.deepEqual(options.outputSchema, MODULAR_OUTCOME_SCHEMA);
  assert.equal(options.sandbox, 'read-only');
  assert.equal(options.onBeforeFinal, undefined);
  const line = options.prompt.split('\n\n').find(part => part.startsWith('{"snapshot":'));
  const { snapshot, candidate } = JSON.parse(line);
  assert.ok(candidate.output.trim(), 'A synthetic completion still needs a candidate.');
  const assessment = assess({ snapshot, candidate });
  return { output: JSON.stringify({ ...assessment, evidenceRefs: assessment.evidenceRefs ?? snapshot.evidence.records.map(row => row.id) }) };
}
export async function finishFixtureCandidate(options, result) {
  const review = await options.onBeforeFinal?.(result);
  assert.equal(review == null, true, 'This fixture must not discard a requested continuation.');
  return result;
}
