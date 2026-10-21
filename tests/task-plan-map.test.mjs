import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlanView } from '../public/task-plan-model.mjs';
import { taskPlanMap, reconcilePlanMapSession, renderTaskPlanMapSVG, exportTaskPlanMM, escapePlanXML, taskPlanExport, planMapZoom, planMapFitZoom } from '../public/task-plan-map.mjs';

const step = (id, parentId = null, extra = {}) => ({ id, title: id, kind: 'action', status: 'pending', parentId, dependsOn: [], ...extra });
const state = () => ({ taskId: 'saved-tree', revision: 9, goal: 'Inspect, choose and verify the result', planVersion: 1, plan: { origin: 'agent', layout: 'sequence', detail: 'detailed' }, steps: [
  step('inspect', null, { kind: 'parallel', status: 'active' }),
  step('source', 'inspect', { status: 'done', note: 'Keep the source.', evidence: 'Read the saved bytes.' }),
  step('constraints', 'inspect', { status: 'active', doneWhen: 'The constraints are recorded.' }),
  step('choose', null, { kind: 'choice', selectedChildId: 'reuse', dependsOn: ['inspect'] }),
  step('reuse', 'choose', { condition: 'The saved method fits.' }),
  step('replace', 'choose', { condition: 'The saved method does not fit.' }),
  step('verify', null, { dependsOn: ['choose'], note: 'Check the actual result.' }),
], artifacts: [] });

test('the mind map contains the exact saved tree plus its goal, with deterministic nonoverlapping layout', () => {
  const source = state(), before = structuredClone(source), view = taskPlanView(source), map = taskPlanMap(view);
  assert.deepEqual(map.nodes.filter(node => !node.isGoal).map(node => node.id), view.nodes.map(node => node.id));
  assert.equal(map.nodes[0].isGoal, true); assert.equal(map.nodes[0].title, source.goal);
  assert.deepEqual(taskPlanMap(view).nodes.map(({ id, x, y }) => ({ id, x, y })), map.nodes.map(({ id, x, y }) => ({ id, x, y })));
  for (const [index, a] of map.nodes.entries()) for (const b of map.nodes.slice(index + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `overlap between ${a.id} and ${b.id}`);
  assert.deepEqual(source, before); assert.equal(map.nodes.find(node => node.id === 'source').source, source.steps[1]);
});

test('sequence, parallel, choice and dependency relations retain distinct saved meanings', () => {
  const view = taskPlanView(state()), map = taskPlanMap(view), edge = (source, target, relation) => map.edges.find(edge => edge.sourceId === source && edge.targetId === target && edge.relation === relation);
  assert.ok(edge(null, 'inspect', 'sequence')); assert.ok(edge('inspect', 'source', 'parallel')); assert.ok(edge('choose', 'reuse', 'choice')); assert.ok(edge('choose', 'verify', 'dependency'));
  assert.equal(map.byId.get('reuse').isSelectedOption, true); assert.equal(map.byId.get('replace').branch, 'not-selected');
  assert.equal(map.byId.get('replace').status, 'pending', 'displaying alternatives must never mark them skipped');
});

test('every branch and leaf can be focused without unrelated nodes or lost dependency context', () => {
  const view = taskPlanView(state());
  assert.deepEqual(taskPlanMap(view, { focusId: 'inspect' }).nodes.map(node => node.id), ['inspect', 'source', 'constraints']);
  const leaf = taskPlanMap(view, { focusId: 'verify' }); assert.deepEqual(leaf.nodes.map(node => node.id), ['verify']); assert.deepEqual(leaf.externalDependencies, [{ sourceId: 'choose', targetId: 'verify' }]);
  const collapsed = taskPlanMap(view, { collapsed: new Set(['inspect']) }); assert.equal(collapsed.byId.has('source'), false); assert.equal(collapsed.byId.get('inspect').collapsed, true);
  assert.equal(taskPlanMap(view, { focusId: 'removed' }).nodes[0].isGoal, true);
});

test('selection outside a focused branch restores context and removed focus IDs never strand the map', () => {
  const view = taskPlanView(state());
  const saved = { presentation: 'map', mapFocusId: 'inspect', selectedId: 'source', mapZoom: 1.4 };
  assert.equal(reconcilePlanMapSession(view, saved).mapFocusId, 'inspect');
  assert.equal(reconcilePlanMapSession(view, { ...saved, selectedId: 'verify' }).mapFocusId, null);
  assert.equal(reconcilePlanMapSession(view, { ...saved, mapFocusId: 'removed' }).mapFocusId, null);
  assert.equal(planMapZoom(Infinity), 1); assert.equal(planMapZoom(-1), .35); assert.equal(planMapZoom(4), 2.5);
});

test('width fitting keeps a readable scale for short and wide trees without enlarging focused leaves', () => {
  assert.equal(planMapFitZoom({ width: 600, height: 298 }, 520), .9);
  assert.equal(planMapFitZoom({ width: 600, height: 2980 }, 520), .9, 'tree height cannot shrink the reading size');
  assert.equal(planMapFitZoom({ width: 600, height: 298 }, 570), .95);
  assert.equal(planMapFitZoom({ width: 600, height: 298 }, 320), .9, 'narrow screens pan through a readable map');
  assert.equal(planMapFitZoom({ width: 288, height: 166 }, 520), 1, 'a focused leaf retains its native reading size');
  assert.equal(planMapFitZoom({ width: 600 }, 0), 1, 'an unmeasured canvas must not create a tiny first render');
});

test('rendered SVG uses saved IDs, accessible selection, all relation styles and unique gradient references', () => {
  const view = taskPlanView(state(), { runStatus: 'running' }), svg = renderTaskPlanMapSVG(view, { selectedId: 'constraints', collapsed: new Set(), mapZoom: 1 }, { prefix: 'task-one' });
  assert.match(svg, /data-plan-map-node="constraints"[^>]*aria-current="step"/); assert.match(svg, /aria-pressed="true"/); assert.match(svg, /<linearGradient id="task-one-surface"/);
  for (const relation of ['sequence', 'parallel', 'choice', 'dependency']) assert.ok(svg.includes(`data-relation="${relation}"`));
  assert.match(svg, /marker-end="url\(#task-one-arrow\)"/); assert.match(svg, /role="button" tabindex="0"/);
  assert.doesNotMatch(renderTaskPlanMapSVG(view, {}, { prefix: 'task-two' }), /url\(#task-one-/);
});

test('SVG and Freeplane exports contain the entire saved tree even after a focused collapsed view', () => {
  const source = state(), view = taskPlanView(source), svg = taskPlanExport(view, 'svg'), mm = taskPlanExport(view, 'mm');
  assert.equal(svg.contentType, 'image/svg+xml;charset=utf-8'); assert.match(svg.fileName, /\.svg$/); assert.match(mm.fileName, /\.mm$/);
  assert.doesNotMatch(svg.text, /var\(--task-plan-map/); assert.match(svg.text, /fill:url\(#blackice-task-map-surface\)/); assert.match(svg.text, /fill:url\(#blackice-task-map-goal\)/);
  for (const node of view.nodes) { assert.ok(svg.text.includes(`data-plan-map-node="${node.id}"`)); assert.ok(mm.text.includes(`NAME="BLACKICE step ID" VALUE="${node.id}"`)); }
  assert.match(svg.text, /<metadata>/); assert.match(svg.text, /Keep the source/); assert.match(mm.text, /<richcontent TYPE="NOTE">/); assert.match(mm.text, /Read the saved bytes/);
  assert.equal((mm.text.match(/<node /g) || []).length, source.steps.length + 1); assert.equal((mm.text.match(/<\/node>/g) || []).length, source.steps.length + 1);
  const ids = new Set([...mm.text.matchAll(/<node ID="([^"]+)"/g)].map(match => match[1]));
  for (const [, destination] of mm.text.matchAll(/<arrowlink DESTINATION="([^"]+)"/g)) assert.ok(ids.has(destination));
  assert.match(mm.text, /NAME="Root relation" VALUE="sequence"/); assert.match(mm.text, /NAME="Selected child" VALUE="reuse"/);
  assert.throws(() => taskPlanExport(taskPlanView({ steps: [] }), 'svg'), /no saved steps/); assert.throws(() => taskPlanExport(view, 'html'), /Choose SVG/);
});

test('Freeplane notes keep the expected result distinct from actual completion evidence', () => {
  const expected = 'A report saved at report.txt', evidence = 'Read the saved report and checked its exact content.';
  const source = { taskId: 'planned-export', goal: 'Save a report', plan: { origin: 'agent', detail: 'detailed' }, steps: [step('save', null, { result: expected, doneWhen: 'The saved content passes its check.', note: 'Write, read and check the report.' })] }, before = structuredClone(source);
  const pending = exportTaskPlanMM(taskPlanView(source, { planningMode: 'maximal' }));
  assert.match(pending, /<b>Expected result: <\/b>A report saved at report\.txt/);
  assert.doesNotMatch(pending, /<b>(?:Result|Evidence): <\/b>/);
  const completed = { ...source, steps: [{ ...source.steps[0], status: 'done', evidence }] };
  const done = exportTaskPlanMM(taskPlanView(completed, { planningMode: 'maximal' }));
  assert.match(done, /<b>Expected result: <\/b>A report saved at report\.txt/);
  assert.match(done, /<b>Evidence: <\/b>/); assert.ok(done.includes(evidence)); assert.doesNotMatch(done, /<b>Result: <\/b>/);
  assert.deepEqual(source, before); assert.equal(completed.steps[0].result, expected);
});

test('exports safely encode adversarial task text, invalid XML characters and original step IDs', () => {
  const payload = `A & B <script onload="alert(1)">bad</script>\u0000\u000b\ud800 emoji 🙂`, source = state();
  source.goal = payload; source.steps[0].title = payload; source.steps[0].id = 'javascript:bad"/><hook NAME="bad'; source.steps[1].parentId = source.steps[0].id; source.steps[2].parentId = source.steps[0].id; source.steps[3].dependsOn = [source.steps[0].id];
  source.steps[1].note = 'First line\nSecond & <b>literal</b>'; source.steps[1].evidence = '</style><script>evil()</script>';
  const view = taskPlanView(source), svg = taskPlanExport(view, 'svg').text, mm = exportTaskPlanMM(view);
  for (const text of [svg, mm]) { assert.doesNotMatch(text, /<script|<hook|<!DOCTYPE|<!ENTITY|\bonload="|\u0000|\u000b|\ud800/); assert.match(text, /&lt;script/); }
  assert.match(mm, /First line<br\/>Second &amp; &lt;b&gt;literal&lt;\/b&gt;/); assert.doesNotMatch(mm, /ID="javascript|DESTINATION="javascript/);
  assert.equal(escapePlanXML(`"'&<>\r\n\t\u0000🙂`), '&quot;&apos;&amp;&lt;&gt;\r\n\t🙂');
});

test('an empty runtime scaffold never becomes a fabricated SVG plan', () => {
  const view = taskPlanView({ goal: 'A pending goal', steps: [], plan: { origin: 'runtime' } });
  assert.deepEqual(taskPlanMap(view).nodes, []); assert.deepEqual(taskPlanMap(view).edges, []); assert.doesNotMatch(renderTaskPlanMapSVG(view), /data-plan-map-node=/);
});

test('Freeplane XML preserves multiline goal and title whitespace through attribute character references', () => {
  const source = state(); source.goal = 'First line\nSecond line\t& third\r\nFinal line'; source.steps[0].title = 'Inspect\nall inputs';
  const mm = exportTaskPlanMM(taskPlanView(source));
  assert.match(mm, /TEXT="First line&#10;Second line&#9;&amp; third&#13;&#10;Final line"/);
  assert.match(mm, /TEXT="Inspect&#10;all inputs"/); assert.doesNotMatch(mm, /TEXT="[^"<>]*[\r\n\t]/);
});
