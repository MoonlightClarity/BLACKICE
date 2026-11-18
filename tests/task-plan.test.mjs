import { TASK_SCHEMA_VERSION as CURRENT_TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
// Historical schema-13 regression; canonical schema-14 behavior has separate production-engine acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTaskPlan, runtimeTaskPlan, taskPlanProgress, TASK_PLAN_LIMITS } from '../lib/task-plan.mjs';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { BUILTIN_METHODS, BUILTIN_TASK_TYPES, BUILTIN_STEP_TYPES } from '../lib/process-ontology.mjs';
import { MethodStore } from '../lib/methods.mjs';

const action = (id, options = {}) => ({ id, title: `Result ${id}`, kind: 'action', parentId: null, status: 'pending', doneWhen: `The ${id} result meets its stated check.`, ...options });
const group = (id, kind, options = {}) => ({ id, title: `Group ${id}`, kind, parentId: null, status: 'pending', ...options });
const actor = (revision, runId = 'run-one', nodeId = 'coordinator') => ({ expectedRevision: revision, runId, nodeId, schemaVersion: 4, executionGuardrails: true });
const normalize = (steps, plan = { layout: 'sequence' }, options) => normalizeTaskPlan({ plan, steps }, { executionGuardrails: true, ...options });
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
  assert.match(await store.getContext(state.taskId, { maxChars: 512, executionGuardrails: true }), /Inspect the destination before any retry/);
});



test('retired native task schemas reject construction before storage mutation',async t=>{
 const {store,state}=await fixture(t,{legacy:true});const before=await store.get(state.taskId);
 for(const schemaVersion of [1,2,3,13])assert.throws(()=>createTaskToolHandler({store,taskId:state.taskId,schemaVersion}),{code:'TASK_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(await store.get(state.taskId),before);
});

test('an old native catalog cannot flatten a subsequently upgraded outline or invent missing completion evidence', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { steps: [group('work', 'sequence'), action('a', { parentId: 'work', status: 'active' }), action('b', { parentId: 'work' })] }, actor(state.revision));
  const preserved = structuredClone(saved);
  for(const schemaVersion of [1,2,3])assert.throws(()=>createTaskToolHandler({store,taskId:state.taskId,schemaVersion}),{code:'TASK_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(await store.get(state.taskId), preserved);
  saved=await store.setStep(state.taskId,'a',{status:'done',evidence:'Checked actual completed action using its criterion'},actor(saved.revision));assert.equal(saved.steps.find(item=>item.id==='a').parentId,'work');assert.deepEqual(saved.plan.authoredBy,preserved.plan.authoredBy);
});











test('bounded plans reject enormous arrays before traversal, overdeep trees and excessive serialized details', () => {
  let visited = 0;
  const huge = new Proxy([], { get(target, key, receiver) { if (key === 'length') return 1_000_000; if (/^\d+$/.test(String(key))) { visited++; throw Error('Must reject the declared size before reading items.'); } return Reflect.get(target, key, receiver); } });
  assert.throws(() => normalizeTaskPlan({ steps: huge }), { code: 'TASK_PLAN_LIMIT' }); assert.equal(visited, 0);
  const deep = Array.from({ length: TASK_PLAN_LIMITS.depth }, (_, index) => group(`g${index}`, 'sequence', { parentId: index ? `g${index - 1}` : null })); deep.push(action('leaf', { parentId: deep.at(-1).id }));
  assert.throws(() => normalize(deep), /nested plan levels/);
  assert.throws(() => normalize(Array.from({ length: 120 }, (_, index) => action(`a${index}`, { evidence: 'x'.repeat(2000), doneWhen: 'x'.repeat(1000), note: 'x'.repeat(700) })), { layout: 'parallel' }), { code: 'TASK_PLAN_LIMIT' });
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
