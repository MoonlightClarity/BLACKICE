import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { discoverableFileLinks, discoverFinalArtifacts } from '../lib/artifact-discovery.mjs';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createRegisteredArtifactResolver } from '../public/conversation-model.mjs';
import { renderTaskFiles, renderTaskState } from '../public/task-state-ui.mjs';
import { safeSvgPreview } from '../public/svg-preview.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="black"/><path d="M8 32h48M32 8v48" stroke="white"/></svg>';
const digest = value => createHash('sha256').update(value).digest('hex');
async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-artifact-discovery-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(); await store.ensure({ taskId: 'task-files', runId: 'run-files', nodeId: 'agent', cwd, goal: 'Build a real SVG game asset.' });
  t.after(async () => { await store.close(); assert.match(path.basename(directory), /^relay-artifact-discovery-/); await rm(directory, { recursive: true, force: true }); });
  const discover = (output, extra = {}) => discoverFinalArtifacts({ store, taskId: 'task-files', runId: 'run-files', nodeId: 'agent', cwd, output, ...extra });
  return { directory, cwd, store, discover };
}

test('only explicit local links outside code become file candidates', () => {
  const output = [
    'Created [**Board SVG**](./board.svg), [Game source](<game (final).html>) and ![Piece](assets/piece.svg).',
    '[duplicate](./board.svg) [nested [label]](assets/board%20(final).svg)',
    '`[inline](not-output.svg)` ``[inline two](also-not.svg)`` \\[escaped](no.svg)',
    '    [indented](not-output.svg)',
    '\t[tabbed](not-output.svg)',
    '```markdown', '[example](not-output.svg)', '```not-a-closing-fence', '[still code](not-output.svg)', '```',
    '~~~~', '[tilde](not-output.svg)', '~~~~',
    '- ```markdown', '  [list example](not-output.svg)', '  ```',
    '> [quoted example](not-output.svg)',
    '[web](https://example.com/file.svg) [file scheme](file:///C:/file.svg) [action](javascript:alert(1)) [fragment](#file)',
    '[remote](//server/file.svg) [encoded URL](https%3A%2F%2Fexample.com/file.svg) [invalid](%zz) [control](bad%00.svg)',
  ].join('\n');
  assert.deepEqual(discoverableFileLinks(output), { links: [{ href: './board.svg', title: 'Board SVG' }, { href: 'game (final).html', title: 'Game source' }, { href: 'assets/piece.svg', title: 'Piece' }, { href: 'assets/board (final).svg', title: 'nested [label]' }], truncated: false });
  assert.deepEqual(discoverableFileLinks('[one](one.txt) [two](two.txt)', { limit: 1 }), { links: [{ href: 'one.txt', title: 'one' }], truncated: true });
  assert.deepEqual(discoverableFileLinks(null), { links: [], truncated: false });
});

test('actual SVG and spaced file paths become verified clickable outputs without an artifact tool call', async t => {
  const { cwd, discover, store } = await harness(t); await mkdir(path.join(cwd, 'assets')); await writeFile(path.join(cwd, 'assets', 'board (final).svg'), svg);
  const result = await discover('Finished [**Board**](assets/board%20(final).svg).');
  assert.equal(result.receipt.registered.length, 1); assert.equal(result.receipt.skipped.length, 0); assert.equal(result.state.artifacts.length, 1);
  const artifact = result.state.artifacts[0]; assert.equal(artifact.sha256, digest(svg)); assert.equal(artifact.title, 'Board'); assert.equal(artifact.provenance.source, 'runtime'); assert.equal(artifact.provenance.runId, 'run-files'); assert.equal(artifact.provenance.nodeId, 'agent');
  const preview = await store.previewArtifact('task-files', artifact.id); assert.equal(preview.text, svg); assert.ok(safeSvgPreview(preview.text)?.startsWith('data:image/svg+xml;'));
  const resolve = createRegisteredArtifactResolver({ cwd, taskState: result.state }); assert.deepEqual(resolve('assets/board%20(final).svg'), { taskId: 'task-files', artifactId: artifact.id });
  assert.deepEqual(await discover('No file links here.'), { state: null, receipt: null });
});

test('missing files, directories, lexical escapes and symlink escapes leave observable skips; explicit registration remains available', async t => {
  const { cwd, directory, store, discover } = await harness(t), outside = path.join(directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'Outside data.');
  await symlink(outside, path.join(cwd, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discover('[missing](missing.txt) [folder](linked-outside) [parent](../outside/private.txt) [symlink](linked-outside/private.txt)');
  assert.equal(result.state.artifacts.length, 0); assert.equal(result.receipt.skipped.length, 4); assert.equal(result.receipt.registered.length, 0);
  assert.equal(result.receipt.skipped.find(item => item.href === 'missing.txt').code, 'ENOENT');
  assert.equal(result.receipt.skipped.filter(item => item.code === 'ARTIFACT_OUTSIDE_WORKSPACE').length, 3);
  assert.equal((await store.get('task-files')).revision, 1);
  const explicit = await store.addArtifact('task-files', { path: '../outside/private.txt' }, { expectedRevision: 1, runId: 'run-explicit', nodeId: 'agent' });
  assert.equal(explicit.artifacts[0].provenance.source, 'agent'); assert.equal((await store.previewArtifact('task-files', explicit.artifacts[0].id)).text, 'Outside data.');
});

test('manually registered paths and aliases retain their exact receipts, titles and revisions', async t => {
  const { cwd, store, discover } = await harness(t); await writeFile(path.join(cwd, 'board.svg'), svg);
  const manual = await store.addArtifact('task-files', { path: 'board.svg', title: 'My chosen title' }, { expectedRevision: 1, runId: 'manual-run', nodeId: 'manual-agent' });
  const result = await discover('[Different title](board.svg) [Alias](./board.svg)');
  assert.equal(result.receipt.existing.length, 1); assert.equal(result.receipt.registered.length, 0); assert.equal(result.state.revision, manual.revision); assert.deepEqual(result.state.artifacts, manual.artifacts);
});

test('a changed final-linked artifact refreshes bytes while preserving its manually chosen ID/title and historical receipt', async t => {
  const { cwd, store, discover } = await harness(t); await writeFile(path.join(cwd, 'board.svg'), svg);
  const manual = await store.addArtifact('task-files', { path: 'board.svg', title: 'My chosen board name' }, { expectedRevision: 1, runId: 'manual-run', nodeId: 'manual-agent' }), original = manual.artifacts[0];
  const updated = svg.replace('fill="black"', 'fill="white"'); await writeFile(path.join(cwd, 'board.svg'), updated);
  const result = await discover('[A different reply label](board.svg)');
  assert.equal(result.receipt.refreshed.length, 1); assert.equal(result.receipt.registered.length, 0); assert.equal(result.receipt.existing.length, 0);
  assert.equal(result.state.artifacts[0].id, original.id); assert.equal(result.state.artifacts[0].title, 'My chosen board name'); assert.equal(result.state.artifacts[0].sha256, digest(updated)); assert.equal(result.state.artifacts[0].provenance.source, 'runtime');
  assert.equal(result.receipt.refreshed[0].previousSha256, original.sha256); assert.equal(result.receipt.refreshed[0].sha256, digest(updated)); assert.equal((await store.previewArtifact('task-files', original.id)).text, updated);
  const history = await store.history('task-files'); assert.deepEqual(history.find(item => item.revision === manual.revision).artifacts[0], original);
});

test('a compare-and-swap race retries with the latest task revision and preserves the other agent’s plan', async t => {
  const { cwd, store, discover } = await harness(t); await writeFile(path.join(cwd, 'board.svg'), svg);
  const original = store.addArtifact.bind(store); let first = true;
  store.addArtifact = async (...args) => { if (first) { first = false; const state = await store.get('task-files'); await store.setPlan('task-files', { steps: [{ id: 'done', title: 'Another agent finished its work', status: 'done' }] }, { expectedRevision: state.revision, runId: 'other-run', nodeId: 'other-agent' }); } return original(...args); };
  const result = await discover('[Board](board.svg)'); assert.equal(result.state.revision, 3); assert.equal(result.state.steps[0].title, 'Another agent finished its work'); assert.equal(result.state.artifacts.length, 1); assert.equal(result.receipt.skipped.length, 0);
});

test('parallel discovery deduplicates one file and keeps both different files', async t => {
  const { cwd, store, discover } = await harness(t); await writeFile(path.join(cwd, 'board.svg'), svg); await writeFile(path.join(cwd, 'rules.md'), '# Rules\nMove one square.');
  const results = await Promise.all([discover('[Board](board.svg)', { nodeId: 'artist' }), discover('[Board again](./board.svg) [Rules](rules.md)', { nodeId: 'writer' })]);
  const state = await store.get('task-files'); assert.equal(state.artifacts.length, 2); assert.equal(results.flatMap(result => result.receipt.registered).length, 2); assert.ok(state.artifacts.every(item => ['artist', 'writer'].includes(item.provenance.nodeId)));
});

test('cancelled discovery cannot register a file or change task state', async t => {
  const { cwd, store, discover } = await harness(t); await writeFile(path.join(cwd, 'board.svg'), svg); const controller = new AbortController(); controller.abort();
  await assert.rejects(discover('[Board](board.svg)', { signal: controller.signal }), { name: 'AbortError' }); assert.equal((await store.get('task-files')).revision, 1);
});

test('task tools have no hidden turn cutoff and honor an explicitly configured limit', async () => {
  const state = { taskId: 'test-task', revision: 1 }, store = { get: async () => state };
  const unlimited = createTaskToolHandler({ store, taskId: 'test-task' });
  for (let index = 0; index < 275; index++) assert.equal((await unlimited({ name: 'relay_task', arguments: { action: 'read' } })).success, true);
  const limited = createTaskToolHandler({ store, taskId: 'test-task', maxCalls: 1 });
  assert.equal((await limited({ name: 'relay_task', arguments: { action: 'read' } })).success, true);
  await assert.rejects(limited({ name: 'relay_task', arguments: { action: 'read' } }), { code: 'TASK_CALL_LIMIT' });
  for (const maxCalls of [0, -1, 1.5, Infinity]) assert.throws(() => createTaskToolHandler({ store, taskId: 'test-task', maxCalls }), /positive integer or null/);
});

test('standalone Files is compact, escaped and uses the existing verified-preview event hooks', () => {
  const state = { taskId: 'test-task', artifacts: [{ id: 'artifact_1', title: '<script>Board</script>', fileName: 'board.svg', size: 2048 }] };
  const html = renderTaskFiles(state); assert.match(html, /class="task-files"/); assert.match(html, /aria-label="Files"/); assert.match(html, /data-task-artifact="artifact_1"/); assert.match(html, /\/content/); assert.match(html, /2.0 KB/); assert.match(html, /SHA-256/); assert.ok(!html.includes('<script>'));
  assert.equal(renderTaskState(state, { includeArtifacts: false }), ''); assert.match(renderTaskState(state), /Files ready for you/); assert.equal(renderTaskFiles({ artifacts: [] }), '');
  assert.ok(!renderTaskFiles(state, { artifactUrl: () => 'javascript:bad()' }).includes('javascript:'));
  const planned = { ...state, steps: [{ title: 'Create board', status: 'done' }] }; const planOnly = renderTaskState(planned, { includeArtifacts: false }); assert.match(planOnly, /Create board/); assert.ok(!planOnly.includes('board.svg')); assert.equal(planned.artifacts.length, 1, 'presentation must not mutate shared task state');
});

class Runtime extends EventEmitter {
  constructor(execute) { super(); this.execute = execute; }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model' }; }
  async start() { return this.status(); }
  async runAgent(options) { return this.execute(options); }
  async close() {}
}
const graph = { id: 'auto-files', name: 'Automatic output files', nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Artist', prompt: 'Make a board.' }, { id: 'output', type: 'output', name: 'Result' }], edges: [{ id: 'a', source: 'input', target: 'agent' }, { id: 'b', source: 'agent', target: 'output' }], settings: { planningMode: 'off' } };
async function settled(engine, id) { const end = Date.now() + 5000; while (Date.now() < end) { const run = engine.getRun(id); if (run.settled) return run; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Run did not settle.'); }

test('real engine discovers a workspace-written SVG final link and persists its receipt without an explicit artifact tool call', async t => {
  const { cwd, directory, store } = await harness(t), events = [];
  const runtime = new Runtime(async options => {
    const written = await options.onToolCall({ name: 'relay_workspace', arguments: { action: 'write', path: 'chess.svg', text: svg } }); assert.equal(written.success, true);
    assert.match(options.prompt, /Markdown links to the exact actual file paths/); return { output: 'Created [Chess board](chess.svg). [Missing optional export](missing.png)', threadId: 'provider_svg' };
  });
  const engine = new HarnessEngine({ runtime, dataDir: path.join(directory, 'engine'), defaultCwd: cwd, tasks: store }); await engine.init(); engine.on('event', event => events.push(event)); t.after(() => engine.close());
  const run = await settled(engine, engine.startRun({ workflow: graph, input: 'Create a chess board as an SVG.' }).id);
  assert.equal(run.status, 'completed'); assert.equal(run.taskState.artifacts.length, 1); assert.equal(run.taskState.artifacts[0].fileName, 'chess.svg');
  const receipt = run.nodes.agent.artifactDiscovery; assert.equal(receipt.registered.length, 1); assert.equal(receipt.skipped.length, 1); assert.equal(receipt.skipped[0].code, 'ENOENT'); assert.ok(events.some(event => event.data?.type === 'task.artifacts'));
  assert.equal(await readFile(path.join(cwd, 'chess.svg'), 'utf8'), svg); assert.equal((await store.previewArtifact(run.taskId, run.taskState.artifacts[0].id)).text, svg);
  await engine.close(); const disk = JSON.parse(await readFile(path.join(directory, 'engine', 'runs.json'), 'utf8')); assert.deepEqual(disk.find(item => item.id === run.id).nodes.agent.artifactDiscovery, receipt);
});

test('an unavailable optional discovery store leaves an error receipt while the completed agent answer is preserved', async t => {
  const { cwd, directory, store } = await harness(t), originalGet = store.get.bind(store);
  const runtime = new Runtime(async () => { store.get = async () => { throw Object.assign(new Error('Task store was temporarily unavailable.'), { code: 'EIO' }); }; return { output: 'Created [Board](board.svg).', threadId: 'provider_failure' }; });
  const engine = new HarnessEngine({ runtime, dataDir: path.join(directory, 'engine-failure'), defaultCwd: cwd, tasks: store }); await engine.init(); t.after(() => engine.close());
  const run = await settled(engine, engine.startRun({ workflow: graph, input: 'Keep a successful answer if an optional file cannot be registered.' }).id);
  assert.equal(run.status, 'completed'); assert.equal(run.output.includes('[Board](board.svg)'), true); assert.equal(run.nodes.agent.artifactDiscovery.code, 'EIO'); assert.match(run.nodes.agent.artifactDiscovery.error, /temporarily unavailable/);
  store.get = originalGet; await engine.close();
});

test('a real two-turn engine continuation refreshes its final SVG link without another artifact registration call', async t => {
  const { cwd, directory, store } = await harness(t); let turns = 0;
  const updated = svg.replace('stroke="white"', 'stroke="silver"');
  const runtime = new Runtime(async options => { turns++; const written = await options.onToolCall({ name: 'relay_workspace', arguments: { action: 'write', path: 'board.svg', text: turns === 1 ? svg : updated } }); assert.equal(written.success, true); return { output: '[Board](board.svg)', threadId: 'provider_two_turns' }; });
  const engine = new HarnessEngine({ runtime, dataDir: path.join(directory, 'engine-two-turns'), defaultCwd: cwd, tasks: store }); await engine.init(); t.after(() => engine.close());
  const first = await settled(engine, engine.startRun({ workflow: graph, input: 'Create the board.' }).id), firstArtifact = first.taskState.artifacts[0];
  assert.equal(first.status, 'completed'); assert.equal(first.nodes.agent.artifactDiscovery.registered.length, 1);
  const second = await settled(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Make its grid silver.' }).id);
  assert.equal(second.status, 'completed'); assert.equal(second.taskId, first.taskId); assert.equal(second.taskState.artifacts.length, 1); assert.equal(second.taskState.artifacts[0].id, firstArtifact.id);
  assert.equal(second.nodes.agent.artifactDiscovery.refreshed.length, 1); assert.equal(second.taskState.artifacts[0].sha256, digest(updated)); assert.equal(second.taskState.artifacts[0].provenance.runId, second.id);
  assert.equal((await store.previewArtifact(second.taskId, firstArtifact.id)).text, updated); assert.equal((await store.readArtifact(second.taskId, firstArtifact.id)).buffer.toString(), updated);
  assert.equal(engine.getRun(first.id).taskState.artifacts[0].sha256, digest(svg), 'the first turn’s historical run snapshot remains unchanged');
  assert.deepEqual(createRegisteredArtifactResolver(second)('board.svg'), { taskId: first.taskId, artifactId: firstArtifact.id }); await engine.close();
});
