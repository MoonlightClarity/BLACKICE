import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captureSourceEvidence } from '../scripts/source-evidence.mjs';
import { validatePatchPath } from '../scripts/install-background-update.mjs';
import { BROWSER_PROTECTION_QA_SOURCES } from '../scripts/browser-protection-qa.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
async function candidate(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-source-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, relative, contents) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

test('read-only evidence includes workflows, launchers and new documentation without changing updater write rules', async t => {
  const root = await candidate(t), sources = {
    'tests/example.test.mjs': 'test source',
    'RELEASE-NOTES-future.md': 'future documentation',
    'Start Relay.cmd': 'launcher source',
    'lib/browser.mjs': 'browser source',
    'lib.mjs': 'root module',
    '.github/workflows/verify-windows-release.yml': 'workflow source',
    '.gitignore': 'ignored paths',
    'package.json': '{"name":"fixture"}',
  };
  for (const [name, contents] of Object.entries(sources)) await put(root, name, contents);
  const before = await Promise.all(Object.keys(sources).map(name => fs.stat(path.join(root, name))));
  const evidence = await captureSourceEvidence(root);
  assert.deepEqual(Object.keys(evidence), Object.keys(sources).sort());
  for (const [name, contents] of Object.entries(sources)) {
    assert.equal(evidence[name], sha256(contents));
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), contents);
  }
  assert.deepEqual(await captureSourceEvidence(root), evidence);
  const after = await Promise.all(Object.keys(sources).map(name => fs.stat(path.join(root, name))));
  assert.deepEqual(after.map(info => [info.size, info.mtimeMs]), before.map(info => [info.size, info.mtimeMs]));
  assert.throws(() => validatePatchPath('.github/workflows/verify-windows-release.yml'), /outside the application source/);
  assert.throws(() => validatePatchPath('RELEASE-NOTES-future.md'), /outside the application source/);
});

test('source additions, edits and removals change the captured evidence', async t => {
  const root = await candidate(t);
  await put(root, 'lib/browser.mjs', 'before');
  const baseline = await captureSourceEvidence(root);
  await put(root, '.github/workflows/new.yml', 'new workflow');
  const added = await captureSourceEvidence(root);
  assert.notDeepEqual(added, baseline);
  assert.equal(added['.github/workflows/new.yml'], sha256('new workflow'));
  await put(root, 'lib/browser.mjs', 'after');
  const edited = await captureSourceEvidence(root);
  assert.notDeepEqual(edited, added);
  assert.equal(edited['lib/browser.mjs'], sha256('after'));
  await fs.rm(path.join(root, '.github/workflows/new.yml'));
  const removed = await captureSourceEvidence(root);
  assert.notDeepEqual(removed, edited);
  assert.deepEqual(Object.keys(removed), ['lib/browser.mjs']);
});

test('dependency, profile, generated and recovery contents do not change source evidence', async t => {
  const root = await candidate(t);
  await put(root, 'lib/browser.mjs', 'source');
  const baseline = await captureSourceEvidence(root);
  for (const name of ['node_modules/dependency/index.js', 'data/browser-profile/session', 'workspace/result.json', '.build/output', 'dist/application.exe', '.git/index', 'scripts/__pycache__/compiled.pyc', 'lib/browser.mjs.currents-backup-old']) {
    await put(root, name, 'local contents');
  }
  assert.deepEqual(await captureSourceEvidence(root), baseline);
  await put(root, 'data/browser-profile/session', 'changed local contents');
  assert.deepEqual(await captureSourceEvidence(root), baseline);
});

test('excluded dependency links are skipped and source directory links are never traversed', async t => {
  const root = await candidate(t), outside = await candidate(t);
  await put(root, 'package.json', '{}');
  await put(outside, 'outside.mjs', 'outside contents');
  await fs.symlink(outside, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await captureSourceEvidence(root), { 'package.json': sha256('{}') });
  await fs.symlink(outside, path.join(root, 'linked-source'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureSourceEvidence(root), /cannot follow links: linked-source/);
});

test('browser acceptance binds its read-only evidence collector to the candidate', () => {
  assert.ok(BROWSER_PROTECTION_QA_SOURCES.includes('scripts/source-evidence.mjs'));
  assert.equal(new Set(BROWSER_PROTECTION_QA_SOURCES).size, BROWSER_PROTECTION_QA_SOURCES.length);
});
