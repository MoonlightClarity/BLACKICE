import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('existing documentation check rejects historical clutter but permits runtime skills and fixtures', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-doc-hygiene-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const put = async (relative, text = '# Fixture\n') => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
    git('add', '--', relative);
  };
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('../scripts/check-documentation.mjs', import.meta.url),
    path.join(root, 'scripts/check-documentation.mjs'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  git('init', '-q');
  for (const filename of [
    'README.md',
    'RELEASE-NOTES.md',
    'docs/API-PROVIDERS.md',
    'lib/skill-library/browser-navigation.md',
    'tests/fixtures/soul-default-20261125.md',
    'lib/vendor/catalyst/LICENSES.md',
  ]) await put(filename);

  const check = () => spawnSync(process.execPath, ['scripts/check-documentation.mjs'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  let result = check();
  assert.equal(result.status, 0, result.stderr);

  for (const filename of [
    'RELEASE-NOTES-2.41.0.md',
    'docs/document-status.json',
    'docs/README.md',
    'docs/MINICPM-RESULTS-20261125.md',
    'docs/research/experiment.md',
    'verification/log.tap',
    'verification/log.jsonl',
    'tests/retired/old-test.mjs.txt',
  ]) {
    await put(filename);
    result = check();
    assert.notEqual(result.status, 0, 'Expected the existing check to reject ' + filename);
    assert.match(result.stderr, /obsolete tracked development material/);
    assert.ok(result.stderr.includes(filename), result.stderr);
    git('rm', '--cached', '-q', '-f', '--', filename);
    await rm(path.join(root, filename));
  }

  await put('docs/API-PROVIDERS.md', '[missing](./missing.md)\n');
  result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing \.\/missing\.md/);
});
