import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePatchPath, installedFile } from '../scripts/install-background-update.mjs';
import { CHAT_LAYOUT_CHECKS, WORKFLOW_FLAGS } from '../scripts/install-planning-update.mjs';
import { AWARENESS_BASELINE_SHA256, AWARENESS_BASELINE_FINGERPRINT, validateAwarenessBaseline } from '../scripts/prepare-awareness-candidate.mjs';
import { createAwarenessManifest, validateAwarenessManifest } from '../scripts/freeze-awareness-candidate.mjs';
import { validateAwarenessRegression, validateAwarenessNative, validateAwarenessUI, validateAwarenessClosure, REQUIRED_AWARENESS_TEST_FILES, OPTIONAL_REGRESSION_CASES, EMAIL_UI_INTERFACE_COMMANDS } from '../scripts/awareness-release-evidence.mjs';
import { verifyAwarenessExecutables } from '../scripts/install-awareness-update.mjs';

const old = 'a'.repeat(64), next = 'b'.repeat(64), sha = value => createHash('sha256').update(value).digest('hex');
const candidate = path.resolve('awareness-update-fixture', 'candidate');
const context = { candidate, fingerprint: next, sourceFiles: { 'lib/planning-awareness.mjs': old, 'lib/email-oauth.mjs': next } };

test('the awareness release admits only the pinned 2.29 baseline and bounded new release paths', () => {
  assert.equal(AWARENESS_BASELINE_FINGERPRINT, 'c97776f753884f2d75c6b03555a4d7c024a369270833b7b73b6a208442ef4455');
  assert.equal(AWARENESS_BASELINE_SHA256, '98059bdd853b7d448cec3bb5a4815bd1445afb69bda525633b630e91237e8b66');
  assert.throws(() => validateAwarenessBaseline(Buffer.from('{"version":"2.29.0","appFingerprint":"' + AWARENESS_BASELINE_FINGERPRINT + '"}')), /exact reviewed 2.29.0 baseline bytes/);
  for (const file of ['PLANNING-AWARENESS.md', 'RELEASE-NOTES-2.30.0.md', 'scripts/email-oauth-token.mjs']) {
    assert.equal(validatePatchPath(file), file); assert.equal(installedFile(file), true);
  }
  assert.equal(installedFile('scripts/install-awareness-update.mjs'), false);
  for (const file of ['UNREVIEWED.md', '../server.mjs', 'data/email-oauth.json', 'node_modules/package/index.js', 'public/../profile.json']) assert.throws(() => validatePatchPath(file));
});

function manifestFixture() {
  const baseline = { candidate, sourceFiles: { 'package.json': old, 'public/font.ttf': old }, preservedSourceFiles: { 'scripts/retained-helper.mjs': { sha256: old, bytes: 1 } } };
  const local = { 'package.json': next, 'public/planning-awareness.mjs': next };
  return { baseline, local, manifest: createAwarenessManifest(baseline, local) };
}

test('freezing a local overlay retains every absent baseline asset without touching preserved extras', () => {
  const { baseline, local, manifest } = manifestFixture();
  assert.deepEqual(manifest.inheritedFiles, ['public/font.ttf']);
  assert.equal(manifest.sourceFiles['public/font.ttf'], old);
  assert.deepEqual(manifest.changes, [{ path: 'package.json', sha256: next, previousSha256: old }, { path: 'public/planning-awareness.mjs', sha256: next, previousSha256: null }]);
  assert.deepEqual(validateAwarenessManifest(manifest, baseline, manifest.sourceFiles), manifest);
  assert.throws(() => createAwarenessManifest(baseline, { ...local, 'scripts/retained-helper.mjs': next }), /conflicting/);
  assert.throws(() => createAwarenessManifest(baseline, { ...local, 'public/FONT.ttf': next }), /conflicting/);
  assert.throws(() => createAwarenessManifest(baseline, { ...local, 'package.json': old }), /version/);
});

test('a frozen manifest rejects omitted, duplicated, modified or newly added staged files', () => {
  for (const alter of [
    value => { delete value.sourceFiles['public/font.ttf']; },
    value => { value.inheritedFiles = []; },
    value => { value.localFiles.push(value.localFiles[0]); },
    value => { value.changes[0].previousSha256 = null; },
    value => { value.version = '2.29.0'; },
  ]) { const { baseline, manifest } = manifestFixture(); alter(manifest); assert.throws(() => validateAwarenessManifest(manifest, baseline)); }
  const { baseline, manifest } = manifestFixture();
  assert.throws(() => validateAwarenessManifest(manifest, baseline, { ...manifest.sourceFiles, 'lib/later.mjs': next }), /staged candidate/);
  assert.throws(() => validateAwarenessManifest(manifest, baseline, { ...manifest.sourceFiles, 'package.json': old }), /staged candidate/);
});

function regressionFixture(skipNames = []) {
  const sourceFiles = Object.fromEntries([...REQUIRED_AWARENESS_TEST_FILES, 'tests/nested/additional.test.mjs', 'scripts/verify-awareness-regression.mjs'].sort().map(file => [file, old]));
  const testFileList = Object.keys(sourceFiles).filter(file => /^tests\/.+\.test\.mjs$/.test(file)).sort();
  const skips = skipNames.map((name, index) => 'ok ' + (index + 2) + ' - ' + name + ' # SKIP explicitly optional native fixture');
  const tap = ['TAP version 13', 'ok 1 - an executed fixture', ...skips, '# tests ' + (1 + skips.length), '# pass 1', '# fail 0', '# cancelled 0', '# skipped ' + skips.length, ''].join('\n');
  const report = {
    format: 1, product: 'BLACKICE', version: '2.30.0', platform: 'win32', candidate,
    passed: true, exitCode: 0, timedOut: false, unchanged: true,
    appFingerprintBefore: next, appFingerprintAfter: next,
    sourceHashesBefore: { ...sourceFiles }, sourceHashesAfter: { ...sourceFiles },
    testFileList, testFiles: testFileList.length,
    testArguments: ['--test', '--test-concurrency=4', '--test-timeout=60000', '--test-reporter=tap', ...testFileList],
    tests: { total: 1 + skips.length, passed: 1, failed: 0, cancelled: 0, skipped: skips.length },
    logSha256: sha(tap), failures: [], skips,
  };
  return { report, tap, context: { candidate, sourceFiles, fingerprint: next } };
}

test('regression evidence binds the recursive actual test list and TAP bytes, with only reviewed optional skips', () => {
  for (const names of [[], [OPTIONAL_REGRESSION_CASES[0]]]) {
    const fixture = regressionFixture(names), accepted = validateAwarenessRegression(fixture.report, fixture.tap, fixture.context);
    assert.equal(accepted.completeTestFileList, true); assert.equal(accepted.testFiles, REQUIRED_AWARENESS_TEST_FILES.length + 1); assert.equal(accepted.skipped, names.length);
  }
  for (const alter of [
    value => { value.report.testFileList = value.report.testFileList.filter(file => !file.includes('/nested/')); value.report.testFiles -= 1; },
    value => { value.report.testArguments.push('--test-name-pattern=selected'); },
    value => { delete value.report.sourceHashesAfter['tests/nested/additional.test.mjs']; },
    value => { value.report.version = '2.29.0'; },
    value => { value.tap += '# later bytes\n'; },
    value => { value.report.tests.passed = 2; },
  ]) { const fixture = regressionFixture(); alter(fixture); assert.throws(() => validateAwarenessRegression(fixture.report, fixture.tap, fixture.context)); }
  const skipped = regressionFixture(['critical shared editing acceptance']);
  assert.throws(() => validateAwarenessRegression(skipped.report, skipped.tap, skipped.context), /Only the reviewed optional/);
});

function nativeFixture() {
  const requiredChecks = ['actual command completed', 'owned state closed normally'];
  const receipt = { passed: true, version: '2.30.0', platform: 'win32', candidate, appFingerprintBefore: next, appFingerprintAfter: next, unchangedDuringChecks: true, errors: [], cleanup: true, forcedCleanup: false, providerTurnsRequested: 0, checks: requiredChecks.map(name => ({ name, passed: true })), sourceHashesBefore: { ...context.sourceFiles }, sourceHashesAfter: { ...context.sourceFiles } };
  return { receipt, options: { ...context, name: 'native fixture', requiredChecks, requiredSources: ['lib/email-oauth.mjs'] } };
}

test('native acceptance needs every measured scenario on unchanged complete sources and normal cleanup', () => {
  const fixture = nativeFixture(); assert.equal(validateAwarenessNative(fixture.receipt, fixture.options).passed, true);
  for (const alter of [
    value => { value.checks.reverse(); }, value => { value.checks.pop(); },
    value => { value.version = '2.29.0'; }, value => { value.forcedCleanup = true; },
    value => { value.providerTurnsRequested = 1; }, value => { value.errors.push('fixture failed'); },
    value => { delete value.sourceHashesBefore['lib/planning-awareness.mjs']; },
  ]) { const { receipt, options } = nativeFixture(); alter(receipt); assert.throws(() => validateAwarenessNative(receipt, options)); }
});

function uiFixture() {
  const requiredFeatures = ['planningEditingPresence', 'planningWorkerReview', 'planningAwarenessMobile', 'emailOAuthSignIn', 'emailOAuthDraftSafety', 'emailOAuthMobile', 'clipboardRecovery', 'chatModePicker'];
  const checks = [...CHAT_LAYOUT_CHECKS];
  const receipt = {
    ok: true, version: '2.30.0', platform: 'win32', candidate, appFingerprintBefore: next, appFingerprintAfter: next, unchangedDuringChecks: true,
    serverClosed: true, disposableStateRemoved: true, checks, passed: checks.length, pageErrors: [], runtimeCalls: [{ externalRequests: 0, harnessIdentified: true }],
    features: Object.fromEntries(requiredFeatures.map(name => [name, true])), before: { ...context.sourceFiles }, after: { ...context.sourceFiles },
    emailCliCalls: EMAIL_UI_INTERFACE_COMMANDS.map(command => ({ args: command.split(' '), fixtureOnly: true })),
    workflowImprovement: Object.fromEntries(WORKFLOW_FLAGS.map(name => [name, true])),
    chatLayout: {
      before: { conversation: 840, plan: 360 }, collapsed: { planHidden: true, planInert: true, width: 1220, draft: 'QA layout draft: preserve this while changing panes.', expanded: 'false', focus: 'conversation-plan-toggle', saved: 'true' }, draftPreserved: true, keyboardRestored: true,
      breakpoints: [320, 390, 768, 1180, 1440, 1920].map(width => ({ width, planningMode: 'on', controlsSeparated: true, labelsVisible: true, planningHit: true, intersections: [], controls: ['options', 'attach', 'model', 'reasoning', 'planning', 'send', 'stop'].map((name, index) => ({ name, visible: true, hit: true, rect: { left: 10 + index * 40, right: 42 + index * 40, top: 710, bottom: 746, width: 32, height: 36 } })) })),
    },
    recovery: {
      chatMode: {
        fixtureOnly: true, liveCompletionVerified: false, route: 'chatgpt::chat-mode', catalogAvailable: false, finalState: 'schema-unverified', experimentalVisible: true, unavailableVisible: true, noFallback: true,
        savedSelection: 'chatgpt::chat-mode', selectionAfterReload: 'chatgpt::chat-mode', reasoningDisabled: true, reasoningValue: 'default', draftPreserved: true, setupDraftPreserved: true, setupSelectionPreserved: true, refreshSearchPreserved: true,
        exactTab: 'qa-owned-chat-mode-tab', setupTab: 'qa-owned-chat-mode-tab', setupCaptures: ['qa-owned-chat-mode-tab'], historicalFixture: true, historicalRoute: 'chatgpt::chat-mode', routeAfterNextReplyChange: 'chatgpt::chat-mode', nextReplyModel: 'fixture-model',
        mobile: { width: 320, fits: true, experimentalVisible: true, actionsReachable: true }, externalRequestCount: 0, turnsBefore: 6, turnsAfter: 6, historyRecordsAdded: 1, connectionActions: ['setup', 'refresh'],
      },
      clipboard: {
        fixtureOnly: true, osClipboardTouched: false, permissionChanges: false, noPrematureSuccess: true, mobileFits: true,
        denied: { sourceRetained: true, readonlySource: true, agentDraftRetained: true, scopeRetained: true, temporaryFieldsRemoved: true, reads: 0, unexpected: 0, events: [{ method: 'selection', exact: true, accepted: false }, { method: 'clipboard', exact: true, accepted: false }] },
        retry: { sourceRetained: true, readonlySource: true, agentDraftRetained: true, scopeRetained: true, temporaryFieldsRemoved: true, reads: 0, unexpected: 0, events: [{ method: 'selection', exact: true, accepted: false }, { method: 'clipboard', exact: true, accepted: false }, { method: 'selection', exact: true, accepted: false }, { method: 'clipboard', exact: true, accepted: true }] },
        selection: { reads: 0, unexpected: 0, temporaryFields: 0, events: [{ method: 'selection', exact: true, selectionValid: true, accepted: true }] },
        chat: { reads: 0, unexpected: 0, temporaryFields: 0, nativeCopyEvents: 0, inputPreserved: true, draftPreserved: true, selectionPreserved: true, scrollPreserved: true, copyButtonFocused: true, events: [{ method: 'selection', exact: true, selectionValid: true, accepted: true }] },
      },
      planningAwareness: {
        modelTurnsAdded: 0, beforeRevision: 7, presence: { draftTextSent: false, observedByTaskRead: true, advisoryOperationSucceeded: true }, draftIdentity: { sameField: true, sameSave: true, focused: true, selection: [4, 13, 'backward'] },
        saved: { revision: 8, affected: { pendingRevision: 8, state: 'needs-review' }, independent: { lastReadRevision: 7, pendingRevision: null, state: 'current' }, rejectedCode: 'TASK_PLAN_REVIEW_REQUIRED', rejectedActionExecuted: false, independentReadSucceeded: true },
        after: { deliveredRevision: 8, affectedWorkerReadsExecuted: 2, independentWorkerReadsExecuted: 1, nativeModelTurns: 0 },
        mobile: { width: 320, visiblePanes: 1, panelScrollWidth: 300, panelWidth: 300, awareness: { left: 10, right: 310 }, releasedOnHide: true, draftPreserved: true, reopeningDidNotAdvertise: true, fields: [{ left: 10, right: 310, width: 300, fontSize: 12 }] },
      },
      emailOAuth: {
        fixtureConsent: true, externalRequests: 0, mailboxReads: 0, localImport: true, conflictPreserved: true, composePreserved: true, identityVerified: true, pkceVerified: true, credentialsProtected: true, cliInterfaceChecks: EMAIL_UI_INTERFACE_COMMANDS.length,
        dropdown: [{ colorScheme: 'dark', backgroundAlpha: 1, foregroundAlpha: 1, backgroundLuminance: .02, contrast: 7 }], popup: { captured: true, open: null }, mobile: { width: 320, paneScrollWidth: 320, paneClientWidth: 320, fields: [{ left: 10, right: 310, width: 300, fontSize: 12 }] },
      },
    },
  };
  return { receipt, options: { ...context, requiredFeatures, uiSources: Object.keys(context.sourceFiles) } };
}

test('rendered awareness and email acceptance checks measured behavior beyond aggregate pass flags', () => {
  const fixture = uiFixture(), accepted = validateAwarenessUI(fixture.receipt, fixture.options);
  assert.equal(accepted.measuredPlanningAwareness, true); assert.equal(accepted.measuredEmailOAuth, true); assert.equal(accepted.measuredClipboardRecovery, true); assert.equal(accepted.measuredChatModePicker, true); assert.equal(accepted.actualEmailProcesses, 0);
  for (const alter of [
    value => { value.recovery.planningAwareness.saved.rejectedActionExecuted = true; },
    value => { value.recovery.planningAwareness.saved.independent.pendingRevision = 8; },
    value => { value.recovery.planningAwareness.after.deliveredRevision = 7; },
    value => { value.recovery.planningAwareness.draftIdentity.sameField = false; },
    value => { value.recovery.planningAwareness.mobile.awareness.right = 400; },
    value => { value.recovery.emailOAuth.dropdown[0].contrast = 1.2; },
    value => { value.recovery.emailOAuth.mailboxReads = 1; },
    value => { value.recovery.clipboard.osClipboardTouched = true; },
    value => { value.recovery.clipboard.retry.events.at(-1).accepted = false; },
    value => { value.recovery.clipboard.chat.selectionPreserved = false; },
    value => { value.recovery.chatMode.liveCompletionVerified = true; },
    value => { value.recovery.chatMode.setupCaptures.push('unrelated-tab'); },
    value => { value.recovery.chatMode.routeAfterNextReplyChange = 'fixture-model'; },
    value => { value.emailCliCalls[1].args = ['message', 'send', '--help']; },
    value => { value.emailCliCalls[1].fixtureOnly = false; },
    value => { value.recovery.emailOAuth.composePreserved = false; },
    value => { value.features.planningWorkerReview = false; },
  ]) { const { receipt, options } = uiFixture(); alter(receipt); assert.throws(() => validateAwarenessUI(receipt, options)); }
});

function closureFixture() {
  const at = Date.now(), time = delta => new Date(at + delta).toISOString(), installed = path.resolve('awareness-update-fixture', 'installed', 'resources', 'app');
  const base = { format: 1, product: 'BLACKICE', version: '2.29.0', targetVersion: '2.30.0', platform: 'win32', baselineSha256: AWARENESS_BASELINE_SHA256, planSha256: next, providerTurnsRequested: 0, routesMutated: false, errors: [] };
  const exactNativeProcess = { pid: 42, executable: path.resolve(installed, '../..', 'Agent Desk.exe'), mainWindowHandle: 123, startedAt: time(-100000) };
  const sample = observedAt => ({ observedAt, idle: true, version: '2.29.0', desktopApp: true, activeTurns: 0, execution: { activeCount: 0, activeRunIds: [], settling: false, stopping: false }, learning: { activeReview: false, activeRun: false }, inbox: { active: 0, pending: 0, paused: true }, operations: { running: 0, queued: 0, paused: true }, projects: { running: 0 }, browser: { busy: false } });
  return {
    idle: { ...base, verifiedAt: time(-900), exactNativeProcess: { ...exactNativeProcess }, idle: true, statusOk: true, loopbackListenerOwned: true, samples: [sample(time(-1500)), sample(time(-1000))] },
    closure: { ...base, verifiedAt: time(-100), requestedAt: time(-800), exactNativeProcess: { ...exactNativeProcess }, idleReceiptSha256: old, method: 'CloseMainWindow', closeRequested: true, closeAccepted: true, nativeExited: true, exitCode: 0, graceful: true, closed: true, remainingInstalledProcesses: 0, loopbackListenerClosed: true, runtimeMarkerRemoved: true, forcedCleanup: false },
    options: { at, installed, planSha256: next, idleSha256: old },
  };
}

test('commit closure evidence binds fresh idle samples, exact process, normal exit and the reviewed plan', () => {
  const fixture = closureFixture(); assert.equal(validateAwarenessClosure(fixture.idle, fixture.closure, fixture.options).normalClose, true);
  for (const alter of [
    value => { value.idle.verifiedAt = new Date(value.options.at - 11 * 60 * 1000).toISOString(); },
    value => { value.closure.planSha256 = old; }, value => { value.closure.idleReceiptSha256 = next; },
    value => { value.idle.samples[1].inbox.pending = 1; }, value => { value.idle.samples[0].operations.paused = false; },
    value => { value.closure.exactNativeProcess.pid = 43; }, value => { value.closure.forcedCleanup = true; },
    value => { value.closure.exitCode = 1; }, value => { value.closure.remainingInstalledProcesses = 1; },
    value => { value.closure.requestedAt = new Date(value.options.at + 1500).toISOString(); },
  ]) { const value = closureFixture(); alter(value); assert.throws(() => validateAwarenessClosure(value.idle, value.closure, value.options)); }
});

test('accepted native executable hashes are rechecked without executing those files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-awareness-executables-'));
  try {
    const electron = path.join(directory, 'electron.exe'), himalaya = path.join(directory, 'himalaya.exe');
    await writeFile(electron, 'owned inert runtime fixture'); await writeFile(himalaya, 'owned inert email fixture');
    const runtime = { electron, himalaya, electronHashAfter: sha('owned inert runtime fixture'), himalayaHashAfter: sha('owned inert email fixture') };
    const accepted = await verifyAwarenessExecutables(runtime);
    assert.equal(accepted.himalaya.sha256, runtime.himalayaHashAfter);
    await writeFile(himalaya, 'later changed bytes');
    await assert.rejects(verifyAwarenessExecutables(runtime), /changed after acceptance/);
    await assert.rejects(verifyAwarenessExecutables({ ...runtime, electron: 'relative.exe' }), /absolute measured executable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
