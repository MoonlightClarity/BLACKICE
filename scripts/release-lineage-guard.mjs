#!/usr/bin/env node
// Verify a release candidate contains an independently designated accepted
// development tip. A candidate's own fingerprints cannot establish this.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), error: (result.stderr || '').trim(), status: result.status };
}
function commit(root, ref) {
  if (!ref || !/^[A-Za-z0-9_./+-]+$/.test(ref) || ref.startsWith('-')) return null;
  const result = git(root, 'rev-parse', '--verify', ref + '^{commit}');
  return result.ok && /^[a-f0-9]{40}$/i.test(result.out) ? result.out.toLowerCase() : null;
}

export function auditReleaseLineage({ repository = process.cwd(), candidate = 'HEAD', acceptedRefs = [], canonical = null, requireCheckoutMatch = false } = {}) {
  const repo = resolve(repository);
  const check = [];
  const source = commit(repo, candidate);
  const head = commit(repo, 'HEAD');
  if (!source) check.push({ kind: 'candidate', status: 'fail', detail: 'Candidate commit is missing or invalid.' });
  else check.push({ kind: 'candidate', status: 'pass', commit: source });
  if (requireCheckoutMatch) {
    const ok = source && head === source;
    check.push({ kind: 'checkout', status: ok ? 'pass' : 'fail', head, detail: ok ? 'Checkout equals candidate.' : 'Checked-out files are not from the candidate commit.' });
  }
  if (!acceptedRefs.length && !canonical) {
    check.push({ kind: 'baseline', status: 'fail', detail: 'A candidate must be checked against an independent accepted commit/ref or canonical workspace.' });
  }
  for (const ref of acceptedRefs) {
    const expected = commit(repo, ref);
    const ancestor = expected && source ? git(repo, 'merge-base', '--is-ancestor', expected, source).ok : false;
    check.push({ kind: 'accepted-ref', ref, commit: expected, status: ancestor ? 'pass' : 'fail',
      detail: !expected ? 'Accepted ref/commit is not available in the release checkout.' : ancestor ? 'Accepted development history is present.' : 'Release source omits accepted development history.' });
  }
  if (canonical) {
    const root = resolve(canonical);
    const expected = commit(root, 'HEAD');
    const changed = git(root, 'status', '--porcelain=v1', '-uall');
    const dirty = !changed.ok || Boolean(changed.out);
    const ancestor = expected && source ? git(repo, 'merge-base', '--is-ancestor', expected, source).ok : false;
    check.push({ kind: 'canonical-head', root, commit: expected, status: ancestor ? 'pass' : 'fail',
      detail: !expected ? 'Canonical source cannot be inspected.' : ancestor ? 'Canonical development history is present.' : 'Release omits the current canonical development HEAD.' });
    check.push({ kind: 'canonical-worktree', root, status: dirty ? 'fail' : 'pass',
      changedEntries: changed.ok && changed.out ? changed.out.split(/\r?\n/).length : 0,
      detail: dirty ? 'Canonical workspace has uncommitted/untracked work; release completeness cannot be asserted.' : 'Canonical workspace is clean.' });
  }
  return { format: 1, candidate: source, repository: repo, passed: check.length > 0 && check.every(item => item.status === 'pass'), checks: check };
}

const called = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (called) {
  const args = process.argv.slice(2);
  const options = { acceptedRefs: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--repo') options.repository = args[++i];
    else if (flag === '--candidate') options.candidate = args[++i];
    else if (flag === '--accepted-ref') options.acceptedRefs.push(args[++i]);
    else if (flag === '--canonical') options.canonical = args[++i];
    else if (flag === '--require-checkout-match') options.requireCheckoutMatch = true;
    else { console.error('Unknown/invalid option: ' + flag); process.exit(2); }
  }
  const result = auditReleaseLineage(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 2;
}