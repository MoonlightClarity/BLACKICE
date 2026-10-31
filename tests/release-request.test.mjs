import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateReleaseRequest, verifyReleaseSource, verifyReleaseArtifact, bindReleaseTag, releaseSourceIndex, verifyReleaseAssetCopies } from '../scripts/release-request.mjs';

const request = () => ({ format: 1, version: '9.8.7', sourceCommit: 'a'.repeat(40),
  appFingerprint: 'b'.repeat(64), sourceTestReceipt: 'verification/windows-9.8.7.json', publish: false });

test('release requests retain the exact source and require an explicit publication choice', () => {
  assert.equal(validateReleaseRequest(request()).publish, false);
  assert.equal(validateReleaseRequest({ ...request(), publish: true }).publish, true);
  assert.equal(validateReleaseRequest(request()).tag, 'v9.8.7');
  assert.equal(validateReleaseRequest(request()).notes, 'RELEASE-NOTES-9.8.7.md');
  for (const value of [undefined, null, 'true', 1]) assert.throws(() => validateReleaseRequest({ ...request(), publish: value }), /explicitly/);
});

test('the triggering workflow supplies its actual commit when the request cannot contain its own hash', () => {
  const value = request(); delete value.sourceCommit;
  assert.equal(validateReleaseRequest(value, { sourceCommit: 'c'.repeat(40) }).sourceCommit, 'c'.repeat(40));
  assert.throws(() => validateReleaseRequest(value), /exact source commit/);
  assert.throws(() => validateReleaseRequest(request(), { sourceCommit: 'c'.repeat(40) }), /differs/);
});

test('release request fields cannot silently select another version or arbitrary file', () => {
  for (const value of [
    null, [], { ...request(), format: 2 }, { ...request(), version: 'latest' },
    { ...request(), version: '9.8.7-beta' }, { ...request(), sourceCommit: 'main' },
    { ...request(), appFingerprint: '' }, { ...request(), sourceTestReceipt: '../private.json' },
    { ...request(), sourceTestReceipt: 'verification/nested/private.json' },
    { ...request(), sourceTestReceipt: 'verification/windows.json\nOTHER=value' },
  ]) assert.throws(() => validateReleaseRequest(value));
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-release-request-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const value = request(), name = 'Blackice-' + value.version + '-Setup.exe', bytes = Buffer.from('disposable candidate, never executed');
  const manifest = { format: 1, product: 'BLACKICE', version: value.version, appFingerprint: value.appFingerprint,
    artifact: { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const save = data => fs.writeFile(path.join(directory, 'blackice-public-release.json'), JSON.stringify(data));
  await fs.writeFile(path.join(directory, name), bytes); await save(manifest);
  return { directory, value, name, manifest, save };
}

test('a candidate is bound to its exact source fingerprint, filename and bytes', async t => {
  const f = await fixture(t), result = await verifyReleaseArtifact(f.value, f.directory);
  assert.equal(result.installerName, f.name); assert.equal(result.installerSha256, f.manifest.artifact.sha256);
  await fs.appendFile(path.join(f.directory, f.name), 'changed');
  await assert.rejects(verifyReleaseArtifact(f.value, f.directory), /size/);
});

test('same-sized tampering and mismatched source metadata cannot pass the release request', async t => {
  const f = await fixture(t);
  for (const update of [
    { ...f.manifest, version: '9.8.6' }, { ...f.manifest, appFingerprint: 'c'.repeat(64) },
    { ...f.manifest, artifact: { ...f.manifest.artifact, name: '../another.exe' } },
  ]) { await f.save(update); await assert.rejects(verifyReleaseArtifact(f.value, f.directory), /manifest/); }
  await f.save(f.manifest);
  await fs.writeFile(path.join(f.directory, f.name), Buffer.alloc(f.manifest.artifact.size, 1));
  await assert.rejects(verifyReleaseArtifact(f.value, f.directory), /checksum/);
});


test('the workflow CLI resolves the real triggering commit and emits safe outputs', async t => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t), value = request(); delete value.sourceCommit;
  const file = path.join(f.directory, 'request.json'), output = path.join(f.directory, 'outputs.txt');
  await fs.writeFile(file, JSON.stringify(value));
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/release-request.mjs', import.meta.url)),
    '--request', file, '--source-commit', 'd'.repeat(40), '--github-output'], { env: { ...process.env, GITHUB_OUTPUT: output } });
  assert.equal(JSON.parse(result.stdout).sourceCommit, 'd'.repeat(40));
  const outputs = await fs.readFile(output, 'utf8');
  assert.match(outputs, /^publish=false$/m); assert.match(outputs, /^tag=v9\.8\.7$/m);
  assert.ok(outputs.includes('sourceCommit=' + 'd'.repeat(40) + '\n'));
});

function tagApiFixture(answers) {
  const calls = [];
  const api = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    assert.ok(answers.length > 0, 'unexpected GitHub request');
    return answers.shift();
  };
  return { api, calls, answers };
}
const refResponse = (type = 'commit', sha = 'a'.repeat(40)) =>
  ({ status: 200, data: { ref: 'refs/tags/v9.8.7', object: { type, sha } } });
const annotationResponse = (sha, type, target) => ({ status: 200, data: { sha, object: { type, sha: target } } });
const repository = 'MoonlightClarity/BLACKICE';

test('lightweight and nested annotated release tags resolve to the exact requested commit', async () => {
  const light = tagApiFixture([refResponse()]);
  const direct = await bindReleaseTag(request(), { repository, api: light.api });
  assert.equal(direct.tagCommit, request().sourceCommit); assert.equal(direct.tagDepth, 0);
  assert.equal(direct.tagCreated, false); assert.deepEqual(light.calls.map(x => x.method), ['GET']);
  const first = 'c'.repeat(40), second = 'd'.repeat(40);
  const nested = tagApiFixture([refResponse('tag', first), annotationResponse(first, 'tag', second), annotationResponse(second, 'commit', request().sourceCommit)]);
  const result = await bindReleaseTag(request(), { repository, api: nested.api });
  assert.equal(result.tagReferenceSha, first); assert.equal(result.tagDepth, 2);
  assert.equal(result.tagCommit, request().sourceCommit); assert.equal(nested.answers.length, 0);
});

test('an existing tag mismatch fails before draft reuse and is never forced or replaced', async () => {
  for (const mode of ['inspect', 'verify']) {
    const f = tagApiFixture([refResponse('commit', 'e'.repeat(40))]);
    await assert.rejects(bindReleaseTag(request(), { repository, api: f.api, mode }), /different source commit/);
    assert.deepEqual(f.calls.map(x => x.method), ['GET']);
  }
});

test('absent tags may be inspected, but verification cannot silently accept or create one', async () => {
  const inspect = tagApiFixture([{ status: 404 }]);
  assert.deepEqual(await bindReleaseTag(request(), { repository, api: inspect.api, mode: 'inspect' }), { tagPresent: false, tagCreated: false });
  const verify = tagApiFixture([{ status: 404 }]);
  await assert.rejects(bindReleaseTag(request(), { repository, api: verify.api }), /missing/);
  assert.deepEqual(verify.calls.map(x => x.method), ['GET']);
});

test('ensure creates an absent lightweight tag only after exact installer bytes pass verification', async t => {
  const f = await fixture(t), github = tagApiFixture([{ status: 404 }, { status: 201 }, refResponse()]);
  const result = await bindReleaseTag(f.value, { repository, api: github.api, mode: 'ensure', distribution: f.directory });
  assert.equal(result.tagCreated, true); assert.equal(result.tagCommit, f.value.sourceCommit);
  assert.equal(result.installerSha256, f.manifest.artifact.sha256);
  assert.deepEqual(github.calls[1], { method: 'POST', endpoint: '/repos/' + repository + '/git/refs', body: { ref: 'refs/tags/v9.8.7', sha: f.value.sourceCommit } });
  assert.deepEqual(github.calls.map(x => x.method), ['GET', 'POST', 'GET']);
  await fs.appendFile(path.join(f.directory, f.name), 'changed');
  const untouched = tagApiFixture([]);
  await assert.rejects(bindReleaseTag(f.value, { repository, api: untouched.api, mode: 'ensure', distribution: f.directory }), /size/);
  assert.equal(untouched.calls.length, 0);
});

test('ensure retains an existing matching annotated tag without a mutation', async t => {
  const f = await fixture(t), annotation = 'c'.repeat(40);
  const github = tagApiFixture([refResponse('tag', annotation), annotationResponse(annotation, 'commit', f.value.sourceCommit)]);
  const result = await bindReleaseTag(f.value, { repository, api: github.api, mode: 'ensure', distribution: f.directory });
  assert.equal(result.tagCreated, false); assert.equal(result.tagDepth, 1);
  assert.ok(github.calls.every(call => call.method === 'GET'));
});

test('a tag creation race must resolve to the same commit and cannot overwrite a competing tag', async t => {
  const f = await fixture(t);
  for (const match of [true, false]) {
    const github = tagApiFixture([{ status: 404 }, { status: 422 }, refResponse('commit', match ? f.value.sourceCommit : 'e'.repeat(40))]);
    const promise = bindReleaseTag(f.value, { repository, api: github.api, mode: 'ensure', distribution: f.directory });
    if (match) assert.equal((await promise).tagCreated, false);
    else await assert.rejects(promise, /different source commit/);
    assert.deepEqual(github.calls.map(x => x.method), ['GET', 'POST', 'GET']);
  }
});

test('tag resolution rejects annotation cycles, excessive depth and noncommit objects', async () => {
  const first = 'c'.repeat(40), second = 'd'.repeat(40);
  const cycle = tagApiFixture([refResponse('tag', first), annotationResponse(first, 'tag', second), annotationResponse(second, 'tag', first)]);
  await assert.rejects(bindReleaseTag(request(), { repository, api: cycle.api }), /cycle/);
  assert.equal(cycle.calls.length, 3);
  const ids = Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(40));
  const deep = tagApiFixture([refResponse('tag', ids[0]), ...ids.slice(0, 8).map((sha, i) => annotationResponse(sha, 'tag', ids[i + 1]))]);
  await assert.rejects(bindReleaseTag(request(), { repository, api: deep.api }), /bounded limit/);
  assert.equal(deep.calls.length, 9);
  for (const response of [refResponse('tree'), refResponse('commit', 'main'), { ...refResponse(), data: { ...refResponse().data, ref: 'refs/tags/other' } }]) {
    await assert.rejects(bindReleaseTag(request(), { repository, api: tagApiFixture([response]).api }), /commit|invalid object|different ref/);
  }
});

test('unavailable or invalid tag lookup evidence never authorizes creation', async t => {
  const f = await fixture(t);
  for (const status of [401, 403, 429, 500]) {
    const github = tagApiFixture([{ status }]);
    await assert.rejects(bindReleaseTag(request(), { repository, api: github.api, mode: 'ensure', distribution: f.directory }), /lookup failed/);
    assert.deepEqual(github.calls.map(x => x.method), ['GET']);
  }
  const first = 'c'.repeat(40);
  for (const response of [{ status: 404 }, annotationResponse('d'.repeat(40), 'commit', request().sourceCommit)]) {
    const github = tagApiFixture([refResponse('tag', first), response]);
    await assert.rejects(bindReleaseTag(request(), { repository, api: github.api, mode: 'inspect' }), /annotation lookup failed/);
    assert.ok(github.calls.every(call => call.method === 'GET'));
  }
  await assert.rejects(bindReleaseTag(request(), { repository, api: tagApiFixture([]).api, mode: 'ensure' }), /candidate bytes/);
});

test('workflow tag creation follows candidate checks and installer execution has no publishing token', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/publish-windows-release.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^\s{6}- name: /m).slice(1);
  const inspect = steps.find(x => x.startsWith('Inspect an existing draft'));
  const ensureIndex = steps.findIndex(x => x.startsWith('Bind the actual source tag'));
  const bytesIndex = steps.findIndex(x => x.startsWith('Verify candidate bytes'));
  const installer = steps.find(x => x.startsWith('Verify this installer'));
  assert.match(inspect, /--github-tag inspect/);
  assert.ok(ensureIndex > bytesIndex);
  assert.match(steps[ensureIndex], /--github-tag ensure --distribution/);
  assert.doesNotMatch(installer, /GH_TOKEN|github\.token|--github-tag/);
  for (const name of ['Upload a new draft', 'Attach the bounded installer evidence', 'Publish only the verified requested release']) {
    assert.match(steps.find(x => x.startsWith(name)), /--github-tag verify/);
  }
});

async function sourceIndexFixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-source-index-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['.gitattributes', '.gitignore', 'package.json', 'package-lock.json', 'server.mjs']) await fs.writeFile(path.join(directory, name), name);
  for (const name of ['lib', 'public', 'desktop', 'scripts', 'tests', '.github/workflows']) {
    await fs.mkdir(path.join(directory, name), { recursive: true });
    await fs.writeFile(path.join(directory, name, 'fixture.txt'), name);
  }
  return directory;
}

test('the source index binds tests, build scripts, lockfile and workflows as well as runtime bytes', async t => {
  const directory = await sourceIndexFixture(t), baseline = await releaseSourceIndex(directory);
  assert.equal(baseline.records.length, 11);
  assert.equal(baseline.sourceIndexSha256, createHash('sha256').update(JSON.stringify(baseline.records)).digest('hex'));
  for (const file of ['tests/fixture.txt', 'scripts/fixture.txt', 'package-lock.json', '.github/workflows/fixture.txt', 'lib/fixture.txt']) {
    const original = await fs.readFile(path.join(directory, file));
    await fs.appendFile(path.join(directory, file), ' changed');
    assert.notEqual((await releaseSourceIndex(directory)).sourceIndexSha256, baseline.sourceIndexSha256, file);
    await fs.writeFile(path.join(directory, file), original);
    assert.equal((await releaseSourceIndex(directory)).sourceIndexSha256, baseline.sourceIndexSha256);
  }
});

test('source inventory excludes private diagnostics, recovery backups and circular receipts but rejects links', async t => {
  const directory = await sourceIndexFixture(t), baseline = await releaseSourceIndex(directory);
  for (const folder of ['lib/cache.ownership-backup', 'tests/.currents-backup-old', 'verification']) {
    await fs.mkdir(path.join(directory, folder), { recursive: true });
    await fs.writeFile(path.join(directory, folder, 'private.txt'), 'excluded');
  }
  await fs.writeFile(path.join(directory, '.github/release-request.json'), '{}');
  const privateBaseline = path.join(directory, 'tests/browser-debug-baseline-check.mjs');
  await fs.writeFile(privateBaseline, 'private backup dependency');
  assert.deepEqual(await releaseSourceIndex(directory), baseline);
  assert.equal(await fs.readFile(privateBaseline, 'utf8'), 'private backup dependency', 'indexing preserves the excluded local diagnostic');
  await fs.symlink(path.join(directory, 'tests'), path.join(directory, 'lib/linked-tests'), 'junction');
  await assert.rejects(releaseSourceIndex(directory), /cannot contain links/);
});

test('publication copies must match every pre-verification asset checksum', async t => {
  const f = await fixture(t), checksumFile = path.join(f.directory, 'SHA256SUMS.txt');
  await fs.writeFile(checksumFile, f.manifest.artifact.sha256 + '  ' + f.name + '\n');
  const files = { installerSha256: f.name, manifestSha256: 'blackice-public-release.json', checksumsSha256: 'SHA256SUMS.txt' };
  const expected = {};
  for (const [key, name] of Object.entries(files)) expected[key] = createHash('sha256').update(await fs.readFile(path.join(f.directory, name))).digest('hex');
  assert.equal((await verifyReleaseAssetCopies(f.value, f.directory, expected)).publicationAssetsVerified, true);
  for (const name of Object.values(files)) {
    const file = path.join(f.directory, name), bytes = await fs.readFile(file);
    await fs.writeFile(file, Buffer.alloc(bytes.length, 1));
    await assert.rejects(verifyReleaseAssetCopies(f.value, f.directory, expected), /changed after installer verification/);
    await fs.writeFile(file, bytes);
  }
  await assert.rejects(verifyReleaseAssetCopies(f.value, f.directory, { ...expected, manifestSha256: undefined }), /checksums are required/);
});

test('exact source verification rejects matching-index partial receipts and proves complete test inventory', async t => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { appFingerprint } = await import('../scripts/release-check.mjs');
  const execute = promisify(execFile), directory = await sourceIndexFixture(t), value = request();
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blackice-fixture', version: value.version }));
  await fs.writeFile(path.join(directory, '.gitattributes'), '');
  await fs.writeFile(path.join(directory, '.gitignore'), '');
  await fs.writeFile(path.join(directory, 'desktop/icon.ico'), 'synthetic icon, never executed');
  const files = ['tests/first.test.mjs', 'tests/second.test.mjs'];
  for (const file of files) await fs.writeFile(path.join(directory, file), '/* isolated source inventory fixture */\n');
  await fs.mkdir(path.join(directory, 'verification'));
  await fs.writeFile(path.join(directory, 'RELEASE-NOTES-' + value.version + '.md'), 'Synthetic release validation fixture.\n');
  value.appFingerprint = await appFingerprint(directory);
  const index = await releaseSourceIndex(directory);
  const receipt = { format: 1, product: 'BLACKICE', scope: 'source-publication', version: value.version,
    platform: 'win32', appFingerprint: value.appFingerprint, fingerprintUnchanged: true,
    sourceIndexSha256: index.sourceIndexSha256, passed: true, fullSuite: true, countsComplete: true,
    sourceUnchanged: true, execution: { uniqueCoverageVerified: true }, testFiles: files.length,
    testInventorySha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), optionalSkips: [],
    tests: { total: 2, passed: 2, failed: 0, requiredSkipped: 0, optionalSkipped: 0, cancelled: 0, todo: 0, exitCode: 0 },
    testLogSha256: 'c'.repeat(64) };
  const save = data => fs.writeFile(path.join(directory, value.sourceTestReceipt), JSON.stringify(data));
  await save(receipt);
  const git = args => execute('git', args, { cwd: directory });
  await git(['init', '--quiet']);
  await git(['-c', 'core.autocrlf=false', 'add', '--', '.']);
  await git(['-c', 'user.name=Release Fixture', '-c', 'user.email=release-fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic release verifier fixture']);
  value.sourceCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal((await verifyReleaseSource(value, directory)).sourceIndexSha256, index.sourceIndexSha256);
  const focused = { ...receipt, fullSuite: false, tests: { ...receipt.tests, total: 1, passed: 1 } };
  await save(focused);
  assert.equal((await releaseSourceIndex(directory)).sourceIndexSha256, receipt.sourceIndexSha256);
  await assert.rejects(verifyReleaseSource(value, directory), /full suite/);
  for (const field of ['passed', 'fullSuite', 'countsComplete', 'sourceUnchanged']) {
    for (const present of [false, true]) {
      const partial = structuredClone(receipt);
      if (present) partial[field] = false; else delete partial[field];
      await save(partial);
      await assert.rejects(verifyReleaseSource(value, directory), /full suite/, field);
    }
  }
  for (const execution of [{}, { uniqueCoverageVerified: false }]) {
    await save({ ...receipt, execution });
    await assert.rejects(verifyReleaseSource(value, directory), /full suite/);
  }
  for (const partial of [
    { ...receipt, testFiles: 1 }, { ...receipt, testInventorySha256: 'd'.repeat(64) },
    { ...receipt, tests: { ...receipt.tests, todo: 1 } },
  ]) {
    await save(partial);
    await assert.rejects(verifyReleaseSource(value, directory), /test inventory/);
  }
  for (const optionalSkips of [undefined, ['A required fixture was not run'],
    ['A required fixture was not run', 'A required fixture was not run']]) {
    const count = optionalSkips?.length || 0;
    await save({ ...receipt, optionalSkips, tests: { ...receipt.tests, total: 2 + count, optionalSkipped: count } });
    await assert.rejects(verifyReleaseSource(value, directory), /skipped test/);
  }
  const optional = 'Relay-owned sign-in and local storage survive a full process restart without foregrounding';
  await save({ ...receipt, optionalSkips: [optional], tests: { ...receipt.tests, total: 3, optionalSkipped: 1 } });
  assert.equal((await verifyReleaseSource(value, directory)).tests.optionalSkipped, 1);
  await save(receipt);
  assert.equal((await verifyReleaseSource(value, directory)).tests.passed, 2);
});
