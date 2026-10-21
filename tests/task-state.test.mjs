import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStateStore, TASK_LIMITS, TASK_TOOL, createTaskToolHandler } from '../lib/task-state.mjs';
import { renderTaskState, bindTaskStateEvents } from '../public/task-state-ui.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-task-state-test-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory, ...options }).init(), stores = [store];
  t.after(async () => { for (const instance of stores) await instance.close(); assert.match(path.basename(directory), /^relay-task-state-test-/); await rm(directory, { recursive: true, force: true }); });
  const state = await store.ensure({ taskId: 'task-one', runId: 'run-one', nodeId: 'agent', cwd, goal: 'Finish project ALPHA.' });
  return { store, stores, directory, cwd, state };
}
const actor = revision => ({ runId: 'run-one', nodeId: 'agent', expectedRevision: revision });
const plan = [{ id: 'inspect', title: 'Inspect the project', status: 'active' }, { id: 'build', title: 'Build the result', status: 'pending' }, { id: 'verify', title: 'Check and save the final file', status: 'pending' }];

test('durable plans have one current step, actual saved counts, revisions and run/node provenance', async t => {
  const { store, directory, cwd, stores, state } = await harness(t, { maxRevisions: 3 }); assert.equal(state.revision, 1); assert.equal(state.progress.total, 0);
  const planned = await store.setPlan('task-one', { steps: plan }, actor(1)); assert.equal(planned.progress.current.id, 'inspect'); assert.equal(planned.progress.done, 0); assert.equal(planned.progress.total, 3);
  const moved = await store.setStep('task-one', 'build', { status: 'active' }, actor(planned.revision)); assert.equal(moved.steps[0].status, 'pending'); assert.equal(moved.steps.filter(step => step.status === 'active').length, 1);
  const completed = await store.setStep('task-one', 'inspect', { status: 'done', note: 'Read the source files.' }, actor(moved.revision)); assert.equal(completed.progress.done, 1); assert.equal(completed.provenance.runId, 'run-one'); assert.equal(completed.provenance.nodeId, 'agent');
  assert.deepEqual((await store.history('task-one')).map(item => item.revision), [2, 3, 4]);
  const restored = await new TaskStateStore({ dataDir: directory }).init(); stores.push(restored); assert.deepEqual(await restored.get('task-one'), completed);
  const stable = await restored.ensure({ taskId: 'task-one', runId: 'followup', nodeId: 'other-agent', cwd, goal: 'Do not overwrite the original goal.' }); assert.equal(stable.goal, 'Finish project ALPHA.'); assert.equal(stable.revision, completed.revision);
  await assert.rejects(restored.ensure({ taskId: 'task-one', runId: 'followup', cwd: directory }), { code: 'TASK_WORKSPACE_MISMATCH' });
});

test('two store instances enforce compare-and-swap without losing concurrent edits', async t => {
  const { store, directory, stores } = await harness(t), other = await new TaskStateStore({ dataDir: directory }).init(); stores.push(other);
  const outcomes = await Promise.allSettled([store.setPlan('task-one', { steps: plan }, actor(1)), other.setPlan('task-one', { steps: [{ id: 'other', title: 'Another plan', status: 'active' }] }, actor(1))]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); const rejected = outcomes.find(item => item.status === 'rejected'); assert.equal(rejected.reason.code, 'TASK_STATE_CONFLICT');
  const latest = await other.get('task-one'); assert.equal(latest.revision, 2); assert.deepEqual(await store.get('task-one'), latest);
  await assert.rejects(store.setStep('task-one', 'inspect', { status: 'done' }, {}), { code: 'TASK_STATE_CONFLICT' });
});

test('checkpoint saves are bounded and interruption records facts without replacing an agent checkpoint', async t => {
  const { store } = await harness(t); let state = await store.setPlan('task-one', { steps: plan }, actor(1));
  state = await store.setStep('task-one', 'inspect', { status: 'done' }, actor(state.revision)); state = await store.setStep('task-one', 'build', { status: 'active' }, actor(state.revision));
  const checkpoint = { goal: 'Finish project ALPHA.', decisions: ['Use existing files.'], completed: ['Inspected the actual source.'], nextSteps: ['Finish implementation, then test it.'], openQuestions: ['Does the target app expose this control?'] };
  state = await store.checkpoint('task-one', checkpoint, actor(state.revision)); const before = structuredClone(state.checkpoint);
  const interrupted = await store.interrupt('task-one', { runId: 'run-one', nodeId: 'agent', status: 'cancelled', reason: 'User stopped this run.' });
  assert.deepEqual(interrupted.checkpoint, before); assert.equal(interrupted.interruption.provenance.source, 'runtime'); assert.equal(interrupted.interruption.status, 'cancelled');
  assert.deepEqual(interrupted.interruption.stepStates, [{ id: 'inspect', status: 'done' }, { id: 'build', status: 'active' }, { id: 'verify', status: 'pending' }]); assert.equal(interrupted.interruption.progress.done, 1); assert.equal(interrupted.interruption.progress.total, 3);
  assert.ok(!JSON.stringify(interrupted.interruption).includes('Inspected the actual source.'), 'runtime fallback must not manufacture a model summary');
  const resumed = await store.setStep('task-one', 'build', { status: 'done' }, { ...actor(interrupted.revision), runId: 'continued-run' }); assert.equal(resumed.interruption, null); assert.equal(resumed.provenance.runId, 'continued-run');
  const context = await store.getContext('task-one', { maxChars: 512 }); assert.equal(typeof context, 'string'); assert.ok(context.length <= 512); assert.match(context, /agent-reported/); assert.match(context, /relay_task/); assert.match(context, /shortened/);
  await assert.rejects(store.checkpoint('task-one', { ...checkpoint, decisions: Array(9).fill('too many') }, actor(resumed.revision)), { code: 'INVALID_TASK_STATE' });
});

test('stopping before any agent plan records an empty factual checkpoint and no invented progress', async t => {
  const { store } = await harness(t); const stopped = await store.interrupt('task-one', { runId: 'run-one', nodeId: 'agent', status: 'failed', reason: 'Provider disconnected.' });
  assert.equal(stopped.progress.total, 0); assert.equal(stopped.progress.done, 0); assert.equal(stopped.progress.current, null); assert.equal(stopped.checkpoint.kind, 'interruption'); assert.deepEqual(stopped.checkpoint.completed, []); assert.deepEqual(stopped.checkpoint.nextSteps, []); assert.deepEqual(stopped.interruption.stepStates, []);
});

test('artifact registration verifies actual bytes and opaque identifiers cannot read arbitrary files', async t => {
  const { store, cwd, directory } = await harness(t); const file = path.join(cwd, 'finished.txt'), bytes = Buffer.from('Finished project ALPHA.\nValidated.'); await writeFile(file, bytes);
  let state = await store.addArtifact('task-one', { path: 'finished.txt', title: 'Finished result' }, actor(1)); const artifact = state.artifacts[0];
  assert.equal(artifact.sha256, digest(bytes)); assert.equal(artifact.size, bytes.length); assert.equal(artifact.path, await import('node:fs/promises').then(fs => fs.realpath(file))); assert.equal(artifact.verification, 'filesystem-sha256'); assert.equal(artifact.provenance.nodeId, 'agent');
  const read = await store.readArtifact('task-one', artifact.id); assert.deepEqual(read.bytes, bytes); assert.equal(read.mimeType, 'text/plain; charset=utf-8'); assert.equal(read.fileName, 'finished.txt');
  const preview = await store.previewArtifact('task-one', artifact.id); assert.equal(preview.previewKind, 'text'); assert.equal(preview.text, bytes.toString()); assert.equal(preview.sha256, digest(bytes));
  await assert.rejects(store.readArtifact('task-one', '../finished.txt'), { code: 'INVALID_TASK_STATE' }); await assert.rejects(store.readArtifact('task-one', 'artifact_00000000-0000-0000-0000-000000000000'), { code: 'ARTIFACT_MISSING' });
  await writeFile(file, 'Changed after registration.'); await assert.rejects(store.readArtifact('task-one', artifact.id), { code: 'ARTIFACT_CHANGED' }); await assert.rejects(store.previewArtifact('task-one', artifact.id), { code: 'ARTIFACT_CHANGED' }); await assert.rejects(store.verifyArtifact('task-one', artifact.id), { code: 'ARTIFACT_CHANGED' });
  state = await store.addArtifact('task-one', { path: file }, actor(state.revision)); assert.equal(state.artifacts.length, 1); assert.equal(state.artifacts[0].id, artifact.id); assert.equal((await store.previewArtifact('task-one', artifact.id)).text, 'Changed after registration.');
  const before = state.revision; await assert.rejects(store.addArtifact('task-one', { path: 'missing.txt' }, actor(before))); assert.equal((await store.get('task-one')).revision, before);
  await assert.rejects(store.addArtifact('task-one', { path: directory }, actor(before)), { code: 'ARTIFACT_NOT_FILE' });
});

test('image signatures, text previews and binary downloads reflect files rather than claimed extensions', async t => {
  const { store, cwd } = await harness(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(cwd, 'pixel.png'), png); let state = await store.addArtifact('task-one', { path: 'pixel.png' }, actor(1)); const image = await store.previewArtifact('task-one', state.artifacts[0].id); assert.equal(image.previewKind, 'image'); assert.equal(image.mimeType, 'image/png'); assert.deepEqual(image.bytes, png);
  await writeFile(path.join(cwd, 'fake.png'), '<html><script>not an image</script></html>'); state = await store.addArtifact('task-one', { path: 'fake.png' }, actor(state.revision)); const fake = await store.previewArtifact('task-one', state.artifacts[1].id); assert.equal(fake.previewKind, 'text'); assert.equal(fake.mimeType, 'text/plain; charset=utf-8');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3])); state = await store.addArtifact('task-one', { path: 'binary.bin' }, actor(state.revision)); assert.equal((await store.previewArtifact('task-one', state.artifacts[2].id)).previewKind, 'download');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 4])); await assert.rejects(store.previewArtifact('task-one', state.artifacts[2].id), { code: 'ARTIFACT_CHANGED' });
  await assert.rejects(store.readArtifact('task-one', state.artifacts[0].id, { maxBytes: 10 }), { code: 'ARTIFACT_TOO_LARGE' });
});

test('cancellation and rejected bounds cannot create file claims or change saved revisions', async t => {
  const { store, cwd } = await harness(t); await writeFile(path.join(cwd, 'result.txt'), 'actual result'); const controller = new AbortController(); controller.abort();
  await assert.rejects(store.addArtifact('task-one', { path: 'result.txt' }, { ...actor(1), signal: controller.signal }), { name: 'AbortError' }); assert.equal((await store.get('task-one')).revision, 1);
  assert.throws(() => store.setPlan('task-one', { steps: [{ title: 'One', status: 'active' }, { title: 'Two', status: 'active' }] }, actor(1)), /one current/);
  assert.throws(() => store.setPlan('task-one', { steps: [{ title: 'Extra', doneWhen: 'x'.repeat(1001) }] }, actor(1)), /at most/);
  assert.throws(() => store.file('../outside'), { code: 'INVALID_TASK_STATE' }); assert.equal((await store.get('task-one')).artifacts.length, 0);
  await store.close(); await assert.rejects(store.setPlan('task-one', { steps: [] }, actor(1)), { code: 'TASK_STATE_CLOSED' });
});

test('bounded revisions recover a valid backup while corrupt history without backup is preserved', async t => {
  const { store } = await harness(t); await store.setPlan('task-one', { steps: plan }, actor(1)); await store.setStep('task-one', 'inspect', { status: 'done' }, actor(2));
  const file = store.file('task-one'); await writeFile(file, '{broken'); const recovered = await store.get('task-one'); assert.equal(recovered.revision, 2); assert.equal(await readFile(file, 'utf8'), '{broken', 'reading recovery must preserve the damaged source');
  await rm(file + '.bak'); await assert.rejects(store.get('task-one'), { code: 'TASK_STATE_DAMAGED' }); assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('missing task state with a damaged backup never silently recreates an empty task', async t => {
  const { store, cwd } = await harness(t), file = store.file('task-one'), damaged = '{"version":1,"taskId":"task-one","history":[]';
  await writeFile(file + '.bak', damaged); await rm(file);
  await assert.rejects(store.ensure({ taskId: 'task-one', runId: 'resumed-run', cwd, goal: 'Must not replace the original continuity.' }), { code: 'TASK_STATE_DAMAGED' });
  await assert.rejects(store.get('task-one'), { code: 'TASK_STATE_DAMAGED' });
  assert.equal(await readFile(file + '.bak', 'utf8'), damaged);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await rm(file + '.bak');
  const fresh = await store.ensure({ taskId: 'task-one', runId: 'new-run', cwd, goal: 'Only both missing files make a new task.' });
  assert.equal(fresh.revision, 1); assert.equal(fresh.goal, 'Only both missing files make a new task.');
});

test('bound relay_task writes use real actor provenance, latest CAS and emit committed snapshots', async t => {
  const { store } = await harness(t), events = [], handler = createTaskToolHandler({ store, taskId: 'task-one', runId: 'bound-run', nodeId: 'bound-agent', schemaVersion: 3, onEvent: event => events.push(event) }); assert.equal(TASK_TOOL.name, 'relay_task');
  const read = await handler({ name: 'relay_task', arguments: { action: 'read' } }); assert.equal(read.success, true); assert.equal(JSON.parse(read.contentItems[0].text).revision, 1); assert.equal(events.length, 0);
  const result = await handler({ name: 'relay_task', arguments: JSON.stringify({ action: 'plan', expectedRevision: 1, steps: plan }) }); assert.equal(result.success, true); assert.equal(events.length, 1); assert.equal(events[0].type, 'task.state'); assert.equal(events[0].state.provenance.runId, 'bound-run'); assert.equal(events[0].state.provenance.nodeId, 'bound-agent');
  const conflict = await handler({ name: 'relay_task', arguments: { action: 'step', expectedRevision: 1, stepId: 'inspect', status: 'done' } }); assert.equal(conflict.success, false); assert.equal(conflict.code, 'TASK_STATE_CONFLICT'); assert.equal(events.length, 1);
  const nonexistent = await handler({ name: 'relay_task', arguments: { action: 'artifact', expectedRevision: 2, path: 'not-created.txt' } }); assert.equal(nonexistent.success, false); assert.equal((await store.get('task-one')).artifacts.length, 0);
});

test('task UI shows one current step, accurate saved counts, escaped checkpoint text and actual file links', async t => {
  const { store, cwd } = await harness(t); await writeFile(path.join(cwd, 'result.txt'), 'actual'); let state = await store.setPlan('task-one', { steps: plan }, actor(1)); state = await store.setStep('task-one', 'inspect', { status: 'done' }, actor(state.revision)); state = await store.checkpoint('task-one', { goal: '<script>bad</script>', nextSteps: ['<img onerror=bad>'] }, actor(state.revision)); state = await store.addArtifact('task-one', { path: 'result.txt', title: '<b>Result</b>' }, actor(state.revision));
  const html = renderTaskState(state); assert.match(html, /1 of 3 steps complete/); assert.match(html, /Build the result/); assert.match(html, /Where we left off/); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img onerror')); assert.ok(!html.includes('<b>Result</b>')); assert.match(html, /data-task-artifact="artifact_/); assert.match(html, /\/content/); assert.match(html, /SHA-256/); assert.match(html, /<svg/);
  assert.equal(renderTaskState({ steps: [], artifacts: [], checkpoint: null }), ''); assert.ok(!renderTaskState(state, { artifactUrl: () => 'javascript:alert(1)' }).includes('javascript:'));
  let listener, removed = false, clicked, prevented = false; const target = { dataset: { taskId: 'task-one', taskArtifact: state.artifacts[0].id }, getAttribute: () => null, setAttribute() {}, removeAttribute() {} }, root = { contains: () => true, addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => { removed = true; } };
  const unbind = bindTaskStateEvents(root, { onArtifact: args => { clicked = args; } }); await listener({ target: { closest: () => target }, button: 0, preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); assert.deepEqual(clicked, { taskId: 'task-one', artifactId: state.artifacts[0].id }); unbind(); assert.equal(removed, true);
});
