import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { ATTACHMENT_SCHEMA_VERSION, ATTACHMENT_TOOL } from '../lib/attachments.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const ids = Object.fromEntries(['text', 'image', 'pdf', 'file'].map((kind, i) => [kind, `file_${String(i + 1).repeat(32)}`]));
const originalFields = ['action', 'attachmentId', 'startLine', 'lineCount', 'startChar', 'charCount', 'query', 'limit', 'caseSensitive'];
const fileTool = options => options.dynamicTools.find(tool => tool.name === 'relay_files');
const wait = async predicate => { const until = Date.now() + 5000; while (Date.now() < until) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Attachment-schema fixture did not settle.'); };
class FixtureAttachments {
  constructor() {
    this.calls = []; this.text = 'Actual <file> & text.\nSecond line.';
    this.entries = new Map(Object.entries(ids).map(([kind, id]) => [id, { id, kind, name: `fixture.${{ text: 'txt', image: 'png', pdf: 'pdf', file: 'bin' }[kind]}`, mime: { text: 'text/plain', image: 'image/png', pdf: 'application/pdf', file: 'application/octet-stream' }[kind], size: 40, sha256: 'a'.repeat(64), reader: 'MODERN_READER_DETAILS' }]));
  }
  validateIds(values) { assert.ok(values.every(id => this.entries.has(id))); return [...new Set(values)]; }
  async get(id) { this.calls.push({ action: 'get', id }); this.beforeGet?.(id); return structuredClone(this.entries.get(id)); }
  async snapshot(values) { this.calls.push({ action: 'snapshot', ids: [...values] }); return values.map(id => structuredClone(this.entries.get(id))); }
  async prompt() { this.calls.push({ action: 'prompt' }); return 'MODERN_ATTACHMENT_PROMPT: PDF pages, read_bytes and export.\n'; }
  async readChars(id, options) { this.calls.push({ action: 'readChars', id, options }); assert.equal(this.entries.get(id).kind, 'text', 'Legacy prompt must not decode a PDF or binary'); const startChar = options.startChar ?? 0; return { attachment: this.entries.get(id), text: this.text.slice(startChar, startChar + (options.charCount ?? 10000)), startChar, totalChars: this.text.length }; }
  async read(id, options) { this.calls.push({ action: 'read', id, options }); return { attachment: this.entries.get(id), lines: [{ line: 1, text: 'Actual file text.' }] }; }
  async search(id, options) { this.calls.push({ action: 'search', id, options }); return { attachment: this.entries.get(id), matches: [{ text: 'Actual file text.' }] }; }
  async image(id, options) { this.calls.push({ action: 'image', id, options }); return { attachment: this.entries.get(id), bytes: Buffer.from('fixture pixels'), mime: 'image/png', width: 1, height: 1 }; }
  async readBytes(id, options) { this.calls.push({ action: 'readBytes', id, options }); return { attachment: this.entries.get(id), dataBase64: 'AQID', nextOffset: null }; }
  async export(id, options) { this.calls.push({ action: 'export', id, options }); return { attachment: this.entries.get(id), path: path.join(options.cwd, 'owned-fixture-copy.bin') }; }
}
async function fixture(t, execute, { model = 'fixture', threadId = 'native-attachment-thread' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-attachment-schema-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const attachments = new FixtureAttachments();
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; }
    status() { return { connected: true, authenticated: true, defaultModel: model }; }
    async runAgent(options) { this.calls.push(options); options.onEvent({ type: 'thread', threadId }); return execute(options, this.calls.length, attachments, cwd); }
    async close() {}
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, attachments, dataDir: directory, defaultCwd: cwd }).init();
  t.after(async () => { await engine.close(); assert.match(path.basename(directory), /^blackice-attachment-schema-/); await rm(directory, { recursive: true, force: true }); });
  const workflow = createMissionWorkflow({ id: 'attachment-schema-fixture', task: 'Use the attached task files.', cwd });
  return { engine, runtime, attachments, cwd, workflow, threadId, start: () => engine.startRun({ workflow, input: { task: 'Read the actual attachment.', attachmentIds: Object.values(ids) } }), settled: id => wait(() => engine.getRun(id).settled && engine.getRun(id)) };
}
const completed = run => assert.equal(run.status, 'completed', run.nodes.agent.error || run.error);
const call = (options, args, context) => options.onToolCall({ name: 'relay_files', arguments: args }, context);

test('fresh native attachment schema is recorded and survives continuation and Retry', async t => {
  const f = await fixture(t, async (options, number, store, cwd) => {
    assert.deepEqual(fileTool(options), ATTACHMENT_TOOL);
    assert.match(options.prompt, /MODERN_ATTACHMENT_PROMPT/);
    if (number === 1) {
      await call(options, { action: 'read', attachmentId: ids.pdf, startPage: 2, pageCount: 1 });
      await call(options, { action: 'read_bytes', attachmentId: ids.file, offset: 0, byteCount: 3 });
      await call(options, { action: 'export', attachmentId: ids.file });
      assert.equal(store.calls.find(item => item.action === 'export').options.cwd, cwd);
    }
    if (number === 2) throw Error('Fixture response lost after a native thread was established.');
    return { output: 'File result.', threadId: 'native-attachment-thread' };
  });
  const first = await f.settled(f.start().id); completed(first); assert.equal(first.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  const failed = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the current file gateway.' }).id); assert.equal(failed.status, 'failed');
  assert.equal(failed.nodes.agent.resumeAttachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  const retry = await f.settled(f.engine.retryRun(failed.id).id); completed(retry); assert.equal(retry.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  assert.equal(f.runtime.calls[2].threadId, f.threadId);
});

test('unversioned native threads retain their old schema, text/image tools, scope and cancellation', async t => {
  const f = await fixture(t, async (options, number, store) => {
    if (number > 1) {
      const tool = fileTool(options), properties = tool.inputSchema.properties;
      assert.deepEqual(properties.action.enum, ['list', 'read', 'search', 'image']);
      assert.deepEqual(Object.keys(properties), originalFields);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(properties.query.minLength, undefined);
      assert.doesNotMatch(options.prompt, /MODERN_ATTACHMENT_PROMPT|MODERN_READER_DETAILS/);
      assert.match(options.prompt, /original relay_files schema/);
      assert.match(options.prompt, /This saved tool schema cannot read this format/);
      assert.match(options.prompt, /Actual \\u003cfile\\u003e \\u0026 text/);
      assert.match(options.prompt, /require a new task/);
      if (number === 2) {
        const listed = await call(options, { action: 'list' }); assert.equal(JSON.parse(listed.contentItems[0].text).length, 4);
        assert.equal((await call(options, { action: 'read', attachmentId: ids.text })).success, true);
        assert.equal((await call(options, { action: 'read', attachmentId: ids.text, startChar: 0, charCount: 5 })).success, true);
        assert.equal((await call(options, { action: 'search', attachmentId: ids.text, query: 'Actual' })).success, true);
        assert.equal((await call(options, { action: 'image', attachmentId: ids.image })).contentItems[1].type, 'inputImage');
        const before = store.calls.length;
        for (const args of [
          { action: 'export', attachmentId: ids.file }, { action: 'read_bytes', attachmentId: ids.file },
          ...['startPage', 'pageCount', 'page', 'offset', 'byteCount'].map(key => ({ action: 'read', attachmentId: ids.text, [key]: 1 })),
        ]) await assert.rejects(call(options, args), { code: 'ATTACHMENT_SCHEMA_UNAVAILABLE' });
        assert.equal(store.calls.length, before, 'Unadvertised arguments must be rejected before storage');
        for (const id of [ids.pdf, ids.file]) for (const action of ['read', 'search', 'image']) await assert.rejects(call(options, { action, attachmentId: id, query: 'text' }), { code: 'ATTACHMENT_SCHEMA_UNAVAILABLE' });
        assert.ok(store.calls.slice(before).every(item => item.action === 'get'), 'Unsupported formats must not reach a decoder');
        const scoped = store.calls.length;
        await assert.rejects(call(options, { action: 'read', attachmentId: `file_${'f'.repeat(32)}` }), { status: 403 });
        assert.equal(store.calls.length, scoped, 'Foreign attachment metadata must not be read');
        const abort = new AbortController(); store.beforeGet = () => abort.abort();
        await assert.rejects(call(options, { action: 'read', attachmentId: ids.text }, { signal: abort.signal }), { name: 'AbortError' });
        store.beforeGet = null; assert.equal(store.calls.at(-1).action, 'get', 'Cancellation during metadata lookup must precede file reading');
        throw Error('Fixture interrupted an old native turn.');
      }
    }
    return { output: 'Original file tools retained.', threadId: 'native-attachment-thread' };
  });
  const first = await f.settled(f.start().id); completed(first);
  delete f.engine.runs.get(first.id).nodes.agent.attachmentSchemaVersion;
  const old = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue an older saved native conversation.' }).id); assert.equal(old.status, 'failed'); assert.match(old.nodes.agent.error, /Fixture interrupted/); assert.equal(old.nodes.agent.attachmentSchemaVersion, 1);
  delete f.engine.runs.get(old.id).nodes.agent.attachmentSchemaVersion;
  const retry = await f.settled(f.engine.retryRun(old.id).id); completed(retry); assert.equal(retry.nodes.agent.attachmentSchemaVersion, 1); assert.equal(retry.nodes.agent.resumeAttachmentSchemaVersion, 1);
  assert.equal(f.attachments.calls.filter(item => item.action === 'prompt').length, 1, 'Old native prompts must not use the modern gateway instructions');
  assert.match(retry.nodes.agent.capabilitiesNote, /retains its original tools/);
});

test('a native conversation without relay_files does not gain it or advertise new attachment actions', async t => {
  const f = await fixture(t, async (options, number) => {
    if (number > 1) {
      assert.equal(fileTool(options), undefined);
      assert.doesNotMatch(options.prompt, /MODERN_ATTACHMENT_PROMPT|MODERN_READER_DETAILS|TASK ATTACHMENTS — SAVED TOOL SCHEMA/);
      assert.match(options.prompt, /cannot gain relay_files/);
      await assert.rejects(call(options, { action: 'list' }), /not attached/);
    }
    return { output: 'Metadata was preserved.', threadId: 'native-attachment-thread' };
  });
  const first = await f.settled(f.start().id); completed(first);
  const saved = f.engine.runs.get(first.id).nodes.agent; delete saved.attachmentSchemaVersion; saved.toolNames = saved.toolNames.filter(name => name !== 'relay_files');
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Keep this original catalog.' }).id); completed(next); assert.equal(next.nodes.agent.attachmentSchemaVersion, undefined);
});

test('API continuations receive current attachment tools even when an earlier schema version is absent', async t => {
  const threadId = 'provider_attachment-fixture';
  const f = await fixture(t, async options => { assert.deepEqual(fileTool(options), ATTACHMENT_TOOL); return { output: 'API tool catalog refreshed.', threadId }; }, { model: 'fixture-api::model', threadId });
  const first = await f.settled(f.start().id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.attachmentSchemaVersion;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue through the API provider.' }).id); completed(next); assert.equal(next.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION); assert.equal(f.runtime.calls[1].threadId, threadId);
});

test('an explicit fresh native history restart can attach the current schema without changing the old turn', async t => {
  const f = await fixture(t, async options => { assert.deepEqual(fileTool(options), ATTACHMENT_TOOL); return { output: 'Actual saved result.', threadId: 'native-attachment-thread' }; });
  const first = await f.settled(f.start().id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.attachmentSchemaVersion;
  f.engine.runtimeSettings = { get: () => ({ codexHistory: 'relay' }) };
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Start the configured fresh history turn.' }).id); completed(next);
  assert.equal(next.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION); assert.equal(f.runtime.calls[1].threadId, undefined); assert.equal(next.modelHandoff.reason, 'relay-history'); assert.equal(f.engine.getRun(first.id).nodes.agent.attachmentSchemaVersion, undefined);
});

test('legacy attachment context stays bounded with ten heavily escaped text excerpts', async t => {
  const f = await fixture(t, async (options, number, store) => {
    if (number > 1) {
      const start = options.prompt.indexOf('\nATTACHED TASK FILES\n'), end = options.prompt.indexOf('\n\nTASK ATTACHMENTS — SAVED TOOL SCHEMA', start);
      assert.ok(start >= 0 && end > start);
      const context = options.prompt.slice(start, end); assert.ok(context.length <= 16000);
      const metadata = JSON.parse(context.slice(context.indexOf('\n[') + 1).trim());
      assert.equal(metadata.length, 10); assert.ok(metadata.every(entry => entry.excerptTruncated === true));
      assert.ok(metadata.every(entry => !Object.hasOwn(entry, 'reader')));
      assert.ok(store.calls.filter(item => item.action === 'readChars').every(item => item.options.charCount === 1200));
    }
    return { output: 'Bounded context retained.', threadId: 'native-attachment-thread' };
  });
  const attachmentIds = Array.from({ length: 10 }, (_, i) => `file_${i.toString(16).repeat(32)}`);
  f.attachments.entries = new Map(attachmentIds.map(id => [id, { ...f.attachments.entries.get(ids.text), id, name: '<&>'.repeat(80) }]));
  f.attachments.text = '<&>'.repeat(30000);
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: { task: 'Read these bounded text attachments.', attachmentIds } }).id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.attachmentSchemaVersion;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the old file schema.' }).id); completed(next);
});
