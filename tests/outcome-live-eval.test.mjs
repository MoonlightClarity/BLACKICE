import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseOutcomeOptions, snapshotOutcomeSources } from '../scripts/outcome-eval-support.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const common = ['--root', 'evaluation-output', '--case-file', 'fixtures.json'];

test('outcome evaluation preserves the default baseline/candidate comparison', () => {
  const config = parseOutcomeOptions(['--baseline', 'before', '--candidate', 'after', ...common]);
  assert.deepEqual(Object.keys(config.sources), ['baseline', 'candidate']);
  assert.deepEqual(config.modes, ['on']);
  assert.equal(config.dependencies, path.resolve('before', 'node_modules'));
  assert.throws(() => parseOutcomeOptions(['--candidate', 'after', ...common]), /source paths for each selected variant/);
});

test('candidate-only evaluation needs no baseline and preserves explicit dependencies and selections', () => {
  const args = ['--variants', 'candidate', '--candidate', 'after', '--modes', 'on,off', '--ids', 'one,two', ...common];
  const config = parseOutcomeOptions(args);
  assert.deepEqual(config.sources, { candidate: path.resolve('after') });
  assert.deepEqual(config.modes, ['on', 'off']);
  assert.equal(config.options.ids, 'one,two');
  assert.equal(config.dependencies, path.resolve('after', 'node_modules'));
  assert.equal(parseOutcomeOptions([...args, '--dependencies', 'shared-modules']).dependencies, path.resolve('shared-modules'));
  for (const variants of ['candidate,candidate', 'candidate,unknown', 'candidate,']) {
    assert.throws(() => parseOutcomeOptions(['--variants', variants, '--candidate', 'after', ...common]), /Variants must select/);
  }
});

test('fresh candidate snapshots load the real server and tool modules without bundled skills without starting a runtime', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-outcome-snapshot-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-outcome-snapshot-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = parseOutcomeOptions(['--variants', 'candidate', '--candidate', source, '--root', root, '--case-file', path.join(source, 'scripts', 'fixtures', 'outcome-disclosure-cases.json')]);
  const { snapshots, changedFiles } = await snapshotOutcomeSources(config);
  assert.deepEqual(Object.keys(snapshots), ['candidate']);
  assert.equal(changedFiles, null);
  await assert.rejects(fs.stat(path.join(root, 'source-baseline')), { code: 'ENOENT' });
  const target = path.join(root, 'source-candidate');
  for (const relative of ['lib/conversation-autonomy.mjs', 'desktop/browser-submission-observation.mjs']) {
    const original = await fs.readFile(path.join(source, relative));
    const copied = await fs.readFile(path.join(target, relative));
    assert.deepEqual(copied, original);
    assert.equal(snapshots.candidate.files[relative], hash(original));
  }
  // Import only: server.mjs starts its runtime solely when used as the entrypoint.
  const server = await import(pathToFileURL(path.join(target, 'server.mjs')).href);
  assert.equal(typeof server.createHarnessServer, 'function');
  assert.equal(snapshots.candidate.fingerprint, hash(JSON.stringify(snapshots.candidate.files, null, 2) + '\n'));
  await assert.rejects(fs.stat(path.join(target,'skills','planning','SKILL.md')), {code:'ENOENT'});
});
