#!/usr/bin/env node
// Evidence-backed release warning and candidate-bound explicit acknowledgement.
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), error: (result.stderr || '').trim(), status: result.status };
}
function commit(root, ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9_./+-]+$/.test(ref) || ref.startsWith('-')) return null;
  const result = git(root, 'rev-parse', '--verify', ref + '^{commit}');
  return result.ok && sha(result.out) ? result.out.toLowerCase() : null;
}

export function auditReleaseLineage({ repository = process.cwd(), candidate = 'HEAD', acceptedRefs = [], canonical = null, requireCheckoutMatch = false } = {}) {
  const repo = resolve(repository), checks = [];
  const source = commit(repo, candidate), head = commit(repo, 'HEAD');
  checks.push({ kind: 'candidate', status: source ? 'pass' : 'fail', commit: source,
    detail: source ? 'Candidate commit resolved.' : 'Candidate commit is missing or invalid.' });
  if (requireCheckoutMatch) checks.push({ kind: 'checkout', status: source && head === source ? 'pass' : 'fail', head,
    detail: head === source ? 'Checkout matches candidate.' : 'Checkout does not match candidate.' });
  if (!acceptedRefs.length && !canonical) checks.push({ kind: 'baseline', status: 'unknown',
    detail: 'No independent accepted tip was supplied; unpushed local work cannot be assessed.' });
  for (const ref of acceptedRefs) {
    const expected = commit(repo, ref);
    const ancestor = expected && source ? git(repo, 'merge-base', '--is-ancestor', expected, source).ok : false;
    checks.push({ kind: 'accepted-ref', ref, commit: expected, status: expected ? ancestor ? 'pass' : 'fail' : 'unknown',
      detail: !expected ? 'The accepted development ref is unavailable.' : ancestor
        ? 'Candidate includes accepted development history.' : 'Candidate omits accepted development history.' });
  }
  if (canonical) {
    const root = resolve(canonical), expected = commit(root, 'HEAD');
    const changed = git(root, 'status', '--porcelain=v1', '-uall');
    const dirty = !changed.ok || Boolean(changed.out);
    const ancestor = expected && source ? git(repo, 'merge-base', '--is-ancestor', expected, source).ok : false;
    checks.push({ kind: 'canonical-head', root, commit: expected, status: expected ? ancestor ? 'pass' : 'fail' : 'unknown',
      detail: !expected ? 'Canonical source unavailable.' : ancestor ? 'Candidate includes canonical HEAD.' : 'Candidate omits canonical HEAD.' });
    checks.push({ kind: 'canonical-worktree', root, status: changed.ok ? dirty ? 'warning' : 'pass' : 'unknown',
      changedEntries: changed.ok && changed.out ? changed.out.split(/\r?\n/).length : 0,
      detail: dirty ? 'Uncommitted local work exists. Classify it, but exploratory WIP does not automatically block.' : 'Canonical worktree clean.' });
  }
  return { format: 1, repository: repo, candidate: source, checks,
    passed: checks.every(c => c.status === 'pass'), warnings: checks.filter(c => c.status !== 'pass') };
}

export function verifyReleaseAcknowledgement({ audit, request, acceptedRef = null } = {}) {
  if (!audit || !request || !sha(audit.candidate)) return { authorized: false, reason: 'Release source was not verified.', outcome: 'unavailable' };
  const record = acceptedRef
    ? audit.checks.find(c => c.kind === 'accepted-ref' && c.ref === acceptedRef)
    : audit.checks.find(c => c.kind === 'baseline');
  const outcome = !record || !record.commit ? 'unavailable' : record.status === 'pass' ? 'included' : 'omitted';
  const acceptedTip = record?.commit || null;
  const r = request.lineageReview;
  const warning = outcome === 'included' ? null : outcome === 'omitted'
    ? 'Candidate omits accepted development tip ' + acceptedTip + '. Completed work may be missing.'
    : 'No independent accepted development baseline could be verified. CI cannot see unpushed local work.';
  const valid = r?.format === 1 && r.acknowledged === true
    && r.reviewedVersion === request.version && /^\d+\.\d+\.\d+$/.test(request.version || '')
    && fingerprint(request.appFingerprint) && r.reviewedAppFingerprint === request.appFingerprint
    && r.reviewedAcceptedTip === acceptedTip && r.reviewedOutcome === outcome
    && typeof r.note === 'string' && r.note.trim().length >= 15 && r.note.length <= 1200;
  const verified = audit.checks.find(c => c.kind === 'candidate')?.status === 'pass'
    && !audit.checks.some(c => c.kind === 'checkout' && c.status !== 'pass');
  return { authorized: Boolean(verified && valid), outcome, acceptedTip,
    version: request.version, appFingerprint: request.appFingerprint, warning,
    reason: !verified ? 'Candidate identity was not verified.' : valid
      ? 'Explicitly acknowledged for this version, fingerprint, accepted baseline and observed outcome.'
      : 'Missing or stale explicit acknowledgement for this exact version, fingerprint, accepted tip and verified outcome.',
    reviewed: Boolean(valid) };
}

export function releaseReviewSummary(result) {
  const status = result.authorized ? 'ACKNOWLEDGED' : 'NOT ACKNOWLEDGED';
  const out = ['## BLACKICE release lineage review',
    '**' + status + '** — independently verified outcome: **' + result.outcome + '**.',
    '- Release version: ' + (result.version || 'unknown'),
    '- Application fingerprint: ' + (result.appFingerprint || 'unknown'),
    '- Accepted baseline: ' + (result.acceptedTip || 'unavailable'),
    '- ' + result.reason];
  if (result.warning) out.push('> WARNING: ' + result.warning);
  out.push('CI cannot infer work that has not been pushed to a remote accepted-development ref.');
  return out.join('\n') + '\n';
}

const called = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (called) {
  const args = process.argv.slice(2);
  const options = { acceptedRefs: [], requireCheckoutMatch: false };
  let requestPath, summaryPath, enforce = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--repo') options.repository = args[++i];
    else if (flag === '--candidate') options.candidate = args[++i];
    else if (flag === '--accepted-ref') options.acceptedRefs.push(args[++i]);
    else if (flag === '--canonical') options.canonical = args[++i];
    else if (flag === '--require-checkout-match') options.requireCheckoutMatch = true;
    else if (flag === '--request') requestPath = args[++i];
    else if (flag === '--summary') summaryPath = args[++i];
    else if (flag === '--enforce') enforce = true;
    else { console.error('Unknown/invalid release-review option: ' + flag); process.exit(2); }
  }
  const audit = auditReleaseLineage(options);
  if (!requestPath) {
    console.log(JSON.stringify(audit, null, 2));
    if (enforce && !audit.passed) process.exitCode = 2;
  } else {
    const request = JSON.parse(readFileSync(requestPath, 'utf8').replace(/^\uFEFF/, ''));
    const result = verifyReleaseAcknowledgement({ audit, request, acceptedRef: options.acceptedRefs[0] || null });
    console.log(JSON.stringify({ audit, review: result }, null, 2));
    if (summaryPath) appendFileSync(summaryPath, releaseReviewSummary(result), 'utf8');
    if (result.warning) console.log('::warning::' + result.warning);
    if (enforce && !result.authorized) {
      console.error('::error::Release blocked: verify and explicitly acknowledge the current source lineage.');
      process.exitCode = 2;
    }
  }
}