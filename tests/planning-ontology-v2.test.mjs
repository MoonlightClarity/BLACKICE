import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlanningWorkspace } from '../public/next/workspaces/planning.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
const root = new URL('../', import.meta.url);
const module = async path => import(new URL(path, root).href);
const visual = await module('public/next/workspaces/planning-visual.mjs');
const ontology = await module('public/planning-ontology.mjs');
const process = await module('lib/process-ontology.mjs');
const { ProjectStore } = await module('lib/projects.mjs');

const header = [
  '# Intelligence Assessment',
  'Format: BLACKICE-INTEL/1',
  'Title: Source-based assessment',
  'Decision: Whether to act on the reported event',
  'PIR: Which of two possible explanations best matches the source?',
  'Scope: An observed report',
  'Product: A bounded assessment with explicit gaps',
  'Working folder: ' + fileURLToPath(root),
  '',
].join('\n');

test('new analytical and technical types are in the saved method vocabulary', () => {
  for (const id of ['analytic_question','hypothesis_test','evidence_evaluation','analytic_judgment',
    'technical_method','technical_operation','technical_verification'])
    assert.ok(process.BUILTIN_STEP_TYPES.some(entry => entry.id === id), id);
});

test('starter text saves without executing six fixed intelligence stages', () => {
  const draft = visual.intelligenceStarterText({
    title: 'Test question', decision: 'What decision to inform',
    pir: 'What does the actual evidence support?', cwd: 'C:\\Users\\iris\\Documents'
  });
  const parsed = visual.parseIntelligenceText(draft, { requireBrief: true });
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.entities.some(node => /^DRAFT/.test(node.title)));
  const project = visual.intelligenceProjectFromText(draft);
  assert.deepEqual(project.tasks.map(task => task.id), ['intel-core-inquiry']);
  assert.equal(project.tasks[0].status, undefined);
  assert.ok(project.context.includes('## Technical Methods'));
  assert.ok(project.context.includes('## Analysis'));
});

test('explicit ontology relationships create one technical collection action and a separate analytical action', () => {
  const source = header + [
    '## Requirements',
    '- [REQ-1] Explain the signal in the user-provided report',
    '## Hypotheses',
    '- [HYP-1] First explanation',
    '  Answers: REQ-1',
    '- [HYP-2] Serious alternative explanation',
    '  Answers: REQ-1',
    '## Collection',
    '- [COL-1] Extract source statements relevant to the disputed claim',
    '  Answers: REQ-1',
    '  Tests: HYP-1, HYP-2',
    '  Source: User-provided report',
    '## Analysis',
    '- [ANL-1] Compare the alternatives against the recorded statements',
    '  Tests: HYP-1, HYP-2',
    '  Requires: COL-1',
    '  Based on: EVD-1',
    '## Technical Methods',
    '- [TEC-1] Use the local file reader to extract the relevant passages',
    '  Implements: COL-1',
    '  Used for: ANL-1',
    '  Tool: File reader',
    '  Procedure: Read the exact saved text with line references',
    '  Verify: Compare extracted text against original',
    '## Evidence',
    '- [EVD-1] A directly observed statement from the report',
    '  Obtained via: TEC-1',
    '  Supports: HYP-1',
    '## Judgments',
    '- [JDG-1] Judgment requires a discriminating comparison',
    '  Based on: EVD-1',
    '  Analysis: ANL-1',
    ''
  ].join('\n');
  const parsed = visual.parseIntelligenceText(source,{requireBrief:true});
  assert.deepEqual(parsed.errors, []);
  for(const relation of ['examines','implements','used_for','obtained_via','reasoned_by','requires_collection'])
    assert.ok(parsed.edges.some(edge => edge.kind === relation), relation);
  const output = visual.intelligenceProjectFromText(source);
  const validated = ProjectStore.prototype.definition.call({}, output);
  assert.equal(validated.tasks.length, 3);
  assert.equal(validated.tasks[0].stepType, 'collect');
  assert.equal(validated.tasks[1].stepType, 'analysis');
  assert.deepEqual(output.tasks.map(task => task.id), ['intel-col-1','intel-anl-1','intel-jdg-1']);
  assert.deepEqual(output.tasks[1].dependsOn,['intel-col-1']);
  assert.deepEqual(output.tasks[2].dependsOn,['intel-anl-1']);
  assert.equal(output.tasks[2].stepType, 'analysis');
  assert.match(output.tasks[2].instructions, /not.*certify|not.*established|not.*judgment/i);
  assert.match(output.tasks[0].instructions,/TEC-1: Use the local file reader/);
  assert.match(output.tasks[1].instructions,/Compare the alternatives/);
  assert.ok(output.tasks.every(task => task.status === undefined && !task.evidence));
  const geometry = visual.intelligenceMapGeometry(parsed, {availableWidth:950});
  assert.equal(geometry.groups.length,7);
  assert.ok(geometry.colWidth >= 175);
});

test('an invalid referenced technical method is never silently accepted',()=>{
  const input = header + '## Collection\n- [COL-1] Find source\n## Evidence\n- [EVD-1] Example\n  Obtained via: TEC-ABSENT\n';
  const parsed = visual.parseIntelligenceText(input,{requireBrief:true});
  assert.equal(parsed.valid,false);
  assert.match(parsed.errors.map(x=>x.message).join('|'),/references missing TEC-ABSENT/);
  assert.throws(()=>visual.intelligenceProjectFromText(input));
});


test('a text-authored analytical project survives a real isolated save and reload', async()=>{
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'blackice-ontology-test-'));
  const work = join(dir, 'work');
  let store;
  try {
    await mkdir(work);
    const source = visual.intelligenceStarterText({
      title:'Saved ontology', decision:'Assess whether a hypothesis is supportable',
      pir:'What does the verified source actually establish?', cwd:work
    });
    const definition = visual.intelligenceProjectFromText(source);
    const fakeEngine = { startRun: async()=>{throw Error('Saving must never run an agent');}, listRuns:()=>[], on(){}, off(){} };
    store = new ProjectStore({ dataDir:dir, engine:fakeEngine, isPaused:()=>true });
    await store.init();
    const saved = await store.create(definition);
    assert.equal(saved.status, 'draft');
    assert.deepEqual(saved.tasks.map(t=>t.id), ['intel-core-inquiry']);
    assert.equal(saved.tasks[0].status, 'pending');
    assert.ok(saved.context.includes('## Technical Methods'));
    const reloaded = store.get(saved.id);
    assert.equal(reloaded.context, definition.context);
    assert.deepEqual(reloaded.tasks[0].acceptanceCriteria, definition.tasks[0].acceptanceCriteria);
  } finally {
    if(store) await store.close();
    await rm(dir, {recursive:true,force:true});
  }
});

test('standalone technical work and unfinished analytical judgment remain distinct',()=>{
  const source = header + '## Technical Methods\n- [TEC-1] Inspect input file format\n  Tool: Local file reader\n';
  const output = visual.intelligenceProjectFromText(source);
  assert.deepEqual(output.tasks.map(task=>task.id),['intel-tec-1','intel-core-inquiry']);
  assert.equal(output.tasks[0].stepType,'technical_method');
  assert.equal(output.tasks[1].stepType,'analysis');
  const projected=ontology.projectPlanningOntology({steps:[
    {id:'tech', title:'Read a file', kind:'action', stepType:'technical_operation',status:'done',
     evidence:'A tool returned bytes', artifactIds:['file1'],dependsOn:[]},
    {id:'analysis',title:'Interpret the file',kind:'action',stepType:'analytic_judgment',status:'pending',dependsOn:['tech']},
    {id:'old',title:'Legacy work',kind:'action',status:'pending',dependsOn:[]},
  ]});
  assert.equal(projected.lanes.technical[0].status,'done');
  assert.equal(projected.lanes.analytical[0].status,'pending');
  assert.equal(projected.lanes.unclassified.length,1);
  assert.ok(projected.edges.some(edge=>edge.kind==='depends_on' && edge.from==='analysis' && edge.to==='tech'));
  assert.ok(!projected.edges.some(edge=>edge.kind==='supports'));
});

function releasePlan() {
  const local = 'workspace:c:/release', portal = 'origin:https://registry.test';
  const goal = 'Review and release a package';
  return { taskId: 'release-plan', revision: 3, goal, steps: [],
    contract: { contractVersion: 2, planEpoch: 1, goal, instructions: [],
      workItems: [
        { id: 'test', title: 'Check the release tests', objective: 'Read the test report.', owner: 'agent', resourceKeys: [local], effects: ['observe'], dependsOn: [], criterionIds: ['assessment'] },
        { id: 'release', title: 'Release the package', objective: 'Prepare and publish the reviewed package.', owner: 'agent', resourceKeys: [local, portal], effects: ['observe', 'commit'], dependsOn: ['test'], criterionIds: ['receipt'], operationScopes: [
          { effect: 'observe', resourceKeys: [local, portal] }, { effect: 'commit', resourceKeys: [portal], confirmationCriterionId: 'receipt' },
        ] },
      ],
      criteria: [
        { id: 'assessment', kind: 'judgment', label: 'Tests support a release', description: 'Check the reviewed test results.', resourceKey: local },
        { id: 'receipt', kind: 'external-confirmation', label: 'Registry receipt', description: 'Find one confirmation from the registry.', resourceKey: portal, receiptBinding: { format: 'json', confirmedValues: ['published'], status: 'INTERNAL_SELECTOR' } },
      ] },
    contractRuntime: { version: 1, planEpoch: 1, workItems: [{ id: 'test', status: 'satisfied' }, { id: 'release', status: 'running', unresolvedCount: 1 }],
      criteria: [{ id: 'assessment', satisfied: true, observedCount: 1, evidenceIds: ['PRIVATE_RECORD_ID'] }, { id: 'receipt', satisfied: false, observedCount: 0 }],
      operations: [{ workItemId: 'release', success: true, effectState: 'unconfirmed', rawResult: 'PRIVATE_RESULT' }],
    },
  };
}

test('canonical ontology separates scoped permissions, checked criteria and confirmed outcomes', () => {
  const saved = releasePlan(), before = structuredClone(saved);
  const view = ontology.projectPlanningOntology(saved);
  assert.equal(view.kind, 'canonical');
  assert.equal(view.runtimeCurrent, true);
  assert.deepEqual(view.nodes.map(node => [node.id, node.status, node.scoped]), [['test', 'satisfied', false], ['release', 'running', true]]);
  assert.deepEqual(view.nodes[1].permissions.map(row => [row.effect, row.resources, row.confirmationCriterionId]), [
    ['observe', ['c:/release', 'https://registry.test'], null], ['commit', ['https://registry.test'], 'receipt'],
  ]);
  assert.deepEqual(view.edges, [
    { kind: 'checks', from: 'test', to: 'assessment' }, { kind: 'depends_on', from: 'release', to: 'test' },
    { kind: 'checks', from: 'release', to: 'receipt' },
  ]);
  assert.deepEqual(view.criteria.map(row => [row.satisfied, row.observedCount, row.evidenceCount]), [[true, 1, 1], [false, 0, 0]]);
  assert.match(view.criteria[1].receipt, /confirmation in the destination’s reply/);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|INTERNAL_SELECTOR/);
  assert.deepEqual(saved, before);

  saved.contract.planEpoch++;
  const revised = ontology.projectPlanningOntology(saved);
  assert.equal(revised.runtimeCurrent, false);
  assert.ok(revised.nodes.every(row => row.status === 'pending' && row.unresolvedCount === 0));
  assert.ok(revised.criteria.every(row => !row.satisfied && row.observedCount === 0));
});

test('current Planning displays canonical work and evidence without adding edit controls', async t => {
  const dom = planningDOM(t), saved = releasePlan(), calls = [];
  const prototype = Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype, 'type', { get() { return this.getAttribute('type'); }, set(value) { this.setAttribute('type', value); }, configurable: true });
  prototype.replaceChildren = function (...nodes) { for (const child of [...this.children]) child.remove(); this.rawText = ''; this.append(...nodes); };
  const ui = createPlanningWorkspace({ mount: dom.mount, events: { subscribe: () => () => {} }, api: async (route, method = 'GET') => {
    calls.push(method);
    if (route.startsWith('/api/planning?')) return { plans: [{ taskId: saved.taskId, goal: saved.goal, revision: saved.revision, bucket: 'active' }] };
    if (route === '/api/tasks/release-plan') return structuredClone(saved);
    throw Error('Unexpected route ' + route);
  } });
  t.after(() => ui.destroy());
  dom.$('#next-planning-type').value = 'conversation';
  ui.enter();
  await new Promise(resolve => setImmediate(resolve));
  const summary = dom.$('.next-plan-ontology');
  assert.ok(summary?.open);
  assert.match(summary.textContent, /Work, permissions, and evidence/);
  assert.match(summary.textContent, /Depends on Check the release tests/);
  assert.match(summary.textContent, /Make the final change on https:\/\/registry\.test · Confirmation needs Registry receipt/);
  assert.match(summary.textContent, /Registry receiptPending evidence/);
  assert.match(summary.textContent, /0 of 1 new confirmations/);
  assert.match(summary.textContent, /One action still needs an effect check/);
  assert.equal(summary.querySelectorAll('button, input, select, textarea').length, 0);
  assert.doesNotMatch(dom.mount.textContent, /no steps yet/);
  assert.ok(calls.every(method => method === 'GET'));
});

test('Planning final CSS neutralizes prototype blue and wraps long analytical text', () => {
  const css = readFileSync(new URL('../public/next/planning-ontology.css',import.meta.url),'utf8');
  assert.match(css, /\.next-planning-workspace\s*\{/);
  assert.match(css, /background:#22272e/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /\.next-intel-node-caption/);
});
