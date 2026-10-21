import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';
import { createConversationExport, parseConversationExport, renderConversationMarkdown, serializeConversationExport } from '../lib/conversation-export.mjs';

const at = index => new Date(1700000000000 + index * 1000).toISOString();
function run(index = 0, overrides = {}) {
  return {
    id: `turn-${index}`, taskId: 'turn-0', parentRunId: index ? `turn-${index - 1}` : null,
    createdAt: at(index), finishedAt: at(index + 1), settled: true, status: 'completed', input: `Question ${index}`, output: `Answer ${index}`,
    workflow: { nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Researcher', model: 'router::vendor/model', systemPrompt: 'PRIVATE_SYSTEM_INSTRUCTION' }] },
    nodes: { agent: { status: 'completed', output: `Answer ${index}`, threadId: 'PROVIDER_PRIVATE_THREAD', resumeThreadId: 'RESUME_PRIVATE_THREAD', turnId: 'PRIVATE_TURN', toolNames: ['PRIVATE_TOOL_NAME'], resolvedModel: 'router::vendor/model' } },
    events: [], ...overrides,
  };
}
const family = runs => ({ rootId: 'turn-0', state: 'active', title: 'Release notes', runs });
class OfflineEngine extends EventEmitter {
  listRuns() { return []; }
  getRun() { throw Error('Provider deliberately offline.'); }
}

test('portable export projects visible text and model metadata without provider or local-machine internals', () => {
  const source = run(0, {
    cwd: 'C:\\Private\\workspace', attachmentIds: ['file_1'], metadata: { clientRequestId: 'PRIVATE_RECEIPT' },
    connection: { apiKey: 'PRIVATE_API_KEY', extraHeaders: { Authorization: 'PRIVATE_AUTH_HEADER' }, baseUrl: 'https://PRIVATE_ENDPOINT/' },
    modelHandoff: { context: 'PRIVATE_HANDOFF_CONTEXT', sourceThreadId: 'PRIVATE_SOURCE_THREAD' },
    events: [
      { at: at(0), nodeId: 'agent', data: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
      { at: at(0), nodeId: 'agent', data: { type: 'item', item: { type: 'mcpToolCall', arguments: { password: 'PRIVATE_TOOL_PASSWORD' }, output: 'PRIVATE_TOOL_RESULT' } } },
      { at: at(1), nodeId: 'agent', data: { type: 'message', itemId: 'answer', phase: 'final_answer', text: 'Answer 0' } },
    ],
  });
  const manifest = [{ id: 'file_1', name: 'notes.md', kind: 'text', mime: 'text/markdown', size: 16, sha256: 'a'.repeat(64), path: 'C:\\Private\\source.md', content: 'PRIVATE_ATTACHMENT_BYTES' }];
  const document = createConversationExport(family([source]), { attachmentManifest: manifest, exportedAt: at(10) });
  assert.deepEqual(document.turns[0].messages.map(item => [item.role, item.text]), [['user', 'Question 0'], ['assistant', 'Answer 0']]);
  assert.deepEqual(document.turns[0].models[0], { nodeId: 'agent', name: 'Researcher', provider: 'router', model: 'vendor/model', status: 'completed' });
  assert.equal(document.conversation.resumable, false);
  assert.equal(document.included.providerSessions, false);
  assert.equal(document.included.attachmentContents, false);
  const serialized = JSON.stringify(document);
  for (const forbidden of ['PRIVATE_', 'threadId', 'turnId', 'resumeThreadId', 'apiKey', 'Authorization', 'baseUrl', 'cwd', '"systemPrompt":', 'toolNames']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(document.attachments[0]), ['id', 'name', 'kind', 'mime', 'size', 'sha256', 'available']);
  assert.deepEqual(source.attachmentIds, ['file_1'], 'Export never mutates the saved run.');
});

test('export contains every agent, accepted directions, distinct commentary and final text without retry duplicates', () => {
  const first = run(0, { output: 'Final result', nodes: { agent: { status: 'completed', output: 'Final result' }, writer: { status: 'completed', output: 'Draft result', resolvedModel: 'local::other-model' } },
    workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Researcher', model: 'native-model' }, { id: 'writer', type: 'agent', name: 'Writer', model: 'local::other-model' }] },
    events: [
      { at: at(0), nodeId: 'agent', data: { type: 'delta', itemId: 'first', delta: 'Checking' } },
      { at: at(0), nodeId: 'agent', data: { type: 'message', itemId: 'first', text: 'Checking sources', phase: 'commentary' } },
      { at: at(1), nodeId: 'agent', data: { type: 'steer', text: 'Use the current year.', accepted: true } },
      { at: at(1), nodeId: 'agent', data: { type: 'steer', text: 'Rejected direction', accepted: false } },
      { at: at(2), nodeId: 'agent', data: { type: 'message', itemId: 'last', text: 'Final result', phase: 'final_answer' } },
    ],
  });
  const retry = run(1, { retryOf: 'turn-0', input: first.input });
  const document = createConversationExport(family([retry, first]));
  assert.deepEqual(document.turns.map(turn => turn.id), ['turn-0', 'turn-1']);
  assert.deepEqual(document.turns[0].messages.map(message => message.text), ['Question 0', 'Checking sources', 'Use the current year.', 'Final result', 'Draft result']);
  assert.equal(document.turns[0].messages[2].direction, true);
  assert.equal(document.turns[0].models[0].provider, 'codex');
  assert.equal(document.turns[1].retry, true);
  assert.equal(document.turns[1].messages.filter(message => message.role === 'user').length, 0);
});

test('a running snapshot labels partial text and missing attachments honestly', () => {
  const document = createConversationExport({ ...family([run(0, { status: 'running', settled: false, attachmentIds: ['missing-file'], output: '', nodes: { agent: { status: 'running', output: 'Partial answer' } } })]), truncated: true });
  assert.equal(document.conversation.snapshot, true);
  assert.equal(document.conversation.archiveIncomplete, true);
  assert.equal(document.turns[0].status, 'running');
  assert.equal(document.turns[0].messages.at(-1).text, 'Partial answer');
  assert.deepEqual(document.attachments, [{ id: 'missing-file', available: false }]);
  const markdown = renderConversationMarkdown(document);
  assert.match(markdown, /still running/);
  assert.match(markdown, /may be incomplete/);
  assert.match(markdown, /missing-file — unavailable/);
});

test('Markdown and JSON preserve multiline message content; titles and filenames cannot add paths or headings', () => {
  const message = 'Use `x`\n\n```js\nconst x = 1;\n```\n[Artifact](https://example.com/)';
  const input = { ...family([run(0, { input: message })]), title: '../../Example\r\n# Surprise*' };
  const json = serializeConversationExport(input, { exportedAt: at(10) });
  assert.equal(json.contentType, 'application/json; charset=utf-8');
  assert.equal(JSON.parse(json.body).turns[0].messages[0].text, message);
  assert.ok(!/[<>:"/\\|?*\x00-\x1f\x7f]/.test(json.filename));
  const markdown = serializeConversationExport(input, { format: 'markdown' });
  assert.equal(markdown.contentType, 'text/markdown; charset=utf-8');
  assert.match(markdown.filename, /\.md$/);
  assert.ok(markdown.body.includes(message));
  assert.ok(!markdown.body.startsWith('# ../../Example\r\n# Surprise'));
  assert.throws(() => serializeConversationExport(input, { format: 'xml' }), { code: 'CONVERSATION_EXPORT_INVALID' });
});

test('transcript parser strips injected provider sessions and configuration; rejects unsupported roles and versions', () => {
  const document = createConversationExport(family([run()]));
  document.providerConfig = { apiKey: 'PRIVATE' };
  document.conversation.resumable = true;
  document.turns[0].threadId = 'PRIVATE';
  document.turns[0].messages[0].command = 'PRIVATE';
  const parsed = parseConversationExport(JSON.stringify(document));
  assert.equal(parsed.conversation.resumable, false);
  assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
  assert.throws(() => parseConversationExport({ ...document, version: 2 }), { code: 'CONVERSATION_EXPORT_INVALID' });
  document.turns[0].messages[0].role = 'system';
  assert.throws(() => parseConversationExport(document), { code: 'CONVERSATION_EXPORT_INVALID' });
  for (const value of [null, [], 'not json', { format: 'relay-conversation', version: 1 }]) assert.throws(() => parseConversationExport(value), { code: 'CONVERSATION_EXPORT_INVALID' });
});

test('durable export works offline after restart, includes evicted turns and preserves archive state', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-export-')), archives = [];
  t.after(async () => { for (const archive of archives) await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  const first = await new ConversationArchive({ dataDir, engine: new OfflineEngine() }).init(); archives.push(first);
  for (let index = 0; index < 105; index++) await first.capture(run(index, { attachmentIds: index === 0 ? ['missing-file'] : [] }));
  await first.rename('turn-104', 'All my work');
  await first.setState('turn-0', 'archived');
  await first.close();
  const restored = await new ConversationArchive({ dataDir, engine: new OfflineEngine() }).init(); archives.push(restored);
  const attachmentLookups = [];
  const exported = await restored.export('turn-104', { attachments: { get: async id => { attachmentLookups.push(id); throw Error('File not available.'); } } });
  const document = parseConversationExport(exported.body);
  assert.equal(exported.filename, 'All my work.json');
  assert.equal(document.turns.length, 105);
  assert.equal(document.turns[0].messages[0].text, 'Question 0');
  assert.equal(document.turns[104].messages.at(-1).text, 'Answer 104');
  assert.equal(document.conversation.state, 'archived');
  assert.equal(document.conversation.archiveIncomplete, false);
  assert.equal(restored.list('archived').length, 1);
  assert.deepEqual(attachmentLookups, ['missing-file']);
  assert.deepEqual(document.attachments, [{ id: 'missing-file', available: false }]);
  assert.equal((await restored.get('turn-0')).nodes.agent.threadId, 'PROVIDER_PRIVATE_THREAD');
  await assert.rejects(restored.export('../outside'), /not found/i);
});
