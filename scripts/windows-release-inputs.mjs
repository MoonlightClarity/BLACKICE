import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const topLevelFiles = new Set(['package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'server.mjs', 'CHATGPT-BRIDGE.md', 'CHATGPT-CONNECTOR.md', 'CHAT-MODE.md', 'PLANNING-ORGANIZATION.md', 'REMOTE-ACCESS.md', 'BROWSER-PROTECTION.md', 'BROWSER-IMPORT.md', 'EMAIL.md', 'PLANNING-AWARENESS.md', ...['2.30.0', '2.31.0', '2.31.1', '2.32.0', '2.33.5', '2.33.6'].map(version => `RELEASE-NOTES-${version}.md`)]);
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function forbiddenWindowsPackagePath(relative) {
  return relative === 'desktop/build-icon.mjs' || relative.endsWith('.test.mjs') || relative.includes('.currents-backup-') || /(^|\/)(\.git|\.env(?:\..*)?|data|workspace|tests|node_modules)(\/|$)/.test(relative);
}

/** The installed-file verifier uses the same runtime families as electron-builder. */
export function approvedWindowsPackageFile(relative, version) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..') || forbiddenWindowsPackagePath(relative)) return false;
  return topLevelFiles.has(relative) || (/^\d+\.\d+\.\d+$/.test(version) && relative === `RELEASE-NOTES-${version}.md`) || /^(lib|public)\//.test(relative) || /^desktop\/.*\.(mjs|cjs)$/.test(relative) || relative.startsWith('desktop/browser-compatibility/') || relative === 'desktop/icon.ico' || /^scripts\/(generate-noir-background\.mjs|noir-scene\.config\.json|chatgpt-bridge\.mjs|email-oauth-token\.mjs|remote-access-cli\.mjs|browser-cli\.mjs)$/.test(relative);
}

/** Read existing, tracked evidence; never synthesize a passing source-test receipt. */
export async function readWindowsSourceTestReceipt({ directory, receiptPath, version, appFingerprint, tracked }) {
  check(typeof receiptPath === 'string' && /^verification\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(receiptPath), 'Choose a source-test receipt under verification/.');
  check(tracked?.has(receiptPath), 'Source-test receipt is not tracked in the approved source.');
  const verification = await fs.lstat(path.join(directory, 'verification'));
  check(verification.isDirectory() && !verification.isSymbolicLink(), 'Source-test receipt directory must not be a link.');
  const file = path.join(directory, receiptPath), stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1000000, 'Source-test receipt must be a regular bounded file.');
  const bytes = await fs.readFile(file), prior = JSON.parse(bytes), tests = prior.tests;
  check(prior.format === 1 && prior.product === 'BLACKICE' && prior.scope === 'source-publication' && prior.version === version && prior.appFingerprint === appFingerprint && prior.fingerprintUnchanged === true && prior.platform === 'win32', 'Prior source test receipt binding mismatch');
  check(tests && ['total', 'passed', 'failed', 'requiredSkipped', 'optionalSkipped', 'cancelled', 'exitCode'].every(key => Number.isSafeInteger(tests[key]) && tests[key] >= 0) && tests.passed > 0 && tests.failed === 0 && tests.requiredSkipped === 0 && tests.cancelled === 0 && tests.exitCode === 0 && tests.total === tests.passed + tests.failed + tests.requiredSkipped + tests.optionalSkipped, 'Prior required tests did not pass');
  check(/^[a-f\d]{64}$/.test(prior.testLogSha256), 'Prior test log provenance missing');
  return { receiptPath, receiptSha256: createHash('sha256').update(bytes).digest('hex'), checkedAt: prior.checkedAt, platform: prior.platform, node: prior.node, appFingerprint: prior.appFingerprint, tests, testLogSha256: prior.testLogSha256 };
}
