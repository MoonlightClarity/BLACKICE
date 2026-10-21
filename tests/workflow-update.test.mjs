import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_FLAGS, WORKFLOW_UI_CHECK_COUNT, validateWorkflowImprovementEvidence, validateWorkflowBaseline, candidateChanges } from '../scripts/install-workflow-update.mjs';

const improvementReceipt = () => ({ workflowImprovement: Object.fromEntries(WORKFLOW_FLAGS.map(flag => [flag, true])) });

test('workflow update requires the complete explicit improvement receipt', () => {
  const ui = improvementReceipt();
  assert.deepEqual(validateWorkflowImprovementEvidence(ui), ui.workflowImprovement);
  assert.notEqual(validateWorkflowImprovementEvidence(ui), ui.workflowImprovement);
  for (const receipt of [undefined, null, [], true, 'passed']) assert.throws(() => validateWorkflowImprovementEvidence({ workflowImprovement: receipt }), /completed workflow improvement receipt/);
});

test('workflow update rejects missing checks, truthy substitutes and inherited pass flags', () => {
  for (const flag of WORKFLOW_FLAGS) {
    const missing = improvementReceipt(); delete missing.workflowImprovement[flag];
    assert.throws(() => validateWorkflowImprovementEvidence(missing), { message: 'The workflow improvement check did not pass: ' + flag });
    for (const value of [false, null, 1, 'true', {}]) {
      const ui = improvementReceipt(); ui.workflowImprovement[flag] = value;
      assert.throws(() => validateWorkflowImprovementEvidence(ui), { message: 'The workflow improvement check did not pass: ' + flag });
    }
  }
  assert.throws(() => validateWorkflowImprovementEvidence({ workflowImprovement: Object.create(improvementReceipt().workflowImprovement) }), /did not pass/);
});

test('workflow update refuses the earlier 96-check receipt without model, dropdown and rename acceptance', () => {
  const previous = { workflowImprovement: { sidebarMessageSearch: true, sidebarFileSearch: true, matchedTurnNavigation: true, paletteContentSearch: true, searchDraftPreserved: true, narrowSearchLayout: true, composerShortcutScoped: true, catalogRetry: true } };
  for (const flag of ['modelPickerList', 'modelReasoningContrast', 'chatRename']) {
    assert.throws(() => validateWorkflowImprovementEvidence(previous), { message: 'The workflow improvement check did not pass: ' + flag });
    previous.workflowImprovement[flag] = true;
  }
  assert.equal(WORKFLOW_UI_CHECK_COUNT, 99);
  assert.deepEqual(validateWorkflowImprovementEvidence(previous), previous.workflowImprovement);
});

test('workflow update remains bound to the inspected 2.27 baseline and preserves existing files', () => {
  assert.throws(() => validateWorkflowBaseline(Buffer.from('{"version":"2.27.0"}')), /exact inspected 2.27.0 baseline bytes/);
  const old = 'a'.repeat(64), next = 'b'.repeat(64);
  const baseline = { sourceFiles: { 'public/app.js': old }, preservedSourceFiles: { 'scripts/legacy-helper.mjs': { sha256: old, bytes: 1 } } };
  assert.deepEqual(candidateChanges(baseline, { 'public/app.js': next }), [{ path: 'public/app.js', sha256: next, previousSha256: old }]);
  assert.throws(() => candidateChanges(baseline, {}), /omitted a baseline file/);
  assert.throws(() => candidateChanges(baseline, { 'public/app.js': old, 'scripts/legacy-helper.mjs': next }), /conflicting/);
});
