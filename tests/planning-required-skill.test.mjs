import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAgentDeveloperInstructions } from '../lib/developer-instruction-budget.mjs';
import { defaultPlanInstructions } from '../lib/engine.mjs';
import { planningModuleXml, planningProgramXml, parsePlanningModuleXml } from '../public/planning-program-xml.mjs';
import { projectPlanningRequest } from '../public/planning-browser-model.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { planningModulePrompt } from '../lib/planning-browser-runtime.mjs';
import { planningModuleTemplate } from '../public/planning-browser-model.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('planning procedures have no packaged skill dependency or global delivery marker', () => {
  for (const version of [11,12,13,14]) for (const guarded of [true,false]) {
    const guidance=defaultPlanInstructions('detailed',version,'on',guarded);
    assert.doesNotMatch(guidance,/FIRST-PARTY BLACKICE PLANNING SKILL|SKILL.md|sha256=/);
    assert.match(guidance,/Planning|planning/);
  }
});

test('analytical module prompts retain operation-specific schema without generic skill injection', () => {
 const base={requestId:'request-1',nodeId:'node-1',nodeRevision:1,node:{kind:'plan',title:'Plan',prompt:'Inspect evidence'},template:planningModuleTemplate('plan'),sources:[],inputs:[],challenges:[],workflowNodeIds:[]};
 for(const kind of ['viability','inference','plan','think','respond']) {
  const prompt=planningModulePrompt({...base,node:{...base.node,kind},template:planningModuleTemplate(kind),cycleContext:{stageId:kind,cycleId:'cycle-1',prerequisites:[],children:[],acceptanceCriteria:[],effectReceipts:[]}});
  assert.doesNotMatch(prompt,/FIRST-PARTY BLACKICE PLANNING SKILL|blackice-planning:v/);
  assert.match(prompt,/This response worker cannot execute external tools/);
 }
});

test('selected module XML is reversible but cannot impersonate a different module, insert hidden markup, or skip required stages', () => {
  const node = {
    id: 'child-1', kind: 'inquiry', title: 'Disconfirm <routine> & frame',
    prompt: 'Inspect one\nobservable "source".', doneWhen: 'A concrete answer is recorded.', skipReason: ''
  };
  const xml = planningModuleXml(node);
  assert.match(xml, /&lt;routine&gt; &amp; frame/);
  assert.deepEqual(parsePlanningModuleXml(xml, { expectedId: node.id }), {
    id: node.id, patch: {
      kind: node.kind, title: node.title, prompt: node.prompt,
      doneWhen: node.doneWhen, skipReason: ''
    }
  });
  assert.throws(() => parsePlanningModuleXml(xml, { expectedId: 'other-id' }), /does not match/);
  assert.throws(() => parsePlanningModuleXml(xml.replace('</prompt>', '<!DOCTYPE x></prompt>')), /directives|malformed/);
  assert.throws(() => parsePlanningModuleXml(xml.replace('&amp;', '&external;')), /unsupported/);
  assert.throws(() => parsePlanningModuleXml(xml.replace('</module>', '<executed>true</executed></module>')), /unsupported fields/);
  assert.throws(() => parsePlanningModuleXml(planningModuleXml({ id: 'required', kind: 'plan', title: 'Plan', prompt: 'Plan', skipReason: 'skip' })), /cannot be skipped/);
  assert.throws(() => parsePlanningModuleXml(planningModuleXml({ id: 'action', kind: 'action', title: 'Do', prompt: 'Do', doneWhen: '' })), /completion check/);
});

test('program XML shows true numbered containment, including recorded skips, without fabricated completion', () => {
  const request = {
    id: 'req-one', revision: 3, objective: 'Perform the actual task.',
    nodes: [
      { id: 'root', parentId: null, kind: 'frame', title: 'Frame', prompt: 'Ask one question.' },
      { id: 'child', parentId: 'root', kind: 'action', title: 'Observe', prompt: 'Check the effect.', doneWhen: 'Effect observed.', skipReason: 'Not needed for the narrower goal.' },
      { id: 'later', parentId: null, kind: 'decision', title: 'Decide', prompt: 'Compare results.' }
    ], edges: [], responses: [], assignments: [], attempts: [], sources: []
  };
  const xml = planningProgramXml(request);
  assert.match(xml, /<module id="root" number="1"/);
  assert.match(xml, /<module id="child" number="1\.1"/);
  assert.match(xml, /<module id="later" number="2"/);
  assert.match(xml, /<skip-reason>Not needed/);
  assert.doesNotMatch(xml, /<executed>|<verified>|<completed>/);
});

test('a skipped optional module is settled for its parent, but never satisfies a real dependent operation', () => {
  const request = {
    id: 'req-check', objective: 'Check dependencies.', nodes: [
      { id: 'root', parentId: null, kind: 'frame', title: 'Parent', prompt: 'Frame outcome', revision: 1 },
      { id: 'optional', parentId: 'root', kind: 'inquiry', title: 'Optional check', prompt: 'Check optional source', skipReason: 'No longer material', revision: 1 },
      { id: 'dependent', parentId: null, kind: 'action', title: 'Dependent effect', prompt: 'Apply needed result', doneWhen: 'Actual effect checked', revision: 1 }
    ],
    edges: [{ id: 'requires-optional', kind: 'depends_on', from: 'dependent', to: 'optional' }],
    responses: [], assignments: [], attempts: [], sources: []
  };
  const view = projectPlanningRequest(request);
  const byId = Object.fromEntries(view.nodes.map(node => [node.id, node]));
  assert.equal(byId.optional.readiness.state, 'skipped');
  assert.equal(byId.root.readiness.unresolvedChildren.length, 0);
  assert.deepEqual(byId.dependent.readiness.blockedDependencies, ['optional']);
  assert.equal(view.summary.skipped, 1);
});

test('the durable store refuses running skipped actions or actions without a declared observable check', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-skill-gate-'));
  const store = new PlanningBrowserStore({ dataDir });
  await store.init();
  t.after(async () => { await store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = await store.create({ conversationId: 'skill-test', title: 'Atomic action test', objective: 'Verify an observable result.', cwd: dataDir });
  let state = await store.addNode(request.id, { id: 'action-1', kind: 'action', title: 'Check one action', prompt: 'Observe one result.' });
  let action = state.nodes.find(node => node.id === 'action-1');
  const begin = revision => store.runtimeWriter().beginAttempt(request.id, 'action-1', { expectedNodeRevision: revision, ownerId: 'skill-worker' });
  await assert.rejects(begin(action.revision), { code: 'PLANNING_COMPLETION_UNDEFINED' });

  state = await store.updateNode(request.id, 'action-1', { doneWhen: 'The actual result is inspected.', skipReason: 'No longer needed.' }, { expectedNodeRevision: action.revision });
  action = state.nodes.find(node => node.id === 'action-1');
  await assert.rejects(begin(action.revision), { code: 'PLANNING_MODULE_SKIPPED' });

  state = await store.updateNode(request.id, 'action-1', { skipReason: '' }, { expectedNodeRevision: action.revision });
  action = state.nodes.find(node => node.id === 'action-1');
  const result = await begin(action.revision);
  assert.equal(result.attempt.status, 'running');
  assert.equal(result.attempt.node.doneWhen, 'The actual result is inspected.');
  assert.equal(result.attempt.node.skipReason, undefined);
});
