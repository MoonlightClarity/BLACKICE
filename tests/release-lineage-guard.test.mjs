import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { auditReleaseLineage, verifyReleaseAcknowledgement, releaseReviewSummary } from '../scripts/release-lineage-guard.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'blackice-release-lineage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','ignore'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'BLACKICE Test');
  git('config', 'user.email', 'blackice-test@example.invalid');
  writeFileSync(join(root, 'common.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'last shared source');
  git('branch', 'accepted');
  writeFileSync(join(root, 'release.txt'), 'self driving\n');
  git('add', '.');
  git('commit', '-m', 'release from old shared source');
  const candidate = git('rev-parse', 'HEAD');
  git('checkout', 'accepted');
  writeFileSync(join(root, 'runtime.txt'), 'accepted runtime\n');
  git('add', '.');
  git('commit', '-m', 'accepted Runtime work');
  const accepted = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  return { root, git, candidate, accepted };
}

const requestFor = (audit, overrides = {}) => {
  const accepted = audit.checks.find(item => item.kind === 'accepted-ref');
  const outcome = !accepted?.commit ? 'unavailable' : accepted.status === 'pass' ? 'included' : 'omitted';
  return {
    format: 1, version: '2.40.85', appFingerprint: 'b'.repeat(64),
    lineageReview: {
      format: 1, acknowledged: true, reviewedVersion: '2.40.85',
      reviewedAppFingerprint: 'b'.repeat(64),
      reviewedAcceptedTip: accepted?.commit || null, reviewedOutcome: outcome,
      note: 'I checked this version and the accepted-development baseline and reviewed the exact gap.',
      ...overrides
    }
  };
};
const check = (f, opts = {}) => auditReleaseLineage({ repository: f.root, candidate: opts.candidate || f.candidate, acceptedRefs: opts.acceptedRefs || ['accepted'], ...(opts.canonical ? {canonical:f.root}:{}), requireCheckoutMatch: opts.requireCheckoutMatch===true });

test('the exact 2.40.84 fork failure is an omission warning and blocks without acknowledgement', t => {
  const f = fixture(t), audit = check(f);
  assert.equal(audit.passed, false);
  assert.equal(audit.checks.find(item => item.kind === 'accepted-ref').commit, f.accepted);
  const missing = verifyReleaseAcknowledgement({ audit, request: { version:'2.40.85',appFingerprint:'b'.repeat(64) }, acceptedRef:'accepted' });
  assert.equal(missing.outcome, 'omitted');
  assert.equal(missing.authorized, false);
  assert.match(missing.warning, /omits accepted development tip/);
});

test('a fully informed acknowledgement allows an intentional known omission, without silently treating it as included', t => {
  const f = fixture(t), audit = check(f);
  const review = verifyReleaseAcknowledgement({ audit, request: requestFor(audit), acceptedRef:'accepted' });
  assert.equal(review.authorized, true);
  assert.equal(review.outcome, 'omitted');
  assert.match(releaseReviewSummary(review), /WARNING: Candidate omits/);
});

test('an accepted ancestor with explicit acknowledgement can release, even if unrelated WIP exists', t => {
  const f = fixture(t);
  f.git('merge', '--no-ff', '--no-edit', 'accepted');
  writeFileSync(join(f.root, 'experimental-branch-work.txt'), 'uncommitted experiment');
  const audit = check(f, {candidate:'HEAD',canonical:true,requireCheckoutMatch:true});
  assert.equal(audit.checks.find(item => item.kind === 'accepted-ref').status, 'pass');
  assert.equal(audit.checks.find(item => item.kind === 'canonical-worktree').status, 'warning');
  const review = verifyReleaseAcknowledgement({ audit, request: requestFor(audit), acceptedRef:'accepted' });
  assert.equal(review.outcome, 'included');
  assert.equal(review.authorized, true);
  assert.equal(review.warning, null);
});

test('review is bound to version, app fingerprint, baseline tip, outcome, explicit boolean and specific note', t => {
  const f = fixture(t), audit = check(f);
  for(const patch of [
    { acknowledged:false }, {acknowledged:'true'}, {reviewedVersion:'2.40.84'},
    {reviewedAppFingerprint:'c'.repeat(64)}, {reviewedAcceptedTip:'f'.repeat(40)},
    {reviewedOutcome:'included'}, {note:'ok'}, {note:42}
  ]) {
    const request=requestFor(audit,patch);
    assert.equal(verifyReleaseAcknowledgement({audit,request,acceptedRef:'accepted'}).authorized,false,JSON.stringify(patch));
  }
});

test('unavailable independent baseline is conspicuously warned and must be acknowledged as unavailable', t => {
  const f = fixture(t);
  const audit = check(f,{acceptedRefs:['not-published']});
  const missing = verifyReleaseAcknowledgement({audit,request:{version:'2.40.85',appFingerprint:'b'.repeat(64)},acceptedRef:'not-published'});
  assert.equal(missing.outcome,'unavailable');
  assert.equal(missing.authorized,false);
  assert.match(missing.warning,/No independent accepted/);
  const reviewed=verifyReleaseAcknowledgement({audit,request:requestFor(audit),acceptedRef:'not-published'});
  assert.equal(reviewed.authorized,true);
  assert.equal(reviewed.outcome,'unavailable');
});

test('invalid source commit always rejects even with an acknowledgement', t => {
  const f = fixture(t), audit = check(f,{candidate:'does-not-exist'});
  assert.equal(verifyReleaseAcknowledgement({audit,request:requestFor(audit),acceptedRef:'accepted'}).authorized,false);
});

test('actual publishing workflow includes acknowledgement gate without changing automatic publish trigger', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish-windows-release.yml', import.meta.url),'utf8');
  assert.match(workflow,/paths: \['\.github\/release-request\.json'\]/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/Verify development lineage and require explicit acknowledgement/);
  assert.match(workflow,/release-lineage-guard\.mjs --repo \. --candidate \$env:GITHUB_SHA/);
  assert.match(workflow,/--summary \$env:GITHUB_STEP_SUMMARY --enforce/);
  assert.match(workflow,/refs\/heads\/accepted-development/);
  assert.ok(workflow.indexOf('release-lineage-guard.mjs')<workflow.indexOf('Build the locked Windows candidate'));
});