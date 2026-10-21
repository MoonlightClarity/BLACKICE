import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore, KNOWLEDGE_LIMITS, KNOWLEDGE_TOOLS, createKnowledgeToolHandler } from '../lib/knowledge.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const call = (name, args) => ({ name, arguments: args });
const decode = response => { assert.equal(response.success, true); assert.equal(response.contentItems[0].type, 'inputText'); return JSON.parse(response.contentItems[0].text); };
async function harness(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-knowledge-test-'));
  const store = await new KnowledgeStore({ dataDir }).init();
  const cwd = path.join(dataDir, 'project-a'), otherCwd = path.join(dataDir, 'project-b');
  t.after(async () => {
    await store.writeChain.catch(() => {});
    assert.match(path.basename(dataDir), /^relay-knowledge-test-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, dataDir, cwd, otherCwd };
}
const memory = (content, extra = {}) => ({ kind: 'memory', title: 'Project convention', content, ...extra });

test('knowledge is durable, revisions retain creation time and returned records cannot mutate storage', async t => {
  const { store, dataDir, cwd } = await harness(t);
  const saved = await store.upsert(memory('Use Node.js built-in tests.', { cwd }), { source: 'agent', runId: 'run-one', nodeId: 'builder' });
  assert.equal(saved.revision, 1);
  assert.equal(saved.provenance.source, 'agent');
  assert.equal(saved.provenance.runId, 'run-one');
  assert.equal(saved.provenance.nodeId, 'builder');
  assert.ok(Number.isFinite(Date.parse(saved.provenance.at)));
  const changed = await store.upsert(memory('Use meaningful regression tests.', { id: saved.id, title: 'Testing convention' }));
  assert.equal(changed.createdAt, saved.createdAt);
  assert.equal(changed.revision, 2);
  assert.equal(changed.cwd, cwd, 'updates preserve workspace when omitted');
  saved.content = 'mutated client copy';
  const listed = store.list(); listed[0].title = 'changed metadata';
  assert.equal(store.get(saved.id).content, 'Use meaningful regression tests.');
  assert.equal(store.get(saved.id).title, 'Testing convention');
  const restored = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restored.get(saved.id).revision, 2);
  assert.equal(restored.get(saved.id).content, 'Use meaningful regression tests.');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'knowledge.json.bak'), 'utf8')).entries[0].revision, 1);
  await restored.remove(saved.id);
  assert.throws(() => restored.get(saved.id), { status: 404 });
  assert.equal((await new KnowledgeStore({ dataDir }).init()).list().length, 0);
});

test('workspace search includes shared knowledge but never another project and reads only metadata until requested', async t => {
  const { store, cwd, otherCwd } = await harness(t);
  const local = await store.upsert(memory('A body-only searchable needle.', { cwd, title: 'Local note', summary: 'Concise summary.' }));
  await store.upsert(memory('Global searchable needle.', { title: 'Global note' }));
  await store.upsert(memory('Private searchable needle.', { cwd: otherCwd, title: 'Other note' }));
  await store.upsert({ kind: 'skill', title: 'Needle procedure', summary: 'A reusable method', content: '# Procedure\nSECRET_FULL_BODY\nneedle', cwd });
  assert.equal(store.list().length, 4);
  assert.deepEqual(store.list({ kind: 'memory', cwd, query: 'NEEDLE' }).map(entry => entry.title).sort(), ['Global note', 'Local note']);
  assert.equal(store.list({ cwd, includeGlobal: false, kind: 'memory' }).length, 1);
  assert.equal(store.list({ cwd: null }).length, 1);
  const matches = store.list({ kind: 'memory', cwd, query: 'body-only needle' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, local.id);
  assert.equal(Object.hasOwn(matches[0], 'content'), false);
  assert.match(matches[0].excerpt, /searchable needle/);
  assert.equal(store.get(local.id).content, 'A body-only searchable needle.');
  if (process.platform === 'win32') assert.equal(store.list({ cwd: cwd.toUpperCase(), includeGlobal: false }).length, 2);
});

test('context is a bounded progressive catalog rather than full skill bodies', async t => {
  const { store, cwd } = await harness(t);
  await Promise.all(Array.from({ length: 24 }, (_, index) => store.upsert({ kind: index % 2 ? 'memory' : 'skill', title: `Procedure ${index} ${'t'.repeat(80)}`, summary: 's'.repeat(400), content: `FULL_BODY_MARKER_${index}\n${'x'.repeat(4000)}`, cwd })));
  const context = store.context(cwd), serialized = JSON.stringify(context);
  assert.ok(context.memories.length > 0 && context.skills.length > 0);
  assert.ok(serialized.length <= KNOWLEDGE_LIMITS.contextChars);
  assert.doesNotMatch(serialized, /FULL_BODY_MARKER/);
  assert.ok(context.memories.length <= 12 && context.skills.length <= 12);
  assert.equal(context.skills[0].scope, 'workspace');
  assert.equal(context.skills[0].revision, 1);
});

test('concurrent explicit writes serialize and keep every committed entry', async t => {
  const { store, dataDir, cwd } = await harness(t);
  const records = await Promise.all(Array.from({ length: 12 }, (_, index) => store.upsert(memory(`Fact ${index}`, { title: `Fact ${index}`, cwd }))));
  const restored = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restored.list().length, 12);
  for (const record of records) assert.equal(restored.get(record.id).content, record.content);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('independent knowledge stores reload under one filesystem lock before saving and editing', async t => {
  const { store, dataDir, cwd } = await harness(t), second = await new KnowledgeStore({ dataDir }).init();
  const first = await store.upsert(memory('First instance fact.', { id: 'first-instance', cwd }));
  const saved = await second.upsert(memory('Second instance fact.', { id: 'second-instance', cwd }));
  let restored = await new KnowledgeStore({ dataDir }).init();
  assert.deepEqual(restored.list().map(entry => entry.id).sort(), [first.id, saved.id].sort());
  await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? store : second).upsert(memory(`Concurrent fact ${index}`, { id: `parallel-${index}`, cwd }))));
  const edits = await Promise.all([store.upsert(memory('First replacement.', { id: first.id })), second.upsert(memory('Second replacement.', { id: first.id }))]);
  assert.deepEqual(edits.map(entry => entry.revision).sort(), [2, 3]);
  assert.ok(edits.every(entry => entry.createdAt === first.createdAt && entry.cwd === cwd));
  restored = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restored.list().length, 12); assert.equal(restored.get(first.id).revision, 3); assert.equal(restored.get(saved.id).content, saved.content);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('a stale instance cannot resurrect a deleted note when saving another entry', async t => {
  const { store, dataDir, cwd } = await harness(t), initial = await store.upsert(memory('Delete this fact.', { cwd }));
  const second = await new KnowledgeStore({ dataDir }).init(), frozenContext = second.context(cwd), frozenNote = second.get(initial.id);
  await store.remove(initial.id); await second.upsert(memory('Retain this new fact.', { id: 'retained-new', cwd }));
  const restored = await new KnowledgeStore({ dataDir }).init();
  assert.throws(() => restored.get(initial.id), { status: 404 }); assert.equal(restored.list().length, 1);
  assert.equal(frozenNote.content, 'Delete this fact.'); assert.equal(frozenContext.memories[0].id, initial.id, 'captured context remains an independent snapshot');
});

test('a damaged or missing live file rejects mutation without overwriting valid backup or cached knowledge', async t => {
  const { store, dataDir } = await harness(t), saved = await store.upsert(memory('Initial fact.'));
  await store.upsert(memory('Latest confirmed fact.', { id: saved.id }));
  const file = path.join(dataDir, 'knowledge.json'), backup = await readFile(`${file}.bak`, 'utf8');
  const damaged = '{ damaged after initialization'; await writeFile(file, damaged);
  await assert.rejects(store.upsert(memory('Must not overwrite damaged storage.')), { status: 500 });
  await assert.rejects(store.remove(saved.id), { status: 500 });
  assert.equal(await readFile(file, 'utf8'), damaged); assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
  assert.equal(store.get(saved.id).content, 'Latest confirmed fact.'); assert.equal(store.status().healthy, false);
  await rm(file);
  await assert.rejects(store.upsert(memory('Must not treat missing storage as empty.')), { status: 500 });
  assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
  const recovered = await new KnowledgeStore({ dataDir }).init(); assert.equal(recovered.get(saved.id).content, 'Initial fact.');
  await store.upsert(memory('A save after explicit recovery.', { id: 'post-recovery' }));
  assert.equal(store.status().healthy, true); assert.equal(store.list().length, 2);
});

test('a cancelled writer waiting on another instance never steals a live lock or commits late', async t => {
  const { store, dataDir } = await harness(t), second = await new KnowledgeStore({ dataDir }).init();
  const entered = deferred(), release = deferred(), original = store.writeSnapshot.bind(store);
  store.writeSnapshot = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const saving = store.upsert(memory('First committed fact.')); await entered.promise;
  try {
    const old = new Date(Date.now() - 240000); await utimes(store.lockDirectory, old, old);
    const controller = new AbortController(), waiting = second.upsert(memory('Cancelled waiting fact.'), {}, { signal: controller.signal });
    const rejected = assert.rejects(waiting, { name: 'AbortError' }); await new Promise(resolve => setTimeout(resolve, 25)); controller.abort(); await rejected;
    assert.equal((await readdir(dataDir)).includes('knowledge.json.lock'), true, 'a live writer retains its lock even if its timestamp is old');
  } finally { release.resolve(); await saving; }
  assert.equal((await new KnowledgeStore({ dataDir }).init()).list().length, 1);
  await second.upsert(memory('New save after cancellation.')); assert.equal(second.list().length, 2);
});

test('a confirmed dead writer lock is reclaimed without modifying saved notes', async t => {
  const { store, dataDir } = await harness(t); await store.upsert(memory('Retain before recovery.', { id: 'retained' }));
  await mkdir(store.lockDirectory); await writeFile(path.join(store.lockDirectory, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-writer-fixture' }));
  await store.upsert(memory('After dead-writer recovery.', { id: 'after-recovery' }));
  assert.equal((await new KnowledgeStore({ dataDir }).init()).list().length, 2);
  assert.equal((await readdir(dataDir)).includes('knowledge.json.lock'), false);
});

test('invalid and oversized knowledge never reaches disk, and a full store rejects additions without evicting existing entries', async t => {
  const { store, dataDir } = await harness(t);
  assert.throws(() => store.upsert(memory('x'.repeat(KNOWLEDGE_LIMITS.memoryChars + 1))), /at most/);
  assert.throws(() => store.upsert({ kind: 'skill', title: 'Too long', content: 'x'.repeat(KNOWLEDGE_LIMITS.skillChars + 1) }), /at most/);
  assert.throws(() => store.upsert(memory('fact', { cwd: 'relative-folder' })), /absolute path/);
  assert.throws(() => store.upsert(memory('fact', { id: '../escape' })), /Invalid knowledge entry ID/);
  assert.throws(() => store.list({ query: 'x'.repeat(257) }), /Search query/);
  assert.throws(() => store.list({ limit: 301 }), /Limit/);
  const first = await store.upsert(memory('retained'));
  const entries = Array.from({ length: KNOWLEDGE_LIMITS.entries }, (_, index) => ({ ...first, id: `entry-${index}` }));
  await writeFile(path.join(dataDir, 'knowledge.json'), JSON.stringify({ version: 1, entries }));
  const full = await new KnowledgeStore({ dataDir }).init();
  await assert.rejects(full.upsert(memory('must not evict anything')), /limited to 300 entries/);
  assert.equal(full.list({ limit: 300 }).length, 300);
  assert.equal(full.get('entry-0').content, 'retained');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'knowledge.json'), 'utf8')).entries.length, 300);
});

test('storage failures preserve the committed in-memory state and allow a later successful save', async t => {
  const { store } = await harness(t);
  const saved = await store.upsert(memory('committed fact'));
  const persist = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => { throw new Error('fixture disk full'); };
  await assert.rejects(store.upsert(memory('uncommitted replacement', { id: saved.id })), /disk full/);
  assert.equal(store.get(saved.id).content, 'committed fact');
  assert.equal(store.get(saved.id).revision, 1);
  assert.equal(store.status().healthy, false);
  store.writeSnapshot = persist;
  const updated = await store.upsert(memory('successful replacement', { id: saved.id }));
  assert.equal(updated.revision, 2);
  assert.equal(store.status().healthy, true);
});

test('corrupt knowledge recovers a valid backup while retaining the exact corrupt file', async t => {
  const { store, dataDir } = await harness(t);
  const saved = await store.upsert(memory('backup fact'));
  await store.upsert(memory('latest fact', { id: saved.id }));
  const corrupt = '{ interrupted write';
  await writeFile(path.join(dataDir, 'knowledge.json'), corrupt);
  const restored = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restored.get(saved.id).content, 'backup fact');
  assert.equal(restored.status().recovered, true);
  const preserved = (await readdir(dataDir)).find(name => name.startsWith('knowledge.json.corrupt-'));
  assert.ok(preserved);
  assert.equal(await readFile(path.join(dataDir, preserved), 'utf8'), corrupt);
});

test('unrecoverable or oversized knowledge fails usefully without silently discarding files', async t => {
  const { dataDir } = await harness(t);
  const file = path.join(dataDir, 'knowledge.json');
  await writeFile(file, '{bad');
  await assert.rejects(new KnowledgeStore({ dataDir }).init(), /Existing files were preserved/);
  assert.equal(await readFile(file, 'utf8'), '{bad');
  await writeFile(file, 'x'.repeat(KNOWLEDGE_LIMITS.bytes + 1));
  await assert.rejects(new KnowledgeStore({ dataDir }).init(), /storage limit/);
});

test('memory and skills tools explicitly write scoped records with immutable run provenance and semantic trace events', async t => {
  const { store, cwd } = await harness(t);
  const events = [];
  const handler = createKnowledgeToolHandler({ store, cwd, runId: 'run-original', nodeId: 'researcher', onEvent: event => events.push(event) });
  const remembered = decode(await handler(call('relay_memory', { action: 'remember', title: 'Test command', content: 'Run node --test.' }))).entry;
  assert.equal(remembered.cwd, cwd);
  assert.deepEqual({ source: remembered.provenance.source, runId: remembered.provenance.runId, nodeId: remembered.provenance.nodeId }, { source: 'agent', runId: 'run-original', nodeId: 'researcher' });
  assert.equal(decode(await handler(call('relay_memory', { action: 'search', query: 'test' }))).entries.length, 1);
  assert.equal(decode(await handler(call('relay_memory', { action: 'read', id: remembered.id }))).entry.content, 'Run node --test.');
  const skill = decode(await handler(call('relay_skills', { action: 'save', title: 'Review procedure', content: '# Review\nRead, test, report.' }))).entry;
  const catalog = decode(await handler(call('relay_skills', { action: 'search', query: 'review' }))).entries;
  assert.equal(catalog[0].content, undefined);
  assert.equal(decode(await handler(call('relay_skills', { action: 'read', id: skill.id }))).entry.content, '# Review\nRead, test, report.');
  assert.equal(decode(await handler(call('relay_skills', { action: 'remove', id: skill.id }))).ok, true);
  assert.equal(decode(await handler(call('relay_memory', { action: 'forget', id: remembered.id }))).ok, true);
  assert.ok(events.every(event => event.type === 'knowledge' && event.tool.startsWith('relay_')));
  assert.ok(events.some(event => event.action === 'remember' && event.status === 'completed'));
  assert.equal(events.find(event => event.action === 'remember' && event.status === 'completed').revision, 1);
  assert.equal(events.find(event => event.action === 'read' && event.status === 'completed').revision, 1);
  assert.equal(events.some(event => Object.hasOwn(event, 'content')), false, 'trace stores action metadata rather than full knowledge bodies');
});

test('agents cannot read another workspace, forge provenance, or modify a shared entry without explicit global scope', async t => {
  const { store, cwd, otherCwd } = await harness(t);
  const other = await store.upsert(memory('other project', { cwd: otherCwd }));
  const shared = await store.upsert(memory('shared global fact'));
  const handler = createKnowledgeToolHandler({ store, cwd, runId: 'run-current', nodeId: 'agent' });
  await assert.rejects(handler(call('relay_memory', { action: 'read', id: other.id })), /selected scope/);
  await assert.rejects(handler(call('relay_memory', { action: 'remember', title: 'forged', content: 'fact', cwd: otherCwd })), /Unknown knowledge tool argument/);
  await assert.rejects(handler(call('relay_memory', { action: 'remember', title: 'forged', content: 'fact', provenance: { runId: 'forged' } })), /Unknown knowledge tool argument/);
  assert.equal(decode(await handler(call('relay_memory', { action: 'read', id: shared.id }))).entry.content, 'shared global fact');
  await assert.rejects(handler(call('relay_memory', { action: 'forget', id: shared.id })), /global scope explicitly/);
  await assert.rejects(handler(call('relay_memory', { action: 'remember', id: shared.id, title: 'Changed', content: 'changed' })), /global scope explicitly/);
  assert.equal(decode(await handler(call('relay_memory', { action: 'forget', id: shared.id, scope: 'global' }))).ok, true);
  const global = decode(await handler(call('relay_memory', { action: 'remember', scope: 'global', title: 'Shared preference', content: 'Prefer short status updates.' }))).entry;
  assert.equal(global.cwd, null);
});

test('cancellation before or during trace delivery prevents explicit knowledge mutations', async t => {
  const { store, cwd } = await harness(t);
  const controller = new AbortController(); controller.abort();
  const stopped = createKnowledgeToolHandler({ store, cwd, signal: controller.signal });
  await assert.rejects(stopped(call('relay_memory', { action: 'remember', title: 'No write', content: 'no' })), { name: 'AbortError' });
  const midCall = new AbortController();
  const handler = createKnowledgeToolHandler({ store, cwd, signal: midCall.signal, onEvent: event => { if (event.status === 'running') midCall.abort(); } });
  await assert.rejects(handler(call('relay_skills', { action: 'save', title: 'No skill', content: 'no' })), { name: 'AbortError' });
  assert.equal(store.list().length, 0);
});

test('a mutation cancelled while queued cannot commit after another agent finishes saving', async t => {
  const { store, cwd } = await harness(t);
  const entered = deferred(), release = deferred(), original = store.writeSnapshot.bind(store);
  let first = true;
  store.writeSnapshot = async (...args) => { if (first) { first = false; entered.resolve(); await release.promise; } return original(...args); };
  const saving = store.upsert(memory('first fact', { cwd }));
  await entered.promise;
  const controller = new AbortController();
  const handler = createKnowledgeToolHandler({ store, cwd, signal: controller.signal });
  const queued = handler(call('relay_memory', { action: 'remember', title: 'cancelled fact', content: 'must not commit' }));
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort(); release.resolve();
  await saving; await rejected;
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].title, 'Project convention');
});

test('failed or queued cancelled deletion preserves the durable note and its revision', async t => {
  const { store, dataDir, cwd } = await harness(t);
  const saved = await store.upsert(memory('must remain', { cwd }));
  const original = store.writeSnapshot.bind(store);
  store.writeSnapshot = async () => { throw new Error('deletion could not be saved'); };
  await assert.rejects(store.remove(saved.id), /could not be saved/);
  assert.equal(store.get(saved.id).content, 'must remain');
  assert.equal((await new KnowledgeStore({ dataDir }).init()).get(saved.id).revision, 1);
  const entered = deferred(), release = deferred();
  let first = true;
  store.writeSnapshot = async (...args) => { if (first) { first = false; entered.resolve(); await release.promise; } return original(...args); };
  const saving = store.upsert(memory('a second fact', { cwd }));
  await entered.promise;
  const controller = new AbortController();
  const handler = createKnowledgeToolHandler({ store, cwd, signal: controller.signal });
  const deleting = handler(call('relay_memory', { action: 'forget', id: saved.id }));
  const stopped = assert.rejects(deleting, { name: 'AbortError' });
  controller.abort(); release.resolve();
  await saving; await stopped;
  assert.equal(store.get(saved.id).content, 'must remain');
  assert.equal((await new KnowledgeStore({ dataDir }).init()).get(saved.id).revision, 1);
});

test('history discovery is workspace scoped, excludes the current run, returns at most ten summaries and requires explicit global search', async t => {
  const { store, cwd, otherCwd } = await harness(t);
  const runs = Array.from({ length: 14 }, (_, index) => ({ id: `run-${index}`, workflowName: 'Research pipeline', input: 'Find workflow facts', output: `verified needle ${index} ${'x'.repeat(5000)}`, status: 'completed', cwd, createdAt: new Date(2026, 0, index + 1).toISOString(), nodes: {} }));
  runs.push({ id: 'other-project', cwd: otherCwd, workflowName: 'Other project needle', status: 'completed', input: 'private task', output: 'private output' });
  const handler = createKnowledgeToolHandler({ store, cwd, runId: 'run-0', getRuns: () => runs });
  const result = decode(await handler(call('relay_history', { action: 'search', query: 'needle', limit: 10 })));
  assert.equal(result.results.length, 10);
  assert.equal(result.totalMatches, 13);
  assert.equal(result.truncated, true);
  assert.ok(result.results.every(run => run.id !== 'run-0' && run.id !== 'other-project' && run.excerpt.length <= 600));
  await assert.rejects(handler(call('relay_history', { action: 'read', id: 'other-project' })), /selected history scope/);
  assert.equal(decode(await handler(call('relay_history', { action: 'read', id: 'other-project', scope: 'global' }))).run.output, 'private output');
  assert.equal(decode(await handler(call('relay_history', { action: 'search', query: 'Other project', scope: 'global' }))).results[0].id, 'other-project');
  await assert.rejects(handler(call('relay_history', { action: 'search', limit: 11 })), /Limit/);
});

test('history reads bound large outcomes and node handoffs and preserve observed completion status', async t => {
  const { store, cwd } = await harness(t);
  const run = { id: 'large-history', cwd, workflowName: 'Large run', status: 'cancelled', input: '\u0001'.repeat(20000), output: '\n"'.repeat(200000), error: 'Interrupted by user', nodes: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`node-${index}`, { status: 'completed', output: '\n"'.repeat(20000) }])) };
  const handler = createKnowledgeToolHandler({ store, cwd, getRuns: async () => [run] });
  const response = await handler(call('relay_history', { action: 'read', id: run.id })), result = decode(response);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.truncated, true);
  assert.ok(result.run.output.length <= 18000);
  assert.ok(result.run.input.length <= 4000);
  assert.ok(response.contentItems[0].text.length <= 43000);
  assert.ok(result.run.nodes.every(node => node.output.length <= 2000));
});

test('published dynamic tool schemas match their runtime names and disallow unbounded extra fields', () => {
  assert.deepEqual(KNOWLEDGE_TOOLS.map(tool => tool.name), ['relay_memory', 'relay_skills', 'relay_history']);
  for (const tool of KNOWLEDGE_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.limit.maximum, 10);
    assert.equal(tool.inputSchema.properties.query.maxLength, 256);
  }
});
