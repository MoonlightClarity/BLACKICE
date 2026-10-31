import test from 'node:test';
import assert from 'node:assert/strict';
import {planningCycleStageContext, planningNodeSources, projectPlanningRequest} from '../public/planning-browser-model.mjs';
import {RESPONSE_CYCLE_STAGES, responseCycleTemplate} from '../public/response-cycle-model.mjs';

const copy = value => structuredClone(value);
const criterion = (id, description = 'Inspect the specified fixture record and report its actual contents.') => ({
  id, label: 'Requested fixture observation', description, verification: 'evidence'
});

function graph() {
  return {
    version: 1, id: 'workflow-ownership-fixture', conversationId: 'fixture-conversation',
    objective: 'Analyze the supplied synthetic premises and preserve each separately owned workflow.',
    provenance: {kind: 'human'}, nodes: [], edges: [], responses: [], assignments: [], attempts: [], sources: [],
    responseCycle: {cycles: [], limits: {}}
  };
}

function addCycle(request, id, {parent, runId, state = 'pending', required = true} = {}) {
  const stageNodeIds = Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage => [stage.id, id + '-' + stage.id]));
  const value = {
    id, title: 'Synthetic cycle ' + id, objective: 'Resolve the bounded question for ' + id + '.',
    parentCycleId: parent?.id || null, parentStageId: parent?.stageNodeIds.inference || null,
    stageNodeIds, depth: parent ? parent.depth + 1 : 0, key: id, required, state,
    acceptanceCriteria: [{id: id + '-answer', label: 'Bounded analytical answer',
      description: 'Explain the supported conclusion from the supplied synthetic premises.', verification: 'response'}],
    execution: {required: Boolean(runId), state: runId ? 'pending' : 'not_required'},
    ...(runId ? {linkedRunId: runId} : {})
  };
  request.responseCycle.cycles.push(value);
  request.nodes.push({id, parentId: value.parentStageId, kind: 'cycle', title: value.title, prompt: value.objective, revision: 1});
  for (const stage of RESPONSE_CYCLE_STAGES) request.nodes.push({
    id: stageNodeIds[stage.id], parentId: id, kind: stage.kind, title: stage.label,
    prompt: 'Give a bounded public finding from the synthetic premises.', revision: 1,
    cycleId: id, cycleStage: stage.id
  });
  return value;
}

function inference(request, cycle, key, acceptanceCriteria, {revision = 1, required = true} = {}) {
  const work = {
    key, title: 'Inspect a fixture record', objective: 'Obtain the requested fixture observation using the owning workflow.',
    reason: 'The analytical worker has no tool with which to obtain the missing observation.',
    required, executionTarget: 'workflow', sourceIds: ['request:' + request.id], acceptanceCriteria: copy(acceptanceCriteria)
  };
  const response = {
    id: cycle.id + '-inference-response-' + revision, nodeId: cycle.stageNodeIds.inference,
    kind: 'inference', revision, nodeRevision: 1, subproblems: [work], sources: [], values: {},
    provenance: {kind: 'fixture', at: '2026-10-31T00:00:00.000Z'}
  };
  request.responses.push(response);
  return {work, response};
}

function context(request, cycle) {
  return planningCycleStageContext(request, cycle.stageNodeIds.plan);
}

function completeAnalysis(request, cycle, {workflowRequests = [], transformCriteria} = {}) {
  for (const stage of RESPONSE_CYCLE_STAGES) {
    const template = responseCycleTemplate(stage.id), sourceId = 'request:' + request.id;
    const sources = planningNodeSources(request, cycle.stageNodeIds[stage.id]);
    const prior = RESPONSE_CYCLE_STAGES.slice(0, stage.order - 1).map(item =>
      request.responses.find(response => response.nodeId === cycle.stageNodeIds[item.id]));
    const assessedCriteria = request.responses.find(response => response.nodeId === cycle.stageNodeIds.plan)?.acceptanceCriteria || cycle.acceptanceCriteria;
    const body = {
      values: Object.fromEntries(template.fields.map(field =>
        [field.id, 'The supplied synthetic premises support a bounded analytical conclusion.'])),
      grounding: template.fields.filter(field => field.grounding === 'required').map(field => ({field: field.id, sourceId})),
      openQuestions: [], challengeResponses: []
    };
    if (stage.id === 'feasibility') body.requirements = [];
    else {
      Object.assign(body, {
        checks: stage.checks.map(check => ({
          id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported',
          sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [],
          note: 'The captured synthetic premises support this bounded assessment.'
        })), subproblems: [], childResults: []
      });
      if (stage.id === 'inference') body.inferences = [{
        id: 'supported-conclusion', claim: 'The supplied premises determine the bounded analytical conclusion.',
        basis: 'inferred', sourceIds: [sourceId], limitation: 'This result concerns only the synthetic premises.'
      }];
      if (stage.id === 'inference') body.subproblems = copy(workflowRequests);
      if (stage.id === 'plan') {
        const requiredCriteria = context(request, cycle).requiredAcceptanceCriteria;
        const plannedCriteria = transformCriteria ? transformCriteria(copy(requiredCriteria)) : copy(requiredCriteria);
        Object.assign(body, {
          acceptanceCriteria: plannedCriteria,
          steps: [{id: 'answer', label: 'Explain the bounded conclusion',
            description: 'Use the supplied premises to explain and check the analytical answer.',
            dependsOn: [], criterionIds: plannedCriteria.map(item => item.id), sourceIds: [sourceId]}]
        });
      }
      if (stage.id === 'think') body.criterionResults = assessedCriteria.map(item => ({
        criterionId: item.id, assessment: 'satisfied', sourceIds: [sourceId], receiptIds: [],
        rationale: 'The captured synthetic premises establish the requested analytical conclusion.'
      }));
      if (stage.id === 'respond') {
        body.values.answer = 'The supplied synthetic premises establish the bounded analytical conclusion.';
        body.coverage = assessedCriteria.map(item => ({
          criterionId: item.id, disposition: 'addressed', sourceIds: [sourceId],
          responseExcerpt: body.values.answer, limitation: ''
        }));
      }
    }
    request.responses.push({
      ...body, id: cycle.id + '-' + stage.id + '-completed-response', nodeId: cycle.stageNodeIds[stage.id],
      kind: stage.kind, revision: 1, nodeRevision: 1, sources,
      inputs: prior.map(response => ({nodeId: response.nodeId, responseId: response.id, responseRevision: response.revision})),
      provenance: {kind: 'fixture', at: '2026-10-31T00:00:00.000Z'}
    });
  }
  cycle.state = 'completed';
}

function criterionIdentityFixture(transformCriteria) {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  root.execution.state = 'completed';
  const required = criterion('required-observation');
  const work = {
    key: 'inspect-record', title: 'Inspect the required fixture record',
    objective: 'Read the required fixture record with the owning workflow.',
    reason: 'The requested observation is absent from the captured analytical sources.',
    required: true, executionTarget: 'workflow', sourceIds: ['request:' + request.id], acceptanceCriteria: [required]
  };
  completeAnalysis(request, root, {workflowRequests: [work], transformCriteria});
  const view = projectPlanningRequest(request);
  return {request, root, required, work, plan: view.nodes.find(node => node.id === root.stageNodeIds.plan)};
}

test('a required workflow criterion preserves its complete declared identity in the Plan', () => {
  assert.equal(criterionIdentityFixture().plan.readiness.cycle.analysisReady, true,
    'the exact declared workflow criterion forms a usable Plan');
  const changes = [
    value => ({...value, label: 'A different label for the pending observation'}),
    value => ({...value, accuracy: {
      mode: 'exact', tolerance: '0 units', decisionThreshold: 'Every fixture value is exact.',
      evidenceNeeded: 'The captured fixture record.', consequence: 'A different value changes the answer.',
      unknownPolicy: 'block', stopWhen: 'The exact fixture observation has been recorded.'
    }})
  ];
  for (const change of changes) {
    const f = criterionIdentityFixture(items => items.map(item => item.id === 'required-observation' ? change(item) : item));
    assert.equal(f.plan.readiness.cycle.analysisReady, false,
      'a changed criterion cannot pass Plan and later fail the exact handoff comparison');
    assert.match(f.plan.readiness.cycle.issues.join(' '), /criterion|workflow|preserve/i);
    const saved = f.request.responses.find(response => response.nodeId === f.root.stageNodeIds.inference);
    assert.deepEqual(saved.subproblems[0].acceptanceCriteria, [f.required],
      'validation does not rewrite the original declared criterion');
  }
});

test('an unadopted optional workflow criterion cannot capture an unrelated Plan criterion by ID', () => {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  root.execution.state = 'completed';
  const optional = addCycle(request, 'optional', {parent: root, required: false});
  inference(request, optional, 'optional-work', [
    criterion(root.acceptanceCriteria[0].id, 'Read a different optional fixture record using workflow tools.')
  ]);
  completeAnalysis(request, root);
  const scope = context(request, root), view = projectPlanningRequest(request);
  assert.equal(scope.workflowRequests[0].requiredForPlan, false);
  assert.deepEqual(scope.requiredAcceptanceCriteria, root.acceptanceCriteria);
  const think = view.nodes.find(node => node.id === root.stageNodeIds.think);
  const respond = view.nodes.find(node => node.id === root.stageNodeIds.respond);
  assert.equal(think.readiness.cycle.analysisReady, true,
    'an unadopted different definition cannot demand tool evidence for the analytical answer');
  assert.equal(respond.readiness.cycle.analysisReady, true);
  assert.equal(respond.readiness.cycle.outcome, 'satisfied');
});

test('an explicitly adopted optional workflow criterion still needs operational evidence', () => {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  root.execution.state = 'completed';
  const optional = addCycle(request, 'optional', {parent: root, required: false});
  const proposed = inference(request, optional, 'optional-work', [criterion('optional-observation')]);
  completeAnalysis(request, root, {
    transformCriteria: items => [...items, ...copy(proposed.work.acceptanceCriteria)]
  });
  const view = projectPlanningRequest(request);
  const plan = view.nodes.find(node => node.id === root.stageNodeIds.plan);
  const think = view.nodes.find(node => node.id === root.stageNodeIds.think);
  assert.equal(plan.readiness.cycle.analysisReady, true, 'the optional criterion was explicitly adopted in a usable Plan');
  assert.equal(think.readiness.cycle.analysisReady, false,
    'adoption does not turn the proposed observation into a completed operation');
  assert.match(think.readiness.cycle.issues.join(' '), /workflow criterion.*operational evidence/i);
});

const stateOf = (view, cycle) => view.cycles.find(item => item.id === cycle.id).state;

test('workflow obligations and exact provenance follow the nearest operational owner', () => {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  const child = addCycle(request, 'child', {parent: root}), grandchild = addCycle(request, 'grandchild', {parent: child});
  const optional = addCycle(request, 'optional', {parent: root, required: false});
  const separate = addCycle(request, 'separate', {parent: child, runId: 'fixture-run-b'});
  const separateChild = addCycle(request, 'separate-child', {parent: separate});
  const rootWork = inference(request, root, 'root-work', [criterion('root-observation')]);
  const childWork = inference(request, child, 'child-work', [criterion('child-observation')]);
  const grandchildWork = inference(request, grandchild, 'grandchild-work', [criterion('grandchild-observation')]);
  inference(request, optional, 'optional-work', [criterion('optional-observation')]);
  const separateWork = inference(request, separate, 'separate-work', [criterion('root-observation', 'Inspect a different record for the separately owned workflow.')]);
  const separateChildWork = inference(request, separateChild, 'separate-child-work', [criterion('separate-child-observation')]);
  const before = copy(request), rootContext = context(request, root);

  assert.deepEqual(rootContext.workflowRequests.map(item => item.key).sort(),
    ['child-work', 'grandchild-work', 'optional-work', 'root-work']);
  assert.deepEqual(rootContext.requiredAcceptanceCriteria, [
    ...root.acceptanceCriteria, ...rootWork.work.acceptanceCriteria,
    ...childWork.work.acceptanceCriteria, ...grandchildWork.work.acceptanceCriteria
  ]);
  assert.deepEqual(rootContext.workflowCriterionConflicts, [], 'a separate owner cannot introduce a conflicting criterion');
  assert.equal(rootContext.workflowRequests.find(item => item.key === 'optional-work').requiredForPlan, false);
  const collected = rootContext.workflowRequests.find(item => item.key === 'grandchild-work');
  assert.deepEqual(collected.origin, {
    cycleId: grandchild.id, nodeId: grandchild.stageNodeIds.inference,
    responseId: grandchildWork.response.id, responseRevision: 1, key: grandchildWork.work.key
  });
  assert.equal(collected.sourceId, 'response:' + grandchildWork.response.id);
  assert.deepEqual(collected.acceptanceCriteria, grandchildWork.work.acceptanceCriteria);
  assert.equal(context(request, grandchild).workflowOwner.cycleId, root.id);

  const separateContext = context(request, separate);
  assert.equal(separateContext.workflowOwner.cycleId, separate.id);
  assert.equal(separateContext.workflowOwner.runId, 'fixture-run-b');
  assert.deepEqual(separateContext.workflowRequests.map(item => item.key).sort(), ['separate-child-work', 'separate-work']);
  assert.deepEqual(separateContext.requiredAcceptanceCriteria, [
    ...separate.acceptanceCriteria, ...separateWork.work.acceptanceCriteria, ...separateChildWork.work.acceptanceCriteria
  ]);
  assert.equal(context(request, separateChild).workflowOwner.cycleId, separate.id);
  assert.deepEqual(request, before, 'deriving requirements does not rewrite saved responses or cycles');
});

test('only current Inference obligations propagate, with exact conflicts and detached public records', () => {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  const child = addCycle(request, 'child', {parent: root});
  inference(request, child, 'superseded-work', [criterion('old-observation')]);
  const current = inference(request, child, 'current-work', [criterion('current-observation')], {revision: 2});
  const selected = context(request, root);
  assert.deepEqual(selected.workflowRequests.map(item => item.key), ['current-work']);
  assert.deepEqual(selected.requiredAcceptanceCriteria, [...root.acceptanceCriteria, ...current.work.acceptanceCriteria]);
  assert.equal(selected.workflowRequests[0].origin.responseId, current.response.id);
  assert.equal(selected.workflowRequests[0].origin.responseRevision, 2);
  selected.workflowRequests[0].acceptanceCriteria[0].description = 'Mutation of a returned view.';
  selected.requiredAcceptanceCriteria[1].description = 'Another returned-view mutation.';
  assert.equal(current.response.subproblems[0].acceptanceCriteria[0].description,
    'Inspect the specified fixture record and report its actual contents.');

  const conflict = inference(request, root, 'root-conflict',
    [criterion('current-observation', 'This definition conflicts with the current child obligation.')]);
  const conflicted = context(request, root);
  assert.deepEqual(conflicted.workflowCriterionConflicts, ['current-observation']);
  assert.deepEqual(conflicted.requiredAcceptanceCriteria, [...root.acceptanceCriteria, ...conflict.work.acceptanceCriteria],
    'conflicting definitions are held under their original ID, never silently renamed');
});

function cancellationGraph() {
  const request = graph(), root = addCycle(request, 'root', {runId: 'fixture-run-a'});
  const child = addCycle(request, 'child', {parent: root}), grandchild = addCycle(request, 'grandchild', {parent: child});
  const optional = addCycle(request, 'optional', {parent: root, required: false});
  const completed = addCycle(request, 'completed', {parent: root});
  const separate = addCycle(request, 'separate', {parent: root, runId: 'fixture-run-b'});
  const separateChild = addCycle(request, 'separate-child', {parent: separate});
  const separateCompleted = addCycle(request, 'separate-completed', {parent: separate});
  const unrelated = addCycle(request, 'unrelated', {runId: 'fixture-run-c'});
  completeAnalysis(request, completed);
  completeAnalysis(request, separateCompleted);
  const initial = projectPlanningRequest(request);
  assert.equal(stateOf(initial, completed), 'completed', 'same-owner completed fixture has valid checked responses');
  assert.equal(stateOf(initial, separateCompleted), 'completed', 'separate completed fixture has valid checked responses');
  return {request, root, child, grandchild, optional, completed, separate, separateChild, separateCompleted, unrelated};
}

test('cancelled-owner read projection stops at a separate operational run and preserves completed analysis', () => {
  const f = cancellationGraph();
  f.root.state = 'cancelled'; f.root.execution.state = 'cancelled'; f.root.summary = 'The first synthetic workflow was stopped.';
  const saved = copy(f.request), view = projectPlanningRequest(f.request);
  for (const cycle of [f.root, f.child, f.grandchild, f.optional]) assert.equal(stateOf(view, cycle), 'cancelled', cycle.id);
  for (const cycle of [f.separate, f.separateChild, f.unrelated]) assert.equal(stateOf(view, cycle), 'pending', cycle.id);
  for (const cycle of [f.completed, f.separateCompleted]) assert.equal(stateOf(view, cycle), 'completed', cycle.id);
  assert.deepEqual(f.request, saved, 'historical read projection never rewrites descendant records');
  assert.equal(f.child.state, 'pending', 'inherited cancellation is a view, not fabricated saved child evidence');
  assert.equal(view.cycles.find(item => item.id === f.separate.id).linkedRunId, 'fixture-run-b');
});

test('cancelling a nested operational owner affects only its own unfinished analysis', () => {
  const f = cancellationGraph();
  f.separate.state = 'cancelled'; f.separate.execution.state = 'cancelled';
  const view = projectPlanningRequest(f.request);
  for (const cycle of [f.separate, f.separateChild]) assert.equal(stateOf(view, cycle), 'cancelled', cycle.id);
  for (const cycle of [f.root, f.child, f.grandchild, f.optional, f.unrelated]) assert.equal(stateOf(view, cycle), 'pending', cycle.id);
  for (const cycle of [f.completed, f.separateCompleted]) assert.equal(stateOf(view, cycle), 'completed', cycle.id);
});

test('new-attempt workflow criterion validation rejects changes while ignoring object-key order', async () => {
  const {validatePlanningModuleResponse} = await import('../lib/planning-browser-runtime.mjs');
  const {planningResponseBody} = await import('../public/planning-browser-model.mjs');
  const f = criterionIdentityFixture(), body = planningResponseBody(f.plan.response);
  const attempt = {
    node: {kind: 'plan'}, sources: f.plan.response.sources, challenges: [], workflowNodeIds: [],
    cycleContext: context(f.request, f.root)
  };
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, body));
  const accuracy = {
    mode: 'exact', tolerance: '0 units', decisionThreshold: 'Every fixture value is exact.',
    evidenceNeeded: 'The captured fixture record.', consequence: 'A different value changes the answer.',
    unknownPolicy: 'block', stopWhen: 'The exact fixture observation has been recorded.'
  };
  for (const change of [
    value => ({...value, label: 'A changed workflow observation label'}),
    value => ({...value, accuracy: copy(accuracy)})
  ]) {
    const altered = copy(body);
    altered.acceptanceCriteria = altered.acceptanceCriteria.map(item =>
      item.id === f.required.id ? change(item) : item);
    assert.throws(() => validatePlanningModuleResponse(attempt, altered),
      error => error.code === 'PLANNING_RESPONSE_FORMAT' &&
        error.issues.some(issue => issue.path.startsWith('response.acceptanceCriteria')),
      'a changed contract enters the existing bounded structured-response repair');
  }

  const exactAttempt = copy(attempt), exactBody = copy(body);
  exactAttempt.cycleContext.workflowRequests[0].acceptanceCriteria[0].accuracy = copy(accuracy);
  exactAttempt.cycleContext.requiredAcceptanceCriteria.find(item => item.id === f.required.id).accuracy = copy(accuracy);
  exactBody.acceptanceCriteria.find(item => item.id === f.required.id).accuracy = copy(accuracy);
  const reorder = value => Array.isArray(value) ? value.map(reorder) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()
      .map(([key, item]) => [key, reorder(item)])) : value;
  const accepted = validatePlanningModuleResponse(reorder(exactAttempt), reorder(exactBody));
  assert.deepEqual(accepted.acceptanceCriteria.find(item => item.id === f.required.id),
    {...f.required, accuracy}, 'recursive object-key ordering does not alter semantic criterion identity');
  const changedAccuracy = copy(exactBody);
  changedAccuracy.acceptanceCriteria.find(item => item.id === f.required.id).accuracy.tolerance = '1 unit';
  assert.throws(() => validatePlanningModuleResponse(exactAttempt, changedAccuracy),
    {code: 'PLANNING_RESPONSE_FORMAT'}, 'a real accuracy change is still rejected');
});
