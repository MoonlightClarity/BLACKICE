import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanningBrowser } from '../public/next/workspaces/planning-browser.mjs';
import { PLANNING_MODULE_TEMPLATES, planningModuleTemplate, planningRequestSources, projectPlanningRequest } from '../public/planning-browser-model.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const copy = value => structuredClone(value);
const waitFor = async read => { const deadline = Date.now() + 4000; while (Date.now() < deadline) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 4)); } throw Error('Planning UI did not settle.'); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const request = (id, conversationId, child = false) => ({
  id, conversationId, title: 'Synthetic ' + id, objective: 'Compare synthetic options before selecting work.', revision: 1,
  nodes: [{ id: 'frame', kind: 'frame', title: 'Define the actual outcome', prompt: 'Expose the assumptions and alternative framing.', parentId: null, revision: 1 }, ...(child ? [{ id: 'child', kind: 'decision', title: 'Choose the next useful check', prompt: 'Compare opportunity costs and a reversal condition.', parentId: 'frame', revision: 1 }] : [])],
  edges: [], sources: [], responses: [], assignments: [], attempts: [], history: []
});

async function fixture(t, { hook, empty = false, status = {}, initialNodeId = 'frame' } = {}) {
  const dom = planningDOM(t), prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  prototype.replaceChildren = function (...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.rawText = ''; this.markup = ''; this.append(...children); };
  const documents = new Map([['request-a', request('request-a', 'conversation-a', true)], ['request-b', request('request-b', 'conversation-a')], ['request-c', request('request-c', 'conversation-c')]]);
  if (empty) documents.clear();
  const calls = [], listeners = new Set(), navigation = [], legacyCalls = [];
  let serial = 0;
  const api = async (route, method = 'GET', body) => {
    const call = { route, method, body: copy(body) }; calls.push(call);
    if (hook) { const result = await hook(call, documents); if (result !== undefined) return result; }
    if (route === '/api/planning-browser' && method === 'GET') return { conversations: empty ? [] : [{ id: 'conversation-a', title: 'Synthetic first conversation', state: 'active' }, { id: 'conversation-c', title: 'Synthetic archive', state: 'archived' }], requests: [...documents.values()].map(row => ({ id: row.id, title: row.title, conversationId: row.conversationId, revision: row.revision })), templates: PLANNING_MODULE_TEMPLATES };
    if (route === '/api/planning-browser/requests' && method === 'POST') { const saved = request('created-' + (++serial), body.conversationId || 'planning_generated'); saved.title = body.title; saved.objective = body.objective; saved.nodes = []; documents.set(saved.id, saved); return projectPlanningRequest(saved); }
    const parts = route.split('/'), id = parts[4], document = documents.get(id);
    assert.ok(document, 'Only known fake requests are read or changed.');
    if (parts.length === 5 && method === 'GET') return projectPlanningRequest(document);
    const node = document.nodes.find(value => value.id === parts[6]);
    if (method === 'PATCH') { assert.equal(body.expectedNodeRevision, node.revision); Object.assign(node, { title: body.title ?? node.title, prompt: body.prompt ?? node.prompt, revision: node.revision + 1 }); }
    else if (parts[5] === 'nodes' && parts.length === 6 && method === 'POST') { const parent = document.nodes.find(value => value.id === body.parentId); if (parent) assert.equal(body.expectedParentRevision, parent.revision); document.nodes.push({ id: 'new-' + (++serial), parentId: body.parentId || null, kind: body.kind, title: body.title, prompt: body.prompt, revision: 1 }); }
    else if (parts[7] === 'responses') {
      assert.equal(body.expectedNodeRevision, node.revision); assert.equal(body.provenance, undefined); assert.equal(body.clientRequestId, undefined);
      const response = { id: 'human-' + (++serial), nodeId: node.id, nodeRevision: node.revision, revision: document.responses.filter(value => value.nodeId === node.id).length + 1, values: body.values, grounding: body.grounding, openQuestions: body.openQuestions, challengeResponses: body.challengeResponses, inputs: [], sources: planningRequestSources(document), provenance: { kind: 'human', at: '2026-10-30T12:00:00Z', contentHash: 'synthetic' } };
      document.responses.push(response);
    } else if (parts[7] === 'run') {
      assert.equal(body.expectedNodeRevision, node.revision); document.attempts.push({ id: 'attempt-' + (++serial), nodeId: node.id, status: 'running', model: 'configured-model', effort: 'high' });
    } else if (parts[7] === 'cancel') { assert.deepEqual(Object.keys(body), ['attemptId']); const attempt = document.attempts.find(value => value.id === body.attemptId); assert.ok(attempt); attempt.status = 'cancelled'; attempt.message = 'Stopped from the Planning workspace.'; }
    else if (parts[5] === 'edges') { assert.equal(body.expectedNodeRevision, document.nodes.find(value => value.id === body.from).revision); document.edges.push({ id: 'edge-' + (++serial), kind: body.kind, from: body.from, to: body.to, ...(body.sourceField ? { sourceField: body.sourceField } : {}), ...(body.freshness ? { freshness: body.freshness } : {}) }); }
    else if (parts[5] === 'sources') document.sources.push({ id: 'source:' + (++serial), kind: 'user_provided', title: body.title, text: body.text, provenance: { kind: 'user_provided', assurance: 'unverified' } });
    else throw Error('Unexpected fake route: ' + method + ' ' + route);
    document.revision++; return projectPlanningRequest(document);
  };
  const workspace = createPlanningBrowser({ mount: dom.mount, api, events: { subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); } }, onNavigate: (...args) => navigation.push(args), getStatus: () => ({ cwd: 'C:\\synthetic', ...status }), createLegacy: () => { legacyCalls.push('created'); return { enter() { legacyCalls.push('enter'); }, leave() { legacyCalls.push('leave'); }, destroy() { legacyCalls.push('destroy'); } }; } });
  t.after(() => workspace.destroy()); workspace.enter(); await waitFor(() => empty ? calls.length && dom.$('.pb-empty') : dom.$('[data-selected-node-id="' + initialNodeId + '"]'));
  return { ...dom, api, workspace, documents, calls, navigation, legacyCalls, listeners,
    mutations: () => calls.filter(call => call.method !== 'GET'),
    async selectRequest(id) { await dom.click('[data-request-id="' + id + '"]'); await waitFor(() => dom.$('[data-request-id="' + id + '"]')?.getAttribute('aria-selected') === 'true' && dom.$('[data-selected-node-id="frame"]')); },
    async fillResponse(kind = 'frame', prefix = 'Synthetic answer') { for (const field of planningModuleTemplate(kind).fields) { await dom.input('[data-response-field="' + field.id + '"]', prefix + ': ' + field.label); const source = dom.$('[data-grounding-field="' + field.id + '"]'); if (source) { source.value = 'request:' + dom.$('[role="tab"][aria-selected="true"]').dataset.requestId; await source.dispatch('change'); } } },
    async submitResponse() { await dom.$('[data-action="save-response"]').closest('form').dispatch('submit'); },
    async refresh() { await dom.click('[data-action="refresh"]'); await new Promise(resolve => setTimeout(resolve, 10)); },
    async emit(id) { for (const callback of listeners) callback({ type: 'planning.browser.updated', data: { requestId: id } }); await new Promise(resolve => setTimeout(resolve, 190)); }
  };
}

test('the planning browser opens read-only, recursively selects the same module in Outline and Graph, and exposes required questions', async t => {
  const f = await fixture(t);
  assert.equal(f.mutations().length, 0); assert.equal(f.legacyCalls.length, 0);
  assert.match(f.mount.textContent, /Required questions/); assert.match(f.mount.textContent, /Alternative framing/);
  assert.equal(f.$('[data-disclosure-key="definition-editor"]').open, false, 'Prompt editing does not push required questions below the working area.');
  assert.ok(f.$('.pb-run-actions [data-action="run-module"]'));
  f.documents.get('request-a').assignments.push({ nodeId: 'child', ownerId: 'worker-mapping', label: 'Mapping analyst · assigned only', scope: 'node' }); f.documents.get('request-a').revision++;
  await f.refresh(); assert.match(f.$('[data-node-id="child"]').textContent, /Mapping analyst · assigned only/);
  assert.equal(f.$('[data-node-id="child"]').getAttribute('aria-level'), '2');
  await f.click('[data-node-id="child"]'); assert.ok(f.$('[data-selected-node-id="child"]')); assert.match(f.mount.textContent, /Opportunity cost/);
  await f.click('[data-view="graph"]'); assert.equal(f.$('[data-node-id="child"]').getAttribute('aria-selected'), 'true');
  assert.match(f.$('[data-node-id="child"]').textContent, /Mapping analyst · assigned only/);
  assert.equal(f.mount.querySelectorAll('.pb-graph-edge[data-kind="contains"]').length, 1, 'A projected relation is rendered once.');
  await f.click('[data-view="outline"]'); assert.equal(f.$('[data-node-id="child"]').getAttribute('aria-selected'), 'true');
  await f.key(f.$('[data-node-id="child"]'), 'ArrowLeft'); assert.ok(f.$('[data-selected-node-id="frame"]'));
  await f.click('[data-toggle-node="frame"]'); assert.equal(f.$('[data-node-id="child"]'), null);
  assert.equal(f.mutations().length, 0, 'Selection, collapse, graph layout, and keyboard navigation are read-only.');
});

test('request tabs preserve independent same-ID node drafts and human response submission uses only the selected node revision', async t => {
  const f = await fixture(t);
  await f.fillResponse('frame', 'First request');
  f.$('[data-disclosure-key="source-editor"]').open = true; await f.input('[data-field-key="request-a:source:title"]', 'Source draft on first request');
  await f.selectRequest('request-b'); await f.input('[data-response-field="objective"]', 'Second request draft');
  await f.selectRequest('request-a'); assert.match(f.$('[data-response-field="objective"]').value, /^First request/);
  assert.equal(f.$('[data-disclosure-key="source-editor"]').open, true); assert.equal(f.$('[data-field-key="request-a:source:title"]').value, 'Source draft on first request');
  await f.submitResponse(); await waitFor(() => f.documents.get('request-a').responses.length === 1);
  const call = f.mutations().at(-1); assert.equal(call.route, '/api/planning-browser/requests/request-a/nodes/frame/responses'); assert.equal(call.body.expectedNodeRevision, 1); assert.equal(call.body.expectedRevision, undefined); assert.equal(call.body.provenance, undefined);
  assert.equal(f.documents.get('request-b').responses.length, 0);
  await f.selectRequest('request-b'); assert.equal(f.$('[data-response-field="objective"]').value, 'Second request draft');
  assert.equal(f.calls.filter(call => call.route.endsWith('/run')).length, 0);
});

test('stale response and open child details start collapsed with a readable count and keep required inputs outside the disclosure', async t => {
  const f = await fixture(t), document = f.documents.get('request-a'), node = document.nodes[0];
  node.revision = 7;
  document.responses.push({ id: 'older-frame-response', nodeId: node.id, nodeRevision: 6, revision: 1,
    values: Object.fromEntries(planningModuleTemplate('frame').fields.map(field => [field.id, 'Recorded answer: ' + field.label])),
    grounding: planningModuleTemplate('frame').fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:request-a' })),
    openQuestions: [], challengeResponses: [], inputs: [], sources: planningRequestSources(document), provenance: { kind: 'human', at: '2026-10-30T12:00:00Z' } });
  document.revision++; await f.refresh();
  const inspector = f.$('.pb-inspector'), attention = f.$('[data-disclosure-key="readiness-details"]');
  assert.equal(attention.open, false, 'Detailed readiness warnings do not occupy the working area until explicitly expanded.');
  assert.match(attention.querySelector('summary').textContent, /Why this response needs attention · 2 items/);
  assert.match(inspector.querySelector('.pb-status').textContent, /stale/);
  assert.match(attention.textContent, /This response uses module revision 6; the module is now at revision 7\./);
  assert.match(attention.textContent, /Unresolved child modules.*Choose the next useful check/s);
  assert.doesNotMatch(attention.textContent, /module_revision|"expected"|"current"|\{\s*"/);
  assert.equal(inspector.querySelectorAll('.pb-note[data-tone="warning"]').length, 0);
  assert.equal(f.$('[data-response-field="objective"]').closest('details'), null, 'The first required input remains directly available.');
  attention.open = true; await f.click('[data-view="graph"]');
  assert.equal(f.$('[data-disclosure-key="readiness-details"]').open, true, 'An explicit expansion survives a view change.');
  assert.equal(f.mutations().length, 0);
});

test('a fresh worker revision preserves a local draft, reports its conflict, and requires explicit rebase before saving', async t => {
  const f = await fixture(t); await f.fillResponse('frame', 'Preserved draft');
  const live = f.documents.get('request-a'); live.nodes[0].revision = 2; live.nodes[0].prompt = 'A newer saved prompt'; live.revision = 2;
  await f.refresh(); await waitFor(() => f.mount.textContent.includes('changed while you were editing'));
  assert.match(f.$('[data-response-field="objective"]').value, /^Preserved draft/); assert.equal(f.$('[data-action="save-response"]').disabled, true);
  const keep = f.mount.querySelectorAll('button').find(button => button.textContent === 'Keep draft on this revision'); await f.click(keep); await f.submitResponse();
  await waitFor(() => f.documents.get('request-a').responses.length === 1); assert.equal(f.mutations().at(-1).body.expectedNodeRevision, 2);
  assert.equal(f.documents.get('request-a').nodes[0].prompt, 'A newer saved prompt', 'Saving a response never overwrites the saved prompt.');
});

test('only explicit run clicks launch workers; concurrent requests stay independent and cancellation names the actual attempt', async t => {
  const gate = deferred(); let hold = true;
  const f = await fixture(t, { hook: async call => { if (hold && call.route === '/api/planning-browser/requests/request-a/nodes/frame/run') { hold = false; await gate.promise; } } });
  assert.equal(f.mutations().length, 0);
  await f.click('[data-action="run-module"]'); await waitFor(() => f.$('[data-action="run-module"]').disabled);
  await f.selectRequest('request-b'); assert.equal(f.$('[data-action="run-module"]').disabled, false);
  await f.click('[data-action="run-module"]'); await waitFor(() => f.documents.get('request-b').attempts.length === 1);
  assert.match(f.mount.textContent, /Runtime: running/); assert.match(f.mount.textContent, /configured-model/);
  gate.resolve(); await waitFor(() => f.documents.get('request-a').attempts.length === 1);
  assert.ok(f.$('[data-request-id="request-b"][aria-selected="true"]'), 'A late receipt does not switch the selected request.');
  assert.equal(f.$('[data-action="run-module"]').disabled, true);
  await f.click('[data-action="cancel-worker"]'); await waitFor(() => f.documents.get('request-b').attempts[0].status === 'cancelled');
  assert.equal(f.documents.get('request-a').attempts[0].status, 'running');
  assert.equal(f.calls.filter(call => call.route.endsWith('/run')).length, 2);
  assert.deepEqual(f.mutations().at(-1).body, { attemptId: f.documents.get('request-b').attempts[0].id });
});

test('new response identity refreshes a clean form without a prompt revision and preserves an overlapping human draft', async t => {
  const f = await fixture(t), document = f.documents.get('request-a'), node = document.nodes[0];
  const record = (id, prefix) => {
    const values = Object.fromEntries(planningModuleTemplate('frame').fields.map(field => [field.id, prefix + ': ' + field.label]));
    document.responses.push({ id, nodeId: node.id, nodeRevision: node.revision, revision: document.responses.length + 1, values, grounding: planningModuleTemplate('frame').fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:request-a' })), openQuestions: [], challengeResponses: [], inputs: [], sources: planningRequestSources(document), provenance: { kind: 'runtime', model: 'configured-model', runId: 'synthetic-run', at: '2026-10-30T12:00:00Z' } }); document.revision++;
  };
  record('model-one', 'First model answer'); await f.refresh(); await waitFor(() => f.$('[data-response-field="objective"]').value.startsWith('First model answer'));
  assert.equal(node.revision, 1); assert.match(f.mount.textContent, /Model response/);
  await f.input('[data-response-field="objective"]', 'Human answer being drafted');
  record('model-two', 'Later model answer'); await f.refresh(); await waitFor(() => f.mount.textContent.includes('changed while you were editing'));
  assert.equal(f.$('[data-response-field="objective"]').value, 'Human answer being drafted'); assert.equal(f.$('[data-action="save-response"]').disabled, true);
  assert.equal(f.mutations().length, 0, 'Receiving model output is a read and never silently saves a draft.');
});

test('nested module creation is an explicit parent-revision edit and legacy plans load only when opened', async t => {
  const f = await fixture(t), expand = f.mount.querySelectorAll('button').find(button => button.textContent === '+ Expand into a child module');
  await f.click(expand); await f.input('#pb-node-title', 'A further consequential question'); await f.input('#pb-node-prompt', 'What observation would reverse this choice?');
  assert.equal(f.mutations().length, 0);
  await f.$('[data-action="create-node"]').closest('form').dispatch('submit'); await waitFor(() => f.documents.get('request-a').nodes.length === 3);
  const create = f.mutations().at(-1); assert.equal(create.body.parentId, 'frame'); assert.equal(create.body.expectedParentRevision, 1); assert.equal(create.body.expectedRevision, undefined);
  assert.equal(f.calls.filter(call => call.route.endsWith('/run')).length, 0);
  await f.click(f.mount.querySelectorAll('button').find(button => button.textContent === 'Legacy plans')); assert.deepEqual(f.legacyCalls, ['created', 'enter']);
  await f.click(f.mount.querySelectorAll('button').find(button => button.textContent === 'Planning browser')); assert.ok(f.legacyCalls.includes('leave'));
});

test('direct ChatGPT contributions display external origin and their recorded job without claiming a human or Luna runtime response', async t => {
  const f = await fixture(t), document = f.documents.get('request-a');
  const values = Object.fromEntries(planningModuleTemplate('frame').fields.map(field => [field.id, 'Synthetic direct contribution']));
  document.responses.push({ id: 'direct-response', nodeId: 'frame', nodeRevision: 1, revision: 1, values, grounding: [], inputs: [], sources: [], openQuestions: [], challengeResponses: [], provenance: { kind: 'external_agent', author: 'synthetic-connection', receipt: { connectionId: 'synthetic-connection', jobId: 'synthetic-direct-job', requestId: 'synthetic-direct-request', tool: 'blackice_planning_graph_write' } } }); document.revision++;
  await f.refresh(); await waitFor(() => f.$('[data-response-id="direct-response"]'));
  const stamp = f.$('[data-response-id="direct-response"]'); assert.match(stamp.textContent, /External agent response/); assert.doesNotMatch(stamp.textContent, /Human response|Model response/);
  assert.match(f.$('[data-disclosure-key="provenance:direct-response"]').textContent, /synthetic-direct-job/); assert.equal(f.mutations().length, 0);
});

test('opening an archived conversation preserves the request grouping and never invents a model result', async t => {
  const f = await fixture(t); await f.click('[data-conversation-id="conversation-c"]'); await waitFor(() => f.$('[data-request-id="request-c"]') && f.$('[data-selected-node-id="frame"]'));
  assert.equal(f.$('[data-request-id="request-a"]'), null); assert.match(f.mount.textContent, /Synthetic archive/);
  assert.equal(f.$('[data-response-field="objective"]').value, ''); assert.equal(f.mutations().length, 0);
  f.workspace.leave(); f.workspace.enter(); await waitFor(() => f.$('[data-request-id="request-c"][aria-selected="true"]'));
  assert.equal(f.mutations().length, 0);
});

test('a first independent request selects the actual conversation group created by the server without starting work', async t => {
  const f = await fixture(t, { empty: true }); await f.click('[data-action="new-request"]');
  await f.input('#pb-request-title', 'Synthetic independent request'); await f.input('#pb-request-objective', 'Inspect a general question before choosing an action.');
  await f.$('[data-action="create-request"]').closest('form').dispatch('submit');
  await waitFor(() => f.$('[data-conversation-id="planning_generated"][aria-current="true"]'));
  assert.ok(f.$('[data-request-id="created-1"][aria-selected="true"]'));
  assert.equal(f.mutations().length, 1); assert.equal(f.mutations()[0].route, '/api/planning-browser/requests');
});

test('catalog corruption warnings retain readable requests and identify damaged records without starting recovery work', async t => {
  const f = await fixture(t, { hook: (call, documents) => call.route === '/api/planning-browser' ? { conversations: [{ id: 'conversation-a', title: 'Readable synthetic conversation', state: 'active' }], requests: [...documents.values()].map(row => ({ id: row.id, conversationId: row.conversationId, title: row.title, revision: row.revision })), templates: PLANNING_MODULE_TEMPLATES, errors: [{ id: 'damaged-fixture', message: 'Malformed saved graph' }] } : undefined });
  assert.match(f.$('.pb-notice').textContent, /damaged-fixture: Malformed saved graph/); assert.match(f.$('.pb-notice').textContent, /Available requests remain visible/);
  assert.ok(f.$('[data-node-id="frame"]')); assert.ok(f.$('[data-request-id="request-b"]')); assert.equal(f.mutations().length, 0);
});

test('module run labels follow configured model changes without starting or overriding a worker', async t => {
  const status = { defaultModel: 'provider-default', runtimeSettings: { defaultModel: 'chosen-routing-model' } };
  const f = await fixture(t, { status });
  assert.equal(f.$('[data-action="run-module"]').textContent, 'Run module with chosen-routing-model');
  status.runtimeSettings.defaultModel = 'default'; status.defaultModel = 'new-provider-default';
  f.workspace.updateStatus();
  assert.equal(f.$('[data-action="run-module"]').textContent, 'Run module with new-provider-default');
  status.defaultModel = 'default'; f.workspace.updateStatus();
  assert.equal(f.$('[data-action="run-module"]').textContent, 'Run module with configured model');
  assert.equal(f.mutations().length, 0);
});

test('nested module numbers remain scoped to their request in Outline and Graph', async t => {
  const f = await fixture(t), document = f.documents.get('request-a');
  document.nodes.push({ id: 'grandchild', kind: 'inquiry', title: 'Discriminating check', prompt: 'Which observation changes the choice?', parentId: 'child', revision: 1 });
  document.revision++; await f.refresh();
  const number = id => f.$('[data-node-id="' + id + '"] .pb-module-number')?.textContent.trim();
  assert.equal(number('frame'), '1'); assert.equal(number('child'), '1.1'); assert.equal(number('grandchild'), '1.1.1');
  await f.click('[data-view="graph"]');
  assert.equal(number('grandchild'), '1.1.1');
  await f.selectRequest('request-b'); assert.equal(number('frame'), '1'); assert.equal(number('grandchild'), undefined);
  await f.selectRequest('request-a'); assert.equal(number('grandchild'), '1.1.1');
  assert.equal(f.mutations().length, 0);
});

test('saved failed and cancelled attempts show their reason and actual provider metadata without a false Chat link', async t => {
  const f = await fixture(t), document = f.documents.get('request-a');
  const attempt = { id: 'actual-attempt', nodeId: 'frame', status: 'failed', model: 'requested-routing-model',
    message: 'The provider rejected the structured response schema.',
    metadata: { runId: 'module-run-actual', threadId: 'provider-thread-actual', turnId: 'provider-turn-actual', model: 'actual-provider-model', provider: 'actual-provider' } };
  document.attempts.push(attempt); document.revision++; await f.refresh();
  assert.match(f.$('.pb-worker').textContent, /Model: actual-provider-model/);
  assert.equal(f.$('.pb-worker-message').textContent, attempt.message);
  assert.match(f.$('.pb-attempt-provenance').textContent, /Module run: module-run-actual/);
  assert.match(f.$('.pb-attempt-provenance').textContent, /Thread: provider-thread-actual/);
  assert.match(f.$('.pb-attempt-provenance').textContent, /Turn: provider-turn-actual/);
  assert.equal(f.mount.querySelectorAll('button').some(button => button.textContent === 'Open run'), false);
  attempt.status = 'cancelled'; attempt.message = 'Stopped from the Planning workspace.'; document.revision++;
  await f.refresh(); assert.equal(f.$('.pb-worker-message').textContent, attempt.message);
  await f.selectRequest('request-b'); assert.equal(f.$('.pb-worker-message'), null);
  assert.equal(f.navigation.length, 0); assert.equal(f.mutations().length, 0);
});

function viabilityGraph(document, { state = 'awaiting_input', responseId = 'viability-response-1', pendingIntent = { id: 'authorized-original' }, scope = 'request' } = {}) {
  const graph = projectPlanningRequest(document), node = graph.nodes[0];
  graph.viability = { scope, scopeId: document.conversationId, nodeId: node.id, ...(pendingIntent ? { pendingIntent } : {}) };
  node.response = { ...(node.response || {}), id: responseId, values: {}, grounding: [{ field: 'objective', sourceId: 'request:' + document.id }], openQuestions: [], challengeResponses: [] };
  node.readiness.viability = { state, blockingFacts: state === 'awaiting_input' ? [{ id: 'address', label: 'Delivery address', question: 'Which address should this use?', consequence: 'The requested edit needs your actual address.' }] : [], preferences: [{ id: 'color', label: 'Preferred color' }] };
  return graph;
}

test('viability answers preserve their request draft and resume only through the authoritative answer result', async t => {
  let state = 'awaiting_input';
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') return viabilityGraph(documents.get('request-a'), { state });
    if (call.route === '/api/planning-browser/requests/request-a/viability/answer') {
      state = 'ready'; const document = documents.get('request-a'); document.revision++; document.nodes[0].revision++;
      return { ...viabilityGraph(document, { state, responseId: 'viability-response-2' }), viabilityAction: { resumedRunId: 'original-conversation-run' } };
    }
  } });
  assert.equal(f.$('[data-action="answer-viability"]').textContent, 'Answer and continue');
  assert.match(f.$('.pb-viability').textContent, /These preferences do not block the work/);
  await f.input('[data-viability-requirement="address"]', '123 Example Street');
  await f.selectRequest('request-b'); assert.equal(f.$('.pb-viability'), null);
  await f.selectRequest('request-a'); assert.equal(f.$('[data-viability-requirement="address"]').value, '123 Example Street');
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');
  await waitFor(() => f.$('.pb-viability')?.dataset.viabilityState === 'ready');
  const call = f.mutations().at(-1);
  assert.equal(call.route, '/api/planning-browser/requests/request-a/viability/answer');
  assert.equal(call.body.requirementId, 'address'); assert.equal(call.body.answer, '123 Example Street');
  assert.equal(call.body.expectedNodeRevision, 1); assert.equal(call.body.expectedResponseId, 'viability-response-1');
  assert.ok(call.body.clientRequestId);
  assert.match(f.$('.pb-notice').textContent, /original conversation resumed/);
  assert.equal(f.calls.filter(call => call.route.endsWith('/run')).length, 0);
  assert.equal(f.documents.get('request-b').revision, 1);
});

test('an uncertain viability answer retry keeps its exact client receipt and does not create an enable or run call', async t => {
  let submissions = 0;
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') return viabilityGraph(documents.get('request-a'), { pendingIntent: null, scope: 'deployment' });
    if (call.route.endsWith('/viability/answer')) {
      if (++submissions === 1) throw Error('Connection ended before the saved answer receipt arrived.');
      return viabilityGraph(documents.get('request-a'), { state: 'ready', responseId: 'viability-response-2', pendingIntent: null, scope: 'deployment' });
    }
  } });
  assert.equal(f.$('[data-action="answer-viability"]').textContent, 'Save answer');
  await f.input('[data-viability-requirement="address"]', '123 Example Street');
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');
  await waitFor(() => f.$('.pb-notice').textContent.includes('saved answer receipt'));
  assert.equal(f.$('[data-viability-requirement="address"]').value, '123 Example Street');
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');
  await waitFor(() => f.$('.pb-viability')?.dataset.viabilityState === 'ready');
  const writes = f.mutations(); assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  assert.equal(f.calls.filter(call => /enabled|\/run$/.test(call.route)).length, 0);
});

test('a changed viability response preserves the typed answer and blocks stale submission until its current question is reviewed', async t => {
  let responseId = 'viability-response-1';
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') return viabilityGraph(documents.get('request-a'), { responseId, pendingIntent: null });
    if (call.route.endsWith('/viability/answer')) return viabilityGraph(documents.get('request-a'), { state: 'ready', responseId: 'viability-response-3', pendingIntent: null });
  } });
  await f.input('[data-viability-requirement="address"]', '123 Example Street');
  const document = f.documents.get('request-a'); document.revision++; document.nodes[0].revision++; responseId = 'viability-response-2';
  await f.refresh();
  assert.equal(f.$('[data-viability-requirement="address"]').value, '123 Example Street');
  assert.equal(f.$('[data-action="answer-viability"]').disabled, true);
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');
  assert.equal(f.mutations().length, 0);
  await f.click('[data-action="adopt-viability-revision"]');
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');
  await waitFor(() => f.mutations().length === 1);
  assert.equal(f.mutations()[0].body.expectedNodeRevision, 2);
  assert.equal(f.mutations()[0].body.expectedResponseId, 'viability-response-2');
});

test('Open conversation requires an actual catalog conversation and navigates its persisted run identity', async t => {
  const groupId = 'opaque-shared-group', savedRunId = 'persisted-chat-run';
  let source = 'planning', runId = 'unrelated-looking-run';
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route !== '/api/planning-browser') return;
    documents.get('request-a').conversationId = groupId;
    return { conversations: [{ id: groupId, title: 'Shared planning group', source, ...(runId ? { runId } : {}) }], requests: [...documents.values()].map(row => ({ id: row.id, title: row.title, conversationId: row.conversationId, revision: row.revision })), templates: PLANNING_MODULE_TEMPLATES };
  } });
  const open = () => f.mount.querySelectorAll('button').find(button => button.textContent === 'Open conversation');
  assert.equal(open(), undefined, 'A planning-only group is not a Chat conversation, even if it carries a run-looking string.');
  source = 'conversation'; runId = null; await f.refresh();
  assert.equal(open(), undefined, 'A group without a persisted run is not navigable.');
  runId = savedRunId; await f.refresh();
  assert.ok(open()); await f.click(open());
  assert.deepEqual(f.navigation, [['chat', { conversationId: savedRunId }]]);
  source = 'planning'; await f.refresh(); assert.equal(open(), undefined);
  assert.equal(f.mutations().length, 0);
});

test('viability source recovery and stale checks do not ask factual questions and preserve an existing answer draft', async t => {
  let mode = 'recovery';
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route !== '/api/planning-browser/requests/request-a' || call.method !== 'GET') return;
    const graph = viabilityGraph(documents.get('request-a')), node = graph.nodes[0];
    if (mode === 'recovery') {
      graph.viability.recoveryIssue = { code: 'TASK_VIABILITY_SOURCE_INCOMPLETE', message: 'Inspect the scanned attachment before deciding whether the address is missing.' };
      delete node.readiness.viability;
    } else if (mode === 'unchecked') {
      node.readiness.viability.state = 'needs_evidence';
      node.readiness.viability.issues = ['Inspect the captured sources before treating this essential fact as missing.'];
    } else if (mode === 'stale') node.readiness.viability.state = 'stale';
    return graph;
  } });
  assert.equal(f.$('.pb-viability').dataset.viabilityState, 'needs_evidence');
  assert.match(f.$('.pb-viability').textContent, /Inspect the scanned attachment/);
  assert.equal(f.$('[data-action="answer-viability"]'), null);
  assert.doesNotMatch(f.$('.pb-viability').textContent, /Which address should this use/);
  mode = 'unchecked'; await f.refresh();
  assert.match(f.$('.pb-viability-issues').textContent, /Inspect the captured sources/);
  assert.equal(f.$('[data-action="answer-viability"]'), null);
  mode = 'awaiting_input'; await f.refresh();
  await f.input('[data-viability-requirement="address"]', '123 Example Street');
  mode = 'stale'; await f.refresh();
  assert.equal(f.$('[data-action="answer-viability"]'), null);
  mode = 'awaiting_input'; await f.refresh();
  assert.equal(f.$('[data-viability-requirement="address"]').value, '123 Example Street');
  assert.equal(f.mutations().length, 0);
});

test('typed viability findings use factual answers or complete checks instead of a generic partial response save', async t => {
  const f = await fixture(t, { hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') return viabilityGraph(documents.get('request-a'));
  } });
  const save = f.$('[data-action="save-response"]'), form = save.closest('form');
  assert.equal(save.disabled, true);
  assert.ok(form.querySelectorAll('textarea').length);
  assert.ok(form.querySelectorAll('textarea').every(control => control.readOnly));
  assert.ok(form.querySelectorAll('select').every(control => control.disabled));
  assert.equal(f.$('[data-action="answer-viability"]').disabled, false);
  assert.match(f.$('.pb-inspector').textContent, /Use the factual Answer controls above/);
  await form.dispatch('submit');
  assert.equal(f.mutations().length, 0);
  await f.selectRequest('request-b');
  assert.equal(f.$('[data-action="save-response"]').disabled, false);
});

const cycleIds={cycle:'cycle_opaque_61b5',feasibility:'stage_opaque_a1',inference:'stage_opaque_a2',plan:'stage_opaque_a3',think:'stage_opaque_a4',respond:'stage_opaque_a5'};
function cycleGraph(document,{state='paused_after_plan',planRevision=7,responseId='opaque_plan_response_1',child=false}={}){
  const graph=projectPlanningRequest(document),kinds=['viability','inference','plan','think','respond'],stages=['feasibility','inference','plan','think','respond'];
  graph.revision=11+planRevision-7;
  const container={id:cycleIds.cycle,kind:'cycle',title:'Prepare an evidence-based report',prompt:'Establish the report through five connected stages.',parentId:null,revision:2,readiness:{state:'empty'}};
  const nodes=stages.map((stage,index)=>({id:cycleIds[stage],kind:kinds[index],title:['Check source availability','Interpret the evidence','Design the report work','Evaluate the findings','Deliver the supported report'][index],prompt:'Make the '+stage+' contribution inspectable.',parentId:container.id,revision:stage==='plan'?planRevision:1,readiness:{state:index<3?'ready':'empty'},...(index<3?{response:{id:'opaque_response_'+stage,revision:1,values:Object.fromEntries(planningModuleTemplate(kinds[index]).fields.map(field=>[field.id,'Recorded '+field.label.toLowerCase()+'.'])),grounding:[],openQuestions:[],challengeResponses:[]}}:{})}));
  const plan=nodes[2];plan.response={...plan.response,id:responseId,acceptanceCriteria:[{id:'criterion_opaque_1',label:'Supported report',description:'The report cites the supplied evidence.',verification:'evidence'}],steps:[{id:'step_opaque_1',label:'Inspect source records',description:'Read the available original records.',dependsOn:[],criterionIds:['criterion_opaque_1'],sourceIds:['source_opaque_1']},{id:'step_opaque_2',label:'Draft the report',description:'Write the supported result.',dependsOn:[],criterionIds:['criterion_opaque_1'],sourceIds:[]}],checks:[{id:'outcome_covered',assessment:'supported',sourceIds:['source_opaque_1'],note:'The report criterion is assigned to the proposed work.'}],subproblems:[],childResults:[]};
  graph.nodes=[container,...nodes];graph.edges=[];graph.sources=[{id:'source_opaque_1',title:'Supplied research notes',kind:'source',text:'Observed source material.'},{id:'source_opaque_2',title:'Prior user correction',kind:'user_input',text:'Use the corrected location.'}];
  graph.cycles=[{id:container.id,title:container.title,objective:'Produce a report grounded in the original sources.',stageNodeIds:Object.fromEntries(stages.map(stage=>[stage,cycleIds[stage]])),depth:0,planningExecutionMode:'plan_only',state,planRevision,planResponseId:responseId,summary:'The proposed work is ready for inspection.'}];
  if(child){const nested={...container,id:'child_cycle_opaque',parentId:cycleIds.inference,title:'Resolve a conflicting source'};graph.nodes.push(nested);graph.cycles.push({...graph.cycles[0],id:nested.id,title:nested.title,parentCycleId:container.id,parentStageId:cycleIds.inference,depth:1,state:'pending',stageNodeIds:{}});}
  return graph;
}
const visibleText=node=>node.hidden?'':node.tagName==='DETAILS'&&!node.open?visibleText(node.children.find(child=>child.tagName==='SUMMARY')||{children:[],rawText:''}):(node.rawText||'')+(node.children||[]).map(visibleText).join(' ');

test('recursive cycles expose ordered stage work, named findings and refinement at every stage without running on read',async t=>{
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET'?cycleGraph(documents.get('request-a'),{child:true}):undefined});
  assert.deepEqual(f.$('.pb-cycle-stages').children.map(item=>item.dataset.cycleStage),['feasibility','inference','plan','think','respond']);
  assert.match(f.$('.pb-cycle-controls').textContent,/3 of 5 stages have a recorded response/);
  assert.match(f.$('.pb-cycle-controls').textContent,/Plan ready · paused/);
  assert.doesNotMatch(visibleText(f.mount),/cycle_opaque|stage_opaque|opaque_plan_response|source_opaque|criterion_opaque|step_opaque/);
  assert.match(visibleText(f.mount),/Supplied research notes|Inspect source records/);
  for(const stage of ['feasibility','inference','plan','think','respond']){
    await f.click('[data-node-id="'+cycleIds[stage]+'"]');
    assert.ok(f.mount.querySelectorAll('button').find(button=>button.textContent==='+ Refine with a child cycle'));
  }
  assert.equal(f.mutations().length,0);
});

test('Plan edits preserve typed findings and save separately from exact-revision Continue',async t=>{
  let planRevision=7,responseId='opaque_plan_response_1',cycleState='paused_after_plan';
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    const doc=documents.get('request-a');
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return cycleGraph(doc,{planRevision,responseId,state:cycleState});
    if(call.route.endsWith('/'+cycleIds.cycle+'/plan')){planRevision++;responseId='opaque_plan_response_2';return cycleGraph(doc,{planRevision,responseId,state:cycleState});}
    if(call.route.endsWith('/'+cycleIds.cycle+'/continue')){cycleState='running';return cycleGraph(doc,{planRevision,responseId,state:cycleState});}
  }});
  const form=f.$('[data-cycle-plan-form="'+cycleIds.cycle+'"]');
  await f.input('[data-field-key="cycle-plan:'+cycleIds.cycle+':values:approach"]','Inspect both sources before drafting.');
  assert.equal(f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled,true);
  const second=form.querySelector('[data-plan-step="step_opaque_2"]');
  const dependencies=second.querySelectorAll('details').find(detail=>detail.querySelector('summary').textContent==='Depends on');
  const dependency=dependencies.querySelector('input');dependency.checked=true;await dependency.dispatch('change');
  const sourceChoice=second.querySelectorAll('details').find(detail=>detail.querySelector('summary').textContent==='Recorded sources');
  for(const check of sourceChoice.querySelectorAll('input')){check.checked=true;await check.dispatch('change');}
  assert.equal(f.mutations().length,0);
  await form.dispatch('submit');await waitFor(()=>f.mutations().length===1&&f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled===false);
  const save=f.mutations()[0];assert.equal(save.body.expectedRequestRevision,11);assert.equal(save.body.expectedCycleRevision,2);assert.equal(save.body.expectedPlanRevision,7);assert.equal(save.body.expectedPlanResponseId,'opaque_plan_response_1');
  assert.equal(save.body.plan.values.approach,'Inspect both sources before drafting.');
  assert.deepEqual(save.body.plan.steps[1].dependsOn,['step_opaque_1']);assert.deepEqual(save.body.plan.steps[1].sourceIds,['source_opaque_1','source_opaque_2']);
  assert.equal(save.body.plan.checks[0].id,'outcome_covered');assert.equal(save.body.plan.acceptanceCriteria[0].label,'Supported report');
  assert.equal(Object.hasOwn(save.body.plan,'provenance'),false);assert.equal(Object.hasOwn(save.body.plan,'status'),false);
  assert.equal(f.calls.some(call=>call.route.endsWith('/continue')),false);
  await f.click('[data-cycle-continue="'+cycleIds.cycle+'"]');await waitFor(()=>f.mutations().length===2);
  assert.equal(f.mutations()[1].body.expectedRequestRevision,12);assert.equal(f.mutations()[1].body.expectedPlanRevision,8);assert.equal(f.mutations()[1].body.expectedPlanResponseId,'opaque_plan_response_2');
});

test('a stale Plan edit remains visible and cannot silently continue or overwrite newer findings',async t=>{
  let revision=7;
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET'?cycleGraph(documents.get('request-a'),{planRevision:revision,responseId:'plan-response-'+revision}):undefined});
  const key='[data-field-key="cycle-plan:'+cycleIds.cycle+':values:approach"]';
  await f.input(key,'Keep these local edits.');revision=8;await f.refresh();
  assert.equal(f.$(key).value,'Keep these local edits.');
  assert.equal(f.$('[data-cycle-plan-save="'+cycleIds.cycle+'"]').disabled,true);
  assert.equal(f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled,true);
  await f.$('[data-cycle-plan-form="'+cycleIds.cycle+'"]').dispatch('submit');
  assert.equal(f.mutations().length,0);
});

test('exact request navigation focuses the requested stage without opening another conversation or starting work',async t=>{
  const f=await fixture(t);
  f.workspace.openRequestId('request-a',{nodeId:'child'});await waitFor(()=>f.$('[data-selected-node-id="child"]'));
  assert.equal(f.$('[data-request-id="request-a"]').getAttribute('aria-selected'),'true');
  f.workspace.leave();const count=f.calls.length;f.workspace.openRequestId('request-c',{nodeId:'frame'});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.calls.length,count);
  f.workspace.enter();await waitFor(()=>f.$('[data-request-id="request-c"]')?.getAttribute('aria-selected')==='true'&&f.$('[data-selected-node-id="frame"]'));
  assert.equal(f.navigation.length,0);assert.equal(f.mutations().length,0);
});

test('supervising model revisions identify their author type and keep raw author references in provenance',async t=>{
  const f=await fixture(t,{hook:(call,documents)=>{
    if(call.route!=='/api/planning-browser/requests/request-a'||call.method!=='GET')return;
    const graph=projectPlanningRequest(documents.get('request-a'));
    graph.nodes[0].response={id:'supervisor_response',revision:2,values:{},grounding:[],openQuestions:[],challengeResponses:[],provenance:{kind:'supervising_model',author:'supervisor_opaque_12'}};
    return graph;
  }});
  assert.match(visibleText(f.mount),/Supervising model response/);
  assert.doesNotMatch(visibleText(f.mount),/supervisor_opaque_12/);
  assert.equal(f.mutations().length,0);
});

test('an uncertain Continue retry keeps the same exact plan revision and request receipt',async t=>{
  let submits=0;
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return cycleGraph(documents.get('request-a'));
    if(call.route.endsWith('/'+cycleIds.cycle+'/continue')){if(++submits===1)throw Error('Continue receipt unavailable.');return cycleGraph(documents.get('request-a'),{state:'running'});}
  }});
  await f.click('[data-cycle-continue="'+cycleIds.cycle+'"]');await waitFor(()=>f.$('.pb-notice').textContent.includes('receipt unavailable'));
  assert.equal(f.mutations().length,1);
  await f.click('[data-cycle-continue="'+cycleIds.cycle+'"]');await waitFor(()=>f.mutations().length===2);
  assert.deepEqual(f.mutations()[1],f.mutations()[0]);
});

const freeCycleProfile = { model: 'saved_free::small-model:free', effort: 'default', serviceTier: 'default' };
const cycleModelStatus = () => ({
  defaultModel: 'gpt-default', defaultModelAvailable: true,
  runtimeSettings: { defaultEffort: 'default', defaultServiceTier: 'default' },
  models: [
    { id: 'gpt-default', displayName: 'Configured Codex model', available: true },
    { id: freeCycleProfile.model, displayName: 'Saved free provider · Small model', available: true, supportedReasoningEfforts: [] }
  ]
});

test('standalone cycle Run sends the chosen saved model and preserves its exact uncertain-delivery receipt', async t => {
  let submissions = 0;
  const status = cycleModelStatus();
  const f = await fixture(t, { status, initialNodeId: cycleIds.cycle, hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') {
      const graph = cycleGraph(documents.get('request-a'), { state: 'pending' });
      graph.responseCycle = { executionProfile: { model: 'gpt-default', effort: 'default', serviceTier: 'default' } };
      return graph;
    }
    if (call.route.endsWith('/' + cycleIds.cycle + '/run')) {
      if (++submissions === 1) throw Error('Run receipt unavailable.');
      const graph = cycleGraph(documents.get('request-a'));
      graph.cycles[0].executionProfile = copy(freeCycleProfile);
      return graph;
    }
  } });
  assert.equal(f.mutations().length, 0);
  let model = f.$('[data-cycle-model="' + cycleIds.cycle + '"]');
  assert.equal(model.disabled, false);
  assert.equal(model.value, 'gpt-default', 'An independent cycle may change the legacy default seed before its own first run.');
  model.value = freeCycleProfile.model; await model.dispatch('change');
  await f.click('[data-cycle-run="' + cycleIds.cycle + '"]');
  await waitFor(() => f.$('.pb-notice').textContent.includes('Run receipt unavailable'));
  const first = f.mutations()[0];
  assert.deepEqual({ model: first.body.model, effort: first.body.effort, serviceTier: first.body.serviceTier }, freeCycleProfile);
  assert.equal(first.body.planningExecutionMode, 'plan_only');
  assert.equal(first.body.expectedRequestRevision, 11); assert.equal(first.body.expectedCycleRevision, 2);
  assert.equal(f.$('[data-cycle-model="' + cycleIds.cycle + '"]').value, freeCycleProfile.model);
  await f.click('[data-cycle-run="' + cycleIds.cycle + '"]');
  await waitFor(() => f.$('[data-cycle-continue="' + cycleIds.cycle + '"]'));
  assert.deepEqual(f.mutations()[1], first);
  model = f.$('[data-cycle-model="' + cycleIds.cycle + '"]');
  assert.equal(model.value, freeCycleProfile.model); assert.equal(model.disabled, true);
  assert.equal(status.defaultModel, 'gpt-default');
  assert.equal(f.mutations().some(call => !call.route.startsWith('/api/planning-browser/requests/')), false);
});

test('a saved cycle model stays visible across default changes and individual stage Run uses the same profile', async t => {
  const status = cycleModelStatus();
  const graphFor = documents => {
    const graph = cycleGraph(documents.get('request-a'));
    graph.cycles[0].executionProfile = copy(freeCycleProfile);
    return graph;
  };
  const f = await fixture(t, { status, initialNodeId: cycleIds.cycle, hook: (call, documents) => {
    if (call.route === '/api/planning-browser/requests/request-a' && call.method === 'GET') return graphFor(documents);
    if (call.route.endsWith('/nodes/' + cycleIds.inference + '/run') || call.route.endsWith('/' + cycleIds.cycle + '/continue')) return graphFor(documents);
  } });
  assert.equal(f.$('[data-cycle-model="' + cycleIds.cycle + '"]').disabled, true);
  status.defaultModel = 'changed-global-default'; await f.refresh();
  assert.equal(f.$('[data-cycle-model="' + cycleIds.cycle + '"]').value, freeCycleProfile.model);
  await f.click('[data-node-id="' + cycleIds.inference + '"]');
  assert.equal(f.$('[data-action="run-module"]').textContent, 'Run module with Saved free provider · Small model');
  await f.click('[data-action="run-module"]'); await waitFor(() => f.mutations().length === 1);
  const run = f.mutations()[0];
  assert.equal(run.body.expectedNodeRevision, 1);
  assert.deepEqual({ model: run.body.model, effort: run.body.effort, serviceTier: run.body.serviceTier }, freeCycleProfile);
  await f.click('[data-cycle-continue="' + cycleIds.cycle + '"]'); await waitFor(() => f.mutations().length === 2);
  const continued = f.mutations()[1].body;
  assert.equal(continued.expectedPlanRevision, 7); assert.equal(continued.expectedPlanResponseId, 'opaque_plan_response_1');
  for (const key of ['model', 'effort', 'serviceTier']) assert.equal(Object.hasOwn(continued, key), false);
});

test('child cycles display the inherited model and active cycle controls cannot change or rerun it', async t => {
  const f = await fixture(t, { status: cycleModelStatus(), initialNodeId: cycleIds.cycle, hook: (call, documents) => {
    if (call.route !== '/api/planning-browser/requests/request-a' || call.method !== 'GET') return;
    const graph = cycleGraph(documents.get('request-a'), { state: 'running', child: true });
    graph.cycles[0].executionProfile = copy(freeCycleProfile);
    return graph;
  } });
  assert.equal(f.$('[data-cycle-model="' + cycleIds.cycle + '"]').disabled, true);
  assert.equal(f.$('[data-cycle-run="' + cycleIds.cycle + '"]').disabled, true);
  await f.click('[data-node-id="' + cycleIds.inference + '"]');
  assert.equal(f.$('[data-action="run-module"]').disabled, true);
  await f.click('[data-node-id="child_cycle_opaque"]');
  const model = f.$('[data-cycle-model="child_cycle_opaque"]');
  assert.equal(model.value, freeCycleProfile.model); assert.equal(model.disabled, true);
  assert.match(f.$('.pb-cycle-controls').textContent, /These model settings are saved/);
  assert.equal(f.mutations().length, 0);
});

test('an unavailable saved cycle model remains visible and is never silently replaced by the configured default', async t => {
  const status = cycleModelStatus(); status.models = status.models.filter(model => model.id !== freeCycleProfile.model);
  const f = await fixture(t, { status, initialNodeId: cycleIds.cycle, hook: (call, documents) => {
    if (call.route !== '/api/planning-browser/requests/request-a' || call.method !== 'GET') return;
    const graph = cycleGraph(documents.get('request-a'), { state: 'needs_review' });
    graph.cycles[0].executionProfile = copy(freeCycleProfile);
    return graph;
  } });
  const model = f.$('[data-cycle-model="' + cycleIds.cycle + '"]');
  assert.equal(model.value, freeCycleProfile.model); assert.equal(model.disabled, true);
  await f.click('[data-cycle-run="' + cycleIds.cycle + '"]');
  assert.match(f.$('.pb-notice').textContent, /Choose an available model/);
  assert.equal(f.mutations().length, 0);
});

test('refining a stage creates one revision-bound child cycle without starting a worker',async t=>{
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return cycleGraph(documents.get('request-a'));
    if(call.route==='/api/planning-browser/requests/request-a/cycles')return {...cycleGraph(documents.get('request-a'),{child:true}),cycleAction:{cycleId:'child_cycle_opaque'}};
  }});
  await f.click('[data-node-id="'+cycleIds.inference+'"]');
  await f.click(f.mount.querySelectorAll('button').find(button=>button.textContent==='+ Refine with a child cycle'));
  const form=f.$('.pb-create form');form.querySelector('input').value='Resolve a conflicting source';form.querySelector('textarea').value='Compare the two records and return the supported distinction.';
  await form.dispatch('submit');await waitFor(()=>f.mutations().length===1&&f.$('[data-selected-node-id="child_cycle_opaque"]'));
  const body=f.mutations()[0].body;
  assert.equal(body.parentNodeId,cycleIds.inference);assert.equal(body.expectedParentRevision,1);assert.equal(body.expectedRequestRevision,11);
  assert.equal(body.planningExecutionMode,'plan_only');assert.equal(body.title,'Resolve a conflicting source');assert.ok(body.clientRequestId);
  assert.equal(f.calls.some(call=>call.route.endsWith('/run')||call.route.endsWith('/continue')),false);
});

test('a nested feasibility answer names its exact node and response without resuming a Plan only parent',async t=>{
  const childNode='nested_feasibility_opaque';let answered=false;
  const make=document=>{
    const graph=cycleGraph(document,{child:true}),nested=graph.cycles[1];nested.stageNodeIds={feasibility:childNode};nested.state=answered?'pending':'awaiting_input';
    graph.nodes.push({id:childNode,kind:'viability',title:'Locate the correct source record',prompt:'Determine the source needed by this child question.',parentId:nested.id,revision:3,
      response:{id:answered?'nested-response-2':'nested-response-1',revision:1,values:{},grounding:[],openQuestions:[],challengeResponses:[],requirements:[]},
      readiness:{state:answered?'ready':'awaiting_input',viability:{state:answered?'ready':'awaiting_input',preferences:[],blockingFacts:answered?[]:[{id:'record-location',label:'Source record',question:'Which saved source contains the corrected address?',consequence:'This resolves the source conflict before drafting.'}]}}});
    return graph;
  };
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return make(documents.get('request-a'));
    if(call.route.endsWith('/viability/answer')){answered=true;return make(documents.get('request-a'));}
  }});
  f.workspace.openRequestId('request-a',{nodeId:childNode});await waitFor(()=>f.$('[data-selected-node-id="'+childNode+'"]'));
  await f.input('[data-viability-requirement="record-location"]','Use the corrected research notes.');
  await f.$('[data-action="answer-viability"]').closest('form').dispatch('submit');await waitFor(()=>f.mutations().length===1);
  const body=f.mutations()[0].body;
  assert.equal(body.nodeId,childNode);assert.equal(body.requirementId,'record-location');assert.equal(body.expectedNodeRevision,3);assert.equal(body.expectedResponseId,'nested-response-1');
  assert.equal(f.calls.some(call=>call.route.endsWith('/continue')||call.route.endsWith('/run')),false);
  await f.click('[data-node-id="'+cycleIds.cycle+'"]');
  assert.match(f.$('.pb-cycle-state').textContent,/Plan ready · paused/);
});

test('explicit request, stage, and manual conversation selection survive unrelated catalog and runtime updates',async t=>{
  const status={runtimeSettings:{defaultModel:'fixture-fast'}},f=await fixture(t,{status});
  f.workspace.openRequestId('request-a',{nodeId:'child'});await waitFor(()=>f.$('[data-selected-node-id="child"]'));
  status.runtimeSettings.defaultModel='updated-fixture-model';f.workspace.updateStatus({activeConversationId:'conversation-c'});
  for(const callback of f.listeners)callback({type:'conversations.updated',data:{conversationId:'conversation-c',activeConversationId:'conversation-c'}});
  await new Promise(resolve=>setTimeout(resolve,190));
  assert.ok(f.$('[data-request-id="request-a"][aria-selected="true"]'));assert.ok(f.$('[data-selected-node-id="child"]'));
  assert.match(f.$('[data-action="run-module"]').textContent,/updated-fixture-model/);
  await f.selectRequest('request-b');await f.emit('request-c');assert.ok(f.$('[data-request-id="request-b"][aria-selected="true"]'));
  await f.click('[data-conversation-id="conversation-c"]');await waitFor(()=>f.$('[data-request-id="request-c"][aria-selected="true"]'));
  await f.emit('request-a');f.workspace.updateStatus({activeConversationId:'conversation-a'});
  assert.ok(f.$('[data-conversation-id="conversation-c"][aria-current="true"]'));assert.ok(f.$('[data-request-id="request-c"][aria-selected="true"]'));
  assert.equal(f.mutations().length,0);assert.equal(f.navigation.length,0);
});

test('a newer manual conversation selection supersedes a delayed conversation-navigation catalog',async t=>{
  const gate=deferred();let hold=false;
  const f=await fixture(t,{hook:async call=>{if(hold&&call.route==='/api/planning-browser'){hold=false;await gate.promise;}}});
  t.after(()=>gate.resolve());hold=true;f.workspace.openConversationId('conversation-a');
  await f.click('[data-conversation-id="conversation-c"]');await waitFor(()=>f.$('[data-request-id="request-c"][aria-selected="true"]'));
  gate.resolve();await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(f.$('[data-conversation-id="conversation-c"][aria-current="true"]'),'The older pending conversation must not replace the later manual selection.');
  assert.ok(f.$('[data-request-id="request-c"][aria-selected="true"]'));assert.equal(f.mutations().length,0);
});

test('newer manual request or stage selection supersedes a delayed exact-request link',async t=>{
  for(const select of ['request','stage'])await t.test(select,async t=>{
    const gate=deferred();let hold=false;
    const f=await fixture(t,{hook:async call=>{if(hold&&call.route==='/api/planning-browser'){hold=false;await gate.promise;}}});
    t.after(()=>gate.resolve());hold=true;f.workspace.openRequestId('request-a',{nodeId:'child'});
    if(select==='request')await f.selectRequest('request-b');else await f.click('[data-node-id="frame"]');
    gate.resolve();await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(f.$('[data-request-id="'+(select==='request'?'request-b':'request-a')+'"][aria-selected="true"]'),'The older link must not replace the later selected request.');
    assert.ok(f.$('[data-selected-node-id="frame"]'),'The older link must not replace the later selected stage.');assert.equal(f.mutations().length,0);
  });
});

test('a delayed conversation link leaves the current request usable until the target is read',async t=>{
  for(const select of ['request','stage'])await t.test(select,async t=>{
    const gate=deferred();let hold=false;
    const f=await fixture(t,{hook:async call=>{if(hold&&call.route==='/api/planning-browser'){hold=false;await gate.promise;}}});
    t.after(()=>gate.resolve());hold=true;f.workspace.openConversationId('conversation-c');
    if(select==='request')await f.selectRequest('request-b');else await f.click('[data-node-id="child"]');
    gate.resolve();await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(f.$('[data-conversation-id="conversation-a"][aria-current="true"]'));
    assert.ok(f.$('[data-request-id="'+(select==='request'?'request-b':'request-a')+'"][aria-selected="true"]'));
    assert.ok(f.$('[data-selected-node-id="'+(select==='request'?'frame':'child')+'"]'));assert.equal(f.mutations().length,0);
  });
});

test('cycle summaries count unresolved child cycles rather than the two unrecorded later stages',async t=>{
  let childState=null;
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route!=='/api/planning-browser/requests/request-a'||call.method!=='GET')return;
    const graph=cycleGraph(documents.get('request-a'),{child:Boolean(childState)});
    graph.nodes[0].readiness.unresolvedChildren=[cycleIds.think,cycleIds.respond];
    if(childState)graph.cycles[1].state=childState;
    return graph;
  }});
  const row=()=>f.$('[data-node-id="'+cycleIds.cycle+'"]');
  assert.match(row().textContent,/3\/5 stages recorded/);assert.doesNotMatch(row().textContent,/child questions? open/);
  childState='pending';await f.refresh();assert.match(row().textContent,/1 child question open/);assert.doesNotMatch(row().textContent,/2 child/);
  childState='completed';await f.refresh();assert.doesNotMatch(row().textContent,/child questions? open/);
  await f.click('[data-view="graph"]');assert.doesNotMatch(row().textContent,/child questions? open/);assert.equal(f.mutations().length,0);
});

const savedAccuracy = () => ({mode:'exact',tolerance:'',decisionThreshold:'Capacity is at least 5 seats.',evidenceNeeded:'The supplied fictional room capacities.',consequence:'A wrong choice would fail the stated capacity requirement.',unknownPolicy:'block',stopWhen:'The supplied capacities have been compared with 5; no real-room check is needed.'});
const accuracyField = (criterion,key) => '[data-field-key="cycle-plan:'+cycleIds.cycle+':'+criterion+':accuracy:'+key+'"]';

test('saved accuracy and stopping conditions stay visible across all five stages and Plan edits use the exact saved revision',async t=>{
  let revision=7,body=null;
  const graphFor=doc=>{const graph=cycleGraph(doc,{planRevision:revision,responseId:'accuracy-plan-'+revision});const plan=graph.nodes.find(node=>node.id===cycleIds.plan);if(body)Object.assign(plan.response,copy(body));else plan.response.acceptanceCriteria[0].accuracy=savedAccuracy();return graph;};
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return graphFor(documents.get('request-a'));
    if(call.route.endsWith('/'+cycleIds.cycle+'/plan')){body=copy(call.body.plan);revision++;return graphFor(documents.get('request-a'));}
  }});
  for(const id of [cycleIds.cycle,...['feasibility','inference','plan','think','respond'].map(stage=>cycleIds[stage])]){
    if(id!==cycleIds.cycle)await f.click('[data-node-id="'+id+'"]');
    assert.match(visibleText(f.$('.pb-accuracy-targets')),/Accuracy: Exact/);
    assert.match(visibleText(f.$('.pb-accuracy-targets')),/Stop checking when: The supplied capacities/);
  }
  assert.equal(f.mutations().length,0);await f.click('[data-node-id="'+cycleIds.plan+'"]');
  await f.input(accuracyField('criterion_opaque_1','stopWhen'),'The exact cutoff and two-seat difference are established from the supplied premises.');
  assert.equal(f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled,true);
  await f.$('[data-cycle-plan-form="'+cycleIds.cycle+'"]').dispatch('submit');await waitFor(()=>f.mutations().length===1&&f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled===false);
  const save=f.mutations()[0];assert.equal(save.body.expectedRequestRevision,11);assert.equal(save.body.expectedCycleRevision,2);assert.equal(save.body.expectedPlanRevision,7);assert.equal(save.body.expectedPlanResponseId,'accuracy-plan-7');
  assert.equal(save.body.plan.acceptanceCriteria[0].accuracy.stopWhen,'The exact cutoff and two-seat difference are established from the supplied premises.');
  assert.deepEqual(save.body.plan.checks,body.checks);assert.equal(save.body.plan.steps.length,2);
  assert.match(visibleText(f.$('.pb-accuracy-targets')),/Stop checking when: The exact cutoff/);
  assert.equal(f.calls.some(call=>call.route.endsWith('/continue')||call.route.endsWith('/run')),false);
});

test('legacy criteria acquire no invented accuracy target and an explicit target draft saves bounded fields without starting work',async t=>{
  let saved;
  const graphFor=doc=>{const graph=cycleGraph(doc,{planRevision:saved?8:7,responseId:saved?'new-accuracy-plan':'legacy-plan'});if(saved)Object.assign(graph.nodes.find(node=>node.id===cycleIds.plan).response,copy(saved));return graph;};
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route==='/api/planning-browser/requests/request-a'&&call.method==='GET')return graphFor(documents.get('request-a'));
    if(call.route.endsWith('/'+cycleIds.cycle+'/plan')){saved=copy(call.body.plan);return graphFor(documents.get('request-a'));}
  }});
  assert.equal(f.$('.pb-accuracy-targets'),null);assert.equal(f.$('[data-accuracy-editor]'),null);assert.equal(f.mutations().length,0);
  await f.click('[data-accuracy-add="criterion_opaque_1"]');
  const mode=f.$('[data-accuracy-mode="criterion_opaque_1"]');mode.value='bounded_estimate';await mode.dispatch('change');
  const policy=f.$('[data-accuracy-unknown-policy="criterion_opaque_1"]');policy.value='range';await policy.dispatch('change');
  const target={mode:'bounded_estimate',tolerance:'Compare the supplied cost intervals; exact point quotes are not needed.',decisionThreshold:'Option A upper bound is below option B lower bound.',evidenceNeeded:'The supplied 40–60 and 180–220 cost intervals.',consequence:'An incorrect ordering would change the rough comparison.',unknownPolicy:'range',stopWhen:'The intervals do not overlap, so more precision cannot change the ordering.'};
  for(const key of ['tolerance','decisionThreshold','evidenceNeeded','consequence','stopWhen'])await f.input(accuracyField('criterion_opaque_1',key),target[key]);
  assert.equal(f.$(accuracyField('criterion_opaque_1','tolerance')).required,true);
  assert.equal(f.mutations().length,0);await f.$('[data-cycle-plan-form="'+cycleIds.cycle+'"]').dispatch('submit');await waitFor(()=>saved);
  assert.deepEqual(saved.acceptanceCriteria[0].accuracy,target);assert.equal(f.mutations().length,1);assert.ok(f.mutations()[0].route.endsWith('/plan'));
});

test('an accuracy edit remains a dirty revision-bound draft when the saved Plan changes',async t=>{
  let revision=7;
  const f=await fixture(t,{initialNodeId:cycleIds.cycle,hook:(call,documents)=>{
    if(call.route!=='/api/planning-browser/requests/request-a'||call.method!=='GET')return;
    const graph=cycleGraph(documents.get('request-a'),{planRevision:revision,responseId:'accuracy-plan-'+revision});graph.nodes.find(node=>node.id===cycleIds.plan).response.acceptanceCriteria[0].accuracy=savedAccuracy();return graph;
  }});
  await f.input(accuracyField('criterion_opaque_1','decisionThreshold'),'My revised cutoff.');revision++;await f.refresh();
  assert.equal(f.$(accuracyField('criterion_opaque_1','decisionThreshold')).value,'My revised cutoff.');
  assert.equal(f.$('[data-cycle-plan-save="'+cycleIds.cycle+'"]').disabled,true);assert.equal(f.$('[data-cycle-continue="'+cycleIds.cycle+'"]').disabled,true);
  await f.$('[data-cycle-plan-form="'+cycleIds.cycle+'"]').dispatch('submit');assert.equal(f.mutations().length,0);
});

test('feasibility shows the requirement accuracy target without turning it into an extra factual question',async t=>{
  const f=await fixture(t,{hook:(call,documents)=>{
    if(call.route!=='/api/planning-browser/requests/request-a'||call.method!=='GET')return;
    const graph=projectPlanningRequest(documents.get('request-a')),node=graph.nodes[0];node.kind='viability';
    node.response={id:'accuracy-feasibility',values:{},grounding:[],requirements:[{id:'capacity',label:'Stipulated seating capacity',accuracy:savedAccuracy()}]};
    node.readiness={state:'ready',viability:{state:'ready',blockingFacts:[],preferences:[],issues:[]}};return graph;
  }});
  assert.match(visibleText(f.$('.pb-viability')),/Requirement accuracy targets/);assert.match(visibleText(f.$('.pb-viability')),/no real-room check is needed/);
  assert.equal(f.$('[data-action="answer-viability"]'),null);assert.equal(f.mutations().length,0);
});
