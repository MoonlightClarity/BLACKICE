import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateRecoveryBaseline, candidateChanges, verifyInstalledFiles, validateRecoveryEvidence, RECOVERY_FLAGS } from '../scripts/install-recovery-update.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

const UI_SOURCES = ['public/conversation.css','public/blackice-experience.css','public/run-state-model.mjs','public/icon-symbols.mjs','lib/harness-identity.mjs', 'public/planning-mode.mjs', 'public/task-plan-map.mjs', 'public/task-plan.css', 'public/blackice-material.css', 'public/assets/blackice-field.svg', 'public/assets/blackice-wordmark.svg', 'server.mjs', 'lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/cron.mjs', 'lib/projects.mjs', 'lib/subagents.mjs', 'lib/agent-email.mjs', 'public/app.js', 'public/index.html', 'public/workspace-integrations.mjs', 'public/mission-ui.mjs', 'public/task-plan-ui.mjs', 'public/advanced-ui.mjs', 'public/email-ui.mjs', 'public/email.css', 'scripts/revised-workspace-ui-qa.mjs'];
const OPTIONAL_SKIPS = ['Relay-owned sign-in and local storage survive a full process restart without foregrounding', 'restored hidden browser tabs defer requests until used and never load closed or replaced pages', 'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart', 'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched'];

// This synthetic data tests rejection logic; it is never a release receipt.
function evidenceFixture() {
  const candidate = path.resolve('unit-only-candidate'), work = path.dirname(candidate), fingerprint = sha('unit-only-runtime');
  const sourceFiles = Object.fromEntries([...UI_SOURCES, 'lib/codex.mjs', 'lib/providers.mjs', 'scripts/install-recovery-update.mjs', 'tests/tool-settlement.test.mjs', 'tests/runtime-reconnect-queue.test.mjs', 'tests/mission-ui.test.mjs', 'tests/recovery-update.test.mjs'].map(file => [file, sha(file)]));
  const subset = names => Object.fromEntries(names.map(name => [name, sourceFiles[name]]));
  const skips = OPTIONAL_SKIPS.map((name, index) => `ok ${index + 1} - ${name} # SKIP opt-in fixture`);
  const tap = [...skips, ...['API Stop keeps a real pending patch leased', 'API close drains an admitted callback', 'native cancel retains a held dynamic callback', 'native exit retains a held dynamic callback', 'native close retains a held dynamic callback', 'successful reconnect wakes a persisted explicit queue'].map((name, i) => `ok ${i + 5} - ${name}`), '# tests 2740', '# pass 2736', '# fail 0', '# cancelled 0', '# skipped 4', ''].join('\n');
  const regression = { format: 1, product: 'BLACKICE', version: '2.26.0', platform: 'win32', passed: true, exitCode: 0, unchanged: true, appFingerprintBefore: fingerprint, appFingerprintAfter: fingerprint, candidate, sourceHashesBefore: { ...sourceFiles }, sourceHashesAfter: { ...sourceFiles }, testFiles: Object.keys(sourceFiles).filter(file => /^tests\/[^/]+\.test\.mjs$/.test(file)).length, tests: { total: 2740, passed: 2736, failed: 0, cancelled: 0, skipped: 4 }, skips, logSha256: sha(tap) };
  const checks = ['The task pane appears before the answer', 'Stop stays available while a direction request is pending', 'Only acknowledged cancellation is marked stopped and its execution slot is released', ...Array.from({ length: 57 }, (_, index) => `Synthetic UI check ${index + 1}`)];
  const ui = { ok: true, version: '2.26.0', platform: 'win32', candidate, appFingerprintBefore: fingerprint, appFingerprintAfter: fingerprint, unchangedDuringChecks: true, serverClosed: true, disposableStateRemoved: true, checks, passed: checks.length, pageErrors: [], emailCliCalls: [], runtimeCalls: Array.from({length: 6}, () => ({externalRequests: 0, harnessIdentified: true})), cancellation: { directionRequests: 3, directionRequestScope: 'entire-owned-fixture', stopJourneyDirectionRequests: 1, cancellationObserved: 1, pendingStatus: 'Stopping… Waiting for active work to finish.', settledStatus: 'Stopped', settled: true, status: 'cancelled' }, before: subset(UI_SOURCES), after: subset(UI_SOURCES) };
  ui.planning = { choices: ['maximal','on','auto','off'], descriptions: Object.fromEntries(['maximal','on','auto','off'].map(mode => [mode, 'Synthetic unit-only description for ' + mode])), plannedMode: 'on', offMode: 'off', offCompleted: true, offToolCalls: 0, offFinalVisible: true };
  ui.mindMap = { savedNodeIds: ['inspect','save'], dependenciesVisible: true, sharedNotesVisible: true, focusPreservesTree: true, zoomChangesViewport: true, keyboardSelection: true, hoverPreservesPosition: true, readingTitlePx: 11.7, internallyScrollable: true };
  ui.visual = { vectorAssets: ['blackice-field.svg','blackice-wordmark.svg'].map(name => ({name, served: true, vectorOnly: true})), sceneUsesSvg: true, gradientSurfaceCount: 6, repeatedSceneInReadingPanels: false };
  ui.directionHttpReceipts = [409, 200, 409].map(status => ({ status, finished: true }));
  ui.recovery = {
    workspace: { blockedCardsAccurate: true },
    map: { liveUpdatePreservedFocus: true, keyboardPanPreserved: true, enabledZoomFallback: true },
    directions: { newDraftUsable: true, originLockRestored: true, lateErrorOwned: true, otherDraftPreservedAfterError: true, lateSuccessPreservedOtherDraft: true, originRetryEnabled: true, requests: 3, receipts: [{accepted: false}, {accepted: true}, {accepted: false}] },
    emptyPlans: { missing: { conversationDefault: true, planReachable: true, explicitChoicePreserved: true }, unavailable: { conversationDefault: true, planReachable: true, explicitChoicePreserved: true } },
    header: { stoppingUntilSettled: true, readyAfterSettlement: true },
    composer: { offControlsSeparated: true, unavailableControlsSeparated: true },
  };
  return { regression, tap, ui, fingerprint, sourceFiles, candidate, work };
}

test('recovery admission accepts a coherent bound synthetic fixture, never used as live evidence', () => {
  const accepted = validateRecoveryEvidence(evidenceFixture());
  assert.equal(accepted.uiChecks, 60);
  assert.equal(accepted.regression.passed, 2736);
  assert.equal(accepted.localModelTurns, 6);
  assert.equal(accepted.controlledDirectionRequests, 3);
});

test('recovery admission rejects stale release, changed code, omitted coverage and contradictory TAP', () => {
  for (const mutate of [
    value => { value.regression.version = '2.25.0'; },
    value => { value.regression.testFiles--; },
    value => { value.regression.sourceHashesAfter['lib/codex.mjs'] = sha('changed callback lifecycle'); },
    value => { delete value.regression.sourceHashesBefore['tests/mission-ui.test.mjs']; },
    value => { value.regression.appFingerprintAfter = sha('another app'); },
    value => { value.tap += '# pass 2735\n'; },
    value => { value.tap = value.tap.replace(OPTIONAL_SKIPS[0], 'Unapproved skipped recovery'); value.regression.logSha256 = sha(value.tap); value.regression.skips = value.tap.split('\n').filter(line => /# SKIP/.test(line)); },
    value => { value.ui.before['public/run-state-model.mjs'] = sha('stale status model'); },
    value => { value.tap = value.tap.replace('native exit retains a held dynamic callback', 'unrelated protocol test'); value.regression.logSha256 = sha(value.tap); },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateRecoveryEvidence(fixture)); }
});

test('recovery admission requires every real navigation, map and settlement outcome', () => {
  for (const field of RECOVERY_FLAGS) {
    const fixture = evidenceFixture(), keys = field.split('.'), leaf = keys.pop();
    keys.reduce((current, key) => current[key], fixture.ui.recovery)[leaf] = false;
    assert.throws(() => validateRecoveryEvidence(fixture), /real UI recovery check/, field);
  }
});

test('recovery admission rejects external work, incomplete cleanup and missing controlled requests', () => {
  for (const mutate of [
    value => { value.ui.runtimeCalls[0].externalRequests = 1; },
    value => { value.ui.emailCliCalls.push({ command: 'unrequested mailbox' }); },
    value => { value.ui.runtimeCalls[0].harnessIdentified = false; },
    value => { value.ui.disposableStateRemoved = false; },
    value => { value.ui.serverClosed = false; },
    value => { value.ui.cancellation.settled = false; },
    value => { value.ui.recovery.directions.receipts.pop(); },
    value => { value.ui.directionHttpReceipts[1].finished = false; },
    value => { value.ui.pageErrors.push('uncaught exception'); },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateRecoveryEvidence(fixture)); }
});

test('the inspected baseline cannot be substituted with self-declared versions or hashes', () => {
  for (const value of [{}, { format: 1, product: 'BLACKICE', version: '2.25.0', sourceFiles: {} }, { version: '2.26.0' }]) {
    assert.throws(() => validateRecoveryBaseline(Buffer.from(JSON.stringify(value))), /exact inspected 2.25.0 baseline bytes/);
  }
});

test('candidate admission preserves all baseline paths and refuses preserved-file collisions', () => {
  const baseline = { sourceFiles: { 'package.json': sha('old package'), 'server.mjs': sha('server') }, preservedSourceFiles: { 'desktop/old-icon.png': { sha256: sha('preserved'), bytes: 9 } } };
  const candidate = { ...baseline.sourceFiles, 'package.json': sha('new package'), 'tests/new.test.mjs': sha('new test') };
  assert.deepEqual(candidateChanges(baseline, candidate), [
    { path: 'package.json', sha256: sha('new package'), previousSha256: sha('old package') },
    { path: 'tests/new.test.mjs', sha256: sha('new test'), previousSha256: null },
  ]);
  for (const changed of [
    { 'package.json': sha('new package') },
    { ...candidate, 'desktop/OLD-ICON.png': sha('replacement') },
    { ...candidate, 'SERVER.mjs': sha('duplicate') },
    { ...candidate, 'data/settings.json': sha('profile') },
    { ...candidate, 'lib/new.mjs': 'not a checksum' },
  ]) assert.throws(() => candidateChanges(baseline, changed));
});

test('installed verification checks unchanged originals as well as the patch and leaves unrelated files intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-recovery-admission-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), 'packaged metadata');
  await fs.writeFile(path.join(root, 'server.mjs'), 'old server');
  await fs.writeFile(path.join(root, 'unrelated.txt'), 'preserve');
  const expected = { 'package.json': sha('packaged metadata'), 'server.mjs': sha('old server') };
  assert.equal(await verifyInstalledFiles(root, expected), 2);
  await fs.writeFile(path.join(root, 'package.json'), 'independent edit');
  await assert.rejects(verifyInstalledFiles(root, expected), /package.json/);
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), 'independent edit');
  assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'preserve');
});
