/** Release-specific evidence gates for shared editing and OAuth email. Older
 * release validators retain their own versions and acceptance requirements. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AWARENESS_VERSION, AWARENESS_PREVIOUS_VERSION, AWARENESS_BASELINE_SHA256 } from './prepare-awareness-candidate.mjs';
import { validateChatLayoutEvidence, validateWorkflowImprovementEvidence } from './install-planning-update.mjs';


// Historical 2.30 receipts keep their original gate. This pure predicate does
// not load or enable the retired browser provider or its deleted UI journey.
function measuredChatModePicker(value) {
  return Boolean(value?.fixtureOnly === true && value.liveCompletionVerified === false && value.route === 'chatgpt::chat-mode' && value.catalogAvailable === false && value.finalState === 'schema-unverified' && value.experimentalVisible === true && value.unavailableVisible === true && value.noFallback === true && value.savedSelection === value.route && value.selectionAfterReload === value.route && value.reasoningDisabled === true && value.reasoningValue === 'default' && value.draftPreserved === true && value.setupDraftPreserved === true && value.setupSelectionPreserved === true && value.refreshSearchPreserved === true && value.exactTab === value.setupTab && value.exactTab === 'qa-owned-chat-mode-tab' && value.setupCaptures?.length > 0 && value.setupCaptures.every(tabId => tabId === value.exactTab) && value.historicalFixture === true && value.historicalRoute === value.route && value.routeAfterNextReplyChange === value.route && value.nextReplyModel === 'fixture-model' && value.mobile?.width === 320 && value.mobile.fits === true && value.mobile.experimentalVisible === true && value.mobile.actionsReachable === true && value.externalRequestCount === 0 && value.turnsBefore === 6 && value.turnsAfter === 6 && value.historyRecordsAdded === 1 && JSON.stringify(value.connectionActions) === JSON.stringify(['setup', 'refresh']));
}

const SHA256 = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const invariant = (condition, message) => { if (!condition) throw Error(message); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sameDirectory = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

export const EMAIL_UI_INTERFACE_COMMANDS = Object.freeze([
  '--version', 'gmail --help', 'envelope list --help', 'message read --help', 'envelope search --help',
]);

export function requireAwarenessSources(actual, expected, label, subset) {
  const keys = subset || Object.keys(expected);
  invariant(object(actual) && Object.keys(actual).length === keys.length && keys.every(key => SHA256.test(expected[key] || '') && actual[key] === expected[key]), label + ' differs from the exact candidate source files.');
}

export const OPTIONAL_REGRESSION_CASES = Object.freeze([
  'Relay-owned sign-in and local storage survive a full process restart without foregrounding',
  'restored hidden browser tabs defer requests until used and never load closed or replaced pages',
  'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart',
  'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched',
]);

export const REQUIRED_AWARENESS_TEST_FILES = Object.freeze([
  'tests/planning-awareness.test.mjs', 'tests/planning-awareness-engine.test.mjs', 'tests/planning-awareness-http.test.mjs', 'tests/planning-awareness-ui.test.mjs',
  'tests/planning-delegation.test.mjs', 'tests/planning-swarm-engine.test.mjs', 'tests/remote-access-gateway.test.mjs', 'tests/remote-agent-api.test.mjs',
  'tests/email-oauth.test.mjs', 'tests/email-oauth-ui.test.mjs', 'tests/email-http.test.mjs', 'tests/agent-email.test.mjs', 'tests/awareness-update.test.mjs',
  'tests/remote-access-cli.test.mjs', 'tests/remote-access-pairing.test.mjs', 'tests/clipboard.test.mjs', 'tests/desktop-clipboard.test.mjs',
  'tests/webmcp-client.test.mjs', 'tests/desktop-chat-mode.test.mjs', 'tests/chat-mode-http.test.mjs',
  'tests/chat-mode-runtime.test.mjs', 'tests/chat-mode-providers.test.mjs', 'tests/remote-access-native-qa.test.mjs',
  'tests/model-routes.test.mjs',
]);

export function validateAwarenessRegression(regression, tap, { fingerprint, sourceFiles, candidate }) {
  invariant(regression?.format === 1 && regression.product === 'BLACKICE' && regression.version === AWARENESS_VERSION && regression.platform === 'win32' && regression.passed === true && regression.exitCode === 0 && regression.timedOut === false && !regression.error && !regression.runnerError && regression.unchanged === true && regression.appFingerprintBefore === fingerprint && regression.appFingerprintAfter === fingerprint && sameDirectory(regression.candidate, candidate), 'Require successful full Windows regression on this exact candidate.');
  requireAwarenessSources(regression.sourceHashesBefore, sourceFiles, 'Regression source inventory before');
  requireAwarenessSources(regression.sourceHashesAfter, sourceFiles, 'Regression source inventory after');
  const testFiles = Object.keys(sourceFiles).filter(file => /^tests\/.+\.test\.mjs$/.test(file)).sort();
  invariant(testFiles.length > 0 && same(regression.testFileList, testFiles) && regression.testFiles === testFiles.length && same(regression.testArguments, ['--test', '--test-concurrency=4', '--test-timeout=60000', '--test-reporter=tap', ...testFiles]), 'Regression must run and record the complete actual test-file list without filtering.');
  invariant(REQUIRED_AWARENESS_TEST_FILES.every(file => testFiles.includes(file)), 'The complete regression lacks a required shared-editing or email test file.');
  const count = name => { const values = [...tap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
  const counts = { total: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
  invariant(same(counts, regression.tests) && Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0) && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0 && counts.total === counts.passed + counts.skipped && regression.logSha256 === sha(Buffer.from(tap)) && Array.isArray(regression.failures) && regression.failures.length === 0 && !/^not ok\b/m.test(tap), 'The successful regression counts or TAP bytes are inconsistent.');
  const skipped = tap.split(/\r?\n/).filter(line => /# SKIP\b/.test(line));
  const names = skipped.map(line => line.replace(/^\s*ok\s+\d+\s+-\s+/, '').replace(/\s+# SKIP\b.*$/, ''));
  invariant(same(skipped, regression.skips) && counts.skipped === skipped.length && new Set(names).size === names.length && names.every(name => OPTIONAL_REGRESSION_CASES.includes(name)), 'Only the reviewed optional native browser and desktop integration cases may be skipped.');
  return { ...counts, testFiles: testFiles.length, completeTestFileList: true };
}

export function validateAwarenessNative(receipt, { name, requiredChecks, requiredSources, fingerprint, sourceFiles, candidate }) {
  invariant(Array.isArray(requiredChecks) && requiredChecks.length > 0 && new Set(requiredChecks).size === requiredChecks.length, 'Require the reviewed ' + name + ' scenario inventory.');
  invariant(receipt?.passed === true && receipt.version === AWARENESS_VERSION && receipt.platform === 'win32' && sameDirectory(receipt.candidate, candidate) && receipt.appFingerprintBefore === fingerprint && receipt.appFingerprintAfter === fingerprint && receipt.unchangedDuringChecks === true, 'Require successful ' + name + ' acceptance on this exact Windows candidate.');
  invariant(Array.isArray(receipt.errors) && receipt.errors.length === 0 && !receipt.error && !receipt.cleanupError && !receipt.cleanupErrors?.length && receipt.cleanup === true && receipt.forcedCleanup === false && receipt.providerTurnsRequested === 0, 'The ' + name + ' acceptance requires clean owned-state cleanup and no provider turn.');
  invariant(Array.isArray(receipt.checks) && receipt.checks.length === requiredChecks.length && receipt.checks.every((entry, index) => entry?.name === requiredChecks[index] && entry.passed === true), 'The ' + name + ' acceptance lacks a required observed scenario.');
  requireAwarenessSources(receipt.sourceHashesBefore, sourceFiles, name + ' source inventory before');
  requireAwarenessSources(receipt.sourceHashesAfter, sourceFiles, name + ' source inventory after');
  invariant(Array.isArray(requiredSources) && requiredSources.length > 0 && requiredSources.every(file => SHA256.test(sourceFiles[file] || '')), 'The candidate lacks an owned ' + name + ' acceptance input.');
  return { passed: true, checks: requiredChecks.length, sourceFiles: Object.keys(sourceFiles).length, unchangedDuringChecks: true, cleanup: true, providerTurnsRequested: 0 };
}

export function validateAwarenessUI(ui, { fingerprint, sourceFiles, candidate, requiredFeatures, uiSources }) {
  invariant(ui?.ok === true && ui.version === AWARENESS_VERSION && ui.platform === 'win32' && sameDirectory(ui.candidate, candidate) && ui.appFingerprintBefore === fingerprint && ui.appFingerprintAfter === fingerprint && ui.unchangedDuringChecks === true && ui.serverClosed === true && ui.disposableStateRemoved === true && !ui.error && !ui.cleanupError && !ui.cleanupErrors?.length && Array.isArray(ui.checks) && ui.checks.length > 0 && ui.passed === ui.checks.length && new Set(ui.checks).size === ui.checks.length && Array.isArray(ui.pageErrors) && ui.pageErrors.length === 0 && Array.isArray(ui.runtimeCalls) && ui.runtimeCalls.length > 0 && ui.runtimeCalls.every(call => call.externalRequests === 0 && call.harnessIdentified === true), 'Require the completed rendered UI journeys on this exact candidate with clean local fixtures.');
  invariant(Array.isArray(requiredFeatures) && requiredFeatures.length > 0 && object(ui.features) && requiredFeatures.every(name => ui.features[name] === true), 'A required rendered UI feature has not passed.');
  for (const name of ['planningEditingPresence', 'planningWorkerReview', 'planningAwarenessMobile', 'emailOAuthSignIn', 'emailOAuthDraftSafety', 'emailOAuthMobile', 'clipboardRecovery', 'chatModePicker']) invariant(requiredFeatures.includes(name) && ui.features[name] === true, 'The rendered UI lacks the new release scenario: ' + name);
  requireAwarenessSources(ui.before, sourceFiles, 'UI source bindings before', uiSources);
  requireAwarenessSources(ui.after, sourceFiles, 'UI source bindings after', uiSources);
  const awareness = ui.recovery?.planningAwareness;
  invariant(awareness?.modelTurnsAdded === 0 && awareness.presence?.draftTextSent === false && awareness.presence.observedByTaskRead === true && awareness.presence.advisoryOperationSucceeded === true && awareness.draftIdentity?.sameField === true && awareness.draftIdentity.sameSave === true && awareness.draftIdentity.focused === true && same(awareness.draftIdentity.selection, [4, 13, 'backward']), 'Rendered editing presence must retain the actual focused draft and remain advisory.');
  invariant(Number.isSafeInteger(awareness.beforeRevision) && awareness.saved?.revision > awareness.beforeRevision && awareness.saved.affected?.pendingRevision === awareness.saved.revision && awareness.saved.affected.state === 'needs-review' && awareness.saved.independent?.lastReadRevision === awareness.beforeRevision && awareness.saved.independent.pendingRevision === null && awareness.saved.independent.state === 'current' && awareness.saved.rejectedCode === 'TASK_PLAN_REVIEW_REQUIRED' && awareness.saved.rejectedActionExecuted === false && awareness.saved.independentReadSucceeded === true && awareness.after?.deliveredRevision === awareness.saved.revision && awareness.after.affectedWorkerReadsExecuted === 2 && awareness.after.independentWorkerReadsExecuted === 1 && awareness.after.nativeModelTurns === 0, 'Rendered review must match actual gated actions, independent work and a real task read.');
  const mobile = awareness.mobile;
  invariant(mobile?.width === 320 && mobile.visiblePanes === 1 && mobile.panelScrollWidth <= mobile.panelWidth + 2 && mobile.awareness?.left >= -1 && mobile.awareness.right <= 321 && mobile.releasedOnHide === true && mobile.draftPreserved === true && mobile.reopeningDidNotAdvertise === true && Array.isArray(mobile.fields) && mobile.fields.length > 0 && mobile.fields.every(field => field.left >= -1 && field.right <= 321 && field.width >= 60 && field.fontSize >= 11), 'The 320px shared editor lacks measured layout and draft/presence preservation.');
  const email = ui.recovery?.emailOAuth;
  invariant(email?.fixtureConsent === true && email.externalRequests === 0 && email.mailboxReads === 0 && email.localImport === true && email.conflictPreserved === true && email.composePreserved === true && email.identityVerified === true && email.pkceVerified === true && email.credentialsProtected === true && email.cliInterfaceChecks === EMAIL_UI_INTERFACE_COMMANDS.length && Array.isArray(ui.emailCliCalls) && ui.emailCliCalls.length === EMAIL_UI_INTERFACE_COMMANDS.length && ui.emailCliCalls.every((call, index) => call.fixtureOnly === true && Array.isArray(call.args) && same(call.args, EMAIL_UI_INTERFACE_COMMANDS[index].split(' '))), 'Email UI must preserve drafts and account identity through fixture consent, with only the reviewed controlled interface checks.');
  invariant(Array.isArray(email.dropdown) && email.dropdown.length > 0 && email.dropdown.every(item => typeof item.colorScheme === 'string' && item.colorScheme.split(/\s+/).includes('dark') && item.backgroundAlpha === 1 && item.foregroundAlpha === 1 && item.backgroundLuminance < .15 && item.contrast >= 4.5) && email.popup?.captured === true && email.mobile?.width === 320 && email.mobile.paneScrollWidth <= email.mobile.paneClientWidth + 2 && Array.isArray(email.mobile.fields) && email.mobile.fields.length > 0 && email.mobile.fields.every(field => field.left >= -1 && field.right <= 321 && field.width > 0 && field.fontSize >= 12), 'Email OAuth requires measured readable dark dropdowns and a fitting 320px layout.');
  const clipboard = ui.recovery?.clipboard;
  invariant(clipboard?.fixtureOnly === true && clipboard.osClipboardTouched === false && clipboard.permissionChanges === false && clipboard.noPrematureSuccess === true && clipboard.mobileFits === true, 'Clipboard recovery requires measured fixture-only denial and pending-write behavior.');
  for (const name of ['denied', 'retry']) invariant(clipboard[name]?.sourceRetained === true && clipboard[name].readonlySource === true && clipboard[name].agentDraftRetained === true && clipboard[name].scopeRetained === true && clipboard[name].temporaryFieldsRemoved === true && clipboard[name].reads === 0 && clipboard[name].unexpected === 0, 'Clipboard recovery must preserve the exact source and unsent access draft.');
  invariant(same(clipboard.denied.events.map(event => [event.method, event.exact, event.accepted]), [['selection', true, false], ['clipboard', true, false]]) && same(clipboard.retry.events.map(event => [event.method, event.exact, event.accepted]), [['selection', true, false], ['clipboard', true, false], ['selection', true, false], ['clipboard', true, true]]), 'Clipboard recovery requires the observed denied write followed by one completed retry.');
  for (const name of ['selection', 'chat']) invariant(clipboard[name]?.reads === 0 && clipboard[name].unexpected === 0 && clipboard[name].temporaryFields === 0 && same(clipboard[name].events?.at(-1), { method: 'selection', exact: true, selectionValid: true, accepted: true }), 'The shared Copy path must complete its exact selection write without reading the clipboard.');
  invariant(['inputPreserved', 'draftPreserved', 'selectionPreserved', 'scrollPreserved', 'copyButtonFocused'].every(name => clipboard.chat[name] === true) && clipboard.chat.nativeCopyEvents === 0, 'Main-chat Copy must preserve the real unsent draft, caret and scroll.');
  invariant(measuredChatModePicker(ui.recovery?.chatMode), 'Experimental Chat Mode needs the measured main-picker, exact-tab, saved-draft and recorded-route journeys without a real provider request.');
  return { checks: ui.checks.length, features: Object.fromEntries(requiredFeatures.map(name => [name, true])), measuredPlanningAwareness: true, measuredEmailOAuth: true, measuredClipboardRecovery: true, measuredChatModePicker: true, chatLayout: validateChatLayoutEvidence(ui), workflowImprovement: validateWorkflowImprovementEvidence(ui), providerTurnsRequested: 0, emailFixtureInterfaceCalls: ui.emailCliCalls.length, actualEmailProcesses: 0 };
}

/** These receipts describe a separately reviewed normal native close, and are
 * admitted only at commit after the prepared plan hash has been chosen. */
export function validateAwarenessClosure(idle, closure, { planSha256, idleSha256, installed, at = Date.now() }) {
  for (const [name, receipt] of [['idle', idle], ['close', closure]]) {
    invariant(receipt?.format === 1 && receipt.product === 'BLACKICE' && receipt.version === AWARENESS_PREVIOUS_VERSION && receipt.targetVersion === AWARENESS_VERSION && receipt.platform === 'win32' && receipt.baselineSha256 === AWARENESS_BASELINE_SHA256 && receipt.planSha256 === planSha256 && receipt.providerTurnsRequested === 0 && receipt.routesMutated === false && Array.isArray(receipt.errors) && receipt.errors.length === 0, 'The native ' + name + ' receipt does not belong to this reviewed update plan.');
    invariant(Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.parse(receipt.verifiedAt) <= at && at - Date.parse(receipt.verifiedAt) <= 10 * 60 * 1000, 'Use fresh native idle and close receipts for this installation attempt.');
  }
  const native = idle.exactNativeProcess;
  invariant(native && Number.isSafeInteger(native.pid) && native.pid > 0 && native.mainWindowHandle > 0 && sameDirectory(path.dirname(native.executable), path.resolve(installed, '../..')) && same(native, closure.exactNativeProcess), 'The idle and close receipts must identify the same exact installed native process.');
  invariant(idle.idle === true && idle.statusOk === true && idle.loopbackListenerOwned === true && Array.isArray(idle.samples) && idle.samples.length === 2 && idle.samples.every(sample => sample.idle === true && sample.version === AWARENESS_PREVIOUS_VERSION && sample.desktopApp === true && sample.activeTurns === 0 && sample.execution?.activeCount === 0 && Array.isArray(sample.execution.activeRunIds) && sample.execution.activeRunIds.length === 0 && sample.execution.settling === false && sample.execution.stopping === false && sample.learning?.activeReview === false && sample.learning.activeRun === false && sample.inbox?.active === 0 && sample.inbox.pending === 0 && sample.inbox.paused === true && sample.operations?.running === 0 && sample.operations.queued === 0 && sample.operations.paused === true && sample.projects?.running === 0 && sample.browser?.busy === false), 'Normal close requires two observed idle samples without pending or unpaused work.');
  const latest = Date.parse(idle.samples[1].observedAt), requested = Date.parse(closure.requestedAt);
  invariant(Number.isFinite(latest) && Number.isFinite(requested) && requested >= latest && requested - latest <= 2000 && Date.parse(closure.verifiedAt) >= requested && closure.idleReceiptSha256 === idleSha256 && closure.method === 'CloseMainWindow' && closure.closeRequested === true && closure.closeAccepted === true && closure.nativeExited === true && closure.exitCode === 0 && closure.graceful === true && closure.closed === true && closure.remainingInstalledProcesses === 0 && closure.loopbackListenerClosed === true && closure.runtimeMarkerRemoved === true && closure.forcedCleanup === false, 'Require acknowledged normal native shutdown and its exact idle receipt; forced or incomplete closure cannot admit installation.');
  return { normalClose: true, idle: true, pid: native.pid, planSha256, idleReceiptSha256: idleSha256 };
}
