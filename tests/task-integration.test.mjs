import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createHarnessServer } from '../server.mjs';
import { missionProgress } from '../public/mission-model.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const wait = async predicate => { const end = Date.now() + 5000; while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Integration state did not settle.'); };
const graph = { id: 'task-integration', name: 'Durable task integration', nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Finish and verify the task.' }, { id: 'output', type: 'output', name: 'Result' }], edges: [{ id: 'a', source: 'input', target: 'agent' }, { id: 'b', source: 'agent', target: 'output' }], settings: { maxParallel: 1 } };
class Runtime extends EventEmitter {
  constructor(execute = async () => ({ output: 'Done.', threadId: 'provider_test-thread' })) { super(); this.execute = execute; this.calls = []; }
  status() { return { connected: true, authenticated: true, defaultModel: 'test-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent(options) { this.calls.push(options); return this.execute(options, this.calls.length); }
  async close() {}
}
async function engineHarness(t, runtime, { withTasks = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-task-integration-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir }).init(), engine = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd, ...(withTasks ? { tasks } : {}) }), engines = [engine]; await engine.init();
  t.after(async () => { for (const item of engines) await item.close(); await tasks.close(); assert.match(path.basename(directory), /^relay-task-integration-/); await rm(directory, { recursive: true, force: true }); });
  return { engine, tasks, engines, cwd, dataDir };
}
async function taskCall(options, args) { const result = await options.onToolCall({ name: 'relay_task', arguments: args }, { signal: options.signal }); assert.equal(result.success, true, result.contentItems?.[0]?.text); return JSON.parse(result.contentItems[0].text); }
const settled = (engine, id) => wait(() => engine.getRun(id).settled && engine.getRun(id));

for (const ending of ['cancelled', 'failed']) test(`${ending} real saved agent state resumes the same conversation and preserves the stopped run`, async t => {
  const started = deferred(), releaseStop = deferred(), threadId = 'provider_continuity-thread'; let artifactId;
  const runtime = new Runtime(async (options, callNumber) => {
    options.onEvent({ type: 'thread', threadId }); options.onEvent({ type: 'turn', turnId: 'turn-' + callNumber, threadId });
    assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_task'));
    if (callNumber === 1) {
      let state = await taskCall(options, { action: 'read' }); state = await taskCall(options, { action: 'plan', expectedRevision: state.revision, steps: [{ id: 'inspect', title: 'Inspect source', status: 'done', doneWhen: 'The fixture source has been inspected.', evidence: 'The fixture inspected its supplied source before recording this state.' }, { id: 'finish', title: 'Finish the deliverable', status: 'active', doneWhen: 'The complete deliverable is written and its current content has been checked.' }] });
      await writeFile(path.join(options.cwd, 'deliverable.txt'), 'Actual partial work.'); state = await taskCall(options, { action: 'artifact', expectedRevision: state.revision, path: 'deliverable.txt', title: 'Deliverable' }); artifactId = state.artifacts[0].id;
      state = await taskCall(options, { action: 'checkpoint', expectedRevision: state.revision, goal: 'Finish project ALPHA.', completed: ['Inspected the real source.'], decisions: ['Keep the existing implementation.'], nextSteps: ['Complete and recheck the file.'] });
      options.onEvent({ type: 'delta', threadId, delta: 'Partial work is preserved.' }); options.onEvent({ type: 'usage', threadId, usage: { totalTokens: 20, total: { totalTokens: 20 } } }); started.resolve();
      if (ending === 'cancelled') { await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); }); await releaseStop.promise; options.onEvent({ type: 'usage', threadId, usage: { totalTokens: 25, total: { totalTokens: 25 } } }); options.onEvent({ type: 'delta', threadId, delta: 'Unwanted text after stop.' }); throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); }
      throw new Error('Provider transport deliberately failed.');
    }
    assert.equal(options.threadId, threadId, 'continuation must resume, not construct another conversation'); assert.match(options.prompt, /Finish project ALPHA/); assert.match(options.prompt, /Keep the existing implementation/); assert.match(options.prompt, /Verify the current workspace/); assert.deepEqual(options.usageBaseline, { totalTokens: ending === 'cancelled' ? 25 : 20 });
    let state = await taskCall(options, { action: 'read' }); assert.equal(state.interruption.status, ending); assert.equal(state.progress.done, 1); assert.equal(state.artifacts[0].id, artifactId);
    state = await taskCall(options, { action: 'plan', expectedRevision: state.revision, steps: state.steps });
    assert.equal(await readFile(path.join(options.cwd, 'deliverable.txt'), 'utf8'), 'Actual partial work.'); await writeFile(path.join(options.cwd, 'deliverable.txt'), 'Actual finished work.');
    state = await taskCall(options, { action: 'artifact', expectedRevision: state.revision, path: 'deliverable.txt' }); state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'finish', status: 'done', evidence: 'Read and replaced the fixture deliverable, then checked the current registered bytes.' });
    assert.equal(state.progress.done, 2); assert.equal(state.interruption, null); return { output: 'Completed and checked.', threadId, usage: { totalTokens: 10, total: { totalTokens: 30 } } };
  });
  const { engine, tasks, engines, cwd, dataDir } = await engineHarness(t, runtime), original = engine.startRun({ workflow: graph, input: 'Finish project ALPHA.' }); await started.promise;
  if (ending === 'cancelled') { engine.cancelRun(original.id); assert.throws(() => engine.continueRun(original.id, { nodeId: 'agent', message: 'Too soon.' }), /active|stopping|finish/i); releaseStop.resolve(); }
  const stopped = await settled(engine, original.id); assert.equal(stopped.status, ending); assert.equal(stopped.nodes.agent.threadId, threadId); assert.equal(stopped.nodes.agent.output, 'Partial work is preserved.'); assert.equal(stopped.nodes.agent.usage.total.totalTokens, ending === 'cancelled' ? 25 : 20); assert.equal(stopped.taskState.checkpoint.kind, 'agent'); assert.equal(stopped.taskState.interruption.status, ending);
  assert.equal(stopped.taskState.checkpoint.provenance.runId, original.id); assert.equal(stopped.taskState.checkpoint.provenance.nodeId, 'agent'); assert.equal(stopped.taskState.checkpoint.provenance.source, 'agent'); assert.equal(stopped.taskState.interruption.provenance.runId, original.id); assert.equal(stopped.taskState.interruption.provenance.source, 'runtime');
  const stoppedSnapshot = structuredClone(stopped);
  const followup = engine.continueRun(original.id, { nodeId: 'agent', message: 'Finish the remaining work.' }); const completed = await settled(engine, followup.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error || completed.nodes.agent.error)); assert.equal(completed.taskId, original.id); assert.equal(completed.continuedFrom.threadId, threadId); assert.equal(completed.taskState.progress.done, 2); assert.deepEqual(engine.getRun(original.id), stoppedSnapshot, 'continuation must preserve all original output and checkpoint records');
  assert.equal(completed.taskState.goal, 'Finish project ALPHA.'); assert.equal(completed.taskState.provenance.runId, followup.id); assert.equal(completed.taskState.provenance.nodeId, 'agent'); assert.equal(completed.taskState.artifacts[0].provenance.runId, followup.id); assert.equal(completed.taskState.checkpoint.provenance.runId, original.id, 'historical checkpoint provenance must not be rewritten by continuation');
  assert.equal((await tasks.previewArtifact(original.id, artifactId)).text, 'Actual finished work.');
  await engine.close(); const nextRuntime = new Runtime(), restored = new HarnessEngine({ runtime: nextRuntime, tasks, dataDir, defaultCwd: cwd }); engines.push(restored); await restored.init();
  assert.deepEqual(restored.getRun(original.id).taskState, stoppedSnapshot.taskState); assert.equal(restored.getRun(followup.id).taskState.progress.done, 2); assert.equal((await tasks.get(original.id)).progress.done, 2);
});

test('legacy native threads retain their real tool catalog while new tasks receive relay_task', async t => {
  const nativeThread = 'legacy-native-thread', runtime = new Runtime(async options => ({ output: 'Original native result.', threadId: options.threadId || nativeThread }));
  const { engine, tasks, cwd, dataDir, engines } = await engineHarness(t, runtime, { withTasks: false });
  const original = engine.startRun({ workflow: graph, input: 'Keep the original user objective.', planningMode: 'off' }); await settled(engine, original.id); assert.deepEqual(runtime.calls[0].dynamicTools.map(tool => tool.name), ['relay_workspace', 'relay_control']);
  // Simulate a saved thread from before the task and control gateways existed.
  engine.runs.get(original.id).nodes.agent.toolNames = ['relay_workspace']; await engine.close();
  const nextRuntime = new Runtime(async options => ({ output: 'Native resumed.', threadId: options.threadId || 'new-native-thread' })), restored = new HarnessEngine({ runtime: nextRuntime, tasks, dataDir, defaultCwd: cwd }); engines.push(restored); await restored.init();
  const continuation = restored.continueRun(original.id, { nodeId: 'agent', message: 'Refine the original result.' }); const run = await settled(restored, continuation.id); const resumed = nextRuntime.calls[0];
  assert.equal(resumed.threadId, nativeThread); assert.deepEqual(resumed.dynamicTools.map(tool => tool.name), ['relay_workspace']); assert.match(run.nodes.agent.capabilitiesNote, /original tools/); assert.match(resumed.prompt, /relay_task is available in new tasks/); assert.ok(!resumed.prompt.includes('Read relay_task for full state before editing.'), 'a legacy thread must not be told to call an unattached tool');
  assert.equal((await tasks.get(original.id)).goal, 'Keep the original user objective.');
  const fresh = restored.startRun({ workflow: graph, input: 'A new task has the new gateway.', planningMode: 'off' }); await settled(restored, fresh.id); assert.ok(nextRuntime.calls[1].dynamicTools.some(tool => tool.name === 'relay_task')); assert.ok(nextRuntime.calls[1].dynamicTools.some(tool => tool.name === 'relay_control')); assert.notEqual(fresh.taskId, original.id);
});

async function application(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-task-http-integration-')), app = await createHarnessServer({ runtime: new Runtime(), port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), autoAttachDesktop: false }); await app.learning.updateSettings({ mode: 'off' }); const url = new URL(await app.listen());
  t.after(async () => { await app.close(); assert.match(path.basename(directory), /^relay-task-http-integration-/); await rm(directory, { recursive: true, force: true }); });
  function request(route, { cookie, origin, method = 'GET', body } = {}) { return new Promise((resolve, reject) => { const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body)), req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const buffer = Buffer.concat(chunks); let data; if (String(response.headers['content-type']).includes('application/json')) { try { data = JSON.parse(buffer.toString()); } catch (error) { reject(error); return; } } resolve({ status: response.statusCode, headers: response.headers, buffer, data }); }); response.on('error', reject); }); req.setTimeout(5000, () => req.destroy(new Error('Request timed out.'))); req.on('error', reject); req.end(bytes); }); }
  const home = await request('/'), cookie = home.headers['set-cookie'][0].split(';')[0]; return { app, directory, request, cookie };
}

test('authenticated HTTP artifact previews and downloads return verified actual bytes and reject changed files', async t => {
  const { app, request, cookie } = await application(t), cwd = app.engine.defaultCwd;
  let state = await app.tasks.ensure({ taskId: 'http-task', runId: 'http-run', nodeId: 'agent', cwd, goal: 'Produce files.' }); const filename = 'finished result.txt', text = '<script>Task data only</script>\nReal report.'; await writeFile(path.join(cwd, filename), text);
  state = await app.tasks.addArtifact('http-task', { path: filename }, { expectedRevision: state.revision, runId: 'http-run', nodeId: 'agent' }); const artifact = state.artifacts[0], route = `/api/tasks/http-task/artifacts/${artifact.id}`;
  assert.equal((await request(route + '/content')).status, 401); assert.equal((await request(route + '/preview', { cookie, origin: 'https://other.example' })).status, 403);
  const preview = await request(route + '/preview', { cookie }); assert.equal(preview.status, 200); assert.equal(preview.data.text, text); assert.equal(preview.data.previewKind, 'text'); assert.equal(preview.data.sha256, artifact.sha256);
  const download = await request(route + '/content', { cookie }); assert.equal(download.status, 200); assert.equal(download.buffer.toString(), text); assert.equal(download.headers['content-type'], 'text/plain; charset=utf-8'); assert.equal(Number(download.headers['content-length']), Buffer.byteLength(text)); assert.match(download.headers['content-disposition'], /attachment;.*finished%20result\.txt/); assert.equal(download.headers['x-content-type-options'], 'nosniff'); assert.equal(download.headers['cache-control'], 'no-store');
  for (const suffix of ['../finished%20result.txt/content', 'artifact_00000000-0000-0000-0000-000000000000/content']) assert.equal((await request('/api/tasks/http-task/artifacts/' + suffix, { cookie })).status, 404);
  await writeFile(path.join(cwd, filename), 'This is a different file now.'); assert.equal((await request(route + '/content', { cookie })).status, 409); assert.equal((await request(route + '/preview', { cookie })).status, 409);
  const current = await request('/api/tasks/http-task', { cookie }); assert.equal(current.status, 200); assert.equal(current.data.artifacts[0].sha256, artifact.sha256, 'a failed preview must not silently update registration');
});

test('large real deliverables retain a usable metadata preview and deleted files return404', async t => {
  const { app, request, cookie } = await application(t), cwd = app.engine.defaultCwd, large = Buffer.alloc(33 * 1024 * 1024 + 1, 65); await writeFile(path.join(cwd, 'large.txt'), large);
  let state = await app.tasks.ensure({ taskId: 'large-task', runId: 'large-run', nodeId: 'agent', cwd, goal: 'A real large result.' }); state = await app.tasks.addArtifact('large-task', { path: 'large.txt' }, { expectedRevision: state.revision }); const route = `/api/tasks/large-task/artifacts/${state.artifacts[0].id}`;
  const preview = await request(route + '/preview', { cookie }); assert.equal(preview.status, 200); assert.equal(preview.data.previewKind, 'download'); assert.match(preview.data.message, /too large.*preview/i); assert.equal(preview.data.size, large.length); assert.equal(preview.data.artifact.path, path.join(cwd, 'large.txt'));
  const download = await request(route + '/content', { cookie }); assert.equal(download.status, 200); assert.deepEqual(download.buffer, large);
  await rm(path.join(cwd, 'large.txt')); const missing = await request(route + '/preview', { cookie }); assert.equal(missing.status, 404); assert.equal((await request(route + '/content', { cookie })).status, 404);
});

test('HTTP image preview has real image bytes and all new task UI modules are served', async t => {
  const { app, request, cookie } = await application(t), cwd = app.engine.defaultCwd;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=', 'base64'); await writeFile(path.join(cwd, 'pixel.png'), png);
  let state = await app.tasks.ensure({ taskId: 'image-task', runId: 'image-run', nodeId: 'agent', cwd, goal: 'Create a pixel.' }); state = await app.tasks.addArtifact('image-task', { path: 'pixel.png' }, { expectedRevision: state.revision });
  const preview = await request(`/api/tasks/image-task/artifacts/${state.artifacts[0].id}/preview`, { cookie }); assert.equal(preview.status, 200); assert.equal(preview.data.previewKind, 'image'); assert.deepEqual(Buffer.from(preview.data.imageUrl.split(',')[1], 'base64'), png); assert.ok(preview.data.imageUrl.startsWith('data:image/png;base64,'));
  for (const route of ['/task-state-ui.mjs', '/task-state.css', '/inbox-ui.mjs', '/inbox.css', '/attachments-ui.mjs', '/attachments.css']) { const response = await request(route); assert.equal(response.status, 200, route + ' must load for the interface to start'); assert.match(response.headers['content-type'], /(?:javascript|css)/); }
});

test('Mission uses actual saved plan counts and does not label graph plumbing as finished task steps', () => {
  const run = { status: 'running', workflow: graph, nodes: { input: { status: 'completed' }, agent: { status: 'running' }, output: { status: 'queued' } }, taskState: { steps: [{ id: 'inspect', title: 'Inspect', status: 'done' }, { id: 'finish', title: 'Finish', status: 'active' }] } };
  const progress = missionProgress(run); assert.equal(progress.source, 'agent-plan'); assert.equal(progress.completed, 1); assert.equal(progress.total, 2); assert.match(progress.detail, /1 of 2 saved steps marked complete/);
  delete run.taskState; const withoutPlan = missionProgress(run); assert.equal(withoutPlan.source, 'workflow-stages'); assert.ok(!/steps finished|saved steps/.test(withoutPlan.detail));
});
