import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { WindowsWorkbench } from '../lib/windows-workbench.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createPlanningBrowser } from '../public/next/workspaces/planning-browser.mjs';
import { planPayload } from '../public/next/workspaces/response-cycle-ui.mjs';
import { planningModuleTemplate } from '../public/planning-browser-model.mjs';
import { RESPONSE_CYCLE_STAGES, responseCycleStage } from '../public/response-cycle-model.mjs';
import { contractPlanProjection } from '../public/planning-contract-model.mjs';

const cycleId = 'editor-cycle', conversationId = 'editor-conversation';
const contract = () => ({ contractVersion: 2, goal: 'Review the supplied source and obtain one observed confirmation.',
  criteria: [{ id: 'read', kind: 'observation', label: 'Inspect the source', description: 'Read the supplied source.', resourceKey: 'workspace:fixture' },
    { id: 'confirmed', kind: 'external-confirmation', label: 'Observed confirmation', description: 'Obtain an actual confirmation.', resourceKey: 'origin:https://example.invalid', targetCount: 1,
      receiptBinding: { version: 1, format: 'json', resourceKey: 'origin:https://example.invalid', record: '$.records[*]', status: '$.status', confirmedValues: ['confirmed'], outcomeId: '$.id', history: false } }],
  workItems: [{ id: 'inspect', title: 'Inspect source', objective: 'Read the supplied source.', owner: 'coordinator', resourceKeys: ['workspace:fixture'], effects: ['observe'], dependsOn: [], criterionIds: ['read'] },
    { id: 'confirm', title: 'Obtain confirmation', objective: 'Submit the bounded request and inspect its confirmation.', owner: 'coordinator', resourceKeys: ['origin:https://example.invalid'], effects: ['observe', 'interact', 'commit'], dependsOn: ['inspect'], criterionIds: ['confirmed'] }],
  instructions: [{ id: 'retain', text: 'Retain the observed confirmation.', handling: 'preserve' }, { id: 'audit', text: 'Record any optional formatting difference.', handling: 'audit' }] });
class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, ready: true, defaultModel: 'editor-fixture', models: [{ model: 'editor-fixture' }] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.calls++; throw Error('Reading or saving a Plan must not start model work.'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
function request(url, route, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.port, path: route, method, agent: false,
      headers: { Host: url.host, ...headers, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }) } }, res => {
      const chunks = []; res.on('data', value => chunks.push(value)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, value, text }); });
    });
    req.on('error', reject); req.setTimeout(7000, () => req.destroy(Error('Plan editor HTTP fixture timed out.'))); req.end(encoded);
  });
}
const planNode = document => document.nodes.find(node => node.id === document.cycles[0].stageNodeIds.plan);
const controls = document => ({ expectedRequestRevision: document.revision, expectedCycleRevision: document.nodes.find(node => node.id === cycleId).revision,
  expectedPlanRevision: planNode(document).revision, expectedPlanResponseId: planNode(document).response.id });
async function until(check, message) {
  for (let attempt = 0; attempt < 300; attempt++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(typeof message === 'function' ? message() : message);
}
async function fixture(t, { canonical = true, cycleState = 'paused_after_plan', accuracy } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'canonical-cycle-editor-')), runtime = new Runtime();
  const transport = createRemoteTransportFixture(), remoteAccess = new RemoteAccessManager({ dataDir: directory, transport: transport.transport, defaultHttpsPort: 8443 });
  const workbench = new WindowsWorkbench({ dataDir: directory, sharedRoot: directory,
    probe: async () => ({ windows: false, vmExists: false, vmState: 'NotInstalled' }),
    command: async () => { throw Error('Plan editor fixtures must not execute host commands.'); } });
  let app, browser;
  t.after(async () => { browser?.destroy(); try { await app?.close(); assert.equal(runtime.calls, 0); } finally { await rm(directory, { recursive: true, force: true }); } });
  const dom = planningDOM(t);
  const prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  prototype.replaceChildren = function (...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.rawText = ''; this.markup = ''; this.append(...children); };
  app = await createHarnessServer({ port: 0, dataDir: directory, defaultCwd: directory, runtime, desktop: new Desktop(), remoteAccess, workbench, autoAttachDesktop: false, enableWorkbenchVideo: false });
  await app.learning.updateSettings({ mode: 'manual' });
  let document = await app.planningBrowser.create({ conversationId, title: 'Review a saved Plan', objective: 'Review the supplied source and obtain one observed confirmation.', cwd: directory });
  const stages = Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage => [stage.id, cycleId + '-' + stage.id]));
  const writer = app.planningBrowser.runtimeWriter();
  document = await writer.configureResponseCycle(document.id, { createCycle: { id: cycleId, title: 'Review a saved Plan', objective: document.objective, stageNodeIds: stages,
    parentCycleId: null, parentStageId: null, depth: 0, pipelineVersion: 2, planningExecutionMode: 'plan_only', state: 'pending', acceptanceCriteria: [], sourceIds: null, execution: { required: false, state: 'not_required' } },
    rootPatch: { rootCycleId: cycleId }, ...(canonical ? { sources: [{ id: 'cycle:execution-contract:' + cycleId, kind: 'source', label: 'Canonical execution contract', text: JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2 }) }] } : {}) });
  const stage = responseCycleStage('plan', { pipelineVersion: 2 }), fields = planningModuleTemplate('plan', { pipelineVersion: 2 }).fields, sourceId = 'request:' + document.id;
  const authored = contract(); if (accuracy !== undefined) authored.criteria[1].accuracy = structuredClone(accuracy);
  const body = { userAgency: fixtureUserAgency(), values: Object.fromEntries(fields.map(field => [field.id, field.label + ': use the supplied source and preserve the requested confirmation.'])),
    grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })), openQuestions: [], challengeResponses: [], subproblems: [], childResults: [],
    checks: stage.checks.map(check => ({ id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported', sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [], note: 'The bounded proposed work preserves the requested outcome and its stated evidence requirements.' })),
    ...(canonical ? { contract: authored } : contractPlanProjection(authored, [sourceId])) };
  for (const kind of ['inference', 'viability']) {
    const earlyStage = responseCycleStage(kind, { pipelineVersion: 2 }), earlyFields = planningModuleTemplate(kind, { pipelineVersion: 2 }).fields;
    const early = { userAgency: fixtureUserAgency(), values: Object.fromEntries(earlyFields.map(field => [field.id, field.label + ': the supplied source establishes a bounded request with an observed confirmation required.'])),
      grounding: earlyFields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })), openQuestions: [], challengeResponses: [] };
    if (kind === 'viability') early.requirements = [];
    else Object.assign(early, { checks: earlyStage.checks.map(check => ({ id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported', sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [], note: 'The supplied request supports the stated interpretation and bounded route.' })), subproblems: [], childResults: [],
      inferences: [{ id: 'requested-result', claim: 'The request requires a bounded source review and an observed confirmation.', basis: 'inferred', sourceIds: [sourceId], limitation: 'Operational observations have not yet been made.' }] });
    document = await app.planningBrowser.recordHumanResponse(document.id, stages[earlyStage.id], early, { expectedNodeRevision: 1 });
  }
  document = await app.planningBrowser.recordHumanResponse(document.id, stages.plan, body, { expectedNodeRevision: 1 });
  const accepted = planNode(document);
  document = await writer.configureResponseCycle(document.id, { cyclePatch: { id: cycleId, state: cycleState, planRef: { requestId: document.id, cycleId, nodeId: accepted.id, nodeRevision: accepted.revision, responseId: accepted.response.id } } });
  assert.equal(document.cycles[0].state, cycleState, JSON.stringify(document.cycles[0]));
  const initial = structuredClone(document), url = new URL(await app.listen()), page = await request(url, '/'), cookie = page.headers['set-cookie'][0].split(';')[0];
  const local = (route, options = {}) => request(url, route, { ...options, headers: { Cookie: cookie, ...(options.headers || {}) } });
  const calls = []; let afterPlanResponse = null;
  const api = async (route, methodOrOptions = 'GET', payload) => {
    const method = typeof methodOrOptions === 'string' ? methodOrOptions : 'GET'; calls.push({ route, method, body: structuredClone(payload) });
    const result = await local(route, { method, body: payload });
    if (result.status >= 400) throw Object.assign(Error(result.value?.error || result.text), { code: result.value?.code, status: result.status });
    if (method === 'POST' && route.endsWith('/plan')) await afterPlanResponse?.(result.value);
    return result.value;
  };
  browser = createPlanningBrowser({ mount: dom.mount, api, events: { subscribe() { return () => {}; } }, getStatus: () => ({ ...runtime.status(), cwd: directory }) });
  browser.openRequestId(document.id, { nodeId: stages.plan }); browser.enter();
  await until(() => dom.$('[data-cycle-plan-form]'), () => 'Saved Plan editor did not render: ' + dom.mount.textContent.slice(-1500));
  const route = '/api/planning-browser/requests/' + document.id + '/cycles/' + cycleId + '/plan';
  const read = () => app.planningBrowser.get(document.id);
  const editRemote = async change => { const current = await read(), plan = planPayload(planNode(current).response); change(plan); const result = await local(route, { method: 'POST', body: { ...controls(current), plan, clientRequestId: 'remote-' + current.revision } }); assert.equal(result.status, 200, result.text); return result.value; };
  const refresh = async () => { await dom.click('[data-action="refresh"]'); await until(() => !dom.$('[data-action="refresh"]').disabled, 'Refresh did not settle'); };
  return { app, runtime, dom, browser, initial, calls, local, route, read, editRemote, refresh,
    field: key => '[data-field-key="cycle-plan:' + cycleId + ':' + key + '"]',
    save: () => dom.$('[data-cycle-plan-form]').dispatch('submit'),
    planCalls: () => calls.filter(call => call.method === 'POST' && call.route.endsWith('/plan')),
    afterPlanResponse(value) { afterPlanResponse = value; } };
}
const button = (dom, label) => dom.mount.querySelectorAll('button').find(item => item.textContent === label);

test('the actual saved Plan workspace submits canonical intent through the real cycle HTTP route', async t => {
  const f = await fixture(t), old = structuredClone(planNode(f.initial).response);
  assert.ok(f.dom.$('[data-canonical-plan]')); assert.equal(f.dom.$('[data-plan-step]'), null);
  assert.doesNotMatch(f.dom.mount.textContent, /Planned steps and dependencies|How it is verified/);
  assert.ok(f.dom.$('[data-plan-work-item="inspect"]')); assert.ok(f.dom.$('[data-contract-instruction="audit"]'));
  await f.dom.input(f.field('inspect:objective'), 'Read the supplied source and record the relevant observation.');
  await f.dom.input(f.field('confirmed:targetCount'), '2');
  await f.dom.input(f.field('audit:text'), 'Record optional formatting differences without blocking the result.');
  assert.equal(f.dom.$('[data-cycle-continue]').disabled, true);
  await f.save();
  await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
  const saved = await f.read(), response = planNode(saved).response, sent = f.planCalls()[0].body;
  assert.equal(f.planCalls().length, 1); assert.equal(Object.hasOwn(sent.plan, 'steps'), false); assert.equal(Object.hasOwn(sent.plan, 'acceptanceCriteria'), false);
  assert.deepEqual(sent.plan.userAgency, old.userAgency); assert.deepEqual(response.userAgency, old.userAgency);
  assert.deepEqual(response.contract.criteria[1].receiptBinding, old.contract.criteria[1].receiptBinding);
  assert.equal(response.contract.criteria[1].targetCount, 2); assert.equal(response.contract.workItems[0].objective, 'Read the supplied source and record the relevant observation.');
  assert.deepEqual({ steps: response.steps, acceptanceCriteria: response.acceptanceCriteria }, contractPlanProjection(response.contract, ['cycle:execution-contract:' + cycleId]));
  assert.deepEqual(saved.responses.find(value => value.id === old.id), old); assert.equal(response.provenance.kind, 'human'); assert.equal(response.verifiedAction, false);
  assert.equal(saved.cycles[0].state, 'paused_after_plan'); assert.equal(f.calls.some(call => /\/(continue|run)$/.test(call.route) && call.method === 'POST'), false); assert.equal(f.runtime.calls, 0);
  const malformed = planPayload(response); malformed.steps = [{ ...response.steps[0], description: 'A conflicting second plan.' }];
  const rejected = await f.local(f.route, { method: 'POST', body: { ...controls(saved), clientRequestId: 'inconsistent-projection', plan: malformed } });
  assert.equal(rejected.status, 400, rejected.text); assert.match(rejected.text, /disagrees/); assert.equal((await f.read()).revision, saved.revision);
});

test('saved canonical accuracy stays visible and survives ordinary editor saves and refreshes through the real HTTP route', async t => {
  const accuracy = { mode: 'exact', tolerance: 'No missing or duplicate requested confirmations.',
    decisionThreshold: 'Exactly one distinct requested confirmation is observed.', evidenceNeeded: 'A matching receipt from the actual destination.',
    consequence: 'An inaccurate result would misstate the completed request.', unknownPolicy: 'block',
    stopWhen: 'The distinct requested confirmation has been observed and reported.' };
  const f = await fixture(t, { accuracy }), old = structuredClone(planNode(f.initial).response);
  const visible = () => {
    const target = f.dom.$('[data-accuracy-target="confirmed"]'); assert.ok(target, 'Saved accuracy must be reviewable above the canonical editor.');
    for (const key of ['tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'stopWhen']) assert.ok(target.textContent.includes(accuracy[key]), key + ' is visible.');
    assert.match(target.textContent, /Accuracy: Exact/); assert.match(target.textContent, /Resolve before proceeding/);
    assert.ok(f.dom.$('[data-accuracy-stop="confirmed"]').textContent.includes(accuracy.stopWhen));
  };
  visible();
  assert.deepEqual(old.contract.criteria[1].accuracy, accuracy);
  assert.deepEqual(old.acceptanceCriteria.find(item => item.id === 'confirmed').accuracy, accuracy);
  for (const [field, value] of [['inspect:objective', 'Read the supplied source and preserve the inherited accuracy target.'], ['audit:text', 'Retain the exact observed confirmation and any optional formatting difference.']]) {
    await f.dom.input(f.field(field), value); await f.save();
    await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
    const saved = await f.read(), response = planNode(saved).response, sent = f.planCalls().at(-1).body.plan;
    assert.equal(Object.hasOwn(sent, 'acceptanceCriteria'), false);
    assert.deepEqual(sent.contract.criteria[1].accuracy, accuracy);
    assert.deepEqual(response.contract.criteria[1].accuracy, accuracy);
    assert.deepEqual(response.acceptanceCriteria.find(item => item.id === 'confirmed').accuracy, accuracy);
    assert.deepEqual(response.contract.criteria[1].receiptBinding, old.contract.criteria[1].receiptBinding);
    assert.equal(response.contract.criteria[1].kind, 'external-confirmation'); assert.equal(response.contract.criteria[1].targetCount, 1);
    assert.equal(response.verifiedAction, false); assert.equal(response.provenance.kind, 'human');
    assert.deepEqual(saved.responses.find(item => item.id === old.id), old);
    assert.equal(saved.cycles[0].state, 'paused_after_plan');
    await f.refresh(); visible();
  }
  assert.equal(f.planCalls().length, 2);
  assert.equal(f.calls.some(call => /\/(continue|run)$/.test(call.route) && call.method === 'POST'), false);
  assert.equal(f.runtime.calls, 0);
});

test('canonical Plan review merges unrelated saved edits and retains notes for removed work without recreating it', async t => {
  const f = await fixture(t);
  await f.dom.input(f.field('inspect:objective'), 'Retain this local source-reading procedure.');
  await f.editRemote(plan => { plan.contract.goal = 'A newer saved objective.'; plan.contract.instructions[0].text = 'A newer saved instruction.'; });
  await f.refresh(); await until(() => button(f.dom, 'Keep edits on current revision'), 'A stale Plan needs explicit review');
  assert.equal(f.dom.$('[data-cycle-plan-save]').disabled, true); assert.equal(f.dom.$(f.field('inspect:objective')).value, 'Retain this local source-reading procedure.');
  await f.dom.click(button(f.dom, 'Keep edits on current revision'));
  assert.equal(f.dom.$(f.field('contract:goal')).value, 'A newer saved objective.'); assert.equal(f.dom.$(f.field('retain:text')).value, 'A newer saved instruction.');
  await f.save(); await until(async () => planNode(await f.read()).response.contract.workItems[0].objective === 'Retain this local source-reading procedure.', 'Reviewed intent was not saved');
  await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, 'Save did not settle');
  await f.dom.input(f.field('inspect:objective'), 'Local note that must survive removal.');
  await f.editRemote(plan => { plan.contract.workItems = plan.contract.workItems.filter(item => item.id !== 'inspect'); plan.contract.workItems[0].dependsOn = []; plan.contract.workItems[0].criterionIds.push('read'); });
  await f.refresh(); await until(() => button(f.dom, 'Keep edits on current revision'), 'Removed work needs explicit review');
  await f.dom.click(button(f.dom, 'Keep edits on current revision'));
  assert.equal(f.dom.$('[data-plan-work-item="inspect"]'), null); assert.match(f.dom.mount.textContent, /Retained local edits/); assert.match(f.dom.mount.textContent, /Local note that must survive removal/);
  assert.equal((await f.read()).responses.at(-1).contract.workItems.some(item => item.id === 'inspect'), false);
});

test('late canonical Plan save receipts preserve queued typing and a newer saved revision', async t => {
  const f = await fixture(t); let release, accepted;
  const gate = new Promise(resolve => { release = resolve; });
  f.afterPlanResponse(async result => { accepted = result; await gate; });
  await f.dom.input(f.field('inspect:objective'), 'First submitted source procedure.'); await f.save();
  await until(() => accepted, 'The real HTTP save did not commit');
  await f.dom.input(f.field('inspect:objective'), 'Later queued source procedure.');
  const newer = await f.editRemote(plan => { plan.contract.goal = 'A concurrent newer objective.'; });
  await f.refresh(); await until(() => button(f.dom, 'Keep edits on current revision'), 'The newer revision was not read');
  f.afterPlanResponse(null); release();
  await until(() => f.dom.$('[data-cycle-plan-save]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
  assert.equal(f.dom.$(f.field('inspect:objective')).value, 'Later queued source procedure.'); assert.equal(f.dom.$(f.field('contract:goal')).value, 'A concurrent newer objective.');
  assert.equal(f.dom.$('[data-cycle-continue]').disabled, true);
  await f.save(); await until(() => f.planCalls().length === 2, 'Later typing did not submit');
  await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
  const saved = await f.read(); assert.equal(f.planCalls()[1].body.expectedPlanResponseId, planNode(newer).response.id);
  assert.equal(planNode(saved).response.contract.goal, 'A concurrent newer objective.'); assert.equal(planNode(saved).response.contract.workItems[0].objective, 'Later queued source procedure.');
});

test('changing confirmation semantics requires deliberate clearing and preserves criterion identities', async t => {
  const f = await fixture(t), kind = f.dom.$(f.field('confirmed:kind'));
  kind.value = 'judgment'; await kind.dispatch('change'); await f.save();
  assert.equal(f.planCalls().length, 0); assert.match(f.dom.mount.textContent, /Only external-confirmation/);
  assert.deepEqual(planNode(await f.read()).response.contract.criteria[1].receiptBinding, contract().criteria[1].receiptBinding);
  await f.dom.click(button(f.dom, 'Clear saved confirmation matching'));
  await f.dom.input(f.field('confirmed:targetCount'), '2'); await f.save();
  assert.equal(f.planCalls().length, 0, 'A judgment cannot require more distinct work-item judgments than its declared coverage.');
  assert.equal(planNode(await f.read()).response.contract.criteria[1].kind, 'external-confirmation');
  await f.dom.input(f.field('confirmed:targetCount'), '1'); await f.save();
  await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
  const value = planNode(await f.read()).response.contract;
  assert.equal(value.criteria[1].id, 'confirmed'); assert.equal(value.criteria[1].kind, 'judgment'); assert.equal(Object.hasOwn(value.criteria[1], 'receiptBinding'), false); assert.deepEqual(value.workItems[1].criterionIds, ['confirmed']);
});

test('historical saved Plans retain their legacy editor and user-agency context on the same route', async t => {
  const f = await fixture(t, { canonical: false });
  assert.equal(f.dom.$('[data-canonical-plan]'), null); assert.ok(f.dom.$('[data-plan-step="inspect"]')); assert.match(f.dom.mount.textContent, /Planned steps and dependencies/);
  await f.dom.input(f.field('inspect:description'), 'An explicitly edited historical procedure.'); await f.save();
  await until(() => f.dom.$('[data-cycle-continue]')?.disabled === false, () => f.dom.mount.textContent.slice(-1500));
  const response = planNode(await f.read()).response;
  assert.equal(response.steps[0].description, 'An explicitly edited historical procedure.'); assert.equal(Object.hasOwn(response, 'contract'), false); assert.deepEqual(response.userAgency, planNode(f.initial).response.userAgency);
});

for (const canonical of [true, false]) test('stopped ' + (canonical ? 'canonical' : 'historical') + ' Plans keep disclosures and text inspectable without enabling edits', async t => {
  const f = await fixture(t, { canonical, cycleState: 'cancelled' }), before = await f.read();
  const form = f.dom.$('[data-cycle-plan-form]'), work = f.dom.$(canonical ? '[data-plan-work-item="inspect"]' : '[data-plan-step="inspect"]');
  assert.equal(form.inert, false, 'Read-only state must not make the disclosure controls inert.');
  assert.equal(work.open, false, 'The work item begins collapsed, as it does in the installed app.');
  const summary = work.querySelector('summary');
  assert.ok(summary); assert.equal(Boolean(summary.disabled), false);
  for (let element = summary; element; element = element.parentElement) assert.equal(Boolean(element.inert), false);
  const text = form.querySelectorAll('input, textarea').filter(field => !['checkbox', 'radio'].includes(field.type));
  assert.ok(text.length > 0);
  for (const field of text) { assert.equal(field.readOnly, true); assert.equal(field.disabled, false, 'Read-only text must remain focusable and selectable.'); }
  const writes = form.querySelectorAll('select, button, input[type="checkbox"], input[type="radio"]');
  assert.ok(writes.length > 0);
  for (const control of writes) assert.equal(control.disabled, true);
  const description = text[0];
  description.focus(); description.setSelectionRange(0, description.value.length);
  assert.equal(f.dom.document.activeElement, description); assert.equal(description.selectionEnd, description.value.length);
  assert.equal(f.dom.$('[data-cycle-plan-save]').disabled, true); assert.equal(f.dom.$('[data-cycle-continue]'), null);
  await f.save();
  const after = await f.read();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(after.revision, before.revision); assert.equal(planNode(after).response.id, planNode(before).response.id);
  assert.deepEqual(planNode(after).response, planNode(before).response); assert.equal(f.runtime.calls, 0);
});

test('direct cycle and graph tools expose canonical Plan payloads and preserve UI/runtime state', async t => {
  const f = await fixture(t), directory = await mkdtemp(path.join(tmpdir(), 'canonical-direct-editor-'));
  const { DirectExecutionAPI } = await import('../lib/direct-execution-api.mjs');
  const { createDirectResponseCycleTools } = await import('../lib/direct-response-cycle-tools.mjs');
  const { createDirectPlanningBrowserTools } = await import('../lib/direct-planning-browser-tools.mjs');
  const api = await new DirectExecutionAPI({ dataDir: directory, allowedRoot: directory, additionalTools: [
    ...createDirectResponseCycleTools({ service: f.app.responseCycle }),
    ...createDirectPlanningBrowserTools({ store: f.app.planningBrowser }),
  ] }).init();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const client = { id: 'canonical-editor-grant', kind: 'chatgpt', scopes: ['read', 'commands:run', 'planning:write'] };
  const plan = planPayload(planNode(f.initial).response);
  plan.contract.workItems[0].objective = 'Read the source and preserve the observed qualification.';
  const args = { action: 'edit_plan', graphRequestId: f.initial.id, cycleId, ...controls(f.initial), plan, requestId: 'canonical-direct-edit' };
  const {validDirectArguments}=await import('../lib/direct-execution-api.mjs');
  const {planningSchemaIssues}=await import('../lib/planning-schema-diagnostics.mjs');
  const schema=api.tools(client).find(tool=>tool.name==='blackice_planning_cycle').inputSchema;
  assert.equal(validDirectArguments(args,schema),true,JSON.stringify(planningSchemaIssues(args.plan,schema.oneOf.find(branch=>branch.properties.action.const==='edit_plan').properties.plan.anyOf[1])));
  const admitted = await api.call('blackice_planning_cycle', args, client);
  const job = await until(async () => { const value = await api.getJob(admitted.jobId, client); return value.settled ? value : null; }, 'Canonical direct edit did not settle');
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const saved = await f.read(); assert.equal(planNode(saved).response.contract.workItems[0].objective, plan.contract.workItems[0].objective);
  assert.equal(planNode(saved).response.provenance.kind, 'external_agent'); assert.equal(planNode(saved).response.provenance.receipt.connectionId, client.id);
  assert.equal(saved.cycles[0].state, 'paused_after_plan'); assert.equal(f.runtime.calls, 0);
  const replay = await api.call('blackice_planning_cycle', args, client); assert.equal(replay.jobId, admitted.jobId); assert.equal((await f.read()).revision, saved.revision);
  const malformed = structuredClone(args); malformed.requestId = 'mixed-canonical-edit'; malformed.plan.steps = [];
  await assert.rejects(api.call('blackice_planning_cycle', malformed, client), { code: 'DIRECT_REQUEST_INVALID' });
  const publicPlan = planPayload(planNode(saved).response);
  publicPlan.contract.workItems[0].objective = 'A later public contribution retains the same bounded source review.';
  const contribution = await api.call('blackice_planning_graph_write', { requestId: 'canonical-public-response', action: 'record_response', graphRequestId: saved.id, nodeId: planNode(saved).id, expectedNodeRevision: planNode(saved).revision, ...publicPlan }, client);
  const recorded = await until(async () => { const value = await api.getJob(contribution.jobId, client); return value.settled ? value : null; }, 'Canonical graph response did not settle');
  assert.equal(recorded.status, 'succeeded', JSON.stringify(recorded)); assert.equal(planNode(await f.read()).response.contract.workItems[0].objective, publicPlan.contract.workItems[0].objective);
  assert.equal(f.runtime.calls, 0, 'Publishing a public Plan is not execution.');
});
