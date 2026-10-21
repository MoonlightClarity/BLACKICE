import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { commitOperations, validatePatchPath, validateBackgroundEvidence } from '../scripts/install-background-update.mjs';
import { assessPlanAcceptance } from '../scripts/verify-task-plan-runtime.mjs';
import { TASK_TOOL, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

async function transactionFixture(t, definitions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const operations = [];
  for (const [scope, relative, previous, next] of definitions) {
    const root = path.join(directory, scope);
    await fs.mkdir(root, { recursive: true });
    if (previous !== null) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), previous, { mode: 0o640 });
    }
    const bytes = Buffer.from(next), original = previous === null ? null : Buffer.from(previous);
    operations.push({ scope, root, path: validatePatchPath(relative), bytes, original, mode: 0o640, originalMode: original ? 0o640 : null, sha256: sha(bytes), previousSha256: original ? sha(original) : null });
  }
  return { directory, operations };
}
const readOperation = item => fs.readFile(path.join(item.root, item.path), 'utf8');
async function assertNoTemporaries(directory) {
  assert.deepEqual((await fs.readdir(directory, { recursive: true })).filter(name => /\.blackice-ui-.*\.tmp$/.test(name)), []);
}

test('a verification failure rolls back changed source and installed files before checking the restored state', async t => {
  const { directory, operations } = await transactionFixture(t, [['source', 'lib/value.mjs', 'source before', 'new bytes'], ['installed', 'lib/value.mjs', 'installed before', 'new bytes']]);
  let rollbackVerified = false;
  await assert.rejects(commitOperations(operations, {
    verify: async () => { assert.deepEqual(await Promise.all(operations.map(readOperation)), ['new bytes', 'new bytes']); throw Error('Injected verification failure'); },
    verifyRollback: async () => { assert.deepEqual(await Promise.all(operations.map(readOperation)), ['source before', 'installed before']); rollbackVerified = true; },
  }), error => {
    assert.equal(error.message, 'Injected verification failure');
    assert.deepEqual(error.rollback, { attempted: true, complete: true, filesChangedBeforeFailure: 2, errors: [] });
    return true;
  });
  assert.equal(rollbackVerified, true);
  await assertNoTemporaries(directory);
});

test('a conflicting later edit is preserved while other changed files are rolled back', async t => {
  const { directory, operations } = await transactionFixture(t, [['source', 'lib/value.mjs', 'source before', 'new bytes'], ['installed', 'lib/value.mjs', 'installed before', 'new bytes']]);
  await assert.rejects(commitOperations(operations, {
    verify: async () => { await fs.writeFile(path.join(operations[0].root, operations[0].path), 'independent later edit'); throw Error('Injected later failure'); },
  }), error => {
    assert.equal(error.rollback.complete, false);
    assert.equal(error.rollback.filesChangedBeforeFailure, 2);
    assert.equal(error.rollback.errors.length, 1);
    assert.deepEqual({ scope: error.rollback.errors[0].scope, path: error.rollback.errors[0].path }, { scope: 'source', path: 'lib/value.mjs' });
    assert.match(error.rollback.errors[0].error, /later edits were preserved/);
    return true;
  });
  assert.deepEqual(await Promise.all(operations.map(readOperation)), ['independent later edit', 'installed before']);
  await assertNoTemporaries(directory);
});

test('an original changed before its operation is never overwritten and earlier writes roll back', async t => {
  const { operations } = await transactionFixture(t, [['source', 'lib/first.mjs', 'first before', 'first after'], ['source', 'lib/second.mjs', 'second before', 'second after']]);
  await fs.writeFile(path.join(operations[1].root, operations[1].path), 'concurrent original edit');
  await assert.rejects(commitOperations(operations, { verify: async () => assert.fail('Verification must not run after a precondition conflict') }), error => {
    assert.match(error.message, /An application file changed/);
    assert.equal(error.rollback.complete, true);
    assert.equal(error.rollback.filesChangedBeforeFailure, 1);
    return true;
  });
  assert.deepEqual(await Promise.all(operations.map(readOperation)), ['first before', 'concurrent original edit']);
});

test('rollback removes new files and only the directories created for those files', async t => {
  const { directory, operations } = await transactionFixture(t, [['source', 'lib/new/nested/value.mjs', null, 'new source'], ['installed', 'lib/new/nested/value.mjs', null, 'new installed']]);
  await fs.mkdir(path.join(operations[0].root, 'lib'), { recursive: true });
  await fs.writeFile(path.join(operations[0].root, 'lib/keep.mjs'), 'preexisting neighbor');
  await assert.rejects(commitOperations(operations, { verify: async () => { throw Error('Reject new files'); } }), error => error.rollback.complete === true);
  assert.equal(await fs.readFile(path.join(operations[0].root, 'lib/keep.mjs'), 'utf8'), 'preexisting neighbor');
  await assert.rejects(fs.lstat(path.join(operations[0].root, 'lib/new')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(operations[1].root, 'lib')), { code: 'ENOENT' });
  await assertNoTemporaries(directory);
});

test('a successful transaction retains both replacements and checks native closure before and after verification', async t => {
  const { directory, operations } = await transactionFixture(t, [['source', 'server.mjs', 'before', 'after'], ['installed', 'server.mjs', 'before', 'after']]);
  const calls = [];
  await commitOperations(operations, { assertClosed: () => calls.push('closed'), verify: async () => { calls.push('verify'); assert.deepEqual(await Promise.all(operations.map(readOperation)), ['after', 'after']); } });
  assert.deepEqual(calls, ['closed', 'verify', 'closed']);
  assert.deepEqual(await Promise.all(operations.map(readOperation)), ['after', 'after']);
  await assertNoTemporaries(directory);
});

test('patch paths reject profile, traversal, reserved Windows, generated and non-source destinations', () => {
  for (const relative of ['../outside.mjs', 'lib/../../outside.mjs', '/lib/value.mjs', 'C:/lib/value.mjs', 'lib\\value.mjs', 'lib//value.mjs', 'lib/CON.txt', 'public/com1.js', 'lib/nul', 'lib/value.', 'lib/data/value.mjs', 'public/WORKSPACE/value.js', 'node_modules/value.js', 'lib/value.tmp', 'lib/value.currents-backup-1.mjs', 'secrets.json']) {
    assert.throws(() => validatePatchPath(relative), { name: 'Error' }, relative);
  }
  for (const relative of ['package.json', 'lib/agent-email.mjs', 'public/email-ui.mjs', 'tests/install-background-update.test.mjs', 'scripts/install-background-update.mjs']) assert.equal(validatePatchPath(relative), relative);
});

const UI_SOURCES = ['public/icon-symbols.mjs','lib/harness-identity.mjs', 'public/planning-mode.mjs', 'public/task-plan-map.mjs', 'public/task-plan.css', 'public/blackice-material.css', 'public/assets/blackice-field.svg', 'public/assets/blackice-wordmark.svg', 'server.mjs', 'lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/cron.mjs', 'lib/projects.mjs', 'lib/subagents.mjs', 'lib/agent-email.mjs', 'public/app.js', 'public/index.html', 'public/workspace-integrations.mjs', 'public/mission-ui.mjs', 'public/task-plan-ui.mjs', 'public/advanced-ui.mjs', 'public/email-ui.mjs', 'public/email.css', 'scripts/revised-workspace-ui-qa.mjs'];
const BROWSER_SOURCES = ['desktop/browser-driver.mjs', 'desktop/browser-capture.mjs', 'desktop/browser-router.mjs', 'lib/browser.mjs', 'tests/browser-auth.integration.test.mjs', 'tests/browser-lazy.integration.test.mjs', 'tests/fixtures/browser-auth-live.mjs', 'tests/fixtures/browser-lazy-live.mjs', 'scripts/verify-contained-browser.mjs'];
const EMAIL_SOURCES = ['lib/agent-email.mjs', 'lib/email-tools.mjs', 'scripts/verify-email-cli.mjs'];
const NATIVE_SOURCES = ['lib/planning-policy.mjs','lib/harness-identity.mjs','public/planning-mode.mjs','lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/methods.mjs', 'lib/process-ontology.mjs', 'lib/tool-routing.mjs', 'lib/codex.mjs', 'public/mission-model.mjs', 'scripts/verify-task-plan-runtime.mjs'];
const OPTIONAL_SKIPS = ['Relay-owned sign-in and local storage survive a full process restart without foregrounding', 'restored hidden browser tabs defer requests until used and never load closed or replaced pages', 'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart', 'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched'];
const EMAIL_CHECKS = ['configuration_has_no_process_or_account_side_effect', 'installed_cli_version_and_help', 'real_maildir_list', 'real_maildir_search_with_single_argv_query', 'real_maildir_raw_json_read', 'read_preserves_message_flags', 'local_unsent_draft_persistence'];

// Synthetic unit data for acceptance validation. This is never live QA evidence.
function evidenceFixture() {
  const candidate = path.resolve('unit-only-candidate'), work = path.dirname(candidate), fingerprint = sha('unit-only-runtime');
  const sourceFiles = Object.fromEntries([...new Set([...UI_SOURCES, ...BROWSER_SOURCES, ...EMAIL_SOURCES, ...NATIVE_SOURCES, 'scripts/revised-workspace-ui-qa.mjs', 'scripts/install-background-update.mjs', 'tests/install-background-update.test.mjs'])].map(file => [file, sha(file)]));
  const subset = names => Object.fromEntries(names.map(name => [name, sourceFiles[name]]));
  const skips = OPTIONAL_SKIPS.map((name, index) => `ok ${index + 1} - ${name} # SKIP opt-in fixture`);
  const tap = [...skips, '# tests 2506', '# pass 2502', '# fail 0', '# cancelled 0', '# skipped 4', ''].join('\n');
  const browserTap = [`ok 1 - ${OPTIONAL_SKIPS[0]}`, `ok 2 - ${OPTIONAL_SKIPS[1]}`, '# tests 2', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', ''].join('\n');
  const regression = { format: 1, product: 'BLACKICE', version: '2.25.0', platform: 'win32', passed: true, exitCode: 0, unchanged: true, appFingerprintBefore: fingerprint, appFingerprintAfter: fingerprint, candidate, sourceHashesBefore: { ...sourceFiles }, sourceHashesAfter: { ...sourceFiles }, testFiles: Object.keys(sourceFiles).filter(file => /^tests\/[^/]+\.test\.mjs$/.test(file)).length, tests: { total: 2506, passed: 2502, failed: 0, cancelled: 0, skipped: 4 }, skips, logSha256: sha(tap) };
  const checks = ['The task pane appears before the answer', 'Stop stays available while a direction request is pending', 'Only acknowledged cancellation is marked stopped and its execution slot is released', ...Array.from({ length: 37 }, (_, index) => `Synthetic UI check ${index + 1}`)];
  const ui = { ok: true, version: '2.25.0', platform: 'win32', candidate, appFingerprintBefore: fingerprint, appFingerprintAfter: fingerprint, unchangedDuringChecks: true, serverClosed: true, disposableStateRemoved: true, checks, passed: checks.length, pageErrors: [], emailCliCalls: [], runtimeCalls: Array.from({length: 4}, () => ({externalRequests: 0, harnessIdentified: true})), cancellation: { directionRequests: 1, cancellationObserved: 1, pendingStatus: 'Stopping… Waiting for active work to finish.', settledStatus: 'Stopped', settled: true, status: 'cancelled' }, before: subset(UI_SOURCES), after: subset(UI_SOURCES) };
  ui.planning = { choices: ['maximal','on','auto','off'], descriptions: Object.fromEntries(['maximal','on','auto','off'].map(mode => [mode, 'Synthetic unit-only description for ' + mode])), plannedMode: 'on', offMode: 'off', offCompleted: true, offToolCalls: 0, offFinalVisible: true };
  ui.mindMap = { savedNodeIds: ['inspect','save'], dependenciesVisible: true, sharedNotesVisible: true, focusPreservesTree: true, zoomChangesViewport: true, keyboardSelection: true, hoverPreservesPosition: true, readingTitlePx: 11.7, internallyScrollable: true };
  ui.visual = { vectorAssets: ['blackice-field.svg','blackice-wordmark.svg'].map(name => ({name, served: true, vectorOnly: true})), sceneUsesSvg: true, gradientSurfaceCount: 6, repeatedSceneInReadingPanels: false };
  const browser = { passed: true, platform: 'win32', suite: 'contained-browser', candidate, exitCode: 0, unchanged: true, actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, tests: { total: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0 }, logSha256: sha(browserTap), before: subset(BROWSER_SOURCES), after: subset(BROWSER_SOURCES) };
  const email = { passed: true, platform: 'win32', candidateVersion: '2.25.0', offlineFixture: true, actualUserAccountAccessed: false, sent: false, cliVersion: '2.2.1', sourceUnchanged: true, checks: [...EMAIL_CHECKS], sourceHashesBefore: subset(EMAIL_SOURCES), sourceHashesAfter: subset(EMAIL_SOURCES), executable: { path: path.resolve('unit-only-himalaya.exe'), sha256Before: sha('unit-only-cli'), sha256After: sha('unit-only-cli'), version: '2.2.1' }, executableUnchanged: true };
  const expected = { model: 'unit-only-model', tokens: ['actual-alpha', 'actual-beta'] }, artifact = { decision: 'combined', currency: 'USD', total: 42, sourceTokens: ['actual-beta', 'actual-alpha'] };
  const artifactText = JSON.stringify(artifact), artifactSha256 = sha(artifactText), taskSchemaSha256 = sha(JSON.stringify(TASK_TOOL));
  const tool = (name, action, file) => ({ name, arguments: { action, ...(file ? { path: file } : {}), ...(action === 'write' ? { text: artifactText } : {}) }, success: true });
  const calls = [{ model: expected.model, resolvedModel: expected.model, finishedAt: '2026-10-19T00:00:01Z', taskToolSchemaSha256: taskSchemaSha256, toolCalls: [tool('relay_task', 'plan'), tool('relay_workspace', 'read', 'alpha.json'), tool('relay_workspace', 'read', 'beta.json'), tool('relay_workspace', 'write', 'result.json'), tool('relay_workspace', 'read', 'result.json'), tool('relay_task', 'artifact', 'result.json')] }];
  const run = { id: 'unit-only-run', status: 'completed', settled: true, nodes: { agent: { taskSchemaVersion: TASK_SCHEMA_VERSION, planning: { status: 'recorded' } } }, taskState: { planVersion: 1, plan: { origin: 'agent', authoredBy: { runId: 'unit-only-run' } }, progress: { complete: true }, steps: [{ id: 'collect', kind: 'parallel' }, ...['first', 'second', 'check'].map(id => ({ id, kind: 'action', parentId: 'collect', status: 'done', doneWhen: 'The source and result match.', evidence: 'Observed the matching file fields.' }))], artifacts: [{ fileName: 'result.json', sha256: artifactSha256 }] } };
  const native = { format: 1, product: 'BLACKICE', version: '2.25.0', platform: 'win32', live: true, passed: true, appFingerprintBefore: fingerprint, appFingerprintAfter: fingerprint, unchangedDuringCheck: true, modelRuntimeClosed: true, fixtureRemoved: true, calls, nativeTools: [], denied: [], sourceDirectory: candidate, outputDirectory: path.join(work, 'qa-native-plan-root'), expected, requestedModel: expected.model, runId: run.id, timeoutMs: 30000, startedAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:00:01Z', runtimeSources: subset(NATIVE_SOURCES), taskSchemaSha256, run, rootBeforeModel: true, artifact, artifactSha256 };
  native.checks = { ...assessPlanAcceptance(native).checks, exactArtifactHash: true, exactSchema: true };
  return { regression, tap, ui, browser, browserTap, email, native, fingerprint, sourceFiles, candidate, work };
}

test('revised evidence accepts a coherent bound unit fixture and reassesses its native plan', () => {
  const result = validateBackgroundEvidence(evidenceFixture());
  assert.equal(result.containedBrowserTests, 2);
  assert.equal(result.emailChecks, 7);
  assert.equal(result.uiChecks, 40);
  assert.equal(result.nativePlan.checks, 16);
});

test('revised evidence rejects missing regression coverage, changed source hashes and unexpected skips', () => {
  for (const mutate of [
    value => { value.regression.testFiles--; },
    value => { value.regression.sourceHashesAfter['lib/engine.mjs'] = sha('later source'); },
    value => { value.tap = value.tap.replace(OPTIONAL_SKIPS[0], 'Unapproved optional feature'); value.regression.logSha256 = sha(value.tap); value.regression.skips = value.tap.split('\n').filter(line => /# SKIP/.test(line)); },
    value => { value.tap = value.tap.replace('# pass 2502', '# pass 2501'); value.regression.logSha256 = sha(value.tap); },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateBackgroundEvidence(fixture)); }
});

test('revised evidence rejects visible or external fixture work, unmet plan UI and incomplete cleanup', () => {
  for (const mutate of [
    value => { value.ui.checks[0] = 'No plan contract'; },
    value => { value.ui.runtimeCalls[0].externalRequests = 1; },
    value => { value.ui.disposableStateRemoved = false; },
    value => { value.browser.actualUserBrowserAccessed = true; },
    value => { value.browser.tests.skipped = 1; },
    value => { value.email.actualUserAccountAccessed = true; },
    value => { value.email.sent = true; },
    value => { value.native.fixtureRemoved = false; },
    value => { value.native.run.taskState.progress.complete = false; },
    value => { value.native.calls[0].toolCalls.find(call => call.arguments.action === 'write').arguments.text = '{}'; },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateBackgroundEvidence(fixture)); }
});

test('UI acceptance requires the pending direction cancellation journey and actual settlement', () => {
  for (const mutate of [
    value => { delete value.ui.cancellation; },
    value => { value.ui.cancellation.directionRequests = 0; },
    value => { value.ui.cancellation.cancellationObserved = 0; },
    value => { value.ui.cancellation.settled = false; },
    value => { value.ui.cancellation.status = 'completed'; },
    value => { value.ui.cancellation.pendingStatus = 'Stopped'; },
    value => { value.ui.cancellation.settledStatus = 'Stopping…'; },
    value => { value.ui.checks[1] = 'An unrelated control check'; },
    value => { value.ui.checks[2] = 'An unrelated status check'; },
    value => { value.ui.runtimeCalls.pop(); },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateBackgroundEvidence(fixture), /UI|cancellation/); }
});

test('contained-browser TAP cannot contradict the report with a skipped or failing real fixture', () => {
  for (const counts of [{ passed: 1, failed: 0, skipped: 1 }, { passed: 1, failed: 1, skipped: 0 }]) {
    const fixture = evidenceFixture();
    fixture.browserTap = [`ok 1 - ${OPTIONAL_SKIPS[0]}`, counts.failed ? `not ok 2 - ${OPTIONAL_SKIPS[1]}` : `ok 2 - ${OPTIONAL_SKIPS[1]} # SKIP disabled`, '# tests 2', `# pass ${counts.passed}`, `# fail ${counts.failed}`, '# cancelled 0', `# skipped ${counts.skipped}`, ''].join('\n');
    fixture.browser.logSha256 = sha(fixture.browserTap);
    assert.throws(() => validateBackgroundEvidence(fixture), /browser|TAP/i);
  }
});

test('UI and contained-browser evidence cannot replace a required helper binding with unrelated candidate bytes', () => {
  for (const [receipt, missing] of [['ui', 'scripts/revised-workspace-ui-qa.mjs'], ['browser', 'desktop/browser-driver.mjs'], ['browser', 'scripts/verify-contained-browser.mjs']]) {
    const fixture = evidenceFixture();
    for (const map of ['before', 'after']) {
      delete fixture[receipt][map][missing];
      fixture[receipt][map]['scripts/install-background-update.mjs'] = fixture.sourceFiles['scripts/install-background-update.mjs'];
    }
    assert.throws(() => validateBackgroundEvidence(fixture), /source|binding/i);
  }
});

test('installed CLI evidence requires every distinct check and unchanged executable bytes', () => {
  for (const mutate of [
    value => { value.email.checks.fill('installed_cli_version_and_help'); },
    value => { value.email.executableUnchanged = false; value.email.executable.sha256After = sha('different executable'); },
    value => { value.email.error = { message: 'The proof failed after recording checks' }; },
  ]) { const fixture = evidenceFixture(); mutate(fixture); assert.throws(() => validateBackgroundEvidence(fixture), /email|CLI|Maildir/i); }
});

test('visual-planning acceptance rejects missing or contradictory mode, map, vector and harness observations', () => {
  for (const mutate of [
    value => { delete value.ui.planning; },
    value => { value.ui.planning.choices = ['on', 'off']; },
    value => { value.ui.planning.offMode = 'auto'; },
    value => { value.ui.planning.offCompleted = false; },
    value => { value.ui.planning.offToolCalls = 1; },
    value => { value.ui.planning.offFinalVisible = false; },
    value => { delete value.ui.mindMap; },
    value => { value.ui.mindMap.savedNodeIds = ['invented']; },
    value => { value.ui.mindMap.sharedNotesVisible = false; },
    value => { value.ui.mindMap.focusPreservesTree = false; },
    value => { value.ui.mindMap.keyboardSelection = false; },
    value => { value.ui.mindMap.hoverPreservesPosition = false; },
    value => { value.ui.mindMap.readingTitlePx = 4; },
    value => { value.ui.mindMap.internallyScrollable = false; },
    value => { delete value.ui.visual; },
    value => { value.ui.visual.vectorAssets[0].vectorOnly = false; },
    value => { value.ui.visual.vectorAssets[1].served = false; },
    value => { value.ui.visual.gradientSurfaceCount = 0; },
    value => { value.ui.visual.repeatedSceneInReadingPanels = true; },
    value => { value.ui.runtimeCalls[0].harnessIdentified = false; },
  ]) {
    const fixture = evidenceFixture(); mutate(fixture);
    assert.throws(() => validateBackgroundEvidence(fixture), /UI|mode|mind map|SVG|surfaces|fixtures/i);
  }
});
