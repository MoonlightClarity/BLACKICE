import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDirectExecutionContextTool } from '../lib/direct-execution-context.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { InstructionStore } from '../lib/instruction-store.mjs';
import { createSkillsCatalog } from '../lib/skills-catalog.mjs';
import { SkillEditStore } from '../lib/skill-edits.mjs';

const name = 'blackice_execution_context';
const hash = text => createHash('sha256').update(text).digest('hex');
const record = (content, revision = 4) => ({ content, revision, hash: hash(content), source: 'user', updatedAt: '2026-01-01T00:00:00.000Z' });
let request = 0;
const read = async (tool, args) => JSON.parse((await tool.execute({ requestId: 'context-' + (++request), ...args })).contentItems[0].text);
async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-execution-context-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test('saved owner Instructions are exact, fresh and allowed to be empty without a default fallback', async t => {
  const dataDir = await directory(t), store = new InstructionStore({ dataDir, defaultContent: 'Packaged seed' });
  await store.init(); t.after(() => store.close());
  let saved = await store.read();
  saved = await store.update({ content: 'Owner text\nKeep this exact spacing.  ', expectedRevision: saved.revision, expectedHash: saved.hash });
  const tool = createDirectExecutionContextTool({ instructionSettings: store });
  const bytes = await fs.readFile(store.file, 'utf8');
  const first = await read(tool, { action: 'instructions' });
  assert.equal(first.content, saved.content); assert.equal(first.source.hash, saved.hash);
  assert.equal(first.source.origin, 'user'); assert.equal(first.source.revision, saved.revision);
  assert.equal(first.truncated, false); assert.equal(first.nextOffset, null);
  assert.ok(Number.isFinite(Date.parse(first.observedAt)));
  assert.equal((await tool.discoveryInstructions()).text, saved.content);
  assert.equal(await fs.readFile(store.file, 'utf8'), bytes, 'Context reads do not rewrite owner Instructions.');
  saved = await store.update({ content: '', expectedRevision: saved.revision, expectedHash: saved.hash });
  const empty = await read(tool, { action: 'instructions' }), delivery = await tool.discoveryInstructions();
  assert.equal(empty.content, ''); assert.equal(empty.totalCharacters, 0); assert.equal(empty.nextOffset, null);
  assert.equal(empty.source.hash, hash('')); assert.equal(empty.source.revision, saved.revision);
  assert.equal(delivery.metadata.instructions.status, 'empty'); assert.equal(delivery.text, '');
});

test('oversized saved Instructions are not partially injected and page losslessly across Unicode boundaries', async () => {
  const content = 'A😀'.repeat(6000) + 'tail', tool = createDirectExecutionContextTool({ instructionSettings: { read: async () => record(content) } });
  const delivery = await tool.discoveryInstructions();
  assert.equal(delivery.metadata.instructions.status, 'paginated');
  assert.equal(delivery.metadata.instructions.characters, content.length);
  assert.equal(delivery.text.includes(content.slice(0, 100)), false, 'No policy excerpt is presented as complete.');
  let offset = 0, reconstructed = '', pages = 0;
  do {
    const result = await read(tool, { action: 'instructions', offset, maxChars: 127, ...(offset ? { expectedHash: hash(content) } : {}) });
    assert.ok(result.returnedCharacters > 0 && result.returnedCharacters <= 127);
    assert.equal(result.content, content.slice(offset, offset + result.returnedCharacters));
    assert.equal(/[\uD800-\uDBFF]$/.test(result.content), false);
    assert.equal(/^[\uDC00-\uDFFF]/.test(result.content), false);
    reconstructed += result.content; pages++;
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  } while (pages < 1000);
  assert.equal(reconstructed, content); assert.ok(pages > 1);
});

test('paging rejects split offsets, non-advancing sizes and changed content without silently mixing revisions', async () => {
  let saved = record('A😀BC'), tool = createDirectExecutionContextTool({ instructionSettings: { read: async () => saved } });
  const first = await read(tool, { action: 'instructions', maxChars: 2 });
  assert.equal(first.content, 'A'); assert.equal(first.nextOffset, 1);
  const second = await read(tool, { action: 'instructions', offset: 1, maxChars: 2, expectedHash: first.source.hash });
  assert.equal(second.content, '😀'); assert.equal(second.nextOffset, 3);
  await assert.rejects(read(tool, { action: 'instructions', offset: 2, expectedHash: first.source.hash }), { code: 'EXECUTION_CONTEXT_INVALID' });
  await assert.rejects(read(tool, { action: 'instructions', maxChars: 1 }), { code: 'EXECUTION_CONTEXT_INVALID' });
  await assert.rejects(read(tool, { action: 'instructions', offset: 1 }), { code: 'EXECUTION_CONTEXT_INVALID' });
  saved = record('A😀changed', 5);
  await assert.rejects(read(tool, { action: 'instructions', offset: second.nextOffset, expectedHash: first.source.hash }), error => {
    assert.equal(error.code, 'EXECUTION_CONTEXT_CHANGED'); assert.equal(error.current.source.revision, 5);
    assert.equal(error.current.source.hash, hash(saved.content)); return true;
  });
});

test('identity reads use the native projection and retain source metadata, fallback warnings and unavailability', async () => {
  const calls = [], projected = {
    ...record('Enduring owner preference'), kind: 'user', fileName: 'USER.md',
    sourceHash: hash('raw profile with task learning'), sourceChars: 100,
    projection: 'global-profile-without-automatic-task-learning', excludedLearnedEntries: 1,
    provenance: { source: 'user' }, warning: 'The last valid revision is being used.',
  };
  const tool = createDirectExecutionContextTool({ identity: {
    read() { assert.fail('Raw identity reads must not replace the native projection.'); },
    async readForContext(kind) {
      calls.push(kind);
      return kind === 'user' ? projected : { ...record(''), fileName: 'SOUL.md', provenance: { source: 'unavailable' }, warning: 'The file is omitted until repaired.' };
    },
    update() { assert.fail('A context read must not update identity.'); },
    close() { assert.fail('The adapter does not own this store.'); },
  } });
  const user = await read(tool, { action: 'identity', kind: 'user' });
  assert.equal(user.content, projected.content); assert.equal(user.source.hash, hash(projected.content));
  assert.equal(user.source.sourceHash, projected.sourceHash); assert.equal(user.source.sourceCharacters, 100);
  assert.equal(user.source.projection, projected.projection); assert.equal(user.source.excludedLearnedEntries, 1);
  assert.equal(user.availability, 'fallback'); assert.equal(user.warning, projected.warning);
  const soul = await read(tool, { action: 'identity', kind: 'soul' });
  assert.equal(soul.availability, 'unavailable'); assert.equal(soul.content, ''); assert.match(soul.warning, /omitted/);
  assert.deepEqual(calls, ['user', 'soul']);
});

test('effective skill discovery and reads honor real owner edits and deletions without writes or body leakage', async t => {
  const dataDir = await directory(t), catalog = createSkillsCatalog({ dataDir });
  t.after(() => catalog.close());
  const id = 'builtin-decomposition', edited = await catalog.save({ id, value: { content: '# Owner method\nUse the current owner method.', expectedRevision: 1 } });
  const store = new SkillEditStore({ dataDir }); t.after(() => store.close());
  const before = { metadata: await store.listMetadata(), record: await store.readOne(id) };
  const tool = createDirectExecutionContextTool({ skillsCatalog: catalog });
  const first = await read(tool, { action: 'skill_search', limit: 2 });
  assert.equal(first.entries.length, 2); assert.equal(first.nextOffset, 2); assert.equal(first.truncated, true);
  assert.ok(first.entries.every(entry => !Object.hasOwn(entry, 'content')));
  const next = await read(tool, { action: 'skill_search', limit: 2, offset: first.nextOffset });
  assert.equal(next.entries.length, 2); assert.notEqual(next.entries[0].id, first.entries[0].id);
  const found = await read(tool, { action: 'skill_search', query: 'Owner method' });
  assert.ok(found.entries.some(entry => entry.id === id && entry.source === 'user'));
  const detail = await read(tool, { action: 'skill_read', id });
  assert.equal(detail.content, edited.content); assert.equal(detail.source.origin, 'user'); assert.equal(detail.source.revision, edited.revision);
  assert.equal(detail.source.hash, hash(edited.content));
  assert.deepEqual({ metadata: await store.listMetadata(), record: await store.readOne(id) }, before, 'Context reads preserve owner records and generation.');
  await catalog.delete({ id, value: { expectedRevision: edited.revision } });
  await assert.rejects(read(tool, { action: 'skill_read', id }), { status: 404 });
  assert.ok(!(await read(tool, { action: 'skill_search', query: 'Owner method' })).entries.some(entry => entry.id === id));
});


test('skill discovery follows deep pages past 11000 with bounded body-free results and exact on-demand reads', async () => {
  const entries = Array.from({ length: 11103 }, (_, index) => ({
    id: 'library-deep-' + index, title: 'Deep method ' + index, source: 'bundled', revision: 3,
    content: 'Full current body for deep method ' + index,
  }));
  const calls = []; let bodyReads = 0;
  const tool = createDirectExecutionContextTool({ skillsCatalog: {
    async list(args) {
      calls.push(args);
      const page = entries.slice(args.offset, args.offset + args.limit);
      const nextOffset = args.offset + page.length < entries.length ? args.offset + page.length : null;
      return { entries: page, totalMatches: entries.length, nextOffset, truncated: nextOffset !== null, catalogVersion: 'deep-fixture:3' };
    },
    async detail({ id }) { bodyReads++; return entries.find(entry => entry.id === id); },
  } });
  const searchSchema = tool.definition.inputSchema.oneOf.find(value => value.properties.action.const === 'skill_search');
  assert.equal(searchSchema.properties.offset.maximum, undefined, 'The advertised schema must admit the same deep pages as execution.');
  assert.equal(searchSchema.properties.limit.maximum, 50);
  const found = []; let offset = 11001;
  do {
    const result = await read(tool, { action: 'skill_search', offset, limit: 50 });
    assert.ok(result.entries.length > 0 && result.entries.length <= 50);
    assert.ok(result.entries.every(entry => !Object.hasOwn(entry, 'content')));
    assert.equal(result.totalMatches, entries.length);
    assert.equal(result.catalogVersion, 'deep-fixture:3');
    assert.equal(result.truncated, result.nextOffset !== null);
    found.push(...result.entries);
    if (result.nextOffset === null) break;
    assert.equal(result.nextOffset, offset + result.entries.length);
    offset = result.nextOffset;
  } while (calls.length < 4);
  assert.deepEqual(calls.map(value => value.offset), [11001, 11051, 11101]);
  assert.ok(calls.every(value => value.source === 'all' && value.query === '' && value.limit === 50));
  assert.deepEqual(found.map(value => value.id), entries.slice(11001).map(value => value.id));
  assert.equal(bodyReads, 0, 'Discovery does not read bodies.');
  const last = found.at(-1), detail = await read(tool, { action: 'skill_read', id: last.id });
  assert.equal(detail.content, entries.at(-1).content);
  assert.equal(detail.source.id, last.id); assert.equal(detail.source.revision, 3);
  assert.equal(bodyReads, 1);
  const exhausted = await read(tool, { action: 'skill_search', offset: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(exhausted.entries, []); assert.equal(exhausted.nextOffset, null);
  assert.equal(exhausted.truncated, false); assert.equal(calls.at(-1).limit, 12);
});

test('skill discovery rejects malformed offsets and oversized pages before catalog access', async () => {
  let calls = 0;
  const tool = createDirectExecutionContextTool({ skillsCatalog: {
    async list() { calls++; return { entries: [] }; },
  } });
  for (const offset of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '11001', null, {}, []]) {
    await assert.rejects(read(tool, { action: 'skill_search', offset }), { code: 'EXECUTION_CONTEXT_INVALID' });
  }
  for (const limit of [0, 51, 1.5]) {
    await assert.rejects(read(tool, { action: 'skill_search', offset: 11001, limit }), { code: 'EXECUTION_CONTEXT_INVALID' });
  }
  assert.equal(calls, 0);
});

test('an empty effective skill stays empty if the catalog supplies one', async () => {
  // The current edit store rejects new empty saves. This tests the adapter interface, not that store's editing policy.
  const tool = createDirectExecutionContextTool({ skillsCatalog: { detail: async () => ({ id: 'user-empty', title: 'Empty owner method', source: 'user', revision: 8, content: '' }) } });
  const value = await read(tool, { action: 'skill_read', id: 'user-empty' });
  assert.equal(value.content, ''); assert.equal(value.source.hash, hash('')); assert.equal(value.source.revision, 8);
  assert.equal(value.returnedCharacters, 0); assert.equal(value.truncated, false); assert.equal(value.nextOffset, null);
});

test('strict actions reject unrelated or invalid fields before any store read', async () => {
  let reads = 0;
  const tool = createDirectExecutionContextTool({ instructionSettings: { read: async () => { reads++; return record('owner'); } } });
  for (const args of [
    { action: 'instructions', kind: 'user' }, { action: 'instructions', offset: -1 },
    { action: 'instructions', maxChars: 16001 }, { action: 'instructions', expectedHash: 'bad' },
    { action: 'identity', kind: 'other' }, { action: 'skill_read', id: '../USER.md' },
    { action: 'skill_search', limit: 51 }, { action: 'skill_search', offset: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'skill_search', query: 'x'.repeat(2001) }, { action: 'skill_search', maxChars: 12 },
    { action: 'save', content: 'new owner policy' }, { action: 'instructions', taskContext: 'unrelated-task' },
  ]) await assert.rejects(read(tool, args), { code: 'EXECUTION_CONTEXT_INVALID' });
  assert.equal(reads, 0);
});

test('unavailable context is explicit and discovery never invents replacement Instructions', async () => {
  const tool = createDirectExecutionContextTool({ instructionSettings: { read: async () => { throw Object.assign(Error('Corrupt saved record'), { code: 'INSTRUCTIONS_STORAGE_INVALID' }); } } });
  const result = await tool.discoveryInstructions();
  assert.equal(result.metadata.instructions.status, 'unavailable'); assert.equal(result.metadata.instructions.code, 'INSTRUCTIONS_STORAGE_INVALID');
  assert.doesNotMatch(result.text, /BLACKICE EXECUTION|An ordinary request/);
  await assert.rejects(read(tool, { action: 'instructions' }), { code: 'INSTRUCTIONS_STORAGE_INVALID' });
  await assert.rejects(read(tool, { action: 'identity', kind: 'user' }), { code: 'EXECUTION_CONTEXT_UNAVAILABLE' });
});

test('registered context tool is read-only, has no task gate, preserves schemas and recovers durable reads without replay', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-context-durable-')); let saved = record('First owner instructions'), reads = 0;
  const tool = createDirectExecutionContextTool({ instructionSettings: { read: async () => { reads++; return saved; } } });
  const baseline = new DirectExecutionAPI({ dataDir: path.join(dataDir, 'baseline') });
  const api = new DirectExecutionAPI({ dataDir: path.join(dataDir, 'active'), additionalTools: [tool] });
  t.after(async () => { await api.close(); await baseline.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await api.init();
  const definition = api.tools().find(value => value.name === name);
  assert.deepEqual(definition.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(definition.requiredScopes, ['read']);
  assert.equal(definition.inputSchema.properties?.taskContext, undefined);
  assert.ok(definition.inputSchema.oneOf.every(value => value.additionalProperties === false && value.properties.taskContext === undefined));
  assert.deepEqual(api.tools().filter(value => value.name !== name), baseline.tools(), 'Existing operations retain their exact schemas.');
  const client = { id: 'context-reader', scopes: ['read'] };
  async function result(args) {
    const started = await api.call(name, args, client), deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const job = await api.call('blackice_get_job', { jobId: started.jobId, limit: 50000 }, client);
      if (job.settled) { assert.equal(job.status, 'succeeded', JSON.stringify(job.error)); return { started, job, value: JSON.parse(job.result.text.text) }; }
      await sleep(10);
    }
    assert.fail('Context read did not settle.');
  }
  const args = { requestId: 'persistent-read', action: 'instructions' }, first = await result(args);
  assert.equal(first.value.content, saved.content); assert.equal(reads, 1);
  saved = record('Updated owner instructions', 5);
  const recovered = await result(args);
  assert.equal(recovered.started.jobId, first.started.jobId); assert.equal(recovered.started.existing, true);
  assert.deepEqual(recovered.value, first.value); assert.equal(reads, 1, 'Receipt recovery is not a fresh store read.');
  const fresh = await result({ ...args, requestId: 'fresh-read' });
  assert.equal(fresh.value.content, saved.content); assert.equal(fresh.value.source.revision, 5); assert.equal(reads, 2);
  await assert.rejects(api.call(name, { ...args, requestId: 'bad-schema', action: 'instructions', maxChars: 1 }, client));
});
