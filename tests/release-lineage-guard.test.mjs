import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditReleaseLineage } from '../scripts/release-lineage-guard.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'blackice-release-lineage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'BLACKICE Test');
  git('config', 'user.email', 'blackice-test@example.invalid');
  writeFileSync(join(root, 'common.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'last shared source');
  git('branch', 'accepted');
  writeFileSync(join(root, 'release.txt'), 'self driving\n');
  git('add', '.');
  git('commit', '-m', 'self-driving release from older shared source');
  const candidate = git('rev-parse', 'HEAD');
  git('checkout', 'accepted');
  writeFileSync(join(root, 'runtime.txt'), 'runtime controls\n');
  git('add', '.');
  git('commit', '-m', 'unpublished accepted Runtime work');
  const accepted = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  return { root, git, candidate, accepted };
}

test('a tested release fork fails if it omits independently accepted Runtime HEAD', t => {
  const f = fixture(t);
  const result = auditReleaseLineage({ repository: f.root, candidate: f.candidate, acceptedRefs: ['accepted'], canonical: f.root });
  assert.equal(result.passed, false);
  const missing = result.checks.find(item => item.kind === 'accepted-ref');
  assert.equal(missing.commit, f.accepted);
  assert.equal(missing.status, 'fail');
});

test('a merge with both lines passes when the canonical workspace is clean', t => {
  const f = fixture(t);
  f.git('merge', '--no-ff', '--no-edit', 'accepted');
  const result = auditReleaseLineage({ repository: f.root, candidate: 'HEAD', acceptedRefs: ['accepted'], canonical: f.root, requireCheckoutMatch: true });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
});

test('dirty canonical source blocks declaring any release complete', t => {
  const f = fixture(t);
  f.git('merge', '--no-ff', '--no-edit', 'accepted');
  writeFileSync(join(f.root, 'uncommitted-code.mjs'), 'new work\n');
  const result = auditReleaseLineage({ repository: f.root, candidate: 'HEAD', acceptedRefs: ['accepted'], canonical: f.root });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.kind === 'canonical-worktree').status, 'fail');
});

test('no accepted baseline is always an error (no opt-out by omission)', t => {
  const f = fixture(t);
  const result = auditReleaseLineage({ repository: f.root, candidate: 'HEAD' });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.kind === 'baseline').status, 'fail');
});

test('invalid accepted ref fails closed rather than assuming it is merged', t => {
  const f = fixture(t);
  const result = auditReleaseLineage({ repository: f.root, candidate: 'HEAD', acceptedRefs: ['not-a-real-branch'] });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.kind === 'accepted-ref').status, 'fail');
});