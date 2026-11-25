import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const topLevelFiles = new Set(['package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'server.mjs', 'CHATGPT-CONNECTOR.md', 'REMOTE-ACCESS.md', 'RELEASE-NOTES.md']);
const check = (condition, message) => { if (!condition) throw new Error(message); };

// Match the existing installer inputs without admitting arbitrary native helpers.
const packagedNativeHelpers = new Set([
  'desktop/make-icon.ps1', 'desktop/native-window-host.cs', 'desktop/native-window-host.ps1',
  'desktop/installed-app-icons.cs', 'desktop/native-app-launcher.cs', 'desktop/native-foreground-guard.cs',
]);


// Public native CLI diagnostics contain only enumerated codes, never log text.
const nativeRestartErrorCodes = new Set([
  'ACCESS_HOST_PLATFORM', 'ACCESS_HOST_NOT_RUNNING', 'ACCESS_RUNTIME_INVALID', 'ACCESS_RUNTIME_OWNERSHIP',
  'BROWSER_CLI_PROFILE', 'BROWSER_CLI_SESSION', 'BROWSER_CLI_RUNTIME', 'BROWSER_CLI_UNREACHABLE',
  'BROWSER_CLI_UNCERTAIN', 'BROWSER_CLI_RESPONSE', 'BROWSER_CLI_REJECTED',
  'DESKTOP_RESTART_ARGUMENTS', 'DESKTOP_RESTART_CLI_FAILED', 'DESKTOP_RESTART_ACK_UNCERTAIN',
  'DESKTOP_RESTART_LEGACY_UNAVAILABLE', 'DESKTOP_RESTART_STORAGE_UNAVAILABLE', 'DESKTOP_RESTART_HISTORY_FULL',
  'DESKTOP_RESTART_BUSY', 'DESKTOP_RESTART_REQUEST_MISMATCH', 'DESKTOP_RESTART_CLOSING',
  'DESKTOP_RESTART_BROWSER_BUSY', 'DESKTOP_RESTART_BROWSER_STATE', 'DESKTOP_RESTART_STORAGE',
  'DESKTOP_RESTART_DRAIN_TIMEOUT', 'DESKTOP_RESTART_RELEASED', 'DESKTOP_RESTART_NOT_PREPARED',
  'DESKTOP_RESTART_CANCELLED', 'DESKTOP_RESTART_ORIGIN_INVALID', 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED',
  'DESKTOP_RESTART_ORIGIN_FAILED', 'DESKTOP_RESTART_RECEIPT_UNAVAILABLE', 'DESKTOP_RESTART_RECEIPT_TIMEOUT',
  'DESKTOP_RESTART_ACK_UNAVAILABLE', 'DESKTOP_RESTART_PREPARE_FAILED', 'DESKTOP_RESTART_RELEASE_FAILED',
  'DESKTOP_RESTART_LAUNCH_INVALID', 'DESKTOP_RESTART_ARM_FAILED', 'DESKTOP_RESTART_QUIT_UNCONFIRMED',
  'DESKTOP_RESTART_INTERRUPTED', 'DESKTOP_RESTART_MODE_CHANGED', 'DESKTOP_RESTART_UNAVAILABLE',
]);

/** Sanitize only the log segment written after one native restart invocation. */
export function nativeRestartCLIOutcome(log, exitCode) {
  const outcome = { exitCode: Number.isSafeInteger(exitCode) ? exitCode : null };
  if (outcome.exitCode === 0 || typeof log !== 'string') return outcome;
  for (const line of log.split(/\r?\n/)) {
    if (line.length > 65536) continue;
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const code = typeof value.error === 'string' ? value.code
      : value.protocol === 1 && value.acknowledged === true && ['failed', 'cancelled', 'interrupted'].includes(value.receipt?.status) ? value.receipt.error?.code : null;
    if (nativeRestartErrorCodes.has(code)) outcome.errorCode = code;
  }
  return outcome;
}

export function forbiddenWindowsPackagePath(relative) {
  return relative === 'desktop/build-icon.mjs' || relative === 'desktop/upgrade-preflight.ps1' || relative.endsWith('.test.mjs') || relative.includes('.currents-backup-') || relative.split('/').some(part => part.endsWith('.ownership-backup')) || /(^|\/)(\.git|\.env(?:\..*)?|data|workspace|tests|node_modules)(\/|$)/.test(relative);
}


/** The installed-file verifier uses the same runtime families as electron-builder. */
export function approvedWindowsPackageFile(relative, version) {
  if (typeof relative === 'string' && /^(?:lib\/(?:workbench-|windows-workbench\.mjs)|desktop\/workbench-|scripts\/(?:workbench-|install-workbench-|package-workbench-|verify-workbench-)|resources\/(?:workbench-native|guest)\/|public\/next\/(?:workbench\.css|workspaces\/workbench))/.test(relative)) return false;
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..') || forbiddenWindowsPackagePath(relative)) return false;
  return topLevelFiles.has(relative) || relative === 'docs/GOAL-MODE.md' || relative === 'docs/instruction-audit.md' || packagedNativeHelpers.has(relative) || /^(lib|public)\//.test(relative) || /^desktop\/.*\.(mjs|cjs)$/.test(relative) || relative.startsWith('desktop/browser-compatibility/') || relative === 'desktop/icon.ico' || relative === 'desktop/password-manager/index.html' || relative === 'desktop/password-manager/style.css' || relative === 'scripts/repair-shortcuts.ps1' || /^scripts\/(generate-noir-background\.mjs|noir-scene\.config\.json|chatgpt-bridge\.mjs|email-oauth-token\.mjs|remote-access-cli\.mjs|browser-cli\.mjs|chatgpt-cli\.mjs)$/.test(relative);
}

/** Read existing, tracked evidence; never synthesize a passing source-test receipt. */
export async function readWindowsSourceTestReceipt({ directory, receiptPath, version, appFingerprint, tracked, sourceIndexSha256, diagnosticOnly = false, artifactSha256 }) {
  check(typeof receiptPath === 'string' && /^verification\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(receiptPath), 'Choose a source-test receipt under verification/.');
  check(tracked?.has(receiptPath), 'Source-test receipt is not tracked in the approved source.');
  const verification = await fs.lstat(path.join(directory, 'verification'));
  check(verification.isDirectory() && !verification.isSymbolicLink(), 'Source-test receipt directory must not be a link.');
  const file = path.join(directory, receiptPath), stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1000000, 'Source-test receipt must be a regular bounded file.');
  const bytes = await fs.readFile(file), prior = JSON.parse(bytes), tests = prior.tests;
  if (diagnosticOnly === true) {
    check(prior.format === 1 && prior.product === 'BLACKICE' && prior.classification === 'qualification-provenance-not-a-passing-source-receipt' && prior.version === version && prior.appFingerprint === appFingerprint && prior.passed === false, 'Diagnostic source qualification binding mismatch');
    check(/^[a-f\d]{64}$/.test(artifactSha256) && prior.artifact?.sha256 === artifactSha256, 'Diagnostic installer binding mismatch');
    check(/^[a-f\d]{40}$/.test(prior.fullSuiteSource) && /^[a-f\d]{40}$/.test(prior.packagedSource) && /^[a-f\d]{64}$/.test(prior.testLogSha256), 'Diagnostic source/log provenance missing');
    check(tests && ['total', 'passed', 'failed', 'optionalSkipped', 'cancelled', 'exitCode'].every(key => Number.isSafeInteger(tests[key]) && tests[key] >= 0) && tests.failed > 0 && tests.exitCode > 0 && tests.total === tests.passed + tests.failed + tests.optionalSkipped + tests.cancelled, 'Diagnostic failed-suite counts invalid');
    return { receiptPath, receiptSha256: createHash('sha256').update(bytes).digest('hex'), diagnosticOnly: true, publicReleaseReady: false, qualification: prior, tests, testLogSha256: prior.testLogSha256 };
  }
  check(prior.format === 1 && prior.product === 'BLACKICE' && prior.scope === 'source-publication' && prior.version === version && prior.appFingerprint === appFingerprint && prior.fingerprintUnchanged === true && prior.platform === 'win32', 'Prior source test receipt binding mismatch');
  check(tests && ['total', 'passed', 'failed', 'requiredSkipped', 'optionalSkipped', 'cancelled', 'exitCode'].every(key => Number.isSafeInteger(tests[key]) && tests[key] >= 0) && tests.passed > 0 && tests.failed === 0 && tests.requiredSkipped === 0 && tests.cancelled === 0 && tests.exitCode === 0 && tests.total === tests.passed + tests.failed + tests.requiredSkipped + tests.optionalSkipped, 'Prior required tests did not pass');
  check(/^[a-f\d]{64}$/.test(prior.testLogSha256), 'Prior test log provenance missing');
  if (sourceIndexSha256 !== undefined) check(typeof sourceIndexSha256 === 'string' && /^[a-f\d]{64}$/.test(sourceIndexSha256) && prior.sourceIndexSha256 === sourceIndexSha256, 'Prior source-test inventory binding mismatch');
  return { receiptPath, receiptSha256: createHash('sha256').update(bytes).digest('hex'), checkedAt: prior.checkedAt, platform: prior.platform, node: prior.node, appFingerprint: prior.appFingerprint, sourceIndexSha256: prior.sourceIndexSha256, tests, testLogSha256: prior.testLogSha256 };
}

// Disposable release fixtures own a new custom profile. A connector origin from
// the invoking installed app cannot authorize that unrelated fixture instance.
export function disposableDesktopFixtureEnvironment(source = process.env) {
  const env = { ...source };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.BLACKICE_RESTART_ORIGIN;
  return env;
}
