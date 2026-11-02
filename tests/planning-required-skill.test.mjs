import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PLANNING_SKILL_CONTENT, PLANNING_SKILL_SHA256, PLANNING_SKILL_VERSION, planningSkillInstructions, validatePlanningSkill } from '../lib/planning-skill.mjs';
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

test('Planning On loads the same mandatory first-party skill in both guarded and unguarded instructions', () => {
  assert.equal(PLANNING_SKILL_VERSION, 3);
  assert.equal(createHash('sha256').update(PLANNING_SKILL_CONTENT).digest('hex'), PLANNING_SKILL_SHA256);
  for (const phrase of ['Defamiliarize', 'observable', 'ELIF', 'Return to Planning', 'skip', 'opportunity']) {
    assert.match(PLANNING_SKILL_CONTENT.toLowerCase(), new RegExp(phrase.toLowerCase()));
  }
  assert.match(planningSkillInstructions('on'), /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL v3/);
  assert.match(planningSkillInstructions('maximal'), /mandatory for this turn/);
  assert.equal(planningSkillInstructions('off'), '');
  for (const guarded of [true, false]) {
    const result = defaultPlanInstructions('detailed', 12, 'on', guarded);
    assert.match(result, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL v3/);
    assert.equal(result.split(PLANNING_SKILL_CONTENT).length, 2, 'the complete packaged skill is delivered exactly once');
    assert.ok(result.includes('END REQUIRED BLACKICE PLANNING SKILL v3 sha256=' + PLANNING_SKILL_SHA256));
    assert.match(result, /## 6\. Run the plan/);
    assert.doesNotMatch(result, /TASK PLANNING MODE: OFF/);
  }
  assert.doesNotMatch(defaultPlanInstructions('detailed', 12, 'off', false), /FIRST-PARTY BLACKICE PLANNING SKILL/);
  assert.doesNotMatch(defaultPlanInstructions('detailed', 12, 'off', true), /FIRST-PARTY BLACKICE PLANNING SKILL/);
});

test('all Planning-tab workers receive the complete mandatory skill with no-tool boundaries', () => {
  const base = {
    requestId: 'request-1', nodeId: 'node-1', nodeRevision: 1,
    node: { kind: 'plan', title: 'Plan stage', prompt: 'Decompose a measurable action.' },
    template: planningModuleTemplate('plan'), sources: [], inputs: [],
    challenges: [], workflowNodeIds: []
  };
  for (const kind of ['viability', 'inference', 'plan', 'think', 'respond']) {
    const cycle = planningModulePrompt({ ...base, node: { ...base.node, kind }, template: planningModuleTemplate(kind), cycleContext: { stageId: kind, cycleId: 'cycle-1', prerequisites: [], children: [], acceptanceCriteria: [], effectReceipts: [] } });
    assert.equal(cycle.split(PLANNING_SKILL_CONTENT).length, 2);
    assert.match(cycle, /This response worker cannot execute external tools/);
  }
  const independent = planningModulePrompt({ ...base, node: { ...base.node, kind: 'frame' }, template: planningModuleTemplate('frame') });
  assert.ok(independent.includes(PLANNING_SKILL_CONTENT));
  assert.match(independent, /This response worker cannot execute external tools/);
});

test('BLACKICE validates its own versioned contract and rejects incomplete or incompatible packaged skills', () => {
  const descriptor = validatePlanningSkill(PLANNING_SKILL_CONTENT);
  assert.equal(descriptor.id, 'blackice-planning');
  assert.equal(descriptor.version, 3);
  assert.equal(descriptor.appliesWhen, 'planning_mode_on');
  assert.equal(descriptor.sha256, PLANNING_SKILL_SHA256);
  assert.equal(descriptor.content, PLANNING_SKILL_CONTENT);
  const invalid = [
    PLANNING_SKILL_CONTENT.replace('version: 3', 'version: 1'),
    PLANNING_SKILL_CONTENT.replace('applies_when: planning_mode_on', 'applies_when: all_runs'),
    PLANNING_SKILL_CONTENT.replace('name: blackice-planning', 'name: blackice-planning\nname: blackice-planning'),
    PLANNING_SKILL_CONTENT.replace(/description: [^\n]+/, 'description: '),
    PLANNING_SKILL_CONTENT.replace('## 6. Run the plan', '## Run the plan'),
    PLANNING_SKILL_CONTENT.replace('<!-- blackice-planning:v3:complete -->', ''),
    PLANNING_SKILL_CONTENT + '\nUnversioned instruction after the completeness marker.',
    PLANNING_SKILL_CONTENT + 'x'.repeat(32768)
  ];
  for (const source of invalid) assert.throws(() => validatePlanningSkill(source), { code: 'PLANNING_SKILL_MISSING' });
  const crlf = PLANNING_SKILL_CONTENT.replace(/\r?\n/g, '\r\n');
  assert.equal(validatePlanningSkill(crlf).content, crlf, 'delivery/hash bind exact packaged bytes without newline normalization');
  assert.equal(validatePlanningSkill(crlf).sha256, createHash('sha256').update(crlf).digest('hex'));
});

test('instruction assembly preserves every skill byte and fails closed instead of truncating under an explicit budget', () => {
  const section = planningSkillInstructions('on');
  const parts = { core: 'CORE\n', capabilities: 'CATALOG\n', planning: section, worker: '\nWORKER', analysis: '\n' + 'source-context '.repeat(12000) };
  const assembled = composeAgentDeveloperInstructions(parts);
  assert.equal(assembled.instructions, parts.core + parts.capabilities + section + parts.worker + parts.analysis);
  assert.equal(assembled.promptSupplement, '');
  assert.equal(assembled.limit, null);
  assert.throws(() => composeAgentDeveloperInstructions({ ...parts, limit: section.length - 1 }), { code: 'DEVELOPER_INSTRUCTION_LIMIT_EXCEEDED' });
  assert.throws(() => planningSkillInstructions('unknown'), TypeError);
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
