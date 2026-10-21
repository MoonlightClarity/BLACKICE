import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_LAYOUT_CHECKS, validateChatLayoutEvidence, candidateChanges, validateUiRefinementBaseline } from '../scripts/install-ui-refinement-update.mjs';

function layoutReceipt() {
  const names = ['options', 'attach', 'model', 'reasoning', 'planning', 'send', 'stop'];
  return {
    checks: [...CHAT_LAYOUT_CHECKS],
    chatLayout: {
      before: { conversation: 840, plan: 360 },
      collapsed: { planHidden: true, planInert: true, width: 1220, draft: 'QA layout draft: preserve this while changing panes.', expanded: 'false', focus: 'conversation-plan-toggle', saved: 'true' },
      draftPreserved: true,
      keyboardRestored: true,
      breakpoints: [320, 390, 768, 1180, 1440, 1920].map(width => ({
        width, planningMode: 'on', controlsSeparated: true, labelsVisible: true, planningHit: true, intersections: [],
        controls: names.map((name, index) => ({ name, visible: true, hit: true, rect: { left: 10 + index * 40, right: 42 + index * 40, top: 710, bottom: 746, width: 32, height: 36 } })),
      })),
    },
  };
}

test('UI refinement acceptance checks measured chat geometry at all six breakpoints', () => {
  assert.deepEqual(validateChatLayoutEvidence(layoutReceipt()), { breakpoints: [320, 390, 768, 1180, 1440, 1920], checks: CHAT_LAYOUT_CHECKS.length, draftPreserved: true, keyboardRestored: true });
});

test('UI refinement acceptance rejects false aggregate passes and incomplete layout evidence', () => {
  const rejected = [
    ui => { ui.checks = ui.checks.filter(name => name !== 'The welcome invitation aligns with its composer'); },
    ui => { ui.chatLayout.before.conversation = 400; },
    ui => { ui.chatLayout.collapsed.planInert = false; },
    ui => { ui.chatLayout.collapsed.draft = ''; },
    ui => { ui.chatLayout.collapsed.focus = 'mission-task'; },
    ui => { ui.chatLayout.breakpoints.pop(); },
    ui => { ui.chatLayout.breakpoints[0].controls[0].hit = false; },
    ui => { ui.chatLayout.breakpoints[0].controls[0].rect = { ...ui.chatLayout.breakpoints[0].controls[1].rect }; },
    ui => { ui.chatLayout.breakpoints[0].controls[0].rect.right = 400; },
    ui => { ui.chatLayout.breakpoints[0].controls.pop(); },
    ui => { ui.chatLayout.breakpoints[0].planningHit = false; },
  ];
  for (const alter of rejected) { const ui = layoutReceipt(); alter(ui); assert.throws(() => validateChatLayoutEvidence(ui)); }
});

test('UI refinement changes preserve baseline and unmanaged paths', () => {
  const old = 'a'.repeat(64), next = 'b'.repeat(64);
  const baseline = { sourceFiles: { 'public/app.js': old }, preservedSourceFiles: { 'scripts/legacy-helper.mjs': { sha256: old, bytes: 1 } } };
  assert.deepEqual(candidateChanges(baseline, { 'public/app.js': next, 'public/conversation-layout.css': next }), [
    { path: 'public/app.js', sha256: next, previousSha256: old },
    { path: 'public/conversation-layout.css', sha256: next, previousSha256: null },
  ]);
  assert.throws(() => candidateChanges(baseline, {}), /omitted a baseline file/);
  assert.throws(() => candidateChanges(baseline, { 'public/app.js': old, 'scripts/legacy-helper.mjs': next }), /conflicting/);
  assert.throws(() => candidateChanges(baseline, { 'public/app.js': old, 'public/APP.js': next }), /conflicting/);
  assert.throws(() => candidateChanges(baseline, { 'public/app.js': old, 'data/runs.json': next }), /cannot include/);
});

test('UI refinement baseline rejects anything except the inspected 2.26.0 bytes', () => {
  assert.throws(() => validateUiRefinementBaseline(Buffer.from('{"version":"2.26.0"}')), /exact inspected 2.26.0 baseline bytes/);
});
