import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
import { parsePlanAcceptanceArguments, assessPlanAcceptance } from '../scripts/verify-task-plan-runtime.mjs';

function proof() {
  const tool = (name, action, path) => ({ name, arguments: { action, ...(path ? { path } : {}) }, success: true });
  return {
    rootBeforeModel: true,
    expected: { model: 'exact-model', tokens: ['actual-alpha', 'actual-beta'] },
    artifact: { decision: 'combined', currency: 'USD', total: 42, sourceTokens: ['actual-beta', 'actual-alpha'] },
    calls: [{ model: 'exact-model', resolvedModel: 'exact-model', finishedAt: '2026-10-18T00:00:01Z', toolCalls: [
      tool('relay_task', 'plan'), tool('relay_workspace', 'read', 'alpha.json'), tool('relay_workspace', 'read', 'beta.json'),
      tool('relay_workspace', 'write', 'result.json'), tool('relay_workspace', 'read', 'result.json'), tool('relay_task', 'artifact', 'result.json')
    ] }],
    run: { id: 'run', status: 'completed', settled: true, nodes: { agent: { taskSchemaVersion: TASK_SCHEMA_VERSION, planning: { status: 'recorded' } } }, taskState: {
      planVersion: 1, plan: { origin: 'agent', authoredBy: { runId: 'run' } }, progress: { complete: true },
      steps: [{ id: 'collect', kind: 'parallel' }, ...['first', 'second', 'check'].map(id => ({ id, kind: 'action', parentId: 'collect', status: 'done', doneWhen: 'The source and result match.', evidence: 'Observed the matching file fields.' }))],
      artifacts: [{ fileName: 'result.json', sha256: 'a'.repeat(64) }]
    } }
  };
}

test('native outline acceptance requires an explicit bounded live invocation and an exact model ID', () => {
  assert.throws(() => parsePlanAcceptanceArguments([]), /--live/);
  for (const args of [['--live', '--timeout-ms', '14999'], ['--live', '--timeout-ms', '100001'], ['--live', '--model', 'model with spaces'], ['--live', '--unknown'], ['--live', '--output-dir', 'relative']]) assert.throws(() => parsePlanAcceptanceArguments(args));
  assert.deepEqual(parsePlanAcceptanceArguments(['--live', '--model', 'exact-model', '--timeout-ms', '30000']), { live: true, model: 'exact-model', timeoutMs: 30000 });
});

test('native outline acceptance binds the selected model and completed structured work to actual file evidence', () => {
  const fixture = proof(); assert.equal(assessPlanAcceptance(fixture).passed, true);
  fixture.calls[0].resolvedModel = 'another-model'; assert.equal(assessPlanAcceptance(fixture).checks.oneExactModelTurn, false);
  fixture.calls[0].resolvedModel = fixture.expected.model; fixture.artifact.sourceTokens[0] = 'fabricated';
  assert.equal(assessPlanAcceptance(fixture).checks.correctResult, false);
});

test('a final response, blank scaffold, or unchecked completion cannot pass the live plan gate', () => {
  for (const mutate of [
    fixture => { fixture.run.taskState.plan.origin = 'runtime'; },
    fixture => { fixture.run.taskState.plan.authoredBy.runId = 'previous-run'; },
    fixture => { fixture.run.taskState.progress.complete = false; },
    fixture => { fixture.run.taskState.steps[1].evidence = ''; },
    fixture => { fixture.run.nodes.agent.planning.status = 'missing'; },
    fixture => { fixture.run.nodes.agent.taskSchemaVersion = TASK_SCHEMA_VERSION - 1; },
    fixture => { fixture.rootBeforeModel = false; }
  ]) { const fixture = proof(); mutate(fixture); assert.equal(assessPlanAcceptance(fixture).passed, false); }
});

test('a late plan or unsuccessful reads cannot substitute for planning before file changes and checking the output', () => {
  const late = proof(), calls = late.calls[0].toolCalls;
  calls.push(calls.shift()); assert.equal(assessPlanAcceptance(late).checks.plannedBeforeFileWrite, false);
  const unread = proof(); unread.calls[0].toolCalls.find(call => call.arguments.action === 'read').success = false;
  assert.equal(assessPlanAcceptance(unread).checks.originalInputsRead, false);
  const unchecked = proof(); unchecked.calls[0].toolCalls = unchecked.calls[0].toolCalls.filter(call => !(call.arguments.action === 'read' && call.arguments.path === 'result.json'));
  assert.equal(assessPlanAcceptance(unchecked).checks.savedResultReadBack, false);
});

test('unexpected native work or denied actions invalidate otherwise correct task evidence', () => {
  for (const extra of [{ nativeTools: [{ tool: 'shell_command' }] }, { denied: [{ name: 'relay_control' }] }]) assert.equal(assessPlanAcceptance({ ...proof(), ...extra }).passed, false);
  const fixture = proof(); fixture.calls[0].toolCalls.push({ name: 'relay_browser', arguments: { action: 'navigate' }, success: true });
  assert.equal(assessPlanAcceptance(fixture).checks.onlyRequestedToolWork, false);
});
