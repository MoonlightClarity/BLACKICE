import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTaskPlan, runtimeTaskPlan, taskPlanProgress, TASK_PLAN_LIMITS } from '../lib/task-plan.mjs';
import { TaskStateStore, TASK_TOOL, TASK_TOOL_V9, TASK_TOOL_V6, TASK_TOOL_V5, TASK_TOOL_V4, TASK_TOOL_V3, PREVIOUS_TASK_TOOL, LEGACY_TASK_TOOL, TASK_INSTRUCTIONS, TASK_INSTRUCTIONS_V9, TASK_INSTRUCTIONS_V6, TASK_INSTRUCTIONS_V5, TASK_INSTRUCTIONS_V4, TASK_INSTRUCTIONS_V3, PREVIOUS_TASK_INSTRUCTIONS, LEGACY_TASK_INSTRUCTIONS, taskToolForVersion, taskInstructionsForVersion, createTaskToolHandler } from '../lib/task-state.mjs';
import { BUILTIN_METHODS, BUILTIN_TASK_TYPES, BUILTIN_STEP_TYPES } from '../lib/process-ontology.mjs';
import { MethodStore } from '../lib/methods.mjs';

const action = (id, options = {}) => ({ id, title: `Result ${id}`, kind: 'action', parentId: null, status: 'pending', doneWhen: `The ${id} result meets its stated check.`, ...options });
const group = (id, kind, options = {}) => ({ id, title: `Group ${id}`, kind, parentId: null, status: 'pending', ...options });
const actor = (revision, runId = 'run-one', nodeId = 'coordinator') => ({ expectedRevision: revision, runId, nodeId, schemaVersion: 4 });
const normalize = (steps, plan = { layout: 'sequence' }, options) => normalizeTaskPlan({ plan, steps }, options);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

async function fixture(t, { legacy = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-task-plan-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), stores = [store];
  const state = await store.ensure({ taskId: 'outline-task', runId: 'run-one', nodeId: 'runtime', cwd, goal: 'Make the agent work visible and useful.', defaultPlan: !legacy, planDetail: 'detailed' });
  t.after(async () => { await Promise.all(stores.map(item => item.close())); assert.match(path.basename(directory), /^blackice-task-plan-/); await rm(directory, { recursive: true, force: true }); });
  return { store, stores, state, directory, cwd };
}

const nested = () => [
  action('scope', { status: 'done', evidence: 'Read the requested behavior and existing component contracts.' }),
  group('build', 'parallel'),
  group('code', 'sequence', { parentId: 'build' }),
  action('write', { parentId: 'code', status: 'active' }),
  action('test', { parentId: 'code' }),
  action('docs', { parentId: 'build', status: 'active' }),
  action('integrate', { dependsOn: ['build'] })
];

test('the default scaffold saves only the requested goal and does not invent an agent plan or progress', async t => {
  const { store, state, cwd } = await fixture(t);
  assert.equal(state.planVersion, 1); assert.deepEqual(state.plan, { origin: 'runtime', layout: 'sequence', detail: 'detailed', taskType: 'general' });
  assert.deepEqual(state.steps, []); assert.equal(state.progress.source, 'runtime-plan-scaffold'); assert.equal(state.progress.total, 0); assert.equal(state.progress.done, 0); assert.equal(state.progress.skipped, 0); assert.equal(state.progress.current, null); assert.equal(state.progress.complete, false);
  const again = await store.ensure({ taskId: state.taskId, runId: 'next-run', cwd, goal: 'Must not erase the saved goal.', defaultPlan: true, planDetail: 'compact' });
  assert.deepEqual(again, state);
  const stopped = await store.interrupt(state.taskId, { runId: 'run-one', nodeId: 'runtime', status: 'failed', reason: 'Provider disconnected before planning.' });
  assert.deepEqual(stopped.checkpoint.completed, []); assert.deepEqual(stopped.checkpoint.nextSteps, []); assert.deepEqual(stopped.interruption.stepStates, []);
  await assert.rejects(store.setPlan(state.taskId, { steps: [] }, actor(stopped.revision)), /needs from 1/);
  assert.equal((await store.get(state.taskId)).revision, stopped.revision);
});

test('nested parallel work counts actions once, derives groups, and preserves its actual authored run after restart', async t => {
  const { store, stores, state, directory } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { plan: { layout: 'sequence', focusStepId: 'docs' }, steps: nested() }, actor(state.revision));
  assert.equal(saved.plan.origin, 'agent'); assert.equal(saved.plan.detail, 'detailed'); assert.deepEqual(saved.plan.authoredBy, { runId: 'run-one', nodeId: 'coordinator' });
  assert.equal(saved.progress.total, 5); assert.equal(saved.progress.done, 1); assert.equal(saved.progress.current.id, 'docs'); assert.deepEqual(saved.progress.active, ['write', 'docs']); assert.deepEqual(saved.progress.eligible, ['scope', 'write', 'test', 'docs', 'integrate']);
  assert.equal(saved.steps.find(item => item.id === 'build').status, 'active'); assert.equal(saved.steps.find(item => item.id === 'code').status, 'active');
  saved = await store.setStep(state.taskId, 'write', { status: 'done', evidence: 'Implemented the component and read the resulting diff.' }, actor(saved.revision, 'worker-run', 'code-worker'));
  assert.deepEqual(saved.plan.authoredBy, { runId: 'run-one', nodeId: 'coordinator' }, 'a worker status update cannot unlock the next run planning gate');
  assert.deepEqual(saved.progress.ready, ['test']); assert.deepEqual(saved.progress.active, ['docs']);
  saved = await store.setStep(state.taskId, 'test', { status: 'active' }, actor(saved.revision)); assert.deepEqual(saved.progress.active, ['test', 'docs']);
  const restored = await new TaskStateStore({ dataDir: directory }).init(); stores.push(restored); assert.deepEqual(await restored.get(state.taskId), saved);
  assert.equal(JSON.parse(await readFile(store.file(state.taskId), 'utf8')).version, 1, 'the durable file envelope is not destructively migrated');
  const context = await restored.getContext(state.taskId); assert.match(context, /Outline:/); assert.match(context, /"parentId":"build"/); assert.match(context, /agent-reported/);
});

test('choice paths require explicit selection and reasons; selection alone neither skips alternatives nor completes the group', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { steps: [group('route', 'choice'), action('repair', { parentId: 'route', condition: 'The existing implementation can be repaired.' }), action('replace', { parentId: 'route', condition: 'A supported replacement is necessary.' }), action('check')] }, actor(state.revision));
  assert.equal(saved.progress.total, 1); assert.deepEqual(saved.progress.awaitingChoice, ['repair', 'replace']); assert.equal(saved.progress.current.id, 'route'); assert.equal(saved.progress.complete, false);
  await assert.rejects(store.setStep(state.taskId, 'repair', { status: 'active' }, actor(saved.revision)), /Choose this branch/);
  saved = await store.setStep(state.taskId, 'route', { selectedChildId: 'repair' }, actor(saved.revision));
  assert.deepEqual(saved.progress.unselected, ['replace']); assert.equal(saved.steps.find(item => item.id === 'replace').status, 'pending');
  saved = await store.setStep(state.taskId, 'repair', { status: 'done', evidence: 'The original failing reproduction now passes after the repair.' }, actor(saved.revision));
  assert.equal(saved.steps.find(item => item.id === 'route').status, 'active'); assert.equal(saved.progress.complete, false); assert.equal(saved.progress.unresolvedBranches, 1);
  await assert.rejects(store.setStep(state.taskId, 'route', { status: 'done' }, actor(saved.revision)), /descendant is unfinished/);
  await assert.rejects(store.setStep(state.taskId, 'check', { status: 'active' }, actor(saved.revision)), { code: 'TASK_PLAN_PREREQUISITE' });
  await assert.rejects(store.setStep(state.taskId, 'replace', { status: 'skipped' }, actor(saved.revision)), /explicit reason/);
  saved = await store.setStep(state.taskId, 'replace', { status: 'skipped', skipReason: 'The repair passed; replacing the implementation is unnecessary.' }, actor(saved.revision));
  assert.equal(saved.steps.find(item => item.id === 'route').status, 'done'); assert.equal(saved.progress.skipped, 1); assert.equal(saved.progress.total, 2); assert.equal(saved.progress.done, 1); assert.deepEqual(saved.progress.ready, ['check']);
  saved = await store.setStep(state.taskId, 'check', { status: 'done', evidence: 'The integrated main user flow passed; optional external integrations were not run.' }, actor(saved.revision));
  assert.equal(saved.progress.complete, true); assert.equal(saved.progress.done, 2); assert.equal(saved.progress.total, 2); assert.equal(saved.progress.skipped, 1);
  const interrupted = await store.interrupt(state.taskId, { status: 'cancelled' }); assert.ok(!interrupted.checkpoint.nextSteps.includes('Result replace'));
});

test('a skipped subtree is distinct from completed work and an unresolved root choice has no fictitious 100 percent', () => {
  let saved = normalize([group('unused', 'sequence'), action('unused-one', { parentId: 'unused', status: 'skipped', skipReason: 'Input is absent and this optional analysis is unnecessary.' }), action('required')]);
  assert.equal(saved.steps[0].status, 'skipped'); let progress = taskPlanProgress(saved); assert.equal(progress.skipped, 1); assert.equal(progress.done, 0); assert.equal(progress.total, 1); assert.deepEqual(progress.ready, ['required']);
  saved = normalize([action('first'), action('second')], { layout: 'choice' }); progress = taskPlanProgress(saved);
  assert.equal(progress.total, 0); assert.equal(progress.done, 0); assert.equal(progress.complete, false); assert.equal(progress.unresolvedBranches, 2);
  saved = normalize([action('first', { status: 'done', evidence: 'This branch produced the requested result.' }), action('second')], { layout: 'choice', selectedChildId: 'first' }); progress = taskPlanProgress(saved);
  assert.equal(progress.total, 1); assert.equal(progress.done, 1); assert.equal(progress.complete, false); assert.equal(progress.unresolvedBranches, 1);
});

test('hierarchy and prerequisite validation catches dangling references and cycles crossing group boundaries', () => {
  const invalid = [
    [action('one', { parentId: 'missing' })],
    [action('one'), action('one')],
    [action('one'), action('child', { parentId: 'one' })],
    [group('a', 'sequence', { parentId: 'b' }), group('b', 'sequence', { parentId: 'a' }), action('leaf', { parentId: 'b' })],
    [group('a', 'parallel', { dependsOn: ['leaf'] }), action('leaf', { parentId: 'a' })],
    [action('a', { dependsOn: ['b'] }), action('b')],
    [action('a', { dependsOn: ['missing'] })],
    [group('a', 'choice', { selectedChildId: 'nested' }), group('branch', 'sequence', { parentId: 'a' }), action('nested', { parentId: 'branch' }), action('other', { parentId: 'a' })],
    [group('empty', 'parallel'), action('a')],
    [group('done-parent', 'parallel', { status: 'done' }), action('unfinished', { parentId: 'done-parent' })]
  ];
  for (const steps of invalid) assert.throws(() => normalize(steps), { code: 'INVALID_TASK_PLAN' });
  assert.throws(() => normalize([action('a')], { layout: 'choice' }), /at least two/);
});

test('ancestor prerequisites name the conflicting steps and explain how to repair the cycle', () => {
  for (const [steps, childId, ancestorId] of [
    [[group('work', 'sequence'), action('verify', { parentId: 'work', dependsOn: ['work'] })], 'verify', 'work'],
    [[group('outer', 'parallel'), group('inner', 'sequence', { parentId: 'outer' }), action('leaf', { parentId: 'inner', dependsOn: ['outer'] })], 'leaf', 'outer']
  ]) {
    assert.throws(() => normalize(steps, { layout: 'parallel' }), error => {
      assert.equal(error.code, 'INVALID_TASK_PLAN');
      assert.match(error.message, new RegExp(`"${childId}".*parent or ancestor "${ancestorId}"`));
      assert.match(error.message, /Remove that prerequisite/);
      assert.match(error.message, /completes only after its children/);
      return true;
    });
  }
});

test('sequence siblings remain valid with implicit order or an explicit earlier-sibling prerequisite', () => {
  for (const dependsOn of [[], ['first']]) {
    const saved = normalize([group('work', 'sequence'), action('first', { parentId: 'work', status: 'done', evidence: 'The first result was checked.' }), action('second', { parentId: 'work', status: 'active', dependsOn })], { layout: 'parallel' });
    assert.deepEqual(taskPlanProgress(saved).active, ['second']);
  }
  assert.throws(() => normalize([action('a', { dependsOn: ['b'] }), action('b', { dependsOn: ['a'] })], { layout: 'parallel' }), error => error.code === 'INVALID_TASK_PLAN' && error.message === 'Plan dependencies and sequence order contain a cycle.');
});

test('multiple active actions require separate parallel paths and unfinished prerequisites remain enforced', () => {
  assert.throws(() => normalize([action('a', { status: 'active' }), action('b', { status: 'active' })]), { code: 'TASK_PLAN_PREREQUISITE' });
  assert.throws(() => normalize([action('a'), action('b', { status: 'done', evidence: 'Claimed before the required input exists.' })]), { code: 'TASK_PLAN_PREREQUISITE' });
  assert.throws(() => normalize([action('a', { status: 'skipped', skipReason: 'The source was not available.' }), action('b', { dependsOn: ['a'], status: 'active' })]), { code: 'TASK_PLAN_PREREQUISITE' });
  const parallel = normalize([action('a', { status: 'active' }), action('b', { status: 'active' })], { layout: 'parallel' }); assert.deepEqual(taskPlanProgress(parallel).active, ['a', 'b']);
  assert.throws(() => normalize([group('serial', 'sequence'), action('a', { parentId: 'serial', status: 'active' }), action('b', { parentId: 'serial', status: 'active' })], { layout: 'parallel' }), { code: 'TASK_PLAN_PREREQUISITE' });
});

test('new actions need observable criteria and done evidence; changed work cannot reuse stale evidence', async t => {
  const { store, state } = await fixture(t);
  await assert.rejects(store.setPlan(state.taskId, { steps: [{ id: 'one', title: 'Answer the question' }] }, actor(state.revision)), /doneWhen criterion/);
  await assert.rejects(store.setPlan(state.taskId, { steps: [action('one', { status: 'done' })] }, actor(state.revision)), /actual evidence/);
  let saved = await store.setPlan(state.taskId, { steps: [action('one', { status: 'done', evidence: 'The original check passed.' })] }, actor(state.revision)); const doneRevision = saved.revision;
  await assert.rejects(store.setStep(state.taskId, 'one', { status: 'done', doneWhen: 'The expanded result passes another check.' }, actor(saved.revision)), /actual evidence/);
  assert.equal((await store.get(state.taskId)).revision, doneRevision);
  saved = await store.setStep(state.taskId, 'one', { status: 'active' }, actor(saved.revision)); assert.equal(saved.steps[0].evidence, undefined);
  saved = await store.setStep(state.taskId, 'one', { status: 'done', evidence: 'The updated check passed with the expanded result.' }, actor(saved.revision));
  assert.equal(saved.progress.done, 1); assert.equal((await store.history(state.taskId)).find(item => item.revision === doneRevision).steps[0].evidence, 'The original check passed.');
});

test('legacy progress migrates without manufacturing criteria or evidence and cannot grant the same exemption to new work', async t => {
  const { store, state } = await fixture(t, { legacy: true });
  let saved = await store.setPlan(state.taskId, { steps: [{ id: 'old', title: 'Previously completed work', status: 'done' }] }, { expectedRevision: state.revision, runId: 'old-run' });
  saved = await store.setPlan(state.taskId, { plan: { layout: 'sequence' }, steps: [...saved.steps, action('followup')] }, actor(saved.revision, 'followup'));
  assert.equal(saved.planVersion, 1); assert.deepEqual(saved.plan.legacyCompletedIds, ['old']); assert.deepEqual(saved.plan.legacyCriteriaIds, ['old']); assert.equal(saved.steps[0].evidence, undefined); assert.equal(saved.steps[0].doneWhen, undefined); assert.equal(saved.progress.done, 1);
  saved = await store.setStep(state.taskId, 'followup', { status: 'active' }, actor(saved.revision)); assert.deepEqual(saved.plan.legacyCompletedIds, ['old']);
  await assert.rejects(store.setPlan(state.taskId, { steps: [...saved.steps, { id: 'new', title: 'Not historical', status: 'done' }] }, actor(saved.revision)), /doneWhen criterion/);
  await assert.rejects(store.setStep(state.taskId, 'old', { title: 'Different work', status: 'done', doneWhen: 'A new result is checked.' }, actor(saved.revision)), /actual evidence/);
  assert.equal((await store.get(state.taskId)).steps[0].title, 'Previously completed work');
});

test('CAS protects parallel authors and continuation plan affirmation changes ownership without rewriting completed evidence', async t => {
  const { store, stores, state, directory } = await fixture(t), other = await new TaskStateStore({ dataDir: directory }).init(); stores.push(other);
  let saved = await store.setPlan(state.taskId, { plan: { layout: 'parallel' }, steps: [action('a'), action('b')] }, actor(state.revision));
  const changes = [['a', { status: 'done', evidence: 'Worker A completed and checked its actual result.' }], ['b', { status: 'blocked', blockedReason: 'The input is unavailable.' }]];
  const attempts = await Promise.allSettled([store.setStep(state.taskId, ...changes[0], actor(saved.revision, 'worker-a')), other.setStep(state.taskId, ...changes[1], actor(saved.revision, 'worker-b'))]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1); const lost = attempts.findIndex(item => item.status === 'rejected'); assert.equal(attempts[lost].reason.code, 'TASK_STATE_CONFLICT');
  saved = await other.get(state.taskId); saved = await other.setStep(state.taskId, ...changes[lost], actor(saved.revision));
  const completedEvidence = saved.steps.find(item => item.id === 'a').evidence;
  saved = await store.setPlan(state.taskId, { steps: saved.steps }, actor(saved.revision, 'continuation-run'));
  assert.deepEqual(saved.plan.authoredBy, { runId: 'continuation-run', nodeId: 'coordinator' }); assert.equal(saved.steps.find(item => item.id === 'a').evidence, completedEvidence); assert.equal(saved.steps.find(item => item.id === 'b').status, 'blocked');
});

test('artifact links remain task scoped and actual files retain their independent byte-verification boundary', async t => {
  const { store, state, cwd } = await fixture(t); await writeFile(path.join(cwd, 'result.txt'), 'Actual checked output.');
  let saved = await store.addArtifact(state.taskId, { path: 'result.txt' }, actor(state.revision)); const artifact = saved.artifacts[0];
  saved = await store.setPlan(state.taskId, { steps: [action('deliver', { status: 'done', evidence: 'Read the resulting text and checked it against the requested content.', artifactIds: [artifact.id] })] }, actor(saved.revision));
  assert.deepEqual(saved.steps[0].artifactIds, [artifact.id]); assert.equal(saved.artifacts[0].verification, 'filesystem-sha256'); assert.equal(saved.steps[0].verification, undefined);
  await assert.rejects(store.setStep(state.taskId, 'deliver', { status: 'done', artifactIds: ['artifact_00000000-0000-0000-0000-000000000000'] }, actor(saved.revision)), { code: 'TASK_PLAN_ARTIFACT_MISSING' });
  assert.equal((await store.get(state.taskId)).revision, saved.revision);
  await writeFile(path.join(cwd, 'result.txt'), 'Changed after the agent report.'); await assert.rejects(store.previewArtifact(state.taskId, artifact.id), { code: 'ARTIFACT_CHANGED' });
});

test('plan revisions retain external recovery guards and never turn an uncertain side effect into a retry permit', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.externalAction(state.taskId, { receiptId: 'publication', operation: 'prepare', destination: 'https://example.test/account', content: 'The authorized exact final content.' }, actor(state.revision));
  saved = await store.setPlan(state.taskId, { steps: [action('publish')] }, actor(saved.revision));
  saved = await store.externalAction(state.taskId, { receiptId: 'publication', operation: 'attempt' }, actor(saved.revision));
  await writeFile(store.file(state.taskId), '{damaged'); const recovered = await store.get(state.taskId);
  assert.equal(recovered.externalActions[0].status, 'uncertain'); assert.equal(recovered.externalRecovery.required, true); assert.equal(recovered.plan.origin, 'agent');
  saved = await store.setPlan(state.taskId, { steps: recovered.steps }, actor(recovered.revision, 'recovered-run'));
  assert.equal(saved.externalActions[0].status, 'uncertain'); assert.equal(saved.externalRecovery.required, true);
  await assert.rejects(store.externalAction(state.taskId, { receiptId: 'publication', operation: 'attempt' }, actor(saved.revision)), { code: 'EXTERNAL_ACTION_RECONCILE' });
  assert.match(await store.getContext(state.taskId, { maxChars: 512 }), /Inspect the destination before any retry/);
});

test('task tool versions 1 through 6 retain their exact native catalogs and instructions', () => {
  const expected = [
    [LEGACY_TASK_TOOL, LEGACY_TASK_INSTRUCTIONS, '7d35a411c732a452b8906d442e7faa93bbf0885a8e819402af8a55ecf0c86813', 'a7461d87b42633ca51a8a580fc63da6bc18062f3df90805e08a16b35b37bb396'],
    [PREVIOUS_TASK_TOOL, PREVIOUS_TASK_INSTRUCTIONS, '85ab060ad0ea909aa1515c43c2e1be1de59c6b4c03a2233c8a9e84167b2ae62a', '020f26e500ee6f5cbe341f0a3833db2287bc79abb84d92b4830f0134c1ab19b9'],
    [TASK_TOOL_V3, TASK_INSTRUCTIONS_V3, '01f7df1da9f1ed0785c8009ebda7c39aec1d7d7fc97b6d971512a7e9254e7be6', 'da77363a37dd7ecff9440e5fdb7bd19666187b24ae59c5a6510941d3adf22b60'],
    [TASK_TOOL_V4, TASK_INSTRUCTIONS_V4, '6fed41dec09160afd7b66a680808aed672c53677c8857a70e7113712d3fc68d0', '17676fbf975245ee700e175a6f905b2334b59df03f1618fbd75c39a41feb1bfb'],
    [TASK_TOOL_V5, TASK_INSTRUCTIONS_V5, '7ef57b1bf5e36f753a400ce262af91a5044af294c6552c9cbba7fb26a78592ee', '66de27e4b19f66cbf2ee488a4dcc38b76c02b56d95b13b3897f9434ef86a87b2'],
    [TASK_TOOL_V6, TASK_INSTRUCTIONS_V6, 'a690b71995ce9e64e720e2b6c476592e75b2f342e62def14e885e6de03ed46d6', '6c56b3ff76f9ea9822c66d6a3b1254083ca86c1ef9f944fd256cea8e60e625d6']
  ];
  expected.forEach(([tool, instructions, toolHash, instructionHash], index) => { assert.equal(taskToolForVersion(index + 1), tool); assert.equal(taskInstructionsForVersion(index + 1), instructions); assert.equal(digest(tool), toolHash); assert.equal(digest(instructions), instructionHash); });
  assert.equal(taskToolForVersion(9), TASK_TOOL_V9); assert.equal(taskInstructionsForVersion(9), TASK_INSTRUCTIONS_V9); assert.equal(taskToolForVersion(10), TASK_TOOL); assert.equal(taskInstructionsForVersion(10), TASK_INSTRUCTIONS); assert.ok(TASK_TOOL.inputSchema.properties.action.enum.includes('describe')); assert.ok(TASK_TOOL.inputSchema.properties.steps.items.properties.kind);
  assert.equal(taskToolForVersion(8).inputSchema.properties.steps.items.properties.operation, undefined);
  assert.throws(() => taskToolForVersion(11), { code: 'TASK_SCHEMA_UNSUPPORTED' }); assert.match(TASK_INSTRUCTIONS, /normal way to work on every request/); assert.doesNotMatch(TASK_INSTRUCTIONS, /need no saved plan/);
});

test('legacy handlers reject new actions and schema fields instead of silently executing undeclared capabilities', async t => {
  const { store, state } = await fixture(t, { legacy: true });
  for (const schemaVersion of [1, 2, 3]) {
    const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'legacy-run', nodeId: 'agent', schemaVersion });
    for (const args of [{ action: 'describe' }, { action: 'draft_method' }, { action: 'save_method', expectedRevision: 1 }, { action: 'plan', expectedRevision: 1, steps: [action('a')] }, { action: 'plan', expectedRevision: 1, plan: { layout: 'parallel' }, steps: [{ title: 'A legacy-looking action' }] }]) {
      const result = await handler({ name: 'relay_task', arguments: args }); assert.equal(result.success, false); assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED');
    }
    if (schemaVersion < 3) { const result = await handler({ name: 'relay_task', arguments: { action: 'external' } }); assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED'); }
  }
  assert.equal((await store.get(state.taskId)).revision, 1);
});

test('an old native catalog cannot flatten a subsequently upgraded outline or invent missing completion evidence', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { steps: [group('work', 'sequence'), action('a', { parentId: 'work', status: 'active' }), action('b', { parentId: 'work' })] }, actor(state.revision));
  const preserved = structuredClone(saved);
  for (const schemaVersion of [1, 2, 3]) {
    const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'old-native-run', nodeId: 'old-agent', schemaVersion });
    let result = await handler({ name: 'relay_task', arguments: { action: 'plan', expectedRevision: saved.revision, steps: [{ id: 'flat', title: 'A replacement that would erase hierarchy', status: 'active' }] } });
    assert.equal(result.success, false); assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED');
    result = await handler({ name: 'relay_task', arguments: { action: 'step', expectedRevision: saved.revision, stepId: 'work', status: 'done' } }); assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED');
    if (schemaVersion === 1) { result = await handler({ name: 'relay_task', arguments: { action: 'step', expectedRevision: saved.revision, stepId: 'a', status: 'done' } }); assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED'); }
  }
  assert.deepEqual(await store.get(state.taskId), preserved);
  const previous = createTaskToolHandler({ store, taskId: state.taskId, runId: 'old-native-run', nodeId: 'old-agent', schemaVersion: 3 });
  const result = await previous({ name: 'relay_task', arguments: { action: 'step', expectedRevision: saved.revision, stepId: 'a', status: 'done', evidence: 'Checked the actual completed action using its recorded criterion.' } });
  assert.equal(result.success, true, result.contentItems[0].text); saved = await store.get(state.taskId); assert.equal(saved.steps.find(item => item.id === 'a').parentId, 'work'); assert.deepEqual(saved.plan.authoredBy, preserved.plan.authoredBy);
});

test('v5 describe retains its saved method catalog and plan writes bind real method revision, vocabulary and actor', async t => {
  const { store, state } = await fixture(t), events = [], handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'actual-run', nodeId: 'actual-agent', schemaVersion: 5, onEvent: event => events.push(event) });
  const call = args => handler({ name: 'relay_task', arguments: args });
  let result = await call({ action: 'describe' }); assert.equal(result.success, true); const catalog = JSON.parse(result.contentItems[0].text);
  assert.equal(catalog.methods.length, 20); assert.equal(catalog.totalMethods, BUILTIN_METHODS.length); assert.ok(catalog.ontology.taskTypes.some(item => item.id === 'software')); assert.ok(!catalog.methods[0].steps); assert.ok(JSON.stringify(catalog).length < 128000);
  const method = BUILTIN_METHODS.find(item => item.id === 'software-feature');
  result = await call({ action: 'describe', methodId: method.id }); const definition = JSON.parse(result.contentItems[0].text); assert.deepEqual(definition.method, method); assert.equal(definition.pagination.complete, true); assert.equal(events.length, 0); assert.equal((await store.get(state.taskId)).revision, 1);
  result = await call({ action: 'plan', expectedRevision: 1, plan: { taskType: 'software', method: { id: method.id, revision: 1, name: 'A forged name', origin: 'verified' }, origin: 'runtime', authoredBy: { runId: 'spoof' } }, steps: [action('one', { stepType: 'create' })] }); assert.equal(result.success, true, result.contentItems[0].text);
  const saved = JSON.parse(result.contentItems[0].text); assert.deepEqual(saved.plan.method, { id: method.id, revision: 1, name: method.name, origin: 'builtin' }); assert.deepEqual(saved.plan.authoredBy, { runId: 'actual-run', nodeId: 'actual-agent' }); assert.equal(saved.plan.origin, 'agent'); assert.equal(events.length, 1); assert.deepEqual(events[0].state, await store.get(state.taskId));
  for (const invalid of [{ plan: { method: { id: method.id, revision: 99 } }, code: 'TASK_METHOD_CONFLICT' }, { plan: { taskType: 'invented' }, code: 'TASK_TYPE_MISSING' }, { steps: [action('one', { stepType: 'invented' })], code: 'TASK_TYPE_MISSING' }]) {
    result = await call({ action: 'plan', expectedRevision: saved.revision, steps: [action('one')], ...invalid }); assert.equal(result.success, false); assert.equal(result.code, invalid.code);
  }
  assert.equal((await store.get(state.taskId)).revision, saved.revision);
});

test('custom vocabulary works in ordinary task plans and large exact method pages cannot mix revisions', async t => {
  const { store, state } = await fixture(t);
  let method = { id: '_custom-method', revision: 3, origin: 'custom', verification: 'unverified', name: 'A detailed custom method', description: 'Saved author guidance.', taskType: '_custom-task', inputs: [], steps: Array.from({ length: 20 }, (_, index) => ({ id: `part-${index}`, title: `Part ${index}`, type: '_custom-step', instructions: 'Relevant instructions. '.repeat(500), inputs: [], result: 'The documented part.', checks: ['The result exists and meets the requirement.'] })) };
  const methods = { status: () => ({ healthy: true, custom: 1 }), ontology: () => ({ taskTypes: [...BUILTIN_TASK_TYPES, { id: '_custom-task', kind: 'task', name: 'Custom work', description: '', origin: 'custom', revision: 1 }], stepTypes: [...BUILTIN_STEP_TYPES, { id: '_custom-step', kind: 'step', name: 'Custom step', description: '', origin: 'custom', revision: 1 }] }), list: () => [...BUILTIN_METHODS, method], get: id => id === method.id ? structuredClone(method) : structuredClone(BUILTIN_METHODS.find(item => item.id === id)) };
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-one', nodeId: 'coordinator', methods });
  const call = args => handler({ name: 'relay_task', arguments: args });
  let result = await call({ action: 'describe', methodId: method.id }), page = JSON.parse(result.contentItems[0].text);
  assert.equal(result.success, true); assert.ok(page.pagination.nextStepOffset > 0); assert.equal(page.pagination.complete, false); assert.ok(result.contentItems[0].text.length <= 128000); assert.deepEqual(page.method.steps, method.steps.slice(0, page.pagination.returnedSteps));
  const first = page.pagination.returnedSteps;
  result = await call({ action: 'describe', methodId: method.id, methodStepOffset: first }); assert.equal(result.code, 'TASK_METHOD_CONFLICT');
  result = await call({ action: 'describe', methodId: method.id, methodStepOffset: first, methodRevision: 3 }); page = JSON.parse(result.contentItems[0].text); assert.deepEqual(page.method.steps, method.steps.slice(first, first + page.pagination.returnedSteps));
  method = { ...method, revision: 4 }; result = await call({ action: 'describe', methodId: method.id, methodStepOffset: first, methodRevision: 3 }); assert.equal(result.code, 'TASK_METHOD_CONFLICT');
  result = await call({ action: 'plan', expectedRevision: state.revision, plan: { taskType: '_custom-task', method: { id: method.id, revision: 4 } }, steps: [action('custom', { stepType: '_custom-step' })] });
  assert.equal(result.success, true, result.contentItems[0].text); assert.equal(JSON.parse(result.contentItems[0].text).plan.method.revision, 4);
});

test('a changed request detail preference is persisted with the next accepted plan without rewriting work during read or ensure', async t => {
  const { store, state } = await fixture(t);
  const saved = await store.setPlan(state.taskId, { plan: { layout: 'parallel', detail: 'detailed' }, steps: [action('a')] }, actor(state.revision));
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'followup-run', nodeId: 'coordinator', planDetail: 'compact' });
  const read = await handler({ name: 'relay_task', arguments: { action: 'read' } }); assert.equal(JSON.parse(read.contentItems[0].text).plan.detail, 'detailed'); assert.equal((await store.get(state.taskId)).revision, saved.revision);
  const result = await handler({ name: 'relay_task', arguments: { action: 'plan', expectedRevision: saved.revision, plan: { detail: 'detailed' }, steps: saved.steps } });
  assert.equal(result.success, true, result.contentItems[0].text); const next = JSON.parse(result.contentItems[0].text);
  assert.equal(next.plan.detail, 'compact'); assert.equal(next.plan.layout, 'parallel'); assert.deepEqual(next.steps, saved.steps); assert.equal(next.plan.authoredBy.runId, 'followup-run');
});

test('task-scoped methods preserve a branching blueprint and recover the original save after both the task and method advance', async t => {
  const { store, stores, state, directory } = await fixture(t);
  const methods = await new MethodStore({ dataDir: directory, projects: { definition() { assert.fail('Saving a task method cannot create project work.'); }, create() { assert.fail('Saving a task method cannot execute it.'); } } }).init(); stores.push(methods);
  const source = await store.setPlan(state.taskId, { steps: [group('route', 'choice', { selectedChildId: 'repair' }), action('repair', { parentId: 'route', status: 'done', condition: 'A local repair is sufficient.', evidence: 'The selected repair passed its actual check.', note: 'Task-specific discussion.' }), action('replace', { parentId: 'route', status: 'skipped', condition: 'The repair cannot meet the request.', skipReason: 'The selected repair was sufficient.' }), action('review')] }, actor(state.revision));
  const events = [], handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-one', nodeId: 'coordinator', methods, onEvent: event => events.push(event) });
  const call = args => handler({ name: 'relay_task', arguments: args });
  let result = await call({ action: 'draft_method', methodName: 'Repair with an explicit alternative', methodDescription: 'Choose a repair or replacement, then check the result.' });
  assert.equal(result.success, true, result.contentItems[0].text); const draft = JSON.parse(result.contentItems[0].text);
  assert.equal(draft.taskId, undefined); assert.deepEqual(draft.sourceTask, { taskId: state.taskId, revision: source.revision }); assert.equal(draft.draft.outline.steps[0].kind, 'choice');
  for (const node of draft.draft.outline.steps) for (const key of ['status', 'evidence', 'note', 'skipReason', 'selectedChildId', 'artifactIds', 'authoredBy']) assert.equal(Object.hasOwn(node, key), false);
  assert.equal(draft.draft.outline.steps.find(node => node.id === 'repair').condition, 'A local repair is sufficient.');
  assert.equal((await store.get(state.taskId)).revision, source.revision); assert.equal(events.length, 0);
  const request = { action: 'save_method', expectedRevision: source.revision, methodName: draft.draft.name, methodDescription: draft.draft.description };
  result = await call(request); assert.equal(result.success, true, result.contentItems[0].text); const first = JSON.parse(result.contentItems[0].text);
  assert.equal(first.created, true); assert.equal(first.saved, true); assert.equal(first.taskId, undefined); assert.equal(first.method.verification, 'unverified'); assert.deepEqual(methods.get(first.method.id).outline, draft.draft.outline);
  assert.equal(first.sourceTask.taskId, state.taskId); assert.equal(first.sourceTask.revision, source.revision); assert.equal((await store.get(state.taskId)).revision, source.revision); assert.equal(events.length, 0);
  const current = await store.setStep(state.taskId, 'review', { status: 'done', evidence: 'Inspected the final result and compared it with the request.' }, actor(source.revision));
  const edited = await methods.update(first.method.id, { expectedRevision: first.method.revision, name: 'An edited reusable approach' });
  await methods.close(); const restored = await new MethodStore({ dataDir: directory, projects: methods.projects }).init(); stores.push(restored);
  const retry = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-two', nodeId: 'coordinator', methods: restored, onEvent: event => events.push(event) });
  result = await retry({ name: 'relay_task', arguments: request }); assert.equal(result.success, true, result.contentItems[0].text); const recovered = JSON.parse(result.contentItems[0].text);
  assert.equal(recovered.created, false); assert.equal(recovered.method.id, first.method.id); assert.equal(recovered.method.revision, edited.revision); assert.equal(recovered.method.name, edited.name); assert.deepEqual(recovered.sourceTask, first.sourceTask); assert.equal(restored.status().custom, 1);
  result = await retry({ name: 'relay_task', arguments: { ...request, methodName: 'A different save is not a retry' } }); assert.equal(result.success, false); assert.equal(result.code, 'TASK_STATE_CONFLICT');
  result = await retry({ name: 'relay_task', arguments: { action: 'describe', methodId: edited.id, methodRevision: edited.revision } }); const described = JSON.parse(result.contentItems[0].text);
  assert.deepEqual(described.method.outline, draft.draft.outline); assert.equal(described.pagination.outlineComplete, true); assert.equal((await store.get(state.taskId)).revision, current.revision); assert.equal(events.length, 0);
});

test('reusable method drafts preserve honest legacy migration and saving fails clearly without a writable library', async t => {
  const { store, state } = await fixture(t, { legacy: true });
  const legacy = await store.setPlan(state.taskId, { steps: [{ id: 'legacy-answer', title: 'An answer produced before criteria were recorded', status: 'done' }] }, { expectedRevision: state.revision, schemaVersion: 3 });
  const migrated = await store.setPlan(state.taskId, { steps: legacy.steps }, actor(legacy.revision));
  assert.deepEqual(migrated.plan.legacyCriteriaIds, ['legacy-answer']); assert.equal(migrated.steps[0].doneWhen, undefined);
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-one', nodeId: 'coordinator' }), call = args => handler({ name: 'relay_task', arguments: args });
  let result = await call({ action: 'draft_method', expectedRevision: migrated.revision }); assert.equal(result.success, true, result.contentItems[0].text);
  const draft = JSON.parse(result.contentItems[0].text); assert.match(draft.draft.outline.steps[0].doneWhen, /^Draft criterion:/); assert.equal(draft.draft.outline.steps[0].evidence, undefined); assert.deepEqual(await store.get(state.taskId), migrated);
  for (const [expectedRevision, code, status] of [[undefined, 'TASK_STATE_REVISION_REQUIRED', 400], [0, 'TASK_STATE_REVISION_INVALID', 400], [migrated.revision - 1, 'TASK_METHOD_UNAVAILABLE', 503]]) { result = await call({ action: 'save_method', expectedRevision }); assert.equal(result.success, false); assert.equal(result.code, code); assert.equal(result.status, status); }
  result = await call({ action: 'save_method', expectedRevision: migrated.revision }); assert.equal(result.code, 'TASK_METHOD_UNAVAILABLE'); assert.match(result.contentItems[0].text, /outline is still saved/);
  result = await call({ action: 'draft_method', expectedRevision: legacy.revision }); assert.equal(result.code, 'TASK_STATE_CONFLICT');
  assert.deepEqual(await store.get(state.taskId), migrated);
});

test('bounded plans reject enormous arrays before traversal, overdeep trees and excessive serialized details', () => {
  let visited = 0;
  const huge = new Proxy([], { get(target, key, receiver) { if (key === 'length') return 1_000_000; if (/^\d+$/.test(String(key))) { visited++; throw Error('Must reject the declared size before reading items.'); } return Reflect.get(target, key, receiver); } });
  assert.throws(() => normalizeTaskPlan({ steps: huge }), { code: 'TASK_PLAN_LIMIT' }); assert.equal(visited, 0);
  const deep = Array.from({ length: TASK_PLAN_LIMITS.depth }, (_, index) => group(`g${index}`, 'sequence', { parentId: index ? `g${index - 1}` : null })); deep.push(action('leaf', { parentId: deep.at(-1).id }));
  assert.throws(() => normalize(deep), /nested plan levels/);
  assert.throws(() => normalize(Array.from({ length: 40 }, (_, index) => action(`a${index}`, { evidence: 'x'.repeat(2000), doneWhen: 'x'.repeat(1000), note: 'x'.repeat(700) })), { layout: 'parallel' }), { code: 'TASK_PLAN_LIMIT' });
  assert.throws(() => runtimeTaskPlan('verbose'), /compact, balanced or detailed/);
});

test('stopping a large valid outline preserves its full state without overflowing the recovery reserve with duplicate node IDs', async t => {
  const { store, state } = await fixture(t);
  const steps = Array.from({ length: 100 }, (_, index) => action(`action-${index}-` + 'x'.repeat(105), { title: `Unit ${index}`, doneWhen: 'The expected result has been produced and actually checked.' }));
  const saved = await store.setPlan(state.taskId, { plan: { layout: 'parallel' }, steps }, actor(state.revision));
  const stored = JSON.parse(await readFile(store.file(state.taskId), 'utf8')).history.at(-1);
  assert.ok(JSON.stringify(stored).length > 52000); assert.ok(JSON.stringify(stored).length < 56000);
  assert.equal(Object.keys(saved.availableWork.byId).length, 100, 'Readiness is a derived view, not duplicated into saved continuity.');
  assert.ok(JSON.stringify(stored).length + JSON.stringify(saved.steps.map(({ id, status }) => ({ id, status }))).length > 64000, 'duplicating the hierarchy in an interruption would exceed the runtime budget');
  const stopped = await store.interrupt(state.taskId, { runId: 'run-one', nodeId: 'coordinator', status: 'cancelled', reason: 'The user stopped the task.' });
  assert.deepEqual(stopped.steps, saved.steps); assert.equal(stopped.interruption.planRevision, saved.revision); assert.equal(stopped.interruption.stepStatesSource, 'outline-in-this-record'); assert.equal(stopped.interruption.progress.total, 100); assert.equal(stopped.interruption.progress.done, 0); assert.ok(JSON.stringify(JSON.parse(await readFile(store.file(state.taskId), 'utf8')).history.at(-1)).length < 64000);
  assert.deepEqual((await store.history(state.taskId)).find(item => item.revision === saved.revision).steps, saved.steps);
});
