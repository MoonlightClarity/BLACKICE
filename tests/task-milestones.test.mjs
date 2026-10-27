import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, TASK_LIMITS, TASK_TOOL, TASK_TOOL_V3, TASK_SCHEMA_VERSION, LEGACY_TASK_TOOL, TASK_INSTRUCTIONS, TASK_INSTRUCTIONS_V3, LEGACY_TASK_INSTRUCTIONS, createTaskToolHandler, taskToolForVersion, taskInstructionsForVersion } from '../lib/task-state.mjs';

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-milestones-test-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), stores = [store];
  t.after(async () => { await Promise.all(stores.map(item => item.close())); assert.match(path.basename(directory), /^relay-milestones-test-/); await rm(directory, { recursive: true, force: true }); });
  const state = await store.ensure({ taskId: 'milestone-task', runId: 'initial-run', nodeId: 'coordinator', cwd, goal: 'Ship a usable chess trainer.' });
  const actor = revision => ({ expectedRevision: revision, runId: 'initial-run', nodeId: 'coordinator' });
  return { store, stores, directory, cwd, state, actor };
}
const milestones = () => [{ id: 'playable', title: 'A playable board', status: 'active', doneWhen: 'A legal move updates the board using mouse and keyboard.' }, { id: 'shippable', title: 'A launchable package', status: 'pending', doneWhen: 'The installed shortcut opens the current version.' }];

test('milestone criteria, actual-work evidence and one resume action survive restart with revision provenance', async t => {
  const { store, stores, directory, actor } = await harness(t);
  let state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  state = await store.setStep('milestone-task', 'playable', { status: 'done', evidence: 'Keyboard test moved e2 to e4; promotion has not been checked.', note: 'Actual board interaction was exercised.' }, actor(state.revision));
  state = await store.setStep('milestone-task', 'shippable', { status: 'active' }, actor(state.revision));
  state = await store.checkpoint('milestone-task', { completed: ['A playable board.'], nextSteps: ['Package, install and launch.'], nextAction: 'Run the installer and launch the installed Desktop shortcut.' }, actor(state.revision));
  const restored = await new TaskStateStore({ dataDir: directory }).init(); stores.push(restored);
  assert.deepEqual(await restored.get('milestone-task'), state);
  assert.equal(state.steps[0].doneWhen, milestones()[0].doneWhen); assert.match(state.steps[0].evidence, /has not been checked/);
  assert.equal(state.progress.done, 1); assert.equal(state.progress.current.id, 'shippable'); assert.equal(state.progress.source, 'agent-reported-plan');
  assert.equal(state.checkpoint.nextAction, 'Run the installer and launch the installed Desktop shortcut.');
  assert.equal(state.checkpoint.provenance.nodeId, 'coordinator'); assert.equal(state.checkpoint.provenance.source, 'agent');
  const history = await restored.history('milestone-task'); assert.deepEqual(history.map(item => item.revision), [1, 2, 3, 4, 5]);
  assert.equal(history[1].steps[0].evidence, undefined); assert.equal(history.at(-1).provenance.runId, 'initial-run');
  assert.equal(JSON.parse(await readFile(store.file('milestone-task'), 'utf8')).version, 1, 'optional fields require no destructive migration');
});

test('blocked milestones require a real reason, remain current ahead of pending work and clear stale blockers on resume', async t => {
  const { store, actor } = await harness(t); let state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  await assert.rejects(store.setStep('milestone-task', 'playable', { status: 'blocked' }, actor(state.revision)), /needs a reason/);
  assert.equal((await store.get('milestone-task')).revision, state.revision);
  state = await store.setStep('milestone-task', 'playable', { status: 'blocked', blockedReason: 'The test environment is offline.', evidence: 'No network response; board tests did not run.' }, actor(state.revision));
  assert.equal(state.progress.current.id, 'playable'); assert.equal(state.progress.current.status, 'blocked'); assert.equal(state.progress.done, 0);
  state = await store.setStep('milestone-task', 'playable', { status: 'blocked', note: 'Retry after connectivity returns.' }, actor(state.revision));
  assert.equal(state.steps[0].blockedReason, 'The test environment is offline.', 'updating the blocked milestone can retain its saved reason');
  const stopped = await store.interrupt('milestone-task', { runId: 'initial-run', nodeId: 'coordinator', status: 'cancelled', reason: 'Stopped while offline.' });
  assert.equal(stopped.interruption.progress.currentStepId, 'playable'); assert.equal(stopped.interruption.stepStates[0].status, 'blocked'); assert.match(stopped.steps[0].evidence, /did not run/);
  state = await store.setStep('milestone-task', 'playable', { status: 'active' }, actor(stopped.revision));
  assert.equal(state.steps[0].blockedReason, undefined); assert.equal(state.interruption, null); assert.match(state.steps[0].evidence, /did not run/);
  state = await store.setStep('milestone-task', 'shippable', { status: 'active' }, actor(state.revision));
  assert.deepEqual(state.steps.map(item => item.status), ['pending', 'active']); assert.equal(state.steps.filter(item => item.status === 'active').length, 1);
  state = await store.setStep('milestone-task', 'playable', { status: 'done', blockedReason: 'Old obstacle.' }, actor(state.revision));
  assert.equal(state.steps[0].blockedReason, undefined, 'a caller cannot reintroduce a blocker on a nonblocked milestone');
});

test('parallel milestone writers conflict truthfully and can merge after reading the latest saved state', async t => {
  const { store, stores, directory, actor } = await harness(t), other = await new TaskStateStore({ dataDir: directory }).init(); stores.push(other);
  let state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  const updates = [
    ['playable', { status: 'done', evidence: 'A legal move worked in the real board.' }],
    ['shippable', { status: 'blocked', blockedReason: 'Installer is still building.' }],
  ];
  const outcomes = await Promise.allSettled([store.setStep('milestone-task', ...updates[0], { ...actor(state.revision), nodeId: 'board-worker' }), other.setStep('milestone-task', ...updates[1], { ...actor(state.revision), nodeId: 'package-worker' })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); const rejectedIndex = outcomes.findIndex(item => item.status === 'rejected'); assert.equal(outcomes[rejectedIndex].reason.code, 'TASK_STATE_CONFLICT');
  state = await other.get('milestone-task'); const winnerState = structuredClone(state.steps[1 - rejectedIndex]);
  state = await other.setStep('milestone-task', ...updates[rejectedIndex], { ...actor(state.revision), nodeId: 'retrying-worker' });
  assert.deepEqual(state.steps[1 - rejectedIndex], winnerState); assert.equal(state.steps[0].status, 'done'); assert.equal(state.steps[1].status, 'blocked'); assert.equal(state.progress.current.id, 'shippable');
  assert.equal(state.provenance.nodeId, 'retrying-worker'); assert.equal((await store.history('milestone-task')).length, 4);
});

test('advancing or changing the focused milestone retires its saved action without rewriting checkpoint history', async t => {
  const { store, actor } = await harness(t); let state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  state = await store.checkpoint('milestone-task', { decisions: ['Keep the SVG pieces.'], nextSteps: ['Write board.svg again.'], nextAction: 'Write board.svg.' }, actor(state.revision)); const checkpointRevision = state.revision;
  state = await store.setStep('milestone-task', 'playable', { status: 'done', evidence: 'A legal move was checked.' }, actor(state.revision));
  assert.equal(state.checkpoint.nextAction, undefined); assert.deepEqual(state.checkpoint.decisions, ['Keep the SVG pieces.']);
  const advancedContext = await store.getContext('milestone-task'); assert.match(advancedContext, /Next action: A launchable package/); assert.ok(!advancedContext.includes('Next action: Write board.svg'));
  assert.equal((await store.history('milestone-task')).find(item => item.revision === checkpointRevision).checkpoint.nextAction, 'Write board.svg.');
  state = await store.setStep('milestone-task', 'shippable', { status: 'active' }, actor(state.revision));
  state = await store.checkpoint('milestone-task', { nextAction: 'Launch the current installer.' }, actor(state.revision));
  state = await store.setStep('milestone-task', 'shippable', { status: 'active', evidence: 'The package has been built.' }, actor(state.revision));
  assert.equal(state.checkpoint.nextAction, 'Launch the current installer.', 'new evidence alone does not retire a still-relevant action');
  state = await store.setStep('milestone-task', 'shippable', { status: 'active', doneWhen: 'The installed and updated shortcut launches version 2.18.' }, actor(state.revision));
  assert.equal(state.checkpoint.nextAction, undefined); assert.equal(state.steps[1].evidence, undefined, 'changed acceptance criteria cannot reuse an old evidence claim');
  state = await store.checkpoint('milestone-task', { nextAction: 'Launch the updated package.' }, actor(state.revision));
  state = await store.setPlan('milestone-task', { steps: state.steps.map(step => step.id === 'shippable' ? { ...step, title: 'An installed current version' } : step) }, actor(state.revision));
  assert.equal(state.checkpoint.nextAction, undefined, 'whole-plan edits also invalidate actions for changed current milestones');
});

test('reopening or revising completed milestones clears stale evidence while an explicit fresh report remains possible', async t => {
  const { store, actor } = await harness(t); let state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  state = await store.setStep('milestone-task', 'playable', { status: 'done', evidence: 'The first board check passed.' }, actor(state.revision)); const doneRevision = state.revision;
  state = await store.setStep('milestone-task', 'playable', { status: 'active' }, actor(state.revision));
  assert.equal(state.steps[0].evidence, undefined); assert.equal(state.steps[0].doneWhen, milestones()[0].doneWhen);
  assert.equal((await store.history('milestone-task')).find(item => item.revision === doneRevision).steps[0].evidence, 'The first board check passed.');
  state = await store.setStep('milestone-task', 'playable', { status: 'done', evidence: 'The updated board check passed.' }, actor(state.revision));
  state = await store.setStep('milestone-task', 'playable', { status: 'done', doneWhen: 'Castling and promotion also work.' }, actor(state.revision));
  assert.equal(state.steps[0].evidence, undefined);
  state = await store.setStep('milestone-task', 'playable', { status: 'active', evidence: 'New promotion check failed; fix in progress.' }, actor(state.revision));
  assert.equal(state.steps[0].evidence, 'New promotion check failed; fix in progress.');
  state = await store.setStep('milestone-task', 'playable', { status: 'done', evidence: 'Promotion check passed.' }, actor(state.revision));
  state = await store.setPlan('milestone-task', { steps: state.steps.map(step => step.id === 'playable' ? { ...step, status: 'pending' } : step) }, actor(state.revision));
  assert.equal(state.steps[0].evidence, undefined, 'a copied full-plan payload cannot silently carry completed evidence into reopened work');
});

test('legacy records and original step/checkpoint calls retain their optional field behavior', async t => {
  const { store, actor, directory, stores } = await harness(t);
  let state = await store.setPlan('milestone-task', { steps: [{ id: 'old-step', title: 'Original saved step', status: 'active', note: 'Legacy note.' }] }, actor(1));
  state = await store.checkpoint('milestone-task', { goal: 'Legacy goal.', completed: [], nextSteps: ['Legacy next step.'] }, actor(state.revision));
  const other = await new TaskStateStore({ dataDir: directory }).init(); stores.push(other); state = await other.get('milestone-task');
  assert.equal(state.steps[0].doneWhen, undefined); assert.equal(state.steps[0].evidence, undefined); assert.equal(state.checkpoint.nextAction, undefined);
  state = await other.setStep('milestone-task', 'old-step', { status: 'done' }, actor(state.revision));
  assert.equal(state.steps[0].note, 'Legacy note.'); assert.equal(state.steps[0].doneWhen, undefined); assert.equal(state.progress.done, 1);
  const context = await other.getContext('milestone-task'); assert.match(context, /Next action: Legacy next step\./);
  assert.equal(TASK_SCHEMA_VERSION, 8); assert.equal(TASK_TOOL.name, LEGACY_TASK_TOOL.name);
  assert.equal(taskToolForVersion(1), LEGACY_TASK_TOOL); assert.equal(taskToolForVersion(8), TASK_TOOL);
  assert.ok(!taskToolForVersion(5).inputSchema.properties.action.enum.includes('edit')); assert.ok(TASK_TOOL.inputSchema.properties.action.enum.includes('edit'));
  assert.deepEqual(TASK_TOOL_V3.inputSchema.properties.action.enum.filter(action => action !== 'external'), LEGACY_TASK_TOOL.inputSchema.properties.action.enum);
  for (const key of ['doneWhen', 'evidence', 'blockedReason', 'nextAction']) assert.equal(LEGACY_TASK_TOOL.inputSchema.properties[key], undefined);
  for (const key of ['doneWhen', 'evidence', 'blockedReason']) assert.equal(LEGACY_TASK_TOOL.inputSchema.properties.steps.items.properties[key], undefined);
  assert.ok(!LEGACY_TASK_TOOL.inputSchema.properties.status.enum.includes('blocked')); assert.ok(TASK_TOOL.inputSchema.properties.status.enum.includes('blocked'));
  const v5Instructions = taskInstructionsForVersion(5);
  assert.match(TASK_INSTRUCTIONS_V3, /Simple questions and quick edits need no saved plan/); assert.doesNotMatch(TASK_INSTRUCTIONS, /need no saved plan/); assert.match(v5Instructions, /coordinator owns the shared plan/); assert.match(v5Instructions, /revision conflict/); assert.match(v5Instructions, /one concrete nextAction/);
  assert.match(TASK_INSTRUCTIONS, /LIVE PLANNING WORKSPACE/); assert.match(TASK_INSTRUCTIONS, /A changed revision requires a fresh read/); assert.match(TASK_INSTRUCTIONS, /cannot rewrite another owner’s plan, global goal or checkpoint/);
  assert.ok(!LEGACY_TASK_INSTRUCTIONS.includes('doneWhen')); assert.ok(!LEGACY_TASK_INSTRUCTIONS.includes('nextAction'));
});

test('milestone bounds reject invalid criteria, evidence, blockers and next actions without changing saved revisions', async t => {
  const { store, actor } = await harness(t); const state = await store.setPlan('milestone-task', { steps: milestones() }, actor(1));
  for (const [key, values] of [['doneWhen', ['', ' ', 'x'.repeat(1001), 'bad\0value']], ['evidence', ['x'.repeat(2001), 'bad\0value', {}]], ['blockedReason', ['', ' ', 'x'.repeat(1001), 'bad\0value']]]) {
    for (const value of values) {
      assert.throws(() => store.setStep('milestone-task', 'playable', { status: key === 'blockedReason' ? 'blocked' : 'active', [key]: value }, actor(state.revision)), { code: 'INVALID_TASK_STATE' });
      assert.throws(() => store.setPlan('milestone-task', { steps: [{ title: 'Invalid milestone', status: key === 'blockedReason' ? 'blocked' : 'active', [key]: value }] }, actor(state.revision)), { code: 'INVALID_TASK_STATE' });
    }
  }
  for (const nextAction of ['', ' ', 'x'.repeat(1001), 'bad\0value', []]) await assert.rejects(store.checkpoint('milestone-task', { nextAction }, actor(state.revision)), { code: 'INVALID_TASK_STATE' });
  assert.throws(() => store.setPlan('milestone-task', { steps: [{ title: 'Blocked without explanation', status: 'blocked' }] }, actor(state.revision)), /needs a reason/);
  assert.equal((await store.get('milestone-task')).revision, state.revision); assert.equal((await store.history('milestone-task')).length, 2);
  const cleared = await store.setStep('milestone-task', 'playable', { status: 'active', doneWhen: 'x'.repeat(1000), evidence: '' }, actor(state.revision));
  assert.equal(cleared.steps[0].evidence, ''); assert.equal(cleared.steps[0].doneWhen.length, 1000);
});

test('milestone count follows the saved-state budget and enormous arrays stop validation before allocating an unbounded plan', async t => {
  const { store, actor } = await harness(t);
  let state = await store.setPlan('milestone-task', { steps: Array.from({ length: 100 }, (_, index) => ({ title: `Deliver outcome ${index + 1}`, doneWhen: 'The corresponding check passes.' })) }, actor(1));
  assert.equal(state.steps.length, 100); assert.equal(state.progress.total, 100); assert.ok(JSON.stringify(state).length < TASK_LIMITS.agentStateChars);
  let visited = 0; const huge = new Proxy([], { get(target, key, receiver) { if (key === 'length') return 1_000_000; if (/^\d+$/.test(String(key))) { visited++; if (visited > 30) throw new Error('Validation did not stop at the state budget.'); return { title: 'Outcome', doneWhen: 'x'.repeat(1000), evidence: 'x'.repeat(2000), note: 'x'.repeat(700) }; } return Reflect.get(target, key, receiver); } });
  assert.throws(() => store.setPlan('milestone-task', { steps: huge }, actor(state.revision)), { code: 'TASK_STATE_LIMIT' }); assert.ok(visited < 30);
  await assert.rejects(store.setPlan('milestone-task', { steps: Array.from({ length: 17 }, (_, index) => ({ title: `Deliver outcome ${index}`, doneWhen: 'x'.repeat(1000), evidence: 'x'.repeat(2000) })) }, actor(state.revision)), { code: 'TASK_STATE_LIMIT' });
  assert.equal((await store.get('milestone-task')).revision, state.revision);
});

test('continuity budgets preserve outcome, current milestone, evidence, blocker and one next action before historical detail', async t => {
  const { store, actor } = await harness(t);
  let state = await store.setPlan('milestone-task', { goal: 'Ship chess. ' + 'Outcome detail. '.repeat(120), steps: [{ id: 'resume', title: 'Board check', status: 'blocked', doneWhen: 'Legal moves pass. ' + 'Criteria. '.repeat(95), evidence: 'Offline check failed. ' + 'Evidence detail. '.repeat(110), blockedReason: 'Network unavailable. ' + 'Obstacle. '.repeat(90) }, ...Array.from({ length: 80 }, (_, index) => ({ title: `Later milestone ${index + 1}` }))] }, actor(1));
  state = await store.checkpoint('milestone-task', { nextAction: 'Resume board check.', decisions: Array(8).fill('Old decision. '.repeat(45)), completed: Array(8).fill('Historical work. '.repeat(40)), nextSteps: ['This older list must not displace the concrete resume action.'] }, actor(state.revision));
  for (const maxChars of [512, 800, 1200, 12000]) {
    const context = await store.getContext('milestone-task', { maxChars }); assert.ok(context.length <= maxChars);
    for (const label of ['Outcome:', 'Current milestone:', 'Done when:', 'Blocked:', 'Evidence:', 'Next action:']) assert.ok(context.includes(label), `${label} must survive a ${maxChars} character budget`);
    assert.match(context, /agent-reported/); assert.match(context, /not correctness/); assert.match(context, /Next action: Resume/);
    assert.ok(context.indexOf('Next action:') < (context.indexOf('Milestones:') < 0 ? Infinity : context.indexOf('Milestones:')));
    if (maxChars < 12000) assert.match(context, /shortened/);
  }
  const withoutTool = await store.getContext('milestone-task', { maxChars: 512, toolAvailable: false }); assert.ok(!withoutTool.includes('use relay_task')); assert.match(withoutTool, /task tool unavailable/);
  assert.equal((await store.get('milestone-task')).revision, state.revision, 'context assembly is read-only');
});

test('bound milestone tools emit committed truth, retain file-byte limits and expose no claim of automated check verification', async t => {
  const { store } = await harness(t), events = [], handler = createTaskToolHandler({ store, taskId: 'milestone-task', runId: 'bound-run', nodeId: 'worker', onEvent: event => events.push(event) });
  let result = await handler({ name: 'relay_task', arguments: { action: 'plan', expectedRevision: 1, steps: milestones() } }); assert.equal(result.success, true);
  let state = JSON.parse(result.contentItems[0].text);
  result = await handler({ name: 'relay_task', arguments: { action: 'step', expectedRevision: state.revision, stepId: 'playable', status: 'blocked', blockedReason: 'Build is unavailable.', evidence: 'No check executed.' } }); assert.equal(result.success, true); state = JSON.parse(result.contentItems[0].text);
  result = await handler({ name: 'relay_task', arguments: { action: 'checkpoint', expectedRevision: state.revision, nextAction: 'Build and run the board test.' } }); assert.equal(result.success, true); state = JSON.parse(result.contentItems[0].text);
  assert.equal(events.length, 3); assert.deepEqual(events.at(-1).state, await store.get('milestone-task')); assert.equal(state.provenance.runId, 'bound-run'); assert.equal(state.progress.done, 0);
  assert.equal(state.steps[0].verification, undefined); assert.equal(state.steps[0].verifiedAt, undefined); assert.equal(state.steps[0].evidence, 'No check executed.');
  assert.match(TASK_TOOL.inputSchema.properties.evidence.description, /not runtime verification/);
  const invalid = await handler({ name: 'relay_task', arguments: { action: 'step', expectedRevision: state.revision, stepId: 'playable', status: 'blocked', blockedReason: '' } }); assert.equal(invalid.success, false); assert.equal(events.length, 3); assert.equal((await store.get('milestone-task')).revision, state.revision);
});
