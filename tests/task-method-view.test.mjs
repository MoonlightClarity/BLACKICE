import test from 'node:test';
import assert from 'node:assert/strict';
import { methodOutlineRows, methodDraftPrompt, renderMethodOutline } from '../public/task-method-ui.mjs';
import { missionMilestones, missionProgress, createMissionWorkflow } from '../public/mission-model.mjs';
import { repeatTaskSeed } from '../public/repeat-task-model.mjs';

const method = { id: 'evidence-choice', revision: 3, name: 'Compare <evidence>', outline: { layout: 'sequence', steps: [
  { id: 'gather', kind: 'parallel', title: 'Gather evidence' },
  { id: 'source-a', parentId: 'gather', kind: 'action', title: 'Read source A', doneWhen: 'A is inspected.' },
  { id: 'source-b', parentId: 'gather', kind: 'action', title: 'Read source B', dependsOn: ['source-a'], doneWhen: 'B is inspected.' },
  { id: 'route', kind: 'choice', title: 'Choose the supported account' },
  { id: 'supported', parentId: 'route', kind: 'action', title: 'Explain the finding', condition: 'The observations agree.' }
] } };

test('method preview numbers actual nested branches and preserves explicit alternatives', () => {
  const rows = methodOutlineRows(method);
  assert.deepEqual(rows.map(row => [row.id, row.number, row.depth]), [['gather','1',0],['source-a','1.1',1],['source-b','1.2',1],['route','2',0],['supported','2.1',1]]);
  assert.equal(rows.find(row => row.id === 'supported').condition, 'The observations agree.');
  assert.match(renderMethodOutline(method), /In parallel/); assert.match(renderMethodOutline(method), /Choose a path/); assert.match(renderMethodOutline(method), /After Read source A/);
});

test('a root choice identifies alternatives before the actual numbered steps without selecting a path', () => {
  const blueprint = { outline: { layout: 'choice', steps: [
    { id: 'revise', kind: 'action', title: 'Revise the draft', condition: 'Review finds a material issue.' },
    { id: 'deliver', kind: 'action', title: 'Deliver the checked draft', condition: 'All checks pass.' }
  ] } }, original = structuredClone(blueprint), html = renderMethodOutline(blueprint);
  assert.ok(html.indexOf('Choose a path') < html.indexOf('<ol'));
  assert.match(html, /branches are alternatives/); assert.match(html, /chooses a path for the current task/);
  assert.match(html, /When Review finds a material issue/); assert.match(html, /When All checks pass/);
  assert.deepEqual(methodOutlineRows(blueprint).map(row => [row.id, row.number]), [['revise','1'],['deliver','2']]);
  assert.equal((html.match(/<li /g) || []).length, 2, 'the root description does not add a pretend step');
  assert.deepEqual(blueprint, original); assert.ok(!html.includes('aria-selected')); assert.ok(!html.includes('Completed'));
});

test('a parallel root communicates independent branches while retaining each prerequisite', () => {
  const blueprint = { outline: { layout: 'parallel', steps: [
    { id: 'inspect', kind: 'action', title: 'Inspect source material' },
    { id: 'check', kind: 'action', title: 'Cross-check the observations', dependsOn: ['inspect'] }
  ] } }, html = renderMethodOutline(blueprint);
  assert.ok(html.indexOf('In parallel') < html.indexOf('<ol'));
  assert.match(html, /independently, subject to their prerequisites/); assert.match(html, /After Inspect source material/);
  assert.equal((html.match(/<li /g) || []).length, 2); assert.ok(!html.includes('Running'));
});

test('a method adds a revision-bound direction to the authored draft and never turns its definition into commands', () => {
  const original = 'Check the report.\nKeep my exact limits.  ';
  const text = methodDraftPrompt(method, original);
  assert.ok(text.startsWith(original + '\n\n')); assert.ok(text.includes(JSON.stringify({ id: method.id, revision: 3, name: method.name })));
  assert.match(text, /methodId and methodRevision/); assert.match(text, /Reassess choices/); assert.ok(!text.includes('A is inspected.'));
  assert.ok(methodDraftPrompt(method).endsWith('Task: ')); assert.throws(() => methodDraftPrompt({ name: 'Not saved' }), /saved method/);
});

test('method rendering treats source text as data and tolerates a malformed imported relationship', () => {
  const unsafe = { outline: { steps: [{ id: 'a', parentId: 'b', title: '<img src=x onerror=alert(1)>', kind: 'action', doneWhen: '<script>bad</script>' }, { id: 'b', parentId: 'a', title: 'Cycle', kind: 'sequence' }] } };
  const rows = methodOutlineRows(unsafe), html = renderMethodOutline(unsafe);
  assert.equal(rows.length, 2); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  assert.equal(methodOutlineRows({ steps: [{ id: 'plain', title: 'Check', type: 'check', checks: ['Actual result matches.'] }] })[0].doneWhen, 'Actual result matches.');
});

test('mission and repeat controls use action counts and explicit completion, including resolved skipped alternatives', () => {
  const state = { planVersion: 1, plan: { layout: 'sequence', origin: 'agent' }, steps: [{ id: 'group', kind: 'choice', title: 'Route', status: 'done', selectedChildId: 'chosen' }, { id: 'chosen', parentId: 'group', kind: 'action', title: 'Chosen work', status: 'done', evidence: 'Checked.' }, { id: 'other', parentId: 'group', kind: 'action', title: 'Alternative', status: 'skipped', skipReason: 'Not needed.' }], progress: { total: 1, done: 1, skipped: 1, complete: true, current: null } };
  const run = { id: 'run', taskId: 'run', status: 'completed', settled: true, taskState: state, input: 'Do the work.', cwd: '/tmp/task', workflow: createMissionWorkflow({ task: 'Do the work.', id: 'workflow' }) };
  assert.equal(missionMilestones(state).complete, true); assert.equal(missionProgress(run).total, 1); assert.equal(missionProgress(run).completed, 1);
  assert.equal(repeatTaskSeed(run, run).repeatTask, true);
  state.progress.complete = false; state.progress.unresolvedBranches = 1;
  assert.equal(missionMilestones(state).complete, false); assert.throws(() => repeatTaskSeed(run, run), /remaining milestones/);
});

test('mission workflows retain an explicitly selected plan detail independently of reasoning effort', () => {
  const workflow = createMissionWorkflow({ task: 'Inspect the saved output.', id: 'detailed', planDetail: 'detailed', effort: 'low' });
  assert.equal(workflow.settings.planDetail, 'detailed'); assert.equal(workflow.nodes.find(node => node.type === 'agent').effort, 'low');
  assert.ok(!workflow.nodes.find(node => node.type === 'agent').prompt.includes('do not need a plan'));
  assert.equal(Object.hasOwn(createMissionWorkflow({ task: 'Explain this.', id: 'default' }).settings, 'planDetail'), false);
});
