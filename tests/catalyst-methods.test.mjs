import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CATALYST_METHODS, CATALYST_CATALOG_INFO, CATALYST_CATALOG_SHA256, catalystMethodId } from '../lib/catalyst-methods.mjs';
import { BUILTIN_TASK_TYPES, BUILTIN_STEP_TYPES, validateMethod } from '../lib/process-ontology.mjs';
import { createMethodSearchIndex } from '../lib/method-catalog.mjs';
import { CATALYST_SOURCE, CATALYST_VENDOR_DIR, CATALYST_NOTICE, readPinnedCatalystSource } from '../scripts/import-catalyst-catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const catalogBytes = await readFile(path.join(CATALYST_VENDOR_DIR, 'catalog.json'));
const catalog = JSON.parse(catalogBytes);
const byId = new Map(CATALYST_METHODS.map(method => [method.id, method]));

test('Catalyst import retains the complete pinned method corpus, not a list of names', () => {
  assert.equal(digest(catalogBytes), CATALYST_CATALOG_SHA256);
  assert.equal(CATALYST_CATALOG_INFO.methods, 581);
  assert.equal(CATALYST_CATALOG_INFO.steps, 2906);
  assert.equal(CATALYST_CATALOG_INFO.specificCatalogWorkflows, 486);
  assert.equal(CATALYST_CATALOG_INFO.domains.length, 16);
  assert.equal(CATALYST_CATALOG_INFO.clusters.length, 27);
  assert.equal(CATALYST_METHODS.length, byId.size);
  assert.equal(CATALYST_METHODS.reduce((sum, method) => sum + method.steps.length, 0), 2906);
  assert.deepEqual(catalog.referenceIssues, []);
  for (const method of CATALYST_METHODS) {
    assert.ok(method.steps.length >= 4, method.name);
    assert.ok(new Set(method.steps.map(step => step.instructions)).size === method.steps.length, method.name);
    assert.ok(method.catalog.prerequisites.length > 0, method.name);
    assert.ok(method.catalog.outputs.length > 0, method.name);
  }
});

test('every adapted method preserves every original prompt, step order, title and source reference', () => {
  for (const record of catalog.techniques) {
    const source = record.definition, method = byId.get(catalystMethodId(source.id));
    assert.ok(method, source.id);
    assert.equal(method.name, source.name);
    assert.equal(method.description, source.summary);
    assert.deepEqual(method.steps.map(step => step.id), source.steps.map(step => step.id));
    assert.deepEqual(method.steps.map(step => step.title), source.steps.map(step => step.title));
    assert.deepEqual(method.catalog.references, record.metadata.references);
    assert.deepEqual(method.catalog.aliases, record.metadata.aliases);
    assert.equal(method.provenance.sourceDefinitionSha256, digest(JSON.stringify(source)));
    assert.equal(method.provenance.sourceId, source.id);
    assert.equal(method.provenance.commit, CATALYST_SOURCE.commit);
    for (const [index, sourceStep] of source.steps.entries()) {
      assert.ok(method.steps[index].instructions.split('\n\n').includes(sourceStep.prompt), `${source.id}:${sourceStep.id}`);
      assert.ok(method.steps[index].checks.some(check => check.includes(sourceStep.prompt)), `${source.id}:${sourceStep.id} completion`);
      assert.equal(method.provenance.sourceStepFormats[index].responseKind, sourceStep.responseKind);
      if (sourceStep.placeholder) assert.ok(method.steps[index].instructions.includes(sourceStep.placeholder));
    }
  }
});

test('adapted definitions satisfy BLACKICE runtime schemas and remain reusable as ordered project methods', () => {
  const ontology = { taskTypes: BUILTIN_TASK_TYPES, stepTypes: BUILTIN_STEP_TYPES };
  for (const method of CATALYST_METHODS) {
    const validated = validateMethod(method, ontology);
    assert.equal(validated.steps.length, method.steps.length, method.id);
    assert.equal(method.outline, undefined, 'Ordered methods must remain usable in ProjectStore, which rejects branching outlines.');
    assert.equal(method.origin, 'builtin');
    assert.equal(method.verification, 'unverified');
    assert.equal(method.createdAt, null);
    assert.equal(method.updatedAt, null);
    for (const step of method.steps) {
      assert.ok(step.result.length <= 1000, method.id);
      assert.ok(step.checks.join(' ').length <= 1000, method.id);
    }
    assert.ok(Object.isFrozen(method.steps[0]), method.id);
  }
});

test('method relationship IDs and playbooks resolve without depending on visible names or fuzzy search', () => {
  for (const method of CATALYST_METHODS) {
    for (const field of ['recommendedNext', 'useBefore', 'useAfter', 'alternatives']) for (const target of method.catalog[field]) {
      assert.ok(byId.has(target), `${method.id}:${field}:${target}`);
      assert.notEqual(target, method.id);
    }
  }
  assert.ok(CATALYST_CATALOG_INFO.playbooks.length >= 10);
  for (const playbook of CATALYST_CATALOG_INFO.playbooks) for (const step of playbook.steps) {
    assert.equal(byId.get(step.methodId)?.name, step.name);
    assert.ok(step.role.length > 20);
  }
  const ach = byId.get('catalyst-ach');
  assert.deepEqual(ach.catalog.alternatives, ['catalyst-catalog-intelligence-discriminating-evidence-matrix']);
  assert.ok(ach.catalog.useBefore.includes('catalyst-key-assumptions-check'));
});

test('method discovery finds named, alias and cross-domain methods with substantive detail behind the result', () => {
  const search = createMethodSearchIndex(CATALYST_METHODS);
  for (const [query, id] of [
    ['ACH', 'catalyst-ach'],
    ['Difference-in-Differences', 'catalyst-catalog-research-difference-in-differences'],
    ['Linear Programming', 'catalyst-catalog-operations-research-linear-programming'],
    ['Rhetorical Criticism', 'catalyst-catalog-literary-rhetorical-criticism'],
    ['Bowtie Analysis', 'catalyst-bow-tie-analysis']
  ]) assert.equal(search.search({ query, limit: 1 }).methods[0].id, id, query);
  const causal = search.search({ query: 'parallel trends', domain: 'research', phase: 'causal', output: 'estimate' });
  assert.ok(causal.methods.some(method => method.id === 'catalyst-catalog-research-difference-in-differences'));
  const ach = byId.get('catalyst-ach');
  assert.equal(ach.steps.length, 6);
  assert.ok(ach.catalog.prerequisites.includes('At least two plausible hypotheses'));
  assert.ok(ach.steps.some(step => step.instructions.includes('evidence that discriminates among alternatives')));
  assert.ok(ach.catalog.references.some(reference => reference.href.startsWith('https://www.cia.gov/')));
});

test('stable IDs reject unexpected source identifiers and imported definitions cannot mutate each other', () => {
  assert.equal(catalystMethodId('builtin:ach'), 'catalyst-ach');
  for (const id of ['ach', 'custom:ach', 'builtin:../ach', 'builtin:', 'builtin:unsafe/id', `builtin:${'x'.repeat(101)}`]) assert.throws(() => catalystMethodId(id));
  assert.throws(() => { CATALYST_METHODS[0].steps[0].instructions = 'changed'; }, TypeError);
  assert.throws(() => { CATALYST_CATALOG_INFO.domains[0].label = 'changed'; }, TypeError);
});

test('bundled source, licenses and adaptation notice are bound to their exact pinned bytes', async () => {
  const pinned = await readPinnedCatalystSource(path.join(CATALYST_VENDOR_DIR, 'upstream'));
  assert.equal(pinned.files.size, 39);
  assert.equal(digest(pinned.manifestBytes), CATALYST_SOURCE.retrievalManifestSha256);
  for (const name of ['LICENSE.txt', 'LICENSES.md']) assert.deepEqual(await readFile(path.join(CATALYST_VENDOR_DIR, name)), pinned.files.get(name));
  assert.equal(await readFile(path.join(CATALYST_VENDOR_DIR, 'NOTICE.md'), 'utf8'), CATALYST_NOTICE);
  assert.match(CATALYST_NOTICE, /BLACKICE changes the presentation and execution integration/);
  for (const method of CATALYST_METHODS) for (const file of method.provenance.sourceFiles) {
    assert.ok(pinned.files.has(file.path), method.id);
    assert.equal(digest(pinned.files.get(file.path)), file.sha256, file.path);
  }
});

test('offline regeneration reproduces every imported file byte for byte', { timeout: 20000 }, () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', 'scripts/import-catalyst-catalog.mjs', '--check'], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 200000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.mode, 'verified');
  assert.equal(receipt.techniques, 581);
  assert.equal(receipt.steps, 2906);
  assert.equal(receipt.catalogSha256, CATALYST_CATALOG_SHA256);
});

test('the importer rejects changed manifests and changed source instead of silently refreshing the catalog', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-catalyst-pin-'));
  try {
    await cp(path.join(CATALYST_VENDOR_DIR, 'upstream'), directory, { recursive: true });
    const manifest = await readFile(path.join(directory, 'retrieval-manifest.json'));
    await writeFile(path.join(directory, 'retrieval-manifest.json'), `${manifest}\n`);
    await assert.rejects(readPinnedCatalystSource(directory), /retrieval manifest does not match/);
    await writeFile(path.join(directory, 'retrieval-manifest.json'), manifest);
    await writeFile(path.join(directory, 'src', 'domain', 'techniques.ts'), '// changed source\n');
    await assert.rejects(readPinnedCatalystSource(directory), /source bytes changed: src\/domain\/techniques.ts/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
