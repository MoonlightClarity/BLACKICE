import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILTIN_METHODS, BUILTIN_TASK_TYPES, BUILTIN_STEP_TYPES } from '../lib/process-ontology.mjs';
import { createMethodSearchIndex, normalizeMethodSearch, validateMethodCatalog, METHOD_CATALOG_LIMITS } from '../lib/method-catalog.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { createTaskToolHandler, taskInstructionsForVersion, taskToolForVersion } from '../lib/task-state.mjs';

const index = createMethodSearchIndex(BUILTIN_METHODS);
const definition = () => ({ name: 'Fixture source assessment', description: 'Compare original observations.', taskType: 'analysis', inputs: [], catalog: { domain: 'research', aliases: ['Fixture source check'], phases: ['evaluate-evidence'], outputs: ['matrix'], prerequisites: ['At least two original observations.'], avoidWhen: ['Only unsupported claims are available.'] }, steps: [{ id: 'assess', title: 'Assess the observations', type: 'analyze', instructions: 'Compare the dated original observations and identify independent support, contradictions and missing information.', inputs: ['Original observations'], result: 'An attributed comparison.', checks: ['Each supported claim identifies its original observation.'] }] });

test('the expanded catalog returns bounded summaries and every saved method is reachable through consistent pages', () => {
  const first = index.search(); assert.equal(first.totalMethods, 589); assert.equal(first.limit, 20); assert.equal(first.methods.length, 20); assert.equal(first.offset, 0); assert.equal(first.nextOffset, 20);
  assert.ok(JSON.stringify(first).length < 30000); assert.ok(first.methods.every(method => !Object.hasOwn(method, 'steps') && !Object.hasOwn(method, 'provenance')));
  const ids = first.methods.map(method => method.id); let next = first.nextOffset;
  while (next !== null) { const page = index.search({ offset: next, catalogRevision: first.catalogRevision }); assert.equal(page.catalogRevision, first.catalogRevision); assert.ok(page.methods.length <= 20); ids.push(...page.methods.map(method => method.id)); next = page.nextOffset; }
  assert.equal(ids.length, 589); assert.equal(new Set(ids).size, ids.length); assert.deepEqual([...ids].sort(), BUILTIN_METHODS.map(method => method.id).sort());
  first.facets.domains[0].label = 'Changed response'; assert.notEqual(index.search().facets.domains[0].label, first.facets.domains[0].label);
});

test('task intent, aliases, deep procedure text and exact facets retrieve meaningful methods without a suitability score', () => {
  const result = index.search({ query: 'ACH', domain: 'intelligence', phase: 'compare-hypotheses', output: 'matrix' });
  assert.equal(result.methods[0].id, 'catalyst-ach'); assert.equal(result.total, 1); assert.ok(result.methods[0].match.fields.includes('aliases')); assert.equal(Object.hasOwn(result.methods[0], 'score'), false);
  const causal = index.search({ query: 'parallel trends', domain: 'research', phase: 'causal', output: 'estimate' });
  assert.ok(causal.methods.some(method => method.id === 'catalyst-catalog-research-difference-in-differences'));
  assert.equal(index.search({ query: 'xyzyq-utterly-nonexistent' }).total, 0); assert.match(result.note, /not a suitability/);
  for (const facet of ['domains', 'phases', 'outputs']) assert.ok(result.facets[facet].length > 10);
  const literal = index.search({ query: '  difference—in differences  ', limit: 1 }); assert.equal(literal.methods[0].id, 'catalyst-catalog-research-difference-in-differences');
});

test('search rejects malformed or unbounded options and refuses mixed catalog revisions', () => {
  for (const value of [{ limit: 0 }, { limit: 41 }, { limit: '20' }, { offset: -1 }, { offset: 10001 }, { query: 'x'.repeat(501) }, { query: 'bad\0input' }, { unknown: true }, { catalogRevision: 'forged' }]) assert.throws(() => normalizeMethodSearch(value));
  assert.throws(() => index.search({ offset: 20 }), { code: 'METHOD_CATALOG_CONFLICT', status: 409 });
  assert.throws(() => index.search({ offset: 20, catalogRevision: '0'.repeat(64) }), { code: 'METHOD_CATALOG_CONFLICT', status: 409 });
  assert.equal(METHOD_CATALOG_LIMITS.pageSize, 20); assert.equal(index.search({ query: 'ACH', domain: 'unavailable-domain' }).total, 0);
});

test('custom metadata survives storage, contributes to discovery, and invalidates a prior page after editing', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-method-search-')), methods = await new MethodStore({ dataDir: root, projects: { definition() { assert.fail('Search must not prepare execution.'); }, create() { assert.fail('Search must not start execution.'); } } }).init();
  t.after(async () => { await methods.close(); await rm(root, { recursive: true, force: true }); });
  const before = methods.search(), saved = await methods.create(definition());
  assert.deepEqual(methods.get(saved.id).catalog, definition().catalog); assert.equal(methods.search({ query: 'Fixture source check' }).methods[0].id, saved.id);
  assert.throws(() => methods.search({ offset: 20, catalogRevision: before.catalogRevision }), { code: 'METHOD_CATALOG_CONFLICT' });
  const current = methods.search(); await methods.update(saved.id, { expectedRevision: saved.revision, catalog: { ...saved.catalog, aliases: ['Fixture independent support'] } });
  assert.throws(() => methods.search({ offset: 20, catalogRevision: current.catalogRevision }), { code: 'METHOD_CATALOG_CONFLICT' });
  assert.equal(methods.search({ query: 'Fixture independent support' }).methods[0].id, saved.id);
  await methods.close(); const reopened = await new MethodStore({ dataDir: root, projects: methods.projects }).init();
  try { assert.equal(reopened.search({ query: 'Fixture independent support' }).methods[0].id, saved.id); } finally { await reopened.close(); }
});

test('metadata accepts plain descriptive data and rejects executable or credentialed reference URLs', () => {
  const catalog = definition().catalog; assert.deepEqual(validateMethodCatalog(catalog), catalog);
  for (const href of ['javascript:alert(1)', 'file:///private', 'https://user:secret@example.com']) assert.throws(() => validateMethodCatalog({ references: [{ label: 'Reference', href }] }));
  for (const value of [{ domain: 'bad domain' }, { effort: 'guaranteed' }, { aliases: ['duplicate', 'duplicate'] }, { certified: true }]) assert.throws(() => validateMethodCatalog(value));
  assert.deepEqual(validateMethodCatalog({ references: [{ label: '<script>literal text</script>', href: 'https://example.com/source' }] }).references[0].label, '<script>literal text</script>');
});

test('v5 relay_task describes bounded results and exact definitions without changing task state or running work', async () => {
  let reads = 0; const store = { get() { reads++; assert.fail('Method discovery must not alter or require a task-state read.'); } };
  const handler = createTaskToolHandler({ store, taskId: 'search-task', runId: 'search-run', nodeId: 'agent', schemaVersion: 5 }), call = args => handler({ name: 'relay_task', arguments: args });
  let response = await call({ action: 'describe' }); assert.equal(response.success, true); const page = JSON.parse(response.contentItems[0].text);
  assert.equal(page.schemaVersion, 5); assert.equal(page.methods.length, 20); assert.equal(page.totalMethods, 589); assert.ok(page.ontology.taskTypes.length >= 7);
  response = await call({ action: 'describe', methodQuery: 'ACH', methodDomain: 'intelligence', methodOutput: 'matrix' }); const matches = JSON.parse(response.contentItems[0].text); assert.equal(matches.methods[0].id, 'catalyst-ach');
  response = await call({ action: 'describe', methodId: 'catalyst-ach', methodRevision: 1 }); assert.equal(response.success, true); const complete = JSON.parse(response.contentItems[0].text);
  assert.deepEqual(complete.method, BUILTIN_METHODS.find(method => method.id === 'catalyst-ach')); assert.equal(complete.pagination.complete, true); assert.equal(complete.method.steps.length, 6); assert.ok(complete.method.catalog.prerequisites.length); assert.ok(complete.method.provenance);
  response = await call({ action: 'describe', methodId: 'catalyst-ach', methodRevision: 2 }); assert.equal(response.code, 'TASK_METHOD_CONFLICT');
  response = await call({ action: 'describe', methodId: 'catalyst-ach', methodQuery: 'ACH' }); assert.equal(response.success, false);
  const instructions = taskInstructionsForVersion(5, { executionGuardrails: true });
  assert.equal(reads, 0); assert.match(instructions, /Choose and adapt automatically/); assert.match(instructions, /two or three methods/); assert.match(instructions, /supply methodSteps/);
});

test('saved v4 tools retain their declared compact catalog while rejecting fields introduced only by v5', async () => {
  const handler = createTaskToolHandler({ store: {}, taskId: 'v4-task', runId: 'v4-run', nodeId: 'agent', schemaVersion: 4 });
  for (const args of [{ action: 'describe', methodQuery: 'ACH' }, { action: 'describe', methodOffset: 20 }, { action: 'draft_method', methodSteps: definition().steps }, { action: 'draft_method', methodCatalog: definition().catalog }]) {
    const response = await handler({ name: 'relay_task', arguments: args }); assert.equal(response.code, 'TASK_SCHEMA_UNSUPPORTED');
  }
  const response = await handler({ name: 'relay_task', arguments: { action: 'describe' } }); assert.equal(response.success, true); const catalog = JSON.parse(response.contentItems[0].text);
  assert.equal(catalog.methods.length, 589); assert.ok(catalog.methods.some(method => method.id === 'catalyst-ach')); assert.ok(response.contentItems[0].text.length < 128000);
  assert.equal(taskToolForVersion(4).inputSchema.properties.methodQuery, undefined); assert.equal(taskToolForVersion(4).inputSchema.properties.methodSteps, undefined);
  assert.equal(taskToolForVersion(5).inputSchema.properties.methodSteps.maxItems, 200);
});

test('an unhealthy optional library falls back to the actual bundled methods and says which catalog was loaded', async () => {
  const methods = { status: () => ({ healthy: false, error: 'Saved custom file cannot be read.' }), ontology() { assert.fail('Unavailable custom vocabulary must not be used.'); }, list() { assert.fail('Unavailable custom definitions must not be used.'); } };
  const handler = createTaskToolHandler({ store: {}, taskId: 'fallback-task', methods });
  const response = await handler({ name: 'relay_task', arguments: { action: 'describe', methodQuery: 'ACH' } }); assert.equal(response.success, true);
  const page = JSON.parse(response.contentItems[0].text); assert.equal(page.libraryStatus.source, 'builtin-methods'); assert.equal(page.libraryStatus.healthy, false); assert.equal(page.methods[0].id, 'catalyst-ach');
  assert.deepEqual(page.ontology.taskTypes.map(item => item.id), BUILTIN_TASK_TYPES.map(item => item.id)); assert.deepEqual(page.ontology.stepTypes.map(item => item.id), BUILTIN_STEP_TYPES.map(item => item.id));
});
