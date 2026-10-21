import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ConversationArchive } from '../lib/conversations.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createConversationSearchDocument, conversationSearchOptions, conversationMatchPreview } from '../lib/conversation-search.mjs';
import { createHarnessServer } from '../server.mjs';

const at = index => new Date(1700000000000 + index * 1000).toISOString();
const turn = (index = 0, changes = {}) => ({
  id: `turn-${index}`, taskId: `turn-${index}`, parentRunId: null, input: `Request ${index}`, output: `Answer ${index}`,
  createdAt: at(index), updatedAt: at(index + 1), status: 'completed', settled: true,
  workflow: { id: 'search-fixture', name: 'Search fixture', nodes: [{ id: 'agent', type: 'agent', name: 'Agent' }], edges: [] },
  nodes: { agent: { status: 'completed', output: `Answer ${index}` } }, events: [], ...changes,
});
const answer = (index, text, changes = {}) => turn(index, { output: text, nodes: { agent: { status: 'completed', output: text } }, ...changes });
class Engine extends EventEmitter {
  runs = new Map();
  listRuns() { return [...this.runs.values()].map(run => structuredClone(run)); }
  getRun(id) { if (!this.runs.has(id)) throw Error('Run not found.'); return structuredClone(this.runs.get(id)); }
  record(run, data, index = 0) {
    const event = { type: 'agent.event', runId: run.id, nodeId: 'agent', at: at(index), data };
    run.events.push(event); if (run.events.length > 2500) run.events.shift(); this.emit('event', event);
  }
}
async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-search-')), engine = options.engine || new Engine(), archives = [];
  const open = async (next = {}) => { const archive = await new ConversationArchive({ dataDir, engine, ...options, ...next }).init(); archives.push(archive); return archive; };
  t.after(async () => { for (const archive of archives) await archive.close(); assert.match(path.basename(dataDir), /^blackice-search-/); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, engine, archive: await open(), open };
}
const search = (archive, q, options = {}) => archive.search({ q, ...options });

test('full search finds original, continued and visible assistant text and opens the best matching turn', async t => {
  const { archive } = await setup(t);
  const root = answer(0, 'The first answer describes orchid care.', { input: `A long initial request. ${'Background details. '.repeat(20)}OriginalTailMarker` });
  const child = answer(1, 'The quarterly galaxy analysis is ready.', { taskId: root.id, parentRunId: root.id, input: 'Please compare the spring forecast.',
    events: [{ at: at(1), nodeId: 'agent', data: { type: 'message', itemId: 'actual-final', phase: 'final_answer', text: 'The quarterly galaxy analysis is ready.' } }] });
  await archive.capture(root); await archive.capture(child);
  assert.equal(search(archive, 'OriginalTailMarker').conversations[0].match.runId, root.id);
  assert.equal(search(archive, 'spring forecast').conversations[0].match.runId, child.id);
  const response = search(archive, '  GALAXY analysis  ');
  assert.equal(response.query, 'GALAXY analysis'); assert.equal(response.state, 'all'); assert.equal(response.total, 1);
  assert.equal(response.conversations[0].latestRunId, child.id);
  assert.deepEqual(response.conversations[0].match, { runId: child.id, kind: 'message', text: 'The quarterly galaxy analysis is ready.', messageId: 'agent:actual-final' });
  assert.equal(search(archive, 'orchid galaxy').conversations[0].match.runId, child.id, 'words may span saved turns while the preview identifies the strongest passage');
  assert.equal(search(archive, 'orchid absent-word').total, 0);
  await archive.rename(root.id, 'Orchid project');
  const combined = search(archive, 'orchid galaxy').conversations[0].match;
  assert.equal(combined.runId, child.id); assert.equal(combined.kind, 'message'); assert.match(combined.text, /galaxy/, 'a title-plus-message match must show its content term');
});

test('renames rank above transcript matches; Archive and Trash search use committed family state', async t => {
  const { archive } = await setup(t);
  await archive.capture(answer(0, 'Café plan is in this answer.'));
  await archive.capture(answer(1, 'A different response.'));
  await archive.rename('turn-1', 'Café plan');
  assert.equal(search(archive, 'CAFE PLAN').conversations[0].rootId, 'turn-1');
  assert.equal(search(archive, 'CAFE PLAN').conversations[0].match.kind, 'title');
  await archive.rename('turn-1', 'Renamed title only');
  assert.equal(search(archive, 'Café plan').total, 1); assert.equal(search(archive, 'renamed title').total, 1);
  await archive.setState('turn-1', 'archived');
  assert.equal(search(archive, 'renamed').total, 1); assert.equal(search(archive, 'renamed', { state: 'active' }).total, 0);
  assert.equal(search(archive, 'renamed', { state: 'archived' }).conversations[0].state, 'archived');
  await archive.setState('turn-1', 'deleted');
  assert.equal(search(archive, 'renamed').total, 0); assert.equal(search(archive, 'renamed', { state: 'all' }).total, 0);
  assert.equal(search(archive, 'renamed', { state: 'deleted' }).total, 1);
  await archive.setState('turn-1', 'active'); assert.equal(search(archive, 'renamed').total, 1);
});

test('file search uses registered titles and filenames from the newest task snapshot, without reading paths', async t => {
  const { archive } = await setup(t), file = (name, title = name) => ({ id: 'artifact_saved', title, fileName: name, path: '/PRIVATE_PATH_ONLY', sha256: 'PRIVATE_DIGEST_ONLY', provenance: { detail: 'PRIVATE_PROVENANCE_ONLY' } });
  const first = turn(0, { taskState: { taskId: 'turn-0', revision: 1, artifacts: [file('old-report.csv', 'Old report')] } });
  const next = turn(1, { taskId: 'turn-0', parentRunId: 'turn-0', taskState: { taskId: 'turn-0', revision: 2, artifacts: [file('résumé-2026.csv', 'Budget final')] } });
  await archive.capture(first); await archive.capture(next); await archive.capture(first);
  assert.equal(search(archive, 'old-report.csv').total, 0, 'an older hidden file slot must not leave a stale filename hit');
  const match = search(archive, 'RESUME-2026.CSV').conversations[0].match;
  assert.deepEqual(match, { runId: 'turn-1', kind: 'file', text: 'Budget final · résumé-2026.csv' });
  assert.equal(search(archive, 'budget final').conversations[0].match.kind, 'file');
  for (const query of ['PRIVATE_PATH_ONLY', 'PRIVATE_DIGEST_ONLY', 'PRIVATE_PROVENANCE_ONLY']) assert.equal(search(archive, query).total, 0);
  next.taskState = { taskId: 'turn-0', revision: 3, artifacts: [file('résumé-2026.csv', 'Approved deliverable')] };
  await archive.capture(next); assert.equal(search(archive, 'Budget final').total, 0); assert.equal(search(archive, 'Approved deliverable').total, 1);
});

test('an actual saved file becomes searchable only after artifact registration and stays searchable after archive restart', async t => {
  const { archive, dataDir, open } = await setup(t), cwd = path.join(dataDir, 'PRIVATE_DIRECTORY_MARKER');
  await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'qa-result.txt'), 'Saved output bytes.'); await fs.writeFile(path.join(cwd, 'unregistered-private.txt'), 'Unregistered working data.');
  const tasks = await new TaskStateStore({ dataDir }).init(); t.after(() => tasks.close());
  const run = answer(0, 'The result has been saved and checked.', { cwd });
  run.taskState = await tasks.ensure({ taskId: run.id, runId: run.id, nodeId: 'agent', cwd, goal: run.input });
  await archive.capture(run);
  assert.equal(search(archive, 'qa-result.txt').total, 0, 'writing a workspace file alone does not register it as a deliverable');
  run.taskState = await tasks.addArtifact(run.id, { path: 'qa-result.txt', title: 'Checked outcome' }, { expectedRevision: run.taskState.revision, runId: run.id, nodeId: 'agent' });
  assert.equal(run.taskState.artifacts[0].fileName, 'qa-result.txt'); assert.equal(run.taskState.artifacts[0].verification, 'filesystem-sha256');
  await archive.capture(run);
  const expected = { runId: run.id, kind: 'file', text: 'Checked outcome · qa-result.txt' };
  assert.deepEqual(search(archive, 'qa-result.txt').conversations[0].match, expected);
  for (const query of ['unregistered-private.txt', 'PRIVATE_DIRECTORY_MARKER', 'Saved output bytes']) assert.equal(search(archive, query).total, 0);
  await archive.setState(run.id, 'archived'); await archive.close();
  const restored = await open({ engine: new Engine() });
  assert.deepEqual(search(restored, 'qa-result.txt', { state: 'archived' }).conversations[0].match, expected);
  assert.equal(search(restored, 'qa-result.txt', { state: 'active' }).total, 0);
});

test('search projects visible messages without copying traces, held text, prompts or provider settings', () => {
  const source = answer(0, 'Visible final receipt', {
    cwd: 'PRIVATE_WORKSPACE', pendingAnswerEvents: [{ text: 'PRIVATE_HELD_ANSWER' }], modelHandoff: { context: 'PRIVATE_HANDOFF' },
    workflow: { nodes: [{ id: 'agent', type: 'agent', prompt: 'PRIVATE_SYSTEM_PROMPT', settings: { apiKey: 'PRIVATE_KEY' } }] },
    nodes: { agent: { status: 'completed', output: 'Visible final receipt', threadId: 'PRIVATE_THREAD', planning: { status: 'missing', message: 'PRIVATE_PLANNING_DETAIL' } } },
    taskState: { taskId: 'turn-0', revision: 1, notes: [{ text: 'PRIVATE_TASK_NOTE' }], artifacts: [] },
    events: [
      { nodeId: 'agent', data: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
      { nodeId: 'agent', data: { type: 'item', item: { type: 'mcpToolCall', arguments: { secret: 'PRIVATE_ARGUMENT' }, output: 'PRIVATE_TOOL_OUTPUT' } } },
      { nodeId: 'agent', data: { type: 'steer', text: 'PRIVATE_REJECTED_DIRECTION', accepted: false } },
      { nodeId: 'agent', data: { type: 'steer', text: 'Accepted actual direction', accepted: true } },
      { nodeId: 'agent', data: { type: 'item', item: { type: 'agentMessage', id: 'visible-item', text: 'Visible final receipt', phase: 'final_answer' } } },
    ],
  });
  const document = createConversationSearchDocument(source);
  assert.deepEqual(document.fields.map(item => item.text), ['Request 0', 'Accepted actual direction', 'Visible final receipt']);
  assert.ok(!JSON.stringify(document).includes('PRIVATE_'));
  assert.equal(document.fields.at(-1).messageId, 'agent:visible-item');
});

test('native message receipts and accepted directions survive the tool ring, recent-run eviction and restart', async t => {
  const engine = new Engine(), run = answer(0, '', { status: 'running', settled: false }); engine.runs.set(run.id, run);
  const { archive, open } = await setup(t, { engine });
  engine.record(run, { type: 'item', item: { type: 'agentMessage', id: 'early-native', text: 'Early native receipt needle', phase: 'commentary' } }, 1);
  engine.record(run, { type: 'steer', text: 'Accepted recovery direction', accepted: true }, 2);
  await archive.chain;
  const indexed = archive.searchDocuments.get(run.id);
  for (let index = 0; index < 2600; index++) engine.record(run, { type: 'delta', itemId: 'stream', delta: 'Unfinished delta ' }, 3);
  assert.equal(archive.searchDocuments.get(run.id), indexed, 'streaming deltas must not rebuild the saved-text index');
  assert.ok(!run.events.some(event => event.data.type === 'steer' || event.data.item?.id === 'early-native'));
  run.status = 'completed'; run.settled = true; run.output = 'Actual final receipt'; run.nodes.agent = { status: 'completed', output: run.output };
  engine.emit('event', { type: 'run.updated', runId: run.id, data: structuredClone(run) }); await archive.chain;
  for (let index = 1; index < 105; index++) {
    const next = turn(index, { taskId: run.id, parentRunId: `turn-${index - 1}` }); engine.runs.set(next.id, next);
    if (engine.runs.size > 3) engine.runs.delete(engine.runs.keys().next().value); await archive.capture(next);
  }
  assert.equal(engine.runs.size, 3); assert.equal(search(archive, 'early native').conversations[0].match.runId, run.id);
  assert.equal(search(archive, 'recovery direction').total, 1); assert.equal(search(archive, 'Unfinished delta').total, 0);
  await archive.close(); const restored = await open({ engine: new Engine() });
  assert.equal(search(restored, 'early native').conversations[0].match.messageId, 'agent:early-native');
  assert.equal(search(restored, 'recovery direction').total, 1); assert.equal(restored.searchDocuments.size, 105);
});

test('legacy parent links and repeated retries return one conversation and the original matching prompt', async t => {
  const { archive, open } = await setup(t), root = turn(0, { input: 'Original legacy marker' }), retry = turn(1, { input: root.input, parentRunId: root.id, retryOf: root.id });
  delete root.taskId; delete retry.taskId;
  await archive.capture(root); await archive.capture(retry); await archive.close(); const restored = await open();
  const result = search(restored, 'legacy marker');
  assert.equal(result.total, 1); assert.equal(result.conversations[0].rootId, root.id); assert.equal(result.conversations[0].match.runId, root.id);
});

test('results paginate over the complete catalog without filesystem reads during queries', async t => {
  let reads = 0;
  const io = { ...fs, readFile: (...args) => { reads++; return fs.readFile(...args); }, stat: (...args) => { reads++; return fs.stat(...args); }, readdir: (...args) => { reads++; return fs.readdir(...args); } };
  const { archive } = await setup(t, { io });
  for (let index = 0; index < 105; index++) await archive.capture(answer(index, 'Saved catalog needle'));
  reads = 0;
  const pages = [0, 40, 80].map(offset => search(archive, 'needle', { offset, limit: 40 }));
  assert.deepEqual(pages.map(page => page.conversations.length), [40, 40, 25]);
  assert.deepEqual(pages.map(page => page.hasMore), [true, true, false]); assert.ok(pages.every(page => page.total === 105 && !page.truncated));
  assert.equal(new Set(pages.flatMap(page => page.conversations.map(item => item.rootId))).size, 105);
  assert.equal(reads, 0); assert.equal(search(archive, 'absent').total, 0); assert.equal(reads, 0);
  assert.deepEqual(search(archive, 'needle', { offset: 1000 }).conversations, []);
});

test('Unicode, literal punctuation and late-message matches keep short previews around actual text', async t => {
  const { archive } = await setup(t), prefix = 'ﬃ É 👩🏽‍💻 context '.repeat(6000), output = `${prefix}Straße résumé [a-z] C++ preserved tail`;
  await archive.capture(answer(0, output));
  const match = search(archive, 'STRASSE RESUME').conversations[0].match;
  assert.ok(match.text.includes('Straße résumé')); assert.ok(match.text.length <= 200); assert.ok(!match.text.includes('\uFFFD'));
  assert.equal(search(archive, '[a-z] C++').total, 1); assert.equal(search(archive, '.*').total, 0);
  assert.equal(search(archive, 'preserved tail').total, 1, 'saved text is not silently cut to a first-N character index');
  const preview = conversationMatchPreview(' x '.repeat(150) + '<script>actual needle</script>' + ' end'.repeat(100), ['needle'], 'needle');
  assert.ok(preview.includes('<script>actual needle</script>')); assert.ok(preview.length <= 200, 'snippets are bounded plain text for the UI to escape');
});

test('failed writes cannot publish new searchable text or organization before a later successful commit', async t => {
  let failing = '';
  const io = { ...fs, rename: async (source, target) => { if (failing && target.endsWith(failing)) throw Object.assign(Error('Fixture disk failure'), { code: 'ENOSPC' }); return fs.rename(source, target); } };
  const { archive } = await setup(t, { io }); t.after(() => { failing = ''; });
  await archive.capture(answer(0, 'OriginalSavedNeedle')); await archive.rename('turn-0', 'KeptOrganizationName');
  failing = 'turn-0.json'; await assert.rejects(archive.capture(answer(0, 'RejectedReceiptNeedle')));
  assert.equal(search(archive, 'RejectedReceiptNeedle').total, 0); assert.equal(search(archive, 'OriginalSavedNeedle').total, 1); assert.equal(search(archive, 'OriginalSavedNeedle').truncated, true);
  failing = ''; await archive.capture(answer(0, 'ReplacementSavedNeedle'));
  assert.equal(search(archive, 'ReplacementSavedNeedle').total, 1); assert.equal(search(archive, 'OriginalSavedNeedle').total, 0);
  failing = 'conversation-state.json'; await assert.rejects(archive.rename('turn-0', 'RejectedOrganizationName'));
  await assert.rejects(archive.setState('turn-0', 'deleted'));
  assert.equal(search(archive, 'KeptOrganizationName').total, 1); assert.equal(search(archive, 'RejectedOrganizationName').total, 0); assert.equal(search(archive, '', { state: 'deleted' }).total, 0);
  failing = ''; await archive.rename('turn-0', 'New saved title'); assert.equal(search(archive, 'New saved title').truncated, false);
});

test('damaged saved turns disclose incomplete results and damaged organization fails closed', async t => {
  const { archive, dataDir, open } = await setup(t);
  await archive.capture(answer(0, 'Preserved healthy receipt')); await archive.close();
  await fs.writeFile(path.join(dataDir, 'conversations', 'damaged.json'), '{ broken fixture');
  const partial = await open(); const response = search(partial, 'healthy receipt');
  assert.equal(response.total, 1); assert.equal(response.truncated, true); await partial.close();
  await fs.writeFile(archive.stateFile, '{ broken organization'); await fs.writeFile(archive.stateFile + '.bak', '{ broken backup');
  const unknown = await open();
  for (const state of ['all', 'active', 'archived', 'deleted']) assert.throws(() => search(unknown, 'healthy receipt', { state }), { status: 503, code: 'CONVERSATION_STATE_DAMAGED' });
  assert.equal(await fs.readFile(archive.stateFile, 'utf8'), '{ broken organization');
});

test('query validation rejects malformed input without coercing state, result or offset limits', () => {
  for (const value of [{ q: null }, { q: 'x'.repeat(201) }, { q: '\0' }, { state: 'trash' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '20' }, { offset: -1 }, { offset: NaN }, { offset: 2 ** 54 }]) assert.throws(() => conversationSearchOptions(value), { status: 400, code: 'CONVERSATION_SEARCH_INVALID' });
  assert.deepEqual(conversationSearchOptions({ q: '  ÉTÉ \t café  ', limit: 2, offset: 1 }), { query: 'ÉTÉ \t café', state: 'all', limit: 2, offset: 1, phrase: 'ete cafe', words: ['ete', 'cafe'] });
});

class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', supportsTools: true }] }; }
  async start() { return this.status(); }
  async close() {}
}
async function application(t, runtime = new Runtime(), { listen = true } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-search-http-'));
  const app = await createHarnessServer({ runtime, port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace') });
  t.after(async () => { await app.close(); assert.match(path.basename(directory), /^blackice-search-http-/); await fs.rm(directory, { recursive: true, force: true }); });
  if (!listen) return { app };
  const target = new URL(await app.listen());
  const request = (route, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: target.hostname, port: target.port, path: route, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const value = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, data: String(res.headers['content-type']).includes('application/json') ? JSON.parse(value) : value }); });
    });
    req.setTimeout(3000, () => req.destroy(Error('Search HTTP fixture timed out.'))); req.on('error', reject);
  });
  const home = await request('/'); assert.equal(home.status, 200);
  return { app, request, auth: { Cookie: home.headers['set-cookie'][0].split(';', 1)[0] } };
}

test('search endpoint enforces the existing local session and exposes the bounded search contract', async t => {
  const { app, request, auth } = await application(t);
  const module = await request('/conversation-search.mjs'); assert.equal(module.status, 200); assert.match(module.headers['content-type'], /javascript/);
  await app.conversations.capture(answer(0, 'An endpoint receipt with Café text'));
  assert.equal((await request('/api/conversations/search?q=receipt')).status, 401);
  assert.equal((await request('/api/conversations/search?q=receipt', { ...auth, Origin: 'https://untrusted.example' })).status, 403);
  const response = await request('/api/conversations/search?q=%20CAFE%20&state=all&limit=1&offset=0', auth);
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.data).sort(), ['conversations', 'hasMore', 'limit', 'offset', 'query', 'recoveryRequired', 'state', 'total', 'truncated']);
  assert.equal(response.data.query, 'CAFE'); assert.equal(response.data.conversations[0].match.kind, 'message');
  assert.equal(response.data.limit, 1); assert.equal(response.data.total, 1); assert.equal(response.data.hasMore, false);
  for (const suffix of ['q=' + 'x'.repeat(201), 'q=%00', 'limit=0', 'limit=101', 'limit=1.5', 'limit=-1', 'offset=-1', 'offset=9007199254740992', 'state=unknown', 'q=one&q=two', 'unsupported=value']) assert.equal((await request('/api/conversations/search?' + suffix, auth)).status, 400, suffix);
  app.conversations.stateRecoveryRequired = true;
  try { assert.equal((await request('/api/conversations/search?q=receipt', auth)).status, 503); }
  finally { app.conversations.stateRecoveryRequired = false; }
});

test('answers held behind the real planning gate never become searchable while waiting or after a missing plan', async t => {
  let release, called = false;
  const hold = new Promise(resolve => { release = resolve; }), runtime = new Runtime();
  runtime.runAgent = async options => { called = true; options.onEvent({ type: 'message', itemId: 'held', phase: 'final_answer', text: 'HELD_PLANNING_NEEDLE' }); await hold; return { output: 'HELD_PLANNING_NEEDLE', threadId: 'fixture-thread' }; };
  const { app } = await application(t, runtime, { listen: false }); t.after(release);
  const workflow = { id: 'held-search-flow', name: 'Held answer fixture', nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Answer the request.', sandbox: 'read-only' }, { id: 'output', type: 'output', name: 'Result' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } };
  const run = await app.engine.startRun({ workflow, input: 'A visible planning search request.', planningMode: 'on' });
  const until = async check => { const end = Date.now() + 5000; while (Date.now() < end) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Planning search fixture did not settle.'); };
  try {
    await until(() => called); await app.conversations.chain;
    assert.equal(search(app.conversations, 'HELD_PLANNING_NEEDLE').total, 0);
    assert.equal(search(app.conversations, 'visible planning search').total, 1);
    release(); const settled = await until(() => { const value = app.engine.getRun(run.id); return value.settled && value; }); await app.conversations.chain;
    assert.equal(settled.status, 'failed'); assert.equal(settled.nodes.agent.planning.status, 'missing');
    assert.equal(search(app.conversations, 'HELD_PLANNING_NEEDLE').total, 0);
  } finally { release(); }
});
