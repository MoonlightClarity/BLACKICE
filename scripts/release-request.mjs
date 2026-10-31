import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { readWindowsSourceTestReceipt } from './windows-release-inputs.mjs';

const execute = promisify(execFile);
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function validateReleaseRequest(value, context = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'A release request object is required.');
  check(value.format === 1, 'Unsupported release request format.');
  check(typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version), 'Choose a stable release version.');
  const sourceCommit = value.sourceCommit === undefined ? context.sourceCommit : value.sourceCommit;
  check(typeof sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(sourceCommit), 'An exact source commit is required.');
  check(context.sourceCommit === undefined || sourceCommit === context.sourceCommit, 'Request commit differs from the workflow commit.');
  check(typeof value.appFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.appFingerprint), 'An exact application fingerprint is required.');
  check(typeof value.sourceTestReceipt === 'string' && /^verification\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value.sourceTestReceipt), 'Choose a tracked source-test receipt under verification/.');
  check(typeof value.publish === 'boolean', 'Set publish explicitly to true or false.');
  return { format: 1, version: value.version, sourceCommit, appFingerprint: value.appFingerprint,
    sourceTestReceipt: value.sourceTestReceipt, publish: value.publish, tag: 'v' + value.version,
    notes: 'RELEASE-NOTES-' + value.version + '.md' };
}

const optionalWindowsSourceTests = new Set([
  'Relay-owned sign-in and local storage survive a full process restart without foregrounding',
  'restored hidden browser tabs defer requests until used and never load closed or replaced pages',
  'native cross-origin popups redirect, message their opener and follow or close without breaking Observe pins or task routing',
  'actual hidden Chromium fill commits trusted form state across replacement empty Unicode and iframe cases',
  'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched',
  'hidden isolated Chromium composer validates real layout and one-click send wiring',
  'installed Himalaya sends exact MIME to disposable loopback SMTP and strips Bcc headers',
  'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart',
]);

export async function verifyReleaseSource(request, directory) {
  request = validateReleaseRequest(request);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  check(metadata.version === request.version, 'Requested version does not match the source.');
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], { cwd: directory });
  check(head.trim() === request.sourceCommit, 'Checkout does not match the requested source commit.');
  const { stdout: inventory } = await execute('git', ['ls-files', '-z'], { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
  const tracked = new Set(inventory.split('\0').filter(Boolean));
  check(tracked.has(request.notes), 'Current release notes are not tracked in the requested source.');
  const fingerprint = await appFingerprint(directory);
  check(fingerprint === request.appFingerprint, 'Requested application fingerprint does not match the source.');
  const { records, sourceIndexSha256 } = await releaseSourceIndex(directory);
  const receipt = await readWindowsSourceTestReceipt({ directory, receiptPath: request.sourceTestReceipt,
    version: request.version, appFingerprint: fingerprint, tracked, sourceIndexSha256 });
  const receiptBytes = await fs.readFile(path.join(directory, request.sourceTestReceipt));
  check(createHash('sha256').update(receiptBytes).digest('hex') === receipt.receiptSha256, 'Source-test receipt changed during verification.');
  const prior = JSON.parse(receiptBytes);
  check(prior.passed === true && prior.fullSuite === true && prior.countsComplete === true &&
    prior.sourceUnchanged === true && prior.execution?.uniqueCoverageVerified === true,
    'Prior source receipt does not establish a passed full suite with unchanged, unique coverage.');
  const testFiles = records.filter(record => /^tests\/[^/]+\.test\.mjs$/.test(record.path)).map(record => record.path).sort();
  check(testFiles.length > 0 && prior.testFiles === testFiles.length &&
    prior.testInventorySha256 === createHash('sha256').update(JSON.stringify(testFiles)).digest('hex') &&
    receipt.tests.total >= testFiles.length && prior.tests.todo === 0,
    'Prior full-suite test inventory is incomplete or does not match the current source.');
  check(Array.isArray(prior.optionalSkips) && prior.optionalSkips.length === receipt.tests.optionalSkipped &&
    new Set(prior.optionalSkips).size === prior.optionalSkips.length && prior.optionalSkips.every(name => optionalWindowsSourceTests.has(name)),
    'Prior source receipt contains an unexpected or unaccounted skipped test.');
  return { sourceCommit: request.sourceCommit, appFingerprint: fingerprint, sourceIndexSha256, receiptSha256: receipt.receiptSha256,
    tests: receipt.tests };
}

export async function verifyReleaseArtifact(request, distribution) {
  request = validateReleaseRequest(request);
  const manifest = JSON.parse(await fs.readFile(path.join(distribution, 'blackice-public-release.json'), 'utf8'));
  const expectedName = 'Blackice-' + request.version + '-Setup.exe';
  check(manifest.format === 1 && manifest.product === 'BLACKICE' && manifest.version === request.version &&
    manifest.appFingerprint === request.appFingerprint && manifest.artifact?.name === expectedName,
    'Installer manifest does not match the requested source and version.');
  check(Number.isSafeInteger(manifest.artifact.size) && manifest.artifact.size > 0 &&
    typeof manifest.artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.artifact.sha256),
    'Installer manifest has invalid size or checksum.');
  const installer = path.join(distribution, expectedName), stat = await fs.lstat(installer);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size === manifest.artifact.size, 'Installer size does not match its manifest.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const digest = hash.digest('hex');
  check(digest === manifest.artifact.sha256, 'Installer checksum does not match its manifest.');
  return { installerName: expectedName, installerSha256: digest, installerBytes: stat.size };
}

export async function releaseSourceIndex(directory) {
  const records = [];
  async function visit(relative) {
    // This local baseline copy imports private verification backups and is never release source.
    if (relative === 'tests/browser-debug-baseline-check.mjs') return;
    if (relative.split('/').some(part => part.includes('.currents-backup-') || part.endsWith('.ownership-backup'))) return;
    const file = path.join(directory, relative), info = await fs.lstat(file);
    check(!info.isSymbolicLink(), 'Tested source inventory cannot contain links.');
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(relative + '/' + name);
    } else {
      check(info.isFile(), 'Tested source inventory requires regular files.');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      records.push({ path: relative, size: info.size, sha256: hash.digest('hex') });
    }
  }
  for (const relative of ['.gitattributes', '.gitignore', 'package.json', 'package-lock.json', 'server.mjs',
    'lib', 'public', 'desktop', 'scripts', 'tests', '.github/workflows']) await visit(relative);
  records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { records, sourceIndexSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

export async function verifyReleaseAssetCopies(request, directory, expected) {
  request = validateReleaseRequest(request);
  const names = { installerSha256: 'Blackice-' + request.version + '-Setup.exe',
    manifestSha256: 'blackice-public-release.json', checksumsSha256: 'SHA256SUMS.txt' };
  for (const [key, name] of Object.entries(names)) {
    check(typeof expected?.[key] === 'string' && /^[a-f0-9]{64}$/.test(expected[key]), 'Exact pre-verification asset checksums are required.');
    const file = path.join(directory, name), info = await fs.lstat(file);
    check(info.isFile() && !info.isSymbolicLink(), 'Publication asset must be a regular file.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    check(hash.digest('hex') === expected[key], 'Publication asset changed after installer verification: ' + name);
  }
  return { ...(await verifyReleaseArtifact(request, directory)), publicationAssetsVerified: true };
}

const shaPattern = /^[a-f0-9]{40}$/;
const tagModes = new Set(['inspect', 'verify', 'ensure']);

// GitHub's release targetCommitish is declarative metadata. Source archives use
// the actual tag ref, which may instead point through one or more annotated tags.
export async function bindReleaseTag(request, { repository, api, mode = 'verify', distribution } = {}) {
  request = validateReleaseRequest(request);
  check(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'An exact GitHub repository is required.');
  check(typeof api === 'function' && tagModes.has(mode), 'Choose a supported GitHub tag operation.');
  check(mode !== 'ensure' || distribution, 'Verify candidate bytes before creating a release tag.');
  const candidate = mode === 'ensure' ? await verifyReleaseArtifact(request, distribution) : {};
  const ref = 'refs/tags/' + request.tag, base = '/repos/' + repository + '/git';
  const endpoint = base + '/ref/tags/' + encodeURIComponent(request.tag);
  let response = await api('GET', endpoint), created = false;
  if (response.status === 404) {
    if (mode === 'inspect') return { tagPresent: false, tagCreated: false };
    check(mode === 'ensure', 'The requested release tag is missing.');
    const creation = await api('POST', base + '/refs', { ref, sha: request.sourceCommit });
    // A concurrent exact creation may win. Never update or force a tag: read the
    // existing ref again and require its immutable commit to match this request.
    check(creation.status === 201 || creation.status === 422, 'Release tag creation failed.');
    created = creation.status === 201;
    response = await api('GET', endpoint);
  }
  check(response.status === 200 && response.data?.ref === ref, 'Release tag lookup failed or returned a different ref.');
  let object = response.data.object;
  const referenceSha = object?.sha, seen = new Set();
  for (let depth = 0; depth <= 8; depth++) {
    check(object && shaPattern.test(object.sha || ''), 'Release tag contains an invalid object.');
    if (object.type === 'commit') {
      check(object.sha === request.sourceCommit, 'Release tag points at a different source commit.');
      return { ...candidate, tagPresent: true, tagCreated: created, tagCommit: object.sha, tagReferenceSha: referenceSha, tagDepth: depth };
    }
    check(object.type === 'tag', 'Release tag does not resolve to a commit.');
    check(!seen.has(object.sha), 'Release tag contains an annotation cycle.');
    check(depth < 8, 'Release tag annotation depth exceeds the bounded limit.');
    seen.add(object.sha);
    const annotation = await api('GET', base + '/tags/' + object.sha);
    check(annotation.status === 200 && annotation.data?.sha === object.sha, 'Release tag annotation lookup failed.');
    object = annotation.data.object;
  }
  throw new Error('Release tag could not be resolved.');
}

function githubTagApi(token) {
  check(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required for GitHub tag checks.');
  return async (method, endpoint, body) => {
    const response = await fetch('https://api.github.com' + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BLACKICE-release-request', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    check(text.length <= 1000000, 'GitHub tag response exceeded its bounded size.');
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error('GitHub tag response was not valid JSON.'); }
    return { status: response.status, data };
  };
}

async function main() {
  const args = process.argv.slice(2), value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const file = value('--request');
  check(file, 'Use --request FILE and optionally --source DIRECTORY or --distribution DIRECTORY.');
  const request = validateReleaseRequest(JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')), { sourceCommit: value('--source-commit') });
  check(!(value('--source') && value('--distribution')), 'Inspect source and distribution separately.');
  const tagMode = value('--github-tag');
  check(!tagMode || tagModes.has(tagMode), 'Choose inspect, verify or ensure for --github-tag.');
  check(!tagMode || !value('--source') && (!value('--distribution') || tagMode === 'ensure'), 'Inspect GitHub tag identity separately from local source.');
  const publicationAssets = value('--publication-assets');
  check(!publicationAssets || !tagMode && !value('--source') && !value('--distribution'), 'Inspect publication asset copies separately.');
  let result = { ...request };
  if (value('--source')) result = { ...result, ...(await verifyReleaseSource(request, value('--source'))) };
  if (value('--distribution') && !tagMode) result = { ...result, ...(await verifyReleaseArtifact(request, value('--distribution'))) };
  if (tagMode) result = { ...result, ...(await bindReleaseTag(request, { repository: process.env.GITHUB_REPOSITORY,
    api: githubTagApi(process.env.GH_TOKEN), mode: tagMode, distribution: value('--distribution') })) };
  if (publicationAssets) result = { ...result, ...(await verifyReleaseAssetCopies(request, publicationAssets, {
    installerSha256: process.env.EXPECTED_SHA256, manifestSha256: process.env.EXPECTED_MANIFEST_SHA256,
    checksumsSha256: process.env.EXPECTED_CHECKSUMS_SHA256 })) };
  if (args.includes('--github-output')) {
    check(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is unavailable.');
    const keys = ['version', 'sourceCommit', 'appFingerprint', 'sourceTestReceipt', 'publish', 'tag', 'notes', 'installerName', 'installerSha256', 'installerBytes', 'sourceIndexSha256'];
    await fs.appendFile(process.env.GITHUB_OUTPUT, keys.filter(key => result[key] !== undefined).map(key => key + '=' + result[key]).join('\n') + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
