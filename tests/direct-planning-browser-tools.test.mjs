import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, validDirectArguments } from '../lib/direct-execution-api.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { createDirectPlanningBrowserTools } from '../lib/direct-planning-browser-tools.mjs';
import { PLANNING_MODULE_TEMPLATES, planningModuleTemplate } from '../public/planning-browser-model.mjs';

const client = { id: 'synthetic-chatgpt-connection', label: 'Synthetic ChatGPT', kind: 'chatgpt', scopes: ['read', 'planning:write'] };
const readTool = 'blackice_planning_graph_read', writeTool = 'blackice_planning_graph_write';
const waitJob = async (api, jobId, who = client) => { const end = Date.now() + 7000; while (Date.now() < end) { const job = await api.getJob(jobId, who, { limit: 50000 }); if (job.settled) return job; await new Promise(resolve => setTimeout(resolve, 4)); } throw Error('Direct graph job did not settle.'); };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-direct-graph-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'profile'); await mkdir(cwd);
  const store = await new PlanningBrowserStore({ dataDir }).init(), events = [];
  const tools = createDirectPlanningBrowserTools({ store, getCatalog: async () => ({ ...(await store.list()), conversations: [{ id: 'conversation-a', title: 'Synthetic conversation', state: 'active' }], templates: PLANNING_MODULE_TEMPLATES }), onChange: event => events.push(event) });
  const api = await new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: tools }).init();
  t.after(async () => { await api.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const send = async (name, args, who = client) => { const admitted = await api.call(name, { requestId: 'fixture-' + (++sequence), ...args }, who), job = await waitJob(api, admitted.jobId, who); return { admitted, job, value: job.result ? JSON.parse(job.result.text.text) : null }; };
  const write = args => send(writeTool, args);
  const read = args => send(readTool, args);
  const create = async () => { const receipt = await write({ action: 'create_request', graphRequestId: 'graph-a', conversationId: 'conversation-a', title: 'Synthetic modular question', objective: 'Compare evidence and preserve alternatives.', cwd }); assert.equal(receipt.job.status, 'succeeded'); return receipt; };
  const add = async (nodeId, extra = {}) => { const receipt = await write({ action: 'add_module', graphRequestId: 'graph-a', nodeId, kind: 'frame', title: 'Synthetic ' + nodeId, prompt: 'What changes the decision?', ...extra }); assert.equal(receipt.job.status, 'succeeded', JSON.stringify(receipt.job)); return receipt; };
  return { api, store, tools, events, send, write, read, create, add };
}

test('read and planning-write scopes expose distinct durable tools and reject runtime/provenance overrides before admission', async t => {
  const f = await fixture(t), readOnly = { ...client, scopes: ['read'] };
  assert.ok(f.api.tools(readOnly).some(tool => tool.name === readTool)); assert.ok(!f.api.tools(readOnly).some(tool => tool.name === writeTool));
  await assert.rejects(f.api.call(writeTool, { requestId: 'denied', action: 'create_request', title: 'Synthetic', objective: 'Synthetic objective' }, readOnly), { code: 'DIRECT_SCOPE_REQUIRED' });
  const def = f.api.tools(client).find(tool => tool.name === writeTool);
  const allowed = { requestId: 'external', action: 'record_response', graphRequestId: 'graph-a', nodeId: 'root', expectedNodeRevision: 1, values: { objective: 'Synthetic' } };
  assert.equal(validDirectArguments(allowed, def.inputSchema), true);
  for (const extra of [{ provenance: { kind: 'runtime' } }, { actor: { id: 'spoof' } }, { done: true }, { runId: 'fake-run' }, { receipt: { jobId: 'fake' } }, { automatic: true }]) {
    assert.equal(validDirectArguments({ ...allowed, ...extra }, def.inputSchema), false);
    await assert.rejects(f.api.call(writeTool, { ...allowed, ...extra }, client), { code: 'DIRECT_REQUEST_INVALID' });
  }
  assert.equal((await f.api.listJobs(client)).total, 0); assert.equal((await f.store.list()).requests.length, 0);
});

test('a direct edit and a local UI edit share one graph, event stream, and exact recoverable job receipt', async t => {
  const f = await fixture(t); const created = await f.create(); await f.add('root');
  assert.equal(created.value.modelStarted, false); assert.equal(created.value.externalActionExecuted, false);
  const current = await f.store.get('graph-a'); assert.equal(current.nodes[0].title, 'Synthetic root');
  const objective = current.sources.find(source => source.id === 'request:graph-a'); assert.equal(objective.kind, 'request_objective'); assert.equal(objective.provenance.kind, 'external_agent');
  await f.store.updateNode('graph-a', 'root', { title: 'Human revised title' }, { expectedNodeRevision: 1, actor: 'user' });
  const snapshot = await f.read({ action: 'get', graphRequestId: 'graph-a', nodeId: 'root', requestId: 'stable-read' }); assert.equal(snapshot.value.node.title, 'Human revised title');
  const updated = await f.write({ action: 'update_module', graphRequestId: 'graph-a', nodeId: 'root', expectedNodeRevision: 2, prompt: 'External agent developed the same question.', requestId: 'stable-edit' });
  assert.equal(updated.job.status, 'succeeded'); assert.equal((await f.store.get('graph-a')).nodes[0].prompt, 'External agent developed the same question.');
  const before = (await f.store.get('graph-a')).revision, count = f.events.length;
  const replay = await f.api.call(writeTool, { action: 'update_module', graphRequestId: 'graph-a', nodeId: 'root', expectedNodeRevision: 2, prompt: 'External agent developed the same question.', requestId: 'stable-edit' }, client);
  assert.equal(replay.existing, true); assert.equal(replay.jobId, updated.admitted.jobId); assert.equal((await f.store.get('graph-a')).revision, before); assert.equal(f.events.length, count);
  const replayRead = await f.api.call(readTool, { action: 'get', graphRequestId: 'graph-a', nodeId: 'root', requestId: 'stable-read' }, client);
  assert.equal((await f.api.getJob(replayRead.jobId, client)).result.text.text, snapshot.job.result.text.text, 'An identical read retry is the original snapshot.');
  assert.ok(f.events.every(event => event.type === 'planning.browser.updated' && event.data.requestId === 'graph-a'));
  assert.equal((await f.store.get('graph-a')).attempts.length, 0);
});

test('module-level CAS permits independent parallel branches and refuses a stale edit without overwriting the newer work', async t => {
  const f = await fixture(t); await f.create(); await f.add('a'); await f.add('b');
  const updates = await Promise.all(['a', 'b'].map(nodeId => f.write({ action: 'update_module', graphRequestId: 'graph-a', nodeId, expectedNodeRevision: 1, title: 'Developed ' + nodeId })));
  assert.ok(updates.every(receipt => receipt.job.status === 'succeeded'));
  const stale = await f.write({ action: 'update_module', graphRequestId: 'graph-a', nodeId: 'a', expectedNodeRevision: 1, title: 'Stale replacement' });
  assert.equal(stale.job.status, 'failed'); assert.equal(stale.job.error.code, 'PLANNING_NODE_CONFLICT');
  const saved = await f.store.get('graph-a'); assert.deepEqual(saved.nodes.map(node => node.title), ['Developed a', 'Developed b']); assert.equal(saved.attempts.length, 0);
  const nested = await f.add('nested', { parentId: 'a', expectedParentRevision: 2, kind: 'inquiry' }); assert.equal(nested.value.node.parentId, 'a');
});

test('external public responses and source material retain actual connector/job provenance without becoming Luna runtime or verification', async t => {
  const f = await fixture(t); await f.create(); await f.add('root');
  const source = await f.write({ action: 'add_source', graphRequestId: 'graph-a', title: 'Synthetic source', text: 'This source is fictional test material.' });
  assert.equal(source.job.status, 'succeeded'); assert.equal(source.value.source.provenance.kind, 'external_agent'); assert.equal(source.value.source.verified, false);
  const fields = planningModuleTemplate('frame').fields, values = Object.fromEntries(fields.map(field => [field.id, 'Synthetic contribution: ' + field.label]));
  const contribution = await f.write({ action: 'record_response', graphRequestId: 'graph-a', nodeId: 'root', expectedNodeRevision: 1, values, grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: source.value.source.id })), openQuestions: [], challengeResponses: [], requestId: 'public-answer' });
  assert.equal(contribution.job.status, 'succeeded', JSON.stringify(contribution.job));
  const saved = await f.store.get('graph-a'), response = saved.responses[0];
  assert.equal(response.provenance.kind, 'external_agent'); assert.equal(response.verifiedAction, false); assert.equal(saved.attempts.length, 0); assert.equal(response.provenance.runId, undefined);
  assert.equal(response.provenance.receipt.connectionId, client.id); assert.equal(response.provenance.receipt.jobId, contribution.job.jobId); assert.equal(response.provenance.receipt.requestId, 'public-answer');
  assert.equal(saved.nodes[0].revision, 2); assert.equal(response.nodeRevision, 2);
  const history = await f.read({ action: 'response_history', graphRequestId: 'graph-a', nodeId: 'root' }); assert.equal(history.value.responses.total, 1); assert.equal(history.value.responses.items[0].id, response.id);
  const exact = await f.read({ action: 'response_history', graphRequestId: 'graph-a', responseId: response.id }); assert.deepEqual(exact.value.response.values, values); assert.ok(exact.value.response.sourceIds.includes(source.value.source.id));
  const material = await f.read({ action: 'source', graphRequestId: 'graph-a', sourceId: source.value.source.id }); assert.equal(material.value.source.text, 'This source is fictional test material.');
});

test('catalog/templates are read-only and a consumes relationship uses stored IDs and recorded output fields', async t => {
  const f = await fixture(t); await f.create(); await f.add('producer'); await f.add('consumer', { kind: 'decision' });
  const templates = await f.read({ action: 'templates' }); assert.ok(templates.value.templates.find(template => template.kind === 'decision').fields.some(field => field.id === 'opportunityCost'));
  const catalog = await f.read({ action: 'list', conversationId: 'conversation-a', limit: 1 }); assert.equal(catalog.value.requests.total, 1); assert.equal(catalog.value.conversations.items[0].title, 'Synthetic conversation');
  const before = f.events.length, fields = planningModuleTemplate('frame').fields;
  const produced = await f.write({ action: 'record_response', graphRequestId: 'graph-a', nodeId: 'producer', expectedNodeRevision: 1, values: Object.fromEntries(fields.map(field => [field.id, 'Synthetic ' + field.label])), grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'request:graph-a' })) });
  const response = produced.value.node.response;
  const linked = await f.write({ action: 'link', graphRequestId: 'graph-a', from: 'consumer', to: 'producer', kind: 'consumes', sourceResponseId: response.id, sourceResponseRevision: response.revision, sourceField: 'objective', freshness: 'pinned', expectedNodeRevision: 1 });
  assert.equal(linked.job.status, 'succeeded'); assert.equal(linked.value.edges.items[0].sourceField, 'objective'); assert.equal(linked.value.edges.items[0].sourceResponseId, response.id);
  assert.equal(f.events.length, before + 2, 'Read operations never broadcast a mutation.'); assert.equal((await f.store.get('graph-a')).attempts.length, 0);
});

test('large graph reads page real records by byte budget with independent source/edge cursors', async () => {
  const document = { id: 'large', conversationId: 'synthetic', title: 'Synthetic large graph', objective: 'Inspect every record through explicit pages.', revision: 1,
    nodes: Array.from({ length: 120 }, (_, index) => ({ id: 'n' + index, kind: 'frame', title: 'Module ' + index, prompt: 'x'.repeat(12000), parentId: null, revision: 1, readiness: { state: 'empty' } })),
    edges: Array.from({ length: 60 }, (_, index) => ({ id: 'e' + index, kind: 'informs', from: 'n0', to: 'n' + (index + 1) })), sources: Array.from({ length: 60 }, (_, index) => ({ id: 'source:' + index, title: 'Source ' + index, text: 'This exact material is fetched separately.' })), responses: [], attempts: [] };
  const store = Object.fromEntries(['list', 'create', 'addNode', 'updateNode', 'link', 'addSource'].map(name => [name, () => { throw Error('Unexpected write or catalog read.'); }])); store.get = async () => document;
  const tool = createDirectPlanningBrowserTools({ store })[0];
  const read = async args => JSON.parse((await tool.execute({ action: 'get', graphRequestId: 'large', ...args })).contentItems[0].text);
  const first = await read({ limit: 100 }); assert.ok(first.nodes.items.length < 100); assert.equal(first.nodes.total, 120); assert.equal(first.nodes.nextOffset, first.nodes.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024 * 1024);
  const next = await read({ offset: first.nodes.nextOffset, edgeOffset: 30, sourceOffset: 30, limit: 10 }); assert.equal(next.nodes.items[0].id, 'n' + first.nodes.nextOffset); assert.equal(next.sources.items[0].id, 'source:30');
  const focused = await read({ nodeId: 'n0', edgeOffset: 30, sourceOffset: 30, limit: 10 }); assert.equal(focused.edges.items[0].id, 'e30'); assert.equal(focused.edges.nextOffset, 40);
  document.nodes[0].response = { id: 'synthetic-response', nodeId: 'n0', revision: 1, values: { objective: 'One small public answer' }, inputs: [{ nodeId: 'n1', responseId: 'pinned-parent', responseRevision: 1, values: { large: 'x'.repeat(50000) }, subtree: Array.from({ length: 100 }, (_, index) => ({ nodeId: 'child-' + index, responseId: 'pinned-' + index, responseRevision: 2, values: { large: 'x'.repeat(50000) } })) }], sources: [] };
  const pinned = await read({ nodeId: 'n0' });
  assert.equal(pinned.node.response.inputs.items[0].values, undefined); assert.equal(pinned.node.response.inputs.items[0].subtree[0].values, undefined);
  assert.equal(pinned.node.response.inputs.items[0].subtree[99].responseId, 'pinned-99'); assert.equal(pinned.node.response.inputs.items[0].subtree[99].responseRevision, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(pinned)) < 100000, 'Nested historical content is fetched by exact source/response ID instead of overflowing a direct receipt.');
  const references = Array.from({ length: 500 }, (_, index) => ({ nodeId: 'child-' + index, responseId: 'recorded-output-' + 'x'.repeat(100) + index, responseRevision: 4 }));
  document.nodes[0].response.inputs = Array.from({ length: 100 }, (_, index) => ({ edgeId: 'dependency-' + index, nodeId: 'n1', responseId: 'producer-' + index, responseRevision: 4, subtree: references }));
  const firstInputs = await read({ nodeId: 'n0', limit: 100 }); assert.ok(firstInputs.node.response.inputs.items.length < 100); assert.ok(firstInputs.node.response.inputs.nextOffset > 0); assert.ok(Buffer.byteLength(JSON.stringify(firstInputs)) < 1024 * 1024);
  const inputOffset = firstInputs.node.response.inputs.nextOffset, nextInputs = await read({ nodeId: 'n0', inputOffset, limit: 100 }); assert.equal(nextInputs.node.response.inputs.items[0].edgeId, 'dependency-' + inputOffset);
});
